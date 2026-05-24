"use client";

/**
 * Browser-aware install URLs for the wallet extensions Meridian supports.
 *
 * Why this exists
 * ---------------
 * Hardcoding a single `https://<wallet>.com/download` URL routes the user
 * through one extra marketing page before reaching the actual extension
 * store. On 2026-05-24 we observed `phantom.com/download` redirecting
 * first-time users to the phantom.com home page (no install call-to-action,
 * no link forward), creating a dead end. Deep-linking to the Chrome Web
 * Store entry skips that page and surfaces "Add to Chrome" as the first
 * action.
 *
 * Strategy
 * --------
 *   - Detect Firefox (it uses Mozilla Add-ons, not the Chrome Web Store).
 *   - Anything not Firefox is treated as Chromium and gets the Chrome Web
 *     Store URL (Brave, Edge, Arc, Opera, Vivaldi, plain Chrome all share
 *     the Chrome Web Store).
 *   - Safari and unknown browsers fall back to the wallet's `/download`
 *     page. Phantom does not ship a Safari desktop extension, so the
 *     `/download` page is the right place to land Safari users (it
 *     explains the limitation and points them at supported browsers).
 *
 * Failure mode
 * ------------
 * If detection guesses wrong (e.g. a Safari user gets a Chrome Web Store
 * link), the store page shows "This extension is not supported in your
 * browser" with a recommendation to switch browsers. That is strictly
 * better than the previous marketing-page dead end. We log a console.warn
 * on Safari so the failure is visible in DevTools during a demo.
 *
 * Why we hand-roll detection instead of pulling in `bowser` or similar
 * --------------------------------------------------------------------
 *   1. We only need three branches (Chromium, Firefox, fallback). A
 *      30 KB browser-detection library is dead weight for three branches.
 *   2. Wrong answers fall through to the wallet's official `/download`
 *      page, which routes the user to the correct store on its own.
 *      Deep-linking is a speed optimisation, not a correctness primitive.
 *   3. Server-side rendering: `navigator` is undefined during Next.js
 *      build. We guard with `typeof navigator === "undefined"` and return
 *      `"unknown"` so the rendered fallback HTML uses the safe URL until
 *      hydration replaces it with the deep link.
 *
 * Adding a wallet
 * ---------------
 * Add a new entry to `LINKS_BY_WALLET` keyed by the human-readable wallet
 * name (must match the name used in `WalletPickerProvider`'s install
 * option list). Each entry needs three URLs: `chromium`, `firefox`, and
 * `fallback`. Use the wallet's `/download` page for any field where you
 * cannot verify the deep link works in the wild — a working `/download`
 * URL is always safer than a guessed Chrome Web Store ID.
 */

export type BrowserFamily = "chromium" | "firefox" | "safari" | "unknown";

/**
 * Look at the user agent and decide which install URL to surface. Returns
 * `"unknown"` during server-side rendering (no `navigator`) so callers can
 * fall back to the safe default URL. Pure function, safe to call repeatedly.
 */
export function detectBrowserFamily(): BrowserFamily {
  if (typeof navigator === "undefined") return "unknown";
  const ua = navigator.userAgent;
  if (/Firefox|FxiOS/i.test(ua)) return "firefox";
  // Safari's UA must be matched AFTER ruling out Chrome / Chromium / CriOS
  // because Chrome's UA also contains "Safari/...". Order matters here.
  if (/Safari/i.test(ua) && !/Chrome|Chromium|CriOS/i.test(ua)) return "safari";
  if (/Chrome|Chromium|CriOS|Edg\/|OPR\/|Brave/i.test(ua)) return "chromium";
  return "unknown";
}

interface WalletInstallLink {
  /** Deep link for Chrome, Brave, Edge, Arc, Opera, Vivaldi. */
  readonly chromium: string;
  /** Deep link for Firefox desktop. */
  readonly firefox: string;
  /** Used when detection returns `"safari"` or `"unknown"`. */
  readonly fallback: string;
}

// Phantom's Chrome Web Store extension ID is bfnaelmomeimhlpmgjnjophhpkkoljpa.
// This is well-known and stable; the same ID has shipped since the
// extension's public release. Mozilla Add-ons slug is `phantom-app`.
const PHANTOM_LINKS: WalletInstallLink = {
  chromium:
    "https://chromewebstore.google.com/detail/phantom/bfnaelmomeimhlpmgjnjophhpkkoljpa",
  firefox: "https://addons.mozilla.org/firefox/addon/phantom-app/",
  fallback: "https://phantom.com/download",
};

// Solflare's own `/download` page handles browser routing well and the
// Chrome Web Store extension ID is not as well-publicised, so we use the
// official download page for every branch. Future enhancement: deep-link
// once the ID is verified against the live Chrome Web Store.
const SOLFLARE_LINKS: WalletInstallLink = {
  chromium: "https://solflare.com/download",
  firefox: "https://solflare.com/download",
  fallback: "https://solflare.com/download",
};

// Backpack ships only a Chromium extension at this writing. Their
// `/download` page handles browser routing, so we route everything there
// rather than risking a wrong Chrome Web Store ID.
const BACKPACK_LINKS: WalletInstallLink = {
  chromium: "https://backpack.app/download",
  firefox: "https://backpack.app/download",
  fallback: "https://backpack.app/download",
};

const LINKS_BY_WALLET = {
  Phantom: PHANTOM_LINKS,
  Solflare: SOLFLARE_LINKS,
  Backpack: BACKPACK_LINKS,
} as const;

export type SupportedInstallWalletName = keyof typeof LINKS_BY_WALLET;

/**
 * Pick the install URL for `walletName` based on the user's browser. If
 * detection lands on Safari (which has no desktop Solana wallet extensions
 * at this writing), we still hand back the `/download` URL so the user
 * lands on a page that explains the limitation, and emit a console.warn
 * so the failure is visible during a demo.
 */
export function getWalletInstallUrl(walletName: SupportedInstallWalletName): string {
  const links = LINKS_BY_WALLET[walletName];
  const browser = detectBrowserFamily();
  switch (browser) {
    case "chromium":
      return links.chromium;
    case "firefox":
      return links.firefox;
    case "safari":
      // eslint-disable-next-line no-console
      console.warn(
        `[wallet-install] Safari detected. ${walletName} does not ship a Safari ` +
          `desktop extension. Recommend Chrome, Brave, or Edge. Falling back to ` +
          `${links.fallback}.`,
      );
      return links.fallback;
    case "unknown":
    default:
      return links.fallback;
  }
}
