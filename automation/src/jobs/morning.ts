// Morning job — 08:00 ET on every US trading day.
//
// 1. NYSE calendar check; weekend/holiday => log + exit.
// 2. For each MAG7 ticker: Hermes fetch previous close, compute strikes.
// 3. For each (ticker, strike): if Market PDA doesn't exist, call
//    create_strike_market(admin signer).
// 4. Log result table; alert on any failure.

import * as anchor from "@coral-xyz/anchor";

// Anchor 0.31 ESM/CJS interop: `anchor.BN` is undefined under `import * as`;
// fall through to the default export which has BN attached.
const BN = anchor.BN ?? (anchor as unknown as { default: { BN: typeof anchor.BN } }).default.BN;

import { SystemProgram, SYSVAR_RENT_PUBKEY, PublicKey } from "@solana/web3.js";
import {
  TOKEN_PROGRAM_ID,
  ASSOCIATED_TOKEN_PROGRAM_ID,
  getAssociatedTokenAddressSync,
} from "@solana/spl-token";

import type { Env } from "../lib/env.js";
import { MAG7_TICKERS, pythFeedFor } from "../lib/env.js";
import { logger } from "../lib/logger.js";
import { PythClient, type PythTicker } from "../lib/pyth.js";
import { generateStrikes } from "../lib/strikes.js";
import { isUsTradingDay, tradingDayUnix, expiryUnixForTradingDay } from "../lib/calendar.js";
import {
  buildAnchor,
  configPda,
  marketPda,
  NO_MINT_SEED,
  PROGRAM_VERSION_BYTE,
  VAULT_AUTH_SEED,
  YES_MINT_SEED,
  pad6,
} from "../lib/anchor.js";
import { SlackAlerter } from "../lib/alerts.js";

export interface MorningResult {
  readonly tradingDay: number;
  readonly created: number;
  readonly skipped: number;
  readonly failed: number;
}

export async function runMorningJob(env: Env): Promise<MorningResult> {
  const now = new Date();
  if (!isUsTradingDay(now)) {
    logger.info({ date: now.toISOString() }, "not a US trading day; skipping morning job");
    return { tradingDay: 0, created: 0, skipped: 0, failed: 0 };
  }

  const ctx = buildAnchor(env);
  const alerter = new SlackAlerter(env.SLACK_WEBHOOK_URL);
  const pyth = new PythClient(env.PYTH_HERMES_URL);
  const day = tradingDayUnix(now);
  const expiry = expiryUnixForTradingDay(new Date(day * 1000));
  const cfg = configPda(ctx.programId);

  logger.info({ tradingDay: day, expiry }, "morning job starting");

  // Fetch all 7 prices in parallel.
  const feedIds: Record<PythTicker, string> = Object.fromEntries(
    MAG7_TICKERS.map((t) => [t, pythFeedFor(env, t)]),
  ) as Record<PythTicker, string>;
  const prices = await pyth.getAllMag7(feedIds);

  let created = 0;
  let skipped = 0;
  let failed = 0;

  for (const ticker of MAG7_TICKERS) {
    const p = prices[ticker];
    logger.info(
      { ticker, price: p.price, publishTime: p.publishTime, confBps: p.confBps },
      "pyth read",
    );
    const strikes = generateStrikes(ticker, p.price);
    for (const s of strikes) {
      const market = marketPda(ctx.programId, BigInt(day), ticker, s.strikeUsdMicros);
      const info = await ctx.connection.getAccountInfo(market);
      if (info) {
        skipped += 1;
        continue;
      }
      try {
        const [vaultAuth] = PublicKey.findProgramAddressSync(
          [VAULT_AUTH_SEED, market.toBuffer(), PROGRAM_VERSION_BYTE],
          ctx.programId,
        );
        const [yesMint] = PublicKey.findProgramAddressSync(
          [YES_MINT_SEED, market.toBuffer(), PROGRAM_VERSION_BYTE],
          ctx.programId,
        );
        const [noMint] = PublicKey.findProgramAddressSync(
          [NO_MINT_SEED, market.toBuffer(), PROGRAM_VERSION_BYTE],
          ctx.programId,
        );
        const usdcMint = new PublicKey(env.USDC_MINT);
        const vault = getAssociatedTokenAddressSync(usdcMint, vaultAuth, true);
        const feedId = Array.from(Buffer.from(pythFeedFor(env, ticker), "hex"));

        // create_strike_market is admin-only; sign with admin keypair.
        // Cast methods to any: anchor's deeply-generic chain blows TS inference
        // when Program is typed as <any>.
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        await (ctx.program.methods as any)
          .createStrikeMarket(
            new BN(day),
            Array.from(pad6(ticker)),
            new BN(s.strikeUsdMicros.toString()),
            new BN(expiry),
            feedId,
          )
          .accounts({
            config: cfg,
            market,
            vaultAuthority: vaultAuth,
            yesMint,
            noMint,
            vault,
            usdcMint,
            admin: ctx.adminKeypair.publicKey,
            systemProgram: SystemProgram.programId,
            tokenProgram: TOKEN_PROGRAM_ID,
            associatedTokenProgram: ASSOCIATED_TOKEN_PROGRAM_ID,
            rent: SYSVAR_RENT_PUBKEY,
          })
          .signers([ctx.adminKeypair])
          .rpc();
        created += 1;
        logger.info({ ticker, strike: s.strikeUsd, market: market.toBase58() }, "market created");
      } catch (err) {
        failed += 1;
        logger.error({ ticker, strike: s.strikeUsd, err: String(err) }, "market create failed");
      }
    }
  }

  if (failed > 0) {
    await alerter.fire({
      title: "Meridian morning job had failures",
      body: `${failed} markets failed to create.`,
      fields: { tradingDay: day, created, skipped, failed },
    });
  }
  logger.info({ tradingDay: day, created, skipped, failed }, "morning job done");
  return { tradingDay: day, created, skipped, failed };
}
