'use client';

import { useCallback, useEffect, useRef } from 'react';
import { useSession } from 'next-auth/react';
import { toast } from 'sonner';
import { getSupabaseBrowserClient } from '@/lib/supabase/browser';
import { normEmail } from '@/lib/email/norm-email';
import { renderNotificationToast } from '@/components/notifications/NotificationToast';
import { playPingChime, playPingSent } from '@/lib/sound/ping-chime';
import { useSelfEmail } from '@/components/presence/PresenceProvider';

/**
 * Global, cross-dashboard "Ping" — a directed nudge from Admin's Global
 * Master List that lands wherever the recipient currently is (any dashboard,
 * any tab), instead of the existing Accounting/HR collaboration-layer Ping,
 * which only reaches someone already co-present in that one dashboard's room.
 *
 * Live-only by design (same trust/delivery model as the existing collab-layer
 * Ping): a single app-wide Realtime broadcast channel, nothing persisted. If
 * the recipient isn't connected at the moment it's sent, it's simply never
 * received — no history, no catch-up, no database change required.
 */
const ADMIN_PING_CHANNEL = 'hris-ping';

export interface AdminPingPayload {
  kind: 'ping';
  fromEmail: string;
  fromName: string | null;
  toEmail: string;
  text: string;
}

const TOAST_ID = 'admin-ping';

/**
 * Receiver half. Mounted once at the app root (alongside PresenceProvider /
 * SessionInvalidationWatcher) so a ping shows a toast + chime no matter which
 * dashboard the recipient is currently looking at.
 */
export default function GlobalPingListener() {
  const selfEmail = useSelfEmail();
  const normSelf = selfEmail ? normEmail(selfEmail) ?? selfEmail.trim().toLowerCase() : null;
  const normSelfRef = useRef(normSelf);
  normSelfRef.current = normSelf;

  useEffect(() => {
    if (!normSelf) return;
    const supabase = getSupabaseBrowserClient();
    if (!supabase) return;

    const channel = supabase.channel(ADMIN_PING_CHANNEL, {
      config: { broadcast: { self: false } },
    });

    channel
      .on('broadcast', { event: 'ping' }, ({ payload }: { payload: AdminPingPayload }) => {
        if (!payload || payload.kind !== 'ping') return;
        const to = payload.toEmail ? normEmail(payload.toEmail) ?? payload.toEmail.trim().toLowerCase() : null;
        if (!to || to !== normSelfRef.current) return;
        const from = payload.fromName?.trim() || payload.fromEmail;
        toast.custom(
          (id) =>
            renderNotificationToast({
              id,
              title: `Message from ${from}`,
              message: payload.text,
            }),
          { id: TOAST_ID, duration: 10_000, position: 'top-right', unstyled: true },
        );
        playPingChime();
      })
      .subscribe();

    return () => {
      void supabase.removeChannel(channel);
    };
  }, [normSelf]);

  return null;
}

/**
 * Sender half. Call once from the Admin Global Master List tab — returns a
 * stable `sendPing(toEmail, text)` you can call per-row. Keeps one subscribed
 * channel open for the component's lifetime rather than reconnecting per send.
 */
export function useAdminPingSender(): (toEmail: string, text: string) => void {
  const { data: session } = useSession();
  const selfEmail = useSelfEmail();
  const selfName = session?.user?.name ?? null;
  const selfRef = useRef({ email: selfEmail, name: selfName });
  selfRef.current = { email: selfEmail, name: selfName };

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const channelRef = useRef<any>(null);
  const readyRef = useRef(false);

  useEffect(() => {
    const supabase = getSupabaseBrowserClient();
    if (!supabase) return;
    const channel = supabase.channel(ADMIN_PING_CHANNEL, {
      config: { broadcast: { self: false } },
    });
    channelRef.current = channel;
    channel.subscribe((status: string) => {
      readyRef.current = status === 'SUBSCRIBED';
    });
    return () => {
      readyRef.current = false;
      channelRef.current = null;
      void supabase.removeChannel(channel);
    };
  }, []);

  return useCallback((toEmail: string, text: string) => {
    const channel = channelRef.current;
    const { email, name } = selfRef.current;
    const from = email ? normEmail(email) ?? email.trim().toLowerCase() : null;
    const to = normEmail(toEmail) ?? toEmail.trim().toLowerCase();
    if (!channel || !readyRef.current || !from || !to) return;
    void channel.send({
      type: 'broadcast',
      event: 'ping',
      payload: {
        kind: 'ping',
        fromEmail: from,
        fromName: name,
        toEmail: to,
        text,
      } satisfies AdminPingPayload,
    });
    playPingSent();
  }, []);
}
