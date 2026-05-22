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
let lastMorningRun: { at: string; result: unknown } | null = null;
let lastSettlementRun: { at: string; result: unknown } | null = null;

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
    logger.error({ err: String(err) }, "morning job threw");
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
      logger.error({ err: String(err) }, "settlement job threw");
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

const server = http.createServer((req, res) => {
  if (req.url === "/health") {
    res.writeHead(200, { "content-type": "application/json" });
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
