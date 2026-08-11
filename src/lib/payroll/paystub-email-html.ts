/**
 * The emailed pay statement, rendered server-side from a {@link PayStubView}.
 *
 * WHY THIS EXISTS: the statement HTML used to live inside the n8n Gmail node,
 * hand-written against a flat `pay_vars` Set node. n8n therefore had to be
 * edited by hand every time the statement changed, and it silently wasn't — the
 * emailed stub had no Weekend rows (HSL's Sat+Sun carve-out), no Orphanage line,
 * no proration chip, and no COP equivalent, all of which the in-app statement
 * had been showing for weeks. An employee's email and their Pay Stubs tab
 * described the same payment differently.
 *
 * Now the app renders the document and posts it as `paystub_html` on the
 * dispatch payload; n8n's Gmail node is a dumb pipe (`{{ $json.paystub_html }}`).
 * There is exactly one place the statement's shape is decided, and it is the
 * same {@link PayStubView} the Payroll Wizard preview and the in-app modal
 * render — wizard preview == dispatch == email, by construction.
 *
 * Keep this in lockstep with `PayStubStatement.tsx`: same sections, same order,
 * same colours, same line-visibility rules (`showsOrphanageLine`, `hasWeekend`).
 * The React component is the reference; this is its email-safe transcription
 * (tables + inline styles, since email clients have no flexbox and no Tailwind).
 */
import {
  formatCop,
  formatHours,
  formatPhp,
  formatStatementDate,
  formatUsd,
  showsOrphanageLine,
  type PayStubView,
  type ProratedLineView,
} from '@/lib/payroll/paystub-view';

export interface PayStubEmailOptions {
  /** Real disbursement date, else the scheduled Tue/Thu — drives the paid pill. */
  paidAt?: string | null;
  /**
   * `'paid'` once Payment Dispatch marked it, else `'issued'`. Mirrors
   * `PayStubStatement`: `paidAt` alone can't decide the pill, because callers
   * pass a resolved pay date that is non-null for money that hasn't moved yet.
   * Omitted → the classic "Confidential pay record" line, which is what a
   * preview send shows.
   */
  status?: string | null;
}

/* ────────────────────────────── html plumbing ────────────────────────────── */

/**
 * Escape interpolated text. Also maps ₱ to its entity: the peso sign survives a
 * UTF-8 email fine in Gmail, but a few Outlook/Exchange paths still transcode
 * the body, and a mojibake currency symbol on a pay document is not a cosmetic
 * bug. `&` must be replaced first or it would double-escape the entities below.
 */
function esc(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/₱/g, '&#8369;');
}

const php = (n: number) => esc(formatPhp(n));
const hrs = (n: number) => esc(formatHours(n));

/** Shared cell styling, matching the component's `.line-*` classes. */
const CELL_BORDER = 'border-bottom:1px solid #edf2f7;';
const SEC_HEAD_STYLE =
  'background-color:#334155;padding:5px 12px;font-size:11px;line-height:13px;' +
  'font-weight:800;letter-spacing:0.12em;text-transform:uppercase;color:#ffffff;' +
  'mso-line-height-rule:exactly;';
const COL_HEAD_STYLE =
  'background-color:#f1f5f9;padding:4px 0;font-size:10px;line-height:12px;font-weight:700;' +
  'letter-spacing:0.06em;text-transform:uppercase;color:#334155;border-bottom:1px solid #cbd5e1;';

/** The amber "Prorated" tag beside a line label — the component's `ProratedChip`. */
function proratedChip(): string {
  return (
    '<span style="display:inline-block;margin-left:7px;padding:1px 7px 2px 7px;' +
    'border:1px solid #f2ce74;border-radius:999px;background-color:#fffbeb;' +
    'font-size:9.5px;line-height:13px;font-weight:800;letter-spacing:0.07em;' +
    'text-transform:uppercase;color:#b45309;white-space:nowrap;">Prorated</span>'
  );
}

