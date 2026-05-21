import type { Metadata } from "next";
import { Inter, JetBrains_Mono } from "next/font/google";
import "./globals.css";

import { MeridianProviders } from "@/components/WalletProvider";
import { Header } from "@/components/Header";

const inter = Inter({
  subsets: ["latin"],
  variable: "--font-inter",
  display: "swap",
});

const mono = JetBrains_Mono({
  subsets: ["latin"],
  variable: "--font-jetbrains-mono",
  display: "swap",
});

export const metadata: Metadata = {
  title: "Meridian — Binary Stock Outcome Markets",
  description:
    "Non-custodial binary outcome markets on whether MAG7 stocks close above a strike today. On Solana devnet.",
  metadataBase: new URL("https://meridian.example"),
  openGraph: {
    title: "Meridian",
    description: "Binary stock outcome markets on Solana",
    type: "website",
  },
};

export default function RootLayout({
  children,
}: {
  readonly children: React.ReactNode;
}) {
  return (
    <html lang="en" className={`${inter.variable} ${mono.variable}`}>
      <body className="min-h-screen bg-bg font-sans text-text antialiased">
        <MeridianProviders>
          <Header />
          {children}
        </MeridianProviders>
      </body>
    </html>
  );
}
