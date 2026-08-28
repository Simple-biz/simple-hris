// Independent audit of the MESA backfill: recompute what SHOULD be in the
// database straight from the CSV, then diff it against what IS there.
//
//   node scripts/verify-mesa-backfill.mjs
//   node scripts/verify-mesa-backfill.mjs --verbose   # print every member
//
// READ-ONLY. Never writes.
//
// WHY THIS IS NOT JUST RE-RUNNING THE BACKFILL
// --------------------------------------------
// A verifier that imports the writer's own helpers proves only that the code is
// self-consistent — it reproduces the writer's bugs and calls them expected. So
// the date arithmetic here is deliberately implemented a DIFFERENT way: Fridays
// are found by walking the calendar one day at a time and testing getUTCDay(),
// rather than by the writer's `date + (5 - dow)` offset formula. If the offset
// formula is wrong, this disagrees with it instead of agreeing.
//
// It also re-derives balances by summing raw mesa_ledger columns directly,
// rather than calling summarizeMember(), so a bug in the aggregator surfaces as
// a mismatch rather than cancelling out on both sides.

import { createClient } from '@supabase/supabase-js';
import dotenv from 'dotenv';
import fs from 'node:fs';

dotenv.config({ path: '.env.local' });
dotenv.config();

const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
if (!url || !key) {
  console.error('Missing NEXT_PUBLIC_SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY');
  process.exit(1);
}
const supabase = createClient(url, key, { auth: { persistSession: false, autoRefreshToken: false } });

const VERBOSE = process.argv.includes('--verbose');
const CSV_PATH = (() => {
  const i = process.argv.indexOf('--csv');
  return i >= 0 && process.argv[i + 1] ? process.argv[i + 1] : 'references/docs/MESA Final.csv';
})();
const RATES_TABLE =
  process.env.NEXT_PUBLIC_SUPABASE_EMPLOYEE_HOURLY_RATES_TABLE?.trim() || 'employee_hourly_rates';

const low = (s) => (s ?? '').trim().toLowerCase();
const php = (n) => 'PHP ' + Number(n).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
const ISO = /^\d{4}-\d{2}-\d{2}$/;

// ── CSV ─────────────────────────────────────────────────────────────────────
function parseCsv(text) {
  const rows = [];
  let row = [], field = '', quoted = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (quoted) {
      if (c === '"') { if (text[i + 1] === '"') { field += '"'; i++; } else quoted = false; }
      else field += c;
    } else if (c === '"') quoted = true;
    else if (c === ',') { row.push(field); field = ''; }
    else if (c === '\n') { row.push(field); rows.push(row); row = []; field = ''; }
    else if (c !== '\r') field += c;
  }
  if (field.length || row.length) { row.push(field); rows.push(row); }
  return rows.filter((r) => r.some((c) => c.trim() !== ''));
}

function parseDate(raw) {
  const s = (raw ?? '').trim();
  if (!s) return null;
  if (ISO.test(s)) return s;
  const m = s.match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})$/);
  return m ? `${m[3]}-${String(m[1]).padStart(2, '0')}-${String(m[2]).padStart(2, '0')}` : null;
}
const money = (raw) => {
  const s = (raw ?? '').trim();
  if (!s) return 0;
  const n = Number(s.replace(/[^0-9.-]/g, ''));
  return Number.isFinite(n) ? n : 0;
};

// ── date maths, deliberately NOT the writer's formula ───────────────────────
const dayMs = 86_400_000;
const toMs = (iso) => Date.parse(`${iso}T00:00:00Z`);
const toIso = (ms) => new Date(ms).toISOString().slice(0, 10);

/** Every Friday in [from, to], found by walking days and testing the weekday.
 *  Independent of any offset arithmetic. */
function fridaysBetween(from, to) {
  const out = [];
  if (!from || !to) return out;
  // Bounded by the stint itself: a Friday before `from` would be written but
  // never counted (account scoping drops it), and one after `to` would be
  // credited to the next account.
  let cur = toMs(from);
  const end = toMs(to);
  for (; cur <= end; cur += dayMs) {
    if (new Date(cur).getUTCDay() === 5) out.push(toIso(cur));
  }
  return out;
}

/** Last day an OPEN stint accrues to: the last COMPLETED Sun-Sat week. */
function accrueThrough(todayIso) {
  const d = toMs(todayIso);
  const dow = new Date(d).getUTCDay();
  const thisSaturday = d + (6 - dow) * dayMs;
  return toIso(thisSaturday === d ? d : thisSaturday - 7 * dayMs);
}

async function selectAllPaged(table, columns, filter) {
  const out = [];
  for (let from = 0; ; from += 1000) {
    let q = supabase.from(table).select(columns).range(from, from + 999);
    if (filter) q = filter(q);
    const { data, error } = await q;
    if (error) throw new Error(`${table}: ${error.message}`);
    if (!data?.length) break;
    out.push(...data);
    if (data.length < 1000) break;
  }
  return out;
}