/** `33.87h &times; ₱175.00` — the classic single-rate detail cell. */
function rateDetail(hours: number, rate: number): string {
  return `<span style="white-space:nowrap;">${hrs(hours)}h</span> &times; ` +
    `<span style="white-space:nowrap;">${php(rate)}</span>`;
}

/**
 * Detail cell for the merged Weekend Hours line when its hours paid at 2+
 * rates: total hours up top, per-rate basis underneath. No `₱old → ₱new`
 * arrow — the regular and OT buckets of one weekend legitimately pay at
 * different rates without any rate change. `effectiveHuman` only when a dated
 * mid-week change genuinely hit the weekend. Transcribes `MultiRateDetail`.
 */
function multiRateDetail(
  hours: number,
  segments: Array<{ ratePhp: number; hours: number }>,
  effectiveHuman: string,
): string {
  const basis = segments
    .map(
      (s) =>
        `<span style="white-space:nowrap;"><span style="font-weight:600;color:#556377;">` +
        `${hrs(s.hours)}h</span> @ ${php(s.ratePhp)}</span>`,
    )
    .join(' &middot; ');
  const effective = effectiveHuman ? ` &mdash; effective ${esc(effectiveHuman)}` : '';
  return (
    `<span style="white-space:nowrap;">${hrs(hours)}h</span>` +
    `<span style="display:block;margin-top:3px;font-size:11px;line-height:14px;color:#7c8798;">` +
    `${basis}${effective}</span>`
  );
}

/**
 * Detail cell for a line that paid at ONE rate which is not the week's current
 * rate — the whole weekend landed on one side of a dated change:
 * `8.10h × ₱250.00` over `rate changed to ₱240.00 on Jul 27`. Transcribes
 * `RateChangedDetail`.
 */
function rateChangedDetail(
  hours: number,
  rate: number,
  currentRate: number,
  effectiveHuman: string,
): string {
  const on = effectiveHuman ? ` on ${esc(effectiveHuman)}` : '';
  return (
    `<span style="white-space:nowrap;">${hrs(hours)}h</span> &times; ` +
    `<span style="white-space:nowrap;">${php(rate)}</span>` +
    `<span style="display:block;margin-top:3px;font-size:11px;line-height:14px;color:#7c8798;">` +
    `rate changed to <span style="white-space:nowrap;font-weight:600;color:#556377;">` +
    `${php(currentRate)}</span>${on}</span>`
  );
}

/**
 * Detail cell for a line that genuinely paid at two rates (a mid-week transfer,
 * a dated raise): `40.00h × ₱175.00 → ₱225.00` with the per-rate hour basis
 * underneath, so the amount stays explicable arithmetic. Transcribes
 * `ProratedRateDetail`.
 */
function proratedRateDetail(
  hours: number,
  line: ProratedLineView,
  effectiveHuman: string,
): string {
  const basis = line.segments
    .map(
      (s) =>
        `<span style="white-space:nowrap;"><span style="font-weight:600;color:#556377;">` +
        `${hrs(s.hours)}h</span> @ ${php(s.ratePhp)}</span>`,
    )
    .join(' &middot; ');
  const effective = effectiveHuman ? ` &mdash; effective ${esc(effectiveHuman)}` : '';
  return (
    `<span style="white-space:nowrap;">${hrs(hours)}h</span> &times; ` +
    `<span style="white-space:nowrap;">${php(line.previousRate)}</span>` +
    `<span style="padding:0 1px;font-weight:600;color:#d97706;">&rarr;</span>` +
    `<span style="white-space:nowrap;font-weight:600;color:#26384d;">${php(line.currentRate)}</span>` +
    `<span style="display:block;margin-top:3px;font-size:11px;line-height:14px;color:#7c8798;">` +
    `${basis}${effective}</span>`
  );
}

interface LineRow {
  label: string;
  /** Already-escaped HTML for the detail cell (rates, "Bonus", the note). */
  detail: string;
  amount: string;
  /** Teal for money added, red for money withheld. */
  amountColor?: string;
  prorated?: boolean;
  /** Last row in its table — drops the bottom rule, as the component does. */
  last?: boolean;
}

