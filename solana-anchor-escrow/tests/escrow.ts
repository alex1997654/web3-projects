import * as anchor from "@coral-xyz/anchor";
import { Program } from "@coral-xyz/anchor";
import { assert, expect } from "chai";
import {
  PublicKey,
  Keypair,
  SystemProgram,
  LAMPORTS_PER_SOL,
} from "@solana/web3.js";
import {
  TOKEN_PROGRAM_ID,
  ASSOCIATED_TOKEN_PROGRAM_ID,
  createMint,
  mintTo,
  getOrCreateAssociatedTokenAccount,
  getAccount,
  getMint,
} from "@solana/spl-token";

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

describe("escrow", () => {
  const provider = anchor.AnchorProvider.env();
  anchor.setProvider(provider);

  const program = anchor.workspace.Escrow as Program;
  const maker = provider.wallet as anchor.Wallet;
  const makerPk = maker.publicKey;
  const taker = Keypair.generate();

  let mintA: PublicKey;
  let mintB: PublicKey;
  let makerAtaA: PublicKey;
  let makerAtaB: PublicKey;
  let takerAtaB: PublicKey;

  // mint A has 6 decimals, mint B has 9: the program must never mix the
  // scales, and tests assert amounts in raw base units throughout.
  const A_DECIMALS = 6;
  const B_DECIMALS = 9;
  const MAKER_A_START = 10_000_000_000;
  const TAKER_B_START = 100_000_000_000_000;

  const escrowPda = (owner: PublicKey, seed: number) =>
    PublicKey.findProgramAddressSync(
      [
        Buffer.from("escrow"),
        owner.toBuffer(),
        new anchor.BN(seed).toArrayLike(Buffer, "le", 8),
      ],
      program.programId
    )[0];

  const vaultPda = (escrow: PublicKey) =>
    PublicKey.findProgramAddressSync(
      [Buffer.from("vault"), escrow.toBuffer()],
      program.programId
    )[0];

  async function balance(ata: PublicKey): Promise<bigint> {
    return (await getAccount(provider.connection, ata)).amount;
  }

  async function expectFailure(promise: Promise<any>, code: string) {
    try {
      await promise;
    } catch (err: any) {
      const info = err?.error;
      if (info?.errorCode?.code === code) return;
      const logs: string = (err?.logs ?? []).join("\n");
      if (logs.includes("Error Code: " + code)) return;
      throw new Error(
        "expected error " +
        code +
        " but got: " +
        (err?.message ?? String(err)) +
        " logs: " +
        logs
      );
    }
    assert.fail("expected error " + code + " but the call succeeded");
  }

  async function postOffer(
    seed: number,
    offerA: number,
    askB: number,
    expiry = 0,
    makerKey = makerPk,
    signers: Keypair[] = []
  ) {
    return program.methods
      .makeOffer(
        new anchor.BN(seed),
        new anchor.BN(offerA),
        new anchor.BN(askB),
        new anchor.BN(expiry)
      )
      .accounts({
        maker: makerKey,
        mintA,
        mintB,
        makerAtaA,
        escrow: escrowPda(makerKey, seed),
        vault: vaultPda(escrowPda(makerKey, seed)),
        tokenProgram: TOKEN_PROGRAM_ID,
        systemProgram: SystemProgram.programId,
      })
      .signers(signers)
      .rpc();
  }

  function takeAccounts(seed: number, takerKey: PublicKey) {
    const escrow = escrowPda(makerPk, seed);
    return {
      taker: takerKey,
      maker: makerPk,
      mintA,
      mintB,
      takerAtaB,
      makerAtaB,
      takerAtaA: anchor.utils.token.associatedAddress({
        mint: mintA,
        owner: takerKey,
      }),
      escrow,
      vault: vaultPda(escrow),
      tokenProgram: TOKEN_PROGRAM_ID,
      associatedTokenProgram: ASSOCIATED_TOKEN_PROGRAM_ID,
      systemProgram: SystemProgram.programId,
    };
  }

  async function takePartial(
    seed: number,
    amount: number,
    takerKey = taker.publicKey,
    signer: Keypair | null = taker
  ) {
    return program.methods
      .take(new anchor.BN(seed), new anchor.BN(amount))
      .accounts(takeAccounts(seed, takerKey))
      .signers(signer ? [signer] : [])
      .rpc();
  }

  async function takeFull(
    seed: number,
    takerKey = taker.publicKey,
    signer: Keypair | null = taker
  ) {
    return program.methods
      .takeFull(new anchor.BN(seed))
      .accounts(takeAccounts(seed, takerKey))
      .signers(signer ? [signer] : [])
      .rpc();
  }

  before(async () => {
    // Fund both sides on the local validator if needed.
    for (const [pk, label] of [
      [makerPk, "maker"],
      [taker.publicKey, "taker"],
    ] as [PublicKey, string][]) {
      const lamports = await provider.connection.getBalance(pk);
      if (lamports < 10 * LAMPORTS_PER_SOL) {
        const sig = await provider.connection.requestAirdrop(
          pk,
          50 * LAMPORTS_PER_SOL
        );
        await provider.connection.confirmTransaction(sig, "confirmed");
      }
    }

    mintA = await createMint(
      provider.connection,
      maker.payer,
      makerPk,
      null,
      A_DECIMALS
    );
    mintB = await createMint(
      provider.connection,
      maker.payer,
      makerPk,
      null,
      B_DECIMALS
    );

    const makerA = await getOrCreateAssociatedTokenAccount(
      provider.connection,
      maker.payer,
      mintA,
      makerPk
    );
    makerAtaA = makerA.address;
    const makerB = await getOrCreateAssociatedTokenAccount(
      provider.connection,
      maker.payer,
      mintB,
      makerPk
    );
    makerAtaB = makerB.address;
    const takerB = await getOrCreateAssociatedTokenAccount(
      provider.connection,
      maker.payer,
      mintB,
      taker.publicKey
    );
    takerAtaB = takerB.address;

    await mintTo(
      provider.connection,
      maker.payer,
      mintA,
      makerAtaA,
      makerPk,
      MAKER_A_START
    );
    await mintTo(
      provider.connection,
      maker.payer,
      mintB,
      takerAtaB,
      makerPk,
      TAKER_B_START
    );
  });

  it("sets up mints with different decimals", async () => {
    assert.equal((await getMint(provider.connection, mintA)).decimals, 6);
    assert.equal((await getMint(provider.connection, mintB)).decimals, 9);
  });

  it("maker posts an offer, taker fills it completely, accounts close", async () => {
    const seed = 101;
    await postOffer(seed, 1_000, 2_000);

    const escrow = escrowPda(makerPk, seed);
    const vault = vaultPda(escrow);
    const state: any = await program.account.escrow.fetch(escrow);
    assert.equal(state.maker.toBase58(), makerPk.toBase58());
    assert.equal(state.mintA.toBase58(), mintA.toBase58());
    assert.equal(state.mintB.toBase58(), mintB.toBase58());
    assert.isTrue(state.offerAmountA.eq(new anchor.BN(1_000)));
    assert.isTrue(state.askAmountB.eq(new anchor.BN(2_000)));
    assert.isTrue(state.remainingAmountA.eq(new anchor.BN(1_000)));
    assert.isTrue(state.expiry.eq(new anchor.BN(0)));
    assert.equal((await balance(vault)).valueOf(), 1_000n);

    const makerB0 = await balance(makerAtaB);
    await takeFull(seed);

    const takerA = await anchor.utils.token.associatedAddress({
      mint: mintA,
      owner: taker.publicKey,
    });
    assert.equal((await balance(takerA)).valueOf(), 1_000n);
    assert.equal(
      (await balance(makerAtaB)).valueOf(),
      makerB0.valueOf() + 2_000n
    );

    // Both program accounts are gone: rent went back to the maker.
    assert.isNull(await provider.connection.getAccountInfo(escrow));
    assert.isNull(await provider.connection.getAccountInfo(vault));
  });

  it("partial takes pay the original rate, rounded up against the taker", async () => {
    const seed = 202;
    // offer 7 A for 10 B: taking 3 costs ceil(30/7) = 5, not 4.
    await postOffer(seed, 7, 10);

    const makerB0 = await balance(makerAtaB);
    await takePartial(seed, 3);

    const state: any = await program.account.escrow.fetch(
      escrowPda(makerPk, seed)
    );
    assert.isTrue(state.remainingAmountA.eq(new anchor.BN(4)));
    assert.equal(
      (await balance(makerAtaB)).valueOf(),
      makerB0.valueOf() + 5n
    );

    // Finish it: taking the last 4 costs ceil(40/7) = 6.
    await takeFull(seed);
    assert.equal(
      (await balance(makerAtaB)).valueOf(),
      makerB0.valueOf() + 11n
    );
    assert.isNull(
      await provider.connection.getAccountInfo(escrowPda(makerPk, seed))
    );
  });

  it("maker cancels and gets the full deposit back", async () => {
    const seed = 303;
    const makerA0 = await balance(makerAtaA);
    await postOffer(seed, 500, 900);
    assert.equal(
      (await balance(makerAtaA)).valueOf(),
      makerA0.valueOf() - 500n
    );

    await program.methods
      .refund(new anchor.BN(seed))
      .accounts({
        maker: makerPk,
        mintA,
        makerAtaA,
        escrow: escrowPda(makerPk, seed),
        vault: vaultPda(escrowPda(makerPk, seed)),
        tokenProgram: TOKEN_PROGRAM_ID,
        systemProgram: SystemProgram.programId,
      })
      .rpc();

    assert.equal(
      (await balance(makerAtaA)).valueOf(),
      makerA0.valueOf()
    );
    assert.isNull(
      await provider.connection.getAccountInfo(escrowPda(makerPk, seed))
    );
  });

  it("maker can cancel what is left after a partial take", async () => {
    const seed = 304;
    await postOffer(seed, 100, 300);
    await takePartial(seed, 40);

    const makerA0 = await balance(makerAtaA);
    await program.methods
      .refund(new anchor.BN(seed))
      .accounts({
        maker: makerPk,
        mintA,
        makerAtaA,
        escrow: escrowPda(makerPk, seed),
        vault: vaultPda(escrowPda(makerPk, seed)),
        tokenProgram: TOKEN_PROGRAM_ID,
        systemProgram: SystemProgram.programId,
      })
      .rpc();

    assert.equal(
      (await balance(makerAtaA)).valueOf(),
      makerA0.valueOf() + 60n
    );
  });

  it("a non-maker cannot cancel", async () => {
    const seed = 404;
    await postOffer(seed, 100, 100);

    await expectFailure(
      program.methods
        .refund(new anchor.BN(seed))
        .accounts({
          maker: taker.publicKey,
          mintA,
          makerAtaA: anchor.utils.token.associatedAddress({
            mint: mintA,
            owner: taker.publicKey,
          }),
          escrow: escrowPda(makerPk, seed),
          vault: vaultPda(escrowPda(makerPk, seed)),
          tokenProgram: TOKEN_PROGRAM_ID,
          systemProgram: SystemProgram.programId,
        })
        .signers([taker])
        .rpc(),
      "ConstraintSeeds"
    );

    // cleanup
    await program.methods
      .refund(new anchor.BN(seed))
      .accounts({
        maker: makerPk,
        mintA,
        makerAtaA,
        escrow: escrowPda(makerPk, seed),
        vault: vaultPda(escrowPda(makerPk, seed)),
        tokenProgram: TOKEN_PROGRAM_ID,
        systemProgram: SystemProgram.programId,
      })
      .rpc();
  });

  it("expired offers cannot be taken, only refunded", async () => {
    const seed = 505;
    const now = Math.floor(Date.now() / 1000);
    await postOffer(seed, 100, 200, now + 2);

    await sleep(6_000);

    await expectFailure(takeFull(seed), "EscrowExpired");
    await expectFailure(takePartial(seed, 40), "EscrowExpired");

    await program.methods
      .refund(new anchor.BN(seed))
      .accounts({
        maker: makerPk,
        mintA,
        makerAtaA,
        escrow: escrowPda(makerPk, seed),
        vault: vaultPda(escrowPda(makerPk, seed)),
        tokenProgram: TOKEN_PROGRAM_ID,
        systemProgram: SystemProgram.programId,
      })
      .rpc();
  });

  it("offers cannot be created already expired", async () => {
    const now = Math.floor(Date.now() / 1000);
    await expectFailure(postOffer(606, 100, 200, now - 100), "OfferAlreadyExpired");
  });

  it("takes of zero, of everything, or of more than everything are rejected", async () => {
    const seed = 707;
    await postOffer(seed, 100, 200);

    await expectFailure(takePartial(seed, 0), "TakeExceedsRemaining");
    await expectFailure(takePartial(seed, 100), "TakeExceedsRemaining");
    await expectFailure(takePartial(seed, 150), "TakeExceedsRemaining");

    await takePartial(seed, 50);
    await expectFailure(takePartial(seed, 50), "TakeExceedsRemaining");
    await takeFull(seed);
  });

  it("a settled escrow cannot be taken again", async () => {
    const seed = 808;
    await postOffer(seed, 50, 100);
    await takeFull(seed);

    await expectFailure(takeFull(seed), "AccountNotInitialized");
    await expectFailure(takePartial(seed, 10), "AccountNotInitialized");
  });

  it("the same wallet can be maker and taker", async () => {
    const seed = 909;
    await postOffer(seed, 100, 300);

    const makerA0 = await balance(makerAtaA);
    const makerB0 = await balance(makerAtaB);

    // Same wallet takes 30: pays itself B, receives 30 A from the vault.
    await program.methods
      .take(new anchor.BN(seed), new anchor.BN(30))
      .accounts({
        ...takeAccounts(seed, makerPk),
        takerAtaB: makerAtaB,
        takerAtaA: makerAtaA,
      })
      .rpc();

    assert.equal(
      (await balance(makerAtaA)).valueOf(),
      makerA0.valueOf() + 30n
    );
    assert.equal(
      (await balance(makerAtaB)).valueOf(),
      makerB0.valueOf()
    );

    await program.methods
      .refund(new anchor.BN(seed))
      .accounts({
        maker: makerPk,
        mintA,
        makerAtaA,
        escrow: escrowPda(makerPk, seed),
        vault: vaultPda(escrowPda(makerPk, seed)),
        tokenProgram: TOKEN_PROGRAM_ID,
        systemProgram: SystemProgram.programId,
      })
      .rpc();
  });

  it("offers with zero amounts are rejected", async () => {
    await expectFailure(postOffer(1010, 0, 100), "ZeroAmount");
    await expectFailure(postOffer(1011, 100, 0), "ZeroAmount");
  });
});