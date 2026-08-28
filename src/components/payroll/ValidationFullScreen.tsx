// src/components/payroll/ValidationFullScreen.tsx
'use client';

import React, { useEffect, useMemo, useState } from 'react';
import { createPortal } from 'react-dom';
import { AnimatePresence, motion, useReducedMotion } from 'motion/react';
import { Maximize2, Search, X } from 'lucide-react';

import { cn } from '@/lib/utils';
import { formatPHP } from '@/lib/format-php';
import ValidationBreakdownTable from '@/components/payroll/ValidationBreakdownTable';
import type { PayrollBreakdown } from '@/lib/payroll/validation-breakdown';
import type { ManualValidationMap } from '@/lib/payroll/manual-validation';

export type ValidationDeptGroup = {
  key: string;
  name: string;
  rows: PayrollBreakdown[];
};

type Props = {
  open: boolean;
  onClose: () => void;

  /** The department rail. Counts come from each group's own rows. */
  deptGroups: ValidationDeptGroup[];
  activeKey: string;
  onSelectDept: (key: string) => void;

  /**
   * The rows to render — the SAME array the inline step-6 validation table receives, not a
   * re-filtered copy. That is what makes this a mirror rather than a second
   * implementation: there is no predicate here that could drift from the one
   * upstairs.
   */
  rows: PayrollBreakdown[];
  deptName: string;
  isHsl: boolean;

  search: string;
  onSearchChange: (next: string) => void;

  /** Pass-throughs, forwarded verbatim to the shared table. */
  disabled: boolean;
  onToggleExcluded: (email: string) => void;
  onToggleAllExcluded: (emails: string[], next: boolean) => void;
  validations?: ManualValidationMap;
  onToggleValidated?: (email: string, next: boolean, note: string | null) => void;
  savingValidations?: ReadonlySet<string>;

  /** e.g. "Aug 9 – Aug 15" — shown in the header so a full-screen operator can
   *  still see which week they are certifying. */
  periodLabel?: string | null;
};

/** The house easing curve (ease-out-quint) — the same constant five other
 *  surfaces in this app animate on, so the overlay feels like the rest of it. */
const EASE = [0.22, 1, 0.36, 1] as const;

/** Opening is a layout change, so it sits at the low end of the 300-500ms band;
 *  the exit runs at ~70% of it, because a dismissal that takes as long as an
 *  entrance reads as lag rather than polish. */
const ENTER_S = 0.26;
const EXIT_S = 0.18;

/**
 * The Validation step's table, filling the viewport.
 *
 * Why a portal and not a route: the rows are `PayrollBreakdown[]` derived inside
 * `PayrollWizard.tsx`'s React memory from the loaded Hubstaff upload plus the
 * live staged dispatch payloads. There is no endpoint that returns them, so a
 * separate page could only re-derive them from `/api/payroll-current-pay` — a
 * second pay implementation, free to disagree with the wizard on the one screen
 * whose job is certifying that the wizard is right. Rendering the same component
 * with the same array into `document.body` mirrors it by construction.
 *
 * Modelled on the KPI calculator's `focus` mode
 * (`src/components/manager/DeptBonusCalculator.tsx`), the repo's only other
 * full-screen workspace overlay: same SSR `mounted` guard, same body scroll lock,
 * same Escape-to-close.
 */
