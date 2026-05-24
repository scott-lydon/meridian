"use client";

import { useWallet } from "@solana/wallet-adapter-react";

import { useUsdcBalance } from "@/hooks/useUsdcBalance";
import { formatUsdc } from "@/lib/usdc";
import { ConnectWalletButton } from "@/components/ConnectWalletButton";

/**
 * Header connect chip: USDC balance (when connected) next to a
 * `ConnectWalletButton`. The button itself owns the connected vs
 * disconnected rendering and the picker-modal trigger; this wrapper just
 * pairs it with the inline balance.
 *
 * We do NOT use `WalletMultiButton` from `@solana/wallet-adapter-react-ui`
 * because its underlying modal's no-wallets-detected state is a literal dead
 * end. See `WalletPickerProvider.tsx` for the replacement.
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
      <ConnectWalletButton />
    </div>
  );
}
