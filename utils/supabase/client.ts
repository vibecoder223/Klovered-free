import { createBrowserClient } from "@supabase/ssr";

// Guard lazily (inside the factory) rather than at module load. A top-level
// throw breaks `next build` in any env without these vars set — e.g. CI, which
// has no .env.local. The check still fires the moment a client is requested
// with bad config, so misconfiguration is never silent at runtime.
export const createClient = () => {
  const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const supabaseKey = process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY;
  if (!supabaseUrl || !supabaseKey) {
    throw new Error(
      "Supabase auth is not configured. Set NEXT_PUBLIC_SUPABASE_URL and NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY in .env.local."
    );
  }
  return createBrowserClient(supabaseUrl, supabaseKey);
};
