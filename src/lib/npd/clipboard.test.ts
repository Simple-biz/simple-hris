import test, { describe } from 'node:test';
import assert from 'node:assert/strict';

import { parseClipboardGrid, serializeClipboardGrid } from './clipboard';

describe('parseClipboardGrid — Google Sheets TSV', () => {
  test('empty text and a lone line break paste nothing', () => {
    assert.deepEqual(parseClipboardGrid(''), []);
    assert.deepEqual(parseClipboardGrid('\n'), []);
    assert.deepEqual(parseClipboardGrid('\r\n'), []);
  });

  test('tabs split cells, line breaks split rows', () => {
    assert.deepEqual(parseClipboardGrid('a\tb\tc\nd\te\tf'), [
      ['a', 'b', 'c'],
      ['d', 'e', 'f'],
    ]);
  });

  test('CRLF and a lone CR both end a row', () => {
    assert.deepEqual(parseClipboardGrid('a\tb\r\nc\td\re\tf'), [
      ['a', 'b'],
      ['c', 'd'],
      ['e', 'f'],
    ]);
  });

  test('ONE trailing line break is dropped (Excel ends every copy with one)', () => {
    assert.deepEqual(parseClipboardGrid('a\tb\r\n'), [['a', 'b']]);
    assert.deepEqual(parseClipboardGrid('a\tb\n'), [['a', 'b']]);
  });

  test('a blank line in the middle is a real blank row', () => {
    assert.deepEqual(parseClipboardGrid('a\n\nb'), [['a'], [''], ['b']]);
  });

  test('empty cells survive, including a trailing one', () => {
    assert.deepEqual(parseClipboardGrid('a\t\tc\t'), [['a', '', 'c', '']]);
    assert.deepEqual(parseClipboardGrid('\t\t'), [['', '', '']]);
  });

  test('a quoted cell keeps its line break and does NOT split the row', () => {
    // The notes columns hold multi-line cells. A naive split would shift every
    // later cell of this person — and every later person — by one row.
    const text = 'jane@simple.biz\t"Rate changed Wed\nfrom 265 to 280"\t₱12,345.67\nbob@simple.biz\t\t₱9,000.00';
    assert.deepEqual(parseClipboardGrid(text), [
      ['jane@simple.biz', 'Rate changed Wed\nfrom 265 to 280', '₱12,345.67'],
      ['bob@simple.biz', '', '₱9,000.00'],
    ]);
  });

  test('doubled quotes inside a quoted cell are one quote', () => {
    assert.deepEqual(parseClipboardGrid('"He said ""yes"""\tx'), [['He said "yes"', 'x']]);
  });

  test('a quoted cell may hold a tab', () => {
    assert.deepEqual(parseClipboardGrid('"a\tb"\tc'), [['a\tb', 'c']]);
  });

  test('a cell that merely STARTS with a quote is literal', () => {
    assert.deepEqual(parseClipboardGrid('"5 hours\tx'), [['"5 hours', 'x']]);
    assert.deepEqual(parseClipboardGrid('"Bob" Smith\tx'), [['"Bob" Smith', 'x']]);
  });

  test('a quoted cell at the very end, with and without a trailing break', () => {
    assert.deepEqual(parseClipboardGrid('a\t"x\ny"'), [['a', 'x\ny']]);
    assert.deepEqual(parseClipboardGrid('a\t"x\ny"\n'), [['a', 'x\ny']]);
  });

  test('figures come through verbatim — nothing is parsed or rounded', () => {
    assert.deepEqual(parseClipboardGrid('₱1,234.56\t$20.10\t#N/A\t0.333333\tYes'), [
      ['₱1,234.56', '$20.10', '#N/A', '0.333333', 'Yes'],
    ]);
  });
});

describe('serializeClipboardGrid', () => {
  test('plain cells join with tabs and newlines', () => {
    assert.equal(serializeClipboardGrid([['a', 'b'], ['c', '']]), 'a\tb\nc\t');
  });

  test('cells with a tab, newline or quote are quoted with quotes doubled', () => {
    assert.equal(serializeClipboardGrid([['x\ny', 'a\tb', 'say "hi"']]), '"x\ny"\t"a\tb"\t"say ""hi"""');
  });

  test('round trip: what Copy writes, Paste reads back cell for cell', () => {
    const grid = [
      ['jane@simple.biz', 'Line 1\nLine 2', '₱1,234.56', ''],
      ['"quoted"', 'tab\there', '', 'end'],
      ['', '', '', ''],
      ['last', 'x', 'y', 'z'],
    ];
    assert.deepEqual(parseClipboardGrid(serializeClipboardGrid(grid)), grid);
  });
});
