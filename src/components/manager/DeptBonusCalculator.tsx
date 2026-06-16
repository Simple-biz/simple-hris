'use client';

// KPI Calculator -- Departments (non-HSL).
//
// Catalog-driven: the bonuses a manager can apply come from the Bonus Catalog
// (Accounting tab). For each department the manager controls:
//   - "Common" bonuses (assigned to the whole department) apply to every member.
//   - "Individual" bonuses (assigned to one employee in the department) show on
//     that person only.
// On a fresh week, "Common" bonuses are pre-applied to everyone in the
// department (minus anyone excluded in the catalog) so the manager doesn't have
// to tick each person; once the week is saved, the saved selection is
// authoritative (a manual untick persists). Flat bonuses are a simple on/off;
// formula bonuses collect their variable inputs per employee and compute live
// via the catalog formula engine. Applied rows are saved to
// bonus_catalog_applied (one row per member x applied bonus) and, once the week
// is marked Ready, feed the Payroll Wizard "KPI Sub." column.
//
// Week = the latest Hubstaff upload (pinned, same key accounting processes).
// Status (draft/ready/locked) lives in hsl_bonus_period_status (reused).

import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { AnimatePresence, LayoutGroup, motion, useSpring } from 'motion/react';
import {
  AlertTriangle,
  CalendarDays,
  Check,
  CheckCircle2,
  ChevronDown,
  ChevronLeft,
  ChevronRight,
  Clock,
  Lock,
  Minus,
  RefreshCw,
  Save,
  Search,
  Sparkles,
  User,
  Users,
  Zap,
} from 'lucide-react';
import { toast } from 'sonner';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { cn } from '@/lib/utils';
import { normEmail } from '@/lib/email/norm-email';
import type { EmployeeRow } from '@/lib/supabase/employees';
import { normalizeDeptToKey } from '@/lib/payroll/normalize-dept-key';
import { DEPARTMENTS, DEPT_DESCRIPTION, MANAGER_BONUS_DEPT_KEYS } from '@/lib/payroll/department-bonus';
import { parseDateRangeFromFilename } from '@/lib/hubstaff/calendar-column-dedupe';
import {
  pickCurrentSourceFile,
  type HubstaffSourceFilesResponse,
} from '@/lib/hubstaff/current-upload';
import { getSupabaseBrowserClient } from '@/lib/supabase/browser';
import { validateFormula, evaluateFormula } from '@/lib/bonus-catalog/formula';
import type { BonusDef, BonusAssignment } from '@/lib/bonus-catalog/types';
import { OFFICIAL_USD_TO_PHP_RATE, effectiveUsdToPhpRateFromStored } from '@/lib/fx/usd-php';
import { CURRENCY_SYMBOL } from '@/lib/payment-catalog/pay-structure';

// -- Types ---------------------------------------------------------------------

type BonusStatus = 'draft' | 'ready' | 'locked';

const EASE = [0.22, 1, 0.36, 1] as const;
const PESO = '₱';
const MEMBER_PAGE_SIZE = 8;

/** Per-member, per-bonus applied state. `vars` holds formula inputs as strings. */
interface AppliedState {
  on: boolean;
  vars: Record<string, string>;
}

interface MemberState {
  email: string;
  name: string;
  applied: Record<string, AppliedState>; // keyed by bonusId
}

