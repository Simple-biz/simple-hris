/**
 * Admin → Diagnostics → **HR Pipeline**.
 *
 * "Of the people HR listed for a hiring week, how many reached the Global
 * Master List?" — per week and per month.
 *
 * ── The three things this screen must never do ─────────────────────────────
 * 1. **Never divide by `listed`.** A listed hire with no `hr_pending_employees`
 *    row cannot carry a promoted stamp, so a rate over `listed` could never
 *    reach 100% and would read as a pipeline failure when it is an intake gap.
 *    The gap gets its own KPI card ("Never staged") instead.
 * 2. **Never print 0% for a week with nothing staged.** It is unmeasurable and
 *    gets a note (Kane, 2026-08-26). Every checklist week before 2026-06-07
 *    looks like this, as does the current week.
 * 3. **Never blend this with the payroll tab.** Separate surfaces, separate
 *    accents, separate scoreboards (Kane, 2026-09-04).
 *
 * Unlike the payroll tab's frozen close-outs, this is a LIVE read and its older
 * weeks DECAY — offboarding removes `hr_pending_employees` rows. The read stamp
 * and the footnote exist because of that.
 *
 * See `src/lib/admin/hr-pipeline-performance.ts` and
 * `docs/features/diagnostics-performance-tabs.md`.
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
import type { HrPipelineSummary } from '@/lib/admin/hr-pipeline-performance';

interface ApiResponse {
  generatedAt: string;
  pipeline: HrPipelineSummary | null;
  error: string | null;
}

const ACCENT_KEY = 'hr' as const;
const POLL_MS = 120_000;

export default function HrPipelinePerformance() {
  const [data, setData] = React.useState<HrPipelineSummary | null>(null);
  const [generatedAt, setGeneratedAt] = React.useState<string | null>(null);
  const [error, setError] = React.useState<string | null>(null);
  const [refreshing, setRefreshing] = React.useState(false);
  const [everLoaded, setEverLoaded] = React.useState(false);

  const load = React.useCallback(async () => {
    setRefreshing(true);
    try {
      const res = await fetch('/api/admin/diagnostics/hr-pipeline', { cache: 'no-store' });
      const body = (await res.json().catch(() => null)) as ApiResponse | null;
      if (!res.ok || !body || body.error || !body.pipeline) {
        setError(body?.error ?? `Request failed (HTTP ${res.status})`);
      } else {
        setData(body.pipeline);
        setGeneratedAt(body.generatedAt);
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

  /** The funnel, in order. Each leg's width is relative to `listed`. */
  const funnel = React.useMemo(() => {
    if (!totals) return [];
    const base = Math.max(totals.listed, totals.staged, 1);
    return [
      { key: 'listed', label: 'Listed by HR', value: totals.listed },
      { key: 'staged', label: 'Staged for onboarding', value: totals.staged },
      { key: 'submitted', label: 'Onboarding submitted', value: totals.submitted },
      { key: 'attended', label: 'Attended orientation', value: totals.attended },
      { key: 'promoted', label: 'On the master list', value: totals.promoted },
    ].map((leg) => ({ ...leg, share: leg.value / base }));
  }, [totals]);

  return (
    <PerfShell
      accent={ACCENT_KEY}
      title="HR Pipeline Performance"
      subtitle="Of the people HR listed for a hiring week, how many reached the Global Master List. The week is HR's New Hire Checklist week — never the hire's own dates."
      icon={<UsersGlyph />}
      generatedAt={generatedAt}
      loading={!everLoaded && !data}
      loadingTitle="Reading the hiring pipeline"
      loadingDetail="Checklist weeks, staged hires and their stamps."
      tabKey="hr"
      refreshing={refreshing}
      error={error}
      onRefresh={() => void load()}
    >
      {data && totals ? (
        <>
          {/* ── KPI row — HR's four numbers ── */}
          <div className="grid grid-cols-2 gap-2 sm:gap-3 lg:grid-cols-4">
            <KpiCard
              accent={ACCENT_KEY}
              label="Made the master list"
              value={pct(totals.rate)}
              sub={`${num(totals.promoted)} of ${num(totals.staged)} staged`}
              icon={<TargetGlyph />}
              title="Promoted ÷ staged, pooled across every measurable week. Never over 'listed' — a hire who was never staged cannot be promoted."
            />
            <KpiCard
              accent={ACCENT_KEY}
              tone="neutral"
              label="Listed by HR"
              value={num(totals.listed)}
              sub={
                totals.firstWeek && totals.lastWeek
                  ? `${totals.firstWeek} → ${totals.lastWeek}`
                  : 'no checklist weeks'
              }
              icon={<ListGlyph />}
            />
            <KpiCard
              accent={ACCENT_KEY}
              tone={totals.notStaged > 0 ? 'warn' : 'neutral'}
              label="Never staged"
              value={num(totals.notStaged)}
              sub="listed, no onboarding row"
              icon={<GapGlyph />}
              title="Listed on the checklist but never reached hr_pending_employees. These can never be marked attended or promoted, so they are excluded from the rate and counted here instead — an intake gap, not a pipeline failure."
            />
            <KpiCard
              accent={ACCENT_KEY}
              tone={totals.stillOpen > 0 ? 'warn' : 'neutral'}
              label="Still open"
              value={num(totals.stillOpen)}
              sub={`${num(totals.noShow)} no-show`}
              icon={<ClockGlyph />}
              title="Staged, not promoted, and not marked a no-show — still moving, or stalled."
            />
          </div>

          {/* ── The funnel ── */}
          <section className="flex flex-col gap-2">
            <SectionLabel>The funnel, all weeks</SectionLabel>
            <div className="flex flex-col gap-2.5 rounded-xl border border-zinc-200 bg-white/80 p-3.5 shadow-sm backdrop-blur-sm dark:border-zinc-800 dark:bg-zinc-950/40">
              {funnel.map((leg, i) => (
                <div key={leg.key} className="flex items-center gap-3">
                  <span className="w-[11.5rem] shrink-0 truncate text-[11px] text-zinc-600 dark:text-zinc-400">
                    {leg.label}
                  </span>
                  <div className="min-w-0 flex-1">
                    <RateBar rate={leg.share} accent={ACCENT_KEY} height="h-2.5" />
                  </div>
                  <span className="w-[4.5rem] shrink-0 text-right font-mono text-[12px] font-semibold tabular-nums text-zinc-900 dark:text-zinc-100">
                    {num(leg.value)}
                  </span>
                  <span className="w-[3.5rem] shrink-0 text-right font-mono text-[10px] tabular-nums text-zinc-400 dark:text-zinc-500">
                    {i === 0 ? '' : pct(leg.share, 0)}
                  </span>
                </div>
              ))}
              <PerfNote>
                Percentages are against <strong>Listed</strong> so the drop-off is visible end
                to end. The headline rate above is <strong>promoted ÷ staged</strong> — the
                only denominator a hire can actually be measured against.
              </PerfNote>
            </div>
          </section>

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
                        {m.weeks} {m.weeks === 1 ? 'week' : 'weeks'}
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
                      {!m.measurable && <UnmeasurableChip>nothing staged</UnmeasurableChip>}
                    </div>
                    <RateBar rate={m.rate} accent={ACCENT_KEY} />
                    <div className="flex flex-wrap items-center gap-x-3 gap-y-0.5 text-[11px] tabular-nums text-zinc-500 dark:text-zinc-400">
                      <span>{num(m.listed)} listed</span>
                      <span>{num(m.staged)} staged</span>
                      <span>{num(m.promoted)} promoted</span>
                    </div>
                  </div>
                ))}
              </div>
            </section>
          )}

          {/* ── Per-week table ── */}
          <section className="flex flex-col gap-2">
            <SectionLabel>Every hiring week</SectionLabel>
            <div className="overflow-x-auto rounded-xl border border-zinc-200 bg-white/80 backdrop-blur-sm dark:border-zinc-800 dark:bg-zinc-950/40">
              <table className="w-full min-w-[50rem] border-collapse text-[12px]">
                <thead>
                  <tr className="border-b border-zinc-100 text-[10px] uppercase tracking-[0.12em] text-zinc-500 dark:border-zinc-800/60 dark:text-zinc-400">
                    <Th className="text-left">Week</Th>
                    <Th>Listed</Th>
                    <Th>Staged</Th>
                    <Th title="Listed but never reached hr_pending_employees. Excluded from the rate.">
                      Never staged
                    </Th>
                    <Th>Submitted</Th>
                    <Th>Attended</Th>
                    <Th>Promoted</Th>
                    <Th className="w-[9rem]">Rate</Th>
                  </tr>
                </thead>
                <tbody>
                  {data.weeks.map((w) => (
                    <tr
                      key={`${w.onChecklist ? 'w' : 'off'}-${w.weekStart}`}
                      className={cn(
                        'border-b border-zinc-50 transition-colors duration-150 last:border-0 hover:bg-zinc-50/70 motion-reduce:transition-none dark:border-zinc-900 dark:hover:bg-zinc-900/40',
                        !w.onChecklist && 'bg-zinc-50/40 dark:bg-zinc-900/20',
                      )}
                    >
                      <td className="px-3 py-2">
                        <div
                          className={cn(
                            'font-medium',
                            w.onChecklist
                              ? 'text-zinc-900 dark:text-zinc-100'
                              : 'text-zinc-500 dark:text-zinc-400',
                          )}
                        >
                          {w.label}
                        </div>
                        {w.onChecklist && (
                          <div className="font-mono text-[10px] tabular-nums text-zinc-400 dark:text-zinc-500">
                            {w.weekStart}
                          </div>
                        )}
                      </td>
                      <Td>{w.listed || '—'}</Td>
                      <Td strong>{num(w.staged)}</Td>
                      <Td
                        className={
                          w.notStaged > 0 ? 'text-amber-700 dark:text-amber-400' : undefined
                        }
                      >
                        {w.notStaged || '—'}
                      </Td>
                      <Td>{num(w.submitted)}</Td>
                      <Td>{num(w.attended)}</Td>
                      <Td strong>{num(w.promoted)}</Td>
                      <td className="px-3 py-2">
                        {w.measurable ? (
                          <div className="flex items-center gap-2">
                            <span className="w-[3.2rem] shrink-0 text-right font-mono font-semibold tabular-nums text-zinc-900 dark:text-zinc-100">
                              {pct(w.rate)}
                            </span>
                            <RateBar rate={w.rate} accent={ACCENT_KEY} className="flex-1" />
                          </div>
                        ) : (
                          <UnmeasurableChip>nothing staged</UnmeasurableChip>
                        )}
                      </td>
                    </tr>
                  ))}
                  {data.weeks.length === 0 && (
                    <tr>
                      <td
                        colSpan={8}
                        className="px-3 py-6 text-center text-[12px] text-zinc-500 dark:text-zinc-400"
                      >
                        No hiring weeks on the New Hire Checklist yet.
                      </td>
                    </tr>
                  )}
                </tbody>
              </table>
            </div>
          </section>

          {/* ── The caveats. ── */}
          <div className="flex flex-col gap-1.5 rounded-lg border border-zinc-200/70 bg-zinc-50/60 px-3 py-2.5 dark:border-zinc-800/70 dark:bg-zinc-900/30">
            <PerfNote icon={<DotGlyph />}>
              <strong>The rate is over &quot;staged&quot;, never &quot;listed&quot;.</strong> A
              hire HR listed who never reached the onboarding table can never be marked
              attended or promoted, so including them would cap every week below 100% and
              read as a pipeline failure. That gap is the{' '}
              <strong>Never staged</strong> card instead.
            </PerfNote>
            <PerfNote icon={<DotGlyph />}>
              <strong>A week with nothing staged has no percentage</strong> — it is not 0%. A
              freshly-listed current week always looks like this.
            </PerfNote>
            <PerfNote icon={<DotGlyph />}>
              <strong>The week is HR&apos;s checklist week</strong>{' '}
              (<span className="font-mono">period_start</span>, joined on personal email), not
              the hire&apos;s own dates — deriving it from those filed 46% of hires one week
              early.
            </PerfNote>
            <PerfNote icon={<DotGlyph />}>
              <strong>These numbers are live and older weeks drift down.</strong> Offboarding
              removes onboarding rows, so a past week&apos;s &quot;staged&quot; count shrinks
              over time. Unlike the payroll tab, nothing here is a frozen record — this is
              what the database says right now.
            </PerfNote>
            {totals.offChecklist > 0 && (
              <PerfNote icon={<DotGlyph />}>
                <strong>{num(totals.offChecklist)}</strong> staged{' '}
                {totals.offChecklist === 1 ? 'hire matches' : 'hires match'} no checklist row
                at all. They keep their own row at the bottom of the table and are counted in
                the totals — never folded into a real week, never dropped.
              </PerfNote>
            )}
          </div>
        </>
      ) : null}
    </PerfShell>
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
    <th title={title} className={cn('px-3 py-2 text-right font-medium', className)} scope="col">
      {children}
    </th>
  );
}

