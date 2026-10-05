'use client';

import { useSyncExternalStore } from 'react';

import type { NpdSheetKind } from '@/lib/npd/columns';
import { advanceLoadProgress, startLoadProgress, type NpdLoadEvent, type NpdLoadProgress } from '@/lib/npd/load-progress';
import { createNpdStreamAssembler } from '@/lib/npd/load-stream';
import { touchNpdSheetIndex, type NpdSheetPayload } from '@/lib/npd/npd-cache';
import type { NpdRow } from '@/lib/npd/sheet';
import { TAB_CACHE_KEYS, boundAccountingCacheIdentity, clearTabCache, getTabCache, setTabCache } from '@/lib/accounting/tab-cache';

/**
 * Reading NPD sheets, one tab × week at a time, OUTSIDE any component. Governing doc:
 * docs/features/npd-dashboard.md § Loading a sheet.
 *
 * Kane, 2026-10-05: "this should be separate from All department and HSL this way when we
 * switch tabs if its still loading it will have its own loading bar", and "lets add
 * caching on here as this is a very big volume of data".
 *
 *  - A read belongs to its tab × week, not to the component that started it. Switching
 *    tabs no longer throws a read away: it keeps going, its own progress keeps moving,
 *    and coming back JOINS it (the bar is where it got to, never restarted).
 *  - A finished read goes into the Accounting tab cache even when nobody is looking at
 *    that tab (server truth from a load: one of the three moments the cache may be
 *    written). So the other tab, read ahead of time by the dashboard, paints at once.
 *  - It is still only a picture there: the session that opens it reads it live again
 *    (`useNpdSheet`), unless a read is already in flight, which it joins. A read that has
 *    already finished is never taken as an open's live read.
 *  - A read is written to the cache only for the viewer it was started for.
 *  - Reads of a week no longer on screen are cancelled (`retainNpdSheetLoads`).
 *  - `fresh` (Try again, Load their version, after an unlock) never joins: it cancels any
 *    read in flight for that sheet and starts a new one, so it cannot return a copy read
 *    before whatever it is recovering from.
 */

export type NpdLoadOutcome =
  | { ok: true; payload: NpdSheetPayload }
  | { ok: false; error: string; missing: boolean; aborted: boolean };

type Entry = { controller: AbortController; promise: Promise<NpdLoadOutcome> };

const inflight = new Map<string, Entry>();
const progress = new Map<string, NpdLoadProgress>();
const listeners = new Set<() => void>();

export const npdLoadKey = (sheet: NpdSheetKind, week: string) => `${sheet}:${week}`;

function publish(key: string, p: NpdLoadProgress | null) {
  if (p) progress.set(key, p);
  else progress.delete(key);
  for (const fn of listeners) fn();
}

/** Move one sheet's progress on. A newer load of the same sheet owns the progress; an older one is ignored. */
export function advanceNpdLoad(key: string, loadId: number, e: NpdLoadEvent) {
  const p = progress.get(key);
  if (p && p.loadId === loadId) publish(key, advanceLoadProgress(p, e, performance.now()));
}

/** The card is finished with this load's progress (it faded out). */
export function clearNpdLoadProgress(key: string, loadId: number) {
  if (progress.get(key)?.loadId === loadId) publish(key, null);
}

export function getNpdLoadProgress(key: string): NpdLoadProgress | null {
  return progress.get(key) ?? null;
}

function subscribe(fn: () => void) {
  listeners.add(fn);
  return () => {
    listeners.delete(fn);
  };
}

/** One tab × week's progress, for its own card. */
export function useNpdLoadProgress(key: string | null): NpdLoadProgress | null {
  return useSyncExternalStore(
    subscribe,
    () => (key ? (progress.get(key) ?? null) : null),
    () => null,
  );
}

/**
 * THE one writer of a cached sheet (`TAB_CACHE_KEYS.npdSheet`). Called with server truth
 * only: a finished read (below), a confirmed save and a confirmed lock (useNpdSheet).
 * Keeps the most recently used sheets only.
 */
/** A sheet as server truth: the cached shape, but read-only rows are fine (they are copied). */
export type NpdSheetTruth = Omit<NpdSheetPayload, 'rows' | 'columnFormulas'> & {
  columnFormulas: Readonly<Record<string, string>>;
  rows: readonly NpdRow[];
};

