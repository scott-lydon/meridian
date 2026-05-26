"use client";

// ConnectWalletButton — replaces `WalletMultiButton` from
// @solana/wallet-adapter-react-ui at both call sites (the header connect
// chip and the in-trade-form connect CTA).
//
// Why a custom button:
//   1. The default `WalletMultiButton` opens the wallet-adapter modal,
//      whose no-wallets-detected state is a literal dead end (the screen
//      that reads "You'll need a wallet on Solana to continue" with only
//      an X button). See WalletPickerProvider.tsx for the rationale.
//   2. Owning the button gives us first-class Tailwind styling instead of
//      fighting `!important` overrides on the adapter's stock button.
//   3. We unify the connected-vs-disconnected rendering between the header
//      and the trade form so both call sites stay visually consistent
//      without each having to handle the `publicKey` branch.

import { useCallback } from "react";
import { useWallet } from "@solana/wallet-adapter-react";
import clsx from "clsx";

import { useWalletPicker } from "@/components/WalletPickerProvider";
import { dismissWalletErrorBanner } from "@/components/WalletProvider";

interface ConnectWalletButtonProps {
  /** Tailwind class overrides for size/padding tweaks at specific call sites. */
  className?: string;
  /** Label override; defaults to "Connect Wallet" which matches WalletMultiButton. */
  label?: string;
}

/**
 * Shorten a base58 public key for the header chip. 4 leading + 4 trailing
 * characters is the same convention the wallet-adapter ships with.
 */
function truncatePubkey(base58: string): string {
  if (base58.length <= 12) return base58;
  return `${base58.slice(0, 4)}…${base58.slice(-4)}`;
}

/**
 * Disconnected: opens the WalletPicker modal (custom, with install links).
 * Connected: shows truncated pubkey; clicking disconnects.
 *
 * The connected branch deliberately disconnects on click rather than opening
 * a sub-menu because there is exactly one action a connected user wants from
 * this button (disconnect), and a popover would be more UI for less value.
 * If we add wallet-switch later, this is where to grow it.
 */
export function ConnectWalletButton({
  className,
  label = "Connect Wallet",
}: ConnectWalletButtonProps) {
  const { publicKey, disconnect, connecting, select, wallet } = useWallet();
  const { open } = useWalletPicker();

  const onClick = useCallback(async () => {
    if (publicKey) {
      try {
        await disconnect();
      } catch (e) {
        // wallet-adapter onError handles surfacing; we keep this catch so
        // a disconnect failure can't crash the button's render.
        // eslint-disable-next-line no-console
        console.error("[ConnectWalletButton] disconnect failed:", e);
      }
      return;
    }
    // Clean-slate the connect flow:
    //
    // 1. Dismiss any "Wallet didn't connect" banner left over from a
    //    page-load autoConnect failure. The banner persists until the
    //    user takes another action; this click IS that action, so the
    //    banner getting in the way of the picker (or just confusing
    //    the user about why their click "didn't work") is wrong.
    // 2. Clear the previously-selected-but-not-ready wallet so
    //    autoConnect cannot race the picker. Without this, opening
    //    the picker while autoConnect is still mid-flight on a
    //    NotReady wallet can produce a second WalletNotReadyError
    //    that re-pops the banner the moment the user opens the
    //    picker. We only clear the selection if the currently-
    //    selected wallet is itself not Installed; an actually-ready
    //    wallet selection is the normal "reconnect to my last
    //    wallet" path and should be left alone for autoConnect to
    //    finish.
    dismissWalletErrorBanner();
    const selectedReadyState = wallet?.adapter.readyState;
    if (
      wallet &&
      selectedReadyState !== "Installed" &&
      selectedReadyState !== undefined
    ) {
      // Passing null tells the adapter "no wallet selected" and aborts
      // the current connect attempt.
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      (select as unknown as (n: any) => void)(null);
    }
    open();
  }, [publicKey, disconnect, open, select, wallet]);

  const baseClass =
    "inline-flex items-center justify-center rounded-xl bg-accent px-4 py-2 text-sm font-semibold text-white shadow-sm transition hover:bg-accentHover focus:outline-none focus-visible:ring-2 focus-visible:ring-accent/60 disabled:cursor-not-allowed disabled:opacity-60";

  if (publicKey) {
    return (
      <button
        type="button"
        onClick={() => {
          void onClick();
        }}
        className={clsx(baseClass, "font-mono", className)}
        title="Click to disconnect"
        aria-label={`Connected wallet ${truncatePubkey(publicKey.toBase58())}. Click to disconnect.`}
      >
        {truncatePubkey(publicKey.toBase58())}
      </button>
    );
  }

  return (
    <button
      type="button"
      onClick={() => {
        void onClick();
      }}
      disabled={connecting}
      className={clsx(baseClass, className)}
    >
      {connecting ? "Connecting…" : label}
    </button>
  );
}
