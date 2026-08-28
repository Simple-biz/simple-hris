// Rebuild ALL MESA account data from the "MESA Final" CSV export.
//
//   node scripts/backfill-mesa-from-csv.mjs                    # dry run + report
//   node scripts/backfill-mesa-from-csv.mjs --apply            # write it
//   node scripts/backfill-mesa-from-csv.mjs --csv "path.csv"   # different export
//
// SAFE BY DEFAULT: nothing is written without --apply. A full JSON backup of
// every table this touches is written to references/backups/ FIRST, in BOTH
// modes, before a single row is deleted (CLAUDE.md: "Every bulk UPDATE needs a
// SELECT backup written to disk first").
//
//
// WHAT IT REPLACES
// ----------------
//   mesa_ledger                      -- wiped and rebuilt from the CSV
//   mesa_accounts                    -- wiped and rebuilt, one row per stint
//   employee_hourly_rates.mesa_member / mesa_member_since / mesa_account_number
//                                    -- re-derived for EVERY row in the table
//
// WHAT IT DELIBERATELY LEAVES ALONE
// ---------------------------------
//   mesa_requests           -- live workflow state (pending reviews, dispatch
//                              stamps). The CSV carries no requests, so wiping
//                              it would destroy in-flight work to replace it
//                              with nothing. Reported, never touched.
//   mesa_request_receipts   -- evidence attached to those requests.
//   mesa_notes              -- the internal annotation log.
//
//
// THE MODEL, AS SPECIFIED BY KANE (2026-08-27)
// --------------------------------------------
//   * "Opt In date is when they opted in and entered the program... if they
//     opted in from that week the deduction will be the same week as well."
//     -> the first deposit is in the OPT-IN WEEK itself, not the week after.
//
//   * "the deposit dates for this will be the same week but on a FRIDAY"
//     -> every deposit is dated the FRIDAY of its Sun-Sat week. This differs
//        from what the live app currently writes (the week END, a Saturday --
//        record-weekly-contributions.ts:185), and the week-delete cascade
//        exact-matches that Saturday (:245). Both must move to the shared
//        Friday rule or deleting a week will silently reverse NOTHING. That is
//        a CODE change; this script only lays down the history.
//
//   * "if you see an OPT OUT Column date that means all the money that was
//     deposited into that account should be cleared out already"
//     -> the stint closes and is settled to zero on that date.
//
//   * "if they opted in again they would start again"
//     -> a second stint on a fresh account number, starting from PHP 0.
//
//   * "if they used that money and they provided the receipt and the receipt is
//     equal to the amount they requested or if the receipt is more then they
//     dont have to pay back because its theirs... if the value of that receipt
//     is less than what they asked for [they] return it using their next
//     paycheck"
//     -> a withdrawal PERMANENTLY reduces the balance. The Payback columns are
//        RECEIPT SHORTFALLS being returned, never loan repayments. This is what
//        the data shows: all 8 paybacks are smaller than the member's total
//        draws (ralf drew 28,500 across four withdrawals and returned 6,942;
//        ruthb drew 3,000 and returned all 3,000, having produced no receipt),
//        and the other 138 draws returned nothing because their receipts
//        covered them in full.
//
//
// HOW EACH CSV FACT BECOMES A LEDGER ROW
// --------------------------------------
// mesa_ledger has no row-type column, so the aggregator in src/lib/mesa/ledger.ts
// infers meaning from which money columns are populated. balance is
// Sum(total_daily_deposit_php) - Sum(disbursement_amount_php); it does NOT read
// funds_returned_mesa at all. So:
//
//   weekly deposit  -> worker 100 + match 300, total 400, dated the FRIDAY
//   withdrawal      -> disbursement_amount_php + disbursement_date
//   payback         -> a DEPOSIT-shaped row (worker = amount, match = 0, total =
//                      amount) dated the payback date, with funds_returned_mesa
//                      also set for provenance. It has to be deposit-shaped or
//                      it would not move the balance at all. Match is 0 because
//                      Simple.biz does not re-match returned money.
//   opt-out         -> ONE row carrying status='Inactive' AND an 'Opt-out'
//                      disbursement for the stint's whole remaining balance.
//                      One row, not two, because a duplicated opt-out amount is
//                      exactly the bug that made April's full-history balance
//                      read -12,000 (memory/mesa-flag-vs-ledger-rejoin-gap).
//                      status='Inactive' is also what makes lastEventOptedOut
//                      true, which is what suppresses the payroll deduction at
//                      all 7 Wizard sites (docs/features/mesa.md:145).
//
// A payback row can never be mistaken for a weekly deposit by the week-delete
// cascade: that matches worker=100 AND match=300, and a payback has match=0.

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

const argv = process.argv.slice(2);
const APPLY = argv.includes('--apply');
const CSV_PATH = (() => {
  const i = argv.indexOf('--csv');
  return i >= 0 && argv[i + 1] ? argv[i + 1] : 'references/docs/MESA Final.csv';
})();
/** Spot-check one member: prints their stints and the exact ledger rows this
 *  script would write for them. Reads from the SAME plan the apply path uses,
 *  so a number checked here is the number that lands. */
