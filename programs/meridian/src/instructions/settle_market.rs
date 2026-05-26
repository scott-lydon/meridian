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
use crate::math::{decide_outcome, pyth_confidence_bps, pyth_price_to_micros};
use crate::state::{Config, Market, Outcome};

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

    // Staleness check (expressive). A negative age means the Pyth update's
    // publish_time is in the future relative to our on-chain clock — that's
    // not "stale", it's clock skew on whichever Hermes/cranker produced the
    // VAA. Emit the distinct OraclePriceFromFuture variant so the on-chain
    // log + the cranker's debug loop don't conflate the two and chase the
    // wrong fix. The age is then guaranteed >= 0, so the `as u64` cast can
    // never wrap into a giant positive that masquerades as "fresh".
    let publish_time = pu.price_message.publish_time;
    let age = now.saturating_sub(publish_time);
    if age < 0 {
        msg!(
            "OraclePriceFromFuture: now={} publish_time={} (publish_time is {}s ahead of on-chain clock)",
            now,
            publish_time,
            -age
        );
        return err!(MeridianError::OraclePriceFromFuture);
    }
    if (age as u64) > ctx.accounts.config.max_staleness_secs {
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

    // Confidence band check. See `math::pyth_confidence_bps` for the
    // basis-points formula and the unit tests that pin its boundary cases.
    let conf_bps = pyth_confidence_bps(raw_conf, raw_price)?;
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

    // Scale Pyth's `value * 10^exponent` representation into the program's
    // 6-decimal micros. The helper is the single source of truth for this
    // conversion and is unit-tested across boundary scales in `math.rs`.
    let closing_price_micros = pyth_price_to_micros(raw_price, exponent)?;

    let state = decide_outcome(closing_price_micros, market.strike_usd_micros);

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
