import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  MAX_RASTER_WIDTH,
  PDF_SIGNATURE_MAX_HEIGHTS,
  RASTER_PADDING,
  TYPED_EXPORT_HEIGHT,
  exceedsSignatureBudget,
  planRasterAttempts,
  planSignatureRaster,
} from './signature-render';
import { MAX_SIGNATURE_DATA_URL_CHARS } from './types';

test('the export raster is taller than BOTH PDF caps, so a typed signature is always downscaled', () => {
  // Both renderers clamp with Math.min(..., 1) and never upscale, so a raster
  // at or below these heights would render soft and undersized.
  for (const [where, cap] of Object.entries(PDF_SIGNATURE_MAX_HEIGHTS)) {
    assert.ok(
      TYPED_EXPORT_HEIGHT > cap,
      `${where}: raster ${TYPED_EXPORT_HEIGHT} must exceed the ${cap}pt cap`,
    );
  }
  // And by a real margin — not one pixel over.
  assert.ok(TYPED_EXPORT_HEIGHT >= PDF_SIGNATURE_MAX_HEIGHTS.certificationPage * 2);
});

test('even the smallest fallback attempt still clears both caps', () => {
  const smallest = Math.min(...planRasterAttempts());
  for (const cap of Object.values(PDF_SIGNATURE_MAX_HEIGHTS)) {
    assert.ok(smallest > cap, `shrinking to ${smallest} would upscale past the ${cap}pt cap`);
  }
});

/** The scale each PDF renderer would apply — the exact expression at
 *  coe-document.ts:452 and sign-pdf.ts:234. */
function pdfScale(plan: { width: number; height: number }, maxW: number, maxH: number): number {
  return Math.min(maxW / plan.width, maxH / plan.height, 1);
}

test('THE REAL INVARIANT: no plan is ever upscaled by either renderer', () => {
  // Height alone does not settle this — a width-capped plan can come out
  // shorter than the 46pt cap and still be safe, because the PDF is width-
  // limited too. So assert the thing that actually matters.
  for (const aspect of [0.5, 1, 3, 6, 9, 12, 15, 20, 40, 100]) {
    for (const target of planRasterAttempts()) {
      const plan = planSignatureRaster({ width: 100 * aspect, height: 100 }, target);
      assert.ok(
        pdfScale(plan, 196, PDF_SIGNATURE_MAX_HEIGHTS.coeBlock) < 1,
        `COE would upscale aspect ${aspect} @ ${target}`,
      );
      assert.ok(
        pdfScale(plan, 210, PDF_SIGNATURE_MAX_HEIGHTS.certificationPage) < 1,
        `certification page would upscale aspect ${aspect} @ ${target}`,
      );
    }
  }
});

test('realistic cursive names never hit the width cap', () => {
  // Cursive full names run roughly 8:1 to 12:1. Capping costs ink height, so
  // the ceiling must sit above that band, not inside it.
  for (const aspect of [8, 10, 12]) {
    const plan = planSignatureRaster({ width: 100 * aspect, height: 100 });
    assert.ok(
      plan.width < MAX_RASTER_WIDTH,
      `aspect ${aspect}:1 hit the cap at width ${plan.width} — long names would render small`,
    );
    assert.equal(
      plan.height,
      TYPED_EXPORT_HEIGHT + RASTER_PADDING * 2,
      `aspect ${aspect}:1 lost ink height to the cap`,
    );
  }
});

test('a normal name fits its target height exactly', () => {
  const plan = planSignatureRaster({ width: 300, height: 100 });
  assert.equal(plan.height, TYPED_EXPORT_HEIGHT + RASTER_PADDING * 2);
  assert.equal(plan.scale, TYPED_EXPORT_HEIGHT / 100);
  assert.equal(plan.offsetX, RASTER_PADDING);
});

test('an absurdly long name shrinks in HEIGHT rather than growing past the width ceiling', () => {
  const plan = planSignatureRaster({ width: 8000, height: 100 });
  assert.ok(plan.width <= MAX_RASTER_WIDTH, `width ran to ${plan.width}`);
  assert.ok(
    plan.height < TYPED_EXPORT_HEIGHT + RASTER_PADDING * 2,
    'a width-capped name must come out shorter, not clipped',
  );
  assert.ok(Math.abs(plan.scale - (MAX_RASTER_WIDTH - RASTER_PADDING * 2) / 8000) < 1e-9);
});

test('aspect ratio survives both branches', () => {
  for (const ink of [
    { width: 300, height: 100 },
    { width: 8000, height: 100 },
  ]) {
    const plan = planSignatureRaster(ink);
    const drawnW = plan.width - RASTER_PADDING * 2;
    const drawnH = plan.height - RASTER_PADDING * 2;
    const want = ink.width / ink.height;
    const got = drawnW / drawnH;
    // Relative tolerance — the dims are rounded to whole pixels, and at an
    // aspect of 80 one pixel of rounding is worth a whole unit of ratio.
    assert.ok(
      Math.abs(got - want) / want < 0.02,
      `distorted: ${drawnW}x${drawnH} (${got.toFixed(2)}:1) from ${ink.width}x${ink.height} (${want}:1)`,
    );
  }
});

test('degenerate ink boxes never produce a zero-sized raster', () => {
  for (const ink of [
    { width: 0, height: 0 },
    { width: -5, height: 2 },
  ]) {
    const plan = planSignatureRaster(ink);
    assert.ok(plan.width >= 1 && plan.height >= 1);
    assert.ok(Number.isFinite(plan.scale) && plan.scale > 0);
  }
});

test('attempts descend, so each retry is strictly smaller', () => {
  const attempts = planRasterAttempts();
  assert.ok(attempts.length >= 2);
  for (let i = 1; i < attempts.length; i += 1) {
    assert.ok(attempts[i] < attempts[i - 1], 'attempts must strictly descend');
  }
  assert.equal(attempts[0], TYPED_EXPORT_HEIGHT);
});

test('the budget check matches the limit the server actually enforces', () => {
  assert.equal(exceedsSignatureBudget('x'.repeat(MAX_SIGNATURE_DATA_URL_CHARS)), false);
  assert.equal(exceedsSignatureBudget('x'.repeat(MAX_SIGNATURE_DATA_URL_CHARS + 1)), true);
});
