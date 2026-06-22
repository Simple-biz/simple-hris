'use client';

import React, { useCallback, useEffect, useMemo, useState } from 'react';
import { AnimatePresence, motion } from 'motion/react';
import {
  CheckCircle2, ChevronDown, ChevronLeft, ChevronRight, Download, Eye,
  Filter, Lock, RefreshCw, RotateCcw, Save, Search, Users, X,
} from 'lucide-react';

const COLLAPSE_EASE = [0.22, 1, 0.36, 1] as const;
import { toast } from 'sonner';
import { Button } from '@/components/ui/button';
import { cn } from '@/lib/utils';
import {
  BonusStatus, DeptConfig, HslDeptKey, HSL_DEPTS, HSL_DEPT_KEYS,
  KpiData, SubTeamName, TeamSplitRule, TieredRule,
  calcBonus, calcTeamSplitShare, canAccessHslDept, formatPeso,
} from '@/lib/hsl-bonus/schema';
import { parseDateRangeFromFilename } from '@/lib/hubstaff/calendar-column-dedupe';
import {
  pickCurrentSourceFile,
  type HubstaffSourceFilesResponse,
} from '@/lib/hubstaff/current-upload';
import HslBonusReadyPreview from './HslBonusReadyPreview';
import KpiCalculatorLoading from './KpiCalculatorLoading';
import { useDispatchLock } from '@/hooks/useDispatchLock';
import { useLiveRefresh } from '@/hooks/useLiveRefresh';

// ── Types ─────────────────────────────────────────────────────────────────────

export interface EntryRow {
  id?: string;
  employee_email: string;
  employee_name: string;
  is_manager: boolean;
  kpi_data: KpiData;
  calculated_bonus: number;
}

export interface SubTeamState {
  pct: string;
  records: string;
}

interface DeptState {
  entries: EntryRow[];
  status: BonusStatus;
  subTeams: Record<SubTeamName, SubTeamState>;
  dirty: boolean;
  saving: boolean;
}

type AllDeptState = Record<HslDeptKey, DeptState>;

export const DEFAULT_SUB_TEAMS: Record<SubTeamName, SubTeamState> = {
  BLUE: { pct: '', records: '' },
  GREEN: { pct: '', records: '' },
  YELLOW: { pct: '', records: '' },
  ORANGE: { pct: '', records: '' },
  PURPLE: { pct: '', records: '' },
  RED: { pct: '', records: '' },
};

export interface SubTeamPalette {
  ring:       string;  // outer ring colour
  headerBg:   string;  // top strip
  headerText: string;
  bodyBg:     string;  // inner card body
  accent:     string;  // text-color for share + tier
  dotOn:      string;  // filled tier dot
}

export const SUB_TEAM_PALETTE: Record<SubTeamName, SubTeamPalette> = {
  BLUE: {
    ring:       'ring-blue-400/60 dark:ring-blue-500/50',
    headerBg:   'bg-gradient-to-r from-blue-500 to-blue-600 dark:from-blue-600 dark:to-blue-700',
    headerText: 'text-white',
    bodyBg:     'bg-blue-50/60 dark:bg-blue-950/30',
    accent:     'text-blue-700 dark:text-blue-300',
    dotOn:      'bg-blue-500 dark:bg-blue-400',
  },
  GREEN: {
    ring:       'ring-emerald-400/60 dark:ring-emerald-500/50',
    headerBg:   'bg-gradient-to-r from-emerald-500 to-emerald-600 dark:from-emerald-600 dark:to-emerald-700',
    headerText: 'text-white',
    bodyBg:     'bg-emerald-50/60 dark:bg-emerald-950/30',
    accent:     'text-emerald-700 dark:text-emerald-300',
    dotOn:      'bg-emerald-500 dark:bg-emerald-400',
  },
  YELLOW: {
    ring:       'ring-yellow-400/60 dark:ring-yellow-500/50',
    headerBg:   'bg-gradient-to-r from-yellow-400 to-amber-500 dark:from-yellow-500 dark:to-amber-600',
    headerText: 'text-zinc-900',
    bodyBg:     'bg-yellow-50/60 dark:bg-yellow-950/30',
    accent:     'text-amber-700 dark:text-amber-300',
    dotOn:      'bg-yellow-500 dark:bg-yellow-400',
  },
  ORANGE: {
    ring:       'ring-orange-400/60 dark:ring-orange-500/50',
    headerBg:   'bg-gradient-to-r from-orange-500 to-orange-600 dark:from-orange-600 dark:to-orange-700',
    headerText: 'text-white',
    bodyBg:     'bg-orange-50/60 dark:bg-orange-950/30',
    accent:     'text-orange-700 dark:text-orange-300',
    dotOn:      'bg-orange-500 dark:bg-orange-400',
  },
  PURPLE: {
    ring:       'ring-violet-400/60 dark:ring-violet-500/50',
    headerBg:   'bg-gradient-to-r from-violet-500 to-violet-600 dark:from-violet-600 dark:to-violet-700',
    headerText: 'text-white',
    bodyBg:     'bg-violet-50/60 dark:bg-violet-950/30',
    accent:     'text-violet-700 dark:text-violet-300',
    dotOn:      'bg-violet-500 dark:bg-violet-400',
  },
  RED: {
    ring:       'ring-red-400/60 dark:ring-red-500/50',
    headerBg:   'bg-gradient-to-r from-red-500 to-red-600 dark:from-red-600 dark:to-red-700',
    headerText: 'text-white',
    bodyBg:     'bg-red-50/60 dark:bg-red-950/30',
    accent:     'text-red-700 dark:text-red-300',
    dotOn:      'bg-red-500 dark:bg-red-400',
  },
};

/** Active sub-team filter for the SSD roster: a specific team, every member
 *  ('ALL'), or only the still-unassigned ('NONE'). */
export type SubTeamFilter = SubTeamName | 'ALL' | 'NONE';

/** Monday-of-week containing `d`, formatted as YYYY-MM-DD in *local* time.
 *  HSL departments work Mon–Sun, so weeks pivot on Monday. We avoid
 *  `toISOString()` here because it converts to UTC and can shift the date
 *  back a day for late-evening UTC+ users. */
function isoWeekStart(d: Date): string {
  const day = new Date(d.getFullYear(), d.getMonth(), d.getDate());
  const dow = day.getDay(); // 0=Sun … 6=Sat
  const daysBack = dow === 0 ? 6 : dow - 1; // Sunday is 6 back, otherwise dow-1
  day.setDate(day.getDate() - daysBack);
  const yyyy = day.getFullYear();
  const mm = String(day.getMonth() + 1).padStart(2, '0');
  const dd = String(day.getDate()).padStart(2, '0');
  return `${yyyy}-${mm}-${dd}`;
}

