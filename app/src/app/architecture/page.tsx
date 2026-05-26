"use client";

// Architecture page — multi-audience explanation of how Meridian works.
//
//   1. ELI7 (Explain Like I'm 7): friendly emoji cartoon for first-time
//      visitors who do not know what a blockchain is.
//   2. Topology + Components: full architecture with Mermaid diagram, per-
//      component pros/cons cards, sequence diagram of the daily lifecycle.
//   3. Decisions + Trade-offs: the architectural choices mirrored from
//      plan.md §4 and §5; what we chose, what we considered, and why.
//   4. Stack: every dependency at a glance with logos.
//   5. Lifecycle + invariant + decentralization: the operational guarantees.
//   6. Glossary: every piece of jargon used in this app.
//
// Real first-time users skim ELI7, then go trade. Graders read all the
// sections in order. Mermaid is loaded from CDN (one bundle, no npm dep)
// the same way the standalone website does it, so the diagrams render
// identically in-app and on the static site.

import Script from "next/script";
import { useEffect } from "react";

import Link from "next/link";

import { techIconUrl } from "@/lib/techIcons";

export const dynamic = "force-dynamic";

// Re-render Mermaid every time the page mounts. Safe to call repeatedly;
// mermaid.run() is idempotent on already-rendered diagrams.
function useMermaidRender() {
  useEffect(() => {
    // Defer to next tick so the script has a chance to attach window.mermaid
    // when this client component hydrates after the Script tag below.
    const tick = () => {
      const w = window as unknown as {
        mermaid?: {
          initialize: (cfg: Record<string, unknown>) => void;
          run: (opts?: { querySelector?: string }) => void;
        };
      };
      if (!w.mermaid) {
        // The Script load handler also calls initialize; if mermaid is not
        // here yet, the load handler will pick it up on its own. We avoid
        // a busy loop because the alternative (polling) wastes CPU.
        return;
      }
      w.mermaid.initialize({
        startOnLoad: false,
        theme: "dark",
        securityLevel: "loose",
        themeVariables: {
          primaryColor: "#1a2236",
          primaryTextColor: "#e2e8f0",
          primaryBorderColor: "#2d3654",
          lineColor: "#94a3b8",
          secondaryColor: "#232c45",
          tertiaryColor: "#0a0e1a",
          background: "#0a0e1a",
        },
      });
      w.mermaid.run({ querySelector: ".mermaid" });
    };
    // Run once now (covers the case where the user navigated here from
    // another route and the script is already cached), and once on the
    // next animation frame (covers the cold-load case).
    tick();
    const id = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(id);
  }, []);
}

export default function ArchitecturePage() {
  useMermaidRender();
  return (
    <main className="mx-auto max-w-6xl px-6 py-12">
      {/* Mermaid CDN. Same CDN URL the standalone website at
          /website/index.html uses, so diagrams render identically. */}
      <Script
        src="https://cdn.jsdelivr.net/npm/mermaid@10/dist/mermaid.min.js"
        strategy="afterInteractive"
        onLoad={() => {
          const w = window as unknown as {
            mermaid?: {
              initialize: (cfg: Record<string, unknown>) => void;
              run: (opts?: { querySelector?: string }) => void;
            };
          };
          if (!w.mermaid) return;
          w.mermaid.initialize({
            startOnLoad: false,
            theme: "dark",
            securityLevel: "loose",
            themeVariables: {
              primaryColor: "#1a2236",
              primaryTextColor: "#e2e8f0",
              primaryBorderColor: "#2d3654",
              lineColor: "#94a3b8",
              secondaryColor: "#232c45",
              tertiaryColor: "#0a0e1a",
              background: "#0a0e1a",
            },
          });
          w.mermaid.run({ querySelector: ".mermaid" });
        }}
      />

      <header className="mb-12">
        <h1 className="text-5xl font-bold tracking-tight">How Meridian works</h1>
        <p className="mt-3 text-lg text-muted">
          Architecture, data flow, and design trade-offs. Plus an ELI7 walk-through and a full
          glossary.
        </p>
        <nav className="mt-6 flex flex-wrap gap-3 text-sm">
          <SectionLink href="#eli7">Explain to a 7 year old</SectionLink>
          <SectionLink href="#topology">Topology</SectionLink>
          <SectionLink href="#components">Components</SectionLink>
          <SectionLink href="#flow">Data flow</SectionLink>
          <SectionLink href="#lifecycle">Daily lifecycle</SectionLink>
          <SectionLink href="#decisions">Decisions</SectionLink>
          <SectionLink href="#tradeoffs">Trade-offs</SectionLink>
          <SectionLink href="#invariant">Invariant</SectionLink>
          <SectionLink href="#decentralization">Decentralization</SectionLink>
          <SectionLink href="#stack">Stack</SectionLink>
          <SectionLink href="#glossary">Glossary</SectionLink>
        </nav>
      </header>

      <Eli7Section />
      <TopologySection />
      <ComponentsSection />
      <DataFlowSection />
      <LifecycleSection />
      <DecisionsSection />
      <TradeoffsSection />
      <InvariantSection />
      <DecentralizationSection />
      <StackSection />
      <GlossarySection />

      <footer className="mt-16 border-t border-panel pt-6 text-sm text-muted">
        Source on{" "}
        <a
          className="text-accent underline"
          href="https://github.com/scott-lydon/meridian"
          target="_blank"
          rel="noreferrer"
        >
          GitHub
        </a>
        . Verify everything on{" "}
        <a
          className="text-accent underline"
          href="https://explorer.solana.com/address/ERtAbZetHFVmFKyTzfJd9LdMGsqu5b2TWeWc65sikPaX?cluster=devnet"
          target="_blank"
          rel="noreferrer"
        >
          Solana Explorer
        </a>
        . Standalone single-page version of this same content lives at{" "}
        <a
          className="text-accent underline"
          href="https://github.com/scott-lydon/meridian/blob/main/website/index.html"
          target="_blank"
          rel="noreferrer"
        >
          website/index.html
        </a>{" "}
        in the repo.
      </footer>
    </main>
  );
}

