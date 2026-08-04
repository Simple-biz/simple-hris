/**
 * READ-ONLY audit: which HSL people have a stored OT rate that is NOT exactly
 * 1.5x their regular rate?
 *
 * WHY THIS EXISTS
 * The business policy (per Carla) is that overtime pays 1.5x the regular rate.
 * The pay engine does NOT enforce that: `computeProratedRowPay`
 * (src/lib/payroll/current-pay.ts) pays `otRate * otHours`, where `otRate` is an
 * independently stored value. `regularRate * 1.5` appears in exactly two places,
 * neither of which is the pay run:
 *   - `defaultOtRate()` in src/lib/payment-catalog/pay-structure.ts — a UI default
 *     that pre-fills the OT-rate box when an admin CREATES a rate structure, and
 *     is freely overridable;
 *   - a display-only "shortfall" estimate in PayrollWizard.tsx.
 * So an OT rate can drift to any value and the engine will pay it silently. This
 * script finds those people BEFORE anything is changed.
 *
 * It also matters for the paystub: a two-stage "Base Pay + OT Differential"
 * presentation only reconciles to the amount actually paid when OT is exactly
 * 1.5x regular. Anyone listed here would be misstated by a hardcoded 0.5x line.
 *
 * WHAT IT READS (three stores, in the engine's own precedence order)
 *   1. payment_catalog_pay_structures — the Payment Catalog (override / source of truth)
 *   2. employee_rate_history         — dated per-day rates
 *   3. employee_hourly_rates         — the HSL sheet cache (final fallback)
 * A person can be off-ratio in one store and fine in another, so each store is
 * reported separately rather than collapsed.
 *
 * STRICTLY READ-ONLY. No insert / update / delete / upsert anywhere in this file.
 * It reports; a human fixes the rate at source.
 *
 *   npx tsx scripts/audit-hsl-ot-ratio.mts
 *
 * If the app-module imports fail to resolve, use the server-only stub tsconfig:
 *   $env:TSX_TSCONFIG_PATH="tsconfig.readiness-verify.json"
 */
import { createClient } from '@supabase/supabase-js';
import dotenv from 'dotenv';

dotenv.config({ path: '.env.local' });
dotenv.config();

// Imported, never re-implemented: mirroring rate logic in a script is the exact
// drift class this audit is meant to surface.
const { normalizeDeptToKey } = await import('../src/lib/payroll/normalize-dept-key');
const { defaultOtRate, isAutoOtRate, OT_MULTIPLIER } = await import(
  '../src/lib/payment-catalog/pay-structure'
);
const { mapEmployeeHourlyRateRow } = await import('../src/lib/supabase/employee-hourly-rates');

const url = process.env.NEXT_PUBLIC_SUPABASE_URL?.trim();
const key = process.env.SUPABASE_SERVICE_ROLE_KEY?.trim();
if (!url || !key) {
  console.error('Missing NEXT_PUBLIC_SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY');
  process.exit(1);
}
const sb = createClient(url, key, { auth: { persistSession: false, autoRefreshToken: false } });

/** PostgREST caps a single response at db.max-rows (1000) even with .range() — always page. */
async function readAll(
  table: string,
  columns = '*',
): Promise<Record<string, unknown>[]> {
  const PAGE = 1000;
  const out: Record<string, unknown>[] = [];
  for (let from = 0; ; from += PAGE) {
    const { data, error } = await sb.from(table).select(columns).range(from, from + PAGE - 1);
    if (error) throw new Error(`${table}: ${error.message}`);
    const page = (data ?? []) as unknown as Record<string, unknown>[];
    out.push(...page);
    if (page.length < PAGE) break;
  }
  return out;
}

/** Mirrors PayrollWizard.tsx parseRateField: trim, strip thousands commas, parse. */
function parseRate(v: unknown): number | null {
  if (v == null) return null;
  const s = String(v).trim().replace(/,/g, '');
  if (s === '') return null;
  const n = parseFloat(s);
  return Number.isFinite(n) ? n : null;
}

function norm(v: unknown): string {
  return String(v ?? '').trim().toLowerCase();
}

