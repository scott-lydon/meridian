//! Instruction handlers.
//!
//! Each instruction lives in its own file under `instructions/` and is
//! re-exported here. `lib.rs` calls these handlers from the `#[program]`
//! module; the `Accounts` structs are re-exported so Anchor's codegen
//! finds them.

pub mod create_strike_market;
pub mod initialize_config;
pub mod mint_pair;
pub mod redeem;
pub mod settle_market_manual;

pub use create_strike_market::*;
pub use initialize_config::*;
pub use mint_pair::*;
pub use redeem::*;
pub use settle_market_manual::*;
