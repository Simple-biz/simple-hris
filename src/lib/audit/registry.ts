/**
 * The audit-action registry — the single source of truth for what an
 * `audit_log.action` string MEANS and which dashboard it came from.
 *
 * Why this file exists: the same knowledge used to live in two hand-maintained
 * places that drifted apart —
 *
 *  1. `AuditLogPanel`'s `CATEGORIES` array (14 client-side `match` predicates),
 *     which covered no `orphanage.*`, `wizard.*`, `dispatch.*`, `documents.*`,
 *     `people.*`, `bank_*`, `ticket.*`, `time_adjustment.*`,
 *     `feature_permission.*` or `*_assistant.*` action — so every one of those
 *     rows was reachable only under "All activity", with no badge.
 *  2. The `search_audit_log` tool description in `admin-tools.ts`, whose prose
 *     family list had already drifted once (it named actions that do not exist
 *     and omitted three of the largest real families — see
 *     memory/penny-audit-log-visibility.md).
 *
 * Both now derive from `AUDIT_FAMILIES`. Adding a family here reaches the Admin
 * panel filter, the row badge, and Admin Penny's tool description at once, and
 * `registry.test.ts` fails the build if a NEW action is emitted anywhere in the
 * codebase without a family to land in.
 *
 * This module is deliberately isomorphic — no `server-only`, no imports — so the
 * client panel and the `server-only` tool files can share it.
 */

// ─── Surfaces ─────────────────────────────────────────────────────────────────

/**
 * The dashboard an action originates on. This is the panel's primary filter
 * axis, so it names dashboards a person can actually open — not code modules.
 *
 * A family may list several: a PAB dispute is filed on Orphanage and decided on
 * Accounting, and both teams look for it under their own name.
 */
export type AuditSurface =
  | 'accounting'
  | 'ceo'
  | 'hr'
  | 'orphanage'
  | 'payroll'
  | 'manager'
  | 'employee'
  | 'tickets'
  | 'admin';

export type AuditSurfaceDef = {
  readonly id: AuditSurface;
  readonly label: string;
  /** Compact label for the row badge. */
  readonly shortLabel: string;
};

export const AUDIT_SURFACES: readonly AuditSurfaceDef[] = [
  { id: 'accounting', label: 'Accounting', shortLabel: 'Acct' },
  { id: 'payroll', label: 'Payroll & dispatch', shortLabel: 'Payroll' },
  { id: 'hr', label: 'HR', shortLabel: 'HR' },
  { id: 'orphanage', label: 'Orphanage', shortLabel: 'Orph' },
  { id: 'ceo', label: 'CEO', shortLabel: 'CEO' },
  { id: 'manager', label: 'Manager', shortLabel: 'Mgr' },
  { id: 'employee', label: 'Employee', shortLabel: 'Empl' },
  { id: 'tickets', label: 'Tickets board', shortLabel: 'Tickets' },
  { id: 'admin', label: 'Admin & system', shortLabel: 'System' },
] as const;

const SURFACE_LABELS = new Map<AuditSurface, AuditSurfaceDef>(
  AUDIT_SURFACES.map((s) => [s.id, s]),
);

export function auditSurfaceDef(id: AuditSurface): AuditSurfaceDef {
  const def = SURFACE_LABELS.get(id);
  // AUDIT_SURFACES covers the whole union by construction; a miss is a typo in
  // this file, not a runtime condition worth a silent fallback.
  if (!def) throw new Error(`Unknown audit surface: ${id}`);
  return def;
}

// ─── Families ─────────────────────────────────────────────────────────────────

export type AuditFamily = {
  /**
   * Action prefix (`'orphanage.'`) or, with `exact: true`, one whole action
   * name (`'people.profile.updated'`). Matching picks the LONGEST match, so a
   * narrow family always beats a broad one no matter how this array is ordered
   * — the old panel depended on array order ("listed before `csv` so
   * `csv.rates.sync` is tagged as a sync"), which broke the moment anyone
   * re-sorted it.
   */
  readonly match: string;
  readonly exact?: true;
  /** Dashboards where this family is raised or acted on. Never empty. */
  readonly surfaces: readonly [AuditSurface, ...AuditSurface[]];
  /** Human label — panel badge + Penny's family list. */
  readonly label: string;
  /** One line for Penny. Ships inside a tool description: keep it short. */
  readonly note?: string;
};

