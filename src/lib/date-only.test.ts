import test from 'node:test';
import assert from 'node:assert/strict';
import { formatDateOnly } from './date-only';

// Force a zone west of UTC before anything under test runs a `Date`. Without
// this, a runner whose default TZ happens to be UTC or east of it (many CI
// boxes are UTC) would let the naive `new Date('2026-09-01')` bug land on the
// same calendar day anyway, and the assertion below would pass vacuously —
// proving nothing about the fix. Pinning the zone here makes the test fail
// deterministically on the old implementation, on any host, in any timezone.
process.env.TZ = 'America/New_York';

test('a date-only string does not shift a day west of UTC', () => {
  // `new Date('2026-09-01')` parses as UTC midnight, which — in the
  // America/New_York zone pinned above — is Aug 31, 8pm local: the previous
  // calendar day. `parseDateOnlyLocal` builds a LOCAL date instead, so this
  // must render Sep 1, never Aug 31.
  const shown = formatDateOnly('2026-09-01');
  assert.match(shown, /Sep 1, 2026/);
  assert.doesNotMatch(shown, /Aug 31, 2026/);
});

test('an unparseable value is passed through verbatim, never swallowed', () => {
  assert.equal(formatDateOnly('sometime in March'), 'sometime in March');
});

test('an absent value renders the em-dash placeholder', () => {
  assert.equal(formatDateOnly(null), '—');
  assert.equal(formatDateOnly(undefined), '—');
  assert.equal(formatDateOnly('   '), '—');
});
