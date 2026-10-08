/**
 * Employee-reported account status: "this account of mine is closed / deactivated
 * / frozen". Kane, 2026-10-08: *"a mechanism for the Employees to mark these Bank
 * Accounts as closed, deactivated or frozen some stuff like that so Accounting
 * would know"*. docs/features/payout-account-reports.md.
 *
 * A report INFORMS. Nothing here, and nothing that calls it, writes
 * `employee_ids` or touches routing: the destination is changed only by the edit
 * form (employee-profile.md §6.2). Accounting decides what to do with a payment
 * to a reported account.
 *
 * PURE: no I/O. The fingerprint (an HMAC of the account) is computed server-side
 * and injected, so the full number never reaches a view, a client, or the table.
 */
import { PROCESSOR_OPTIONS, type ProcessorId } from '@/lib/employee-payment-processors';
import { payoutDraftFromIdsRow, resolvePreferredAccountNumber } from '@/lib/employee/payout-completeness';
import { maskFieldValue } from '@/lib/bank-update/mask-field';
import { payoutDestinationKey } from './payout-change-safety';

export const PAYOUT_ACCOUNT_STATUSES = ['closed', 'deactivated', 'frozen', 'other'] as const;
export type PayoutAccountStatus = (typeof PAYOUT_ACCOUNT_STATUSES)[number];

export const PAYOUT_ACCOUNT_STATUS_META: Record<
  PayoutAccountStatus,
  { label: string; badge: string; description: string }
> = {
  closed: {
    label: 'Closed',
    badge: 'CLOSED',
    description: 'The account was closed, by me or by the bank.',
  },
  deactivated: {
    label: 'Deactivated / dormant',
    badge: 'DEACTIVATED',
    description: 'The account is inactive or dormant and can no longer receive money.',
  },
  frozen: {
    label: 'Frozen / on hold',
    badge: 'FROZEN',
    description: 'The bank froze, blocked or put a hold on the account.',
  },
  other: {
    label: 'Other problem',
    badge: 'PROBLEM',
    description: 'Something else stops this account receiving money. Tell us what.',
  },
};

export const ACCOUNT_KINDS = ['bank_primary', 'bank_alternative', 'wallet'] as const;
export type AccountKind = (typeof ACCOUNT_KINDS)[number];

export const REPORT_NOTE_MAX = 500;

/**
 * One account on the person's record that can be reported. `fingerprintInput`
 * holds the FULL value and is server-only: it is hashed and dropped, never put in
 * a view (see `toAccountView`).
 */
export type ReportableAccount = {
  kind: AccountKind;
  fingerprintInput: string;
  hint: string;
  label: string | null;
  /** Payment Dispatch pays this account today. */
  paysHere: boolean;
};

const digitsOf = (v: string) => v.replace(/\D/g, '');
const railLabel = (rail: ProcessorId) => PROCESSOR_OPTIONS.find((p) => p.id === rail)?.label ?? rail;

/**
 * The accounts an employee may report: each bank slot that holds an account
 * number (the alternative slot dropped when it is the same account), and the
 * wallet payroll pays when the rail is a wallet. `paysHere` uses the SAME
 * destination rule the payout safety check and Mark Paid use
 * (`payoutDestinationKey`), so the account flagged "payroll pays here" is the one
 * that is actually paid.
 */
