/**
 * Repair the 2026-08-09 → 2026-08-15 pay week for the 23 Lead Gen → HSL
 * mid-week transferees whose rate-history dates were silently snapped to the
 * week start (Sun 2026-08-09) by the now-deleted pay-week snapping in
 * `insertRateHistoryRow`. Ruling 2026-08-18 (Kane): transfer-dated proration
 * stands — each side of the transfer pays at its real rate, legs at 2dp.
 *
 * Per person, this script:
 *   1. re-dates their new-rate `employee_rate_history` row from 2026-08-09 to
 *      the transfer's actual effective date (08-11 / 08-13 / 08-14);
 *   2. backfills a ₱175/₱262.50 pre-transfer baseline row eff 2026-08-09 —
 *      without it, pre-transfer days resolve through the fallback to the SAME
 *      new rate and the split silently collapses (the Uriel Matias failure
 *      mode). ₱175 is grounded: every one of the 23 with an 08-02 stub —
 *      harleyc@ included, whose CACHE said ₱225 — was actually paid ₱175, and
 *      ₱175 is the Lead Gen department base for the rest;
 *   3. (cheskac@ only) deletes her two same-date duplicate rows first — she
 *      held ₱355/₱175/₱355 all eff 2026-08-09, ordered arbitrarily by the
 *      resolver (the back-dated de-dupe hole, closed in the same commit).
 *
 * After the history writes it RE-SEEDS the week's disbursement_records via the
 * real `seedMissingDisbursementRecords` (explicit source_file = re-seed;
 * estimates refresh from hours through the fixed engine, paid state preserved),
 * then prints the repriced rows.
 *
 * NOT touched: raymandc@ / janrielr@ (HSL round-trips with no rate change —
 * their flat ₱175 weeks are correct), and the wizard's final_pay snapshot
 * (Accounting re-locks the week in the wizard, which replaces it).
 *
 * SAFE BY DEFAULT: dry-run prints the plan and writes a JSON backup of every
 * row it would touch to references/backups/. Re-run with --apply to write.
 *
 *   npx tsx scripts/fix-midweek-transfer-effective-dates.mts [--apply]
 */
import { createClient } from '@supabase/supabase-js';
import { writeFileSync } from 'node:fs';
import dotenv from 'dotenv';

dotenv.config({ path: '.env.local' });
dotenv.config();

const APPLY = process.argv.includes('--apply');
const WEEK_START = '2026-08-09';
const SOURCE_FILE = 'simple-biz_daily_report_2026-08-09_to_2026-08-15.csv';
const OLD_REG = '175';
const OLD_OT = '262.5';
const BASELINE_NOTE =
  'baseline backfill: pre-transfer Lead Gen rate (midweek-transfer fix 2026-08-18)';
const ACTOR = 'kaner@simple.biz via fix-midweek-transfer-effective-dates.mts';

/** email → { eff: transfer effective date, rate: new catalog regular rate }.
 *  Declared, not inferred — verified against department_transfer_requests and
 *  payment_catalog_pay_structures below; any mismatch aborts that person. */
