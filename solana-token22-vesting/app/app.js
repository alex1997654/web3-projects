// Token-2022 vesting demo client. No build step, no backend, no keypair
// handling: every signature comes from the connected Phantom wallet.
// Instruction data is encoded by hand (small borsh payloads) so the page
// needs nothing but web3.js and spl-token from a CDN.

import * as web3 from "https://esm.sh/@solana/web3.js@1.95.4";
import * as spl from "https://esm.sh/@solana/spl-token@0.4.6?deps=@solana/web3.js@1.95.4";

const PROGRAM_ID = new web3.PublicKey("A8MoJRBGw2k9MEgK9wzxjtVgpRfYLKQD6UuF9weSAdoF");
const TOKEN2022 = spl.TOKEN_2022_PROGRAM_ID;
const ATA_PROGRAM = spl.ASSOCIATED_TOKEN_PROGRAM_ID;
const DECIMALS = 6;
const RPC_URL = "https://api.devnet.solana.com";

const connection = new web3.Connection(RPC_URL, "confirmed");

const els = {
  connect: document.getElementById("connect"),
  wallet: document.getElementById("wallet"),
  actions: document.getElementById("actions"),
  createMint: document.getElementById("create-mint"),
  mintAddress: document.getElementById("mint-address"),
  createSchedule: document.getElementById("create-schedule"),
  beneficiary: document.getElementById("beneficiary"),
  amount: document.getElementById("amount"),
  cliffMin: document.getElementById("cliff-min"),
  maturityMin: document.getElementById("maturity-min"),
  revocable: document.getElementById("revocable"),
  refresh: document.getElementById("refresh"),
  schedules: document.getElementById("schedules"),
  log: document.getElementById("log"),
};

function log(line) {
  const stamp = new Date().toISOString().slice(11, 19);
  els.log.textContent = "[" + stamp + "] " + line + "\n" + els.log.textContent;
}

function short(key) {
  const s = key.toString();
  return s.slice(0, 6) + "..." + s.slice(-4);
}

function explorerTx(sig) {
  return "https://explorer.solana.com/tx/" + sig + "?cluster=devnet";
}

function getProvider() {
  const p = window.phantom && window.phantom.solana;
  if (!p || !p.isPhantom) {
    throw new Error("Phantom not found. Install it, then reload.");
  }
  return p;
}

async function discriminator(name) {
  const bytes = new TextEncoder().encode("global:" + name);
  const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", bytes));
  return digest.slice(0, 8);
}

function u64Buffer(value) {
  const buf = new ArrayBuffer(8);
  new DataView(buf).setBigUint64(0, BigInt(value), true);
  return new Uint8Array(buf);
}

function i64Buffer(value) {
  const buf = new ArrayBuffer(8);
  new DataView(buf).setBigInt64(0, BigInt(value), true);
  return new Uint8Array(buf);
}

function u32Buffer(value) {
  const buf = new ArrayBuffer(4);
  new DataView(buf).setUint32(0, value, true);
  return new Uint8Array(buf);
}

function concatByteArrays(parts) {
  const total = parts.reduce((n, p) => n + p.length, 0);
  const out = new Uint8Array(total);
  let at = 0;
  for (const p of parts) {
    out.set(p, at);
    at += p.length;
  }
  return out;
}

function vestingPda(beneficiary, index) {
  const seeds = [
    Buffer_like("vesting"),
    beneficiary.toBuffer(),
    u32Buffer(index),
  ];
  return web3.PublicKey.findProgramAddressSync(seeds, PROGRAM_ID)[0];
}

function registryPda(beneficiary) {
  return web3.PublicKey.findProgramAddressSync(
    [Buffer_like("registry"), beneficiary.toBuffer()],
    PROGRAM_ID
  )[0];
}

// web3.js PublicKey.findProgramAddressSync takes Uint8Array seeds; this
// wraps a string as utf-8 bytes.
function Buffer_like(text) {
  return new TextEncoder().encode(text);
}

function vaultAta(vesting, mint) {
  return spl.getAssociatedTokenAddressSync(mint, vesting, true, TOKEN2022, ATA_PROGRAM);
}

function ownerAta(owner, mint) {
  return spl.getAssociatedTokenAddressSync(mint, owner, true, TOKEN2022, ATA_PROGRAM);
}

async function chainNow() {
  const slot = await connection.getSlot("confirmed");
  return connection.getBlockTime(slot);
}