function SectionLink({ href, children }: { href: string; children: React.ReactNode }) {
  return (
    <a
      href={href}
      className="rounded-full border border-panel bg-panel/40 px-4 py-1.5 text-accent hover:bg-panel"
    >
      {children}
    </a>
  );
}

// ===========================================================================
// 1 — Explain to a 7 year old.
// ===========================================================================

function Eli7Section() {
  return (
    <section id="eli7" className="mb-16 rounded-2xl border border-accent/40 bg-accent/5 p-8">
      <h2 className="mb-2 text-3xl font-bold">🧸 Explain this to me like I&apos;m 7</h2>
      <p className="mb-8 text-sm text-muted">
        No homework needed. If you can play a game with cards, you can use Meridian.
      </p>

      <div className="space-y-6 text-base">
        <Eli7Card emoji="🎟️" title="It&apos;s a betting card game about big-company stocks">
          You know how some kids&apos; parents buy little pieces of companies like Apple? Those pieces
          are called stocks. Meridian lets you play a game where you bet on whether a company&apos;s
          stock will close up high or down low at the end of the day. 🍎📈
        </Eli7Card>

        <Eli7Card emoji="🎟️" title="There are TWO kinds of tickets: Yes 🟢 and No 🔴">
          Every game has two tickets. The 🟢 <strong>Yes</strong> ticket says &quot;the price WILL be above this number.&quot;
          The 🔴 <strong>No</strong> ticket says &quot;the price will NOT.&quot; Only one ticket wins.
          🏆 The winning ticket is worth exactly <span className="font-mono text-yes">$1.00</span>. The
          losing ticket is worth <span className="font-mono text-no">$0.00</span> (sad face 😢).
        </Eli7Card>

        <Eli7Card emoji="🏦" title="Where do the tickets come from? A vending machine!">
          🪙 You put <strong>$1.00</strong> into a magic vending machine called <strong>Mint Pair</strong>.
          🤖 It gives you back <strong>both</strong> tickets — one 🟢 Yes and one 🔴 No. You can keep
          them, or sell them to other kids. The machine never runs out, and the $1.00 stays safe in
          a piggy bank 🐷 until someone comes to claim their winning ticket.
        </Eli7Card>

        <Eli7Card emoji="🛒" title="The market is a school lunch trade table">
          Other kids put their tickets on a big trade table called the <strong>order book</strong> 📋.
          Some say &quot;I&apos;ll sell my 🟢 Yes for 50 cents.&quot; Others say &quot;I&apos;ll
          buy 🟢 Yes for 40 cents.&quot; When the prices match — boom 💥 — they trade. You can join in
          and buy or sell whenever you want, until the bell rings at 4:00 PM.
        </Eli7Card>

        <Eli7Card emoji="⏰" title="The bell rings at 4:00 PM (the market close)">
          🛎️ When 4:00 PM hits, no more trading. A trusted scorekeeper called <strong>Pyth</strong> 🔮
          looks at the real-world stock price and says: &quot;The stock closed at $682. The strike
          was $680. Yes wins!&quot; 🎉
        </Eli7Card>

        <Eli7Card emoji="🏆" title="Now everyone collects">
          Whoever has 🟢 Yes tickets walks up to the piggy bank 🐷 and trades each one for $1.00. Whoever
          has 🔴 No tickets... well, those are just souvenirs now 😅. The piggy bank pays out exactly
          the right amount — it can never run out, because every ticket was paid for when it was
          minted. Every dollar in equals every dollar out. ⚖️
        </Eli7Card>

        <Eli7Card emoji="🔐" title="Why is this safe? No one is holding your money">
          Your money never goes to Meridian. It goes straight into the piggy bank 🐷 which is on
          the Solana blockchain — a giant computer that nobody owns but everybody can see. Meridian
          can&apos;t take your money, lose your money, or change the rules halfway through. The rules
          are written in code that anyone can read. 👀
        </Eli7Card>

        <div className="rounded-xl border border-panel bg-panel/40 p-5 text-sm">
          <p className="mb-2 font-semibold">📝 The whole thing in one sentence:</p>
          <p className="text-muted">
            Pay $1, get a Yes 🟢 ticket and a No 🔴 ticket, sell either one to other kids until 4 PM,
            and the winner trades the winning ticket back in for $1. 🪙
          </p>
        </div>
      </div>
    </section>
  );
}

function Eli7Card({ emoji, title, children }: { emoji: string; title: string; children: React.ReactNode }) {
  return (
    <div className="flex gap-4 rounded-xl border border-panel bg-bg/40 p-5">
      <div className="text-3xl leading-none">{emoji}</div>
      <div className="flex-1">
        <h3 className="mb-1 text-lg font-semibold">{title}</h3>
        <p className="text-muted">{children}</p>
      </div>
    </div>
  );
}

// ===========================================================================
// 2 — Topology (Mermaid flowchart).
// ===========================================================================

