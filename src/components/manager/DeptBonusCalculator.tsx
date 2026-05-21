'use client';

import React, { useCallback, useEffect, useMemo, useState } from 'react';
import { AnimatePresence, LayoutGroup, motion, useSpring } from 'motion/react';
import { AlertTriangle, CheckCircle2, ChevronDown, Clock, Lock, RefreshCw, Save, Search, Users } from 'lucide-react';
import { toast } from 'sonner';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { cn } from '@/lib/utils';
import { normEmail } from '@/lib/email/norm-email';
import type { EmployeeRow } from '@/lib/supabase/employees';
import { normalizeDeptToKey } from '@/lib/payroll/normalize-dept-key';
import {
  DEPARTMENTS,
  DEPT_DESCRIPTION,
  DEPT_INPUT_CONFIG,
  FORMULA_DEPT_KEYS,
  MANAGER_BONUS_DEPT_KEYS,
  calculateDepartmentBonus,
} from '@/lib/payroll/department-bonus';

// ── Types ─────────────────────────────────────────────────────────────────────

type BonusStatus = 'draft' | 'ready' | 'locked';

/** Sentinel email used to persist department-level metrics (one row per dept+period). */
const DEPT_META_EMAIL = '__dept_meta__';

const EASE = [0.22, 1, 0.36, 1] as const;

interface EmpEntry {
  email: string;
  name: string;
  metrics: Record<string, number>;   // per-employee numeric inputs
  toggles: Record<string, boolean>;  // award toggles (us_manager_bonus)
}

interface DeptState {
  employees: EmpEntry[];
  deptMetrics: Record<string, number>; // department-level numeric inputs
  status: BonusStatus;
  dirty: boolean;
  saving: boolean;
  loaded: boolean;
}

type AllState = Record<string, DeptState>;

interface Wallpaper {
  url: string | null;
  position: string;
}

interface DeptBonusCalculatorProps {
  viewerEmail: string | null;
  teamMembers: EmployeeRow[];
  managedDepts: string[];
  isElevated: boolean;
}

// ── Per-department colour identity (hex; inline-styled to dodge Tailwind purge) ──

const DEPT_COLOR: Record<string, string> = {
  accounting: '#10b981',
  edit: '#3b82f6',
  devs: '#8b5cf6',
  lead_gen: '#f59e0b',
  us_manager_bonus: '#f43f5e',
  callback: '#06b6d4',
  qc: '#f97316',
  discovery: '#14b8a6',
  hr: '#ec4899',
  sales_assistant: '#6366f1',
  smm: '#d946ef',
  pm_team: '#0ea5e9',
  client_va: '#84cc16',
  site_building: '#64748b',
};

function deptColor(key: string): string {
  return DEPT_COLOR[key] ?? '#6366f1';
}

/** hex (#rrggbb) → rgba string at the given alpha. */
function hexA(hex: string, alpha: number): string {
  const h = hex.replace('#', '');
  const r = parseInt(h.slice(0, 2), 16);
  const g = parseInt(h.slice(2, 4), 16);
  const b = parseInt(h.slice(4, 6), 16);
  return `rgba(${r}, ${g}, ${b}, ${alpha})`;
}

/** Generated "wallpaper" backdrop for departments without an uploaded image. */
function fallbackBg(color: string): string {
  return [
    `radial-gradient(115% 115% at 0% 0%, ${hexA(color, 0.5)} 0%, transparent 55%)`,
    `radial-gradient(130% 130% at 100% 110%, ${hexA(color, 0.9)} 0%, ${hexA(color, 0.1)} 62%)`,
    `linear-gradient(135deg, #0b1220 0%, #0f172a 100%)`,
  ].join(', ');
}

// ── Period helpers (weekly, Monday-anchored — matches the payroll week) ─────────

function isoWeekStart(d: Date): string {
  const day = new Date(d.getFullYear(), d.getMonth(), d.getDate());
  const dow = day.getDay(); // 0=Sun … 6=Sat
  const daysBack = dow === 0 ? 6 : dow - 1;
  day.setDate(day.getDate() - daysBack);
  return `${day.getFullYear()}-${String(day.getMonth() + 1).padStart(2, '0')}-${String(day.getDate()).padStart(2, '0')}`;
}

function weekEndFromStart(startIso: string): string {
  const [y, m, d] = startIso.split('-').map(Number);
  const end = new Date(y!, m! - 1, d! + 6);
  return `${end.getFullYear()}-${String(end.getMonth() + 1).padStart(2, '0')}-${String(end.getDate()).padStart(2, '0')}`;
}

function peso(n: number): string {
  return `₱${Math.round(n).toLocaleString('en-PH')}`;
}

function rowEmail(r: EmployeeRow): string {
  return normEmail(r.personal_email ?? null) || normEmail(r.work_email ?? null) || '';
}

// ── Component ───────────────────────────────────────────────────────────────────

