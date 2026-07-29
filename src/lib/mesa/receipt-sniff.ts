/**
 * Content sniffing for MESA receipt uploads.
 *
 * Its own module (rather than living in ./receipts.ts) for two reasons: that file
 * is `server-only` and so can't be unit-tested under plain Node, and this is the
 * part worth testing — it is the gate that decides whether arbitrary bytes get
 * written into the receipts bucket.
 */

import { MESA_RECEIPT_MIME_TYPES, type MesaReceiptMime } from './receipt-types';

/**
 * The type of the bytes we were actually handed, read from the magic number —
 * NOT from the client's Content-Type, which is trivially spoofed and genuinely
 * wrong for iPhone HEIC uploads.
 *
 * Returns null when the content isn't one of the accepted formats, and that is
 * the rejection path: an executable renamed `receipt.pdf` never reaches the
 * bucket, and neither does an SVG (which is a script-execution vector when
 * served back to a browser) or a ZIP-based Office file.
 */
export function sniffReceiptMime(bytes: Uint8Array): MesaReceiptMime | null {
  // Every accepted format is identifiable within its first 12 bytes; anything
  // shorter than that cannot be a valid image or PDF.
  if (bytes.byteLength < 12) return null;
  const b = bytes;

  // PDF: '%PDF-'
  if (b[0] === 0x25 && b[1] === 0x50 && b[2] === 0x44 && b[3] === 0x46 && b[4] === 0x2d) {
    return 'application/pdf';
  }
  // JPEG (JFIF/Exif/raw): FF D8 FF
  if (b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff) return 'image/jpeg';
  // PNG: 89 'PNG' CR LF SUB LF
  if (
    b[0] === 0x89 && b[1] === 0x50 && b[2] === 0x4e && b[3] === 0x47 &&
    b[4] === 0x0d && b[5] === 0x0a && b[6] === 0x1a && b[7] === 0x0a
  ) {
    return 'image/png';
  }

  const ascii = (from: number, to: number) =>
    String.fromCharCode(...Array.from(b.slice(from, to)));

  // WEBP: 'RIFF' <u32 size> 'WEBP'
  if (ascii(0, 4) === 'RIFF' && ascii(8, 12) === 'WEBP') return 'image/webp';

  // HEIC / HEIF / AVIF: ISO-BMFF — 'ftyp' box at offset 4, brand at offset 8.
  // Unbranded ISO-BMFF (an .mp4, say) falls through to null rather than being
  // waved through as an image.
  if (ascii(4, 8) === 'ftyp') {
    const brand = ascii(8, 12).toLowerCase();
    if (brand.startsWith('hei') || brand === 'mif1' || brand === 'msf1') return 'image/heic';
    if (brand.startsWith('hev') || brand.startsWith('avif')) return 'image/heif';
    return null;
  }

  return null;
}

/** True when the sniffed type is one the receipts bucket accepts. Sanity check
 *  keeping the sniffer and the bucket's allowed_mime_types from drifting apart. */
export function isSniffedTypeAccepted(mime: string | null): boolean {
  return mime != null && (MESA_RECEIPT_MIME_TYPES as readonly string[]).includes(mime);
}