export default function ValidationFullScreen({
  open, onClose,
  deptGroups, activeKey, onSelectDept,
  rows, deptName, isHsl,
  search, onSearchChange,
  disabled, onToggleExcluded, onToggleAllExcluded,
  validations, onToggleValidated, savingValidations,
  periodLabel,
}: Props) {
  // Portal guard: the fixed overlay only renders after mount (SSR-safe).
  const [mounted, setMounted] = useState(false);
  useEffect(() => setMounted(true), []);
  const reduceMotion = useReducedMotion();

  // Escape closes. Bound only while open so a closed overlay never swallows the
  // key from the wizard underneath it.
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [open, onClose]);

  // Lock body scroll, restoring whatever was there before rather than assuming
  // it was the default — the wizard may already have locked it for a modal.
  useEffect(() => {
    if (!open) return;
    const prev = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    return () => { document.body.style.overflow = prev; };
  }, [open]);

  // Gated on `open` so a closed overlay costs nothing while the wizard re-renders
  // around it — `rows` changes on every exclude toggle upstairs.
  const { payable, subtotal } = useMemo(() => {
    if (!open) return { payable: [] as PayrollBreakdown[], subtotal: 0 };
    const p = rows.filter((r) => !r.excluded);
    return { payable: p, subtotal: p.reduce((s, r) => s + r.gross, 0) };
  }, [open, rows]);

  if (!mounted) return null;

  return createPortal(
    // AnimatePresence, not a bare `open &&`: without it React unmounts the panel
    // the instant `open` flips and the exit never gets a chance to play.
    <AnimatePresence>
      {open && (
        <motion.div
          key="validation-full-screen"
          role="dialog"
          aria-modal="true"
          // Matches the visible heading verbatim, so a screen reader announces
          // the same words that are on screen.
          aria-label="Validation — full screen"
          className="fixed inset-0 z-[70] flex flex-col bg-white dark:bg-zinc-950"
          // Grows the last 1.5% into place, because the action IS an expansion:
          // the inline table becoming the whole viewport. Same ~1% magnitude as
          // the KPI calculator's focus mode, mirrored in direction to suit this
          // affordance. Reduced motion gets the crossfade and no transform.
          initial={reduceMotion ? { opacity: 0 } : { opacity: 0, scale: 0.985 }}
          animate={{ opacity: 1, scale: 1 }}
          exit={reduceMotion ? { opacity: 0 } : { opacity: 0, scale: 0.99 }}
          // Duration keyed off `open` rather than a per-property override:
          // AnimatePresence waits for the LONGEST exit tween, so overriding only
          // opacity would have left scale running the full enter duration and
          // made the dismissal slower than the entrance.
          transition={{
            duration: reduceMotion ? 0.12 : open ? ENTER_S : EXIT_S,
            ease: EASE,
          }}
        >
          {/* Header */}
          <div className="flex shrink-0 flex-wrap items-center gap-3 border-b border-zinc-200 px-4 py-3 dark:border-zinc-800">
            <div className="flex items-center gap-2">
              <Maximize2 className="h-4 w-4 text-zinc-400" aria-hidden />
              <h2 className="text-sm font-semibold text-zinc-800 dark:text-zinc-100">
                Validation — full screen
              </h2>
            </div>
            {periodLabel && (
              <span className="rounded-full bg-zinc-100 px-2 py-0.5 font-mono text-[10px] text-zinc-600 dark:bg-zinc-800 dark:text-zinc-300">
                {periodLabel}
              </span>
            )}

            <div className="relative ml-auto">
              <Search className="pointer-events-none absolute left-2 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-zinc-400" aria-hidden />
              <input
                value={search}
                onChange={(e) => onSearchChange(e.target.value)}
                placeholder="Search name or email…"
                aria-label="Search employees"
                className="w-56 rounded-md border border-zinc-200 bg-white py-1.5 pl-7 pr-2 text-xs text-zinc-800 outline-none focus:border-indigo-400 dark:border-zinc-700 dark:bg-zinc-900 dark:text-zinc-200"
              />
            </div>

            <button
              type="button"
              onClick={onClose}
              aria-label="Exit full screen"
              className="rounded-md p-1.5 text-zinc-500 hover:bg-zinc-100 hover:text-zinc-800 dark:hover:bg-zinc-800 dark:hover:text-zinc-200"
            >
              <X className="h-4 w-4" />
            </button>
          </div>

          {/* Department rail */}
          <div className="flex shrink-0 gap-1 overflow-x-auto border-b border-zinc-200 px-3 py-2 dark:border-zinc-800">
            {deptGroups.map((g) => {
              const active = g.key === activeKey;
              const gValidated = validations
                ? g.rows.reduce(
                    (n, r) => n + (validations[r.email.trim().toLowerCase()] ? 1 : 0),
                    0,
                  )
                : 0;
              const allValidated = validations != null && g.rows.length > 0 && gValidated === g.rows.length;
              return (
                <button
                  key={g.key}
                  type="button"
                  onClick={() => onSelectDept(g.key)}
                  aria-pressed={active}
                  className={cn(
                    'flex shrink-0 items-center gap-1.5 rounded-md px-2.5 py-1 text-xs font-medium transition-colors',
                    active
                      ? 'bg-zinc-900 text-white dark:bg-zinc-100 dark:text-zinc-900'
                      : 'text-zinc-600 hover:bg-zinc-100 dark:text-zinc-400 dark:hover:bg-zinc-800',
                  )}
                >
                  <span>{g.name}</span>
                  <span className={cn('font-mono text-[10px]', active ? 'opacity-70' : 'text-zinc-400')}>
                    {g.rows.length}
                  </span>
                  {/* A fully-validated department earns a dot. Progress belongs on the
                      rail so an operator can see where the unchecked work is without
                      opening every tab. */}
                  {allValidated && (
                    <span
                      className="h-1.5 w-1.5 rounded-full bg-emerald-500"
                      title={`All ${g.rows.length} manually validated`}
                      aria-label="All manually validated"
                    />
                  )}
                </button>
              );
            })}
          </div>

          {/* The table — the same component and the same rows as the inline step. */}
          <div className="min-h-0 flex-1 overflow-hidden px-3 py-2">
            <ValidationBreakdownTable
              rows={rows}
              deptName={deptName}
              isHsl={isHsl}
              disabled={disabled}
              onToggleExcluded={onToggleExcluded}
              onToggleAllExcluded={onToggleAllExcluded}
              validations={validations}
              onToggleValidated={onToggleValidated}
              savingValidations={savingValidations}
              fillHeight
            />
          </div>

          {/* Footer total, so the figure being certified stays on screen */}
          <div className="flex shrink-0 items-center justify-between border-t border-zinc-200 px-4 py-2 text-xs dark:border-zinc-800">
            <span className="text-zinc-500 dark:text-zinc-400">
              {deptName} · {payable.length} payable
              {rows.length - payable.length > 0 ? ` · ${rows.length - payable.length} excluded` : ''}
            </span>
            <span className="font-mono font-bold tabular-nums text-indigo-700 dark:text-indigo-300">
              {formatPHP(subtotal)}
            </span>
          </div>
        </motion.div>
      )}
    </AnimatePresence>,
    document.body,
  );
}
