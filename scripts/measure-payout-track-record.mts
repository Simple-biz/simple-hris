/**
 * READ-ONLY: can the payment log say "this account has been paid N times with no
 * problems", and how often do the two mistakes Kane named already sit on file?
 *
 *   node --import tsx scripts/measure-payout-track-record.mts
 *
 * Kane, 2026-10-07: show employees how many times their current account has been
 * paid successfully, and warn them before they change it: card numbers instead of
 * account numbers, closed accounts, and paying into a spouse's or anyone else's
 * account. Before the guards were designed this measured, against production:
 *
 *   A. `payment_dispatches`: rows by status and payee type, and how many employee
 *      `paid` rows carry no account snapshot at all (those can never match).
 *   B. Per `employee_ids` row: the CURRENT destination (the paid bank slot's account
 *      digits, or the wallet email on a wallet rail) matched against the dispatch
 *      snapshots. Distribution of paid-to-this-account counts and problem counts.
 *   C. Card-shaped numbers: 13–19 digits, Luhn-valid, a card-network prefix. How many
 *      are stored now, and how many of them were PAID SUCCESSFULLY anyway (a hard
 *      block would then refuse a working account).
 *   D. Account holder name vs the person's own name on the row: match / mismatch /
 *      blank, by the same pure rule the save routes use.
 *
 * TOTALS ONLY on stdout. No name, no email, no account number, no note text.
 * READ-ONLY BY CONSTRUCTION: plain `select` only, every read paged (PostgREST
 * truncates at 1000 rows). `.env.local` holds PRODUCTION credentials.
 */
import dotenv from 'dotenv';

dotenv.config({ path: '.env.local' });
dotenv.config();

const { createSupabaseServiceRoleClient } = await import('../src/lib/supabase/server');
const { selectAllPaged } = await import('../src/lib/supabase/select-all-paged');
const {
  looksLikeCardNumber,
  holderNameVerdict,
  payoutDestinationKey,
  snapshotDestinationKey,
} = await import('../src/lib/banking/payout-change-safety');
const { resolveEffectivePayoutProcessor } = await import('../src/lib/employee/payout-completeness');

const sb = createSupabaseServiceRoleClient();
if (!sb) {
  console.error('No service-role client. Check .env.local');
  process.exit(1);
}

type Dispatch = {
  id: string;
  recipient_email: string | null;
  recipient_account_number: string | null;
  status: string | null;
  payee_type: string | null;
};

const dispatchRead = await selectAllPaged<Dispatch>((from, to) =>
  sb
    .from('payment_dispatches')
    .select('id, recipient_email, recipient_account_number, status, payee_type')
    .order('id', { ascending: true })
    .range(from, to),
);
if (dispatchRead.error) throw new Error(`payment_dispatches: ${dispatchRead.error}`);
const dispatches = dispatchRead.rows;

const idsRead = await selectAllPaged<Record<string, unknown>>((from, to) =>
  sb
    .from('employee_ids')
    .select(
      'employee_id, name, work_email, personal_email, preferred_processor, bank_preferred, preferred_bank_slot, bank_name, alt_bank_name, account_holder_name, alt_account_holder_name, account_number, alt_account_number, hurupay_email, wepay_email, higlobe_email, wise_email, wise_tag, phone_number, swift_code, routing_number, alt_routing_number',
    )
    .order('employee_id', { ascending: true })
    .range(from, to),
);
if (idsRead.error) throw new Error(`employee_ids: ${idsRead.error}`);
const ids = idsRead.rows;

const tally = (m: Map<string, number>, k: string) => m.set(k, (m.get(k) ?? 0) + 1);
const print = (title: string, m: Map<string, number>) => {
  console.log(`  ${title}`);
  for (const [k, v] of [...m.entries()].sort((a, b) => b[1] - a[1])) console.log(`    ${k.padEnd(28)} ${v}`);
};

// ── A ───────────────────────────────────────────────────────────────────────
console.log(`A. payment_dispatches: ${dispatches.length} rows`);
const byStatus = new Map<string, number>();
const byType = new Map<string, number>();
let paidNoSnapshot = 0;
let nonLowerEmail = 0;
for (const d of dispatches) {
  tally(byStatus, d.status ?? '(null)');
  tally(byType, d.payee_type ?? '(null)');
  if (d.status === 'paid' && d.payee_type !== 'contractor' && !String(d.recipient_account_number ?? '').trim()) {
    paidNoSnapshot += 1;
  }
  const e = d.recipient_email ?? '';
  if (e !== e.trim().toLowerCase()) nonLowerEmail += 1;
}
print('by status', byStatus);
print('by payee_type', byType);
console.log(`  employee paid rows with NO account snapshot: ${paidNoSnapshot}`);
console.log(`  rows whose recipient_email is not trimmed lowercase: ${nonLowerEmail}`);

