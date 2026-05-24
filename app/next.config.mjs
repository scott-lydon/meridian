/** @type {import('next').NextConfig} */
const nextConfig = {
  reactStrictMode: true,
  poweredByHeader: false,
  // Force Webpack worker threads off until @solana/wallet-adapter resolves
  // Buffer + Node polyfills cleanly under Turbopack.
  experimental: {
    optimizePackageImports: ["@solana/wallet-adapter-react", "@tanstack/react-query"],
  },
  webpack: (config) => {
    config.resolve.fallback = { ...config.resolve.fallback, fs: false };
    config.externals.push("pino-pretty", "lokijs", "encoding");
    return config;
  },

  // Cache-Control overrides.
  //
  // Why this exists: Next 14 ships prerendered HTML with
  // `cache-control: s-maxage=31536000, stale-while-revalidate`. That cache
  // directive targets shared/edge caches (Cloudflare in front of Render),
  // but Safari's heuristic-freshness can pin the HTML in the browser cache
  // for hours regardless. The result is the user reloads after a deploy and
  // STILL sees the previous build's bundle references — exactly the
  // "I reloaded and the old modal is still there" failure that bit us
  // immediately after shipping the WalletPicker (commit b30e035).
  //
  // The fix is the standard SPA-shell pattern: tell the BROWSER never to
  // serve cached HTML without revalidating (`no-cache` means "you may
  // cache, but you must revalidate with the origin before using it"), and
  // keep the content-hashed `_next/static/*` chunks immutable for a year
  // (their URLs change on every build, so the year-long cache is safe).
  // The edge cache still benefits from `s-maxage` from Next's default; we
  // are only constraining the browser layer.
  async headers() {
    return [
      {
        // All page routes (HTML responses). Bypasses Next's default
        // s-maxage on dynamic and static pages alike. The `must-revalidate`
        // is belt-and-suspenders against intermediaries that ignore
        // `no-cache` semantically.
        source: "/((?!_next/static|_next/image|favicon.ico).*)",
        headers: [
          {
            key: "Cache-Control",
            value: "public, max-age=0, must-revalidate",
          },
        ],
      },
      {
        // Content-hashed Next static assets — safe to cache forever.
        source: "/_next/static/:path*",
        headers: [
          {
            key: "Cache-Control",
            value: "public, max-age=31536000, immutable",
          },
        ],
      },
    ];
  },
};

export default nextConfig;
