import { normEmail } from '@/lib/email/norm-email';

/**
 * What promote does with a `global_master_list` row that already holds this
 * hire's (Work Email, Department) — the pair the schema enforces unique, so a
 * rehire can never get a second row and has to go back onto the old one.
 *
 * Before 2026-09-24 promote reused the row by re-stamping `last_seen_upload_id`
 * and never looked at `off_boarded_at`. A rehire whose old stint was still
 * stamped landed "promoted" yet invisible to `active_employees` and every
 * surface built on it (audit items 186 / 197 — `aireenp@`, `irenef@`, 47 rows).
 *
 * Kane chose (b) on 2026-09-24: promote brings the row back itself, but only
 * when the row provably belongs to the SAME person. Work emails are recycled
 * (`markg@` held four humans), so the work email proves nothing; the row's
 * Personal Email has to match the hire's. Anything that cannot be proven the
 * same person is REFUSED — never reactivated, never silently reused.
 */
export type MasterReuseDecision =
  | { kind: 'reuse' }
  | { kind: 'reactivate'; previousOffBoardedAt: string; previousReason: string | null }
  | { kind: 'refuse'; error: string };

export interface ExistingMasterRow {
  offBoardedAt: string | null;
  offBoardedReason: string | null;
  personalEmail: string | null;
}

export interface PendingHireIdentity {
  personalEmail: string | null;
  workEmail: string;
  department: string;
}

export function decideMasterRowReuse(
  existing: ExistingMasterRow,
  hire: PendingHireIdentity,
): MasterReuseDecision {
  if (!existing.offBoardedAt) return { kind: 'reuse' };

  const rowPersonal = normEmail(existing.personalEmail ?? '');
  const hirePersonal = normEmail(hire.personalEmail ?? '');
  const where = `${hire.workEmail} in ${hire.department}`;

  if (!rowPersonal || !hirePersonal) {
    return {
      kind: 'refuse',
      error:
        `The master-list row for ${where} is off-boarded and has no personal email to prove it is the same person. ` +
        'It was not reactivated. Ask an admin to resolve the row before promoting.',
    };
  }
  if (rowPersonal !== hirePersonal) {
    return {
      kind: 'refuse',
      error:
        `The master-list row for ${where} is off-boarded and belongs to a different personal email — ` +
        'this work email was used by someone else before. It was not reactivated. Ask an admin to resolve the row before promoting.',
    };
  }
  return {
    kind: 'reactivate',
    previousOffBoardedAt: existing.offBoardedAt,
    previousReason: existing.offBoardedReason,
  };
}
