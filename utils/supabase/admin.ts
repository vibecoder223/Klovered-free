import { createClient } from "@supabase/supabase-js";

export function hasServiceRole() {
  return !!process.env.SUPABASE_SERVICE_ROLE_KEY;
}

// Server-only admin client. Bypasses RLS — use sparingly inside trusted API routes
// for operations that strictly need elevated access. Returns null if the env var
// isn't configured, so callers can fall back to a user-context client.
export function tryCreateAdminClient() {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !key) return null;
  return createClient(url, key, {
    auth: { persistSession: false, autoRefreshToken: false },
  });
}

export function createAdminClient() {
  const admin = tryCreateAdminClient();
  if (!admin) {
    throw new Error(
      "SUPABASE_SERVICE_ROLE_KEY is not set — required for this operation."
    );
  }
  return admin;
}
