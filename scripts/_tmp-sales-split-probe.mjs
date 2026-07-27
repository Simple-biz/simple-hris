// TEMP probe — Sales vs Sales Assistant split. Read-only.
import { createClient } from '@supabase/supabase-js';
import dotenv from 'dotenv';

dotenv.config();

const sb = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY,
);

const PH = ['aleighshaa', 'mar', 'vine', 'markf', 'deanm', 'debm', 'heartm', 'gladysp', 'jcr', 'larat']
  .map(u => `${u}@simple.biz`);
const US = ['dee', 'will', 'brad', 'shawn', 'randy', 'chad', 'justin', 'locke']
  .map(u => `${u}@simple.biz`);
const WANTED = new Map([...PH.map(e => [e, 'PH']), ...US.map(e => [e, 'US'])]);

const norm = (v) => (v ?? '').trim().toLowerCase();

async function pageAll(table, select) {
  const out = [];
  for (let from = 0; ; from += 1000) {
    const { data, error } = await sb.from(table).select(select).range(from, from + 999);
    if (error) throw new Error(`${table}: ${error.message}`);
    out.push(...(data ?? []));
    if ((data ?? []).length < 1000) break;
  }
  return out;
}

const master = await pageAll(
  'global_master_list',
  'id,Department,Name,"Work Email","Personal Email","Alternate Work Email","Alternate Work Email 2",off_boarded_at,last_seen_upload_id',
);
const active = await pageAll('active_employees', 'Department,Name,"Work Email"');
const ids = await pageAll('employee_ids', 'employee_id,work_email,personal_email,bank_preferred');

const activeEmails = new Set(active.map(r => norm(r['Work Email'])).filter(Boolean));
const idByEmail = new Map();
for (const r of ids) {
  for (const e of [r.work_email, r.personal_email]) if (norm(e)) idByEmail.set(norm(e), r);
}

console.log('=== The 18 listed emails ===');
const rowsFor = (email) =>
  master.filter(r =>
    [r['Work Email'], r['Personal Email'], r['Alternate Work Email'], r['Alternate Work Email 2']]
      .some(v => norm(v) === email));
for (const [email, group] of WANTED) {
  const rows = rowsFor(email);
  if (rows.length === 0) { console.log(`${group}  ${email.padEnd(24)} → NOT ON MASTER LIST`); continue; }
  for (const r of rows) {
    const id = idByEmail.get(email);
    console.log(
      `${group}  ${email.padEnd(24)} dept="${r.Department ?? ''}" name="${r.Name ?? ''}"` +
      ` active=${activeEmails.has(norm(r['Work Email'])) ? 'Y' : 'n'}` +
      ` offboarded=${r.off_boarded_at ? r.off_boarded_at.slice(0, 10) : '-'}` +
      ` empId=${id?.employee_id ?? '-'} bank=${id?.bank_preferred ?? '-'}` +
      (rows.length > 1 ? '  [DUPE ROW]' : ''),
    );
  }
}

console.log('\n=== Every master row whose Department mentions "sales" ===');
const salesRows = master.filter(r => norm(r.Department).includes('sales'));
for (const r of salesRows.sort((a, b) => norm(a.Name).localeCompare(norm(b.Name)))) {
  const we = norm(r['Work Email']);
  const listed = WANTED.has(we) || WANTED.has(norm(r['Personal Email']));
  console.log(
    `${listed ? '  listed' : 'UNLISTED'} dept="${r.Department}" ${(r['Work Email'] ?? '(no work email)').padEnd(26)}` +
    ` name="${r.Name ?? ''}" active=${activeEmails.has(we) ? 'Y' : 'n'}` +
    ` offboarded=${r.off_boarded_at ? r.off_boarded_at.slice(0, 10) : '-'}` +
    ` empId=${idByEmail.get(we)?.employee_id ?? '-'}`,
  );
}

console.log('\n=== Distinct sales-ish labels (all master rows) ===');
const labels = new Map();
for (const r of salesRows) {
  const d = (r.Department ?? '').trim();
  labels.set(d, (labels.get(d) ?? 0) + 1);
}
console.log([...labels.entries()]);

console.log('\n=== US- prefixed employee_ids among the 18 ===');
for (const [email, group] of WANTED) {
  const id = idByEmail.get(email);
  if (id?.employee_id?.startsWith('US-')) console.log(`${group} ${email} → ${id.employee_id}`);
}

console.log('\n=== Are any of the 18 in this-week Hubstaff hours? ===');
const { data: hs, error: hsErr } = await sb
  .from('hubstaff_hours')
  .select('email, source_file')
  .in('email', [...WANTED.keys()]);
if (hsErr) console.log('hubstaff_hours error:', hsErr.message);
else {
  const byEmail = new Map();
  for (const r of hs ?? []) {
    const k = norm(r.email);
    byEmail.set(k, (byEmail.get(k) ?? new Set()).add(r.source_file));
  }
  for (const [email, group] of WANTED) {
    const files = byEmail.get(email);
    console.log(`${group} ${email.padEnd(24)} hubstaff_rows=${files ? files.size + ' files' : 'NONE'}`);
  }
}
