//! create_strike_market — admin creates a fresh market for one strike on one
//! trading day for one ticker.
//!
//! Initializes: Market PDA, Yes mint PDA, No mint PDA, vault authority PDA,
//! USDC vault (associated token account owned by the vault-authority PDA).
//!
//! Idempotency: a second call with identical (trading_day, ticker, strike)
//! fails because the Market PDA already exists (Anchor's `init` constraint).

use anchor_lang::prelude::*;
use anchor_spl::associated_token::AssociatedToken;
use anchor_spl::token::{Mint, Token, TokenAccount};

use crate::constants::{
    CONFIG_SEED, MARKET_SEED, NO_MINT_SEED, PROGRAM_VERSION, TICKER_LEN, VAULT_AUTH_SEED,
    YES_MINT_SEED,
};
use crate::error::MeridianError;
use crate::state::{Config, Market, Outcome};

#[derive(Accounts)]
#[instruction(trading_day_unix: i64, ticker: [u8; TICKER_LEN], strike_usd_micros: u64, expiry_unix: i64)]
pub struct CreateStrikeMarket<'info> {
    #[account(
        seeds = [CONFIG_SEED, &[PROGRAM_VERSION]],
        bump = config.bump,
    )]
    pub config: Account<'info, Config>,

    // seeds: [b"market", trading_day_unix LE, ticker, strike_usd_micros LE, PROGRAM_VERSION]
    #[account(
        init,
        payer = admin,
        space = 8 + Market::INIT_SPACE,
        seeds = [
            MARKET_SEED,
            &trading_day_unix.to_le_bytes(),
            &ticker,
            &strike_usd_micros.to_le_bytes(),
            &[PROGRAM_VERSION],
        ],
        bump,
    )]
    pub market: Account<'info, Market>,

    /// CHECK: PDA used only as a signer for vault transfers and as the mint
    /// authority for Yes/No. No state; just a derived address.
    #[account(
        seeds = [VAULT_AUTH_SEED, market.key().as_ref(), &[PROGRAM_VERSION]],
        bump,
    )]
    pub vault_authority: UncheckedAccount<'info>,

    #[account(
        init,
        payer = admin,
        seeds = [YES_MINT_SEED, market.key().as_ref(), &[PROGRAM_VERSION]],
        bump,
        mint::decimals = 0,
        mint::authority = vault_authority,
    )]
    pub yes_mint: Account<'info, Mint>,

    #[account(
        init,
        payer = admin,
        seeds = [NO_MINT_SEED, market.key().as_ref(), &[PROGRAM_VERSION]],
        bump,
        mint::decimals = 0,
        mint::authority = vault_authority,
    )]
    pub no_mint: Account<'info, Mint>,

    #[account(
        init,
        payer = admin,
        associated_token::mint = usdc_mint,
        associated_token::authority = vault_authority,
    )]
    pub vault: Account<'info, TokenAccount>,

    #[account(address = config.usdc_mint @ MeridianError::WrongTokenMint)]
    pub usdc_mint: Account<'info, Mint>,

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

pub fn handler(
    ctx: Context<CreateStrikeMarket>,
    trading_day_unix: i64,
    ticker: [u8; TICKER_LEN],
    strike_usd_micros: u64,
    expiry_unix: i64,
) -> Result<()> {
    require!(strike_usd_micros > 0, MeridianError::InvalidStrike);
    require!(trading_day_unix > 0, MeridianError::InvalidTradingDay);

    let config = &ctx.accounts.config;

    // Find the Pyth feed for this ticker in Config. Reject unknown tickers.
    let feed = config
        .pyth_feeds
        .iter()
        .find(|f| f.ticker == ticker)
        .ok_or(MeridianError::UnknownTicker)?;

    let clock = Clock::get()?;
    let admin_override_earliest = clock
        .unix_timestamp
        .checked_add(config.admin_override_delay_secs)
        .ok_or(MeridianError::MathOverflow)?;

    let market = &mut ctx.accounts.market;
    market.config = config.key();
    market.trading_day_unix = trading_day_unix;
    market.ticker = ticker;
    market.strike_usd_micros = strike_usd_micros;
    market.yes_mint = ctx.accounts.yes_mint.key();
    market.no_mint = ctx.accounts.no_mint.key();
    market.vault = ctx.accounts.vault.key();
    market.vault_authority_bump = ctx.bumps.vault_authority;
    market.yes_mint_bump = ctx.bumps.yes_mint;
    market.no_mint_bump = ctx.bumps.no_mint;
    market.created_at_unix = clock.unix_timestamp;
    market.expiry_unix = expiry_unix;
    market.admin_override_earliest = admin_override_earliest;
    market.pyth_feed_id = feed.feed_id;
    market.outcome = Outcome::pending();
    market.bump = ctx.bumps.market;
    market.version = PROGRAM_VERSION;

    msg!(
        "meridian: market created ticker={:?} strike={} expiry={}",
        ticker,
        strike_usd_micros,
        expiry_unix
    );
    Ok(())
}
