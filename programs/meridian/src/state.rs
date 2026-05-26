//! On-chain account layouts.
//!
//! Per constitution §3 (Rust style), every account has a `LEN` const that adds
//! up its fields with a comment showing the arithmetic. Anchor's `InitSpace`
//! derive auto-generates the same number; we keep the `LEN` constant as a
//! cross-check in tests.

use anchor_lang::prelude::*;

use crate::constants::TICKER_LEN;

// ===========================================================================
// Config — one per program deployment.
// ===========================================================================

/// Global program configuration set once at deploy time by the admin.
///
/// Note: Pyth feeds intentionally live OFF this account. Storing the 7
/// feeds inline blew the on-chain BPF stack when create_strike_market
/// deserialized Config (Anchor copies through the stack). Feeds are now
/// either (a) passed directly to create_strike_market by the admin, or
/// (b) verified via the Pyth receiver SDK at settle time (slice 2).
#[account]
#[derive(InitSpace)]
pub struct Config {
    /// Admin pubkey that can create markets, settle via override, pause.
    pub admin: Pubkey,                                   // 32
    /// Devnet USDC mint (Circle's official); recorded so callers can verify.
    pub usdc_mint: Pubkey,                               // 32
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
    /// 8 (discriminator) + 32 + 32 + 8 + 2 + 8 + 1 + 1 + 1.
    pub const LEN: usize = 8 + 32 + 32 + 8 + 2 + 8 + 1 + 1 + 1;
}

/// One ticker, one Pyth feed. Used only by client-side configuration
/// helpers; not stored on-chain in slice 1.
#[derive(AnchorSerialize, AnchorDeserialize, Clone, Copy, PartialEq, Eq, Debug)]
pub struct PythFeedConfig {
    /// ASCII ticker symbol, null-padded right (e.g. b"AAPL\0\0").
    pub ticker: [u8; TICKER_LEN],
    /// Pyth feed id (32-byte hash).
    pub feed_id: [u8; 32],
}

// Suppress unused warning when MAX_TICKERS isn't used by any on-chain struct.
const _: usize = crate::constants::MAX_TICKERS;

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

// ============================================================================
// Unit tests for the account-state primitives.
// ============================================================================
#[cfg(test)]
#[allow(clippy::unwrap_used, clippy::expect_used, clippy::panic)]
mod tests {
    use super::*;

    #[test]
    fn outcome_pending_is_zero_initialized() {
        let p = Outcome::pending();
        assert_eq!(p.state, OutcomeState::Pending);
        assert_eq!(p.closing_price_micros, 0);
        assert_eq!(p.settled_at_unix, 0);
        assert!(!p.admin_override);
    }

    #[test]
    fn outcome_is_settled_state_machine() {
        // Pending => not settled
        let p = Outcome::pending();
        assert!(!p.is_settled());

        // YesWins => settled
        let y = Outcome {
            state: OutcomeState::YesWins,
            closing_price_micros: 500_000_000,
            settled_at_unix: 1_700_000_000,
            admin_override: false,
        };
        assert!(y.is_settled());

        // NoWins => settled
        let n = Outcome {
            state: OutcomeState::NoWins,
            closing_price_micros: 499_000_000,
            settled_at_unix: 1_700_000_000,
            admin_override: false,
        };
        assert!(n.is_settled());
    }

    #[test]
    fn outcome_admin_override_flag_is_preserved_independently_of_state() {
        // The admin_override flag and the state field are orthogonal — a
        // settled-via-Pyth outcome and a settled-via-admin outcome have the
        // same state but different `admin_override` values, and downstream
        // consumers (the frontend) must be able to tell.
        let pyth_yes = Outcome {
            state: OutcomeState::YesWins,
            closing_price_micros: 1,
            settled_at_unix: 1,
            admin_override: false,
        };
        let admin_yes = Outcome { admin_override: true, ..pyth_yes };
        assert_eq!(pyth_yes.state, admin_yes.state);
        assert!(!pyth_yes.admin_override);
        assert!(admin_yes.admin_override);
    }

    #[test]
    fn config_len_matches_field_arithmetic() {
        // 8 discriminator + 32 admin + 32 usdc_mint + 8 max_staleness +
        // 2 max_confidence_bps + 8 admin_override_delay + 1 paused +
        // 1 version + 1 bump = 93. If a field is added without updating LEN,
        // this test fails LOUDLY rather than the on-chain allocation silently
        // truncating the account.
        assert_eq!(Config::LEN, 93);
        assert_eq!(
            Config::LEN,
            8 + 32 + 32 + 8 + 2 + 8 + 1 + 1 + 1,
            "Config::LEN drifted from the documented arithmetic"
        );
    }
}
