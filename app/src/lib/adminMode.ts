"use client";

// adminMode — a localStorage flag that gates dev-only affordances on
// public deployments. The flag is set by /admin sign-in (username "admin",
// password "pass" — see app/src/app/admin/page.tsx) and consumed by
// AfterHoursModeToggle to decide whether the 🧪 DEV button is visible.
//
// THIS IS NOT A SECURITY BOUNDARY.
//
// The toggle it gates only relaxes client-side UI checks (isExpired,
// sessionPhase banner). The on-chain Anchor program already accepts
// mint_pair / place_order / buy_no / sell_no / match_orders / cancel_order
// / redeem 24/7 — anyone with a wallet can submit those transactions
// regardless of what's in localStorage. The intent of this gate is
// "don't put the dev affordance in front of casual visitors on a public
// URL", not "protect the program from misuse." That protection lives in
// the Anchor program's own require! checks.
//
// Anyone who knows the password can flip the flag. The password is
// committed into the client bundle on purpose because there's nothing to
// protect — the toggle has no privileged on-chain effect.

import { useEffect, useState } from "react";

export const ADMIN_STORAGE_KEY = "meridian.admin";
const ADMIN_EVENT = "meridian:adminModeChanged";

// Hard-coded credentials. Same admin/pass convention used elsewhere in the
// user's stack (OpenEMR's bundled default). The /admin form validates
// these literally.
export const ADMIN_USERNAME = "admin";
export const ADMIN_PASSWORD = "pass";

/**
 * Read the flag synchronously. SSR returns false because there's no
 * localStorage in Node — the client effect re-reads after mount.
 */
export function isAdminEnabled(): boolean {
  if (typeof window === "undefined") return false;
  try {
    return window.localStorage.getItem(ADMIN_STORAGE_KEY) === "on";
  } catch {
    // Private mode / storage disabled — fall back to OFF. Never silently
    // enable; the user must explicitly sign in.
    return false;
  }
}

/**
 * Set or clear the flag. Fires the custom event so other components
 * (specifically AfterHoursModeToggle) re-read without a route change.
 */
export function setAdminEnabled(enabled: boolean): void {
  if (typeof window === "undefined") return;
  try {
    if (enabled) {
      window.localStorage.setItem(ADMIN_STORAGE_KEY, "on");
    } else {
      window.localStorage.removeItem(ADMIN_STORAGE_KEY);
    }
  } catch (err) {
    console.error(
      "adminMode: failed to persist to localStorage (private mode?). " +
        "Sign-in will not survive reload.",
      err,
    );
  }
  window.dispatchEvent(new Event(ADMIN_EVENT));
}

/**
 * React hook returning the current flag. Subscribes to same-tab event +
 * cross-tab storage event so the visibility of dev affordances stays
 * coherent if the user has multiple tabs open.
 */
export function useAdminMode(): boolean {
  const [enabled, setEnabled] = useState<boolean>(false);
  useEffect(() => {
    setEnabled(isAdminEnabled());
    function sync() {
      setEnabled(isAdminEnabled());
    }
    window.addEventListener(ADMIN_EVENT, sync);
    window.addEventListener("storage", sync);
    return () => {
      window.removeEventListener(ADMIN_EVENT, sync);
      window.removeEventListener("storage", sync);
    };
  }, []);
  return enabled;
}
