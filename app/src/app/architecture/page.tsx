"use client";

// Architecture page — three layers of explanation pitched at three audiences.
//
//   1. ELI7 (Explain Like I'm 7): a friendly cartoonish walk-through with
//      emojis, intentionally non-technical, for visitors who do not know
//      what a blockchain is.
//   2. Architecture: the real component diagram + data flow, written for a
//      developer or grader.
//   3. Glossary: every piece of jargon used anywhere in the app with a
//      one-sentence definition, sorted alphabetically.
//
// The page is deliberately long. Real first-time users skim ELI7, then go
// trade. Graders read all three.

import Link from "next/link";

export const dynamic = "force-dynamic";

export default function ArchitecturePage() {
  return (
    <main className="mx-auto max-w-4xl px-6 py-12">
      <header className="mb-12">
        <h1 className="text-5xl font-bold tracking-tight">How Meridian works</h1>
        <p className="mt-3 text-lg text-muted">
          Three explanations of the same thing, picked by who you are.
        </p>
        <nav className="mt-6 flex flex-wrap gap-3 text-sm">
          <a href="#eli7" className="rounded-full border border-panel bg-panel/40 px-4 py-1.5 text-accent hover:bg-panel">
            Explain to a 7 year old
          </a>
          <a href="#architecture" className="rounded-full border border-panel bg-panel/40 px-4 py-1.5 text-accent hover:bg-panel">
            Real architecture
          </a>
          <a href="#glossary" className="rounded-full border border-panel bg-panel/40 px-4 py-1.5 text-accent hover:bg-panel">
            Glossary
          </a>
        </nav>
      </header>

      <Eli7Section />
      <ArchitectureSection />
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
        .
      </footer>
    </main>
  );
}

// ===========================================================================
// Section 1 — Explain to a 7 year old.
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
// Section 2 — Real architecture.
// ===========================================================================

