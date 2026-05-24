"use client";

// NetworkBadge — the cluster pill in the header.
//
// Clicking it opens a popover with click-by-click instructions for
// switching the user's wallet to devnet (or whichever cluster the site is
// currently on). The DEVNET / TESTNET / MAINNET label still indicates what
// the SITE is on; the popover explains how to make the WALLET match.
//
// Design choices the user pushed for (2026-05-22):
//   1. Detect the browser ONCE and only show that browser's "find the
//      extension" instruction. No more "Chrome / Brave / Edge" shrug
//      mixed into a single bullet.
//   2. Show ONE wallet's steps at a time, behind a two-tab toggle. The
//      Solflare/Phantom dual-render was wall-of-text and the user
//      couldn't tell which steps applied to them.
//   3. No "Works in: Chrome / Brave / Firefox / Edge" badge row. The
//      browser-specific instructions already encode that information;
//      the badge row was redundant noise.
//   4. All icons inlined as data URLs — no cdn.simpleicons.org. Safari
//      was silently dropping the CDN images on Strict tracking-prevention.
//   5. Phantom panel embeds an annotated SVG of the popup so the user
//      sees a picture of where the account avatar is, not just words.

import { useEffect, useMemo, useRef, useState } from "react";

import { cluster } from "@/lib/cluster";
import { WalletBrandIcon } from "@/components/WalletBrandIcon";
import {
  BROWSER_ICONS,
  PHANTOM_AVATAR_DIAGRAM,
} from "@/lib/walletIcons";
import {
  browserDisplayName,
  detectBrowser,
  findExtensionInstructions,
  isWalletSupportedBrowser,
  type DetectedBrowser,
} from "@/lib/browser";

const PHANTOM_HELP_URL = "https://help.phantom.com/hc/en-us/articles/4406393831187-How-do-I-change-my-network";
const SOLFLARE_HELP_URL = "https://docs.solflare.com/solflare/account-management/changing-networks";
const PHANTOM_DOWNLOAD_URL = "https://phantom.com/download";
const SOLFLARE_DOWNLOAD_URL = "https://solflare.com/download";

type WalletChoice = "solflare" | "phantom";

function clusterCopy(name: string): { label: string; tone: "neutral" | "warn"; intro: string } {
  switch (name) {
    case "mainnet":
      return {
        label: "MAINNET",
        tone: "warn",
        intro: "This site is on Solana Mainnet — real money. Most users do not want this for testing.",
      };
    case "testnet":
      return {
        label: "TESTNET",
        tone: "neutral",
        intro: "This site is on Solana Testnet. Your wallet must also be on testnet.",
      };
    case "devnet":
      return {
        label: "DEVNET",
        tone: "neutral",
        intro: "This site is on Solana Devnet — fake money for testing. Your wallet must also be on devnet to connect.",
      };
    case "localnet":
      return {
        label: "LOCALNET",
        tone: "neutral",
        intro: "This site is on your local validator. Your wallet must be pointed at the same RPC URL.",
      };
    default:
      return {
        label: name.toUpperCase(),
        tone: "neutral",
        intro: `This site is on ${name}. Your wallet must also be on ${name}.`,
      };
  }
}

/**
 * Small detected-browser pill rendered at the top of the popover so the
 * user can see at a glance "we know you're on Chrome — these steps are for
 * Chrome." If detection is unknown we hide it; if Safari we still show it
 * (the unsupported banner gives the actual hard-stop message).
 */
function DetectedBrowserPill({ browser }: { browser: DetectedBrowser }) {
  if (browser === "unknown") return null;
  const name = browserDisplayName(browser);
  // Capitalize first letter for icon key lookup (Chrome, Brave, etc.).
  const iconKey = (name.charAt(0).toUpperCase() + name.slice(1)) as keyof typeof BROWSER_ICONS;
  const icon = BROWSER_ICONS[iconKey];
  if (!icon) return null;
  return (
    <span className="inline-flex items-center gap-1.5 rounded-full border border-panel bg-panel/60 px-2 py-0.5 text-[10px] text-muted">
      <img src={icon} alt="" width={12} height={12} className="flex-shrink-0" />
      <span>
        Showing steps for <span className="font-semibold text-text">{name}</span>
      </span>
    </span>
  );
}

