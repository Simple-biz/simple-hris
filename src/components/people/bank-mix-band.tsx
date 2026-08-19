'use client';

import { Landmark, Send } from 'lucide-react';
import { StatCard, StatSub, StatValue, TONES } from '@/components/accounting/kpi-stat-card';
import type { BankMix, BankMixSlice } from '@/lib/people/bank-mix';

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
 * edits, so each card states its own denominator rather than leaving the two to
 * be read as one number.
 */

/** Chips beyond this many fold into a "+N more" chip with a title listing them. */
const CHIP_CAP = 4;
/** How many folded names that hover title spells out before "…and N more". The
 *  roster carries ~100 distinct bank spellings; a 96-line tooltip is useless. */
const TITLE_CAP = 15;

function pct(n: number, of: number): string {
  if (of <= 0) return '—';
  return `${Math.round((n / of) * 100)}%`;
}

function num(n: number): string {
  return n.toLocaleString('en-US');
}

function Chips({ slices, leadChip }: { slices: readonly BankMixSlice[]; leadChip: string }) {
  const shown = slices.slice(0, CHIP_CAP);
  const rest = slices.slice(CHIP_CAP);
  const restTotal = rest.reduce((s, r) => s + r.count, 0);
  return (
    <div className="mt-2 flex flex-wrap items-center gap-1">
      {/* Bank names are free text and run long ("Bank of the Philippine Islands
          (BPI)" is 36 chars and the roster holds worse), so the NAME truncates
          under a hover title and the count never does. */}
      {shown.map((s, i) => (
        <span
          key={s.key}
          title={`${s.label} — ${num(s.count)}`}
          className={
            i === 0
              ? `inline-flex max-w-full items-center gap-1 rounded-full px-1.5 py-0.5 text-[10px] font-semibold ${leadChip}`
              : 'inline-flex max-w-full items-center gap-1 rounded-full bg-zinc-500/10 px-1.5 py-0.5 text-[10px] font-semibold text-zinc-600 dark:bg-zinc-500/20 dark:text-zinc-300'
          }
        >
          <span className="max-w-[9.5rem] truncate">{s.label}</span>
          <span className="shrink-0 font-normal tabular-nums opacity-80">{num(s.count)}</span>
        </span>
      ))}
      {rest.length > 0 && (
        <span
          className="inline-flex shrink-0 items-center gap-1 rounded-full bg-zinc-500/10 px-1.5 py-0.5 text-[10px] font-semibold text-zinc-500 dark:bg-zinc-500/20 dark:text-zinc-400"
          title={rest
            .slice(0, TITLE_CAP)
            .map((r) => `${r.label} — ${num(r.count)}`)
            .concat(rest.length > TITLE_CAP ? [`…and ${num(rest.length - TITLE_CAP)} more`] : [])
            .join('\n')}
        >
          +{rest.length} more <span className="font-normal tabular-nums opacity-80">{num(restTotal)}</span>
        </span>
      )}
    </div>
  );
}

function Footnote({ children }: { children: React.ReactNode }) {
  return <p className="mt-2 text-[10.5px] leading-snug text-zinc-500 dark:text-zinc-400">{children}</p>;
}

function Flag({ children }: { children: React.ReactNode }) {
  return <span className="font-medium text-amber-700 dark:text-amber-400">{children}</span>;
}

function Band({ children }: { children: React.ReactNode }) {
  return <div className="mb-4 grid grid-cols-1 gap-3 sm:grid-cols-2">{children}</div>;
}

export function BankMixBand({ mix }: { mix: BankMix | null }) {
  // The roster drives both cards, so until it lands there is nothing honest to
  // put in them — placeholders, never a zero that reads as a real figure.
  if (!mix) {
    return (
      <Band>
        <StatCard tone="accent" icon={Send} label="Preferred bank · send-from">
          <StatValue>—</StatValue>
          <StatSub>Roster still loading</StatSub>
        </StatCard>
        <StatCard tone="teal" icon={Landmark} label="Receiving bank">
          <StatValue>—</StatValue>
          <StatSub>Roster still loading</StatSub>
        </StatCard>
      </Band>
    );
  }

  const routed = mix.total - mix.unrouted;
  const topRail = mix.sending[0] ?? null;
  const topBank = mix.receiving[0] ?? null;

  return (
    <Band>
      <StatCard tone="accent" icon={Send} label="Preferred bank · send-from">
        {topRail ? (
          <>
            <StatValue>{num(topRail.count)}</StatValue>
            <StatSub>
              <span className="font-medium text-zinc-700 dark:text-zinc-200">{topRail.label}</span>
              {` · ${pct(topRail.count, routed)} of ${num(routed)} routed people`}
            </StatSub>
            <Chips slices={mix.sending} leadChip={TONES.accent.chip} />
            <Footnote>
              The rail Accounting pays OUT on, resolved with Payment Dispatch&apos;s precedence
              (Bank&nbsp;Preferred → Disbursement pick → rates sheet) — not the employee&apos;s own bank.
              {mix.unrouted > 0 && (
                <>
                  {' '}
                  <Flag>{num(mix.unrouted)} unrouted</Flag> — no rail resolves, so dispatch excludes them.
                </>
              )}
            </Footnote>
          </>
        ) : (
          <>
            <StatValue>—</StatValue>
            <StatSub>
              {mix.total > 0
                ? `No send-from rail resolves for any of ${num(mix.total)} people`
                : 'No people on the roster'}
            </StatSub>
          </>
        )}
      </StatCard>

      <StatCard tone="teal" icon={Landmark} label="Receiving bank">
        {topBank ? (
          <>
            <StatValue>{num(topBank.count)}</StatValue>
            <StatSub>
              <span className="font-medium text-zinc-700 dark:text-zinc-200" title={topBank.label}>
                {topBank.label}
              </span>
              {` · ${pct(topBank.count, mix.bankRail)} of ${num(mix.bankRail)} on a bank rail`}
            </StatSub>
            <Chips slices={mix.receiving} leadChip={TONES.teal.chip} />
            <Footnote>
              {num(mix.distinctBanks)} {mix.distinctBanks === 1 ? 'bank' : 'banks'}, counted as typed — spellings
              are never merged.
              {mix.wallet > 0 && <> {num(mix.wallet)} more are paid to a wallet, which has no receiving bank.</>}
              {mix.missingBank > 0 && (
                <>
                  {' '}
                  <Flag>{num(mix.missingBank)} on a bank rail with no bank on file.</Flag>
                </>
              )}
            </Footnote>
          </>
        ) : (
          <>
            <StatValue>—</StatValue>
            <StatSub>
              {mix.wallet > 0
                ? `Everyone routed is on a wallet — ${num(mix.wallet)} with no receiving bank`
                : 'No receiving bank on file yet'}
            </StatSub>
          </>
        )}
      </StatCard>
    </Band>
  );
}
