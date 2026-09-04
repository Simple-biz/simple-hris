import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { ID_CARD_COLORS, ID_CARD_GEOMETRY, idCardFileName, trackedTotalWidth, wrapToLines } from './id-card-render';

/** Stand-in measurer: every character is 1 unit wide. */
const measure = (s: string) => s.length;

/* ── wrapping: the address must never be truncated ── */

test('a short value stays on one line', () => {
  assert.deepEqual(wrapToLines('Quezon City', 40, measure), ['Quezon City']);
});

test('a long address wraps instead of overflowing', () => {
  const lines = wrapToLines('28 Katipunan Ave, Brgy. Loyola Heights, Quezon City, Metro Manila 1108', 30, measure);
  assert.ok(lines.length > 1);
  lines.forEach((l) => assert.ok(measure(l) <= 30, `line too wide: ${l}`));
});

test('wrapping loses no words — the whole address survives', () => {
  const text = '28 Katipunan Ave, Brgy. Loyola Heights, Quezon City, Metro Manila 1108';
  const lines = wrapToLines(text, 30, measure);
  assert.equal(lines.join(' '), text);
});

test('a single word wider than the line gets its own line rather than being cut', () => {
  const lines = wrapToLines('Supercalifragilisticexpialidocious st', 10, measure);
  assert.equal(lines[0], 'Supercalifragilisticexpialidocious');
  assert.equal(lines.join(' '), 'Supercalifragilisticexpialidocious st');
});

test('empty text produces no lines rather than one blank one', () => {
  assert.deepEqual(wrapToLines('', 40, measure), []);
  assert.deepEqual(wrapToLines('   ', 40, measure), []);
});

test('runs of whitespace collapse instead of producing empty words', () => {
  assert.deepEqual(wrapToLines('Quezon    City', 40, measure), ['Quezon City']);
});

/* ── filename ── */

test('the serial names the file', () => {
  assert.equal(idCardFileName({ employeeId: '2405-0012', name: 'Maria Elena Santos' }), 'simple-id-2405-0012.png');
});

test('no serial falls back to the name', () => {
  assert.equal(idCardFileName({ employeeId: null, name: 'Maria Elena Santos' }), 'simple-id-maria-elena-santos.png');
});

test('a name with characters a filesystem rejects is slugged, not passed through', () => {
  const out = idCardFileName({ employeeId: null, name: 'Ana "Nena" Cruz/Reyes' });
  assert.equal(out, 'simple-id-ana-nena-cruz-reyes.png');
  assert.ok(!/["/\\:*?<>|]/.test(out));
});

test('a name with no Latin characters still yields a saveable filename', () => {
  const out = idCardFileName({ employeeId: null, name: '山田太郎' });
  assert.equal(out, 'simple-id-card.png');
  assert.ok(out.endsWith('.png'));
});

test('an absurdly long name cannot produce an unbounded filename', () => {
  const out = idCardFileName({ employeeId: null, name: 'a'.repeat(500) });
  assert.ok(out.length <= 'simple-id-.png'.length + 48);
});

/* ── geometry: the numbers the component's literal classes mirror ── */

test('the card keeps the CR80 upright ratio', () => {
  const ratio = ID_CARD_GEOMETRY.height / ID_CARD_GEOMETRY.width;
  assert.ok(Math.abs(ratio - 85.6 / 54) < 1e-9);
});

test('the record block cannot reach the footer band', () => {
  const { height, padding, footer } = ID_CARD_GEOMETRY;
  const contentBottom = height - padding.bottom;
  const bandTop = height - footer.height;
  assert.ok(
    contentBottom < bandTop,
    `content bottom ${contentBottom} must sit above the band top ${bandTop}`,
  );
});

test('the export scale is above 1 so the file is not a blurry thumbnail', () => {
  assert.ok(ID_CARD_GEOMETRY.scale >= 2);
});

test('orange is present as a fill colour but navy carries the labels', () => {
  assert.equal(ID_CARD_COLORS.orange, '#F26F07');
  assert.equal(ID_CARD_COLORS.navy, '#27285A');
  assert.notEqual(ID_CARD_COLORS.value, ID_CARD_COLORS.orange);
  assert.notEqual(ID_CARD_COLORS.missing, ID_CARD_COLORS.orange);
});

/* ── tracked text: the bug that shipped in the first PNG ── */

test('tracking adds a gap BETWEEN glyphs only, never a trailing one', () => {
  // 3 glyphs of 10 + 2 gaps of 12 * 0.05
  assert.equal(trackedTotalWidth([10, 10, 10], 12, 0.05), 31.2);
});

test('a single glyph carries no tracking at all', () => {
  assert.equal(trackedTotalWidth([10], 12, 0.5), 10);
});

test('an empty run has no width', () => {
  assert.equal(trackedTotalWidth([], 12, 0.2), 0);
});

test('the gap scales with the FONT SIZE, not the font weight', () => {
  // The shipped bug read the size back off ctx.font, which the canvas normalises
  // to "600 12.65px ...", so parseFloat returned the WEIGHT. At size 12.65 and
  // tracking 0.05 one gap is 0.63px; at "600" it was 30px, and the footer serial
  // ran straight across the EMPLOYEE ID label.
  const correct = trackedTotalWidth([7, 7], 12.65, 0.05);
  const weightAsSize = trackedTotalWidth([7, 7], 600, 0.05);
  assert.ok(Math.abs(correct - 14.6325) < 1e-9);
  assert.ok(weightAsSize > correct * 2, 'the two must not be confusable');
});

test('the footer serial fits between the card edges instead of overlapping itself', () => {
  const { serial, padding, width } = ID_CARD_GEOMETRY;
  // Rough advances: bold sans ~0.62em, mono ~0.6em. Generous on purpose — this
  // guards the ORDER of magnitude, which is what the shipped bug got wrong.
  const label = 'EMPLOYEE ID';
  const value = '2511-0006';
  const labelRun = trackedTotalWidth(
    Array.from(label, () => serial.labelSize * 0.62),
    serial.labelSize,
    serial.labelTracking,
  );
  const valueRun = trackedTotalWidth(
    Array.from(value, () => serial.valueSize * 0.6),
    serial.valueSize,
    0.05,
  );
  const available = width - padding.x * 2;
  assert.ok(
    labelRun + valueRun < available,
    `serial runs ${labelRun + valueRun} must fit in ${available}`,
  );
});

test('the font size is never read back off ctx.font', () => {
  // ctx.font is normalised by the canvas: weight 700 comes back as the keyword
  // "bold" (parseFloat -> NaN) and weight 600 as "600" (parseFloat -> 600). Both
  // readings are wrong; one was merely survivable. Sizes are passed explicitly.
  const src = readFileSync(new URL('./id-card-render.ts', import.meta.url), 'utf8');
  assert.ok(!/parseFloat\s*\(\s*ctx\.font/.test(src), 'ctx.font must not be parsed for a size');
});
