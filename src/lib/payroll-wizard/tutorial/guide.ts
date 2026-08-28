/**
 * [WIZARD-TUTORIAL] Processing Tutorial Mode — pure step-guide model.
 *
 * The guide activates while Payroll Processing is locked ON and the viewer is
 * the lock driver. It is ADVISORY ONLY by contract (Kane, 2026-08-17): a step
 * status never gates navigation, no click is ever required, and every hint is
 * skippable. Statuses derive from serializable signals the wizard already
 * computes — this module performs no fetches and reads no DOM.
 *
 * One-shot removal: this folder, `src/components/payroll-wizard/tutorial/`,
 * `app/api/payroll-wizard/audit-week/`, and the `[WIZARD-TUTORIAL]` blocks in
 * `PayrollWizard.tsx`. See docs/features/payroll-wizard-tutorial-mode.md.
 */

export type TutorialStatus = 'pending' | 'attention' | 'done';
export type TutorialStepKind = 'action' | 'review';

/** `data-tutorial-target` values the wizard stamps on its DOM anchors. */
export type TutorialTargetKey =
  | 'step1-upload-weekly'
  | 'step1-config-tab'
  | 'step2-review'
  | 'step2-fx-php'
  | 'step2-fx-php-cta'
  | 'step2-fx-cop'
  | 'step2-fx-cop-cta'
  | 'step3-paste-data'
  | 'step4-hsl-table'
  | 'step4-col-pab'
  | 'step4-col-tech'
  | 'step4-col-mesa'
  | 'step4-col-adjustment'
  | 'step4-col-orphanage'
  // Step 4 carries two surfaces since HSL and Additions merged (2026-08-28): the
  // `hsl-*`/`col-*` anchors live on the HSL tab, these three on the shared
  // department side. Only one set is ever mounted, and a missing anchor is
  // skipped — the guide runs head-only rather than crashing.
  | 'step4-system-bonus'
  | 'step4-pab-month'
  | 'step4-tech-week'
  | 'step5-pending-invoices'
  | 'step6-pab-review'
  | 'step7-validation-table'
  | 'step8-lock-in'
  | 'step9-audit-trail';

/**
 * Step 4's spotlight takes turns across the HSL table's money columns rather
 * than ringing the whole table forever (Kane, 2026-08-17). Order is the table's
 * own left-to-right order; PAB and Tech are conditional columns, so the visible
 * set is filtered from signals before rotating.
 */
export const HSL_COLUMN_ROTATION: { target: TutorialTargetKey; label: string }[] = [
  { target: 'step4-col-pab', label: 'PAB' },
  { target: 'step4-col-tech', label: 'Tech Bonus' },
  { target: 'step4-col-mesa', label: 'MESA' },
  { target: 'step4-col-adjustment', label: 'Adjustment' },
  { target: 'step4-col-orphanage', label: 'Orphanage' },
];

export type TutorialStepDef = {
  /** Wizard step id (1–9), matching the `steps` array in PayrollWizard.tsx. */
  stepId: number;
  title: string;
  /** What the operator should do (or look at) on this step. */
  hint: string;
  kind: TutorialStepKind;
  targets: TutorialTargetKey[];
};

