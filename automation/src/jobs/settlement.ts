// Settlement job — 16:05 ET on every US trading day.
//
// Primary path: `settle_market` reads Pyth on-chain via the receiver SDK.
// The cranker posts a fresh PriceUpdateV2 then calls settle_market which
// validates feed_id + staleness + confidence and writes the outcome.
//
// Fallback path: `admin_settle` (admin-signed, time-delayed by 1 hour).
// Used only when Pyth has been unavailable for 15 minutes.

import * as anchor from "@coral-xyz/anchor";

// Anchor 0.31 ESM/CJS interop: `anchor.BN` is undefined under `import * as`;
// fall through to the default export which has BN attached.
const BN = anchor.BN ?? (anchor as unknown as { default: { BN: typeof anchor.BN } }).default.BN;

import type { Env } from "../lib/env.js";
import { logger } from "../lib/logger.js";
import { PythClient, type PythTicker } from "../lib/pyth.js";
import { isUsTradingDay, tradingDayUnix } from "../lib/calendar.js";
import { buildAnchor, configPda } from "../lib/anchor.js";
import { SlackAlerter } from "../lib/alerts.js";
import { MAG7_TICKERS, pythFeedFor } from "../lib/env.js";
import { settleMarketWithPyth } from "../lib/pyth-onchain.js";

const SETTLEMENT_RETRY_INTERVAL_MS = 30_000;
const SETTLEMENT_RETRY_WINDOW_MS = 15 * 60 * 1000;
const USDC_BASE = 1_000_000n;

export interface SettlementResult {
  readonly tradingDay: number;
  readonly settledViaPyth: number;
  readonly settledViaAdmin: number;
  readonly stillOpen: number;
}

export async function runSettlementJob(env: Env): Promise<SettlementResult> {
  const now = new Date();
  if (!isUsTradingDay(now)) {
    logger.info({ date: now.toISOString() }, "not a US trading day; skipping settlement");
    return { tradingDay: 0, settledViaPyth: 0, settledViaAdmin: 0, stillOpen: 0 };
  }

  const ctx = buildAnchor(env);
  const pyth = new PythClient(env.PYTH_HERMES_URL);
  const alerter = new SlackAlerter(env.SLACK_WEBHOOK_URL);
  const day = tradingDayUnix(now);
  logger.info({ tradingDay: day }, "settlement job starting (Pyth primary, admin fallback)");

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const allMarkets: any[] = await (ctx.program.account as any).market.all();
  const todays = allMarkets.filter(
    (m) =>
      Number(m.account.tradingDayUnix.toString()) === day &&
      Object.keys(m.account.outcome.state)[0] === "pending",
  );
  logger.info({ count: todays.length }, "unsettled markets today");

  let settledViaPyth = 0;
  let settledViaAdmin = 0;
  let stillOpen = 0;

  for (const m of todays) {
    const ticker = decodeTicker(m.account.ticker) as PythTicker;
    if (!MAG7_TICKERS.includes(ticker)) {
      logger.warn({ ticker }, "unknown ticker on market; skipping");
      stillOpen += 1;
      continue;
    }
    const feedId = pythFeedFor(env, ticker);

    // Primary: settle_market via Pyth on-chain.
    let pythSettled = false;
    const start = Date.now();
    let attempts = 0;
    while (Date.now() - start < SETTLEMENT_RETRY_WINDOW_MS) {
      attempts += 1;
      try {
        // Pre-flight: check Hermes confidence before paying gas to post on-chain.
        const offchain = await pyth.getLatest(feedId);
        if (!offchain) throw new Error("Hermes returned no price");
        if (offchain.confBps > env.PYTH_MAX_CONFIDENCE_BPS) {
          throw new Error(
            `Hermes conf ${offchain.confBps}bps > max ${env.PYTH_MAX_CONFIDENCE_BPS}bps`,
          );
        }

        const result = await settleMarketWithPyth(ctx, env.PYTH_HERMES_URL, m.publicKey, feedId);
        logger.info(
          { market: m.publicKey.toBase58(), ticker, sig: result.settleSig, attempts },
          "settled via Pyth",
        );
        settledViaPyth += 1;
        pythSettled = true;
        break;
      } catch (err) {
        logger.warn(
          { ticker, attempts, err: String(err) },
          "Pyth settle attempt failed; retrying",
        );
        await new Promise((r) => setTimeout(r, SETTLEMENT_RETRY_INTERVAL_MS));
      }
    }
    if (pythSettled) continue;

    // Fallback: admin_settle. Will only succeed if 1hr override delay has passed.
    try {
      const offchain = await pyth.getLatest(feedId);
      if (!offchain) throw new Error("Hermes has no price for admin fallback");
      const closeMicros = BigInt(Math.round(offchain.price * Number(USDC_BASE)));
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const sig = await (ctx.program.methods as any)
        .adminSettle(new BN(closeMicros.toString()))
        .accounts({
          config: configPda(ctx.programId),
          market: m.publicKey,
          admin: ctx.adminKeypair.publicKey,
        })
        .signers([ctx.adminKeypair])
        .rpc();
      logger.info(
        { market: m.publicKey.toBase58(), ticker, sig },
        "settled via admin fallback",
      );
      settledViaAdmin += 1;
    } catch (err) {
      stillOpen += 1;
      await alerter.fire({
        title: `Settlement: both Pyth and admin paths failed for ${ticker}`,
        body: `Market ${m.publicKey.toBase58()} remains open. Manual intervention required.`,
        fields: { ticker, tradingDay: day, err: String(err) },
      });
    }
  }

  logger.info(
    { tradingDay: day, settledViaPyth, settledViaAdmin, stillOpen },
    "settlement done",
  );
  return { tradingDay: day, settledViaPyth, settledViaAdmin, stillOpen };
}

function decodeTicker(bytes: number[] | Uint8Array): string {
  const buf = Buffer.from(bytes);
  const end = buf.indexOf(0);
  return end === -1 ? buf.toString("ascii") : buf.slice(0, end).toString("ascii");
}
