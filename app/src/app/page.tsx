"use client";

// Landing page. Two audiences:
//   1. Already-connected traders → quick CTA to the Markets grid.
//   2. New users staring at "Connect Wallet" wondering why their wallet
//      shows no balance → the devnet setup helper below explains the
//      EXACT failure modes I hit testing this (Solflare "No Active
//      Wallets Found" gating mainnet, Phantom defaulting to mainnet,
//      where to get devnet SOL + USDC).

import Link from "next/link";
import { useWallet } from "@solana/wallet-adapter-react";

import { cluster } from "@/lib/cluster";

export const dynamic = "force-dynamic";

export default function LandingPage() {
  const { publicKey } = useWallet();
  const connected = !!publicKey;

  return (
    <main className="mx-auto flex min-h-screen max-w-4xl flex-col items-start gap-8 px-6 py-12">
      <header className="flex flex-col gap-2">
        <h1 className="text-5xl font-bold tracking-tight">Meridian</h1>
        <p className="text-xl text-muted">
          Binary stock outcome markets on Solana <span className="text-accent">{cluster.name}</span>.
        </p>
      </header>

      <section className="grid w-full gap-4 sm:grid-cols-2">
        <div className="rounded-2xl border border-panel bg-panel/50 p-6">
          <h2 className="mb-2 text-lg font-semibold">What is a Meridian contract?</h2>
          <p className="text-sm leading-relaxed text-muted">
            Yes pays <span className="font-mono text-yes">$1.00</span> if the underlying stock closes
            at or above the strike at 16:00 ET. No pays{" "}
            <span className="font-mono text-no">$1.00</span> if it closes below. Yes + No = $1.00,
            always.
          </p>
        </div>
        <div className="rounded-2xl border border-panel bg-panel/50 p-6">
          <h2 className="mb-2 text-lg font-semibold">Where to go</h2>
          <ul className="space-y-1 text-sm text-muted">
            <li><Link className="text-accent" href="/markets">Markets</Link> — open strikes, place trades</li>
            <li><Link className="text-accent" href="/portfolio">Portfolio</Link> — your positions and redeem</li>
            <li><Link className="text-accent" href="/history">History</Link> — your tx log</li>
            <li><Link className="text-accent" href="/audit">Audit</Link> — invariant + automation health</li>
          </ul>
        </div>
      </section>

      {!connected && <DevnetSetupHelper />}

      {connected && (
        <Link
          href="/markets"
          className="rounded-xl bg-accent px-5 py-3 text-base font-semibold text-white hover:bg-accentHover"
        >
          Open Markets →
        </Link>
      )}
    </main>
  );
}

