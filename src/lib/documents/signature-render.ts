// Raster planning for the typed signature — the pure half of Type mode.
//
// The component measures the drawn glyphs with ctx.measureText() and hands the
// ink box here; this module decides how big the exported PNG is. Keeping it
// pure is what lets the two constraints below be asserted in tests instead of
// eyeballed, which matters because this environment has no PDF rasteriser.
//
// TWO CONSTRAINTS, BOTH INHERITED FROM CODE THIS FEATURE DOES NOT TOUCH
//
// 1. Neither PDF renderer will UPSCALE a signature. Both clamp with
//    `Math.min(maxW / w, maxH / h, 1)` — coe-document.ts:450 (maxH 46) and
//    sign-pdf.ts:232 (maxH 58). A typed PNG exported at CSS pixels would be
//    ~40 px tall and land as a postage stamp beside a drawn signature, which
//    exports at devicePixelRatio. So the raster is fixed well above both caps.
//
// 2. signatures.ts refuses a data URL over MAX_SIGNATURE_DATA_URL_CHARS
//    (types.ts:114 = 300 000). Its message — "draw it again with fewer
//    strokes" — is written for a drawing pad and is nonsense for typed text,
//    and a 400 from the save route is a bad place to discover the problem.
//    planRasterAttempts() steps the raster down so the dialog resolves it
//    before submitting.

import { MAX_SIGNATURE_DATA_URL_CHARS } from './types';

/**
 * Ink height of the exported PNG, in pixels.
 *
 * Chosen against the tighter of the two PDF caps: at 160 px the certification
 * page (max 58 pt) scales by 0.36 and the COE block (max 46 pt) by 0.29, so a
 * typed signature is always DOWNscaled — exactly like a drawn one — and can
 * never render soft or undersized. A test pins it above both caps.
 */
export const TYPED_EXPORT_HEIGHT = 160;

/**
 * Hard ceiling on raster width. Past it a name shrinks in height rather than
 * producing an ever-wider PNG.
 *
 * Set so REALISTIC names never reach it. Capping is not free: it drops the ink
 * below the target height, and the signature then renders small in the PDF. The
 * cap engages at an ink aspect ratio of
 * `(MAX_RASTER_WIDTH - 2·RASTER_PADDING) / TYPED_EXPORT_HEIGHT` ≈ 14.8:1, and
 * cursive full names run wide — roughly 8:1 to 12:1 — so 1600 (≈9.9:1) would
 * have caught long ones like "Christopher Villanueva". A test pins the
 * threshold above the realistic band.
 */
export const MAX_RASTER_WIDTH = 2400;

/** Transparent margin around the ink, in exported pixels. Mirrors the drawing
 *  pad's 8 px trim padding so the two modes seat identically in the PDF. */
export const RASTER_PADDING = 12;

export interface InkBox {
  /** Measured ink width in the measuring context's units. */
  width: number;
  /** Measured ink height (ascent + descent) in the same units. */
  height: number;
}

export interface RasterPlan {
  /** Canvas bitmap size for the export. */
  width: number;
  height: number;
  /** Multiplier from measuring units to export pixels. */
  scale: number;
  /** Where the ink's left edge / top sits inside the raster. */
  offsetX: number;
  offsetY: number;
}

/**
 * Fit a measured ink box into an export raster of `targetHeight` ink pixels.
 *
 * Because the ink box is measured rather than derived from font metrics, faces
 * with wildly different em usage (Homemade Apple draws roughly twice the height
 * of Great Vibes at the same font-size) come out visually matched without any
 * hand-tuned per-face constant being load-bearing.
 */
export function planSignatureRaster(
  ink: InkBox,
  targetHeight: number = TYPED_EXPORT_HEIGHT,
): RasterPlan {
  const inkW = Math.max(1, ink.width);
  const inkH = Math.max(1, ink.height);

  let scale = targetHeight / inkH;
  // A long name hits the width ceiling first and gets shorter, never wider.
  const widthAt = inkW * scale + RASTER_PADDING * 2;
  if (widthAt > MAX_RASTER_WIDTH) {
    scale = (MAX_RASTER_WIDTH - RASTER_PADDING * 2) / inkW;
  }

  return {
    width: Math.max(1, Math.round(inkW * scale + RASTER_PADDING * 2)),
    height: Math.max(1, Math.round(inkH * scale + RASTER_PADDING * 2)),
    scale,
    offsetX: RASTER_PADDING,
    offsetY: RASTER_PADDING,
  };
}

/**
 * Successive target heights to try when the encoded PNG overruns the column
 * budget. Descending, and every entry still clears both PDF caps — but callers
 * must handle "even the smallest was too big" rather than assuming success.
 */
export function planRasterAttempts(): number[] {
  return [TYPED_EXPORT_HEIGHT, 128, 104, 84, 68];
}

/** True when the data URL would be refused by upsertDocumentSignature. */
export function exceedsSignatureBudget(dataUrl: string): boolean {
  return dataUrl.length > MAX_SIGNATURE_DATA_URL_CHARS;
}

/** The PDF caps this module is sized against, kept here so the test that pins
 *  the relationship reads them from one place. */
export const PDF_SIGNATURE_MAX_HEIGHTS = {
  /** coe-document.ts:451 */
  coeBlock: 46,
  /** sign-pdf.ts:233 */
  certificationPage: 58,
} as const;
