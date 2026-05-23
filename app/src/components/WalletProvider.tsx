"use client";

// Wallet adapter + connection provider for the whole app.
//
// IMPORTANT — wallet adapter v0.15+ migration notes (root-caused 2026-05-22):
// Phantom, Solflare, and Backpack all register themselves via the Solana
// Wallet Standard. Passing explicit `PhantomWalletAdapter` /
// `SolflareWalletAdapter` instances is redundant AND harmful on modern
// Phantom builds (>= v23) because those builds removed the legacy
// `window.solana` shim the old adapter relied on. The legacy adapter's
// `connect()` then throws `WalletNotReadyError`, which — without an
// onError handler — is swallowed and the click looks like a no-op.
//
// Fix: pass an empty `wallets` array so the Wallet Standard discovery in
// `@solana/wallet-adapter-react` finds the actual registered wallets, and
// install an onError handler that surfaces failures in a visible banner.
// See https://github.com/anza-xyz/wallet-adapter#wallet-standard for the
// Standard discovery contract.

import { useCallback, useMemo, useState } from "react";
import type { ReactNode } from "react";
import { Connection } from "@solana/web3.js";
import {
  ConnectionProvider,
  WalletProvider as SolanaWalletProvider,
} from "@solana/wallet-adapter-react";
import { WalletModalProvider } from "@solana/wallet-adapter-react-ui";
import {
  WalletError,
  WalletNotReadyError,
  WalletConnectionError,
  WalletWindowBlockedError,
  WalletWindowClosedError,
} from "@solana/wallet-adapter-base";
import { QueryClientProvider } from "@tanstack/react-query";

import { cluster } from "@/lib/cluster";
import { queryClient } from "@/lib/queryClient";

import "@solana/wallet-adapter-react-ui/styles.css";

/**
 * Map a raw `WalletError` to a short, action-oriented sentence a non-developer
 * can act on. The default `error.message` on wallet-adapter errors is too
 * terse ("WalletNotReadyError") to be useful in a UI.
 */
function describeWalletError(err: unknown): string {
  if (err instanceof WalletNotReadyError) {
    return "Phantom (or Solflare) is not installed or not unlocked. Open the extension, unlock it, then click again. If the extension is missing, install it from phantom.com or solflare.com and reload this page.";
  }
  if (err instanceof WalletWindowBlockedError) {
    return "The browser blocked the wallet popup. Allow popups for this site in the address bar, then click connect again.";
  }
  if (err instanceof WalletWindowClosedError) {
    return "You closed the wallet popup before approving. Click connect again and approve in the popup.";
  }
  if (err instanceof WalletConnectionError) {
    return `Wallet refused to connect: ${err.message || "no message provided"}. If the wallet is unlocked and on devnet, try disconnecting and reconnecting from the extension itself.`;
  }
  if (err instanceof WalletError) {
    return `Wallet error: ${err.name}${err.message ? ` — ${err.message}` : ""}.`;
  }
  if (err instanceof Error) {
    return `Unexpected wallet error: ${err.message || err.name}.`;
  }
  return `Unknown wallet error: ${String(err)}.`;
}

function WalletErrorBanner({
  message,
  onDismiss,
}: {
  message: string;
  onDismiss: () => void;
}) {
  return (
    <div
      role="alert"
      // Fixed top-of-page so it survives any in-page navigation while the
      // user is in the middle of trying to connect. z-50 to outrank the
      // wallet modal's overlay. Manual dismiss; no auto-hide because the
      // user needs time to read multi-sentence guidance.
      className="fixed inset-x-0 top-0 z-50 border-b border-no/40 bg-no/15 px-6 py-3 text-sm text-no shadow-lg backdrop-blur-md"
    >
      <div className="mx-auto flex max-w-6xl items-start justify-between gap-4">
        <div>
          <p className="font-semibold">Wallet didn&apos;t connect.</p>
          <p className="mt-1 text-no/90">{message}</p>
        </div>
        <button
          onClick={onDismiss}
          className="rounded p-1 text-no/80 hover:bg-no/20 hover:text-no"
          aria-label="Dismiss wallet error"
          title="Dismiss"
        >
          ✕
        </button>
      </div>
    </div>
  );
}

export function MeridianProviders({ children }: { readonly children: ReactNode }) {
  // Empty wallets array — modern Phantom / Solflare / Backpack register via
  // the Wallet Standard and the wallet-adapter react package discovers them
  // automatically. See the file-top WTF block for why explicit adapters were
  // removed.
  const wallets = useMemo(() => [], []);

  // Custom Connection with WS endpoint for live account subscriptions.
  const endpoint = cluster.rpcUrl;
  const wsEndpoint = cluster.wsUrl;
  const connectionConfig = useMemo(
    () => ({ commitment: "confirmed" as const, wsEndpoint }),
    [wsEndpoint],
  );

  const [walletErrorMsg, setWalletErrorMsg] = useState<string | null>(null);

  const onWalletError = useCallback((err: WalletError) => {
    // Full detail in the console for developers; short actionable line in
    // the on-screen banner for users. Never silently swallow — the original
    // bug (2026-05-22) was that the default onError did nothing visible and
    // clicking Phantom looked like a no-op for ~minutes before the user
    // gave up.
    // eslint-disable-next-line no-console
    console.error("[wallet-adapter] connect/select failed:", err);
    setWalletErrorMsg(describeWalletError(err));
  }, []);

  return (
    <QueryClientProvider client={queryClient}>
      <ConnectionProvider endpoint={endpoint} config={connectionConfig}>
        <SolanaWalletProvider wallets={wallets} autoConnect onError={onWalletError}>
          <WalletModalProvider>
            {walletErrorMsg && (
              <WalletErrorBanner
                message={walletErrorMsg}
                onDismiss={() => setWalletErrorMsg(null)}
              />
            )}
            {children}
          </WalletModalProvider>
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