function SolflareSteps({ browser }: { browser: DetectedBrowser }) {
  // Solflare panel — the recommended path for first-time users. Solflare
  // offers in-flow wallet creation, so a brand-new user can finish the
  // entire connect flow without ever opening the extension popup
  // separately. The site's Select Wallet → Solflare popup carries them
  // through seed-phrase generation, network selection, and connection.
  return (
    <div className="space-y-3">
      <div className="rounded-md border border-yes/30 bg-yes/5 p-2.5 text-[11px] text-text">
        <span className="font-semibold text-yes">First time? Use this.</span> Solflare lets you
        create a wallet AS PART OF the connect flow. No separate setup. Pick &quot;Create new
        wallet&quot; when the Solflare popup opens.
      </div>
      <ol className="list-decimal space-y-2 pl-5 text-xs text-text">
        <li>
          <span className="font-semibold">Install Solflare</span> if you haven&apos;t already:{" "}
          <a
            href={SOLFLARE_DOWNLOAD_URL}
            target="_blank"
            rel="noreferrer"
            className="text-accent underline"
          >
            solflare.com/download
          </a>
          . Then reload this page so the site can detect it.
        </li>
        <li>
          <span className="font-semibold">Open Solflare from your toolbar.</span>{" "}
          <span className="text-muted">{findExtensionInstructions(browser, "Solflare")}</span>
        </li>
        <li>
          <span className="font-semibold">Create or import your wallet</span> from the popup
          wizard. Save the seed phrase on paper — never screenshot, never paste into cloud notes.
        </li>
        <li>
          In the open Solflare popup, click the <span className="font-semibold">three-dot menu</span>{" "}
          (top-right corner of the popup).
        </li>
        <li>
          Open <span className="font-semibold">Settings</span> →{" "}
          <span className="font-semibold">Manage Networks</span> → pick{" "}
          <span className="font-semibold">Devnet</span>.
        </li>
        <li>
          Come back to this tab and click <span className="font-semibold">Select Wallet</span> →{" "}
          Solflare. Approve in the popup.
        </li>
      </ol>
      <a
        href={SOLFLARE_HELP_URL}
        target="_blank"
        rel="noreferrer"
        className="inline-block text-xs text-accent underline"
      >
        Solflare docs: changing networks →
      </a>
    </div>
  );
}