interface DeptState {
  members: MemberState[];
  /** Team-effort ("shared") common bonuses: entered once for the whole dept,
   *  keyed by bonusId. Every non-excluded member receives the computed amount. */
  shared: Record<string, AppliedState>;
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

// -- Per-department colour identity (hex; inline-styled to dodge Tailwind purge) --

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

/** hex (#rrggbb) -> rgba string at the given alpha. */
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

// -- Period helpers (weekly, Monday-anchored -- matches the payroll week) -------

function isoWeekStart(d: Date): string {
  const day = new Date(d.getFullYear(), d.getMonth(), d.getDate());
  const dow = day.getDay(); // 0=Sun ... 6=Sat
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
  // Always show centavos so a fractional formula result (e.g. a division in the
  // Payment Catalog formula) is never silently rounded to whole pesos.
  return `${PESO}${n.toLocaleString('en-PH', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
}

/** Two-letter initials from a roster name (handles "Last, First M." formats). */
function initials(name: string): string {
  const parts = name.replace(/["']/g, '').replace(/,/g, ' ').split(/\s+/).filter(Boolean);
  if (parts.length === 0) return '?';
  if (parts.length === 1) return parts[0]!.slice(0, 2).toUpperCase();
  return (parts[0]![0]! + parts[1]![0]!).toUpperCase();
}

/** Tileable film-grain noise, layered over the hero with mix-blend for depth. */
const HERO_NOISE =
  "url(\"data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='120' height='120'%3E%3Cfilter id='n'%3E%3CfeTurbulence type='fractalNoise' baseFrequency='0.85' numOctaves='3' stitchTiles='stitch'/%3E%3C/filter%3E%3Crect width='100%25' height='100%25' filter='url(%23n)'/%3E%3C/svg%3E\")";

function rowEmail(r: EmployeeRow): string {
  return normEmail(r.personal_email ?? null) || normEmail(r.work_email ?? null) || '';
}

/** Deterministic applied-row id so re-saves upsert the same row. */
function appliedId(dept: string, periodStart: string, email: string, bonusId: string): string {
  return `app:${periodStart}:${dept}:${email}:${bonusId}`;
}

/** Round a peso amount to centavos (2dp) — the money granularity the
 *  bonus_catalog_applied.amount column (numeric(14,2)) and the Payroll Wizard
 *  "KPI Sub." sum operate at. Keeps the live display, the saved row, and what
 *  the wizard pays in exact agreement. */
function toCentavos(n: number): number {
  return Number.isFinite(n) ? Math.round(n * 100) / 100 : 0;
}

/** Compute the PESO amount a bonus pays for a given set of (string) variable
 *  inputs. Flat bonuses use the catalog amount; formula bonuses evaluate the
 *  Payment Catalog formula verbatim (`evaluateFormula`).
 *
 *  A USD-denominated bonus is converted to PHP at `fxRate` (PHP per $1) — the
 *  same USD->PHP-at-FX rule Pay Structures use (resolve-rate.ts). The multiply
 *  happens BEFORE centavo-pinning so the stored PHP value is exact. Because this
 *  is the single chokepoint every display + the saved `amount` funnels through,
 *  converting here keeps bonus_catalog_applied + the Payroll Wizard PHP-only.
 *  PHP bonuses (and legacy bonuses with no currency) pass through untouched. */
function computeAmount(
  bonus: BonusDef,
  varsStr: Record<string, string> | undefined,
  fxRate: number,
): number {
  const factor = bonus.currency === 'USD' ? fxRate : 1;
  if (bonus.kind === 'flat') {
    return toCentavos((Number.isFinite(bonus.amount) ? (bonus.amount as number) : 0) * factor);
  }
  const check = validateFormula(bonus.formula ?? '');
  if (!check.ok) return 0;
  const nums: Record<string, number> = {};
  for (const v of check.variables) nums[v] = Number(varsStr?.[v] ?? '') || 0;
  try {
    return toCentavos(evaluateFormula(bonus.formula ?? '', nums) * factor);
  } catch {
    return 0;
  }
}

/** The bonus amount in its OWN currency (no FX) — for showing the native source
 *  figure next to the converted peso. Flat bonuses only; formula results vary
 *  with inputs so callers show a plain "USD" tag instead. */
function nativeFlatAmount(bonus: BonusDef): number {
  return toCentavos(Number.isFinite(bonus.amount) ? (bonus.amount as number) : 0);
}

/** Variable names a formula references (empty for flat bonuses / invalid formulas). */
function bonusVariables(bonus: BonusDef): string[] {
  if (bonus.kind !== 'formula') return [];
  const check = validateFormula(bonus.formula ?? '');
  return check.ok ? check.variables : [];
}

// -- Component ------------------------------------------------------------------

export default function DeptBonusCalculator({
  viewerEmail,
  teamMembers,
  managedDepts,
  isElevated,
}: DeptBonusCalculatorProps) {
  const [weekStart, setWeekStart] = useState(() => isoWeekStart(new Date()));
  const weekEnd = useMemo(() => weekEndFromStart(weekStart), [weekStart]);

  // Which weeks the manager can switch between (one per uploaded Hubstaff file)
  // and which one is the *live* payroll week (the Initialized / is_current batch).
  const [availableWeeks, setAvailableWeeks] = useState<{ start: string; end: string }[]>([]);
  const [currentWeekStart, setCurrentWeekStart] = useState<string | null>(null);
  // Always offer the selected + live weeks even before the upload list resolves.
  const weekOptions = useMemo(() => {
    const map = new Map<string, { start: string; end: string }>();
    for (const w of availableWeeks) map.set(w.start, w);
    for (const s of [currentWeekStart, weekStart]) {
      if (s && !map.has(s)) map.set(s, { start: s, end: weekEndFromStart(s) });
    }
    return Array.from(map.values()).sort((a, b) =>
      a.start < b.start ? 1 : a.start > b.start ? -1 : 0,
    );
  }, [availableWeeks, currentWeekStart, weekStart]);
  const isLiveWeek = currentWeekStart == null || weekStart === currentWeekStart;

  // Catalog (authored in Accounting -> Bonus Catalog).
  const [bonuses, setBonuses] = useState<BonusDef[]>([]);
  const [assignments, setAssignments] = useState<BonusAssignment[]>([]);
  const [catalogLoaded, setCatalogLoaded] = useState(false);

  // Live USD->PHP rate (PHP per $1). USD-denominated catalog bonuses are
  // converted to PHP at this rate when applied, mirroring how Pay Structures
  // convert USD rates (resolve-rate.ts). Read from the benign app_settings key
  // the Payroll Wizard uses, falling back to the official rate.
  const [usdToPhpRate, setUsdToPhpRate] = useState<number>(OFFICIAL_USD_TO_PHP_RATE);
  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const res = await fetch('/api/app-settings?key=usd_to_php_rate', { cache: 'no-store' });
        const json = (await res.json()) as { value?: string | null };
        if (!cancelled) setUsdToPhpRate(effectiveUsdToPhpRateFromStored(json.value));
      } catch {
        /* keep the official fallback */
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  const bonusById = useMemo(() => {
    const m = new Map<string, BonusDef>();
    for (const b of bonuses) m.set(b.id, b);
    return m;
  }, [bonuses]);

  const fetchCatalog = useCallback(async () => {
    try {
      const res = await fetch('/api/bonus-catalog', { cache: 'no-store' });
      const json = (await res.json()) as { bonuses?: BonusDef[]; assignments?: BonusAssignment[] };
      setBonuses(json.bonuses ?? []);
      setAssignments(json.assignments ?? []);
    } catch {
      /* keep prior */
    } finally {
      setCatalogLoaded(true);
    }
  }, []);

  useEffect(() => {
    void fetchCatalog();
  }, [fetchCatalog]);

  // Roster grouped by normalized department key, limited to this calculator's depts.
  const rosterByDept = useMemo(() => {
    const map = new Map<string, { email: string; name: string }[]>();
    for (const r of teamMembers) {
      const key = normalizeDeptToKey(r.department);
      if (!key || !MANAGER_BONUS_DEPT_KEYS.includes(key)) continue;
      const email = rowEmail(r);
      if (!email) continue;
      const list = map.get(key) ?? [];
      list.push({ email, name: r.name ?? email });
      map.set(key, list);
    }
    for (const list of map.values()) list.sort((a, b) => a.name.localeCompare(b.name));
    return map;
  }, [teamMembers]);

  // Common + per-employee catalog bonuses resolved per department key.
  const commonByDept = useMemo(() => {
    const map = new Map<string, BonusDef[]>();
    for (const a of assignments) {
      if (a.scope !== 'department') continue;
      const key = normalizeDeptToKey(a.departmentKey) ?? a.departmentKey;
      const bonus = bonusById.get(a.bonusId);
      if (!bonus) continue;
      const list = map.get(key) ?? [];
      if (!list.some((b) => b.id === bonus.id)) list.push(bonus);
      map.set(key, list);
    }
    return map;
  }, [assignments, bonusById]);

  // dept key -> set of bonusIds that are "team effort" (shared) common bonuses:
  // entered once for the whole dept, everyone non-excluded receives the result.
  const sharedCommonByDept = useMemo(() => {
    const map = new Map<string, Set<string>>();
    for (const a of assignments) {
      if (a.scope !== 'department' || !a.sharedTeam) continue;
      const key = normalizeDeptToKey(a.departmentKey) ?? a.departmentKey;
      const set = map.get(key) ?? new Set<string>();
      set.add(a.bonusId);
      map.set(key, set);
    }
    return map;
  }, [assignments]);

  // dept key -> (bonusId -> set of excluded member emails). A common bonus skips
  // anyone the accountant excluded for it (Payment Catalog -> Assignments).
  const commonExclusionsByDept = useMemo(() => {
    const map = new Map<string, Map<string, Set<string>>>();
    for (const a of assignments) {
      if (a.scope !== 'department' || !a.excludedEmails?.length) continue;
      const key = normalizeDeptToKey(a.departmentKey) ?? a.departmentKey;
      const byBonus = map.get(key) ?? new Map<string, Set<string>>();
      const set = byBonus.get(a.bonusId) ?? new Set<string>();
      for (const e of a.excludedEmails) set.add(e.toLowerCase());
      byBonus.set(a.bonusId, set);
      map.set(key, byBonus);
    }
    return map;
  }, [assignments]);

  const individualByDept = useMemo(() => {
    // dept key -> (employee email -> BonusDef[])
    const map = new Map<string, Map<string, BonusDef[]>>();
    for (const a of assignments) {
      if (a.scope !== 'employee' || !a.employeeEmail) continue;
      const key = normalizeDeptToKey(a.departmentKey) ?? a.departmentKey;
      const bonus = bonusById.get(a.bonusId);
      if (!bonus) continue;
      const email = normEmail(a.employeeEmail) || a.employeeEmail.toLowerCase();
      const byEmail = map.get(key) ?? new Map<string, BonusDef[]>();
      const list = byEmail.get(email) ?? [];
      if (!list.some((b) => b.id === bonus.id)) list.push(bonus);
      byEmail.set(email, list);
      map.set(key, byEmail);
    }
    return map;
  }, [assignments, bonusById]);

  const deptLabelByKey = useMemo<Record<string, string>>(() => {
    const out: Record<string, string> = {};
    const add = (raw: string | null | undefined) => {
      if (!raw) return;
      const k = normalizeDeptToKey(raw);
      if (k && !(k in out)) out[k] = raw.trim();
    };
    for (const r of teamMembers) add(r.department);
    for (const d of managedDepts) add(d);
    return out;
  }, [teamMembers, managedDepts]);

  const visibleDeptKeys = useMemo<string[]>(() => {
    if (isElevated) {
      return MANAGER_BONUS_DEPT_KEYS.filter(
        (k) =>
          (rosterByDept.get(k)?.length ?? 0) > 0 ||
          (commonByDept.get(k)?.length ?? 0) > 0 ||
          (individualByDept.get(k)?.size ?? 0) > 0,
      );
    }
    const keys = new Set<string>();
    for (const d of managedDepts) {
      const k = normalizeDeptToKey(d);
      if (k && MANAGER_BONUS_DEPT_KEYS.includes(k)) keys.add(k);
    }
    return Array.from(keys);
  }, [isElevated, managedDepts, rosterByDept, commonByDept, individualByDept]);

  const [state, setState] = useState<AllState>({});
  const [wallpapers, setWallpapers] = useState<Record<string, Wallpaper>>({});
  const [activeFilter, setActiveFilter] = useState<string>('all');
  // Per-department member search + pagination (standard list controls).
  const [cardSearch, setCardSearch] = useState<Record<string, string>>({});
  const [cardPage, setCardPage] = useState<Record<string, number>>({});
  const [manualOpen, setManualOpen] = useState<Record<string, boolean>>({});

  function patchDept(key: string, patch: Partial<DeptState>) {
    setState((prev) => {
      const cur = prev[key];
      if (!cur) return prev; // never create a partial (members-less) dept state
      return { ...prev, [key]: { ...cur, ...patch } };
    });
  }

  /** Bonuses applicable to one member: dept-common + that person's individual ones. */
  const applicableBonuses = useCallback(
    (deptKey: string, email: string): BonusDef[] => {
      const common = commonByDept.get(deptKey) ?? [];
      const indiv = individualByDept.get(deptKey)?.get(email) ?? [];
      const excludedFor = commonExclusionsByDept.get(deptKey);
      const lower = email.toLowerCase();
      const seen = new Set<string>();
      const out: BonusDef[] = [];
      // Common bonuses, minus anyone explicitly excluded from them.
      for (const b of common) {
        if (excludedFor?.get(b.id)?.has(lower)) continue;
        if (seen.has(b.id)) continue;
        seen.add(b.id);
        out.push(b);
      }
      // Individual assignments always apply (and override a common exclusion).
      for (const b of indiv) {
        if (seen.has(b.id)) continue;
        seen.add(b.id);
        out.push(b);
      }
      return out;
    },
    [commonByDept, individualByDept, commonExclusionsByDept],
  );

  // -- Load existing applied rows + status for a department ----------------------

  const loadDept = useCallback(
    async (key: string) => {
      const roster = rosterByDept.get(key) ?? [];
      try {
        const [appliedRes, statusRes] = await Promise.all([
          fetch(`/api/bonus-catalog-applied?dept=${key}&period_start=${weekStart}`, { cache: 'no-store' }),
          fetch(`/api/hsl-bonus/period-status?dept=${key}&period_start=${weekStart}`, { cache: 'no-store' }),
        ]);
        const appliedJson = (await appliedRes.json()) as {
          rows?: {
            employee_email: string;
            employee_name: string | null;
            bonus_id: string;
            vars: Record<string, number> | null;
          }[];
        };
        const statusJson = (await statusRes.json()) as { rows?: { status: BonusStatus }[] };
        const savedRows = appliedJson.rows ?? [];

        // Seed members from roster, then overlay anyone who has saved applied rows.
        const byEmail = new Map<string, MemberState>();
        for (const e of roster) byEmail.set(e.email, { email: e.email, name: e.name, applied: {} });
        // Also include individually-assigned employees even if not in the roster fetch.
        const indivMap = individualByDept.get(key);
        if (indivMap) {
          for (const email of indivMap.keys()) {
            if (!byEmail.has(email)) byEmail.set(email, { email, name: email, applied: {} });
          }
        }
        const sharedSet = sharedCommonByDept.get(key);
        const shared: Record<string, AppliedState> = {};
        for (const row of savedRows) {
          const em = (row.employee_email ?? '').toLowerCase();
          if (!em) continue;
          const vars: Record<string, string> = {};
          if (row.vars) for (const [k, v] of Object.entries(row.vars)) vars[k] = String(v);
          // Team-effort bonuses are stored per-member but are identical across the
          // dept -- collapse them into one shared entry instead of per-member.
          if (sharedSet?.has(row.bonus_id)) {
            if (!shared[row.bonus_id]) shared[row.bonus_id] = { on: true, vars };
            continue;
          }
          const member =
            byEmail.get(em) ?? { email: em, name: row.employee_name ?? em, applied: {} };
          if (!byEmail.has(em)) byEmail.set(em, member);
          member.applied[row.bonus_id] = { on: true, vars };
        }

        const status: BonusStatus = statusJson.rows?.[0]?.status ?? 'draft';

        // Pre-apply common bonuses: on a fresh (never-saved, still-draft) week a
        // common bonus set to "everyone" should already be ticked, so the manager
        // doesn't have to apply it by hand. Once the week has been saved, the
        // saved selection is authoritative (a manual untick persists). Excluded
        // members are skipped here and by applicableBonuses regardless.
        let preApplied = false;
        if (savedRows.length === 0 && status === 'draft') {
          const common = commonByDept.get(key) ?? [];
          const exMap = commonExclusionsByDept.get(key);
          for (const b of common) {
            if (sharedSet?.has(b.id)) {
              // Team-effort bonus: one shared entry, default on.
              shared[b.id] = { on: true, vars: {} };
              preApplied = true;
              continue;
            }
            for (const member of byEmail.values()) {
              const lower = member.email.toLowerCase();
              if (exMap?.get(b.id)?.has(lower)) continue;
              if (member.applied[b.id]) continue;
              member.applied[b.id] = { on: true, vars: {} };
              preApplied = true;
            }
          }
        }

        const members = Array.from(byEmail.values()).sort((a, b) => a.name.localeCompare(b.name));
        setState((prev) => ({
          // Pre-applied defaults are unsaved -- mark dirty so Save (then Mark
          // Ready) persists them into bonus_catalog_applied for the Wizard.
          ...prev,
          [key]: { members, shared, status, dirty: preApplied, saving: false, loaded: true },
        }));
      } catch {
        setState((prev) => ({
          ...prev,
          [key]: {
            members: roster.map((e) => ({ email: e.email, name: e.name, applied: {} })),
            shared: {},
            status: 'draft',
            dirty: false,
            saving: false,
            loaded: true,
          },
        }));
      }
    },
    [rosterByDept, individualByDept, commonByDept, commonExclusionsByDept, sharedCommonByDept, weekStart],
  );

  useEffect(() => {
    if (!catalogLoaded) return;
    visibleDeptKeys.forEach((k) => void loadDept(k));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [visibleDeptKeys, loadDept, catalogLoaded]);

  // Live: a teammate authoring/assigning a bonus, or another manager applying one,
  // refetches the catalog and reloads the open departments.
  useEffect(() => {
    const supabase = getSupabaseBrowserClient();
    if (!supabase) return;
    const channel = supabase
      .channel('dept-bonus-calc')
      .on('postgres_changes', { event: '*', schema: 'public', table: 'bonus_catalog_bonuses' }, () => void fetchCatalog())
      .on('postgres_changes', { event: '*', schema: 'public', table: 'bonus_catalog_assignments' }, () => void fetchCatalog())
      .subscribe();
    return () => {
      void supabase.removeChannel(channel);
    };
  }, [fetchCatalog]);

  // Pin the KPI week to the Hubstaff batch accounting is dispatching — the
  // Initialized (is_current) upload, NOT merely the newest file. The public
  // endpoint returns newest-first, so we resolve the current batch the same way
  // the Payroll Wizard does (pickCurrentSourceFile) to keep the manager's KPI
  // week in lock-step with the week accounting processes.
  useEffect(() => {
    const toIso = (d: Date) =>
      `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
    (async () => {
      try {
        const res = await fetch('/api/hubstaff-hours?source_files=1', { cache: 'no-store' });
        const json = (await res.json()) as HubstaffSourceFilesResponse;

        // Build the week menu: one entry per distinct uploaded Hubstaff week.
        const seen = new Set<string>();
        const weeks: { start: string; end: string }[] = [];
        const allFiles = [
          ...(json.uploads?.map((u) => u.source_file ?? '') ?? []),
          ...(json.files ?? []),
        ];
        for (const f of allFiles) {
          const range = f ? parseDateRangeFromFilename(f) : null;
          if (!range) continue;
          const startIso = toIso(range.start);
          if (seen.has(startIso)) continue;
          seen.add(startIso);
          weeks.push({ start: startIso, end: weekEndFromStart(startIso) });
        }
        weeks.sort((a, b) => (a.start < b.start ? 1 : a.start > b.start ? -1 : 0));
        setAvailableWeeks(weeks);

        // Pin the *live* week to the batch accounting is dispatching (is_current).
        const latest = pickCurrentSourceFile(json.uploads, json.files);
        const range = latest ? parseDateRangeFromFilename(latest) : null;
        if (range) {
          const iso = toIso(range.start);
          setCurrentWeekStart(iso);
          // Default the view to the live week (only while still on today's auto-week).
          setWeekStart((cur) => (cur === isoWeekStart(new Date()) ? iso : cur));
        }
      } catch {
        // keep today's week on any error
      }
    })();
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  // Fetch each department's team wallpaper (best-effort; falls back to a mesh).
  useEffect(() => {
    let cancelled = false;
    void Promise.all(
      visibleDeptKeys.map(async (key) => {
        const name = deptLabelByKey[key] ?? DEPARTMENTS.find((d) => d.key === key)?.name ?? key;
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
  }, [visibleDeptKeys, deptLabelByKey]);

  // -- Live bonus computation ----------------------------------------------------

  const memberTotal = useCallback(
    (deptKey: string, member: MemberState, shared: Record<string, AppliedState> | undefined): number => {
      const sharedSet = sharedCommonByDept.get(deptKey);
      let sum = 0;
      for (const bonus of applicableBonuses(deptKey, member.email)) {
        // Team-effort bonus: every member gets the single shared amount.
        if (sharedSet?.has(bonus.id)) {
          const sh = shared?.[bonus.id];
          if (sh?.on) sum += computeAmount(bonus, sh.vars, usdToPhpRate);
          continue;
        }
        const st = member.applied[bonus.id];
        if (st?.on) sum += computeAmount(bonus, st.vars, usdToPhpRate);
      }
      return sum;
    },
    [applicableBonuses, sharedCommonByDept, usdToPhpRate],
  );

  const deptTotal = useCallback(
    (deptKey: string, st: DeptState | undefined): number => {
      if (!st) return 0;
      return st.members.reduce((s, m) => s + memberTotal(deptKey, m, st.shared), 0);
    },
    [memberTotal],
  );

  // -- Mutators ------------------------------------------------------------------

  function toggleBonus(deptKey: string, email: string, bonusId: string, on: boolean) {
    setState((prev) => {
      const d = prev[deptKey];
      if (!d) return prev; // dept not loaded yet -- ignore
      return {
        ...prev,
        [deptKey]: {
          ...d,
          dirty: true,
          members: d.members.map((m) =>
            m.email === email
              ? { ...m, applied: { ...m.applied, [bonusId]: { on, vars: m.applied[bonusId]?.vars ?? {} } } }
              : m,
          ),
        },
      };
    });
  }

  function setVar(deptKey: string, email: string, bonusId: string, varName: string, value: string) {
    setState((prev) => {
      const d = prev[deptKey];
      if (!d) return prev; // dept not loaded yet -- ignore
      return {
        ...prev,
        [deptKey]: {
          ...d,
          dirty: true,
          members: d.members.map((m) => {
            if (m.email !== email) return m;
            const cur = m.applied[bonusId] ?? { on: true, vars: {} };
            return {
              ...m,
              applied: { ...m.applied, [bonusId]: { on: true, vars: { ...cur.vars, [varName]: value } } },
            };
          }),
        },
      };
    });
  }

  /** Turn a team-effort (shared) bonus on/off for the whole department. */
  function toggleShared(deptKey: string, bonusId: string, on: boolean) {
    setState((prev) => {
      const d = prev[deptKey];
      if (!d) return prev;
      const cur = d.shared[bonusId] ?? { on: false, vars: {} };
      return {
        ...prev,
        [deptKey]: { ...d, dirty: true, shared: { ...d.shared, [bonusId]: { ...cur, on } } },
      };
    });
  }

  /** Set a shared formula variable for a team-effort bonus (entered once). */
  function setSharedVar(deptKey: string, bonusId: string, varName: string, value: string) {
    setState((prev) => {
      const d = prev[deptKey];
      if (!d) return prev;
      const cur = d.shared[bonusId] ?? { on: true, vars: {} };
      return {
        ...prev,
        [deptKey]: {
          ...d,
          dirty: true,
          shared: { ...d.shared, [bonusId]: { on: true, vars: { ...cur.vars, [varName]: value } } },
        },
      };
    });
  }

  /** Toggle a common bonus on/off for every member of the department at once. */
  function applyToAll(deptKey: string, bonusId: string, on: boolean) {
    setState((prev) => {
      const d = prev[deptKey];
      if (!d) return prev; // dept not loaded yet -- ignore
      return {
        ...prev,
        [deptKey]: {
          ...d,
          dirty: true,
          members: d.members.map((m) => ({
            ...m,
            applied: { ...m.applied, [bonusId]: { on, vars: m.applied[bonusId]?.vars ?? {} } },
          })),
        },
      };
    });
  }

  // -- Persistence ---------------------------------------------------------------

  async function saveDept(key: string) {
    const d = state[key];
    if (!d) return;
    patchDept(key, { saving: true });
    try {
      const sharedSet = sharedCommonByDept.get(key);
      const rows = [] as Array<Record<string, unknown>>;
      for (const m of d.members) {
        for (const bonus of applicableBonuses(key, m.email)) {
          // Team-effort bonuses pull from the single shared entry; everyone who
          // is applicable gets an identical row (so the Wizard pays each member).
          const isShared = sharedSet?.has(bonus.id);
          const st = isShared ? d.shared[bonus.id] : m.applied[bonus.id];
          if (!st?.on) continue;
          const numVars: Record<string, number> = {};
          for (const v of bonusVariables(bonus)) numVars[v] = Number(st.vars?.[v] ?? '') || 0;
          rows.push({
            id: appliedId(key, weekStart, m.email, bonus.id),
            periodStart: weekStart,
            periodEnd: weekEnd,
            department: key,
            employeeEmail: m.email,
            employeeName: m.name,
            bonusId: bonus.id,
            bonusName: bonus.name,
            kind: bonus.kind,
            vars: bonus.kind === 'formula' ? numVars : null,
            // USD bonuses are converted to PHP here so the saved amount (and the
            // Payroll Wizard "KPI Sub." sum) stays PHP. The rate is snapshotted
            // at apply time, like the rest of the applied row.
            amount: computeAmount(bonus, st.vars, usdToPhpRate),
          });
        }
      }
      const res = await fetch('/api/bonus-catalog-applied', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ department: key, period_start: weekStart, period_end: weekEnd, rows }),
      });
      const json = (await res.json()) as { error?: string | null; saved?: number };
      if (!res.ok || json.error) throw new Error(json.error ?? 'Save failed');
      patchDept(key, { dirty: false });
      const stillDraft = d.status !== 'ready' && d.status !== 'locked';
      const applied = `${rows.length} bonus${rows.length === 1 ? '' : 'es'} applied`;
      toast.success(`${DEPARTMENTS.find((x) => x.key === key)?.name ?? key} saved`, {
        description: stillDraft ? `${applied} · Mark Ready before payroll` : applied,
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

  // -- Derived view data ---------------------------------------------------------

  const grandTotal = useMemo(() => {
    let sum = 0;
    for (const k of visibleDeptKeys) sum += deptTotal(k, state[k]);
    return sum;
  }, [visibleDeptKeys, state, deptTotal]);

  const totalPeople = useMemo(
    () => visibleDeptKeys.reduce((s, k) => s + (state[k]?.members.length ?? 0), 0),
    [visibleDeptKeys, state],
  );

  const filteredKeys = activeFilter === 'all' ? visibleDeptKeys : visibleDeptKeys.filter((k) => k === activeFilter);
  const oneCard = filteredKeys.length <= 1;

  function isOpen(key: string): boolean {
    if (key in manualOpen) return manualOpen[key]!;
    return visibleDeptKeys.length === 1 || activeFilter === key;
  }

  if (visibleDeptKeys.length === 0) return null;

  // Weekly KPI deadline: managers submit before the current week's payroll.
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
              KPI Calculator &middot; Departments
            </p>
            <h2 className="mt-0.5 text-[15px] font-semibold tracking-tight text-zinc-900 dark:text-zinc-100">
              {isElevated
                ? 'All Departments'
                : visibleDeptKeys.length === 1
                  ? DEPARTMENTS.find((d) => d.key === visibleDeptKeys[0])?.name
                  : 'My Departments'}
            </h2>
            <div className="mt-2">
              <WeekPicker
                value={weekStart}
                weekEnd={weekEnd}
                options={weekOptions}
                currentWeekStart={currentWeekStart}
                onChange={setWeekStart}
              />
            </div>
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

        {/* Filter row (department pills; member search lives per-card) */}
        {visibleDeptKeys.length > 1 && (
          <div className="mt-3 flex flex-wrap items-center gap-2">
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
                    count={state[k]?.members.length ?? 0}
                  />
                ))}
              </div>
            </LayoutGroup>
          </div>
        )}

        {isLiveWeek ? (
          <DeadlineBanner
            weekStart={weekStart}
            weekEnd={weekEnd}
            daysLeft={daysLeft}
            overdue={overdue}
            readyCount={readyCount}
            total={totalDepts}
          />
        ) : (
          <PastWeekBanner
            weekStart={weekStart}
            weekEnd={weekEnd}
            liveWeekStart={currentWeekStart}
            liveWeekEnd={currentWeekStart ? weekEndFromStart(currentWeekStart) : ''}
            onJumpToLive={() => currentWeekStart && setWeekStart(currentWeekStart)}
          />
        )}
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
          const dept = DEPARTMENTS.find((x) => x.key === key);
          const color = deptColor(key);
          const wp = wallpapers[key];
          const readOnly = d ? d.status !== 'draft' : false;
          const total = deptTotal(key, d);
          const open = isOpen(key);
          const common = commonByDept.get(key) ?? [];
          const sharedSet = sharedCommonByDept.get(key);
          const normalCommon = common.filter((b) => !sharedSet?.has(b.id));
          const sharedCommon = common.filter((b) => sharedSet?.has(b.id));
          const allMembers = d?.members ?? [];
          const cq = (cardSearch[key] ?? '').trim().toLowerCase();
          const members = cq
            ? allMembers.filter(
                (e) => e.name.toLowerCase().includes(cq) || e.email.toLowerCase().includes(cq),
              )
            : allMembers;
          // Pagination (per department) -- clamp the page to the filtered set.
          const totalPages = Math.max(1, Math.ceil(members.length / MEMBER_PAGE_SIZE));
          const curPage = Math.min(cardPage[key] ?? 1, totalPages);
          const pageStart = (curPage - 1) * MEMBER_PAGE_SIZE;
          const pagedMembers = members.slice(pageStart, pageStart + MEMBER_PAGE_SIZE);
          const hasAnyBonus =
            common.length > 0 || (individualByDept.get(key)?.size ?? 0) > 0;
          const hasIndividual = (individualByDept.get(key)?.size ?? 0) > 0;

          // Per-column rollups for the table (header tri-state + footer subtotals).
          // Computed over *all* members so the footer reflects the whole dept,
          // independent of the current search/pagination view.
          const isApplicable = (email: string, bonusId: string) =>
            applicableBonuses(key, email).some((x) => x.id === bonusId);
          const colMeta = normalCommon.map((b) => {
            const appMembers = allMembers.filter((m) => isApplicable(m.email, b.id));
            const onCount = appMembers.filter((m) => m.applied[b.id]?.on).length;
            const subtotal = appMembers.reduce(
              (s, m) => s + (m.applied[b.id]?.on ? computeAmount(b, m.applied[b.id]?.vars, usdToPhpRate) : 0),
              0,
            );
            return {
              b,
              appCount: appMembers.length,
              onCount,
              allOn: appMembers.length > 0 && onCount === appMembers.length,
              someOn: onCount > 0 && onCount < appMembers.length,
              subtotal,
            };
          });
          const sharedMeta = sharedCommon.map((b) => {
            const sh = d?.shared?.[b.id];
            const on = !!sh?.on;
            const perPerson = on ? computeAmount(b, sh?.vars, usdToPhpRate) : 0;
            const appCount = allMembers.filter((m) => isApplicable(m.email, b.id)).length;
            return { b, sh, on, perPerson, subtotal: perPerson * appCount };
          });
          const indivSubtotal = allMembers.reduce((s, m) => {
            const ind = applicableBonuses(key, m.email).filter(
              (b) => !common.some((c) => c.id === b.id) && !sharedSet?.has(b.id),
            );
            return (
              s +
              ind.reduce(
                (ss, b) => ss + (m.applied[b.id]?.on ? computeAmount(b, m.applied[b.id]?.vars, usdToPhpRate) : 0),
                0,
              )
            );
          }, 0);

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
                isLiveWeek && !readOnly && daysLeft <= 2 && 'ring-1 ring-amber-400/70 dark:ring-amber-500/40',
              )}
            >
              {/* Header row -- the wallpaper is now a compact thumbnail accent,
                  not a full-bleed hero. The whole row toggles open/closed. */}
              <div className="absolute inset-x-0 top-0 h-1" style={{ backgroundColor: color }} aria-hidden />
              <motion.div
                role="button"
                tabIndex={0}
                aria-expanded={open}
                whileTap={{ scale: 0.994 }}
                onClick={() => setManualOpen((m) => ({ ...m, [key]: !open }))}
                onKeyDown={(ev) => {
                  if (ev.key === 'Enter' || ev.key === ' ') {
                    ev.preventDefault();
                    setManualOpen((m) => ({ ...m, [key]: !open }));
                  }
                }}
                className="relative flex w-full cursor-pointer items-center gap-3 p-3 outline-none sm:gap-3.5 sm:p-3.5"
              >
                {/* Image thumbnail (a portion of the card, not the whole header) */}
                <div className="relative h-16 w-20 shrink-0 overflow-hidden rounded-xl ring-1 ring-black/5 dark:ring-white/10 sm:h-[68px] sm:w-24">
                  <div
                    className="absolute inset-0 bg-cover bg-center group-hover:scale-110"
                    style={{
                      backgroundImage: wp?.url ? `url("${wp.url}")` : fallbackBg(color),
                      backgroundPosition: wp?.position ?? '50% 50%',
                      transitionProperty: 'transform',
                      transitionDuration: '700ms',
                      transitionTimingFunction: 'cubic-bezier(0.22, 1, 0.36, 1)',
                    }}
                    aria-hidden
                  />
                  <div className="absolute inset-0 bg-gradient-to-t from-black/45 to-transparent" aria-hidden />
                  <div className="pointer-events-none absolute inset-0 opacity-[0.12] mix-blend-overlay" style={{ backgroundImage: HERO_NOISE }} aria-hidden />
                  <div className="absolute bottom-1 left-1 flex items-center gap-1 rounded-full bg-black/45 px-1.5 py-0.5 text-white/90 backdrop-blur-sm">
                    <Users className="h-2.5 w-2.5" aria-hidden />
                    <span className="tabular-nums font-mono text-[10px]">{d?.members.length ?? 0}</span>
                  </div>
                </div>

