'use client';

import { useCallback, useEffect, useMemo, useRef, useState, type ChangeEvent, type ReactNode } from 'react';
import { toast } from 'sonner';
import {
  AlertTriangle,
  Archive,
  Banknote,
  CheckCircle2,
  CheckIcon,
  ChevronDownIcon,
  ChevronLeft,
  ChevronRight,
  ClipboardCopy,
  ClipboardList,
  Download,
  ExternalLink,
  Eye,
  EyeOff,
  FileSpreadsheet,
  FileText,
  Globe,
  Landmark,
  Link2,
  Loader2,
  Mail,
  Plus,
  RefreshCw,
  Search,
  Send,
  Sheet,
  ShieldCheck,
  Sparkles,
  Trash2,
  UploadCloud,
  User,
  UserCheck,
  Users,
  Wand2,
  XCircle,
} from 'lucide-react';
import { Select as SelectPrimitive } from '@base-ui/react/select';
import { derivationNameParts } from '@/lib/hr/work-email';
import { toTitleCaseNameOrNull } from '@/lib/text/sanitize-name';
import { getSupabaseBrowserClient } from '@/lib/supabase/browser';
import { getHrTabCache, hasHrTabCache, setHrTabCache, HR_TAB_CACHE_KEYS } from '@/lib/hr/tab-cache';
import { Button } from '@/components/ui/button';
import { DatePicker } from '@/components/ui/date-picker';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Badge } from '@/components/ui/badge';
import { Checkbox } from '@/components/ui/checkbox';
import { Skeleton } from '@/components/ui/skeleton';
import { Tabs as TabsPrimitive } from '@base-ui/react/tabs';
import { AnimatePresence, motion, useReducedMotion } from 'motion/react';
import {
  AGREEMENT_TITLES,
  ContractWorkerText,
  IntellectualPropertyText,
  NonSolicitationText,
  PrivacyText,
} from '@/components/onboarding/agreement-texts';
import { formatLongDate } from '@/lib/onboarding/ip-assignment-text';
import { currencyForCountry, ONBOARDING_COUNTRIES, resolveOnboardingCountry } from '@/lib/onboarding/countries';
import { addWeeks, formatWeekLabel, sundayIso } from '@/lib/hr/hiring-week';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { cn } from '@/lib/utils';
import {
  buildOnboardingExport,
  downloadOnboardingCsv,
  downloadOnboardingPdf,
  downloadOnboardingXlsx,
  type OnboardingExportInput,
} from '@/lib/hr/onboarding-export';
import { downloadContractsPacketPdf } from '@/lib/hr/onboarding-contracts-pdf';

function isPlausibleEmail(s: string): boolean {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(s.trim());
}

// Title-case the identity name fields on each submission as it enters state, so
// a SHOUTED / all-lowercase name ("JAN KANE REROMA") reads naturally
// ("Jan Kane Reroma") everywhere it's shown — the Submitted table, the detail
// drawer, the bulk dialogs and search — without touching every render site.
// Mixed-case names are left exactly as typed (see toTitleCaseName). Banking and
// gmail-surname fields are intentionally left alone. This is display-side only;
// the data is title-cased at write time and via the backfill migration too.
function withTitleCasedNames(rows: SubmissionRow[]): SubmissionRow[] {
  return rows.map((r) => ({
    ...r,
    full_name: toTitleCaseNameOrNull(r.full_name),
    invite_name: toTitleCaseNameOrNull(r.invite_name),
    ip_agreement_name: toTitleCaseNameOrNull(r.ip_agreement_name),
  }));
}

// Peso sign as a char code so this source stays ASCII (the editor on this box
// mangles literal non-ASCII bytes).
const CURRENCY_PESO = String.fromCharCode(0x20b1);

// Live preview of the onboarding paperwork — opens the same multi-step form
// (personal info, agreements, W-8BEN, payment method, contract signature) that
// new hires complete, in a no-save "preview" mode. See app/onboarding/[token].
const ONBOARDING_PAPERWORK_TEMPLATE_URL = '/onboarding/preview';

/** Shape returned by GET /api/hr/department-rates. SECURITY: this endpoint never
 *  ships pay-rate figures to the HR client — only whether Accounting has set an
 *  authoritative Payment Catalog rate for the department (`ready`). The actual
 *  rate is resolved server-side from the catalog at submit time. */
type DeptRateApi = {
  department: string;
  ready: boolean;
};

/** A department's compensation readiness as held in the form's lookup map.
 *  `ready` is true once Accounting has set an authoritative Payment Catalog rate;
 *  HR never sees the figure itself. */
type DeptRate = {
  ready: boolean;
};

// Runs `fn` over `items` with at most `limit` in-flight at once.
// Callers that previously used Promise.all/allSettled with no cap use this
// instead so bursts of bulk actions don't saturate the n8n webhook endpoints.
async function runPooled<T, R>(
  items: T[],
  limit: number,
  fn: (item: T) => Promise<R>,
): Promise<PromiseSettledResult<R>[]> {
  const results: PromiseSettledResult<R>[] = [];
  for (let i = 0; i < items.length; i += limit) {
    const chunk = items.slice(i, i + limit);
    const chunkResults = await Promise.allSettled(chunk.map(fn));
    results.push(...chunkResults);
  }
  return results;
}

type HrOnboardingStatus = 'pending' | 'submitted' | 'archived';
type PaymentMethod = 'hurupay' | 'wires';

type SubmissionRow = {
  id: string;
  token: string;
  status: HrOnboardingStatus;
  created_at: string;
  created_by: string | null;
  submitted_at: string | null;
  invite_name: string | null;
  invite_personal_email: string | null;
  invite_department: string | null;
  invite_country: string | null;
  invite_note: string | null;
  full_name: string | null;
  // Structured name parts (source of truth). OPTIONAL like calltools_* below —
  // the list query omits them for pre-migration safety; only the detail modal's
  // full-row fetch hydrates them. Null on pre-split-migration / manual hires.
  first_name?: string | null;
  last_name?: string | null;
  name_extension?: string | null;
  // DERIVED surname-first display name (`Surname, Given... "GoBy"`) from the DB
  // trigger; null until a hire submits. Display only — see migration #87.
  display_name: string | null;
  // Lead Gen only: the hire's self-chosen dialer nickname + the auto-minted
  // CallTools username ("Mikey J. T."). OPTIONAL because the list query omits
  // them (pre-migration safety) — only the detail modal's full-row fetch
  // hydrates them. Null/absent for every other department.
  calltools_nickname?: string | null;
  calltools_username?: string | null;
  phone: string | null;
  email: string | null;
  location: string | null;
  country: string | null;
  address_street: string | null;
  address_city: string | null;
  address_state: string | null;
  address_province: string | null;
  address_region: string | null;
  address_postal_code: string | null;
  ip_agreement_agreed: boolean | null;
  ip_agreement_name: string | null;
  ip_agreement_signature: string | null;
  ip_agreement_date: string | null;
  ip_assignment_file_path: string | null;
  ip_assignment_file_name: string | null;
  non_solicitation_signature: string | null;
  privacy_signature: string | null;
  w8ben_applicable: boolean | null;
  w8ben_file_path: string | null;
  w8ben_file_name: string | null;
  payment_method: PaymentMethod | null;
  hurupay_email: string | null;
  bank_full_name: string | null;
  bank_account_name: string | null;
  bank_account_number: string | null;
  bank_swift_code: string | null;
  bank_street: string | null;
  bank_city: string | null;
  bank_province: string | null;
  bank_postal_code: string | null;
  bank_full_address: string | null;
  contract_signature: string | null;
  contract_date: string | null;
  work_email: string | null;
  pending_employee_id: number | null;
  // Outcome of the create-workspace-account webhook (see set-work-email route).
  // ok === true  -> the address is a CONFIRMED designated work email (200).
  // ok === false -> minted but the automation failed; needs a retry.
  // ok == null   -> never attempted / legacy row (status unknown).
  workspace_account_ok: boolean | null;
  workspace_account_status: number | null;
  workspace_account_error: string | null;
  workspace_account_at: string | null;
  // Status of the linked pending hire (derived server-side) — used to show
  // "Archived/Complete" for an archived submission whose hire was promoted.
  pending_status?: string | null;
};

type StatusFilter = 'all' | HrOnboardingStatus;

/**
 * Designated-work-email state for a submission. Keeps the "do we have a real,
 * provisioned @simple.biz address" question in one place so the column, the
 * "needs work email" toggle, and the action buttons all agree.
 *
 *   'confirmed'  - work email minted AND the workspace webhook returned 200.
 *   'failed'     - work email minted but the webhook failed; retry needed.
 *   'unverified' - work email minted before we tracked the outcome (unknown).
 *   'none'       - no work email set yet.
 */
type WorkEmailState = 'confirmed' | 'failed' | 'unverified' | 'none';

function workEmailState(r: SubmissionRow): WorkEmailState {
  if (!r.work_email) return 'none';
  if (r.workspace_account_ok === true) return 'confirmed';
  if (r.workspace_account_ok === false) return 'failed';
  return 'unverified';
}

/**
 * A submitted hire still needs HR action when there's no work email yet OR the
 * workspace automation failed. A legacy 'unverified' row (set before we tracked
 * the outcome) is left alone — we have no signal that it failed.
 */
function needsWorkEmailSetup(r: SubmissionRow): boolean {
  const s = workEmailState(r);
  return s === 'none' || s === 'failed';
}

/** One row's outcome in a bulk verify run. */
type BulkVerifyResult = {
  id: string;
  name: string;
  email: string;
  state: 'exists' | 'missing' | 'error';
};

/** Drives the bulk verify modal: live progress, then the per-row results. */
type BulkVerifyState = {
  total: number;
  done: number;
  running: boolean;
  results: BulkVerifyResult[];
};

/** Drives the verify result modal: a loading phase, then the translated webhook
 *  outcome for the row being checked. */
type VerifyDialogState = {
  row: SubmissionRow;
  loading: boolean;
  result?: {
    state: 'exists' | 'missing' | 'error';
    httpStatus: number | null;
    detail: string | null;
  };
};

/**
 * Renders the "Designated Work Email" column. The address is shown as a real,
 * designated work email ONLY when the workspace webhook returned 200. A
 * minted-but-failed address is shown struck-through with a loud "Automation
 * failed" pill so HR never mistakes it for a provisioned account.
 *
 * Every row that has an address also gets a read-only "Verify" button — it
 * looks up the live Google Workspace account WITHOUT recreating it, so an
 * "Unverified" legacy row can be resolved to confirmed/failed with zero risk of
 * a duplicate account.
 */
function DesignatedWorkEmailCell({
  row,
  onVerify,
  verifying,
}: {
  row: SubmissionRow;
  onVerify: () => void;
  verifying: boolean;
}) {
  const state = workEmailState(row);

  if (state === 'none') {
    return <span className="text-xs text-zinc-400">Not set</span>;
  }

  let statusNode: ReactNode;
  if (state === 'confirmed') {
    statusNode = (
      <span
        className="inline-flex min-w-0 max-w-full items-center gap-1 break-all rounded-md border border-emerald-300 bg-emerald-50 px-2 py-1 font-mono text-[11px] font-medium text-emerald-900 dark:border-emerald-700 dark:bg-emerald-950/40 dark:text-emerald-100"
        title="Workspace account created - the onboarding webhook returned 200."
      >
        <CheckCircle2 className="h-3 w-3 shrink-0" />
        {row.work_email}
      </span>
    );
  } else if (state === 'failed') {
    statusNode = (
      <>
        <span
          className="inline-flex items-center gap-1 rounded-md border border-rose-300 bg-rose-50 px-2 py-0.5 text-[10px] font-semibold uppercase tracking-wide text-rose-700 dark:border-rose-800 dark:bg-rose-950/40 dark:text-rose-300"
          title={
            row.workspace_account_error
              ? `Account creation failed: ${row.workspace_account_error}`
              : 'The onboarding webhook did not return 200.'
          }
        >
          <XCircle className="h-3 w-3 shrink-0" />
          Account Creation Failed
        </span>
        <span className="break-all font-mono text-[11px] text-zinc-500 line-through decoration-rose-400/70">
          {row.work_email}
        </span>
        <span className="text-[10px] text-rose-600 dark:text-rose-400">
          Retry setup to provision the account.
        </span>
      </>
    );
  } else {
    // 'unverified' - minted before we tracked the webhook outcome.
    statusNode = (
      <>
        <span
          className="inline-flex min-w-0 max-w-full items-center gap-1 break-all rounded-md border border-amber-300 bg-amber-50 px-2 py-1 font-mono text-[11px] font-medium text-amber-900 dark:border-amber-700 dark:bg-amber-950/40 dark:text-amber-100"
          title="This address was set before the workspace outcome was tracked - status unknown. Click Verify to check Google Workspace."
        >
          <Mail className="h-3 w-3 shrink-0" />
          {row.work_email}
        </span>
        <span className="text-[10px] text-amber-600 dark:text-amber-400">
          Unverified - click Verify to check
        </span>
      </>
    );
  }

  return (
    <div className="flex flex-col items-start gap-1">
      {statusNode}
      <button
        type="button"
        onClick={onVerify}
        disabled={verifying}
        title="Look up the Google Workspace account (read-only - never recreates it)"
        className="inline-flex w-fit items-center gap-1 rounded-md border border-zinc-200 px-1.5 py-0.5 text-[10px] font-medium text-zinc-600 transition-colors hover:bg-zinc-50 hover:text-zinc-900 disabled:cursor-not-allowed disabled:opacity-60 dark:border-zinc-700 dark:text-zinc-300 dark:hover:bg-zinc-800 dark:hover:text-zinc-100"
      >
        {verifying ? (
          <Loader2 className="h-3 w-3 shrink-0 animate-spin" />
        ) : (
          <ShieldCheck className="h-3 w-3 shrink-0" />
        )}
        {verifying ? 'Verifying' : state === 'confirmed' ? 'Re-verify' : 'Verify'}
      </button>
    </div>
  );
}

/**
 * Result modal for the Verify button. Opens with a loading state, then shows the
 * webhook outcome translated into plain language (verified / not found / could
 * not verify) plus the raw detail. Offers the right follow-up per outcome,
 * including a manual "Mark as verified" override for when HR has confirmed the
 * account exists in Google Admin themselves (the webhook got it wrong).
 */
function VerifyResultDialog({
  dialog,
  onClose,
  onTryAgain,
  onManualConfirm,
  onRetrySetup,
}: {
  dialog: VerifyDialogState | null;
  onClose: () => void;
  onTryAgain: (row: SubmissionRow) => void;
  onManualConfirm: (row: SubmissionRow) => void;
  onRetrySetup: (row: SubmissionRow) => void;
}) {
  const open = !!dialog;
  const row = dialog?.row ?? null;
  const loading = dialog?.loading ?? false;
  const result = dialog?.result;
  const workEmail = row?.work_email ?? '';
  const state = result?.state ?? 'error';

  const tone =
    state === 'exists'
      ? {
          Icon: CheckCircle2,
          iconWrap: 'from-emerald-500 to-teal-700',
          header:
            'border-emerald-100/80 from-emerald-50 via-white to-teal-50/60 dark:border-emerald-950/40 dark:from-emerald-950/30 dark:via-zinc-950 dark:to-teal-950/20',
          title: 'Account verified',
        }
      : state === 'missing'
        ? {
            Icon: XCircle,
            iconWrap: 'from-rose-500 to-rose-700',
            header:
              'border-rose-100/80 from-rose-50 via-white to-rose-50/60 dark:border-rose-950/40 dark:from-rose-950/30 dark:via-zinc-950 dark:to-rose-950/20',
            title: 'Account not found',
          }
        : {
            Icon: AlertTriangle,
            iconWrap: 'from-amber-500 to-orange-600',
            header:
              'border-amber-100/80 from-amber-50 via-white to-orange-50/60 dark:border-amber-950/40 dark:from-amber-950/30 dark:via-zinc-950 dark:to-orange-950/20',
            title: 'Could not verify',
          };
  const ToneIcon = tone.Icon;

  const summary =
    state === 'exists'
      ? `${workEmail} exists in Google Workspace.`
      : state === 'missing'
        ? `${workEmail} was not found in Google Workspace.`
        : `We could not confirm the status of ${workEmail}.`;

  // A 404 / "not registered" means the n8n verify workflow isn't published yet -
  // call that out instead of just echoing the raw message.
  const notRegistered =
    state === 'error' &&
    (result?.httpStatus === 404 || /not registered/i.test(result?.detail ?? ''));
  const sub =
    state === 'exists'
      ? 'It is now marked as a designated work email.'
      : state === 'missing'
        ? 'It has not been provisioned yet - use Retry setup to create it, or mark it verified if you know it already exists.'
        : notRegistered
          ? 'The verify webhook is not set up in n8n yet (slug verify_workspace_account). Build it to enable automated checks - meanwhile, use Mark as verified if you have confirmed the account in Google Admin.'
          : (result?.detail ?? 'The verify webhook did not return a clear answer.');

  return (
    <Dialog open={open} onOpenChange={(o) => !o && onClose()}>
      <DialogContent className="sm:max-w-md">
        {loading ? (
          <div className="flex flex-col items-center gap-3 py-10 text-center">
            <Loader2 className="h-8 w-8 animate-spin text-emerald-500" />
            <p className="text-sm font-medium text-zinc-800 dark:text-zinc-100">
              Checking Google Workspace...
            </p>
            {workEmail && (
              <p className="break-all font-mono text-xs text-zinc-500">{workEmail}</p>
            )}
          </div>
        ) : (
          <>
            <div
              className={cn(
                '-mx-6 -mt-6 mb-4 overflow-hidden rounded-t-lg border-b bg-gradient-to-br px-6 py-5',
                tone.header,
              )}
            >
              <DialogHeader>
                <DialogTitle className="flex items-center gap-2.5 text-base font-semibold">
                  <span
                    className={cn(
                      'flex h-8 w-8 shrink-0 items-center justify-center rounded-lg bg-gradient-to-br text-white shadow-md',
                      tone.iconWrap,
                    )}
                  >
                    <ToneIcon className="h-4 w-4" />
                  </span>
                  {tone.title}
                </DialogTitle>
              </DialogHeader>
            </div>

            <div className="flex flex-col gap-2">
              <p className="text-sm text-zinc-800 dark:text-zinc-100">{summary}</p>
              <p className="text-xs leading-relaxed text-zinc-500 dark:text-zinc-400">{sub}</p>

              {(result?.detail || result?.httpStatus != null) && (
                <div className="mt-1 rounded-lg border border-zinc-200 bg-zinc-50 px-3 py-2 dark:border-zinc-800 dark:bg-zinc-900/40">
                  <p className="mb-1 text-[10px] font-semibold uppercase tracking-widest text-zinc-400">
                    Details
                  </p>
                  {result?.httpStatus != null && (
                    <p className="text-[11px] text-zinc-600 dark:text-zinc-300">
                      HTTP status: <span className="font-mono">{result.httpStatus}</span>
                    </p>
                  )}
                  {result?.detail && (
                    <p className="break-words font-mono text-[11px] text-zinc-600 dark:text-zinc-300">
                      {result.detail}
                    </p>
                  )}
                </div>
              )}
            </div>

            <DialogFooter className="mt-4 flex-wrap gap-2">
              {state === 'error' && row && (
                <Button variant="outline" size="sm" onClick={() => onTryAgain(row)}>
                  <RefreshCw className="mr-1 h-3.5 w-3.5" />
                  Try again
                </Button>
              )}
              {state === 'missing' && row && (
                <Button
                  variant="outline"
                  size="sm"
                  className="border-rose-300 text-rose-700 hover:bg-rose-50 dark:border-rose-800 dark:text-rose-300 dark:hover:bg-rose-950/30"
                  onClick={() => onRetrySetup(row)}
                >
                  <RefreshCw className="mr-1 h-3.5 w-3.5" />
                  Retry setup
                </Button>
              )}
              {state !== 'exists' && row && (
                <Button
                  variant="outline"
                  size="sm"
                  className="border-emerald-300 text-emerald-700 hover:bg-emerald-50 dark:border-emerald-800 dark:text-emerald-300 dark:hover:bg-emerald-950/30"
                  onClick={() => onManualConfirm(row)}
                  title="I checked Google Admin myself - this account exists"
                >
                  <CheckCircle2 className="mr-1 h-3.5 w-3.5" />
                  Mark as verified
                </Button>
              )}
              <Button size="sm" onClick={onClose}>
                {state === 'exists' ? 'Done' : 'Close'}
              </Button>
            </DialogFooter>
          </>
        )}
      </DialogContent>
    </Dialog>
  );
}

/**
 * Bulk verify modal — shows live progress while the selected accounts are looked
 * up (read-only), then a per-row results list with a confirmed / not-found /
 * unchecked breakdown. Never recreates anything.
 */
