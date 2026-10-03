import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';

import HrisNpdComparison, {
  type HrisNpdFeedProps,
  type HrisNpdSaveProps,
  type HrisNpdStep,
} from '@/components/payroll/HrisNpdComparison';
import {
  compareHrisNpd,
  parseNpdPaste,
  type CompareHrisNpdInput,
  type HrisCompareInput,
  type HrisNpdFilter,
} from './hris-npd-compare';

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

/** How the panel is mounted: which step (wizard state in the app; the output tests default
 *  to step 2), the display-only search / chip, and the full-screen levers. */
type Mount = {
  step?: HrisNpdStep;
  search?: string;
  filter?: HrisNpdFilter;
  fillHeight?: boolean;
  onOpenFullScreen?: () => void;
  /** Save output's state; defaults to a week with nothing saved and the button live. */
  save?: Partial<HrisNpdSaveProps>;
  /** NPD's locked sheets; defaults to a week where neither tab is locked (the paste is the input). */
  npdFeed?: Partial<HrisNpdFeedProps>;
};

/** Neither NPD tab locked: the paste is the input, exactly as before 2026-10-02. */
const NPD_NOT_LOCKED: HrisNpdFeedProps = {
  view: {
    state: 'ready',
    week: '2026-09-20',
    tabs: {
      all_departments: { state: 'unlocked', version: 1, rowCount: 3, updatedAt: null, updatedBy: null },
      hsl: { state: 'none' },
    },
    feed: null,
  },
  refreshing: false,
  lastError: null,
  checkedAt: null,
  onRefresh: () => {},
};

const NOT_SAVED: HrisNpdSaveProps = {
  latest: { state: 'ready', meta: null },
  disabledReason: null,
  saving: false,
  savedThisOutput: false,
  onSave: () => {},
};

