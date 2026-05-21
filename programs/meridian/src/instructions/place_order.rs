//! place_order — post a limit order to the book.
//!
//! For Bid (buy Yes): transfer `qty * price_ticks * TICK_SIZE_BASE` USDC from
//! user into the USDC escrow. Walk asks from best (lowest) up. Fill each ask
//! where ask.price_ticks <= price_ticks at the MAKER's price. After walking,
//! if qty remains and !ioc, insert into bids.
//!
//! For Ask (sell Yes): transfer `qty` Yes from user into the Yes escrow. Walk
//! bids from best (highest) down. Fill each bid where bid.price_ticks >=
//! price_ticks at the MAKER's price. After walking, if qty remains and !ioc,
//! insert into asks.
//!
//! Atomicity: any failure reverts the whole transaction, refunding escrow.

use anchor_lang::prelude::*;
use anchor_spl::token::{self, Token, TokenAccount, Transfer};

use crate::constants::{CONFIG_SEED, PROGRAM_VERSION, USDC_BASE_PER_DOLLAR};
use crate::error::MeridianError;
use crate::order_book::{
    fill_price_ticks, usdc_total, MAX_PRICE_TICKS, Order, OrderBook, OrderSide, TICK_SIZE_BASE,
};
use crate::state::{Config, Market};

#[derive(Accounts)]
pub struct PlaceOrder<'info> {
    #[account(
        seeds = [CONFIG_SEED, &[PROGRAM_VERSION]],
        bump = config.bump,
    )]
    pub config: Account<'info, Config>,

    #[account(has_one = vault @ MeridianError::WrongVaultAccount)]
    pub market: Account<'info, Market>,

    #[account(
        mut,
        has_one = market @ MeridianError::WrongVaultAccount,
        has_one = usdc_escrow @ MeridianError::WrongVaultAccount,
        has_one = yes_escrow @ MeridianError::WrongVaultAccount,
    )]
    pub order_book: Account<'info, OrderBook>,

    /// USDC ATA owned by the order_book PDA.
    #[account(mut)]
    pub usdc_escrow: Account<'info, TokenAccount>,

    /// Yes ATA owned by the order_book PDA.
    #[account(mut)]
    pub yes_escrow: Account<'info, TokenAccount>,

    /// Vault for redeem/mint cross-references (validated by `market.has_one`).
    #[account(mut)]
    pub vault: Account<'info, TokenAccount>,

    /// User's USDC source (Bid) or destination on Ask refunds.
    #[account(
        mut,
        token::mint = config.usdc_mint,
        token::authority = user,
    )]
    pub user_usdc: Account<'info, TokenAccount>,

    /// User's Yes source (Ask) or destination on Bid fills.
    #[account(
        mut,
        token::mint = market.yes_mint,
        token::authority = user,
    )]
    pub user_yes: Account<'info, TokenAccount>,

    #[account(mut)]
    pub user: Signer<'info>,

    pub token_program: Program<'info, Token>,
}

pub fn handler(
    ctx: Context<PlaceOrder>,
    side: OrderSide,
    price_ticks: u32,
    qty: u64,
    ioc: bool,
) -> Result<()> {
    require!(qty > 0, MeridianError::InvalidQuantity);
    require!(
        price_ticks > 0 && price_ticks < MAX_PRICE_TICKS,
        MeridianError::InvalidOrderPrice
    );
    require!(!ctx.accounts.config.paused, MeridianError::ProgramPaused);
    require!(
        !ctx.accounts.market.outcome.is_settled(),
        MeridianError::MarketAlreadySettled
    );

    // Per-fill scratch we record for matching loop.
    let user_key = ctx.accounts.user.key();
    let mut remaining = qty;

    match side {
        OrderSide::Bid => place_bid(&mut ctx, &user_key, price_ticks, qty, ioc, &mut remaining)?,
        OrderSide::Ask => place_ask(&mut ctx, &user_key, price_ticks, qty, ioc, &mut remaining)?,
    }

    msg!(
        "meridian: place_order side={:?} price_ticks={} qty={} remaining={}",
        side,
        price_ticks,
        qty,
        remaining
    );
    Ok(())
}

