/** [TERMINATION-DOCS]
 * G3/T4 — the cycle timesheet as a REFUSAL-ONLY signal, and its three states.
 *
 * The round-2 blocker this file exists for: `loadCycleHoursIndex` can return
 * empty sets with `error: null`, and the old caller spelled the read as
 * `hours.error ? null : personWorkedCycle(...)`, so that shape became a
 * CONFIDENT "did not work" for every person on the roster. The union under test
 * cannot express `worked` outside `ready`, and these tests hold that line.
 *
 * Also the widening: a working person's Hubstaff login is routinely an address
 * `global_master_list` does not carry. Because a hit only ever REFUSES, the
 * widest reasonable match is the correct one — but it still has a floor, and the
 * floor is tested too.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  readCycleHoursSignal,
  type TerminationHoursIndexView,
} from './termination-cycle-hours';

function index(over: Partial<{ emails: string[]; nameTokenKeys: string[]; error: string | null }> = {}): TerminationHoursIndexView {
  return {
    emails: new Set(over.emails ?? ['someone.else@simple.biz']),
    nameTokenKeys: new Set(over.nameTokenKeys ?? ['else someone']),
    error: over.error ?? null,
  };
}

const SUBJECT = { emails: ['carlath@simple.biz'], names: ['Thomas, Carla'] };

// ── The three states ────────────────────────────────────────────────────────

test('G3: an ERRORED index is `unreadable` — never a "did not work"', () => {
  const signal = readCycleHoursSignal(
    index({ error: 'No Hubstaff upload to build the cycle hours index from' }),
    SUBJECT,
  );
  assert.equal(signal.state, 'unreadable');
  // The type has no `worked` here at all; this is the runtime half of that.
  assert.equal('worked' in signal, false, 'an unreadable index produced a worked verdict');
});

test('G3: an EMPTY-but-healthy index is `unavailable`, NOT "nobody worked"', () => {
  // THE ROUND-2 BLOCKER. `loadCycleHoursIndex` returns `{emails: new Set(),
  // nameTokenKeys: new Set(), error: null}` whenever the `is_current` upload has
  // no rows — and the old `hours.error ? null : personWorkedCycle(...)` read that
  // as a confident false for the whole roster.
  const signal = readCycleHoursSignal(index({ emails: [], nameTokenKeys: [] }), SUBJECT);
  assert.equal(signal.state, 'unavailable');
  assert.equal(
    'worked' in signal,
    false,
    'an empty index produced a worked verdict — the signal collapsed back into a false',
  );
});

test('G3: a NON-EMPTY index that does not name this person is a real `ready` miss', () => {
  // The negative control for both tests above: without it, "never says worked"
  // could be satisfied by never answering at all.
  const signal = readCycleHoursSignal(index(), SUBJECT);
  assert.deepEqual(signal, { state: 'ready', worked: false, matchedBy: null });
});

// ── The match, widened — every hit REFUSES, so wider is the safe direction ──

test('G3: the exact address in the timesheet is a hit', () => {
  const signal = readCycleHoursSignal(index({ emails: ['carlath@simple.biz'] }), SUBJECT);
  assert.equal(signal.state === 'ready' && signal.worked, true);
  assert.match(String(signal.state === 'ready' ? signal.matchedBy : ''), /carlath@simple\.biz/);
});

test('G3: the SAME local part on a different domain is a hit', () => {
  // A working person's Hubstaff login is routinely an address the master row
  // does not carry — the timesheet is exported from a third-party tool people
  // sign into with whatever address was handy. Matching only the four master
  // email columns misses those hours, and a missed hit is the one direction that
  // prints a termination letter for someone who worked this week.
  const signal = readCycleHoursSignal(index({ emails: ['carlath@gmail.com'] }), SUBJECT);
  assert.equal(
    signal.state === 'ready' && signal.worked,
    true,
    'a Hubstaff login on another domain was not matched',
  );
});

test('G3: a SHORT local part does not match across domains', () => {
  // The floor on the widening. `hr@`, `jm@` and `ap@` are role addresses on many
  // domains; a two-character local part is not an identity.
  const signal = readCycleHoursSignal(index({ emails: ['jm@vendor.com'] }), {
    emails: ['jm@simple.biz'],
    names: [],
  });
  assert.equal(signal.state === 'ready' && signal.worked, false);
});

test('G3: the exact name-token key is a hit whatever the column order', () => {
  // `normalizeNameTokens` sorts, so "Thomas, Carla" and "Carla Thomas" are one
  // key — the matcher `personWorkedCycle` already used.
  const signal = readCycleHoursSignal(index({ nameTokenKeys: ['carla thomas'] }), SUBJECT);
  assert.equal(signal.state === 'ready' && signal.worked, true);
});

test('G3: a token SUBSET name is a hit — the master row carries the fuller name', () => {
  // `nameTokens` is exported for exactly this ("Kane Reroma" against the
  // master's fuller "Jan Kane Reroma", name-tokens.ts:16-18). The timesheet is
  // hand-keyed and routinely holds the short name.
  const signal = readCycleHoursSignal(index({ nameTokenKeys: ['kane reroma'] }), {
    emails: ['kaner@simple.biz'],
    names: ['Reroma, Jan Kane'],
  });
  assert.equal(
    signal.state === 'ready' && signal.worked,
    true,
    'a shorter timesheet name did not match the fuller master name',
  );
});

test('G3: ONE shared name token is not a person — the subset match has a floor', () => {
  // Without the floor, every "Maria" in a 1,300-person roster refuses every
  // other Maria's letter, and the refusal becomes noise the rep learns to
  // override.
  const signal = readCycleHoursSignal(index({ nameTokenKeys: ['maria santos'] }), {
    emails: ['mariaa@simple.biz'],
    names: ['Argote, Maria'],
  });
  assert.equal(signal.state === 'ready' && signal.worked, false);
});

test('G3: a blank identity cannot match a populated timesheet', () => {
  const signal = readCycleHoursSignal(index(), { emails: [null, undefined, ''], names: [null] });
  assert.deepEqual(signal, { state: 'ready', worked: false, matchedBy: null });
});
