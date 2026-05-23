//! redeem_pair — burn N Yes + N No, receive N USDC back from the vault.
//!
//! Inverse of `mint_pair`. Lets a user unwind a paired position before
//! settlement so they recover their collateral without waiting for the
//! market to resolve. Critical for the "I minted 3 pair on an empty
//! order book and now my $3 USDC is stuck" scenario — without this
//! instruction the only exits pre-settlement are (a) sell Yes into the
//! book at some discount, leaving a No-only exposure, or (b) sell No
//! via the atomic IOC helper, which also requires book liquidity.
//! Both fail on an empty book.
//!
//! Anyone can call. Enforces:
//! - market is not paused
//! - market is NOT settled (post-settlement, the asymmetric `redeem`
//!   instruction is the right call — one side pays $1, the other $0.
//!   redeem_pair is a pre-settlement convenience that requires both
//!   sides to be present in the caller's ATAs)
//! - quantity > 0
//! - user holds >= qty YES and >= qty NO
//! - vault has >= qty USDC (always true by vault invariant; defensive
//!   check below catches a corrupted vault state)
//!
//! Vault invariant after this op:
//!   vault_balance == previous_balance - qty
//!   yes_supply    == previous_yes_supply - qty
//!   no_supply     == previous_no_supply - qty
//!
//! The invariant `vault_balance == yes_supply == no_supply` is preserved
//! because we burn exactly `qty` from each of yes_mint and no_mint and
//! transfer exactly `qty * USDC_BASE_PER_DOLLAR` out of the vault.

use anchor_lang::prelude::*;
use anchor_spl::token::{self, Burn, Mint, Token, TokenAccount, Transfer};

use crate::constants::{
    CONFIG_SEED, NO_MINT_SEED, PROGRAM_VERSION, USDC_BASE_PER_DOLLAR, VAULT_AUTH_SEED,
    YES_MINT_SEED,
};
use crate::error::MeridianError;
use crate::state::{Config, Market};

#[derive(Accounts)]
pub struct RedeemPair<'info> {
    #[account(
        seeds = [CONFIG_SEED, &[PROGRAM_VERSION]],
        bump = config.bump,
    )]
    pub config: Box<Account<'info, Config>>,

    #[account(
        mut,
        has_one = vault @ MeridianError::WrongVaultAccount,
        has_one = yes_mint @ MeridianError::WrongTokenMint,
        has_one = no_mint @ MeridianError::WrongTokenMint,
    )]
    pub market: Box<Account<'info, Market>>,

    /// CHECK: PDA, signs the USDC transfer from vault to user via seeds.
    /// The burn CPIs do NOT need this signer — the user owns the token
    /// accounts being burned from, so `user` is the burn authority.
    #[account(
        seeds = [VAULT_AUTH_SEED, market.key().as_ref(), &[PROGRAM_VERSION]],
        bump = market.vault_authority_bump,
    )]
    pub vault_authority: UncheckedAccount<'info>,

    #[account(
        mut,
        seeds = [YES_MINT_SEED, market.key().as_ref(), &[PROGRAM_VERSION]],
        bump = market.yes_mint_bump,
    )]
    pub yes_mint: Box<Account<'info, Mint>>,

    #[account(
        mut,
        seeds = [NO_MINT_SEED, market.key().as_ref(), &[PROGRAM_VERSION]],
        bump = market.no_mint_bump,
    )]
    pub no_mint: Box<Account<'info, Mint>>,

    #[account(mut)]
    pub vault: Box<Account<'info, TokenAccount>>,

    /// USDC destination for the redeemer.
    #[account(
        mut,
        token::mint = config.usdc_mint,
        token::authority = user,
    )]
    pub user_usdc: Box<Account<'info, TokenAccount>>,

    /// User's Yes ATA — burn source.
    #[account(
        mut,
        token::mint = yes_mint,
        token::authority = user,
    )]
    pub user_yes: Box<Account<'info, TokenAccount>>,

    /// User's No ATA — burn source.
    #[account(
        mut,
        token::mint = no_mint,
        token::authority = user,
    )]
    pub user_no: Box<Account<'info, TokenAccount>>,

    #[account(mut)]
    pub user: Signer<'info>,

    pub token_program: Program<'info, Token>,
}

