/**
 * Decides what a real offboard should do when the guarded stamp UPDATE in
 * POST /api/hr/offboard matched ZERO active rows — i.e. every master-list row
 * for the email is already off-boarded (or the email isn't on the roster).
 *
 * The routing invariant (docs/features/offboarding-automation.md): EVERY
 * offboard fires `offboarding_delete`; `offboarding_deactivate` is the
 * suspend/temporary-pause pathway only. A person suspended via a
 * `temporary_pause` offboard is stamped but was never deleted — so a later
 * real offboard MUST still ride the delete pathway (escalation), not vanish
 * into a 404. Conversely, a person already off-boarded with a real reason has
 * already been through the delete automation — re-firing it would send
 * duplicate teardown/termination emails, so that stays a hard no-op.
 */

export interface OffboardedRowState {
  off_boarded_reason: string | null;
  off_boarded_at: string | null;
}

export type ZeroStampOutcome =
  /** Email has no master-list rows at all — genuinely not on the roster. */
  | { kind: "not_found" }
  /**
   * At least one row is a temporary-pause suspension and the incoming reason
   * is a real offboard: re-stamp those rows and fire `offboarding_delete`.
   */
  | { kind: "escalate_paused" }
  /** Incoming reason is itself temporary_pause but the person is already off-boarded. */
  | { kind: "pause_on_offboarded" }
  /** Already off-boarded with a real reason — the delete automation already ran. */
  | { kind: "already_offboarded"; reason: string | null; off_boarded_at: string | null };

export function classifyZeroStampOffboard(
  incomingReason: string,
  rows: OffboardedRowState[],
): ZeroStampOutcome {
  const offboarded = rows.filter((r) => r.off_boarded_at !== null);
  if (offboarded.length === 0) return { kind: "not_found" };

  if (incomingReason === "temporary_pause") return { kind: "pause_on_offboarded" };

  // Mixed states (dual-department rows) escalate too: any surviving
  // suspension means the account still exists and must be torn down.
  if (offboarded.some((r) => r.off_boarded_reason === "temporary_pause")) {
    return { kind: "escalate_paused" };
  }

  const first = offboarded[0]!;
  return {
    kind: "already_offboarded",
    reason: first.off_boarded_reason,
    off_boarded_at: first.off_boarded_at,
  };
}
