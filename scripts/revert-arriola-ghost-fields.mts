/**
 * Revert the three fields written onto Mark Arriola's GHOST master row through
 * People on 2026-10-06 16:27Z (audit items 364 → 384; Kane's ruling (a), 2026-10-07).
 *
 * `global_master_list` 327a7857 is the name-in-email ghost of 5dba371f
 * (`marka@simple.biz`, off-boarded 2026-07-16 ncns). At 16:27:28Z jakec@ wrote
 * Work Email `marka@simple.biz`, Personal Email `markarriola.sos@gmail.com` and
 * Alternate Work Email `tony@simple.biz.` onto it (`people.profile.updated`,
 * `app/api/people/[email]/profile/route.ts`). Those are the real row's addresses.
 * Kane ruled to put them back, then retire the ghost with
 * `stamp-arriola-ghost-row.mts`, whose guards need the ghost's original shape.
 *
 * ## What it writes
 *
 * ONE row, THREE columns, back to the values in the pre-edit backup
 * `docs/audits/backups/2026-10-06T14-04-17-601Z-arriola-ghost-stamp.json`:
 *   - `Work Email`           → null
 *   - `Personal Email`       → `arriola, mark anthony  "mark"` (the name)
 *   - `Alternate Work Email` → null
 *
 * It does NOT touch `off_boarded_*` (whoever stamped the row keeps their stamp),
 * the Google master sheet (the ghost is not on it; the 16:27Z sheet write landed
 * on the real row's line with the values it already had), the offboarding
 * queue, `offboarded_sheet`, or the 09-20 ₱750 (Kane's money ruling).
 *
 * ## What stops it clobbering a later change
 *
 * Every check must pass, and any read that fails REFUSES `--apply`:
 *   1. the pre-edit backup is a plan-run backup of THIS row, taken before 16:27Z,
 *   2. the audit trail holds exactly one People edit of the row, at 16:27Z, and its
 *      before/after agree with the backup and with what is written below,
 *   3. the live row still holds exactly what the 16:27Z edit wrote,
 *   4. the live stamp is one this script was written against (unstamped, or
 *      jakec@'s 2026-10-07 13:28:39Z `ncns` offboard); anything else is new,
 *   5. the real row 5dba371f keeps the three addresses, so they are not stranded.
 * The UPDATE repeats 3 and 4 as filters, so a change between read and write
 * matches 0 rows and fails. Filters are `.eq`, never `.in()`: a name key inside
 * `.in()` silently matches 0 rows (gml-roster-source-of-truth.md).
 *
 * READ-ONLY WITHOUT A FLAG. `--apply` writes, and `--revert <backup>` puts back
 * the three values an `--apply` backup recorded. Both write a SELECT backup to
 * `docs/audits/backups/` (gitignored) first.
 *
 * Usage (PowerShell):
 *   node --import tsx scripts/revert-arriola-ghost-fields.mts                  # plan only
 *   node --import tsx scripts/revert-arriola-ghost-fields.mts --apply          # revert
 *   node --import tsx scripts/revert-arriola-ghost-fields.mts --revert <file>  # undo an --apply
 */
import dotenv from 'dotenv';
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
dotenv.config({ path: '.env.local' });
dotenv.config();

const APPLY = process.argv.includes('--apply');
const revertAt = process.argv.indexOf('--revert');
const REVERT_FILE = revertAt === -1 ? null : process.argv[revertAt + 1] ?? '';
if (APPLY && REVERT_FILE !== null) {
  console.error('Pass --apply or --revert <backup>, not both.');
  process.exit(1);
}
if (REVERT_FILE === '' || REVERT_FILE?.startsWith('--')) {
  console.error('--revert needs the path of the backup an --apply run wrote.');
  process.exit(1);
}