function isoMonthStart(d: Date): string {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-01`;
}

function isoWeekEnd(start: string): string {
  const d = new Date(start);
  d.setDate(d.getDate() + 6);
  return d.toISOString().slice(0, 10);
}

function isoMonthEnd(start: string): string {
  const [y, m] = start.split('-').map(Number);
  return new Date(y!, m!, 0).toISOString().slice(0, 10);
}

function periodEnd(dept: DeptConfig, start: string): string {
  return dept.cadence === 'weekly' ? isoWeekEnd(start) : isoMonthEnd(start);
}

/**
 * Per-employee bonus recompute for SSD Medical Records (team_split rule).
 * `calcBonus` skips team_split rules because the share depends on team-level
 * pct/records held in `subTeams` state, not on `kpi_data`. This computes the
 * share and writes it into each entry's `calculated_bonus` so dept totals,
 * the View modal, and persisted `hsl_bonus_entries.calculated_bonus` (read by
 * PayrollWizard) all reflect reality.
 *
 * Returns a new entries array; pass-through if not SSD.
 */
export function recomputeSsdEntries(
  deptKey: HslDeptKey,
  entries: EntryRow[],
  subTeams: Record<SubTeamName, SubTeamState>,
): EntryRow[] {
  if (deptKey !== 'ssd_medical_records') return entries;
  const rule = HSL_DEPTS.ssd_medical_records.rules[0] as TeamSplitRule;
  const memberCounts: Record<string, number> = {};
  for (const e of entries) {
    const st = String(e.kpi_data.sub_team ?? '');
    if (st) memberCounts[st] = (memberCounts[st] ?? 0) + 1;
  }
  return entries.map((e) => {
    const st = String(e.kpi_data.sub_team ?? '') as SubTeamName | '';
    if (!st) return e.calculated_bonus === 0 ? e : { ...e, calculated_bonus: 0 };
    const sub = subTeams[st];
    const pct = parseFloat(sub.pct) || 0;
    const records = parseInt(sub.records, 10) || 0;
    const share = calcTeamSplitShare(pct, records, memberCounts[st] ?? 0, rule);
    return e.calculated_bonus === share ? e : { ...e, calculated_bonus: share };
  });
}

function periodLabel(dept: DeptConfig, start: string): string {
  if (dept.cadence === 'weekly') {
    const s = new Date(start + 'T00:00:00');
    const e = new Date(isoWeekEnd(start) + 'T00:00:00');
    return `${s.toLocaleDateString('en-US', { month: 'short', day: 'numeric' })} – ${e.toLocaleDateString('en-US', { month: 'short', day: 'numeric' })}`;
  }
  const [y, m] = start.split('-').map(Number);
  return new Date(y!, m! - 1, 1).toLocaleDateString('en-US', { month: 'long', year: 'numeric' });
}

// Canonical HSL roster row from `hsl_team_members` table.
// NOTE: hourly_rate/ot_rate are intentionally NOT part of this shape — the
// /api/hsl-bonus/team-members endpoint no longer ships pay rates to the client
// (Accounting/CEO only) and the calculator never used them.
interface HslMember {
  email: string;
  full_name: string | null;
  hsl_name: string | null;
  is_manager: boolean;
  sub_team: SubTeamName | null;
}

// ── Props ─────────────────────────────────────────────────────────────────────

interface HslBonusCalculatorProps {
  viewerEmail: string | null;
  managedDepts: string[];
  isElevated: boolean;
}

// ── Main component ────────────────────────────────────────────────────────────

export default function HslBonusCalculator({
  viewerEmail,
  managedDepts,
  isElevated,
}: HslBonusCalculatorProps) {
  const today = new Date();
  const [weekStart, setWeekStart] = useState(() => isoWeekStart(today));
  const [monthStart] = useState(() => isoMonthStart(today));

  const visibleDepts = useMemo<HslDeptKey[]>(
    () => HSL_DEPT_KEYS.filter((k) => canAccessHslDept(managedDepts, k, isElevated)),
    [managedDepts, isElevated],
  );

  const [deptState, setDeptState] = useState<AllDeptState>(() => {
    const init = {} as AllDeptState;
    for (const k of HSL_DEPT_KEYS) {
      init[k] = {
        entries: [],
        status: 'draft',
        subTeams: { ...DEFAULT_SUB_TEAMS },
        dirty: false,
        saving: false,
      };
    }
    return init;
  });

  const [loadingDepts, setLoadingDepts] = useState<Set<HslDeptKey>>(new Set());
  /** Which dept's preview modal is open (null = closed). Mounted at the parent so
   *  it overlays the page rather than nesting inside a single dept block. */
  const [viewingDept, setViewingDept] = useState<HslDeptKey | null>(null);
  const [reopenSubmitting, setReopenSubmitting] = useState(false);
  const { state: dispatchLock } = useDispatchLock();
  const payrollLocked = dispatchLock.locked;

  // Department navigation: which dept's block is expanded, and the active filter
  // pill. With many HSL branches visible at once a flat stack is unreadable, so
  // "All" shows a collapsed overview and a single dept can be focused.
  const [activeFilter, setActiveFilter] = useState<HslDeptKey | 'all'>('all');
  const [manualOpen, setManualOpen] = useState<Record<string, boolean>>({});

  function periodStart(dept: DeptConfig): string {
    return dept.cadence === 'weekly' ? weekStart : monthStart;
  }

  function setDept(key: HslDeptKey, patch: Partial<DeptState>) {
    setDeptState((prev) => ({ ...prev, [key]: { ...prev[key]!, ...patch } }));
  }

  function patchEntry(key: HslDeptKey, email: string, patch: Partial<EntryRow>) {
    setDeptState((prev) => {
      const d = prev[key]!;
      return {
        ...prev,
        [key]: {
          ...d,
          dirty: true,
          entries: d.entries.map((e) =>
            e.employee_email === email ? { ...e, ...patch } : e,
          ),
        },
      };
    });
  }

  // ── Load entries from DB and merge with roster auto-population ─────────────

  const loadDept = useCallback(async (key: HslDeptKey) => {
    const dept = HSL_DEPTS[key];
    const start = periodStart(dept);
    setLoadingDepts((prev) => new Set([...prev, key]));
    try {
      const [entriesRes, statusRes, membersRes] = await Promise.all([
        fetch(`/api/hsl-bonus/entries?dept=${key}&period_start=${start}`, { cache: 'no-store' }),
        fetch(`/api/hsl-bonus/period-status?dept=${key}&period_start=${start}`, { cache: 'no-store' }),
        fetch(`/api/hsl-bonus/team-members?dept=${key}`, { cache: 'no-store' }),
      ]);
      const entriesJson = (await entriesRes.json()) as { rows?: {
        id: string; employee_email: string; employee_name: string | null;
        is_manager: boolean; kpi_data: KpiData; calculated_bonus: number;
      }[] };
      const statusJson = (await statusRes.json()) as { rows?: { status: BonusStatus }[] };
      const membersJson = (await membersRes.json()) as { rows?: HslMember[] };

      // DB entries (existing scored data) — these win over roster defaults
      const byEmail = new Map<string, EntryRow>();
      (entriesJson.rows ?? []).forEach((r) => {
        byEmail.set(r.employee_email.toLowerCase(), {
          id: r.id,
          employee_email: r.employee_email.toLowerCase(),
          employee_name: r.employee_name ?? r.employee_email,
          is_manager: r.is_manager,
          kpi_data: r.kpi_data ?? {},
          calculated_bonus: r.calculated_bonus ?? 0,
        });
      });

      // Seed any roster members from hsl_team_members who aren't in entries yet.
      // Pre-fill kpi_data.sub_team for SSD so the dropdown reflects the seeded assignment.
      (membersJson.rows ?? []).forEach((m) => {
        const email = m.email.toLowerCase();
        if (!email || byEmail.has(email)) return;
        const kpi: KpiData = {};
        if (m.sub_team) (kpi as unknown as Record<string, string>).sub_team = m.sub_team;
        byEmail.set(email, {
          employee_email: email,
          employee_name: m.full_name ?? m.hsl_name ?? email,
          is_manager: m.is_manager,
          kpi_data: kpi,
          calculated_bonus: 0,
        });
      });

      const sortedEntries = Array.from(byEmail.values()).sort((a, b) =>
        a.employee_name.localeCompare(b.employee_name),
      );
      const status: BonusStatus = statusJson.rows?.[0]?.status ?? 'draft';
      // After load, recompute SSD per-employee shares so the dept total +
      // table read from the right values (DB persists 0 for legacy entries).
      setDeptState((prev) => {
        const recomputed = recomputeSsdEntries(key, sortedEntries, prev[key]!.subTeams);
        return {
          ...prev,
          [key]: { ...prev[key]!, entries: recomputed, status, dirty: false },
        };
      });
    } catch {
      // silent — table may be empty on first use
    } finally {
      setLoadingDepts((prev) => {
        const next = new Set(prev);
        next.delete(key);
        return next;
      });
    }
  }, [weekStart, monthStart]); // eslint-disable-line react-hooks/exhaustive-deps

  // First-load gate: show a loading screen until every visible dept's initial
  // fetch has settled, so switching to the tab doesn't flash an empty calculator.
  const [booted, setBooted] = useState(false);
  useEffect(() => {
    let cancelled = false;
    void (async () => {
      await Promise.all(visibleDepts.map((k) => loadDept(k)));
      if (!cancelled) setBooted(true);
    })();
    return () => {
      cancelled = true;
    };
  }, [visibleDepts, loadDept]);

  // ── Live refresh ───────────────────────────────────────────────────────────
  // Reload every visible dept, but skip any with unsaved local edits (`dirty`)
  // or an in-flight save so another scorer's change can't clobber work in
  // progress. Used by both the manual Refresh button and the live subscription.
  const [refreshing, setRefreshing] = useState(false);
  const refreshAll = useCallback(async () => {
    await Promise.all(
      visibleDepts.map((k) => {
        const d = deptState[k];
        if (d?.dirty || d?.saving) return Promise.resolve();
        return loadDept(k);
      }),
    );
  }, [visibleDepts, deptState, loadDept]);

  const manualRefresh = useCallback(async () => {
    setRefreshing(true);
    try {
      await refreshAll();
    } finally {
      setRefreshing(false);
    }
  }, [refreshAll]);

  // See teammates' scoring as it lands: watch the entry + status tables and
  // re-pull (debounced). Falls back to a 30s poll + tab-focus refresh when
  // Realtime isn't available for these tables.
  useLiveRefresh({
    tables: ['hsl_bonus_entries', 'hsl_bonus_period_status'],
    onRefresh: refreshAll,
    channel: 'hsl-bonus-calc-live',
    enabled: visibleDepts.length > 0,
  });

  // Pin the KPI week to the Hubstaff batch accounting is dispatching — the
  // Initialized (is_current) upload, NOT merely the newest file. The public
  // endpoint returns newest-first, so we resolve the current batch the same way
  // the Payroll Wizard does (pickCurrentSourceFile) to keep the manager's KPI
  // week in lock-step with the week accounting processes.
  useEffect(() => {
    (async () => {
      try {
        const res = await fetch('/api/hubstaff-hours?source_files=1', { cache: 'no-store' });
        const json = (await res.json()) as HubstaffSourceFilesResponse;
        const latest = pickCurrentSourceFile(json.uploads, json.files);
        if (latest) {
          const range = parseDateRangeFromFilename(latest);
          if (range) {
            const d = range.start;
            const iso = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
            setWeekStart(iso);
          }
        }
      } catch {
        // keep today's week on any error
      }
    })();
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  // ── Save entries to DB ─────────────────────────────────────────────────────

  async function saveDept(key: HslDeptKey) {
    const d = deptState[key]!;
    const dept = HSL_DEPTS[key];
    const start = periodStart(dept);
    const end = periodEnd(dept, start);

    setDept(key, { saving: true });
    try {
      const entries = d.entries.map((e) => ({
        department: key,
        period_type: dept.cadence,
        period_start: start,
        period_end: end,
        employee_email: e.employee_email,
        employee_name: e.employee_name,
        is_manager: e.is_manager,
        kpi_data: e.kpi_data,
        calculated_bonus: e.calculated_bonus,
        created_by: viewerEmail ?? undefined,
      }));

      const res = await fetch('/api/hsl-bonus/entries', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ entries }),
      });
      const json = (await res.json()) as { error?: string; saved?: number };
      if (!res.ok) throw new Error(json.error ?? 'Save failed');

      setDept(key, { dirty: false });
      toast.success(`${dept.name} saved`, { description: `${json.saved ?? 0} entries updated` });
    } catch (e) {
      toast.error('Save failed', { description: e instanceof Error ? e.message : 'Unknown error' });
    } finally {
      setDept(key, { saving: false });
    }
  }

  async function setStatus(key: HslDeptKey, next: BonusStatus): Promise<boolean> {
    const dept = HSL_DEPTS[key];
    const start = periodStart(dept);
    try {
      const res = await fetch('/api/hsl-bonus/period-status', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          department: key,
          period_type: dept.cadence,
          period_start: start,
          period_end: periodEnd(dept, start),
          status: next,
          locked_by: viewerEmail ?? undefined,
        }),
      });
      const json = (await res.json()) as { error?: string };
      if (!res.ok) throw new Error(json.error ?? 'Status update failed');
      setDept(key, { status: next });
      return true;
    } catch (e) {
      toast.error('Status update failed', {
        description: e instanceof Error ? e.message : String(e),
      });
      return false;
    }
  }

  async function markReady(key: HslDeptKey) {
    const d = deptState[key]!;
    if (d.dirty) {
      toast.error('Save your changes first', {
        description: 'Click Save before marking the period Ready.',
      });
      return;
    }
    const ok = await setStatus(key, 'ready');
    if (ok) {
      toast.success(`${HSL_DEPTS[key].name} marked ready`, {
        description: 'Visible to Accounting · PayrollWizard.',
      });
      setViewingDept(key);
    }
  }

  async function reopenToDraft(key: HslDeptKey) {
    setReopenSubmitting(true);
    const ok = await setStatus(key, 'draft');
    setReopenSubmitting(false);
    if (ok) {
      toast.success(`${HSL_DEPTS[key].name} reopened`, {
        description: 'Back to draft — make edits and Mark Ready when done.',
      });
      setViewingDept(null);
    }
  }

  function ssdShareForTeam(subTeam: SubTeamName, memberCount: number): number {
    const d = deptState.ssd_medical_records!;
    const st = d.subTeams[subTeam];
    const pct = parseFloat(st.pct) || 0;
    const records = parseInt(st.records, 10) || 0;
    const rule = HSL_DEPTS.ssd_medical_records.rules[0] as TeamSplitRule;
    return calcTeamSplitShare(pct, records, memberCount, rule);
  }

  function exportCsv() {
    const headers = ['Department', 'Period', 'Employee', 'Email', 'Bonus (PHP)', 'Status'];
    const rows: string[] = [];
    for (const key of visibleDepts) {
      const dept = HSL_DEPTS[key];
      const d = deptState[key]!;
      const period = periodLabel(dept, periodStart(dept));
      for (const e of d.entries) {
        rows.push([
          dept.name,
          period,
          e.employee_name,
          e.employee_email,
          e.calculated_bonus.toFixed(2),
          d.status,
        ].map((v) => `"${v.replace(/"/g, '""')}"`).join(','));
      }
    }
    const csv = '﻿' + [headers.map((h) => `"${h}"`).join(','), ...rows].join('\n');
    const a = document.createElement('a');
    a.href = URL.createObjectURL(new Blob([csv], { type: 'text/csv;charset=utf-8;' }));
    a.download = `hsl-bonus-${isoWeekStart(new Date())}.csv`;
    a.click();
  }

  const grandTotal = useMemo(
    () => visibleDepts.reduce((sum, k) => sum + deptState[k]!.entries.reduce((s, e) => s + e.calculated_bonus, 0), 0),
    [deptState, visibleDepts],
  );

  const totalPeople = useMemo(
    () => visibleDepts.reduce((sum, k) => sum + deptState[k]!.entries.length, 0),
    [deptState, visibleDepts],
  );

  const multiDept = visibleDepts.length > 1;

  // If the active filter points at a dept that's no longer visible, fall back.
  useEffect(() => {
    if (activeFilter !== 'all' && !visibleDepts.includes(activeFilter)) {
      setActiveFilter('all');
    }
  }, [activeFilter, visibleDepts]);

  const filteredDepts = useMemo<HslDeptKey[]>(
    () => (activeFilter === 'all' ? visibleDepts : visibleDepts.filter((k) => k === activeFilter)),
    [activeFilter, visibleDepts],
  );

  // "All" overview lays the collapsed branches out as a grid; an expanded card
  // spans the full width so its wide tables aren't squeezed into one column.
  const gridMode = activeFilter === 'all' && multiDept;

  /** A block is expanded when: only one dept exists, it's the focused filter,
   *  or the user manually opened it. With multiple depts under "All" the blocks
   *  start collapsed so the page reads as a tidy overview. */
  function isOpen(key: HslDeptKey): boolean {
    if (key in manualOpen) return manualOpen[key]!;
    if (!multiDept) return true;
    return activeFilter === key;
  }

  function toggleOpen(key: HslDeptKey) {
    setManualOpen((m) => ({ ...m, [key]: !isOpen(key) }));
  }

  // ── Render ─────────────────────────────────────────────────────────────────

  if (visibleDepts.length === 0) {
    return (
      <div className="flex flex-col items-center justify-center gap-3 px-6 py-20 text-center">
        <Users className="h-10 w-10 text-zinc-300 dark:text-zinc-700" aria-hidden />
        <p className="text-sm font-medium text-zinc-700 dark:text-zinc-300">
          No HSL bonus departments assigned to you.
        </p>
        <p className="max-w-sm text-xs text-zinc-500 dark:text-zinc-500">
          Ask an admin to assign you to one or more HSL sub-departments under
          Roles &amp; permissions.
        </p>
      </div>
    );
  }

  if (!booted) {
    return (
      <KpiCalculatorLoading
        variant="hsl"
        title={
          isElevated
            ? 'All Departments'
            : visibleDepts.length === 1
              ? HSL_DEPTS[visibleDepts[0]!].name
              : 'My Departments'
        }
        cards={visibleDepts.length}
      />
    );
  }

  return (
    <div className="flex min-h-0 flex-col bg-gradient-to-b from-white via-blue-50/20 to-white text-zinc-900 dark:from-black dark:via-blue-950/15 dark:to-black dark:text-zinc-100">
      {/* Top bar */}
      <div className="sticky top-0 z-10 flex flex-col gap-2.5 border-b border-zinc-200/80 bg-white/90 px-5 py-3 backdrop-blur-md dark:border-zinc-800 dark:bg-zinc-950/90">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div>
            <p className="font-mono text-[10px] uppercase tracking-[0.2em] text-zinc-500">
              KPI Calculator · HSL
            </p>
            <h2 className="text-base font-semibold tracking-tight text-zinc-900 dark:text-zinc-100">
              {isElevated ? 'All Departments' : visibleDepts.length === 1 ? HSL_DEPTS[visibleDepts[0]!].name : 'My Departments'}
              <span className="ml-2 font-mono text-xs font-normal text-zinc-500">
                week of {weekStart}
              </span>
            </h2>
          </div>
          <div className="flex items-center gap-2">
            <div className="flex items-center gap-2 rounded-lg border border-zinc-200 bg-white px-3 py-1.5 shadow-sm dark:border-zinc-800 dark:bg-zinc-900/60">
              <span className="font-mono text-[10px] uppercase tracking-[0.15em] text-zinc-500">Total</span>
              <span className="font-mono text-sm font-bold text-emerald-600 dark:text-emerald-400">
                {formatPeso(grandTotal)}
              </span>
              <span className="font-mono text-[10px] text-zinc-500">{totalPeople} ppl</span>
            </div>
            <Button
              size="sm"
              variant="outline"
              className="h-8 gap-1.5 text-xs"
              onClick={() => void manualRefresh()}
              disabled={refreshing}
              title="Reload scores (also updates live as teammates edit)"
            >
              <RefreshCw className={cn('h-3.5 w-3.5', refreshing && 'animate-spin')} />
              {refreshing ? 'Refreshing…' : 'Refresh'}
            </Button>
            {isElevated && (
              <Button
                size="sm"
                variant="outline"
                className="h-8 gap-1.5 text-xs"
                onClick={exportCsv}
              >
                <Download className="h-3.5 w-3.5" /> Export CSV
              </Button>
            )}
          </div>
        </div>

        {/* Department filter rail — focus one branch or scan them all */}
        {multiDept && (
          <div className="-mx-1 flex items-center gap-1.5 overflow-x-auto px-1 pb-0.5">
            <DeptPill
              active={activeFilter === 'all'}
              label="All"
              count={visibleDepts.length}
              onClick={() => setActiveFilter('all')}
            />
            {visibleDepts.map((k) => (
              <DeptPill
                key={k}
                active={activeFilter === k}
                label={HSL_DEPTS[k].name}
                color={HSL_DEPTS[k].color}
                count={deptState[k]!.entries.length}
                onClick={() => {
                  setActiveFilter(k);
                  setManualOpen((m) => ({ ...m, [k]: true }));
                }}
              />
            ))}
          </div>
        )}
      </div>

      {/* Payroll processing lock banner */}
      {payrollLocked && (
        <div className="flex items-center gap-2 border-b border-red-200 bg-red-50 px-5 py-2 text-xs text-red-700 dark:border-red-900 dark:bg-red-950/40 dark:text-red-400">
          <Lock className="h-3.5 w-3.5 shrink-0" />
          <span>Payroll is being processed — KPI Calculator is locked. You cannot mark ready or unready until processing is complete.</span>
        </div>
      )}

      {/* Department blocks */}
      <div
        className={cn(
          'px-4 py-5 sm:px-6',
          gridMode
            ? 'grid grid-cols-1 items-start gap-4 sm:grid-cols-2 xl:grid-cols-3'
            : 'flex flex-col gap-4',
        )}
      >
        {filteredDepts.map((key) => (
          <DeptBlock
            key={key}
            deptKey={key}
            state={deptState[key]!}
            loading={loadingDepts.has(key)}
            collapsible={multiDept}
            open={isOpen(key)}
            sectionClassName={cn(gridMode && isOpen(key) && 'sm:col-span-2 xl:col-span-3')}
            onToggleOpen={() => toggleOpen(key)}
            periodStartStr={periodStart(HSL_DEPTS[key])}
            onKpiChange={(email, kpiKey, val) => {
              setDeptState((prev) => {
                const d = prev[key]!;
                const next = d.entries.map((e) => {
                  if (e.employee_email !== email) return e;
                  const newKpi = { ...e.kpi_data, [kpiKey]: val };
                  return {
                    ...e,
                    kpi_data: newKpi,
                    calculated_bonus: calcBonus(newKpi, HSL_DEPTS[key], e.is_manager),
                  };
                });
                // For SSD, sub_team changes affect every team member's share —
                // the per-member denominator just changed. Recompute the whole list.
                const finalEntries = recomputeSsdEntries(key, next, d.subTeams);
                return { ...prev, [key]: { ...d, entries: finalEntries, dirty: true } };
              });
            }}
            onToggleManager={(email) => {
              setDeptState((prev) => {
                const d = prev[key]!;
                const next = d.entries.map((e) => {
                  if (e.employee_email !== email) return e;
                  const newIsManager = !e.is_manager;
                  return {
                    ...e,
                    is_manager: newIsManager,
                    calculated_bonus: calcBonus(e.kpi_data, HSL_DEPTS[key], newIsManager),
                  };
                });
                // Re-share for SSD — toggling someone's manager flag doesn't
                // change the team_split share but we re-run the recompute so
                // calculated_bonus stays canonical (it was reset by calcBonus=0).
                const finalEntries = recomputeSsdEntries(key, next, d.subTeams);
                return { ...prev, [key]: { ...d, entries: finalEntries, dirty: true } };
              });
            }}
            onSave={() => void saveDept(key)}
            onMarkReady={() => void markReady(key)}
            onMarkUnready={() => void reopenToDraft(key)}
            onView={() => setViewingDept(key)}
            payrollLocked={payrollLocked}
            markUnreadySubmitting={reopenSubmitting}
            onSubTeamChange={(subTeam, field, val) => {
              setDeptState((prev) => {
                const d = prev[key]!;
                const newSubTeams = {
                  ...d.subTeams,
                  [subTeam]: { ...d.subTeams[subTeam], [field]: val },
                };
                // Pct/records changed → recompute per-employee shares so dept
                // total and the persisted `calculated_bonus` reflect the new score.
                const newEntries = recomputeSsdEntries(key, d.entries, newSubTeams);
                return {
                  ...prev,
                  [key]: {
                    ...d,
                    dirty: true,
                    subTeams: newSubTeams,
                    entries: newEntries,
                  },
                };
              });
            }}
            ssdShareForTeam={key === 'ssd_medical_records' ? ssdShareForTeam : undefined}
          />
        ))}
      </div>

      {/* Read-only preview modal — opens on View button click. Reopen flips the
          period back to draft so the manager can edit again. */}
      <HslBonusReadyPreview
        open={viewingDept !== null}
        dept={viewingDept ? HSL_DEPTS[viewingDept] : null}
        status={
          viewingDept && deptState[viewingDept]!.status !== 'draft'
            ? (deptState[viewingDept]!.status as 'ready' | 'locked')
            : 'ready'
        }
        periodLabel={
          viewingDept
            ? periodLabel(HSL_DEPTS[viewingDept], periodStart(HSL_DEPTS[viewingDept]))
            : ''
        }
        entries={viewingDept ? deptState[viewingDept]!.entries : []}
        reopenSubmitting={reopenSubmitting}
        onReopen={() => viewingDept && void reopenToDraft(viewingDept)}
        onClose={() => setViewingDept(null)}
      />
    </div>
  );
}

