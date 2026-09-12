import test from 'node:test';
import assert from 'node:assert/strict';
import {
  INTENT_TARGET, PROFILE_SECTIONS, PROFILE_TAB_IDS,
  nextProfileTarget, profileSectionDomId,
} from './profile-tabs';

test('every deep-link intent resolves to a real tab, and a real section when it names one', () => {
  // The render chain is a series of bare `activeTab === '…' &&` guards with NO
  // default branch, so an intent pointing at a retired id shows an EMPTY pane —
  // silently, and with no type error, because a narrow union still satisfies a
  // wide one. This is the guard that catches that.
  for (const [intent, target] of Object.entries(INTENT_TARGET)) {
    assert.ok(PROFILE_TAB_IDS.includes(target.tab), `intent "${intent}" points at unknown tab "${target.tab}"`);
    if (target.section) {
      assert.ok(
        PROFILE_SECTIONS[target.tab].includes(target.section),
        `intent "${intent}" points at section "${target.section}", which tab "${target.tab}" does not have`,
      );
    }
  }
});

test('the bank nudge lands on the payout section, not merely the tab', () => {
  assert.deepEqual(INTENT_TARGET.bank, { tab: 'compensation', section: 'payout' });
});

test('the nonce advances on EVERY call, so the same nudge fires twice', () => {
  // focusTarget is applied by a value-keyed effect and no visited tab ever
  // unmounts (EmployeeApp.tsx:613). Without a changing nonce, firing the same
  // nudge twice sets state to its current value, React bails out, and the user
  // does not move.
  const first = nextProfileTarget(null, 'bank');
  const second = nextProfileTarget(first, 'bank');
  assert.notEqual(first.nonce, second.nonce);
  assert.equal(second.tab, 'compensation');
});

test('section DOM ids are derived, never hand-written', () => {
  assert.equal(profileSectionDomId('commendations'), 'profile-section-commendations');
});

test('every section belongs to exactly one tab', () => {
  // One SectionId union serves every tab, so a section listed twice would make
  // `PROFILE_SECTIONS[tab].includes(section)` true for the wrong tab and let a
  // deep link resolve to a pane that does not render it.
  const seen = new Map<string, string>();
  for (const [tab, sections] of Object.entries(PROFILE_SECTIONS)) {
    for (const section of sections) {
      const owner = seen.get(section);
      assert.equal(owner, undefined, `section "${section}" is claimed by both "${owner}" and "${tab}"`);
      seen.set(section, tab);
    }
  }
});

test('PROFILE_SECTIONS covers every tab id, so no tab is missing from the map', () => {
  assert.deepEqual([...PROFILE_TAB_IDS].sort(), Object.keys(PROFILE_SECTIONS).sort());
});