// ── expected, straight from the CSV ─────────────────────────────────────────
function expectedFromCsv(csvText, cutoff) {
  const rows = parseCsv(csvText.replace(/^﻿/, ''));
  const hdr = rows[0].map((h) => h.replace(/\s+/g, ' ').trim());
  const recs = rows.slice(1).map((r) => Object.fromEntries(hdr.map((h, i) => [h, (r[i] ?? '').trim()])));

  const members = new Map();
  const seen = new Set();
  for (const rec of recs) {
    const email = low(rec['Work Email']);
    if (!email || seen.has(email)) continue; // first row wins, as the writer does
    seen.add(email);

    const in1 = parseDate(rec['Opt In Date 1']);
    const out1 = parseDate(rec['Opt Out Date 1']);
    const in2 = parseDate(rec['Opt In Date 2']);
    if (!in1) continue;

    const stints = [];
    if (in2 && !out1) {
      stints.push({ open: in1, close: toIso(toMs(in2) - dayMs) });
      stints.push({ open: in2, close: null });
    } else if (out1 && in2) {
      stints.push({ open: in1, close: out1 });
      stints.push({ open: in2, close: null });
    } else if (out1) stints.push({ open: in1, close: out1 });
    else stints.push({ open: in1, close: null });

    const draws = [], backs = [];
    for (const n of [1, 2, 3, 4, 5]) {
      const a = money(rec[`Withdrawn Amount ${n}`]);
      const d = parseDate(rec[`Date of Withdraw ${n}`]);
      if (a && d) draws.push({ amount: a, date: d });
    }
    for (const [dc, ac] of [['Payback 1', 'Payback Amount 1'], ['Payback 2', 'Payback Amount']]) {
      const a = money(rec[ac]);
      const d = parseDate(rec[dc]);
      if (a && d) backs.push({ amount: a, date: d });
    }

    const inStint = (s, d) => d >= s.open && (s.close === null || d <= s.close);
    let depositRows = 0, openBalance = 0, openAcctOpen = null;
    for (const s of stints) {
      const fris = fridaysBetween(s.open, s.close ?? cutoff);
      depositRows += fris.length;
      if (s.close === null) {
        const dep = fris.length * 400;
        const drew = draws.filter((d) => inStint(s, d.date)).reduce((a, b) => a + b.amount, 0);
        const back = backs.filter((b) => inStint(s, b.date)).reduce((a, b) => a + b.amount, 0);
        openBalance = dep - drew + back;
        openAcctOpen = s.open;
      }
    }
    const placedDraws = draws.filter((d) => stints.some((s) => inStint(s, d.date)));
    const placedBacks = backs.filter((b) => stints.some((s) => inStint(s, b.date)));

    members.set(email, {
      email,
      stints: stints.length,
      closed: stints.filter((s) => s.close !== null).length,
      hasOpen: stints.some((s) => s.close === null),
      openedOn: openAcctOpen,
      depositRows,
      drawRows: placedDraws.length,
      backRows: placedBacks.length,
      openBalance,
    });
  }
  return members;
}