// ── Department filter pill ──────────────────────────────────────────────────

function DeptPill({
  active, label, color, count, onClick,
}: {
  active: boolean;
  label: string;
  color?: string;
  count: number;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={cn(
        'flex shrink-0 items-center gap-1.5 rounded-full border px-2.5 py-1 text-xs font-medium transition-colors',
        active
          ? 'border-transparent bg-zinc-900 text-white dark:bg-zinc-100 dark:text-zinc-900'
          : 'border-zinc-200 bg-white text-zinc-600 hover:bg-zinc-50 dark:border-zinc-800 dark:bg-zinc-900/50 dark:text-zinc-300 dark:hover:bg-zinc-800/60',
      )}
    >
      {color && <span className="h-2 w-2 shrink-0 rounded-full" style={{ backgroundColor: color }} aria-hidden />}
      <span className="max-w-[10rem] truncate">{label}</span>
      <span className={cn('font-mono text-[10px] tabular-nums', active ? 'opacity-70' : 'text-zinc-400')}>{count}</span>
    </button>
  );
}

// ── DeptBlock ─────────────────────────────────────────────────────────────────

interface DeptBlockProps {
  deptKey: HslDeptKey;
  state: DeptState;
  loading: boolean;
  collapsible: boolean;
  open: boolean;
  sectionClassName?: string;
  onToggleOpen: () => void;
  periodStartStr: string;
  onKpiChange: (email: string, key: string, val: number | boolean) => void;
  onToggleManager: (email: string) => void;
  onSave: () => void;
  onMarkReady: () => void;
  onMarkUnready: () => void;
  onView: () => void;
  onSubTeamChange: (subTeam: SubTeamName, field: 'pct' | 'records', val: string) => void;
  ssdShareForTeam?: (subTeam: SubTeamName, memberCount: number) => number;
  payrollLocked: boolean;
  markUnreadySubmitting: boolean;
}

