'use client';

import { motion, useReducedMotion } from 'motion/react';
import { Landmark, Send } from 'lucide-react';
import { StatCard, StatSub, StatValue } from '@/components/accounting/kpi-stat-card';
import type { RailMix, RailSlice } from '@/lib/people/rail-mix';

/**
 * The two KPI cards above the People → Bank changes feed, in the Payment Catalog
 * Summary band's card idiom (same shared `StatCard` — see kpi-stat-card.tsx).
 *
 *   1. **Preferred bank · send-from** — the rail Accounting pays OUT on, one row
 *      per processor with its headcount and share.
 *   2. **Receiving details on file** — the SAME rails in the SAME order, counting
 *      how many of each are actually payable there, plus what that rail needs.
 *
 * Same rows, two facts, and no bank names (Kane, 2026-08-19). A receiving *bank* is
 * free text carrying ~100 spellings of maybe 30 banks, and it is not the unit
 * anyone pays on: GoTyme arrives via Wise or Wires rather than being a category of
 * its own. The rail carries the meaning, so the second card asks the useful
 * question instead — of the people on Wires, how many can we actually pay?
 *
 * Both fold from one roster-wide `RailMix`, off the same `processor` / `hasBanking`
 * pair that paints the roster chip — deliberately NOT from the feed below, whose
 * `processor` column is the employee's receive election and whose rows are a capped
 * newest-first slice. The band describes the whole roster (or one department) while
 * the feed describes recent edits, so each card states its own denominator.
 */

function num(n: number): string {
  return n.toLocaleString('en-US');
}

function pctLabel(n: number, of: number): string {
  if (of <= 0) return '—';
  const p = (n / of) * 100;
  // Never round a real, non-zero share down to a bare "0%".
  if (p > 0 && p < 1) return '<1%';
  return `${Math.round(p)}%`;
}

/**
 * One rail row: name, bar, count, share. `of` is the denominator the bar and the
 * percentage are read against — total routed on the send-from card, the rail's own
 * headcount on the receiving card, so a short bar there means a real gap.
 */
function RailRow({
  label,
  value,
  of,
  fill,
  caption,
  index,
  reduce,
  dim,
  title,
}: {
  label: string;
  value: number;
  of: number;
  /** Tailwind background for the filled portion — the card's own tone. */
  fill: string;
  /** Quiet second line under the name: what the rail needs on file. */
  caption?: string;
  index: number;
  reduce: boolean;
  /** Renders the row muted — nobody is on this rail. */
  dim?: boolean;
  title?: string;
}) {
  const share = of > 0 ? (value / of) * 100 : 0;
  return (
    <li className={`flex items-center gap-2.5 ${dim ? 'opacity-55' : ''}`} title={title}>
      <span className="w-[5.25rem] shrink-0">
        <span className="block truncate text-[11.5px] text-zinc-700 dark:text-zinc-200">{label}</span>
        {caption && (
          <span className="block truncate text-[9.5px] text-zinc-600 dark:text-zinc-400">{caption}</span>
        )}
      </span>
      <span
        aria-hidden
        className="h-1.5 min-w-[1.5rem] flex-1 overflow-hidden rounded-full bg-zinc-900/[0.08] dark:bg-white/10"
      >
        {share > 0 && (
          <motion.span
            className={`block h-full rounded-full ${fill}`}
            initial={reduce ? false : { width: 0 }}
            animate={{ width: `${share}%` }}
            transition={
              reduce ? { duration: 0 } : { duration: 0.24, delay: index * 0.02, ease: [0.22, 1, 0.36, 1] }
            }
          />
        )}
      </span>
      <span className="w-10 shrink-0 text-right text-[12px] font-semibold tabular-nums text-zinc-900 dark:text-white">
        {num(value)}
      </span>
      <span className="w-9 shrink-0 text-right text-[11px] tabular-nums text-zinc-600 dark:text-zinc-300">
        {pctLabel(value, of)}
      </span>
    </li>
  );
}

function Footnote({ children }: { children: React.ReactNode }) {
  return <p className="mt-3 text-[10.5px] leading-snug text-zinc-600 dark:text-zinc-300">{children}</p>;
}

function Flag({ children }: { children: React.ReactNode }) {
  return <span className="font-medium text-amber-800 dark:text-amber-300">{children}</span>;
}

function Band({ children }: { children: React.ReactNode }) {
  return <div className="mb-4 grid grid-cols-1 gap-3 lg:grid-cols-2">{children}</div>;
}

/** A rail carrying nobody still holds a row, muted, so a live processor with zero
 *  people reads as "nobody" instead of vanishing off the card. */
