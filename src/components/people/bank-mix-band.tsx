'use client';

import { useMemo } from 'react';
import { motion, useReducedMotion } from 'motion/react';
import { Landmark, Send } from 'lucide-react';
import { StatCard, StatSub, StatValue } from '@/components/accounting/kpi-stat-card';
import { railDistribution, type BankMix, type BankMixSlice, type BankNameSlice } from '@/lib/people/bank-mix';

/**
 * The two KPI cards above the People → Bank changes feed, in the Payment Catalog
 * Summary band's card idiom (same shared `StatCard` — see kpi-stat-card.tsx).
 *
 *   1. Preferred bank · send-from — which processor Accounting pays OUT on.
 *   2. Receiving bank — the payee's own account where the money LANDS.
 *
 * These are two of the three concepts docs/features/bank-preferred-routing.md
 * forbids conflating, sitting side by side, so the labels do real work: the first
 * card is a RAIL, never an employee's bank; the second is a BANK, never a rail.
 *
 * Both fold from one roster-wide `BankMix` (Payment Dispatch's own routing
 * precedence) — deliberately NOT from the feed below, whose `processor` column is
 * the employee's receive election and whose rows are a capped newest-first slice.
 * The band therefore describes the WHOLE roster while the feed describes recent
 * edits, so each card's headline states its own denominator rather than leaving
 * the two to be read as one number.
 *
 * Each card carries a full distribution: one row per processor (every rail the
 * system knows, zero-count ones included) and one per receiving bank, with the
 * share bar, count and percentage on the same line. The headline figure is the
 * card's denominator, so it never restates the leading row.
 */

/** Receiving banks listed individually before the remainder folds into one row.
 *  Matches the rail count, so the two cards stay about the same height. */
const BANK_ROWS = 6;
/** How many folded names the remainder row's hover title spells out. The roster
 *  carries ~100 distinct bank spellings; a 94-line tooltip is useless. */
const TITLE_CAP = 15;
/** Row key for the folded remainder — never a real bank's grouping key. */
const REST_KEY = '__rest__';

function num(n: number): string {
  return n.toLocaleString('en-US');
}

/**
 * A bank's send-from rails, quietest useful form: "wise 92 · wires 42". This is the
 * link between the two cards — one bank receives from several rails at once — and
 * the reason the receiving card is not just a name list.
 */
function railSub(bank: BankNameSlice): string | undefined {
  if (bank.byRail.length === 0) return undefined;
  return bank.byRail.map((r) => `${r.label.toLowerCase()} ${num(r.count)}`).join(' · ');
}

function pctLabel(n: number, of: number): string {
  if (of <= 0) return '—';
  const p = (n / of) * 100;
  // Never round a real, non-zero share down to a bare "0%".
  if (p > 0 && p < 1) return '<1%';
  return `${Math.round(p)}%`;
}

/**
 * One distribution row: name, share bar, count, share. The bar absorbs whatever
 * width is left, so the same row reads at 360px and at 780px.
 */