export const TUTORIAL_STEPS: TutorialStepDef[] = [
  {
    stepId: 1,
    title: 'Initialize payroll data',
    hint:
      'Upload the Hubstaff weekly report and wait for it to land — the guide marks this done once the active batch covers the week being paid. Then open the Configuration tab and check the per-department “Pay this week” and Overtime switches.',
    kind: 'action',
    targets: ['step1-upload-weekly', 'step1-config-tab'],
  },
  {
    stepId: 2,
    title: 'Conversion rates & initial calculation',
    hint:
      'Set this cycle’s conversion rates — the ringed box is the one still waiting. Each box holds its own rate and its own Edit/Apply control. Then review the calculated hours × rates below.',
    kind: 'action',
    targets: ['step2-review'],
  },
  {
    stepId: 3,
    title: 'Orphanage',
    hint:
      'Paste the approved orphanage visits into the Paste Data field — one row per person: pay week, work email, hours.',
    kind: 'action',
    targets: ['step3-paste-data'],
  },
  {
    // HSL and Additions merged into this one step 2026-08-28. The hint covers both
    // halves because the rail's HSL tab is where HSL review now happens.
    stepId: 4,
    title: 'Additions, HSL & System Bonus',
    hint:
      'Review bonuses and adjustments department by department, then open System Bonus settings — the guide follows you inside and rings the month that still needs a PAB period. Hogan Smith Law has its own tab on the rail: open it and the ring walks the HSL table’s money columns (PAB, Tech Bonus, MESA, Adjustment, Orphanage) in turn.',
    kind: 'review',
    targets: ['step4-system-bonus'],
  },
  {
    stepId: 5,
    title: 'Contractors',
    hint:
      'Review each pending contractor invoice for this period and approve or reject it before dispatch.',
    kind: 'action',
    targets: ['step5-pending-invoices'],
  },
  {
    stepId: 6,
    title: 'PAB',
    hint:
      'Check who lost Perfect Attendance this period. One or two missed days is usually a shifting schedule — open the calendar before the month’s bonus is written off.',
    kind: 'review',
    targets: ['step6-pab-review'],
  },
  {
    stepId: 7,
    title: 'Validation',
    hint:
      'Go through the validation columns one by one and decide whether anyone needs to be excluded from this pay run.',
    kind: 'review',
    targets: ['step7-validation-table'],
  },
  {
    stepId: 8,
    title: 'Dispatch',
    hint:
      'Once every rate is right, lock in the values and send the cycle to Payment Dispatch.',
    kind: 'action',
    targets: ['step8-lock-in'],
  },
  {
    stepId: 9,
    title: 'Reports & audit trail',
    hint:
      'Read the Processing Narrative for this week — every start/stop and every change since processing began — and the full per-cycle audit trail below it.',
    kind: 'review',
    targets: ['step9-audit-trail'],
  },
];

/**
 * Everything the guide needs to know, as plain serializable values the wizard
 * already holds. `todayIso` is injected (YYYY-MM-DD) so derivation stays pure.
 */
/**
 * The previous cycle's saved FX record, read for ADVISORY COPY ONLY.
 *
 * This exists so the guide can say "last set two weeks ago" instead of the
 * bare "not set". It must NEVER prefill, seed, or default this cycle's rate:
 * `per-cycle-fx-zero-placeholder` makes typing the rate the weekly
 * confirmation, and carrying a stale number into the input would silently
 * un-confirm the week. Display it; never adopt it.
 */
export type PreviousCycleFx = {
  sourceFile: string;
  php: number | null;
  cop: number | null;
  /** ISO instant the previous cycle's rates were saved. */
  at: string | null;
  /** Operator who saved them. */
  by: string | null;
};

export type TutorialSignals = {
  todayIso: string;
  sourceFile: string | null;
  /** Cycle period parsed from the active Hubstaff filename (may be null). */
  periodStart: string | null;
  periodEnd: string | null;
  /**
   * Per-cycle FX legs, RAW: 0/null = not set for THIS cycle. Read straight off
   * the wizard's hydrated state — never through `effectiveUsdTo*RateFromStored`,
   * which would replace the meaningful zero with an official placeholder.
   */
  fxPhp: number | null;
  fxCop: number | null;
  /** Last cycle that had rates saved — advisory only, never a prefill source. */
  previousCycleFx: PreviousCycleFx | null;
  orphanageReadyCount: number;
  pabRangeLabel: string | null;
  isTechBonusWeek: boolean;
  /** Which conditional HSL columns are actually rendered this cycle. */
  hslPabColumnShown: boolean;
  hslTechColumnShown: boolean;
  /**
   * True while step 4's department rail is on its HSL tab. Step 4 owns two
   * surfaces since the merge, and only the mounted one may be ringed: rotating
   * onto an HSL column while the shared department table is showing would ask
   * for an anchor that is not in the DOM, and the ring would silently vanish.
   */
  additionsHslTabActive: boolean;
  /** System Bonus modal state — step 4 teaches inside it once it's open. */
  systemBonusModalOpen: boolean;
  /** True when the PAB period for the month being edited is already set. */
  pabSetForActiveMonth: boolean;
  /** The month the System Bonus modal is editing, e.g. "August 2026". */
  pabActiveMonthLabel: string | null;
  pendingContractorCount: number;
  /** Step 6: how many people are ineligible for the active PAB period. */
  pabIneligibleCount: number;
  /** Of those, how many missed only 1–2 days — the cohort worth a look. */
  pabReviewCount: number;
  validationRedFlagCount: number;
  excludedCount: number;
  payableCount: number;
  /** True once this cycle has been dispatched in this wizard session. */
  dispatched: boolean;
  /** Wizard steps the driver has landed on since the guide activated. */
  visitedSteps: number[];
};

