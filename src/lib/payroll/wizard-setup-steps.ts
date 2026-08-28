/**
 * The Payroll Wizard's per-week setup checklist — the pure decision layer.
 *
 * Seven prerequisites must be true before a cycle can go to Payment Dispatch:
 * this week's Hubstaff CSV (step 1), the USD→PHP rate confirmed for the week
 * (step 2), orphanage hours entered or confirmed-none (step 3), KPI bonuses
 * ready (step 4, including its HSL tab), notes adjustments pulled (step 4),
 * contractor invoices reviewed (step 5), and finally the dispatch lock itself
 * (step 8). These strings are the operator's map to the rail, so they move with
 * it — twice on 2026-08-28 alone: down one when HSL and Additions merged into a
 * single step 4, then back up one for Dispatch when the PAB review landed at 6.
 *
 * This module is PURE (no I/O, no server-only) so node:test can exercise every
 * status branch; the reads live in payroll-readiness.ts `buildWizardSetup`.
 * It is also imported by the wizard client for the app_settings marker keys.
 *
 * Deliberately NOT part of the readiness score — the checklist sits beside the
 * people-coverage score, never inside it (Kane, 2026-08-03).
 */

export type WizardSetupStepKey =
  | 'csv'
  | 'fx'
  | 'orphanage'
  | 'kpi'
  | 'notes'
  | 'contractors'
  | 'dispatch';

export interface WizardSetupStep {
  key: WizardSetupStepKey;
  /** Wizard step number(s) the fix lives on — "1", "2", "3", "4", "5", "8". */
  stepNo: string;
  label: string;
  /** done = green · attention = amber (actionable) · blocked = rose (CSV missing
   *  — the only red) · pending = sky (neutral: not-yet end-state or failed read). */
  status: 'done' | 'attention' | 'blocked' | 'pending';
  detail: string;
}

export interface WizardSetup {
  /** Sunday ISO of the pay week the checklist evaluates — ALWAYS the week the
   *  readiness pane (and its week selector) is on. */
  expectedWeekStart: string;
  weekLabel: string;
  /** The upload whose filename week matches `expectedWeekStart`, if any. */
  matchedSourceFile: string | null;
  /** A LATER pay week that has already closed with no Hubstaff CSV uploaded —
   *  set only while the pane sits on the newest upload. The checklist itself
   *  stays on the week in view; this is just the nudge that a newer cycle is
   *  waiting to be started. Null when there's nothing newer to upload. */
  awaitingWeekStart: string | null;
  awaitingWeekLabel: string | null;
  steps: WizardSetupStep[];
  doneCount: number;
  totalCount: number;
}

export interface WizardSetupInput {
  expectedWeekStart: string;
  weekLabel: string;
  /** See WizardSetup.awaitingWeekStart — null when nothing newer is pending. */
  awaitingWeekStart: string | null;
  awaitingWeekLabel: string | null;
  csvUpload: { sourceFile: string; uploadedAt: string; rowCount: number | null } | null;
  /** The live current upload's filename carries no parseable week range. */
  newestUploadUnparseable: boolean;
  /** The cycle's per-upload FX record (see CYCLE_FX_SETTING_PREFIX). Null when
   *  no record exists for the matched upload — which reads as rates-at-zero. */
  fx: CycleFxRecord | null;
  orphanageRowCount: number;
  orphanageNoneMarker: boolean;
  kpi: { due: number; submitted: number; pendingDepts: string[] };
  /** Adjustment notes for the week: total strict-parseable rows / rows whose
   *  worker already has an Adj. override in the cycle's additions blob. */
  notes: { total: number; applied: number };
  contractorsPending: number;
  dispatchLock: { locked: boolean; lockedBy: string | null; lockedAt: string | null };
  /** Step keys whose backing read failed — those rows read `pending`,
   *  never a false done/blocked. */
  degradedKeys: Set<WizardSetupStepKey>;
}

// ── app_settings keys (written by the wizard, read by buildWizardSetup) ──────

