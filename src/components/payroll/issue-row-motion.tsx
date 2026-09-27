'use client';

/**
 * Accounting → Issues: row motion shared by BOTH row kinds — the dispute rows drawn in
 * `PabDisputeQueue.tsx` and `TimeAdjustmentIssueTableRow` — so the two can never move
 * differently inside one table.
 *
 * - Rows rise in with a capped stagger when a view mounts (page, status filter, first load).
 * - A row that leaves the current view (a decision moved it out of Pending, a search
 *   narrowed past it, a delete) drifts out and the rows below close the gap
 *   (`layout="position"` — position only, so a wrapping explanation never scale-distorts).
 * - A row whose status changed between two reads sweeps its outcome colour once
 *   (`issue-row-flash-*` in `src/index.css`; which rows, and which colour, is the pure
 *   `src/lib/accounting/issue-row-flash.ts`) and its status badge swaps in place.
 *
 * Reduced motion keeps the fades and the colour sweep — they carry state — and drops every
 * translation, the stagger, and the layout slide.
 */

import type { ComponentProps, ReactNode } from 'react';
import { AnimatePresence, motion, useReducedMotion } from 'motion/react';
import { cn } from '@/lib/utils';
import type { IssueFlashTone } from '@/lib/accounting/issue-row-flash';

/** Confident arrival, no overshoot. */
export const ISSUE_EASE = [0.16, 1, 0.3, 1] as const;

type IssueMotionRowProps = Omit<
  ComponentProps<typeof motion.tr>,
  'initial' | 'animate' | 'exit' | 'transition' | 'layout'
> & {
  /** Position on the page — drives the entrance stagger (capped at 200ms). */
  index: number;
  flash?: IssueFlashTone | null;
};

export function IssueMotionRow({ index, flash, className, ...props }: IssueMotionRowProps) {
  const reduce = useReducedMotion();
  return (
    <motion.tr
      data-slot="table-row"
      layout={reduce ? false : 'position'}
      initial={reduce ? { opacity: 0 } : { opacity: 0, y: 6 }}
      animate={{ opacity: 1, y: 0 }}
      exit={
        reduce
          ? { opacity: 0, transition: { duration: 0.1 } }
          : { opacity: 0, x: -14, transition: { duration: 0.16, ease: [0.4, 0, 1, 1] } }
      }
      transition={{
        duration: reduce ? 0.12 : 0.28,
        ease: ISSUE_EASE,
        delay: reduce ? 0 : Math.min(index * 0.028, 0.2),
        layout: { duration: 0.32, ease: ISSUE_EASE },
      }}
      className={cn('border-b', flash && `issue-row-flash issue-row-flash-${flash}`, className)}
      {...props}
    />
  );
}

/** A status badge that swaps in place when the status changes, and sits still otherwise. */
export function IssueStatusSwap({ status, children }: { status: string; children: ReactNode }) {
  const reduce = useReducedMotion();
  return (
    <AnimatePresence initial={false} mode="wait">
      <motion.span
        key={status}
        className="inline-flex"
        initial={{ opacity: 0, scale: reduce ? 1 : 0.8 }}
        animate={{ opacity: 1, scale: 1 }}
        exit={{ opacity: 0, scale: reduce ? 1 : 0.9, transition: { duration: 0.09 } }}
        transition={{ duration: 0.24, ease: ISSUE_EASE }}
      >
        {children}
      </motion.span>
    </AnimatePresence>
  );
}
