/**
 * The peer-safety ruling, pinned.
 *
 * Every assertion here stands for a way a teammate's legal name, middle name,
 * surname or personal address could reach the employee team directory. See
 * docs/features/employee-team-directory.md § "Identity redaction".
 *
 * Run:  npx tsx --test src/lib/name/team-display-name.test.ts
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { shortDisplayName, teamDisplayNames } from './team-display-name';

describe('shortDisplayName', () => {
  it('uses the quoted go-by when the stored name carries one', () => {
    assert.equal(shortDisplayName('Reroma, Jan Kane "Kane"', 'kaner@simple.biz'), 'Kane');
    assert.equal(shortDisplayName('Cruz Jr, Juan Dela "Dela"', 'juan@simple.biz'), 'Dela');
    // The multi-word-first marker form keeps its quoted go-by, and the
    // parenthesized MIDDLE on the surname side is never mistaken for one.
    assert.equal(shortDisplayName('Reroma (Miguel), Jan Kane Teves "Kane"', 'k@simple.biz'), 'Kane');
    // A plain legal name may carry an inline go-by too.
    assert.equal(shortDisplayName('Juan (JJ) Cruz', 'juan@simple.biz'), 'JJ');
  });

  it('falls back to the FIRST name, never the derived go-by', () => {
    // THE regression this module exists for: `parseNameParts().nickname` would
    // derive "Marie" (the middle name) and introduce her to the team as that.
    assert.equal(shortDisplayName('Jane Marie Santos', 'jane@simple.biz'), 'Jane');
    assert.equal(shortDisplayName('Santos, Jane Marie', 'jane@simple.biz'), 'Jane');
    // ...and `resolveFirstName` would return "Jane Marie" — the middle name
    // again, just attached. Neither is what ships.
    assert.equal(shortDisplayName('Dela Cruz, Juan Miguel', 'juan@simple.biz'), 'Juan');
  });

  it('never emits a surname, a suffix, or a middle name', () => {
    for (const stored of [
      'Reroma, Jan Kane "Kane"',
      'Jan Kane Reroma',
      'Cruz Jr, Juan Dela "Dela"',
      'Juan Cruz III',
      'Dela Cruz, Juan',
      'Engalan, Kyle S. "Kyle"',
    ]) {
      const shown = shortDisplayName(stored, 'someone@simple.biz').toLowerCase();
      for (const forbidden of ['reroma', 'cruz', 'engalan', 'jr', 'iii', ' s.']) {
        assert.ok(
          !shown.includes(forbidden),
          `${stored} rendered as "${shown}" — leaks "${forbidden}"`,
        );
      }
    }
  });

  it('refuses a go-by that IS the surname, and uses the first name instead', () => {
    // A real roster row. The ruling is about the surname, not about which field
    // it arrived in.
    assert.equal(shortDisplayName('Lagunero, Joshua "Lagunero"', 'joshual@simple.biz'), 'Joshua');
    assert.equal(shortDisplayName('Dela Cruz, Juan "Dela Cruz"', 'juan@simple.biz'), 'Juan');
    // Case-insensitively.
    assert.equal(shortDisplayName('Lagunero, Joshua "LAGUNERO"', 'joshual@simple.biz'), 'Joshua');
    // A MIDDLE name used as the go-by is the person's own choice and stands —
    // only the surname is forbidden.
    assert.equal(shortDisplayName('Avellaneda, Sonia Cardenas "Cardenas"', 'sonia@simple.biz'), 'Cardenas');
    // A mononym has no first name to fall back to, so it keeps what it has.
    assert.equal(shortDisplayName('Madonna "Madonna"', 'madonna@simple.biz'), 'Madonna');
  });

  it('shows a mononym as itself', () => {
    assert.equal(shortDisplayName('Madonna', 'madonna@simple.biz'), 'Madonna');
  });

  it('proper-cases a SHOUTED or lowercase stored name', () => {
    assert.equal(shortDisplayName('SANTOS, JANE MARIE', 'jane@simple.biz'), 'Jane');
    assert.equal(shortDisplayName('jane marie santos', 'jane@simple.biz'), 'Jane');
  });

  it('re-cases a go-by typed in a different case from its own name', () => {
    // toTitleCaseName returns a MIXED-case string verbatim, so these reach the
    // card SHOUTED unless the go-by is re-cased on its own.
    assert.equal(shortDisplayName('Santos, Carla "CARLA"', 'carla@simple.biz'), 'Carla');
    assert.equal(shortDisplayName('Santos, Carla "carla"', 'carla@simple.biz'), 'Carla');
    // ...but a SHORT all-caps go-by is initials, and "Jj" would be worse.
    assert.equal(shortDisplayName('Juan (JJ) Cruz', 'juan@simple.biz'), 'JJ');
    assert.equal(shortDisplayName('Cruz, Juan Carlo "KC"', 'juan@simple.biz'), 'KC');
    // Mixed case was typed on purpose.
    assert.equal(shortDisplayName('Donald, Ann "McD"', 'ann@simple.biz'), 'McD');
  });

  it('never renders an address parked in the name column', () => {
    // It may well BE the personal address — so it is treated as no name at all
    // and the WORK email supplies the label instead.
    assert.equal(shortDisplayName('jane.santos@gmail.com', 'janes@simple.biz'), 'Janes');
    assert.equal(shortDisplayName('', 'janes@simple.biz'), 'Janes');
    assert.equal(shortDisplayName(null, 'j.delacruz@simple.biz'), 'J');
  });

  it('degrades to "Teammate" rather than invent an identity', () => {
    assert.equal(shortDisplayName(null, null), 'Teammate');
    assert.equal(shortDisplayName('', ''), 'Teammate');
    // No work email and only a personal address parked in the name column:
    // the personal address must NOT become the label.
    assert.equal(shortDisplayName('jane.santos@gmail.com', null), 'Teammate');
  });
});

describe('teamDisplayNames — collisions', () => {
  it('leaves a name nobody else shares alone', () => {
    assert.deepEqual(
      teamDisplayNames([
        { name: 'Reroma, Jan Kane "Kane"', workEmail: 'kaner@simple.biz' },
        { name: 'Santos, Carla "Carla"', workEmail: 'carla@simple.biz' },
      ]),
      ['Kane', 'Carla'],
    );
  });

  it('rung 1 — a surname initial, and only for the people who collide', () => {
    assert.deepEqual(
      teamDisplayNames([
        { name: 'Reroma, Jan Kane "Kane"', workEmail: 'kaner@simple.biz' },
        { name: 'Lim, Kane Patrick "Kane"', workEmail: 'kanel@simple.biz' },
        { name: 'Santos, Carla "Carla"', workEmail: 'carla@simple.biz' },
      ]),
      ['Kane R.', 'Kane L.', 'Carla'],
    );
  });

  it('rung 2 — the work-email local part when the surname initial also collides', () => {
    assert.deepEqual(
      teamDisplayNames([
        { name: 'Reroma, Jan Kane "Kane"', workEmail: 'kaner@simple.biz' },
        { name: 'Reyes, Kane Patrick "Kane"', workEmail: 'kanep@simple.biz' },
      ]),
      ['Kane R. (kaner)', 'Kane R. (kanep)'],
    );
  });

  it('rung 3 — a positional index only when there is no work email either', () => {
    assert.deepEqual(
      teamDisplayNames([
        { name: 'Reroma, Kane "Kane"', workEmail: null },
        { name: 'Reyes, Kane "Kane"', workEmail: '' },
      ]),
      ['Kane R. 1', 'Kane R. 2'],
    );
  });

  it('disambiguates the no-identity fallback too', () => {
    assert.deepEqual(
      teamDisplayNames([
        { name: null, workEmail: null },
        { name: '', workEmail: null },
      ]),
      ['Teammate 1', 'Teammate 2'],
    );
  });

  it('is case-insensitive about what counts as a collision', () => {
    assert.deepEqual(
      teamDisplayNames([
        { name: 'Reroma, Kane "KANE"', workEmail: 'kaner@simple.biz' },
        { name: 'Lim, Kane "kane"', workEmail: 'kanel@simple.biz' },
      ]),
      ['Kane R.', 'Kane L.'],
    );
  });

  it('depends on input order alone, so a label is stable across pages', () => {
    const roster = [
      { name: 'Reroma, Jan Kane "Kane"', workEmail: 'kaner@simple.biz' },
      { name: 'Lim, Kane Patrick "Kane"', workEmail: 'kanel@simple.biz' },
      { name: 'Santos, Carla "Carla"', workEmail: 'carla@simple.biz' },
    ];
    assert.deepEqual(teamDisplayNames(roster), teamDisplayNames([...roster]));
    // The suffix follows the person, not the slot: dropping an unrelated
    // teammate must not relabel anyone.
    assert.deepEqual(teamDisplayNames(roster.slice(0, 2)), ['Kane R.', 'Kane L.']);
  });
});
