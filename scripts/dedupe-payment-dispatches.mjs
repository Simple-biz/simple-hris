/**
 * Remove duplicate `paid` rows from payment_dispatches — the same person logged
 * paid more than once in the same cycle.
 *
 *   node scripts/dedupe-payment-dispatches.mjs            # dry run: report + backup only
 *   node scripts/dedupe-payment-dispatches.mjs --apply    # delete the echoes
 *
 * BACKGROUND (2026-09-03). Until the server-side guard landed the same day, a
 * stale dispatch-queue reload could paint a just-paid person back into Pending;
 * the clerk marked them again and a second identical `paid` row was written.
 * 82 people across five cycles (2026-07-26 … 2026-08-23), ₱992,843 of phantom
 * "paid" money in the log; cobb@ was the reported case.
 *
 * WHAT IS A DUPLICATE HERE. Employee rows (payee_type employee / absent) with
 * status 'paid', the same cycle (cycle_source_file, else cycle_id) and the same
 * email (case-insensitive) — AND identical transaction_id, amount_php and
 * amount_usd. Only then is the later row an echo of the same payment.
 *
 * WHAT IS NOT. A group whose rows carry DIFFERENT transaction ids or amounts is
 * reported as DIVERGENT and left alone: two processor references mean the money
 * may genuinely have moved twice, and deleting a row would hide the evidence.
 * (alonzos@, 07-26 cycle, two Hurupay txn ids 82 s apart — verify in Hurupay.)
 *
 * WHICH ROW SURVIVES. The OLDEST — it marks the moment the money moved; every
 * later row is the echo. Same rule the API guard uses (findDuplicatePaid).
 *
 * WHY THE KEPT ROW IS TOUCHED AFTER THE DELETE. The AFTER INSERT trigger pointed
 * disbursement_records.dispatch_id at the NEWEST row (the echo), and the AFTER
 * DELETE trigger reverts the disbursement record to 'pending' when the row it
 * points to is deleted. A no-op UPDATE on the surviving row re-fires the sync
 * trigger, which re-marks the disbursement record paid and re-points it.
 *
 * AUDIT. One `payment.undone` event per deleted row (the same shape the Undo
 * route writes) tagged reason 'duplicate_paid_row' and the kept row's id — the
 * deleted rows' only surviving record besides the backup JSON.
 *
 * SAFE BY DEFAULT: dry-run. ALWAYS writes a backup JSON of every duplicate group
 * (full rows) to references/backups/ before anything else, apply or not.
 */
import { createClient } from '@supabase/supabase-js';
import dotenv from 'dotenv';
import { mkdirSync, writeFileSync } from 'node:fs';

dotenv.config({ path: '.env.local' });
dotenv.config();

const APPLY = process.argv.includes('--apply');
const ACTOR = 'kaner@simple.biz (dedupe-payment-dispatches)';

const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
if (!url || !key) {
  console.error('Missing NEXT_PUBLIC_SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY');
  process.exit(1);
}
const sb = createClient(url, key, { auth: { persistSession: false, autoRefreshToken: false } });

// ── 1. Read everything (paged — PostgREST caps at 1,000 rows) ────────────────
// Ordered by (created_at, id): created_at alone is NOT a total order — the June
// backfill wrote ~800 rows with one identical timestamp, and paging over ties
// without a tiebreaker can return the same row on two pages (a phantom
// "duplicate" that a dedupe would then DELETE). The id tiebreaker makes pages
// deterministic; the Map de-dupes by id as a second line of defence and the
// count is asserted so a repeated fetch can never masquerade as a duplicate row.
async function selectAllPaged(table, columns) {
  const byId = new Map();
  let fetched = 0;
  for (let from = 0; ; from += 1000) {
    const { data, error } = await sb
      .from(table)
      .select(columns)
      .order('created_at', { ascending: true })
      .order('id', { ascending: true })
      .range(from, from + 999);
    if (error) throw new Error(`${table}: ${error.message}`);
    for (const r of data ?? []) byId.set(r.id, r);
    fetched += data?.length ?? 0;
    if (!data || data.length < 1000) break;
  }
  if (fetched !== byId.size) {
    throw new Error(`${table}: paging returned ${fetched} rows but only ${byId.size} distinct ids — unstable page order, refusing to continue`);
  }
  return [...byId.values()];
}