const MANIFEST: Record<string, { eff: string; rate: number }> = {
  // eff 2026-08-13 → hsl:simple_texting (₱225)
  'annalizaa@simple.biz': { eff: '2026-08-13', rate: 225 },
  'exoferioc@simple.biz': { eff: '2026-08-13', rate: 225 },
  'georgea@simple.biz': { eff: '2026-08-13', rate: 225 },
  'glezas@simple.biz': { eff: '2026-08-13', rate: 225 },
  'jessag@simple.biz': { eff: '2026-08-13', rate: 225 },
  'boniorm@simple.biz': { eff: '2026-08-13', rate: 225 },
  'matthewm@simple.biz': { eff: '2026-08-13', rate: 225 },
  'harleyc@simple.biz': { eff: '2026-08-13', rate: 225 },
  // eff 2026-08-14 → hsl:medical_records (₱265)
  'pabuayaj@simple.biz': { eff: '2026-08-14', rate: 265 },
  'torresn@simple.biz': { eff: '2026-08-14', rate: 265 },
  'lizethm@simple.biz': { eff: '2026-08-14', rate: 265 },
  'alisonm@simple.biz': { eff: '2026-08-14', rate: 265 },
  'perezr@simple.biz': { eff: '2026-08-14', rate: 265 },
  'villaualas@simple.biz': { eff: '2026-08-14', rate: 265 },
  'dennym@simple.biz': { eff: '2026-08-14', rate: 265 },
  'melissap@simple.biz': { eff: '2026-08-14', rate: 265 },
  'vinchelc@simple.biz': { eff: '2026-08-14', rate: 265 },
  'sebastians@simple.biz': { eff: '2026-08-14', rate: 265 },
  // eff 2026-08-14 → hsl:hearing_prep_mail_sorting (₱265)
  'erickb@simple.biz': { eff: '2026-08-14', rate: 265 },
  // eff 2026-08-14 → hsl:executive_guest_services (₱355)
  'cheskac@simple.biz': { eff: '2026-08-14', rate: 355 },
  'ralfpa@simple.biz': { eff: '2026-08-14', rate: 355 },
  'gizellel@simple.biz': { eff: '2026-08-14', rate: 355 },
  // eff 2026-08-11 → HSL (₱265)
  'rosalyj@simple.biz': { eff: '2026-08-11', rate: 265 },
};

const url = process.env.NEXT_PUBLIC_SUPABASE_URL?.trim();
const key = process.env.SUPABASE_SERVICE_ROLE_KEY?.trim();
if (!url || !key) {
  console.error('Missing Supabase env');
  process.exit(1);
}
const sb = createClient(url, key, { auth: { persistSession: false, autoRefreshToken: false } });

const EMAILS = Object.keys(MANIFEST);
const num = (v: unknown) => parseFloat(String(v ?? '').replace(/,/g, ''));

// ── Backup FIRST (CLAUDE.md: every bulk UPDATE needs a SELECT backup on disk) ─
const { data: histRows, error: hErr } = await sb
  .from('employee_rate_history')
  .select('*')
  .in('employee_email', EMAILS)
  .order('employee_email');
if (hErr) {
  console.error('history read failed:', hErr.message);
  process.exit(1);
}
const { data: drRows, error: dErr } = await sb
  .from('disbursement_records')
  .select('*')
  .eq('cycle_period_start', WEEK_START)
  .in('recipient_email', EMAILS);
if (dErr) {
  console.error('disbursement read failed:', dErr.message);
  process.exit(1);
}
const backupPath = 'references/backups/2026-08-18_midweek-transfer-rate-history-backup.json';
writeFileSync(
  backupPath,
  JSON.stringify(
    { takenAt: new Date().toISOString(), employee_rate_history: histRows, disbursement_records: drRows },
    null,
    2,
  ),
);
console.log(`Backup written: ${backupPath} (${histRows?.length ?? 0} history rows, ${drRows?.length ?? 0} disbursement rows)\n`);

// ── Verify + plan ─────────────────────────────────────────────────────────────
const { data: transfers } = await sb
  .from('department_transfer_requests')
  .select('employee_email, employee_work_email, to_department, status, effective_date')
  .eq('status', 'applied')
  .or(`employee_email.in.(${EMAILS.join(',')}),employee_work_email.in.(${EMAILS.join(',')})`)
  .order('effective_date', { ascending: true });
const latestTransfer = new Map<string, { eff: string; to: string }>();
for (const t of transfers ?? []) {
  const e = String(t.employee_work_email || t.employee_email).toLowerCase();
  latestTransfer.set(e, { eff: String(t.effective_date).slice(0, 10), to: String(t.to_department) });
}

const { data: cats } = await sb
  .from('payment_catalog_pay_structures')
  .select('employee_email, regular_rate, ot_rate, currency')
  .eq('scope', 'employee')
  .in('employee_email', EMAILS);
const catBy = new Map((cats ?? []).map((c) => [String(c.employee_email).toLowerCase(), c]));

