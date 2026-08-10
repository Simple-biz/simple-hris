/**
 * Canonical offboarding reason set — shared by:
 *   - the HR Offboard dialog (HrOffboarding.tsx)
 *   - the Manager "Queue for offboarding" dialog (ManagerOffboardQueueDialog.tsx)
 *   - the HR queue processor (HrOffboardQueueProcessor.tsx)
 *   - server validation (POST /api/hr/offboard keeps its own copy authoritative,
 *     but MUST stay in sync with VALID_OFFBOARD_REASONS below)
 *
 * `other` requires a free-text note.
 */
export const VALID_OFFBOARD_REASONS = [
  'ncns',
  'resigned',
  'end_of_contract',
  'performance',
  'attendance',
  'time_manipulation',
  'temporary_pause',
  'other',
] as const;

export type OffboardReason = (typeof VALID_OFFBOARD_REASONS)[number];

export const OFFBOARD_REASON_OPTIONS: { value: OffboardReason; label: string }[] = [
  { value: 'ncns', label: 'NCNS (No Call, No Show)' },
  { value: 'resigned', label: 'Resigned' },
  { value: 'end_of_contract', label: 'End of contract' },
  { value: 'performance', label: 'Performance' },
  { value: 'attendance', label: 'Attendance' },
  { value: 'time_manipulation', label: 'Time manipulation' },
  // Suspends the Workspace account (offboarding_deactivate) but never schedules
  // the 14-day delete — for employees taking approved time off who will return.
  { value: 'temporary_pause', label: 'Temporary Pause' },
  { value: 'other', label: 'Other (note required)' },
];

/** Short display label for a stored reason key (falls back to the raw value). */
export const OFFBOARD_REASON_LABELS: Record<string, string> = {
  ncns: 'NCNS',
  resigned: 'Resigned',
  end_of_contract: 'End of contract',
  performance: 'Performance',
  attendance: 'Attendance',
  time_manipulation: 'Time manipulation',
  temporary_pause: 'Temporary Pause',
  other: 'Other',
};

export function isValidOffboardReason(v: string | null | undefined): v is OffboardReason {
  return !!v && (VALID_OFFBOARD_REASONS as readonly string[]).includes(v);
}

/**
 * Reasons a MANAGER-raised offboard (the My Team Offboard action → offboarding
 * queue → HR processor) may carry. Everything in the queue rides the DELETE
 * pathway when HR processes it, so `temporary_pause` — a suspension, owned by
 * the Suspend action / HR's own dialog — is not queueable. Enforced server-side
 * at POST /api/offboarding-queue and at the queue-completion PATCH; the manager
 * dialog and the HR queue processor consume this too so all four surfaces share
 * one gate.
 */
export type QueueableOffboardReason = Exclude<OffboardReason, 'temporary_pause'>;

export function isQueueableOffboardReason(
  v: string | null | undefined,
): v is QueueableOffboardReason {
  return isValidOffboardReason(v) && v !== 'temporary_pause';
}

export function offboardReasonLabel(v: string | null | undefined): string {
  if (!v) return '—';
  return OFFBOARD_REASON_LABELS[v] ?? v;
}
