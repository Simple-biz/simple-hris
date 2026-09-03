import 'server-only';

import { createSupabaseServiceRoleClient } from '@/lib/supabase/server';

/**
 * Server-side Supabase Realtime Broadcast — the ONE push channel that reaches
 * the browser here. The browser client is `anon`; `payment_dispatches` has RLS
 * on with zero policies and `app_settings` is "Admins only" (verified against
 * the live catalog 2026-09-02), so `postgres_changes` on either never delivers
 * to a dashboard. Broadcast is a pub/sub bus that never touches a table or a
 * policy, so a message sent from the route that just wrote the row reaches
 * every subscriber — whatever build the PAYER's browser is running.
 *
 * Fire-and-forget by contract: never awaited on the request path, never
 * throws. A lost broadcast costs a few seconds (the subscribers all poll).
 */
export async function broadcastFromServer(
  topic: string,
  event: string,
  payload: Record<string, unknown>,
): Promise<boolean> {
  try {
    const sb = createSupabaseServiceRoleClient();
    if (!sb) return false;
    // Not subscribed → realtime-js posts to /realtime/v1/api/broadcast (REST).
    const channel = sb.channel(topic);
    const res = await channel.httpSend(event, payload, { timeout: 4000 });
    await sb.removeChannel(channel);
    if (!res.success) {
      // eslint-disable-next-line no-console
      console.warn(`[realtime-broadcast] ${topic}/${event} failed (${res.status})`);
    }
    return res.success;
  } catch (e) {
    // eslint-disable-next-line no-console
    console.warn(`[realtime-broadcast] ${topic}/${event} threw`, e);
    return false;
  }
}
