'use client';

import React from 'react';
import {
  formatCop,
  formatHours,
  formatPhp,
  formatStatementDate,
  formatTimeAdjustmentDetail,
  formatUsd,
  showsOrphanageLine,
  showsTimeAdjustmentLine,
  type PayStubView,
  type ProratedLineView,
} from '@/lib/payroll/paystub-view';
import {
  allFieldsSettled,
  showsWhileUnsettled,
  type PayStubFieldState,
  type PayStubFieldStates,
} from '@/lib/payroll/paystub-field-state';

import { formatDeptLabel } from '@/lib/departments/hsl-subdept';
/**
 * The pay statement itself — a faithful React port of the emailed paystub
 * (`docs/features/paystub.html` / the n8n "Paystub Automation" Gmail node). Same
 * orange 560px card, same sections and colours, so the in-app view matches the
 * email pixel-for-pixel in spirit, and matches the Payroll Wizard's Paystubs
 * preview line for line. Rendered as a light "document" in both app themes (the
 * email is light-only).
 *
 * Layout rules that keep it honest — a pay document may never hide money:
 *   - Every table is `table-fixed` over a `<colgroup>`, so the three columns
 *     hold their widths no matter how long a line's text runs. Only the Amount
 *     column is `whitespace-nowrap`; descriptions and details wrap. A long
 *     Adjustment note therefore grows the row taller instead of pushing the
 *     Amount column out through the card's clipped edge.
 *   - Every table carries `table-keep`, opting out of the global <640px
 *     "collapse each row into a card" rule in index.css. That rule is right for
 *     app tables and wrong for a document: it would repaint these rows in app
 *     theme colours and break the statement on phones.
 *   - Below `sm` the detail column is hidden (as the email does at 600px), but
 *     the detail rides along under its label instead of disappearing, so hours ×
 *     rate and the reason for an adjustment survive on a phone.
 */

/* Money and hours come from the shared formatters in `paystub-view` — the same
   ones the emailed HTML prints through, so no figure can appear in two shapes
   across the two documents describing one payment. */
const php = formatPhp;
const usd = formatUsd;
const cop = formatCop;
const hrs = formatHours;

const SEC_HEAD =
  'bg-[#334155] px-3 py-[5px] text-[11px] font-extrabold uppercase leading-[13px] tracking-[0.12em] text-white';
const COL_HEAD =
  'bg-[#f1f5f9] py-1 text-[10px] font-bold uppercase leading-3 tracking-[0.06em] text-[#334155] border-b border-[#cbd5e1]';
/** Section padding — 32px like the email, 20px under its 600px rule. */
const SEC_PAD = 'px-5 sm:px-8';

/**
 * One line-item table: fixed 44/28/28 columns like the email's `.line-label` /
 * `.detail-col` / `.line-amount`, and 65/0/35 below `sm` where the detail column
 * folds into the label cell.
 */
function StatementTable({
  caption,
  detailHead,
  children,
}: {
  /** Announced to screen readers; the slate bar above already labels it visually. */
  caption: string;
  /** Column 2's heading: "Hours × Rate" on Earnings, "Type" on MESA. */
  detailHead: string;
  children: React.ReactNode;
}) {
  return (
    <table className="table-keep w-full table-fixed border-collapse tabular-nums">
      <caption className="sr-only">{caption}</caption>
      <colgroup>
        <col className="w-[65%] sm:w-[44%]" />
        <col className="w-0 sm:w-[28%]" />
        <col className="w-[35%] sm:w-[28%]" />
      </colgroup>
      <tbody>
        <tr>
          <th scope="col" className={`${COL_HEAD} text-left`}>
            Description
          </th>
          <th scope="col" className={`${COL_HEAD} hidden px-2 text-left sm:table-cell`}>
            {detailHead}
          </th>
          <th scope="col" className={`${COL_HEAD} text-right`}>
            Amount
          </th>
        </tr>
        {children}
      </tbody>
    </table>
  );
}

