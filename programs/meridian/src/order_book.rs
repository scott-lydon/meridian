//! In-program order book (slab-based CLOB).
//!
//! Design: two fixed-capacity slabs, bids sorted descending by price and
//! asks sorted ascending by price. Each entry carries the owner pubkey,
//! the resting quantity (in Yes-token base units), and a monotonic sequence
//! number for FIFO at-price priority.
//!
//! Per plan.md §2.2 + trade-off panel 5.1, the matching engine is
//! property-tested for conservation (USDC + Yes) across random sequences.
//! Capacity 256 per side per plan.md D3.
//!
//! Escrow: each OrderBook owns a `usdc_escrow` ATA (buyer-committed USDC)
//! and a `yes_escrow` ATA (seller-committed Yes). place_order transfers
//! into escrow; match_orders transfers from escrow to taker; cancel_order
//! refunds the unfilled remainder.

use anchor_lang::prelude::*;

use crate::constants::USDC_BASE_PER_DOLLAR;
use crate::error::MeridianError;

/// Capacity per side. Mirrored from `Config.order_book_max_depth` once that
/// field is wired in v1.1; constant for v1.
pub const MAX_DEPTH_PER_SIDE: usize = 256;

/// $0.01 in USDC-base units = 10_000.
pub const TICK_SIZE_BASE: u64 = 10_000;

/// 100 ticks span $0.00 to $1.00 inclusive at $0.01 granularity.
pub const MAX_PRICE_TICKS: u32 = 100;

#[derive(AnchorSerialize, AnchorDeserialize, Clone, Copy, InitSpace, PartialEq, Eq, Debug)]
pub enum OrderSide {
    /// Buy Yes (taker pays USDC; maker is selling Yes).
    Bid,
    /// Sell Yes (taker receives USDC; maker is buying Yes).
    Ask,
}

#[derive(AnchorSerialize, AnchorDeserialize, Clone, Copy, InitSpace, PartialEq, Eq, Debug)]
pub struct Order {
    pub owner: Pubkey,        // 32
    pub price_ticks: u32,     // 4 — 1..=99 for live trading; 0 and 100 reserved
    pub qty: u64,             // 8 — remaining Yes tokens
    pub sequence: u64,        // 8 — FIFO at same price
    pub side: OrderSide,      // 1
    pub _padding: [u8; 3],    // 3 — keep struct aligned for slab walks
}

impl Order {
    pub const SIZE: usize = 32 + 4 + 8 + 8 + 1 + 3; // 56

    pub const fn empty() -> Self {
        Self {
            owner: Pubkey::new_from_array([0; 32]),
            price_ticks: 0,
            qty: 0,
            sequence: 0,
            side: OrderSide::Bid,
            _padding: [0; 3],
        }
    }

    pub fn is_empty(&self) -> bool {
        self.qty == 0
    }

    /// USDC base-units required to fill this resting Bid at the given qty.
    /// price_ticks=65 (= $0.65) and qty=10 -> 65 * TICK_SIZE_BASE * 10.
    pub fn usdc_for(&self, fill_qty: u64) -> Result<u64> {
        u64::from(self.price_ticks)
            .checked_mul(TICK_SIZE_BASE)
            .and_then(|p| p.checked_mul(fill_qty))
            .ok_or_else(|| MeridianError::MathOverflow.into())
    }
}

/// One OrderBook account per Market. Owned by the Meridian program.
/// Vault authority for usdc_escrow and yes_escrow is the OrderBook PDA.
#[account]
#[derive(InitSpace)]
pub struct OrderBook {
    pub market: Pubkey,                            // 32
    pub next_sequence: u64,                        // 8
    pub bids_len: u16,                             // 2 — number of populated bids
    pub asks_len: u16,                             // 2 — number of populated asks
    pub bids: [Order; MAX_DEPTH_PER_SIDE],         // 256 * 56 = 14_336
    pub asks: [Order; MAX_DEPTH_PER_SIDE],         // 14_336
    pub usdc_escrow: Pubkey,                       // 32
    pub yes_escrow: Pubkey,                        // 32
    pub bump: u8,                                  // 1
    pub version: u8,                               // 1
}

impl OrderBook {
    /// Best ask is at asks[0] (lowest price). Best bid is at bids[0] (highest).
    /// Returns `None` if the side is empty.
    pub fn best_bid(&self) -> Option<&Order> {
        if self.bids_len == 0 {
            None
        } else {
            self.bids.first()
        }
    }

    pub fn best_ask(&self) -> Option<&Order> {
        if self.asks_len == 0 {
            None
        } else {
            self.asks.first()
        }
    }