                {/* Title + description */}
                <div className="min-w-0 flex-1">
                  <div className="flex items-center gap-2">
                    <h3 className="truncate text-base font-bold tracking-tight text-zinc-900 dark:text-zinc-100">{dept?.name ?? key}</h3>
                    <HeroBadge status={d?.status ?? 'draft'} warn={isLiveWeek && !readOnly && daysLeft <= 2} />
                    {d?.dirty && (
                      <motion.span
                        className="h-1.5 w-1.5 shrink-0 rounded-full bg-amber-400 shadow-[0_0_6px] shadow-amber-400"
                        title="Unsaved changes"
                        aria-hidden
                        animate={{ opacity: [1, 0.35, 1] }}
                        transition={{ duration: 1.6, repeat: Infinity, ease: 'easeInOut' }}
                      />
                    )}
                  </div>
                  <p className="mt-0.5 line-clamp-1 text-[11px] leading-snug text-zinc-500 dark:text-zinc-400">
                    {DEPT_DESCRIPTION[key] ?? ''}
                  </p>
                </div>

                {/* Projected + chevron */}
                <div className="flex shrink-0 items-center gap-2.5">
                  <div className="text-right">
                    <div className="font-mono text-[8px] uppercase tracking-[0.18em] text-zinc-400">Projected</div>
                    <div className="tabular-nums font-mono text-sm font-bold leading-none text-emerald-600 dark:text-emerald-400">
                      <AnimatedPeso value={total} />
                    </div>
                  </div>
                  <motion.span
                    className="shrink-0 rounded-full bg-zinc-100 p-1 text-zinc-500 dark:bg-zinc-800 dark:text-zinc-300"
                    animate={{ rotate: open ? 180 : 0 }}
                    transition={{ type: 'spring', stiffness: 320, damping: 20 }}
                  >
                    <ChevronDown className="h-4 w-4" aria-hidden />
                  </motion.span>
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
                    transition={{
                      height: { duration: 0.42, ease: EASE },
                      opacity: { duration: 0.22, ease: 'easeOut' },
                    }}
                    style={{ overflow: 'hidden', willChange: 'height' }}
                  >
                    <motion.div
                      className="border-t border-zinc-100 dark:border-zinc-800/70"
                      initial={{ y: -8 }}
                      animate={{ y: 0 }}
                      exit={{ y: -8 }}
                      transition={{ duration: 0.42, ease: EASE }}
                    >
                      {/* Member search + pagination toolbar (standard list controls) */}
                      {d?.loaded && hasAnyBonus && allMembers.length > 0 && (
                        <div className="flex flex-col gap-2 px-2.5 pt-3 sm:flex-row sm:items-center sm:justify-between">
                          <div className="relative min-w-0 flex-1 sm:max-w-xs">
                            <Search className="pointer-events-none absolute left-2.5 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-zinc-400" aria-hidden />
                            <input
                              type="search"
                              placeholder="Search name or email..."
                              value={cardSearch[key] ?? ''}
                              onChange={(e) => {
                                const v = e.target.value;
                                setCardSearch((prev) => ({ ...prev, [key]: v }));
                                setCardPage((prev) => ({ ...prev, [key]: 1 }));
                              }}
                              className="h-8 w-full rounded-md border border-zinc-200 bg-white pl-8 pr-2 text-xs text-zinc-900 outline-none transition-colors focus:border-emerald-400 focus:ring-1 focus:ring-emerald-200 dark:border-zinc-800 dark:bg-zinc-900/60 dark:text-zinc-100"
                            />
                          </div>
                          <div className="flex shrink-0 items-center gap-2 self-end sm:self-auto">
                            <span className="font-mono text-[10px] text-zinc-500">
                              {members.length === 0
                                ? '0 of 0'
                                : `${pageStart + 1}-${Math.min(pageStart + MEMBER_PAGE_SIZE, members.length)} of ${members.length}`}
                              {cq && members.length !== allMembers.length && (
                                <span className="text-zinc-400"> &middot; filtered from {allMembers.length}</span>
                              )}
                            </span>
                            <div className="flex items-center gap-0.5 rounded-md border border-zinc-200 bg-white p-0.5 dark:border-zinc-800 dark:bg-zinc-900/60">
                              <button
                                type="button"
                                className="rounded p-1 text-zinc-600 hover:bg-zinc-100 disabled:cursor-not-allowed disabled:opacity-40 dark:text-zinc-300 dark:hover:bg-zinc-800"
                                disabled={curPage <= 1}
                                onClick={() => setCardPage((prev) => ({ ...prev, [key]: Math.max(1, curPage - 1) }))}
                                aria-label="Previous page"
                              >
                                <ChevronLeft className="h-3.5 w-3.5" />
                              </button>
                              <span className="min-w-[3rem] text-center font-mono text-[10px] tabular-nums text-zinc-600 dark:text-zinc-400">
                                {curPage} / {totalPages}
                              </span>
                              <button
                                type="button"
                                className="rounded p-1 text-zinc-600 hover:bg-zinc-100 disabled:cursor-not-allowed disabled:opacity-40 dark:text-zinc-300 dark:hover:bg-zinc-800"
                                disabled={curPage >= totalPages}
                                onClick={() => setCardPage((prev) => ({ ...prev, [key]: Math.min(totalPages, curPage + 1) }))}
                                aria-label="Next page"
                              >
                                <ChevronRight className="h-3.5 w-3.5" />
                              </button>
                            </div>
                          </div>
                        </div>
                      )}