// Mirror of the on-chain schedule math, in BigInt.
function unlockedAmount(total, start, cliff, maturity, now) {
  if (now < cliff) return 0n;
  if (now >= maturity) return total;
  const span = BigInt(maturity - start);
  const elapsed = BigInt(now - start);
  return (total * elapsed) / span;
}

function decodeSchedule(data) {
  const view = new DataView(data.buffer, data.byteOffset, data.byteLength);
  let at = 8; // anchor discriminator
  const readPubkey = () => {
    const key = new web3.PublicKey(data.slice(at, at + 32));
    at += 32;
    return key;
  };
  const readU64 = () => {
    const v = view.getBigUint64(at, true);
    at += 8;
    return v;
  };
  const readI64 = () => {
    const v = view.getBigInt64(at, true);
    at += 8;
    return Number(v);
  };
  const beneficiary = readPubkey();
  const authority = readPubkey();
  const mint = readPubkey();
  const vault = readPubkey();
  const totalAmount = readU64();
  const claimedAmount = readU64();
  const startTs = readI64();
  const cliffTs = readI64();
  const maturityTs = readI64();
  const scheduleIdx = view.getUint32(at, true);
  at += 4;
  const revocable = data[at] === 1;
  at += 1;
  const revoked = data[at] === 1;
  at += 1;
  const revokedAt = readI64();
  return {
    beneficiary, authority, mint, vault, totalAmount, claimedAmount,
    startTs, cliffTs, maturityTs, scheduleIdx, revocable, revoked, revokedAt,
  };
}

let walletPublicKey = null;
let provider = null;

els.connect.addEventListener("click", async () => {
  try {
    provider = getProvider();
    const resp = await provider.connect();
    walletPublicKey = resp.publicKey;
    els.wallet.textContent = short(walletPublicKey);
    els.actions.hidden = false;
    log("connected " + walletPublicKey.toString());
    await refreshSchedules();
  } catch (err) {
    log("connect failed: " + (err.message || err));
  }
});

els.createMint.addEventListener("click", async () => {
  if (!walletPublicKey) return;
  try {
    els.createMint.disabled = true;
    const mint = web3.Keypair.generate();
    const space = spl.MINT_SIZE;
    const lamports = await connection.getMinimumBalanceForRentExemption(space);
    const ata = ownerAta(walletPublicKey, mint.publicKey);
    const supply = 1000n * 10n ** BigInt(DECIMALS);
    const tx = new web3.Transaction();
    tx.add(
      web3.SystemProgram.createAccount({
        fromPubkey: walletPublicKey,
        newAccountPubkey: mint.publicKey,
        space,
        lamports,
        programId: TOKEN2022,
      }),
      spl.createInitializeMint2Instruction(
        mint.publicKey, DECIMALS, walletPublicKey, walletPublicKey, TOKEN2022
      ),
      spl.createAssociatedTokenAccountInstruction(
        walletPublicKey, ata, walletPublicKey, mint.publicKey, ATA_PROGRAM, TOKEN2022
      ),
      spl.createMintToInstruction(
        mint.publicKey, ata, walletPublicKey, supply, [], TOKEN2022
      )
    );
    tx.feePayer = walletPublicKey;
    tx.recentBlockhash = (await connection.getLatestBlockhash("confirmed")).blockhash;
    tx.partialSign(mint);
    const { signature } = await provider.signAndSendTransaction(tx);
    log("mint created " + mint.publicKey.toString() + " tx " + explorerTx(signature));
    els.mintAddress.value = mint.publicKey.toString();
  } catch (err) {
    log("mint creation failed: " + (err.message || err));
  } finally {
    els.createMint.disabled = false;
  }
});

