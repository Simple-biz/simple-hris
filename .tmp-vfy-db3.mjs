import fs from 'node:fs';
import { createClient } from '@supabase/supabase-js';
const env = {};
for (const line of fs.readFileSync('.env.local', 'utf8').split('\n')) {
  const m = /^([A-Z0-9_]+)=(.*)$/.exec(line.trim());
  if (m) env[m[1]] = m[2].replace(/^["']|["']$/g, '');
}
const sb = createClient(env.NEXT_PUBLIC_SUPABASE_URL || env.SUPABASE_URL, env.SUPABASE_SERVICE_ROLE_KEY, { auth: { persistSession: false } });
async function pageAll(table, cols) {
  const out = []; const step = 1000;
  for (let from = 0; ; from += step) {
    const { data, error } = await sb.from(table).select(cols).range(from, from + step - 1);
    if (error) return { rows: null, error };
    out.push(...(data ?? []));
    if (!data || data.length < step) break;
  }
  return { rows: out, error: null };
}

// audit_log details containing hsl:
const al = await pageAll('audit_log', 'id,action,details');
if (al.error) console.log('AL ERROR', al.error.code, al.error.message);
else {
  const rows = al.rows;
  const hit = rows.filter((r) => /hsl:/i.test(JSON.stringify(r.details ?? {})));
  const byAction = {};
  for (const r of hit) byAction[r.action] = (byAction[r.action] ?? 0) + 1;
  console.log('AUDIT total=' + rows.length + ' details containing "hsl:" = ' + hit.length);
  console.log('AUDIT by action: ' + JSON.stringify(byAction));
}
console.log('');

// paystub payload.department_name
const pdq = await pageAll('paystub_dispatch_queue', 'id,department_key,payload');
if (pdq.error) console.log('PDQ ERROR', pdq.error.code, pdq.error.message);
else {
  const rows = pdq.rows;
  const names = {};
  let slugCount = 0, nullCount = 0;
  for (const r of rows) {
    const dn = r.payload && typeof r.payload === 'object' ? r.payload.department_name : undefined;
    if (dn == null) { nullCount++; continue; }
    const s = String(dn);
    if (/^hsl:/i.test(s.trim())) slugCount++;
    if (/hsl|hogan/i.test(s)) names[s] = (names[s] ?? 0) + 1;
  }
  console.log('PDQ rows=' + rows.length + ' payload.department_name NULL=' + nullCount + ' raw hsl:* = ' + slugCount);
  console.log('PDQ HSL-ish department_name values: ' + JSON.stringify(names));
}
console.log('');

// urgent_payment_requests + hr_pending_employees + hr_onboarding_submissions + leave_requests
for (const [t, col] of [['urgent_payment_requests', 'department'], ['hr_pending_employees', 'department'], ['hr_onboarding_submissions', 'invite_department'], ['leave_requests', 'department'], ['mesa_requests', 'department']]) {
  const r = await pageAll(t, 'id,' + col);
  if (r.error) { console.log(t + '.' + col + ' -> ERROR ' + r.error.code + ' ' + r.error.message.slice(0, 70)); continue; }
  const vals = {};
  for (const row of r.rows) { const v = (row[col] ?? '(null)').toString().trim() || '(empty)'; if (/hsl|hogan/i.test(v)) vals[v] = (vals[v] ?? 0) + 1; }
  const slug = r.rows.filter((row) => /^hsl:/i.test((row[col] ?? '').toString().trim())).length;
  console.log(t + '.' + col + ' rows=' + r.rows.length + ' raw hsl:*=' + slug + ' HSL-ish=' + JSON.stringify(vals));
}
