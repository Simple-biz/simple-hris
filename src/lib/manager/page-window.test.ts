import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { pageWindow } from './page-window';

/* Kane, 2026-09-28: *"Now for the Orientation tab per department make the line items
 * paginated to 10 items per page"*. Every item is on exactly one page, and a page that
 * no longer exists (a refresh or the Show-everyone toggle shrank the list) is clamped,
 * never rendered empty under counts that say otherwise. */

const list = Array.from({ length: 23 }, (_, i) => i + 1);

describe('pageWindow — 10 per page', () => {
  it('pages 23 items as 10 · 10 · 3, and says which ones it shows', () => {
    const p1 = pageWindow(list, 1, 10);
    assert.deepEqual([p1.items.length, p1.from, p1.to, p1.total, p1.totalPages], [10, 1, 10, 23, 3]);
    const p3 = pageWindow(list, 3, 10);
    assert.deepEqual(p3.items, [21, 22, 23]);
    assert.deepEqual([p3.from, p3.to], [21, 23]);
  });

  it('every item is on exactly one page — paging never hides or repeats a row', () => {
    const seen: number[] = [];
    for (let page = 1; page <= pageWindow(list, 1, 10).totalPages; page++) seen.push(...pageWindow(list, page, 10).items);
    assert.deepEqual(seen, list);
  });

  it('clamps a page the list no longer has (a refresh shrank it) to the last one', () => {
    const shrunk = pageWindow(list.slice(0, 12), 3, 10);
    assert.equal(shrunk.page, 2);
    assert.deepEqual(shrunk.items, [11, 12]);
  });

  it('clamps below 1, and reads a non-number as page 1', () => {
    assert.equal(pageWindow(list, 0, 10).page, 1);
    assert.equal(pageWindow(list, -4, 10).page, 1);
    assert.equal(pageWindow(list, Number.NaN, 10).page, 1);
  });

  it('an empty list is page 1 of 1 with nothing shown', () => {
    const empty = pageWindow([], 5, 10);
    assert.deepEqual([empty.page, empty.totalPages, empty.from, empty.to, empty.items.length], [1, 1, 0, 0, 0]);
  });

  it('exactly 10 items is ONE page (no pager needed)', () => {
    assert.equal(pageWindow(list.slice(0, 10), 1, 10).totalPages, 1);
  });

  it('refuses a page size that is not a positive integer', () => {
    assert.throws(() => pageWindow(list, 1, 0), RangeError);
    assert.throws(() => pageWindow(list, 1, 2.5), RangeError);
  });
});
