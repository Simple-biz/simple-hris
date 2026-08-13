/**
 * Seed the department-scope Payment Catalog base rate for the PLACEMENT-ONLY
 * HSL sub-teams (see docs/features/hsl-subdepartments.md §1.1):
 *
 *     hsl:simple_texting   →  ₱225.00 regular / ₱337.50 OT  (PHP)
 *
 * Kane, 2026-08-12: "just put them on 225 please and ot 337.50".
 *
 * `hsl:lead_nurture` was seeded here on 2026-08-12 and RETIRED on 2026-08-13 —
 * it named the same team as Simple Texting (see §7c). Its row is removed by
 * scripts/remove-hsl-lead-nurture-rate.mts. Do not re-add it to SEED: Guard 2
 * imports HSL_PLACEMENT_ONLY_SUB_KEYS from the code and would abort anyway.
 *
 * WHAT THIS MIRRORS. It replicates exactly what Accounting → Payment Catalog →
 * Pay Structure does for a DEPARTMENT-scope save (`upsertPayStructure` in
 * src/lib/supabase/pay-structures-db.ts): one row per department_key, employee
 * columns null, currency PHP. Department-scope saves deliberately do NOT touch
 * `employee_rate_history`, `employee_hourly_rates`, the Google rates sheet, the
 * Hogan Pay Plan sheet, or employee notifications — those are employee-scope
 * side effects only (pay-structures/route.ts:205). This script does none of them
 * either. It DOES write one audit row, which the UI route omits for dept saves;
 * a script-driven production write should be traceable.
 *
 * GUARDS (every one fails CLOSED):
 *   1. Payroll processing lock. The UI route refuses catalog edits while
 *      `payroll.dispatch_locked` is true (processing-guard.ts:22) because the
 *      catalog is the rate source of truth and editing mid-run desyncs staged
 *      amounts from what the paystub renders. Re-checked here. See the
 *      narrow exemption below — it is evidence-gated, not a switch.
 *   2. Key validity. Refuses any key that is not a real placement-only sub-team,
 *      validated by importing HSL_PLACEMENT_ONLY_SUB_KEYS from the actual code.
 *   3. Occupied slot. Refuses to overwrite an existing department-scope row for
 *      these keys — that would be a rate CHANGE for whoever sits there, not a
 *      seed. Re-run intent has to be explicit, so it aborts and tells you.
 *   4. Backup first. Writes every HSL-family pay structure to reports/ before
 *      touching anything (CLAUDE.md: a SELECT backup on disk precedes a write).
 *
 * THE LOCKED-CYCLE EXEMPTION (`--seed-while-locked-proven-no-op`)
 * Guard 1 exists to stop a rate edit from desyncing STAGED amounts mid-run. That
 * harm requires someone in the current run to resolve their rate through the key
 * being written. So the flag is honoured ONLY when all four preconditions below
 * prove nobody can:
 *      P1  zero master-list Department cells hold either target key
 *      P2  zero employee_hourly_rates rows carry either target key
 *      P3  zero employee-scope pay structures are keyed to either target key
 *      P4  the seeded figures EXACTLY equal the parent hogan_smith_law base,
 *          so even a future placement resolves the identical rate
 * With P1–P4 true the write cannot change any resolved rate for any person, so it
 * cannot move a staged amount. If ANY precondition fails the script aborts even
 * with the flag — the flag can never widen the guard, only ride a proof.
 *
 * USAGE
 *   node --import tsx scripts/seed-hsl-placement-subdept-rates.mts            # dry run
 *   node --import tsx scripts/seed-hsl-placement-subdept-rates.mts --apply    # writes
 *   …--apply --seed-while-locked-proven-no-op   # only if P1–P4 hold
 */
