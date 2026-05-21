//! settle_market_manual — admin sets the closing price directly.
//!
//! Slice 1 test fixture. Slice 2 introduces `settle_market` (Pyth-based,
//! anyone-callable) plus `admin_settle` (admin-only, time-delayed). This
//! manual variant remains as a developer convenience for local tests but
//! is admin-only and the on-chain Outcome is flagged `admin_override=true`
//! so downstream consumers can tell.

use anchor_lang::prelude::*;

use crate::constants::PROGRAM_VERSION;
use crate::error::MeridianError;
use crate::state::{Config, Market, Outcome, OutcomeState};

#[derive(Accounts)]
pub struct SettleMarketManual<'info> {
    #[account(
        seeds = [crate::constants::CONFIG_SEED, &[PROGRAM_VERSION]],
        bump = config.bump,
    )]
    pub config: Account<'info, Config>,

    #[account(mut)]
    pub market: Account<'info, Market>,

    #[account(address = config.admin @ MeridianError::Unauthorized)]
    pub admin: Signer<'info>,
}

pub fn handler(ctx: Context<SettleMarketManual>, closing_price_micros: u64) -> Result<()> {
    let market = &mut ctx.accounts.market;
    require!(!market.outcome.is_settled(), MeridianError::MarketAlreadySettled);
    require!(closing_price_micros > 0, MeridianError::InvalidStrike);

    let state = if closing_price_micros >= market.strike_usd_micros {
        OutcomeState::YesWins
    } else {
        OutcomeState::NoWins
    };

    market.outcome = Outcome {
        state,
        closing_price_micros,
        settled_at_unix: Clock::get()?.unix_timestamp,
        admin_override: true,
    };

    msg!(
        "meridian: manual-settled strike={} close={} -> {:?}",
        market.strike_usd_micros,
        closing_price_micros,
        state
    );
    Ok(())
}
