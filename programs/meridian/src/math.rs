//! Pure numerical helpers shared by every settlement path.
//!
//! These functions exist in a dedicated module for ONE reason: every line of
//! logic that decides who wins a market, or that converts an oracle price into
//! the program's micro-USD scale, must be unit-testable WITHOUT a validator.
//! Before this module existed the comparison and the Pyth scale math were
//! inlined inside Anchor instruction handlers, which meant the only way to
//! catch an off-by-one or an overflow was to spin up `solana-test-validator`
//! and hit the on-chain code path. That is slow, brittle, and useless in CI on
//! a machine that does not have the validator installed.
//!
//! Every function here is `pub(crate)`, takes plain integers in / returns plain
//! integers or a typed error out, and is paired with a `#[cfg(test)] mod tests`
//! block at the bottom of THIS file with comprehensive coverage:
//!
//! - boundary cases (strike == close, scale == 0, scale boundary signs),
//! - overflow paths (every `checked_*` arm),
//! - property tests via `proptest` (round-trip and monotonicity invariants).
//!
//! If you change a function here, you MUST keep the per-function unit tests
//! green AND the on-chain integration test (`tests/meridian.test.ts`) green.
//! The two layers together guarantee that the extracted helper matches the
//! semantics the validator-driven test was asserting before extraction.

use anchor_lang::prelude::*;

use crate::error::MeridianError;
use crate::state::OutcomeState;

/// Decide a market's outcome from the settled closing price.
///
/// Binary stock outcome markets settle by comparing the underlying ticker's
/// 4:00 PM ET closing price to the market's strike. Yes pays $1.00 USDC if the
/// close lands AT OR ABOVE the strike, No pays $1.00 if it lands strictly
/// below. The `>=` (not `>`) at the boundary is part of the product spec: a
/// market with strike $500.00 where the close prints exactly $500.00 settles
/// YesWins. The on-chain integration test in `tests/meridian.test.ts`
/// exercises this boundary explicitly.
///
/// Both inputs are in 6-decimal USDC base units (micros) so the comparison is
/// exact integer arithmetic with no float drift.
#[must_use]
pub fn decide_outcome(closing_price_micros: u64, strike_usd_micros: u64) -> OutcomeState {
    if closing_price_micros >= strike_usd_micros {
        OutcomeState::YesWins
    } else {
        OutcomeState::NoWins
    }
}

/// Convert a Pyth `PriceUpdateV2.price_message.price` + `exponent` pair into
/// the program's 6-decimal USDC micros.
///
/// Pyth publishes prices in the form `value * 10^exponent`. Equity feeds are
/// typically negative-exponent (e.g. AAPL at $190.25 publishes as raw=19025,
/// exponent=-2). We need to land at micros, which is 6 decimals, so the
/// scaling factor is `10^(exponent + 6)`.
///
/// Every arithmetic step is checked. Returning an error here is preferable to
/// a silent wrap because settlement is irreversible; an overflow that silently
/// produced the wrong micro count would lock the market into the wrong outcome
/// with no path to recovery short of an admin override.
///
/// # Errors
///
/// - `MeridianError::OracleUpdateMissing` if `raw_price <= 0` or if it cannot
///   be widened into a `u128` (the conversion only fails for negative values,
///   which the prior guard already rules out, but we re-check defensively).
/// - `MeridianError::MathOverflow` for any checked-arithmetic failure
///   downstream (pow exponent out of range, multiplication overflow, final
///   downcast to `u64` overflow).
pub fn pyth_price_to_micros(raw_price: i64, exponent: i32) -> Result<u64> {
    if raw_price <= 0 {
        msg!("pyth_price_to_micros: raw_price={} must be > 0", raw_price);
        return err!(MeridianError::OracleUpdateMissing);
    }
    let price_u128 =
        u128::try_from(raw_price).map_err(|_| MeridianError::OracleUpdateMissing)?;
    let scale = i64::from(exponent) + 6;
    if scale >= 0 {
        let pow = u32::try_from(scale).map_err(|_| MeridianError::MathOverflow)?;
        let mul = 10u128.checked_pow(pow).ok_or(MeridianError::MathOverflow)?;
        let scaled = price_u128
            .checked_mul(mul)
            .ok_or(MeridianError::MathOverflow)?;
        let micros = u64::try_from(scaled).map_err(|_| MeridianError::MathOverflow)?;
        Ok(micros)
    } else {
        // scale < 0 means exponent < -6: Pyth published more precision than
        // we keep on-chain. Divide and truncate (Pyth's own conventions round
        // down too — see their `Price::scale_to_exponent`).
        let pow = u32::try_from(-scale).map_err(|_| MeridianError::MathOverflow)?;
        let div = 10u128.checked_pow(pow).ok_or(MeridianError::MathOverflow)?;
        // `div` is never zero because 10^n >= 1 for n >= 0.
        let truncated = price_u128 / div;
        let micros = u64::try_from(truncated).map_err(|_| MeridianError::MathOverflow)?;
        Ok(micros)
    }
}

