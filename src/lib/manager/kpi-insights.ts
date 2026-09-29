/**
 * Manager → KPI Calculator → Departments AND → HSL Branches: the three insight
 * cards above each grid. Doc: `docs/features/kpi-calculator-insights.md`.
 *
 * Pure. The routes (`app/api/manager/kpi-insights/route.ts` for Departments,
 * `…/kpi-insights/hsl/route.ts` for HSL) read the rows and hand them here; the
 * component draws what comes back. The two calculators differ only in the scope
 * gate and in which table holds the money — `bonus_catalog_applied.amount` or
 * `hsl_bonus_entries.calculated_bonus`, each the stored PHP the Payroll Wizard
 * pays. Nothing in this file reads a clock, a session or a table, so every rule
 * below is unit-tested.
 *
 * Three rules carry the feature, and each one has a wrong reading that looks fine:
 *
 * 1. **"Sent to Accounting" is a STATUS, not a save.** A dept-week counts as sent
 *    only when its `hsl_bonus_period_status` row is `ready` or `locked`, the
 *    transition that notifies Accounting (`kpi.published`) and the state the Payroll
 *    Wizard pays. Saved-but-draft rows are `pending`. Summing every saved row would
 *    turn the trend into a projection and it would stop matching what Accounting received.
 * 2. **A week with no saved row has NO point.** That is the absence of a
 *    measurement, not ₱0, and the line breaks there (the rule
 *    `memory/cycle-success-trend-chart.md` set for the Diagnostics chart). A week that
 *    has rows but sent nothing IS a measurement, of ₱0.
 * 3. **One person, two departments, one week ⇒ SUM** (`memory/kpi-one-person-two-departments.md`).
 *    The top earner is ranked on the person's weekly total across every scoped department.
 */

import { MANAGER_BONUS_DEPT_KEYS, isKpiCalculatorDeptKey } from '@/lib/payroll/department-bonus';
import { normalizeDeptToKey } from '@/lib/payroll/normalize-dept-key';
import { slugifyDeptKey } from '@/lib/departments/registry';
import { normEmail } from '@/lib/email/norm-email';
import { HSL_DEPTS, HSL_DEPT_KEYS, type HslDeptKey } from '@/lib/hsl-bonus/schema';

/** How many Sunday weeks the trend and the department averages cover. */
export const INSIGHT_WEEKS = 12;

/** Ceiling on requested department keys. The grid tops out near 20. */
export const MAX_INSIGHT_DEPTS = 40;

/** Ceiling on tied top earners returned. A flat common bonus can tie a whole
 *  department; the card picks one at random, so it needs only a pool. */
export const MAX_TIED_TOP = 25;

const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;
const DEPT_KEY = /^[a-z0-9_]{1,64}$/;

// -- Dates ---------------------------------------------------------------------

function utc(iso: string): Date {
  const [y, m, d] = iso.split('-').map(Number);
  return new Date(Date.UTC(y!, m! - 1, d!));
}

/** A real calendar date in `YYYY-MM-DD` that falls on a Sunday. Every stored KPI
 *  week is keyed on the Hubstaff upload's Sunday; anything else is a caller bug. */
export function isSundayIso(v: string | null | undefined): v is string {
  if (!v || !ISO_DATE.test(v)) return false;
  const dt = utc(v);
  return dt.toISOString().slice(0, 10) === v && dt.getUTCDay() === 0;
}

export function shiftWeeks(iso: string, weeks: number): string {
  const dt = utc(iso);
  dt.setUTCDate(dt.getUTCDate() + weeks * 7);
  return dt.toISOString().slice(0, 10);
}

/** `count` consecutive Sundays ending at `through`, OLDEST FIRST (a time axis
 *  runs left to right). */
export function trendWindow(through: string, count: number = INSIGHT_WEEKS): string[] {
  const out: string[] = [];
  for (let i = count - 1; i >= 0; i--) out.push(shiftWeeks(through, -i));
  return out;
}