/**
 * Every action family in the log. Prefixes, so a historical action that code no
 * longer emits still resolves — the table is append-only and reaches back to
 * 2026-06-06.
 */
export const AUDIT_FAMILIES: readonly AuditFamily[] = [
  // ── Payroll & dispatch ─────────────────────────────────────────────────────
  {
    match: 'wizard.',
    surfaces: ['payroll', 'accounting'],
    label: 'Payroll Wizard',
    note: 'opened, cycle_selected, bonus_edited, addition_edited, config.dept_pay, fx_rate_changed, orphanage_period_cleared',
  },
  {
    match: 'payroll.',
    surfaces: ['payroll', 'accounting'],
    label: 'Rates, KPI & dispatch lock',
    note: 'rate.set, rate.exempted, kpi.marked_ready/locked/reopened, bank.exempted, dispatch.locked/unlocked/lock_changed',
  },
  {
    match: 'payment.',
    surfaces: ['payroll', 'accounting'],
    label: 'Payment dispatch',
    note: 'dispatched, undone (undo DELETES the dispatch row, so the event carries the full payment snapshot)',
  },
  {
    match: 'payment_cycle.',
    surfaces: ['payroll', 'accounting'],
    label: 'Pay cycle close-out',
    note: 'closed, completed, reopened',
  },
  {
    match: 'paystub',
    surfaces: ['payroll', 'accounting'],
    label: 'Paystubs',
    note: 'paystubs.staged/dispatched, paystub.sent/send_failed',
  },
  {
    match: 'dispatch.',
    surfaces: ['payroll', 'accounting'],
    label: 'Dispatch lock',
    note: 'lock_acquired, lock_released',
  },
  {
    match: 'pab_exclusion.',
    surfaces: ['payroll', 'accounting'],
    label: 'PAB exclusions',
    note: 'added/removed — zeroes a whole month of PAB for one person; trail starts 2026-08-20, earlier entries have no author',
  },

  // ── Accounting ─────────────────────────────────────────────────────────────
  {
    match: 'accounting.payroll_wizard_notes.',
    surfaces: ['accounting'],
    label: 'Payroll Notes board',
    note: 'row_added/row_updated/row_deleted/adjustment_bridged. The event carries only a note-row UUID — use get_payroll_notes_history to resolve the worker and week',
  },
  {
    match: 'accounting.payroll_wizard.',
    surfaces: ['accounting', 'payroll'],
    label: 'Manual Validation (MV)',
    note: 'manual_validation.set / .cleared — the per-person MV overrides on the wizard',
  },
  {
    match: 'bonus_catalog.',
    surfaces: ['accounting'],
    label: 'Bonus library definitions',
    note: 'definition.saved/deleted — the Payment Catalog bonus definitions the KPI calculator pays from',
  },
  {
    match: 'system_bonus.',
    surfaces: ['accounting'],
    label: 'Custom system bonuses',
    note: 'saved/deleted — the custom `pab:*` / `tech:*` system-bonus codes',
  },
  {
    match: 'hsl_bonus.',
    surfaces: ['accounting', 'manager'],
    label: 'HSL bonus entries',
    note: 'entries.saved/deleted and period_deleted (a dept+period wipe: the event carries the deleted row ids and totals)',
  },
  {
    match: 'bank.',
    surfaces: ['accounting'],
    label: 'Bank registry',
    note: 'create/update of the declared bank-name table',
  },
  {
    match: 'pay_processor.',
    surfaces: ['accounting'],
    label: 'Pay processors registry',
    note: 'create/update — the source-of-truth processor list',
  },
  {
    match: 'special_transfer.',
    surfaces: ['accounting'],
    label: 'Accounting transfers',
  },
  {
    match: 'contractor.',
    surfaces: ['accounting'],
    label: 'Contractors',
    note: 'decided, retracted, banking.updated',
  },
  {
    match: 'urgent_payment.',
    surfaces: ['accounting'],
    label: 'Urgent one-off payments',
    note: 'requested, dispatched, cancelled, link_failed',
  },
  {
    match: 'documents.',
    surfaces: ['accounting', 'employee'],
    label: 'Documents & COE',
    note: 'request_submitted/signed/rejected/cancelled/deleted, termination_generated, termination_writeback',
  },
  {
    match: 'qc.',
    surfaces: ['accounting', 'manager'],
    label: 'QC scoring',
    note: 'review.*, scores.locked/reopened, compare_override_applied',
  },
  {
    match: 'mesa.',
    surfaces: ['accounting'],
    label: 'MESA program',
    note: 'request.*, disbursement.dispatched, receipt.uploaded/deleted, note.added, dispatch.stamp_failed',
  },
  {
    match: 'employee.mesa.',
    surfaces: ['accounting', 'employee'],
    label: 'MESA membership',
    note: 'enroll / unenroll',
  },
  {
    match: 'time_adjustment.',
    surfaces: ['accounting', 'manager'],
    label: 'Time adjustments',
    note: 'submitted, approved/denied, second_approver_assigned, recalled, deleted',
  },
  {
    match: 'leave.',
    surfaces: ['accounting', 'manager'],
    label: 'Leave requests',
    note: 'request, approved/rejected, cancelled, admin_deleted, owner_deleted',
  },
  {
    match: 'pab_dispute.',
    surfaces: ['accounting', 'orphanage'],
    label: 'PAB day disputes',
    note: 'submitted (orphanage manager or employee), edited, approved/denied, revoked, month_forgiven, withdrawn, admin_deleted, orphanage_returned_to_manager',
  },

  // ── Orphanage ──────────────────────────────────────────────────────────────
  {
    match: 'orphanage_registry.',
    surfaces: ['orphanage'],
    label: 'Orphanage registry',
    note: 'created/updated/deleted/photo_uploaded — the orphanage list itself (name, budget, photos). A delete carries the whole prior row',
  },
  {
    match: 'orphanage.',
    surfaces: ['orphanage'],
    label: 'Orphanage budget & vendors',
    note: 'budget_decided, dispatched, vendor.saved/deleted, vendor_invoice.created/updated/paid/deleted, worker_payment.*',
  },
  {
    match: 'orphanage_budget.',
    surfaces: ['orphanage', 'accounting'],
    label: 'Orphanage budget requests',
    note: 'created, approved, denied',
  },
  {
    match: 'orphanage_intern',
    surfaces: ['orphanage', 'payroll'],
    label: 'Orphanage interns',
    note: 'orphanage_intern.saved/deleted, _hours.uploaded/deleted, _rate.added, _pay.week_submitted/accepted/withdrawn, orphanage_interns.config_changed',
  },
  {
    match: 'orphanage_pay.',
    surfaces: ['orphanage', 'payroll'],
    label: 'Orphanage pay records',
    note: 'period_cleared, record_deleted',
  },

  // ── HR ─────────────────────────────────────────────────────────────────────
  {
    match: 'hr.',
    surfaces: ['hr'],
    label: 'HR pipeline',
    note: 'onboarding.* (link_created/submitted/set_work_email/verify_work_email/archived/deleted/bypass_promoted), pending.*, hire.*, orientation.marked/cleared, new_hire_checklist.*, pay_plan.*, employee.offboarded/reonboarded/scheduled_deletion, offboarded_sheet.backfilled',
  },
  {
    match: 'offboarding.',
    surfaces: ['hr'],
    label: 'Offboarding queue',
    note: 'requested, request_completed, request_cancelled, request_deleted',
  },
  {
    match: 'resignation.',
    surfaces: ['hr', 'manager'],
    label: 'Resignations',
    note: 'submitted, approved, rejected, cancelled',
  },
  {
    match: 'people.',
    surfaces: ['hr', 'accounting'],
    label: 'People tab edits',
    note: 'profile.updated (name / work + personal email / department / start date / phone / address — THIS is the family for "who changed X\'s name"), banking.updated, banking.revealed, bank_info.requested',
  },
  {
    match: 'gift.',
    surfaces: ['hr', 'orphanage'],
    label: 'Gift tracker',
    note: 'catalog_saved, tracker_note_saved, payment_edited',
  },
  {
    match: 'employee_gift_shipping.',
    surfaces: ['hr', 'orphanage', 'employee'],
    label: 'Gift shipping details',
    note: 'submitted/updated by the employee themself (channel employee_self) or edited/approved/deleted by staff (channel staff)',
  },
  {
    match: 'gift_address.',
    surfaces: ['hr', 'orphanage', 'employee'],
    label: 'Gift address (public link)',
    note: "otp_requested, otp_throttled, otp_verified, otp_verify_failed, saved — the PUBLIC /update-gift-address link (user_name 'external', channel external_link). The 6-digit CODE and the delivery ADDRESS are deliberately NOT in details: the trail is read by more people than the shipping list is, and auditing a live code hands a reader a credential. Never means a gift was GIVEN — that is gift_receipt.*",
  },
  {
    match: 'gift_receipt.',
    surfaces: ['hr', 'orphanage'],
    label: 'Gift fulfilment',
    note: "recorded (a staff member stating a tenure gift was or was not given), withdrawn (the assertion removed, returning that milestone to UNKNOWN — details carry the deleted row because nothing else records that it was ever made), imported (the sheet backfill). Separate from employee_gift_shipping.*, which is ADDRESS REVIEW and never means 'gifted'.",
  },
  {
    match: 'announcement.',
    surfaces: ['hr', 'employee'],
    label: 'Announcements',
    note: 'posted, pin_toggled, deleted',
  },
  {
    match: 'tenure.',
    surfaces: ['hr'],
    label: 'Tenure gifts',
    note: 'gift_decided',
  },
  {
    match: 'daily_report.',
    surfaces: ['hr', 'accounting'],
    label: 'Daily report import',
    note: 'imported — a CSV ingest; details carry the file name and row counts',
  },
  {
    match: 'fpu.',
    surfaces: ['hr', 'employee'],
    label: 'FPU enrolment',
  },

  // ── Roster, departments & transfers ────────────────────────────────────────
  {
    match: 'department_transfer.',
    surfaces: ['hr', 'accounting', 'manager'],
    label: 'Department transfers',
    note: 'requested, scheduled_apply, released, applied_manual, updated, declined, cancelled, deleted, sheet_retry, stale_release_cancelled',
  },
  {
    match: 'department_manager.',
    surfaces: ['admin', 'manager'],
    label: 'Department managers',
    note: 'assigned, revoked',
  },
  {
    match: 'department.',
    surfaces: ['accounting', 'admin'],
    label: 'Department registry',
    note: 'create, update, managers.update — the Payment Catalog department registry',
  },
  {
    match: 'manager.',
    surfaces: ['manager'],
    label: 'Manager suspend / reactivate',
    note: 'suspended / reactivated — the temp-pause Workspace envelope. Nothing is deleted and no offboard stamps are written',
  },

  // ── Employee & identity ────────────────────────────────────────────────────
  {
    match: 'employee.',
    surfaces: ['admin', 'hr', 'employee'],
    label: 'Employee records & sign-in',
    note: 'create/delete, profile.update, rates.update/revoke, suspend/unsuspend, login.success/failed, password_reset.*',
  },
  {
    match: 'bank_update.',
    surfaces: ['employee', 'accounting'],
    label: 'Self-service bank changes',
    note: 'otp_requested, otp_verified, otp_verify_failed, saved — the public /update-bank-info link (channel external_link = the employee themself)',
  },
  {
    match: 'bank_override.',
    surfaces: ['accounting', 'payroll'],
    label: 'Dispatch bank override',
    note: 'saved — the mark-paid pencil',
  },
  {
    match: 'bank_preferred.',
    surfaces: ['accounting'],
    label: 'Bank Preferred approvals',
    note: 'request.approved/denied/deleted — the send-from rail, held for Accounting approval',
  },

  // ── Tickets ────────────────────────────────────────────────────────────────
  {
    match: 'ticket.',
    surfaces: ['tickets'],
    label: 'Tickets board',
    note: 'created, updated, moved, commented, archived, restored, deleted',
  },

  // ── Assistants ─────────────────────────────────────────────────────────────
  {
    match: 'admin_assistant.',
    surfaces: ['admin'],
    label: 'Admin Penny',
    note: 'query — one event per tool-using turn, naming which tools ran, never the figures they returned',
  },
  {
    match: 'ceo_assistant.',
    surfaces: ['ceo'],
    label: 'CEO Penny',
    note: 'query, report_download, feedback',
  },
  {
    match: 'employee_assistant.',
    surfaces: ['employee'],
    label: 'Employee Penny',
    note: 'query',
  },

  // ── Admin & system ─────────────────────────────────────────────────────────
  {
    match: 'rbac.',
    surfaces: ['admin'],
    label: 'Role grants',
    note: 'role.granted / role.revoked',
  },
  {
    match: 'feature_permission.',
    surfaces: ['admin'],
    label: 'Feature permissions',
    note: 'grant / revoke — the per-tab hidden/view/edit overlay',
  },
  {
    match: 'auth.',
    surfaces: ['admin'],
    label: 'Auth & impersonation',
    note: 'impersonation.signin, force_logout',
  },
  {
    match: 'csv.',
    surfaces: ['admin', 'accounting'],
    label: 'CSV uploads & sheet syncs',
    note: 'master/rates/hsl .sync (+ .sync.error), upload, delete, set_current, rename',
  },
  {
    match: 'hubstaff.',
    surfaces: ['admin', 'payroll'],
    label: 'Hubstaff ingest',
    note: 'api_sync',
  },
  {
    match: 'offboarded.sheet.',
    surfaces: ['admin', 'hr'],
    label: 'Offboarded sheet sync',
  },
  {
    match: 'screening.sheet.',
    surfaces: ['admin', 'hr'],
    label: 'Screening sheet sync',
  },
  {
    match: 'settings.',
    surfaces: ['admin'],
    label: 'System settings',
    note: 'rule.toggle, ot.global, ot.department, holidays.toggle, collab.toggle',
  },
  {
    match: 'app_settings.',
    surfaces: ['admin'],
    label: 'Sensitive settings writes',
    note: 'sensitive_write — a write to a policed app_settings key',
  },
  {
    match: 'webhook.',
    surfaces: ['admin'],
    label: 'Webhook automations',
    note: 'automation_updated, test_run',
  },
  {
    match: 'notification.',
    surfaces: ['admin'],
    label: 'Notification failures',
    note: 'insert_failed — a notification that FAILED to insert. Delivery is best-effort so the underlying save still succeeded',
  },
  {
    match: 'audit.',
    surfaces: ['admin'],
    label: 'Audit-log retention',
    note: 'purged — an admin pruned events older than a cutoff. Written BEFORE the delete and the purge aborts if this write fails, so the trail can never be emptied silently',
  },
  {
    match: 'monday.',
    surfaces: ['admin'],
    label: 'Monday board sync',
  },
] as const;

