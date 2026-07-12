import { cache } from "react";
import { cookies } from "next/headers";
import { createClient } from "@/utils/supabase/server";

// The subset of auth user fields this app reads. All of them live inside the
// access-token JWT, so they can be pulled from locally verified claims without
// a round-trip to the auth server.
export type SessionUser = {
  id: string;
  email: string;
  user_metadata: Record<string, any>;
};

// Verify the session locally via getClaims(): the JWT signature is checked
// against the project's public signing keys (JWKS, cached in-process) instead
// of calling the auth server — getUser() costs a ~300ms network round-trip on
// EVERY request. Expired sessions still refresh over the network as before.
export async function getClaimsUser(
  supabase: ReturnType<typeof createClient>
): Promise<SessionUser | null> {
  const { data } = await supabase.auth.getClaims();
  const claims = data?.claims;
  if (!claims?.sub) return null;
  return {
    id: claims.sub,
    email: (claims.email as string | undefined) ?? "",
    user_metadata: (claims.user_metadata as Record<string, any>) ?? {},
  };
}

// Free-tool variant: the app auto-provisions guests instead of redirecting to a
// login/onboarding page. So auth failures surface as thrown AuthErrors that API
// routes translate into JSON responses, never as navigation redirects.
export class AuthError extends Error {
  constructor(public status: number, msg: string) {
    super(msg);
    this.name = "AuthError";
  }
}

// cache() dedupes within a single server render — layout + page both call this,
// so without caching the auth check and the team_members query run twice per
// navigation. Cached, it runs once.
export const requireGuest = cache(async () => {
  const supabase = createClient(await cookies());
  const user = await getClaimsUser(supabase);
  if (!user) throw new AuthError(401, "No session");
  const { data: member } = await supabase
    .from("team_members")
    .select("id, org_id, role, name, email")
    .eq("user_id", user.id)
    .limit(1)
    .maybeSingle();
  if (!member) throw new AuthError(409, "Session not provisioned");
  return { user, supabase, member };
});
