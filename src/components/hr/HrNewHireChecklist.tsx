'use client';

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  Building2,
  Check,
  ClipboardList,
  Eraser,
  Info,
  Loader2,
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
  hasHrTabCache,
  setHrTabCache,
  HR_TAB_CACHE_KEYS,
} from '@/lib/hr/tab-cache';
import type { HrNewHireChecklistRow } from '@/lib/supabase/hr-new-hire-checklist';
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

/** A grid row: a stable client `_key`, the DB `id` (null until saved), and one
 *  string per column (empty string = blank cell). */
type GridRow = { _key: string; id: string | null } & Record<FieldKey, string>;

type CacheVal = { rows: GridRow[]; dirty: boolean };

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
  const r = { _key: nextKey(), id: row.id } as GridRow;
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

export default function HrNewHireChecklist() {
  const cached = getHrTabCache<CacheVal>(CACHE_KEY);
  const [rows, setRows] = useState<GridRow[]>(() => cached?.rows ?? []);
  const [dirty, setDirty] = useState<boolean>(() => cached?.dirty ?? false);
  const [loading, setLoading] = useState<boolean>(() => !hasHrTabCache(CACHE_KEY));
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // Pending focus target after a structural change (e.g. Enter adds a row).
  const [focusCell, setFocusCell] = useState<{ r: number; c: number } | null>(null);
  const scrollRef = useRef<HTMLDivElement>(null);
  // Department options for the constrained dropdown — same source as the
  // onboarding Bulk Invite (/api/departments), so a picked department matches
  // there exactly and the batch is detected.
  const [departments, setDepartments] = useState<string[]>([]);
  // Row multiselect → bulk-apply one department to many people at once. Keyed by
  // the stable row `_key` so selection survives edits/paste (a stale key just
  // matches no row; cleared on save/refresh when rows get fresh keys).
  const [selectedKeys, setSelectedKeys] = useState<Set<string>>(() => new Set());
  const [bulkDept, setBulkDept] = useState('');
  const [bulkCountry, setBulkCountry] = useState('');
  const selectAllRef = useRef<HTMLInputElement>(null);

  const fetchAll = useCallback(async (opts: { silent?: boolean } = {}) => {
    if (!opts.silent) setLoading(true);
    setError(null);
    try {
      const res = await fetch('/api/hr/new-hire-checklist', { cache: 'no-store' });
      const json = (await res.json()) as { rows?: HrNewHireChecklistRow[]; error?: string };
      if (!res.ok || json.error) throw new Error(json.error || `Request failed (${res.status})`);
      const fresh = (json.rows ?? []).map(fromServer);
      setRows(fresh.length ? fresh : seedBlank(6));
      setDirty(false);
      setSelectedKeys(new Set());
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Failed to load the checklist');
    } finally {
      setLoading(false);
    }
  }, []);

  // Skip the initial fetch when the cache is warm so in-progress (unsaved) edits
  // survive a tab switch; the manual Refresh button pulls fresh server state.
  useEffect(() => {
    if (hasHrTabCache(CACHE_KEY)) return;
    void fetchAll();
  }, [fetchAll]);

  // Load the department dropdown options (best-effort; a failure just leaves the
  // Department cell as a free-text input so entry is never blocked).
  useEffect(() => {
    let cancelled = false;
    fetch('/api/departments', { cache: 'no-store' })
      .then((r) => r.json())
      .then((j: { departments?: string[] }) => {
        if (!cancelled) setDepartments(j.departments ?? []);
      })
      .catch(() => { /* leave departments empty → text-input fallback */ });
    return () => { cancelled = true; };
  }, []);

  // Mirror grid + dirty state into the per-session tab cache on every change.
  useEffect(() => {
    setHrTabCache<CacheVal>(CACHE_KEY, { rows, dirty });
  }, [rows, dirty]);

  // Focus (and select) a cell after a structural change lands in the DOM.
  useEffect(() => {
    if (!focusCell) return;
    const el = scrollRef.current?.querySelector<HTMLElement>(
      `[data-cell="${focusCell.r}-${focusCell.c}"]`,
    );
    if (el) {
      el.focus();
      if (el instanceof HTMLInputElement) el.select();
    }
    setFocusCell(null);
  }, [focusCell, rows.length]);

  const setCell = useCallback((r: number, key: FieldKey, value: string) => {
    setRows((prev) => prev.map((row, i) => (i === r ? { ...row, [key]: value } : row)));
    setDirty(true);
  }, []);

  const handlePaste = useCallback(
    (e: React.ClipboardEvent<HTMLInputElement>, r: number, c: number) => {
      const text = e.clipboardData?.getData('text/plain') ?? '';
      if (!text) return;
      const matrix = parseClipboard(text);
      // A single value (no tabs/newlines) pastes natively into the one cell.
      if (matrix.length === 1 && matrix[0]!.length === 1) return;

      e.preventDefault();
      setRows((prev) => {
        const next = prev.map((row) => ({ ...row }));
        for (let i = 0; i < matrix.length; i++) {
          const targetRow = r + i;
          while (next.length <= targetRow) next.push(blankRow());
          const cells = matrix[i]!;
          for (let j = 0; j < cells.length; j++) {
            const targetCol = c + j;
            if (targetCol >= COLUMNS.length) break; // ignore overflow columns
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
    (e: React.KeyboardEvent<HTMLInputElement | HTMLSelectElement>, r: number, c: number) => {
      // On a <select>, leave Arrow keys to their native option-cycling.
      const isSelect = e.currentTarget.tagName === 'SELECT';
      if (e.key === 'Enter') {
        e.preventDefault();
        const nextR = r + 1;
        setRows((prev) => (nextR >= prev.length ? [...prev, blankRow()] : prev));
        setFocusCell({ r: nextR, c });
      } else if (!isSelect && e.key === 'ArrowDown') {
        e.preventDefault();
        setFocusCell({ r: Math.min(r + 1, rows.length - 1), c });
      } else if (!isSelect && e.key === 'ArrowUp') {
        e.preventDefault();
        setFocusCell({ r: Math.max(r - 1, 0), c });
      }
    },
    [rows.length],
  );

  const addRows = useCallback((n: number) => {
    setRows((prev) => [...prev, ...seedBlank(n)]);
    setDirty(true);
  }, []);

  const clearColumn = useCallback((key: FieldKey, label: string) => {
    setRows((prev) => prev.map((row) => ({ ...row, [key]: '' })));
    setDirty(true);
    toast.success(`Cleared the ${label} column`);
  }, []);

  const deleteRow = useCallback((r: number, key: string) => {
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

  const refresh = useCallback(() => {
    if (dirty && !window.confirm('Discard unsaved changes and reload from the server?')) return;
    void fetchAll();
  }, [dirty, fetchAll]);

  const save = useCallback(async () => {
    setSaving(true);
    setError(null);
    try {
      const res = await fetch('/api/hr/new-hire-checklist', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ rows: toPayload(rows) }),
      });
      const json = (await res.json()) as { rows?: HrNewHireChecklistRow[]; error?: string };
      if (!res.ok || json.error) throw new Error(json.error || `Save failed (${res.status})`);
      const fresh = (json.rows ?? []).map(fromServer);
      setRows(fresh.length ? fresh : seedBlank(6));
      setDirty(false);
      setSelectedKeys(new Set());
      toast.success('New hire checklist saved');
    } catch (e) {
      toast.error(e instanceof Error ? e.message : 'Save failed');
    } finally {
      setSaving(false);
    }
  }, [rows]);

  const filledCount = useMemo(() => rows.filter((r) => !rowIsBlank(r)).length, [rows]);

  // ── Row multiselect → bulk-apply department / delete ──
  const selectedCount = selectedKeys.size;
  const allSelected = rows.length > 0 && rows.every((r) => selectedKeys.has(r._key));

  // Reflect "some but not all selected" on the header checkbox.
  useEffect(() => {
    if (selectAllRef.current) {
      selectAllRef.current.indeterminate = selectedCount > 0 && !allSelected;
    }
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
      const v = value.trim();
      if (!v || selectedKeys.size === 0) return;
      const n = selectedKeys.size;
      setRows((prev) =>
        prev.map((row) => (selectedKeys.has(row._key) ? { ...row, [field]: v } : row)),
      );
      setDirty(true);
      toast.success(`Set ${field} on ${n} ${n === 1 ? 'hire' : 'hires'} to ${v}`);
    },
    [selectedKeys],
  );

  const deleteSelected = useCallback(() => {
    if (selectedKeys.size === 0) return;
    setRows((prev) => {
      const next = prev.filter((row) => !selectedKeys.has(row._key));
      return next.length ? next : seedBlank(1);
    });
    setSelectedKeys(new Set());
    setDirty(true);
  }, [selectedKeys]);

  return (
    <div className="flex h-full min-h-0 flex-col">
      {/* Header */}
      <div className="shrink-0 border-b border-emerald-100/70 bg-white px-4 py-3 sm:px-6 sm:py-5 dark:border-emerald-950/40 dark:bg-[#0d1117]">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div className="min-w-0">
            <h1 className="flex items-center gap-2 text-base font-semibold tracking-tight text-zinc-900 sm:text-xl dark:text-white">
              <ClipboardList className="h-5 w-5 text-emerald-600 dark:text-emerald-400" />
              New Hire Checklist
            </h1>
            <p className="mt-0.5 text-xs text-zinc-500 dark:text-zinc-500">
              Paste each column straight from your spreadsheet, then Save to lock it in.
              {filledCount > 0 && (
                <span className="ml-1 font-medium text-emerald-700 dark:text-emerald-400">
                  {filledCount} {filledCount === 1 ? 'hire' : 'hires'}.
                </span>
              )}
            </p>
          </div>
          <div className="flex items-center gap-2">
            {dirty && (
              <span className="flex items-center gap-1.5 text-[11px] font-medium text-amber-600 dark:text-amber-400">
                <span className="h-1.5 w-1.5 animate-pulse rounded-full bg-amber-500" />
                Unsaved changes
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
              Refresh
            </Button>
            <Button
              type="button"
              size="sm"
              onClick={() => void save()}
              disabled={saving || loading || !dirty}
              className="h-8 gap-1.5 bg-emerald-600 text-white hover:bg-emerald-700 disabled:opacity-50"
            >
              {saving ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Save className="h-3.5 w-3.5" />}
              Save
            </Button>
          </div>
        </div>
      </div>

      <div className="min-h-0 flex-1 overflow-hidden bg-[#fafaf8] px-3 py-4 sm:px-6 sm:py-6 dark:bg-[#0d1117]">
        <div className="flex h-full min-h-0 flex-col gap-3">
          {/* Paste hint */}
          <div className="flex items-start gap-2 rounded-xl border border-emerald-200 bg-emerald-50/70 px-3.5 py-2.5 text-[12px] leading-snug text-emerald-800 dark:border-emerald-500/30 dark:bg-emerald-950/20 dark:text-emerald-300">
            <Info className="mt-0.5 h-3.5 w-3.5 shrink-0" />
            <span>
              Copy a column from Excel / Google Sheets and paste it into any cell — it fills straight
              down. <strong>Department</strong> and <strong>Country</strong> offer a dropdown but can also be
              typed or pasted (they snap to a valid option). Tick rows and use the bulk bar to apply a
              department / country to many at once. Press <strong>Enter</strong> to move down a row. Once
              saved, these rows feed the per-country <strong>Bulk Invite</strong> in Onboarding.
            </span>
          </div>

          {/* Bulk action bar — tick rows, then apply one department / country to all at once. */}
          {!loading && !error && selectedCount > 0 && (
            <div className="flex shrink-0 flex-wrap items-center gap-x-2 gap-y-2 rounded-xl border border-emerald-300 bg-emerald-50 px-3 py-2 shadow-sm dark:border-emerald-700 dark:bg-emerald-950/40">
              <span className="flex items-center gap-1.5 text-[12px] font-semibold text-emerald-800 dark:text-emerald-200">
                <Building2 className="h-3.5 w-3.5" />
                {selectedCount} selected
              </span>

              {/* Apply a department to all selected */}
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
                    <option key={d} value={d} className={SELECT_OPTION_CLASS}>
                      {d}
                    </option>
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

              {/* Apply a country to all selected */}
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
                  <option key={c} value={c} className={SELECT_OPTION_CLASS}>
                    {c}
                  </option>
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
              Loading checklist…
            </div>
          ) : error ? (
            <div className="rounded-xl border border-dashed border-rose-200 bg-white py-10 text-center text-sm text-rose-600 dark:border-rose-500/30 dark:bg-[#0d1117]">
              {error}
            </div>
          ) : (
            <>
              {/* Dropdown sources for the Department + Country comboboxes (the
                  cells are text inputs with `list=`, so they paste/type freely). */}
              <datalist id="nhc-departments">
                {departments.map((d) => (
                  <option key={d} value={d} />
                ))}
              </datalist>
              <datalist id="nhc-countries">
                {COUNTRY_OPTIONS.map((c) => (
                  <option key={c} value={c} />
                ))}
              </datalist>

              <div
                ref={scrollRef}
                className="min-h-0 flex-1 overflow-auto rounded-2xl border border-emerald-100/80 bg-white shadow-sm dark:border-emerald-950/40 dark:bg-zinc-950"
              >
                <table className="table-keep w-full border-collapse text-[13px]">
                  <thead className="sticky top-0 z-10">
                    <tr className="bg-emerald-50/90 backdrop-blur dark:bg-emerald-950/40">
                      <th className="sticky left-0 z-20 w-14 border-b border-r border-emerald-100/80 bg-emerald-50/90 px-1 py-2 text-center backdrop-blur dark:border-emerald-950/40 dark:bg-emerald-950/40">
                        <input
                          ref={selectAllRef}
                          type="checkbox"
                          checked={allSelected}
                          onChange={toggleAll}
                          aria-label="Select all rows"
                          className="h-3.5 w-3.5 cursor-pointer align-middle accent-emerald-600"
                        />
                      </th>
                      {COLUMNS.map((c) => (
                        <th
                          key={c.key}
                          className="group/col whitespace-nowrap border-b border-emerald-100/80 px-2.5 py-2 text-left text-[11.5px] font-semibold uppercase tracking-wide text-emerald-700 dark:border-emerald-950/40 dark:text-emerald-300"
                        >
                          <div className="flex items-center justify-between gap-2">
                            <span>{c.label}</span>
                            <button
                              type="button"
                              onClick={() => clearColumn(c.key, c.label)}
                              aria-label={`Clear the ${c.label} column`}
                              title={`Clear the ${c.label} column`}
                              className="shrink-0 rounded p-0.5 text-emerald-400 opacity-0 transition hover:bg-emerald-100 hover:text-emerald-700 focus:opacity-100 group-hover/col:opacity-100 dark:text-emerald-600 dark:hover:bg-emerald-900/40 dark:hover:text-emerald-200"
                            >
                              <Eraser className="h-3 w-3" />
                            </button>
                          </div>
                        </th>
                      ))}
                      <th className="w-10 border-b border-emerald-100/80 px-1 py-2 dark:border-emerald-950/40" />
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
                          isSelected
                            ? 'bg-emerald-50 dark:bg-emerald-950/30'
                            : 'even:bg-zinc-50/40 dark:even:bg-zinc-900/30',
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
                            <input
                              type="checkbox"
                              checked={isSelected}
                              onChange={() => toggleRow(row._key)}
                              aria-label={`Select row ${r + 1}`}
                              className="h-3.5 w-3.5 cursor-pointer accent-emerald-600"
                            />
                            <span className="tabular-nums text-[11px] text-zinc-400">{r + 1}</span>
                          </div>
                        </td>
                        {COLUMNS.map((c, ci) => {
                          const value = row[c.key];
                          // Department + Country are comboboxes: a <datalist> dropdown
                          // of valid values on a plain text input, so they can be
                          // picked OR typed / pasted like every other column. A typed /
                          // pasted value snaps to the canonical option on blur.
                          // Department drops the dropdown (plain input) until
                          // /api/departments loads.
                          const listId =
                            c.key === 'department'
                              ? departments.length > 0
                                ? 'nhc-departments'
                                : undefined
                              : c.key === 'country'
                                ? 'nhc-countries'
                                : undefined;
                          return (
                          <td
                            key={c.key}
                            className="border-b border-emerald-50/80 p-0 dark:border-zinc-800/80"
                          >
                            <input
                              data-cell={`${r}-${ci}`}
                              list={listId}
                              value={value}
                              onChange={(e) => setCell(r, c.key, e.target.value)}
                              onPaste={(e) => handlePaste(e, r, ci)}
                              onKeyDown={(e) => handleKeyDown(e, r, ci)}
                              onBlur={
                                listId
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
                                'h-9 w-full bg-transparent px-2.5 text-[13px] text-zinc-800 outline-none placeholder:text-zinc-300 focus:bg-emerald-50/80 focus:ring-1 focus:ring-inset focus:ring-emerald-400 dark:text-zinc-100 dark:focus:bg-emerald-950/30',
                                listId ? cn('min-w-[10rem]', SELECT_SCHEME_CLASS) : 'min-w-[8rem]',
                              )}
                            />
                          </td>
                          );
                        })}
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
                      </tr>
                      );
                    })}
                  </tbody>
                </table>
              </div>

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
            </>
          )}
        </div>
      </div>
    </div>
  );
}
