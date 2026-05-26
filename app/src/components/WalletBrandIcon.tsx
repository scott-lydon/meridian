"use client";

// WalletBrandIcon — renders each wallet's official brand mark as INLINE SVG
// JSX, not as an <img src="data:image/svg+xml;base64,..."/>.
//
// Why inline SVG instead of a data URL:
//
//   1. The previous implementation passed a `data:image/svg+xml;base64,...`
//      string to <img>. In most browsers this works. But in real user
//      reports (2026-05-24, both Safari and Chrome on macOS), the Phantom
//      and Solflare install-row icons came back as the browser's broken-
//      image glyph while the simpler Backpack mark next to them rendered
//      fine. The Backpack mark was the only one drawn directly in JSX
//      (rect + text). The Phantom and Solflare marks were the only two
//      coming through the <img src=data-url> pipeline. The differentiator
//      is the rendering path, not the SVG content (we verified all three
//      data URLs decode to valid SVG with `base64 -d`). Inlining the SVG
//      removes the data-URL parsing step entirely and renders identically
//      in every browser.
//
//   2. Browser extensions (ad blockers, privacy extensions, "Image Block"
//      utilities) occasionally interfere with data: URL <img> resources
//      even though the bytes never leave the page. Inline <svg> JSX is
//      part of the document tree and cannot be blocked by a network-level
//      extension.
//
//   3. We pay zero extra bandwidth: the SVG bytes shipped as a base64
//      string in the prior implementation, and ship as JSX in this one.
//      The JSX form is actually smaller because there is no base64 padding
//      overhead.
//
// The original constants in `lib/walletIcons.ts` are kept for any future
// caller that genuinely needs a data URL (e.g. dropping a wallet mark into
// a generated PDF or a clipboard payload). They are no longer used by the
// install-row UI; that contract is now this component.
//
// Adding a new wallet:
//   1. Find the official SVG (the wallet's brand kit or
//      node_modules/.pnpm/@solana+wallet-adapter-<name>/.../adapter.js).
//   2. Add a case below. Use `viewBox` (not `width`/`height`) so Tailwind
//      classes control the rendered size from outside.
//   3. Wire it up in `WalletPickerProvider` by replacing the install-row
//      <img> with `<WalletBrandIcon name="…" className="h-7 w-7" />`.

import type { JSX } from "react";

export type WalletBrand = "Phantom" | "Solflare" | "Backpack" | "Coinbase";

interface WalletBrandIconProps {
  name: WalletBrand;
  /** Tailwind sizing classes. Default 28x28 to match the previous img. */
  className?: string;
}

/**
 * Inline-SVG rendering of each wallet's mark. Returns a React element, not
 * a data URL. Sized by the consumer via Tailwind classes (defaults to a
 * 28×28 rounded chip to match the prior <img className="h-7 w-7 rounded">).
 *
 * Each `viewBox` is taken from the official artwork so the marks render at
 * their intended aspect ratio. The wrapping `<span>` carries the rounded
 * corners so a wallet whose own SVG is square (Solflare, Backpack) still
 * matches the rounded-square chrome of the row.
 */
