'use client';

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { motion, useReducedMotion } from 'motion/react';
import {
  Building2,
  CalendarDays,
  Check,
  ChevronDown,
  ChevronLeft,
  ChevronRight,
  ClipboardList,
  Download,
  Filter,
  Info,
  Loader2,
  Lock,
  LockOpen,
  Pencil,
  RefreshCw,
  Search,
  Trash2,
  UserPlus,
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
import { useSession } from 'next-auth/react';
import type { CellEditEntry, HrNewHireChecklistRow } from '@/lib/supabase/hr-new-hire-checklist';
import { ONBOARDING_COUNTRIES, resolveOnboardingCountry } from '@/lib/onboarding/countries';
import { BASE_SOURCE_OPTIONS, isReferralSource } from '@/lib/hr/referral-source';
import { useChecklistRoom } from '@/hooks/useChecklistRoom';
import NewHireChecklistLockDialog, { type LockDialogMode } from './NewHireChecklistLockDialog';
import NewHireQuickAddDialog, { type QuickAddValues } from './NewHireQuickAddDialog';
import { formatDeptLabel } from '@/lib/departments/hsl-subdept';

/** Grid columns, in display order. Keys match the DB / API field names 1:1. */
const COLUMNS = [
  { key: 'name', label: 'Names' },
  { key: 'personal_email', label: 'Personal Email' },
  { key: 'location', label: 'Location' },
  { key: 'phone_number', label: 'Phone Number' },
  { key: 'date_of_interview', label: 'Date of Interview' },
  { key: 'source', label: 'Source' },
  { key: 'referred_by', label: 'Referred By' },
  { key: 'hired_by', label: 'Hired By' },
  { key: 'department', label: 'Department' },
  { key: 'country', label: 'Country' },
] as const;

/** The onboarding-supported countries — the bulk-apply Country control offers
 *  these so Bulk Invite can segregate hires into the matching per-country box. */
const COUNTRY_OPTIONS = ONBOARDING_COUNTRIES.map((c) => c.name);

// Native <option> popups don't inherit the app's dark theme — without an
// explicit dark background, the (light) option text renders on a white popup
// and is invisible. Pair this on every <option> with `color-scheme` on the
// <select> so both the closed control and the open list read correctly.
const SELECT_OPTION_CLASS = 'bg-white text-zinc-900 dark:bg-zinc-900 dark:text-zinc-100';
const SELECT_SCHEME_CLASS = '[color-scheme:light] dark:[color-scheme:dark]';

// Shared styling for the filter-bar dropdowns (neutral border so they read as
// "view" controls, distinct from the emerald bulk-apply bar).
const FILTER_SELECT_CLASS =
  'h-8 min-w-[8.5rem] rounded-lg border border-zinc-200 bg-white px-2 text-[13px] text-zinc-800 outline-none focus:border-emerald-400 focus:ring-1 focus:ring-emerald-300 disabled:cursor-not-allowed disabled:opacity-50 dark:border-zinc-700 dark:bg-zinc-900 dark:text-zinc-100';

type FieldKey = (typeof COLUMNS)[number]['key'];

/**
 * A grid row. Every row is server-persisted, so it always has a DB `id` (used as
 * the React key, the selection key, and the co-editing identity). `_updatedAt`
 * is the row's version for optimistic-concurrency edits, and `_editedBy` is the
 * per-column edit-history log loaded from the server (never sent back).
 */
type GridRow = {
  id: string;
  _updatedAt: string | null;
  _editedBy?: Partial<Record<FieldKey, CellEditEntry[]>>;
} & Record<FieldKey, string>;

/** The edit modal's open state: adding a hire, or editing a specific row with a
 *  snapshot of its values + version captured AT OPEN TIME (so the save diffs
 *  against what the editor actually saw and can detect a co-editor's change). */
type EditorState =
  | { mode: 'add' }
  | { mode: 'edit'; id: string; baseUpdatedAt: string | null; base: QuickAddValues }
  | null;

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
  locked: boolean;
  lockedAt: string | null;
  lockedBy: string | null;
  loaded: boolean;
};

const CACHE_KEY = HR_TAB_CACHE_KEYS.newHireChecklist;

// Coalesce a burst of peer "changed" broadcasts into a single refetch.
const REMOTE_REFETCH_DEBOUNCE_MS = 400;

function fromServer(row: HrNewHireChecklistRow): GridRow {
  const r = {
    id: row.id,
    _updatedAt: row.updated_at ?? null,
    _editedBy: row.cell_edits ?? undefined,
  } as GridRow;
  for (const c of COLUMNS) r[c.key] = (row[c.key] ?? '') as string;
  return r;
}

/** A grid row → the modal's field values (for editing an existing row in the
 *  form, and as the diff baseline). Keys line up 1:1 with COLUMNS / QuickAddValues. */
function rowToValues(row: GridRow): QuickAddValues {
  const v = {} as QuickAddValues;
  for (const c of COLUMNS) v[c.key] = row[c.key] ?? '';
  return v;
}

/** Snap a department to the canonical casing from the dropdown list when it
 *  matches case-insensitively (so Bulk Invite detects it exactly); otherwise
 *  keep the raw value so nothing is silently dropped. */
function canonicalizeDept(value: string, departments: string[]): string {
  const t = value.trim();
  if (!t) return '';
  return departments.find((d) => d.toLowerCase() === t.toLowerCase()) ?? t;
}

/** Snap a country to its canonical onboarding name (handles aliases like "USA"
 *  → "United States") so Bulk Invite routes it to the right box; keep raw if
 *  unrecognized. */
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

/** The orientation day for a Sun-anchored week: the MONDAY (start + 1 day),
 *  formatted "Monday, Jul 6, 2026". Mirrors the webhook's ORIENT_OFFSET_DAYS=1. */
