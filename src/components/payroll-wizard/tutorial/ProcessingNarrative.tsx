'use client';

/**
 * [WIZARD-TUTORIAL] Processing Narrative — the Reports-step section that tells
 * the story of a payroll week: every Start/Stop Processing toggle and what
 * happened around them, in plain templated sentences.
 *
 * The window is the calendar Sun–Sat week (Kane, 2026-08-17) so the on/off
 * ledger is auditable against the week itself — stopping processing does not
 * stop the trail; it runs until the next Sunday. Week arrows navigate history.
 *
 * Render-only: derives everything from audit_log via /api/payroll-wizard/
 * audit-week and persists nothing (the cycle close-out stays the only
 * per-cycle record — cycle-closeout.md).
 */

import React, { useEffect, useMemo, useState } from 'react';
import {
  BookOpenText,
  ChevronLeft,
  ChevronRight,
  Loader2,
  Pause,
  Play,
} from 'lucide-react';
import { cn } from '@/lib/utils';
import { Button } from '@/components/ui/button';
import {
  buildProcessingNarrative,
  payrollWeekWindowFor,
  shiftWeekWindow,
  type NarrativeEventInput,
  type PayrollWeekWindow,
} from '@/lib/payroll-wizard/tutorial/narrative';

function formatToggleTime(iso: string): string {
  try {
    return new Date(iso).toLocaleString('en-US', {
      weekday: 'short',
      month: 'short',
      day: 'numeric',
      hour: 'numeric',
      minute: '2-digit',
    });
  } catch {
    return iso;
  }
}

