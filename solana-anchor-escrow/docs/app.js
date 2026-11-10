import { Connection, PublicKey, Transaction, TransactionInstruction, SystemProgram, LAMPORTS_PER_SOL } from "https://esm.sh/@solana/web3.js@1.95.3";
import * as spl from "https://esm.sh/@solana/spl-token@0.4.9";

const RPC_URL = "https://api.devnet.solana.com";
const PROGRAM_ID = new PublicKey("9VcbzbGs9Et814sq6z7dLYaP6qPq6tffv2nHDSPqoeTo");
const TOKEN_PROGRAM = new PublicKey("TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA");
const ATA_PROGRAM = new PublicKey("ATokenGPvbdGVxr1b2SoZSioiZRfvtLVTEjfyUosPjLp");
const SYSTEM_PROGRAM = new PublicKey("11111111111111111111111111111111");

const DISC_MAKE_OFFER = "d66261233b0c2cb2";
const DISC_TAKE = "95e23468068ee627";
const DISC_TAKE_FULL = "6ff88531c31902aa";
const DISC_REFUND = "0260b7fb3fd02e2e";
// First 8 bytes of sha256("account:Escrow"), the standard anchor account
// discriminator for the Escrow struct in programs/escrow/src/state.rs.
// The RPC memcmp filter expects these bytes base58-encoded, so they are
// encoded at runtime below.
const ESCROW_ACCOUNT_DISCRIM_HEX = "1fd57bbbba16da9b";

const DEMO_MINT_AMOUNT = 1000000000000n;

const connection = new Connection(RPC_URL, "confirmed");
let provider = null;
let wallet = null;
const decimalsCache = new Map();

const $ = (id) => document.getElementById(id);

function hexBytes(hex) {
  const out = new Uint8Array(hex.length / 2);
  for (let i = 0; i < out.length; i++) out[i] = parseInt(hex.slice(i * 2, i * 2 + 2), 16);
  return out;
}

function leU64(value) {
  const out = new Uint8Array(8);
  new DataView(out.buffer).setBigUint64(0, value, true);
  return out;
}

function leI64(value) {
  const out = new Uint8Array(8);
  new DataView(out.buffer).setBigInt64(0, value, true);
  return out;
}

function u8cat(parts) {
  let total = 0;
  for (const part of parts) total += part.length;
  const out = new Uint8Array(total);
  let offset = 0;
  for (const part of parts) {
    out.set(part, offset);
    offset += part.length;
  }
  return out;
}

const BASE58 = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz";

function b58encode(bytes) {
  let num = 0n;
  for (const byte of bytes) num = num * 256n + BigInt(byte);
  let out = "";
  while (num > 0n) {
    out = BASE58[Number(num % 58n)] + out;
    num /= 58n;
  }
  for (const byte of bytes) {
    if (byte !== 0) break;
    out = "1" + out;
  }
  return out || "1";
}

function dataBytes(data) {
  if (Array.isArray(data)) data = data[0];
  if (typeof data === "string") return Uint8Array.from(atob(data), (c) => c.charCodeAt(0));
  return Uint8Array.from(data);
}

function randomU64() {
  const bytes = new Uint8Array(8);
  crypto.getRandomValues(bytes);
  return new DataView(bytes.buffer).getBigUint64(0, true);
}

function escrowAddress(maker, seed) {
  const seeds = [new TextEncoder().encode("escrow"), maker.toBytes(), leU64(seed)];
  return PublicKey.findProgramAddressSync(seeds, PROGRAM_ID)[0];
}

function vaultAddress(escrow) {
  return PublicKey.findProgramAddressSync([new TextEncoder().encode("vault"), escrow.toBytes()], PROGRAM_ID)[0];
}

function meta(pubkey, isSigner, isWritable) {
  return { pubkey, isSigner, isWritable };
}

