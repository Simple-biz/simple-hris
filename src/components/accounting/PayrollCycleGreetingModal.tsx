'use client';

import React, { useEffect, useMemo, useState } from 'react';
import { motion, useReducedMotion } from 'motion/react';
import { ArrowRight, CheckCircle2, Eye, Sparkles } from 'lucide-react';
import { cn } from '@/lib/utils';
import { Button } from '@/components/ui/button';
import { Dialog, DialogContent, DialogDescription, DialogTitle } from '@/components/ui/dialog';
import { SETUP_STATUS_PILL, SETUP_STEP_ICON } from '@/components/accounting/wizard-setup-meta';
import { getTabCache, setTabCache, TAB_CACHE_KEYS } from '@/lib/accounting/tab-cache';
import { resolveFirstName } from '@/lib/name/first-name';
import type { PayrollReadiness } from '@/lib/payroll/payroll-readiness';
import type { WizardSetup, WizardSetupStep } from '@/lib/payroll/wizard-setup-steps';
import { READINESS_FRESH_MS, readCachedReadiness, writeCachedReadiness } from '@/lib/payroll/readiness-cache';
import { AWAITING_CSV_KEY, buildCycleGreeting, type GreetingItem } from '@/lib/payroll/cycle-greeting';

/**
 * Accounting dashboard → "Hi Kane" greeting modal: the LIVE payroll cycle's
 * Wizard Setup checklist with the unfinished steps first, so they get fixed
 * right away (Kane, 2026-09-26 — e.g. USD → PHP / COP rates not updated,
 * orphanage hours not synced).
 *
 * The shell mounts this only for a viewer who can open BOTH the Overview and
 * the Payroll Wizard tab; the readiness route's own `payroll_wizard` view gate
 * still decides — a 401/403 (or any failed read) means the modal never opens.
 * It never greets with empty or invented steps.
 *
 * Opens at most once per browser session (`TAB_CACHE_KEYS.cycleGreetingShown`,
 * purged on sign-out), only when something is unfinished, never over another
 * open dialog, and about 600ms after the data is ready so it lands after the
 * dashboard has painted.
 *
 * Every row is `wizardSetup` as the server derived it (`buildCycleGreeting`
 * adds headlines and order, never a status). "You're on Step N" is DERIVED from
 * the first unfinished row — the wizard's own step is not stored anywhere.
 */

const OPEN_DELAY_MS = 600;
/** How long to keep waiting for another open dialog to close before giving up
 *  for this page load (the session flag stays unset, so a reload tries again). */
const OTHER_DIALOG_WAIT_MS = 20_000;
/** Don't hold the greeting hostage to the name lookup. */
const NAME_WAIT_MS = 1500;

const SEGMENT_FILL: Record<WizardSetupStep['status'], string> = {
  done: 'bg-emerald-500 dark:bg-emerald-400',
  attention: 'bg-amber-400',
  blocked: 'bg-rose-500 dark:bg-rose-400',
  pending: 'bg-sky-400',
};

const ITEM_ACCENT: Record<WizardSetupStep['status'], { bar: string; tile: string }> = {
  blocked: {
    bar: 'bg-rose-500',
    tile: 'bg-rose-50 text-rose-600 ring-rose-200 dark:bg-rose-500/10 dark:text-rose-300 dark:ring-rose-500/30',
  },
  attention: {
    bar: 'bg-amber-400',
    tile: 'bg-amber-50 text-amber-600 ring-amber-200 dark:bg-amber-500/10 dark:text-amber-300 dark:ring-amber-500/30',
  },
  pending: {
    bar: 'bg-sky-400',
    tile: 'bg-sky-50 text-sky-600 ring-sky-200 dark:bg-sky-500/10 dark:text-sky-300 dark:ring-sky-500/30',
  },
  done: {
    bar: 'bg-emerald-500',
    tile: 'bg-emerald-50 text-emerald-600 ring-emerald-200 dark:bg-emerald-500/10 dark:text-emerald-300 dark:ring-emerald-500/30',
  },
};

