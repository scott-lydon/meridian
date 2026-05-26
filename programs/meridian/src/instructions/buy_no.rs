//! buy_no — atomic mint-pair + IOC-sell-Yes against the best bid.
//!
//! User signs ONCE. Program:
//! 1. Pulls `qty * $1.00 USDC` from user into the market's vault.
//! 2. Mints `qty` Yes + `qty` No to the user.
//! 3. Walks the best bid in the order book; fills against it.
//! 4. Transfers user's Yes (just minted) to bid maker's Yes ATA.
//! 5. Transfers bid maker's escrowed USDC (already in usdc_escrow) to user.
//! 6. Decrements bid.qty; removes if zero.
//!
//! Net: user holds `qty` No, paid `qty * (1.00 - bid_price)` USDC.
//! Reverts atomically if the best bid is gone or below the caller's
//! min_bid_price_ticks (slippage protection).

use anchor_lang::prelude::*;
use anchor_spl::token::{self, Mint, MintTo, Token, TokenAccount, Transfer};

use crate::constants::{
    CONFIG_SEED, MAX_TICKERS, NO_MINT_SEED, PROGRAM_VERSION, USDC_BASE_PER_DOLLAR,
    VAULT_AUTH_SEED, YES_MINT_SEED,
};
use crate::error::MeridianError;
use crate::order_book::{OrderBook, OrderSide, TICK_SIZE_BASE};
use crate::state::{Config, Market};

use super::init_order_book::{BOOK_AUTH_SEED, ORDER_BOOK_SEED};

const _: usize = MAX_TICKERS; // silence unused if future refactor drops the import