function makeOfferIx(maker, mintA, mintB, seed, amountA, askB, expiry) {
  const makerAtaA = spl.getAssociatedTokenAddressSync(mintA, maker);
  const makerAtaB = spl.getAssociatedTokenAddressSync(mintB, maker);
  const escrow = escrowAddress(maker, seed);
  const vault = vaultAddress(escrow);
  return new TransactionInstruction({
    programId: PROGRAM_ID,
    data: u8cat([hexBytes(DISC_MAKE_OFFER), leU64(seed), leU64(amountA), leU64(askB), leI64(expiry)]),
    keys: [
      meta(maker, true, true),
      meta(mintA, false, false),
      meta(mintB, false, false),
      meta(makerAtaA, false, true),
      meta(escrow, false, true),
      meta(vault, false, true),
      meta(TOKEN_PROGRAM, false, false),
      meta(SYSTEM_PROGRAM, false, false),
    ],
  });
}

function takeIx(discriminator, taker, maker, mintA, mintB, seed, takeAmount) {
  const takerAtaA = spl.getAssociatedTokenAddressSync(mintA, taker);
  const takerAtaB = spl.getAssociatedTokenAddressSync(mintB, taker);
  const makerAtaB = spl.getAssociatedTokenAddressSync(mintB, maker);
  const escrow = escrowAddress(maker, seed);
  const vault = vaultAddress(escrow);
  const dataParts = [hexBytes(discriminator), leU64(seed)];
  if (takeAmount !== null) dataParts.push(leU64(takeAmount));
  return new TransactionInstruction({
    programId: PROGRAM_ID,
    data: u8cat(dataParts),
    keys: [
      meta(taker, true, true),
      meta(maker, false, false),
      meta(mintA, false, false),
      meta(mintB, false, false),
      meta(takerAtaB, false, true),
      meta(makerAtaB, false, true),
      meta(takerAtaA, false, true),
      meta(escrow, false, true),
      meta(vault, false, true),
      meta(TOKEN_PROGRAM, false, false),
      meta(ATA_PROGRAM, false, false),
      meta(SYSTEM_PROGRAM, false, false),
    ],
  });
}

function refundIx(maker, mintA, seed) {
  const makerAtaA = spl.getAssociatedTokenAddressSync(mintA, maker);
  const escrow = escrowAddress(maker, seed);
  const vault = vaultAddress(escrow);
  return new TransactionInstruction({
    programId: PROGRAM_ID,
    data: u8cat([hexBytes(DISC_REFUND), leU64(seed)]),
    keys: [
      meta(maker, true, true),
      meta(mintA, false, false),
      meta(makerAtaA, false, true),
      meta(escrow, false, true),
      meta(vault, false, true),
      meta(TOKEN_PROGRAM, false, false),
      meta(SYSTEM_PROGRAM, false, false),
    ],
  });
}

// Escrow account layout, little-endian, 145 bytes total:
// 0..8 anchor account discriminator, 8..40 maker, 40..48 seed,
// 48..80 mint A, 80..112 mint B, 112..120 offer_amount_a,
// 120..128 ask_amount_b, 128..136 remaining_amount_a, 136..144 expiry (i64), 144 bump.
function parseEscrow(pubkey, data) {
  if (data.length !== 145) {
    throw new Error("Escrow " + pubkey.toBase58() + ": data is " + data.length + " bytes, expected 145.");
  }
  const view = new DataView(data.buffer, data.byteOffset, data.byteLength);
  return {
    pubkey,
    maker: new PublicKey(data.slice(8, 40)),
    seed: view.getBigUint64(40, true),
    mintA: new PublicKey(data.slice(48, 80)),
    mintB: new PublicKey(data.slice(80, 112)),
    offerAmountA: view.getBigUint64(112, true),
    askAmountB: view.getBigUint64(120, true),
    remainingA: view.getBigUint64(128, true),
    expiry: view.getBigInt64(136, true),
  };
}

async function sendTx(instructions) {
  if (provider === null || wallet === null) throw new Error("Connect first.");
  const blockhash = await connection.getLatestBlockhash();
  const tx = new Transaction();
  tx.feePayer = wallet;
  tx.recentBlockhash = blockhash.blockhash;
  for (const instruction of instructions) tx.add(instruction);
  const { signature } = await provider.signAndSendTransaction(tx);
  await connection.confirmTransaction({ signature, blockhash: blockhash.blockhash, lastValidBlockHeight: blockhash.lastValidBlockHeight }, "confirmed");
  return signature;
}

