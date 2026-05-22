"use client";

import { useQuery } from "@tanstack/react-query";

import { MAG7_TICKERS, pyth } from "@/lib/pyth";

export interface PythLivePrice {
  ticker: string;
  feedId: string;
  price: number;
  confBps: number;
  publishTime: number;
  ageSecs: number;
}

/**
 * Live MAG7 prices from Pyth Hermes. Refreshes every 5 seconds.
 *
 * Feed IDs and the Hermes URL come from `@/lib/pyth`, which reads them from
 * `NEXT_PUBLIC_PYTH_*` env at boot. Constitution section 5 forbids hardcoding
 * either of them here; if you find yourself wanting to inline a feed ID for
 * a quick fix, update `.env.example` and `@/lib/pyth` instead so the
 * automation service mirror stays in sync.
 */
export function usePythLive() {
  return useQuery<PythLivePrice[]>({
    queryKey: ["pyth-live-mag7", pyth.hermesUrl],
    queryFn: async () => {
      const ids = MAG7_TICKERS.map((t) => `ids[]=${pyth.feeds[t]}`).join("&");
      const url = `${pyth.hermesUrl}/v2/updates/price/latest?${ids}`;
      const res = await fetch(url);
      if (!res.ok) {
        throw new Error(
          `Pyth Hermes returned HTTP ${res.status} for ${url}. ` +
            `Check NEXT_PUBLIC_PYTH_HERMES_URL is reachable from the browser and that ` +
            `the feed IDs in NEXT_PUBLIC_PYTH_FEED_* are current (Hermes verified periodically).`,
        );
      }
      const json = (await res.json()) as {
        parsed: {
          id: string;
          price: { price: string; conf: string; expo: number; publish_time: number };
        }[];
      };
      const now = Math.floor(Date.now() / 1000);
      const out: PythLivePrice[] = [];
      for (const ticker of MAG7_TICKERS) {
        const feedId = pyth.feeds[ticker];
        const entry = json.parsed.find((p) => p.id === feedId);
        if (!entry) continue;
        const rawPrice = BigInt(entry.price.price);
        const rawConf = BigInt(entry.price.conf);
        // Pyth integer prices are well under 2^53 for equity feeds (price * 10^expo
        // with expo around -8 means the integer is in the low billions for $100-$1000
        // stocks). Safe to Number-coerce at the render boundary.
        const price = Number(rawPrice) * 10 ** entry.price.expo;
        const confBps = Math.round((Number(rawConf) * 10_000) / Number(rawPrice));
        out.push({
          ticker,
          feedId,
          price,
          confBps,
          publishTime: entry.price.publish_time,
          ageSecs: now - entry.price.publish_time,
        });
      }
      return out;
    },
    refetchInterval: 5_000,
  });
}
