// Slice 1 end-to-end: initialize_config -> create_strike_market -> mint_pair ->
// settle_market_manual -> redeem (both sides).
//
// Runs against `solana-test-validator`. Uses devnet USDC mint via spl-token
// `createMint` since we don't have access to Circle's devnet mint on localnet.

import * as anchor from "@coral-xyz/anchor";
import { BN } from "@coral-xyz/anchor";
import {
  PublicKey,
  Keypair,
  SystemProgram,
  SYSVAR_RENT_PUBKEY,
} from "@solana/web3.js";
import {
  TOKEN_PROGRAM_ID,
  ASSOCIATED_TOKEN_PROGRAM_ID,
  createMint,
  createAssociatedTokenAccount,
  mintTo,
  getAccount,
} from "@solana/spl-token";
import { describe, it, beforeAll, expect } from "vitest";
import { readFileSync } from "node:fs";
import { resolve as resolvePath } from "node:path";

const PROGRAM_VERSION = 1;
const CONFIG_SEED = Buffer.from("config");
const MARKET_SEED = Buffer.from("market");
const VAULT_AUTH_SEED = Buffer.from("vault_auth");
const YES_MINT_SEED = Buffer.from("yes_mint");
const NO_MINT_SEED = Buffer.from("no_mint");

const TICKER_LEN = 6;
const USDC_BASE = 1_000_000;

function padTicker(sym: string): number[] {
  const buf = Buffer.alloc(TICKER_LEN);
  buf.write(sym, "ascii");
  return Array.from(buf);
}

