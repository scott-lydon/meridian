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
        // Distinct error from `InvalidOrderPrice` so a corrupted side byte in a
        // zero-copy Order record is diagnosable from the on-chain log alone
        // instead of looking like a routine bad-price rejection.
        match b {
            0 => Ok(Self::Bid),
            1 => Ok(Self::Ask),
            _ => err!(MeridianError::InvalidOrderSide),
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

// ============================================================================
// Unit tests for the order-book primitives.
// ============================================================================
//
// Every test below runs without a validator. The zero-copy OrderBook is
// allocated in-test via `bytemuck::Zeroable::zeroed()` so we can exercise the
// same invariants the on-chain handler relies on (price-priority + FIFO at the
// same price, capacity, find/remove) without spinning up `solana-test-validator`.
//
// Crate-wide clippy lints (`unwrap_used = deny`, `panic = deny`, etc.) are
// allowed inside `mod tests` because `assert_eq!`/`unwrap()` are the natural
// test idioms and would otherwise force `?` plumbing throughout.
#[cfg(test)]
#[allow(
    clippy::unwrap_used,
    clippy::expect_used,
    clippy::panic,
    clippy::indexing_slicing,
    clippy::cast_possible_truncation,
    clippy::cast_lossless,
    clippy::similar_names
)]
mod tests {
    use super::*;
    use anchor_lang::prelude::Pubkey;
    use proptest::prelude::*;

    /// Allocate a zeroed OrderBook for tests. Safe because every field is
    /// `Pod`/`Zeroable`: all-zero bytes is a valid bit pattern for `Pubkey`
    /// (the all-zeros pubkey is the system program), `u64`, `u32`, `u8`, and
    /// `[Order; N]` whose `Order` fields are all integer/Pubkey.
    fn zeroed_book() -> OrderBook {
        bytemuck::Zeroable::zeroed()
    }

    fn order(owner: u8, side: OrderSide, price_ticks: u32, qty: u64) -> Order {
        Order {
            qty,
            sequence: 0, // overwritten by OrderBook::insert
            owner: Pubkey::new_from_array([owner; 32]),
            price_ticks,
            side: side.as_u8(),
            _pad: [0; 3],
        }
    }

    // ---------- OrderSide round-trip ----------

    #[test]
    fn order_side_round_trip_bid() {
        assert_eq!(OrderSide::from_u8(OrderSide::Bid.as_u8()).unwrap(), OrderSide::Bid);
    }

    #[test]
    fn order_side_round_trip_ask() {
        assert_eq!(OrderSide::from_u8(OrderSide::Ask.as_u8()).unwrap(), OrderSide::Ask);
    }

    #[test]
    fn order_side_from_u8_rejects_unknown_byte() {
        for bad in 2u8..=255 {
            let parsed = OrderSide::from_u8(bad);
            assert!(parsed.is_err(), "byte {} should be rejected", bad);
        }
    }

    proptest! {
        /// For any valid side, `from_u8(as_u8(x))` recovers `x`. This is the
        /// minimum guarantee a wire-format byte must satisfy; a regression here
        /// would corrupt every zero-copy Order on the slab.
        #[test]
        fn prop_order_side_round_trip(byte in 0u8..=1) {
            let side = OrderSide::from_u8(byte).unwrap();
            prop_assert_eq!(side.as_u8(), byte);
        }
    }

    // ---------- Order ----------

    #[test]
    fn order_size_is_exactly_56_bytes() {
        // Pinning this prevents an accidental field reorder/padding change
        // from silently shifting where data lives in the zero-copy slab.
        assert_eq!(Order::SIZE, 56);
        assert_eq!(core::mem::size_of::<Order>(), 56);
    }

    #[test]
    fn order_is_empty_when_qty_zero() {
        let mut o = order(1, OrderSide::Bid, 50, 0);
        assert!(o.is_empty());
        o.qty = 1;
        assert!(!o.is_empty());
    }

    // ---------- usdc_total math ----------

    #[test]
    fn usdc_total_typical_fill() {
        // 100 Yes at 42 ticks ($0.42) -> 100 * 42 * 10_000 = 42_000_000 micros = $42.00.
        assert_eq!(usdc_total(42, 100).unwrap(), 42_000_000);
    }

