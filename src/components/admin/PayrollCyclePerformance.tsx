/**
 * Admin → Diagnostics → **Payroll Cycles**.
 *
 * "Of the people this pay week owed money to, what fraction actually got paid?"
 * — per cycle and per month, read from the close-out records and nothing else.
 *
 * ── The three things this screen must never do ─────────────────────────────
 * 1. **Never show a rate for a cycle that was not closed.** The series simply
 *    starts at the first close-out; earlier weeks are absent, not zero. The
 *    coverage note says so in words, because an absence is invisible.
 * 2. **Never present `records_outstanding` as a rate.** It counts people
 *    Accounting deliberately EXCLUDED, so it is normally larger than unpaid.
 *    It sits in its own column, labelled audit, with no percentage anywhere
 *    near it.
 * 3. **Never blend this with the HR tab.** Accounting's score and HR's score
 *    are different questions with different denominators (Kane, 2026-09-04).
 *
 * See `src/lib/admin/cycle-performance.ts` for why the numbers come from where
 * they come from, and `docs/features/diagnostics-performance-tabs.md`.
 */

'use client';

import * as React from 'react';
import { cn } from '@/lib/utils';
import {
  ACCENT,
  KpiCard,
  PerfNote,
  PerfShell,
  RateBar,
  UnmeasurableChip,
  num,
  pct,
} from '@/components/admin/performance-ui';
import type {
  CyclePerformanceRow,
  CyclePerformanceSummary,
} from '@/lib/admin/cycle-performance';

interface ApiResponse {
  generatedAt: string;
  performance: CyclePerformanceSummary | null;
  unreadable?: string[];
  inventoryError?: string | null;
  error: string | null;
}

const ACCENT_KEY = 'accounting' as const;

/** Poll slower than the service map's 30s: these are frozen records, not health. */
const POLL_MS = 120_000;