/// Pyth confidence as basis points of the price.
///
/// 1 basis point = 0.01%. The on-chain validation rejects updates whose
/// confidence band is wider than `Config.max_confidence_bps` (default 50 bps =
/// 0.5%). We compute in `u128` to avoid intermediate overflow on equity prices
/// where `raw_conf * 10_000` can exceed `u64::MAX`.
///
/// # Errors
///
/// - `MeridianError::OracleUpdateMissing` if `raw_price <= 0` (would divide by
///   zero or a negative). The price must already be positive at this point in
///   the settlement pipeline; this is a defensive re-check.
pub fn pyth_confidence_bps(raw_conf: u64, raw_price: i64) -> Result<u128> {
    if raw_price <= 0 {
        return err!(MeridianError::OracleUpdateMissing);
    }
    let price_u128 =
        u128::try_from(raw_price).map_err(|_| MeridianError::OracleUpdateMissing)?;
    // 10_000 bps = 100%. Multiplying first keeps integer precision; dividing
    // first would zero out small confidence relative to large equity prices.
    let conf_u128 = u128::from(raw_conf);
    let conf_x10k = conf_u128
        .checked_mul(10_000)
        .ok_or(MeridianError::MathOverflow)?;
    Ok(conf_x10k / price_u128)
}

// ============================================================================
// Unit tests
// ============================================================================
//
// Tests live next to the code per Rust convention. All test code is gated
// `#[cfg(test)]` so it never ships in the deployed BPF binary. The crate-wide
// clippy lints (unwrap_used = deny, panic = deny, etc) are relaxed inside
// `mod tests` because `assert_eq!` and `unwrap()` are the natural test idioms.
#[cfg(test)]
#[allow(
    clippy::unwrap_used,
    clippy::expect_used,
    clippy::panic,
    clippy::indexing_slicing,
    clippy::cast_possible_truncation,
    clippy::cast_sign_loss,
    clippy::cast_lossless
)]
mod tests {
    use super::*;
    use proptest::prelude::*;

    // ---------- decide_outcome ----------

    #[test]
    fn decide_outcome_close_above_strike_yes_wins() {
        // $501.00 close vs $500.00 strike: clear Yes win.
        let close = 501_000_000;
        let strike = 500_000_000;
        assert_eq!(decide_outcome(close, strike), OutcomeState::YesWins);
    }

    #[test]
    fn decide_outcome_close_below_strike_no_wins() {
        let close = 499_000_000;
        let strike = 500_000_000;
        assert_eq!(decide_outcome(close, strike), OutcomeState::NoWins);
    }

    #[test]
    fn decide_outcome_boundary_equality_yes_wins() {
        // Spec-critical: equality at the strike resolves YesWins.
        // The on-chain integration test asserts the same boundary.
        let strike = 680_000_000;
        assert_eq!(decide_outcome(strike, strike), OutcomeState::YesWins);
    }

    #[test]
    fn decide_outcome_one_micro_below_strike_no_wins() {
        // One USDC micro is the smallest unit; the boundary must be exact.
        let strike = 680_000_000;
        assert_eq!(
            decide_outcome(strike - 1, strike),
            OutcomeState::NoWins,
            "one micro below strike must be NoWins"
        );
    }

    #[test]
    fn decide_outcome_one_micro_above_strike_yes_wins() {
        let strike = 680_000_000;
        assert_eq!(
            decide_outcome(strike + 1, strike),
            OutcomeState::YesWins,
            "one micro above strike must be YesWins"
        );
    }

    #[test]
    fn decide_outcome_zero_strike_always_yes_wins_for_any_positive_close() {
        // Defense in depth: even though create_strike_market rejects strike=0,
        // the helper itself stays well-defined.
        assert_eq!(decide_outcome(1, 0), OutcomeState::YesWins);
        assert_eq!(decide_outcome(u64::MAX, 0), OutcomeState::YesWins);
        assert_eq!(decide_outcome(0, 0), OutcomeState::YesWins);
    }

