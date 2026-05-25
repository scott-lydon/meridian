// Expiry sweep — runs every 30 seconds.
//
// Purpose: settle any market whose `expiry_unix` has passed and whose
// `outcome.state` is still `pending`, regardless of trading-day or
// time-of-day. This is the mechanism that makes the admin-created custom
// test markets self-settle at their custom expiry, without requiring an
// operator to click a "Settle Now" button.
//
// Why this is additive (does not regress production behavior):
//
//   - The 08:00 ET morning cron (jobs/morning.ts) is untouched.
//   - The 16:05 ET settlement cron (jobs/settlement.ts) is untouched.
//   - The on-chain instructions settle_market / admin_settle /
//     settle_market_manual are untouched.
//   - The /trigger/morning and /trigger/settle HTTP endpoints are
//     untouched.
//
// In normal production flow, the daily ladder of markets is created at
// 08:00 ET by the morning cron, all expiring at 16:00 ET that day. The
// sweep first sees those markets as expired-pending at ~16:00:30 ET (one
// tick after the EXPIRY_GRACE_SECS buffer) and tries to settle via Pyth.
// Pyth at 16:00 ET is fresh, so settlement succeeds via the primary path
// and the on-chain Outcome carries `admin_override = false`, identical to
// the 16:05 cron's behavior today. The 16:05 cron then runs five minutes
// later, finds no pending markets, and exits clean. Behavior change for
// production markets: settlement happens at 16:00:30 instead of 16:05.
// That is 4.5 minutes earlier than today and well within the spec's
// "automatically within 10 minutes of 4:00 PM ET" acceptance criterion
// (spec.md US-8).
//
// For admin-created custom test markets (created at, say, Sunday 17:31 ET
// with a 2-minute expiry), the daily 16:05 cron will not handle them
// because (a) the daily cron filters by trading day and weekends are
// excluded, and (b) the custom expiry does not match 16:00 ET. The sweep
// handles them as soon as their expiry passes, falling back to
// settle_market_manual with the last Hermes price when Pyth is stale
// (which is the off-hours condition).
//
// Why settle_market_manual instead of admin_settle as the fallback:
// admin_settle enforces market.admin_override_earliest =
// created_at + config.admin_override_delay_secs (set to 3600 seconds on
// devnet). A custom market created at 17:31 cannot be admin_settle'd
// until 18:31, defeating the rapid-test goal. settle_market_manual is
// admin-signed, computes the same YES/NO outcome from the supplied
// closing price, and has no time delay. Both instructions set
// outcome.admin_override = true so downstream consumers cannot tell
// the difference. Switching the fallback instruction for the sweep job
// does not change semantics observable from the program's perspective.
//
// Idempotency: the sweep filters on `outcome.state == "pending"`. Any
// market that another job (16:05 cron, /trigger/settle, a manual admin
// click) settles between two sweep ticks is invisible to the next tick.
// Safe to run alongside any other settlement path; first to settle wins,
// the rest see MarketAlreadySettled and skip.

import * as anchor from "@coral-xyz/anchor";

// Anchor 0.31 ESM/CJS interop: `anchor.BN` is undefined under `import * as`;
// fall through to the default export which has BN attached. (Same dance
// every other automation job does — see jobs/settlement.ts for the
// rationale comment.)
const BN = anchor.BN ?? (anchor as unknown as { default: { BN: typeof anchor.BN } }).default.BN;

import type { Env } from "../lib/env.js";
import { logger } from "../lib/logger.js";
import { PythClient, type PythTicker } from "../lib/pyth.js";
import { buildAnchor, configPda } from "../lib/anchor.js";
import { SlackAlerter } from "../lib/alerts.js";
import { MAG7_TICKERS, pythFeedFor } from "../lib/env.js";
import { settleMarketWithPyth } from "../lib/pyth-onchain.js";
import { expiryUnixForTradingDay } from "../lib/calendar.js";