export type TutorialStepStatus = {
  status: TutorialStatus;
  /** Short advisory note rendered under the step title. Never a blocker. */
  note: string | null;
};

/** How old (in days) the active batch's week-end may be before we call it stale. */
const REPORT_STALE_AFTER_DAYS = 8;

const isSet = (v: number | null | undefined): boolean => v != null && v > 0;

/** "Aug 10" / "Aug 10, 2025" for advisory copy. Never used for math. */
function shortDate(iso: string | null, todayIso: string): string | null {
  if (!iso) return null;
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return null;
  const sameYear = iso.slice(0, 4) === todayIso.slice(0, 4);
  return d.toLocaleDateString('en-US', {
    month: 'short',
    day: 'numeric',
    ...(sameYear ? {} : { year: 'numeric' }),
  });
}

/**
 * Which anchors this step spotlights right now. Dynamic on purpose:
 *
 * - Step 2 rings only the FX legs still UNSET, plus that box's CTA, so a rate
 *   already entered stops being nagged about (Kane 2026-08-17: highlight the
 *   box and the CTA per box, not the step header).
 * - Step 4 has two faces since HSL and Additions merged. On the HSL tab it rings
 *   the HSL table and takes turns across its visible money columns (`tick`
 *   advances the rotation); on any other department tab it moves inside the
 *   System Bonus modal once it's open, and goes quiet about the PAB month when
 *   that month's period is already set.
 *
 * Pure: `tick` is supplied by the caller so the rotation stays testable.
 */
export function resolveStepTargets(
  stepId: number,
  s: TutorialSignals,
  tick = 0,
): TutorialTargetKey[] {
  switch (stepId) {
    case 2: {
      const targets: TutorialTargetKey[] = [];
      if (!isSet(s.fxPhp)) targets.push('step2-fx-php', 'step2-fx-php-cta');
      if (!isSet(s.fxCop)) targets.push('step2-fx-cop', 'step2-fx-cop-cta');
      // Both legs set — nothing to fix, so fall back to reviewing the calc.
      return targets.length > 0 ? targets : ['step2-review'];
    }
    case 4: {
      // HSL tab open ⇒ the HSL table is what's mounted, so ring it and walk its
      // money columns. Only the HSL anchors exist in this state.
      if (s.additionsHslTabActive) {
        const visible = HSL_COLUMN_ROTATION.filter((c) => {
          if (c.target === 'step4-col-pab') return s.hslPabColumnShown;
          if (c.target === 'step4-col-tech') return s.hslTechColumnShown;
          return true;
        });
        if (visible.length === 0) return ['step4-hsl-table'];
        const current = visible[((tick % visible.length) + visible.length) % visible.length];
        return ['step4-hsl-table', current.target];
      }
      if (!s.systemBonusModalOpen) return ['step4-system-bonus'];
      // Inside the modal: the month pill only earns a ring while its PAB
      // period is unset. A set period "shouldn't bother at all" (Kane).
      return s.pabSetForActiveMonth
        ? ['step4-tech-week']
        : ['step4-pab-month', 'step4-tech-week'];
    }
    default: {
      const def = TUTORIAL_STEPS.find((d) => d.stepId === stepId);
      return def ? def.targets : [];
    }
  }
}

