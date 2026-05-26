"use client";

// AfterHoursModeToggle — small flask button in the header that opens a
// popover with the after-hours testing toggle. When the flag is ON the
// button glows orange and a persistent top-of-page banner renders via
// AfterHoursBanner (separate component below) so the user can't forget
// the gates are relaxed.
//
// Pairs with afterHoursMode.ts (state) and AfterHoursBanner (the loud
// reminder strip). Toggle persists in localStorage so closing the popover
// does not lose state.

import { useEffect, useRef, useState } from "react";

// Per-tab dismissal of the AfterHoursBanner strip. Stored in
// sessionStorage (not localStorage) so closing and reopening the browser
// brings the banner back — the safety reminder must survive normal
// "I'm just dismissing this banner right now" without permanently
// hiding the active-test-mode warning. Resets whenever the toggle is
// flipped OFF and ON again, so the user always sees the banner once
// per testing session.
const BANNER_DISMISSED_SESSION_KEY = "meridian.afterHoursBannerDismissed";
const BANNER_DISMISSED_EVENT = "meridian:afterHoursBannerDismissedChanged";

function readBannerDismissed(): boolean {
  if (typeof window === "undefined") return false;
  try {
    return window.sessionStorage.getItem(BANNER_DISMISSED_SESSION_KEY) === "1";
  } catch {
    return false;
  }
}

function setBannerDismissed(value: boolean): void {
  if (typeof window === "undefined") return;
  try {
    if (value) {
      window.sessionStorage.setItem(BANNER_DISMISSED_SESSION_KEY, "1");
    } else {
      window.sessionStorage.removeItem(BANNER_DISMISSED_SESSION_KEY);
    }
  } catch (err) {
    // Private browsing / disabled storage. Surface to the console so the
    // operator understands why "X" appears to no-op; do not throw — the
    // page still functions with the banner visible.
    console.error("afterHoursBanner: failed to persist dismissal state", err);
  }
  window.dispatchEvent(new Event(BANNER_DISMISSED_EVENT));
}

import { useAdminMode } from "@/lib/adminMode";
import { useAfterHoursMode } from "@/lib/afterHoursMode";

export function AfterHoursModeToggle() {
  const [open, setOpen] = useState(false);
  const [enabled, setEnabled] = useAfterHoursMode();
  const containerRef = useRef<HTMLDivElement>(null);
  // The whole toggle is hidden on public deployments unless the visitor has
  // signed in at /admin. SSR-safe because useAdminMode() returns false
  // until the client effect runs. On localhost the user can still sign in
  // once and never see the form again (localStorage persists). The gate
  // protects the affordance, not the program — see lib/adminMode.ts.
  const adminUnlocked = useAdminMode();

  // Outside-click + Esc close. Matches NetworkBadge's popover pattern so
  // the two feel like the same control style.
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

  // When ON: amber flask + ring so the button itself is visible state.
  // When OFF: muted icon, just available. Using Tailwind's built-in amber
  // palette (no theme-config change required for one rarely-used signal).
  const buttonClass = enabled
    ? "rounded-full border border-amber-500/50 bg-amber-500/15 px-2 py-1 text-xs font-semibold text-amber-400 hover:bg-amber-500/25"
    : "rounded-full border border-panel bg-panel/40 px-2 py-1 text-xs text-muted hover:bg-panel hover:text-text";

  // Public visitors don't see this at all. They have to visit /admin and
  // sign in first. Renders null AFTER hooks (rules of hooks compliance).
  if (!adminUnlocked) return null;

  return (
    <div className="relative" ref={containerRef}>
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        className={buttonClass}
        title={
          enabled
            ? "After-hours testing mode is ON. Click to manage."
            : "Open after-hours testing mode toggle (relaxes UI expiry gates for testing)."
        }
        aria-haspopup="dialog"
        aria-expanded={open}
        aria-label="After-hours testing mode toggle"
      >
        <span aria-hidden="true">🧪</span>
        <span className="ml-1 hidden sm:inline">{enabled ? "TESTING ON" : "DEV"}</span>
      </button>
      {open && (
        <div
          role="dialog"
          aria-label="After-hours testing mode"
          className="absolute right-0 z-30 mt-2 max-h-[min(80vh,calc(100vh-5rem))] w-[min(22rem,calc(100vw-3rem))] overflow-y-auto overscroll-contain rounded-2xl border border-panel bg-bg/95 p-4 text-sm shadow-2xl backdrop-blur-md"
        >
          <div className="mb-3 flex items-start justify-between gap-3">
            <p className="font-semibold text-text">After-hours testing mode</p>
            <button
              onClick={() => setOpen(false)}
              className="rounded p-1 text-muted hover:bg-panel hover:text-text"
              aria-label="Close"
              title="Close"
            >
              ✕
            </button>
          </div>

          <p className="mb-3 text-xs text-muted">
            Relaxes the client-side <code className="rounded bg-panel/60 px-1 font-mono text-[10px]">isExpired</code>{" "}
            and <em>Trading closed</em> banner so you can mint pair, place orders, and trade
            against markets past their 16:00 ET expiry. The Anchor program already accepts these
            transactions 24/7 — this toggle only flips the UI gate that mirrors product rules.
          </p>

          <label className="flex cursor-pointer items-center justify-between rounded-lg border border-panel bg-panel/40 p-3">
            <span className="text-sm text-text">
              <span className="font-semibold">Bypass UI expiry gates</span>
              <span className="block text-[11px] text-muted">
                {enabled ? "ON — UI shows past-expiry markets as tradeable" : "OFF — normal product rules"}
              </span>
            </span>
            <input
              type="checkbox"
              checked={enabled}
              onChange={(e) => setEnabled(e.target.checked)}
              className="h-5 w-5 cursor-pointer accent-amber-500"
              aria-label="Bypass UI expiry gates"
            />
          </label>

          <div className="mt-3 rounded-md border border-amber-500/30 bg-amber-500/5 p-2 text-[11px] text-amber-300">
            <span className="font-semibold">Heads up:</span> while this is ON, every page shows a
            persistent banner so you don&apos;t forget. The toggle is per-browser (localStorage)
            and does not affect other users.
          </div>
        </div>
      )}
    </div>
  );
}

