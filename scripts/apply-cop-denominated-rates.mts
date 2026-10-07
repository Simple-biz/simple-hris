/**
 * Item 373: the Colombians' rates are COP. Kane ruled reading (a) on 2026-10-07, then
 * chose COP-denominated Pay Structures (resolution (b)).
 *
 *   node --import tsx scripts/apply-cop-denominated-rates.mts                       # DRY RUN, writes nothing
 *   node --import tsx scripts/apply-cop-denominated-rates.mts --apply --deployed    # backup, write, read back
 *
 * WHAT IT WRITES, and only after every precondition below holds:
 *   1. The three individual Pay Structures get `currency: 'COP'`. Their figures are unchanged
 *      (arturoa@ and soniaa@ 22,200 / 33,300, reinelr@ 17,300 / 25,950). The pay engines then
 *      convert them at each cycle's FX (`phpPerUnit('COP')`), so 22,200 COP/hr is ≈ ₱427.51
 *      at 62.68 / 3254.87.
 *   2. Bonus `bonus_mtddp1p5rf4hq1rw` "Lead Gen (COP)" (=Appts*14000) gets `currency: 'COP'`,
 *      plus one version row, exactly as `upsertBonus` mints it (display + audit only,
 *      bonus-catalog.md §8).
 *   3. The LIVE week's applied rows of that bonus are re-priced as COP at the live cycle's FX.
 *      Applied rows are an apply-time peso snapshot (bonus-catalog.md §7), so a currency
 *      change alone never reprices them. The KPI Calculator would normally re-save them, but
 *      it is refused while the payroll is locked. Mirrors `computeAmount` in
 *      DeptBonusCalculator.tsx: evaluateFormula × phpPerUnit, pinned to centavos.
 *
 * WHAT IT NEVER TOUCHES (payroll-rule-changes-forward-only):
 *   - any PAST week: applied rows, `paystub_dispatch_queue`, final-pay snapshots,
 *     `payment_dispatches`. 08-23 → 09-20 stay exactly as staged;
 *   - `employee_rate_history` / `employee_hourly_rates`. These are peso tables, and a
 *     non-PHP employee structure outranks them in every pay engine (`historyMatchesCatalogAsOf`
 *     is false for a non-PHP catalog, so the 22,200 history row can never resurface).
 *
 * --deployed IS REQUIRED WITH --apply. It is your word that the code from the same commit is
 * live. On the old build: current-pay files a COP structure under Payment Dispatch's COP tab
 * (payCurrency 'COP', silently unpaid); `mapBonus` reads the COP bonus back as PHP; and the
 * next Payment Catalog save turns COP back into pesos.
 *
 * AFTER --apply: reload EVERY open Payroll Wizard tab (a stale tab republishes the 22,200
 * figures, and the stale-snapshot check has no claim for a non-PHP rate). Then open the
 * Wizard on the live week and let it load. Its final-pay snapshot is newer than the 10-06
 * lock, so Payment Dispatch prices the three PENDING rows from it. Do NOT Unlock and re-Lock:
 * 226 of that week's 232 rows are already paid, and a re-lock re-stages money onto paid rows.
 *
 * Every precondition is a refusal, not a warning. Each read is checked, a backup lands in
 * `references/backups/` (gitignored) before the first write, and every write is read back.
 * Safe to re-run: an artifact that is already in the target state is skipped.
 */
