/**
 * Envelopes for the Manager -> My Team list "Suspend" / "Reactivation" buttons
 * (the manager-facing temporary-pause pair; the temp-pause reason is disabled
 * in the manager offboard modal — these buttons replace it):
 *
 *   Suspend      -> slug `manager_suspend`, default endpoint the SAME
 *                   offboarding-deactivate flow HR temp pauses ride. The
 *                   payload mirrors the HR `temporary_pause` envelope EXACTLY
 *                   (event employee.offboarded / phase deactivate /
 *                   deletion_mode "none" / scheduled_deletion_at null) so the
 *                   existing n8n flow suspends the Workspace account with no
 *                   n8n changes. `source` is additive — a future branch can
 *                   tell manager suspends from HR temp pauses.
 *   Reactivation -> slug `manager_reactivate`, default endpoint the
 *                   hris-reactivate-suspended flow, which re-enables the
 *                   account and emails a confirmation. Its own envelope
 *                   (event employee.reactivate / phase reactivate /
 *                   reactivated_by / reactivated_at) — NOT the offboard one;
 *                   `reason` and `note` are not required by that flow.
 *
 * Neither writes offboard stamps — suspend/reactivate is account state only.
 * Pure builders so the contracts are unit-testable (see the .test.ts) and
 * can't silently drift from what the n8n workflows expect.
 */

export type TempPausePerson = {
  work_email: string | null;
  personal_email: string | null;
  name: string | null;
  /** Every department the person appears under (dual-department people have
   *  one roster row per department — send the union, like offboarding does). */
  departments: string[];
  start_date: string | null;
};

/** Mirrors OffboardEmployeePayload (app/api/hr/offboard/route.ts) — each item
 *  must stay self-contained after n8n's Split Out. */
export type SuspendEmployeePayload = TempPausePerson & {
  reason: 'temporary_pause';
  note: string | null;
  off_boarded_by: string;
  off_boarded_at: string;
  scheduled_deletion_at: null;
};

export type SuspendWebhookEnvelope = {
  event: 'employee.offboarded';
  phase: 'deactivate';
  deletion_mode: 'none';
  hubstaff_pay_rate: 0;
  off_boarded_by: string;
  off_boarded_at: string;
  source: 'manager_suspend';
  count: number;
  employees: SuspendEmployeePayload[];
};

export function buildManagerSuspendPayload(
  person: TempPausePerson,
  triggeredBy: string,
  triggeredAt: string,
): SuspendWebhookEnvelope {
  return {
    event: 'employee.offboarded',
    phase: 'deactivate',
    deletion_mode: 'none',
    hubstaff_pay_rate: 0,
    off_boarded_by: triggeredBy,
    off_boarded_at: triggeredAt,
    source: 'manager_suspend',
    count: 1,
    employees: [
      {
        work_email: person.work_email,
        personal_email: person.personal_email,
        name: person.name,
        departments: person.departments,
        start_date: person.start_date,
        reason: 'temporary_pause',
        note: null,
        off_boarded_by: triggeredBy,
        off_boarded_at: triggeredAt,
        scheduled_deletion_at: null,
      },
    ],
  };
}

/** Mirrors the `hris-reactivate-suspended` contract Kane verified on the n8n
 *  side (2026-08-10). Self-contained per item, like the offboard payloads, so
 *  n8n's Split Out loses nothing. `note` is carried but never required — the
 *  flow only sends a confirmation email, and the Reactivation button has no
 *  note input, so it is always null today. */
export type ReactivateEmployeePayload = TempPausePerson & {
  note: string | null;
  reactivated_by: string;
  reactivated_at: string;
};

export type ReactivateWebhookEnvelope = {
  event: 'employee.reactivate';
  phase: 'reactivate';
  reactivated_by: string;
  reactivated_at: string;
  count: number;
  employees: ReactivateEmployeePayload[];
};

export function buildManagerReactivatePayload(
  person: TempPausePerson,
  triggeredBy: string,
  triggeredAt: string,
): ReactivateWebhookEnvelope {
  return {
    event: 'employee.reactivate',
    phase: 'reactivate',
    reactivated_by: triggeredBy,
    reactivated_at: triggeredAt,
    count: 1,
    employees: [
      {
        work_email: person.work_email,
        personal_email: person.personal_email,
        name: person.name,
        departments: person.departments,
        start_date: person.start_date,
        note: null,
        reactivated_by: triggeredBy,
        reactivated_at: triggeredAt,
      },
    ],
  };
}
