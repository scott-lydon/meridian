//! Meridian — binary stock outcome markets on Solana.
//!
//! Each strike market resolves on the underlying stock's 4:00 PM ET closing
//! price relative to a fixed strike. Yes pays $1.00 USDC if the stock closes
//! at or above the strike; No pays $1.00 if it closes below. The vault holds
//! exactly `total_pairs × $1.00` at all times.
//!
//! See `constitution.md`, `spec.md`, `plan.md`, `tasks.md` at the repo root
//! for the binding spec.
//!
//! Slice 1: initialize_config, create_strike_market, mint_pair,
//! settle_market_manual (admin-only stub), redeem. Slice 2 adds Pyth-based
//! settle_market and the time-delayed admin_settle override.

#![cfg_attr(feature = "no-entrypoint", allow(unused_imports))]
#![warn(clippy::pedantic, clippy::nursery)]
#![allow(clippy::missing_errors_doc, clippy::module_name_repetitions)]
// Anchor's macros expand into code that triggers a few stylistic clippy lints
// we cannot fix without forking the macros. Tolerate them here.
#![allow(clippy::needless_pass_by_value, clippy::result_large_err)]

use anchor_lang::prelude::*;

pub mod constants;
pub mod error;
pub mod instructions;
pub mod state;

use crate::constants::TICKER_LEN;
use crate::instructions::*;
use crate::state::PythFeedConfig;

declare_id!("499QonPencmcxszHqjKKsMUE6dnbWh1AJ4f9LTrv9t1s");

#[program]
pub mod meridian {
    use super::*;

    /// One-time program setup. Admin signs, records USDC mint + Pyth feeds.
    pub fn initialize_config(
        ctx: Context<InitializeConfig>,
        pyth_feeds: [PythFeedConfig; constants::MAX_TICKERS],
    ) -> Result<()> {
        instructions::initialize_config::handler(ctx, pyth_feeds)
    }

    /// Admin creates one market: one (trading-day, ticker, strike) tuple.
    /// Initializes Yes/No mints, vault, and Market PDA.
    pub fn create_strike_market(
        ctx: Context<CreateStrikeMarket>,
        trading_day_unix: i64,
        ticker: [u8; TICKER_LEN],
        strike_usd_micros: u64,
        expiry_unix: i64,
    ) -> Result<()> {
        instructions::create_strike_market::handler(
            ctx,
            trading_day_unix,
            ticker,
            strike_usd_micros,
            expiry_unix,
        )
    }

    /// Anyone deposits N USDC and receives N Yes + N No tokens.
    pub fn mint_pair(ctx: Context<MintPair>, qty: u64) -> Result<()> {
        instructions::mint_pair::handler(ctx, qty)
    }

    /// Admin-only stub settlement used by tests and dev workflows.
    /// Real Pyth-driven `settle_market` lands in slice 2.
    pub fn settle_market_manual(
        ctx: Context<SettleMarketManual>,
        closing_price_micros: u64,
    ) -> Result<()> {
        instructions::settle_market_manual::handler(ctx, closing_price_micros)
    }

    /// Burn winning tokens for $1.00 each. Losing tokens redeem for $0.00
    /// (the burn still succeeds; rent on the ATA returns to the user).
    pub fn redeem(ctx: Context<Redeem>, side: RedeemSide, qty: u64) -> Result<()> {
        instructions::redeem::handler(ctx, side, qty)
    }
}