/** Tolerant column read — master-list / sheet-import tables use quoted capitalised names. */
function pick(row: Record<string, unknown>, aliases: string[]): unknown {
  const idx = new Map<string, unknown>();
  for (const [k, v] of Object.entries(row)) {
    idx.set(k.toLowerCase().replace(/\s+/g, '_'), v);
    idx.set(k.toLowerCase().replace(/\s+/g, ''), v);
  }
  for (const a of aliases) {
    for (const c of [a.toLowerCase().replace(/\s+/g, '_'), a.toLowerCase().replace(/\s+/g, '')]) {
      const v = idx.get(c);
      if (v !== undefined && v !== null && String(v).trim() !== '') return v;
    }
  }
  return undefined;
}

/** HSL membership, via the app's own resolver (handles the `hsl:<subteam>` prefix). */
function isHslDept(dept: unknown): boolean {
  const raw = String(dept ?? '').trim();
  if (!raw) return false;
  if (normalizeDeptToKey(raw) === 'hogan_smith_law') return true;
  // Belt-and-braces: labels the map doesn't know but that are plainly HSL.
  const l = raw.toLowerCase();
  return l.startsWith('hsl') || l.includes('hogan');
}

type Finding = {
  store: string;
  email: string;
  name: string;
  dept: string;
  regular: number;
  ot: number;
  expected: number;
  perOtHour: number;
  offboarded: boolean;
  detail?: string;
};

console.log('HSL OT-ratio audit — READ-ONLY. Nothing is written.');
console.log(`Policy under test: OT rate === regular x ${OT_MULTIPLIER}\n`);

// ---------------------------------------------------------------- master roster
const master = await readAll('global_master_list');
type Person = { name: string; dept: string; offboarded: boolean };
const hslByEmail = new Map<string, Person>();
for (const row of master) {
  const dept = String(pick(row, ['Department', 'department']) ?? '');
  if (!isHslDept(dept)) continue;
  const work = norm(pick(row, ['Work Email', 'work_email']));
  const personal = norm(pick(row, ['Personal Email', 'personal_email']));
  const name = String(pick(row, ['Name', 'name', 'Full Name']) ?? '(no name)');
  // Offboard state is stamped on the master list, not employee_ids.
  const offRaw = pick(row, ['off_board', 'offboarded', 'Off Board', 'off_boarded']);
  const offboarded = offRaw === true || ['true', 'yes', 'y', '1'].includes(norm(offRaw));
  const person: Person = { name, dept, offboarded };
  for (const e of [work, personal]) if (e) hslByEmail.set(e, person);
}
console.log(
  `Master list: ${master.length} rows, ${new Set([...hslByEmail.values()].map((p) => p.name)).size} HSL people ` +
    `(${hslByEmail.size} email keys).`,
);

const findings: Finding[] = [];
const seenOnRatio = new Set<string>();

function check(store: string, email: string, reg: unknown, ot: unknown, detail?: string) {
  const e = norm(email);
  const person = hslByEmail.get(e);
  if (!person) return; // not HSL — out of scope for this audit
  const regular = parseRate(reg);
  const otRate = parseRate(ot);
  if (regular == null || regular <= 0) return; // no regular rate → nothing to compare against
  if (otRate == null) {
    findings.push({
      store,
      email: e,
      name: person.name,
      dept: person.dept,
      regular,
      ot: NaN,
      expected: defaultOtRate(regular),
      perOtHour: defaultOtRate(regular),
      offboarded: person.offboarded,
      detail: detail ? `${detail}; OT RATE MISSING` : 'OT RATE MISSING',
    });
    return;
  }
  if (isAutoOtRate(regular, otRate)) {
    seenOnRatio.add(`${store}|${e}`);
    return;
  }
  const expected = defaultOtRate(regular);
  findings.push({
    store,
    email: e,
    name: person.name,
    dept: person.dept,
    regular,
    ot: otRate,
    expected,
    perOtHour: Math.round((otRate - expected) * 100) / 100,
    offboarded: person.offboarded,
    detail,
  });
}

// ------------------------------------------------- 1. Payment Catalog structures
const structures = await readAll('payment_catalog_pay_structures');
let catalogEmployeeScoped = 0;
for (const s of structures) {
  if (norm(s.scope) !== 'employee') continue; // dept-scope rows have no single owner
  catalogEmployeeScoped++;
  check(
    'catalog',
    String(s.employee_email ?? ''),
    s.regular_rate,
    s.ot_rate,
    `currency=${String(s.currency ?? '?')}`,
  );
}
console.log(
  `Payment Catalog: ${structures.length} structures (${catalogEmployeeScoped} employee-scoped).`,
);

