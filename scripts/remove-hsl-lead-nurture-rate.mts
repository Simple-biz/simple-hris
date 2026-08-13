/**
 * Remove the orphaned department-scope Payment Catalog base rate for the RETIRED
 * placement-only HSL sub-team `hsl:lead_nurture`
 * (see docs/features/hsl-subdepartments.md §7c — Retiring a sub-team):
 *
 *     hsl:lead_nurture  →  ₱225.00 regular / ₱337.50 OT  (PHP), seeded 2026-08-12
 *
 * WHY. The key shipped 2026-08-12 and was withdrawn 2026-08-13. Carla and CJ
 * settled that it named the SAME team as Simple Texting and collided with Lucky's
 * separate Lead Nurture team — CJ: *"We can use HSL – SimpleTexting to avoid any
 * confusion with Lucky's Lead Nurture Team."* Kane: *"we need to remove the other
 * one."* The code no longer knows the key, so nothing can place, price or display
 * it; this row is what's left behind.
 *
 * WHY DELETE IT AT ALL, given nothing reads it. Two reasons, both about later:
 *   - the Payment Catalog is the rate SOURCE OF TRUTH (docs/features/
 *     payment-catalog-departments.md, memory rate-catalog-source-of-truth). A base
 *     rate for a department that does not exist is a lie in the source of truth.
 *   - `resolveDeptCatalogRate` matches on the raw namespaced key BEFORE
 *     normalizeDeptToKey. If the key is ever re-minted — or a hand-edited sheet
 *     cell reads `hsl:lead_nurture` — it would silently inherit a ₱225 base that
 *     nobody in that future chose. Empty is not the same as dead
 *     (memory dead-tables-drop-candidates); this one is genuinely dead, so it goes.
 *
 * WHAT THIS MIRRORS. The inverse of a department-scope Pay Structure save: it
 * deletes the one `payment_catalog_pay_structures` row and nothing else.
 * Department-scope writes have no `employee_rate_history` / `employee_hourly_rates`
 * / Google rates sheet / Pay Plan sheet / notification side effects
 * (pay-structures/route.ts:205), so neither does their removal. It adds one
 * `audit_log` row. It does NOT touch the 2026-08-12 `payroll.rate.set` audit row —
 * that is the history of the seed and history is never rewritten.
 *
 * GUARDS (every one fails CLOSED):
 *   1. The key must be RETIRED. Validated by importing HSL_PLACEMENT_ONLY_SUB_KEYS
 *      and HSL_DEPT_KEYS from the actual code: if `lead_nurture` is still in either
 *      keyspace this is a LIVE sub-team and deleting its base rate reprices whoever
 *      rides it. Land the code removal first. (Exact inverse of the seed's Guard 2.)
 *   2. Nobody may resolve a rate through the key. Zero master-list cells, zero
 *      employee_hourly_rates rows, zero employee-scope structures, zero
 *      hsl_team_members rows, zero LIVE department_managers grants
 *      (`revoked_at IS NULL` — revoked rows are tombstones, memory
 *      hsl-placement-only-subteams), zero open transfer requests.
 *   3. Exactly ONE department-scope row, and its figures must equal the parent
 *      hogan_smith_law base. Any other count aborts rather than bulk-deleting, and
 *      a row that DIFFERS from the parent means somebody set a real rate here on
 *      purpose — that is a decision, not an orphan, so it needs a human.
 *   4. Backup first: every HSL-family pay structure to reports/ before any write
 *      (CLAUDE.md — a SELECT backup on disk precedes a write).
 *   5. Payroll processing lock, re-checked from app_settings.
 *
 * THE LOCKED-CYCLE EXEMPTION (`--delete-while-locked-proven-no-op`)
 * Identical in spirit to the seed's, and the proof is stronger. The lock exists to
 * stop a catalog edit desyncing STAGED amounts mid-run, which requires somebody in
 * the run to resolve their rate through the key. So the flag is honoured ONLY when:
 *      P1  zero master-list Department cells hold the key
 *      P2  zero employee_hourly_rates rows carry it
 *      P3  zero employee-scope pay structures are keyed to it
 *      P4  the row being deleted EXACTLY equals the parent hogan_smith_law base,
 *          so the post-delete parent fallback resolves the identical figures
 * With P1-P4 true, deletion cannot change any resolved rate for any person, so it
 * cannot move a staged amount. If ANY precondition fails the script aborts even
 * with the flag — the flag rides a proof, it never widens the guard.
 *
 * USAGE
 *   node --import tsx scripts/remove-hsl-lead-nurture-rate.mts          # dry run
 *   node --import tsx scripts/remove-hsl-lead-nurture-rate.mts --apply  # deletes
 *   …--apply --delete-while-locked-proven-no-op   # only if P1-P4 hold
 */
