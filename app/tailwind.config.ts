import type { Config } from "tailwindcss";

const config: Config = {
  content: ["./src/**/*.{ts,tsx}"],
  darkMode: "class",
  theme: {
    extend: {
      colors: {
        bg: "#0a0e1a",
        panel: "#1a2236",
        accent: "#6366f1",
        accentHover: "#818cf8",
        muted: "#94a3b8",
        text: "#e2e8f0",
        yes: "#10b981",
        no: "#ef4444",
      },
      fontFamily: {
        sans: ["var(--font-inter)", "ui-sans-serif", "system-ui"],
        mono: ["var(--font-jetbrains-mono)", "ui-monospace", "SFMono-Regular"],
      },
    },
  },
  plugins: [],
};

export default config;
