/** [TERMINATION-DOCS]
 * `reasonKey` / allowlist / `escapeLikePattern`.
 *
 * These three functions are reimplementations of module-private originals, so
 * the tests pin BEHAVIOUR rather than identity: nothing in the compiler can
 * notice the copy drifting from
 * `src/lib/payment-catalog/catalog-roster-visibility.ts:80` or
 * `src/lib/supabase/hr-pending-employees.ts:714`.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  TERMINATION_DEPARTURE_REASON_SET,
  escapeLikePattern,
  reasonKey,
} from './reason-key';
import { TERMINATION_DEPARTURE_REASONS, isTerminationDepartureReason } from './types';

/** The five spellings of a suspension that the free-text, CHECK-less
 *  `off_boarded_reason` column is known to hold. */
const PAUSE_CORPUS = [
  'temporary_pause',
  'Temporary Pause',
  'TEMPORARY_PAUSE',
  ' temporary-pause ',
  'Temporary  Pause',
];

test('G2: every spelling of a suspension collapses to the one key temporary_pause', () => {
  for (const raw of PAUSE_CORPUS) {
    assert.equal(reasonKey(raw), 'temporary_pause', `failed on ${JSON.stringify(raw)}`);
  }
});

test('G2: the collapsed suspension key is refused by the departure allowlist, both ways', () => {
  for (const raw of PAUSE_CORPUS) {
    const k = reasonKey(raw);
    assert.equal(isTerminationDepartureReason(k), false, `predicate accepted ${JSON.stringify(raw)}`);
    assert.equal(
      TERMINATION_DEPARTURE_REASON_SET.has(k ?? ''),
      false,
      `set accepted ${JSON.stringify(raw)}`,
    );
  }
});

test('G2 negative control: resigned survives the same pipeline in every casing', () => {
  // Without this the whole G2 suite could pass by refusing every input.
  for (const raw of ['resigned', 'Resigned', 'RESIGNED', ' resigned ']) {
    const k = reasonKey(raw);
    assert.equal(k, 'resigned', `failed on ${JSON.stringify(raw)}`);
    assert.equal(isTerminationDepartureReason(k), true);
    assert.equal(TERMINATION_DEPARTURE_REASON_SET.has(k ?? ''), true);
  }
  // And so does every other canonical departure.
  for (const r of TERMINATION_DEPARTURE_REASONS) {
    assert.equal(reasonKey(r), r, `reasonKey mangled the canonical ${r}`);
    assert.equal(TERMINATION_DEPARTURE_REASON_SET.has(r), true);
  }
});

test('reasonKey returns null for absent and whitespace-only text, never an empty string', () => {
  // A null key is a fillable BLANK downstream; an '' key would be a value that
  // no allowlist member matches and no rep can see.
  for (const raw of [null, undefined, '', '   ', '\t\n', '---', '___', '  //  ']) {
    assert.equal(reasonKey(raw), null, `failed on ${JSON.stringify(raw)}`);
  }
});

test('reasonKey normalizes the sheet-authored labels that really sit in the column', () => {
  assert.equal(reasonKey('Policy Violation'), 'policy_violation');
  assert.equal(reasonKey('Declined Offer'), 'declined_offer');
  assert.equal(reasonKey('Agent Passed Away'), 'agent_passed_away');
  assert.equal(reasonKey('Active'), 'active');
  assert.equal(reasonKey('duplicate_cleanup'), 'duplicate_cleanup');
  assert.equal(reasonKey('sheet_sync'), 'sheet_sync');
  assert.equal(reasonKey('End of Contract'), 'end_of_contract');
  assert.equal(reasonKey('Time Manipulation'), 'time_manipulation');
  assert.equal(reasonKey('NCNS (No Call, No Show)'), 'ncns_no_call_no_show');
});

test('reasonKey is an ALLOWLIST feed: none of the non-departures it normalizes is accepted', () => {
  for (const raw of [
    'Policy Violation',
    'Declined Offer',
    'Agent Passed Away',
    'Active',
    'duplicate_cleanup',
    'sheet_sync',
    'NCNS (No Call, No Show)',
  ]) {
    assert.equal(
      TERMINATION_DEPARTURE_REASON_SET.has(reasonKey(raw) ?? ''),
      false,
      `${raw} passed the allowlist`,
    );
  }
});

