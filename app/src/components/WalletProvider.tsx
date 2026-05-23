"use client";

// Wallet adapter + connection provider for the whole app.
//
// IMPORTANT — wallet adapter v0.15+ migration + no-silent-click defence
// (root-caused 2026-05-22). Three things go wrong if you do the "standard"
// wallet-adapter setup naively, all three of which look identical to the
// user (click Phantom, nothing happens, no error, no popup):
//
//   1. Modern Phantom (>= v23) removed the legacy `window.solana` shim that
//      the @solana/wallet-adapter-wallets `PhantomWalletAdapter` relied on.
//      That adapter's `connect()` throws `WalletNotReadyError`. We fix this
//      by passing an empty `wallets` array and letting the Solana Wallet
//      Standard auto-discover the actually-registered wallets.
//   2. The default `onError` prop is `console.error`, which is invisible
//      to a non-developer. We install one that surfaces failures in a
//      fixed top-of-page banner with an action-oriented sentence.
//   3. Even with onError installed, the adapter's `connect()` can return
//      SILENTLY in some paths — the user-gesture chain that Phantom's
//      popup needs is lost in the autoConnect useEffect microtask, or the
//      extension is locked and the adapter's open-extension call no-ops.
//      No error is thrown, so onError never fires. We fix this with a
//      WalletWatcher that surfaces a banner if a wallet was selected but
//      neither connected nor connecting within 4 seconds.
//
// The combination of (2) + (3) implements the "no-silent-click" policy
// codified in BUG_PREVENTION.md and constitution.md: every user-initiated
// UI action must produce a visible signal — success OR failure — within
// a few seconds, regardless of which code path the failure took.

import { useCallback, useEffect, useMemo, useState } from "react";
import type { ReactNode } from "react";
import { Connection } from "@solana/web3.js";
import {
  ConnectionProvider,
  useWallet,
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
import { WalletSetupChecklist } from "@/components/WalletSetupChecklist";

import "@solana/wallet-adapter-react-ui/styles.css";

const WATCHER_TIMEOUT_MS = 4_000;

/**
 * Map a raw `WalletError` to a short, action-oriented sentence a non-developer
 * can act on. The default `error.message` on wallet-adapter errors is too
 * terse ("WalletNotReadyError") to be useful in a UI.
 */
function describeWalletError(err: unknown): string {
  if (err instanceof WalletNotReadyError) {
    return "Phantom (or Solflare) is not installed or not unlocked. Open the extension, unlock it, then click connect again. If the extension is missing, install it from phantom.com or solflare.com and reload this page.";
  }
  if (err instanceof WalletWindowBlockedError) {
    return "The browser blocked the wallet popup. Allow popups for this site in the address bar, then click connect again.";
  }
  if (err instanceof WalletWindowClosedError) {
    return "You closed the wallet popup before approving. Click connect again and approve in the popup.";
  }
  if (err instanceof WalletConnectionError) {
    const rawMsg = err.message?.trim() || "";
    // "Unexpected error" / "" / "no message provided" is what Phantom returns
    // when the user has NOT created a wallet inside the extension yet, OR
    // they dismissed the approval popup. The checklist component handles the
    // detail; this top line just stops the user reading a useless string.
    if (!rawMsg || /unexpected error|no message provided/i.test(rawMsg)) {
      return "Connection refused with no specific reason — usually means you haven't created a wallet inside the extension yet, OR you dismissed the approval popup. The checklist below shows exactly which step is missing.";
    }
    return `Wallet refused to connect: ${rawMsg}. If the wallet is unlocked and on devnet, try disconnecting and reconnecting from the extension itself.`;
  }
  if (err instanceof WalletError) {
    return `Wallet error: ${err.name}${err.message ? ` — ${err.message}` : ""}.`;
  }
  if (err instanceof Error) {
    return `Unexpected wallet error: ${err.message || err.name}.`;
  }
  return `Unknown wallet error: ${String(err)}.`;
}

/**
 * Defensive copy for the most-common "silent click" cause: user picked a
 * wallet in the modal, modal closed, nothing else happened. Lists all four
 * plausible causes ranked by frequency, each with the user-facing fix.
 */
function silentNoConnectMessage(walletName: string): string {
  return (
    `"${walletName}" was selected ${Math.round(WATCHER_TIMEOUT_MS / 1000)}s ago but never connected and didn't return an error. ` +
    `Most likely causes, in order:\n` +
    `  1. Extension is locked. Click the ${walletName} icon in your browser toolbar; if it asks for your password, that was the problem. Then click connect here again.\n` +
    `  2. Wrong network. ${walletName} must be on Solana Devnet. CLICK THE DEVNET PILL in the header (top right) for click-by-click switch instructions for your wallet.\n` +
    `  3. Popup blocked. The wallet popup needs popups allowed for this site. Look in the address bar for a popup-blocked icon; click it and allow.\n` +
    `  4. A previous wallet popup is still open elsewhere. Check the extension icon for a notification badge — if there's a pending request, approve or dismiss it first.`
  );
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
      // max-h + overflow-y-auto so the banner stays bounded when the
      // checklist + multi-sentence message would otherwise push past the
      // viewport on a short screen. backdrop-blur-md keeps page content
      // readable underneath.
      className="fixed inset-x-0 top-0 z-50 max-h-screen overflow-y-auto border-b border-no/40 bg-no/15 px-6 py-3 text-sm text-no shadow-lg backdrop-blur-md"
    >
      <div className="mx-auto flex max-w-6xl items-start justify-between gap-4">
        <div className="min-w-0 flex-1">
          <p className="font-semibold">Wallet didn&apos;t connect.</p>
          {/* whitespace-pre-line so newlines in silentNoConnectMessage render
              as a real numbered list. */}
          <p className="mt-1 whitespace-pre-line text-no/90">{message}</p>
          {/* Live setup checklist so the user can see WHICH of the four
              prerequisites is unmet, rather than reading the failure
              description and guessing. */}
          <WalletSetupChecklist errorMessage={message} />
        </div>
        <button
          onClick={onDismiss}
          className="flex-shrink-0 rounded p-1 text-no/80 hover:bg-no/20 hover:text-no"
          aria-label="Dismiss wallet error"
          title="Dismiss"
        >
          ✕
        </button>
      </div>
    </div>
  );
}

