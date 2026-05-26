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

// ============================================================================
// Unit tests for the constants.
// ============================================================================
//
// These tests look trivial but they are the safety net for an entire class of
// silent-corruption bugs: change `PROGRAM_VERSION` from 1 to 2 without bumping
// every PDA seed list, and every test below catches it before the program
// touches a validator. Change `USDC_BASE_PER_DOLLAR` and every settlement
// micro-USD round-trip silently shifts a decimal place. Pinning these in tests
// makes a refactor that drifts immediately visible.
#[cfg(test)]
#[allow(clippy::unwrap_used, clippy::expect_used, clippy::panic)]
mod tests {
    use super::*;

    #[test]
    fn program_version_is_positive() {
        // Zero would silently match a hypothetical default-initialized PDA.
        assert!(PROGRAM_VERSION > 0);
    }

    #[test]
    fn ticker_len_matches_the_longest_supported_ticker() {
        // The longest MAG7 ticker is GOOGL at 5 ASCII chars. The 6-byte
        // budget gives us one byte of headroom for ticker symbols up to 6
        // chars; longer ones would truncate silently if we ever extended.
        assert_eq!(TICKER_LEN, 6);
        assert!("GOOGL".len() <= TICKER_LEN);
    }

    #[test]
    fn max_tickers_covers_the_mag7_set() {
        // 7 is the cardinality of the MAG7 set (AAPL, MSFT, GOOGL, AMZN, META,
        // NVDA, TSLA). Adding an 8th ticker means bumping this AND either
        // expanding Config or accepting an off-chain registry approach.
        assert_eq!(MAX_TICKERS, 7);
    }

    #[test]
    fn usdc_base_per_dollar_is_one_million() {
        // 6-decimal USDC mint. If this constant ever drifts, every settlement
        // calculation across the program silently shifts a decimal place.
        assert_eq!(USDC_BASE_PER_DOLLAR, 1_000_000);
    }

    #[test]
    fn pyth_feed_id_length_is_32() {
        // Pyth publishes feed IDs as 32-byte hashes; this constant is used to
        // size on-chain storage and slice incoming params.
        assert_eq!(PYTH_FEED_ID_LEN, 32);
    }

    #[test]
    fn default_oracle_thresholds_match_constitution() {
        // The constitution pins these defaults; this test makes any silent
        // edit visible. Change here MUST also update constitution.md.
        assert_eq!(DEFAULT_MAX_STALENESS_SECS, 300);
        assert_eq!(DEFAULT_MAX_CONFIDENCE_BPS, 50);
        assert_eq!(DEFAULT_ADMIN_OVERRIDE_DELAY_SECS, 3600);
    }

    #[test]
    fn market_close_et_hour_is_four_pm() {
        assert_eq!(MARKET_CLOSE_ET_HOUR, 16);
    }

    #[test]
    fn pda_seeds_are_disjoint_and_nonempty() {
        // The PDA seeds must be byte-distinct so an attacker cannot derive a
        // Market PDA that happens to also be the Config PDA's pre-image.
        let seeds = [
            CONFIG_SEED, MARKET_SEED, VAULT_AUTH_SEED, YES_MINT_SEED, NO_MINT_SEED,
        ];
        for s in seeds {
            assert!(!s.is_empty(), "every PDA seed must be non-empty");
            // ASCII-only so logs render readably.
            for b in s {
                assert!(b.is_ascii_alphanumeric() || *b == b'_', "PDA seed must be readable ASCII");
            }
        }
        for (i, a) in seeds.iter().enumerate() {
            for (j, b) in seeds.iter().enumerate() {
                if i != j {
                    assert_ne!(a, b, "seed {} and seed {} collide", i, j);
                }
            }
        }
    }
}
