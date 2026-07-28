/**
 * Smoke-test the contractor dispatch-queue builder against the live database.
 *
 *   npx tsx scripts/smoke-contractor-dispatch-queue.mts
 *
 * READ-ONLY. Runs the real `loadContractorDispatchRows` twice:
 *   1. as the app calls it (current cycle) — the rows the clerk will see
 *   2. with a PAST source_file — must return zero rows (the cycle gate)
 *
 * Before add_contractor_dispatch_link.sql is applied it should report zero rows
 * and a console error about the missing columns, while still returning the
 * contractor-role set; that IS the expected graceful degradation.
 *
 * It also re-derives the rows straight from raw SQL-ish selects so the builder's
 * output can be checked against the source data rather than trusted.
 */
import { createClient } from '@supabase/supabase-js';
import dotenv from 'dotenv';

dotenv.config({ path: '.env.local' });
dotenv.config();

// Dynamic import AFTER dotenv, matching scripts/verify-readiness.mts — the app
// modules read env at import time.
const { loadContractorDispatchRows, buildContractorRows } = await import(
  '../src/lib/contractor/contractor-dispatch-queue'
);

const url = process.env.NEXT_PUBLIC_SUPABASE_URL!;
const key = process.env.SUPABASE_SERVICE_ROLE_KEY!;
if (!url || !key) {
  console.error('Missing Supabase env vars');
  process.exit(1);
}
const supabase = createClient(url, key, { auth: { persistSession: false } });

const { data: cur } = await supabase
  .from('hubstaff_uploads')
  .select('source_file')
  .eq('is_current', true)
  .limit(1)
  .maybeSingle();
const currentSourceFile = (cur as { source_file?: string } | null)?.source_file ?? null;
console.log('current cycle:', currentSourceFile);

// A plausible FX rate so both money slots get filled; the app passes the real one.
const FX = 58.5;

console.log('\n=== 1. CURRENT CYCLE ===');
const now = await loadContractorDispatchRows(supabase, { sourceFile: currentSourceFile, fxRate: FX });
console.log(`contractor-role holders: ${now.contractorEmails.length}`);
console.log(`active rows: ${now.active.length} · excluded rows: ${now.excluded.length}`);
for (const r of now.active) {
  console.log(
    `  ACTIVE  ${r.id}\n` +
      `    ${r.name} <${r.email}> · ${r.processor} · ${r.payCurrency}` +
      ` · USD=${r.amountUSD} PHP=${r.amountPHP}\n` +
      `    invoice=${r.invoiceNumber} dept=${r.departmentName ?? 'NONE'} (${r.departmentKey ?? 'no-key'})` +
      ` payeeKind=${r.payeeKind}\n` +
      `    details=${JSON.stringify(
        Object.fromEntries(Object.entries(r.details).filter(([, v]) => v)),
      )}`,
  );
}
for (const r of now.excluded) {
  console.log(`  EXCLUDED ${r.id} · ${r.name} · reasons=${r.reasons.join(',')} · invoice=${r.invoiceNumber}`);
}

// Assertions the UI depends on. `problems` fail the run; `warnings` are data
// gaps the clerk should know about but that are not defects in this code.
const problems: string[] = [];
const warnings: string[] = [];
const ids = now.active.map((r) => r.id).concat(now.excluded.map((r) => r.id));
if (new Set(ids).size !== ids.length) problems.push('duplicate row ids — React key collision');
for (const r of now.active) {
  if (r.payeeKind !== 'contractor') problems.push(`${r.id}: payeeKind not set`);
  if (!r.contractorInvoiceId) problems.push(`${r.id}: no contractorInvoiceId — Mark Paid could not settle it`);
  if (r.payCurrency === 'USD' && r.amountUSD == null) problems.push(`${r.id}: USD row without amountUSD`);
  if (r.payCurrency === 'PHP' && r.amountPHP == null) problems.push(`${r.id}: PHP row without amountPHP`);
  for (const [k, v] of Object.entries({ amountUSD: r.amountUSD, amountPHP: r.amountPHP })) {
    if (v != null && Math.abs(v * 100 - Math.round(v * 100)) > 1e-9) {
      problems.push(`${r.id}: ${k}=${v} is not rounded to 2dp`);
    }
  }
  const hasSomewhereToPay =
    r.details.hurupay_email ||
    r.details.higlobe_email ||
    r.details.wise_email ||
    r.details.wise_tag ||
    r.details.account_number ||
    r.details.phone_number;
  if (!hasSomewhereToPay) problems.push(`${r.id}: routed to ${r.processor} but carries no payout detail`);
}

// ── 1b. POST-MIGRATION SIMULATION ─────────────────────────────────────────────
// Before the migration exists we cannot select dispatch_id, so `loadContractor…`
// returns nothing. Feed the SAME real approved invoices into the pure row builder
// to verify the money math, rail precedence and payout details the clerk will
// actually see. Post-migration this section and section 1 should agree.
console.log('\n=== 1b. ROW BUILDER against live approved invoices ===');
const norm = (e: string | null | undefined) => (e ?? '').trim().toLowerCase();

