/**
 * A rehire promote must never leave the person "promoted" but invisible.
 *
 * 2026-09-14: `aireenp@` (Aireen Grace Pinili) was promoted onto her old Lead
 * Gen row. Promote re-stamped `last_seen_upload_id` and left the 2026-05-18
 * off-board in place, so `active_employees` hid her — a manager could not find
 * her to transfer her ten days later. Audit items 186 / 197.
 *
 * Kane, 2026-09-24, chose (b): promote reactivates the row itself when it is
 * provably the same person (Personal Email match) and refuses otherwise.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { decideMasterRowReuse } from './rehire-master-reuse';

const hire = {
  personalEmail: 'aigella918@gmail.com',
  workEmail: 'aireenp@simple.biz',
  department: 'Lead Gen',
};

test('an active row is reused as before — nothing to reactivate', () => {
  assert.deepEqual(
    decideMasterRowReuse(
      { offBoardedAt: null, offBoardedReason: null, personalEmail: 'aigella918@gmail.com' },
      hire,
    ),
    { kind: 'reuse' },
  );
});

test('the aireenp@ case: same person, off-boarded row → reactivate, old stint carried out', () => {
  assert.deepEqual(
    decideMasterRowReuse(
      {
        offBoardedAt: '2026-05-18T00:00:00+00:00',
        offBoardedReason: 'Performance',
        personalEmail: 'aigella918@gmail.com',
      },
      hire,
    ),
    {
      kind: 'reactivate',
      previousOffBoardedAt: '2026-05-18T00:00:00+00:00',
      previousReason: 'Performance',
    },
  );
});

test('personal email match ignores case and whitespace', () => {
  const d = decideMasterRowReuse(
    { offBoardedAt: '2026-05-18', offBoardedReason: null, personalEmail: '  AIGELLA918@Gmail.com ' },
    hire,
  );
  assert.equal(d.kind, 'reactivate');
});

test('recycled work email (different personal email) → refused, never reactivated', () => {
  const d = decideMasterRowReuse(
    { offBoardedAt: '2026-05-18', offBoardedReason: 'resigned', personalEmail: 'someone.else@gmail.com' },
    hire,
  );
  assert.equal(d.kind, 'refuse');
  assert.match((d as { error: string }).error, /is off-boarded/);
});

test('no personal email on either side → refused (cannot prove the same person)', () => {
  for (const [rowPe, hirePe] of [[null, hire.personalEmail], ['aigella918@gmail.com', null], ['', ' ']] as const) {
    const d = decideMasterRowReuse(
      { offBoardedAt: '2026-05-18', offBoardedReason: null, personalEmail: rowPe },
      { ...hire, personalEmail: hirePe },
    );
    assert.equal(d.kind, 'refuse', `row=${rowPe} hire=${hirePe}`);
  }
});

/** Comments stripped, so the controls scan CODE and not the history in comments. */
function code(rel: string): string {
  return readFileSync(join(process.cwd(), rel), 'utf8')
    .split('\n')
    .filter((l) => !/^\s*(\/\/|\*)/.test(l))
    .join('\n');
}

test('CONTROL: promote routes every reused row through decideMasterRowReuse', () => {
  const src = code('src/lib/supabase/hr-pending-employees.ts');
  assert.match(src, /decideMasterRowReuse\(/);
  assert.match(src, /decision\.kind === "refuse"\) return/);
  // The lookup must fetch what the decision needs.
  assert.match(src, /select\('id, "Personal Email", off_boarded_at, off_boarded_reason'\)/);
});

test('CONTROL: the reuse UPDATE error is checked, not fire-and-forget', () => {
  const src = code('src/lib/supabase/hr-pending-employees.ts');
  assert.match(src, /const \{ error: reuseErr \} = await sb\.from\(MASTER_TABLE\)\.update\(patch\)/);
  assert.match(src, /if \(reuseErr\)/);
});

test('CONTROL: reactivation clears the deletion timers too (else the new accounts get deleted)', () => {
  const src = code('src/lib/supabase/hr-pending-employees.ts');
  for (const col of ['off_boarded_at', 'off_boarded_reason', 'off_boarded_by', 'off_boarded_note', 'scheduled_deletion_at', 'deletion_processed_at']) {
    assert.match(src, new RegExp(`patch\\.${col} = null;`), col);
  }
});

test('CONTROL: both promote routes audit a reactivation as hr.employee.reonboarded', () => {
  for (const rel of ['app/api/hr/pending-employees/[id]/promote/route.ts', 'app/api/hr/pending-employees/bulk-promote/route.ts']) {
    const src = code(rel);
    assert.match(src, /reactivated/, rel);
    assert.match(src, /action: "hr\.employee\.reonboarded"/, rel);
    assert.match(src, /via: "rehire_promote"/, rel);
  }
});
