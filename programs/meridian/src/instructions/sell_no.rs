//! sell_no — atomic IOC-buy-Yes + redeem-pair against the best ask.
//!
//! User signs ONCE. User holds `qty` No tokens. Program:
//! 1. Pulls `qty * ask_price * 0.01` USDC from user into ask_maker_usdc.
//! 2. yes_escrow releases `qty` Yes to user (transient).
//! 3. Burns `qty` Yes + `qty` No from user.
//! 4. Vault releases `qty * $1.00` USDC to user.
//! 5. Decrements ask.qty; removes if zero.
//!
//! Net: user receives `qty * (1.00 - ask_price)` USDC.

use anchor_lang::prelude::*;
use anchor_spl::token::{self, Burn, Mint, Token, TokenAccount, Transfer};

use crate::constants::{
    CONFIG_SEED, NO_MINT_SEED, PROGRAM_VERSION, USDC_BASE_PER_DOLLAR, VAULT_AUTH_SEED,
    YES_MINT_SEED,
};
use crate::error::MeridianError;
use crate::order_book::{OrderBook, OrderSide, TICK_SIZE_BASE};
use crate::state::{Config, Market};

use super::init_order_book::{BOOK_AUTH_SEED, ORDER_BOOK_SEED};

#[derive(Accounts)]
pub struct SellNo<'info> {
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

    /// CHECK: vault PDA.
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

    #[account(
        mut,
        seeds = [ORDER_BOOK_SEED, market.key().as_ref(), &[PROGRAM_VERSION]],
        bump,
    )]
    pub order_book: AccountLoader<'info, OrderBook>,

    /// CHECK: book PDA.
    #[account(
        seeds = [BOOK_AUTH_SEED, market.key().as_ref(), &[PROGRAM_VERSION]],
        bump,
    )]
    pub book_authority: UncheckedAccount<'info>,

    #[account(mut)]
    pub yes_escrow: Box<Account<'info, TokenAccount>>,

    /// USDC ATA of the ask maker (receives USDC).
    #[account(
        mut,
        token::mint = config.usdc_mint,
    )]
    pub ask_maker_usdc: Box<Account<'info, TokenAccount>>,

    /// User's USDC ATA: pays ask, then receives the pair-redemption USDC.
    #[account(
        mut,
        token::mint = config.usdc_mint,
        token::authority = user,
    )]
    pub user_usdc: Box<Account<'info, TokenAccount>>,

    /// User's Yes ATA: transient sink for the bought Yes (burned next).
    #[account(
        mut,
        token::mint = yes_mint,
        token::authority = user,
    )]
    pub user_yes: Box<Account<'info, TokenAccount>>,

    /// User's No ATA: source for the burn.
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