const DEPT_PAGE_SIZE = 10;

function DeptBlock({
  deptKey, state, loading, collapsible, open, sectionClassName, onToggleOpen, periodStartStr,
  onKpiChange, onToggleManager,
  onSave, onMarkReady, onMarkUnready, onView, onSubTeamChange, ssdShareForTeam,
  payrollLocked, markUnreadySubmitting,
}: DeptBlockProps) {
  const dept = HSL_DEPTS[deptKey];
  const deptTotal = state.entries.reduce((s, e) => s + e.calculated_bonus, 0);
  const isTeamSplit = dept.rules[0]?.type === 'team_split';
  const tieredRule = dept.rules.find((r): r is TieredRule => r.type === 'tiered');
  const isLocked = state.status === 'locked';

  function subTeamMemberCount(subTeam: SubTeamName): number {
    return state.entries.filter((e) => (e.kpi_data.sub_team as unknown as string) === subTeam).length;
  }

  // Per-dept search + pagination
  const [search, setSearch] = useState('');
  const [page, setPage] = useState(1);

  // SSD sub-team filter — shared between the colored scoring boxes (left) and the
  // employee table (right) so clicking either surface filters the roster live.
  // 'ALL' shows everyone, 'NONE' shows only the unassigned.
  const [subTeamFilter, setSubTeamFilter] = useState<SubTeamFilter>('ALL');
  const toggleSubTeamFilter = useCallback((name: SubTeamName) => {
    setSubTeamFilter((prev) => (prev === name ? 'ALL' : name));
  }, []);

  const filteredEntries = useMemo(() => {
    const q = search.trim().toLowerCase();
    let list = state.entries;
    if (q) {
      list = list.filter((e) =>
        e.employee_name.toLowerCase().includes(q) || e.employee_email.toLowerCase().includes(q),
      );
    }
    if (isTeamSplit && subTeamFilter !== 'ALL') {
      list = list.filter((e) => {
        const st = String(e.kpi_data.sub_team ?? '');
        return subTeamFilter === 'NONE' ? !st : st === subTeamFilter;
      });
    }
    return list;
  }, [state.entries, search, subTeamFilter, isTeamSplit]);

  const totalPages = Math.max(1, Math.ceil(filteredEntries.length / DEPT_PAGE_SIZE));
  const currentPage = Math.min(page, totalPages);
  const pageStart = (currentPage - 1) * DEPT_PAGE_SIZE;
  const pagedEntries = filteredEntries.slice(pageStart, pageStart + DEPT_PAGE_SIZE);

  // Reset to page 1 whenever the search or sub-team filter changes
  useEffect(() => { setPage(1); }, [search, subTeamFilter]);

  const statusColors: Record<BonusStatus, string> = {
    draft:  'bg-zinc-200 text-zinc-700 dark:bg-zinc-700 dark:text-zinc-200',
    ready:  'bg-amber-200 text-amber-900 dark:bg-amber-700/80 dark:text-amber-100',
    locked: 'bg-emerald-200 text-emerald-900 dark:bg-emerald-800/80 dark:text-emerald-100',
  };

  return (
    <section
      className={cn(
        'overflow-hidden rounded-xl border border-zinc-200 bg-white shadow-sm dark:border-zinc-800 dark:bg-zinc-950/60',
        sectionClassName,
      )}
      style={{ borderLeft: `3px solid ${dept.color}` }}
    >
      {/* Header — click to expand/collapse when several depts are visible */}
      <header
        className={cn(
          'flex flex-wrap items-center gap-3 border-b border-zinc-200 bg-zinc-50/70 px-5 py-3.5 dark:border-zinc-800/80 dark:bg-zinc-900/40',
          collapsible && 'cursor-pointer select-none transition-colors hover:bg-zinc-100/70 dark:hover:bg-zinc-900/70',
        )}
        {...(collapsible
          ? {
              role: 'button' as const,
              tabIndex: 0,
              'aria-expanded': open,
              onClick: onToggleOpen,
              onKeyDown: (ev: React.KeyboardEvent) => {
                if (ev.key === 'Enter' || ev.key === ' ') {
                  ev.preventDefault();
                  onToggleOpen();
                }
              },
            }
          : {})}
      >
        {collapsible && (
          <ChevronDown
            className={cn(
              'h-4 w-4 shrink-0 text-zinc-400 transition-transform duration-300 ease-[cubic-bezier(0.22,1,0.36,1)]',
              open ? 'rotate-180' : 'rotate-0',
            )}
            aria-hidden
          />
        )}
        <div className="flex min-w-0 flex-1 flex-wrap items-center gap-2">
          <h3 className="text-sm font-semibold tracking-tight text-zinc-900 dark:text-zinc-100">
            {dept.name}
          </h3>
          <span className={cn(
            'rounded px-1.5 py-0.5 font-mono text-[9px] uppercase tracking-[0.15em]',
            'bg-zinc-100 text-zinc-700 dark:bg-zinc-800 dark:text-zinc-300',
          )}>
            {dept.cadence}
          </span>
          <span className={cn('rounded px-1.5 py-0.5 font-mono text-[9px] uppercase tracking-[0.12em]', statusColors[state.status])}>
            {state.status}
          </span>
          {dept.monthlyMax && (
            <span className="font-mono text-[9px] text-zinc-500 dark:text-zinc-500">
              max {formatPeso(dept.monthlyMax)}/mo
            </span>
          )}
          <span className="font-mono text-[10px] text-zinc-500">· {periodLabel(dept, periodStartStr)}</span>
          {loading && (
            <span className="inline-flex items-center gap-1 font-mono text-[10px] text-zinc-500">
              <RefreshCw className="h-3 w-3 animate-spin" /> loading
            </span>
          )}
        </div>
        <div className="flex shrink-0 items-center gap-3">
          <span className="font-mono text-[10px] text-zinc-500">{state.entries.length} ppl</span>
          <span className="font-mono text-base font-bold tabular-nums" style={{ color: dept.color }}>
            {formatPeso(deptTotal)}
          </span>
        </div>
      </header>

      {/* Body */}
      <AnimatePresence initial={false}>
      {open && (
      <motion.div
        key="dept-body"
        initial={{ height: 0, opacity: 0 }}
        animate={{ height: 'auto', opacity: 1 }}
        exit={{ height: 0, opacity: 0 }}
        transition={{ height: { duration: 0.36, ease: COLLAPSE_EASE }, opacity: { duration: 0.22, ease: 'easeOut' } }}
        className="overflow-hidden"
      >
      <div className="space-y-4 px-5 py-5">
        {/* Search + pagination toolbar */}
        {state.entries.length > 0 && (
          <div className="flex flex-col gap-2 sm:flex-row sm:items-center sm:justify-between">
            <div className="relative min-w-0 flex-1 sm:max-w-xs">
              <Search className="pointer-events-none absolute left-2.5 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-zinc-400" />
              <input
                type="text"
                placeholder="Search name or email…"
                value={search}
                onChange={(e) => setSearch(e.target.value)}
                className="h-8 w-full rounded-md border border-zinc-200 bg-white pl-8 pr-2 text-xs text-zinc-900 outline-none transition-colors focus:border-blue-400 focus:ring-1 focus:ring-blue-200 dark:border-zinc-800 dark:bg-zinc-900/60 dark:text-zinc-100 dark:focus:border-zinc-600 dark:focus:ring-zinc-700"
              />
            </div>
            <div className="flex shrink-0 items-center gap-2 self-end sm:self-auto">
              <span className="font-mono text-[10px] text-zinc-500">
                {filteredEntries.length === 0
                  ? '0 of 0'
                  : `${pageStart + 1}–${Math.min(pageStart + DEPT_PAGE_SIZE, filteredEntries.length)} of ${filteredEntries.length}`}
                {search.trim() && state.entries.length !== filteredEntries.length && (
                  <span className="text-zinc-400"> · filtered from {state.entries.length}</span>
                )}
              </span>
              <div className="flex items-center gap-0.5 rounded-md border border-zinc-200 bg-white p-0.5 dark:border-zinc-800 dark:bg-zinc-900/60">
                <button
                  type="button"
                  className="rounded p-1 text-zinc-600 hover:bg-zinc-100 disabled:cursor-not-allowed disabled:opacity-40 dark:text-zinc-300 dark:hover:bg-zinc-800"
                  disabled={currentPage <= 1}
                  onClick={() => setPage((p) => Math.max(1, p - 1))}
                  aria-label="Previous page"
                >
                  <ChevronLeft className="h-3.5 w-3.5" />
                </button>
                <span className="min-w-[3rem] text-center font-mono text-[10px] tabular-nums text-zinc-600 dark:text-zinc-400">
                  {currentPage} / {totalPages}
                </span>
                <button
                  type="button"
                  className="rounded p-1 text-zinc-600 hover:bg-zinc-100 disabled:cursor-not-allowed disabled:opacity-40 dark:text-zinc-300 dark:hover:bg-zinc-800"
                  disabled={currentPage >= totalPages}
                  onClick={() => setPage((p) => Math.min(totalPages, p + 1))}
                  aria-label="Next page"
                >
                  <ChevronRight className="h-3.5 w-3.5" />
                </button>
              </div>
            </div>
          </div>
        )}

        {dept.noKpi && (
          <div className="rounded-lg border border-zinc-200 bg-zinc-50 px-4 py-3 dark:border-zinc-800 dark:bg-zinc-900/40">
            <p className="font-mono text-[10px] uppercase tracking-[0.15em] text-zinc-500">
              Roster only — no KPI inputs
            </p>
            <div className="mt-2 flex flex-wrap gap-1.5">
              {state.entries.length === 0 ? (
                <span className="font-mono text-[10px] text-zinc-400">No employees in this department.</span>
              ) : pagedEntries.length === 0 ? (
                <span className="font-mono text-[10px] text-zinc-400">No matches for &quot;{search}&quot;.</span>
              ) : (
                pagedEntries.map((e) => (
                  <span
                    key={e.employee_email}
                    className="inline-flex items-center gap-1 rounded-full border border-zinc-300 bg-white px-2.5 py-0.5 text-[11px] text-zinc-700 dark:border-zinc-700 dark:bg-zinc-800 dark:text-zinc-300"
                  >
                    {e.employee_name}
                  </span>
                ))
              )}
            </div>
          </div>
        )}

        {tieredRule && (
          <div className="flex flex-wrap items-center gap-1.5 rounded-md border border-zinc-200 bg-zinc-50 px-3 py-2 dark:border-zinc-800 dark:bg-zinc-900/30">
            <span className="font-mono text-[9px] uppercase tracking-[0.15em] text-zinc-500">
              {tieredRule.label} tiers
            </span>
            {tieredRule.tiers.map((t, i) => (
              <span
                key={i}
                className="rounded border border-zinc-300 bg-white px-1.5 py-0.5 font-mono text-[9px] text-zinc-600 dark:border-zinc-700 dark:bg-zinc-900 dark:text-zinc-400"
              >
                {t.min}–{t.max ?? '∞'} → {t.rate === 0 ? '₱0' : `₱${t.rate}/case`}
              </span>
            ))}
          </div>
        )}

        {!dept.noKpi && !isTeamSplit && (
          <KpiTable
            dept={dept}
            entries={pagedEntries}
            subtotal={deptTotal}
            isLocked={isLocked}
            onKpiChange={onKpiChange}
            onToggleManager={onToggleManager}
          />
        )}

        {/* SSD: side-by-side at lg+ — sub-team scoring boxes (left), employee
            chip picker (right). `items-stretch` (default for grid) + the inner
            `h-full auto-rows-fr` on SsdSubTeamGrid keeps both columns and the
            6 boxes vertically aligned with the employee list. */}
        {isTeamSplit && ssdShareForTeam && !dept.noKpi && (
          <div className="grid items-stretch gap-4 lg:grid-cols-2">
            <div className="flex min-w-0 flex-col">
              <SsdSubTeamGrid
                subTeams={state.subTeams}
                isLocked={isLocked}
                onSubTeamChange={onSubTeamChange}
                ssdShareForTeam={ssdShareForTeam}
                subTeamMemberCount={subTeamMemberCount}
                activeFilter={subTeamFilter}
                onFilterToggle={toggleSubTeamFilter}
              />
            </div>
            <div className="flex min-w-0 flex-col">
              <SsdEmployeeTable
                entries={pagedEntries}
                allEntries={state.entries}
                isLocked={isLocked}
                ssdShareForTeam={ssdShareForTeam}
                onSubTeamAssign={(email, subTeam) =>
                  onKpiChange(email, 'sub_team', subTeam as unknown as number)
                }
                activeFilter={subTeamFilter}
                onFilterChange={setSubTeamFilter}
              />
            </div>
          </div>
        )}

        {/* Fallback for any team_split dept that has no KPI inputs (none today).
            No employee table here, so the boxes stay static (no filter toggle). */}
        {isTeamSplit && ssdShareForTeam && dept.noKpi && (
          <SsdSubTeamGrid
            subTeams={state.subTeams}
            isLocked={isLocked}
            onSubTeamChange={onSubTeamChange}
            ssdShareForTeam={ssdShareForTeam}
            subTeamMemberCount={subTeamMemberCount}
          />
        )}

        {/* Action bar — Save / Mark Ready (draft) → Mark as Unready + View (ready/locked). */}
        <div className="flex items-center gap-2 border-t border-zinc-200 pt-3 dark:border-zinc-800">
          <span className="font-mono text-[10px] text-zinc-500">
            {state.status === 'draft' && state.dirty && !payrollLocked && 'Unsaved changes'}
            {state.status === 'draft' && !state.dirty && state.entries.length > 0 && !payrollLocked && 'Saved · ready to mark'}
            {(state.status === 'draft' || state.status === 'ready') && payrollLocked && (
              <span className="inline-flex items-center gap-1 text-red-600 dark:text-red-400">
                <Lock className="h-3 w-3" /> Payroll processing — locked
              </span>
            )}
            {state.status === 'ready' && !payrollLocked && (
              <span className="inline-flex items-center gap-1 text-amber-700 dark:text-amber-400">
                <CheckCircle2 className="h-3 w-3" /> Sent to Accounting
              </span>
            )}
            {state.status === 'locked' && (
              <span className="inline-flex items-center gap-1 text-emerald-700 dark:text-emerald-400">
                <Lock className="h-3 w-3" /> Locked for the period
              </span>
            )}
          </span>
          <div className="ml-auto flex gap-2">
            {state.status === 'draft' && state.dirty && (
              <Button
                size="sm"
                variant="outline"
                className="h-7 gap-1.5 text-xs"
                disabled={state.saving || payrollLocked}
                onClick={onSave}
              >
                <Save className="h-3 w-3" />
                {state.saving ? 'Saving…' : 'Save'}
              </Button>
            )}
            {state.status === 'draft' && (
              <Button
                size="sm"
                className="h-7 gap-1.5 bg-amber-600 text-xs text-white hover:bg-amber-500 disabled:opacity-50"
                disabled={state.dirty || state.saving || state.entries.length === 0 || payrollLocked}
                title={
                  payrollLocked
                    ? 'KPI Calculator is locked while payroll is processing'
                    : state.dirty
                      ? 'Save your changes before marking ready'
                      : state.entries.length === 0
                        ? 'No employees to mark ready'
                        : 'Send these scores to Accounting · PayrollWizard'
                }
                onClick={onMarkReady}
              >
                <CheckCircle2 className="h-3 w-3" />
                Mark Ready
              </Button>
            )}
            {state.status === 'ready' && (
              <Button
                size="sm"
                variant="outline"
                className="h-7 gap-1.5 border-red-200 text-xs text-red-600 hover:bg-red-50 hover:text-red-700 disabled:opacity-50 dark:border-red-800 dark:text-red-400 dark:hover:bg-red-950/30"
                disabled={markUnreadySubmitting || payrollLocked}
                title={payrollLocked ? 'KPI Calculator is locked while payroll is processing' : 'Remove from Accounting — revert to draft'}
                onClick={onMarkUnready}
              >
                <RotateCcw className="h-3 w-3" />
                {markUnreadySubmitting ? 'Reverting…' : 'Mark as Unready'}
              </Button>
            )}
            {(state.status === 'ready' || state.status === 'locked') && (
              <Button
                size="sm"
                className={cn(
                  'h-7 gap-1.5 text-xs text-white',
                  state.status === 'ready'
                    ? 'bg-amber-600 hover:bg-amber-500'
                    : 'bg-emerald-600 hover:bg-emerald-500',
                )}
                onClick={onView}
              >
                <Eye className="h-3 w-3" />
                View
              </Button>
            )}
          </div>
        </div>
      </div>
      </motion.div>
      )}
      </AnimatePresence>
    </section>
  );
}

