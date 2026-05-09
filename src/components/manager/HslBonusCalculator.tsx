'use client';

import React, { useCallback, useEffect, useMemo, useState } from 'react';
import {
  CheckCircle2, ChevronLeft, ChevronRight, Download, Eye,
  Lock, RefreshCw, Save, Search, Users,
} from 'lucide-react';
import { toast } from 'sonner';
import { Button } from '@/components/ui/button';
import { cn } from '@/lib/utils';
import {
  BonusStatus, DeptConfig, HslDeptKey, HSL_DEPTS, HSL_DEPT_KEYS,
  KpiData, SubTeamName, TeamSplitRule, TieredRule,
  calcBonus, calcTeamSplitShare, canAccessHslDept, formatPeso,
} from '@/lib/hsl-bonus/schema';
import HslBonusReadyPreview from './HslBonusReadyPreview';

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

// Canonical HSL roster row from `hsl_team_members` table
interface HslMember {
  email: string;
  full_name: string | null;
  hsl_name: string | null;
  is_manager: boolean;
  sub_team: SubTeamName | null;
  hourly_rate: number | null;
  ot_rate: number | null;
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
  const [weekStart]  = useState(() => isoWeekStart(today));
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

  useEffect(() => {
    visibleDepts.forEach((k) => void loadDept(k));
  }, [visibleDepts, loadDept]);

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
          String(Math.round(e.calculated_bonus)),
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

