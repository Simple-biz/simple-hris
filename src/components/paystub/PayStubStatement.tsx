'use client';

import React from 'react';
import type { PayStubView } from '@/lib/payroll/paystub-view';

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

function php(n: number): string {
  return `₱${n.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
}
/** USD carries thousands separators like every other figure here (and like the wizard). */
function usd(n: number): string {
  return `$${n.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })} USD`;
}
function hrs(n: number): string {
  return n.toFixed(2);
}

function formatPaidAt(iso: string | null | undefined): string | null {
  if (!iso) return null;
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(iso.trim());
  if (!m) return null;
  const months = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
  return `${months[Number(m[2]) - 1] ?? ''} ${Number(m[3])}, ${m[1]}`;
}

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

function EarningRow({
  label,
  detail,
  amount,
  amountClass,
  last,
}: {
  label: string;
  detail: React.ReactNode;
  amount: string;
  amountClass?: string;
  last?: boolean;
}) {
  const border = last ? '' : 'border-b border-[#edf2f7]';
  return (
    <tr>
      <th
        scope="row"
        className={`break-words py-1.5 pr-2 text-left align-top text-[13px] font-normal leading-[15px] text-[#26384d] ${border}`}
      >
        {label}
        {/* The detail column is hidden below sm — carry the detail under the
            label so no line ever loses the basis for its amount. */}
        <div className="mt-[3px] break-words text-[11px] font-normal leading-[14px] text-[#556377] sm:hidden">
          {detail}
        </div>
      </th>
      <td
        className={`hidden break-words px-2 py-1.5 align-top text-[12px] leading-[15px] text-[#556377] sm:table-cell ${border}`}
      >
        {detail}
      </td>
      <td
        className={`whitespace-nowrap py-1.5 text-right align-top text-[13px] font-bold leading-[15px] tabular-nums text-[#102034] ${border} ${amountClass ?? ''}`}
      >
        {amount}
      </td>
    </tr>
  );
}

export function PayStubStatement({
  view,
  paidAt,
}: {
  view: PayStubView;
  paidAt?: string | null;
}) {
  const paidLabel = formatPaidAt(paidAt);
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
          {paidLabel ? (
            <div className="mt-2 inline-flex items-center gap-1.5 rounded-full bg-emerald-50 px-2.5 py-1 text-[11px] font-semibold text-emerald-700 ring-1 ring-emerald-200">
              <span className="h-1.5 w-1.5 rounded-full bg-emerald-500" />
              Paid {paidLabel}
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
              <div className="whitespace-nowrap text-[30px] font-extrabold leading-9 tabular-nums text-[#102034] sm:text-[34px] sm:leading-10">
                {php(view.totalPayPhp)}
              </div>
              <div className="mt-1.5 flex items-center justify-between gap-3 border-t border-[#e2e8f0] pt-1.5">
                <span className="text-[12px] leading-[17px] text-[#556377]">USD equivalent</span>
                <span className="whitespace-nowrap text-[12px] font-bold leading-[17px] text-[#26384d]">
                  {usd(view.totalPayUsd)}
                </span>
              </div>
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
                {view.department || '—'}
              </div>
            </div>
          </div>
        </div>

        {/* Earnings */}
        <div className={`${SEC_PAD} border-b border-[#e2e8f0] pb-[5px]`}>
          <div className={SEC_HEAD}>Earnings</div>
          <StatementTable caption="Earnings" detailHead="Hours × Rate">
            {/* HSL weeks split the hours: Regular/Overtime carry the WEEKDAY
                portion and two Weekend rows carry Sat+Sun at the premium rate
                (base + ₱15/h). Weekend hours can sit in either bucket — a
                weekend day past the 40h cap is weekend OT — so both weekend
                lines exist. The four lines sum exactly to the old two.
                Non-HSL (and pre-split) stubs: weekday === full totals and the
                weekend rows don't render, so nothing changes. */}
            <EarningRow
              label="Regular Hours"
              detail={<RateDetail hours={view.weekdayHours ?? view.mfHours} rate={view.mfRate} />}
              amount={php(view.weekdayPay ?? view.mfPay)}
            />
            <EarningRow
              label="Overtime"
              detail={<RateDetail hours={view.weekdayOtHours ?? view.mfOtHours} rate={view.otRate} />}
              amount={php(view.weekdayOtPay ?? view.otPay)}
            />
            {view.hasWeekend && (
              <EarningRow
                label="Weekend Hours"
                detail={<RateDetail hours={view.weekendHours} rate={view.weekendRate} />}
                amount={php(view.weekendPay)}
              />
            )}
            {view.hasWeekend && (
              <EarningRow
                label="Weekend Overtime"
                detail={<RateDetail hours={view.weekendOtHours} rate={view.weekendOtRate} />}
                amount={php(view.weekendOtPay)}
              />
            )}
            <EarningRow label="Tech Allowance" detail="Bonus" amount={php(view.techBonus)} />
            <EarningRow
              label="Attendance Incentive"
              detail="Bonus"
              amount={php(view.attendanceBonus)}
            />
            <EarningRow
              label="Performance Bonus"
              detail="Bonus"
              amount={php(view.performanceBonus)}
            />
            <EarningRow
              label="Adjustment"
              detail={view.adjustmentNote || 'Manual adjustment'}
              amount={php(view.adjustment)}
            />
            {/* Orphanage — an accounting extra added on top of pay. Always shown
                (like the other bonus rows) so the breakdown reconciles; ₱0.00 when
                unused. Signed + teal to match the emailed statement + wizard preview. */}
            <EarningRow
              label="Orphanage"
              detail="Contribution"
              amount={`+${php(view.orphanagePay)}`}
              amountClass="!text-[#0f766e]"
              last
            />
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
            />
            <EarningRow
              label="MESA Deduction"
              detail="Contribution"
              amount={`-${php(view.mesaDeduction)}`}
              amountClass="!text-[#b3261e]"
              last
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
