//! Compile-time constants shared across instructions and tests.
//!
//! Conventions
//! - Every PDA seed list ends with `PROGRAM_VERSION` so a future v2 program can
//!   coexist with v1 without colliding PDAs (see constitution §3, "PDAs:
//!   deterministic seeds documented in a `// seeds:` comment").
//! - All USDC-denominated amounts are in 6-decimal base units (micros).

#![allow(clippy::cast_possible_truncation)]

/// Bumped on any breaking change to account layouts or PDAs.
pub const PROGRAM_VERSION: u8 = 1;

/// MAG7 tickers carried in `Config.pyth_feeds`.
pub const MAX_TICKERS: usize = 7;

/// All tickers fit in 6 ASCII bytes (longest is "GOOGL" at 5).
/// Null-padded on the right.
pub const TICKER_LEN: usize = 6;

/// USDC base units per dollar (6-decimal mint).
pub const USDC_BASE_PER_DOLLAR: u64 = 1_000_000;

/// Pyth feed id is a 32-byte hash.
pub const PYTH_FEED_ID_LEN: usize = 32;

// === PDA seeds ===
pub const CONFIG_SEED: &[u8] = b"config";
pub const MARKET_SEED: &[u8] = b"market";
pub const VAULT_AUTH_SEED: &[u8] = b"vault_auth";
pub const YES_MINT_SEED: &[u8] = b"yes_mint";
pub const NO_MINT_SEED: &[u8] = b"no_mint";

// === Defaults for oracle validation (mutable in Config post-init) ===
pub const DEFAULT_MAX_STALENESS_SECS: u64 = 300;
pub const DEFAULT_MAX_CONFIDENCE_BPS: u16 = 50;
pub const DEFAULT_ADMIN_OVERRIDE_DELAY_SECS: i64 = 3_600;

/// 16:00 ET expressed as seconds offset from midnight UTC on a trading day,
/// for the EST(UTC-5)/EDT(UTC-4) timezone. We use a sentinel `expiry_unix`
/// stored on each Market, computed by the automation service when the market
/// is created. Constant kept here for cross-checks in tests.
#[cfg(test)]
pub const MARKET_CLOSE_ET_HOUR: i64 = 16;
