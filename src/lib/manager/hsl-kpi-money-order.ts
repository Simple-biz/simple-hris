/**
 * The SERVER half of My Team's HSL KPI Rankings: one HSL sub-team's KPI Calculator
 * scores (`hsl_bonus_entries`), ranked by the bonus the Payroll Wizard pays.
 * Doc: `docs/features/manager-hsl-kpi-rankings.md`.
 *
 * Kane, 2026-09-28: *"My Team - HR, QC, and some others that have KPI Bonus dont have
 * the rankings and the view modal performance please add them"* → HSL. The Payment
 * Catalog boards' rules hold here unchanged (`manager-pm-rankings.md`): the order is the
 * bonus, and no peso leaves the server. What differs is the SHAPE of an HSL row:
 *
 * - **ONE amount per person-week.** `calculated_bonus` is the whole card — every code
 *   rule and every Library bonus folded together (`catalog-bonus.ts`). There is no
 *   per-KPI amount, so "All bonuses" is the ONLY order (`allOnly`). The KPIs label the
 *   breakdown under each name; none can be ranked on its own bonus.
 * - **The KPIs come from `kpi_data`**, classified by {@link classifyHslKpiKey}: a code
 *   key by its rule (live, then retired — `hslRuleForKey`), a Library key
 *   (`catalog:<bonusId>:<Var>`) by its formula, through the same `isCountVariable` the
 *   catalog boards use. Formulas carry the pay RATES, so they stay here.
 * - **A KPI is keyed by its NAME.** The same item scored before and after a branch's
 *   Library cutover (Attestation's "Attested Cases": code rule, then Library variable)
 *   reads as one item; differently named ones stay apart ("Signed Rep Docs" ≠ "Signups").
 *   Display only: the order is the stored amount either way.
 *
 * PURE (no I/O) so `node:test` walks it, but **server-only by contract**: a source-scan
 * test fails if any file under `src/components` or `app/` (outside `app/api`) imports it.
 */
import { normEmail } from '@/lib/email/norm-email';
import { weekEndFromStart } from '@/lib/payroll/manila-week';
import { HSL_DEPTS, type HslDeptKey } from '@/lib/hsl-bonus/schema';
import { hslRuleForKey } from '@/lib/hsl-bonus/retired-rules';
import { HSL_CATALOG_KPI_PREFIX, catalogInputLabel } from '@/lib/hsl-bonus/catalog-bonus';
import { badgeWeeks, type ApptStatusRow, type LockSettingRow } from '@/lib/manager/appointment-rankings';
import { isCountVariable, type KpiData, type MoneyWeek, type MoneyWeekRow } from '@/lib/manager/deliverable-money-order';
import { kpiCount, type DeliverableMetricInfo, type DeliverableWeek } from '@/lib/manager/deliverable-rankings';

/** An `hsl_bonus_entries` row as the server reads it — WITH the stored amount. Never serialized. */
export type HslEntryMoneyRow = {
  period_start: string;
  period_end: string | null;
  period_type: string | null;
  employee_email: string | null;
  kpi_data: Record<string, unknown> | null;
  calculated_bonus: number | string | null;
};

/** A Library bonus behind a `catalog:<id>:<Var>` key. Server-only: `formula` holds the rates. */
export interface HslCatalogDef {
  id: string;
  kind: string | null;
  formula: string | null;
}

export type HslKpiClass = { kind: 'count' | 'hidden'; label: string } | { kind: 'skip' };

/**
 * What one `kpi_data` key is on `branch`'s card.
 *
 * - **count** (shown): a `per_unit` or `tiered` code rule — its value is items — or a
 *   Library variable whose formula multiplies it by a rate (`isCountVariable`).
 * - **hidden** (order-only, the value never leaves): a `manual` code rule, whose typed
 *   value IS pesos (Medical Records' RFC), and a Library variable the count check cannot
 *   read (`+(RFC)`, `(BBB + Referral_Leads) * 250`, an unreadable or fixed bonus). Fails
 *   closed, exactly as the catalog boards do.
 * - **skip** (not a KPI): a flat checkbox, a team split / pool, a Library bonus's on/off
 *   flag, and any key no rule explains (`sub_team`, Managers Weekly's bespoke bands).
 */
export function classifyHslKpiKey(
  branch: string,
  key: string,
  catalog: ReadonlyMap<string, HslCatalogDef>,
): HslKpiClass {
  if (key.startsWith(HSL_CATALOG_KPI_PREFIX)) {
    const rest = key.slice(HSL_CATALOG_KPI_PREFIX.length);
    const sep = rest.indexOf(':');
    if (sep < 0) return { kind: 'skip' };
    const variable = rest.slice(sep + 1);
    const label = catalogInputLabel(key);
    if (!variable || !label) return { kind: 'skip' };
    const def = catalog.get(rest.slice(0, sep));
    const count = !!def && def.kind !== 'fixed' && isCountVariable(def.formula, variable);
    return { kind: count ? 'count' : 'hidden', label };
  }
  const found = hslRuleForKey(branch, key, HSL_DEPTS[branch as HslDeptKey]?.rules);
  if (!found) return { kind: 'skip' };
  const { rule } = found;
  if (rule.type === 'per_unit' || rule.type === 'tiered') return { kind: 'count', label: rule.label };
  if (rule.type === 'manual') return { kind: 'hidden', label: rule.label };
  return { kind: 'skip' };
}

