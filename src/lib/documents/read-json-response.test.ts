import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { readJsonResponse, describeNonJsonResponse, BODY_SNIPPET_CHARS } from './read-json-response';

const ROOT = process.cwd();

function res(body: string, init: { status?: number; statusText?: string; type?: string } = {}): Response {
  return new Response(body, {
    status: init.status ?? 200,
    statusText: init.statusText ?? '',
    headers: init.type ? { 'content-type': init.type } : undefined,
  });
}

test('a good response parses', async () => {
  const out = await readJsonResponse<{ row?: { id: number }; error?: string }>(
    res(JSON.stringify({ row: { id: 7 } }), { type: 'application/json' }),
    'Saving your signature',
  );
  assert.deepEqual(out.row, { id: 7 });
});

test("the route's own message wins — it is written for this operator", async () => {
  await assert.rejects(
    () => readJsonResponse(res(JSON.stringify({ error: 'Signature image is too large — draw it again with fewer strokes' }), { status: 400, type: 'application/json' }), 'Saving your signature'),
    /too large — draw it again/,
  );
});

test('an HTML error page reports the status and the body, not a parser complaint', async () => {
  await assert.rejects(
    () => readJsonResponse(res('<!DOCTYPE html><html><head><title>500</title></head><body>Internal Server Error</body></html>', { status: 500, statusText: 'Internal Server Error', type: 'text/html; charset=utf-8' }), 'Saving your signature'),
    (e: Error) => {
      assert.match(e.message, /Saving your signature failed/);
      assert.match(e.message, /500 Internal Server Error/);
      assert.match(e.message, /text\/html/);
      assert.match(e.message, /<!DOCTYPE html>/);
      // The thing Kane actually saw must NOT be what surfaces.
      assert.ok(!/Unexpected token/i.test(e.message), 'the parser complaint leaked through');
      assert.ok(!/is not valid JSON/i.test(e.message), 'the parser complaint leaked through');
      return true;
    },
  );
});

test('a plain-text gateway message is reported verbatim', async () => {
  await assert.rejects(
    () => readJsonResponse(res('Internal Server Error', { status: 500, type: 'text/plain' }), 'Generating the certificate'),
    /Generating the certificate failed — the server answered 500 with text\/plain, not JSON: Internal Server Error/,
  );
});

test('an empty body says so rather than quoting nothing', async () => {
  await assert.rejects(
    () => readJsonResponse(res('', { status: 502 }), 'Saving your signature'),
    /\(empty body\)/,
  );
});

test('a long HTML page is truncated but still identifiable', async () => {
  const long = `<!DOCTYPE html>${'x'.repeat(5000)}`;
  await assert.rejects(
    () => readJsonResponse(res(long, { status: 500, type: 'text/html' }), 'Saving your signature'),
    (e: Error) => {
      assert.ok(e.message.length < 400, `message is ${e.message.length} chars — too long for a toast`);
      assert.match(e.message, /<!DOCTYPE html>/);
      assert.match(e.message, /…$/);
      return true;
    },
  );
});

test('multi-line HTML collapses to one line', () => {
  const msg = describeNonJsonResponse({
    what: 'Saving your signature',
    status: 500,
    contentType: 'text/html',
    body: '<html>\n  <body>\n    Something broke\n  </body>\n</html>',
  });
  assert.ok(!msg.includes('\n'), 'a newline in a toast truncates the rest of the message');
  assert.match(msg, /<html> <body> Something broke/);
});

test('a failed request with a JSON body but no error field still throws', async () => {
  await assert.rejects(
    () => readJsonResponse(res(JSON.stringify({ row: null }), { status: 403, statusText: 'Forbidden', type: 'application/json' }), 'Saving your signature'),
    /Saving your signature failed \(403 Forbidden\)/,
  );
});

test('the snippet cap stays toast-sized', () => {
  assert.ok(BODY_SNIPPET_CHARS > 0 && BODY_SNIPPET_CHARS <= 200);
});

test('no bare res.json() survives in the Documents tab', () => {
  // The whole point: one unguarded parse is enough to reproduce the original
  // unreadable toast on whichever request happens to fail.
  const src = fs.readFileSync(path.join(ROOT, 'src/components/accounting/AccountingDocuments.tsx'), 'utf8');
  const bare = src.match(/await\s+res\.json\(\)/g) ?? [];
  assert.deepEqual(bare, [], 'an unguarded res.json() is back — route it through readJsonResponse');
});
