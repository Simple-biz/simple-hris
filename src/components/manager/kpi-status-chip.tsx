'use client';

import { AlertTriangle, CheckCircle2, CircleDashed, Lock } from 'lucide-react';
import type { BonusStatus } from '@/lib/hsl-bonus/schema';
import { cn } from '@/lib/utils';

/**
 * The scoring-period status chip, shared by BOTH KPI calculators — the HSL
 * branch grid and its block header, and the Departments landing rows — so one
 * status can never read two ways across the two surfaces a manager switches
 * between.
 *
 * The three states are a ladder: nothing entered yet, the manager has signed
 * off, payroll has taken it. They are drawn as one — a hollow outline, then two
 * filled chips:
 *
 * | Status   | Chip                             | Glyph          |
 * | -------- | -------------------------------- | -------------- |
 * | `draft`  | hollow, `zinc-300` border        | `CircleDashed` |
 * | `ready`  | filled `emerald-700`, white      | `CheckCircle2` |
 * | `locked` | filled `zinc-900` (inverted dark)| `Lock`         |
 *
 * Both calculators previously washed all three in the same pale tint, which made
 * "draft" and "ready" the same shape at a glance across a wall of departments.
 * They also disagreed with each other: HSL painted `ready` amber, Departments
 * painted `locked` amber, and amber is reserved for warnings everywhere else in
 * this app.
 *
 * **Ready is green** (Kane, 2026-09-02) — the manager's own sign-off, and the
 * state they are scanning the list for. That pushes `locked` onto the terminal
 * ink instead: green means *you* finished, black means payroll did and nothing
 * moves now. Two greens a step apart would have been the amber problem again in
 * a different hue.
 *
 * Each chip carries a glyph, so the state survives being read at speed or in
 * greyscale. The green is `emerald-700` (4.6:1 against white) rather than `-600`
 * or `-500`, which fall under 4.5:1 at this text size.
 */
const STATUS_PRESENTATION: Record<
  BonusStatus,
  { label: string; Icon: typeof CircleDashed; className: string; title: string }
> = {
  draft: {
    label: 'Draft',
    Icon: CircleDashed,
    className:
      'border-zinc-300 bg-transparent text-zinc-600 dark:border-zinc-700 dark:text-zinc-400',
    title: 'Still being scored — nobody downstream can see these figures yet.',
  },
  ready: {
    label: 'Ready',
    Icon: CheckCircle2,
    className: 'border-transparent bg-emerald-700 text-white shadow-sm',
    title: 'Marked ready by the manager — waiting for payroll to lock it.',
  },
  locked: {
    label: 'Locked',
    Icon: Lock,
    className:
      'border-transparent bg-zinc-900 text-white shadow-sm dark:bg-zinc-100 dark:text-zinc-900',
    title: 'Locked by payroll — these figures are final for the period.',
  },
};

/**
 * `warn` replaces the draft chip with an amber "Action needed" — the deadline is
 * close and this period is still editable. It is deliberately the ONLY amber on
 * either calculator, which is what lets amber keep meaning "a person has to do
 * something" rather than "a state exists". It never overrides `ready` or
 * `locked`: once a period is signed off there is nothing left to act on.
 */
export function StatusChip({
  status,
  warn = false,
  className,
}: {
  status: BonusStatus;
  warn?: boolean;
  className?: string;
}) {
  const base =
    warn && status === 'draft'
      ? {
          label: 'Action needed',
          Icon: AlertTriangle,
          className:
            'border-amber-300 bg-amber-100 text-amber-800 dark:border-amber-700/60 dark:bg-amber-950/50 dark:text-amber-300',
          title: 'The scoring deadline is close and this period is still a draft.',
        }
      : STATUS_PRESENTATION[status];

  return (
    <span
      title={base.title}
      className={cn(
        'inline-flex flex-none items-center gap-1 rounded-md border px-1.5 py-0.5',
        'font-mono text-[10px] font-semibold uppercase leading-none tracking-[0.1em]',
        base.className,
        className,
      )}
    >
      <base.Icon className="h-3 w-3" aria-hidden />
      {base.label}
    </span>
  );
}