els.createSchedule.addEventListener("click", async () => {
  if (!walletPublicKey) return;
  try {
    els.createSchedule.disabled = true;
    const mintStr = els.mintAddress.value.trim();
    if (!mintStr) {
      throw new Error("create a mint first");
    }
    const mint = new web3.PublicKey(mintStr);
    const beneficiary = new web3.PublicKey(els.beneficiary.value.trim());
    const uiAmount = Number(els.amount.value);
    const amount = BigInt(Math.round(uiAmount * 10 ** DECIMALS));
    const cliffMin = Number(els.cliffMin.value);
    const maturityMin = Number(els.maturityMin.value);
    if (!(maturityMin > cliffMin)) {
      throw new Error("maturity must be later than the cliff");
    }
    const now = await chainNow();
    const start = now - 2;
    const cliff = now + cliffMin * 60;
    const maturity = now + maturityMin * 60;

    const registryKey = registryPda(beneficiary);
    const registryInfo = await connection.getAccountInfo(registryKey, "confirmed");
    let scheduleIdx = 0;
    if (registryInfo) {
      scheduleIdx = new DataView(
        registryInfo.data.buffer, registryInfo.data.byteOffset
      ).getUint32(8 + 32, true);
    }
    const vesting = vestingPda(beneficiary, scheduleIdx);
    const source = ownerAta(walletPublicKey, mint);

    const data = concatByteArrays([
      await discriminator("create_schedule"),
      u64Buffer(amount),
      i64Buffer(start),
      i64Buffer(cliff),
      i64Buffer(maturity),
      u32Buffer(scheduleIdx),
      new Uint8Array([els.revocable.checked ? 1 : 0]),
    ]);

    const ix = new web3.TransactionInstruction({
      programId: PROGRAM_ID,
      keys: [
        { pubkey: walletPublicKey, isSigner: true, isWritable: true },
        { pubkey: beneficiary, isSigner: false, isWritable: false },
        { pubkey: registryKey, isSigner: false, isWritable: true },
        { pubkey: vesting, isSigner: false, isWritable: true },
        { pubkey: vaultAta(vesting, mint), isSigner: false, isWritable: true },
        { pubkey: source, isSigner: false, isWritable: true },
        { pubkey: mint, isSigner: false, isWritable: false },
        { pubkey: TOKEN2022, isSigner: false, isWritable: false },
        { pubkey: ATA_PROGRAM, isSigner: false, isWritable: false },
        { pubkey: web3.SystemProgram.programId, isSigner: false, isWritable: false },
      ],
      data,
    });

    const tx = new web3.Transaction().add(ix);
    tx.feePayer = walletPublicKey;
    tx.recentBlockhash = (await connection.getLatestBlockhash("confirmed")).blockhash;
    const { signature } = await provider.signAndSendTransaction(tx);
    log("schedule " + scheduleIdx + " created for " + short(beneficiary) + " tx " + explorerTx(signature));
    if (beneficiary.equals(walletPublicKey)) {
      await refreshSchedules();
    }
  } catch (err) {
    log("schedule creation failed: " + (err.message || err));
  } finally {
    els.createSchedule.disabled = false;
  }
});

els.refresh.addEventListener("click", () => refreshSchedules());

async function refreshSchedules() {
  if (!walletPublicKey) return;
  try {
    const registryKey = registryPda(walletPublicKey);
    const registryInfo = await connection.getAccountInfo(registryKey, "confirmed");
    const count = registryInfo
      ? new DataView(registryInfo.data.buffer, registryInfo.data.byteOffset).getUint32(8 + 32, true)
      : 0;
    const now = await chainNow();
    const cards = [];
    for (let idx = 0; idx < count; idx++) {
      const vesting = vestingPda(walletPublicKey, idx);
      const info = await connection.getAccountInfo(vesting, "confirmed");
      if (!info) continue;
      const s = decodeSchedule(info.data);
      const vaultInfo = await spl.getAccount(connection, s.vault, "confirmed", TOKEN2022).catch(() => null);
      const vaultBalance = vaultInfo ? vaultInfo.amount : 0n;
      const effNow = s.revoked ? s.revokedAt : now;
      const claimable = s.revoked
        ? unlockedAmount(s.totalAmount, s.startTs, s.cliffTs, s.maturityTs, effNow) - s.claimedAmount
        : unlockedAmount(s.totalAmount, s.startTs, s.cliffTs, s.maturityTs, now) - s.claimedAmount;
      cards.push(renderCard(s, vaultBalance, claimable, now));
    }
    els.schedules.innerHTML = cards.length
      ? cards.join("")
      : '<p class="muted">none yet</p>';
    bindCardButtons();
  } catch (err) {
    log("refresh failed: " + (err.message || err));
  }
}

function fmt(amount) {
  return (Number(amount) / 10 ** DECIMALS).toLocaleString(undefined, {
    maximumFractionDigits: 6,
  });
}