    #[test]
    fn usdc_total_zero_qty_is_zero() {
        assert_eq!(usdc_total(50, 0).unwrap(), 0);
    }

    #[test]
    fn usdc_total_one_tick_one_qty() {
        assert_eq!(usdc_total(1, 1).unwrap(), TICK_SIZE_BASE);
    }

    #[test]
    fn usdc_total_overflows_on_extreme_values() {
        // qty=u64::MAX, price_ticks=99 -> overflows checked_mul.
        let err = usdc_total(99, u64::MAX);
        assert!(err.is_err(), "u64::MAX * 99 * TICK_SIZE_BASE must overflow");
    }

    proptest! {
        /// usdc_total is linear in qty: (n+1)*price - n*price == price*TICK_SIZE_BASE.
        /// Tests both multiplicands without exhausting the u64 space.
        #[test]
        fn prop_usdc_total_linear_in_qty(price in 1u32..MAX_PRICE_TICKS, qty in 0u64..1_000_000u64) {
            let a = usdc_total(price, qty).unwrap();
            let b = usdc_total(price, qty + 1).unwrap();
            prop_assert_eq!(b - a, u64::from(price) * TICK_SIZE_BASE);
        }
    }

    // ---------- max_book_notional ----------

    #[test]
    fn max_book_notional_typical_value() {
        // 1000 pairs * $1.00 = 1000 USDC = 1_000_000_000 micros.
        assert_eq!(max_book_notional(1000), 1_000_000_000);
    }

    #[test]
    fn max_book_notional_saturates_at_extreme() {
        // u64::MAX * USDC_BASE_PER_DOLLAR fits in u128 with room to spare,
        // so saturating_mul here is just guaranteeing-no-overflow not
        // saturating.
        let n = max_book_notional(u64::MAX);
        let expected = u128::from(u64::MAX) * u128::from(crate::constants::USDC_BASE_PER_DOLLAR);
        assert_eq!(n, expected);
    }

    // ---------- OrderBook insertion sort: bids descending ----------

    #[test]
    fn insert_keeps_bids_sorted_descending() {
        let mut book = zeroed_book();
        // Insert prices in mixed order: 50, 70, 30, 90.
        book.insert(order(1, OrderSide::Bid, 50, 10)).unwrap();
        book.insert(order(2, OrderSide::Bid, 70, 10)).unwrap();
        book.insert(order(3, OrderSide::Bid, 30, 10)).unwrap();
        book.insert(order(4, OrderSide::Bid, 90, 10)).unwrap();
        assert_eq!(book.bids_len, 4);
        let prices: Vec<u32> = (0..4).map(|i| book.bids[i].price_ticks).collect();
        assert_eq!(prices, vec![90, 70, 50, 30]);
        // best_bid returns the head, which is the highest price.
        assert_eq!(book.best_bid().unwrap().price_ticks, 90);
    }

    // ---------- OrderBook insertion sort: asks ascending ----------

    #[test]
    fn insert_keeps_asks_sorted_ascending() {
        let mut book = zeroed_book();
        book.insert(order(1, OrderSide::Ask, 50, 10)).unwrap();
        book.insert(order(2, OrderSide::Ask, 70, 10)).unwrap();
        book.insert(order(3, OrderSide::Ask, 30, 10)).unwrap();
        book.insert(order(4, OrderSide::Ask, 90, 10)).unwrap();
        assert_eq!(book.asks_len, 4);
        let prices: Vec<u32> = (0..4).map(|i| book.asks[i].price_ticks).collect();
        assert_eq!(prices, vec![30, 50, 70, 90]);
        assert_eq!(book.best_ask().unwrap().price_ticks, 30);
    }

    // ---------- OrderBook FIFO at the same price ----------