function isDim(rail: RailSlice): boolean {
  return rail.count === 0;
}

export function RailMixBand({
  mix,
  scope,
}: {
  mix: RailMix | null;
  /** Department name when the band is scoped to one, else null for the whole
   *  roster. Printed on both cards, because a scoped figure that looks org-wide is
   *  the one way this band could mislead. */
  scope?: string | null;
}) {
  const reduce = !!useReducedMotion();
  const scoped = scope ? ` · ${scope}` : '';

  // The roster drives both cards, so until it lands there is nothing honest to put
  // in them: placeholders, never a zero that reads as a real figure.
  if (!mix) {
    return (
      <Band>
        <StatCard tone="accent" icon={Send} label={`Preferred bank · send-from${scoped}`}>
          <StatValue>—</StatValue>
          <StatSub>{scope ? `Nobody on the roster in ${scope}` : 'Roster still loading'}</StatSub>
        </StatCard>
        <StatCard tone="teal" icon={Landmark} label={`Receiving details on file${scoped}`}>
          <StatValue>—</StatValue>
          <StatSub>{scope ? `Nobody on the roster in ${scope}` : 'Roster still loading'}</StatSub>
        </StatCard>
      </Band>
    );
  }

  const missing = mix.routed - mix.payable;

  return (
    <Band>
      <StatCard tone="accent" icon={Send} label={`Preferred bank · send-from${scoped}`}>
        <StatValue>{num(mix.routed)}</StatValue>
        <StatSub>
          {mix.routed === 1 ? 'person on a send-from rail' : 'people on a send-from rail'}
          {mix.unrouted > 0 && ` · ${num(mix.unrouted)} unrouted`}
        </StatSub>

        {mix.routed > 0 ? (
          <ul className="mt-3 space-y-1.5">
            {mix.rails.map((r, i) => (
              <RailRow
                key={r.key}
                label={r.label}
                value={r.count}
                of={mix.routed}
                fill="bg-orange-500/70 dark:bg-blue-400/70"
                index={i}
                reduce={reduce}
                dim={isDim(r)}
                title={`${r.label} — ${num(r.count)} of ${num(mix.routed)} routed`}
              />
            ))}
          </ul>
        ) : (
          <p className="mt-3 text-[11.5px] text-zinc-600 dark:text-zinc-300">
            {mix.total > 0
              ? `No send-from rail resolves for any of ${num(mix.total)} people.`
              : 'No people on the roster.'}
          </p>
        )}

        <Footnote>
          The rail Accounting pays OUT on, resolved with Payment Dispatch&apos;s precedence
          (Bank&nbsp;Preferred → Disbursement pick → rates sheet), not the employee&apos;s own bank.
          {mix.unrouted > 0 && (
            <>
              {' '}
              <Flag>{num(mix.unrouted)} unrouted</Flag>: no rail resolves, so dispatch excludes them.
            </>
          )}
        </Footnote>
      </StatCard>

      <StatCard tone="teal" icon={Landmark} label={`Receiving details on file${scoped}`}>
        <StatValue>{num(mix.payable)}</StatValue>
        <StatSub>
          {`payable of ${num(mix.routed)} routed`}
          {missing > 0 && ` · ${num(missing)} short`}
        </StatSub>

        {mix.routed > 0 ? (
          <ul className="mt-3 space-y-1.5">
            {mix.rails.map((r, i) => (
              <RailRow
                key={r.key}
                label={r.label}
                value={r.payable}
                of={r.count}
                fill="bg-teal-500/70 dark:bg-teal-400/70"
                caption={r.requires}
                index={i}
                reduce={reduce}
                dim={isDim(r)}
                title={
                  r.count === 0
                    ? `${r.label} — nobody routed here`
                    : `${r.label} — ${num(r.payable)} of ${num(r.count)} have ${r.requires} on file`
                }
              />
            ))}
          </ul>
        ) : (
          <p className="mt-3 text-[11.5px] text-zinc-600 dark:text-zinc-300">
            Nobody is routed, so there is nothing to pay yet.
          </p>
        )}

        <Footnote>
          Judged the way Payment Dispatch actually pays, so this agrees with the roster&apos;s
          Missing-bank-info list: {num(mix.wallet)} on a wallet rail need their wallet email,{' '}
          {num(mix.bankRail)} on a bank rail need a bank and account.
          {missing > 0 && (
            <>
              {' '}
              <Flag>{num(missing)} cannot be paid on their rail today.</Flag>
            </>
          )}
        </Footnote>
      </StatCard>
    </Band>
  );
}
