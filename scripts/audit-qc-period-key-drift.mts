/**
 * READ-ONLY reconciliation report for QC period keys. SELECT only — it writes
 * nothing and deletes nothing, by design (Kane, 2026-09-14: fix and report,
 * delete never).
 *
 * `qc_score_assignments.period_start` must be a pay-week SUNDAY. Until the
 * Sunday lock shipped (src/lib/qc/period.ts) nothing enforced it, and
 * `GET /api/qc/assignments` WRITES — it deals and upserts a whole week of slots
 * for whatever key it is handed. Two clients seeded a period from the local
 * clock with a Monday-anchored helper and fetched before the real week resolved
 * (`QCApp.tsx`, and the manager calculator's QcOfficerLog), so each first paint
 * could manufacture a week rather than read one.
 *
 * Measured 2026-09-14, before the fix: 10 of 29 periods were non-Sunday and
 * eight pay weeks existed twice over.
 *
 * Run:
 *   $env:TSX_TSCONFIG_PATH="tsconfig.readiness-verify.json"
 *   node --import tsx scripts/audit-qc-period-key-drift.mts
 *
 * Exit 1 if any phantom period holds SCORES — that is the only state that needs
 * a decision rather than an observation, because scores under a Monday key are
 * invisible to every reader forever.
 */
import dotenv from 'dotenv';
dotenv.config({ path: '.env.local' });
dotenv.config();

const { createSupabaseServiceRoleClient } = await import('../src/lib/supabase/server');
const { isQcPeriodStart } = await import('../src/lib/qc/period');

const sb = createSupabaseServiceRoleClient();
if (!sb) {
  console.error('Supabase is not configured (.env.local)');
  process.exit(1);
}

/** PostgREST truncates at 1000 rows even with .range() — always page. */
async function pageAll<T = Record<string, unknown>>(
  table: string,
  select: string,
): Promise<T[]> {
  const out: T[] = [];
  for (let from = 0; ; from += 1000) {
    const { data, error } = await sb!.from(table).select(select).range(from, from + 999);
    if (error) throw new Error(`${table}: ${error.message}`);
    const rows = (data ?? []) as T[];
    out.push(...rows);
    if (rows.length < 1000) break;
  }
  return out;
}

const DAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
const dow = (d: string) =>
  DAYS[new Date(Date.UTC(+d.slice(0, 4), +d.slice(5, 7) - 1, +d.slice(8, 10))).getUTCDay()];
const addDays = (d: string, n: number) => {
  const dt = new Date(Date.UTC(+d.slice(0, 4), +d.slice(5, 7) - 1, +d.slice(8, 10) + n));
  return dt.toISOString().slice(0, 10);
};

const slots = await pageAll<{ period_start: string; member_email: string | null }>(
  'qc_score_assignments',
  'period_start, member_email',
);
const scores = await pageAll<{ period_start: string }>('qc_kpi_submissions', 'period_start');

const slotsBy = new Map<string, Set<string>>();
for (const r of slots) {
  const set = slotsBy.get(r.period_start) ?? new Set<string>();
  set.add(String(r.member_email ?? '').toLowerCase());
  slotsBy.set(r.period_start, set);
}
const scoresBy = new Map<string, number>();
for (const r of scores) scoresBy.set(r.period_start, (scoresBy.get(r.period_start) ?? 0) + 1);

const periods = [...slotsBy.keys()].sort();
const phantom = periods.filter((p) => !isQcPeriodStart(p));

console.log(`qc_score_assignments : ${slots.length} slots across ${periods.length} periods`);
console.log(`qc_kpi_submissions   : ${scores.length} scores across ${scoresBy.size} periods`);
console.log(`\nPHANTOM (non-Sunday) periods: ${phantom.length} of ${periods.length}`);

let scoredPhantoms = 0;
for (const p of phantom) {
  const n = slotsBy.get(p)?.size ?? 0;
  const sc = scoresBy.get(p) ?? 0;
  if (sc > 0) scoredPhantoms++;
  console.log(`   ${p} ${dow(p)}  ${String(n).padStart(4)} members  ${sc} scores${sc > 0 ? '  <-- HOLDS SCORES' : ''}`);
}

// A phantom that shadows a real Sunday week: same pay week, dealt twice.
console.log(`\nPHANTOMS SHADOWING A REAL SUNDAY WEEK`);
let shadows = 0;
for (const p of phantom) {
  // The Sunday of the pay week this key fell inside.
  const back = new Date(Date.UTC(+p.slice(0, 4), +p.slice(5, 7) - 1, +p.slice(8, 10))).getUTCDay();
  const sunday = addDays(p, -back);
  const real = slotsBy.get(sunday);
  if (!real) {
    console.log(`   ${p} ${dow(p)} -> ${sunday} Sun : no real week exists (orphan phantom)`);
    continue;
  }
  shadows++;
  const mine = slotsBy.get(p)!;
  const overlap = [...mine].filter((e) => real.has(e)).length;
  console.log(
    `   ${p} ${dow(p)} (${mine.size}) shadows ${sunday} Sun (${real.size}) — ${overlap} members in both`,
  );
}

console.log(`\nSummary: ${phantom.length} phantom periods, ${shadows} shadowing a real week, ${scoredPhantoms} holding scores.`);
if (scoredPhantoms > 0) {
  console.error(
    `\nFAIL: ${scoredPhantoms} phantom period(s) hold scores. Those scores are unreachable by ` +
      `every reader (Sunday keys only) and need an explicit decision — they are NOT cleaned up here.`,
  );
  process.exit(1);
}
console.log('\nOK: no phantom period holds scores — they are dead slot rows only, safe to leave in place.');