// -- Scope ---------------------------------------------------------------------

/** Who is asking, resolved server-side exactly as `/api/manager/department-members`
 *  resolves it: assignments scope everyone who has them, even an elevated caller;
 *  only an elevated caller with NO assignments sees every department. */
export type InsightScope = { kind: 'elevated' } | { kind: 'department'; managed: readonly string[] };

/**
 * The requested department keys this caller may read, in request order, deduped.
 *
 * The client sends the keys on its grid; that proves nothing. Each one is re-matched
 * here against the caller's own assignments, using the two keys the calculator itself
 * derives from a grant string: the built-in payroll key (`"PM Team"` → `pm_team`) and,
 * for an in-app department, the slug of its label (`"Executive Assistants"` →
 * `executive_assistants`). Namespaced `hsl:*` grants are HSL access keys, never a
 * department on this grid. Retired calculator keys are refused, as on the grid.
 */
export function scopeInsightDeptKeys(requested: readonly string[], scope: InsightScope): string[] {
  const allowed = new Set<string>();
  if (scope.kind === 'elevated') {
    for (const k of MANAGER_BONUS_DEPT_KEYS) allowed.add(k);
  } else {
    for (const raw of scope.managed) {
      const m = (raw ?? '').trim();
      if (!m || m.includes(':')) continue;
      const builtIn = normalizeDeptToKey(m);
      if (builtIn) {
        if (MANAGER_BONUS_DEPT_KEYS.includes(builtIn)) allowed.add(builtIn);
        continue;
      }
      const slug = slugifyDeptKey(m);
      if (slug && isKpiCalculatorDeptKey(slug)) allowed.add(slug);
    }
  }
  const out: string[] = [];
  const seen = new Set<string>();
  for (const raw of requested) {
    const k = (raw ?? '').trim();
    if (!DEPT_KEY.test(k) || seen.has(k) || !allowed.has(k)) continue;
    seen.add(k);
    out.push(k);
    if (out.length >= MAX_INSIGHT_DEPTS) break;
  }
  return out;
}

/** Is `key` an HSL branch that SCORES — a code team that is not roster-only
 *  (`noKpi`), or a data sub-team stored under HSL right now? A data key that
 *  collides with a code key is the code team (`hslBranchConfigs` drops the data
 *  copy), so a `noKpi` team cannot be reopened through one. */
function isLiveScoringHslBranch(key: string, dataBranchKeys: ReadonlySet<string>): boolean {
  if ((HSL_DEPT_KEYS as readonly string[]).includes(key)) return !HSL_DEPTS[key as HslDeptKey].noKpi;
  return dataBranchKeys.has(key);
}

/**
 * The requested HSL branch keys this caller may read, in request order, deduped:
 * the HSL Branches calculator's own gate, re-derived on the server.
 *
 * That calculator lists a branch only on an EXPLICIT `hsl:<key>` grant
 * (`canAccessHslDept(managed, k, false)` in `ManagerApp`). An elevated or admin
 * role does not unlock it, and neither does the parent HSL assignment, so there
 * is no elevated arm here, unlike {@link scopeInsightDeptKeys}. A granted key must
 * also be a live scoring branch. A retired key (`case_manager`) or an unknown one
 * resolves nothing, even with the grant still on file, and a roster-only `noKpi`
 * team has no bonus to average.
 */
export function scopeHslInsightBranchKeys(
  requested: readonly string[],
  managed: readonly string[],
  dataBranchKeys: readonly string[],
): string[] {
  const data = new Set(dataBranchKeys);
  const allowed = new Set<string>();
  for (const raw of managed) {
    // `canAccessHslDept` compares lowercased; so does this.
    const m = (raw ?? '').trim().toLowerCase();
    if (!m.startsWith('hsl:')) continue;
    const key = m.slice(4);
    if (DEPT_KEY.test(key) && isLiveScoringHslBranch(key, data)) allowed.add(key);
  }
  const out: string[] = [];
  const seen = new Set<string>();
  for (const raw of requested) {
    const k = (raw ?? '').trim();
    if (!DEPT_KEY.test(k) || seen.has(k) || !allowed.has(k)) continue;
    seen.add(k);
    out.push(k);
    if (out.length >= MAX_INSIGHT_DEPTS) break;
  }
  return out;
}

