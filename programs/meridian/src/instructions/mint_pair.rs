//! mint_pair — deposit N USDC, receive N Yes + N No.
//!
//! Anyone can call. Enforces:
//! - market is not paused
//! - market is not settled (no minting after settlement)
//! - quantity > 0
//! - USDC transfer from user to vault succeeds before any Yes/No is minted
//!
//! Vault invariant after this op:
//!   vault_balance == previous_balance + qty
//!   yes_supply    == previous_yes_supply + qty
//!   no_supply     == previous_no_supply + qty

use anchor_lang::prelude::*;
use anchor_spl::token::{self, Mint, MintTo, Token, TokenAccount, Transfer};

use crate::constants::{NO_MINT_SEED, PROGRAM_VERSION, VAULT_AUTH_SEED, YES_MINT_SEED};
use crate::error::MeridianError;
use crate::state::{Config, Market};

#[derive(Accounts)]
pub struct MintPair<'info> {
    #[account(
        seeds = [crate::constants::CONFIG_SEED, &[PROGRAM_VERSION]],
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

    /// CHECK: PDA, signs the mint cpi via seeds.
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

    /// User's USDC source account.
    #[account(
        mut,
        token::mint = config.usdc_mint,
        token::authority = user,
    )]
    pub user_usdc: Box<Account<'info, TokenAccount>>,

    /// User's Yes destination ATA.
    #[account(
        mut,
        token::mint = yes_mint,
        token::authority = user,
    )]
    pub user_yes: Box<Account<'info, TokenAccount>>,

    /// User's No destination ATA.
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

pub fn handler(ctx: Context<MintPair>, qty: u64) -> Result<()> {
    require!(qty > 0, MeridianError::InvalidQuantity);
    require!(!ctx.accounts.config.paused, MeridianError::ProgramPaused);
    require!(
        !ctx.accounts.market.outcome.is_settled(),
        MeridianError::MarketAlreadySettled
    );

    // qty Yes tokens cost qty * 1.00 USDC = qty * USDC_BASE_PER_DOLLAR.
    let usdc_owed = qty
        .checked_mul(crate::constants::USDC_BASE_PER_DOLLAR)
        .ok_or(MeridianError::MathOverflow)?;

    require!(
        ctx.accounts.user_usdc.amount >= usdc_owed,
        MeridianError::InsufficientBalance
    );

    // 1) Transfer USDC from user to vault.
    token::transfer(
        CpiContext::new(
            ctx.accounts.token_program.to_account_info(),
            Transfer {
                from: ctx.accounts.user_usdc.to_account_info(),
                to: ctx.accounts.vault.to_account_info(),
                authority: ctx.accounts.user.to_account_info(),
            },
        ),
        usdc_owed,
    )?;

    // 2) Mint qty Yes and qty No to the user. Vault authority signs.
    let market_key = ctx.accounts.market.key();
    let auth_bump = ctx.accounts.market.vault_authority_bump;
    let signer_seeds: &[&[&[u8]]] = &[&[
        VAULT_AUTH_SEED,
        market_key.as_ref(),
        &[PROGRAM_VERSION],
        &[auth_bump],
    ]];

    token::mint_to(
        CpiContext::new_with_signer(
            ctx.accounts.token_program.to_account_info(),
            MintTo {
                mint: ctx.accounts.yes_mint.to_account_info(),
                to: ctx.accounts.user_yes.to_account_info(),
                authority: ctx.accounts.vault_authority.to_account_info(),
            },
            signer_seeds,
        ),
        qty,
    )?;

    token::mint_to(
        CpiContext::new_with_signer(
            ctx.accounts.token_program.to_account_info(),
            MintTo {
                mint: ctx.accounts.no_mint.to_account_info(),
                to: ctx.accounts.user_no.to_account_info(),
                authority: ctx.accounts.vault_authority.to_account_info(),
            },
            signer_seeds,
        ),
        qty,
    )?;

    msg!("meridian: minted {} pair(s), usdc_in={}", qty, usdc_owed);
    Ok(())
}
