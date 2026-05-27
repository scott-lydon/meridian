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
import {
  WalletError,
  WalletNotReadyError,
  WalletConnectionError,
  WalletWindowBlockedError,
  WalletWindowClosedError,
  WalletSendTransactionError,
  WalletSignTransactionError,
} from "@solana/wallet-adapter-base";
import { QueryClientProvider } from "@tanstack/react-query";

import {
  PhantomWalletAdapter,
  SolflareWalletAdapter,
  CoinbaseWalletAdapter,
} from "@solana/wallet-adapter-wallets";

import { cluster } from "@/lib/cluster";
import { queryClient } from "@/lib/queryClient";
import { WalletSetupChecklist } from "@/components/WalletSetupChecklist";
import { WalletPickerProvider } from "@/components/WalletPickerProvider";

// NOTE: we deliberately do NOT import @solana/wallet-adapter-react-ui or its
// stylesheet anywhere in the tree. The default modal that ships with that
// package dead-ends on the "no wallets detected" path (one X button, zero
// install guidance) and the override surface is minimal. WalletPickerProvider
// owns the connect-flow UI instead; see its file-top comment for rationale.

const WATCHER_TIMEOUT_MS = 4_000;

// Custom event other components dispatch to dismiss the "Wallet didn't
// connect" banner. The most common use case: when the user clicks the
// Connect Wallet button, any stale autoConnect failure banner from page
// load should be dismissed so the user-initiated picker flow gets a
// clean slate. Mirrors the meridian:afterHoursModeChanged pattern.
//
// Exported so ConnectWalletButton and the wallet picker can dispatch
// without re-declaring the string. Listening side is in MeridianProviders.
export const WALLET_ERROR_DISMISS_EVENT = "meridian:dismissWalletErrorBanner";
export function dismissWalletErrorBanner(): void {
  if (typeof window === "undefined") return;
  window.dispatchEvent(new Event(WALLET_ERROR_DISMISS_EVENT));
}

/**
 * Map a raw `WalletError` to a short, action-oriented sentence a non-developer
 * can act on. The default `error.message` on wallet-adapter errors is too
 * terse ("WalletNotReadyError") to be useful in a UI.
 */
