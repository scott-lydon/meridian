//! pause / unpause — admin toggles the global Config.paused flag.
//!
//! Per constitution §2.10: pause blocks mint and order-book entry
//! instructions. Redeem MUST continue to work even when paused, so winners
//! can always claim. mint_pair, place_order, buy_no, sell_no check
//! `config.paused` and reject with `ProgramPaused`.

use anchor_lang::prelude::*;

use crate::constants::{CONFIG_SEED, PROGRAM_VERSION};
use crate::error::MeridianError;
use crate::state::Config;

#[derive(Accounts)]
pub struct Pause<'info> {
    #[account(
        mut,
        seeds = [CONFIG_SEED, &[PROGRAM_VERSION]],
        bump = config.bump,
    )]
    pub config: Box<Account<'info, Config>>,

    #[account(address = config.admin @ MeridianError::Unauthorized)]
    pub admin: Signer<'info>,
}

pub fn pause_handler(ctx: Context<Pause>) -> Result<()> {
    ctx.accounts.config.paused = true;
    msg!("meridian: PAUSED");
    Ok(())
}

pub fn unpause_handler(ctx: Context<Pause>) -> Result<()> {
    ctx.accounts.config.paused = false;
    msg!("meridian: UNPAUSED");
    Ok(())
}
