'use client';

import { useEffect, useState } from 'react';
import { parseCollabEnabled } from '@/lib/collab/collab-settings';

const POLL_MS = 60_000;

/**
 * Reads an admin collab kill-switch (`collab.accounting.enabled` /
 * `collab.hr.enabled`) from app_settings. Plain HTTP poll, NOT a Supabase
 * Realtime channel — the whole point of this switch is to cut Realtime
 * message volume, so watching it must not add a channel of its own. Defaults
 * to enabled (today's behavior) until the first read lands and whenever a
 * read fails, so a network hiccup never silently kills collab for everyone.
 */
export function useCollabEnabled(key: string): boolean {
  const [enabled, setEnabled] = useState(true);

  useEffect(() => {
    let cancelled = false;
    const load = () => {
      fetch(`/api/app-settings?key=${encodeURIComponent(key)}`, { cache: 'no-store' })
        .then((r) => (r.ok ? r.json() : null))
        .then((j: { value: string | null } | null) => {
          if (!cancelled && j) setEnabled(parseCollabEnabled(j.value));
        })
        .catch(() => { /* keep last-known value */ });
    };
    load();
    const t = setInterval(load, POLL_MS);
    return () => {
      cancelled = true;
      clearInterval(t);
    };
  }, [key]);

  return enabled;
}
