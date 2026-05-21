"use client";

// Audit page — every piece of state the program owns, visible.
// Built so a reviewer (or the user) can sanity-check every part of the
// system without leaving the browser.

import { useMarkets } from "@/hooks/useMarkets";
import { useConfig } from "@/hooks/useConfig";
import { usePythLive } from "@/hooks/usePythLive";
import { useProgramTxs, useVaultSum } from "@/hooks/useProgramTxs";
import { useAutomationHealth } from "@/hooks/useAutomationHealth";
import { formatUsdc, usdcFromBase } from "@/lib/usdc";
import { cluster } from "@/lib/cluster";

export const dynamic = "force-dynamic";

const explorer = (kind: "address" | "tx", id: string) =>
  `https://explorer.solana.com/${kind}/${id}?cluster=${cluster.name === "mainnet" ? "" : cluster.name}`;

function Mono({ children }: { children: React.ReactNode }) {
  return <span className="font-mono text-xs">{children}</span>;
}

function Pill({ tone, children }: { tone: "ok" | "warn" | "bad" | "info"; children: React.ReactNode }) {
  const cls =
    tone === "ok"
      ? "bg-yes/20 text-yes"
      : tone === "bad"
        ? "bg-no/20 text-no"
        : tone === "warn"
          ? "bg-yellow-500/20 text-yellow-300"
          : "bg-accent/20 text-accent";
  return <span className={`rounded-full px-2 py-0.5 text-xs font-medium ${cls}`}>{children}</span>;
}

function shortPubkey(s: string) {
  return s.length > 12 ? `${s.slice(0, 6)}…${s.slice(-4)}` : s;
}

function relTime(unix: number | null | undefined): string {
  if (!unix) return "never";
  const now = Math.floor(Date.now() / 1000);
  const diff = now - unix;
  if (diff < 60) return `${diff}s ago`;
  if (diff < 3600) return `${Math.floor(diff / 60)}m ago`;
  if (diff < 86400) return `${Math.floor(diff / 3600)}h ago`;
  return `${Math.floor(diff / 86400)}d ago`;
}

