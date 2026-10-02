'use client';

import { useCallback, useEffect, useRef, useState } from 'react';

import { NPD_COLUMNS, type NpdSheetKind } from '@/lib/npd/columns';
import {
  applyFormulasToEdit,
  defaultFormula,
  formulaBehind,
  parseUsdPerPhp,
  recomputeAfterSettingsChange,
  recomputeRow,
  recomputeSheet,
  toStoredFormula,
  type NpdFormulaContext,
} from '@/lib/npd/formulas';
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
 *  - LOCK IN: a locked sheet (meta.lockedAt) takes no edit and no save. `lock()`
 *    saves pending edits first and locks the version on screen; a 409 there is the
 *    same conflict as a save's (someone saved after you opened it). A save the
 *    server refuses with 423 (someone locked it meanwhile) keeps the edits on
 *    screen, UNSAVED, and says so. `unlock(reason)` reloads the sheet afterwards,
 *    so nothing typed before the lock is saved without being seen again.
 *  - FORMULAS: every edit goes through formulas.ts `applyFormulasToEdit` (typing
 *    `=…` makes a cell's own formula; a different figure in a formula cell is a
 *    typed value over it; blank gives it back to the formula). The rate and the
 *    column formulas are part of the sheet: saved with it, undone with it (an undo
 *    step is rows AND settings together), and never carried over from another
 *    week. The server recalculates every formula cell on save, with the same module.
 *  - GOOGLE SHEET SYNC (`importSheet`): the rows a sync fetched REPLACE the target
 *    tab × week — rows, rate, and the column formulas reset to the Google Sheet's —
 *    as one undo step, saved at once through the normal save (so the removed-rows
 *    audit, the lock and the version check all apply). It waits for that sheet to
 *    load, and is DROPPED (never applied later) if the sheet is left first.
 */

export const SAVE_DEBOUNCE_MS = 1200;
const UNDO_LIMIT = 50;

export type NpdMeta = {
  version: number;
  rowCount: number;
  updatedAt: string | null;
  updatedBy: string | null;
  lockedAt: string | null;
  lockedBy: string | null;
};
export type NpdConflict = { version: number; updatedBy: string | null; updatedAt: string | null };
export type LoadState = 'loading' | 'ready' | 'error' | 'missing';
/** `locked` = a save the server refused because the sheet was locked meanwhile. */
export type SaveState = 'idle' | 'pending' | 'saving' | 'error' | 'conflict' | 'locked';
export type LockResult = { ok: boolean; message?: string };
/** What a Google Sheet sync puts on a sheet (from GET /api/accounting/npd/google-sheet). */
export type NpdImportPayload = {
  readonly rows: ReadonlyArray<{ readonly values: readonly string[]; readonly overrides: readonly string[] }>;
  readonly rateText: string;
  /** The Google Sheet tab and the wizard upload it was synced for: sent with the save, stamped by the server. */
  readonly tab: string;
  readonly sourceFile: string | null;
};
/** A sync whose save landed: the server's timestamp. */
export type NpdSyncStamp = { sheet: NpdSheetKind; week: string; at: string; by: string; tab: string };
type SyncTag = { tab: string; sourceFile: string | null };
/** The sheet's formula settings. Replaced (never mutated) on change, so identity = dirty. */
export type NpdSettings = { readonly rateText: string; readonly columnFormulas: Readonly<Record<string, string>> };
const NO_SETTINGS: NpdSettings = { rateText: '', columnFormulas: {} };
type Snapshot = { rows: NpdRow[]; settings: NpdSettings };

export function contextOf(settings: NpdSettings): NpdFormulaContext {
  const rate = parseUsdPerPhp(settings.rateText);
  return { columnFormulas: settings.columnFormulas, rate: rate.ok ? rate.rate : null };
}

export function newRowId(): string {
  return crypto.randomUUID();
}

type Session = {
  sheet: NpdSheetKind;
  week: string;
  rows: NpdRow[];
  /** The rows the server last confirmed, by identity. Dirty = rows !== saved (or settings). */
  saved: NpdRow[] | null;
  settings: NpdSettings;
  savedSettings: NpdSettings | null;
  meta: NpdMeta | null;
  inFlight: Promise<boolean> | null;
  timer: number | null;
  /** An unresolved conflict: no autosave until the editor chooses. */
  blocked: boolean;
  /** A Google Sheet sync not saved yet: the next save carries it, and the server stamps its time. */
  syncTag: SyncTag | null;
  undo: Snapshot[];
  redo: Snapshot[];
};

