import test from 'node:test';
import assert from 'node:assert/strict';
import {
  loadAllUploadsPabMerge,
  mergeViaPerUploadReads,
  parseServerMergeBody,
  type UploadReadJson,
} from './load-pab-merge';
import { mergeHubstaffUploadsForPab } from '@/lib/payroll/pab-merge';

const COLS = ['Member', 'Email', 'monday', 'sunday'];
const UPLOADS: Record<string, UploadReadJson> = {
  'a_2026-09-13_to_2026-09-19.csv': { columns: COLS, rows: [{ Member: 'A', Email: 'a@simple.biz', monday: '7:00', sunday: null }], error: null },
  'b_2026-09-06_to_2026-09-12.csv': { columns: COLS, rows: [{ Member: 'A0', Email: 'a@simple.biz', monday: '6:00', sunday: '1:00' }], error: null },
  'c_2026-08-30_to_2026-09-05.csv': { columns: null, rows: null, error: 'boom' },
};
const FILES = Object.keys(UPLOADS);
const readUpload = async (file: string) => structuredClone(UPLOADS[file]);
const expectedMerge = () =>
  mergeHubstaffUploadsForPab(FILES.map((file) => ({ file, columns: UPLOADS[file].columns, rows: UPLOADS[file].rows })));

const jsonResponse = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });

test('server path: a valid body is used as-is and the uploads are never read in the browser', async () => {
  const server = { ...expectedMerge(), skipped: [{ file: FILES[2], error: 'boom' }] };
  let reads = 0;
  const load = await loadAllUploadsPabMerge(FILES, {
    postMerge: async () => jsonResponse(server),
    readUpload: async (f) => { reads++; return readUpload(f); },
  });
  assert.equal(load.via, 'server');
  assert.equal(load.fallbackReason, null);
  assert.equal(reads, 0);
  assert.deepEqual(load.result, expectedMerge());
  assert.deepEqual(load.skipped, [{ file: FILES[2], error: 'boom' }]);
});

for (const [name, postMerge, reason] of [
  ['a 403 from the gate', async () => jsonResponse({ error: 'no' }, 403), /HTTP 403/],
  ['a platform 413', async () => new Response('FUNCTION_PAYLOAD_TOO_LARGE', { status: 413 }), /HTTP 413/],
  ['a network error', async () => { throw new TypeError('Failed to fetch'); }, /Failed to fetch/],
  ['a truncated body', async () => new Response('{"columns":["a"],"rows":[', { status: 200 }), /server merge failed/],
  ['a body with the wrong shape', async () => jsonResponse({ columns: 'x', rows: [], skipped: [] }), /body invalid: columns/],
  ['rows that are not objects', async () => jsonResponse({ columns: [], rows: [1], skipped: [] }), /body invalid: rows/],
  ['a missing skipped list', async () => jsonResponse({ columns: [], rows: [] }), /body invalid: skipped/],
] as const) {
  test(`falls back to the per-upload fan-out on ${name}, with the SAME merge`, async () => {
    const load = await loadAllUploadsPabMerge(FILES, { postMerge, readUpload });
    assert.equal(load.via, 'per-upload');
    assert.match(load.fallbackReason ?? '', reason);
    assert.deepEqual(load.result, expectedMerge());
  });
}

test('the fan-out skips a failed upload exactly as before, and now names it', async () => {
  const { result, skipped } = await mergeViaPerUploadReads(FILES, async (file) => {
    if (file === FILES[1]) throw new SyntaxError('Unexpected token <');
    return readUpload(file);
  });
  assert.deepEqual(skipped.map((s) => s.file), [FILES[1], FILES[2]]);
  assert.deepEqual(result, mergeHubstaffUploadsForPab([
    { file: FILES[0], columns: UPLOADS[FILES[0]].columns, rows: UPLOADS[FILES[0]].rows },
  ]));
});

test('the fan-out keeps the caller\'s order — the merge is last-wins', async () => {
  const forward = await mergeViaPerUploadReads(FILES, readUpload);
  const reverse = await mergeViaPerUploadReads([...FILES].reverse(), readUpload);
  assert.equal(forward.result.rows[0].Member, 'A0');
  assert.equal(reverse.result.rows[0].Member, 'A');
});

test('parseServerMergeBody accepts the route\'s streamed shape', () => {
  const body = JSON.parse('{"columns":["Email"],"skipped":[],"rows":[{"Email":"a@simple.biz"},{"Email":"b@simple.biz"}]}');
  const parsed = parseServerMergeBody(body);
  assert.ok(!('invalid' in parsed));
  assert.equal(parsed.result.rows.length, 2);
});