const MEMBER = (() => {
  const i = argv.indexOf('--member');
  return i >= 0 && argv[i + 1] ? argv[i + 1].trim().toLowerCase() : null;
})();
/**
 * By default an open stint accrues only through the last COMPLETED Sun-Sat
 * week. A deposit represents money actually deducted from a paycheck, and the
 * in-progress week's payroll has not run — crediting it would show every member
 * PHP 400 they have not been charged yet (PHP ~97,000 across the roster). The
 * live weekly job credits that week normally when its Hubstaff hours land.
 *
 * --include-current-week accrues through today instead.
 */
const INCLUDE_CURRENT_WEEK = argv.includes('--include-current-week');

const RATES_TABLE =
  process.env.NEXT_PUBLIC_SUPABASE_EMPLOYEE_HOURLY_RATES_TABLE?.trim() || 'employee_hourly_rates';

const supabase = createClient(url, key, {
  auth: { persistSession: false, autoRefreshToken: false },
});

const WORKER_CONTRIB = 100;
const COMPANY_MATCH = 300;
const WEEKLY_TOTAL = WORKER_CONTRIB + COMPANY_MATCH;

// Manila is the payroll timezone everywhere else in this codebase; "today"
// bounds every still-open stint, so it must not drift west of UTC.
const TODAY = new Intl.DateTimeFormat('en-CA', {
  timeZone: 'Asia/Manila',
  year: 'numeric',
  month: '2-digit',
  day: '2-digit',
}).format(new Date());

/**
 * The last day an open stint may accrue to. Computed once, after the date
 * helpers are defined (see ACCRUE_THROUGH below).
 */
let ACCRUE_THROUGH = TODAY;

const low = (s) => (s ?? '').trim().toLowerCase();
const php = (n) =>
  'PHP ' + Number(n).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });

// ── CSV ─────────────────────────────────────────────────────────────────────
// Hand-rolled because the header itself contains embedded newlines inside
// quotes ("Opt In\nDate 1"), which line-splitting parsers mangle into columns
// that silently read as empty.
function parseCsv(text) {
  const rows = [];
  let row = [];
  let field = '';
  let quoted = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (quoted) {
      if (c === '"') {
        if (text[i + 1] === '"') {
          field += '"';
          i++;
        } else quoted = false;
      } else field += c;
    } else if (c === '"') quoted = true;
    else if (c === ',') {
      row.push(field);
      field = '';
    } else if (c === '\n') {
      row.push(field);
      rows.push(row);
      row = [];
      field = '';
    } else if (c !== '\r') field += c;
  }
  if (field.length || row.length) {
    row.push(field);
    rows.push(row);
  }
  return rows.filter((r) => r.some((c) => c.trim() !== ''));
}

// ── dates ───────────────────────────────────────────────────────────────────
const ISO = /^\d{4}-\d{2}-\d{2}$/;

/** Accepts ISO (128 of the 131 dates in this export) and M/D/YYYY (the other
 *  three: ruthb, harrye, ralf). Anything else returns null rather than a
 *  plausible-but-wrong date — a misparsed date puts money in the wrong week. */
function parseDate(raw) {
  const s = (raw ?? '').trim();
  if (!s) return null;
  if (ISO.test(s)) return s;
  const m = s.match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})$/);
  if (m) {
    const [, mo, d, y] = m;
    return `${y}-${String(mo).padStart(2, '0')}-${String(d).padStart(2, '0')}`;
  }
  return null;
}

const toUtc = (iso) => new Date(`${iso}T00:00:00Z`);
const fromUtc = (d) => d.toISOString().slice(0, 10);
const addDays = (iso, n) => fromUtc(new Date(toUtc(iso).getTime() + n * 86_400_000));

/**
 * Deposits are bounded BY THEIR OWN STINT. Both ends matter, and getting either
 * wrong is silent:
 *
 *   - A deposit dated BEFORE the account opened is written but never counted --
 *     summarizeMemberAccount scopes to events on/after opened_on, so the money
 *     simply vanishes from the balance (johnwp@, opened Sat 2025-06-14, first
 *     deposit 06-13).
 *   - A deposit dated AFTER the stint closed leaks into the NEXT account. The
 *     old code took "the Friday of the closing date's week", which for a Sunday
 *     close is 5 days LATER: brixf@'s stint 1 closed 2026-06-21 and got a
 *     deposit dated 06-26, inside stint 2 (opened 06-22), inflating the fresh
 *     account from PHP 3,600 to PHP 4,000.
 *
 * So: first Friday ON OR AFTER the open, last Friday ON OR BEFORE the end.
 * A stint too short to contain a Friday gets no deposit at all.
 */
function firstFridayOnOrAfter(iso) {
  return addDays(iso, (5 - toUtc(iso).getUTCDay() + 7) % 7);
}
function lastFridayOnOrBefore(iso) {
  return addDays(iso, -((toUtc(iso).getUTCDay() - 5 + 7) % 7));
}

/** The SATURDAY that ends the Sun-Sat week containing `iso`. */
function weekEndOf(iso) {
  return addDays(iso, 6 - toUtc(iso).getUTCDay());
}

// The in-progress week is not payable yet: its Saturday has not passed and its
// payroll has not run. Accrue only through the last week that has fully closed,
// unless explicitly told otherwise.
ACCRUE_THROUGH = (() => {
  if (INCLUDE_CURRENT_WEEK) return TODAY;
  const thisWeekEnd = weekEndOf(TODAY);
  // If today IS the Saturday, this week has closed and counts.
  return thisWeekEnd === TODAY ? TODAY : addDays(thisWeekEnd, -7);
})();