import { createClient } from '@supabase/supabase-js';
import { mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import dotenv from 'dotenv';

dotenv.config({ path: '.env.local' });
dotenv.config();

const APPLY = process.argv.includes('--apply');
const LOCKED_EXEMPTION = process.argv.includes('--delete-while-locked-proven-no-op');
const TABLE = 'payment_catalog_pay_structures';
const AUDIT_TABLE = 'audit_log'; // singular — see src/lib/supabase/audit-log.ts:136
const ACTOR = 'kaner@simple.biz';

/** The retired key whose orphaned rate row is being removed. */
const TARGET_KEY = 'hsl:lead_nurture';
const TARGET_BARE = 'lead_nurture';
const PARENT_KEY = 'hogan_smith_law';

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

/** Paged read with no ordering requirement (tables with quoted display columns). */
async function selectPagedRaw<T>(table: string, cols: string): Promise<T[] | null> {
  const out: T[] = [];
  const SIZE = 1000;
  for (let from = 0; ; from += SIZE) {
    const { data, error } = await db.from(table).select(cols).range(from, from + SIZE - 1);
    if (error) {
      console.error(`  NOTE: could not read ${table} (${error.message})`);
      return null;
    }
    const rows = (data ?? []) as T[];
    out.push(...rows);
    if (rows.length < SIZE) break;
  }
  return out;
}

const num = (v: number | string | null) => (v == null ? null : Number(v));
const peso = (v: number | null) =>
  v == null ? '—' : `₱${v.toLocaleString('en-PH', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;

console.log(`\n${APPLY ? '=== APPLY ===' : '=== DRY RUN (pass --apply to delete) ==='}\n`);
console.log(`Target: ${TARGET_KEY} (department scope)\n`);

// ── Guard 1: the key really is RETIRED in the code ───────────────────────────
// The exact inverse of the seed script's key-validity guard. If the app still
// knows this key, people can be placed in it and its base rate is load-bearing.
{
  const mod = await import('../src/lib/departments/hsl-subdept.js').catch((e: unknown) => {
    die(
      `could not import the HSL sub-dept keyspaces from src/lib/departments/hsl-subdept: ${String(e)}. ` +
        'Refusing to delete a rate row I cannot prove is orphaned.',
    );
  });
  const placement = (mod as { HSL_PLACEMENT_ONLY_SUB_KEYS?: readonly string[] }).HSL_PLACEMENT_ONLY_SUB_KEYS;
  if (!placement?.length) die('HSL_PLACEMENT_ONLY_SUB_KEYS imported but empty — refusing to guess.');

  const schema = await import('../src/lib/hsl-bonus/schema.js').catch((e: unknown) => {
    die(`could not import HSL_DEPT_KEYS from src/lib/hsl-bonus/schema: ${String(e)}.`);
  });
  const kpi = (schema as { HSL_DEPT_KEYS?: readonly string[] }).HSL_DEPT_KEYS;
  if (!kpi?.length) die('HSL_DEPT_KEYS imported but empty — refusing to guess.');

  if (placement.includes(TARGET_BARE)) {
    die(
      `"${TARGET_BARE}" is STILL in HSL_PLACEMENT_ONLY_SUB_KEYS (${placement.join(', ')}). ` +
        `That makes it a live, placeable sub-team whose base rate people ride — deleting it would reprice them. ` +
        `Land the code removal first (docs/features/hsl-subdepartments.md §7c), then re-run.`,
    );
  }
  if (kpi.includes(TARGET_BARE)) {
    die(`"${TARGET_BARE}" is in HSL_DEPT_KEYS (${kpi.join(', ')}) — it owns a KPI calculator. Not an orphan.`);
  }
  console.log(
    `Guard 1/5  key is retired .............. "${TARGET_BARE}" is in neither keyspace\n` +
      `           placement-only: ${placement.join(', ')}\n` +
      `           kpi keys:       ${kpi.length} (${kpi.slice(0, 4).join(', ')}…)`,
  );
}

// ── Read the catalog ─────────────────────────────────────────────────────────
const all = await selectAllPaged<PayRow>(TABLE, '*');
const hslFamily = all.filter((r) => /^(hsl|hogan)/i.test((r.department_key ?? '').trim()));
const targetRows = all.filter((r) => (r.department_key ?? '').trim().toLowerCase() === TARGET_KEY);
const deptRows = targetRows.filter((r) => r.scope === 'department');
const employeeScopeHits = targetRows.filter((r) => r.scope === 'employee');
const parent = all.find((r) => r.scope === 'department' && r.department_key === PARENT_KEY);

console.log(`\nHSL-family pay structures on file (${hslFamily.length}), department scope:`);
for (const r of hslFamily.filter((x) => x.scope === 'department')) {
  const mark = (r.department_key ?? '').toLowerCase() === TARGET_KEY ? ' ←– TO DELETE' : '';
  console.log(
    `  ${r.department_key.padEnd(24)} reg ${peso(num(r.regular_rate))}  ot ${peso(num(r.ot_rate))}  ${r.currency}` +
      `  (set by ${r.created_by ?? '?'})${mark}`,
  );
}
console.log(
  parent
    ? `\n  Parent fallback (${PARENT_KEY}): reg ${peso(num(parent.regular_rate))} / ot ${peso(num(parent.ot_rate))} ${parent.currency}`
    : `\n  NOTE: no department-scope ${PARENT_KEY} row — the parent fallback is EMPTY.`,
);

// ── Guard 2: nobody resolves a rate through this key ─────────────────────────
const masterHits = await (async () => {
  const rows = await selectPagedRaw<{ Department: string | null }>('global_master_list', '"Department"');
  if (rows == null) return null;
  return {
    hits: rows.filter((r) => (r.Department ?? '').trim().toLowerCase() === TARGET_KEY).length,
    total: rows.length,
  };
})();

const ratesRowHits = await (async () => {
  // employee_hourly_rates uses QUOTED display-name columns, not snake_case.
  const rows = await selectPagedRaw<Record<string, string | null>>('employee_hourly_rates', '"Work Email", "Department"');
  if (rows == null) return null;
  return { hits: rows.filter((r) => (r.Department ?? '').trim().toLowerCase() === TARGET_KEY).length, total: rows.length };
})();

const rosterHits = await (async () => {
  const { data, error } = await db.from('hsl_team_members').select('email, dept_key').ilike('dept_key', `%${TARGET_BARE}%`);
  if (error) {
    console.error(`  NOTE: could not read hsl_team_members (${error.message})`);
    return null;
  }
  return (data ?? []).length;
})();

const liveGrants = await (async () => {
  // revoked_at IS NULL — revoked rows are tombstones AND the re-grant slot, never
  // live access. Every app reader filters this; a probe that doesn't miscounts.
  const { data, error } = await db
    .from('department_managers')
    .select('manager_email, department, revoked_at')
    .ilike('department', `%${TARGET_BARE}%`);
  if (error) {
    console.error(`  NOTE: could not read department_managers (${error.message})`);
    return null;
  }
  const rows = data ?? [];
  return { live: rows.filter((r) => r.revoked_at == null).length, revoked: rows.filter((r) => r.revoked_at != null).length };
})();

const openTransfers = await (async () => {
  const { data, error } = await db
    .from('department_transfer_requests')
    .select('employee_email, from_department, to_department, status')
    .or(`from_department.ilike.%${TARGET_BARE}%,to_department.ilike.%${TARGET_BARE}%`);
  if (error) {
    console.error(`  NOTE: could not read department_transfer_requests (${error.message})`);
    return null;
  }
  return (data ?? []).length;
})();

const parentReg = parent ? Number(parent.regular_rate) : null;
const parentOt = parent ? num(parent.ot_rate) : null;
const row = deptRows[0];
const figuresMatchParent =
  parent != null && row != null && Number(row.regular_rate) === parentReg && num(row.ot_rate) === parentOt;

const occupancy = [
  { id: 'master-list cells', ok: masterHits?.hits === 0, detail: masterHits ? `${masterHits.hits} (of ${masterHits.total})` : 'UNKNOWN' },
  { id: 'employee_hourly_rates rows', ok: ratesRowHits?.hits === 0, detail: ratesRowHits ? `${ratesRowHits.hits} (of ${ratesRowHits.total})` : 'UNKNOWN' },
  { id: 'employee-scope structures', ok: employeeScopeHits.length === 0, detail: `${employeeScopeHits.length}` },
  { id: 'hsl_team_members rows', ok: rosterHits === 0, detail: `${rosterHits ?? 'UNKNOWN'}` },
  { id: 'LIVE manager grants', ok: liveGrants?.live === 0, detail: liveGrants ? `${liveGrants.live} live / ${liveGrants.revoked} revoked` : 'UNKNOWN' },
  { id: 'transfer requests', ok: openTransfers === 0, detail: `${openTransfers ?? 'UNKNOWN'}` },
];

console.log(`\nGuard 2/5  occupancy — can anyone resolve a rate through ${TARGET_KEY}?`);
for (const o of occupancy) console.log(`  ${o.ok ? '✓' : '✗'} ${o.id.padEnd(28)} ${o.detail}`);
const unoccupied = occupancy.every((o) => o.ok);
if (!unoccupied) {
  die(
    'at least one live reference to this key exists (or could not be proven zero). Deleting its base rate ' +
      'would reprice whoever rides it — that is a rate CHANGE, not an orphan cleanup. Resolve the references first.',
  );
}

// ── Guard 3: exactly one department row, and it equals the parent base ───────
{
  if (deptRows.length === 0) {
    console.log(`\nGuard 3/5  row count ................... 0 — nothing to delete. Already clean.`);
    console.log('\nNo-op: the orphaned rate row is not present.\n');
    process.exit(0);
  }
  if (deptRows.length !== 1) {
    die(
      `expected exactly 1 department-scope row for ${TARGET_KEY}, found ${deptRows.length}. ` +
        `Refusing to bulk-delete — inspect them by hand:\n` +
        deptRows.map((r) => `    id=${r.id} reg=${r.regular_rate} ot=${r.ot_rate} ${r.currency} by=${r.created_by}`).join('\n'),
    );
  }
  if (!figuresMatchParent) {
    die(
      `the row to delete (reg ${peso(num(row.regular_rate))} / ot ${peso(num(row.ot_rate))}) does NOT match the parent ` +
        `${PARENT_KEY} base (reg ${peso(parentReg)} / ot ${peso(parentOt)}). A figure that differs from the parent means ` +
        `somebody set a real rate here deliberately — that is a decision, not an orphan. Needs a human.`,
    );
  }
  console.log(
    `\nGuard 3/5  row count + figures ......... 1 row, reg ${peso(num(row.regular_rate))} / ot ${peso(num(row.ot_rate))} ` +
      `= parent base exactly`,
  );
}

// ── Preconditions P1–P4 for the locked-cycle exemption ──────────────────────
const P = [
  { id: 'P1', ok: masterHits?.hits === 0, label: `master-list cells on the key = ${masterHits?.hits ?? 'UNKNOWN'}` },
  { id: 'P2', ok: ratesRowHits?.hits === 0, label: `employee_hourly_rates rows on the key = ${ratesRowHits?.hits ?? 'UNKNOWN'}` },
  { id: 'P3', ok: employeeScopeHits.length === 0, label: `employee-scope structures on the key = ${employeeScopeHits.length}` },
  { id: 'P4', ok: figuresMatchParent, label: `deleted figures equal the parent fallback (reg ${peso(parentReg)} / ot ${peso(parentOt)})` },
];
console.log('\nPreconditions — could this DELETE move anyone’s resolved rate?');
for (const p of P) console.log(`  ${p.ok ? '✓' : '✗'} ${p.id}  ${p.label}`);
const provenNoOp = P.every((p) => p.ok);
console.log(
  provenNoOp
    ? '  → PROVEN NO-OP: nobody resolves a rate through this key, and the row being\n' +
        '    removed is identical to the parent fallback that would replace it, so no\n' +
        '    resolved rate and no staged amount can move.'
    : '  → NOT a proven no-op. This delete could change someone’s resolved rate.',
);

// ── Guard 4: the payroll processing lock ────────────────────────────────────
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
    console.log('\nGuard 4/5  payroll dispatch lock ....... OPEN (not processing)');
  } else if (!provenNoOp) {
    die(
      `payroll is being processed right now (${who}) and this delete is NOT a proven no-op. ` +
        `The catalog is the rate source of truth — editing it mid-run desyncs staged amounts from the paystubs. ` +
        `Re-run once Payment Dispatch is unlocked.`,
    );
  } else if (!LOCKED_EXEMPTION) {
    die(
      `payroll is being processed right now (${who}).\n` +
        `  P1–P4 all hold, so this particular delete provably cannot move any staged amount.\n` +
        `  If you want it to land during the locked run anyway, re-run with:\n` +
        `      --apply --delete-while-locked-proven-no-op\n` +
        `  Otherwise wait for Payment Dispatch to unlock and re-run with just --apply.`,
    );
  } else {
    console.log(`\nGuard 4/5  payroll dispatch lock ....... LOCKED (${who})`);
    console.log('           EXEMPTION ACTIVE — P1–P4 proved the delete cannot move a staged amount.');
  }
}

// ── Guard 5: backup to disk before writing ──────────────────────────────────
const reportsDir = path.join(process.cwd(), 'reports');
mkdirSync(reportsDir, { recursive: true });
const stamp = new Date().toISOString().replace(/[:.]/g, '-');
const backupPath = path.join(reportsDir, `backup_hsl_pay_structures_${stamp}.json`);
writeFileSync(
  backupPath,
  JSON.stringify(
    {
      takenAt: new Date().toISOString(),
      table: TABLE,
      filter: 'department_key ~ ^(hsl|hogan)',
      aboutToDelete: deptRows,
      rows: hslFamily,
    },
    null,
    2,
  ),
  'utf8',
);
console.log(`Guard 5/5  backup written .............. ${path.relative(process.cwd(), backupPath)} (${hslFamily.length} rows)`);

// ── The plan ────────────────────────────────────────────────────────────────
console.log('\nPlanned DELETE (by primary key, exactly one row):');
console.log(
  `  id=${row.id}  ${row.department_key}  reg ${peso(num(row.regular_rate))} / ot ${peso(num(row.ot_rate))} ${row.currency}` +
    `  seeded by ${row.created_by ?? '?'} at ${row.created_at ?? '?'}`,
);
console.log(
  `\nAfter deletion, ${TARGET_KEY} resolves through the parent ${PARENT_KEY} fallback at ` +
    `reg ${peso(parentReg)} / ot ${peso(parentOt)} — the identical figures. Nobody is placed in the key ` +
    `(${masterHits?.hits ?? '?'} master cells), so nobody's pay changes either way.`,
);
console.log(`The 2026-08-12 seed's audit_log row is NOT touched — that history stays.`);

