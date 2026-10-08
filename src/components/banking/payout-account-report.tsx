'use client';

import { useEffect, useState } from 'react';
import { AlertOctagon, Ban, CircleHelp, Loader2, Lock, ShieldOff, Snowflake, Undo2 } from 'lucide-react';
import { Button } from '@/components/ui/button';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { cn } from '@/lib/utils';
import { formatDateOnly } from '@/lib/date-only';
import {
  PAYOUT_ACCOUNT_STATUSES,
  PAYOUT_ACCOUNT_STATUS_META,
  REPORT_NOTE_MAX,
  accountDisplayName,
  parseAccountReportsView,
  type AccountKind,
  type AccountReportView,
  type AccountReportsView,
  type PayoutAccountStatus,
  type ReportableAccountView,
} from '@/lib/banking/payout-account-reports';

/**
 * Employee-reported account status (docs/features/payout-account-reports.md).
 *
 * - `AccountReportsPanel` — the employee's list of their own accounts with
 *   "Report a problem" / "It works again". Shared by Profile → Payout and the
 *   public /update-bank-info page.
 * - `PayoutAccountReportsBanner` — what Accounting sees on Mark Paid and People →
 *   Banking. Self-fetching, so each host mounts one line.
 *
 * A report INFORMS. Nothing on this file changes where anyone is paid.
 */

const STATUS_ICON: Record<PayoutAccountStatus, typeof Ban> = {
  closed: Ban,
  deactivated: ShieldOff,
  frozen: Snowflake,
  other: CircleHelp,
};

const day = (iso: string) => formatDateOnly(iso.slice(0, 10));

function KindChip({ paysHere, kind }: { paysHere: boolean; kind: AccountKind }) {
  return (
    <span
      className={cn(
        'inline-flex shrink-0 items-center rounded-full px-2 py-0.5 text-[10.5px] font-medium',
        paysHere
          ? 'bg-emerald-100 text-emerald-800 dark:bg-emerald-950/50 dark:text-emerald-200'
          : 'bg-zinc-100 text-zinc-600 dark:bg-zinc-800 dark:text-zinc-300',
      )}
    >
      {paysHere ? 'Payroll pays here' : kind === 'wallet' ? 'Wallet' : 'Backup'}
    </span>
  );
}

function ReportedBadge({ report }: { report: AccountReportView }) {
  const Icon = STATUS_ICON[report.status];
  return (
    <span className="inline-flex items-center gap-1 rounded-full bg-rose-100 px-2 py-0.5 text-[10.5px] font-semibold text-rose-800 dark:bg-rose-950/50 dark:text-rose-200">
      <Icon className="h-3 w-3" aria-hidden />
      Reported {PAYOUT_ACCOUNT_STATUS_META[report.status].badge} · {day(report.reportedAt)}
    </span>
  );
}

// ── Employee ────────────────────────────────────────────────────────────────

