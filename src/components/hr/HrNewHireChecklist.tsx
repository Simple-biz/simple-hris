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
  Eraser,
  Info,
  Loader2,
  Lock,
  LockOpen,
  Pencil,
  Plus,
  RefreshCw,
  Save,
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
import { useLiveCells, type LiveCellPeer, type LiveCellValue } from '@/hooks/useLiveCells';
import NewHireChecklistLockDialog, { type LockDialogMode } from './NewHireChecklistLockDialog';
import NewHireQuickAddDialog, { type QuickAddValues } from './NewHireQuickAddDialog';

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

/** Valid column keys, for validating a live-edit message from a peer. */
const COLUMN_KEY_SET = new Set<string>(COLUMNS.map((c) => c.key));

/** A grid row: a stable client `_key`, the DB `id` (null until saved), a shared
 *  cross-client identity `_cid` (used by live co-editing to line rows up between
 *  clients regardless of position), one string per column (empty string = blank
 *  cell), and `_editedBy` — the edit history log per column, as loaded from the
 *  server (never sent back on save; the server recomputes it by diffing against
 *  its own current values). */
type GridRow = {
  _key: string;
  /** Shared co-editing identity: the DB id once saved, a deterministic seed key
   *  for a fresh week's blank rows (so two clients align), or a random client id
   *  for rows added after that. Never sent to the server. */
  _cid: string;
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

// Cap how many pasted cells are mirrored live to co-editors in one batch. A
// paste bigger than this still saves normally — it just doesn't stream live
// (keeps the single broadcast payload well under Realtime's message-size limit).
const MAX_PASTE_BROADCAST_CELLS = 2000;

// Stable, render-safe row keys (no Math.random/Date during render — avoids SSR
// hydration drift). Module-level so keys stay unique across tab remounts.
let keySeq = 0;
const nextKey = () => `nhc-${++keySeq}`;

/** A fresh shared co-editing id for a client-created row. Only ever called from
 *  event handlers / effects (never during render), so `crypto` is safe here. */
function newCid(): string {
  if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') {
    return crypto.randomUUID();
  }
  return `cid-${nextKey()}`;
}

function blankRow(cid?: string): GridRow {
  const r = { _key: nextKey(), _cid: cid ?? newCid(), id: null } as GridRow;
  for (const c of COLUMNS) r[c.key] = '';
  return r;
}

function seedBlank(n: number): GridRow[] {
  return Array.from({ length: n }, () => blankRow());
}

/** Deterministic blank seed for an EMPTY week, so two clients opening the same
 *  fresh week share row identities (`seed:<week>:<i>`) and their live edits line
 *  up cell-for-cell — even if one of them later deletes a blank row. */
function emptyWeekSeed(period: string, n = 6): GridRow[] {
  return Array.from({ length: n }, (_, i) => blankRow(`seed:${period}:${i}`));
}

