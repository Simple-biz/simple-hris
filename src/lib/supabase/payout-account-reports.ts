import 'server-only';

import { createHmac } from 'crypto';
import { createSupabaseServiceRoleClient } from './server';
import { selectAllPaged } from './select-all-paged';
import { insertAuditLog } from './audit-log';
import { getEmployeeIdRowByEmail } from './employee-ids';
import { normEmail } from '@/lib/email/norm-email';
import { resolveWalletRailLock } from '@/lib/employee/wallet-rail-lock';
import { recordNotifyFailure } from '@/lib/notifications/notify-failure-audit';
import type { ProcessorId } from '@/lib/employee-payment-processors';
import {
  PAYOUT_ACCOUNT_STATUS_META,
  accountDisplayName,
  buildReportsView,
  reportableAccounts,
  type AccountKind,
  type AccountReportsView,
  type PayoutAccountStatus,
  type StoredAccountReport,
} from '@/lib/banking/payout-account-reports';

/**
 * Data layer for employee-reported account status
 * (docs/features/payout-account-reports.md). Reads and writes
 * `payout_account_reports` ONLY. It never writes `employee_ids` and never touches
 * routing; a source-scan test pins that (`payout-account-reports.test.ts`).
 */

const TABLE = 'payout_account_reports';
const SELECT =
  'id, account_kind, account_fingerprint, account_hint, account_label, status, note, reported_at, reported_via';

export type ReportChannel = 'external_link' | 'employee_dashboard';

/**
 * HMAC-SHA256 keyed on NEXTAUTH_SECRET. Null when the secret is absent, and every
 * caller then REFUSES: unlike the OTP pepper there is no constant fallback,
 * because a fingerprint under a known key is a brute-forceable account number.
 */
function makeFingerprinter(): ((input: string) => string) | null {
  const key = process.env.NEXTAUTH_SECRET?.trim();
  if (!key) return null;
  return (input: string) => createHmac('sha256', key).update(`payout-account-report:${input}`).digest('hex');
}

function isMissingTable(message: string): boolean {
  const m = message.toLowerCase();
  return m.includes(TABLE) && (m.includes('schema cache') || m.includes('does not exist') || m.includes('relation'));
}

const emailsOf = (list: ReadonlyArray<string | null | undefined>) =>
  [...new Set(list.map((e) => normEmail(e ?? '')).filter((e): e is string => !!e))];

/**
 * The person's payout row and the rail Payment Dispatch pays them on (all three
 * tiers, fails closed). The same two reads `/api/employee-ids?email=` makes.
 */
export async function loadPayoutRowAndRail(email: string): Promise<{
  row: Record<string, unknown> | null;
  rail: ProcessorId | null;
  error: string | null;
}> {
  const { row, error } = await getEmployeeIdRowByEmail(email);
  if (error) return { row: null, rail: null, error };
  const lock = await resolveWalletRailLock(email, { row });
  if (lock.error) return { row: null, rail: null, error: lock.error };
  return { row: (row ?? null) as unknown as Record<string, unknown> | null, rail: lock.effectiveRail, error: null };
}

/**
 * Open reports for everyone the person is known as, matched to their CURRENT
 * accounts. A failed read, a missing table or a missing key is `unavailable`,
 * never "no reports": a read that failed is not a fact about the account.
 */
export async function readAccountReportsView(opts: {
  emails: ReadonlyArray<string | null | undefined>;
  row: Record<string, unknown> | null;
  rail: ProcessorId | null;
}): Promise<AccountReportsView> {
  const fingerprint = makeFingerprinter();
  const supabase = createSupabaseServiceRoleClient();
  const emails = emailsOf(opts.emails);
  if (!fingerprint || !supabase || emails.length === 0) return { status: 'unavailable' };
  try {
    const { rows, error } = await selectAllPaged<StoredAccountReport>((from, to) =>
      supabase
        .from(TABLE)
        .select(SELECT)
        .in('work_email', emails)
        .is('withdrawn_at', null)
        .order('id', { ascending: true })
        .range(from, to),
    );
    if (error) {
      console.error('[payout-account-reports] read failed:', error);
      return { status: 'unavailable' };
    }
    return buildReportsView(reportableAccounts(opts.row, opts.rail), rows, fingerprint);
  } catch (e) {
    console.error('[payout-account-reports] read threw:', e);
    return { status: 'unavailable' };
  }
}