/**
 * Surfaces silently-failed wallet selections — the case where the user picks
 * a wallet in the modal, the modal closes, but `connect()` returns without
 * throwing AND without setting `connected`. Without this watcher the UI is
 * frozen with no signal at all (the original 2026-05-22 bug).
 *
 * Implementation note: we live INSIDE WalletProvider's tree so `useWallet`
 * is available. Hoisted into its own component because hooks cannot live in
 * the parent that mounts WalletProvider.
 */
function WalletWatcher({ onTimeout }: { onTimeout: (message: string) => void }) {
  const { wallet, connected, connecting, publicKey } = useWallet();
  useEffect(() => {
    // Only watch the dangerous state: a wallet was selected (wallet != null)
    // but we are neither connected nor in the connecting state. Either
    // connect() was never invoked, or it returned silently. Give it 4s.
    if (!wallet || connected || connecting || publicKey) return;
    const walletName = wallet.adapter.name;
    const timerId = window.setTimeout(() => {
      onTimeout(silentNoConnectMessage(walletName));
    }, WATCHER_TIMEOUT_MS);
    return () => window.clearTimeout(timerId);
  }, [wallet, connected, connecting, publicKey, onTimeout]);
  return null;
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
    // gave up. See WalletWatcher above for the complementary defence
    // against silent-no-throw returns.
    // eslint-disable-next-line no-console
    console.error("[wallet-adapter] connect/select failed:", err);
    setWalletErrorMsg(describeWalletError(err));
  }, []);

  const onWalletWatcherTimeout = useCallback((message: string) => {
    // eslint-disable-next-line no-console
    console.warn("[wallet-adapter] silent-no-connect timeout:", message);
    setWalletErrorMsg(message);
  }, []);

  return (
    <QueryClientProvider client={queryClient}>
      <ConnectionProvider endpoint={endpoint} config={connectionConfig}>
        <SolanaWalletProvider wallets={wallets} autoConnect onError={onWalletError}>
          <WalletModalProvider>
            <WalletWatcher onTimeout={onWalletWatcherTimeout} />
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