function setStatus(text, isError) {
  const el = $("status-msg");
  el.textContent = text;
  el.classList.toggle("error", isError === true);
}

function setSig(signature) {
  const el = $("status-sig");
  el.textContent = "";
  const link = document.createElement("a");
  link.href = "https://explorer.solana.com/tx/" + signature + "?cluster=devnet";
  link.target = "_blank";
  link.rel = "noreferrer";
  link.title = signature;
  link.textContent = signature.slice(0, 8) + "..." + signature.slice(-8);
  el.append("tx ", link);
}

function showError(err) {
  setStatus(err && err.message ? err.message : String(err), true);
}

function guard(fn) {
  return (...args) => {
    try {
      const result = fn(...args);
      if (result && typeof result.catch === "function") result.catch(showError);
    } catch (err) {
      showError(err);
    }
  };
}

function requireWallet() {
  if (wallet === null) throw new Error("Connect first.");
  return wallet;
}

function parsePubkeyField(value, label) {
  const s = value.trim();
  if (s === "") throw new Error(label + " is required.");
  try {
    return new PublicKey(s);
  } catch {
    throw new Error(label + ": not a valid pubkey.");
  }
}

function parseBig(value, label) {
  const s = String(value).trim().replace(/_/g, "");
  if (!/^[0-9]+$/.test(s)) throw new Error(label + " must be a whole number.");
  return BigInt(s);
}

function shortAddr(addr) {
  return addr.slice(0, 4) + "..." + addr.slice(-4);
}

function fmtAmount(raw, decimals) {
  if (decimals === 0) return raw.toString();
  const scale = 10n ** BigInt(decimals);
  const whole = raw / scale;
  const frac = (raw % scale).toString().padStart(decimals, "0").replace(/0+$/, "");
  return frac === "" ? whole.toString() : whole.toString() + "." + frac;
}

function fmtDiv(num, den, fracDigits) {
  if (den === 0n) throw new Error("Division by zero.");
  let out = (num / den).toString();
  let rem = num % den;
  if (rem === 0n) return out;
  let digits = "";
  for (let i = 0; i < fracDigits; i++) {
    rem *= 10n;
    digits += (rem / den).toString();
    rem %= den;
  }
  digits = digits.replace(/0+$/, "");
  if (digits !== "") out += "." + digits;
  return out;
}

function fmtDate(unixSeconds) {
  return new Date(Number(unixSeconds) * 1000).toISOString().slice(0, 16).replace("T", " ") + " UTC";
}

async function decimalsOf(mint) {
  const key = mint.toBase58();
  if (decimalsCache.has(key)) return decimalsCache.get(key);
  const mintInfo = await spl.getMint(connection, mint);
  decimalsCache.set(key, mintInfo.decimals);
  return mintInfo.decimals;
}

async function onConnect() {
  const p = window.phantom?.solana ?? window.solana;
  if (!p) throw new Error("Phantom not found");
  const resp = await p.connect();
  provider = p;
  wallet = new PublicKey(resp.publicKey);
  const lamports = await connection.getBalance(wallet);
  const btn = $("connect-btn");
  btn.textContent = shortAddr(wallet.toBase58());
  btn.title = wallet.toBase58();
  btn.disabled = true;
  $("wallet-info").textContent = fmtAmount(BigInt(lamports), 9) + " SOL";
  setStatus("Connected.");
  await Promise.all([refreshOffers(), refreshBalances()]);
}

function copyButton(text) {
  const btn = document.createElement("button");
  btn.type = "button";
  btn.className = "small";
  btn.textContent = "Copy";
  btn.addEventListener("click", guard(async () => {
    await navigator.clipboard.writeText(text);
    setStatus("Copied.");
  }));
  return btn;
}

