import * as anchor from "@coral-xyz/anchor";
import { Program } from "@coral-xyz/anchor";
import { expect } from "chai";
import {
  ASSOCIATED_TOKEN_PROGRAM_ID,
  TOKEN_PROGRAM_ID,
  createAssociatedTokenAccount,
  createMint,
  getAccount,
  getAssociatedTokenAddressSync,
  getMint,
  getOrCreateAssociatedTokenAccount,
  mintTo,
  transfer,
} from "@solana/spl-token";
import { Keypair, PublicKey, SystemProgram } from "@solana/web3.js";
import type { Amm } from "../target/types/amm";
import {
  LP_DECIMALS,
  MIN_INITIAL_LP,
  computeAmountOut,
  computeLpFirstLiquidity,
  computeLpMint,
  computeWithdrawAmounts,
  isqrtU128,
} from "./helpers/mirror";

// SPEC fixes the errors.rs declaration order; Anchor numbers custom errors from 6000.
const ERR_IDENTICAL_MINTS = { code: 6000, name: "IdenticalMints" };
const ERR_NON_CANONICAL_PAIR_ORDER = { code: 6001, name: "NonCanonicalPairOrder" };
const ERR_ZERO_AMOUNT = { code: 6002, name: "ZeroAmount" };
const ERR_INSUFFICIENT_LIQUIDITY = { code: 6003, name: "InsufficientLiquidity" };
const ERR_INSUFFICIENT_INITIAL_LIQUIDITY = { code: 6004, name: "InsufficientInitialLiquidity" };
const ERR_SLIPPAGE_EXCEEDED = { code: 6005, name: "SlippageExceeded" };

const MINT_DECIMALS = 6;

interface PoolHandles {
  baseMint: PublicKey;
  quoteMint: PublicKey;
  pool: PublicKey;
  lpMint: PublicKey;
  vaultBase: PublicKey;
  vaultQuote: PublicKey;
  userBaseAta: PublicKey;
  userQuoteAta: PublicKey;
  userLpAta: PublicKey;
}

interface LiquidityArgs {
  amountBase: bigint;
  amountQuote: bigint;
  minLpOut: bigint;
}

interface RemoveArgs {
  lpAmount: bigint;
  minBaseOut: bigint;
  minQuoteOut: bigint;
}

