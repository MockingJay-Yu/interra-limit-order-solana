// Cross-chain Limit Order Anchor Contract (Solana version)
use anchor_lang::prelude::*;
use anchor_lang::system_program;
use anchor_spl::associated_token::get_associated_token_address;
use anchor_spl::token::{self, Mint, Token, TokenAccount, Transfer as TokenTransfer};
use std::str::FromStr;

// Declare the program ID
declare_id!("DV7Ni48rt8frfLkpfLHkTuN4i8Zijj7ojM5XaZwetHW6");

#[program]
pub mod limit_order {
    use super::*;

    pub fn initialize(ctx: Context<Initialize>, platform_fee: u16, treasury: Pubkey) -> Result<()> {
        require!(platform_fee < 10000, CustomError::InvalidPlatformFee);

        let config = &mut ctx.accounts.global_config;
        config.owner = ctx.accounts.signer.key();
        config.platform_fee = platform_fee;
        config.treasury = treasury;
        config.paused = false;
        config.reserved = [0; 128]; // Initialize reserved space to zero
        emit!(Initialized {
            owner: config.owner,
            platform_fee: config.platform_fee,
            treasury: config.treasury,
            paused: config.paused,
        });
        Ok(())
    }

    pub fn update_config(
        ctx: Context<UpdateConfig>,
        new_owner: Pubkey,
        new_platform_fee: u16,
        new_treasury: Pubkey,
        new_paused: bool,
    ) -> Result<()> {
        require!(new_platform_fee < 10000, CustomError::InvalidPlatformFee);

        let config = &mut ctx.accounts.global_config;

        config.owner = new_owner;
        config.platform_fee = new_platform_fee;
        config.treasury = new_treasury;
        config.paused = new_paused;

        emit!(ConfigUpdated {
            owner: config.owner,
            platform_fee: config.platform_fee,
            treasury: config.treasury,
            paused: config.paused,
        });

        Ok(())
    }
    pub fn open_order_sol(ctx: Context<OpenOrderSol>, params: OpenOrderParams) -> Result<()> {
        if params.from_token != native_token()
            || params.from_chain_id != 10002
            || params.amount_in == 0
            || params.to_chain_id == 0
            || params.to_token.is_empty()
            || params.recipient.is_empty()
        {
            return Err(error!(CustomError::InvalidParameter));
        }
        let clock = Clock::get()?;
        if params.expiry <= clock.unix_timestamp {
            return Err(error!(CustomError::InvalidParameter));
        }

        require!(
            ctx.accounts.user.lamports() >= params.amount_in,
            CustomError::InsufficientFunds
        );

        system_program::transfer(
            CpiContext::new(
                ctx.accounts.system_program.to_account_info(),
                system_program::Transfer {
                    from: ctx.accounts.user.to_account_info(),
                    to: ctx.accounts.order.to_account_info(),
                },
            ),
            params.amount_in, // lamports
        )?;
        let order = &mut ctx.accounts.order;
        add_order(order, &ctx.accounts.user, &params, ctx.bumps.order);

        emit!(OrderOpened {
            order_pubkey: ctx.accounts.order.key(),
        });

        Ok(())
    }

    pub fn open_order_spl(ctx: Context<OpenOrderSpl>, params: OpenOrderParams) -> Result<()> {
        if params.from_token == Pubkey::default()
            || params.from_chain_id != 10002
            || params.amount_in == 0
            || params.to_chain_id == 0
            || params.to_token.is_empty()
            || params.recipient.is_empty()
        {
            return Err(error!(CustomError::InvalidParameter));
        }
        let clock = Clock::get()?;
        if params.expiry <= clock.unix_timestamp {
            return Err(error!(CustomError::InvalidParameter));
        }
        require_keys_eq!(
            ctx.accounts.token_mint.key(),
            params.from_token,
            CustomError::InvalidParameter
        );
        require_keys_eq!(
            ctx.accounts.user_token_account.mint,
            params.from_token,
            CustomError::InvalidParameter
        );

        // Transfer SPL token to order_token_account
        let cpi_accounts = TokenTransfer {
            from: ctx.accounts.user_token_account.to_account_info(),
            to: ctx.accounts.order_token_account.to_account_info(),
            authority: ctx.accounts.user.to_account_info(),
        };
        let cpi_ctx = CpiContext::new(ctx.accounts.token_program.to_account_info(), cpi_accounts);

        // Transfer SPL tokens
        token::transfer(cpi_ctx, params.amount_in)?;

        let order = &mut ctx.accounts.order;
        add_order(order, &ctx.accounts.user, &params, ctx.bumps.order);

        emit!(OrderOpened {
            order_pubkey: ctx.accounts.order.key(),
        });
        Ok(())
    }