/**
 * Grace period between expiry and first sweep attempt. 60 seconds keeps
 * production settlement at ~16:00:30 ET (still earlier than the current
 * 16:05 cron) without making test iteration painful. Bumping this affects
 * BOTH production and test behavior; lowering it risks racing against
 * Pyth's own publish cadence right at the close.
 */
const EXPIRY_GRACE_SECS = 60;

/** USDC base units per dollar. Matches programs/meridian/src/constants.rs. */
const USDC_BASE = 1_000_000n;

export interface ExpirySweepResult {
  readonly nowUnix: number;
  /** Total expired-pending markets observed this tick. */
  readonly observed: number;
  /** Settled via the Pyth primary path on this tick. */
  readonly settledViaPyth: number;
  /** Settled via the settle_market_manual fallback (Pyth was stale/failed). */
  readonly settledViaManual: number;
  /** Markets that failed both paths and remain pending. */
  readonly stillPending: number;
  /** Markets whose ticker did not resolve to a known Pyth feed (logged + skipped). */
  readonly skippedUnknownTicker: number;
  /**
   * Markets whose `(trading_day, expiry)` shape matches the production
   * daily ladder created by the 08:00 ET morning cron. Owned by the
   * 16:05 ET settlement cron's 15-minute Pyth-retry window; the sweep
   * intentionally leaves them alone. See `isProductionDailyLadderMarket`
   * for the rationale.
   */
  readonly skippedProductionMarket: number;
}

/**
 * The 08:00 ET morning cron creates markets whose `expiry_unix` equals
 * `expiryUnixForTradingDay(trading_day)` (today's UTC midnight + the
 * fixed 21:00 UTC = 16:00 ET expiry slot — see `morning.ts:58` and
 * `calendar.ts:78-86`). Custom admin-created markets use
 * `expiry = now + expirySecondsFromNow`, which essentially never lands
 * exactly on that production slot. We use the equality as a sentinel to
 * say "this market is the production daily ladder; leave it for the
 * 16:05 ET settlement cron." Without this gate, the sweep at 16:00:30 ET
 * would single-attempt Pyth on these markets, and on the first transient
 * Hermes flap it would fall back to `settle_market_manual` (writing
 * `admin_override = true`), pre-empting the 16:05 cron's 15-minute Pyth
 * retry window. That is exactly the regression QA-adversary flagged.
 *
 * Soft-collision case (orthogonal): if an admin manually creates a
 * market that happens to land on the production slot AND uses a
 * trading-day-aligned strike, this gate also makes the sweep skip the
 * admin's market. The admin would then have to wait for the 16:05 cron
 * (on a trading day) to settle it. That's an acceptable trade because
 * collisions require the admin to compute the exact production-slot
 * expiry timestamp on purpose — the create-market form takes
 * `expirySecondsFromNow`, which rounds to the nearest second from
 * "now", never to the slot's UTC midnight + 21h.
 */
export function isProductionDailyLadderMarket(
  tradingDayUnix: number,
  expiryUnix: number,
): boolean {
  if (tradingDayUnix <= 0 || expiryUnix <= 0) return false;
  const expectedExpiry = expiryUnixForTradingDay(
    new Date(tradingDayUnix * 1000),
  );
  return expiryUnix === expectedExpiry;
}

/**
 * One-shot sweep: query, filter, settle. Designed to be called on a
 * recurring schedule from index.ts.
 */