const histBy = new Map<string, Array<Record<string, unknown>>>();
for (const r of (histRows ?? []) as Array<Record<string, unknown>>) {
  const e = String(r.employee_email).toLowerCase();
  if (!histBy.has(e)) histBy.set(e, []);
  histBy.get(e)!.push(r);
}

type Action =
  | { kind: 'delete-duplicate'; id: string; why: string }
  | { kind: 're-date'; id: string; from: string; to: string }
  | { kind: 'insert-baseline'; eff: string };
const plan = new Map<string, Action[]>();
const problems: string[] = [];

for (const email of EMAILS) {
  const m = MANIFEST[email];
  const actions: Action[] = [];

  const tr = latestTransfer.get(email);
  if (!tr || tr.eff !== m.eff) {
    problems.push(`${email}: transfer eff mismatch — manifest ${m.eff}, DB ${tr?.eff ?? 'none'} (ABORTING this person)`);
    continue;
  }
  const cat = catBy.get(email);
  if (!cat || cat.currency !== 'PHP' || Math.abs(num(cat.regular_rate) - m.rate) > 0.005) {
    problems.push(`${email}: catalog rate mismatch — manifest ₱${m.rate}, DB ${cat ? `${cat.currency} ${cat.regular_rate}` : 'none'} (ABORTING this person)`);
    continue;
  }

  const rows = histBy.get(email) ?? [];
  const atWeekStart = rows.filter((r) => String(r.effective_from).slice(0, 10) === WEEK_START);
  const alreadyMoved = rows.filter(
    (r) => String(r.effective_from).slice(0, 10) === m.eff && Math.abs(num(r.regular_rate) - m.rate) <= 0.005,
  );
  const baselineExists = rows.some(
    (r) =>
      String(r.effective_from).slice(0, 10) === WEEK_START &&
      Math.abs(num(r.regular_rate) - 175) <= 0.005 &&
      String(r.note ?? '') === BASELINE_NOTE,
  );

  if (alreadyMoved.length > 0) {
    // Idempotent re-run: new-rate row already at the transfer date.
    if (!baselineExists) actions.push({ kind: 'insert-baseline', eff: WEEK_START });
    plan.set(email, actions);
    continue;
  }

  const newRateAtStart = atWeekStart.filter((r) => Math.abs(num(r.regular_rate) - m.rate) <= 0.005);
  const strayAtStart = atWeekStart.filter((r) => Math.abs(num(r.regular_rate) - m.rate) > 0.005);

  if (newRateAtStart.length === 0) {
    problems.push(`${email}: no ${WEEK_START} row at the catalog rate ₱${m.rate} — rows: ${atWeekStart.map((r) => `${r.regular_rate}`).join(', ') || 'none'} (ABORTING this person)`);
    continue;
  }
  // Same-date duplicates (cheskac@): keep the NEWEST new-rate row, delete the rest
  // and every same-date stray (her ₱175 row) — the baseline insert below restores
  // the pre-transfer ₱175 under the audited note.
  const sorted = [...newRateAtStart].sort((a, b) => String(b.created_at).localeCompare(String(a.created_at)));
  const keep = sorted[0];
  for (const r of sorted.slice(1)) {
    actions.push({ kind: 'delete-duplicate', id: String(r.id), why: `duplicate ₱${r.regular_rate} eff ${WEEK_START} (created ${String(r.created_at).slice(0, 19)})` });
  }
  for (const r of strayAtStart) {
    actions.push({ kind: 'delete-duplicate', id: String(r.id), why: `same-date stray ₱${r.regular_rate} eff ${WEEK_START} (created ${String(r.created_at).slice(0, 19)})` });
  }
  actions.push({ kind: 're-date', id: String(keep.id), from: WEEK_START, to: m.eff });
  if (!baselineExists) actions.push({ kind: 'insert-baseline', eff: WEEK_START });
  plan.set(email, actions);
}

