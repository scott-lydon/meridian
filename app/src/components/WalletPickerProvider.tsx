"use client";

// WalletPickerProvider — replaces the default `@solana/wallet-adapter-react-ui`
// modal because that modal dead-ends when no wallet extension is detected.
// All it shows on the no-wallet path is the line "You'll need a wallet on
// Solana to continue" plus an X button: zero install guidance, zero next
// action. Users who don't already have Phantom installed have nothing to
// click and bounce.
//
// This provider exposes a context-backed `useWalletPicker()` hook that any
// button in the app can call to open one shared, well-typed modal. The modal:
//
//   1. Lists wallets actually detected via the Solana Wallet Standard
//      (`useWallet().wallets` filtered to `WalletReadyState.Installed`). One
//      click selects + connects; failures are surfaced by the existing
//      onError handler + WalletWatcher in WalletProvider.
//
//   2. When NO wallets are detected, swaps the empty state for a panel of
//      direct install links to Phantom, Solflare, and Backpack. Each link
//      points at the wallet's official download page, which detects the
//      user's browser and lands them in the correct extension store
//      (Chrome Web Store / Firefox Add-ons / Edge / Brave). This is the
//      "no dead end" rule from constitution.md and BUG_PREVENTION.md —
//      every empty state must specify the next action and how to take it.
//
//   3. Shows the "First time here? Use Solflare" tip even when Phantom is
//      detected. Phantom requires a wallet to exist inside the extension
//      BEFORE the site can connect; Solflare creates the wallet as part
//      of the connect popup. We learned this the hard way on 2026-05-22.
//
// Why a custom modal instead of patching the wallet-adapter modal: the
// wallet-adapter modal's "no wallets" copy lives inside its compiled JS;
// monkey-patching is fragile across upgrades. A custom modal that consumes
// the same `useWallet` data is cleaner, fully typed, and lets us style
// against our own Tailwind palette.

import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useState,
} from "react";
import type { ReactNode } from "react";
import { useWallet } from "@solana/wallet-adapter-react";
import { WalletReadyState, type WalletName } from "@solana/wallet-adapter-base";

import { WalletBrandIcon } from "@/components/WalletBrandIcon";
import {
  getWalletInstallUrl,
  type SupportedInstallWalletName,
} from "@/lib/walletInstallLinks";

interface WalletPickerContextValue {
  /** Open the picker modal. Idempotent. */
  open: () => void;
  /** Close the picker modal. */
  close: () => void;
  /** True when the modal is currently visible. */
  isOpen: boolean;
}

const WalletPickerContext = createContext<WalletPickerContextValue | null>(null);

/**
 * Read the picker controls. Throws when called outside a `WalletPickerProvider`
 * so a mis-wired component fails loudly at mount time instead of silently
 * never opening the modal.
 */
export function useWalletPicker(): WalletPickerContextValue {
  const ctx = useContext(WalletPickerContext);
  if (!ctx) {
    throw new Error(
      "useWalletPicker called outside <WalletPickerProvider>. " +
        "Mount the provider inside MeridianProviders (wallet adapter tree).",
    );
  }
  return ctx;
}

/**
 * One row in the "install a wallet" fallback list. We hand-curate this rather
 * than discovering it at runtime because the whole point of this list is to
 * show wallets the user does NOT have yet — runtime detection returns nothing.
 *
 * `name` is the human-readable wallet brand AND the lookup key into
 * `getWalletInstallUrl` in `lib/walletInstallLinks.ts`. The install URL is
 * resolved per-render so a Firefox visitor receives the Mozilla Add-ons link
 * and a Chrome / Brave / Edge visitor receives the Chrome Web Store deep link,
 * rather than every visitor landing on the wallet's marketing `/download`
 * page (which on 2026-05-24 redirected first-time Phantom users to
 * phantom.com home, creating a dead end — see file-top WTF and
 * `lib/walletInstallLinks.ts` file-top WTF).
 *
 * The brand mark for each row is rendered as INLINE SVG JSX by
 * `<WalletBrandIcon>` rather than as an `<img src="data:image/svg+xml;...">`.
 * Real-user reports on 2026-05-24 (both Safari and Chrome on macOS) showed
 * the Phantom and Solflare data-URL <img> elements rendering as the
 * browser's broken-image glyph while the Backpack chip (drawn directly in
 * JSX) rendered fine. The differentiator was the rendering pipeline, not
 * the SVG content — base64-decoding the data URLs produced valid SVG in
 * every case. Inlining the SVG eliminates the data-URL parsing step and
 * any extension-level image blocking; see `components/WalletBrandIcon.tsx`
 * for the full rationale.
 *
 * `firstTimeRecommended` flags Solflare because it lets the user create the
 * wallet inside the connect popup (single flow). Phantom requires a wallet to
 * already exist in the extension before any site can connect; for a first-time
 * crypto user that's two flows instead of one and a higher drop-off rate.
 */
