/**
 * READ-ONLY audit (with an opt-in repair) for KPI Calculator data that has drifted
 * off the keys the app reads back — the "a manager saved values and nobody else can
 * see them" class of bug.
 *
 * Every KPI row is addressed by (department, period_start). The calculators read
 * exactly one such pair, so a row written under any other pair is invisible
 * forever: to the other managers, to Payroll Readiness, and to payroll itself.
 * Two ways that happens:
 *
 *   1. DEPARTMENT-KEY DRIFT — a dept key was renamed in the schema and the rows
 *      stayed behind. Live example: `case_manager` -> `case_managers`.
 *
 *   2. PERIOD-KEY DRIFT — both calculators seed the week from a MONDAY-anchored
 *      local clock (`isoWeekStart(new Date())`) and only correct it once
 *      /api/hubstaff-hours?source_files=1 answers; the catch is
 *      "keep today's week on any error". Stored weeks are the Hubstaff filename's
 *      SUNDAY start, so a session that fetch fails in silently reads and writes a
 *      week key nothing else uses.
 *
 * Both cadences key on the SAME upload Sunday (2026-08-04 fix — monthly HSL
 * depts used to key on the 1st of the month, which Payroll Readiness never
 * reads; that's a THIRD way period-key drift happened, and is why Collections /
 * Healthcare Team Lead / SSD Medical Records could be marked ready forever and
 * never clear in Readiness. See HslBonusCalculator.tsx `periodStart`.
 *
 * SAFE BY DEFAULT — dry-run prints what it would do and changes nothing.
 *   npx tsx scripts/audit-kpi-key-drift.mts             # audit only
 *   npx tsx scripts/audit-kpi-key-drift.mts --apply     # rename drifted DEPT keys
 *
 * `--apply` covers department-key drift ONLY, and only where the target
 * (department, period_start) has no rows of its own — a collision needs a human to
 * decide which set is right. Period-key drift is always report-only: picking the
 * week someone meant is a judgement call, so the suggested target is printed for
 * you to act on. Every affected row is written to references/backups/ first
 * (gitignored).
 *
 * Needs the server-only stub tsconfig to import the shipped schema:
 *   $env:TSX_TSCONFIG_PATH="tsconfig.readiness-verify.json"
 */
import { createClient } from '@supabase/supabase-js';
import dotenv from 'dotenv';
import { writeFileSync, mkdirSync } from 'node:fs';

dotenv.config({ path: '.env.local' });
dotenv.config();

const APPLY = process.argv.includes('--apply');

const { HSL_DEPTS, HSL_DEPT_KEYS } = await import('../src/lib/hsl-bonus/schema');
const { DEPARTMENTS, MANAGER_BONUS_DEPT_KEYS } = await import('../src/lib/payroll/department-bonus');
const { parseDateRangeFromFilename } = await import('../src/lib/hubstaff/calendar-column-dedupe');
const { slugifyDeptKey, DEPARTMENTS_REGISTRY_SETTING_KEY } = await import(
  '../src/lib/departments/registry'
);
const { normalizeDeptToKey } = await import('../src/lib/payroll/normalize-dept-key');

const url = process.env.NEXT_PUBLIC_SUPABASE_URL?.trim();
const key = process.env.SUPABASE_SERVICE_ROLE_KEY?.trim();
if (!url || !key) {
  console.error('Missing NEXT_PUBLIC_SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY');
  process.exit(1);
}
const sb = createClient(url, key, { auth: { persistSession: false, autoRefreshToken: false } });

/** PostgREST caps a single response at 1000 rows — page or silently miss drift. */
async function readAll(table: string): Promise<Record<string, unknown>[]> {
  const PAGE = 1000;
  const out: Record<string, unknown>[] = [];
  let from = 0;
  for (;;) {
    const { data, error } = await sb.from(table).select('*').range(from, from + PAGE - 1);
    if (error) throw new Error(`${table}: ${error.message}`);
    const page = (data ?? []) as Record<string, unknown>[];
    out.push(...page);
    if (page.length < PAGE) break;
    from += PAGE;
  }
  return out;
}

