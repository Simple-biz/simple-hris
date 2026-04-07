import { createClient, type SupabaseClient } from "@supabase/supabase-js";

/**
 * Browser Supabase client (uses public anon key).
 * Prefer `/api/*` routes for server-side reads when you want to avoid exposing query logic.
 */
let browserClient: SupabaseClient | null = null;

export function getSupabaseBrowserClient(): SupabaseClient | null {
  if (typeof window === "undefined") return null;
  if (browserClient) return browserClient;
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const key = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;
  if (!url || !key) return null;
  browserClient = createClient(url, key);
  return browserClient;
}
