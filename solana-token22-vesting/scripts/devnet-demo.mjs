// Recreates the demo assets on devnet: a fresh Token-2022 mint and one
// funded, revocable schedule. Run it, then watch the addresses it prints.
//
// Usage: yarn node scripts/devnet-demo.mjs
//
// Requires wallet/devnet-payer.json (scripts/setup-wallet.sh) with devnet
// SOL. Fails loud on any missing precondition; no fallbacks.

import { readFileSync } from "node:fs";
import { createHash, webcrypto } from "node:crypto";

// Node 18 has no global webcrypto and @solana/web3.js 1.95 (noble ed25519)
// needs it; polyfill before the web3.js import below.
if (!globalThis.crypto) {
  globalThis.crypto = webcrypto;
}

import * as web3 from "@solana/web3.js";
import * as spl from "@solana/spl-token";

const PROGRAM_ID = new web3.PublicKey("A8MoJRBGw2k9MEgK9wzxjtVgpRfYLKQD6UuF9weSAdoF");
const TOKEN2022 = spl.TOKEN_2022_PROGRAM_ID;
const ATA_PROGRAM = spl.ASSOCIATED_TOKEN_PROGRAM_ID;
const DECIMALS = 6;
const CONNECTION = new web3.Connection(
  process.env.DEVNET_RPC_URL ?? "https://api.devnet.solana.com",
  "confirmed"
);

function die(message) {
  console.error("error: " + message);
  process.exit(1);
}

function loadPayer() {
  try {
    const raw = JSON.parse(readFileSync("wallet/devnet-payer.json", "utf8"));
    return web3.Keypair.fromSecretKey(Uint8Array.from(raw));
  } catch {
    die("wallet/devnet-payer.json missing or unreadable; run: bash scripts/setup-wallet.sh");
  }
}

function discriminator(name) {
  return createHash("sha256").update("global:" + name).digest().slice(0, 8);
}

function u64(value) {
  const buf = Buffer.alloc(8);
  buf.writeBigUInt64LE(BigInt(value));
  return buf;
}

function i64(value) {
  const buf = Buffer.alloc(8);
  buf.writeBigInt64LE(BigInt(value));
  return buf;
}

function u32(value) {
  const buf = Buffer.alloc(4);
  buf.writeUInt32LE(value);
  return buf;
}

function vestingPda(beneficiary, index) {
  return web3.PublicKey.findProgramAddressSync(
    [Buffer.from("vesting"), beneficiary.toBuffer(), u32(index)],
    PROGRAM_ID
  )[0];
}

function registryPda(beneficiary) {
  return web3.PublicKey.findProgramAddressSync(
    [Buffer.from("registry"), beneficiary.toBuffer()],
    PROGRAM_ID
  )[0];
}

function vaultAta(vesting, mint) {
  return spl.getAssociatedTokenAddressSync(mint, vesting, true, TOKEN2022, ATA_PROGRAM);
}

const payer = loadPayer();
console.log("payer: " + payer.publicKey.toString());

const balance = await CONNECTION.getBalance(payer.publicKey);
console.log("payer balance: " + balance / web3.LAMPORTS_PER_SOL + " SOL");
if (balance < 0.05 * web3.LAMPORTS_PER_SOL) {
  die("payer needs devnet SOL: solana airdrop 2 " + payer.publicKey.toString() + " --url devnet");
}

// 1. fresh Token-2022 mint, payer as authority
const mint = web3.Keypair.generate();
const mintSpace = spl.MINT_SIZE;
const mintLamports = await CONNECTION.getMinimumBalanceForRentExemption(mintSpace);
const payerAta = spl.getAssociatedTokenAddressSync(mint.publicKey, payer.publicKey, false, TOKEN2022, ATA_PROGRAM);
const supply = 1000n * 10n ** BigInt(DECIMALS);

let tx = new web3.Transaction();
tx.add(
  web3.SystemProgram.createAccount({
    fromPubkey: payer.publicKey,
    newAccountPubkey: mint.publicKey,
    space: mintSpace,
    lamports: mintLamports,
    programId: TOKEN2022,
  }),
  spl.createInitializeMint2Instruction(mint.publicKey, DECIMALS, payer.publicKey, payer.publicKey, TOKEN2022),
  spl.createAssociatedTokenAccountInstruction(payer.publicKey, payerAta, payer.publicKey, mint.publicKey, ATA_PROGRAM, TOKEN2022),
  spl.createMintToInstruction(mint.publicKey, payerAta, payer.publicKey, supply, [], TOKEN2022)
);
tx.feePayer = payer.publicKey;
tx.recentBlockhash = (await CONNECTION.getLatestBlockhash("confirmed")).blockhash;
tx.sign(payer, mint);
let sig = await web3.sendAndConfirmTransaction(CONNECTION, tx, [payer, mint]);
console.log("mint created: " + mint.publicKey.toString());
console.log("  tx https://explorer.solana.com/tx/" + sig + "?cluster=devnet");

// 2. one revocable schedule, beneficiary = payer so the operator can claim
//    from the frontend right away
const slot = await CONNECTION.getSlot("confirmed");
const now = await CONNECTION.getBlockTime(slot);
const start = now - 2;
const cliff = now + 2 * 60;
const maturity = now + 10 * 60;
const amount = 100n * 10n ** BigInt(DECIMALS);

const registry = registryPda(payer.publicKey);
const registryInfo = await CONNECTION.getAccountInfo(registry);
const scheduleIdx = registryInfo
  ? new DataView(registryInfo.data.buffer, registryInfo.data.byteOffset).getUint32(8 + 32, true)
  : 0;
const vesting = vestingPda(payer.publicKey, scheduleIdx);
const vault = vaultAta(vesting, mint.publicKey);

const data = Buffer.concat([
  discriminator("create_schedule"),
  u64(amount),
  i64(start),
  i64(cliff),
  i64(maturity),
  u32(scheduleIdx),
  Buffer.from([1]), // revocable
]);

const ix = new web3.TransactionInstruction({
  programId: PROGRAM_ID,
  keys: [
    { pubkey: payer.publicKey, isSigner: true, isWritable: true },
    { pubkey: payer.publicKey, isSigner: false, isWritable: false }, // beneficiary
    { pubkey: registry, isSigner: false, isWritable: true },
    { pubkey: vesting, isSigner: false, isWritable: true },
    { pubkey: vault, isSigner: false, isWritable: true },
    { pubkey: payerAta, isSigner: false, isWritable: true }, // source
    { pubkey: mint.publicKey, isSigner: false, isWritable: false },
    { pubkey: TOKEN2022, isSigner: false, isWritable: false },
    { pubkey: ATA_PROGRAM, isSigner: false, isWritable: false },
    { pubkey: web3.SystemProgram.programId, isSigner: false, isWritable: false },
  ],
  data,
});

tx = new web3.Transaction().add(ix);
tx.feePayer = payer.publicKey;
tx.recentBlockhash = (await CONNECTION.getLatestBlockhash("confirmed")).blockhash;
sig = await web3.sendAndConfirmTransaction(CONNECTION, tx, [payer]);
console.log("schedule #" + scheduleIdx + " created: " + vesting.toString());
console.log("  vault: " + vault.toString());
console.log("  amount: 100 tokens, cliff in 2 min, maturity in 10 min, revocable");
console.log("  tx https://explorer.solana.com/tx/" + sig + "?cluster=devnet");
console.log("claim it at https://alex1997654.github.io/solana-token22-vesting/ with the payer wallet");