export default function AuditPage() {
  const config = useConfig();
  const markets = useMarkets();
  const pyth = usePythLive();
  const txs = useProgramTxs(25);
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const vaults = (markets.data ?? []).map((m: any) => m.vault);
  const vaultSum = useVaultSum(vaults);
  const automation = useAutomationHealth();

  return (
    <main className="mx-auto max-w-6xl px-6 py-10">
      <header className="mb-8">
        <h1 className="text-3xl font-bold">Audit</h1>
        <p className="mt-2 text-sm text-muted">
          Real-time on-chain + automation state for the Meridian program. Refreshes every 5–15s.
          Every value is verifiable on the linked Solana Explorer.
        </p>
      </header>

      {/* === CONFIG === */}
      <section className="mb-10">
        <h2 className="mb-3 text-xl font-semibold">Program config</h2>
        <div className="rounded-2xl border border-panel bg-panel/40 p-5 text-sm">
          {config.isLoading && <p className="text-muted">Loading...</p>}
          {config.data && (
            <dl className="grid grid-cols-1 gap-y-2 sm:grid-cols-2">
              <dt className="text-muted">Config PDA</dt>
              <dd>
                <a className="text-accent" href={explorer("address", config.data.pda)} target="_blank" rel="noreferrer">
                  <Mono>{config.data.pda}</Mono>
                </a>
              </dd>
              <dt className="text-muted">Admin</dt>
              <dd>
                <a className="text-accent" href={explorer("address", config.data.admin)} target="_blank" rel="noreferrer">
                  <Mono>{config.data.admin}</Mono>
                </a>
              </dd>
              <dt className="text-muted">USDC mint</dt>
              <dd>
                <a className="text-accent" href={explorer("address", config.data.usdcMint)} target="_blank" rel="noreferrer">
                  <Mono>{config.data.usdcMint}</Mono>
                </a>
              </dd>
              <dt className="text-muted">Pyth max staleness</dt>
              <dd>{config.data.maxStalenessSecs}s</dd>
              <dt className="text-muted">Pyth max confidence</dt>
              <dd>{config.data.maxConfidenceBps} bps ({(config.data.maxConfidenceBps / 100).toFixed(2)}%)</dd>
              <dt className="text-muted">Admin override delay</dt>
              <dd>{config.data.adminOverrideDelaySecs}s ({(config.data.adminOverrideDelaySecs / 60).toFixed(0)} min)</dd>
              <dt className="text-muted">Paused</dt>
              <dd>{config.data.paused ? <Pill tone="bad">PAUSED</Pill> : <Pill tone="ok">running</Pill>}</dd>
              <dt className="text-muted">Program version</dt>
              <dd>v{config.data.version}</dd>
            </dl>
          )}
        </div>
      </section>

      {/* === VAULT INVARIANT === */}
      <section className="mb-10">
        <h2 className="mb-3 text-xl font-semibold">
          Vault invariant{" "}
          <span className="text-sm font-normal text-muted">(sum of every market's vault USDC)</span>
        </h2>
        <div className="rounded-2xl border border-panel bg-panel/40 p-5 text-sm">
          {vaultSum.data && (
            <>
              <p className="mb-3">
                Total USDC held across {vaultSum.data.perVault.length} market vaults:{" "}
                <span className="font-mono">{formatUsdc(usdcFromBase(vaultSum.data.total))}</span>
              </p>
              <p className="text-xs text-muted">
                Invariant: this MUST equal{" "}
                <span className="font-mono">$1.00 × total_pairs_outstanding</span> for every market.
                Drill into a market on /markets to see its individual vault, Yes supply, No supply.
              </p>
              {vaultSum.data.perVault.length > 0 && (
                <details className="mt-4">
                  <summary className="cursor-pointer text-muted">per-vault breakdown</summary>
                  <table className="mt-2 w-full text-xs">
                    <thead className="text-left text-muted">
                      <tr>
                        <th className="pb-1">Vault</th>
                        <th className="pb-1 text-right">Balance</th>
                      </tr>
                    </thead>
                    <tbody className="font-mono">
                      {vaultSum.data.perVault.map((v) => (
                        <tr key={v.vaultPubkey} className="border-t border-panel/50">
                          <td className="py-1">
                            <a className="text-accent" href={explorer("address", v.vaultPubkey)} target="_blank" rel="noreferrer">
                              {shortPubkey(v.vaultPubkey)}
                            </a>
                          </td>
                          <td className="py-1 text-right">{formatUsdc(usdcFromBase(v.usdcMicros))}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </details>
              )}
            </>
          )}
        </div>
      </section>

      {/* === MARKETS === */}
      <section className="mb-10">
        <h2 className="mb-3 text-xl font-semibold">
          Markets <span className="text-sm font-normal text-muted">({markets.data?.length ?? 0} on chain)</span>
        </h2>
        <div className="rounded-2xl border border-panel bg-panel/40 p-5 text-sm">
          {markets.data && markets.data.length === 0 && (
            <p className="text-muted">
              No markets yet. Run the morning cron (or call <code className="rounded bg-bg/50 px-1">create_strike_market</code>) to spawn markets.
            </p>
          )}
          {markets.data && markets.data.length > 0 && (
            <table className="w-full text-xs">
              <thead className="text-left text-muted">
                <tr>
                  <th className="pb-2">Ticker</th>
                  <th className="pb-2">Strike</th>
                  <th className="pb-2">Day</th>
                  <th className="pb-2">Expiry</th>
                  <th className="pb-2">Outcome</th>
                  <th className="pb-2">Market PDA</th>
                </tr>
              </thead>
              <tbody className="font-mono">
                {markets.data.map((m) => (
                  <tr key={m.pubkey} className="border-t border-panel/50">
                    <td className="py-1">{m.ticker}</td>
                    <td className="py-1">{formatUsdc(m.strikeUsd)}</td>
                    <td className="py-1">{new Date(m.tradingDayUnix * 1000).toISOString().slice(0, 10)}</td>
                    <td className="py-1">{new Date(m.expiryUnix * 1000).toISOString().slice(11, 16)} UTC</td>
                    <td className="py-1">
                      {m.outcome === "Pending" ? (
                        <Pill tone="info">pending</Pill>
                      ) : m.outcome === "YesWins" ? (
                        <Pill tone="ok">Yes {m.adminOverride ? "(admin)" : ""}</Pill>
                      ) : (
                        <Pill tone="bad">No {m.adminOverride ? "(admin)" : ""}</Pill>
                      )}
                    </td>
                    <td className="py-1">
                      <a className="text-accent" href={explorer("address", m.pubkey)} target="_blank" rel="noreferrer">
                        {shortPubkey(m.pubkey)}
                      </a>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </div>
      </section>

      {/* === PYTH FEEDS === */}
      <section className="mb-10">
        <h2 className="mb-3 text-xl font-semibold">
          Pyth oracle feeds (Hermes) <span className="text-sm font-normal text-muted">refreshes every 5s</span>
        </h2>
        <div className="rounded-2xl border border-panel bg-panel/40 p-5 text-sm">
          {pyth.error && <p className="text-no">Hermes error: {(pyth.error as Error).message}</p>}
          {pyth.data && (
            <table className="w-full text-xs">
              <thead className="text-left text-muted">
                <tr>
                  <th className="pb-2">Ticker</th>
                  <th className="pb-2 text-right">Price</th>
                  <th className="pb-2 text-right">Confidence (bps)</th>
                  <th className="pb-2 text-right">Age</th>
                  <th className="pb-2">Settle-eligible?</th>
                  <th className="pb-2">Feed ID</th>
                </tr>
              </thead>
              <tbody className="font-mono">
                {pyth.data.map((p) => {
                  const stale = p.ageSecs > (config.data?.maxStalenessSecs ?? 300);
                  const wide = p.confBps > (config.data?.maxConfidenceBps ?? 50);
                  return (
                    <tr key={p.ticker} className="border-t border-panel/50">
                      <td className="py-1">{p.ticker}</td>
                      <td className="py-1 text-right">${p.price.toFixed(2)}</td>
                      <td className="py-1 text-right">
                        {wide ? <Pill tone="bad">{p.confBps}</Pill> : p.confBps}
                      </td>
                      <td className="py-1 text-right">
                        {stale ? <Pill tone="bad">{p.ageSecs}s</Pill> : `${p.ageSecs}s`}
                      </td>
                      <td className="py-1">
                        {!stale && !wide ? (
                          <Pill tone="ok">yes</Pill>
                        ) : (
                          <Pill tone="bad">no — {stale ? "stale" : "wide conf"}</Pill>
                        )}
                      </td>
                      <td className="py-1 text-muted">{p.feedId.slice(0, 10)}…</td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          )}
        </div>
      </section>

      {/* === AUTOMATION === */}
      <section className="mb-10">
        <h2 className="mb-3 text-xl font-semibold">Automation service</h2>
        <div className="rounded-2xl border border-panel bg-panel/40 p-5 text-sm">
          {automation.data && "error" in automation.data && (
            <p className="text-no">automation /health unreachable: {automation.data.error}</p>
          )}
          {automation.data && !("error" in automation.data) && (
            <dl className="grid grid-cols-1 gap-y-2 sm:grid-cols-2">
              <dt className="text-muted">Status</dt>
              <dd>
                <Pill tone="ok">{automation.data.status}</Pill>
              </dd>
              <dt className="text-muted">Cluster</dt>
              <dd>{automation.data.cluster}</dd>
              <dt className="text-muted">Started at</dt>
              <dd>{new Date(automation.data.startedAt).toLocaleString()}</dd>
              <dt className="text-muted">Service time</dt>
              <dd>{new Date(automation.data.now).toLocaleString()}</dd>
              <dt className="text-muted">Last morning run</dt>
              <dd>{automation.data.lastMorningRun ? JSON.stringify(automation.data.lastMorningRun) : <span className="text-muted">never</span>}</dd>
              <dt className="text-muted">Last settlement run</dt>
              <dd>{automation.data.lastSettlementRun ? JSON.stringify(automation.data.lastSettlementRun) : <span className="text-muted">never</span>}</dd>
              <dt className="text-muted">Morning cron next</dt>
              <dd>{automation.data.morningNext ? new Date(automation.data.morningNext).toLocaleString() : "—"}</dd>
              <dt className="text-muted">Settlement cron next</dt>
              <dd>{automation.data.settlementNext ? new Date(automation.data.settlementNext).toLocaleString() : "—"}</dd>
            </dl>
          )}
        </div>
      </section>

      {/* === RECENT TXS === */}
      <section className="mb-10">
        <h2 className="mb-3 text-xl font-semibold">
          Recent program transactions{" "}
          <span className="text-sm font-normal text-muted">last 25 sigs touching the program</span>
        </h2>
        <div className="rounded-2xl border border-panel bg-panel/40 p-5 text-sm">
          {txs.data && txs.data.length === 0 && <p className="text-muted">No transactions yet.</p>}
          {txs.data && txs.data.length > 0 && (
            <table className="w-full text-xs">
              <thead className="text-left text-muted">
                <tr>
                  <th className="pb-2">When</th>
                  <th className="pb-2">Slot</th>
                  <th className="pb-2">Outcome</th>
                  <th className="pb-2">Signature</th>
                </tr>
              </thead>
              <tbody className="font-mono">
                {txs.data.map((t) => (
                  <tr key={t.signature} className="border-t border-panel/50">
                    <td className="py-1">{relTime(t.blockTime)}</td>
                    <td className="py-1">{t.slot}</td>
                    <td className="py-1">
                      {t.err === null ? <Pill tone="ok">success</Pill> : <Pill tone="bad">err</Pill>}
                    </td>
                    <td className="py-1">
                      <a className="text-accent" href={explorer("tx", t.signature)} target="_blank" rel="noreferrer">
                        {t.signature.slice(0, 10)}…{t.signature.slice(-6)}
                      </a>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </div>
      </section>

      {/* === LINKS === */}
      <section className="mb-10">
        <h2 className="mb-3 text-xl font-semibold">Out-of-app verification</h2>
        <div className="rounded-2xl border border-panel bg-panel/40 p-5 text-sm">
          <ul className="space-y-2">
            <li>
              Program on Solana Explorer:{" "}
              <a className="text-accent" href={explorer("address", cluster.programId)} target="_blank" rel="noreferrer">
                <Mono>{cluster.programId}</Mono>
              </a>
            </li>
            <li>
              GitHub:{" "}
              <a className="text-accent" href="https://github.com/scott-lydon/meridian" target="_blank" rel="noreferrer">
                scott-lydon/meridian
              </a>
            </li>
            <li>
              GitLab:{" "}
              <a className="text-accent" href="https://labs.gauntletai.com/scottlydon/meridian" target="_blank" rel="noreferrer">
                labs.gauntletai.com/scottlydon/meridian
              </a>
            </li>
            <li>
              Automation /health (raw JSON):{" "}
              <a className="text-accent" href="https://meridian-automation.onrender.com/health" target="_blank" rel="noreferrer">
                meridian-automation.onrender.com/health
              </a>
            </li>
            <li>
              Pyth Hermes API for MAG7:{" "}
              <a className="text-accent" href="https://hermes.pyth.network/v2/price_feeds?asset_type=equity" target="_blank" rel="noreferrer">
                hermes.pyth.network
              </a>
            </li>
          </ul>
        </div>
      </section>
    </main>
  );
}
