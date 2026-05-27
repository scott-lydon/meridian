// Meridian Automation Service entrypoint.
//
// - Two crons: morning (08:00 ET) creates strike markets; settlement (16:05 ET)
//   resolves them via Pyth.
// - HTTP /health endpoint for Render's platform health check.
// - On boot, validates env (zod). Any missing key is a fatal error with a
//   clear message naming the field (constitution §2.4: no catch-log-continue).

import http from "node:http";
import { Cron } from "croner";

import { loadEnv } from "./lib/env.js";
import { logger } from "./lib/logger.js";
import { runMorningJob } from "./jobs/morning.js";
import { runSettlementJob } from "./jobs/settlement.js";
import { runExpirySweep } from "./jobs/expirySweep.js";
import { runSettleOneMarket } from "./jobs/settleOneMarket.js";
import {
  runCreateCustomMarket,
  CreateCustomMarketError,
} from "./jobs/createCustomMarket.js";
import { PublicKey } from "@solana/web3.js";
import { buildAnchor } from "./lib/anchor.js";
import { ensureOrderBook, EnsureOrderBookError } from "./jobs/ensureOrderBook.js";
import {
  runMatchSweep,
  runMatchOneMarket,
  MatchSweepError,
} from "./jobs/matchSweep.js";

const env = loadEnv();
const startedAt = new Date().toISOString();

// Each "last X run" record captures EITHER the successful result OR the
// swallowed error. Without the error branch, a silently-failing cron leaves
// `lastMorningRun: null` on /health for the entire weekend, which is exactly
// the failure mode the Vouch run on 2026-05-22 surfaced (the morning cron
// scheduled by croner appeared to skip today; without an error trail there
// was nothing to debug). The `error` field below makes the next failure
// self-diagnosing from /health alone.
interface CronRunRecord {
  at: string;
  result?: unknown;
  error?: string;
}
let lastMorningRun: CronRunRecord | null = null;
let lastSettlementRun: CronRunRecord | null = null;
let lastExpirySweepRun: CronRunRecord | null = null;
let lastMatchSweepRun: CronRunRecord | null = null;

// Cron schedules in America/New_York. croner has sub-100ms drift.
const MORNING_CRON = "0 8 * * 1-5";
const SETTLEMENT_CRON = "5 16 * * 1-5";
// Match sweep — invokes the on-chain `match_orders` cranker for every
// market with a crossed book. The cadence is the "how soon does my
// limit fill against an existing resting order" knob. 1 second is the
// minimum useful interval given Solana's ~400ms slot time: a tighter
// schedule would not produce visibly faster fills because the tx still
// has to wait for slot inclusion. Each tick reads every market account
// once via `program.account.market.all()`, then reads one OrderBook PDA
// per pending market. `protect: true` (set below on the croner Cron
// instance) ensures a long tick will not overlap with the next one, so
// a slow RPC pulse just means fewer ticks per minute, not piled-up work.
// croner extended-cron 6-field form, leading `* * * * * *` = every second.
//
// Why this cron has to exist: `place_order` (the on-chain instruction)
// only inserts into the slab; it never matches. The frontend `buyYes` /
// `sellYes` only sends `place_order`. Until this cron was added, every
// crossing order pair sat in the book unfilled (the failure reported on
// 2026-05-26 for market AAPL/3AL4SEZdBuJBo3BbBgRwzmxPmgaxfzNGJ1FJJrn7jmpD,
// where a 50¢ bid and a 50¢ ask coexisted for 101+ hours). See
// jobs/matchSweep.ts for the full rationale.
const MATCH_SWEEP_CRON = "* * * * * *";
// Expiry sweep runs every 30 seconds, every day. The cadence is the
// "how soon will my test market settle after expiry" knob. 30 seconds
// keeps the interactive test feel responsive without spamming the RPC
// node (the sweep does one `program.account.market.all()` call per tick,
// plus a settle tx per expired-pending market). Cron expression
// "*/30 * * * * *" is the croner extended-cron form (6 fields: sec min
// hr dom mon dow); croner supports the leading seconds field when the
// expression has 6 columns.
const EXPIRY_SWEEP_CRON = "*/30 * * * * *";

const morningJob = new Cron(MORNING_CRON, { timezone: env.TZ, name: "morning" }, async () => {
  // WTF guard: this looks like the catch-log-continue forbidden by
  // constitution §2.4, but throwing out of a croner callback kills the
  // whole cron loop (tomorrow's run never fires). We log and swallow so
  // a bad day doesn't take the schedule with it; Slack alerts inside
  // runMorningJob still surface the failure to humans.
  try {
    const result = await runMorningJob(env);
    lastMorningRun = { at: new Date().toISOString(), result };
  } catch (err) {
    // Croner unmounts the cron if the callback throws (kills tomorrow's run
    // and every run after), so we MUST swallow here — but we record the
    // failure on lastMorningRun so /health surfaces it instead of silently
    // staying `null` for a weekend. Slack alerts inside runMorningJob remain
    // the human-facing channel; this is the machine-readable trail.
    const message = err instanceof Error ? err.message : String(err);
    lastMorningRun = { at: new Date().toISOString(), error: message };
    logger.error({ err: message }, "morning job threw");
  }
});

const settlementJob = new Cron(
  SETTLEMENT_CRON,
  { timezone: env.TZ, name: "settlement" },
  async () => {
    // Same WTF guard as the morning job above: croner unmounts the cron
    // if the callback throws, so we eat the error and keep the schedule.
    try {
      const result = await runSettlementJob(env);
      lastSettlementRun = { at: new Date().toISOString(), result };
    } catch (err) {
      // See morning-job comment above: swallow to keep croner alive AND
      // record the failure so /health is self-diagnosing.
      const message = err instanceof Error ? err.message : String(err);
      lastSettlementRun = { at: new Date().toISOString(), error: message };
      logger.error({ err: message }, "settlement job threw");
    }
  },
);

