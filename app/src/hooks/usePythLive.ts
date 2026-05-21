"use client";

import { useQuery } from "@tanstack/react-query";

export interface PythLivePrice {
  ticker: string;
  feedId: string;
  price: number;
  confBps: number;
  publishTime: number;
  ageSecs: number;
}

const FEEDS: Record<string, string> = {
  AAPL: "5a207c4aa0114baecf852fcd9db9beb8ec715f2db48caa525dbd878fd416fb09",
  MSFT: "8f98f8267ddddeeb61b4fd11f21dc0c2842c417622b4d685243fa73b5830131f",
  GOOGL: "88d0800b1649d98e21b8bf9c3f42ab548034d62874ad5d80e1c1b730566d7f61",
  AMZN: "82c59e36a8e0247e15283748d6cd51f5fa1019d73fbf3ab6d927e17d9e357a7f",
  NVDA: "61c4ca5b9731a79e285a01e24432d57d89f0ecdd4cd7828196ca8992d5eafef6",
  META: "399f1e8f1c4a517859963b56f104727a7a3c7f0f8fee56d34fa1f72e5a4b78ef",
  TSLA: "42676a595d0099c381687124805c8bb22c75424dffcaa55e3dc6549854ebe20a",
};

export function usePythLive() {
  return useQuery<PythLivePrice[]>({
    queryKey: ["pyth-live-mag7"],
    queryFn: async () => {
      const ids = Object.values(FEEDS)
        .map((id) => `ids[]=${id}`)
        .join("&");
      const url = `https://hermes.pyth.network/v2/updates/price/latest?${ids}`;
      const res = await fetch(url);
      if (!res.ok) {
        throw new Error(`Hermes returned HTTP ${res.status}`);
      }
      const json = (await res.json()) as {
        parsed: {
          id: string;
          price: { price: string; conf: string; expo: number; publish_time: number };
        }[];
      };
      const now = Math.floor(Date.now() / 1000);
      const out: PythLivePrice[] = [];
      for (const ticker of Object.keys(FEEDS)) {
        const feedId = FEEDS[ticker]!;
        const entry = json.parsed.find((p) => p.id === feedId);
        if (!entry) continue;
        const rawPrice = BigInt(entry.price.price);
        const rawConf = BigInt(entry.price.conf);
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
