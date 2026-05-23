// Official Phantom + Solflare logos extracted from the @solana/wallet-adapter
// packages so the popover instructions show the exact icon a user will see
// in their browser extensions menu. Inlined as constants (no runtime fetch,
// no risk of an external CDN going down or rate-limiting our users mid-demo).
//
// Source files (regenerate with the snippets below if upgrading the adapter):
//   node_modules/.pnpm/@solana+wallet-adapter-phantom@*/node_modules/@solana/wallet-adapter-phantom/lib/cjs/adapter.js
//   node_modules/.pnpm/@solana+wallet-adapter-solflare@*/node_modules/@solana/wallet-adapter-solflare/lib/cjs/adapter.js
//
//   grep -o "data:image[^\"']*" .../wallet-adapter-phantom/lib/cjs/adapter.js | head -1
//   grep -o "data:image[^\"']*" .../wallet-adapter-solflare/lib/cjs/adapter.js | head -1

export const PHANTOM_ICON_DATA_URL =
  "data:image/svg+xml;base64,PHN2ZyB4bWxucz0iaHR0cDovL3d3dy53My5vcmcvMjAwMC9zdmciIHdpZHRoPSIxMDgiIGhlaWdodD0iMTA4IiB2aWV3Qm94PSIwIDAgMTA4IDEwOCIgZmlsbD0ibm9uZSI+CjxyZWN0IHdpZHRoPSIxMDgiIGhlaWdodD0iMTA4IiByeD0iMjYiIGZpbGw9IiNBQjlGRjIiLz4KPHBhdGggZmlsbC1ydWxlPSJldmVub2RkIiBjbGlwLXJ1bGU9ImV2ZW5vZGQiIGQ9Ik00Ni41MjY3IDY5LjkyMjlDNDIuMDA1NCA3Ni44NTA5IDM0LjQyOTIgODUuNjE4MiAyNC4zNDggODUuNjE4MkMxOS41ODI0IDg1LjYxODIgMTUgODMuNjU2MyAxNSA3NS4xMzQyQzE1IDUzLjQzMDUgNDQuNjMyNiAxOS44MzI3IDcyLjEyNjggMTkuODMyN0M4Ny43NjggMTkuODMyNyA5NCAzMC42ODQ2IDk0IDQzLjAwNzlDOTQgNTguODI1OCA4My43MzU1IDc2LjkxMjIgNzMuNTMyMSA3Ni45MTIyQzcwLjI5MzkgNzYuOTEyMiA2OC43MDUzIDc1LjEzNDIgNjguNzA1MyA3Mi4zMTRDNjguNzA1MyA3MS41NzgzIDY4LjgyNzUgNzAuNzgxMiA2OS4wNzE5IDY5LjkyMjlDNjUuNTg5MyA3NS44Njk5IDU4Ljg2ODUgODEuMzg3OCA1Mi41NzU0IDgxLjM4NzhDNDcuOTkzIDgxLjM4NzggNDUuNjcxMyA3OC41MDYzIDQ1LjY3MTMgNzQuNDU5OEM0NS42NzEzIDcyLjk4ODQgNDUuOTc2OCA3MS40NTU2IDQ2LjUyNjcgNjkuOTIyOVpNODMuNjc2MSA0Mi41Nzk0QzgzLjY3NjEgNDYuMTcwNCA4MS41NTc1IDQ3Ljk2NTggNzkuMTg3NSA0Ny45NjU4Qzc2Ljc4MTYgNDcuOTY1OCA3NC42OTg5IDQ2LjE3MDQgNzQuNjk4OSA0Mi41Nzk0Qzc0LjY5ODkgMzguOTg4NSA3Ni43ODE2IDM3LjE5MzEgNzkuMTg3NSAzNy4xOTMxQzgxLjU1NzUgMzcuMTkzMSA4My42NzYxIDM4Ljk4ODUgODMuNjc2MSA0Mi41Nzk0Wk03MC4yMTAzIDQyLjU3OTVDNzAuMjEwMyA0Ni4xNzA0IDY4LjA5MTYgNDcuOTY1OCA2NS43MjE2IDQ3Ljk2NThDNjMuMzE1NyA0Ny45NjU4IDYxLjIzMyA0Ni4xNzA0IDYxLjIzMyA0Mi41Nzk1QzYxLjIzMyAzOC45ODg1IDYzLjMxNTcgMzcuMTkzMSA2NS43MjE2IDM3LjE5MzFDNjguMDkxNiAzNy4xOTMxIDcwLjIxMDMgMzguOTg4NSA3MC4yMTAzIDQyLjU3OTVaIiBmaWxsPSIjRkZGREY4Ii8+Cjwvc3ZnPg==";