// ── The keys the app can actually read back ──────────────────────────────────

/** In-app (Payment Catalog -> Department) departments live in an app_settings
 *  registry, so their keys are only knowable from the DB. */
async function registrySlugs(): Promise<Set<string>> {
  const out = new Set<string>();
  const { data } = await sb
    .from('app_settings')
    .select('value')
    .eq('key', DEPARTMENTS_REGISTRY_SETTING_KEY)
    .maybeSingle();
  const raw = (data as { value?: unknown } | null)?.value;
  if (!raw) return out;
  try {
    const parsed = JSON.parse(typeof raw === 'string' ? raw : JSON.stringify(raw)) as unknown;
    for (const e of Array.isArray(parsed) ? parsed : []) {
      const entry = e as { key?: string; name?: string };
      const k = entry.key ?? (entry.name ? slugifyDeptKey(entry.name) : null);
      if (k) out.add(k);
    }
  } catch {
    /* a malformed registry just means fewer known keys — reported as unknown */
  }
  return out;
}

/**
 * Departments that exist only as a master-list LABEL. The calculators derive a key
 * for those on the fly (`normalizeDeptToKey(label) ?? slugifyDeptKey(label)`) and
 * render the card when a manager's grant covers it — "US Manager Bonus" ->
 * `us_manager_bonus` is one. They're in no static list, so without this the audit
 * would report a live, in-use department as retired.
 */
async function rosterSlugs(): Promise<Set<string>> {
  const out = new Set<string>();
  for (const r of await readAll('global_master_list')) {
    const label = String(r['Department'] ?? '').trim();
    if (!label) continue;
    const norm = normalizeDeptToKey(label);
    if (norm) out.add(norm);
    const slug = slugifyDeptKey(label);
    if (slug) out.add(slug);
  }
  return out;
}

/** Departments the Payment Catalog assigns bonuses to. `us_manager_bonus` exists
 *  ONLY here — no schema entry, no roster label — and is actively being applied,
 *  so catalog assignments are a first-class source of live keys. */
async function catalogAssignmentKeys(): Promise<Set<string>> {
  const out = new Set<string>();
  try {
    for (const r of await readAll('bonus_catalog_assignments')) {
      const k = String(r['department_key'] ?? '').trim();
      if (k) out.add(k);
    }
  } catch {
    /* table missing on an older deployment — the other sources still apply */
  }
  return out;
}

const liveKeys = new Set<string>([
  ...HSL_DEPT_KEYS,
  ...MANAGER_BONUS_DEPT_KEYS,
  ...DEPARTMENTS.map((d) => d.key),
  ...(await registrySlugs()),
  ...(await rosterSlugs()),
  ...(await catalogAssignmentKeys()),
]);

/** Monthly cadence is a per-dept property; unknown depts are assumed weekly
 *  (the common case) and flagged by the dept-key audit anyway. */
const monthlyKeys = new Set<string>(
  HSL_DEPT_KEYS.filter((k) => HSL_DEPTS[k].cadence === 'monthly'),
);

/** Best single live key for a retired one: same slug ignoring a trailing plural
 *  's' and any underscores. Only returned when exactly ONE live key matches, so a
 *  guess can never rename rows onto the wrong department. */
function suggestDeptKey(stale: string): string | null {
  const fold = (s: string) => s.toLowerCase().replace(/_/g, '').replace(/s$/, '');
  const want = fold(stale);
  const hits = [...liveKeys].filter((k) => fold(k) === want);
  return hits.length === 1 ? hits[0]! : null;
}

// ── The period keys the app can actually read back ───────────────────────────

const uploads = await readAll('hubstaff_uploads');
const weekKeys = new Set<string>();
for (const u of uploads) {
  const f = String(u['source_file'] ?? '').trim();
  if (!f) continue;
  const range = parseDateRangeFromFilename(f);
  const d = range?.start;
  if (d && !Number.isNaN(d.getTime())) {
    weekKeys.add(
      `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`,
    );
  }
}