    pub fn cancel_order(ctx: Context<CancelOrder>) -> Result<()> {
        let order = &ctx.accounts.order;

        require!(
            ctx.accounts.user.key() == order.sender
                || ctx.accounts.user.key() == ctx.accounts.global_config.owner,
            CustomError::OnlySenderOrOwner
        );

        require!(
            ctx.accounts.refund_receiver.key() == ctx.accounts.order.sender,
            CustomError::InvalidRefundReceiver
        );

        let native_token = native_token();

        if order.from_token == native_token {
            // refund SOL
            **ctx
                .accounts
                .order
                .to_account_info()
                .try_borrow_mut_lamports()? -= order.amount_in;
            **ctx.accounts.user.try_borrow_mut_lamports()? += order.amount_in;
        } else {
            // refund SPL token
            let seeds = &[
                b"limit_order",
                order.sender.as_ref(),
                &order.timestamp.to_le_bytes(),
                &[order.bump],
            ];
            let signer = &[&seeds[..]];

            let cpi_accounts = TokenTransfer {
                from: ctx.accounts.order_token_account.to_account_info(),
                to: ctx.accounts.user_token_account.to_account_info(),
                authority: ctx.accounts.order.to_account_info(),
            };
            let cpi_ctx = CpiContext::new_with_signer(
                ctx.accounts.token_program.to_account_info(),
                cpi_accounts,
                signer,
            );
            token::transfer(cpi_ctx, order.amount_in)?;
        }

        emit!(OrderCancelled {
            order_pubkey: ctx.accounts.order.key(),
            by: ctx.accounts.user.key(),
        });

        Ok(())
    }

    pub fn execute_order(ctx: Context<ExecuteOrder>, native_token_volume: u64) -> Result<()> {
        let order = &ctx.accounts.order;
        let config = &ctx.accounts.global_config;

        let clock = Clock::get()?;
        require!(
            order.expiry > clock.unix_timestamp,
            CustomError::ExpiryEarlier
        );

        let from_token = order.from_token;
        let amount_in = order.amount_in;
        let platform_fee = config.platform_fee;

        let fee_amount = amount_in
            .checked_mul(platform_fee as u64)
            .ok_or(CustomError::Overflow)?
            / 10000;
        let send_amount = amount_in
            .checked_sub(fee_amount)
            .ok_or(CustomError::Overflow)?;
        require!(send_amount > 0, CustomError::InsufficientFunds);

        let seeds = &[
            b"limit_order",
            order.sender.as_ref(),
            &order.timestamp.to_le_bytes(),
            &[order.bump],
        ];
        let signer = &[&seeds[..]];

        if from_token == native_token() {
            **ctx
                .accounts
                .order
                .to_account_info()
                .try_borrow_mut_lamports()? -= amount_in;
            **ctx.accounts.target_sol.try_borrow_mut_lamports()? += send_amount;
            **ctx.accounts.treasury.try_borrow_mut_lamports()? += fee_amount;
        } else {
            let cpi_accounts = TokenTransfer {
                from: ctx.accounts.order_token_account.to_account_info(),
                to: ctx.accounts.target_token_account.to_account_info(),
                authority: ctx.accounts.order.to_account_info(),
            };
            let cpi_ctx = CpiContext::new_with_signer(
                ctx.accounts.token_program.to_account_info(),
                cpi_accounts,
                signer,
            );
            token::transfer(cpi_ctx, send_amount)?;

            // 转账平台费到 treasury
            let cpi_fee_accounts = TokenTransfer {
                from: ctx.accounts.order_token_account.to_account_info(),
                to: ctx.accounts.treasury_token_account.to_account_info(),
                authority: ctx.accounts.order.to_account_info(),
            };
            let cpi_fee_ctx = CpiContext::new_with_signer(
                ctx.accounts.token_program.to_account_info(),
                cpi_fee_accounts,
                signer,
            );
            token::transfer(cpi_fee_ctx, fee_amount)?;
        }

        Ok(())
    }
}

