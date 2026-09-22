'use client';

// Data sub-teams of built-in departments, for pickers that live far from the
// Payment Catalog (HR onboarding, Admin Roles). Reads the map off
// GET /api/departments, which already serves every elevated picker; a failed
// read yields {} so the caller falls back to the code teams — the
// pre-2026-09-22 behaviour. Cached per page load; one fetch for every consumer.

import { useEffect, useState } from 'react';
import type { BuiltinSubMap } from './builtin-subs';

/** A read that either produced the map or did not. `ok: false` NEVER means
 *  "no sub-departments" — see `useBuiltinSubsState`. */
export interface BuiltinSubsRead {
  map: BuiltinSubMap;
  ok: boolean;
}

let cache: BuiltinSubMap | null = null;
let inflight: Promise<BuiltinSubsRead> | null = null;

async function load(): Promise<BuiltinSubsRead> {
  if (cache) return { map: cache, ok: true };
  if (!inflight) {
    inflight = fetch('/api/departments', { cache: 'no-store' })
      .then((r) => (r.ok ? r.json() : null))
      .then((j): BuiltinSubsRead => {
        // A response that carries no `builtinSubs` object is a FAILED read, not an
        // empty map: the key is always present on a healthy reply, and a caller on
        // a money path must be able to tell the two apart.
        if (!j || typeof j.builtinSubs !== 'object' || !j.builtinSubs) return { map: {}, ok: false };
        const m = j.builtinSubs as BuiltinSubMap;
        cache = m;
        return { map: m, ok: true };
      })
      .catch((): BuiltinSubsRead => ({ map: {}, ok: false }))
      .finally(() => {
        inflight = null;
      });
  }
  return inflight;
}

/** Drop the cache so the next mount refetches (after an edit saves). */
export function invalidateBuiltinSubs(): void {
  cache = null;
}

export function useBuiltinSubs(): BuiltinSubMap {
  return useBuiltinSubsState().map;
}

/**
 * The map PLUS whether it is actually known.
 *
 * `useBuiltinSubs` degrades a failed read to `{}`, which reads as "this
 * department has no sub-teams" — harmless for a picker, a silent UNDERPAY on a
 * money path (the Payroll Wizard would pay the 14 code teams and quietly skip
 * every data branch). A caller that spends money must gate on `status`, never on
 * the emptiness of the map.
 *
 * `status`: `loading` until the first read settles, then `ready` or `error`.
 * `ready` with an empty map genuinely means no sub-departments exist.
 */
export function useBuiltinSubsState(): { map: BuiltinSubMap; status: 'loading' | 'ready' | 'error' } {
  const [state, setState] = useState<{ map: BuiltinSubMap; status: 'loading' | 'ready' | 'error' }>(
    cache ? { map: cache, status: 'ready' } : { map: {}, status: 'loading' },
  );
  useEffect(() => {
    let alive = true;
    void load().then((r) => {
      if (alive) setState({ map: r.map, status: r.ok ? 'ready' : 'error' });
    });
    return () => {
      alive = false;
    };
  }, []);
  return state;
}