/**
 * Persistent top-of-page strip rendered when after-hours mode is ON.
 * Acts as the constant visual reminder that the gates are relaxed, plus
 * two one-click affordances:
 *   - "Turn off →" disables the entire testing mode (preserves prior behavior).
 *   - "✕"        dismisses the BANNER for this tab session only, leaving
 *                 the mode ON. Cleared when (a) the user opens a new
 *                 tab/browser, or (b) the toggle is flipped OFF then ON
 *                 again, so the safety reminder is always shown at the
 *                 start of every new testing session.
 *
 * Lives in the layout above page content; height collapses to zero when
 * the flag is OFF or the user has dismissed it in this session so it
 * doesn't shift layout in the normal case.
 */
export function AfterHoursBanner() {
  const [enabled, setEnabled] = useAfterHoursMode();
  const adminUnlocked = useAdminMode();
  // Local mirror of sessionStorage so the component re-renders when the
  // close button is clicked or when another tab/another component
  // toggles the dismissal state. Hydration-safe: the effect re-reads
  // after mount so SSR HTML matches.
  const [dismissed, setDismissedState] = useState(false);
  useEffect(() => {
    function sync() {
      setDismissedState(readBannerDismissed());
    }
    sync();
    window.addEventListener(BANNER_DISMISSED_EVENT, sync);
    window.addEventListener("storage", sync);
    return () => {
      window.removeEventListener(BANNER_DISMISSED_EVENT, sync);
      window.removeEventListener("storage", sync);
    };
  }, []);

  // Clear the dismissal flag whenever the user toggles testing mode OFF
  // so the next time they enable it, the banner re-appears for the
  // safety reminder. Without this, dismissing once would silence the
  // banner across every future enable-disable-enable cycle in the same
  // tab session.
  const lastEnabledRef = useRef<boolean>(enabled);
  useEffect(() => {
    if (lastEnabledRef.current === true && enabled === false) {
      setBannerDismissed(false);
    }
    lastEnabledRef.current = enabled;
  }, [enabled]);

  // Only show the banner when (a) admin has unlocked, (b) the toggle is
  // ON, and (c) the user has not closed it this session. Without the
  // admin guard, a user who flipped the toggle and then signed out
  // would keep seeing the banner forever even though the affordance is
  // meant to be hidden. All three flags are reachable independently.
  if (!adminUnlocked || !enabled || dismissed) return null;
  return (
    <div
      role="status"
      aria-live="polite"
      className="sticky top-[57px] z-10 flex items-center justify-center gap-2 border-b border-amber-500/40 bg-amber-500/15 px-4 py-2 text-center text-xs text-amber-300"
    >
      <span className="flex-1">
        <span className="font-semibold">🧪 After-hours testing mode is ON</span>{" "}
        <span className="text-amber-300/80">
          — UI expiry gates relaxed. The program already allows these transactions; only the
          product&apos;s wall-clock rules are bypassed.
        </span>{" "}
        <button
          type="button"
          onClick={() => setEnabled(false)}
          className="ml-2 inline-flex items-center gap-1 rounded-full border border-amber-500/40 bg-amber-500/10 px-2 py-0.5 text-[11px] font-semibold text-amber-300 hover:bg-amber-500/20"
        >
          Turn off →
        </button>
      </span>
      <button
        type="button"
        onClick={() => setBannerDismissed(true)}
        className="rounded p-1 text-amber-300/80 hover:bg-amber-500/15 hover:text-amber-200"
        aria-label="Dismiss the after-hours testing banner for this session (mode stays ON)"
        title={
          "Dismiss this banner for the current tab session. Testing mode stays ON; the " +
          "banner reappears in a new tab, after a browser restart, or after you toggle " +
          "the mode OFF and back ON."
        }
      >
        ✕
      </button>
    </div>
  );
}