function fromServer(row: HrNewHireChecklistRow): GridRow {
  // A saved row's shared identity IS its DB id, so a peer editing it resolves to
  // the same row on every client.
  const r = { _key: nextKey(), _cid: row.id, id: row.id, _editedBy: row.cell_edits ?? undefined } as GridRow;
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

/** A grid row → the modal's field values (for editing an existing row in the
 *  form). Keys line up 1:1 with COLUMNS / QuickAddValues. */
function rowToValues(row: GridRow): QuickAddValues {
  const v = {} as QuickAddValues;
  for (const c of COLUMNS) v[c.key] = row[c.key] ?? '';
  return v;
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

/** The orientation day for a Sun-anchored week: the MONDAY (start + 1 day),
 *  formatted "Monday, Jul 6, 2026". Mirrors the webhook's ORIENT_OFFSET_DAYS=1
 *  (src/lib/hr/new-hire-checklist-webhook.ts) so the dialog shows the exact date
 *  each hire is emailed. */
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
  // ── Spreadsheet-style cell selection ──────────────────────────────────────
  // Google-Sheets feel: a single click selects a cell (drag or Shift-click
  // extends a rectangular range); editing only begins on double-click, Enter, or
  // by typing. `sel` is the anchor→head range; `editing` is the single cell in
  // edit mode (its <input> is live), null while the grid is in select mode.
  const [sel, setSel] = useState<{ ar: number; ac: number; hr: number; hc: number } | null>(null);
  const [editing, setEditing] = useState<{ r: number; c: number } | null>(null);
  const draggingRef = useRef(false);
  const selRef = useRef(sel);
  const editingRef = useRef(editing);
  const escapingRef = useRef(false); // Escape reverts the in-flight edit on blur
  const preEditRef = useRef<{ r: number; c: number; value: string } | null>(null);
  const editSelectAllRef = useRef(false); // select-all vs caret-at-end on edit start
  // Which password-gated action is being confirmed (null = no dialog). Locking
  // fires the orientation automation and reopening lets a locked week be edited
  // (and re-locked), so both go through the HR-Manager passphrase dialog.
  const [actionDialog, setActionDialog] = useState<LockDialogMode | null>(null);
  // A lock/reopen requested from the week dropdown for a week that first has to
  // load: we switch to it, then this effect fires the dialog once it's in view.
  const [pendingAction, setPendingAction] = useState<{ period: string; mode: LockDialogMode } | null>(null);
  const scrollRef = useRef<HTMLDivElement>(null);
  const [departments, setDepartments] = useState<string[]>([]);
  // Source dropdown suggestions = the base list ∪ sources already used (so a
  // custom source, once typed + saved, reappears as a suggestion). Referrers =
  // active-employee names from the Global Master List (the "Referred By" picker
  // always checks the master list).
  const [sourceOptions, setSourceOptions] = useState<string[]>(() => [...BASE_SOURCE_OPTIONS]);
  const [referrers, setReferrers] = useState<string[]>([]);
  const [selectedKeys, setSelectedKeys] = useState<Set<string>>(() => new Set());
  const [bulkDept, setBulkDept] = useState('');
  const [bulkCountry, setBulkCountry] = useState('');
  const selectAllRef = useRef<HTMLInputElement>(null);
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
  // button opens it in 'edit' mode pre-filled with that row (keyed by _key).
  // null = closed. Disabled while the week is locked.
  const [editor, setEditor] = useState<{ mode: 'add' } | { mode: 'edit'; key: string } | null>(null);
  const reduceMotion = useReducedMotion();

  // Mutators read the lock through a ref so a locked week can never be edited
  // (even a paste on a readOnly input still fires our onPaste handler).
  const lockedRef = useRef(locked);
  useEffect(() => { lockedRef.current = locked; }, [locked]);
  // Latest selection / editing cell in refs so global (window / grid) handlers
  // read them without being recreated every keystroke.
  useEffect(() => { selRef.current = sel; }, [sel]);
  useEffect(() => { editingRef.current = editing; }, [editing]);

  // ── Live cell co-editing ────────────────────────────────────────────────
  // Broadcast this viewer's cell focus/typing to everyone else on the same week,
  // and merge peers' keystrokes into our grid in real time (Google-Sheets style).
  const { data: session } = useSession();
  const selfEmail = session?.user?.email ?? null;
  const selfName = session?.user?.name ?? null;

  // The cell the local user is actively editing, so an incoming peer edit can
  // never overwrite it mid-keystroke (which would jump their caret).
  const activeCellRef = useRef<{ r: number; col: FieldKey } | null>(null);
  // Latest rows in a ref, so the paste handler can resolve target-row DB ids
  // when broadcasting pasted cells without re-creating its callback each render.
  const rowsRef = useRef(rows);
  useEffect(() => { rowsRef.current = rows; }, [rows]);

  // Set when a co-editor announces they saved the week; drives the resync/nudge
  // effect (declared after fetchPeriod so it can reload).
  const [savedSignal, setSavedSignal] = useState<{ by: string } | null>(null);

  // Merge a peer's edits (one cell for a keystroke, many for a paste) into our
  // own grid in ONE state update. Each cell matches its row by the shared `_cid`
  // (DB id once saved, else a deterministic seed / client id) so it lines up
  // regardless of position, falling back to the broadcast index only when no cid
  // matches. Grows the grid so a peer's freshly-added row still lands (adopting
  // the sender's cid so later edits keep matching), skips the cell the local
  // user is focused in so their typing is never clobbered, and on the index-only
  // fallback will ONLY fill a blank cell — so a structural drift can never
  // destroy data the local user typed elsewhere. `dirty` flips only if a cell
  // actually changed (read after the single setRows, whose updater React runs
  // eagerly for this empty-queue async dispatch).
  const applyRemoteEdits = useCallback((cells: LiveCellValue[]) => {
    if (lockedRef.current) return; // a locked week is read-only for everyone
    let changed = false;
    setRows((prev) => {
      const active = activeCellRef.current;
      const origLen = prev.length;
      let next = prev;
      for (const cell of cells) {
        if (!COLUMN_KEY_SET.has(cell.c)) continue;
        const key = cell.c as FieldKey;
        let idx = cell.cid ? next.findIndex((row) => row._cid === cell.cid) : -1;
        const matchedByCid = idx >= 0;
        if (idx < 0) idx = cell.r;
        if (idx < 0) continue;
        if (active && active.r === idx && active.col === key) continue;
        // Don't grow the grid just to write a blank into a row we don't have yet
        // (a paste batch can carry empty trailing cells); clearing an existing
        // cell still works because that row is already present.
        if (idx >= next.length && cell.v.trim() === '') continue;
        if (next === prev) next = prev.slice();
        while (next.length <= idx) next.push(blankRow());
        // A brand-new row we just grew to reach the peer's row adopts their cid,
        // so their subsequent edits to it keep cid-matching instead of drifting.
        if (cell.cid && idx >= origLen) next[idx] = { ...next[idx]!, _cid: cell.cid };
        const cur = next[idx]![key] ?? '';
        if (cur === cell.v) continue; // already in sync
        if (!matchedByCid && cur.trim() !== '') continue; // don't clobber on index guess
        next[idx] = { ...next[idx]!, [key]: cell.v };
        changed = true;
      }
      return changed ? next : prev;
    });
    if (changed) setDirty(true);
  }, []);

  const handlePeerSaved = useCallback((byEmail: string, byName: string | null) => {
    setSavedSignal({ by: (byName && byName.trim()) || byEmail.split('@')[0] || byEmail });
  }, []);

  const {
    peers: livePeers,
    sendFocus: liveFocus,
    sendBlur: liveBlur,
    sendEdit: liveEdit,
    sendEdits: liveEdits,
    sendSaved: liveSaved,
  } = useLiveCells({
    selfEmail,
    selfName,
    channel: `hr-nhc-cells:${period}`,
    enabled: !!selfEmail && !!period,
    onRemoteEdits: applyRemoteEdits,
    onSaved: handlePeerSaved,
  });

  // Resolve each peer's row index once (shared cid, then broadcast index) so
  // `peerByCell` (exact cell) and `peersByRow` (anywhere in the row) can't
  // disagree on which row a peer is in.
  const resolvedPeers = useMemo(() => {
    const out: Array<{ peer: LiveCellPeer; idx: number }> = [];
    for (const p of livePeers) {
      let idx = p.cid ? rows.findIndex((row) => row._cid === p.cid) : -1;
      if (idx < 0) idx = p.row;
      if (idx < 0 || idx >= rows.length) continue;
      out.push({ peer: p, idx });
    }
    return out;
  }, [livePeers, rows]);

  // Which peer (if any) occupies each rendered cell, keyed `${rowIndex}:${col}`.
  const peerByCell = useMemo(() => {
    const m = new Map<string, LiveCellPeer>();
    for (const { peer, idx } of resolvedPeers) m.set(`${idx}:${peer.col}`, peer);
    return m;
  }, [resolvedPeers]);

  // Which peer(s) are anywhere in a row, regardless of column — drives a
  // row-level "someone's already in here" indicator so a second person can
  // see a row is occupied before they've focused any specific cell in it.
  const peersByRow = useMemo(() => {
    const m = new Map<number, LiveCellPeer[]>();
    for (const { peer, idx } of resolvedPeers) {
      const arr = m.get(idx);
      if (arr) arr.push(peer);
      else m.set(idx, [peer]);
    }
    return m;
  }, [resolvedPeers]);

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
      setRows(fresh.length ? fresh : isLocked ? [] : emptyWeekSeed(p));
      setLocked(isLocked);
      setLockedAt(json.period?.locked_at ?? null);
      setLockedBy(json.period?.locked_by ?? null);
      setDirty(false);
      setSelectedKeys(new Set());
      setSel(null);
      setEditing(null);
      // A resync (e.g. a peer's save) can drop the editing cell without a blur,
      // so clear the live-edit cursor here too — otherwise a stale activeCellRef
      // would make one cell ignore incoming peer edits until the next focus.
      activeCellRef.current = null;
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

  // A co-editor saved this week. With no local edits in flight, silently resync
  // so we adopt the server row ids (a blind second save would otherwise insert a
  // co-edited new row twice); mid-edit, just nudge to Refresh.
  useEffect(() => {
    if (!savedSignal) return;
    setSavedSignal(null);
    if (dirty || saving) {
      toast.info(`${savedSignal.by} saved this week — Refresh to sync (avoids duplicate rows).`);
    } else {
      void fetchPeriod(period);
      void loadPeriods();
    }
  }, [savedSignal, dirty, saving, period, fetchPeriod, loadPeriods]);

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

  // Source suggestions: merge the base list with sources already used across all
  // weeks (case-insensitive de-dupe), so custom sources persist in the dropdown.
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

  // When a cell enters edit mode, focus its freshly-mounted <input> and either
  // select all (double-click / Enter) or drop the caret at the end (F2 / typing).
  useEffect(() => {
    if (!editing) return;
    const el = scrollRef.current?.querySelector<HTMLInputElement>(`[data-cell="${editing.r}-${editing.c}"]`);
    if (!el) return;
    el.focus();
    if (editSelectAllRef.current) {
      el.select();
    } else {
      const n = el.value.length;
      el.setSelectionRange(n, n);
    }
  }, [editing]);

  // Drag-select ends whenever the mouse is released anywhere.
  useEffect(() => {
    const up = () => { draggingRef.current = false; };
    window.addEventListener('mouseup', up);
    return () => window.removeEventListener('mouseup', up);
  }, []);

  // Switching weeks invalidates row indices — drop any selection / edit.
  useEffect(() => { setSel(null); setEditing(null); }, [period]);

  const setCell = useCallback((r: number, key: FieldKey, value: string) => {
    if (lockedRef.current) return;
    setRows((prev) => prev.map((row, i) => (i === r ? { ...row, [key]: value } : row)));
    setDirty(true);
  }, []);

  // Core fill logic shared by the editing cell's onPaste (fill-down) and a
  // range paste from select mode: writes `matrix` into the grid starting at
  // (r, c), growing rows as needed, and mirrors it live to co-editors.
  const pasteMatrixAt = useCallback(
    (matrix: string[][], r: number, c: number) => {
      if (lockedRef.current) return;
      const preRows = rowsRef.current;
      // Resolve a stable shared cid per target row up front, so the row we grow
      // locally and the value we broadcast to peers share identity (an appended
      // paste row gets a fresh cid that BOTH sides use).
      const targetCids: string[] = [];
      for (let i = 0; i < matrix.length; i++) targetCids[i] = preRows[r + i]?._cid ?? newCid();

      setRows((prev) => {
        const next = prev.map((row) => ({ ...row }));
        for (let i = 0; i < matrix.length; i++) {
          const targetRow = r + i;
          while (next.length <= targetRow) next.push(blankRow());
          next[targetRow]!._cid = targetCids[i]!; // share identity with the broadcast
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

      // Mirror the paste to co-editors as one batch (same grow-on-demand path as
      // typing), so a fill-down shows up live on their screens too. Skipped when
      // over the cap — such a paste still syncs on Save.
      const batch: LiveCellValue[] = [];
      let overflow = false;
      for (let i = 0; i < matrix.length && !overflow; i++) {
        const targetRow = r + i;
        const cells = matrix[i]!;
        for (let j = 0; j < cells.length; j++) {
          const targetCol = c + j;
          if (targetCol >= COLUMNS.length) break;
          if (batch.length >= MAX_PASTE_BROADCAST_CELLS) { overflow = true; break; }
          const key = COLUMNS[targetCol]!.key;
          const raw = cells[j]!.trim();
          const val =
            key === 'department'
              ? canonicalizeDept(raw, departments)
              : key === 'country'
                ? canonicalizeCountry(raw)
                : raw;
          batch.push({ r: targetRow, cid: targetCids[i]!, c: key, v: val });
        }
      }
      if (!overflow) liveEdits(batch);
    },
    [departments, liveEdits],
  );

  // The editing cell's paste = fill-down from that cell (a single value falls
  // through to the browser's native paste into the input).
  const handlePaste = useCallback(
    (e: React.ClipboardEvent<HTMLInputElement>, r: number, c: number) => {
      if (lockedRef.current) return;
      const text = e.clipboardData?.getData('text/plain') ?? '';
      if (!text) return;
      const matrix = parseClipboard(text);
      if (matrix.length === 1 && matrix[0]!.length === 1) return; // single value → native paste
      e.preventDefault();
      pasteMatrixAt(matrix, r, c);
    },
    [pasteMatrixAt],
  );

  // ── Cell selection + edit-mode handlers ───────────────────────────────────
  const beginEdit = useCallback(
    (r: number, c: number, opts?: { selectAll?: boolean; initial?: string }) => {
      if (lockedRef.current) return;
      const key = COLUMNS[c]!.key;
      const cid = rowsRef.current[r]?._cid ?? '';
      preEditRef.current = { r, c, value: rowsRef.current[r]?.[key] ?? '' };
      editSelectAllRef.current = !!opts?.selectAll;
      if (opts?.initial !== undefined) {
        setCell(r, key, opts.initial);
        if (cid) liveEdit(r, cid, key, opts.initial);
      }
      setSel({ ar: r, ac: c, hr: r, hc: c });
      setEditing({ r, c });
    },
    [setCell, liveEdit],
  );

  const cellMouseDown = useCallback((e: React.MouseEvent, r: number, c: number) => {
    if (e.button !== 0) return;
    // Clicking inside the cell already being edited: let the input place its own
    // caret / drag a text selection.
    if (editingRef.current?.r === r && editingRef.current?.c === c) return;
    e.preventDefault(); // suppress native text-selection while range-selecting
    setSel((prev) => (e.shiftKey && prev ? { ...prev, hr: r, hc: c } : { ar: r, ac: c, hr: r, hc: c }));
    draggingRef.current = true;
    // Move focus off any open editor (commits it via onBlur) onto the grid so
    // keyboard nav / copy / type-to-edit work.
    scrollRef.current?.focus();
  }, []);

  const cellMouseEnter = useCallback((r: number, c: number) => {
    if (!draggingRef.current) return;
    setSel((prev) => (prev ? { ...prev, hr: r, hc: c } : prev));
  }, []);

  const clearRange = useCallback(() => {
    if (lockedRef.current) return;
    const s = selRef.current;
    if (!s) return;
    const r0 = Math.min(s.ar, s.hr), r1 = Math.max(s.ar, s.hr);
    const c0 = Math.min(s.ac, s.hc), c1 = Math.max(s.ac, s.hc);
    const batch: LiveCellValue[] = [];
    setRows((prev) =>
      prev.map((row, ri) => {
        if (ri < r0 || ri > r1) return row;
        let changed = false;
        const next = { ...row };
        for (let ci = c0; ci <= c1; ci++) {
          const key = COLUMNS[ci]!.key;
          if ((next[key] ?? '') !== '') {
            next[key] = '';
            changed = true;
            batch.push({ r: ri, cid: row._cid, c: key, v: '' });
          }
        }
        return changed ? next : row;
      }),
    );
    if (batch.length) { liveEdits(batch); setDirty(true); }
  }, [liveEdits]);

  // Keyboard while a cell/range is selected (not editing). Attached to the grid
  // container; bails while editing so the <input> keeps its own keys.
  const gridKeyDown = useCallback(
    (e: React.KeyboardEvent<HTMLDivElement>) => {
      // Only handle keys aimed at the container itself — never hijack Space /
      // Enter etc. bubbling up from a focused checkbox / delete / history button.
      if (e.target !== e.currentTarget) return;
      if (editingRef.current) return;
      const k = e.key;
      const isNav =
        k === 'ArrowUp' || k === 'ArrowDown' || k === 'ArrowLeft' || k === 'ArrowRight' || k === 'Enter' || k === 'F2';
      const isPrintable = !e.ctrlKey && !e.metaKey && !e.altKey && k.length === 1;
      const s = selRef.current;
      // Keyboard bootstrap: a user who Tabs into the grid (no prior click) has no
      // selection yet — the first navigation / edit / type key seeds cell A1, and
      // subsequent keys operate normally.
      if (!s) {
        if ((isNav || isPrintable) && rowsRef.current.length > 0) {
          e.preventDefault();
          setSel({ ar: 0, ac: 0, hr: 0, hc: 0 });
        }
        return;
      }
      const maxR = rowsRef.current.length - 1;
      const maxC = COLUMNS.length - 1;
      if (k === 'ArrowUp' || k === 'ArrowDown' || k === 'ArrowLeft' || k === 'ArrowRight') {
        e.preventDefault();
        const dr = k === 'ArrowDown' ? 1 : k === 'ArrowUp' ? -1 : 0;
        const dc = k === 'ArrowRight' ? 1 : k === 'ArrowLeft' ? -1 : 0;
        const nr = Math.min(Math.max(s.hr + dr, 0), maxR);
        const nc = Math.min(Math.max(s.hc + dc, 0), maxC);
        setSel((prev) => (prev && e.shiftKey ? { ...prev, hr: nr, hc: nc } : { ar: nr, ac: nc, hr: nr, hc: nc }));
        return;
      }
      if (k === 'Enter' || k === 'F2') {
        e.preventDefault();
        beginEdit(s.hr, s.hc, { selectAll: k === 'Enter' });
        return;
      }
      if (k === 'Escape') { e.preventDefault(); setSel(null); return; }
      if (k === 'Delete' || k === 'Backspace') {
        if (lockedRef.current) return;
        e.preventDefault();
        clearRange();
        return;
      }
      // Type-to-edit: a lone printable character replaces the cell and edits it.
      if (!e.ctrlKey && !e.metaKey && !e.altKey && k.length === 1) {
        if (lockedRef.current) return;
        e.preventDefault();
        beginEdit(s.hr, s.hc, { initial: k });
      }
    },
    [beginEdit, clearRange],
  );

  // Keys inside the editing <input>: commit + move (Enter/Tab) or revert (Esc).
  const editingKeyDown = useCallback((e: React.KeyboardEvent<HTMLInputElement>, r: number, c: number) => {
    const k = e.key;
    if (k === 'Enter') {
      e.preventDefault();
      if (r + 1 >= rowsRef.current.length) setRows((prev) => [...prev, blankRow()]);
      setSel({ ar: r + 1, ac: c, hr: r + 1, hc: c });
      scrollRef.current?.focus(); // blurs the input → commit via onBlur
    } else if (k === 'Tab') {
      e.preventDefault();
      const nc = Math.min(Math.max(c + (e.shiftKey ? -1 : 1), 0), COLUMNS.length - 1);
      setSel({ ar: r, ac: nc, hr: r, hc: nc });
      scrollRef.current?.focus();
    } else if (k === 'Escape') {
      e.preventDefault();
      escapingRef.current = true; // onBlur restores the pre-edit value
      setSel({ ar: r, ac: c, hr: r, hc: c });
      scrollRef.current?.focus();
    }
  }, []);

  // Copy the selected range as TSV (so it pastes cleanly into Sheets / Excel).
  const gridCopy = useCallback((e: React.ClipboardEvent<HTMLDivElement>) => {
    if (e.target !== e.currentTarget) return; // only when the grid itself is focused
    if (editingRef.current) return; // let the input copy its own text selection
    const s = selRef.current;
    if (!s) return;
    const r0 = Math.min(s.ar, s.hr), r1 = Math.max(s.ar, s.hr);
    const c0 = Math.min(s.ac, s.hc), c1 = Math.max(s.ac, s.hc);
    const rowsNow = rowsRef.current;
    const lines: string[] = [];
    for (let ri = r0; ri <= r1; ri++) {
      const cells: string[] = [];
      for (let ci = c0; ci <= c1; ci++) cells.push(rowsNow[ri]?.[COLUMNS[ci]!.key] ?? '');
      lines.push(cells.join('\t'));
    }
    e.preventDefault();
    e.clipboardData.setData('text/plain', lines.join('\n'));
  }, []);

  // Paste into the grid from select mode (starts at the range's top-left).
  const gridPaste = useCallback((e: React.ClipboardEvent<HTMLDivElement>) => {
    if (e.target !== e.currentTarget) return; // only when the grid itself is focused
    if (editingRef.current) return; // the input's own onPaste handles fill-down
    if (lockedRef.current) return;
    const s = selRef.current;
    if (!s) return;
    const text = e.clipboardData?.getData('text/plain') ?? '';
    if (!text) return;
    e.preventDefault();
    pasteMatrixAt(parseClipboard(text), Math.min(s.ar, s.hr), Math.min(s.ac, s.hc));
  }, [pasteMatrixAt]);

  const addRows = useCallback((n: number) => {
    if (lockedRef.current) return;
    setRows((prev) => [...prev, ...seedBlank(n)]);
    setDirty(true);
  }, []);

  // "New Hire" modal → append one hire at the very bottom of the grid. Mirrors
  // the grid's own canonicalisation (department / country) and broadcasts the
  // new row to co-editors so it lands with a shared identity on every client.
  // The row is local + dirty until the week is Saved / Locked in (same as any
  // other grid edit).
  const handleQuickAdd = useCallback(
    (values: QuickAddValues) => {
      if (lockedRef.current) return;
      const cid = newCid();
      const row = blankRow(cid);
      for (const c of COLUMNS) {
        const raw = (values[c.key] ?? '').trim();
        row[c.key] =
          c.key === 'department'
            ? canonicalizeDept(raw, departments)
            : c.key === 'country'
              ? canonicalizeCountry(raw)
              : raw;
      }
      const insertIndex = rowsRef.current.length;
      setRows((prev) => [...prev, row]);
      setDirty(true);

      // Stream the new row to co-editors (one batch, same shared cid).
      const batch: LiveCellValue[] = [];
      for (const c of COLUMNS) {
        const v = row[c.key];
        if (v) batch.push({ r: insertIndex, cid, c: c.key, v });
      }
      if (batch.length) liveEdits(batch);

      // Select the new row + scroll it into view so it's clearly "there".
      setSel({ ar: insertIndex, ac: 0, hr: insertIndex, hc: 0 });
      setEditing(null);
      setTimeout(() => {
        const el = scrollRef.current;
        if (el) el.scrollTo({ top: el.scrollHeight, behavior: reduceMotion ? 'auto' : 'smooth' });
      }, 60);

      toast.success(`Added ${row.name.trim() || 'new hire'} to ${formatWeekLabel(period)}`);
    },
    [departments, liveEdits, period, reduceMotion],
  );

  // "Edit" a row from the modal → apply the form values to that row in place
  // (matched by stable _key), canonicalising dept/country and streaming only the
  // changed cells to co-editors. Local + dirty until Save / Lock in.
  const handleEditHire = useCallback(
    (key: string, values: QuickAddValues) => {
      if (lockedRef.current) return;
      const cur = rowsRef.current;
      const idx = cur.findIndex((row) => row._key === key);
      if (idx < 0) return;
      const row = cur[idx]!;
      const updates: Partial<Record<FieldKey, string>> = {};
      const batch: LiveCellValue[] = [];
      for (const c of COLUMNS) {
        const raw = (values[c.key] ?? '').trim();
        const val =
          c.key === 'department'
            ? canonicalizeDept(raw, departments)
            : c.key === 'country'
              ? canonicalizeCountry(raw)
              : raw;
        if ((row[c.key] ?? '') !== val) {
          updates[c.key] = val;
          batch.push({ r: idx, cid: row._cid, c: c.key, v: val });
        }
      }
      if (batch.length === 0) return; // nothing changed
      setRows((prev) => prev.map((rw) => (rw._key === key ? { ...rw, ...updates } : rw)));
      setDirty(true);
      liveEdits(batch);
      setSel({ ar: idx, ac: 0, hr: idx, hc: 0 });
      setEditing(null);
      toast.success(`Updated ${(values.name || '').trim() || 'hire'}`);
    },
    [departments, liveEdits],
  );

  // A locked week is read-only — never leave the modal open over it (e.g. if a
  // co-editor locks the week while the dialog is up).
  useEffect(() => {
    if (locked) setEditor(null);
  }, [locked]);

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
    setSel(null); // row indices shifted — drop the cell selection
    setEditing(null);
    setDirty(true);
  }, []);

  const changePeriod = useCallback((p: string) => {
    setPeriodMenuOpen(false);
    if (p === period) return;
    if (dirty && !window.confirm('Discard unsaved changes and switch weeks?')) return;
    setPeriod(p);
    setLoaded(false);
    setSavedSignal(null); // drop any pending peer-save nudge from the week we're leaving
  }, [period, dirty]);

  const refresh = useCallback(() => {
    if (dirty && !window.confirm('Discard unsaved changes and reload from the server?')) return;
    void fetchPeriod(period);
    void loadPeriods();
  }, [dirty, period, fetchPeriod, loadPeriods]);

  // Download a multi-sheet .xlsx workbook (one sheet per week) — either just the
  // current week or every week with saved rows. Reflects SAVED data; a warning
  // fires first if the current week has unsaved edits.
  const exportWorkbook = useCallback(async (scope: 'week' | 'all') => {
    setExportMenuOpen(false);
    if (scope === 'week' && dirty && !window.confirm('This week has unsaved changes — export the last SAVED data anyway?')) return;
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
  }, [dirty, period]);

  const persist = useCallback(async (action: 'save' | 'lock'): Promise<boolean> => {
    if (!period) return false;
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
      setRows(fresh.length ? fresh : isLocked ? [] : emptyWeekSeed(period));
      setLocked(isLocked);
      setLockedAt(json.period?.locked_at ?? null);
      setLockedBy(json.period?.locked_by ?? null);
      setDirty(false);
      setSelectedKeys(new Set());
      setSel(null);
      setEditing(null);
      setLoaded(true);
      liveSaved(); // tell co-editors to resync (avoids a duplicate insert of a shared new row)
      const filled = fresh.filter((r) => !rowIsBlank(r)).length;
      toast.success(
        action === 'lock'
          ? `Locked in ${filled} ${filled === 1 ? 'hire' : 'hires'} for ${formatWeekLabel(period)}`
          : `Saved ${filled} ${filled === 1 ? 'hire' : 'hires'} to ${formatWeekLabel(period)}`,
      );
      void loadPeriods();
      return true;
    } catch (e) {
      toast.error(e instanceof Error ? e.message : 'Save failed');
      return false;
    } finally {
      setSaving(false);
    }
  }, [period, rows, loadPeriods, liveSaved]);

  const reopen = useCallback(async (): Promise<boolean> => {
    if (!period) return false;
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
      setRows(fresh.length ? fresh : emptyWeekSeed(period));
      setLocked(false);
      setLockedAt(null);
      setLockedBy(null);
      setDirty(false);
      toast.success(`Reopened ${formatWeekLabel(period)} for editing`);
      liveSaved(); // reopen changes the shared grid too — nudge co-editors to resync
      void loadPeriods();
      return true;
    } catch (e) {
      toast.error(e instanceof Error ? e.message : 'Reopen failed');
      return false;
    } finally {
      setSaving(false);
    }
  }, [period, loadPeriods, liveSaved]);

  // Run the password-gated action the dialog just confirmed; close the dialog
  // only on success (a failure keeps it open so the passphrase can be retried).
  const runGatedAction = useCallback(async (): Promise<boolean> => {
    const ok = actionDialog === 'lock' ? await persist('lock') : await reopen();
    if (ok) setActionDialog(null);
    return ok;
  }, [actionDialog, persist, reopen]);

  // Lock / reopen a specific week straight from the dropdown. Locking requires
  // that week's rows loaded (the server sends the whole grid + fires the
  // orientation emails), and it's safest to always show the HR Manager the week
  // they're about to act on — so if it isn't the active week we switch to it
  // first and let the effect below open the dialog once it's loaded.
  const startPeriodAction = useCallback((targetPeriod: string, mode: LockDialogMode) => {
    setPeriodMenuOpen(false);
    if (targetPeriod === period && loaded && !loading) {
      setActionDialog(mode);
      return;
    }
    if (targetPeriod !== period) {
      if (dirty && !window.confirm('Discard unsaved changes and switch weeks?')) return;
      setPeriod(targetPeriod);
      setLoaded(false);
      setSavedSignal(null);
    }
    setPendingAction({ period: targetPeriod, mode });
  }, [period, loaded, loading, dirty]);

  // Once the week a dropdown action asked for is in view (loaded, not loading),
  // pop its dialog. A failed load leaves `loaded` false so nothing opens.
  useEffect(() => {
    if (!pendingAction) return;
    if (pendingAction.period !== period || loading || !loaded) return;
    setActionDialog(pendingAction.mode);
    setPendingAction(null);
  }, [pendingAction, period, loading, loaded]);

  const filledCount = useMemo(() => rows.filter((r) => !rowIsBlank(r)).length, [rows]);

  // Normalised (min→max) selection rectangle for highlighting cells.
  const selBounds = useMemo(() => {
    if (!sel) return null;
    return {
      r0: Math.min(sel.ar, sel.hr),
      r1: Math.max(sel.ar, sel.hr),
      c0: Math.min(sel.ac, sel.hc),
      c1: Math.max(sel.ac, sel.hc),
    };
  }, [sel]);

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
    setSel(null); // row indices shifted — drop the cell selection
    setEditing(null);
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
                      Start Week
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
                            disabled={saving}
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
                            disabled={saving}
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
                  onClick={() => setActionDialog('lock')}
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
                onClick={() => setActionDialog('reopen')}
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
                Works like a spreadsheet: <strong>click</strong> a cell to select it, <strong>drag</strong> or{' '}
                <strong>Shift-click</strong> to highlight a range, then <strong>double-click</strong> (or just start
                typing / press Enter) to edit. <strong>Ctrl/Cmd+C</strong> copies the highlighted range and{' '}
                <strong>Delete</strong> clears it. Paste a column from Excel / Google Sheets into any cell and it fills
                straight down. <strong>Source</strong>, <strong>Department</strong> and <strong>Country</strong> offer a dropdown while editing — pick <strong>Referral</strong> as the source and <strong>Referred By</strong> (checked against the Global Master List) is required.
                Tick rows to bulk-apply a department / country. A green dot in a cell&apos;s corner means it&apos;s been
                edited — click it for the full history. <strong>Lock in</strong> saves this week&apos;s hires and feeds
                the per-country <strong>Bulk Invite</strong> in Onboarding. Reopen any week to edit.
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
              <datalist id="nhc-sources">
                {sourceOptions.map((s) => (<option key={s} value={s} />))}
              </datalist>
              <datalist id="nhc-referrers">
                {referrers.map((n) => (<option key={n} value={n} />))}
              </datalist>

              {rows.length === 0 ? (
                <div className="flex flex-1 flex-col items-center justify-center gap-2 rounded-2xl border border-dashed border-emerald-200 bg-white py-12 text-center dark:border-emerald-950/40 dark:bg-[#0d1117]">
                  <ClipboardList className="h-7 w-7 text-emerald-300 dark:text-emerald-800" />
                  <p className="text-sm text-zinc-500">No hires saved for {formatWeekLabel(period)}.</p>
                  {locked && (
                    <Button type="button" size="sm" onClick={() => setActionDialog('reopen')} disabled={saving} className="mt-1 gap-1.5 bg-amber-500 text-white hover:bg-amber-600">
                      <LockOpen className="h-3.5 w-3.5" /> Reopen to add hires
                    </Button>
                  )}
                </div>
              ) : (
                <div className="relative min-h-0 flex-1">
                <div
                  ref={registerScrollSurface}
                  tabIndex={0}
                  aria-label="New hire checklist grid — click or use arrow keys to select cells; Enter, F2, or double-click to edit; Ctrl+C to copy, Delete to clear"
                  onKeyDown={gridKeyDown}
                  onCopy={gridCopy}
                  onPaste={gridPaste}
                  className="relative h-full w-full overflow-auto rounded-2xl border border-emerald-100/80 bg-white shadow-sm outline-none focus-visible:ring-2 focus-visible:ring-emerald-400/40 dark:border-emerald-950/40 dark:bg-zinc-950"
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
                        {!locked && <th className="w-16 border-b border-emerald-100/80 px-1 py-2 dark:border-emerald-950/40" />}
                      </tr>
                    </thead>
                    <tbody>
                      {rows.map((row, r) => {
                        const isSelected = selectedKeys.has(row._key);
                        // A referral hire must name who referred them — flag the
                        // Referred By cell amber until it's filled.
                        const needsReferrer = isReferralSource(row.source || '') && !(row.referred_by || '').trim();
                        const rowPeers = peersByRow.get(r) ?? [];
                        const rowPeerColor = rowPeers[0]?.color;
                        const rowPeerNames = rowPeers
                          .map((p) => p.name?.trim() || p.email.split('@')[0])
                          .join(', ');
                        return (
                          <tr
                            key={row._key}
                            className={cn(
                              'group/row hover:bg-emerald-50/40 dark:hover:bg-emerald-950/20',
                              isSelected ? 'bg-emerald-50 dark:bg-emerald-950/30' : 'even:bg-zinc-50/40 dark:even:bg-zinc-900/30',
                            )}
                            style={rowPeerColor ? { boxShadow: `inset 3px 0 0 0 ${rowPeerColor}` } : undefined}
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
                                title={
                                  rowPeers.length > 0
                                    ? `${rowPeerNames} ${rowPeers.length > 1 ? 'are' : 'is'} already in this row`
                                    : undefined
                                }
                              >
                                {!locked && (
                                  <input
                                    type="checkbox"
                                    checked={isSelected}
                                    onChange={() => toggleRow(row._key)}
                                    aria-label={`Select row ${r + 1}`}
                                    className="h-3.5 w-3.5 cursor-pointer accent-emerald-600"
                                  />
                                )}
                                <span className="relative tabular-nums text-[11px] text-zinc-400">
                                  {r + 1}
                                  {rowPeerColor && (
                                    <motion.span
                                      aria-hidden
                                      className="absolute -right-1.5 top-0 h-2.5 w-[2px] rounded-full"
                                      style={{ background: rowPeerColor }}
                                      animate={{ opacity: [1, 0.15, 1] }}
                                      transition={{ duration: 0.9, repeat: Infinity, ease: 'linear' }}
                                    />
                                  )}
                                </span>
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
                                    : c.key === 'source'
                                      ? 'nhc-sources'
                                      : c.key === 'referred_by'
                                        ? referrers.length > 0 ? 'nhc-referrers' : undefined
                                        : undefined;
                              const peerHere = peerByCell.get(`${r}:${c.key}`) ?? null;
                              const isEditing = editing?.r === r && editing?.c === ci;
                              const inSel =
                                !!selBounds && r >= selBounds.r0 && r <= selBounds.r1 && ci >= selBounds.c0 && ci <= selBounds.c1;
                              const isHead = sel?.hr === r && sel?.hc === ci;
                              const widthClass = listId ? 'min-w-[10rem]' : 'min-w-[8rem]';
                              return (
                                <td
                                  key={c.key}
                                  onMouseDown={(e) => cellMouseDown(e, r, ci)}
                                  onMouseEnter={() => cellMouseEnter(r, ci)}
                                  onDoubleClick={() => beginEdit(r, ci, { selectAll: true })}
                                  className={cn(
                                    'relative border-b border-emerald-50/80 p-0 dark:border-zinc-800/80',
                                    !isEditing && 'cursor-cell',
                                    inSel && !isEditing && 'bg-emerald-200/70 dark:bg-emerald-700/40',
                                    c.key === 'referred_by' && needsReferrer && !inSel && !isEditing &&
                                      'bg-amber-50 ring-1 ring-inset ring-amber-300 dark:bg-amber-950/30 dark:ring-amber-700/60',
                                  )}
                                >
                                  {hasEdits && (
                                    <button
                                      type="button"
                                      data-cell-history-dot
                                      onMouseDown={(e) => e.stopPropagation()}
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
                                      className="absolute right-0.5 top-0.5 z-[4] flex h-3 w-3 items-center justify-center"
                                    >
                                      <span className="h-1.5 w-1.5 rounded-full bg-emerald-500 ring-2 ring-white dark:bg-emerald-400 dark:ring-zinc-950" />
                                    </button>
                                  )}
                                  {isEditing ? (
                                    <input
                                      data-cell={`${r}-${ci}`}
                                      list={listId}
                                      value={value}
                                      onFocus={() => {
                                        activeCellRef.current = { r, col: c.key };
                                        liveFocus(r, row._cid, c.key);
                                      }}
                                      onChange={(e) => {
                                        setCell(r, c.key, e.target.value);
                                        liveEdit(r, row._cid, c.key, e.target.value);
                                      }}
                                      onPaste={(e) => handlePaste(e, r, ci)}
                                      onKeyDown={(e) => editingKeyDown(e, r, ci)}
                                      onBlur={(e) => {
                                        if (escapingRef.current) {
                                          escapingRef.current = false;
                                          const pre = preEditRef.current;
                                          if (pre && pre.r === r && pre.c === ci) {
                                            setCell(r, c.key, pre.value);
                                            liveEdit(r, row._cid, c.key, pre.value);
                                          }
                                        } else if (listId && (c.key === 'department' || c.key === 'country')) {
                                          const canon =
                                            c.key === 'department'
                                              ? canonicalizeDept(e.target.value, departments)
                                              : canonicalizeCountry(e.target.value);
                                          if (canon !== e.target.value) {
                                            setCell(r, c.key, canon);
                                            liveEdit(r, row._cid, c.key, canon);
                                          }
                                        }
                                        liveBlur(r, row._cid, c.key);
                                        if (activeCellRef.current?.r === r && activeCellRef.current?.col === c.key) {
                                          activeCellRef.current = null;
                                        }
                                        setEditing((cur) => (cur?.r === r && cur?.c === ci ? null : cur));
                                      }}
                                      className={cn(
                                        'relative z-[3] h-9 w-full bg-emerald-50/90 px-2.5 text-[13px] text-zinc-800 outline-none ring-2 ring-inset ring-emerald-500 placeholder:text-zinc-300 dark:bg-emerald-950/50 dark:text-zinc-100',
                                        listId ? cn(widthClass, SELECT_SCHEME_CLASS) : widthClass,
                                      )}
                                    />
                                  ) : (
                                    <div
                                      className={cn(
                                        'flex h-9 select-none items-center whitespace-nowrap px-2.5 text-[13px]',
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
                                  )}
                                  {/* Active-cell outline for the current selection head. */}
                                  {isHead && !isEditing && (
                                    <span
                                      aria-hidden
                                      className="pointer-events-none absolute inset-0 z-[2] rounded-[1px] ring-2 ring-inset ring-emerald-500"
                                    />
                                  )}
                                  {/* Live co-editing: a peer is in this cell right
                                      now — ring it in their identity color + tag
                                      it with their name (their keystrokes stream
                                      into the value above in real time). */}
                                  {peerHere && (
                                    <>
                                      <span
                                        aria-hidden
                                        className="pointer-events-none absolute inset-0 z-[2] rounded-[2px]"
                                        style={{ boxShadow: `inset 0 0 0 2px ${peerHere.color}` }}
                                      />
                                      <span
                                        className={cn(
                                          // z above the sticky header (z-10) + sticky row-number cell (z-20)
                                          // so the name isn't painted over at the header boundary.
                                          'pointer-events-none absolute left-0 z-[21] flex max-w-full items-center whitespace-nowrap rounded px-1 py-px text-[9px] font-semibold leading-none text-white shadow-sm',
                                          r === 0 ? 'top-full mt-px' : 'bottom-full mb-px',
                                        )}
                                        style={{ background: peerHere.color }}
                                        title={`${(peerHere.name && peerHere.name.trim()) || peerHere.email} is editing this cell`}
                                      >
                                        {(peerHere.name && peerHere.name.trim()) || peerHere.email.split('@')[0]}
                                      </span>
                                    </>
                                  )}
                                </td>
                              );
                            })}
                            {!locked && (
                              <td className="border-b border-emerald-50/80 px-1 dark:border-zinc-800/80">
                                <div className="flex items-center justify-center gap-0.5">
                                  <button
                                    type="button"
                                    onClick={() => setEditor({ mode: 'edit', key: row._key })}
                                    aria-label={`Edit row ${r + 1} in a form`}
                                    title="Edit this hire in a form"
                                    className="rounded p-1 text-zinc-300 opacity-0 transition hover:bg-emerald-50 hover:text-emerald-600 focus:opacity-100 group-hover/row:opacity-100 dark:hover:bg-emerald-950/30 dark:hover:text-emerald-300"
                                  >
                                    <Pencil className="h-3.5 w-3.5" />
                                  </button>
                                  <button
                                    type="button"
                                    onClick={() => deleteRow(r, row._key)}
                                    aria-label={`Delete row ${r + 1}`}
                                    className="rounded p-1 text-zinc-300 opacity-0 transition hover:bg-rose-50 hover:text-rose-500 focus:opacity-100 group-hover/row:opacity-100 dark:hover:bg-rose-950/30"
                                  >
                                    <Trash2 className="h-3.5 w-3.5" />
                                  </button>
                                </div>
                              </td>
                            )}
                          </tr>
                        );
                      })}
                    </tbody>
                  </table>
                </div>

                {/* "New Hire" CTA — a neon-green glowing button pinned to the
                    lower-right corner of the table (stays put while the grid
                    scrolls). Greyed out + inert once the week is locked in;
                    reopen the week to re-enable it. */}
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
                      onClick={() => setEditor({ mode: 'add' })}
                      disabled={saving}
                      aria-label="Add a new hire"
                      initial={false}
                      animate={
                        reduceMotion || saving
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

      {/* Password-gated Lock in / Reopen (fires / warns about the orientation
          automation) — restricted to the HR Manager passphrase. */}
      <NewHireChecklistLockDialog
        mode={actionDialog}
        weekLabel={formatWeekLabel(period)}
        orientationLabel={formatOrientationLabel(period)}
        hireCount={filledCount}
        lockedBy={lockedBy}
        lockedStamp={formatLockStamp(lockedAt) || null}
        onCancel={() => setActionDialog(null)}
        onConfirm={runGatedAction}
      />

      {/* "New Hire" modal — 'add' appends a hire; 'edit' (a row's Edit button)
          pre-fills the form and updates that row in place. */}
      <NewHireQuickAddDialog
        open={editor !== null}
        mode={editor?.mode ?? 'add'}
        weekLabel={formatWeekLabel(period)}
        departments={departments}
        sources={sourceOptions}
        referrers={referrers}
        initialValues={
          editor?.mode === 'edit'
            ? (() => {
                const rw = rows.find((r) => r._key === editor.key);
                return rw ? rowToValues(rw) : null;
              })()
            : null
        }
        onCancel={() => setEditor(null)}
        onSave={(values) => {
          if (editor?.mode === 'edit') handleEditHire(editor.key, values);
          else handleQuickAdd(values);
        }}
      />
    </div>
  );
}