/**
 * One statement line. The detail column is `display:none` under 600px (the
 * `.detail-col` rule below), so it also rides along under the label in a
 * mobile-only block — no line ever loses the basis for its amount on a phone.
 */
function renderRow(row: LineRow): string {
  const border = row.last ? 'border-bottom:0;' : CELL_BORDER;
  const amountColor = row.amountColor ? `color:${row.amountColor};` : 'color:#102034;';
  return (
    '<tr>' +
    `<td class="line-label" style="${border}">` +
    `${esc(row.label)}${row.prorated ? proratedChip() : ''}` +
    `<div class="detail-stacked" style="display:none;margin-top:3px;font-size:11px;` +
    `line-height:14px;color:#556377;">${row.detail}</div>` +
    '</td>' +
    `<td class="detail-col" style="${border}">${row.detail}</td>` +
    `<td class="line-amount" align="right" style="${border}${amountColor}">${row.amount}</td>` +
    '</tr>'
  );
}

/** A line-item table with its column headings — Earnings and MESA share it. */
function renderTable(detailHead: string, rows: string[]): string {
  return (
    '<table role="presentation" cellpadding="0" cellspacing="0" border="0" width="100%" ' +
    'style="width:100%;border-collapse:collapse;border-bottom:1px solid #e2e8f0;">' +
    '<tr>' +
    `<td class="line-label" style="${COL_HEAD_STYLE}">Description</td>` +
    `<td class="detail-col" style="${COL_HEAD_STYLE}padding:4px 8px;">${esc(detailHead)}</td>` +
    `<td class="line-amount" align="right" style="${COL_HEAD_STYLE}">Amount</td>` +
    '</tr>' +
    rows.join('') +
    '</table>'
  );
}

/* ─────────────────────────────── the document ─────────────────────────────── */

/** `Paystub for Roselyn Agrito · Jul 12 – Jul 18, 2026` */
export function payStubEmailSubject(view: PayStubView): string {
  const who = view.name?.trim();
  const week = view.weekHuman || 'your pay period';
  return who ? `Paystub for ${who} · ${week}` : `Paystub · ${week}`;
}

/**
 * The complete email body for one pay statement. Self-contained HTML — the only
 * external reference is the Simple logo on `host.simple.biz`, as before.
 */