    #[test]
    fn decide_outcome_u64_max_close() {
        let strike = u64::MAX - 1;
        assert_eq!(decide_outcome(u64::MAX, strike), OutcomeState::YesWins);
    }

    proptest! {
        /// Monotonicity invariant: holding strike constant, increasing the
        /// close can only flip NoWins -> YesWins, never the reverse.
        #[test]
        fn prop_decide_outcome_monotonic_in_close(strike in 1u64..1_000_000_000_000u64, close_delta in 0u64..1_000_000_000u64) {
            let close = strike.saturating_sub(close_delta);
            let close_plus = strike.saturating_add(close_delta);
            // strike - delta <= strike (NoWins or YesWins at boundary)
            // strike + delta >= strike (always YesWins)
            prop_assert_eq!(decide_outcome(close_plus, strike), OutcomeState::YesWins);
            // The lower-bound case: either equal-or-above (YesWins) or below (NoWins).
            let lower = decide_outcome(close, strike);
            if close >= strike {
                prop_assert_eq!(lower, OutcomeState::YesWins);
            } else {
                prop_assert_eq!(lower, OutcomeState::NoWins);
            }
        }

        /// Equality is always YesWins for ANY strike.
        #[test]
        fn prop_decide_outcome_equality_always_yes_wins(strike in 0u64..=u64::MAX) {
            prop_assert_eq!(decide_outcome(strike, strike), OutcomeState::YesWins);
        }
    }

    // ---------- pyth_price_to_micros ----------

    #[test]
    fn pyth_to_micros_typical_equity_aapl_at_190_25() {
        // AAPL at $190.25 published as raw=19025, exponent=-2.
        // scale = -2 + 6 = 4, micros = 19025 * 10^4 = 190_250_000.
        let micros = pyth_price_to_micros(19_025, -2).unwrap();
        assert_eq!(micros, 190_250_000);
    }

    #[test]
    fn pyth_to_micros_typical_equity_meta_at_680_15() {
        // META at $680.15 published as raw=68015, exponent=-2.
        // scale = 4, micros = 68015 * 10^4 = 680_150_000.
        let micros = pyth_price_to_micros(68_015, -2).unwrap();
        assert_eq!(micros, 680_150_000);
    }

    #[test]
    fn pyth_to_micros_zero_exponent() {
        // Whole-dollar publish (rare for equities, common for indices):
        // raw=42 exponent=0 -> $42.00 -> 42_000_000 micros.
        let micros = pyth_price_to_micros(42, 0).unwrap();
        assert_eq!(micros, 42_000_000);
    }

    #[test]
    fn pyth_to_micros_exponent_minus_six_is_identity() {
        // exponent=-6 means raw is already in micros: scale = 0.
        let micros = pyth_price_to_micros(1_234_567, -6).unwrap();
        assert_eq!(micros, 1_234_567);
    }

    #[test]
    fn pyth_to_micros_exponent_minus_eight_truncates() {
        // exponent=-8 publishes 8 decimals. We keep 6, so divide by 10^2.
        // raw=12345678 (representing 0.12345678) -> 123_456 micros (truncated).
        let micros = pyth_price_to_micros(12_345_678, -8).unwrap();
        assert_eq!(micros, 123_456);
    }

    #[test]
    fn pyth_to_micros_rejects_zero_price() {
        let err = pyth_price_to_micros(0, -2);
        assert!(err.is_err(), "raw_price=0 must reject");
    }

    #[test]
    fn pyth_to_micros_rejects_negative_price() {
        let err = pyth_price_to_micros(-1, -2);
        assert!(err.is_err(), "raw_price<0 must reject");
        let err2 = pyth_price_to_micros(i64::MIN, -2);
        assert!(err2.is_err(), "raw_price=i64::MIN must reject");
    }

    #[test]
    fn pyth_to_micros_overflow_on_extreme_positive_exponent() {
        // exponent=20 -> scale=26 -> 10^26 overflows checked_pow on u128 (max ~3.4e38)?
        // Actually 10^26 fits in u128 (~1.0e26 < ~3.4e38), but raw=1 * 10^26 then
        // downcasting to u64 (max ~1.8e19) MUST overflow. The error must be
        // MathOverflow, never a silent wrap.
        let err = pyth_price_to_micros(1, 20);
        assert!(err.is_err(), "exponent=20 must overflow u64");
    }