describe("meridian slice 1", () => {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let program: any;
  let provider: anchor.AnchorProvider;
  let admin: Keypair;
  let user: Keypair;
  let usdcMint: PublicKey;
  let configPda: PublicKey;
  let marketPda: PublicKey;
  let yesMintPda: PublicKey;
  let noMintPda: PublicKey;
  let vaultAuthPda: PublicKey;
  let vaultAta: PublicKey;
  let userUsdc: PublicKey;
  let userYes: PublicKey;
  let userNo: PublicKey;

  const ticker = padTicker("META");
  const tradingDay = new BN(Math.floor(Date.now() / 1000));
  const strikeMicros = new BN(680 * USDC_BASE);
  const expiry = tradingDay.add(new BN(16 * 3600));

  beforeAll(async () => {
    provider = anchor.AnchorProvider.env();
    anchor.setProvider(provider);
    // Load IDL directly from target/ instead of going through anchor.workspace
    // (which reads Anchor.toml from cwd and breaks under vitest).
    const idlPath = resolvePath(__dirname, "..", "target", "idl", "meridian.json");
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const idl: any = JSON.parse(readFileSync(idlPath, "utf-8"));
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    program = new (anchor as any).Program(idl, provider);
    if (!program) throw new Error(`could not load program from ${idlPath}`);

    admin = (provider.wallet as anchor.Wallet).payer;
    user = Keypair.generate();

    // Airdrop the test user 2 SOL so they can pay rent for their ATAs.
    const sig = await provider.connection.requestAirdrop(user.publicKey, 2e9);
    await provider.connection.confirmTransaction(sig, "confirmed");

    // Create a test USDC mint owned by admin (stand-in for devnet USDC).
    usdcMint = await createMint(
      provider.connection,
      admin,
      admin.publicKey,
      null,
      6,
    );

    // Derive PDAs.
    [configPda] = PublicKey.findProgramAddressSync(
      [CONFIG_SEED, Buffer.from([PROGRAM_VERSION])],
      program.programId,
    );
    [marketPda] = PublicKey.findProgramAddressSync(
      [
        MARKET_SEED,
        tradingDay.toArrayLike(Buffer, "le", 8),
        Buffer.from(ticker),
        strikeMicros.toArrayLike(Buffer, "le", 8),
        Buffer.from([PROGRAM_VERSION]),
      ],
      program.programId,
    );
    [vaultAuthPda] = PublicKey.findProgramAddressSync(
      [VAULT_AUTH_SEED, marketPda.toBuffer(), Buffer.from([PROGRAM_VERSION])],
      program.programId,
    );
    [yesMintPda] = PublicKey.findProgramAddressSync(
      [YES_MINT_SEED, marketPda.toBuffer(), Buffer.from([PROGRAM_VERSION])],
      program.programId,
    );
    [noMintPda] = PublicKey.findProgramAddressSync(
      [NO_MINT_SEED, marketPda.toBuffer(), Buffer.from([PROGRAM_VERSION])],
      program.programId,
    );
  });

  it("initialize_config", async () => {
    await program.methods
      .initializeConfig()
      .accounts({
        config: configPda,
        usdcMint,
        admin: admin.publicKey,
        systemProgram: SystemProgram.programId,
      })
      .rpc();

    const cfg = await program.account.config.fetch(configPda);
    expect(cfg.admin.toBase58()).toBe(admin.publicKey.toBase58());
    expect(cfg.usdcMint.toBase58()).toBe(usdcMint.toBase58());
    expect(cfg.paused).toBe(false);
  });

  it("create_strike_market", async () => {
    // vault is an ATA derived later; let the IX init it.
    const { getAssociatedTokenAddressSync } = await import("@solana/spl-token");
    vaultAta = getAssociatedTokenAddressSync(usdcMint, vaultAuthPda, true);
    // Pyth feed id placeholder for slice 1 (slice 2 verifies on-chain).
    const pythFeedId = Array.from(Buffer.alloc(32));

    await program.methods
      .createStrikeMarket(tradingDay, ticker, strikeMicros, expiry, pythFeedId)
      .accounts({
        config: configPda,
        market: marketPda,
        vaultAuthority: vaultAuthPda,
        yesMint: yesMintPda,
        noMint: noMintPda,
        vault: vaultAta,
        usdcMint,
        admin: admin.publicKey,
        systemProgram: SystemProgram.programId,
        tokenProgram: TOKEN_PROGRAM_ID,
        associatedTokenProgram: ASSOCIATED_TOKEN_PROGRAM_ID,
        rent: SYSVAR_RENT_PUBKEY,
      })
      .rpc();

    const market = await program.account.market.fetch(marketPda);
    expect(market.strikeUsdMicros.toString()).toBe(strikeMicros.toString());
    expect(market.outcome.state).toEqual({ pending: {} });
  });

  it("mint_pair (3 pairs) then vault holds 3 USDC", async () => {
    userUsdc = await createAssociatedTokenAccount(
      provider.connection,
      user,
      usdcMint,
      user.publicKey,
    );
    userYes = await createAssociatedTokenAccount(
      provider.connection,
      user,
      yesMintPda,
      user.publicKey,
    );
    userNo = await createAssociatedTokenAccount(
      provider.connection,
      user,
      noMintPda,
      user.publicKey,
    );
    // Fund user with 10 USDC.
    await mintTo(provider.connection, admin, usdcMint, userUsdc, admin, 10 * USDC_BASE);

    await program.methods
      .mintPair(new BN(3))
      .accounts({
        config: configPda,
        market: marketPda,
        vaultAuthority: vaultAuthPda,
        yesMint: yesMintPda,
        noMint: noMintPda,
        vault: vaultAta,
        userUsdc,
        userYes,
        userNo,
        user: user.publicKey,
        tokenProgram: TOKEN_PROGRAM_ID,
      })
      .signers([user])
      .rpc();

    const vault = await getAccount(provider.connection, vaultAta);
    const yes = await getAccount(provider.connection, userYes);
    const no = await getAccount(provider.connection, userNo);
    expect(Number(vault.amount)).toBe(3 * USDC_BASE);
    expect(Number(yes.amount)).toBe(3);
    expect(Number(no.amount)).toBe(3);
  });

  it("settle_market_manual (yes wins)", async () => {
    await program.methods
      .settleMarketManual(new BN(685 * USDC_BASE))
      .accounts({
        config: configPda,
        market: marketPda,
        admin: admin.publicKey,
      })
      .rpc();
    const market = await program.account.market.fetch(marketPda);
    expect(market.outcome.state).toEqual({ yesWins: {} });
  });

  it("redeem yes (3 tokens) -> 3 USDC", async () => {
    const before = (await getAccount(provider.connection, userUsdc)).amount;
    await program.methods
      .redeem({ yes: {} }, new BN(3))
      .accounts({
        config: configPda,
        market: marketPda,
        vaultAuthority: vaultAuthPda,
        yesMint: yesMintPda,
        noMint: noMintPda,
        vault: vaultAta,
        userUsdc,
        userYes,
        userNo,
        user: user.publicKey,
        tokenProgram: TOKEN_PROGRAM_ID,
      })
      .signers([user])
      .rpc();
    const after = (await getAccount(provider.connection, userUsdc)).amount;
    expect(Number(after - before)).toBe(3 * USDC_BASE);
    expect(Number((await getAccount(provider.connection, userYes)).amount)).toBe(0);
  });

  it("redeem no (3 tokens) -> 0 USDC (loser path)", async () => {
    const before = (await getAccount(provider.connection, userUsdc)).amount;
    await program.methods
      .redeem({ no: {} }, new BN(3))
      .accounts({
        config: configPda,
        market: marketPda,
        vaultAuthority: vaultAuthPda,
        yesMint: yesMintPda,
        noMint: noMintPda,
        vault: vaultAta,
        userUsdc,
        userYes,
        userNo,
        user: user.publicKey,
        tokenProgram: TOKEN_PROGRAM_ID,
      })
      .signers([user])
      .rpc();
    const after = (await getAccount(provider.connection, userUsdc)).amount;
    expect(Number(after - before)).toBe(0);
    expect(Number((await getAccount(provider.connection, userNo)).amount)).toBe(0);
  });

  it("vault invariant: drained after all redeems", async () => {
    const vault = await getAccount(provider.connection, vaultAta);
    expect(Number(vault.amount)).toBe(0);
  });
});

