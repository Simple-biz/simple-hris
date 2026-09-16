import test from 'node:test';
import assert from 'node:assert/strict';
import {
  staffReplyRecipient,
  employeeReplyRecipient,
  ticketFiledRecipient,
} from './recipients';

const EMPLOYEE = 'mariac@simple.biz';
const STAFFER = 'carla@simple.biz';

test('a staff reply always reaches the employee who asked', () => {
  assert.equal(staffReplyRecipient({ work_email: EMPLOYEE, claimed_by: STAFFER }), EMPLOYEE);
  assert.equal(staffReplyRecipient({ work_email: EMPLOYEE, claimed_by: null }), EMPLOYEE);
});

test('an employee reply reaches the staffer holding the ticket', () => {
  assert.equal(employeeReplyRecipient({ work_email: EMPLOYEE, claimed_by: STAFFER }), STAFFER);
});

test('an employee reply on an unclaimed ticket emails nobody', () => {
  // Deliberate: the staff section's "needs reply" filter already surfaces it.
  // Widening this to all five answerers is the thing not to do.
  assert.equal(employeeReplyRecipient({ work_email: EMPLOYEE, claimed_by: null }), null);
});

test('a missing support inbox sends nothing rather than an empty To', () => {
  assert.equal(ticketFiledRecipient(null), null);
  assert.equal(ticketFiledRecipient(undefined), null);
  assert.equal(ticketFiledRecipient(''), null);
  assert.equal(ticketFiledRecipient('   '), null);
});

test('a configured support inbox is used as given, normalised', () => {
  assert.equal(ticketFiledRecipient('  Support@Simple.biz '), 'support@simple.biz');
});

test('every function returns null rather than an empty string', () => {
  // The Gmail node is stop-on-error: an empty To fails the whole run instead of
  // skipping one message. Null is the contract; '' is the incident.
  const blanks = [null, undefined, '', '   '];
  for (const b of blanks) {
    assert.equal(staffReplyRecipient({ work_email: b as string, claimed_by: STAFFER }), null);
    assert.equal(employeeReplyRecipient({ work_email: EMPLOYEE, claimed_by: b as string }), null);
    assert.equal(ticketFiledRecipient(b as string), null);
  }
});

test('casing and whitespace never decide who gets mailed', () => {
  assert.equal(
    staffReplyRecipient({ work_email: '  MariaC@Simple.BIZ ', claimed_by: null }),
    EMPLOYEE,
  );
  assert.equal(
    employeeReplyRecipient({ work_email: EMPLOYEE, claimed_by: ' CARLA@simple.biz' }),
    STAFFER,
  );
});
