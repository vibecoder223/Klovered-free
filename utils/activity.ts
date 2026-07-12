import type { SupabaseClient } from "@supabase/supabase-js";

export async function logActivity(
  supabase: SupabaseClient,
  args: {
    org_id: string;
    user_id?: string | null;
    action: string;
    entity_type: string;
    entity_id: string;
    metadata?: Record<string, unknown>;
  }
) {
  await supabase.from("activity_log").insert(args);
}