import dotenv from 'dotenv';
import { mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';

dotenv.config({ path: '.env.local', quiet: true });
dotenv.config({ quiet: true });

const { createClient } = await import('@supabase/supabase-js');
const { evaluateFormula, validateFormula } = await import('../src/lib/bonus-catalog/formula');
const { phpPerUnit } = await import('../src/lib/fx/currency-fx');

const APPLY = process.argv.includes('--apply');
const DEPLOYED = process.argv.includes('--deployed');
const ACTOR = 'kaner@simple.biz';
const SOURCE = 'script:apply-cop-denominated-rates (item 373)';
const BACKUP_DIR = 'references/backups';

/** The three structures, as measured read-only on 2026-10-07. Anything else is a refusal. */
const STRUCTURES = [
  { id: 'pay_msnpjuvbpaxe7w23', email: 'arturoa@simple.biz', regular: 22200, ot: 33300 },
  { id: 'pay_ms3za61fa9tc3kvl', email: 'soniaa@simple.biz', regular: 22200, ot: 33300 },
  { id: 'pay_mtddx3yinmtr1li8', email: 'reinelr@simple.biz', regular: 17300, ot: 25950 },
] as const;
const BONUS_ID = 'bonus_mtddp1p5rf4hq1rw';
const BONUS_FORMULA_NUMBER = 14000;

function die(msg: string): never {
  console.error(`\nREFUSED: ${msg}`);
  process.exit(1);
}
const centavos = (n: number) => Math.round(n * 100) / 100;

const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
if (!url || !key) die('NEXT_PUBLIC_SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY missing');
if (APPLY && !DEPLOYED) {
  die(
    '--apply needs --deployed: push the commit that keeps COP (toPayCurrency, dispatchCurrencyForRate,\n' +
      "  the PHP-only history gate) and let it deploy first. On the old build the three land in the COP tab\n" +
      '  and the next catalog save turns COP back into pesos.',
  );
}
const sb = createClient(url, key, { auth: { persistSession: false } });

// ── 1. The live week and its FX ─────────────────────────────────────────────────────────────
const { data: uploads, error: upErr } = await sb
  .from('hubstaff_uploads')
  .select('*')
  .eq('is_current', true)
  .order('uploaded_at', { ascending: false })
  .limit(1);
if (upErr) die(`hubstaff_uploads read failed: ${upErr.message}`);
const liveFile = String((uploads?.[0] as Record<string, unknown> | undefined)?.source_file ?? '');
const weekMatch = /_(\d{4}-\d{2}-\d{2})_to_(\d{4}-\d{2}-\d{2})/.exec(liveFile);
if (!weekMatch) die(`could not read the live week from "${liveFile}"`);
const [, weekStart, weekEnd] = weekMatch;

const { data: fxRows, error: fxErr } = await sb
  .from('app_settings')
  .select('key,value')
  .eq('key', `payroll.wizard.fx.${liveFile}`);
if (fxErr) die(`cycle FX read failed: ${fxErr.message}`);
let cycleFx: { php?: number; cop?: number } = {};
try {
  cycleFx = JSON.parse(String(fxRows?.[0]?.value ?? '{}'));
} catch {
  die('the cycle FX record is not JSON');
}
const fx = { usdToPhp: Number(cycleFx.php), usdToCop: Number(cycleFx.cop) };
if (!(fx.usdToPhp > 0 && fx.usdToCop > 0)) {
  die(`the live cycle's FX is not set (php ${cycleFx.php}, cop ${cycleFx.cop}) — Step 2 must be filled in first`);
}
const perCop = phpPerUnit('COP', fx);
console.log(`Live week   ${weekStart} → ${weekEnd}   (${liveFile})`);
console.log(`Cycle FX    $1 = ₱${fx.usdToPhp} = COP ${fx.usdToCop}   →   1 COP = ₱${perCop.toFixed(6)}`);

// ── 2. The three structures ────────────────────────────────────────────────────────────────
const { data: sRows, error: sErr } = await sb
  .from('payment_catalog_pay_structures')
  .select('*')
  .in('id', STRUCTURES.map((s) => s.id));
if (sErr) die(`structures read failed: ${sErr.message}`);
const structuresToFlip: string[] = [];
console.log('\nPay Structures');
for (const want of STRUCTURES) {
  const row = (sRows ?? []).find((r) => r.id === want.id) as Record<string, unknown> | undefined;
  if (!row) die(`${want.id} (${want.email}) not found`);
  if (row.scope !== 'employee') die(`${want.id} is not an employee structure`);
  if (String(row.employee_email ?? '').trim().toLowerCase() !== want.email) {
    die(`${want.id} belongs to ${row.employee_email}, expected ${want.email}`);
  }
  if ((row.pay_basis ?? 'hourly') !== 'hourly') die(`${want.email} is not hourly (${row.pay_basis})`);
  if (Number(row.regular_rate) !== want.regular || Number(row.ot_rate) !== want.ot) {
    die(
      `${want.email} now holds ${row.regular_rate} / ${row.ot_rate}, not ${want.regular} / ${want.ot}. ` +
        'Someone changed it since 10-07; re-measure before converting anything.',
    );
  }
  const reg = centavos(want.regular * perCop);
  const ot = centavos(want.ot * perCop);
  if (row.currency === 'COP') {
    console.log(`  ${want.email.padEnd(20)} already COP ${want.regular} / ${want.ot} (≈ ₱${reg} / ₱${ot}) — skip`);
    continue;
  }
  if (row.currency !== 'PHP') die(`${want.email} is in ${row.currency}, expected PHP`);
  structuresToFlip.push(want.id);
  console.log(`  ${want.email.padEnd(20)} PHP ${want.regular} / ${want.ot}  →  COP ${want.regular} / ${want.ot}  (≈ ₱${reg} / ₱${ot} this cycle)`);
}

// ── 3. The bonus and its live-week applied rows ────────────────────────────────────────────
const { data: bonus, error: bErr } = await sb.from('bonus_catalog_bonuses').select('*').eq('id', BONUS_ID).maybeSingle();
if (bErr) die(`bonus read failed: ${bErr.message}`);
if (!bonus) die(`${BONUS_ID} not found`);
const b = bonus as Record<string, unknown>;
const formula = String(b.formula ?? '');
if (b.kind !== 'formula' || !validateFormula(formula).ok) die(`${BONUS_ID} is not a valid formula bonus`);
if (evaluateFormula(formula, { Appts: 1 }) !== BONUS_FORMULA_NUMBER) {
  die(`${BONUS_ID}'s formula is "${formula}", no longer ${BONUS_FORMULA_NUMBER} an appointment`);
}
const flipBonus = b.currency !== 'COP';
if (flipBonus && b.currency !== 'PHP') die(`${BONUS_ID} is in ${b.currency}, expected PHP`);
console.log(`\nBonus "${b.name}" (${formula})  ${flipBonus ? `${b.currency} → COP` : 'already COP — skip'}`);

const { data: applied, error: aErr } = await sb
  .from('bonus_catalog_applied')
  .select('*')
  .eq('bonus_id', BONUS_ID)
  .eq('period_start', weekStart);
if (aErr) die(`applied rows read failed: ${aErr.message}`);
type Reprice = { id: string; email: string; vars: Record<string, number>; before: number; after: number };
const reprices: Reprice[] = [];
console.log(`Applied rows for ${weekStart}: ${(applied ?? []).length}`);
for (const r of (applied ?? []) as Record<string, unknown>[]) {
  const vars: Record<string, number> = {};
  for (const [k, v] of Object.entries((r.vars as Record<string, unknown>) ?? {})) vars[k] = Number(v) || 0;
  const native = evaluateFormula(formula, vars);
  const before = Number(r.amount);
  const after = centavos(native * perCop);
  if (Math.abs(before - after) <= 0.005) {
    console.log(`  ${r.employee_email}  ${JSON.stringify(vars)}  already ₱${after} — skip`);
    continue;
  }
  if (Math.abs(before - centavos(native)) > 0.005) {
    die(`${r.id} holds ₱${before}, which is neither the raw COP figure ${native} nor its peso ₱${after}; re-measure`);
  }
  reprices.push({ id: String(r.id), email: String(r.employee_email), vars, before, after });
  console.log(`  ${String(r.employee_email).padEnd(24)} ${JSON.stringify(vars)}  ₱${before}  →  ₱${after}  (COP ${native})`);
}

// ── 4. What the live week will price at (read-only) ────────────────────────────────────────
const { data: staged, error: qErr } = await sb
  .from('paystub_dispatch_queue')
  .select('recipient_email,amount_php,amount_usd,payload')
  .eq('cycle_source_file', liveFile)
  .in('recipient_email', STRUCTURES.map((s) => s.email));
if (qErr) die(`staged read failed: ${qErr.message}`);
const { data: paidRows, error: pErr } = await sb
  .from('payment_dispatches')
  .select('recipient_email,status')
  .eq('cycle_source_file', liveFile)
  .in('recipient_email', STRUCTURES.map((s) => s.email));
if (pErr) die(`dispatch read failed: ${pErr.message}`);
if ((paidRows ?? []).length > 0) {
  die(
    `the live week already has a payment_dispatches row for ${(paidRows ?? []).map((r) => `${r.recipient_email} (${r.status})`).join(', ')}. ` +
      'This run exists to correct an UNPAID week; re-measure.',
  );
}
console.log('\nLive week, staged at lock (stays as-is; the Wizard\'s next snapshot supersedes it):');
for (const q of (staged ?? []) as Record<string, unknown>[]) {
  const pay = ((q.payload as Record<string, unknown>)?.pay_php ?? {}) as Record<string, number>;
  console.log(`  ${String(q.recipient_email).padEnd(20)} staged ₱${q.amount_php} ($${q.amount_usd}) · regular ${pay.regular} · ot ${pay.ot} · other bonuses ${pay.other_bonuses} · PAB ${pay.perfect_attendance_bonus}`);
}

if (structuresToFlip.length === 0 && !flipBonus && reprices.length === 0) {
  console.log('\nNothing to do — every artifact is already in the target state.');
  process.exit(0);
}
if (!APPLY) {
  console.log(
    `\nDRY RUN — 0 writes. Would flip ${structuresToFlip.length} structure(s), ${flipBonus ? '1' : '0'} bonus, and re-price ${reprices.length} applied row(s).` +
      '\nRe-run with --apply --deployed once the code is live.',
  );
  process.exit(0);
}

// ── APPLY ──────────────────────────────────────────────────────────────────────────────────
mkdirSync(BACKUP_DIR, { recursive: true });
const stamp = new Date().toISOString().replace(/[:.]/g, '-');
const backupPath = path.join(BACKUP_DIR, `cop_denominated_rates_${stamp}.json`);
writeFileSync(
  backupPath,
  JSON.stringify({ liveFile, fx, structures: sRows, bonus, applied, staged }, null, 2),
  'utf8',
);
console.log(`\nBackup → ${backupPath}`);

if (structuresToFlip.length > 0) {
  const { error } = await sb
    .from('payment_catalog_pay_structures')
    .update({ currency: 'COP', updated_by: ACTOR })
    .in('id', structuresToFlip)
    .eq('currency', 'PHP');
  if (error) die(`structure update failed: ${error.message}`);
}

if (flipBonus) {
  const nextVersion = Number(b.version ?? 1) + 1;
  const { error } = await sb
    .from('bonus_catalog_bonuses')
    .update({ currency: 'COP', updated_by: ACTOR, version: nextVersion, effective_from: weekStart })
    .eq('id', BONUS_ID)
    .eq('currency', 'PHP');
  if (error) die(`bonus update failed: ${error.message}`);
  const { error: hErr } = await sb.from('bonus_catalog_bonus_history').insert({
    bonus_id: BONUS_ID,
    version: nextVersion,
    name: b.name,
    description: b.description ?? null,
    kind: b.kind,
    amount: null,
    formula,
    currency: 'COP',
    cadence: b.cadence ?? 'weekly',
    changed_fields: ['currency'],
    effective_from: weekStart,
    note: 'edited',
    created_by: ACTOR,
  });
  if (hErr) console.warn(`  ! bonus version row not written: ${hErr.message} (the definition IS saved)`);
}

for (const r of reprices) {
  const { error } = await sb
    .from('bonus_catalog_applied')
    .update({ amount: r.after })
    .eq('id', r.id)
    .eq('amount', r.before);
  if (error) die(`applied row ${r.id} update failed: ${error.message}`);
}

// ── Read back ───────────────────────────────────────────────────────────────────────────────
const { data: sAfter, error: sAfterErr } = await sb
  .from('payment_catalog_pay_structures')
  .select('id,employee_email,currency,regular_rate,ot_rate')
  .in('id', STRUCTURES.map((s) => s.id));
if (sAfterErr) die(`read-back failed: ${sAfterErr.message}`);
const { data: bAfter } = await sb.from('bonus_catalog_bonuses').select('currency,version').eq('id', BONUS_ID).maybeSingle();
const { data: aAfter } = await sb
  .from('bonus_catalog_applied')
  .select('id,amount')
  .in('id', reprices.length > 0 ? reprices.map((r) => r.id) : ['-']);
let ok = true;
for (const s of sAfter ?? []) {
  const good = s.currency === 'COP';
  ok &&= good;
  console.log(`  ${good ? 'OK  ' : 'FAIL'} ${s.employee_email} ${s.currency} ${s.regular_rate} / ${s.ot_rate}`);
}
const bonusGood = bAfter?.currency === 'COP';
ok &&= bonusGood;
console.log(`  ${bonusGood ? 'OK  ' : 'FAIL'} bonus ${BONUS_ID} ${bAfter?.currency} v${bAfter?.version}`);
for (const r of reprices) {
  const got = Number((aAfter ?? []).find((x) => x.id === r.id)?.amount);
  const good = Math.abs(got - r.after) <= 0.005;
  ok &&= good;
  console.log(`  ${good ? 'OK  ' : 'FAIL'} applied ${r.email} ₱${got}`);
}

const { error: auditErr } = await sb.from('audit_log').insert([
  {
    user_name: ACTOR,
    user_role: 'admin',
    action: 'payroll.rate.set',
    resource: 'payment_catalog_pay_structures',
    resource_id: structuresToFlip.join(',') || STRUCTURES.map((s) => s.id).join(','),
    details: {
      source: SOURCE,
      change: 'currency PHP → COP, figures unchanged (Kane ruled reading (a) + resolution (b), 2026-10-07)',
      structures: STRUCTURES,
      fx_at_apply: fx,
      backup: backupPath,
    },
  },
  {
    user_name: ACTOR,
    user_role: 'admin',
    action: 'bonus_catalog.definition.saved',
    resource: 'bonus_catalog_bonuses',
    resource_id: BONUS_ID,
    details: {
      source: SOURCE,
      change: flipBonus ? 'currency PHP → COP' : 'unchanged',
      live_week_repriced: reprices,
      backup: backupPath,
    },
  },
]);
if (auditErr) console.warn(`  ! audit rows not written: ${auditErr.message}`);

if (!ok) die('read-back did not match — restore from the backup above');
console.log(
  '\nDone. Next: reload EVERY open Payroll Wizard tab, open the Wizard on the live week and let it load,' +
    '\nthen reload Payment Dispatch. Do NOT Unlock / re-Lock the week.',
);