// Expiry sweep — runs every 30 seconds, no trading-day filter. Settles
// any expired-pending market via Pyth-primary, settle_market_manual
// fallback. See jobs/expirySweep.ts for the full rationale: this is the
// mechanism that makes admin-created custom test markets auto-settle at
// their custom expiry without operator intervention.
//
// Croner concurrency note: by default croner refuses to overlap two
// invocations of the same Cron. So if a sweep tick takes 35 seconds
// (longer than the 30-second cadence), the next tick is skipped, not
// queued. That is the right default for this workload — duplicate
// settlement attempts are wasted RPC calls.
const expirySweepJob = new Cron(
  EXPIRY_SWEEP_CRON,
  { timezone: env.TZ, name: "expirySweep", protect: true },
  async () => {
    // Same WTF guard: croner unmounts the cron on throw. The sweep can
    // and will fail intermittently (Pyth flakiness, RPC throttling), and
    // we MUST keep the schedule alive across those failures. The error
    // is recorded on lastExpirySweepRun so /health is self-diagnosing.
    try {
      const result = await runExpirySweep(env);
      lastExpirySweepRun = { at: new Date().toISOString(), result };
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      lastExpirySweepRun = { at: new Date().toISOString(), error: message };
      logger.error({ err: message }, "expiry sweep job threw");
    }
  },
);

// Match sweep — every 5 seconds, calls match_orders on every crossed
// book. See MATCH_SWEEP_CRON above for the full rationale. Same WTF
// guard as the other crons: croner unmounts the cron on throw, so we
// MUST swallow exceptions here. lastMatchSweepRun captures the error so
// /health is self-diagnosing without a log scan.
//
// `protect: true` prevents two concurrent ticks. match_orders mutates
// the shared OrderBook slab; a race between two cranker invocations
// would either revert (account-version mismatch) or, worse, pay a maker
// twice if the program's idempotency check ever regressed. Better to
// skip a tick than to race.
const matchSweepJob = new Cron(
  MATCH_SWEEP_CRON,
  { timezone: env.TZ, name: "matchSweep", protect: true },
  async () => {
    try {
      const result = await runMatchSweep(env);
      lastMatchSweepRun = { at: new Date().toISOString(), result };
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      lastMatchSweepRun = { at: new Date().toISOString(), error: message };
      logger.error({ err: message }, "match sweep job threw");
    }
  },
);

logger.info(
  {
    morning: MORNING_CRON,
    settlement: SETTLEMENT_CRON,
    expirySweep: EXPIRY_SWEEP_CRON,
    matchSweep: MATCH_SWEEP_CRON,
    tz: env.TZ,
    morningNext: morningJob.nextRun()?.toISOString(),
    settlementNext: settlementJob.nextRun()?.toISOString(),
    expirySweepNext: expirySweepJob.nextRun()?.toISOString(),
    matchSweepNext: matchSweepJob.nextRun()?.toISOString(),
  },
  "crons scheduled",
);

// Boot-time catch-up. The Vouch 2026-05-22 run surfaced a real failure mode:
// a process that booted Thursday evening at 20:14 ET went 20+ hours without
// firing today's 08:00 ET morning cron, leaving lastMorningRun=null and the
// frontend showing "0 STRIKES today" all day. Whatever caused croner to miss
// that fire (renderer/process suspension, system clock slew, croner internal
// state), the cheap fix is: if (a) today is a trading day, (b) today's
// scheduled morning fire is already in the past, and (c) we have not yet
// recorded a morning run this trading day, then run it immediately and let
// croner pick up tomorrow. Same logic for settlement.
// Returns the UTC instant of today's slot at HH:MM in America/New_York.
// Factored out of maybeRunCatchupJobs because the catch-up logic for
// morning (08:00) and settlement (16:05) is the same shape; computing
// the slot in one place avoids duplicating the Intl gymnastics.
function todaysSlotEtMs(hour: number, minute: number): number | null {
  const fmt = new Intl.DateTimeFormat("en-US", {
    timeZone: env.TZ,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  });
  const parts = Object.fromEntries(
    fmt.formatToParts(new Date()).map((p) => [p.type, p.value]),
  );
  if (!parts.year) return null;
  const offsetMinutes = -new Date(
    `${parts.year}-${parts.month}-${parts.day}T12:00:00Z`,
  ).getTimezoneOffset();
  const sign = offsetMinutes >= 0 ? "+" : "-";
  const hh = String(Math.abs(Math.floor(offsetMinutes / 60))).padStart(2, "0");
  const mm = String(Math.abs(offsetMinutes % 60)).padStart(2, "0");
  const slot = `${String(hour).padStart(2, "0")}:${String(minute).padStart(2, "0")}`;
  const iso = `${parts.year}-${parts.month}-${parts.day}T${slot}:00${sign}${hh}:${mm}`;
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? null : d.getTime();
}