export default function ProcessingNarrative() {
  const [window_, setWindow] = useState<PayrollWeekWindow>(() =>
    payrollWeekWindowFor(new Date()),
  );
  const [events, setEvents] = useState<NarrativeEventInput[] | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const isCurrentWeek = useMemo(
    () => payrollWeekWindowFor(new Date()).startDateIso === window_.startDateIso,
    [window_],
  );

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setError(null);
    const qs = new URLSearchParams({
      window_start: window_.startIso,
      window_end: window_.endIso,
    });
    fetch(`/api/payroll-wizard/audit-week?${qs.toString()}`, { cache: 'no-store' })
      .then(async (res) => {
        const json = (await res.json()) as {
          events: NarrativeEventInput[] | null;
          error: string | null;
        };
        if (cancelled) return;
        if (!res.ok || !json.events) {
          setEvents(null);
          setError(json.error ?? `HTTP ${res.status}`);
        } else {
          setEvents(json.events);
        }
      })
      .catch((e: unknown) => {
        if (!cancelled) {
          setEvents(null);
          setError(e instanceof Error ? e.message : String(e));
        }
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [window_]);

  const narrative = useMemo(
    () => (events ? buildProcessingNarrative(events, window_) : null),
    [events, window_],
  );

  return (
    <section className="rounded-2xl border border-indigo-200/70 bg-gradient-to-br from-indigo-50/60 via-white to-white p-5 shadow-sm dark:border-indigo-900/40 dark:from-indigo-950/25 dark:via-zinc-950 dark:to-zinc-950">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="flex items-center gap-2.5">
          <div className="flex h-9 w-9 items-center justify-center rounded-lg border border-indigo-200/80 bg-white dark:border-indigo-800/60 dark:bg-indigo-950/50">
            <BookOpenText className="h-5 w-5 text-indigo-600 dark:text-indigo-400" aria-hidden />
          </div>
          <div>
            <h3 className="text-base font-semibold text-zinc-900 dark:text-white">
              Processing Narrative
            </h3>
            <p className="text-xs text-zinc-600 dark:text-zinc-400">
              {narrative?.weekLabel ??
                `Week of ${window_.startDateIso} (Sun) – ${window_.endDateIso} (Sat)`}
              {' · '}the trail runs all week, even with processing off
            </p>
          </div>
        </div>
        <div className="flex items-center gap-1.5">
          <Button
            type="button"
            variant="outline"
            size="sm"
            className="h-8 w-8 p-0"
            onClick={() => setWindow((w) => shiftWeekWindow(w, -1))}
            title="Previous week"
          >
            <ChevronLeft className="h-4 w-4" />
          </Button>
          <Button
            type="button"
            variant="outline"
            size="sm"
            className="h-8 px-2.5 text-xs"
            disabled={isCurrentWeek}
            onClick={() => setWindow(payrollWeekWindowFor(new Date()))}
          >
            This week
          </Button>
          <Button
            type="button"
            variant="outline"
            size="sm"
            className="h-8 w-8 p-0"
            disabled={isCurrentWeek}
            onClick={() => setWindow((w) => shiftWeekWindow(w, 1))}
            title="Next week"
          >
            <ChevronRight className="h-4 w-4" />
          </Button>
        </div>
      </div>

      {loading ? (
        <div className="flex items-center gap-2 py-8 text-sm text-zinc-500 dark:text-zinc-400">
          <Loader2 className="h-4 w-4 animate-spin" /> Reading the week&apos;s audit trail…
        </div>
      ) : error ? (
        <p className="py-6 text-sm text-rose-600 dark:text-rose-400">
          Couldn&apos;t load the narrative: {error}
        </p>
      ) : narrative && narrative.totalEvents > 0 ? (
        <div className="mt-4 space-y-4">
          {/* On/off ledger — the reason the window is the calendar week. */}
          {narrative.toggles.length > 0 && (
            <div className="flex flex-wrap gap-1.5">
              {narrative.toggles.map((t, i) => (
                <span
                  key={i}
                  className={cn(
                    'inline-flex items-center gap-1.5 rounded-full border px-2.5 py-1 text-[11px] font-medium',
                    t.kind === 'started'
                      ? 'border-emerald-200 bg-emerald-50 text-emerald-700 dark:border-emerald-900/50 dark:bg-emerald-950/40 dark:text-emerald-300'
                      : 'border-rose-200 bg-rose-50 text-rose-700 dark:border-rose-900/50 dark:bg-rose-950/40 dark:text-rose-300',
                  )}
                >
                  {t.kind === 'started' ? (
                    <Play className="h-3 w-3" />
                  ) : (
                    <Pause className="h-3 w-3" />
                  )}
                  {t.kind === 'started' ? 'Started' : 'Stopped'} by {t.by} ·{' '}
                  {formatToggleTime(t.at)}
                </span>
              ))}
            </div>
          )}

          {/* The story, segment by segment. */}
          <ol className="space-y-3">
            {narrative.segments.map((seg, i) => (
              <li
                key={i}
                className={cn(
                  'rounded-xl border p-3.5',
                  seg.session != null
                    ? 'border-indigo-200/70 bg-white dark:border-indigo-900/40 dark:bg-zinc-950'
                    : 'border-dashed border-zinc-300 bg-zinc-50/60 dark:border-zinc-700 dark:bg-zinc-900/40',
                )}
              >
                <p
                  className={cn(
                    'text-[13px] font-semibold',
                    seg.session != null
                      ? 'text-zinc-900 dark:text-white'
                      : 'text-zinc-600 dark:text-zinc-400',
                  )}
                >
                  {seg.heading}
                </p>
                {seg.lines.length > 0 ? (
                  <ul className="mt-1.5 space-y-1">
                    {seg.lines.map((line, j) => (
                      <li
                        key={j}
                        className="flex items-start gap-2 text-xs leading-relaxed text-zinc-700 dark:text-zinc-300"
                      >
                        <span className="mt-1.5 h-1 w-1 shrink-0 rounded-full bg-indigo-400 dark:bg-indigo-500" />
                        {line}
                      </li>
                    ))}
                  </ul>
                ) : (
                  <p className="mt-1 text-xs italic text-zinc-500 dark:text-zinc-500">
                    Nothing recorded in this stretch.
                  </p>
                )}
              </li>
            ))}
          </ol>
        </div>
      ) : (
        <p className="py-6 text-sm text-zinc-500 dark:text-zinc-400">
          No processing activity recorded for this week yet. The narrative starts the
          moment someone presses Start Processing.
        </p>
      )}
    </section>
  );
}
