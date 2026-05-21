//! settle_market — permissionless, Pyth-verified settlement.
//!
//! Anyone can call after market close. Validates:
//! 1. Pyth feed_id matches the one stored on the Market.
//! 2. publish_time is within config.max_staleness_secs.
//! 3. confidence band is within config.max_confidence_bps.
//!
//! Writes Outcome and locks it immutably.

use anchor_lang::prelude::*;
use pyth_solana_receiver_sdk::price_update::PriceUpdateV2;

use crate::constants::{CONFIG_SEED, PROGRAM_VERSION, USDC_BASE_PER_DOLLAR};
use crate::error::MeridianError;
use crate::state::{Config, Market, Outcome, OutcomeState};

#[derive(Accounts)]
pub struct SettleMarket<'info> {
    #[account(
        seeds = [CONFIG_SEED, &[PROGRAM_VERSION]],
        bump = config.bump,
    )]
    pub config: Box<Account<'info, Config>>,

    #[account(mut)]
    pub market: Box<Account<'info, Market>>,

    /// Pyth price update account. Caller (cranker) posts a fresh one before
    /// calling this instruction.
    pub price_update: Box<Account<'info, PriceUpdateV2>>,

    /// Cranker pays the tx fee.
    pub cranker: Signer<'info>,
}

pub fn handler(ctx: Context<SettleMarket>) -> Result<()> {
    let market = &mut ctx.accounts.market;
    require!(!market.outcome.is_settled(), MeridianError::MarketAlreadySettled);

    let now = Clock::get()?.unix_timestamp;
    require!(now >= market.expiry_unix, MeridianError::SettleTooEarly);

    let pu = &ctx.accounts.price_update;
    let feed_id = pu.price_message.feed_id;
    if feed_id != market.pyth_feed_id {
        msg!(
            "OracleFeedMismatch: price_update.feed_id={:?} but market expects feed_id={:?}",
            feed_id,
            market.pyth_feed_id
        );
        return err!(MeridianError::OracleFeedMismatch);
    }

    // Staleness check (expressive)
    let publish_time = pu.price_message.publish_time;
    let age = now.saturating_sub(publish_time);
    if age < 0 || (age as u64) > ctx.accounts.config.max_staleness_secs {
        msg!(
            "OraclePriceStale: now={} publish_time={} age={}s but max_staleness={}s",
            now,
            publish_time,
            age,
            ctx.accounts.config.max_staleness_secs
        );
        return err!(MeridianError::OraclePriceStale);
    }

    let raw_price = pu.price_message.price;
    let raw_conf = pu.price_message.conf;
    let exponent = pu.price_message.exponent;
    if raw_price <= 0 {
        msg!("OracleUpdateMissing: raw_price={} (must be > 0)", raw_price);
        return err!(MeridianError::OracleUpdateMissing);
    }

    let conf_bps: u128 = (u128::from(raw_conf) * 10_000)
        / u128::try_from(raw_price).map_err(|_| MeridianError::OracleUpdateMissing)?;
    if conf_bps > u128::from(ctx.accounts.config.max_confidence_bps) {
        msg!(
            "OracleConfidenceTooWide: conf_bps={} > max_confidence_bps={} (raw_conf={}, raw_price={})",
            conf_bps,
            ctx.accounts.config.max_confidence_bps,
            raw_conf,
            raw_price
        );
        return err!(MeridianError::OracleConfidenceTooWide);
    }

    // Scale price to USDC base units (6 decimals).
    // closing_price_micros = raw_price * 10^(exponent + 6)
    let scale = i64::from(exponent) + 6;
    let price_u128 = u128::try_from(raw_price).map_err(|_| MeridianError::OracleUpdateMissing)?;
    let closing_price_micros: u64 = if scale >= 0 {
        let mul = 10u128
            .checked_pow(u32::try_from(scale).map_err(|_| MeridianError::MathOverflow)?)
            .ok_or(MeridianError::MathOverflow)?;
        u64::try_from(price_u128.checked_mul(mul).ok_or(MeridianError::MathOverflow)?)
            .map_err(|_| MeridianError::MathOverflow)?
    } else {
        let div = 10u128
            .checked_pow(u32::try_from(-scale).map_err(|_| MeridianError::MathOverflow)?)
            .ok_or(MeridianError::MathOverflow)?;
        u64::try_from(price_u128 / div).map_err(|_| MeridianError::MathOverflow)?
    };

    let state = if closing_price_micros >= market.strike_usd_micros {
        OutcomeState::YesWins
    } else {
        OutcomeState::NoWins
    };

    market.outcome = Outcome {
        state,
        closing_price_micros,
        settled_at_unix: now,
        admin_override: false,
    };

    msg!(
        "meridian: settle_market strike={} close={} -> {:?} (conf_bps={}, age={}s)",
        market.strike_usd_micros,
        closing_price_micros,
        state,
        conf_bps,
        age
    );

    // Compile-time touch so USDC_BASE_PER_DOLLAR stays in scope for invariants.
    let _ = USDC_BASE_PER_DOLLAR;
    Ok(())
}
