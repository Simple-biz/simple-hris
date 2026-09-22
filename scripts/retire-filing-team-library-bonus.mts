/**
 * Retire the "Filing Team" Bonus Library assignment on `hsl:filing_specialist`.
 *
 * READ-ONLY by default. Pass `--apply` to write. Backup-first, always.
 *
 * WHY. Kane authored the Filing Specialist pay rule as a Library formula and
 * assigned it to the branch, which re-expressed the department's four code rules
 * a SECOND time — `scoreEntry` returns `calcBonus(...) + calcHslCatalogTotal(...)`
 * with no dedupe, so a manager filling both sets of boxes pays every unit twice.
 * Kane ruled 2026-09-22: the formula's Attested Cases bands move into
 * `schema.ts` (done, with tests) and this assignment goes, so the programme
 * exists once.
 *
 * WHAT IT TOUCHES, and nothing else:
 *   1. `bonus_catalog_assignments` — the ONE row `hsl:filing_specialist` ->
 *      "Filing Team". The bonus DEFINITION is left alone: it is still a valid
 *      Library bonus that an accountant may assign elsewhere.
 *   2. `hsl_bonus_entries.kpi_data` — the orphaned `catalog:<bonusId>*` keys that
 *      assignment left behind. `withoutCatalogKeys` exists to do this and is
 *      **never called from anywhere** (verified 2026-09-22), so without this the
 *      keys survive forever and would come back to life if the same bonus id were
 *      ever re-assigned to this branch.
 *
 * WHAT IT REFUSES. A `catalog:` key currently worth more than ₱0 is NOT stripped —
 * that would cut someone's bonus on a week they may already have been scored for.
 * The script aborts and names the rows instead. Locked periods are never touched.
 *
 *   npx tsx scripts/retire-filing-team-library-bonus.mts           # report only
 *   npx tsx scripts/retire-filing-team-library-bonus.mts --apply   # write
 */
import { createClient } from '@supabase/supabase-js';
import dotenv from 'dotenv';
import fs from 'node:fs';
import path from 'node:path';
import * as catalogBonusNs from '../src/lib/hsl-bonus/catalog-bonus';

// tsx loads this module through CJS interop, where the named exports land under
// `.default` and a direct named import silently reads `undefined`. That is not a
// cosmetic problem: an undefined prefix makes `k.startsWith(prefix)` match NOTHING,
// so the script reports "0 rows to clean" and sweeps nothing — a false all-clear on
// a money path. Resolve both shapes, then REFUSE to run if it still is not there.
const catalogBonus = ((catalogBonusNs as any).HSL_CATALOG_KPI_PREFIX
  ? catalogBonusNs
  : (catalogBonusNs as any).default) as typeof catalogBonusNs;
if (typeof catalogBonus?.HSL_CATALOG_KPI_PREFIX !== 'string' || !catalogBonus.HSL_CATALOG_KPI_PREFIX) {
  console.error('catalog-bonus.ts did not load its named exports. REFUSING to run: an undefined');
  console.error('prefix matches no key, which would report a clean sweep having checked nothing.');
  process.exit(5);
}
if (typeof catalogBonus.calcHslCatalogBonus !== 'function') {
  console.error('calcHslCatalogBonus did not load. REFUSING to run — the money guard would never fire.');
  process.exit(5);
}
import type { BonusDef } from '../src/lib/bonus-catalog/types';

dotenv.config({ path: '.env.local' });
dotenv.config();

const APPLY = process.argv.includes('--apply');
const BRANCH = 'hsl:filing_specialist';
const BONUS_NAME = 'Filing Team';

const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
if (!url || !key) {
  console.error('Missing NEXT_PUBLIC_SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY in .env.local');
  process.exit(1);
}
const db = createClient(url, key, { auth: { persistSession: false } });

