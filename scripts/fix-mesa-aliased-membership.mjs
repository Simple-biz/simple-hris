/**
 * Stamp MESA membership onto the rate rows of members whose LEDGER identity is
 * an ALIAS of their roster email.
 *
 * WHY THIS EXISTS
 * ---------------
 * `scripts/backfill-mesa-from-csv.mjs` (2026-08-27/28) set `mesa_member` by
 * matching the CSV/ledger email against `employee_hourly_rates."Work Email"`,
 * and never consulted `src/data/mesa-email-aliases.json`. A member whose ledger
 * address differs from their roster address therefore matched nothing and was
 * left unflagged — so the Payroll Wizard has NEVER charged them the PHP100,
 * while Accounting -> MESA -> Active Members shows them with a balance (that
 * read path IS alias-resolved). Found 2026-09-15 for jimg@simple.biz
 * (ledger `jim@`), reported by Kane; dales@simple.biz (ledger `dale@`) is the
 * identical case.
 *
 * The backfill was a one-time initialisation and will not run again (Kane,
 * 2026-09-15), so the repair is here, against the affected people, not there.
 *
 * WHAT IT WRITES — the same three columns, and only those three, that the
 * backfill's own enrolment step writes (backfill-mesa-from-csv.mjs:957-961):
 *
 *     mesa_member        = true
 *     mesa_member_since  = <their OPEN mesa_accounts row>.opened_on
 *     mesa_account_number= <their OPEN mesa_accounts row>.account_number
 *
 * onto EVERY `employee_hourly_rates` row carrying their ROSTER work email (the
 * flag is denormalised per upload, and `employee_hourly_rates_current` picks
 * the newest, so a partial stamp would drift straight back).
 *
 * `mesa_member_since` is TAKEN FROM the account row, never computed:
 * `scripts/verify-mesa-backfill.mjs:288` asserts the two are equal, and
 * `POST /api/toggle-mesa-member` keeps them equal on every re-enrolment.
 *
 * WHAT IT DOES NOT DO
 * -------------------
 *  - It does NOT call `/api/toggle-mesa-member`. That route resolves the open
 *    account by the email it is handed; for an aliased member it would find
 *    none and MINT A SECOND ACCOUNT, whose window would start today and hide
 *    the member's existing balance. Nothing here mints, closes or edits
 *    `mesa_accounts`.
 *  - It does NOT touch `mesa_ledger`. The weeks already missed (no deposit was
 *    written while they were unflagged) are NOT backfilled — that is a
 *    separate decision, tied to the open question of whether their imported
 *    balance already credits contributions nobody collected.
 *  - It does NOT touch any snapshot, staged paystub or dispatch row. Payroll
 *    rule changes are forward-only; a past week is never rewritten.
 *
 * SAFETY
 * ------
 *  - Dry run by default. `--apply` writes.
 *  - A full SELECT of every row it will touch is written to
 *    `references/backups/` BEFORE the first write, and the path is printed.
 *  - Refuses, per target, on anything unexpected: no open account, more than
 *    one open account, no rate rows, or a ledger email that has rate rows of
 *    its own (which would mean the alias is wrong and two people could be
 *    merged). A refusal skips that target; it never guesses.
 *  - Idempotent: a row already carrying the correct three values is reported
 *    as SKIP and not rewritten.
 *  - Re-reads and verifies after applying.
 *
 * USAGE
 *   node scripts/fix-mesa-aliased-membership.mjs                         # dry run, all targets
 *   node scripts/fix-mesa-aliased-membership.mjs --only jimg@simple.biz  # dry run, one person
 *   node scripts/fix-mesa-aliased-membership.mjs --only jimg@simple.biz --apply
 */
import { createClient } from '@supabase/supabase-js';
import dotenv from 'dotenv';
import fs from 'node:fs';
import path from 'node:path';

dotenv.config({ path: '.env.local' });
dotenv.config();

const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
if (!url || !key) {
  console.error('Missing NEXT_PUBLIC_SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY');
  process.exit(1);
}
const supabase = createClient(url, key, { auth: { persistSession: false, autoRefreshToken: false } });

const RATES_TABLE =
  process.env.NEXT_PUBLIC_SUPABASE_EMPLOYEE_HOURLY_RATES_TABLE?.trim() || 'employee_hourly_rates';
