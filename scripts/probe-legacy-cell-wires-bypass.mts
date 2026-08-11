/**
 * READ-ONLY: measure the WIRES-lock bypass on the legacy rates-sheet cell.
 *
 *   node --import tsx scripts/probe-legacy-cell-wires-bypass.mts
 *
 * The open question (bank-preferred-routing.md:76-82, memory wires-lock-shipped,
 * Monday row 12620645283 "decision + guard"): Payment Dispatch resolves the rail
 * as `employee_ids.bank_preferred` -> `employee_ids.preferred_processor` ->
 * the legacy free-text `employee_hourly_rates."Bank Preferred"` cell. The WIRES
 * lock (§4) says someone whose stored `bank_preferred` is null IS wires-preferred
 * and may never be moved to hurupay/higlobe. Yet for exactly those people, a
 * sheet cell reading "Hurupay" still routes them to Hurupay.
 *
 * But §6 of the same doc says the CSV seed made that cell the INTENDED source of
 * truth for ~1,351 people, deliberately clearing `preferred_processor` for 466 so
 * the cell would win. Guarding the cell therefore re-routes real, currently-paid
 * people onto wires. This script says exactly how many, and who.
 *
 * READ-ONLY BY CONSTRUCTION — plain `select` only. `.env.local` holds PRODUCTION
 * service-role credentials, so nothing here may write.
 */
import { createClient } from '@supabase/supabase-js';
import dotenv from 'dotenv';

dotenv.config({ path: '.env.local' });
dotenv.config();

const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
if (!url || !serviceKey) {
  console.error('need NEXT_PUBLIC_SUPABASE_URL + SUPABASE_SERVICE_ROLE_KEY');
  process.exit(1);
}
const db = createClient(url, serviceKey, { auth: { persistSession: false } });

const norm = (v: unknown): string => String(v ?? '').trim().toLowerCase();

/** Byte-for-byte the mapper Payment Dispatch uses
 *  (`processorIdFromBankPreferredText`, employee-payment-processors.ts:62). */
function processorIdFromText(raw: unknown): string | null {
  if (raw == null) return null;
  const v = String(raw).trim().toLowerCase().replace(/\s+/g, '');
  if (!v) return null;
  if (v === 'hurupay' || v === 'huru' || v === 'huropay') return 'hurupay';
  if (v === 'wepay') return 'wepay';
  if (v === 'higlobe' || v === 'higloble' || v === 'higlobel') return 'higlobe';
  if (v === 'wise' || v === 'transferwise') return 'wise';
  if (v === 'jeeves') return 'jeeves';
  if (/^x?\d{3,5}$/.test(v) || v === 'wire' || v === 'wires' || v.startsWith('wire')) return 'wires';
  return null;
}

async function selectAllPaged<T>(table: string, cols: string): Promise<T[]> {
  const PAGE = 1000;
  const out: T[] = [];
  for (let from = 0; ; from += PAGE) {
    const { data, error } = await db.from(table).select(cols).range(from, from + PAGE - 1);
    if (error) throw new Error(`${table}: ${error.message}`);
    const rows = (data ?? []) as unknown as T[];
    out.push(...rows);
    if (rows.length < PAGE) break;
  }
  return out;
}

