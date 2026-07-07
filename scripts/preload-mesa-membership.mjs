// Preload MESA membership from the mesa_ledger backfill into employee_hourly_rates.
//
// Everyone in the ledger has already opted in, so we mark them as active MESA
// members (mesa_member=true) — which is exactly the flag the Payroll Wizard
// reads to deduct ₱100/week. Enrollment date (mesa_member_since) is stamped to
// each member's FIRST recorded deposit so the Wizard charges the correct weeks.
//
// Scope (confirmed): enroll everyone EXCEPT members explicitly marked Inactive
// (they opted out). Members with no deposit history are stamped with today's
// Manila date since there's no deposit to anchor to.
//
// The rates table is snapshotted per upload (many rows per email), so — like
// /api/toggle-mesa-member — we update ALL rows for a matched email.
//
// SAFE BY DEFAULT: dry-run unless you pass --apply.
//   node scripts/preload-mesa-membership.mjs          # dry-run report
//   node scripts/preload-mesa-membership.mjs --apply   # write changes

import { createClient } from '@supabase/supabase-js';
import dotenv from 'dotenv';

dotenv.config({ path: '.env.local' });
dotenv.config();

const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
if (!url || !key) {
  console.error('Missing NEXT_PUBLIC_SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY');
  process.exit(1);
}
const APPLY = process.argv.includes('--apply');
const RATES_TABLE = process.env.NEXT_PUBLIC_SUPABASE_EMPLOYEE_HOURLY_RATES_TABLE?.trim() || 'employee_hourly_rates';

const supabase = createClient(url, key, { auth: { persistSession: false, autoRefreshToken: false } });

const manilaToday = new Intl.DateTimeFormat('en-CA', {
  timeZone: 'Asia/Manila',
  year: 'numeric',
  month: '2-digit',
  day: '2-digit',
}).format(new Date());

// ── 1. Aggregate the ledger per member ──────────────────────────────────────
async function loadLedger() {
  let all = [];
  for (let from = 0; ; from += 1000) {
    const { data, error } = await supabase
      .from('mesa_ledger')
      .select('email,name,status,total_daily_deposit_php,deposit_date')
      .range(from, from + 999);
    if (error) throw new Error('mesa_ledger read: ' + error.message);
    all = all.concat(data);
    if (data.length < 1000) break;
  }
  const byEmail = new Map();
  for (const r of all) {
    const e = (r.email || '').trim().toLowerCase();
    if (!e) continue;
    if (!byEmail.has(e)) byEmail.set(e, []);
    byEmail.get(e).push(r);
  }
  const members = [];
  for (const [email, rows] of byEmail) {
    let status = null, statusDate = '', firstDeposit = null, name = null;
    for (const r of rows) {
      if (r.status) {
        const d = r.deposit_date || '';
        if (status === null || d >= statusDate) { status = r.status; statusDate = d; }
      }
      if ((r.total_daily_deposit_php || 0) > 0 && r.deposit_date) {
        if (!firstDeposit || r.deposit_date < firstDeposit) firstDeposit = r.deposit_date;
      }
      if (!name && r.name) name = r.name;
    }
    members.push({ email, name, status, firstDeposit });
  }
  return members;
}

// ── 2. Enroll each eligible member ──────────────────────────────────────────
async function main() {
  const members = await loadLedger();
  const inactive = members.filter((m) => m.status === 'Inactive');
  const enroll = members.filter((m) => m.status !== 'Inactive');

  console.log(`Ledger members: ${members.length}`);
  console.log(`  → enrolling (not Inactive): ${enroll.length}`);
  console.log(`  → skipping (Inactive/opted-out): ${inactive.length}`);
  console.log(`Mode: ${APPLY ? 'APPLY (writing)' : 'DRY-RUN (no writes)'}\n`);

  let matched = 0, rowsTouched = 0, noDeposit = 0;
  const unmatched = [];

  // Small concurrency to keep it quick without hammering the API.
  const CHUNK = 15;
  for (let i = 0; i < enroll.length; i += CHUNK) {
    const slice = enroll.slice(i, i + CHUNK);
    await Promise.all(
      slice.map(async (m) => {
        const since = m.firstDeposit || manilaToday;
        if (!m.firstDeposit) noDeposit += 1;

        // Find matching rate rows by work email, else personal email (case-insensitive).
        const tryMatch = async (col) => {
          if (APPLY) {
            const { data, error } = await supabase
              .from(RATES_TABLE)
              .update({ mesa_member: true, mesa_member_since: since })
              .ilike(col, m.email)
              .select('id');
            if (error) throw new Error(`${m.email} update(${col}): ${error.message}`);
            return data?.length ?? 0;
          }
          const { data, error } = await supabase
            .from(RATES_TABLE)
            .select('id')
            .ilike(col, m.email);
          if (error) throw new Error(`${m.email} read(${col}): ${error.message}`);
          return data?.length ?? 0;
        };

        let n = await tryMatch('Work Email');
        if (n === 0) n = await tryMatch('Personal Email');
        if (n > 0) { matched += 1; rowsTouched += n; }
        else unmatched.push(m);
      }),
    );
    process.stdout.write(`\r  processed ${Math.min(i + CHUNK, enroll.length)}/${enroll.length}`);
  }
  console.log('');

  console.log(`\nMatched to a rate row: ${matched}/${enroll.length}`);
  console.log(`Rate rows ${APPLY ? 'updated' : 'that would update'}: ${rowsTouched}`);
  console.log(`Stamped with today's date (no deposit history): ${noDeposit}`);
  if (unmatched.length) {
    console.log(`\nNo rate row found for ${unmatched.length} ledger member(s) — reconcile emails:`);
    unmatched.slice(0, 40).forEach((m) => console.log(`  - ${m.email}  (${m.name ?? '—'})`));
    if (unmatched.length > 40) console.log(`  … and ${unmatched.length - 40} more`);
  }
  console.log(
    APPLY
      ? '\nDone. mesa_member=true + mesa_member_since set. The Payroll Wizard will now deduct ₱100/week for these members.'
      : '\nDry-run only. Re-run with --apply to write.',
  );
}

main().catch((e) => { console.error('\nFAILED:', e.message); process.exit(1); });
