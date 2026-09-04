import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { ID_CARD_COLORS, ID_CARD_GEOMETRY, ID_CARD_METAL, idCardFileName, trackedTotalWidth, wrapToLines } from './id-card-render';

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

/* ── the metal surface is a contrast budget, not a taste knob ── */

const channel = (c: number) => {
  const v = c / 255;
  return v <= 0.04045 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4;
};
const rgb = (hex: string) => {
  const n = parseInt(hex.slice(1), 16);
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255] as const;
};
const luminance = (hex: string) => {
  const [r, g, b] = rgb(hex);
  return 0.2126 * channel(r) + 0.7152 * channel(g) + 0.0722 * channel(b);
};
const contrast = (a: string, b: string) => {
  const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x);
  return (hi + 0.05) / (lo + 0.05);
};
/** White laid over a colour at `alpha` — what the sheen does to the metal. */
const litBy = (hex: string, alpha: number) => {
  const [r, g, b] = rgb(hex);
  const mix = (c: number) => Math.round(c + (255 - c) * alpha);
  return `#${[mix(r), mix(g), mix(b)].map((c) => c.toString(16).padStart(2, '0')).join('')}`;
};

test('the sheen at full strength still leaves white text on navy above AA', () => {
  // Worst case is the LIGHTEST navy stop under the brightest point of the sweep —
  // that is the pixel the footer serial can sit on.
  const lightestNavy = ID_CARD_METAL.navy[ID_CARD_METAL.navy.length - 3]![1] as string;
  const lit = litBy(lightestNavy, ID_CARD_METAL.sheenPeakAlpha);
  const ratio = contrast('#FFFFFF', lit);
  assert.ok(ratio >= 4.5, `white on the lit navy is ${ratio.toFixed(2)}:1, must be >= 4.5`);
});

test('raising the sheen cap past its budget would break that, which is why it is pinned', () => {
  const lightestNavy = ID_CARD_METAL.navy[ID_CARD_METAL.navy.length - 3]![1] as string;
  assert.ok(ID_CARD_METAL.sheenPeakAlpha <= 0.3, 'sheen peak alpha is a contrast budget');
  // Proof the bound is real and not decorative: go well past it and AA fails.
  assert.ok(contrast('#FFFFFF', litBy(lightestNavy, 0.55)) < 4.5);
});

test('the sweep stops at the footer band, which is where the only light-on-dark text lives', () => {
  const { sheen, height, footer } = ID_CARD_GEOMETRY;
  assert.ok(
    sheen.height <= height - footer.height,
    'the sheen region must not reach the band the serial sits on',
  );
});

test('the EMPLOYEE ID label clears AA on the band, which the sheen never lightens', () => {
  // Worst case is the lightest stop of the navy ramp, unlit — the sheen is
  // excluded from this surface by the bound above.
  const lightestNavy = ID_CARD_METAL.navy[ID_CARD_METAL.navy.length - 3]![1] as string;
  const ratio = contrast(ID_CARD_COLORS.onNavySoft, lightestNavy);
  assert.ok(ratio >= 4.5, `the EMPLOYEE ID label is ${ratio.toFixed(2)}:1, must be >= 4.5`);
});

test('that label would NOT have survived the sheen — which is why the bound exists', () => {
  const lightestNavy = ID_CARD_METAL.navy[ID_CARD_METAL.navy.length - 3]![1] as string;
  const lit = litBy(lightestNavy, ID_CARD_METAL.sheenPeakAlpha);
  assert.ok(contrast(ID_CARD_COLORS.onNavySoft, lit) < 4.5);
});

test('the component mirrors the sheen bound instead of spanning the whole card', () => {
  const src = readFileSync(
    new URL('../../components/employee/EmployeeIdCard.tsx', import.meta.url),
    'utf8',
  );
  const layer = /id-card-sheen[\s\S]{0,400}?/.test(src);
  assert.ok(layer, 'sheen layer present');
  assert.ok(/z-\[2\][^"]*h-\[89%\]/.test(src), 'the sheen layer must stop above the band');
});

test('"Not on file" ink clears AA on the darkest point of the silver body', () => {
  const darkestSilver = ID_CARD_METAL.silver[ID_CARD_METAL.silver.length - 1]![1] as string;
  const ratio = contrast(ID_CARD_COLORS.missing, darkestSilver);
  assert.ok(ratio >= 4.5, `missing-value ink is ${ratio.toFixed(2)}:1, must be >= 4.5`);
});

test('value ink clears AA on the darkest point of the silver body', () => {
  const darkestSilver = ID_CARD_METAL.silver[ID_CARD_METAL.silver.length - 1]![1] as string;
  assert.ok(contrast(ID_CARD_COLORS.value, darkestSilver) >= 4.5);
});

test('orange is never a text colour in the badge component', () => {
  // 2.95:1 on white — under AA even for large text. It is a fill, always.
  const src = readFileSync(
    new URL('../../components/employee/EmployeeIdCard.tsx', import.meta.url),
    'utf8',
  );
  assert.ok(!/text-\[#(F26F07|FF8B2D|D75E02)\]/i.test(src), 'orange must not colour text');
});

test('the badge component still declares no dark-mode variant', () => {
  const src = readFileSync(
    new URL('../../components/employee/EmployeeIdCard.tsx', import.meta.url),
    'utf8',
  );
  assert.ok(!/dark:/.test(src), 'the card never themes');
});

test('the sweep is stopped for viewers who ask for reduced motion', () => {
  const src = readFileSync(
    new URL('../../components/employee/EmployeeIdCard.tsx', import.meta.url),
    'utf8',
  );
  assert.ok(/prefers-reduced-motion/.test(src));
  assert.ok(/animation:\s*none/.test(src));
});