/** `40.00h × ₱425.00` — each token unbreakable, the × the only break point. */
function RateDetail({ hours, rate }: { hours: number; rate: number }) {
  return (
    <>
      <span className="whitespace-nowrap">{hrs(hours)}h</span>
      {' × '}
      <span className="whitespace-nowrap">{php(rate)}</span>
    </>
  );
}

/**
 * Amber "Prorated" tag beside a line label whose money genuinely spanned two
 * rates (a mid-week transfer / dated rate change). Same amber family as the
 * wizard's Step-2 mid-week badge. Exported so the wizard's Paystubs preview
 * renders the identical element — preview == dispatch == email.
 */
export function ProratedChip() {
  return (
    <span className="ml-[7px] inline-flex items-center whitespace-nowrap rounded-full bg-[#fffbeb] px-[7px] pb-[2px] pt-px align-[2px] text-[9.5px] font-extrabold uppercase leading-[13px] tracking-[0.07em] text-[#b45309] ring-1 ring-inset ring-[#f2ce74]">
      Prorated
    </span>
  );
}

/**
 * Detail cell for the merged Weekend Hours line when its hours paid at 2+
 * rates: the total hours up top, then the per-rate basis underneath —
 * `8.72h @ ₱265.00 · 8.65h @ ₱382.50` — so the amount stays explicable
 * arithmetic. Two rates appear here without any rate CHANGE: the regular and
 * OT buckets of the same weekend legitimately pay differently, which is why
 * there is no `₱old → ₱new` arrow. `effectiveHuman` is set only when a dated
 * mid-week change genuinely hit the weekend (the line also gets the chip).
 */
export function MultiRateDetail({
  hours,
  segments,
  effectiveHuman,
}: {
  hours: number;
  segments: Array<{ ratePhp: number; hours: number }>;
  effectiveHuman?: string;
}) {
  return (
    <>
      <span className="whitespace-nowrap">{hrs(hours)}h</span>
      <span className="mt-[3px] block text-[11px] leading-[14px] text-[#7c8798]">
        {segments.map((s, i) => (
          <React.Fragment key={`${s.ratePhp}-${i}`}>
            {i > 0 && ' · '}
            <span className="whitespace-nowrap">
              <span className="font-semibold text-[#556377]">{hrs(s.hours)}h</span> @ {php(s.ratePhp)}
            </span>
          </React.Fragment>
        ))}
        {effectiveHuman ? ` — effective ${effectiveHuman}` : ''}
      </span>
    </>
  );
}

/**
 * Detail cell for a line that paid at ONE rate which is nevertheless not the
 * week's current rate — the whole weekend landed on one side of a dated change:
 *
 *     8.10h × ₱250.00
 *     rate changed to ₱240.00 on Jul 27
 *
 * The `₱old → ₱new` arrow would be a lie here (only ₱250 paid any of these
 * hours) and a bare `8.10h × ₱250.00` was the actual defect — it left a ₱250
 * weekend sitting under a ₱225 regular line with nothing to reconcile them.
 * Exported so the wizard preview renders the identical element.
 */
export function RateChangedDetail({
  hours,
  rate,
  currentRate,
  effectiveHuman,
}: {
  hours: number;
  rate: number;
  currentRate: number;
  effectiveHuman: string;
}) {
  return (
    <>
      <span className="whitespace-nowrap">{hrs(hours)}h</span>
      {' × '}
      <span className="whitespace-nowrap">{php(rate)}</span>
      <span className="mt-[3px] block text-[11px] leading-[14px] text-[#7c8798]">
        rate changed to{' '}
        <span className="whitespace-nowrap font-semibold text-[#556377]">{php(currentRate)}</span>
        {effectiveHuman ? ` on ${effectiveHuman}` : ''}
      </span>
    </>
  );
}