/** A KPI's key: its name, so the same item before and after a Library cutover is one. */
function metricKeyOf(label: string): string {
  return label.trim().toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_+|_+$/g, '') || 'kpi';
}

function pesos(v: unknown): number {
  const n = typeof v === 'string' ? Number(v) : typeof v === 'number' ? v : 0;
  return Number.isFinite(n) ? n : 0;
}

/**
 * Raw HSL rows → badged weeks of KPI counts plus each row's stored amount, through the
 * shared `badgeWeeks` (same Draft / With Accounting / Finalized ladder — HSL's statuses
 * live in the same `hsl_bonus_period_status` table).
 *
 * - **Weekly rows only.** A monthly period (Collections, Healthcare TL, SSD's monthly
 *   half) is not a week's KPI. Measured 2026-09-28: every branch with a board has only
 *   weekly rows.
 * - **Every saved row is an entry** on All, even one with no KPI item (a row whose
 *   amount came from a checkbox). A saved 0 is ranked. **No entry ≠ 0** per KPI: a key
 *   the row does not carry, or carries blank, is no entry.
 * - **Available when at least one KPI item exists.** A branch whose rows carry none
 *   (SSD: only its sub-team; Managers Weekly: bespoke bands) gets no board — the order
 *   alone would be a pay ranking with nothing beside it.
 * - A KPI is **shown** only when every key scoring it is a count.
 */
export function buildHslKpiData(input: {
  entries: readonly HslEntryMoneyRow[];
  statuses: readonly ApptStatusRow[] | null;
  locks: readonly LockSettingRow[] | null;
  currentWeekStart: string;
  branch: string;
  catalog: readonly HslCatalogDef[];
}): KpiData {
  const catalog = new Map(input.catalog.map((d) => [d.id, d]));
  const classes = new Map<string, HslKpiClass>();
  const classOf = (key: string): HslKpiClass => {
    let c = classes.get(key);
    if (!c) {
      c = classifyHslKpiKey(input.branch, key, catalog);
      classes.set(key, c);
    }
    return c;
  };

  const byWeek = new Map<string, { periodEnd: string; byEmail: Map<string, MoneyWeekRow> }>();
  const labels = new Map<string, { label: string; week: string }>();
  const orderOnly = new Set<string>();
  for (const r of input.entries) {
    if (r.period_type !== 'weekly') continue;
    const email = normEmail(r.employee_email);
    if (!email) continue;
    let week = byWeek.get(r.period_start);
    if (!week) {
      week = { periodEnd: r.period_end || weekEndFromStart(r.period_start), byEmail: new Map() };
      byWeek.set(r.period_start, week);
    }
    // One row per (branch, week, email) by the table's key; a second address for the
    // same person is merged later by the roster, like every other board.
    const out = week.byEmail.get(email) ?? { email, counts: {}, money: {}, total: 0 };
    out.total = (out.total ?? 0) + pesos(r.calculated_bonus);
    for (const [key, raw] of Object.entries(r.kpi_data ?? {})) {
      const c = classOf(key);
      if (c.kind === 'skip') continue;
      if (raw === null || raw === '' || typeof raw === 'boolean' || typeof raw === 'object') continue;
      const metric = metricKeyOf(c.label);
      if (c.kind === 'hidden') orderOnly.add(metric);
      out.counts[metric] = (out.counts[metric] ?? 0) + kpiCount(raw);
      const prev = labels.get(metric);
      if (!prev || r.period_start > prev.week) labels.set(metric, { label: c.label, week: r.period_start });
    }
    week.byEmail.set(email, out);
  }

  if (labels.size === 0) {
    return { available: false, servedBy: null, weeks: [], moneyWeeks: [], metrics: [], skippedRows: 0 };
  }

  const scored = new Map<string, { periodEnd: string; rows: MoneyWeekRow[] }>();
  for (const [periodStart, w] of byWeek) {
    scored.set(periodStart, {
      periodEnd: w.periodEnd,
      rows: [...w.byEmail.values()].sort((a, b) => a.email.localeCompare(b.email)),
    });
  }
  const moneyWeeks: MoneyWeek[] = badgeWeeks({ ...input, scored });
  const weeks: DeliverableWeek[] = moneyWeeks.map((w) => ({
    periodStart: w.periodStart,
    periodEnd: w.periodEnd,
    badge: w.badge,
    rows: w.rows.map((r) => {
      const counts: Record<string, number> = {};
      const hidden: string[] = [];
      for (const [k, n] of Object.entries(r.counts)) {
        if (orderOnly.has(k)) hidden.push(k);
        else counts[k] = n;
      }
      return hidden.length > 0 ? { email: r.email, counts, hidden: hidden.sort() } : { email: r.email, counts };
    }),
  }));
  const metrics: DeliverableMetricInfo[] = [...labels.entries()]
    .map(([key, { label }]) => ({ key, label, shown: !orderOnly.has(key), team: false }))
    .sort((a, b) => a.label.localeCompare(b.label, undefined, { sensitivity: 'base' }) || a.key.localeCompare(b.key));
  return { available: true, servedBy: null, weeks, moneyWeeks, metrics, skippedRows: 0, allOnly: true };
}
