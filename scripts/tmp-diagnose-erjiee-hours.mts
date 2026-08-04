/**
 * READ-ONLY diagnostic: trace one person's hours through every stage of the
 * pipeline, so we can see WHICH boundary loses/changes hours rather than guess.
 *
 * Stages instrumented:
 *   1. global_master_list      -> who they are, dept (dept decides the week shape)
 *   2. hubstaff_uploads        -> which uploads exist, which is_current
 *   3. hubstaff_hours          -> every row for this email, per-day + "Total worked"
 *   4. duplicate detection     -> >1 row for the same email in the same source_file
 *                                (the known double-ingest class)
 *   5. per-week day sums       -> what a 7-day pay window would actually total
 *   6. disbursement_records /
 *      payment_dispatches      -> what the money side recorded
 *
 * STRICTLY READ-ONLY.  npx tsx scripts/tmp-diagnose-erjiee-hours.mts [email]
 */
import { createClient } from '@supabase/supabase-js';
import dotenv from 'dotenv';

dotenv.config({ path: '.env.local' });
dotenv.config();

const EMAIL = (process.argv.find((a) => a.includes('@')) ?? 'erjiee@simple.biz').toLowerCase();

const sb = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL!.trim(),
  process.env.SUPABASE_SERVICE_ROLE_KEY!.trim(),
  { auth: { persistSession: false, autoRefreshToken: false } },
);

const norm = (v: unknown) => String(v ?? '').trim().toLowerCase();

/** Mirrors parseHmsToSec in current-pay.ts: H:MM:SS, H:MM, or decimal hours. */
function parseHmsToSec(v: unknown): number {
  if (v == null) return 0;
  const s = String(v).trim();
  if (!s) return 0;
  const hms = /^(\d+):(\d{2}):(\d{2})$/.exec(s);
  if (hms) return +hms[1] * 3600 + +hms[2] * 60 + +hms[3];
  const hm = /^(\d+):(\d{2})$/.exec(s);
  if (hm) return +hm[1] * 3600 + +hm[2] * 60;
  const dec = parseFloat(s);
  return Number.isFinite(dec) ? Math.round(dec * 3600) : 0;
}
const isDateCol = (k: string) => /^\d{4}-\d{2}-\d{2}$/.test(k.trim());
const hrs = (sec: number) => (sec / 3600).toFixed(2);

console.log(`\n${'='.repeat(96)}`);
console.log(`HOURS PIPELINE DIAGNOSTIC — ${EMAIL}   (READ-ONLY)`);
console.log('='.repeat(96));

// ---------------------------------------------------- 1. master list identity
const { data: master } = await sb.from('global_master_list').select('*');
const mine = (master ?? []).filter((r: Record<string, unknown>) => {
  const vals = Object.entries(r)
    .filter(([k]) => /email/i.test(k))
    .map(([, v]) => norm(v));
  return vals.includes(EMAIL);
});
console.log(`\n[1] global_master_list — ${mine.length} row(s) matching this email`);
for (const m of mine as Record<string, unknown>[]) {
  const pick = (aliases: string[]) => {
    for (const [k, v] of Object.entries(m)) {
      if (aliases.some((a) => a.toLowerCase() === k.toLowerCase())) return v;
    }
    return undefined;
  };
  console.log(
    `    name=${String(pick(['Name']) ?? '?')} | dept=${String(pick(['Department']) ?? '?')}` +
      ` | off_board=${String(pick(['off_board', 'offboarded']) ?? '-')}` +
      ` | work=${String(pick(['Work Email']) ?? '-')} | personal=${String(pick(['Personal Email']) ?? '-')}`,
  );
}
if (mine.length > 1) console.log('    !! DUPLICATE master rows — the dual-master-row drift class.');

// ------------------------------------------------------------- 2. the uploads
const { data: uploads } = await sb
  .from('hubstaff_uploads')
  .select('id, source_file, is_current, uploaded_at')
  .order('uploaded_at', { ascending: false })
  .limit(14);