export const ORPHANAGE_CONFIRMED_SETTING_PREFIX = 'payroll.wizard.orphanage_confirmed.';

export function orphanageConfirmedSettingKey(weekStart: string): string {
  return `${ORPHANAGE_CONFIRMED_SETTING_PREFIX}${weekStart}`;
}

export function parseOrphanageNoneMarker(
  value: string | null,
): { by: string | null; at: string | null } | null {
  if (!value) return null;
  try {
    const o = JSON.parse(value) as { none?: unknown; by?: unknown; at?: unknown };
    if (o.none !== true) return null;
    return {
      by: typeof o.by === 'string' ? o.by : null,
      at: typeof o.at === 'string' ? o.at : null,
    };
  } catch {
    return null;
  }
}

// ── Per-cycle FX record (Step 2 zero placeholders) ───────────────────────────

/** The cycle's USD-anchored rates. Kept per Hubstaff upload so every NEW cycle
 *  starts at 0 — typing the real rates IS the weekly confirmation (Kane,
 *  2026-08-03; supersedes the fx_confirmed week marker). Absent key ⇒ both 0.
 *  The wizard writes this AND the global usd_to_*_rate keys (write-through);
 *  the globals never hold 0 — their effective* readers erase zeros. */
export const CYCLE_FX_SETTING_PREFIX = 'payroll.wizard.fx.';

export function cycleFxSettingKey(sourceFile: string): string {
  return `${CYCLE_FX_SETTING_PREFIX}${sourceFile}`;
}

export interface CycleFxRecord {
  php: number;
  cop: number;
  by: string | null;
  at: string | null;
}

/** Malformed/null ⇒ null (treated as absent). Invalid/negative legs read 0 —
 *  a broken leg must look UNSET, never set. */
export function parseCycleFxRecord(value: string | null): CycleFxRecord | null {
  if (!value) return null;
  try {
    const o = JSON.parse(value) as { php?: unknown; cop?: unknown; by?: unknown; at?: unknown };
    const leg = (v: unknown): number => (typeof v === 'number' && Number.isFinite(v) && v > 0 ? v : 0);
    return {
      php: leg(o.php),
      cop: leg(o.cop),
      by: typeof o.by === 'string' ? o.by : null,
      at: typeof o.at === 'string' ? o.at : null,
    };
  } catch {
    return null;
  }
}

/** Mirror of useWizardDispatchLock's parseLock (the hook is client-only): JSON
 *  object, legacy 'true'/'false', or null. */
export function parseDispatchLockValue(
  value: string | null,
): { locked: boolean; lockedBy: string | null; lockedAt: string | null } {
  const EMPTY = { locked: false, lockedAt: null, lockedBy: null };
  if (!value) return EMPTY;
  const trimmed = value.trim();
  if (trimmed === 'true') return { locked: true, lockedAt: null, lockedBy: null };
  if (trimmed === 'false' || trimmed === '') return EMPTY;
  try {
    const o = JSON.parse(trimmed) as { locked?: unknown; lockedAt?: unknown; lockedBy?: unknown };
    return {
      locked: o.locked === true,
      lockedAt: typeof o.lockedAt === 'string' ? o.lockedAt : null,
      lockedBy: typeof o.lockedBy === 'string' ? o.lockedBy : null,
    };
  } catch {
    return EMPTY;
  }
}

// ── derive ───────────────────────────────────────────────────────────────────

/** "Aug 2" in Manila time, for detail strings. Null in → null out. */
function manilaStampLabel(iso: string | null): string | null {
  if (!iso) return null;
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return null;
  return new Intl.DateTimeFormat('en-PH', {
    timeZone: 'Asia/Manila',
    month: 'short',
    day: 'numeric',
  }).format(d);
}