interface WalletInstallOption {
  name: SupportedInstallWalletName;
  blurb: string;
  firstTimeRecommended?: true;
}

const INSTALL_OPTIONS: readonly WalletInstallOption[] = [
  {
    name: "Solflare",
    blurb:
      "Easiest first-time setup. Lets you create a wallet as part of the connect popup (one flow).",
    firstTimeRecommended: true,
  },
  {
    name: "Phantom",
    blurb:
      "Most popular wallet. You must create a wallet inside the extension BEFORE clicking connect here.",
  },
  {
    name: "Backpack",
    blurb: "Newer wallet. Supports xNFTs.",
  },
];

/**
 * Picker modal body. Lives inside `WalletPickerProvider` so it shares modal
 * open/close state with anything that calls `useWalletPicker()`.
 *
 * Layout:
 *   - Detected wallets list (one-click connect). Hidden when none are
 *     detected so the install panel becomes the primary content.
 *   - Install panel. Always rendered; styled as "I don't see my wallet"
 *     when wallets ARE detected, and as the main content when none are.
 *   - First-time tip steering the user to Solflare. Always rendered because
 *     even users with Phantom installed often haven't created an in-extension
 *     wallet yet, and the first-time-Solflare guidance applies to them too.
 */
/**
 * Persistent setup checklist shown beneath the install buttons. The user's
 * journey when they have no wallet yet is: install the extension, create a
 * wallet inside it, switch the wallet to Solana Devnet, fund the wallet from
 * a faucet, then return and click Connect. None of those four post-install
 * steps are obvious from a one-line "Install Phantom" button, and skipping
 * any of them produces the silent-click failure the WalletWatcher in
 * `WalletProvider.tsx` catches after the fact. Surfacing the steps before
 * the user takes the broken path is strictly better than catching the
 * failure after.
 *
 * Stays visible whether or not a wallet is currently detected, because the
 * second-most common WTF is "I see Phantom in the picker but clicking it
 * does nothing." Step 3 (switch to Solana Devnet) fixes that case.
 */
function PostInstallChecklist() {
  return (
    <div className="mt-4 rounded-lg border border-accent/30 bg-accent/5 p-3 text-xs text-text">
      <p className="mb-2 font-semibold text-accent">
        After installing the extension, do these five steps BEFORE clicking Connect:
      </p>
      <ol className="list-decimal space-y-1.5 pl-5 text-text">
        <li>
          Click the wallet icon in your browser toolbar to open it. If you don&apos;t see it,
          click the puzzle-piece icon to the right of the address bar and pin the wallet.
        </li>
        <li>
          Choose <span className="font-semibold">Create a new wallet</span>. Write the
          12-word recovery phrase on paper. Anyone with the phrase owns the wallet.
        </li>
        <li>
          Open wallet Settings (gear icon), turn on{" "}
          <span className="font-semibold">Testnet Mode</span> (Phantom labels this
          &quot;Developer Settings&quot;), then switch the network to{" "}
          <span className="font-semibold">Solana Devnet</span>. Meridian only runs on
          Devnet.
        </li>
        <li>
          Visit{" "}
          <a
            href="https://faucet.solana.com"
            target="_blank"
            rel="noreferrer"
            className="underline decoration-accent/60 underline-offset-2 hover:text-accent"
          >
            faucet.solana.com
          </a>
          , paste your wallet address, request 1 SOL. This pays transaction fees and is
          free.
        </li>
        <li>
          Reload this page, click <span className="font-semibold">Connect</span>, pick
          your wallet, approve in the popup.
        </li>
      </ol>
    </div>
  );
}

