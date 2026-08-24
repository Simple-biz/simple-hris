import fs from 'node:fs';
import { createClient } from '@supabase/supabase-js';
const env = {};
for (const line of fs.readFileSync('.env.local', 'utf8').split('\n')) {
  const m = /^([A-Z0-9_]+)=(.*)$/.exec(line.trim());
  if (m) env[m[1]] = m[2].replace(/^["']|["']$/g, '');
}
const url = env.NEXT_PUBLIC_SUPABASE_URL || env.SUPABASE_URL;
const key = env.SUPABASE_SERVICE_ROLE_KEY || env.SUPABASE_SERVICE_KEY;
const sb = createClient(url, key, { auth: { persistSession: false } });

async function pageAll(table, cols) {
  const out = [];
  const step = 1000;
  for (let from = 0; ; from += step) {
    const { data, error } = await sb.from(table).select(cols).range(from, from + step - 1);
    if (error) return { rows: null, error };
    out.push(...(data ?? []));
    if (!data || data.length < step) break;
  }
  return { rows: out, error: null };
}

const nc1 = await sb.from('table_that_does_not_exist_xyz').select('*').limit(1);
console.log('NEG-CTL missing table ->', nc1.error ? 'ERROR ' + nc1.error.code : 'NO ERROR data=' + JSON.stringify(nc1.data));
const nc2 = await sb.from('global_master_list').select('column_that_does_not_exist_xyz').limit(1);
console.log('NEG-CTL bad column    ->', nc2.error ? 'ERROR ' + nc2.error.code : 'NO ERROR data=' + JSON.stringify(nc2.data));
const pc = await sb.from('global_master_list').select('"Department"').limit(1);
console.log('POS-CTL 1 row         ->', pc.error ? 'ERROR ' + pc.error.message : 'ok ' + JSON.stringify(pc.data));
console.log('');

const norm = (d) => (d ?? '').trim();
const lc = (d) => norm(d).toLowerCase();

const gml = await pageAll('global_master_list', '"Department",off_boarded_at,work_email');
if (gml.error) {
  console.log('GML ERROR', gml.error.code, gml.error.message);
} else {
  const rows = gml.rows;
  const active = rows.filter((r) => !r.off_boarded_at);
  const slugActive = active.filter((r) => lc(r.Department).startsWith('hsl:'));
  const bareActive = active.filter((r) => ['hsl', 'hogan smith law', 'hogan_smith_law'].includes(lc(r.Department)));
  const byKey = {};
  for (const r of slugActive) { const k = norm(r.Department); byKey[k] = (byKey[k] ?? 0) + 1; }
  console.log('GML total=' + rows.length + ' active=' + active.length);
  console.log('GML active hsl:* slug cells = ' + slugActive.length + ' across ' + Object.keys(byKey).length + ' keys');
  console.log('GML active bare HSL/Hogan   = ' + bareActive.length + ' ' + JSON.stringify([...new Set(bareActive.map((r) => norm(r.Department)))]));
  console.log('GML keys: ' + Object.entries(byKey).sort((a, b) => b[1] - a[1]).map(([k, v]) => k + '=' + v).join(' '));
  const otherNs = [...new Set(rows.map((r) => norm(r.Department)).filter((d) => /^[a-z0-9_ ]+:/i.test(d) && !lc(d).startsWith('hsl:')))];
  console.log('GML other namespaced labels: ' + JSON.stringify(otherNs));
  console.log('GML ALL rows with hsl:* = ' + rows.filter((r) => lc(r.Department).startsWith('hsl:')).length);
}
console.log('');

const pcs = await pageAll('payment_catalog_pay_structures', 'id,scope,department_key,employee_email,hourly_rate,created_at,created_by');
if (pcs.error) {
  console.log('PCS ERROR', pcs.error.code, pcs.error.message);
} else {
  const rows = pcs.rows;
  const scopes = {};
  for (const r of rows) scopes[r.scope ?? 'null'] = (scopes[r.scope ?? 'null'] ?? 0) + 1;
  console.log('PCS total=' + rows.length + ' ' + JSON.stringify(scopes));
  const emp = rows.filter((r) => r.scope === 'employee');
  const dep = rows.filter((r) => r.scope === 'department');
  const cnt = (arr, p) => arr.filter(p).length;
  console.log('PCS emp on hogan_smith_law = ' + cnt(emp, (r) => r.department_key === 'hogan_smith_law'));
  console.log('PCS emp on bare hsl        = ' + cnt(emp, (r) => r.department_key === 'hsl'));
  console.log('PCS emp on hsl:*           = ' + cnt(emp, (r) => (r.department_key ?? '').startsWith('hsl:')));
  console.log('PCS dep on hogan_smith_law = ' + cnt(dep, (r) => r.department_key === 'hogan_smith_law'));
  console.log('PCS dep on bare hsl        = ' + cnt(dep, (r) => r.department_key === 'hsl'));
  console.log('PCS dep on hsl:*           = ' + cnt(dep, (r) => (r.department_key ?? '').startsWith('hsl:')));
  console.log('PCS bare-hsl emp rows: ' + JSON.stringify(emp.filter((r) => r.department_key === 'hsl').map((r) => [r.employee_email, r.hourly_rate, r.created_by])));
  const parent = emp.filter((r) => r.department_key === 'hogan_smith_law');
  const after = parent.filter((r) => r.created_at && r.created_at >= '2026-08-14');
  console.log('PCS parent-keyed emp rows created >= 2026-08-14 = ' + after.length + ' of ' + parent.length);
  const byDay = {};
  for (const r of after) { const d = (r.created_at ?? '').slice(0, 10); byDay[d] = (byDay[d] ?? 0) + 1; }
  console.log('PCS   by day: ' + JSON.stringify(byDay));
  const byEmail = new Map();
  for (const r of emp) { const k = (r.employee_email ?? '').toLowerCase(); if (!k) continue; if (!byEmail.has(k)) byEmail.set(k, []); byEmail.get(k).push(r); }
  const dupes = [...byEmail.entries()].filter(([, v]) => v.length > 1);
  console.log('PCS emails with >1 emp-scope row = ' + dupes.length);
  for (const [e, v] of dupes) {
    const rates = [...new Set(v.map((r) => String(r.hourly_rate)))];
    console.log('   ' + e + ': ' + v.map((r) => r.department_key + '=' + r.hourly_rate + '@' + (r.created_at ?? '').slice(0, 10)).join(' | ') + (rates.length > 1 ? '  << DIFFERENT RATES' : ''));
  }
}
console.log('');

const htm = await pageAll('hsl_team_members', 'id,dept_key,created_at,updated_at');
if (htm.error) {
  console.log('HTM ERROR', htm.error.code, htm.error.message);
} else {
  const rows = htm.rows;
  console.log('HTM total=' + rows.length + ' dept_key NULL=' + rows.filter((r) => !r.dept_key).length
    + ' newest updated_at=' + rows.map((r) => r.updated_at).filter(Boolean).sort().pop()
    + ' newest created_at=' + rows.map((r) => r.created_at).filter(Boolean).sort().pop());
}
console.log('');

const dm = await pageAll('department_managers', 'id,department,manager_email,revoked_at');
if (dm.error) {
  console.log('DM ERROR', dm.error.code, dm.error.message);
} else {
  const rows = dm.rows;
  const fam = rows.filter((r) => ['hsl', 'hogan smith law', 'hogan_smith_law'].includes(lc(r.department)) || lc(r.department).startsWith('hsl:'));
  const live = fam.filter((r) => !r.revoked_at);
  const rev = fam.filter((r) => r.revoked_at);
  console.log('DM total=' + rows.length + ' HSL-family=' + fam.length + ' live=' + live.length + ' revoked=' + rev.length);
  const bl = {}, br = {};
  for (const r of live) bl[r.department] = (bl[r.department] ?? 0) + 1;
  for (const r of rev) br[r.department] = (br[r.department] ?? 0) + 1;
  console.log('DM live  : ' + JSON.stringify(bl));
  console.log('DM revokd: ' + JSON.stringify(br));
}