const money = (raw) => {
  const s = (raw ?? '').trim();
  if (!s) return 0;
  const n = Number(s.replace(/[^0-9.-]/g, ''));
  return Number.isFinite(n) ? n : 0;
};

// ── paging (PostgREST truncates at 1000 even with .range() — CLAUDE.md) ─────
async function selectAllPaged(table, columns) {
  const out = [];
  for (let from = 0; ; from += 1000) {
    const { data, error } = await supabase.from(table).select(columns).range(from, from + 999);
    if (error) throw new Error(`${table}: ${error.message}`);
    if (!data?.length) break;
    out.push(...data);
    if (data.length < 1000) break;
  }
  return out;
}

// ── build the plan ──────────────────────────────────────────────────────────
function buildPlan(csvText) {
  const rows = parseCsv(csvText);
  const header = rows[0].map((h) => h.replace(/\s+/g, ' ').trim());
  const records = rows.slice(1).map((r, i) => {
    const o = { __line: i + 2 };
    header.forEach((h, j) => (o[h] = (r[j] ?? '').trim()));
    return o;
  });

  const anomalies = [];
  const members = new Map(); // email -> { email, name, stints[], draws[], returns[] }

  for (const rec of records) {
    const email = low(rec['Work Email']);
    const name = rec['Name'] || null;
    if (!email) {
      anomalies.push({ level: 'skip', line: rec.__line, msg: 'row has no Work Email — skipped' });
      continue;
    }

    let m = members.get(email);
    if (m) {
      // A second row for the same person would otherwise mint a SECOND open
      // account, which mesa_accounts rejects (one open per email) — mid-insert,
      // after the delete. First row wins. Money on the dropped row is reported
      // explicitly so a duplicate can never silently swallow a withdrawal.
      const dropped = [];
      for (const n of [1, 2, 3, 4, 5]) {
        const a = money(rec[`Withdrawn Amount ${n}`]);
        if (a) dropped.push(`withdrawal ${n} ${php(a)}`);
      }
      for (const c of ['Payback Amount 1', 'Payback Amount']) {
        const a = money(rec[c]);
        if (a) dropped.push(`${c} ${php(a)}`);
      }
      anomalies.push({
        level: dropped.length ? 'warn' : 'merged',
        line: rec.__line,
        email,
        msg: dropped.length
          ? `duplicate row — SKIPPED, and it carried money that is being dropped: ${dropped.join(', ')}`
          : `duplicate row — skipped (identical, carries no money)`,
      });
      continue;
    }
    m = { email, name, stints: [], draws: [], returns: [] };
    members.set(email, m);

    const in1 = parseDate(rec['Opt In Date 1']);
    const out1 = parseDate(rec['Opt Out Date 1']);
    const in2 = parseDate(rec['Opt In Date 2']);

    if (!in1) {
      anomalies.push({ level: 'skip', line: rec.__line, email, msg: 'no parseable Opt In Date 1 — no stints built' });
    }

    // ---- stints -----------------------------------------------------------
    if (in1) {
      if (in2 && !out1) {
        // A second opt-in with no recorded opt-out. All five of these
        // (brixf, kristinec, joloe, emsa, renzj) are known re-joins whose
        // termination the new sheet lost — memory/mesa-flag-vs-ledger-rejoin-gap
        // records emsa and renzj as carrying "Termination" outright. Kane's rule
        // is "if they opted in again they would start again", so the re-entry
        // date is itself the evidence the first stint ended: close it the day
        // before. No date is invented that the sheet does not already imply.
        m.stints.push({ openedOn: in1, closedOn: addDays(in2, -1), inferredClose: true });
        m.stints.push({ openedOn: in2, closedOn: null });
        anomalies.push({
          level: 'inferred',
          line: rec.__line,
          email,
          msg: `Opt In 2 (${in2}) with no Opt Out 1 — closed stint 1 on ${addDays(in2, -1)}`,
        });
      } else if (out1 && in2) {
        if (in2 <= out1) {
          anomalies.push({ level: 'warn', line: rec.__line, email, msg: `Opt In 2 (${in2}) is not after Opt Out 1 (${out1})` });
        }
        m.stints.push({ openedOn: in1, closedOn: out1 });
        m.stints.push({ openedOn: in2, closedOn: null });
      } else if (out1) {
        if (out1 < in1) {
          anomalies.push({ level: 'warn', line: rec.__line, email, msg: `Opt Out 1 (${out1}) precedes Opt In 1 (${in1})` });
        }
        m.stints.push({ openedOn: in1, closedOn: out1 });
      } else {
        m.stints.push({ openedOn: in1, closedOn: null });
      }
    }

    // ---- withdrawals ------------------------------------------------------
    for (const n of [1, 2, 3, 4, 5]) {
      const amt = money(rec[`Withdrawn Amount ${n}`]);
      const when = parseDate(rec[`Date of Withdraw ${n}`]);
      if (!amt && !when) continue;
      if (amt && !when) {
        anomalies.push({
          level: 'held',
          line: rec.__line,
          email,
          msg: `withdrawal ${n} of ${php(amt)} has NO date — HELD OUT of the ledger (cannot be placed in a week)`,
        });
        continue;
      }
      if (!amt && when) {
        anomalies.push({ level: 'warn', line: rec.__line, email, msg: `withdrawal ${n} dated ${when} has no amount — skipped` });
        continue;
      }
      m.draws.push({ amount: amt, date: when, idx: n });
    }

    // ---- paybacks (receipt shortfalls returned) ---------------------------
    for (const [dCol, aCol, n] of [
      ['Payback 1', 'Payback Amount 1', 1],
      ['Payback 2', 'Payback Amount', 2],
    ]) {
      const amt = money(rec[aCol]);
      const when = parseDate(rec[dCol]);
      if (!amt && !when) continue;
      if (amt && !when) {
        anomalies.push({ level: 'held', line: rec.__line, email, msg: `payback ${n} of ${php(amt)} has NO date — HELD OUT` });
        continue;
      }
      if (!amt) continue;
      m.returns.push({ amount: amt, date: when, idx: n });
    }
  }

  // ---- place draws/returns into their stint, then build events ------------
  const ledger = [];
  const accounts = [];
  const perMember = [];
  let ledgerId = 0;
  const serialByMonth = new Map();

  const stintOf = (m, date) =>
    m.stints.find((s) => date >= s.openedOn && (s.closedOn === null || date <= s.closedOn)) ?? null;

  // Deterministic account numbering: by opening date, then email.
  const allStints = [];
  for (const m of members.values()) {
    for (const s of m.stints) allStints.push({ m, s });
  }
  allStints.sort((a, b) => a.s.openedOn.localeCompare(b.s.openedOn) || a.m.email.localeCompare(b.m.email));
  for (const { m, s } of allStints) {
    const yymm = s.openedOn.slice(2, 4) + '-' + s.openedOn.slice(5, 7);
    const next = (serialByMonth.get(yymm) ?? 0) + 1;
    serialByMonth.set(yymm, next);
    s.accountNumber = `${yymm}-${String(next).padStart(5, '0')}`;
  }

  for (const m of [...members.values()].sort((a, b) => a.email.localeCompare(b.email))) {
    for (const d of m.draws) {
      const s = stintOf(m, d.date);
      if (!s) {
        anomalies.push({
          level: 'held',
          email: m.email,
          msg: `withdrawal of ${php(d.amount)} on ${d.date} falls in NO enrolment stint — HELD OUT`,
        });
        continue;
      }
      (s.draws ??= []).push(d);
    }
    for (const r of m.returns) {
      const s = stintOf(m, r.date);
      if (!s) {
        anomalies.push({
          level: 'held',
          email: m.email,
          msg: `payback of ${php(r.amount)} on ${r.date} falls in NO enrolment stint — HELD OUT`,
        });
        continue;
      }
      (s.returns ??= []).push(r);
    }

    let memberDeposited = 0;
    let memberDrawn = 0;
    let memberReturned = 0;

    for (const s of m.stints) {
      const common = { email: m.email, name: m.name, department: null };
      const until = s.closedOn ?? ACCRUE_THROUGH;

      // weekly deposits, every Friday from the OPT-IN week through the close week
      let stintDeposited = 0;
      const firstFri = firstFridayOnOrAfter(s.openedOn);
      const lastFri = lastFridayOnOrBefore(until);
      if (firstFri > lastFri) {
        anomalies.push({
          level: 'note',
          email: m.email,
          msg: `stint ${s.openedOn} -> ${until} contains no Friday — no deposits`,
        });
      }
      for (let f = firstFri; f <= lastFri; f = addDays(f, 7)) {
        ledger.push({
          id: ++ledgerId,
          ...common,
          status: null,
          deposit_date: f,
          worker_contribution_php: WORKER_CONTRIB,
          simple_match_php: COMPANY_MATCH,
          total_daily_deposit_php: WEEKLY_TOTAL,
          disbursement_date: null,
          disbursement_amount_php: null,
          disbursement_type: null,
          funds_returned_mesa: null,
          notes: null,
          additional_notes: null,
        });
        stintDeposited += WEEKLY_TOTAL;
      }

      const stintDrawn = (s.draws ?? []).reduce((a, d) => a + d.amount, 0);
      const stintReturned = (s.returns ?? []).reduce((a, r) => a + r.amount, 0);

      for (const d of s.draws ?? []) {
        ledger.push({
          id: ++ledgerId,
          ...common,
          status: null,
          deposit_date: null,
          worker_contribution_php: null,
          simple_match_php: null,
          total_daily_deposit_php: null,
          disbursement_date: d.date,
          disbursement_amount_php: d.amount,
          disbursement_type: 'Disbursement',
          funds_returned_mesa: null,
          notes: null,
          additional_notes: null,
        });
      }

      // Deposit-shaped so the aggregator counts it; match 0 so it can never be
      // mistaken for a weekly contribution by the week-delete cascade.
      for (const r of s.returns ?? []) {
        ledger.push({
          id: ++ledgerId,
          ...common,
          status: null,
          deposit_date: r.date,
          worker_contribution_php: r.amount,
          simple_match_php: 0,
          total_daily_deposit_php: r.amount,
          disbursement_date: null,
          disbursement_amount_php: null,
          disbursement_type: null,
          // DATE column in the tracker schema — WHEN the funds came back, not
          // how much. The amount rides in worker_contribution_php /
          // total_daily_deposit_php above, which is what the aggregator sums.
          funds_returned_mesa: r.date,
          notes: 'Receipt shortfall returned',
          additional_notes: null,
        });
      }

      const remaining = stintDeposited - stintDrawn + stintReturned;

      // Closing a stint settles it to zero: ONE row carrying both the Inactive
      // status and the Opt-out disbursement.
      if (s.closedOn) {
        if (remaining < 0) {
          anomalies.push({
            level: 'warn',
            email: m.email,
            msg: `stint ${s.accountNumber} closes ${php(remaining)} OVERDRAWN (deposited ${php(stintDeposited)}, drew ${php(stintDrawn)}, returned ${php(stintReturned)}) — no clearing row written`,
          });
        }
        ledger.push({
          id: ++ledgerId,
          ...common,
          status: 'Inactive',
          deposit_date: null,
          worker_contribution_php: null,
          simple_match_php: null,
          total_daily_deposit_php: null,
          disbursement_date: s.closedOn,
          disbursement_amount_php: remaining > 0 ? remaining : null,
          disbursement_type: 'Opt-out',
          funds_returned_mesa: null,
          notes: 'Account closed on opt-out — balance cleared',
          additional_notes: null,
        });
      }

      accounts.push({
        account_number: s.accountNumber,
        email: m.email,
        name: m.name,
        opened_on: s.openedOn,
        closed_on: s.closedOn,
      });

      memberDeposited += stintDeposited;
      memberDrawn += stintDrawn;
      memberReturned += stintReturned;
      s.remaining = remaining;
    }

    const open = m.stints.find((s) => s.closedOn === null) ?? null;
    perMember.push({
      email: m.email,
      name: m.name,
      stints: m.stints.length,
      open,
      deposited: memberDeposited,
      drawn: memberDrawn,
      returned: memberReturned,
      openBalance: open ? open.remaining : 0,
      // Open-stint-only figures. Money inside a CLOSED stint was already
      // cleared out at opt-out, so it cannot move a current balance under any
      // reading — comparing the two interpretations has to exclude it or the
      // difference is overstated.
      openDrawn: open ? (open.draws ?? []).reduce((a, d) => a + d.amount, 0) : 0,
      openReturned: open ? (open.returns ?? []).reduce((a, r) => a + r.amount, 0) : 0,
    });
  }

  return { members, ledger, accounts, perMember, anomalies };
}