function maybeRunCatchupJobs(): void {
  const nowMs = Date.now();
  const today0800Et = todaysSlotEtMs(8, 0);
  const today1605Et = todaysSlotEtMs(16, 5);
  if (today0800Et == null || today1605Et == null) {
    logger.warn("catch-up: could not compute today's ET slots; skipping");
    return;
  }
  // Morning catch-up: if today's 08:00 ET slot is past and no run is
  // recorded, run now and let croner pick up tomorrow.
  if (nowMs >= today0800Et && !lastMorningRun) {
    logger.info(
      { today0800Et: new Date(today0800Et).toISOString() },
      "catch-up: today's morning slot has passed and no run is recorded; running now",
    );
    void (async () => {
      try {
        const result = await runMorningJob(env);
        lastMorningRun = { at: new Date().toISOString(), result };
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        lastMorningRun = { at: new Date().toISOString(), error: message };
        logger.error({ err: message }, "catch-up morning job threw");
      }
    })();
  }
  // Settlement catch-up: same shape, different slot. The original boot
  // catch-up only handled morning despite the comment claiming "same logic
  // for settlement". That gap is exactly why every market created Friday
  // 2026-05-22 stayed in AWAITING SETTLE through the weekend — the
  // settlement cron is gated by isUsTradingDay (which is false on
  // Sat/Sun) so a boot AFTER Friday's 16:05 slot has nothing else to
  // catch the missed run until Monday. Fixing it here so the next missed
  // slot recovers on the next boot without operator intervention.
  if (nowMs >= today1605Et && !lastSettlementRun) {
    logger.info(
      { today1605Et: new Date(today1605Et).toISOString() },
      "catch-up: today's settlement slot has passed and no run is recorded; running now",
    );
    void (async () => {
      try {
        const result = await runSettlementJob(env);
        lastSettlementRun = { at: new Date().toISOString(), result };
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        lastSettlementRun = { at: new Date().toISOString(), error: message };
        logger.error({ err: message }, "catch-up settlement job threw");
      }
    })();
  }
}
maybeRunCatchupJobs();

// CORS headers applied to PUBLIC, read-only endpoints (currently just /health).
// WHY: the audit page in the Next.js frontend fetches /health from the browser
// to display the cron lastRun / nextRun on a single dashboard. Without these
// headers the browser blocks the cross-origin request and surfaces
// `TypeError: Failed to fetch`, which a user reasonably reads as "the service
// is down" when it is actually running fine (Render's own server-to-server
// health probe is unaffected). Allow-Origin: * is acceptable here because
// /health exposes no per-user data — only public cron state and the public
// Solana cluster id. Admin endpoints like /trigger/morning intentionally do
// NOT get these headers, so a malicious page cannot CSRF the cranker.
const PUBLIC_CORS_HEADERS = {
  "access-control-allow-origin": "*",
  "access-control-allow-methods": "GET, OPTIONS",
  "access-control-allow-headers": "content-type",
  "access-control-max-age": "600",
} as const;