const GHOST_ID = '327a7857-eddd-491f-886c-f0058c6cb45b';
const REAL_ID = '5dba371f-1e72-45e5-a1a9-f678601ea01c';
const PRE_EDIT_BACKUP = 'docs/audits/backups/2026-10-06T14-04-17-601Z-arriola-ghost-stamp.json';
const EDIT_AT = '2026-10-06T16:27:28';
const EDIT_BY = 'jakec@simple.biz';
const COLS = ['Work Email', 'Personal Email', 'Alternate Work Email'] as const;
type Col = (typeof COLS)[number];
type Fields = Record<Col, string | null>;
/** People's patch keys for the same columns, as the audit row records them. */
const AUDIT_FIELD: Record<Col, string> = {
  'Work Email': 'work_email',
  'Personal Email': 'personal_email',
  'Alternate Work Email': 'alternate_work_email',
};
/** Exactly what the 16:27Z edit wrote (audit 96c1d34c). */
const EDIT_WROTE: Fields = {
  'Work Email': 'marka@simple.biz',
  'Personal Email': 'markarriola.sos@gmail.com',
  'Alternate Work Email': 'tony@simple.biz.',
};
/**
 * The stamps this script was written against. Measured 2026-10-07: jakec@
 * completed Jackie's queue row badf971b at 13:28:39Z, which stamped the ghost
 * through `/api/hr/offboard` by its new `marka@`. Any other stamp means someone
 * acted again since, and the plan has to be re-read before writing.
 */
const KNOWN_STAMPS: Array<{ at: string | null; by: string | null; reason: string | null }> = [
  { at: null, by: null, reason: null },
  { at: '2026-10-07T13:28:39.316+00:00', by: EDIT_BY, reason: 'ncns' },
];

const { createSupabaseServiceRoleClient } = await import('../src/lib/supabase/server');
const sb = createSupabaseServiceRoleClient();
if (!sb) {
  console.error('Supabase is not configured (.env.local)');
  process.exit(1);
}

const mode = APPLY ? 'APPLY' : REVERT_FILE !== null ? 'REVERT' : 'PLAN (read-only)';
console.log(`${mode} · ghost ${GHOST_ID.slice(0, 8)} · three fields from the ${EDIT_AT}Z People edit\n`);

const failures: string[] = [];
const check = (ok: boolean, label: string) => {
  console.log(`  ${ok ? 'ok  ' : 'FAIL'}  ${label}`);
  if (!ok) failures.push(label);
};
const val = (v: unknown): string | null => (typeof v === 'string' ? v : v == null ? null : String(v));
const pick = (row: Record<string, unknown>): Fields =>
  Object.fromEntries(COLS.map((c) => [c, val(row[c])])) as Fields;
const same = (a: Fields, b: Fields) => COLS.every((c) => a[c] === b[c]);
const show = (v: string | null) => (v === null ? 'null' : JSON.stringify(v));

const ghostRead = await sb.from('global_master_list').select('*').eq('id', GHOST_ID).maybeSingle();
const realRead = await sb.from('global_master_list').select('*').eq('id', REAL_ID).maybeSingle();
if (ghostRead.error || realRead.error || !ghostRead.data || !realRead.data) {
  console.error(`Master read failed: ${ghostRead.error?.message ?? realRead.error?.message ?? 'row missing'}`);
  process.exit(1);
}
const ghost = ghostRead.data as Record<string, unknown>;
const real = realRead.data as Record<string, unknown>;
const live = pick(ghost);

// The SELECT backup, before anything else can write. CLAUDE.md § Data.
const dir = join(process.cwd(), 'docs', 'audits', 'backups');
mkdirSync(dir, { recursive: true });
const backupPath = join(dir, `${new Date().toISOString().replace(/[:.]/g, '-')}-arriola-ghost-fields.json`);
writeFileSync(backupPath, JSON.stringify({ mode, takenAt: new Date().toISOString(), ghost, real }, null, 2), 'utf8');
console.log(`Backup written: ${backupPath}\n`);

// What the target values are, and what the row must hold now for the write to land.
let from: Fields;
let to: Fields;

