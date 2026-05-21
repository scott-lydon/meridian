//! initialize_config — one-time setup.
//!
//! Admin signs. Creates the `Config` PDA, records the USDC mint, seeds the
//! Pyth feeds table, and sets default oracle / override thresholds.
//!
//! Second invocation fails with `ConfigAlreadyInitialized` (the `init`
//! constraint enforces this — Anchor returns the underlying account-already-
//! exists error, which the caller can map).

use anchor_lang::prelude::*;
use anchor_spl::token::Mint;

use crate::constants::{
    CONFIG_SEED, DEFAULT_ADMIN_OVERRIDE_DELAY_SECS, DEFAULT_MAX_CONFIDENCE_BPS,
    DEFAULT_MAX_STALENESS_SECS, MAX_TICKERS, PROGRAM_VERSION,
};
use crate::state::{Config, PythFeedConfig};

#[derive(Accounts)]
pub struct InitializeConfig<'info> {
    // seeds: [b"config", PROGRAM_VERSION]
    #[account(
        init,
        payer = admin,
        space = Config::LEN,
        seeds = [CONFIG_SEED, &[PROGRAM_VERSION]],
        bump,
    )]
    pub config: Account<'info, Config>,

    /// USDC mint. Recorded into Config; subsequent instructions verify against
    /// this so the program can never settle against a wrong-stable market.
    pub usdc_mint: Account<'info, Mint>,

    #[account(mut)]
    pub admin: Signer<'info>,

    pub system_program: Program<'info, System>,
}

pub fn handler(
    ctx: Context<InitializeConfig>,
    pyth_feeds: [PythFeedConfig; MAX_TICKERS],
) -> Result<()> {
    let config = &mut ctx.accounts.config;
    config.admin = ctx.accounts.admin.key();
    config.usdc_mint = ctx.accounts.usdc_mint.key();
    config.pyth_feeds = pyth_feeds;
    config.max_staleness_secs = DEFAULT_MAX_STALENESS_SECS;
    config.max_confidence_bps = DEFAULT_MAX_CONFIDENCE_BPS;
    config.admin_override_delay_secs = DEFAULT_ADMIN_OVERRIDE_DELAY_SECS;
    config.paused = false;
    config.version = PROGRAM_VERSION;
    config.bump = ctx.bumps.config;

    msg!(
        "meridian: config initialized, admin={}, usdc_mint={}",
        config.admin,
        config.usdc_mint
    );
    Ok(())
}