test('reasonKey collapses runs of punctuation and digits the way the original does', () => {
  // Byte-parity with catalog-roster-visibility.ts:80 — [^a-z0-9]+ → '_', then
  // the leading/trailing underscores are stripped.
  assert.equal(reasonKey('end---of...contract'), 'end_of_contract');
  assert.equal(reasonKey('__resigned__'), 'resigned');
  assert.equal(reasonKey('Other (note required)'), 'other_note_required');
  assert.equal(reasonKey('ncns2'), 'ncns2');
  assert.equal(reasonKey('résigné'), 'r_sign', 'non-ASCII letters are punctuation to this normalizer');
});

test('the departure set is the allowlist itself — same members, same size', () => {
  assert.equal(TERMINATION_DEPARTURE_REASON_SET.size, TERMINATION_DEPARTURE_REASONS.length);
  for (const r of TERMINATION_DEPARTURE_REASONS) {
    assert.equal(TERMINATION_DEPARTURE_REASON_SET.has(r), true);
  }
  assert.equal(TERMINATION_DEPARTURE_REASON_SET.has('temporary_pause'), false);
});

// ─── escapeLikePattern ──────────────────────────────────────────────────────

/** ILIKE semantics, faithfully: `%` = any run, `_` = exactly one character,
 *  `\` escapes the next character into a literal. Everything else is literal.
 *  This is what PostgREST hands Postgres, so it is what the escaper must beat. */
function ilikeMatches(pattern: string, value: string): boolean {
  let rx = '';
  for (let i = 0; i < pattern.length; i += 1) {
    const ch = pattern[i];
    if (ch === '\\') {
      i += 1;
      if (i < pattern.length) rx += pattern[i].replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
      continue;
    }
    if (ch === '%') { rx += '.*'; continue; }
    if (ch === '_') { rx += '.'; continue; }
    rx += ch.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  }
  return new RegExp(`^${rx}$`, 'i').test(value);
}

test('escapeLikePattern escapes exactly the three ILIKE metacharacters', () => {
  assert.equal(escapeLikePattern('a_b'), 'a\\_b');
  assert.equal(escapeLikePattern('a%b'), 'a\\%b');
  assert.equal(escapeLikePattern('a\\b'), 'a\\\\b');
  assert.equal(escapeLikePattern('a_b%c\\d'), 'a\\_b\\%c\\\\d');
  // A dot is NOT an ILIKE metacharacter; escaping it would break every email.
  assert.equal(escapeLikePattern('juan@simple.biz'), 'juan@simple.biz');
  assert.equal(escapeLikePattern(''), '');
});

test('THE BUG: an unescaped underscore matches a DIFFERENT person; escaped, it stops', () => {
  // `_` is legal in an email local-part. Unescaped it is a single-char wildcard,
  // so the query for a_b@x.com silently returns axb@x.com's rows — someone
  // else's off-board stamp, rate and paystub, on a signed termination letter.
  assert.equal(ilikeMatches('a_b@x.com', 'axb@x.com'), true, 'the hazard is real');
  assert.equal(ilikeMatches(escapeLikePattern('a_b@x.com'), 'axb@x.com'), false);
  // And the escaped pattern still finds the person actually being searched for.
  assert.equal(ilikeMatches(escapeLikePattern('a_b@x.com'), 'a_b@x.com'), true);
  assert.equal(ilikeMatches(escapeLikePattern('a_b@x.com'), 'A_B@X.COM'), true, 'ILIKE is case-insensitive');
});

test('an escaped percent stops matching an unrelated prefix', () => {
  assert.equal(ilikeMatches('carla%@simple.biz', 'carlathomas@simple.biz'), true);
  assert.equal(
    ilikeMatches(escapeLikePattern('carla%@simple.biz'), 'carlathomas@simple.biz'),
    false,
  );
  assert.equal(ilikeMatches(escapeLikePattern('carla%@simple.biz'), 'carla%@simple.biz'), true);
});

test('escaping is idempotent-safe to reason about: a plain email is unchanged and still matches itself', () => {
  for (const email of ['juan@simple.biz', 'maria.argote@simple.biz', 'kaner@simple.biz']) {
    assert.equal(escapeLikePattern(email), email);
    assert.equal(ilikeMatches(escapeLikePattern(email), email), true);
  }
});