export function renderPayStubEmailHtml(
  view: PayStubView,
  opts: PayStubEmailOptions = {},
): string {
  const paidLabel = formatStatementDate(opts.paidAt);
  const isPaid = opts.status ? opts.status === 'paid' : Boolean(paidLabel);
  const pror = view.proration;
  const weekHuman = view.weekHuman || '—';

  /* Earnings. Sheet-form HSL stubs (2026-08-11, view.otIsDifferential) render
     the Hogan sheet's three-stage form: "M-F Hours" = ALL Mon–Fri hours at the
     regular rate (past-cap included), ONE Weekend Hours row = ALL Sat+Sun at
     (regular + 15), and "OT Differential" = hours-past-40 × (regular × 0.5) on
     top of base already paid. Pre-2026-08-11 HSL stubs keep their staged
     weekday-by-subtraction split with a full-rate "Overtime" line. Non-HSL
     weeks have `hasWeekend: false` — no Weekend row at all, and weekday ===
     the full-week totals, so those statements are unchanged. */
  const earnings: string[] = [
    renderRow({
      label: view.otIsDifferential ? 'M-F Hours' : 'Regular Hours',
      prorated: Boolean(pror?.regular),
      detail: pror?.regular
        ? proratedRateDetail(view.weekdayHours, pror.regular, pror.effectiveHuman)
        : rateDetail(view.weekdayHours, view.mfRate),
      amount: php(view.weekdayPay),
    }),
    renderRow({
      label: view.otIsDifferential ? 'OT Differential' : 'Overtime',
      prorated: Boolean(pror?.ot),
      detail: pror?.ot
        ? proratedRateDetail(view.weekdayOtHours, pror.ot, pror.effectiveHuman)
        : rateDetail(view.weekdayOtHours, view.otRate),
      amount: php(view.weekdayOtPay),
    }),
  ];
  if (view.hasWeekend) {
    earnings.push(
      renderRow({
        label: 'Weekend Hours',
        prorated: Boolean(pror?.weekend),
        detail:
          view.weekendBasis.length > 1
            ? multiRateDetail(
                view.weekendHours,
                view.weekendBasis,
                pror?.weekend ? pror.effectiveHuman : '',
              )
            : pror?.weekend
              ? // One rate, but not the week's current one — the weekend sat
                // entirely on one side of a dated change.
                rateChangedDetail(
                  view.weekendHours,
                  view.weekendBasis[0]?.ratePhp ?? 0,
                  pror.weekend.currentRate,
                  pror.effectiveHuman,
                )
              : rateDetail(view.weekendHours, view.weekendBasis[0]?.ratePhp ?? 0),
        amount: php(view.weekendPay),
      }),
    );
  }
  earnings.push(
    renderRow({ label: 'Tech Allowance', detail: 'Bonus', amount: php(view.techBonus) }),
    renderRow({ label: 'Attendance Incentive', detail: 'Bonus', amount: php(view.attendanceBonus) }),
    renderRow({ label: 'Performance Bonus', detail: 'Bonus', amount: php(view.performanceBonus) }),
  );
  // Orphanage renders only when there's money on it (see `showsOrphanageLine`),
  // so whichever of these two is last must drop its bottom rule.
  const hasOrphanage = showsOrphanageLine(view);
  earnings.push(
    renderRow({
      label: 'Adjustment',
      detail: esc(view.adjustmentNote || 'Manual adjustment'),
      amount: php(view.adjustment),
      last: !hasOrphanage,
    }),
  );
  if (hasOrphanage) {
    earnings.push(
      renderRow({
        label: 'Orphanage',
        detail: 'Contribution',
        amount: `+${php(view.orphanagePay)}`,
        amountColor: '#0f766e',
        last: true,
      }),
    );
  }

  const mesa = [
    renderRow({
      label: 'MESA Reimbursement',
      detail: 'Payout',
      amount: `+${php(view.mesaDisbursement)}`,
      amountColor: '#0f766e',
    }),
    renderRow({
      label: 'MESA Deduction',
      detail: 'Contribution',
      amount: `-${php(view.mesaDeduction)}`,
      amountColor: '#b3261e',
      last: true,
    }),
  ];

  const statusBlock = isPaid
    ? '<div style="display:inline-block;margin-top:8px;padding:4px 10px;border:1px solid #a7f3d0;' +
      'border-radius:999px;background-color:#ecfdf5;font-size:11px;line-height:14px;' +
      `font-weight:600;color:#047857;">${paidLabel ? `Paid ${esc(paidLabel)}` : 'Paid'}</div>`
    : opts.status
      ? '<div style="display:inline-block;margin-top:8px;padding:4px 10px;border:1px solid #fed7aa;' +
        'border-radius:999px;background-color:#fff7ed;font-size:11px;line-height:14px;' +
        'font-weight:600;color:#c2410c;">Pending</div>'
      : '<div style="font-size:11px;line-height:16px;color:#556377;margin-top:5px;">' +
        'Confidential pay record</div>';

  // Colombian (COP-country) payees only — the native figure their bank receives,
  // off the same USD anchor Payment Dispatch pays from.
  const copRow =
    view.totalPayCop != null
      ? '<tr>' +
        '<td style="padding-top:4px;font-size:12px;line-height:17px;color:#556377;">COP equivalent</td>' +
        '<td align="right" style="padding-top:4px;font-size:12px;line-height:17px;' +
        `font-weight:700;color:#26384d;white-space:nowrap;">${esc(formatCop(view.totalPayCop))}</td>` +
        '</tr>'
      : '';

  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1.0" />
<meta name="color-scheme" content="light" />
<meta name="supported-color-schemes" content="light" />
<title>Pay Statement</title>
<style>
body,table,td,a{-webkit-text-size-adjust:100%;-ms-text-size-adjust:100%;}
table,td{mso-table-lspace:0pt;mso-table-rspace:0pt;}
img{-ms-interpolation-mode:bicubic;border:0;height:auto;line-height:100%;outline:none;text-decoration:none;}
table{border-collapse:collapse !important;}
html{height:100% !important;}
body{height:100% !important;margin:0 !important;padding:0 !important;width:100% !important;}
body,table,td,div,p,a{font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,Helvetica,Arial,sans-serif;-webkit-font-smoothing:antialiased;-moz-osx-font-smoothing:grayscale;}
.amount-main,.line-amount{font-variant-numeric:tabular-nums;font-feature-settings:"tnum" 1;}
.line-label{width:44%;padding:6px 0;font-size:13px;line-height:15px;color:#26384d;vertical-align:top;word-break:break-word;}
.detail-col{width:28%;padding:6px 8px;font-size:12px;line-height:15px;color:#556377;vertical-align:top;word-break:break-word;}
.line-amount{width:28%;padding:6px 0;font-size:13px;line-height:15px;font-weight:700;vertical-align:top;white-space:nowrap;}
@media screen and (max-width:600px){
.email-shell{padding:18px 10px !important;}
.statement-card{width:100% !important;max-width:100% !important;}
.px{padding-left:20px !important;padding-right:20px !important;}
.top-pad{padding-top:14px !important;}
.brand-logo{width:92px !important;}
.amount-main{font-size:30px !important;line-height:36px !important;}
.stack-cell{display:block !important;width:100% !important;text-align:left !important;padding-right:0 !important;}
.stack-cell+.stack-cell{padding-top:12px !important;}
.detail-col{display:none !important;}
.detail-stacked{display:block !important;}
.line-label{width:65% !important;}
.line-amount{width:35% !important;}
}
</style>
</head>

<body style="margin:0;padding:0;height:100%;background-color:#f4f7fb;">
<div style="display:none;max-height:0;overflow:hidden;opacity:0;color:transparent;font-size:1px;line-height:1px;">Pay statement for ${esc(weekHuman)}</div>
<table role="presentation" cellpadding="0" cellspacing="0" border="0" width="100%" height="100%" class="email-shell" style="height:100vh;background-color:#f4f7fb;padding:20px 16px;">
<tr>
<td align="center" valign="middle" style="vertical-align:middle;">
<table role="presentation" cellpadding="0" cellspacing="0" border="0" width="560" class="statement-card" style="width:560px;max-width:560px;background-color:#f97316;border-radius:17px;box-shadow:0 20px 48px rgba(16, 32, 52, 0.16), 0 2px 6px rgba(16, 32, 52, 0.07);overflow:hidden;">
<tr>
<td style="padding:3px;font-size:0;line-height:0;">
<table role="presentation" cellpadding="0" cellspacing="0" border="0" width="100%" style="width:100%;background-color:#fbfcfe;border-radius:14px;overflow:hidden;">

<tr>
<td class="px top-pad" align="center" style="padding:18px 32px 14px 32px;background-color:#ffffff;border-bottom:1px solid #eef2f6;text-align:center;">
<img class="brand-logo" src="https://host.simple.biz/email/simplelogo.png" alt="Simple" width="112" style="display:block;width:112px;height:auto;border:0;margin:0 auto 8px auto;" />
<div style="font-size:26px;line-height:32px;font-weight:700;color:#102034;margin-top:0;letter-spacing:0;text-align:center;">Pay Statement</div>
<div style="font-size:13px;line-height:19px;color:#556377;margin-top:3px;text-align:center;">Period ending <span style="font-weight:700;color:#334155;">${esc(weekHuman)}</span></div>
${statusBlock}
</td>
</tr>

<tr>
<td class="px" style="padding:12px 32px 12px 32px;">
<table role="presentation" cellpadding="0" cellspacing="0" border="0" width="100%" style="background-color:#f8fafc;border:1px solid #e2e8f0;border-radius:10px;overflow:hidden;">
<tr><td style="${SEC_HEAD_STYLE}padding:5px 20px;letter-spacing:0.11em;">Total Net Pay</td></tr>
<tr>
<td style="padding:9px 20px 10px 20px;">
<div class="amount-main" style="font-size:34px;line-height:40px;font-weight:800;color:#102034;margin-top:0;letter-spacing:0;white-space:nowrap;text-align:left;">${php(view.totalPayPhp)}</div>
<table role="presentation" cellpadding="0" cellspacing="0" border="0" width="100%" style="margin-top:6px;border-top:1px solid #e2e8f0;">
<tr>
<td style="padding-top:6px;font-size:12px;line-height:17px;color:#556377;">USD equivalent</td>
<td align="right" style="padding-top:6px;font-size:12px;line-height:17px;font-weight:700;color:#26384d;white-space:nowrap;">${esc(formatUsd(view.totalPayUsd))}</td>
</tr>
${copRow}
</table>
</td>
</tr>
</table>
</td>
</tr>

<tr>
<td class="px" style="padding:0 32px 10px 32px;">
<table role="presentation" cellpadding="0" cellspacing="0" border="0" width="100%" style="width:100%;">
<tr><td colspan="2" style="${SEC_HEAD_STYLE}">Employee</td></tr>
<tr>
<td class="stack-cell" style="width:50%;vertical-align:top;padding:8px 14px 8px 0;border-bottom:1px solid #e2e8f0;">
<div style="font-size:10px;line-height:13px;font-weight:700;letter-spacing:0.12em;text-transform:uppercase;color:#556377;">Recipient</div>
<div style="font-size:14px;line-height:20px;font-weight:700;color:#102034;margin-top:3px;">${esc(view.name || '—')}</div>
</td>
<td class="stack-cell" align="right" style="width:50%;vertical-align:top;text-align:right;padding:8px 0 8px 0;border-bottom:1px solid #e2e8f0;">
<div style="font-size:10px;line-height:13px;font-weight:700;letter-spacing:0.12em;text-transform:uppercase;color:#556377;">Department</div>
<div style="font-size:14px;line-height:20px;font-weight:700;color:#102034;margin-top:3px;">${esc(view.department || '—')}</div>
</td>
</tr>
</table>
</td>
</tr>

<tr>
<td class="px" style="padding:0 32px 5px 32px;">
<div style="${SEC_HEAD_STYLE}">Earnings</div>
${renderTable('Hours × Rate', earnings)}
</td>
</tr>

<tr>
<td class="px" style="padding:8px 32px 5px 32px;">
<div style="${SEC_HEAD_STYLE}">MESA Adjustment</div>
${renderTable('Type', mesa)}
</td>
</tr>

<tr>
<td class="px" style="padding:10px 32px 16px 32px;">
<table role="presentation" cellpadding="0" cellspacing="0" border="0" width="100%" style="background-color:#f8fafc;border:1px solid #e2e8f0;border-radius:10px;">
<tr><td style="padding:8px 14px;font-size:11px;line-height:16px;color:#556377;"><strong style="color:#334155;">Confidential:</strong> This statement is intended only for the recipient named above. Contact your payroll representative if any hours or totals need review.</td></tr>
</table>
</td>
</tr>

<tr>
<td class="px" style="background-color:#f8fafc;border-top:1px solid #eef2f6;padding:10px 32px;">
<table role="presentation" cellpadding="0" cellspacing="0" border="0" width="100%">
<tr>
<td style="font-size:11px;line-height:16px;color:#556377;">Automated dispatch from Simple HRIS</td>
<td align="right" style="font-size:11px;line-height:16px;font-weight:700;color:#334155;white-space:nowrap;">Simple Payroll</td>
</tr>
</table>
</td>
</tr>
</table>
</td>
</tr>
</table>
</td>
</tr>
</table>
</body>
</html>
`;
}