const keyOf = (sheet: NpdSheetKind, week: string) => `${sheet}:${week}`;
type PendingImport = { key: string; payload: NpdImportPayload; resolve: (r: LockResult) => void };

const isDirty = (s: Session) => s.saved !== null && (s.rows !== s.saved || s.settings !== s.savedSettings);
const isLocked = (s: Session) => !!s.meta?.lockedAt;

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
    lockedAt: (j.lockedAt as string | null) ?? null,
    lockedBy: (j.lockedBy as string | null) ?? null,
  };
}

async function patchLock(body: Record<string, unknown>): Promise<{ status: number; ok: boolean; j: Record<string, unknown> }> {
  try {
    const res = await fetch('/api/accounting/npd', {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
    const j = (await res.json().catch(() => ({}))) as Record<string, unknown>;
    return { status: res.status, ok: res.ok, j };
  } catch (e) {
    return { status: 0, ok: false, j: { error: e instanceof Error ? e.message : 'Request failed' } };
  }
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
  const [settings, setSettingsState] = useState<NpdSettings>(NO_SETTINGS);
  const [syncStamp, setSyncStamp] = useState<NpdSyncStamp | null>(null);

  const sessionRef = useRef<Session | null>(null);
  const pendingImportRef = useRef<PendingImport | null>(null);
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
    if (!s.meta || !canEditRef.current || s.blocked || isLocked(s)) return Promise.resolve(!isDirty(s));
    if (!isDirty(s)) return Promise.resolve(true);

    const sent = s.rows;
    const sentSettings = s.settings;
    const sentTag = s.syncTag;
    const body = {
      ...(sentTag ? { googleSheetSync: sentTag } : {}),
      sheet: s.sheet,
      week: s.week,
      expectedVersion: s.meta.version,
      usdPerPhp: sentSettings.rateText.trim() === '' ? null : sentSettings.rateText.trim(),
      columnFormulas: sentSettings.columnFormulas,
      rows: trimTrailingBlankRows(sent).map((r) => ({ id: r.id, values: r.values, overrides: r.overrides, formulas: r.formulas })),
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
        if (res.status === 423) {
          // Locked in by someone while these edits were waiting. They are NOT saved.
          s.blocked = true;
          s.meta = {
            ...s.meta!,
            lockedAt: (j.lockedAt as string | null) ?? new Date().toISOString(),
            lockedBy: (j.lockedBy as string | null) ?? null,
          };
          if (live(s)) {
            setMeta(s.meta);
            setSaveState('locked');
          }
          return false;
        }
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
        s.savedSettings = sentSettings;
        if (sentTag && s.syncTag === sentTag) {
          s.syncTag = null;
          if (typeof j.syncedAt === 'string') {
            setSyncStamp({ sheet: s.sheet, week: s.week, at: j.syncedAt, by: String(j.syncedBy ?? ''), tab: sentTag.tab });
          }
        }
        if (live(s)) {
          setMeta(s.meta);
          setSaveError(null);
          setSaveState(s.rows === sent && s.settings === sentSettings ? 'idle' : 'pending');
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
    if (!canEditRef.current || s.blocked || isLocked(s)) return;
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
        settlePendingImport(s, { ok: false, message: 'The sheet could not be loaded, so nothing from the Google Sheet was put on it.' });
        return;
      }
      const loaded = ((Array.isArray(j.rows) ? j.rows : []) as Partial<NpdRow>[]).map((r) => ({
        id: String(r.id),
        values: (r.values ?? []) as string[],
        overrides: Array.isArray(r.overrides) ? r.overrides : [],
        formulas: r.formulas && typeof r.formulas === 'object' ? r.formulas : {},
      }));
      const padded = ensureSpareRows(loaded, NPD_COLUMNS[s.sheet].length, newRowId);
      s.meta = metaFrom(j);
      s.rows = padded;
      s.saved = padded;
      s.settings = {
        rateText: j.usdPerPhp === null || j.usdPerPhp === undefined ? '' : String(j.usdPerPhp),
        columnFormulas:
          j.columnFormulas && typeof j.columnFormulas === 'object' ? (j.columnFormulas as Record<string, string>) : {},
      };
      s.savedSettings = s.settings;
      setSettingsState(s.settings);
      s.undo = [];
      s.redo = [];
      s.blocked = false;
      s.syncTag = null;
      setMeta(s.meta);
      setRowsState(padded);
      syncHistory(s);
      setConflict(null);
      setSaveError(null);
      setSaveState('idle');
      setLoadState('ready');
      const pending = pendingImportRef.current;
      if (pending && pending.key === keyOf(s.sheet, s.week)) {
        pendingImportRef.current = null;
        pending.resolve(applyImport(s, pending.payload));
      }
    } catch (e) {
      if (!live(s)) return;
      setLoadError(e instanceof Error ? e.message : 'Could not load the sheet');
      setLoadState('error');
      settlePendingImport(s, { ok: false, message: 'The sheet could not be loaded, so nothing from the Google Sheet was put on it.' });
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
      settings: NO_SETTINGS,
      savedSettings: null,
      meta: null,
      inFlight: null,
      timer: null,
      blocked: false,
      syncTag: null,
      undo: [],
      redo: [],
    };
    sessionRef.current = s;
    // A sync waiting for ANOTHER sheet is dropped: it must never land later, unseen.
    const pending = pendingImportRef.current;
    if (pending && pending.key !== keyOf(sheet, week)) {
      pendingImportRef.current = null;
      pending.resolve({ ok: false, message: 'You moved to another sheet before the Google Sheet rows were put on it, so nothing was changed.' });
    }
    setMeta(null);
    setRowsState([]);
    setSettingsState(NO_SETTINGS);
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
      const pending = pendingImportRef.current;
      pendingImportRef.current = null;
      pending?.resolve({ ok: false, message: 'The page was closed before the Google Sheet rows were put on the sheet.' });
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
  const apply = (s: Session, next: NpdRow[], nextSettings: NpdSettings = s.settings) => {
    s.rows = next;
    s.settings = nextSettings;
    setRowsState(next);
    setSettingsState(nextSettings);
    syncHistory(s);
    scheduleSave(s);
  };

  /** The session an edit may touch, or null (none, not loaded, view-only, locked). */
  const editable = (): Session | null => {
    const s = sessionRef.current;
    if (!s || !s.meta || !canEditRef.current || isLocked(s)) return null;
    return s;
  };

  const pushUndo = (s: Session) => {
    s.undo.push({ rows: s.rows, settings: s.settings });
    if (s.undo.length > UNDO_LIMIT) s.undo.shift();
    s.redo = [];
  };

  const commit = useCallback((next: NpdRow[]) => {
    const s = editable();
    if (!s) return;
    const withFormulas = applyFormulasToEdit(s.sheet, s.rows, next, contextOf(s.settings));
    pushUndo(s);
    apply(s, ensureSpareRows(withFormulas, NPD_COLUMNS[s.sheet].length, newRowId));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const undo = useCallback(() => {
    const s = editable();
    const prev = s?.undo.pop();
    if (!s || !prev) return;
    // Undoing a sync before it saved: what saves next is not the Google Sheet's.
    s.syncTag = null;
    s.redo.push({ rows: s.rows, settings: s.settings });
    apply(s, prev.rows, prev.settings);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const redo = useCallback(() => {
    const s = editable();
    const next = s?.redo.pop();
    if (!s || !next) return;
    s.undo.push({ rows: s.rows, settings: s.settings });
    apply(s, next.rows, next.settings);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // ── Formula settings ────────────────────────────────────────────────────

  /** Type this sheet's PHP→USD rate. Returns an error message, or null when applied. */
  const setRate = useCallback((text: string): string | null => {
    const s = editable();
    if (!s) return 'This sheet cannot be changed.';
    const parsed = parseUsdPerPhp(text);
    if (!parsed.ok) return parsed.error;
    const rateText = text.trim();
    if (rateText === s.settings.rateText) return null;
    const nextSettings: NpdSettings = { ...s.settings, rateText };
    pushUndo(s);
    apply(s, recomputeAfterSettingsChange(s.sheet, s.rows, contextOf(nextSettings)), nextSettings);
    return null;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  /**
   * One cell's own formula, typed as the sheet shows it (`=H5*1.5`). Empty removes
   * the cell's own formula. Returns an error message, or null when applied.
   */
  const setCellFormula = useCallback((rowIndex: number, key: string, typed: string): string | null => {
    const s = editable();
    const row = s?.rows[rowIndex];
    if (!s || !row) return 'This sheet cannot be changed.';
    const ctx = contextOf(s.settings);
    const formulas = { ...row.formulas };
    if (typed.trim() === '') delete formulas[key];
    else {
      let stored: string;
      try {
        stored = toStoredFormula(typed, rowIndex + 1, NPD_COLUMNS[s.sheet]);
      } catch (e) {
        return e instanceof Error ? e.message : 'Unreadable formula.';
      }
      // The same as the column's formula: no need for an own copy.
      const { [key]: _own, ...rest } = formulas;
      void _own;
      if (formulaBehind(s.sheet, { formulas: rest }, key, ctx)?.formula === stored) delete formulas[key];
      else formulas[key] = stored;
    }
    const nextRow = recomputeRow(s.sheet, { ...row, formulas, overrides: row.overrides.filter((k) => k !== key) }, ctx);
    const next = [...s.rows];
    next[rowIndex] = nextRow;
    pushUndo(s);
    apply(s, ensureSpareRows(next, NPD_COLUMNS[s.sheet].length, newRowId));
    return null;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  /**
   * The whole column's formula on THIS sheet (the sheet's "fill down"): typed as in
   * row `rowIndex`. Every cell in the column follows it — its own formulas and typed
   * values are replaced. `''` means "no formula in this column"; `null` resets the
   * column to the Google Sheet's formula. Returns an error message, or null.
   */
  const setColumnFormula = useCallback((key: string, typed: string | null, rowIndex: number): string | null => {
    const s = editable();
    if (!s) return 'This sheet cannot be changed.';
    const columnFormulas = { ...s.settings.columnFormulas };
    if (typed === null) delete columnFormulas[key];
    else if (typed.trim() === '') columnFormulas[key] = '';
    else {
      let stored: string;
      try {
        stored = toStoredFormula(typed, rowIndex + 1, NPD_COLUMNS[s.sheet]);
      } catch (e) {
        return e instanceof Error ? e.message : 'Unreadable formula.';
      }
      if (stored === defaultFormula(s.sheet, key)) delete columnFormulas[key];
      else columnFormulas[key] = stored;
    }
    const nextSettings: NpdSettings = { ...s.settings, columnFormulas };
    const cleared = s.rows.map((r) => {
      if (!(key in r.formulas) && !r.overrides.includes(key)) return r;
      const { [key]: _drop, ...formulas } = r.formulas;
      void _drop;
      return { ...r, formulas, overrides: r.overrides.filter((k) => k !== key) };
    });
    pushUndo(s);
    apply(s, recomputeSheet(s.sheet, cleared, contextOf(nextSettings)), nextSettings);
    return null;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  /** Give a typed-over cell back to its formula. */
  const useFormulaAgain = useCallback((rowIndex: number, key: string) => {
    const s = editable();
    const row = s?.rows[rowIndex];
    if (!s || !row || !row.overrides.includes(key)) return;
    const next = [...s.rows];
    next[rowIndex] = recomputeRow(s.sheet, { ...row, overrides: row.overrides.filter((k) => k !== key) }, contextOf(s.settings));
    pushUndo(s);
    apply(s, next);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // ── Google Sheet sync ───────────────────────────────────────────────────

  /** A failed load of the sheet a sync is waiting for ends that sync. */
  const settlePendingImport = (s: Session, r: LockResult) => {
    const pending = pendingImportRef.current;
    if (pending && pending.key === keyOf(s.sheet, s.week)) {
      pendingImportRef.current = null;
      pending.resolve(r);
    }
  };

  /** Replace a loaded sheet with the synced rows: one undo step, saved straight away. */
  const applyImport = (s: Session, payload: NpdImportPayload): LockResult => {
    if (!canEditRef.current) return { ok: false, message: 'You can view this sheet but not change it.' };
    if (isLocked(s)) return { ok: false, message: 'This sheet is locked in, so nothing was changed. Unlock it first.' };
    if (s.blocked) return { ok: false, message: 'Resolve the message above first; nothing was changed.' };
    const settings: NpdSettings = { rateText: payload.rateText, columnFormulas: {} };
    const width = NPD_COLUMNS[s.sheet].length;
    const rows: NpdRow[] = payload.rows.map((r) => ({
      id: newRowId(),
      values: Array.from({ length: width }, (_, i) => r.values[i] ?? ''),
      overrides: [...r.overrides],
      formulas: {},
    }));
    pushUndo(s);
    s.syncTag = { tab: payload.tab, sourceFile: payload.sourceFile };
    apply(s, ensureSpareRows(recomputeSheet(s.sheet, rows, contextOf(settings)), width, newRowId), settings);
    void saveNow(s);
    return { ok: true };
  };

  /**
   * Put a sync's rows on `target`. Applied now when that sheet is the one loaded;
   * otherwise when it finishes loading (the dashboard switches to it first). A
   * newer sync, leaving that sheet, or closing the page ends the wait with
   * nothing changed.
   */
  const importSheet = useCallback(
    (target: { sheet: NpdSheetKind; week: string }, payload: NpdImportPayload): Promise<LockResult> => {
      const key = keyOf(target.sheet, target.week);
      const earlier = pendingImportRef.current;
      pendingImportRef.current = null;
      earlier?.resolve({ ok: false, message: 'A newer sync replaced this one.' });
      const s = sessionRef.current;
      if (s && keyOf(s.sheet, s.week) === key && s.meta) return Promise.resolve(applyImport(s, payload));
      return new Promise<LockResult>((resolve) => {
        pendingImportRef.current = { key, payload, resolve };
      });
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [],
  );

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

  /** Lock in the sheet on screen: save pending edits, then lock exactly that version. */
  const lock = useCallback(async (): Promise<LockResult> => {
    const s = sessionRef.current;
    if (!s || !s.meta || !canEditRef.current) return { ok: false, message: 'The sheet is not loaded.' };
    if (isLocked(s)) return { ok: true };
    const saved = await flush();
    if (!saved) {
      return { ok: false, message: 'Your latest edits are not saved yet, so nothing was locked. Resolve the message above first.' };
    }
    if (!s.meta || s.meta.version === 0 || s.meta.rowCount === 0) {
      return { ok: false, message: 'Nothing to lock: this sheet has no saved rows yet.' };
    }
    const { status, ok, j } = await patchLock({ action: 'lock', sheet: s.sheet, week: s.week, expectedVersion: s.meta.version });
    if (ok || status === 423) {
      s.meta = { ...s.meta, lockedAt: (j.lockedAt as string | null) ?? null, lockedBy: (j.lockedBy as string | null) ?? null };
      clearTimer(s);
      if (live(s)) {
        setMeta(s.meta);
        setSaveState('idle');
      }
      return ok ? { ok: true } : { ok: true, message: `Already locked in by ${String(j.lockedBy ?? 'someone')}.` };
    }
    if (status === 409) {
      // Someone saved after this sheet was opened: what is on screen is not what would be locked.
      s.blocked = true;
      if (live(s)) {
        setConflict({
          version: Number(j.version),
          updatedBy: (j.updatedBy as string | null) ?? null,
          updatedAt: (j.updatedAt as string | null) ?? null,
        });
        setSaveState('conflict');
      }
      return { ok: false, message: 'Not locked: someone saved this sheet after you opened it. Choose a version, then lock it in.' };
    }
    return { ok: false, message: typeof j.error === 'string' ? j.error : `Lock in failed (${status})` };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [flush]);

  /** Unlock with a reason. The sheet is reloaded afterwards, fresh from the server. */
  const unlock = useCallback(async (reason: string): Promise<LockResult> => {
    const s = sessionRef.current;
    if (!s || !s.meta || !canEditRef.current) return { ok: false, message: 'The sheet is not loaded.' };
    const { status, ok, j } = await patchLock({ action: 'unlock', sheet: s.sheet, week: s.week, reason });
    if (ok || status === 409) {
      s.blocked = false;
      void load(s);
      return ok ? { ok: true } : { ok: true, message: 'It was already unlocked.' };
    }
    return { ok: false, message: typeof j.error === 'string' ? j.error : `Unlock failed (${status})` };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [load]);

  return {
    loadState,
    loadError,
    rows,
    meta,
    settings,
    setRate,
    setCellFormula,
    setColumnFormula,
    useFormulaAgain,
    locked: !!meta?.lockedAt,
    lock,
    unlock,
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
    importSheet,
    /** The last sync whose save landed in this page (the server's timestamp). */
    syncStamp,
  };
}

export type NpdSheetController = ReturnType<typeof useNpdSheet>;