const server = http.createServer((req, res) => {
  // CORS preflight for /health. Modern browsers only preflight when the
  // request is non-simple (custom headers, credentialed, etc.); a plain GET
  // does not preflight. We still handle OPTIONS so a future change that adds
  // a header to the hook does not silently fail.
  if (req.method === "OPTIONS" && req.url === "/health") {
    res.writeHead(204, PUBLIC_CORS_HEADERS);
    res.end();
    return;
  }
  if (req.url === "/health") {
    res.writeHead(200, {
      "content-type": "application/json",
      ...PUBLIC_CORS_HEADERS,
    });
    res.end(
      JSON.stringify({
        status: "ok",
        startedAt,
        now: new Date().toISOString(),
        lastMorningRun,
        lastSettlementRun,
        lastExpirySweepRun,
        lastMatchSweepRun,
        morningNext: morningJob.nextRun()?.toISOString() ?? null,
        settlementNext: settlementJob.nextRun()?.toISOString() ?? null,
        expirySweepNext: expirySweepJob.nextRun()?.toISOString() ?? null,
        matchSweepNext: matchSweepJob.nextRun()?.toISOString() ?? null,
        cluster: env.SOLANA_CLUSTER,
      }),
    );
    return;
  }
  if (req.url === "/trigger/morning") {
    // Manual trigger for dev/devnet smoke tests.
    runMorningJob(env)
      .then((r) => {
        lastMorningRun = { at: new Date().toISOString(), result: r };
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify(r));
      })
      .catch((err) => {
        logger.error({ err: String(err) }, "manual morning trigger failed");
        res.writeHead(500, { "content-type": "application/json" });
        res.end(JSON.stringify({ error: String(err) }));
      });
    return;
  }
  if (req.url === "/trigger/settle") {
    // Manual settlement trigger. Mirrors /trigger/morning. Same intent:
    // unblock a manual recovery when the scheduled cron missed, without
    // shelling into the Render service. runSettlementJob is idempotent —
    // already-settled markets are filtered out by the
    // `Object.keys(...outcome.state)[0] === "pending"` filter. Safe to
    // call any number of times.
    //
    // WTF heads-up: runSettlementJob short-circuits with
    // settledViaPyth=0 / settledViaAdmin=0 / stillOpen=0 on weekends or
    // holidays (isUsTradingDay returns false), because it only ever
    // looks at TODAY's trading day. If you are calling this on a
    // Saturday to clean up Friday's missed settlement, the response
    // will be a "skipped" body and nothing will actually settle. For
    // that case the boot-time catch-up is the right path (kick a
    // redeploy or wait for the next service restart), since it does
    // not key off "today is a US trading day".
    runSettlementJob(env)
      .then((r) => {
        lastSettlementRun = { at: new Date().toISOString(), result: r };
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify(r));
      })
      .catch((err) => {
        logger.error({ err: String(err) }, "manual settle trigger failed");
        res.writeHead(500, { "content-type": "application/json" });
        res.end(JSON.stringify({ error: String(err) }));
      });
    return;
  }
  if (req.url === "/trigger/match") {
    // Manual trigger for the cross-the-book cranker. Sweeps every
    // pending market with both bids and asks and calls match_orders
    // until uncrossed. Same idempotency guarantees as the 1-second
    // cron — safe to call any number of times.
    //
    // Use case: an operator wants to unstick crossed orders RIGHT now
    // without waiting up to 1 second for the next cron tick. Also
    // useful when the cron has been temporarily disabled and we want
    // to manually batch-match on a redeploy.
    runMatchSweep(env)
      .then((r) => {
        lastMatchSweepRun = { at: new Date().toISOString(), result: r };
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify(r));
      })
      .catch((err: unknown) => {
        logger.error({ err: String(err) }, "manual match-sweep trigger failed");
        res.writeHead(500, { "content-type": "application/json" });
        res.end(JSON.stringify({ error: String(err) }));
      });
    return;
  }
  // ===== Admin-only: match a single market's order book on demand. =====
  //
  // POST /admin/match-market with JSON body { marketPubkey: "...base58..." }
  // and headers x-admin-username: admin / x-admin-password: pass.
  //
  // Why this exists: the 1-second `matchSweep` cron already cranks every
  // crossed book, but operators (and the trade page's repair toast) need
  // a way to manually unstick one specific market RIGHT now without
  // waiting up to 1 second, AND without paying the RPC cost of a full
  // sweep over every market. This is the single-market scalpel; the
  // /trigger/match endpoint is the broad sweep.
  //
  // Same admin/pass auth as /admin/create-market; same CORS posture.
  if (req.url === "/admin/match-market" && req.method === "OPTIONS") {
    res.writeHead(204, {
      "access-control-allow-origin": "*",
      "access-control-allow-methods": "POST, OPTIONS",
      "access-control-allow-headers": "content-type, x-admin-username, x-admin-password",
      "access-control-max-age": "600",
    });
    res.end();
    return;
  }
  if (req.url === "/admin/match-market" && req.method === "POST") {
    handleMatchMarket(req, res).catch((err: unknown) => {
      const message = err instanceof Error ? err.message : String(err);
      logger.error({ err: message }, "/admin/match-market top-level error");
      if (!res.headersSent) {
        res.writeHead(500, {
          "content-type": "application/json",
          "access-control-allow-origin": "*",
        });
        res.end(JSON.stringify({ error: "internal", message }));
      }
    });
    return;
  }
  // ===== Admin-only: create a custom market on demand. =====
  //
  // POST /admin/create-market with JSON body
  //   { ticker: "AAPL", strikeUsd: 309, expirySecondsFromNow: 120 }
  // and headers
  //   x-admin-username: admin
  //   x-admin-password: pass
  //
  // The username/password pair reuses the existing /admin sign-in
  // credentials hardcoded on the frontend in app/src/lib/adminMode.ts.
  // Same values, same posture, same "not a real security boundary"
  // rationale: the credentials are visible in the client bundle on
  // purpose. The actual boundary is the on-chain
  // `address = config.admin` check on create_strike_market. This
  // header pair exists to make casual /admin/* probes from random
  // visitors return 401 instead of triggering on-chain admin work.
  //
  // CORS preflight is supported so the Next.js frontend can call this
  // from the browser (browsers preflight any POST with non-simple
  // headers like x-admin-username).
  if (req.url === "/admin/create-market" && req.method === "OPTIONS") {
    res.writeHead(204, {
      "access-control-allow-origin": "*",
      "access-control-allow-methods": "POST, OPTIONS",
      "access-control-allow-headers": "content-type, x-admin-username, x-admin-password",
      "access-control-max-age": "600",
    });
    res.end();
    return;
  }
  if (req.url === "/admin/create-market" && req.method === "POST") {
    handleCreateMarket(req, res).catch((err) => {
      // Top-level safety net. Any failure inside handleCreateMarket that
      // escapes its own try/catch is a programmer bug; surface it
      // verbatim instead of returning a generic 500 so the next
      // diagnostic round is short.
      const message = err instanceof Error ? err.message : String(err);
      logger.error({ err: message }, "/admin/create-market top-level error");
      if (!res.headersSent) {
        res.writeHead(500, {
          "content-type": "application/json",
          "access-control-allow-origin": "*",
        });
        res.end(JSON.stringify({ error: "internal", message }));
      }
    });
    return;
  }

  // ===== Admin-only: settle a single market on demand. =====
  //
  // POST /admin/settle-market with JSON body { marketPubkey: "...base58..." }
  // and headers x-admin-username: admin / x-admin-password: pass.
  //
  // Why this exists: the 30-second expirySweep cron handles auto-settlement
  // for every past-expiry market without operator intervention, BUT the
  // sweep depends on the deployed automation service being up-to-date. If
  // the Render auto-deploy missed a commit (the failure mode that produced
  // the AAPL "Expired 74h 18m ago — awaiting settle" report on 2026-05-25),
  // there is no in-product affordance for the admin to force settle the
  // stuck market other than waiting for the next sweep tick AFTER the
  // service redeploys. This endpoint gives the trade page a button to call
  // immediately for that single market, using the same Pyth-primary +
  // settle_market_manual-fallback shape as the sweep.
  //
  // Same admin/pass auth as /admin/create-market; same CORS posture (we
  // intentionally allow cross-origin so the Next.js frontend can call us
  // from a browser session).
  if (req.url === "/admin/settle-market" && req.method === "OPTIONS") {
    res.writeHead(204, {
      "access-control-allow-origin": "*",
      "access-control-allow-methods": "POST, OPTIONS",
      "access-control-allow-headers": "content-type, x-admin-username, x-admin-password",
      "access-control-max-age": "600",
    });
    res.end();
    return;
  }
  if (req.url === "/admin/settle-market" && req.method === "POST") {
    handleSettleMarket(req, res).catch((err) => {
      const message = err instanceof Error ? err.message : String(err);
      logger.error({ err: message }, "/admin/settle-market top-level error");
      if (!res.headersSent) {
        res.writeHead(500, {
          "content-type": "application/json",
          "access-control-allow-origin": "*",
        });
        res.end(JSON.stringify({ error: "internal", message }));
      }
    });
    return;
  }

  // ===== Admin-only: initialize a market's order book on demand. =====
  //
  // POST /admin/init-order-book with JSON body { marketPubkey: "...base58..." }
  // and headers x-admin-username: admin / x-admin-password: pass.
  //
  // Why this exists: the on-chain `init_order_book` instruction has a
  // `address = config.admin` constraint, so the BROWSER cannot call it
  // directly — only this server (which holds the admin keypair) can.
  // Before this endpoint, a market created without an order book
  // (every market from the pre-fix morning cron) was non-tradable with
  // no in-product remediation; the user saw `Simulation failed →
  // Internal error` when they hit `Sell Yes` and there was no way to
  // recover without an operator shell session. This endpoint plus the
  // trade-page repair button makes the failure self-healing from the
  // signed-in admin's browser.
  //
  // Idempotent at the order-book PDA: if the book already exists, the
  // endpoint returns 200 with `alreadyInitialized: true` and no
  // transaction is issued. Safe to call from a retry loop.
  if (req.url === "/admin/init-order-book" && req.method === "OPTIONS") {
    res.writeHead(204, {
      "access-control-allow-origin": "*",
      "access-control-allow-methods": "POST, OPTIONS",
      "access-control-allow-headers": "content-type, x-admin-username, x-admin-password",
      "access-control-max-age": "600",
    });
    res.end();
    return;
  }
  if (req.url === "/admin/init-order-book" && req.method === "POST") {
    handleInitOrderBook(req, res).catch((err) => {
      const message = err instanceof Error ? err.message : String(err);
      logger.error({ err: message }, "/admin/init-order-book top-level error");
      if (!res.headersSent) {
        res.writeHead(500, {
          "content-type": "application/json",
          "access-control-allow-origin": "*",
        });
        res.end(JSON.stringify({ error: "internal", message }));
      }
    });
    return;
  }
  res.writeHead(404, { "content-type": "text/plain" });
  res.end("not found\n");
});