/** The rotating column's human label, for the balloon's copy. */
export function activeHslColumnLabel(s: TutorialSignals, tick = 0): string | null {
  const visible = HSL_COLUMN_ROTATION.filter((c) => {
    if (c.target === 'step4-col-pab') return s.hslPabColumnShown;
    if (c.target === 'step4-col-tech') return s.hslTechColumnShown;
    return true;
  });
  if (visible.length === 0) return null;
  return visible[((tick % visible.length) + visible.length) % visible.length].label;
}

function daysBetweenIso(fromIso: string, toIso: string): number | null {
  const from = Date.parse(`${fromIso}T00:00:00Z`);
  const to = Date.parse(`${toIso}T00:00:00Z`);
  if (Number.isNaN(from) || Number.isNaN(to)) return null;
  return Math.round((to - from) / 86_400_000);
}

/**
 * Derive the advisory status for one wizard step. Pure; a `done` is a hint
 * badge, never permission — the wizard's own gates (FX-zero on Step 8, etc.)
 * stay the only real gates.
 */
export function deriveStepStatus(
  stepId: number,
  s: TutorialSignals,
): TutorialStepStatus {
  const visited = s.visitedSteps.includes(stepId);
  switch (stepId) {
    case 1: {
      if (!s.sourceFile) {
        return { status: 'pending', note: 'No Hubstaff weekly report for this cycle yet.' };
      }
      if (s.periodEnd) {
        const age = daysBetweenIso(s.periodEnd, s.todayIso);
        if (age != null && age > REPORT_STALE_AFTER_DAYS) {
          return {
            status: 'attention',
            note: `Active batch ends ${s.periodEnd} — looks stale for this week. Upload the new weekly report.`,
          };
        }
      }
      return { status: 'done', note: `Active batch: ${s.sourceFile}` };
    }
    case 2: {
      const phpSet = isSet(s.fxPhp);
      const copSet = isSet(s.fxCop);
      if (!phpSet || !copSet) {
        const missing = !phpSet && !copSet ? 'Neither conversion rate is' : !phpSet ? 'USD→PHP is' : 'USD→COP is';
        // Staleness: name when the rates were last set and what they were, so
        // "not set" reads as "not set THIS week" — but never offer the old
        // number as a value to keep (see PreviousCycleFx).
        const prev = s.previousCycleFx;
        const when = shortDate(prev?.at ?? null, s.todayIso);
        const parts = [`${missing} set for this cycle.`];
        if (prev && when) {
          const rates = [
            isSet(prev.php) ? `₱${prev.php}` : null,
            isSet(prev.cop) ? `$COP${prev.cop}` : null,
          ].filter(Boolean).join(' / ');
          parts.push(
            `Last set ${when}${prev.by ? ` by ${prev.by.split('@')[0]}` : ''} for ${prev.sourceFile}${rates ? ` — ${rates}` : ''}.`,
            'Those are last cycle’s numbers and are never carried over — type this week’s.',
          );
        } else {
          parts.push('Every new upload starts at zero — typing the rate is this week’s confirmation.');
        }
        return { status: 'attention', note: parts.join(' ') };
      }
      return visited
        ? { status: 'done', note: 'Both conversion rates are set for this cycle.' }
        : { status: 'pending', note: 'Review hours × rates and the header cards.' };
    }
    case 3: {
      if (s.orphanageReadyCount > 0) {
        return { status: 'done', note: `${s.orphanageReadyCount} orphanage row(s) ready.` };
      }
      return visited
        ? { status: 'done', note: 'No orphanage rows pasted — fine if there are none this week.' }
        : { status: 'pending', note: null };
    }
    // Additions + HSL + System Bonus (merged 2026-08-28). The old HSL step had no
    // note of its own — visited was the whole status — so the merged step keeps the
    // Additions side's copy, which is the half that actually has something to say.
    case 4: {
      // Inside the modal the guide talks about what still needs setting.
      if (s.systemBonusModalOpen) {
        const month = s.pabActiveMonthLabel ?? 'this month';
        if (!s.pabSetForActiveMonth) {
          return {
            status: 'attention',
            note: `${month} has no PAB period saved yet — set its start/end (or auto-calculate the Mon–Fri window), then pick the Technology Bonus payout week.`,
          };
        }
        return {
          status: 'done',
          note: `${month}'s PAB period is already set — leave it alone. Only the Technology Bonus payout week still needs a look.`,
        };
      }
      const parts: string[] = [];
      if (s.pabRangeLabel) parts.push(`PAB range: ${s.pabRangeLabel}`);
      parts.push(
        s.isTechBonusWeek
          ? 'This IS a Technology Bonus payout week.'
          : 'Not a Technology Bonus payout week (check the System Bonus setting if that is wrong).',
      );
      const note = parts.join(' · ');
      return visited
        ? { status: 'done', note }
        : { status: 'pending', note };
    }
    case 5: {
      if (s.pendingContractorCount > 0) {
        return {
          status: 'attention',
          note: `${s.pendingContractorCount} contractor invoice(s) awaiting a decision.`,
        };
      }
      return { status: 'done', note: 'No pending contractor invoices for this period.' };
    }
    // PAB review. The count is advisory like every other badge here — the guide
    // never gates, and nobody is required to forgive anyone.
    case 6: {
      if (s.pabIneligibleCount > 0) {
        const review = s.pabReviewCount > 0 ? ` ${s.pabReviewCount} missed only 1–2 days.` : '';
        return {
          status: 'attention',
          note: `${s.pabIneligibleCount} person(s) ineligible for this PAB period.${review}`,
        };
      }
      return visited
        ? { status: 'done', note: 'Nobody lost Perfect Attendance this period.' }
        : { status: 'pending', note: 'Nobody ineligible so far.' };
    }
    case 7: {
      if (s.validationRedFlagCount > 0) {
        return {
          status: 'attention',
          note: `${s.validationRedFlagCount} validation flag(s) to review — check each column and the exclusions.`,
        };
      }
      const excl = s.excludedCount > 0 ? ` ${s.excludedCount} excluded from pay.` : '';
      return visited
        ? { status: 'done', note: `No red flags.${excl}` }
        : { status: 'pending', note: `No red flags so far.${excl}` };
    }
    case 8: {
      if (s.dispatched) return { status: 'done', note: 'Cycle dispatched.' };
      return {
        status: 'pending',
        note: `${s.payableCount} payable${s.excludedCount > 0 ? ` · ${s.excludedCount} excluded` : ''}. Lock in when every rate is final.`,
      };
    }
    case 9:
      return visited
        ? { status: 'done', note: null }
        : { status: 'pending', note: null };
    default:
      return { status: 'pending', note: null };
  }
}

