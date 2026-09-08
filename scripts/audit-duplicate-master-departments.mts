/**
 * READ-ONLY audit: active people carrying MORE THAN ONE `global_master_list`
 * row with different departments.
 *
 * Why it matters (2026-09-08): the wizard resolves one department per person,
 * and PAB grades HSL and non-HSL by different attendance rules — non-HSL must
 * clear every Mon–Fri at >=7h, HSL needs 5 of 7 Mon–Sun days with weekends
 * droppable. `pickMasterRowForWorkEmail` now gives HSL the win so the verdict
 * cannot flip between loads, but that is a TIE-BREAK, not the truth: the
 * duplicate rows are invalid data and only HR can say which department is real.
 * This file is the worklist for fixing them.
 *
 * Writes nothing. Ever. Deduping is a separate script behind an --apply gate.
 *
 *   npx tsx scripts/audit-duplicate-master-departments.mts [--csv <path>]
 */
import { createClient } from '@supabase/supabase-js';
import fs from 'node:fs';


const url = process.env.NEXT_PUBLIC_SUPABASE_URL ?? readEnv('NEXT_PUBLIC_SUPABASE_URL');
const key = process.env.SUPABASE_SERVICE_ROLE_KEY ?? readEnv('SUPABASE_SERVICE_ROLE_KEY');

function readEnv(name: string): string {
  const raw = fs.readFileSync('.env.local', 'utf8');
  for (const line of raw.split(/\r?\n/)) {
    if (!line || line.startsWith('#') || !line.includes('=')) continue;
    const i = line.indexOf('=');
    if (line.slice(0, i).trim() === name) return line.slice(i + 1).trim().replace(/^["']|["']$/g, '');
  }
  throw new Error(`${name} not found in .env.local`);
}

// The app's own predicate, not a second copy of the rule: a bare "HSL" label
// normalises to hogan_smith_law and a regex mirror here missed it (zeussb@).
// Loaded dynamically because a named import of a .ts module from a .mts entry
// does not resolve under tsx's ESM loader.
const { isHslFamilyLabel } = (await import('../src/lib/departments/hsl-subdept')) as {
  isHslFamilyLabel: (raw: string | null | undefined) => boolean;
};
const isHsl = (d: string) => isHslFamilyLabel(d);

const sb = createClient(url, key, { auth: { persistSession: false } });

type Row = Record<string, unknown>;

// PostgREST truncates at 1000 rows even with .range() — always page.
async function selectAllPaged(): Promise<Row[]> {
  const out: Row[] = [];
  for (let from = 0; ; from += 1000) {
    const { data, error } = await sb
      .from('global_master_list')
      .select('"Work Email","Name","Department","Employement Status",off_boarded_at,employee_id,created_at')
      .range(from, from + 999);
    if (error) throw new Error(error.message);
    out.push(...(data ?? []));
    if (!data || data.length < 1000) return out;
  }
}

const rows = await selectAllPaged();
const active = rows.filter(
  (r) => !r.off_boarded_at && String(r['Employement Status'] ?? '').toLowerCase() === 'active',
);

const byEmail = new Map<string, Row[]>();
for (const r of active) {
  const e = String(r['Work Email'] ?? '').trim().toLowerCase();
  if (!e) continue;
  byEmail.set(e, [...(byEmail.get(e) ?? []), r]);
}

const dupes = [...byEmail.entries()]
  .map(([email, rs]) => {
    const depts = [...new Set(rs.map((r) => String(r['Department'] ?? '(null)').trim()))];
    return { email, name: String(rs[0]['Name'] ?? ''), rows: rs.length, depts };
  })
  .filter((d) => d.depts.length > 1)
  .sort((a, b) => a.email.localeCompare(b.email));

const straddling = dupes.filter((d) => d.depts.some(isHsl) && d.depts.some((x) => !isHsl(x)));

console.log(`master rows: ${rows.length}  ·  active: ${active.length}`);
console.log(`active people with >1 distinct department: ${dupes.length}`);
console.log(`  ...straddling HSL and non-HSL (PAB rule differs, tie-break applied): ${straddling.length}`);
console.log(`  ...other duplicates (same PAB rule, still bad data): ${dupes.length - straddling.length}\n`);

console.log('PAB-AFFECTING — HSL wins the tie-break; confirm the real department:');
for (const d of straddling) {
  console.log(`  ${d.email.padEnd(34)} ${d.depts.join('  |  ')}   (${d.name})`);
}

const csvArg = process.argv.indexOf('--csv');
if (csvArg !== -1 && process.argv[csvArg + 1]) {
  const path = process.argv[csvArg + 1];
  const esc = (v: string) => `"${v.replace(/"/g, '""')}"`;
  const lines = ['work_email,name,row_count,departments,pab_rule_differs'];
  for (const d of dupes) {
    lines.push(
      [
        esc(d.email),
        esc(d.name),
        String(d.rows),
        esc(d.depts.join(' | ')),
        straddling.includes(d) ? 'YES' : 'no',
      ].join(','),
    );
  }
  fs.writeFileSync(path, lines.join('\n'), 'utf8');
  console.log(`\nwrote ${dupes.length} rows to ${path}`);
}
