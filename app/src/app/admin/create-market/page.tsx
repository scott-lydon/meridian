"use client";

// /admin/create-market — admin-only page that creates a fresh on-chain
// market at any wall-clock moment with a chosen ticker, strike, and
// expiry. The complement to the 08:00 ET morning cron, which creates the
// standard daily ladder of strikes once per trading day.
//
// Use case: at, say, Sunday 17:31, the admin wants a market to test
// against. The market closed Friday at 4 PM ET so the morning cron
// has not run since. The admin opens this page, picks "AAPL above $309
// expiring in 2 minutes," and the expiry-sweep cron auto-settles it at
// 17:33:30 using the last Hermes price. The whole test loop runs
// without leaving the browser, regardless of day of week or time of day.
//
// Gated behind /admin sign-in (lib/adminMode.ts). The localStorage flag
// is not a security boundary; the underlying HTTP endpoint requires an
// x-admin-secret header that matches ADMIN_API_SECRET on the server.
// See lib/automationApi.ts for the wire-format details.

import { useEffect, useMemo, useState, type FormEvent } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";

import { useAdminMode } from "@/lib/adminMode";
import {
  AutomationApiError,
  postCreateMarket,
  type CreateMarketResult,
} from "@/lib/automationApi";

// Magnificent 7 — same set the morning cron + .env.example use. Kept in
// sync manually for now; if Meridian ever supports more tickers we
// surface them through an endpoint, not a literal here.
const MAG7_TICKERS = ["AAPL", "MSFT", "GOOGL", "AMZN", "NVDA", "META", "TSLA"] as const;
type Mag7Ticker = (typeof MAG7_TICKERS)[number];

// Defaults oriented around "fast test": NVDA is the project's stock
// throughout the demo materials, 2 minutes is fast enough to feel
// interactive but slow enough that the expiry-sweep grace window
// (60 seconds) does not race the trade. Pick a strike near current spot
// and the outcome is ~50/50; pick well above or below to force the
// outcome you want for the win/loss test step.
const DEFAULT_TICKER: Mag7Ticker = "NVDA";
const DEFAULT_STRIKE = 250;
const DEFAULT_EXPIRY_MINUTES = 2;

const MIN_EXPIRY_MINUTES = 0.5; // 30 seconds, matching the server-side floor
const MAX_EXPIRY_MINUTES = 60 * 24; // 1 day cap; longer than this is fine
// for production-style markets via the morning cron, not this fast-test page.

export const dynamic = "force-dynamic";

