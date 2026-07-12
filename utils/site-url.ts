/**
 * Returns the canonical site URL for use in auth redirect URLs.
 * Set NEXT_PUBLIC_SITE_URL in your environment (Vercel project settings + .env.local).
 */
export function getSiteUrl(): string {
  return (
    process.env.NEXT_PUBLIC_SITE_URL?.replace(/\/$/, "") ||
    "http://localhost:3000"
  );
}