// Index employee dispatch rows by lowercased recipient email.
const byEmail = new Map<string, Dispatch[]>();
for (const d of dispatches) {
  if (d.payee_type === 'contractor') continue;
  const e = (d.recipient_email ?? '').trim().toLowerCase();
  if (!e) continue;
  const list = byEmail.get(e) ?? [];
  list.push(d);
  byEmail.set(e, list);
}

// ── B ───────────────────────────────────────────────────────────────────────
const bucket = (n: number) => (n === 0 ? '0' : n < 5 ? '1-4' : n < 10 ? '5-9' : n < 20 ? '10-19' : '20+');
const paidDist = new Map<string, number>();
const problemDist = new Map<string, number>();
const destKind = new Map<string, number>();
let paidBeforeNotToCurrent = 0;
let withAnyPaid = 0;
let currentHasProblem = 0;
for (const row of ids) {
  const emails = [row.work_email, row.personal_email]
    .map((v) => String(v ?? '').trim().toLowerCase())
    .filter(Boolean);
  const rail = resolveEffectivePayoutProcessor(row);
  const dest = payoutDestinationKey(row, rail);
  tally(destKind, dest ? dest.kind : 'none');
  const rows = [...new Set(emails)].flatMap((e) => byEmail.get(e) ?? []);
  const anyPaid = rows.some((d) => d.status === 'paid');
  if (anyPaid) withAnyPaid += 1;
  if (!dest) continue;
  let paid = 0;
  let problem = 0;
  for (const d of rows) {
    const snap = snapshotDestinationKey(d.recipient_account_number);
    if (!snap || snap.kind !== dest.kind || snap.value !== dest.value) continue;
    if (d.status === 'paid') paid += 1;
    else if (d.status === 'problem') problem += 1;
  }
  tally(paidDist, bucket(paid));
  tally(problemDist, bucket(problem));
  if (problem > 0) currentHasProblem += 1;
  if (anyPaid && paid === 0) paidBeforeNotToCurrent += 1;
}
console.log(`\nB. employee_ids: ${ids.length} rows; ${withAnyPaid} have ≥1 paid dispatch under their emails`);
print('current destination kind', destKind);
print('paid-to-CURRENT-destination count', paidDist);
print('problem-to-CURRENT-destination count', problemDist);
console.log(`  rows paid before but NEVER to the current destination: ${paidBeforeNotToCurrent}`);
console.log(`  rows whose current destination has ≥1 problem row: ${currentHasProblem}`);

// ── C ───────────────────────────────────────────────────────────────────────
let cardStored = 0;
let cardStoredPaid = 0;
let sixteenDigit = 0;
const paidSnapCard = { paid: 0, problem: 0, other: 0 };
for (const row of ids) {
  for (const col of ['account_number', 'alt_account_number'] as const) {
    const v = String(row[col] ?? '');
    const digits = v.replace(/\D/g, '');
    if (digits.length === 16) sixteenDigit += 1;
    if (!looksLikeCardNumber(v)) continue;
    cardStored += 1;
    const emails = [row.work_email, row.personal_email]
      .map((x) => String(x ?? '').trim().toLowerCase())
      .filter(Boolean);
    const paid = [...new Set(emails)]
      .flatMap((e) => byEmail.get(e) ?? [])
      .some((d) => d.status === 'paid' && String(d.recipient_account_number ?? '').replace(/\D/g, '') === digits);
    if (paid) cardStoredPaid += 1;
  }
}
for (const d of dispatches) {
  if (!looksLikeCardNumber(d.recipient_account_number)) continue;
  if (d.status === 'paid') paidSnapCard.paid += 1;
  else if (d.status === 'problem') paidSnapCard.problem += 1;
  else paidSnapCard.other += 1;
}
console.log(`\nC. card-shaped numbers`);
console.log(`  stored in employee_ids (either slot): ${cardStored} (of ${sixteenDigit} 16-digit values)`);
console.log(`  of those, PAID successfully to that exact number at least once: ${cardStoredPaid}`);
console.log(`  dispatch snapshots card-shaped: paid ${paidSnapCard.paid} · problem ${paidSnapCard.problem} · other ${paidSnapCard.other}`);

// ── D ───────────────────────────────────────────────────────────────────────
const holder = new Map<string, number>();
for (const row of ids) {
  const rail = resolveEffectivePayoutProcessor(row);
  if (!rail || !['wires', 'wise', 'jeeves'].includes(rail)) continue;
  const alt = row.preferred_bank_slot === 'alternative';
  const h = String((alt ? row.alt_account_holder_name : row.account_holder_name) ?? row.account_holder_name ?? '');
  tally(holder, holderNameVerdict(h, [String(row.name ?? '')]));
}
console.log(`\nD. bank-rail rows: paid-slot holder name vs the row's own name`);
print('verdict', holder);
