import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { decodePng, dominantInkColor } from '@/lib/images/decode-png';
import {
  ALLOWED_BANK_PUBLIC_LOGO_SRCS,
  BANK_BRAND_SWATCH_SRC,
  BANK_LOGO_SRC,
  OFFICIAL_BANKS,
  bankBrandArtworkSrc,
  bankKeysWithBrandArtwork,
  officialKeyFor,
} from './banks';
import {
  BANK_BRAND_HEX,
  CARD_TEXT_CONTRAST_FLOOR,
  bankCardInk,
  bankCardPalette,
  contrastRatio,
} from './bank-card-palette';

const publicPath = (src: string) => path.join(process.cwd(), 'public', src.replace(/^\//, ''));
const hex = (n: number) => n.toString(16).padStart(2, '0');

test('every declared brand colour is the one MEASURED off that bank’s shipped artwork', () => {
  // The whole discipline of this table. A hand-edited value, refreshed artwork nobody
  // re-derived, or a colour recalled from memory all land here instead of shipping a
  // bank's card in another bank's colour. Re-run scripts/derive-bank-brand-colors.mts.
  //
  // "Artwork" is the bank's SWATCH where it has one, else its logo — the same resolver
  // the derive script uses, so the table and the script cannot disagree about which
  // file answered. Dropping a bank's swatch entry does not quietly revert its colour
  // to its logo's: the re-derived value stops matching and this fails.
  for (const key of bankKeysWithBrandArtwork()) {
    const src = bankBrandArtworkSrc(key)!;
    const file = publicPath(src);
    assert.ok(fs.existsSync(file), `${key}: ${src} is missing`);
    const ink = dominantInkColor(decodePng(fs.readFileSync(file), key));
    assert.ok(ink, `${key}: its artwork has no ink at all`);
    const measured = `#${hex(ink.r)}${hex(ink.g)}${hex(ink.b)}`;
    assert.equal(
      BANK_BRAND_HEX[key],
      measured,
      `${key}: table says ${BANK_BRAND_HEX[key]}, ${src} says ${measured}`,
    );
  }
});

test('a bank colour exists for exactly the banks that ship artwork of either kind', () => {
  // Neither direction is allowed to drift: a colour without artwork is a colour
  // nobody measured, and artwork without a colour silently gets the neutral card.
  assert.deepEqual(Object.keys(BANK_BRAND_HEX).sort(), bankKeysWithBrandArtwork());
});

test('a swatch is a colour source, never something the catalog can draw', () => {
  // A swatch is a brand tile or banner — a solid ground with a wordmark on it. Drawn
  // on the catalog's white plate it would read as a coloured sticker beside 23 clean
  // lockups, and a registry row pointing at one would ship that. The logo map is the
  // only thing a bank row may reference, so the two must not overlap.
  for (const [key, src] of Object.entries(BANK_BRAND_SWATCH_SRC)) {
    assert.ok(fs.existsSync(publicPath(src)), `${key}: swatch ${src} is missing`);
    assert.notEqual(src, BANK_LOGO_SRC[key], `${key}: a swatch must not double as the logo`);
    assert.equal(
      ALLOWED_BANK_PUBLIC_LOGO_SRCS.has(src),
      false,
      `${key}: swatch ${src} is reachable as a bank row's logo`,
    );
  }
});

test('every card face carries white text at or above the floor', () => {
  for (const key of Object.keys(BANK_BRAND_HEX)) {
    const p = bankCardPalette(key);
    const ratio = contrastRatio(p.surface, '#ffffff');
    assert.ok(
      ratio >= CARD_TEXT_CONTRAST_FLOOR,
      `${key}: white on ${p.surface} is ${ratio.toFixed(2)}:1, under ${CARD_TEXT_CONTRAST_FLOOR}`,
    );
    // The deeper stop of the gradient is darker still, so the account number stays
    // readable wherever it lands on the face.
    assert.ok(
      contrastRatio(p.surfaceDeep, '#ffffff') >= CARD_TEXT_CONTRAST_FLOOR,
      `${key}: the deep stop ${p.surfaceDeep} is lighter than the floor`,
    );
  }
});

test('the tinted label ink still clears AA on every card', () => {
  // Labels are mixed toward the surface rather than set to a grey. That is a real
  // contrast risk, so it is measured rather than assumed — on the neutral card too.
  for (const key of [...Object.keys(BANK_BRAND_HEX), null]) {
    const p = bankCardPalette(key);
    const ink = bankCardInk(p);
    const levels: [string, string, number][] = [
      ['secondary', ink.secondary, 6],
      ['label', ink.label, 4.5],
    ];
    for (const [name, colour, floor] of levels) {
      const ratio = contrastRatio(p.surface, colour);
      assert.ok(ratio >= floor, `${key ?? 'neutral'}: ${name} ink is ${ratio.toFixed(2)}:1, under ${floor}`);
      // …and it must actually be tinted, not silently collapsed back to plain white.
      assert.ok(colour !== '#ffffff', `${key ?? 'neutral'}: ${name} ink fell back to pure white`);
    }
  }
});

test('a light brand keeps its hue instead of flipping to dark ink', () => {
  // Maybank gold, Maya mint, BanKo amber and LandBank green cannot host white text at
  // their own lightness. They are darkened along their OWN hue, never desaturated to
  // charcoal and never given a different text colour from the rest of the set.
  const pairs: [string, number, number][] = [
    // key, hue floor, hue ceiling (degrees) — the band the brand must stay inside.
    ['maybank', 35, 60],
    ['maya', 120, 165],
    ['landbank', 75, 115],
    ['unionbank', 20, 40],
    ['bpi', 350, 365],
  ];
  for (const [key, lo, hi] of pairs) {
    const surface = bankCardPalette(key).surface;
    const r = parseInt(surface.slice(1, 3), 16) / 255;
    const g = parseInt(surface.slice(3, 5), 16) / 255;
    const b = parseInt(surface.slice(5, 7), 16) / 255;
    const max = Math.max(r, g, b), min = Math.min(r, g, b), d = max - min;
    assert.ok(d > 0.02, `${key}: the face lost its hue entirely (${surface})`);
    let h = max === r ? ((g - b) / d) % 6 : max === g ? (b - r) / d + 2 : (r - g) / d + 4;
    h *= 60;
    if (h < 0) h += 360;
    const wrapped = h < lo && hi > 360 ? h + 360 : h;
    assert.ok(wrapped >= lo && wrapped <= hi, `${key}: face hue ${h.toFixed(0)}° left ${lo}–${hi}°`);
  }
});

test('two banks never share a card face', () => {
  // The card is how the bank is recognised before anything on it is read. Two banks
  // printing the same colour would quietly defeat that.
  const faces = new Map<string, string>();
  for (const key of Object.keys(BANK_BRAND_HEX)) {
    const surface = bankCardPalette(key).surface;
    const clash = faces.get(surface);
    assert.equal(clash, undefined, `${key} and ${clash} both print ${surface}`);
    faces.set(surface, key);
  }
});

test('an unknown, unmapped or null bank gets the NEUTRAL card, never a guessed colour', () => {
  // Metrobank, Security Bank and SeaBank ship no artwork on purpose; "Rizal Bank" is
  // claimed by nobody. None of them may be given a colour — that is the invented
  // equivalence the catalog docs forbid.
  //
  // MariBank was on this list until 2026-09-13, when Kane supplied a brand swatch and
  // its orange was MEASURED off it. It left because the fact changed, not the rule: a
  // bank is branded iff it ships artwork, and the test below derives that from the
  // artwork maps rather than from any list a person maintains here. MariBank still
  // ships no LOGO, so it draws the same generic glyph it always did.
  const neutral = bankCardPalette(null);
  assert.equal(neutral.branded, false);
  for (const spelling of ['Metrobank', 'Security Bank', 'SeaBank', 'Rizal Bank', 'Mark Anthony Padilla']) {
    const p = bankCardPalette(officialKeyFor(spelling));
    assert.equal(p.branded, false, `${spelling} must not be branded`);
    assert.equal(p.surface, neutral.surface, `${spelling} must print the neutral face`);
  }
  // And the neutral face is readable too.
  assert.ok(contrastRatio(neutral.surface, '#ffffff') >= CARD_TEXT_CONTRAST_FLOOR);
});

test('a bank that ships artwork is branded; one that does not is not', () => {
  // Branded means "has a MEASURED colour", which is artwork of either kind — not "has
  // a logo". MariBank is the case that separates them: no logo (§7 — a search returns
  // its parent Sea Group's mark), but a supplied swatch, so 104 people get its orange
  // card and the same generic Landmark glyph every artwork-less bank gets.
  const withArtwork = new Set(bankKeysWithBrandArtwork());
  for (const bank of OFFICIAL_BANKS) {
    assert.equal(
      bankCardPalette(bank.key).branded,
      withArtwork.has(bank.key),
      `${bank.name} (${bank.key})`,
    );
  }
});
