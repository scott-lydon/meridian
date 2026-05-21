// scripts/seed-devnet.mjs
//
// End-to-end smoke against the LIVE devnet program. Idempotent: re-running
// skips work that already landed. Each step logs the tx signature with the
// Explorer URL so the user can verify on-chain.
//
// Order:
//   1. Verify config exists (initialized previously).
//   2. Create one NVDA market (today's day, strike $250) — or skip if present.
//   3. Init order book + escrow ATAs — or skip.
//   4. mint_pair 5 (admin keypair plays user too for the seed).
//   5. place_order Bid at $0.45 qty 2.
//   6. place_order Ask at $0.55 qty 2.
//
// Run from tests/ so @coral-xyz/anchor + @solana/spl-token resolve:
//   cd tests && node /Users/scottlydon/Desktop/Clutter/iOS/meridian/scripts/seed-devnet.mjs

import * as anchor from "@coral-xyz/anchor";
import {
  Connection,
  Keypair,
  PublicKey,
  SystemProgram,
  SYSVAR_RENT_PUBKEY,
} from "@solana/web3.js";
import {
  TOKEN_PROGRAM_ID,
  ASSOCIATED_TOKEN_PROGRAM_ID,
  getAssociatedTokenAddressSync,
  getOrCreateAssociatedTokenAccount,
  getAccount,
} from "@solana/spl-token";
import { readFileSync } from "node:fs";
import { homedir } from "node:os";

const RPC = "https://api.devnet.solana.com";
const USDC = new PublicKey("4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU");

const IDL_PATH = "/Users/scottlydon/Desktop/Clutter/iOS/meridian/target/idl/meridian.json";
const idl = JSON.parse(readFileSync(IDL_PATH, "utf-8"));

const admin = Keypair.fromSecretKey(
  Uint8Array.from(JSON.parse(readFileSync(`${homedir()}/.config/solana/id.json`, "utf-8"))),
);
const connection = new Connection(RPC, "confirmed");
const wallet = {
  publicKey: admin.publicKey,
  payer: admin,
  signTransaction: async (tx) => {
    tx.partialSign(admin);
    return tx;
  },
  signAllTransactions: async (txs) => {
    txs.forEach((t) => t.partialSign(admin));
    return txs;
  },
};
const provider = new anchor.AnchorProvider(connection, wallet, { commitment: "confirmed" });
const program = new anchor.Program(idl, provider);
const programId = program.programId;

const VERSION = Buffer.from([1]);
const seed = (s) => Buffer.from(s);
const TICKER = (s) => {
  const buf = Buffer.alloc(6);
  buf.write(s, "ascii");
  return Array.from(buf);
};

function explorer(kind, id) {
  return `https://explorer.solana.com/${kind}/${id}?cluster=devnet`;
}

// PDA helpers
const [configPda] = PublicKey.findProgramAddressSync([seed("config"), VERSION], programId);

function marketPda(tradingDayUnix, ticker, strikeUsdMicros) {
  const day = Buffer.alloc(8);
  day.writeBigInt64LE(BigInt(tradingDayUnix));
  const strike = Buffer.alloc(8);
  strike.writeBigUInt64LE(BigInt(strikeUsdMicros));
  return PublicKey.findProgramAddressSync(
    [seed("market"), day, Buffer.from(ticker), strike, VERSION],
    programId,
  )[0];
}

function vaultAuthPda(market) {
  return PublicKey.findProgramAddressSync([seed("vault_auth"), market.toBuffer(), VERSION], programId)[0];
}
function yesMintPda(market) {
  return PublicKey.findProgramAddressSync([seed("yes_mint"), market.toBuffer(), VERSION], programId)[0];
}
function noMintPda(market) {
  return PublicKey.findProgramAddressSync([seed("no_mint"), market.toBuffer(), VERSION], programId)[0];
}
function orderBookPda(market) {
  return PublicKey.findProgramAddressSync([seed("book"), market.toBuffer(), VERSION], programId)[0];
}
function bookAuthPda(market) {
  return PublicKey.findProgramAddressSync([seed("book_auth"), market.toBuffer(), VERSION], programId)[0];
}

async function ensureATA(mint, owner, allowOwnerOffCurve = false) {
  const ata = getAssociatedTokenAddressSync(mint, owner, allowOwnerOffCurve);
  try {
    await getAccount(connection, ata);
    return ata;
  } catch {
    const created = await getOrCreateAssociatedTokenAccount(connection, admin, mint, owner, allowOwnerOffCurve);
    console.log(`  [+] created ATA ${ata.toBase58()} for owner ${owner.toBase58()}`);
    return created.address;
  }
}