// ─── Lookup ───────────────────────────────────────────────────────────────────

/**
 * The family owning `action`, or null when nothing claims it.
 *
 * Longest match wins, so `orphanage_registry.deleted` lands in the registry
 * family rather than the broader `orphanage.` one, whatever the array order.
 * Returning null (rather than an "Other" bucket) is what lets
 * `registry.test.ts` fail on an unregistered action instead of hiding it.
 */
export function familyForAction(action: string): AuditFamily | null {
  const a = action.trim().toLowerCase();
  if (!a) return null;
  let best: AuditFamily | null = null;
  for (const fam of AUDIT_FAMILIES) {
    const hit = fam.exact ? a === fam.match : a.startsWith(fam.match);
    if (!hit) continue;
    if (!best || fam.match.length > best.match.length) best = fam;
  }
  return best;
}

/** Dashboards an action belongs to; empty when the action is unregistered. */
export function surfacesForAction(action: string): readonly AuditSurface[] {
  return familyForAction(action)?.surfaces ?? [];
}

export function isOnSurface(action: string, surface: AuditSurface): boolean {
  return surfacesForAction(action).includes(surface);
}

/** Families raised on one dashboard, in registry order. */
export function familiesForSurface(surface: AuditSurface): readonly AuditFamily[] {
  return AUDIT_FAMILIES.filter((f) => f.surfaces.includes(surface));
}

// ─── Penny ────────────────────────────────────────────────────────────────────

/**
 * The ACTION FAMILIES block of `search_audit_log`'s description, generated from
 * the registry so it cannot drift from the log the way the hand-written list
 * did. Grouped by dashboard because that is how an admin asks the question
 * ("what happened on Orphanage yesterday").
 */
export function describeAuditFamilies(): string {
  const lines: string[] = [];
  for (const surface of AUDIT_SURFACES) {
    // Each family is listed ONCE, under its first surface, with the other
    // dashboards named inline — a family repeated under every surface it
    // touches would double the size of a description that ships on every turn.
    const fams = AUDIT_FAMILIES.filter((f) => f.surfaces[0] === surface.id);
    if (fams.length === 0) continue;
    lines.push(surface.label.toUpperCase());
    for (const fam of fams) {
      const prefix = fam.exact ? fam.match : `${fam.match}*`;
      const also = fam.surfaces.slice(1);
      const alsoText =
        also.length > 0
          ? ` [also on ${also.map((s) => auditSurfaceDef(s).label).join(', ')}]`
          : '';
      lines.push(`• ${prefix} — ${fam.label}${fam.note ? `: ${fam.note}` : ''}${alsoText}`);
    }
  }
  return lines.join('\n');
}