const APPLY = process.argv.includes('--apply');
const ONLY = (() => {
  const i = process.argv.indexOf('--only');
  return i >= 0 && process.argv[i + 1] ? process.argv[i + 1].trim().toLowerCase() : null;
})();

/**
 * The aliased members, hardcoded on purpose.
 *
 * `roster` is the address on `employee_hourly_rates."Work Email"`, the active
 * roster and the Hubstaff CSV. `ledger` is the address on `mesa_ledger` and
 * `mesa_accounts`. Both pairs below are already in
 * src/data/mesa-email-aliases.json, which is what makes the Accounting tab
 * show them correctly today; this list is the payroll side of the same fact.
 *
 * To extend: run `node --import tsx scripts/probe-mesa-flag-vs-account.mts`,
 * which lists every open account with no flagged rate row and says which are
 * alias cases.
 */
const TARGETS = [
  { roster: 'jimg@simple.biz', ledger: 'jim@simple.biz', name: 'Guzago, Jimron "Jim"' },
  { roster: 'dales@simple.biz', ledger: 'dale@simple.biz', name: 'Delos Santos, Dale "Dale"' },
];

const low = (s) => (s ?? '').trim().toLowerCase();

async function selectAllPaged(table, columns, filter) {
  const out = [];
  for (let from = 0; ; from += 1000) {
    let q = supabase.from(table).select(columns).range(from, from + 999);
    if (filter) q = filter(q);
    const { data, error } = await q;
    if (error) throw new Error(`${table}: ${error.message}`);
    out.push(...(data ?? []));
    if (!data || data.length < 1000) return out;
  }
}

const RATE_COLS = 'id, "Work Email", "Personal Email", mesa_member, mesa_member_since, mesa_account_number';