// -- Aggregation ---------------------------------------------------------------

export interface InsightAppliedRow {
  department: string;
  period_start: string;
  employee_email: string | null;
  employee_name: string | null;
  /** Stored PHP — what the Payroll Wizard pays (`bonus-catalog.md` §3). */
  amount: number | string | null;
}

export interface InsightStatusRow {
  department: string;
  period_start: string;
  status: string | null;
}

export interface TrendWeek {
  weekStart: string;
  /** Any saved row at all. `false` ⇒ no point on the chart. */
  measured: boolean;
  /** PHP in dept-weeks that are ready/locked. */
  sent: number;
  /** PHP saved in dept-weeks that are still draft (or have no status row). */
  pending: number;
  /** Departments whose week is ready/locked — including a ready week with no
   *  saved rows (a ₱0 submission). */
  sentDepts: number;
  /** Departments with saved rows that are not sent. The rest of the set, neither
   *  sent nor pending, has not been scored at all. */
  pendingDepts: number;
  /** Distinct people with a non-zero sent total. */
  sentPeople: number;
}

export interface DeptAverage {
  dept: string;
  /** Weeks in the window this department SENT. The average's denominator. */
  weeksSent: number;
  totalSent: number;
  /** `totalSent / weeksSent`; 0 when nothing was sent. */
  avgWeekly: number;
  /** `totalSent / Σ people paid across those weeks` — the average person's week. */
  avgPerPerson: number;
  /** One value per window week, oldest first: the sent total, or null when the
   *  department did not send that week. */
  series: (number | null)[];
}

export interface TopEarner {
  /** Normalized email, or `name:<lowercased name>` for a row keyed on a name. */
  key: string;
  name: string;
  email: string | null;
  amount: number;
  depts: string[];
  /** Every department this person was paid through that week has been sent. */
  sent: boolean;
}

export interface WeekSpotlight {
  weekStart: string;
  /** People with a non-zero saved total that week. */
  peoplePaid: number;
  /** Σ of those people's totals — with `peoplePaid`, the week's average bonus. */
  weekTotal: number;
  topAmount: number;
  /** The highest total BELOW `topAmount` (0 when nobody is below it). */
  runnerUpAmount: number;
  /** Everyone tied at `topAmount` (capped at {@link MAX_TIED_TOP}), name order. */
  top: TopEarner[];
  /** How many people tie at the top, before the cap. */
  tiedCount: number;
}

export interface KpiInsights {
  weeks: TrendWeek[];
  depts: DeptAverage[];
  spotlight: WeekSpotlight;
}

/** `GET /api/manager/kpi-insights` — cached RAW by the card (paint only). */
export interface KpiInsightsResponse {
  /** The department keys actually read: the request, minus anything out of scope. */
  depts: string[];
  /** The newest week any of them SENT; the trend ends here. Null = never sent. */
  through: string | null;
  insights: KpiInsights | null;
  error: string | null;
}

/** Money is summed in centavos so twelve weeks of ₱0.10s cannot drift. */
function centavos(v: number | string | null | undefined): number {
  const n = typeof v === 'string' ? Number(v) : v;
  return typeof n === 'number' && Number.isFinite(n) ? Math.round(n * 100) : 0;
}
const pesos = (c: number): number => c / 100;

export function isSentStatus(status: string | null | undefined): boolean {
  return status === 'ready' || status === 'locked';
}

function personKey(r: InsightAppliedRow): string | null {
  const email = normEmail(r.employee_email);
  if (email) return email;
  const name = (r.employee_name ?? '').trim().toLowerCase();
  return name ? `name:${name}` : null;
}