    /// Insert a new resting order into the correct slab. Maintains the sort
    /// invariant (bids descending, asks ascending) with FIFO at same price.
    /// Returns `Err(OrderBookFull)` if capacity reached.
    pub fn insert(&mut self, mut order: Order) -> Result<()> {
        order.sequence = self.next_sequence;
        self.next_sequence = self.next_sequence.checked_add(1).ok_or(MeridianError::MathOverflow)?;

        match order.side {
            OrderSide::Bid => Self::insert_into(
                &mut self.bids,
                &mut self.bids_len,
                order,
                /* descending = */ true,
            ),
            OrderSide::Ask => Self::insert_into(
                &mut self.asks,
                &mut self.asks_len,
                order,
                /* descending = */ false,
            ),
        }
    }

    fn insert_into(
        slab: &mut [Order; MAX_DEPTH_PER_SIDE],
        len: &mut u16,
        order: Order,
        descending: bool,
    ) -> Result<()> {
        let cur_len = usize::from(*len);
        if cur_len >= MAX_DEPTH_PER_SIDE {
            return err!(MeridianError::OrderBookFull);
        }
        // Find insertion index that keeps the slab sorted.
        let mut idx = cur_len;
        for i in 0..cur_len {
            let entry = &slab[i];
            let better_price = if descending {
                order.price_ticks > entry.price_ticks
            } else {
                order.price_ticks < entry.price_ticks
            };
            // Tie-break: earlier sequence stays before later (FIFO at price).
            if better_price {
                idx = i;
                break;
            }
        }
        // Shift right from idx to cur_len.
        let mut j = cur_len;
        while j > idx {
            slab[j] = slab[j - 1];
            j -= 1;
        }
        slab[idx] = order;
        *len = u16::try_from(cur_len + 1).map_err(|_| MeridianError::MathOverflow)?;
        Ok(())
    }

    /// Remove the order at slab[idx] by shifting the rest left. Returns the
    /// removed Order (or an error if idx is out of range).
    pub fn remove_at(&mut self, side: OrderSide, idx: usize) -> Result<Order> {
        let (slab, len) = match side {
            OrderSide::Bid => (&mut self.bids, &mut self.bids_len),
            OrderSide::Ask => (&mut self.asks, &mut self.asks_len),
        };
        let cur_len = usize::from(*len);
        require!(idx < cur_len, MeridianError::OrderNotFound);
        let removed = slab[idx];
        for i in idx..cur_len - 1 {
            slab[i] = slab[i + 1];
        }
        slab[cur_len - 1] = Order::empty();
        *len = u16::try_from(cur_len - 1).map_err(|_| MeridianError::MathOverflow)?;
        Ok(removed)
    }

    /// Find an order by (owner, sequence) on the given side.
    pub fn find(&self, side: OrderSide, owner: &Pubkey, sequence: u64) -> Option<usize> {
        let (slab, len) = match side {
            OrderSide::Bid => (&self.bids, self.bids_len),
            OrderSide::Ask => (&self.asks, self.asks_len),
        };
        for i in 0..usize::from(len) {
            if slab[i].owner == *owner && slab[i].sequence == sequence {
                return Some(i);
            }
        }
        None
    }
}

/// USDC base units required to fully fill `qty` at `price_ticks`.
/// price_ticks 55 = $0.55. qty 10 Yes tokens => 55 * 10_000 * 10 = 5_500_000 = $5.50.
pub fn usdc_total(price_ticks: u32, qty: u64) -> Result<u64> {
    u64::from(price_ticks)
        .checked_mul(TICK_SIZE_BASE)
        .and_then(|p| p.checked_mul(qty))
        .ok_or_else(|| MeridianError::MathOverflow.into())
}

/// For a resting Ask filled by an incoming Bid: the buyer's USDC commitment
/// at price `incoming_price_ticks` might exceed `resting_ask.price_ticks`.
/// We always fill at the resting (maker's) price for price improvement.
pub fn fill_price_ticks(taker_price: u32, maker_price: u32, side: OrderSide) -> u32 {
    let _ = side; // unused; both sides fill at maker price.
    let _ = taker_price;
    maker_price
}

/// Round a USDC-base-units price to ticks. $0.55 = 550_000 base -> 55 ticks.
pub fn price_ticks_from_base(usdc_base: u64) -> Result<u32> {
    let ticks = usdc_base / TICK_SIZE_BASE;
    u32::try_from(ticks).map_err(|_| MeridianError::InvalidQuantity.into())
}

/// Sanity: `qty * price_ticks * TICK_SIZE_BASE` never exceeds `total_pairs *
/// USDC_BASE_PER_DOLLAR` for a single market. Used in match_orders to assert
/// the conservation invariant after a fill.
pub const fn max_book_notional(total_pairs: u64) -> u128 {
    total_pairs as u128 * USDC_BASE_PER_DOLLAR as u128
}
