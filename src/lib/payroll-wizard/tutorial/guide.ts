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
  | 'step3-paste-data'
  | 'step4-hsl-review'
  | 'step5-system-bonus'
  | 'step6-pending-invoices'
  | 'step7-validation-table'
  | 'step8-lock-in'
  | 'step9-audit-trail';

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
    title: 'Initial calculation',
    hint:
      'Review the calculated hours × rates. Make sure the FX rate is set for this cycle and no one is missing a pay rate before moving on.',
    kind: 'review',
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
    stepId: 4,
    title: 'HSL review',
    hint:
      'Review Hogan Smith Law pay: initial pay, KPI bonuses, and accounting overrides. Confirm the values look right — nothing to submit here.',
    kind: 'review',
    targets: ['step4-hsl-review'],
  },
  {
    stepId: 5,
    title: 'Additions & System Bonus',
    hint:
      'Review bonuses and adjustments. Open System Bonus settings and confirm the PAB range and the Technology Bonus payout week for this month.',
    kind: 'review',
    targets: ['step5-system-bonus'],
  },
  {
    stepId: 6,
    title: 'Contractors',
    hint:
      'Review each pending contractor invoice for this period and approve or reject it before dispatch.',
    kind: 'action',
    targets: ['step6-pending-invoices'],
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
export type TutorialSignals = {
  todayIso: string;
  sourceFile: string | null;
  /** Cycle period parsed from the active Hubstaff filename (may be null). */
  periodStart: string | null;
  periodEnd: string | null;
  /** Per-cycle FX; 0 or null = not set for this cycle (Step 8 is hard-gated on it elsewhere). */
  fxRate: number | null;
  orphanageReadyCount: number;
  pabRangeLabel: string | null;
  isTechBonusWeek: boolean;
  pendingContractorCount: number;
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
      if (s.fxRate == null || s.fxRate === 0) {
        return { status: 'attention', note: 'FX rate is not set for this cycle.' };
      }
      return visited
        ? { status: 'done', note: null }
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
    case 4:
      return visited
        ? { status: 'done', note: null }
        : { status: 'pending', note: null };
    case 5: {
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
    case 6: {
      if (s.pendingContractorCount > 0) {
        return {
          status: 'attention',
          note: `${s.pendingContractorCount} contractor invoice(s) awaiting a decision.`,
        };
      }
      return { status: 'done', note: 'No pending contractor invoices for this period.' };
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
