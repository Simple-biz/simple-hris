/**
 * STRICTLY READ-ONLY. No insert / update / delete / upsert.
 *
 * Two questions, before `filing_specialist`'s Attested Cases bands move from
 * 30/40/50 to 20/30/40 (Kane's ruling, 2026-09-22):
 *
 *   1. Which SAVED `hsl_bonus_entries` rows would score differently under the new
 *      bands, and what is the status of the period they sit in? A saved
 *      `calculated_bonus` is FROZEN at save time — the wizard dispatches the
 *      stored value — so a band change does NOT reach a row that is already on
 *      disk. That is the same shape the 2026-07-27 attestation correction hit,
 *      where 11 stale rows had to be recalculated by a separate --apply script
 *      (memory `hsl-kpi-calculator-2026-07-changes`). A `locked` period is NEVER
 *      a candidate for that (`payroll-rule-changes-forward-only`).
 *
 *   2. Has the "Filing Team" Bonus Library assignment — the duplicate programme
 *      that prompted the ruling — actually been SCORED on anyone? Its inputs live
 *      in `kpi_data` under `catalog:<bonusId>…`, and its amount is folded into the
 *      same `calculated_bonus`. A row carrying BOTH a code-rule value and a
 *      catalog value for the same work has been paid twice.
 *
 * Both answers are printed, nothing is written, and the row-level detail is
 * dumped to disk so a later --apply has a before-image to diff against.
 *
 *   npx tsx scripts/probe-filing-attested-tier-change.mts
 */
import { createClient } from '@supabase/supabase-js';
import dotenv from 'dotenv';
import fs from 'node:fs';
import path from 'node:path';

dotenv.config({ path: '.env.local' });
dotenv.config();

const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
if (!url || !key) {
  console.error('Missing NEXT_PUBLIC_SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY in .env.local');
  process.exit(1);
}
const db = createClient(url, key, { auth: { persistSession: false } });

/** PostgREST truncates at 1000 rows even with .range() — always page. */
async function selectAllPaged<T>(
  table: string,
  columns: string,
  refine: (q: any) => any = (q) => q,
): Promise<T[]> {
  const PAGE = 1000;
  const out: T[] = [];
  for (let from = 0; ; from += PAGE) {
    const { data, error } = await refine(db.from(table).select(columns)).range(from, from + PAGE - 1);
    if (error) throw new Error(`${table}: ${error.message}`);
    const rows = (data ?? []) as T[];
    out.push(...rows);
    if (rows.length < PAGE) return out;
  }
}

const OLD_TIERS = [
  { min: 0, max: 29, rate: 0 },
  { min: 30, max: 39, rate: 50 },
  { min: 40, max: 49, rate: 75 },
  { min: 50, max: null as number | null, rate: 100 },
];
const NEW_TIERS = [
  { min: 0, max: 19, rate: 0 },
  { min: 20, max: 29, rate: 50 },
  { min: 30, max: 39, rate: 75 },
  { min: 40, max: null as number | null, rate: 100 },
];
/** Mirrors `calcBonus`'s tiered branch exactly: whole count × the landed rate. */
const tiered = (tiers: typeof OLD_TIERS, n: number) => {
  const band = tiers.find((t) => n >= t.min && (t.max === null || n <= t.max));
  return band ? n * band.rate : 0;
};

type Entry = {
  employee_email: string;
  employee_name: string | null;
  department: string;
  period_start: string;
  calculated_bonus: number | null;
  kpi_data: Record<string, unknown> | null;
};
type Status = { department: string; period_start: string; status: string | null };

