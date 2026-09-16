'use client';

/**
 * Payroll Wizard → Orphanage step → "Orphanage Management System" tab.
 *
 * The second way orphanage hours reach the step. OMS is where the orphanage team
 * prepares and APPROVES a week's hours; this panel pulls the approved rows for the
 * period on request, matches them to the people in this pay period through the SAME
 * resolver the paste tool uses, and shows what the HRIS makes of them — which hours
 * are regular, which are overtime, and what they price to.
 *
 * Rules this panel keeps (docs/features/orphanage-oms-pull.md):
 *   - Nothing polls. Refresh (a count) and Load (the rows) are both manual buttons.
 *   - Refresh DETECTS change (count / stamp moved since the last pull) and says "load
 *     again"; a re-load then shows WHAT changed, person by person (oms-diff.ts).
 *   - TEST mode is the default every session and writes NOTHING, anywhere.
 *   - LIVE mode warns, confirms in a dialog, and then rides the paste's lock-in —
 *     the same blob-CAS-then-record write, the same audit, the same money.
 *   - What is overtime is decided here by the HRIS (40h stack on worked hours), never
 *     read from OMS.
 *
 * Display + fetch orchestration only. Matching/pricing = `resolveOrphanageHourRows`;
 * the write = the wizard's lock-in, passed in as `onLockIn`.
 */

import { useMemo, useState } from 'react';
import { AnimatePresence, motion, useReducedMotion } from 'motion/react';
import {
  AlertTriangle,
  CheckCircle2,
  CloudDownload,
  Database,
  FlaskConical,
  Loader2,
  Lock,
  RefreshCw,
  ShieldAlert,
} from 'lucide-react';

import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Switch } from '@/components/ui/switch';
import { cn } from '@/lib/utils';
import { formatPHP } from '@/lib/format-php';
import type { OrphanageResolveResult } from '@/lib/payroll/orphanage-rows';
import { diffOmsPulls } from '@/lib/oms/oms-diff';

import OrphanageOmsLiveConfirmDialog from './OrphanageOmsLiveConfirmDialog';
import type { OmsHoursState } from './use-oms-hours';

export interface OrphanageOmsPanelProps {
  /** ISO Sunday of the period being edited. Null = no parseable source file. */
  weekStart: string | null;
  periodLabel: string;
  isReplay: boolean;
  /** TEST on = nothing is written. Lives in the wizard so a tab switch keeps it. */
  testMode: boolean;
  onTestModeChange: (on: boolean) => void;
  oms: OmsHoursState;
  /** The last pull, matched + priced by the wizard. Null until something was pulled. */
  resolved: OrphanageResolveResult | null;
  lockingIn: boolean;
  /** The wizard's lock-in over `resolved.ok`. Resolves true when the money landed. */
  onLockIn: () => Promise<boolean>;
}

const EASE = [0.22, 1, 0.36, 1] as const;

function ago(iso: string | null, now: number): string | null {
  if (!iso) return null;
  const t = Date.parse(iso);
  if (!Number.isFinite(t)) return null;
  const s = Math.max(0, Math.round((now - t) / 1000));
  if (s < 60) return 'just now';
  const m = Math.round(s / 60);
  if (m < 60) return `${m} min ago`;
  const h = Math.round(m / 60);
  if (h < 48) return `${h} h ago`;
  return `${Math.round(h / 24)} d ago`;
}

const fmtH = (n: number) => (Number.isInteger(n) ? String(n) : n.toFixed(2));

