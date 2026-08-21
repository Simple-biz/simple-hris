import { strict as assert } from 'node:assert';
import { test } from 'node:test';

import {
  MV_NOTE_MAX_LEN,
  countValidated,
  mergeIntoRawMvBlob,
  mvSettingKey,
  normalizeMvEmail,
  normalizeMvNote,
  parseManualValidationMap,
  validationFor,
  type ManualValidation,
} from './manual-validation';

const AT = '2026-08-21T04:15:00.000Z';
const entry = (over: Partial<ManualValidation> = {}): ManualValidation => ({
  by: 'aliviah@simple.biz',
  at: AT,
  note: null,
  ...over,
});

test('the setting key is scoped to one Hubstaff source file', () => {
  assert.equal(
    mvSettingKey('simple-biz_daily_report_2026-08-09_to_2026-08-15.csv'),
    'payroll.wizard.mv.simple-biz_daily_report_2026-08-09_to_2026-08-15.csv',
  );
});

// ── keying ────────────────────────────────────────────────────────────────────
// Must match how the wizard keys excludedEmails, or the MV checkbox and the
// Exclude checkbox disagree about who a table row is.

test('emails are trimmed and lowercased, blanks become null', () => {
  assert.equal(normalizeMvEmail('  Alivia.H@Simple.Biz '), 'alivia.h@simple.biz');
  assert.equal(normalizeMvEmail(''), null);
  assert.equal(normalizeMvEmail('   '), null);
  assert.equal(normalizeMvEmail(null), null);
  assert.equal(normalizeMvEmail(undefined), null);
  // Not a string — a number key off a JSON blob must not become "123".
  assert.equal(normalizeMvEmail(123 as unknown as string), null);
});

test('a note is optional: blank and whitespace are the same state as never typing one', () => {
  assert.equal(normalizeMvNote(''), null);
  assert.equal(normalizeMvNote('   '), null);
  assert.equal(normalizeMvNote(null), null);
  assert.equal(normalizeMvNote('  checked against the sheet  '), 'checked against the sheet');
});

test('a note is capped rather than rejected', () => {
  const long = 'x'.repeat(MV_NOTE_MAX_LEN + 50);
  assert.equal(normalizeMvNote(long)?.length, MV_NOTE_MAX_LEN);
});

// ── tolerant read ─────────────────────────────────────────────────────────────

test('an absent or empty value reads as no validations, not an error', () => {
  assert.deepEqual(parseManualValidationMap(null), { map: {}, malformed: 0 });
  assert.deepEqual(parseManualValidationMap(''), { map: {}, malformed: 0 });
  assert.deepEqual(parseManualValidationMap(undefined), { map: {}, malformed: 0 });
});

test('a well-formed blob round-trips', () => {
  const raw = JSON.stringify({ 'jane@simple.biz': entry({ note: 'ties to the sheet' }) });
  const { map, malformed } = parseManualValidationMap(raw);
  assert.equal(malformed, 0);
  assert.deepEqual(map['jane@simple.biz'], { by: 'aliviah@simple.biz', at: AT, note: 'ties to the sheet' });
});

test('one malformed entry is dropped and counted — it never hides the good ones', () => {
  const raw = JSON.stringify({
    'jane@simple.biz': entry(),
    'broken@simple.biz': { by: '', at: AT },        // no validator
    'nodate@simple.biz': { by: 'a@b.c', at: 'nope' }, // unparseable instant
    'notobj@simple.biz': 'true',                      // not a record at all
  });
  const { map, malformed } = parseManualValidationMap(raw);
  assert.deepEqual(Object.keys(map), ['jane@simple.biz']);
  assert.equal(malformed, 3);
});

test('a non-object payload reads as empty rather than throwing', () => {
  for (const raw of ['[]', '"a string"', '42', 'null', '{oops']) {
    assert.deepEqual(parseManualValidationMap(raw), { map: {}, malformed: 0 });
  }
});

test('keys in the blob are normalised on read', () => {
  const raw = JSON.stringify({ '  Jane@Simple.Biz ': entry() });
  const { map } = parseManualValidationMap(raw);
  assert.ok(map['jane@simple.biz']);
});

// ── strict write ──────────────────────────────────────────────────────────────
// The asymmetry with the read path is the whole safety property.

test('merging into an absent blob creates it', () => {
  const res = mergeIntoRawMvBlob(null, 'jane@simple.biz', entry());
  assert.ok(res.ok);
  assert.deepEqual(JSON.parse(res.next), {
    'jane@simple.biz': { by: 'aliviah@simple.biz', at: AT, note: null },
  });
});

