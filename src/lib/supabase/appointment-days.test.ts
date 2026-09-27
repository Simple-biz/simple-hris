import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, it } from 'node:test';

/* Kane, 2026-09-26: "No money values should be displayed here." `hubstaff_hours`
 * carries `Spent total` and `Currency`; a widened SELECT would put pay on the wire
 * even if nothing rendered it. The projection STRING is pinned, as the applied
 * read's is in `appointment-rankings.test.ts`. */

const SRC = readFileSync(path.join(__dirname, 'appointment-days.ts'), 'utf8');
const CODE = SRC.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, '');

describe('appointment days read — never selects pay', () => {
  it('the Hubstaff projection is exactly the email and the seven day columns', () => {
    const m = /HUBSTAFF_DAYS_SELECT\s*=\s*'([^']*)'/.exec(SRC);
    assert.ok(m, 'expected the projection constant to be findable');
    assert.equal(m[1], 'Email, sunday, monday, tuesday, wednesday, thursday, friday, saturday');
  });

  it('every select in the module goes through that constant', () => {
    const selects = [...CODE.matchAll(/\.select\(([^)]*)\)/g)].map((x) => x[1]!.trim());
    assert.deepEqual(selects, ['HUBSTAFF_DAYS_SELECT']);
  });

  it('no pay column, amount or * appears anywhere in the code', () => {
    // Case-SENSITIVE on purpose: the column is `Currency`; `CONCURRENCY` is a constant.
    assert.doesNotMatch(CODE, /Spent total|\bCurrency\b|\bamount\b|select\(\s*'\*'/);
    assert.doesNotMatch(CODE, /spent|currency'/i);
  });

  it('never filters Hubstaff by an exact email list (26 rows are mixed-case)', () => {
    assert.doesNotMatch(CODE, /\.in\(\s*'Email'/);
  });
});
