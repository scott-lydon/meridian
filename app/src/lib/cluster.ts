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

// Single source of truth for the official explorer.solana.com URLs we link
// out to. Bare `?cluster=mainnet-beta` is the mainnet path; `?cluster=devnet`
// for devnet; localnet uses the custom RPC param. Mainnet localnet would be
// nonsensical, so `localnet` keeps the same path mainnet uses with the
// custom URL appended so the user can paste it into the explorer's network
// switcher.
function explorerCluster(): string {
  switch (cluster.name) {
    case "mainnet":
      return "mainnet-beta";
    case "testnet":
      return "testnet";
    case "devnet":
      return "devnet";
    case "localnet":
      // The explorer UI calls this "custom"; users have to set the RPC URL
      // manually in the explorer's settings dialog, but linking with
      // ?cluster=custom is the canonical way.
      return "custom";
  }
}

/**
 * URL to view a Solana transaction signature on the official Solana
 * Explorer, scoped to the cluster Meridian itself is on. Caller passes the
 * raw signature string from a sendTransaction return value.
 *
 * Why centralize: the same URL was hard-coded with `?cluster=devnet` in at
 * least three places (TradePage, HistoryPage, admin force-settle toast),
 * and a mainnet bring-up that forgets to update one of them silently links
 * to the wrong cluster from the production UI.
 */
export function explorerTxUrl(signature: string): string {
  return `https://explorer.solana.com/tx/${signature}?cluster=${explorerCluster()}`;
}

/**
 * URL to view any Solana account / address / token-account / mint on the
 * official Solana Explorer. Same cluster-routing as `explorerTxUrl`.
 *
 * Use cases: the "view this token account on-chain" pills on the trade
 * page (see-for-yourself transparency rule in
 * `~/.claude/CLAUDE.md → transparency + debug routes`), and the "view this
 * wallet on Solana Explorer" link on the history page.
 */
export function explorerAddressUrl(address: string): string {
  return `https://explorer.solana.com/address/${address}?cluster=${explorerCluster()}`;
}