#[derive(Accounts)]
pub struct BuyNo<'info> {
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
    pub usdc_escrow: Box<Account<'info, TokenAccount>>,

    /// Yes ATA of the bid maker (receives Yes tokens).
    #[account(
        mut,
        token::mint = market.yes_mint,
    )]
    pub bid_maker_yes: Box<Account<'info, TokenAccount>>,

    /// User's USDC source.
    #[account(
        mut,
        token::mint = config.usdc_mint,
        token::authority = user,
    )]
    pub user_usdc: Box<Account<'info, TokenAccount>>,

    /// User's Yes ATA — used as a transient sink for the minted Yes.
    #[account(
        mut,
        token::mint = yes_mint,
        token::authority = user,
    )]
    pub user_yes: Box<Account<'info, TokenAccount>>,

    /// User's No ATA — destination for the No half of the pair.
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
    ctx: Context<BuyNo>,
    qty: u64,
    min_bid_price_ticks: u32,
) -> Result<()> {
    require!(qty > 0, MeridianError::InvalidQuantity);
    require!(!ctx.accounts.config.paused, MeridianError::ProgramPaused);
    require!(
        !ctx.accounts.market.outcome.is_settled(),
        MeridianError::MarketAlreadySettled
    );

    let market_key = ctx.accounts.market.key();
    let vault_auth_bump = ctx.accounts.market.vault_authority_bump;
    let book_auth_bump = ctx.bumps.book_authority;

    // Read best bid (immutable borrow scope). Each failure path emits a msg!()
    // BEFORE the require so the on-chain log surfaces the actual vs expected
    // values — keeps debug-after-revert one log scan instead of a guess.
    let (bid_price_ticks, bid_owner) = {
        let book = ctx.accounts.order_book.load()?;
        if book.usdc_escrow != ctx.accounts.usdc_escrow.key() {
            msg!(
                "WrongVaultAccount: usdc_escrow supplied={} but book records={}",
                ctx.accounts.usdc_escrow.key(),
                book.usdc_escrow
            );
            return err!(MeridianError::WrongVaultAccount);
        }
        if book.bids_len == 0 {
            msg!("IocPartialFillRejected: no bids in book — buy_no needs liquidity");
            return err!(MeridianError::IocPartialFillRejected);
        }
        let bid = book.bids[0];
        if bid.qty < qty {
            msg!(
                "IocPartialFillRejected: best_bid_qty={} < requested_qty={}",
                bid.qty,
                qty
            );
            return err!(MeridianError::IocPartialFillRejected);
        }
        if bid.price_ticks < min_bid_price_ticks {
            msg!(
                "IocPartialFillRejected (slippage): best_bid_price={} < min_required={}",
                bid.price_ticks,
                min_bid_price_ticks
            );
            return err!(MeridianError::IocPartialFillRejected);
        }
        if ctx.accounts.bid_maker_yes.owner != bid.owner {
            msg!(
                "OrderNotFound: bid_maker_yes.owner={} but best_bid.owner={} — caller supplied wrong maker ATA",
                ctx.accounts.bid_maker_yes.owner,
                bid.owner
            );
            return err!(MeridianError::OrderNotFound);
        }
        // Self-matching protection. If the best bid was placed by the caller,
        // the SPL Transfer at step 2 becomes user_yes -> user_yes (same ATA),
        // which is a no-op. The mint_pair leg still gives the caller 1 YES + 1 NO
        // and the usdc_escrow refund still returns the caller's own escrowed
        // USDC, so the caller ends up holding BOTH halves of the pair while
        // having only paid the (1.00 - bid_price) net difference. The 2026-05-26
        // user report — "I tapped Buy No but I still have a YES" — is exactly
        // this. Reject so the frontend can either disable the button or prompt
        // a cancel_order first. The frontend ALSO disables the button when
        // best_bid.owner == publicKey for the same reason, but this on-chain
        // check is the load-bearing one; the UI hint is convenience.
        if bid.owner == ctx.accounts.user.key() {
            msg!(
                "SelfMatchingForbidden: best_bid.owner={} == caller — would self-cross. Cancel your own bid first.",
                bid.owner
            );
            return err!(MeridianError::SelfMatchingForbidden);
        }
        (bid.price_ticks, bid.owner)
    };

    // 1. mint_pair: pull qty USDC, mint qty Yes + qty No
    let usdc_to_vault = qty
        .checked_mul(USDC_BASE_PER_DOLLAR)
        .ok_or(MeridianError::MathOverflow)?;
    require!(
        ctx.accounts.user_usdc.amount >= usdc_to_vault,
        MeridianError::InsufficientBalance
    );
    token::transfer(
        CpiContext::new(
            ctx.accounts.token_program.to_account_info(),
            Transfer {
                from: ctx.accounts.user_usdc.to_account_info(),
                to: ctx.accounts.vault.to_account_info(),
                authority: ctx.accounts.user.to_account_info(),
            },
        ),
        usdc_to_vault,
    )?;

    let vault_signer: &[&[&[u8]]] = &[&[
        VAULT_AUTH_SEED,
        market_key.as_ref(),
        &[PROGRAM_VERSION],
        &[vault_auth_bump],
    ]];
    token::mint_to(
        CpiContext::new_with_signer(
            ctx.accounts.token_program.to_account_info(),
            MintTo {
                mint: ctx.accounts.yes_mint.to_account_info(),
                to: ctx.accounts.user_yes.to_account_info(),
                authority: ctx.accounts.vault_authority.to_account_info(),
            },
            vault_signer,
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
            vault_signer,
        ),
        qty,
    )?;

    // 2. Sell Yes against the best bid: user_yes -> bid_maker_yes
    token::transfer(
        CpiContext::new(
            ctx.accounts.token_program.to_account_info(),
            Transfer {
                from: ctx.accounts.user_yes.to_account_info(),
                to: ctx.accounts.bid_maker_yes.to_account_info(),
                authority: ctx.accounts.user.to_account_info(),
            },
        ),
        qty,
    )?;

    // 3. Pay user from usdc_escrow at bid's price.
    let usdc_to_user = u64::from(bid_price_ticks)
        .checked_mul(TICK_SIZE_BASE)
        .and_then(|p| p.checked_mul(qty))
        .ok_or(MeridianError::MathOverflow)?;
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
                from: ctx.accounts.usdc_escrow.to_account_info(),
                to: ctx.accounts.user_usdc.to_account_info(),
                authority: ctx.accounts.book_authority.to_account_info(),
            },
            book_signer,
        ),
        usdc_to_user,
    )?;

    // 4. Decrement bid (mut borrow scope after CPIs).
    {
        let mut book = ctx.accounts.order_book.load_mut()?;
        book.bids[0].qty = book.bids[0]
            .qty
            .checked_sub(qty)
            .ok_or(MeridianError::MathOverflow)?;
        if book.bids[0].qty == 0 {
            book.remove_at(OrderSide::Bid, 0)?;
        }
    }

    msg!(
        "meridian: buy_no qty={} bid_price_ticks={} bid_owner={} net_cost={}",
        qty,
        bid_price_ticks,
        bid_owner,
        usdc_to_vault - usdc_to_user
    );
    Ok(())
}
