//! place_order — escrow tokens, insert a resting limit order into the book.
//! OrderBook is zero-copy; loaded via AccountLoader.

use anchor_lang::prelude::*;
use anchor_spl::token::{self, Mint, Token, TokenAccount, Transfer};

use crate::constants::{CONFIG_SEED, PROGRAM_VERSION};
use crate::error::MeridianError;
use crate::order_book::{usdc_total, MAX_PRICE_TICKS, Order, OrderBook, OrderSide};
use crate::state::{Config, Market};

use super::init_order_book::ORDER_BOOK_SEED;

#[derive(Accounts)]
pub struct PlaceOrder<'info> {
    #[account(
        seeds = [CONFIG_SEED, &[PROGRAM_VERSION]],
        bump = config.bump,
    )]
    pub config: Box<Account<'info, Config>>,

    pub market: Box<Account<'info, Market>>,

    #[account(
        mut,
        seeds = [ORDER_BOOK_SEED, market.key().as_ref(), &[PROGRAM_VERSION]],
        bump,
    )]
    pub order_book: AccountLoader<'info, OrderBook>,

    #[account(mut)]
    pub usdc_escrow: Box<Account<'info, TokenAccount>>,

    #[account(mut)]
    pub yes_escrow: Box<Account<'info, TokenAccount>>,

    /// USDC source (Bid path).
    #[account(
        mut,
        token::mint = config.usdc_mint,
        token::authority = user,
    )]
    pub user_usdc: Box<Account<'info, TokenAccount>>,

    /// Yes source (Ask path).
    #[account(
        mut,
        token::mint = market.yes_mint,
        token::authority = user,
    )]
    pub user_yes: Box<Account<'info, TokenAccount>>,

    #[account(address = market.yes_mint @ MeridianError::WrongTokenMint)]
    pub yes_mint: Box<Account<'info, Mint>>,

    #[account(mut)]
    pub user: Signer<'info>,

    pub token_program: Program<'info, Token>,
}

pub fn handler(
    ctx: Context<PlaceOrder>,
    side: OrderSide,
    price_ticks: u32,
    qty: u64,
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

    // Verify escrow accounts match the book's recorded ones.
    {
        let book = ctx.accounts.order_book.load()?;
        require_keys_eq!(
            book.usdc_escrow,
            ctx.accounts.usdc_escrow.key(),
            MeridianError::WrongVaultAccount
        );
        require_keys_eq!(
            book.yes_escrow,
            ctx.accounts.yes_escrow.key(),
            MeridianError::WrongVaultAccount
        );
    }

    // Pull escrow from user. Bid = USDC; Ask = Yes tokens.
    match side {
        OrderSide::Bid => {
            let usdc_in = usdc_total(price_ticks, qty)?;
            require!(
                ctx.accounts.user_usdc.amount >= usdc_in,
                MeridianError::InsufficientBalance
            );
            token::transfer(
                CpiContext::new(
                    ctx.accounts.token_program.to_account_info(),
                    Transfer {
                        from: ctx.accounts.user_usdc.to_account_info(),
                        to: ctx.accounts.usdc_escrow.to_account_info(),
                        authority: ctx.accounts.user.to_account_info(),
                    },
                ),
                usdc_in,
            )?;
        }
        OrderSide::Ask => {
            require!(
                ctx.accounts.user_yes.amount >= qty,
                MeridianError::InsufficientBalance
            );
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
        }
    }

    let user_key = ctx.accounts.user.key();
    let mut book = ctx.accounts.order_book.load_mut()?;
    let order = Order {
        qty,
        sequence: 0, // overwritten by insert()
        owner: user_key,
        price_ticks,
        side: side.as_u8(),
        _pad: [0; 3],
    };
    book.insert(order)?;

    msg!(
        "meridian: place_order side={:?} price_ticks={} qty={}",
        side,
        price_ticks,
        qty
    );
    Ok(())
}