function Td({
  children,
  className,
  strong,
}: {
  children: React.ReactNode;
  className?: string;
  strong?: boolean;
}) {
  return (
    <td
      className={cn(
        'px-3 py-2 text-right font-mono tabular-nums',
        strong
          ? 'font-semibold text-zinc-900 dark:text-zinc-100'
          : 'text-zinc-700 dark:text-zinc-300',
        className,
      )}
    >
      {children}
    </td>
  );
}

/* ── Glyphs ── */

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

function UsersGlyph() {
  return (
    <svg {...svgProps('h-4 w-4')}>
      <path d="M16 21v-2a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4v2" />
      <circle cx="9" cy="7" r="4" />
      <path d="M22 21v-2a4 4 0 0 0-3-3.87" />
      <path d="M16 3.13a4 4 0 0 1 0 7.75" />
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

function ListGlyph() {
  return (
    <svg {...svgProps()}>
      <path d="M8 6h13" />
      <path d="M8 12h13" />
      <path d="M8 18h13" />
      <path d="M3 6h.01" />
      <path d="M3 12h.01" />
      <path d="M3 18h.01" />
    </svg>
  );
}

function GapGlyph() {
  return (
    <svg {...svgProps()}>
      <path d="M12 3v4" />
      <path d="M12 17v4" />
      <path d="M5 12H3" />
      <path d="M21 12h-2" />
      <circle cx="12" cy="12" r="3" strokeDasharray="3 3" />
    </svg>
  );
}

function ClockGlyph() {
  return (
    <svg {...svgProps()}>
      <circle cx="12" cy="12" r="9" />
      <path d="M12 7v5l3 2" />
    </svg>
  );
}

function DotGlyph() {
  return (
    <span className="mt-[5px] inline-block h-1 w-1 shrink-0 rounded-full bg-zinc-300 dark:bg-zinc-600" />
  );
}
