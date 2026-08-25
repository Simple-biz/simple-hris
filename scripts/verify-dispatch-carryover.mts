/**
 * READ-ONLY verifier: does Payment Dispatch carry over the Payroll Wizard's values?
 *
 * Runs the REAL `resolveWizardRowValues()` — the exact production function
 * `useDispatchQueue` prices every row with — against live rows for a cycle, and
 * asserts the two ways the screen can quote a number payroll never approved:
 *
 *   1. A payee the wizard LOCKED IN must never be priced by `computeCurrentPay`.
 *      That recomputation knows nothing about the accounting layer (Adjustments,
 *      Orphanage pay, KPI/dept bonuses, MESA), so a row falling through to it is
 *      silently missing money. On the 2026-08-02 cycle, before the fix, 680 of
 *      1,067 rows carried a wizard TOTAL beside a recomputed ₱0 bonus split.
 *   2. The itemization must travel with the total. A row whose Regular+OT, bonus,
 *      Orphanage and MESA lines don't recompose to the amount being sent is a row
 *      whose worksheet and paystub contradict the payment.
 *   3. The bonus total must recompose from its four NAMED parts (PAB, Tech, other
 *      dept/KPI bonuses, and the signed Accounting Adjustment). A residual here
 *      means the exported worksheet can show a total moving with no column that
 *      says why — and, worse, can present money being WITHHELD as a bonus. This
 *      is the same identity the wizard's own Reports export carries
 *      (`payrollExportRowReconciles`).
 *
 * It also REPORTS (without failing) the two states that are legitimate but must
 * never be invisible: a wizard that re-priced someone after the lock, and a
 * snapshot rejected for contradicting the Payment Catalog.
 *
 * Usage:
 *   $env:TSX_TSCONFIG_PATH="tsconfig.readiness-verify.json"
 *   node --import tsx scripts/verify-dispatch-carryover.mts [source_file]
 *
 * Omitted [source_file] = the current (`is_current`) cycle.
 */
import dotenv from 'dotenv';
dotenv.config({ path: '.env.local' });
dotenv.config();

const { createClient } = await import('@supabase/supabase-js');
const { resolveWizardRowValues } = await import('../src/lib/payroll/wizard-dispatch-values');
const { listPaystubDispatchQueue } = await import('../src/lib/supabase/paystub-dispatch-queue');
const { getCatalogRateClaimsByEmail, catalogClaimForEmails } = await import('../src/lib/payroll/paystub-fresh');
import type { WizardSnapshotEntry } from '../src/lib/payroll/wizard-dispatch-values';

const url = process.env.NEXT_PUBLIC_SUPABASE_URL?.trim();
const key = process.env.SUPABASE_SERVICE_ROLE_KEY?.trim();
if (!url || !key) {
  console.error('Missing NEXT_PUBLIC_SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY');
  process.exit(1);
}
const sb = createClient(url, key, { auth: { persistSession: false, autoRefreshToken: false } });

// ── Which cycle ─────────────────────────────────────────────────────────────
let sourceFile = process.argv[2]?.trim() || null;
if (!sourceFile) {
  const { data } = await sb
    .from('hubstaff_uploads')
    .select('source_file, is_current, uploaded_at')
    .order('uploaded_at', { ascending: false })
    .limit(10);
  const rows = (data ?? []) as { source_file: string | null; is_current: boolean | null }[];
  sourceFile = (rows.find((r) => r.is_current) ?? rows[0])?.source_file ?? null;
}
if (!sourceFile) {
  console.error('No source file — pass one as the first argument.');
  process.exit(1);
}
console.log(`cycle: ${sourceFile}\n`);

// ── Carrier A: what the wizard LOCKED (paged; PostgREST caps at 1000) ───────
const { rows: staged, error: stagedErr } = await listPaystubDispatchQueue(sourceFile);
if (stagedErr) {
  console.error(`FAIL: could not read the locked stage — ${stagedErr}`);
  process.exit(1);
}
const lockedAt = staged.map((s) => s.locked_at).filter(Boolean).sort().at(-1) ?? null;
console.log(
  `locked stage:  ${staged.length} payees (${staged.filter((s) => s.excluded).length} held) ` +
    `· newest locked_at ${lockedAt ?? '—'}`,
);
const itemizedStage = staged.filter((s) => s.pay_php != null).length;
console.log(`               ${itemizedStage} carry an itemized payload`);

