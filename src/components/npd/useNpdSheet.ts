'use client';

import { useCallback, useEffect, useRef, useState } from 'react';

import { NPD_COLUMNS, type NpdSheetKind } from '@/lib/npd/columns';
import { ensureSpareRows, trimTrailingBlankRows, type NpdRow } from '@/lib/npd/sheet';

/**
 * One NPD sheet (tab × pay week) on the client: load, local edits, undo/redo and
 * autosave. Governing doc: docs/features/npd-dashboard.md.
 *
 * Save model — the rules the doc names:
 *  - AUTOSAVE, debounced: SAVE_DEBOUNCE_MS after the last edit the whole sheet is
 *    PUT with the version it was loaded at. One request in flight per sheet;
 *    edits made meanwhile are saved by the next one.
 *  - A 409 STOPS autosave. Someone else saved this sheet; the editor chooses
 *    "Load theirs" (drop local edits) or "Keep mine" (save over theirs at their
 *    version — the route then audits every row of theirs it removes).
 *  - A failed save keeps the edits and says so; the next edit or Retry tries again.
 *    Nothing is reported saved that the server did not confirm.
 *  - A failed LOAD is an error, never an empty sheet (an empty grid invites
 *    pasting the week again over rows that are really there).
 *  - Each tab × week is a SESSION object that owns its rows, its version and its
 *    in-flight save. Switching week or leaving the page does not orphan unsaved
 *    edits: the old session finishes saving itself, and only the CURRENT session
 *    ever touches React state. The dashboard still `flush()`es before a switch so
 *    a failure is shown while the sheet is on screen.
 */

export const SAVE_DEBOUNCE_MS = 1200;
const UNDO_LIMIT = 50;

export type NpdMeta = { version: number; rowCount: number; updatedAt: string | null; updatedBy: string | null };
export type NpdConflict = { version: number; updatedBy: string | null; updatedAt: string | null };
export type LoadState = 'loading' | 'ready' | 'error' | 'missing';
export type SaveState = 'idle' | 'pending' | 'saving' | 'error' | 'conflict';

export function newRowId(): string {
  return crypto.randomUUID();
}

type Session = {
  sheet: NpdSheetKind;
  week: string;
  rows: NpdRow[];
  /** The rows the server last confirmed, by identity. Dirty = rows !== saved. */
  saved: NpdRow[] | null;
  meta: NpdMeta | null;
  inFlight: Promise<boolean> | null;
  timer: number | null;
  /** An unresolved conflict: no autosave until the editor chooses. */
  blocked: boolean;
  undo: NpdRow[][];
  redo: NpdRow[][];
};

const isDirty = (s: Session) => s.saved !== null && s.rows !== s.saved;

function clearTimer(s: Session) {
  if (s.timer != null) {
    window.clearTimeout(s.timer);
    s.timer = null;
  }
}

function metaFrom(j: Record<string, unknown>): NpdMeta {
  return {
    version: Number(j.version),
    rowCount: Number(j.rowCount),
    updatedAt: (j.updatedAt as string | null) ?? null,
    updatedBy: (j.updatedBy as string | null) ?? null,
  };
}