// ── KPI Table ─────────────────────────────────────────────────────────────────

interface KpiTableProps {
  dept: DeptConfig;
  entries: EntryRow[];
  subtotal: number;
  isLocked: boolean;
  onKpiChange: (email: string, key: string, val: number | boolean) => void;
  onToggleManager: (email: string) => void;
}

export function KpiTable({ dept, entries, subtotal, isLocked, onKpiChange, onToggleManager }: KpiTableProps) {
  const rules = dept.rules.filter((r) => r.type !== 'team_split');

  return (
    <div className="overflow-x-auto rounded-lg border border-zinc-200 dark:border-zinc-800">
      <table className="table-keep w-full min-w-[600px] text-xs">
        <thead>
          <tr className="border-b border-zinc-200 bg-zinc-50 dark:border-zinc-800 dark:bg-zinc-900/60">
            <th className="px-3 py-2 text-left font-mono text-[9px] uppercase tracking-[0.15em] text-zinc-500">Employee</th>
            <th className="px-2 py-2 text-center font-mono text-[9px] uppercase tracking-[0.15em] text-zinc-500">Mgr</th>
            {rules.map((r) => (
              <th key={r.key} className="px-2 py-2 text-right font-mono text-[9px] uppercase tracking-[0.12em] text-zinc-500">
                {r.label}
                <span className="block font-normal text-zinc-400 dark:text-zinc-600">
                  {r.type === 'per_unit' ? formatPeso(r.rate, r.currency) :
                   r.type === 'flat' ? `${formatPeso(r.amount, r.currency)} flat` :
                   'tiered'}
                </span>
              </th>
            ))}
            <th className="px-3 py-2 text-right font-mono text-[9px] uppercase tracking-[0.15em] text-zinc-500">Bonus</th>
          </tr>
        </thead>
        <tbody>
          {entries.length === 0 && (
            <tr>
              <td colSpan={rules.length + 3} className="px-3 py-6 text-center font-mono text-[10px] text-zinc-500">
                No employees on this page.
              </td>
            </tr>
          )}
          {entries.map((e) => (
            <tr key={e.employee_email} className="border-b border-zinc-100 hover:bg-zinc-50/60 dark:border-zinc-800/60 dark:hover:bg-zinc-900/40">
              <td className="px-3 py-2">
                <div className="font-medium text-zinc-900 dark:text-zinc-100">{e.employee_name}</div>
                <div className="font-mono text-[10px] text-zinc-500">{e.employee_email}</div>
              </td>
              <td className="px-2 py-2 text-center">
                <input
                  type="checkbox"
                  className="accent-blue-600"
                  checked={e.is_manager}
                  disabled={isLocked}
                  onChange={() => onToggleManager(e.employee_email)}
                />
              </td>
              {rules.map((r) => (
                <td key={r.key} className="px-2 py-2 text-right">
                  {r.type === 'flat' ? (
                    r.managerOnly && !e.is_manager ? (
                      <span className="text-zinc-300 dark:text-zinc-700">n/a</span>
                    ) : (
                      <input
                        type="checkbox"
                        className="accent-amber-500"
                        checked={Boolean(e.kpi_data[r.key])}
                        disabled={isLocked}
                        onChange={(ev) => onKpiChange(e.employee_email, r.key, ev.target.checked)}
                      />
                    )
                  ) : (
                    <input
                      type="number"
                      min={0}
                      className="w-16 rounded border border-zinc-300 bg-white px-1.5 py-0.5 text-right font-mono text-xs text-zinc-900 outline-none transition-colors focus:border-blue-400 focus:ring-1 focus:ring-blue-200 disabled:opacity-40 dark:border-zinc-700 dark:bg-zinc-800 dark:text-zinc-100 dark:focus:border-zinc-500 dark:focus:ring-zinc-700"
                      value={String(e.kpi_data[r.key] ?? '')}
                      disabled={isLocked}
                      onChange={(ev) => onKpiChange(e.employee_email, r.key, Number(ev.target.value))}
                    />
                  )}
                </td>
              ))}
              <td className="px-3 py-2 text-right font-mono font-bold tabular-nums text-emerald-600 dark:text-emerald-400">
                {formatPeso(e.calculated_bonus)}
              </td>
            </tr>
          ))}
          <tr className="border-t border-zinc-300 bg-zinc-100/70 dark:border-zinc-700 dark:bg-zinc-900/60">
            <td colSpan={rules.length + 2} className="px-3 py-2 font-mono text-[10px] uppercase tracking-[0.15em] text-zinc-500">
              Subtotal
            </td>
            <td className="px-3 py-2 text-right font-mono font-bold text-zinc-900 dark:text-zinc-100">
              {formatPeso(subtotal)}
            </td>
          </tr>
        </tbody>
      </table>
    </div>
  );
}

