// Backfill MESA FPU completion + opt-in confirmation dates from mesa_ledger
// into employee_hourly_rates.
//
// The MESA active export (mesa_ledger) carries, per member:
//   fpu_completion_date      -- when they completed Financial Peace University
//   optin_confirmation_sent  -- when Accounting sent their opt-in confirmation
//
// These populate mesa_fpu_completed_on / mesa_optin_confirmation_sent on the
// rates table (add via references/sql/alter/add_mesa_fpu_dates.sql). The employee
// Opt-in form pre-fills "Date you completed FPU" from mesa_fpu_completed_on.
//
// A member can appear on many ledger rows (one per deposit) and — for the 9 who
// re-took FPU — with more than one fpu_completion_date. We take the EARLIEST
// (their original completion), and likewise the earliest opt-in confirmation.
//
// The rates table is snapshotted per upload (many rows per email), so — like
// scripts/preload-mesa-membership.mjs — we update ALL rows for a matched email.
//
// SAFE BY DEFAULT: dry-run unless you pass --apply.
//   node scripts/backfill-mesa-fpu-dates.mjs           # dry-run report
//   node scripts/backfill-mesa-fpu-dates.mjs --apply    # write changes

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
const RATES_TABLE =
  process.env.NEXT_PUBLIC_SUPABASE_EMPLOYEE_HOURLY_RATES_TABLE?.trim() || 'employee_hourly_rates';

const supabase = createClient(url, key, { auth: { persistSession: false, autoRefreshToken: false } });

// Normalize a date/timestamp to a plain YYYY-MM-DD for a Postgres `date` column.
const toDate = (v) => {
  if (!v) return null;
  const s = String(v).trim();
  return /^\d{4}-\d{2}-\d{2}/.test(s) ? s.slice(0, 10) : null;
};
// Earliest non-null date wins (lexical compare is valid for YYYY-MM-DD).
const earlier = (a, b) => (!a ? b : !b ? a : a < b ? a : b);

// ── 1. Aggregate the ledger per member ──────────────────────────────────────
async function loadLedger() {
  let all = [];
  for (let from = 0; ; from += 1000) {
    const { data, error } = await supabase
      .from('mesa_ledger')
      .select('email,name,fpu_completion_date,optin_confirmation_sent')
      .range(from, from + 999);
    if (error) throw new Error('mesa_ledger read: ' + error.message);
    all = all.concat(data);
    if (data.length < 1000) break;
  }
  const byEmail = new Map();
  for (const r of all) {
    const e = (r.email || '').trim().toLowerCase();
    if (!e) continue;
    if (!byEmail.has(e)) byEmail.set(e, { email: e, name: r.name ?? null, fpu: null, optin: null });
    const m = byEmail.get(e);
    m.fpu = earlier(m.fpu, toDate(r.fpu_completion_date));
    m.optin = earlier(m.optin, toDate(r.optin_confirmation_sent));
    if (!m.name && r.name) m.name = r.name;
  }
  return [...byEmail.values()];
}

// ── 2. Stamp each member's rate rows ─────────────────────────────────────────
async function main() {
  const members = await loadLedger();
  const withFpu = members.filter((m) => m.fpu);

  console.log(`Ledger members: ${members.length}`);
  console.log(`  → with an FPU completion date: ${withFpu.length}`);
  console.log(`  → with an opt-in confirmation date: ${members.filter((m) => m.optin).length}`);
  console.log(`Mode: ${APPLY ? 'APPLY (writing)' : 'DRY-RUN (no writes)'}\n`);

  let matched = 0, rowsTouched = 0;
  const unmatched = [];

  const CHUNK = 15;
  for (let i = 0; i < members.length; i += CHUNK) {
    const slice = members.slice(i, i + CHUNK);
    await Promise.all(
      slice.map(async (m) => {
        if (!m.fpu && !m.optin) return; // nothing to stamp
        const patch = {
          mesa_fpu_completed_on: m.fpu,
          mesa_optin_confirmation_sent: m.optin,
        };

        const tryMatch = async (col) => {
          if (APPLY) {
            const { data, error } = await supabase
              .from(RATES_TABLE)
              .update(patch)
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
    process.stdout.write(`\r  processed ${Math.min(i + CHUNK, members.length)}/${members.length}`);
  }
  console.log('');

  console.log(`\nMatched to a rate row: ${matched}/${members.length}`);
  console.log(`Rate rows ${APPLY ? 'updated' : 'that would update'}: ${rowsTouched}`);
  if (unmatched.length) {
    console.log(`\nNo rate row found for ${unmatched.length} ledger member(s) — reconcile emails:`);
    unmatched.slice(0, 40).forEach((m) => console.log(`  - ${m.email}  (${m.name ?? '—'})`));
    if (unmatched.length > 40) console.log(`  … and ${unmatched.length - 40} more`);
  }
  console.log(
    APPLY
      ? '\nDone. mesa_fpu_completed_on + mesa_optin_confirmation_sent stamped. The Opt-in form now pre-fills the real FPU date.'
      : '\nDry-run only. Re-run with --apply to write.',
  );
}

main().catch((e) => { console.error('\nFAILED:', e.message); process.exit(1); });
