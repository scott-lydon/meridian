//! redeem — burn winning tokens, receive USDC.
//!
//! Side parameter says whether the user holds Yes tokens or No tokens.
//! Winning side gets `qty × $1.00`. Losing side gets `$0.00` but the burn
//! still succeeds (the user reclaims rent on the ATA when balance hits zero;
//! this matches PRD wording on "losers click Redeem too").

use anchor_lang::prelude::*;
use anchor_spl::token::{self, Burn, Token, TokenAccount, Transfer};

use crate::constants::{
    CONFIG_SEED, NO_MINT_SEED, PROGRAM_VERSION, USDC_BASE_PER_DOLLAR, VAULT_AUTH_SEED,
    YES_MINT_SEED,
};
use crate::error::MeridianError;
use crate::state::{Config, Market, OutcomeState};

#[derive(AnchorSerialize, AnchorDeserialize, Clone, Copy, PartialEq, Eq, Debug)]
pub enum RedeemSide {
    Yes,
    No,
}

#[derive(Accounts)]
pub struct Redeem<'info> {
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

    /// CHECK: PDA signer.
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
    pub yes_mint: Box<Account<'info, anchor_spl::token::Mint>>,

    #[account(
        mut,
        seeds = [NO_MINT_SEED, market.key().as_ref(), &[PROGRAM_VERSION]],
        bump = market.no_mint_bump,
    )]
    pub no_mint: Box<Account<'info, anchor_spl::token::Mint>>,

    #[account(mut)]
    pub vault: Box<Account<'info, TokenAccount>>,

    /// USDC destination for the redeemer.
    #[account(
        mut,
        token::mint = config.usdc_mint,
        token::authority = user,
    )]
    pub user_usdc: Box<Account<'info, TokenAccount>>,

    /// User's Yes ATA. Mutated only when side == Yes.
    #[account(
        mut,
        token::mint = yes_mint,
        token::authority = user,
    )]
    pub user_yes: Box<Account<'info, TokenAccount>>,

    /// User's No ATA. Mutated only when side == No.
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

pub fn handler(ctx: Context<Redeem>, side: RedeemSide, qty: u64) -> Result<()> {
    require!(qty > 0, MeridianError::InvalidQuantity);

    let market = &ctx.accounts.market;
    require!(market.outcome.is_settled(), MeridianError::MarketNotSettled);

    // Determine payout per token. Winning side: 1.00 USDC. Losing side: 0.
    let wins_for_yes = matches!(market.outcome.state, OutcomeState::YesWins);
    let user_wins = matches!(
        (side, wins_for_yes),
        (RedeemSide::Yes, true) | (RedeemSide::No, false)
    );

    let usdc_out: u64 = if user_wins {
        qty.checked_mul(USDC_BASE_PER_DOLLAR)
            .ok_or(MeridianError::MathOverflow)?
    } else {
        0
    };

    // Pick which mint + user ATA to burn from.
    let (burn_mint, user_token) = match side {
        RedeemSide::Yes => (
            ctx.accounts.yes_mint.to_account_info(),
            ctx.accounts.user_yes.to_account_info(),
        ),
        RedeemSide::No => (
            ctx.accounts.no_mint.to_account_info(),
            ctx.accounts.user_no.to_account_info(),
        ),
    };

    // 1) Burn the redeemed tokens.
    token::burn(
        CpiContext::new(
            ctx.accounts.token_program.to_account_info(),
            Burn {
                mint: burn_mint,
                from: user_token,
                authority: ctx.accounts.user.to_account_info(),
            },
        ),
        qty,
    )?;

    // 2) If winning, transfer USDC out of the vault.
    if usdc_out > 0 {
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
            usdc_out,
        )?;
    }

    msg!(
        "meridian: redeem side={:?} qty={} usdc_out={}",
        side,
        qty,
        usdc_out
    );
    Ok(())
}