export function reportableAccounts(
  row: Record<string, unknown> | null | undefined,
  rail: ProcessorId | null,
): ReportableAccount[] {
  if (!row) return [];
  const { payout } = payoutDraftFromIdsRow(row);
  const paid = payoutDestinationKey(row, rail);
  const out: ReportableAccount[] = [];

  const bankSlot = (kind: AccountKind, raw: string, bankName: string) => {
    const digits = digitsOf(raw);
    if (digits.length < 4) return;
    if (out.some((a) => a.fingerprintInput === `account:${digits}`)) return; // same account in both slots
    out.push({
      kind,
      fingerprintInput: `account:${digits}`,
      // Masked from the DIGITS: masking the typed form keeps separators inside
      // the visible tail, so '1234-5678-90' would show '8-90', three digits.
      hint: maskFieldValue('account_number', digits) ?? '',
      label: bankName || null,
      paysHere: paid?.kind === 'account' && paid.value === digits,
    });
  };
  bankSlot('bank_primary', payout.accountNumber, payout.bankName);
  bankSlot('bank_alternative', payout.altAccountNumber, payout.altBankName);

  if (paid?.kind === 'wallet' && rail) {
    out.push({
      kind: 'wallet',
      fingerprintInput: `wallet:${paid.value}`,
      hint: maskFieldValue('wise_email', paid.value) ?? paid.value,
      label: railLabel(rail),
      paysHere: true,
    });
  }
  // The paid account always leads.
  return out.sort((a, b) => Number(b.paysHere) - Number(a.paysHere));
}

// ── Input ───────────────────────────────────────────────────────────────────

/**
 * Clean a free-text note: control characters out, whitespace collapsed, capped.
 * Any run of 6+ digits keeps only its last 4, because a note is shown to
 * Accounting and kept forever, and "no trail holds a full account number"
 * (update-bank-info.md rule 22) applies to what an employee types too.
 */