export function WalletBrandIcon({
  name,
  className = "h-7 w-7",
}: WalletBrandIconProps): JSX.Element {
  // The `aria-hidden` is intentional. These icons are purely decorative;
  // each install row already has a visible "Install Phantom" label as the
  // accessible name, so screen readers should not announce the icon too.
  const wrapperClass = `${className} inline-block overflow-hidden rounded`;

  switch (name) {
    case "Phantom":
      // Source: @solana/wallet-adapter-phantom adapter.js — the canonical
      // mark shipped with the wallet adapter. Lavender background, two-tone
      // ghost glyph.
      return (
        <span className={wrapperClass} aria-hidden="true">
          <svg
            xmlns="http://www.w3.org/2000/svg"
            viewBox="0 0 108 108"
            width="100%"
            height="100%"
            fill="none"
          >
            <rect width="108" height="108" rx="26" fill="#AB9FF2" />
            <path
              fillRule="evenodd"
              clipRule="evenodd"
              d="M46.5267 69.9229C42.0054 76.8509 34.4292 85.6182 24.348 85.6182C19.5824 85.6182 15 83.6563 15 75.1342C15 53.4305 44.6326 19.8327 72.1268 19.8327C87.768 19.8327 94 30.6846 94 43.0079C94 58.8258 83.7355 76.9122 73.5321 76.9122C70.2939 76.9122 68.7053 75.1342 68.7053 72.314C68.7053 71.5783 68.8275 70.7812 69.0719 69.9229C65.5893 75.8699 58.8685 81.3878 52.5754 81.3878C47.993 81.3878 45.6713 78.5063 45.6713 74.4598C45.6713 72.9884 45.9768 71.4556 46.5267 69.9229ZM83.6761 42.5794C83.6761 46.1704 81.5575 47.9658 79.1875 47.9658C76.7816 47.9658 74.6989 46.1704 74.6989 42.5794C74.6989 38.9885 76.7816 37.1931 79.1875 37.1931C81.5575 37.1931 83.6761 38.9885 83.6761 42.5794ZM70.2103 42.5795C70.2103 46.1704 68.0916 47.9658 65.7216 47.9658C63.3157 47.9658 61.233 46.1704 61.233 42.5795C61.233 38.9885 63.3157 37.1931 65.7216 37.1931C68.0916 37.1931 70.2103 38.9885 70.2103 42.5795Z"
              fill="#FFFDF8"
            />
          </svg>
        </span>
      );

    case "Solflare":
      // Source: @solana/wallet-adapter-solflare adapter.js. Yellow ground,
      // dark sun glyph. The original artwork uses a <style> CSS block with
      // class selectors; we inline the resulting fills/strokes directly so
      // there is no embedded stylesheet to scope-collide with the page CSS.
      return (
        <span className={wrapperClass} aria-hidden="true">
          <svg
            xmlns="http://www.w3.org/2000/svg"
            viewBox="0 0 50 50"
            width="100%"
            height="100%"
          >
            <rect x="0" width="50" height="50" rx="12" ry="12" fill="#ffef46" />
            <path
              fill="#02050a"
              stroke="#ffef46"
              strokeMiterlimit={10}
              strokeWidth={0.5}
              d="M24.23,26.42l2.46-2.38,4.59,1.5c3.01,1,4.51,2.84,4.51,5.43,0,1.96-.75,3.26-2.25,4.93l-.46.5.17-1.17c.67-4.26-.58-6.09-4.72-7.43l-4.3-1.38h0ZM18.05,11.85l12.52,4.17-2.71,2.59-6.51-2.17c-2.25-.75-3.01-1.96-3.3-4.51v-.08h0ZM17.3,33.06l2.84-2.71,5.34,1.75c2.8.92,3.76,2.13,3.46,5.18l-11.65-4.22h0ZM13.71,20.95c0-.79.42-1.54,1.13-2.17.75,1.09,2.05,2.05,4.09,2.71l4.42,1.46-2.46,2.38-4.34-1.42c-2-.67-2.84-1.67-2.84-2.96M26.82,42.87c9.18-6.09,14.11-10.23,14.11-15.32,0-3.38-2-5.26-6.43-6.72l-3.34-1.13,9.14-8.77-1.84-1.96-2.71,2.38-12.81-4.22c-3.97,1.29-8.97,5.09-8.97,8.89,0,.42.04.83.17,1.29-3.3,1.88-4.63,3.63-4.63,5.8,0,2.05,1.09,4.09,4.55,5.22l2.75.92-9.52,9.14,1.84,1.96,2.96-2.71,14.73,5.22h0Z"
            />
          </svg>
        </span>
      );

    case "Backpack":
      // Backpack does not publish an SVG on Simple Icons or in the adapter
      // package, so this is the same hand-drawn monogram (red rounded
      // square + bold white "B") that previously shipped as a data URL.
      // Rendering it inline keeps the three install rows consistent.
      return (
        <span className={wrapperClass} aria-hidden="true">
          <svg
            xmlns="http://www.w3.org/2000/svg"
            viewBox="0 0 50 50"
            width="100%"
            height="100%"
          >
            <rect
              x="0"
              y="0"
              width="50"
              height="50"
              rx="12"
              ry="12"
              fill="#E33E3F"
            />
            <text
              x="25"
              y="34"
              textAnchor="middle"
              fontFamily="-apple-system,BlinkMacSystemFont,Segoe UI,Roboto,sans-serif"
              fontSize="28"
              fontWeight="800"
              fill="#ffffff"
            >
              B
            </text>
          </svg>
        </span>
      );

    case "Coinbase":
      // Source: @solana/wallet-adapter-coinbase adapter.js — the canonical
      // mark shipped with the wallet adapter. Coinbase brand blue (#0052FF)
      // disc with a white inset square (the "Coinbase symbol"). The original
      // ships as a base64 data URL inside the adapter; rendered here as
      // inline JSX so it follows the same rendering path as the Phantom and
      // Solflare marks (no data-URL pipeline that 2026-05-24 user reports
      // showed silently broken in Safari + Chrome).
      return (
        <span className={wrapperClass} aria-hidden="true">
          <svg
            xmlns="http://www.w3.org/2000/svg"
            viewBox="0 0 1024 1024"
            width="100%"
            height="100%"
            fill="none"
          >
            <circle cx="512" cy="512" r="512" fill="#0052FF" />
            <path
              fillRule="evenodd"
              clipRule="evenodd"
              d="M152 512C152 710.823 313.177 872 512 872C710.823 872 872 710.823 872 512C872 313.177 710.823 152 512 152C313.177 152 152 313.177 152 512ZM420 396C406.745 396 396 406.745 396 420V604C396 617.255 406.745 628 420 628H604C617.255 628 628 617.255 628 604V420C628 406.745 617.255 396 604 396H420Z"
              fill="white"
            />
          </svg>
        </span>
      );

    default: {
      // Exhaustiveness check — adding a new WalletBrand without adding a
      // case above is a compile-time error, not a silent fallback to a
      // broken icon.
      const exhaustive: never = name;
      throw new Error(
        `[WalletBrandIcon] unhandled wallet brand: ${exhaustive as string}. ` +
          "Add a case in WalletBrandIcon.tsx and a matching entry in INSTALL_OPTIONS.",
      );
    }
  }
}
