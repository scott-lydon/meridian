//! init_order_book — admin creates the OrderBook + escrow ATAs for a Market.
//! OrderBook is zero-copy (~28KB), so we use AccountLoader and `load_init()`.

use anchor_lang::prelude::*;
use anchor_spl::associated_token::AssociatedToken;
use anchor_spl::token::{Mint, Token, TokenAccount};

use crate::constants::{CONFIG_SEED, PROGRAM_VERSION};
use crate::error::MeridianError;
use crate::order_book::OrderBook;
use crate::state::{Config, Market};

pub const ORDER_BOOK_SEED: &[u8] = b"book";
pub const BOOK_AUTH_SEED: &[u8] = b"book_auth";

/// Account size = 8 (disc) + 32+32+32+8+4+4+1+1+6 + 56*64*2 = 7296.
/// (Stays under Solana's 10240-byte CPI realloc limit.)
pub const ORDER_BOOK_SIZE: usize = 7_296;

#[derive(Accounts)]
pub struct InitOrderBook<'info> {
    #[account(
        seeds = [CONFIG_SEED, &[PROGRAM_VERSION]],
        bump = config.bump,
    )]
    pub config: Box<Account<'info, Config>>,

    pub market: Box<Account<'info, Market>>,

    #[account(
        init,
        payer = admin,
        space = ORDER_BOOK_SIZE,
        seeds = [ORDER_BOOK_SEED, market.key().as_ref(), &[PROGRAM_VERSION]],
        bump,
    )]
    pub order_book: AccountLoader<'info, OrderBook>,

    /// CHECK: PDA, signs escrow withdrawals.
    #[account(
        seeds = [BOOK_AUTH_SEED, market.key().as_ref(), &[PROGRAM_VERSION]],
        bump,
    )]
    pub book_authority: UncheckedAccount<'info>,

    #[account(
        init,
        payer = admin,
        associated_token::mint = usdc_mint,
        associated_token::authority = book_authority,
    )]
    pub usdc_escrow: Box<Account<'info, TokenAccount>>,

    #[account(
        init,
        payer = admin,
        associated_token::mint = yes_mint,
        associated_token::authority = book_authority,
    )]
    pub yes_escrow: Box<Account<'info, TokenAccount>>,

    #[account(address = config.usdc_mint @ MeridianError::WrongTokenMint)]
    pub usdc_mint: Box<Account<'info, Mint>>,

    #[account(address = market.yes_mint @ MeridianError::WrongTokenMint)]
    pub yes_mint: Box<Account<'info, Mint>>,

    #[account(
        mut,
        address = config.admin @ MeridianError::Unauthorized,
    )]
    pub admin: Signer<'info>,

    pub system_program: Program<'info, System>,
    pub token_program: Program<'info, Token>,
    pub associated_token_program: Program<'info, AssociatedToken>,
    pub rent: Sysvar<'info, Rent>,
}

pub fn handler(ctx: Context<InitOrderBook>) -> Result<()> {
    let mut book = ctx.accounts.order_book.load_init()?;
    book.market = ctx.accounts.market.key();
    book.next_sequence = 0;
    book.bids_len = 0;
    book.asks_len = 0;
    book.usdc_escrow = ctx.accounts.usdc_escrow.key();
    book.yes_escrow = ctx.accounts.yes_escrow.key();
    book.bump = ctx.bumps.order_book;
    book.version = PROGRAM_VERSION;
    msg!("meridian: order_book initialized for market={}", book.market);
    Ok(())
}
