/**
 * STRICTLY READ-ONLY. No insert / update / delete / upsert.
 *
 * Before `intake_specialist`'s two code rules — Signed Rep Docs x P250 and
 * 5-Star Reviews x P100 — are deleted (Kane, 2026-09-22: *"the signed up rep
 * docs and 5 star reviews columns are hard coded and not from the Payment
 * catalog make sure we delete these columns"*), answer the only question that
 * can make that unsafe:
 *
 *   Is any saved row's `calculated_bonus` STANDING ON those two rules?
 *
 * A stored `calculated_bonus` is frozen and is what the wizard dispatches, so
 * deleting the rules cannot move money on its own. The exposure is a REOPEN: a
 * manager marks a past week unready, the card rescores with `calcBonus` now
 * returning 0 for those keys, and the person is silently repriced DOWNWARD.
 * This prints exactly which weeks and people that would hit, per period status.
 *
 * Also prints what the live 2026-09-13 week would recompute to, so the
 * P282,700 on screen can be compared against the post-change figure.
 *
 *   npx tsx scripts/probe-intake-hardcoded-columns.mts
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
  employee_email: string;
  department: string;
  period_start: string;
  calculated_bonus: number | null;
  kpi_data: Record<string, unknown> | null;
};

const num = (v: unknown) => Number(v ?? 0) || 0;

async function main() {
  const entries = await selectAllPaged<Entry>(
    'hsl_bonus_entries',
    'employee_email, department, period_start, calculated_bonus, kpi_data',
    (q) => q.eq('department', 'intake_specialist'),
  );
  const statuses = await selectAllPaged<{ period_start: string; status: string | null }>(
    'hsl_bonus_period_status',
    'period_start, status',
    (q) => q.eq('department', 'intake_specialist'),
  );
  const statusOf = new Map(statuses.map((s) => [s.period_start, s.status ?? 'draft']));

  const weeks = [...new Set(entries.map((e) => e.period_start))].sort();
  console.log(`\nintake_specialist — ${entries.length} saved rows across ${weeks.length} weeks`);

  // ── what the two doomed rules are carrying, per week ───────────────────────
  console.log('\nweek        status   rows  rows w/ code-rule value   P from code rules   P stored total');
  let grandCode = 0;
  for (const w of weeks) {
    const rows = entries.filter((e) => e.period_start === w);
    const withVal = rows.filter((e) => num(e.kpi_data?.signed_rep_docs) > 0 || num(e.kpi_data?.five_star_reviews) > 0);
    const codePhp = rows.reduce(
      (s, e) => s + num(e.kpi_data?.signed_rep_docs) * 250 + num(e.kpi_data?.five_star_reviews) * 100,
      0,
    );
    const stored = rows.reduce((s, e) => s + (e.calculated_bonus ?? 0), 0);
    grandCode += codePhp;
    console.log(
      `${w}  ${(statusOf.get(w) ?? 'draft').padEnd(7)} ${String(rows.length).padStart(5)} ` +
        `${String(withVal.length).padStart(23)} ${`P${codePhp.toLocaleString('en-PH')}`.padStart(19)} ` +
        `${`P${stored.toLocaleString('en-PH')}`.padStart(16)}`,
    );
  }
  console.log(`\nTOTAL pesos currently attributable to the two code rules: P${grandCode.toLocaleString('en-PH')}`);

  const atRisk = entries.filter(
    (e) => num(e.kpi_data?.signed_rep_docs) > 0 || num(e.kpi_data?.five_star_reviews) > 0,
  );
  if (atRisk.length > 0) {
    console.log(`\nROWS THAT WOULD REPRICE DOWNWARD IF THEIR WEEK IS REOPENED (${atRisk.length}):`);
    for (const e of atRisk.slice(0, 40)) {
      const loss = num(e.kpi_data?.signed_rep_docs) * 250 + num(e.kpi_data?.five_star_reviews) * 100;
      console.log(
        `   ${e.period_start} ${(statusOf.get(e.period_start) ?? 'draft').padEnd(7)} ${e.employee_email.padEnd(30)} ` +
          `docs=${num(e.kpi_data?.signed_rep_docs)} reviews=${num(e.kpi_data?.five_star_reviews)}  -P${loss.toLocaleString('en-PH')}`,
      );
    }
    if (atRisk.length > 40) console.log(`   … ${atRisk.length - 40} more`);
  } else {
    console.log('\nNo saved row anywhere carries a non-zero Signed Rep Docs or 5-Star Reviews value.');
    console.log('Deleting the two rules therefore cannot reprice anyone, on any week, reopened or not.');
  }

  // ── the live week, for comparison against what is on screen ────────────────
  const live = '2026-09-13';
  const liveRows = entries.filter((e) => e.period_start === live);
  if (liveRows.length > 0) {
    const stored = liveRows.reduce((s, e) => s + (e.calculated_bonus ?? 0), 0);
    const codePhp = liveRows.reduce(
      (s, e) => s + num(e.kpi_data?.signed_rep_docs) * 250 + num(e.kpi_data?.five_star_reviews) * 100,
      0,
    );
    const ticked = liveRows.filter((e) =>
      Object.keys(e.kpi_data ?? {}).some((k) => k.startsWith('catalog:')),
    ).length;
    console.log(
      `\nlive week ${live} (${statusOf.get(live) ?? 'draft'}): ${liveRows.length} rows · stored total P${stored.toLocaleString('en-PH')} · ` +
        `P${codePhp.toLocaleString('en-PH')} of it from the two code rules · ${ticked} rows carry a catalog: key`,
    );
  }

  const dir = path.join('references', 'backups');
  fs.mkdirSync(dir, { recursive: true });
  const out = path.join(dir, `${new Date().toISOString().slice(0, 10)}-intake-hardcoded-columns.json`);
  fs.writeFileSync(out, JSON.stringify({ measuredAt: new Date().toISOString(), statuses, entries }, null, 2));
  console.log(`\nbefore-image written: ${out}`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