// ── pre-flight validation ───────────────────────────────────────────────────
/**
 * Every row is checked BEFORE anything is deleted.
 *
 * This exists because the first apply deleted the whole ledger, inserted 3,000
 * rows, then died on `invalid input syntax for type date: "6000"` — leaving the
 * table half-built. Postgres validated the payload one batch at a time, which
 * is far too late when the destructive step already ran. A malformed value has
 * to be caught while the old data is still there and the run can simply refuse.
 */
const DATE_FIELDS = {
  // funds_returned_mesa is a DATE despite the name reading like an amount —
  // assuming otherwise is exactly what put "6000" in it and broke the first run.
  // Types come from information_schema, never from what a column is called.
  mesa_ledger: ['deposit_date', 'disbursement_date', 'funds_returned_mesa'],
  mesa_accounts: ['opened_on', 'closed_on'],
};
const NUMERIC_FIELDS = {
  mesa_ledger: [
    'worker_contribution_php',
    'simple_match_php',
    'total_daily_deposit_php',
    'disbursement_amount_php',
  ],
  mesa_accounts: [],
};

function validatePlan(plan) {
  const problems = [];
  const check = (table, rows) => {
    rows.forEach((row, i) => {
      for (const f of DATE_FIELDS[table]) {
        const v = row[f];
        if (v === null || v === undefined) continue;
        if (typeof v !== 'string' || !ISO.test(v)) {
          problems.push(`${table}[${i}] ${row.email ?? ''} — ${f} is not a date: ${JSON.stringify(v)}`);
        }
      }
      for (const f of NUMERIC_FIELDS[table]) {
        const v = row[f];
        if (v === null || v === undefined) continue;
        if (typeof v !== 'number' || !Number.isFinite(v)) {
          problems.push(`${table}[${i}] ${row.email ?? ''} — ${f} is not a number: ${JSON.stringify(v)}`);
        }
      }
    });
  };
  check('mesa_ledger', plan.ledger);
  check('mesa_accounts', plan.accounts);

  // Every deposit must sit INSIDE its stint. Outside it, the row is either
  // invisible (before opened_on) or credited to the wrong account (after
  // closed_on) -- both silent, both money-wrong.
  {
    const stintsByEmail = new Map();
    for (const a of plan.accounts) {
      if (!stintsByEmail.has(a.email)) stintsByEmail.set(a.email, []);
      stintsByEmail.get(a.email).push(a);
    }
    for (const r of plan.ledger) {
      if (r.simple_match_php !== COMPANY_MATCH || !r.deposit_date) continue;
      const stints = stintsByEmail.get(r.email) ?? [];
      const inside = stints.some(
        (a) => r.deposit_date >= a.opened_on && (!a.closed_on || r.deposit_date <= a.closed_on),
      );
      if (!inside) {
        problems.push(`mesa_ledger ${r.email} — deposit ${r.deposit_date} falls outside every stint`);
      }
    }
  }

  // A ledger row must be a deposit, a withdrawal, or a closure — never a
  // half-populated hybrid that reads as both to the aggregator.
  plan.ledger.forEach((row, i) => {
    const isDeposit = row.total_daily_deposit_php !== null;
    const isDisb = row.disbursement_amount_php !== null || row.disbursement_type !== null;
    if (isDeposit && row.deposit_date === null) {
      problems.push(`mesa_ledger[${i}] ${row.email} — deposit with no deposit_date`);
    }
    if (isDisb && row.disbursement_date === null) {
      problems.push(`mesa_ledger[${i}] ${row.email} — disbursement with no disbursement_date`);
    }
    if (isDeposit && isDisb) {
      problems.push(`mesa_ledger[${i}] ${row.email} — row is both a deposit and a disbursement`);
    }
  });

  // Exactly one open account per member — mesa_accounts enforces this with a
  // partial unique index, so a duplicate would fail mid-insert like the date did.
  const openSeen = new Set();
  for (const a of plan.accounts) {
    if (a.closed_on) continue;
    if (openSeen.has(a.email)) problems.push(`mesa_accounts — ${a.email} has more than one OPEN account`);
    openSeen.add(a.email);
  }
  const numSeen = new Set();
  for (const a of plan.accounts) {
    if (numSeen.has(a.account_number)) problems.push(`mesa_accounts — duplicate account_number ${a.account_number}`);
    numSeen.add(a.account_number);
  }
  const idSeen = new Set();
  for (const r of plan.ledger) {
    if (idSeen.has(r.id)) problems.push(`mesa_ledger — duplicate id ${r.id}`);
    idSeen.add(r.id);
  }
  return problems;
}

