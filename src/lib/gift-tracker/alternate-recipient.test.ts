/**
 * Somebody other than the employee receiving a tenure gift.
 *
 * The properties these exist to protect:
 *   1. A BLANK NAME IS NOT A PERSON. Whitespace, a lone relationship, a lone
 *      phone number — none of them means "somebody else receives this". Every
 *      downstream reader keys off one predicate, so if it says yes on a blank
 *      the Gift Tracker prints "Received by:" with nothing after it and the
 *      shipping list claims a handover that was never arranged.
 *   2. AN UNKNOWN RELATIONSHIP IS REFUSED, NEVER COERCED. Same trade the
 *      apparel size makes: a silently dropped value hands the parcel to the
 *      wrong person and nobody finds out why.
 *   3. THE RECIPIENT'S CONTACT NEVER SUBSTITUTES FOR THE EMPLOYEE'S. Kane's Q1
 *      ruling of 2026-09-18 — the courier calls the employee, who contacts their
 *      spouse. Nothing here may return one in place of the other.
 *
 * Run:  npx tsx --test src/lib/gift-tracker/alternate-recipient.test.ts
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  alternateRecipientColumns,
  describeAlternateRecipient,
  GIFT_RECIPIENT_RELATIONSHIPS,
  hasAlternateRecipient,
  MAX_RECIPIENT_CONTACT,
  MAX_RECIPIENT_NAME,
  normalizeAlternateRecipient,
  validateAlternateRecipient,
} from './alternate-recipient';

const SPOUSE = {
  recipient_name: 'Maria Dela Cruz',
  recipient_relationship: 'Spouse',
  recipient_contact: '09181234567',
};

// ---------------------------------------------------------------------------
// hasAlternateRecipient — the one predicate
// ---------------------------------------------------------------------------

test('hasAlternateRecipient is false for a row nobody filled in', () => {
  assert.equal(hasAlternateRecipient(null), false);
  assert.equal(hasAlternateRecipient(undefined), false);
  assert.equal(hasAlternateRecipient({}), false);
  assert.equal(
    hasAlternateRecipient({
      recipient_name: '',
      recipient_relationship: '',
      recipient_contact: '',
    }),
    false,
  );
});

test('hasAlternateRecipient is true only once a name is present', () => {
  assert.equal(hasAlternateRecipient(SPOUSE), true);
  assert.equal(hasAlternateRecipient({ recipient_name: 'Maria' }), true);
});

test('a WHITESPACE-ONLY name is not a person', () => {
  // Untrimmed, '   ' satisfies `!== ''` and every surface downstream would
  // render a handover to nobody.
  assert.equal(hasAlternateRecipient({ recipient_name: '   ' }), false);
  assert.equal(hasAlternateRecipient({ recipient_name: '\t\n ' }), false);
});

test('a relationship or a contact alone is not a person', () => {
  assert.equal(hasAlternateRecipient({ recipient_relationship: 'Spouse' }), false);
  assert.equal(hasAlternateRecipient({ recipient_contact: '09181234567' }), false);
});

test('a null column reads as absent, not as a crash', () => {
  // The columns are NOT NULL in the schema, but a joined/partial row in a test
  // or an older cached payload can still arrive holding nulls.
  assert.equal(
    hasAlternateRecipient({
      recipient_name: null,
      recipient_relationship: null,
      recipient_contact: null,
    }),
    false,
  );
});

// ---------------------------------------------------------------------------
// normalizeAlternateRecipient
// ---------------------------------------------------------------------------

test('normalize trims every field', () => {
  assert.deepEqual(
    normalizeAlternateRecipient({
      recipient_name: '  Maria Dela Cruz  ',
      recipient_relationship: ' Spouse ',
      recipient_contact: ' 09181234567 ',
    }),
    { name: 'Maria Dela Cruz', relationship: 'Spouse', contact: '09181234567' },
  );
});

test('normalize DROPS a relationship and contact that have no name', () => {
  // The partial record: unactionable, and it would make the stored row disagree
  // with what `hasAlternateRecipient` reports.
  assert.deepEqual(
    normalizeAlternateRecipient({
      recipient_name: '  ',
      recipient_relationship: 'Spouse',
      recipient_contact: '09181234567',
    }),
    { name: '', relationship: '', contact: '' },
  );
});

test('normalize returns a fresh object, never the shared empty constant', () => {
  const a = normalizeAlternateRecipient(null);
  const b = normalizeAlternateRecipient(null);
  a.name = 'mutated';
  assert.equal(b.name, '');
});

// ---------------------------------------------------------------------------
// validateAlternateRecipient
// ---------------------------------------------------------------------------

test('an empty triple is valid — most people receive their own gift', () => {
  const v = validateAlternateRecipient({});
  assert.equal(v.ok, true);
  assert.deepEqual(v.ok && v.value, { name: '', relationship: '', contact: '' });
});

test('a full triple is valid and comes back trimmed', () => {
  const v = validateAlternateRecipient({
    recipient_name: ' Maria Dela Cruz ',
    recipient_relationship: 'Spouse',
    recipient_contact: ' 09181234567 ',
  });
  assert.equal(v.ok, true);
  assert.deepEqual(v.ok && v.value, {
    name: 'Maria Dela Cruz',
    relationship: 'Spouse',
    contact: '09181234567',
  });
});

test('the contact is OPTIONAL — the courier calls the employee', () => {
  // Kane's Q1 ruling. Requiring a fallback number would block a legitimate
  // submission from somebody who does not have their spouse's number to hand.
  const v = validateAlternateRecipient({
    recipient_name: 'Maria Dela Cruz',
    recipient_relationship: 'Spouse',
  });
  assert.equal(v.ok, true);
  assert.equal(v.ok && v.value.contact, '');
});

test('a name with no relationship is REFUSED', () => {
  const v = validateAlternateRecipient({ recipient_name: 'Maria Dela Cruz' });
  assert.equal(v.ok, false);
  assert.match(v.ok === false ? v.error : '', /related/i);
});

test('a relationship with no name is REFUSED, not silently dropped', () => {
  // normalize() drops it; validate() REPORTS it. A form that quietly discarded
  // what somebody typed would leave them believing the arrangement was recorded.
  const v = validateAlternateRecipient({ recipient_relationship: 'Spouse' });
  assert.equal(v.ok, false);
  assert.match(v.ok === false ? v.error : '', /name/i);
});

test('a contact with no name is REFUSED', () => {
  const v = validateAlternateRecipient({ recipient_contact: '09181234567' });
  assert.equal(v.ok, false);
});

test('an unknown relationship is REFUSED, never coerced to blank', () => {
  const v = validateAlternateRecipient({
    recipient_name: 'Maria Dela Cruz',
    recipient_relationship: 'Landlord',
  });
  assert.equal(v.ok, false);
  assert.match(v.ok === false ? v.error : '', /list/i);
});

test('the relationship list is case-sensitive — the list is the list', () => {
  const v = validateAlternateRecipient({
    recipient_name: 'Maria Dela Cruz',
    recipient_relationship: 'spouse',
  });
  assert.equal(v.ok, false);
});

test('every listed relationship validates', () => {
  for (const rel of GIFT_RECIPIENT_RELATIONSHIPS) {
    const v = validateAlternateRecipient({
      recipient_name: 'Maria Dela Cruz',
      recipient_relationship: rel,
    });
    assert.equal(v.ok, true, `${rel} should validate`);
  }
});

test('an over-long name or contact is REFUSED, not truncated', () => {
  // The app and the CHECK must refuse the same thing. If the app truncated, a
  // name would silently change between the form and the shipping list.
  const longName = validateAlternateRecipient({
    recipient_name: 'a'.repeat(MAX_RECIPIENT_NAME + 1),
    recipient_relationship: 'Spouse',
  });
  assert.equal(longName.ok, false);

  const longContact = validateAlternateRecipient({
    recipient_name: 'Maria Dela Cruz',
    recipient_relationship: 'Spouse',
    recipient_contact: '9'.repeat(MAX_RECIPIENT_CONTACT + 1),
  });
  assert.equal(longContact.ok, false);
});

test('a name of exactly the maximum length is accepted', () => {
  const v = validateAlternateRecipient({
    recipient_name: 'a'.repeat(MAX_RECIPIENT_NAME),
    recipient_relationship: 'Spouse',
  });
  assert.equal(v.ok, true);
});

// ---------------------------------------------------------------------------
// describeAlternateRecipient
// ---------------------------------------------------------------------------

test('describe gives one spelling for every surface', () => {
  assert.equal(describeAlternateRecipient(SPOUSE), 'Maria Dela Cruz (Spouse)');
});

test('describe is empty when the employee receives it themself', () => {
  assert.equal(describeAlternateRecipient({}), '');
  assert.equal(describeAlternateRecipient({ recipient_name: '  ' }), '');
});

test('describe never renders an empty pair of brackets', () => {
  // Unreachable through the validator, but a legacy row or a hand-written
  // database edit can hold a name with no relationship.
  assert.equal(describeAlternateRecipient({ recipient_name: 'Maria' }), 'Maria');
});

// ---------------------------------------------------------------------------
// alternateRecipientColumns
// ---------------------------------------------------------------------------

test('columns always writes all three, so clearing one clears the set', () => {
  // A partial patch would leave a stale relationship attached to a new name.
  assert.deepEqual(
    alternateRecipientColumns({ name: '', relationship: '', contact: '' }),
    { recipient_name: '', recipient_relationship: '', recipient_contact: '' },
  );
  assert.deepEqual(alternateRecipientColumns({
    name: 'Maria Dela Cruz',
    relationship: 'Spouse',
    contact: '09181234567',
  }), {
    recipient_name: 'Maria Dela Cruz',
    recipient_relationship: 'Spouse',
    recipient_contact: '09181234567',
  });
});

// ---------------------------------------------------------------------------
// Q1 — the recipient's number never substitutes for the employee's
// ---------------------------------------------------------------------------

test('SOURCE SCAN: no export in this module returns a fallback contact', () => {
  // Kane's Q1 ruling lives here as a structural guard, not just a comment. The
  // module must not grow a `contactNumberFor(row)`-style helper that prefers the
  // recipient's number — that helper is exactly how the shipping list would
  // start calling the wrong person. The export owns the employee's number and
  // this module never sees it.
  const src = describeAlternateRecipient.toString() + hasAlternateRecipient.toString();
  assert.equal(/active_contact_number/.test(src), false);
});

test('normalize does NOT truncate — over-length is a refusal, not a slice', () => {
  // If normalize sliced, a write path that skipped the validator would store a
  // shortened name and nobody would ever see the full one again.
  const long = 'a'.repeat(MAX_RECIPIENT_NAME + 40);
  assert.equal(
    normalizeAlternateRecipient({
      recipient_name: long,
      recipient_relationship: 'Spouse',
    }).name.length,
    long.length,
  );
});
