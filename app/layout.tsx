import "./globals.css";

export const metadata = { title: "Klovered Free: answer any RFP" };

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <head>
        {/* Clash Display — the marketing site's wordmark face, so the tool's
            logo matches the landing page exactly. */}
        <link rel="preconnect" href="https://api.fontshare.com" crossOrigin="anonymous" />
        <link
          href="https://api.fontshare.com/v2/css?f[]=clash-display@600,700&display=swap"
          rel="stylesheet"
        />
        {/* Self-hosted, first-party analytics (Umami) — no cookie, no
            third-party request. No-op until NEXT_PUBLIC_UMAMI_WEBSITE_ID is
            set at build time (see docker-compose.stack.yml). A plain <script>
            tag, not next/script — Next's basePath (/app) only rewrites its
            own routing, not a literal src, and Umami is mounted at the domain
            root (/analytics), not under /app. */}
        {process.env.NEXT_PUBLIC_UMAMI_WEBSITE_ID && (
          <script
            defer
            src="/analytics/script.js"
            data-website-id={process.env.NEXT_PUBLIC_UMAMI_WEBSITE_ID}
          />
        )}
      </head>
      <body>{children}</body>
    </html>
  );
}
