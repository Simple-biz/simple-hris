/**
 * READ-ONLY verifier for the Payroll Wizard's FINAL-PAY roster overlay.
 *
 * The overlay (src/lib/roster/offboarded-roster-row.ts, served by
 * GET /api/payroll-wizard/offboarded-roster) exists because `active_employees`
 * carries no offboarded rows: tier 1 of the wizard's department resolver is
 * silent for a leaver, so whatever department key the wizard recorded before
 * they left is frozen forever. That key selects the pay week, the HSL weekend
 * premium, the OT convention and KPI eligibility — so a leaver with hours gets
 * their FINAL check computed on the wrong basis.
 *
 * This script replays the resolver's tier-1/1b decision against live data and
 * asserts the two ways the overlay could LOSE someone money:
 *
 *   1. No leaver with hours may resolve into a PAY-PAUSED department. A pause
 *      suppresses rather than defers (a paused dept's people never get a staged
 *      row, so nothing can surface arrears later) — for someone who has already
 *      left, "not this week" means never.
 *   2. The duplicate-master-row merge must resolve to the row the sheet still
 *      carries. vano@ and mikayi@ each have a retired row AND a live row with
 *      off_boarded_at stamped on both; only `last_seen_upload_id` separates
 *      them, and the retired one says a department that is pay-paused.
 *
 * Usage:
 *   $env:TSX_TSCONFIG_PATH="tsconfig.readiness-verify.json"
 *   node --import tsx scripts/verify-final-pay-overlay.mts [--source-file=<name>]
 */
import { createClient } from '@supabase/supabase-js';
import dotenv from 'dotenv';

dotenv.config({ path: '.env.local' });
dotenv.config();

const { listRecentlyOffboardedPeople } = await import('../src/lib/roster/recently-offboarded');
const { offboardedRelevantToWeek } = await import('../src/lib/roster/offboarded-week-relevance');
const { isEligibleForFinalPayReview } = await import('../src/lib/payroll/offboarded-final-pay-eligibility');
const { normalizeDeptToKey } = await import('../src/lib/payroll/normalize-dept-key');
const { slugifyDeptKey } = await import('../src/lib/departments/registry');
const { resolveCurrentWeek } = await import('../src/lib/payroll/payroll-readiness');

const args = process.argv.slice(2);
const sourceFileArg =
  args.find((a) => a.startsWith('--source-file='))?.slice('--source-file='.length) ?? null;

const sb = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL!, process.env.SUPABASE_SERVICE_ROLE_KEY!, {
  auth: { persistSession: false },
});

const norm = (e: string | null | undefined): string | null => (e ?? '').trim().toLowerCase() || null;
const keyOf = (raw: string | null): string | null =>
  raw ? normalizeDeptToKey(raw) ?? slugifyDeptKey(raw) ?? null : null;

/** Paged reader — PostgREST caps a plain select at 1000 rows. */
async function pageAll(table: string, cols: string, tweak?: (q: never) => never): Promise<Record<string, unknown>[]> {
  const out: Record<string, unknown>[] = [];
  for (let from = 0; ; from += 1000) {
    let q = sb.from(table).select(cols).range(from, from + 999) as never;
    if (tweak) q = tweak(q);
    const { data, error } = (await q) as unknown as { data: Record<string, unknown>[] | null; error: { message: string } | null };
    if (error) throw new Error(`${table}: ${error.message}`);
    out.push(...(data ?? []));
    if (!data || data.length < 1000) break;
  }
  return out;
}

// ── Resolve the cycle in view ────────────────────────────────────────────────
let sourceFile = sourceFileArg;
if (!sourceFile) {
  const { data, error: upErr } = await sb
    .from('hubstaff_uploads')
    .select('source_file, is_current, uploaded_at')
    .order('uploaded_at', { ascending: false })
    .limit(10);
  if (upErr) console.error(`hubstaff_uploads: ${upErr.message}`);
  const rows = (data ?? []) as { source_file: string | null; is_current: boolean | null }[];
  sourceFile = (rows.find((r) => r.is_current) ?? rows[0])?.source_file ?? null;
}
if (!sourceFile) {
  console.error('No source file — pass --source-file=<name>.');
  process.exit(1);
}

const { weekStart } = await resolveCurrentWeek(sourceFile);
console.log(`cycle:     ${sourceFile}`);
console.log(`pay week:  ${weekStart}\n`);

// ── The overlay, exactly as the route builds it ──────────────────────────────
const { people, hoursWeekFloor, error } = await listRecentlyOffboardedPeople(90);
if (error) {
  console.error(`ERROR building the overlay: ${error}`);
  process.exit(1);
}
const overlay = people.filter(
  (p) => isEligibleForFinalPayReview(p.off_boarded_reason) && offboardedRelevantToWeek(p, weekStart, hoursWeekFloor),
);
console.log(`overlay rows for this week: ${overlay.length} (of ${people.length} recent leavers)\n`);

// ── Who has hours in this cycle ──────────────────────────────────────────────
const hours = await pageAll('hubstaff_hours', '"Email","Member"', ((q: never) =>
  (q as unknown as { eq: (a: string, b: string) => never }).eq('source_file', sourceFile!)) as never);
