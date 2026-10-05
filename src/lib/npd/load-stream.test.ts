import test, { describe } from 'node:test';
import assert from 'node:assert/strict';

import { NPD_COLUMNS } from './columns';
import { NPD_STREAM_CUT_SHORT, chunkNpdRows, createNpdStreamAssembler, encodeNpdStreamLine, type NpdStreamLine } from './load-stream';
import type { NpdLoadEvent } from './load-progress';

const WEEK = '2026-09-20';
const width = NPD_COLUMNS.hsl.length;
const row = (i: number) => ({ id: `r${i}`, values: Array.from({ length: width }, (_, c) => (c === 0 ? `cell ${i}` : '')), overrides: [], formulas: {} });
const rows = (n: number) => Array.from({ length: n }, (_, i) => row(i));

function sheetLine(n: number, over: Partial<Record<string, unknown>> = {}): NpdStreamLine {
  return {
    type: 'sheet',
    sheet: 'hsl',
    week: WEEK,
    version: 3,
    rowCount: n,
    updatedAt: '2026-10-02T19:38:17.95366+00:00',
    updatedBy: 'aliviah@simple.biz',
    lockedAt: null,
    lockedBy: null,
    usdPerPhp: '0.0162575',
    columnFormulas: {},
    rows: n,
    ...over,
  } as NpdStreamLine;
}

/** The lines exactly as the route sends them for a sheet of n rows. */
function routeLines(n: number): NpdStreamLine[] {
  const all = rows(n);
  return [
    { type: 'header', attempt: 1, version: 3, rowCount: n },
    { type: 'read', attempt: 1, rows: n },
    sheetLine(n),
    ...chunkNpdRows(all).map((chunk): NpdStreamLine => ({ type: 'rows', rows: chunk })),
    { type: 'end', rows: n },
  ];
}

function feed(lines: Array<NpdStreamLine | string>) {
  const asm = createNpdStreamAssembler('hsl', WEEK);
  const events: NpdLoadEvent[] = [];
  for (const l of lines) {
    const text = typeof l === 'string' ? l : encodeNpdStreamLine(l).trimEnd();
    const e = asm.push(text);
    if (e) events.push(e);
  }
  return { out: asm.finish(), events };
}

describe('the NPD sheet stream', () => {
  test('a whole sheet arrives whole, in order, with its progress', () => {
    const { out, events } = feed(routeLines(613));
    assert.ok(out.ok);
    if (!out.ok) return;
    assert.equal(out.payload.rows.length, 613);
    assert.deepEqual(out.payload.rows[612], row(612));
    assert.equal(out.payload.version, 3);
    assert.equal(out.payload.usdPerPhp, '0.0162575');
    assert.deepEqual(events.slice(0, 3), [
      { kind: 'header', attempt: 1, rowCount: 613 },
      { kind: 'read', attempt: 1, rows: 613 },
      { kind: 'sheet', rows: 613 },
    ]);
    const counted = events.filter((e) => e.kind === 'rows').reduce((s, e) => s + (e.kind === 'rows' ? e.count : 0), 0);
    assert.equal(counted, 613, 'the rows events add up to exactly what arrived');
  });

  test('every line is one JSON object and one newline', () => {
    const text = encodeNpdStreamLine({ type: 'end', rows: 2 });
    assert.equal(text, '{"type":"end","rows":2}\n');
    assert.deepEqual(chunkNpdRows([1, 2, 3], 2), [[1, 2], [3]]);
  });

  test('an empty week is a whole (empty) sheet, not a failure', () => {
    const { out } = feed([{ type: 'header', attempt: 1, version: 0, rowCount: 0 }, sheetLine(0, { version: 0, updatedAt: null, updatedBy: null }), { type: 'end', rows: 0 }]);
    assert.ok(out.ok);
    if (out.ok) assert.equal(out.payload.rows.length, 0);
  });

  test('a retry is reported, and the rows come only once the read is consistent', () => {
    const { out, events } = feed([
      { type: 'header', attempt: 1, version: 3, rowCount: 2 },
      { type: 'read', attempt: 1, rows: 2 },
      { type: 'retry', attempt: 2 },
      { type: 'header', attempt: 2, version: 4, rowCount: 2 },
      { type: 'read', attempt: 2, rows: 2 },
      sheetLine(2, { version: 4 }),
      { type: 'rows', rows: rows(2) },
      { type: 'end', rows: 2 },
    ]);
    assert.ok(out.ok);
    assert.deepEqual(events[2], { kind: 'retry', attempt: 2 });
  });
});

