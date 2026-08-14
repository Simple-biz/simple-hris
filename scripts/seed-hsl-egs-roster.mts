/**
 * Seed the KPI roster for the new roster-only HSL sub-team
 * `executive_guest_services` (see docs/features/hsl-subdepartments.md §7a —
 * the noKpi variant, added 2026-08-14 per Kane: "Lets add these please").
 *
 * WHAT IT DOES. Sets `hsl_team_members.dept_key = 'executive_guest_services'`
 * on the rows whose Hogan-sheet role already names the team but that are
 * assigned to NO sub-team today (`dept_key IS NULL`) — measured 2026-08-14 as
 * 29x "Executive Guest Services" + 2 Team Captain variants. Setting dept_key
 * is what makes them visible in the team's KPI Calculator card and the
 * Payroll Wizard HSL rail bucket. It is NOT a pay write: pay routes on the
 * master `Department` cell, and the dept has no scoring rules (noKpi), so no
 * bonus can be computed from this either.
 *
 * DELIBERATELY LEFT ALONE (reported, never moved):
 *   - Rows whose role matches but that already carry a dept_key (2 sat under
 *     `collections` on 2026-08-14: jaya@, syr@). Re-keying them MOVES them out
 *     of the calculator that scores them today — that is a scoring decision
 *     for Kane/Carla, not a seed.
 *   - "Guest Services Manager" (arr@) — a different role string; managers are
 *     scored under the bespoke Managers Weekly program, not a team roster.
 *     Reported so Kane can decide.
 *
 * GUARDS (fail closed):
 *   1. Key validity — imports HSL_DEPT_KEYS + HSL_DEPTS from the actual code;
 *      refuses to run unless `executive_guest_services` exists AND is noKpi
 *      (this script must never quietly enrol people into a SCORED dept).
 *   2. NULL-only — the UPDATE re-asserts `dept_key IS NULL`, so a row another
 *      process assigned between read and write is skipped, never clobbered.
 *   3. By proven key — updates exactly the emails proven eligible in the read
 *      (`hsl_team_members` is keyed by email; the sheet sync upserts by
 *      LOWER(email)), never a role_raw filter evaluated at write time
 *      (§7c lesson: write to the rows you proved).
 *   4. Backup first — full hsl_team_members dump to reports/ before any write
 *      (CLAUDE.md: a SELECT backup on disk precedes every bulk UPDATE).
 *
 * Rows keep their existing upload_id (we touch dept_key only), so
 * active_hsl_agents visibility is unchanged.
 *
 * USAGE
 *   node --import tsx scripts/seed-hsl-egs-roster.mts           # dry run
 *   node --import tsx scripts/seed-hsl-egs-roster.mts --apply   # writes
 */
