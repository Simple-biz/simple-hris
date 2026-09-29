import type { SupabaseClient } from '@supabase/supabase-js';

/**
 * ONE Realtime Broadcast channel per topic per page, shared by every listener.
 *
 * realtime-js returns the EXISTING channel for a repeated topic, so a surface
 * that opens its own `supabase.channel(topic)` and later `removeChannel`s it
 * tears the topic down for every other surface on the page. The PAB period hook
 * solved this for one topic (`joinPabPeriodLive`); this is the same shape keyed
 * by topic, for topics with many listeners per page (the KPI topic has up to
 * five on the Accounting shell alone).
 *
 * The listener receives the raw payload, or `null` for a catch-up after the
 * channel RE-subscribes — a drop can swallow a message, so every listener
 * re-reads when the socket comes back.
 */

type Listener = (payload: unknown) => void;

interface TopicEntry {
  event: string;
  listeners: Set<Listener>;
  teardown: (() => void) | null;
  pendingTeardown: ReturnType<typeof setTimeout> | null;
}

const topics = new Map<string, TopicEntry>();

export function joinSharedBroadcast(
  topic: string,
  event: string,
  listener: Listener,
  getClient: () => Pick<SupabaseClient, 'channel' | 'removeChannel'> | null,
): () => void {
  let entry = topics.get(topic);
  if (entry && entry.event !== event) {
    throw new Error(`[shared-broadcast] topic ${topic} is already joined for event ${entry.event}, not ${event}`);
  }
  if (!entry) {
    entry = { event, listeners: new Set(), teardown: null, pendingTeardown: null };
    topics.set(topic, entry);
  }
  const e = entry;
  e.listeners.add(listener);

  // An unmount→remount in the same tick (StrictMode, a tab remount) reuses the
  // still-open channel instead of racing the async removeChannel.
  if (e.pendingTeardown !== null) {
    clearTimeout(e.pendingTeardown);
    e.pendingTeardown = null;
  }

  if (!e.teardown) {
    const supabase = getClient();
    if (supabase) {
      const notifyAll = (payload: unknown) => {
        for (const l of e.listeners) l(payload);
      };
      let subscribedOnce = false;
      const channel = supabase
        .channel(topic)
        .on('broadcast', { event }, (msg: { payload?: unknown }) => notifyAll(msg?.payload ?? null));
      channel.subscribe((state: string) => {
        if (state !== 'SUBSCRIBED') return;
        if (subscribedOnce) notifyAll(null);
        subscribedOnce = true;
      });
      e.teardown = () => {
        void supabase.removeChannel(channel);
      };
    }
  }

  return () => {
    e.listeners.delete(listener);
    if (e.listeners.size > 0 || e.pendingTeardown !== null) return;
    if (!e.teardown) {
      topics.delete(topic);
      return;
    }
    e.pendingTeardown = setTimeout(() => {
      e.pendingTeardown = null;
      if (e.listeners.size === 0 && e.teardown) {
        e.teardown();
        e.teardown = null;
        topics.delete(topic);
      }
    }, 0);
  };
}

/** Test seam: how many listeners a topic has on this page right now. */
export function sharedBroadcastListenerCount(topic: string): number {
  return topics.get(topic)?.listeners.size ?? 0;
}