if (!APPLY) {
  console.log('\nDry run only — nothing written. Re-run with --apply to delete.\n');
  process.exit(0);
}

// ── Apply ───────────────────────────────────────────────────────────────────
console.log('\nDeleting…');
{
  // Delete by PRIMARY KEY, never by a department_key filter: a filter deletes
  // whatever happens to match at execution time, an id deletes the row we proved.
  const { data, error } = await db.from(TABLE).delete().eq('id', row.id).select('*');
  if (error) die(`deleting ${row.id}: ${error.message}`);
  if ((data ?? []).length !== 1) die(`expected to delete exactly 1 row, deleted ${(data ?? []).length}. Check ${backupPath}.`);
  console.log(`  ✓ deleted id=${row.id} (${row.department_key})`);
}

// Audit trail. Mirrors the seed's: a script-driven production rate write should be
// attributable. Non-fatal but reported loudly — the delete is already committed.
{
  const { error } = await db.from(AUDIT_TABLE).insert({
    user_name: ACTOR,
    user_role: 'accounting',
    action: 'payroll.rate.delete',
    resource: TABLE,
    resource_id: row.department_key,
    details: {
      source: 'script:remove-hsl-lead-nurture-rate',
      scope: 'department',
      department_key: row.department_key,
      deleted_row_id: row.id,
      regular_rate: num(row.regular_rate),
      ot_rate: num(row.ot_rate),
      currency: row.currency,
      seeded_at: row.created_at,
      backup: path.relative(process.cwd(), backupPath),
      note:
        'Retired placement-only HSL sub-team (Carla/CJ 2026-08-13: same team as Simple Texting, and it collided ' +
        'with Lucky\'s Lead Nurture team). Orphan rate row removed; 0 people were placed in the key and the ' +
        'figures equalled the parent hogan_smith_law base, so no resolved rate changed.',
    },
  });
  if (error) console.error(`\n  WARNING: row deleted, but the audit row failed: ${error.message}`);
  else console.log(`  ✓ ${AUDIT_TABLE.padEnd(20)} 1 row`);
}

