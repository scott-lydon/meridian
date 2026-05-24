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
  const { publicKey, disconnect, connecting } = useWallet();
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
    open();
  }, [publicKey, disconnect, open]);

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
