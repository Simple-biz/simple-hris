/**
 * MESA receipt content sniffing.
 *
 * Run:  npx tsx --test src/lib/mesa/receipt-sniff.test.ts
 *   (or `npm test`, which globs src/**\/*.test.ts)
 *
 * These matter because sniffing is the ONLY thing standing between the receipts
 * bucket and whatever bytes a member (or someone with their session) posts at it.
 * The declared Content-Type is not consulted anywhere in the upload path, so a
 * regression here doesn't fail loudly — it silently starts accepting files.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { isSniffedTypeAccepted, sniffReceiptMime } from './receipt-sniff';
import { MESA_RECEIPT_MIME_TYPES } from './receipt-types';

/** Header bytes + filler, so every fixture clears the 12-byte minimum. */
function withHeader(head: number[], totalLength = 64): Uint8Array {
  const out = new Uint8Array(totalLength);
  out.set(head.slice(0, totalLength));
  return out;
}

const ascii = (s: string): number[] => Array.from(s, (c) => c.charCodeAt(0));

// ── Accepted formats ────────────────────────────────────────────────────────

test('PDF is recognized from %PDF-', () => {
  assert.equal(sniffReceiptMime(withHeader(ascii('%PDF-1.7\n%âãÏÓ'))), 'application/pdf');
});

test('JPEG is recognized from FF D8 FF (JFIF, Exif and raw variants)', () => {
  for (const fourth of [0xe0, 0xe1, 0xdb]) {
    assert.equal(sniffReceiptMime(withHeader([0xff, 0xd8, 0xff, fourth])), 'image/jpeg');
  }
});

test('PNG is recognized from its 8-byte signature', () => {
  assert.equal(
    sniffReceiptMime(withHeader([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])),
    'image/png',
  );
});

test('WEBP requires BOTH the RIFF container and the WEBP form', () => {
  const webp = withHeader([...ascii('RIFF'), 0x40, 0x00, 0x00, 0x00, ...ascii('WEBP')]);
  assert.equal(sniffReceiptMime(webp), 'image/webp');

  // A RIFF that is NOT WebP (e.g. a WAV) must not pass as an image.
  const wav = withHeader([...ascii('RIFF'), 0x40, 0x00, 0x00, 0x00, ...ascii('WAVE')]);
  assert.equal(sniffReceiptMime(wav), null);
});

test('HEIC/HEIF brands are recognized — iPhone photos arrive as these', () => {
  const ftyp = (brand: string) =>
    withHeader([0x00, 0x00, 0x00, 0x18, ...ascii('ftyp'), ...ascii(brand)]);
  for (const brand of ['heic', 'heix', 'mif1', 'msf1']) {
    assert.equal(sniffReceiptMime(ftyp(brand)), 'image/heic', `brand ${brand}`);
  }
  for (const brand of ['hevc', 'avif']) {
    assert.equal(sniffReceiptMime(ftyp(brand)), 'image/heif', `brand ${brand}`);
  }
});

test('every type the sniffer can return is one the bucket accepts', () => {
  // Guards against the sniffer and MESA_RECEIPT_MIME_TYPES drifting apart, which
  // would show up as an upload that passes validation then fails at the bucket.
  const returnable = [
    'application/pdf',
    'image/jpeg',
    'image/png',
    'image/webp',
    'image/heic',
    'image/heif',
  ];
  for (const mime of returnable) {
    assert.ok(isSniffedTypeAccepted(mime), `${mime} should be an accepted bucket type`);
  }
  assert.deepEqual([...MESA_RECEIPT_MIME_TYPES].sort(), [...returnable].sort());
});

// ── Rejected content ────────────────────────────────────────────────────────

test('an executable renamed receipt.pdf is rejected (the whole point)', () => {
  // Windows PE ('MZ') and ELF (0x7F 'ELF') — the filename is irrelevant here,
  // only the bytes are read.
  assert.equal(sniffReceiptMime(withHeader(ascii('MZ\x90\x00\x03\x00\x00\x00'))), null);
  assert.equal(sniffReceiptMime(withHeader([0x7f, ...ascii('ELF'), 0x02, 0x01, 0x01, 0x00])), null);
});

test('SVG is rejected — it is markup that can carry script, not a receipt', () => {
  assert.equal(sniffReceiptMime(withHeader(ascii('<svg xmlns="http://www.w3.org/2000/svg">'))), null);
  assert.equal(sniffReceiptMime(withHeader(ascii('<?xml version="1.0"?><svg>'))), null);
});

test('ZIP-based Office files and plain archives are rejected', () => {
  assert.equal(sniffReceiptMime(withHeader([0x50, 0x4b, 0x03, 0x04, 0x14, 0x00, 0x00, 0x00])), null);
});

test('GIF and TIFF are rejected — accepted list is JPG/PNG/WebP/HEIC/PDF only', () => {
  assert.equal(sniffReceiptMime(withHeader(ascii('GIF89a'))), null);
  assert.equal(sniffReceiptMime(withHeader([0x49, 0x49, 0x2a, 0x00, 0x08, 0x00, 0x00, 0x00])), null);
});

test('a PDF signature that is not at offset 0 is rejected', () => {
  // Prefixed content is how a polyglot smuggles one format inside another.
  const shifted = new Uint8Array(64);
  shifted.set(ascii('JUNK'), 0);
  shifted.set(ascii('%PDF-1.4'), 4);
  assert.equal(sniffReceiptMime(shifted), null);
});

test('empty and too-short buffers are rejected, never crash', () => {
  assert.equal(sniffReceiptMime(new Uint8Array(0)), null);
  // '%PDF-' alone is 5 bytes — under the 12-byte floor, so it cannot be judged.
  assert.equal(sniffReceiptMime(new Uint8Array(ascii('%PDF-'))), null);
  assert.equal(sniffReceiptMime(new Uint8Array(11)), null);
});

test('all-zero bytes are rejected', () => {
  assert.equal(sniffReceiptMime(new Uint8Array(64)), null);
});

test('isSniffedTypeAccepted rejects null and anything off the list', () => {
  assert.equal(isSniffedTypeAccepted(null), false);
  assert.equal(isSniffedTypeAccepted('image/svg+xml'), false);
  assert.equal(isSniffedTypeAccepted('image/gif'), false);
  assert.equal(isSniffedTypeAccepted('application/pdf'), true);
});
