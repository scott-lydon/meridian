// Meridian Automation Service
// Slice 0: scaffold with a /health endpoint. Cron jobs land in slice 9.

import http from "node:http";
import process from "node:process";
import pino from "pino";

const log = pino({
  level: process.env.LOG_LEVEL ?? "info",
  // Per constitution §3 (TypeScript style): JSON output for production,
  // pretty-print only when explicitly requested.
  ...(process.env.LOG_PRETTY === "1"
    ? { transport: { target: "pino-pretty" } }
    : {}),
});

const port = Number.parseInt(process.env.PORT ?? "8080", 10);
if (!Number.isFinite(port) || port < 1 || port > 65535) {
  // Per constitution §2.4: no catch-log-continue. Surface and exit.
  log.fatal({ port: process.env.PORT }, "invalid PORT");
  process.exit(1);
}

const startedAt = new Date().toISOString();

const server = http.createServer((req, res) => {
  if (req.url === "/health") {
    res.writeHead(200, { "content-type": "application/json" });
    res.end(
      JSON.stringify({
        status: "ok",
        slice: 0,
        startedAt,
        now: new Date().toISOString(),
        lastMorningRun: null,
        lastSettlementRun: null,
        crankerStatus: "idle",
      }),
    );
    return;
  }
  res.writeHead(404, { "content-type": "text/plain" });
  res.end("not found\n");
});

server.listen(port, () => {
  log.info({ port }, "meridian automation listening (slice 0 scaffold)");
});

for (const sig of ["SIGTERM", "SIGINT"] as const) {
  process.on(sig, () => {
    log.info({ signal: sig }, "shutting down");
    server.close(() => process.exit(0));
  });
}