function mintRow(label, mint) {
  const row = document.createElement("div");
  row.className = "mint-row";
  const name = document.createElement("span");
  name.textContent = label;
  const addr = document.createElement("span");
  addr.className = "mono";
  addr.textContent = mint.toBase58();
  row.append(name, addr, copyButton(mint.toBase58()));
  return row;
}

async function onCreateDemo() {
  const payer = requireWallet();
  setStatus("Creating mints...");
  const seedA = "demo-a-" + randomU64().toString(16).padStart(16, "0");
  const seedB = "demo-b-" + randomU64().toString(16).padStart(16, "0");
  const mintA = await PublicKey.createWithSeed(payer, seedA, TOKEN_PROGRAM);
  const mintB = await PublicKey.createWithSeed(payer, seedB, TOKEN_PROGRAM);
  const rent = await connection.getMinimumBalanceForRentExemption(spl.MINT_SIZE);
  await sendTx([
    SystemProgram.createAccountWithSeed({ fromPubkey: payer, basePubkey: payer, seed: seedA, newAccountPubkey: mintA, lamports: rent, space: spl.MINT_SIZE, programId: TOKEN_PROGRAM }),
    spl.createInitializeMint2Instruction(mintA, 6, payer, null),
    SystemProgram.createAccountWithSeed({ fromPubkey: payer, basePubkey: payer, seed: seedB, newAccountPubkey: mintB, lamports: rent, space: spl.MINT_SIZE, programId: TOKEN_PROGRAM }),
    spl.createInitializeMint2Instruction(mintB, 9, payer, null),
  ]);
  setStatus("Minting tokens...");
  const ataA = spl.getAssociatedTokenAddressSync(mintA, payer);
  const ataB = spl.getAssociatedTokenAddressSync(mintB, payer);
  const instructions = [];
  if ((await connection.getAccountInfo(ataA)) === null) {
    instructions.push(spl.createAssociatedTokenAccountInstruction(payer, ataA, payer, mintA));
  }
  if ((await connection.getAccountInfo(ataB)) === null) {
    instructions.push(spl.createAssociatedTokenAccountInstruction(payer, ataB, payer, mintB));
  }
  instructions.push(spl.createMintToInstruction(mintA, ataA, payer, DEMO_MINT_AMOUNT, 6));
  instructions.push(spl.createMintToInstruction(mintB, ataB, payer, DEMO_MINT_AMOUNT, 9));
  const signature = await sendTx(instructions);
  $("mint-a").value = mintA.toBase58();
  $("mint-b").value = mintB.toBase58();
  const out = $("demo-out");
  out.textContent = "";
  out.append(mintRow("Mint A", mintA), mintRow("Mint B", mintB));
  setSig(signature);
  setStatus("Demo tokens created.");
  await Promise.all([updatePriceLine(), refreshBalances(), refreshOffers()]);
}

async function updatePriceLine() {
  const el = $("price-line");
  const aStr = $("amount-a").value.trim().replace(/_/g, "");
  const bStr = $("ask-b").value.trim().replace(/_/g, "");
  if ($("mint-a").value.trim() === "" || $("mint-b").value.trim() === "" || !/^[0-9]+$/.test(aStr) || !/^[0-9]+$/.test(bStr)) {
    el.textContent = "Price: fill mints and raw amounts to see the rate.";
    return;
  }
  const mintA = new PublicKey($("mint-a").value.trim());
  const mintB = new PublicKey($("mint-b").value.trim());
  const amountA = BigInt(aStr);
  const askB = BigInt(bStr);
  if (amountA === 0n) {
    el.textContent = "Price: amount A must be greater than 0.";
    return;
  }
  const decA = await decimalsOf(mintA);
  const decB = await decimalsOf(mintB);
  el.textContent = "Price: " + fmtDiv(askB * 10n ** BigInt(decA), amountA * 10n ** BigInt(decB), 9) + " B per 1 A";
}

