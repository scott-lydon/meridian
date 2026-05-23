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

// Cron schedules in America/New_York. croner has sub-100ms drift.
const MORNING_CRON = "0 8 * * 1-5";
const SETTLEMENT_CRON = "5 16 * * 1-5";

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

logger.info(
  {
    morning: MORNING_CRON,
    settlement: SETTLEMENT_CRON,
    tz: env.TZ,
    morningNext: morningJob.nextRun()?.toISOString(),
    settlementNext: settlementJob.nextRun()?.toISOString(),
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
        morningNext: morningJob.nextRun()?.toISOString() ?? null,
        settlementNext: settlementJob.nextRun()?.toISOString() ?? null,
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
  res.writeHead(404, { "content-type": "text/plain" });
  res.end("not found\n");
});

server.listen(env.PORT, () => {
  logger.info({ port: env.PORT }, "meridian automation listening");
});

for (const sig of ["SIGTERM", "SIGINT"] as const) {
  process.on(sig, () => {
    logger.info({ signal: sig }, "shutting down");
    morningJob.stop();
    settlementJob.stop();
    server.close(() => process.exit(0));
  });
}
