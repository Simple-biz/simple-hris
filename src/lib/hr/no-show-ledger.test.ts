/**
 * An orientation no-show must land on the Offboarded list exactly once, and the
 * row must never become off-board evidence against someone working today.
 *
 * 2026-10-05 (audit item 343): HR nearly re-interviewed a returning no-show
 * because Manager → Did not attend never wrote `offboarded_sheet`. 42 of 59
 * no-shows were missing; 9 of the 13 rehired came back on the SAME work email.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  buildNoShowLedgerRow,
  recordNoShowOnLedger,
  noShowLedgerMarker,
  pendingIdFromLedgerNote,
  escapeIlike,
  type NoShowLedgerRow,
  type NoShowLedgerStore,
} from './no-show-ledger';

const base = {
  pendingId: 1379,
  name: ' Juan Dela Cruz ',
  workEmail: 'JuanD@simple.biz ',
  personalEmail: ' Juan.DC@Gmail.com',
  department: 'Lead Gen',
  noShowAt: '2026-09-28T14:00:00.000Z',
  markedBy: 'Manager@Simple.biz',
  managerNote: null,
};

test('a no-show becomes an ncns row, hris origin, no start date, the marker in the note', () => {
  const d = buildNoShowLedgerRow({ ...base, workEmailLive: false });
  assert.equal(d.kind, 'insert');
  if (d.kind !== 'insert') return;
  assert.deepEqual(d.row, {
    personal_email: 'juan.dc@gmail.com',
    work_email: 'juand@simple.biz',
    name: 'Juan Dela Cruz',
    department: 'Lead Gen',
    start_date: null,
    off_boarded_at: '2026-09-28T14:00:00.000Z',
    off_boarded_reason: 'ncns',
    off_boarded_note: 'Did not attend orientation (pending hire #1379)',
    off_boarded_by: 'manager@simple.biz',
    origin: 'hris',
  });
  assert.equal(d.workEmailWithheld, null);
});

test('a work email LIVE on the roster is withheld, and the note says why', () => {
  const d = buildNoShowLedgerRow({ ...base, workEmailLive: true });
  assert.equal(d.kind, 'insert');
  if (d.kind !== 'insert') return;
  assert.equal(d.row.work_email, null);
  assert.equal(d.workEmailWithheld, 'live_on_roster');
  assert.match(d.row.off_boarded_note, /juand@simple\.biz not recorded: it is in use on the active roster/);
  // Still on the list by personal email and name — what HR searches by.
  assert.equal(d.row.personal_email, 'juan.dc@gmail.com');
  assert.equal(d.row.name, 'Juan Dela Cruz');
});

test('unknown liveness withholds too — the safe direction on an evidence table', () => {
  const d = buildNoShowLedgerRow({ ...base, workEmailLive: null });
  assert.equal(d.kind, 'insert');
  if (d.kind !== 'insert') return;
  assert.equal(d.row.work_email, null);
  assert.equal(d.workEmailWithheld, 'live_check_failed');
});

test('no work email (no account was made) still writes the row', () => {
  const d = buildNoShowLedgerRow({ ...base, workEmail: null, workEmailLive: false });
  assert.equal(d.kind, 'insert');
  if (d.kind !== 'insert') return;
  assert.equal(d.row.work_email, null);
  assert.equal(d.workEmailWithheld, null);
});

test('no personal email is a reported skip — never a fall-back to the work address', () => {
  assert.deepEqual(buildNoShowLedgerRow({ ...base, personalEmail: '  ', workEmailLive: false }), {
    kind: 'skip',
    reason: 'no_personal_email',
  });
});

test('the manager note rides after the marker', () => {
  const d = buildNoShowLedgerRow({ ...base, managerNote: '  no reply to 3 calls ', workEmailLive: false });
  assert.equal(d.kind, 'insert');
  if (d.kind !== 'insert') return;
  assert.equal(d.row.off_boarded_note, 'Did not attend orientation (pending hire #1379) · no reply to 3 calls');
  assert.equal(pendingIdFromLedgerNote(d.row.off_boarded_note), 1379);
});

test('the marker cannot match a longer id', () => {
  assert.equal(noShowLedgerMarker(1379), '(pending hire #1379)');
  assert.ok(!noShowLedgerMarker(13790).includes(noShowLedgerMarker(1379)));
  assert.equal(pendingIdFromLedgerNote('Did not attend orientation (pending hire #13790)'), 13790);
  assert.equal(pendingIdFromLedgerNote('Resigned'), null);
  assert.equal(pendingIdFromLedgerNote(null), null);
});

test('escapeIlike neutralises the wildcards an email can carry', () => {
  assert.equal(escapeIlike('john_d@simple.biz'), 'john\\_d@simple.biz');
  assert.equal(escapeIlike('a%b\\c'), 'a\\%b\\\\c');
});

// ── recordNoShowOnLedger: order and failure handling ───────────────────────

function fakeStore(over: Partial<{
  markerExists: { exists: boolean; error: string | null };
  workEmailLive: { live: boolean; error: string | null };
  insert: { error: string | null };
}> = {}) {
  const calls: string[] = [];
  const inserted: NoShowLedgerRow[] = [];
  const store: NoShowLedgerStore = {
    async markerExists(m) {
      calls.push(`marker:${m}`);
      return over.markerExists ?? { exists: false, error: null };
    },
    async workEmailLive(w) {
      calls.push(`live:${w}`);
      return over.workEmailLive ?? { live: false, error: null };
    },
    async insert(row) {
      calls.push('insert');
      inserted.push(row);
      return over.insert ?? { error: null };
    },
  };
  return { store, calls, inserted };
}

test('writes once: marker checked, liveness checked, then inserted', async () => {
  const f = fakeStore();
  const r = await recordNoShowOnLedger(f.store, base);
  assert.deepEqual(r, { written: true, skipped: null, workEmailWithheld: null, error: null });
  assert.deepEqual(f.calls, ['marker:(pending hire #1379)', 'live:juand@simple.biz', 'insert']);
  assert.equal(f.inserted[0]?.work_email, 'juand@simple.biz');
});

test('an existing marker writes nothing — re-runs and double clicks are no-ops', async () => {
  const f = fakeStore({ markerExists: { exists: true, error: null } });
  const r = await recordNoShowOnLedger(f.store, base);
  assert.deepEqual(r, { written: false, skipped: 'already_on_list', workEmailWithheld: null, error: null });
  assert.deepEqual(f.calls, ['marker:(pending hire #1379)']);
});

test('a failed marker read writes NOTHING and says so', async () => {
  const f = fakeStore({ markerExists: { exists: false, error: 'timeout' } });
  const r = await recordNoShowOnLedger(f.store, base);
  assert.equal(r.written, false);
  assert.match(r.error ?? '', /Offboarded list check failed: timeout/);
  assert.equal(f.inserted.length, 0);
});

test('a failed liveness read still writes, with the work email withheld', async () => {
  const f = fakeStore({ workEmailLive: { live: false, error: 'boom' } });
  const r = await recordNoShowOnLedger(f.store, base);
  assert.equal(r.written, true);
  assert.equal(r.workEmailWithheld, 'live_check_failed');
  assert.equal(f.inserted[0]?.work_email, null);
});

test('a live work email is withheld on the written row', async () => {
  const f = fakeStore({ workEmailLive: { live: true, error: null } });
  const r = await recordNoShowOnLedger(f.store, base);
  assert.equal(r.workEmailWithheld, 'live_on_roster');
  assert.equal(f.inserted[0]?.work_email, null);
});

test('no work email skips the liveness read', async () => {
  const f = fakeStore();
  await recordNoShowOnLedger(f.store, { ...base, workEmail: null });
  assert.deepEqual(f.calls, ['marker:(pending hire #1379)', 'insert']);
});

test('an insert failure is reported, never swallowed', async () => {
  const f = fakeStore({ insert: { error: 'permission denied' } });
  const r = await recordNoShowOnLedger(f.store, base);
  assert.deepEqual(r, { written: false, skipped: null, workEmailWithheld: null, error: 'permission denied' });
});

test('no personal email is a skip, not an insert attempt', async () => {
  const f = fakeStore();
  const r = await recordNoShowOnLedger(f.store, { ...base, personalEmail: null });
  assert.equal(r.skipped, 'no_personal_email');
  assert.ok(!f.calls.includes('insert'));
});

// ── Source pin: the route writes the ledger, after the no-show is saved ─────

test('the no-show route records the ledger row only after markPendingHireNoShow succeeds', () => {
  const src = readFileSync(
    join(process.cwd(), 'app/api/manager/pending-hires/[id]/no-show/route.ts'),
    'utf8',
  );
  const mark = src.indexOf('await markPendingHireNoShow(');
  const bail = src.indexOf('if (error) return NextResponse.json({ error }, { status: 500 });', mark);
  const ledger = src.indexOf('await recordNoShowOnLedger(');
  assert.ok(mark > 0, 'route marks the no-show');
  assert.ok(bail > mark, 'route bails when the no-show did not save');
  assert.ok(ledger > bail, 'ledger write comes after the no-show is saved');
  assert.match(src, /ledger_written:/, 'audit row records whether the ledger row landed');
});
