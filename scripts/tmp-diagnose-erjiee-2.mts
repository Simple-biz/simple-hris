/** READ-ONLY: is Estolonio on the master list under another email? + every week's total. */
import { createClient } from '@supabase/supabase-js';
import dotenv from 'dotenv';
dotenv.config({ path: '.env.local' });
dotenv.config();

const sb = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL!.trim(),
  process.env.SUPABASE_SERVICE_ROLE_KEY!.trim(),
  { auth: { persistSession: false, autoRefreshToken: false } },
);

function parseHmsToSec(v: unknown): number {
  if (v == null) return 0;
  const s = String(v).trim();
  if (!s) return 0;
  const hms = /^(\d+):(\d{2}):(\d{2})$/.exec(s);
  if (hms) return +hms[1] * 3600 + +hms[2] * 60 + +hms[3];
  const hm = /^(\d+):(\d{2})$/.exec(s);
  if (hm) return +hm[1] * 3600 + +hm[2] * 60;
  const d = parseFloat(s);
  return Number.isFinite(d) ? Math.round(d * 3600) : 0;
}

// ---- master list, searched by NAME not email
const { data: master } = await sb.from('global_master_list').select('*');
const hits = (master ?? []).filter((r: Record<string, unknown>) =>
  Object.values(r).some((v) => /estolonio|erjie/i.test(String(v ?? ''))),
);
console.log(`[A] global_master_list rows matching /estolonio|erjie/ : ${hits.length}`);
for (const h of hits as Record<string, unknown>[]) {
  const g = (n: string) => {
    for (const [k, v] of Object.entries(h)) if (k.toLowerCase() === n.toLowerCase()) return v;
    return undefined;
  };
  console.log(
    `    Name="${String(g('Name') ?? '?')}"  Dept="${String(g('Department') ?? '?')}"` +
      `  Work="${String(g('Work Email') ?? '-')}"  Personal="${String(g('Personal Email') ?? '-')}"` +
      `  off_board=${String(g('off_board') ?? '-')}  last_seen_upload=${String(g('last_seen_upload_id') ?? '-').slice(0, 8)}`,
  );
}

// ---- also check the rates cache + employee_ids for this person
for (const tbl of ['employee_hourly_rates', 'employee_ids']) {
  const { data, error } = await sb.from(tbl).select('*');
  if (error) {
    console.log(`[B] ${tbl}: ${error.message}`);
    continue;
  }
  const m = (data ?? []).filter((r: Record<string, unknown>) =>
    Object.values(r).some((v) => /estolonio|erjie/i.test(String(v ?? ''))),
  );
  console.log(`\n[B] ${tbl} rows matching /estolonio|erjie/ : ${m.length}`);
  for (const r of m as Record<string, unknown>[]) {
    const g = (names: string[]) => {
      for (const [k, v] of Object.entries(r))
        if (names.some((n) => n.toLowerCase() === k.toLowerCase())) return v;
      return undefined;
    };
    console.log(
      `    work=${String(g(['Work Email', 'work_email']) ?? '-')}` +
        `  dept=${String(g(['Department', 'department']) ?? '-')}` +
        `  reg=${String(g(['Regular Rate', 'regular_rate']) ?? '-')}` +
        `  ot=${String(g(['OT Rate', 'ot_rate']) ?? '-')}`,
    );
  }
}

// ---- every week's Total worked, sorted, with the 36.5 target flagged
const { data: rows } = await sb.from('hubstaff_hours').select('*').ilike('Email', 'erjiee@simple.biz');
type W = { file: string; hrs: number; days: number };
const weeks: W[] = [];
for (const r of (rows ?? []) as Record<string, unknown>[]) {
  const tw = Object.entries(r).find(([k]) => k.trim().toLowerCase() === 'total worked')?.[1];
  const dayCols = Object.keys(r).filter((k) => /^\d{4}-\d{2}-\d{2}$/.test(k.trim()));
  weeks.push({
    file: String(r.source_file ?? '?'),
    hrs: parseHmsToSec(tw) / 3600,
    days: dayCols.length,
  });
}
console.log(`\n[C] every week's "Total worked" (${weeks.length} rows) — flagging anything near 36.5`);
for (const w of weeks.sort((a, b) => a.file.localeCompare(b.file))) {
  const m = /(\d{4}-\d{2}-\d{2})_to_(\d{4}-\d{2}-\d{2})/.exec(w.file);
  let span = '?';
  if (m) {
    const [a, b] = [new Date(m[1]), new Date(m[2])];
    span = `${Math.round((+b - +a) / 86400000) + 1}d`;
  }
  const near = Math.abs(w.hrs - 36.5) < 1.0 ? '   <<< NEAR 36.5' : '';
  console.log(
    `    ${w.file.padEnd(52)} span=${span.padStart(3)}  dateCols=${String(w.days).padStart(2)}  total=${w.hrs.toFixed(2).padStart(6)}${near}`,
  );
}
console.log('\nNothing was written.');