console.log(`\n[2] hubstaff_uploads — newest 14`);
for (const u of uploads ?? []) {
  console.log(
    `    ${u.is_current ? '* CURRENT' : '         '}  ${String(u.uploaded_at).slice(0, 19)}  id=${u.id}  ${u.source_file}`,
  );
}

// ------------------------------------------------- 3+4. this person's raw rows
const { data: rows, error } = await sb
  .from('hubstaff_hours')
  .select('*')
  .ilike('Email', EMAIL);
if (error) throw new Error(`hubstaff_hours: ${error.message}`);
console.log(`\n[3] hubstaff_hours — ${rows?.length ?? 0} row(s) for this email`);

const bySource = new Map<string, Record<string, unknown>[]>();
for (const r of (rows ?? []) as Record<string, unknown>[]) {
  const sf = String(r.source_file ?? '(none)');
  bySource.set(sf, [...(bySource.get(sf) ?? []), r]);
}

for (const [sf, rs] of [...bySource.entries()].sort()) {
  console.log(`\n  --- ${sf}    (${rs.length} row${rs.length > 1 ? 's' : ''})`);
  if (rs.length > 1) {
    console.log(`      !! ${rs.length} ROWS for the same email in ONE source_file — double-ingest class.`);
  }
  for (const r of rs) {
    const days = Object.entries(r)
      .filter(([k]) => isDateCol(k))
      .map(([k, v]) => ({ date: k.trim(), sec: parseHmsToSec(v), raw: String(v ?? '') }))
      .filter((d) => d.sec > 0)
      .sort((a, b) => a.date.localeCompare(b.date));
    const daySum = days.reduce((s, d) => s + d.sec, 0);
    const totalWorked = parseHmsToSec(
      Object.entries(r).find(([k]) => k.trim().toLowerCase() === 'total worked')?.[1],
    );
    console.log(
      `      upload_id=${String(r.upload_id ?? 'NULL')}  job_type=${String(r['Job type'] ?? '?')}` +
        `  member=${String(r['Member'] ?? '?')}`,
    );
    console.log(
      `      "Total worked" = ${hrs(totalWorked)} h   |   sum of per-day cols = ${hrs(daySum)} h` +
        (Math.abs(totalWorked - daySum) > 60 ? '   <-- MISMATCH' : ''),
    );
    if (days.length === 0) {
      console.log('      (no per-day date columns on this row)');
    } else {
      const dow = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
      console.log(
        '      days: ' +
          days
            .map((d) => {
              const [y, m, dd] = d.date.split('-').map(Number);
              return `${d.date}(${dow[new Date(y, m - 1, dd).getDay()]})=${hrs(d.sec)}`;
            })
            .join('  '),
      );
      // What each candidate 7-day window would total.
      const first = days[0].date;
      const last = days[days.length - 1].date;
      console.log(`      span ${first} → ${last}  (${days.length} worked day(s))`);
    }
  }
}

// ------------------------------------------------------ 6. the money side
const { data: disb } = await sb
  .from('disbursement_records')
  .select('cycle_period_start, cycle_period_end, regular_hours, ot_hours, total_hours, amount_php, status')
  .ilike('recipient_email', EMAIL)
  .order('cycle_period_start', { ascending: false })
  .limit(10);
console.log(`\n[6a] disbursement_records — newest ${disb?.length ?? 0}`);
for (const d of disb ?? []) {
  console.log(
    `    ${d.cycle_period_start} → ${d.cycle_period_end}   total=${d.total_hours}` +
      `  reg=${d.regular_hours}  ot=${d.ot_hours}  php=${d.amount_php}  [${d.status}]`,
  );
}

const { data: pd } = await sb
  .from('payment_dispatches')
  .select('cycle_source_file, amount_php, status, sent_date')
  .ilike('recipient_email', EMAIL)
  .order('sent_date', { ascending: false })
  .limit(10);
console.log(`\n[6b] payment_dispatches — newest ${pd?.length ?? 0}`);
for (const p of pd ?? []) {
  console.log(`    ${String(p.sent_date).slice(0, 10)}  php=${p.amount_php}  [${p.status}]  ${p.cycle_source_file}`);
}

console.log(`\n${'='.repeat(96)}`);
console.log('Nothing was written.');
console.log('='.repeat(96));