function renderCard(s, vaultBalance, claimable, now) {
  const drained = vaultBalance === 0n;
  const pct = ((Number(s.claimedAmount) / Number(s.totalAmount)) * 100).toFixed(1);
  const cliffLeft = Math.max(0, s.cliffTs - now);
  const matLeft = Math.max(0, s.maturityTs - now);
  return (
    '<div class="schedule-card" data-idx="' + s.scheduleIdx + '">' +
    "<dl>" +
    "<dt>schedule</dt><dd>#" + s.scheduleIdx + (s.revoked ? " (revoked)" : "") + "</dd>" +
    "<dt>mint</dt><dd><code>" + s.mint.toString() + "</code></dd>" +
    "<dt>total</dt><dd>" + fmt(s.totalAmount) + "</dd>" +
    "<dt>claimed</dt><dd>" + fmt(s.claimedAmount) + " (" + pct + "%)</dd>" +
    "<dt>claimable now</dt><dd>" + fmt(claimable > 0n ? claimable : 0n) + "</dd>" +
    "<dt>vault</dt><dd>" + fmt(vaultBalance) + "</dd>" +
    "<dt>cliff in</dt><dd>" + (cliffLeft === 0 ? "passed" : cliffLeft + "s") + "</dd>" +
    "<dt>matures in</dt><dd>" + (matLeft === 0 ? "matured" : matLeft + "s") + "</dd>" +
    "</dl>" +
    '<div class="row">' +
    '<button class="claim" data-idx="' + s.scheduleIdx + '" data-mint="' + s.mint + '"' +
    (claimable <= 0n ? " disabled" : "") + '>Claim</button>' +
    '<button class="close" data-idx="' + s.scheduleIdx + '" data-mint="' + s.mint + '"' +
    (!drained ? " disabled" : "") + '>Close</button>' +
    "</div></div>"
  );
}

function bindCardButtons() {
  els.schedules.querySelectorAll("button.claim").forEach((b) => {
    b.addEventListener("click", () => claimSchedule(Number(b.dataset.idx), b.dataset.mint));
  });
  els.schedules.querySelectorAll("button.close").forEach((b) => {
    b.addEventListener("click", () => closeSchedule(Number(b.dataset.idx), b.dataset.mint));
  });
}

async function claimSchedule(idx, mintStr) {
  try {
    const mint = new web3.PublicKey(mintStr);
    const vesting = vestingPda(walletPublicKey, idx);
    const destination = ownerAta(walletPublicKey, mint);
    const data = await discriminator("claim");
    const ix = new web3.TransactionInstruction({
      programId: PROGRAM_ID,
      keys: [
        { pubkey: walletPublicKey, isSigner: true, isWritable: true },
        { pubkey: vesting, isSigner: false, isWritable: true },
        { pubkey: vaultAta(vesting, mint), isSigner: false, isWritable: true },
        { pubkey: mint, isSigner: false, isWritable: false },
        { pubkey: destination, isSigner: false, isWritable: true },
        { pubkey: TOKEN2022, isSigner: false, isWritable: false },
        { pubkey: ATA_PROGRAM, isSigner: false, isWritable: false },
        { pubkey: web3.SystemProgram.programId, isSigner: false, isWritable: false },
      ],
      data,
    });
    const tx = new web3.Transaction().add(ix);
    tx.feePayer = walletPublicKey;
    tx.recentBlockhash = (await connection.getLatestBlockhash("confirmed")).blockhash;
    const { signature } = await provider.signAndSendTransaction(tx);
    log("claim sent " + explorerTx(signature));
    await refreshSchedules();
  } catch (err) {
    log("claim failed: " + (err.message || err));
  }
}

async function closeSchedule(idx, mintStr) {
  try {
    const mint = new web3.PublicKey(mintStr);
    const vesting = vestingPda(walletPublicKey, idx);
    const data = await discriminator("close_schedule");
    const ix = new web3.TransactionInstruction({
      programId: PROGRAM_ID,
      keys: [
        { pubkey: walletPublicKey, isSigner: true, isWritable: true },
        { pubkey: vesting, isSigner: false, isWritable: true },
        { pubkey: vaultAta(vesting, mint), isSigner: false, isWritable: true },
        { pubkey: TOKEN2022, isSigner: false, isWritable: false },
      ],
      data,
    });
    const tx = new web3.Transaction().add(ix);
    tx.feePayer = walletPublicKey;
    tx.recentBlockhash = (await connection.getLatestBlockhash("confirmed")).blockhash;
    const { signature } = await provider.signAndSendTransaction(tx);
    log("close sent " + explorerTx(signature));
    await refreshSchedules();
  } catch (err) {
    log("close failed: " + (err.message || err));
  }
}