export default function PayrollCyclePerformance() {
  const [data, setData] = React.useState<CyclePerformanceSummary | null>(null);
  const [generatedAt, setGeneratedAt] = React.useState<string | null>(null);
  const [unreadable, setUnreadable] = React.useState<string[]>([]);
  const [inventoryError, setInventoryError] = React.useState<string | null>(null);
  const [error, setError] = React.useState<string | null>(null);
  const [refreshing, setRefreshing] = React.useState(false);
  // First load is the ONLY time a skeleton shows. Derived from "we have never
  // had data and are not in an error state" — never from a separate flag that
  // can fall out of sync and repaint a loaded screen.
  const [everLoaded, setEverLoaded] = React.useState(false);

  const load = React.useCallback(async () => {
    setRefreshing(true);
    try {
      const res = await fetch('/api/admin/diagnostics/cycle-performance', {
        cache: 'no-store',
      });
      const body = (await res.json().catch(() => null)) as ApiResponse | null;
      if (!res.ok || !body || body.error || !body.performance) {
        setError(body?.error ?? `Request failed (HTTP ${res.status})`);
        // Keep whatever was on screen: a failed refresh must not blank a
        // screen that was previously correct.
      } else {
        setData(body.performance);
        setGeneratedAt(body.generatedAt);
        setUnreadable(body.unreadable ?? []);
        setInventoryError(body.inventoryError ?? null);
        setError(null);
      }
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Network error');
    } finally {
      setRefreshing(false);
      setEverLoaded(true);
    }
  }, []);

  const loadRef = React.useRef(load);
  loadRef.current = load;
  React.useEffect(() => {
    void loadRef.current();
    const t = setInterval(() => void loadRef.current(), POLL_MS);
    return () => clearInterval(t);
  }, []);

  const totals = data?.totals ?? null;

  return (
    <PerfShell
      accent={ACCENT_KEY}
      title="Payroll Cycle Performance"
      subtitle="Of the people each closed pay week owed money to, how many were actually paid. Read from the cycle close-out records — the only artifact that knows who was still owed."
      icon={<WalletGlyph />}
      generatedAt={generatedAt}
      loading={!everLoaded && !data}
      refreshing={refreshing}
      error={error}
      onRefresh={() => void load()}
    >
      {data && totals ? (
        <>
          {/* ── KPI row — Accounting's numbers. The first three describe the
              DECLARED population only; the fourth is the coverage caveat. ── */}
          <div className="grid grid-cols-2 gap-2 sm:gap-3 lg:grid-cols-4">
            <KpiCard
              accent={ACCENT_KEY}
              label="Success rate"
              value={pct(totals.rate)}
              sub={`${num(totals.paid)} of ${num(totals.payable)} payable`}
              icon={<TargetGlyph />}
              title="Pooled across every CLOSED cycle: total paid ÷ total payable. Unclosed cycles are excluded — they have no payable count, so they cannot be scored."
            />
            <KpiCard
              accent={ACCENT_KEY}
              tone="neutral"
              label="People paid"
              value={num(totals.paid)}
              sub={`across ${num(totals.measuredCycles)} closed ${totals.measuredCycles === 1 ? 'cycle' : 'cycles'}`}
              icon={<CheckGlyph />}
              title="Paid payees on closed cycles only. Payments on unclosed cycles are counted separately, on the Unclosed card."
            />
            <KpiCard
              accent={ACCENT_KEY}
              tone={totals.unpaid > 0 ? 'warn' : 'neutral'}
              label="Still owed"
              value={num(totals.unpaid)}
              sub="payable but unpaid at close"
              icon={<AlertGlyph />}
              title="Pending + Problem + Threshold, on closed cycles. People in the Excluded tab are never counted here — they were set aside deliberately."
            />
            <KpiCard
              accent={ACCENT_KEY}
              tone={totals.unclosedCycles > 0 ? 'warn' : 'neutral'}
              label="Unclosed cycles"
              value={num(totals.unclosedCycles)}
              sub={
                totals.preCloseoutCycles > 0
                  ? `+ ${num(totals.preCloseoutCycles)} before close-outs`
                  : totals.unclosedCycles > 0
                    ? 'no payable count recorded'
                    : 'every cycle declared'
              }
              icon={<OpenGlyph />}
              title="Cycles that happened after close-outs existed and were never closed. Their payments are real and shown in the table, but nothing recorded who was still owed, so they carry no rate and are in no percentage above."
            />
          </div>

          {/* ── Month cards ── */}
          {data.months.length > 0 && (
            <section className="flex flex-col gap-2">
              <SectionLabel>By month</SectionLabel>
              <div className="grid grid-cols-1 gap-2 sm:grid-cols-2 sm:gap-3 xl:grid-cols-3">
                {data.months.map((m) => (
                  <div
                    key={m.month}
                    className="flex flex-col gap-2 rounded-xl border border-zinc-200 bg-white/80 p-3 shadow-sm backdrop-blur-sm transition-shadow duration-200 hover:shadow-md motion-reduce:transition-none dark:border-zinc-800 dark:bg-zinc-950/40"
                  >
                    <div className="flex items-baseline justify-between gap-2">
                      <span className="text-[11px] font-semibold tracking-tight text-zinc-700 dark:text-zinc-300">
                        {m.label}
                      </span>
                      <span className="font-mono text-[10px] tabular-nums text-zinc-400 dark:text-zinc-500">
                        {m.closedCycles}/{m.cycles} closed
                      </span>
                    </div>
                    <div className="flex items-baseline gap-2">
                      <span
                        className={cn(
                          'font-mono text-2xl font-bold leading-none tabular-nums',
                          m.measurable
                            ? 'text-zinc-900 dark:text-zinc-100'
                            : 'text-zinc-400 dark:text-zinc-600',
                        )}
                      >
                        {pct(m.rate)}
                      </span>
                      {!m.measurable && (
                        <UnmeasurableChip>
                          {m.closedCycles === 0 ? 'nothing closed' : 'no payable people'}
                        </UnmeasurableChip>
                      )}
                    </div>
                    <RateBar rate={m.rate} accent={ACCENT_KEY} />
                    <div className="flex flex-wrap items-center gap-x-3 gap-y-0.5 text-[11px] tabular-nums text-zinc-500 dark:text-zinc-400">
                      <span>{num(m.paid)} paid</span>
                      <span>{num(m.unpaid)} unpaid</span>
                      {m.worstCycleLabel && m.closedCycles > 1 && (
                        <span className="text-zinc-400 dark:text-zinc-500">
                          weakest {m.worstCycleLabel} · {pct(m.worstCycleRate)}
                        </span>
                      )}
                    </div>
                    {/* A rate over part of a month must say which part. Without
                        this a 98% headline reads as the whole month. */}
                    {!m.fullyDeclared && (
                      <p className="text-[10.5px] leading-snug text-amber-700 dark:text-amber-400">
                        {m.measurable ? 'Covers ' : 'Would cover '}
                        {m.closedCycles} of {m.cycles} {m.cycles === 1 ? 'cycle' : 'cycles'}
                        {m.unclosedCycles > 0 && ` · ${m.unclosedCycles} unclosed`}
                        {m.preCloseoutCycles > 0 &&
                          ` · ${m.preCloseoutCycles} before close-outs`}
                      </p>
                    )}
                  </div>
                ))}
              </div>
            </section>
          )}

          {/* ── Per-cycle table ── */}
          <section className="flex flex-col gap-2">
            <SectionLabel>Every pay cycle</SectionLabel>
            <div className="overflow-x-auto rounded-xl border border-zinc-200 bg-white/80 backdrop-blur-sm dark:border-zinc-800 dark:bg-zinc-950/40">
              <table className="w-full min-w-[52rem] border-collapse text-[12px]">
                <thead>
                  <tr className="border-b border-zinc-100 text-[10px] uppercase tracking-[0.12em] text-zinc-500 dark:border-zinc-800/60 dark:text-zinc-400">
                    <Th className="text-left">Cycle</Th>
                    <Th className="text-left">Status</Th>
                    <Th title="Paid + Unpaid. Only a closed cycle has one — nothing else knows who Payment Dispatch still had queued.">
                      Payable
                    </Th>
                    <Th>Paid</Th>
                    <Th>Unpaid</Th>
                    <Th className="w-[9rem]">Rate</Th>
                    <Th title="disbursement_records cross-check. Counts people Accounting EXCLUDED too, so it is normally larger than Unpaid. Audit only — never a rate.">
                      Outstanding
                    </Th>
                  </tr>
                </thead>
                <tbody>
                  {data.cycles.map((c) => (
                    <tr
                      key={c.sourceFile}
                      className={cn(
                        'border-b border-zinc-50 transition-colors duration-150 last:border-0 hover:bg-zinc-50/70 motion-reduce:transition-none dark:border-zinc-900 dark:hover:bg-zinc-900/40',
                        c.status !== 'closed' && 'bg-zinc-50/40 dark:bg-zinc-900/20',
                      )}
                    >
                      <td className="px-3 py-2">
                        <div
                          className={cn(
                            'font-medium',
                            c.status === 'closed'
                              ? 'text-zinc-900 dark:text-zinc-100'
                              : 'text-zinc-600 dark:text-zinc-300',
                          )}
                        >
                          {c.label}
                        </div>
                        {c.periodStart && c.periodEnd && (
                          <div className="font-mono text-[10px] tabular-nums text-zinc-400 dark:text-zinc-500">
                            {c.periodStart} → {c.periodEnd}
                          </div>
                        )}
                      </td>
                      <td className="px-3 py-2">
                        <StatusCell row={c} />
                      </td>
                      {/* null ≠ 0 here. An em dash says "unknown"; a 0 would
                          claim nobody was owed, which only a close-out knows. */}
                      <Td strong muted={c.payable == null}>
                        {c.payable == null ? '—' : num(c.payable)}
                      </Td>
                      <Td>{num(c.paid)}</Td>
                      <Td
                        muted={c.unpaid == null}
                        className={
                          c.unpaid != null && c.unpaid > 0
                            ? 'text-amber-700 dark:text-amber-400'
                            : undefined
                        }
                      >
                        {c.unpaid == null ? '—' : num(c.unpaid)}
                      </Td>
                      <td className="px-3 py-2">
                        {c.measurable ? (
                          <div className="flex items-center gap-2">
                            <span className="w-[3.2rem] shrink-0 text-right font-mono font-semibold tabular-nums text-zinc-900 dark:text-zinc-100">
                              {pct(c.rate)}
                            </span>
                            <RateBar rate={c.rate} accent={ACCENT_KEY} className="flex-1" />
                          </div>
                        ) : (
                          <UnmeasurableChip>
                            {c.status === 'closed' ? 'not measurable' : 'no denominator'}
                          </UnmeasurableChip>
                        )}
                      </td>
                      <Td muted>
                        {c.recordsOutstanding == null ? (
                          <span title="The cross-check read failed, or this cycle has no ledger rows. Recorded as unknown, never as zero.">
                            unknown
                          </span>
                        ) : (
                          num(c.recordsOutstanding)
                        )}
                      </Td>
                    </tr>
                  ))}
                  {data.cycles.length === 0 && (
                    <tr>
                      <td
                        colSpan={7}
                        className="px-3 py-6 text-center text-[12px] text-zinc-500 dark:text-zinc-400"
                      >
                        No pay cycles found.
                      </td>
                    </tr>
                  )}
                </tbody>
              </table>
            </div>
          </section>

          {/* ── The caveats. Every one of these is load-bearing. ── */}
          <div className="flex flex-col gap-1.5 rounded-lg border border-zinc-200/70 bg-zinc-50/60 px-3 py-2.5 dark:border-zinc-800/70 dark:bg-zinc-900/30">
            <PerfNote icon={<DotGlyph />}>
              <strong>Only a closed cycle can have a rate.</strong> An unclosed cycle shows its
              real payments but no <em>Payable</em> and no percentage, because nothing recorded
              who was still owed — &quot;payable but unpaid&quot; lives in Payment Dispatch&apos;s
              queue and no table reproduces it. That is why those cells read{' '}
              <span className="font-mono">—</span> and not <span className="font-mono">0</span>:
              zero would claim nobody was owed.
            </PerfNote>
            <PerfNote icon={<DotGlyph />}>
              <strong>Unclosed cycles are in no rate above.</strong> They are listed and their
              payments counted separately, but they never enter a month&apos;s or the all-time
              denominator — a cycle whose payable count is unknowable cannot make a percentage
              more accurate, only made-up. Any month not fully closed says so on its card.
            </PerfNote>
            <PerfNote icon={<DotGlyph />}>
              <strong>&quot;Before close-outs&quot; is not a failure.</strong>{' '}
              {totals.firstPeriodEnd ? (
                <>
                  The first cycle ever closed ends <strong>{totals.firstPeriodEnd}</strong>;
                  anything earlier could not have been closed, because the feature did not exist.
                </>
              ) : (
                <>No cycle has been closed yet, so nothing is marked that way.</>
              )}{' '}
              Those weeks are greyed, never flagged.
            </PerfNote>
            <PerfNote icon={<DotGlyph />}>
              A <strong>reopened</strong> cycle correctly returns to <em>Unclosed</em> — reopening
              archives the declaration and frees the week, so it genuinely has none again until
              it is closed a second time.
            </PerfNote>
            <PerfNote icon={<DotGlyph />}>
              <strong>&quot;Payable&quot; excludes the Excluded tab.</strong> People with no
              bank, no rate, a wizard exclusion or a USD track were set aside on purpose, so
              counting them as unpaid would turn a deliberate hold into an apparent failure.
              Unpaid = Pending + Problem + Threshold.
            </PerfNote>
            <PerfNote icon={<DotGlyph />}>
              <strong>Outstanding is an audit cross-check, never a rate.</strong> It reads{' '}
              <span className="font-mono">disbursement_records</span>, which counts excluded
              people too — so it is normally larger than Unpaid, and that is not a bug.
            </PerfNote>
            <PerfNote icon={<DotGlyph />}>
              These are <strong>frozen declarations</strong>. A cycle&apos;s numbers are what
              the clerk approved at close time and do not move afterwards, even if money is
              paid later.
            </PerfNote>
            {inventoryError && (
              <PerfNote icon={<DotGlyph />}>
                <span className="text-amber-700 dark:text-amber-400">
                  <strong>The cycle list may be incomplete</strong> — reading the dispatch and
                  ledger tables failed, so unclosed cycles could be missing. Every rate above is
                  still correct (they come from the close-out records).{' '}
                  <span className="font-mono text-[11px]">{inventoryError}</span>
                </span>
              </PerfNote>
            )}
            {unreadable.length > 0 && (
              <PerfNote icon={<DotGlyph />}>
                <span className="text-amber-700 dark:text-amber-400">
                  <strong>{unreadable.length}</strong>{' '}
                  {unreadable.length === 1 ? 'close-out record' : 'close-out records'} could
                  not be parsed and {unreadable.length === 1 ? 'is' : 'are'} missing from every
                  number above.
                </span>
              </PerfNote>
            )}
          </div>
        </>
      ) : null}
    </PerfShell>
  );
}