export default function DeptBonusCalculator({
  viewerEmail,
  teamMembers,
  managedDepts,
  isElevated,
}: DeptBonusCalculatorProps) {
  const [weekStart] = useState(() => isoWeekStart(new Date()));
  const weekEnd = useMemo(() => weekEndFromStart(weekStart), [weekStart]);

  // Roster grouped by normalized department key, limited to manager-bonus depts.
  const rosterByDept = useMemo(() => {
    const map = new Map<string, EmpEntry[]>();
    for (const r of teamMembers) {
      const key = normalizeDeptToKey(r.department);
      if (!key || !(key in DEPT_INPUT_CONFIG)) continue;
      const email = rowEmail(r);
      if (!email) continue;
      const list = map.get(key) ?? [];
      list.push({ email, name: r.name ?? email, metrics: {}, toggles: {} });
      map.set(key, list);
    }
    for (const list of map.values()) list.sort((a, b) => a.name.localeCompare(b.name));
    return map;
  }, [teamMembers]);

  const visibleDeptKeys = useMemo<string[]>(() => {
    if (isElevated) {
      return MANAGER_BONUS_DEPT_KEYS.filter((k) => (rosterByDept.get(k)?.length ?? 0) > 0);
    }
    const keys = new Set<string>();
    for (const d of managedDepts) {
      const k = normalizeDeptToKey(d);
      if (k && k in DEPT_INPUT_CONFIG) keys.add(k);
    }
    return Array.from(keys);
  }, [isElevated, managedDepts, rosterByDept]);

  const [state, setState] = useState<AllState>({});
  const [wallpapers, setWallpapers] = useState<Record<string, Wallpaper>>({});
  const [activeFilter, setActiveFilter] = useState<string>('all');
  const [search, setSearch] = useState('');
  const [manualOpen, setManualOpen] = useState<Record<string, boolean>>({});

  function patchDept(key: string, patch: Partial<DeptState>) {
    setState((prev) => ({ ...prev, [key]: { ...prev[key]!, ...patch } }));
  }

  // ── Load existing entries + status for a department ──────────────────────────

  const loadDept = useCallback(
    async (key: string) => {
      const roster = rosterByDept.get(key) ?? [];
      try {
        const [entriesRes, statusRes] = await Promise.all([
          fetch(`/api/hsl-bonus/entries?dept=${key}&period_start=${weekStart}`, { cache: 'no-store' }),
          fetch(`/api/hsl-bonus/period-status?dept=${key}&period_start=${weekStart}`, { cache: 'no-store' }),
        ]);
        const entriesJson = (await entriesRes.json()) as {
          rows?: { employee_email: string; employee_name: string | null; kpi_data: Record<string, unknown> | null }[];
        };
        const statusJson = (await statusRes.json()) as { rows?: { status: BonusStatus }[] };

        const cfg = DEPT_INPUT_CONFIG[key]!;
        const dept = DEPARTMENTS.find((d) => d.key === key);

        const savedByEmail = new Map<string, Record<string, unknown>>();
        const deptMetrics: Record<string, number> = {};
        for (const row of entriesJson.rows ?? []) {
          const em = (row.employee_email ?? '').toLowerCase();
          if (em === DEPT_META_EMAIL) {
            for (const f of cfg.deptFields) {
              const v = Number(row.kpi_data?.[f.key] ?? 0);
              if (Number.isFinite(v)) deptMetrics[f.key] = v;
            }
            continue;
          }
          savedByEmail.set(em, row.kpi_data ?? {});
        }

        const byEmail = new Map<string, EmpEntry>();
        for (const e of roster) byEmail.set(e.email, { ...e, metrics: {}, toggles: {} });
        for (const [em, kpi] of savedByEmail) {
          if (!byEmail.has(em)) {
            byEmail.set(em, { email: em, name: String(kpi.__name__ ?? em), metrics: {}, toggles: {} });
          }
        }
        for (const entry of byEmail.values()) {
          const kpi = savedByEmail.get(entry.email);
          if (!kpi) continue;
          for (const f of cfg.employeeFields) {
            const v = Number(kpi[f.key] ?? 0);
            if (Number.isFinite(v) && v !== 0) entry.metrics[f.key] = v;
          }
          if (cfg.useToggleBonuses) {
            for (const b of dept?.bonuses ?? []) {
              if (kpi[b.id]) entry.toggles[b.id] = true;
            }
          }
        }

        const employees = Array.from(byEmail.values()).sort((a, b) => a.name.localeCompare(b.name));
        const status: BonusStatus = statusJson.rows?.[0]?.status ?? 'draft';
        setState((prev) => ({
          ...prev,
          [key]: { employees, deptMetrics, status, dirty: false, saving: false, loaded: true },
        }));
      } catch {
        setState((prev) => ({
          ...prev,
          [key]: { employees: roster, deptMetrics: {}, status: 'draft', dirty: false, saving: false, loaded: true },
        }));
      }
    },
    [rosterByDept, weekStart],
  );

  useEffect(() => {
    visibleDeptKeys.forEach((k) => void loadDept(k));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [visibleDeptKeys, loadDept]);

  // Fetch each department's team wallpaper (best-effort; falls back to a mesh).
  useEffect(() => {
    let cancelled = false;
    void Promise.all(
      visibleDeptKeys.map(async (key) => {
        const name = DEPARTMENTS.find((d) => d.key === key)?.name ?? key;
        try {
          const res = await fetch(`/api/manager/team-wallpaper?department=${encodeURIComponent(name)}`, { cache: 'no-store' });
          const json = (await res.json()) as { url?: string | null; position?: string };
          if (cancelled) return;
          setWallpapers((prev) => ({ ...prev, [key]: { url: json.url ?? null, position: json.position ?? '50% 50%' } }));
        } catch {
          /* fallback mesh is used */
        }
      }),
    );
    return () => {
      cancelled = true;
    };
  }, [visibleDeptKeys]);

  // ── Live bonus computation ───────────────────────────────────────────────────

  const computeBonuses = useCallback((key: string, st: DeptState): Record<string, number> => {
    const cfg = DEPT_INPUT_CONFIG[key]!;
    if (FORMULA_DEPT_KEYS.has(key)) {
      const empMetrics: Record<string, Record<string, number>> = {};
      for (const e of st.employees) empMetrics[e.email] = e.metrics;
      return calculateDepartmentBonus(key, st.employees, empMetrics, { [key]: st.deptMetrics });
    }
    if (cfg.useToggleBonuses) {
      const dept = DEPARTMENTS.find((d) => d.key === key);
      const out: Record<string, number> = {};
      for (const e of st.employees) {
        let sum = 0;
        for (const b of dept?.bonuses ?? []) if (e.toggles[b.id]) sum += b.amount;
        out[e.email] = sum;
      }
      return out;
    }
    const out: Record<string, number> = {};
    for (const e of st.employees) out[e.email] = 0;
    return out;
  }, []);

  // ── Mutators ─────────────────────────────────────────────────────────────────

  function setEmpMetric(key: string, email: string, metric: string, value: number) {
    setState((prev) => {
      const d = prev[key]!;
      return {
        ...prev,
        [key]: {
          ...d,
          dirty: true,
          employees: d.employees.map((e) =>
            e.email === email ? { ...e, metrics: { ...e.metrics, [metric]: value } } : e,
          ),
        },
      };
    });
  }

  function setEmpToggle(key: string, email: string, bonusId: string, on: boolean) {
    setState((prev) => {
      const d = prev[key]!;
      return {
        ...prev,
        [key]: {
          ...d,
          dirty: true,
          employees: d.employees.map((e) =>
            e.email === email ? { ...e, toggles: { ...e.toggles, [bonusId]: on } } : e,
          ),
        },
      };
    });
  }

  function setDeptMetric(key: string, metric: string, value: number) {
    setState((prev) => {
      const d = prev[key]!;
      return { ...prev, [key]: { ...d, dirty: true, deptMetrics: { ...d.deptMetrics, [metric]: value } } };
    });
  }

  // ── Persistence ──────────────────────────────────────────────────────────────

  async function saveDept(key: string) {
    const d = state[key];
    if (!d) return;
    const cfg = DEPT_INPUT_CONFIG[key]!;
    const bonuses = computeBonuses(key, d);
    patchDept(key, { saving: true });
    try {
      const entries: Record<string, unknown>[] = d.employees.map((e) => ({
        department: key,
        period_type: 'weekly',
        period_start: weekStart,
        period_end: weekEnd,
        employee_email: e.email,
        employee_name: e.name,
        is_manager: false,
        kpi_data: { ...e.metrics, ...e.toggles, __name__: e.name },
        calculated_bonus: bonuses[e.email] ?? 0,
        created_by: viewerEmail ?? undefined,
      }));
      if (cfg.deptFields.length > 0) {
        entries.push({
          department: key,
          period_type: 'weekly',
          period_start: weekStart,
          period_end: weekEnd,
          employee_email: DEPT_META_EMAIL,
          employee_name: 'Department metrics',
          is_manager: false,
          kpi_data: { ...d.deptMetrics },
          calculated_bonus: 0,
          created_by: viewerEmail ?? undefined,
        });
      }
      const res = await fetch('/api/hsl-bonus/entries', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ entries }),
      });
      const json = (await res.json()) as { error?: string; saved?: number };
      if (!res.ok) throw new Error(json.error ?? 'Save failed');
      patchDept(key, { dirty: false });
      const stillDraft = d.status !== 'ready' && d.status !== 'locked';
      const memberCount = `${d.employees.length} member${d.employees.length === 1 ? '' : 's'} updated`;
      toast.success(`${DEPARTMENTS.find((x) => x.key === key)?.name ?? key} saved`, {
        description: stillDraft ? `${memberCount} · Mark Ready before payroll` : memberCount,
      });
    } catch (e) {
      toast.error('Save failed', { description: e instanceof Error ? e.message : 'Unknown error' });
    } finally {
      patchDept(key, { saving: false });
    }
  }

  async function setStatus(key: string, next: BonusStatus): Promise<boolean> {
    try {
      const res = await fetch('/api/hsl-bonus/period-status', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          department: key,
          period_type: 'weekly',
          period_start: weekStart,
          period_end: weekEnd,
          status: next,
          locked_by: viewerEmail ?? undefined,
        }),
      });
      const json = (await res.json()) as { error?: string };
      if (!res.ok) throw new Error(json.error ?? 'Status update failed');
      patchDept(key, { status: next });
      return true;
    } catch (e) {
      toast.error('Status update failed', { description: e instanceof Error ? e.message : String(e) });
      return false;
    }
  }

  async function markReady(key: string) {
    const d = state[key];
    if (d?.dirty) {
      toast.error('Save your changes first', { description: 'Click Save before marking the week Ready.' });
      return;
    }
    const ok = await setStatus(key, 'ready');
    if (ok) {
      toast.success(`${DEPARTMENTS.find((x) => x.key === key)?.name ?? key} marked ready`, {
        description: 'Visible to Accounting in the Payroll Wizard.',
      });
    }
  }

  // ── Derived view data ────────────────────────────────────────────────────────

  const grandTotal = useMemo(() => {
    let sum = 0;
    for (const k of visibleDeptKeys) {
      const d = state[k];
      if (!d) continue;
      const b = computeBonuses(k, d);
      for (const v of Object.values(b)) sum += v;
    }
    return sum;
  }, [visibleDeptKeys, state, computeBonuses]);

  const totalPeople = useMemo(
    () => visibleDeptKeys.reduce((s, k) => s + (state[k]?.employees.length ?? 0), 0),
    [visibleDeptKeys, state],
  );

  const filteredKeys = activeFilter === 'all' ? visibleDeptKeys : visibleDeptKeys.filter((k) => k === activeFilter);
  const oneCard = filteredKeys.length <= 1;

  function isOpen(key: string): boolean {
    if (key in manualOpen) return manualOpen[key]!;
    return visibleDeptKeys.length === 1 || activeFilter === key;
  }

  if (visibleDeptKeys.length === 0) return null;

  const q = search.trim().toLowerCase();

  // Weekly KPI deadline: managers must mark every department Ready before the
  // current week's payroll. Whole-days remaining until the week closes (Sunday).
  const now = new Date();
  const today0 = new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime();
  const [ey, em, ed] = weekEnd.split('-').map(Number);
  const daysLeft = Math.round((new Date(ey!, em! - 1, ed!).getTime() - today0) / 86_400_000);
  const overdue = daysLeft < 0;
  const totalDepts = visibleDeptKeys.length;
  const readyCount = visibleDeptKeys.filter((k) => {
    const s = state[k]?.status;
    return s === 'ready' || s === 'locked';
  }).length;

  return (
    <div className="flex min-h-0 flex-col">
      {/* Header + controls */}
      <div className="sticky top-0 z-10 border-b border-zinc-200/80 bg-white/85 px-4 py-3 backdrop-blur-md dark:border-zinc-800 dark:bg-[#0d1117]/85 sm:px-6">
        <div className="flex flex-wrap items-end justify-between gap-3">
          <div>
            <p className="font-mono text-[10px] uppercase tracking-[0.22em] text-zinc-400 dark:text-zinc-500">
              KPI Calculator · Departments
            </p>
            <h2 className="mt-0.5 text-[15px] font-semibold tracking-tight text-zinc-900 dark:text-zinc-100">
              {isElevated ? 'All Departments' : visibleDeptKeys.length === 1
                ? DEPARTMENTS.find((d) => d.key === visibleDeptKeys[0])?.name
                : 'My Departments'}
              <span className="ml-2 font-mono text-[11px] font-normal text-zinc-400">week of {weekStart}</span>
            </h2>
          </div>
          <motion.div
            className="flex items-center gap-3 rounded-xl border border-zinc-200 bg-zinc-50/80 px-3.5 py-1.5 dark:border-zinc-800 dark:bg-zinc-900/60"
            initial={{ opacity: 0, scale: 0.96 }}
            animate={{ opacity: 1, scale: 1 }}
            transition={{ duration: 0.4, ease: EASE }}
          >
            <div className="text-right">
              <div className="font-mono text-[9px] uppercase tracking-[0.15em] text-zinc-400">Projected</div>
              <div className="tabular-nums font-mono text-base font-bold leading-none text-emerald-600 dark:text-emerald-400">
                <AnimatedPeso value={grandTotal} />
              </div>
            </div>
            <div className="h-7 w-px bg-zinc-200 dark:bg-zinc-700" />
            <div className="flex items-center gap-1 text-zinc-500">
              <Users className="h-3.5 w-3.5" aria-hidden />
              <span className="tabular-nums font-mono text-sm font-semibold">{totalPeople}</span>
            </div>
          </motion.div>
        </div>

        {/* Filter row */}
        <div className="mt-3 flex flex-wrap items-center gap-2">
          {visibleDeptKeys.length > 1 && (
            <LayoutGroup id="dept-filter">
              <div className="-mx-1 flex max-w-full items-center gap-1.5 overflow-x-auto px-1 pb-0.5">
                <FilterPill active={activeFilter === 'all'} onClick={() => setActiveFilter('all')} label="All" count={visibleDeptKeys.length} />
                {visibleDeptKeys.map((k) => (
                  <FilterPill
                    key={k}
                    active={activeFilter === k}
                    onClick={() => setActiveFilter(k)}
                    label={DEPARTMENTS.find((d) => d.key === k)?.name ?? k}
                    color={deptColor(k)}
                    count={state[k]?.employees.length ?? 0}
                  />
                ))}
              </div>
            </LayoutGroup>
          )}
          <div className="relative ml-auto">
            <Search className="pointer-events-none absolute left-2.5 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-zinc-400" aria-hidden />
            <Input
              type="search"
              placeholder="Find member…"
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              className="h-8 w-44 pl-8 text-xs"
            />
          </div>
        </div>

        <DeadlineBanner
          weekStart={weekStart}
          weekEnd={weekEnd}
          daysLeft={daysLeft}
          overdue={overdue}
          readyCount={readyCount}
          total={totalDepts}
        />
      </div>

      {/* Department cards */}
      <motion.div
        className={cn(
          'grid items-start gap-5 px-4 py-4 sm:px-6',
          oneCard ? 'mx-auto w-full max-w-3xl grid-cols-1' : 'grid-cols-1 lg:grid-cols-2',
        )}
        initial="hidden"
        animate="show"
        variants={{ show: { transition: { staggerChildren: 0.07, delayChildren: 0.05 } } }}
      >
        {filteredKeys.map((key) => {
          const d = state[key];
          const cfg = DEPT_INPUT_CONFIG[key]!;
          const dept = DEPARTMENTS.find((x) => x.key === key);
          const color = deptColor(key);
          const wp = wallpapers[key];
          const readOnly = d ? d.status !== 'draft' : false;
          const bonuses = d ? computeBonuses(key, d) : {};
          const total = Object.values(bonuses).reduce((s, n) => s + n, 0);
          const open = isOpen(key);
          const awards = cfg.useToggleBonuses ? dept?.bonuses ?? [] : [];
          const cols = `minmax(0,1fr) ${[...cfg.employeeFields, ...awards].map(() => '5.5rem').join(' ')} 5rem`;
          const members = (d?.employees ?? []).filter((e) => !q || e.name.toLowerCase().includes(q));

          return (
            <motion.div
              key={key}
              variants={{
                hidden: { opacity: 0, y: 8, scale: 0.98 },
                show: { opacity: 1, y: 0, scale: 1, transition: { duration: 0.35, ease: EASE } },
              }}
              whileHover={{ y: -4 }}
              className={cn(
                'group relative overflow-hidden rounded-2xl border bg-white shadow-sm transition-shadow hover:shadow-xl dark:bg-zinc-900/40',
                'border-zinc-200/90 dark:border-zinc-800',
                !readOnly && daysLeft <= 2 && 'ring-1 ring-amber-400/70 dark:ring-amber-500/40',
              )}
            >
              {/* Hero header (toggles open/closed) */}
              <motion.div
                role="button"
                tabIndex={0}
                aria-expanded={open}
                whileTap={{ scale: 0.992 }}
                onClick={() => setManualOpen((m) => ({ ...m, [key]: !open }))}
                onKeyDown={(ev) => {
                  if (ev.key === 'Enter' || ev.key === ' ') {
                    ev.preventDefault();
                    setManualOpen((m) => ({ ...m, [key]: !open }));
                  }
                }}
                className="relative block h-32 w-full cursor-pointer overflow-hidden outline-none"
              >
                {/* Background: uploaded wallpaper or generated mesh */}
                <div
                  className="absolute inset-0 bg-cover bg-center group-hover:scale-[1.06]"
                  style={{
                    backgroundImage: wp?.url ? `url("${wp.url}")` : fallbackBg(color),
                    backgroundPosition: wp?.position ?? '50% 50%',
                    transitionProperty: 'transform',
                    transitionDuration: '700ms',
                    transitionTimingFunction: 'cubic-bezier(0.22, 1, 0.36, 1)',
                  }}
                  aria-hidden
                />
                {/* Legibility overlay */}
                <div
                  className="absolute inset-0"
                  style={{ background: 'linear-gradient(to top, rgba(0,0,0,0.9) 0%, rgba(0,0,0,0.45) 48%, rgba(0,0,0,0.1) 100%)' }}
                  aria-hidden
                />
                {/* Sheen sweep on hover */}
                <div
                  className="pointer-events-none absolute inset-0 -translate-x-full bg-gradient-to-r from-transparent via-white/15 to-transparent group-hover:translate-x-full"
                  style={{
                    transitionProperty: 'transform',
                    transitionDuration: '900ms',
                    transitionTimingFunction: 'ease-out',
                  }}
                  aria-hidden
                />
                {/* Top colour accent */}
                <div className="absolute inset-x-0 top-0 h-1" style={{ backgroundColor: color }} aria-hidden />

                <div className="relative flex h-full flex-col justify-between p-4">
                  <div className="flex items-start justify-between gap-2">
                    <HeroBadge status={d?.status ?? 'draft'} warn={!readOnly && daysLeft <= 2} />
                    <div className="flex items-center gap-3">
                      {d?.dirty && (
                        <motion.span
                          className="h-1.5 w-1.5 rounded-full bg-amber-400 shadow-[0_0_6px] shadow-amber-400"
                          title="Unsaved changes"
                          aria-hidden
                          animate={{ opacity: [1, 0.35, 1] }}
                          transition={{ duration: 1.6, repeat: Infinity, ease: 'easeInOut' }}
                        />
                      )}
                      <div className="flex items-center gap-1 text-white/70">
                        <Users className="h-3 w-3" aria-hidden />
                        <span className="tabular-nums font-mono text-xs">{d?.employees.length ?? 0}</span>
                      </div>
                      <div className="text-right">
                        <div className="font-mono text-[8px] uppercase tracking-[0.18em] text-white/55">Projected</div>
                        <div className="tabular-nums font-mono text-sm font-bold leading-none text-emerald-300">
                          <AnimatedPeso value={total} />
                        </div>
                      </div>
                    </div>
                  </div>

                  <div className="flex items-end justify-between gap-3">
                    <div className="min-w-0">
                      <h3 className="truncate text-lg font-bold tracking-tight text-white drop-shadow-sm">{dept?.name ?? key}</h3>
                      <p className="mt-0.5 line-clamp-2 max-w-[48ch] text-[11px] leading-snug text-white/75">
                        {DEPT_DESCRIPTION[key] ?? ''}
                      </p>
                    </div>
                    <motion.span
                      className="shrink-0 rounded-full bg-white/15 p-1 text-white/90 backdrop-blur-sm"
                      animate={{ rotate: open ? 180 : 0 }}
                      transition={{ type: 'spring', stiffness: 320, damping: 20 }}
                    >
                      <ChevronDown className="h-4 w-4" aria-hidden />
                    </motion.span>
                  </div>
                </div>
              </motion.div>

              {/* Card body */}
              <AnimatePresence initial={false}>
                {open && (
                  <motion.section
                    key="body"
                    initial={{ height: 0, opacity: 0 }}
                    animate={{ height: 'auto', opacity: 1 }}
                    exit={{ height: 0, opacity: 0 }}
                    transition={{ duration: 0.34, ease: EASE }}
                    className="overflow-hidden"
                  >
                    <div className="border-t border-zinc-100 dark:border-zinc-800/70">
                      {/* Formula */}
                      <motion.div
                        className="flex flex-wrap items-center gap-2 px-3.5 pt-3"
                        initial={{ opacity: 0, y: 8 }}
                        animate={{ opacity: 1, y: 0 }}
                        transition={{ duration: 0.3, delay: 0.08, ease: EASE }}
                      >
                        <span
                          className="rounded-md px-1.5 py-0.5 font-mono text-[9px] font-semibold uppercase tracking-wide"
                          style={{ backgroundColor: hexA(color, 0.14), color }}
                        >
                          Formula
                        </span>
                        <p className="flex-1 text-[11px] leading-relaxed text-zinc-500 dark:text-zinc-400">{cfg.formula}</p>
                      </motion.div>

                      {/* Dept-level inputs */}
                      {cfg.deptFields.length > 0 && (
                        <motion.div
                          className="mx-3.5 mt-2.5 flex flex-wrap gap-2.5 rounded-xl p-2.5"
                          style={{ backgroundColor: hexA(color, 0.06) }}
                          initial={{ opacity: 0, y: 8 }}
                          animate={{ opacity: 1, y: 0 }}
                          transition={{ duration: 0.3, delay: 0.12, ease: EASE }}
                        >
                          {cfg.deptFields.map((f) => (
                            <label key={f.key} className="flex flex-col gap-1">
                              <span className="font-mono text-[9px] uppercase tracking-wide text-zinc-500 dark:text-zinc-400">
                                {f.label}
                              </span>
                              <Input
                                type="number"
                                inputMode="numeric"
                                className="h-7 w-20 text-sm tabular-nums"
                                disabled={readOnly || !d?.loaded}
                                value={d?.deptMetrics[f.key] ?? ''}
                                onChange={(ev) => setDeptMetric(key, f.key, Number(ev.target.value) || 0)}
                              />
                            </label>
                          ))}
                        </motion.div>
                      )}

                      {/* Members */}
                      {!d || !d.loaded ? (
                        <div className="px-3.5 py-5 text-center text-xs text-zinc-400">Loading…</div>
                      ) : members.length === 0 ? (
                        <div className="px-3.5 py-5 text-center text-xs text-zinc-400">
                          {q ? 'No members match your search.' : 'No team members in this department.'}
                        </div>
                      ) : (
                        <div className="mt-1.5 overflow-x-auto px-1.5 pb-1">
                          {(cfg.employeeFields.length > 0 || awards.length > 0) && (
                            <div
                              className="grid items-end gap-2 px-2 pb-1 text-[9px] font-medium uppercase tracking-wide text-zinc-400"
                              style={{ gridTemplateColumns: cols }}
                            >
                              <span>Member</span>
                              {cfg.employeeFields.map((f) => (
                                <span key={f.key} className="text-center leading-tight">{f.label}</span>
                              ))}
                              {awards.map((b) => (
                                <span key={b.id} className="text-center leading-tight">{b.label}</span>
                              ))}
                              <span className="text-right">Bonus</span>
                            </div>
                          )}
                          <motion.div
                            className="space-y-0.5"
                            initial="hidden"
                            animate="show"
                            variants={{ show: { transition: { staggerChildren: 0.028, delayChildren: 0.12 } } }}
                          >
                            {members.map((e) => (
                              <motion.div
                                key={e.email}
                                variants={{ hidden: { opacity: 0, y: 8 }, show: { opacity: 1, y: 0 } }}
                                className="grid items-center gap-2 rounded-lg px-2 py-1.5 transition-colors hover:bg-zinc-50 dark:hover:bg-zinc-800/40"
                                style={{ gridTemplateColumns: cols }}
                              >
                                <div className="min-w-0">
                                  <div className="truncate text-[13px] font-medium text-zinc-800 dark:text-zinc-100">{e.name}</div>
                                </div>
                                {cfg.employeeFields.map((f) => {
                                  const applies = !f.appliesTo || f.appliesTo(e.name);
                                  return (
                                    <div key={f.key} className="flex justify-center">
                                      {applies ? (
                                        <Input
                                          type="number"
                                          inputMode="numeric"
                                          aria-label={`${f.label} for ${e.name}`}
                                          className="h-7 w-[4.75rem] text-center text-sm tabular-nums"
                                          disabled={readOnly}
                                          value={e.metrics[f.key] ?? ''}
                                          onChange={(ev) => setEmpMetric(key, e.email, f.key, Number(ev.target.value) || 0)}
                                        />
                                      ) : (
                                        <span className="text-zinc-300 dark:text-zinc-600">—</span>
                                      )}
                                    </div>
                                  );
                                })}
                                {awards.map((b) => (
                                  <div key={b.id} className="flex justify-center">
                                    <input
                                      type="checkbox"
                                      aria-label={`${b.label} for ${e.name}`}
                                      className="h-4 w-4 rounded accent-emerald-600"
                                      disabled={readOnly}
                                      checked={e.toggles[b.id] ?? false}
                                      onChange={(ev) => setEmpToggle(key, e.email, b.id, ev.target.checked)}
                                    />
                                  </div>
                                ))}
                                <div className="tabular-nums text-right font-mono text-sm font-semibold text-emerald-600 dark:text-emerald-400">
                                  <AnimatedPeso value={bonuses[e.email] ?? 0} />
                                </div>
                              </motion.div>
                            ))}
                          </motion.div>
                        </div>
                      )}

                      {/* Footer */}
                      <div className="flex items-center justify-between gap-2 border-t border-zinc-100 px-3.5 py-2.5 dark:border-zinc-800/70">
                        <span
                          className={cn(
                            'font-mono text-[10px] uppercase tracking-wide',
                            readOnly ? 'text-emerald-500' : 'text-amber-600 dark:text-amber-400',
                          )}
                        >
                          {readOnly ? 'Sent to Accounting' : d?.dirty ? 'Unsaved changes' : 'Saved — not yet submitted'}
                        </span>
                        <div className="flex items-center gap-2">
                          {readOnly ? (
                            <Button size="sm" variant="outline" className="h-7 gap-1.5 text-xs" onClick={() => void setStatus(key, 'draft')}>
                              <RefreshCw className="h-3.5 w-3.5" /> Reopen
                            </Button>
                          ) : (
                            <>
                              <Button size="sm" variant="outline" className="h-7 gap-1.5 text-xs" disabled={d?.saving} onClick={() => void saveDept(key)}>
                                <Save className="h-3.5 w-3.5" /> {d?.saving ? 'Saving…' : 'Save'}
                              </Button>
                              <motion.div whileTap={{ scale: 0.95 }}>
                                <Button
                                  size="sm"
                                  className="h-7 gap-1.5 bg-emerald-600 text-xs text-white hover:bg-emerald-700"
                                  disabled={d?.dirty}
                                  onClick={() => void markReady(key)}
                                >
                                  <CheckCircle2 className="h-3.5 w-3.5" /> Mark Ready
                                </Button>
                              </motion.div>
                            </>
                          )}
                        </div>
                      </div>
                    </div>
                  </motion.section>
                )}
              </AnimatePresence>
            </motion.div>
          );
        })}
      </motion.div>
    </div>
  );
}