function PhantomSteps({ browser }: { browser: DetectedBrowser }) {
  // Phantom panel — for users who already have a Phantom wallet, or who
  // specifically want to use Phantom. Phantom requires a pre-created
  // wallet inside the extension BEFORE the site's Select Wallet → Phantom
  // flow will work. Without that, Phantom returns "Unexpected error" with
  // no popup and the user has no idea why.
  //
  // The avatar location matters because the user told us they "tried a
  // bunch of things and still can't figure out how to get the testnet
  // thing going on." The inline diagram below makes "click the colored
  // circle in the top-left of the popup" visually obvious.
  return (
    <div className="space-y-3">
      <div className="rounded-md border border-no/40 bg-no/10 p-2.5 text-[11px] text-text">
        <span className="font-semibold text-no">Heads-up:</span> Phantom needs an existing wallet
        BEFORE you can connect. The site can&apos;t see an extension with zero wallets — Phantom
        returns &quot;Unexpected error&quot; with no popup. If you&apos;re brand new, switch to
        the Solflare tab above.
      </div>
      <ol className="list-decimal space-y-2 pl-5 text-xs text-text">
        <li>
          <span className="font-semibold">Install Phantom</span> if you haven&apos;t:{" "}
          <a
            href={PHANTOM_DOWNLOAD_URL}
            target="_blank"
            rel="noreferrer"
            className="text-accent underline"
          >
            phantom.com/download
          </a>
          .
        </li>
        <li>
          <span className="font-semibold">Open Phantom from your toolbar.</span>{" "}
          <span className="text-muted">{findExtensionInstructions(browser, "Phantom")}</span>
        </li>
        <li>
          If you don&apos;t already have a Phantom wallet:{" "}
          <span className="font-semibold">create or import one now</span>. Save the seed phrase on
          paper.
        </li>
        <li>
          In the open Phantom popup, click your{" "}
          <span className="font-semibold">account avatar</span> — the colored circle in the{" "}
          <span className="font-semibold">top-left corner</span> of the popup. See diagram below.
        </li>
        <li>
          <div className="my-1.5 inline-block rounded-lg border border-panel bg-bg/60 p-2">
            <div
              className="w-[160px]"
              // Inline SVG diagram of where the avatar sits in the popup.
              // dangerouslySetInnerHTML is safe here: the source string is
              // a hard-coded constant in walletIcons.ts, no user input.
              dangerouslySetInnerHTML={{ __html: PHANTOM_AVATAR_DIAGRAM }}
            />
          </div>
        </li>
        <li>
          A side panel slides in. Click <span className="font-semibold">Settings</span>.
        </li>
        <li>
          Scroll to <span className="font-semibold">Developer Settings</span> → toggle{" "}
          <span className="font-semibold">Testnet Mode</span> ON.
        </li>
        <li>
          Under the Solana row, pick <span className="font-semibold">Devnet</span>. Important:
          Solana <em>Testnet</em> is a DIFFERENT network — Meridian uses Solana <em>Devnet</em>.
        </li>
        <li>
          Close the side panel, come back to this tab, click{" "}
          <span className="font-semibold">Select Wallet</span> → Phantom. Approve in the popup.
        </li>
      </ol>
      <a
        href={PHANTOM_HELP_URL}
        target="_blank"
        rel="noreferrer"
        className="inline-block text-xs text-accent underline"
      >
        Phantom docs: changing your network →
      </a>
    </div>
  );
}