                      {/* Members */}
                      {!d || !d.loaded ? (
                        <div className="px-3.5 py-5 text-center text-xs text-zinc-400">Loading...</div>
                      ) : !hasAnyBonus ? (
                        <div className="px-3.5 py-6 text-center text-xs text-zinc-400">
                          No bonuses assigned to this department yet.
                          <br />
                          Assign one in Accounting &rarr; Bonus Catalog.
                        </div>
                      ) : members.length === 0 ? (
                        <div className="px-3.5 py-5 text-center text-xs text-zinc-400">
                          {cq ? 'No members match your search.' : 'No team members in this department.'}
                        </div>
                      ) : (
                        <div className="px-2.5 pb-1 pt-2.5">
                          <div className="overflow-x-auto rounded-xl border border-zinc-200/80 dark:border-zinc-800">
                            <table className="table-keep w-full border-collapse text-left">
                              {/* Header: Member · one column per common / team bonus · Total */}
                              <thead>
                                <tr>
                                  <th className="sticky left-0 z-[3] min-w-[148px] border-b border-r border-zinc-200 bg-zinc-50 px-3 py-2 align-bottom dark:border-zinc-800 dark:bg-[#0f141b]">
                                    <span className="font-mono text-[9px] font-semibold uppercase tracking-[0.14em] text-zinc-500">
                                      Member
                                    </span>
                                  </th>

                                  {colMeta.map(({ b, allOn, someOn, onCount, appCount }) => (
                                    <th
                                      key={b.id}
                                      className="min-w-[128px] border-b border-l border-zinc-200/70 bg-zinc-50 px-2.5 py-2 align-bottom dark:border-zinc-800/70 dark:bg-zinc-900/70"
                                    >
                                      <div className="flex flex-col gap-1.5">
                                        <div className="flex items-start justify-between gap-1.5">
                                          <span
                                            className="line-clamp-2 text-[11.5px] font-semibold leading-tight text-zinc-800 dark:text-zinc-100"
                                            title={b.name}
                                          >
                                            {b.name}
                                          </span>
                                          <KindDot kind={b.kind} />
                                        </div>
                                        <BonusCurrencyTag bonus={b} rate={usdToPhpRate} />
                                        <button
                                          type="button"
                                          disabled={readOnly || !d?.loaded || appCount === 0}
                                          onClick={() => applyToAll(key, b.id, !allOn)}
                                          title={allOn ? 'Untick for everyone' : 'Tick for everyone'}
                                          className={cn(
                                            'inline-flex w-fit items-center gap-1 rounded-md border px-1.5 py-0.5 transition-colors disabled:opacity-40',
                                            allOn
                                              ? 'border-emerald-300 bg-emerald-50 text-emerald-700 dark:border-emerald-800/60 dark:bg-emerald-950/40 dark:text-emerald-300'
                                              : someOn
                                                ? 'border-amber-300 bg-amber-50 text-amber-700 dark:border-amber-800/60 dark:bg-amber-950/30 dark:text-amber-300'
                                                : 'border-zinc-200 bg-white text-zinc-500 hover:bg-zinc-50 dark:border-zinc-700 dark:bg-zinc-900 dark:text-zinc-400',
                                          )}
                                        >
                                          <span
                                            className={cn(
                                              'flex h-3 w-3 items-center justify-center rounded-[3px] border',
                                              allOn
                                                ? 'border-emerald-500 bg-emerald-500 text-white'
                                                : someOn
                                                  ? 'border-amber-500 bg-amber-500 text-white'
                                                  : 'border-zinc-300 dark:border-zinc-600',
                                            )}
                                          >
                                            {allOn ? <Check className="h-2 w-2" strokeWidth={3.5} /> : someOn ? <Minus className="h-2 w-2" strokeWidth={3.5} /> : null}
                                          </span>
                                          <span className="font-mono text-[9px] font-semibold tabular-nums">
                                            {onCount}/{appCount}
                                          </span>
                                        </button>
                                      </div>
                                    </th>
                                  ))}

                                  {sharedMeta.map(({ b, sh, on, perPerson }) => {
                                    const vars = bonusVariables(b);
                                    return (
                                      <th
                                        key={b.id}
                                        className="min-w-[144px] border-b border-l border-violet-200/70 bg-violet-50/70 px-2.5 py-2 align-bottom dark:border-violet-900/50 dark:bg-violet-950/25"
                                      >
                                        <div className="flex flex-col gap-1.5">
                                          <label className="flex items-start gap-1.5">
                                            <input
                                              type="checkbox"
                                              className="mt-0.5 h-3.5 w-3.5 shrink-0 rounded accent-violet-600"
                                              disabled={readOnly}
                                              checked={on}
                                              onChange={(ev) => toggleShared(key, b.id, ev.target.checked)}
                                            />
                                            <span
                                              className="line-clamp-2 text-[11.5px] font-semibold leading-tight text-zinc-800 dark:text-zinc-100"
                                              title={b.name}
                                            >
                                              {b.name}
                                            </span>
                                          </label>
                                          <span className="inline-flex w-fit items-center gap-0.5 rounded bg-violet-100 px-1 py-0.5 font-mono text-[8px] font-semibold uppercase tracking-wide text-violet-700 dark:bg-violet-950/60 dark:text-violet-300">
                                            <Users className="h-2 w-2" /> Team · {peso(perPerson)}/ea
                                          </span>
                                          <BonusCurrencyTag bonus={b} rate={usdToPhpRate} />
                                          {on && b.kind === 'formula' && vars.length > 0 && (
                                            <div className="flex flex-wrap gap-1">
                                              {vars.map((v) => (
                                                <label key={v} className="flex items-center gap-1">
                                                  <span className="font-mono text-[9px] text-zinc-400">{v}</span>
                                                  <Input
                                                    type="number"
                                                    inputMode="decimal"
                                                    aria-label={`${v} for the whole team`}
                                                    disabled={readOnly}
                                                    value={sh?.vars?.[v] ?? ''}
                                                    onChange={(ev) => setSharedVar(key, b.id, v, ev.target.value)}
                                                    className="h-6 w-14 px-1 text-center text-[11px] tabular-nums"
                                                  />
                                                </label>
                                              ))}
                                            </div>
                                          )}
                                        </div>
                                      </th>
                                    );
                                  })}

                                  {hasIndividual && (
                                    <th className="min-w-[150px] border-b border-l border-zinc-200/70 bg-zinc-50 px-2.5 py-2 align-bottom dark:border-zinc-800/70 dark:bg-zinc-900/70">
                                      <span className="inline-flex items-center gap-1 font-mono text-[9px] font-semibold uppercase tracking-[0.14em] text-zinc-500">
                                        <User className="h-2.5 w-2.5" /> Individual
                                      </span>
                                    </th>
                                  )}

                                  <th className="sticky right-0 z-[3] min-w-[96px] border-b border-l border-zinc-200 bg-zinc-50 px-3 py-2 text-right align-bottom dark:border-zinc-800 dark:bg-[#0f141b]">
                                    <span className="font-mono text-[9px] font-semibold uppercase tracking-[0.14em] text-zinc-500">
                                      Total
                                    </span>
                                  </th>
                                </tr>
                              </thead>

                              <motion.tbody
                                initial="hidden"
                                animate="show"
                                variants={{ show: { transition: { staggerChildren: 0.02, delayChildren: 0.04 } } }}
                              >
                                {pagedMembers.map((m) => {
                                  const appl = applicableBonuses(key, m.email);
                                  const applSet = new Set(appl.map((b) => b.id));
                                  const mIndividual = appl.filter(
                                    (b) => !common.some((c) => c.id === b.id) && !sharedSet?.has(b.id),
                                  );
                                  const mTotal = memberTotal(key, m, d.shared);
                                  return (
                                    <motion.tr
                                      key={m.email}
                                      variants={{ hidden: { opacity: 0, y: 4 }, show: { opacity: 1, y: 0 } }}
                                      className="group/row border-b border-zinc-100 last:border-0 hover:bg-emerald-50/40 dark:border-zinc-800/60 dark:hover:bg-emerald-950/10"
                                    >
                                      {/* Member (sticky) */}
                                      <td className="sticky left-0 z-[2] border-r border-zinc-200/80 bg-white px-3 py-2 align-top group-hover/row:bg-emerald-50/40 dark:border-zinc-800 dark:bg-[#11161c] dark:group-hover/row:bg-emerald-950/20">
                                        <div className="flex items-center gap-2">
                                          <span
                                            className="flex h-6 w-6 shrink-0 items-center justify-center rounded-full text-[9px] font-bold"
                                            style={{ backgroundColor: hexA(color, 0.16), color }}
                                            aria-hidden
                                          >
                                            {initials(m.name)}
                                          </span>
                                          <span
                                            className="min-w-0 truncate text-[12px] font-medium text-zinc-800 dark:text-zinc-100"
                                            title={m.name}
                                          >
                                            {m.name}
                                          </span>
                                        </div>
                                      </td>

                                      {/* Common bonus cells */}
                                      {colMeta.map(({ b }) => {
                                        const applicable = applSet.has(b.id);
                                        const st = m.applied[b.id];
                                        const on = !!st?.on;
                                        const vars = bonusVariables(b);
                                        const amt = applicable && on ? computeAmount(b, st?.vars, usdToPhpRate) : 0;
                                        return (
                                          <td key={b.id} className="border-l border-zinc-100 px-2.5 py-2 align-top dark:border-zinc-800/50">
                                            {!applicable ? (
                                              <span className="font-mono text-[11px] text-zinc-300 dark:text-zinc-700">—</span>
                                            ) : (
                                              <div className="flex flex-col gap-1">
                                                <label className="flex items-center gap-1.5">
                                                  <input
                                                    type="checkbox"
                                                    className="h-3.5 w-3.5 shrink-0 rounded accent-emerald-600"
                                                    disabled={readOnly}
                                                    checked={on}
                                                    onChange={(ev) => toggleBonus(key, m.email, b.id, ev.target.checked)}
                                                  />
                                                  <span
                                                    className={cn(
                                                      'font-mono text-[11px] tabular-nums',
                                                      amt > 0 ? 'text-emerald-600 dark:text-emerald-400' : 'text-zinc-400 dark:text-zinc-600',
                                                    )}
                                                  >
                                                    {on ? peso(amt) : '—'}
                                                  </span>
                                                </label>
                                                {on && b.kind === 'formula' && vars.length > 0 && (
                                                  <div className="flex flex-wrap gap-1 pl-5">
                                                    {vars.map((v) => (
                                                      <label key={v} className="flex items-center gap-0.5">
                                                        <span className="font-mono text-[9px] text-zinc-400">{v}</span>
                                                        <Input
                                                          type="number"
                                                          inputMode="decimal"
                                                          aria-label={`${v} for ${m.name}`}
                                                          disabled={readOnly}
                                                          value={st?.vars?.[v] ?? ''}
                                                          onChange={(ev) => setVar(key, m.email, b.id, v, ev.target.value)}
                                                          className="h-6 w-14 px-1 text-center text-[11px] tabular-nums"
                                                        />
                                                      </label>
                                                    ))}
                                                  </div>
                                                )}
                                              </div>
                                            )}
                                          </td>
                                        );
                                      })}

                                      {/* Team bonus cells (entered once in the header; read-only per person) */}
                                      {sharedMeta.map(({ b, on, perPerson }) => {
                                        const applicable = applSet.has(b.id);
                                        const amt = applicable && on ? perPerson : 0;
                                        return (
                                          <td
                                            key={b.id}
                                            className="border-l border-violet-100/70 bg-violet-50/20 px-2.5 py-2 align-top dark:border-violet-900/30 dark:bg-violet-950/10"
                                          >
                                            {!applicable ? (
                                              <span className="font-mono text-[11px] text-zinc-300 dark:text-zinc-700">—</span>
                                            ) : (
                                              <span
                                                className={cn(
                                                  'font-mono text-[11px] tabular-nums',
                                                  amt > 0 ? 'text-emerald-600 dark:text-emerald-400' : 'text-zinc-400 dark:text-zinc-600',
                                                )}
                                              >
                                                {on ? peso(amt) : '—'}
                                              </span>
                                            )}
                                          </td>
                                        );
                                      })}

                                      {/* Individual bonuses for this member */}
                                      {hasIndividual && (
                                        <td className="border-l border-zinc-100 px-2.5 py-2 align-top dark:border-zinc-800/50">
                                          {mIndividual.length === 0 ? (
                                            <span className="font-mono text-[11px] text-zinc-300 dark:text-zinc-700">—</span>
                                          ) : (
                                            <div className="flex flex-col gap-1.5">
                                              {mIndividual.map((b) => {
                                                const st = m.applied[b.id];
                                                const on = !!st?.on;
                                                const vars = bonusVariables(b);
                                                const amt = on ? computeAmount(b, st?.vars, usdToPhpRate) : 0;
                                                return (
                                                  <div key={b.id} className="flex flex-col gap-0.5">
                                                    <label className="flex items-center gap-1.5">
                                                      <input
                                                        type="checkbox"
                                                        className="h-3.5 w-3.5 shrink-0 rounded accent-violet-600"
                                                        disabled={readOnly}
                                                        checked={on}
                                                        onChange={(ev) => toggleBonus(key, m.email, b.id, ev.target.checked)}
                                                      />
                                                      <span className="min-w-0 truncate text-[11px] text-zinc-600 dark:text-zinc-300" title={b.name}>
                                                        {b.name}
                                                      </span>
                                                      <BonusCurrencyTag bonus={b} rate={usdToPhpRate} />
                                                      <span
                                                        className={cn(
                                                          'ml-auto shrink-0 font-mono text-[11px] tabular-nums',
                                                          amt > 0 ? 'text-emerald-600 dark:text-emerald-400' : 'text-zinc-400 dark:text-zinc-600',
                                                        )}
                                                      >
                                                        {on ? peso(amt) : '—'}
                                                      </span>
                                                    </label>
                                                    {on && b.kind === 'formula' && vars.length > 0 && (
                                                      <div className="flex flex-wrap gap-1 pl-5">
                                                        {vars.map((v) => (
                                                          <label key={v} className="flex items-center gap-0.5">
                                                            <span className="font-mono text-[9px] text-zinc-400">{v}</span>
                                                            <Input
                                                              type="number"
                                                              inputMode="decimal"
                                                              aria-label={`${v} for ${m.name}`}
                                                              disabled={readOnly}
                                                              value={st?.vars?.[v] ?? ''}
                                                              onChange={(ev) => setVar(key, m.email, b.id, v, ev.target.value)}
                                                              className="h-6 w-14 px-1 text-center text-[11px] tabular-nums"
                                                            />
                                                          </label>
                                                        ))}
                                                      </div>
                                                    )}
                                                  </div>
                                                );
                                              })}
                                            </div>
                                          )}
                                        </td>
                                      )}

                                      {/* Member total (sticky) */}
                                      <td className="sticky right-0 z-[2] border-l border-zinc-200/80 bg-white px-3 py-2 text-right align-top group-hover/row:bg-emerald-50/40 dark:border-zinc-800 dark:bg-[#11161c] dark:group-hover/row:bg-emerald-950/20">
                                        <span
                                          className={cn(
                                            'font-mono text-[12px] font-bold tabular-nums',
                                            mTotal > 0 ? 'text-emerald-600 dark:text-emerald-400' : 'text-zinc-400 dark:text-zinc-600',
                                          )}
                                        >
                                          <AnimatedPeso value={mTotal} />
                                        </span>
                                      </td>
                                    </motion.tr>
                                  );
                                })}
                              </motion.tbody>

                              {/* Footer: per-column subtotals + dept grand total */}
                              <tfoot>
                                <tr>
                                  <td className="sticky left-0 z-[2] border-r border-t border-zinc-200 bg-zinc-50 px-3 py-2 dark:border-zinc-800 dark:bg-[#0f141b]">
                                    <span className="font-mono text-[9px] font-semibold uppercase tracking-[0.14em] text-zinc-500">
                                      Totals
                                    </span>
                                  </td>
                                  {colMeta.map(({ b, subtotal, onCount }) => (
                                    <td key={b.id} className="border-l border-t border-zinc-200/70 bg-zinc-50/60 px-2.5 py-2 dark:border-zinc-800/70 dark:bg-zinc-900/50">
                                      <div className="flex flex-col">
                                        <span
                                          className={cn(
                                            'font-mono text-[11px] font-semibold tabular-nums',
                                            subtotal > 0 ? 'text-emerald-600 dark:text-emerald-400' : 'text-zinc-400 dark:text-zinc-600',
                                          )}
                                        >
                                          {peso(subtotal)}
                                        </span>
                                        <span className="font-mono text-[9px] text-zinc-400">{onCount} applied</span>
                                      </div>
                                    </td>
                                  ))}
                                  {sharedMeta.map(({ b, subtotal }) => (
                                    <td key={b.id} className="border-l border-t border-violet-200/60 bg-violet-50/40 px-2.5 py-2 dark:border-violet-900/40 dark:bg-violet-950/20">
                                      <span
                                        className={cn(
                                          'font-mono text-[11px] font-semibold tabular-nums',
                                          subtotal > 0 ? 'text-emerald-600 dark:text-emerald-400' : 'text-zinc-400 dark:text-zinc-600',
                                        )}
                                      >
                                        {peso(subtotal)}
                                      </span>
                                    </td>
                                  ))}
                                  {hasIndividual && (
                                    <td className="border-l border-t border-zinc-200/70 bg-zinc-50/60 px-2.5 py-2 dark:border-zinc-800/70 dark:bg-zinc-900/50">
                                      <span
                                        className={cn(
                                          'font-mono text-[11px] font-semibold tabular-nums',
                                          indivSubtotal > 0 ? 'text-emerald-600 dark:text-emerald-400' : 'text-zinc-400 dark:text-zinc-600',
                                        )}
                                      >
                                        {peso(indivSubtotal)}
                                      </span>
                                    </td>
                                  )}
                                  <td className="sticky right-0 z-[2] border-l border-t border-zinc-200 bg-zinc-50 px-3 py-2 text-right dark:border-zinc-800 dark:bg-[#0f141b]">
                                    <span className="font-mono text-[12px] font-extrabold tabular-nums text-emerald-600 dark:text-emerald-400">
                                      <AnimatedPeso value={total} />
                                    </span>
                                  </td>
                                </tr>
                              </tfoot>
                            </table>
                          </div>
                        </div>
                      )}

