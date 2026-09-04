/**
 * What the Admin Penny console prints while a tool runs.
 *
 * One line per tool the model can actually call, phrased as the work that tool
 * really does — `search_audit_log` says it is searching the audit log, and
 * nothing here claims a step that isn't happening. The route names the tool
 * (see `console-stream.ts`); this file only translates that name into the
 * operator's language, so the console stays a readout of state rather than a
 * loading animation with vocabulary.
 *
 * Phrases carry NO trailing punctuation — the console appends the ellipsis and
 * the caret, so a running step and a finished step can be typeset differently
 * from the same string. `console-phases.test.ts` pins that, and pins that every
 * tool in CEO_TOOLS ∪ ADMIN_TOOLS has an entry: an unmapped tool would print a
 * raw snake_case identifier to an admin mid-answer.
 */

export const TOOL_PHASES: Record<string, string> = {
  // ── Identity & roster ────────────────────────────────────────────────────
  find_employee: 'Matching the name against the active roster',
  get_employee_profile: 'Opening the employee record',
  get_employee_access: 'Checking dashboard access and roles',

  // ── Pay & payroll figures ────────────────────────────────────────────────
  get_employee_pay: 'Reading their pay weeks',
  get_payroll_report: 'Pulling the payroll report for the cycle',
  get_financial_summary: 'Totalling the cycle financials',
  get_overtime_leaders: 'Ranking overtime hours',
  get_department_bonuses: 'Adding up department bonuses',
  get_hours_uploads: 'Listing the Hubstaff hour uploads',
  get_uploaded_hours: 'Reading the uploaded hours',
  get_payroll_wizard_notes: 'Opening the payroll notes checklist',

  // ── Admin operations ─────────────────────────────────────────────────────
  search_audit_log: 'Searching the audit log',
  list_audit_actions: 'Listing the audited action names',
  run_diagnostics: 'Running the diagnostic probes',
  get_payroll_wizard_status: 'Checking the payroll wizard lock',
  get_rate_history: 'Reading the rate history',
  get_transfer_history: 'Reading the transfer history',
  get_onboarding_info: 'Reading the onboarding record',
  get_bank_change_history: 'Reading the bank-change history',
  get_change_timeline: 'Merging every change source into one timeline',
  get_payroll_notes_history: 'Reading the payroll-note edits',
};

/** Prefix used when a tool has no mapped phrase — honest, if unlovely. */
export const TOOL_PHASE_FALLBACK = 'Running ';

export function phaseForTool(name: string): string {
  return TOOL_PHASES[name] ?? `${TOOL_PHASE_FALLBACK}${name}`;
}

/**
 * The console's resting line. Names what this Penny is armed for, because the
 * admin tool set is the reason this surface exists.
 */
export const CONSOLE_IDLE_LINE =
  'Standing by — ask about an audit trail, the probes, payroll state, or one person';

/**
 * The boot banner, printed once when the console mounts. Every line is a fact
 * the surface can stand behind: the two static ones here, plus the session
 * identity and tool count the component supplies from real values.
 */
export const CONSOLE_BOOT_LINES = [
  'Read-only session. Penny can query, never write',
  'Every tool-using question is written to the audit log',
] as const;