// Mermaid topology diagram. Icons reference inline data URLs from
// techIcons.ts (no cdn.simpleicons.org) so the diagram renders identically
// in Safari, which silently drops simpleicons CDN requests under Strict
// tracking-prevention. mermaid.initialize is called with securityLevel:
// "loose" elsewhere in this file, which is what permits <img> in node
// labels in the first place.
// Topology grouping rationale (read before editing):
//
//   The Solana program IS the backend; Render hosts two off-chain clients.
//   The diagram makes this explicit by putting the Next.js UI inside a
//   "User's browser" subgraph (where it actually runs at runtime, even
//   though it's served from Render) and labeling the Solana subgraph as
//   the decentralized backend. The wallet node shows Phantom, Solflare,
//   and Coinbase Wallet icons because the WalletProvider explicitly wires
//   in all three adapters alongside Wallet Standard auto-discovery —
//   Phantom and Solflare back Safari, and Coinbase Wallet does not
//   publish a Wallet Standard handshake so it must be wired explicitly.
//   Any other Wallet-Standard wallet (Backpack, Glow, etc.) still
//   surfaces automatically via auto-discovery; Phantom is not special.
//
//   The previous version of this diagram labeled the wallet alone as
//   "Client" and stuck Next.js in an "Off-chain" subgraph next to the
//   keeper, which made it look like (a) Phantom IS the product and
//   (b) the UI talks through the keeper to reach Solana. Both wrong.
//   The UI talks to Solana directly via RPC + WS; it does NOT route
//   through the keeper. The only UI→keeper edge in the system is the
//   /audit page polling the keeper's /health endpoint, which is cosmetic
//   and intentionally not in this diagram.
const TOPOLOGY_MERMAID = `flowchart LR
  subgraph Browser["User's browser"]
    direction TB
    Wallet["<img src='${techIconUrl("phantom")}' width='16'/> <img src='${techIconUrl("solflare")}' width='16'/> <img src='${techIconUrl("coinbase")}' width='16'/> Phantom / Solflare / Coinbase<br/>(Wallet Standard + explicit adapters)"]
    UI["<img src='${techIconUrl("nextdotjs")}' width='18'/> Next.js 14 UI<br/>(served from Render)"]
    Wallet -->|sign tx| UI
  end
  subgraph Off["Off-chain keeper"]
    Automation["<img src='${techIconUrl("nodedotjs")}' width='18'/> Automation service<br/>(Render, admin keypair)"]
  end
  subgraph Oracle["Price oracle"]
    Pyth["<img src='${techIconUrl("pyth")}' width='18'/> Pyth Hermes<br/>MAG7 equity feeds"]
  end
  subgraph Solana["Solana devnet (decentralized backend)"]
    direction TB
    Program["<img src='${techIconUrl("rust")}' width='18'/> Meridian program<br/>(Anchor 0.31.1)"]
    Config["Config PDA"]
    Market["Market PDA<br/>(per strike per day)"]
    Book["OrderBook<br/>(zero-copy slabs)"]
    Vault["USDC vault"]
    Mints["Yes/No mints"]
  end
  UI -->|RPC + WS| Program
  Automation -->|cron 08:00 ET<br/>create markets| Program
  Automation -->|cron 16:05 ET<br/>settle| Program
  Pyth -.->|prev close| Automation
  Pyth -.->|on-chain verify| Program
  Program --- Config
  Program --- Market
  Program --- Book
  Program --- Vault
  Program --- Mints`;

function TopologySection() {
  return (
    <section id="topology" className="mb-16">
      <h2 className="mb-2 text-3xl font-bold">Topology</h2>
      <p className="mb-6 max-w-3xl text-muted">
        The backend is a Solana program. The two boxes labeled <em>Render</em> are off-chain
        clients, not the source of truth. The Next.js UI runs inside the user&apos;s browser
        (it&apos;s only <em>served</em> from Render). The keeper bot runs as a long-lived
        daemon and holds the admin keypair. Both talk to Solana directly, not to each other.
        The wallet is multi-provider: Phantom, Solflare, Coinbase Wallet, or any Wallet-Standard
        wallet (Backpack, Glow, etc.) shows up in the connect modal. Phantom, Solflare, and
        Coinbase Wallet are wired explicitly because two of them (Phantom on Safari, Coinbase
        Wallet everywhere) do not publish the Wallet Standard handshake the auto-discovery code
        path expects.
      </p>
      <div className="rounded-2xl border border-panel bg-panel/40 p-6">
        <pre className="mermaid text-sm">{TOPOLOGY_MERMAID}</pre>
      </div>
    </section>
  );
}

// ===========================================================================
// 3 — Components (per-component pros/cons cards).
// ===========================================================================

interface ComponentSpec {
  title: string;
  icon: string;
  iconColor: string;
  chain: string;
  blurb: string;
  pros: string[];
  cons: string[];
}