const all = await selectAllPaged('payment_dispatches', '*');
console.log(`payment_dispatches rows: ${all.length}`);

// ── 2. Group paid employee rows by (cycle, email) ────────────────────────────
const cycleKey = (r) => (r.cycle_source_file && r.cycle_source_file.trim()) || (r.cycle_id ? `cycle:${r.cycle_id}` : null);
const groups = new Map();
for (const r of all) {
  if (r.status !== 'paid') continue;
  if ((r.payee_type ?? 'employee') !== 'employee') continue;
  const ck = cycleKey(r);
  if (!ck) continue;
  const k = `${ck}|${r.recipient_email.trim().toLowerCase()}`;
  if (!groups.has(k)) groups.set(k, []);
  groups.get(k).push(r);
}

const identical = []; // { keep, remove[] }
const divergent = []; // rows[]
for (const rows of groups.values()) {
  if (rows.length < 2) continue;
  rows.sort((a, b) => a.created_at.localeCompare(b.created_at) || a.id.localeCompare(b.id));
  const sig = (r) => `${r.transaction_id}|${r.amount_php}|${r.amount_usd}`;
  const same = rows.every((r) => sig(r) === sig(rows[0]));
  if (same) identical.push({ keep: rows[0], remove: rows.slice(1) });
  else divergent.push(rows);
}

// ── 3. Backup FIRST (always) ─────────────────────────────────────────────────
mkdirSync('references/backups', { recursive: true });
const backupPath = `references/backups/dedupe-payment-dispatches-${Date.now()}.json`;
writeFileSync(
  backupPath,
  JSON.stringify(
    {
      taken_at: new Date().toISOString(),
      apply: APPLY,
      rule: 'employee paid rows, same cycle (source file else cycle_id) + email, identical txn/amount_php/amount_usd → keep OLDEST, delete later',
      identical_groups: identical,
      divergent_groups_left_alone: divergent,
    },
    null,
    2,
  ),
);
console.log(`backup written: ${backupPath}`);

// ── 4. Report ────────────────────────────────────────────────────────────────
const removeAll = identical.flatMap((g) => g.remove);
const phantomPhp = removeAll.reduce((s, r) => s + Number(r.amount_php ?? 0), 0);
console.log(`\nidentical duplicate groups: ${identical.length} → rows to delete: ${removeAll.length} (₱${Math.round(phantomPhp).toLocaleString('en-PH')} phantom)`);
const perCycle = new Map();
for (const g of identical) perCycle.set(cycleKey(g.keep), (perCycle.get(cycleKey(g.keep)) ?? 0) + g.remove.length);
for (const [c, n] of [...perCycle].sort()) console.log(`  ${String(n).padStart(3)}  ${c}`);
console.log(`\nDIVERGENT groups (left alone — verify with the processor):`);
for (const rows of divergent) {
  console.log(`  ${rows[0].cycle_source_file} | ${rows[0].recipient_email}`);
  for (const r of rows) console.log(`     ${r.created_at.slice(0, 19)} ${r.created_by} txn=${r.transaction_id || '(blank)'} php=${r.amount_php} bank=${r.bank_used}`);
}
if (divergent.length === 0) console.log('  none');

if (!APPLY) {
  console.log('\nDRY RUN — nothing deleted. Re-run with --apply to remove the rows above.');
  process.exit(0);
}

