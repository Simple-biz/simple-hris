/**
 * READ-ONLY dry run of the week-scoped QC deal. SELECT only — it never writes,
 * and it never calls ensureQcAssignmentsForPeriod (that function DEALS).
 *
 * It reads the same three inputs the deal now reads and runs the REAL pure
 * function (src/lib/qc/roster-as-of-week.ts) over them, then prints the delta
 * against the live-roster-only behaviour it replaces:
 *
 *   + added   : in the department during the week, gone from the roster since
 *               (offboarded, or transferred out after the week ended)
 *   - dropped : on the roster today, but a filed transfer says they arrived
 *               AFTER the week ended
 *
 * Usage:
 *   $env:TSX_TSCONFIG_PATH="tsconfig.readiness-verify.json"
 *   node --import tsx scripts/verify-qc-roster-as-of-week.mts [--week=YYYY-MM-DD]
 */
import dotenv from 'dotenv';
dotenv.config({ path: '.env.local' });
dotenv.config();

const { createSupabaseServiceRoleClient } = await import('../src/lib/supabase/server');
const { qcSlotsAsOfWeek } = await import('../src/lib/qc/roster-as-of-week');
const { isQcDeptKey, QC_DEPT_KEYS } = await import('../src/lib/qc/constants');
const { isQcPeriodStart } = await import('../src/lib/qc/period');
const { normalizeDeptToKey } = await import('../src/lib/payroll/normalize-dept-key');
const { sanitizeOffboardDay } = await import('../src/lib/roster/offboard-date-sanity');

const weekArg = process.argv.find((a) => a.startsWith('--week='))?.slice('--week='.length) ?? '2026-09-06';
if (!isQcPeriodStart(weekArg)) {
  console.error(`--week must be a pay-week Sunday; ${weekArg} is not`);
  process.exit(1);
}
const [wy, wm, wd] = weekArg.split('-').map(Number);
const endDt = new Date(Date.UTC(wy!, wm! - 1, wd! + 6));
const weekEnd = endDt.toISOString().slice(0, 10);

const sb = createSupabaseServiceRoleClient();
if (!sb) {
  console.error('Supabase is not configured');
  process.exit(1);
}
const norm = (v: unknown) => String(v ?? '').toLowerCase().trim();

async function pageAll(table: string, select: string, apply: (q: any) => any = (q) => q) {
  const out: any[] = [];
  for (let from = 0; ; from += 1000) {
    const { data, error } = await apply(sb!.from(table).select(select).range(from, from + 999));
    if (error) throw new Error(`${table}: ${error.message}`);
    out.push(...(data ?? []));
    if ((data ?? []).length < 1000) break;
  }
  return out;
}

console.log(`QC week ${weekArg} .. ${weekEnd}   scored depts: ${QC_DEPT_KEYS.join(', ')}\n`);

const active = await pageAll('active_employees', '"Name","Work Email","Personal Email","Department","Start Date"');
const offRows = await pageAll(
  'global_master_list',
  '"Name","Work Email","Personal Email","Department","Alternate Work Email","Alternate Work Email 2",off_boarded_at',
  (q) => q.not('off_boarded_at', 'is', null).gte('off_boarded_at', weekArg),
);
const transferRows = await pageAll(
  'department_transfer_requests',
  'employee_email, employee_work_email, from_department, to_department, effective_date, status',
  (q) => q.in('status', ['applied', 'approved']),
);
console.log(`active_employees ${active.length} · offboard stamps >= ${weekArg}: ${offRows.length} · transfers ${transferRows.length}`);

const roster = active.map((e) => ({
  email: norm(e['Personal Email']) || norm(e['Work Email']),
  identityEmails: [norm(e['Personal Email']), norm(e['Work Email'])].filter(Boolean),
  name: e['Name'] ?? null,
  departmentKey: normalizeDeptToKey(e['Department']),
  offBoardedAt: null,
}));
const offboarded = offRows
  .map((r) => ({
    email: norm(r['Personal Email']) || norm(r['Work Email']),
    identityEmails: [
      norm(r['Personal Email']), norm(r['Work Email']),
      norm(r['Alternate Work Email']), norm(r['Alternate Work Email 2']),
    ].filter(Boolean),
    name: r['Name'] ?? null,
    departmentKey: normalizeDeptToKey(r['Department']),
    offBoardedAt: sanitizeOffboardDay(r.off_boarded_at ? String(r.off_boarded_at).slice(0, 10) : null),
  }))
  .filter((p) => p.email && p.offBoardedAt);
const transfers = transferRows.map((t) => ({
  identityEmails: [norm(t.employee_email), norm(t.employee_work_email)].filter(Boolean),
  fromKey: normalizeDeptToKey(t.from_department),
  toKey: normalizeDeptToKey(t.to_department),
  effectiveDate: t.effective_date ?? null,
}));

const before = new Set(
  roster.filter((p) => isQcDeptKey(p.departmentKey)).map((p) => `${p.email}|${p.departmentKey}`),
);
const after = qcSlotsAsOfWeek({ roster, offboarded, transfers, weekStart: weekArg, weekEnd, isScoredDept: isQcDeptKey });
const afterKeys = new Set(after.map((s) => `${s.email}|${s.dept}`));

const added = after.filter((s) => !before.has(`${s.email}|${s.dept}`));
const dropped = [...before].filter((k) => !afterKeys.has(k));

console.log(`\nlive-roster-only slots : ${before.size}`);
console.log(`week-scoped slots      : ${after.length}   (+${added.length} / -${dropped.length})`);

const byBasis = new Map<string, number>();
for (const s of after) byBasis.set(s.basis, (byBasis.get(s.basis) ?? 0) + 1);
console.log(`\nbasis:`);
for (const [b, n] of [...byBasis].sort()) console.log(`   ${b.padEnd(28)} ${n}`);

console.log(`\nADDED — would have needed "add external member" (${added.length}):`);
for (const s of added.slice(0, 40)) console.log(`   + ${s.dept}  ${s.email}  [${s.basis}]  ${s.name ?? ''}`);
if (added.length > 40) console.log(`   … and ${added.length - 40} more`);

console.log(`\nDROPPED — a filed transfer says they arrived after the week ended (${dropped.length}):`);
for (const k of dropped.slice(0, 40)) console.log(`   - ${k}`);
if (dropped.length > 40) console.log(`   … and ${dropped.length - 40} more`);

// Nobody may be dropped without a positive, dated transfer record saying so.
const explained = new Set<string>();
for (const t of transfers) {
  const eff = t.effectiveDate ? String(t.effectiveDate).slice(0, 10) : null;
  if (!eff || eff <= weekEnd || !isQcDeptKey(t.toKey)) continue;
  for (const e of t.identityEmails) explained.add(`${e}|${t.toKey}`);
}
const unexplained = dropped.filter((k) => !explained.has(k));
if (unexplained.length > 0) {
  console.error(`\nFAIL: ${unexplained.length} dropped WITHOUT a dated transfer-in record:`);
  for (const k of unexplained.slice(0, 20)) console.error(`   ! ${k}`);
  process.exit(1);
}
console.log(`\nOK: every drop is backed by a filed transfer INTO the department dated after ${weekEnd}.`);