const DOW = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
function dayName(iso: string): string {
  const [y, m, d] = iso.split('-').map(Number);
  if (!y || !m || !d) return '??';
  return DOW[new Date(y, m - 1, d).getDay()]!;
}

/** The upload week whose Sun–Sat range CONTAINS a stray key — what the person was
 *  almost certainly looking at when their session guessed the week. */
function containingWeek(iso: string): string | null {
  for (const w of weekKeys) {
    const [wy, wm, wd] = w.split('-').map(Number);
    const start = new Date(wy!, wm! - 1, wd!);
    const end = new Date(wy!, wm! - 1, wd! + 6);
    const [y, m, d] = iso.split('-').map(Number);
    const t = new Date(y!, m! - 1, d!);
    if (t >= start && t <= end) return w;
  }
  return null;
}

// ── Audit ────────────────────────────────────────────────────────────────────

interface TableSpec {
  table: string;
  actor: string | null;
  amount: string | null;
}
const TABLES: TableSpec[] = [
  { table: 'hsl_bonus_entries', actor: 'created_by', amount: 'calculated_bonus' },
  { table: 'bonus_catalog_applied', actor: 'applied_by', amount: 'amount' },
  { table: 'hsl_bonus_period_status', actor: 'locked_by', amount: null },
];

interface Group {
  ids: string[];
  people: Set<string>;
  actors: Set<string>;
  total: number;
}
const peso = (n: number) => `₱${Math.round(n).toLocaleString()}`;

const deptPlan: {
  table: string;
  dept: string;
  target: string;
  periodStart: string;
  ids: string[];
  total: number;
  collision: boolean;
}[] = [];
const backup: Record<string, Record<string, unknown>[]> = {};
let weekDriftCount = 0;

for (const spec of TABLES) {
  const rows = await readAll(spec.table);
  const byKey = new Map<string, Group>();
  const present = new Set<string>(); // "dept|period" pairs that exist at all
  for (const r of rows) {
    present.add(`${String(r['department'] ?? '')}|${String(r['period_start'] ?? '')}`);
  }
  for (const r of rows) {
    const dept = String(r['department'] ?? '');
    const ps = String(r['period_start'] ?? '');
    const k = `${dept}|${ps}`;
    const g = byKey.get(k) ?? { ids: [], people: new Set(), actors: new Set(), total: 0 };
    if (r['id'] != null) g.ids.push(String(r['id']));
    g.people.add(String(r['employee_email'] ?? '').toLowerCase());
    if (spec.actor && r[spec.actor]) g.actors.add(String(r[spec.actor]));
    if (spec.amount) g.total += Number(r[spec.amount] ?? 0);
    byKey.set(k, g);
    if (!liveKeys.has(dept) || !isPeriodReadable(dept, ps)) {
      (backup[spec.table] ??= []).push(r);
    }
  }

  console.log(`\n===== ${spec.table} — ${rows.length} rows, ${byKey.size} dept-weeks`);

  // 1. Department-key drift
  const staleDepts = [...new Set([...byKey.keys()].map((k) => k.split('|')[0]!))].filter(
    (d) => d && !liveKeys.has(d),
  );
  if (staleDepts.length === 0) {
    console.log('  dept keys: all live ✓');
  } else {
    for (const dept of staleDepts.sort()) {
      const target = suggestDeptKey(dept);
      console.log(`  RETIRED DEPT KEY "${dept}" -> ${target ? `"${target}"` : 'NO SINGLE MATCH (decide by hand)'}`);
      for (const [k, g] of [...byKey].filter(([k]) => k.startsWith(`${dept}|`)).sort()) {
        const ps = k.split('|')[1]!;
        const collision = !!target && present.has(`${target}|${ps}`);
        console.log(
          `      ${ps}  rows=${g.ids.length} people=${g.people.size}` +
            (spec.amount ? ` total=${peso(g.total)}` : '') +
            ` by=${[...g.actors].join(',') || '-'}` +
            (collision ? '   ⚠ TARGET ALREADY HAS THIS WEEK — skipped' : ''),
        );
        if (target && g.ids.length > 0) {
          deptPlan.push({
            table: spec.table,
            dept,
            target,
            periodStart: ps,
            ids: g.ids,
            total: g.total,
            collision,
          });
        }
      }
    }
  }

  // 2. Period-key drift (report-only)
  const strays = [...byKey.keys()].filter((k) => {
    const [dept, ps] = k.split('|') as [string, string];
    return !isPeriodReadable(dept, ps);
  });
  if (strays.length === 0) {
    console.log('  period keys: all readable ✓');
  } else {
    console.log(`  UNREADABLE PERIOD KEYS (${strays.length}) — report only:`);
    for (const k of strays.sort()) {
      const [dept, ps] = k.split('|') as [string, string];
      const g = byKey.get(k)!;
      const cadence = monthlyKeys.has(dept) ? 'monthly' : 'weekly';
      const suggest = containingWeek(ps);
      weekDriftCount += g.ids.length;
      console.log(
        `      ${dept} @ ${ps} (${dayName(ps)}, ${cadence})  rows=${g.ids.length} people=${g.people.size}` +
          (spec.amount ? ` total=${peso(g.total)}` : '') +
          ` by=${[...g.actors].join(',') || '-'}` +
          `  looks like -> ${suggest ?? 'no matching upload week'}`,
      );
    }
  }
}

