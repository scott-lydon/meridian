//! On-chain account layouts.
//!
//! Per constitution §3 (Rust style), every account has a `LEN` const that adds
//! up its fields with a comment showing the arithmetic. Anchor's `InitSpace`
//! derive auto-generates the same number; we keep the `LEN` constant as a
//! cross-check in tests.

use anchor_lang::prelude::*;

use crate::constants::{MAX_TICKERS, TICKER_LEN};

// ===========================================================================
// Config — one per program deployment.
// ===========================================================================

/// Global program configuration set once at deploy time by the admin.
#[account]
#[derive(InitSpace)]
pub struct Config {
    /// Admin pubkey that can create markets, settle via override, pause.
    pub admin: Pubkey,                                   // 32
    /// Devnet USDC mint (Circle's official); recorded so callers can verify.
    pub usdc_mint: Pubkey,                               // 32
    /// One Pyth feed per MAG7 ticker.
    pub pyth_feeds: [PythFeedConfig; MAX_TICKERS],       // 7 * 38 = 266
    /// Reject Pyth prices older than this many seconds at settlement.
    pub max_staleness_secs: u64,                         // 8
    /// Reject Pyth prices whose confidence exceeds this many basis points
    /// of the price. 50 bps = 0.5%.
    pub max_confidence_bps: u16,                         // 2
    /// Seconds the admin must wait after market close before `admin_settle`
    /// becomes callable. Slice 2 enforces this on-chain.
    pub admin_override_delay_secs: i64,                  // 8
    /// Global pause flag. When set, mint and trading reject; redeem continues
    /// to work (see constitution §2.10).
    pub paused: bool,                                    // 1
    /// Bumped on any breaking change to layouts or PDAs.
    pub version: u8,                                     // 1
    /// PDA bump.
    pub bump: u8,                                        // 1
}

impl Config {
    /// 8 (discriminator) + 32 + 32 + 266 + 8 + 2 + 8 + 1 + 1 + 1.
    pub const LEN: usize = 8 + 32 + 32 + (TICKER_LEN + 32) * MAX_TICKERS + 8 + 2 + 8 + 1 + 1 + 1;
}

/// One ticker, one Pyth feed.
#[derive(AnchorSerialize, AnchorDeserialize, Clone, Copy, InitSpace, PartialEq, Eq, Debug)]
pub struct PythFeedConfig {
    /// ASCII ticker symbol, null-padded right (e.g. b"AAPL\0\0").
    pub ticker: [u8; TICKER_LEN],
    /// Pyth feed id (32-byte hash).
    pub feed_id: [u8; 32],
}

// ===========================================================================
// Market — one per (trading-day, ticker, strike) tuple.
// ===========================================================================

#[account]
#[derive(InitSpace)]
pub struct Market {
    /// Pointer back to the parent Config (set at create_strike_market).
    pub config: Pubkey,                          // 32
    /// UTC midnight of the trading day this market settles on.
    pub trading_day_unix: i64,                   // 8
    /// Ticker (e.g. b"META\0\0").
    pub ticker: [u8; TICKER_LEN],                // 6
    /// Strike price in 6-decimal USDC base units (micros).
    /// e.g. $680.00 == 680_000_000.
    pub strike_usd_micros: u64,                  // 8
    /// SPL mint for Yes tokens (0 decimals).
    pub yes_mint: Pubkey,                        // 32
    /// SPL mint for No tokens (0 decimals).
    pub no_mint: Pubkey,                         // 32
    /// USDC ATA owned by `vault_authority`.
    pub vault: Pubkey,                           // 32
    /// PDA bumps captured so signers can be reconstructed cheaply.
    pub vault_authority_bump: u8,                // 1
    pub yes_mint_bump: u8,                       // 1
    pub no_mint_bump: u8,                        // 1
    /// Set by `create_strike_market` from Clock.
    pub created_at_unix: i64,                    // 8
    /// 16:00 ET of `trading_day_unix`.
    pub expiry_unix: i64,                        // 8
    /// `created_at_unix + admin_override_delay_secs`. Slice 5 enforces.
    pub admin_override_earliest: i64,            // 8
    /// Pyth feed id for the underlying ticker (mirrored from Config for
    /// O(1) verification at settle time).
    pub pyth_feed_id: [u8; 32],                  // 32
    /// Settlement state. `OutcomeState::Pending` until settle lands.
    pub outcome: Outcome,                        // ~20
    /// PDA bump for this Market account.
    pub bump: u8,                                // 1
    /// Account-layout version.
    pub version: u8,                             // 1
}

#[derive(AnchorSerialize, AnchorDeserialize, Clone, Copy, InitSpace, PartialEq, Eq, Debug)]
pub struct Outcome {
    pub state: OutcomeState,
    /// Closing price in micro-USD as reported by the oracle (or admin override).
    /// Zero before settlement.
    pub closing_price_micros: u64,
    /// Unix timestamp the outcome was written. Zero before settlement.
    pub settled_at_unix: i64,
    /// True if settled via `admin_settle` (the override path).
    pub admin_override: bool,
}

#[derive(AnchorSerialize, AnchorDeserialize, Clone, Copy, InitSpace, PartialEq, Eq, Debug)]
pub enum OutcomeState {
    Pending,
    YesWins,
    NoWins,
}

impl Outcome {
    pub const fn pending() -> Self {
        Self {
            state: OutcomeState::Pending,
            closing_price_micros: 0,
            settled_at_unix: 0,
            admin_override: false,
        }
    }

    pub const fn is_settled(&self) -> bool {
        !matches!(self.state, OutcomeState::Pending)
    }
}
