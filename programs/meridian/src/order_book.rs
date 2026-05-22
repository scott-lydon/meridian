//! In-program order book (slab-based CLOB) — zero-copy layout.
//!
//! `OrderBook` is ~7.3KB at the current capacity of 64 per side. At plan.md's
//! original spec of 256 per side it was ~28KB and would overflow the 4KB BPF
//! stack on borsh deserialize, so we use Anchor's `#[account(zero_copy(unsafe))]`
//! and read the account directly from raw bytes (no copy, no stack churn).
//! That requires Pod-compatible fields: every field repr(C), no padding,
//! no Rust enums (we use a `side` u8 instead).
//!
//! Capacity 64 per side (down from plan.md D3's 256 to fit Solana's 10240-byte
//! CPI-create-account realloc ceiling). Bids sorted descending by price, asks
//! ascending, FIFO at same price.

use anchor_lang::prelude::*;

use crate::constants::USDC_BASE_PER_DOLLAR;
use crate::error::MeridianError;

/// Capacity per side. 64 keeps the OrderBook account under Solana's 10KB
/// CPI-create-account size limit (28KB at 256 hit "realloc limited to 10240").
/// Plan.md D3 makes this raisable in v1.1 via a separate, larger account.
pub const MAX_DEPTH_PER_SIDE: usize = 64;
/// $0.01 in USDC-base units.
pub const TICK_SIZE_BASE: u64 = 10_000;
/// Live trading prices: 1..=99 ticks. 0 and 100 reserved.
pub const MAX_PRICE_TICKS: u32 = 100;

/// Wire-format side. Stored as u8 in Order so OrderBook is Pod-compatible.
#[derive(AnchorSerialize, AnchorDeserialize, Clone, Copy, PartialEq, Eq, Debug)]
#[repr(u8)]
pub enum OrderSide {
    Bid = 0,
    Ask = 1,
}

impl OrderSide {
    pub const fn as_u8(self) -> u8 {
        self as u8
    }

    pub fn from_u8(b: u8) -> Result<Self> {
        match b {
            0 => Ok(Self::Bid),
            1 => Ok(Self::Ask),
            _ => err!(MeridianError::InvalidOrderPrice),
        }
    }
}

/// Pod-compatible: every field repr(C)-laid-out with no implicit padding.
/// Layout: 8 + 8 + 32 + 4 + 1 + 3 = 56 bytes, naturally aligned.
///
/// `AnchorSerialize`/`Deserialize` for the IDL; `Pod`/`Zeroable` for the
/// zero-copy OrderBook account.
#[repr(C)]
#[derive(
    AnchorSerialize,
    AnchorDeserialize,
    Clone,
    Copy,
    Pod,
    Zeroable,
    PartialEq,
    Eq,
    Debug,
    Default,
    InitSpace,
)]
pub struct Order {
    pub qty: u64,          // 8 — remaining Yes tokens
    pub sequence: u64,     // 8 — FIFO at same price
    pub owner: Pubkey,     // 32
    pub price_ticks: u32,  // 4
    pub side: u8,          // 1 — OrderSide
    pub _pad: [u8; 3],     // 3
}

impl Order {
    pub const SIZE: usize = 56;

    pub fn is_empty(&self) -> bool {
        self.qty == 0
    }
}

/// Zero-copy OrderBook. Loaded via `AccountLoader<'info, OrderBook>`,
/// accessed via `.load()?` (read) or `.load_mut()?` (write).
#[account(zero_copy(unsafe))]
#[repr(C)]
pub struct OrderBook {
    pub market: Pubkey,                            // 32
    pub usdc_escrow: Pubkey,                       // 32
    pub yes_escrow: Pubkey,                        // 32
    pub next_sequence: u64,                        // 8
    pub bids_len: u32,                             // 4 — u32 for alignment (not u16)
    pub asks_len: u32,                             // 4
    pub bump: u8,                                  // 1
    pub version: u8,                               // 1
    pub _pad0: [u8; 6],                            // 6 — align bids[] to 8
    pub bids: [Order; MAX_DEPTH_PER_SIDE],         // 64 * 56 = 3_584
    pub asks: [Order; MAX_DEPTH_PER_SIDE],         // 64 * 56 = 3_584
}