/**
 * Hardcoded admin credentials. SOURCE OF TRUTH for the frontend side is
 * app/src/lib/adminMode.ts (ADMIN_USERNAME / ADMIN_PASSWORD). The two
 * sides are kept in sync manually because the automation server and the
 * Next.js app are in separate workspaces; if you change one side, change
 * the other in the same commit.
 *
 * NOT a security boundary. These are visible in the client bundle on
 * purpose. See app/src/lib/adminMode.ts for the rationale. The actual
 * boundary is the on-chain `address = config.admin` check on
 * create_strike_market — only the admin keypair (held by this
 * automation server, never by the browser) can sign that instruction.
 */
const ADMIN_USERNAME = "admin";
const ADMIN_PASSWORD = "pass";

/**
 * Handle POST /admin/create-market. Streams the body, parses, authorizes,
 * runs the on-chain create+init flow, returns a JSON result the frontend
 * can use to redirect the admin to the new trade page.
 *
 * Error mapping:
 *   - missing/wrong x-admin-username + x-admin-password headers -> 401
 *   - invalid JSON body or missing fields -> 400
 *   - CreateCustomMarketError.code starting with INVALID_ -> 400
 *   - CreateCustomMarketError.code CONFIG_MISSING -> 503
 *   - CreateCustomMarketError.code *_TX_FAILED -> 502 (upstream Solana failure)
 *   - anything else -> 500
 */