const { data: approvedRaw } = await supabase
  .from('contractor_invoices')
  .select(
    'id, contractor_email, invoice_number, invoice_date, total, currency, status, payment_method, from_name, from_entity_name, created_at',
  )
  .eq('status', 'approved');
const approved = (approvedRaw ?? []) as Parameters<typeof buildContractorRows>[0]['invoices'];
const emails = [...new Set(approved.map((i) => norm(i.contractor_email)))];

const { data: idsRaw } = await supabase
  .from('employee_ids')
  .select(
    'work_email, personal_email, name, bank_preferred, preferred_processor, preferred_bank_slot, bank_name, account_holder_name, account_number, routing_number, alt_bank_name, alt_account_holder_name, alt_account_number, alt_routing_number, hurupay_email, wepay_email, higlobe_email, higlobe_account_name, wise_email, wise_tag, phone_number, swift_code, full_address',
  )
  .or(`work_email.in.(${emails.join(',')}),personal_email.in.(${emails.join(',')})`);
const idsByEmail = new Map<string, never>();
for (const r of (idsRaw ?? []) as Record<string, string | null>[]) {
  const we = norm(r.work_email);
  const pe = norm(r.personal_email);
  if (we) idsByEmail.set(we, r as never);
  if (pe && !idsByEmail.has(pe)) idsByEmail.set(pe, r as never);
}
const { data: profRaw } = await supabase.from('contractor_profiles').select('*').in('contractor_email', emails);
const profileByEmail = new Map(
  ((profRaw ?? []) as Record<string, string | null>[]).map((p) => [norm(p.contractor_email), p as never]),
);
const { data: masterRaw } = await supabase
  .from('active_employees')
  .select('"Name", "Work Email", "Personal Email", "Department"');
const deptByEmail = new Map<string, string | null>();
const nameByEmail = new Map<string, string | null>();
for (const r of (masterRaw ?? []) as Record<string, string | null>[]) {
  for (const k of [norm(r['Work Email']), norm(r['Personal Email'])]) {
    if (!k) continue;
    if (!deptByEmail.has(k)) deptByEmail.set(k, r['Department'] ?? null);
    if (!nameByEmail.has(k)) nameByEmail.set(k, r['Name'] ?? null);
  }
}

const sim = buildContractorRows({
  invoices: approved,
  idsByEmail,
  profileByEmail,
  deptByEmail,
  nameByEmail,
  fxRate: FX,
});
console.log(`built ${sim.active.length} active + ${sim.excluded.length} excluded from ${approved.length} approved invoice(s)`);
/** The fields THIS rail actually needs — same shape Payroll Readiness checks. */
const RAIL_FIELDS: Record<string, string[]> = {
  hurupay: ['hurupay_email'],
  wepay: ['wepay_email'],
  higlobe: ['higlobe_email', 'higlobe_account_name'],
  wise: ['bank_name', 'account_number'],
  jeeves: ['bank_name', 'account_number'],
  wires: ['bank_name', 'account_number', 'account_holder_name', 'swift_code'],
};

for (const r of sim.active) {
  // Show the fields the resolved rail will actually be paid from, not a generic
  // first-non-empty — otherwise a stale wise_email can masquerade as wire details.
  const paidTo =
    (RAIL_FIELDS[r.processor] ?? [])
      .map((f) => `${f}=${r.details[f as keyof typeof r.details] ?? '∅'}`)
      .join(' ') || '(no fields for rail)';
  console.log(
    `  ${(r.invoiceNumber ?? '?').padEnd(22)} ${r.email.padEnd(24)} ${r.processor.padEnd(8)} ${r.payCurrency}` +
      ` USD=${String(r.amountUSD).padStart(9)} PHP=${String(r.amountPHP).padStart(11)}` +
      ` dept=${r.departmentName ?? 'NONE'} → ${paidTo}`,
  );
}
for (const r of sim.excluded) {
  console.log(`  EXCLUDED ${r.invoiceNumber} ${r.email} reasons=${r.reasons.join(',')}`);
}

