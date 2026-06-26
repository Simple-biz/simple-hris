'use client';

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  ClipboardList,
  Info,
  Loader2,
  Plus,
  RefreshCw,
  Save,
  Trash2,
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

/** Grid columns, in display order. Keys match the DB / API field names 1:1. */
const COLUMNS = [
  { key: 'name', label: 'Names' },
  { key: 'personal_email', label: 'Personal Email' },
  { key: 'start_date', label: 'Start Date' },
  { key: 'location', label: 'Location' },
  { key: 'phone_number', label: 'Phone Number' },
  { key: 'date_of_interview', label: 'Date of Interview' },
  { key: 'source', label: 'Source' },
  { key: 'hired_by', label: 'Hired By' },
  { key: 'department', label: 'Department' },
] as const;

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

  // Mirror grid + dirty state into the per-session tab cache on every change.
  useEffect(() => {
    setHrTabCache<CacheVal>(CACHE_KEY, { rows, dirty });
  }, [rows, dirty]);

  // Focus (and select) a cell after a structural change lands in the DOM.
  useEffect(() => {
    if (!focusCell) return;
    const el = scrollRef.current?.querySelector<HTMLInputElement>(
      `input[data-cell="${focusCell.r}-${focusCell.c}"]`,
    );
    if (el) {
      el.focus();
      el.select();
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
            next[targetRow]![COLUMNS[targetCol]!.key] = cells[j]!.trim();
          }
        }
        return next;
      });
      setDirty(true);
    },
    [],
  );

  const handleKeyDown = useCallback(
    (e: React.KeyboardEvent<HTMLInputElement>, r: number, c: number) => {
      if (e.key === 'Enter') {
        e.preventDefault();
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
    setRows((prev) => [...prev, ...seedBlank(n)]);
    setDirty(true);
  }, []);

  const deleteRow = useCallback((r: number) => {
    setRows((prev) => {
      const next = prev.filter((_, i) => i !== r);
      return next.length ? next : seedBlank(1);
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
      toast.success('New hire checklist saved');
    } catch (e) {
      toast.error(e instanceof Error ? e.message : 'Save failed');
    } finally {
      setSaving(false);
    }
  }, [rows]);

  const filledCount = useMemo(() => rows.filter((r) => !rowIsBlank(r)).length, [rows]);

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
              down that column. Paste a whole block to fill a grid. Press <strong>Enter</strong> to move
              down a row. Once saved, these rows feed the department <strong>Bulk Invite</strong> in
              Onboarding.
            </span>
          </div>

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
              <div
                ref={scrollRef}
                className="min-h-0 flex-1 overflow-auto rounded-2xl border border-emerald-100/80 bg-white shadow-sm dark:border-emerald-950/40 dark:bg-zinc-950"
              >
                <table className="table-keep w-full border-collapse text-[13px]">
                  <thead className="sticky top-0 z-10">
                    <tr className="bg-emerald-50/90 backdrop-blur dark:bg-emerald-950/40">
                      <th className="sticky left-0 z-20 w-10 border-b border-r border-emerald-100/80 bg-emerald-50/90 px-1 py-2 text-center text-[11px] font-semibold text-emerald-700 backdrop-blur dark:border-emerald-950/40 dark:bg-emerald-950/40 dark:text-emerald-300">
                        #
                      </th>
                      {COLUMNS.map((c) => (
                        <th
                          key={c.key}
                          className="whitespace-nowrap border-b border-emerald-100/80 px-2.5 py-2 text-left text-[11.5px] font-semibold uppercase tracking-wide text-emerald-700 dark:border-emerald-950/40 dark:text-emerald-300"
                        >
                          {c.label}
                        </th>
                      ))}
                      <th className="w-10 border-b border-emerald-100/80 px-1 py-2 dark:border-emerald-950/40" />
                    </tr>
                  </thead>
                  <tbody>
                    {rows.map((row, r) => (
                      <tr
                        key={row._key}
                        className="group/row even:bg-zinc-50/40 hover:bg-emerald-50/40 dark:even:bg-zinc-900/30 dark:hover:bg-emerald-950/20"
                      >
                        <td className="sticky left-0 z-[1] border-b border-r border-emerald-50 bg-white px-1 py-0 text-center text-[11px] tabular-nums text-zinc-400 group-even/row:bg-zinc-50/40 group-hover/row:bg-emerald-50/40 dark:border-zinc-800 dark:bg-zinc-950 dark:group-even/row:bg-zinc-900/30">
                          {r + 1}
                        </td>
                        {COLUMNS.map((c, ci) => (
                          <td
                            key={c.key}
                            className="border-b border-emerald-50/80 p-0 dark:border-zinc-800/80"
                          >
                            <input
                              data-cell={`${r}-${ci}`}
                              value={row[c.key]}
                              onChange={(e) => setCell(r, c.key, e.target.value)}
                              onPaste={(e) => handlePaste(e, r, ci)}
                              onKeyDown={(e) => handleKeyDown(e, r, ci)}
                              className="h-9 w-full min-w-[8rem] bg-transparent px-2.5 text-[13px] text-zinc-800 outline-none placeholder:text-zinc-300 focus:bg-emerald-50/80 focus:ring-1 focus:ring-inset focus:ring-emerald-400 dark:text-zinc-100 dark:focus:bg-emerald-950/30"
                            />
                          </td>
                        ))}
                        <td className="border-b border-emerald-50/80 px-1 text-center dark:border-zinc-800/80">
                          <button
                            type="button"
                            onClick={() => deleteRow(r)}
                            aria-label={`Delete row ${r + 1}`}
                            className="rounded p-1 text-zinc-300 opacity-0 transition hover:bg-rose-50 hover:text-rose-500 focus:opacity-100 group-hover/row:opacity-100 dark:hover:bg-rose-950/30"
                          >
                            <Trash2 className="h-3.5 w-3.5" />
                          </button>
                        </td>
                      </tr>
                    ))}
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