const hourEmails = new Map<string, string>();
for (const h of hours) {
  const e = norm(h['Email'] as string);
  if (e) hourEmails.set(e, (h['Member'] as string) ?? '');
}

// ── Active roster: tier 1 always wins, so anyone here is NOT overlay territory ─
const active = await pageAll('active_employees', '"Work Email","Personal Email","Alternate Work Email","Alternate Work Email 2"');
const activeEmails = new Set<string>();
for (const r of active) {
  for (const c of ['Work Email', 'Personal Email', 'Alternate Work Email', 'Alternate Work Email 2']) {
    const e = norm(r[c] as string);
    if (e) activeEmails.add(e);
  }
}

// ── The wizard's persisted grouping + this cycle's pause set ─────────────────
const settingsFor = async (key: string): Promise<string | null> => {
  const { data } = await sb.from('app_settings').select('value').eq('key', key);
  return (data?.[0]?.value as string | undefined) ?? null;
};
const blobRaw = await settingsFor(`payroll.wizard.additions.${sourceFile}`);
const savedDepts: Record<string, string> = blobRaw ? JSON.parse(blobRaw).employeeDepts ?? {} : {};
const pausedRaw = await settingsFor(`payroll.wizard.dept_pay_paused.${sourceFile}`);
const paused: string[] = pausedRaw ? JSON.parse(pausedRaw) : [];
console.log(`pay-paused departments: ${JSON.stringify(paused)}\n`);

// ── Replay tier 1b for every leaver who logged hours ─────────────────────────
const HSL_KEY = 'hogan_smith_law';
interface Line {
  email: string;
  name: string;
  saved: string | null;
  resolved: string | null;
  hslBoundary: boolean;
  pausedNow: boolean;
}
const lines: Line[] = [];

for (const p of overlay) {
  const emails = [p.hubstaff_email, p.work_email, p.personal_email, p.alternate_work_email, p.alternate_work_email_2]
    .map(norm)
    .filter((e): e is string => !!e);
  // Only people who actually logged hours in this cycle are in scope — the
  // overlay can annotate a calc row, never create one.
  const hit = emails.find((e) => hourEmails.has(e));
  if (!hit) continue;
  // An active row would have won at tier 1; the overlay is never reached.
  if (emails.some((e) => activeEmails.has(e))) continue;

  const saved = savedDepts[hit] ?? emails.map((e) => savedDepts[e]).find(Boolean) ?? null;
  const resolved = keyOf(p.department);
  lines.push({
    email: hit,
    name: p.name,
    saved,
    resolved,
    hslBoundary: (saved === HSL_KEY) !== (resolved === HSL_KEY),
    pausedNow: !!resolved && paused.includes(resolved),
  });
}

lines.sort((a, b) => Number(b.hslBoundary) - Number(a.hslBoundary) || a.name.localeCompare(b.name));

console.log(`leavers with hours this cycle: ${lines.length}\n`);
for (const l of lines) {
  const change = l.saved === l.resolved ? '(unchanged)' : `${l.saved ?? 'UNASSIGNED'} → ${l.resolved ?? 'UNASSIGNED'}`;
  console.log(
    `  ${l.name}\n      <${l.email}>  ${change}` +
      `${l.hslBoundary ? '   ← HSL BOUNDARY (pay week, weekend premium, OT convention change)' : ''}` +
      `${l.pausedNow ? '   ← LANDS IN A PAY-PAUSED DEPT' : ''}`,
  );
}

// ── Assertions ───────────────────────────────────────────────────────────────
let failed = false;

const stranded = lines.filter((l) => l.pausedNow);
if (stranded.length > 0) {
  failed = true;
  console.error(`\nFAIL: ${stranded.length} leaver(s) with hours resolve into a pay-paused department.`);
  console.error('      A pause has no arrears path, so for someone who has left it means never paid.');
  for (const l of stranded) console.error(`        ${l.name} <${l.email}> → ${l.resolved}`);
}

// The duplicate-row merge must pick the row the sheet still carries.
const DUPE_EXPECT: Record<string, string> = {
  'vano@simple.biz': 'lead_gen',
  'mikayi@simple.biz': 'lead_gen',
};
for (const [email, want] of Object.entries(DUPE_EXPECT)) {
  const p = overlay.find((x) =>
    [x.hubstaff_email, x.work_email, x.personal_email].map(norm).includes(email),
  );
  if (!p) {
    console.log(`\nnote: ${email} is not in this week's overlay — duplicate-row check skipped.`);
    continue;
  }
  const got = keyOf(p.department);
  if (got !== want) {
    failed = true;
    console.error(
      `\nFAIL: ${email} resolves to "${got}" but the CURRENT master upload says "${want}".` +
        `\n      The duplicate-row merge is preferring a retired row (see the promotion rule in recently-offboarded.ts).`,
    );
  } else {
    console.log(`\nOK: ${email} → ${got} (current-upload row won the duplicate merge)`);
  }
}

if (failed) process.exit(1);
console.log('\nOK: no leaver with hours is stranded by a pay-pause, and duplicate rows resolve to the live roster.');
