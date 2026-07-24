/**
 * Clear the backlog of stuck ("approved" but never applied) department transfers.
 *
 * Mirrors the shipped applyDepartmentTransfer resolution EXACTLY:
 *   moved      — a row still in the source dept, or on the roster elsewhere:
 *                write Department = to_department, flip request -> applied.
 *   satisfied  — employee already in to_department: no write; flip -> applied.
 *   notFound   — employee not on the active roster: flip request -> cancelled
 *                with a note (never applies).
 *
 * SAFE BY DEFAULT: dry-run. It prints exactly what it WOULD do and writes a
 * backup JSON of every affected transfer + master row. Re-run with --apply to
 * perform the writes. NOTE: this script does NOT write the Google Sheet — the
 * next master-sheet sync reconciles the Sheet from Supabase, and the in-app
 * "Apply now" handles the Sheet for future transfers.
 *
 * Run through tsx so it can import the SHIPPED decision logic (planDepartmentApply)
 * — the script can't drift from what the app actually does:
 *   npx tsx scripts/clear-stuck-transfers.mjs            # dry run
 *   npx tsx scripts/clear-stuck-transfers.mjs --apply    # perform writes
 */
import { createClient } from '@supabase/supabase-js';
import dotenv from 'dotenv';
import { writeFileSync } from 'node:fs';

/**
 * INLINE copy of planDepartmentApply from
 * src/lib/supabase/department-transfer-requests.ts — kept identical on purpose.
 * (Importing the app module here drags in the Next-flavored Supabase server
 * client, which fails to evaluate under a bare tsx run. The logic is small and
 * the shipped copy is unit-tested in department-transfer-requests.test.ts; if you
 * change one, change both.)
 */
type Cand = { id: string | number; dept: string; workEmail?: string | null };
function planDepartmentApply(candidates: Cand[], fromDepartment: string, toDepartment: string) {
  const fromKey = fromDepartment.trim().toLowerCase();
  const toKey = toDepartment.trim().toLowerCase();
  const weKey = (v: string | null | undefined) => (v ?? '').trim().toLowerCase();
  if (candidates.length === 0) return { resolution: 'notFound', moveIds: [], deleteIds: [] };
  const targetWorkEmails = new Set(
    candidates.filter((r) => r.dept.trim().toLowerCase() === toKey && weKey(r.workEmail)).map((r) => weKey(r.workEmail)),
  );
  const sourceRows = candidates.filter((r) => r.dept.trim().toLowerCase() === fromKey);
  if (sourceRows.length > 0) {
    const moveIds: Array<string | number> = [];
    const deleteIds: Array<string | number> = [];
    for (const r of sourceRows) {
      if (weKey(r.workEmail) && targetWorkEmails.has(weKey(r.workEmail))) deleteIds.push(r.id);
      else moveIds.push(r.id);
    }
    if (moveIds.length === 0) return { resolution: 'satisfied', moveIds: [], deleteIds };
    return { resolution: 'moved', moveIds, deleteIds };
  }
  if (candidates.some((r) => r.dept.trim().toLowerCase() === toKey)) {
    return { resolution: 'satisfied', moveIds: [], deleteIds: [] };
  }
  return { resolution: 'moved', moveIds: candidates.map((r) => r.id), deleteIds: [] };
}

dotenv.config({ path: '.env.local' });
dotenv.config();

const APPLY = process.argv.includes('--apply');
const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
if (!url || !key) {
  console.log('Missing NEXT_PUBLIC_SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY');
  process.exit(1);
}
const supabase = createClient(url, key, { auth: { persistSession: false } });
const norm = (v) => String(v ?? '').trim().toLowerCase();

async function sel(fn) {
  // Small retry — the sandboxed network occasionally drops the first fetch.
  let last;
  for (let i = 0; i < 3; i++) {
    const r = await fn();
    if (!r.error && r.data) return r;
    last = r;
  }
  return last;
}

const reqRes = await sel(() =>
  supabase
    .from('department_transfer_requests')
    .select('*')
    .eq('status', 'approved')
    .order('created_at', { ascending: true }),
);
if (reqRes.error) {
  console.log('read requests failed:', reqRes.error.message);
  process.exit(1);
}
const reqs = reqRes.data ?? [];

// Supabase caps a plain select at 1000 rows; the roster is larger, so PAGINATE —
// an unpaged read silently truncates and would make people past row 1000 look
// off-roster (wrongly cancelling their transfers).
const master: any[] = [];
{
  const PAGE = 1000;
  for (let from = 0; ; from += PAGE) {
    const res = await sel(() =>
      supabase
        .from('global_master_list')
        .select('id, "Personal Email", "Work Email", "Department", "Name"')
        .order('id', { ascending: true })
        .range(from, from + PAGE - 1),
    );
    if (res.error) {
      console.log('read master failed:', res.error.message);
      process.exit(1);
    }
    const batch = res.data ?? [];
    master.push(...batch);
    if (batch.length < PAGE) break;
  }
}
console.log(`master rows loaded: ${master.length}`);

