'use client';

import React from 'react';
import type { PayStubView } from '@/lib/payroll/paystub-view';

/**
 * The pay statement itself — a faithful React port of the emailed paystub
 * (`docs/features/paystub.html` / the n8n "Paystub Automation" Gmail node). Same
 * orange 560px card, same sections and colours, so the in-app view matches the
 * email pixel-for-pixel in spirit. Rendered as a light "document" in both app
 * themes (the email is light-only).
 */

function php(n: number): string {
  return `₱${n.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
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

function EarningRow({
  label,
  detail,
  amount,
  amountClass,
  last,
}: {
  label: string;
  detail: string;
  amount: string;
  amountClass?: string;
  last?: boolean;
}) {
  const border = last ? '' : 'border-b border-[#edf2f7]';
  return (
    <tr>
      <td className={`w-[44%] py-1.5 pr-2 text-[13px] leading-[15px] text-[#26384d] ${border}`}>
        {label}
      </td>
      <td
        className={`hidden w-[28%] whitespace-nowrap px-2 py-1.5 text-[12px] leading-[15px] text-[#556377] sm:table-cell ${border}`}
      >
        {detail}
      </td>
      <td
        className={`w-[28%] whitespace-nowrap py-1.5 text-right text-[13px] font-bold leading-[15px] tabular-nums text-[#102034] ${border} ${amountClass ?? ''}`}
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
        <div className="border-b border-[#eef2f6] bg-white px-8 pb-[14px] pt-[18px] text-center">
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img
            src="https://host.simple.biz/email/simplelogo.png"
            alt="Simple"
            width={112}
            className="mx-auto mb-2 block h-auto w-[112px]"
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
        <div className="px-8 pb-3 pt-3">
          <div className="overflow-hidden rounded-[10px] border border-[#e2e8f0] bg-[#f8fafc]">
            <div className={`${SEC_HEAD} px-5 tracking-[0.11em]`}>Total Net Pay</div>
            <div className="px-5 pb-[10px] pt-[9px]">
              <div className="whitespace-nowrap text-[34px] font-extrabold leading-10 tabular-nums text-[#102034]">
                {php(view.totalPayPhp)}
              </div>
              <div className="mt-1.5 flex items-center justify-between border-t border-[#e2e8f0] pt-1.5">
                <span className="text-[12px] leading-[17px] text-[#556377]">USD equivalent</span>
                <span className="whitespace-nowrap text-[12px] font-bold leading-[17px] text-[#26384d]">
                  ${view.totalPayUsd.toFixed(2)} USD
                </span>
              </div>
            </div>
          </div>
        </div>

        {/* Employee */}
        <div className="px-8 pb-[10px]">
          <table className="w-full">
            <tbody>
              <tr>
                <td colSpan={2} className={SEC_HEAD}>
                  Employee
                </td>
              </tr>
              <tr>
                <td className="w-1/2 border-b border-[#e2e8f0] py-2 pr-3.5 align-top">
                  <div className="text-[10px] font-bold uppercase leading-[13px] tracking-[0.12em] text-[#556377]">
                    Recipient
                  </div>
                  <div className="mt-[3px] text-[14px] font-bold leading-5 text-[#102034]">
                    {view.name || '—'}
                  </div>
                </td>
                <td className="w-1/2 border-b border-[#e2e8f0] py-2 text-right align-top">
                  <div className="text-[10px] font-bold uppercase leading-[13px] tracking-[0.12em] text-[#556377]">
                    Department
                  </div>
                  <div className="mt-[3px] text-[14px] font-bold leading-5 text-[#102034]">
                    {view.department || '—'}
                  </div>
                </td>
              </tr>
            </tbody>
          </table>
        </div>

        {/* Earnings */}
        <div className="border-b border-[#e2e8f0] px-8 pb-[5px]">
          <table className="w-full">
            <tbody>
              <tr>
                <td colSpan={3} className={SEC_HEAD}>
                  Earnings
                </td>
              </tr>
              <tr>
                <td className={`${COL_HEAD} pl-0 text-left`}>Description</td>
                <td className={`${COL_HEAD} hidden px-2 text-left sm:table-cell`}>Hours × Rate</td>
                <td className={`${COL_HEAD} pr-0 text-right`}>Amount</td>
              </tr>
              <EarningRow
                label="Regular Hours"
                detail={`${hrs(view.mfHours)}h × ${php(view.mfRate)}`}
                amount={php(view.mfPay)}
              />
              <EarningRow
                label="Overtime"
                detail={`${hrs(view.mfOtHours)}h × ${php(view.otRate)}`}
                amount={php(view.otPay)}
              />
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
                last
              />
            </tbody>
          </table>
        </div>

        {/* MESA Adjustment */}
        <div className="border-b border-[#e2e8f0] px-8 pb-[5px] pt-2">
          <table className="w-full">
            <tbody>
              <tr>
                <td colSpan={3} className={SEC_HEAD}>
                  MESA Adjustment
                </td>
              </tr>
              <tr>
                <td className={`${COL_HEAD} pl-0 text-left`}>Description</td>
                <td className={`${COL_HEAD} hidden px-2 text-left sm:table-cell`}>Type</td>
                <td className={`${COL_HEAD} pr-0 text-right`}>Amount</td>
              </tr>
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
            </tbody>
          </table>
        </div>

        {/* Confidential */}
        <div className="px-8 pb-4 pt-2.5">
          <div className="rounded-[10px] border border-[#e2e8f0] bg-[#f8fafc] px-3.5 py-2 text-[11px] leading-4 text-[#556377]">
            <strong className="text-[#334155]">Confidential:</strong> This statement is intended only
            for the recipient named above. Contact your payroll representative if any hours or totals
            need review.
          </div>
        </div>

        {/* Footer */}
        <div className="flex items-center justify-between border-t border-[#eef2f6] bg-[#f8fafc] px-8 py-2.5">
          <span className="text-[11px] leading-4 text-[#556377]">Automated dispatch from Simple HRIS</span>
          <span className="whitespace-nowrap text-[11px] font-bold leading-4 text-[#334155]">
            Simple Payroll
          </span>
        </div>
      </div>
    </div>
  );
}