export function AccountReportsPanel({
  view,
  onReport,
  onWithdraw,
  onAddNewAccount,
  idPrefix,
}: {
  /** Null renders nothing (the server sent no view). */
  view: AccountReportsView | null;
  /** Files the report; resolves to an error message, or null on success. */
  onReport: (kind: AccountKind, status: PayoutAccountStatus, note: string) => Promise<string | null>;
  onWithdraw: (reportId: string) => Promise<string | null>;
  /** Opens the edit form so the employee can add a replacement account. */
  onAddNewAccount?: () => void;
  idPrefix: string;
}) {
  const [reporting, setReporting] = useState<ReportableAccountView | null>(null);
  const [withdrawing, setWithdrawing] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  if (!view) return null;
  if (view.status === 'unavailable') {
    return (
      <p className="flex items-center gap-1.5 text-[12px] text-zinc-500 dark:text-zinc-400">
        <AlertOctagon className="h-3.5 w-3.5 shrink-0" aria-hidden />
        Reporting a closed or frozen account isn&rsquo;t available right now. If one of your accounts stopped
        working, tell Accounting directly.
      </p>
    );
  }
  if (view.accounts.length === 0 && view.staleReports.length === 0) return null;

  const paidReported = view.accounts.find((a) => a.paysHere && a.report);

  const withdraw = async (id: string) => {
    setWithdrawing(id);
    setError(null);
    const err = await onWithdraw(id);
    setWithdrawing(null);
    if (err) setError(err);
  };

  return (
    <div className="space-y-2.5 rounded-xl border border-zinc-200 bg-white/60 p-3.5 dark:border-zinc-800 dark:bg-zinc-900/40">
      <div>
        <p className="text-[13px] font-semibold text-zinc-800 dark:text-zinc-100">
          Has one of these accounts stopped working?
        </p>
        <p className="mt-0.5 text-[12px] leading-relaxed text-zinc-500 dark:text-zinc-400">
          If an account was closed, deactivated or frozen, report it here so Accounting knows before they pay
          you. Reporting does not change where you are paid.
        </p>
      </div>

      {paidReported && (
        <div className="flex flex-wrap items-start justify-between gap-2 rounded-lg border border-rose-300 bg-rose-50/80 px-3 py-2.5 text-[12.5px] text-rose-900 dark:border-rose-900/60 dark:bg-rose-950/30 dark:text-rose-100">
          <p className="min-w-0 flex-1 leading-relaxed">
            <span className="font-semibold">Payroll still pays the account you reported.</span> Add your new
            account so your next payment isn&rsquo;t delayed or returned.
          </p>
          {onAddNewAccount && (
            <Button type="button" size="sm" className="h-7 shrink-0 text-[12px]" onClick={onAddNewAccount}>
              Add new account
            </Button>
          )}
        </div>
      )}

      <ul className="divide-y divide-zinc-100 dark:divide-zinc-800">
        {view.accounts.map((a) => (
          <li key={a.kind} className="flex flex-wrap items-center justify-between gap-2 py-2">
            <div className="min-w-0 space-y-1">
              <div className="flex flex-wrap items-center gap-1.5">
                <span className="font-mono text-[12.5px] text-zinc-800 dark:text-zinc-100">{accountDisplayName(a)}</span>
                <KindChip paysHere={a.paysHere} kind={a.kind} />
              </div>
              {a.report && (
                <div className="flex flex-wrap items-center gap-1.5">
                  <ReportedBadge report={a.report} />
                  {a.report.note && (
                    <span className="text-[11.5px] text-zinc-500 dark:text-zinc-400">&ldquo;{a.report.note}&rdquo;</span>
                  )}
                </div>
              )}
            </div>
            {a.report ? (
              <Button
                type="button"
                size="sm"
                variant="outline"
                className="h-7 gap-1 text-[12px]"
                disabled={withdrawing !== null}
                onClick={() => a.report && withdraw(a.report.id)}
              >
                {withdrawing === a.report.id ? <Loader2 className="h-3 w-3 animate-spin" /> : <Undo2 className="h-3 w-3" />}
                It works again
              </Button>
            ) : (
              <Button
                type="button"
                size="sm"
                variant="outline"
                className="h-7 text-[12px]"
                onClick={() => {
                  setError(null);
                  setReporting(a);
                }}
              >
                Report a problem
              </Button>
            )}
          </li>
        ))}
      </ul>

      {view.staleReports.length > 0 && (
        <div className="space-y-1 border-t border-zinc-100 pt-2 dark:border-zinc-800">
          <p className="text-[11px] font-medium uppercase tracking-wide text-zinc-400">No longer on your record</p>
          {view.staleReports.map((r) => (
            <div key={r.id} className="flex flex-wrap items-center justify-between gap-2 text-[12px] text-zinc-500 dark:text-zinc-400">
              <span>
                {accountDisplayName(r)} · reported {PAYOUT_ACCOUNT_STATUS_META[r.status].label.toLowerCase()} on{' '}
                {day(r.reportedAt)}
              </span>
              <button
                type="button"
                className="text-[11.5px] underline-offset-2 hover:underline disabled:opacity-50"
                disabled={withdrawing !== null}
                onClick={() => withdraw(r.id)}
              >
                Clear
              </button>
            </div>
          ))}
        </div>
      )}

      {error && <p className="text-[12px] text-rose-700 dark:text-rose-300" role="alert">{error}</p>}

      {reporting && (
        <ReportAccountDialog
          idPrefix={idPrefix}
          account={reporting}
          onClose={() => setReporting(null)}
          onSubmit={async (status, note) => {
            const err = await onReport(reporting.kind, status, note);
            if (!err) setReporting(null);
            return err;
          }}
        />
      )}
    </div>
  );
}