fn native_token() -> Pubkey {
    Pubkey::from_str("So11111111111111111111111111111111111111112").unwrap()
}

fn add_order(order: &mut Account<LimitOrder>, user: &Signer, params: &OpenOrderParams, bump: u8) {
    order.from_token = params.from_token;
    order.from_chain_id = params.from_chain_id;
    order.amount_in = params.amount_in;
    order.to_chain_id = params.to_chain_id;
    order.to_token = params.to_token;
    order.recipient = params.recipient;
    order.sender = user.key();
    order.expiry = params.expiry;
    order.amount_out = params.amount_out;
    order.bump = bump;
}

#[derive(Accounts)]
pub struct TestContext<'info> {
    #[account(mut)]
    pub user_token_account: Account<'info, TokenAccount>,
    pub token_mint: Account<'info, Mint>,
    pub token_program: Program<'info, Token>,
}

#[derive(Accounts)]
pub struct Initialize<'info> {
    #[account(
        init,
        seeds = [b"global-config"],
        bump,
        payer = signer,
        space = 8 + GlobalConfig::SIZE
    )]
    pub global_config: Account<'info, GlobalConfig>,

    #[account(mut)]
    pub signer: Signer<'info>,

    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
#[instruction(params: OpenOrderParams)]

pub struct OpenOrderSol<'info> {
    #[account(
        init,
        seeds = [b"limit_order", user.key().as_ref(),&params.expiry.to_le_bytes()],
        bump,
        payer = user,
        space = 8 + LimitOrder::SIZE,
    )]
    pub order: Account<'info, LimitOrder>,

    #[account(mut)]
    pub user: Signer<'info>,

    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
#[instruction(params: OpenOrderParams)]
pub struct OpenOrderSpl<'info> {
    #[account(
        init,
        seeds = [b"limit_order", user.key().as_ref(),&params.expiry.to_le_bytes()],
        bump,
        payer = user,
        space = 8 + LimitOrder::SIZE,
    )]
    pub order: Account<'info, LimitOrder>,

    #[account(mut)]
    pub user: Signer<'info>,

    #[account(mut)]
    pub user_token_account: Account<'info, TokenAccount>,

    #[account(
        init,
        payer = user,
        associated_token::mint = token_mint,
        associated_token::authority = order
    )]
    pub order_token_account: Account<'info, TokenAccount>,

    pub token_mint: Account<'info, Mint>,

    pub token_program: Program<'info, Token>,

    pub system_program: Program<'info, System>,

    pub associated_token_program: Program<'info, anchor_spl::associated_token::AssociatedToken>,
}

#[derive(Accounts)]
pub struct ExecuteOrder<'info> {
    #[account(
        mut,
        close = refund_receiver // refund rent to order.sender
    )]
    pub order: Account<'info, LimitOrder>,

    #[account(
        mut,
        constraint = order_token_account.owner == order.key()
    )]
    pub order_token_account: Account<'info, TokenAccount>,

    #[account(mut)]
    pub target_token_account: Account<'info, TokenAccount>,

    #[account(
        mut,
        constraint = treasury_token_account.owner == treasury.key(),
        constraint = treasury_token_account.mint == order.from_token,
        constraint = treasury_token_account.key() == get_associated_token_address(&treasury.key(), &order.from_token)
    )]
    pub treasury_token_account: Account<'info, TokenAccount>,

    #[account(
        seeds = [b"global-config"],
        bump,
    )]
    pub global_config: Account<'info, GlobalConfig>,

    pub refund_receiver: SystemAccount<'info>, // <- 新增

    #[account(mut, address = global_config.treasury)]
    pub treasury: SystemAccount<'info>,

    pub executor: Signer<'info>,

    #[account(mut)]
    pub target_sol: SystemAccount<'info>,

    pub token_program: Program<'info, Token>,
}