                      {/* Footer */}
                      <div className="flex items-center justify-between gap-2 border-t border-zinc-100 px-3.5 py-2.5 dark:border-zinc-800/70">
                        <span
                          className={cn(
                            'font-mono text-[10px] uppercase tracking-wide',
                            readOnly ? 'text-emerald-500' : d?.dirty ? 'text-amber-600 dark:text-amber-400' : 'text-zinc-400',
                          )}
                        >
                          {readOnly ? 'Sent to Accounting' : d?.dirty ? 'Unsaved changes' : 'Saved -- not yet submitted'}
                        </span>
                        <div className="flex items-center gap-2">
                          {readOnly ? (
                            <Button size="sm" variant="outline" className="h-7 gap-1.5 text-xs" onClick={() => void setStatus(key, 'draft')}>
                              <RefreshCw className="h-3.5 w-3.5" /> Reopen
                            </Button>
                          ) : (
                            <>
                              <Button size="sm" variant="outline" className="h-7 gap-1.5 text-xs" disabled={d?.saving} onClick={() => void saveDept(key)}>
                                <Save className="h-3.5 w-3.5" /> {d?.saving ? 'Saving...' : 'Save'}
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
                    </motion.div>
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

// -- Bits -----------------------------------------------------------------------

/** Sky chip flagging a USD-denominated bonus. For a flat bonus it shows the
 *  native "$X"; for a formula it shows "USD" (the result varies with inputs).
 *  The peso figures in the grid are the FX-converted amounts that get paid; this
 *  chip explains why a "$50" library bonus appears as a peso total. Renders
 *  nothing for PHP bonuses so the common case stays uncluttered. */
function BonusCurrencyTag({ bonus, rate }: { bonus: BonusDef; rate: number }) {
  if ((bonus.currency ?? 'PHP') !== 'USD') return null;
  const label =
    bonus.kind === 'flat'
      ? `${CURRENCY_SYMBOL.USD}${nativeFlatAmount(bonus).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`
      : 'USD';
  return (
    <span
      className="inline-flex w-fit items-center gap-0.5 rounded bg-sky-100 px-1 py-0.5 font-mono text-[8px] font-semibold uppercase tracking-wide text-sky-700 dark:bg-sky-950/60 dark:text-sky-300"
      title={`USD bonus — paid in PHP, converted at ${PESO}${rate.toLocaleString('en-PH', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}/$1`}
    >
      {label}
    </span>
  );
}

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

/** Compact flat/formula indicator for a bonus column header. */
function KindDot({ kind }: { kind: BonusDef['kind'] }) {
  return (
    <span
      className={cn(
        'shrink-0 rounded px-1 py-0.5 font-mono text-[8px] font-semibold uppercase tracking-wide',
        kind === 'flat'
          ? 'bg-emerald-100 text-emerald-700 dark:bg-emerald-950/60 dark:text-emerald-300'
          : 'bg-blue-100 text-blue-700 dark:bg-blue-950/60 dark:text-blue-300',
      )}
      title={kind === 'flat' ? 'Flat amount' : 'Formula bonus'}
    >
      {kind === 'flat' ? 'flat' : 'ƒ(x)'}
    </span>
  );
}

/** "Live" pulse pill — marks the week accounting is currently dispatching. */
function LiveBadge() {
  return (
    <span className="inline-flex shrink-0 items-center gap-1 rounded-full bg-emerald-100 px-1.5 py-0.5 font-mono text-[8px] font-semibold uppercase tracking-wide text-emerald-700 dark:bg-emerald-950/50 dark:text-emerald-300">
      <span className="relative flex h-1.5 w-1.5">
        <span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-emerald-400 opacity-75" />
        <span className="relative inline-flex h-1.5 w-1.5 rounded-full bg-emerald-500" />
      </span>
      Live
    </span>
  );
}

/** Format a Mon–Sun week as "Jun 9 – Jun 15". */
function fmtWeek(startIso: string, endIso: string): string {
  if (!startIso) return '—';
  const [sy, sm, sd] = startIso.split('-').map(Number);
  const s = new Date(sy!, sm! - 1, sd!);
  const sL = s.toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
  if (!endIso) return `${sL}, ${sy}`;
  const [ey, em, ed] = endIso.split('-').map(Number);
  const e = new Date(ey!, em! - 1, ed!);
  const eL = e.toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
  return `${sL} – ${eL}`;
}

/**
 * Week navigator: prev/next arrows step through uploaded Hubstaff weeks and a
 * dropdown lists them all, marking the live (currently-dispatched) week and
 * offering a one-tap jump back to it.
 */
function WeekPicker({
  value,
  weekEnd,
  options,
  currentWeekStart,
  onChange,
}: {
  value: string;
  weekEnd: string;
  options: { start: string; end: string }[];
  currentWeekStart: string | null;
  onChange: (start: string) => void;
}) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement | null>(null);
  useEffect(() => {
    if (!open) return;
    const onDoc = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setOpen(false);
    };
    document.addEventListener('mousedown', onDoc);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('mousedown', onDoc);
      document.removeEventListener('keydown', onKey);
    };
  }, [open]);

