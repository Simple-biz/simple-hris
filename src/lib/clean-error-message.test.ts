import { test } from 'node:test';
import assert from 'node:assert/strict';
import { cleanErrorMessage, looksLikeHtmlError, detectHttpStatus } from './clean-error-message';

const CF_522 =
  '<!DOCTYPE html><html class="no-js"><head><title>supabase.co | 522: Connection timed out</title></head>' +
  '<body><div id="cf-error-details"><h1>Connection timed out <span class="code-label">Error code 522</span></h1>' +
  '<p>ookpxwxxujdtppqizlrp.supabase.co</p></body></html>';

test('collapses a full Cloudflare 522 HTML page to a friendly line', () => {
  assert.equal(cleanErrorMessage(CF_522), "Can't reach the server — the connection timed out (HTTP 522).");
});

test('collapses the res.json()-on-HTML SyntaxError', () => {
  const e = new SyntaxError(`Unexpected token '<', "<!DOCTYPE "... is not valid JSON`);
  assert.equal(cleanErrorMessage(e), "Can't reach the server right now. Please retry.");
});

test('passes a normal short message through unchanged', () => {
  assert.equal(cleanErrorMessage('Row not found'), 'Row not found');
});

test('uses the fallback for null / empty', () => {
  assert.equal(cleanErrorMessage(null, 'Failed to load'), 'Failed to load');
  assert.equal(cleanErrorMessage('   ', 'Failed to load'), 'Failed to load');
});

test('reads an Error object message', () => {
  assert.equal(cleanErrorMessage(new Error('boom')), 'boom');
});

test('HTML with no detectable status → generic retry line', () => {
  assert.equal(
    cleanErrorMessage('<html><body>cf-error web server is down</body></html>'),
    "Can't reach the server right now. Please retry.",
  );
});

test('hard-caps an undetected giant body', () => {
  const out = cleanErrorMessage('x'.repeat(500));
  assert.ok(out.length <= 200, `expected <=200, got ${out.length}`);
  assert.ok(out.endsWith('…'));
});

test('helper predicates', () => {
  assert.equal(looksLikeHtmlError(CF_522), true);
  assert.equal(looksLikeHtmlError('a normal message'), false);
  assert.equal(detectHttpStatus(CF_522), 522);
  assert.equal(detectHttpStatus('no code here'), null);
});
