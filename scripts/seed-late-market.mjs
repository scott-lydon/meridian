// scripts/seed-late-market.mjs
//
// Create a fresh on-chain market with a FUTURE expiry, plus an initialized
// order book seeded with one bid and one ask. Companion to
// scripts/seed-devnet.mjs but tuned for after-hours testing — the existing
// seed script hard-codes expiry to 16:00 ET TODAY, which makes the market
// instantly past-expiry if you run it after market close.
//
// Same on-chain instructions as seed-devnet.mjs (create_strike_market,
// init_order_book, mint_pair, place_order). Nothing about the transactions
// is mocked or simulated — this is real devnet state. The only difference
// is the expiry value passed to create_strike_market.
//
// Usage:
//
//   # default: expiry = now + 24h, strike = $250 NVDA
//   node scripts/seed-late-market.mjs
//
//   # custom expiry window:
//   EXPIRY_HOURS=48 node scripts/seed-late-market.mjs
//
//   # custom ticker / strike:
//   TICKER=AAPL STRIKE_USD=200 node scripts/seed-late-market.mjs
//
// Outputs:
//   - Solana Explorer links for the market PDA and each tx
//   - The /trade/<TICKER>/<MARKET_PDA> path you can open in the local dev
//     server to verify the buttons enable
//
// Prereqs:
//   - Anchor IDL has been built (./target/idl/meridian.json present)
//   - Admin keypair at ~/.config/solana/id.json has ≥ 5 USDC on devnet
//     (faucet.circle.com) and ≥ 0.05 SOL for fees (faucet.solana.com)
//   - The program's Config PDA has been initialized (scripts/init-config.mjs)
//
// The script is idempotent at the (trading_day, ticker, strike) PDA level:
// re-running it with the same env vars finds the existing market and skips
// the create step. Mint and place_order ALWAYS run again though, because
// you may want to top up liquidity on the same market.

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

// Devnet only. Mainnet seeding is intentionally NOT supported by this
// script — real money is not for ad-hoc test fixtures.
const RPC = "https://api.devnet.solana.com";
const USDC = new PublicKey("4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU");

// MAG7 Pyth feed IDs. These are the same ones the morning cron + .env.example
// use; keep this table in sync if those change.
const PYTH_FEEDS = {
  AAPL: "5a207c4aa0114baecf852fcd9db9beb8ec715f2db48caa525dbd878fd416fb09",
  MSFT: "8f98f8267ddddeeb61b4fd11f21dc0c2842c417622b4d685243fa73b5830131f",
  GOOGL: "88d0800b1649d98e21b8bf9c3f42ab548034d62874ad5d80e1c1b730566d7f61",
  AMZN: "82c59e36a8e0247e15283748d6cd51f5fa1019d73fbf3ab6d927e17d9e357a7f",
  NVDA: "61c4ca5b9731a79e285a01e24432d57d89f0ecdd4cd7828196ca8992d5eafef6",
  META: "399f1e8f1c4a517859963b56f104727a7a3c7f0f8fee56d34fa1f72e5a4b78ef",
  TSLA: "42676a595d0099c381687124805c8bb22c75424dffcaa55e3dc6549854ebe20a",
};

// CLI env knobs. All optional. Defaults pick a sensible after-hours market:
// NVDA $250 strike, expiring 24 hours from now.
const TICKER_STR = (process.env.TICKER ?? "NVDA").toUpperCase();
const STRIKE_USD = Number(process.env.STRIKE_USD ?? "250");
const EXPIRY_HOURS = Number(process.env.EXPIRY_HOURS ?? "24");
const MINT_QTY = Number(process.env.MINT_QTY ?? "5");
const BID_PRICE_TICKS = Number(process.env.BID_PRICE_TICKS ?? "45"); // 45¢
const ASK_PRICE_TICKS = Number(process.env.ASK_PRICE_TICKS ?? "55"); // 55¢
const QUOTE_QTY = Number(process.env.QUOTE_QTY ?? "2");

