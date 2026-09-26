/**
 * Run:  npx tsx --test src/lib/hr/onboarding-submission-bucket.test.ts
 */
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { isArchivedBucket, onboardingSubmissionBucket } from './onboarding-submission-bucket';

describe('onboardingSubmissionBucket', () => {
  it('keeps live rows in their own status, whatever the hire says', () => {
    assert.equal(onboardingSubmissionBucket({ status: 'pending', pending_status: null }), 'pending');
    assert.equal(onboardingSubmissionBucket({ status: 'submitted', pending_status: 'promoted' }), 'submitted');
    assert.equal(onboardingSubmissionBucket({ status: 'submitted', pending_status: 'pending_work_email' }), 'submitted');
  });

  it('files an archived row with a promoted hire as complete', () => {
    assert.equal(onboardingSubmissionBucket({ status: 'archived', pending_status: 'promoted' }), 'complete');
  });

  it('files every other archived row as plain archived', () => {
    for (const pending_status of [null, undefined, 'no_show', 'ready', 'pending_work_email', 'failed_to_promote']) {
      assert.equal(onboardingSubmissionBucket({ status: 'archived', pending_status }), 'archived', String(pending_status));
    }
  });

  it('treats both archived buckets as archived, and nothing else', () => {
    assert.equal(isArchivedBucket('archived'), true);
    assert.equal(isArchivedBucket('complete'), true);
    assert.equal(isArchivedBucket('pending'), false);
    assert.equal(isArchivedBucket('submitted'), false);
  });
});
