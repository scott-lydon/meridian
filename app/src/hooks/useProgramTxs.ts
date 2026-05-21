"use client";

import { useQuery } from "@tanstack/react-query";
import { useConnection } from "@solana/wallet-adapter-react";
import { PublicKey } from "@solana/web3.js";

import { programIdPubkey } from "@/lib/anchor";

export interface TxRecord {
  signature: string;
  slot: number;
  blockTime: number | null;
  err: unknown;
}

/** Most recent N signatures touching the Meridian program. */
export function useProgramTxs(limit = 25) {
  const { connection } = useConnection();
  return useQuery<TxRecord[]>({
    queryKey: ["program-txs", limit],
    queryFn: async () => {
      const sigs = await connection.getSignaturesForAddress(programIdPubkey(), {
        limit,
      });
      return sigs.map((s) => ({
        signature: s.signature,
        slot: s.slot,
        blockTime: s.blockTime ?? null,
        err: s.err,
      }));
    },
    refetchInterval: 10_000,
  });
}

export interface VaultBalance {
  vaultPubkey: string;
  usdcMicros: bigint;
}

/** Sum of every market's vault balance (for the on-chain $1.00 invariant audit). */
export function useVaultSum(vaults: PublicKey[] | undefined) {
  const { connection } = useConnection();
  return useQuery<{ total: bigint; perVault: VaultBalance[] }>({
    queryKey: ["vault-sum", vaults?.map((v) => v.toBase58()).join(",") ?? ""],
    enabled: !!vaults && vaults.length > 0,
    queryFn: async () => {
      if (!vaults || vaults.length === 0) return { total: 0n, perVault: [] };
      const accounts = await connection.getMultipleAccountsInfo(vaults);
      const perVault: VaultBalance[] = [];
      let total = 0n;
      for (let i = 0; i < vaults.length; i++) {
        const a = accounts[i];
        const v = vaults[i]!;
        if (!a) {
          perVault.push({ vaultPubkey: v.toBase58(), usdcMicros: 0n });
          continue;
        }
        // SPL Token account layout: amount is 8 bytes at offset 64, little-endian.
        const amount = a.data.readBigUInt64LE(64);
        perVault.push({ vaultPubkey: v.toBase58(), usdcMicros: amount });
        total += amount;
      }
      return { total, perVault };
    },
    refetchInterval: 8_000,
  });
}
