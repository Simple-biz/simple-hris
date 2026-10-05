import test from 'node:test';
import assert from 'node:assert/strict';
import { intersectBoxes, isClipped, placePopup, toContainingBlock, type Box } from './popup-placement';

const VIEWPORT: Box = { top: 0, left: 0, right: 1280, bottom: 800 };
const box = (top: number, left: number, w: number, h: number): Box => ({ top, left, right: left + w, bottom: top + h });

// ── isClipped ────────────────────────────────────────────────────────────────

test('a menu that fits inside its scrolling card is not clipped', () => {
  const card = box(100, 100, 400, 400);
  assert.equal(isClipped(box(150, 120, 200, 224), [card]), false);
});

test('a calendar that runs past the bottom of a scrolling dialog body is clipped', () => {
  // The DatePicker case: a 360px calendar under a trigger 80px above the body's bottom edge.
  const dialogBody = box(100, 100, 500, 400);
  assert.equal(isClipped(box(428, 120, 304, 360), [dialogBody]), true);
});

test('a menu that spills sideways out of an overflow-x table wrapper is clipped', () => {
  const tableScroller = box(0, 0, 600, 800);
  assert.equal(isClipped(box(200, 480, 180, 120), [tableScroller]), true);
});

test('any one clipping ancestor is enough, however many others fit', () => {
  const roomy = box(0, 0, 1280, 800);
  const tight = box(100, 100, 300, 100);
  assert.equal(isClipped(box(150, 120, 200, 224), [roomy, tight]), true);
});

test('sub-pixel overhang within the tolerance does not count as clipped', () => {
  const card = box(0, 0, 400, 400);
  assert.equal(isClipped({ top: 10, left: 10, right: 400.6, bottom: 400.4 }, [card]), false);
  assert.equal(isClipped({ top: 10, left: 10, right: 402, bottom: 300 }, [card]), true);
});

test('no clipping ancestors means never clipped', () => {
  assert.equal(isClipped(box(5000, 5000, 10, 10), []), false);
});

// ── placePopup ───────────────────────────────────────────────────────────────

const place = (anchor: Box, width: number, height: number, extra: Partial<Parameters<typeof placePopup>[0]> = {}) =>
  placePopup({ anchor, width, height, bounds: VIEWPORT, align: 'start', gap: 6, pad: 8, ...extra });

test('opens below the trigger when it fits there', () => {
  const p = place(box(100, 50, 200, 36), 200, 240);
  assert.deepEqual(p, { top: 142, left: 50, up: false, maxHeight: null });
});

test('flips above when it does not fit below but fits above', () => {
  const p = place(box(600, 50, 200, 36), 200, 300);
  assert.equal(p.up, true);
  assert.equal(p.top, 600 - 6 - 300);
  assert.equal(p.maxHeight, null);
});

test('stays below when it fits on neither side but below is roomier, capped to the room', () => {
  // Below: 800 - 8 - (336 + 6) = 450 · above: 300 - 6 - 8 = 286 · popup 600 tall.
  const p = place(box(300, 50, 200, 36), 200, 600);
  assert.equal(p.up, false);
  assert.equal(p.maxHeight, 450);
  assert.equal(p.top, 342);
});

test('goes above, capped, when it fits on neither side and above is roomier', () => {
  // Below: 800 - 8 - (736 + 6) = 50 · above: 700 - 6 - 8 = 686 · popup 900 tall.
  const p = place(box(700, 50, 200, 36), 200, 900);
  assert.equal(p.up, true);
  assert.equal(p.maxHeight, 686);
  assert.equal(p.top, 700 - 6 - 686);
});

test('never returns a negative cap for a trigger scrolled off-screen', () => {
  const p = place(box(-200, 50, 200, 36), 200, 300, { bounds: { top: 0, left: 0, right: 1280, bottom: 100 } });
  assert.ok(p.maxHeight === null || p.maxHeight >= 0);
});

test('align end lines up the right edges', () => {
  const p = place(box(100, 400, 120, 26), 220, 200, { align: 'end' });
  assert.equal(p.left, 400 + 120 - 220);
});

test('slides left to stay inside the right edge', () => {
  const p = place(box(100, 1200, 60, 36), 304, 360);
  assert.equal(p.left, 1280 - 8 - 304);
});

test('slides right to stay inside the left edge (align end near the left edge, a phone)', () => {
  const p = place(box(100, 10, 80, 26), 220, 200, { align: 'end', bounds: { top: 0, left: 0, right: 390, bottom: 844 } });
  assert.equal(p.left, 8);
});

test('a popup wider than the bounds starts at the left pad, not off-screen', () => {
  const p = place(box(100, 100, 80, 36), 576, 360, { bounds: { top: 0, left: 0, right: 390, bottom: 844 } });
  assert.equal(p.left, 8);
});

test('respects a clipping host as the bounds, not just the viewport', () => {
  // A dialog that hides its overflow, 300px tall: the calendar must flip inside it.
  const host = box(200, 300, 500, 300);
  const bounds = intersectBoxes(VIEWPORT, host);
  const p = place(box(440, 320, 200, 36), 304, 200, { bounds });
  // Below: 500 - 8 - 482 = 10 · above: 440 - 6 - 208 = 226 → up.
  assert.equal(p.up, true);
  assert.equal(p.top, 440 - 6 - 200);
});

// ── toContainingBlock ────────────────────────────────────────────────────────

test('subtracts the containing block offset and border, and adds back its scroll', () => {
  const p = toContainingBlock({ top: 500, left: 300 }, { rect: { top: 100, left: 200 }, clientTop: 1, clientLeft: 1, scrollTop: 240, scrollLeft: 0 });
  // A dialog scrolled 240px: the absolute child sits 240px further down its content.
  assert.deepEqual(p, { top: 500 - 100 - 1 + 240, left: 300 - 200 - 1 });
});

test('intersectBoxes takes the overlap', () => {
  assert.deepEqual(intersectBoxes(box(0, 0, 100, 100), box(50, 20, 100, 100)), { top: 50, left: 20, right: 100, bottom: 100 });
});