/**
 * The declaration status of one cycle.
 *
 * `unclosed` is amber because it is genuinely actionable — a cycle that could
 * have been closed and was not. `pre_closeout` is deliberately NEUTRAL grey:
 * those weeks predate the close-out feature and could not have been closed, so
 * colouring them as a problem would blame a clerk for a calendar.
 */
function StatusCell({ row }: { row: CyclePerformanceRow }) {
  if (row.status === 'closed') {
    return (
      <span
        className="inline-flex items-center gap-1.5 text-[11px] text-zinc-600 dark:text-zinc-300"
        title={row.closedAt ? `Closed ${row.closedAt.slice(0, 10)}` : undefined}
      >
        <span className="inline-block h-1.5 w-1.5 rounded-full bg-zinc-800 dark:bg-zinc-300" />
        Closed
        {row.closedAt && (
          <span className="font-mono text-[10px] tabular-nums text-zinc-400 dark:text-zinc-500">
            {row.closedAt.slice(0, 10)}
          </span>
        )}
      </span>
    );
  }
  if (row.status === 'unclosed') {
    return (
      <span
        className="inline-flex items-center gap-1.5 text-[11px] font-medium text-amber-700 dark:text-amber-400"
        title="This cycle was never closed from Payment Dispatch (or was closed and then reopened). Its payments are real, but nothing recorded who was still owed — so it has no rate."
      >
        <span className="inline-block h-1.5 w-1.5 rounded-full bg-amber-500" />
        Unclosed
      </span>
    );
  }
  return (
    <span
      className="inline-flex items-center gap-1.5 text-[11px] text-zinc-400 dark:text-zinc-500"
      title="This cycle ended before the first close-out was ever filed. It could not have been closed — the feature did not exist yet."
    >
      <span className="inline-block h-1.5 w-1.5 rounded-full bg-zinc-300 dark:bg-zinc-600" />
      Before close-outs
    </span>
  );
}