function BulkVerifyDialog({
  state,
  onClose,
}: {
  state: BulkVerifyState | null;
  onClose: () => void;
}) {
  const open = !!state;
  const running = state?.running ?? false;
  const total = state?.total ?? 0;
  const doneCount = state?.done ?? 0;
  const results = state?.results ?? [];

  const [query, setQuery] = useState('');
  // Clear the filter when the modal closes so the next run starts fresh.
  useEffect(() => {
    if (!open) setQuery('');
  }, [open]);

  // Totals (for the summary) vs filtered (for the columns).
  const exists = results.filter((r) => r.state === 'exists').length;
  const missing = results.filter((r) => r.state === 'missing').length;
  const errored = results.filter((r) => r.state === 'error').length;

  const q = query.trim().toLowerCase();
  const matchesQuery = (r: BulkVerifyResult) =>
    !q || r.name.toLowerCase().includes(q) || r.email.toLowerCase().includes(q);
  const verified = results.filter((r) => r.state === 'exists' && matchesQuery(r));
  const unverified = results.filter((r) => r.state !== 'exists' && matchesQuery(r));

  return (
    <Dialog open={open} onOpenChange={(o) => !o && !running && onClose()}>
      <DialogContent className="max-h-[90vh] overflow-y-auto sm:max-w-lg">
        <div className="-mx-4 -mt-4 mb-3 overflow-hidden rounded-t-xl border-b border-sky-100/80 bg-gradient-to-br from-sky-50 via-white to-indigo-50/60 px-4 py-3 dark:border-sky-950/40 dark:from-sky-950/30 dark:via-zinc-950 dark:to-indigo-950/20">
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2 text-sm font-semibold">
              <span className="flex h-7 w-7 shrink-0 items-center justify-center rounded-lg bg-gradient-to-br from-sky-500 to-indigo-700 text-white shadow-sm shadow-sky-600/25">
                <ShieldCheck className="h-3.5 w-3.5" />
              </span>
              {running ? 'Verifying accounts' : 'Verify complete'}
            </DialogTitle>
            <p className="mt-0.5 text-[11px] text-zinc-500 dark:text-zinc-400">
              {running ? (
                `Looking up ${doneCount} of ${total} in Google Workspace...`
              ) : (
                <>
                  <span className="font-semibold text-emerald-700 dark:text-emerald-400">{exists} confirmed</span>
                  {missing > 0 && <>, <span className="font-semibold text-amber-600 dark:text-amber-400">{missing} not found</span></>}
                  {errored > 0 && <>, <span className="font-semibold text-rose-600 dark:text-rose-400">{errored} unchecked</span></>}
                </>
              )}
            </p>
          </DialogHeader>
        </div>

        {running && (
          <div className="mb-4 h-1.5 w-full overflow-hidden rounded-full bg-zinc-100 dark:bg-zinc-800">
            <div
              className="h-full rounded-full bg-gradient-to-r from-sky-500 to-indigo-600 transition-all"
              style={{ width: `${total > 0 ? Math.round((doneCount / total) * 100) : 0}%` }}
            />
          </div>
        )}

        {results.length > 0 && (
          <div className="relative mb-3">
            <Search className="pointer-events-none absolute left-3 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-zinc-400" />
            <Input
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              placeholder="Search name or email..."
              className="h-8 pl-9 text-xs"
            />
          </div>
        )}

        {results.length > 0 && (
          <div className="grid gap-3 sm:grid-cols-2">
            {/* Left: verified */}
            <div className="flex max-h-[55vh] flex-col overflow-hidden rounded-xl border border-emerald-200/80 dark:border-emerald-900/40">
              <div className="flex shrink-0 items-center gap-1.5 border-b border-emerald-200/80 bg-emerald-50/70 px-3 py-1.5 text-[10px] font-semibold uppercase tracking-widest text-emerald-700 dark:border-emerald-900/40 dark:bg-emerald-950/30 dark:text-emerald-400">
                <CheckCircle2 className="h-3 w-3" />
                Verified ({verified.length})
              </div>
              <div className="overflow-y-auto">
                {verified.length === 0 ? (
                  <p className="px-3 py-4 text-center text-[11px] text-zinc-400">{q ? 'No matches' : 'None yet'}</p>
                ) : (
                  verified.map((r) => (
                    <div key={r.id} className="border-b border-zinc-100 px-3 py-2 text-xs last:border-b-0 dark:border-zinc-800/70">
                      <p className="truncate font-medium text-zinc-800 dark:text-zinc-200">{r.name}</p>
                      <p className="truncate font-mono text-[10.5px] text-zinc-500">{r.email}</p>
                    </div>
                  ))
                )}
              </div>
            </div>

            {/* Right: unverified (not found + unchecked) */}
            <div className="flex max-h-[55vh] flex-col overflow-hidden rounded-xl border border-amber-200/80 dark:border-amber-900/40">
              <div className="flex shrink-0 items-center gap-1.5 border-b border-amber-200/80 bg-amber-50/70 px-3 py-1.5 text-[10px] font-semibold uppercase tracking-widest text-amber-700 dark:border-amber-900/40 dark:bg-amber-950/30 dark:text-amber-400">
                <XCircle className="h-3 w-3" />
                Unverified ({unverified.length})
              </div>
              <div className="overflow-y-auto">
                {unverified.length === 0 ? (
                  <p className="px-3 py-4 text-center text-[11px] text-zinc-400">{q ? 'No matches' : 'None'}</p>
                ) : (
                  unverified.map((r) => (
                    <div key={r.id} className="flex items-start gap-2 border-b border-zinc-100 px-3 py-2 text-xs last:border-b-0 dark:border-zinc-800/70">
                      <div className="min-w-0 flex-1">
                        <p className="truncate font-medium text-zinc-800 dark:text-zinc-200">{r.name}</p>
                        <p className="truncate font-mono text-[10.5px] text-zinc-500">{r.email}</p>
                      </div>
                      <span
                        className={cn(
                          'shrink-0 text-[10px] font-medium',
                          r.state === 'missing'
                            ? 'text-amber-600 dark:text-amber-400'
                            : 'text-rose-600 dark:text-rose-400',
                        )}
                      >
                        {r.state === 'missing' ? 'Not found' : 'Unchecked'}
                      </span>
                    </div>
                  ))
                )}
              </div>
            </div>
          </div>
        )}

        {!running && missing > 0 && (
          <p className="mt-3 text-[11px] text-amber-600 dark:text-amber-400">
            The "not found" accounts haven't been provisioned - use Retry setup on those rows.
          </p>
        )}

        <DialogFooter className="mt-4">
          <Button size="sm" onClick={onClose} disabled={running}>
            {running ? (
              <>
                <Loader2 className="mr-1 h-3.5 w-3.5 animate-spin" />
                Verifying...
              </>
            ) : (
              'Done'
            )}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

const STATUS_BADGE: Record<HrOnboardingStatus, string> = {
  pending:
    'border-amber-300 bg-amber-50 text-amber-900 dark:border-amber-700 dark:bg-amber-950/35 dark:text-amber-100',
  submitted:
    'border-emerald-300 bg-emerald-50 text-emerald-900 dark:border-emerald-700 dark:bg-emerald-950/40 dark:text-emerald-100',
  archived:
    'border-zinc-300 bg-zinc-100 text-zinc-700 dark:border-zinc-700 dark:bg-zinc-900 dark:text-zinc-400',
};

const STATUS_LABEL: Record<HrOnboardingStatus, string> = {
  pending: 'Awaiting submission',
  submitted: 'Submitted',
  archived: 'Archived',
};

/** Status pill label + classes. An archived submission whose linked hire was
 *  promoted to the master list reads "Archived/Complete" (sky) instead of a
 *  plain grey "Archived". */
function submissionStatusPill(r: SubmissionRow): { label: string; className: string } {
  if (r.status === 'archived' && r.pending_status === 'promoted') {
    return {
      label: 'Archived/Complete',
      className:
        'border-sky-300 bg-sky-50 text-sky-900 dark:border-sky-700 dark:bg-sky-950/40 dark:text-sky-100',
    };
  }
  return { label: STATUS_LABEL[r.status], className: STATUS_BADGE[r.status] };
}

function fmtDate(iso: string | null): string {
  if (!iso) return '—';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  return d.toLocaleDateString(undefined, { year: 'numeric', month: 'short', day: 'numeric' });
}

function fmtDateTime(iso: string | null): string {
  if (!iso) return '—';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  return d.toLocaleString(undefined, {
    year: 'numeric',
    month: 'short',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  });
}

function publicLinkFor(token: string): string {
  if (typeof window === 'undefined') return `/onboarding/${token}`;
  return `${window.location.origin}/onboarding/${token}`;
}

/**
 * Neon-green treatment for the primary "Generate link" CTA.
 *   • Standby: a soft neon pulse roughly once every 10s, hinting "press me".
 *   • Hover:   a running neon-green border + glow (idle pulse pauses).
 * Honors prefers-reduced-motion (static border on hover, no pulse/spin).
 */
const GEN_NEON_CSS = `
@property --gen-angle { syntax: "<angle>"; inherits: false; initial-value: 0deg; }
@keyframes gen-neon-spin { to { --gen-angle: 360deg; } }
@keyframes gen-neon-idle {
  0%, 84%, 100% { box-shadow: 0 4px 14px rgba(16,185,129,0.25); }
  90%, 95%      { box-shadow: 0 0 18px 2px rgba(57,255,20,0.85), 0 0 5px rgba(57,255,20,0.9); }
}
.gen-neon { position: relative; display: inline-flex; border-radius: 0.55rem; }
/* Only the 2px BORDER is painted — the conic fills the box but a content-box
   mask punches out the center, so there is no rotating "radar" sweep behind the
   button, just a glowing segment running along the edge. */
.gen-neon__run {
  --gen-angle: 0deg;
  position: absolute; inset: -2px; border-radius: 0.55rem; padding: 2px;
  background: conic-gradient(from var(--gen-angle),
    transparent 0deg, transparent 250deg,
    #34d399 300deg, #39ff14 338deg, #d9ffcf 354deg, transparent 360deg);
  -webkit-mask: linear-gradient(#000 0 0) content-box, linear-gradient(#000 0 0);
          mask: linear-gradient(#000 0 0) content-box, linear-gradient(#000 0 0);
  -webkit-mask-composite: xor;
          mask-composite: exclude;
  opacity: 0; transition: opacity .25s ease; pointer-events: none;
}
.gen-neon:hover .gen-neon__run { opacity: 1; animation: gen-neon-spin 1.4s linear infinite; }
.gen-neon__btn { position: relative; animation: gen-neon-idle 10s ease-in-out infinite; }
.gen-neon:hover .gen-neon__btn { animation: none; box-shadow: 0 0 16px 1px rgba(57,255,20,0.5); }
@media (prefers-reduced-motion: reduce) {
  .gen-neon__btn { animation: none; }
  .gen-neon:hover .gen-neon__run { animation: none; }
}
`;

// Export dropdown for the onboarding submissions in view (PDF / CSV / XLSX).
// Visually mirrors the Payment Catalog / Accounting export menu: an outline
// trigger with the orange (light) / blue (dark) accent, and an animated panel
// with one styled row per format. Acts on whatever rows are currently in view
// (respects the active status filter, search and the "needs setup" toggles).
const EXPORT_EASE = [0.22, 1, 0.36, 1] as const;

function OnboardingExportMenu({
  rows,
  scopeLabel,
  disabled,
}: {
  rows: readonly OnboardingExportInput[];
  scopeLabel: string;
  disabled?: boolean;
}) {
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState<null | 'csv' | 'xlsx' | 'pdf'>(null);
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    const onDocClick = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setOpen(false);
    };
    document.addEventListener('mousedown', onDocClick);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('mousedown', onDocClick);
      document.removeEventListener('keydown', onKey);
    };
  }, [open]);

  const buildModel = useCallback(
    () => buildOnboardingExport({ rows, scopeLabel }),
    [rows, scopeLabel],
  );

  const noRows = rows.length === 0;

  const onCsv = () => {
    try {
      downloadOnboardingCsv(buildModel());
      toast.success('New hires exported to CSV');
    } catch {
      toast.error('Could not export CSV');
    } finally {
      setOpen(false);
    }
  };

  const onXlsx = () => {
    try {
      downloadOnboardingXlsx(buildModel());
      toast.success('New hires exported to Excel');
    } catch {
      toast.error('Could not export Excel file');
    } finally {
      setOpen(false);
    }
  };

  const onPdf = async () => {
    setBusy('pdf');
    try {
      await downloadOnboardingPdf(buildModel());
      toast.success('New hires exported to PDF');
      setOpen(false);
    } catch {
      toast.error('Could not generate PDF');
    } finally {
      setBusy(null);
    }
  };

  return (
    <div ref={ref} className="relative shrink-0">
      <Button
        type="button"
        size="sm"
        variant="outline"
        disabled={disabled || busy !== null}
        onClick={() => setOpen((o) => !o)}
        className="gap-1.5 border-orange-200 text-orange-700 hover:bg-orange-50 dark:border-blue-900/60 dark:text-blue-300 dark:hover:bg-blue-950/40"
      >
        {busy ? <Loader2 className="h-4 w-4 animate-spin" /> : <Download className="h-4 w-4" />}
        Export
        <motion.span animate={{ rotate: open ? 180 : 0 }} transition={{ duration: 0.2, ease: EXPORT_EASE }}>
          <ChevronDownIcon className="h-3.5 w-3.5" />
        </motion.span>
      </Button>

      <AnimatePresence>
        {open && (
          <motion.div
            initial={{ opacity: 0, y: -6, scale: 0.98 }}
            animate={{ opacity: 1, y: 0, scale: 1 }}
            exit={{ opacity: 0, y: -6, scale: 0.98 }}
            transition={{ duration: 0.16, ease: EXPORT_EASE }}
            className="absolute right-0 z-40 mt-1 w-64 origin-top-right overflow-hidden rounded-lg border border-zinc-200 bg-white shadow-xl dark:border-zinc-700 dark:bg-zinc-900"
          >
            <div className="border-b border-zinc-100 px-3 py-2 dark:border-zinc-800">
              <p className="text-[11px] font-semibold uppercase tracking-wide text-zinc-500 dark:text-zinc-400">
                Export new hires
              </p>
              <p className="mt-0.5 text-[10.5px] text-zinc-400">
                {noRows
                  ? 'No hires in this view.'
                  : `${rows.length} hire${rows.length === 1 ? '' : 's'} in view · ${scopeLabel}`}
              </p>
            </div>
            <button
              type="button"
              onClick={onPdf}
              disabled={busy !== null || noRows}
              className="flex w-full items-start gap-2.5 px-3 py-2.5 text-left transition-colors hover:bg-orange-50 disabled:opacity-50 dark:hover:bg-blue-950/30"
            >
              {busy === 'pdf' ? (
                <Loader2 className="mt-0.5 h-4 w-4 shrink-0 animate-spin text-orange-500" />
              ) : (
                <FileText className="mt-0.5 h-4 w-4 shrink-0 text-rose-500" />
              )}
              <span>
                <span className="block text-sm font-medium text-zinc-800 dark:text-zinc-100">PDF report</span>
                <span className="block text-[11px] text-zinc-500 dark:text-zinc-400">Branded, sectioned, print-ready.</span>
              </span>
            </button>
            <button
              type="button"
              onClick={onCsv}
              disabled={busy !== null || noRows}
              className="flex w-full items-start gap-2.5 px-3 py-2.5 text-left transition-colors hover:bg-orange-50 disabled:opacity-50 dark:hover:bg-blue-950/30"
            >
              <FileSpreadsheet className="mt-0.5 h-4 w-4 shrink-0 text-emerald-600 dark:text-emerald-400" />
              <span>
                <span className="block text-sm font-medium text-zinc-800 dark:text-zinc-100">CSV spreadsheet</span>
                <span className="block text-[11px] text-zinc-500 dark:text-zinc-400">One flat table for Excel / Sheets.</span>
              </span>
            </button>
            <button
              type="button"
              onClick={onXlsx}
              disabled={busy !== null || noRows}
              className="flex w-full items-start gap-2.5 px-3 py-2.5 text-left transition-colors hover:bg-orange-50 disabled:opacity-50 dark:hover:bg-blue-950/30"
            >
              <Sheet className="mt-0.5 h-4 w-4 shrink-0 text-green-600 dark:text-green-400" />
              <span>
                <span className="block text-sm font-medium text-zinc-800 dark:text-zinc-100">Excel workbook</span>
                <span className="block text-[11px] text-zinc-500 dark:text-zinc-400">Native .xlsx with sized columns.</span>
              </span>
            </button>
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  );
}

export default function HrOnboardingForm({
  openSubmission,
}: {
  /** When set (from a notification click), open this submission's drawer. The
   *  `nonce` refires the effect if the same id is requested again. */
  openSubmission?: { id: string; nonce: number } | null;
} = {}) {
  const reduceMotion = useReducedMotion();
  const [rows, setRows] = useState<SubmissionRow[]>(
    () =>
      withTitleCasedNames(
        getHrTabCache<SubmissionRow[]>(HR_TAB_CACHE_KEYS.onboardingSubmissions) ?? [],
      ),
  );
  const [loading, setLoading] = useState(
    () => !hasHrTabCache(HR_TAB_CACHE_KEYS.onboardingSubmissions),
  );
  const [filter, setFilter] = useState<StatusFilter>('all');
  const [search, setSearch] = useState('');
  // Submitted tab only: when on, hide rows whose work email is already set so HR
  // can focus on the hires that still need an @simple.biz address minted.
  const [hideEmailSet, setHideEmailSet] = useState(false);
  // Submitted tab only: when on, show only hires whose account creation failed.
  const [showFailedOnly, setShowFailedOnly] = useState(false);

  const [generateOpen, setGenerateOpen] = useState(false);
  const [bypassOpen, setBypassOpen] = useState(false);
  const [payPlansOpen, setPayPlansOpen] = useState(false);
  const [linkCreated, setLinkCreated] = useState<SubmissionRow | null>(null);
  const [viewRow, setViewRow] = useState<SubmissionRow | null>(null);
  const [workEmailFor, setWorkEmailFor] = useState<SubmissionRow | null>(null);
  const [archiveTarget, setArchiveTarget] = useState<SubmissionRow | null>(null);
  const [deleteTarget, setDeleteTarget] = useState<SubmissionRow | null>(null);
  const [busyId, setBusyId] = useState<string | null>(null);
  // Verify modal — opens on "Verify", shows a loading state, then the translated
  // webhook outcome (exists / not found / could not verify). Also drives the
  // cell button's spinner.
  const [verifyDialog, setVerifyDialog] = useState<VerifyDialogState | null>(null);

  // Multi-select for bulk actions. Selection is scoped to the rows currently
  // visible under the active filter + search; an effect prunes it whenever the
  // visible set changes so we never act on a hidden row.
  const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set());
  const [bulkAction, setBulkAction] = useState<{
    type: 'archive' | 'delete' | 'send';
    rows: SubmissionRow[];
  } | null>(null);
  const [bulkBusy, setBulkBusy] = useState(false);
  // Bulk set-work-email: the submitted hires handed to the grouped modal.
  const [bulkWorkEmail, setBulkWorkEmail] = useState<SubmissionRow[] | null>(null);
  // Bulk verify: drives a progress + results modal for multi-selected rows.
  const [bulkVerify, setBulkVerify] = useState<BulkVerifyState | null>(null);
  // License info display
  const [licenseInfo, setLicenseInfo] = useState<{
    available_licenses: number | null;
    total_licenses: number | null;
    last_updated: string | null;
    note?: string;
    error?: string;
  } | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const res = await fetch('/api/hr/onboarding-submissions', { cache: 'no-store' });
      const json = (await res.json()) as { rows?: SubmissionRow[]; error?: string };
      if (!res.ok || json.error) throw new Error(json.error ?? 'Failed to load');
      const normalized = withTitleCasedNames(json.rows ?? []);
      setRows(normalized);
      setHrTabCache(HR_TAB_CACHE_KEYS.onboardingSubmissions, normalized);
    } catch (e) {
      toast.error(e instanceof Error ? e.message : 'Failed to load submissions');
      setRows([]);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    // Skip the initial fetch when cached (tab revisit) so the table doesn't
    // re-query / reload; mutations + the Refresh button keep the cache current.
    if (hasHrTabCache(HR_TAB_CACHE_KEYS.onboardingSubmissions)) return;
    void load();
  }, [load]);

  // A notification click (via HrOnboarding) asked to open a specific submission.
  // Prefer the already-loaded list row so the drawer's summary renders instantly;
  // otherwise open with a minimal row (the detail dialog fetches the full record
  // on open) and refresh the list so the rest of the table catches up. Keyed on
  // `nonce` so it fires once per click, not on every rows refresh.
  useEffect(() => {
    if (!openSubmission) return;
    const found = rows.find((r) => r.id === openSubmission.id);
    if (found) {
      setViewRow(found);
    } else {
      setViewRow({ id: openSubmission.id } as SubmissionRow);
      void load();
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [openSubmission?.nonce]);

  // Re-pull the license meter — on mount and after a set consumes seats, so the
  // "available" count reflects newly-provisioned accounts.
  const refreshLicenseInfo = useCallback(() => {
    fetch('/api/hr/workspace-license-info', { cache: 'no-store' })
      .then((r) => r.json())
      .then((j) => setLicenseInfo(j))
      .catch(() => setLicenseInfo({ available_licenses: null, total_licenses: null, last_updated: null, error: 'Could not fetch license info' }));
  }, []);

  useEffect(() => {
    refreshLicenseInfo();
  }, [refreshLicenseInfo]);

  const counts = useMemo(() => {
    const c = { pending: 0, submitted: 0, archived: 0 };
    for (const r of rows) c[r.status] += 1;
    return c;
  }, [rows]);

  const filtered = useMemo(() => {
    const q = search.trim().toLowerCase();
    const result = rows.filter((r) => {
      if (filter !== 'all' && r.status !== filter) return false;
      // "Needs setup" toggle — scoped to the Submitted tab so switching away
      // from it doesn't silently hide rows elsewhere. A row still needs setup
      // when it has no work email yet OR its workspace automation failed — a
      // minted-but-failed address must not be mistaken for a finished one.
      if (filter === 'submitted' && hideEmailSet && !needsWorkEmailSetup(r)) return false;
      // "Account Creation Failed" toggle — show only minted addresses whose
      // workspace account creation failed (a definite failure, not just unset).
      if (filter === 'submitted' && showFailedOnly && workEmailState(r) !== 'failed') return false;
      if (!q) return true;
      return [r.invite_name, r.invite_personal_email, r.invite_department, r.full_name, r.email]
        .filter(Boolean)
        .some((s) => s!.toLowerCase().includes(q));
    });
    if (filter === 'submitted') {
      result.sort((a, b) => {
        const ta = a.submitted_at ? new Date(a.submitted_at).getTime() : 0;
        const tb = b.submitted_at ? new Date(b.submitted_at).getTime() : 0;
        return tb - ta;
      });
    }
    return result;
  }, [rows, filter, search, hideEmailSet, showFailedOnly]);

  // How many submitted hires still need setup — no work email yet, OR a minted
  // address whose account creation failed. Shown on the toggle and used to
  // decide whether the toggle is worth rendering at all.
  const submittedNeedingEmail = useMemo(
    () => rows.filter((r) => r.status === 'submitted' && needsWorkEmailSetup(r)).length,
    [rows],
  );
  // How many submitted hires had their account creation fail (definite failure).
  const submittedFailed = useMemo(
    () => rows.filter((r) => r.status === 'submitted' && workEmailState(r) === 'failed').length,
    [rows],
  );

  const PAGE_SIZE = 20;
  const [page, setPage] = useState(0);
  useEffect(() => { setPage(0); }, [filter, search]);
  const totalPages = Math.max(1, Math.ceil(filtered.length / PAGE_SIZE));
  const safePage = Math.min(page, totalPages - 1);
  const pageRows = filtered.slice(safePage * PAGE_SIZE, (safePage + 1) * PAGE_SIZE);

  // Keep ticks across search/filter changes so HR can curate a selection by
  // searching one name at a time (add) and unticking (remove). We only drop ids
  // for rows that no longer EXIST at all (deleted/reloaded away) — a row merely
  // hidden by the current search or status tab stays selected.
  useEffect(() => {
    setSelectedIds((prev) => {
      if (prev.size === 0) return prev;
      const live = new Set(rows.map((r) => r.id));
      const next = new Set<string>();
      for (const id of prev) if (live.has(id)) next.add(id);
      return next.size === prev.size ? prev : next;
    });
  }, [rows]);

  // The curated selection spans ALL loaded rows, not just the visible ones, so
  // bulk actions act on everything ticked even after the search box is cleared
  // or changed.
  const selectedRows = useMemo(
    () => rows.filter((r) => selectedIds.has(r.id)),
    [rows, selectedIds],
  );
  // Header checkbox reflects only the currently-visible (filtered) rows.
  const visibleSelectedCount = useMemo(
    () => filtered.reduce((n, r) => n + (selectedIds.has(r.id) ? 1 : 0), 0),
    [filtered, selectedIds],
  );
  const allVisibleSelected = filtered.length > 0 && visibleSelectedCount === filtered.length;
  const someVisibleSelected = visibleSelectedCount > 0 && !allVisibleSelected;
  // How many ticked rows are currently hidden by the search/filter — surfaced in
  // the bulk bar so HR knows the action will include them.
  const hiddenSelectedCount = selectedRows.length - visibleSelectedCount;
  const selSendable = selectedRows.filter((r) => r.status === 'pending');
  const selArchivable = selectedRows.filter((r) => r.status !== 'archived');
  const selDeletable = selectedRows.filter((r) => r.status === 'archived');
  // Only hires who have actually submitted their paperwork can be assigned a
  // work email. The button shows this count; clicking it drops any non-submitted
  // rows from the selection so we never carry them into the modal.
  const selWorkEmailable = selectedRows.filter((r) => r.status === 'submitted');
  // Any selected row that has a minted address can be verified (read-only).
  // The bulk "Verify" button is only offered when NONE of the selected rows are
  // work-emailable (i.e. nothing to set) — so in the normal Submitted-tab flow
  // HR sees a single, unambiguous "Set work email" primary action and never
  // mixes it up with Verify. Per-row Verify still lives in the column.
  const selVerifiable = selectedRows.filter((r) => !!r.work_email);
  const showBulkVerify = selVerifiable.length > 0 && selWorkEmailable.length === 0;

  function openBulkWorkEmail() {
    const eligible = selectedRows.filter((r) => r.status === 'submitted');
    if (eligible.length === 0) {
      toast.info('Only submitted hires can be assigned a work email.');
      return;
    }
    const removed = selectedRows.length - eligible.length;
    if (removed > 0) {
      // Deselect the not-yet-submitted rows so the selection reflects exactly
      // what the modal will act on.
      setSelectedIds(new Set(eligible.map((r) => r.id)));
      toast.info(
        `${removed} not-yet-submitted ${removed === 1 ? 'hire' : 'hires'} deselected - only submitted hires can be assigned a work email.`,
      );
    }
    setBulkWorkEmail(eligible);
  }

  function toggleAllVisible() {
    setSelectedIds((prev) => {
      const next = new Set(prev);
      if (filtered.every((r) => next.has(r.id))) {
        for (const r of filtered) next.delete(r.id);
      } else {
        for (const r of filtered) next.add(r.id);
      }
      return next;
    });
  }

  function toggleOne(id: string) {
    setSelectedIds((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }

  async function resendLink(r: SubmissionRow) {
    const recipient = r.invite_personal_email ?? r.email;
    if (!recipient) {
      toast.error('No email address on file — cannot resend.');
      return;
    }
    setBusyId(r.id);
    try {
      const res = await fetch(`/api/hr/onboarding-submissions/${r.id}/send`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({}),
      });
      const json = (await res.json()) as { error?: string };
      if (!res.ok || json.error) throw new Error(json.error ?? 'Failed to resend');
      toast.success(`Link resent to ${recipient}`);
    } catch (e) {
      toast.error(e instanceof Error ? e.message : 'Failed to resend');
    } finally {
      setBusyId(null);
    }
  }

  // Read-only verify — looks up the live Google Workspace account WITHOUT
  // recreating it, opens the result modal, then refreshes the row so the
  // Designated Work Email column reflects the real state.
  async function verifyWorkEmail(r: SubmissionRow) {
    if (!r.work_email) return;
    setVerifyDialog({ row: r, loading: true });
    try {
      const res = await fetch(`/api/hr/onboarding-submissions/${r.id}/verify-work-email`, {
        method: 'POST',
      });
      const json = (await res.json().catch(() => ({}))) as {
        state?: 'exists' | 'missing' | 'error';
        http_status?: number | null;
        detail?: string | null;
        error?: string;
      };
      const state = json.state ?? 'error';
      const detail =
        json.detail ?? json.error ?? (res.ok ? null : `Request failed (${res.status})`);
      setVerifyDialog({
        row: r,
        loading: false,
        result: { state, httpStatus: json.http_status ?? null, detail: detail ?? null },
      });
      if (res.ok) await load();
    } catch (e) {
      setVerifyDialog({
        row: r,
        loading: false,
        result: {
          state: 'error',
          httpStatus: null,
          detail: e instanceof Error ? e.message : 'Verify failed',
        },
      });
    }
  }

  // Manual override — HR checked Google Admin themselves and sets the truth the
  // webhook got wrong (e.g. a "create failed" that actually means the account
  // already exists). No webhook call; just stamps the stored status.
  async function markWorkspace(r: SubmissionRow, ok: boolean) {
    setVerifyDialog((p) => (p ? { ...p, loading: true } : p));
    try {
      const res = await fetch(`/api/hr/onboarding-submissions/${r.id}/workspace-status`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ ok }),
      });
      const json = (await res.json().catch(() => ({}))) as { error?: string };
      if (!res.ok) throw new Error(json.error ?? 'Failed to update status');
      setVerifyDialog({
        row: r,
        loading: false,
        result: {
          state: ok ? 'exists' : 'missing',
          httpStatus: null,
          detail: ok
            ? 'Manually marked as verified by HR.'
            : 'Manually marked as not provisioned by HR.',
        },
      });
      await load();
    } catch (e) {
      toast.error(e instanceof Error ? e.message : 'Failed to update status');
      setVerifyDialog((p) => (p ? { ...p, loading: false } : p));
    }
  }

  // Bulk verify the multi-selected rows (read-only lookups, 5 at a time). Opens
  // a progress + results modal and refreshes the table when done.
  async function runBulkVerify(targets: SubmissionRow[]) {
    const list = targets.filter((r) => !!r.work_email);
    if (list.length === 0) {
      toast.info('Select rows that have a work email to verify.');
      return;
    }
    setBulkVerify({ total: list.length, done: 0, running: true, results: [] });
    const results: BulkVerifyResult[] = [];
    let done = 0;
    await runPooled(list, 5, async (r) => {
      let state: 'exists' | 'missing' | 'error' = 'error';
      try {
        const res = await fetch(`/api/hr/onboarding-submissions/${r.id}/verify-work-email`, {
          method: 'POST',
        });
        const j = (await res.json().catch(() => ({}))) as { state?: 'exists' | 'missing' | 'error' };
        state = res.ok ? (j.state ?? 'error') : 'error';
      } catch {
        state = 'error';
      }
      results.push({
        id: r.id,
        name: r.full_name?.trim() || r.invite_name?.trim() || '(no name)',
        email: r.work_email ?? '',
        state,
      });
      done += 1;
      // Update progress + the per-row list live as each lookup lands.
      setBulkVerify((p) => (p ? { ...p, done, results: [...results] } : p));
    });
    setBulkVerify((p) => (p ? { ...p, running: false, results } : p));
    setSelectedIds(new Set());
    await load();
  }

  async function runBulkAction() {
    if (!bulkAction) return;
    const { type, rows: targets } = bulkAction;
    setBulkBusy(true);
    try {
      // 5 concurrent max — resend hits the n8n webhook; uncapped bursts saturate it.
      const results = await runPooled(targets, 5, async (r) => {
        let res: Response;
        if (type === 'archive') {
          res = await fetch(`/api/hr/onboarding-submissions/${r.id}`, { method: 'DELETE' });
        } else if (type === 'delete') {
          res = await fetch(`/api/hr/onboarding-submissions/${r.id}?hard=true`, {
            method: 'DELETE',
          });
        } else {
          res = await fetch(`/api/hr/onboarding-submissions/${r.id}/send`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({}),
          });
        }
        const json = (await res.json().catch(() => ({}))) as { error?: string };
        if (!res.ok || json.error) throw new Error(json.error ?? 'Request failed');
      });
      const ok = results.filter((r) => r.status === 'fulfilled').length;
      const failed = results.length - ok;
      const verb = type === 'archive' ? 'archived' : type === 'delete' ? 'deleted' : 'sent';
      if (ok > 0) toast.success(`${ok} submission${ok === 1 ? '' : 's'} ${verb}`);
      if (failed > 0) toast.error(`${failed} failed — check and retry`);
      setSelectedIds(new Set());
      await load();
    } finally {
      setBulkBusy(false);
      setBulkAction(null);
    }
  }

  async function archive(row: SubmissionRow) {
    setBusyId(row.id);
    try {
      const res = await fetch(`/api/hr/onboarding-submissions/${row.id}`, { method: 'DELETE' });
      const json = (await res.json()) as { error?: string };
      if (!res.ok || json.error) throw new Error(json.error ?? 'Failed to archive');
      toast.success('Submission archived');
      await load();
    } catch (e) {
      toast.error(e instanceof Error ? e.message : 'Failed to archive');
    } finally {
      setBusyId(null);
      setArchiveTarget(null);
    }
  }

  async function hardDelete(row: SubmissionRow) {
    setBusyId(row.id);
    try {
      const res = await fetch(`/api/hr/onboarding-submissions/${row.id}?hard=true`, {
        method: 'DELETE',
      });
      const json = (await res.json()) as { error?: string };
      if (!res.ok || json.error) throw new Error(json.error ?? 'Failed to delete');
      toast.success('Submission deleted permanently');
      await load();
    } catch (e) {
      toast.error(e instanceof Error ? e.message : 'Failed to delete');
    } finally {
      setBusyId(null);
      setDeleteTarget(null);
    }
  }

  return (
    <div className="flex flex-col gap-5">
      {/* Hero strip */}
      <div className="rounded-2xl border border-emerald-100/80 bg-gradient-to-br from-emerald-50/80 via-white to-teal-50/60 p-5 dark:border-emerald-950/40 dark:from-emerald-950/20 dark:via-zinc-950 dark:to-teal-950/15">
        <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
          <div>
            <div className="flex items-center gap-2 text-[10px] font-semibold uppercase tracking-[0.2em] text-emerald-700/80">
              <Sparkles className="h-3 w-3" />
              Self-serve onboarding
            </div>
            <h2 className="mt-1 text-lg font-semibold text-zinc-900 dark:text-zinc-50">
              Send new hires a shareable form — no SSO required.
            </h2>
            <p className="mt-1 max-w-2xl text-xs leading-relaxed text-zinc-600 dark:text-zinc-400">
              Generate a unique link and email it to the new hire. They complete the 6-step
              form (personal info, agreements, W-8BEN upload, payment method, contract) and
              the submission lands here for you to review.
            </p>
          </div>
          <div className="flex shrink-0 items-center gap-2">
            <style>{GEN_NEON_CSS}</style>
            <span className="gen-neon">
              <span aria-hidden className="gen-neon__run" />
              <Button
                className="gen-neon__btn bg-gradient-to-r from-emerald-500 to-teal-700 text-white shadow-md shadow-emerald-600/25"
                onClick={() => setGenerateOpen(true)}
              >
                <Plus className="mr-1.5 h-4 w-4" />
                Generate link
              </Button>
            </span>
            <Button
              variant="outline"
              className="border-violet-200 text-violet-800 hover:bg-violet-50 dark:border-violet-900/50 dark:text-violet-300 dark:hover:bg-violet-950/30"
              onClick={() => setBypassOpen(true)}
              title="Manual setup for a worker who already has a Workspace account — verify it, then promote straight to the master list (no account created)."
            >
              <ShieldCheck className="mr-1.5 h-4 w-4" />
              Bypass
            </Button>
            <Button
              variant="outline"
              className="border-emerald-200 text-emerald-800"
              onClick={() => setPayPlansOpen(true)}
            >
              <Banknote className="mr-1.5 h-4 w-4" />
              Pay Plans
            </Button>
            <Button
              variant="outline"
              className="border-emerald-200 text-emerald-800"
              onClick={() => void load()}
              disabled={loading}
            >
              <RefreshCw className={cn('mr-1.5 h-3.5 w-3.5', loading && 'animate-spin')} />
              Refresh
            </Button>
          </div>
        </div>

        <div className="mt-4 flex flex-col gap-3 sm:flex-row sm:items-stretch">
        {licenseInfo && (
          <div className={'flex-1 rounded-lg border px-3 py-2.5 text-xs ' + (licenseInfo.available_licenses === null ? 'border-amber-200/60 bg-amber-50/60 dark:border-amber-900/40 dark:bg-amber-950/20' : licenseInfo.available_licenses === 0 ? 'border-red-200/60 bg-red-50/60 dark:border-red-900/40 dark:bg-red-950/20' : licenseInfo.available_licenses <= 2 ? 'border-orange-200/60 bg-orange-50/60 dark:border-orange-900/40 dark:bg-orange-950/20' : 'border-emerald-200/60 bg-emerald-50/60 dark:border-emerald-900/40 dark:bg-emerald-950/20')}>
            <div className="mb-2 flex items-center gap-1.5 font-medium">
              {licenseInfo.available_licenses === null && <AlertTriangle className="h-3.5 w-3.5 text-amber-600 dark:text-amber-400" />}
              {licenseInfo.available_licenses === 0 && <XCircle className="h-3.5 w-3.5 text-red-600 dark:text-red-400" />}
              {licenseInfo.available_licenses && licenseInfo.available_licenses <= 2 && <AlertTriangle className="h-3.5 w-3.5 text-orange-600 dark:text-orange-400" />}
              {licenseInfo.available_licenses && licenseInfo.available_licenses > 2 && <CheckCircle2 className="h-3.5 w-3.5 text-emerald-600 dark:text-emerald-400" />}
              <span className={licenseInfo.available_licenses === null ? 'text-amber-900 dark:text-amber-100' : licenseInfo.available_licenses === 0 ? 'text-red-900 dark:text-red-100' : licenseInfo.available_licenses <= 2 ? 'text-orange-900 dark:text-orange-100' : 'text-emerald-900 dark:text-emerald-100'}>
                {licenseInfo.available_licenses === null ? 'License info unavailable' : licenseInfo.available_licenses === 0 ? 'No licenses available' : licenseInfo.available_licenses <= 2 ? 'Low on licenses' : 'Licenses available'}
              </span>
            </div>
            {licenseInfo.available_licenses !== null && licenseInfo.total_licenses && (
              <div className="text-zinc-600 dark:text-zinc-400">
                <div className="mb-2 flex items-baseline gap-2">
                  <strong className="text-sm font-semibold text-zinc-900 dark:text-zinc-100">{licenseInfo.available_licenses}</strong>
                  <span className="text-[10px]">of {licenseInfo.total_licenses} available</span>
                </div>
                <div className="mb-1.5 h-2 w-full overflow-hidden rounded-full bg-zinc-200 dark:bg-zinc-700">
                  <div
                    className={licenseInfo.available_licenses === 0 ? 'h-full bg-red-500 dark:bg-red-600' : licenseInfo.available_licenses <= 2 ? 'h-full bg-orange-500 dark:bg-orange-600' : 'h-full bg-emerald-500 dark:bg-emerald-600'}
                    style={{ width: ((licenseInfo.total_licenses - licenseInfo.available_licenses) / licenseInfo.total_licenses) * 100 + '%' }}
                  />
                </div>
                <div className="text-[10px] text-zinc-500 dark:text-zinc-400">
                  {licenseInfo.total_licenses - licenseInfo.available_licenses} used, {licenseInfo.available_licenses} free
                </div>
              </div>
            )}
            {licenseInfo.available_licenses === null && (
              <div className="text-[10px] text-zinc-600 dark:text-zinc-400">
                {licenseInfo.note || licenseInfo.error || 'Check Google Workspace Admin console'}
              </div>
            )}
          </div>
        )}

          {/* Link to the external onboarding paperwork template — preview / edit the doc */}
          <a
            href={ONBOARDING_PAPERWORK_TEMPLATE_URL}
            target="_blank"
            rel="noopener noreferrer"
            className="group flex flex-1 items-center gap-3 rounded-lg border border-emerald-200/60 bg-emerald-50/60 px-3 py-2.5 text-xs transition-colors hover:border-emerald-300 hover:bg-emerald-100/70 dark:border-emerald-900/40 dark:bg-emerald-950/20 dark:hover:border-emerald-800 dark:hover:bg-emerald-950/40"
          >
            <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-md bg-emerald-100 text-emerald-700 dark:bg-emerald-900/50 dark:text-emerald-300">
              <FileText className="h-4 w-4" />
            </span>
            <span className="min-w-0 flex-1">
              <span className="flex items-center gap-1 font-medium text-emerald-900 dark:text-emerald-100">
                Onboarding Paper Work Template
                <ExternalLink className="h-3 w-3 shrink-0 opacity-60 transition-opacity group-hover:opacity-100" />
              </span>
              <span className="mt-0.5 block text-[10px] text-emerald-700/80 dark:text-emerald-300/70">
                Preview what the onboarding paperwork looks like
              </span>
            </span>
          </a>
        </div>
      </div>

      {/* Filter + search */}
      <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
        <div className="flex flex-wrap items-center gap-1">
          <div role="tablist" aria-label="Onboarding submission status" className="flex flex-wrap items-center gap-1">
            <FilterPill label="Awaiting submission" count={counts.pending} active={filter === 'pending'} onClick={() => setFilter('pending')} />
            <FilterPill label="Submitted" count={counts.submitted} active={filter === 'submitted'} onClick={() => setFilter('submitted')} />
            <FilterPill label="Archived" count={counts.archived} active={filter === 'archived'} onClick={() => setFilter('archived')} />
            <FilterPill label="All" count={rows.length} active={filter === 'all'} onClick={() => setFilter('all')} />
          </div>
          {filter === 'submitted' && counts.submitted > 0 && (
            <>
              <span className="mx-1 h-4 w-px bg-emerald-200/70 dark:bg-emerald-900/50" aria-hidden />
              <button
                type="button"
                onClick={() => setHideEmailSet((v) => !v)}
                aria-pressed={hideEmailSet}
                title="Show only submissions that still need setup — no work email yet, or a minted address whose account creation failed. Hides hires with a confirmed designated work email."
                className={cn(
                  'flex items-center gap-1.5 rounded-md px-2.5 py-1 text-[12px] font-medium transition-colors',
                  hideEmailSet
                    ? 'bg-gradient-to-r from-emerald-500 to-teal-700 text-white shadow-sm shadow-emerald-600/25'
                    : 'text-zinc-600 hover:bg-emerald-50 hover:text-emerald-900 dark:text-zinc-300 dark:hover:bg-emerald-950/40 dark:hover:text-emerald-100',
                )}
              >
                {hideEmailSet ? <EyeOff className="h-3.5 w-3.5" /> : <Eye className="h-3.5 w-3.5" />}
                Needs setup
                <span
                  className={cn(
                    'rounded-full px-1.5 text-[10px] tabular-nums',
                    hideEmailSet ? 'bg-white/20 text-white' : 'bg-zinc-100 text-zinc-600 dark:bg-zinc-800 dark:text-zinc-400',
                  )}
                >
                  {submittedNeedingEmail}
                </span>
              </button>
              {submittedFailed > 0 && (
                <button
                  type="button"
                  onClick={() => setShowFailedOnly((v) => !v)}
                  aria-pressed={showFailedOnly}
                  title="Show only hires whose Google Workspace account creation failed — these need a retry."
                  className={cn(
                    'flex items-center gap-1.5 rounded-md px-2.5 py-1 text-[12px] font-medium transition-colors',
                    showFailedOnly
                      ? 'bg-gradient-to-r from-rose-500 to-rose-700 text-white shadow-sm shadow-rose-600/25'
                      : 'text-rose-600 hover:bg-rose-50 hover:text-rose-800 dark:text-rose-300 dark:hover:bg-rose-950/30 dark:hover:text-rose-100',
                  )}
                >
                  <XCircle className="h-3.5 w-3.5" />
                  Account Creation Failed
                  <span
                    className={cn(
                      'rounded-full px-1.5 text-[10px] tabular-nums',
                      showFailedOnly ? 'bg-white/20 text-white' : 'bg-rose-100 text-rose-700 dark:bg-rose-950/50 dark:text-rose-300',
                    )}
                  >
                    {submittedFailed}
                  </span>
                </button>
              )}
            </>
          )}
        </div>
        <div className="flex w-full items-center gap-2 sm:w-auto">
          <div className="relative w-full sm:w-72">
            <Search className="pointer-events-none absolute left-3 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-zinc-400" />
            <Input
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              placeholder="Search name, email, dept…"
              className="border-emerald-100/70 bg-white pl-9 dark:border-emerald-900/50 dark:bg-zinc-900"
            />
          </div>
          <OnboardingExportMenu
            rows={filtered}
            scopeLabel={
              filter === 'all'
                ? 'All'
                : filter === 'pending'
                  ? 'Awaiting submission'
                  : filter === 'submitted'
                    ? 'Submitted'
                    : 'Archived'
            }
            disabled={loading}
          />
        </div>
      </div>

      {/* Bulk action bar — appears once one or more rows are selected. Selection
          persists across search/filter, so this can include rows not currently
          shown. Each action only targets the eligible subset of the selection. */}
      {selectedRows.length > 0 && (
        <div className="flex flex-wrap items-center gap-2 rounded-xl border border-emerald-200 bg-emerald-50/70 px-4 py-2.5 dark:border-emerald-900/50 dark:bg-emerald-950/25">
          <span className="text-sm font-medium text-emerald-900 dark:text-emerald-200">
            {selectedRows.length} selected
            {hiddenSelectedCount > 0 && (
              <span className="ml-1 font-normal text-emerald-700/80 dark:text-emerald-300/70">
                ({hiddenSelectedCount} hidden by search/filter)
              </span>
            )}
          </span>
          <div className="ml-auto flex flex-wrap items-center gap-1.5">
            {selSendable.length > 0 && (
              <Button
                size="sm"
                variant="outline"
                className="h-7 gap-1 px-2 text-xs text-emerald-800 hover:bg-emerald-100 dark:text-emerald-200 dark:hover:bg-emerald-900/40"
                onClick={() => setBulkAction({ type: 'send', rows: selSendable })}
                disabled={bulkBusy}
              >
                <Send className="h-3 w-3" />
                Send ({selSendable.length})
              </Button>
            )}
            {selWorkEmailable.length > 0 && (
              <Button
                size="sm"
                className="h-7 gap-1 bg-gradient-to-r from-emerald-500 to-teal-700 px-2.5 text-xs text-white shadow-sm shadow-emerald-600/25 hover:opacity-90"
                onClick={openBulkWorkEmail}
                disabled={bulkBusy}
                title="Mint @simple.biz addresses for the submitted hires, grouped by department"
              >
                <Mail className="h-3 w-3" />
                Set work email ({selWorkEmailable.length})
              </Button>
            )}
            {showBulkVerify && (
              <Button
                size="sm"
                variant="outline"
                className="h-7 gap-1 px-2 text-xs text-sky-800 hover:bg-sky-50 dark:text-sky-200 dark:hover:bg-sky-950/30"
                onClick={() => void runBulkVerify(selVerifiable)}
                disabled={bulkBusy || bulkVerify?.running}
                title="Look up each selected account in Google Workspace (read-only - never recreates)"
              >
                <ShieldCheck className="h-3 w-3" />
                Verify ({selVerifiable.length})
              </Button>
            )}
            {selArchivable.length > 0 && (
              <Button
                size="sm"
                variant="outline"
                className="h-7 gap-1 px-2 text-xs text-zinc-700 hover:bg-zinc-100 dark:text-zinc-300 dark:hover:bg-zinc-800"
                onClick={() => setBulkAction({ type: 'archive', rows: selArchivable })}
                disabled={bulkBusy}
              >
                <Archive className="h-3 w-3" />
                Archive ({selArchivable.length})
              </Button>
            )}
            {selDeletable.length > 0 && (
              <Button
                size="sm"
                variant="outline"
                className="h-7 gap-1 px-2 text-xs text-rose-700 hover:bg-rose-50 hover:text-rose-800 dark:text-rose-300 dark:hover:bg-rose-950/30"
                onClick={() => setBulkAction({ type: 'delete', rows: selDeletable })}
                disabled={bulkBusy}
              >
                <Trash2 className="h-3 w-3" />
                Delete ({selDeletable.length})
              </Button>
            )}
            <Button
              size="sm"
              variant="ghost"
              className="h-7 px-2 text-xs text-zinc-500 hover:text-zinc-800 dark:hover:text-zinc-200"
              onClick={() => setSelectedIds(new Set())}
              disabled={bulkBusy}
            >
              Clear
            </Button>
          </div>
        </div>
      )}

      {/* Submissions table */}
      <div className="overflow-hidden rounded-xl border border-emerald-100/80 bg-white shadow-sm ring-1 ring-emerald-500/5 dark:border-emerald-950/40 dark:bg-zinc-950">
        {loading ? (
          <div className="overflow-x-auto">
            <table className="w-full text-left text-sm sm:min-w-[1040px]">
              <thead className="border-b border-emerald-100/60 bg-gradient-to-r from-emerald-50 via-white to-emerald-50/80 text-xs text-zinc-600 dark:border-emerald-900/40 dark:from-emerald-950/40 dark:via-zinc-950 dark:to-emerald-950/30 dark:text-zinc-400">
                <tr>
                  <th className="w-10 px-4 py-3" />
                  <th className="px-4 py-3 font-semibold">Invitee</th>
                  <th className="px-4 py-3 font-semibold">Department</th>
                  <th className="px-4 py-3 font-semibold">Country</th>
                  <th className="px-4 py-3 font-semibold">Status</th>
                  <th className="px-4 py-3 font-semibold">Created</th>
                  <th className="px-4 py-3 font-semibold">Submitted</th>
                  <th className="px-4 py-3 font-semibold">Designated Work Email</th>
                  <th className="px-4 py-3 font-semibold text-right">Actions</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-emerald-100/60 dark:divide-emerald-900/30">
                {Array.from({ length: 5 }).map((_, i) => (
                  <tr key={i} className="align-top">
                    <td className="px-4 py-3">
                      <Skeleton className="h-4 w-4 rounded" />
                    </td>
                    <td className="px-4 py-3">
                      <Skeleton className="h-4 w-32" />
                      <Skeleton className="mt-1.5 h-3 w-40" />
                    </td>
                    <td className="px-4 py-3"><Skeleton className="h-3.5 w-20" /></td>
                    <td className="px-4 py-3"><Skeleton className="h-3.5 w-16" /></td>
                    <td className="px-4 py-3"><Skeleton className="h-5 w-20 rounded-full" /></td>
                    <td className="px-4 py-3"><Skeleton className="h-3.5 w-16" /></td>
                    <td className="px-4 py-3"><Skeleton className="h-3.5 w-16" /></td>
                    <td className="px-4 py-3"><Skeleton className="h-5 w-40 rounded-md" /></td>
                    <td className="px-4 py-3 text-right">
                      <div className="flex justify-end gap-1.5">
                        <Skeleton className="h-7 w-16 rounded-md" />
                        <Skeleton className="h-7 w-7 rounded-md" />
                      </div>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        ) : filtered.length === 0 ? (
          <div className="flex flex-col items-center gap-2 py-12 text-center">
            <FileText className="h-8 w-8 text-emerald-300" />
            <p className="text-sm text-zinc-500">
              {rows.length === 0
                ? 'No onboarding links yet — click "Generate link" to send your first one.'
                : 'No submissions match this filter.'}
            </p>
          </div>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-left text-sm sm:min-w-[1040px]">
              <thead className="border-b border-emerald-100/60 bg-gradient-to-r from-emerald-50 via-white to-emerald-50/80 text-xs text-zinc-600 dark:border-emerald-900/40 dark:from-emerald-950/40 dark:via-zinc-950 dark:to-emerald-950/30 dark:text-zinc-400">
                <tr>
                  <th className="w-10 px-4 py-3">
                    <Checkbox
                      checked={allVisibleSelected}
                      indeterminate={someVisibleSelected}
                      onCheckedChange={toggleAllVisible}
                      aria-label="Select all visible submissions"
                    />
                  </th>
                  <th className="px-4 py-3 font-semibold">Invitee</th>
                  <th className="px-4 py-3 font-semibold">Department</th>
                  <th className="px-4 py-3 font-semibold">Country</th>
                  <th className="px-4 py-3 font-semibold">Status</th>
                  <th className="px-4 py-3 font-semibold">Created</th>
                  <th className="px-4 py-3 font-semibold">Submitted</th>
                  <th className="px-4 py-3 font-semibold">Designated Work Email</th>
                  <th className="px-4 py-3 font-semibold text-right">Actions</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-emerald-100/60 dark:divide-emerald-900/30">
                {pageRows.map((r, i) => {
                  const isBusy = busyId === r.id;
                  const wstate = workEmailState(r);
                  return (
                    // Keyed by filter so every row remounts and re-runs its
                    // stagger-in when you switch Awaiting/Submitted/Archived/All.
                    <motion.tr
                      key={`${filter}:${r.id}`}
                      initial={{ opacity: 0, y: 4 }}
                      animate={{ opacity: 1, y: 0 }}
                      transition={{ duration: 0.18, ease: 'easeOut', delay: reduceMotion ? 0 : Math.min(i * 0.025, 0.25) }}
                      className={cn(
                        'align-top hover:bg-emerald-50/30 dark:hover:bg-emerald-950/20',
                        selectedIds.has(r.id) && 'bg-emerald-50/60 dark:bg-emerald-950/30',
                      )}
                    >
                      <td data-label="Select" className="px-4 py-3">
                        <Checkbox
                          checked={selectedIds.has(r.id)}
                          onCheckedChange={() => toggleOne(r.id)}
                          aria-label={`Select ${r.invite_name ?? r.full_name ?? 'submission'}`}
                        />
                      </td>
                      <td data-label="Invitee" className="px-4 py-3">
                        <div className="font-medium text-zinc-900 dark:text-zinc-100">
                          {/* Submitted hires show the surname-first display name
                              (`Reroma, Jan Kane "Kane"`); pending rows have no
                              full_name yet so they fall back to the invite name. */}
                          {r.display_name ?? r.invite_name ?? r.full_name ?? '—'}
                        </div>
                        <div className="mt-0.5 break-all font-mono text-[11px] text-zinc-500">
                          {r.invite_personal_email ?? r.email ?? '—'}
                        </div>
                      </td>
                      <td data-label="Department" className="px-4 py-3 text-xs text-zinc-700 dark:text-zinc-300">
                        {r.invite_department ?? '—'}
                      </td>
                      <td data-label="Country" className="px-4 py-3 text-xs text-zinc-700 dark:text-zinc-300">
                        {r.country ?? r.invite_country ?? '—'}
                      </td>
                      <td data-label="Status" className="px-4 py-3">
                        {(() => {
                          const pill = submissionStatusPill(r);
                          return (
                            <Badge variant="outline" className={cn('text-[10px] font-medium', pill.className)}>
                              {pill.label}
                            </Badge>
                          );
                        })()}
                      </td>
                      <td data-label="Created" className="px-4 py-3 text-xs text-zinc-500">
                        {fmtDateTime(r.created_at)}
                      </td>
                      <td data-label="Submitted" className="px-4 py-3 text-xs text-zinc-500">
                        {fmtDateTime(r.submitted_at)}
                      </td>
                      <td data-label="Designated Work Email" className="px-4 py-3">
                        <DesignatedWorkEmailCell
                          row={r}
                          onVerify={() => void verifyWorkEmail(r)}
                          verifying={
                            verifyDialog?.loading === true && verifyDialog.row.id === r.id
                          }
                        />
                      </td>
                      <td data-label="Actions" className="px-4 py-3 text-right max-sm:flex-col max-sm:items-stretch max-sm:text-left">
                        <div className="flex flex-wrap justify-end gap-1.5 max-sm:justify-start">
                          {r.status === 'pending' && (
                            <>
                              <Button
                                size="sm"
                                variant="outline"
                                className="h-7 gap-1 px-2 text-xs text-emerald-800 hover:bg-emerald-50 dark:text-emerald-200 dark:hover:bg-emerald-950/30"
                                onClick={() => void resendLink(r)}
                                disabled={isBusy}
                                title={`Send onboarding link to ${r.invite_personal_email ?? 'this hire'}`}
                              >
                                {isBusy ? (
                                  <Loader2 className="h-3 w-3 animate-spin" />
                                ) : (
                                  <Send className="h-3 w-3" />
                                )}
                                Send
                              </Button>
                              <Button
                                size="sm"
                                variant="outline"
                                className="h-7 px-2 text-xs"
                                onClick={() => {
                                  void navigator.clipboard.writeText(publicLinkFor(r.token));
                                  toast.success('Link copied');
                                }}
                                title="Copy public link"
                              >
                                <ClipboardCopy className="mr-1 h-3 w-3" />
                                Copy link
                              </Button>
                            </>
                          )}
                          {r.status === 'submitted' && (
                            <>
                              {/* The minted address now lives in the dedicated
                                  "Designated Work Email" column, so no inline
                                  badge here. The button below is state-aware:
                                  a failed automation reads "Retry setup" and
                                  goes loud so HR can tell it apart. */}
                              <Button
                                size="sm"
                                variant="outline"
                                className={cn(
                                  'h-7 gap-1 px-2 text-xs',
                                  wstate === 'failed'
                                    ? 'border-rose-300 text-rose-700 hover:bg-rose-50 dark:border-rose-800 dark:text-rose-300 dark:hover:bg-rose-950/30'
                                    : 'text-emerald-800 hover:bg-emerald-50 dark:text-emerald-200 dark:hover:bg-emerald-950/30',
                                )}
                                onClick={() => setWorkEmailFor(r)}
                                title={
                                  wstate === 'failed'
                                    ? 'Account creation failed - retry to create the account + Hubstaff invite'
                                    : r.pending_employee_id
                                      ? 'Re-send workspace setup with updated details'
                                      : 'Mint an @simple.biz address and stage this hire'
                                }
                              >
                                {wstate === 'failed' ? (
                                  <RefreshCw className="h-3 w-3" />
                                ) : (
                                  <Mail className="h-3 w-3" />
                                )}
                                {wstate === 'failed'
                                  ? 'Retry setup'
                                  : r.pending_employee_id
                                    ? 'Update setup'
                                    : 'Set work email'}
                              </Button>
                              <Button
                                size="sm"
                                variant="outline"
                                className="h-7 gap-1 px-2 text-xs text-zinc-600 hover:bg-zinc-50 dark:text-zinc-300 dark:hover:bg-zinc-800/50"
                                onClick={() => void resendLink(r)}
                                disabled={isBusy}
                                title={`Resend the onboarding link to ${r.invite_personal_email ?? r.email ?? 'this hire'}`}
                              >
                                {isBusy ? (
                                  <Loader2 className="h-3 w-3 animate-spin" />
                                ) : (
                                  <Send className="h-3 w-3" />
                                )}
                                Resend
                              </Button>
                              <Button
                                size="sm"
                                className="h-7 bg-gradient-to-r from-emerald-500 to-teal-700 px-3 text-xs text-white hover:opacity-90"
                                onClick={() => setViewRow(r)}
                              >
                                <Eye className="mr-1 h-3 w-3" />
                                View
                              </Button>
                            </>
                          )}
                          {r.status !== 'archived' ? (
                            <Button
                              size="sm"
                              variant="outline"
                              className="h-7 px-2 text-xs text-zinc-600 hover:bg-zinc-50"
                              onClick={() => setArchiveTarget(r)}
                              disabled={isBusy}
                              title="Archive — link will stop working but can be reviewed later"
                            >
                              <Archive className="h-3 w-3" />
                            </Button>
                          ) : (
                            <>
                              {/* Archived hires who actually submitted their form can
                                  still be reviewed — same View as the Submitted tab. */}
                              {r.submitted_at && (
                                <Button
                                  size="sm"
                                  className="h-7 bg-gradient-to-r from-emerald-500 to-teal-700 px-3 text-xs text-white hover:opacity-90"
                                  onClick={() => setViewRow(r)}
                                  title="View this submission's details"
                                >
                                  <Eye className="mr-1 h-3 w-3" />
                                  View
                                </Button>
                              )}
                              {/* Gmail trash-bin pattern: hard-delete only reachable from the
                                  Archived view, so accidental one-clicks can't nuke a live link. */}
                              <Button
                                size="sm"
                                variant="outline"
                                className="h-7 px-2 text-xs text-rose-700 hover:bg-rose-50 hover:text-rose-800 dark:text-rose-300 dark:hover:bg-rose-950/30"
                                onClick={() => setDeleteTarget(r)}
                                disabled={isBusy}
                                title="Permanently delete this archived submission"
                              >
                                <Trash2 className="h-3 w-3" />
                              </Button>
                            </>
                          )}
                        </div>
                      </td>
                    </motion.tr>
                  );
                })}
              </tbody>
            </table>
            {totalPages > 1 && (
              <div data-readonly-allow className="flex items-center justify-between border-t border-emerald-100/60 px-4 py-2.5 dark:border-emerald-900/30">
                <p className="text-[11px] text-zinc-400">
                  {safePage * PAGE_SIZE + 1}–{Math.min((safePage + 1) * PAGE_SIZE, filtered.length)} of {filtered.length}
                </p>
                <div className="flex items-center gap-1">
                  <Button variant="outline" size="icon" className="h-7 w-7" disabled={safePage === 0} onClick={() => setPage(0)}>
                    <ChevronLeft className="h-3 w-3" /><ChevronLeft className="h-3 w-3 -ml-2" />
                  </Button>
                  <Button variant="outline" size="icon" className="h-7 w-7" disabled={safePage === 0} onClick={() => setPage((p) => Math.max(0, p - 1))}>
                    <ChevronLeft className="h-3 w-3" />
                  </Button>
                  <span className="min-w-[4rem] text-center text-[11px] text-zinc-500">
                    {safePage + 1} / {totalPages}
                  </span>
                  <Button variant="outline" size="icon" className="h-7 w-7" disabled={safePage >= totalPages - 1} onClick={() => setPage((p) => Math.min(totalPages - 1, p + 1))}>
                    <ChevronRight className="h-3 w-3" />
                  </Button>
                  <Button variant="outline" size="icon" className="h-7 w-7" disabled={safePage >= totalPages - 1} onClick={() => setPage(totalPages - 1)}>
                    <ChevronRight className="h-3 w-3" /><ChevronRight className="h-3 w-3 -ml-2" />
                  </Button>
                </div>
              </div>
            )}
          </div>
        )}
      </div>

      <GenerateLinkDialog
        open={generateOpen}
        onClose={() => setGenerateOpen(false)}
        onCreated={(row) => {
          setGenerateOpen(false);
          setLinkCreated(row);
          void load();
        }}
      />

      <BypassSetupDialog
        open={bypassOpen}
        onClose={() => setBypassOpen(false)}
        onDone={() => {
          setBypassOpen(false);
          void load();
          refreshLicenseInfo();
        }}
      />

      <LinkCreatedDialog
        row={linkCreated}
        onClose={() => setLinkCreated(null)}
        onSent={() => void load()}
      />

      <PayPlansDialog open={payPlansOpen} onClose={() => setPayPlansOpen(false)} />

      <SubmissionDetailDialog
        row={viewRow}
        onClose={() => setViewRow(null)}
      />

      <SetOnboardingWorkEmailDialog
        row={workEmailFor}
        onClose={() => setWorkEmailFor(null)}
        onConverted={() => {
          setWorkEmailFor(null);
          void load();
          refreshLicenseInfo();
        }}
      />

      <BulkSetWorkEmailDialog
        rows={bulkWorkEmail}
        onClose={() => setBulkWorkEmail(null)}
        reload={() => void load()}
      />

      <VerifyResultDialog
        dialog={verifyDialog}
        onClose={() => setVerifyDialog(null)}
        onTryAgain={(row) => void verifyWorkEmail(row)}
        onManualConfirm={(row) => void markWorkspace(row, true)}
        onRetrySetup={(row) => {
          setVerifyDialog(null);
          setWorkEmailFor(row);
        }}
      />

      <BulkVerifyDialog
        state={bulkVerify}
        onClose={() => setBulkVerify(null)}
      />

      <Dialog open={!!archiveTarget} onOpenChange={(o) => !o && setArchiveTarget(null)}>
        <DialogContent className="max-w-md">
          <DialogHeader>
            <DialogTitle className="text-base">Archive this submission?</DialogTitle>
            <DialogDescription className="text-xs">
              The link will stop working. You can still see archived submissions under the
              Archived filter, but the new hire won't be able to open or submit the form.
            </DialogDescription>
          </DialogHeader>
          <DialogFooter className="gap-2 sm:gap-0">
            <Button variant="outline" size="sm" onClick={() => setArchiveTarget(null)}>
              Keep
            </Button>
            <Button
              size="sm"
              className="bg-zinc-700 hover:bg-zinc-800"
              onClick={() => archiveTarget && void archive(archiveTarget)}
              disabled={busyId === archiveTarget?.id}
            >
              {busyId === archiveTarget?.id ? (
                <Loader2 className="mr-1 h-3 w-3 animate-spin" />
              ) : (
                <Archive className="mr-1 h-3 w-3" />
              )}
              Archive
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <Dialog open={!!deleteTarget} onOpenChange={(o) => !o && setDeleteTarget(null)}>
        <DialogContent className="max-w-md">
          <DialogHeader>
            <DialogTitle className="text-base">Permanently delete this submission?</DialogTitle>
            <DialogDescription className="text-xs">
              <strong>{deleteTarget?.invite_name ?? deleteTarget?.full_name ?? 'This row'}</strong>
              {' '}
              ({deleteTarget?.invite_personal_email ?? deleteTarget?.email ?? '—'}) will be
              removed from the database, along with any signatures and W-8BEN file uploaded
              with it. This cannot be undone.
            </DialogDescription>
          </DialogHeader>
          <DialogFooter className="gap-2 sm:gap-0">
            <Button variant="outline" size="sm" onClick={() => setDeleteTarget(null)} disabled={busyId === deleteTarget?.id}>
              Keep
            </Button>
            <Button
              size="sm"
              className="bg-rose-600 hover:bg-rose-700"
              onClick={() => deleteTarget && void hardDelete(deleteTarget)}
              disabled={busyId === deleteTarget?.id}
            >
              {busyId === deleteTarget?.id ? (
                <Loader2 className="mr-1 h-3 w-3 animate-spin" />
              ) : (
                <Trash2 className="mr-1 h-3 w-3" />
              )}
              Delete permanently
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <Dialog open={!!bulkAction} onOpenChange={(o) => !o && !bulkBusy && setBulkAction(null)}>
        <DialogContent className="max-w-md">
          <DialogHeader>
            <DialogTitle className="text-base">
              {bulkAction?.type === 'send'
                ? `Send ${bulkAction.rows.length} onboarding email${bulkAction.rows.length === 1 ? '' : 's'}?`
                : bulkAction?.type === 'archive'
                  ? `Archive ${bulkAction.rows.length} submission${bulkAction.rows.length === 1 ? '' : 's'}?`
                  : `Permanently delete ${bulkAction?.rows.length ?? 0} submission${bulkAction?.rows.length === 1 ? '' : 's'}?`}
            </DialogTitle>
            <DialogDescription className="text-xs">
              {bulkAction?.type === 'send'
                ? 'Each recipient gets a fresh, unique link — any previous link for that row stops working. Emails go out via the configured webhook.'
                : bulkAction?.type === 'archive'
                  ? "Their links will stop working. You can still review them under the Archived filter, but new hires won't be able to open or submit the form."
                  : 'These archived submissions and any signatures / W-8BEN files uploaded with them will be removed from the database. This cannot be undone.'}
            </DialogDescription>
          </DialogHeader>
          <DialogFooter className="gap-2 sm:gap-0">
            <Button variant="outline" size="sm" onClick={() => setBulkAction(null)} disabled={bulkBusy}>
              Cancel
            </Button>
            <Button
              size="sm"
              className={cn(
                bulkAction?.type === 'send' && 'bg-emerald-600 hover:bg-emerald-700',
                bulkAction?.type === 'archive' && 'bg-zinc-700 hover:bg-zinc-800',
                bulkAction?.type === 'delete' && 'bg-rose-600 hover:bg-rose-700',
              )}
              onClick={() => void runBulkAction()}
              disabled={bulkBusy}
            >
              {bulkBusy ? (
                <Loader2 className="mr-1 h-3 w-3 animate-spin" />
              ) : bulkAction?.type === 'send' ? (
                <Send className="mr-1 h-3 w-3" />
              ) : bulkAction?.type === 'archive' ? (
                <Archive className="mr-1 h-3 w-3" />
              ) : (
                <Trash2 className="mr-1 h-3 w-3" />
              )}
              {bulkAction?.type === 'send'
                ? 'Send all'
                : bulkAction?.type === 'archive'
                  ? 'Archive all'
                  : 'Delete all'}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}

// ─── Bypass / manual setup dialog ─────────────────────────────────────────

/**
 * "Bypass" — manual setup for a worker whose @simple.biz Google Workspace
 * account is ALREADY provisioned (set up outside the self-serve onboarding
 * flow). HR types the worker's identity + their existing work email; a
 * read-only Verify confirms the account exists in Google Workspace — and the
 * pipeline is BLOCKED until it does. "Promote to Master List" then stages the
 * hire and promotes them straight into global_master_list + the master Google
 * Sheet in one shot (POST /api/hr/onboarding-bypass), reusing the exact same
 * promote pipeline as every other hire. The create-workspace webhook is NEVER
 * fired — no duplicate account, no Hubstaff invite, no onboarding emails —
 * because the account already exists.
 */
function BypassSetupDialog({
  open,
  onClose,
  onDone,
}: {
  open: boolean;
  onClose: () => void;
  onDone: () => void;
}) {
  const [departments, setDepartments] = useState<string[]>([]);
  const [deptsLoading, setDeptsLoading] = useState(false);

  const [fullName, setFullName] = useState('');
  const [personalEmail, setPersonalEmail] = useState('');
  const [dept, setDept] = useState('');
  const [workEmail, setWorkEmail] = useState('');
  const [phone, setPhone] = useState('');
  const [location, setLocation] = useState('');
  const [startDate, setStartDate] = useState('');

  // Verify phase — the account must be confirmed to exist before we promote.
  const [verifying, setVerifying] = useState(false);
  const [verifyState, setVerifyState] = useState<'exists' | 'missing' | 'error' | null>(null);
  const [verifyDetail, setVerifyDetail] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  // Identity token for the in-flight verify. A verify only applies its result if
  // it's still the current request — so editing the work email, closing the
  // dialog, or firing a newer verify while one is in flight can never land a
  // stale green check on a DIFFERENT address than the one being checked.
  const verifyReq = useRef<object | null>(null);

  const emailNorm = workEmail.trim().toLowerCase();
  const workEmailValid = isPlausibleEmail(emailNorm) && emailNorm.endsWith('@simple.biz');
  const personalValid = isPlausibleEmail(personalEmail.trim());
  const fieldsReady =
    fullName.trim().length > 0 && personalValid && dept.trim().length > 0 && workEmailValid;
  const verified = verifyState === 'exists';

  // Reset everything when the dialog closes so the next open starts clean.
  // Dropping verifyReq abandons any verify still in flight so its late result
  // can't stamp a stale green check onto the next open (which starts blank).
  useEffect(() => {
    if (open) return;
    verifyReq.current = null;
    setFullName(''); setPersonalEmail(''); setDept(''); setWorkEmail('');
    setPhone(''); setLocation(''); setStartDate('');
    setVerifying(false); setVerifyState(null); setVerifyDetail(null); setBusy(false);
  }, [open]);

  // Editing the work email invalidates any prior verify — HR must re-verify the
  // new address before the pipeline unlocks (so a green check never lingers on a
  // different address than the one that will be promoted). Dropping verifyReq +
  // clearing `verifying` also abandons an in-flight verify for the old address.
  useEffect(() => {
    verifyReq.current = null;
    setVerifyState(null);
    setVerifyDetail(null);
    setVerifying(false);
  }, [emailNorm]);

  // Department list, once, when the dialog opens.
  useEffect(() => {
    if (!open || departments.length > 0 || deptsLoading) return;
    setDeptsLoading(true);
    fetch('/api/departments', { cache: 'no-store' })
      .then((r) => r.json())
      .then((j: { departments?: string[]; error?: string }) => {
        if (j.error) throw new Error(j.error);
        setDepartments(j.departments ?? []);
      })
      .catch((e) => toast.error(e instanceof Error ? e.message : 'Could not load departments'))
      .finally(() => setDeptsLoading(false));
  }, [open, departments.length, deptsLoading]);

  async function runVerify() {
    if (!workEmailValid) {
      toast.error('Enter a valid @simple.biz work email first.');
      return;
    }
    const token = {};
    verifyReq.current = token;
    setVerifying(true);
    setVerifyState(null);
    setVerifyDetail(null);
    try {
      const res = await fetch('/api/hr/workspace-account/verify', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ work_email: emailNorm }),
      });
      const j = (await res.json().catch(() => ({}))) as {
        state?: 'exists' | 'missing' | 'error';
        detail?: string | null;
        error?: string;
      };
      // Stale — the address changed, the dialog closed, or a newer verify started
      // while this one was in flight. Drop the result rather than stamping it.
      if (verifyReq.current !== token) return;
      if (!res.ok && !j.state) throw new Error(j.error ?? `Verify failed (${res.status})`);
      setVerifyState(j.state ?? 'error');
      setVerifyDetail(j.detail ?? j.error ?? null);
    } catch (e) {
      if (verifyReq.current !== token) return;
      setVerifyState('error');
      setVerifyDetail(e instanceof Error ? e.message : 'Verify failed');
    } finally {
      if (verifyReq.current === token) setVerifying(false);
    }
  }

  async function runPipeline() {
    if (!verified) {
      toast.error('Verify the Workspace account first.');
      return;
    }
    setBusy(true);
    try {
      const res = await fetch('/api/hr/onboarding-bypass', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          full_name: fullName.trim(),
          personal_email: personalEmail.trim(),
          department: dept.trim(),
          work_email: emailNorm,
          phone: phone.trim() || null,
          location: location.trim() || null,
          start_date: startDate.trim() || null,
        }),
      });
      const j = (await res.json().catch(() => ({}))) as {
        ok?: boolean;
        error?: string;
        warning?: string | null;
      };
      if (!res.ok || j.error) throw new Error(j.error ?? 'Bypass failed');
      if (j.warning) {
        // Partial success — the worker IS on the master list, but the Google
        // Sheet append failed and can be retried from Pending Hires.
        toast.warning(`${fullName.trim()} added to the master list`, {
          description: `${j.warning} Retry the Google Sheet sync from Pending Hires.`,
        });
      } else {
        toast.success(`${fullName.trim()} added to the master list`, {
          description:
            'Verified and promoted straight into the roster — no account created, no emails sent.',
        });
      }
      onDone();
    } catch (e) {
      toast.error(e instanceof Error ? e.message : 'Bypass failed');
    } finally {
      setBusy(false);
    }
  }

  return (
    <Dialog open={open} onOpenChange={(o) => !o && !busy && onClose()}>
      <DialogContent className="max-h-[92vh] overflow-y-auto sm:max-w-2xl">
        {/* Header (violet, to set it apart from the emerald Generate-link flow) */}
        <div className="-mx-6 -mt-6 mb-4 overflow-hidden rounded-t-lg border-b border-violet-100/80 bg-gradient-to-br from-violet-50 via-white to-fuchsia-50/60 px-6 py-5 dark:border-violet-950/40 dark:from-violet-950/30 dark:via-zinc-950 dark:to-fuchsia-950/20">
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2.5 text-base font-semibold">
              <span className="flex h-8 w-8 shrink-0 items-center justify-center rounded-lg bg-gradient-to-br from-violet-500 to-fuchsia-700 text-white shadow-md shadow-violet-600/25">
                <ShieldCheck className="h-4 w-4" />
              </span>
              Bypass — manual setup
            </DialogTitle>
            <p className="mt-1 text-[12px] leading-relaxed text-zinc-500 dark:text-zinc-400">
              For a worker whose @simple.biz account is <strong>already set up</strong>. Verify the
              account exists, then promote them straight to the master list — no account is created
              and no onboarding emails are sent.
            </p>
          </DialogHeader>
        </div>

        {/* Identity */}
        <div className="flex flex-col gap-4">
          <div className="grid gap-4 sm:grid-cols-2">
            <div className="flex flex-col gap-1.5">
              <Label className="text-[10px] font-semibold uppercase tracking-widest text-zinc-400 dark:text-zinc-500">
                Full name
              </Label>
              <div className="relative">
                <User className="pointer-events-none absolute left-2.5 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-zinc-400" />
                <Input
                  value={fullName}
                  onChange={(e) => setFullName(e.target.value)}
                  placeholder="Jan Kane Reroma"
                  className="pl-8"
                  autoFocus
                />
              </div>
            </div>
            <div className="flex flex-col gap-1.5">
              <Label className="text-[10px] font-semibold uppercase tracking-widest text-zinc-400 dark:text-zinc-500">
                Personal email
              </Label>
              <div className="relative">
                <Mail className="pointer-events-none absolute left-2.5 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-zinc-400" />
                <Input
                  value={personalEmail}
                  onChange={(e) => setPersonalEmail(e.target.value)}
                  placeholder="jane@gmail.com"
                  className="pl-8 font-mono"
                  spellCheck={false}
                  autoCapitalize="none"
                />
              </div>
              {personalEmail.trim().length > 0 && !personalValid && (
                <p className="text-[11px] text-rose-600 dark:text-rose-400">
                  Enter a valid personal email.
                </p>
              )}
            </div>
          </div>

          {/* Department */}
          <div className="flex flex-col gap-1.5">
            <Label className="text-[10px] font-semibold uppercase tracking-widest text-zinc-400 dark:text-zinc-500">
              Department
            </Label>
            <DepartmentSelect
              value={dept}
              onChange={setDept}
              departments={departments}
              loading={deptsLoading}
            />
            <p className="text-[11px] text-zinc-400 dark:text-zinc-500">
              Required — the worker is added to the master list under this department.
            </p>
          </div>

          {/* Existing work email + verify */}
          <div className="flex flex-col gap-1.5">
            <Label className="text-[10px] font-semibold uppercase tracking-widest text-zinc-400 dark:text-zinc-500">
              Existing work email
            </Label>
            <div className="flex flex-col gap-2 sm:flex-row sm:items-center">
              <div className="relative flex-1">
                <Mail className="pointer-events-none absolute left-2.5 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-zinc-400" />
                <Input
                  value={workEmail}
                  onChange={(e) => setWorkEmail(e.target.value)}
                  placeholder="namel@simple.biz"
                  className="pl-8 pr-9 font-mono"
                  spellCheck={false}
                  autoCapitalize="none"
                />
                <span className="pointer-events-none absolute right-2.5 top-1/2 -translate-y-1/2">
                  {verifying ? (
                    <Loader2 className="h-4 w-4 animate-spin text-zinc-400" />
                  ) : verifyState === 'exists' ? (
                    <CheckCircle2 className="h-4 w-4 text-emerald-500" />
                  ) : verifyState === 'missing' ? (
                    <XCircle className="h-4 w-4 text-rose-500" />
                  ) : verifyState === 'error' ? (
                    <AlertTriangle className="h-4 w-4 text-amber-500" />
                  ) : null}
                </span>
              </div>
              <Button
                type="button"
                variant="outline"
                size="sm"
                className="border-violet-200 text-violet-800 hover:bg-violet-50 disabled:opacity-50 dark:border-violet-900/50 dark:text-violet-300 dark:hover:bg-violet-950/30"
                onClick={() => void runVerify()}
                disabled={!workEmailValid || verifying}
              >
                {verifying ? (
                  <Loader2 className="mr-1 h-3.5 w-3.5 animate-spin" />
                ) : (
                  <ShieldCheck className="mr-1 h-3.5 w-3.5" />
                )}
                {verifying ? 'Verifying' : verified ? 'Re-verify' : 'Verify'}
              </Button>
            </div>

            {/* Verify result banner */}
            {verifyState === 'exists' && (
              <div className="flex items-center gap-2 rounded-lg border border-emerald-200 bg-emerald-50/70 px-3 py-2 text-xs font-medium text-emerald-800 dark:border-emerald-900/50 dark:bg-emerald-950/25 dark:text-emerald-200">
                <CheckCircle2 className="h-4 w-4 shrink-0" />
                Account verified in Google Workspace — you can promote this worker.
              </div>
            )}
            {verifyState === 'missing' && (
              <div className="flex items-start gap-2 rounded-lg border border-rose-200 bg-rose-50/70 px-3 py-2 text-xs font-medium text-rose-800 dark:border-rose-900/50 dark:bg-rose-950/25 dark:text-rose-200">
                <XCircle className="mt-0.5 h-4 w-4 shrink-0" />
                <span>
                  No account found for this address. Bypass is only for workers who already have a
                  Workspace account — use “Generate link” to provision a new one.
                </span>
              </div>
            )}
            {verifyState === 'error' && (
              <div className="flex items-start gap-2 rounded-lg border border-amber-200 bg-amber-50/70 px-3 py-2 text-xs font-medium text-amber-800 dark:border-amber-900/50 dark:bg-amber-950/25 dark:text-amber-200">
                <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0" />
                <span>
                  Could not verify this account{verifyDetail ? ` (${verifyDetail})` : ''}. It must be
                  verifiable before it can be bypassed — try again.
                </span>
              </div>
            )}
            {!verifyState && (
              <p className="text-[11px] text-zinc-400 dark:text-zinc-500">
                Must be an @simple.biz address. Click Verify to confirm the account exists before
                promoting.
              </p>
            )}
          </div>

          {/* Optional details */}
          <div className="grid gap-4 sm:grid-cols-3">
            <div className="flex flex-col gap-1.5">
              <Label className="text-[10px] font-semibold uppercase tracking-widest text-zinc-400 dark:text-zinc-500">
                Phone <span className="font-normal normal-case text-zinc-400">(optional)</span>
              </Label>
              <Input value={phone} onChange={(e) => setPhone(e.target.value)} placeholder="+63…" />
            </div>
            <div className="flex flex-col gap-1.5">
              <Label className="text-[10px] font-semibold uppercase tracking-widest text-zinc-400 dark:text-zinc-500">
                Location <span className="font-normal normal-case text-zinc-400">(optional)</span>
              </Label>
              <Input
                value={location}
                onChange={(e) => setLocation(e.target.value)}
                placeholder="City, Country"
              />
            </div>
            <div className="flex flex-col gap-1.5">
              <Label className="text-[10px] font-semibold uppercase tracking-widest text-zinc-400 dark:text-zinc-500">
                Start date <span className="font-normal normal-case text-zinc-400">(optional)</span>
              </Label>
              <DatePicker value={startDate} onChange={setStartDate} />
            </div>
          </div>
        </div>

        <DialogFooter className="mt-5 gap-2 border-t border-zinc-100 pt-4 sm:gap-0 dark:border-zinc-800">
          <Button variant="outline" size="sm" onClick={onClose} disabled={busy}>
            Cancel
          </Button>
          {!verified ? (
            <Button
              size="sm"
              className="bg-gradient-to-br from-violet-500 to-fuchsia-700 text-white shadow-md shadow-violet-600/25 hover:from-violet-500 hover:to-fuchsia-600"
              onClick={() => void runVerify()}
              disabled={!fieldsReady || verifying}
              title={
                fieldsReady
                  ? 'Check that this Workspace account exists'
                  : 'Fill in name, personal email, department and a valid @simple.biz work email first'
              }
            >
              {verifying ? (
                <Loader2 className="mr-1 h-3.5 w-3.5 animate-spin" />
              ) : (
                <ShieldCheck className="mr-1 h-3.5 w-3.5" />
              )}
              {verifying ? 'Verifying…' : 'Verify account'}
            </Button>
          ) : (
            <Button
              size="sm"
              className="bg-gradient-to-br from-violet-500 to-fuchsia-700 text-white shadow-md shadow-violet-600/25 hover:from-violet-500 hover:to-fuchsia-600"
              onClick={() => void runPipeline()}
              disabled={!fieldsReady || busy}
            >
              {busy ? (
                <Loader2 className="mr-1 h-3.5 w-3.5 animate-spin" />
              ) : (
                <UserCheck className="mr-1 h-3.5 w-3.5" />
              )}
              {busy ? 'Promoting…' : 'Promote to Master List'}
            </Button>
          )}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

// ─── Generate link dialog ─────────────────────────────────────────────────

/** One bulk hire: an email plus the canonical country of the paste box it was
 *  pasted into (which selects that hire's pay-plan PDF). */
type BulkRow = { email: string; country: string };

/** Extracts a deduped list of valid emails from free-pasted text. Newlines,
 *  commas, tabs, spaces, semicolons and pipes all separate tokens, so an Excel
 *  column, a comma-list, or "Name <email>" rows all work. Tokens that look
 *  email-ish (contain @ or .) but don't validate come back as `invalid` so HR
 *  can spot typos; plain words (stray names) are ignored. Lower-cased + deduped. */
function parseEmailList(raw: string): { valid: string[]; invalid: string[] } {
  const tokens = raw.split(/[\s,;|]+/).map((t) => t.trim()).filter(Boolean);
  const seen = new Set<string>();
  const seenInvalid = new Set<string>();
  const valid: string[] = [];
  const invalid: string[] = [];
  for (const t of tokens) {
    // Peel off the cruft that rides along when pasting "Name <addr>", a
    // mailto: link, or a trailing comma/period from a list — so the address
    // itself validates instead of being stored (or skipped) with the brackets.
    const cleaned = t
      .replace(/^mailto:/i, '')
      .replace(/^[<("']+/, '')
      .replace(/[>)"'.,;]+$/, '');
    if (isPlausibleEmail(cleaned)) {
      const e = cleaned.toLowerCase();
      if (seen.has(e)) continue;
      seen.add(e);
      valid.push(e);
    } else if (cleaned.includes('@') || cleaned.includes('.')) {
      const bad = cleaned.toLowerCase();
      if (seenInvalid.has(bad)) continue;
      seenInvalid.add(bad);
      invalid.push(bad);
    }
  }
  return { valid, invalid };
}

type BulkResult = { email: string; ok: boolean; error?: string };

function GenerateLinkDialog({
  open,
  onClose,
  onCreated,
}: {
  open: boolean;
  onClose: () => void;
  onCreated: (row: SubmissionRow) => void;
}) {
  const reduceMotion = useReducedMotion();
  // Smoothly elongate the modal: measure the body's natural height so the wrapper
  // can animate TO it (box grows/shrinks instead of snapping) on toggle. A ref
  // callback + ResizeObserver keeps it live across mode swaps, pasting, and
  // validation messages — and is robust to the dialog's portal mount timing.
  const [bodyHeight, setBodyHeight] = useState<number | null>(null);
  const bodyResizeObs = useRef<ResizeObserver | null>(null);
  const measureBody = useCallback((el: HTMLDivElement | null) => {
    bodyResizeObs.current?.disconnect();
    bodyResizeObs.current = null;
    if (!el) {
      setBodyHeight(null);
      return;
    }
    setBodyHeight(el.offsetHeight);
    const ro = new ResizeObserver(() => setBodyHeight(el.offsetHeight));
    ro.observe(el);
    bodyResizeObs.current = ro;
  }, []);
  const [email, setEmail] = useState('');
  const [dept, setDept] = useState('');
  const [country, setCountry] = useState('');
  const [note, setNote] = useState('');
  const [busy, setBusy] = useState(false);

  // Bulk invite — a toggle available for ANY department (auto-on for Lead Gen).
  const [bulkMode, setBulkMode] = useState(false);

  // Bulk state — one paste box per onboarding country (keyed by canonical
  // country name). Every email pasted into a box inherits that box's country
  // (which selects its pay-plan PDF), so HR no longer tags hires one-by-one.
  const [bulkByCountry, setBulkByCountry] = useState<Record<string, string>>({});
  const [bulkProgress, setBulkProgress] = useState<{ done: number; total: number } | null>(null);
  const [bulkResults, setBulkResults] = useState<BulkResult[] | null>(null);

  // Prefill from the New Hire Checklist: pull a department's saved rows and drop
  // their emails into a chosen country box (the checklist stores no country).
  // Names ride along in `prefillNames` so each invite goes out pre-addressed.
  const [checklistRows, setChecklistRows] = useState<{ name: string; email: string; country: string }[]>([]);
  const [checklistLoading, setChecklistLoading] = useState(false);
  const [prefillCountry, setPrefillCountry] = useState('');
  const [prefillNames, setPrefillNames] = useState<Record<string, string>>({});
  // Next week's Sunday (the upcoming start cohort) — Bulk Invite only pulls
  // checklist hires filed under this week. Computed in an effect (never during
  // render) so `new Date()` can't cause SSR hydration drift.
  const [nextWeekStart, setNextWeekStart] = useState<string | null>(null);
  useEffect(() => { setNextWeekStart(addWeeks(sundayIso(new Date()), 1)); }, []);

  const [departments, setDepartments] = useState<string[]>([]);
  const [deptsLoading, setDeptsLoading] = useState(false);

  const isLeadGenDept = ['lead gen', 'lead generation'].includes(dept.trim().toLowerCase());

  // Parse each country box into a deduped email list (+ skipped tokens). A box
  // holds only emails for ONE country, so the country comes from the box, not
  // the paste.
  const parsedByCountry = useMemo(() => {
    if (!bulkMode) return [];
    return ONBOARDING_COUNTRIES.map((c) => {
      const { valid, invalid } = parseEmailList(bulkByCountry[c.name] ?? '');
      return { country: c.name, currency: c.currency, emails: valid, invalid };
    });
  }, [bulkMode, bulkByCountry]);

  // Flatten the boxes to per-hire rows, deduped GLOBALLY so an email pasted into
  // two boxes is sent once (first country wins); the rest are surfaced as
  // cross-country duplicates (each shown once, with the country it was kept as,
  // so HR can catch a mis-paste before sending).
  const { parsedRows, crossDupes } = useMemo(() => {
    const keptCountry = new Map<string, string>();
    const rows: BulkRow[] = [];
    const dupeSeen = new Set<string>();
    const dupes: { email: string; keptAs: string }[] = [];
    for (const b of parsedByCountry) {
      for (const email of b.emails) {
        if (keptCountry.has(email)) {
          if (!dupeSeen.has(email)) {
            dupeSeen.add(email);
            dupes.push({ email, keptAs: keptCountry.get(email) ?? '' });
          }
          continue;
        }
        keptCountry.set(email, b.country);
        rows.push({ email, country: b.country });
      }
    }
    return { parsedRows: rows, crossDupes: dupes };
  }, [parsedByCountry]);

  const invalidTokens = useMemo(
    () => [...new Set(parsedByCountry.flatMap((b) => b.invalid))],
    [parsedByCountry],
  );

  // Lead Gen auto-enables bulk (the common case); HR can still toggle it on for
  // any other department, or off for Lead Gen.
  useEffect(() => {
    if (isLeadGenDept) setBulkMode(true);
  }, [isLeadGenDept]);

  useEffect(() => {
    if (!open) return;
    if (departments.length > 0 || deptsLoading) return;
    setDeptsLoading(true);
    fetch('/api/departments', { cache: 'no-store' })
      .then((r) => r.json())
      .then((j: { departments?: string[]; error?: string }) => {
        if (j.error) throw new Error(j.error);
        setDepartments(j.departments ?? []);
      })
      .catch((e) =>
        toast.error(e instanceof Error ? e.message : 'Could not load departments'),
      )
      .finally(() => setDeptsLoading(false));
  }, [open, departments.length, deptsLoading]);

  useEffect(() => {
    if (!open) {
      setEmail(''); setDept(''); setCountry(''); setNote('');
      setBulkByCountry({}); setBulkProgress(null); setBulkResults(null);
      setBulkMode(false);
      setChecklistRows([]); setPrefillCountry(''); setPrefillNames({});
    }
  }, [open]);

  // Pull the selected department's NEXT-WEEK hires from the New Hire Checklist
  // (the upcoming start cohort) so they can be loaded into the batch with one
  // click. Re-runs whenever the department changes while bulk mode is on.
  useEffect(() => {
    if (!open || !bulkMode) { setChecklistRows([]); return; }
    const d = dept.trim();
    if (!d || !nextWeekStart) { setChecklistRows([]); return; }
    let cancelled = false;
    setChecklistLoading(true);
    fetch(`/api/hr/new-hire-checklist/departments?department=${encodeURIComponent(d)}&period=${encodeURIComponent(nextWeekStart)}`, { cache: 'no-store' })
      .then((r) => r.json())
      .then((j: { rows?: { name: string | null; personal_email: string | null; country: string | null }[]; error?: string }) => {
        if (cancelled) return;
        if (j.error) throw new Error(j.error);
        const rows = (j.rows ?? [])
          .map((r) => ({
            name: (r.name ?? '').trim(),
            email: (r.personal_email ?? '').trim(),
            country: (r.country ?? '').trim(),
          }))
          .filter((r) => r.email);
        setChecklistRows(rows);
      })
      .catch((e) => { if (!cancelled) toast.error(e instanceof Error ? e.message : 'Could not load the checklist'); })
      .finally(() => { if (!cancelled) setChecklistLoading(false); });
    return () => { cancelled = true; };
  }, [open, bulkMode, dept, nextWeekStart]);

  const emailInvalid = !bulkMode && email.trim().length > 0 && !isPlausibleEmail(email);

  // ── Single-hire submit ──
  async function submitSingle() {
    if (emailInvalid) { toast.error("Personal email doesn't look right."); return; }
    setBusy(true);
    try {
      const res = await fetch('/api/hr/onboarding-submissions', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          invite_name: null,
          invite_personal_email: email.trim() || null,
          invite_department: dept.trim() || null,
          invite_country: country.trim() || null,
          invite_note: note.trim() || null,
        }),
      });
      const json = (await res.json()) as { row?: SubmissionRow; error?: string };
      if (!res.ok || json.error || !json.row) throw new Error(json.error ?? 'Failed to create link');
      onCreated(json.row);
      toast.success('Onboarding link created');
    } catch (e) {
      toast.error(e instanceof Error ? e.message : 'Failed to create link');
    } finally {
      setBusy(false);
    }
  }

  // ── Load the department's checklist hires into their per-country boxes ──
  // Each hire carries its own Country (the checklist's Country column), so they
  // segregate automatically into the matching pay-plan box. A hire whose country
  // is blank/unrecognized routes to the optional fallback picker, or is skipped
  // (and reported) if no fallback is set. Emails dedupe against what's already
  // pasted; names ride along for invite_name.
  function loadFromChecklist() {
    const valid = checklistRows.filter((r) => isPlausibleEmail(r.email));
    if (valid.length === 0) {
      toast.error('No valid emails in the checklist for this department.');
      return;
    }
    const fallback = resolveOnboardingCountry(prefillCountry)?.name ?? '';

    // Dedupe by email (a person can appear once); bucket per resolved country.
    const byEmail = new Map<string, { name: string; email: string; country: string }>();
    for (const r of valid) {
      const key = r.email.toLowerCase();
      if (!byEmail.has(key)) byEmail.set(key, r);
    }
    const buckets: Record<string, string[]> = {};
    const names: Record<string, string> = {};
    let noCountry = 0;
    for (const r of byEmail.values()) {
      const email = r.email.toLowerCase();
      if (r.name) names[email] = r.name;
      const country = resolveOnboardingCountry(r.country)?.name ?? fallback;
      if (!country) { noCountry += 1; continue; }
      (buckets[country] ??= []).push(email);
    }

    const targets = Object.keys(buckets);
    if (targets.length === 0) {
      toast.error(
        'None of these hires have a country set — set their Country in the checklist, or pick a fallback country here.',
      );
      return;
    }

    setBulkByCountry((m) => {
      const next = { ...m };
      for (const [country, emails] of Object.entries(buckets)) {
        const existing = next[country] ?? '';
        const have = new Set(parseEmailList(existing).valid);
        const additions = emails.filter((e) => !have.has(e));
        next[country] = [existing.trim(), ...additions].filter(Boolean).join('\n');
      }
      return next;
    });
    setPrefillNames((prev) => ({ ...prev, ...names }));

    const loaded = targets.reduce((sum, c) => sum + buckets[c]!.length, 0);
    toast.success(
      `Loaded ${loaded} hire${loaded !== 1 ? 's' : ''} across ${targets.length} ` +
        `${targets.length === 1 ? 'country' : 'countries'}` +
        (noCountry > 0 ? ` — ${noCountry} skipped (no country)` : ''),
    );
  }

  // ── Bulk submit: create + send for every parsed row ──
  // Each row carries the country of the paste box it was pasted into, so a mixed
  // batch emails each hire the pay plan for their country.
  async function submitBulk() {
    if (parsedRows.length === 0) return;
    setBusy(true);
    setBulkProgress({ done: 0, total: parsedRows.length });
    setBulkResults(null);
    const results: BulkResult[] = [];

    for (let i = 0; i < parsedRows.length; i++) {
      const r = parsedRows[i]!;
      const e = r.email;
      try {
        // 1. Create submission
        const createRes = await fetch('/api/hr/onboarding-submissions', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            // Pre-address the invite with the checklist name when this email was
            // pulled from the New Hire Checklist; otherwise the hire types it.
            invite_name: prefillNames[e.toLowerCase()] ?? null,
            invite_personal_email: e,
            invite_department: dept.trim(),
            invite_country: r.country || null,
            invite_note: note.trim() || null,
          }),
        });
        const createJson = (await createRes.json()) as { row?: SubmissionRow; error?: string };
        if (!createRes.ok || createJson.error || !createJson.row) {
          throw new Error(createJson.error ?? 'Failed to create');
        }
        const rowId = createJson.row.id;

        // 2. Send the onboarding link immediately
        const sendRes = await fetch(`/api/hr/onboarding-submissions/${rowId}/send`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({}),
        });
        const sendJson = (await sendRes.json()) as { error?: string };
        if (!sendRes.ok || sendJson.error) {
          throw new Error(sendJson.error ?? 'Created but send failed');
        }

        results.push({ email: e, ok: true });
      } catch (err) {
        results.push({ email: e, ok: false, error: err instanceof Error ? err.message : String(err) });
      }
      setBulkProgress({ done: i + 1, total: parsedRows.length });
    }

    setBulkResults(results);
    setBusy(false);
    const sent = results.filter((r) => r.ok).length;
    const failed = results.length - sent;
    if (failed === 0) {
      toast.success(`${sent} onboarding link${sent !== 1 ? 's' : ''} sent`);
    } else {
      toast.warning(`${sent} sent, ${failed} failed — see results below`);
    }
    // Refresh the submissions list
    onCreated(results.find((r) => r.ok) ? { id: '' } as unknown as SubmissionRow : { id: '' } as unknown as SubmissionRow);
  }

  // ── Bulk results view (shown after generation) ──
  if (bulkResults) {
    const sent = bulkResults.filter((r) => r.ok).length;
    const failed = bulkResults.length - sent;
    return (
      <Dialog open={open} onOpenChange={(o) => !o && onClose()}>
        <DialogContent className="max-h-[92vh] overflow-y-auto sm:max-w-lg">
          <div className="-mx-6 -mt-6 mb-4 overflow-hidden rounded-t-lg border-b border-emerald-100/80 bg-gradient-to-br from-emerald-50 via-white to-teal-50/60 px-6 py-5 dark:border-emerald-950/40 dark:from-emerald-950/30 dark:via-zinc-950 dark:to-teal-950/20">
            <DialogHeader>
              <DialogTitle className="flex items-center gap-2.5 text-base font-semibold">
                <span className="flex h-8 w-8 shrink-0 items-center justify-center rounded-lg bg-gradient-to-br from-emerald-500 to-teal-700 text-white shadow-md shadow-emerald-600/25">
                  <Send className="h-4 w-4" />
                </span>
                Bulk send complete
              </DialogTitle>
              <p className="mt-1 text-[12px] text-zinc-500 dark:text-zinc-400">
                <span className="font-semibold text-emerald-700 dark:text-emerald-400">{sent} sent</span>
                {failed > 0 && <>, <span className="font-semibold text-rose-600 dark:text-rose-400">{failed} failed</span></>}
                {dept.trim() ? ` — ${dept.trim()}` : ''}
              </p>
            </DialogHeader>
          </div>
          <div className="max-h-72 overflow-y-auto rounded-xl border border-zinc-200 dark:border-zinc-800">
            {bulkResults.map((r) => (
              <div key={r.email} className={cn(
                'flex items-start gap-2.5 border-b px-3 py-2 text-xs last:border-b-0 dark:border-zinc-800',
                r.ok ? 'border-zinc-100' : 'border-rose-100 bg-rose-50/50 dark:border-rose-900/30 dark:bg-rose-950/20',
              )}>
                {r.ok
                  ? <CheckCircle2 className="mt-0.5 h-3.5 w-3.5 shrink-0 text-emerald-500" />
                  : <XCircle className="mt-0.5 h-3.5 w-3.5 shrink-0 text-rose-500" />}
                <div className="min-w-0">
                  <p className="truncate font-mono text-zinc-800 dark:text-zinc-200">{r.email}</p>
                  {r.error && <p className="text-rose-600 dark:text-rose-400">{r.error}</p>}
                </div>
              </div>
            ))}
          </div>
          <DialogFooter className="mt-4 gap-2 sm:gap-0">
            <Button size="sm" onClick={onClose}>Done</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    );
  }

  return (
    <Dialog open={open} onOpenChange={(o) => !o && onClose()}>
      <DialogContent
        className={cn(
          'max-h-[92vh] overflow-y-auto transition-[max-width] duration-300 ease-out',
          bulkMode ? 'sm:max-w-3xl' : 'sm:max-w-lg',
        )}
      >
        <div className="-mx-6 -mt-6 mb-1 overflow-hidden rounded-t-lg border-b border-emerald-100/80 bg-gradient-to-br from-emerald-50 via-white to-teal-50/60 px-6 py-5 dark:border-emerald-950/40 dark:from-emerald-950/30 dark:via-zinc-950 dark:to-teal-950/20">
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2.5 text-base font-semibold">
              <span className="flex h-8 w-8 shrink-0 items-center justify-center rounded-lg bg-gradient-to-br from-emerald-500 to-teal-700 text-white shadow-md shadow-emerald-600/25">
                <Link2 className="h-4 w-4" />
              </span>
              {bulkMode
                ? `Bulk onboarding${dept.trim() ? ` — ${dept.trim()}` : ''}`
                : 'Generate onboarding link'}
            </DialogTitle>
            <p className="mt-1.5 text-[12px] leading-relaxed text-zinc-600 dark:text-zinc-400">
              {bulkMode
                ? 'Paste personal emails into each country below. Every hire gets a one-time link sent immediately, carrying their country pay plan — they fill in their own name and sign the contracts on the form.'
                : 'Mint a one-time, no-SSO link. The new hire fills in their name, signs contracts, and submits payment details directly on the form.'}
            </p>
          </DialogHeader>
        </div>

        {/* Bulk-invite toggle — available for every department (auto-on for Lead Gen) */}
        <button
          type="button"
          role="switch"
          aria-checked={bulkMode}
          onClick={() => setBulkMode((v) => !v)}
          className={cn(
            'mt-1 flex w-full items-center justify-between gap-3 rounded-xl border px-3.5 py-2.5 text-left transition-colors',
            bulkMode
              ? 'border-emerald-300 bg-emerald-50/70 dark:border-emerald-800 dark:bg-emerald-950/30'
              : 'border-zinc-200 bg-white hover:border-zinc-300 dark:border-zinc-800 dark:bg-zinc-900/40 dark:hover:border-zinc-700',
          )}
        >
          <span className="flex items-center gap-2.5">
            <span
              className={cn(
                'flex h-8 w-8 shrink-0 items-center justify-center rounded-lg',
                bulkMode
                  ? 'bg-emerald-100 text-emerald-700 dark:bg-emerald-900/50 dark:text-emerald-300'
                  : 'bg-zinc-100 text-zinc-500 dark:bg-zinc-800 dark:text-zinc-400',
              )}
            >
              <Users className="h-4 w-4" />
            </span>
            <span className="min-w-0">
              <span className="block text-sm font-medium text-zinc-900 dark:text-zinc-100">
                Bulk invite
              </span>
              <span className="block text-[11px] text-zinc-500 dark:text-zinc-400">
                Send one-time links to many hires at once — paste a list.
              </span>
            </span>
          </span>
          <span
            className={cn(
              'relative inline-flex h-5 w-9 shrink-0 items-center rounded-full transition-colors',
              bulkMode ? 'bg-emerald-500' : 'bg-zinc-300 dark:bg-zinc-600',
            )}
          >
            <span
              className={cn(
                'inline-block h-4 w-4 transform rounded-full bg-white shadow transition-transform',
                bulkMode ? 'translate-x-4' : 'translate-x-0.5',
              )}
            />
          </span>
        </button>

        {/* Department + Country — always on top */}
        <DialogSection label="Where will they work?">
          <DialogField label="Department" hint={deptsLoading ? 'Loading…' : bulkMode ? 'Applied to every hire in this batch.' : 'Optional — helps HR sort submissions.'}>
            <DepartmentSelect
              value={dept}
              onChange={setDept}
              departments={departments}
              loading={deptsLoading}
            />
          </DialogField>
          {!bulkMode && (
            <DialogField
              label="Country"
              icon={<Globe className="h-3.5 w-3.5" />}
              hint="Picks the pay-plan PDF emailed with the invite (matched by department + country). Leave blank to send no pay plan."
            >
              <CountrySelect value={country} onChange={setCountry} />
            </DialogField>
          )}
        </DialogSection>

        {/* Smoothly ELONGATE on toggle: the outer wrapper animates its HEIGHT to
            the measured body height (the box grows/shrinks instead of snapping)
            while the modal width CSS-transitions in step; the inner keyed layer
            crossfades the swapped content. The footer lives OUTSIDE this clip so
            its full-bleed background isn't cut off. Dropdowns here are portaled,
            so overflow-hidden won't clip them. */}
        <motion.div
          initial={false}
          animate={{ height: bodyHeight ?? 'auto' }}
          transition={{ duration: reduceMotion ? 0 : 0.36, ease: [0.22, 1, 0.36, 1] }}
          className="-mx-1 overflow-hidden px-1"
        >
          <div ref={measureBody}>
            <motion.div
              key={bulkMode ? 'bulk' : 'single'}
              initial={reduceMotion ? false : { opacity: 0, y: 8 }}
              animate={{ opacity: 1, y: 0 }}
              transition={{ duration: reduceMotion ? 0 : 0.25, ease: [0.16, 1, 0.3, 1] }}
            >
        {bulkMode ? (
          /* ── Bulk mode (any department) ── */
          <>
            <DialogSection label="From New Hire Checklist">
              <div className="rounded-xl border border-emerald-200 bg-emerald-50/50 p-3 dark:border-emerald-800/50 dark:bg-emerald-950/20">
                {!dept.trim() ? (
                  <p className="flex items-center gap-2 text-[12px] leading-relaxed text-zinc-500 dark:text-zinc-400">
                    <ClipboardList className="h-4 w-4 shrink-0 text-emerald-500" />
                    Pick a department above to pull its <strong>next-week</strong> hires
                    {nextWeekStart ? <> (<span className="tabular-nums">{formatWeekLabel(nextWeekStart)}</span>)</> : null} straight from the New Hire Checklist.
                  </p>
                ) : (
                  <div className="space-y-2.5">
                    <p className="flex items-center gap-2 text-[12px] leading-relaxed text-zinc-700 dark:text-zinc-300">
                      <ClipboardList className="h-4 w-4 shrink-0 text-emerald-600 dark:text-emerald-400" />
                      {checklistLoading ? (
                        <>Checking next week&apos;s checklist for <strong>{dept.trim()}</strong>…</>
                      ) : checklistRows.length > 0 ? (
                        <>
                          <strong>{checklistRows.length}</strong> hire{checklistRows.length !== 1 ? 's' : ''} starting next week
                          {nextWeekStart ? <> (<span className="tabular-nums">{formatWeekLabel(nextWeekStart)}</span>)</> : null} for{' '}
                          <strong>{dept.trim()}</strong>.
                        </>
                      ) : (
                        <>No hires filed for <strong>{dept.trim()}</strong> next week
                          {nextWeekStart ? <> (<span className="tabular-nums">{formatWeekLabel(nextWeekStart)}</span>)</> : null} yet.</>
                      )}
                    </p>
                    {checklistRows.length > 0 && (
                      <>
                        <div className="flex flex-col gap-2 sm:flex-row sm:items-end">
                          <div className="flex-1">
                            <DialogField
                              label="Fallback country (optional)"
                              icon={<Globe className="h-3.5 w-3.5" />}
                              hint="Each hire routes by their own Country from the checklist. This only catches hires with no country set."
                            >
                              <CountrySelect value={prefillCountry} onChange={setPrefillCountry} />
                            </DialogField>
                          </div>
                          <Button
                            type="button"
                            size="sm"
                            onClick={loadFromChecklist}
                            disabled={busy}
                            className="h-9 shrink-0 gap-1.5 bg-emerald-600 text-white hover:bg-emerald-700 disabled:opacity-50"
                          >
                            <Plus className="h-3.5 w-3.5" />
                            Load {checklistRows.length} hire{checklistRows.length !== 1 ? 's' : ''}
                          </Button>
                        </div>
                        <p className="text-[11px] leading-relaxed text-zinc-500 dark:text-zinc-400">
                          Each hire drops into their own country&apos;s box below (from the checklist&apos;s Country column), deduped, with their name riding along.
                          {(() => {
                            const noCountry = checklistRows.filter((r) => !resolveOnboardingCountry(r.country)).length;
                            return noCountry > 0
                              ? ` ${noCountry} ${noCountry === 1 ? 'hire has' : 'hires have'} no country — set a fallback above to include ${noCountry === 1 ? 'it' : 'them'}.`
                              : '';
                          })()}
                        </p>
                      </>
                    )}
                  </div>
                )}
              </div>
            </DialogSection>

            <DialogSection label="Paste hires by country">
              <p className="-mt-1 text-[11px] leading-relaxed text-zinc-500 dark:text-zinc-400">
                Paste personal emails into the matching country — one per line (commas, tabs and spaces also work). Every email in a box is invited as that country, so there&apos;s no need to tag hires one-by-one.
              </p>

              {/* One paste box per country — the box IS the country picker */}
              <div className="grid grid-cols-1 gap-3 sm:grid-cols-3">
                {parsedByCountry.map((b) => (
                  <div
                    key={b.country}
                    className="flex flex-col overflow-hidden rounded-xl border border-zinc-200 bg-white dark:border-zinc-800 dark:bg-zinc-900/40"
                  >
                    <div className="flex items-center justify-between gap-2 border-b border-zinc-100 px-3 py-2 dark:border-zinc-800">
                      <span className="flex items-center gap-1.5 text-xs font-semibold text-zinc-800 dark:text-zinc-200">
                        <Globe className="h-3.5 w-3.5 text-emerald-500" />
                        {b.country}
                      </span>
                      <span className="rounded-full bg-zinc-100 px-1.5 py-0.5 text-[10px] font-medium text-zinc-500 dark:bg-zinc-800 dark:text-zinc-400">
                        {b.currency}
                      </span>
                    </div>
                    <textarea
                      value={bulkByCountry[b.country] ?? ''}
                      onChange={(e) =>
                        setBulkByCountry((m) => ({ ...m, [b.country]: e.target.value }))
                      }
                      placeholder={'jane@gmail.com\njohn@yahoo.com'}
                      rows={4}
                      disabled={busy}
                      className="w-full resize-y border-0 bg-transparent px-3 py-2 font-mono text-xs leading-relaxed outline-none transition-colors placeholder:text-zinc-400 focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-emerald-500/30 disabled:opacity-50 dark:placeholder:text-zinc-600"
                    />
                    <div className="flex items-center justify-between gap-2 border-t border-zinc-100 px-3 py-1.5 text-[11px] dark:border-zinc-800">
                      {b.emails.length > 0 ? (
                        <span className="font-medium text-emerald-700 dark:text-emerald-400">
                          ✓ {b.emails.length} hire{b.emails.length !== 1 ? 's' : ''}
                        </span>
                      ) : (
                        <span className="text-zinc-400">No emails yet</span>
                      )}
                      {b.invalid.length > 0 && (
                        <span className="text-amber-600 dark:text-amber-400">
                          ⚠ {b.invalid.length} skipped
                        </span>
                      )}
                    </div>
                  </div>
                ))}
              </div>

              {/* Batch summary + cross-box warnings */}
              {(parsedRows.length > 0 || invalidTokens.length > 0 || crossDupes.length > 0) && (
                <div className="flex flex-wrap items-center gap-x-4 gap-y-1 text-[11px]">
                  {parsedRows.length > 0 && (
                    <span className="font-semibold text-emerald-700 dark:text-emerald-400">
                      {parsedRows.length} hire{parsedRows.length !== 1 ? 's' : ''} ready to send
                    </span>
                  )}
                  {crossDupes.length > 0 && (
                    <span className="text-amber-600 dark:text-amber-400">
                      {crossDupes.length} in more than one country (see below)
                    </span>
                  )}
                  {invalidTokens.length > 0 && (
                    <span className="text-amber-600 dark:text-amber-400">
                      {invalidTokens.length} skipped (not valid emails)
                    </span>
                  )}
                </div>
              )}

              {crossDupes.length > 0 && (
                <div className="rounded-lg border border-amber-200/80 bg-amber-50/40 px-3 py-2 dark:border-amber-900/40 dark:bg-amber-950/20">
                  <p className="mb-1 text-[10px] font-semibold uppercase tracking-widest text-amber-600 dark:text-amber-400">In more than one country — kept as the first</p>
                  <div className="space-y-0.5">
                    {crossDupes.map((d) => (
                      <p key={d.email} className="font-mono text-[11px] text-amber-800 dark:text-amber-300">
                        {d.email}
                        {d.keptAs ? <span className="not-italic text-amber-600 dark:text-amber-400"> — kept as {d.keptAs}</span> : null}
                      </p>
                    ))}
                  </div>
                </div>
              )}

              {invalidTokens.length > 0 && (
                <div className="rounded-lg border border-amber-200/80 bg-amber-50/40 px-3 py-2 dark:border-amber-900/40 dark:bg-amber-950/20">
                  <p className="mb-1 text-[10px] font-semibold uppercase tracking-widest text-amber-600 dark:text-amber-400">Skipped</p>
                  <p className="font-mono text-[11px] text-amber-800 dark:text-amber-300">{invalidTokens.join(', ')}</p>
                </div>
              )}
            </DialogSection>

            <DialogSection label="Cover note" last>
              <DialogField label="Note for all hires (optional)" hint="Shown at the top of each form.">
                <textarea
                  value={note}
                  onChange={(e) => setNote(e.target.value)}
                  placeholder="Welcome! Please complete this form before your first day."
                  rows={2}
                  disabled={busy}
                  className="w-full rounded-lg border border-zinc-300 bg-transparent px-2.5 py-1.5 text-sm outline-none transition-colors placeholder:text-muted-foreground focus-visible:border-emerald-500 focus-visible:ring-2 focus-visible:ring-emerald-500/20 disabled:opacity-50 dark:border-input dark:bg-input/30"
                />
              </DialogField>
            </DialogSection>
          </>
        ) : (
          /* ── Single-hire mode ── */
          <>
            <DialogSection label="Who is this for?">
              <DialogField
                label="Personal email"
                icon={<Mail className="h-3 w-3" />}
                error={emailInvalid ? "Doesn't look like an email" : undefined}
                hint={!emailInvalid ? 'Used to pre-fill the send link. The hire enters their own name on the form.' : undefined}
              >
                <Input
                  type="email"
                  value={email}
                  onChange={(e) => setEmail(e.target.value)}
                  placeholder="jane@gmail.com"
                  aria-invalid={emailInvalid || undefined}
                />
              </DialogField>
            </DialogSection>

            <DialogSection label="Cover note" last>
              <DialogField label="Note for the new hire (optional)" hint="Shown at the top of their form.">
                <textarea
                  value={note}
                  onChange={(e) => setNote(e.target.value)}
                  placeholder="Welcome! Please complete this before your first day so payroll can set you up."
                  rows={3}
                  className="w-full rounded-lg border border-zinc-300 bg-transparent px-2.5 py-1.5 text-sm outline-none transition-colors placeholder:text-muted-foreground focus-visible:border-emerald-500 focus-visible:ring-2 focus-visible:ring-emerald-500/20 dark:border-input dark:bg-input/30"
                />
              </DialogField>
            </DialogSection>
          </>
        )}
            </motion.div>
          </div>
        </motion.div>

        {/* Unified footer — outside the height clip so its full-bleed bg shows */}
        <DialogFooter className="gap-2 pt-2 sm:gap-0">
          <Button variant="outline" size="sm" onClick={onClose} disabled={busy}>Cancel</Button>
          <Button
            size="sm"
            className="bg-gradient-to-br from-emerald-500 to-teal-700 text-white shadow-md shadow-emerald-600/25 hover:from-emerald-500 hover:to-teal-600 disabled:opacity-60"
            onClick={() => void (bulkMode ? submitBulk() : submitSingle())}
            disabled={busy || (bulkMode ? parsedRows.length === 0 : emailInvalid)}
          >
            {busy ? (
              <>
                <Loader2 className="mr-1.5 h-3.5 w-3.5 animate-spin" />
                {bulkMode
                  ? bulkProgress
                    ? `Sending ${bulkProgress.done} / ${bulkProgress.total}…`
                    : 'Working…'
                  : 'Generating…'}
              </>
            ) : (
              <>
                <Send className="mr-1.5 h-3.5 w-3.5" />
                {bulkMode
                  ? parsedRows.length > 0
                    ? `Generate & send ${parsedRows.length} link${parsedRows.length !== 1 ? 's' : ''}`
                    : 'Paste hires above'
                  : 'Generate link'}
              </>
            )}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

// --- Set-work-email dialog (mints @simple.biz + stages a pending hire) -----

function SetOnboardingWorkEmailDialog({
  row,
  onClose,
  onConverted,
}: {
  row: SubmissionRow | null;
  onClose: () => void;
  onConverted: () => void;
}) {
  const [departments, setDepartments] = useState<string[]>([]);
  const [deptsLoading, setDeptsLoading] = useState(false);
  const [deptRates, setDeptRates] = useState<Map<string, DeptRate>>(new Map());
  const [dept, setDept] = useState('');
  const [workEmail, setWorkEmail] = useState('');
  const [suggesting, setSuggesting] = useState(false);
  const [checking, setChecking] = useState(false);
  const [available, setAvailable] = useState<boolean | null>(null);
  // True when the address is free only because Workspace verify found no real
  // account (a stale prior claim) — shown as a reassuring hint.
  const [reclaimed, setReclaimed] = useState(false);
  const [busy, setBusy] = useState(false);
  // Compensation is owned by Accounting (Payment Catalog). HR never sees the
  // figures and the client never sends them — the server resolves the rate from
  // the catalog at submit time. We track only readiness (the checkmark).
  const [ratesRefreshing, setRatesRefreshing] = useState(false);
  const [projectNames, setProjectNames] = useState<string[]>([]);
  const [projectOptions, setProjectOptions] = useState<string[]>([]);
  const [projectsLoading, setProjectsLoading] = useState(false);

  const fullName = row?.full_name?.trim() || row?.invite_name?.trim() || '';
  // Prefer the hire's structured parts (reduced to the same tokens splitFullName
  // yields, so the suggested address is unchanged); fall back to splitting the
  // combined name for legacy rows.
  const { first, last } = useMemo(
    () =>
      derivationNameParts({
        first_name: row?.first_name,
        last_name: row?.last_name,
        full_name: fullName,
      }),
    [row?.first_name, row?.last_name, fullName],
  );

  // Ask the server for the next free address derived from the hire's name.
  const reSuggest = useCallback(async () => {
    if (!fullName) return;
    setSuggesting(true);
    try {
      const res = await fetch('/api/hr/work-email/suggest', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        // verify: reclaim an ideal address that's only locked by a stale prior
        // claim (no real Workspace account) instead of bumping to a variant.
        body: JSON.stringify({ fullName, verify: true }),
      });
      const j = (await res.json()) as {
        suggestion?: { email: string } | null;
        error?: string;
      };
      if (j.error) throw new Error(j.error);
      if (j.suggestion?.email) {
        setWorkEmail(j.suggestion.email);
        // Let the debounced useEffect run the real availability check —
        // don't blindly set available=true here.
        setAvailable(null);
      }
    } catch (e) {
      toast.error(e instanceof Error ? e.message : 'Could not suggest a work email');
    } finally {
      setSuggesting(false);
    }
  }, [fullName]);

  // Seed the form (and a fresh suggestion) whenever a row opens.
  useEffect(() => {
    if (!row) return;
    setDept(row.invite_department?.trim() ?? '');
    setWorkEmail('');
    setAvailable(null);
    setReclaimed(false);
    setProjectNames([]);
    void reSuggest();
  }, [row, reSuggest]);

  const removeProject = useCallback((name: string) => {
    setProjectNames((prev) => prev.filter((p) => p !== name));
  }, []);

  // Re-pull the Payment Catalog rates. Called on open, by the Refresh button,
  // and by the realtime subscription when Accounting saves a pay structure.
  const loadDeptRates = useCallback(async () => {
    setRatesRefreshing(true);
    try {
      const rj = (await fetch('/api/hr/department-rates', { cache: 'no-store' }).then((r) =>
        r.json(),
      )) as { departments?: Array<DeptRateApi>; error?: string };
      if (rj.error) throw new Error(rj.error);
      const m = new Map<string, DeptRate>();
      for (const d of rj.departments ?? []) {
        m.set(d.department.trim().toLowerCase(), { ready: d.ready });
      }
      setDeptRates(m);
    } catch (e) {
      toast.error(e instanceof Error ? e.message : 'Could not load compensation status');
    } finally {
      setRatesRefreshing(false);
    }
  }, []);

  // Department list (once) + initial compensation status when the dialog opens.
  useEffect(() => {
    if (!row) return;
    if (departments.length === 0 && !deptsLoading) {
      setDeptsLoading(true);
      fetch('/api/departments', { cache: 'no-store' })
        .then((r) => r.json())
        .then((dj: { departments?: string[]; error?: string }) => {
          if (dj.error) throw new Error(dj.error);
          setDepartments(dj.departments ?? []);
        })
        .catch((e) => toast.error(e instanceof Error ? e.message : 'Could not load departments'))
        .finally(() => setDeptsLoading(false));
    }
    void loadDeptRates();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [row, loadDeptRates]);

  // Live updates: when Accounting saves a Payment Catalog pay structure, re-pull
  // so the compensation checkmark flips without reopening the dialog.
  useEffect(() => {
    if (!row) return;
    const supabase = getSupabaseBrowserClient();
    if (!supabase) return;
    const channel = supabase
      .channel('onboarding-pay-structures-realtime')
      .on(
        'postgres_changes',
        { event: '*', schema: 'public', table: 'payment_catalog_pay_structures' },
        () => void loadDeptRates(),
      )
      .subscribe();
    return () => {
      void supabase.removeChannel(channel);
    };
  }, [row, loadDeptRates]);

  // Hubstaff project list — from the secondary Supabase `hubstaff_projects` table.
  useEffect(() => {
    if (!row) return;
    if (projectOptions.length > 0 || projectsLoading) return;
    setProjectsLoading(true);
    fetch('/api/secondary/hubstaff-projects', { cache: 'no-store' })
      .then((r) => r.json())
      .then((j: { projects?: Array<{ name?: string | null }>; error?: string }) => {
        if (j.error) throw new Error(j.error);
        const names = (j.projects ?? [])
          .map((p) => (p?.name ?? '').trim())
          .filter(Boolean);
        setProjectOptions(Array.from(new Set(names)));
      })
      .catch((e) =>
        toast.error(e instanceof Error ? e.message : 'Could not load projects'),
      )
      .finally(() => setProjectsLoading(false));
  }, [row, projectOptions.length, projectsLoading]);

  // Debounced availability check as HR edits the address.
  useEffect(() => {
    if (!row) return;
    const email = workEmail.trim().toLowerCase();
    if (!email) {
      setAvailable(null);
      setReclaimed(false);
      setChecking(false);
      return;
    }
    let active = true;
    setChecking(true);
    const t = setTimeout(async () => {
      try {
        const res = await fetch('/api/hr/work-email/suggest', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          // verify: a roster-taken address with no real Workspace account is
          // freed up (stale claim), so a previously-burned address is usable.
          body: JSON.stringify({ candidate: email, verify: true }),
        });
        const j = (await res.json()) as {
          candidate?: { available: boolean; verifiedFree?: boolean } | null;
        };
        if (active) {
          setAvailable(j.candidate ? j.candidate.available : null);
          setReclaimed(!!j.candidate?.verifiedFree);
        }
      } catch {
        if (active) {
          setAvailable(null);
          setReclaimed(false);
        }
      } finally {
        if (active) setChecking(false);
      }
    }, 350);
    return () => {
      active = false;
      clearTimeout(t);
    };
  }, [workEmail, row]);

  const emailNorm = workEmail.trim().toLowerCase();
  const emailValid = isPlausibleEmail(emailNorm) && emailNorm.endsWith('@simple.biz');
  const deptKey = dept.trim().toLowerCase();
  const deptRate = deptKey ? deptRates.get(deptKey) : undefined;
  // HR never sees the figures — only whether Accounting has set an authoritative
  // Payment Catalog rate for this department. That readiness gates save.
  const compReady = deptRate?.ready ?? false;
  // Compensation readiness is informational only — a hire can be staged before
  // Accounting sets the Payment Catalog (the rate stays null until they do).
  const canSave =
    !!row &&
    !busy &&
    emailValid &&
    available === true &&
    dept.trim().length > 0 &&
    projectNames.length > 0;

  async function save() {
    if (!row) return;
    setBusy(true);
    try {
      const res = await fetch(
        `/api/hr/onboarding-submissions/${row.id}/set-work-email`,
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            work_email: emailNorm,
            department: dept.trim(),
            project_names: projectNames,
          }),
        },
      );
      const json = (await res.json()) as {
        ok?: boolean;
        error?: string;
        workspace_account?: { ok?: boolean; error?: string };
      };
      if (!res.ok || json.error) throw new Error(json.error ?? 'Failed to set work email');
      if (json.workspace_account && json.workspace_account.ok === false) {
        toast.warning(`${emailNorm} staged — account creation failed`, {
          description: json.workspace_account.error
            ? `${json.workspace_account.error}. Create the Workspace account and Hubstaff invite manually.`
            : 'The onboarding webhook did not fire. Create the Workspace account and Hubstaff invite manually.',
        });
      } else {
        toast.success(
          row.pending_employee_id ? `${emailNorm} updated` : `${emailNorm} assigned`,
          {
            description: row.pending_employee_id
              ? 'Pending hire updated. Workspace account + Hubstaff invite re-sent.'
              : 'Staged in Pending Hires. Workspace account + Hubstaff invite requested.',
          },
        );
      }
      onConverted();
    } catch (e) {
      toast.error(e instanceof Error ? e.message : 'Failed to set work email');
    } finally {
      setBusy(false);
    }
  }

  if (!row) return null;

  return (
    <Dialog open={!!row} onOpenChange={(o) => !o && onClose()}>
      <DialogContent className="max-h-[92vh] overflow-y-auto sm:max-w-3xl">
        {/* Header */}
        <div className="-mx-6 -mt-6 mb-4 overflow-hidden rounded-t-lg border-b border-emerald-100/80 bg-gradient-to-br from-emerald-50 via-white to-teal-50/60 px-6 py-5 dark:border-emerald-950/40 dark:from-emerald-950/30 dark:via-zinc-950 dark:to-teal-950/20">
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2.5 text-base font-semibold">
              <span className="flex h-8 w-8 shrink-0 items-center justify-center rounded-lg bg-gradient-to-br from-emerald-500 to-teal-700 text-white shadow-md shadow-emerald-600/25">
                <Mail className="h-4 w-4" />
              </span>
              Set work email
            </DialogTitle>
            <p className="mt-1 text-[12px] leading-relaxed text-zinc-500 dark:text-zinc-400">
              Suggest an @simple.biz address, pick department and projects, then save to stage in Pending Hires.
            </p>
          </DialogHeader>
        </div>

        {/* Two-column body */}
        <div className="grid gap-x-6 gap-y-4 sm:grid-cols-2">

          {/* ── Left column: identity + department + work email ── */}
          <div className="flex flex-col gap-4">

            {/* New hire info */}
            <div className="flex flex-col gap-1.5">
              <p className="text-[10px] font-semibold uppercase tracking-widest text-zinc-400 dark:text-zinc-500">New hire</p>
              <div className="flex flex-wrap items-center gap-x-2 gap-y-1.5 text-xs">
                <span className="inline-flex items-center gap-1.5 rounded-full border border-emerald-100 bg-emerald-50/60 px-2 py-0.5 text-emerald-900 dark:border-emerald-900/40 dark:bg-emerald-950/40 dark:text-emerald-200">
                  <User className="h-3 w-3 shrink-0" />
                  {fullName || '(no name)'}
                </span>
                {(row.email || row.invite_personal_email) && (
                  <span className="inline-flex items-center gap-1.5 rounded-full border border-zinc-200 bg-zinc-50 px-2 py-0.5 font-mono text-zinc-700 dark:border-zinc-700 dark:bg-zinc-900 dark:text-zinc-300">
                    <Mail className="h-3 w-3 shrink-0" />
                    {row.email ?? row.invite_personal_email}
                  </span>
                )}
              </div>
              {(first || last) && (
                <p className="text-[11px] text-zinc-400 dark:text-zinc-500">
                  First <span className="font-medium text-zinc-600 dark:text-zinc-300">{first || '-'}</span>
                  {' · '}last <span className="font-medium text-zinc-600 dark:text-zinc-300">{last || '-'}</span>
                </p>
              )}
            </div>

            {/* Department */}
            <div className="flex flex-col gap-1.5">
              <p className="text-[10px] font-semibold uppercase tracking-widest text-zinc-400 dark:text-zinc-500">Department</p>
              <DepartmentSelect
                value={dept}
                onChange={setDept}
                departments={departments}
                loading={deptsLoading}
              />
              <p className="text-[11px] text-zinc-400 dark:text-zinc-500">
                {deptsLoading ? 'Loading…' : 'Required — carried into the staged hire.'}
              </p>
            </div>

            {/* Work email */}
            <div className="flex flex-col gap-1.5">
              <p className="text-[10px] font-semibold uppercase tracking-widest text-zinc-400 dark:text-zinc-500">Work email</p>
              <div className="relative">
                <Input
                  value={workEmail}
                  onChange={(e) => setWorkEmail(e.target.value)}
                  placeholder={suggesting ? 'Suggesting...' : 'namel@simple.biz'}
                  className="pr-9 font-mono"
                  spellCheck={false}
                  autoCapitalize="none"
                />
                <span className="pointer-events-none absolute right-2.5 top-1/2 -translate-y-1/2">
                  {suggesting || checking ? (
                    <Loader2 className="h-4 w-4 animate-spin text-zinc-400" />
                  ) : available === true ? (
                    <CheckCircle2 className="h-4 w-4 text-emerald-500" />
                  ) : available === false ? (
                    <XCircle className="h-4 w-4 text-rose-500" />
                  ) : null}
                </span>
              </div>
              <div className="flex items-center justify-between gap-2">
                <p className={cn(
                  'text-[11px]',
                  available === false ? 'text-rose-600 dark:text-rose-400'
                    : available === true ? 'text-emerald-600 dark:text-emerald-400'
                    : 'text-zinc-400',
                )}>
                  {available === false
                    ? 'Already in use — try another.'
                    : available === true
                      ? reclaimed
                        ? 'Available — was claimed before but has no Workspace account.'
                        : 'Available.'
                      : emailNorm && !emailValid
                        ? 'Must be a valid @simple.biz address.'
                        : 'Checking availability as you type.'}
                </p>
                <button
                  type="button"
                  onClick={() => void reSuggest()}
                  className="inline-flex items-center gap-1 text-[11px] font-medium text-emerald-700 hover:underline disabled:opacity-50 dark:text-emerald-300"
                  disabled={suggesting || !fullName}
                >
                  <Wand2 className="h-3 w-3" /> Suggest
                </button>
              </div>
            </div>

          </div>

          {/* ── Right column: rates + projects ── */}
          <div className="flex flex-col gap-4">

            {/* Compensation — owned by Accounting via the Payment Catalog. HR
                only sees whether it's ready, never the figures. Updates live and
                a Refresh button re-checks on demand. */}
            <div className="flex flex-col gap-1.5">
              <div className="flex items-center justify-between">
                <p className="text-[10px] font-semibold uppercase tracking-widest text-zinc-400 dark:text-zinc-500">Compensation</p>
                <button
                  type="button"
                  onClick={() => void loadDeptRates()}
                  disabled={ratesRefreshing}
                  className="inline-flex items-center gap-1 text-[11px] font-medium text-emerald-700 hover:underline disabled:opacity-50 dark:text-emerald-300"
                  title="Re-check whether Accounting has set this department's pay in the Payment Catalog"
                >
                  <RefreshCw className={cn('h-3 w-3', ratesRefreshing && 'animate-spin')} />
                  Refresh
                </button>
              </div>
              {!deptKey ? (
                <div className="rounded-lg border border-zinc-200 bg-zinc-50 px-3 py-2.5 text-[11px] text-zinc-500 dark:border-zinc-800 dark:bg-zinc-900/40">
                  Pick a department to check its compensation.
                </div>
              ) : compReady ? (
                <div className="flex items-center gap-2 rounded-lg border border-emerald-200 bg-emerald-50/70 px-3 py-2.5 text-xs font-medium text-emerald-800 dark:border-emerald-900/50 dark:bg-emerald-950/25 dark:text-emerald-200">
                  <CheckCircle2 className="h-4 w-4 shrink-0" />
                  Compensation ready — set by Accounting in the Payment Catalog.
                </div>
              ) : (
                <div className="flex items-start gap-2 rounded-lg border border-amber-200 bg-amber-50/70 px-3 py-2.5 text-xs font-medium text-amber-800 dark:border-amber-900/50 dark:bg-amber-950/25 dark:text-amber-200">
                  <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0" />
                  <span>
                    Not set yet — Accounting will set this department's pay in the Payment Catalog.
                    You can still stage the hire now; pay applies once they set it. Use Refresh to re-check.
                  </span>
                </div>
              )}
            </div>

            {/* Projects — takes all remaining space so the dropdown opens downward with room */}
            <div className="flex flex-1 flex-col gap-1.5">
              <p className="text-[10px] font-semibold uppercase tracking-widest text-zinc-400 dark:text-zinc-500">Hubstaff project(s)</p>
              <ProjectMultiSelect
                selected={projectNames}
                onChange={setProjectNames}
                options={projectOptions}
                loading={projectsLoading}
              />
              <p className="text-[11px] text-zinc-400 dark:text-zinc-500">
                Required — the hire is invited to these projects when the workspace account is created.
              </p>
              {projectNames.length > 0 && (
                <div className="mt-1 flex flex-wrap gap-1.5">
                  {projectNames.map((p) => (
                    <span
                      key={p}
                      className="inline-flex items-center gap-1 rounded-full border border-emerald-200 bg-emerald-50/70 px-2 py-0.5 text-[11px] font-medium text-emerald-900 dark:border-emerald-900/40 dark:bg-emerald-950/40 dark:text-emerald-200"
                    >
                      {p}
                      <button
                        type="button"
                        onClick={() => removeProject(p)}
                        className="text-emerald-600 hover:text-emerald-800 dark:text-emerald-400"
                        aria-label={`Remove ${p}`}
                      >
                        <XCircle className="h-3.5 w-3.5" />
                      </button>
                    </span>
                  ))}
                </div>
              )}
            </div>

          </div>
        </div>

        <DialogFooter className="mt-4 gap-2 border-t border-zinc-100 pt-4 sm:gap-0 dark:border-zinc-800">
          <Button variant="outline" size="sm" onClick={onClose} disabled={busy}>
            Cancel
          </Button>
          <Button
            size="sm"
            className="bg-gradient-to-br from-emerald-500 to-teal-700 text-white shadow-md shadow-emerald-600/25 hover:from-emerald-500 hover:to-teal-600"
            onClick={() => void save()}
            disabled={!canSave}
          >
            {busy ? (
              <Loader2 className="mr-1 h-3.5 w-3.5 animate-spin" />
            ) : (
              <UserCheck className="mr-1 h-3.5 w-3.5" />
            )}
            {busy ? 'Saving...' : 'Save and stage hire'}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

// --- Bulk set-work-email dialog (grouped by department) -------------------

type BulkDeptRate = DeptRate;

/**
 * Mints @simple.biz addresses for a batch of SUBMITTED hires at once. The
 * batch is grouped by department; each department is set on its own (shared
 * rate + projects for the group, a unique auto-suggested address per person),
 * so there is never a single action spanning every department. Reuses the
 * per-submission set-work-email route once per hire.
 */
function BulkSetWorkEmailDialog({
  rows,
  onClose,
  reload,
}: {
  rows: SubmissionRow[] | null;
  onClose: () => void;
  reload: () => void;
}) {
  const open = !!rows && rows.length > 0;

  const [departments, setDepartments] = useState<string[]>([]);
  const [deptRates, setDeptRates] = useState<Map<string, BulkDeptRate>>(new Map());
  const [projectOptions, setProjectOptions] = useState<string[]>([]);
  const [metaLoading, setMetaLoading] = useState(false);
  const [ratesRefreshing, setRatesRefreshing] = useState(false);

  // Email state lives at the parent so duplicate detection spans the whole
  // batch (across departments), not just one group.
  const [emails, setEmails] = useState<Record<string, string>>({});
  const [avail, setAvail] = useState<Record<string, boolean | null>>({});
  const [suggesting, setSuggesting] = useState(false);
  const [doneIds, setDoneIds] = useState<Set<string>>(new Set());
  // `warn` = the work email was saved but the workspace automation failed; the
  // hire is staged but not provisioned, so the table will flag it for a retry.
  // `verify` = result of the read-only Workspace lookup run after setting.
  const [results, setResults] = useState<
    Record<string, { ok: boolean; warn?: boolean; error?: string; verify?: 'exists' | 'missing' | 'error' }>
  >({});
  const [groupBusy, setGroupBusy] = useState<Record<string, boolean>>({});
  const [groupProgress, setGroupProgress] = useState<
    Record<string, { done: number; total: number; phase?: 'set' | 'verify' } | null>
  >({});
  const [licenseInfo, setLicenseInfo] = useState<{
    available_licenses: number | null;
    total_licenses: number | null;
    last_updated: string | null;
    note?: string;
    error?: string;
  } | null>(null);
  const scrollContainerRef = useRef<HTMLDivElement>(null);

  // Re-pull the license meter — called on open and after a set consumes seats,
  // so the "available" count reflects the newly-provisioned accounts.
  const refreshLicenseInfo = useCallback(() => {
    fetch('/api/hr/workspace-license-info', { cache: 'no-store' })
      .then((r) => r.json())
      .then((j) => setLicenseInfo(j))
      .catch(() =>
        setLicenseInfo({
          available_licenses: null,
          total_licenses: null,
          last_updated: null,
          error: 'Could not fetch license info',
        }),
      );
  }, []);

  // Pin the modal to the top when it opens. A single scrollTop reset isn't
  // enough: Radix auto-focuses an element on open (often a button near the
  // bottom) which scrolls it into view, and async content (license info,
  // grouped rows) lays out after the effect runs. Reset across two animation
  // frames so we win after focus + layout settle.
  useEffect(() => {
    if (!open) return;
    const reset = () => {
      if (scrollContainerRef.current) scrollContainerRef.current.scrollTop = 0;
    };
    reset();
    const r1 = requestAnimationFrame(() => {
      reset();
      requestAnimationFrame(reset);
    });
    return () => cancelAnimationFrame(r1);
  }, [open]);

  // Group rows by submission department; blank departments fall into a single
  // bucket that forces HR to pick one before that group can be set.
  const groups = useMemo(() => {
    const m = new Map<string, { dept: string; rows: SubmissionRow[] }>();
    for (const r of rows ?? []) {
      const dept = (r.invite_department ?? '').trim();
      const key = dept.toLowerCase() || '__none__';
      const g = m.get(key) ?? { dept, rows: [] };
      g.rows.push(r);
      m.set(key, g);
    }
    return [...m.entries()].map(([key, v]) => ({ key, dept: v.dept, rows: v.rows }));
  }, [rows]);

  // Re-pull the Payment Catalog rates (compensation status). Called on open, by
  // the Refresh button, and by realtime when Accounting saves a pay structure.
  const loadDeptRates = useCallback(async () => {
    setRatesRefreshing(true);
    try {
      const rj = (await fetch('/api/hr/department-rates', { cache: 'no-store' }).then((r) =>
        r.json(),
      )) as { departments?: Array<DeptRateApi>; error?: string };
      if (rj.error) throw new Error(rj.error);
      const m = new Map<string, BulkDeptRate>();
      for (const d of rj.departments ?? []) {
        m.set(d.department.trim().toLowerCase(), { ready: d.ready });
      }
      setDeptRates(m);
    } catch (e) {
      toast.error(e instanceof Error ? e.message : 'Could not load compensation status');
    } finally {
      setRatesRefreshing(false);
    }
  }, []);

  // Load shared setup data (departments, Hubstaff projects) + compensation.
  useEffect(() => {
    if (!open) return;
    setMetaLoading(true);
    Promise.all([
      fetch('/api/departments', { cache: 'no-store' }).then((r) => r.json()),
      fetch('/api/secondary/hubstaff-projects', { cache: 'no-store' }).then((r) => r.json()),
    ])
      .then(
        ([dj, pj]: [
          { departments?: string[]; error?: string },
          { projects?: Array<{ name?: string | null }>; error?: string },
        ]) => {
          setDepartments(dj.departments ?? []);
          const names = (pj.projects ?? [])
            .map((p) => (p?.name ?? '').trim())
            .filter(Boolean);
          setProjectOptions(Array.from(new Set(names)));
        },
      )
      .catch((e) => toast.error(e instanceof Error ? e.message : 'Could not load setup data'))
      .finally(() => setMetaLoading(false));
    void loadDeptRates();
    refreshLicenseInfo();
  }, [open, loadDeptRates, refreshLicenseInfo]);

  // Live: flip the compensation checkmarks when Accounting saves a pay structure.
  useEffect(() => {
    if (!open) return;
    const supabase = getSupabaseBrowserClient();
    if (!supabase) return;
    const channel = supabase
      .channel('bulk-onboarding-pay-structures-realtime')
      .on(
        'postgres_changes',
        { event: '*', schema: 'public', table: 'payment_catalog_pay_structures' },
        () => void loadDeptRates(),
      )
      .subscribe();
    return () => {
      void supabase.removeChannel(channel);
    };
  }, [open, loadDeptRates]);

  // Auto-suggest a UNIQUE @simple.biz address for every hire when the modal
  // opens. Runs sequentially, threading the addresses already assigned earlier
  // in the batch through `also_taken`, so two same-named hires never collide on
  // the same suggestion. A hire who already has a work email keeps it; only a
  // CONFIRMED account starts "done". A minted-but-failed / unverified address
  // stays settable so HR can bulk-retry provisioning (re-setting the same
  // address is allowed and auto-verifies server-side).
  useEffect(() => {
    if (!open || !rows) return;
    let cancelled = false;
    (async () => {
      setSuggesting(true);
      setResults({});
      setGroupBusy({});
      setGroupProgress({});
      const assigned: string[] = [];
      const nextEmails: Record<string, string> = {};
      const nextAvail: Record<string, boolean | null> = {};
      const initialDone = new Set<string>();
      for (const r of rows) {
        if (cancelled) return;
        if (r.work_email) {
          nextEmails[r.id] = r.work_email;
          nextAvail[r.id] = true;
          // Only a confirmed account is "done"; failed/unverified rows stay
          // settable so they can be bulk-retried.
          if (r.workspace_account_ok === true) initialDone.add(r.id);
          assigned.push(r.work_email.toLowerCase());
          continue;
        }
        const fullName = r.full_name?.trim() || r.invite_name?.trim() || '';
        if (!fullName) {
          nextEmails[r.id] = '';
          nextAvail[r.id] = null;
          continue;
        }
        try {
          const res = await fetch('/api/hr/work-email/suggest', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ fullName, also_taken: assigned }),
          });
          const j = (await res.json()) as { suggestion?: { email: string } | null };
          const email = j.suggestion?.email ?? '';
          nextEmails[r.id] = email;
          nextAvail[r.id] = email ? true : null;
          if (email) assigned.push(email.toLowerCase());
        } catch {
          nextEmails[r.id] = '';
          nextAvail[r.id] = null;
        }
      }
      if (!cancelled) {
        setEmails(nextEmails);
        setAvail(nextAvail);
        setDoneIds(initialDone);
        setSuggesting(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [open, rows]);

  // Duplicate detection across the WHOLE batch (every department).
  const dupIds = useMemo(() => {
    const byEmail = new Map<string, string[]>();
    for (const [id, raw] of Object.entries(emails)) {
      const e = raw.trim().toLowerCase();
      if (!e) continue;
      const arr = byEmail.get(e) ?? [];
      arr.push(id);
      byEmail.set(e, arr);
    }
    const dups = new Set<string>();
    for (const arr of byEmail.values()) {
      if (arr.length > 1) for (const id of arr) dups.add(id);
    }
    return dups;
  }, [emails]);

  const setEmail = useCallback((id: string, v: string) => {
    setEmails((p) => ({ ...p, [id]: v }));
  }, []);
  const setAvailOne = useCallback((id: string, v: boolean | null) => {
    setAvail((p) => (p[id] === v ? p : { ...p, [id]: v }));
  }, []);

  async function runGroup(
    groupKey: string,
    args: {
      rows: SubmissionRow[];
      department: string;
      projects: string[];
    },
  ) {
    const { rows: targets, department, projects } = args;
    setGroupBusy((p) => ({ ...p, [groupKey]: true }));

    const newResults: Record<string, { ok: boolean; warn?: boolean; error?: string }> = {};
    const succeeded: string[] = [];
    let automationFailed = 0;

    // ── Phase 1: set work email for the rows that still need one. ──
    if (targets.length > 0) {
      setGroupProgress((p) => ({ ...p, [groupKey]: { done: 0, total: targets.length, phase: 'set' } }));
      let done = 0;
      // 5 concurrent max — each hire fires the workspace-account creation webhook.
      await runPooled(targets, 5, async (r) => {
        try {
          const res = await fetch(`/api/hr/onboarding-submissions/${r.id}/set-work-email`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
              work_email: (emails[r.id] ?? '').trim().toLowerCase(),
              department,
              project_names: projects,
            }),
          });
          const j = (await res.json().catch(() => ({}))) as {
            ok?: boolean;
            error?: string;
            workspace_account?: { ok?: boolean; error?: string };
          };
          if (!res.ok || j.error) throw new Error(j.error ?? 'Failed to set work email');
          // The email saved, but the workspace webhook may still have failed —
          // the verify pass below will sort the truth (e.g. "already exists").
          const wsFailed = j.workspace_account ? j.workspace_account.ok === false : false;
          if (wsFailed) automationFailed += 1;
          newResults[r.id] = wsFailed
            ? {
                ok: true,
                warn: true,
                error: j.workspace_account?.error ?? 'Workspace automation failed - verifying...',
              }
            : { ok: true };
          succeeded.push(r.id);
        } catch (e) {
          newResults[r.id] = { ok: false, error: e instanceof Error ? e.message : String(e) };
        } finally {
          done += 1;
          setGroupProgress((p) => ({ ...p, [groupKey]: { done, total: targets.length, phase: 'set' } }));
        }
      });
      setResults((p) => ({ ...p, ...newResults }));
      if (succeeded.length > 0) {
        setDoneIds((p) => {
          const n = new Set(p);
          for (const id of succeeded) n.add(id);
          return n;
        });
      }
    }

    // ── Phase 2: verify the accounts that aren't confirmed yet — the ones just
    // set whose create webhook failed (often "already exists") PLUS any row that
    // already had an address but was never verified. Read-only; never recreates. ──
    const group = groups.find((g) => g.key === groupKey);
    const groupRows = group?.rows ?? targets;
    const verifyTargets = groupRows.filter((r) => {
      const created = newResults[r.id];
      // Freshly created + confirmed by the create webhook -> already green.
      if (created && created.ok && !created.warn) return false;
      // Need an address to verify (pre-existing, or just saved this run).
      if (!r.work_email && !succeeded.includes(r.id)) return false;
      // Pre-existing row that's already confirmed -> nothing to do.
      if (!created && r.workspace_account_ok === true) return false;
      return true;
    });

    let vExists = 0;
    let vMissing = 0;
    let vError = 0;
    if (verifyTargets.length > 0) {
      setGroupProgress((p) => ({ ...p, [groupKey]: { done: 0, total: verifyTargets.length, phase: 'verify' } }));
      let vdone = 0;
      await runPooled(verifyTargets, 5, async (r) => {
        let state: 'exists' | 'missing' | 'error' = 'error';
        try {
          const res = await fetch(`/api/hr/onboarding-submissions/${r.id}/verify-work-email`, {
            method: 'POST',
          });
          const j = (await res.json().catch(() => ({}))) as { state?: 'exists' | 'missing' | 'error' };
          state = res.ok ? (j.state ?? 'error') : 'error';
        } catch {
          state = 'error';
        }
        if (state === 'exists') vExists += 1;
        else if (state === 'missing') vMissing += 1;
        else vError += 1;
        setResults((p) => ({ ...p, [r.id]: { ...(p[r.id] ?? { ok: true }), verify: state } }));
        vdone += 1;
        setGroupProgress((p) => ({ ...p, [groupKey]: { done: vdone, total: verifyTargets.length, phase: 'verify' } }));
      });
      // Mark verified rows processed so they leave the pending set.
      setDoneIds((p) => {
        const n = new Set(p);
        for (const r of verifyTargets) n.add(r.id);
        return n;
      });
    }

    setGroupBusy((p) => ({ ...p, [groupKey]: false }));
    setGroupProgress((p) => ({ ...p, [groupKey]: null }));
    if (succeeded.length > 0 || verifyTargets.length > 0) reload();
    // Seats just got consumed — refresh the license meter so "available" drops.
    if (succeeded.length > 0) refreshLicenseInfo();

    // ── Toasts ──
    const label = department || 'department';
    if (targets.length > 0) {
      const ok = succeeded.length;
      const failed = targets.length - ok;
      if (ok > 0 && failed === 0) {
        toast.success(`${ok} work email${ok === 1 ? '' : 's'} set for ${label}`);
      } else if (ok > 0) {
        toast.warning(`${label}: ${ok} set, ${failed} failed - check and retry`);
      } else {
        toast.error(`${label}: ${failed} failed - check and retry`);
      }
    }
    if (verifyTargets.length > 0) {
      if (vMissing === 0 && vError === 0) {
        toast.success(`${vExists} account${vExists === 1 ? '' : 's'} verified for ${label}`);
      } else {
        toast.warning(
          `${label} verify: ${vExists} confirmed, ${vMissing} not found${vError > 0 ? `, ${vError} unchecked` : ''} - retry the not-found from the table`,
        );
      }
    }
  }

  const totalRows = rows?.length ?? 0;
  const allDone = totalRows > 0 && doneIds.size >= totalRows;

  if (!open) return null;

  return (
    <Dialog open={open} onOpenChange={(o) => !o && onClose()}>
      <DialogContent
        ref={scrollContainerRef}
        // Focus the popup root (top) instead of letting Base UI focus the first
        // focusable control, which can be below the fold and scroll the modal
        // down on open. The rAF reset in the open effect is the backstop.
        initialFocus={scrollContainerRef}
        className="max-h-[92vh] overflow-y-auto sm:max-w-3xl"
      >
        <div className="-mx-6 -mt-6 mb-4 overflow-hidden rounded-t-lg border-b border-emerald-100/80 bg-gradient-to-br from-emerald-50 via-white to-teal-50/60 px-6 py-5 dark:border-emerald-950/40 dark:from-emerald-950/30 dark:via-zinc-950 dark:to-teal-950/20">
          <div className="flex items-start gap-4">
            <div className="flex-1 min-w-0">
              <DialogHeader>
                <DialogTitle className="flex items-center gap-2.5 text-base font-semibold">
                  <span className="flex h-8 w-8 shrink-0 items-center justify-center rounded-lg bg-gradient-to-br from-emerald-500 to-teal-700 text-white shadow-md shadow-emerald-600/25">
                    <Mail className="h-4 w-4" />
                  </span>
                  Set work emails
                </DialogTitle>
                <p className="mt-1 text-[12px] leading-relaxed text-zinc-500 dark:text-zinc-400">
                  {totalRows} submitted {totalRows === 1 ? 'hire' : 'hires'}, grouped by department.
                  Each address is auto-suggested and unique - review them, then set each department on
                  its own.
                </p>
              </DialogHeader>
            </div>
            {licenseInfo && (
              <div className={'shrink-0 rounded-lg border px-3 py-2.5 text-xs w-56 ' + (licenseInfo.available_licenses === null ? 'border-amber-200/60 bg-amber-50/60 dark:border-amber-900/40 dark:bg-amber-950/20' : licenseInfo.available_licenses === 0 ? 'border-red-200/60 bg-red-50/60 dark:border-red-900/40 dark:bg-red-950/20' : licenseInfo.available_licenses <= 2 ? 'border-orange-200/60 bg-orange-50/60 dark:border-orange-900/40 dark:bg-orange-950/20' : 'border-emerald-200/60 bg-emerald-50/60 dark:border-emerald-900/40 dark:bg-emerald-950/20')}>
                <div className="mb-2 flex items-center gap-1.5 font-medium text-xs">
                  {licenseInfo.available_licenses === null && <AlertTriangle className="h-3.5 w-3.5 text-amber-600 dark:text-amber-400" />}
                  {licenseInfo.available_licenses === 0 && <XCircle className="h-3.5 w-3.5 text-red-600 dark:text-red-400" />}
                  {licenseInfo.available_licenses && licenseInfo.available_licenses <= 2 && <AlertTriangle className="h-3.5 w-3.5 text-orange-600 dark:text-orange-400" />}
                  {licenseInfo.available_licenses && licenseInfo.available_licenses > 2 && <CheckCircle2 className="h-3.5 w-3.5 text-emerald-600 dark:text-emerald-400" />}
                  <span className={licenseInfo.available_licenses === null ? 'text-amber-900 dark:text-amber-100' : licenseInfo.available_licenses === 0 ? 'text-red-900 dark:text-red-100' : licenseInfo.available_licenses <= 2 ? 'text-orange-900 dark:text-orange-100' : 'text-emerald-900 dark:text-emerald-100'}>
                    Licenses
                  </span>
                </div>
                {licenseInfo.available_licenses !== null && licenseInfo.total_licenses && (
                  <div>
                    <div className="mb-2">
                      <div className="flex items-baseline gap-1">
                        <strong className="text-2xl font-bold text-zinc-900 dark:text-zinc-100">{licenseInfo.available_licenses}</strong>
                        <span className="text-xs text-zinc-600 dark:text-zinc-400">/ {licenseInfo.total_licenses}</span>
                      </div>
                      <div className="mt-1 text-[10px] text-zinc-500 dark:text-zinc-500">
                        {licenseInfo.total_licenses - licenseInfo.available_licenses} assigned
                      </div>
                    </div>
                    <div className="h-2 w-full overflow-hidden rounded-full bg-zinc-300 dark:bg-zinc-600">
                      <div
                        className={licenseInfo.available_licenses === 0 ? 'h-full bg-red-500 dark:bg-red-600' : licenseInfo.available_licenses <= 2 ? 'h-full bg-orange-500 dark:bg-orange-600' : 'h-full bg-emerald-500 dark:bg-emerald-600'}
                        style={{ width: ((licenseInfo.total_licenses - licenseInfo.available_licenses) / licenseInfo.total_licenses) * 100 + '%' }}
                      />
                    </div>
                  </div>
                )}
                {licenseInfo.available_licenses === null && (
                  <div className="text-[9px] leading-relaxed text-zinc-600 dark:text-zinc-400">
                    <div className="mb-1.5 font-medium text-zinc-900 dark:text-zinc-100">Not configured</div>
                    <div className="text-[8px] text-zinc-500 dark:text-zinc-500">
                      See "How do I configure it?" in onboarding
                    </div>
                  </div>
                )}
              </div>
            )}
          </div>
        </div>

        {suggesting && (
          <div className="mb-4 flex items-center gap-2 rounded-xl border border-sky-200 bg-sky-50/70 px-3.5 py-2.5 text-[12px] text-sky-800 dark:border-sky-900/50 dark:bg-sky-950/25 dark:text-sky-200">
            <Loader2 className="h-4 w-4 shrink-0 animate-spin" />
            <span>
              Please wait while we check for duplicate addresses and suggest a unique
              @simple.biz email for each hire...
            </span>
          </div>
        )}

        <div className="mb-3 flex items-center justify-end">
          <button
            type="button"
            onClick={() => void loadDeptRates()}
            disabled={ratesRefreshing}
            className="inline-flex items-center gap-1 text-[11px] font-medium text-emerald-700 hover:underline disabled:opacity-50 dark:text-emerald-300"
            title="Re-check which departments have compensation set by Accounting in the Payment Catalog"
          >
            <RefreshCw className={cn('h-3 w-3', ratesRefreshing && 'animate-spin')} />
            Refresh compensation
          </button>
        </div>

        <div className="flex flex-col gap-4">
          {groups.map((g) => (
            <BulkDeptGroup
              key={g.key}
              groupKey={g.key}
              initialDept={g.dept}
              rows={g.rows}
              departments={departments}
              deptRates={deptRates}
              projectOptions={projectOptions}
              metaLoading={metaLoading}
              emails={emails}
              avail={avail}
              dupIds={dupIds}
              doneIds={doneIds}
              results={results}
              suggesting={suggesting}
              onEmailChange={setEmail}
              onAvail={setAvailOne}
              onSubmitGroup={(args) => void runGroup(g.key, args)}
              busy={!!groupBusy[g.key]}
              progress={groupProgress[g.key] ?? null}
            />
          ))}
        </div>

        <DialogFooter className="mt-4 gap-2 border-t border-zinc-100 pt-4 sm:gap-0 dark:border-zinc-800">
          <Button variant="outline" size="sm" onClick={onClose}>
            {allDone ? (
              <>
                <CheckCircle2 className="mr-1 h-3.5 w-3.5" />
                Done
              </>
            ) : (
              'Close'
            )}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function BulkDeptGroup({
  groupKey,
  initialDept,
  rows,
  departments,
  deptRates,
  projectOptions,
  metaLoading,
  emails,
  avail,
  dupIds,
  doneIds,
  results,
  suggesting,
  onEmailChange,
  onAvail,
  onSubmitGroup,
  busy,
  progress,
}: {
  groupKey: string;
  initialDept: string;
  rows: SubmissionRow[];
  departments: string[];
  deptRates: Map<string, BulkDeptRate>;
  projectOptions: string[];
  metaLoading: boolean;
  emails: Record<string, string>;
  avail: Record<string, boolean | null>;
  dupIds: Set<string>;
  doneIds: Set<string>;
  results: Record<string, { ok: boolean; warn?: boolean; error?: string; verify?: 'exists' | 'missing' | 'error' }>;
  suggesting: boolean;
  onEmailChange: (id: string, v: string) => void;
  onAvail: (id: string, v: boolean | null) => void;
  onSubmitGroup: (args: {
    rows: SubmissionRow[];
    department: string;
    projects: string[];
  }) => void;
  busy: boolean;
  progress: { done: number; total: number; phase?: 'set' | 'verify' } | null;
}) {
  const needsDept = groupKey === '__none__';
  const [dept, setDept] = useState(initialDept);
  const [projects, setProjects] = useState<string[]>([]);

  const deptKey = dept.trim().toLowerCase();
  const typical = deptKey ? deptRates.get(deptKey) : undefined;
  // Compensation is owned by Accounting (Payment Catalog). HR never sees the
  // figure and the client never sends it — the server resolves the rate from the
  // catalog at submit time. We track only readiness for the checkmark.
  const compReady = typical?.ready ?? false;

  // Compensation readiness is informational only — a group can be set before
  // Accounting fills the Payment Catalog (rate stays null until they do).
  const configValid = dept.trim().length > 0 && projects.length > 0;

  const usableRows = rows.filter((r) => {
    if (doneIds.has(r.id)) return false;
    const e = (emails[r.id] ?? '').trim().toLowerCase();
    if (!isPlausibleEmail(e) || !e.endsWith('@simple.biz')) return false;
    if (dupIds.has(r.id)) return false;
    // Re-setting a row's OWN existing address is always allowed (the route
    // permits it + auto-verifies), even though the roster reports it "taken".
    const own = (r.work_email ?? '').trim().toLowerCase();
    if (own && e === own) return true;
    return avail[r.id] === true;
  });
  const pendingCount = rows.filter((r) => !doneIds.has(r.id)).length;
  const allDone = pendingCount === 0;
  // Rows that already have an address but aren't confirmed yet — these can be
  // verified (read-only) even when there's nothing new to set, so a group of
  // already-staged-but-unverified hires can still be reconciled in one click.
  const verifiableRows = rows.filter((r) => !!r.work_email && r.workspace_account_ok !== true);
  const canSet = configValid && usableRows.length > 0;
  const canVerifyOnly = usableRows.length === 0 && verifiableRows.length > 0;
  const canSubmit = !busy && (canSet || canVerifyOnly);

  return (
    <div className="rounded-xl border border-emerald-100/80 bg-white p-4 shadow-sm ring-1 ring-emerald-500/5 dark:border-emerald-950/40 dark:bg-zinc-950">
      {/* Group header */}
      <div className="flex flex-col gap-2 sm:flex-row sm:items-center sm:justify-between">
        <div className="flex items-center gap-2">
          <span className="flex h-7 w-7 shrink-0 items-center justify-center rounded-lg bg-gradient-to-br from-emerald-500 to-teal-700 text-white shadow-sm shadow-emerald-600/25">
            <Users className="h-3.5 w-3.5" />
          </span>
          <div>
            <h3 className="text-sm font-semibold text-zinc-900 dark:text-zinc-100">
              {needsDept ? 'No department on file' : dept}
            </h3>
            <p className="text-[11px] text-zinc-500">
              {rows.length} {rows.length === 1 ? 'hire' : 'hires'}
              {allDone ? ' - all set' : ''}
            </p>
          </div>
        </div>
        {needsDept && (
          <div className="w-full sm:w-60">
            <DepartmentSelect
              value={dept}
              onChange={setDept}
              departments={departments}
              loading={metaLoading}
            />
          </div>
        )}
      </div>

      {/* Shared config: compensation readiness (from Accounting's Payment
          Catalog — figures hidden) + the project set for everyone here. */}
      <div className="mt-3 grid gap-3 sm:grid-cols-2">
        <div className="flex flex-col gap-1">
          <label className="text-[11px] font-medium text-zinc-600 dark:text-zinc-400">
            Compensation
          </label>
          {!deptKey ? (
            <div className="flex h-8 items-center rounded-md border border-zinc-200 bg-zinc-50 px-2.5 text-[11px] text-zinc-500 dark:border-zinc-800 dark:bg-zinc-900/40">
              Pick a department.
            </div>
          ) : compReady ? (
            <div className="flex h-8 items-center gap-1.5 rounded-md border border-emerald-200 bg-emerald-50/70 px-2.5 text-[11px] font-medium text-emerald-800 dark:border-emerald-900/50 dark:bg-emerald-950/25 dark:text-emerald-200">
              <CheckCircle2 className="h-3.5 w-3.5 shrink-0" />
              Ready (set by Accounting)
            </div>
          ) : (
            <div className="flex h-8 items-center gap-1.5 rounded-md border border-amber-200 bg-amber-50/70 px-2.5 text-[11px] font-medium text-amber-800 dark:border-amber-900/50 dark:bg-amber-950/25 dark:text-amber-200">
              <AlertTriangle className="h-3.5 w-3.5 shrink-0" />
              Not set in Payment Catalog
            </div>
          )}
          <p className="text-[10.5px] text-zinc-400">Set by Accounting — not editable here.</p>
        </div>
        <div className="flex flex-col gap-1">
          <label className="text-[11px] font-medium text-zinc-600 dark:text-zinc-400">
            Hubstaff project(s)
          </label>
          <ProjectMultiSelect
            selected={projects}
            onChange={setProjects}
            options={projectOptions}
            loading={metaLoading}
          />
          <p className="text-[10.5px] text-zinc-400">Required for everyone here.</p>
        </div>
      </div>

      {/* Per-person rows */}
      <div className="mt-3 overflow-hidden rounded-lg border border-zinc-200/80 dark:border-zinc-800">
        {rows.map((r, i) => {
          const done = doneIds.has(r.id);
          const res = results[r.id];
          const name = r.full_name?.trim() || r.invite_name?.trim() || '(no name)';
          const personal = r.email ?? r.invite_personal_email ?? '';
          const preExisting = done && !res?.ok && !!r.work_email;
          return (
            <div
              key={r.id}
              className={cn(
                'grid grid-cols-1 gap-2 px-3 py-2.5 sm:grid-cols-2 sm:items-start',
                i > 0 && 'border-t border-zinc-100 dark:border-zinc-800/70',
                done && 'bg-emerald-50/40 dark:bg-emerald-950/20',
              )}
            >
              <div className="min-w-0">
                <p className="truncate text-xs font-medium text-zinc-800 dark:text-zinc-200">
                  {name}
                </p>
                {personal && (
                  <p className="truncate font-mono text-[10.5px] text-zinc-500">{personal}</p>
                )}
                {res?.verify === 'exists' ? (
                  <span className="mt-0.5 inline-flex items-center gap-1 text-[10.5px] font-medium text-emerald-600 dark:text-emerald-400">
                    <CheckCircle2 className="h-3 w-3" />
                    Verified in Workspace
                  </span>
                ) : res?.verify === 'missing' ? (
                  <span className="mt-0.5 inline-flex items-center gap-1 text-[10.5px] font-medium text-amber-600 dark:text-amber-400">
                    <XCircle className="h-3 w-3" />
                    Account not found - retry from table
                  </span>
                ) : res?.verify === 'error' ? (
                  <span className="mt-0.5 inline-flex items-center gap-1 text-[10.5px] font-medium text-zinc-500">
                    <CheckCircle2 className="h-3 w-3" />
                    Saved (verify unavailable)
                  </span>
                ) : done && res?.warn ? (
                  <span className="mt-0.5 inline-flex items-center gap-1 text-[10.5px] font-medium text-amber-600 dark:text-amber-400">
                    <XCircle className="h-3 w-3" />
                    Saved, verifying...
                  </span>
                ) : done ? (
                  <span className="mt-0.5 inline-flex items-center gap-1 text-[10.5px] font-medium text-emerald-600 dark:text-emerald-400">
                    <CheckCircle2 className="h-3 w-3" />
                    {preExisting ? 'Already had a work email' : 'Work email set'}
                  </span>
                ) : null}
                {res && (!res.ok || res.warn) && !res.verify && res.error && (
                  <span
                    className={cn(
                      'mt-0.5 block text-[10.5px]',
                      res.ok
                        ? 'text-amber-600 dark:text-amber-400'
                        : 'text-rose-600 dark:text-rose-400',
                    )}
                  >
                    {res.error}
                  </span>
                )}
              </div>
              <BulkWorkEmailField
                value={emails[r.id] ?? ''}
                onChange={(v) => onEmailChange(r.id, v)}
                onAvail={(v) => onAvail(r.id, v)}
                isDup={dupIds.has(r.id)}
                done={done}
                ownEmail={r.work_email ?? undefined}
                suggesting={suggesting}
              />
            </div>
          );
        })}
      </div>

      {/* Per-department submit — never a single action across all departments */}
      {busy && (
        <div className="mt-3 flex items-center gap-2 rounded-lg border border-emerald-200 bg-emerald-50/70 px-3 py-2 text-[11px] text-emerald-800 dark:border-emerald-900/50 dark:bg-emerald-950/25 dark:text-emerald-200">
          <Loader2 className="h-3.5 w-3.5 shrink-0 animate-spin" />
          <span>
            {progress?.phase === 'verify'
              ? 'Verifying Workspace accounts'
              : 'Creating Google Workspace accounts + Hubstaff invites'}
            {progress ? ` (${progress.done}/${progress.total})` : ''}... this can take a moment
            per hire - please keep this window open.
          </span>
        </div>
      )}

      <div className="mt-3 flex flex-wrap items-center justify-end gap-2">
        {!configValid && pendingCount > 0 && (
          <span className="text-[11px] text-amber-600 dark:text-amber-400">
            {dept.trim().length === 0 ? 'Pick a department first.' : 'Pick a project first.'}
          </span>
        )}
        <Button
          size="sm"
          className="h-8 bg-gradient-to-r from-emerald-500 to-teal-700 px-3 text-xs text-white shadow-sm shadow-emerald-600/25 hover:opacity-90 disabled:opacity-60"
          onClick={() =>
            onSubmitGroup({
              rows: usableRows,
              department: dept.trim(),
              projects,
            })
          }
          disabled={!canSubmit}
        >
          {busy ? (
            <Loader2 className="mr-1 h-3.5 w-3.5 animate-spin" />
          ) : (
            <UserCheck className="mr-1 h-3.5 w-3.5" />
          )}
          {busy && progress
            ? progress.phase === 'verify'
              ? `Verifying ${progress.done}/${progress.total}...`
              : `Setting ${progress.done}/${progress.total}...`
            : canVerifyOnly
              ? `Verify ${verifiableRows.length} account${verifiableRows.length === 1 ? '' : 's'}`
              : allDone
                ? 'All set'
                : `Set ${usableRows.length} work email${usableRows.length === 1 ? '' : 's'}`}
        </Button>
      </div>
    </div>
  );
}

/**
 * One editable work-email cell. Debounces an availability check against the
 * live roster and reports the result up via `onAvail`. Duplicate-within-batch
 * is detected by the parent and passed in as `isDup`.
 */
function BulkWorkEmailField({
  value,
  onChange,
  onAvail,
  isDup,
  done,
  ownEmail,
  suggesting,
}: {
  value: string;
  onChange: (v: string) => void;
  onAvail: (v: boolean | null) => void;
  isDup: boolean;
  done: boolean;
  /** The row's current work email, if any. Re-selecting it is always allowed
   *  (the route permits re-setting the same address), so we never report a
   *  row's own address as "taken". */
  ownEmail?: string;
  suggesting: boolean;
}) {
  const [checking, setChecking] = useState(false);
  const [serverAvail, setServerAvail] = useState<boolean | null>(null);
  // Hold the latest onAvail in a ref so a fresh inline callback from the parent
  // each render doesn't re-trigger the debounced fetch.
  const onAvailRef = useRef(onAvail);
  onAvailRef.current = onAvail;

  const norm = value.trim().toLowerCase();
  const ownNorm = (ownEmail ?? '').trim().toLowerCase();
  const validFormat = isPlausibleEmail(norm) && norm.endsWith('@simple.biz');

  useEffect(() => {
    if (done) return;
    if (!norm || !validFormat) {
      setServerAvail(null);
      onAvailRef.current(null);
      setChecking(false);
      return;
    }
    // A row re-selecting its OWN existing address: it's "taken" by this very
    // row, so skip the roster check and treat it as available/settable.
    if (ownNorm && norm === ownNorm) {
      setServerAvail(true);
      onAvailRef.current(true);
      setChecking(false);
      return;
    }
    let active = true;
    setChecking(true);
    const t = setTimeout(async () => {
      try {
        const res = await fetch('/api/hr/work-email/suggest', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ candidate: norm }),
        });
        const j = (await res.json()) as { candidate?: { available: boolean } | null };
        const a = j.candidate ? j.candidate.available : null;
        if (active) {
          setServerAvail(a);
          onAvailRef.current(a);
        }
      } catch {
        if (active) {
          setServerAvail(null);
          onAvailRef.current(null);
        }
      } finally {
        if (active) setChecking(false);
      }
    }, 350);
    return () => {
      active = false;
      clearTimeout(t);
    };
  }, [norm, validFormat, done, ownNorm]);

  const showSpinner = !done && (checking || (suggesting && !norm));
  const state: 'ok' | 'bad' | 'none' =
    done || (validFormat && !isDup && serverAvail === true)
      ? 'ok'
      : (!!norm && !validFormat) || isDup || serverAvail === false
        ? 'bad'
        : 'none';

  const message = done
    ? 'Set'
    : suggesting && !norm
      ? 'Suggesting address'
      : checking
        ? 'Checking availability'
        : norm && !validFormat
          ? 'Must be a valid @simple.biz address.'
          : isDup
            ? 'Duplicate address in this batch.'
            : serverAvail === false
              ? 'Already in use - try another.'
              : serverAvail === true
                ? 'Available.'
                : 'Enter an @simple.biz address.';

  return (
    <div className="flex min-w-0 flex-col gap-0.5">
      <div className="relative">
        <Input
          value={value}
          onChange={(e) => onChange(e.target.value)}
          disabled={done}
          placeholder="namel@simple.biz"
          className="h-8 pr-8 font-mono text-xs disabled:opacity-70"
          spellCheck={false}
          autoCapitalize="none"
        />
        <span className="pointer-events-none absolute right-2 top-1/2 -translate-y-1/2">
          {showSpinner ? (
            <Loader2 className="h-3.5 w-3.5 animate-spin text-zinc-400" />
          ) : state === 'ok' ? (
            <CheckCircle2 className="h-3.5 w-3.5 text-emerald-500" />
          ) : state === 'bad' ? (
            <XCircle className="h-3.5 w-3.5 text-rose-500" />
          ) : null}
        </span>
      </div>
      <p
        className={cn(
          'text-[10.5px] leading-tight',
          state === 'bad'
            ? 'text-rose-600 dark:text-rose-400'
            : state === 'ok'
              ? 'text-emerald-600 dark:text-emerald-400'
              : 'text-zinc-400',
        )}
      >
        {message}
      </p>
    </div>
  );
}

