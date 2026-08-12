/**
 * STRICTLY READ-ONLY probe: what does the HSL parent→sub-department rate
 * migration actually have to move, as of today?
 *
 * No insert / update / delete / upsert anywhere in this file.
 *
 *   npx tsx <this file>
 */
import { createClient } from '@supabase/supabase-js';
import dotenv from 'dotenv';

dotenv.config({ path: '.env.local' });
dotenv.config();

const url = process.env.NEXT_PUBLIC_SUPABASE_URL!;
const key = process.env.SUPABASE_SERVICE_ROLE_KEY!;
const db = createClient(url, key, { auth: { persistSession: false } });

/** PostgREST truncates at 1000 rows even with .range() — always page. */
async function pageAll<T>(build: (from: number, to: number) => any): Promise<T[]> {
  const out: T[] = [];
  const SIZE = 1000;
  for (let from = 0; ; from += SIZE) {
    const { data, error } = await build(from, from + SIZE - 1);
    if (error) throw new Error(error.message);
    const rows = (data ?? []) as T[];
    out.push(...rows);
    if (rows.length < SIZE) break;
  }
  return out;
}

// ── 1. Catalog pay structures in the HSL family ─────────────────────────────
const structures = await pageAll<any>((f, t) =>
  db
    .from('payment_catalog_pay_structures')
    .select('id, scope, department_key, employee_email, regular_rate, ot_rate, currency, updated_at')
    .range(f, t),
);

const hslFam = structures.filter((s) => {
  const k = String(s.department_key ?? '').toLowerCase();
  return k === 'hogan_smith_law' || k.startsWith('hsl:');
});

console.log('\n=== 1. Payment Catalog structures, HSL family ===');
console.log(`total structures in catalog: ${structures.length}`);
const deptScoped = hslFam.filter((s) => s.scope === 'department');
const empScoped = hslFam.filter((s) => s.scope === 'employee');
console.log(`\n-- DEPARTMENT-scope (the rail rows) --`);
for (const s of deptScoped) {
  console.log(
    `  ${String(s.department_key).padEnd(28)} reg=${s.regular_rate} ot=${s.ot_rate} ${s.currency}  (updated ${s.updated_at})`,
  );
}
if (!deptScoped.length) console.log('  (none)');
console.log(`\n-- EMPLOYEE-scope under an HSL key: ${empScoped.length} --`);
const empByKey = new Map<string, number>();
for (const s of empScoped) empByKey.set(s.department_key, (empByKey.get(s.department_key) ?? 0) + 1);
for (const [k, n] of [...empByKey].sort()) console.log(`  ${k.padEnd(28)} ${n}`);

// ── 2. Live roster: who is in the HSL family, and under which exact label ───
const roster = await pageAll<any>((f, t) =>
  db.from('active_employees').select('"Work Email", "Department", "Name"').range(f, t),
);
const isHslRaw = (d: string) => {
  const s = String(d ?? '').trim().toLowerCase();
  return s === 'hsl' || s === 'hogan smith law' || s === 'hogan' || s === 'hogan_smith_law' || s.startsWith('hsl:');
};
const hslPeople = roster.filter((r) => isHslRaw(r.Department));
const byLabel = new Map<string, number>();
for (const r of hslPeople) {
  const l = String(r.Department ?? '').trim();
  byLabel.set(l, (byLabel.get(l) ?? 0) + 1);
}
console.log(`\n=== 2. Active roster, HSL family: ${hslPeople.length} people ===`);
for (const [l, n] of [...byLabel].sort((a, b) => b[1] - a[1])) {
  console.log(`  ${l.padEnd(30)} ${n}`);
}

// ── 3. Which of them would a dept base rate actually reach? ─────────────────
// Engine precedence: employee catalog -> rate history / sheet -> DEPARTMENT base.
// Anyone with an individual rate is UNAFFECTED by a dept-base change.
const hslEmails = new Set(hslPeople.map((r) => String(r['Work Email'] ?? '').toLowerCase()).filter(Boolean));
const empCatalogEmails = new Set(
  structures
    .filter((s) => s.scope === 'employee' && s.employee_email)
    .map((s) => String(s.employee_email).toLowerCase()),
);

const hourly = await pageAll<any>((f, t) =>
  db.from('employee_hourly_rates').select('"Work Email", "Department", "Regular Rate"').range(f, t),
);
const hourlyByEmail = new Map<string, any>();
for (const r of hourly) {
  const e = String(r['Work Email'] ?? '').toLowerCase();
  if (e) hourlyByEmail.set(e, r);
}

const history = await pageAll<any>((f, t) =>
  db.from('employee_rate_history').select('employee_email, regular_rate, effective_from').range(f, t),
);
const historyEmails = new Set(history.map((r) => String(r.employee_email ?? '').toLowerCase()));

let withIndividualCatalog = 0;
let withSheetRate = 0;
let withHistory = 0;
let ridesDeptBase = 0;
const ridesList: string[] = [];
for (const e of hslEmails) {
  if (empCatalogEmails.has(e)) { withIndividualCatalog++; continue; }
  if (historyEmails.has(e)) { withHistory++; continue; }
  const h = hourlyByEmail.get(e);
  if (h && h['Regular Rate'] != null) { withSheetRate++; continue; }
  ridesDeptBase++;
  ridesList.push(e);
}
console.log(`\n=== 3. What a DEPARTMENT base rate actually reaches ===`);
console.log(`  individual catalog rate : ${withIndividualCatalog}  (dept base irrelevant)`);
console.log(`  rate-history rate       : ${withHistory}  (dept base irrelevant)`);
console.log(`  sheet employee_hourly   : ${withSheetRate}  (dept base irrelevant)`);
console.log(`  --> RIDES THE DEPT BASE : ${ridesDeptBase}`);
if (ridesList.length && ridesList.length <= 40) console.log('     ' + ridesList.join('\n     '));

// ── 4. The HARD HOLD: what label do HSL hourly-rate rows carry? ─────────────
const hslHourly = hourly.filter((r) => hslEmails.has(String(r['Work Email'] ?? '').toLowerCase()));
const hourlyLabels = new Map<string, number>();
for (const r of hslHourly) {
  const l = String(r.Department ?? '(null)').trim();
  hourlyLabels.set(l, (hourlyLabels.get(l) ?? 0) + 1);
}
console.log(`\n=== 4. employee_hourly_rates."Department" for HSL people (${hslHourly.length} rows) ===`);
for (const [l, n] of [...hourlyLabels].sort((a, b) => b[1] - a[1])) console.log(`  ${l.padEnd(30)} ${n}`);
console.log('\n(read-only: nothing was written)\n');
