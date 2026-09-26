/**
 * Which HR → Onboarding status filter a submission lives under.
 *
 * Archived splits in two (Kane, 2026-09-25): an archived submission whose
 * linked hire was PROMOTED is "Archived/Complete" and lives under the Archive
 * icon pill; every other archived submission (never submitted, no-show, no hire
 * record, staged but never promoted) stays under the plain "Archived" pill.
 * Neither ever appears under "All", which is the live pipeline only.
 *
 * `pending_status` is the linked hire's status, attached server-side by
 * `listHrOnboardingSubmissions`.
 */
export type OnboardingSubmissionBucket = 'pending' | 'submitted' | 'archived' | 'complete';

export function onboardingSubmissionBucket(r: {
  status: 'pending' | 'submitted' | 'archived';
  pending_status?: string | null;
}): OnboardingSubmissionBucket {
  if (r.status !== 'archived') return r.status;
  return r.pending_status === 'promoted' ? 'complete' : 'archived';
}

/** True for the two archived buckets — the rows "All" leaves out. */
export function isArchivedBucket(b: OnboardingSubmissionBucket): boolean {
  return b === 'archived' || b === 'complete';
}