function DepartmentSelect({
  value,
  onChange,
  departments,
  loading,
}: {
  value: string;
  onChange: (v: string) => void;
  departments: string[];
  loading: boolean;
}) {
  const [query, setQuery] = useState('');

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return departments;
    return departments.filter((d) => d.toLowerCase().includes(q));
  }, [departments, query]);

  return (
    <SelectPrimitive.Root
      value={value}
      onValueChange={(v) => onChange(v ?? '')}
      disabled={loading}
      onOpenChange={(open) => { if (!open) setQuery(''); }}
    >
      <SelectPrimitive.Trigger
        className={cn(
          'flex h-9 w-full items-center justify-between gap-2 rounded-lg border border-zinc-300 bg-transparent px-3 py-2 text-sm whitespace-nowrap transition-colors outline-none select-none dark:border-input',
          'data-placeholder:text-muted-foreground',
          'hover:border-zinc-400 dark:hover:border-zinc-500',
          'focus-visible:border-emerald-500 focus-visible:ring-2 focus-visible:ring-emerald-500/20',
          'disabled:cursor-not-allowed disabled:opacity-50',
          'dark:bg-input/30',
        )}
      >
        <SelectPrimitive.Value
          placeholder={loading ? 'Loading departments…' : 'Select department'}
          className="flex-1 text-left"
        />
        <ChevronDownIcon className="h-4 w-4 shrink-0 text-muted-foreground" />
      </SelectPrimitive.Trigger>
      <SelectPrimitive.Portal>
        <SelectPrimitive.Positioner side="bottom" sideOffset={4} alignItemWithTrigger className="isolate z-50">
          <SelectPrimitive.Popup className="w-(--anchor-width) min-w-56 overflow-hidden rounded-xl border border-zinc-200 bg-white shadow-lg shadow-black/8 dark:border-zinc-700 dark:bg-zinc-900 data-open:animate-in data-open:fade-in-0 data-open:zoom-in-95 data-closed:animate-out data-closed:fade-out-0 data-closed:zoom-out-95">
            {/* Sticky search input — stopPropagation keeps Base UI's typeahead off
                so the user types into the input, not against item keys. */}
            <div className="sticky top-0 z-[1] border-b border-zinc-100 bg-white p-2 dark:border-zinc-800 dark:bg-zinc-900">
              <div className="relative">
                <Search className="pointer-events-none absolute left-2.5 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-zinc-400" />
                <input
                  type="text"
                  value={query}
                  onChange={(e) => setQuery(e.target.value)}
                  onKeyDown={(e) => {
                    e.stopPropagation();
                    if (e.key === 'Enter' && filtered.length === 1) {
                      e.preventDefault();
                      onChange(filtered[0]);
                    }
                  }}
                  placeholder="Search departments…"
                  autoFocus
                  className="h-8 w-full rounded-md border border-zinc-200 bg-white pl-8 pr-2 text-xs outline-none transition-colors placeholder:text-zinc-400 focus:border-emerald-500 focus:ring-2 focus:ring-emerald-500/20 dark:border-zinc-700 dark:bg-zinc-950 dark:text-zinc-100"
                />
              </div>
            </div>
            <SelectPrimitive.List className="max-h-64 overflow-y-auto p-1">
              {filtered.length === 0 ? (
                <div className="px-3 py-4 text-center text-xs italic text-muted-foreground">
                  {loading
                    ? 'Loading…'
                    : query.trim()
                      ? `No departments match "${query.trim()}".`
                      : 'No departments on file yet.'}
                </div>
              ) : (
                filtered.map((d) => (
                  <SelectPrimitive.Item
                    key={d}
                    value={d}
                    className={cn(
                      'relative flex w-full cursor-default items-center justify-between rounded-lg px-3 py-2 text-sm outline-none select-none',
                      'focus:bg-emerald-50 focus:text-emerald-900 dark:focus:bg-emerald-950/50 dark:focus:text-emerald-100',
                      'data-highlighted:bg-emerald-50 data-highlighted:text-emerald-900 dark:data-highlighted:bg-emerald-950/50 dark:data-highlighted:text-emerald-100',
                    )}
                  >
                    <SelectPrimitive.ItemText className="flex-1 truncate pr-2">
                      {d}
                    </SelectPrimitive.ItemText>
                    <SelectPrimitive.ItemIndicator className="flex h-4 w-4 items-center justify-center">
                      <CheckIcon className="h-3.5 w-3.5 text-emerald-600" />
                    </SelectPrimitive.ItemIndicator>
                  </SelectPrimitive.Item>
                ))
              )}
            </SelectPrimitive.List>
          </SelectPrimitive.Popup>
        </SelectPrimitive.Positioner>
      </SelectPrimitive.Portal>
    </SelectPrimitive.Root>
  );
}