/**
 * Detail cell for a prorated line: `40.00h × ₱175.00 → ₱225.00` (previous rate
 * muted, current rate carrying the weight — no strikethrough, both rates
 * genuinely paid part of the week), then the per-rate basis on its own line so
 * the amount stays explicable arithmetic: `16.25h @ ₱175.00 · 23.75h @ ₱225.00
 * — effective Jul 22`. Replaces `RateDetail` on that line only; single-rate
 * lines keep the classic render. Exported for the wizard preview.
 */
export function ProratedRateDetail({
  hours,
  line,
  effectiveHuman,
}: {
  hours: number;
  line: ProratedLineView;
  effectiveHuman: string;
}) {
  return (
    <>
      <span className="whitespace-nowrap">{hrs(hours)}h</span>
      {' × '}
      <span className="whitespace-nowrap">{php(line.previousRate)}</span>
      <span aria-hidden="true" className="px-px font-semibold text-[#d97706]">
        →
      </span>
      <span className="sr-only"> changed to </span>
      <span className="whitespace-nowrap font-semibold text-[#26384d]">{php(line.currentRate)}</span>
      <span className="mt-[3px] block text-[11px] leading-[14px] text-[#7c8798]">
        {line.segments.map((s, i) => (
          <React.Fragment key={`${s.ratePhp}-${i}`}>
            {i > 0 && ' · '}
            <span className="whitespace-nowrap">
              <span className="font-semibold text-[#556377]">{hrs(s.hours)}h</span> @ {php(s.ratePhp)}
            </span>
          </React.Fragment>
        ))}
        {effectiveHuman ? ` — effective ${effectiveHuman}` : ''}
      </span>
    </>
  );
}

/**
 * A shimmering placeholder standing where a figure will be — the Wizard Step-8
 * preview only, driven by `fieldStates`. Grey and in motion, never amber: amber
 * is the wizard's WARNING colour (`payroll-wizard-pab-step.md` § — *"missing
 * evidence is a warning to check, not furniture"*), and a fetch that has not
 * landed yet is not a warning, it is simply not an answer. Amber is reserved
 * below for `unavailable`, which genuinely is one.
 *
 * `aria-hidden` on the bar with the state in text beside it, so a screen reader
 * hears "still loading" rather than nothing at all.
 */
function PendingBar() {
  return (
    <>
      {/* No sizing utilities on purpose — `.paystub-pending-bar` carries its own
          `em`-relative width and height, so the bar can never render zero-size
          and scales itself to the cell it sits in (Kane: "it just blanked
          itself"). Do not add `w-[…]`/`h-[…]` back. */}
      <span className="paystub-pending-bar" aria-hidden="true" />
      <span className="sr-only">still loading</span>
    </>
  );
}

/**
 * The terminal state. A loader that FAILED will not produce a figure without a
 * reload, so it must never animate — `payroll-wizard-step-load.md` § forbids the
 * forever-spinner, and [[kpi-calculator-week-unresolved-hang]] settled the
 * general rule: an unresolvable input is TERMINAL, not pending. Says the word
 * rather than showing a zero, the same ruling as the wizard's first-paycheck
 * label (*"a failed read says unavailable, never zero"*).
 */
function UnavailableMark() {
  return (
    <span className="whitespace-nowrap text-[11px] font-bold uppercase tracking-[0.06em] text-[#b45309]">
      Unavailable
    </span>
  );
}

/** Render `amount` as itself, a shimmer, or the word — one decision, three cells. */
function AmountCell({
  amount,
  state,
}: {
  amount: string;
  state: PayStubFieldState;
}) {
  if (state === 'pending') return <PendingBar />;
  if (state === 'unavailable') return <UnavailableMark />;
  return <>{amount}</>;
}