function anotherDialogIsOpen(): boolean {
  return document.querySelector('[data-slot="dialog-content"], [role="dialog"], [role="alertdialog"]') != null;
}

/** The live week's checklist: fresh cache if we have it, else the route. Null
 *  on ANY failure — the caller then simply never opens. */
async function loadLiveSetup(signal: AbortSignal): Promise<WizardSetup | null> {
  const cached = readCachedReadiness(null);
  if (cached && Date.now() - cached.at < READINESS_FRESH_MS) return cached.readiness.wizardSetup ?? null;
  try {
    const res = await fetch('/api/payroll-wizard/readiness', { cache: 'no-store', signal });
    if (!res.ok) return null;
    const json = (await res.json()) as { readiness?: PayrollReadiness };
    if (!json.readiness?.wizardSetup) return null;
    writeCachedReadiness(null, json.readiness);
    return json.readiness.wizardSetup;
  } catch {
    return null;
  }
}

async function loadViewerName(email: string, signal: AbortSignal): Promise<string | null> {
  try {
    const res = await fetch(`/api/employees?email=${encodeURIComponent(email)}`, { cache: 'no-store', signal });
    if (!res.ok) return null;
    const j = (await res.json()) as { employees?: Array<{ name?: unknown }> };
    const n = j.employees?.[0]?.name;
    return typeof n === 'string' && n.trim() ? n.trim() : null;
  } catch {
    return null;
  }
}

