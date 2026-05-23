"use client";

// WalletSetupChecklist — live "have you done the prerequisites?" panel that
// shows beneath the WalletErrorBanner whenever connect fails. Each row is
// detected at runtime (not hard-coded) so the user can see which step is
// actually missing instead of reading a five-line failure description and
// guessing.
//
// Why this exists: a banner reading "Wallet refused to connect: Unexpected
// error" is true but useless when the actual problem is the user installed
// Phantom 30 seconds ago and never created a wallet inside it. A checklist
// surfaces "Wallet created inside the extension: ✗" so they know exactly
// which prerequisite is unmet.
//
// Detection methods:
//   - Extension installed: window.phantom?.solana?.isPhantom (similar for
//     Solflare, Backpack). These are set by the extension on every page.
//   - Wallet created: we cannot detect this directly without trying to
//     connect (it's gated behind the extension's permission model). We
//     INFER from the error message — see inferWalletCreated below.
//   - On devnet: we can't read the wallet's selected network from the page
//     (Phantom doesn't expose it). We tell the user to verify in the
//     extension and link to the DEVNET pill popover's instructions.
//   - Connected to this site: useWallet().connected from the adapter.

import { useEffect, useState } from "react";
import { useWallet } from "@solana/wallet-adapter-react";

interface DetectedWallet {
  name: string;
  installed: boolean;
}

/**
 * Probe window.* for each wallet extension. Phantom, Solflare, and
 * Backpack all set a global synchronously when their content script runs,
 * so on a hydrated client these checks are reliable. We re-run on mount
 * because content-script injection can happen after the first paint on
 * slow extensions.
 */
function useDetectedWallets(): DetectedWallet[] {
  const [wallets, setWallets] = useState<DetectedWallet[]>([
    { name: "Phantom", installed: false },
    { name: "Solflare", installed: false },
    { name: "Backpack", installed: false },
  ]);
  useEffect(() => {
    const detect = () => {
      const w = window as unknown as {
        phantom?: { solana?: { isPhantom?: boolean } };
        solflare?: { isSolflare?: boolean };
        backpack?: { isBackpack?: boolean };
      };
      setWallets([
        { name: "Phantom", installed: !!w.phantom?.solana?.isPhantom },
        { name: "Solflare", installed: !!w.solflare?.isSolflare },
        { name: "Backpack", installed: !!w.backpack?.isBackpack },
      ]);
    };
    detect();
    // Re-detect after a tick in case the extension's content script injects
    // its globals after the first paint (slow systems, dev tools open, etc).
    const id = window.setTimeout(detect, 500);
    return () => window.clearTimeout(id);
  }, []);
  return wallets;
}

/**
 * Guess whether the wallet has any accounts based on the error message.
 * Phantom returns errors via wallet-adapter; the "Unexpected error" /
 * "no message provided" / "User rejected the request" set of messages
 * is fairly typical of "I just installed and haven't created an account
 * yet" OR "I rejected the approval popup." Both have the same fix:
 * open the extension and either (a) create a wallet, or (b) approve.
 *
 * If the error message clearly states something else (popup blocked,
 * network mismatch, etc.) we return null and let the existing banner copy
 * carry the actionable detail.
 */
function inferWalletCreated(errorMessage: string | null): boolean | null {
  if (!errorMessage) return null;
  const lower = errorMessage.toLowerCase();
  if (
    lower.includes("unexpected error") ||
    lower.includes("no message provided") ||
    lower.includes("user rejected") ||
    lower.includes("rejected the request") ||
    lower.includes("no accounts")
  ) {
    return false; // probably no wallet created OR rejected approval
  }
  return null; // can't tell; don't make a claim
}

function CheckRow({
  ok,
  unknown,
  children,
}: {
  ok: boolean;
  unknown?: boolean;
  children: React.ReactNode;
}) {
  return (
    <li className="flex items-start gap-2 text-xs">
      <span
        aria-hidden="true"
        className={
          unknown
            ? "mt-0.5 inline-block w-4 text-center text-muted"
            : ok
              ? "mt-0.5 inline-block w-4 text-center text-yes"
              : "mt-0.5 inline-block w-4 text-center text-no"
        }
      >
        {unknown ? "?" : ok ? "✓" : "✗"}
      </span>
      <span className={unknown ? "text-muted" : ok ? "text-text" : "text-text"}>{children}</span>
    </li>
  );
}