function EarningRow({
  label,
  badge,
  detail,
  amount,
  amountClass,
  last,
  state = 'settled',
}: {
  label: string;
  /** Inline tag after the label (the "Prorated" chip) — never a new row. */
  badge?: React.ReactNode;
  detail: React.ReactNode;
  amount: string;
  amountClass?: string;
  last?: boolean;
  /**
   * Wizard preview only; omitted everywhere else, which is what keeps every
   * employee-facing and emailed statement byte-identical. While it is not
   * `settled` the row keeps its label and its position and swaps ONLY the two
   * cells that would otherwise assert a figure — the detail cell goes too,
   * because `40.00h × ₱0.00` is exactly as confident a claim as the amount is.
   */
  state?: PayStubFieldState;
}) {
  const border = last ? '' : 'border-b border-[#edf2f7]';
  const unsettled = state !== 'settled';
  // The detail cell follows the SAME three-way branch as the amount. It must not
  // shimmer on `unavailable` — a terminal state that animates is exactly the
  // forever-spinner `payroll-wizard-step-load.md` § rules out, and this cell was
  // the one place it could still creep in (caught by the all-unavailable test).
  // On `unavailable` it goes blank rather than repeating the word: the amount
  // cell beside it already says it once, and twice reads as two problems.
  const detailCell =
    state === 'pending' ? <PendingBar /> : state === 'unavailable' ? null : detail;
  // `amountClass` carries the signed teal/red of the MESA and Orphanage rows.
  // Dropping it while unsettled is deliberate: a red placeholder would assert a
  // deduction, and a teal one a credit, before either is known.
  const amountTone = unsettled ? '' : (amountClass ?? '');
  return (
    <tr>
      <th
        scope="row"
        className={`break-words py-1.5 pr-2 text-left align-top text-[13px] font-normal leading-[15px] text-[#26384d] ${border}`}
      >
        {label}
        {badge}
        {/* The detail column is hidden below sm — carry the detail under the
            label so no line ever loses the basis for its amount. */}
        <div className="mt-[3px] break-words text-[11px] font-normal leading-[14px] text-[#556377] sm:hidden">
          {detailCell}
        </div>
      </th>
      <td
        className={`hidden break-words px-2 py-1.5 align-top text-[12px] leading-[15px] text-[#556377] sm:table-cell ${border}`}
      >
        {detailCell}
      </td>
      <td
        className={`whitespace-nowrap py-1.5 text-right align-top text-[13px] font-bold leading-[15px] tabular-nums text-[#102034] ${border} ${amountTone}`}
      >
        <AmountCell amount={amount} state={state} />
      </td>
    </tr>
  );
}