import { createClient } from '@supabase/supabase-js';
import { mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import dotenv from 'dotenv';

dotenv.config({ path: '.env.local' });
dotenv.config();

const APPLY = process.argv.includes('--apply');
const TABLE = 'hsl_team_members';
const AUDIT_TABLE = 'audit_log'; // singular — see src/lib/supabase/audit-log.ts:136
const ACTOR = 'kaner@simple.biz';
const TARGET_KEY = 'executive_guest_services';
/** Prefix match, so "...Team Capt"/"...Team Captain" ride along; "Guest
 *  Services Manager" does NOT start with this and is deliberately excluded. */
const ROLE_PREFIX = 'executive guest services';

const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
if (!url || !serviceKey) {
  console.error('FATAL: need NEXT_PUBLIC_SUPABASE_URL + SUPABASE_SERVICE_ROLE_KEY in .env.local');
  process.exit(1);
}
const db = createClient(url, serviceKey, { auth: { persistSession: false } });

const die = (msg: string): never => {
  console.error(`\nABORTED — ${msg}`);
  process.exit(1);
};

interface RosterRow {
  email: string | null;
  full_name: string | null;
  role_raw: string | null;
  dept_key: string | null;
  upload_id: string | null;
}

/** PostgREST caps every read at 1000 rows even with .range() — always page. */
async function selectAllPaged<T>(table: string, cols: string): Promise<T[]> {
  const out: T[] = [];
  const SIZE = 1000;
  for (let from = 0; ; from += SIZE) {
    const { data, error } = await db
      .from(table)
      .select(cols)
      .order('email', { ascending: true })
      .range(from, from + SIZE - 1);
    if (error) die(`reading ${table}: ${error.message}`);
    const rows = (data ?? []) as T[];
    out.push(...rows);
    if (rows.length < SIZE) break;
  }
  return out;
}

console.log(`\n${APPLY ? '=== APPLY ===' : '=== DRY RUN (pass --apply to write) ==='}\n`);

// ── Guard 1: the target key is a real, roster-only KPI dept in the code ──────
{
  const mod = await import('../src/lib/hsl-bonus/schema.js').catch((e: unknown) =>
    die(`could not import HSL_DEPT_KEYS from src/lib/hsl-bonus/schema: ${String(e)}`),
  );
  const { HSL_DEPT_KEYS, HSL_DEPTS } = mod as {
    HSL_DEPT_KEYS?: readonly string[];
    HSL_DEPTS?: Record<string, { noKpi?: boolean; rules?: unknown[] }>;
  };
  if (!HSL_DEPT_KEYS?.includes(TARGET_KEY)) {
    die(`"${TARGET_KEY}" is not in HSL_DEPT_KEYS — ship the code first (§7a), then seed.`);
  }
  const cfg = HSL_DEPTS?.[TARGET_KEY];
  if (!cfg?.noKpi || (cfg.rules?.length ?? 0) !== 0) {
    die(
      `"${TARGET_KEY}" is not a noKpi/rules-less dept in the code — this seed only enrols ` +
        'people into a roster-only team. A scored dept needs a deliberate roster decision.',
    );
  }
  console.log(`Guard 1/4  key valid ................... ${TARGET_KEY} exists in HSL_DEPT_KEYS and is roster-only (noKpi)`);
}

// ── Read + partition ─────────────────────────────────────────────────────────
const all = await selectAllPaged<RosterRow>(TABLE, 'email, full_name, role_raw, dept_key, upload_id');
const roleMatches = all.filter((r) => (r.role_raw ?? '').trim().toLowerCase().startsWith(ROLE_PREFIX));
const eligible = roleMatches.filter((r) => r.dept_key == null && !!r.email);
const noEmail = roleMatches.filter((r) => r.dept_key == null && !r.email);
const alreadyAssigned = roleMatches.filter((r) => r.dept_key != null && r.dept_key !== TARGET_KEY);
const alreadyDone = roleMatches.filter((r) => r.dept_key === TARGET_KEY);
const managerRows = all.filter((r) => /guest services manager/i.test((r.role_raw ?? '').trim()));

console.log(`\n${TABLE}: ${all.length} rows total, ${roleMatches.length} match role prefix "${ROLE_PREFIX}"`);
console.log(`\nELIGIBLE (dept_key NULL -> '${TARGET_KEY}'): ${eligible.length}`);
for (const r of eligible) console.log(`  ${(r.email ?? '?').padEnd(32)} ${r.role_raw}`);
console.log(`\nLEFT ALONE — already scored elsewhere (Kane/Carla's call to move): ${alreadyAssigned.length}`);
for (const r of alreadyAssigned) console.log(`  ${(r.email ?? '?').padEnd(32)} ${r.role_raw}  dept_key=${r.dept_key}`);
console.log(`\nLEFT ALONE — "Guest Services Manager" (different role, likely the manager): ${managerRows.length}`);
for (const r of managerRows) console.log(`  ${(r.email ?? '?').padEnd(32)} ${r.role_raw}  dept_key=${r.dept_key ?? 'NULL'}`);
if (noEmail.length) {
  console.log(`\nLEFT ALONE — no email on the row (cannot key the update): ${noEmail.length}`);
  for (const r of noEmail) console.log(`  ${(r.full_name ?? '?').padEnd(32)} ${r.role_raw}`);
}
if (alreadyDone.length) console.log(`\nAlready on ${TARGET_KEY} (idempotent no-op): ${alreadyDone.length}`);

if (!eligible.length) {
  console.log('\nNothing to do — every matching row already has a dept_key.');
  process.exit(0);
}

// ── Guard 4: backup before any write ─────────────────────────────────────────
const stamp = new Date().toISOString().replace(/[:.]/g, '-');
const backupPath = path.join('reports', `backup_hsl_team_members_${stamp}.json`);
mkdirSync('reports', { recursive: true });
writeFileSync(backupPath, JSON.stringify(all, null, 2));
console.log(`\nGuard 4/4  backup written .............. ${backupPath} (${all.length} rows)`);

if (!APPLY) {
  console.log(`\nDRY RUN — would set dept_key='${TARGET_KEY}' on the ${eligible.length} eligible row(s) above.`);
  process.exit(0);
}

// ── Write: by proven email, NULL re-asserted ─────────────────────────────────
const emails = eligible.map((r) => r.email!);
const { data: updated, error: updErr } = await db
  .from(TABLE)
  .update({ dept_key: TARGET_KEY })
  .in('email', emails)
  .is('dept_key', null) // Guard 2: a row assigned since the read is skipped, not clobbered
  .select('email, role_raw');
if (updErr) die(`UPDATE failed: ${updErr.message}`);
const wrote = updated ?? [];
console.log(`\n  OK ${TABLE.padEnd(20)} ${wrote.length}/${emails.length} row(s) updated`);
if (wrote.length !== emails.length) {
  console.error(
    `  NOTE: ${emails.length - wrote.length} row(s) gained a dept_key between read and write and were skipped — re-run to review them.`,
  );
}

// Audit trail — non-fatal but reported loudly.
{
  const { error } = await db.from(AUDIT_TABLE).insert({
    user_name: ACTOR,
    user_role: 'accounting',
    action: 'hsl.roster.seed',
    resource: TABLE,
    resource_id: TARGET_KEY,
    details: {
      source: 'script:seed-hsl-egs-roster',
      dept_key: TARGET_KEY,
      updated: wrote.length,
      emails: wrote.map((r) => r.email),
      note: 'Executive Guest Services roster-only sub-team seeded from role_raw per Kane 2026-08-14.',
      backup: backupPath,
    },
  });
  if (error) console.error(`  WARNING: roster written, but the audit row failed: ${error.message}`);
  else console.log(`  OK ${AUDIT_TABLE.padEnd(20)} 1 row`);
}

// ── Verify by re-reading ─────────────────────────────────────────────────────
const after = await selectAllPaged<RosterRow>(TABLE, 'email, full_name, role_raw, dept_key, upload_id');
const onTeam = after.filter((r) => r.dept_key === TARGET_KEY);
console.log(`\nVerification (re-read): ${onTeam.length} row(s) now carry dept_key='${TARGET_KEY}'.`);
const expected = eligible.length + alreadyDone.length;
if (onTeam.length !== expected) {
  console.error(`  X expected ${expected} — investigate before re-running.`);
  process.exit(1);
}
console.log('  OK matches the eligible set. Done.');