function SectionLabel({ children }: { children: React.ReactNode }) {
  return (
    <h4 className="text-[10px] font-semibold uppercase tracking-[0.14em] text-zinc-400 dark:text-zinc-500">
      {children}
    </h4>
  );
}

function Th({
  children,
  className,
  title,
}: {
  children: React.ReactNode;
  className?: string;
  title?: string;
}) {
  return (
    <th
      title={title}
      className={cn('px-3 py-2 text-right font-medium', className)}
      scope="col"
    >
      {children}
    </th>
  );
}

function Td({
  children,
  className,
  strong,
  muted,
}: {
  children: React.ReactNode;
  className?: string;
  strong?: boolean;
  muted?: boolean;
}) {
  return (
    <td
      className={cn(
        'px-3 py-2 text-right font-mono tabular-nums',
        strong
          ? 'font-semibold text-zinc-900 dark:text-zinc-100'
          : muted
            ? 'text-zinc-400 dark:text-zinc-500'
            : 'text-zinc-700 dark:text-zinc-300',
        className,
      )}
    >
      {children}
    </td>
  );
}

/* ── Glyphs. Inline so the tab carries no icon-import weight of its own. ── */

function svgProps(size = 'h-3.5 w-3.5') {
  return {
    viewBox: '0 0 24 24',
    fill: 'none',
    stroke: 'currentColor',
    strokeWidth: 2,
    strokeLinecap: 'round' as const,
    strokeLinejoin: 'round' as const,
    className: size,
    'aria-hidden': true,
  };
}

