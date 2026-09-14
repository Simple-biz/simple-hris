/**
 * READ-ONLY. Of the people QC scored for a dept-week who have NO applied row
 * (not on the manager's table), how many can the shipped "Offboarded · last pay"
 * strip already reach, and where are the rest?
 *
 * Runs the REAL strip function (`listRecentlyOffboardedPeople` +
 * `offboardedRelevantToWeek`) — the same pair the calculators use — so the
 * answer is what the UI would offer, not an approximation.
 *
 * Usage:
 *   $env:TSX_TSCONFIG_PATH="tsconfig.readiness-verify.json"
 *   node --import tsx scripts/probe-lead-gen-qc-only-reach.mts [--dept=lead_gen] [--week=2026-09-06]
 */
import dotenv from 'dotenv';
dotenv.config({ path: '.env.local' }); dotenv.config();
const arg = (n: string, d: string) => process.argv.find((a) => a.startsWith(`--${n}=`))?.slice(n.length + 3) ?? d;
const DEPT = arg('dept', 'lead_gen'); const WEEK = arg('week', '2026-09-06');
const { createSupabaseServiceRoleClient } = await import('../src/lib/supabase/server');
const { listRecentlyOffboardedPeople } = await import('../src/lib/roster/recently-offboarded');
const { offboardedRelevantToWeek } = await import('../src/lib/roster/offboarded-week-relevance');
const sb = createSupabaseServiceRoleClient()!;
const k = (e: unknown) => String(e ?? '').trim().toLowerCase();
const num = (v: unknown) => Number(v ?? 0) || 0;
async function pageAll(table: string, select: string, f: Array<[string, string]>) {
  const out: Record<string, unknown>[] = [];
  for (let from = 0; ; from += 1000) {
    let q = sb.from(table).select(select); for (const [c, v] of f) q = q.eq(c, v);
    const { data, error } = await q.range(from, from + 999); if (error) throw new Error(`${table}: ${error.message}`);
    out.push(...((data ?? []) as Record<string, unknown>[])); if ((data ?? []).length < 1000) break;
  }
  return out;
}
const applied = await pageAll('bonus_catalog_applied', 'employee_email', [['department', DEPT], ['period_start', WEEK]]);
const qc = await pageAll('qc_kpi_submissions', 'employee_email, employee_name, amount, scored_by', [['department', DEPT], ['period_start', WEEK]]);
const onTable = new Set(applied.map((r) => k(r.employee_email)));
const qcOnly = qc.filter((r) => num(r.amount) > 0 && !onTable.has(k(r.employee_email)));
const qcOnlyZero = qc.filter((r) => num(r.amount) === 0 && !onTable.has(k(r.employee_email)));
console.log(`\n${DEPT} · ${WEEK}\nQC-scored, NOT on the manager's table: ${qcOnly.length} with amount > 0 (₱${qcOnly.reduce((s, r) => s + num(r.amount), 0).toLocaleString()}), ${qcOnlyZero.length} at ₱0`);

// (a) the strip's real list, week-scoped exactly as the calculators do it
const { people: all, error: offErr } = await listRecentlyOffboardedPeople(); if (offErr) throw new Error(offErr);
const offered = all.filter((p: any) => offboardedRelevantToWeek(p, WEEK));
const offeredByEmail = new Map<string, any>();
for (const p of offered) for (const e of [p.work_email, p.personal_email, p.hubstaff_email]) { const kk = k(e); if (kk) offeredByEmail.set(kk, p); }
console.log(`strip would OFFER ${offered.length} leavers for this week (of ${all.length} in the 90-day list)`);

// (b) the active roster, for whoever the strip does not reach
const active = await pageAll('active_employees', '"Work Email","Personal Email","Department"', []);
const activeByEmail = new Map<string, any>();
for (const r of active) for (const c of ['Work Email', 'Personal Email']) { const kk = k(r[c]); if (kk) activeByEmail.set(kk, r); }

let viaStrip = 0, onActiveElsewhere = 0, onActiveSameDept = 0, nowhere = 0;
const rows: string[] = [];
for (const r of qcOnly) {
  const e = k(r.employee_email); const name = String(r.employee_name ?? e).slice(0, 30).padEnd(31);
  const strip = offeredByEmail.get(e); const act = activeByEmail.get(e);
  let how: string;
  if (strip) { viaStrip++; how = `STRIP offers them (left ${strip.off_boarded_at ?? strip.last_hours_week_start ?? '?'}; add key = ${k(strip.hubstaff_email) || k(strip.work_email) || e})`; }
  else if (act) { const d = String(act.Department ?? ''); if (d.toLowerCase().replace(/[^a-z]/g, '') .includes(DEPT.replace(/_/g, ''))) { onActiveSameDept++; how = `ACTIVE in ${d} — on roster yet off the table?!`; } else { onActiveElsewhere++; how = `ACTIVE in "${d}" — transferred out; nothing offers them`; } }
  else { nowhere++; how = 'not offered by the strip, not on the active roster — nothing reaches them'; }
  rows.push(`  ${name} ₱${num(r.amount).toLocaleString().padStart(6)}  ${how}`);
}
console.log('\n' + rows.join('\n'));
console.log(`\nreachable today via the strip: ${viaStrip}   transferred out (active elsewhere): ${onActiveElsewhere}   active in ${DEPT} but off the table: ${onActiveSameDept}   unreachable by anything: ${nowhere}`);
console.log('\nREAD-ONLY. Nothing was written.\n');
