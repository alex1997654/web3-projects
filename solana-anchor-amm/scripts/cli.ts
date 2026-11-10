import fs from "node:fs";
import path from "node:path";
import {
  ASSOCIATED_TOKEN_PROGRAM_ID, TOKEN_PROGRAM_ID,
  createAssociatedTokenAccountIdempotentInstruction, createAssociatedTokenAccountInstruction,
  createMint, getAccount, getAssociatedTokenAddressSync, getMint, getOrCreateAssociatedTokenAccount, mintTo,
} from "@solana/spl-token";
import { AnchorProvider, BN, Program, Wallet, setProvider } from "@coral-xyz/anchor";
import { Connection, Keypair, PublicKey, SystemProgram, Transaction } from "@solana/web3.js";
import type { Amm } from "../target/types/amm";

const IDL = JSON.parse(
  fs.readFileSync(path.join(__dirname, "../target/idl/amm.json"), "utf8"),
) as unknown as Amm;
import { U64_MAX, computeAmountOut, computeLpMint } from "./lib/math";

const DEVNET_RPC = "https://api.devnet.solana.com";
const LOCALNET_RPC = "http://127.0.0.1:8899";
const DEMO_MINT_DECIMALS = 6;
const DEMO_FIRST_LIQUIDITY = 1_000_000n;
const RATIO_SCALE = 6;

type Ctx = ReturnType<typeof makeCtx>;

function fail(msg: string): never {
  console.error(`error: ${msg}`);
  process.exit(1);
}

const USAGE =
  "usage: cli.ts [--wallet <keypair.json>] [--cluster localnet|devnet] <command> [args]\n" +
  "env: AMM_WALLET=keypair path (or --wallet), AMM_RPC=rpc url override; amounts are raw integer units\n" +
  "commands: create-mints <initialSupplyEach> | init-pool <baseMint> <quoteMint> | " +
  "add-liquidity <baseMint> <quoteMint> <amountBase> <amountQuote> [minLpOut=0] | " +
  "swap <baseMint> <quoteMint> <base-in|quote-in> <amountIn> [minOut=0] | " +
  "pool <baseMint> <quoteMint> | demo <baseMint> <quoteMint> <amountIn>";

function parseAmount(label: string, raw: string): bigint {
  if (!/^\d+$/.test(raw)) fail(`${label} must be a non-negative integer in raw units, got "${raw}"`);
  const x = BigInt(raw);
  if (x > U64_MAX) fail(`${label} exceeds u64 range`);
  return x;
}

function parsePubkey(raw: string): PublicKey {
  try {
    return new PublicKey(raw);
  } catch {
    fail(`invalid pubkey "${raw}"`);
  }
}

function loadWallet(path: string): Keypair {
  if (!fs.existsSync(path)) fail(`wallet keypair not found: ${path} (set AMM_WALLET or pass --wallet)`);
  try {
    return Keypair.fromSecretKey(new Uint8Array(JSON.parse(fs.readFileSync(path, "utf8"))));
  } catch (e) {
    fail(`wallet keypair at ${path} is not valid keypair json: ${e instanceof Error ? e.message : String(e)}`);
  }
}

function makeCtx(cluster: string, walletPath: string) {
  const endpoint = process.env.AMM_RPC ?? (cluster === "devnet" ? DEVNET_RPC : LOCALNET_RPC);
  const payer = loadWallet(walletPath);
  const connection = new Connection(endpoint, { commitment: "confirmed" });
  const provider = new AnchorProvider(connection, new Wallet(payer), { commitment: "confirmed" });
  setProvider(provider);
  const program = new Program<Amm>(IDL, provider);
  return { connection, payer, program };
}

function derivePair(programId: PublicKey, base: PublicKey, quote: PublicKey) {
  const [pool] = PublicKey.findProgramAddressSync(
    [Buffer.from("pool"), base.toBuffer(), quote.toBuffer()],
    programId,
  );
  const [lpMint] = PublicKey.findProgramAddressSync([Buffer.from("lp_mint"), pool.toBuffer()], programId);
  const vaultBase = getAssociatedTokenAddressSync(base, pool, true);
  const vaultQuote = getAssociatedTokenAddressSync(quote, pool, true);
  return {
    pool, lpMint, vaultBase, vaultQuote,
  };
}

