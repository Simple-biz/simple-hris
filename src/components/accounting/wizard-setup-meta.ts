import {
  AlertTriangle,
  CheckCircle2,
  Clock,
  DollarSign,
  FileText,
  Heart,
  Send,
  Sparkles,
  StickyNote,
  Upload,
} from 'lucide-react';
import type { WizardSetupStep } from '@/lib/payroll/wizard-setup-steps';

/**
 * How a Wizard Setup step LOOKS — one map for every surface that renders one:
 * the Readiness pane's checklist (`PayrollWizardNotesFab.tsx`) and the
 * Accounting Overview's Payroll Notes card (`PayrollNotesSetupCard.tsx`).
 * Extracted 2026-09-26 when the card became the second consumer, so a row can't
 * read "Attention" amber in one place and something else in the other.
 *
 * Amber is for actionable warnings only; `pending` (not sent yet / nothing due /
 * couldn't read) is neutral sky, and rose is reserved for `blocked` — the CSV
 * row is the only one that can reach it.
 */
export const SETUP_STATUS_PILL: Record<
  WizardSetupStep['status'],
  { label: string; cls: string; Icon: typeof CheckCircle2 }
> = {
  done: {
    label: 'Done',
    cls: 'border-emerald-200 bg-emerald-50 text-emerald-700 dark:border-emerald-500/30 dark:bg-emerald-500/10 dark:text-emerald-300',
    Icon: CheckCircle2,
  },
  attention: {
    label: 'Attention',
    cls: 'border-amber-200 bg-amber-50 text-amber-700 dark:border-amber-500/30 dark:bg-amber-500/10 dark:text-amber-300',
    Icon: AlertTriangle,
  },
  blocked: {
    label: 'Blocked',
    cls: 'border-rose-200 bg-rose-50 text-rose-700 dark:border-rose-500/30 dark:bg-rose-500/10 dark:text-rose-300',
    Icon: AlertTriangle,
  },
  pending: {
    label: 'Pending',
    cls: 'border-sky-200 bg-sky-50 text-sky-700 dark:border-sky-500/30 dark:bg-sky-500/10 dark:text-sky-300',
    Icon: Clock,
  },
};

/** The wizard-step icon beside each row — the same glyph the wizard rail uses
 *  for that step where one exists. */
export const SETUP_STEP_ICON: Record<WizardSetupStep['key'], typeof CheckCircle2> = {
  csv: Upload,
  fx: DollarSign,
  orphanage: Heart,
  kpi: Sparkles,
  notes: StickyNote,
  contractors: FileText,
  dispatch: Send,
};