// ── Print the plan ────────────────────────────────────────────────────────────
console.log(`${APPLY ? 'APPLYING' : 'DRY RUN (no writes; re-run with --apply)'} — ${plan.size}/${EMAILS.length} people planned\n`);
for (const [email, actions] of plan) {
  const m = MANIFEST[email];
  console.log(`${email}  → eff ${m.eff} @ ₱${m.rate}`);
  if (actions.length === 0) console.log('   (nothing to do — already repaired)');
  for (const a of actions) {
    if (a.kind === 'delete-duplicate') console.log(`   DELETE ${a.id.slice(0, 8)}  ${a.why}`);
    if (a.kind === 're-date') console.log(`   UPDATE ${a.id.slice(0, 8)}  effective_from ${a.from} → ${a.to}`);
    if (a.kind === 'insert-baseline') console.log(`   INSERT baseline ₱${OLD_REG}/${OLD_OT} eff ${a.eff}`);
  }
}
if (problems.length) {
  console.log('\nPROBLEMS (people skipped):');
  for (const p of problems) console.log('  ⚠ ' + p);
}

if (!APPLY) {
  console.log('\nDry run complete. Nothing written.');
  process.exit(problems.length ? 2 : 0);
}

// ── Apply ─────────────────────────────────────────────────────────────────────
let failed = 0;
for (const [email, actions] of plan) {
  for (const a of actions) {
    if (a.kind === 'delete-duplicate') {
      const { error } = await sb.from('employee_rate_history').delete().eq('id', a.id);
      if (error) { console.error(`  ✖ ${email} delete ${a.id.slice(0, 8)}: ${error.message}`); failed++; }
    } else if (a.kind === 're-date') {
      const { error } = await sb
        .from('employee_rate_history')
        .update({ effective_from: a.to, note: `effective date corrected ${a.from} → ${a.to} (transfer date; midweek fix 2026-08-18)` })
        .eq('id', a.id);
      if (error) { console.error(`  ✖ ${email} re-date ${a.id.slice(0, 8)}: ${error.message}`); failed++; }
    } else {
      const { error } = await sb.from('employee_rate_history').insert({
        employee_email: email,
        regular_rate: OLD_REG,
        ot_rate: OLD_OT,
        effective_from: a.eff,
        note: BASELINE_NOTE,
        created_by: ACTOR,
      });
      if (error) { console.error(`  ✖ ${email} baseline insert: ${error.message}`); failed++; }
    }
  }
}
console.log(failed ? `\n${failed} write(s) FAILED — fix and re-run (idempotent).` : '\nAll history writes applied.');
if (failed) process.exit(1);

// ── Re-seed the week's disbursement records through the fixed engine ─────────
console.log(`\nRe-seeding ${SOURCE_FILE} …`);
const { seedMissingDisbursementRecords } = await import('../src/lib/payroll/disbursement-reports');
const seedRes = await seedMissingDisbursementRecords({ sourceFiles: [SOURCE_FILE] });
console.log(`seed result: seeded=${seedRes.seeded} error=${seedRes.error ?? 'none'}`);

// ── Verify: print the repriced rows ───────────────────────────────────────────
const { data: after } = await sb
  .from('disbursement_records')
  .select('recipient_email, regular_hours, ot_hours, regular_rate_php, amount_php, status')
  .eq('cycle_period_start', WEEK_START)
  .in('recipient_email', EMAILS)
  .order('recipient_email');
console.log('\nRepriced disbursement records:');
const before = new Map((drRows ?? []).map((r: Record<string, unknown>) => [String(r.recipient_email), r]));
let sumBefore = 0;
let sumAfter = 0;
for (const r of after ?? []) {
  const b = before.get(String(r.recipient_email));
  const was = b ? num(b.amount_php) : 0;
  sumBefore += was;
  sumAfter += num(r.amount_php);
  console.log(
    `  ${String(r.recipient_email).padEnd(26)} ₱${String(was).padStart(9)} → ₱${String(r.amount_php).padStart(9)}  (reg ${r.regular_hours}h ot ${r.ot_hours}h @₱${r.regular_rate_php}) [${r.status}]`,
  );
}
console.log(`\nTOTAL ₱${sumBefore.toFixed(2)} → ₱${sumAfter.toFixed(2)}  (Δ ₱${(sumAfter - sumBefore).toFixed(2)})`);