async function ensureAtas(ctx: Ctx, mints: PublicKey[]): Promise<void> {
  const owner = ctx.payer.publicKey;
  const missing: { mint: PublicKey; ataAddr: PublicKey }[] = [];
  for (const mint of mints) {
    const ataAddr = getAssociatedTokenAddressSync(mint, owner, true);
    if ((await ctx.connection.getAccountInfo(ataAddr)) === null) missing.push({ mint, ataAddr });
  }
  if (missing.length === 0) return;
  const sig = await ctx.connection.sendTransaction(
    new Transaction().add(
      ...missing.map((m) => createAssociatedTokenAccountIdempotentInstruction(owner, m.ataAddr, owner, m.mint)),
    ),
    [ctx.payer],
  );
  await ctx.connection.confirmTransaction(sig, "confirmed");
  console.log(`tx (create atas for ${missing.map((m) => m.mint.toBase58()).join(", ")}): ${sig}`);
}

async function loadPair(ctx: Ctx, base: PublicKey, quote: PublicKey) {
  const accs = derivePair(ctx.program.programId, base, quote);
  if ((await ctx.program.account.pool.fetchNullable(accs.pool)) === null) {
    fail(`pool ${accs.pool.toBase58()} is not initialized; run init-pool first`);
  }
  return {
    accs,
    rBase: (await getAccount(ctx.connection, accs.vaultBase)).amount,
    rQuote: (await getAccount(ctx.connection, accs.vaultQuote)).amount,
    lpSupply: (await getMint(ctx.connection, accs.lpMint)).supply,
  };
}

function formatRatio(num: bigint, den: bigint): string {
  if (den === 0n) return "undefined (denominator reserve is 0)";
  const s = ((num * 10n ** BigInt(RATIO_SCALE)) / den).toString().padStart(RATIO_SCALE + 1, "0");
  return `${s.slice(0, -RATIO_SCALE)}.${s.slice(-RATIO_SCALE)}`;
}

async function cmdCreateMints(ctx: Ctx, initialSupplyEach: bigint): Promise<void> {
  const { connection, payer } = ctx;
  const mintA = Keypair.generate();
  const mintB = Keypair.generate();
  for (const mint of [mintA, mintB]) {
    const sig = await createMint(connection, payer, payer.publicKey, null, DEMO_MINT_DECIMALS, mint);
    console.log(`tx (create mint): ${sig}`);
  }
  const [base, quote] = [mintA.publicKey, mintB.publicKey].sort((a, b) =>
    Buffer.compare(a.toBuffer(), b.toBuffer()),
  );
  for (const mint of [base, quote]) {
    const mintAta = getAssociatedTokenAddressSync(mint, payer.publicKey, true);
    const tx = new Transaction().add(
      createAssociatedTokenAccountInstruction(payer.publicKey, mintAta, payer.publicKey, mint),
    );
    const sig = await connection.sendTransaction(tx, [payer]);
    await connection.confirmTransaction(sig, "confirmed");
    console.log(`tx (create ata): ${sig}`);
    const sig2 = await mintTo(connection, payer, mint, mintAta, payer.publicKey, initialSupplyEach);
    console.log(`tx (mint ${initialSupplyEach} to ${mintAta.toBase58()}): ${sig2}`);
  }
  console.log(`base mint: ${base.toBase58()}`);
  console.log(`quote mint: ${quote.toBase58()}`);
}

async function cmdInitPool(ctx: Ctx, baseRaw: string, quoteRaw: string): Promise<void> {
  const base = parsePubkey(baseRaw);
  const quote = parsePubkey(quoteRaw);
  if (Buffer.compare(base.toBuffer(), quote.toBuffer()) >= 0) {
    fail(`pair not canonical: base mint must sort before quote mint (base ${base.toBase58()}, quote ${quote.toBase58()})`);
  }
  const accs = derivePair(ctx.program.programId, base, quote);
  await getOrCreateAssociatedTokenAccount(ctx.connection, ctx.payer, base, accs.pool, true);
  await getOrCreateAssociatedTokenAccount(ctx.connection, ctx.payer, quote, accs.pool, true);
  const sig = await ctx.program.methods.initializePool().accounts({
    baseMint: base, quoteMint: quote, payer: ctx.payer.publicKey,
  }).rpc();
  console.log(`tx: ${sig}`);
  console.log(`pool: ${accs.pool.toBase58()}`);
  console.log(`lp mint: ${accs.lpMint.toBase58()}`);
}