export const SOLFLARE_ICON_DATA_URL =
  "data:image/svg+xml;base64,PD94bWwgdmVyc2lvbj0iMS4wIiBlbmNvZGluZz0iVVRGLTgiPz48c3ZnIGlkPSJTIiB4bWxucz0iaHR0cDovL3d3dy53My5vcmcvMjAwMC9zdmciIHZpZXdCb3g9IjAgMCA1MCA1MCI+PGRlZnM+PHN0eWxlPi5jbHMtMXtmaWxsOiMwMjA1MGE7c3Ryb2tlOiNmZmVmNDY7c3Ryb2tlLW1pdGVybGltaXQ6MTA7c3Ryb2tlLXdpZHRoOi41cHg7fS5jbHMtMntmaWxsOiNmZmVmNDY7fTwvc3R5bGU+PC9kZWZzPjxyZWN0IGNsYXNzPSJjbHMtMiIgeD0iMCIgd2lkdGg9IjUwIiBoZWlnaHQ9IjUwIiByeD0iMTIiIHJ5PSIxMiIvPjxwYXRoIGNsYXNzPSJjbHMtMSIgZD0iTTI0LjIzLDI2LjQybDIuNDYtMi4zOCw0LjU5LDEuNWMzLjAxLDEsNC41MSwyLjg0LDQuNTEsNS40MywwLDEuOTYtLjc1LDMuMjYtMi4yNSw0LjkzbC0uNDYuNS4xNy0xLjE3Yy42Ny00LjI2LS41OC02LjA5LTQuNzItNy40M2wtNC4zLTEuMzhoMFpNMTguMDUsMTEuODVsMTIuNTIsNC4xNy0yLjcxLDIuNTktNi41MS0yLjE3Yy0yLjI1LS43NS0zLjAxLTEuOTYtMy4zLTQuNTF2LS4wOGgwWk0xNy4zLDMzLjA2bDIuODQtMi43MSw1LjM0LDEuNzVjMi44LjkyLDMuNzYsMi4xMywzLjQ2LDUuMThsLTExLjY1LTQuMjJoMFpNMTMuNzEsMjAuOTVjMC0uNzkuNDItMS41NCwxLjEzLTIuMTcuNzUsMS4wOSwyLjA1LDIuMDUsNC4wOSwyLjcxbDQuNDIsMS40Ni0yLjQ2LDIuMzgtNC4zNC0xLjQyYy0yLS42Ny0yLjg0LTEuNjctMi44NC0yLjk2TTI2LjgyLDQyLjg3YzkuMTgtNi4wOSwxNC4xMS0xMC4yMywxNC4xMS0xNS4zMiwwLTMuMzgtMi01LjI2LTYuNDMtNi43MmwtMy4zNC0xLjEzLDkuMTQtOC43Ny0xLjg0LTEuOTYtMi43MSwyLjM4LTEyLjgxLTQuMjJjLTMuOTcsMS4yOS04Ljk3LDUuMDktOC45Nyw4Ljg5LDAsLjQyLjA0LjgzLjE3LDEuMjktMy4zLDEuODgtNC42MywzLjYzLTQuNjMsNS44LDAsMi4wNSwxLjA5LDQuMDksNC41NSw1LjIybDIuNzUuOTItOS41Miw5LjE0LDEuODQsMS45NiwyLjk2LTIuNzEsMTQuNzMsNS4yMmgwWiIvPjwvc3ZnPg==";

/**
 * Browser logo URLs.
 *
 * ALL FOUR ARE INLINED as data URLs (no third-party CDN). The earlier
 * cdn.simpleicons.org references failed silently in Safari (the SVGs are
 * served with a Cross-Origin-Resource-Policy that Safari treats as a
 * cross-origin fetch failure on Strict tracking-prevention; the request
 * returns 200 but the image never paints). Inlining the marks removes the
 * failure mode entirely AND removes a deploy-day risk that the CDN could
 * go down or rate-limit during the AI interview demo.
 *
 * Source marks: stylized brand monograms drawn for this app (not
 * pixel-copied from the official logos). Chrome = red/green/yellow tri-arc
 * with a blue center; Brave = orange shield with a B; Firefox = orange
 * flame ring with an F; Edge = teal-to-blue gradient circle with an "e".
 * All four browsers run Phantom + Solflare equally well — Edge is Chromium
 * under the hood — so the marks are presence-only, not capability badges.
 */
