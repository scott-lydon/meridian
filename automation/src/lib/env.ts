// Boot-time env validation. If anything is missing or malformed, the service
// fails fast with a message naming the missing key — per constitution §2.4
// (no catch-log-continue) and the user's preference for clear error messages.

import { z } from "zod";
// IMPORTANT: kept the alias `pythFeedFor` as the canonical export.

const TICKERS = ["AAPL", "MSFT", "GOOGL", "AMZN", "NVDA", "META", "TSLA"] as const;
export type Ticker = (typeof TICKERS)[number];

const FeedSchema = z.string().regex(/^[0-9a-f]{64}$/i, "feed id must be 64 hex chars");

const EnvSchema = z.object({
  SOLANA_RPC_URL: z.string().url(),
  SOLANA_WS_URL: z.string().url(),
  SOLANA_CLUSTER: z.enum(["devnet", "testnet", "mainnet", "localnet"]),
  MERIDIAN_PROGRAM_ID: z.string().min(32).max(44),
  USDC_MINT: z.string().min(32).max(44),
  PYTH_HERMES_URL: z.string().url(),
  PYTH_FEED_AAPL: FeedSchema,
  PYTH_FEED_MSFT: FeedSchema,
  PYTH_FEED_GOOGL: FeedSchema,
  PYTH_FEED_AMZN: FeedSchema,
  PYTH_FEED_NVDA: FeedSchema,
  PYTH_FEED_META: FeedSchema,
  PYTH_FEED_TSLA: FeedSchema,
  // Keypair sources: provide EITHER the PATH (local dev) OR the JSON
  // (Render / CI — paste the 64-byte secret key array). At least one of
  // each (admin/automation) must be present; checked at boot.
  ADMIN_KEYPAIR_PATH: z.string().optional(),
  ADMIN_KEYPAIR_JSON: z.string().optional(),
  AUTOMATION_KEYPAIR_PATH: z.string().optional(),
  AUTOMATION_KEYPAIR_JSON: z.string().optional(),
  CRANKER_KEYPAIR_PATH: z.string().optional(),
  CRANKER_KEYPAIR_JSON: z.string().optional(),
  PYTH_MAX_STALENESS_SECS: z.coerce.number().int().positive().default(300),
  PYTH_MAX_CONFIDENCE_BPS: z.coerce.number().int().positive().default(50),
  ADMIN_OVERRIDE_DELAY_SECS: z.coerce.number().int().positive().default(3600),
  PORT: z.coerce.number().int().positive().default(8080),
  LOG_LEVEL: z.enum(["trace", "debug", "info", "warn", "error", "fatal"]).default("info"),
  SLACK_WEBHOOK_URL: z.string().url().optional(),
  TZ: z.string().default("America/New_York"),
});

export type Env = z.infer<typeof EnvSchema>;

export function loadEnv(): Env {
  const result = EnvSchema.safeParse(process.env);
  if (!result.success) {
    const issues = result.error.issues
      .map((i) => `  - ${i.path.join(".")}: ${i.message}`)
      .join("\n");
    throw new Error(`Invalid environment:\n${issues}\nSee .env.example for required keys.`);
  }
  return result.data;
}

export function pythFeedFor(env: Env, ticker: Ticker): string {
  switch (ticker) {
    case "AAPL":
      return env.PYTH_FEED_AAPL;
    case "MSFT":
      return env.PYTH_FEED_MSFT;
    case "GOOGL":
      return env.PYTH_FEED_GOOGL;
    case "AMZN":
      return env.PYTH_FEED_AMZN;
    case "NVDA":
      return env.PYTH_FEED_NVDA;
    case "META":
      return env.PYTH_FEED_META;
    case "TSLA":
      return env.PYTH_FEED_TSLA;
  }
}

export const MAG7_TICKERS = TICKERS;
