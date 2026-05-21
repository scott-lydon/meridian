// Settlement job — 16:05 ET on every US trading day.
//
// For each unsettled Market today: fetch Pyth close, compute outcome.
// Slice 9 v1 calls `admin_settle` (admin override path is the only one
// that exists pre-Pyth-on-chain). Slice 2 replaces this with a real
// settle_market that reads Pyth on-chain.
//
// Retry policy: per-ticker, every 30s for up to 15min. Alert + manual
// override if still failing.

import * as anchor from "@coral-xyz/anchor";

import type { Env } from "../lib/env.js";
import { logger } from "../lib/logger.js";
import { PythClient, type PythTicker } from "../lib/pyth.js";
import { isUsTradingDay, tradingDayUnix } from "../lib/calendar.js";
import { buildAnchor, configPda } from "../lib/anchor.js";
import { SlackAlerter } from "../lib/alerts.js";
import { MAG7_TICKERS, pythFeedFor } from "../lib/env.js";

const SETTLEMENT_RETRY_INTERVAL_MS = 30_000;
const SETTLEMENT_RETRY_WINDOW_MS = 15 * 60 * 1000;
const USDC_BASE = 1_000_000n;

export interface SettlementResult {
  readonly tradingDay: number;
  readonly settled: number;
  readonly stillOpen: number;
}

export async function runSettlementJob(env: Env): Promise<SettlementResult> {
  const now = new Date();
  if (!isUsTradingDay(now)) {
    logger.info({ date: now.toISOString() }, "not a US trading day; skipping settlement");
    return { tradingDay: 0, settled: 0, stillOpen: 0 };
  }

  const ctx = buildAnchor(env);
  const pyth = new PythClient(env.PYTH_HERMES_URL);
  const alerter = new SlackAlerter(env.SLACK_WEBHOOK_URL);
  const day = tradingDayUnix(now);
  logger.info({ tradingDay: day }, "settlement job starting");

  // Fetch all today's markets and filter unsettled ones.
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const allMarkets: any[] = await (ctx.program.account as any).market.all();
  const todays = allMarkets.filter(
    (m) =>
      Number(m.account.tradingDayUnix.toString()) === day &&
      Object.keys(m.account.outcome.state)[0] === "pending",
  );
  logger.info({ count: todays.length }, "unsettled markets today");

  // For each ticker, fetch its closing price once and reuse across strikes.
  const closes = new Map<PythTicker, number>();
  for (const ticker of MAG7_TICKERS) {
    let attempts = 0;
    const start = Date.now();
    while (Date.now() - start < SETTLEMENT_RETRY_WINDOW_MS) {
      attempts += 1;
      try {
        const p = await pyth.getLatest(pythFeedFor(env, ticker));
        if (!p) throw new Error("no price published");
        if (p.confBps > env.PYTH_MAX_CONFIDENCE_BPS) {
          throw new Error(`conf too wide: ${p.confBps}bps > ${env.PYTH_MAX_CONFIDENCE_BPS}bps`);
        }
        closes.set(ticker, p.price);
        logger.info(
          { ticker, attempts, price: p.price, confBps: p.confBps },
          "close obtained",
        );
        break;
      } catch (err) {
        logger.warn({ ticker, attempts, err: String(err) }, "pyth read failed; retrying");
        await new Promise((r) => setTimeout(r, SETTLEMENT_RETRY_INTERVAL_MS));
      }
    }
    if (!closes.has(ticker)) {
      await alerter.fire({
        title: `Settlement: oracle failed for ${ticker}`,
        body: `Gave up after 15min retry window. Run admin_settle manually.`,
        fields: { ticker, tradingDay: day },
      });
    }
  }

  let settled = 0;
  let stillOpen = 0;
  for (const m of todays) {
    const ticker = decodeTicker(m.account.ticker) as PythTicker;
    const closePrice = closes.get(ticker);
    if (closePrice === undefined) {
      stillOpen += 1;
      continue;
    }
    const closeMicros = BigInt(Math.round(closePrice * Number(USDC_BASE)));
    try {
      // For slice 9 v1, we use admin_settle. Slice 2 swaps in settle_market
      // (anyone-callable, on-chain Pyth verify). admin_settle ENFORCES
      // the override delay, so it will only succeed if market.created_at +
      // admin_override_delay_secs <= now. For freshly-created markets the
      // delay blocks; this path is meant for the real fallback only.
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      await (ctx.program.methods as any)
        .adminSettle(new anchor.BN(closeMicros.toString()))
        .accounts({
          config: configPda(ctx.programId),
          market: m.publicKey,
          admin: ctx.adminKeypair.publicKey,
        })
        .signers([ctx.adminKeypair])
        .rpc();
      settled += 1;
      logger.info(
        { market: m.publicKey.toBase58(), ticker, close: closePrice },
        "market settled",
      );
    } catch (err) {
      stillOpen += 1;
      logger.error(
        { market: m.publicKey.toBase58(), ticker, err: String(err) },
        "settle failed",
      );
    }
  }

  if (stillOpen > 0) {
    await alerter.fire({
      title: "Meridian settlement incomplete",
      body: `${stillOpen} markets still open after settlement run.`,
      fields: { tradingDay: day, settled, stillOpen },
    });
  }
  logger.info({ tradingDay: day, settled, stillOpen }, "settlement done");
  return { tradingDay: day, settled, stillOpen };
}

function decodeTicker(bytes: number[] | Uint8Array): string {
  const buf = Buffer.from(bytes);
  const end = buf.indexOf(0);
  return end === -1 ? buf.toString("ascii") : buf.slice(0, end).toString("ascii");
}