export function normalizeReportNote(raw: unknown): string | null {
  if (typeof raw !== 'string') return null;
  const cleaned = raw
    .replace(/[\u0000-\u001f\u007f]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .replace(/\d(?:[\s-]?\d){5,}/g, (run) => {
      const d = run.replace(/\D/g, '');
      return `••••${d.slice(-4)}`;
    })
    .slice(0, REPORT_NOTE_MAX)
    .trim();
  return cleaned || null;
}

export type ReportInput =
  | { ok: true; kind: AccountKind; status: PayoutAccountStatus; note: string | null }
  | { ok: false; error: string };

export function validateReportInput(body: Record<string, unknown>): ReportInput {
  const kind = body.account_kind;
  const status = body.status;
  if (typeof kind !== 'string' || !(ACCOUNT_KINDS as readonly string[]).includes(kind)) {
    return { ok: false, error: 'Choose which account you are reporting.' };
  }
  if (typeof status !== 'string' || !(PAYOUT_ACCOUNT_STATUSES as readonly string[]).includes(status)) {
    return { ok: false, error: 'Choose what is wrong with the account.' };
  }
  const note = normalizeReportNote(body.note);
  if (status === 'other' && (!note || note.length < 3)) {
    return { ok: false, error: 'Tell us briefly what is wrong with the account.' };
  }
  return { ok: true, kind: kind as AccountKind, status: status as PayoutAccountStatus, note };
}

// ── The view ────────────────────────────────────────────────────────────────

/** A stored report, as the server reads it. */
export type StoredAccountReport = {
  id: string;
  account_kind: string;
  account_fingerprint: string;
  account_hint: string;
  account_label: string | null;
  status: string;
  note: string | null;
  reported_at: string;
  reported_via: string;
};

/** What a client sees of a report. No fingerprint, no full value. */
export type AccountReportView = {
  id: string;
  status: PayoutAccountStatus;
  note: string | null;
  reportedAt: string;
  reportedVia: string;
  /** Where the account sat when it was reported. */
  reportedKind: AccountKind;
  hint: string;
  label: string | null;
  /** Which current account it still names, or null when that account has left the record. */
  appliesTo: AccountKind | null;
  /** The reported account is the one payroll pays today. */
  paysHere: boolean;
};

export type ReportableAccountView = {
  kind: AccountKind;
  hint: string;
  label: string | null;
  paysHere: boolean;
  report: AccountReportView | null;
};

export type AccountReportsView =
  | { status: 'ok'; accounts: ReportableAccountView[]; staleReports: AccountReportView[] }
  | { status: 'unavailable' };

const asStatus = (s: string): PayoutAccountStatus =>
  (PAYOUT_ACCOUNT_STATUSES as readonly string[]).includes(s) ? (s as PayoutAccountStatus) : 'other';
const asKind = (k: string): AccountKind =>
  (ACCOUNT_KINDS as readonly string[]).includes(k) ? (k as AccountKind) : 'bank_primary';

/**
 * Match open reports to the person's CURRENT accounts by fingerprint. A report
 * names the account, not the slot: moved to the other slot it still applies;
 * replaced, it applies to nothing and is listed as stale ("no longer on file").
 */
export function buildReportsView(
  accounts: ReadonlyArray<ReportableAccount>,
  reports: ReadonlyArray<StoredAccountReport>,
  fingerprint: (input: string) => string,
): Extract<AccountReportsView, { status: 'ok' }> {
  const byFp = new Map(accounts.map((a) => [fingerprint(a.fingerprintInput), a] as const));
  const newestFirst = [...reports].sort((a, b) => (a.reported_at < b.reported_at ? 1 : -1));
  const views = newestFirst.map((r): AccountReportView => {
    const current = byFp.get(r.account_fingerprint) ?? null;
    return {
      id: r.id,
      status: asStatus(r.status),
      note: r.note,
      reportedAt: r.reported_at,
      reportedVia: r.reported_via,
      reportedKind: asKind(r.account_kind),
      hint: r.account_hint,
      label: r.account_label,
      appliesTo: current?.kind ?? null,
      paysHere: current?.paysHere ?? false,
    };
  });
  return {
    status: 'ok',
    accounts: accounts.map((a) => ({
      kind: a.kind,
      hint: a.hint,
      label: a.label,
      paysHere: a.paysHere,
      report: views.find((v) => v.appliesTo === a.kind) ?? null,
    })),
    staleReports: views.filter((v) => v.appliesTo === null),
  };
}

/** Read a view off an API payload: absent → null (render nothing), malformed → unavailable. */
export function parseAccountReportsView(raw: unknown): AccountReportsView | null {
  if (raw == null) return null;
  if (typeof raw !== 'object') return { status: 'unavailable' };
  const o = raw as Record<string, unknown>;
  if (o.status !== 'ok' || !Array.isArray(o.accounts) || !Array.isArray(o.staleReports)) {
    return { status: 'unavailable' };
  }
  const str = (v: unknown) => (typeof v === 'string' ? v : null);
  const report = (v: unknown): AccountReportView | null => {
    if (!v || typeof v !== 'object') return null;
    const r = v as Record<string, unknown>;
    const id = str(r.id);
    const reportedAt = str(r.reportedAt);
    if (!id || !reportedAt) return null;
    const applies = str(r.appliesTo);
    return {
      id,
      status: asStatus(str(r.status) ?? ''),
      note: str(r.note),
      reportedAt,
      reportedVia: str(r.reportedVia) ?? '',
      reportedKind: asKind(str(r.reportedKind) ?? ''),
      hint: str(r.hint) ?? '',
      label: str(r.label),
      appliesTo: applies && (ACCOUNT_KINDS as readonly string[]).includes(applies) ? (applies as AccountKind) : null,
      paysHere: r.paysHere === true,
    };
  };
  const accounts: ReportableAccountView[] = [];
  for (const v of o.accounts) {
    if (!v || typeof v !== 'object') return { status: 'unavailable' };
    const a = v as Record<string, unknown>;
    const kind = str(a.kind);
    if (!kind || !(ACCOUNT_KINDS as readonly string[]).includes(kind)) return { status: 'unavailable' };
    accounts.push({
      kind: kind as AccountKind,
      hint: str(a.hint) ?? '',
      label: str(a.label),
      paysHere: a.paysHere === true,
      report: a.report == null ? null : report(a.report),
    });
  }
  const staleReports = o.staleReports.map(report).filter((r): r is AccountReportView => r !== null);
  return { status: 'ok', accounts, staleReports };
}

/** "BPI ••••7890", "Kolan j•••@gmail.com". */
export function accountDisplayName(a: { label: string | null; hint: string }): string {
  return [a.label, a.hint].filter(Boolean).join(' ');
}
