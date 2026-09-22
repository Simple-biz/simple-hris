/**
 * READ-ONLY. Is anybody scored a KPI bonus in TWO departments for the SAME week?
 *
 * WHY THIS EXISTS (Kane, 2026-09-22: karens@simple.biz "should be 1200 but it
 * comes out to 1450"). Karen Tricia Salvador transferred Lead Gen -> HSL Filing
 * Specialist. Her HSL card scores her on her WORK email
 * (`hsl_bonus_entries.employee_email` = karens@simple.biz, PHP 1,200); the Lead
 * Gen QC first pass scores her on her PERSONAL email
 * (`qc_kpi_submissions.employee_email` = ktriciava@gmail.com, PHP 250). The two
 * stores share no key, so NOTHING in the HRIS could see they are one person, and
 * any surface that reads both reports PHP 1,450.
 *
 * The two stores are keyed differently ON PURPOSE (the 2026-07-21 HSL re-key set
 * HSL to work email; the catalog side carries whatever the roster held), so the
 * fix is not to re-key either one — it is to FOLD IDENTITY and look. Identity is
 * folded across all four master-list address columns, because a department
 * transfer INSERTS a master row and orphans the first
 * (`gml-transfer-orphan-rows.md`), so one person routinely holds several rows.
 *
 * Reports every collision across the three scoring stores:
 *   hsl_bonus_entries . bonus_catalog_applied . qc_kpi_submissions
 *
 * A collision is NOT automatically an error — somebody can legitimately be paid
 * by two programmes in one week. It is a thing a human must rule on, which is
 * exactly why it must be visible. Rows worth PHP 0 are counted apart: they are a
 * roster question, not money.
 *
 * Usage:
 *   $env:TSX_TSCONFIG_PATH="tsconfig.readiness-verify.json"
 *   node --import tsx scripts/audit-cross-dept-double-scoring.mts [--week YYYY-MM-DD] [--all-weeks]
 */
import dotenv from 'dotenv';
dotenv.config({ path: '.env.local' });
dotenv.config();

const { createSupabaseServiceRoleClient } = await import('../src/lib/supabase/server');
const sb = createSupabaseServiceRoleClient();
if (!sb) {
  console.error('Supabase is not configured (.env.local)');
  process.exit(1);
}

const argv = process.argv.slice(2);
const argOf = (f: string) => {
  const i = argv.indexOf(f);
  return i >= 0 ? argv[i + 1] : undefined;
};
const onlyWeek = argOf('--week');
const allWeeks = argv.includes('--all-weeks');

/** PostgREST truncates at 1000 rows even with .range() — always page. */
async function pageAll<T>(table: string, select: string, build: (q: any) => any): Promise<T[]> {
  const out: T[] = [];
  for (let from = 0; ; from += 1000) {
    const { data, error } = await build(sb!.from(table).select(select)).range(from, from + 999);
    if (error) throw new Error(`${table}: ${error.message}`);
    const rows = (data ?? []) as T[];
    out.push(...rows);
    if (rows.length < 1000) break;
  }
  return out;
}

const peso = (n: number) => `PHP ${Math.round(n).toLocaleString('en-PH')}`;
const norm = (s: unknown) => String(s ?? '').trim().toLowerCase();

// ---- Identity folding -------------------------------------------------------
// All four address columns, across EVERY master row, folded into one id per
// person. A transfer orphan means the same human owns several rows.
const ADDRESS_COLS = [
  'Work Email',
  'Personal Email',
  'Alternate Work Email',
  'Alternate Work Email 2',
];

const gml = await pageAll<Record<string, unknown>>('global_master_list', '*', (q) => q);

/** union-find over email addresses */
const parent = new Map<string, string>();
const find = (x: string): string => {
  if (!parent.has(x)) {
    parent.set(x, x);
    return x;
  }
  let r = x;
  while (parent.get(r) !== r) r = parent.get(r)!;
  let c = x;
  while (parent.get(c) !== c) {
    const n = parent.get(c)!;
    parent.set(c, r);
    c = n;
  }
  return r;
};
const union = (a: string, b: string) => {
  const ra = find(a);
  const rb = find(b);
  if (ra !== rb) parent.set(ra, rb);
};

const nameOf = new Map<string, string>();
for (const r of gml) {
  const addrs = ADDRESS_COLS.map((c) => norm(r[c])).filter(Boolean);
  if (!addrs.length) continue;
  for (const a of addrs) find(a);
  for (let i = 1; i < addrs.length; i += 1) union(addrs[0], addrs[i]);
  const nm = String(r.Name ?? '').trim();
  if (nm) for (const a of addrs) if (!nameOf.has(a)) nameOf.set(a, nm);
}
const idOf = (email: string) => {
  const e = norm(email);
  return e ? find(e) : '';
};

// ---- Load the three scoring stores -----------------------------------------
type Score = { store: string; dept: string; week: string; email: string; amount: number };
const scores: Score[] = [];
const weekFilter = (q: any) => (onlyWeek ? q.eq('period_start', onlyWeek) : q);