async function handleCreateMarket(
  req: http.IncomingMessage,
  res: http.ServerResponse,
): Promise<void> {
  const corsHeaders = {
    "access-control-allow-origin": "*",
  } as const;
  const send = (status: number, body: object): void => {
    res.writeHead(status, {
      "content-type": "application/json",
      ...corsHeaders,
    });
    res.end(JSON.stringify(body));
  };

  // ===== Auth gate. =====
  // Reuses the same admin/pass credentials the /admin sign-in form on
  // the frontend already uses. No env vars, no shared secret to set in
  // Render — works out of the box, matching the existing pattern.
  const headerUser = req.headers["x-admin-username"];
  const headerPass = req.headers["x-admin-password"];
  const username = Array.isArray(headerUser) ? headerUser[0] : headerUser;
  const password = Array.isArray(headerPass) ? headerPass[0] : headerPass;
  if (username !== ADMIN_USERNAME || password !== ADMIN_PASSWORD) {
    return send(401, {
      error: "unauthorized",
      message:
        "missing or invalid x-admin-username + x-admin-password headers. " +
        "Sign in at /admin on the frontend first; the page picks up the " +
        "credentials from localStorage and includes them automatically.",
    });
  }

  // ===== Body parse. =====
  const chunks: Buffer[] = [];
  for await (const chunk of req) {
    chunks.push(chunk as Buffer);
    // Cap the body size at 8 KB. The expected payload is well under 1 KB.
    if (chunks.reduce((s, c) => s + c.length, 0) > 8 * 1024) {
      return send(413, {
        error: "body_too_large",
        message: "request body exceeded 8KB; expected a small JSON object",
      });
    }
  }
  const bodyStr = Buffer.concat(chunks).toString("utf8");
  let body: unknown;
  try {
    body = JSON.parse(bodyStr);
  } catch (err) {
    return send(400, {
      error: "invalid_json",
      message: `request body is not valid JSON: ${String(err)}`,
    });
  }
  if (typeof body !== "object" || body === null) {
    return send(400, {
      error: "invalid_body_shape",
      message: "request body must be a JSON object",
    });
  }
  const { ticker, strikeUsd, expirySecondsFromNow } = body as Record<string, unknown>;
  if (typeof ticker !== "string") {
    return send(400, {
      error: "missing_field",
      message: "field 'ticker' is required and must be a string",
    });
  }
  if (typeof strikeUsd !== "number") {
    return send(400, {
      error: "missing_field",
      message: "field 'strikeUsd' is required and must be a number",
    });
  }
  if (typeof expirySecondsFromNow !== "number") {
    return send(400, {
      error: "missing_field",
      message: "field 'expirySecondsFromNow' is required and must be a number",
    });
  }

  // ===== Run. =====
  try {
    const result = await runCreateCustomMarket(env, {
      ticker,
      strikeUsd,
      expirySecondsFromNow,
    });
    logger.info({ result }, "/admin/create-market succeeded");
    return send(200, result);
  } catch (err) {
    if (err instanceof CreateCustomMarketError) {
      if (err.code.startsWith("INVALID_")) {
        return send(400, { error: err.code.toLowerCase(), message: err.message });
      }
      if (err.code === "CONFIG_MISSING") {
        return send(503, { error: "config_missing", message: err.message });
      }
      if (err.code === "ADMIN_INSUFFICIENT_SOL") {
        return send(503, { error: "admin_insufficient_sol", message: err.message });
      }
      if (err.code === "CREATE_TX_FAILED" || err.code === "INIT_BOOK_TX_FAILED") {
        return send(502, { error: err.code.toLowerCase(), message: err.message });
      }
    }
    const message = err instanceof Error ? err.message : String(err);
    logger.error({ err: message }, "/admin/create-market unexpected error");
    return send(500, { error: "unexpected", message });
  }
}

/**
 * Handle POST /admin/settle-market. Streams the body, parses, authorizes,
 * runs a single-market Pyth-primary + settle_market_manual-fallback
 * settlement using the admin keypair, returns a JSON result the frontend
 * can use to update its banner.
 *
 * Error mapping:
 *   - missing/wrong x-admin-username + x-admin-password headers -> 401
 *   - invalid JSON body or missing marketPubkey -> 400
 *   - SettleOneMarketError.code MARKET_NOT_FOUND -> 404
 *   - SettleOneMarketError.code MARKET_ALREADY_SETTLED -> 409
 *   - SettleOneMarketError.code UNKNOWN_TICKER -> 422
 *   - SettleOneMarketError.code SETTLE_FAILED -> 502 (upstream Solana failure)
 *   - anything else -> 500
 */
async function handleSettleMarket(
  req: http.IncomingMessage,
  res: http.ServerResponse,
): Promise<void> {
  const corsHeaders = { "access-control-allow-origin": "*" } as const;
  const send = (status: number, body: object): void => {
    res.writeHead(status, { "content-type": "application/json", ...corsHeaders });
    res.end(JSON.stringify(body));
  };

  // Auth gate — same admin/pass shape as /admin/create-market.
  const headerUser = req.headers["x-admin-username"];
  const headerPass = req.headers["x-admin-password"];
  const username = Array.isArray(headerUser) ? headerUser[0] : headerUser;
  const password = Array.isArray(headerPass) ? headerPass[0] : headerPass;
  if (username !== ADMIN_USERNAME || password !== ADMIN_PASSWORD) {
    return send(401, {
      error: "unauthorized",
      message:
        "missing or invalid x-admin-username + x-admin-password headers. " +
        "Sign in at /admin on the frontend first; the page picks up the " +
        "credentials from localStorage and includes them automatically.",
    });
  }

  // Body parse with size cap (mirrors handleCreateMarket).
  const chunks: Buffer[] = [];
  for await (const chunk of req) {
    chunks.push(chunk as Buffer);
    if (chunks.reduce((s, c) => s + c.length, 0) > 8 * 1024) {
      return send(413, {
        error: "body_too_large",
        message: "request body exceeded 8KB; expected a small JSON object",
      });
    }
  }
  const bodyStr = Buffer.concat(chunks).toString("utf8");
  let body: unknown;
  try {
    body = JSON.parse(bodyStr);
  } catch (err) {
    return send(400, {
      error: "invalid_json",
      message: `request body is not valid JSON: ${String(err)}`,
    });
  }
  if (typeof body !== "object" || body === null) {
    return send(400, {
      error: "invalid_body_shape",
      message: "request body must be a JSON object",
    });
  }
  const { marketPubkey } = body as Record<string, unknown>;
  if (typeof marketPubkey !== "string" || marketPubkey.length < 32 || marketPubkey.length > 44) {
    return send(400, {
      error: "missing_field",
      message:
        "field 'marketPubkey' is required, must be a base58-encoded Solana account address (32-44 chars). " +
        "Got: " +
        JSON.stringify(marketPubkey),
    });
  }

  try {
    const result = await runSettleOneMarket(env, { marketPubkey });
    logger.info({ result }, "/admin/settle-market succeeded");
    return send(200, result);
  } catch (err) {
    // Lazy-import the error type to avoid circular ESM evaluation; runtime
    // shape check below is the actual gate.
    const { SettleOneMarketError } = await import("./jobs/settleOneMarket.js");
    if (err instanceof SettleOneMarketError) {
      if (err.code === "MARKET_NOT_FOUND") {
        return send(404, { error: "market_not_found", message: err.message });
      }
      if (err.code === "MARKET_ALREADY_SETTLED") {
        return send(409, { error: "market_already_settled", message: err.message });
      }
      if (err.code === "UNKNOWN_TICKER") {
        return send(422, { error: "unknown_ticker", message: err.message });
      }
      if (err.code === "SETTLE_FAILED") {
        return send(502, { error: "settle_failed", message: err.message });
      }
    }
    const message = err instanceof Error ? err.message : String(err);
    logger.error({ err: message }, "/admin/settle-market unexpected error");
    return send(500, { error: "unexpected", message });
  }
}