pub fn handler(ctx: Context<RedeemPair>, qty: u64) -> Result<()> {
    require!(qty > 0, MeridianError::InvalidQuantity);
    require!(!ctx.accounts.config.paused, MeridianError::ProgramPaused);
    // After settlement, the asymmetric `redeem` instruction is the
    // economically meaningful path: one side pays $1, the other $0.
    // Calling redeem_pair post-settlement would burn both sides for a
    // combined $1 payout (mathematically equivalent to redeeming both
    // separately), so technically safe, but the user almost certainly
    // does not want that — if the winner pays $1 and they redeem the
    // pair, they get the same $1 they'd get from redeeming the winner
    // alone, throwing away the loser's separately-redeemable $0 ATA
    // rent. Reject and force the user to use `redeem` instead, which
    // makes the choice explicit.
    require!(
        !ctx.accounts.market.outcome.is_settled(),
        MeridianError::MarketAlreadySettled
    );

    // qty pairs return qty * 1.00 USDC = qty * USDC_BASE_PER_DOLLAR.
    let usdc_owed = qty
        .checked_mul(USDC_BASE_PER_DOLLAR)
        .ok_or(MeridianError::MathOverflow)?;

    // Defensive: surface invariant breakage instead of a confusing SPL
    // "insufficient funds" error. If we ever hit this it means the vault
    // has drifted from yes_supply / no_supply — a real bug, not a user
    // problem.
    require!(
        ctx.accounts.vault.amount >= usdc_owed,
        MeridianError::VaultInvariantViolated
    );

    // The token program checks user ATA balances during Burn, but
    // pre-checking lets us return a typed MeridianError instead of an
    // opaque SPL error code — easier to diagnose from the explorer log.
    require!(
        ctx.accounts.user_yes.amount >= qty,
        MeridianError::InsufficientBalance
    );
    require!(
        ctx.accounts.user_no.amount >= qty,
        MeridianError::InsufficientBalance
    );

    // 1) Burn qty YES from user_yes. User signs (owns the ATA).
    token::burn(
        CpiContext::new(
            ctx.accounts.token_program.to_account_info(),
            Burn {
                mint: ctx.accounts.yes_mint.to_account_info(),
                from: ctx.accounts.user_yes.to_account_info(),
                authority: ctx.accounts.user.to_account_info(),
            },
        ),
        qty,
    )?;

    // 2) Burn qty NO from user_no. Same authority pattern.
    token::burn(
        CpiContext::new(
            ctx.accounts.token_program.to_account_info(),
            Burn {
                mint: ctx.accounts.no_mint.to_account_info(),
                from: ctx.accounts.user_no.to_account_info(),
                authority: ctx.accounts.user.to_account_info(),
            },
        ),
        qty,
    )?;

    // 3) Transfer usdc_owed from vault to user_usdc. Vault authority
    //    is a PDA, signed via the same seeds pattern used in mint_pair
    //    and redeem.
    let market_key = ctx.accounts.market.key();
    let auth_bump = ctx.accounts.market.vault_authority_bump;
    let signer_seeds: &[&[&[u8]]] = &[&[
        VAULT_AUTH_SEED,
        market_key.as_ref(),
        &[PROGRAM_VERSION],
        &[auth_bump],
    ]];

    token::transfer(
        CpiContext::new_with_signer(
            ctx.accounts.token_program.to_account_info(),
            Transfer {
                from: ctx.accounts.vault.to_account_info(),
                to: ctx.accounts.user_usdc.to_account_info(),
                authority: ctx.accounts.vault_authority.to_account_info(),
            },
            signer_seeds,
        ),
        usdc_owed,
    )?;

    msg!(
        "meridian: redeemed {} pair(s), usdc_out={}",
        qty,
        usdc_owed
    );
    Ok(())
}
