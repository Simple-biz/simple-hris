// Canvas geometry for the signature pad — the pure half of the drawing surface.
//
// WHY THIS IS A MODULE AND NOT TWO LINES INSIDE THE COMPONENT
// The pad used to size its bitmap from getBoundingClientRect() on mount. It is
// opened inside a Dialog that animates in with `zoom-in-[0.94]` +
// `slide-in-from-bottom-6` over 320ms (components/ui/dialog.tsx:58), so that
// call measured a TRANSFORMED box: the bitmap ended up spanning 0.94·W CSS
// units stretched across the displayed W, while pointer coordinates — taken
// later, from a settled rect — ranged 0..W. Ink landed at ~0.94x the pointer's
// distance from the left edge: no error at the left edge, ~6% of the pad width
// at the right (about a centimetre), plus the same again vertically. That is
// the "the pointer doesn't actually point properly to the ink" report.
//
// ResizeObserver could not save it: a CSS transform does not change the layout
// box it observes, so the wrong size stuck for the life of the dialog.
//
// Deferring the measurement past the animation is NOT the fix — it makes the
// symptom rarer while leaving browser page zoom and any future ancestor
// transform broken. Instead the geometry is computed here, from values the
// caller reads at the moment it needs them, and unit-tested with no DOM.

/** The canvas's LAYOUT size — `offsetWidth/offsetHeight`, which is unaffected by
 *  ancestor transforms — plus the device pixel ratio. */
export interface BitmapSizeInput {
  layoutWidth: number;
  layoutHeight: number;
  devicePixelRatio: number;
}

export interface BitmapSize {
  /** Bitmap pixels — what to assign to canvas.width / canvas.height. */
  width: number;
  height: number;
  /** CSS units the drawing surface spans once ctx.scale(dpr, dpr) is applied. */
  cssWidth: number;
  cssHeight: number;
  dpr: number;
}

/** Clamped so a hidden or not-yet-laid-out canvas can never produce a 0-sized
 *  bitmap (which throws on getImageData) or a multi-megapixel one on a silly
 *  devicePixelRatio. */
export function bitmapSizeFor({
  layoutWidth,
  layoutHeight,
  devicePixelRatio,
}: BitmapSizeInput): BitmapSize {
  const dpr = clamp(finiteOr(devicePixelRatio, 1), 1, 3);
  const cssWidth = Math.max(1, finiteOr(layoutWidth, 1));
  const cssHeight = Math.max(1, finiteOr(layoutHeight, 1));
  return {
    width: Math.max(1, Math.round(cssWidth * dpr)),
    height: Math.max(1, Math.round(cssHeight * dpr)),
    cssWidth,
    cssHeight,
    dpr,
  };
}

export interface PointFromEventInput {
  /** Pointer position in client coordinates. */
  clientX: number;
  clientY: number;
  /** The canvas's CURRENT getBoundingClientRect() — transformed, whatever it is. */
  rect: { left: number; top: number; width: number; height: number };
  /** CSS units the drawing surface spans, i.e. bitmap size ÷ dpr. */
  cssWidth: number;
  cssHeight: number;
}

/**
 * Map a pointer event to the canvas's own drawing coordinates.
 *
 * The ratio `cssWidth / rect.width` is what cancels an ancestor transform: when
 * the dialog is drawn at 94%, `rect.width` is 0.94x the layout width the bitmap
 * was sized from, and the division scales the pointer back up so the ink lands
 * under the cursor. At rest the ratio is 1 and this is the old arithmetic.
 *
 * Axes are divided independently — `slide-in-from-bottom-6` and page zoom do
 * not necessarily distort both by the same factor.
 */
export function canvasPointFromEvent({
  clientX,
  clientY,
  rect,
  cssWidth,
  cssHeight,
}: PointFromEventInput): { x: number; y: number } {
  const scaleX = rect.width > 0 ? cssWidth / rect.width : 1;
  const scaleY = rect.height > 0 ? cssHeight / rect.height : 1;
  return {
    x: (clientX - rect.left) * scaleX,
    y: (clientY - rect.top) * scaleY,
  };
}

function finiteOr(value: number, fallback: number): number {
  return Number.isFinite(value) && value > 0 ? value : fallback;
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}
