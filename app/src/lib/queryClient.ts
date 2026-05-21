// TanStack Query client + stable key factory.
//
// Per plan.md §2.3: queryKeys are factored into a const so cache invalidations
// after on-chain writes hit the exact subset that changed.

import { QueryClient } from "@tanstack/react-query";

export const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      // Chain state changes per slot; default refetch keeps the UI honest.
      staleTime: 5_000,
      // Errors should bubble up so we can render them; no silent retries on RPC.
      retry: 1,
      refetchOnWindowFocus: true,
    },
    mutations: {
      retry: 0,
    },
  },
});

export const queryKeys = {
  usdcBalance: (owner: string) => ["usdc-balance", owner] as const,
  solBalance: (owner: string) => ["sol-balance", owner] as const,
  markets: (tradingDay: number) => ["markets", tradingDay] as const,
  market: (marketPda: string) => ["market", marketPda] as const,
  orderBook: (marketPda: string) => ["order-book", marketPda] as const,
  userPositions: (owner: string) => ["user-positions", owner] as const,
  oraclePrice: (ticker: string) => ["oracle-price", ticker] as const,
} as const;