pub fn handler(
    ctx: Context<SellNo>,
    qty: u64,
    max_ask_price_ticks: u32,
) -> Result<()> {
    require!(qty > 0, MeridianError::InvalidQuantity);
    require!(!ctx.accounts.config.paused, MeridianError::ProgramPaused);
    require!(
        !ctx.accounts.market.outcome.is_settled(),
        MeridianError::MarketAlreadySettled
    );
    require!(
        ctx.accounts.user_no.amount >= qty,
        MeridianError::InsufficientBalance
    );

    let market_key = ctx.accounts.market.key();
    let vault_auth_bump = ctx.accounts.market.vault_authority_bump;
    let book_auth_bump = ctx.bumps.book_authority;

    let (ask_price_ticks, ask_owner) = {
        let book = ctx.accounts.order_book.load()?;
        if book.yes_escrow != ctx.accounts.yes_escrow.key() {
            msg!(
                "WrongVaultAccount: yes_escrow supplied={} but book records={}",
                ctx.accounts.yes_escrow.key(),
                book.yes_escrow
            );
            return err!(MeridianError::WrongVaultAccount);
        }
        if book.asks_len == 0 {
            msg!("IocPartialFillRejected: no asks in book — sell_no needs liquidity");
            return err!(MeridianError::IocPartialFillRejected);
        }
        let ask = book.asks[0];
        if ask.qty < qty {
            msg!(
                "IocPartialFillRejected: best_ask_qty={} < requested_qty={}",
                ask.qty,
                qty
            );
            return err!(MeridianError::IocPartialFillRejected);
        }
        if ask.price_ticks > max_ask_price_ticks {
            msg!(
                "IocPartialFillRejected (slippage): best_ask_price={} > max_allowed={}",
                ask.price_ticks,
                max_ask_price_ticks
            );
            return err!(MeridianError::IocPartialFillRejected);
        }
        if ctx.accounts.ask_maker_usdc.owner != ask.owner {
            msg!(
                "OrderNotFound: ask_maker_usdc.owner={} but best_ask.owner={} — caller supplied wrong maker ATA",
                ctx.accounts.ask_maker_usdc.owner,
                ask.owner
            );
            return err!(MeridianError::OrderNotFound);
        }
        // Self-matching protection (sell_no side). If the best ask was placed
        // by the caller, the USDC transfer at step 1 becomes
        // user_usdc -> user_usdc (same ATA), a no-op, while yes_escrow still
        // releases YES to the caller and the burn + vault payout still proceed.
        // The caller ends up effectively redeeming their own ask's escrowed
        // YES at par while gaining nothing in exchange. Same self-cross class
        // as the buy_no bug fixed in this commit; reject symmetrically.
        if ask.owner == ctx.accounts.user.key() {
            msg!(
                "SelfMatchingForbidden: best_ask.owner={} == caller — would self-cross. Cancel your own ask first.",
                ask.owner
            );
            return err!(MeridianError::SelfMatchingForbidden);
        }
        (ask.price_ticks, ask.owner)
    };

    // 1. User pays ask maker.
    let usdc_to_seller = u64::from(ask_price_ticks)
        .checked_mul(TICK_SIZE_BASE)
        .and_then(|p| p.checked_mul(qty))
        .ok_or(MeridianError::MathOverflow)?;
    require!(
        ctx.accounts.user_usdc.amount >= usdc_to_seller,
        MeridianError::InsufficientBalance
    );
    token::transfer(
        CpiContext::new(
            ctx.accounts.token_program.to_account_info(),
            Transfer {
                from: ctx.accounts.user_usdc.to_account_info(),
                to: ctx.accounts.ask_maker_usdc.to_account_info(),
                authority: ctx.accounts.user.to_account_info(),
            },
        ),
        usdc_to_seller,
    )?;

    // 2. yes_escrow releases Yes to user (transient).
    let book_signer: &[&[&[u8]]] = &[&[
        BOOK_AUTH_SEED,
        market_key.as_ref(),
        &[PROGRAM_VERSION],
        &[book_auth_bump],
    ]];
    token::transfer(
        CpiContext::new_with_signer(
            ctx.accounts.token_program.to_account_info(),
            Transfer {
                from: ctx.accounts.yes_escrow.to_account_info(),
                to: ctx.accounts.user_yes.to_account_info(),
                authority: ctx.accounts.book_authority.to_account_info(),
            },
            book_signer,
        ),
        qty,
    )?;

    // 3. Burn user's Yes + No.
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

    // 4. Vault pays qty * $1.00 USDC back to user (pair redemption).
    let vault_signer: &[&[&[u8]]] = &[&[
        VAULT_AUTH_SEED,
        market_key.as_ref(),
        &[PROGRAM_VERSION],
        &[vault_auth_bump],
    ]];
    let usdc_pair = qty
        .checked_mul(USDC_BASE_PER_DOLLAR)
        .ok_or(MeridianError::MathOverflow)?;
    token::transfer(
        CpiContext::new_with_signer(
            ctx.accounts.token_program.to_account_info(),
            Transfer {
                from: ctx.accounts.vault.to_account_info(),
                to: ctx.accounts.user_usdc.to_account_info(),
                authority: ctx.accounts.vault_authority.to_account_info(),
            },
            vault_signer,
        ),
        usdc_pair,
    )?;

    // 5. Decrement ask in book.
    {
        let mut book = ctx.accounts.order_book.load_mut()?;
        book.asks[0].qty = book.asks[0]
            .qty
            .checked_sub(qty)
            .ok_or(MeridianError::MathOverflow)?;
        if book.asks[0].qty == 0 {
            book.remove_at(OrderSide::Ask, 0)?;
        }
    }

    msg!(
        "meridian: sell_no qty={} ask_price_ticks={} ask_owner={} net_in={}",
        qty,
        ask_price_ticks,
        ask_owner,
        usdc_pair - usdc_to_seller
    );
    Ok(())
}