    #[test]
    fn insert_preserves_fifo_at_same_price_for_bids() {
        let mut book = zeroed_book();
        // Three bids at the SAME price, distinct owners.
        book.insert(order(1, OrderSide::Bid, 50, 10)).unwrap();
        book.insert(order(2, OrderSide::Bid, 50, 10)).unwrap();
        book.insert(order(3, OrderSide::Bid, 50, 10)).unwrap();
        assert_eq!(book.bids_len, 3);
        // Owners should appear in insertion order (1, 2, 3) — sequence ASC.
        assert_eq!(book.bids[0].owner.to_bytes()[0], 1);
        assert_eq!(book.bids[1].owner.to_bytes()[0], 2);
        assert_eq!(book.bids[2].owner.to_bytes()[0], 3);
        assert_eq!(book.bids[0].sequence, 0);
        assert_eq!(book.bids[1].sequence, 1);
        assert_eq!(book.bids[2].sequence, 2);
    }

    #[test]
    fn insert_preserves_fifo_at_same_price_for_asks() {
        let mut book = zeroed_book();
        book.insert(order(1, OrderSide::Ask, 50, 10)).unwrap();
        book.insert(order(2, OrderSide::Ask, 50, 10)).unwrap();
        book.insert(order(3, OrderSide::Ask, 50, 10)).unwrap();
        assert_eq!(book.asks[0].owner.to_bytes()[0], 1);
        assert_eq!(book.asks[1].owner.to_bytes()[0], 2);
        assert_eq!(book.asks[2].owner.to_bytes()[0], 3);
    }

    #[test]
    fn insert_rejects_when_side_at_capacity() {
        let mut book = zeroed_book();
        for i in 0..MAX_DEPTH_PER_SIDE {
            // Distinct prices so each new order takes its own slot.
            book.insert(order(1, OrderSide::Bid, (i as u32) + 1, 10)).unwrap();
        }
        assert_eq!(book.bids_len as usize, MAX_DEPTH_PER_SIDE);
        let one_more = book.insert(order(2, OrderSide::Bid, 99, 10));
        assert!(one_more.is_err(), "MAX_DEPTH_PER_SIDE+1 must be rejected");
    }

    #[test]
    fn next_sequence_increments_globally_across_both_sides() {
        // Sequence is shared across bids and asks per the field doc.
        let mut book = zeroed_book();
        book.insert(order(1, OrderSide::Bid, 50, 10)).unwrap();
        book.insert(order(2, OrderSide::Ask, 60, 10)).unwrap();
        book.insert(order(3, OrderSide::Bid, 40, 10)).unwrap();
        assert_eq!(book.bids[0].sequence, 0); // bid at 50 (only bid for now wait, two)
        // After 3 inserts, sequences used are 0, 1, 2. The Bid at 50 was first
        // (seq 0); the Ask at 60 was second (seq 1); the Bid at 40 was third
        // (seq 2). Bids array order is descending price, so [50, 40].
        assert_eq!(book.bids[0].price_ticks, 50);
        assert_eq!(book.bids[0].sequence, 0);
        assert_eq!(book.bids[1].price_ticks, 40);
        assert_eq!(book.bids[1].sequence, 2);
        assert_eq!(book.asks[0].price_ticks, 60);
        assert_eq!(book.asks[0].sequence, 1);
        assert_eq!(book.next_sequence, 3);
    }

    // ---------- find ----------

    #[test]
    fn find_locates_order_by_owner_and_sequence() {
        let mut book = zeroed_book();
        book.insert(order(1, OrderSide::Bid, 50, 10)).unwrap();
        book.insert(order(2, OrderSide::Bid, 70, 10)).unwrap();
        let owner1 = Pubkey::new_from_array([1; 32]);
        let idx = book.find(OrderSide::Bid, &owner1, 0);
        assert_eq!(idx, Some(1), "owner=1 was inserted first (seq 0) and lives below the higher price");
    }

    #[test]
    fn find_returns_none_when_owner_and_sequence_dont_match() {
        let mut book = zeroed_book();
        book.insert(order(1, OrderSide::Bid, 50, 10)).unwrap();
        let owner1 = Pubkey::new_from_array([1; 32]);
        assert_eq!(book.find(OrderSide::Bid, &owner1, 99), None);
        let owner_wrong = Pubkey::new_from_array([99; 32]);
        assert_eq!(book.find(OrderSide::Bid, &owner_wrong, 0), None);
    }