describe("amm", () => {
  const provider = anchor.AnchorProvider.env();
  anchor.setProvider(provider);
  const payer = (provider.wallet as anchor.Wallet).payer;
  const program = anchor.workspace.Amm as Program<Amm>;

  const bn = (v: bigint): anchor.BN => new anchor.BN(v.toString(10));

  async function expectFailure(promise: Promise<unknown>): Promise<unknown> {
    try {
      await promise;
    } catch (err) {
      return err;
    }
    throw new Error("expected transaction to fail, but it succeeded");
  }

  function errorText(err: unknown): string {
    const e = err as { error?: { errorMessage?: string } };
    return [e?.error?.errorMessage, err instanceof Error ? err.message : String(err)]
      .filter(Boolean)
      .join(" ");
  }

  // Custom program errors carry the structured errorCode; the message-name
  // comparison covers clients that surface the AnchorError textually.
  function expectAnchorError(err: unknown, expected: { code: number; name: string }): void {
    const e = err as { error?: { errorCode?: { code?: number; name?: string } } };
    const codeMatch =
      e?.error?.errorCode?.code === expected.code && e?.error?.errorCode?.name === expected.name;
    const text = errorText(err);
    expect(
      codeMatch || text.includes(expected.name),
      `expected ${expected.name} (code ${expected.code}); got: ${text || JSON.stringify(err)}`,
    ).to.equal(true);
  }

  // Failures raised by the token/system programs or by anchor account
  // validation have no stable custom code, so they are matched by message family.
  function expectForeignError(err: unknown, pattern: RegExp): void {
    const text = errorText(err);
    expect(
      pattern.test(text),
      `expected error matching ${String(pattern)}; got: ${text || JSON.stringify(err)}`,
    ).to.equal(true);
  }

  // Pubkey ordering is bytewise; the program requires base < quote.
  function orderedMintKeypairs(): { base: Keypair; quote: Keypair } {
    const a = Keypair.generate();
    const b = Keypair.generate();
    return a.publicKey.toBuffer().compare(b.publicKey.toBuffer()) <= 0
      ? { base: a, quote: b }
      : { base: b, quote: a };
  }

  function reversedMintKeypairs(): { base: Keypair; quote: Keypair } {
    const a = Keypair.generate();
    const b = Keypair.generate();
    return a.publicKey.toBuffer().compare(b.publicKey.toBuffer()) > 0
      ? { base: a, quote: b }
      : { base: b, quote: a };
  }

  function derivePool(baseMint: PublicKey, quoteMint: PublicKey) {
    const [pool] = PublicKey.findProgramAddressSync(
      [Buffer.from("pool"), baseMint.toBuffer(), quoteMint.toBuffer()],
      program.programId,
    );
    const [lpMint] = PublicKey.findProgramAddressSync(
      [Buffer.from("lp_mint"), pool.toBuffer()],
      program.programId,
    );
    const vaultBase = getAssociatedTokenAddressSync(baseMint, pool, true, TOKEN_PROGRAM_ID);
    const vaultQuote = getAssociatedTokenAddressSync(quoteMint, pool, true, TOKEN_PROGRAM_ID);
    return { pool, lpMint, vaultBase, vaultQuote };
  }

  async function balanceOf(tokenAccount: PublicKey): Promise<bigint> {
    return (await getAccount(provider.connection, tokenAccount)).amount;
  }

  async function supplyOf(mint: PublicKey): Promise<bigint> {
    return (await getMint(provider.connection, mint)).supply;
  }

  async function createFundedMint(
    decimals: number,
    amount: bigint,
    keypair: Keypair = Keypair.generate(),
  ): Promise<{ mint: PublicKey; userAta: PublicKey }> {
    const mint = await createMint(provider.connection, payer, payer.publicKey, null, decimals, keypair);
    const userAta = await getOrCreateAssociatedTokenAccount(provider.connection, payer, mint, payer.publicKey);
    if (amount > 0n) {
      await mintTo(provider.connection, payer, mint, userAta.address, payer.publicKey, amount);
    }
    return { mint, userAta: userAta.address };
  }

  async function initializePool(baseMint: PublicKey, quoteMint: PublicKey) {
    const derived = derivePool(baseMint, quoteMint);
    await getOrCreateAssociatedTokenAccount(provider.connection, payer, baseMint, derived.pool, true);
    await getOrCreateAssociatedTokenAccount(provider.connection, payer, quoteMint, derived.pool, true);
    await program.methods
      .initializePool()
      .accounts({
        payer: payer.publicKey,
        baseMint,
        quoteMint,
      })
      .rpc();
    return derived;
  }

  async function addLiquidity(handles: PoolHandles, args: LiquidityArgs) {
    return program.methods
      .addLiquidity({
        amountBase: bn(args.amountBase),
        amountQuote: bn(args.amountQuote),
        minLpOut: bn(args.minLpOut),
      })
      .accounts({
        user: payer.publicKey,
        baseMint: handles.baseMint,
        quoteMint: handles.quoteMint,
      })
      .rpc();
  }

  async function removeLiquidity(handles: PoolHandles, args: RemoveArgs) {
    return program.methods
      .removeLiquidity({
        lpAmount: bn(args.lpAmount),
        minBaseOut: bn(args.minBaseOut),
        minQuoteOut: bn(args.minQuoteOut),
      })
      .accounts({
        user: payer.publicKey,
        baseMint: handles.baseMint,
        quoteMint: handles.quoteMint,
      })
      .rpc();
  }

  async function swap(handles: PoolHandles, isBaseIn: boolean, amountIn: bigint, minOut: bigint) {
    return program.methods
      .swap({ isBaseIn, amountIn: bn(amountIn), minOut: bn(minOut) })
      .accounts({
        user: payer.publicKey,
        baseMint: handles.baseMint,
        quoteMint: handles.quoteMint,
      })
      .rpc();
  }

  async function createUserLpAta(lpMint: PublicKey): Promise<PublicKey> {
    return createAssociatedTokenAccount(provider.connection, payer, lpMint, payer.publicKey);
  }

  // Fresh pool with the first deposit already placed; headroom tops up the
  // payer wallet so later instructions have tokens to move.
  async function setupPool(
    initialBase: bigint,
    initialQuote: bigint,
    baseHeadroom: bigint = 0n,
    quoteHeadroom: bigint = 0n,
  ): Promise<{ handles: PoolHandles; supply: bigint }> {
    const { base, quote } = orderedMintKeypairs();
    const { mint: baseMint, userAta: userBaseAta } = await createFundedMint(
      MINT_DECIMALS,
      initialBase + baseHeadroom,
      base,
    );
    const { mint: quoteMint, userAta: userQuoteAta } = await createFundedMint(
      MINT_DECIMALS,
      initialQuote + quoteHeadroom,
      quote,
    );
    const derived = await initializePool(baseMint, quoteMint);
    const userLpAta = await createUserLpAta(derived.lpMint);
    const handles: PoolHandles = { baseMint, quoteMint, userBaseAta, userQuoteAta, userLpAta, ...derived };
    const supply = computeLpFirstLiquidity(initialBase, initialQuote);
    await addLiquidity(handles, { amountBase: initialBase, amountQuote: initialQuote, minLpOut: supply });
    return { handles, supply };
  }

  async function setupEmptyPool(): Promise<PoolHandles> {
    const { base, quote } = orderedMintKeypairs();
    const { mint: baseMint, userAta: userBaseAta } = await createFundedMint(MINT_DECIMALS, 1_000_000n, base);
    const { mint: quoteMint, userAta: userQuoteAta } = await createFundedMint(MINT_DECIMALS, 1_000_000n, quote);
    const derived = await initializePool(baseMint, quoteMint);
    const userLpAta = await createUserLpAta(derived.lpMint);
    return { baseMint, quoteMint, userBaseAta, userQuoteAta, userLpAta, ...derived };
  }

  describe("initializePool", () => {
    it("creates the pool with correct fields, an LP mint with 6 decimals owned by the pool, and empty vaults", async () => {
      const { base, quote } = orderedMintKeypairs();
      const { mint: baseMint } = await createFundedMint(MINT_DECIMALS, 0n, base);
      const { mint: quoteMint } = await createFundedMint(MINT_DECIMALS, 0n, quote);
      const derived = await initializePool(baseMint, quoteMint);

      const poolAccount = await program.account.pool.fetch(derived.pool);
      expect(poolAccount.baseMint.equals(baseMint), "pool.base_mint").to.equal(true);
      expect(poolAccount.quoteMint.equals(quoteMint), "pool.quote_mint").to.equal(true);
      expect(poolAccount.lpMint.equals(derived.lpMint), "pool.lp_mint").to.equal(true);
      expect(poolAccount.vaultBase.equals(derived.vaultBase), "pool.vault_base").to.equal(true);
      expect(poolAccount.vaultQuote.equals(derived.vaultQuote), "pool.vault_quote").to.equal(true);
      const [expectedPool, expectedBump] = PublicKey.findProgramAddressSync(
        [Buffer.from("pool"), baseMint.toBuffer(), quoteMint.toBuffer()],
        program.programId,
      );
      expect(derived.pool.equals(expectedPool)).to.equal(true);
      expect(poolAccount.bump).to.equal(expectedBump);

      const lp = await getMint(provider.connection, derived.lpMint);
      expect(lp.decimals).to.equal(LP_DECIMALS);
      expect(lp.supply).to.equal(0n);
      expect(lp.mintAuthority, "lp mint must have an authority").to.not.equal(null);
      expect(lp.mintAuthority!.equals(derived.pool), "lp mint authority is the pool PDA").to.equal(true);
      expect(lp.freezeAuthority).to.equal(null);

      const vaultBase = await getAccount(provider.connection, derived.vaultBase);
      const vaultQuote = await getAccount(provider.connection, derived.vaultQuote);
      expect(vaultBase.amount).to.equal(0n);
      expect(vaultQuote.amount).to.equal(0n);
      expect(vaultBase.owner.equals(derived.pool), "vault base owned by pool").to.equal(true);
      expect(vaultQuote.owner.equals(derived.pool), "vault quote owned by pool").to.equal(true);
      expect(vaultBase.mint.equals(baseMint)).to.equal(true);
      expect(vaultQuote.mint.equals(quoteMint)).to.equal(true);
    });

    it("rejects identical mints and persists no pool", async () => {
      const { mint } = await createFundedMint(MINT_DECIMALS, 0n);
      const derived = derivePool(mint, mint);
      const err = await expectFailure(initializePool(mint, mint));
      // The vaults are verified (not program-initialized) accounts, so no
      // ATA collision fires first; the handler's own check surfaces.
      expectAnchorError(err, ERR_IDENTICAL_MINTS);
      const poolInfo = await provider.connection.getAccountInfo(derived.pool);
      expect(poolInfo, "pool PDA must not exist after a failed init").to.equal(null);
    });

    it("rejects a non-canonical pair order with NonCanonicalPairOrder", async () => {
      const { base, quote } = reversedMintKeypairs();
      const { mint: baseMint } = await createFundedMint(MINT_DECIMALS, 0n, base);
      const { mint: quoteMint } = await createFundedMint(MINT_DECIMALS, 0n, quote);
      const err = await expectFailure(initializePool(baseMint, quoteMint));
      expectAnchorError(err, ERR_NON_CANONICAL_PAIR_ORDER);
    });

    it("rejects re-initializing the same pair", async () => {
      const { base, quote } = orderedMintKeypairs();
      const { mint: baseMint } = await createFundedMint(MINT_DECIMALS, 0n, base);
      const { mint: quoteMint } = await createFundedMint(MINT_DECIMALS, 0n, quote);
      await initializePool(baseMint, quoteMint);
      const err = await expectFailure(initializePool(baseMint, quoteMint));
      // init on an occupied PDA fails in anchor/system, not with a custom error.
      expectForeignError(err, /in use|already|initialized/i);
    });
  });

  describe("first liquidity", () => {
    it("mints exactly isqrt(base * quote) LP on the first deposit", async () => {
      const initialBase = 1_000_000n;
      const initialQuote = 2_500_000n;
      const expectedSupply = computeLpFirstLiquidity(initialBase, initialQuote);
      expect(expectedSupply).to.equal(isqrtU128(initialBase * initialQuote));
      expect(expectedSupply >= MIN_INITIAL_LP).to.equal(true);

      const { handles, supply } = await setupPool(initialBase, initialQuote);
      expect(supply).to.equal(expectedSupply);
      expect(await supplyOf(handles.lpMint)).to.equal(expectedSupply);
      expect(await balanceOf(handles.userLpAta)).to.equal(expectedSupply);
      expect(await balanceOf(handles.vaultBase)).to.equal(initialBase);
      expect(await balanceOf(handles.vaultQuote)).to.equal(initialQuote);
    });

    it("rejects a first deposit whose isqrt is below MIN_INITIAL_LP with InsufficientInitialLiquidity", async () => {
      const initialBase = 998n;
      const initialQuote = 1_000n;
      expect(isqrtU128(initialBase * initialQuote) < MIN_INITIAL_LP).to.equal(true);

      const handles = await setupEmptyPool();
      const err = await expectFailure(
        addLiquidity(handles, { amountBase: initialBase, amountQuote: initialQuote, minLpOut: 0n }),
      );
      expectAnchorError(err, ERR_INSUFFICIENT_INITIAL_LIQUIDITY);
    });

    it("accepts a first deposit landing exactly on MIN_INITIAL_LP", async () => {
      const { handles, supply } = await setupPool(MIN_INITIAL_LP, MIN_INITIAL_LP);
      expect(supply).to.equal(MIN_INITIAL_LP);
      expect(await supplyOf(handles.lpMint)).to.equal(MIN_INITIAL_LP);
      expect(await balanceOf(handles.vaultBase)).to.equal(MIN_INITIAL_LP);
      expect(await balanceOf(handles.vaultQuote)).to.equal(MIN_INITIAL_LP);
    });
  });

  describe("add liquidity proportionality", () => {
    it("mints exactly k times the current supply for a deposit of k times the reserves", async () => {
      const rBase = 1_000_000n;
      const rQuote = 4_000_000n;
      const k = 3n;
      const { handles, supply } = await setupPool(rBase, rQuote, rBase * k, rQuote * k);
      expect(supply).to.equal(computeLpFirstLiquidity(rBase, rQuote));

      const minted = computeLpMint(rBase * k, rQuote * k, rBase, rQuote, supply);
      expect(minted).to.equal(k * supply);
      const lpBefore = await balanceOf(handles.userLpAta);
      expect(lpBefore).to.equal(supply);

      await addLiquidity(handles, { amountBase: rBase * k, amountQuote: rQuote * k, minLpOut: minted });

      expect(await supplyOf(handles.lpMint)).to.equal(supply * (k + 1n));
      expect(await balanceOf(handles.userLpAta)).to.equal(lpBefore + minted);
      expect(await balanceOf(handles.vaultBase)).to.equal(rBase * (k + 1n));
      expect(await balanceOf(handles.vaultQuote)).to.equal(rQuote * (k + 1n));
    });

    it("rejects min_lp_out above the computed mint with SlippageExceeded", async () => {
      const rBase = 1_000_000n;
      const rQuote = 4_000_000n;
      const { handles, supply } = await setupPool(rBase, rQuote, 500_000n, 500_000n);
      const amountBase = 500_000n;
      const amountQuote = 500_000n;
      const expected = computeLpMint(amountBase, amountQuote, rBase, rQuote, supply);
      expect(expected > 0n).to.equal(true);

      const err = await expectFailure(
        addLiquidity(handles, { amountBase, amountQuote, minLpOut: expected + 1n }),
      );
      expectAnchorError(err, ERR_SLIPPAGE_EXCEEDED);
    });
  });

  describe("remove liquidity", () => {
    it("pays out exactly the mirror floors and burns the LP", async () => {
      const initialBase = 2_000_000n;
      const initialQuote = 3_000_000n;
      const { handles, supply: supply1 } = await setupPool(initialBase, initialQuote, 1_000_000n, 1_000_000n);

      const lpMinted2 = computeLpMint(1_000_000n, 1_000_000n, initialBase, initialQuote, supply1);
      expect(lpMinted2 > 0n).to.equal(true);
      await addLiquidity(handles, { amountBase: 1_000_000n, amountQuote: 1_000_000n, minLpOut: lpMinted2 });

      const supply2 = supply1 + lpMinted2;
      expect(await supplyOf(handles.lpMint)).to.equal(supply2);

      const reservesBase = initialBase + 1_000_000n;
      const reservesQuote = initialQuote + 1_000_000n;
      const lpAmount = supply2 / 2n;
      const [outBase, outQuote] = computeWithdrawAmounts(lpAmount, supply2, reservesBase, reservesQuote);
      expect(outBase > 0n && outQuote > 0n).to.equal(true);

      const baseBefore = await balanceOf(handles.userBaseAta);
      const quoteBefore = await balanceOf(handles.userQuoteAta);
      const lpBefore = await balanceOf(handles.userLpAta);

      await removeLiquidity(handles, { lpAmount, minBaseOut: outBase, minQuoteOut: outQuote });

      expect((await balanceOf(handles.userBaseAta)) - baseBefore).to.equal(outBase);
      expect((await balanceOf(handles.userQuoteAta)) - quoteBefore).to.equal(outQuote);
      expect((await balanceOf(handles.userLpAta)) - lpBefore).to.equal(-lpAmount);
      expect(await supplyOf(handles.lpMint)).to.equal(supply2 - lpAmount);
      expect(await balanceOf(handles.vaultBase)).to.equal(reservesBase - outBase);
      expect(await balanceOf(handles.vaultQuote)).to.equal(reservesQuote - outQuote);
    });

    it("rejects min_base_out above the computed withdrawal with SlippageExceeded", async () => {
      const rBase = 2_000_000n;
      const rQuote = 3_000_000n;
      const { handles, supply } = await setupPool(rBase, rQuote);
      const [outBase] = computeWithdrawAmounts(supply, supply, rBase, rQuote);
      const err = await expectFailure(
        removeLiquidity(handles, { lpAmount: supply, minBaseOut: outBase + 1n, minQuoteOut: 0n }),
      );
      expectAnchorError(err, ERR_SLIPPAGE_EXCEEDED);
    });

    it("fails when the burn exceeds the user LP balance", async () => {
      const { handles, supply } = await setupPool(2_000_000n, 3_000_000n);

      // Move 1 LP away so the user balance sits below the total supply: the
      // supply guard passes but the burn still fails against the user balance.
      const second = Keypair.generate();
      const secondLpAta = (
        await getOrCreateAssociatedTokenAccount(provider.connection, payer, handles.lpMint, second.publicKey)
      ).address;
      await transfer(provider.connection, payer, handles.userLpAta, secondLpAta, payer.publicKey, 1n);
      expect(await balanceOf(handles.userLpAta)).to.equal(supply - 1n);

      const err = await expectFailure(
        removeLiquidity(handles, { lpAmount: supply, minBaseOut: 0n, minQuoteOut: 0n }),
      );
      expectForeignError(err, /insufficient funds|balance too low|custom program error: 0x1/i);
    });
  });

  describe("swap", () => {
    it("swaps base for quote matching the mirror and strictly increases k", async () => {
      const rBase = 10_000_000n;
      const rQuote = 10_000_000n;
      const amountIn = 2_000_000n;
      const { handles } = await setupPool(rBase, rQuote, amountIn, 0n);
      const expectedOut = computeAmountOut(amountIn, rBase, rQuote);
      expect(expectedOut > 0n).to.equal(true);

      const quoteBefore = await balanceOf(handles.userQuoteAta);
      await swap(handles, true, amountIn, expectedOut);

      expect((await balanceOf(handles.userQuoteAta)) - quoteBefore).to.equal(expectedOut);
      expect(await balanceOf(handles.vaultBase)).to.equal(rBase + amountIn);
      expect(await balanceOf(handles.vaultQuote)).to.equal(rQuote - expectedOut);
      // The fee stays in the pool, so the product strictly grows.
      expect((rBase + amountIn) * (rQuote - expectedOut) > rBase * rQuote).to.equal(true);
    });

    it("swaps quote for base matching the mirror and strictly increases k", async () => {
      const rBase = 10_000_000n;
      const rQuote = 10_000_000n;
      const amountIn = 2_000_000n;
      const { handles } = await setupPool(rBase, rQuote, 0n, amountIn);
      const expectedOut = computeAmountOut(amountIn, rQuote, rBase);
      expect(expectedOut > 0n).to.equal(true);

      const baseBefore = await balanceOf(handles.userBaseAta);
      await swap(handles, false, amountIn, expectedOut);

      expect((await balanceOf(handles.userBaseAta)) - baseBefore).to.equal(expectedOut);
      expect(await balanceOf(handles.vaultQuote)).to.equal(rQuote + amountIn);
      expect(await balanceOf(handles.vaultBase)).to.equal(rBase - expectedOut);
      expect((rQuote + amountIn) * (rBase - expectedOut) > rQuote * rBase).to.equal(true);
    });

    it("rejects min_out above the computed output with SlippageExceeded", async () => {
      const rBase = 10_000_000n;
      const rQuote = 10_000_000n;
      const amountIn = 2_000_000n;
      const { handles } = await setupPool(rBase, rQuote, amountIn, 0n);
      const expectedOut = computeAmountOut(amountIn, rBase, rQuote);
      const err = await expectFailure(swap(handles, true, amountIn, expectedOut + 1n));
      expectAnchorError(err, ERR_SLIPPAGE_EXCEEDED);
    });

    it("succeeds with zero out on a dust swap when min_out is zero", async () => {
      const rBase = 10_000_000n;
      const rQuote = 10_000_000n;
      const amountIn = 1n;
      const { handles } = await setupPool(rBase, rQuote, amountIn, 0n);
      // fee = ceil(1 * 25 / 10000) = 1, so nothing survives to earn output.
      expect(computeAmountOut(amountIn, rBase, rQuote)).to.equal(0n);

      const quoteBefore = await balanceOf(handles.userQuoteAta);
      const baseBefore = await balanceOf(handles.userBaseAta);
      await swap(handles, true, amountIn, 0n);

      expect((await balanceOf(handles.userQuoteAta)) - quoteBefore).to.equal(0n);
      expect((await balanceOf(handles.userBaseAta)) - baseBefore).to.equal(-1n);
      expect(await balanceOf(handles.vaultBase)).to.equal(rBase + 1n);
      expect(await balanceOf(handles.vaultQuote)).to.equal(rQuote);
    });
  });

  describe("extreme reserves near u64::MAX", () => {
    it("swaps a large amount at 2^62 reserves with no overflow, matching the mirror", async () => {
      const unit = 1n << 62n;
      const swapIn = 1n << 60n;

      const { base, quote } = orderedMintKeypairs();
      const { mint: baseMint, userAta: userBaseAta } = await createFundedMint(0, unit + swapIn, base);
      const { mint: quoteMint, userAta: userQuoteAta } = await createFundedMint(0, unit, quote);
      const derived = await initializePool(baseMint, quoteMint);
      const userLpAta = await createUserLpAta(derived.lpMint);
      const handles: PoolHandles = { baseMint, quoteMint, userBaseAta, userQuoteAta, userLpAta, ...derived };

      await addLiquidity(handles, { amountBase: unit, amountQuote: unit, minLpOut: unit });

      expect(await balanceOf(handles.vaultBase)).to.equal(unit);
      expect(await balanceOf(handles.vaultQuote)).to.equal(unit);
      expect(await supplyOf(handles.lpMint)).to.equal(unit);

      const expectedOut = computeAmountOut(swapIn, unit, unit);
      expect(expectedOut > 0n).to.equal(true);

      const quoteBefore = await balanceOf(userQuoteAta);
      await swap(handles, true, swapIn, expectedOut);

      expect((await balanceOf(userQuoteAta)) - quoteBefore).to.equal(expectedOut);
      expect(await balanceOf(handles.vaultBase)).to.equal(unit + swapIn);
      expect(await balanceOf(handles.vaultQuote)).to.equal(unit - expectedOut);
    });
  });

  describe("round trip", () => {
    it("ends with strictly less base by exactly the mirror-simulated deficit", async () => {
      const rBase = 50_000_000n;
      const rQuote = 80_000_000n;
      const amountIn = 5_000_000n;
      const { handles } = await setupPool(rBase, rQuote, amountIn, 0n);

      const baseStart = await balanceOf(handles.userBaseAta);

      const outQuote = computeAmountOut(amountIn, rBase, rQuote);
      await swap(handles, true, amountIn, outQuote);

      const quoteHeld = await balanceOf(handles.userQuoteAta);
      expect(quoteHeld).to.equal(outQuote);

      const backOut = computeAmountOut(quoteHeld, rQuote - outQuote, rBase + amountIn);
      expect(backOut < amountIn, "round trip must lose value").to.equal(true);

      await swap(handles, false, quoteHeld, backOut);

      expect(await balanceOf(handles.userBaseAta)).to.equal(baseStart - (amountIn - backOut));
      expect(await balanceOf(handles.userQuoteAta)).to.equal(0n);
    });
  });

  describe("amount and liquidity guards", () => {
    it("rejects a zero amount_base deposit with ZeroAmount", async () => {
      const { handles } = await setupPool(1_000_000n, 1_000_000n, 0n, 1_000_000n);
      const err = await expectFailure(
        addLiquidity(handles, { amountBase: 0n, amountQuote: 1_000_000n, minLpOut: 0n }),
      );
      expectAnchorError(err, ERR_ZERO_AMOUNT);
    });

    it("rejects a zero lp_amount withdrawal with ZeroAmount", async () => {
      const { handles } = await setupPool(1_000_000n, 1_000_000n);
      const err = await expectFailure(
        removeLiquidity(handles, { lpAmount: 0n, minBaseOut: 0n, minQuoteOut: 0n }),
      );
      expectAnchorError(err, ERR_ZERO_AMOUNT);
    });

    it("rejects a zero amount_in swap with ZeroAmount", async () => {
      const { handles } = await setupPool(1_000_000n, 1_000_000n);
      const err = await expectFailure(swap(handles, true, 0n, 0n));
      expectAnchorError(err, ERR_ZERO_AMOUNT);
    });

    it("rejects a swap against an empty pool with InsufficientLiquidity", async () => {
      const handles = await setupEmptyPool();
      const err = await expectFailure(swap(handles, true, 1_000_000n, 0n));
      expectAnchorError(err, ERR_INSUFFICIENT_LIQUIDITY);
    });
  });
});