if (!PYTH_FEEDS[TICKER_STR]) {
  throw new Error(
    `Unknown ticker ${TICKER_STR}. Set TICKER=<one of ${Object.keys(PYTH_FEEDS).join(", ")}>.`,
  );
}
if (!(STRIKE_USD > 0) || !Number.isFinite(STRIKE_USD)) {
  throw new Error(`Invalid STRIKE_USD=${process.env.STRIKE_USD}; must be a positive number.`);
}
if (!(EXPIRY_HOURS > 0) || !Number.isFinite(EXPIRY_HOURS)) {
  throw new Error(
    `Invalid EXPIRY_HOURS=${process.env.EXPIRY_HOURS}; must be a positive number of hours.`,
  );
}

const IDL_PATH = "/Users/scottlydon/Desktop/Clutter/iOS/meridian/target/idl/meridian.json";
let idl;
try {
  idl = JSON.parse(readFileSync(IDL_PATH, "utf-8"));
} catch (err) {
  throw new Error(
    `Failed to read Anchor IDL at ${IDL_PATH}. Run \`anchor build\` first so target/idl/meridian.json exists. Cause: ${err.message}`,
  );
}

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

// Match the Anchor program's PDA derivation. Same constants as
// programs/meridian/src/constants.rs.
const VERSION = Buffer.from([1]);
const seed = (s) => Buffer.from(s);
const TICKER_BYTES = (s) => {
  const buf = Buffer.alloc(6);
  buf.write(s, "ascii");
  return Array.from(buf);
};

function explorer(kind, id) {
  return `https://explorer.solana.com/${kind}/${id}?cluster=devnet`;
}

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
  return PublicKey.findProgramAddressSync(
    [seed("vault_auth"), market.toBuffer(), VERSION],
    programId,
  )[0];
}
function yesMintPda(market) {
  return PublicKey.findProgramAddressSync(
    [seed("yes_mint"), market.toBuffer(), VERSION],
    programId,
  )[0];
}
function noMintPda(market) {
  return PublicKey.findProgramAddressSync(
    [seed("no_mint"), market.toBuffer(), VERSION],
    programId,
  )[0];
}
function orderBookPda(market) {
  return PublicKey.findProgramAddressSync(
    [seed("book"), market.toBuffer(), VERSION],
    programId,
  )[0];
}
function bookAuthPda(market) {
  return PublicKey.findProgramAddressSync(
    [seed("book_auth"), market.toBuffer(), VERSION],
    programId,
  )[0];
}

async function ensureATA(mint, owner, allowOwnerOffCurve = false) {
  const ata = getAssociatedTokenAddressSync(mint, owner, allowOwnerOffCurve);
  try {
    await getAccount(connection, ata);
    return ata;
  } catch {
    const created = await getOrCreateAssociatedTokenAccount(
      connection,
      admin,
      mint,
      owner,
      allowOwnerOffCurve,
    );
    console.log(`  [+] created ATA ${ata.toBase58()} for owner ${owner.toBase58()}`);
    return created.address;
  }
}