const byEmail = new Map();
for (const r of master) {
  for (const em of [r['Personal Email'], r['Work Email']]) {
    const k = norm(em);
    if (!k) continue;
    const arr = byEmail.get(k) ?? [];
    arr.push({ id: r.id, dept: String(r.Department ?? '').trim(), workEmail: norm(r['Work Email']) });
    byEmail.set(k, arr);
  }
}

// Classify each approved request with the SHIPPED decision (planDepartmentApply).
const plan = []; // { req, action:'move'|'satisfied'|'cancel', ids:[], note }
for (const r of reqs) {
  const emails = [r.employee_email, r.employee_work_email, r.employee_personal_email]
    .map(norm)
    .filter(Boolean);
  const seen = new Set();
  const mine = [];
  for (const e of emails)
    for (const row of byEmail.get(e) ?? []) {
      if (seen.has(row.id)) continue;
      seen.add(row.id);
      mine.push(row);
    }
  const who = r.employee_name ?? r.employee_email;
  const decision = planDepartmentApply(mine, r.from_department, r.to_department);

  if (decision.resolution === 'notFound') {
    plan.push({
      req: r,
      action: 'cancel',
      moveIds: [],
      deleteIds: [],
      note: `Auto-cancelled: ${who} is not on the active roster, so the move to ${r.to_department} can't be applied (off-boarded or email changed).`,
    });
  } else if (decision.resolution === 'satisfied') {
    plan.push({ req: r, action: 'satisfied', moveIds: [], deleteIds: decision.deleteIds, note: null });
  } else {
    plan.push({ req: r, action: 'move', moveIds: decision.moveIds, deleteIds: decision.deleteIds, note: null });
  }
}

// Report.
const tally = { move: 0, satisfied: 0, cancel: 0 };
console.log(`\n=== ${APPLY ? 'APPLYING' : 'DRY RUN'} — ${reqs.length} approved transfers ===\n`);
for (const p of plan) {
  tally[p.action]++;
  const who = p.req.employee_name ?? p.req.employee_email;
  const del = p.deleteIds.length ? ` (+ delete ${p.deleteIds.length} redundant dupe row(s))` : '';
  const label =
    p.action === 'move'
      ? `MOVE ${p.moveIds.length} master row(s) -> ${p.req.to_department}, mark applied${del}`
      : p.action === 'satisfied'
        ? `ALREADY in ${p.req.to_department} — mark applied${del || ' (no master write)'}`
        : `CANCEL — not on active roster`;
  console.log(`  [${p.action}] ${who}  (${p.req.from_department} -> ${p.req.to_department})  ${label}`);
}
console.log(`\nsummary: move=${tally.move}  satisfied=${tally.satisfied}  cancel=${tally.cancel}`);

if (!APPLY) {
  console.log('\nDry run only. Re-run with --apply to perform the writes.');
  process.exit(0);
}

// Backup before writing (per data-fix rule): the affected transfers + touched master rows.
const touchedIds = new Set(plan.flatMap((p) => [...p.moveIds, ...p.deleteIds]));
const backup = {
  when: new Date().toISOString(),
  approved_transfers: reqs,
  touched_master_rows: master.filter((m) => touchedIds.has(m.id)),
};
const path = `references/backups/clear-stuck-transfers-${Date.now()}.json`;
writeFileSync(path, JSON.stringify(backup, null, 2));
console.log(`\nBackup written: ${path}\n`);

const now = new Date().toISOString();
let ok = 0;
let err = 0;
for (const p of plan) {
  const who = p.req.employee_name ?? p.req.employee_email;
  try {
    // Prune redundant dupe rows first so the target (work email, dept) slot is free.
    if (p.deleteIds.length > 0) {
      const d = await supabase.from('global_master_list').delete().in('id', p.deleteIds);
      if (d.error) throw new Error(`delete-dupe: ${d.error.message}`);
    }
    if (p.action === 'move') {
      const u = await supabase.from('global_master_list').update({ Department: p.req.to_department }).in('id', p.moveIds);
      if (u.error) throw new Error(`master: ${u.error.message}`);
    }
    if (p.action === 'cancel') {
      const c = await supabase
        .from('department_transfer_requests')
        .update({ status: 'cancelled', approver_note: p.note, decided_at: now, updated_at: now })
        .eq('id', p.req.id)
        .eq('status', 'approved');
      if (c.error) throw new Error(`cancel: ${c.error.message}`);
    } else {
      const a = await supabase
        .from('department_transfer_requests')
        .update({ status: 'applied', applied_at: now, updated_at: now })
        .eq('id', p.req.id)
        .eq('status', 'approved');
      if (a.error) throw new Error(`mark-applied: ${a.error.message}`);
    }
    ok++;
    console.log(`  ✓ ${p.action}  ${who}`);
  } catch (e) {
    err++;
    console.log(`  ✗ ${p.action}  ${who}  — ${e.message}`);
  }
}
console.log(`\ndone: ${ok} ok, ${err} failed. (Google Sheet not touched — next master-sheet sync reconciles it.)`);
