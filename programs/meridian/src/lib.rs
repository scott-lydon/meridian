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
//! Slice 1: initialize_config, create_strike_market, mint_pair,
//! settle_market_manual (admin-only stub), redeem. Slice 2 adds Pyth-based
//! settle_market and the time-delayed admin_settle override.

#![cfg_attr(feature = "no-entrypoint", allow(unused_imports))]
#![warn(clippy::pedantic, clippy::nursery)]
#![allow(clippy::missing_errors_doc, clippy::module_name_repetitions)]
// Anchor's macros expand into code that triggers a few stylistic clippy lints
// we cannot fix without forking the macros. Tolerate them here.
#![allow(clippy::needless_pass_by_value, clippy::result_large_err)]

use anchor_lang::prelude::*;

pub mod constants;
pub mod error;
pub mod instructions;
pub mod order_book;
pub mod state;

use crate::constants::TICKER_LEN;
use crate::instructions::*;
use crate::order_book::OrderSide;

declare_id!("ERtAbZetHFVmFKyTzfJd9LdMGsqu5b2TWeWc65sikPaX");

#[program]
pub mod meridian {
    use super::*;

    /// One-time program setup. Admin signs, records USDC mint + thresholds.
    /// Pyth feeds attach via the per-market `pyth_feed_id` param in slice 1
    /// and via a dedicated registry in slice 2.
    pub fn initialize_config(ctx: Context<InitializeConfig>) -> Result<()> {
        instructions::initialize_config::handler(ctx)
    }

    /// Admin creates one market: one (trading-day, ticker, strike) tuple.
    /// Initializes Yes/No mints, vault, and Market PDA. `pyth_feed_id`
    /// is stored on the market so settle_market (slice 2) can verify on chain.
    pub fn create_strike_market(
        ctx: Context<CreateStrikeMarket>,
        trading_day_unix: i64,
        ticker: [u8; TICKER_LEN],
        strike_usd_micros: u64,
        expiry_unix: i64,
        pyth_feed_id: [u8; 32],
    ) -> Result<()> {
        instructions::create_strike_market::handler(
            ctx,
            trading_day_unix,
            ticker,
            strike_usd_micros,
            expiry_unix,
            pyth_feed_id,
        )
    }

    /// Anyone deposits N USDC and receives N Yes + N No tokens.
    pub fn mint_pair(ctx: Context<MintPair>, qty: u64) -> Result<()> {
        instructions::mint_pair::handler(ctx, qty)
    }

    /// Admin-only stub settlement used by tests and dev workflows.
    /// Real Pyth-driven `settle_market` lands in slice 2.
    pub fn settle_market_manual(
        ctx: Context<SettleMarketManual>,
        closing_price_micros: u64,
    ) -> Result<()> {
        instructions::settle_market_manual::handler(ctx, closing_price_micros)
    }

    /// Burn winning tokens for $1.00 each. Losing tokens redeem for $0.00
    /// (the burn still succeeds; rent on the ATA returns to the user).
    pub fn redeem(ctx: Context<Redeem>, side: RedeemSide, qty: u64) -> Result<()> {
        instructions::redeem::handler(ctx, side, qty)
    }

    // ===== Slice 3: in-program order book =====

    /// Admin creates the order-book PDA + escrow ATAs for a market.
    pub fn init_order_book(ctx: Context<InitOrderBook>) -> Result<()> {
        instructions::init_order_book::handler(ctx)
    }

    /// Post a limit order. Escrows the user's tokens and inserts a resting
    /// order. Matching happens in a separate `match_orders` cranker.
    pub fn place_order(
        ctx: Context<PlaceOrder>,
        side: OrderSide,
        price_ticks: u32,
        qty: u64,
    ) -> Result<()> {
        instructions::place_order::handler(ctx, side, price_ticks, qty)
    }

    /// Owner cancels an unfilled order, gets remaining escrow back.
    pub fn cancel_order(
        ctx: Context<CancelOrder>,
        side: OrderSide,
        sequence: u64,
    ) -> Result<()> {
        instructions::cancel_order::handler(ctx, side, sequence)
    }

    // ===== Slice 5: admin guardrails =====

    /// Admin override settle. Enforces market.admin_override_earliest
    /// (created_at + config.admin_override_delay_secs) on-chain.
    pub fn admin_settle(ctx: Context<AdminSettle>, closing_price_micros: u64) -> Result<()> {
        instructions::admin_settle::handler(ctx, closing_price_micros)
    }

    /// Pause all minting and order placement (redeem keeps working).
    pub fn pause(ctx: Context<Pause>) -> Result<()> {
        instructions::pause::pause_handler(ctx)
    }

    /// Resume normal operation.
    pub fn unpause(ctx: Context<Pause>) -> Result<()> {
        instructions::pause::unpause_handler(ctx)
    }

    // ===== Slice 3.5: cranker =====

    /// Crosses the best bid against the best ask. Anyone can call.
    /// No-op when the book is one-sided or the spreads don't cross.
    pub fn match_orders(ctx: Context<MatchOrders>) -> Result<()> {
        instructions::match_orders::handler(ctx)
    }

    // ===== Slice 4: atomic Buy No / Sell No =====

    /// Atomic mint-pair + IOC-sell-Yes against the best bid.
    /// User signs once, ends up with `qty` No tokens, paying
    /// `qty * (1.00 - bid_price)` USDC net. Reverts if best bid is
    /// missing or below `min_bid_price_ticks` (slippage protection).
    pub fn buy_no(
        ctx: Context<BuyNo>,
        qty: u64,
        min_bid_price_ticks: u32,
    ) -> Result<()> {
        instructions::buy_no::handler(ctx, qty, min_bid_price_ticks)
    }

    /// Atomic IOC-buy-Yes + redeem-pair against the best ask.
    /// User signs once, receives `qty * (1.00 - ask_price)` USDC.
    /// Reverts if best ask is missing or above `max_ask_price_ticks`.
    pub fn sell_no(
        ctx: Context<SellNo>,
        qty: u64,
        max_ask_price_ticks: u32,
    ) -> Result<()> {
        instructions::sell_no::handler(ctx, qty, max_ask_price_ticks)
    }

    // ===== Slice 2: Pyth on-chain settlement =====

    /// Permissionless settle: reads Pyth PriceUpdateV2 on-chain, validates
    /// staleness + confidence, writes Outcome immutably.
    pub fn settle_market(ctx: Context<SettleMarket>) -> Result<()> {
        instructions::settle_market::handler(ctx)
    }
}
