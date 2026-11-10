pub mod errors;
pub mod instructions;
pub mod math;
pub mod state;

use anchor_lang::prelude::*;
use instructions::*;

declare_id!("DWqPzswcf4rvZSb5yGj14Cy7fnyGvrgUM17N4WnkLheY");

#[program]
pub mod amm {
    use super::*;

    pub fn initialize_pool(ctx: Context<InitializePool>) -> Result<()> {
        instructions::initialize_pool::initialize_pool(ctx)
    }

    pub fn add_liquidity(ctx: Context<AddLiquidity>, args: AddLiquidityArgs) -> Result<()> {
        instructions::add_liquidity::add_liquidity(ctx, args)
    }

    pub fn remove_liquidity(
        ctx: Context<RemoveLiquidity>,
        args: RemoveLiquidityArgs,
    ) -> Result<()> {
        instructions::remove_liquidity::remove_liquidity(ctx, args)
    }

    pub fn swap(ctx: Context<Swap>, args: SwapArgs) -> Result<()> {
        instructions::swap::swap(ctx, args)
    }
}