function ReportAccountDialog({
  account,
  onClose,
  onSubmit,
  idPrefix,
}: {
  account: ReportableAccountView;
  onClose: () => void;
  onSubmit: (status: PayoutAccountStatus, note: string) => Promise<string | null>;
  idPrefix: string;
}) {
  const [status, setStatus] = useState<PayoutAccountStatus | null>(null);
  const [note, setNote] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const needsNote = status === 'other' && note.trim().length < 3;

  const submit = async () => {
    if (!status || needsNote) return;
    setBusy(true);
    setError(null);
    const err = await onSubmit(status, note);
    setBusy(false);
    if (err) setError(err);
  };

  return (
    <Dialog open onOpenChange={(o) => !o && !busy && onClose()}>
      <DialogContent className="max-h-[90dvh] overflow-y-auto sm:max-w-md">
        <DialogHeader>
          <DialogTitle>Report a problem with this account</DialogTitle>
          <DialogDescription>
            <span className="font-mono">{accountDisplayName(account)}</span>
            {account.paysHere ? ' — payroll pays this account today.' : ' — payroll does not pay this account today.'}
          </DialogDescription>
        </DialogHeader>

        <div role="radiogroup" aria-label="What is wrong with the account" className="grid gap-2">
          {PAYOUT_ACCOUNT_STATUSES.map((s) => {
            const Icon = STATUS_ICON[s];
            const on = status === s;
            return (
              <button
                key={s}
                type="button"
                role="radio"
                aria-checked={on}
                disabled={busy}
                onClick={() => setStatus(s)}
                className={cn(
                  'flex items-start gap-2.5 rounded-lg border px-3 py-2 text-left transition-colors',
                  on
                    ? 'border-rose-400 bg-rose-50 dark:border-rose-700 dark:bg-rose-950/40'
                    : 'border-zinc-200 bg-white/70 hover:border-zinc-300 dark:border-zinc-800 dark:bg-zinc-900/40',
                )}
              >
                <Icon className={cn('mt-0.5 h-4 w-4 shrink-0', on ? 'text-rose-600 dark:text-rose-300' : 'text-zinc-400')} aria-hidden />
                <span>
                  <span className="block text-[13px] font-medium">{PAYOUT_ACCOUNT_STATUS_META[s].label}</span>
                  <span className="block text-[12px] text-zinc-500 dark:text-zinc-400">{PAYOUT_ACCOUNT_STATUS_META[s].description}</span>
                </span>
              </button>
            );
          })}
        </div>

        <div className="grid gap-1.5">
          <label htmlFor={`${idPrefix}-note`} className="text-[12px] font-medium">
            Anything Accounting should know? {status === 'other' ? '(required)' : '(optional)'}
          </label>
          <textarea
            id={`${idPrefix}-note`}
            value={note}
            maxLength={REPORT_NOTE_MAX}
            disabled={busy}
            onChange={(e) => setNote(e.target.value)}
            rows={3}
            placeholder="e.g. The bank closed it on October 1."
            className="w-full resize-none rounded-lg border border-zinc-200 bg-white/80 px-3 py-2 text-[13px] outline-none focus-visible:ring-2 focus-visible:ring-rose-300 dark:border-zinc-800 dark:bg-zinc-900/60"
          />
          <p className="text-[11px] text-zinc-500 dark:text-zinc-400">
            Don&rsquo;t type a full account number here. Long numbers are cut to their last 4 digits.
          </p>
        </div>

        <p className="flex items-start gap-1.5 rounded-lg bg-zinc-100/80 px-3 py-2 text-[12px] text-zinc-600 dark:bg-zinc-900/60 dark:text-zinc-300">
          <Lock className="mt-0.5 h-3.5 w-3.5 shrink-0" aria-hidden />
          Accounting is told right away. This does not change where you are paid: to get paid into a different
          account, update your bank details.
        </p>

        {error && <p className="text-[12px] text-rose-700 dark:text-rose-300" role="alert">{error}</p>}

        <DialogFooter>
          <Button type="button" variant="outline" onClick={onClose} disabled={busy}>
            Cancel
          </Button>
          <Button type="button" onClick={submit} disabled={busy || !status || needsNote}>
            {busy ? <Loader2 className="mr-1.5 h-3.5 w-3.5 animate-spin" /> : null}
            Send report
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

// ── Accounting ──────────────────────────────────────────────────────────────

/**
 * Accounting's view of a person's open reports, for Mark Paid and People →
 * Banking. Renders nothing while loading and when nothing is reported; a failed
 * read SAYS so, because "we could not check" must not look like "nothing reported".
 * Reports on accounts no longer on the record are left out: they describe nothing
 * a clerk could pay into.
 */
export function PayoutAccountReportsBanner({ email, className }: { email: string | null | undefined; className?: string }) {
  const [view, setView] = useState<AccountReportsView | null>(null);

  useEffect(() => {
    const target = (email ?? '').trim();
    setView(null);
    if (!target) return;
    let alive = true;
    fetch(`/api/payout-account-reports?email=${encodeURIComponent(target)}`, { cache: 'no-store' })
      .then(async (res) => {
        const json = (await res.json().catch(() => ({}))) as { accountReports?: unknown };
        if (!alive) return;
        setView(res.ok ? (parseAccountReportsView(json.accountReports) ?? { status: 'unavailable' }) : { status: 'unavailable' });
      })
      .catch(() => alive && setView({ status: 'unavailable' }));
    return () => {
      alive = false;
    };
  }, [email]);

  if (!view) return null;
  if (view.status === 'unavailable') {
    return (
      <p className={cn('flex items-center gap-1.5 text-[11.5px] text-zinc-500 dark:text-zinc-400', className)}>
        <AlertOctagon className="h-3.5 w-3.5 shrink-0" aria-hidden />
        Couldn&rsquo;t check whether the employee reported an account closed or frozen.
      </p>
    );
  }
  const reported = view.accounts.filter((a) => a.report);
  if (reported.length === 0) return null;
  return (
    <div className={cn('space-y-1.5', className)}>
      {reported.map((a) => {
        const r = a.report as AccountReportView;
        const Icon = STATUS_ICON[r.status];
        return (
          <div
            key={r.id}
            role="alert"
            className="flex items-start gap-2 rounded-lg border border-rose-300 bg-rose-50 px-3 py-2 text-[12.5px] text-rose-900 dark:border-rose-900/60 dark:bg-rose-950/40 dark:text-rose-100"
          >
            <Icon className="mt-0.5 h-4 w-4 shrink-0 text-rose-600 dark:text-rose-300" aria-hidden />
            <div className="min-w-0 leading-relaxed">
              <p>
                <span className="font-semibold">
                  Employee reported {accountDisplayName(a)} {PAYOUT_ACCOUNT_STATUS_META[r.status].badge}
                </span>{' '}
                on {day(r.reportedAt)}.{' '}
                {a.paysHere
                  ? 'This is the account payroll pays. Confirm with them before sending.'
                  : 'Payroll does not pay this account today.'}
              </p>
              {r.note && <p className="mt-0.5 text-rose-800/90 dark:text-rose-200/80">&ldquo;{r.note}&rdquo;</p>}
            </div>
          </div>
        );
      })}
    </div>
  );
}