if (REVERT_FILE !== null) {
  // ── --revert: put back what an --apply backup recorded ─────────────────────
  let applied: { mode?: string; ghost?: Record<string, unknown> };
  try {
    applied = JSON.parse(readFileSync(REVERT_FILE, 'utf8'));
  } catch (e) {
    console.error(`Cannot read ${REVERT_FILE}: ${e instanceof Error ? e.message : e}`);
    process.exit(1);
  }
  console.log('guards:');
  check(applied.mode === 'APPLY', `backup is from an --apply run (mode = ${applied.mode ?? 'missing'})`);
  check(applied.ghost?.id === GHOST_ID, `backup is of the ghost row (${String(applied.ghost?.id ?? 'missing').slice(0, 8)})`);
  to = applied.ghost ? pick(applied.ghost) : EDIT_WROTE;
  check(same(to, EDIT_WROTE), 'backup holds what the 16:27Z edit wrote');
  // What --apply leaves behind is the pre-edit shape.
  from = { 'Work Email': null, 'Personal Email': val(ghost['Personal Email']), 'Alternate Work Email': null };
  check(live['Work Email'] === null && live['Alternate Work Email'] === null, 'live row has no Work Email and no Alternate (the --apply state)');
  check(!!live['Personal Email'] && !live['Personal Email'].includes('@'), `live Personal Email is the name (${show(live['Personal Email'])})`);
} else {
  // ── plan / --apply ─────────────────────────────────────────────────────────
  console.log('guards:');

  // 1. The pre-edit backup is a plan run of this row, taken before the edit.
  let pre: { mode?: string; takenAt?: string; ghost?: Record<string, unknown> } = {};
  try {
    pre = JSON.parse(readFileSync(PRE_EDIT_BACKUP, 'utf8'));
  } catch (e) {
    check(false, `pre-edit backup readable (${e instanceof Error ? e.message : e})`);
  }
  check(pre.mode === 'PLAN (read-only)', `pre-edit backup is a plan run (${pre.mode ?? 'missing'})`);
  check(pre.ghost?.id === GHOST_ID, `pre-edit backup is of the ghost row (${String(pre.ghost?.id ?? 'missing').slice(0, 8)})`);
  check(!!pre.takenAt && pre.takenAt < EDIT_AT, `pre-edit backup predates the edit (${pre.takenAt ?? 'missing'} < ${EDIT_AT}Z)`);
  to = pre.ghost ? pick(pre.ghost) : { 'Work Email': null, 'Personal Email': null, 'Alternate Work Email': null };
  check(
    to['Work Email'] === null && to['Alternate Work Email'] === null && !!to['Personal Email'] && !to['Personal Email'].includes('@'),
    `pre-edit values are the ghost's shape (no Work Email, a name in Personal Email ${show(to['Personal Email'])}, no Alternate)`,
  );
  from = EDIT_WROTE;

  // 2. One People edit, at 16:27Z, whose before/after agree with the backup and EDIT_WROTE.
  const audit = await sb
    .from('audit_log')
    .select('created_at, user_name, details')
    .eq('resource_id', GHOST_ID)
    .eq('action', 'people.profile.updated');
  if (audit.error) check(false, `audit_log readable (${audit.error.message})`);
  else {
    const rows = (audit.data ?? []) as Array<{ created_at: string; user_name: string; details: { changes?: Array<{ field: string; before: unknown; after: unknown }> } }>;
    check(rows.length === 1, `exactly one People edit of the ghost on record (${rows.length} found)`);
    const edit = rows[0];
    check(!!edit && edit.created_at.startsWith(EDIT_AT) && edit.user_name === EDIT_BY, `that edit is ${EDIT_BY} at ${EDIT_AT}Z (${edit ? `${edit.user_name} ${edit.created_at}` : 'none'})`);
    const changes = edit?.details?.changes ?? [];
    const byField = new Map(changes.map((c) => [c.field, c]));
    check(
      changes.length === COLS.length &&
        COLS.every((c) => {
          const ch = byField.get(AUDIT_FIELD[c]);
          return !!ch && val(ch.before) === to[c] && val(ch.after) === EDIT_WROTE[c];
        }),
      'its before = the backup and its after = the values this script reverts',
    );
  }

  // 3. The live row still holds exactly what the edit wrote.
  for (const c of COLS) check(live[c] === EDIT_WROTE[c], `live ${c} is still the edit's ${show(EDIT_WROTE[c])} (${show(live[c])})`);
}

