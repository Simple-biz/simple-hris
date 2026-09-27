'use client';

import React, { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { AnimatePresence, motion, useReducedMotion } from 'motion/react';
import { AlertTriangle, ArrowRight, CheckCircle2, Lock, RefreshCw, StickyNote } from 'lucide-react';
import { cn } from '@/lib/utils';
import { ATTENTION_PALETTE, type AttentionTone } from '@/components/accounting/hero-stat-row';
import { SETUP_STATUS_PILL, SETUP_STEP_ICON } from '@/components/accounting/wizard-setup-meta';
import type { PayrollReadiness } from '@/lib/payroll/payroll-readiness';
import type { WizardSetupStep } from '@/lib/payroll/wizard-setup-steps';
import {
  READINESS_FRESH_MS,
  readCachedReadiness,
  writeCachedReadiness,
  type StampedReadiness,
} from '@/lib/payroll/readiness-cache';
import {
  buildSpotlightSlides,
  nextSlideKey,
  resolveActiveKey,
  worstSetupStatus,
  type SpotlightSlide,
  type WizardSetupStatus,
} from '@/lib/payroll/wizard-setup-spotlight';

/**
 * Accounting Overview → "Payroll Notes" card: the Payroll Wizard's Steps 1–8
 * setup checklist for the week in view, spotlighting one step at a time and
 * crossfading to the next — open steps first (Kane, 2026-09-26: replaces the
 * New hires + Attrition cards, "the first data they have to see").
 *
 * Read-only, same as the Readiness pane's Wizard Setup tab it mirrors: every
 * row, status, detail and count is `readiness.wizardSetup` exactly as the
 * server derived it — nothing is recomputed here, so the two surfaces cannot
 * disagree. The fix for any row lives on the wizard step it names.
 *
 * Data: `GET /api/payroll-wizard/readiness[?source_file=]`, through the SAME
 * per-week cache entry the FAB's ring and Readiness pane use
 * (`readiness-cache.ts`): painted from cache, revalidated unless younger than
 * 30s, refreshed on focus and every 2 minutes while the page is visible. A
 * background failure keeps what is on screen; a 401/403 drops it and shows the
 * locked state — the route's `payroll_wizard` view grant decides, not this card.
 */

/** How long each spotlight slide holds before crossfading to the next. */
const DWELL_MS = 5200;
/** Background refresh while the page is visible. The readiness snapshot is an
 *  expensive aggregate — this is deliberately slower than the open pane's 30s
 *  poll, which owns the live view once someone is working the wizard. */
const POLL_MS = 120_000;

const useIsoLayoutEffect = typeof window !== 'undefined' ? useLayoutEffect : useEffect;

const TONE_FOR_STATUS: Record<WizardSetupStatus, AttentionTone> = {
  blocked: 'warn',
  attention: 'warn',
  pending: 'info',
  done: 'ok',
};

/** Rail segment fill per status — the pill colours, solid. */
const SEGMENT_FILL: Record<WizardSetupStatus, string> = {
  done: 'bg-emerald-500 dark:bg-emerald-400',
  attention: 'bg-amber-400 dark:bg-amber-400',
  blocked: 'bg-rose-500 dark:bg-rose-400',
  pending: 'bg-sky-400 dark:bg-sky-400',
};

const EASE = [0.22, 1, 0.36, 1] as const;

const SLIDE_VARIANTS = {
  enter: { opacity: 0, y: 14, filter: 'blur(4px)' },
  center: { opacity: 1, y: 0, filter: 'blur(0px)' },
  exit: { opacity: 0, y: -14, filter: 'blur(4px)' },
};
const SLIDE_VARIANTS_REDUCED = {
  enter: { opacity: 0 },
  center: { opacity: 1 },
  exit: { opacity: 0 },
};

type Fault = 'error' | 'denied' | null;

export default function PayrollNotesSetupCard({
  sourceFile,
  onOpenWizard,
  className,
}: {
  /** The Hubstaff upload the Overview is on; null = the server's live week. */
  sourceFile: string | null;
  /** Jump to the Payroll Wizard tab. Omitted → no CTA. */
  onOpenWizard?: () => void;
  className?: string;
}) {
  const reduceMotion = useReducedMotion();

  // Seeded in a layout effect, never in the initialiser: the Accounting shell
  // renders server-side, where sessionStorage does not exist, so a cache read
  // in useState would hydrate differently on the client.
  const [snap, setSnap] = useState<StampedReadiness | null>(null);
  const [fault, setFault] = useState<Fault>(null);
  const [settled, setSettled] = useState(false);
  const snapRef = useRef<StampedReadiness | null>(null);
  const seqRef = useRef(0);
  /** The slide the viewer is on; null = start from the first (most urgent). */
  const [activeKey, setActiveKey] = useState<string | null>(null);

  const load = useCallback(async () => {
    const seq = ++seqRef.current;
    try {
      const qs = sourceFile ? `?source_file=${encodeURIComponent(sourceFile)}` : '';
      const res = await fetch(`/api/payroll-wizard/readiness${qs}`, { cache: 'no-store' });
      if (seq !== seqRef.current) return;
      if (res.status === 401 || res.status === 403) {
        snapRef.current = null;
        setSnap(null);
        setFault('denied');
        return;
      }
      const json = (await res.json().catch(() => null)) as { readiness?: PayrollReadiness } | null;
      if (seq !== seqRef.current) return;
      if (!res.ok || !json?.readiness?.wizardSetup) throw new Error(`readiness ${res.status}`);
      writeCachedReadiness(sourceFile, json.readiness);
      const next = { readiness: json.readiness, at: Date.now() };
      snapRef.current = next;
      setSnap(next);
      setFault(null);
    } catch {
      if (seq !== seqRef.current) return;
      // A blip behind visible steps keeps them (their "as of" stamp stays
      // honest); only a load with nothing to paint reports the failure.
      if (!snapRef.current) setFault('error');
    } finally {
      if (seq === seqRef.current) setSettled(true);
    }
  }, [sourceFile]);

  // Week in view changed (or first mount): paint that week's cached snapshot,
  // then revalidate unless it is only seconds old.
  useIsoLayoutEffect(() => {
    const cached = readCachedReadiness(sourceFile);
    snapRef.current = cached;
    setSnap(cached);
    setFault(null);
    setActiveKey(null);
    if (cached && Date.now() - cached.at < READINESS_FRESH_MS) {
      seqRef.current += 1; // drop any in-flight pull for the previous week
      setSettled(true);
      return;
    }
    setSettled(false);
    void load();
  }, [sourceFile, load]);

  useEffect(() => {
    if (fault === 'denied') return;
    const stale = () => Date.now() - (snapRef.current?.at ?? 0) >= READINESS_FRESH_MS;
    const tick = () => {
      if (document.visibilityState === 'visible') void load();
    };
    const onReturn = () => {
      if (document.visibilityState === 'visible' && stale()) void load();
    };
    const id = window.setInterval(tick, POLL_MS);
    document.addEventListener('visibilitychange', onReturn);
    window.addEventListener('focus', onReturn);
    return () => {
      window.clearInterval(id);
      document.removeEventListener('visibilitychange', onReturn);
      window.removeEventListener('focus', onReturn);
    };
  }, [load, fault]);

  // ── Spotlight rotation ────────────────────────────────────────────────────
  const setup = snap?.readiness.wizardSetup ?? null;
  const slides = useMemo(() => (setup ? buildSpotlightSlides(setup.steps) : []), [setup]);
  const currentKey = resolveActiveKey(slides, activeKey);
  const current = slides.find((s) => s.key === currentKey) ?? null;

  // Hovering or focusing the card holds the current slide so it can be read.
  const [hovered, setHovered] = useState(false);
  const [focused, setFocused] = useState(false);
  const paused = hovered || focused;

  useEffect(() => {
    if (paused || slides.length <= 1) return;
    const t = window.setTimeout(() => setActiveKey(nextSlideKey(slides, currentKey)), DWELL_MS);
    return () => window.clearTimeout(t);
  }, [paused, slides, currentKey]);

  const loading = !snap && !fault && !settled;
  const steps = setup?.steps ?? [];
  const openCount = steps.filter((s) => s.status !== 'done').length;
  const tone: AttentionTone = setup ? TONE_FOR_STATUS[worstSetupStatus(steps)] : 'neutral';
  const palette = ATTENTION_PALETTE[tone];

  /** Which slide a rail segment jumps to: its own, or the recap it sits in. */
  const slideKeyForStep = (key: WizardSetupStep['key']): string | null =>
    slides.find((s) => (s.kind === 'step' ? s.key === key : s.done.some((d) => d.key === key)))?.key ?? null;

  return (
    <section
      aria-label="Payroll Notes — wizard setup steps"
      onMouseEnter={() => setHovered(true)}
      onMouseLeave={() => setHovered(false)}
      // Keyboard focus holds the slide; a mouse click on a rail segment must
      // not leave the card frozen after the pointer moves away.
      onFocus={(e) => {
        if ((e.target as HTMLElement).matches?.(':focus-visible')) setFocused(true);
      }}
      onBlur={(e) => {
        if (!e.currentTarget.contains(e.relatedTarget as Node | null)) setFocused(false);
      }}
      className={cn(
        'group relative flex w-full flex-col overflow-hidden rounded-2xl border p-5 text-left shadow-sm transition-colors duration-300',
        palette.ring,
        palette.surface,
        className,
      )}
    >
      <div
        aria-hidden
        className={cn(
          'pointer-events-none absolute -right-12 -top-12 h-32 w-32 rounded-full opacity-50 blur-3xl transition-opacity duration-500 group-hover:opacity-80',
          palette.blob,
        )}
      />

      {/* Header — same anatomy as the AttentionCard beside it */}
      <div className="relative mb-4 flex items-start justify-between gap-3">
        <div className="flex min-w-0 items-center gap-2">
          <span
            className={cn(
              'flex h-8 w-8 shrink-0 items-center justify-center rounded-lg [&_svg]:h-4 [&_svg]:w-4',
              palette.iconTile,
            )}
          >
            <StickyNote />
          </span>
          <span className={cn('truncate text-[10px] font-semibold uppercase tracking-[0.16em]', palette.label)}>
            Payroll Notes · Steps 1–8
          </span>
        </div>
        {setup?.weekLabel && (
          <span className={cn('shrink-0 rounded-full px-2 py-0.5 text-[10px] font-medium tracking-normal', palette.tag)}>
            {setup.weekLabel}
          </span>
        )}
      </div>

      {fault === 'denied' ? (
        <CardNote icon={<Lock className="h-4 w-4" />} title="Payroll Wizard access needed">
          This card reads the wizard&apos;s setup checklist, which needs the Payroll Wizard view grant.
        </CardNote>
      ) : fault === 'error' && !setup ? (
        <CardNote icon={<AlertTriangle className="h-4 w-4" />} title="Couldn't load this week's steps">
          <button
            type="button"
            onClick={() => {
              setFault(null);
              setSettled(false);
              void load();
            }}
            className="mt-1 inline-flex items-center gap-1 text-xs font-semibold text-zinc-800 underline-offset-2 hover:underline focus:outline-none focus-visible:ring-2 focus-visible:ring-orange-500/40 dark:text-zinc-200"
          >
            <RefreshCw className="h-3 w-3" /> Try again
          </button>
        </CardNote>
      ) : loading || !setup ? (
        <SetupSkeleton />
      ) : (
        <>
          <div className="relative grid gap-4 sm:grid-cols-[minmax(0,11rem)_minmax(0,1fr)] sm:gap-5">
            {/* Left — progress + the step rail (doubles as the slide picker) */}
            <div className="flex min-w-0 flex-col">
              <div className="flex items-baseline gap-1">
                <span className={cn('font-mono text-4xl font-bold leading-none tracking-tight tabular-nums', palette.valueText)}>
                  {setup.doneCount}
                </span>
                <span className="font-mono text-lg font-semibold text-zinc-400 dark:text-zinc-500">/{setup.totalCount}</span>
                <span className="ml-1 font-sans text-sm font-medium text-zinc-500 dark:text-zinc-400">done</span>
              </div>
              <p className="mt-2 text-[12.5px] leading-relaxed text-zinc-600 dark:text-zinc-400">
                {openCount === 0 ? (
                  <>Every setup step is done.</>
                ) : (
                  <>
                    <strong className="text-zinc-700 dark:text-zinc-300">{openCount}</strong>{' '}
                    {openCount === 1 ? 'step' : 'steps'} still open
                  </>
                )}
              </p>
              <div className="mt-3 flex items-end gap-1" role="group" aria-label="Setup steps">
                {steps.map((s) => {
                  const target = slideKeyForStep(s.key);
                  const active = target != null && target === currentKey;
                  return (
                    <button
                      key={s.key}
                      type="button"
                      onClick={() => target && setActiveKey(target)}
                      aria-label={`Step ${s.stepNo} · ${s.label} — ${SETUP_STATUS_PILL[s.status].label}`}
                      aria-current={active ? 'true' : undefined}
                      title={`Step ${s.stepNo} · ${s.label} — ${s.detail}`}
                      className="group/seg flex min-w-0 flex-1 flex-col items-center gap-1 rounded focus:outline-none focus-visible:ring-2 focus-visible:ring-orange-500/40"
                    >
                      <span
                        className={cn(
                          'block w-full rounded-full transition-all duration-300',
                          SEGMENT_FILL[s.status],
                          active ? 'h-2.5 opacity-100' : 'h-1.5 opacity-60 group-hover/seg:opacity-90',
                        )}
                      />
                      <span
                        className={cn(
                          'font-mono text-[9px] font-semibold leading-none tabular-nums transition-colors',
                          active ? 'text-zinc-800 dark:text-zinc-100' : 'text-zinc-400 dark:text-zinc-500',
                        )}
                      >
                        {s.stepNo}
                      </span>
                    </button>
                  );
                })}
              </div>
            </div>

            {/* Right — the spotlight: one slide at a time, crossfading */}
            <div
              // Silent while it rotates on its own (a 5s announcement loop is
              // noise); announces once the viewer holds or picks a slide.
              aria-live={paused ? 'polite' : 'off'}
              className="relative h-[7.25rem] overflow-hidden rounded-xl border border-white/70 bg-white/65 backdrop-blur-sm dark:border-zinc-800/80 dark:bg-zinc-900/50"
            >
              <AnimatePresence initial={false}>
                {current && (
                  <motion.div
                    key={current.key}
                    variants={reduceMotion ? SLIDE_VARIANTS_REDUCED : SLIDE_VARIANTS}
                    initial="enter"
                    animate="center"
                    exit="exit"
                    transition={{ duration: reduceMotion ? 0.2 : 0.42, ease: EASE }}
                    className="absolute inset-0 p-3.5"
                  >
                    <SpotlightBody slide={current} total={setup.totalCount} />
                  </motion.div>
                )}
              </AnimatePresence>
            </div>
          </div>

          {/* A newer pay week closed with no CSV — the only mention of the next
              cycle, worded so it can't be mistaken for the week in view. */}
          {setup.awaitingWeekLabel && (
            <div className="relative mt-3 flex items-start gap-1.5 rounded-lg border border-amber-200 bg-amber-50/70 px-2 py-1.5 text-[11px] text-amber-800 dark:border-amber-900/50 dark:bg-amber-950/25 dark:text-amber-300">
              <AlertTriangle className="mt-0.5 h-3 w-3 shrink-0" />
              <span>
                <span className="font-semibold">{setup.awaitingWeekLabel}</span> has closed with no Hubstaff CSV yet —
                upload it on Step 1 to start that cycle.
              </span>
            </div>
          )}
        </>
      )}

      {(onOpenWizard || snap) && fault !== 'denied' && (
        <div className="relative mt-auto flex items-center justify-between gap-3 pt-4">
          {onOpenWizard ? (
            <button
              type="button"
              onClick={onOpenWizard}
              className={cn(
                'inline-flex items-center gap-1 rounded text-xs font-semibold focus:outline-none focus-visible:ring-2 focus-visible:ring-orange-500/40',
                palette.cta,
              )}
            >
              Open Payroll Wizard
              <ArrowRight className="h-3.5 w-3.5 transition-transform duration-300 group-hover:translate-x-0.5" />
            </button>
          ) : (
            <span />
          )}
          {snap && (
            <span className="text-[10.5px] text-zinc-400 dark:text-zinc-500" title={new Date(snap.at).toLocaleString('en-US')}>
              as of {new Date(snap.at).toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' })}
            </span>
          )}
        </div>
      )}
    </section>
  );
}

function SpotlightBody({ slide, total }: { slide: SpotlightSlide; total: number }) {
  if (slide.kind === 'recap') {
    return (
      <div className="flex h-full flex-col">
        <div className="flex items-center justify-between gap-2">
          <span className="inline-flex items-center gap-1.5 text-[10px] font-semibold uppercase tracking-[0.14em] text-emerald-700 dark:text-emerald-300">
            <CheckCircle2 className="h-3.5 w-3.5" />
            Done so far
          </span>
          <span className="font-mono text-[10.5px] font-semibold tabular-nums text-zinc-400 dark:text-zinc-500">
            {slide.done.length} of {total}
          </span>
        </div>
        <div className="mt-2 flex max-h-[4.1rem] flex-wrap gap-1 overflow-hidden">
          {slide.done.map((s) => (
            <span
              key={s.key}
              className="inline-flex items-center gap-1 rounded-full border border-emerald-200 bg-emerald-50/80 px-2 py-0.5 text-[11px] font-medium text-emerald-800 dark:border-emerald-500/30 dark:bg-emerald-500/10 dark:text-emerald-300"
            >
              <span className="font-mono text-[9.5px] opacity-70">{s.stepNo}</span>
              {s.label}
            </span>
          ))}
        </div>
      </div>
    );
  }

  const { step } = slide;
  const pill = SETUP_STATUS_PILL[step.status];
  const StepIcon = SETUP_STEP_ICON[step.key];
  return (
    <div className="flex h-full flex-col">
      <div className="flex items-center justify-between gap-2">
        <span className="inline-flex min-w-0 items-center gap-1.5 text-[10px] font-semibold uppercase tracking-[0.14em] text-zinc-500 dark:text-zinc-400">
          <StepIcon className="h-3.5 w-3.5 shrink-0" />
          <span className="truncate">
            Step {step.stepNo}
            {slide.openIndex != null && (
              <span className="normal-case tracking-normal text-zinc-400 dark:text-zinc-500">
                {' '}· {slide.openIndex} of {slide.openTotal} open
              </span>
            )}
          </span>
        </span>
        <span
          className={cn(
            'inline-flex shrink-0 items-center gap-1 rounded-full border px-1.5 py-0.5 text-[9px] font-semibold uppercase tracking-wide',
            pill.cls,
          )}
        >
          <pill.Icon className="h-2.5 w-2.5" />
          {pill.label}
        </span>
      </div>
      <p className="mt-1.5 truncate text-[15px] font-semibold tracking-tight text-zinc-900 dark:text-white">{step.label}</p>
      <p className="mt-0.5 line-clamp-2 text-[12.5px] leading-snug text-zinc-600 dark:text-zinc-400" title={step.detail}>
        {step.detail}
      </p>
    </div>
  );
}

function CardNote({ icon, title, children }: { icon: React.ReactNode; title: string; children: React.ReactNode }) {
  return (
    <div className="relative flex items-start gap-2.5 rounded-xl border border-zinc-200/80 bg-white/60 p-3.5 dark:border-zinc-800 dark:bg-zinc-900/40">
      <span className="mt-0.5 text-zinc-500 dark:text-zinc-400">{icon}</span>
      <div className="min-w-0">
        <p className="text-sm font-semibold text-zinc-800 dark:text-zinc-100">{title}</p>
        <div className="mt-0.5 text-[12.5px] leading-relaxed text-zinc-600 dark:text-zinc-400">{children}</div>
      </div>
    </div>
  );
}

function SetupSkeleton() {
  return (
    <div className="relative grid gap-4 sm:grid-cols-[minmax(0,11rem)_minmax(0,1fr)] sm:gap-5" aria-busy="true">
      <span className="sr-only">Loading this week&apos;s setup steps…</span>
      <div className="space-y-3">
        <div className="h-9 w-20 animate-pulse rounded-md bg-zinc-200/80 dark:bg-zinc-800" />
        <div className="h-3 w-28 animate-pulse rounded bg-zinc-200/80 dark:bg-zinc-800" />
        <div className="flex gap-1">
          {Array.from({ length: 7 }).map((_, i) => (
            <div key={i} className="h-1.5 flex-1 animate-pulse rounded-full bg-zinc-200/80 dark:bg-zinc-800" />
          ))}
        </div>
      </div>
      <div className="h-[7.25rem] animate-pulse rounded-xl bg-zinc-200/60 dark:bg-zinc-800/60" />
    </div>
  );
}