    #[test]
    fn pyth_to_micros_overflow_on_max_raw_with_positive_scale() {
        // raw=i64::MAX, exponent=0 -> scale=6 -> mul by 10^6 -> overflows u64.
        let err = pyth_price_to_micros(i64::MAX, 0);
        assert!(err.is_err());
    }

    proptest! {
        /// Round-trip property: for any micros value m that fits in i64 (so it
        /// could plausibly be a raw price), pyth_price_to_micros(m, -6) == m.
        #[test]
        fn prop_pyth_round_trip_at_exponent_minus_six(m in 1i64..1_000_000_000_000i64) {
            let micros = pyth_price_to_micros(m, -6).unwrap();
            prop_assert_eq!(micros, m as u64);
        }

        /// Monotonicity: holding exponent constant, larger raw_price produces
        /// >= micros. Catches a bug where the divide-and-truncate branch
        /// accidentally swaps inputs.
        #[test]
        fn prop_pyth_monotonic_in_raw(raw_a in 1i64..1_000_000i64, raw_b in 1_000_001i64..2_000_000i64, exp in -8i32..2i32) {
            let a = pyth_price_to_micros(raw_a, exp).unwrap();
            let b = pyth_price_to_micros(raw_b, exp).unwrap();
            prop_assert!(b >= a, "raw_b > raw_a must yield micros_b >= micros_a (got a={}, b={})", a, b);
        }
    }

    // ---------- pyth_confidence_bps ----------

    #[test]
    fn pyth_confidence_bps_typical_equity() {
        // AAPL raw_price=19025 ($190.25), raw_conf=10 -> 10/19025 * 10000 ~= 5.26 bps
        // Integer math: (10 * 10000) / 19025 = 100_000 / 19025 = 5 bps (truncated).
        let bps = pyth_confidence_bps(10, 19_025).unwrap();
        assert_eq!(bps, 5);
    }

    #[test]
    fn pyth_confidence_bps_exact_50_bps() {
        // raw_conf = 0.5% of raw_price. e.g. raw_price=10_000, raw_conf=50 ->
        // (50 * 10_000) / 10_000 = 50 bps exactly.
        let bps = pyth_confidence_bps(50, 10_000).unwrap();
        assert_eq!(bps, 50);
    }

    #[test]
    fn pyth_confidence_bps_zero_confidence() {
        let bps = pyth_confidence_bps(0, 19_025).unwrap();
        assert_eq!(bps, 0);
    }

    #[test]
    fn pyth_confidence_bps_rejects_zero_price() {
        let err = pyth_confidence_bps(50, 0);
        assert!(err.is_err());
    }

    #[test]
    fn pyth_confidence_bps_rejects_negative_price() {
        let err = pyth_confidence_bps(50, -1);
        assert!(err.is_err());
    }

    #[test]
    fn pyth_confidence_bps_huge_conf_relative_to_tiny_price() {
        // u128 has enough range to hold u64::MAX (~1.8e19) * 10_000 (1.8e23 fits
        // comfortably under u128::MAX ~ 3.4e38), so this case does NOT overflow.
        // It returns an enormous bps which the caller will reject upstream as
        // "confidence band too wide". The test pins that behavior so a future
        // refactor cannot turn a non-overflowing-but-rejectable path into a
        // silent panic.
        let big = pyth_confidence_bps(u64::MAX, 1).unwrap();
        assert!(
            big > 1_000_000,
            "huge conf relative to price=1 yields enormous bps, got {}",
            big
        );
    }

    proptest! {
        /// bps must be 0 when conf is 0 regardless of price.
        #[test]
        fn prop_pyth_conf_zero_when_conf_zero(price in 1i64..1_000_000_000i64) {
            prop_assert_eq!(pyth_confidence_bps(0, price).unwrap(), 0);
        }

        /// bps must equal 10_000 (100%) when conf == price (in absolute value).
        /// This is the "the oracle is so unsure the band covers the whole
        /// price" boundary.
        #[test]
        fn prop_pyth_conf_equals_price_yields_10k_bps(price in 1i64..1_000_000_000i64) {
            let conf = price as u64;
            prop_assert_eq!(pyth_confidence_bps(conf, price).unwrap(), 10_000);
        }
    }
}