function render(paste: string, over: Partial<CompareHrisNpdInput> = {}, mount: Mount = {}): string {
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
      npdFeed: { ...NPD_NOT_LOCKED, ...mount.npdFeed },
      comparison,
      fxRate: over.fxRate ?? FX,
      hrisPeople: 3,
      periodLabel: 'hubstaff_2026-09-20_to_2026-09-26.csv',
      step: mount.step ?? 'output',
      onStepChange: () => {},
      // The box shows the SAME tolerance the verdicts were given with, as in the wizard.
      toleranceCents: comparison.toleranceCents,
      onToleranceChange: () => {},
      search: mount.search ?? '',
      onSearchChange: () => {},
      filter: mount.filter ?? 'all',
      onFilterChange: () => {},
      save: { ...NOT_SAVED, ...mount.save },
      fillHeight: mount.fillHeight,
      onOpenFullScreen: mount.onOpenFullScreen,
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

  it('within 3 cents is a green row with a check — and the difference is still printed (Kane, 2026-09-30)', () => {
    const row = rowFor(render('kaner@simple.biz\t250.02'), 'kaner@simple.biz');
    assert.match(row, /bg-emerald-100/);
    assert.doesNotMatch(row, /bg-rose-100/);
    assert.match(row, /<span class="sr-only">Match<\/span>/);
    assert.match(row, /NPD \+\$0\.02/);
    assert.match(row, /Within 3¢, so counted as a match/);
  });

  it('an exact match prints no difference', () => {
    const row = rowFor(render(PASTE), 'kaner@simple.biz');
    assert.doesNotMatch(row, /NPD [+−]\$/);
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

  it('people configured not to be paid are not rows — and the output says how many, and why (Kane, 2026-09-30)', () => {
    const html = render(`${PASTE}\nexcl@simple.biz\t50.00\npaused@simple.biz\t9.00`, {
      hrisRows: [
        hris('kaner@simple.biz', phpFor(250)),
        { email: 'excl@simple.biz', name: 'Ex', php: phpFor(50), dispatchable: true, excluded: true },
      ],
      pausedEmails: new Set(['paused@simple.biz']),
    });
    const tableRows = html.split('<tr').slice(1).join('');
    assert.ok(!tableRows.includes('excl@simple.biz') && !tableRows.includes('paused@simple.biz'), 'left-out people must not be table rows');
    assert.match(html, /2 people not compared/);
    assert.match(html, /1 excluded on Final Pay · 1 in a department paused in Step 1 → Configuration/);
    assert.match(html, /NPD lists 2 of them/);
    assert.match(html, />Show who</);
    assert.doesNotMatch(html, /Excluded from pay/);
  });

  it('with nobody configured out, there is no "not compared" line', () => {
    assert.doesNotMatch(render(PASTE), /not compared/);
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

  it('with nothing pasted there is no table — "absence is not zero" — even if step 2 was asked for', () => {
    const html = render('', {}, { step: 'output' });
    assert.doesNotMatch(html, /<table/);
    assert.match(html, /<h3[^>]*>NPD Figures<\/h3>/);
    assert.match(html, /<textarea/);
  });
});

// ── The two steps (Kane, 2026-09-30: "separate the input from the output please hide the
// input" · "The NPD Figures lets make this the first step after that it will load the
// output where we can see the mismatches" · "add a search bar in the output") ──────────

/** The "Load output" button's opening tag. */
function loadOutputButton(html: string): string {
  const at = html.indexOf('Load output');
  assert.ok(at > 0, 'no Load output button');
  return html.slice(html.lastIndexOf('<button', at), at);
}

describe('HRIS vs NPD — step 1 NPD Figures, then step 2 Output', () => {
  it('step 1 is the input: the paste box, what was read, and Load output — no table', () => {
    const html = render(PASTE, {}, { step: 'input' });
    assert.match(html, /<textarea[^>]*aria-label="NPD work emails and dollar amounts"/);
    assert.match(html, /3 lines read/);
    assert.doesNotMatch(html, /<table/);
    assert.doesNotMatch(loadOutputButton(html), /disabled=""/);
    assert.match(html, /aria-current="step"[^>]*>[\s\S]*?NPD Figures/);
  });

  it('step 2 is the output with the input HIDDEN: no paste box, the table, and the rail summary', () => {
    const html = render(PASTE, {}, { step: 'output' });
    assert.doesNotMatch(html, /<textarea/);
    assert.match(html, /<table/);
    assert.match(html, /NPD Figures · 3 lines read/);
    assert.match(html, />Edit</);
  });

  it('hiding the input never hides a refused line: step 2 carries the skipped count', () => {
    const html = render(`${PASTE}\nbad@simple.biz\t₱1,000`, {}, { step: 'output' });
    assert.doesNotMatch(html, /<textarea/);
    assert.match(html, />1 skipped</);
  });

  it('step 1 lists every refused line with its line number and reason', () => {
    const html = render(`${PASTE}\nbad@simple.biz\t₱1,000`, {}, { step: 'input' });
    assert.match(html, /aria-label="Skipped lines"/);
    assert.match(html, />L4</);
    assert.match(html, /looks like pesos/);
  });

  it('with nothing readable, Load output and the Output step are disabled', () => {
    const html = render('only-garbage', {}, { step: 'input' });
    assert.match(loadOutputButton(html), /disabled=""/);
    const railOutput = html.slice(html.lastIndexOf('<button', html.indexOf('Output</button>')), html.indexOf('Output</button>'));
    assert.match(railOutput, /disabled=""/);
  });

  it('the "off by" box is at the TOP of the output (first after Load output), set to 3 by default', () => {
    const html = render(PASTE, {}, { step: 'output' });
    const box = html.indexOf('Count as a match when HRIS and NPD are off by at most');
    assert.ok(box > 0, 'no off-by box');
    assert.ok(box < html.indexOf('per $1') && box < html.indexOf('<table'), 'the box must sit above the rate line and the table');
    assert.match(html, /<input[^>]*type="number"[^>]*min="0"[^>]*max="99"[^>]*step="1"[^>]*value="3"/);
    assert.match(html, /Up to \$0\.03 either way/);
    assert.doesNotMatch(html, /Reset to 3¢/);
  });

  it('the box is on the output only, never on step 1', () => {
    assert.doesNotMatch(render(PASTE, {}, { step: 'input' }), /off by at most/);
  });

  it('a non-default setting shows the value the verdicts use, a Reset, and drives the "within N¢" wording', () => {
    const html = render('kaner@simple.biz\t250.01', { toleranceCents: 1 });
    assert.match(html, /value="1"/);
    assert.match(html, /Reset to 3¢/);
    assert.match(rowFor(html, 'kaner@simple.biz'), /Within 1¢, so counted as a match/);
    assert.match(render('kaner@simple.biz\t250.00', { toleranceCents: 0 }), /Only an exact match counts/);
  });

  it('the output has a full-width search bar directly above the table', () => {
    const html = render(PASTE, {}, { step: 'output' });
    const search = html.indexOf('aria-label="Search HRIS vs NPD"');
    const table = html.indexOf('<table');
    assert.ok(search > 0 && search < table, 'search must sit above the table');
    assert.match(html, /placeholder="Search the output by email or name…"/);
    assert.equal((html.match(/aria-label="Search HRIS vs NPD"/g) ?? []).length, 1);
  });
});

// ── The full-screen view (Kane, 2026-09-30: "please add this in the full screen view") ──
//
// The overlay renders THIS component from the SAME props object as the step, plus
// `fillHeight` — the rule the Final Pay table's full screen already keeps
// (payroll-wizard-manual-validation.md § Full screen is a portal). The search and the
// chip are the wizard's, so both mounts show the same slice.

describe('HRIS vs NPD — Save output (Kane, 2026-10-01)', () => {
  const META = {
    id: 'u',
    version: 2,
    savedAt: '2026-10-01T15:04:00Z',
    savedBy: 'alivia@simple.biz',
    toleranceCents: 3,
    rowCount: 4,
    leftOutCount: 1,
    counts: { match: 1, mismatch: 1, not_in_hris: 1, not_in_npd: 1 },
  };
  const button = (html: string) => {
    const m = /<button[^>]*>(?:(?!<\/button>)[\s\S])*?(Save output|Saved|Saving…)<\/button>/.exec(html);
    assert.ok(m, 'no Save output button');
    return m![0];
  };

  it('sits on the output, right under the "off by" box, and not on step 1', () => {
    const html = render(PASTE);
    const box = html.indexOf('Count as a match when HRIS and NPD are off by at most');
    const save = html.indexOf('Save output');
    const table = html.indexOf('<table');
    assert.ok(box > 0 && save > box && table > save, 'off-by box → Save output → table');
    // Step 1 may MENTION Save output in its copy; the bar and its button are output-only.
    const input = render(PASTE, {}, { step: 'input' });
    assert.doesNotMatch(input, /Save output<\/button>/);
    assert.doesNotMatch(input, /Not saved yet for this week/);
  });

  it('a week with nothing saved says so, and the button is live', () => {
    const html = render(PASTE);
    assert.match(html, /Not saved yet for this week\./);
    assert.doesNotMatch(button(html), /\sdisabled=""/);
  });

  it('names the last save: version, who, and what it held', () => {
    const html = render(PASTE, {}, { save: { latest: { state: 'ready', meta: META } } });
    assert.match(html, /Saved v2/);
    assert.match(html, /by alivia@simple\.biz/);
    assert.match(html, /1 match · 1 mismatch · 1 not in HRIS · 1 not in NPD · 1 not compared · off by 3¢/);
  });

  it('is OFF, with the reason beside it, when the output cannot be saved', () => {
    const html = render(PASTE, {}, { save: { disabledReason: 'This is a replay of a past week, so nothing is saved.' } });
    assert.match(button(html), /\sdisabled=""/);
    assert.match(html, /This is a replay of a past week, so nothing is saved\./);
  });

  it('reads "Saved" (and is off) once this exact output is the one on file', () => {
    const html = render(PASTE, {}, { save: { latest: { state: 'ready', meta: META }, savedThisOutput: true } });
    const b = button(html);
    assert.match(b, />Saved<\/button>|Saved<\/button>/);
    assert.match(b, /\sdisabled=""/);
  });

  it('a failed read is an error, never "not saved yet"', () => {
    const html = render(PASTE, {}, { save: { latest: { state: 'error', message: 'HTTP 500', notSetUp: false } } });
    assert.match(html, /Couldn&#x27;t read this week&#x27;s saved output: HTTP 500/);
    assert.doesNotMatch(html, /Not saved yet/);
    const pending = render(PASTE, {}, { save: { latest: { state: 'error', message: 'x', notSetUp: true } } });
    assert.match(pending, /the database migration is pending/);
  });

  it('while saving the button says so and cannot be clicked twice', () => {
    const b = button(render(PASTE, {}, { save: { saving: true } }));
    assert.match(b, /Saving…/);
    assert.match(b, /\sdisabled=""/);
  });
});

describe('HRIS vs NPD — full screen', () => {
  it('on the step the table is capped at ~62vh; in the overlay it fills the box instead', () => {
    const inline = render(PASTE);
    assert.match(inline, /max-height:min\(62vh, calc\(100dvh - 24rem\)\)/);
    const full = render(PASTE, {}, { fillHeight: true });
    assert.doesNotMatch(full, /max-height/);
    assert.match(full, /class="relative overflow-auto \[scrollbar-gutter:stable\] min-h-0 flex-1"/);
    assert.match(full, /^<div class="flex min-w-0 flex-col gap-4 h-full min-h-0">/);
  });

  it('offers "Full screen" on the step, like the Final Pay table — and not inside the overlay', () => {
    assert.match(render(PASTE, {}, { onOpenFullScreen: () => {} }), /title="Open this table full screen"/);
    assert.doesNotMatch(render(PASTE, {}, { fillHeight: true }), /Open this table full screen/);
  });

  it('the overlay does not repeat the week — its own header carries it', () => {
    assert.match(render(PASTE), /hubstaff_2026-09-20_to_2026-09-26\.csv<\/span>/);
    assert.doesNotMatch(render(PASTE, {}, { fillHeight: true }), /hubstaff_2026-09-20_to_2026-09-26\.csv<\/span>/);
  });

  it('the chip and the search come from the mount, so step and overlay show the same slice', () => {
    const onlyMismatch = render(PASTE, {}, { filter: 'mismatch', fillHeight: true });
    assert.ok(onlyMismatch.includes('lorar@simple.biz'));
    assert.ok(!onlyMismatch.includes('>kaner@simple.biz<'));
    assert.match(onlyMismatch, /showing 1 of 4/);
    const searched = render(PASTE, {}, { search: 'npdonly' });
    assert.ok(searched.includes('npdonly@simple.biz'));
    assert.ok(!searched.includes('>lorar@simple.biz<'));
    // …and the totals still cover every row.
    assert.match(searched, /Totals · 4 people/);
  });

  it('a held chip still falls back to All while verdicts cannot be given', () => {
    const html = render(PASTE, { hrisState: 'pending' }, { filter: 'mismatch' });
    assert.ok(html.includes('kaner@simple.biz') && html.includes('npdonly@simple.biz'));
  });
});

describe('HRIS vs NPD — the wizard mounts ONE overlay for both sections (source guard)', () => {
  const src = fs
    .readFileSync(path.join(process.cwd(), 'src/components/PayrollWizard.tsx'), 'utf8')
    .replace(/\r\n/g, '\n');

  it('there is exactly one full-screen overlay', () => {
    assert.equal(src.split('<ValidationFullScreen').length - 1, 1);
  });

  it('it is mounted AFTER the section swap closes, so switching sections inside it cannot unmount it', () => {
    const swapBranch = src.indexOf("validationSection === 'hris_vs_npd' ? (");
    assert.ok(swapBranch > 0, 'section swap not found');
    const swapClose = src.indexOf('</AnimatePresence>', swapBranch);
    const overlay = src.indexOf('<ValidationFullScreen', swapBranch);
    assert.ok(swapClose > 0 && overlay > swapClose, 'ValidationFullScreen must render outside the section swap');
  });

  it('step and overlay are handed the SAME panel props object and the SAME section state', () => {
    assert.match(src, /<HrisNpdComparison\n\s+\{\.\.\.hrisNpdPanelProps\}/);
    assert.match(src, /hrisNpd=\{hrisNpdPanelProps\}/);
    assert.match(src, /section=\{validationSection\}\n\s+onSelectSection=\{selectValidationSection\}/);
    assert.match(src, /onClick=\{\(\) => selectValidationSection\(sec\.key\)\}/);
  });

  it('the "off by" setting is ONE wizard state: it builds the comparison and fills the box', () => {
    assert.match(src, /useState<number>\(DEFAULT_MATCH_TOLERANCE_CENTS\)/);
    assert.match(src, /toleranceCents: hrisNpdTolerance,\n\s+\}\),/);
    assert.match(src, /toleranceCents: hrisNpdTolerance,\n\s+onToleranceChange: setHrisNpdTolerance,/);
  });

  it('the step rides in the SAME week-stamped state as the paste, so another week starts on step 1', () => {
    assert.match(src, /useState<\{ sourceFile: string \| null; text: string; step: HrisNpdStep \}>/);
    assert.match(src, /step: prev\.sourceFile === calcSourceFile && text\.trim\(\) !== '' \? prev\.step : 'input'/);
    assert.match(src, /const npdPasteStep: HrisNpdStep = npdPasteForThisWeek \? npdPaste\.step : 'input';/);
    assert.match(src, /step: npdStep,\n\s+onStepChange: setNpdStep,/);
  });

  it("NPD's locked sheets keep their OWN week-stamped step, opening on the output (2026-10-02)", () => {
    assert.match(src, /useState<\{ sourceFile: string \| null; step: HrisNpdStep \}>\(\{\n\s+sourceFile: null,\n\s+step: 'output',/);
    assert.match(src, /const npdFeedStepNow: HrisNpdStep = npdFeedStep\.sourceFile === calcSourceFile \? npdFeedStep\.step : 'output';/);
    assert.match(src, /const npdStep: HrisNpdStep = npdFeedActive \? npdFeedStepNow : npdPasteStep;/);
  });

  it('the sections are defined once — in ValidationFullScreen.tsx — never again in the wizard', () => {
    assert.doesNotMatch(src, /const VALIDATION_SECTIONS\s*=/);
    const overlaySrc = fs.readFileSync(path.join(process.cwd(), 'src/components/payroll/ValidationFullScreen.tsx'), 'utf8');
    assert.match(overlaySrc, /export const VALIDATION_SECTIONS = \[/);
    assert.match(overlaySrc, /<HrisNpdComparison \{\.\.\.hrisNpd\} fillHeight \/>/);
  });
});