async function cmdAddLiquidity(
  ctx: Ctx, base: PublicKey, quote: PublicKey,
  amountBase: bigint, amountQuote: bigint, minLpOut: bigint,
): Promise<void> {
  const state = await loadPair(ctx, base, quote);
  const owner = ctx.payer.publicKey;
  console.log(`expected lp mint (local mirror): ${computeLpMint(amountBase, amountQuote, state.rBase, state.rQuote, state.lpSupply)}`);
  await ensureAtas(ctx, [base, quote, state.accs.lpMint]);
  const userBaseAta = getAssociatedTokenAddressSync(base, owner, true);
  const userQuoteAta = getAssociatedTokenAddressSync(quote, owner, true);
  const userLpAta = getAssociatedTokenAddressSync(state.accs.lpMint, owner, true);
  const lpBefore = (await getAccount(ctx.connection, userLpAta)).amount;
  const sig = await ctx.program.methods.addLiquidity({
    amountBase: new BN(amountBase.toString(10), 10), amountQuote: new BN(amountQuote.toString(10), 10),
    minLpOut: new BN(minLpOut.toString(10), 10),
  }).accounts({
    baseMint: base, quoteMint: quote, user: owner,
  }).rpc();
  console.log(`tx: ${sig}`);
  const lpAfter = (await getAccount(ctx.connection, userLpAta)).amount;
  console.log(`lp minted: ${lpAfter - lpBefore}, lp balance: ${lpAfter}`);
}

async function doSwap(
  ctx: Ctx, base: PublicKey, quote: PublicKey,
  isBaseIn: boolean, amountIn: bigint, minOut: bigint,
): Promise<{ expectedOut: bigint; actualOut: bigint }> {
  const state = await loadPair(ctx, base, quote);
  const expectedOut = computeAmountOut(amountIn,
    isBaseIn ? state.rBase : state.rQuote,
    isBaseIn ? state.rQuote : state.rBase);
  console.log(`expected out (local mirror): ${expectedOut}`);
  const owner = ctx.payer.publicKey;
  await ensureAtas(ctx, [base, quote]);
  const userBaseAta = getAssociatedTokenAddressSync(base, owner, true);
  const userQuoteAta = getAssociatedTokenAddressSync(quote, owner, true);
  const outAta = isBaseIn ? userQuoteAta : userBaseAta;
  const outBefore = (await getAccount(ctx.connection, outAta)).amount;
  const sig = await ctx.program.methods.swap({
    isBaseIn, amountIn: new BN(amountIn.toString(10), 10), minOut: new BN(minOut.toString(10), 10),
  }).accounts({
    baseMint: base, quoteMint: quote, user: owner,
  }).rpc();
  console.log(`tx: ${sig}`);
  const actualOut = (await getAccount(ctx.connection, outAta)).amount - outBefore;
  const inAta = isBaseIn ? userBaseAta : userQuoteAta;
  console.log(`swap ${isBaseIn ? "base->quote" : "quote->base"}: in ${amountIn} (${inAta.toBase58()}), out ${actualOut}`);
  return { expectedOut, actualOut };
}

async function cmdPool(ctx: Ctx, base: PublicKey, quote: PublicKey): Promise<void> {
  const { accs, rBase, rQuote, lpSupply } = await loadPair(ctx, base, quote);
  console.log(`pool: ${accs.pool.toBase58()}`);
  console.log(`lp mint: ${accs.lpMint.toBase58()} (supply ${lpSupply})`);
  console.log(`vault base: ${accs.vaultBase.toBase58()} (reserve ${rBase})`);
  console.log(`vault quote: ${accs.vaultQuote.toBase58()} (reserve ${rQuote})`);
  console.log(`k = reserve_base * reserve_quote = ${rBase * rQuote}`);
  console.log(`price base->quote (quote per base, ${RATIO_SCALE}dp): ${formatRatio(rQuote, rBase)}`);
  console.log(`price quote->base (base per quote, ${RATIO_SCALE}dp): ${formatRatio(rBase, rQuote)}`);
}

