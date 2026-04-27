#!/usr/bin/env node
/**
 * Reads `references/NEW Payroll Dashboard - All Dept.csv`, dedupes rows by
 * lowercased Work Email (picking the row with the most non-empty payment
 * fields), and emits a per-row UPDATE seed for the new payroll-dispatch
 * columns on employee_hourly_rates.
 *
 * Output: references/seed_payroll_dispatch_columns.sql
 */
import { readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';

const ROOT = path.resolve(import.meta.dirname, '..');
const CSV_PATH = path.join(ROOT, 'references', 'NEW Payroll Dashboard - All Dept.csv');
const OUT_PATH = path.join(ROOT, 'references', 'seed_payroll_dispatch_columns.sql');

function parseCSV(text) {
  const rows = [];
  let row = [];
  let cur = '';
  let inQ = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (c === '"') {
      if (inQ && text[i + 1] === '"') { cur += '"'; i++; continue; }
      inQ = !inQ;
      continue;
    }
    if (c === ',' && !inQ) { row.push(cur); cur = ''; continue; }
    if ((c === '\n' || c === '\r') && !inQ) {
      if (c === '\r' && text[i + 1] === '\n') i++;
      row.push(cur); cur = '';
      rows.push(row); row = [];
      continue;
    }
    cur += c;
  }
  if (cur.length || row.length) { row.push(cur); rows.push(row); }
  return rows;
}

function clean(s) {
  if (s == null) return '';
  const v = String(s).replace(/\r/g, '').replace(/\s+/g, ' ').trim();
  // Excel error markers and other non-values that shouldn't be seeded.
  if (/^(#n\/?a|n\/?a|none|null|-|--)$/i.test(v)) return '';
  return v;
}

function sqlStr(s) {
  if (s == null || s === '') return 'NULL';
  return "'" + String(s).replace(/'/g, "''") + "'";
}

const text = readFileSync(CSV_PATH, 'utf8');
const allRows = parseCSV(text);
const header = allRows[0];

// Locate column indexes by trimmed/normalised header text.
const norm = (s) => clean(s).toLowerCase();
const idx = (name) => {
  const want = norm(name);
  const i = header.findIndex((h) => norm(h) === want);
  if (i < 0) throw new Error(`Header column not found: "${name}"`);
  return i;
};

const COL = {
  phone:           idx('Phone Number'),
  workEmail:       idx('Work Email'),
  city:            idx('City'),
  province:        idx('Province /State'),  // header has "Province\n/State" → cleaned to "Province /State"
  fullAddress:     idx('Full Address'),
  hurupayEmail:    idx('HuruPay Email Account'),
  higlobeEmail:    idx('HiGlobe Email'),
  higlobeAccount:  idx('HiGlobe Account Name'),
  bankPreferred:   idx('Bank preferred'),
};

// Group rows by lowercased work email, pick the row with the most non-empty
// values across the columns we care about. Ties broken by latest CSV row.
const PICK_COLS = [
  COL.bankPreferred, COL.hurupayEmail, COL.higlobeEmail, COL.higlobeAccount,
  COL.phone, COL.fullAddress, COL.city, COL.province,
];

const best = new Map();
for (let r = 1; r < allRows.length; r++) {
  const row = allRows[r];
  if (!row || row.length < header.length / 2) continue;
  const we = clean(row[COL.workEmail]).toLowerCase();
  if (!we || !we.includes('@')) continue;
  let score = 0;
  for (const c of PICK_COLS) if (clean(row[c])) score++;
  const prev = best.get(we);
  if (!prev || score > prev.score) best.set(we, { score, row });
}

const lines = [];
lines.push('-- ============================================================');
lines.push('-- Seed: payroll-dispatch columns on employee_hourly_rates');
lines.push('-- Source: references/NEW Payroll Dashboard - All Dept.csv');
lines.push('-- Generated: per-row UPDATE matched on LOWER("Work Email")');
lines.push('-- Run AFTER the ALTER TABLE migration in pending_sql.md');
lines.push('-- ============================================================');
lines.push('');
lines.push('-- Step 1: ensure new columns exist (idempotent)');
lines.push('ALTER TABLE employee_hourly_rates');
lines.push('  ADD COLUMN IF NOT EXISTS "Bank Preferred"       TEXT,');
lines.push('  ADD COLUMN IF NOT EXISTS "Hurupay Email"        TEXT,');
lines.push('  ADD COLUMN IF NOT EXISTS "HiGlobe Email"        TEXT,');
lines.push('  ADD COLUMN IF NOT EXISTS "HiGlobe Account Name" TEXT,');
lines.push('  ADD COLUMN IF NOT EXISTS "Phone Number"         TEXT,');
lines.push('  ADD COLUMN IF NOT EXISTS "Full Address"         TEXT,');
lines.push('  ADD COLUMN IF NOT EXISTS "City"                 TEXT,');
lines.push('  ADD COLUMN IF NOT EXISTS "Province/State"       TEXT;');
lines.push('');
lines.push('-- Step 2: per-row UPDATE — only sets a value when the CSV cell is non-empty');
lines.push('--          (so re-running cannot overwrite curated values with nulls).');
lines.push('');

let written = 0;
const sortedEmails = [...best.keys()].sort();
for (const we of sortedEmails) {
  const row = best.get(we).row;
  const vals = {
    bankPreferred:  clean(row[COL.bankPreferred]),
    hurupayEmail:   clean(row[COL.hurupayEmail]),
    higlobeEmail:   clean(row[COL.higlobeEmail]),
    higlobeAccount: clean(row[COL.higlobeAccount]),
    phone:          clean(row[COL.phone]),
    fullAddress:    clean(row[COL.fullAddress]),
    city:           clean(row[COL.city]),
    province:       clean(row[COL.province]),
  };
  // Skip rows with literally nothing to seed.
  if (!Object.values(vals).some((v) => v)) continue;

  const setParts = [];
  if (vals.bankPreferred)  setParts.push(`"Bank Preferred" = COALESCE(${sqlStr(vals.bankPreferred)},  "Bank Preferred")`);
  if (vals.hurupayEmail)   setParts.push(`"Hurupay Email" = COALESCE(${sqlStr(vals.hurupayEmail)},   "Hurupay Email")`);
  if (vals.higlobeEmail)   setParts.push(`"HiGlobe Email" = COALESCE(${sqlStr(vals.higlobeEmail)},   "HiGlobe Email")`);
  if (vals.higlobeAccount) setParts.push(`"HiGlobe Account Name" = COALESCE(${sqlStr(vals.higlobeAccount)}, "HiGlobe Account Name")`);
  if (vals.phone)          setParts.push(`"Phone Number" = COALESCE(${sqlStr(vals.phone)},           "Phone Number")`);
  if (vals.fullAddress)    setParts.push(`"Full Address" = COALESCE(${sqlStr(vals.fullAddress)},     "Full Address")`);
  if (vals.city)           setParts.push(`"City" = COALESCE(${sqlStr(vals.city)},                    "City")`);
  if (vals.province)       setParts.push(`"Province/State" = COALESCE(${sqlStr(vals.province)},      "Province/State")`);

  lines.push(
    `UPDATE employee_hourly_rates SET ${setParts.join(', ')} WHERE LOWER("Work Email") = ${sqlStr(we)};`,
  );
  written++;
}

lines.push('');
lines.push(`-- Updates emitted: ${written}`);
lines.push('');
writeFileSync(OUT_PATH, lines.join('\n'));
console.log(`Wrote ${written} UPDATE statements to ${path.relative(ROOT, OUT_PATH)}`);