// ── 5. Apply: delete echoes, re-touch survivors, audit ───────────────────────
console.log('\nAPPLYING…');
let deleted = 0;
const failures = [];
for (const g of identical) {
  const ids = g.remove.map((r) => r.id);
  const { data: gone, error: delErr } = await sb.from('payment_dispatches').delete().in('id', ids).select('id');
  if (delErr) {
    failures.push({ keep: g.keep.id, ids, error: delErr.message });
    console.error(`  ✗ delete failed for ${g.keep.recipient_email}: ${delErr.message}`);
    continue;
  }
  deleted += gone?.length ?? 0;

  // Re-fire the INSERT/UPDATE sync trigger on the survivor so the disbursement
  // record (which the DELETE trigger just reverted to pending, if it pointed at
  // an echo) reads paid again and points at the kept row.
  const { error: touchErr } = await sb.from('payment_dispatches').update({ note: g.keep.note ?? null }).eq('id', g.keep.id);
  if (touchErr) {
    failures.push({ keep: g.keep.id, ids, error: `touch: ${touchErr.message}` });
    console.error(`  ✗ re-touch failed for ${g.keep.recipient_email}: ${touchErr.message}`);
  }

  const events = g.remove.map((row) => ({
    user_name: ACTOR,
    user_role: 'admin',
    action: 'payment.undone',
    resource: 'payment_dispatches',
    resource_id: row.id,
    details: {
      reason: 'duplicate_paid_row',
      kept_dispatch_id: g.keep.id,
      script: 'scripts/dedupe-payment-dispatches.mjs',
      backup: backupPath,
      recipient_email: row.recipient_email,
      recipient_name: row.recipient_name,
      processor: row.processor,
      amount_usd: row.amount_usd,
      amount_php: row.amount_php,
      amount_cop: row.amount_cop,
      transaction_id: row.transaction_id,
      bank_used: row.bank_used,
      sent_date: row.sent_date,
      original_status: row.status,
      note: row.note,
      payee_type: row.payee_type ?? 'employee',
      contractor_invoice_id: row.contractor_invoice_id ?? null,
      originally_paid_by: row.created_by,
      originally_paid_at: row.created_at,
      cycle: {
        cycle_id: row.cycle_id,
        source_file: row.cycle_source_file,
        period_start: row.cycle_period_start,
        period_end: row.cycle_period_end,
      },
    },
  }));
  const { error: auditErr } = await sb.from('audit_log').insert(events);
  if (auditErr) {
    failures.push({ keep: g.keep.id, ids, error: `audit: ${auditErr.message}` });
    console.error(`  ✗ audit insert failed for ${g.keep.recipient_email}: ${auditErr.message}`);
  }
}
console.log(`deleted ${deleted} rows; failures: ${failures.length}`);

// ── 6. Verify ────────────────────────────────────────────────────────────────
console.log('\nVERIFY');
const after = await selectAllPaged('payment_dispatches', 'id,cycle_id,cycle_source_file,recipient_email,status,payee_type,transaction_id,amount_php,amount_usd');
const g2 = new Map();
for (const r of after) {
  if (r.status !== 'paid' || (r.payee_type ?? 'employee') !== 'employee') continue;
  const ck = cycleKey(r);
  if (!ck) continue;
  const k = `${ck}|${r.recipient_email.trim().toLowerCase()}`;
  g2.set(k, (g2.get(k) ?? 0) + 1);
}
const remaining = [...g2.values()].filter((n) => n > 1).length;
console.log(`  remaining (cycle,email) groups with >1 paid row: ${remaining} (expected ${divergent.length} — the divergent ones)`);

let mirrorOk = 0;
const mirrorBad = [];
for (const g of identical) {
  const k = g.keep;
  if (!k.cycle_source_file) continue;
  const { data: dr } = await sb
    .from('disbursement_records')
    .select('status,dispatch_id,transaction_id')
    .eq('source_file', k.cycle_source_file)
    .ilike('recipient_email', k.recipient_email)
    .maybeSingle();
  if (!dr) continue; // no disbursement record for this week (never seeded) — nothing to mirror
  if (dr.status === 'paid' && dr.dispatch_id === k.id) mirrorOk += 1;
  else mirrorBad.push({ email: k.recipient_email, file: k.cycle_source_file, dr });
}
console.log(`  disbursement_records re-pointed at the kept row: ${mirrorOk} ok, ${mirrorBad.length} bad`);
for (const b of mirrorBad) console.log('   ✗', b.email, b.file, JSON.stringify(b.dr));

if (failures.length || mirrorBad.length || remaining !== divergent.length) {
  console.error('\nVERIFY FAILED — see above. Backup:', backupPath);
  process.exit(2);
}
console.log('\nDONE. Backup:', backupPath);
