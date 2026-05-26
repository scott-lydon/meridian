//! admin_settle — admin-only override for when the oracle fails.
//! Enforces the time-delay window from Config.

use anchor_lang::prelude::*;

use crate::constants::{CONFIG_SEED, PROGRAM_VERSION};
use crate::error::MeridianError;
use crate::math::decide_outcome;
use crate::state::{Config, Market, Outcome};

#[derive(Accounts)]
pub struct AdminSettle<'info> {
    #[account(
        seeds = [CONFIG_SEED, &[PROGRAM_VERSION]],
        bump = config.bump,
    )]
    pub config: Box<Account<'info, Config>>,

    #[account(mut)]
    pub market: Box<Account<'info, Market>>,

    #[account(address = config.admin @ MeridianError::Unauthorized)]
    pub admin: Signer<'info>,
}

pub fn handler(ctx: Context<AdminSettle>, closing_price_micros: u64) -> Result<()> {
    let market = &mut ctx.accounts.market;
    require!(!market.outcome.is_settled(), MeridianError::MarketAlreadySettled);
    require!(closing_price_micros > 0, MeridianError::InvalidStrike);

    let now = Clock::get()?.unix_timestamp;
    // Time-delay: cannot fire until market.admin_override_earliest passes.
    if now < market.admin_override_earliest {
        msg!(
            "admin_settle blocked: now={} < earliest={}",
            now,
            market.admin_override_earliest
        );
        return err!(MeridianError::AdminOverrideTooEarly);
    }

    // See `math::decide_outcome` for the boundary spec.
    let state = decide_outcome(closing_price_micros, market.strike_usd_micros);

    market.outcome = Outcome {
        state,
        closing_price_micros,
        settled_at_unix: now,
        admin_override: true,
    };

    msg!(
        "meridian: admin_settle strike={} close={} -> {:?}",
        market.strike_usd_micros,
        closing_price_micros,
        state
    );
    Ok(())
}
