/** [TERMINATION-DOCS]
 * G1 — the residue: a THIRD PARTY'S personal inbox parked in an
 * "Alternate Work Email" cell.
 *
 * Round 1 closed the obvious half: the rate alias set stopped carrying the
 * subject's OWN personal email. Round 2 found what that leaves standing —
 * `workAliasesForRateContext` can only see the SUBJECT'S master rows, so it
 * drops the harmless self-match and KEEPS someone else's gmail sitting in an
 * alternate-work cell. `hr_pending_employees` and `employee_rate_history` are
 * both keyed by whatever address the sheet era held, so that one cell prints a
 * different person's rate as this person's STARTING RATE, on a signed page and
 * permanently on the log row.
 *
 * The fixtures below are THIRD-PARTY fixtures, not self-match fixtures: the
 * screened address belongs to somebody else entirely, which is the shape the
 * round-1 fix could not see.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  screenWorkAliases,
  type TerminationAliasScreenPort,
} from './termination-alias-screen';

const SUBJECT = 'carlath@simple.biz';
/** Somebody ELSE's personal inbox — Maria Argote's, say — typed into the
 *  subject's "Alternate Work Email" cell by a sheet editor. */
const THIRD_PARTY_INBOX = 'mariaargote88@gmail.com';
const REAL_ALTERNATE = 'carla.thomas@simple.biz';

/** Records what was looked up, so "the screen ran" is never assumed. */
function port(
  personal: string[],
  error: string | null = null,
): TerminationAliasScreenPort & { looked: string[] } {
  const looked: string[] = [];
  return {
    looked,
    async isRecordedAsPersonalEmail(email: string) {
      looked.push(email);
      if (error) return { found: false, error };
      return { found: personal.includes(email), error: null };
    },
  };
}

test("G1: a THIRD PARTY's personal inbox in an alternate-work cell never keys a rate", async () => {
  const p = port([THIRD_PARTY_INBOX]);

  const res = await screenWorkAliases(SUBJECT, [SUBJECT, THIRD_PARTY_INBOX], p);

  assert.deepEqual(
    res.workAliases,
    [SUBJECT],
    "another person's personal inbox survived into the rate alias set",
  );
  assert.deepEqual(res.dropped, [
    { email: THIRD_PARTY_INBOX, reason: 'recorded_as_personal_email' },
  ]);
  assert.match(res.degraded.join(' '), /PERSONAL email/);
  assert.deepEqual(p.looked, [THIRD_PARTY_INBOX], 'the screen never ran, or ran on the identity');
});

test('G1: a genuine alternate WORK address still keys a rate', async () => {
  // The negative control. Without it, "drops personal inboxes" is satisfied by
  // dropping everything, and every alternate-work rate silently becomes a blank.
  const p = port([THIRD_PARTY_INBOX]);

  const res = await screenWorkAliases(SUBJECT, [SUBJECT, REAL_ALTERNATE], p);

  assert.deepEqual(res.workAliases, [SUBJECT, REAL_ALTERNATE]);
  assert.deepEqual(res.dropped, []);
  assert.deepEqual(res.degraded, []);
});

test("G1: the subject's OWN work email is never screened out of its own rate lookup", async () => {
  // A work address that also sits in somebody's "Personal Email" cell is a
  // roster defect, not a licence to resolve the letter with no address at all.
  const p = port([SUBJECT]);

  const res = await screenWorkAliases(SUBJECT, [SUBJECT], p);

  assert.deepEqual(res.workAliases, [SUBJECT]);
  assert.deepEqual(p.looked, [], 'the identity itself was sent to the screen');
});

test('G1: a FAILED screen drops the alias — an unverified address may not price a letter', async () => {
  // Fail closed. The alias set is only ever a widening, so losing one address
  // costs a blank the rep fills; keeping an unverified one costs a wrong figure
  // on a signed legal document.
  const p = port([], 'canceling statement due to statement timeout');

  const res = await screenWorkAliases(SUBJECT, [SUBJECT, REAL_ALTERNATE], p);

  assert.deepEqual(res.workAliases, [SUBJECT]);
  assert.deepEqual(res.dropped, [{ email: REAL_ALTERNATE, reason: 'screen_read_failed' }]);
  assert.match(res.degraded.join(' '), /could not be checked/);
});

test('G1: the identity survives even when the caller forgot to include it', async () => {
  const p = port([]);
  const res = await screenWorkAliases(SUBJECT, [REAL_ALTERNATE], p);
  assert.deepEqual(res.workAliases, [SUBJECT, REAL_ALTERNATE]);
});

test('G1: a repeated alias is looked up once', async () => {
  const p = port([]);
  const res = await screenWorkAliases(SUBJECT, [SUBJECT, REAL_ALTERNATE, REAL_ALTERNATE], p);
  assert.deepEqual(res.workAliases, [SUBJECT, REAL_ALTERNATE]);
  assert.deepEqual(p.looked, [REAL_ALTERNATE]);
});