async function main() {
  // ── 1. saved filing_specialist rows ────────────────────────────────────────
  const entries = await selectAllPaged<Entry>(
    'hsl_bonus_entries',
    'employee_email, employee_name, department, period_start, calculated_bonus, kpi_data',
    (q) => q.eq('department', 'filing_specialist'),
  );
  const statuses = await selectAllPaged<Status>(
    'hsl_bonus_period_status',
    'department, period_start, status',
    (q) => q.eq('department', 'filing_specialist'),
  );
  const statusOf = new Map(statuses.map((s) => [s.period_start, s.status ?? 'draft']));

  console.log(`\nfiling_specialist — ${entries.length} saved rows across ${new Set(entries.map((e) => e.period_start)).size} weeks`);
  console.log(`periods: ${statuses.map((s) => `${s.period_start}=${s.status ?? 'draft'}`).sort().join(' · ') || '(none)'}`);

  const drift = entries
    .map((e) => {
      const n = Number(e.kpi_data?.attested_cases ?? 0) || 0;
      const before = tiered(OLD_TIERS, n);
      const after = tiered(NEW_TIERS, n);
      return { e, n, before, after, delta: after - before, status: statusOf.get(e.period_start) ?? 'draft' };
    })
    .filter((r) => r.delta !== 0);

  console.log(`\nrows whose Attested Cases term CHANGES under the new bands: ${drift.length}`);
  const byStatus = new Map<string, { rows: number; delta: number }>();
  for (const r of drift) {
    const cur = byStatus.get(r.status) ?? { rows: 0, delta: 0 };
    cur.rows += 1;
    cur.delta += r.delta;
    byStatus.set(r.status, cur);
  }
  for (const [status, v] of [...byStatus].sort()) {
    console.log(`  ${status.padEnd(8)} ${String(v.rows).padStart(4)} rows  ₱${v.delta.toLocaleString('en-PH')}`);
  }
  for (const r of drift.slice(0, 25)) {
    console.log(
      `   ${r.e.period_start} ${r.status.padEnd(7)} ${r.e.employee_email.padEnd(28)} ` +
        `${String(r.n).padStart(3)} cases  ₱${r.before} -> ₱${r.after}  (${r.delta > 0 ? '+' : ''}${r.delta})`,
    );
  }
  if (drift.length > 25) console.log(`   … ${drift.length - 25} more (full list in the dump)`);

  // ── 2. the "Filing Team" Library assignment, and whether it has been scored ──
  const bonuses = await selectAllPaged<{ id: string; name: string; kind: string; formula: string | null; currency: string | null }>(
    'bonus_catalog_bonuses',
    'id, name, kind, formula, currency',
  );
  const assignments = await selectAllPaged<{ id: string; bonus_id: string; scope: string; department_key: string; employee_email: string | null }>(
    'bonus_catalog_assignments',
    'id, bonus_id, scope, department_key, employee_email',
  );
  const hslAssign = assignments.filter((a) => (a.department_key ?? '').toLowerCase().startsWith('hsl:'));
  const nameOf = new Map(bonuses.map((b) => [b.id, b.name]));

  console.log(`\nBonus Library assignments on an hsl:<sub> branch: ${hslAssign.length}`);
  for (const a of hslAssign) {
    console.log(`   ${a.department_key.padEnd(28)} ${(nameOf.get(a.bonus_id) ?? '(unknown bonus)').padEnd(24)} scope=${a.scope}${a.employee_email ? ` (${a.employee_email})` : ''}  id=${a.id}`);
  }

  const hslBonusIds = new Set(hslAssign.map((a) => a.bonus_id));
  const allEntries = await selectAllPaged<Entry>(
    'hsl_bonus_entries',
    'employee_email, employee_name, department, period_start, calculated_bonus, kpi_data',
  );
  const scored = allEntries.filter((e) =>
    Object.entries(e.kpi_data ?? {}).some(([k, v]) => {
      if (!k.startsWith('catalog:')) return false;
      const id = k.slice('catalog:'.length).split(':')[0];
      return hslBonusIds.has(id) && v !== 0 && v !== false && v != null;
    }),
  );
  console.log(`\nsaved rows carrying a NON-EMPTY catalog: key for one of those bonuses: ${scored.length}`);
  for (const e of scored.slice(0, 25)) {
    const keys = Object.entries(e.kpi_data ?? {}).filter(([k]) => k.startsWith('catalog:'));
    console.log(`   ${e.period_start} ${e.department.padEnd(20)} ${e.employee_email.padEnd(28)} ₱${e.calculated_bonus ?? 0}  ${JSON.stringify(Object.fromEntries(keys))}`);
  }

  // ── 3. before-image on disk, so a later --apply has something to diff ───────
  const dir = path.join('references', 'backups');
  fs.mkdirSync(dir, { recursive: true });
  const stamp = new Date().toISOString().slice(0, 10);
  const out = path.join(dir, `${stamp}-filing-attested-tier-change.json`);
  fs.writeFileSync(
    out,
    JSON.stringify(
      {
        measuredAt: new Date().toISOString(),
        oldTiers: OLD_TIERS,
        newTiers: NEW_TIERS,
        filingPeriods: statuses,
        filingEntries: entries,
        driftRows: drift.map((r) => ({ ...r.e, cases: r.n, before: r.before, after: r.after, delta: r.delta, status: r.status })),
        hslAssignments: hslAssign.map((a) => ({ ...a, bonusName: nameOf.get(a.bonus_id) ?? null })),
        catalogScoredRows: scored,
      },
      null,
      2,
    ),
  );
  console.log(`\nbefore-image written: ${out}`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