// Devnet onboarding helper. Landing-page overview of the four prerequisites
// to connect. Step 2 (switch wallet to devnet) used to inline a generic
// "settings (gear icon)" walkthrough — but the gear is in different places
// in Phantom vs. Solflare AND in different places across browsers, so the
// detailed click-by-click lives in the DEVNET pill's modal (NetworkBadge)
// where browser detection picks the right copy. Here we just point at it
// with a button that opens the modal programmatically.
//
// Single source of truth for the network-switch steps: NetworkBadge.tsx.
// Anything that needs to teach the user "how to switch your wallet to
// devnet" must call openNetworkSwitchModal() rather than inlining steps.
function DevnetSetupHelper() {
  // Click handler for "Open setup instructions" — locates the DEVNET pill
  // button in the header (it's a <button> whose textContent is the
  // cluster label, "DEVNET" / "TESTNET" / "MAINNET") and triggers click.
  // Failing closed: if the pill can't be found for any reason, scroll
  // the user to the header so they can find it visually instead of a
  // silent no-op.
  function openNetworkSwitchModal() {
    const pill = Array.from(document.querySelectorAll<HTMLButtonElement>("button")).find(
      (b) => b.textContent?.trim().toUpperCase() === cluster.name.toUpperCase(),
    );
    if (pill) {
      pill.click();
      pill.scrollIntoView({ behavior: "smooth", block: "center" });
    } else {
      // Should not happen — NetworkBadge always renders the pill in the
      // header. Surfacing as a console error makes the regression
      // immediately obvious if Header.tsx changes structure.
      console.error(
        "DevnetSetupHelper: could not locate the network pill button in the header.",
      );
      window.scrollTo({ top: 0, behavior: "smooth" });
    }
  }

  return (
    <section className="w-full rounded-2xl border border-accent/40 bg-accent/5 p-6">
      <h2 className="mb-3 text-lg font-semibold text-accent">First time? Devnet setup in 90 seconds</h2>
      <p className="mb-4 text-sm text-muted">
        Meridian runs on Solana <span className="font-mono">{cluster.name}</span>. Your wallet
        extension must (1) have a wallet imported, and (2) be switched to devnet, before you can
        Connect.
      </p>

      <ol className="space-y-3 text-sm">
        <li className="flex gap-3">
          <span className="font-mono text-accent">1.</span>
          <div>
            <p className="text-fg">
              <strong>Install a wallet extension:</strong>{" "}
              <a className="text-accent underline" href="https://solflare.com/download" target="_blank" rel="noreferrer">Solflare</a>{" "}
              (easiest — in-popup wallet creation) or{" "}
              <a className="text-accent underline" href="https://phantom.com/download" target="_blank" rel="noreferrer">Phantom</a>{" "}
              (requires creating a wallet inside the extension first).
            </p>
            <p className="text-xs text-muted">
              Create a new wallet OR import a seed phrase. Write the seed phrase down on paper — never screenshot, never paste into cloud notes.
            </p>
          </div>
        </li>

        <li className="flex gap-3">
          <span className="font-mono text-accent">2.</span>
          <div>
            <p className="text-fg">
              <strong>Switch the extension to Devnet.</strong> The exact clicks differ by wallet AND
              browser, so the instructions are tailored to you.
            </p>
            <button
              type="button"
              onClick={openNetworkSwitchModal}
              className="mt-1.5 inline-flex items-center gap-2 rounded-lg border border-accent/40 bg-accent/10 px-3 py-1.5 text-xs font-semibold text-accent hover:bg-accent/20"
            >
              Open click-by-click instructions →
            </button>
          </div>
        </li>

        <li className="flex gap-3">
          <span className="font-mono text-accent">3.</span>
          <div>
            <p className="text-fg">
              <strong>Fund your wallet on devnet:</strong> copy your address from the extension and use both faucets.
            </p>
            <ul className="ml-2 text-xs text-muted">
              <li>
                <a className="text-accent underline" href="https://faucet.solana.com" target="_blank" rel="noreferrer">faucet.solana.com</a>{" "}
                — devnet SOL (gas fees). Has a Cloudflare captcha + GitHub OAuth gate.
              </li>
              <li>
                <a className="text-accent underline" href="https://faucet.circle.com" target="_blank" rel="noreferrer">faucet.circle.com</a>{" "}
                — devnet USDC (trading currency). No captcha. Pick "Solana Devnet" in the network dropdown.
              </li>
            </ul>
          </div>
        </li>

        <li className="flex gap-3">
          <span className="font-mono text-accent">4.</span>
          <div>
            <p className="text-fg">
              <strong>Click Select Wallet</strong> (top right). Pick your extension, approve the popup, you're in.
            </p>
            <p className="text-xs text-muted">
              The extension MUST be on devnet at connect time. If you see "wallet not connected" errors after clicking Connect, your extension is probably still on mainnet — switch it and retry.
            </p>
          </div>
        </li>
      </ol>

      <p className="mt-4 rounded border border-panel/60 bg-panel/30 p-3 text-xs text-muted">
        <strong className="text-fg">Devnet = fake money.</strong> All SOL and USDC on devnet are testnet tokens with no monetary value. You can't lose real money trading here. Devnet is wiped periodically; treat any positions as ephemeral.
      </p>
    </section>
  );
}
