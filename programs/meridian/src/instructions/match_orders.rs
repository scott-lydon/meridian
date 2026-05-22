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
//!
//! Escrow accounting and price-improvement refund (BUG-FIX 2026-05-22):
//! The bidder ALWAYS escrows `bid.price * qty` USDC up front in `place_order`.
//! When the ask rests first (`ask.sequence < bid.sequence`), `fill_price =
//! ask.price`, which can be strictly LESS than `bid.price`. In that case the
//! bidder over-escrowed by `(bid.price - fill_price) * fill_qty` USDC. The
//! prior version of this handler silently left that surplus locked in
//! `usdc_escrow` forever (`cancel_order` could not reach it: a fully-filled
//! bid is no longer in the book). We now refund the spread to `bid_maker_usdc`
//! in the same instruction, so escrow accounting is conserved.

use anchor_lang::prelude::*;
use anchor_spl::token::{self, Token, TokenAccount, Transfer};

use crate::constants::{CONFIG_SEED, PROGRAM_VERSION};
use crate::error::MeridianError;
use crate::order_book::{OrderBook, OrderSide, TICK_SIZE_BASE};
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

    /// USDC ATA of the resting-bid owner. Receives the price-improvement
    /// refund when the bidder is the taker (`ask.sequence < bid.sequence`
    /// and `bid.price > ask.price`). Always required so the IDL is stable;
    /// when no refund is owed the transfer amount is zero.
    #[account(
        mut,
        token::mint = config.usdc_mint,
    )]
    pub bid_maker_usdc: Box<Account<'info, TokenAccount>>,

    /// Cranker pays the tx fee. Can be anyone.
    pub cranker: Signer<'info>,

    pub token_program: Program<'info, Token>,
}

pub fn handler(ctx: Context<MatchOrders>) -> Result<()> {
    // Once the market settles, Yes is worth exactly $1.00 or $0.00. Letting
    // stale resting orders keep crossing at $0.50 (or any pre-settle price)
    // hands free arbitrage to whoever runs the cranker next: match an old
    // ask at 50, redeem the Yes for 100, pocket the spread at the ask
    // maker's expense. Cancel still works post-settle (see cancel_order.rs)
    // so makers retain the ability to pull their escrow back.
    require!(
        !ctx.accounts.market.outcome.is_settled(),
        MeridianError::MarketAlreadySettled
    );

    let market_key = ctx.accounts.market.key();
    let book_auth_bump = ctx.bumps.book_authority;

    // Compute the fill under a short borrow scope so we can drop the mutable
    // borrow before CPI calls (CPIs need to re-borrow accounts).
    //
    // We additionally surface `bid_price_ticks` so the post-borrow refund
    // logic can compute the price-improvement spread without re-loading
    // the book.
    let (fill_qty, fill_price_ticks, bid_price_ticks, bid_owner, ask_owner) = {
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
        // Each comparison logs the mismatch BEFORE returning so the on-chain
        // log surfaces "bid_maker_yes owner X, but best_bid.owner Y" instead of
        // a bare 6011 — keeps the cranker debug loop one log scan instead of a
        // guess.
        if ctx.accounts.bid_maker_yes.owner != bid.owner {
            msg!(
                "OrderNotFound: bid_maker_yes.owner={} but best_bid.owner={}",
                ctx.accounts.bid_maker_yes.owner,
                bid.owner
            );
            return err!(MeridianError::OrderNotFound);
        }
        if ctx.accounts.ask_maker_usdc.owner != ask.owner {
            msg!(
                "OrderNotFound: ask_maker_usdc.owner={} but best_ask.owner={}",
                ctx.accounts.ask_maker_usdc.owner,
                ask.owner
            );
            return err!(MeridianError::OrderNotFound);
        }
        if ctx.accounts.bid_maker_usdc.owner != bid.owner {
            msg!(
                "OrderNotFound: bid_maker_usdc.owner={} but best_bid.owner={} (price-improvement refund target)",
                ctx.accounts.bid_maker_usdc.owner,
                bid.owner
            );
            return err!(MeridianError::OrderNotFound);
        }

        // Decrement both resting orders.
        book.bids[0].qty = bid.qty.checked_sub(fill_qty).ok_or(MeridianError::MathOverflow)?;
        book.asks[0].qty = ask.qty.checked_sub(fill_qty).ok_or(MeridianError::MathOverflow)?;
        if book.bids[0].qty == 0 {
            book.remove_at(OrderSide::Bid, 0)?;
        }
        if book.asks[0].qty == 0 {
            book.remove_at(OrderSide::Ask, 0)?;
        }

        (fill_qty, fill_price, bid.price_ticks, bid.owner, ask.owner)
    };

    // Cash legs out of escrow at the fill price.
    let usdc_to_seller = u64::from(fill_price_ticks)
        .checked_mul(TICK_SIZE_BASE)
        .and_then(|p| p.checked_mul(fill_qty))
        .ok_or(MeridianError::MathOverflow)?;

    // Price-improvement refund owed to the bidder when their bid price was
    // strictly better than the fill price (only possible when the ask was
    // the maker — older order). At this point `bid_price_ticks >=
    // fill_price_ticks` is guaranteed by the cross check; `.saturating_sub`
    // is used defensively so a corrupted book never panics, but the assert
    // makes the invariant explicit.
    debug_assert!(bid_price_ticks >= fill_price_ticks);
    let bid_refund = u64::from(bid_price_ticks.saturating_sub(fill_price_ticks))
        .checked_mul(TICK_SIZE_BASE)
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

    // USDC: escrow -> bid maker, if their bid price exceeded the fill price.
    // We skip the CPI when refund == 0 to save a CPI's worth of CU/log space
    // on the common same-price-cross path; correctness is unchanged.
    if bid_refund > 0 {
        token::transfer(
            CpiContext::new_with_signer(
                ctx.accounts.token_program.to_account_info(),
                Transfer {
                    from: ctx.accounts.usdc_escrow.to_account_info(),
                    to: ctx.accounts.bid_maker_usdc.to_account_info(),
                    authority: ctx.accounts.book_authority.to_account_info(),
                },
                signer_seeds,
            ),
            bid_refund,
        )?;
    }

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
        "meridian: match_orders filled qty={} fill_price_ticks={} bid_price_ticks={} bid_refund={} bid_maker={} ask_maker={}",
        fill_qty,
        fill_price_ticks,
        bid_price_ticks,
        bid_refund,
        bid_owner,
        ask_owner
    );
    Ok(())
}
