"use client";

// After-hours testing mode — a localStorage-backed UI toggle that bypasses
// the client-side expiry / session-phase gates.
//
// Why this exists: Meridian's frontend gates trading on a wall-clock
// `isExpired` check (16:00 ET expiry) and a `sessionPhase` banner ("Trading
// closed for today"). Both are UX rules, not on-chain rules — the Anchor
// program itself does NOT enforce expiry on mint_pair / place_order / buy_no
// / sell_no / match_orders / cancel_order / redeem. It only blocks them when
// `market.outcome.is_settled()` or `config.paused`. So the program is happy
// to accept trades 24/7; the UI just hides the buttons.
//
// During development and demos, the user wants to verify the full
// mint/buy/sell/redeem loop after 4pm ET on a weekday, on weekends, or
// against past-expiry markets without standing up new infrastructure.
// Toggling this flag relaxes the UI gates to expose the actual on-chain
// behavior. Nothing about the transactions or program is mocked — only the
// client-side disable predicates flip.
//
// Safety:
//   - Default OFF. Must be explicitly enabled.
//   - Persisted in localStorage so the user doesn't accidentally toggle on
//     by URL share. Survives reload + tab restart.
//   - When ON, a persistent banner renders at the top of every page (see
//     AfterHoursBanner) so the user cannot forget the toggle is active.
//   - SSR-safe: every accessor guards `typeof window`.
//   - Custom event "meridian:afterHoursModeChanged" + cross-tab via
//     "storage" event keeps multiple components in sync without prop
//     drilling.

import { useEffect, useState } from "react";

import { isAdminEnabled } from "@/lib/adminMode";

export const AFTER_HOURS_MODE_STORAGE_KEY = "meridian.afterHoursMode";
const AFTER_HOURS_MODE_EVENT = "meridian:afterHoursModeChanged";
const ADMIN_EVENT = "meridian:adminModeChanged";

/**
 * Read the current flag synchronously. Returns false in SSR / Node since
 * there's no localStorage there. Treat this as the source of truth at any
 * given moment — components subscribe via the hook below for reactive
 * updates.
 */
export function isAfterHoursModeEnabled(): boolean {
  if (typeof window === "undefined") return false;
  try {
    return window.localStorage.getItem(AFTER_HOURS_MODE_STORAGE_KEY) === "on";
  } catch {
    // Private mode / disabled storage — fall back to OFF. We never want to
    // silently say ON because the user "must have meant it" — if the toggle
    // can't be persisted, the user should explicitly re-enable per session.
    return false;
  }
}

/**
 * Imperative setter. Writes to localStorage and fires the custom event so
 * every subscribed component re-reads. Pass `false` to clear; pass `true`
 * to enable.
 */
export function setAfterHoursMode(enabled: boolean): void {
  if (typeof window === "undefined") return;
  try {
    if (enabled) {
      window.localStorage.setItem(AFTER_HOURS_MODE_STORAGE_KEY, "on");
    } else {
      window.localStorage.removeItem(AFTER_HOURS_MODE_STORAGE_KEY);
    }
  } catch (err) {
    // Surface to the console so private-mode users see why the toggle
    // appears to no-op. Throwing would be hostile — the page still works
    // with the gates engaged.
    console.error(
      "afterHoursMode: failed to persist to localStorage (private mode?). " +
        "Toggle will not survive reload.",
      err,
    );
  }
  // Same-tab listeners. The native `storage` event ONLY fires in OTHER tabs.
  window.dispatchEvent(new Event(AFTER_HOURS_MODE_EVENT));
}

/**
 * React hook returning [enabled, setter]. Subscribes to both the custom
 * same-tab event AND the cross-tab `storage` event so the toggle stays
 * coherent if the user has multiple Meridian tabs open.
 *
 * Initial render returns `false` (the SSR-safe answer) so the server-
 * rendered HTML matches; the effect then reads the real value and triggers
 * a re-render. This is the same hydration-mismatch dodge Next.js uses for
 * any client-only state.
 */
/**
 * React hook returning [enabled, setter].
 *
 * The returned `enabled` value is AND-gated with the admin flag from
 * lib/adminMode.ts. This means a stale `meridian.afterHoursMode = "on"`
 * value silently does nothing for visitors who haven't signed in at
 * /admin. Consumers (trade page, markets page, banner) never need to
 * check admin separately — the hook handles it.
 *
 * Subscribes to four events to stay coherent:
 *   - same-tab afterHoursMode change (custom event)
 *   - same-tab admin change (custom event)
 *   - cross-tab `storage` (covers both keys)
 *   - (no fourth — the storage event fires once per write regardless of
 *     which of our two keys was touched, and our sync() re-reads both.)
 */
export function useAfterHoursMode(): [boolean, (next: boolean) => void] {
  const [enabled, setEnabled] = useState<boolean>(false);

  useEffect(() => {
    function sync() {
      // Effective = admin unlocked AND user flipped the toggle.
      setEnabled(isAdminEnabled() && isAfterHoursModeEnabled());
    }
    sync();

    window.addEventListener(AFTER_HOURS_MODE_EVENT, sync);
    window.addEventListener(ADMIN_EVENT, sync);
    window.addEventListener("storage", sync);
    return () => {
      window.removeEventListener(AFTER_HOURS_MODE_EVENT, sync);
      window.removeEventListener(ADMIN_EVENT, sync);
      window.removeEventListener("storage", sync);
    };
  }, []);

  return [enabled, (next: boolean) => setAfterHoursMode(next)];
}
