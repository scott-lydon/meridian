"use client";

import Link from "next/link";
import { ConnectButton } from "@/components/ConnectButton";
import { cluster } from "@/lib/cluster";

const nav = [
  { href: "/", label: "Home" },
  { href: "/markets", label: "Markets" },
  { href: "/portfolio", label: "Portfolio" },
  { href: "/history", label: "History" },
  { href: "/audit", label: "Audit" },
  { href: "/architecture", label: "Architecture" },
];

export function Header() {
  return (
    <header className="sticky top-0 z-20 border-b border-panel bg-bg/80 backdrop-blur-md">
      <div className="mx-auto flex max-w-6xl items-center justify-between gap-4 px-6 py-3">
        <div className="flex items-center gap-6">
          <Link href="/" className="text-lg font-semibold tracking-tight">
            <span className="font-mono text-accent">M</span>eridian
          </Link>
          <nav className="hidden gap-4 text-sm text-muted sm:flex">
            {nav.map((n) => (
              <Link key={n.href} href={n.href} className="hover:text-text">
                {n.label}
              </Link>
            ))}
          </nav>
        </div>
        <div className="flex items-center gap-3">
          <span
            className={`rounded-full px-2 py-0.5 text-xs uppercase tracking-wider ${
              cluster.name === "mainnet"
                ? "bg-no/20 text-no"
                : "bg-panel text-muted"
            }`}
            title={cluster.rpcUrl}
          >
            {cluster.name}
          </span>
          <ConnectButton />
        </div>
      </div>
    </header>
  );
}