    // ---------- remove_at ----------

    #[test]
    fn remove_at_returns_the_removed_order_and_shifts_remainder() {
        let mut book = zeroed_book();
        book.insert(order(1, OrderSide::Bid, 90, 10)).unwrap();
        book.insert(order(2, OrderSide::Bid, 70, 10)).unwrap();
        book.insert(order(3, OrderSide::Bid, 50, 10)).unwrap();
        let removed = book.remove_at(OrderSide::Bid, 1).unwrap();
        assert_eq!(removed.price_ticks, 70);
        assert_eq!(book.bids_len, 2);
        assert_eq!(book.bids[0].price_ticks, 90);
        assert_eq!(book.bids[1].price_ticks, 50);
        // The tail slot is zeroed so a stale Order can't be matched.
        assert_eq!(book.bids[2].qty, 0);
        assert_eq!(book.bids[2].owner, Pubkey::default());
    }

    #[test]
    fn remove_at_rejects_out_of_bounds_index() {
        let mut book = zeroed_book();
        book.insert(order(1, OrderSide::Bid, 90, 10)).unwrap();
        let err = book.remove_at(OrderSide::Bid, 5);
        assert!(err.is_err(), "removing past bids_len must error");
    }

    proptest! {
        /// After inserting N distinct prices into the bid side, the slab is
        /// strictly descending. Catches a regression where the insertion-sort
        /// shift loop misorders adjacent slots.
        #[test]
        fn prop_bids_strictly_descending_after_random_inserts(
            prices in proptest::collection::vec(1u32..MAX_PRICE_TICKS, 1..16)
        ) {
            let mut book = zeroed_book();
            // Deduplicate so we exercise strict (not <=) descending.
            let mut uniq: Vec<u32> = prices;
            uniq.sort_unstable();
            uniq.dedup();
            for &p in &uniq {
                book.insert(order(1, OrderSide::Bid, p, 10)).unwrap();
            }
            for i in 1..book.bids_len as usize {
                prop_assert!(
                    book.bids[i - 1].price_ticks > book.bids[i].price_ticks,
                    "bids[{}].price ({}) must be > bids[{}].price ({})",
                    i - 1, book.bids[i - 1].price_ticks, i, book.bids[i].price_ticks
                );
            }
        }

        /// After inserting N distinct prices into the ask side, the slab is
        /// strictly ascending.
        #[test]
        fn prop_asks_strictly_ascending_after_random_inserts(
            prices in proptest::collection::vec(1u32..MAX_PRICE_TICKS, 1..16)
        ) {
            let mut book = zeroed_book();
            let mut uniq: Vec<u32> = prices;
            uniq.sort_unstable();
            uniq.dedup();
            for &p in &uniq {
                book.insert(order(1, OrderSide::Ask, p, 10)).unwrap();
            }
            for i in 1..book.asks_len as usize {
                prop_assert!(
                    book.asks[i - 1].price_ticks < book.asks[i].price_ticks,
                    "asks[{}].price ({}) must be < asks[{}].price ({})",
                    i - 1, book.asks[i - 1].price_ticks, i, book.asks[i].price_ticks
                );
            }
        }

        /// Inserting then finding the inserted order by (owner, sequence) is a
        /// total function: the find must succeed for every insertion.
        #[test]
        fn prop_insert_then_find_round_trips(
            owners in proptest::collection::vec(1u8..=64, 1..16),
            base_price in 1u32..50u32
        ) {
            let mut book = zeroed_book();
            for (i, owner_byte) in owners.iter().enumerate() {
                let price = base_price + i as u32; // distinct price per slot
                book.insert(order(*owner_byte, OrderSide::Bid, price, 10)).unwrap();
            }
            for (seq, owner_byte) in owners.iter().enumerate() {
                let owner = Pubkey::new_from_array([*owner_byte; 32]);
                prop_assert!(
                    book.find(OrderSide::Bid, &owner, seq as u64).is_some(),
                    "owner byte {} sequence {} should be findable",
                    owner_byte, seq
                );
            }
        }
    }
}