// ── Verify by re-reading ────────────────────────────────────────────────────
{
  const after = await selectAllPaged<PayRow>(TABLE, '*');
  const left = after.filter((r) => (r.department_key ?? '').trim().toLowerCase() === TARGET_KEY);
  const sibling = after.filter((r) => (r.department_key ?? '').trim().toLowerCase() === 'hsl:simple_texting');
  const parentAfter = after.find((r) => r.scope === 'department' && r.department_key === PARENT_KEY);
  console.log('\nVerification (re-read from the DB):');
  console.log(`  ${left.length === 0 ? '✓' : '✗'} ${TARGET_KEY}: ${left.length} row(s) remaining (want 0)`);
  console.log(
    `  ${sibling.length === 1 ? '✓' : '✗'} hsl:simple_texting SURVIVES: ${sibling.length} row(s)` +
      (sibling[0] ? ` reg ${peso(num(sibling[0].regular_rate))} / ot ${peso(num(sibling[0].ot_rate))}` : ''),
  );
  console.log(
    `  ${parentAfter ? '✓' : '✗'} parent ${PARENT_KEY} intact` +
      (parentAfter ? `: reg ${peso(num(parentAfter.regular_rate))} / ot ${peso(num(parentAfter.ot_rate))}` : ''),
  );
  const ok = left.length === 0 && sibling.length === 1 && !!parentAfter;
  console.log(ok ? '\nDone — orphan removed, Simple Texting and the parent untouched.\n' : '\nFAILED verification — inspect above.\n');
  process.exit(ok ? 0 : 1);
}