/**
 * Build all three cards' data.
 *
 * `applied` must already be scoped to the caller's departments and to the window
 * weeks plus `selectedWeek`; rows outside both are ignored rather than trusted.
 */
export function buildKpiInsights(input: {
  weeks: readonly string[];
  depts: readonly string[];
  selectedWeek: string;
  applied: readonly InsightAppliedRow[];
  statuses: readonly InsightStatusRow[];
}): KpiInsights {
  const deptSet = new Set(input.depts);
  const weekIndex = new Map(input.weeks.map((w, i) => [w, i]));
  const sentKeys = new Set<string>();
  for (const s of input.statuses) {
    if (deptSet.has(s.department) && isSentStatus(s.status)) sentKeys.add(`${s.department}::${s.period_start}`);
  }

  // (dept, week) → per-person centavos. One pass; everything else derives from it.
  const cells = new Map<string, Map<string, { c: number; name: string; email: string | null }>>();
  for (const r of input.applied) {
    if (!deptSet.has(r.department)) continue;
    if (!weekIndex.has(r.period_start) && r.period_start !== input.selectedWeek) continue;
    const who = personKey(r);
    if (!who) continue;
    const cellKey = `${r.department}::${r.period_start}`;
    let people = cells.get(cellKey);
    if (!people) {
      people = new Map();
      cells.set(cellKey, people);
    }
    const prev = people.get(who);
    const name = (r.employee_name ?? '').trim();
    if (prev) {
      prev.c += centavos(r.amount);
      if (!prev.name && name) prev.name = name;
    } else {
      people.set(who, { c: centavos(r.amount), name, email: normEmail(r.employee_email) });
    }
  }

  // -- Trend ------------------------------------------------------------------
  const weeks: TrendWeek[] = input.weeks.map((w) => {
    let measured = false;
    let sentC = 0;
    let pendingC = 0;
    let sentDepts = 0;
    let pendingDepts = 0;
    const paid = new Map<string, number>();
    for (const d of input.depts) {
      const sent = sentKeys.has(`${d}::${w}`);
      // Sent is the STATUS. A ready status over zero saved rows is a submission
      // of ₱0, counted as sent here exactly as the averages below count it —
      // never as "not scored at all". It adds nothing to `sent` and does not
      // make the week `measured`: a point still needs a saved row.
      if (sent) sentDepts += 1;
      const people = cells.get(`${d}::${w}`);
      if (!people || people.size === 0) continue;
      measured = true;
      let deptC = 0;
      for (const p of people.values()) deptC += p.c;
      if (sent) {
        sentC += deptC;
        for (const [who, p] of people) paid.set(who, (paid.get(who) ?? 0) + p.c);
      } else {
        pendingC += deptC;
        pendingDepts += 1;
      }
    }
    let sentPeople = 0;
    for (const c of paid.values()) if (c !== 0) sentPeople += 1;
    return { weekStart: w, measured, sent: pesos(sentC), pending: pesos(pendingC), sentDepts, pendingDepts, sentPeople };
  });

  // -- Department averages ----------------------------------------------------
  const depts: DeptAverage[] = input.depts.map((d) => {
    let totalC = 0;
    let weeksSent = 0;
    let personWeeks = 0;
    const series = input.weeks.map((w) => {
      if (!sentKeys.has(`${d}::${w}`)) return null;
      const people = cells.get(`${d}::${w}`);
      // A ready status over zero saved rows is a submission of nothing: the
      // department sent ₱0 that week, and it still counts as a week sent.
      let c = 0;
      if (people) {
        for (const p of people.values()) {
          c += p.c;
          if (p.c !== 0) personWeeks += 1;
        }
      }
      totalC += c;
      weeksSent += 1;
      return pesos(c);
    });
    return {
      dept: d,
      weeksSent,
      totalSent: pesos(totalC),
      avgWeekly: weeksSent > 0 ? Math.round(totalC / weeksSent) / 100 : 0,
      avgPerPerson: personWeeks > 0 ? Math.round(totalC / personWeeks) / 100 : 0,
      series,
    };
  });

  // -- Top earner for the selected week (saved rows, drafts included) ---------
  const people = new Map<string, { c: number; name: string; email: string | null; depts: string[]; sent: boolean }>();
  for (const d of input.depts) {
    const cell = cells.get(`${d}::${input.selectedWeek}`);
    if (!cell) continue;
    const deptSent = sentKeys.has(`${d}::${input.selectedWeek}`);
    for (const [who, p] of cell) {
      if (p.c === 0) continue;
      const cur = people.get(who);
      if (cur) {
        cur.c += p.c;
        cur.depts.push(d);
        cur.sent = cur.sent && deptSent;
        if (!cur.name && p.name) cur.name = p.name;
      } else {
        people.set(who, { c: p.c, name: p.name, email: p.email, depts: [d], sent: deptSent });
      }
    }
  }
  let topC = 0;
  let peoplePaid = 0;
  let weekC = 0;
  for (const p of people.values()) {
    if (p.c <= 0) continue;
    peoplePaid += 1;
    weekC += p.c;
    if (p.c > topC) topC = p.c;
  }
  let runnerC = 0;
  for (const p of people.values()) if (p.c > runnerC && p.c < topC) runnerC = p.c;
  const tied: TopEarner[] = [];
  if (topC > 0) {
    for (const [key, p] of people) {
      if (p.c !== topC) continue;
      tied.push({
        key,
        name: p.name || (p.email ?? key.replace(/^name:/, '')),
        email: p.email,
        amount: pesos(p.c),
        depts: p.depts,
        sent: p.sent,
      });
    }
  }
  tied.sort((a, b) => a.name.localeCompare(b.name, 'en', { sensitivity: 'base' }) || a.key.localeCompare(b.key));

  return {
    weeks,
    depts,
    spotlight: {
      weekStart: input.selectedWeek,
      peoplePaid,
      weekTotal: pesos(weekC),
      topAmount: pesos(topC),
      runnerUpAmount: pesos(runnerC),
      top: tied.slice(0, MAX_TIED_TOP),
      tiedCount: tied.length,
    },
  };
}

