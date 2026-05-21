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
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    program = (anchor.workspace as any).Meridian;
    if (!program) throw new Error("workspace.Meridian missing; run `anchor build`");

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
    // Build pyth_feeds with the META feed populated; rest can be zero for slice 1.
    const pythFeeds = Array.from({ length: 7 }).map((_, i) => ({
      ticker: padTicker(["AAPL", "MSFT", "GOOGL", "AMZN", "NVDA", "META", "TSLA"][i] ?? ""),
      feedId: Array.from(Buffer.alloc(32)),
    }));

    await program.methods
      .initializeConfig(pythFeeds)
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

    await program.methods
      .createStrikeMarket(tradingDay, ticker, strikeMicros, expiry)
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