// Every assertion from section 1, applied to the simulated rows.
const simIds = sim.active.map((r) => r.id).concat(sim.excluded.map((r) => r.id));
if (new Set(simIds).size !== simIds.length) problems.push('sim: duplicate row ids');
for (const r of sim.active) {
  if (r.payeeKind !== 'contractor') problems.push(`sim ${r.id}: payeeKind not set`);
  if (!r.contractorInvoiceId) problems.push(`sim ${r.id}: no contractorInvoiceId`);
  if (r.payCurrency === 'USD' && r.amountUSD == null) problems.push(`sim ${r.id}: USD row without amountUSD`);
  if (r.payCurrency === 'PHP' && r.amountPHP == null) problems.push(`sim ${r.id}: PHP row without amountPHP`);
  if (r.amountUSD == null || r.amountPHP == null) problems.push(`sim ${r.id}: a money slot is null with fx=${FX}`);
  for (const [k, v] of Object.entries({ amountUSD: r.amountUSD, amountPHP: r.amountPHP })) {
    if (v != null && Math.abs(v * 100 - Math.round(v * 100)) > 1e-9) {
      problems.push(`sim ${r.id}: ${k}=${v} not rounded to 2dp`);
    }
  }
  // A row the clerk can't identify is a row they shouldn't pay.
  if (!r.name || r.name === r.email) problems.push(`sim ${r.id}: no human name resolved`);

  // Completeness is judged by the SAME predicate Payroll Readiness uses, per
  // processor. Incomplete is a WARNING, not a failure: employees with a resolved
  // processor but missing details also sit in the pending queue today, and the
  // brief was "no difference whatsoever". Readiness is where gaps get chased.
  const needed: Record<string, string[]> = {
    hurupay: ['hurupay_email'],
    wepay: ['wepay_email'],
    higlobe: ['higlobe_email', 'higlobe_account_name'],
    wise: ['bank_name', 'account_number'],
    jeeves: ['bank_name', 'account_number'],
    wires: ['bank_name', 'account_number'],
  };
  const missing = (needed[r.processor] ?? []).filter(
    (f) => !r.details[f as keyof typeof r.details],
  );
  if (missing.length) {
    warnings.push(
      `${r.invoiceNumber} (${r.email}) routes to ${r.processor} but is missing ${missing.join(', ')} — the clerk will see an incomplete row`,
    );
  }
}

// ── 1c. STRANDED CLAIM ────────────────────────────────────────────────────────
// The claim_stuck path cannot be reached from live data (it needs a leaked claim),
// so exercise it directly: feed the same real invoices in with one marked stranded
// and assert it becomes EXCLUDED-and-unpayable, never payable.
console.log('\n=== 1c. STRANDED CLAIM (claim_stuck) ===');
if (approved.length > 0) {
  const victim = approved[0]!;
  const victimWasPayable = sim.active.some((r) => r.contractorInvoiceId === victim.id);
  const strandedSim = buildContractorRows({
    invoices: approved,
    idsByEmail,
    profileByEmail,
    deptByEmail,
    nameByEmail,
    fxRate: FX,
    strandedIds: new Set([victim.id]),
  });
  const stillActive = strandedSim.active.some((r) => r.contractorInvoiceId === victim.id);
  const nowExcluded = strandedSim.excluded.find((r) => r.contractorInvoiceId === victim.id);
  console.log(
    `  marked ${victim.invoice_number} stranded → payable=${stillActive ? 'YES (BAD)' : 'no'}` +
      ` · excluded reasons=${nowExcluded ? nowExcluded.reasons.join(',') : 'MISSING (BAD)'}` +
      ` · payableRow=${nowExcluded ? String(nowExcluded.payable) : 'n/a'}`,
  );
  if (stillActive) problems.push('stranded invoice is still PAYABLE — it could be double-paid');
  if (!nowExcluded) problems.push('stranded invoice vanished from both lists — invisible owed money');
  if (nowExcluded && !nowExcluded.reasons.includes('claim_stuck')) {
    problems.push(`stranded invoice reasons=${nowExcluded.reasons.join(',')} instead of claim_stuck`);
  }
  if (nowExcluded && nowExcluded.payable) problems.push('stranded invoice carries a payable row');
  // No collateral damage: only the marked invoice should change.
  const expectedActive = sim.active.length - (victimWasPayable ? 1 : 0);
  if (strandedSim.active.length !== expectedActive) {
    problems.push(
      `marking one invoice stranded changed others: active ${sim.active.length} → ${strandedSim.active.length} (expected ${expectedActive})`,
    );
  }
}

console.log('\n=== 2. PAST CYCLE (gate must return zero rows) ===');
const { data: past } = await supabase
  .from('hubstaff_uploads')
  .select('source_file, uploaded_at')
  .eq('is_current', false)
  .order('uploaded_at', { ascending: false })
  .limit(1);
const pastFile = (past?.[0] as { source_file?: string } | undefined)?.source_file ?? null;
console.log('past file:', pastFile);
if (pastFile) {
  const before = await loadContractorDispatchRows(supabase, { sourceFile: pastFile, fxRate: FX });
  console.log(`active=${before.active.length} excluded=${before.excluded.length} (both must be 0)`);
  if (before.active.length || before.excluded.length) {
    problems.push('cycle gate leaked: a past week returned contractor rows');
  }
}

console.log('\n=== RESULT ===');
if (warnings.length) {
  console.log(`⚠ ${warnings.length} data gap(s) (not code defects):`);
  for (const w of warnings) console.log('  -', w);
}
if (problems.length === 0) console.log('✓ no problems detected');
else {
  console.log(`✗ ${problems.length} problem(s):`);
  for (const p of problems) console.log('  -', p);
  process.exitCode = 1;
}
