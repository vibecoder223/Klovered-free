import type { Config } from "tailwindcss";

const config: Config = {
  content: [
    "./app/**/*.{js,ts,jsx,tsx,mdx}",
    "./components/**/*.{js,ts,jsx,tsx,mdx}",
  ],
  theme: {
    extend: {
      colors: {
        // These reference the CSS variables in app/globals.css (BRAND.md
        // "Green" system) so Tailwind utilities and the app's own tokens can
        // never drift apart again.
        bg: "var(--bg)",
        "bg-2": "var(--bg-2)",
        surface: "var(--surface)",
        border: "var(--border)",
        "border-strong": "var(--border-strong)",
        divider: "var(--divider)",
        fg: "var(--fg)",
        "fg-2": "var(--fg-2)",
        "fg-3": "var(--fg-3)",
        "fg-4": "var(--fg-4)",
        "fg-5": "var(--fg-5)",
        accent: "var(--accent)",
        "accent-2": "var(--accent-2)",
        "accent-tint": "var(--accent-tint)",
        "accent-line": "var(--accent-line)",
        ok: "var(--ok)",
        "ok-tint": "var(--ok-tint)",
        warn: "var(--warn)",
        "warn-tint": "var(--warn-tint)",
        err: "var(--err)",
        "err-tint": "var(--err-tint)",
      },
      fontFamily: {
        sans: [
          "Geist",
          "-apple-system",
          "BlinkMacSystemFont",
          "SF Pro Text",
          "system-ui",
          "sans-serif",
        ],
        mono: ["Geist Mono", "ui-monospace", "SF Mono", "Menlo", "monospace"],
      },
      borderRadius: {
        xs: "4px",
        sm: "6px",
        md: "8px",
        lg: "12px",
      },
      boxShadow: {
        s1: "0 1px 2px rgba(15,22,38,0.04), 0 0 0 1px rgba(15,22,38,0.02)",
        s2: "0 4px 14px rgba(15,22,38,0.06), 0 1px 2px rgba(15,22,38,0.04)",
        s3: "0 16px 40px rgba(15,22,38,0.10), 0 2px 6px rgba(15,22,38,0.05)",
      },
    },
  },
  plugins: [],
};
export default config;