export function deriveWizardSetupSteps(input: WizardSetupInput): WizardSetup {
  const steps: WizardSetupStep[] = [];
  const degraded = (key: WizardSetupStepKey) => input.degradedKeys.has(key);

  // 1 · Hubstaff CSV — the only row that can read `blocked`.
  if (degraded('csv')) {
    steps.push({ key: 'csv', stepNo: '1', label: 'Hubstaff CSV', status: 'pending', detail: "Couldn't read the upload list" });
  } else if (input.csvUpload) {
    const stamp = manilaStampLabel(input.csvUpload.uploadedAt);
    steps.push({
      key: 'csv',
      stepNo: '1',
      label: 'Hubstaff CSV',
      status: 'done',
      detail: `Uploaded${stamp ? ` ${stamp}` : ''}${input.csvUpload.rowCount != null ? ` · ${input.csvUpload.rowCount} rows` : ''}`,
    });
  } else if (input.newestUploadUnparseable) {
    steps.push({
      key: 'csv',
      stepNo: '1',
      label: 'Hubstaff CSV',
      status: 'attention',
      detail: "Can't tell — the newest upload's name has no week range",
    });
  } else {
    steps.push({
      key: 'csv',
      stepNo: '1',
      label: 'Hubstaff CSV',
      status: 'blocked',
      detail: 'Not uploaded yet',
    });
  }

  // 2 · USD rates set for the cycle — zero is the placeholder; both legs must
  // be non-zero. No matched CSV means there is no cycle to set rates on yet.
  if (degraded('fx')) {
    steps.push({ key: 'fx', stepNo: '2', label: 'USD rate confirmed', status: 'pending', detail: "Couldn't read the cycle rates" });
  } else if (!input.csvUpload) {
    steps.push({ key: 'fx', stepNo: '2', label: 'USD rate confirmed', status: 'attention', detail: "Waiting for this week's CSV" });
  } else {
    const php = input.fx?.php ?? 0;
    const cop = input.fx?.cop ?? 0;
    if (php > 0 && cop > 0) {
      const stamp = manilaStampLabel(input.fx?.at ?? null);
      steps.push({
        key: 'fx',
        stepNo: '2',
        label: 'USD rate confirmed',
        status: 'done',
        detail: `₱${php} · COP ${new Intl.NumberFormat('en-US').format(cop)} / $1${input.fx?.by ? ` · ${input.fx.by}` : ''}${stamp ? ` · ${stamp}` : ''}`,
      });
    } else if (php <= 0 && cop <= 0) {
      steps.push({ key: 'fx', stepNo: '2', label: 'USD rate confirmed', status: 'attention', detail: 'Rates at 0 — set on Step 2' });
    } else if (php <= 0) {
      steps.push({ key: 'fx', stepNo: '2', label: 'USD rate confirmed', status: 'attention', detail: 'PHP still 0 — Step 2' });
    } else {
      steps.push({ key: 'fx', stepNo: '2', label: 'USD rate confirmed', status: 'attention', detail: 'COP still 0 — Step 2' });
    }
  }

  // 3 · Orphanage hours — real rows always outrank the confirm-none marker.
  if (degraded('orphanage')) {
    steps.push({ key: 'orphanage', stepNo: '3', label: 'Orphanage hours', status: 'pending', detail: "Couldn't read orphanage records" });
  } else if (input.orphanageRowCount > 0) {
    steps.push({
      key: 'orphanage',
      stepNo: '3',
      label: 'Orphanage hours',
      status: 'done',
      detail: `${input.orphanageRowCount} ${input.orphanageRowCount === 1 ? 'person' : 'people'} locked in`,
    });
  } else if (input.orphanageNoneMarker) {
    steps.push({ key: 'orphanage', stepNo: '3', label: 'Orphanage hours', status: 'done', detail: 'Confirmed none this week' });
  } else {
    steps.push({
      key: 'orphanage',
      stepNo: '3',
      label: 'Orphanage hours',
      status: 'attention',
      detail: 'Paste hours or confirm none on Step 3',
    });
  }

  // 4–5 · KPI bonuses.
  if (degraded('kpi')) {
    steps.push({ key: 'kpi', stepNo: '4', label: 'KPI bonuses', status: 'pending', detail: "Couldn't read KPI statuses" });
  } else if (input.kpi.due === 0) {
    steps.push({ key: 'kpi', stepNo: '4', label: 'KPI bonuses', status: 'pending', detail: 'No departments due this week' });
  } else if (input.kpi.submitted >= input.kpi.due) {
    steps.push({
      key: 'kpi',
      stepNo: '4',
      label: 'KPI bonuses',
      status: 'done',
      detail: `${input.kpi.due}/${input.kpi.due} departments ready`,
    });
  } else {
    const listed = input.kpi.pendingDepts.slice(0, 3).join(', ');
    const extra = input.kpi.pendingDepts.length > 3 ? ` +${input.kpi.pendingDepts.length - 3} more` : '';
    steps.push({
      key: 'kpi',
      stepNo: '4',
      label: 'KPI bonuses',
      status: 'attention',
      detail: `${input.kpi.submitted}/${input.kpi.due} ready${listed ? ` · ${listed}${extra}` : ''}`,
    });
  }

  // 5 · Notes adjustments.
  if (degraded('notes')) {
    steps.push({ key: 'notes', stepNo: '4', label: 'Notes adjustments', status: 'pending', detail: "Couldn't read the notes board" });
  } else if (input.notes.total === 0) {
    steps.push({ key: 'notes', stepNo: '4', label: 'Notes adjustments', status: 'done', detail: 'None this week' });
  } else if (input.notes.applied >= input.notes.total) {
    steps.push({
      key: 'notes',
      stepNo: '4',
      label: 'Notes adjustments',
      status: 'done',
      detail: `${input.notes.total} applied in the wizard`,
    });
  } else {
    steps.push({
      key: 'notes',
      stepNo: '4',
      label: 'Notes adjustments',
      status: 'attention',
      detail: `${input.notes.total - input.notes.applied} of ${input.notes.total} not yet in wizard`,
    });
  }

  // 6 · Contractor invoices.
  if (degraded('contractors')) {
    steps.push({ key: 'contractors', stepNo: '5', label: 'Contractor invoices', status: 'pending', detail: "Couldn't read invoices" });
  } else if (input.contractorsPending === 0) {
    steps.push({ key: 'contractors', stepNo: '5', label: 'Contractor invoices', status: 'done', detail: 'None pending' });
  } else {
    steps.push({
      key: 'contractors',
      stepNo: '5',
      label: 'Contractor invoices',
      status: 'attention',
      detail: `${input.contractorsPending} awaiting approval`,
    });
  }

  // 8 · Sent to dispatch — the end-state; never a warning while unfinished.
  if (degraded('dispatch')) {
    steps.push({ key: 'dispatch', stepNo: '8', label: 'Sent to dispatch', status: 'pending', detail: "Couldn't read the cycle lock" });
  } else if (input.dispatchLock.locked) {
    const stamp = manilaStampLabel(input.dispatchLock.lockedAt);
    steps.push({
      key: 'dispatch',
      stepNo: '8',
      label: 'Sent to dispatch',
      status: 'done',
      detail: `Locked${input.dispatchLock.lockedBy ? ` by ${input.dispatchLock.lockedBy}` : ''}${stamp ? ` · ${stamp}` : ''}`,
    });
  } else {
    steps.push({ key: 'dispatch', stepNo: '8', label: 'Sent to dispatch', status: 'pending', detail: 'Not sent yet' });
  }

  return {
    expectedWeekStart: input.expectedWeekStart,
    weekLabel: input.weekLabel,
    matchedSourceFile: input.csvUpload?.sourceFile ?? null,
    awaitingWeekStart: input.awaitingWeekStart,
    awaitingWeekLabel: input.awaitingWeekLabel,
    steps,
    doneCount: steps.filter((s) => s.status === 'done').length,
    totalCount: steps.length,
  };
}