/** A period key is readable iff the calculator (and Payroll Readiness) would
 *  ever ask for it — the upload filename's Sunday, same for both cadences
 *  since the 2026-08-04 fix. A bare month-first key ("YYYY-MM-01") is still
 *  tolerated so the pre-fix orphans this audit already knows about (see
 *  `references/backups/hsl-monthly-period-key-fix-*.json`) don't re-flag on
 *  every run; a NEW month-first row would mean the bug regressed. */
function isPeriodReadable(dept: string, periodStart: string): boolean {
  if (!periodStart) return false;
  return weekKeys.has(periodStart) || /^\d{4}-\d{2}-01$/.test(periodStart);
}

// ── Summary / apply ──────────────────────────────────────────────────────────

const renameable = deptPlan.filter((p) => !p.collision);
const blocked = deptPlan.filter((p) => p.collision);
const rows = renameable.reduce((n, p) => n + p.ids.length, 0);
const money = renameable.reduce((n, p) => n + p.total, 0);

console.log('\n===== SUMMARY');
console.log(`  dept-key drift : ${rows} rows renameable (${peso(money)}), ${blocked.length} dept-weeks blocked by a collision`);
console.log(`  period drift   : ${weekDriftCount} rows on a week key nothing reads (report only)`);

if (!APPLY) {
  console.log('\nDRY RUN — nothing written. Re-run with --apply to rename the dept keys above.');
  process.exit(0);
}

if (renameable.length === 0) {
  console.log('\nNothing to apply.');
  process.exit(0);
}

mkdirSync('references/backups', { recursive: true });
const stamp = new Date().toISOString().replace(/[:.]/g, '-');
const backupPath = `references/backups/kpi-key-drift-${stamp}.json`;
writeFileSync(backupPath, JSON.stringify({ plan: deptPlan, rows: backup }, null, 2), 'utf8');
console.log(`\nBackup written: ${backupPath}`);

for (const p of renameable) {
  // Rename by primary key, never by (department, period_start) — a concurrent
  // save must not get swept into this batch.
  const { error } = await sb.from(p.table).update({ department: p.target }).in('id', p.ids);
  if (error) {
    console.log(`  FAILED ${p.table} ${p.dept}@${p.periodStart}: ${error.message}`);
    continue;
  }
  console.log(`  renamed ${p.table} ${p.dept}@${p.periodStart} -> ${p.target} (${p.ids.length} rows)`);
}
console.log('\nDone. Re-run without --apply to confirm the drift is gone.');