async function main() {
  console.log("=== seed-late-market starting ===");
  console.log("program_id:    ", programId.toBase58());
  console.log("admin:         ", admin.publicKey.toBase58());
  console.log("ticker:        ", TICKER_STR);
  console.log("strike:        $", STRIKE_USD);
  console.log("expiry window: ", EXPIRY_HOURS, "h from now");

  // 1) Verify config exists.
  const cfg = await connection.getAccountInfo(configPda);
  if (!cfg) {
    throw new Error(
      `config not initialized at ${configPda.toBase58()}; run scripts/init-config.mjs first`,
    );
  }
  console.log("[ok] config exists at", configPda.toBase58());

  // 2) Derive the market PDA. We use the SAME trading-day-unix derivation
  // the morning cron uses (UTC midnight of today) so the market lives in
  // the same per-day slot — that means if the morning cron also runs, it
  // will see this strike exists and skip it (idempotent). The expiry is
  // decoupled from the trading day, so it can sit hours or days later.
  const ticker = TICKER_BYTES(TICKER_STR);
  const strikeUsdMicros = STRIKE_USD * 1_000_000;
  const now = new Date();
  const utcMidnight = new Date(
    Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate(), 0, 0, 0),
  );
  const tradingDayUnix = Math.floor(utcMidnight.getTime() / 1000);
  const expiryUnix = Math.floor(Date.now() / 1000) + EXPIRY_HOURS * 3600;
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
  console.log(`  strike:        $${STRIKE_USD.toFixed(2)}`);

  const marketInfo = await connection.getAccountInfo(market);
  if (!marketInfo) {
    console.log("\n[step] create_strike_market");
    const pythFeedId = Array.from(Buffer.from(PYTH_FEEDS[TICKER_STR], "hex"));
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
    // The market PDA exists from a prior run. Its on-chain expiry is fixed
    // at create time — we cannot push it forward without a new admin
    // instruction. Surface this loudly so the user knows the expiry they
    // requested is NOT what this market actually has.
    console.log(
      "[skip] market PDA already exists at this (day, ticker, strike). " +
        "On-chain expiry was set when the market was first created; this " +
        "run's EXPIRY_HOURS value does NOT update it. Use a different strike " +
        "or run on a different trading day to get a market with a new expiry.",
    );
  }

  // 3) Init order book if needed.
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

  // 4) Admin ATAs (USDC source + Yes/No targets).
  console.log("\n[step] ensure ATAs");
  const userUsdc = await ensureATA(USDC, admin.publicKey);
  const userYes = await ensureATA(yesMint, admin.publicKey);
  const userNo = await ensureATA(noMint, admin.publicKey);

  const adminUsdc = await getAccount(connection, userUsdc);
  console.log("  admin USDC balance:", adminUsdc.amount.toString(), "base units");
  if (adminUsdc.amount < BigInt(MINT_QTY) * 1_000_000n) {
    console.log(
      `  [!] admin has < ${MINT_QTY} USDC; mint_pair + place_order steps will be skipped.`,
    );
    console.log(
      "      Fund via https://faucet.circle.com (devnet, paste:",
      admin.publicKey.toBase58(),
      ")",
    );
    console.log("\n=== seed-late-market complete (market only) ===");
    console.log("market on Explorer:", explorer("address", market.toBase58()));
    console.log("trade page URL:    ", `http://localhost:3000/trade/${TICKER_STR}/${market.toBase58()}`);
    console.log(
      "If after-hours mode is OFF in the UI, click the 🧪 DEV button in the header and toggle it on; the market will then be tradeable in the UI regardless of clock.",
    );
    return;
  }

  // 5) mint_pair MINT_QTY (deposit MINT_QTY USDC, receive MINT_QTY Yes +
  // MINT_QTY No). This is the same instruction a normal user calls — we
  // run it with the admin keypair purely because the admin is the only
  // pre-funded wallet in the dev environment.
  console.log(`\n[step] mint_pair(${MINT_QTY})`);
  const sig5 = await program.methods
    .mintPair(new anchor.BN(MINT_QTY))
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

  // 6) Place a Bid at BID_PRICE_TICKS / 100 USDC, qty QUOTE_QTY.
  console.log(`\n[step] place_order Bid ${BID_PRICE_TICKS}¢ qty ${QUOTE_QTY}`);
  const sigBid = await program.methods
    .placeOrder({ bid: {} }, BID_PRICE_TICKS, new anchor.BN(QUOTE_QTY))
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

  // 7) Place an Ask at ASK_PRICE_TICKS / 100 USDC, qty QUOTE_QTY.
  console.log(`\n[step] place_order Ask ${ASK_PRICE_TICKS}¢ qty ${QUOTE_QTY}`);
  const sigAsk = await program.methods
    .placeOrder({ ask: {} }, ASK_PRICE_TICKS, new anchor.BN(QUOTE_QTY))
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

  console.log("\n=== seed-late-market complete ===");
  console.log("market on Explorer:", explorer("address", market.toBase58()));
  console.log("order book:        ", explorer("address", orderBook.toBase58()));
  console.log("program:           ", explorer("address", programId.toBase58()));
  console.log(
    "\nTrade it locally at:   ",
    `http://localhost:3000/trade/${TICKER_STR}/${market.toBase58()}`,
  );
  console.log(
    "Tip: if the buttons are disabled, click the 🧪 DEV button in the header and toggle after-hours testing mode ON.",
  );
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
