// Pure helpers that translate raw market + clock state into copy the UI can
// render without re-deriving the rules in three places. The trade page, the
// markets list, and any future status widget all want the SAME answer to
// "is this market currently trading?", "did the session already close?",
// "when does the next one open?". Centralizing keeps those answers in sync.
//
// Why a module of its own: a previous Vouch depth-2 run flagged that the
// markets page collapsed three real states ("open", "awaiting settlement",
// "settled") into one "live" pill, then dumped the user onto a "Trading
// closed" banner inside the trade page. The fix was a state machine; this
// file is that machine.

import type { MarketView } from "@/hooks/useMarkets";

/**
 * The four user-visible states of a single market. Mapped from the on-chain
 * `Market.outcome.state` (which is only Pending / YesWins / NoWins) PLUS the
 * client's clock. There is no on-chain "Expired" state because the program
 * itself doesn't currently honour expiry on `place_order` / `mint_pair`
 * (the gate is UX-only — see `app/src/app/architecture/page.tsx` Step 3).
 */
export type MarketUiState = "open" | "awaiting-settle" | "won-yes" | "won-no";

/** Whether the user can currently click into a market and place a bet. */
export function isTradeable(state: MarketUiState): boolean {
  return state === "open";
}

export function marketUiState(m: MarketView, nowMs: number = Date.now()): MarketUiState {
  if (m.outcome === "YesWins") return "won-yes";
  if (m.outcome === "NoWins") return "won-no";
  // outcome === "Pending"
  return m.expiryUnix * 1000 > nowMs ? "open" : "awaiting-settle";
}

export function marketUiStateLabel(state: MarketUiState): string {
  switch (state) {
    case "open":
      return "live";
    case "awaiting-settle":
      return "awaiting settle";
    case "won-yes":
      return "Yes won";
    case "won-no":
      return "No won";
  }
}

/** Tailwind classes for the per-state pill on the markets list. */
export function marketUiStatePillClasses(state: MarketUiState): string {
  const base = "inline-block rounded-full border px-2 py-0.5 text-[10px] font-sans uppercase tracking-wider";
  switch (state) {
    case "open":
      return `${base} border-yes/40 bg-yes/10 text-yes`;
    case "awaiting-settle":
      return `${base} border-accent/40 bg-accent/10 text-accent`;
    case "won-yes":
      return `${base} border-yes/40 bg-yes/10 text-yes`;
    case "won-no":
      return `${base} border-no/40 bg-no/10 text-no`;
  }
}

/**
 * Trading-session phase derived purely from the wall clock in New York.
 *
 * - `before-open`: it is a US trading day but the time is earlier than the
 *   user-facing 09:00 ET trading window opens.
 * - `open`: it is a US trading day and we are inside the 09:00-16:00 ET
 *   trading window. (16:00 ET is the moment markets expire.)
 * - `after-close`: it is a US trading day and the time is past 16:00 ET.
 * - `weekend`: today is Saturday or Sunday.
 *
 * Note we do NOT consult a holiday calendar here. The automation service's
 * `calendar.ts` is the authority on which days have markets created; the
 * markets list will reveal a holiday by simply having zero markets, and the
 * banner copy below is correct in either case.
 */
export type SessionPhase = "before-open" | "open" | "after-close" | "weekend";

interface NyTimeParts {
  hour: number;
  minute: number;
  weekday: number; // 0=Sun .. 6=Sat
}

function nyParts(nowMs: number = Date.now()): NyTimeParts {
  const fmt = new Intl.DateTimeFormat("en-US", {
    timeZone: "America/New_York",
    weekday: "short",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  });
  const parts = Object.fromEntries(
    fmt.formatToParts(new Date(nowMs)).map((p) => [p.type, p.value]),
  ) as { weekday?: string; hour?: string; minute?: string };
  const weekdayMap: Record<string, number> = {
    Sun: 0,
    Mon: 1,
    Tue: 2,
    Wed: 3,
    Thu: 4,
    Fri: 5,
    Sat: 6,
  };
  const weekday = weekdayMap[parts.weekday ?? "Mon"] ?? 1;
  const hour = Number(parts.hour ?? "0");
  // Intl returns "24" at midnight in some Node versions; normalize.
  const safeHour = hour === 24 ? 0 : hour;
  const minute = Number(parts.minute ?? "0");
  return { hour: safeHour, minute, weekday };
}

export function sessionPhase(nowMs: number = Date.now()): SessionPhase {
  const { hour, minute, weekday } = nyParts(nowMs);
  if (weekday === 0 || weekday === 6) return "weekend";
  const totalMinutes = hour * 60 + minute;
  // 9:00 ET = 540, 16:00 ET = 960. The morning cron at 08:00 ET creates the
  // day's markets; we treat 09:00 ET as the user-facing "open" so a card
  // shown at 08:30 has at least 30 minutes of warmup before it accepts bets.
  if (totalMinutes < 540) return "before-open";
  if (totalMinutes >= 960) return "after-close";
  return "open";
}

/** Copy for the top-of-page banner on the markets list, keyed by phase. */
export function sessionPhaseBannerCopy(phase: SessionPhase): {
  title: string;
  body: string;
  tone: "neutral" | "warn";
} | null {
  switch (phase) {
    case "open":
      return null; // no banner needed mid-session
    case "before-open":
      return {
        title: "Markets open at 09:00 ET",
        body:
          "Today's strike markets are created by the admin cron at 08:00 ET and become tradeable at 09:00 ET. " +
          "All markets settle on the underlying stock's 16:00 ET closing price via Pyth.",
        tone: "neutral",
      };
    case "after-close":
      return {
        title: "Trading closed for today",
        body:
          "All of today's markets are past their 16:00 ET expiry and are awaiting settlement (the settle cron " +
          "runs at 16:05 ET; admin_settle can be triggered after 60 minutes if Pyth is stale). New strike markets " +
          "are created tomorrow at 08:00 ET and become tradeable at 09:00 ET.",
        tone: "warn",
      };
    case "weekend":
      return {
        title: "NYSE is closed",
        body:
          "Meridian only creates markets on US trading days. New strike markets resume Monday at 08:00 ET (or the next trading day if Monday is a holiday).",
        tone: "warn",
      };
  }
}
