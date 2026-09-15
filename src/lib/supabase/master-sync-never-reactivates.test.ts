/**
 * A sheet sync must never un-write an offboard.
 *
 * Kane, 2026-09-14: *"everyone offboarded should not be in the GLOBAL MASTER
 * LIST anywhere in the HRIS."*
 *
 * The ingest path used to accept `clearOffboarded`, which re-activated any
 * stamped row whose stamp was older than a 14-day grace — and the Admin
 * checkbox that set it **defaulted to `true`**. That is how 158 Lead Gen people,
 * every one of them stamped in July 2026, walked back onto the active roster
 * with `off_boarded_at = null` and were dealt QC scoring slots for weeks.
 *
 * These are source-scan controls rather than behavioural tests because the
 * function is a long Supabase write path with no seam to fake; what has to hold
 * is that the capability is *absent*, and absence is exactly what a scan can
 * prove. The behaviour is verified against production by
 * `scripts/verify-master-sync-preserves-offboard.mts`.
 *
 * Three UI callers post to the sync, not two: the Admin CSV Imports tab, the
 * Payroll Wizard's Setup step, and the cron. The wizard was still sending the
 * flag a day after removal (2026-09-15) — inert, because the route no longer
 * reads it, but a control that names two senders while three exist is the kind
 * of gap this file exists to close.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

/** Comments stripped, so the controls scan CODE and not the history above. */
function stripComments(src: string): string {
  return src
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .split('\n')
    .filter((l) => !/^\s*(\/\/|\*)/.test(l))
    .join('\n');
}

const dbCode = stripComments(
  readFileSync(join(process.cwd(), 'src/lib/supabase/global-master-list-db.ts'), 'utf8'),
);
const cronCode = stripComments(
  readFileSync(join(process.cwd(), 'app/api/cron/sync-master-from-sheet/route.ts'), 'utf8'),
);
const adminCode = stripComments(
  readFileSync(join(process.cwd(), 'src/components/admin/AdminCsvImports.tsx'), 'utf8'),
);
const wizardCode = stripComments(
  readFileSync(join(process.cwd(), 'src/components/PayrollWizard.tsx'), 'utf8'),
);

test('the stripper strips (the detector that broke four times today)', () => {
  assert.equal(stripComments('  // clearOffboarded\nconst a = 1;').includes('clearOffboarded'), false);
  assert.equal(stripComments('/* clearOffboarded */\nconst a = 1;').includes('clearOffboarded'), false);
  assert.equal(stripComments('const x = clearOffboarded;').includes('clearOffboarded'), true);
});

test('CONTROL: ingest has no re-activation capability at all', () => {
  for (const token of ['clearOffboarded', 'OFFBOARD_REACTIVATION_GRACE_DAYS', 'reonboarded']) {
    assert.doesNotMatch(
      dbCode,
      new RegExp(token),
      `${token} must not return to the ingest path — a sync cannot un-write an offboard`,
    );
  }
});

test('CONTROL: the sync never writes null into an off_boarded_* column', () => {
  // The old code did `updatePayload["off_boarded_at"] = null`. Any assignment
  // into these columns from ingest is the defect coming back.
  for (const col of ['off_boarded_at', 'off_boarded_reason', 'off_boarded_by', 'off_boarded_note']) {
    assert.doesNotMatch(
      dbCode,
      new RegExp(`\\[\\s*["']${col}["']\\s*\\]\\s*=`),
      `ingest must never assign ${col}`,
    );
  }
});

test('CONTROL: the sync actively strips offboard columns from its update payload', () => {
  // Belt and braces: not merely "does not set them", but deletes them, so a
  // future edit that lets one into `payload` still cannot un-offboard anyone.
  for (const col of [
    'off_boarded_at',
    'off_boarded_reason',
    'off_boarded_by',
    'off_boarded_note',
    'scheduled_deletion_at',
    'deletion_processed_at',
  ]) {
    assert.match(
      dbCode,
      new RegExp(`delete updatePayload\\["${col}"\\]`),
      `the update payload must drop ${col}`,
    );
  }
});

test('CONTROL: no caller — cron, Admin screen, or Payroll Wizard — can ask for a re-activation', () => {
  assert.doesNotMatch(cronCode, /clearOffboarded/, 'the cron must not read the flag');
  assert.doesNotMatch(adminCode, /clearOffboarded/, 'the Admin sync must not send it');
  assert.doesNotMatch(
    wizardCode,
    /clearOffboarded/,
    'the Payroll Wizard Setup sync must not send it — it was the third caller, still posting the flag on 2026-09-15',
  );
  assert.doesNotMatch(
    adminCode,
    /masterSyncClearOffboarded/,
    'and the checkbox is removed, not disabled — a control that cannot act is a worse lie than no control',
  );
});

test('CONTROL: the Restore button is still the way back', () => {
  // Removing the sheet path is only safe because an explicit, audited,
  // per-person path survives. If this ever disappears, a re-hire has no route.
  const reonboard = readFileSync(join(process.cwd(), 'app/api/hr/reonboard/route.ts'), 'utf8');
  assert.match(reonboard, /hr\.employee\.reonboarded/, 'the Restore path must stay, and stay audited');
});