/**
 * Handle POST /admin/init-order-book. Streams the body, parses,
 * authorizes, runs the idempotent ensureOrderBook flow using the admin
 * keypair, returns a JSON result the frontend uses to refresh the
 * trade page.
 *
 * Response shape (200):
 *   {
 *     bookPubkey: string,
 *     bookAuthority: string,
 *     usdcEscrow: string,
 *     yesEscrow: string,
 *     sig: string | null,           // null when alreadyInitialized
 *     alreadyInitialized: boolean,
 *   }
 *
 * Error mapping:
 *   - missing/wrong x-admin-username + x-admin-password headers -> 401
 *   - invalid JSON body or missing marketPubkey -> 400
 *   - EnsureOrderBookError.code MARKET_NOT_FOUND -> 404
 *   - EnsureOrderBookError.code CONFIG_MISSING -> 503
 *   - EnsureOrderBookError.code INIT_BOOK_TX_FAILED -> 502 (upstream Solana)
 *   - anything else -> 500
 */
async function handleInitOrderBook(
  req: http.IncomingMessage,
  res: http.ServerResponse,
): Promise<void> {
  const corsHeaders = { "access-control-allow-origin": "*" } as const;
  const send = (status: number, body: object): void => {
    res.writeHead(status, { "content-type": "application/json", ...corsHeaders });
    res.end(JSON.stringify(body));
  };

  // Auth gate — same admin/pass shape as /admin/create-market and
  // /admin/settle-market. NOT a real security boundary; the actual
  // gate is the on-chain `address = config.admin` constraint, which
  // only the admin keypair (held by THIS server, never by the browser)
  // can satisfy.
  const headerUser = req.headers["x-admin-username"];
  const headerPass = req.headers["x-admin-password"];
  const username = Array.isArray(headerUser) ? headerUser[0] : headerUser;
  const password = Array.isArray(headerPass) ? headerPass[0] : headerPass;
  if (username !== ADMIN_USERNAME || password !== ADMIN_PASSWORD) {
    return send(401, {
      error: "unauthorized",
      message:
        "missing or invalid x-admin-username + x-admin-password headers. " +
        "Sign in at /admin on the frontend first; the page picks up the " +
        "credentials from localStorage and includes them automatically.",
    });
  }

  // Body parse with size cap (mirrors handleSettleMarket).
  const chunks: Buffer[] = [];
  for await (const chunk of req) {
    chunks.push(chunk as Buffer);
    if (chunks.reduce((s, c) => s + c.length, 0) > 8 * 1024) {
      return send(413, {
        error: "body_too_large",
        message: "request body exceeded 8KB; expected a small JSON object",
      });
    }
  }
  const bodyStr = Buffer.concat(chunks).toString("utf8");
  let body: unknown;
  try {
    body = JSON.parse(bodyStr);
  } catch (err) {
    return send(400, {
      error: "invalid_json",
      message: `request body is not valid JSON: ${String(err)}`,
    });
  }
  if (typeof body !== "object" || body === null) {
    return send(400, {
      error: "invalid_body_shape",
      message: "request body must be a JSON object",
    });
  }
  const { marketPubkey } = body as Record<string, unknown>;
  if (typeof marketPubkey !== "string" || marketPubkey.length < 32 || marketPubkey.length > 44) {
    return send(400, {
      error: "missing_field",
      message:
        "field 'marketPubkey' is required, must be a base58-encoded Solana account address (32-44 chars). " +
        "Got: " +
        JSON.stringify(marketPubkey),
    });
  }
  // Parse the pubkey at the boundary; surface a precise 400 instead of
  // letting a generic 500 fall out of ensureOrderBook later.
  let marketKey: PublicKey;
  try {
    marketKey = new PublicKey(marketPubkey);
  } catch (err) {
    return send(400, {
      error: "invalid_pubkey",
      message: `field 'marketPubkey' is not a valid base58 Solana pubkey: ${
        err instanceof Error ? err.message : String(err)
      }`,
    });
  }

  try {
    // Build the Anchor context lazily here (vs at module-init time) so
    // the endpoint can run even if a future change moves the env load
    // around. buildAnchor is cheap and stateless aside from RPC + key
    // load.
    const ctx = buildAnchor(env);
    const usdcMint = new PublicKey(env.USDC_MINT);
    const result = await ensureOrderBook(ctx, marketKey, usdcMint);
    logger.info({ result }, "/admin/init-order-book succeeded");
    return send(200, result);
  } catch (err) {
    if (err instanceof EnsureOrderBookError) {
      if (err.code === "MARKET_NOT_FOUND") {
        return send(404, { error: "market_not_found", message: err.message });
      }
      if (err.code === "CONFIG_MISSING") {
        return send(503, { error: "config_missing", message: err.message });
      }
      if (err.code === "ADMIN_INSUFFICIENT_SOL") {
        // 503 + distinct slug so the trade page can render a specific
        // "top up the admin keypair" CTA. 502 would mislead operators
        // into thinking it was an RPC failure.
        return send(503, { error: "admin_insufficient_sol", message: err.message });
      }
      if (err.code === "INIT_BOOK_TX_FAILED") {
        return send(502, { error: "init_book_tx_failed", message: err.message });
      }
    }
    const message = err instanceof Error ? err.message : String(err);
    logger.error({ err: message }, "/admin/init-order-book unexpected error");
    return send(500, { error: "unexpected", message });
  }
}

