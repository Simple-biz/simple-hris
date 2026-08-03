/**
 * The Payroll Wizard's per-week setup checklist — the pure decision layer.
 *
 * Seven prerequisites must be true before a cycle can go to Payment Dispatch:
 * this week's Hubstaff CSV (step 1), the USD→PHP rate confirmed for the week
 * (step 2), orphanage hours entered or confirmed-none (step 3), KPI bonuses
 * ready (steps 4–5), notes adjustments pulled (step 5), contractor invoices
 * reviewed (step 6), and finally the dispatch lock itself (step 8).
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
  /** Wizard step number(s) the fix lives on — "1", "2", "3", "4–5", "5", "6", "8". */
  stepNo: string;
  label: string;
  /** done = green · attention = amber (actionable) · blocked = rose (CSV missing
   *  — the only red) · pending = sky (neutral: not-yet end-state or failed read). */
  status: 'done' | 'attention' | 'blocked' | 'pending';
  detail: string;
}

export interface WizardSetup {
  /** Sunday ISO of the pay week the checklist evaluates. */
  expectedWeekStart: string;
  weekLabel: string;
  /** The upload whose filename week matches `expectedWeekStart`, if any. */
  matchedSourceFile: string | null;
  /** True when the rest of the readiness pane resolved a DIFFERENT week (its
   *  data is a stale file) — the CSV row's detail calls it out. */
  mismatch: boolean;
  steps: WizardSetupStep[];
  doneCount: number;
  totalCount: number;
}

export interface WizardSetupInput {
  expectedWeekStart: string;
  weekLabel: string;
  paneWeekStart: string;
  paneWeekLabel: string;
  csvUpload: { sourceFile: string; uploadedAt: string; rowCount: number | null } | null;
  /** The live current upload's filename carries no parseable week range. */
  newestUploadUnparseable: boolean;
  fxMarker: { rate: number; by: string | null; at: string | null } | null;
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

export const FX_CONFIRMED_SETTING_PREFIX = 'payroll.wizard.fx_confirmed.';
export const ORPHANAGE_CONFIRMED_SETTING_PREFIX = 'payroll.wizard.orphanage_confirmed.';

export function fxConfirmedSettingKey(weekStart: string): string {
  return `${FX_CONFIRMED_SETTING_PREFIX}${weekStart}`;
}

export function orphanageConfirmedSettingKey(weekStart: string): string {
  return `${ORPHANAGE_CONFIRMED_SETTING_PREFIX}${weekStart}`;
}

export function parseFxConfirmedMarker(
  value: string | null,
): { rate: number; by: string | null; at: string | null } | null {
  if (!value) return null;
  try {
    const o = JSON.parse(value) as { rate?: unknown; by?: unknown; at?: unknown };
    if (typeof o.rate !== 'number' || !Number.isFinite(o.rate)) return null;
    return {
      rate: o.rate,
      by: typeof o.by === 'string' ? o.by : null,
      at: typeof o.at === 'string' ? o.at : null,
    };
  } catch {
    return null;
  }
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
  const mismatch = input.paneWeekStart !== input.expectedWeekStart;
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
      detail: mismatch ? `Not uploaded — sections below show ${input.paneWeekLabel}` : 'Not uploaded yet',
    });
  }

  // 2 · USD → PHP rate confirmed for the week.
  if (degraded('fx')) {
    steps.push({ key: 'fx', stepNo: '2', label: 'USD rate confirmed', status: 'pending', detail: "Couldn't read the weekly confirmation" });
  } else if (input.fxMarker) {
    const stamp = manilaStampLabel(input.fxMarker.at);
    steps.push({
      key: 'fx',
      stepNo: '2',
      label: 'USD rate confirmed',
      status: 'done',
      detail: `₱${input.fxMarker.rate} / $1${input.fxMarker.by ? ` · ${input.fxMarker.by}` : ''}${stamp ? ` · ${stamp}` : ''}`,
    });
  } else {
    steps.push({ key: 'fx', stepNo: '2', label: 'USD rate confirmed', status: 'attention', detail: 'Not confirmed — Confirm on Step 2' });
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
    steps.push({ key: 'kpi', stepNo: '4–5', label: 'KPI bonuses', status: 'pending', detail: "Couldn't read KPI statuses" });
  } else if (input.kpi.due === 0) {
    steps.push({ key: 'kpi', stepNo: '4–5', label: 'KPI bonuses', status: 'pending', detail: 'No departments due this week' });
  } else if (input.kpi.submitted >= input.kpi.due) {
    steps.push({
      key: 'kpi',
      stepNo: '4–5',
      label: 'KPI bonuses',
      status: 'done',
      detail: `${input.kpi.due}/${input.kpi.due} departments ready`,
    });
  } else {
    const listed = input.kpi.pendingDepts.slice(0, 3).join(', ');
    const extra = input.kpi.pendingDepts.length > 3 ? ` +${input.kpi.pendingDepts.length - 3} more` : '';
    steps.push({
      key: 'kpi',
      stepNo: '4–5',
      label: 'KPI bonuses',
      status: 'attention',
      detail: `${input.kpi.submitted}/${input.kpi.due} ready${listed ? ` · ${listed}${extra}` : ''}`,
    });
  }

  // 5 · Notes adjustments.
  if (degraded('notes')) {
    steps.push({ key: 'notes', stepNo: '5', label: 'Notes adjustments', status: 'pending', detail: "Couldn't read the notes board" });
  } else if (input.notes.total === 0) {
    steps.push({ key: 'notes', stepNo: '5', label: 'Notes adjustments', status: 'done', detail: 'None this week' });
  } else if (input.notes.applied >= input.notes.total) {
    steps.push({
      key: 'notes',
      stepNo: '5',
      label: 'Notes adjustments',
      status: 'done',
      detail: `${input.notes.total} applied in the wizard`,
    });
  } else {
    steps.push({
      key: 'notes',
      stepNo: '5',
      label: 'Notes adjustments',
      status: 'attention',
      detail: `${input.notes.total - input.notes.applied} of ${input.notes.total} not yet in wizard`,
    });
  }

  // 6 · Contractor invoices.
  if (degraded('contractors')) {
    steps.push({ key: 'contractors', stepNo: '6', label: 'Contractor invoices', status: 'pending', detail: "Couldn't read invoices" });
  } else if (input.contractorsPending === 0) {
    steps.push({ key: 'contractors', stepNo: '6', label: 'Contractor invoices', status: 'done', detail: 'None pending' });
  } else {
    steps.push({
      key: 'contractors',
      stepNo: '6',
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
    mismatch,
    steps,
    doneCount: steps.filter((s) => s.status === 'done').length,
    totalCount: steps.length,
  };
}
