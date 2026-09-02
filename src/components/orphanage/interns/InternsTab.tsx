'use client';

import { useState } from 'react';
import { AnimatePresence, motion, useReducedMotion } from 'motion/react';
import { CalendarRange, Users } from 'lucide-react';
import { cn } from '@/lib/utils';
import InternsProfilesPanel from './InternsProfilesPanel';
import InternsWizard from './InternsWizard';

type Pane = 'profiles' | 'pay-week';

/**
 * Orphanage dashboard → Interns. Two panes:
 *   Profiles — the ONLY place intern personal data, bank details and rates change
 *              (Kane 2026-09-02). Accounting reads; it never edits.
 *   Pay week — the mini Payroll Wizard: upload the interns' Hubstaff report,
 *              price the week, lock it in for Accounting.
 * Doc: docs/features/orphanage-interns.md.
 *
 * The pane switch uses the dashboard's own tab motion (the OrphanageApp tab
 * variants: fade + 10px rise, 280ms, the same ease), with `mode="wait"` so the
 * outgoing pane finishes leaving before the incoming one enters — no overlap
 * flash, no layout jump. The selected pill slides with a shared layoutId.
 * Reduced motion collapses it to an instant crossfade.
 */
export default function InternsTab({ viewerEmail, canEdit }: { viewerEmail: string | null; canEdit: boolean }) {
  const [pane, setPane] = useState<Pane>('profiles');
  const reduceMotion = useReducedMotion() ?? false;

  const tabs: Array<{ id: Pane; label: string; Icon: typeof Users; hint: string }> = [
    { id: 'profiles', label: 'Profiles', Icon: Users, hint: 'Who the interns are, their rate and bank' },
    { id: 'pay-week', label: 'Pay week', Icon: CalendarRange, hint: 'Upload hours, price the week, lock in' },
  ];

  const paneMotion = reduceMotion
    ? { initial: { opacity: 0 }, animate: { opacity: 1 }, exit: { opacity: 0 }, transition: { duration: 0.12 } }
    : {
        initial: { opacity: 0, y: 10 },
        animate: { opacity: 1, y: 0 },
        exit: { opacity: 0, y: -8 },
        transition: { duration: 0.28, ease: [0.22, 1, 0.36, 1] as [number, number, number, number] },
      };

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div className="border-b border-pink-100/70 px-6 pt-5 dark:border-pink-950/40">
        <div className="flex flex-wrap items-end justify-between gap-3 pb-4">
          <div>
            <h1 className="text-xl font-bold text-zinc-900 dark:text-zinc-50">Interns</h1>
            <p className="mt-0.5 text-xs text-zinc-500 dark:text-zinc-400">
              @pathway.ph interns — profiled here, paid through the Payroll Wizard&apos;s Interns view.
            </p>
          </div>
          <div
            role="tablist"
            aria-label="Interns sections"
            className="inline-flex rounded-xl border border-pink-100 bg-pink-50/60 p-1 dark:border-pink-950/50 dark:bg-pink-950/20"
          >
            {tabs.map((t) => {
              const active = pane === t.id;
              return (
                <button
                  key={t.id}
                  role="tab"
                  type="button"
                  aria-selected={active}
                  aria-controls={`interns-pane-${t.id}`}
                  onClick={() => setPane(t.id)}
                  title={t.hint}
                  className={cn(
                    'relative flex items-center gap-1.5 rounded-lg px-3 py-1.5 text-xs font-semibold transition-colors duration-200',
                    active ? 'text-pink-700 dark:text-pink-300' : 'text-zinc-500 hover:text-pink-700 dark:text-zinc-400 dark:hover:text-pink-300',
                  )}
                >
                  {active && (
                    <motion.span
                      layoutId="interns-pane-pill"
                      aria-hidden
                      className="absolute inset-0 rounded-lg bg-white shadow-sm dark:bg-zinc-900"
                      transition={reduceMotion ? { duration: 0 } : { type: 'spring', stiffness: 420, damping: 34 }}
                    />
                  )}
                  <t.Icon className="relative h-3.5 w-3.5" />
                  <span className="relative">{t.label}</span>
                </button>
              );
            })}
          </div>
        </div>
      </div>

      <div className="relative flex min-h-0 flex-1 flex-col overflow-hidden">
        <AnimatePresence mode="wait" initial={false}>
          {pane === 'profiles' ? (
            <motion.div
              key="profiles"
              id="interns-pane-profiles"
              role="tabpanel"
              {...paneMotion}
              className="flex min-h-0 flex-1 flex-col overflow-y-auto"
            >
              <InternsProfilesPanel viewerEmail={viewerEmail} canEdit={canEdit} />
            </motion.div>
          ) : (
            <motion.div
              key="pay-week"
              id="interns-pane-pay-week"
              role="tabpanel"
              {...paneMotion}
              className="flex min-h-0 flex-1 flex-col overflow-y-auto"
            >
              <InternsWizard viewerEmail={viewerEmail} canEdit={canEdit} onGoToProfiles={() => setPane('profiles')} />
            </motion.div>
          )}
        </AnimatePresence>
      </div>
    </div>
  );
}
