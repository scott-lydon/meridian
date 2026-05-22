"use client";

import { useQuery } from "@tanstack/react-query";
import { PublicKey } from "@solana/web3.js";

import { useMeridian } from "@/hooks/useMeridian";
import { configPda } from "@/lib/anchor";

export interface ConfigView {
  pda: string;
  admin: string;
  usdcMint: string;
  maxStalenessSecs: number;
  maxConfidenceBps: number;
  adminOverrideDelaySecs: number;
  paused: boolean;
  version: number;
}

export function useConfig() {
  const { program } = useMeridian();
  return useQuery<ConfigView | null>({
    queryKey: ["config", program.programId.toBase58()],
    queryFn: async () => {
      const pda = configPda();
      try {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const cfg: any = await (program.account as any).config.fetch(pda);
        return {
          pda: pda.toBase58(),
          admin: (cfg.admin as PublicKey).toBase58(),
          usdcMint: (cfg.usdcMint as PublicKey).toBase58(),
          maxStalenessSecs: Number(cfg.maxStalenessSecs.toString()),
          maxConfidenceBps: Number(cfg.maxConfidenceBps),
          adminOverrideDelaySecs: Number(cfg.adminOverrideDelaySecs.toString()),
          paused: Boolean(cfg.paused),
          version: Number(cfg.version),
        };
      } catch (err) {
        // Constitution §2.4: no catch-log-continue. The ONLY legitimate empty
        // state is "Config PDA hasn't been initialised yet" — every other
        // failure (RPC outage, IDL drift, decode error) is a real bug we want
        // surfaced loudly. Same allowlist pattern as useOrderBookFor.
        const msg = err instanceof Error ? err.message : String(err);
        if (/Account does not exist|could not find account/i.test(msg)) {
          return null;
        }
        throw new Error(
          `useConfig: failed to load Config PDA ${pda.toBase58()}: ${msg}`,
          { cause: err instanceof Error ? err : undefined },
        );
      }
    },
  });
}
