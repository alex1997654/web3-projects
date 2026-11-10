import * as anchor from "@coral-xyz/anchor";
import { Program } from "@coral-xyz/anchor";
import {
  ASSOCIATED_TOKEN_PROGRAM_ID,
  TOKEN_PROGRAM_ID,
  createMint,
  getAccount,
  getAssociatedTokenAddressSync,
  getMint,
  getOrCreateAssociatedTokenAccount,
  mintTo,
} from "@solana/spl-token";
import { PublicKey, SystemProgram } from "@solana/web3.js";
import BN from "bn.js";
import { assert } from "chai";
import { Amm } from "../target/types/amm";

function isqrt(x: bigint): bigint {
  if (x === 0n) return 0n;
  let bit = 1n << 126n;
  while (bit > x) bit >>= 2n;
  let result = 0n;
  while (bit !== 0n) {
    if (x >= result + bit) {
      x -= result + bit;
      result = (result >> 1n) + bit;
    } else {
      result >>= 1n;
    }
    bit >>= 2n;
  }
  return result;
}

describe("amm smoke", () => {
  const provider = anchor.AnchorProvider.env();
  anchor.setProvider(provider);
  const program = anchor.workspace.Amm as Program<Amm>;
  const wallet = provider.wallet as anchor.Wallet;
  const connection = provider.connection;

  const DECIMALS = 9;
  const DEPOSIT = 1_000_000_000;

  it("initializes a pool, takes first liquidity, and swaps", async () => {
    const m1 = await createMint(connection, wallet.payer, wallet.publicKey, null, DECIMALS);
    const m2 = await createMint(connection, wallet.payer, wallet.publicKey, null, DECIMALS);
    const [base, quote] =
      m1.toBuffer().compare(m2.toBuffer()) < 0 ? [m1, m2] : [m2, m1];

    const [pool] = PublicKey.findProgramAddressSync(
      [Buffer.from("pool"), base.toBuffer(), quote.toBuffer()],
      program.programId
    );
    const [lpMint] = PublicKey.findProgramAddressSync(
      [Buffer.from("lp_mint"), pool.toBuffer()],
      program.programId
    );
    const vaultBase = getAssociatedTokenAddressSync(base, pool, true);
    const vaultQuote = getAssociatedTokenAddressSync(quote, pool, true);

    await getOrCreateAssociatedTokenAccount(connection, wallet.payer, base, pool, true);
    await getOrCreateAssociatedTokenAccount(connection, wallet.payer, quote, pool, true);

    await program.methods
      .initializePool()
      .accounts({
        payer: wallet.publicKey,
        baseMint: base,
        quoteMint: quote,
      })
      .rpc();

    const poolAccount = await program.account.pool.fetch(pool);
    assert.equal(poolAccount.baseMint.toBase58(), base.toBase58());
    assert.equal(poolAccount.quoteMint.toBase58(), quote.toBase58());
    assert.equal(poolAccount.lpMint.toBase58(), lpMint.toBase58());

    const userBase = await getOrCreateAssociatedTokenAccount(
      connection, wallet.payer, base, wallet.publicKey
    );
    const userQuote = await getOrCreateAssociatedTokenAccount(
      connection, wallet.payer, quote, wallet.publicKey
    );
    const userLp = await getOrCreateAssociatedTokenAccount(
      connection, wallet.payer, lpMint, wallet.publicKey
    );
    await mintTo(connection, wallet.payer, base, userBase.address, wallet.publicKey, DEPOSIT);
    await mintTo(connection, wallet.payer, quote, userQuote.address, wallet.publicKey, DEPOSIT);

    await program.methods
      .addLiquidity({ amountBase: new BN(DEPOSIT), amountQuote: new BN(DEPOSIT), minLpOut: new BN(0) })
      .accounts({
        user: wallet.publicKey,
        baseMint: base,
        quoteMint: quote,
      })
      .rpc();

    const lpMintInfo = await getMint(connection, lpMint);
    assert.equal(lpMintInfo.supply, isqrt(BigInt(DEPOSIT) * BigInt(DEPOSIT)));

    // The first deposit moved the user's entire balance into the vaults;
    // top the base side back up so the swap has something to spend.
    const amountIn = 1_000_000;
    await mintTo(connection, wallet.payer, base, userBase.address, wallet.publicKey, amountIn);
    const rIn = BigInt(DEPOSIT);
    const rOut = BigInt(DEPOSIT);
    const fee = 1n + ((BigInt(amountIn) * 25n - 1n) / 10_000n);
    const aif = BigInt(amountIn) - fee;
    const expectedOut = (aif * rOut) / (rIn + aif);

    const quoteBefore = (await getAccount(connection, userQuote.address)).amount;
    await program.methods
      .swap({ isBaseIn: true, amountIn: new BN(amountIn), minOut: new BN(0) })
      .accounts({
        user: wallet.publicKey,
        baseMint: base,
        quoteMint: quote,
      })
      .rpc();

    const quoteAfter = (await getAccount(connection, userQuote.address)).amount;
    assert.equal(quoteAfter - quoteBefore, expectedOut);

    // k must have grown by the fee staying in the pool.
    const vaultBaseAfter = (await getAccount(connection, vaultBase)).amount;
    const vaultQuoteAfter = (await getAccount(connection, vaultQuote)).amount;
    assert.equal(
      vaultBaseAfter * vaultQuoteAfter,
      (rIn + BigInt(amountIn)) * (rOut - expectedOut)
    );
  });
});
