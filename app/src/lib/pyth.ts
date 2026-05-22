// Pyth configuration for the frontend live-price feed.
//
// Why this file exists: constitution section 5 forbids hardcoded oracle
// feed IDs inside hooks/components — they should be operator-overridable
// without a code deploy. Before this refactor, app/src/hooks/usePythLive.ts
// embedded the 7 MAG7 feed IDs and the Hermes URL inline, which meant a
// Pyth feed rotation would require an emergency PR + deploy.
//
// Resolution: read from `NEXT_PUBLIC_PYTH_*` env at module load (the
// canonical source). Fall back to the documented `.env.example` values as
// a transitional safety net so an in-flight Render/Vercel deploy that
// hasn't been updated yet doesn't fail to boot. The fallback prints a
// `console.warn` so the operator sees the gap on first page load.
//
// To fully comply with constitution section 5 in production, set the
// NEXT_PUBLIC_PYTH_* vars in your deploy platform (Render Dashboard →
// Environment, or Vercel → Settings → Environment Variables). Once set,
// the fallback warning disappears.
//
// The automation service has a parallel reader at
// `automation/src/lib/env.ts` (`pythFeedFor`); the two layers MUST stay
// in sync because the markets page shows traders the price that settlement
// will use, and divergence is user-visible silent drift.

import { z } from "zod";

/** The seven MAG7 tickers Meridian supports in v1. Mirrors automation's `MAG7_TICKERS`. */
export const MAG7_TICKERS = ["AAPL", "MSFT", "GOOGL", "AMZN", "NVDA", "META", "TSLA"] as const;
export type Mag7Ticker = (typeof MAG7_TICKERS)[number];

// Last verified 2026-05-20 against Hermes /v2/price_feeds?asset_type=equity.
// Mirror of .env.example. If Pyth rotates a feed ID, update BOTH this map
// AND .env.example AND the automation mirror at automation/src/lib/env.ts
// in the same commit. Falls back to here only when env is missing.
const FALLBACK_FEEDS: Record<Mag7Ticker, string> = {
  AAPL: "5a207c4aa0114baecf852fcd9db9beb8ec715f2db48caa525dbd878fd416fb09",
  MSFT: "8f98f8267ddddeeb61b4fd11f21dc0c2842c417622b4d685243fa73b5830131f",
  GOOGL: "88d0800b1649d98e21b8bf9c3f42ab548034d62874ad5d80e1c1b730566d7f61",
  AMZN: "82c59e36a8e0247e15283748d6cd51f5fa1019d73fbf3ab6d927e17d9e357a7f",
  NVDA: "61c4ca5b9731a79e285a01e24432d57d89f0ecdd4cd7828196ca8992d5eafef6",
  META: "399f1e8f1c4a517859963b56f104727a7a3c7f0f8fee56d34fa1f72e5a4b78ef",
  TSLA: "42676a595d0099c381687124805c8bb22c75424dffcaa55e3dc6549854ebe20a",
};
const FALLBACK_HERMES_URL = "https://hermes.pyth.network";

const HEX_FEED = z.string().regex(/^[0-9a-f]{64}$/i, "Pyth feed ID must be 64 hex chars");
const PythEnv = z.object({
  hermesUrl: z.string().url(),
  AAPL: HEX_FEED,
  MSFT: HEX_FEED,
  GOOGL: HEX_FEED,
  AMZN: HEX_FEED,
  NVDA: HEX_FEED,
  META: HEX_FEED,
  TSLA: HEX_FEED,
});

function readWithFallback(envValue: string | undefined, fallback: string, name: string): string {
  if (envValue && envValue.length > 0) return envValue;
  // Warn ONLY in the browser; on the server during build, the env var legitimately
  // may not be set yet (Vercel / Render build envs differ from runtime envs). The
  // browser warning is the one operators will actually notice.
  if (typeof window !== "undefined") {
    // eslint-disable-next-line no-console
    console.warn(
      `[meridian/pyth] ${name} env var is not set; falling back to .env.example value. ` +
        `Set ${name} in your deploy platform (Render/Vercel dashboard) to remove this warning ` +
        `and fully comply with constitution section 5.`,
    );
  }
  return fallback;
}

const parsed = PythEnv.parse({
  hermesUrl: readWithFallback(
    process.env.NEXT_PUBLIC_PYTH_HERMES_URL,
    FALLBACK_HERMES_URL,
    "NEXT_PUBLIC_PYTH_HERMES_URL",
  ),
  AAPL: readWithFallback(
    process.env.NEXT_PUBLIC_PYTH_FEED_AAPL,
    FALLBACK_FEEDS.AAPL,
    "NEXT_PUBLIC_PYTH_FEED_AAPL",
  ),
  MSFT: readWithFallback(
    process.env.NEXT_PUBLIC_PYTH_FEED_MSFT,
    FALLBACK_FEEDS.MSFT,
    "NEXT_PUBLIC_PYTH_FEED_MSFT",
  ),
  GOOGL: readWithFallback(
    process.env.NEXT_PUBLIC_PYTH_FEED_GOOGL,
    FALLBACK_FEEDS.GOOGL,
    "NEXT_PUBLIC_PYTH_FEED_GOOGL",
  ),
  AMZN: readWithFallback(
    process.env.NEXT_PUBLIC_PYTH_FEED_AMZN,
    FALLBACK_FEEDS.AMZN,
    "NEXT_PUBLIC_PYTH_FEED_AMZN",
  ),
  NVDA: readWithFallback(
    process.env.NEXT_PUBLIC_PYTH_FEED_NVDA,
    FALLBACK_FEEDS.NVDA,
    "NEXT_PUBLIC_PYTH_FEED_NVDA",
  ),
  META: readWithFallback(
    process.env.NEXT_PUBLIC_PYTH_FEED_META,
    FALLBACK_FEEDS.META,
    "NEXT_PUBLIC_PYTH_FEED_META",
  ),
  TSLA: readWithFallback(
    process.env.NEXT_PUBLIC_PYTH_FEED_TSLA,
    FALLBACK_FEEDS.TSLA,
    "NEXT_PUBLIC_PYTH_FEED_TSLA",
  ),
});

const FEEDS_BY_TICKER: Record<Mag7Ticker, string> = {
  AAPL: parsed.AAPL,
  MSFT: parsed.MSFT,
  GOOGL: parsed.GOOGL,
  AMZN: parsed.AMZN,
  NVDA: parsed.NVDA,
  META: parsed.META,
  TSLA: parsed.TSLA,
};

/** Frontend Pyth configuration. Read once at module load, validated by zod. */
export const pyth = {
  hermesUrl: parsed.hermesUrl,
  feeds: FEEDS_BY_TICKER,
} as const;

/**
 * Returns the Pyth feed ID for a MAG7 ticker. Throws if the ticker is not in
 * the supported set; that case is unreachable at the type level but the
 * runtime check catches accidental `as Mag7Ticker` casts during refactors.
 */
export function pythFeedFor(ticker: Mag7Ticker): string {
  const feed = pyth.feeds[ticker];
  if (!feed) {
    throw new Error(
      `pythFeedFor: unknown MAG7 ticker '${ticker}'. ` +
        `Expected one of ${MAG7_TICKERS.join(", ")}. ` +
        `If a new ticker was added, update MAG7_TICKERS, .env.example, FALLBACK_FEEDS, ` +
        `and automation/src/lib/env.ts in the same commit.`,
    );
  }
  return feed;
}
