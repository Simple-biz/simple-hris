/**
 * READ-ONLY verifier for the wizard-staged safety net in Payment Dispatch.
 *
 * Runs the REAL `buildStagedOnlyPlacement()` — the exact production function
 * useDispatchQueue calls — against live rows, and prints where each staged payee
 * with NO `employee_hourly_rates` row would land (payable queue vs Excluded).
 *
 * These are the catalog-paid people: since the Payment Catalog became the rate
 * source of truth, they have no legacy rates row, so buildQueueFromRates can
 * never emit them and this net is the ONLY thing that surfaces them.
 *
 * Usage:
 *   node --import tsx scripts/verify-staged-only-dispatch.mts [source_file]
 *
 * Omitted [source_file] = the most recently staged cycle.
 */
import dotenv from 'dotenv';
dotenv.config({ path: '.env.local' });
dotenv.config();

const { createClient } = await import('@supabase/supabase-js');
const { buildStagedOnlyPlacement } = await import('../src/components/payroll-clerk/mock-queue');

const url = process.env.NEXT_PUBLIC_SUPABASE_URL?.trim();
const key = process.env.SUPABASE_SERVICE_ROLE_KEY?.trim();
if (!url || !key) {
  console.error('Missing NEXT_PUBLIC_SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY');
  process.exit(1);
}
const supabase = createClient(url, key, {
  auth: { persistSession: false, autoRefreshToken: false },
});

const PAGE = 1000;
async function pageAll<T>(
  build: (from: number) => PromiseLike<{ data: T[] | null; error: { message: string } | null }>,
): Promise<T[]> {
  const out: T[] = [];
  for (let from = 0; ; from += PAGE) {
    const { data, error } = await build(from);
    if (error) throw new Error(error.message);
    const rows = data ?? [];
    out.push(...rows);
    if (rows.length < PAGE) break;
  }
  return out;
}

// -- Which cycle ------------------------------------------------------------
let sourceFile = process.argv[2]?.trim() || null;
if (!sourceFile) {
  const { data, error } = await supabase
    .from('paystub_dispatch_queue')
    .select('cycle_source_file, created_at')
    .order('created_at', { ascending: false })
    .limit(1);
  if (error) throw new Error(error.message);
  sourceFile = data?.[0]?.cycle_source_file ?? null;
}
if (!sourceFile) {
  console.log('No staged cycle found.');
  process.exit(0);
}
console.log(`Cycle: ${sourceFile}\n`);

// -- Staged payees (the payroll-authoritative payee list) -------------------
type StagedRow = {
  recipient_email: string;
  personal_email: string | null;
  recipient_name: string | null;
  department_key: string | null;
  amount_php: number | null;
  amount_usd: number | null;
  excluded: boolean;
  sent_at: string | null;
};
const staged = await pageAll<StagedRow>((from) =>
  supabase
    .from('paystub_dispatch_queue')
    .select(
      'recipient_email, personal_email, recipient_name, department_key, amount_php, amount_usd, excluded, sent_at',
    )
    .eq('cycle_source_file', sourceFile!)
    .order('recipient_email')
    .range(from, from + PAGE - 1),
);

// -- Who already has a rates row (buildQueueFromRates emits those) ----------
const ratesRows = await pageAll<{ 'Work Email': string | null; 'Personal Email': string | null }>((from) =>
  supabase.from('employee_hourly_rates').select('"Work Email","Personal Email"').range(from, from + PAGE - 1),
);
const rateEmails = new Set<string>();
for (const r of ratesRows) {
  if (r['Work Email']) rateEmails.add(r['Work Email'].trim().toLowerCase());
  if (r['Personal Email']) rateEmails.add(r['Personal Email'].trim().toLowerCase());
}

// -- employee_ids, indexed exactly like useDispatchQueue's buildIdsMap ------
const idsRows = await pageAll<Record<string, unknown>>((from) =>
  supabase.from('employee_ids').select('*').range(from, from + PAGE - 1),
);
const idsByEmail = new Map<string, Parameters<typeof buildStagedOnlyPlacement>[0]['idsRow']>();
for (const r of idsRows) {
  const we = (r.work_email as string | null)?.trim().toLowerCase();
  const pe = (r.personal_email as string | null)?.trim().toLowerCase();
  const row = r as unknown as Parameters<typeof buildStagedOnlyPlacement>[0]['idsRow'];
  if (we) idsByEmail.set(we, row);
  if (pe && !idsByEmail.has(pe)) idsByEmail.set(pe, row);
}

// -- Place each staged-only payee through the REAL production function ------
let payable = 0;
let blocked = 0;
let payablePhp = 0;
let blockedPhp = 0;
const lines: string[] = [];

for (const s of staged) {
  const email = s.recipient_email.trim().toLowerCase();
  const personal = s.personal_email?.trim().toLowerCase() ?? null;
  if (rateEmails.has(email) || (personal && rateEmails.has(personal))) continue;

  const placement = buildStagedOnlyPlacement({
    staged: s,
    idsRow: idsByEmail.get(email) ?? (personal ? idsByEmail.get(personal) : undefined),
    // Hours/breakdown come from /api/payroll-current-pay in the app; absent here,
    // which the function tolerates (hours degrade to null, pay stays staged).
    pay: undefined,
  });

  const amount = `P${String(s.amount_php ?? '-')}`.padEnd(11);
  if (placement.kind === 'pending') {
    payable += 1;
    payablePhp += s.amount_php ?? 0;
    const d = placement.row.details;
    const dest = d.bank_name ?? d.hurupay_email ?? d.higlobe_email ?? d.wise_email ?? 'NO DETAILS';
    lines.push(`  PAYABLE   ${placement.row.processor.padEnd(8)} ${amount} ${email}  [${dest}]`);
  } else {
    blocked += 1;
    blockedPhp += s.amount_php ?? 0;
    lines.push(
      `  EXCLUDED  ${placement.row.reasons.join('+').padEnd(8)} ${amount} ${email}  ` +
        `payable=${placement.row.payable ? 'yes' : 'no'}`,
    );
  }
}

console.log(`Staged payees with NO rates row: ${payable + blocked} of ${staged.length}`);
console.log(`  -> payable queue: ${payable}  (P${payablePhp.toLocaleString('en-PH')})`);
console.log(`  -> Excluded:      ${blocked}  (P${blockedPhp.toLocaleString('en-PH')})\n`);
for (const l of lines.sort()) console.log(l);
