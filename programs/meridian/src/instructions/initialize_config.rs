//! initialize_config — one-time setup.
//!
//! Admin signs. Creates the `Config` PDA, records the USDC mint, sets default
//! oracle / override thresholds. Pyth feeds are NOT stored here (see state.rs
//! note on BPF stack overflow); admin passes pyth_feed_id directly to
//! create_strike_market in slice 1, and a PythFeedRegistry account is added
//! in slice 2 for on-chain verification.
//!
//! Second invocation fails with `ConfigAlreadyInitialized` (the `init`
//! constraint enforces this — Anchor returns the account-already-exists
//! error).

use anchor_lang::prelude::*;
use anchor_spl::token::Mint;

use crate::constants::{
    CONFIG_SEED, DEFAULT_ADMIN_OVERRIDE_DELAY_SECS, DEFAULT_MAX_CONFIDENCE_BPS,
    DEFAULT_MAX_STALENESS_SECS, PROGRAM_VERSION,
};
use crate::state::Config;

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

pub fn handler(ctx: Context<InitializeConfig>) -> Result<()> {
    let config = &mut ctx.accounts.config;
    config.admin = ctx.accounts.admin.key();
    config.usdc_mint = ctx.accounts.usdc_mint.key();
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