export async function runExpirySweep(env: Env): Promise<ExpirySweepResult> {
  const ctx = buildAnchor(env);
  const pyth = new PythClient(env.PYTH_HERMES_URL);
  const alerter = new SlackAlerter(env.SLACK_WEBHOOK_URL);

  const nowUnix = Math.floor(Date.now() / 1000);
  const cutoff = nowUnix - EXPIRY_GRACE_SECS;

  // Pull every Market account in one call. For a tiny number of markets
  // (Meridian's daily ladder is ~35-49 per day) this is the right shape;
  // if Meridian ever scales to thousands, we add a getMultipleAccounts
  // index here. Until then, the simpler walk wins on clarity.
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const allMarkets: any[] = await (ctx.program.account as any).market.all();

  // Two-stage filter:
  //  1. Pending + past-expiry-plus-grace. Cheap, no PDA derivation.
  //  2. Not a production-daily-ladder market. Custom admin-created
  //     markets only; the 16:05 ET production cron owns the daily ladder.
  //     See `isProductionDailyLadderMarket` comment for the rationale and
  //     the QA-adversary finding this gate addresses (sweep at 16:00:30 ET
  //     pre-empting the 16:05 cron's 15-minute Pyth retry window).
  let skippedProductionMarket = 0;
  const expiredPending = allMarkets.filter((m) => {
    const state = Object.keys(m.account.outcome.state)[0];
    if (state !== "pending") return false;
    const expiry = Number(m.account.expiryUnix.toString());
    if (!(expiry > 0 && expiry <= cutoff)) return false;
    const tradingDay = Number(m.account.tradingDayUnix.toString());
    if (isProductionDailyLadderMarket(tradingDay, expiry)) {
      skippedProductionMarket += 1;
      return false;
    }
    return true;
  });

  if (expiredPending.length === 0) {
    if (skippedProductionMarket > 0) {
      logger.info(
        { nowUnix, cutoff, skippedProductionMarket },
        "expiry-sweep: tick saw only production-ladder markets; left for the 16:05 ET cron",
      );
    }
    return {
      nowUnix,
      observed: 0,
      settledViaPyth: 0,
      settledViaManual: 0,
      stillPending: 0,
      skippedUnknownTicker: 0,
      skippedProductionMarket,
    };
  }

  logger.info(
    { nowUnix, cutoff, observed: expiredPending.length, skippedProductionMarket },
    "expiry-sweep: found expired-pending markets (custom only; production ladder skipped)",
  );

  let settledViaPyth = 0;
  let settledViaManual = 0;
  let stillPending = 0;
  let skippedUnknownTicker = 0;

  for (const m of expiredPending) {
    const ticker = decodeTicker(m.account.ticker);
    if (!MAG7_TICKERS.includes(ticker as PythTicker)) {
      // We log and count, but do NOT Slack-alert here. An unknown ticker
      // is a config / seed-data shape bug, not an operational incident,
      // and the sweep runs every 30 seconds; a Slack flood would
      // submerge real alerts.
      logger.warn(
        { ticker, market: m.publicKey.toBase58() },
        "expiry-sweep: market with unknown ticker; skipping",
      );
      skippedUnknownTicker += 1;
      continue;
    }
    const feedId = pythFeedFor(env, ticker as PythTicker);

    // Step 1: try the Pyth primary path. Wrapping in try/catch instead of
    // a retry loop because the sweep itself runs every 30 seconds — the
    // next tick IS the retry. The 16:05 cron's 15-minute retry-with-30s
    // intervals is the right shape for a once-a-day fire; for a
    // recurring sweep, single-attempt-per-tick avoids stacking work and
    // keeps tick durations bounded.
    let pythSettled = false;
    try {
      // Pre-flight: check Hermes confidence off-chain before paying gas
      // to post on-chain. Same guard the 16:05 cron uses (settlement.ts
      // line 81); if Hermes itself reports a wide confidence band, the
      // on-chain check will reject too and we save a transaction round
      // trip.
      const offchain = await pyth.getLatest(feedId);
      if (!offchain) {
        throw new Error(`Hermes returned no price for feed ${feedId}`);
      }
      if (offchain.confBps > env.PYTH_MAX_CONFIDENCE_BPS) {
        throw new Error(
          `Hermes confidence ${offchain.confBps} bps exceeds max ${env.PYTH_MAX_CONFIDENCE_BPS} bps`,
        );
      }
      const result = await settleMarketWithPyth(
        ctx,
        env.PYTH_HERMES_URL,
        m.publicKey,
        feedId,
      );
      logger.info(
        { market: m.publicKey.toBase58(), ticker, sig: result.settleSig },
        "expiry-sweep: settled via Pyth",
      );
      settledViaPyth += 1;
      pythSettled = true;
    } catch (err) {
      // Expected off-hours: Pyth feed is stale or confidence too wide.
      // Falling through to the manual path below.
      logger.info(
        { market: m.publicKey.toBase58(), ticker, err: String(err) },
        "expiry-sweep: Pyth path failed; trying settle_market_manual fallback",
      );
    }
    if (pythSettled) continue;

    // Step 2: fall back to settle_market_manual with the last Hermes
    // price. Hermes continues to serve the last published price even
    // when the underlying market is closed; the confidence band widens
    // but the price itself is the most recent honest Pyth quote. For
    // the test path this is the genuine close-comparable number;
    // bypassing the on-chain freshness check is the only piece of
    // off-hours testing accommodation, and it lives behind admin auth.
    try {
      const offchain = await pyth.getLatest(feedId);
      if (!offchain) {
        throw new Error(`Hermes has no last-known price for fallback (feed ${feedId})`);
      }
      // Convert the human-decimal price to USDC base units (micros). The
      // on-chain instruction expects u64 micros and computes outcome by
      // comparing to market.strike_usd_micros, so the units must match.
      const closeMicros = BigInt(Math.round(offchain.price * Number(USDC_BASE)));
      if (closeMicros <= 0n) {
        throw new Error(
          `Hermes price ${offchain.price} rounded to <= 0 micros; refusing to call settle_market_manual`,
        );
      }
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const sig = await (ctx.program.methods as any)
        .settleMarketManual(new BN(closeMicros.toString()))
        .accounts({
          config: configPda(ctx.programId),
          market: m.publicKey,
          admin: ctx.adminKeypair.publicKey,
        })
        .signers([ctx.adminKeypair])
        .rpc();
      logger.info(
        {
          market: m.publicKey.toBase58(),
          ticker,
          closeMicros: closeMicros.toString(),
          sig,
        },
        "expiry-sweep: settled via settle_market_manual fallback",
      );
      settledViaManual += 1;
    } catch (err) {
      stillPending += 1;
      // Both paths failed. This is a real operational issue worth a
      // Slack ping: it means the admin keypair cannot sign OR the on-
      // chain account state is inconsistent OR Hermes itself is down.
      // We DO want to know about this. Throttle is implicit: the alerter
      // sends a hash-deduped message per (market, ticker) within a
      // rolling window, so a market that fails on every 30s tick gets
      // one alert, not 120 alerts per hour.
      await alerter.fire({
        title: `Expiry sweep: BOTH Pyth and manual paths failed for ${ticker}`,
        body:
          `Market ${m.publicKey.toBase58()} expired at ${new Date(
            Number(m.account.expiryUnix.toString()) * 1000,
          ).toISOString()} and could not be settled. Manual intervention may be required.`,
        fields: {
          ticker,
          market: m.publicKey.toBase58(),
          err: String(err),
        },
      });
      logger.error(
        { market: m.publicKey.toBase58(), ticker, err: String(err) },
        "expiry-sweep: BOTH paths failed",
      );
    }
  }

  logger.info(
    {
      nowUnix,
      observed: expiredPending.length,
      settledViaPyth,
      settledViaManual,
      stillPending,
      skippedUnknownTicker,
      skippedProductionMarket,
    },
    "expiry-sweep: tick complete",
  );

  return {
    nowUnix,
    observed: expiredPending.length,
    settledViaPyth,
    settledViaManual,
    stillPending,
    skippedUnknownTicker,
    skippedProductionMarket,
  };
}

/**
 * Decode a 6-byte ticker buffer (zero-padded ASCII) back to a string.
 * Same shape as settlement.ts's local helper; kept inline here instead of
 * extracted to lib/ to avoid a one-call util churn that the codebase
 * does not yet need.
 */
function decodeTicker(bytes: number[] | Uint8Array): string {
  const buf = Buffer.from(bytes);
  const end = buf.indexOf(0);
  return end === -1 ? buf.toString("ascii") : buf.subarray(0, end).toString("ascii");
}
