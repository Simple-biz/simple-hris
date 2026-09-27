import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, it } from 'node:test';

/* Managers never see pay on My Team (`manager-my-team.md:13-17`), and an
 * appointment count × ₱250 IS the Lead Gen pay. A widened SELECT ships pay even
 * against a clean render, so the projection STRING is pinned here — the same
 * control `team-rankings.test.ts` keeps on the SP Rankings read. */

const SRC = readFileSync(path.join(__dirname, 'appointment-rankings.ts'), 'utf8');
const CODE = SRC.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, '');

describe('appointment rankings read — never selects pay', () => {
  it('the applied projection is exactly the four columns, no amount', () => {
    const m = /APPOINTMENT_APPLIED_SELECT\s*=\s*'([^']*)'/.exec(SRC);
    assert.ok(m, 'expected the projection constant to be findable');
    assert.equal(m[1], 'period_start, period_end, employee_email, vars');
  });

  it('bonus_catalog_applied is read through that constant and nothing else', () => {
    assert.match(
      CODE,
      /from\('bonus_catalog_applied'\)\s*\.select\(APPOINTMENT_APPLIED_SELECT\)/,
    );
    assert.equal((CODE.match(/from\('bonus_catalog_applied'\)/g) ?? []).length, 1);
  });

  it('no select anywhere in the module mentions amount, and nothing selects *', () => {
    for (const [, arg] of CODE.matchAll(/\.select\(([^)]*)\)/g)) {
      assert.doesNotMatch(arg!, /amount|\*/, `select(${arg}) must not read pay`);
    }
    assert.doesNotMatch(CODE, /\bamount\b/);
  });
});
