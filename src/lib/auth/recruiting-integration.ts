import 'server-only';

import type { AuthzOk } from './authorize-email';

/**
 * Server-to-server auth for simple-recruitment calling into the onboarding
 * link create/send endpoints, so a recruiter can hand a hired applicant off
 * to onboarding without leaving the recruiting app. Same shape as
 * cron-auth.ts's CRON_SECRET check — Authorization: Bearer <secret>, fail
 * CLOSED when the secret isn't configured (missing secret must never mean
 * "open"). Checked inline in each route ahead of the session check, so a
 * valid secret short-circuits without a DB/session round-trip.
 */
const RECRUITING_ACTOR_EMAIL = 'hr@simple.biz';

export function recruitingIntegrationAuthorized(req: Request): AuthzOk | null {
  const expected = process.env.RECRUITING_INTEGRATION_SECRET?.trim();
  if (!expected) return null;
  const got = req.headers.get('authorization') ?? '';
  if (got !== `Bearer ${expected}`) return null;
  return {
    ok: true,
    sessionEmail: RECRUITING_ACTOR_EMAIL,
    effectiveEmail: RECRUITING_ACTOR_EMAIL,
    elevated: true,
    roles: ['recruiting-integration'],
  };
}