test('merging preserves every other person already in the blob', () => {
  const raw = JSON.stringify({
    'a@simple.biz': entry({ by: 'clerk1@simple.biz' }),
    'b@simple.biz': entry({ by: 'clerk2@simple.biz' }),
  });
  const res = mergeIntoRawMvBlob(raw, 'c@simple.biz', entry({ by: 'clerk3@simple.biz' }));
  assert.ok(res.ok);
  const next = JSON.parse(res.next);
  assert.deepEqual(Object.keys(next).sort(), ['a@simple.biz', 'b@simple.biz', 'c@simple.biz']);
  assert.equal(next['a@simple.biz'].by, 'clerk1@simple.biz');
  assert.equal(next['b@simple.biz'].by, 'clerk2@simple.biz');
});

test('an un-tick DELETES the key rather than storing a falsy record', () => {
  const raw = JSON.stringify({ 'a@simple.biz': entry(), 'b@simple.biz': entry() });
  const res = mergeIntoRawMvBlob(raw, 'a@simple.biz', null);
  assert.ok(res.ok);
  const next = JSON.parse(res.next);
  assert.deepEqual(Object.keys(next), ['b@simple.biz']);
  assert.ok(!('a@simple.biz' in next));
});

test('un-ticking someone who was never ticked is a no-op, not an error', () => {
  const res = mergeIntoRawMvBlob(JSON.stringify({ 'b@simple.biz': entry() }), 'ghost@simple.biz', null);
  assert.ok(res.ok);
  assert.deepEqual(Object.keys(JSON.parse(res.next)), ['b@simple.biz']);
});

test('a write onto an UNREADABLE blob is REFUSED — never silently reset', () => {
  // This is the lost-accountability case. Parsing to {} and writing would
  // destroy every other clerk's validation for the whole cycle.
  for (const raw of ['{oops', '[1,2,3]', '"a string"', '42']) {
    const res = mergeIntoRawMvBlob(raw, 'jane@simple.biz', entry());
    assert.equal(res.ok, false, `expected refusal for ${raw}`);
    if (!res.ok) assert.match(res.reason, /refusing to overwrite|unreadable|not an object/i);
  }
});

test('a write preserves keys this version does not understand', () => {
  // An older deploy must not strip a field a newer one added.
  const raw = JSON.stringify({
    'a@simple.biz': { by: 'clerk@simple.biz', at: AT, note: null, futureField: 'keep me' },
  });
  const res = mergeIntoRawMvBlob(raw, 'b@simple.biz', entry());
  assert.ok(res.ok);
  assert.equal(JSON.parse(res.next)['a@simple.biz'].futureField, 'keep me');
});

test('a write refuses an entry with no validator or a bad timestamp', () => {
  const noBy = mergeIntoRawMvBlob(null, 'jane@simple.biz', entry({ by: '  ' }));
  assert.equal(noBy.ok, false);
  const badAt = mergeIntoRawMvBlob(null, 'jane@simple.biz', entry({ at: 'not-a-date' }));
  assert.equal(badAt.ok, false);
});

test('a write refuses a blank subject email', () => {
  assert.equal(mergeIntoRawMvBlob(null, '   ', entry()).ok, false);
});

test('the written note is normalised, not stored raw', () => {
  const res = mergeIntoRawMvBlob(null, 'jane@simple.biz', entry({ note: '   spaced   ' }));
  assert.ok(res.ok);
  assert.equal(JSON.parse(res.next)['jane@simple.biz'].note, 'spaced');
});

test('the subject email is normalised on write, so case cannot create a twin', () => {
  const raw = JSON.stringify({ 'jane@simple.biz': entry({ note: 'first' }) });
  const res = mergeIntoRawMvBlob(raw, '  JANE@Simple.Biz  ', entry({ note: 'second' }));
  assert.ok(res.ok);
  const next = JSON.parse(res.next);
  assert.deepEqual(Object.keys(next), ['jane@simple.biz']);
  assert.equal(next['jane@simple.biz'].note, 'second');
});

// ── lookups ───────────────────────────────────────────────────────────────────

test('validationFor is case- and padding-insensitive, and absent means null', () => {
  const { map } = parseManualValidationMap(JSON.stringify({ 'jane@simple.biz': entry() }));
  assert.ok(validationFor(map, '  Jane@Simple.BIZ '));
  assert.equal(validationFor(map, 'someone@else.biz'), null);
  assert.equal(validationFor(map, null), null);
  assert.equal(validationFor(map, ''), null);
});

test('countValidated counts people, not notes', () => {
  const { map } = parseManualValidationMap(JSON.stringify({
    'a@simple.biz': entry({ note: null }),
    'b@simple.biz': entry({ note: 'with a note' }),
  }));
  assert.equal(countValidated(map), 2);
  assert.equal(countValidated({}), 0);
});
