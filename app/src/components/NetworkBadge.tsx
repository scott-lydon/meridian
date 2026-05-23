"use client";

// NetworkBadge — the cluster pill in the header.
//
// Was originally a plain <span> with a tooltip naming the RPC URL. That
// looked like a button to anyone who didn't already know better; users on
// the wrong wallet network would click it expecting a network switch and
// get nothing. Per the no-silent-click policy (BUG_PREVENTION.md I1 /
// constitution.md §2.15), an interactive-looking element that doesn't
// react is a bug.
//
// Now: clicking the badge opens a popover with click-by-click instructions
// for switching Phantom and Solflare to devnet (or whichever cluster the
// site is currently on), plus the canonical docs link for each wallet.
// The DEVNET / TESTNET / MAINNET label still indicates what the SITE is
// on; the popover explains how to make the WALLET match it.

import { useEffect, useRef, useState } from "react";

import { cluster } from "@/lib/cluster";
import {
  BROWSER_ICONS,
  PHANTOM_ICON_DATA_URL,
  SOLFLARE_ICON_DATA_URL,
} from "@/lib/walletIcons";

const PHANTOM_HELP_URL = "https://help.phantom.com/hc/en-us/articles/4406393831187-How-do-I-change-my-network";
const SOLFLARE_HELP_URL = "https://docs.solflare.com/solflare/account-management/changing-networks";

// Visual chip used both in the wallet section headers (24px) and in the
// "Works in:" browser-compat row (16px). Memorialized as a tiny inline
// component because the alt-text / decorative-image rule shows up four
// times in this file and inlining would obscure intent.
function IconChip({
  src,
  alt,
  size,
  label,
}: {
  src: string;
  alt: string;
  size: number;
  label?: string;
}) {
  return (
    <span className="inline-flex items-center gap-1.5">
      <img
        src={src}
        alt={alt}
        width={size}
        height={size}
        className="flex-shrink-0 rounded-sm"
      />
      {label ? <span className="text-[10px] text-muted">{label}</span> : null}
    </span>
  );
}

function BrowserCompatRow() {
  return (
    <div className="mt-2 flex items-center gap-3 text-[10px] text-muted">
      <span className="uppercase tracking-wider">Works in:</span>
      <IconChip src={BROWSER_ICONS.Chrome} alt="Chrome" size={16} label="Chrome" />
      <IconChip src={BROWSER_ICONS.Brave} alt="Brave" size={16} label="Brave" />
      <IconChip src={BROWSER_ICONS.Firefox} alt="Firefox" size={16} label="Firefox" />
      <IconChip src={BROWSER_ICONS.Edge} alt="Edge" size={16} label="Edge" />
    </div>
  );
}

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