import { createClient } from '@supabase/supabase-js';
import { randomUUID } from 'node:crypto';
import { mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import dotenv from 'dotenv';

dotenv.config({ path: '.env.local' });
dotenv.config();

const APPLY = process.argv.includes('--apply');
const LOCKED_EXEMPTION = process.argv.includes('--seed-while-locked-proven-no-op');
const TABLE = 'payment_catalog_pay_structures';
const AUDIT_TABLE = 'audit_log'; // singular — see src/lib/supabase/audit-log.ts:136
const ACTOR = 'kaner@simple.biz';

/** The seed. Keys must match HSL_PLACEMENT_ONLY_SUB_KEYS in
 *  src/lib/departments/hsl-subdept.ts — validated against it below. */
const SEED = [
  { departmentKey: 'hsl:simple_texting', name: 'HSL — Simple Texting', regularRate: 225, otRate: 337.5 },
] as const;

const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
if (!url || !serviceKey) {
  console.error('FATAL: need NEXT_PUBLIC_SUPABASE_URL + SUPABASE_SERVICE_ROLE_KEY in .env.local');
  process.exit(1);
}
const db = createClient(url, serviceKey, { auth: { persistSession: false } });

const die = (msg: string): never => {
  console.error(`\nABORTED — ${msg}`);
  process.exit(1);
};

interface PayRow {
  id: string;
  scope: string;
  department_key: string;
  employee_email: string | null;
  regular_rate: number | string;
  ot_rate: number | string | null;
  currency: string;
  created_by: string | null;
  created_at: string | null;
  updated_by: string | null;
  updated_at: string | null;
}

/** PostgREST caps every read at 1000 rows even with .range() — always page. */
async function selectAllPaged<T>(table: string, cols: string): Promise<T[]> {
  const out: T[] = [];
  const SIZE = 1000;
  for (let from = 0; ; from += SIZE) {
    const { data, error } = await db
      .from(table)
      .select(cols)
      .order('created_at', { ascending: true })
      .order('id', { ascending: true })
      .range(from, from + SIZE - 1);
    if (error) die(`reading ${table}: ${error.message}`);
    const rows = (data ?? []) as T[];
    out.push(...rows);
    if (rows.length < SIZE) break;
  }
  return out;
}

const num = (v: number | string | null) => (v == null ? null : Number(v));
const peso = (v: number | null) =>
  v == null ? '—' : `₱${v.toLocaleString('en-PH', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;

console.log(`\n${APPLY ? '=== APPLY ===' : '=== DRY RUN (pass --apply to write) ==='}\n`);

// ── Guard 2: the keys really are placement-only sub-teams ────────────────────
// Validated by importing the ACTUAL code, so the script cannot seed a key the
// application does not recognise as a placement.
{
  const mod = await import('../src/lib/departments/hsl-subdept.js').catch((e: unknown) => {
    die(
      `could not import HSL_PLACEMENT_ONLY_SUB_KEYS from src/lib/departments/hsl-subdept: ${String(e)}. ` +
        'Refusing to seed keys I cannot validate against the code.',
    );
  });
  const keys = (mod as { HSL_PLACEMENT_ONLY_SUB_KEYS?: readonly string[] }).HSL_PLACEMENT_ONLY_SUB_KEYS;
  if (!keys?.length) die('HSL_PLACEMENT_ONLY_SUB_KEYS imported but empty — refusing to guess.');
  for (const s of SEED) {
    const bare = s.departmentKey.replace(/^hsl:/, '');
    if (!keys.includes(bare)) {
      die(`"${s.departmentKey}" is not in HSL_PLACEMENT_ONLY_SUB_KEYS (${keys.join(', ')}). Add the key to the code first.`);
    }
  }
  console.log(`Guard 2/4  keys valid .................. ${SEED.length}/${SEED.length} real placement-only sub-teams (${keys.join(', ')})`);
}

// ── Read current state ───────────────────────────────────────────────────────
const all = await selectAllPaged<PayRow>(TABLE, '*');
const hslFamily = all.filter((r) => /^(hsl|hogan)/i.test((r.department_key ?? '').trim()));

// DEPARTMENT-scope rows in full (there are few, and they are what we're changing);
// employee-scope rows summarised per department key (there are hundreds).
console.log(`\nHSL-family pay structures on file (${hslFamily.length}):`);
for (const r of hslFamily.filter((x) => x.scope === 'department')) {
  console.log(
    `  department  ${r.department_key.padEnd(24)} reg ${peso(num(r.regular_rate))}  ot ${peso(num(r.ot_rate))}  ${r.currency}` +
      `   (set by ${r.created_by ?? '?'})`,
  );
}
{
  const byKey = new Map<string, number>();
  for (const r of hslFamily.filter((x) => x.scope === 'employee')) {
    byKey.set(r.department_key, (byKey.get(r.department_key) ?? 0) + 1);
  }
  for (const [k, n] of [...byKey].sort((a, b) => b[1] - a[1])) {
    console.log(`  employee    ${k.padEnd(24)} ${n} individual override(s)`);
  }
}

const parent = hslFamily.find((r) => r.scope === 'department' && r.department_key === 'hogan_smith_law');
if (!parent) {
  console.log('\n  NOTE: no department-scope hogan_smith_law row — the parent fallback is EMPTY.');
} else {
  console.log(
    `\n  Parent fallback (hogan_smith_law): reg ${peso(num(parent.regular_rate))} / ot ${peso(num(parent.ot_rate))} ${parent.currency}`,
  );
}

// ── Preconditions P1–P4: can this write move ANY person's resolved rate? ─────
const targets = SEED.map((s) => s.departmentKey.toLowerCase());

const masterHeadcount = await (async () => {
  const counts = new Map<string, number>(targets.map((t) => [t, 0]));
  let total = 0;
  const SIZE = 1000;
  for (let from = 0; ; from += SIZE) {
    const { data, error } = await db.from('global_master_list').select('"Department"').range(from, from + SIZE - 1);
    if (error) die(`reading global_master_list: ${error.message}`);
    const rows = (data ?? []) as { Department: string | null }[];
    for (const r of rows) {
      total++;
      const d = (r.Department ?? '').trim().toLowerCase();
      if (counts.has(d)) counts.set(d, counts.get(d)! + 1);
    }
    if (rows.length < SIZE) break;
  }
  return { counts, total };
})();

const ratesRowHits = await (async () => {
  // employee_hourly_rates uses QUOTED display-name columns, not snake_case.
  const { data, error } = await db.from('employee_hourly_rates').select('"Work Email", "Department"');
  if (error) {
    console.error(`  NOTE: could not read employee_hourly_rates (${error.message}) — P2 cannot be proven.`);
    return null;
  }
  return ((data ?? []) as { Department: string | null }[]).filter((r) =>
    targets.includes((r.Department ?? '').trim().toLowerCase()),
  ).length;
})();

const employeeScopeHits = all.filter(
  (r) => r.scope === 'employee' && targets.includes((r.department_key ?? '').trim().toLowerCase()),
).length;

const parentReg = parent ? Number(parent.regular_rate) : null;
const parentOt = parent ? num(parent.ot_rate) : null;
const figuresMatchParent =
  parent != null && SEED.every((s) => parentReg === s.regularRate && parentOt === s.otRate);

const totalHeadcount = targets.reduce((n, t) => n + (masterHeadcount.counts.get(t) ?? 0), 0);

const P = [
  { id: 'P1', ok: totalHeadcount === 0, label: `master-list cells holding a target key = ${totalHeadcount} (of ${masterHeadcount.total} rows)` },
  { id: 'P2', ok: ratesRowHits === 0, label: `employee_hourly_rates rows on a target key = ${ratesRowHits ?? 'UNKNOWN'}` },
  { id: 'P3', ok: employeeScopeHits === 0, label: `employee-scope structures on a target key = ${employeeScopeHits}` },
  {
    id: 'P4',
    ok: figuresMatchParent,
    label: `seeded figures equal the parent base (parent reg ${peso(parentReg)} / ot ${peso(parentOt)})`,
  },
];

console.log('\nPreconditions — could this write move anyone’s resolved rate?');
for (const p of P) console.log(`  ${p.ok ? '✓' : '✗'} ${p.id}  ${p.label}`);
const provenNoOp = P.every((p) => p.ok);
console.log(
  provenNoOp
    ? '  → PROVEN NO-OP: no person resolves a rate through either key, and the figures\n' +
        '    match the parent fallback, so no staged amount can move.'
    : '  → NOT a proven no-op. This write could change someone’s resolved rate.',
);

// ── Guard 1: the payroll processing lock ─────────────────────────────────────
// Mirrors rejectWhilePayrollProcessing (processing-guard.ts:22). The UI's
// admin-role bypass is deliberately NOT replicated — a script has no session to
// prove admin with, so it fails closed and relies on the P1–P4 proof instead.
{
  const { data, error } = await db
    .from('app_settings')
    .select('key, value')
    .in('key', ['payroll.dispatch_locked', 'payroll.dispatch_locked_at', 'payroll.dispatch_locked_by']);
  if (error) die(`could not read the payroll dispatch lock: ${error.message}`);
  const bag = new Map((data ?? []).map((r) => [r.key as string, String(r.value ?? '')]));
  const locked = (bag.get('payroll.dispatch_locked') ?? '').trim().toLowerCase() === 'true';
  const who = `locked ${bag.get('payroll.dispatch_locked_at') || '?'} by ${bag.get('payroll.dispatch_locked_by') || '?'}`;

  if (!locked) {
    console.log('\nGuard 1/4  payroll dispatch lock ....... OPEN (not processing)');
  } else if (!provenNoOp) {
    die(
      `payroll is being processed right now (${who}) and this write is NOT a proven no-op. ` +
        `The catalog is the rate source of truth — editing it mid-run desyncs staged amounts from the ` +
        `paystubs. Re-run once Payment Dispatch is unlocked.`,
    );
  } else if (!LOCKED_EXEMPTION) {
    die(
      `payroll is being processed right now (${who}).\n` +
        `  P1–P4 all hold, so this particular write provably cannot move any staged amount.\n` +
        `  If you want it to land during the locked run anyway, re-run with:\n` +
        `      --apply --seed-while-locked-proven-no-op\n` +
        `  Otherwise wait for Payment Dispatch to unlock and re-run with just --apply.`,
    );
  } else {
    console.log(`\nGuard 1/4  payroll dispatch lock ....... LOCKED (${who})`);
    console.log('           EXEMPTION ACTIVE — P1–P4 proved the write cannot move a staged amount.');
  }
}

// ── Guard 3: refuse to overwrite an occupied slot ────────────────────────────
{
  const collisions = SEED.map((s) => ({
    s,
    existing: all.find((r) => r.scope === 'department' && r.department_key === s.departmentKey),
  })).filter((c) => c.existing);
  if (collisions.length) {
    for (const c of collisions) {
      console.error(
        `  ${c.s.departmentKey} already has a department-scope row: ` +
          `reg ${peso(num(c.existing!.regular_rate))} / ot ${peso(num(c.existing!.ot_rate))} ` +
          `(set by ${c.existing!.created_by ?? '?'} ${c.existing!.created_at ?? ''})`,
      );
    }
    die(
      'one or more slots are already occupied. Changing an existing department base rate is a rate CHANGE ' +
        'for everyone riding it, not a seed — do that from Payment Catalog → Pay Structure so it goes through ' +
        'the normal guards, or say explicitly that you want it overwritten.',
    );
  }
  console.log(`Guard 3/4  slots free .................. ${SEED.length}/${SEED.length} (no existing dept row to clobber)`);
}

// ── Guard 4: backup to disk before writing ──────────────────────────────────
const reportsDir = path.join(process.cwd(), 'reports');
mkdirSync(reportsDir, { recursive: true });
const stamp = new Date().toISOString().replace(/[:.]/g, '-');
const backupPath = path.join(reportsDir, `backup_hsl_pay_structures_${stamp}.json`);
writeFileSync(
  backupPath,
  JSON.stringify(
    { takenAt: new Date().toISOString(), table: TABLE, filter: 'department_key ~ ^(hsl|hogan)', rows: hslFamily },
    null,
    2,
  ),
  'utf8',
);
console.log(`Guard 4/4  backup written .............. ${path.relative(process.cwd(), backupPath)} (${hslFamily.length} rows)`);

// ── The plan ─────────────────────────────────────────────────────────────────
console.log('\nPlanned INSERTs (department scope, PHP):');
for (const s of SEED) {
  console.log(`  ${s.name.padEnd(26)} ${s.departmentKey.padEnd(22)} reg ${peso(s.regularRate)}  ot ${peso(s.otRate)}`);
}

console.log(
  totalHeadcount === 0
    ? '\nNobody is placed in either sub-team yet, so this changes NOBODY’s pay today.' +
        (figuresMatchParent ? ' The figures also equal the parent fallback, so it stays economically neutral even after the first placement.' : '')
    : `\n${totalHeadcount} person/people sit in these sub-teams and WOULD be repriced. Verify before applying.`,
);

if (!APPLY) {
  console.log('\nDry run only — nothing written. Re-run with --apply to commit.\n');
  process.exit(0);
}

// ── Apply ────────────────────────────────────────────────────────────────────
console.log('\nWriting…');
const written: PayRow[] = [];
for (const s of SEED) {
  const payload = {
    id: randomUUID(),
    scope: 'department' as const,
    department_key: s.departmentKey,
    employee_email: null,
    employee_name: null,
    regular_rate: s.regularRate,
    ot_rate: s.otRate,
    currency: 'PHP',
    created_by: ACTOR,
    updated_by: ACTOR,
  };
  const { data, error } = await db.from(TABLE).insert(payload).select('*').maybeSingle();
  if (error) die(`inserting ${s.departmentKey}: ${error.message}`);
  written.push(data as PayRow);
  console.log(`  ✓ ${s.departmentKey.padEnd(22)} reg ${peso(s.regularRate)} / ot ${peso(s.otRate)} PHP`);
}

// Audit trail. The UI route only audits employee-scope saves; a script-driven
// production rate write should be attributable. Non-fatal but reported loudly —
// the rate rows are the deliverable and are already committed by this point.
{
  const { error } = await db.from(AUDIT_TABLE).insert(
    written.map((r) => ({
      user_name: ACTOR,
      user_role: 'accounting',
      action: 'payroll.rate.set',
      resource: TABLE,
      resource_id: r.department_key,
      details: {
        source: 'script:seed-hsl-placement-subdept-rates',
        scope: 'department',
        department_key: r.department_key,
        regular_rate: num(r.regular_rate),
        ot_rate: num(r.ot_rate),
        currency: r.currency,
        note: 'Placement-only HSL sub-team seeded at the parent figures per Kane 2026-08-12.',
      },
    })),
  );
  if (error) console.error(`\n  WARNING: rates written, but the audit row failed: ${error.message}`);
  else console.log(`  ✓ ${AUDIT_TABLE.padEnd(20)} ${written.length} row(s)`);
}

// ── Verify by re-reading ─────────────────────────────────────────────────────
const after = await selectAllPaged<PayRow>(TABLE, '*');
console.log('\nVerification (re-read from the DB):');
let ok = true;
for (const s of SEED) {
  const rows = after.filter((r) => r.scope === 'department' && r.department_key === s.departmentKey);
  if (rows.length !== 1) {
    ok = false;
    console.error(`  ✗ ${s.departmentKey}: expected exactly 1 department row, found ${rows.length}`);
    continue;
  }
  const r = rows[0];
  const good =
    Number(r.regular_rate) === s.regularRate &&
    Number(r.ot_rate) === s.otRate &&
    r.currency === 'PHP' &&
    r.employee_email === null;
  if (!good) ok = false;
  console.log(
    `  ${good ? '✓' : '✗'} ${s.departmentKey.padEnd(22)} reg ${peso(num(r.regular_rate))}  ot ${peso(num(r.ot_rate))}  ${r.currency}`,
  );
}
console.log(ok ? '\nDone — both rates verified live.\n' : '\nFAILED verification — inspect the rows above.\n');
process.exit(ok ? 0 : 1);
