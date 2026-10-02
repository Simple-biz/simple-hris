import test, { describe } from 'node:test';
import assert from 'node:assert/strict';

import { NPD_COLUMNS } from './columns';
import { NPD_CACHED_SHEETS_MAX, parseNpdSheetPayload, parseNpdSyncWeek, parseNpdView, parseNpdWeeks, touchNpdSheetIndex } from './npd-cache';

const W = NPD_COLUMNS.hsl.length;
const good = () => ({
  version: 3,
  rowCount: 1,
  updatedAt: '2026-10-02T15:00:00Z',
  updatedBy: 'aliviah@x.com',
  lockedAt: null,
  lockedBy: null,
  usdPerPhp: '0.0160051',
  columnFormulas: { ot_differential: '={mf_rate}*0.5' },
  rows: [{ id: 'a1', values: Array(W).fill(''), overrides: ['hogan_we_rate'], formulas: {} }],
});

describe('a cached NPD sheet is re-checked before it paints', () => {
  test('a good payload comes back as itself (copied, not aliased)', () => {
    const raw = good();
    const p = parseNpdSheetPayload('hsl', raw);
    assert.deepEqual(p, raw);
    assert.notEqual(p!.rows[0]!.values, raw.rows[0]!.values);
  });

  test('anything off drops the whole copy: the live read decides', () => {
    const bad: Array<[string, (x: ReturnType<typeof good>) => unknown]> = [
      ['not an object', () => 'x'],
      ['negative version', (x) => ({ ...x, version: -1 })],
      ['fractional version', (x) => ({ ...x, version: 1.5 })],
      ['numeric rate', (x) => ({ ...x, usdPerPhp: 0.016 })],
      ['unknown column formula', (x) => ({ ...x, columnFormulas: { regular_rate: '=1' } })],
      ['row with too few cells', (x) => ({ ...x, rows: [{ ...x.rows[0]!, values: ['a'] }] })],
      ['a number in a cell', (x) => ({ ...x, rows: [{ ...x.rows[0]!, values: [1, ...Array(W - 1).fill('')] }] })],
      ['an override that is not a column', (x) => ({ ...x, rows: [{ ...x.rows[0]!, overrides: ['nope'] }] })],
      ['a row with no id', (x) => ({ ...x, rows: [{ ...x.rows[0]!, id: '' }] })],
      ['rows not a list', (x) => ({ ...x, rows: {} })],
    ];
    for (const [name, make] of bad) assert.equal(parseNpdSheetPayload('hsl', make(good())), null, name);
  });

  test('a sheet cached for one tab is never trusted as the other tab', () => {
    assert.equal(parseNpdSheetPayload('all_departments', good()), null);
  });
});

describe('the cached week list', () => {
  test('good entries pass; one bad entry drops the list', () => {
    const w = { sheet: 'hsl', week: '2026-09-20', rowCount: 612, updatedAt: 'x', updatedBy: 'y', lockedAt: null };
    assert.deepEqual(parseNpdWeeks([w]), [w]);
    assert.equal(parseNpdWeeks([w, { ...w, sheet: 'payroll' }]), null);
    assert.equal(parseNpdWeeks([{ ...w, week: '9/20' }]), null);
    assert.equal(parseNpdWeeks('nope'), null);
  });
});

describe('at most a few sheets are kept, most recently used first', () => {
  test('a new key goes to the front; the oldest fall off and are evicted', () => {
    let index: string[] = [];
    for (const k of ['a', 'b', 'c', 'd', 'e']) {
      const r = touchNpdSheetIndex(index, k);
      index = r.keep;
      if (k === 'e') assert.deepEqual(r.evict, ['a']);
    }
    assert.deepEqual(index, ['e', 'd', 'c', 'b']);
    assert.equal(index.length, NPD_CACHED_SHEETS_MAX);
  });
  test('touching a kept key moves it to the front and evicts nothing', () => {
    assert.deepEqual(touchNpdSheetIndex(['a', 'b', 'c'], 'c'), { keep: ['c', 'a', 'b'], evict: [] });
  });
  test('a damaged index is treated as empty', () => {
    assert.deepEqual(touchNpdSheetIndex({ oops: 1 }, 'x'), { keep: ['x'], evict: [] });
    assert.deepEqual(touchNpdSheetIndex(['x', 7, 'y'], 'z'), { keep: ['z', 'x', 'y'], evict: [] });
  });
});

describe('the cached sync bar (wizard week + last sync)', () => {
  const ok = {
    week: '2026-09-20',
    sourceFile: 'hubstaff_2026-09-20_to_2026-09-26.csv',
    lastSync: { all_departments: { at: '2026-10-01T14:00:00Z', by: 'a@x.com', tab: 'All Dept' }, hsl: null },
    lastSyncError: null,
  };
  test('good comes back as itself; an unread last-sync stays null (not "never synced")', () => {
    assert.deepEqual(parseNpdSyncWeek(ok), ok);
    assert.deepEqual(parseNpdSyncWeek({ ...ok, lastSync: null, lastSyncError: 'could not be read' }), { ...ok, lastSync: null, lastSyncError: 'could not be read' });
  });
  test('anything off is dropped', () => {
    assert.equal(parseNpdSyncWeek({ ...ok, week: 'Sep 20' }), null);
    assert.equal(parseNpdSyncWeek({ ...ok, lastSync: { all_departments: { at: 1 }, hsl: null } }), null);
    assert.equal(parseNpdSyncWeek({ ...ok, lastSync: { hsl: null } }), null);
    assert.equal(parseNpdSyncWeek(null), null);
  });
});

describe('the week NPD was left on', () => {
  test('a real Sunday comes back; anything else is nothing', () => {
    assert.deepEqual(parseNpdView({ week: '2026-09-20' }), { week: '2026-09-20' });
    for (const bad of [{ week: '2026-09-21' }, { week: '2026-02-30' }, { week: 20 }, null, 'x']) assert.equal(parseNpdView(bad), null);
  });
});
