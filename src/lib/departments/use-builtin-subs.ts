'use client';

// Data sub-teams of built-in departments, for pickers that live far from the
// Payment Catalog (HR onboarding, Admin Roles). Reads the map off
// GET /api/departments, which already serves every elevated picker; a failed
// read yields {} so the caller falls back to the code teams — the
// pre-2026-09-22 behaviour. Cached per page load; one fetch for every consumer.

import { useEffect, useState } from 'react';
import type { BuiltinSubMap } from './builtin-subs';

let cache: BuiltinSubMap | null = null;
let inflight: Promise<BuiltinSubMap> | null = null;

async function load(): Promise<BuiltinSubMap> {
  if (cache) return cache;
  if (!inflight) {
    inflight = fetch('/api/departments', { cache: 'no-store' })
      .then((r) => (r.ok ? r.json() : null))
      .then((j) => {
        const m = j && typeof j.builtinSubs === 'object' && j.builtinSubs ? (j.builtinSubs as BuiltinSubMap) : {};
        cache = m;
        return m;
      })
      .catch(() => ({}) as BuiltinSubMap)
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
  const [map, setMap] = useState<BuiltinSubMap>(cache ?? {});
  useEffect(() => {
    let alive = true;
    void load().then((m) => {
      if (alive) setMap(m);
    });
    return () => {
      alive = false;
    };
  }, []);
  return map;
}