describe('the NPD sheet stream fails CLOSED: never part of a sheet', () => {
  const failsWith = (lines: Array<NpdStreamLine | string>, message?: RegExp | string) => {
    const { out } = feed(lines);
    assert.equal(out.ok, false);
    if (!out.ok && message) {
      if (typeof message === 'string') assert.equal(out.error, message);
      else assert.match(out.error, message);
    }
    return out;
  };

  test('a stream that stops part-way (no end line) is a failed load', () => {
    failsWith(routeLines(613).slice(0, -1), NPD_STREAM_CUT_SHORT);
    failsWith(routeLines(613).slice(0, 5), NPD_STREAM_CUT_SHORT);
    failsWith([], NPD_STREAM_CUT_SHORT);
  });

  test('fewer or more rows than announced is a failed load', () => {
    const lines = routeLines(120);
    // Drop one rows line: the end count no longer matches what arrived.
    failsWith([...lines.slice(0, 3), ...lines.slice(4)], NPD_STREAM_CUT_SHORT);
    failsWith([sheetLine(2), { type: 'rows', rows: rows(3) }, { type: 'end', rows: 2 }]);
    failsWith([sheetLine(2), { type: 'rows', rows: rows(2) }, { type: 'end', rows: 3 }], NPD_STREAM_CUT_SHORT);
  });

  test('rows before the sheet line, a second sheet line, or progress after it is refused', () => {
    failsWith([{ type: 'rows', rows: rows(1) }, sheetLine(1), { type: 'end', rows: 1 }]);
    failsWith([sheetLine(0), sheetLine(0), { type: 'end', rows: 0 }]);
    failsWith([sheetLine(0), { type: 'retry', attempt: 2 }, { type: 'end', rows: 0 }]);
  });

  test('a line that is not JSON, or of no known type, is refused', () => {
    failsWith(['{"type":"header","attempt":1,"version":1,"rowCount":1', sheetLine(0), { type: 'end', rows: 0 }]);
    failsWith(['{"type":"surprise"}']);
    failsWith(['[1,2,3]']);
  });

  test('a sheet for another tab or week is never shown', () => {
    failsWith([sheetLine(0, { sheet: 'all_departments' }), { type: 'end', rows: 0 }], /different sheet/);
    failsWith([sheetLine(0, { week: '2026-09-13' }), { type: 'end', rows: 0 }], /different sheet/);
  });

  test('a row of the wrong shape fails the whole sheet (the cache’s own validator)', () => {
    const bad = { id: 'x', values: ['too', 'short'], overrides: [], formulas: {} };
    failsWith([sheetLine(1), { type: 'rows', rows: [bad] as never }, { type: 'end', rows: 1 }], /could not read/);
    const badKey = { ...row(0), overrides: ['not_a_column'] };
    failsWith([sheetLine(1), { type: 'rows', rows: [badKey] }, { type: 'end', rows: 1 }], /could not read/);
  });

  test('an error line ends it with the server’s message, and says when NPD is not set up', () => {
    const out = failsWith([{ type: 'header', attempt: 1, version: 1, rowCount: 5 }, { type: 'error', error: 'connection reset', missing: false }], 'connection reset');
    assert.equal(!out.ok && out.missing, false);
    const missing = failsWith([{ type: 'error', error: 'NPD is not set up yet', missing: true }]);
    assert.equal(!missing.ok && missing.missing, true);
  });

  test('after the first problem every later line is ignored, a good end included', () => {
    const { out, events } = feed(['not json', ...routeLines(3)]);
    assert.equal(out.ok, false);
    assert.equal(events.length, 1);
    assert.equal(events[0]!.kind, 'failed');
  });
});
