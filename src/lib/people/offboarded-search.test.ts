import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import {
  OFFBOARDED_SEARCH_CAP,
  OFFBOARDED_SEARCH_MIN_QUERY,
  foldBankStatus,
  matchOffboardedRows,
  pickSnapshotIdRow,
} from './offboarded-search';

const row = (name: string | null, workEmail: string | null) => ({ name, workEmail });

describe('matchOffboardedRows', () => {
  it('matches name and work email, case-insensitively', () => {
    const rows = [
      row('Ceniza James John "James"', 'jamesc@simple.biz'),
      row('Cargo, James Adrian "James"', 'jamesc@simple.biz'),
      row('Morales, Angelyne "Ang"', 'angm@simple.biz'),
    ];
    assert.equal(matchOffboardedRows(rows, 'JAMESC@').rows.length, 2);
    assert.equal(matchOffboardedRows(rows, 'morales').rows.length, 1);
    assert.equal(matchOffboardedRows(rows, 'james').rows.length, 2);
  });

  it('a recycled work email returns EVERY row that carried it', () => {
    const rows = [
      row('Ceniza James John', 'jamesc@simple.biz'),
      row('Cargo, James Adrian', 'jamesc@simple.biz'),
      row('Chan, James Edward', 'jamesc@simple.biz'),
    ];
    assert.equal(matchOffboardedRows(rows, 'jamesc@simple.biz').rows.length, 3);
  });

  it('under-length queries return nothing (search-first tab, not a browse list)', () => {
    const rows = [row('Ana', 'a@simple.biz')];
    assert.deepEqual(matchOffboardedRows(rows, ''), { rows: [], total: 0 });
    assert.deepEqual(matchOffboardedRows(rows, 'a'), { rows: [], total: 0 });
    assert.deepEqual(matchOffboardedRows(rows, '  a  '), { rows: [], total: 0 });
    assert.equal(OFFBOARDED_SEARCH_MIN_QUERY, 2);
  });

  it('does NOT match on personal email (Kane named name + work email)', () => {
    const rows = [{ name: 'X Y', workEmail: 'xy@simple.biz', personalEmail: 'match-me@gmail.com' }];
    assert.equal(matchOffboardedRows(rows, 'match-me').rows.length, 0);
  });

  it('caps results but reports the true total, preserving input order', () => {
    const rows = Array.from({ length: OFFBOARDED_SEARCH_CAP + 10 }, (_, i) =>
      row(`Person ${i}`, `p${i}@simple.biz`),
    );
    const res = matchOffboardedRows(rows, 'person');
    assert.equal(res.rows.length, OFFBOARDED_SEARCH_CAP);
    assert.equal(res.total, OFFBOARDED_SEARCH_CAP + 10);
    assert.equal(res.rows[0]!.name, 'Person 0');
  });

  it('tolerates null name/work email cells', () => {
    const rows = [row(null, 'only-email@simple.biz'), row('Only Name', null)];
    assert.equal(matchOffboardedRows(rows, 'only-email').rows.length, 1);
    assert.equal(matchOffboardedRows(rows, 'only name').rows.length, 1);
  });
});

// A live employee_ids row that isPayoutComplete accepts (wallet rail: email is
// the destination).
const LIVE_KOLAN_ROW = { preferred_processor: 'hurupay', hurupay_email: 'pay@me.com' };
// A snapshot row for a bank rail (wires needs bank name + holder + account).
const SNAPSHOT_WIRES_ROW = {
  preferred_processor: 'wires',
  bank_name: 'BPI',
  account_holder_name: 'Old Holder',
  account_number: '12345678',
  swift_code: 'BOPIPHMM',
};

describe('foldBankStatus', () => {
  it('live payable row → ok, with the LIVE processor allowed to lock the picker', () => {
    const res = foldBankStatus({ idRow: LIVE_KOLAN_ROW, snapshotIdRows: [SNAPSHOT_WIRES_ROW] });
    assert.equal(res.bankStatus, 'ok');
    assert.equal(res.bankProcessor, 'hurupay');
    assert.equal(res.bankPrefill, null);
  });

  it('snapshot-only → missing_has_snapshot; the snapshot processor rides the PREFILL, never bankProcessor', () => {
    const res = foldBankStatus({ idRow: null, snapshotIdRows: [SNAPSHOT_WIRES_ROW] });
    assert.equal(res.bankStatus, 'missing_has_snapshot');
    // A locked picker skips writing preferred_processor — a snapshot value must
    // seed WITHOUT locking (payroll-notes-offboarded-tab-shipped).
    assert.equal(res.bankProcessor, null);
    assert.equal(res.bankPrefill?.processor, 'wires');
    assert.equal(res.bankPrefill?.bankName, 'BPI');
    assert.equal(res.bankPrefill?.accountNumber, '12345678');
  });

  it('neither live nor snapshot → missing ("No Bank")', () => {
    const res = foldBankStatus({ idRow: null, snapshotIdRows: null });
    assert.deepEqual(res, { bankStatus: 'missing', bankProcessor: null, bankPrefill: null });
  });

  it('an empty snapshot row cannot vouch — still missing', () => {
    const res = foldBankStatus({ idRow: null, snapshotIdRows: [{}] });
    assert.equal(res.bankStatus, 'missing');
    assert.equal(res.bankPrefill, null);
  });
});

describe('pickSnapshotIdRow', () => {
  it('an empty/legacy row must not shadow a usable one', () => {
    const usable = SNAPSHOT_WIRES_ROW;
    assert.equal(pickSnapshotIdRow([{}, usable]), usable);
  });
  it('falls back to the first row when none resolves', () => {
    const first = { note: 'legacy' };
    assert.equal(pickSnapshotIdRow([first, {}]), first);
  });
});