function describeWalletError(err: unknown): string {
  if (err instanceof WalletNotReadyError) {
    return "Phantom, Solflare, or Coinbase Wallet is not installed or not unlocked. Open the extension, unlock it, then click connect again. If the extension is missing, install it from phantom.com, solflare.com, or wallet.coinbase.com and reload this page.";
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
  // Belt-AND-suspenders wallet discovery (2026-05-25 Safari fix; extended
  // 2026-05-25 to include Coinbase Wallet).
  //
  // The previous setup was `wallets={[]}` and relied entirely on the Solana
  // Wallet Standard to auto-discover registered wallets. That works on
  // Chromium / Firefox where Phantom and Solflare publish a Wallet Standard
  // registration synchronously on every page. It does NOT work on Safari:
  // Phantom's Safari WebExtension (and Solflare's, as of late 2026) injects
  // its provider at `window.phantom.solana` / `window.solflare` but does NOT
  // publish the Wallet Standard handshake the same way the Chromium build
  // does. The picker's "Detected wallets" list filters by `WalletReadyState
  // .Installed`, so Safari users saw an empty Detected section and were
  // told to install a wallet they already had installed.
  //
  // The fix: include the explicit `PhantomWalletAdapter`,
  // `SolflareWalletAdapter`, and `CoinbaseWalletAdapter` alongside whatever
  // Wallet Standard discovers. Each adapter probes its own injected global
  // (PhantomWalletAdapter checks `window.phantom?.solana?.isPhantom`,
  // SolflareWalletAdapter checks `window.solflare?.isSolflare`, and
  // CoinbaseWalletAdapter checks `window.coinbaseSolana` — see
  // node_modules/.../@solana/wallet-adapter-coinbase/lib/cjs/adapter.js) and
  // flips its `readyState` to `Installed` independently of the Wallet
  // Standard handshake. The picker de-duplicates by adapter `name`, so on
  // Chromium where Wallet Standard ALSO surfaces them you still see exactly
  // one Phantom row, not two.
  //
  // The historical concern that prompted the empty-wallets approach
  // ("Phantom v23 removed window.solana") was specific to the old
  // `window.solana` global; the v0.9.29 PhantomWalletAdapter targets
  // `window.phantom.solana` and is not affected.
  //
  // Coinbase Wallet note: the Coinbase Wallet browser extension supports
  // Solana sign + send via the standard wallet-adapter interface. Meridian's
  // `Connection` is what dictates the cluster (devnet); Coinbase Wallet
  // signs whatever transaction Meridian builds against that endpoint, so
  // there is no per-network setting inside the extension that gates this.
  // (Coinbase Wallet's UI does have a Settings → Developer Settings →
  // Testnets toggle, but that only affects what balances the wallet's
  // own asset list shows; it does not gate dApp signing.)
  const wallets = useMemo(
    () => [
      new PhantomWalletAdapter(),
      new SolflareWalletAdapter(),
      new CoinbaseWalletAdapter(),
    ],
    [],
  );

  // Custom Connection with WS endpoint for live account subscriptions.
  const endpoint = cluster.rpcUrl;
  const wsEndpoint = cluster.wsUrl;
  const connectionConfig = useMemo(
    () => ({ commitment: "confirmed" as const, wsEndpoint }),
    [wsEndpoint],
  );

  const [walletErrorMsg, setWalletErrorMsg] = useState<string | null>(null);

  // Listen for explicit dismiss requests from elsewhere in the app
  // (currently: ConnectWalletButton click, picker onPickWallet, etc.).
  // The dismiss request is fire-and-forget; we always honor it because
  // banner persistence is "until the user takes another action," and
  // dispatching the event IS that action.
  useEffect(() => {
    const handler = () => setWalletErrorMsg(null);
    window.addEventListener(WALLET_ERROR_DISMISS_EVENT, handler);
    return () => window.removeEventListener(WALLET_ERROR_DISMISS_EVENT, handler);
  }, []);

  const onWalletError = useCallback((err: WalletError) => {
    // Full detail in the console for developers; short actionable line in
    // the on-screen banner for users. Never silently swallow — the original
    // bug (2026-05-22) was that the default onError did nothing visible and
    // clicking Phantom looked like a no-op for ~minutes before the user
    // gave up. See WalletWatcher above for the complementary defence
    // against silent-no-throw returns.
    // eslint-disable-next-line no-console
    console.error("[wallet-adapter] wallet adapter error:", err);

    // Send/sign-transaction failures route through this same onError hook
    // AFTER the wallet is already connected. The global banner title is
    // hard-coded "Wallet didn't connect" because its original purpose was
    // surfacing connect/select failures — surfacing send/sign failures
    // through it produces the misleading "wallet didn't connect" banner
    // that 2026-05-25 user testing flagged (the wallet's pubkey was
    // visibly present in the header). The per-page toast on the awaited
    // `sendTransaction` promise rejection already owns these — see the
    // trade page `run()` catch — so skipping the global banner here
    // avoids double-surfacing and the wrong title.
    //
    // WTF heads-up: the `instanceof` check is BACKED UP with a name-based
    // check because pnpm sometimes hoists two copies of
    // `@solana/wallet-adapter-base` (one for the picker, one for the
    // adapter). When that happens the error thrown by the adapter is a
    // `WalletSendTransactionError` from copy A, but the `instanceof`
    // check here imports copy B's class object — different reference,
    // check returns false, and the misleading "Wallet didn't connect"
    // banner appears for a send failure. The 2026-05-26 user-testing
    // report ("Wallet error: WalletSendTransactionError — Internal
    // error" under the Wallet didn't connect banner with the wallet
    // visibly connected) was exactly this path. The `err.name` fallback
    // is robust to that.
    const looksLikeSendOrSignFailure =
      err instanceof WalletSendTransactionError ||
      err instanceof WalletSignTransactionError ||
      err.name === "WalletSendTransactionError" ||
      err.name === "WalletSignTransactionError";
    if (looksLikeSendOrSignFailure) {
      return;
    }

    // Filter out the transient `WalletNotSelectedError` (root-caused
    // 2026-05-27 from a user video showing the red "Wallet didn't
    // connect" banner appearing AT THE SAME TIME the wallet was
    // visibly connected in the header).
    //
    // The WalletPicker's `onPickWallet` calls `select(name)` then —
    // after a defensive 50ms sleep against the 2026-05-22 silent-click
    // bug — explicitly awaits `connect()`. The 50ms sleep is sometimes
    // shorter than the React state propagation that turns the named
    // selection into a non-null `wallet` ref on the underlying
    // adapter, so the explicit `connect()` runs while the adapter
    // still sees `wallet === null`. The adapter throws
    // `WalletNotSelectedError` synchronously AND emits an error event
    // that the wallet-adapter-react's onError prop forwards to us. By
    // the time the banner renders, autoConnect's own useEffect has
    // ALREADY started the real connection: the user sees their pubkey
    // in the header while a giant red "Wallet didn't connect" banner
    // covers half the page. Maximally confusing.
    //
    // The error is purely a developer-facing race signal between the
    // two redundant connect entry points. It is never actionable for
    // the user, and the actual connect either succeeds (most of the
    // time) or fails with a different, accurate error (WalletNotReady,
    // WalletWindowClosed, WalletConnection). Drop it on the floor.
    //
    // Name-based match (same robustness justification as the
    // send/sign filter above: pnpm hoists multiple copies of
    // `@solana/wallet-adapter-base`, so `instanceof` is flaky).
    if (err.name === "WalletNotSelectedError") {
      return;
    }

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
          <WalletPickerProvider>
            <WalletWatcher onTimeout={onWalletWatcherTimeout} />
            {walletErrorMsg && (
              <WalletErrorBanner
                message={walletErrorMsg}
                onDismiss={() => setWalletErrorMsg(null)}
              />
            )}
            {children}
          </WalletPickerProvider>
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