// ── Bits ─────────────────────────────────────────────────────────────────────

/** Peso figure that springs to its new value whenever it changes. */
function AnimatedPeso({ value }: { value: number }) {
  const spring = useSpring(value, { stiffness: 150, damping: 24, mass: 0.6 });
  const [shown, setShown] = useState(value);
  useEffect(() => {
    spring.set(value);
  }, [spring, value]);
  useEffect(() => spring.on('change', (v) => setShown(v)), [spring]);
  return <>{peso(shown)}</>;
}

function FilterPill({
  active,
  onClick,
  label,
  color,
  count,
}: {
  active: boolean;
  onClick: () => void;
  label: string;
  color?: string;
  count: number;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={cn(
        'relative flex shrink-0 items-center gap-1.5 rounded-full border px-2.5 py-1 text-xs font-medium transition-colors',
        active
          ? 'border-transparent text-white dark:text-zinc-900'
          : 'border-zinc-200 bg-white text-zinc-600 hover:bg-zinc-50 dark:border-zinc-800 dark:bg-zinc-900/50 dark:text-zinc-300 dark:hover:bg-zinc-800/60',
      )}
    >
      {active && (
        <motion.span
          layoutId="dept-filter-active"
          className="absolute inset-0 -z-10 rounded-full bg-zinc-900 dark:bg-zinc-100"
          transition={{ type: 'spring', stiffness: 380, damping: 32 }}
        />
      )}
      {color && <span className="h-2 w-2 rounded-full" style={{ backgroundColor: color }} aria-hidden />}
      <span className="max-w-[10rem] truncate">{label}</span>
      <span className={cn('tabular-nums font-mono text-[10px]', active ? 'opacity-70' : 'text-zinc-400')}>{count}</span>
    </button>
  );
}