function WalletGlyph() {
  return (
    <svg {...svgProps('h-4 w-4')}>
      <path d="M19 7V5a2 2 0 0 0-2-2H5a2 2 0 0 0 0 4h14a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V5" />
      <path d="M16 12h.01" />
    </svg>
  );
}

function TargetGlyph() {
  return (
    <svg {...svgProps()}>
      <circle cx="12" cy="12" r="9" />
      <circle cx="12" cy="12" r="5" />
      <circle cx="12" cy="12" r="1" />
    </svg>
  );
}

function CheckGlyph() {
  return (
    <svg {...svgProps()}>
      <path d="M20 6 9 17l-5-5" />
    </svg>
  );
}

function AlertGlyph() {
  return (
    <svg {...svgProps()}>
      <path d="M12 9v4" />
      <path d="M12 17h.01" />
      <path d="M10.29 3.86 1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.71 3.86a2 2 0 0 0-3.42 0Z" />
    </svg>
  );
}

function OpenGlyph() {
  return (
    <svg {...svgProps()}>
      <rect width="18" height="13" x="3" y="8" rx="2" />
      <path d="M7 8V6a5 5 0 0 1 9.5-2" />
    </svg>
  );
}

function ArchiveGlyph() {
  return (
    <svg {...svgProps()}>
      <rect width="20" height="5" x="2" y="3" rx="1" />
      <path d="M4 8v11a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8" />
      <path d="M10 12h4" />
    </svg>
  );
}

function DotGlyph() {
  return (
    <span className="mt-[5px] inline-block h-1 w-1 shrink-0 rounded-full bg-zinc-300 dark:bg-zinc-600" />
  );
}