  return (
    <div className="flex min-h-0 flex-col bg-gradient-to-b from-white via-blue-50/20 to-white text-zinc-900 dark:from-black dark:via-blue-950/15 dark:to-black dark:text-zinc-100">
      {/* Top bar */}
      <div className="sticky top-0 z-10 flex flex-wrap items-center justify-between gap-3 border-b border-zinc-200/80 bg-white/90 px-5 py-3 backdrop-blur-md dark:border-zinc-800 dark:bg-zinc-950/90">
        <div>
          <p className="font-mono text-[10px] uppercase tracking-[0.2em] text-zinc-500">
            KPI Calculator · HSL
          </p>
          <h2 className="text-base font-semibold tracking-tight text-zinc-900 dark:text-zinc-100">
            {isElevated ? 'All Departments' : visibleDepts.length === 1 ? HSL_DEPTS[visibleDepts[0]!].name : 'My Departments'}
            <span className="ml-2 font-mono text-xs font-normal text-zinc-500">
              week of {isoWeekStart(today)}
            </span>
          </h2>
        </div>
        <div className="flex items-center gap-2">
          {isElevated && (
            <div className="flex items-center gap-2 rounded-lg border border-zinc-200 bg-white px-3 py-1.5 shadow-sm dark:border-zinc-800 dark:bg-zinc-900/60">
              <span className="font-mono text-[10px] uppercase tracking-[0.15em] text-zinc-500">Total</span>
              <span className="font-mono text-sm font-bold text-emerald-600 dark:text-emerald-400">
                {formatPeso(grandTotal)}
              </span>
              <span className="font-mono text-[10px] text-zinc-500">{totalPeople} ppl</span>
            </div>
          )}
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

      {/* Department blocks */}
      <div className="flex flex-col gap-4 px-4 py-5 sm:px-6">
        {visibleDepts.map((key) => (
          <DeptBlock
            key={key}
            deptKey={key}
            state={deptState[key]!}
            loading={loadingDepts.has(key)}
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
            onView={() => setViewingDept(key)}
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

// ── DeptBlock ─────────────────────────────────────────────────────────────────

interface DeptBlockProps {
  deptKey: HslDeptKey;
  state: DeptState;
  loading: boolean;
  periodStartStr: string;
  onKpiChange: (email: string, key: string, val: number | boolean) => void;
  onToggleManager: (email: string) => void;
  onSave: () => void;
  onMarkReady: () => void;
  onView: () => void;
  onSubTeamChange: (subTeam: SubTeamName, field: 'pct' | 'records', val: string) => void;
  ssdShareForTeam?: (subTeam: SubTeamName, memberCount: number) => number;
}

const DEPT_PAGE_SIZE = 10;

function DeptBlock({
  deptKey, state, loading, periodStartStr,
  onKpiChange, onToggleManager,
  onSave, onMarkReady, onView, onSubTeamChange, ssdShareForTeam,
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

  const filteredEntries = useMemo(() => {
    const q = search.trim().toLowerCase();
    if (!q) return state.entries;
    return state.entries.filter((e) =>
      e.employee_name.toLowerCase().includes(q) || e.employee_email.toLowerCase().includes(q),
    );
  }, [state.entries, search]);

  const totalPages = Math.max(1, Math.ceil(filteredEntries.length / DEPT_PAGE_SIZE));
  const currentPage = Math.min(page, totalPages);
  const pageStart = (currentPage - 1) * DEPT_PAGE_SIZE;
  const pagedEntries = filteredEntries.slice(pageStart, pageStart + DEPT_PAGE_SIZE);

  // Reset to page 1 whenever the filter changes
  useEffect(() => { setPage(1); }, [search]);

  const statusColors: Record<BonusStatus, string> = {
    draft:  'bg-zinc-200 text-zinc-700 dark:bg-zinc-700 dark:text-zinc-200',
    ready:  'bg-amber-200 text-amber-900 dark:bg-amber-700/80 dark:text-amber-100',
    locked: 'bg-emerald-200 text-emerald-900 dark:bg-emerald-800/80 dark:text-emerald-100',
  };

  return (
    <section
      className="overflow-hidden rounded-xl border border-zinc-200 bg-white shadow-sm dark:border-zinc-800 dark:bg-zinc-950/60"
      style={{ borderLeft: `3px solid ${dept.color}` }}
    >
      {/* Header */}
      <header className="flex flex-wrap items-center gap-3 border-b border-zinc-200 bg-zinc-50/70 px-5 py-3.5 dark:border-zinc-800/80 dark:bg-zinc-900/40">
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
              />
            </div>
          </div>
        )}

        {/* Fallback for any team_split dept that has no KPI inputs (none today) */}
        {isTeamSplit && ssdShareForTeam && dept.noKpi && (
          <SsdSubTeamGrid
            subTeams={state.subTeams}
            isLocked={isLocked}
            onSubTeamChange={onSubTeamChange}
            ssdShareForTeam={ssdShareForTeam}
            subTeamMemberCount={subTeamMemberCount}
          />
        )}

        {/* Action bar — Save / Mark Ready (draft) → View (ready/locked). */}
        <div className="flex items-center gap-2 border-t border-zinc-200 pt-3 dark:border-zinc-800">
          <span className="font-mono text-[10px] text-zinc-500">
            {state.status === 'draft' && state.dirty && 'Unsaved changes'}
            {state.status === 'draft' && !state.dirty && state.entries.length > 0 && 'Saved · ready to mark'}
            {state.status === 'ready' && (
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
                disabled={state.saving}
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
                disabled={state.dirty || state.saving || state.entries.length === 0}
                title={
                  state.dirty
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
      <table className="w-full min-w-[600px] text-xs">
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
}

export function SsdSubTeamGrid({ subTeams, isLocked, onSubTeamChange, ssdShareForTeam, subTeamMemberCount }: SsdSubTeamGridProps) {
  const SUB_TEAM_NAMES: SubTeamName[] = ['BLUE', 'GREEN', 'YELLOW', 'ORANGE', 'PURPLE', 'RED'];
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

        return (
          <div
            key={name}
            className={cn(
              'overflow-hidden rounded-xl border border-zinc-200 bg-white shadow-sm ring-1 transition-all dark:border-zinc-800 dark:bg-zinc-950/40',
              palette.ring,
              tier === 'gold' && 'shadow-md',
            )}
          >
            {/* Header */}
            <div className={cn('flex items-center justify-between px-3 py-2', palette.headerBg, palette.headerText)}>
              <span className="font-mono text-[11px] font-bold tracking-[0.2em]">{name}</span>
              <span
                className={cn(
                  'rounded-full px-2 py-0.5 font-mono text-[10px] font-semibold backdrop-blur-sm',
                  'bg-white/25',
                )}
              >
                {members} {members === 1 ? 'member' : 'members'}
              </span>
            </div>

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

export function SsdEmployeeTable({ entries, allEntries, isLocked, ssdShareForTeam, onSubTeamAssign }: SsdEmployeeTableProps) {
  // Member counts must reflect every entry in the dept, not just the current page
  const memberCounts = useMemo(() => {
    const counts: Record<string, number> = {};
    for (const e of allEntries) {
      const st = String(e.kpi_data.sub_team ?? '');
      if (st) counts[st] = (counts[st] ?? 0) + 1;
    }
    return counts;
  }, [allEntries]);

  return (
    <div className="h-full overflow-x-auto rounded-lg border border-zinc-200 dark:border-zinc-800">
      <table className="w-full min-w-[560px] text-xs">
        <thead>
          <tr className="border-b border-zinc-200 bg-zinc-50 dark:border-zinc-800 dark:bg-zinc-900/60">
            <th className="px-3 py-2 text-left font-mono text-[9px] uppercase tracking-[0.15em] text-zinc-500">Employee</th>
            <th className="px-2 py-2 text-left font-mono text-[9px] uppercase tracking-[0.15em] text-zinc-500">Sub-Team</th>
            <th className="px-3 py-2 text-right font-mono text-[9px] uppercase tracking-[0.15em] text-zinc-500">Share</th>
          </tr>
        </thead>
        <tbody>
          {entries.length === 0 && (
            <tr>
              <td colSpan={3} className="px-3 py-6 text-center font-mono text-[10px] text-zinc-500">
                No employees on this page.
              </td>
            </tr>
          )}
          {entries.map((e) => {
            const subTeam = String(e.kpi_data.sub_team ?? '') as SubTeamName | '';
            const memberCount = subTeam ? (memberCounts[subTeam] ?? 0) : 0;
            const share = subTeam ? ssdShareForTeam(subTeam, memberCount) : 0;
            const palette = subTeam ? SUB_TEAM_PALETTE[subTeam] : null;
            return (
              <tr
                key={e.employee_email}
                className={cn(
                  'border-b border-zinc-100 transition-colors hover:bg-zinc-50/60 dark:border-zinc-800/60 dark:hover:bg-zinc-900/40',
                  palette && palette.bodyBg,
                )}
              >
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
  );
}