// ── run ─────────────────────────────────────────────────────────────────────
(async () => {
  const TODAY = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Asia/Manila', year: 'numeric', month: '2-digit', day: '2-digit',
  }).format(new Date());
  const cutoff = accrueThrough(TODAY);

  console.log(`\nMESA backfill audit — independent recomputation`);
  console.log(`  csv     ${CSV_PATH}`);
  console.log(`  today   ${TODAY} (Manila)   accrue through ${cutoff}\n`);

  const expected = expectedFromCsv(fs.readFileSync(CSV_PATH, 'utf8'), cutoff);

  const ledger = await selectAllPaged('mesa_ledger', '*');
  const accounts = await selectAllPaged('mesa_accounts', '*');
  const rates = await selectAllPaged(RATES_TABLE, '"Work Email", mesa_member, mesa_member_since, mesa_account_number');

  const problems = [];
  const P = (m) => problems.push(m);

  // ---- structural ---------------------------------------------------------
  const acctNums = accounts.map((a) => a.account_number);
  if (new Set(acctNums).size !== acctNums.length) P(`mesa_accounts: duplicate account_number`);
  const openByEmail = {};
  for (const a of accounts) if (!a.closed_on) openByEmail[low(a.email)] = (openByEmail[low(a.email)] ?? 0) + 1;
  for (const [e, n] of Object.entries(openByEmail)) if (n > 1) P(`${e}: ${n} OPEN accounts`);
  const ids = ledger.map((r) => r.id);
  if (new Set(ids).size !== ids.length) P(`mesa_ledger: duplicate id`);
  for (const r of ledger) {
    if (!r.deposit_date && !r.disbursement_date) P(`ledger id=${r.id} (${r.email}): no date at all`);
    if (r.disbursement_amount_php != null && r.disbursement_amount_php < 0) P(`ledger id=${r.id}: negative disbursement`);
    for (const f of ['deposit_date', 'disbursement_date', 'funds_returned_mesa']) {
      if (r[f] != null && !ISO.test(String(r[f]))) P(`ledger id=${r.id}: ${f} is not a date (${r[f]})`);
    }
  }

  // ---- per member ---------------------------------------------------------
  const byEmail = new Map();
  for (const r of ledger) {
    const e = low(r.email);
    if (!e) { P(`ledger id=${r.id}: no email`); continue; }
    (byEmail.get(e) ?? byEmail.set(e, []).get(e)).push(r);
  }
  const rateByEmail = new Map();
  for (const r of rates) {
    const e = low(r['Work Email']);
    if (!e) continue;
    const prev = rateByEmail.get(e);
    if (!prev || (r.mesa_member === true && prev.mesa_member !== true)) rateByEmail.set(e, r);
  }

  let checked = 0, balanceOk = 0;
  for (const [email, exp] of expected) {
    checked++;
    const rows = byEmail.get(email) ?? [];
    const deposits = rows.filter((r) => r.simple_match_php === 300 && r.total_daily_deposit_php === 400);
    const backs = rows.filter((r) => r.total_daily_deposit_php != null && r.simple_match_php === 0);
    const draws = rows.filter((r) => r.disbursement_type === 'Disbursement');
    const closes = rows.filter((r) => r.disbursement_type === 'Opt-out');

    if (deposits.length !== exp.depositRows) P(`${email}: ${deposits.length} deposit rows, expected ${exp.depositRows}`);
    if (draws.length !== exp.drawRows) P(`${email}: ${draws.length} withdrawal rows, expected ${exp.drawRows}`);
    if (backs.length !== exp.backRows) P(`${email}: ${backs.length} payback rows, expected ${exp.backRows}`);
    if (closes.length !== exp.closed) P(`${email}: ${closes.length} opt-out rows, expected ${exp.closed}`);

    for (const d of deposits) {
      if (new Date(`${d.deposit_date}T00:00:00Z`).getUTCDay() !== 5) P(`${email}: deposit ${d.deposit_date} is not a Friday`);
    }

    const acct = accounts.filter((a) => low(a.email) === email);
    if (acct.length !== exp.stints) P(`${email}: ${acct.length} accounts, expected ${exp.stints}`);
    const open = acct.find((a) => !a.closed_on);
    if (exp.hasOpen && !open) P(`${email}: expected an OPEN account, found none`);
    if (!exp.hasOpen && open) P(`${email}: has an OPEN account but the CSV shows none`);
    if (open && exp.openedOn && open.opened_on !== exp.openedOn) P(`${email}: open account opened ${open.opened_on}, expected ${exp.openedOn}`);

    // balance, re-derived from raw columns and scoped to the open account
    if (open) {
      const scoped = rows.filter((r) => (r.deposit_date ?? r.disbursement_date ?? '') >= open.opened_on);
      const bal =
        scoped.reduce((a, r) => a + (r.total_daily_deposit_php ?? 0), 0) -
        scoped.reduce((a, r) => a + (r.disbursement_amount_php ?? 0), 0);
      if (Math.abs(bal - exp.openBalance) > 0.005) P(`${email}: balance ${php(bal)}, expected ${php(exp.openBalance)}`);
      else balanceOk++;
      if (VERBOSE) console.log(`  ${email.padEnd(26)} ${String(deposits.length).padStart(3)} wk  ${php(bal).padStart(15)}  ${open.account_number}`);
    }

    // membership flag
    const rate = rateByEmail.get(email);
    if (rate) {
      const shouldBe = exp.hasOpen;
      if ((rate.mesa_member === true) !== shouldBe) P(`${email}: mesa_member=${rate.mesa_member}, expected ${shouldBe}`);
      if (shouldBe && open && rate.mesa_account_number !== open.account_number) P(`${email}: rates acct ${rate.mesa_account_number} != ${open.account_number}`);
      if (shouldBe && open && rate.mesa_member_since !== open.opened_on) P(`${email}: mesa_member_since ${rate.mesa_member_since} != ${open.opened_on}`);
    }
  }

  // ---- nothing extra ------------------------------------------------------
  for (const e of byEmail.keys()) if (!expected.has(e)) P(`ledger has rows for ${e}, which is not in the CSV`);
  for (const a of accounts) if (!expected.has(low(a.email))) P(`account ${a.account_number} belongs to ${a.email}, not in the CSV`);
  // no one outside the CSV may still be flagged
  for (const [e, r] of rateByEmail) {
    if (r.mesa_member === true && !expected.has(e)) P(`${e}: flagged mesa_member=true but not in the CSV`);
  }

  console.log('── RESULT ──────────────────────────────────────────────────');
  console.log(`  CSV members checked        ${checked}`);
  console.log(`  ledger rows in DB          ${ledger.length}`);
  console.log(`  accounts in DB             ${accounts.length}  (${accounts.filter((a) => !a.closed_on).length} open)`);
  console.log(`  balances independently OK  ${balanceOk}`);
  if (!problems.length) {
    console.log(`\n  NO DISCREPANCIES. Every figure recomputed from the CSV matches production.\n`);
  } else {
    console.log(`\n  ${problems.length} DISCREPANCIES:\n`);
    problems.slice(0, 60).forEach((p) => console.log(`    ${p}`));
    if (problems.length > 60) console.log(`    ... and ${problems.length - 60} more`);
    console.log('');
    process.exitCode = 1;
  }
})().catch((e) => { console.error('\nFAILED:', e.message); process.exit(1); });