// ── Carrier B: the wizard's published snapshot ──────────────────────────────
const { data: snapRows, error: snapErr } = await sb
  .from('app_settings')
  .select('value, updated_at')
  .eq('key', `payroll.wizard.final_pay.${sourceFile}`);
if (snapErr) {
  console.error(`FAIL: could not read the final-pay snapshot — ${snapErr.message}`);
  process.exit(1);
}
const snapRaw = (snapRows?.[0]?.value as string | undefined) ?? null;
const snapUpdatedAt = (snapRows?.[0]?.updated_at as string | undefined) ?? null;
let finals: Record<string, WizardSnapshotEntry> | null = null;
if (snapRaw) {
  finals = (JSON.parse(snapRaw) as { finals?: Record<string, WizardSnapshotEntry> }).finals ?? null;
}
console.log(
  `snapshot:      ${finals ? `${Object.keys(finals).length} keys` : 'ABSENT'} · updated_at ${snapUpdatedAt ?? '—'}`,
);
if (snapUpdatedAt && lockedAt) {
  const newer = Date.parse(snapUpdatedAt) > Date.parse(lockedAt);
  console.log(`               snapshot is ${newer ? 'NEWER than' : 'OLDER than'} the lock → ${newer ? 'it may speak for unheld rows' : 'the LOCK wins everywhere'}`);
}

// ── The catalog claims that gate a snapshot (the real production loader) ────
const claims = await getCatalogRateClaimsByEmail();
console.log(`catalog:       ${claims.size} employee-scope PHP structures\n`);

// ── Replay the production precedence for every staged payee ─────────────────
const round2 = (n: number) => Math.round(n * 100) / 100;
let bySnapshot = 0;
let byLock = 0;
const unpriced: string[] = [];
const repriced: Array<{ email: string; locked: number | null; shown: number }> = [];
const staleRate: string[] = [];
const noBreakdown: string[] = [];
const nonReconciling: Array<{ email: string; total: number; recomposed: number }> = [];
const bonusResidual: Array<{ email: string; total: number; split: number }> = [];
/** How much of the money rides in the two columns the export used to fold away. */
let otherBonusRows = 0;
let otherBonusSum = 0;
let adjustmentRows = 0;
let negativeAdjustmentRows = 0;
let negativeAdjustmentSum = 0;

for (const s of staged) {
  const email = s.recipient_email.trim().toLowerCase();
  const values = resolveWizardRowValues({
    workEmail: email,
    finals,
    snapshotUpdatedAt: snapUpdatedAt,
    staged: {
      amountPHP: s.amount_php,
      amountUSD: s.amount_usd,
      lockedAt: s.locked_at,
      excluded: s.excluded === true,
      payPhp: s.pay_php,
      hours: s.hours,
    },
    catalogClaim: catalogClaimForEmails(claims, [email, s.personal_email]),
  });

  if (!values) {
    unpriced.push(email);
    continue;
  }
  if (values.source === 'snapshot') bySnapshot += 1;
  else byLock += 1;
  if (values.staleRateSnapshot) staleRate.push(email);
  if (values.repricedAfterLock) {
    repriced.push({ email, locked: values.lockedAmountPHP, shown: values.amountPHP });
  }
  const b = values.breakdown;
  if (!b) {
    noBreakdown.push(email);
    continue;
  }
  const recomposed = round2(
    (b.initialPayPHP ?? 0) +
      b.bonusTotalPHP +
      b.orphanagePayPHP -
      b.mesaDeductionPHP +
      b.mesaDisbursementPHP,
  );
  if (Math.abs(recomposed - values.amountPHP) > 0.02) {
    nonReconciling.push({ email, total: values.amountPHP, recomposed });
  }
  // The bonus total's own four named parts — the columns the exported worksheet
  // shows. A residual is a total that moved with nothing saying why.
  const split = round2(b.pabBonusPHP + b.techBonusPHP + b.otherBonusesPHP + b.adjustmentPHP);
  if (Math.abs(split - b.bonusTotalPHP) > 0.02) {
    bonusResidual.push({ email, total: b.bonusTotalPHP, split });
  }
  if (Math.abs(b.otherBonusesPHP) > 0.004) {
    otherBonusRows += 1;
    otherBonusSum += b.otherBonusesPHP;
  }
  if (Math.abs(b.adjustmentPHP) > 0.004) {
    adjustmentRows += 1;
    if (b.adjustmentPHP < 0) {
      negativeAdjustmentRows += 1;
      negativeAdjustmentSum += b.adjustmentPHP;
    }
  }
}