async function renderBalanceLine(el, value, label) {
  const s = value.trim();
  if (s === "") {
    el.textContent = "Mint " + label + ": not set.";
    return;
  }
  let mint;
  try {
    mint = new PublicKey(s);
  } catch {
    el.textContent = "Mint " + label + ": not a valid pubkey.";
    return;
  }
  const decimals = await decimalsOf(mint);
  const ata = spl.getAssociatedTokenAddressSync(mint, wallet);
  const info = await connection.getAccountInfo(ata);
  if (info === null) {
    el.textContent = "Mint " + label + ": no token account.";
    return;
  }
  const account = await spl.getAccount(connection, ata);
  el.textContent = "Mint " + label + ": " + account.amount.toString() + " raw = " + fmtAmount(account.amount, decimals) + " UI";
}

async function refreshBalances() {
  if (wallet === null) {
    $("bal-a").textContent = "Not connected.";
    $("bal-b").textContent = "";
    return;
  }
  await renderBalanceLine($("bal-a"), $("mint-a").value, "A");
  await renderBalanceLine($("bal-b"), $("mint-b").value, "B");
}

async function refreshOffers() {
  const accounts = await connection.getProgramAccounts(PROGRAM_ID, {
    encoding: "base64",
    filters: [{ memcmp: { offset: 0, bytes: b58encode(hexBytes(ESCROW_ACCOUNT_DISCRIM_HEX)) } }],
  });
  const rows = accounts.map((entry) => parseEscrow(entry.pubkey, dataBytes(entry.account.data)));
  rows.sort((a, b) => (a.seed < b.seed ? -1 : a.seed > b.seed ? 1 : 0));
  const ratePairs = await Promise.all(rows.map(async (row) => [
    row.pubkey.toBase58(),
    { decA: await decimalsOf(row.mintA), decB: await decimalsOf(row.mintB) },
  ]));
  renderOffers(rows, new Map(ratePairs));
}

function cell(tr, text, title) {
  const td = document.createElement("td");
  td.textContent = text;
  if (title !== undefined) td.title = title;
  tr.appendChild(td);
}

function renderOffers(rows, rates) {
  const body = $("offers-body");
  body.textContent = "";
  const empty = $("offers-empty");
  if (rows.length === 0) {
    empty.textContent = "No open offers.";
    empty.hidden = false;
    return;
  }
  empty.hidden = true;
  for (const row of rows) {
    const rate = rates.get(row.pubkey.toBase58());
    const tr = document.createElement("tr");
    cell(tr, shortAddr(row.maker.toBase58()), row.maker.toBase58());
    cell(tr, shortAddr(row.mintA.toBase58()), row.mintA.toBase58());
    cell(tr, shortAddr(row.mintB.toBase58()), row.mintB.toBase58());
    cell(tr, row.remainingA.toString());
    cell(tr, row.askAmountB.toString());
    cell(tr, fmtDiv(row.askAmountB * 10n ** BigInt(rate.decA), row.offerAmountA * 10n ** BigInt(rate.decB), 6) + " B/A");
    cell(tr, row.expiry === 0n ? "never" : fmtDate(row.expiry));
    const takeTd = document.createElement("td");
    const wrap = document.createElement("div");
    wrap.className = "take-cell";
    const input = document.createElement("input");
    input.type = "text";
    input.inputMode = "numeric";
    input.value = row.remainingA.toString();
    const takeBtn = document.createElement("button");
    takeBtn.type = "button";
    takeBtn.textContent = "Take";
    const cancelBtn = document.createElement("button");
    cancelBtn.type = "button";
    cancelBtn.textContent = "Cancel";
    cancelBtn.disabled = wallet === null || row.maker.toBase58() !== wallet.toBase58();
    const hint = document.createElement("span");
    hint.className = "hint";
    const updateHint = () => {
      const s = input.value.trim().replace(/_/g, "");
      if (!/^[0-9]+$/.test(s) || BigInt(s) === 0n) {
        hint.textContent = "";
        return;
      }
      const taken = BigInt(s);
      const full = taken >= row.remainingA;
      const amount = full ? row.remainingA : taken;
      const owed = (amount * row.askAmountB + row.offerAmountA - 1n) / row.offerAmountA;
      hint.textContent = (full ? "full take, " : "") + "you pay " + fmtAmount(owed, rate.decB) + " B";
    };
    input.addEventListener("input", updateHint);
    updateHint();
    takeBtn.addEventListener("click", guard(() => doTake(row, input)));
    cancelBtn.addEventListener("click", guard(() => doRefund(row)));
    wrap.append(input, takeBtn, cancelBtn, hint);
    takeTd.appendChild(wrap);
    tr.appendChild(takeTd);
    body.appendChild(tr);
  }
}