export const BROWSER_ICONS = {
  // Chrome — simplified tri-color disc + blue center (stylized).
  Chrome:
    "data:image/svg+xml;base64,PHN2ZyB4bWxucz0iaHR0cDovL3d3dy53My5vcmcvMjAwMC9zdmciIHZpZXdCb3g9IjAgMCAyNCAyNCI+PGNpcmNsZSBjeD0iMTIiIGN5PSIxMiIgcj0iMTEiIGZpbGw9IiNmZmZmZmYiLz48cGF0aCBkPSJNMTIgMWE5IDkgMCAwIDEgNy43OSA0LjVoLTcuNzlhNi41IDYuNSAwIDAgMC02LjA4IDQuMjFsLTMuOTUtNi44NEE5IDkgMCAwIDEgMTIgMVoiIGZpbGw9IiNlYTQzMzUiLz48cGF0aCBkPSJtNS43MiA5LjcxLTMuOTUtNi44NGE5IDkgMCAwIDAgMS43MyAxNS41NGw0LjYxLTQuNjFhNi41IDYuNSAwIDAgMS0yLjM5LTQuMDlaIiBmaWxsPSIjZmJiYzA1Ii8+PHBhdGggZD0iTTEyIDIyYTkgOSAwIDAgMCA4LjE4LTUuMjVMMTUuNyAxMC4yYTYuNSA2LjUgMCAwIDEtNy43IDcuMTRMNS41IDIxLjlBOSA5IDAgMCAwIDEyIDIyWiIgZmlsbD0iIzM0YTg1MyIvPjxjaXJjbGUgY3g9IjEyIiBjeT0iMTIiIHI9IjQuNSIgZmlsbD0iIzQyODVmNCIvPjwvc3ZnPg==",
  // Brave — orange shield monogram.
  Brave:
    "data:image/svg+xml;base64,PHN2ZyB4bWxucz0iaHR0cDovL3d3dy53My5vcmcvMjAwMC9zdmciIHZpZXdCb3g9IjAgMCAyNCAyNCI+PHBhdGggZD0iTTEyIDIuNUw0IDUuNXY3YzAgNS41IDMuNSA4LjUgOCAxMCA0LjUtMS41IDgtNC41IDgtMTB2LTdMMTIgMi41WiIgZmlsbD0iI2ZiNTQyYiIvPjx0ZXh0IHg9IjEyIiB5PSIxNiIgdGV4dC1hbmNob3I9Im1pZGRsZSIgZm9udC1mYW1pbHk9Ii1hcHBsZS1zeXN0ZW0sc2Fucy1zZXJpZiIgZm9udC1zaXplPSIxMSIgZm9udC13ZWlnaHQ9IjcwMCIgZmlsbD0iI2ZmZmZmZiI+QjwvdGV4dD48L3N2Zz4=",
  // Firefox — orange flame ring + F.
  Firefox:
    "data:image/svg+xml;base64,PHN2ZyB4bWxucz0iaHR0cDovL3d3dy53My5vcmcvMjAwMC9zdmciIHZpZXdCb3g9IjAgMCAyNCAyNCI+PGNpcmNsZSBjeD0iMTIiIGN5PSIxMiIgcj0iMTAiIGZpbGw9IiNmZjcxMzkiLz48Y2lyY2xlIGN4PSIxMiIgY3k9IjEyIiByPSI3IiBmaWxsPSIjZmZjMTQxIi8+PHRleHQgeD0iMTIiIHk9IjE2IiB0ZXh0LWFuY2hvcj0ibWlkZGxlIiBmb250LWZhbWlseT0iLWFwcGxlLXN5c3RlbSxzYW5zLXNlcmlmIiBmb250LXNpemU9IjExIiBmb250LXdlaWdodD0iNzAwIiBmaWxsPSIjMjMyMTM1Ij5GPC90ZXh0Pjwvc3ZnPg==",
  // Edge — teal-to-blue gradient circle with "e".
  Edge:
    "data:image/svg+xml;base64,PHN2ZyB4bWxucz0iaHR0cDovL3d3dy53My5vcmcvMjAwMC9zdmciIHZpZXdCb3g9IjAgMCAyNCAyNCIgZmlsbD0ibm9uZSI+PGRlZnM+PGxpbmVhckdyYWRpZW50IGlkPSJlIiB4MT0iMCIgeTE9IjAiIHgyPSIxIiB5Mj0iMSI+PHN0b3Agb2Zmc2V0PSIwJSIgc3RvcC1jb2xvcj0iIzAwNzhENyIvPjxzdG9wIG9mZnNldD0iMTAwJSIgc3RvcC1jb2xvcj0iIzAwQkNGMiIvPjwvbGluZWFyR3JhZGllbnQ+PC9kZWZzPjxjaXJjbGUgY3g9IjEyIiBjeT0iMTIiIHI9IjEwIiBmaWxsPSJ1cmwoI2UpIi8+PHRleHQgeD0iMTIiIHk9IjE2IiB0ZXh0LWFuY2hvcj0ibWlkZGxlIiBmb250LWZhbWlseT0iLWFwcGxlLXN5c3RlbSxzYW5zLXNlcmlmIiBmb250LXNpemU9IjEwIiBmb250LXdlaWdodD0iNzAwIiBmaWxsPSIjZmZmZmZmIj5lPC90ZXh0Pjwvc3ZnPg==",
  // Safari — blue compass disc with red needle (rough). Useful when the
  // unsupported-browser banner needs to acknowledge the user's actual
  // browser instead of "your browser".
  Safari:
    "data:image/svg+xml;base64,PHN2ZyB4bWxucz0iaHR0cDovL3d3dy53My5vcmcvMjAwMC9zdmciIHZpZXdCb3g9IjAgMCAyNCAyNCI+PGNpcmNsZSBjeD0iMTIiIGN5PSIxMiIgcj0iMTAiIGZpbGw9IiMxNDkxZmYiLz48Y2lyY2xlIGN4PSIxMiIgY3k9IjEyIiByPSI3IiBmaWxsPSIjZmZmZmZmIi8+PHBvbHlnb24gcG9pbnRzPSIxMiw1IDEzLjUsMTIgMTIsMTIiIGZpbGw9IiNmZjQwM2IiLz48cG9seWdvbiBwb2ludHM9IjEyLDE5IDEwLjUsMTIgMTIsMTIiIGZpbGw9IiMyMjIyMjIiLz48L3N2Zz4=",
} as const;