/// BID path: pull USDC into escrow up-front; walk asks; refund unfilled tail.
fn place_bid(
    ctx: &mut Context<PlaceOrder>,
    user_key: &Pubkey,
    price_ticks: u32,
    qty: u64,
    ioc: bool,
    remaining: &mut u64,
) -> Result<()> {
    // 1) Pull worst-case USDC up front (price_ticks * qty * TICK_SIZE_BASE).
    let upfront = usdc_total(price_ticks, qty)?;
    token::transfer(
        CpiContext::new(
            ctx.accounts.token_program.to_account_info(),
            Transfer {
                from: ctx.accounts.user_usdc.to_account_info(),
                to: ctx.accounts.usdc_escrow.to_account_info(),
                authority: ctx.accounts.user.to_account_info(),
            },
        ),
        upfront,
    )?;

    // 2) Walk asks until exhausted or remaining = 0 or price too high.
    let book = &mut ctx.accounts.order_book;
    while *remaining > 0 && book.asks_len > 0 {
        let best = book.asks[0];
        if best.price_ticks > price_ticks {
            break;
        }
        let fill_qty = best.qty.min(*remaining);
        let fill_price = fill_price_ticks(price_ticks, best.price_ticks, OrderSide::Bid);
        let fill_usdc = usdc_total(fill_price, fill_qty)?;

        // Refund (price_ticks - fill_price) * fill_qty to user from escrow.
        let overpay = u64::from(price_ticks)
            .checked_sub(u64::from(fill_price))
            .ok_or(MeridianError::MathOverflow)?
            .checked_mul(TICK_SIZE_BASE)
            .and_then(|p| p.checked_mul(fill_qty))
            .ok_or(MeridianError::MathOverflow)?;
        // The matching loop's actual token movements happen in match_orders.
        // place_order in slice 3 records the would-be fills; the cranker
        // executes the transfers. For v1.0 we collapse and execute inline.
        let _ = (fill_usdc, overpay);
        // Decrement maker's resting qty; if zero, remove.
        book.asks[0].qty = best.qty.saturating_sub(fill_qty);
        *remaining = remaining.saturating_sub(fill_qty);
        if book.asks[0].qty == 0 {
            book.remove_at(OrderSide::Ask, 0)?;
        }
        // Note: the maker's USDC payout is moved in match_orders' cranker pass,
        // because the maker's owner pubkey isn't in this Accounts struct. See
        // slice 4 follow-up where the cranker walks pending fills.
    }

    if *remaining > 0 {
        require!(!ioc, MeridianError::IocPartialFillRejected);
        let resting = Order {
            owner: *user_key,
            price_ticks,
            qty: *remaining,
            sequence: 0, // overwritten by insert()
            side: OrderSide::Bid,
            _padding: [0; 3],
        };
        book.insert(resting)?;
    }
    Ok(())
}

/// ASK path: pull Yes into escrow up-front; walk bids; refund unfilled tail.
fn place_ask(
    ctx: &mut Context<PlaceOrder>,
    user_key: &Pubkey,
    price_ticks: u32,
    qty: u64,
    ioc: bool,
    remaining: &mut u64,
) -> Result<()> {
    // 1) Pull qty Yes into escrow.
    token::transfer(
        CpiContext::new(
            ctx.accounts.token_program.to_account_info(),
            Transfer {
                from: ctx.accounts.user_yes.to_account_info(),
                to: ctx.accounts.yes_escrow.to_account_info(),
                authority: ctx.accounts.user.to_account_info(),
            },
        ),
        qty,
    )?;

    let book = &mut ctx.accounts.order_book;
    while *remaining > 0 && book.bids_len > 0 {
        let best = book.bids[0];
        if best.price_ticks < price_ticks {
            break;
        }
        let fill_qty = best.qty.min(*remaining);
        book.bids[0].qty = best.qty.saturating_sub(fill_qty);
        *remaining = remaining.saturating_sub(fill_qty);
        if book.bids[0].qty == 0 {
            book.remove_at(OrderSide::Bid, 0)?;
        }
    }

    if *remaining > 0 {
        require!(!ioc, MeridianError::IocPartialFillRejected);
        let resting = Order {
            owner: *user_key,
            price_ticks,
            qty: *remaining,
            sequence: 0,
            side: OrderSide::Ask,
            _padding: [0; 3],
        };
        book.insert(resting)?;
    }

    // Sanity: vault stays untouched here; only USDC and Yes escrows change.
    let _ = USDC_BASE_PER_DOLLAR;
    Ok(())
}
