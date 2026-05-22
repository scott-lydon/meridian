//! Typed program errors.
//!
//! Per constitution §2.4 (no catch-log-continue) and §3 (Rust style: "Vague
//! errors are bugs"), each variant carries enough context to diagnose the
//! failure from the on-chain log alone. Where a threshold or count is what
//! got tripped, include the actual + the expected.

use anchor_lang::prelude::*;

#[error_code]
pub enum MeridianError {
    // === Authorization and lifecycle ===
    #[msg("Caller is not the program admin")]
    Unauthorized,

    #[msg("Config has already been initialized; call again denied")]
    ConfigAlreadyInitialized,

    #[msg("Mint/trade attempted while the program is paused")]
    ProgramPaused,

    // === Market state ===
    #[msg("Market has not been settled yet; redeem disabled until settle_market lands")]
    MarketNotSettled,

    #[msg("Market is already settled; outcome is immutable")]
    MarketAlreadySettled,

    #[msg("settle_market called before market close (16:00 ET)")]
    SettleTooEarly,

    #[msg("admin_settle called before the override delay elapsed")]
    AdminOverrideTooEarly,

    // === Oracle ===
    #[msg("Pyth price is older than max_staleness_secs")]
    OraclePriceStale,

    #[msg("Pyth confidence band wider than max_confidence_bps")]
    OracleConfidenceTooWide,

    #[msg("Pyth account passed does not match the feed configured for this ticker")]
    OracleFeedMismatch,

    #[msg("Pyth update missing or malformed")]
    OracleUpdateMissing,

    // === Quantity / arithmetic ===
    #[msg("Quantity must be positive")]
    InvalidQuantity,

    #[msg("Integer overflow in vault accounting")]
    MathOverflow,

    #[msg("Caller balance is insufficient for the requested action")]
    InsufficientBalance,

    // === Vault invariant ===
    #[msg("Vault balance no longer equals total_pairs_outstanding x 1.00 USDC")]
    VaultInvariantViolated,

    // === Config inputs ===
    #[msg("Ticker not present in Config.pyth_feeds")]
    UnknownTicker,

    #[msg("Strike price must be a positive integer in micro-USD")]
    InvalidStrike,

    #[msg("Trading-day timestamp does not align with a UTC midnight")]
    InvalidTradingDay,

    #[msg("Order-book capacity must fit within program limits")]
    InvalidOrderBookCapacity,

    // === Token operations ===
    #[msg("Provided token mint does not match the expected Yes or No mint for this market")]
    WrongTokenMint,

    #[msg("Provided vault account does not match the market's vault PDA")]
    WrongVaultAccount,

    // === Order book (slice 3) ===
    #[msg("Order book side is at capacity")]
    OrderBookFull,

    #[msg("Order not found (owner + sequence did not match)")]
    OrderNotFound,

    #[msg("IOC order could not be fully filled at the requested price")]
    IocPartialFillRejected,

    #[msg("Order price must be between 1 and 99 ticks ($0.01 to $0.99)")]
    InvalidOrderPrice,

    #[msg("Order side byte is neither 0 (Bid) nor 1 (Ask) — corrupted Order record")]
    InvalidOrderSide,

    #[msg("Pyth publish_time is in the future relative to on-chain clock — likely cranker clock skew")]
    OraclePriceFromFuture,
}