function WalletPickerModal({ onClose }: { onClose: () => void }) {
  const { wallets, select, connect } = useWallet();

  // The Solana Wallet Standard auto-discovers wallets and reports readyState.
  // We only render "Installed" entries as clickable connect buttons because
  // anything else (NotDetected / Loadable) cannot complete a connect without
  // a separate install step the user is already being guided through below.
  const detected = useMemo(
    () => wallets.filter((w) => w.readyState === WalletReadyState.Installed),
    [wallets],
  );

  // Close on Escape — keyboard accessibility expectation for any modal.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  const onPickWallet = useCallback(
    async (name: string) => {
      // select() in wallet-adapter-react v0.15+ triggers the autoConnect
      // useEffect to fire connect() on the next render. We close the modal
      // immediately so the user sees the wallet popup pop forward.
      select(name as WalletName);
      onClose();

      // Defensive: in some race conditions the autoConnect side-effect does
      // not fire (the 2026-05-22 silent-click case documented in
      // WalletProvider). Yield a tick for `wallet` state to settle, then
      // drive connect() ourselves. Idempotent — if autoConnect already
      // started the connection, the adapter sees `connecting === true` and
      // this second call is a no-op. Errors are already surfaced by the
      // onError prop on SolanaWalletProvider, so we don't re-surface here.
      await new Promise<void>((resolve) => window.setTimeout(resolve, 50));
      try {
        await connect();
      } catch {
        // Intentionally swallowed — WalletProvider.onWalletError owns the UI
        // surface for connect failures. Re-throwing here would double-banner.
      }
    },
    [connect, onClose, select],
  );

  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-labelledby="wallet-picker-title"
      // z-50 to outrank page content; the WalletErrorBanner uses the same
      // z-index so error + picker stack rather than fight. Backdrop click
      // closes the modal (standard expectation), inner click does not
      // propagate to the backdrop.
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/70 p-4 backdrop-blur-sm"
      onClick={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
    >
      <div className="w-full max-w-md rounded-2xl border border-panel bg-bg/95 p-6 shadow-2xl">
        <div className="mb-4 flex items-start justify-between gap-4">
          <h2 id="wallet-picker-title" className="text-lg font-semibold text-text">
            Connect a Solana wallet
          </h2>
          <button
            type="button"
            onClick={onClose}
            aria-label="Close wallet picker"
            className="rounded-full p-1 text-muted hover:bg-panel hover:text-text"
          >
            ✕
          </button>
        </div>

        {detected.length > 0 && (
          <section className="mb-5">
            <p className="mb-2 text-xs font-semibold uppercase tracking-wider text-muted">
              Detected wallets
            </p>
            <ul className="space-y-2">
              {detected.map((w) => (
                <li key={w.adapter.name}>
                  <button
                    type="button"
                    onClick={() => {
                      void onPickWallet(w.adapter.name);
                    }}
                    className="flex w-full items-center gap-3 rounded-xl border border-panel bg-panel/40 px-4 py-3 text-left text-text transition hover:border-accent/60 hover:bg-panel/70"
                  >
                    {w.adapter.icon ? (
                      // Adapter icons are inline SVG data-urls; safe to render
                      // with <img>. eslint-disable for next/image isn't worth
                      // it here because the asset is base64-embedded.
                      // eslint-disable-next-line @next/next/no-img-element
                      <img
                        src={w.adapter.icon}
                        alt=""
                        className="h-7 w-7 rounded"
                        width={28}
                        height={28}
                      />
                    ) : (
                      <span className="grid h-7 w-7 place-items-center rounded bg-accent text-xs font-bold text-white">
                        {w.adapter.name[0]}
                      </span>
                    )}
                    <span className="font-medium">{w.adapter.name}</span>
                    <span className="ml-auto rounded-full bg-yes/20 px-2 py-0.5 text-[10px] font-semibold uppercase tracking-wider text-yes">
                      Detected
                    </span>
                  </button>
                </li>
              ))}
            </ul>
          </section>
        )}

        <section>
          <p className="mb-2 text-xs font-semibold uppercase tracking-wider text-muted">
            {detected.length > 0 ? "Don't see your wallet?" : "Install a wallet extension"}
          </p>

          {detected.length === 0 && (
            <p className="mb-3 rounded-lg border border-accent/30 bg-accent/10 p-3 text-sm text-text">
              <span className="font-semibold">No Solana wallet extension detected.</span>{" "}
              Install one below, reload this page, and click Connect again. Each link goes to
              the wallet's official download page, which routes you to the right extension
              store for your browser (Chrome, Firefox, Edge, Brave).
            </p>
          )}

          <ul className="space-y-2">
            {INSTALL_OPTIONS.map((opt) => (
              <li key={opt.name}>
                <a
                  // Resolve per-render so a Firefox visitor lands on Mozilla
                  // Add-ons and a Chromium visitor lands on the Chrome Web
                  // Store entry, rather than every visitor landing on the
                  // wallet's marketing /download page (the 2026-05-24
                  // dead-end fix — see WalletInstallOption docstring and
                  // lib/walletInstallLinks.ts file-top WTF).
                  href={getWalletInstallUrl(opt.name)}
                  target="_blank"
                  rel="noreferrer"
                  className="flex items-start gap-3 rounded-xl border border-panel bg-panel/40 px-4 py-3 text-left transition hover:border-accent/60 hover:bg-panel/70"
                >
                  {/* Inline-SVG JSX, not <img src=data:url>. See
                      `components/WalletBrandIcon.tsx` for why: in real
                      Safari and Chrome reports the data-URL pipeline
                      rendered the broken-image glyph while inline JSX
                      worked. Tailwind `mt-0.5 h-7 w-7` matches the prior
                      image size; the component handles its own rounding. */}
                  <WalletBrandIcon name={opt.name} className="mt-0.5 h-7 w-7" />
                  <span className="flex-1">
                    <span className="flex flex-wrap items-center gap-2">
                      <span className="font-medium text-text">Install {opt.name}</span>
                      {opt.firstTimeRecommended && (
                        <span className="rounded-full bg-yes/20 px-2 py-0.5 text-[10px] font-semibold uppercase tracking-wider text-yes">
                          Recommended for first-timers
                        </span>
                      )}
                    </span>
                    <span className="mt-0.5 block text-xs text-muted">{opt.blurb}</span>
                  </span>
                  <span className="mt-1 select-none text-muted" aria-hidden="true">
                    ↗
                  </span>
                </a>
              </li>
            ))}
          </ul>

          {/*
            First-time tip lives outside the "no wallets" conditional because
            it applies just as much when Phantom IS detected but the user has
            never created a wallet inside the extension. That's the most
            common cause of the "I clicked Phantom and nothing happened"
            failure mode the WalletWatcher in WalletProvider catches.
          */}
          <p className="mt-4 rounded-lg border border-yes/30 bg-yes/5 p-3 text-xs text-text">
            <span className="font-semibold text-yes">First time using a Solana wallet?</span>{" "}
            Pick Solflare. It creates the wallet during the connect popup, so you finish in
            one flow. Phantom and Backpack require you to create the wallet INSIDE the
            extension first, before any site can connect.
          </p>

          {/*
            Five-step setup walkthrough — kept always-visible (not gated on
            `detected.length === 0`) because the second-most-common failure
            we see is "I installed Phantom, the picker shows it as Detected,
            but clicking it does nothing." That failure is virtually always
            step 3 (wallet not on Solana Devnet), and the checklist is the
            single intervention that prevents it.
          */}
          <PostInstallChecklist />

          <p className="mt-3 text-xs text-muted">
            Already installed but not detected? Some extensions inject after the first paint —
            reload this page and try again. Make sure the extension is unlocked.
          </p>
        </section>
      </div>
    </div>
  );
}

/**
 * Mount once inside the wallet-adapter tree (after `SolanaWalletProvider`).
 * Exposes the open/close API via context and renders the modal when open.
 */
export function WalletPickerProvider({ children }: { children: ReactNode }) {
  const [isOpen, setIsOpen] = useState(false);
  const open = useCallback(() => setIsOpen(true), []);
  const close = useCallback(() => setIsOpen(false), []);

  const value = useMemo<WalletPickerContextValue>(
    () => ({ open, close, isOpen }),
    [open, close, isOpen],
  );

  return (
    <WalletPickerContext.Provider value={value}>
      {children}
      {isOpen && <WalletPickerModal onClose={close} />}
    </WalletPickerContext.Provider>
  );
}