async function cmdDemo(ctx: Ctx, base: PublicKey, quote: PublicKey, amountIn: bigint): Promise<void> {
  const state = await loadPair(ctx, base, quote);
  if (state.lpSupply === 0n || state.rBase === 0n || state.rQuote === 0n) {
    console.log(`pool is empty; adding first liquidity (${DEMO_FIRST_LIQUIDITY} each side)`);
    await cmdAddLiquidity(ctx, base, quote, DEMO_FIRST_LIQUIDITY, DEMO_FIRST_LIQUIDITY, 0n);
  }
  const owner = ctx.payer.publicKey;
  const baseAta = getAssociatedTokenAddressSync(base, owner, true);
  const quoteAta = getAssociatedTokenAddressSync(quote, owner, true);
  const startBase = (await getAccount(ctx.connection, baseAta)).amount;
  const startQuote = (await getAccount(ctx.connection, quoteAta)).amount;
  const leg1 = await doSwap(ctx, base, quote, true, amountIn, 0n);
  if (leg1.actualOut !== leg1.expectedOut) fail(`swap out mismatch: mirror expected ${leg1.expectedOut}, actual ${leg1.actualOut}`);
  if (leg1.actualOut === 0n) fail(`first leg produced 0 quote out; nothing to swap back (raise amountIn)`);
  const leg2 = await doSwap(ctx, base, quote, false, leg1.actualOut, 0n);
  if (leg2.actualOut !== leg2.expectedOut) fail(`swap out mismatch: mirror expected ${leg2.expectedOut}, actual ${leg2.actualOut}`);
  const endBase = (await getAccount(ctx.connection, baseAta)).amount;
  const endQuote = (await getAccount(ctx.connection, quoteAta)).amount;
  console.log(`start base ${startBase}, end base ${endBase}`);
  console.log(`start quote ${startQuote}, end quote ${endQuote}`);
  console.log(`round-trip base deficit: ${startBase - endBase} (fee 0.25% each leg + floor rounding)`);
}

async function main(): Promise<void> {
  const argv = process.argv.slice(2);
  let walletPath = process.env.AMM_WALLET;
  let cluster = "devnet";
  const pos: string[] = [];
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--wallet" || a === "--cluster") {
      i += 1;
      if (i >= argv.length) fail(`${a} requires a value`);
      if (a === "--wallet") walletPath = argv[i];
      else cluster = argv[i];
    } else if (a.startsWith("--")) {
      fail(`unknown flag: ${a}`);
    } else {
      pos.push(a);
    }
  }
  if (cluster !== "devnet" && cluster !== "localnet") {
    fail(`invalid --cluster "${cluster}": expected localnet or devnet`);
  }
  if (!walletPath) fail("wallet keypair required: set AMM_WALLET or pass --wallet <path>");
  if (pos.length === 0) fail(USAGE);
  const [command, ...rest] = pos;
  const ctx = makeCtx(cluster, walletPath);
  switch (command) {
    case "create-mints":
      if (rest.length !== 1) fail("expected: create-mints <initialSupplyEach>");
      await cmdCreateMints(ctx, parseAmount("initialSupplyEach", rest[0]));
      break;
    case "init-pool":
      if (rest.length !== 2) fail("expected: init-pool <baseMint> <quoteMint>");
      await cmdInitPool(ctx, rest[0], rest[1]);
      break;
    case "add-liquidity":
      if (rest.length < 4 || rest.length > 5) {
        fail("expected: add-liquidity <baseMint> <quoteMint> <amountBase> <amountQuote> [minLpOut=0]");
      }
      await cmdAddLiquidity(ctx, parsePubkey(rest[0]), parsePubkey(rest[1]),
        parseAmount("amountBase", rest[2]), parseAmount("amountQuote", rest[3]),
        rest[4] !== undefined ? parseAmount("minLpOut", rest[4]) : 0n);
      break;
    case "swap":
      if (rest.length < 4 || rest.length > 5) {
        fail("expected: swap <baseMint> <quoteMint> <base-in|quote-in> <amountIn> [minOut=0]");
      }
      if (rest[2] !== "base-in" && rest[2] !== "quote-in") {
        fail(`direction must be "base-in" or "quote-in", got "${rest[2]}"`);
      }
      await doSwap(ctx, parsePubkey(rest[0]), parsePubkey(rest[1]), rest[2] === "base-in",
        parseAmount("amountIn", rest[3]),
        rest[4] !== undefined ? parseAmount("minOut", rest[4]) : 0n);
      break;
    case "pool":
      if (rest.length !== 2) fail("expected: pool <baseMint> <quoteMint>");
      await cmdPool(ctx, parsePubkey(rest[0]), parsePubkey(rest[1]));
      break;
    case "demo":
      if (rest.length !== 3) fail("expected: demo <baseMint> <quoteMint> <amountIn>");
      await cmdDemo(ctx, parsePubkey(rest[0]), parsePubkey(rest[1]), parseAmount("amountIn", rest[2]));
      break;
    default:
      fail(`unknown command "${command}"; usage:\n${USAGE}`);
  }
}

main().catch((e: unknown) => {
  console.error(e instanceof Error ? e.message : String(e));
  process.exit(1);
});