export default function PayrollCycleGreetingModal({
  viewerEmail,
  canJump,
  onGoToStep,
  onOpenWizard,
}: {
  viewerEmail: string;
  /** The viewer holds the wizard's EDIT grant — items get "Go to Step N". A
   *  view-only viewer is locked out of step navigation, so gets only "Open". */
  canJump: boolean;
  onGoToStep: (step: number, sourceFile: string | null) => void;
  onOpenWizard: () => void;
}) {
  const reduceMotion = useReducedMotion();
  const [open, setOpen] = useState(false);
  const [setup, setSetup] = useState<WizardSetup | null>(null);
  const [firstName, setFirstName] = useState<string>('');

  useEffect(() => {
    if (getTabCache<boolean>(TAB_CACHE_KEYS.cycleGreetingShown) === true) return;
    const ctrl = new AbortController();
    const timers: number[] = [];
    let cancelled = false;

    (async () => {
      const namePromise = loadViewerName(viewerEmail, ctrl.signal);
      const nameOrTimeout = Promise.race([
        namePromise,
        new Promise<null>((r) => timers.push(window.setTimeout(() => r(null), NAME_WAIT_MS))),
      ]);
      const [live, name] = await Promise.all([loadLiveSetup(ctrl.signal), nameOrTimeout]);
      if (cancelled || !live || !buildCycleGreeting(live).shouldOpen) return;

      setSetup(live);
      setFirstName(resolveFirstName({ name, email: viewerEmail, fallback: 'there' }));

      const startedWaiting = Date.now();
      const tryOpen = () => {
        if (cancelled) return;
        if (anotherDialogIsOpen()) {
          if (Date.now() - startedWaiting < OTHER_DIALOG_WAIT_MS) timers.push(window.setTimeout(tryOpen, 1000));
          return;
        }
        setTabCache(TAB_CACHE_KEYS.cycleGreetingShown, true);
        setOpen(true);
      };
      timers.push(window.setTimeout(tryOpen, OPEN_DELAY_MS));
    })();

    return () => {
      cancelled = true;
      ctrl.abort();
      timers.forEach((t) => window.clearTimeout(t));
    };
  }, [viewerEmail]);

  const greeting = useMemo(() => (setup ? buildCycleGreeting(setup) : null), [setup]);
  if (!setup || !greeting) return null;

  const actionable = greeting.items.filter((i) => i.status === 'attention' || i.status === 'blocked').length;
  const summary =
    actionable > 0
      ? `${actionable} ${actionable === 1 ? 'thing needs' : 'things need'} fixing on the ${setup.weekLabel} payroll before it can go to Payment Dispatch.`
      : `The ${setup.weekLabel} payroll is still waiting on ${greeting.items.length} ${greeting.items.length === 1 ? 'step' : 'steps'}.`;
  const nextKey = setup.steps.find((s) => s.status !== 'done')?.key ?? null;

  const go = (item: GreetingItem) => {
    if (item.jumpStep == null) return;
    setOpen(false);
    onGoToStep(item.jumpStep, item.jumpSourceFile);
  };

  const enter = (i: number) =>
    reduceMotion
      ? { initial: { opacity: 0 }, animate: { opacity: 1 }, transition: { duration: 0.2, delay: 0.05 * i } }
      : {
          initial: { opacity: 0, y: 12 },
          animate: { opacity: 1, y: 0 },
          transition: { duration: 0.36, delay: 0.14 + 0.07 * i, ease: [0.22, 1, 0.36, 1] as const },
        };

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogContent className="max-h-[85dvh] gap-0 overflow-hidden p-0 sm:max-w-xl">
        <div className="flex max-h-[85dvh] min-h-0 flex-col">
          {/* Header */}
          <div className="shrink-0 px-6 pb-4 pt-6">
            <motion.div {...enter(0)}>
              <span className="inline-flex items-center gap-1.5 rounded-full bg-white/70 px-2.5 py-1 text-[10px] font-semibold uppercase tracking-[0.16em] text-orange-700 ring-1 ring-orange-200/70 dark:bg-zinc-900/60 dark:text-orange-300 dark:ring-orange-900/40">
                <Sparkles className="h-3 w-3" />
                Payroll Wizard · {setup.weekLabel}
              </span>
              <DialogTitle className="mt-3 text-2xl font-semibold tracking-tight text-zinc-900 dark:text-white">
                Hi {firstName},
              </DialogTitle>
              <DialogDescription className="mt-1 text-[13.5px] leading-relaxed text-zinc-600 dark:text-zinc-400">
                {summary}
              </DialogDescription>
            </motion.div>

            <motion.div {...enter(1)} className="mt-4 rounded-xl border border-white/70 bg-white/60 p-3 dark:border-zinc-800 dark:bg-zinc-900/40">
              <div className="flex items-baseline justify-between gap-2">
                <span className="text-[12.5px] text-zinc-600 dark:text-zinc-400">
                  {greeting.nextUp ? (
                    <>
                      You&apos;re on{' '}
                      <strong className="font-semibold text-zinc-900 dark:text-white">
                        Step {greeting.nextUp.stepNo} · {greeting.nextUp.label}
                      </strong>
                    </>
                  ) : (
                    'Every setup step is done'
                  )}
                </span>
                <span className="shrink-0 font-mono text-[11px] font-semibold tabular-nums text-zinc-400 dark:text-zinc-500">
                  {setup.doneCount}/{setup.totalCount} done
                </span>
              </div>
              <div className="mt-2.5 flex items-end gap-1" aria-hidden>
                {setup.steps.map((s) => (
                  <div key={s.key} className="flex min-w-0 flex-1 flex-col items-center gap-1">
                    <span
                      className={cn(
                        'block w-full rounded-full',
                        SEGMENT_FILL[s.status],
                        s.key === nextKey ? 'h-2.5' : 'h-1.5 opacity-70',
                      )}
                    />
                    <span
                      className={cn(
                        'font-mono text-[9px] font-semibold leading-none tabular-nums',
                        s.key === nextKey ? 'text-zinc-800 dark:text-zinc-100' : 'text-zinc-400 dark:text-zinc-500',
                      )}
                    >
                      {s.stepNo}
                    </span>
                  </div>
                ))}
              </div>
            </motion.div>
          </div>

          {/* Unfinished — most urgent first */}
          <div className="min-h-0 flex-1 overflow-y-auto border-t border-zinc-200/70 px-6 py-4 dark:border-zinc-800">
            <p className="mb-2.5 text-[10px] font-semibold uppercase tracking-[0.16em] text-zinc-500 dark:text-zinc-400">
              Fix these first
            </p>
            <ul className="space-y-2">
              {greeting.items.map((item, i) => {
                const pill = SETUP_STATUS_PILL[item.status];
                const accent = ITEM_ACCENT[item.status];
                const Icon = item.key === AWAITING_CSV_KEY ? SETUP_STEP_ICON.csv : SETUP_STEP_ICON[item.key];
                return (
                  <motion.li
                    key={item.key}
                    {...enter(i + 2)}
                    className="relative overflow-hidden rounded-xl border border-zinc-200/80 bg-white/80 py-3 pl-4 pr-3 shadow-sm dark:border-zinc-800 dark:bg-zinc-900/60"
                  >
                    <span aria-hidden className={cn('absolute inset-y-0 left-0 w-1', accent.bar)} />
                    <div className="flex items-start gap-3">
                      <span className={cn('mt-0.5 flex h-8 w-8 shrink-0 items-center justify-center rounded-lg ring-1', accent.tile)}>
                        <Icon className="h-4 w-4" />
                      </span>
                      <div className="min-w-0 flex-1">
                        <div className="flex flex-wrap items-center gap-1.5">
                          <span className="text-[10px] font-semibold uppercase tracking-[0.14em] text-zinc-500 dark:text-zinc-400">
                            Step {item.stepNo}
                          </span>
                          <span
                            className={cn(
                              'inline-flex items-center gap-1 rounded-full border px-1.5 py-0.5 text-[9px] font-semibold uppercase tracking-wide',
                              pill.cls,
                            )}
                          >
                            <pill.Icon className="h-2.5 w-2.5" />
                            {pill.label}
                          </span>
                        </div>
                        <p className="mt-1 text-[14px] font-semibold leading-snug text-zinc-900 dark:text-white">{item.headline}</p>
                        <p className="mt-0.5 text-[12.5px] leading-snug text-zinc-600 dark:text-zinc-400">{item.detail}</p>
                      </div>
                      {canJump && item.jumpStep != null && (
                        <Button
                          type="button"
                          size="sm"
                          variant="outline"
                          onClick={() => go(item)}
                          className="shrink-0 gap-1 self-center"
                        >
                          Go to Step {item.jumpStep}
                          <ArrowRight className="h-3.5 w-3.5" />
                        </Button>
                      )}
                    </div>
                  </motion.li>
                );
              })}
            </ul>

            {greeting.done.length > 0 && (
              <motion.div {...enter(greeting.items.length + 2)} className="mt-3 flex flex-wrap items-center gap-1">
                <span className="mr-1 inline-flex items-center gap-1 text-[11px] font-medium text-emerald-700 dark:text-emerald-300">
                  <CheckCircle2 className="h-3.5 w-3.5" /> Done:
                </span>
                {greeting.done.map((s) => (
                  <span
                    key={s.key}
                    className="inline-flex items-center gap-1 rounded-full border border-emerald-200 bg-emerald-50/80 px-2 py-0.5 text-[11px] font-medium text-emerald-800 dark:border-emerald-500/30 dark:bg-emerald-500/10 dark:text-emerald-300"
                  >
                    <span className="font-mono text-[9.5px] opacity-70">{s.stepNo}</span>
                    {s.label}
                  </span>
                ))}
              </motion.div>
            )}

            {!canJump && (
              <p className="mt-3 flex items-start gap-1.5 text-[11.5px] leading-snug text-zinc-500 dark:text-zinc-400">
                <Eye className="mt-0.5 h-3.5 w-3.5 shrink-0" />
                You have view access to the Payroll Wizard — someone with edit access has to make these changes.
              </p>
            )}
          </div>

          {/* Footer */}
          <div className="flex shrink-0 items-center justify-end gap-2 border-t border-zinc-200/70 px-6 py-3.5 dark:border-zinc-800">
            <Button type="button" variant="ghost" onClick={() => setOpen(false)}>
              Later
            </Button>
            <Button
              type="button"
              onClick={() => {
                setOpen(false);
                onOpenWizard();
              }}
              className="gap-1"
            >
              Open Payroll Wizard
              <ArrowRight className="h-3.5 w-3.5" />
            </Button>
          </div>
        </div>
      </DialogContent>
    </Dialog>
  );
}
