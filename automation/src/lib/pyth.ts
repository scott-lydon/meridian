// Pyth Hermes client. Fetches latest equity prices off-chain for the morning
// strike-creation job. Settlement reads Pyth on-chain via the receiver SDK
// (slice 2). This file is the off-chain piece only.

import { request } from "undici";
import { z } from "zod";

import { logger } from "./logger.js";

const HERMES_PARSED = z.object({
  parsed: z.array(
    z.object({
      id: z.string(),
      price: z.object({
        price: z.string(),
        conf: z.string(),
        expo: z.number().int(),
        publish_time: z.number().int(),
      }),
      metadata: z.object({
        slot: z.number().int().optional(),
        proof_available_time: z.number().int().optional(),
        prev_publish_time: z.number().int().optional(),
      }).partial().optional(),
    }),
  ),
});

export interface PythPrice {
  readonly feedId: string;
  /** Decoded human price, e.g. 30.0115 for AAPL. */
  readonly price: number;
  /** Confidence interval in same units as price. */
  readonly conf: number;
  /** Confidence as basis points of the price (10000 = 100%). */
  readonly confBps: number;
  /** Pyth publish_time as unix seconds. */
  readonly publishTime: number;
  /** How old in seconds the price is, evaluated at the current wall clock. */
  readonly ageSecs: number;
}

const TICKER_PATH = {
  AAPL: "Equity.US.AAPL/USD",
  MSFT: "Equity.US.MSFT/USD",
  GOOGL: "Equity.US.GOOGL/USD",
  AMZN: "Equity.US.AMZN/USD",
  NVDA: "Equity.US.NVDA/USD",
  META: "Equity.US.META/USD",
  TSLA: "Equity.US.TSLA/USD",
} as const;

export type PythTicker = keyof typeof TICKER_PATH;

export class PythClient {
  constructor(private readonly hermesUrl: string) {}

  /**
   * Fetch the latest published price for one feed.
   * Returns `null` only when the feed has never published. Network errors
   * throw — caller decides whether to retry.
   */
  async getLatest(feedId: string): Promise<PythPrice | null> {
    const url = `${this.hermesUrl}/v2/updates/price/latest?ids[]=${feedId}`;
    const res = await request(url, { method: "GET" });
    if (res.statusCode !== 200) {
      const body = await res.body.text();
      throw new Error(
        `Hermes price fetch failed for feed=${feedId} status=${res.statusCode} body=${body}`,
      );
    }
    const json: unknown = await res.body.json();
    const parsed = HERMES_PARSED.safeParse(json);
    if (!parsed.success) {
      logger.error({ feedId, issues: parsed.error.issues }, "Hermes response did not parse");
      throw new Error(`Hermes response shape unexpected for feed=${feedId}`);
    }
    const entry = parsed.data.parsed[0];
    if (!entry) return null;

    const rawPrice = BigInt(entry.price.price);
    const rawConf = BigInt(entry.price.conf);
    const expo = entry.price.expo;
    // WTF heads-up: parsing as BigInt then coercing to Number looks lossy,
    // but Pyth equity feeds use expo around -8, which keeps the raw integer
    // in the low billions even for $1000 stocks (well under 2^53). Exact
    // for these feeds. Do NOT copy this pattern for crypto feeds where the
    // raw value can exceed 2^53 and silent precision loss starts.
    const scaled = Number(rawPrice) * 10 ** expo;
    const confScaled = Number(rawConf) * 10 ** expo;

    const now = Math.floor(Date.now() / 1000);
    return {
      feedId,
      price: scaled,
      conf: confScaled,
      confBps: Math.round((Number(rawConf) * 10000) / Number(rawPrice)),
      publishTime: entry.price.publish_time,
      ageSecs: now - entry.price.publish_time,
    };
  }

  /** Fetch all 7 MAG7 prices in parallel; throws if any feed fails. */
  async getAllMag7(
    feedIds: Record<PythTicker, string>,
  ): Promise<Record<PythTicker, PythPrice>> {
    const tickers = Object.keys(feedIds) as PythTicker[];
    const results = await Promise.all(
      tickers.map(async (t) => {
        const p = await this.getLatest(feedIds[t]);
        if (!p) throw new Error(`Pyth has no published price for ${t}`);
        return [t, p] as const;
      }),
    );
    return Object.fromEntries(results) as Record<PythTicker, PythPrice>;
  }
}
