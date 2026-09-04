import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ID_CARD_COLORS, ID_CARD_GEOMETRY, idCardFileName, wrapToLines } from './id-card-render';

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