// -- Drawing helpers (pure, used by the chart) -------------------------------------

export interface XY {
  x: number;
  y: number;
}

/**
 * Split a series into runs of CONSECUTIVE measured weeks. A gap is never bridged:
 * no segment runs into, out of or across a week with no measurement.
 */
export function toRuns<T>(values: readonly (T | null)[]): { start: number; items: T[] }[] {
  const runs: { start: number; items: T[] }[] = [];
  let cur: { start: number; items: T[] } | null = null;
  values.forEach((v, i) => {
    if (v === null) {
      cur = null;
      return;
    }
    if (!cur) {
      cur = { start: i, items: [] };
      runs.push(cur);
    }
    cur.items.push(v);
  });
  return runs;
}

/**
 * Monotone cubic path through `pts` (Steffen, 1990 — the tangents d3's
 * `curveMonotoneX` uses). Smooth, and it **never overshoots**: between two weeks
 * the curve stays inside the pair's own range, so it cannot dip below ₱0 or peak
 * above a week that never happened. That is the reason this is not the Catmull-Rom
 * in `src/components/ceo/financial-chart.tsx`, which overshoots after a sharp drop.
 *
 * One point → a bare `M`; two → a straight segment. X must be strictly increasing.
 */
export function monotonePath(pts: readonly XY[]): string {
  const n = pts.length;
  if (n === 0) return '';
  const f = (v: number) => (Math.round(v * 100) / 100).toString();
  const first = pts[0]!;
  if (n === 1) return `M${f(first.x)},${f(first.y)}`;
  if (n === 2) return `M${f(first.x)},${f(first.y)}L${f(pts[1]!.x)},${f(pts[1]!.y)}`;

  const sign = (v: number) => (v > 0 ? 1 : v < 0 ? -1 : 0);
  const h: number[] = [];
  const s: number[] = [];
  for (let i = 0; i < n - 1; i++) {
    const dx = pts[i + 1]!.x - pts[i]!.x;
    h.push(dx);
    s.push(dx === 0 ? 0 : (pts[i + 1]!.y - pts[i]!.y) / dx);
  }
  const m: number[] = new Array(n).fill(0);
  for (let i = 1; i < n - 1; i++) {
    const p = (s[i - 1]! * h[i]! + s[i]! * h[i - 1]!) / (h[i - 1]! + h[i]!);
    m[i] = (sign(s[i - 1]!) + sign(s[i]!)) * Math.min(Math.abs(s[i - 1]!), Math.abs(s[i]!), 0.5 * Math.abs(p)) || 0;
  }
  m[0] = h[0] ? (3 * s[0]! - m[1]!) / 2 : m[1]!;
  m[n - 1] = h[n - 2] ? (3 * s[n - 2]! - m[n - 2]!) / 2 : m[n - 2]!;
  // The one-sided end tangents can flip sign on a sharp turn; clamp them into the
  // end segment's own direction so the first and last spans stay monotone too.
  if (sign(m[0]!) !== sign(s[0]!)) m[0] = 0;
  else if (Math.abs(m[0]!) > 3 * Math.abs(s[0]!)) m[0] = 3 * s[0]!;
  if (sign(m[n - 1]!) !== sign(s[n - 2]!)) m[n - 1] = 0;
  else if (Math.abs(m[n - 1]!) > 3 * Math.abs(s[n - 2]!)) m[n - 1] = 3 * s[n - 2]!;

  let d = `M${f(first.x)},${f(first.y)}`;
  for (let i = 0; i < n - 1; i++) {
    const a = pts[i]!;
    const b = pts[i + 1]!;
    const dx = h[i]! / 3;
    d += `C${f(a.x + dx)},${f(a.y + dx * m[i]!)},${f(b.x - dx)},${f(b.y - dx * m[i + 1]!)},${f(b.x)},${f(b.y)}`;
  }
  return d;
}

