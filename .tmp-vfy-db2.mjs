import fs from 'node:fs';
import { createClient } from '@supabase/supabase-js';
const env = {};
for (const line of fs.readFileSync('.env.local', 'utf8').split('\n')) {
  const m = /^([A-Z0-9_]+)=(.*)$/.exec(line.trim());
  if (m) env[m[1]] = m[2].replace(/^["']|["']$/g, '');
}
const sb = createClient(env.NEXT_PUBLIC_SUPABASE_URL || env.SUPABASE_URL, env.SUPABASE_SERVICE_ROLE_KEY, { auth: { persistSession: false } });

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
const norm = (d) => (d ?? '').trim();
const lc = (d) => norm(d).toLowerCase();
const isSlug = (d) => lc(d).startsWith('hsl:');

// 1. GML
const gml = await pageAll('global_master_list', '"Department",off_boarded_at,"Work Email",last_seen_upload_id');
if (gml.error) console.log('GML ERROR', gml.error.code, gml.error.message);
else {
  const rows = gml.rows;
  const active = rows.filter((r) => !r.off_boarded_at);
  const slug = active.filter((r) => isSlug(r.Department));
  const bare = active.filter((r) => ['hsl', 'hogan smith law', 'hogan_smith_law'].includes(lc(r.Department)));
  const byKey = {};
  for (const r of slug) { const k = norm(r.Department); byKey[k] = (byKey[k] ?? 0) + 1; }
  console.log('GML total=' + rows.length + ' active=' + active.length);
  console.log('GML ACTIVE hsl:* cells=' + slug.length + ' keys=' + Object.keys(byKey).length);
  console.log('GML ACTIVE bare-family=' + bare.length + ' ' + JSON.stringify([...new Set(bare.map((r) => norm(r.Department)))]));
  console.log('GML keys: ' + Object.entries(byKey).sort((a, b) => b[1] - a[1]).map(([k, v]) => k + '=' + v).join(' '));
  console.log('GML ALL-rows hsl:* = ' + rows.filter((r) => isSlug(r.Department)).length);
  const other = [...new Set(rows.map((r) => norm(r.Department)).filter((d) => /:/.test(d) && !isSlug(d)))];
  console.log('GML other colon labels: ' + JSON.stringify(other));
  // first 1000 rows only, to test verifier-1 claim of "186 of first 1000"
  const first1k = rows.slice(0, 1000).filter((r) => isSlug(r.Department)).length;
  console.log('GML hsl:* in first 1000 rows returned = ' + first1k);
}
console.log('');

// 2. PCS
const pcs = await pageAll('payment_catalog_pay_structures', 'id,scope,department_key,employee_email,regular_rate,currency,created_at,created_by');
if (pcs.error) console.log('PCS ERROR', pcs.error.code, pcs.error.message);
else {
  const rows = pcs.rows;
  const scopes = {};
  for (const r of rows) scopes[r.scope ?? 'null'] = (scopes[r.scope ?? 'null'] ?? 0) + 1;
  console.log('PCS total=' + rows.length + ' ' + JSON.stringify(scopes));
  const emp = rows.filter((r) => r.scope === 'employee');
  const dep = rows.filter((r) => r.scope === 'department');
  const c = (a, p) => a.filter(p).length;
  console.log('PCS emp hogan_smith_law=' + c(emp, (r) => r.department_key === 'hogan_smith_law')
    + ' emp bare-hsl=' + c(emp, (r) => r.department_key === 'hsl')
    + ' emp hsl:*=' + c(emp, (r) => (r.department_key ?? '').startsWith('hsl:')));
  console.log('PCS dep hogan_smith_law=' + c(dep, (r) => r.department_key === 'hogan_smith_law')
    + ' dep bare-hsl=' + c(dep, (r) => r.department_key === 'hsl')
    + ' dep hsl:*=' + c(dep, (r) => (r.department_key ?? '').startsWith('hsl:')));
  console.log('PCS bare-hsl emp rows: ' + JSON.stringify(emp.filter((r) => r.department_key === 'hsl').map((r) => [r.employee_email, r.regular_rate, r.currency, r.created_by])));
  const parent = emp.filter((r) => r.department_key === 'hogan_smith_law');
  const after = parent.filter((r) => r.created_at >= '2026-08-14');
  console.log('PCS parent-keyed emp created >= 2026-08-14: ' + after.length + '/' + parent.length);
  const byDayBy = {};
  for (const r of after) { const k = (r.created_at ?? '').slice(0, 10) + ' ' + (r.created_by ?? '?'); byDayBy[k] = (byDayBy[k] ?? 0) + 1; }
  console.log('PCS  ' + JSON.stringify(byDayBy));
  const byEmail = new Map();
  for (const r of emp) { const k = (r.employee_email ?? '').toLowerCase(); if (!k) continue; if (!byEmail.has(k)) byEmail.set(k, []); byEmail.get(k).push(r); }
  const dupes = [...byEmail.entries()].filter(([, v]) => v.length > 1);
  console.log('PCS emails with >1 emp-scope row = ' + dupes.length);
  for (const [e, v] of dupes) {
    const rates = [...new Set(v.map((r) => String(r.regular_rate)))];
    console.log('   ' + e + ': ' + v.map((r) => r.department_key + '=' + r.regular_rate + '@' + (r.created_at ?? '').slice(0, 10)).join(' | ') + (rates.length > 1 ? '  << DIFFERENT RATES' : ''));
  }
  const depKeys = {};
  for (const r of dep) depKeys[r.department_key] = (depKeys[r.department_key] ?? 0) + 1;
  console.log('PCS dept-scope keys: ' + JSON.stringify(depKeys));
}
console.log('');

// 3. HTM
const htm = await pageAll('hsl_team_members', 'email,dept_key,created_at,updated_at,upload_id');
if (htm.error) console.log('HTM ERROR', htm.error.code, htm.error.message);
else {
  const rows = htm.rows;
  console.log('HTM total=' + rows.length + ' NULL dept_key=' + rows.filter((r) => !r.dept_key).length
    + ' newest updated=' + rows.map((r) => r.updated_at).filter(Boolean).sort().pop()
    + ' newest created=' + rows.map((r) => r.created_at).filter(Boolean).sort().pop());
  const k = {};
  for (const r of rows) k[r.dept_key ?? 'NULL'] = (k[r.dept_key ?? 'NULL'] ?? 0) + 1;
  console.log('HTM dept_key counts: ' + JSON.stringify(k));
}
console.log('');

// 4. transfer requests / notifications / offboarding_queue / paystubs / audit
const dtr = await pageAll('department_transfer_requests', 'id,from_department,to_department,status');
if (dtr.error) console.log('DTR ERROR', dtr.error.code);
else {
  const rows = dtr.rows;
  const withSlug = rows.filter((r) => isSlug(r.from_department) || isSlug(r.to_department));
  console.log('DTR total=' + rows.length + ' rows touching hsl:*=' + withSlug.length
    + ' (from-side=' + rows.filter((r) => isSlug(r.from_department)).length
    + ' to-side=' + rows.filter((r) => isSlug(r.to_department)).length + ')');
}

const en = await pageAll('employee_notifications', 'id,type,message,created_at');
if (en.error) console.log('EN ERROR', en.error.code);
else {
  const rows = en.rows;
  const hit = rows.filter((r) => /hsl:/i.test(r.message ?? ''));
  const byType = {};
  for (const r of hit) byType[r.type] = (byType[r.type] ?? 0) + 1;
  console.log('EN total=' + rows.length + ' messages containing "hsl:" = ' + hit.length + ' ' + JSON.stringify(byType));
  for (const r of hit.slice(0, 3)) console.log('   e.g. [' + r.type + '] ' + (r.message ?? '').slice(0, 150));
  const byTypeAll = {};
  for (const r of rows) if (/^transfer\./.test(r.type ?? '')) byTypeAll[r.type] = (byTypeAll[r.type] ?? 0) + 1;
  console.log('EN transfer.* totals: ' + JSON.stringify(byTypeAll));
}

const oq = await pageAll('offboarding_queue', 'id,department,status');
if (oq.error) console.log('OQ ERROR', oq.error.code);
else console.log('OQ total=' + oq.rows.length + ' hsl:* dept rows=' + oq.rows.filter((r) => isSlug(r.department)).length);

const pdq = await pageAll('paystub_dispatch_queue', 'id,department_key');
if (pdq.error) console.log('PDQ ERROR', pdq.error.code);
else {
  const rows = pdq.rows;
  console.log('PDQ total=' + rows.length + ' department_key hsl:*=' + rows.filter((r) => isSlug(r.department_key)).length
    + ' hogan_smith_law=' + rows.filter((r) => r.department_key === 'hogan_smith_law').length);
}