// ── backup ──────────────────────────────────────────────────────────────────
/**
 * Reads every table this script would overwrite and, on --apply, writes the
 * snapshot to disk BEFORE anything is deleted (CLAUDE.md).
 *
 * A dry run performs the same reads — so a backup that could not be taken is
 * discovered before it matters — but does not write the file: nothing is
 * deleted in a dry run, and a 12 MB snapshot per rehearsal is just clutter.
 */
async function writeBackup({ persist }) {
  const dir = path.join('references', 'backups');
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const file = path.join(dir, `mesa_pre_backfill_${stamp}.json`);

  const payload = {
    taken_at: new Date().toISOString(),
    note: 'Pre-backfill snapshot. Restore source for scripts/backfill-mesa-from-csv.mjs.',
    mesa_ledger: await selectAllPaged('mesa_ledger', '*'),
    mesa_accounts: await selectAllPaged('mesa_accounts', '*'),
    mesa_requests: await selectAllPaged('mesa_requests', '*'),
    mesa_notes: await selectAllPaged('mesa_notes', '*'),
    mesa_request_receipts: await selectAllPaged('mesa_request_receipts', '*'),
    employee_hourly_rates_mesa_columns: await selectAllPaged(
      RATES_TABLE,
      'id, "Work Email", mesa_member, mesa_member_since, mesa_account_number',
    ),
  };
  if (persist) {
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(file, JSON.stringify(payload, null, 1));
  }
  const counts = Object.fromEntries(
    Object.entries(payload)
      .filter(([, v]) => Array.isArray(v))
      .map(([k, v]) => [k, v.length]),
  );
  return { file: persist ? file : null, counts };
}

