/**
 * MESA receipt URL shaping.
 *
 * Run:  npx tsx --test src/lib/mesa/receipt-types.test.ts
 *   (or `npm test`, which globs src/**\/*.test.ts)
 *
 * `mesaReceiptDownloadUrl` is the whole of the Download button in Accounting's
 * review gallery: `<a download>` is ignored cross-origin and receipts come off
 * the storage host, so the attachment has to be asked for in the query string.
 * A regression here doesn't error — the browser just navigates to the file
 * inline and Accounting quietly loses the ability to save one.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mesaReceiptDownloadUrl } from './receipt-types';

/** A signed URL always arrives with `?token=…`, so `&` is the normal case. */
const SIGNED = 'https://x.supabase.co/storage/v1/object/sign/mesa-receipts/a/1.jpg?token=abc';

test('appends download to a signed URL that already has a query', () => {
  assert.equal(mesaReceiptDownloadUrl(SIGNED, 'receipt.jpg'), `${SIGNED}&download=receipt.jpg`);
});

test('uses ? when the URL carries no query', () => {
  assert.equal(
    mesaReceiptDownloadUrl('https://x.supabase.co/a/1.jpg', 'receipt.jpg'),
    'https://x.supabase.co/a/1.jpg?download=receipt.jpg',
  );
});

test('encodes a file name with spaces and reserved characters', () => {
  assert.equal(
    mesaReceiptDownloadUrl(SIGNED, 'jan groceries & rent.pdf'),
    `${SIGNED}&download=jan%20groceries%20%26%20rent.pdf`,
  );
});

test('falls back to a bare download flag when the row has no file name', () => {
  // Storage still serves it as an attachment; only the saved name is its own.
  for (const name of [null, undefined, '   ']) {
    assert.equal(mesaReceiptDownloadUrl(SIGNED, name), `${SIGNED}&download`);
  }
});

test('a missing URL stays missing — the button renders disabled, not broken', () => {
  assert.equal(mesaReceiptDownloadUrl(null, 'receipt.jpg'), null);
  assert.equal(mesaReceiptDownloadUrl(undefined, 'receipt.jpg'), null);
  assert.equal(mesaReceiptDownloadUrl('', 'receipt.jpg'), null);
});
