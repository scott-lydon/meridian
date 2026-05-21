// Cluster + RPC configuration. Reads from env at boot so a wallet pointing at
// the wrong cluster gets flagged in the UI immediately rather than silently
// erroring on the first transaction.

import { z } from "zod";

const ClusterEnv = z.object({
  NEXT_PUBLIC_SOLANA_RPC_URL: z.string().url(),
  NEXT_PUBLIC_SOLANA_WS_URL: z.string().url(),
  NEXT_PUBLIC_MERIDIAN_PROGRAM_ID: z.string().min(32).max(44),
  NEXT_PUBLIC_USDC_MINT: z.string().min(32).max(44),
  NEXT_PUBLIC_CIRCLE_FAUCET_URL: z.string().url().optional(),
});

const env = ClusterEnv.parse({
  NEXT_PUBLIC_SOLANA_RPC_URL: process.env.NEXT_PUBLIC_SOLANA_RPC_URL,
  NEXT_PUBLIC_SOLANA_WS_URL: process.env.NEXT_PUBLIC_SOLANA_WS_URL,
  NEXT_PUBLIC_MERIDIAN_PROGRAM_ID: process.env.NEXT_PUBLIC_MERIDIAN_PROGRAM_ID,
  NEXT_PUBLIC_USDC_MINT: process.env.NEXT_PUBLIC_USDC_MINT,
  NEXT_PUBLIC_CIRCLE_FAUCET_URL: process.env.NEXT_PUBLIC_CIRCLE_FAUCET_URL,
});

export const cluster = {
  rpcUrl: env.NEXT_PUBLIC_SOLANA_RPC_URL,
  wsUrl: env.NEXT_PUBLIC_SOLANA_WS_URL,
  programId: env.NEXT_PUBLIC_MERIDIAN_PROGRAM_ID,
  usdcMint: env.NEXT_PUBLIC_USDC_MINT,
  faucetUrl: env.NEXT_PUBLIC_CIRCLE_FAUCET_URL ?? "https://faucet.circle.com",
  name: deriveClusterName(env.NEXT_PUBLIC_SOLANA_RPC_URL),
} as const;

function deriveClusterName(rpcUrl: string): "devnet" | "testnet" | "mainnet" | "localnet" {
  if (rpcUrl.includes("devnet")) return "devnet";
  if (rpcUrl.includes("testnet")) return "testnet";
  if (rpcUrl.includes("mainnet")) return "mainnet";
  return "localnet";
}
