'use client';

/**
 * "Send to OMS" — the small modal that carries the loading (Kane, 2026-09-26: "I want
 * the loading not to be in the button but in a small modal pushing the data smoothly
 * animated").
 *
 * What the motion is allowed to claim (the step-load-progress rule, applied here):
 *   - While the request is out, rows stream HRIS → OMS and the bar eases toward 90% on
 *     an ESTIMATE (`predictedProgress`). The estimate never reaches 100%.
 *   - Only OMS's ack takes the bar to 100% and puts a tick on each row. There is one
 *     insert on the server, all rows or none, so the ticks land together (staggered for
 *     the eye) — never one at a time as if some had arrived and others had not.
 *   - A failure turns the bar rose, sends every row back to queued, and names the reason.
 * Not dismissable while sending. Reduced motion ⇒ crossfades only, no streaming dots.
 *
 * Display only. What is sent is decided by the server (`/api/orphanage-pay/oms/return`),
 * rebuilt from the saved carriers; this modal shows that server-built preview.
 */

import { useEffect, useMemo, type ReactNode } from 'react';
import { AnimatePresence, animate, motion, useMotionValue, useReducedMotion, useTransform } from 'motion/react';
import { AlertTriangle, Building2, CheckCircle2, CloudUpload, Database, Loader2, RotateCcw, XCircle } from 'lucide-react';

import { Button } from '@/components/ui/button';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import AnimatedNumber from '@/components/payroll-clerk/AnimatedNumber';
import { cn } from '@/lib/utils';
import { formatPHP } from '@/lib/format-php';
import { predictedProgress } from '@/lib/payroll/step-load-prediction';
import type { OmsReturnRow } from '@/lib/oms/oms-return';

import type { OmsReturnInfo, OmsReturnState } from './use-oms-return';

const EASE = [0.22, 1, 0.36, 1] as const;

const fmtH = (n: number) => (Number.isInteger(n) ? String(n) : n.toFixed(2));

function ago(iso: string | null): string | null {
  if (!iso) return null;
  const t = Date.parse(iso);
  if (!Number.isFinite(t)) return null;
  const m = Math.max(0, Math.round((Date.now() - t) / 60_000));
  if (m < 1) return 'just now';
  if (m < 60) return `${m} min ago`;
  const h = Math.round(m / 60);
  if (h < 48) return `${h} h ago`;
  return `${Math.round(h / 24)} d ago`;
}

const VERDICT_CHIP: Record<OmsReturnRow['verdict'], { label: string; cls: string } | null> = {
  ok: null,
  unverifiable: { label: 'entered by hand', cls: 'border-zinc-200 bg-zinc-50 text-zinc-600 dark:border-zinc-700 dark:bg-zinc-800/60 dark:text-zinc-300' },
  amount_mismatch: { label: "doesn't match its hours", cls: 'border-amber-200 bg-amber-50 text-amber-800 dark:border-amber-900/50 dark:bg-amber-950/30 dark:text-amber-300' },
  ot_underpriced: { label: 'OT below regular', cls: 'border-amber-200 bg-amber-50 text-amber-800 dark:border-amber-900/50 dark:bg-amber-950/30 dark:text-amber-300' },
};

type Flow = 'idle' | 'flowing' | 'done' | 'failed';

/**
 * HRIS ──•──•──▶ OMS. The connector IS the progress bar: at rest it is a thin rail
 * between the two systems (a separate empty track under it read as a stalled loader),
 * while the request is out it fills on the estimate (never past 90–99%), and only
 * OMS's ack fills it. Dots stream only while the request is out.
 */