export function NetworkBadge() {
  const [open, setOpen] = useState(false);
  const containerRef = useRef<HTMLDivElement>(null);
  const copy = clusterCopy(cluster.name);

  // Outside-click + Esc close. Without this the popover sticks around when
  // the user clicks anywhere else, which is bad UX and a state-leak waiting
  // to confuse the next interaction.
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
          // Absolutely-positioned popover. Right-anchored so it doesn't fall
          // off the screen on narrow viewports. Max-w-sm keeps the line
          // length readable. z-30 stays under the WalletErrorBanner (z-50)
          // but above page content.
          className="absolute right-0 z-30 mt-2 w-[min(28rem,calc(100vw-3rem))] rounded-2xl border border-panel bg-bg/95 p-5 text-sm shadow-2xl backdrop-blur-md"
        >
          <div className="mb-3 flex items-start justify-between gap-3">
            <div>
              <p className="font-semibold text-text">Wallet must also be on {copy.label}</p>
              <p className="mt-1 text-xs text-muted">{copy.intro}</p>
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

          <div className="space-y-4">
            {/*
              Solflare goes FIRST — it offers a one-flow setup where you can
              create a wallet AS PART OF the connect handshake. Phantom
              requires you to create a wallet inside the extension BEFORE
              clicking Select Wallet (extension treats itself as a manager,
              site as a client). For a first-time user the Solflare path is
              strictly easier; for an existing wallet user either works.
            */}
            <div className="rounded-lg border border-yes/40 bg-yes/5 p-3">
              <div className="mb-2 flex items-center gap-2">
                <img
                  src={SOLFLARE_ICON_DATA_URL}
                  alt="Solflare logo"
                  width={24}
                  height={24}
                  className="rounded-md"
                />
                <p className="text-xs font-semibold uppercase tracking-wider text-yes">
                  Solflare
                </p>
                <span className="rounded-full border border-yes/40 bg-yes/15 px-2 py-0.5 text-[10px] font-semibold uppercase tracking-wider text-yes">
                  Easiest for new users
                </span>
              </div>
              <p className="mb-2 text-xs text-muted">
                Solflare lets you create a wallet AS PART OF the connect flow. Click Select
                Wallet → Solflare and follow the popup&apos;s setup wizard; the connection
                lands when the wizard finishes. No pre-setup required.
              </p>
              <ol className="list-decimal space-y-1.5 pl-5 text-xs text-text">
                <li>
                  Open the Solflare extension (yellow icon shown above). Don&apos;t see it in your
                  toolbar? Click the <span className="font-semibold">puzzle-piece</span> Extensions
                  icon (top right of Chrome / Brave / Edge), pick <span className="font-semibold">Solflare</span>,
                  pin for next time.
                </li>
                <li>If it&apos;s your first time, create or import a wallet from the wizard. Save the seed phrase on paper — never screenshot, never paste into cloud notes.</li>
                <li>Click the <span className="font-semibold">three-dot menu</span> (top right of the extension popup).</li>
                <li>Open <span className="font-semibold">Settings</span> → <span className="font-semibold">Manage Networks</span> → pick <span className="font-semibold">Devnet</span>.</li>
                <li>Come back to this tab and click <span className="font-semibold">Select Wallet</span> → Solflare.</li>
              </ol>
              <a
                href={SOLFLARE_HELP_URL}
                target="_blank"
                rel="noreferrer"
                className="mt-2 inline-block text-xs text-accent underline"
              >
                Solflare docs: changing networks →
              </a>
              <BrowserCompatRow />
            </div>

            <div className="rounded-lg border border-panel bg-panel/40 p-3">
              <div className="mb-2 flex items-center gap-2">
                <img
                  src={PHANTOM_ICON_DATA_URL}
                  alt="Phantom logo"
                  width={24}
                  height={24}
                  className="rounded-md"
                />
                <p className="text-xs font-semibold uppercase tracking-wider text-accent">
                  Phantom
                </p>
                <span className="rounded-full border border-no/40 bg-no/10 px-2 py-0.5 text-[10px] font-semibold uppercase tracking-wider text-no">
                  Requires pre-setup
                </span>
              </div>
              <p className="mb-2 text-xs text-muted">
                Phantom does NOT offer in-flow wallet creation. You must create a wallet inside
                the extension BEFORE returning to this site. If you click Select Wallet → Phantom
                without an existing wallet, Phantom returns &quot;Unexpected error&quot; with no
                popup. Use Solflare above if you want a one-step flow.
              </p>
              <ol className="list-decimal space-y-1.5 pl-5 text-xs text-text">
                <li>
                  Open the Phantom extension (purple icon shown above). Don&apos;t see it in your toolbar?
                  Click the <span className="font-semibold">puzzle-piece</span> Extensions icon (top right
                  of Chrome / Brave / Edge), pick <span className="font-semibold">Phantom</span>, pin for next time.
                </li>
                <li>
                  <span className="font-semibold text-no">FIRST-TIME USERS:</span> the popup shows
                  &quot;Create a new wallet&quot; or &quot;Import a wallet.&quot; You MUST finish
                  this step inside the extension. The site can&apos;t see an extension with
                  zero wallets. Save the seed phrase on paper.
                </li>
                <li>Click the <span className="font-semibold">gear icon</span> (Settings, bottom right of the extension popup).</li>
                <li>Scroll to <span className="font-semibold">Developer Settings</span> and tap it.</li>
                <li>Turn on <span className="font-semibold">Testnet Mode</span> (toggle to ON).</li>
                <li>Back on the main screen, tap the network name at the top (currently &quot;Mainnet&quot;) and pick <span className="font-semibold">Solana Devnet</span>.</li>
                <li>Come back to this tab and click <span className="font-semibold">Select Wallet</span> → Phantom.</li>
              </ol>
              <a
                href={PHANTOM_HELP_URL}
                target="_blank"
                rel="noreferrer"
                className="mt-2 inline-block text-xs text-accent underline"
              >
                Phantom docs: changing your network →
              </a>
              <BrowserCompatRow />
            </div>

            <p className="text-xs text-muted">
              This site&apos;s RPC URL is{" "}
              <code className="rounded bg-panel/60 px-1 py-0.5 font-mono text-[10px] text-text">
                {cluster.rpcUrl}
              </code>
              . Your wallet&apos;s RPC must point at the same cluster (the host can differ).
            </p>
          </div>
        </div>
      )}
    </div>
  );
}