(async () => {
  const targets = ONLY ? TARGETS.filter((t) => t.roster === ONLY || t.ledger === ONLY) : TARGETS;
  if (targets.length === 0) {
    console.error(`--only ${ONLY} matches no known aliased member. Known: ${TARGETS.map((t) => t.roster).join(', ')}`);
    process.exit(1);
  }

  console.log('\nMESA aliased-membership repair');
  console.log(`  mode     ${APPLY ? 'APPLY (writes)' : 'DRY RUN (no writes)'}`);
  console.log(`  targets  ${targets.map((t) => t.roster).join(', ')}`);
  console.log(`  table    ${RATES_TABLE}\n`);

  const plans = [];

  for (const t of targets) {
    console.log('─'.repeat(74));
    console.log(`${t.name}`);
    console.log(`  roster/rates email : ${t.roster}`);
    console.log(`  ledger/account email: ${t.ledger}`);

    // 1. Exactly one OPEN account, under the LEDGER email.
    const accounts = await selectAllPaged(
      'mesa_accounts',
      'account_number, email, name, opened_on, closed_on',
      (q) => q.ilike('email', t.ledger),
    );
    const open = accounts.filter((a) => !a.closed_on);
    if (open.length !== 1) {
      console.log(`  REFUSED: expected exactly 1 OPEN mesa_accounts row for ${t.ledger}, found ${open.length}.`);
      continue;
    }
    const acct = open[0];
    console.log(`  open account       : ${acct.account_number}  opened ${acct.opened_on}`);

    // 2. The ledger email must NOT have rate rows of its own. If it did, the
    //    alias would be joining two different payroll identities and stamping
    //    the roster email could enrol the wrong person.
    const ledgerSideRates = await selectAllPaged(RATES_TABLE, 'id', (q) => q.ilike('"Work Email"', t.ledger));
    if (ledgerSideRates.length > 0) {
      console.log(
        `  REFUSED: ${t.ledger} has ${ledgerSideRates.length} rate row(s) of its own — the alias may join two people. Not touching this.`,
      );
      continue;
    }

    // 3. Their rate rows, by ROSTER work email.
    const rates = await selectAllPaged(RATES_TABLE, RATE_COLS, (q) => q.ilike('"Work Email"', t.roster));
    if (rates.length === 0) {
      console.log(`  REFUSED: no rate rows for ${t.roster}.`);
      continue;
    }

    const correct = (r) =>
      r.mesa_member === true &&
      r.mesa_member_since === acct.opened_on &&
      r.mesa_account_number === acct.account_number;
    const toWrite = rates.filter((r) => !correct(r));
    const already = rates.length - toWrite.length;

    console.log(`  rate rows          : ${rates.length}  (${already} already correct, ${toWrite.length} to stamp)`);
    console.log(`  will set           : mesa_member=true · mesa_member_since=${acct.opened_on} · mesa_account_number=${acct.account_number}`);
    if (toWrite.length === 0) {
      console.log('  nothing to do.');
      continue;
    }
    plans.push({ target: t, acct, rates, toWrite });
  }

  console.log('─'.repeat(74));
  const totalRows = plans.reduce((n, p) => n + p.toWrite.length, 0);
  console.log(`\nPLAN: ${plans.length} member(s), ${totalRows} rate row(s) to stamp.`);

  if (totalRows === 0) {
    console.log('Nothing to write.\n');
    return;
  }
  if (!APPLY) {
    console.log('\nDRY RUN — nothing was written. Re-run with --apply to write.\n');
    return;
  }

  // ---- backup BEFORE any write -------------------------------------------
  const dir = 'references/backups';
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, `mesa_aliased_membership_pre_fix_${new Date().toISOString().replace(/[:.]/g, '-')}.json`);
  fs.writeFileSync(
    file,
    JSON.stringify(
      {
        taken_at: new Date().toISOString(),
        note: 'Pre-fix snapshot of every rate row scripts/fix-mesa-aliased-membership.mjs is about to stamp. Restore source.',
        rates_table: RATES_TABLE,
        members: plans.map((p) => ({
          roster_email: p.target.roster,
          ledger_email: p.target.ledger,
          open_account: p.acct,
          rate_rows_before: p.rates,
        })),
      },
      null,
      1,
    ),
  );
  console.log(`\nbackup written: ${file}`);

  // ---- write --------------------------------------------------------------
  for (const p of plans) {
    console.log(`\nstamping ${p.target.roster} (${p.toWrite.length} rows)...`);
    let done = 0;
    for (const r of p.toWrite) {
      const { error } = await supabase
        .from(RATES_TABLE)
        .update({
          mesa_member: true,
          mesa_member_since: p.acct.opened_on,
          mesa_account_number: p.acct.account_number,
        })
        .eq('id', r.id);
      if (error) throw new Error(`rates update id=${r.id}: ${error.message}`);
      done += 1;
    }
    console.log(`  stamped ${done}`);
  }

  // ---- verify -------------------------------------------------------------
  console.log('\n── VERIFY (re-read from the database) ─────────────────────────');
  let bad = 0;
  for (const p of plans) {
    const rows = await selectAllPaged(RATES_TABLE, RATE_COLS, (q) => q.ilike('"Work Email"', p.target.roster));
    const wrong = rows.filter(
      (r) =>
        r.mesa_member !== true ||
        r.mesa_member_since !== p.acct.opened_on ||
        r.mesa_account_number !== p.acct.account_number,
    );
    console.log(`  ${p.target.roster}: ${rows.length} rows, ${rows.length - wrong.length} correct, ${wrong.length} wrong`);
    for (const w of wrong.slice(0, 5)) {
      console.log(`    id=${w.id} member=${w.mesa_member} since=${w.mesa_member_since} acct=${w.mesa_account_number}`);
    }
    bad += wrong.length;

    // What the app will now read.
    const { data: view } = await supabase
      .from('employee_hourly_rates_current')
      .select(RATE_COLS)
      .ilike('"Work Email"', p.target.roster)
      .maybeSingle();
    if (view) {
      console.log(
        `    employee_hourly_rates_current -> mesa_member=${view.mesa_member} since=${view.mesa_member_since} acct=${view.mesa_account_number}`,
      );
    }
  }

  if (bad > 0) {
    console.error(`\n${bad} row(s) did not take. Backup: ${file}\n`);
    process.exitCode = 1;
  } else {
    console.log('\nDone. The Payroll Wizard will charge the PHP100 from the next cycle it computes.');
    console.log('Past cycles are NOT recomputed (payroll rule changes are forward-only), and no');
    console.log('missed weekly deposit was backfilled into mesa_ledger.\n');
  }
})().catch((e) => {
  console.error('\nFAILED:', e.message);
  process.exit(1);
});