export type ReportWriteResult = { ok: true } | { ok: false; status: number; error: string };

const UNAVAILABLE: ReportWriteResult = {
  ok: false,
  status: 503,
  error: "Account reporting isn't available right now. Please contact Accounting directly.",
};

/**
 * File a report on ONE of the person's own current accounts. An open report on the
 * same account is withdrawn as `superseded` first (one open report per account,
 * enforced by a unique index), so the history is kept. Audited, and Accounting is
 * alerted. Writes nothing else.
 */
export async function fileAccountReport(opts: {
  workEmail: string;
  displayName: string | null;
  row: Record<string, unknown> | null;
  rail: ProcessorId | null;
  kind: AccountKind;
  status: PayoutAccountStatus;
  note: string | null;
  via: ReportChannel;
  ip: string | null;
}): Promise<ReportWriteResult> {
  const fingerprint = makeFingerprinter();
  const supabase = createSupabaseServiceRoleClient();
  const workEmail = normEmail(opts.workEmail);
  if (!fingerprint || !supabase || !workEmail) return UNAVAILABLE;

  const target = reportableAccounts(opts.row, opts.rail).find((a) => a.kind === opts.kind);
  if (!target) {
    return { ok: false, status: 400, error: 'That account is not on your payout record any more. Reload and try again.' };
  }
  const fp = fingerprint(target.fingerprintInput);
  const nowIso = new Date().toISOString();

  const { error: supErr } = await supabase
    .from(TABLE)
    .update({ withdrawn_at: nowIso, withdrawn_via: 'superseded' })
    .eq('work_email', workEmail)
    .eq('account_fingerprint', fp)
    .is('withdrawn_at', null);
  if (supErr) {
    if (isMissingTable(supErr.message)) return UNAVAILABLE;
    return { ok: false, status: 500, error: 'We could not save your report. Please try again.' };
  }

  const { data, error } = await supabase
    .from(TABLE)
    .insert({
      work_email: workEmail,
      account_kind: target.kind,
      account_fingerprint: fp,
      account_hint: target.hint,
      account_label: target.label,
      status: opts.status,
      note: opts.note,
      reported_via: opts.via,
      reported_by: workEmail,
      ip_address: opts.ip,
    })
    .select('id')
    .single();
  if (error || !data) {
    if (error && isMissingTable(error.message)) return UNAVAILABLE;
    // A concurrent report on the same account trips the one-open index.
    return { ok: false, status: 409, error: 'That account was just reported. Reload to see it.' };
  }
  const reportId = String((data as { id: string }).id);

  const details = {
    via: opts.via,
    report_id: reportId,
    account_kind: target.kind,
    account: accountDisplayName(target),
    status: opts.status,
    pays_here: target.paysHere,
    has_note: !!opts.note,
  };
  await insertAuditLog({
    user_name: opts.displayName || workEmail,
    user_role: opts.via === 'external_link' ? 'employee (external link)' : 'employee (dashboard)',
    action: 'bank_update.account_reported',
    resource: TABLE,
    resource_id: workEmail,
    details,
    ip_address: opts.ip,
  });
  await notifyAccounting({
    supabase,
    workEmail,
    displayName: opts.displayName,
    title: `Bank account reported ${PAYOUT_ACCOUNT_STATUS_META[opts.status].badge}`,
    message: [
      `${opts.displayName || workEmail} reported their ${accountDisplayName(target)} as ${PAYOUT_ACCOUNT_STATUS_META[opts.status].label.toLowerCase()}`,
      `(${target.paysHere ? 'this is the account payroll pays' : 'payroll does not pay this account today'})`,
      `via the ${opts.via === 'external_link' ? 'external link' : 'Employee Dashboard'}.`,
      target.paysHere ? 'Check with them before paying into it. Nothing was re-routed.' : '',
      opts.note ? `Their note: "${opts.note}"` : '',
    ]
      .filter(Boolean)
      .join(' '),
    details: { work_email: workEmail, via: opts.via, account_report: details },
  });
  return { ok: true };
}