// 4. The stamp is one this script was written against.
const stamp = { at: val(ghost.off_boarded_at), by: val(ghost.off_boarded_by), reason: val(ghost.off_boarded_reason) };
check(
  KNOWN_STAMPS.some((k) => k.at === stamp.at && k.by === stamp.by && k.reason === stamp.reason),
  `ghost stamp is a known state (${stamp.at ? `${stamp.at} ${stamp.reason} by ${stamp.by}` : 'unstamped'})`,
);

// 5. The real row keeps the three addresses.
check(same(pick(real), EDIT_WROTE), `real row ${REAL_ID.slice(0, 8)} holds the same three addresses`);

// The UPDATE's own filters, read first. A filter that silently matches 0 rows
// (the `.in()` name-key trap) would otherwise only show up as a failed write.
// The write below repeats this chain filter for filter.
let probeQuery = sb.from('global_master_list').select('id').eq('id', GHOST_ID);
for (const c of COLS) {
  const v = from[c];
  probeQuery = v === null ? probeQuery.is(`"${c}"`, null) : probeQuery.eq(`"${c}"`, v);
}
probeQuery = stamp.at === null ? probeQuery.is('off_boarded_at', null) : probeQuery.eq('off_boarded_at', stamp.at);
const probe = await probeQuery;
if (probe.error) check(false, `write filter readable (${probe.error.message})`);
else check((probe.data ?? []).length === 1, `the write's filter matches exactly this row (${(probe.data ?? []).length} matched)`);

console.log(`\nWOULD WRITE ${GHOST_ID} (three columns, nothing else):`);
for (const c of COLS) console.log(`  ${c.padEnd(21)} ${show(live[c])}  →  ${show(to[c])}`);
console.log(`  off_boarded_*         untouched (${stamp.at ? `${stamp.at} ${stamp.reason} by ${stamp.by}` : 'unstamped'})`);

if (failures.length > 0) {
  console.error(`\nREFUSING: ${failures.length} guard(s) failed. Nothing written.`);
  process.exit(1);
}
if (!APPLY && REVERT_FILE === null) {
  console.log('\nPLAN ONLY — nothing written. Re-run with --apply to revert the three fields.');
  process.exit(0);
}

// ── Write ────────────────────────────────────────────────────────────────────
let writeQuery = sb.from('global_master_list').update(to).eq('id', GHOST_ID);
for (const c of COLS) {
  const v = from[c];
  writeQuery = v === null ? writeQuery.is(`"${c}"`, null) : writeQuery.eq(`"${c}"`, v);
}
writeQuery = stamp.at === null ? writeQuery.is('off_boarded_at', null) : writeQuery.eq('off_boarded_at', stamp.at);
const { data, error } = await writeQuery.select('*');
if (error || (data ?? []).length !== 1) {
  console.error(`\nWrite failed: ${error?.message ?? `${(data ?? []).length} rows matched, expected 1`}`);
  process.exit(1);
}

// Prove only the three columns moved.
const after = (data as Record<string, unknown>[])[0];
const moved = Object.keys({ ...ghost, ...after }).filter((k) => JSON.stringify(ghost[k]) !== JSON.stringify(after[k]));
const expected = COLS.filter((c) => live[c] !== to[c]);
const exact = moved.length === expected.length && expected.every((c) => moved.includes(c));
console.log(`\nWritten. Columns changed: ${moved.join(', ') || 'none'}${exact ? '' : '  ← NOT the three expected, check the backup'}`);
for (const c of COLS) console.log(`  ${c.padEnd(21)} ${show(val(after[c]))}`);
console.log(
  REVERT_FILE === null
    ? `Undo: node --import tsx scripts/revert-arriola-ghost-fields.mts --revert ${backupPath}`
    : 'Reverted to the --apply backup.',
);
if (!exact) process.exit(1);