// --- Country dropdown (onboarding currencies) ----------------------------

/** Compact picker over the three onboarding countries (US / PH / CO). Shows the
 *  derived currency next to each so HR knows what the plan targets. */
function CountrySelect({
  value,
  onChange,
}: {
  value: string;
  onChange: (v: string) => void;
}) {
  return (
    <SelectPrimitive.Root value={value} onValueChange={(v) => onChange(v ?? '')}>
      <SelectPrimitive.Trigger
        className={cn(
          'flex h-9 w-full items-center justify-between gap-2 rounded-lg border border-zinc-300 bg-transparent px-3 py-2 text-sm whitespace-nowrap transition-colors outline-none select-none dark:border-input',
          'data-placeholder:text-muted-foreground',
          'hover:border-zinc-400 dark:hover:border-zinc-500',
          'focus-visible:border-emerald-500 focus-visible:ring-2 focus-visible:ring-emerald-500/20',
          'disabled:cursor-not-allowed disabled:opacity-50',
          'dark:bg-input/30',
        )}
      >
        <SelectPrimitive.Value placeholder="Select country" className="flex-1 text-left" />
        <ChevronDownIcon className="h-4 w-4 shrink-0 text-muted-foreground" />
      </SelectPrimitive.Trigger>
      <SelectPrimitive.Portal>
        <SelectPrimitive.Positioner side="bottom" sideOffset={4} alignItemWithTrigger className="isolate z-50">
          <SelectPrimitive.Popup className="w-(--anchor-width) min-w-56 overflow-hidden rounded-xl border border-zinc-200 bg-white shadow-lg shadow-black/8 dark:border-zinc-700 dark:bg-zinc-900 data-open:animate-in data-open:fade-in-0 data-open:zoom-in-95 data-closed:animate-out data-closed:fade-out-0 data-closed:zoom-out-95">
            <SelectPrimitive.List className="max-h-64 overflow-y-auto p-1">
              {ONBOARDING_COUNTRIES.map((c) => (
                <SelectPrimitive.Item
                  key={c.name}
                  value={c.name}
                  className={cn(
                    'relative flex w-full cursor-default items-center justify-between rounded-lg px-3 py-2 text-sm outline-none select-none',
                    'focus:bg-emerald-50 focus:text-emerald-900 dark:focus:bg-emerald-950/50 dark:focus:text-emerald-100',
                    'data-highlighted:bg-emerald-50 data-highlighted:text-emerald-900 dark:data-highlighted:bg-emerald-950/50 dark:data-highlighted:text-emerald-100',
                  )}
                >
                  <SelectPrimitive.ItemText className="flex-1 truncate pr-2">
                    {c.name}
                  </SelectPrimitive.ItemText>
                  <span className="mr-2 text-[10px] font-medium text-zinc-400">{c.currency}</span>
                  <SelectPrimitive.ItemIndicator className="flex h-4 w-4 items-center justify-center">
                    <CheckIcon className="h-3.5 w-3.5 text-emerald-600" />
                  </SelectPrimitive.ItemIndicator>
                </SelectPrimitive.Item>
              ))}
            </SelectPrimitive.List>
          </SelectPrimitive.Popup>
        </SelectPrimitive.Positioner>
      </SelectPrimitive.Portal>
    </SelectPrimitive.Root>
  );
}