function formatOrientationLabel(startIso: string): string {
  if (!startIso) return '—';
  const [y, m, d] = startIso.split('-').map(Number);
  if (!y || !m || !d) return startIso;
  const orient = new Date(y, m - 1, d + 1);
  return orient.toLocaleDateString(undefined, {
    weekday: 'long',
    month: 'short',
    day: 'numeric',
    year: 'numeric',
  });
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

const JSON_HEADERS = { 'Content-Type': 'application/json' };

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
  const [locked, setLocked] = useState<boolean>(() => cached?.locked ?? false);
  const [lockedAt, setLockedAt] = useState<string | null>(() => cached?.lockedAt ?? null);
  const [lockedBy, setLockedBy] = useState<string | null>(() => cached?.lockedBy ?? null);
  const [loaded, setLoaded] = useState<boolean>(() => cached?.loaded ?? false);
  const [loading, setLoading] = useState<boolean>(() => !cached?.loaded);
  const [busy, setBusy] = useState(false); // any in-flight mutation (add/edit/delete/bulk/lock)
  const [error, setError] = useState<string | null>(null);

  // Which password-gated action is being confirmed (null = no dialog).
  const [actionDialog, setActionDialog] = useState<LockDialogMode | null>(null);
  // A lock/reopen requested from the week dropdown for a week that first has to
  // load: we switch to it, then this effect fires the dialog once it's in view.
  const [pendingAction, setPendingAction] = useState<{ period: string; mode: LockDialogMode } | null>(null);

  const scrollRef = useRef<HTMLDivElement>(null);
  const [departments, setDepartments] = useState<string[]>([]);
  // Source dropdown suggestions = the base list ∪ sources already used; Referrers
  // = active-employee names from the Global Master List (fed to the modal).
  const [sourceOptions, setSourceOptions] = useState<string[]>(() => [...BASE_SOURCE_OPTIONS]);
  const [referrers, setReferrers] = useState<string[]>([]);

  // Row multiselect (keyed by DB id, so it survives a live refetch).
  const [selectedIds, setSelectedIds] = useState<Set<string>>(() => new Set());
  const [bulkDept, setBulkDept] = useState('');
  const [bulkCountry, setBulkCountry] = useState('');
  const selectAllRef = useRef<HTMLInputElement>(null);

  // Table filters (Department / Country / Hired By). Each holds the exact value
  // to match, or '' for "all". Options are derived from the loaded week's rows.
  const [filterDept, setFilterDept] = useState('');
  const [filterCountry, setFilterCountry] = useState('');
  const [filterHiredBy, setFilterHiredBy] = useState('');
  // Free-text search across every column of the loaded week (case-insensitive).
  const [search, setSearch] = useState('');

  // Period selector
  const [periodMetas, setPeriodMetas] = useState<PeriodMeta[]>([]);
  const [periodMenuOpen, setPeriodMenuOpen] = useState(false);
  const periodMenuRef = useRef<HTMLDivElement>(null);
  // Export-to-Excel menu (this week / all weeks → one .xlsx sheet per week).
  const [exportMenuOpen, setExportMenuOpen] = useState(false);
  const [exporting, setExporting] = useState<'week' | 'all' | null>(null);
  const exportMenuRef = useRef<HTMLDivElement>(null);
  // Per-cell edit-history popover, anchored to the clicked dot via a fixed
  // portal so the grid's scroll overflow never clips it.
  const [historyPopover, setHistoryPopover] = useState<
    { label: string; entries: CellEditEntry[]; top: number; left: number } | null
  >(null);
  // "New Hire" modal — the glowing CTA opens it in 'add' mode; a row's Edit
  // button opens it in 'edit' mode pre-filled with that row. null = closed.
  const [editor, setEditor] = useState<EditorState>(null);
  const reduceMotion = useReducedMotion();

  // Mutators read the lock through a ref so a locked week can never be edited.
  const lockedRef = useRef(locked);
  useEffect(() => { lockedRef.current = locked; }, [locked]);
  // Latest period in a ref so the (stable) remote-refetch callback reads it.
  const periodRef = useRef(period);
  useEffect(() => { periodRef.current = period; }, [period]);

  const { data: session } = useSession();
  const selfEmail = session?.user?.email ?? null;
  const selfName = session?.user?.name ?? null;

  const fetchPeriod = useCallback(async (p: string, opts?: { silent?: boolean }) => {
    if (!opts?.silent) setLoading(true);
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
      setRows(fresh);
      setLocked(isLocked);
      setLockedAt(json.period?.locked_at ?? null);
      setLockedBy(json.period?.locked_by ?? null);
      // Keep any selection that still points at rows that survived the refetch.
      setSelectedIds((prev) => {
        if (prev.size === 0) return prev;
        const live = new Set(fresh.map((r) => r.id));
        const next = new Set([...prev].filter((id) => live.has(id)));
        return next.size === prev.size ? prev : next;
      });
      setLoaded(true);
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Failed to load the checklist');
    } finally {
      if (!opts?.silent) setLoading(false);
    }
  }, []);

  const loadPeriods = useCallback(async () => {
    try {
      const res = await fetch('/api/hr/new-hire-checklist/periods', { cache: 'no-store' });
      const json = (await res.json()) as { periods?: PeriodMeta[] };
      setPeriodMetas(json.periods ?? []);
    } catch { /* selector still works off the generated rolling weeks */ }
  }, []);

  // A peer changed the week's data — coalesce a burst into one silent refetch so
  // an added / edited / deleted hire shows up live without a loading flash.
  const refetchTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const scheduleRefetch = useCallback(() => {
    if (refetchTimer.current) clearTimeout(refetchTimer.current);
    refetchTimer.current = setTimeout(() => {
      refetchTimer.current = null;
      void fetchPeriod(periodRef.current, { silent: true });
      void loadPeriods();
    }, REMOTE_REFETCH_DEBOUNCE_MS);
  }, [fetchPeriod, loadPeriods]);
  useEffect(() => () => { if (refetchTimer.current) clearTimeout(refetchTimer.current); }, []);

  // ── Realtime room: soft row-lock (who's editing which row) + change fan-out ──
  const { editingByRowId, broadcastChanged, setEditing } = useChecklistRoom({
    selfEmail,
    selfName,
    channel: `hr-nhc-room:${period}`,
    enabled: !!selfEmail && !!period,
    onChanged: scheduleRefetch,
  });

  // Announce which row (if any) this client is editing, so peers see the soft
  // lock. Cleared when the modal closes or drops to 'add'.
  useEffect(() => {
    setEditing(editor?.mode === 'edit' ? editor.id : null);
  }, [editor, setEditing]);

  // Callback ref for the scrollable grid box: keeps `scrollRef` in sync AND
  // registers the element with the HR collab layer so peer cursors anchor to the
  // rows. Fires with `null` when the box unmounts (empty state / tab switch).
  const registerScrollSurface = useCallback(
    (el: HTMLDivElement | null) => {
      scrollRef.current = el;
      onScrollSurfaceChange?.(el);
    },
    [onScrollSurfaceChange],
  );
  useEffect(() => () => onScrollSurfaceChange?.(null), [onScrollSurfaceChange]);

  // Load the selected week's rows + lock state when it isn't already loaded
  // (skipped on a warm cache so tab-switches stay instant).
  useEffect(() => {
    if (!period || loaded) return;
    void fetchPeriod(period);
  }, [period, loaded, fetchPeriod]);

  useEffect(() => { void loadPeriods(); }, [loadPeriods]);

  // Department dropdown options (best-effort; used by the modal + bulk bar).
  useEffect(() => {
    let cancelled = false;
    fetch('/api/departments', { cache: 'no-store' })
      .then((r) => r.json())
      .then((j: { departments?: string[] }) => { if (!cancelled) setDepartments(j.departments ?? []); })
      .catch(() => { /* free-text fallback */ });
    return () => { cancelled = true; };
  }, []);

  // Source suggestions: base list ∪ sources already used (case-insensitive).
  useEffect(() => {
    let cancelled = false;
    fetch('/api/hr/new-hire-checklist/sources', { cache: 'no-store' })
      .then((r) => r.json())
      .then((j: { sources?: { source: string }[] }) => {
        if (cancelled) return;
        const seen = new Set<string>();
        const merged: string[] = [];
        for (const s of [...BASE_SOURCE_OPTIONS, ...((j.sources ?? []).map((x) => x.source))]) {
          const t = (s ?? '').trim();
          if (!t) continue;
          const key = t.toLowerCase();
          if (seen.has(key)) continue;
          seen.add(key);
          merged.push(t);
        }
        setSourceOptions(merged);
      })
      .catch(() => { /* keep the base fallback */ });
    return () => { cancelled = true; };
  }, []);

  // Referrer suggestions: active-employee names from the Global Master List.
  useEffect(() => {
    let cancelled = false;
    fetch('/api/global-master-list/names', { cache: 'no-store' })
      .then((r) => r.json())
      .then((j: { names?: string[] }) => { if (!cancelled) setReferrers(j.names ?? []); })
      .catch(() => { /* free-text fallback */ });
    return () => { cancelled = true; };
  }, []);

  // Mirror state into the per-session tab cache on every change.
  useEffect(() => {
    setHrTabCache<CacheVal>(CACHE_KEY, { period, rows, locked, lockedAt, lockedBy, loaded });
  }, [period, rows, locked, lockedAt, lockedBy, loaded]);

  // A locked week is read-only — never leave the modal or a selection over it.
  useEffect(() => {
    if (locked) { setEditor(null); setSelectedIds(new Set()); }
  }, [locked]);

  // Switching weeks invalidates ids — drop any editor / selection / filters.
  useEffect(() => {
    setEditor(null);
    setSelectedIds(new Set());
    setFilterDept('');
    setFilterCountry('');
    setFilterHiredBy('');
    setSearch('');
  }, [period]);

  // Close the edit-history popover on outside click, Escape, or any scroll.
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

  // Close the export menu on outside click / Escape.
  useEffect(() => {
    if (!exportMenuOpen) return;
    const onDown = (e: MouseEvent) => {
      if (exportMenuRef.current && !exportMenuRef.current.contains(e.target as Node)) setExportMenuOpen(false);
    };
    const onEsc = (e: KeyboardEvent) => { if (e.key === 'Escape') setExportMenuOpen(false); };
    document.addEventListener('mousedown', onDown);
    document.addEventListener('keydown', onEsc);
    return () => {
      document.removeEventListener('mousedown', onDown);
      document.removeEventListener('keydown', onEsc);
    };
  }, [exportMenuOpen]);

  // ── Mutations — each an atomic server write, reconciled from the response ────

  // "New Hire" modal (add) → POST one row. Returns false to keep the modal open
  // on failure (the entry isn't lost).
  const handleQuickAdd = useCallback(
    async (values: QuickAddValues): Promise<boolean> => {
      if (lockedRef.current) return false;
      const payloadValues: Record<string, string> = {};
      for (const c of COLUMNS) {
        const raw = (values[c.key] ?? '').trim();
        payloadValues[c.key] =
          c.key === 'department'
            ? canonicalizeDept(raw, departments)
            : c.key === 'country'
              ? canonicalizeCountry(raw)
              : raw;
      }
      setBusy(true);
      try {
        const res = await fetch('/api/hr/new-hire-checklist', {
          method: 'POST',
          headers: JSON_HEADERS,
          body: JSON.stringify({ period_start: period, period_end: weekEndIso(period), values: payloadValues }),
        });
        const json = (await res.json()) as { row?: HrNewHireChecklistRow; error?: string };
        if (!res.ok || json.error || !json.row) throw new Error(json.error || `Add failed (${res.status})`);
        const row = fromServer(json.row);
        setRows((prev) => [...prev, row]);
        broadcastChanged();
        void loadPeriods();
        setTimeout(() => {
          const el = scrollRef.current;
          if (el) el.scrollTo({ top: el.scrollHeight, behavior: reduceMotion ? 'auto' : 'smooth' });
        }, 60);
        toast.success(`Added ${row.name.trim() || 'new hire'} to ${formatWeekLabel(period)}`);
        return true;
      } catch (e) {
        toast.error(e instanceof Error ? e.message : 'Failed to add the hire');
        return false;
      } finally {
        setBusy(false);
      }
    },
    [departments, period, reduceMotion, broadcastChanged, loadPeriods],
  );

  // "Edit" modal → PATCH only the fields that changed vs the snapshot taken when
  // the modal opened, with optimistic concurrency. On a 409 the server hands
  // back the current row: we refresh the grid + the modal's baseline and keep it
  // open so the editor can re-apply their change on top of the co-editor's.
  const handleEditHire = useCallback(
    async (ed: { id: string; baseUpdatedAt: string | null; base: QuickAddValues }, values: QuickAddValues): Promise<boolean> => {
      if (lockedRef.current) return false;
      const changed: Record<string, string> = {};
      for (const c of COLUMNS) {
        const raw = (values[c.key] ?? '').trim();
        const val =
          c.key === 'department'
            ? canonicalizeDept(raw, departments)
            : c.key === 'country'
              ? canonicalizeCountry(raw)
              : raw;
        if (val !== (ed.base[c.key] ?? '').trim()) changed[c.key] = val;
      }
      if (Object.keys(changed).length === 0) return true; // nothing to do → close

      setBusy(true);
      try {
        const res = await fetch('/api/hr/new-hire-checklist', {
          method: 'PATCH',
          headers: JSON_HEADERS,
          body: JSON.stringify({ period_start: period, id: ed.id, values: changed, expectedUpdatedAt: ed.baseUpdatedAt }),
        });
        const json = (await res.json()) as { row?: HrNewHireChecklistRow; conflict?: boolean; error?: string };
        if (res.status === 409 && json.row) {
          const fresh = fromServer(json.row);
          setRows((prev) => prev.map((r) => (r.id === fresh.id ? fresh : r)));
          setEditor((prev) =>
            prev?.mode === 'edit' && prev.id === fresh.id
              ? { ...prev, baseUpdatedAt: fresh._updatedAt, base: rowToValues(fresh) }
              : prev,
          );
          toast.error('Someone else just changed this hire — the latest values are loaded. Review and save again.');
          return false; // keep the modal open with the refreshed baseline
        }
        if (!res.ok || json.error || !json.row) throw new Error(json.error || `Save failed (${res.status})`);
        const fresh = fromServer(json.row);
        setRows((prev) => prev.map((r) => (r.id === fresh.id ? fresh : r)));
        broadcastChanged();
        toast.success(`Updated ${(values.name || '').trim() || 'hire'}`);
        return true;
      } catch (e) {
        toast.error(e instanceof Error ? e.message : 'Failed to save the hire');
        return false;
      } finally {
        setBusy(false);
      }
    },
    [departments, period, broadcastChanged],
  );

  const deleteIds = useCallback(
    async (ids: string[]) => {
      if (lockedRef.current || ids.length === 0) return;
      setBusy(true);
      try {
        const res = await fetch('/api/hr/new-hire-checklist', {
          method: 'DELETE',
          headers: JSON_HEADERS,
          body: JSON.stringify({ period_start: period, ids }),
        });
        const json = (await res.json()) as { deleted?: number; error?: string };
        if (!res.ok || json.error) throw new Error(json.error || `Delete failed (${res.status})`);
        const gone = new Set(ids);
        setRows((prev) => prev.filter((r) => !gone.has(r.id)));
        setSelectedIds((prev) => {
          const next = new Set([...prev].filter((id) => !gone.has(id)));
          return next.size === prev.size ? prev : next;
        });
        broadcastChanged();
        void loadPeriods();
        const n = json.deleted ?? ids.length;
        toast.success(`Deleted ${n} ${n === 1 ? 'hire' : 'hires'}`);
      } catch (e) {
        toast.error(e instanceof Error ? e.message : 'Failed to delete');
      } finally {
        setBusy(false);
      }
    },
    [period, broadcastChanged, loadPeriods],
  );

  const deleteRow = useCallback(
    (id: string, name: string) => {
      if (lockedRef.current) return;
      if (!window.confirm(`Delete ${name.trim() || 'this hire'} from ${formatWeekLabel(period)}? This can't be undone.`)) return;
      void deleteIds([id]);
    },
    [period, deleteIds],
  );

  const deleteSelected = useCallback(() => {
    if (lockedRef.current) return;
    const ids = [...selectedIds];
    if (ids.length === 0) return;
    if (!window.confirm(`Delete ${ids.length} ${ids.length === 1 ? 'hire' : 'hires'}? This can't be undone.`)) return;
    void deleteIds(ids);
  }, [selectedIds, deleteIds]);

  const applyToSelected = useCallback(
    async (field: 'department' | 'country', value: string) => {
      if (lockedRef.current) return;
      const v = value.trim();
      const ids = [...selectedIds];
      if (!v || ids.length === 0) return;
      setBusy(true);
      try {
        const res = await fetch('/api/hr/new-hire-checklist', {
          method: 'PATCH',
          headers: JSON_HEADERS,
          body: JSON.stringify({ period_start: period, ids, field, value: v }),
        });
        const json = (await res.json()) as { rows?: HrNewHireChecklistRow[]; error?: string };
        if (!res.ok || json.error) throw new Error(json.error || `Update failed (${res.status})`);
        const byId = new Map((json.rows ?? []).map((r) => [r.id, fromServer(r)]));
        setRows((prev) => prev.map((r) => byId.get(r.id) ?? r));
        broadcastChanged();
        toast.success(`Set ${field} on ${ids.length} ${ids.length === 1 ? 'hire' : 'hires'} to ${v}`);
      } catch (e) {
        toast.error(e instanceof Error ? e.message : 'Failed to apply');
      } finally {
        setBusy(false);
      }
    },
    [selectedIds, period, broadcastChanged],
  );

  // ── Lock / reopen (rows are already persisted; lock only freezes + emails) ───
  const lockWeek = useCallback(async (): Promise<boolean> => {
    if (!period) return false;
    setBusy(true);
    setError(null);
    try {
      const res = await fetch('/api/hr/new-hire-checklist', {
        method: 'PUT',
        headers: JSON_HEADERS,
        body: JSON.stringify({ period_start: period, period_end: weekEndIso(period), action: 'lock' }),
      });
      const json = (await res.json()) as {
        rows?: HrNewHireChecklistRow[];
        period?: { status?: string; locked_at?: string | null; locked_by?: string | null };
        webhook?: {
          fired: boolean;
          count: number;
          error: string | null;
          skipped?: { name: string | null; personal_email: string | null }[];
        };
        error?: string;
      };
      if (!res.ok || json.error) throw new Error(json.error || `Lock failed (${res.status})`);
      const fresh = (json.rows ?? []).map(fromServer);
      setRows(fresh);
      setLocked(true);
      setLockedAt(json.period?.locked_at ?? null);
      setLockedBy(json.period?.locked_by ?? null);
      setSelectedIds(new Set());
      broadcastChanged();
      void loadPeriods();
      toast.success(`Locked in ${fresh.length} ${fresh.length === 1 ? 'hire' : 'hires'} for ${formatWeekLabel(period)}`);
      // Hires whose email cell holds no usable address were left out of the
      // orientation send — tell HR exactly who, or they silently get nothing.
      const skipped = json.webhook?.skipped ?? [];
      if (skipped.length > 0) {
        toast.warning(
          `${skipped.length} ${skipped.length === 1 ? 'hire' : 'hires'} got NO orientation email (invalid address): ` +
            skipped.map((s) => `${s.name ?? 'Unnamed'} (${s.personal_email || 'no email'})`).join(', ') +
            '. Fix the email cell, then resend.',
          { duration: Infinity, closeButton: true },
        );
      } else if (json.webhook && json.webhook.fired && json.webhook.error) {
        toast.warning(`Week locked, but the orientation email automation failed: ${json.webhook.error}`);
      }
      return true;
    } catch (e) {
      toast.error(e instanceof Error ? e.message : 'Lock failed');
      return false;
    } finally {
      setBusy(false);
    }
  }, [period, broadcastChanged, loadPeriods]);

  const reopen = useCallback(async (): Promise<boolean> => {
    if (!period) return false;
    setBusy(true);
    setError(null);
    try {
      const res = await fetch('/api/hr/new-hire-checklist', {
        method: 'PUT',
        headers: JSON_HEADERS,
        body: JSON.stringify({ period_start: period, action: 'reopen' }),
      });
      const json = (await res.json()) as { rows?: HrNewHireChecklistRow[]; error?: string };
      if (!res.ok || json.error) throw new Error(json.error || `Reopen failed (${res.status})`);
      setRows((json.rows ?? []).map(fromServer));
      setLocked(false);
      setLockedAt(null);
      setLockedBy(null);
      broadcastChanged();
      void loadPeriods();
      toast.success(`Reopened ${formatWeekLabel(period)} for editing`);
      return true;
    } catch (e) {
      toast.error(e instanceof Error ? e.message : 'Reopen failed');
      return false;
    } finally {
      setBusy(false);
    }
  }, [period, broadcastChanged, loadPeriods]);

  // Run the password-gated action the dialog just confirmed; close only on
  // success (a failure keeps it open so the passphrase can be retried).
  const runGatedAction = useCallback(async (): Promise<boolean> => {
    const ok = actionDialog === 'lock' ? await lockWeek() : await reopen();
    if (ok) setActionDialog(null);
    return ok;
  }, [actionDialog, lockWeek, reopen]);

  // Lock / reopen a specific week from the dropdown. If it isn't the active week
  // we switch to it first (so the HR Manager sees what they're acting on), then
  // the effect below opens the dialog once it's loaded.
  const startPeriodAction = useCallback((targetPeriod: string, mode: LockDialogMode) => {
    setPeriodMenuOpen(false);
    if (targetPeriod === period && loaded && !loading) {
      setActionDialog(mode);
      return;
    }
    if (targetPeriod !== period) {
      setPeriod(targetPeriod);
      setLoaded(false);
    }
    setPendingAction({ period: targetPeriod, mode });
  }, [period, loaded, loading]);

  useEffect(() => {
    if (!pendingAction) return;
    if (pendingAction.period !== period || loading || !loaded) return;
    setActionDialog(pendingAction.mode);
    setPendingAction(null);
  }, [pendingAction, period, loading, loaded]);

  const changePeriod = useCallback((p: string) => {
    setPeriodMenuOpen(false);
    if (p === period) return;
    setPeriod(p);
    setLoaded(false);
  }, [period]);

  const refresh = useCallback(() => {
    void fetchPeriod(period);
    void loadPeriods();
  }, [period, fetchPeriod, loadPeriods]);

  // Download a multi-sheet .xlsx workbook (one sheet per week).
  const exportWorkbook = useCallback(async (scope: 'week' | 'all') => {
    setExportMenuOpen(false);
    setExporting(scope);
    try {
      const url =
        scope === 'week'
          ? `/api/hr/new-hire-checklist/export?scope=week&period=${encodeURIComponent(period)}`
          : '/api/hr/new-hire-checklist/export?scope=all';
      const res = await fetch(url, { cache: 'no-store' });
      if (!res.ok) {
        let msg = `Export failed (${res.status})`;
        try {
          const j = (await res.json()) as { error?: string };
          if (j.error) msg = j.error;
        } catch { /* non-JSON body — keep the status message */ }
        throw new Error(msg);
      }
      const blob = await res.blob();
      const cd = res.headers.get('Content-Disposition') ?? '';
      const named = /filename="?([^"]+)"?/.exec(cd)?.[1];
      const filename = named ?? (scope === 'week' ? `new-hire-checklist-${period}.xlsx` : 'new-hire-checklist-all-weeks.xlsx');
      const objectUrl = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = objectUrl;
      a.download = filename;
      document.body.appendChild(a);
      a.click();
      document.body.removeChild(a);
      setTimeout(() => URL.revokeObjectURL(objectUrl), 200);
      toast.success(scope === 'week' ? `Exported ${formatWeekLabel(period)}` : 'Exported all weeks');
    } catch (e) {
      toast.error(e instanceof Error ? e.message : 'Export failed');
    } finally {
      setExporting(null);
    }
  }, [period]);

  const hireCount = rows.length;

  // ── Filters: distinct Department / Country / Hired By values present this week
  // (sorted, blanks dropped), used to populate the filter-bar dropdowns. ──
  const filterOptions = useMemo(() => {
    const dept = new Set<string>();
    const country = new Set<string>();
    const hiredBy = new Set<string>();
    for (const row of rows) {
      const d = (row.department || '').trim();
      if (d) dept.add(d);
      const c = (row.country || '').trim();
      if (c) country.add(c);
      const h = (row.hired_by || '').trim();
      if (h) hiredBy.add(h);
    }
    const sorted = (s: Set<string>) => [...s].sort((a, b) => a.localeCompare(b));
    return { departments: sorted(dept), countries: sorted(country), hiredBy: sorted(hiredBy) };
  }, [rows]);

  const searchQuery = search.trim().toLowerCase();
  const anyFilterActive = !!(filterDept || filterCountry || filterHiredBy || searchQuery);

  // The rows actually shown — `rows` narrowed by the active filters + search.
  const filteredRows = useMemo(() => {
    if (!anyFilterActive) return rows;
    return rows.filter((row) => {
      if (filterDept && (row.department || '').trim() !== filterDept) return false;
      if (filterCountry && (row.country || '').trim() !== filterCountry) return false;
      if (filterHiredBy && (row.hired_by || '').trim() !== filterHiredBy) return false;
      if (searchQuery && !COLUMNS.some((c) => (row[c.key] || '').toLowerCase().includes(searchQuery))) return false;
      return true;
    });
  }, [rows, anyFilterActive, filterDept, filterCountry, filterHiredBy, searchQuery]);

  // Drop a filter whose value no longer exists in the loaded rows (e.g. after
  // deleting the last hire in that department) so the grid can't get stuck empty.
  useEffect(() => {
    if (filterDept && !filterOptions.departments.includes(filterDept)) setFilterDept('');
    if (filterCountry && !filterOptions.countries.includes(filterCountry)) setFilterCountry('');
    if (filterHiredBy && !filterOptions.hiredBy.includes(filterHiredBy)) setFilterHiredBy('');
  }, [filterOptions, filterDept, filterCountry, filterHiredBy]);

  const clearFilters = useCallback(() => {
    setFilterDept('');
    setFilterCountry('');
    setFilterHiredBy('');
    setSearch('');
  }, []);

  // Changing a filter changes which rows are visible — drop the selection so a
  // bulk apply / delete can never hit a row that's currently hidden.
  useEffect(() => { setSelectedIds(new Set()); }, [filterDept, filterCountry, filterHiredBy, searchQuery]);

  // ── Row multiselect → bulk-apply department / country / delete ──
  // Selection acts on the *visible* (filtered) rows so "select all" is intuitive.
  const selectedCount = selectedIds.size;
  const allSelected = filteredRows.length > 0 && filteredRows.every((r) => selectedIds.has(r.id));

  useEffect(() => {
    if (selectAllRef.current) selectAllRef.current.indeterminate = selectedCount > 0 && !allSelected;
  }, [selectedCount, allSelected]);

  const toggleRow = useCallback((id: string) => {
    setSelectedIds((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }, []);

  const toggleAll = useCallback(() => {
    setSelectedIds((prev) => {
      const everySelected = filteredRows.length > 0 && filteredRows.every((r) => prev.has(r.id));
      return everySelected ? new Set() : new Set(filteredRows.map((r) => r.id));
    });
  }, [filteredRows]);

  const clearSelection = useCallback(() => setSelectedIds(new Set()), []);

  const openAdd = useCallback(() => setEditor({ mode: 'add' }), []);
  const openEdit = useCallback((row: GridRow) => {
    setEditor({ mode: 'edit', id: row.id, baseUpdatedAt: row._updatedAt, base: rowToValues(row) });
  }, []);

  // Period options: generated rolling weeks ∪ weeks that already have rows / a lock.
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
              Add hires with the New Hire button — every change saves instantly. Lock in the week to send orientation invites.
              {hireCount > 0 && (
                <span className="ml-1 font-medium text-emerald-700 dark:text-emerald-400">
                  {hireCount} {hireCount === 1 ? 'hire' : 'hires'} this week.
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
                  disabled={busy}
                  aria-label="Previous week"
                  className="flex h-8 w-7 items-center justify-center rounded-lg border border-emerald-200 text-emerald-700 hover:bg-emerald-50 disabled:opacity-50 dark:border-emerald-800 dark:text-emerald-300 dark:hover:bg-emerald-950/40"
                >
                  <ChevronLeft className="h-4 w-4" />
                </button>
                <button
                  type="button"
                  onClick={() => setPeriodMenuOpen((o) => !o)}
                  disabled={busy}
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
                      Start Week
                    </span>
                  )}
                  {locked && <Lock className="h-3 w-3 text-amber-500" />}
                  <ChevronDown className="h-3.5 w-3.5 text-zinc-400" />
                </button>
                <button
                  type="button"
                  onClick={() => changePeriod(addWeeks(period, 1))}
                  disabled={busy}
                  aria-label="Next week"
                  className="flex h-8 w-7 items-center justify-center rounded-lg border border-emerald-200 text-emerald-700 hover:bg-emerald-50 disabled:opacity-50 dark:border-emerald-800 dark:text-emerald-300 dark:hover:bg-emerald-950/40"
                >
                  <ChevronRight className="h-4 w-4" />
                </button>
              </div>
              {periodMenuOpen && (
                <div className="absolute right-0 z-30 mt-1 max-h-80 w-72 overflow-auto rounded-xl border border-zinc-200 bg-white py-1 shadow-lg shadow-black/10 dark:border-zinc-700 dark:bg-zinc-900">
                  {periodOptions.map((o) => {
                    const isActive = o.start === period;
                    return (
                      <div
                        key={o.start}
                        className={cn(
                          'flex items-center gap-1 px-1.5 py-0.5',
                          isActive && 'bg-emerald-50 dark:bg-emerald-950/40',
                        )}
                      >
                        <button
                          type="button"
                          onClick={() => changePeriod(o.start)}
                          className={cn(
                            'flex min-w-0 flex-1 items-center gap-2 rounded-lg px-1.5 py-1.5 text-left text-[13px] hover:bg-emerald-50 dark:hover:bg-emerald-950/40',
                            isActive
                              ? 'font-medium text-emerald-800 dark:text-emerald-200'
                              : 'text-zinc-700 dark:text-zinc-300',
                          )}
                        >
                          <span className="flex min-w-0 items-center gap-1.5 tabular-nums">
                            <span className="truncate">{formatWeekLabel(o.start)}</span>
                            {o.start === currentSunday && (
                              <span className="shrink-0 rounded-full bg-emerald-100 px-1.5 py-px text-[10px] font-semibold text-emerald-700 dark:bg-emerald-900/50 dark:text-emerald-300">
                                now
                              </span>
                            )}
                          </span>
                          {o.rowCount > 0 && (
                            <span className="ml-auto shrink-0 tabular-nums text-[11px] text-zinc-400">{o.rowCount}</span>
                          )}
                        </button>
                        {o.locked ? (
                          <button
                            type="button"
                            onClick={() => startPeriodAction(o.start, 'reopen')}
                            disabled={busy}
                            title={`Reopen ${formatWeekLabel(o.start)} for editing`}
                            aria-label={`Reopen ${formatWeekLabel(o.start)} for editing`}
                            className="flex shrink-0 items-center gap-1 rounded-lg border border-amber-300 bg-amber-50 px-2 py-1 text-[11px] font-semibold text-amber-700 transition hover:bg-amber-100 disabled:opacity-50 dark:border-amber-500/40 dark:bg-amber-950/30 dark:text-amber-300 dark:hover:bg-amber-950/50"
                          >
                            <LockOpen className="h-3 w-3" />
                            Reopen
                          </button>
                        ) : (
                          <button
                            type="button"
                            onClick={() => startPeriodAction(o.start, 'lock')}
                            disabled={busy}
                            title={`Lock in ${formatWeekLabel(o.start)} & send orientation invites`}
                            aria-label={`Lock in ${formatWeekLabel(o.start)}`}
                            className="flex shrink-0 items-center gap-1 rounded-lg border border-emerald-300 bg-emerald-50 px-2 py-1 text-[11px] font-semibold text-emerald-700 transition hover:bg-emerald-100 disabled:opacity-50 dark:border-emerald-500/40 dark:bg-emerald-950/30 dark:text-emerald-300 dark:hover:bg-emerald-950/50"
                          >
                            <Lock className="h-3 w-3" />
                            Lock in
                          </button>
                        )}
                      </div>
                    );
                  })}
                </div>
              )}
            </div>

            <Button
              type="button"
              variant="outline"
              size="sm"
              onClick={refresh}
              disabled={loading || busy}
              className="h-8 gap-1.5 border-emerald-200 text-emerald-700 hover:bg-emerald-50 dark:border-emerald-800 dark:text-emerald-300"
            >
              <RefreshCw className={cn('h-3.5 w-3.5', loading && 'animate-spin')} />
              <span className="hidden sm:inline">Refresh</span>
            </Button>

            {/* Export to Excel — one .xlsx sheet per week (this week / all weeks) */}
            <div className="relative" ref={exportMenuRef}>
              <Button
                type="button"
                variant="outline"
                size="sm"
                onClick={() => setExportMenuOpen((o) => !o)}
                disabled={!!exporting}
                aria-haspopup="menu"
                aria-expanded={exportMenuOpen}
                className="h-8 gap-1.5 border-emerald-200 text-emerald-700 hover:bg-emerald-50 dark:border-emerald-800 dark:text-emerald-300"
              >
                {exporting ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Download className="h-3.5 w-3.5" />}
                <span className="hidden sm:inline">Export</span>
                <ChevronDown className="h-3.5 w-3.5 text-zinc-400" />
              </Button>
              {exportMenuOpen && (
                <div
                  role="menu"
                  className="absolute right-0 z-30 mt-1 w-56 overflow-hidden rounded-xl border border-zinc-200 bg-white py-1 shadow-lg shadow-black/10 dark:border-zinc-700 dark:bg-zinc-900"
                >
                  <button
                    type="button"
                    role="menuitem"
                    onClick={() => void exportWorkbook('week')}
                    className="flex w-full flex-col items-start gap-0.5 px-3 py-2 text-left hover:bg-emerald-50 dark:hover:bg-emerald-950/40"
                  >
                    <span className="text-[13px] font-medium text-zinc-800 dark:text-zinc-100">This week</span>
                    <span className="text-[11px] text-zinc-500 dark:text-zinc-400">
                      {formatWeekLabel(period)} — one sheet
                    </span>
                  </button>
                  <button
                    type="button"
                    role="menuitem"
                    onClick={() => void exportWorkbook('all')}
                    className="flex w-full flex-col items-start gap-0.5 px-3 py-2 text-left hover:bg-emerald-50 dark:hover:bg-emerald-950/40"
                  >
                    <span className="text-[13px] font-medium text-zinc-800 dark:text-zinc-100">All weeks</span>
                    <span className="text-[11px] text-zinc-500 dark:text-zinc-400">
                      Workbook with one sheet per week
                    </span>
                  </button>
                </div>
              )}
            </div>

            {locked ? (
              <Button
                type="button"
                size="sm"
                onClick={() => setActionDialog('reopen')}
                disabled={busy || loading}
                className="h-8 gap-1.5 bg-amber-500 text-white hover:bg-amber-600 disabled:opacity-50"
              >
                {busy ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <LockOpen className="h-3.5 w-3.5" />}
                Reopen
              </Button>
            ) : (
              <Button
                type="button"
                size="sm"
                onClick={() => setActionDialog('lock')}
                disabled={busy || loading}
                className="h-8 gap-1.5 bg-emerald-600 text-white hover:bg-emerald-700 disabled:opacity-50"
              >
                <Lock className="h-3.5 w-3.5" />
                Lock in
              </Button>
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
                onClick={() => setActionDialog('reopen')}
                disabled={busy}
                className="ml-auto h-7 gap-1.5 bg-amber-500 text-white hover:bg-amber-600"
              >
                <LockOpen className="h-3.5 w-3.5" />
                Reopen to edit
              </Button>
            </div>
          )}

          {/* How-it-works hint (editing only) */}
          {!locked && (
            <div className="flex items-start gap-2 rounded-xl border border-emerald-200 bg-emerald-50/70 px-3.5 py-2.5 text-[12px] leading-snug text-emerald-800 dark:border-emerald-500/30 dark:bg-emerald-950/20 dark:text-emerald-300">
              <Info className="mt-0.5 h-3.5 w-3.5 shrink-0" />
              <span>
                This checklist is edit-locked so two people can never overwrite each other. Use the{' '}
                <strong>New Hire</strong> button to add a hire and the <strong>pencil</strong> to edit one — every change
                saves instantly and shows up live for everyone. Tick rows to bulk-apply a{' '}
                <strong>department</strong> / <strong>country</strong> or delete. A green dot in a cell means it&apos;s been
                edited — click it for the full history. <strong>Lock in</strong> sends this week&apos;s orientation invites
                and feeds the per-country <strong>Bulk Invite</strong> in Onboarding.
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
                    <option key={d} value={d} className={SELECT_OPTION_CLASS}>{formatDeptLabel(d) || d}</option>
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
                onClick={() => void applyToSelected('department', bulkDept)}
                disabled={!bulkDept.trim() || busy}
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
                onClick={() => void applyToSelected('country', bulkCountry)}
                disabled={!bulkCountry.trim() || busy}
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
                disabled={busy}
                className="h-8 gap-1.5 border-rose-200 text-rose-700 hover:bg-rose-50 disabled:opacity-50 dark:border-rose-800 dark:text-rose-300"
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

          {/* Filter bar — narrow the visible rows by Department / Country / Hired
              By. Options are the distinct values present in the loaded week.
              Available whether or not the week is locked (filtering is read-only). */}
          {!loading && !error && rows.length > 0 && (
            <div className="flex shrink-0 flex-wrap items-center gap-x-2 gap-y-2 rounded-xl border border-zinc-200 bg-white px-3 py-2 dark:border-zinc-800 dark:bg-zinc-900/50">
              <div className="relative">
                <Search className="pointer-events-none absolute left-2.5 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-zinc-400" />
                <input
                  type="text"
                  value={search}
                  onChange={(e) => setSearch(e.target.value)}
                  placeholder="Search hires…"
                  aria-label="Search hires by name, email, source, or any field"
                  className="h-8 w-52 rounded-lg border border-zinc-200 bg-white pl-8 pr-7 text-[13px] text-zinc-800 outline-none focus:border-emerald-400 focus:ring-1 focus:ring-emerald-300 dark:border-zinc-700 dark:bg-zinc-900 dark:text-zinc-100 dark:placeholder:text-zinc-500"
                />
                {search && (
                  <button
                    type="button"
                    onClick={() => setSearch('')}
                    aria-label="Clear search"
                    className="absolute right-1.5 top-1/2 -translate-y-1/2 rounded p-0.5 text-zinc-400 hover:bg-zinc-100 hover:text-zinc-600 dark:hover:bg-zinc-800 dark:hover:text-zinc-200"
                  >
                    <X className="h-3.5 w-3.5" />
                  </button>
                )}
              </div>

              <span className="ml-1 flex items-center gap-1.5 text-[12px] font-semibold text-zinc-600 dark:text-zinc-300">
                <Filter className="h-3.5 w-3.5" />
                Filter
              </span>

              <span className="ml-1 text-[11px] text-zinc-600 dark:text-zinc-400">Dept</span>
              <select
                value={filterDept}
                onChange={(e) => setFilterDept(e.target.value)}
                disabled={filterOptions.departments.length === 0}
                aria-label="Filter by department"
                className={cn(FILTER_SELECT_CLASS, SELECT_SCHEME_CLASS)}
              >
                <option value="" className={SELECT_OPTION_CLASS}>All departments</option>
                {filterOptions.departments.map((d) => (
                  <option key={d} value={d} className={SELECT_OPTION_CLASS}>{formatDeptLabel(d) || d}</option>
                ))}
              </select>

              <span className="ml-2 text-[11px] text-zinc-600 dark:text-zinc-400">Country</span>
              <select
                value={filterCountry}
                onChange={(e) => setFilterCountry(e.target.value)}
                disabled={filterOptions.countries.length === 0}
                aria-label="Filter by country"
                className={cn(FILTER_SELECT_CLASS, SELECT_SCHEME_CLASS)}
              >
                <option value="" className={SELECT_OPTION_CLASS}>All countries</option>
                {filterOptions.countries.map((c) => (
                  <option key={c} value={c} className={SELECT_OPTION_CLASS}>{c}</option>
                ))}
              </select>

              <span className="ml-2 text-[11px] text-zinc-600 dark:text-zinc-400">Hired By</span>
              <select
                value={filterHiredBy}
                onChange={(e) => setFilterHiredBy(e.target.value)}
                disabled={filterOptions.hiredBy.length === 0}
                aria-label="Filter by who hired"
                className={cn(FILTER_SELECT_CLASS, SELECT_SCHEME_CLASS)}
              >
                <option value="" className={SELECT_OPTION_CLASS}>Anyone</option>
                {filterOptions.hiredBy.map((h) => (
                  <option key={h} value={h} className={SELECT_OPTION_CLASS}>{h}</option>
                ))}
              </select>

              {anyFilterActive && (
                <>
                  <span className="ml-1 text-[11px] tabular-nums text-zinc-500 dark:text-zinc-400">
                    Showing {filteredRows.length} of {hireCount}
                  </span>
                  <button
                    type="button"
                    onClick={clearFilters}
                    className="ml-auto flex items-center gap-1 text-[11px] text-zinc-500 hover:text-zinc-700 dark:text-zinc-400 dark:hover:text-zinc-200"
                  >
                    <X className="h-3.5 w-3.5" />
                    Clear filters
                  </button>
                </>
              )}
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
          ) : rows.length === 0 ? (
            <div className="flex flex-1 flex-col items-center justify-center gap-3 rounded-2xl border border-dashed border-emerald-200 bg-white py-12 text-center dark:border-emerald-950/40 dark:bg-[#0d1117]">
              <ClipboardList className="h-7 w-7 text-emerald-300 dark:text-emerald-800" />
              <p className="text-sm text-zinc-500">No hires yet for {formatWeekLabel(period)}.</p>
              {locked ? (
                <Button type="button" size="sm" onClick={() => setActionDialog('reopen')} disabled={busy} className="gap-1.5 bg-amber-500 text-white hover:bg-amber-600">
                  <LockOpen className="h-3.5 w-3.5" /> Reopen to add hires
                </Button>
              ) : (
                <Button type="button" size="sm" onClick={openAdd} disabled={busy} className="gap-1.5 bg-emerald-600 text-white hover:bg-emerald-700">
                  <UserPlus className="h-3.5 w-3.5" /> Add a new hire
                </Button>
              )}
            </div>
          ) : (
            <div className="relative min-h-0 flex-1">
              <div
                ref={registerScrollSurface}
                className="relative h-full w-full overflow-auto rounded-2xl border border-emerald-100/80 bg-white shadow-sm dark:border-emerald-950/40 dark:bg-zinc-950"
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
                          className="whitespace-nowrap border-b border-emerald-100/80 px-2.5 py-2 text-left text-[11.5px] font-semibold uppercase tracking-wide text-emerald-700 dark:border-emerald-950/40 dark:text-emerald-300"
                        >
                          {c.label}
                        </th>
                      ))}
                      {!locked && <th className="w-16 border-b border-emerald-100/80 px-1 py-2 dark:border-emerald-950/40" />}
                    </tr>
                  </thead>
                  <tbody>
                    {filteredRows.length === 0 ? (
                      <tr>
                        <td
                          colSpan={COLUMNS.length + (locked ? 1 : 2)}
                          className="px-4 py-10 text-center text-[13px] text-zinc-500 dark:text-zinc-400"
                        >
                          No hires match these filters.{' '}
                          <button
                            type="button"
                            onClick={clearFilters}
                            className="font-medium text-emerald-700 underline-offset-2 hover:underline dark:text-emerald-400"
                          >
                            Clear filters
                          </button>
                        </td>
                      </tr>
                    ) : (
                      filteredRows.map((row, r) => {
                      const isSelected = selectedIds.has(row.id);
                      // A referral hire must name who referred them — flag the
                      // Referred By cell amber until it's filled.
                      const needsReferrer = isReferralSource(row.source || '') && !(row.referred_by || '').trim();
                      const peerEditing = editingByRowId.get(row.id) ?? null;
                      const peerName = peerEditing ? (peerEditing.name?.trim() || peerEditing.email.split('@')[0]) : '';
                      return (
                        <tr
                          key={row.id}
                          className={cn(
                            'group/row hover:bg-emerald-50/40 dark:hover:bg-emerald-950/20',
                            isSelected ? 'bg-emerald-50 dark:bg-emerald-950/30' : 'even:bg-zinc-50/40 dark:even:bg-zinc-900/30',
                          )}
                          style={peerEditing ? { boxShadow: `inset 3px 0 0 0 ${peerEditing.color}` } : undefined}
                        >
                          <td
                            className={cn(
                              'sticky left-0 z-[1] border-b border-r border-emerald-50 px-1.5 py-0 dark:border-zinc-800',
                              isSelected
                                ? 'bg-emerald-50 dark:bg-emerald-950/30'
                                : 'bg-white group-even/row:bg-zinc-50/40 group-hover/row:bg-emerald-50/40 dark:bg-zinc-950 dark:group-even/row:bg-zinc-900/30',
                            )}
                          >
                            <div
                              className="flex items-center justify-center gap-1.5"
                              title={peerEditing ? `${peerName} is editing this hire` : undefined}
                            >
                              {!locked && (
                                <input
                                  type="checkbox"
                                  checked={isSelected}
                                  onChange={() => toggleRow(row.id)}
                                  aria-label={`Select row ${r + 1}`}
                                  className="h-3.5 w-3.5 cursor-pointer accent-emerald-600"
                                />
                              )}
                              <span className="relative tabular-nums text-[11px] text-zinc-400">
                                {r + 1}
                                {peerEditing && (
                                  <motion.span
                                    aria-hidden
                                    className="absolute -right-1.5 top-0 h-2.5 w-[2px] rounded-full"
                                    style={{ background: peerEditing.color }}
                                    animate={{ opacity: [1, 0.15, 1] }}
                                    transition={{ duration: 0.9, repeat: Infinity, ease: 'linear' }}
                                  />
                                )}
                              </span>
                            </div>
                          </td>
                          {COLUMNS.map((c) => {
                            const value = row[c.key];
                            const edits = row._editedBy?.[c.key];
                            const hasEdits = !!edits && edits.length > 0;
                            const listId =
                              c.key === 'department' || c.key === 'country' || c.key === 'source' || c.key === 'referred_by';
                            const widthClass = listId ? 'min-w-[10rem]' : 'min-w-[8rem]';
                            return (
                              <td
                                key={c.key}
                                className={cn(
                                  'relative border-b border-emerald-50/80 p-0 dark:border-zinc-800/80',
                                  c.key === 'referred_by' && needsReferrer && 'bg-amber-50 ring-1 ring-inset ring-amber-300 dark:bg-amber-950/30 dark:ring-amber-700/60',
                                )}
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
                                        top: Math.max(12, Math.min(rect.bottom + 6, window.innerHeight - maxH - 12)),
                                        left: Math.max(12, Math.min(rect.left, window.innerWidth - width - 12)),
                                      });
                                    }}
                                    title={`Edited ${edits!.length} ${edits!.length === 1 ? 'time' : 'times'} — view history`}
                                    aria-label={`View edit history for ${c.label}, row ${r + 1}`}
                                    className="absolute right-0.5 top-0.5 z-[4] flex h-3 w-3 items-center justify-center"
                                  >
                                    <span className="h-1.5 w-1.5 rounded-full bg-emerald-500 ring-2 ring-white dark:bg-emerald-400 dark:ring-zinc-950" />
                                  </button>
                                )}
                                <div
                                  className={cn(
                                    'flex h-9 select-text items-center whitespace-nowrap px-2.5 text-[13px]',
                                    value
                                      ? 'text-zinc-800 dark:text-zinc-100'
                                      : c.key === 'referred_by' && needsReferrer
                                        ? 'text-amber-600 dark:text-amber-400'
                                        : 'text-zinc-400',
                                    widthClass,
                                  )}
                                >
                                  {value || (c.key === 'referred_by' && needsReferrer ? 'Who referred?' : '')}
                                </div>
                              </td>
                            );
                          })}
                          {!locked && (
                            <td className="border-b border-emerald-50/80 px-1 dark:border-zinc-800/80">
                              <div className="flex items-center justify-center gap-0.5">
                                <button
                                  type="button"
                                  onClick={() => openEdit(row)}
                                  disabled={busy || !!peerEditing}
                                  aria-label={`Edit row ${r + 1} in a form`}
                                  title={peerEditing ? `${peerName} is editing this hire` : 'Edit this hire in a form'}
                                  className="rounded p-1 text-zinc-300 opacity-0 transition hover:bg-emerald-50 hover:text-emerald-600 focus:opacity-100 group-hover/row:opacity-100 disabled:cursor-not-allowed disabled:opacity-40 disabled:group-hover/row:opacity-40 dark:hover:bg-emerald-950/30 dark:hover:text-emerald-300"
                                >
                                  <Pencil className="h-3.5 w-3.5" />
                                </button>
                                <button
                                  type="button"
                                  onClick={() => deleteRow(row.id, row.name)}
                                  disabled={busy}
                                  aria-label={`Delete row ${r + 1}`}
                                  className="rounded p-1 text-zinc-300 opacity-0 transition hover:bg-rose-50 hover:text-rose-500 focus:opacity-100 group-hover/row:opacity-100 disabled:cursor-not-allowed disabled:opacity-40 dark:hover:bg-rose-950/30"
                                >
                                  <Trash2 className="h-3.5 w-3.5" />
                                </button>
                              </div>
                            </td>
                          )}
                        </tr>
                      );
                      })
                    )}
                  </tbody>
                </table>
              </div>

              {/* "New Hire" CTA — a neon-green glowing button pinned to the
                  lower-right corner of the table (stays put while the grid
                  scrolls). Greyed out + inert once the week is locked. */}
              <div className="pointer-events-none absolute bottom-4 right-4 z-30">
                {locked ? (
                  <button
                    type="button"
                    disabled
                    title="This week is locked — reopen it to add a hire"
                    aria-label="Add a new hire (disabled — this week is locked)"
                    className="pointer-events-auto flex h-11 cursor-not-allowed items-center gap-2 rounded-full border border-zinc-300 bg-zinc-200/90 px-5 text-sm font-semibold text-zinc-400 shadow-md backdrop-blur-sm dark:border-zinc-700 dark:bg-zinc-800/90 dark:text-zinc-500"
                  >
                    <Lock className="h-4 w-4" />
                    New Hire
                  </button>
                ) : (
                  <motion.button
                    type="button"
                    onClick={openAdd}
                    disabled={busy}
                    aria-label="Add a new hire"
                    initial={false}
                    animate={
                      reduceMotion || busy
                        ? undefined
                        : {
                            boxShadow: [
                              '0 0 0 1px rgba(16,185,129,0.55), 0 0 12px 2px rgba(16,185,129,0.5), 0 0 26px 6px rgba(16,185,129,0.28)',
                              '0 0 0 1px rgba(16,185,129,0.9), 0 0 22px 5px rgba(16,185,129,0.85), 0 0 46px 13px rgba(16,185,129,0.5)',
                            ],
                          }
                    }
                    transition={{ duration: 1.8, repeat: Infinity, repeatType: 'reverse', ease: 'easeInOut' }}
                    whileHover={reduceMotion ? undefined : { scale: 1.05 }}
                    whileTap={reduceMotion ? undefined : { scale: 0.96 }}
                    className={cn(
                      'pointer-events-auto flex h-11 items-center gap-2 rounded-full bg-gradient-to-br from-emerald-400 via-emerald-500 to-teal-600 px-5 text-sm font-bold tracking-wide text-white ring-1 ring-emerald-300/70 shadow-[0_0_18px_4px_rgba(16,185,129,0.55)] focus:outline-none focus-visible:ring-2 focus-visible:ring-emerald-200 disabled:cursor-not-allowed disabled:opacity-50 dark:ring-emerald-400/40',
                    )}
                  >
                    <span className="flex h-6 w-6 items-center justify-center rounded-full bg-white/25 backdrop-blur-sm">
                      <UserPlus className="h-4 w-4" />
                    </span>
                    New Hire
                  </motion.button>
                )}
              </div>
            </div>
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

      {/* Password-gated Lock in / Reopen (fires / warns about the orientation
          automation) — restricted to the HR Manager passphrase. */}
      <NewHireChecklistLockDialog
        mode={actionDialog}
        weekLabel={formatWeekLabel(period)}
        orientationLabel={formatOrientationLabel(period)}
        hireCount={hireCount}
        lockedBy={lockedBy}
        lockedStamp={formatLockStamp(lockedAt) || null}
        onCancel={() => setActionDialog(null)}
        onConfirm={runGatedAction}
      />

      {/* "New Hire" modal — 'add' inserts a hire; 'edit' (a row's Edit button)
          pre-fills the form and updates that row. Both write to the server
          immediately (see handleQuickAdd / handleEditHire). */}
      <NewHireQuickAddDialog
        open={editor !== null}
        mode={editor?.mode ?? 'add'}
        weekLabel={formatWeekLabel(period)}
        departments={departments}
        sources={sourceOptions}
        referrers={referrers}
        initialValues={editor?.mode === 'edit' ? editor.base : null}
        onCancel={() => setEditor(null)}
        onSave={(values) => {
          const ed = editor;
          if (ed?.mode === 'edit') return handleEditHire(ed, values);
          return handleQuickAdd(values);
        }}
      />
    </div>
  );
}