  // options are sorted newest-first, so a higher index is an older week.
  const idx = options.findIndex((o) => o.start === value);
  const isLive = currentWeekStart != null && value === currentWeekStart;
  const hasOlder = idx >= 0 && idx < options.length - 1;
  const hasNewer = idx > 0;

  return (
    <div ref={ref} className="relative inline-flex items-center gap-1">
      <button
        type="button"
        aria-label="Older week"
        disabled={!hasOlder}
        onClick={() => hasOlder && onChange(options[idx + 1]!.start)}
        className="rounded-md border border-zinc-200 bg-white p-1 text-zinc-500 transition-colors hover:bg-zinc-50 disabled:cursor-not-allowed disabled:opacity-40 dark:border-zinc-800 dark:bg-zinc-900/60 dark:text-zinc-400 dark:hover:bg-zinc-800"
      >
        <ChevronLeft className="h-3.5 w-3.5" />
      </button>

      <button
        type="button"
        onClick={() => setOpen((o) => !o)}
        aria-expanded={open}
        className="inline-flex items-center gap-2 rounded-lg border border-zinc-200 bg-white px-2.5 py-1.5 text-left transition-colors hover:bg-zinc-50 dark:border-zinc-800 dark:bg-zinc-900/60 dark:hover:bg-zinc-800/70"
      >
        <CalendarDays className="h-3.5 w-3.5 text-zinc-400" />
        <span className="text-[12.5px] font-semibold tracking-tight text-zinc-800 dark:text-zinc-100">
          {fmtWeek(value, weekEnd)}
        </span>
        {isLive ? (
          <LiveBadge />
        ) : (
          <span className="rounded-full bg-zinc-100 px-1.5 py-0.5 font-mono text-[8px] font-semibold uppercase tracking-wide text-zinc-500 dark:bg-zinc-800 dark:text-zinc-400">
            Past
          </span>
        )}
        <ChevronDown className={cn('h-3.5 w-3.5 text-zinc-400 transition-transform', open && 'rotate-180')} />
      </button>

      <button
        type="button"
        aria-label="Newer week"
        disabled={!hasNewer}
        onClick={() => hasNewer && onChange(options[idx - 1]!.start)}
        className="rounded-md border border-zinc-200 bg-white p-1 text-zinc-500 transition-colors hover:bg-zinc-50 disabled:cursor-not-allowed disabled:opacity-40 dark:border-zinc-800 dark:bg-zinc-900/60 dark:text-zinc-400 dark:hover:bg-zinc-800"
      >
        <ChevronRight className="h-3.5 w-3.5" />
      </button>

      <AnimatePresence>
        {open && (
          <motion.div
            initial={{ opacity: 0, y: -6, scale: 0.98 }}
            animate={{ opacity: 1, y: 0, scale: 1 }}
            exit={{ opacity: 0, y: -6, scale: 0.98 }}
            transition={{ duration: 0.16, ease: EASE }}
            className="absolute left-9 top-full z-30 mt-1.5 w-64 overflow-hidden rounded-xl border border-zinc-200 bg-white shadow-xl dark:border-zinc-800 dark:bg-zinc-950"
          >
            <div className="flex items-center justify-between border-b border-zinc-100 px-3 py-2 dark:border-zinc-800">
              <span className="font-mono text-[9px] font-semibold uppercase tracking-[0.16em] text-zinc-500">
                Pay weeks
              </span>
              {currentWeekStart && !isLive && (
                <button
                  type="button"
                  onClick={() => {
                    onChange(currentWeekStart);
                    setOpen(false);
                  }}
                  className="inline-flex items-center gap-1 rounded-full bg-emerald-50 px-1.5 py-0.5 font-mono text-[9px] font-semibold uppercase tracking-wide text-emerald-700 transition-colors hover:bg-emerald-100 dark:bg-emerald-950/40 dark:text-emerald-300 dark:hover:bg-emerald-950/70"
                >
                  <Zap className="h-2.5 w-2.5" /> Jump to live
                </button>
              )}
            </div>
            <ul className="max-h-72 overflow-y-auto py-1">
              {options.length === 0 ? (
                <li className="px-3 py-3 text-center text-[11px] text-zinc-400">No uploaded weeks yet.</li>
              ) : (
                options.map((o) => {
                  const selected = o.start === value;
                  const live = currentWeekStart != null && o.start === currentWeekStart;
                  return (
                    <li key={o.start}>
                      <button
                        type="button"
                        onClick={() => {
                          onChange(o.start);
                          setOpen(false);
                        }}
                        className={cn(
                          'flex w-full items-center gap-2 px-3 py-1.5 text-left text-[12px] transition-colors',
                          selected ? 'bg-emerald-50/70 dark:bg-emerald-950/30' : 'hover:bg-zinc-50 dark:hover:bg-zinc-900',
                        )}
                      >
                        <span
                          className={cn(
                            'flex h-3.5 w-3.5 shrink-0 items-center justify-center',
                            selected ? 'text-emerald-600 dark:text-emerald-400' : 'text-transparent',
                          )}
                        >
                          <Check className="h-3.5 w-3.5" strokeWidth={3} />
                        </span>
                        <span
                          className={cn(
                            'flex-1 tabular-nums',
                            selected ? 'font-semibold text-zinc-900 dark:text-zinc-100' : 'text-zinc-600 dark:text-zinc-300',
                          )}
                        >
                          {fmtWeek(o.start, o.end)}
                        </span>
                        {live && <LiveBadge />}
                      </button>
                    </li>
                  );
                })
              )}
            </ul>
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  );
}

/** Shown in place of the deadline banner while viewing a non-live (past) week. */
function PastWeekBanner({
  weekStart,
  weekEnd,
  liveWeekStart,
  liveWeekEnd,
  onJumpToLive,
}: {
  weekStart: string;
  weekEnd: string;
  liveWeekStart: string | null;
  liveWeekEnd: string;
  onJumpToLive: () => void;
}) {
  return (
    <div className="mt-3 flex flex-wrap items-center gap-x-3 gap-y-1 rounded-xl border border-indigo-300/70 bg-indigo-50 px-3 py-2 text-xs text-indigo-900 dark:border-indigo-800/60 dark:bg-indigo-950/40 dark:text-indigo-200">
      <CalendarDays className="h-4 w-4 shrink-0" aria-hidden />
      <span className="font-semibold">Viewing the week of {fmtWeek(weekStart, weekEnd)}.</span>
      <span className="opacity-80">
        Not the current payroll week{liveWeekStart ? ` (${fmtWeek(liveWeekStart, liveWeekEnd)})` : ''} — edits here apply to this past period.
      </span>
      {liveWeekStart && (
        <button
          type="button"
          onClick={onJumpToLive}
          className="ml-auto inline-flex items-center gap-1 rounded-full bg-white/80 px-2 py-0.5 font-mono text-[10px] font-semibold uppercase tracking-wide text-indigo-700 transition-colors hover:bg-white dark:bg-black/30 dark:text-indigo-200 dark:hover:bg-black/50"
        >
          <Zap className="h-3 w-3" /> Jump to live
        </button>
      )}
    </div>
  );
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
        Week {fmt(weekStart)} &ndash; {fmt(weekEnd)} &middot; feeds this week&rsquo;s payroll{done ? '' : ` · ${countdown}`}
      </span>
      <span className="ml-auto rounded-full bg-white/70 px-2 py-0.5 font-mono text-[10px] font-semibold dark:bg-black/30">
        {readyCount}/{total} ready
      </span>
    </div>
  );
}

function HeroBadge({ status, warn }: { status: BonusStatus; warn?: boolean }) {
  const map: Record<BonusStatus, { label: string; cls: string; icon?: React.ReactNode }> = {
    draft: warn
      ? { label: 'Action needed', cls: 'bg-amber-100 text-amber-700 ring-1 ring-amber-300/70 dark:bg-amber-950/50 dark:text-amber-300 dark:ring-amber-700/50', icon: <AlertTriangle className="h-3 w-3" /> }
      : { label: 'Draft', cls: 'bg-zinc-100 text-zinc-500 dark:bg-zinc-800 dark:text-zinc-400', icon: <Sparkles className="h-3 w-3" /> },
    ready: { label: 'Ready', cls: 'bg-emerald-100 text-emerald-700 dark:bg-emerald-950/50 dark:text-emerald-300', icon: <CheckCircle2 className="h-3 w-3" /> },
    locked: { label: 'Locked', cls: 'bg-amber-100 text-amber-700 dark:bg-amber-950/50 dark:text-amber-300', icon: <Lock className="h-3 w-3" /> },
  };
  const s = map[status];
  return (
    <span
      className={cn(
        'inline-flex shrink-0 items-center gap-1 rounded-full px-2 py-0.5 text-[9px] font-semibold uppercase tracking-wide',
        s.cls,
      )}
    >
      {s.icon}
      {s.label}
    </span>
  );
}