async function main() {
  console.log("=== seed-devnet starting ===");
  console.log("program_id:", programId.toBase58());
  console.log("admin:     ", admin.publicKey.toBase58());

  // 1) Verify config exists.
  const cfg = await connection.getAccountInfo(configPda);
  if (!cfg) throw new Error(`config not initialized at ${configPda.toBase58()}; run init-config.mjs first`);
  console.log("[ok] config exists at", configPda.toBase58());

  // 2) Today's market: NVDA > $250 expiring 16:00 ET (20:00 UTC) today.
  const ticker = TICKER("NVDA");
  const strikeUsdMicros = 250 * 1_000_000;
  const now = new Date();
  const utcMidnight = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate(), 0, 0, 0));
  const tradingDayUnix = Math.floor(utcMidnight.getTime() / 1000);
  const expiryUnix = tradingDayUnix + 21 * 3600; // 21:00 UTC ~ 16:00 ET DST/EDT
  const market = marketPda(tradingDayUnix, ticker, strikeUsdMicros);
  const vaultAuth = vaultAuthPda(market);
  const yesMint = yesMintPda(market);
  const noMint = noMintPda(market);
  const orderBook = orderBookPda(market);
  const bookAuth = bookAuthPda(market);
  const vaultAta = getAssociatedTokenAddressSync(USDC, vaultAuth, true);
  const usdcEscrow = getAssociatedTokenAddressSync(USDC, bookAuth, true);
  const yesEscrow = getAssociatedTokenAddressSync(yesMint, bookAuth, true);

  console.log("\n=== Market state ===");
  console.log("  market PDA:    ", market.toBase58());
  console.log("  trading_day:   ", new Date(tradingDayUnix * 1000).toISOString().slice(0, 10));
  console.log("  expiry:        ", new Date(expiryUnix * 1000).toISOString());
  console.log("  strike:        $250.00");

  const marketInfo = await connection.getAccountInfo(market);
  if (!marketInfo) {
    console.log("\n[step] create_strike_market");
    // Pyth NVDA feed id as bytes
    const pythNvda = "61c4ca5b9731a79e285a01e24432d57d89f0ecdd4cd7828196ca8992d5eafef6";
    const pythFeedId = Array.from(Buffer.from(pythNvda, "hex"));
    const sig = await program.methods
      .createStrikeMarket(
        new anchor.BN(tradingDayUnix),
        ticker,
        new anchor.BN(strikeUsdMicros),
        new anchor.BN(expiryUnix),
        pythFeedId,
      )
      .accounts({
        config: configPda,
        market,
        vaultAuthority: vaultAuth,
        yesMint,
        noMint,
        vault: vaultAta,
        usdcMint: USDC,
        admin: admin.publicKey,
        systemProgram: SystemProgram.programId,
        tokenProgram: TOKEN_PROGRAM_ID,
        associatedTokenProgram: ASSOCIATED_TOKEN_PROGRAM_ID,
        rent: SYSVAR_RENT_PUBKEY,
      })
      .rpc();
    console.log("  tx:", explorer("tx", sig));
  } else {
    console.log("[skip] market already exists");
  }

  // 3) Init order book.
  const bookInfo = await connection.getAccountInfo(orderBook);
  if (!bookInfo) {
    console.log("\n[step] init_order_book");
    const sig = await program.methods
      .initOrderBook()
      .accounts({
        config: configPda,
        market,
        orderBook,
        bookAuthority: bookAuth,
        usdcEscrow,
        yesEscrow,
        usdcMint: USDC,
        yesMint,
        admin: admin.publicKey,
        systemProgram: SystemProgram.programId,
        tokenProgram: TOKEN_PROGRAM_ID,
        associatedTokenProgram: ASSOCIATED_TOKEN_PROGRAM_ID,
        rent: SYSVAR_RENT_PUBKEY,
      })
      .rpc();
    console.log("  tx:", explorer("tx", sig));
  } else {
    console.log("[skip] order book already initialized");
  }

  // 4) Ensure admin's USDC, Yes, No ATAs exist.
  console.log("\n[step] ensure ATAs");
  const userUsdc = await ensureATA(USDC, admin.publicKey);
  const userYes = await ensureATA(yesMint, admin.publicKey);
  const userNo = await ensureATA(noMint, admin.publicKey);

  // Fund admin USDC if needed via Circle's devnet faucet — out of scope here.
  // The admin needs USDC to mint pairs. Skip if we don't have any.
  const adminUsdc = await getAccount(connection, userUsdc);
  console.log("  admin USDC balance:", adminUsdc.amount.toString(), "base units");
  if (adminUsdc.amount < 5_000_000n) {
    console.log(
      "  [!] admin has < 5 USDC; mint_pair + place_order steps will be skipped.",
    );
    console.log("      Fund via https://faucet.circle.com (devnet, paste:", admin.publicKey.toBase58(), ")");
  } else {
    // 5) mint_pair 5
    console.log("\n[step] mint_pair(5)");
    const sig5 = await program.methods
      .mintPair(new anchor.BN(5))
      .accounts({
        config: configPda,
        market,
        vaultAuthority: vaultAuth,
        yesMint,
        noMint,
        vault: vaultAta,
        userUsdc,
        userYes,
        userNo,
        user: admin.publicKey,
        tokenProgram: TOKEN_PROGRAM_ID,
      })
      .rpc();
    console.log("  tx:", explorer("tx", sig5));

    // 6) Place a Bid at $0.45 qty 2.
    console.log("\n[step] place_order Bid $0.45 qty 2");
    const sigBid = await program.methods
      .placeOrder({ bid: {} }, 45, new anchor.BN(2))
      .accounts({
        config: configPda,
        market,
        orderBook,
        usdcEscrow,
        yesEscrow,
        userUsdc,
        userYes,
        yesMint,
        user: admin.publicKey,
        tokenProgram: TOKEN_PROGRAM_ID,
      })
      .rpc();
    console.log("  tx:", explorer("tx", sigBid));

    // 7) Place an Ask at $0.55 qty 2.
    console.log("\n[step] place_order Ask $0.55 qty 2");
    const sigAsk = await program.methods
      .placeOrder({ ask: {} }, 55, new anchor.BN(2))
      .accounts({
        config: configPda,
        market,
        orderBook,
        usdcEscrow,
        yesEscrow,
        userUsdc,
        userYes,
        yesMint,
        user: admin.publicKey,
        tokenProgram: TOKEN_PROGRAM_ID,
      })
      .rpc();
    console.log("  tx:", explorer("tx", sigAsk));
  }

  console.log("\n=== seed complete ===");
  console.log("market on Explorer:", explorer("address", market.toBase58()));
  console.log("order book:        ", explorer("address", orderBook.toBase58()));
  console.log("program:           ", explorer("address", programId.toBase58()));
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