// ── apply ───────────────────────────────────────────────────────────────────
async function insertBatched(table, rows, size = 500) {
  for (let i = 0; i < rows.length; i += size) {
    const { error } = await supabase.from(table).insert(rows.slice(i, i + size));
    if (error) throw new Error(`${table} insert @${i}: ${error.message}`);
    process.stdout.write(`\r  ${table}: ${Math.min(i + size, rows.length)}/${rows.length}`);
  }
  if (rows.length) process.stdout.write('\n');
}

async function main() {
  if (!fs.existsSync(CSV_PATH)) {
    console.error(`CSV not found: ${CSV_PATH}`);
    process.exit(1);
  }

  console.log(`\nMESA backfill — ${APPLY ? 'APPLY' : 'DRY RUN'}`);
  console.log(`  csv    ${CSV_PATH}`);
  console.log(`  today  ${TODAY} (Manila)\n`);

  const plan = buildPlan(fs.readFileSync(CSV_PATH, 'utf8').replace(/^﻿/, ''));

  if (MEMBER) {
    const p = plan.perMember.find((x) => x.email === MEMBER);
    if (!p) {
      console.log(`${MEMBER} is not in this CSV.\n`);
      return;
    }
    const rows = plan.ledger.filter((r) => r.email === MEMBER);
    const acct = plan.accounts.filter((a) => a.email === MEMBER);
    const deposits = rows.filter((r) => r.simple_match_php === COMPANY_MATCH);
    const openAcct = acct.find((a) => !a.closed_on);

    console.log(`── ${p.name ?? MEMBER} ─────────────────────────────────────`);
    console.log(`  ${MEMBER}\n`);
    for (const a of acct) {
      console.log(`  account ${a.account_number}  opened ${a.opened_on}  ${a.closed_on ? `CLOSED ${a.closed_on}` : 'OPEN'}`);
    }

    // Figures Accounting sees are scoped to the OPEN account, so scope here too.
    const inOpen = (d) => openAcct && d >= openAcct.opened_on;
    const openDeposits = deposits.filter((r) => inOpen(r.deposit_date));
    const hisMoney = openDeposits.reduce((a, r) => a + r.worker_contribution_php, 0);
    const simpleMoney = openDeposits.reduce((a, r) => a + r.simple_match_php, 0);
    const drawn = rows
      .filter((r) => r.disbursement_type === 'Disbursement' && inOpen(r.disbursement_date))
      .reduce((a, r) => a + r.disbursement_amount_php, 0);
    // A payback is deposit-shaped with a ZERO company match — that structural
    // signature is the row type, not funds_returned_mesa (which is a DATE).
    const returned = rows
      .filter((r) => r.total_daily_deposit_php !== null && r.simple_match_php === 0 && inOpen(r.deposit_date))
      .reduce((a, r) => a + r.total_daily_deposit_php, 0);

    console.log(`\n  OPEN ACCOUNT (what Accounting shows)`);
    console.log(`    weekly deposits      ${openDeposits.length}`);
    if (openDeposits.length) {
      console.log(`    first / last Friday  ${openDeposits[0].deposit_date} .. ${openDeposits[openDeposits.length - 1].deposit_date}`);
    }
    console.log(`    HIS money   -100/wk  ${php(hisMoney)}`);
    console.log(`    SIMPLE gave +300/wk  ${php(simpleMoney)}`);
    console.log(`    deposited            ${php(hisMoney + simpleMoney)}`);
    console.log(`    withdrawals          ${php(drawn)}`);
    console.log(`    paybacks returned    ${php(returned)}`);
    console.log(`    ${'-'.repeat(34)}`);
    console.log(`    BALANCE              ${php(hisMoney + simpleMoney - drawn + returned)}`);
    console.log(`\n  ledger rows this script would write for them: ${rows.length}\n`);
    return;
  }

  console.log(
    APPLY
      ? 'Backing up (before anything is deleted)...'
      : 'Reading what a backup would capture (dry run writes no file)...',
  );
  const backup = await writeBackup({ persist: APPLY });
  if (backup.file) console.log(`  -> ${backup.file}`);
  for (const [k, v] of Object.entries(backup.counts)) console.log(`     ${String(v).padStart(6)}  ${k}`);

  // ---- rates targeting ----------------------------------------------------
  const rateRows = await selectAllPaged(RATES_TABLE, 'id, "Work Email", mesa_member');
  const openByEmail = new Map();
  for (const p of plan.perMember) if (p.open) openByEmail.set(p.email, p.open);

  const toEnrol = [];
  const toClear = [];
  for (const r of rateRows) {
    const email = low(r['Work Email']);
    const open = email ? openByEmail.get(email) : null;
    if (open) toEnrol.push({ id: r.id, open });
    else if (r.mesa_member) toClear.push({ id: r.id });
  }
  const missingRateRow = [...openByEmail.keys()].filter(
    (e) => !rateRows.some((r) => low(r['Work Email']) === e),
  );

  // ---- report -------------------------------------------------------------
  const totals = plan.perMember.reduce(
    (a, p) => {
      a.deposited += p.deposited;
      a.drawn += p.drawn;
      a.returned += p.returned;
      a.openBalance += p.openBalance;
      a.openDrawn += p.openDrawn;
      a.openReturned += p.openReturned;
      return a;
    },
    { deposited: 0, drawn: 0, returned: 0, openBalance: 0, openDrawn: 0, openReturned: 0 },
  );

  console.log('\n── PLAN ────────────────────────────────────────────────────');
  console.log(`  members in CSV        ${plan.members.size}`);
  console.log(`  enrolment stints      ${plan.accounts.length}  (${plan.accounts.filter((a) => !a.closed_on).length} open / ${plan.accounts.filter((a) => a.closed_on).length} closed)`);
  console.log(`  ledger rows to write  ${plan.ledger.length}`);
  console.log(`    deposits            ${plan.ledger.filter((r) => r.simple_match_php === COMPANY_MATCH).length}`);
  console.log(`    paybacks            ${plan.ledger.filter((r) => r.total_daily_deposit_php !== null && r.simple_match_php === 0).length}`);
  console.log(`    withdrawals         ${plan.ledger.filter((r) => r.disbursement_type === 'Disbursement').length}`);
  console.log(`    opt-out closures    ${plan.ledger.filter((r) => r.disbursement_type === 'Opt-out').length}`);
  console.log(`  rate rows to enrol    ${toEnrol.length}`);
  console.log(`  rate rows to clear    ${toClear.length}`);

  console.log('\n── MONEY ───────────────────────────────────────────────────');
  console.log(`  gross deposits        ${php(totals.deposited)}`);
  console.log(`  withdrawals           ${php(totals.drawn)}`);
  console.log(`  paybacks returned     ${php(totals.returned)}`);
  console.log(`  OPEN-ACCOUNT BALANCE  ${php(totals.openBalance)}   <- what Accounting will see`);
  console.log('\n  Withdrawals are treated as SPENT (receipts covered them), and the');
  console.log('  payback column as receipt SHORTFALLS returned. Under the rejected');
  console.log('  reading — every withdrawal a loan repaid in full — the open balance');
  console.log(`  would instead be ${php(totals.openBalance + totals.openDrawn - totals.openReturned)}, a ${php(totals.openDrawn - totals.openReturned)} difference.`);
  console.log('  (Open stints only; money in a closed stint was cleared at opt-out.)');

  if (missingRateRow.length) {
    console.log(`\n── ${missingRateRow.length} ACTIVE MEMBERS HAVE NO RATE ROW ──────────────────`);
    console.log('  Their ledger and account are written (both key on email), but');
    console.log('  mesa_member cannot be stamped, so they will NOT appear on the');
    console.log('  roster-grounded Active Members tab and will NOT be deducted:');
    missingRateRow.forEach((e) => console.log(`    ${e}`));
  }

  const byLevel = plan.anomalies.reduce((a, x) => ((a[x.level] ??= []).push(x), a), {});
  if (plan.anomalies.length) {
    console.log('\n── ANOMALIES ───────────────────────────────────────────────');
    for (const level of ['held', 'skip', 'warn', 'inferred', 'merged', 'note']) {
      const list = byLevel[level];
      if (!list?.length) continue;
      console.log(`\n  ${level.toUpperCase()} (${list.length})`);
      list.forEach((x) => console.log(`    ${x.email ?? ''} ${x.msg}`));
    }
  }

  const untouched = backup.counts.mesa_requests;
  if (untouched) {
    console.log(`\n  NOTE: ${untouched} mesa_requests rows are LEFT UNTOUCHED (live workflow state).`);
  }

  // Validate the ENTIRE payload before the destructive step. A bad value found
  // here costs nothing; found mid-insert it leaves a half-built ledger.
  const problems = validatePlan(plan);
  console.log('\n── PRE-FLIGHT ──────────────────────────────────────────────');
  if (problems.length) {
    console.log(`  ${problems.length} problem(s) — REFUSING to write:\n`);
    problems.slice(0, 40).forEach((p) => console.log(`    ${p}`));
    if (problems.length > 40) console.log(`    ... and ${problems.length - 40} more`);
    console.log('');
    process.exitCode = 1;
    return;
  }
  console.log(`  ${plan.ledger.length} ledger + ${plan.accounts.length} account rows validated — all clean.`);

  if (!APPLY) {
    console.log('\nDRY RUN — nothing written. Re-run with --apply to commit.\n');
    return;
  }

  // ---- write --------------------------------------------------------------
  console.log('\n── APPLYING ────────────────────────────────────────────────');

  console.log('  deleting mesa_ledger...');
  {
    const { error } = await supabase.from('mesa_ledger').delete().gte('id', 0);
    if (error) throw new Error(`mesa_ledger delete: ${error.message}`);
  }
  console.log('  deleting mesa_accounts...');
  {
    const { error } = await supabase.from('mesa_accounts').delete().not('id', 'is', null);
    if (error) throw new Error(`mesa_accounts delete: ${error.message}`);
  }

  await insertBatched('mesa_ledger', plan.ledger);
  await insertBatched('mesa_accounts', plan.accounts);

  console.log('  clearing stale membership flags...');
  for (let i = 0; i < toClear.length; i += 200) {
    const ids = toClear.slice(i, i + 200).map((r) => r.id);
    const { error } = await supabase
      .from(RATES_TABLE)
      .update({ mesa_member: false, mesa_member_since: null, mesa_account_number: null })
      .in('id', ids);
    if (error) throw new Error(`rates clear @${i}: ${error.message}`);
    process.stdout.write(`\r    cleared ${Math.min(i + 200, toClear.length)}/${toClear.length}`);
  }
  if (toClear.length) process.stdout.write('\n');

  console.log('  stamping current members...');
  let done = 0;
  for (const { id, open } of toEnrol) {
    const { error } = await supabase
      .from(RATES_TABLE)
      .update({
        mesa_member: true,
        mesa_member_since: open.openedOn,
        mesa_account_number: open.accountNumber,
      })
      .eq('id', id);
    if (error) throw new Error(`rates enrol id=${id}: ${error.message}`);
    if (++done % 100 === 0 || done === toEnrol.length) {
      process.stdout.write(`\r    stamped ${done}/${toEnrol.length}`);
    }
  }
  if (toEnrol.length) process.stdout.write('\n');

  // ---- verify -------------------------------------------------------------
  const { count: ledgerCount } = await supabase.from('mesa_ledger').select('*', { head: true, count: 'exact' });
  const { count: acctCount } = await supabase.from('mesa_accounts').select('*', { head: true, count: 'exact' });
  const { count: openCount } = await supabase
    .from('mesa_accounts')
    .select('*', { head: true, count: 'exact' })
    .is('closed_on', null);

  console.log('\n── VERIFY ──────────────────────────────────────────────────');
  console.log(`  mesa_ledger    ${ledgerCount} (expected ${plan.ledger.length}) ${ledgerCount === plan.ledger.length ? 'OK' : 'MISMATCH'}`);
  console.log(`  mesa_accounts  ${acctCount} (expected ${plan.accounts.length}) ${acctCount === plan.accounts.length ? 'OK' : 'MISMATCH'}`);
  console.log(`  open accounts  ${openCount} (expected ${plan.accounts.filter((a) => !a.closed_on).length})`);
  console.log(`\nDone. Backup: ${backup.file}\n`);
}

main().catch((e) => {
  console.error('\nFAILED:', e.message);
  process.exit(1);
});
