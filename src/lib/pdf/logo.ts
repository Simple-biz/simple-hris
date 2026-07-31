// The Simple wordmark, for PDFs the HRIS issues.
//
// Server-rendered documents (the Certificate of Engagement, the signing
// certification page) cannot fetch `/simple-logo.png` the way the client-side
// pay-stub export does, so the PNG is embedded from a generated base64 module —
// see scripts/build-pdf-logo.mjs for why, and how to regenerate it.
//
// Embedding is best-effort. A letterhead is worth having but never worth failing
// a document over, so callers get `null` and fall back to setting the wordmark
// as type.

import type { PDFDocument, PDFImage } from 'pdf-lib';
import { SIMPLE_LOGO_PNG_BASE64, SIMPLE_LOGO_SIZE } from './assets/simple-logo';

export { SIMPLE_LOGO_SIZE };

function base64ToBytes(b64: string): Uint8Array {
  if (typeof Buffer !== 'undefined') return new Uint8Array(Buffer.from(b64, 'base64'));
  const bin = atob(b64);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i += 1) out[i] = bin.charCodeAt(i);
  return out;
}

/**
 * Embed the wordmark into `doc`. Returns null when the PNG can't be embedded,
 * which the caller should treat as "draw the wordmark as text instead".
 */
export async function embedSimpleLogo(doc: PDFDocument): Promise<PDFImage | null> {
  try {
    return await doc.embedPng(base64ToBytes(SIMPLE_LOGO_PNG_BASE64));
  } catch {
    return null;
  }
}

/**
 * Width for a target height, preserving the source aspect ratio.
 *
 * The artwork is 900x324 including the heart that sits ABOVE the wordmark, so
 * the visible letters are roughly 70% of the box height — pick a target height
 * with that in mind rather than matching a font size.
 */
export function simpleLogoWidthForHeight(height: number): number {
  return (SIMPLE_LOGO_SIZE.width / SIMPLE_LOGO_SIZE.height) * height;
}
