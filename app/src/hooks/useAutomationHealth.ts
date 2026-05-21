"use client";

import { useQuery } from "@tanstack/react-query";

export interface AutomationHealth {
  status: string;
  startedAt: string;
  now: string;
  lastMorningRun: unknown;
  lastSettlementRun: unknown;
  morningNext: string | null;
  settlementNext: string | null;
  cluster: string;
}

const HEALTH_URL = "https://meridian-automation.onrender.com/health";

export function useAutomationHealth() {
  return useQuery<AutomationHealth | { error: string }>({
    queryKey: ["automation-health"],
    queryFn: async () => {
      try {
        const res = await fetch(HEALTH_URL, { signal: AbortSignal.timeout(8000) });
        if (!res.ok) {
          return { error: `automation responded HTTP ${res.status}` };
        }
        return (await res.json()) as AutomationHealth;
      } catch (e) {
        return { error: e instanceof Error ? e.message : String(e) };
      }
    },
    refetchInterval: 15_000,
  });
}