export function WalletSetupChecklist({
  errorMessage,
}: {
  errorMessage: string | null;
}) {
  const wallets = useDetectedWallets();
  const { connected } = useWallet();
  const anyInstalled = wallets.some((w) => w.installed);
  const walletCreated = inferWalletCreated(errorMessage);

  return (
    <div className="mt-3 rounded-lg border border-no/30 bg-bg/40 p-3 text-no/90">
      <p className="mb-2 text-xs font-semibold uppercase tracking-wider text-text">
        What&apos;s required (any one wallet works — not just Phantom)
      </p>
      {/*
        First-time-user tip. Phantom returns "Unexpected error" with no popup
        if the extension has no wallet — its design treats extension as a
        manager, sites as clients. Solflare offers in-flow creation. For a
        first-time user the Solflare path is strictly easier.
      */}
      <p className="mb-3 rounded-md border border-yes/30 bg-yes/5 p-2 text-[11px] text-text">
        <span className="font-semibold text-yes">First time here?</span> Use{" "}
        <span className="font-semibold">Solflare</span>. It lets you create a wallet AS PART OF
        the connect popup (one flow). <span className="font-semibold">Phantom</span> requires
        you to create a wallet inside the extension FIRST — if you click Select Wallet →
        Phantom without an existing wallet, Phantom returns &quot;Unexpected error&quot; with
        no popup. The DEVNET pill in the header has full instructions for both.
      </p>
      <ol className="space-y-1.5">
        <CheckRow ok={anyInstalled}>
          <span>
            <span className="font-semibold">Install a Solana wallet extension</span> in your
            browser.{" "}
            {anyInstalled ? (
              <span className="text-yes">
                Detected:{" "}
                {wallets
                  .filter((w) => w.installed)
                  .map((w) => w.name)
                  .join(", ")}
                .
              </span>
            ) : (
              <span>
                None detected. Install{" "}
                <a
                  className="underline text-accent"
                  href="https://phantom.com/download"
                  target="_blank"
                  rel="noreferrer"
                >
                  Phantom
                </a>
                ,{" "}
                <a
                  className="underline text-accent"
                  href="https://solflare.com/download"
                  target="_blank"
                  rel="noreferrer"
                >
                  Solflare
                </a>
                , or{" "}
                <a
                  className="underline text-accent"
                  href="https://backpack.app/download"
                  target="_blank"
                  rel="noreferrer"
                >
                  Backpack
                </a>{" "}
                and reload this page.
              </span>
            )}
          </span>
        </CheckRow>
        <CheckRow
          ok={walletCreated === null ? false : walletCreated}
          unknown={walletCreated === null}
        >
          <span>
            <span className="font-semibold">Create a wallet INSIDE the extension</span> (new
            seed phrase or import). Open the extension popup; if it shows &quot;Create a new
            wallet&quot; or &quot;Import a wallet,&quot; do that first. The site can&apos;t
            connect to an extension with zero wallets.
          </span>
        </CheckRow>
        <CheckRow ok={false} unknown>
          <span>
            <span className="font-semibold">Switch the wallet to Solana Devnet.</span>{" "}
            <button
              type="button"
              onClick={() => {
                // The DEVNET pill button in the header has aria-haspopup
                // "dialog". Find it and click it to open the instructions
                // popover — saves the user a separate click hunt.
                const pill = Array.from(document.querySelectorAll("button")).find(
                  (b) => b.textContent?.trim().toUpperCase() === "DEVNET",
                );
                pill?.click();
              }}
              className="underline text-accent hover:text-accentHover"
            >
              Open switch instructions →
            </button>
          </span>
        </CheckRow>
        <CheckRow ok={connected}>
          <span>
            <span className="font-semibold">Connect on this site.</span> After the three above
            are done, click <span className="font-semibold">Select Wallet</span> in the header,
            pick your wallet, approve in the extension popup.
          </span>
        </CheckRow>
      </ol>
    </div>
  );
}