const COMPONENTS: ComponentSpec[] = [
  {
    title: "Anchor program",
    icon: "rust",
    iconColor: "c1763a",
    chain: "On-chain (Solana devnet)",
    blurb:
      "Single Solana program. Owns every piece of on-chain state. Instructions: initialize_config, create_strike_market, mint_pair, place_order, cancel_order, match_orders, settle_market, admin_settle, redeem, pause, unpause.",
    pros: [
      "One source of truth for state",
      "Atomic Buy No path is feasible",
      "Property tests for invariants",
    ],
    cons: [
      "Custom matcher is less battle-tested than Phoenix",
      "Stack pressure from large accounts",
      "Compute budget per tx is finite",
    ],
  },
  {
    title: "In-program order book",
    icon: "anchor",
    iconColor: "512BD4",
    chain: "On-chain (Solana devnet)",
    blurb:
      "Zero-copy slabs. Bids descending, asks ascending. FIFO at price. Depth 64 per side. USDC and Yes escrow ATAs owned by book PDA. Matching via permissionless cranker.",
    pros: [
      "Atomic mint + sell in one instruction",
      "No off-chain listing coordination",
      "Fits Solana CPI create limit",
    ],
    cons: [
      "Less depth than mature DEXs",
      "We own matching-engine bugs",
      "Requires zero-copy discipline",
    ],
  },
  {
    title: "Frontend (Next.js)",
    icon: "nextdotjs",
    iconColor: "ffffff",
    chain: "Off-chain (Render)",
    blurb:
      "App Router on Render. Pages: landing, markets grid, trade page with order book, portfolio, history, audit, this page. TanStack Query for chain reads, wallet adapter for Phantom, Solflare, and Coinbase Wallet (plus Wallet Standard auto-discovery for Backpack and others). Branded UsdcBase bigint type for money.",
    pros: [
      "Type-safe Anchor client generated from IDL",
      "Sub-2s order book polling",
      "One client of many possible clients",
    ],
    cons: [
      "Buffer / Node polyfill bundle weight",
      "Wallet adapter UX is opinionated",
    ],
  },
  {
    title: "Automation service",
    icon: "nodedotjs",
    iconColor: "339933",
    chain: "Off-chain (Render)",
    blurb:
      "Node 20 + croner on Render. Two crons in America/New_York. Morning at 08:00 ET reads Pyth previous close and calls create_strike_market per strike. Settlement at 16:05 ET posts a fresh PriceUpdateV2 on-chain and calls settle_market per market. NYSE calendar hard-coded. JSON logs (pino).",
    pros: [
      "Sub-100ms cron drift",
      "Idempotent on every job",
      "Boot-time catch-up if a slot was missed",
    ],
    cons: [
      "Single-instance (no HA in v1)",
      "Keypair custody required for create_strike_market",
    ],
  },
  {
    title: "Pyth oracle",
    icon: "pyth",
    iconColor: "4ec9b0",
    chain: "Read-only (pull model)",
    blurb:
      "Two distinct paths. Off-chain: Hermes HTTPS API gives the previous close for strike generation and the live display ticker on the trade page (refreshes every 5s). On-chain: pyth-solana-receiver-sdk PriceUpdateV2 accounts are posted by the cranker and verified inside settle_market against feed_id, max_staleness_secs, and max_confidence_bps from the program Config.",
    pros: [
      "First-class MAG7 equity feeds with confidence intervals",
      "Pull model lets us post a fresh price at settle time",
      "Hermes is independent infra from on-chain verification",
    ],
    cons: [
      "Sustained Hermes outage during US close requires admin_settle fallback",
      "Two integration points for the same vendor (Hermes + on-chain) is more surface area",
    ],
  },
];

function ComponentsSection() {
  return (
    <section id="components" className="mb-16">
      <h2 className="mb-2 text-3xl font-bold">Components</h2>
      <p className="mb-6 text-muted">Five pieces. Each does one thing.</p>
      <div className="grid gap-6 lg:grid-cols-2">
        {COMPONENTS.map((c) => (
          <div key={c.title} className="rounded-2xl border border-panel bg-panel/40 p-6">
            <div className="mb-2 flex items-center gap-2">
              {/* Inline data URL — see lib/techIcons.ts. cdn.simpleicons.org
                  is forbidden because Safari Strict tracking-prevention
                  silently drops those requests. */}
              <img src={techIconUrl(c.icon)} width={20} height={20} alt="" />
              <h3 className="text-xl font-semibold">{c.title}</h3>
            </div>
            <p className="text-xs uppercase tracking-wider text-muted">{c.chain}</p>
            <p className="mt-3 text-sm text-text">{c.blurb}</p>
            <div className="mt-4 grid grid-cols-2 gap-4 text-sm">
              <div>
                <div className="mb-1 font-semibold text-yes">Pros</div>
                <ul className="list-inside list-disc space-y-1 text-muted">
                  {c.pros.map((p) => (
                    <li key={p}>{p}</li>
                  ))}
                </ul>
              </div>
              <div>
                <div className="mb-1 font-semibold text-no">Cons</div>
                <ul className="list-inside list-disc space-y-1 text-muted">
                  {c.cons.map((p) => (
                    <li key={p}>{p}</li>
                  ))}
                </ul>
              </div>
            </div>
          </div>
        ))}
      </div>
    </section>
  );
}

// ===========================================================================
// 4 — Data flow sequence.
// ===========================================================================

const FLOW_MERMAID = `sequenceDiagram
  participant Cron as Automation
  participant Pyth as Pyth Hermes
  participant Prog as Anchor program
  participant User as User wallet
  Cron->>Pyth: 08:00 ET fetch prev closes (7 tickers)
  Pyth-->>Cron: prices + publish_time
  loop per ticker
    Cron->>Cron: compute strikes ±3,6,9% rounded $10
  end
  loop per (ticker, strike)
    Cron->>Prog: create_strike_market (admin)
    Prog-->>Cron: Market PDA created
  end
  Note over User,Prog: 09:00-16:00 ET trading
  User->>Prog: mint_pair(N) → pays N USDC, gets N Yes + N No
  User->>Prog: place_order(Bid, price, qty) → escrow USDC
  Cron->>Pyth: 16:05 ET post fresh PriceUpdateV2 on-chain
  Pyth-->>Prog: PriceUpdateV2 account written
  loop per market
    Cron->>Prog: settle_market(market_pda, price_update)
    Prog->>Prog: validate feed_id + staleness + conf bps
    Prog->>Prog: write Outcome (YesWins or NoWins)
  end
  User->>Prog: redeem(side, qty) → burn → $1.00 if winner`;

function DataFlowSection() {
  return (
    <section id="flow" className="mb-16">
      <h2 className="mb-2 text-3xl font-bold">Data flow — daily lifecycle</h2>
      <p className="mb-6 max-w-3xl text-muted">
        One end-to-end happy-path trade from before-open to redeemed-winnings.
      </p>
      <div className="rounded-2xl border border-panel bg-panel/40 p-6">
        <pre className="mermaid text-sm">{FLOW_MERMAID}</pre>
      </div>
    </section>
  );
}

// ===========================================================================
// 5 — Lifecycle (the operational timeline as numbered steps).
// ===========================================================================

