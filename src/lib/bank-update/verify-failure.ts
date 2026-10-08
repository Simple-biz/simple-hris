import type { VerifyResult } from "./otp";

type VerifyFailureReason = Extract<VerifyResult, { ok: false }>["reason"];

/** The ONE sentence a failed code check answers with, whatever went wrong. */
export const VERIFY_FAILURE_MESSAGE = "That code is invalid or expired. Request a new one.";

/**
 * What `/api/bank-update/verify-otp` returns for a failed check. Identical for
 * every reason, on purpose (Open item 266 #1, closed 2026-10-08).
 *
 * `invalid` and `locked` occur only when a live code exists for an ACTIVE
 * employee's inbox; a non-employee always reads `expired` (`otp.ts` verifyOtp).
 * So request a code for any address, submit a wrong one, and a body that says
 * which reason it was, or a message that differs for `locked` ("Too many
 * incorrect attempts"), tells anyone whether that address belongs to an active
 * employee. The gift link answers one failure for every shape
 * (gift-address-external-link.md); this matches it.
 *
 * The reason is taken and DISCARDED so the call site documents that it was
 * considered. It still goes to the server-side audit row, which the public never
 * reads. Pinned by `verify-failure.test.ts`, which also scans the route.
 */
export function verifyFailureResponse(_reason: VerifyFailureReason): {
  body: { error: string };
  status: 401;
} {
  return { body: { error: VERIFY_FAILURE_MESSAGE }, status: 401 };
}