// =============================================================================
// SLICE 3: in-program order book — init, place, cancel
// =============================================================================

const ORDER_BOOK_SEED = Buffer.from("book");
const BOOK_AUTH_SEED = Buffer.from("book_auth");

describe("meridian slice 3 — order book", () => {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let program: any;
  let provider: anchor.AnchorProvider;
  let admin: Keypair;
  let user: Keypair;
  let usdcMint: PublicKey;
  let configPda: PublicKey;
  let marketPda: PublicKey;
  let yesMintPda: PublicKey;
  let noMintPda: PublicKey;
  let vaultAuthPda: PublicKey;
  let vaultAta: PublicKey;
  let orderBookPda: PublicKey;
  let bookAuthPda: PublicKey;
  let usdcEscrow: PublicKey;
  let yesEscrow: PublicKey;
  let userUsdc: PublicKey;
  let userYes: PublicKey;
  let userNo: PublicKey;

  // Fresh market for this describe so we don't conflict with slice 1's markets.
  const ticker = padTicker("NVDA");
  const tradingDay = new BN(Math.floor(Date.now() / 1000) + 100);
  const strikeMicros = new BN(220 * USDC_BASE);
  const expiry = tradingDay.add(new BN(16 * 3600));

  beforeAll(async () => {
    provider = anchor.AnchorProvider.env();
    anchor.setProvider(provider);
    const idlPath = resolvePath(__dirname, "..", "target", "idl", "meridian.json");
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const idl: any = JSON.parse(readFileSync(idlPath, "utf-8"));
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    program = new (anchor as any).Program(idl, provider);
    admin = (provider.wallet as anchor.Wallet).payer;
    user = Keypair.generate();
    const sig = await provider.connection.requestAirdrop(user.publicKey, 2e9);
    await provider.connection.confirmTransaction(sig, "confirmed");

    // Read the USDC mint from the existing Config (slice 1 already initialized).
    [configPda] = PublicKey.findProgramAddressSync(
      [Buffer.from("config"), Buffer.from([1])],
      program.programId,
    );
    const cfg = await program.account.config.fetch(configPda);
    usdcMint = cfg.usdcMint;

    [marketPda] = PublicKey.findProgramAddressSync(
      [
        Buffer.from("market"),
        tradingDay.toArrayLike(Buffer, "le", 8),
        Buffer.from(ticker),
        strikeMicros.toArrayLike(Buffer, "le", 8),
        Buffer.from([1]),
      ],
      program.programId,
    );
    [vaultAuthPda] = PublicKey.findProgramAddressSync(
      [Buffer.from("vault_auth"), marketPda.toBuffer(), Buffer.from([1])],
      program.programId,
    );
    [yesMintPda] = PublicKey.findProgramAddressSync(
      [Buffer.from("yes_mint"), marketPda.toBuffer(), Buffer.from([1])],
      program.programId,
    );
    [noMintPda] = PublicKey.findProgramAddressSync(
      [Buffer.from("no_mint"), marketPda.toBuffer(), Buffer.from([1])],
      program.programId,
    );
    [orderBookPda] = PublicKey.findProgramAddressSync(
      [ORDER_BOOK_SEED, marketPda.toBuffer(), Buffer.from([1])],
      program.programId,
    );
    [bookAuthPda] = PublicKey.findProgramAddressSync(
      [BOOK_AUTH_SEED, marketPda.toBuffer(), Buffer.from([1])],
      program.programId,
    );

    // Create market for this slice
    const { getAssociatedTokenAddressSync } = await import("@solana/spl-token");
    vaultAta = getAssociatedTokenAddressSync(usdcMint, vaultAuthPda, true);
    usdcEscrow = getAssociatedTokenAddressSync(usdcMint, bookAuthPda, true);
    yesEscrow = getAssociatedTokenAddressSync(yesMintPda, bookAuthPda, true);

    const pythFeedId = Array.from(Buffer.alloc(32));
    await program.methods
      .createStrikeMarket(tradingDay, ticker, strikeMicros, expiry, pythFeedId)
      .accounts({
        config: configPda,
        market: marketPda,
        vaultAuthority: vaultAuthPda,
        yesMint: yesMintPda,
        noMint: noMintPda,
        vault: vaultAta,
        usdcMint,
        admin: admin.publicKey,
        systemProgram: SystemProgram.programId,
        tokenProgram: TOKEN_PROGRAM_ID,
        associatedTokenProgram: ASSOCIATED_TOKEN_PROGRAM_ID,
        rent: SYSVAR_RENT_PUBKEY,
      })
      .rpc();

    // User funds
    userUsdc = await createAssociatedTokenAccount(provider.connection, user, usdcMint, user.publicKey);
    userYes = await createAssociatedTokenAccount(provider.connection, user, yesMintPda, user.publicKey);
    userNo = await createAssociatedTokenAccount(provider.connection, user, noMintPda, user.publicKey);
    await mintTo(provider.connection, admin, usdcMint, userUsdc, admin, 50 * USDC_BASE);
  });

  it("init_order_book creates OrderBook + escrow ATAs", async () => {
    await program.methods
      .initOrderBook()
      .accounts({
        config: configPda,
        market: marketPda,
        orderBook: orderBookPda,
        bookAuthority: bookAuthPda,
        usdcEscrow,
        yesEscrow,
        usdcMint,
        yesMint: yesMintPda,
        admin: admin.publicKey,
        systemProgram: SystemProgram.programId,
        tokenProgram: TOKEN_PROGRAM_ID,
        associatedTokenProgram: ASSOCIATED_TOKEN_PROGRAM_ID,
        rent: SYSVAR_RENT_PUBKEY,
      })
      .rpc();

    const book = await program.account.orderBook.fetch(orderBookPda);
    expect(book.market.toBase58()).toBe(marketPda.toBase58());
    expect(book.bidsLen).toBe(0);
    expect(book.asksLen).toBe(0);
    expect(Number(book.nextSequence)).toBe(0);
  });

  it("place_order Bid escrows USDC and inserts into bids", async () => {
    const before = (await getAccount(provider.connection, userUsdc)).amount;
    // Buy 5 Yes at $0.55 = 5 * 55 * 10_000 = 2_750_000 base.
    await program.methods
      .placeOrder({ bid: {} }, 55, new BN(5))
      .accounts({
        config: configPda,
        market: marketPda,
        orderBook: orderBookPda,
        usdcEscrow,
        yesEscrow,
        userUsdc,
        userYes,
        yesMint: yesMintPda,
        user: user.publicKey,
        tokenProgram: TOKEN_PROGRAM_ID,
      })
      .signers([user])
      .rpc();

    const after = (await getAccount(provider.connection, userUsdc)).amount;
    expect(Number(before - after)).toBe(2_750_000);
    const escrow = await getAccount(provider.connection, usdcEscrow);
    expect(Number(escrow.amount)).toBe(2_750_000);

    const book = await program.account.orderBook.fetch(orderBookPda);
    expect(book.bidsLen).toBe(1);
    expect(book.bids[0].priceTicks).toBe(55);
    expect(Number(book.bids[0].qty)).toBe(5);
  });

  it("cancel_order refunds USDC", async () => {
    const before = (await getAccount(provider.connection, userUsdc)).amount;
    const book0 = await program.account.orderBook.fetch(orderBookPda);
    const sequence = book0.bids[0].sequence;

    await program.methods
      .cancelOrder({ bid: {} }, sequence)
      .accounts({
        config: configPda,
        market: marketPda,
        orderBook: orderBookPda,
        bookAuthority: bookAuthPda,
        usdcEscrow,
        yesEscrow,
        userUsdc,
        userYes,
        user: user.publicKey,
        tokenProgram: TOKEN_PROGRAM_ID,
      })
      .signers([user])
      .rpc();

    const after = (await getAccount(provider.connection, userUsdc)).amount;
    expect(Number(after - before)).toBe(2_750_000);
    const book = await program.account.orderBook.fetch(orderBookPda);
    expect(book.bidsLen).toBe(0);
  });
});