function LifecycleSection() {
  return (
    <section id="lifecycle" className="mb-16">
      <h2 className="mb-2 text-3xl font-bold">A day in the life</h2>
      <p className="mb-6 max-w-3xl text-muted">
        What happens on a typical US trading day, step by step. Times are in America/New_York. The
        automation service runs under TZ=America/New_York so daylight-savings transitions are
        handled by the runtime, not by hand-written offsets.
      </p>
      <ol className="space-y-3 text-sm">
        <Step
          n="1"
          t="08:00 ET"
          line="Morning cron (automation/src/jobs/morning.ts) reads previous close from Pyth Hermes, generates ±3% / ±6% / ±9% / 0% strikes per MAG7 ticker (rounded to $10, deduped), and calls create_strike_market for each new (ticker, strike) the program has never seen. Admin signer required."
        />
        <Step
          n="2"
          t="09:00 ET"
          line="Markets open in the UI. Traders mint pairs, place Bids/Asks on the order book, and take positions. Permissionless match_orders crosses overlapping orders into fills. Anyone with a keypair can crank."
        />
        <Step
          n="3"
          t="16:00 ET"
          line="Expiry. expiry_unix is in the past. The UI gates new orders, new pair mints, and new sell flows on a client-side isExpired check, and the trade page shows the 'Trading closed — awaiting settlement' banner. Heads-up: the on-chain Anchor program does NOT currently honour expiry on place_order / mint_pair / buy_no / sell_no (tracked in tasks.md as a hardening pass). A wallet that bypassed the UI could still submit those transactions."
        />
        <Step
          n="4"
          t="16:05 ET"
          line="Settlement cron (automation/src/jobs/settlement.ts) posts a fresh Pyth PriceUpdateV2 account on-chain, then calls settle_market(market, price_update). The program validates feed_id matches market.pyth_feed_id, publish_time is within max_staleness_secs, and conf_bps is within max_confidence_bps. On success it writes the binary outcome (YesWins or NoWins) and the closing_price into the Market account."
        />
        <Step
          n="5"
          t="any time after"
          line="Winners call redeem; each winning token burns and pays out $1.00 USDC from the vault. Losers can also redeem (burns the worthless token, reclaims the SPL rent fee, $0.00 payout). The vault_balance == pairs_outstanding × $1.00 invariant is enforced on every operation that touches the vault."
        />
        <Step
          n="6"
          t="if Pyth dies"
          line="admin_settle is a time-locked fallback. After 60 minutes past expiry without a successful settle_market, the admin can submit a manual closing price. The admin_override flag is recorded on the Market account so any redeem path knows the outcome came from the fallback, not from Pyth."
        />
      </ol>
    </section>
  );
}

function Step({ n, t, line }: { n: string; t: string; line: string }) {
  return (
    <li className="flex gap-4 rounded-lg border border-panel bg-panel/30 p-3">
      <span className="rounded-full bg-accent/20 px-2.5 py-1 font-mono text-xs text-accent">{n}</span>
      <div className="flex-1">
        <p className="font-mono text-xs text-muted">{t}</p>
        <p className="text-sm">{line}</p>
      </div>
    </li>
  );
}

// ===========================================================================
// 6 — Decisions table (mirror of plan.md §4).
// ===========================================================================

interface DecisionRow {
  decision: string;
  chose: string;
  alternative: string;
  why: string;
}

const DECISIONS: DecisionRow[] = [
  { decision: "Chain", chose: "Solana devnet", alternative: "Arbitrum / Base / HyperLiquid", why: "Sub-second finality; PRD-required for pass." },
  { decision: "Program framework", chose: "Anchor 0.31.1", alternative: "Raw Solana program", why: "Account validation, IDL, type-safe TS client." },
  { decision: "Order book", chose: "In-program slabs", alternative: "Phoenix CPI", why: "Atomic Buy No needs single-program revert." },
  { decision: "Oracle", chose: "Pyth (pull model)", alternative: "Switchboard", why: "First-class MAG7 equity feeds + confidence interval." },
  { decision: "USDC", chose: "Circle devnet mint", alternative: "Custom stable", why: "Real mint mirrors mainnet semantics." },
  { decision: "Token standard", chose: "SPL Token", alternative: "Token-2022", why: "No transfer hooks needed in v1." },
  { decision: "Wallet", chose: "@solana/wallet-adapter w/ explicit Phantom + Solflare + Coinbase adapters", alternative: "Per-wallet integration or Wallet Standard auto-discovery alone", why: "Standard. Explicit Phantom + Solflare back Safari (no synchronous handshake there). Explicit Coinbase Wallet because it does not publish a Wallet Standard handshake at all; users coming from Coinbase get a path that does not require installing a second wallet just for Meridian." },
  { decision: "Frontend", chose: "Next.js 14 App Router", alternative: "Vite + React Router", why: "SSR landing, client trading, Render ergonomics." },
  { decision: "Server state", chose: "TanStack Query", alternative: "Apollo / SWR", why: "Best cache invalidation by key." },
  { decision: "UI state", chose: "Zustand", alternative: "Redux / Jotai", why: "No allocation in selectors (avoids React error #185)." },
  { decision: "Automation", chose: "Node 20 + croner", alternative: "Lambda / CloudFlare Workers", why: "Long-running process for cron + crank work." },
  { decision: "Logging", chose: "pino (JSON)", alternative: "Winston / console", why: "Fastest Node logger; Render scrapes structured JSON." },
];