impl OrderBook {
    pub fn best_bid(&self) -> Option<&Order> {
        if self.bids_len == 0 { None } else { self.bids.first() }
    }

    pub fn best_ask(&self) -> Option<&Order> {
        if self.asks_len == 0 { None } else { self.asks.first() }
    }

    /// Insert a resting order into the correct side. Keeps the slab sorted:
    /// bids descending by price, asks ascending. FIFO (earlier sequence wins)
    /// at the same price level.
    pub fn insert(&mut self, mut order: Order) -> Result<()> {
        order.sequence = self.next_sequence;
        self.next_sequence = self.next_sequence
            .checked_add(1)
            .ok_or(MeridianError::MathOverflow)?;

        let side = OrderSide::from_u8(order.side)?;
        match side {
            OrderSide::Bid => Self::insert_slab(
                &mut self.bids,
                &mut self.bids_len,
                order,
                true,
            ),
            OrderSide::Ask => Self::insert_slab(
                &mut self.asks,
                &mut self.asks_len,
                order,
                false,
            ),
        }
    }

    fn insert_slab(
        slab: &mut [Order; MAX_DEPTH_PER_SIDE],
        len: &mut u32,
        order: Order,
        descending: bool,
    ) -> Result<()> {
        let cur_len = *len as usize;
        if cur_len >= MAX_DEPTH_PER_SIDE {
            return err!(MeridianError::OrderBookFull);
        }
        let mut idx = cur_len;
        for i in 0..cur_len {
            let entry = &slab[i];
            let better = if descending {
                order.price_ticks > entry.price_ticks
            } else {
                order.price_ticks < entry.price_ticks
            };
            if better {
                idx = i;
                break;
            }
        }
        let mut j = cur_len;
        while j > idx {
            slab[j] = slab[j - 1];
            j -= 1;
        }
        slab[idx] = order;
        *len = (cur_len as u32)
            .checked_add(1)
            .ok_or(MeridianError::MathOverflow)?;
        Ok(())
    }

    /// Find an order by (owner, sequence) on a side. O(n).
    pub fn find(&self, side: OrderSide, owner: &Pubkey, sequence: u64) -> Option<usize> {
        let (slab, len): (&[Order; MAX_DEPTH_PER_SIDE], u32) = match side {
            OrderSide::Bid => (&self.bids, self.bids_len),
            OrderSide::Ask => (&self.asks, self.asks_len),
        };
        for i in 0..(len as usize) {
            if slab[i].owner == *owner && slab[i].sequence == sequence {
                return Some(i);
            }
        }
        None
    }

    /// Remove and return the order at index. Shifts the rest left.
    pub fn remove_at(&mut self, side: OrderSide, idx: usize) -> Result<Order> {
        let (slab, len) = match side {
            OrderSide::Bid => (&mut self.bids, &mut self.bids_len),
            OrderSide::Ask => (&mut self.asks, &mut self.asks_len),
        };
        let cur_len = *len as usize;
        require!(idx < cur_len, MeridianError::OrderNotFound);
        let removed = slab[idx];
        for i in idx..cur_len - 1 {
            slab[i] = slab[i + 1];
        }
        slab[cur_len - 1] = Order::default();
        *len = (cur_len as u32) - 1;
        Ok(removed)
    }
}

/// USDC base units required to fully fill `qty` at `price_ticks`.
pub fn usdc_total(price_ticks: u32, qty: u64) -> Result<u64> {
    u64::from(price_ticks)
        .checked_mul(TICK_SIZE_BASE)
        .and_then(|p| p.checked_mul(qty))
        .ok_or_else(|| MeridianError::MathOverflow.into())
}

/// Used in match_orders to assert vault accounting.
pub const fn max_book_notional(total_pairs: u64) -> u128 {
    (total_pairs as u128).saturating_mul(USDC_BASE_PER_DOLLAR as u128)
}

// Bytemuck Pod/Zeroable: derive via the bytemuck crate. Anchor's zero_copy
// macro reexports these; if they aren't found, add `bytemuck = "1"` to deps.
use bytemuck::{Pod, Zeroable};