async function doTake(row, input) {
  const taker = requireWallet();
  const taken = parseBig(input.value, "Take amount");
  if (taken === 0n) throw new Error("Take amount must be greater than 0.");
  let signature;
  if (taken >= row.remainingA) {
    signature = await sendTx([takeIx(DISC_TAKE_FULL, taker, row.maker, row.mintA, row.mintB, row.seed, null)]);
    setStatus("Offer fully taken. Escrow closed.");
  } else {
    signature = await sendTx([takeIx(DISC_TAKE, taker, row.maker, row.mintA, row.mintB, row.seed, taken)]);
    setStatus("Offer partially taken.");
  }
  setSig(signature);
  await Promise.all([refreshOffers(), refreshBalances()]);
}

async function doRefund(row) {
  const maker = requireWallet();
  if (row.maker.toBase58() !== maker.toBase58()) throw new Error("Only the maker can refund this offer.");
  const signature = await sendTx([refundIx(maker, row.mintA, row.seed)]);
  setSig(signature);
  setStatus("Refunded. Escrow closed.");
  await Promise.all([refreshOffers(), refreshBalances()]);
}

async function onPostOffer() {
  const maker = requireWallet();
  const mintA = parsePubkeyField($("mint-a").value, "Mint A");
  const mintB = parsePubkeyField($("mint-b").value, "Mint B");
  const amountA = parseBig($("amount-a").value, "Amount A");
  const askB = parseBig($("ask-b").value, "Ask B");
  if (amountA === 0n) throw new Error("Amount A must be greater than 0.");
  if (askB === 0n) throw new Error("Ask B must be greater than 0.");
  const seed = parseBig($("seed").value, "Seed");
  const minutesStr = $("expiry-min").value.trim();
  let expiry = 0n;
  if (minutesStr !== "" && minutesStr !== "0") {
    const nowSeconds = BigInt(Math.floor(Date.now() / 1000));
    expiry = nowSeconds + parseBig(minutesStr, "Expiry") * 60n;
    if (expiry > 9223372036854775807n) throw new Error("Expiry is too far in the future.");
  }
  // The program does not create the maker's token accounts, so both ATAs
  // must exist before the offer is posted.
  const setup = [];
  for (const mint of [mintA, mintB]) {
    const ata = spl.getAssociatedTokenAddressSync(mint, maker);
    const info = await connection.getAccountInfo(ata);
    if (info === null) {
      setup.push(spl.createAssociatedTokenAccountInstruction(maker, ata, maker, mint));
    }
  }
  const signature = await sendTx([...setup, makeOfferIx(maker, mintA, mintB, seed, amountA, askB, expiry)]);
  setSig(signature);
  setStatus("Offer posted.");
  $("seed").value = randomU64().toString();
  await Promise.all([refreshOffers(), refreshBalances()]);
}

$("connect-btn").addEventListener("click", guard(onConnect));
$("create-tokens").addEventListener("click", guard(onCreateDemo));
$("post-offer").addEventListener("click", guard(onPostOffer));
$("refresh-offers").addEventListener("click", guard(async () => {
  await refreshOffers();
  setStatus("Offers refreshed.");
}));
$("seed-new").addEventListener("click", guard(() => {
  $("seed").value = randomU64().toString();
}));
for (const id of ["mint-a", "mint-b"]) {
  $(id).addEventListener("change", guard(async () => {
    await Promise.all([updatePriceLine(), refreshBalances()]);
  }));
}
for (const id of ["amount-a", "ask-b"]) {
  $(id).addEventListener("change", guard(updatePriceLine));
}
$("seed").value = randomU64().toString();