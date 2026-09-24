import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mailableEmail, normEmail } from './norm-email';

test('mailableEmail normalizes a real address', () => {
  assert.equal(mailableEmail('  AppleSider2013@Gmail.com '), 'applesider2013@gmail.com');
});

test('mailableEmail rejects a name typed into an email cell (breyl@, 2026-09-24)', () => {
  assert.equal(mailableEmail('breynald john lim'), null);
  // normEmail alone lets it through — that is the bug this guards.
  assert.equal(normEmail('breynald john lim'), 'breynald john lim');
});

test('mailableEmail rejects empty and malformed values', () => {
  for (const v of [null, undefined, '', '   ', 'no-at-sign.com', 'a@b', 'two words@x.com', '@x.com']) {
    assert.equal(mailableEmail(v), null, String(v));
  }
});
