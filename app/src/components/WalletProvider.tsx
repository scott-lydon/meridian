"use client";

// Wallet adapter + connection provider for the whole app.
// Per plan.md decisions table row 7: @solana/wallet-adapter with Phantom,
// Solflare, Backpack. Provider lives at the root layout.

import { useMemo } from "react";
import type { ReactNode } from "react";
import { Connection } from "@solana/web3.js";
import {
  ConnectionProvider,
  WalletProvider as SolanaWalletProvider,
} from "@solana/wallet-adapter-react";
import { WalletModalProvider } from "@solana/wallet-adapter-react-ui";
import {
  PhantomWalletAdapter,
  SolflareWalletAdapter,
} from "@solana/wallet-adapter-wallets";
import { QueryClientProvider } from "@tanstack/react-query";

import { cluster } from "@/lib/cluster";
import { queryClient } from "@/lib/queryClient";

import "@solana/wallet-adapter-react-ui/styles.css";

export function MeridianProviders({ children }: { readonly children: ReactNode }) {
  const wallets = useMemo(
    () => [new PhantomWalletAdapter(), new SolflareWalletAdapter()],
    [],
  );

  // Custom Connection with WS endpoint for live account subscriptions.
  const endpoint = cluster.rpcUrl;
  const wsEndpoint = cluster.wsUrl;
  const connectionConfig = useMemo(
    () => ({ commitment: "confirmed" as const, wsEndpoint }),
    [wsEndpoint],
  );

  return (
    <QueryClientProvider client={queryClient}>
      <ConnectionProvider endpoint={endpoint} config={connectionConfig}>
        <SolanaWalletProvider wallets={wallets} autoConnect>
          <WalletModalProvider>{children}</WalletModalProvider>
        </SolanaWalletProvider>
      </ConnectionProvider>
    </QueryClientProvider>
  );
}

// Helper for non-react contexts (e.g. server actions that need a one-shot Connection).
export function makeReadOnlyConnection(): Connection {
  return new Connection(cluster.rpcUrl, {
    commitment: "confirmed",
    wsEndpoint: cluster.wsUrl,
  });
}
