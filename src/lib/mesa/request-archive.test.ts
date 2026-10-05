import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

import { isMesaRequestArchived, mesaArchiveRefusal, mesaRequestCompletion } from './request-archive';

const req = (over: Record<string, unknown>) => ({
  request_type: 'disbursement',
  status: 'approved',
  dispatched_at: null as string | null,
  archived_at: null as string | null,
  ...over,
});

describe('mesaRequestCompletion — what may leave the main view', () => {
  test('denied is complete, whatever the type (nothing was released)', () => {
    for (const t of ['opt_out', 'disbursement', 'return']) {
      assert.equal(mesaRequestCompletion(req({ request_type: t, status: 'denied' })).complete, true, t);
    }
  });

  test('pending is never complete', () => {
    for (const t of ['opt_out', 'disbursement', 'return']) {
      assert.equal(mesaRequestCompletion(req({ request_type: t, status: 'pending' })).complete, false, t);
    }
  });

  test('an approved opt-out is complete', () => {
    assert.equal(mesaRequestCompletion(req({ request_type: 'opt_out' })).complete, true);
  });

  test('an approved disbursement is complete ONLY once paid', () => {
    assert.equal(mesaRequestCompletion(req({})).complete, false);
    assert.equal(mesaRequestCompletion(req({ dispatched_at: '2026-10-05T10:00:00Z' })).complete, true);
  });

  test('an approved return is NOT complete — nothing takes it from a paycheck yet', () => {
    const c = mesaRequestCompletion(req({ request_type: 'return' }));
    assert.equal(c.complete, false);
  });

  test('an unknown status or type is not complete', () => {
    assert.equal(mesaRequestCompletion(req({ status: 'weird' })).complete, false);
    assert.equal(mesaRequestCompletion(req({ request_type: 'mystery' })).complete, false);
  });
});

describe('mesaArchiveRefusal', () => {
  test('archiving an incomplete request is refused, with the reason', () => {
    const r = mesaArchiveRefusal(req({}), true);
    assert.ok(r);
    assert.match(r, /not paid out/);
  });

  test('archiving a completed request is allowed', () => {
    assert.equal(mesaArchiveRefusal(req({ status: 'denied' }), true), null);
  });

  test('re-archiving an archived row is a no-op, not an error', () => {
    assert.equal(mesaArchiveRefusal(req({ status: 'denied', archived_at: '2026-10-05T00:00:00Z' }), true), null);
  });

  test('unarchiving is always allowed', () => {
    assert.equal(mesaArchiveRefusal(req({ archived_at: '2026-10-05T00:00:00Z' }), false), null);
    assert.equal(mesaArchiveRefusal(req({}), false), null);
  });

  test('a row read before the migration (no archived_at key) is not archived', () => {
    assert.equal(isMesaRequestArchived({ request_type: 'opt_out', status: 'approved' }), false);
  });
});

describe('the database restates the same rule', () => {
  const sql = fs.readFileSync(
    path.join(process.cwd(), 'references/sql/alter/2026-10-05_add_mesa_request_archive.sql'),
    'utf8',
  );

  test('the CHECK admits exactly the complete shapes', () => {
    assert.match(sql, /archived_at IS NULL\s+OR status = 'denied'/);
    assert.match(sql, /status = 'approved' AND request_type IN \('opt_out', 'opt_in'\)/);
    assert.match(sql, /request_type = 'disbursement' AND dispatched_at IS NOT NULL/);
    // A return must not be admitted until something takes it from a paycheck.
    assert.equal(/request_type IN \([^)]*'return'/.test(sql), false);
  });

  test('archived_at and archived_by travel together', () => {
    assert.match(sql, /CHECK \(\(archived_at IS NULL\) = \(archived_by IS NULL\)\)/);
  });
});

describe('every writer that reopens a request respects the archive', () => {
  const read = (p: string) => fs.readFileSync(path.join(process.cwd(), p), 'utf8');

  test('the dispatch undo unarchives before clearing dispatched_at', () => {
    const src = read('app/api/urgent-payments/dispatches/undo/route.ts');
    const unarchive = src.indexOf('archived_at: null, archived_by: null');
    const reopen = src.indexOf(".update({ dispatched_at: null })");
    assert.ok(unarchive > 0, 'undo must clear the archive');
    assert.ok(reopen > unarchive, 'the archive is cleared BEFORE dispatched_at');
  });

  test('PATCH and DELETE refuse an archived row', () => {
    const src = read('app/api/mesa-requests/[id]/route.ts');
    assert.match(src, /Unarchive it before changing it/);
    assert.match(src, /Unarchive it before deleting it/);
    assert.match(src, /mesaArchiveRefusal\(existing, archive\)/);
  });
});
