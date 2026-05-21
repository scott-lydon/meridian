// pino-based structured logger. Per plan.md decision row 15.
//
// Production: JSON output to stdout (Render scrapes this).
// Development: pretty-printed when LOG_PRETTY=1.

import pino from "pino";

export const logger = pino({
  level: process.env.LOG_LEVEL ?? "info",
  base: {
    service: "meridian-automation",
    cluster: process.env.SOLANA_CLUSTER ?? "unknown",
  },
  ...(process.env.LOG_PRETTY === "1"
    ? {
        transport: {
          target: "pino-pretty",
          options: { colorize: true, translateTime: "SYS:HH:MM:ss" },
        },
      }
    : {}),
});

export type Logger = typeof logger;
