//! cancel_order — owner cancels an unfilled order, escrow refunds.

use anchor_lang::prelude::*;
use anchor_spl::token::{self, Token, TokenAccount, Transfer};

use crate::constants::{CONFIG_SEED, PROGRAM_VERSION};
use crate::error::MeridianError;
use crate::order_book::{usdc_total, Order, OrderBook, OrderSide};
use crate::state::{Config, Market};

use super::init_order_book::{BOOK_AUTH_SEED, ORDER_BOOK_SEED};

#[derive(Accounts)]
pub struct CancelOrder<'info> {
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

    #[account(
        mut,
        token::mint = config.usdc_mint,
        token::authority = user,
    )]
    pub user_usdc: Box<Account<'info, TokenAccount>>,

    #[account(
        mut,
        token::mint = market.yes_mint,
        token::authority = user,
    )]
    pub user_yes: Box<Account<'info, TokenAccount>>,

    pub user: Signer<'info>,

    pub token_program: Program<'info, Token>,
}

pub fn handler(ctx: Context<CancelOrder>, side: OrderSide, sequence: u64) -> Result<()> {
    let user_key = ctx.accounts.user.key();
    let market_key = ctx.accounts.market.key();
    let book_auth_bump = ctx.bumps.book_authority;

    let removed: Order = {
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
        let idx = book
            .find(side, &user_key, sequence)
            .ok_or(MeridianError::OrderNotFound)?;
        book.remove_at(side, idx)?
    };

    let signer_seeds: &[&[&[u8]]] = &[&[
        BOOK_AUTH_SEED,
        market_key.as_ref(),
        &[PROGRAM_VERSION],
        &[book_auth_bump],
    ]];

    match side {
        OrderSide::Bid => {
            let refund = usdc_total(removed.price_ticks, removed.qty)?;
            token::transfer(
                CpiContext::new_with_signer(
                    ctx.accounts.token_program.to_account_info(),
                    Transfer {
                        from: ctx.accounts.usdc_escrow.to_account_info(),
                        to: ctx.accounts.user_usdc.to_account_info(),
                        authority: ctx.accounts.book_authority.to_account_info(),
                    },
                    signer_seeds,
                ),
                refund,
            )?;
        }
        OrderSide::Ask => {
            token::transfer(
                CpiContext::new_with_signer(
                    ctx.accounts.token_program.to_account_info(),
                    Transfer {
                        from: ctx.accounts.yes_escrow.to_account_info(),
                        to: ctx.accounts.user_yes.to_account_info(),
                        authority: ctx.accounts.book_authority.to_account_info(),
                    },
                    signer_seeds,
                ),
                removed.qty,
            )?;
        }
    }

    msg!(
        "meridian: cancel_order side={:?} sequence={} qty={}",
        side,
        sequence,
        removed.qty
    );
    Ok(())
}
