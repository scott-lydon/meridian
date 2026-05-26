// Synchronous browser detection. Used by the wallet popover to show ONLY
// the user's browser instructions instead of a "Chrome / Brave / Edge"
// shrug. Different browsers really do put the extensions menu in different
// places — pretending they're the same is a UX cost.
//
// Notes on detection signals:
//   - Brave hides itself in `navigator.userAgent` to match Chrome. The
//     reliable sync probe is `'brave' in navigator` AND `typeof
//     navigator.brave.isBrave === 'function'`. Chrome does NOT inject this.
//   - Microsoft Edge keeps an `Edg/` token in the UA string (intentionally
//     truncated from "Edge" to avoid old version-sniff bugs).
//   - Firefox includes `Firefox/` in the UA.
//   - Safari has its own `Safari/` token AND lacks `Chrome|Chromium`.
//
// All checks run at module init on the client. The `unknown` fallback
// covers SSR (typeof window === "undefined") and any future browser we
// haven't added a probe for. Callers must handle `unknown` gracefully —
// usually by falling back to a generic instruction set.

export type DetectedBrowser = "chrome" | "brave" | "edge" | "firefox" | "safari" | "unknown";

export function detectBrowser(): DetectedBrowser {
  if (typeof window === "undefined" || typeof navigator === "undefined") {
    return "unknown";
  }
  const nav = navigator as Navigator & { brave?: { isBrave?: () => Promise<boolean> } };
  // Brave first: hides in UA, so a UA-only check misclassifies it as Chrome.
  if (nav.brave && typeof nav.brave.isBrave === "function") return "brave";
  const ua = navigator.userAgent;
  if (/Edg\//.test(ua)) return "edge";
  if (/Firefox\//.test(ua)) return "firefox";
  if (/Chrome\//.test(ua) && !/Edg\/|OPR\//.test(ua)) return "chrome";
  if (/Safari\//.test(ua) && !/Chrome|Chromium/.test(ua)) return "safari";
  return "unknown";
}

export function browserDisplayName(b: DetectedBrowser): string {
  switch (b) {
    case "chrome":
      return "Chrome";
    case "brave":
      return "Brave";
    case "edge":
      return "Edge";
    case "firefox":
      return "Firefox";
    case "safari":
      return "Safari";
    case "unknown":
      return "your browser";
  }
}

/**
 * Browser-specific text for "you can't find your extension in the toolbar
 * — here's where to look." Returned as plain strings; the caller wraps
 * them in <li> tags or whatever structure they need.
 *
 * extensionName is the wallet's display name ("Phantom", "Solflare", etc.).
 */
export function findExtensionInstructions(
  browser: DetectedBrowser,
  extensionName: string,
): string {
  switch (browser) {
    case "chrome":
      return `In Chrome, extension icons aren't pinned by default. Click the puzzle-piece icon in the top-right of the Chrome window (beside your profile picture), pick ${extensionName} from the list to open it. To make it appear in the toolbar going forward, click the pin icon next to ${extensionName}'s row.`;
    case "brave":
      return `In Brave, extension icons aren't pinned by default. Click the puzzle-piece icon in the top-right of the Brave window, pick ${extensionName} to open it. To pin: click the pin icon next to ${extensionName}'s row in the extensions list.`;
    case "edge":
      return `In Edge, extension icons aren't pinned by default. Click the puzzle-piece icon in the top-right of the Edge window, pick ${extensionName} to open it. To pin: click the eye icon next to ${extensionName} in the extensions menu, then choose "Show in toolbar".`;
    case "firefox":
      // Coinbase Wallet's browser extension is Chromium-only at this
      // writing — there is no Firefox build. Steer Coinbase users to a
      // Chromium browser instead of telling them to enable an add-on
      // that does not exist.
      if (extensionName.toLowerCase().includes("coinbase")) {
        return `Coinbase Wallet does not ship a Firefox extension. For Coinbase Wallet, use Chrome, Brave, or Edge. Or pick Phantom / Solflare here — both do work on Firefox.`;
      }
      return `In Firefox, extension icons usually appear in the toolbar automatically. If you don't see ${extensionName}, click the hamburger menu (three lines, top-right) → "Add-ons and themes" → "Extensions" and make sure ${extensionName} is enabled.`;
    case "safari":
      // Updated 2026-05-25: Phantom ships a real Safari WebExtension
      // (distributed via the Mac App Store as "Phantom for Safari"), so the
      // previous flat "Safari has no support" message was wrong. Phantom on
      // Safari injects its provider at `window.phantom.solana`; the
      // PhantomWalletAdapter detects it the same way it does on Chromium.
      // Solflare's Safari extension is in beta and detection is less
      // reliable; we still steer Solflare users toward a Chromium browser.
      // Coinbase Wallet has no Safari desktop extension either; same path.
      return extensionName.toLowerCase() === "phantom"
        ? `On Safari (macOS), install Phantom for Safari from the Mac App Store, then enable the extension under Safari → Settings → Extensions and allow it on this site. After enabling, reload this page. Phantom's Safari extension is the only Solana wallet extension currently shipped for Safari; Solflare, Backpack, and Coinbase Wallet are Chromium-only.`
        : `${extensionName} does not ship a Safari extension. For ${extensionName}, use Chrome, Brave, Edge, or Firefox. Phantom is the one Solana wallet that does support Safari (Mac App Store).`;
    case "unknown":
      return `If you don't see the ${extensionName} icon in your toolbar, look for an "Extensions" menu in your browser's toolbar (usually top-right, often a puzzle-piece icon) and select ${extensionName} from the list.`;
  }
}

/**
 * True if the detected browser supports the wallet extensions Meridian
 * uses (Phantom + Solflare). Used to control whether a hard-stop banner is
 * surfaced inside the NetworkBadge popover.
 *
 * Safari is included as of 2026-05-25 because Phantom now ships a real
 * Safari WebExtension on the Mac App Store; suppressing the hard-stop is
 * accurate but the install instructions for Safari are Phantom-specific
 * (see `findExtensionInstructions`). Solflare's Safari extension is in
 * beta and unreliable, so the per-row Solflare copy steers Safari users
 * to Chromium for Solflare while still letting them pick Phantom here.
 */
export function isWalletSupportedBrowser(b: DetectedBrowser): boolean {
  return (
    b === "chrome" ||
    b === "brave" ||
    b === "edge" ||
    b === "firefox" ||
    b === "safari"
  );
}
