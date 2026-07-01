'use client';

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import {
  Building2,
  CalendarDays,
  Check,
  ChevronDown,
  ChevronLeft,
  ChevronRight,
  ClipboardList,
  Eraser,
  Info,
  Loader2,
  Lock,
  LockOpen,
  Plus,
  RefreshCw,
  Save,
  Trash2,
  X,
} from 'lucide-react';
import { toast } from 'sonner';
import { Button } from '@/components/ui/button';
import { cn } from '@/lib/utils';
import {
  getHrTabCache,
  setHrTabCache,
  HR_TAB_CACHE_KEYS,
} from '@/lib/hr/tab-cache';
import type { CellEditEntry, HrNewHireChecklistRow } from '@/lib/supabase/hr-new-hire-checklist';
import { ONBOARDING_COUNTRIES, resolveOnboardingCountry } from '@/lib/onboarding/countries';

/** Grid columns, in display order. Keys match the DB / API field names 1:1. */
const COLUMNS = [
  { key: 'name', label: 'Names' },
  { key: 'personal_email', label: 'Personal Email' },
  { key: 'location', label: 'Location' },
  { key: 'phone_number', label: 'Phone Number' },
  { key: 'date_of_interview', label: 'Date of Interview' },
  { key: 'source', label: 'Source' },
  { key: 'hired_by', label: 'Hired By' },
  { key: 'department', label: 'Department' },
  { key: 'country', label: 'Country' },
] as const;

/** The onboarding-supported countries — the Country cell is a dropdown of these
 *  so Bulk Invite can segregate hires into the matching per-country box. */
const COUNTRY_OPTIONS = ONBOARDING_COUNTRIES.map((c) => c.name);

// Native <option> popups don't inherit the app's dark theme — without an
// explicit dark background, the (light) option text renders on a white popup
// and is invisible. Pair this on every <option> with `color-scheme` on the
// <select> so both the closed control and the open list read correctly.
const SELECT_OPTION_CLASS = 'bg-white text-zinc-900 dark:bg-zinc-900 dark:text-zinc-100';
const SELECT_SCHEME_CLASS = '[color-scheme:light] dark:[color-scheme:dark]';

type FieldKey = (typeof COLUMNS)[number]['key'];

/** A grid row: a stable client `_key`, the DB `id` (null until saved), one
 *  string per column (empty string = blank cell), and `_editedBy` — the edit
 *  history log per column, as loaded from the server (never sent back on save;
 *  the server recomputes it by diffing against its own current values). */
type GridRow = {
  _key: string;
  id: string | null;
  _editedBy?: Partial<Record<FieldKey, CellEditEntry[]>>;
} & Record<FieldKey, string>;

type PeriodMeta = {
  period_start: string;
  period_end: string | null;
  status: 'open' | 'locked';
  locked_at: string | null;
  locked_by: string | null;
  row_count: number;
};

type CacheVal = {
  period: string;
  rows: GridRow[];
  dirty: boolean;
  locked: boolean;
  lockedAt: string | null;
  lockedBy: string | null;
  loaded: boolean;
};

const CACHE_KEY = HR_TAB_CACHE_KEYS.newHireChecklist;

// Stable, render-safe row keys (no Math.random/Date during render — avoids SSR
// hydration drift). Module-level so keys stay unique across tab remounts.
let keySeq = 0;
const nextKey = () => `nhc-${++keySeq}`;

function blankRow(): GridRow {
  const r = { _key: nextKey(), id: null } as GridRow;
  for (const c of COLUMNS) r[c.key] = '';
  return r;
}

function seedBlank(n: number): GridRow[] {
  return Array.from({ length: n }, () => blankRow());
}

function fromServer(row: HrNewHireChecklistRow): GridRow {
  const r = { _key: nextKey(), id: row.id, _editedBy: row.cell_edits ?? undefined } as GridRow;
  for (const c of COLUMNS) r[c.key] = (row[c.key] ?? '') as string;
  return r;
}

function toPayload(rows: GridRow[]) {
  return rows.map((r) => {
    const o: Record<string, string | null> = {};
    if (r.id) o.id = r.id;
    for (const c of COLUMNS) o[c.key] = r[c.key];
    return o;
  });
}

function rowIsBlank(r: GridRow): boolean {
  return COLUMNS.every((c) => (r[c.key] ?? '').trim() === '');
}

/** Parse clipboard text into a 2D matrix: rows split on newlines, cells on tabs
 *  (the format Excel / Google Sheets put on the clipboard). A trailing newline
 *  is dropped so a copied column doesn't yield a stray empty final row. */
function parseClipboard(text: string): string[][] {
  const normalized = text.replace(/\r\n?/g, '\n');
  const trimmed = normalized.endsWith('\n') ? normalized.slice(0, -1) : normalized;
  return trimmed.split('\n').map((line) => line.split('\t'));
}

/** Snap a pasted department to the canonical casing from the dropdown list when
 *  it matches case-insensitively (so Bulk Invite detects it exactly); otherwise
 *  keep the raw value so nothing is silently dropped. */
function canonicalizeDept(value: string, departments: string[]): string {
  const t = value.trim();
  if (!t) return '';
  return departments.find((d) => d.toLowerCase() === t.toLowerCase()) ?? t;
}

/** Snap a pasted country to its canonical onboarding name (handles aliases like
 *  "USA" → "United States") so Bulk Invite routes it to the right box; keep raw
 *  if unrecognized. */
function canonicalizeCountry(value: string): string {
  const t = value.trim();
  if (!t) return '';
  return resolveOnboardingCountry(t)?.name ?? t;
}

