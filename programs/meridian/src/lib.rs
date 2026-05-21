//! Meridian — binary stock outcome markets on Solana.
//!
//! Each strike market resolves on the underlying stock's 4:00 PM ET closing
//! price relative to a fixed strike. Yes pays $1.00 USDC if the stock closes
//! at or above the strike; No pays $1.00 if it closes below. The vault holds
//! exactly `total_pairs × $1.00` at all times.
//!
//! See `constitution.md`, `spec.md`, `plan.md`, `tasks.md` at the repo root
//! for the binding spec.
//!
//! Slice 0: program skeleton with `ping` only. Real instructions arrive in
//! slice 1 (`initialize_config`, `create_strike_market`, `mint_pair`, `redeem`).

#![cfg_attr(feature = "no-entrypoint", allow(unused_imports))]
#![warn(clippy::pedantic, clippy::nursery)]
#![allow(clippy::missing_errors_doc, clippy::module_name_repetitions)]

use anchor_lang::prelude::*;

// Placeholder program-id; replaced after `anchor build` writes
// `target/deploy/meridian-keypair.json`. Slice 1 finalizes this.
declare_id!("499QonPencmcxszHqjKKsMUE6dnbWh1AJ4f9LTrv9t1s");

#[program]
pub mod meridian {
    use super::*;

    /// Sanity instruction. Confirms the program is deployed and callable.
    /// Removed in slice 1 once real instructions land.
    pub fn ping(_ctx: Context<Ping>) -> Result<()> {
        msg!("meridian: ping (slice 0 scaffold)");
        Ok(())
    }
}

#[derive(Accounts)]
pub struct Ping<'info> {
    #[account(mut)]
    pub payer: Signer<'info>,
}