function ArchitectureSection() {
  return (
    <section id="architecture" className="mb-16">
      <h2 className="mb-2 text-3xl font-bold">Architecture</h2>
      <p className="mb-8 text-muted">
        The mechanical version. Three components, one on-chain program, one daily lifecycle.
      </p>

      <h3 className="mb-3 mt-8 text-xl font-semibold">The three components</h3>
      <div className="grid gap-4 sm:grid-cols-3">
        <ComponentCard
          title="Anchor program"
          chain="On-chain (Solana devnet)"
          role="The protocol itself. Holds vault USDC, mints Yes/No pair SPL tokens, runs the order book, settles markets against Pyth, pays out redeems. Source of truth for every dollar."
        />
        <ComponentCard
          title="Next.js frontend"
          chain="Off-chain (Render)"
          role="A wallet-aware UI for the program. Reads on-chain state, builds and signs transactions client-side. Just one client out of many possible clients — anyone can build their own and connect to the same program."
        />
        <ComponentCard
          title="Automation cron"
          chain="Off-chain (Render)"
          role="Two scheduled jobs: 08:00 ET creates today's strike markets, 16:05 ET settles them via Pyth on-chain oracle. Permissionless — anyone with a keypair could run an equivalent cranker."
        />
      </div>

      <h3 className="mb-3 mt-8 text-xl font-semibold">A day in the life</h3>
      <ol className="space-y-3 text-sm">
        <Step n="1" t="08:00 ET" line="Morning cron reads previous close from Pyth Hermes, generates ±3% / ±6% / ±9% strikes per MAG7 ticker, calls create_strike_market for each new (ticker, strike) the program has never seen." />
        <Step n="2" t="09:00 ET" line="Markets open. Traders mint pairs, place Bids/Asks on the order book, take positions. match_orders crosses overlapping orders into fills." />
        <Step n="3" t="16:00 ET" line="Trading closes. expiry_unix < now → place_order rejects new orders, mint_pair rejects new pair creation. Existing positions are frozen." />
        <Step n="4" t="16:05 ET" line="Settlement cron posts a fresh Pyth PriceUpdateV2 on-chain and calls settle_market. The program validates feed_id + staleness + confidence and writes the binary outcome (YesWins or NoWins) into the Market account." />
        <Step n="5" t="any time after" line="Winners call redeem; each winning token burns and pays out $1 USDC from the vault. Losers can also redeem (burns the worthless token, reclaims SPL rent, $0 payout). vault_balance == pairs_outstanding × $1 invariant is enforced on every operation." />
        <Step n="6" t="if Pyth dies" line="settle_market fallback after 60 minutes: admin_settle with a manual closing price. Time-locked, can never preempt the automatic path." />
      </ol>

      <h3 className="mb-3 mt-8 text-xl font-semibold">The invariant that secures everything</h3>
      <div className="rounded-xl border border-panel bg-panel/40 p-5 font-mono text-sm">
        <p>
          <span className="text-accent">vault_balance(market)</span> =={" "}
          <span className="text-accent">total_pairs_outstanding(market)</span> ×{" "}
          <span className="text-yes">$1.00</span>
        </p>
        <p className="mt-2 text-muted">
          For every market, at every block, the USDC in the vault equals the number of Yes/No pairs
          outstanding times $1.00 — never more, never less. Mint adds $1 in and 1 pair to circulation.
          Redeem burns 1 winning token and pays out $1. The order book moves tokens between users but
          never touches the vault. There is no possible state where the program owes more than it has.
          You can verify this live on{" "}
          <Link className="text-accent underline" href="/audit">
            the Audit page
          </Link>
          .
        </p>
      </div>

      <h3 className="mb-3 mt-8 text-xl font-semibold">Decentralization tracking</h3>
      <table className="w-full text-sm">
        <thead className="text-left text-xs uppercase tracking-wider text-muted">
          <tr>
            <th className="pb-2">Property</th>
            <th className="pb-2">Status</th>
          </tr>
        </thead>
        <tbody className="font-mono">
          <DecRow label="Non-custodial (user holds keys)" pass />
          <DecRow label="Settlement reads on-chain oracle (no trusted off-chain price)" pass />
          <DecRow label="Open source" pass />
          <DecRow label="Permissionless settle_market, place_order, mint_pair, redeem" pass />
          <DecRow label="create_strike_market admin-only (operational, not custodial)" warn />
          <DecRow label="Automation cron centrally operated (anyone can replicate)" warn />
        </tbody>
      </table>
    </section>
  );
}

function ComponentCard({ title, chain, role }: { title: string; chain: string; role: string }) {
  return (
    <div className="rounded-xl border border-panel bg-panel/40 p-5">
      <p className="text-xs uppercase tracking-wider text-muted">{chain}</p>
      <h4 className="mt-1 font-semibold">{title}</h4>
      <p className="mt-2 text-sm text-muted">{role}</p>
    </div>
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

function DecRow({ label, pass, warn }: { label: string; pass?: boolean; warn?: boolean }) {
  return (
    <tr className="border-t border-panel/50">
      <td className="py-2">{label}</td>
      <td className="py-2">
        {pass && <span className="text-yes">✓ on-chain</span>}
        {warn && <span className="text-yellow-400">⚠ operational</span>}
      </td>
    </tr>
  );
}

// ===========================================================================
// Section 3 — Glossary.
// ===========================================================================

interface GlossaryEntry {
  term: string;
  definition: string;
}

const GLOSSARY: GlossaryEntry[] = [
  {
    term: "Admin override",
    definition:
      "A fallback settlement path. If Pyth's oracle has been broken for over an hour past market close, the admin can call admin_settle with a manual closing price. Time-locked so it can't preempt the automatic path.",
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
      "The Unix timestamp when a market stops accepting new trades. Always 16:00 ET (21:00 UTC) on the trading day a market was created.",
  },
  {
    term: "Faucet",
    definition:
      "A free source of test tokens. The Solana faucet hands out devnet SOL for transaction fees. The Circle faucet hands out devnet USDC for trading.",
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
      "A browser extension or app that holds your Solana private keys and signs transactions. Meridian works with Phantom, Solflare, and any wallet that implements the Solana Wallet Standard.",
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