/**
 * A zero-based axis for `max`: a tidy step (1 / 2 / 2.5 / 3 / 4 / 5 × 10ⁿ) and a
 * top that is the first step at or above `max`, aiming for about `target`
 * intervals. Zero-based on purpose — the trend is an AREA, and an area encodes
 * its value as the distance from ₱0 (the licence the Diagnostics chart took to
 * float its floor was for a line with no fill).
 *
 * Rounding the CEILING alone (1 / 2 / 5) left ~40% of the plot empty above a
 * ₱1.2M peak (axis to ₱2M); stepping first keeps the line in the plot.
 */
export function niceTicks(max: number, target = 4): { top: number; step: number; ticks: number[] } {
  if (!(max > 0)) return { top: 1, step: 0.25, ticks: [0, 0.25, 0.5, 0.75, 1] };
  const raw = max / target;
  const base = Math.pow(10, Math.floor(Math.log10(raw)));
  const f = raw / base;
  const nf = [1, 2, 2.5, 3, 4, 5, 10].find((c) => f <= c + 1e-9) ?? 10;
  const step = nf * base;
  const top = Math.ceil(max / step - 1e-9) * step;
  const ticks: number[] = [];
  for (let v = 0; v <= top + step / 2; v += step) ticks.push(Math.round(v * 100) / 100);
  return { top, step, ticks };
}

/** Axis / chip peso label: ₱1.2M · ₱350k · ₱4.5k · ₱900. */
export function compactPeso(v: number): string {
  const n = Math.abs(v);
  const sgn = v < 0 ? '-' : '';
  const t = (x: number) => (Math.round(x * 10) / 10).toString();
  if (n >= 1_000_000) return `${sgn}₱${t(n / 1_000_000)}M`;
  if (n >= 1_000) return `${sgn}₱${t(n / 1_000)}k`;
  return `${sgn}₱${Math.round(n)}`;
}