// ── SSD Sub-team Grid ─────────────────────────────────────────────────────────

interface SsdSubTeamGridProps {
  subTeams: Record<SubTeamName, SubTeamState>;
  isLocked: boolean;
  onSubTeamChange: (subTeam: SubTeamName, field: 'pct' | 'records', val: string) => void;
  ssdShareForTeam: (subTeam: SubTeamName, memberCount: number) => number;
  subTeamMemberCount: (subTeam: SubTeamName) => number;
  /** Currently-active roster filter (shared with the employee table). */
  activeFilter?: SubTeamFilter;
  /** Toggle the filter for a team — click the same team again to clear it. */
  onFilterToggle?: (subTeam: SubTeamName) => void;
}

export function SsdSubTeamGrid({
  subTeams, isLocked, onSubTeamChange, ssdShareForTeam, subTeamMemberCount,
  activeFilter = 'ALL', onFilterToggle,
}: SsdSubTeamGridProps) {
  const SUB_TEAM_NAMES: SubTeamName[] = ['BLUE', 'GREEN', 'YELLOW', 'ORANGE', 'PURPLE', 'RED'];
  const filterActive = activeFilter !== 'ALL';
  return (
    <div className="grid h-full auto-rows-fr gap-3 sm:grid-cols-2">
      {SUB_TEAM_NAMES.map((name) => {
        const st = subTeams[name];
        const members = subTeamMemberCount(name);
        const share = ssdShareForTeam(name, members || 1);
        const pct = parseFloat(st.pct) || 0;
        const tier: 'gold' | 'silver' | 'none' = pct >= 95 ? 'gold' : pct >= 90 ? 'silver' : 'none';
        const palette = SUB_TEAM_PALETTE[name];
        const tierLabel =
          tier === 'gold'   ? '≥ 95%  ·  ₱350 / record'
          : tier === 'silver' ? '90–94%  ·  ₱250 / record'
          : 'Below 90%  ·  no bonus';
        const tierStep = tier === 'gold' ? 3 : tier === 'silver' ? 2 : 1;
        const isPicked = activeFilter === name;       // this box drives the filter
        const isDimmed = filterActive && !isPicked;   // another team is being viewed

        return (
          <div
            key={name}
            className={cn(
              'group/box relative overflow-hidden rounded-xl border border-zinc-200 bg-white shadow-sm ring-1 transition-all duration-300 ease-[cubic-bezier(0.22,1,0.36,1)] dark:border-zinc-800 dark:bg-zinc-950/40',
              palette.ring,
              tier === 'gold' && 'shadow-md',
              isPicked && 'scale-[1.015] shadow-lg ring-2',
              isDimmed && 'scale-[0.99] opacity-55 saturate-[0.7]',
            )}
          >
            {/* Header — doubles as the filter toggle for this team */}
            <button
              type="button"
              onClick={() => onFilterToggle?.(name)}
              aria-pressed={isPicked}
              title={isPicked ? `Showing ${name} only — click to show all` : `Filter roster to ${name}`}
              className={cn(
                'flex w-full items-center justify-between px-3 py-2 text-left transition-[filter] duration-200',
                palette.headerBg, palette.headerText,
                onFilterToggle ? 'cursor-pointer hover:brightness-110 active:brightness-95' : 'cursor-default',
              )}
            >
              <span className="flex items-center gap-1.5 font-mono text-[11px] font-bold tracking-[0.2em]">
                <Filter
                  className={cn(
                    'h-3 w-3 transition-all duration-300',
                    isPicked ? 'scale-100 opacity-100' : 'scale-75 opacity-0 group-hover/box:opacity-60',
                  )}
                  aria-hidden
                />
                {name}
              </span>
              <span
                className={cn(
                  'rounded-full px-2 py-0.5 font-mono text-[10px] font-semibold backdrop-blur-sm transition-colors',
                  isPicked ? 'bg-white/40 ring-1 ring-white/60' : 'bg-white/25',
                )}
              >
                {members} {members === 1 ? 'member' : 'members'}
              </span>
            </button>

            {/* Body */}
            <div className={cn('px-3 py-3', palette.bodyBg)}>
              <div className="grid grid-cols-2 gap-2">
                <div>
                  <label className="mb-1 block font-mono text-[9px] font-semibold uppercase tracking-[0.12em] text-zinc-500 dark:text-zinc-400">
                    Accuracy %
                  </label>
                  <div className="relative">
                    <input
                      type="number" step="0.01" min={0} max={100}
                      className="h-9 w-full rounded-md border border-zinc-300 bg-white pl-2 pr-7 font-mono text-sm font-medium text-zinc-900 shadow-inner outline-none transition-colors focus:border-blue-400 focus:ring-2 focus:ring-blue-200 disabled:opacity-50 dark:border-zinc-700 dark:bg-zinc-900 dark:text-zinc-100 dark:focus:border-zinc-500 dark:focus:ring-zinc-700"
                      value={st.pct}
                      disabled={isLocked}
                      placeholder="0.00"
                      onChange={(e) => onSubTeamChange(name, 'pct', e.target.value)}
                    />
                    <span className="pointer-events-none absolute right-2 top-1/2 -translate-y-1/2 font-mono text-[10px] text-zinc-400">%</span>
                  </div>
                </div>
                <div>
                  <label className="mb-1 block font-mono text-[9px] font-semibold uppercase tracking-[0.12em] text-zinc-500 dark:text-zinc-400">
                    Records
                  </label>
                  <input
                    type="number" min={0}
                    className="h-9 w-full rounded-md border border-zinc-300 bg-white px-2 font-mono text-sm font-medium text-zinc-900 shadow-inner outline-none transition-colors focus:border-blue-400 focus:ring-2 focus:ring-blue-200 disabled:opacity-50 dark:border-zinc-700 dark:bg-zinc-900 dark:text-zinc-100 dark:focus:border-zinc-500 dark:focus:ring-zinc-700"
                    value={st.records}
                    disabled={isLocked}
                    placeholder="0"
                    onChange={(e) => onSubTeamChange(name, 'records', e.target.value)}
                  />
                </div>
              </div>

              {/* Tier indicator + share */}
              <div className="mt-3 flex items-center justify-between gap-2 border-t border-zinc-200/80 pt-2.5 dark:border-zinc-800/80">
                <div className="flex flex-col gap-1">
                  <div className="flex items-center gap-1">
                    {[1, 2, 3].map((step) => (
                      <span
                        key={step}
                        className={cn(
                          'h-1.5 w-5 rounded-full transition-colors',
                          step <= tierStep ? palette.dotOn : 'bg-zinc-200 dark:bg-zinc-800',
                        )}
                        aria-hidden
                      />
                    ))}
                  </div>
                  <span className={cn('font-mono text-[10px] font-medium', palette.accent)}>
                    {tierLabel}
                  </span>
                </div>
                <div className="text-right">
                  <div className={cn('font-mono text-base font-bold tabular-nums leading-none', palette.accent)}>
                    {formatPeso(share)}
                  </div>
                  <div className="mt-1 font-mono text-[9px] uppercase tracking-[0.12em] text-zinc-500">
                    per member
                  </div>
                </div>
              </div>
            </div>
          </div>
        );
      })}
    </div>
  );
}