// ── Week (period) math: Sun–Sat weeks anchored on their SUNDAY (YYYY-MM-DD) ───
function toIso(d: Date): string {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

/** The Sunday that starts the week containing `d`. */
function sundayIso(d: Date): string {
  const x = new Date(d.getFullYear(), d.getMonth(), d.getDate());
  x.setDate(x.getDate() - x.getDay()); // getDay(): Sun=0 … Sat=6
  return toIso(x);
}

/** Saturday end of the Sun-anchored week (start + 6 days). */
function weekEndIso(startIso: string): string {
  const [y, m, d] = startIso.split('-').map(Number);
  return toIso(new Date(y!, m! - 1, d! + 6));
}

/** Shift a week start by `n` weeks (±). */
function addWeeks(startIso: string, n: number): string {
  const [y, m, d] = startIso.split('-').map(Number);
  return toIso(new Date(y!, m! - 1, d! + n * 7));
}

/** "Jun 28 – Jul 4, 2026" for a Sun-anchored week start. */
function formatWeekLabel(startIso: string): string {
  if (!startIso) return '—';
  const [y, m, d] = startIso.split('-').map(Number);
  if (!y || !m || !d) return startIso;
  const s = new Date(y, m - 1, d);
  const e = new Date(y, m - 1, d + 6);
  const f = (dt: Date) => dt.toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
  return `${f(s)} – ${f(e)}, ${e.getFullYear()}`;
}

function formatLockStamp(iso: string | null): string {
  if (!iso) return '';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '';
  return `${d.toLocaleDateString(undefined, { month: 'short', day: 'numeric' })}, ${d.toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' })}`;
}

/** Newest-first list of week starts: `fwd` ahead of, through `back` behind, the
 *  current week. */
function rollingWeeks(currentSunday: string, back: number, fwd: number): string[] {
  const out: string[] = [];
  for (let i = fwd; i >= -back; i--) out.push(addWeeks(currentSunday, i));
  return out;
}

export default function HrNewHireChecklist({
  onScrollSurfaceChange,
}: {
  /** Registers the grid's scroll container with the HR collab layer so peer
   *  cursors anchor to the actual rows (and clip when scrolled away). Called
   *  with the element on mount and `null` on unmount. */
  onScrollSurfaceChange?: (el: HTMLElement | null) => void;
} = {}) {
  // This tab only ever mounts client-side (HrApp gates it behind an auth check),
  // so reading the cache / `new Date()` in initializers is hydration-safe.
  const cached = getHrTabCache<CacheVal>(CACHE_KEY);
  const [currentSunday] = useState(() => sundayIso(new Date()));
  const [period, setPeriod] = useState<string>(() => cached?.period ?? sundayIso(new Date()));
  const [rows, setRows] = useState<GridRow[]>(() => cached?.rows ?? []);
  const [dirty, setDirty] = useState<boolean>(() => cached?.dirty ?? false);
  const [locked, setLocked] = useState<boolean>(() => cached?.locked ?? false);
  const [lockedAt, setLockedAt] = useState<string | null>(() => cached?.lockedAt ?? null);
  const [lockedBy, setLockedBy] = useState<string | null>(() => cached?.lockedBy ?? null);
  const [loaded, setLoaded] = useState<boolean>(() => cached?.loaded ?? false);
  const [loading, setLoading] = useState<boolean>(() => !cached?.loaded);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [focusCell, setFocusCell] = useState<{ r: number; c: number } | null>(null);
  const scrollRef = useRef<HTMLDivElement>(null);
  const [departments, setDepartments] = useState<string[]>([]);
  const [selectedKeys, setSelectedKeys] = useState<Set<string>>(() => new Set());
  const [bulkDept, setBulkDept] = useState('');
  const [bulkCountry, setBulkCountry] = useState('');
  const selectAllRef = useRef<HTMLInputElement>(null);
  // Period selector
  const [periodMetas, setPeriodMetas] = useState<PeriodMeta[]>([]);
  const [periodMenuOpen, setPeriodMenuOpen] = useState(false);
  const periodMenuRef = useRef<HTMLDivElement>(null);
  // Per-cell edit-history popover, anchored to the clicked dot via a fixed
  // portal so the grid's scroll overflow never clips it.
  const [historyPopover, setHistoryPopover] = useState<
    { label: string; entries: CellEditEntry[]; top: number; left: number } | null
  >(null);

  // Mutators read the lock through a ref so a locked week can never be edited
  // (even a paste on a readOnly input still fires our onPaste handler).
  const lockedRef = useRef(locked);
  useEffect(() => { lockedRef.current = locked; }, [locked]);

  // Callback ref for the scrollable grid box: keeps `scrollRef` (used for cell
  // focus) in sync AND registers the element with the HR collab layer so peer
  // cursors anchor to the rows. Fires with `null` when the box unmounts (empty
  // state / tab switch), clearing the anchor.
  const registerScrollSurface = useCallback(
    (el: HTMLDivElement | null) => {
      scrollRef.current = el;
      onScrollSurfaceChange?.(el);
    },
    [onScrollSurfaceChange],
  );

  // Clear the anchor if this tab unmounts entirely.
  useEffect(() => () => onScrollSurfaceChange?.(null), [onScrollSurfaceChange]);

  const fetchPeriod = useCallback(async (p: string) => {
    setLoading(true);
    setError(null);
    try {
      const res = await fetch(`/api/hr/new-hire-checklist?period=${encodeURIComponent(p)}`, { cache: 'no-store' });
      const json = (await res.json()) as {
        rows?: HrNewHireChecklistRow[];
        period?: { status?: string; locked_at?: string | null; locked_by?: string | null };
        error?: string;
      };
      if (!res.ok || json.error) throw new Error(json.error || `Request failed (${res.status})`);
      const isLocked = json.period?.status === 'locked';
      const fresh = (json.rows ?? []).map(fromServer);
      setRows(fresh.length ? fresh : isLocked ? [] : seedBlank(6));
      setLocked(isLocked);
      setLockedAt(json.period?.locked_at ?? null);
      setLockedBy(json.period?.locked_by ?? null);
      setDirty(false);
      setSelectedKeys(new Set());
      setLoaded(true);
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Failed to load the checklist');
    } finally {
      setLoading(false);
    }
  }, []);

  const loadPeriods = useCallback(async () => {
    try {
      const res = await fetch('/api/hr/new-hire-checklist/periods', { cache: 'no-store' });
      const json = (await res.json()) as { periods?: PeriodMeta[] };
      setPeriodMetas(json.periods ?? []);
    } catch { /* selector still works off the generated rolling weeks */ }
  }, []);

  // Load the selected week's rows + lock state when it isn't already loaded
  // (skipped on a warm cache so tab-switches keep in-progress edits).
  useEffect(() => {
    if (!period || loaded) return;
    void fetchPeriod(period);
  }, [period, loaded, fetchPeriod]);

  useEffect(() => { void loadPeriods(); }, [loadPeriods]);

  // Department dropdown options (best-effort; failure leaves Department as a
  // plain text input so entry is never blocked).
  useEffect(() => {
    let cancelled = false;
    fetch('/api/departments', { cache: 'no-store' })
      .then((r) => r.json())
      .then((j: { departments?: string[] }) => { if (!cancelled) setDepartments(j.departments ?? []); })
      .catch(() => { /* text-input fallback */ });
    return () => { cancelled = true; };
  }, []);

  // Mirror state into the per-session tab cache on every change.
  useEffect(() => {
    setHrTabCache<CacheVal>(CACHE_KEY, { period, rows, dirty, locked, lockedAt, lockedBy, loaded });
  }, [period, rows, dirty, locked, lockedAt, lockedBy, loaded]);

  // Close the edit-history popover on outside click, Escape, or any scroll
  // (its fixed position would otherwise drift away from the anchor cell).
  useEffect(() => {
    if (!historyPopover) return;
    const onDown = (e: MouseEvent) => {
      const t = e.target as HTMLElement | null;
      if (t?.closest('[data-cell-history-popover]') || t?.closest('[data-cell-history-dot]')) return;
      setHistoryPopover(null);
    };
    const onEsc = (e: KeyboardEvent) => { if (e.key === 'Escape') setHistoryPopover(null); };
    const onScroll = () => setHistoryPopover(null);
    document.addEventListener('mousedown', onDown);
    document.addEventListener('keydown', onEsc);
    window.addEventListener('scroll', onScroll, true);
    return () => {
      document.removeEventListener('mousedown', onDown);
      document.removeEventListener('keydown', onEsc);
      window.removeEventListener('scroll', onScroll, true);
    };
  }, [historyPopover]);

  // Close the period menu on outside click / Escape.
  useEffect(() => {
    if (!periodMenuOpen) return;
    const onDown = (e: MouseEvent) => {
      if (periodMenuRef.current && !periodMenuRef.current.contains(e.target as Node)) setPeriodMenuOpen(false);
    };
    const onEsc = (e: KeyboardEvent) => { if (e.key === 'Escape') setPeriodMenuOpen(false); };
    document.addEventListener('mousedown', onDown);
    document.addEventListener('keydown', onEsc);
    return () => {
      document.removeEventListener('mousedown', onDown);
      document.removeEventListener('keydown', onEsc);
    };
  }, [periodMenuOpen]);

  // Focus (and select) a cell after a structural change lands in the DOM.
  useEffect(() => {
    if (!focusCell) return;
    const el = scrollRef.current?.querySelector<HTMLElement>(`[data-cell="${focusCell.r}-${focusCell.c}"]`);
    if (el) {
      el.focus();
      if (el instanceof HTMLInputElement) el.select();
    }
    setFocusCell(null);
  }, [focusCell, rows.length]);

  const setCell = useCallback((r: number, key: FieldKey, value: string) => {
    if (lockedRef.current) return;
    setRows((prev) => prev.map((row, i) => (i === r ? { ...row, [key]: value } : row)));
    setDirty(true);
  }, []);

  const handlePaste = useCallback(
    (e: React.ClipboardEvent<HTMLInputElement>, r: number, c: number) => {
      if (lockedRef.current) return;
      const text = e.clipboardData?.getData('text/plain') ?? '';
      if (!text) return;
      const matrix = parseClipboard(text);
      if (matrix.length === 1 && matrix[0]!.length === 1) return; // single value → native paste
      e.preventDefault();
      setRows((prev) => {
        const next = prev.map((row) => ({ ...row }));
        for (let i = 0; i < matrix.length; i++) {
          const targetRow = r + i;
          while (next.length <= targetRow) next.push(blankRow());
          const cells = matrix[i]!;
          for (let j = 0; j < cells.length; j++) {
            const targetCol = c + j;
            if (targetCol >= COLUMNS.length) break;
            const key = COLUMNS[targetCol]!.key;
            const raw = cells[j]!.trim();
            next[targetRow]![key] =
              key === 'department'
                ? canonicalizeDept(raw, departments)
                : key === 'country'
                  ? canonicalizeCountry(raw)
                  : raw;
          }
        }
        return next;
      });
      setDirty(true);
    },
    [departments],
  );

  const handleKeyDown = useCallback(
    (e: React.KeyboardEvent<HTMLInputElement>, r: number, c: number) => {
      if (e.key === 'Enter') {
        e.preventDefault();
        if (lockedRef.current) return;
        const nextR = r + 1;
        setRows((prev) => (nextR >= prev.length ? [...prev, blankRow()] : prev));
        setFocusCell({ r: nextR, c });
      } else if (e.key === 'ArrowDown') {
        e.preventDefault();
        setFocusCell({ r: Math.min(r + 1, rows.length - 1), c });
      } else if (e.key === 'ArrowUp') {
        e.preventDefault();
        setFocusCell({ r: Math.max(r - 1, 0), c });
      }
    },
    [rows.length],
  );

  const addRows = useCallback((n: number) => {
    if (lockedRef.current) return;
    setRows((prev) => [...prev, ...seedBlank(n)]);
    setDirty(true);
  }, []);

  const clearColumn = useCallback((key: FieldKey, label: string) => {
    if (lockedRef.current) return;
    setRows((prev) => prev.map((row) => ({ ...row, [key]: '' })));
    setDirty(true);
    toast.success(`Cleared the ${label} column`);
  }, []);

  const deleteRow = useCallback((r: number, key: string) => {
    if (lockedRef.current) return;
    setRows((prev) => {
      const next = prev.filter((_, i) => i !== r);
      return next.length ? next : seedBlank(1);
    });
    setSelectedKeys((prev) => {
      if (!prev.has(key)) return prev;
      const next = new Set(prev);
      next.delete(key);
      return next;
    });
    setDirty(true);
  }, []);

  const changePeriod = useCallback((p: string) => {
    setPeriodMenuOpen(false);
    if (p === period) return;
    if (dirty && !window.confirm('Discard unsaved changes and switch weeks?')) return;
    setPeriod(p);
    setLoaded(false);
  }, [period, dirty]);

  const refresh = useCallback(() => {
    if (dirty && !window.confirm('Discard unsaved changes and reload from the server?')) return;
    void fetchPeriod(period);
    void loadPeriods();
  }, [dirty, period, fetchPeriod, loadPeriods]);

  const persist = useCallback(async (action: 'save' | 'lock') => {
    if (!period) return;
    setSaving(true);
    setError(null);
    try {
      const res = await fetch('/api/hr/new-hire-checklist', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          period_start: period,
          period_end: weekEndIso(period),
          rows: toPayload(rows),
          action,
        }),
      });
      const json = (await res.json()) as {
        rows?: HrNewHireChecklistRow[];
        period?: { status?: string; locked_at?: string | null; locked_by?: string | null };
        error?: string;
      };
      if (!res.ok || json.error) throw new Error(json.error || `Save failed (${res.status})`);
      const isLocked = json.period?.status === 'locked';
      const fresh = (json.rows ?? []).map(fromServer);
      setRows(fresh.length ? fresh : isLocked ? [] : seedBlank(6));
      setLocked(isLocked);
      setLockedAt(json.period?.locked_at ?? null);
      setLockedBy(json.period?.locked_by ?? null);
      setDirty(false);
      setSelectedKeys(new Set());
      setLoaded(true);
      const filled = fresh.filter((r) => !rowIsBlank(r)).length;
      toast.success(
        action === 'lock'
          ? `Locked in ${filled} ${filled === 1 ? 'hire' : 'hires'} for ${formatWeekLabel(period)}`
          : `Saved ${filled} ${filled === 1 ? 'hire' : 'hires'} to ${formatWeekLabel(period)}`,
      );
      void loadPeriods();
    } catch (e) {
      toast.error(e instanceof Error ? e.message : 'Save failed');
    } finally {
      setSaving(false);
    }
  }, [period, rows, loadPeriods]);

  const reopen = useCallback(async () => {
    if (!period) return;
    setSaving(true);
    setError(null);
    try {
      const res = await fetch('/api/hr/new-hire-checklist', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ period_start: period, action: 'reopen' }),
      });
      const json = (await res.json()) as { rows?: HrNewHireChecklistRow[]; error?: string };
      if (!res.ok || json.error) throw new Error(json.error || `Reopen failed (${res.status})`);
      const fresh = (json.rows ?? []).map(fromServer);
      setRows(fresh.length ? fresh : seedBlank(6));
      setLocked(false);
      setLockedAt(null);
      setLockedBy(null);
      setDirty(false);
      toast.success(`Reopened ${formatWeekLabel(period)} for editing`);
      void loadPeriods();
    } catch (e) {
      toast.error(e instanceof Error ? e.message : 'Reopen failed');
    } finally {
      setSaving(false);
    }
  }, [period, loadPeriods]);

  const filledCount = useMemo(() => rows.filter((r) => !rowIsBlank(r)).length, [rows]);

  // ── Row multiselect → bulk-apply department / country / delete ──
  const selectedCount = selectedKeys.size;
  const allSelected = rows.length > 0 && rows.every((r) => selectedKeys.has(r._key));

  useEffect(() => {
    if (selectAllRef.current) selectAllRef.current.indeterminate = selectedCount > 0 && !allSelected;
  }, [selectedCount, allSelected]);

  const toggleRow = useCallback((key: string) => {
    setSelectedKeys((prev) => {
      const next = new Set(prev);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });
  }, []);

  const toggleAll = useCallback(() => {
    setSelectedKeys((prev) => {
      const everySelected = rows.length > 0 && rows.every((r) => prev.has(r._key));
      return everySelected ? new Set() : new Set(rows.map((r) => r._key));
    });
  }, [rows]);

  const clearSelection = useCallback(() => setSelectedKeys(new Set()), []);

  const applyToSelected = useCallback(
    (field: 'department' | 'country', value: string) => {
      if (lockedRef.current) return;
      const v = value.trim();
      if (!v || selectedKeys.size === 0) return;
      const n = selectedKeys.size;
      setRows((prev) => prev.map((row) => (selectedKeys.has(row._key) ? { ...row, [field]: v } : row)));
      setDirty(true);
      toast.success(`Set ${field} on ${n} ${n === 1 ? 'hire' : 'hires'} to ${v}`);
    },
    [selectedKeys],
  );

  const deleteSelected = useCallback(() => {
    if (lockedRef.current) return;
    if (selectedKeys.size === 0) return;
    setRows((prev) => {
      const next = prev.filter((row) => !selectedKeys.has(row._key));
      return next.length ? next : seedBlank(1);
    });
    setSelectedKeys(new Set());
    setDirty(true);
  }, [selectedKeys]);

  // Period options for the dropdown: generated rolling weeks unioned with weeks
  // that already have saved rows / a lock (so historical data is always reachable).
  const periodOptions = useMemo(() => {
    const map = new Map<string, { start: string; locked: boolean; rowCount: number }>();
    for (const s of rollingWeeks(currentSunday, 16, 1)) map.set(s, { start: s, locked: false, rowCount: 0 });
    for (const p of periodMetas) {
      map.set(p.period_start, { start: p.period_start, locked: p.status === 'locked', rowCount: p.row_count });
    }
    if (period && !map.has(period)) map.set(period, { start: period, locked, rowCount: 0 });
    return [...map.values()].sort((a, b) => b.start.localeCompare(a.start));
  }, [currentSunday, periodMetas, period, locked]);

  return (
    <div className="flex h-full min-h-0 flex-col">
      {/* Header */}
      <div className="shrink-0 border-b border-emerald-100/70 bg-white px-4 py-3 sm:px-6 sm:py-4 dark:border-emerald-950/40 dark:bg-[#0d1117]">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div className="min-w-0">
            <h1 className="flex items-center gap-2 text-base font-semibold tracking-tight text-zinc-900 sm:text-xl dark:text-white">
              <ClipboardList className="h-5 w-5 text-emerald-600 dark:text-emerald-400" />
              New Hire Checklist
            </h1>
            <p className="mt-0.5 text-xs text-zinc-500 dark:text-zinc-500">
              Paste each column, pick the week, then Lock in to save these hires to that period.
              {filledCount > 0 && (
                <span className="ml-1 font-medium text-emerald-700 dark:text-emerald-400">
                  {filledCount} {filledCount === 1 ? 'hire' : 'hires'} this week.
                </span>
              )}
            </p>
          </div>

          <div className="flex flex-wrap items-center gap-2">
            {/* Period (week) selector */}
            <div className="relative" ref={periodMenuRef}>
              <div className="flex items-center gap-1">
                <button
                  type="button"
                  onClick={() => changePeriod(addWeeks(period, -1))}
                  disabled={saving}
                  aria-label="Previous week"
                  className="flex h-8 w-7 items-center justify-center rounded-lg border border-emerald-200 text-emerald-700 hover:bg-emerald-50 disabled:opacity-50 dark:border-emerald-800 dark:text-emerald-300 dark:hover:bg-emerald-950/40"
                >
                  <ChevronLeft className="h-4 w-4" />
                </button>
                <button
                  type="button"
                  onClick={() => setPeriodMenuOpen((o) => !o)}
                  disabled={saving}
                  className={cn(
                    'flex h-8 items-center gap-1.5 rounded-lg border px-2.5 text-[13px] font-medium transition-colors disabled:opacity-50',
                    locked
                      ? 'border-amber-300 bg-amber-50 text-amber-800 hover:bg-amber-100 dark:border-amber-800 dark:bg-amber-950/30 dark:text-amber-200'
                      : 'border-emerald-200 bg-white text-zinc-800 hover:bg-emerald-50 dark:border-emerald-800 dark:bg-zinc-900 dark:text-zinc-100 dark:hover:bg-emerald-950/40',
                  )}
                >
                  <CalendarDays className="h-3.5 w-3.5 text-emerald-600 dark:text-emerald-400" />
                  <span className="tabular-nums">{formatWeekLabel(period)}</span>
                  {period === currentSunday && (
                    <span className="rounded-full bg-emerald-100 px-1.5 py-px text-[10px] font-semibold text-emerald-700 dark:bg-emerald-900/50 dark:text-emerald-300">
                      this week
                    </span>
                  )}
                  {locked && <Lock className="h-3 w-3 text-amber-500" />}
                  <ChevronDown className="h-3.5 w-3.5 text-zinc-400" />
                </button>
                <button
                  type="button"
                  onClick={() => changePeriod(addWeeks(period, 1))}
                  disabled={saving}
                  aria-label="Next week"
                  className="flex h-8 w-7 items-center justify-center rounded-lg border border-emerald-200 text-emerald-700 hover:bg-emerald-50 disabled:opacity-50 dark:border-emerald-800 dark:text-emerald-300 dark:hover:bg-emerald-950/40"
                >
                  <ChevronRight className="h-4 w-4" />
                </button>
              </div>
              {periodMenuOpen && (
                <div className="absolute right-0 z-30 mt-1 max-h-72 w-64 overflow-auto rounded-xl border border-zinc-200 bg-white py-1 shadow-lg shadow-black/10 dark:border-zinc-700 dark:bg-zinc-900">
                  {periodOptions.map((o) => (
                    <button
                      key={o.start}
                      type="button"
                      onClick={() => changePeriod(o.start)}
                      className={cn(
                        'flex w-full items-center justify-between gap-2 px-3 py-2 text-left text-[13px] hover:bg-emerald-50 dark:hover:bg-emerald-950/40',
                        o.start === period
                          ? 'bg-emerald-50 font-medium text-emerald-800 dark:bg-emerald-950/50 dark:text-emerald-200'
                          : 'text-zinc-700 dark:text-zinc-300',
                      )}
                    >
                      <span className="flex items-center gap-2 tabular-nums">
                        {formatWeekLabel(o.start)}
                        {o.start === currentSunday && (
                          <span className="rounded-full bg-emerald-100 px-1.5 py-px text-[10px] font-semibold text-emerald-700 dark:bg-emerald-900/50 dark:text-emerald-300">
                            now
                          </span>
                        )}
                      </span>
                      <span className="flex items-center gap-1.5 text-[11px] text-zinc-400">
                        {o.rowCount > 0 && <span className="tabular-nums">{o.rowCount}</span>}
                        {o.locked && <Lock className="h-3 w-3 text-amber-500" />}
                      </span>
                    </button>
                  ))}
                </div>
              )}
            </div>

            {dirty && !locked && (
              <span className="flex items-center gap-1.5 text-[11px] font-medium text-amber-600 dark:text-amber-400">
                <span className="h-1.5 w-1.5 animate-pulse rounded-full bg-amber-500" />
                Unsaved
              </span>
            )}

            <Button
              type="button"
              variant="outline"
              size="sm"
              onClick={refresh}
              disabled={loading || saving}
              className="h-8 gap-1.5 border-emerald-200 text-emerald-700 hover:bg-emerald-50 dark:border-emerald-800 dark:text-emerald-300"
            >
              <RefreshCw className={cn('h-3.5 w-3.5', loading && 'animate-spin')} />
              <span className="hidden sm:inline">Refresh</span>
            </Button>

            {locked ? (
              <Button
                type="button"
                size="sm"
                onClick={() => void reopen()}
                disabled={saving || loading}
                className="h-8 gap-1.5 bg-amber-500 text-white hover:bg-amber-600 disabled:opacity-50"
              >
                {saving ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <LockOpen className="h-3.5 w-3.5" />}
                Reopen
              </Button>
            ) : (
              <>
                <Button
                  type="button"
                  variant="outline"
                  size="sm"
                  onClick={() => void persist('save')}
                  disabled={saving || loading || !dirty}
                  className="h-8 gap-1.5 border-emerald-200 text-emerald-700 hover:bg-emerald-50 disabled:opacity-50 dark:border-emerald-800 dark:text-emerald-300"
                >
                  {saving ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Save className="h-3.5 w-3.5" />}
                  Save
                </Button>
                <Button
                  type="button"
                  size="sm"
                  onClick={() => void persist('lock')}
                  disabled={saving || loading}
                  className="h-8 gap-1.5 bg-emerald-600 text-white hover:bg-emerald-700 disabled:opacity-50"
                >
                  <Lock className="h-3.5 w-3.5" />
                  Lock in
                </Button>
              </>
            )}
          </div>
        </div>
      </div>

      <div className="min-h-0 flex-1 overflow-hidden bg-[#fafaf8] px-3 py-4 sm:px-6 sm:py-6 dark:bg-[#0d1117]">
        <div className="flex h-full min-h-0 flex-col gap-3">
          {/* Locked banner */}
          {locked && !loading && !error && (
            <div className="flex flex-wrap items-center gap-2 rounded-xl border border-amber-300 bg-amber-50 px-3.5 py-2.5 text-[12px] text-amber-900 dark:border-amber-800 dark:bg-amber-950/30 dark:text-amber-200">
              <Lock className="h-3.5 w-3.5 shrink-0" />
              <span>
                <strong>{formatWeekLabel(period)}</strong> is locked
                {lockedBy ? <> by <strong>{lockedBy}</strong></> : null}
                {lockedAt ? <> on {formatLockStamp(lockedAt)}</> : null}. Reopen to edit.
              </span>
              <Button
                type="button"
                size="sm"
                onClick={() => void reopen()}
                disabled={saving}
                className="ml-auto h-7 gap-1.5 bg-amber-500 text-white hover:bg-amber-600"
              >
                <LockOpen className="h-3.5 w-3.5" />
                Reopen to edit
              </Button>
            </div>
          )}

          {/* Paste hint (editing only) */}
          {!locked && (
            <div className="flex items-start gap-2 rounded-xl border border-emerald-200 bg-emerald-50/70 px-3.5 py-2.5 text-[12px] leading-snug text-emerald-800 dark:border-emerald-500/30 dark:bg-emerald-950/20 dark:text-emerald-300">
              <Info className="mt-0.5 h-3.5 w-3.5 shrink-0" />
              <span>
                Copy a column from Excel / Google Sheets and paste it into any cell — it fills straight
                down. <strong>Department</strong> and <strong>Country</strong> offer a dropdown but can also be
                typed or pasted. Tick rows to bulk-apply a department / country. A green dot in a cell&apos;s
                corner means it&apos;s been edited — click it to see the full history (who changed it, when, and
                the old &rarr; new value). <strong>Lock in</strong> saves this week&apos;s hires to Supabase; they
                then feed the per-country <strong>Bulk Invite</strong> in Onboarding. Reopen any week to edit.
              </span>
            </div>
          )}

          {/* Bulk action bar — editing only */}
          {!locked && !loading && !error && selectedCount > 0 && (
            <div className="flex shrink-0 flex-wrap items-center gap-x-2 gap-y-2 rounded-xl border border-emerald-300 bg-emerald-50 px-3 py-2 shadow-sm dark:border-emerald-700 dark:bg-emerald-950/40">
              <span className="flex items-center gap-1.5 text-[12px] font-semibold text-emerald-800 dark:text-emerald-200">
                <Building2 className="h-3.5 w-3.5" />
                {selectedCount} selected
              </span>

              <span className="ml-1 text-[11px] text-zinc-600 dark:text-zinc-400">Dept</span>
              {departments.length > 0 ? (
                <select
                  value={bulkDept}
                  onChange={(e) => setBulkDept(e.target.value)}
                  aria-label="Department to apply to selected rows"
                  className={cn(
                    'h-8 min-w-[9rem] rounded-lg border border-emerald-200 bg-white px-2 text-[13px] text-zinc-800 outline-none focus:border-emerald-400 focus:ring-1 focus:ring-emerald-300 dark:border-emerald-800 dark:bg-zinc-900 dark:text-zinc-100',
                    SELECT_SCHEME_CLASS,
                  )}
                >
                  <option value="" className={SELECT_OPTION_CLASS}>Choose…</option>
                  {departments.map((d) => (
                    <option key={d} value={d} className={SELECT_OPTION_CLASS}>{d}</option>
                  ))}
                </select>
              ) : (
                <input
                  value={bulkDept}
                  onChange={(e) => setBulkDept(e.target.value)}
                  placeholder="Department"
                  aria-label="Department to apply to selected rows"
                  className="h-8 min-w-[9rem] rounded-lg border border-emerald-200 bg-white px-2 text-[13px] text-zinc-800 outline-none focus:border-emerald-400 focus:ring-1 focus:ring-emerald-300 dark:border-emerald-800 dark:bg-zinc-900 dark:text-zinc-100"
                />
              )}
              <Button
                type="button"
                size="sm"
                onClick={() => applyToSelected('department', bulkDept)}
                disabled={!bulkDept.trim()}
                className="h-8 gap-1.5 bg-emerald-600 text-white hover:bg-emerald-700 disabled:opacity-50"
              >
                <Check className="h-3.5 w-3.5" />
                Apply
              </Button>

              <span className="ml-2 text-[11px] text-zinc-600 dark:text-zinc-400">Country</span>
              <select
                value={bulkCountry}
                onChange={(e) => setBulkCountry(e.target.value)}
                aria-label="Country to apply to selected rows"
                className={cn(
                  'h-8 min-w-[9rem] rounded-lg border border-emerald-200 bg-white px-2 text-[13px] text-zinc-800 outline-none focus:border-emerald-400 focus:ring-1 focus:ring-emerald-300 dark:border-emerald-800 dark:bg-zinc-900 dark:text-zinc-100',
                  SELECT_SCHEME_CLASS,
                )}
              >
                <option value="" className={SELECT_OPTION_CLASS}>Choose…</option>
                {COUNTRY_OPTIONS.map((c) => (
                  <option key={c} value={c} className={SELECT_OPTION_CLASS}>{c}</option>
                ))}
              </select>
              <Button
                type="button"
                size="sm"
                onClick={() => applyToSelected('country', bulkCountry)}
                disabled={!bulkCountry.trim()}
                className="h-8 gap-1.5 bg-emerald-600 text-white hover:bg-emerald-700 disabled:opacity-50"
              >
                <Check className="h-3.5 w-3.5" />
                Apply
              </Button>

              <Button
                type="button"
                size="sm"
                variant="outline"
                onClick={deleteSelected}
                className="h-8 gap-1.5 border-rose-200 text-rose-700 hover:bg-rose-50 dark:border-rose-800 dark:text-rose-300"
              >
                <Trash2 className="h-3.5 w-3.5" />
                Delete
              </Button>
              <button
                type="button"
                onClick={clearSelection}
                className="ml-auto flex items-center gap-1 text-[11px] text-zinc-500 hover:text-zinc-700 dark:text-zinc-400 dark:hover:text-zinc-200"
              >
                <X className="h-3.5 w-3.5" />
                Clear
              </button>
            </div>
          )}

          {loading ? (
            <div className="flex flex-1 items-center justify-center gap-2 text-sm text-zinc-500">
              <Loader2 className="h-4 w-4 animate-spin" />
              Loading {formatWeekLabel(period)}…
            </div>
          ) : error ? (
            <div className="rounded-xl border border-dashed border-rose-200 bg-white py-10 text-center text-sm text-rose-600 dark:border-rose-500/30 dark:bg-[#0d1117]">
              {error}
            </div>
          ) : (
            <>
              {/* Dropdown sources for the Department + Country comboboxes. */}
              <datalist id="nhc-departments">
                {departments.map((d) => (<option key={d} value={d} />))}
              </datalist>
              <datalist id="nhc-countries">
                {COUNTRY_OPTIONS.map((c) => (<option key={c} value={c} />))}
              </datalist>

              {rows.length === 0 ? (
                <div className="flex flex-1 flex-col items-center justify-center gap-2 rounded-2xl border border-dashed border-emerald-200 bg-white py-12 text-center dark:border-emerald-950/40 dark:bg-[#0d1117]">
                  <ClipboardList className="h-7 w-7 text-emerald-300 dark:text-emerald-800" />
                  <p className="text-sm text-zinc-500">No hires saved for {formatWeekLabel(period)}.</p>
                  {locked && (
                    <Button type="button" size="sm" onClick={() => void reopen()} disabled={saving} className="mt-1 gap-1.5 bg-amber-500 text-white hover:bg-amber-600">
                      <LockOpen className="h-3.5 w-3.5" /> Reopen to add hires
                    </Button>
                  )}
                </div>
              ) : (
                <div
                  ref={registerScrollSurface}
                  className="relative min-h-0 flex-1 overflow-auto rounded-2xl border border-emerald-100/80 bg-white shadow-sm dark:border-emerald-950/40 dark:bg-zinc-950"
                >
                  <table className="table-keep w-full border-collapse text-[13px]">
                    <thead className="sticky top-0 z-10">
                      <tr className="bg-emerald-50/90 backdrop-blur dark:bg-emerald-950/40">
                        <th className="sticky left-0 z-20 w-14 border-b border-r border-emerald-100/80 bg-emerald-50/90 px-1 py-2 text-center backdrop-blur dark:border-emerald-950/40 dark:bg-emerald-950/40">
                          {locked ? (
                            <span className="text-[11px] font-semibold text-emerald-700 dark:text-emerald-300">#</span>
                          ) : (
                            <input
                              ref={selectAllRef}
                              type="checkbox"
                              checked={allSelected}
                              onChange={toggleAll}
                              aria-label="Select all rows"
                              className="h-3.5 w-3.5 cursor-pointer align-middle accent-emerald-600"
                            />
                          )}
                        </th>
                        {COLUMNS.map((c) => (
                          <th
                            key={c.key}
                            className="group/col whitespace-nowrap border-b border-emerald-100/80 px-2.5 py-2 text-left text-[11.5px] font-semibold uppercase tracking-wide text-emerald-700 dark:border-emerald-950/40 dark:text-emerald-300"
                          >
                            <div className="flex items-center justify-between gap-2">
                              <span>{c.label}</span>
                              {!locked && (
                                <button
                                  type="button"
                                  onClick={() => clearColumn(c.key, c.label)}
                                  aria-label={`Clear the ${c.label} column`}
                                  title={`Clear the ${c.label} column`}
                                  className="shrink-0 rounded p-0.5 text-emerald-400 opacity-0 transition hover:bg-emerald-100 hover:text-emerald-700 focus:opacity-100 group-hover/col:opacity-100 dark:text-emerald-600 dark:hover:bg-emerald-900/40 dark:hover:text-emerald-200"
                                >
                                  <Eraser className="h-3 w-3" />
                                </button>
                              )}
                            </div>
                          </th>
                        ))}
                        {!locked && <th className="w-10 border-b border-emerald-100/80 px-1 py-2 dark:border-emerald-950/40" />}
                      </tr>
                    </thead>
                    <tbody>
                      {rows.map((row, r) => {
                        const isSelected = selectedKeys.has(row._key);
                        return (
                          <tr
                            key={row._key}
                            className={cn(
                              'group/row hover:bg-emerald-50/40 dark:hover:bg-emerald-950/20',
                              isSelected ? 'bg-emerald-50 dark:bg-emerald-950/30' : 'even:bg-zinc-50/40 dark:even:bg-zinc-900/30',
                            )}
                          >
                            <td
                              className={cn(
                                'sticky left-0 z-[1] border-b border-r border-emerald-50 px-1.5 py-0 dark:border-zinc-800',
                                isSelected
                                  ? 'bg-emerald-50 dark:bg-emerald-950/30'
                                  : 'bg-white group-even/row:bg-zinc-50/40 group-hover/row:bg-emerald-50/40 dark:bg-zinc-950 dark:group-even/row:bg-zinc-900/30',
                              )}
                            >
                              <div className="flex items-center justify-center gap-1.5">
                                {!locked && (
                                  <input
                                    type="checkbox"
                                    checked={isSelected}
                                    onChange={() => toggleRow(row._key)}
                                    aria-label={`Select row ${r + 1}`}
                                    className="h-3.5 w-3.5 cursor-pointer accent-emerald-600"
                                  />
                                )}
                                <span className="tabular-nums text-[11px] text-zinc-400">{r + 1}</span>
                              </div>
                            </td>
                            {COLUMNS.map((c, ci) => {
                              const value = row[c.key];
                              const edits = row._editedBy?.[c.key];
                              const hasEdits = !!edits && edits.length > 0;
                              const listId =
                                c.key === 'department'
                                  ? departments.length > 0 ? 'nhc-departments' : undefined
                                  : c.key === 'country'
                                    ? 'nhc-countries'
                                    : undefined;
                              return (
                                <td
                                  key={c.key}
                                  className="relative border-b border-emerald-50/80 p-0 dark:border-zinc-800/80"
                                >
                                  {hasEdits && (
                                    <button
                                      type="button"
                                      data-cell-history-dot
                                      onClick={(e) => {
                                        e.stopPropagation();
                                        const rect = e.currentTarget.getBoundingClientRect();
                                        const width = 300;
                                        const maxH = 320; // matches max-h-80 below
                                        setHistoryPopover({
                                          label: c.label,
                                          entries: [...(edits ?? [])].reverse(),
                                          // Clamp within the viewport so a dot near the
                                          // bottom edge can't push the popover off-screen.
                                          top: Math.max(12, Math.min(rect.bottom + 6, window.innerHeight - maxH - 12)),
                                          left: Math.max(12, Math.min(rect.left, window.innerWidth - width - 12)),
                                        });
                                      }}
                                      title={`Edited ${edits!.length} ${edits!.length === 1 ? 'time' : 'times'} — view history`}
                                      aria-label={`View edit history for ${c.label}, row ${r + 1}`}
                                      className="absolute right-0.5 top-0.5 z-[3] flex h-3 w-3 items-center justify-center"
                                    >
                                      <span className="h-1.5 w-1.5 rounded-full bg-emerald-500 ring-2 ring-white dark:bg-emerald-400 dark:ring-zinc-950" />
                                    </button>
                                  )}
                                  <input
                                    data-cell={`${r}-${ci}`}
                                    list={locked ? undefined : listId}
                                    value={value}
                                    readOnly={locked}
                                    onChange={(e) => setCell(r, c.key, e.target.value)}
                                    onPaste={(e) => handlePaste(e, r, ci)}
                                    onKeyDown={(e) => handleKeyDown(e, r, ci)}
                                    onBlur={
                                      listId && !locked
                                        ? (e) => {
                                            const canon =
                                              c.key === 'department'
                                                ? canonicalizeDept(e.target.value, departments)
                                                : canonicalizeCountry(e.target.value);
                                            if (canon !== e.target.value) setCell(r, c.key, canon);
                                          }
                                        : undefined
                                    }
                                    className={cn(
                                      'h-9 w-full bg-transparent px-2.5 text-[13px] outline-none placeholder:text-zinc-300',
                                      locked
                                        ? 'cursor-default text-zinc-500 dark:text-zinc-400'
                                        : 'text-zinc-800 focus:bg-emerald-50/80 focus:ring-1 focus:ring-inset focus:ring-emerald-400 dark:text-zinc-100 dark:focus:bg-emerald-950/30',
                                      listId ? cn('min-w-[10rem]', SELECT_SCHEME_CLASS) : 'min-w-[8rem]',
                                    )}
                                  />
                                </td>
                              );
                            })}
                            {!locked && (
                              <td className="border-b border-emerald-50/80 px-1 text-center dark:border-zinc-800/80">
                                <button
                                  type="button"
                                  onClick={() => deleteRow(r, row._key)}
                                  aria-label={`Delete row ${r + 1}`}
                                  className="rounded p-1 text-zinc-300 opacity-0 transition hover:bg-rose-50 hover:text-rose-500 focus:opacity-100 group-hover/row:opacity-100 dark:hover:bg-rose-950/30"
                                >
                                  <Trash2 className="h-3.5 w-3.5" />
                                </button>
                              </td>
                            )}
                          </tr>
                        );
                      })}
                    </tbody>
                  </table>
                </div>
              )}

              {!locked && (
                <div className="flex shrink-0 flex-wrap items-center gap-2">
                  <Button
                    type="button"
                    variant="outline"
                    size="sm"
                    onClick={() => addRows(1)}
                    className="h-8 gap-1.5 border-emerald-200 text-emerald-700 hover:bg-emerald-50 dark:border-emerald-800 dark:text-emerald-300"
                  >
                    <Plus className="h-3.5 w-3.5" />
                    Add row
                  </Button>
                  <Button
                    type="button"
                    variant="ghost"
                    size="sm"
                    onClick={() => addRows(10)}
                    className="h-8 gap-1.5 text-emerald-700 hover:bg-emerald-50 dark:text-emerald-300"
                  >
                    <Plus className="h-3.5 w-3.5" />
                    Add 10 rows
                  </Button>
                </div>
              )}
            </>
          )}
        </div>
      </div>

      {/* Per-cell edit-history popover (fixed portal, anchored to the clicked
          dot; escapes the grid's scroll overflow so it's never clipped). */}
      {historyPopover &&
        typeof document !== 'undefined' &&
        createPortal(
          <div
            data-cell-history-popover
            style={{ position: 'fixed', top: historyPopover.top, left: historyPopover.left, width: 300 }}
            className="z-[100] max-h-80 overflow-auto rounded-xl border border-zinc-200 bg-white shadow-xl shadow-black/10 dark:border-zinc-700 dark:bg-zinc-900"
          >
            <div className="sticky top-0 flex items-center justify-between gap-2 border-b border-zinc-100 bg-white px-3 py-2 dark:border-zinc-800 dark:bg-zinc-900">
              <span className="text-[11px] font-semibold uppercase tracking-wide text-emerald-700 dark:text-emerald-300">
                {historyPopover.label} &middot; edit history
              </span>
              <button
                type="button"
                onClick={() => setHistoryPopover(null)}
                aria-label="Close edit history"
                className="rounded p-0.5 text-zinc-400 hover:bg-zinc-100 hover:text-zinc-700 dark:hover:bg-zinc-800 dark:hover:text-zinc-200"
              >
                <X className="h-3.5 w-3.5" />
              </button>
            </div>
            <ol className="space-y-1 p-1.5">
              {historyPopover.entries.map((en, i) => (
                <li key={i} className="rounded-lg bg-zinc-50 px-2.5 py-1.5 dark:bg-zinc-800/50">
                  <div className="flex items-baseline justify-between gap-2">
                    <span className="truncate text-[12px] font-medium text-zinc-800 dark:text-zinc-100">{en.by}</span>
                    <span className="shrink-0 text-[10.5px] tabular-nums text-zinc-400">{formatLockStamp(en.at)}</span>
                  </div>
                  <div className="mt-1 flex items-center gap-1.5 text-[11.5px]">
                    <span className="max-w-[45%] truncate rounded bg-rose-50 px-1 text-rose-700 line-through decoration-rose-300 dark:bg-rose-950/30 dark:text-rose-300">
                      {en.from ?? 'blank'}
                    </span>
                    <span className="shrink-0 text-zinc-400">&rarr;</span>
                    <span className="max-w-[45%] truncate rounded bg-emerald-50 px-1 text-emerald-700 dark:bg-emerald-950/30 dark:text-emerald-300">
                      {en.to ?? 'blank'}
                    </span>
                  </div>
                </li>
              ))}
            </ol>
          </div>,
          document.body,
        )}
    </div>
  );
}