/** PostgREST truncates at 1000 rows even with .range() — always page. */
async function selectAllPaged<T>(table: string, columns: string, refine: (q: any) => any = (q) => q): Promise<T[]> {
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

type Entry = {
  id: string;
  employee_email: string;
  department: string;
  period_start: string;
  calculated_bonus: number | null;
  kpi_data: Record<string, unknown> | null;
};

async function main() {
  console.log(APPLY ? '\n*** --apply: THIS WILL WRITE ***\n' : '\nREPORT ONLY — pass --apply to write\n');

  const bonuses = await selectAllPaged<BonusDef & { id: string }>(
    'bonus_catalog_bonuses',
    'id, name, kind, amount, formula, currency, cadence',
  );
  const assignments = await selectAllPaged<{ id: string; bonus_id: string; scope: string; department_key: string; employee_email: string | null }>(
    'bonus_catalog_assignments',
    'id, bonus_id, scope, department_key, employee_email',
  );

  const target = assignments.filter(
    (a) => (a.department_key ?? '').trim().toLowerCase() === BRANCH,
  );
  if (target.length === 0) {
    console.log(`No assignment on ${BRANCH}. Nothing to retire — already done, or never existed.`);
    return;
  }
  const byId = new Map(bonuses.map((b) => [b.id, b]));
  console.log(`assignments on ${BRANCH}:`);
  for (const a of target) console.log(`   ${(byId.get(a.bonus_id)?.name ?? '(unknown)').padEnd(24)} scope=${a.scope}  id=${a.id}`);

  const named = target.filter((a) => (byId.get(a.bonus_id)?.name ?? '').trim() === BONUS_NAME);
  if (named.length !== target.length) {
    console.error(`\nREFUSING: ${BRANCH} carries an assignment that is not "${BONUS_NAME}". Kane ruled on that one only.`);
    process.exit(2);
  }

  // Other branches are REPORTED, never touched — each is its own pay decision.
  const otherHsl = assignments.filter(
    (a) => (a.department_key ?? '').toLowerCase().startsWith('hsl:') && (a.department_key ?? '').trim().toLowerCase() !== BRANCH,
  );
  if (otherHsl.length > 0) {
    console.log('\nNOT TOUCHED — other HSL branches carrying a Library bonus (each needs its own ruling):');
    for (const a of otherHsl) console.log(`   ${a.department_key.padEnd(28)} ${byId.get(a.bonus_id)?.name ?? '(unknown)'}`);
  }

  // ── the orphaned kpi_data keys ─────────────────────────────────────────────
  const bonusIds = new Set(named.map((a) => a.bonus_id));
  const entries = await selectAllPaged<Entry>(
    'hsl_bonus_entries',
    'id, employee_email, department, period_start, calculated_bonus, kpi_data',
    (q) => q.eq('department', 'filing_specialist'),
  );
  const statuses = await selectAllPaged<{ period_start: string; status: string | null }>(
    'hsl_bonus_period_status',
    'period_start, status',
    (q) => q.eq('department', 'filing_specialist'),
  );
  const statusOf = new Map(statuses.map((s) => [s.period_start, s.status ?? 'draft']));

  const dirty = entries.filter((e) =>
    Object.keys(e.kpi_data ?? {}).some((k) => {
      if (!k.startsWith(catalogBonus.HSL_CATALOG_KPI_PREFIX)) return false;
      return bonusIds.has(k.slice(catalogBonus.HSL_CATALOG_KPI_PREFIX.length).split(':')[0]);
    }),
  );

  const worthMoney: { e: Entry; amount: number }[] = [];
  for (const e of dirty) {
    for (const id of bonusIds) {
      const def = byId.get(id);
      if (!def) continue;
      const amount = catalogBonus.calcHslCatalogBonus((e.kpi_data ?? {}) as any, def);
      if (amount > 0) worthMoney.push({ e, amount });
    }
  }

  console.log(`\nrows carrying an orphaned catalog: key: ${dirty.length}`);
  for (const e of dirty) {
    const keys = Object.entries(e.kpi_data ?? {}).filter(([k]) => k.startsWith(catalogBonus.HSL_CATALOG_KPI_PREFIX));
    console.log(`   ${e.period_start} ${(statusOf.get(e.period_start) ?? 'draft').padEnd(7)} ${e.employee_email.padEnd(28)} ₱${e.calculated_bonus ?? 0}  ${JSON.stringify(Object.fromEntries(keys))}`);
  }

  if (worthMoney.length > 0) {
    console.error(`\nREFUSING to strip — ${worthMoney.length} row(s) score MONEY from this bonus right now:`);
    for (const w of worthMoney) console.error(`   ${w.e.period_start} ${w.e.employee_email} → ₱${w.amount}`);
    console.error('Stripping these would cut a bonus someone has been scored for. Resolve with Kane first.');
    process.exit(3);
  }
  const locked = dirty.filter((e) => (statusOf.get(e.period_start) ?? 'draft') === 'locked');
  if (locked.length > 0) {
    console.error(`\nREFUSING — ${locked.length} row(s) sit in a LOCKED period. A locked week is never rewritten.`);
    process.exit(4);
  }

  // ── backup, then write ─────────────────────────────────────────────────────
  const dir = path.join('references', 'backups');
  fs.mkdirSync(dir, { recursive: true });
  const out = path.join(dir, `${new Date().toISOString().slice(0, 10)}-retire-filing-team-library-bonus.json`);
  fs.writeFileSync(out, JSON.stringify({ measuredAt: new Date().toISOString(), assignments: target, entries: dirty }, null, 2));
  console.log(`\nbackup written: ${out}`);

  if (!APPLY) {
    console.log(`\nWould DELETE ${named.length} assignment row(s) and strip catalog keys from ${dirty.length} entry row(s).`);
    console.log('Re-run with --apply to do it.');
    return;
  }

  for (const a of named) {
    const { error } = await db.from('bonus_catalog_assignments').delete().eq('id', a.id);
    if (error) throw new Error(`delete assignment ${a.id}: ${error.message}`);
    console.log(`deleted assignment ${a.id}`);
  }
  for (const e of dirty) {
    const next: Record<string, unknown> = { ...(e.kpi_data ?? {}) };
    for (const k of Object.keys(next)) {
      if (!k.startsWith(catalogBonus.HSL_CATALOG_KPI_PREFIX)) continue;
      if (bonusIds.has(k.slice(catalogBonus.HSL_CATALOG_KPI_PREFIX.length).split(':')[0])) delete next[k];
    }
    const { error } = await db.from('hsl_bonus_entries').update({ kpi_data: next }).eq('id', e.id);
    if (error) throw new Error(`update entry ${e.id}: ${error.message}`);
    console.log(`stripped catalog keys from ${e.employee_email} ${e.period_start}`);
  }
  console.log('\ndone.');
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