// ── Persistence (localStorage) ───────────────────────────────────────────────
// Keyed per (driver email, cycle source file) so dismissing the guide for one
// week's run never hides it for the next week.

export type TutorialPersistedState = {
  dismissed: boolean;
  collapsed: boolean;
  visitedSteps: number[];
};

export const TUTORIAL_STATE_DEFAULT: TutorialPersistedState = {
  dismissed: false,
  collapsed: false,
  visitedSteps: [],
};

export function tutorialStorageKey(
  email: string | null | undefined,
  sourceFile: string | null | undefined,
): string {
  const who = (email ?? 'anonymous').trim().toLowerCase();
  const cycle = (sourceFile ?? 'no-cycle').trim();
  return `wizard-tutorial:${who}:${cycle}`;
}

export function parseTutorialState(raw: string | null): TutorialPersistedState {
  if (!raw) return { ...TUTORIAL_STATE_DEFAULT, visitedSteps: [] };
  try {
    const v = JSON.parse(raw) as Partial<TutorialPersistedState>;
    return {
      dismissed: v.dismissed === true,
      collapsed: v.collapsed === true,
      visitedSteps: Array.isArray(v.visitedSteps)
        ? v.visitedSteps.filter((n): n is number => typeof n === 'number' && n >= 1 && n <= 9)
        : [],
    };
  } catch {
    return { ...TUTORIAL_STATE_DEFAULT, visitedSteps: [] };
  }
}

export function serializeTutorialState(state: TutorialPersistedState): string {
  return JSON.stringify({
    dismissed: state.dismissed,
    collapsed: state.collapsed,
    visitedSteps: [...new Set(state.visitedSteps)].sort((a, b) => a - b),
  });
}
