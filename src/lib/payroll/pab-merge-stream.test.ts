import test from 'node:test';
import assert from 'node:assert/strict';
import { encodePabMergeStream } from './pab-merge-stream';
import { parseServerMergeBody } from '@/lib/payroll-wizard/load-pab-merge';

const read = async (stream: ReadableStream<Uint8Array>) => new Response(stream).text();

const merged = {
  columns: ['Member', 'Email', '2026-09-14'],
  rows: Array.from({ length: 1001 }, (_, i) => ({
    Member: `M "${i}"   ₱`,
    Email: `p${i}@simple.biz`,
    '2026-09-14': i % 3 === 0 ? null : `${i}:00`,
  })),
};
const skipped = [{ file: 'a_2026-09-06_to_2026-09-12.csv', error: 'boom "quoted"' }];

test('the chunks concatenate to exactly JSON.stringify of the document, at any chunk size', async () => {
  const expected = JSON.stringify({ columns: merged.columns, skipped, rows: merged.rows });
  for (const size of [1, 7, 250, 1000, 1001, 5000]) {
    assert.equal(await read(encodePabMergeStream(merged, skipped, size)), expected, `chunk size ${size}`);
  }
});

test('an empty merge is still a valid document', async () => {
  const body = await read(encodePabMergeStream({ columns: [], rows: [] }, []));
  assert.equal(body, '{"columns":[],"skipped":[],"rows":[]}');
});

test('the streamed body passes the wizard\'s own validator', async () => {
  const parsed = parseServerMergeBody(JSON.parse(await read(encodePabMergeStream(merged, skipped))));
  assert.ok(!('invalid' in parsed));
  assert.equal(parsed.result.rows.length, 1001);
  assert.deepEqual(parsed.skipped, skipped);
});
