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
};

export default nextConfig;