/**
 * Annotated SVG diagram of the Phantom extension popup, with a green arrow
 * pointing at the account avatar in the top-left corner. Renders inline in
 * the modal so the user gets a picture-not-a-paragraph cue for where to
 * click. Approx 200×260 viewBox; the consuming component sets the rendered
 * size. Inlined as a constant (no asset file, no Safari load risk).
 */
export const PHANTOM_AVATAR_DIAGRAM = `
<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 200 260" fill="none">
  <defs>
    <linearGradient id="popup" x1="0" y1="0" x2="0" y2="1">
      <stop offset="0%" stop-color="#1a2236"/>
      <stop offset="100%" stop-color="#0a0e1a"/>
    </linearGradient>
  </defs>
  <rect x="8" y="8" width="184" height="244" rx="14" fill="url(#popup)" stroke="#2a3550" stroke-width="1.5"/>
  <!-- top bar with avatar in top-left -->
  <circle cx="28" cy="32" r="10" fill="#AB9FF2" stroke="#7e6dff" stroke-width="2"/>
  <text x="28" y="36" text-anchor="middle" font-family="-apple-system,sans-serif" font-size="10" font-weight="700" fill="#0a0e1a">S</text>
  <!-- network pill area -->
  <rect x="58" y="22" width="60" height="20" rx="10" fill="#2a3550"/>
  <text x="88" y="36" text-anchor="middle" font-family="-apple-system,sans-serif" font-size="9" fill="#94a3b8">Solana</text>
  <!-- balance area -->
  <text x="100" y="92" text-anchor="middle" font-family="-apple-system,sans-serif" font-size="22" font-weight="700" fill="#e2e8f0">0.00 SOL</text>
  <!-- action buttons row -->
  <rect x="24" y="116" width="36" height="36" rx="18" fill="#2a3550"/>
  <rect x="68" y="116" width="36" height="36" rx="18" fill="#2a3550"/>
  <rect x="112" y="116" width="36" height="36" rx="18" fill="#2a3550"/>
  <rect x="156" y="116" width="20" height="36" rx="10" fill="#2a3550" opacity="0.4"/>
  <!-- token list rows -->
  <rect x="24" y="176" width="152" height="20" rx="6" fill="#1f2942"/>
  <rect x="24" y="204" width="152" height="20" rx="6" fill="#1f2942"/>
  <!-- big green arrow + label pointing at avatar -->
  <path d="M 74 76 L 50 50" stroke="#3dd68c" stroke-width="3" fill="none" marker-end="url(#arrowhead)"/>
  <defs>
    <marker id="arrowhead" markerWidth="10" markerHeight="10" refX="6" refY="5" orient="auto" markerUnits="strokeWidth">
      <path d="M0,0 L0,10 L8,5 z" fill="#3dd68c"/>
    </marker>
  </defs>
  <rect x="74" y="68" width="118" height="22" rx="11" fill="#0a3d24" stroke="#3dd68c" stroke-width="1.5"/>
  <text x="133" y="83" text-anchor="middle" font-family="-apple-system,sans-serif" font-size="11" font-weight="700" fill="#3dd68c">click this circle</text>
</svg>
`.trim();