async function main(): Promise<void> {
  const ids = await selectAllPaged<Record<string, unknown>>(
    'employee_ids',
    'work_email,personal_email,bank_preferred,preferred_processor,hurupay_email,higlobe_email,' +
      'bank_name,account_number,alt_bank_name,alt_account_number,wise_email',
  );
  const idsByEmail = new Map<string, Record<string, unknown>>();
  for (const r of ids) {
    for (const col of ['work_email', 'personal_email']) {
      const em = norm(r[col]);
      if (em && !idsByEmail.has(em)) idsByEmail.set(em, r);
    }
  }

  // The rates table's columns are quoted, human-typed sheet headers with several
  // historical spellings (see mapEmployeeHourlyRateRow) — select * and look the
  // fields up alias-tolerantly rather than guessing a name.
  const rates = await selectAllPaged<Record<string, unknown>>('employee_hourly_rates', '*');
  const field = (row: Record<string, unknown>, names: string[]): unknown => {
    const idx = new Map<string, unknown>();
    for (const [k, v] of Object.entries(row)) idx.set(k.trim().toLowerCase().replace(/\s+/g, ' '), v);
    for (const n of names) {
      const hit = idx.get(n.trim().toLowerCase().replace(/\s+/g, ' '));
      if (hit != null && String(hit).trim() !== '') return hit;
    }
    return null;
  };

  // Active roster, so "who is actually being paid" is separable from data debt.
  const active = await selectAllPaged<Record<string, unknown>>(
    'active_employees',
    '"Work Email","Personal Email",Department,Name',
  );
  const activeByEmail = new Map<string, Record<string, unknown>>();
  for (const r of active) {
    for (const col of ['Work Email', 'Personal Email']) {
      const em = norm(r[col]);
      if (em && !activeByEmail.has(em)) activeByEmail.set(em, r);
    }
  }

  console.log('=== WIRES lock: legacy rates-sheet cell bypass — live blast radius ===\n');
  console.log(`employee_ids .......... ${ids.length} rows`);
  console.log(`employee_hourly_rates . ${rates.length} rows`);
  console.log(`active_employees ...... ${active.length} rows\n`);

  interface Hit {
    email: string;
    cell: string;
    routed: string;
    active: boolean;
    dept: string;
    name: string;
    hasIdsRow: boolean;
    /** Can the wallet actually pay them today? */
    walletEmail: boolean;
    wireDetails: boolean;
  }
  const hits: Hit[] = [];
  const seen = new Set<string>();

  for (const r of rates) {
    const email = norm(field(r, ['Work Email', 'work_email'])) || norm(field(r, ['Personal Email', 'personal_email']));
    if (!email || seen.has(email)) continue;
    seen.add(email);

    const cellRaw = field(r, ['Bank Preferred', 'bank_preferred', 'Bank preferred', 'BankPreferred']);
    const routed = processorIdFromText(cellRaw);
    // Only hurupay/higlobe are forbidden destinations under the WIRES lock.
    if (routed !== 'hurupay' && routed !== 'higlobe') continue;

    const idRow = idsByEmail.get(email);
    // The bypass needs BOTH higher tiers empty — otherwise the cell never wins.
    const stored = norm(idRow?.['bank_preferred']);
    const disb = norm(idRow?.['preferred_processor']);
    if (stored || disb) continue;

    const act = activeByEmail.get(email);
    const walletCol = routed === 'hurupay' ? 'hurupay_email' : 'higlobe_email';
    const sheetWallet =
      routed === 'hurupay'
        ? field(r, ['Hurupay Email', 'hurupay_email', 'HuruPay Email Account', 'Hurupay Email Account'])
        : field(r, ['HiGlobe Email', 'higlobe_email', 'HiGlobe  Email', 'Higlobe Email']);
    hits.push({
      email,
      cell: String(cellRaw ?? '').trim(),
      routed,
      active: !!act,
      dept: String(act?.['Department'] ?? ''),
      name: String(act?.['Name'] ?? ''),
      hasIdsRow: !!idRow,
      walletEmail: !!(norm(idRow?.[walletCol]) || norm(sheetWallet)),
      // isPayoutComplete accepts wire details from EITHER slot (PD's pickFirst
      // falls back primary <-> alternative), so both must be checked.
      wireDetails:
        !!(norm(idRow?.['bank_name']) || norm(idRow?.['alt_bank_name'])) &&
        !!(norm(idRow?.['account_number']) || norm(idRow?.['alt_account_number'])),
    });
  }

  const activeHits = hits.filter((h) => h.active);
  console.log(`TOTAL people the legacy cell routes to a wallet with BOTH higher tiers null: ${hits.length}`);
  console.log(`  …of whom are on the ACTIVE roster (would change rail on the next run): ${activeHits.length}\n`);

  const byRail = new Map<string, number>();
  for (const h of activeHits) byRail.set(h.routed, (byRail.get(h.routed) ?? 0) + 1);
  console.log('Active, by rail the cell routes them to:');
  for (const [rail, n] of [...byRail.entries()].sort((a, b) => b[1] - a[1])) {
    console.log(`  ${String(n).padStart(4)}  ${rail}`);
  }

  const payableNow = activeHits.filter((h) => h.walletEmail);
  const strandedNow = activeHits.filter((h) => !h.walletEmail);
  console.log(`\nOf the ${activeHits.length} active — payable TODAY on the cell's wallet rail:`);
  console.log(`  ${String(payableNow.length).padStart(4)}  yes, they have the wallet email`);
  console.log(`  ${String(strandedNow.length).padStart(4)}  no wallet email — the cell already routes them somewhere that cannot pay them`);

  // The decisive question: after a guard flips them to WIRES, can they be paid?
  // isPayoutComplete judges `wires` on employee_ids bank details only —
  // PayoutLegacyExtras carries wallet emails, never wire details.
  const survives = activeHits.filter((h) => h.wireDetails);
  const stranded = activeHits.filter((h) => !h.wireDetails);
  const strandedButPaidToday = stranded.filter((h) => h.walletEmail);
  console.log(`\nAFTER a guard flips all ${activeHits.length} to WIRES:`);
  console.log(`  ${String(survives.length).padStart(4)}  have wire details in EITHER bank slot — still payable`);
  console.log(`  ${String(stranded.length).padStart(4)}  have NO wire details in either slot — become no_bank, unpayable`);
  console.log(`  ${String(strandedButPaidToday.length).padStart(4)}  …of those are being paid FINE today on the wallet rail (the real cost)`);

  const byDept = new Map<string, number>();
  for (const h of activeHits) byDept.set(h.dept || '(no dept)', (byDept.get(h.dept || '(no dept)') ?? 0) + 1);
  console.log('\nActive, by department:');
  for (const [dept, n] of [...byDept.entries()].sort((a, b) => b[1] - a[1]).slice(0, 15)) {
    console.log(`  ${String(n).padStart(4)}  ${dept}`);
  }

  console.log('\nFirst 25 active people a guard would re-route:');
  console.log(`  ${'email'.padEnd(34)} ${'cell'.padEnd(10)} ${'→'.padEnd(8)} wallet? wire?  dept`);
  for (const h of activeHits.slice(0, 25)) {
    console.log(
      `  ${h.email.padEnd(34)} ${h.cell.slice(0, 9).padEnd(10)} ${h.routed.padEnd(8)} ` +
        `${(h.walletEmail ? 'yes' : 'NO ').padEnd(7)} ${(h.wireDetails ? 'yes' : 'NO ').padEnd(6)} ${h.dept}`,
    );
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