function DeadlineBanner({
  weekStart,
  weekEnd,
  daysLeft,
  overdue,
  readyCount,
  total,
}: {
  weekStart: string;
  weekEnd: string;
  daysLeft: number;
  overdue: boolean;
  readyCount: number;
  total: number;
}) {
  const draft = total - readyCount;
  const done = draft === 0;
  const tier: 'done' | 'critical' | 'warn' | 'info' = done
    ? 'done'
    : overdue || daysLeft <= 1
      ? 'critical'
      : daysLeft <= 3
        ? 'warn'
        : 'info';
  const styles: Record<'done' | 'critical' | 'warn' | 'info', string> = {
    done: 'border-emerald-300/70 bg-emerald-50 text-emerald-800 dark:border-emerald-800/60 dark:bg-emerald-950/40 dark:text-emerald-200',
    info: 'border-sky-300/70 bg-sky-50 text-sky-800 dark:border-sky-800/60 dark:bg-sky-950/40 dark:text-sky-200',
    warn: 'border-amber-300/80 bg-amber-50 text-amber-900 dark:border-amber-700/60 dark:bg-amber-950/40 dark:text-amber-200',
    critical: 'border-red-300/80 bg-red-50 text-red-900 dark:border-red-700/60 dark:bg-red-950/40 dark:text-red-200',
  };
  const Icon = done ? CheckCircle2 : tier === 'info' ? Clock : AlertTriangle;
  const fmt = (iso: string) => {
    const [y, m, dd] = iso.split('-').map(Number);
    return new Date(y!, m! - 1, dd!).toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
  };
  const countdown = overdue ? 'payroll window closing' : daysLeft <= 0 ? 'due today' : `${daysLeft} day${daysLeft === 1 ? '' : 's'} left`;
  return (
    <div className={cn('mt-3 flex flex-wrap items-center gap-x-3 gap-y-1 rounded-xl border px-3 py-2 text-xs', styles[tier])}>
      <Icon className={cn('h-4 w-4 shrink-0', tier === 'critical' && !done && 'animate-pulse')} aria-hidden />
      <span className="font-semibold">
        {done ? 'All departments submitted for this week.' : `${draft} of ${total} department${total === 1 ? '' : 's'} not yet submitted.`}
      </span>
      <span className="opacity-80">
        Week {fmt(weekStart)} – {fmt(weekEnd)} · feeds this week&rsquo;s payroll{done ? '' : ` · ${countdown}`}
      </span>
      <span className="ml-auto rounded-full bg-white/70 px-2 py-0.5 font-mono text-[10px] font-semibold dark:bg-black/30">
        {readyCount}/{total} ready
      </span>
    </div>
  );
}

function HeroBadge({ status, warn }: { status: BonusStatus; warn?: boolean }) {
  const map: Record<BonusStatus, { label: string; cls: string; icon?: React.ReactNode }> = {
    draft:
      warn
        ? { label: 'Action needed', cls: 'bg-amber-400/30 text-amber-50 ring-1 ring-amber-200/40', icon: <AlertTriangle className="h-3 w-3" /> }
        : { label: 'Draft', cls: 'bg-white/15 text-white/90' },
    ready: { label: 'Ready', cls: 'bg-emerald-400/25 text-emerald-100', icon: <CheckCircle2 className="h-3 w-3" /> },
    locked: { label: 'Locked', cls: 'bg-amber-400/25 text-amber-100', icon: <Lock className="h-3 w-3" /> },
  };
  const s = map[status];
  return (
    <span
      className={cn(
        'inline-flex shrink-0 items-center gap-1 rounded-full px-2 py-0.5 text-[9px] font-semibold uppercase tracking-wide backdrop-blur-sm',
        s.cls,
      )}
    >
      {s.icon}
      {s.label}
    </span>
  );
}
