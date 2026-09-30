import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';

import HrisNpdComparison from '@/components/payroll/HrisNpdComparison';
import { compareHrisNpd, parseNpdPaste, type CompareHrisNpdInput, type HrisCompareInput } from './hris-npd-compare';

// ── HRIS vs NPD, as rendered (Kane, 2026-09-30) ──────────────────────────────
//
// The spec is visual, so it is pinned on the markup: a match is a GREEN row with a
// check in Match; anything else is a RED row with an ✗, or "Not in HRIS" / "Not in
// NPD" for whoever is missing — and nobody is dropped. Plus the rule the spec
// implies: no colour and no verdict while the figures cannot be judged.

const FX = 61.52;
const phpFor = (dollars: number) => Math.round(dollars * FX * 100) / 100;

function hris(email: string, php: number): HrisCompareInput {
  return { email, name: email.split('@')[0], php, dispatchable: true, excluded: false };
}

function render(paste: string, over: Partial<CompareHrisNpdInput> = {}): string {
  const parse = parseNpdPaste(paste);
  const comparison = compareHrisNpd({
    hrisRows: [
      hris('kaner@simple.biz', phpFor(250)),
      hris('lorar@simple.biz', 17009.68),
      hris('hrisonly@simple.biz', phpFor(40)),
    ],
    npdRows: parse.rows,
    fxRate: FX,
    hrisState: 'settled',
    ...over,
  });
  return renderToStaticMarkup(
    React.createElement(HrisNpdComparison, {
      pasteText: paste,
      onPasteChange: () => {},
      parse,
      comparison,
      fxRate: over.fxRate ?? FX,
      hrisPeople: 3,
      periodLabel: 'hubstaff_2026-09-20_to_2026-09-26.csv',
    }),
  );
}

/** The markup of the one table row that contains `email`. */
function rowFor(html: string, email: string): string {
  const rows = html.split('<tr').slice(1).map((r) => `<tr${r.split('</tr>')[0]}`);
  const hit = rows.find((r) => r.includes(email));
  assert.ok(hit, `no row for ${email}`);
  return hit!;
}

const PASTE = ['kaner@simple.biz\t250.00', 'lorar@simple.biz\t279.17', 'npdonly@simple.biz\t12.00'].join('\n');

describe('HRIS vs NPD — rendered', () => {
  it('has exactly the four columns Kane named', () => {
    const html = render(PASTE);
    for (const h of ['Work Email', 'HRIS', 'NPD', 'Match?']) assert.ok(html.includes(`>${h}</th>`), h);
    assert.equal((html.match(/<th /g) ?? []).length, 4);
  });

  it('a match is a green row with a check', () => {
    const row = rowFor(render(PASTE), 'kaner@simple.biz');
    assert.match(row, /bg-emerald-100/);
    assert.doesNotMatch(row, /bg-rose-100/);
    assert.match(row, /<span class="sr-only">Match<\/span>/);
    assert.equal((row.match(/\$250\.00/g) ?? []).length, 2);
  });

  it('a mismatch is a red row with an ✗ and the difference', () => {
    const row = rowFor(render(PASTE), 'lorar@simple.biz');
    assert.match(row, /bg-rose-100/);
    assert.match(row, /<span class="sr-only">Mismatch<\/span>/);
    assert.match(row, /NPD \+\$2\.68/);
    assert.match(row, /implies ₱60\.93 per \$1/);
  });

  it('nobody is dropped: each missing side is labelled on a red row', () => {
    const html = render(PASTE);
    const npdOnly = rowFor(html, 'npdonly@simple.biz');
    assert.match(npdOnly, /bg-rose-100/);
    assert.match(npdOnly, />Not in HRIS</);
    const hrisOnly = rowFor(html, 'hrisonly@simple.biz');
    assert.match(hrisOnly, /bg-rose-100/);
    assert.match(hrisOnly, />Not in NPD</);
    assert.equal((html.match(/<tr class="(?:bg-emerald|bg-rose)/g) ?? []).length, 4);
  });

  it('holds its minimum width on a wrapper, never on the fixed-layout table (a phone would crush Work Email to nothing)', () => {
    const html = render(PASTE);
    assert.match(html, /<div class="min-w-\[560px\]"><table class="table-keep w-full table-fixed/);
    assert.doesNotMatch(html, /<table class="[^"]*min-w-/);
  });

  it('opts out of the site-wide phone card stack, which would repaint every row the card colour', () => {
    assert.match(render(PASTE), /<table class="table-keep /);
  });

  it('prints the divisor behind every HRIS dollar figure', () => {
    assert.match(render(PASTE), /₱61\.52<\/span> per \$1/);
  });

  it('while figures are loading: no colour, no verdict, and the banner says why', () => {
    const html = render(PASTE, { hrisState: 'pending' });
    assert.doesNotMatch(html, /bg-emerald-100|bg-rose-100/);
    assert.doesNotMatch(html, /sr-only">Match</);
    assert.match(html, /Reading this week/);
    assert.match(html, /skeleton-shimmer/);
    // …and the footer does not total figures that are still landing ($250 + $276.49 + $40).
    assert.doesNotMatch(html, /\$566\.49/);
    assert.match(render(PASTE), /\$566\.49/);
  });

  it('with the cycle rate still 0: no colour, no HRIS dollar figure, and the banner names Step 2', () => {
    const html = render(PASTE, { fxRate: 0 });
    assert.doesNotMatch(html, /bg-emerald-100/);
    assert.match(html, /USD→PHP rate is still 0/);
    assert.match(html, /Step 2/);
  });

  it('a failed input names itself', () => {
    const html = render(PASTE, { hrisState: 'unavailable', unavailableSources: ['additions'] });
    assert.match(html, /Couldn(?:&#x27;|')t load the Additions values/);
  });

  it('with nothing pasted there is no table — "absence is not zero"', () => {
    const html = render('');
    assert.doesNotMatch(html, /<table/);
    assert.match(html, /Paste NPD(?:&#x27;|')s figures to compare/);
  });
});