// --- Pay Plans dialog -----------------------------------------------------

/** One configured pay plan, as returned by GET /api/hr/pay-plans. */
type PayPlanApi = {
  id: string;
  department: string;
  country: string;
  file_name: string;
  content_type: string | null;
  file_size: number | null;
  uploaded_by: string | null;
  created_at: string;
  updated_at: string;
  download_url: string | null;
};

const PAY_PLAN_MAX_BYTES = 10 * 1024 * 1024; // 10 MB

function fmtBytes(n: number | null): string {
  if (n == null || !Number.isFinite(n)) return '';
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(0)} KB`;
  return `${(n / (1024 * 1024)).toFixed(1)} MB`;
}

/**
 * HR config modal: upload one pay-plan PDF per (Department, Country). When HR
 * generates an onboarding link and picks a Department + Country, the matching
 * plan rides the onboarding invite email (the `onboarding_send` webhook) as a
 * download link + attachment.
 */
function PayPlansDialog({ open, onClose }: { open: boolean; onClose: () => void }) {
  const [plans, setPlans] = useState<PayPlanApi[]>([]);
  const [loading, setLoading] = useState(false);
  const [departments, setDepartments] = useState<string[]>([]);
  const [deptsLoading, setDeptsLoading] = useState(false);

  const [dept, setDept] = useState('');
  const [country, setCountry] = useState('');
  const [file, setFile] = useState<File | null>(null);
  const [uploading, setUploading] = useState(false);

  const [pendingDeleteId, setPendingDeleteId] = useState<string | null>(null);
  const [deletingId, setDeletingId] = useState<string | null>(null);

  const fileInputRef = useRef<HTMLInputElement | null>(null);

  const loadPlans = useCallback(async () => {
    setLoading(true);
    try {
      const res = await fetch('/api/hr/pay-plans', { cache: 'no-store' });
      const json = (await res.json()) as { rows?: PayPlanApi[]; error?: string };
      if (!res.ok || json.error) throw new Error(json.error ?? 'Failed to load pay plans');
      setPlans(json.rows ?? []);
    } catch (e) {
      toast.error(e instanceof Error ? e.message : 'Failed to load pay plans');
      setPlans([]);
    } finally {
      setLoading(false);
    }
  }, []);

  // Load plans + departments whenever the modal opens.
  useEffect(() => {
    if (!open) return;
    void loadPlans();
    setDeptsLoading(true);
    fetch('/api/departments', { cache: 'no-store' })
      .then((r) => r.json())
      .then((j: { departments?: string[] }) => setDepartments(j.departments ?? []))
      .catch((e) => toast.error(e instanceof Error ? e.message : 'Could not load departments'))
      .finally(() => setDeptsLoading(false));
  }, [open, loadPlans]);

  // Reset the entry form each time the modal is closed so it opens fresh.
  useEffect(() => {
    if (open) return;
    setDept('');
    setCountry('');
    setFile(null);
    setPendingDeleteId(null);
  }, [open]);

  function onPickFile(e: ChangeEvent<HTMLInputElement>) {
    const f = e.target.files?.[0] ?? null;
    // Allow re-picking the same file later.
    e.target.value = '';
    if (!f) return;
    const isPdf = f.type === 'application/pdf' || /\.pdf$/i.test(f.name);
    if (!isPdf) {
      toast.error('Only PDF files are accepted.');
      return;
    }
    if (f.size > PAY_PLAN_MAX_BYTES) {
      toast.error('File too large (max 10 MB).');
      return;
    }
    setFile(f);
  }

  // A plan already exists for the chosen pair (case-insensitive) -> the upload
  // replaces it. Surfaced as a hint so HR isn't surprised.
  const replacingExisting = useMemo(() => {
    if (!dept || !country) return false;
    const d = dept.trim().toLowerCase();
    const c = country.trim().toLowerCase();
    return plans.some(
      (p) => p.department.trim().toLowerCase() === d && p.country.trim().toLowerCase() === c,
    );
  }, [plans, dept, country]);

  async function handleUpload() {
    if (!dept) {
      toast.error('Pick a department.');
      return;
    }
    if (!country) {
      toast.error('Pick a country.');
      return;
    }
    if (!file) {
      toast.error('Choose a PDF file.');
      return;
    }
    setUploading(true);
    try {
      const fd = new FormData();
      fd.append('department', dept);
      fd.append('country', country);
      fd.append('file', file);
      const res = await fetch('/api/hr/pay-plans', { method: 'POST', body: fd });
      const json = (await res.json().catch(() => ({}))) as { error?: string };
      if (!res.ok || json.error) throw new Error(json.error ?? 'Upload failed');
      toast.success(
        `Pay plan ${replacingExisting ? 'replaced' : 'saved'} for ${dept} · ${country}`,
      );
      setFile(null);
      await loadPlans();
    } catch (e) {
      toast.error(e instanceof Error ? e.message : 'Upload failed');
    } finally {
      setUploading(false);
    }
  }

  async function handleDelete(id: string) {
    setDeletingId(id);
    try {
      const res = await fetch(`/api/hr/pay-plans/${id}`, { method: 'DELETE' });
      const json = (await res.json().catch(() => ({}))) as { error?: string };
      if (!res.ok || json.error) throw new Error(json.error ?? 'Delete failed');
      toast.success('Pay plan removed');
      setPendingDeleteId(null);
      await loadPlans();
    } catch (e) {
      toast.error(e instanceof Error ? e.message : 'Delete failed');
    } finally {
      setDeletingId(null);
    }
  }

  return (
    <Dialog open={open} onOpenChange={(o) => !o && onClose()}>
      <DialogContent className="max-h-[90vh] overflow-y-auto sm:max-w-2xl">
        <div className="-mx-6 -mt-6 mb-2 overflow-hidden rounded-t-lg border-b border-emerald-100/80 bg-gradient-to-br from-emerald-50 via-white to-teal-50/60 px-6 py-5 dark:border-emerald-950/40 dark:from-emerald-950/30 dark:via-zinc-950 dark:to-teal-950/20">
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2.5 text-base font-semibold">
              <span className="flex h-8 w-8 shrink-0 items-center justify-center rounded-lg bg-gradient-to-br from-emerald-500 to-teal-700 text-white shadow-md">
                <Banknote className="h-4 w-4" />
              </span>
              Onboarding Pay Plans
            </DialogTitle>
            <DialogDescription className="text-xs leading-relaxed">
              Upload one pay-plan PDF per <strong>Department + Country</strong>. When you generate an
              onboarding link and pick that Department + Country, the matching plan is attached to
              the hire's invite email (download link + attachment).
            </DialogDescription>
          </DialogHeader>
        </div>

        {/* Upload / replace form */}
        <DialogSection label="Add or replace a pay plan">
          <div className="grid gap-3 sm:grid-cols-2">
            <DialogField label="Department" icon={<Users className="h-3.5 w-3.5" />}>
              <DepartmentSelect
                value={dept}
                onChange={setDept}
                departments={departments}
                loading={deptsLoading}
              />
            </DialogField>
            <DialogField label="Country" icon={<Globe className="h-3.5 w-3.5" />}>
              <CountrySelect value={country} onChange={setCountry} />
            </DialogField>
          </div>

          <DialogField
            label="Pay plan PDF"
            icon={<FileText className="h-3.5 w-3.5" />}
            hint="PDF only, up to 10 MB."
          >
            <input
              ref={fileInputRef}
              type="file"
              accept="application/pdf,.pdf"
              className="hidden"
              aria-label="Upload pay plan PDF"
              onChange={onPickFile}
            />
            <button
              type="button"
              onClick={() => fileInputRef.current?.click()}
              className={cn(
                'flex w-full items-center gap-3 rounded-lg border border-dashed px-3 py-3 text-left text-sm transition-colors',
                file
                  ? 'border-emerald-300 bg-emerald-50/60 dark:border-emerald-800 dark:bg-emerald-950/20'
                  : 'border-zinc-300 hover:border-emerald-400 hover:bg-emerald-50/40 dark:border-zinc-700 dark:hover:border-emerald-700',
              )}
            >
              <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-md bg-emerald-100 text-emerald-700 dark:bg-emerald-900/50 dark:text-emerald-300">
                <UploadCloud className="h-4 w-4" />
              </span>
              <span className="min-w-0 flex-1">
                <span className="block truncate font-medium text-zinc-800 dark:text-zinc-100">
                  {file ? file.name : 'Choose a PDF file'}
                </span>
                <span className="block text-[11px] text-zinc-500">
                  {file ? fmtBytes(file.size) : 'Click to browse'}
                </span>
              </span>
              {file && (
                <span className="shrink-0 text-[11px] font-medium text-emerald-700 dark:text-emerald-400">
                  Change
                </span>
              )}
            </button>
          </DialogField>

          {replacingExisting && (
            <p className="flex items-center gap-1.5 text-[11px] text-amber-600 dark:text-amber-400">
              <AlertTriangle className="h-3.5 w-3.5 shrink-0" />
              A plan already exists for {dept} · {country} — uploading replaces it.
            </p>
          )}

          <div className="flex justify-end">
            <Button
              size="sm"
              className="bg-gradient-to-r from-emerald-500 to-teal-700 text-white shadow-sm hover:opacity-95"
              disabled={uploading || !dept || !country || !file}
              onClick={() => void handleUpload()}
            >
              {uploading ? (
                <Loader2 className="mr-1.5 h-3.5 w-3.5 animate-spin" />
              ) : (
                <UploadCloud className="mr-1.5 h-3.5 w-3.5" />
              )}
              {replacingExisting ? 'Replace plan' : 'Upload plan'}
            </Button>
          </div>
        </DialogSection>

        {/* Existing plans */}
        <DialogSection label={`Configured plans${plans.length ? ` (${plans.length})` : ''}`} last>
          <div className="-mt-1 mb-1 flex justify-end">
            <button
              type="button"
              onClick={() => void loadPlans()}
              disabled={loading}
              className="inline-flex items-center gap-1 text-[11px] font-medium text-emerald-700 hover:text-emerald-900 disabled:opacity-60 dark:text-emerald-400"
            >
              <RefreshCw className={cn('h-3 w-3', loading && 'animate-spin')} />
              Refresh
            </button>
          </div>

          {loading && plans.length === 0 ? (
            <div className="flex items-center justify-center py-8 text-zinc-400">
              <Loader2 className="h-5 w-5 animate-spin" />
            </div>
          ) : plans.length === 0 ? (
            <div className="rounded-lg border border-dashed border-zinc-300 py-8 text-center text-xs text-zinc-500 dark:border-zinc-700">
              No pay plans yet. Upload one above to get started.
            </div>
          ) : (
            <ul className="flex flex-col gap-2">
              {plans.map((p) => {
                const currency = currencyForCountry(p.country);
                return (
                  <li
                    key={p.id}
                    className="flex flex-wrap items-center gap-3 rounded-lg border border-zinc-200 bg-white px-3 py-2.5 dark:border-zinc-800 dark:bg-zinc-900/40"
                  >
                    <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-md bg-rose-50 text-rose-600 dark:bg-rose-950/30 dark:text-rose-400">
                      <FileText className="h-4 w-4" />
                    </span>
                    <div className="min-w-0 flex-1">
                      <div className="flex flex-wrap items-center gap-1.5">
                        <span className="text-sm font-semibold text-zinc-900 dark:text-zinc-100">
                          {p.department}
                        </span>
                        <span className="inline-flex items-center gap-1 rounded-full border border-emerald-200 bg-emerald-50 px-1.5 py-0.5 text-[10px] font-medium text-emerald-800 dark:border-emerald-800 dark:bg-emerald-950/30 dark:text-emerald-300">
                          <Globe className="h-2.5 w-2.5" />
                          {p.country}
                          {currency ? ` · ${currency}` : ''}
                        </span>
                      </div>
                      <div className="mt-0.5 flex items-center gap-1.5 text-[11px] text-zinc-500">
                        <span className="truncate">{p.file_name}</span>
                        {p.file_size != null && <span>· {fmtBytes(p.file_size)}</span>}
                        <span>· {fmtDate(p.updated_at)}</span>
                      </div>
                    </div>
                    <div className="flex shrink-0 items-center gap-1">
                      {p.download_url && (
                        <a
                          href={p.download_url}
                          target="_blank"
                          rel="noopener noreferrer"
                          className="inline-flex items-center gap-1 rounded-md border border-zinc-200 px-2 py-1 text-[11px] font-medium text-zinc-600 transition-colors hover:bg-zinc-50 hover:text-zinc-900 dark:border-zinc-700 dark:text-zinc-300 dark:hover:bg-zinc-800"
                        >
                          <Download className="h-3 w-3" />
                          View
                        </a>
                      )}
                      {pendingDeleteId === p.id ? (
                        <>
                          <Button
                            size="sm"
                            variant="ghost"
                            className="h-7 px-2 text-[11px] text-rose-600 hover:bg-rose-50 hover:text-rose-700 dark:hover:bg-rose-950/30"
                            disabled={deletingId === p.id}
                            onClick={() => void handleDelete(p.id)}
                          >
                            {deletingId === p.id ? (
                              <Loader2 className="h-3 w-3 animate-spin" />
                            ) : (
                              'Confirm'
                            )}
                          </Button>
                          <Button
                            size="sm"
                            variant="ghost"
                            className="h-7 px-2 text-[11px]"
                            disabled={deletingId === p.id}
                            onClick={() => setPendingDeleteId(null)}
                          >
                            Cancel
                          </Button>
                        </>
                      ) : (
                        <button
                          type="button"
                          onClick={() => setPendingDeleteId(p.id)}
                          title="Delete pay plan"
                          className="inline-flex h-7 w-7 items-center justify-center rounded-md text-zinc-400 transition-colors hover:bg-rose-50 hover:text-rose-600 dark:hover:bg-rose-950/30"
                        >
                          <Trash2 className="h-3.5 w-3.5" />
                        </button>
                      )}
                    </div>
                  </li>
                );
              })}
            </ul>
          )}
        </DialogSection>

        <DialogFooter className="mt-2">
          <Button size="sm" variant="outline" onClick={onClose}>
            Close
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

// --- Hubstaff project multi-select dropdown ------------------------------

/**
 * Multi-select of Hubstaff project names (selected names are sent as
 * `projectNames` to the create-workspace-account webhook). Options are fetched
 * live from the secondary Supabase `hubstaff_projects` table via
 * `/api/secondary/hubstaff-projects`.
 */
function ProjectMultiSelect({
  selected,
  onChange,
  options,
  loading,
}: {
  selected: string[];
  onChange: (next: string[]) => void;
  options: string[];
  loading: boolean;
}) {
  const [query, setQuery] = useState('');

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return options;
    return options.filter((p) => p.toLowerCase().includes(q));
  }, [options, query]);

  const summary =
    selected.length === 0
      ? ''
      : selected.length === 1
        ? selected[0]
        : `${selected.length} projects selected`;

  return (
    <SelectPrimitive.Root
      multiple
      value={selected}
      onValueChange={(v) => onChange((v ?? []) as string[])}
      disabled={loading}
      onOpenChange={(open) => { if (!open) setQuery(''); }}
    >
      <SelectPrimitive.Trigger
        className={cn(
          'flex h-9 w-full items-center justify-between gap-2 rounded-lg border border-zinc-300 bg-transparent px-3 py-2 text-sm whitespace-nowrap transition-colors outline-none select-none dark:border-input',
          'data-placeholder:text-muted-foreground',
          'hover:border-zinc-400 dark:hover:border-zinc-500',
          'focus-visible:border-emerald-500 focus-visible:ring-2 focus-visible:ring-emerald-500/20',
          'disabled:cursor-not-allowed disabled:opacity-50',
          'dark:bg-input/30',
        )}
      >
        <span className={cn('flex-1 truncate text-left', summary ? '' : 'text-muted-foreground')}>
          {loading ? 'Loading projects…' : summary || 'Select project(s)'}
        </span>
        <ChevronDownIcon className="h-4 w-4 shrink-0 text-muted-foreground" />
      </SelectPrimitive.Trigger>
      <SelectPrimitive.Portal>
        <SelectPrimitive.Positioner side="bottom" sideOffset={4} alignItemWithTrigger className="isolate z-50">
          <SelectPrimitive.Popup className="w-(--anchor-width) min-w-56 overflow-hidden rounded-xl border border-zinc-200 bg-white shadow-lg shadow-black/8 dark:border-zinc-700 dark:bg-zinc-900 data-open:animate-in data-open:fade-in-0 data-open:zoom-in-95 data-closed:animate-out data-closed:fade-out-0 data-closed:zoom-out-95">
            <div className="sticky top-0 z-[1] border-b border-zinc-100 bg-white p-2 dark:border-zinc-800 dark:bg-zinc-900">
              <div className="relative">
                <Search className="pointer-events-none absolute left-2.5 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-zinc-400" />
                <input
                  type="text"
                  value={query}
                  onChange={(e) => setQuery(e.target.value)}
                  onKeyDown={(e) => e.stopPropagation()}
                  placeholder="Search projects…"
                  autoFocus
                  className="h-8 w-full rounded-md border border-zinc-200 bg-white pl-8 pr-2 text-xs outline-none transition-colors placeholder:text-zinc-400 focus:border-emerald-500 focus:ring-2 focus:ring-emerald-500/20 dark:border-zinc-700 dark:bg-zinc-950 dark:text-zinc-100"
                />
              </div>
            </div>
            <SelectPrimitive.List className="max-h-64 overflow-y-auto p-1">
              {filtered.length === 0 ? (
                <div className="px-3 py-4 text-center text-xs italic text-muted-foreground">
                  {loading
                    ? 'Loading…'
                    : query.trim()
                      ? `No projects match "${query.trim()}".`
                      : 'No projects found.'}
                </div>
              ) : (
                filtered.map((p) => (
                  <SelectPrimitive.Item
                    key={p}
                    value={p}
                    className={cn(
                      'relative flex w-full cursor-default items-center justify-between rounded-lg px-3 py-2 text-sm outline-none select-none',
                      'focus:bg-emerald-50 focus:text-emerald-900 dark:focus:bg-emerald-950/50 dark:focus:text-emerald-100',
                      'data-highlighted:bg-emerald-50 data-highlighted:text-emerald-900 dark:data-highlighted:bg-emerald-950/50 dark:data-highlighted:text-emerald-100',
                    )}
                  >
                    <SelectPrimitive.ItemText className="flex-1 truncate pr-2">
                      {p}
                    </SelectPrimitive.ItemText>
                    <SelectPrimitive.ItemIndicator className="flex h-4 w-4 items-center justify-center">
                      <CheckIcon className="h-3.5 w-3.5 text-emerald-600" />
                    </SelectPrimitive.ItemIndicator>
                  </SelectPrimitive.Item>
                ))
              )}
            </SelectPrimitive.List>
          </SelectPrimitive.Popup>
        </SelectPrimitive.Positioner>
      </SelectPrimitive.Portal>
    </SelectPrimitive.Root>
  );
}

function DialogSection({
  label,
  last,
  children,
}: {
  label: string;
  last?: boolean;
  children: ReactNode;
}) {
  return (
    <div className={cn('space-y-3 pt-4', !last && 'border-b border-zinc-200 pb-4 dark:border-zinc-800')}>
      <p className="text-[11px] font-semibold uppercase tracking-wider text-zinc-500 dark:text-zinc-500">
        {label}
      </p>
      {children}
    </div>
  );
}

function DialogField({
  label,
  icon,
  hint,
  error,
  children,
}: {
  label: string;
  icon?: ReactNode;
  hint?: string;
  error?: string;
  children: ReactNode;
}) {
  return (
    <div className="space-y-1.5">
      <Label className="flex items-center gap-1.5 text-xs font-medium text-zinc-700 dark:text-zinc-400">
        {icon && <span className="text-zinc-400">{icon}</span>}
        {label}
      </Label>
      {children}
      {error ? (
        <p className="text-[11px] text-rose-500">{error}</p>
      ) : hint ? (
        <p className="text-[11px] text-zinc-500 dark:text-zinc-500">{hint}</p>
      ) : null}
    </div>
  );
}

// ─── Link-created dialog (shows the URL with a Copy button) ───────────────

function LinkCreatedDialog({
  row,
  onClose,
  onSent,
}: {
  row: SubmissionRow | null;
  onClose: () => void;
  onSent?: () => void;
}) {
  const [justCopied, setJustCopied] = useState(false);
  const [sending, setSending] = useState(false);
  const [sent, setSent] = useState(false);
  // Send rotates the token server-side, so cache the post-send token locally
  // and prefer it for the displayed URL — otherwise Copy link would keep
  // handing out the pre-rotation URL that's now a 404.
  const [rotatedToken, setRotatedToken] = useState<string | null>(null);
  useEffect(() => {
    if (!row) {
      setJustCopied(false);
      setSending(false);
      setSent(false);
      setRotatedToken(null);
    } else {
      setRotatedToken(null);
    }
  }, [row]);

  const displayToken = rotatedToken ?? row?.token ?? '';
  const url = row ? publicLinkFor(displayToken) : '';
  const firstName = row?.invite_name ? row.invite_name.split(/\s+/)[0] : null;
  const mailtoSubject = encodeURIComponent('Your Simple.biz onboarding form');
  const mailtoBodyRaw = `Hi${firstName ? ` ${firstName}` : ''},\n\nWelcome to Simple.biz! Please complete your onboarding form here — it should take about 10 minutes:\n\n${url}\n\nNo account needed; the link is private to you.\n\nLet me know if you hit any issues.\n`;

  const copy = () => {
    void navigator.clipboard.writeText(url);
    setJustCopied(true);
    toast.success('Link copied to clipboard');
    setTimeout(() => setJustCopied(false), 1500);
  };

  const sendViaWebhook = async () => {
    if (!row) return;
    setSending(true);
    try {
      const res = await fetch(`/api/hr/onboarding-submissions/${row.id}/send`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({}),
      });
      const json = (await res.json()) as {
        ok?: boolean;
        to?: string;
        token?: string;
        error?: string;
      };
      if (!res.ok || json.error) throw new Error(json.error ?? 'Send failed');
      setSent(true);
      if (json.token) setRotatedToken(json.token);
      toast.success(`Email sent to ${json.to ?? row.invite_personal_email ?? 'recipient'}`);
      onSent?.();
    } catch (e) {
      toast.error(e instanceof Error ? e.message : 'Send failed');
    } finally {
      setSending(false);
    }
  };

  if (!row) return null;

  return (
    <Dialog open={!!row} onOpenChange={(o) => !o && onClose()}>
      <DialogContent className="max-h-[92vh] overflow-y-auto sm:max-w-lg">
        {/* Header strip — mirrors the GenerateLinkDialog so the two feel like one flow. */}
        <div className="-mx-6 -mt-6 mb-1 overflow-hidden rounded-t-lg border-b border-emerald-100/80 bg-gradient-to-br from-emerald-50 via-white to-teal-50/60 px-6 py-5 dark:border-emerald-950/40 dark:from-emerald-950/30 dark:via-zinc-950 dark:to-teal-950/20">
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2.5 text-base font-semibold">
              <span className="flex h-8 w-8 shrink-0 items-center justify-center rounded-lg bg-gradient-to-br from-emerald-500 to-teal-700 text-white shadow-md shadow-emerald-600/25">
                <CheckCircle2 className="h-4 w-4" />
              </span>
              Link ready to share
            </DialogTitle>
            <p className="mt-1.5 text-[12px] leading-relaxed text-zinc-600 dark:text-zinc-400">
              Send it to {row.invite_name ?? 'the new hire'}. No SSO needed — anyone with this
              link can complete the form one time.
            </p>
          </DialogHeader>
        </div>

        {/* Invitee context (only renders if HR filled any of the fields) */}
        {(row.invite_name || row.invite_personal_email || row.invite_department) && (
          <DialogSection label="For">
            <div className="flex flex-wrap items-center gap-x-3 gap-y-1.5 text-xs">
              {row.invite_name && (
                <span className="inline-flex items-center gap-1.5 rounded-full border border-emerald-100 bg-emerald-50/60 px-2 py-0.5 text-emerald-900 dark:border-emerald-900/40 dark:bg-emerald-950/40 dark:text-emerald-200">
                  <User className="h-3 w-3" />
                  {row.invite_name}
                </span>
              )}
              {row.invite_personal_email && (
                <span className="inline-flex items-center gap-1.5 rounded-full border border-zinc-200 bg-zinc-50 px-2 py-0.5 font-mono text-zinc-700 dark:border-zinc-700 dark:bg-zinc-900 dark:text-zinc-300">
                  <Mail className="h-3 w-3" />
                  {row.invite_personal_email}
                </span>
              )}
              {row.invite_department && (
                <span className="inline-flex items-center gap-1.5 rounded-full border border-zinc-200 bg-zinc-50 px-2 py-0.5 text-zinc-700 dark:border-zinc-700 dark:bg-zinc-900 dark:text-zinc-300">
                  {row.invite_department}
                </span>
              )}
            </div>
          </DialogSection>
        )}

        <DialogSection label="Shareable link">
          <div className="rounded-xl border border-emerald-200 bg-emerald-50/60 p-3 dark:border-emerald-900/40 dark:bg-emerald-950/30">
            <div className="flex items-start gap-2">
              <Link2 className="mt-[3px] h-4 w-4 shrink-0 text-emerald-700 dark:text-emerald-400" />
              <code
                className="flex-1 break-all font-mono text-[12px] leading-[1.55] text-emerald-900 dark:text-emerald-100"
                aria-label="Onboarding link"
              >
                {url}
              </code>
            </div>
            <div className="mt-2.5 flex flex-wrap items-center justify-between gap-2 border-t border-emerald-200/60 pt-2.5 dark:border-emerald-900/40">
              <p className="text-[11px] text-emerald-800/80 dark:text-emerald-300/80">
                Single-use — flips to "Submitted" the moment they finish.
              </p>
              <Button
                size="sm"
                variant="outline"
                className={cn(
                  'h-7 border-emerald-300 text-xs transition-colors',
                  justCopied
                    ? 'bg-emerald-600 text-white hover:bg-emerald-600'
                    : 'text-emerald-800 hover:bg-emerald-100 dark:text-emerald-200 dark:hover:bg-emerald-900/40',
                )}
                onClick={copy}
              >
                {justCopied ? (
                  <>
                    <CheckIcon className="mr-1 h-3 w-3" />
                    Copied
                  </>
                ) : (
                  <>
                    <ClipboardCopy className="mr-1 h-3 w-3" />
                    Copy link
                  </>
                )}
              </Button>
            </div>
          </div>
        </DialogSection>

        <DialogSection label="Send via email" last>
          <div className="space-y-2 rounded-lg border border-zinc-200 bg-zinc-50/60 p-3 dark:border-zinc-800 dark:bg-zinc-900/40">
            <div className="flex items-center gap-2 text-[11px]">
              <span className="rounded bg-white px-1.5 py-0.5 font-mono text-zinc-500 ring-1 ring-zinc-200 dark:bg-zinc-950 dark:text-zinc-400 dark:ring-zinc-700">
                To
              </span>
              <span className="truncate text-zinc-800 dark:text-zinc-200">
                {row.invite_personal_email ?? <span className="italic text-zinc-400">no recipient — you'll fill it in</span>}
              </span>
            </div>
            <div className="flex items-center gap-2 text-[11px]">
              <span className="rounded bg-white px-1.5 py-0.5 font-mono text-zinc-500 ring-1 ring-zinc-200 dark:bg-zinc-950 dark:text-zinc-400 dark:ring-zinc-700">
                Subject
              </span>
              <span className="truncate text-zinc-800 dark:text-zinc-200">
                Your Simple.biz onboarding form
              </span>
            </div>
            <pre className="max-h-32 overflow-y-auto whitespace-pre-wrap break-words rounded-md border border-zinc-200 bg-white p-2 font-mono text-[11px] leading-relaxed text-zinc-700 dark:border-zinc-800 dark:bg-zinc-950 dark:text-zinc-300">
              {mailtoBodyRaw.trim()}
            </pre>
            <div className="flex flex-wrap items-center justify-between gap-2 pt-1">
              <p className="text-[11px] italic text-zinc-500 dark:text-zinc-500">
                "Send via webhook" delivers this server-side. The buttons below are manual fallbacks.
              </p>
              <div className="flex flex-wrap gap-1.5">
                <Button
                  size="sm"
                  variant="outline"
                  className="h-7 text-xs"
                  onClick={() => {
                    void navigator.clipboard.writeText(mailtoBodyRaw.trim());
                    toast.success('Email body copied');
                  }}
                >
                  <ClipboardCopy className="mr-1 h-3 w-3" />
                  Copy body
                </Button>
                <Button
                  size="sm"
                  variant="outline"
                  className="h-7 text-xs"
                  onClick={() => {
                    const to = row.invite_personal_email ?? '';
                    const gmail = `https://mail.google.com/mail/?view=cm&fs=1&to=${encodeURIComponent(to)}&su=${mailtoSubject}&body=${encodeURIComponent(mailtoBodyRaw)}`;
                    window.open(gmail, '_blank', 'noopener,noreferrer');
                  }}
                >
                  <Mail className="mr-1 h-3 w-3" />
                  Open in Gmail
                </Button>
              </div>
            </div>
          </div>
        </DialogSection>

        <DialogFooter className="gap-2 pt-2 sm:gap-0">
          <Button variant="outline" size="sm" onClick={onClose}>
            Done
          </Button>
          <Button
            size="sm"
            disabled={sending || sent || !row.invite_personal_email}
            className={cn(
              'shadow-md shadow-emerald-600/25 transition-colors',
              sent
                ? 'bg-emerald-600 text-white hover:bg-emerald-600'
                : 'bg-gradient-to-br from-emerald-500 to-teal-700 text-white hover:from-emerald-500 hover:to-teal-600',
            )}
            onClick={() => void sendViaWebhook()}
            title={!row.invite_personal_email ? 'Add a recipient email to enable this.' : undefined}
          >
            {sending ? (
              <Loader2 className="mr-1 h-3.5 w-3.5 animate-spin" />
            ) : sent ? (
              <CheckIcon className="mr-1 h-3.5 w-3.5" />
            ) : (
              <Send className="mr-1 h-3.5 w-3.5" />
            )}
            {sending ? 'Sending…' : sent ? 'Sent' : 'Send via webhook'}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

