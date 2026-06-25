'use client';

import { createClient, type SupabaseClient } from '@supabase/supabase-js';

let cached: SupabaseClient | null | undefined;

/**
 * Browser-side Supabase client (anon key only — no service role).
 * Singleton: returns the same instance across calls so a single Realtime
 * websocket is shared. Returns `null` when env vars are missing.
 */
export function getSupabaseBrowserClient(): SupabaseClient | null {
  if (cached !== undefined) return cached;
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const key = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;
  if (!url || !key) {
    cached = null;
    return null;
  }
  cached = createClient(url, key, {
    auth: { persistSession: false, autoRefreshToken: false },
    // eventsPerSecond is the client's outbound broadcast rate CAP (a token
    // bucket — overflow is DROPPED, not queued). The old value of 5 silently
    // killed the screen-mirror: the cobrowse recorder streams a page's initial
    // rrweb snapshot as a burst of 28KB chunks (a heavy page like the Payroll
    // Wizard is dozens of chunks at once), and live cursors fire ~30–60/sec — so
    // at 5/sec most of those messages never left the sender and the CEO's live
    // view stayed stuck on "waiting for their screen". 100 gives ample headroom
    // for the snapshot burst + cursor stream; it's only a ceiling, so it never
    // increases traffic on its own.
    realtime: { params: { eventsPerSecond: 100 } },
  });
  return cached;
}
