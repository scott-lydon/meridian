//! match_orders — cranker that crosses the best bid against the best ask.
//!
//! Anyone can call. The caller (typically the automation cranker) supplies
//! the maker accounts via the Accounts struct because the program needs to
//! transfer escrow OUT to the makers' wallets.
//!
//! Fill rules:
//! - Best bid price >= best ask price for a fill to happen; else no-op.
//! - Fill quantity = min(bid.qty, ask.qty).
//! - Fill price = the older order's price (price-time priority: maker wins).
//! - Maker who placed first: USDC out of escrow to seller; Yes out of escrow
//!   to buyer.

use anchor_lang::prelude::*;
use anchor_spl::token::{self, Token, TokenAccount, Transfer};

use crate::constants::{CONFIG_SEED, PROGRAM_VERSION};
use crate::error::MeridianError;
use crate::order_book::{OrderBook, OrderSide};
use crate::state::{Config, Market};

use super::init_order_book::{BOOK_AUTH_SEED, ORDER_BOOK_SEED};

#[derive(Accounts)]
pub struct MatchOrders<'info> {
    #[account(
        seeds = [CONFIG_SEED, &[PROGRAM_VERSION]],
        bump = config.bump,
    )]
    pub config: Box<Account<'info, Config>>,

    pub market: Box<Account<'info, Market>>,

    #[account(
        mut,
        seeds = [ORDER_BOOK_SEED, market.key().as_ref(), &[PROGRAM_VERSION]],
        bump,
    )]
    pub order_book: AccountLoader<'info, OrderBook>,

    /// CHECK: PDA escrow authority.
    #[account(
        seeds = [BOOK_AUTH_SEED, market.key().as_ref(), &[PROGRAM_VERSION]],
        bump,
    )]
    pub book_authority: UncheckedAccount<'info>,

    #[account(mut)]
    pub usdc_escrow: Box<Account<'info, TokenAccount>>,

    #[account(mut)]
    pub yes_escrow: Box<Account<'info, TokenAccount>>,

    /// USDC ATA of the resting-ask owner (seller). Receives USDC on fill.
    #[account(
        mut,
        token::mint = config.usdc_mint,
    )]
    pub ask_maker_usdc: Box<Account<'info, TokenAccount>>,

    /// Yes ATA of the resting-bid owner (buyer). Receives Yes tokens on fill.
    #[account(
        mut,
        token::mint = market.yes_mint,
    )]
    pub bid_maker_yes: Box<Account<'info, TokenAccount>>,

    /// Cranker pays the tx fee. Can be anyone.
    pub cranker: Signer<'info>,

    pub token_program: Program<'info, Token>,
}

pub fn handler(ctx: Context<MatchOrders>) -> Result<()> {
    let market_key = ctx.accounts.market.key();
    let book_auth_bump = ctx.bumps.book_authority;

    // Compute the fill under a short borrow scope so we can drop the mutable
    // borrow before CPI calls (CPIs need to re-borrow accounts).
    let (fill_qty, fill_price_ticks, bid_owner, ask_owner) = {
        let mut book = ctx.accounts.order_book.load_mut()?;
        require_keys_eq!(
            book.usdc_escrow,
            ctx.accounts.usdc_escrow.key(),
            MeridianError::WrongVaultAccount
        );
        require_keys_eq!(
            book.yes_escrow,
            ctx.accounts.yes_escrow.key(),
            MeridianError::WrongVaultAccount
        );

        if book.bids_len == 0 || book.asks_len == 0 {
            // Nothing to match — no error, just a no-op crank.
            msg!("meridian: match_orders no-op (book one-sided or empty)");
            return Ok(());
        }
        let bid = book.bids[0];
        let ask = book.asks[0];
        if bid.price_ticks < ask.price_ticks {
            msg!(
                "meridian: match_orders no-op (no cross: bid={} < ask={})",
                bid.price_ticks,
                ask.price_ticks
            );
            return Ok(());
        }

        // Price-time priority: whichever maker rested earlier sets the fill price.
        let fill_price = if bid.sequence < ask.sequence {
            bid.price_ticks
        } else {
            ask.price_ticks
        };
        let fill_qty = bid.qty.min(ask.qty);

        // Verify the caller's supplied maker accounts match the makers' owners.
        require_keys_eq!(
            ctx.accounts.bid_maker_yes.owner,
            bid.owner,
            MeridianError::OrderNotFound
        );
        require_keys_eq!(
            ctx.accounts.ask_maker_usdc.owner,
            ask.owner,
            MeridianError::OrderNotFound
        );

        // Decrement both resting orders.
        book.bids[0].qty = bid.qty.checked_sub(fill_qty).ok_or(MeridianError::MathOverflow)?;
        book.asks[0].qty = ask.qty.checked_sub(fill_qty).ok_or(MeridianError::MathOverflow)?;
        if book.bids[0].qty == 0 {
            book.remove_at(OrderSide::Bid, 0)?;
        }
        if book.asks[0].qty == 0 {
            book.remove_at(OrderSide::Ask, 0)?;
        }

        (fill_qty, fill_price, bid.owner, ask.owner)
    };

    // Cash legs out of escrow at the fill price.
    let usdc_to_seller = u64::from(fill_price_ticks)
        .checked_mul(crate::order_book::TICK_SIZE_BASE)
        .and_then(|p| p.checked_mul(fill_qty))
        .ok_or(MeridianError::MathOverflow)?;

    let signer_seeds: &[&[&[u8]]] = &[&[
        BOOK_AUTH_SEED,
        market_key.as_ref(),
        &[PROGRAM_VERSION],
        &[book_auth_bump],
    ]];

    // USDC: escrow -> seller (ask maker).
    token::transfer(
        CpiContext::new_with_signer(
            ctx.accounts.token_program.to_account_info(),
            Transfer {
                from: ctx.accounts.usdc_escrow.to_account_info(),
                to: ctx.accounts.ask_maker_usdc.to_account_info(),
                authority: ctx.accounts.book_authority.to_account_info(),
            },
            signer_seeds,
        ),
        usdc_to_seller,
    )?;

    // Yes: escrow -> buyer (bid maker).
    token::transfer(
        CpiContext::new_with_signer(
            ctx.accounts.token_program.to_account_info(),
            Transfer {
                from: ctx.accounts.yes_escrow.to_account_info(),
                to: ctx.accounts.bid_maker_yes.to_account_info(),
                authority: ctx.accounts.book_authority.to_account_info(),
            },
            signer_seeds,
        ),
        fill_qty,
    )?;

    msg!(
        "meridian: match_orders filled qty={} price_ticks={} bid_maker={} ask_maker={}",
        fill_qty,
        fill_price_ticks,
        bid_owner,
        ask_owner
    );
    Ok(())
}