// ─── Submission detail dialog ─────────────────────────────────────────────

// Left-to-right order of the detail tabs — drives the directional slide so a
// jump to a later tab enters from the right, an earlier tab from the left.
const DETAIL_TAB_ORDER = ['summary', 'ip_assignment', 'non_solicitation', 'privacy', 'contract', 'download'] as const;

function SubmissionDetailDialog({
  row: rowProp,
  onClose,
}: {
  row: SubmissionRow | null;
  onClose: () => void;
}) {
  const [w8benUrl, setW8benUrl] = useState<string | null>(null);
  const [ipAssignmentUrl, setIpAssignmentUrl] = useState<string | null>(null);
  const [tab, setTab] = useState('summary');
  const [tabDirection, setTabDirection] = useState(0);
  const [downloadingW8Ben, setDownloadingW8Ben] = useState(false);
  const [downloadingIp, setDownloadingIp] = useState(false);

  // Switch tabs while recording which way we moved (1 = rightward, -1 = left)
  // so the panel can slide in the matching direction.
  function selectTab(next: string) {
    const from = DETAIL_TAB_ORDER.indexOf(tab as (typeof DETAIL_TAB_ORDER)[number]);
    const to = DETAIL_TAB_ORDER.indexOf(next as (typeof DETAIL_TAB_ORDER)[number]);
    setTabDirection(to >= from ? 1 : -1);
    setTab(next);
  }

  // Keep the last-opened submission rendered while the dialog plays its close
  // animation. Without this, `row` flips to null on close and the early return
  // unmounts the whole dialog synchronously — Base UI never runs the
  // data-closed:animate-out exit, so the modal just blinks out.
  const [cachedRow, setCachedRow] = useState<SubmissionRow | null>(rowProp);
  useEffect(() => {
    if (rowProp) setCachedRow(rowProp);
  }, [rowProp]);

  // The list query intentionally omits the four heavy signature data-URLs (see
  // LIST_COLUMNS in hr-onboarding-submissions.ts — they're ~99% of the payload
  // and made the table load forever on localhost). We fetch the FULL row on open
  // and merge it over the slim list row so the signature previews below render.
  const [fullRow, setFullRow] = useState<SubmissionRow | null>(null);

  const open = !!rowProp;
  const baseRow = rowProp ?? cachedRow;
  const row =
    baseRow && fullRow && fullRow.id === baseRow.id
      ? { ...baseRow, ...fullRow }
      : baseRow;

  // Opened from a notification deep-link with only an id (no cached list row):
  // every summary field is blank until the full record lands, so show a skeleton
  // instead of a wall of "—". A normal "View" click already carries the list row
  // (which always has `status`), so no skeleton flashes in that path.
  const hydrating = !!baseRow && !baseRow.status && (!fullRow || fullRow.id !== baseRow.id);

  // Reset to the Summary tab each time a submission is opened — guarded so it
  // doesn't snap back to Summary mid-close (rowProp is null while closing).
  useEffect(() => {
    if (rowProp) {
      setTab('summary');
      setTabDirection(0);
    }
  }, [rowProp?.id]);

  // On open, pull the FULL single row (incl. the signature data-URLs the list
  // omits) plus short-lived signed URLs for the W-8BEN / IP-assignment PDFs.
  // Keyed on the opened row's id so it fires once per open, not on every merge.
  useEffect(() => {
    if (!rowProp) return;
    let cancelled = false;
    setFullRow(null);
    setW8benUrl(null);
    setIpAssignmentUrl(null);
    (async () => {
      try {
        const res = await fetch(`/api/hr/onboarding-submissions/${rowProp.id}`, { cache: 'no-store' });
        const json = (await res.json()) as {
          row?: SubmissionRow;
          w8benUrl?: string;
          ipAssignmentUrl?: string;
        };
        if (!cancelled) {
          setFullRow(json.row ?? null);
          setW8benUrl(json.w8benUrl ?? null);
          setIpAssignmentUrl(json.ipAssignmentUrl ?? null);
        }
      } catch {
        if (!cancelled) {
          setFullRow(null);
          setW8benUrl(null);
          setIpAssignmentUrl(null);
        }
      }
    })();
    return () => { cancelled = true; };
  }, [rowProp?.id]);

  if (!row) return null;

  // Force a real download (save file) rather than opening it in the browser.
  // The `download` attribute is ignored cross-origin, so fetch the signed URL
  // into a blob and trigger a same-origin object-URL download instead.
  async function handleDownloadW8Ben() {
    if (!w8benUrl) return;
    setDownloadingW8Ben(true);
    try {
      const res = await fetch(w8benUrl);
      if (!res.ok) throw new Error(`Download failed (HTTP ${res.status})`);
      const blob = await res.blob();
      const objUrl = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = objUrl;
      a.download = row?.w8ben_file_name || 'FW8BEN.pdf';
      document.body.appendChild(a);
      a.click();
      a.remove();
      URL.revokeObjectURL(objUrl);
    } catch (e) {
      toast.error(e instanceof Error ? e.message : 'Download failed');
    } finally {
      setDownloadingW8Ben(false);
    }
  }

  // Same blob-download trick for the generated IP-assignment PDF.
  async function handleDownloadIp() {
    if (!ipAssignmentUrl) return;
    setDownloadingIp(true);
    try {
      const res = await fetch(ipAssignmentUrl);
      if (!res.ok) throw new Error(`Download failed (HTTP ${res.status})`);
      const blob = await res.blob();
      const objUrl = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = objUrl;
      a.download = row?.ip_assignment_file_name || 'IP-Assignment.pdf';
      document.body.appendChild(a);
      a.click();
      a.remove();
      URL.revokeObjectURL(objUrl);
    } catch (e) {
      toast.error(e instanceof Error ? e.message : 'Download failed');
    } finally {
      setDownloadingIp(false);
    }
  }

  const detailTabs = [
    { value: 'summary', label: 'Summary' },
    { value: 'ip_assignment', label: 'IP Assignment', signed: !!row.ip_agreement_signature },
    { value: 'non_solicitation', label: 'Non-Solicitation', signed: !!row.non_solicitation_signature },
    { value: 'privacy', label: 'Privacy', signed: !!row.privacy_signature },
    { value: 'contract', label: 'Contract', signed: !!row.contract_signature },
    { value: 'download', label: 'Download' },
  ] as const;

  return (
    <Dialog open={open} onOpenChange={(o) => !o && onClose()}>
      <DialogContent className="flex max-h-[88vh] w-[min(94vw,920px)] max-w-[min(94vw,920px)] flex-col gap-0 overflow-hidden p-0 data-closed:slide-out-to-bottom-4 data-closed:duration-200 sm:max-w-[min(94vw,920px)]">
        <DialogHeader className="shrink-0 px-6 pt-5 pr-12">
          <DialogTitle className="text-base">
            {row.full_name ?? row.invite_name ?? 'Onboarding submission'}
          </DialogTitle>
          <DialogDescription className="text-xs">
            {hydrating
              ? 'Loading submission…'
              : `Submitted ${fmtDateTime(row.submitted_at)} · ${row.invite_department ?? '—'}`}
          </DialogDescription>
        </DialogHeader>

        {hydrating ? (
          <SubmissionDetailSkeleton />
        ) : (
        /* Folder-style tabs: the active tab connects seamlessly into the
            panel below it (shared white edge, broken baseline). */
        <div className="flex min-h-0 flex-1 flex-col px-6 pb-6 pt-4">
          <TabsPrimitive.Root value={tab} onValueChange={(v) => selectTab(v as string)} className="shrink-0">
            <TabsPrimitive.List className="flex flex-wrap items-end gap-1 border-b border-zinc-200/80 dark:border-zinc-700/70">
              {detailTabs.map((t) => (
                <TabsPrimitive.Tab
                  key={t.value}
                  value={t.value}
                  className={cn(
                    'relative -mb-px flex items-center gap-1.5 rounded-t-lg border px-4 py-2 text-sm font-medium',
                    'transition-[background-color,color,border-color,box-shadow] duration-200 ease-out',
                    'cursor-pointer select-none border-transparent text-zinc-500 outline-none',
                    'hover:bg-white/50 hover:text-zinc-800 focus-visible:ring-2 focus-visible:ring-emerald-500/40',
                    'dark:text-zinc-400 dark:hover:bg-zinc-800/40 dark:hover:text-zinc-200',
                    'data-[active]:z-10 data-[active]:border-zinc-200/90 data-[active]:border-b-white data-[active]:bg-white data-[active]:text-zinc-900 data-[active]:shadow-[0_-1px_8px_-2px_rgba(16,24,40,0.08)]',
                    'dark:data-[active]:border-zinc-700/80 dark:data-[active]:border-b-zinc-950 dark:data-[active]:bg-zinc-950 dark:data-[active]:text-white',
                  )}
                >
                  {t.label}
                  {'signed' in t ? <SignedDot signed={t.signed} /> : null}
                </TabsPrimitive.Tab>
              ))}
            </TabsPrimitive.List>
          </TabsPrimitive.Root>

          {/* Connected content panel. overflow-x-hidden clips the horizontal
              slide so it never spawns a scrollbar mid-transition. */}
          <div className="min-h-0 flex-1 overflow-y-auto overflow-x-hidden rounded-b-xl rounded-tr-xl border border-t-0 border-zinc-200/90 bg-white p-5 shadow-sm dark:border-zinc-700/80 dark:bg-zinc-950">
            <AnimatePresence mode="wait" initial={false} custom={tabDirection}>
              <motion.div
                key={tab}
                custom={tabDirection}
                variants={{
                  enter: (dir: number) => ({ opacity: 0, x: dir >= 0 ? 36 : -36 }),
                  center: { opacity: 1, x: 0 },
                  exit: (dir: number) => ({ opacity: 0, x: dir >= 0 ? -36 : 36 }),
                }}
                initial="enter"
                animate="center"
                exit="exit"
                transition={{ duration: 0.18, ease: [0.22, 1, 0.36, 1] }}
              >
                {tab === 'summary' ? (
                  <div className="grid gap-x-8 gap-y-5 md:grid-cols-2">
                    {/* Left column — text-based details */}
                    <div className="space-y-5">
                      <DetailSection title="Personal info">
                        <DetailRow label="Full name" value={row.full_name} />
                        {/* Structured parts the hire typed (source of truth) —
                            shown when the row has them (post-split-migration). */}
                        {(row.first_name || row.last_name) && (
                          <>
                            <DetailRow label="First name" value={row.first_name} />
                            <DetailRow label="Last name" value={row.last_name} />
                            {row.name_extension && (
                              <DetailRow label="Extension" value={row.name_extension} />
                            )}
                          </>
                        )}
                        {/* Lead Gen only — the hire's self-chosen dialer nickname and
                            the auto-minted CallTools username ("Mikey J. T."). */}
                        {(row.calltools_nickname || row.calltools_username) && (
                          <>
                            <DetailRow label="CallTools nickname" value={row.calltools_nickname} />
                            <DetailRow label="CallTools username" value={row.calltools_username} mono copyable />
                          </>
                        )}
                        <DetailRow label="Phone" value={row.phone} />
                        <DetailRow label="Email" value={row.email} mono />
                        <DetailRow label="Country" value={row.country} />
                        <DetailRow
                          label="Currency"
                          value={currencyForCountry(row.country) ?? undefined}
                        />
                        {row.address_street || row.address_city || row.address_state || row.address_province || row.address_region || row.address_postal_code ? (
                          <>
                            <DetailRow label="Street address" value={row.address_street} wrap />
                            <DetailRow label="City / Municipality" value={row.address_city} />
                            <DetailRow label="State" value={row.address_state} />
                            <DetailRow label="Province" value={row.address_province} />
                            <DetailRow label="Region" value={row.address_region} />
                            <DetailRow label="Postal code" value={row.address_postal_code} />
                          </>
                        ) : (
                          <DetailRow label="Address" value={row.location} wrap />
                        )}
                      </DetailSection>

                      <DetailSection title="IP Assignment">
                        <DetailRow
                          label="Acknowledged?"
                          value={row.ip_agreement_agreed ? 'Yes' : row.ip_agreement_signature ? 'Yes' : '—'}
                        />
                        <DetailRow label="Signed by" value={row.ip_agreement_name} />
                        <DetailRow label="Date" value={formatLongDate(row.ip_agreement_date) || '—'} />
                        {(row.ip_assignment_file_name || row.ip_agreement_signature) && (
                          <div className="flex items-center justify-between gap-2 rounded-lg border border-emerald-100 bg-emerald-50/40 px-3 py-2 text-xs">
                            <div className="flex items-center gap-2 truncate">
                              <FileText className="h-4 w-4 shrink-0 text-emerald-700" />
                              <span className="truncate">{row.ip_assignment_file_name || 'IP-Assignment.pdf'}</span>
                            </div>
                            {!row.ip_assignment_file_path ? (
                              <span className="shrink-0 text-[11px] italic text-zinc-400">PDF not generated</span>
                            ) : ipAssignmentUrl ? (
                              <div className="flex shrink-0 items-center gap-1.5">
                                <a
                                  href={ipAssignmentUrl}
                                  target="_blank"
                                  rel="noopener noreferrer"
                                  className="inline-flex items-center gap-1 rounded-md border border-emerald-300 bg-white px-2 py-1 text-[11px] font-medium text-emerald-800 transition-colors hover:bg-emerald-50"
                                  title="Open the IP Assignment in a new tab"
                                >
                                  <Eye className="h-3 w-3" />
                                  View
                                </a>
                                <button
                                  type="button"
                                  onClick={handleDownloadIp}
                                  disabled={downloadingIp}
                                  className="inline-flex items-center gap-1 rounded-md border border-emerald-600 bg-emerald-600 px-2 py-1 text-[11px] font-medium text-white transition-colors hover:bg-emerald-700 disabled:opacity-60"
                                  title="Download the signed IP Assignment PDF"
                                >
                                  {downloadingIp ? (
                                    <Loader2 className="h-3 w-3 animate-spin" />
                                  ) : (
                                    <Download className="h-3 w-3" />
                                  )}
                                  Download
                                </button>
                              </div>
                            ) : (
                              <Loader2 className="h-3 w-3 animate-spin text-emerald-700" />
                            )}
                          </div>
                        )}
                      </DetailSection>

                      <DetailSection title="W-8BEN">
                        <DetailRow
                          label="Applicable?"
                          value={row.w8ben_applicable === null ? '—' : row.w8ben_applicable ? 'Yes — non-US' : 'No — US-based'}
                        />
                        {row.w8ben_file_name && (
                          <div className="flex items-center justify-between gap-2 rounded-lg border border-emerald-100 bg-emerald-50/40 px-3 py-2 text-xs">
                            <div className="flex items-center gap-2 truncate">
                              <FileText className="h-4 w-4 shrink-0 text-emerald-700" />
                              <span className="truncate">{row.w8ben_file_name}</span>
                            </div>
                            {w8benUrl ? (
                              <div className="flex shrink-0 items-center gap-1.5">
                                <a
                                  href={w8benUrl}
                                  target="_blank"
                                  rel="noopener noreferrer"
                                  className="inline-flex items-center gap-1 rounded-md border border-emerald-300 bg-white px-2 py-1 text-[11px] font-medium text-emerald-800 transition-colors hover:bg-emerald-50"
                                  title="Open the W-8BEN in a new tab"
                                >
                                  <Eye className="h-3 w-3" />
                                  View
                                </a>
                                <button
                                  type="button"
                                  onClick={handleDownloadW8Ben}
                                  disabled={downloadingW8Ben}
                                  className="inline-flex items-center gap-1 rounded-md border border-emerald-600 bg-emerald-600 px-2 py-1 text-[11px] font-medium text-white transition-colors hover:bg-emerald-700 disabled:opacity-60"
                                  title="Download the W-8BEN file"
                                >
                                  {downloadingW8Ben ? (
                                    <Loader2 className="h-3 w-3 animate-spin" />
                                  ) : (
                                    <Download className="h-3 w-3" />
                                  )}
                                  Download
                                </button>
                              </div>
                            ) : (
                              <Loader2 className="h-3 w-3 animate-spin text-emerald-700" />
                            )}
                          </div>
                        )}
                      </DetailSection>

                      <DetailSection title="Payment method">
                        {row.payment_method === 'wires' ? (
                          <WireDetailsCard row={row} />
                        ) : row.payment_method === 'hurupay' ? (
                          <>
                            <DetailRow label="Method" value="Hurupay" />
                            <DetailRow label="Hurupay email" value={row.hurupay_email} mono copyable />
                          </>
                        ) : (
                          <DetailRow label="Method" value="—" />
                        )}
                      </DetailSection>
                    </div>

                    {/* Right column — signatures */}
                    <div className="space-y-5">
                      <DetailSection title="Agreement signatures">
                        <SignaturePreview label="Non-solicitation" src={row.non_solicitation_signature} />
                        <SignaturePreview label="Privacy" src={row.privacy_signature} />
                        <SignaturePreview label="Contract worker agreement" src={row.contract_signature} />
                        <DetailRow label="Contract date" value={fmtDate(row.contract_date)} />
                      </DetailSection>
                    </div>
                  </div>
                ) : tab === 'ip_assignment' ? (
                  <AgreementTab
                    title={AGREEMENT_TITLES.intellectualProperty}
                    signatureSrc={row.ip_agreement_signature}
                    signedOn={row.ip_agreement_signature ? formatLongDate(row.ip_agreement_date) : null}
                  >
                    <IntellectualPropertyText />
                  </AgreementTab>
                ) : tab === 'non_solicitation' ? (
                  <AgreementTab
                    title={AGREEMENT_TITLES.nonSolicitation}
                    signatureSrc={row.non_solicitation_signature}
                  >
                    <NonSolicitationText />
                  </AgreementTab>
                ) : tab === 'privacy' ? (
                  <AgreementTab title={AGREEMENT_TITLES.privacy} signatureSrc={row.privacy_signature}>
                    <PrivacyText />
                  </AgreementTab>
                ) : tab === 'contract' ? (
                  <AgreementTab
                    title={AGREEMENT_TITLES.contract}
                    signatureSrc={row.contract_signature}
                    signedOn={row.contract_signature ? fmtDate(row.contract_date) : null}
                  >
                    <ContractWorkerText />
                  </AgreementTab>
                ) : (
                  <ContractsDownloadTab
                    row={row}
                    signaturesReady={!!fullRow && fullRow.id === row.id}
                  />
                )}
              </motion.div>
            </AnimatePresence>
          </div>
        </div>
        )}

        {/* mx-0/mb-0 cancel DialogFooter's default -mx-4/-mb-4 (those assume the
            dialog's default p-4; this modal is p-0, so without resetting them the
            footer overflows and the Close button hugs the corner). */}
        <DialogFooter className="mx-0 mb-0 shrink-0 rounded-b-xl border-t border-zinc-200/70 bg-white/70 px-6 py-4 backdrop-blur-sm dark:border-zinc-800/70 dark:bg-zinc-950/50 sm:justify-end sm:gap-0">
          <Button variant="outline" size="sm" onClick={onClose}>
            <CheckCircle2 className="mr-1 h-3 w-3" />
            Close
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

// Loading placeholder for the detail dialog when it's opened from a notification
// deep-link (only the submission id is known) and the full record is still in
// flight. Mirrors the tab bar + two-column summary layout so the modal doesn't
// jump when the real content lands.
function SubmissionDetailSkeleton() {
  return (
    <div className="flex min-h-0 flex-1 flex-col px-6 pb-6 pt-4" aria-busy="true">
      {/* Tab bar */}
      <div className="flex flex-wrap items-end gap-1 border-b border-zinc-200/80 dark:border-zinc-700/70">
        {[64, 96, 104, 72, 80, 84].map((w, i) => (
          <Skeleton key={i} className="mb-1 h-8 rounded-t-lg" style={{ width: w }} />
        ))}
      </div>
      {/* Summary panel */}
      <div className="min-h-0 flex-1 rounded-b-xl rounded-tr-xl border border-t-0 border-zinc-200/90 bg-white p-5 shadow-sm dark:border-zinc-700/80 dark:bg-zinc-950">
        <div className="grid gap-x-8 gap-y-6 md:grid-cols-2">
          {[0, 1].map((col) => (
            <div key={col} className="space-y-6">
              {[0, 1].map((sec) => (
                <div key={sec} className="space-y-3">
                  <Skeleton className="h-2.5 w-28" />
                  {[0, 1, 2, 3].map((r) => (
                    <div key={r} className="flex items-center justify-between gap-4">
                      <Skeleton className="h-3 w-20" />
                      <Skeleton className="h-3 w-32" />
                    </div>
                  ))}
                </div>
              ))}
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}

function DetailSection({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <section>
      <h3 className="mb-2 text-[10px] font-semibold uppercase tracking-[0.18em] text-emerald-700/80">
        {title}
      </h3>
      <div className="space-y-1.5">{children}</div>
    </section>
  );
}

/** Small copy-to-clipboard button used for sensitive payout fields (account
 *  number, SWIFT, etc.). Flashes a check on success. */
function CopyIconButton({ value, label }: { value: string; label: string }) {
  const [copied, setCopied] = useState(false);
  return (
    <button
      type="button"
      onClick={() => {
        void navigator.clipboard.writeText(value);
        setCopied(true);
        toast.success(`${label} copied`);
        setTimeout(() => setCopied(false), 1200);
      }}
      title={`Copy ${label}`}
      aria-label={`Copy ${label}`}
      className="shrink-0 rounded p-0.5 text-zinc-400 transition-colors hover:bg-zinc-100 hover:text-zinc-700 dark:hover:bg-zinc-800 dark:hover:text-zinc-200"
    >
      {copied ? (
        <CheckIcon className="h-3 w-3 text-emerald-500" />
      ) : (
        <ClipboardCopy className="h-3 w-3" />
      )}
    </button>
  );
}

function DetailRow({
  label,
  value,
  mono,
  className,
  copyable,
  wrap,
}: {
  label: string;
  value: string | null | undefined;
  mono?: boolean;
  className?: string;
  /** Show a copy-to-clipboard icon (and never truncate the value). */
  copyable?: boolean;
  /** Show the value in full (wrap instead of truncate). */
  wrap?: boolean;
}) {
  const hasValue = value != null && value !== '';
  const showFull = copyable || wrap;
  return (
    <div className={cn('flex items-start justify-between gap-3 text-xs', className)}>
      <span className="shrink-0 text-zinc-500">{label}</span>
      <div className="flex min-w-0 flex-1 items-start justify-end gap-1">
        <span
          className={cn(
            'min-w-0 text-right text-zinc-800 dark:text-zinc-200',
            mono && 'font-mono',
            showFull ? 'break-all' : 'truncate',
          )}
          title={hasValue ? (value as string) : undefined}
        >
          {hasValue ? value : '—'}
        </span>
        {copyable && hasValue && <CopyIconButton value={value as string} label={label} />}
      </div>
    </div>
  );
}

/** Wire-transfer payout details, laid out as a clean "bank card" so long
 *  account numbers / addresses read in full (no cramped 2-col truncation) and
 *  the account number + SWIFT are one-click copyable. */
function WireDetailsCard({ row }: { row: SubmissionRow }) {
  const address =
    row.bank_full_address?.trim() ||
    [row.bank_street, row.bank_city, row.bank_province, row.bank_postal_code]
      .map((s) => s?.trim())
      .filter(Boolean)
      .join(', ');

  const Field = ({
    label,
    value,
    big,
  }: {
    label: string;
    value: string | null;
    big?: boolean;
  }) => (
    <div>
      <p className="text-[10px] font-semibold uppercase tracking-widest text-zinc-400 dark:text-zinc-500">
        {label}
      </p>
      <div className="mt-0.5 flex items-center gap-1.5">
        <span
          className={cn(
            'select-all break-all font-mono font-semibold text-zinc-900 dark:text-zinc-100',
            big ? 'text-base tracking-wide' : 'text-sm',
          )}
        >
          {value?.trim() || '—'}
        </span>
        {value?.trim() && <CopyIconButton value={value.trim()} label={label} />}
      </div>
    </div>
  );

  return (
    <div className="overflow-hidden rounded-xl border border-emerald-200/70 bg-gradient-to-br from-emerald-50/70 via-white to-teal-50/40 shadow-sm dark:border-emerald-900/40 dark:from-emerald-950/30 dark:via-zinc-950 dark:to-teal-950/20">
      {/* Header: bank + account holder */}
      <div className="flex items-center justify-between gap-3 border-b border-emerald-200/60 bg-white/60 px-4 py-2.5 dark:border-emerald-900/40 dark:bg-zinc-950/40">
        <div className="flex min-w-0 items-center gap-2.5">
          <span className="flex h-8 w-8 shrink-0 items-center justify-center rounded-lg bg-gradient-to-br from-emerald-500 to-teal-700 text-white shadow-sm shadow-emerald-600/25">
            <Landmark className="h-4 w-4" />
          </span>
          <div className="min-w-0">
            <p className="truncate text-[13px] font-semibold text-zinc-900 dark:text-zinc-100">
              {row.bank_full_name?.trim() || 'Bank'}
            </p>
            <p className="truncate text-[11px] text-zinc-500">
              {row.bank_account_name?.trim() || '—'}
            </p>
          </div>
        </div>
        <span className="shrink-0 rounded-full border border-emerald-300/70 bg-emerald-50 px-2 py-0.5 text-[10px] font-semibold uppercase tracking-wider text-emerald-700 dark:border-emerald-800 dark:bg-emerald-950/40 dark:text-emerald-300">
          Wire
        </span>
      </div>

      {/* Account number (hero) + SWIFT */}
      <div className="grid gap-3 px-4 py-3 sm:grid-cols-2">
        <Field label="Account number" value={row.bank_account_number} big />
        <Field label="SWIFT / BIC" value={row.bank_swift_code} />
      </div>

      {/* Address */}
      <div className="border-t border-emerald-200/50 px-4 py-2.5 dark:border-emerald-900/30">
        <p className="text-[10px] font-semibold uppercase tracking-widest text-zinc-400 dark:text-zinc-500">
          Address
        </p>
        <p className="mt-0.5 text-xs leading-relaxed text-zinc-700 dark:text-zinc-300">
          {address || '—'}
        </p>
      </div>
    </div>
  );
}

function SignaturePreview({ label, src }: { label: string; src: string | null }) {
  if (!src) {
    return (
      <div className="flex items-center justify-between text-xs">
        <span className="text-zinc-500">{label}</span>
        <span className="text-zinc-400">No signature</span>
      </div>
    );
  }
  return (
    // Signatures are dark ink, so the canvas stays white in both themes — which
    // means the label must be dark (not the default light-on-dark) to stay
    // readable against it.
    <div className="rounded-lg border border-zinc-200 bg-white p-2 dark:border-zinc-300">
      <div className="mb-1 text-[11px] font-medium text-zinc-600 dark:text-zinc-900">{label}</div>
      {/* eslint-disable-next-line @next/next/no-img-element */}
      <img src={src} alt={`${label} signature`} className="max-h-24 w-full object-contain" />
    </div>
  );
}

// Small colored dot in a tab trigger — green when that agreement has a
// signature on file, amber when it's still unsigned.
function SignedDot({ signed }: { signed: boolean }) {
  return (
    <span
      className={cn('ml-1.5 h-1.5 w-1.5 rounded-full', signed ? 'bg-emerald-500' : 'bg-amber-400')}
      aria-label={signed ? 'Signed' : 'Not signed'}
    />
  );
}

// One granular agreement tab: the legal copy the hiree saw, a signed/not-signed
// badge, and the captured signature image (or a clear "not signed" notice).
function AgreementTab({
  title,
  signatureSrc,
  signedOn,
  children,
}: {
  title: string;
  signatureSrc: string | null;
  signedOn?: string | null;
  children: React.ReactNode;
}) {
  const signed = !!signatureSrc;
  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between gap-3">
        <h3 className="text-sm font-semibold text-zinc-900 dark:text-zinc-100">{title}</h3>
        <span
          className={cn(
            'inline-flex shrink-0 items-center gap-1 rounded-full px-2 py-0.5 text-[10px] font-semibold',
            signed
              ? 'bg-emerald-100 text-emerald-700 dark:bg-emerald-950/40 dark:text-emerald-300'
              : 'bg-amber-100 text-amber-700 dark:bg-amber-950/40 dark:text-amber-300',
          )}
        >
          {signed ? <CheckCircle2 className="h-3 w-3" /> : null}
          {signed ? 'Signed' : 'Not signed'}
        </span>
      </div>

      <div className="max-h-64 overflow-y-auto rounded-lg border border-zinc-200 bg-zinc-50/50 p-4 dark:border-zinc-800 dark:bg-zinc-900/40">
        {children}
      </div>

      <div className="rounded-lg border border-zinc-200 bg-white p-3 dark:border-zinc-300">
        <div className="mb-1.5 flex items-center justify-between">
          <span className="text-[11px] font-medium uppercase tracking-wide text-zinc-500 dark:text-zinc-600">
            Signature
          </span>
          {signedOn ? (
            <span className="text-[11px] text-zinc-500 dark:text-zinc-600">Dated {signedOn}</span>
          ) : null}
        </div>
        {signed ? (
          // eslint-disable-next-line @next/next/no-img-element
          <img
            src={signatureSrc!}
            alt={`${title} signature`}
            className="max-h-32 w-full object-contain"
          />
        ) : (
          <p className="py-4 text-center text-xs text-zinc-400">
            No signature captured — the hiree has not signed this agreement.
          </p>
        )}
      </div>
    </div>
  );
}

/** The "Download" tab: compiles all four onboarding agreements into one
 *  Simple-branded PDF (built client-side from the row already in the modal),
 *  with each captured signature baked in and a per-page footer carrying the
 *  agreement's signed date + the packet's generated date. */
function ContractsDownloadTab({
  row,
  signaturesReady,
}: {
  row: SubmissionRow;
  /** The list row omits the heavy signature data-URLs; this flips true once
   *  the full-row fetch has merged them in, so we never bake blank lines. */
  signaturesReady: boolean;
}) {
  const [generating, setGenerating] = useState(false);

  const submittedOn = row.submitted_at ? fmtDate(row.submitted_at) : null;
  const docs = [
    {
      label: AGREEMENT_TITLES.intellectualProperty,
      signed: !!row.ip_agreement_signature || !!row.ip_agreement_agreed,
      signedOn: row.ip_agreement_date ? formatLongDate(row.ip_agreement_date) : submittedOn,
    },
    {
      label: AGREEMENT_TITLES.nonSolicitation,
      signed: !!row.non_solicitation_signature,
      signedOn: submittedOn,
    },
    {
      label: AGREEMENT_TITLES.privacy,
      signed: !!row.privacy_signature,
      signedOn: submittedOn,
    },
    {
      label: AGREEMENT_TITLES.contract,
      signed: !!row.contract_signature,
      signedOn: row.contract_date ? fmtDate(row.contract_date) : submittedOn,
    },
  ];
  const signedCount = docs.filter((d) => d.signed).length;
  const allSigned = signedCount === docs.length;

  async function handleDownload() {
    setGenerating(true);
    try {
      await downloadContractsPacketPdf(row);
    } catch (e) {
      toast.error(e instanceof Error ? e.message : 'Could not generate the contracts PDF');
    } finally {
      setGenerating(false);
    }
  }

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between gap-3">
        <h3 className="text-sm font-semibold text-zinc-900 dark:text-zinc-100">
          Signed contracts packet
        </h3>
        <span
          className={cn(
            'inline-flex shrink-0 items-center gap-1 rounded-full px-2 py-0.5 text-[10px] font-semibold',
            allSigned
              ? 'bg-emerald-100 text-emerald-700 dark:bg-emerald-950/40 dark:text-emerald-300'
              : 'bg-amber-100 text-amber-700 dark:bg-amber-950/40 dark:text-amber-300',
          )}
        >
          {allSigned ? <CheckCircle2 className="h-3 w-3" /> : null}
          {signedCount} of {docs.length} signed
        </span>
      </div>

      <p className="text-xs leading-relaxed text-zinc-500 dark:text-zinc-400">
        Compiles the agreements below into one Simple-branded PDF — each starts on its own
        page with the exact copy the hire saw plus their captured signature, and every page&apos;s
        footer shows the date that agreement was signed and the date the file was generated.
      </p>

      <ul className="divide-y divide-zinc-100 overflow-hidden rounded-lg border border-zinc-200 bg-zinc-50/50 dark:divide-zinc-800 dark:border-zinc-800 dark:bg-zinc-900/40">
        {docs.map((d) => (
          <li key={d.label} className="flex items-center justify-between gap-3 px-3 py-2.5">
            <div className="flex min-w-0 items-center gap-2">
              <FileText className="h-4 w-4 shrink-0 text-emerald-700 dark:text-emerald-400" />
              <span
                className="truncate text-xs font-medium text-zinc-800 dark:text-zinc-200"
                title={d.label}
              >
                {d.label}
              </span>
            </div>
            {d.signed ? (
              <span className="shrink-0 text-[11px] text-emerald-700 dark:text-emerald-300">
                Signed{d.signedOn ? ` ${d.signedOn}` : ''}
              </span>
            ) : (
              <span className="shrink-0 text-[11px] font-medium text-amber-600 dark:text-amber-400">
                Not signed
              </span>
            )}
          </li>
        ))}
      </ul>

      <div className="flex flex-col gap-2 sm:flex-row sm:items-center sm:justify-between">
        <p className="text-[11px] text-zinc-400 dark:text-zinc-500">
          Unsigned agreements are included with a blank signature line.
        </p>
        <Button
          size="sm"
          disabled={generating || !signaturesReady}
          onClick={() => void handleDownload()}
          className="bg-gradient-to-br from-emerald-500 to-teal-700 text-white shadow-md shadow-emerald-600/25 transition-colors hover:from-emerald-500 hover:to-teal-600"
          title={!signaturesReady ? 'Still loading the captured signatures…' : undefined}
        >
          {generating || !signaturesReady ? (
            <Loader2 className="mr-1 h-3.5 w-3.5 animate-spin" />
          ) : (
            <Download className="mr-1 h-3.5 w-3.5" />
          )}
          {!signaturesReady ? 'Loading signatures…' : generating ? 'Generating…' : 'Download PDF'}
        </Button>
      </div>
    </div>
  );
}

// ─── Filter pill ──────────────────────────────────────────────────────────

function FilterPill({
  label,
  count,
  active,
  onClick,
}: {
  label: string;
  count: number;
  active: boolean;
  onClick: () => void;
}) {
  const reduce = useReducedMotion();
  return (
    <button
      type="button"
      onClick={onClick}
      role="tab"
      aria-selected={active}
      className={cn(
        'relative flex items-center gap-1.5 rounded-md px-2.5 py-1 text-[12px] font-medium transition-colors',
        active
          ? 'text-white'
          : 'text-zinc-600 hover:bg-emerald-50 hover:text-emerald-900 dark:text-zinc-300 dark:hover:bg-emerald-950/40 dark:hover:text-emerald-100',
      )}
    >
      {/* Shared indicator — glides between pills via layoutId. */}
      {active && (
        <motion.span
          layoutId="hr-onboarding-filter"
          className="absolute inset-0 rounded-md bg-gradient-to-r from-emerald-500 to-teal-700 shadow-sm shadow-emerald-600/25"
          transition={{ duration: reduce ? 0 : 0.28, ease: [0.22, 1, 0.36, 1] }}
        />
      )}
      <span className="relative z-10">{label}</span>
      <span
        className={cn(
          'relative z-10 rounded-full px-1.5 text-[10px] tabular-nums',
          active ? 'bg-white/20 text-white' : 'bg-zinc-100 text-zinc-600 dark:bg-zinc-800 dark:text-zinc-400',
        )}
      >
        {count}
      </span>
    </button>
  );
}