export function NetworkBadge() {
  const [open, setOpen] = useState(false);
  // Default to Solflare — the strictly-easier first-time path.
  const [choice, setChoice] = useState<WalletChoice>("solflare");
  const containerRef = useRef<HTMLDivElement>(null);
  const copy = clusterCopy(cluster.name);
  // useMemo so the result is stable for the lifetime of the component.
  // detectBrowser is sync + idempotent; memo makes the dependency intent clear.
  const browser = useMemo(() => detectBrowser(), []);
  const browserSupported = isWalletSupportedBrowser(browser);

  // Outside-click + Esc close. Without this the popover sticks around when
  // the user clicks anywhere else, which is a state-leak waiting to confuse
  // the next interaction.
  useEffect(() => {
    if (!open) return;
    function onDocClick(e: MouseEvent) {
      if (!containerRef.current) return;
      if (e.target instanceof Node && !containerRef.current.contains(e.target)) {
        setOpen(false);
      }
    }
    function onKey(e: KeyboardEvent) {
      if (e.key === "Escape") setOpen(false);
    }
    document.addEventListener("mousedown", onDocClick);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onDocClick);
      document.removeEventListener("keydown", onKey);
    };
  }, [open]);

  const badgeClass =
    copy.tone === "warn"
      ? "bg-no/20 text-no hover:bg-no/30"
      : "bg-panel text-muted hover:bg-panel/70 hover:text-text";

  return (
    <div className="relative" ref={containerRef}>
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        className={`rounded-full px-2 py-0.5 text-xs uppercase tracking-wider transition-colors ${badgeClass}`}
        title={`This site's RPC: ${cluster.rpcUrl}. Click for wallet-network switch instructions.`}
        aria-haspopup="dialog"
        aria-expanded={open}
        aria-label={`Site is on ${copy.label}. Open wallet-network switch instructions.`}
      >
        {copy.label}
      </button>
      {open && (
        <div
          role="dialog"
          aria-label="Wallet network switch instructions"
          className="absolute right-0 z-30 mt-2 w-[min(28rem,calc(100vw-3rem))] rounded-2xl border border-panel bg-bg/95 p-5 text-sm shadow-2xl backdrop-blur-md"
        >
          <div className="mb-3 flex items-start justify-between gap-3">
            <div>
              <p className="font-semibold text-text">Wallet must also be on {copy.label}</p>
              <p className="mt-1 text-xs text-muted">{copy.intro}</p>
              <div className="mt-2">
                <DetectedBrowserPill browser={browser} />
              </div>
            </div>
            <button
              onClick={() => setOpen(false)}
              className="rounded p-1 text-muted hover:bg-panel hover:text-text"
              aria-label="Close"
              title="Close"
            >
              ✕
            </button>
          </div>

          {!browserSupported && (
            <div className="mb-4 rounded-lg border border-no/40 bg-no/15 p-3 text-xs text-no">
              <p className="font-semibold">
                {browserDisplayName(browser)} doesn&apos;t support Solana wallet extensions.
              </p>
              <p className="mt-1 text-no/90">
                Open this site in Chrome, Brave, Edge, or Firefox to connect a wallet. Steps below
                still apply once you switch browsers.
              </p>
            </div>
          )}

          {/*
            Tab toggle. Aria-current marks the active panel for screen
            readers. Buttons (not links) because they don't change URL.
          */}
          <div
            role="tablist"
            aria-label="Choose which wallet you want to set up"
            className="mb-3 flex gap-2 rounded-lg border border-panel bg-panel/30 p-1"
          >
            <button
              role="tab"
              aria-selected={choice === "solflare"}
              onClick={() => setChoice("solflare")}
              className={
                choice === "solflare"
                  ? "flex-1 rounded-md bg-yes/15 px-2 py-1.5 text-xs font-semibold text-yes"
                  : "flex-1 rounded-md px-2 py-1.5 text-xs text-muted hover:text-text"
              }
            >
              <span className="inline-flex items-center gap-1.5">
                {/* Inline-SVG via WalletBrandIcon, not <img src=data:url>. The
                    same data-URL pipeline that broke the install rows on
                    2026-05-24 (Safari + Chrome) would silently break this
                    tab-toggle icon too; rendering inline removes the failure
                    mode entirely. */}
                <WalletBrandIcon name="Solflare" className="h-3.5 w-3.5" />
                Solflare
                {choice === "solflare" && (
                  <span className="rounded-full border border-yes/40 bg-yes/20 px-1.5 py-0.5 text-[9px] uppercase tracking-wider">
                    Easiest
                  </span>
                )}
              </span>
            </button>
            <button
              role="tab"
              aria-selected={choice === "phantom"}
              onClick={() => setChoice("phantom")}
              className={
                choice === "phantom"
                  ? "flex-1 rounded-md bg-accent/15 px-2 py-1.5 text-xs font-semibold text-accent"
                  : "flex-1 rounded-md px-2 py-1.5 text-xs text-muted hover:text-text"
              }
            >
              <span className="inline-flex items-center gap-1.5">
                {/* See sibling Solflare comment — inline SVG, not data URL. */}
                <WalletBrandIcon name="Phantom" className="h-3.5 w-3.5" />
                Phantom
              </span>
            </button>
          </div>

          <div role="tabpanel">
            {choice === "solflare" ? (
              <SolflareSteps browser={browser} />
            ) : (
              <PhantomSteps browser={browser} />
            )}
          </div>

          <p className="mt-4 border-t border-panel pt-3 text-xs text-muted">
            This site&apos;s RPC URL is{" "}
            <code className="rounded bg-panel/60 px-1 py-0.5 font-mono text-[10px] text-text">
              {cluster.rpcUrl}
            </code>
            . Your wallet&apos;s RPC must point at the same cluster (the host can differ).
          </p>
        </div>
      )}
    </div>
  );
}
