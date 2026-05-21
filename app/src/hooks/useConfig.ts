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
      } catch {
        return null;
      }
    },
  });
}