#[derive(Accounts)]
pub struct CancelOrder<'info> {
    #[account(
        mut,
        close = refund_receiver
    )]
    pub order: Account<'info, LimitOrder>,

    #[account(mut)]
    pub user: Signer<'info>,

    #[account(
        mut,
        constraint = order.from_token == native_token() || (
            user_token_account.owner == refund_receiver.key() &&
            user_token_account.mint == order.from_token
        )
    )]
    pub user_token_account: Account<'info, TokenAccount>,

    #[account(
        mut,
        constraint = order_token_account.owner == order.key(),
        close = refund_receiver 
    )]
    pub order_token_account: Account<'info, TokenAccount>,

    #[account(mut)]
    pub refund_receiver: SystemAccount<'info>,

    #[account(
        seeds = [b"global-config"],
        bump,    
    )]
    pub global_config: Account<'info, GlobalConfig>,

    pub token_program: Program<'info, Token>,
}

#[derive(Accounts)]
pub struct UpdateConfig<'info> {
    #[account(
        mut,
        seeds = [b"global-config"],
        bump,
        has_one = owner
    )]
    pub global_config: Account<'info, GlobalConfig>,

    pub owner: Signer<'info>,
}

#[derive(AnchorSerialize, AnchorDeserialize)]
pub struct OpenOrderParams {
    pub from_token: Pubkey,
    pub from_chain_id: u64,
    pub amount_in: u64,
    pub to_chain_id: u64,
    pub to_token: [u8; 40],
    pub recipient: [u8; 40],
    pub expiry: i64,
    pub amount_out: [u8; 32],
}

#[account]
pub struct GlobalConfig {
    pub owner: Pubkey,
    pub platform_fee: u16,
    pub treasury: Pubkey,
    pub paused: bool,
    pub reserved: [u8; 128], // Reserved space for future use
}

impl GlobalConfig {
    pub const SIZE: usize = 32 + 2 + 32 + 1 + 128;
}

#[account]
pub struct LimitOrder {
    pub from_token: Pubkey,
    pub from_chain_id: u64,
    pub amount_in: u64,
    pub to_chain_id: u64,
    pub to_token: [u8; 40],
    pub recipient: [u8; 40],
    pub sender: Pubkey,
    pub expiry: i64,
    pub amount_out: [u8; 32],
    pub timestamp: u64,
    pub bump: u8,
}

impl LimitOrder {
    pub const SIZE: usize = 32 + 8 + 8 + 8 + 40 + 40 + 32 + 8 + 32 + 8 + 1;
}

#[event]
pub struct Initialized {
    pub owner: Pubkey,
    pub platform_fee: u16,
    pub treasury: Pubkey,
    pub paused: bool,
}

#[event]
pub struct ConfigUpdated {
    pub owner: Pubkey,
    pub platform_fee: u16,
    pub treasury: Pubkey,
    pub paused: bool,
}

#[event]
pub struct OrderOpened {
    pub order_pubkey: Pubkey,
}

#[event]
pub struct OrderCancelled {
    pub order_pubkey: Pubkey,
    pub by: Pubkey,
}

#[error_code]
pub enum CustomError {
    #[msg("Platform fee must be between 0 and 10000.")]
    InvalidPlatformFee,
    #[msg("Invalid parameter")]
    InvalidParameter,
    #[msg("Expiry time must be in the future.")]
    ExpiryEarlier,
    #[msg("math over flow.")]
    Overflow,
    #[msg("Insufficient funds for the operation.")]
    InsufficientFunds,
    #[msg("OnlySenderOrOwner.")]
    OnlySenderOrOwner,
    #[msg("Invalid refund receiver.")]
    InvalidRefundReceiver,
}