export default function CreateCustomMarketPage() {
  const router = useRouter();
  const adminUnlocked = useAdminMode();
  // Hydration-safe: useAdminMode returns false on first render server-
  // side, then re-reads from localStorage after mount. We track a
  // separate `mounted` flag so the "you need to sign in" copy does not
  // flash for a frame before the real admin state lands.
  const [mounted, setMounted] = useState(false);
  useEffect(() => setMounted(true), []);

  const [ticker, setTicker] = useState<Mag7Ticker>(DEFAULT_TICKER);
  const [strikeUsd, setStrikeUsd] = useState<number>(DEFAULT_STRIKE);
  const [expiryMinutes, setExpiryMinutes] = useState<number>(DEFAULT_EXPIRY_MINUTES);

  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<{ slug: string; message: string } | null>(null);
  const [result, setResult] = useState<CreateMarketResult | null>(null);

  const expirySecondsFromNow = useMemo(
    () => Math.round(expiryMinutes * 60),
    [expiryMinutes],
  );

  async function submit(e: FormEvent) {
    e.preventDefault();
    setError(null);
    setResult(null);
    setSubmitting(true);
    try {
      const r = await postCreateMarket({
        ticker,
        strikeUsd,
        expirySecondsFromNow,
      });
      setResult(r);
    } catch (err) {
      if (err instanceof AutomationApiError) {
        setError({ slug: err.slug, message: err.message });
      } else {
        setError({
          slug: "client_error",
          message: err instanceof Error ? err.message : String(err),
        });
      }
    } finally {
      setSubmitting(false);
    }
  }

  // Gate the page on admin sign-in. The /admin page is the canonical
  // sign-in form; bounce there with a return-to query param. The bounce
  // happens after mount so the SSR HTML matches the un-mounted state.
  useEffect(() => {
    if (mounted && !adminUnlocked) {
      router.replace("/admin");
    }
  }, [mounted, adminUnlocked, router]);

  if (!mounted) {
    // SSR-safe placeholder; identical to the unsigned-in shell so React
    // does not flag a hydration mismatch.
    return (
      <main className="mx-auto max-w-2xl px-6 py-16">
        <h1 className="text-2xl font-bold">Loading…</h1>
      </main>
    );
  }
  if (!adminUnlocked) {
    return (
      <main className="mx-auto max-w-2xl px-6 py-16">
        <h1 className="text-2xl font-bold">Admin sign-in required</h1>
        <p className="mt-3 text-sm text-muted">
          Redirecting to <Link href="/admin" className="text-accent underline">/admin</Link>…
        </p>
      </main>
    );
  }

  return (
    <main className="mx-auto flex max-w-2xl flex-col gap-6 px-6 py-12">
      <header>
        <h1 className="text-2xl font-bold tracking-tight">Create a custom market</h1>
        <p className="mt-2 text-sm text-muted">
          Spin up a fresh on-chain market with a chosen ticker, strike, and expiry. Use this
          to test trading and settlement any time of day, on weekends, or against a strike
          that forces a chosen outcome. The expiry-sweep cron auto-settles roughly one
          minute after the expiry timestamp passes.
        </p>
      </header>

      <form
        onSubmit={submit}
        className="flex flex-col gap-4 rounded-2xl border border-panel bg-panel/40 p-6"
      >
        <label className="block text-sm">
          <span className="mb-1 block text-xs uppercase tracking-wider text-muted">
            Ticker
          </span>
          <select
            value={ticker}
            onChange={(e) => setTicker(e.target.value as Mag7Ticker)}
            className="w-full rounded-lg border border-panel bg-bg px-3 py-2 font-mono text-sm text-text focus:border-accent focus:outline-none"
          >
            {MAG7_TICKERS.map((t) => (
              <option key={t} value={t}>
                {t}
              </option>
            ))}
          </select>
        </label>

        <label className="block text-sm">
          <span className="mb-1 block text-xs uppercase tracking-wider text-muted">
            Strike price (US dollars)
          </span>
          <input
            type="number"
            inputMode="decimal"
            min="0.000001"
            step="0.01"
            value={strikeUsd}
            onChange={(e) => setStrikeUsd(Number(e.target.value))}
            className="w-full rounded-lg border border-panel bg-bg px-3 py-2 font-mono text-sm text-text focus:border-accent focus:outline-none"
            required
          />
          <span className="mt-1 block text-[11px] text-muted">
            Pick well above current spot to force NO to win, or well below to force YES to win.
            Pick near spot for a real coin-flip test.
          </span>
        </label>

        <label className="block text-sm">
          <span className="mb-1 block text-xs uppercase tracking-wider text-muted">
            Expiry (minutes from now)
          </span>
          <input
            type="number"
            inputMode="decimal"
            min={MIN_EXPIRY_MINUTES}
            max={MAX_EXPIRY_MINUTES}
            step="0.5"
            value={expiryMinutes}
            onChange={(e) => setExpiryMinutes(Number(e.target.value))}
            className="w-full rounded-lg border border-panel bg-bg px-3 py-2 font-mono text-sm text-text focus:border-accent focus:outline-none"
            required
          />
          <span className="mt-1 block text-[11px] text-muted">
            Minimum 0.5 minutes (30 seconds). After expiry, the auto-settle cron fires roughly
            one minute later. Equals {expirySecondsFromNow} seconds, or about{" "}
            {new Date(Date.now() + expirySecondsFromNow * 1000).toLocaleTimeString()} local
            time.
          </span>
        </label>

        {error && (
          <div className="rounded-lg border border-no/40 bg-no/10 p-3 text-xs">
            <div className="font-semibold text-no">Error: {error.slug}</div>
            <div className="mt-1 text-muted">{error.message}</div>
          </div>
        )}

        <button
          type="submit"
          disabled={submitting}
          className="rounded-lg bg-accent px-3 py-2 text-sm font-semibold text-white hover:bg-accentHover disabled:cursor-not-allowed disabled:opacity-60"
        >
          {submitting ? "Creating market…" : "Create market"}
        </button>
      </form>

      {result && (
        <section className="rounded-2xl border border-yes/40 bg-yes/5 p-6">
          <h2 className="text-lg font-bold text-yes">Market created</h2>
          <p className="mt-2 text-sm text-text">
            {result.marketAlreadyExisted
              ? "A market for this (today, ticker, strike) tuple already existed; reusing it."
              : "A fresh market was created on devnet."}{" "}
            {result.orderBookAlreadyInitialized
              ? "The order book was already initialized."
              : "Its order book was initialized in the same admin call."}
          </p>
          <dl className="mt-4 space-y-2 font-mono text-[12px] text-muted">
            <div>
              <dt className="inline text-text">market: </dt>
              <dd className="inline break-all">{result.market}</dd>
            </div>
            <div>
              <dt className="inline text-text">order book: </dt>
              <dd className="inline break-all">{result.orderBook}</dd>
            </div>
            <div>
              <dt className="inline text-text">expiry: </dt>
              <dd className="inline">
                {new Date(result.expiryUnix * 1000).toLocaleString()}
              </dd>
            </div>
            {result.createSig !== "(reused-existing-market)" && (
              <div>
                <dt className="inline text-text">create tx: </dt>
                <dd className="inline break-all">
                  <a
                    href={`https://explorer.solana.com/tx/${result.createSig}?cluster=devnet`}
                    target="_blank"
                    rel="noreferrer"
                    className="text-accent underline"
                  >
                    {result.createSig.slice(0, 12)}…
                  </a>
                </dd>
              </div>
            )}
            {result.initOrderBookSig && (
              <div>
                <dt className="inline text-text">init-book tx: </dt>
                <dd className="inline break-all">
                  <a
                    href={`https://explorer.solana.com/tx/${result.initOrderBookSig}?cluster=devnet`}
                    target="_blank"
                    rel="noreferrer"
                    className="text-accent underline"
                  >
                    {result.initOrderBookSig.slice(0, 12)}…
                  </a>
                </dd>
              </div>
            )}
          </dl>
          <div className="mt-4 flex gap-3">
            <Link
              href={`/trade/${ticker}/${result.market}`}
              className="rounded-lg bg-accent px-3 py-2 text-sm font-semibold text-white hover:bg-accentHover"
            >
              Open trade page →
            </Link>
            <button
              type="button"
              onClick={() => {
                setResult(null);
              }}
              className="rounded-lg border border-panel px-3 py-2 text-sm text-muted hover:bg-panel"
            >
              Create another
            </button>
          </div>
        </section>
      )}
    </main>
  );
}