// ── SSD Employee Table ────────────────────────────────────────────────────────

interface SsdEmployeeTableProps {
  entries: EntryRow[];
  allEntries: EntryRow[];
  isLocked: boolean;
  ssdShareForTeam: (subTeam: SubTeamName, memberCount: number) => number;
  onSubTeamAssign: (email: string, subTeam: SubTeamName | '') => void;
  /** Active roster filter, shared with the colored scoring boxes. */
  activeFilter?: SubTeamFilter;
  /** Set the active roster filter. */
  onFilterChange?: (f: SubTeamFilter) => void;
}

/** Colored sub-team chip picker. Replaces the native <select> — clicking a chip
 *  assigns that sub-team. Selected chip uses the sub-team's gradient header
 *  palette so the row's affiliation is visible at a glance. */
export function SubTeamChips({
  value,
  onChange,
  isLocked,
}: {
  value: SubTeamName | '';
  onChange: (v: SubTeamName | '') => void;
  isLocked: boolean;
}) {
  const SUB_TEAM_NAMES: SubTeamName[] = ['BLUE', 'GREEN', 'YELLOW', 'ORANGE', 'PURPLE', 'RED'];
  return (
    <div className="inline-flex flex-wrap items-center gap-1">
      <button
        type="button"
        disabled={isLocked}
        onClick={() => onChange('')}
        className={cn(
          'rounded px-1.5 py-0.5 font-mono text-[9px] uppercase tracking-wider transition-colors',
          value === ''
            ? 'bg-zinc-200 text-zinc-700 ring-1 ring-zinc-300 dark:bg-zinc-700 dark:text-zinc-200 dark:ring-zinc-600'
            : 'text-zinc-400 hover:text-zinc-700 dark:text-zinc-500 dark:hover:text-zinc-300',
          isLocked && 'cursor-not-allowed opacity-60',
        )}
      >
        none
      </button>
      {SUB_TEAM_NAMES.map((name) => {
        const palette = SUB_TEAM_PALETTE[name];
        const selected = value === name;
        return (
          <button
            key={name}
            type="button"
            disabled={isLocked}
            onClick={() => onChange(name)}
            title={`Assign to ${name}`}
            className={cn(
              'inline-flex items-center gap-1 rounded px-1.5 py-0.5 font-mono text-[9px] font-bold uppercase tracking-wider transition-all',
              selected
                ? `${palette.headerBg} ${palette.headerText} shadow-sm`
                : 'bg-white text-zinc-500 ring-1 ring-zinc-200 hover:text-zinc-800 dark:bg-zinc-900 dark:text-zinc-500 dark:ring-zinc-800 dark:hover:text-zinc-300',
              isLocked && 'cursor-not-allowed opacity-60',
            )}
          >
            <span
              className={cn(
                'h-1.5 w-1.5 rounded-full',
                selected ? 'bg-white/85' : palette.dotOn,
              )}
            />
            {name}
          </button>
        );
      })}
    </div>
  );
}

