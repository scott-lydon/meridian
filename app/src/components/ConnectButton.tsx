"use client";

import { useWallet } from "@solana/wallet-adapter-react";
import { WalletMultiButton } from "@solana/wallet-adapter-react-ui";

import { useUsdcBalance } from "@/hooks/useUsdcBalance";
import { formatUsdc } from "@/lib/usdc";

/**
 * The header's Connect Wallet button.
 *
 * Connected: shows truncated pubkey + USDC balance.
 * Disconnected: triggers the wallet-adapter modal.
 */
export function ConnectButton() {
  const { publicKey } = useWallet();
  const balance = useUsdcBalance(publicKey?.toBase58());

  return (
    <div className="flex items-center gap-3">
      {publicKey && (
        <div className="hidden rounded-full border border-panel bg-panel/40 px-3 py-1.5 text-sm font-mono text-muted md:flex">
          {balance.data !== undefined ? formatUsdc(balance.data) : "..."}
          <span className="ml-1 text-xs uppercase tracking-wider text-muted/70">USDC</span>
        </div>
      )}
      <WalletMultiButton className="!rounded-xl !bg-accent hover:!bg-accentHover" />
    </div>
  );
}