export function useNpdSheet(sheet: NpdSheetKind, week: string | null, canEdit: boolean) {
  const [loadState, setLoadState] = useState<LoadState>('loading');
  const [loadError, setLoadError] = useState<string | null>(null);
  const [rows, setRowsState] = useState<NpdRow[]>([]);
  const [meta, setMeta] = useState<NpdMeta | null>(null);
  const [saveState, setSaveState] = useState<SaveState>('idle');
  const [saveError, setSaveError] = useState<string | null>(null);
  const [conflict, setConflict] = useState<NpdConflict | null>(null);
  const [history, setHistory] = useState({ canUndo: false, canRedo: false });

  const sessionRef = useRef<Session | null>(null);
  const mountedRef = useRef(true);
  const canEditRef = useRef(canEdit);
  canEditRef.current = canEdit;

  /** React state follows the CURRENT session only. */
  const live = (s: Session) => mountedRef.current && sessionRef.current === s;

  const syncHistory = (s: Session) => {
    if (live(s)) setHistory({ canUndo: s.undo.length > 0, canRedo: s.redo.length > 0 });
  };

  // ── Save ────────────────────────────────────────────────────────────────
  const saveNow = useCallback((s: Session): Promise<boolean> => {
    clearTimer(s);
    if (s.inFlight) {
      // Once the current save lands, save whatever is newer.
      return s.inFlight.then(() => (isDirty(s) && !s.blocked ? saveNow(s) : !isDirty(s)));
    }
    if (!s.meta || !canEditRef.current || s.blocked) return Promise.resolve(!isDirty(s));
    if (!isDirty(s)) return Promise.resolve(true);

    const sent = s.rows;
    const body = {
      sheet: s.sheet,
      week: s.week,
      expectedVersion: s.meta.version,
      rows: trimTrailingBlankRows(sent).map((r) => ({ id: r.id, values: r.values })),
    };
    if (live(s)) setSaveState('saving');

    const run = (async (): Promise<boolean> => {
      try {
        const res = await fetch('/api/accounting/npd', {
          method: 'PUT',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(body),
        });
        const j = (await res.json().catch(() => ({}))) as Record<string, unknown>;
        if (res.status === 409) {
          s.blocked = true;
          if (live(s)) {
            setConflict({
              version: Number(j.version),
              updatedBy: (j.updatedBy as string | null) ?? null,
              updatedAt: (j.updatedAt as string | null) ?? null,
            });
            setSaveState('conflict');
          }
          return false;
        }
        if (!res.ok) {
          if (live(s)) {
            setSaveError(typeof j.error === 'string' ? j.error : `Save failed (${res.status})`);
            setSaveState('error');
          }
          return false;
        }
        s.meta = metaFrom(j);
        s.saved = sent;
        if (live(s)) {
          setMeta(s.meta);
          setSaveError(null);
          setSaveState(s.rows === sent ? 'idle' : 'pending');
        }
        return true;
      } catch (e) {
        if (live(s)) {
          setSaveError(e instanceof Error ? e.message : 'Save failed');
          setSaveState('error');
        }
        return false;
      }
    })();

    s.inFlight = run;
    return run
      .finally(() => {
        s.inFlight = null;
      })
      .then((ok) => {
        // Edits made while this save was in flight: the current sheet waits for
        // the debounce; a sheet already left behind saves them straight away.
        if (ok && isDirty(s) && !s.blocked) {
          if (live(s)) scheduleSave(s);
          else return saveNow(s);
        }
        return ok;
      });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const scheduleSave = useCallback((s: Session) => {
    if (!canEditRef.current || s.blocked) return;
    clearTimer(s);
    if (live(s)) setSaveState((st) => (st === 'saving' ? st : 'pending'));
    s.timer = window.setTimeout(() => {
      s.timer = null;
      void saveNow(s);
    }, SAVE_DEBOUNCE_MS);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [saveNow]);

  // ── Load ────────────────────────────────────────────────────────────────
  const load = useCallback(async (s: Session) => {
    if (!live(s)) return;
    setLoadState('loading');
    setLoadError(null);
    try {
      const res = await fetch(
        `/api/accounting/npd?sheet=${encodeURIComponent(s.sheet)}&week=${encodeURIComponent(s.week)}`,
        { cache: 'no-store' },
      );
      const j = (await res.json().catch(() => ({}))) as Record<string, unknown>;
      if (!live(s)) return;
      if (!res.ok) {
        setLoadError(typeof j.error === 'string' ? j.error : `Could not load the sheet (${res.status})`);
        setLoadState(j.missing === true ? 'missing' : 'error');
        return;
      }
      const loaded = (Array.isArray(j.rows) ? j.rows : []) as NpdRow[];
      const padded = ensureSpareRows(loaded, NPD_COLUMNS[s.sheet].length, newRowId);
      s.meta = metaFrom(j);
      s.rows = padded;
      s.saved = padded;
      s.undo = [];
      s.redo = [];
      s.blocked = false;
      setMeta(s.meta);
      setRowsState(padded);
      syncHistory(s);
      setConflict(null);
      setSaveError(null);
      setSaveState('idle');
      setLoadState('ready');
    } catch (e) {
      if (!live(s)) return;
      setLoadError(e instanceof Error ? e.message : 'Could not load the sheet');
      setLoadState('error');
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    mountedRef.current = true;
    if (!week) return;
    const s: Session = {
      sheet,
      week,
      rows: [],
      saved: null,
      meta: null,
      inFlight: null,
      timer: null,
      blocked: false,
      undo: [],
      redo: [],
    };
    sessionRef.current = s;
    setMeta(null);
    setRowsState([]);
    setConflict(null);
    setSaveError(null);
    setSaveState('idle');
    syncHistory(s);
    void load(s);
    return () => {
      // Leaving this sheet (another tab or week, or the page): unsaved edits
      // still go out, on this session, with this session's version.
      if (sessionRef.current === s) sessionRef.current = null;
      if (isDirty(s) && !s.blocked) void saveNow(s);
      else clearTimer(s);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sheet, week]);

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
    };
  }, []);

  // Closing the browser tab with edits the server has not confirmed.
  useEffect(() => {
    const onBeforeUnload = (e: BeforeUnloadEvent) => {
      const s = sessionRef.current;
      if (s && (isDirty(s) || s.inFlight)) {
        e.preventDefault();
        e.returnValue = '';
      }
    };
    window.addEventListener('beforeunload', onBeforeUnload);
    return () => window.removeEventListener('beforeunload', onBeforeUnload);
  }, []);

  // ── Edits ───────────────────────────────────────────────────────────────
  const apply = (s: Session, next: NpdRow[]) => {
    s.rows = next;
    setRowsState(next);
    syncHistory(s);
    scheduleSave(s);
  };

  const commit = useCallback((next: NpdRow[]) => {
    const s = sessionRef.current;
    if (!s || !s.meta || !canEditRef.current) return;
    s.undo.push(s.rows);
    if (s.undo.length > UNDO_LIMIT) s.undo.shift();
    s.redo = [];
    apply(s, ensureSpareRows(next, NPD_COLUMNS[s.sheet].length, newRowId));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const undo = useCallback(() => {
    const s = sessionRef.current;
    const prev = s?.undo.pop();
    if (!s || !prev || !canEditRef.current) return;
    s.redo.push(s.rows);
    apply(s, prev);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const redo = useCallback(() => {
    const s = sessionRef.current;
    const next = s?.redo.pop();
    if (!s || !next || !canEditRef.current) return;
    s.undo.push(s.rows);
    apply(s, next);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  /** Save now if anything is unsaved. Resolves false when the edits are NOT safely saved. */
  const flush = useCallback(async (): Promise<boolean> => {
    const s = sessionRef.current;
    if (!s) return true;
    if (s.blocked) return !isDirty(s);
    if (!isDirty(s) && !s.inFlight) return true;
    const ok = await saveNow(s);
    return ok && !isDirty(s);
  }, [saveNow]);

  const retrySave = useCallback(() => {
    const s = sessionRef.current;
    if (s) void saveNow(s);
  }, [saveNow]);

  const reload = useCallback(() => {
    const s = sessionRef.current;
    if (s) void load(s);
  }, [load]);

  /** Conflict → drop local edits and show what the server has. */
  const loadTheirs = useCallback(() => {
    const s = sessionRef.current;
    if (!s) return;
    clearTimer(s);
    s.blocked = false;
    void load(s);
  }, [load]);

  /** Conflict → save local rows over theirs, at their version. */
  const keepMine = useCallback(() => {
    const s = sessionRef.current;
    if (!s || !s.meta || !conflict) return;
    s.meta = { ...s.meta, version: conflict.version };
    s.blocked = false;
    setConflict(null);
    void saveNow(s);
  }, [conflict, saveNow]);

  return {
    loadState,
    loadError,
    rows,
    meta,
    saveState,
    saveError,
    conflict,
    canUndo: history.canUndo,
    canRedo: history.canRedo,
    commit,
    undo,
    redo,
    flush,
    retrySave,
    reload,
    loadTheirs,
    keepMine,
  };
}

export type NpdSheetController = ReturnType<typeof useNpdSheet>;