/** Withdraw the person's OWN open report ("this account works again"). */
export async function withdrawAccountReport(opts: {
  workEmails: ReadonlyArray<string | null | undefined>;
  displayName: string | null;
  reportId: string;
  via: ReportChannel;
  ip: string | null;
}): Promise<ReportWriteResult> {
  const supabase = createSupabaseServiceRoleClient();
  const emails = emailsOf(opts.workEmails);
  if (!supabase || emails.length === 0) return UNAVAILABLE;
  if (!/^[0-9a-f-]{36}$/i.test(opts.reportId)) return { ok: false, status: 400, error: 'Unknown report.' };

  // Owner-checked: the report must belong to one of the caller's own addresses.
  const { data, error } = await supabase
    .from(TABLE)
    .update({ withdrawn_at: new Date().toISOString(), withdrawn_via: opts.via })
    .eq('id', opts.reportId)
    .in('work_email', emails)
    .is('withdrawn_at', null)
    .select('id, work_email, account_kind, account_hint, account_label, status');
  if (error) {
    if (isMissingTable(error.message)) return UNAVAILABLE;
    return { ok: false, status: 500, error: 'We could not update your report. Please try again.' };
  }
  const row = Array.isArray(data) ? (data[0] as Record<string, string | null> | undefined) : undefined;
  if (!row) return { ok: false, status: 404, error: 'That report is not open any more. Reload to see the latest.' };

  const workEmail = String(row.work_email);
  const account = accountDisplayName({ label: row.account_label ?? null, hint: String(row.account_hint ?? '') });
  const details = { via: opts.via, report_id: opts.reportId, account_kind: row.account_kind, account, status: row.status };
  await insertAuditLog({
    user_name: opts.displayName || workEmail,
    user_role: opts.via === 'external_link' ? 'employee (external link)' : 'employee (dashboard)',
    action: 'bank_update.account_report_withdrawn',
    resource: TABLE,
    resource_id: workEmail,
    details,
    ip_address: opts.ip,
  });
  await notifyAccounting({
    supabase,
    workEmail,
    displayName: opts.displayName,
    title: 'Bank account report withdrawn',
    message: `${opts.displayName || workEmail} says their ${account} works again and withdrew their report.`,
    details: { work_email: workEmail, via: opts.via, account_report_withdrawn: details },
  });
  return { ok: true };
}

/**
 * Alert the live admin / accounting / ceo role holders. The type is the one the
 * self-service bank saves already use (`people.banking.self_updated`, `neutral`):
 * a new type would be rejected by the CHECK until an ALTER ran
 * (notification-alerts.md). A failed insert is recorded, never fatal.
 */
async function notifyAccounting(opts: {
  supabase: NonNullable<ReturnType<typeof createSupabaseServiceRoleClient>>;
  workEmail: string;
  displayName: string | null;
  title: string;
  message: string;
  details: Record<string, unknown>;
}): Promise<void> {
  try {
    const { data: roleRows, error: roleErr } = await opts.supabase
      .from('employee_roles')
      .select('work_email')
      .in('role', ['admin', 'accounting', 'ceo'])
      .is('revoked_at', null);
    if (roleErr) throw new Error(roleErr.message);
    const recipients = emailsOf((roleRows ?? []).map((r: { work_email?: string | null }) => r.work_email));
    if (recipients.length === 0) return;
    const { error } = await opts.supabase.from('employee_notifications').insert(
      recipients.map((to) => ({
        recipient_email: to,
        type: 'people.banking.self_updated',
        tone: 'neutral',
        title: opts.title,
        message: opts.message,
        details: opts.details,
      })),
    );
    if (error) throw new Error(error.message);
  } catch (e) {
    await recordNotifyFailure({
      notificationType: 'people.banking.self_updated',
      origin: 'payout-account-reports',
      error: e,
      actor: { user_name: opts.displayName || opts.workEmail, user_role: 'employee' },
      details: { work_email: opts.workEmail },
    });
  }
}