function TransferStrip({ flow, phase, rows, reduceMotion }: { flow: Flow; phase: OmsReturnState['phase']; rows: number; reduceMotion: boolean }) {
  const mv = useMotionValue(0);
  const width = useTransform(mv, (v) => `${Math.max(0, Math.min(1, v)) * 100}%`);
  const sending = phase.kind === 'sending';
  const startedAt = phase.kind === 'sending' ? phase.startedAt : null;

  useEffect(() => {
    if (!sending || startedAt == null) return;
    const estimate = Math.min(8000, Math.max(700, 700 + rows * 6));
    let raf = 0;
    // Written to the motion value from rAF, never React state: 60 re-renders a second
    // while the request is out is what makes a bar stutter.
    const tick = () => {
      mv.set(predictedProgress(performance.now() - startedAt, estimate));
      raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, [sending, startedAt, rows, mv]);

  useEffect(() => {
    if (phase.kind === 'sent') {
      const c = animate(mv, 1, reduceMotion ? { duration: 0.1 } : { type: 'spring', stiffness: 140, damping: 22 });
      return () => c.stop();
    }
    if (phase.kind === 'ready' || phase.kind === 'preparing') mv.set(0);
  }, [phase.kind, mv, reduceMotion]);

  const trackTone = flow === 'failed' ? 'bg-rose-100 dark:bg-rose-950/60' : 'bg-zinc-200 dark:bg-zinc-700/80';
  const fillTone =
    flow === 'failed' ? 'bg-rose-500'
    : flow === 'done' ? 'bg-gradient-to-r from-emerald-500 to-teal-500'
    : 'bg-gradient-to-r from-sky-500 to-cyan-500';
  return (
    <div className="flex shrink-0 items-center gap-3 px-1">
      <span aria-hidden className="inline-flex items-center gap-1.5 rounded-lg border border-zinc-200 bg-white px-2.5 py-1.5 text-[11px] font-semibold uppercase tracking-wide text-zinc-700 shadow-sm dark:border-zinc-700 dark:bg-zinc-900 dark:text-zinc-200">
        <Building2 className="h-3.5 w-3.5 text-zinc-500" /> HRIS
      </span>
      <div className="relative h-5 flex-1">
        <div
          role="progressbar"
          aria-label="Send progress"
          className={cn('absolute inset-x-0 top-1/2 h-1 -translate-y-1/2 overflow-hidden rounded-full transition-colors duration-500', trackTone)}
        >
          <motion.div className={cn('absolute inset-y-0 left-0 rounded-full transition-colors duration-300', fillTone)} style={{ width }} />
          {sending && !reduceMotion && (
            <motion.div
              className="absolute inset-y-0 w-1/3 bg-gradient-to-r from-transparent via-white/45 to-transparent"
              initial={{ x: '-100%' }}
              animate={{ x: '350%' }}
              transition={{ duration: 1.1, repeat: Infinity, ease: 'easeInOut' }}
            />
          )}
        </div>
        {flow === 'flowing' && !reduceMotion &&
          [0, 1, 2, 3].map((i) => (
            <motion.span
              key={i}
              aria-hidden
              className="absolute top-1/2 h-2 w-2 -translate-y-1/2 rounded-full bg-sky-500 shadow-[0_0_0_3px_rgba(14,165,233,0.18)]"
              initial={{ left: '0%', opacity: 0 }}
              animate={{ left: ['0%', '100%'], opacity: [0, 1, 1, 0] }}
              transition={{ duration: 1.3, repeat: Infinity, ease: 'easeInOut', delay: i * 0.32 }}
            />
          ))}
      </div>
      <span
        aria-hidden
        className={cn(
          'relative inline-flex items-center gap-1.5 rounded-lg border px-2.5 py-1.5 text-[11px] font-semibold uppercase tracking-wide shadow-sm transition-colors duration-500',
          flow === 'done'
            ? 'border-emerald-300 bg-emerald-50 text-emerald-700 dark:border-emerald-800 dark:bg-emerald-950/40 dark:text-emerald-300'
            : flow === 'failed'
              ? 'border-rose-300 bg-rose-50 text-rose-700 dark:border-rose-900 dark:bg-rose-950/40 dark:text-rose-300'
              : 'border-zinc-200 bg-white text-zinc-700 dark:border-zinc-700 dark:bg-zinc-900 dark:text-zinc-200',
        )}
      >
        <AnimatePresence mode="wait" initial={false}>
          <motion.span
            key={flow === 'done' ? 'done' : 'db'}
            initial={reduceMotion ? { opacity: 0 } : { opacity: 0, scale: 0.6 }}
            animate={{ opacity: 1, scale: 1 }}
            exit={reduceMotion ? { opacity: 0 } : { opacity: 0, scale: 0.6 }}
            transition={{ duration: 0.18, ease: EASE }}
            className="inline-flex"
          >
            {/* Rose is this modal's failure colour, so the icon is neutral until a send fails. */}
            {flow === 'done' ? <CheckCircle2 className="h-3.5 w-3.5" /> : <Database className={cn('h-3.5 w-3.5', flow !== 'failed' && 'text-zinc-500')} />}
          </motion.span>
        </AnimatePresence>
        OMS
      </span>
    </div>
  );
}

function Stat({ label, value, formatter, tone }: { label: string; value: number; formatter?: (n: number) => string; tone?: 'violet' }) {
  return (
    <div className="min-w-0 rounded-lg border border-zinc-200 bg-zinc-50/70 px-2.5 py-2 dark:border-zinc-800 dark:bg-zinc-900/40">
      <div className="truncate text-[10px] font-semibold uppercase tracking-wide text-zinc-500 dark:text-zinc-400">{label}</div>
      {/* Never truncated: a figure with its tail cut off reads as a different figure. The grid gives Amount the room. */}
      <AnimatedNumber
        value={value}
        formatter={formatter}
        className={cn(
          'mt-0.5 block whitespace-nowrap font-mono text-[15px] font-semibold tabular-nums',
          tone === 'violet' ? 'text-violet-700 dark:text-violet-300' : 'text-zinc-900 dark:text-white',
        )}
      />
    </div>
  );
}

function Notices({ info }: { info: OmsReturnInfo }) {
  const p = info.preview;
  const flagged = p.verdictCounts.amount_mismatch + p.verdictCounts.ot_underpriced;
  const items: Array<{ tone: 'amber' | 'zinc' | 'rose'; text: ReactNode }> = [];
  if (!info.configured || !info.tableReady) {
    // The reason is the server's own sentence ("Sending to OMS is not set up — set …"), so the
    // lead must not repeat it.
    items.push({ tone: 'amber', text: <><span className="font-semibold">Can&apos;t send yet.</span> {info.reason}</> });
  }
  if (p.rows.length === 0) items.push({ tone: 'zinc', text: 'Nothing is locked in for this period — there is nothing to send.' });
  if (p.rows.length > 0 && !p.cycleLocked) {
    items.push({ tone: 'zinc', text: <>Payroll isn&apos;t locked yet, so amounts can still change. Every row goes marked <span className="font-mono">cycle_locked = false</span>.</> });
  }
  if (flagged > 0) {
    items.push({ tone: 'amber', text: `${flagged} ${flagged === 1 ? 'amount does' : 'amounts do'} not match ${flagged === 1 ? 'its' : 'their'} own hours × rates. Sent as paid and flagged — Re-price on the step first if they are wrong.` });
  }
  if (p.verdictCounts.unverifiable > 0) {
    items.push({ tone: 'zinc', text: `${p.verdictCounts.unverifiable} ${p.verdictCounts.unverifiable === 1 ? 'amount was' : 'amounts were'} entered by hand — sent without hours, because there are none on record.` });
  }
  if (p.recordsWithoutAmount.length > 0) {
    items.push({ tone: 'rose', text: `${p.recordsWithoutAmount.length} ${p.recordsWithoutAmount.length === 1 ? 'person has' : 'people have'} hours on record but no amount on the column — they pay ₱0 today and are NOT sent. Fix them on the step first.` });
  }
  if (info.latest) {
    items.push({
      tone: 'zinc',
      text: <>OMS already holds a send for this week — {ago(info.latest.pushedAt) ?? info.latest.pushedAt} by {info.latest.pushedBy}, {info.latest.people} {info.latest.people === 1 ? 'person' : 'people'} · {formatPHP(info.latest.amountPhp)}. Sending adds a newer copy; OMS reads the newest.</>,
    });
  } else if (info.latestError) {
    items.push({ tone: 'amber', text: `Could not read what OMS already holds — ${info.latestError}` });
  }
  if (items.length === 0) return null;
  const tones = {
    amber: 'border-amber-200 bg-amber-50 text-amber-900 dark:border-amber-900/50 dark:bg-amber-950/30 dark:text-amber-200',
    zinc: 'border-zinc-200 bg-zinc-50 text-zinc-700 dark:border-zinc-800 dark:bg-zinc-900/40 dark:text-zinc-300',
    rose: 'border-rose-200 bg-rose-50 text-rose-800 dark:border-rose-900/50 dark:bg-rose-950/30 dark:text-rose-300',
  } as const;
  return (
    <ul className="flex shrink-0 flex-col gap-1.5">
      {items.map((it, i) => (
        <li key={i} className={cn('flex items-start gap-2 rounded-lg border px-2.5 py-1.5 text-[12px] leading-snug', tones[it.tone])}>
          <AlertTriangle className="mt-0.5 h-3.5 w-3.5 shrink-0 opacity-70" />
          <span className="min-w-0">{it.text}</span>
        </li>
      ))}
    </ul>
  );
}

function RowList({ rows, phase, reduceMotion }: { rows: OmsReturnRow[]; phase: OmsReturnState['phase']['kind']; reduceMotion: boolean }) {
  return (
    // No fixed max-height (responsive-design.md § Dialogs and modals): the list takes what the
    // capped dialog leaves and scrolls; it shrinks to its floor on a short window so the
    // footer stays reachable, and the body behind it scrolls past that.
    <div className="min-h-[7.5rem] overflow-y-auto overscroll-contain rounded-lg border border-zinc-200 dark:border-zinc-800">
      <ul className="divide-y divide-zinc-100 dark:divide-zinc-800/80">
        {rows.map((r, i) => {
          const chip = VERDICT_CHIP[r.verdict];
          const sending = phase === 'sending';
          const sent = phase === 'sent';
          return (
            <motion.li
              key={r.hrisEmail}
              initial={reduceMotion ? { opacity: 0 } : { opacity: 0, y: 4 }}
              animate={
                sending && !reduceMotion
                  ? { opacity: [1, 0.55, 1], x: [0, 3, 0], y: 0 }
                  : { opacity: 1, x: 0, y: 0 }
              }
              transition={
                sending && !reduceMotion
                  ? { duration: 1.1, repeat: Infinity, ease: 'easeInOut', delay: (i % 12) * 0.08 }
                  : { duration: reduceMotion ? 0.1 : 0.22, ease: EASE, delay: reduceMotion ? 0 : Math.min(i, 20) * 0.02 }
              }
              className="flex items-center gap-2.5 px-2.5 py-1.5 text-[12px]"
            >
              <span className="relative flex h-4 w-4 shrink-0 items-center justify-center">
                <AnimatePresence mode="wait" initial={false}>
                  {sent ? (
                    <motion.span
                      key="ok"
                      initial={reduceMotion ? { opacity: 0 } : { opacity: 0, scale: 0.4 }}
                      animate={{ opacity: 1, scale: 1 }}
                      transition={{ duration: 0.2, ease: EASE, delay: reduceMotion ? 0 : Math.min(i, 30) * 0.025 }}
                      className="absolute inset-0 flex items-center justify-center"
                    >
                      <CheckCircle2 className="h-4 w-4 text-emerald-500" />
                    </motion.span>
                  ) : (
                    <motion.span
                      key="dot"
                      initial={{ opacity: 0 }}
                      animate={{ opacity: 1 }}
                      exit={{ opacity: 0 }}
                      className={cn('h-1.5 w-1.5 rounded-full', sending ? 'bg-sky-500' : 'bg-zinc-300 dark:bg-zinc-600')}
                    />
                  )}
                </AnimatePresence>
              </span>
              <div className="min-w-0 flex-1">
                <div className="flex items-center gap-1.5">
                  <span className="truncate font-medium text-zinc-800 dark:text-zinc-100">{r.name ?? r.hrisEmail}</span>
                  {chip && <span className={cn('shrink-0 rounded-full border px-1.5 text-[10px] font-medium', chip.cls)}>{chip.label}</span>}
                </div>
                <div className="truncate text-[11px] text-zinc-500 dark:text-zinc-400">{r.workEmail}</div>
              </div>
              <div className="shrink-0 text-right font-mono tabular-nums">
                <div className="font-semibold text-zinc-900 dark:text-white">{formatPHP(r.amountPhp)}</div>
                <div className="text-[10.5px] text-zinc-500 dark:text-zinc-400">
                  {r.regularHours == null ? (
                    'no hours on record'
                  ) : (
                    <>
                      {fmtH(r.regularHours)} reg
                      {(r.otHours ?? 0) > 0 && <span className="text-violet-600 dark:text-violet-400"> · {fmtH(r.otHours ?? 0)} OT</span>}
                    </>
                  )}
                </div>
              </div>
            </motion.li>
          );
        })}
      </ul>
    </div>
  );
}

export default function OrphanageOmsReturnDialog({
  state,
  periodLabel,
  aliases,
}: {
  state: OmsReturnState;
  periodLabel: string;
  /** hrisEmail → OMS's own address, from the current pull. Relabel only. */
  aliases: Record<string, string>;
}) {
  const reduceMotion = useReducedMotion() ?? false;
  const { phase } = state;
  const info = phase.kind === 'ready' || phase.kind === 'sending' || phase.kind === 'sent' ? phase.info : phase.kind === 'error' ? phase.info : null;
  const rows = useMemo(() => {
    const base = info?.preview.rows ?? [];
    // Show the address that will actually go: OMS's own, where the pull carried it.
    return base.map((r) => (aliases[r.hrisEmail] ? { ...r, workEmail: aliases[r.hrisEmail]! } : r));
  }, [info, aliases]);
  const totals = info?.preview.totals ?? { people: 0, amountPhp: 0, regularHours: 0, otHours: 0 };
  const sending = phase.kind === 'sending';
  const canSend =
    !!info && info.configured && info.tableReady && rows.length > 0 &&
    (phase.kind === 'ready' || (phase.kind === 'error' && phase.during === 'send'));

  const flow: Flow =
    phase.kind === 'sending' ? 'flowing'
    : phase.kind === 'sent' ? 'done'
    : phase.kind === 'error' && phase.during === 'send' ? 'failed'
    : 'idle';

  const title =
    phase.kind === 'sending' ? 'Sending to OMS…'
    : phase.kind === 'sent' ? 'Sent to OMS'
    : phase.kind === 'error' ? "Couldn't send to OMS"
    : 'Send to OMS';
  const description =
    phase.kind === 'preparing' ? `Gathering what is locked in for ${periodLabel}…`
    : phase.kind === 'sending' ? `Writing ${rows.length} ${rows.length === 1 ? 'row' : 'rows'} in one go — all of them land, or none do.`
    : phase.kind === 'sent' ? `${phase.result.sent} ${phase.result.sent === 1 ? 'row' : 'rows'} · ${formatPHP(phase.result.totalPhp)} are in OMS for ${periodLabel}${phase.result.cycleLocked ? '' : ' (marked not final — payroll was not locked)'}.`
    : phase.kind === 'error' ? phase.reason
    : `Each person's regular and overtime hours and the amount the HRIS pays them for ${periodLabel}, so OMS can report it to accounting.`;

  return (
    <Dialog
      open={phase.kind !== 'closed'}
      onOpenChange={(o) => {
        if (!o && !sending) state.close();
      }}
    >
      {/* Width at `sm:` — a base-only max-w-* loses to the primitive's sm:max-w-sm (384px), which
          is what clipped the Amount tile, and it would also drop the phone side gutter. */}
      <DialogContent
        className="flex max-h-[calc(100dvh-1.5rem)] flex-col gap-3 overflow-hidden sm:max-h-[92dvh] sm:max-w-[520px]"
        showCloseButton={!sending}
      >
        <DialogHeader className="shrink-0 pr-8">
          <DialogTitle className="flex items-center gap-2 text-base">
            {phase.kind === 'sending' || phase.kind === 'preparing' ? (
              <Loader2 className="h-4 w-4 animate-spin text-sky-600" />
            ) : phase.kind === 'sent' ? (
              <CheckCircle2 className="h-4 w-4 text-emerald-600" />
            ) : phase.kind === 'error' ? (
              <XCircle className="h-4 w-4 text-rose-600" />
            ) : (
              <CloudUpload className="h-4 w-4 text-sky-600" />
            )}
            {title}
          </DialogTitle>
          <DialogDescription className={cn('text-xs leading-relaxed', phase.kind === 'error' && 'text-rose-700 dark:text-rose-300')}>
            {description}
          </DialogDescription>
        </DialogHeader>

        <TransferStrip flow={flow} phase={phase} rows={rows.length} reduceMotion={reduceMotion} />

        <AnimatePresence mode="wait" initial={false}>
          {phase.kind === 'preparing' || (phase.kind === 'error' && !info) ? (
            <motion.div
              key="skeleton"
              initial={{ opacity: 0 }}
              animate={{ opacity: 1 }}
              exit={{ opacity: 0 }}
              transition={{ duration: 0.15 }}
              className="flex flex-col gap-1.5"
            >
              {phase.kind === 'preparing' &&
                [0, 1, 2, 3].map((i) => (
                  <div key={i} className="h-9 animate-pulse rounded-lg bg-zinc-100 motion-reduce:animate-none dark:bg-zinc-800/70" />
                ))}
            </motion.div>
          ) : info ? (
            <motion.div
              key="body"
              initial={reduceMotion ? { opacity: 0 } : { opacity: 0, y: 4 }}
              animate={{ opacity: 1, y: 0 }}
              exit={{ opacity: 0 }}
              transition={{ duration: 0.2, ease: EASE }}
              className="flex min-h-0 flex-1 flex-col gap-3 overflow-y-auto overscroll-contain"
            >
              {/* Amount gets the wide column: ₱ + seven figures + centavos must never be cut. */}
              <div className="grid shrink-0 grid-cols-2 gap-2 sm:grid-cols-[repeat(3,minmax(0,1fr))_minmax(0,1.7fr)]">
                <Stat label="People" value={totals.people} />
                <Stat label="Regular h" value={totals.regularHours} formatter={(n) => n.toFixed(2)} />
                <Stat label="OT h" value={totals.otHours} formatter={(n) => n.toFixed(2)} tone="violet" />
                <Stat label="Amount" value={totals.amountPhp} formatter={(n) => formatPHP(n)} />
              </div>
              {(phase.kind === 'ready' || phase.kind === 'error') && <Notices info={info} />}
              {rows.length > 0 && <RowList rows={rows} phase={phase.kind} reduceMotion={reduceMotion} />}
            </motion.div>
          ) : null}
        </AnimatePresence>

        <DialogFooter className="shrink-0 gap-2">
          {phase.kind === 'sent' ? (
            <Button onClick={state.close} className="bg-emerald-600 text-white hover:bg-emerald-700">
              Done
            </Button>
          ) : sending ? (
            <span className="text-[11.5px] text-zinc-500 dark:text-zinc-400">Keep this open — it closes itself when OMS answers.</span>
          ) : (
            <>
              <Button variant="outline" onClick={state.close}>
                {phase.kind === 'error' ? 'Close' : 'Cancel'}
              </Button>
              {phase.kind === 'error' && phase.during === 'prepare' ? (
                <Button onClick={state.open} className="gap-2 bg-sky-600 text-white hover:bg-sky-700">
                  <RotateCcw className="h-4 w-4" /> Try again
                </Button>
              ) : (
                <Button
                  onClick={() => void state.send(aliases)}
                  disabled={!canSend}
                  className="gap-2 bg-sky-600 text-white transition-colors hover:bg-sky-700 disabled:opacity-60"
                >
                  {phase.kind === 'error' ? <RotateCcw className="h-4 w-4" /> : <CloudUpload className="h-4 w-4" />}
                  {phase.kind === 'error' ? 'Retry' : `Send ${rows.length} to OMS`}
                </Button>
              )}
            </>
          )}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