console.log(`priced from the wizard's published snapshot: ${bySnapshot}`);
console.log(`priced from the wizard's LOCKED values:      ${byLock}`);
console.log(`itemization unavailable (no split shown):    ${noBreakdown.length}`);
console.log(
  `carrying dept/KPI "other" bonuses:           ${otherBonusRows} (₱${round2(otherBonusSum).toLocaleString()})`,
);
console.log(
  `carrying an Accounting Adjustment:           ${adjustmentRows}` +
    (negativeAdjustmentRows > 0
      ? ` — ${negativeAdjustmentRows} NEGATIVE (₱${round2(negativeAdjustmentSum).toLocaleString()} withheld)`
      : ''),
);
console.log('');

if (repriced.length > 0) {
  console.log(`NOTE: the wizard re-priced ${repriced.length} payee(s) AFTER the lock (newer figure shown):`);
  for (const r of repriced.slice(0, 20)) {
    console.log(`   ${r.email}  locked ₱${r.locked?.toLocaleString()} → shown ₱${r.shown.toLocaleString()}`);
  }
  if (repriced.length > 20) console.log(`   … +${repriced.length - 20} more`);
  console.log('   Legitimate (a late Adj. or a post-lock rate fix), but re-lock the week to make them agree.\n');
}
if (staleRate.length > 0) {
  console.log(`NOTE: ${staleRate.length} snapshot entr(ies) rejected — rate contradicts the Payment Catalog:`);
  for (const e of staleRate.slice(0, 20)) console.log(`   ${e}`);
  console.log('   Priced from the LOCKED values instead. Reload every wizard tab, then re-lock.\n');
}

// ── Assertions ─────────────────────────────────────────────────────────────
let failed = false;

if (unpriced.length > 0) {
  failed = true;
  console.error(
    `FAIL: ${unpriced.length} locked-in payee(s) have NO usable wizard figure, so Payment Dispatch\n` +
      `      prices them from computeCurrentPay — which excludes Adjustments, Orphanage pay,\n` +
      `      KPI/dept bonuses and MESA. Re-lock the week in the Payroll Wizard.`,
  );
  for (const e of unpriced.slice(0, 25)) console.error(`        ${e}`);
  if (unpriced.length > 25) console.error(`        … +${unpriced.length - 25} more`);
}

if (nonReconciling.length > 0) {
  failed = true;
  console.error(
    `\nFAIL: ${nonReconciling.length} row(s) whose itemization does not recompose to the amount being sent.\n` +
      `      Regular+OT + Bonus Total + Orphanage − MESA Deduction + MESA Disbursement must equal the total.`,
  );
  for (const r of nonReconciling.slice(0, 25)) {
    console.error(`        ${r.email}  total ₱${r.total.toLocaleString()} vs lines ₱${r.recomposed.toLocaleString()}`);
  }
}

if (bonusResidual.length > 0) {
  failed = true;
  console.error(
    `\nFAIL: ${bonusResidual.length} row(s) whose Bonus Total does not recompose from its named parts.\n` +
      `      PAB + Tech + Other Bonuses + Adjustment must equal Bonus Total, or the exported\n` +
      `      worksheet shows a total moving with no column that says why.`,
  );
  for (const r of bonusResidual.slice(0, 25)) {
    console.error(`        ${r.email}  bonus total ₱${r.total.toLocaleString()} vs parts ₱${r.split.toLocaleString()}`);
  }
}

if (failed) process.exit(1);
console.log(
  'OK: every locked-in payee is priced by the Payroll Wizard (snapshot or lock), every\n' +
    '    itemized row recomposes to the amount being sent, and every bonus total recomposes\n' +
    '    from PAB + Tech + Other + Adjustment — the columns the export now carries.',
);