// ------------------------------------------------------- 2. Dated rate history
const history = await readAll(
  'employee_rate_history',
  'employee_email, regular_rate, ot_rate, effective_from',
);
// Newest effective_from per email — the row the engine resolves for a current week.
const newestByEmail = new Map<string, Record<string, unknown>>();
for (const h of history) {
  const e = norm(h.employee_email);
  if (!e) continue;
  const prev = newestByEmail.get(e);
  if (!prev || String(h.effective_from ?? '') > String(prev.effective_from ?? '')) {
    newestByEmail.set(e, h);
  }
}
for (const [e, h] of newestByEmail) {
  check('rate_history', e, h.regular_rate, h.ot_rate, `effective_from=${String(h.effective_from)}`);
}
console.log(
  `Rate history: ${history.length} rows, ${newestByEmail.size} people (newest row each).`,
);

// ------------------------------------------------------- 3. Sheet cache fallback
const rateRows = await readAll('employee_hourly_rates');
for (const raw of rateRows) {
  const r = mapEmployeeHourlyRateRow(raw);
  const email = r.work_email ?? r.personal_email ?? '';
  check('sheet_cache', email, r.regular_rate, r.ot_rate);
}
console.log(`Sheet cache: ${rateRows.length} employee_hourly_rates rows.\n`);

// --------------------------------------------------------------------- report
const active = findings.filter((f) => !f.offboarded);
const leavers = findings.filter((f) => f.offboarded);

function table(rows: Finding[], heading: string) {
  if (rows.length === 0) return;
  console.log(`\n${heading}`);
  console.log('-'.repeat(heading.length));
  const byPerson = new Map<string, Finding[]>();
  for (const f of rows) {
    const list = byPerson.get(f.name) ?? [];
    list.push(f);
    byPerson.set(f.name, list);
  }
  for (const [name, fs] of [...byPerson.entries()].sort((a, b) =>
    a[0].localeCompare(b[0]),
  )) {
    console.log(`\n  ${name}   [${fs[0].dept}]   ${fs[0].email}`);
    for (const f of fs.sort((a, b) => a.store.localeCompare(b.store))) {
      const otTxt = Number.isNaN(f.ot) ? '(missing)' : f.ot.toFixed(2);
      const sign = f.perOtHour > 0 ? '+' : '';
      const ratio = Number.isNaN(f.ot) ? 'n/a' : (f.ot / f.regular).toFixed(3);
      console.log(
        `      ${f.store.padEnd(13)} reg ${f.regular.toFixed(2).padStart(9)}` +
          `   ot ${otTxt.padStart(9)}` +
          `   expected ${f.expected.toFixed(2).padStart(9)}` +
          `   ${sign}${f.perOtHour.toFixed(2)}/OT-hr   ratio ${ratio}` +
          (f.detail ? `   (${f.detail})` : ''),
      );
    }
  }
}

console.log('='.repeat(78));
if (findings.length === 0) {
  console.log('RESULT: every HSL rate on file is exactly 1.5x. Nobody is off-ratio.');
  console.log('        Staged enforcement has an empty blocker list — safe to hard-derive.');
} else {
  console.log(
    `RESULT: ${findings.length} off-ratio rate record(s) across ` +
      `${new Set(findings.map((f) => f.name)).size} HSL people.`,
  );
  console.log(
    `        ${active.length} on active roster, ${leavers.length} on offboarded rows.`,
  );
  table(active, 'ACTIVE — fix these before the next pay run');
  table(leavers, 'OFFBOARDED — historical only, no upcoming pay');
  console.log(
    '\n  "+x/OT-hr" = paid ABOVE the 1.5x policy per overtime hour; "-x" = paid BELOW (underpaid).',
  );
  console.log(
    '  A two-stage paystub with a hardcoded 0.5x differential would MISSTATE every person above.',
  );
}
console.log('='.repeat(78));
console.log(
  `\nOn-ratio records verified: ${seenOnRatio.size}. Nothing was written to the database.`,
);
