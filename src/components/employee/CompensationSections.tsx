'use client';

import { LayoutGroup, motion, useReducedMotion } from 'motion/react';
import { cn } from '@/lib/utils';
import { COMPENSATION_SECTIONS } from '@/lib/employee/compensation-sections';
import type { SectionId } from '@/lib/employee/profile-tabs';

/**
 * The Compensation tab's inner strip: Rates | Pay Stubs | Payout.
 *
 * The Profile's OUTER tab strip (`TabBar` in EmployeeProfile.tsx) is an orange
 * underline inside `LayoutGroup id="employee-profile-tabs"`. This strip sits one
 * level below it, so — following the house rule stated at
 * `PayProcessorsTab.tsx:1329-1330` ("Inner tabs sit one level below the Payment
 * Catalog's own pill row, so they are quieter by design: a bordered segmented
 * control, not a second row of pills") — it is a bordered segmented control, not
 * a second underline. Two underlines would read as competing rows rather than a
 * hierarchy. `PayProcessorsTab` is an accounting surface though, so its container
 * chrome (`border-zinc-200`, `dark:bg-zinc-950`) is off-tone here — the container
 * border/background instead follow the employee portal's own segmented control at
 * `EmployeeLeaves.tsx:300`. The active pill's `bg-orange-100 dark:bg-blue-950/60`
 * is already house-correct for this portal (same pairing at
 * `EmployeeTeam.tsx:357,966,1141`) and is kept as-is.
 *
 * Its own `LayoutGroup` id and its own `layoutId` are load-bearing: reusing
 * either of the outer strip's would let Framer animate the outer underline down
 * into this inner strip on mount.
 */
export function CompensationSections({
  active,
  onChange,
  needsPayout,
  payoutEscalated = false,
}: {
  active: SectionId;
  onChange: (id: SectionId) => void;
  /** Amber dot on Payout — bank details still needed. */
  needsPayout: boolean;
  /** Escalate the Payout dot to rose — accounting requested bank info. */
  payoutEscalated?: boolean;
}) {
  // The outer strip (TabBar) has no reduced-motion gate. Do not propagate that
  // gap here — when the viewer asked for reduced motion, skip the motion.span
  // entirely rather than just zeroing its transition.
  const reduceMotion = useReducedMotion();

  return (
    <LayoutGroup id="employee-profile-compensation-sections">
      <div
        role="tablist"
        aria-label="Compensation sections"
        className="mb-5 inline-flex items-center gap-1 rounded-lg border border-orange-100/80 bg-white/70 p-1 shadow-sm backdrop-blur dark:border-blue-950/60 dark:bg-zinc-900/60"
      >
        {COMPENSATION_SECTIONS.map((s) => {
          const isActive = active === s.id;
          const hasIssue = s.id === 'payout' && needsPayout;
          const escalated = s.id === 'payout' && payoutEscalated;
          return (
            <button
              key={s.id}
              type="button"
              role="tab"
              aria-selected={isActive}
              onClick={() => onChange(s.id)}
              className={cn(
                'relative flex items-center gap-1.5 rounded-md px-3 py-1.5 text-xs font-semibold transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-orange-500/40 focus-visible:ring-offset-2 focus-visible:ring-offset-white dark:focus-visible:ring-offset-[#0a0a0a]',
                isActive
                  ? 'text-orange-900 dark:text-white'
                  : 'text-zinc-500 hover:text-zinc-800 dark:text-zinc-400 dark:hover:text-zinc-200',
              )}
            >
              {isActive && (
                reduceMotion ? (
                  <span className="absolute inset-0 rounded-md bg-orange-100 dark:bg-blue-950/60" />
                ) : (
                  <motion.span
                    layoutId="compensation-section-chip"
                    className="absolute inset-0 rounded-md bg-orange-100 dark:bg-blue-950/60"
                    transition={{ type: 'spring', stiffness: 500, damping: 36 }}
                  />
                )
              )}
              <span className="relative z-10">{s.label}</span>
              {hasIssue && (
                <span
                  className="relative z-10 ml-0.5 flex h-2 w-2"
                  aria-label={escalated ? `${s.label} details requested` : `${s.label} setup needed`}
                >
                  <span
                    className={cn(
                      'absolute inline-flex h-full w-full animate-ping rounded-full',
                      escalated ? 'bg-rose-500/70' : 'bg-amber-500/70',
                    )}
                  />
                  <span
                    className={cn(
                      'relative inline-flex h-2 w-2 rounded-full ring-2 ring-white dark:ring-zinc-950',
                      escalated ? 'bg-rose-500' : 'bg-amber-500',
                    )}
                  />
                </span>
              )}
            </button>
          );
        })}
      </div>
    </LayoutGroup>
  );
}