export function writeNpdSheetCache(sheet: NpdSheetKind, week: string, payload: NpdSheetTruth) {
  const key = TAB_CACHE_KEYS.npdSheet(sheet, week);
  setTabCache(key, {
    ...payload,
    columnFormulas: { ...payload.columnFormulas },
    rows: payload.rows.map((r) => ({ id: r.id, values: [...r.values], overrides: [...r.overrides], formulas: { ...r.formulas } })),
  });
  const { keep, evict } = touchNpdSheetIndex(getTabCache(TAB_CACHE_KEYS.npdSheetIndex), key);
  for (const k of evict) clearTabCache(k);
  setTabCache(TAB_CACHE_KEYS.npdSheetIndex, keep);
}

/** The read is running in this browser (a load of this tab × week is in flight). */
export function isNpdSheetLoading(sheet: NpdSheetKind, week: string): boolean {
  return inflight.has(npdLoadKey(sheet, week));
}

/**
 * Read one sheet. Joins the read already in flight for it, unless `fresh`. Resolves with
 * the whole, re-checked sheet or a failure; never with part of one.
 */
export function loadNpdSheet(sheet: NpdSheetKind, week: string, opts: { fresh?: boolean } = {}): Promise<NpdLoadOutcome> {
  const key = npdLoadKey(sheet, week);
  const running = inflight.get(key);
  if (running && !opts.fresh) return running.promise;
  running?.controller.abort();

  const controller = new AbortController();
  const started = startLoadProgress(sheet, week, performance.now());
  publish(key, started);
  // The viewer this read is for. A swap mid-read (an ?email= preview) must not land this
  // sheet in the next viewer's cache.
  const identity = boundAccountingCacheIdentity();
  const promise = readStream(sheet, week, key, started.loadId, controller.signal).then((outcome) => {
    if (inflight.get(key)?.promise === promise) inflight.delete(key);
    if (outcome.ok) {
      if (identity !== null && boundAccountingCacheIdentity() === identity) writeNpdSheetCache(sheet, week, outcome.payload);
    } else if (!outcome.aborted) {
      advanceNpdLoad(key, started.loadId, { kind: 'failed', error: outcome.error });
    }
    return outcome;
  });
  inflight.set(key, { controller, promise });
  return promise;
}

/** Cancel every read except these tab × weeks (the week on screen, both tabs). */
export function retainNpdSheetLoads(keep: readonly string[]) {
  for (const [key, entry] of inflight) {
    if (keep.includes(key)) continue;
    entry.controller.abort();
    inflight.delete(key);
    publish(key, null);
  }
}

async function readStream(sheet: NpdSheetKind, week: string, key: string, loadId: number, signal: AbortSignal): Promise<NpdLoadOutcome> {
  const failed = (error: string, missing = false): NpdLoadOutcome => ({ ok: false, error, missing, aborted: false });
  try {
    const res = await fetch(`/api/accounting/npd?sheet=${encodeURIComponent(sheet)}&week=${encodeURIComponent(week)}`, {
      cache: 'no-store',
      signal,
    });
    if (!res.ok || !res.body) {
      // Refused before the stream started (access, a bad week, a missing table, a failed header read).
      const j = (await res.json().catch(() => ({}))) as Record<string, unknown>;
      return failed(typeof j.error === 'string' ? j.error : `Could not load the sheet (${res.status})`, j.missing === true);
    }
    const asm = createNpdStreamAssembler(sheet, week);
    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    let buffered = '';
    const take = (line: string) => {
      if (line.trim() === '') return;
      const e = asm.push(line);
      if (e && e.kind !== 'failed') advanceNpdLoad(key, loadId, e);
    };
    for (;;) {
      const { done, value } = await reader.read();
      if (value) buffered += decoder.decode(value, { stream: true });
      let nl = buffered.indexOf('\n');
      while (nl >= 0) {
        take(buffered.slice(0, nl));
        buffered = buffered.slice(nl + 1);
        nl = buffered.indexOf('\n');
      }
      if (asm.failed()) {
        void reader.cancel().catch(() => {});
        break;
      }
      if (done) break;
    }
    buffered += decoder.decode();
    take(buffered);
    const out = asm.finish();
    return out.ok ? { ok: true, payload: out.payload } : failed(out.error, out.missing);
  } catch (e) {
    if (signal.aborted) return { ok: false, error: 'Cancelled', missing: false, aborted: true };
    return failed(e instanceof Error ? e.message : 'Could not load the sheet');
  }
}
