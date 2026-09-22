/**
 * READ-ONLY probe — who would carry the Step 2 "First paycheck" label on a week?
 *
 *   npx tsx scripts/probe-first-paycheck-cohort.mts                  # the is_current upload
 *   npx tsx scripts/probe-first-paycheck-cohort.mts <source_file>    # any upload
 *
 * Rebuilds the same index the wizard reads (`first-paycheck.ts` rules, applied
 * to `hubstaff_hours` `Email` × `source_file`, paged past the 1000-row cap) and
 * intersects it with the week's rows, the master list (for aliases + start
 * dates) and the off-board stamps, so the label's cohort can be measured
 * before anyone trusts it. Writes nothing.
 */
import { createClient } from '@supabase/supabase-js';
import dotenv from 'dotenv';
// Default import + destructure: the project's src is compiled CJS under tsx, so a
// named ESM import fails the export lexer (same pattern as audit-orphanage-pay-divergence).
import firstPaycheckModule from '../src/lib/payroll/first-paycheck';
const { buildFirstHoursIndex, classifyFirstPaycheck, weekKeyFromUploadName } = firstPaycheckModule;

dotenv.config({ path: '.env.local' });
dotenv.config();

const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
if (!url || !key) throw new Error('NEXT_PUBLIC_SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY missing');
const sb = createClient(url, key, { auth: { persistSession: false } });

const norm = (s: unknown): string | null => {
  const t = String(s ?? '').trim().toLowerCase();
  return t || null;
};

async function paged<T>(build: (from: number, to: number) => PromiseLike<{ data: T[] | null; error: { message: string } | null }>): Promise<T[]> {
  const out: T[] = [];
  for (let from = 0; ; from += 1000) {
    const { data, error } = await build(from, from + 999);
    if (error) throw new Error(error.message);
    out.push(...(data ?? []));
    if (!data || data.length < 1000) break;
  }
  return out;
}

const argFile = process.argv[2]?.trim() || null;

const { data: uploads, error: upErr } = await sb
  .from('hubstaff_uploads')
  .select('source_file,is_current,uploaded_at')
  .order('uploaded_at', { ascending: false });
if (upErr) throw new Error(upErr.message);
const weekFile = argFile ?? uploads?.find((u) => u.is_current)?.source_file ?? uploads?.[0]?.source_file ?? null;
if (!weekFile) throw new Error('No Hubstaff upload found');
const weekStart = weekKeyFromUploadName(weekFile);
if (!weekStart) throw new Error(`Cannot parse a week from "${weekFile}"`);

type HRow = { Email: string | null; Member: string | null; source_file: string | null; 'Total worked': string | null };
const all = await paged<HRow>((from, to) =>
  sb.from('hubstaff_hours').select('"Email","Member",source_file,"Total worked"').not('source_file', 'is', null).order('id', { ascending: true }).range(from, to),
);
const index = buildFirstHoursIndex(all.map((r) => ({ email: r.Email, weekKey: weekKeyFromUploadName(r.source_file) })));
// Same read filter the wizard applies (`rowsToPayrollRows`): orphanage interns
// (`@pathway.ph`) are never payroll rows, so they never get a Step 2 calc row.
const weekRowsRaw = all.filter((r) => (r.source_file ?? '').trim() === weekFile);
const weekRows = weekRowsRaw.filter((r) => !(norm(r.Email) ?? '').endsWith('@pathway.ph'));
const internRowsDropped = weekRowsRaw.length - weekRows.length;

type GRow = {
  'Work Email': string | null; 'Personal Email': string | null; 'Alternate Work Email': string | null;
  'Alternate Work Email 2': string | null; 'Start Date': string | null; off_boarded_at: string | null; Department: string | null;
};
const gml = await paged<GRow>((from, to) =>
  sb.from('global_master_list').select('"Work Email","Personal Email","Alternate Work Email","Alternate Work Email 2","Start Date",off_boarded_at,"Department"').order('id', { ascending: true }).range(from, to),
);
const aliases = new Map<string, string[]>();
const startDate = new Map<string, string | null>();
const offAt = new Map<string, string | null>();
const dept = new Map<string, string | null>();
for (const g of gml) {
  const list = [g['Work Email'], g['Personal Email'], g['Alternate Work Email'], g['Alternate Work Email 2']].map(norm).filter((x): x is string => !!x);
  for (const a of list) {
    if (!aliases.has(a)) aliases.set(a, list);
    if (!startDate.has(a)) startDate.set(a, g['Start Date']);
    if (!dept.has(a)) dept.set(a, g.Department);
    // Any stamped row for the alias counts — a leaver's live row is the stamped one.
    if (g.off_boarded_at && !offAt.get(a)) offAt.set(a, g.off_boarded_at);
  }
}

const seen = new Set<string>();
const verdicts: Array<{ email: string; name: string; hours: string; kind: string; alsoLeaving: boolean; start: string | null; dept: string | null; offAt: string | null }> = [];
for (const r of weekRows) {
  const em = norm(r.Email);
  if (!em || seen.has(em)) continue;
  seen.add(em);
  const off = offAt.get(em) ?? null;
  const v = classifyFirstPaycheck({
    weekStart,
    aliases: [em, ...(aliases.get(em) ?? [])],
    index,
    alsoLeaving: !!off,
    startDate: startDate.get(em) ?? null,
  });
  verdicts.push({
    email: em, name: r.Member ?? '', hours: r['Total worked'] ?? '', kind: v.kind,
    alsoLeaving: v.kind === 'first' ? v.alsoLeaving : false,
    start: startDate.get(em) ?? null, dept: dept.get(em) ?? null, offAt: off,
  });
}

const by = (k: string) => verdicts.filter((v) => v.kind === k);
console.log(`week file      : ${weekFile}`);
console.log(`week start     : ${weekStart}`);
console.log(`uploads on rec : ${uploads?.length ?? 0}   hubstaff rows: ${all.length}   index emails: ${index.firstWeekByEmail.size}   oldest week: ${index.oldestWeek}   skipped rows: ${index.skipped}`);
console.log(`week rows      : ${weekRows.length} (${verdicts.length} distinct emails; ${internRowsDropped} intern rows dropped like the wizard does)`);
console.log(`first          : ${by('first').length}   (also off-boarded: ${by('first').filter((v) => v.alsoLeaving).length})`);
console.log(`not_first      : ${by('not_first').length}`);
console.log(`unknown        : ${by('unknown').length}   history_floor: ${by('history_floor').length}`);
console.log('');
console.log('FIRST PAYCHECKS this week:');
for (const v of by('first').sort((a, b) => Number(b.alsoLeaving) - Number(a.alsoLeaving) || a.name.localeCompare(b.name))) {
  console.log(`  ${v.alsoLeaving ? 'LEAVING ' : '        '} ${v.email.padEnd(32)} ${v.name.padEnd(30)} ${v.hours.padEnd(9)} start=${v.start ?? '—'}  dept=${v.dept ?? '—'}${v.offAt ? `  off=${v.offAt.slice(0, 10)}` : ''}`);
}
const unknown = by('unknown');
if (unknown.length) {
  console.log('');
  console.log('UNKNOWN (should be impossible for a row in this file — index built from a different upload set?):');
  for (const v of unknown) console.log(`  ${v.email}  ${v.name}`);
}