function DistRow({
  slice,
  of,
  fill,
  wide,
  index,
  reduce,
  title,
  sub,
}: {
  slice: BankMixSlice;
  of: number;
  /** Tailwind background for the filled portion — the card's own tone. */
  fill: string;
  /** Bank names run long; rail names don't. Widens the name column. */
  wide?: boolean;
  index: number;
  reduce: boolean;
  title?: string;
  /** Second, quieter line under the name — a bank's send-from rail split. */
  sub?: string;
}) {
  const share = of > 0 ? (slice.count / of) * 100 : 0;
  const empty = slice.count === 0;
  return (
    <li className={`flex items-center gap-2.5 ${empty ? 'opacity-55' : ''}`}>
      <span
        className={`shrink-0 ${wide ? 'w-[7rem] xl:w-[12rem]' : 'w-[4.75rem]'}`}
        title={title ?? slice.label}
      >
        <span className="block truncate text-[11.5px] text-zinc-700 dark:text-zinc-200">{slice.label}</span>
        {sub && (
          <span className="block truncate text-[10px] tabular-nums text-zinc-600 dark:text-zinc-400">{sub}</span>
        )}
      </span>
      <span
        aria-hidden
        className="h-1.5 min-w-[1.5rem] flex-1 overflow-hidden rounded-full bg-zinc-900/[0.08] dark:bg-white/10"
      >
        {!empty && (
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
        {num(slice.count)}
      </span>
      <span className="w-9 shrink-0 text-right text-[11px] tabular-nums text-zinc-600 dark:text-zinc-300">
        {pctLabel(slice.count, of)}
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

export function BankMixBand({
  mix,
  scope,
}: {
  mix: BankMix | null;
  /** Department name when the band is scoped to one, else null for the whole
   *  roster. Printed on both cards, because a scoped figure that looks org-wide
   *  is the one way this band could mislead. */
  scope?: string | null;
}) {
  const reduce = !!useReducedMotion();
  const scoped = scope ? ` · ${scope}` : '';

  // Every rail worth a row: anyone with payees on it (retired or not) plus the
  // still-offered rails at zero, so "Hurupay: 0" reads as nobody rather than
  // vanishing. See railDistribution.
  const rails = useMemo(() => (mix ? railDistribution(mix.sending) : []), [mix]);

  // The roster drives both cards, so until it lands there is nothing honest to
  // put in them: placeholders, never a zero that reads as a real figure.
  if (!mix) {
    return (
      <Band>
        <StatCard tone="accent" icon={Send} label={`Preferred bank · send-from${scoped}`}>
          <StatValue>—</StatValue>
          <StatSub>{scope ? `Nobody on the roster in ${scope}` : 'Roster still loading'}</StatSub>
        </StatCard>
        <StatCard tone="teal" icon={Landmark} label={`Receiving bank${scoped}`}>
          <StatValue>—</StatValue>
          <StatSub>{scope ? `Nobody on the roster in ${scope}` : 'Roster still loading'}</StatSub>
        </StatCard>
      </Band>
    );
  }

  const routed = mix.total - mix.unrouted;
  const named = mix.bankRail - mix.missingBank;

  const topBanks = mix.receiving.slice(0, BANK_ROWS);
  const restBanks = mix.receiving.slice(BANK_ROWS);
  const restTotal = restBanks.reduce((s, r) => s + r.count, 0);
  const bankRows: BankNameSlice[] = restBanks.length
    ? [
        ...topBanks,
        { key: REST_KEY, label: `${num(restBanks.length)} more names`, count: restTotal, byRail: [] },
      ]
    : topBanks;
  const restTitle = restBanks
    .slice(0, TITLE_CAP)
    .map((r) => `${r.label} — ${num(r.count)}`)
    .concat(restBanks.length > TITLE_CAP ? [`…and ${num(restBanks.length - TITLE_CAP)} more`] : [])
    .join('\n');

  return (
    <Band>
      <StatCard tone="accent" icon={Send} label={`Preferred bank · send-from${scoped}`}>
        <StatValue>{num(routed)}</StatValue>
        <StatSub>
          {routed === 1 ? 'person on a send-from rail' : 'people on a send-from rail'}
          {mix.unrouted > 0 && ` · ${num(mix.unrouted)} unrouted`}
        </StatSub>

        {routed > 0 ? (
          <ul className="mt-3 space-y-1.5">
            {rails.map((r, i) => (
              <DistRow
                key={r.key}
                slice={r}
                of={routed}
                fill="bg-orange-500/70 dark:bg-blue-400/70"
                index={i}
                reduce={reduce}
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

      <StatCard tone="teal" icon={Landmark} label={`Receiving bank${scoped}`}>
        <StatValue>{num(named)}</StatValue>
        <StatSub>
          {named === 1 ? 'account with a receiving bank' : 'accounts with a receiving bank'}
          {` · ${num(mix.distinctBanks)} ${mix.distinctBanks === 1 ? 'name' : 'names'}`}
        </StatSub>

        {bankRows.length > 0 ? (
          <ul className="mt-3 space-y-1.5">
            {bankRows.map((b, i) => (
              <DistRow
                key={b.key}
                slice={b}
                of={named}
                fill="bg-teal-500/70 dark:bg-teal-400/70"
                wide
                index={i}
                reduce={reduce}
                title={b.key === REST_KEY ? restTitle : undefined}
                sub={railSub(b)}
              />
            ))}
          </ul>
        ) : (
          <p className="mt-3 text-[11.5px] text-zinc-600 dark:text-zinc-300">
            {mix.wallet > 0
              ? `Everyone routed is on a wallet: ${num(mix.wallet)} with no receiving bank.`
              : 'No receiving bank on file yet.'}
          </p>
        )}

        <Footnote>
          Counted as typed: spellings are never merged.
          {mix.wallet > 0 && <> {num(mix.wallet)} more are paid to a wallet, which has no receiving bank.</>}
          {mix.missingBank > 0 && (
            <>
              {' '}
              <Flag>{num(mix.missingBank)} on a bank rail with no bank on file.</Flag>
            </>
          )}
        </Footnote>
      </StatCard>
    </Band>
  );
}