export function PayStubStatement({
  view,
  paidAt,
  status,
  fieldStates,
}: {
  view: PayStubView;
  paidAt?: string | null;
  /**
   * Dispatch status from the paystub API — 'paid' once Payment Dispatch marked it,
   * else 'issued'. It exists because `paidAt` alone can't decide the header pill:
   * callers pass the resolved PAY DATE (real disbursement date, else the scheduled
   * Tue/Thu), which is non-null for a payment that hasn't gone out yet — so an
   * unpaid stub used to claim "Paid <scheduled date>". With a status in hand an
   * unpaid stub reads Pending instead. Omitted (undefined) → legacy behaviour: any
   * date means paid.
   */
  status?: string | null;
  /**
   * Per-line load state — the **Payroll Wizard Step-8 preview only**, which is
   * the one surface that renders a statement off rows whose fetches have not all
   * landed. Omitted (undefined) everywhere else, and an omitted prop resolves
   * every line to `settled`, so every employee-facing mount, every emailed copy
   * and every export is byte-identical to before — the same contract the
   * weekend, proration, transfer and time-adjustment blocks each carry.
   *
   * Deliberately a React prop and NOT a field on {@link PayStubView}: the view is
   * what `renderPayStubEmailHtml`, `buildPayStubsWorkbook` and the staged
   * `paystub_dispatch_queue` payload are all built from, and none of those three
   * signatures can carry a React prop. A load state can therefore never reach an
   * inbox, a PDF or a row re-rendered days later — structurally, not by
   * discipline. See `paystub-field-state.ts` for the resolution rules.
   */
  fieldStates?: PayStubFieldStates;
}) {
  const paidLabel = formatStatementDate(paidAt);
  const isPaid = status ? status === 'paid' : Boolean(paidLabel);
  // One object either way, so nothing below branches on "was the prop passed".
  const fs = fieldStates ?? allFieldsSettled();
  // The three optional lines are ABSENT rather than ₱0.00 when they carry no
  // money. Unloaded, that absence is a claim the data cannot support — and a
  // vanished row is less visible than a zeroed one, not more (Kane 2026-09-22).
  // The shared predicate still owns the SETTLED answer, which is what keeps the
  // three renderers in agreement about every statement anyone is ever sent.
  const showsWeekend = showsWhileUnsettled(view.hasWeekend, fs.weekend);
  const showsTimeAdj = showsWhileUnsettled(showsTimeAdjustmentLine(view), fs.timeAdjustment);
  const showsOrphanage = showsWhileUnsettled(showsOrphanageLine(view), fs.orphanage);
  return (
    <div
      className="w-full max-w-[560px] overflow-hidden rounded-[17px] bg-[#f97316] p-[3px] shadow-[0_20px_48px_rgba(16,32,52,0.16),0_2px_6px_rgba(16,32,52,0.07)]"
      style={{ colorScheme: 'light' }}
    >
      <div className="overflow-hidden rounded-[14px] bg-[#fbfcfe]">
        {/* Header */}
        <div className={`${SEC_PAD} border-b border-[#eef2f6] bg-white pb-[14px] pt-[18px] text-center`}>
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img
            src="https://host.simple.biz/email/simplelogo.png"
            alt="Simple"
            width={112}
            className="mx-auto mb-2 block h-auto w-[92px] sm:w-[112px]"
            onError={(e) => {
              (e.currentTarget as HTMLImageElement).style.display = 'none';
            }}
          />
          <div className="text-[26px] font-bold leading-8 text-[#102034]">Pay Statement</div>
          <div className="mt-[3px] text-[13px] leading-[19px] text-[#556377]">
            Period ending{' '}
            <span className="font-bold text-[#334155]">{view.weekHuman || '—'}</span>
          </div>
          {isPaid ? (
            <div className="mt-2 inline-flex items-center gap-1.5 rounded-full bg-emerald-50 px-2.5 py-1 text-[11px] font-semibold text-emerald-700 ring-1 ring-emerald-200">
              <span className="h-1.5 w-1.5 rounded-full bg-emerald-500" />
              {paidLabel ? `Paid ${paidLabel}` : 'Paid'}
            </div>
          ) : status ? (
            <div className="mt-2 inline-flex items-center gap-1.5 rounded-full bg-orange-50 px-2.5 py-1 text-[11px] font-semibold text-orange-700 ring-1 ring-orange-200">
              <span className="h-1.5 w-1.5 rounded-full bg-orange-500" />
              Pending
            </div>
          ) : (
            <div className="mt-[5px] text-[11px] leading-4 text-[#556377]">Confidential pay record</div>
          )}
        </div>

        {/* Total Net Pay */}
        <div className={`${SEC_PAD} pb-3 pt-3`}>
          <div className="overflow-hidden rounded-[10px] border border-[#e2e8f0] bg-[#f8fafc]">
            <div className={`${SEC_HEAD} px-5 tracking-[0.11em]`}>Total Net Pay</div>
            <div className="px-5 pb-[10px] pt-[9px]">
              {/* Net inherits the worst state of every line beneath it. A
                  shimmering Attendance Incentive under a confident ₱14,188.29
                  would re-open the exact defect closed on 2026-09-22 — a pay
                  document that does not add up to its own total. `resolvePay
                  StubFieldStates` folds that identity; this only obeys it. */}
              <div className="whitespace-nowrap text-[30px] font-extrabold leading-9 tabular-nums text-[#102034] sm:text-[34px] sm:leading-10">
                {fs.total === 'pending' ? (
                  /* Sized to the NUMBER it replaces (30/34px), not to a line of
                     text — a hairline under the statement's largest figure reads
                     as a rule, not as "this is still coming". */
                  <PendingBar />
                ) : fs.total === 'unavailable' ? (
                  <UnavailableMark />
                ) : (
                  php(view.totalPayPhp)
                )}
              </div>
              <div className="mt-1.5 flex items-center justify-between gap-3 border-t border-[#e2e8f0] pt-1.5">
                <span className="text-[12px] leading-[17px] text-[#556377]">USD equivalent</span>
                {/* Never better than Net and never better than the FX read:
                    `mapPayloadToPayStub` falls back to a hardcoded 58 when the
                    cycle rate is absent, so this figure is plausible, wrong and
                    indistinguishable from a real one. */}
                <span className="whitespace-nowrap text-[12px] font-bold leading-[17px] text-[#26384d]">
                  <AmountCell amount={usd(view.totalPayUsd)} state={fs.totalUsd} />
                </span>
              </div>
              {/* Colombian (COP-country) payees: the native figure their bank
                  receives — same USD-anchor derivation Payment Dispatch pays.
                  Absent for everyone else (totalPayCop stays null). */}
              {view.totalPayCop != null && (
                <div className="mt-1 flex items-center justify-between gap-3">
                  <span className="text-[12px] leading-[17px] text-[#556377]">COP equivalent</span>
                  <span className="whitespace-nowrap text-[12px] font-bold leading-[17px] text-[#26384d]">
                    <AmountCell amount={cop(view.totalPayCop)} state={fs.totalCop} />
                  </span>
                </div>
              )}
            </div>
          </div>
        </div>

        {/* Employee */}
        <div className={`${SEC_PAD} pb-[10px]`}>
          <div className={SEC_HEAD}>Employee</div>
          <div className="flex flex-col gap-2 border-b border-[#e2e8f0] py-2 sm:flex-row sm:items-start sm:justify-between sm:gap-4">
            <div className="min-w-0">
              <div className="text-[10px] font-bold uppercase leading-[13px] tracking-[0.12em] text-[#556377]">
                Recipient
              </div>
              <div className="mt-[3px] break-words text-[14px] font-bold leading-5 text-[#102034]">
                {view.name || '—'}
              </div>
            </div>
            <div className="min-w-0 sm:text-right">
              <div className="text-[10px] font-bold uppercase leading-[13px] tracking-[0.12em] text-[#556377]">
                Department
              </div>
              <div className="mt-[3px] break-words text-[14px] font-bold leading-5 text-[#102034]">
                {formatDeptLabel(view.department) || '—'}
              </div>
              {/* Mid-week transfer disclosure — "Lead Gen to HSL". The Department
                  above is where the person ENDED the week (a transfer moves the
                  label the moment it is released), so without this line a week
                  they only spent part of in that team reads as though they had
                  always been there. Both sides are already through
                  formatDeptLabel inside `formatTransferLabel`; null on every
                  week without a transfer and on every payload staged before
                  2026-08-25, which render exactly as they did before. */}
              {view.departmentTransfer && (
                <div className="mt-[3px] break-words text-[11px] leading-[14px] text-[#7c8798]">
                  {view.departmentTransfer.label}
                </div>
              )}
            </div>
          </div>
        </div>

        {/* Earnings */}
        <div className={`${SEC_PAD} border-b border-[#e2e8f0] pb-[5px]`}>
          <div className={SEC_HEAD}>Earnings</div>
          <StatementTable caption="Earnings" detailHead="Hours × Rate">
            {/* HSL weeks render the Hogan sheet's three-stage form (2026-08-11,
                view.otIsDifferential): "M-F Hours" carries ALL Mon–Fri hours at
                the regular rate (past-cap included — they never re-rate), ONE
                Weekend Hours row carries ALL of Sat+Sun at (regular + 15), and
                "OT Differential" adds hours-past-40 × (regular × 0.5) on top of
                base already paid. The three lines sum exactly to initial pay.
                Pre-2026-08-11 HSL stubs keep their staged split (weekday-by-
                subtraction, "Overtime" full-rate line, mixed weekendBasis).
                Non-HSL (and pre-split) stubs: weekday === full totals and the
                weekend row doesn't render, so nothing changes. */}
            {/* A mid-week transfer / dated rate change prorates a line across two
                rates. Affected lines keep their EXACT row — the "Prorated" chip
                joins the label and the detail cell shows `₱old → ₱new` plus the
                per-rate hour basis. Lines paid at one rate (view.proration null
                or that line's entry null) render classic, byte-identical. */}
            <EarningRow
              label={view.otIsDifferential ? 'M-F Hours' : 'Regular Hours'}
              badge={view.proration?.regular ? <ProratedChip /> : null}
              detail={
                view.proration?.regular ? (
                  <ProratedRateDetail
                    hours={view.weekdayHours ?? view.mfHours}
                    line={view.proration.regular}
                    effectiveHuman={view.proration.effectiveHuman}
                  />
                ) : (
                  <RateDetail hours={view.weekdayHours ?? view.mfHours} rate={view.mfRate} />
                )
              }
              amount={php(view.weekdayPay ?? view.mfPay)}
              state={fs.regular}
            />
            <EarningRow
              label={view.otIsDifferential ? 'OT Differential' : 'Overtime'}
              badge={view.proration?.ot ? <ProratedChip /> : null}
              detail={
                view.proration?.ot ? (
                  <ProratedRateDetail
                    hours={view.weekdayOtHours ?? view.mfOtHours}
                    line={view.proration.ot}
                    effectiveHuman={view.proration.effectiveHuman}
                  />
                ) : (
                  <RateDetail hours={view.weekdayOtHours ?? view.mfOtHours} rate={view.otRate} />
                )
              }
              amount={php(view.weekdayOtPay ?? view.otPay)}
              state={fs.overtime}
            />
            {showsWeekend && (
              <EarningRow
                label="Weekend Hours"
                badge={view.proration?.weekend ? <ProratedChip /> : null}
                detail={
                  view.weekendBasis.length > 1 ? (
                    <MultiRateDetail
                      hours={view.weekendHours}
                      segments={view.weekendBasis}
                      effectiveHuman={view.proration?.weekend ? view.proration.effectiveHuman : ''}
                    />
                  ) : view.proration?.weekend ? (
                    // One rate, but not the week's current one — the weekend sat
                    // entirely on one side of a dated change. Say so, or the
                    // reader has no way to square it with the Regular line.
                    <RateChangedDetail
                      hours={view.weekendHours}
                      rate={view.weekendBasis[0]?.ratePhp ?? 0}
                      currentRate={view.proration.weekend.currentRate}
                      effectiveHuman={view.proration.effectiveHuman}
                    />
                  ) : (
                    <RateDetail hours={view.weekendHours} rate={view.weekendBasis[0]?.ratePhp ?? 0} />
                  )
                }
                amount={php(view.weekendPay)}
                state={fs.weekend}
              />
            )}
            {/* Approved time adjustment. It sits directly after the hours lines,
                the same place the Reports XLSX puts its columns, so the document
                reads `Regular + OT (+ Weekend) + Time Adjustment = Initial Pay`.
                It is NOT folded into Regular Hours: `hours.total` is the RAW
                tracked figure and Hubstaff data is never mutated, so without its
                own row this money is inside the Net and inside nothing that
                explains it — measured 2026-09-22 on a real staged stub whose
                lines summed ₱23.33 short of the Net it printed. Renders only
                when the block moved money (`showsTimeAdjustmentLine`), so every
                statement staged before 2026-09-10 and every week without an
                adjustment is byte-identical to before. */}
            {showsTimeAdj && (
              <EarningRow
                label="Time Adjustment"
                detail={formatTimeAdjustmentDetail(view.timeAdjustment)}
                amount={php(view.timeAdjustment?.payPhp ?? 0)}
                state={fs.timeAdjustment}
              />
            )}
            <EarningRow
              label="Tech Allowance"
              detail="Bonus"
              amount={php(view.techBonus)}
              state={fs.techBonus}
            />
            <EarningRow
              label="Attendance Incentive"
              detail="Bonus"
              amount={php(view.attendanceBonus)}
              state={fs.attendanceBonus}
            />
            <EarningRow
              label="Performance Bonus"
              detail="Bonus"
              amount={php(view.performanceBonus)}
              state={fs.performanceBonus}
            />
            <EarningRow
              label="Adjustment"
              /* The fallback literal is itself a claim — it reads as "Accounting
                 entered one and left it blank" on a week whose additions blob has
                 not hydrated. EarningRow swaps the detail cell while unsettled. */
              detail={view.adjustmentNote || 'Manual adjustment'}
              amount={php(view.adjustment)}
              last={!showsOrphanage}
              state={fs.adjustment}
            />
            {/* Orphanage — an accounting extra added on top of pay, and one
                almost nobody receives, so the row appears only when there is
                money on it (`showsOrphanageLine`) rather than printing ₱0.00 on
                every other person's statement. Signed + teal, matching the
                emailed statement and the wizard preview, which share the rule. */}
            {showsOrphanage && (
              <EarningRow
                label="Orphanage"
                detail="Contribution"
                amount={`+${php(view.orphanagePay)}`}
                amountClass="!text-[#0f766e]"
                last
                state={fs.orphanage}
              />
            )}
          </StatementTable>
        </div>

        {/* MESA Adjustment */}
        <div className={`${SEC_PAD} border-b border-[#e2e8f0] pb-[5px] pt-2`}>
          <div className={SEC_HEAD}>MESA Adjustment</div>
          <StatementTable caption="MESA Adjustment" detailHead="Type">
            <EarningRow
              label="MESA Reimbursement"
              detail="Payout"
              amount={`+${php(view.mesaDisbursement)}`}
              amountClass="!text-[#0f766e]"
              state={fs.mesaDisbursement}
            />
            <EarningRow
              label="MESA Deduction"
              detail="Contribution"
              amount={`-${php(view.mesaDeduction)}`}
              amountClass="!text-[#b3261e]"
              last
              /* The opt-out ledger can only SUPPRESS this charge, so an unread
                 one prints a confident −₱100.00 on someone who has left MESA —
                 a wrong NON-zero, which is why the state is resolved from the
                 loader and not from the amount. */
              state={fs.mesaDeduction}
            />
          </StatementTable>
        </div>

        {/* Confidential */}
        <div className={`${SEC_PAD} pb-4 pt-2.5`}>
          <div className="rounded-[10px] border border-[#e2e8f0] bg-[#f8fafc] px-3.5 py-2 text-[11px] leading-4 text-[#556377]">
            <strong className="text-[#334155]">Confidential:</strong> This statement is intended only
            for the recipient named above. Contact your payroll representative if any hours or totals
            need review.
          </div>
        </div>

        {/* Footer */}
        <div
          className={`${SEC_PAD} flex items-center justify-between gap-3 border-t border-[#eef2f6] bg-[#f8fafc] py-2.5`}
        >
          <span className="text-[11px] leading-4 text-[#556377]">Automated dispatch from Simple HRIS</span>
          <span className="whitespace-nowrap text-[11px] font-bold leading-4 text-[#334155]">
            Simple Payroll
          </span>
        </div>
      </div>
    </div>
  );
}