export function SsdEmployeeTable({
  entries, allEntries, isLocked, ssdShareForTeam, onSubTeamAssign,
  activeFilter = 'ALL', onFilterChange,
}: SsdEmployeeTableProps) {
  const SUB_TEAM_NAMES: SubTeamName[] = ['BLUE', 'GREEN', 'YELLOW', 'ORANGE', 'PURPLE', 'RED'];

  // Member counts must reflect every entry in the dept, not just the current page
  const memberCounts = useMemo(() => {
    const counts: Record<string, number> = {};
    for (const e of allEntries) {
      const st = String(e.kpi_data.sub_team ?? '');
      if (st) counts[st] = (counts[st] ?? 0) + 1;
    }
    return counts;
  }, [allEntries]);

  const unassignedCount = useMemo(
    () => allEntries.filter((e) => !String(e.kpi_data.sub_team ?? '')).length,
    [allEntries],
  );

  // ── Bulk selection ──────────────────────────────────────────────────────────
  // Selection is keyed by email so it survives pagination; checkboxes only show
  // for the rows currently on the page.
  const [selected, setSelected] = useState<Set<string>>(new Set());

  // Drop any selected emails that no longer exist (e.g. roster changed).
  useEffect(() => {
    setSelected((prev) => {
      if (prev.size === 0) return prev;
      const valid = new Set(allEntries.map((e) => e.employee_email));
      let changed = false;
      const next = new Set<string>();
      for (const em of prev) {
        if (valid.has(em)) next.add(em);
        else changed = true;
      }
      return changed ? next : prev;
    });
  }, [allEntries]);

  const pageEmails = entries.map((e) => e.employee_email);
  const allPageSelected = pageEmails.length > 0 && pageEmails.every((em) => selected.has(em));
  const somePageSelected = pageEmails.some((em) => selected.has(em));

  const selectAllRef = React.useRef<HTMLInputElement>(null);
  useEffect(() => {
    if (selectAllRef.current) selectAllRef.current.indeterminate = somePageSelected && !allPageSelected;
  }, [somePageSelected, allPageSelected]);

  function toggleOne(email: string) {
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(email)) next.delete(email);
      else next.add(email);
      return next;
    });
  }

  function toggleAllOnPage() {
    setSelected((prev) => {
      const next = new Set(prev);
      if (allPageSelected) pageEmails.forEach((em) => next.delete(em));
      else pageEmails.forEach((em) => next.add(em));
      return next;
    });
  }

  function bulkAssign(target: SubTeamName | '') {
    if (selected.size === 0) return;
    // Each call composes via functional setState in the parent, so looping is safe.
    selected.forEach((em) => onSubTeamAssign(em, target));
    setSelected(new Set());
  }

  return (
    <div className="flex h-full flex-col gap-2">
      {/* Filter bar — view the roster one team at a time. Stays in sync with the
          colored scoring boxes: clicking a box sets the same filter. */}
      {onFilterChange && (
        <div className="flex flex-wrap items-center gap-1.5 rounded-lg border border-zinc-200 bg-zinc-50/70 px-2.5 py-2 dark:border-zinc-800 dark:bg-zinc-900/40">
          <span className="inline-flex items-center gap-1 font-mono text-[10px] uppercase tracking-[0.12em] text-zinc-500">
            <Filter className="h-3 w-3" /> Filter
          </span>
          <button
            type="button"
            onClick={() => onFilterChange('ALL')}
            aria-pressed={activeFilter === 'ALL'}
            className={cn(
              'inline-flex items-center gap-1 rounded px-1.5 py-0.5 font-mono text-[9px] font-bold uppercase tracking-wider transition-all duration-200',
              activeFilter === 'ALL'
                ? 'bg-zinc-800 text-white shadow-sm dark:bg-zinc-200 dark:text-zinc-900'
                : 'bg-white text-zinc-500 ring-1 ring-zinc-200 hover:text-zinc-800 dark:bg-zinc-900 dark:text-zinc-400 dark:ring-zinc-800 dark:hover:text-zinc-200',
            )}
          >
            All
            <span className={cn('tabular-nums', activeFilter === 'ALL' ? 'opacity-80' : 'opacity-60')}>{allEntries.length}</span>
          </button>
          {SUB_TEAM_NAMES.map((name) => {
            const palette = SUB_TEAM_PALETTE[name];
            const active = activeFilter === name;
            const count = memberCounts[name] ?? 0;
            return (
              <button
                key={name}
                type="button"
                onClick={() => onFilterChange(active ? 'ALL' : name)}
                aria-pressed={active}
                title={active ? `Showing ${name} only — click to show all` : `Show ${name} only`}
                className={cn(
                  'inline-flex items-center gap-1 rounded px-1.5 py-0.5 font-mono text-[9px] font-bold uppercase tracking-wider transition-all duration-200',
                  active
                    ? `${palette.headerBg} ${palette.headerText} scale-105 shadow-sm`
                    : 'bg-white text-zinc-500 ring-1 ring-zinc-200 hover:text-zinc-800 dark:bg-zinc-900 dark:text-zinc-400 dark:ring-zinc-800 dark:hover:text-zinc-200',
                )}
              >
                <span className={cn('h-1.5 w-1.5 rounded-full transition-colors', active ? 'bg-white/85' : palette.dotOn)} />
                {name}
                <span className={cn('tabular-nums', active ? 'opacity-80' : 'opacity-60')}>{count}</span>
              </button>
            );
          })}
          <button
            type="button"
            onClick={() => onFilterChange(activeFilter === 'NONE' ? 'ALL' : 'NONE')}
            aria-pressed={activeFilter === 'NONE'}
            title={activeFilter === 'NONE' ? 'Showing unassigned only — click to show all' : 'Show unassigned only'}
            className={cn(
              'inline-flex items-center gap-1 rounded px-1.5 py-0.5 font-mono text-[9px] font-bold uppercase tracking-wider transition-all duration-200',
              activeFilter === 'NONE'
                ? 'bg-zinc-600 text-white shadow-sm dark:bg-zinc-400 dark:text-zinc-900'
                : 'bg-white text-zinc-500 ring-1 ring-zinc-200 hover:text-zinc-800 dark:bg-zinc-900 dark:text-zinc-400 dark:ring-zinc-800 dark:hover:text-zinc-200',
            )}
          >
            <span className={cn('h-1.5 w-1.5 rounded-full', activeFilter === 'NONE' ? 'bg-white/85' : 'bg-zinc-300 dark:bg-zinc-600')} />
            Unassigned
            <span className={cn('tabular-nums', activeFilter === 'NONE' ? 'opacity-80' : 'opacity-60')}>{unassignedCount}</span>
          </button>
          {activeFilter !== 'ALL' && (
            <button
              type="button"
              onClick={() => onFilterChange('ALL')}
              className="ml-auto inline-flex items-center gap-0.5 font-mono text-[10px] text-zinc-500 underline-offset-2 transition-colors hover:text-zinc-800 hover:underline dark:hover:text-zinc-200"
            >
              <X className="h-3 w-3" /> clear
            </button>
          )}
        </div>
      )}

      {/* Bulk-assign bar */}
      <div
        className={cn(
          'flex flex-wrap items-center gap-2 rounded-lg border px-2.5 py-2 transition-colors',
          selected.size > 0
            ? 'border-blue-300 bg-blue-50/70 dark:border-blue-800/70 dark:bg-blue-950/30'
            : 'border-zinc-200 bg-zinc-50/70 dark:border-zinc-800 dark:bg-zinc-900/40',
        )}
      >
        <span className="font-mono text-[10px] uppercase tracking-[0.12em] text-zinc-500">
          {selected.size > 0 ? (
            <span className="font-semibold text-blue-700 dark:text-blue-300">{selected.size} selected</span>
          ) : (
            'Tick rows to bulk-assign'
          )}
        </span>
        <span className="font-mono text-[10px] text-zinc-400">→ assign to</span>
        <div className="flex flex-wrap items-center gap-1">
          {SUB_TEAM_NAMES.map((name) => {
            const palette = SUB_TEAM_PALETTE[name];
            return (
              <button
                key={name}
                type="button"
                disabled={isLocked || selected.size === 0}
                onClick={() => bulkAssign(name)}
                title={`Assign ${selected.size} selected to ${name}`}
                className={cn(
                  'inline-flex items-center gap-1 rounded px-1.5 py-0.5 font-mono text-[9px] font-bold uppercase tracking-wider transition-all',
                  selected.size > 0
                    ? `${palette.headerBg} ${palette.headerText} shadow-sm hover:brightness-105`
                    : 'bg-white text-zinc-400 ring-1 ring-zinc-200 dark:bg-zinc-900 dark:text-zinc-600 dark:ring-zinc-800',
                  (isLocked || selected.size === 0) && 'cursor-not-allowed opacity-50',
                )}
              >
                <span className={cn('h-1.5 w-1.5 rounded-full', selected.size > 0 ? 'bg-white/85' : palette.dotOn)} />
                {name}
              </button>
            );
          })}
          <button
            type="button"
            disabled={isLocked || selected.size === 0}
            onClick={() => bulkAssign('')}
            title={`Clear sub-team for ${selected.size} selected`}
            className={cn(
              'rounded px-1.5 py-0.5 font-mono text-[9px] uppercase tracking-wider transition-colors',
              'bg-white text-zinc-500 ring-1 ring-zinc-200 hover:text-zinc-800 dark:bg-zinc-900 dark:text-zinc-400 dark:ring-zinc-800',
              (isLocked || selected.size === 0) && 'cursor-not-allowed opacity-50',
            )}
          >
            none
          </button>
        </div>
        {selected.size > 0 && (
          <button
            type="button"
            onClick={() => setSelected(new Set())}
            className="ml-auto font-mono text-[10px] text-zinc-500 underline-offset-2 hover:text-zinc-800 hover:underline dark:hover:text-zinc-200"
          >
            clear
          </button>
        )}
      </div>

      <div className="min-h-0 flex-1 overflow-x-auto rounded-lg border border-zinc-200 dark:border-zinc-800">
        <table className="table-keep w-full min-w-[600px] text-xs">
          <thead>
            <tr className="border-b border-zinc-200 bg-zinc-50 dark:border-zinc-800 dark:bg-zinc-900/60">
              <th className="w-9 px-2 py-2 text-center">
                <input
                  ref={selectAllRef}
                  type="checkbox"
                  className="accent-blue-600"
                  checked={allPageSelected}
                  disabled={isLocked || pageEmails.length === 0}
                  onChange={toggleAllOnPage}
                  aria-label="Select all on this page"
                />
              </th>
              <th className="px-3 py-2 text-left font-mono text-[9px] uppercase tracking-[0.15em] text-zinc-500">Employee</th>
              <th className="px-2 py-2 text-left font-mono text-[9px] uppercase tracking-[0.15em] text-zinc-500">Sub-Team</th>
              <th className="px-3 py-2 text-right font-mono text-[9px] uppercase tracking-[0.15em] text-zinc-500">Share</th>
            </tr>
          </thead>
          <tbody>
            {entries.length === 0 && (
              <tr>
                <td colSpan={4} className="px-3 py-6 text-center font-mono text-[10px] text-zinc-500">
                  {activeFilter === 'NONE'
                    ? 'Everyone has a team — nothing unassigned.'
                    : activeFilter !== 'ALL'
                    ? `No ${activeFilter} members on this page.`
                    : 'No employees on this page.'}
                </td>
              </tr>
            )}
            {entries.map((e, i) => {
              const subTeam = String(e.kpi_data.sub_team ?? '') as SubTeamName | '';
              const memberCount = subTeam ? (memberCounts[subTeam] ?? 0) : 0;
              const share = subTeam ? ssdShareForTeam(subTeam, memberCount) : 0;
              const palette = subTeam ? SUB_TEAM_PALETTE[subTeam] : null;
              const isSel = selected.has(e.employee_email);
              return (
                <tr
                  // Key includes the active filter so rows remount — and replay the
                  // staggered cascade — every time the filter changes.
                  key={`${activeFilter}-${e.employee_email}`}
                  style={{ animation: `pab-row-in 0.32s cubic-bezier(0.22,1,0.36,1) ${Math.min(i * 35, 300)}ms both` }}
                  className={cn(
                    'border-b border-zinc-100 transition-colors hover:bg-zinc-50/60 dark:border-zinc-800/60 dark:hover:bg-zinc-900/40',
                    palette && palette.bodyBg,
                    isSel && 'bg-blue-50/70 dark:bg-blue-950/30',
                  )}
                >
                  <td className="px-2 py-2 text-center">
                    <input
                      type="checkbox"
                      className="accent-blue-600"
                      checked={isSel}
                      disabled={isLocked}
                      onChange={() => toggleOne(e.employee_email)}
                      aria-label={`Select ${e.employee_name}`}
                    />
                  </td>
                  <td className="px-3 py-2">
                    <div className="font-medium text-zinc-900 dark:text-zinc-100">{e.employee_name}</div>
                    <div className="font-mono text-[10px] text-zinc-500">{e.employee_email}</div>
                  </td>
                  <td className="px-2 py-2">
                    <SubTeamChips
                      value={subTeam}
                      isLocked={isLocked}
                      onChange={(v) => onSubTeamAssign(e.employee_email, v)}
                    />
                  </td>
                  <td
                    className={cn(
                      'px-3 py-2 text-right font-mono font-bold tabular-nums',
                      palette ? palette.accent : 'text-zinc-300 dark:text-zinc-700',
                    )}
                  >
                    {subTeam ? formatPeso(share) : '—'}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
    </div>
  );
}