/**
 * Handle POST /admin/match-market. Streams the body, parses, authorizes,
 * runs the single-market match cranker, returns a JSON result.
 *
 * Response shape (200):
 *   {
 *     market: string,           // base58 of the market we matched
 *     matchesIssued: number,    // count of match_orders ix's sent
 *     crossedAtStart: boolean,  // whether the book was crossed on entry
 *     stillCrossed: boolean,    // true if we ran out of iterations
 *   }
 *
 * Error mapping:
 *   - missing/wrong x-admin-username + x-admin-password headers -> 401
 *   - invalid JSON body or missing marketPubkey -> 400
 *   - MatchSweepError.code MARKET_NOT_FOUND -> 404
 *   - MatchSweepError.code ORDER_BOOK_MISSING -> 409 (book PDA absent;
 *     caller should hit /admin/init-order-book first)
 *   - MatchSweepError.code BOOK_DECODE_FAILED -> 500 (IDL drift)
 *   - MatchSweepError.code MATCH_TX_FAILED -> 502 (upstream Solana)
 *   - anything else -> 500
 *
 * Same admin/pass auth shape as the sibling handlers above; same
 * "not a real security boundary" rationale (the real gate is the on-
 * chain account constraints — there is NO admin-only constraint on
 * match_orders itself, which is intentionally permissionless, but the
 * automation keypair pays for the maker ATA rent and that posture is
 * what this header pair gates).
 */
async function handleMatchMarket(
  req: http.IncomingMessage,
  res: http.ServerResponse,
): Promise<void> {
  const corsHeaders = { "access-control-allow-origin": "*" } as const;
  const send = (status: number, body: object): void => {
    res.writeHead(status, { "content-type": "application/json", ...corsHeaders });
    res.end(JSON.stringify(body));
  };

  const headerUser = req.headers["x-admin-username"];
  const headerPass = req.headers["x-admin-password"];
  const username = Array.isArray(headerUser) ? headerUser[0] : headerUser;
  const password = Array.isArray(headerPass) ? headerPass[0] : headerPass;
  if (username !== ADMIN_USERNAME || password !== ADMIN_PASSWORD) {
    send(401, {
      error: "unauthorized",
      message:
        "missing or invalid x-admin-username + x-admin-password headers. " +
        "Sign in at /admin on the frontend first; the page picks up the " +
        "credentials from localStorage and includes them automatically.",
    });
    return;
  }

  const chunks: Buffer[] = [];
  for await (const chunk of req) {
    chunks.push(chunk as Buffer);
    if (chunks.reduce((s, c) => s + c.length, 0) > 8 * 1024) {
      send(413, {
        error: "body_too_large",
        message: "request body exceeded 8KB; expected a small JSON object",
      });
      return;
    }
  }
  const bodyStr = Buffer.concat(chunks).toString("utf8");
  let body: unknown;
  try {
    body = JSON.parse(bodyStr);
  } catch (err) {
    send(400, {
      error: "invalid_json",
      message: `request body is not valid JSON: ${String(err)}`,
    });
    return;
  }
  if (typeof body !== "object" || body === null) {
    send(400, {
      error: "invalid_body_shape",
      message: "request body must be a JSON object",
    });
    return;
  }
  const { marketPubkey } = body as Record<string, unknown>;
  if (
    typeof marketPubkey !== "string" ||
    marketPubkey.length < 32 ||
    marketPubkey.length > 44
  ) {
    send(400, {
      error: "missing_field",
      message:
        "field 'marketPubkey' is required, must be a base58-encoded Solana account address (32-44 chars). " +
        "Got: " +
        JSON.stringify(marketPubkey),
    });
    return;
  }
  let marketKey: PublicKey;
  try {
    marketKey = new PublicKey(marketPubkey);
  } catch (err) {
    send(400, {
      error: "invalid_pubkey",
      message: `field 'marketPubkey' is not a valid base58 Solana pubkey: ${
        err instanceof Error ? err.message : String(err)
      }`,
    });
    return;
  }

  try {
    const result = await runMatchOneMarket(env, marketKey);
    logger.info({ result }, "/admin/match-market succeeded");
    send(200, result);
    return;
  } catch (err) {
    if (err instanceof MatchSweepError) {
      if (err.code === "MARKET_NOT_FOUND") {
        send(404, { error: "market_not_found", message: err.message });
        return;
      }
      if (err.code === "ORDER_BOOK_MISSING") {
        send(409, { error: "order_book_missing", message: err.message });
        return;
      }
      if (err.code === "BOOK_DECODE_FAILED") {
        send(500, { error: "book_decode_failed", message: err.message });
        return;
      }
      if (err.code === "MATCH_TX_FAILED") {
        send(502, { error: "match_tx_failed", message: err.message });
        return;
      }
    }
    const message = err instanceof Error ? err.message : String(err);
    logger.error({ err: message }, "/admin/match-market unexpected error");
    send(500, { error: "unexpected", message });
  }
}

server.listen(env.PORT, () => {
  logger.info({ port: env.PORT }, "meridian automation listening");
});

for (const sig of ["SIGTERM", "SIGINT"] as const) {
  process.on(sig, () => {
    logger.info({ signal: sig }, "shutting down");
    morningJob.stop();
    settlementJob.stop();
    expirySweepJob.stop();
    matchSweepJob.stop();
    server.close(() => process.exit(0));
  });
}