for (const h of await pageAll<Record<string, unknown>>(
  'hsl_bonus_entries',
  'department,period_start,employee_email,calculated_bonus',
  weekFilter,
)) {
  scores.push({
    store: 'hsl_bonus_entries',
    dept: String(h.department),
    week: String(h.period_start),
    email: norm(h.employee_email),
    amount: Number(h.calculated_bonus ?? 0) || 0,
  });
}

for (const a of await pageAll<Record<string, unknown>>(
  'bonus_catalog_applied',
  'department,period_start,employee_email,amount',
  weekFilter,
)) {
  scores.push({
    store: 'bonus_catalog_applied',
    dept: String(a.department),
    week: String(a.period_start),
    email: norm(a.employee_email),
    amount: Number(a.amount ?? 0) || 0,
  });
}

for (const q of await pageAll<Record<string, unknown>>(
  'qc_kpi_submissions',
  'department,period_start,employee_email,amount',
  weekFilter,
)) {
  scores.push({
    store: 'qc_kpi_submissions',
    dept: String(q.department),
    week: String(q.period_start),
    email: norm(q.employee_email),
    amount: Number(q.amount ?? 0) || 0,
  });
}

// ---- Fold to (person, week) -> departments ---------------------------------
type Cell = { dept: string; store: string; amount: number; email: string };
const byPersonWeek = new Map<string, Cell[]>();
for (const s of scores) {
  if (!s.email) continue;
  const k = `${idOf(s.email)}::${s.week}`;
  const list = byPersonWeek.get(k) ?? [];
  list.push({ dept: s.dept, store: s.store, amount: s.amount, email: s.email });
  byPersonWeek.set(k, list);
}

type Hit = { person: string; week: string; cells: Cell[]; paying: number; total: number };
const moneyHits: Hit[] = [];
const zeroHits: Hit[] = [];

for (const [k, cells] of byPersonWeek) {
  const sep = k.lastIndexOf('::');
  const pid = k.slice(0, sep);
  const week = k.slice(sep + 2);
  // Collapse per department. Several applied rows in one department is normal
  // and they sum. But `qc_kpi_submissions` is the FIRST PASS that becomes the
  // `bonus_catalog_applied` row — the same money in two stores, not two awards
  // — so a department that has both counts the applied figure only. Summing the
  // stores would invent a duplicate in every department that has been applied.
  const perDeptStore = new Map<string, number>();
  for (const c of cells) {
    const k = `${c.dept}|${c.store}`;
    perDeptStore.set(k, (perDeptStore.get(k) ?? 0) + c.amount);
  }
  const perDept = new Map<string, number>();
  for (const [k, v] of perDeptStore) {
    const dept = k.slice(0, k.lastIndexOf('|'));
    const store = k.slice(k.lastIndexOf('|') + 1);
    if (store === 'qc_kpi_submissions' && perDeptStore.has(`${dept}|bonus_catalog_applied`)) continue;
    perDept.set(dept, (perDept.get(dept) ?? 0) + v);
  }
  if (perDept.size < 2) continue;
  const paying = [...perDept.values()].filter((v) => v > 0).length;
  const total = [...perDept.values()].reduce((s, v) => s + v, 0);
  const hit: Hit = { person: nameOf.get(pid) ?? pid, week, cells, paying, total };
  (paying >= 2 ? moneyHits : zeroHits).push(hit);
}

const weeksSeen = new Set(scores.map((s) => s.week)).size;
console.log(`Folded ${gml.length} master rows and ${scores.length} score rows over ${weeksSeen} weeks`);
console.log(`  scored in >1 department in a week, MORE THAN ONE PAYING : ${moneyHits.length}`);
console.log(`  same but only one department actually pays (roster noise): ${zeroHits.length}`);

if (moneyHits.length) {
  console.log('\n=== TWO OR MORE PAYING DEPARTMENTS IN ONE WEEK — a human must rule on each ===');
  moneyHits.sort((a, b) => b.week.localeCompare(a.week) || b.total - a.total);
  const show = allWeeks ? moneyHits : moneyHits.slice(0, 60);
  for (const h of show) {
    console.log(`\n  ${h.week}  ${h.person}   combined ${peso(h.total)}`);
    const seen = new Set<string>();
    for (const c of h.cells) {
      const key = `${c.dept}|${c.store}|${c.email}`;
      if (seen.has(key)) continue;
      seen.add(key);
      const sum = h.cells
        .filter((x) => x.dept === c.dept && x.store === c.store && x.email === c.email)
        .reduce((s, x) => s + x.amount, 0);
      console.log(
        `      ${c.dept.padEnd(22)} ${peso(sum).padStart(14)}  via ${c.store.padEnd(22)} as ${c.email}`,
      );
    }
  }
  if (!allWeeks && moneyHits.length > show.length) {
    console.log(`\n  ... ${moneyHits.length - show.length} more (pass --all-weeks)`);
  }
}

process.exit(moneyHits.length ? 1 : 0);