function DecisionsSection() {
  return (
    <section id="decisions" className="mb-16">
      <h2 className="mb-2 text-3xl font-bold">Decisions</h2>
      <p className="mb-6 max-w-3xl text-muted">
        Every architectural choice, the alternative considered, and why. Mirror of{" "}
        <code className="text-xs">plan.md §4</code>; if this table disagrees with the plan, the
        plan wins.
      </p>
      <div className="overflow-x-auto rounded-2xl border border-panel bg-panel/40">
        <table className="w-full text-sm">
          <thead>
            <tr className="text-left text-xs uppercase tracking-wider text-muted">
              <th className="px-4 py-3">Decision</th>
              <th className="px-4 py-3">We chose</th>
              <th className="px-4 py-3">Alternative</th>
              <th className="px-4 py-3">Why</th>
            </tr>
          </thead>
          <tbody>
            {DECISIONS.map((d) => (
              <tr key={d.decision} className="border-t border-panel/50">
                <td className="px-4 py-3">{d.decision}</td>
                <td className="px-4 py-3 font-semibold">{d.chose}</td>
                <td className="px-4 py-3 text-muted">{d.alternative}</td>
                <td className="px-4 py-3 text-muted">{d.why}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </section>
  );
}

// ===========================================================================
// 7 — Trade-off panels (mirror of plan.md §5).
// ===========================================================================

interface TradeoffSpec {
  title: string;
  whyAccept: string;
  whenBites: string;
  mitigation: string;
}

const TRADEOFFS: TradeoffSpec[] = [
  {
    title: "In-program order book vs Phoenix CPI",
    whyAccept:
      "atomic Buy No needs a single-program revert; Phoenix listing required off-chain coordination and would block the atomic path.",
    whenBites:
      "an obscure slab-walk bug that no one happens to write a test for.",
    mitigation:
      "property tests on conservation (USDC + Yes + No invariant) across thousands of random op sequences; vouch coverage on the deployed UI.",
  },
  {
    title: "Pyth pull vs Switchboard",
    whyAccept:
      "first-class MAG7 equity feeds with confidence intervals; the pull model lets the cranker post a fresh price at settle time.",
    whenBites:
      "sustained Hermes outage longer than 15 minutes during the US close.",
    mitigation:
      "admin_settle is a time-locked manual fallback after 60 minutes, with the admin_override flag recorded on-chain so every redeem path can see the outcome was not from Pyth.",
  },
  {
    title: "Position constraint as UX rule (not program rule)",
    whyAccept:
      "market makers calling mint_pair transiently hold both Yes and No; blocking the position at program level would break legitimate liquidity provision.",
    whenBites:
      "a user using the CLI directly and confusing themselves about whether their Buy Yes will fail.",
    mitigation:
      "frontend disables Buy Yes when the wallet holds No (and vice versa); the portfolio page labels pending sells.",
  },
  {
    title: "Devnet-only for v1",
    whyAccept:
      "PRD requires devnet for the pass; constitution forbids mainnet for v1 to keep the project scoped.",
    whenBites:
      "devnet liquidity is whatever the test wallets put in, and devnet RPC can be flaky.",
    mitigation:
      "the mainnet path is a documented bonus that ships as a separate review with its own audit pass.",
  },
  {
    title: "Expiry gate is UX-only (not on-chain)",
    whyAccept:
      "expiry enforcement was deferred to keep the v1 program surface area small; the UI gate covers >99% of real users.",
    whenBites:
      "a determined wallet bypasses the UI and submits place_order at 16:01 ET; the order would still be accepted by the program (then immediately settled out of the book at 16:05).",
    mitigation:
      "add an expiry check to place_order / mint_pair / buy_no / sell_no in the Anchor program; tracked in tasks.md. Until then, the trade page banner names the limitation in plain English so a reader is not misled.",
  },
];

function TradeoffsSection() {
  return (
    <section id="tradeoffs" className="mb-16">
      <h2 className="mb-2 text-3xl font-bold">Trade-offs</h2>
      <p className="mb-6 text-muted">
        Each one is &quot;we accept X, knowing Y, mitigated by Z.&quot; The fifth panel was added
        when an investigation surfaced that the v1 expiry gate is UX-only.
      </p>
      <div className="grid grid-cols-1 gap-6 lg:grid-cols-2">
        {TRADEOFFS.map((t) => (
          <div key={t.title} className="rounded-2xl border border-panel bg-panel/40 p-6">
            <h3 className="mb-2 font-semibold">{t.title}</h3>
            <p className="text-sm text-muted">
              <span className="font-semibold text-yes">Why we accept it: </span>
              {t.whyAccept}{" "}
              <span className="font-semibold text-no">When it would bite: </span>
              {t.whenBites}{" "}
              <span className="rounded bg-accent/15 px-1.5 text-accent">Mitigation:</span>{" "}
              {t.mitigation}
            </p>
          </div>
        ))}
      </div>
    </section>
  );
}

// ===========================================================================
// 8 — Invariant (the conservation law that secures everything).
// ===========================================================================

function InvariantSection() {
  return (
    <section id="invariant" className="mb-16">
      <h2 className="mb-2 text-3xl font-bold">The invariant that secures everything</h2>
      <div className="rounded-2xl border border-panel bg-panel/40 p-6 font-mono text-sm">
        <p>
          <span className="text-accent">vault_balance(market)</span> =={" "}
          <span className="text-accent">total_pairs_outstanding(market)</span> ×{" "}
          <span className="text-yes">$1.00</span>
        </p>
        <p className="mt-2 font-sans text-muted">
          For every market, at every block, the USDC in the vault equals the number of Yes/No
          pairs outstanding times $1.00 — never more, never less. mint_pair adds $1 in and 1 pair
          to circulation. redeem burns 1 winning token and pays out $1. The order book moves
          tokens between users but never touches the vault. There is no possible state where the
          program owes more than it has. You can verify this live on{" "}
          <Link className="text-accent underline" href="/audit">
            the Audit page
          </Link>
          .
        </p>
      </div>
    </section>
  );
}

// ===========================================================================
// 9 — Decentralization tracking.
// ===========================================================================

function DecentralizationSection() {
  return (
    <section id="decentralization" className="mb-16">
      <h2 className="mb-2 text-3xl font-bold">Decentralization tracking</h2>
      <p className="mb-6 max-w-3xl text-muted">
        Where Meridian is fully decentralized and where v1 still has a centralized operator. The
        operator-required pieces are not custodial — they cannot touch user funds — but they are
        single points of operational failure that a v2 would replicate.
      </p>
      <div className="overflow-x-auto rounded-2xl border border-panel bg-panel/40">
        <table className="w-full text-sm">
          <thead className="text-left text-xs uppercase tracking-wider text-muted">
            <tr>
              <th className="px-4 py-3">Property</th>
              <th className="px-4 py-3">Status</th>
            </tr>
          </thead>
          <tbody>
            <DecRow label="Non-custodial (user holds keys)" pass />
            <DecRow label="Settlement reads on-chain oracle (no trusted off-chain price)" pass />
            <DecRow label="Open source" pass />
            <DecRow label="Permissionless settle_market, place_order, mint_pair, redeem" pass />
            <DecRow label="create_strike_market admin-only (operational, not custodial)" warn />
            <DecRow label="Automation cron centrally operated (anyone can replicate)" warn />
          </tbody>
        </table>
      </div>
    </section>
  );
}

function DecRow({ label, pass, warn }: { label: string; pass?: boolean; warn?: boolean }) {
  return (
    <tr className="border-t border-panel/50">
      <td className="px-4 py-3">{label}</td>
      <td className="px-4 py-3">
        {pass && <span className="text-yes">✓ on-chain</span>}
        {warn && <span className="text-yellow-400">⚠ operational</span>}
      </td>
    </tr>
  );
}

// ===========================================================================
// 10 — Tech stack grid.
// ===========================================================================

interface StackItem {
  name: string;
  icon: string;
  iconColor: string;
}

const STACK: StackItem[] = [
  { name: "Rust", icon: "rust", iconColor: "c1763a" },
  { name: "Anchor 0.31.1", icon: "anchor", iconColor: "512BD4" },
  { name: "Solana", icon: "solana", iconColor: "9945FF" },
  { name: "TypeScript", icon: "typescript", iconColor: "3178c6" },
  { name: "Next.js 14", icon: "nextdotjs", iconColor: "ffffff" },
  { name: "React 18", icon: "react", iconColor: "61dafb" },
  { name: "Tailwind", icon: "tailwindcss", iconColor: "06b6d4" },
  { name: "TanStack Query", icon: "reactquery", iconColor: "ff4154" },
  { name: "Node 20", icon: "nodedotjs", iconColor: "339933" },
  { name: "Pyth Network", icon: "pyth", iconColor: "4ec9b0" },
  { name: "pnpm", icon: "pnpm", iconColor: "F69220" },
  { name: "vitest", icon: "vitest", iconColor: "729b1b" },
  { name: "Render", icon: "render", iconColor: "46e3b7" },
  { name: "GitHub", icon: "github", iconColor: "ffffff" },
  { name: "GitLab", icon: "gitlab", iconColor: "fc6d26" },
];

function StackSection() {
  return (
    <section id="stack" className="mb-16">
      <h2 className="mb-2 text-3xl font-bold">Stack</h2>
      <p className="mb-6 text-muted">Every dependency is justified in plan.md §4.</p>
      <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-5">
        {STACK.map((s) => (
          <div
            key={s.name}
            className="flex items-center gap-2 rounded-lg border border-panel bg-panel/40 px-3 py-2"
          >
            {/* Inline data URL — see lib/techIcons.ts. */}
            <img src={techIconUrl(s.icon)} width={20} height={20} alt="" />
            <span className="text-sm">{s.name}</span>
          </div>
        ))}
      </div>
    </section>
  );
}

// ===========================================================================
// 11 — Glossary.
// ===========================================================================

interface GlossaryEntry {
  term: string;
  definition: string;
}

const GLOSSARY: GlossaryEntry[] = [
  {
    term: "Admin override",
    definition:
      "A fallback settlement path. If Pyth's oracle has been broken for over an hour past market close, the admin can call admin_settle with a manual closing price. Time-locked so it can't preempt the automatic path; the override flag is recorded on the Market account.",
  },
  {
    term: "Anchor",
    definition:
      "A Rust framework for writing Solana smart contracts. Meridian's program is written in Anchor. The frontend talks to it via an Interface Definition Language (IDL) file that describes every instruction and account.",
  },
  {
    term: "Ask",
    definition:
      "An offer to sell Yes tokens at a specific price. Sits on the order book until a Bid crosses it.",
  },
  {
    term: "Atomic transaction",
    definition:
      "One Solana transaction that does multiple things and either all of them succeed or none of them do. Buy No is atomic: mint a pair, sell the Yes, keep the No — all in one signature. No half-states.",
  },
  {
    term: "Bid",
    definition:
      "An offer to buy Yes tokens at a specific price. Sits on the order book until an Ask crosses it.",
  },
  {
    term: "Binary outcome contract",
    definition:
      "A bet that pays exactly $1 if a condition is true at a specific time, and exactly $0 if false. Meridian's whole product. Also called a binary option in traditional finance.",
  },
  {
    term: "Cancel order",
    definition:
      "Removes a resting Bid or Ask from the order book and returns the escrowed USDC or Yes tokens to your wallet. Available from the Trade page and the Portfolio's Open Orders section.",
  },
  {
    term: "CLOB (Central Limit Order Book)",
    definition:
      "An order book that matches buy and sell orders by price priority, with explicit Bids and Asks. Meridian's order book is a CLOB stored on-chain. Contrasts with an AMM where a curve provides liquidity.",
  },
  {
    term: "Custody",
    definition:
      "Who holds the money. Meridian is non-custodial — your USDC is in your wallet or in a program-owned vault that only the program logic can move. Meridian's operators cannot touch user funds.",
  },
  {
    term: "Devnet",
    definition:
      "Solana's developer test network. Tokens have no real-world value. Meridian's v1 runs entirely on devnet. Mainnet deployment is not in v1 scope.",
  },
  {
    term: "Expiry",
    definition:
      "The Unix timestamp when a market stops accepting new trades. Always 16:00 ET (21:00 UTC) on the trading day a market was created. Enforced client-side in v1; the on-chain enforcement is tracked in tasks.md.",
  },
  {
    term: "Faucet",
    definition:
      "A free source of test tokens. The Solana faucet hands out devnet SOL for transaction fees. The Circle faucet hands out devnet USDC for trading.",
  },
  {
    term: "Hermes",
    definition:
      "Pyth Network's HTTPS API for fetching the latest price update from off-chain. Used by the automation service for previous-close lookup and by the trade page for the live ticker that refreshes every 5 seconds. Completely separate from the on-chain PriceUpdateV2 path used at settlement.",
  },
  {
    term: "Match orders",
    definition:
      "The on-chain function that crosses overlapping Bids and Asks into fills. Anyone can call it — running match_orders for someone else's order book is permissionless cranking.",
  },
  {
    term: "Mint pair",
    definition:
      "Deposit $1 USDC, receive 1 Yes token + 1 No token. This is the only way tokens come into existence. The opposite of redeem.",
  },
  {
    term: "Non-custodial",
    definition:
      "You hold your own keys. Nobody else can move your money. Meridian satisfies this — every trade requires your wallet to sign.",
  },
  {
    term: "Oracle",
    definition:
      "A trusted source of off-chain data that smart contracts can read. Meridian uses Pyth, a decentralized oracle network, to get MAG7 closing prices on-chain at settlement time.",
  },
  {
    term: "Order book",
    definition:
      "The list of all resting Bids and Asks on a market, stored as an on-chain account. The Trade page shows the top 10 of each side.",
  },
  {
    term: "PDA (Program Derived Address)",
    definition:
      "A Solana account whose address is mathematically derived from a program ID plus a seed. The Meridian program owns several PDAs per market: the market account, the vault authority, the Yes mint, the No mint, the order book, and the book authority.",
  },
  {
    term: "PriceUpdateV2",
    definition:
      "The Pyth on-chain account format that holds a verified price + publish_time + confidence interval. The cranker posts a fresh PriceUpdateV2 just before calling settle_market; the program reads it and validates the feed_id, staleness, and confidence against the program Config.",
  },
  {
    term: "Pyth",
    definition:
      "The decentralized oracle network Meridian reads stock prices from. Specifically, the Pyth on-chain receiver (pyth-solana-receiver-sdk) validates a price update inside a Solana transaction so the settle_market instruction can trust it.",
  },
  {
    term: "Redeem",
    definition:
      "After a market settles, burn your winning tokens for $1 USDC each. Or burn losing tokens for $0 (reclaims the small SPL rent fee). Available indefinitely — you can come back weeks later and still redeem.",
  },
  {
    term: "SOL",
    definition:
      "Solana's native cryptocurrency. You pay tiny amounts of SOL for transaction fees (a few thousandths of a cent per tx). You need a small SOL balance to do anything on Solana.",
  },
  {
    term: "Solana",
    definition:
      "The blockchain Meridian runs on. Fast, cheap transactions; sub-second finality; high throughput. The whole protocol lives on Solana devnet for v1.",
  },
  {
    term: "SPL token",
    definition:
      "Solana's standard fungible-token format (like ERC-20 on Ethereum). Yes tokens and No tokens are SPL tokens with 0 decimals — you can hold whole tokens but not fractions. USDC is also an SPL token (with 6 decimals).",
  },
  {
    term: "Strike",
    definition:
      "The price threshold a market resolves against. NVDA > $250 means the Yes side wins if NVDA closes at or above $250 at 16:00 ET.",
  },
  {
    term: "Settle / Settlement",
    definition:
      "The moment a market's outcome is decided. Happens automatically at 16:05 ET via the Pyth oracle, with a 60-minute admin fallback if Pyth fails.",
  },
  {
    term: "Tick",
    definition:
      "The smallest price increment on the order book. 1 tick = $0.01. Limit prices are between 1 and 99 ticks ($0.01 to $0.99).",
  },
  {
    term: "USDC",
    definition:
      "A stablecoin pegged to the US dollar. Issued by Circle. Meridian uses devnet USDC for v1; mainnet USDC would work identically on a mainnet deployment.",
  },
  {
    term: "Vault",
    definition:
      "The USDC reserve that backs every Yes/No pair in circulation. Owned by a program-derived address — nobody can withdraw except through program logic (mint_pair adds, redeem removes).",
  },
  {
    term: "Wallet",
    definition:
      "A browser extension or app that holds your Solana private keys and signs transactions. Meridian works with Phantom, Solflare, Coinbase Wallet, and any wallet that implements the Solana Wallet Standard (Backpack, Glow, etc.).",
  },
];

function GlossarySection() {
  const sorted = [...GLOSSARY].sort((a, b) => a.term.localeCompare(b.term));
  return (
    <section id="glossary" className="mb-16">
      <h2 className="mb-2 text-3xl font-bold">Glossary</h2>
      <p className="mb-8 text-muted">Every piece of jargon used in this app, defined in one sentence each.</p>
      <dl className="space-y-4">
        {sorted.map((g) => (
          <div key={g.term} className="rounded-lg border border-panel bg-panel/30 p-4">
            <dt className="font-semibold text-accent">{g.term}</dt>
            <dd className="mt-1 text-sm text-muted">{g.definition}</dd>
          </div>
        ))}
      </dl>
    </section>
  );
}
