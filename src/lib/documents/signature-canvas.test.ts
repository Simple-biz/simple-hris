import { test } from 'node:test';
import assert from 'node:assert/strict';
import { bitmapSizeFor, canvasPointFromEvent } from './signature-canvas';

const PAD_W = 640;
const PAD_H = 160;

/** The pad as it is laid out, and as the bitmap is sized. */
function size(dpr = 1) {
  return bitmapSizeFor({ layoutWidth: PAD_W, layoutHeight: PAD_H, devicePixelRatio: dpr });
}

/** A rect as the browser reports it while an ancestor is scaled by `k`, centred. */
function transformedRect(k: number, top = 0) {
  const width = PAD_W * k;
  const height = PAD_H * k;
  return { left: (PAD_W - width) / 2, top, width, height };
}

test('at rest the mapping is the plain rect arithmetic', () => {
  const { cssWidth, cssHeight } = size();
  const rect = { left: 100, top: 50, width: PAD_W, height: PAD_H };
  const pt = canvasPointFromEvent({ clientX: 420, clientY: 130, rect, cssWidth, cssHeight });
  assert.deepEqual(pt, { x: 320, y: 80 });
});

test('THE BUG: a dialog drawn at 0.94 no longer offsets the ink', () => {
  // The bitmap is sized from the LAYOUT box (unaffected by the transform)...
  const { cssWidth, cssHeight } = size();
  assert.equal(cssWidth, PAD_W);

  // ...while the pointer arrives against the transformed rect.
  const rect = transformedRect(0.94);

  // Pointer at the far right edge of what the user actually sees.
  const pt = canvasPointFromEvent({
    clientX: rect.left + rect.width,
    clientY: rect.top + rect.height,
    rect,
    cssWidth,
    cssHeight,
  });

  // It must map to the far right edge of the drawing surface, not to 0.94 of it.
  assert.ok(Math.abs(pt.x - PAD_W) < 1e-9, `x drifted to ${pt.x}`);
  assert.ok(Math.abs(pt.y - PAD_H) < 1e-9, `y drifted to ${pt.y}`);
});

test('the old arithmetic is what produced ~6% drift, growing left→right', () => {
  const rect = transformedRect(0.94);
  const naive = (clientX: number) => clientX - rect.left; // the pre-fix mapping
  const fixed = (clientX: number) =>
    canvasPointFromEvent({ clientX, clientY: 0, rect, cssWidth: PAD_W, cssHeight: PAD_H }).x;

  // At the left edge the two agree — which is why the bug reads as "fine here,
  // wrong over there" rather than as a constant offset.
  assert.ok(Math.abs(naive(rect.left) - fixed(rect.left)) < 1e-9);

  // At the right edge they diverge by ~6% of the pad width.
  const drift = fixed(rect.left + rect.width) - naive(rect.left + rect.width);
  assert.ok(drift > PAD_W * 0.05 && drift < PAD_W * 0.07, `drift was ${drift}`);
});

test('axes are corrected independently (slide-in moves y only)', () => {
  // A vertical-only distortion must not be applied to x.
  const rect = { left: 0, top: 24, width: PAD_W, height: PAD_H * 0.9 };
  const pt = canvasPointFromEvent({
    clientX: 320,
    clientY: 24 + PAD_H * 0.9,
    rect,
    cssWidth: PAD_W,
    cssHeight: PAD_H,
  });
  assert.equal(pt.x, 320);
  assert.ok(Math.abs(pt.y - PAD_H) < 1e-9);
});

test('browser page zoom is cancelled the same way', () => {
  const rect = transformedRect(1.25);
  const pt = canvasPointFromEvent({
    clientX: rect.left + rect.width / 2,
    clientY: rect.top + rect.height / 2,
    rect,
    cssWidth: PAD_W,
    cssHeight: PAD_H,
  });
  assert.ok(Math.abs(pt.x - PAD_W / 2) < 1e-9);
  assert.ok(Math.abs(pt.y - PAD_H / 2) < 1e-9);
});

test('a zero-width rect degrades to 1:1 instead of dividing by zero', () => {
  const rect = { left: 0, top: 0, width: 0, height: 0 };
  const pt = canvasPointFromEvent({ clientX: 12, clientY: 8, rect, cssWidth: PAD_W, cssHeight: PAD_H });
  assert.deepEqual(pt, { x: 12, y: 8 });
});

test('bitmap size multiplies the LAYOUT box by dpr, clamped', () => {
  assert.deepEqual(size(2), { width: 1280, height: 320, cssWidth: 640, cssHeight: 160, dpr: 2 });
  // Absurd ratios are capped so getImageData stays affordable.
  assert.equal(size(8).dpr, 3);
  // Sub-1 ratios never shrink the raster below CSS resolution.
  assert.equal(size(0.5).dpr, 1);
});

test('a not-yet-laid-out canvas never yields a 0-sized bitmap', () => {
  const s = bitmapSizeFor({ layoutWidth: 0, layoutHeight: 0, devicePixelRatio: NaN });
  assert.ok(s.width >= 1 && s.height >= 1);
  assert.equal(s.dpr, 1);
});