export default function OrphanageOmsPanel({
  weekStart,
  periodLabel,
  isReplay,
  testMode,
  onTestModeChange,
  oms,
  resolved,
  lockingIn,
  onLockIn,
}: OrphanageOmsPanelProps) {
  const reduceMotion = useReducedMotion() ?? false;
  const [confirmOpen, setConfirmOpen] = useState(false);
  const now = Date.now();

  const live = !testMode && !isReplay;
  const ok = resolved?.ok ?? [];
  const errors = resolved?.errors ?? [];
  const total = useMemo(() => ok.reduce((s, r) => s + r.amount, 0), [ok]);
  const otPeople = useMemo(() => ok.filter((r) => r.otH > 0).length, [ok]);

  const { status, pull, previousPull, changedSincePull, pulling, pullError } = oms;
  /** What a re-load changed against the pull it replaced. Null until a second pull. */
  const pullDiff = useMemo(
    () => (pull && previousPull ? diffOmsPulls(previousPull.rows, pull.rows) : null),
    [pull, previousPull],
  );
  const changedEmails = useMemo(() => {
    const set = new Set<string>();
    if (pullDiff) for (const c of [...pullDiff.added, ...pullDiff.changed]) set.add(c.email);
    return set;
  }, [pullDiff]);
  const canLoad = !!weekStart && !pulling && status.kind !== 'unconfigured' && status.kind !== 'checking';

  // ── the indicator ────────────────────────────────────────────────────────
  const indicator = (() => {
    switch (status.kind) {
      case 'idle':
        return { tone: 'zinc', dot: 'bg-zinc-400', label: 'Not checked yet', detail: 'Press Refresh to ask OMS what is approved for this week.' as string | null };
      case 'checking':
        return { tone: 'zinc', dot: 'animate-pulse bg-zinc-400', label: 'Checking OMS…', detail: null as string | null };
      case 'unconfigured':
        return { tone: 'zinc', dot: 'bg-zinc-400', label: 'OMS is not configured', detail: status.reason };
      case 'error':
        return { tone: 'rose', dot: 'bg-rose-500', label: 'OMS is unreachable', detail: status.reason };
      case 'empty':
        if (changedSincePull) {
          return { tone: 'amber', dot: 'bg-amber-400', label: 'Changed since your last pull — nothing is approved now', detail: 'Load again to see the week as OMS has it.' as string | null };
        }
        return {
          tone: 'amber',
          dot: 'bg-amber-400',
          label: 'Nothing approved yet for this week',
          detail: 'OMS releases a week only once it is approved there.',
        };
      case 'ready': {
        const when = ago(status.latestUpdatedAt, now);
        if (changedSincePull) {
          const parts: string[] = [];
          if (changedSincePull.countDelta > 0) parts.push(`${changedSincePull.countDelta} more approved`);
          if (changedSincePull.countDelta < 0) parts.push(`${-changedSincePull.countDelta} fewer approved`);
          if (changedSincePull.stampMoved) parts.push(when ? `edited ${when}` : 'rows edited');
          return {
            tone: 'amber',
            dot: 'animate-pulse bg-amber-500',
            label: 'Changed since your last pull',
            detail: `${parts.join(' · ')} — load again to see what changed.` as string | null,
          };
        }
        return {
          tone: 'emerald',
          dot: 'bg-emerald-500',
          label: `${status.approvedCount} approved ${status.approvedCount === 1 ? 'row' : 'rows'} ready to pull`,
          detail: (pull ? 'Same as your last pull' : null) ?? (when ? `Prepared ${when}` : null),
        };
      }
    }
  })();

  const toneRing: Record<string, string> = {
    zinc: 'border-zinc-200 bg-zinc-50 text-zinc-700 dark:border-zinc-800 dark:bg-zinc-900/40 dark:text-zinc-300',
    rose: 'border-rose-200 bg-rose-50 text-rose-800 dark:border-rose-900/50 dark:bg-rose-950/30 dark:text-rose-300',
    amber: 'border-amber-200 bg-amber-50 text-amber-800 dark:border-amber-900/50 dark:bg-amber-950/30 dark:text-amber-300',
    emerald: 'border-emerald-200 bg-emerald-50 text-emerald-800 dark:border-emerald-900/50 dark:bg-emerald-950/30 dark:text-emerald-300',
  };

  return (
    <Card data-tutorial-target="step3-oms-panel" className="border-zinc-200 dark:border-zinc-800">
      <CardHeader className="pb-3">
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div className="min-w-0">
            <CardTitle className="flex items-center gap-2 text-base">
              <Database className="h-4 w-4 text-rose-600 dark:text-rose-400" /> Orphanage Management System
            </CardTitle>
            <CardDescription className="mt-1">
              Approved hours for {periodLabel}, matched to the people in this pay period. The HRIS decides
              which hours are overtime — OMS only says who and how many.
            </CardDescription>
          </div>

          {/* TEST / LIVE. One control, two labels, so the state is never ambiguous. */}
          <div
            className={cn(
              'flex items-center gap-2.5 rounded-lg border px-3 py-1.5 transition-colors duration-300',
              live
                ? 'border-amber-300 bg-amber-50 dark:border-amber-800 dark:bg-amber-950/30'
                : 'border-zinc-200 bg-zinc-50 dark:border-zinc-700 dark:bg-zinc-800/40',
            )}
          >
            <span className="relative flex h-4 w-4 items-center justify-center">
              <AnimatePresence mode="wait" initial={false}>
                {live ? (
                  <motion.span
                    key="live"
                    initial={reduceMotion ? { opacity: 0 } : { opacity: 0, scale: 0.6 }}
                    animate={{ opacity: 1, scale: 1 }}
                    exit={reduceMotion ? { opacity: 0 } : { opacity: 0, scale: 0.6 }}
                    transition={{ duration: reduceMotion ? 0.1 : 0.18, ease: EASE }}
                    className="absolute inset-0 flex items-center justify-center"
                  >
                    <ShieldAlert className="h-4 w-4 text-amber-600 dark:text-amber-400" />
                  </motion.span>
                ) : (
                  <motion.span
                    key="test"
                    initial={reduceMotion ? { opacity: 0 } : { opacity: 0, scale: 0.6 }}
                    animate={{ opacity: 1, scale: 1 }}
                    exit={reduceMotion ? { opacity: 0 } : { opacity: 0, scale: 0.6 }}
                    transition={{ duration: reduceMotion ? 0.1 : 0.18, ease: EASE }}
                    className="absolute inset-0 flex items-center justify-center"
                  >
                    <FlaskConical className="h-4 w-4 text-zinc-500 dark:text-zinc-400" />
                  </motion.span>
                )}
              </AnimatePresence>
            </span>
            <span
              className={cn(
                'text-[11px] font-semibold uppercase tracking-wide',
                live ? 'text-amber-700 dark:text-amber-300' : 'text-zinc-600 dark:text-zinc-300',
              )}
            >
              {live ? 'Live' : 'Test'}
            </span>
            <Switch
              checked={testMode}
              onCheckedChange={(v) => onTestModeChange(v)}
              disabled={isReplay || lockingIn}
              aria-label="Test mode"
            />
            <span className="text-[11px] text-zinc-500 dark:text-zinc-400">Test mode</span>
          </div>
        </div>
      </CardHeader>

      <CardContent className="flex flex-col gap-4">
        {isReplay && (
          <div className="flex items-center gap-2 rounded-lg border border-amber-200 bg-amber-50 px-3 py-2 text-[12.5px] text-amber-800 dark:border-amber-900/50 dark:bg-amber-950/30 dark:text-amber-300">
            <AlertTriangle className="h-3.5 w-3.5 shrink-0" />
            Replaying a past period — you can pull and inspect, but nothing can be locked in from here.
          </div>
        )}

        {/* Indicator + Load */}
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div
            role="status"
            aria-live="polite"
            className={cn(
              'flex min-w-0 items-center gap-2.5 rounded-lg border px-3 py-2 text-[13px] transition-colors duration-300',
              toneRing[indicator.tone],
            )}
          >
            <span className="relative flex h-2.5 w-2.5 shrink-0">
              {status.kind === 'ready' && !reduceMotion && (
                <span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-emerald-400 opacity-60 motion-reduce:hidden" />
              )}
              <span className={cn('relative inline-flex h-2.5 w-2.5 rounded-full', indicator.dot)} />
            </span>
            <AnimatePresence mode="wait" initial={false}>
              <motion.span
                key={`${status.kind}:${indicator.label}`}
                initial={reduceMotion ? { opacity: 0 } : { opacity: 0, y: 3 }}
                animate={{ opacity: 1, y: 0 }}
                exit={reduceMotion ? { opacity: 0 } : { opacity: 0, y: -3 }}
                transition={{ duration: reduceMotion ? 0.1 : 0.2, ease: EASE }}
                className="flex min-w-0 flex-wrap items-baseline gap-x-2"
              >
                <span className="font-medium">{indicator.label}</span>
                {indicator.detail && <span className="truncate text-[12px] opacity-80">{indicator.detail}</span>}
              </motion.span>
            </AnimatePresence>
          </div>

          <div className="flex items-center gap-2">
            {/* Manual poll. Nothing refreshes this pill on its own — not on tab open,
                not on a timer. Kane: "not a live polling just a manual polling button". */}
            <Button
              type="button"
              variant="outline"
              onClick={() => void oms.checkStatus()}
              disabled={!weekStart || status.kind === 'checking' || pulling}
              className="h-9 gap-2 px-3"
            >
              <RefreshCw className={cn('h-4 w-4', status.kind === 'checking' && 'animate-spin')} />
              {status.kind === 'checking' ? 'Checking…' : 'Refresh'}
            </Button>
            <Button
              type="button"
              onClick={() => void oms.load()}
              disabled={!canLoad}
              className={cn(
                'h-9 gap-2 bg-rose-600 px-4 text-white transition-all hover:bg-rose-700 disabled:opacity-60',
                changedSincePull && !pulling && 'ring-2 ring-amber-400 ring-offset-2 ring-offset-white dark:ring-offset-zinc-950',
              )}
            >
              {pulling ? <Loader2 className="h-4 w-4 animate-spin" /> : <CloudDownload className="h-4 w-4" />}
              {pulling ? 'Pulling…' : pull ? 'Load again' : 'Load Orphanage Hours'}
            </Button>
          </div>
        </div>

        {pullError && (
          <div className="flex items-start gap-2 rounded-lg border border-rose-200 bg-rose-50/70 px-3 py-2 text-[12.5px] text-rose-800 dark:border-rose-900/40 dark:bg-rose-950/20 dark:text-rose-300">
            <AlertTriangle className="mt-0.5 h-3.5 w-3.5 shrink-0" />
            <span>Could not pull from OMS — {pullError}</span>
          </div>
        )}

        {/* The pull. Enters as one block; its rows stagger in. */}
        <AnimatePresence initial={false}>
          {pull && resolved && (
            <motion.div
              key={`pull-${pull.pulledAt}`}
              initial={reduceMotion ? { opacity: 0 } : { opacity: 0, y: 6 }}
              animate={{ opacity: 1, y: 0 }}
              exit={{ opacity: 0 }}
              transition={{ duration: reduceMotion ? 0.12 : 0.24, ease: EASE }}
              className="flex flex-col gap-3"
            >
              {/* Summary strip */}
              <div className="flex flex-wrap items-center gap-2 text-[12.5px]">
                <span className="inline-flex items-center gap-1.5 rounded-full border border-emerald-200 bg-emerald-50 px-2.5 py-1 font-medium text-emerald-700 dark:border-emerald-900/50 dark:bg-emerald-950/30 dark:text-emerald-300">
                  <CheckCircle2 className="h-3.5 w-3.5" /> {ok.length} matched · {formatPHP(total)}
                </span>
                {otPeople > 0 && (
                  <span className="inline-flex items-center gap-1.5 rounded-full border border-violet-200 bg-violet-50 px-2.5 py-1 font-medium text-violet-700 dark:border-violet-900/50 dark:bg-violet-950/30 dark:text-violet-300">
                    {otPeople} with overtime
                  </span>
                )}
                {errors.length > 0 && (
                  <span className="inline-flex items-center gap-1.5 rounded-full border border-amber-200 bg-amber-50 px-2.5 py-1 font-medium text-amber-800 dark:border-amber-900/50 dark:bg-amber-950/30 dark:text-amber-300">
                    <AlertTriangle className="h-3.5 w-3.5" /> {errors.length} skipped
                  </span>
                )}
                {pull.truncated && (
                  <span className="inline-flex items-center gap-1.5 rounded-full border border-rose-300 bg-rose-50 px-2.5 py-1 font-semibold text-rose-700 dark:border-rose-900/50 dark:bg-rose-950/30 dark:text-rose-300">
                    Truncated — OMS returned more rows than one week can hold
                  </span>
                )}
                <span className="ml-auto text-zinc-500 dark:text-zinc-400">
                  {pull.rows.length} {pull.rows.length === 1 ? 'row' : 'rows'} pulled {ago(new Date(pull.pulledAt).toISOString(), now) ?? ''}
                </span>
              </div>

              {/* What this re-load changed against the pull it replaced. Person is the
                  unit: added / removed / hours changed. Silent until a second pull. */}
              {pullDiff && (
                <motion.div
                  key={`diff-${pull.pulledAt}`}
                  initial={reduceMotion ? { opacity: 0 } : { opacity: 0, y: 4 }}
                  animate={{ opacity: 1, y: 0 }}
                  transition={{ duration: reduceMotion ? 0.1 : 0.2, ease: EASE }}
                  className={cn(
                    'rounded-lg border px-3 py-2.5 text-[12.5px]',
                    pullDiff.total === 0
                      ? 'border-zinc-200 bg-zinc-50 text-zinc-600 dark:border-zinc-800 dark:bg-zinc-900/40 dark:text-zinc-400'
                      : 'border-sky-200 bg-sky-50/70 text-sky-900 dark:border-sky-900/50 dark:bg-sky-950/30 dark:text-sky-200',
                  )}
                >
                  {pullDiff.total === 0 ? (
                    <span className="inline-flex items-center gap-1.5">
                      <CheckCircle2 className="h-3.5 w-3.5" /> No changes since your previous pull — same people, same hours.
                    </span>
                  ) : (
                    <>
                      <div className="mb-1.5 flex flex-wrap items-center gap-x-3 gap-y-1 font-semibold">
                        <span>Changed since your previous pull</span>
                        {pullDiff.added.length > 0 && <span className="text-emerald-700 dark:text-emerald-300">+{pullDiff.added.length} added</span>}
                        {pullDiff.changed.length > 0 && <span className="text-amber-700 dark:text-amber-300">~{pullDiff.changed.length} hours changed</span>}
                        {pullDiff.removed.length > 0 && <span className="text-rose-700 dark:text-rose-300">−{pullDiff.removed.length} removed</span>}
                      </div>
                      <ul className="flex flex-col gap-0.5">
                        {[...pullDiff.added, ...pullDiff.changed, ...pullDiff.removed].map((c) => (
                          <li key={`${c.kind}:${c.email}`} className="flex gap-2 font-mono text-[12px]">
                            <span
                              className={cn(
                                'w-3 shrink-0 text-center font-bold',
                                c.kind === 'added' && 'text-emerald-600 dark:text-emerald-400',
                                c.kind === 'changed' && 'text-amber-600 dark:text-amber-400',
                                c.kind === 'removed' && 'text-rose-600 dark:text-rose-400',
                              )}
                            >
                              {c.kind === 'added' ? '+' : c.kind === 'removed' ? '−' : '~'}
                            </span>
                            <span className="min-w-0 truncate">{c.email}</span>
                            <span className="ml-auto shrink-0 tabular-nums">
                              {c.kind === 'changed' ? `${fmtH(c.before ?? 0)} → ${fmtH(c.after ?? 0)} h` : c.kind === 'added' ? `${fmtH(c.after ?? 0)} h` : `was ${fmtH(c.before ?? 0)} h`}
                            </span>
                          </li>
                        ))}
                      </ul>
                    </>
                  )}
                </motion.div>
              )}

              {ok.length > 0 && (
                <div className="overflow-x-auto rounded-lg border border-zinc-200 dark:border-zinc-800">
                  <table className="w-full text-[12.5px]">
                    <thead className="bg-zinc-50 text-left text-[11px] uppercase tracking-wide text-zinc-500 dark:bg-zinc-900/60 dark:text-zinc-400">
                      <tr>
                        <th className="px-3 py-2 font-semibold">Person</th>
                        <th className="px-3 py-2 text-right font-semibold">Hours</th>
                        <th className="px-3 py-2 text-right font-semibold">Regular</th>
                        <th className="px-3 py-2 text-right font-semibold">Overtime</th>
                        <th className="px-3 py-2 text-right font-semibold">Rate</th>
                        <th className="px-3 py-2 text-right font-semibold">Amount</th>
                      </tr>
                    </thead>
                    <tbody>
                      {ok.map((r, i) => (
                        <motion.tr
                          key={r.emailKey}
                          initial={reduceMotion ? { opacity: 0 } : { opacity: 0, y: 4 }}
                          animate={{ opacity: 1, y: 0 }}
                          transition={{
                            duration: reduceMotion ? 0.1 : 0.22,
                            ease: EASE,
                            delay: reduceMotion ? 0 : Math.min(i, 20) * 0.024,
                          }}
                          className={cn(
                            'border-t border-zinc-100 transition-colors dark:border-zinc-800/80',
                            changedEmails.has(r.matchedEmail) || changedEmails.has(r.emailKey.toLowerCase())
                              ? 'bg-sky-50/70 dark:bg-sky-950/20'
                              : undefined,
                          )}
                        >
                          <td className="px-3 py-2">
                            <div className="font-medium text-zinc-800 dark:text-zinc-100">{r.name}</div>
                            <div className="truncate text-[11.5px] text-zinc-500 dark:text-zinc-400">
                              {r.emailKey}
                              {r.matchedEmail !== r.emailKey.toLowerCase() && (
                                <span className="ml-1 text-zinc-400 dark:text-zinc-500">via {r.matchedEmail}</span>
                              )}
                            </div>
                          </td>
                          <td className="px-3 py-2 text-right font-mono tabular-nums text-zinc-800 dark:text-zinc-100">{fmtH(r.hours)}</td>
                          <td className="px-3 py-2 text-right font-mono tabular-nums text-zinc-700 dark:text-zinc-300">{fmtH(r.regH)}</td>
                          <td
                            className={cn(
                              'px-3 py-2 text-right font-mono tabular-nums',
                              r.otH > 0 ? 'font-semibold text-violet-700 dark:text-violet-300' : 'text-zinc-400 dark:text-zinc-600',
                            )}
                          >
                            {r.otH > 0 ? fmtH(r.otH) : '—'}
                          </td>
                          <td className="px-3 py-2 text-right font-mono tabular-nums text-zinc-600 dark:text-zinc-400">
                            {formatPHP(r.rate)}
                            {r.otH > 0 && r.otRate != null && (
                              <span className="block text-[11px] text-violet-600 dark:text-violet-400">OT {formatPHP(r.otRate)}</span>
                            )}
                          </td>
                          <td className="px-3 py-2 text-right font-mono font-semibold tabular-nums text-zinc-900 dark:text-white">{formatPHP(r.amount)}</td>
                        </motion.tr>
                      ))}
                    </tbody>
                    <tfoot>
                      <tr className="border-t border-zinc-200 bg-zinc-50/70 dark:border-zinc-800 dark:bg-zinc-900/40">
                        <td className="px-3 py-2 text-[11px] font-semibold uppercase tracking-wide text-zinc-500 dark:text-zinc-400" colSpan={5}>
                          Total · {ok.length} {ok.length === 1 ? 'person' : 'people'}
                        </td>
                        <td className="px-3 py-2 text-right font-mono font-semibold tabular-nums text-zinc-900 dark:text-white">{formatPHP(total)}</td>
                      </tr>
                    </tfoot>
                  </table>
                </div>
              )}

              {ok.length === 0 && errors.length === 0 && (
                <div className="rounded-lg border border-dashed border-zinc-200 px-3 py-4 text-center text-[12.5px] text-zinc-500 dark:border-zinc-800 dark:text-zinc-400">
                  OMS returned no approved rows for this week.
                </div>
              )}

              {errors.length > 0 && (
                <div className="rounded-lg border border-amber-200 bg-amber-50/60 p-3 dark:border-amber-900/40 dark:bg-amber-950/20">
                  <div className="mb-1.5 flex items-center gap-1.5 text-[12px] font-semibold uppercase tracking-wider text-amber-800 dark:text-amber-300">
                    <AlertTriangle className="h-3.5 w-3.5" /> {errors.length} {errors.length === 1 ? 'row' : 'rows'} skipped — not written in any mode
                  </div>
                  <ul className="flex flex-col gap-1 text-[12.5px] text-amber-900 dark:text-amber-200">
                    {errors.map((e, idx) => (
                      <li key={idx} className="flex gap-2">
                        <span className="shrink-0 font-mono text-amber-500">#{e.line}</span>
                        <span className="min-w-0">
                          {e.email && <span className="font-medium">{e.email}</span>}
                          {e.email ? ' — ' : ''}
                          {e.reason}
                        </span>
                      </li>
                    ))}
                  </ul>
                </div>
              )}

              {/* Footer: what happens next depends on the switch. */}
              <AnimatePresence mode="wait" initial={false}>
                {live ? (
                  <motion.div
                    key="live-footer"
                    initial={reduceMotion ? { opacity: 0 } : { opacity: 0, y: 4 }}
                    animate={{ opacity: 1, y: 0 }}
                    exit={{ opacity: 0 }}
                    transition={{ duration: reduceMotion ? 0.1 : 0.2, ease: EASE }}
                    className="flex flex-wrap items-center justify-between gap-3 rounded-lg border border-amber-300 bg-amber-50 px-3 py-2.5 dark:border-amber-800 dark:bg-amber-950/30"
                  >
                    <div className="flex items-start gap-2 text-[12.5px] text-amber-900 dark:text-amber-200">
                      <ShieldAlert className="mt-0.5 h-4 w-4 shrink-0 text-amber-600 dark:text-amber-400" />
                      <span>
                        <span className="font-semibold">Live mode.</span> Locking in writes these amounts to the Additions
                        Orphanage column and every later step sees them — Additions, Validation, Dispatch and the paystub.
                      </span>
                    </div>
                    <Button
                      type="button"
                      onClick={() => setConfirmOpen(true)}
                      disabled={ok.length === 0 || lockingIn}
                      className="h-8 gap-2 bg-amber-600 px-3 text-xs font-semibold text-white transition-colors hover:bg-amber-700"
                    >
                      {lockingIn ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Lock className="h-3.5 w-3.5" />}
                      Lock in {ok.length} {ok.length === 1 ? 'amount' : 'amounts'}
                    </Button>
                  </motion.div>
                ) : (
                  <motion.div
                    key="test-footer"
                    initial={reduceMotion ? { opacity: 0 } : { opacity: 0, y: 4 }}
                    animate={{ opacity: 1, y: 0 }}
                    exit={{ opacity: 0 }}
                    transition={{ duration: reduceMotion ? 0.1 : 0.2, ease: EASE }}
                    className="flex items-start gap-2 rounded-lg border border-zinc-200 bg-zinc-50 px-3 py-2.5 text-[12.5px] text-zinc-600 dark:border-zinc-800 dark:bg-zinc-900/40 dark:text-zinc-400"
                  >
                    <FlaskConical className="mt-0.5 h-4 w-4 shrink-0 text-zinc-500 dark:text-zinc-400" />
                    <span>
                      <span className="font-semibold text-zinc-700 dark:text-zinc-300">Test mode.</span> Nothing is written —
                      this is what the HRIS would lock in.
                      {!isReplay && ' Switch Test off to lock these amounts in for real.'}
                    </span>
                  </motion.div>
                )}
              </AnimatePresence>
            </motion.div>
          )}
        </AnimatePresence>
      </CardContent>

      <OrphanageOmsLiveConfirmDialog
        open={confirmOpen}
        busy={lockingIn}
        peopleCount={ok.length}
        totalLabel={formatPHP(total)}
        skippedCount={errors.length}
        periodLabel={periodLabel}
        onCancel={() => setConfirmOpen(false)}
        onConfirm={() => {
          void onLockIn().then((landed) => {
            if (landed) setConfirmOpen(false);
          });
        }}
      />
    </Card>
  );
}
