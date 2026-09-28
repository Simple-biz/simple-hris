'use client';

/**
 * The read-only panels of one person's record, shared by the People popup
 * (`PersonDetailDialog` in `PeopleTab.tsx`) and the Search Bar's person page
 * (`PeopleBankSearch.tsx`). Kane, 2026-09-28: *"Search Bar — should have the
 * profile, payroll, PAB Calendar not just banking"*.
 *
 * Each panel was MOVED here out of the popup, not rewritten, the same way
 * `payout-record.tsx` took the Banking body (`people-bank-search.md` §5). Never
 * fork a copy back into either host: two copies of one person's record are how
 * the two views come to disagree about the same week.
 *
 * - **Profile**: `ProfileSnapshotCards` + `ProfileReadView`, verbatim. Editing
 *   stays in the popup; the Search Bar page has no write path.
 * - **Payroll**: `PayrollHistoryList` over `GET /api/people/[email]/payroll`,
 *   which since 2026-09-28 carries the bonuses (`people-payroll-history.md`).
 *   The fetch (`usePersonPayWeeks`) and the page index belong to the HOST, so the
 *   popup's Payroll tab survives a tab switch without re-reading.
 * - **PAB Calendar**: `PersonPabPanel`, the loader + calendar pair. The host
 *   mounts it on first visit and keeps it mounted (hidden), as before.
 */

import { useCallback, useEffect, useRef, useState } from 'react';
import type { ReactNode } from 'react';
import { AnimatePresence, motion } from 'motion/react';
import {
  AtSign, Building2, CalendarDays, Check, Contact as ContactIcon, Copy, FileText, Hourglass, IdCard,
  Mail, MapPin, Phone, Sparkles, User,
} from 'lucide-react';
import type { LucideIcon } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { Skeleton } from '@/components/ui/skeleton';
import EmployeePabCalendar from '@/components/employee/EmployeePabCalendar';
import PabCalendarLoader from '@/components/employee/PabCalendarLoader';
import { PayStubStatement } from '@/components/paystub/PayStubStatement';
import { formatDeptLabel } from '@/lib/departments/hsl-subdept';
import { parseNameParts } from '@/lib/name/name-parts';
import type { PayrollHistoryWeek } from '@/lib/people/payroll-history';
import { cn } from '@/lib/utils';
import {
  fmtHours, fmtMoney, formatDay, formatHireDate, formatPeriodRange, tenureFrom, type Currency,
} from './people-format';
import type { Accent } from './PeopleTab';

/* ── The four tabs, one list for both hosts ───────────────────────────────── */

export type PersonTab = 'profile' | 'banking' | 'payroll' | 'pab';

export const PERSON_TABS: ReadonlyArray<readonly [PersonTab, string]> = [
  ['profile', 'Profile'],
  ['banking', 'Banking'],
  ['payroll', 'Payroll'],
  ['pab', 'PAB Calendar'],
];

/** The roster fields the Profile panels read. PeopleTab's `RosterRow` satisfies it. */
export interface PersonProfileRow {
  employee_id: string | null;
  name: string | null;
  work_email: string | null;
  personal_email: string | null;
  alternate_work_emails: string[];
  department: string | null;
  start_date: string | null;
  city: string | null;
  province: string | null;
  full_address: string | null;
  phone_number: string | null;
  location: string | null;
  rate: { regular: number | null; ot: number | null; currency: Currency; source: 'employee' | 'sheet' | 'department' | null };
  hours: {
    thisWeek: number;
    ot: number;
    inProgress: boolean;
    projectedHours: number | null;
    projectedOt: number | null;
  };
}

/* ── Profile ──────────────────────────────────────────────────────────────── */

/** Hours this week · on track for · pay rate. */
export function ProfileSnapshotCards({ row }: { row: PersonProfileRow }) {
  return (
    <div className="grid grid-cols-2 gap-3 sm:grid-cols-3">
      <StatCard label="Hours this week" value={fmtHours(row.hours.thisWeek)} sub={row.hours.ot > 0 ? `+${fmtHours(row.hours.ot)} OT` : 'no OT'} />
      <StatCard
        label="On track for"
        value={row.hours.inProgress && row.hours.projectedHours != null ? fmtHours(row.hours.projectedHours) : '—'}
        sub={
          row.hours.inProgress && (row.hours.projectedOt ?? 0) > 0
            ? `${fmtHours(row.hours.projectedOt)} projected OT`
            : row.hours.inProgress ? 'within 40h' : 'week complete'
        }
      />
      <StatCard
        label="Pay rate"
        value={row.rate.regular != null ? `${fmtMoney(row.rate.regular, row.rate.currency)}/hr` : 'not set'}
        sub={row.rate.ot != null ? `OT ${fmtMoney(row.rate.ot, row.rate.currency)}` : (row.rate.source ?? '')}
      />
    </div>
  );
}

/** Identity & contact, read-only: the name banner and the two grouped cards. */
export function ProfileReadView({ row, accent }: { row: PersonProfileRow; accent: Accent }) {
  // Read-only breakdown (derived from the stored name).
  const viewParts = parseNameParts(row.name);
  return (
    <div className="space-y-2.5">
      {/* Name banner — the composed display name reads at a glance,
          with the go-by nickname called out as an accent pill. */}
      <div className={cn('flex items-center gap-2.5 rounded-lg border border-zinc-200/80 px-3 py-2 dark:border-zinc-800', accent.chipBg)}>
        <span className={cn('flex h-9 w-9 shrink-0 items-center justify-center rounded-full text-sm font-semibold', accent.chipText, 'bg-white/70 dark:bg-zinc-950/40')}>
          {(viewParts.first?.[0] ?? row.name?.[0] ?? '?').toUpperCase()}
        </span>
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-2">
            <p className="truncate text-[14px] font-semibold text-zinc-900 dark:text-zinc-50">
              {[viewParts.first, viewParts.middle, viewParts.last, viewParts.extension].filter(Boolean).join(' ') || row.name || '—'}
            </p>
            {viewParts.nickname && (
              <span className={cn('shrink-0 rounded-full bg-white/70 px-2 py-0.5 text-[10.5px] font-medium dark:bg-zinc-950/40', accent.chipText)}>
                “{viewParts.nickname}”
              </span>
            )}
          </div>
          <p className="truncate text-[11.5px] text-zinc-500 dark:text-zinc-400">
            {formatDeptLabel(row.department) || 'No department'}
            {row.employee_id && <span className="font-mono"> · {row.employee_id}</span>}
          </p>
        </div>
      </div>

      {/* Two grouped cards: who they are, and how to reach them. */}
      <div className="grid grid-cols-1 items-start gap-2.5 sm:grid-cols-2">
        <InfoCard icon={User} title="Identity" accent={accent}>
          <InfoRow icon={User} label="First name" value={viewParts.first || null} />
          <InfoRow icon={User} label="Last name" value={viewParts.last || null} />
          {viewParts.middle && <InfoRow icon={User} label="Middle name" value={viewParts.middle} />}
          {viewParts.extension && <InfoRow icon={User} label="Extension" value={viewParts.extension} />}
          {viewParts.nickname && <InfoRow icon={User} label="Nickname" value={viewParts.nickname} />}
          <InfoRow icon={IdCard} label="Employee ID" value={row.employee_id} mono copyable />
          <InfoRow icon={Building2} label="Department" value={row.department} />
          <InfoRow icon={CalendarDays} label="Start date" value={formatHireDate(row.start_date)} />
          <InfoRow icon={Hourglass} label="Tenure" value={tenureFrom(row.start_date)} />
        </InfoCard>

        <InfoCard icon={ContactIcon} title="Contact" accent={accent}>
          <InfoRow icon={Mail} label="Work email" value={row.work_email} copyable />
          <InfoRow icon={AtSign} label="Personal email" value={row.personal_email} copyable />
          {(row.alternate_work_emails ?? []).length > 0 && (
            <InfoRow icon={Mail} label="Alternate work emails" value={(row.alternate_work_emails ?? []).join(', ')} />
          )}
          <InfoRow icon={Phone} label="Phone number" value={row.phone_number} copyable />
          <InfoRow
            icon={MapPin}
            label="Home address"
            value={
              row.full_address?.trim() ||
              [row.city, row.province].map((x) => (x ?? '').trim()).filter(Boolean).join(', ') ||
              row.location ||
              null
            }
          />
        </InfoCard>
      </div>
    </div>
  );
}

function StatCard({ label, value, sub }: { label: string; value: string; sub?: string }) {
  return (
    <div className="rounded-lg border border-zinc-200 bg-white p-3 dark:border-zinc-800 dark:bg-zinc-950">
      <div className="text-[10.5px] uppercase tracking-wide text-zinc-400">{label}</div>
      <div className="mt-0.5 text-base font-semibold text-zinc-900 dark:text-zinc-100">{value}</div>
      {sub && <div className="text-[11px] text-zinc-400">{sub}</div>}
    </div>
  );
}

/* ── Beautified read-only profile primitives ──────────────────────────────
   InfoCard groups related fields under an icon-badged header; InfoRow renders
   one label→value pair with a leading icon, a monospace/copyable option, and a
   consistent empty-state. Used by the Identity & contact read view so the
   fields read as a structured record rather than a flat label list. */
function InfoCard({
  icon: Icon,
  title,
  accent,
  children,
}: {
  icon: LucideIcon;
  title: string;
  accent: Accent;
  children: ReactNode;
}) {
  return (
    <div className="overflow-hidden rounded-xl border border-zinc-200/80 bg-white shadow-sm dark:border-zinc-800 dark:bg-zinc-950">
      <div className="flex items-center gap-2 border-b border-zinc-100 bg-zinc-50/70 px-3 py-2 dark:border-zinc-800/70 dark:bg-zinc-900/40">
        <span className={cn('flex h-6 w-6 items-center justify-center rounded-md', accent.chipBg, accent.chipText)}>
          <Icon className="h-3.5 w-3.5" />
        </span>
        <h4 className="text-[11px] font-semibold uppercase tracking-wide text-zinc-500 dark:text-zinc-400">{title}</h4>
      </div>
      <dl className="divide-y divide-zinc-100 dark:divide-zinc-800/70">{children}</dl>
    </div>
  );
}

function InfoRow({
  icon: Icon,
  label,
  value,
  mono,
  copyable,
}: {
  icon: LucideIcon;
  label: string;
  value: string | null;
  mono?: boolean;
  copyable?: boolean;
}) {
  const empty = !value;
  const [copied, setCopied] = useState(false);
  const canCopy = copyable && !empty;
  const doCopy = () => {
    if (!canCopy || typeof navigator === 'undefined' || !navigator.clipboard) return;
    navigator.clipboard.writeText(value as string).then(() => {
      setCopied(true);
      window.setTimeout(() => setCopied(false), 1200);
    }).catch(() => {});
  };
  return (
    <div className="group flex items-start gap-2.5 px-3 py-1.5">
      <Icon className="mt-[2px] h-3.5 w-3.5 shrink-0 text-zinc-400 dark:text-zinc-500" />
      <div className="min-w-0 flex-1">
        <dt className="text-[10px] font-medium uppercase tracking-wide text-zinc-400 dark:text-zinc-500">{label}</dt>
        <dd
          className={cn(
            'mt-0.5 break-words text-[12.5px] leading-snug',
            empty
              ? 'italic text-zinc-400 dark:text-zinc-600'
              : cn('font-medium text-zinc-800 dark:text-zinc-100', mono && 'font-mono text-[12px]'),
          )}
        >
          {empty ? 'Not filled' : value}
        </dd>
      </div>
      {canCopy && (
        <button
          type="button"
          onClick={doCopy}
          className="mt-[2px] shrink-0 rounded p-0.5 text-zinc-300 opacity-0 transition-opacity hover:bg-zinc-100 hover:text-zinc-600 focus-visible:opacity-100 group-hover:opacity-100 dark:text-zinc-600 dark:hover:bg-zinc-800 dark:hover:text-zinc-300"
          aria-label={`Copy ${label}`}
          title={copied ? 'Copied' : `Copy ${label}`}
        >
          {copied ? <Check className="h-3 w-3 text-emerald-500" /> : <Copy className="h-3 w-3" />}
        </button>
      )}
    </div>
  );
}

/* ── Payroll ──────────────────────────────────────────────────────────────── */

export type PayWeeksState =
  | { status: 'idle' }
  | { status: 'loading' }
  | { status: 'failed'; error: string }
  | { status: 'ready'; weeks: PayrollHistoryWeek[] };

/**
 * One person's pay weeks. Fetched once `enabled` turns true (the host passes
 * "the Payroll tab has been opened"), and held by the host so a tab switch never
 * re-reads. `email` is the host's FROZEN work email: an edit made in the popup
 * must not re-fire the read.
 *
 * Fails closed: a failed read is `failed`, never an empty list, because an
 * empty Payroll tab reads as "never paid".
 */
export function usePersonPayWeeks(email: string, enabled: boolean): PayWeeksState {
  const [state, setState] = useState<PayWeeksState>({ status: 'idle' });
  useEffect(() => {
    if (!enabled || !email) return;
    let alive = true;
    setState({ status: 'loading' });
    fetch(`/api/people/${encodeURIComponent(email)}/payroll`, { cache: 'no-store' })
      .then(async (res) => {
        const j = (await res.json().catch(() => null)) as { weeks?: PayrollHistoryWeek[]; error?: string | null } | null;
        if (!res.ok || !j || !Array.isArray(j.weeks)) throw new Error(j?.error || `Request failed (${res.status})`);
        return j.weeks;
      })
      .then((weeks) => {
        if (alive) setState({ status: 'ready', weeks });
      })
      .catch((e: unknown) => {
        if (alive) setState({ status: 'failed', error: e instanceof Error ? e.message : String(e) });
      });
    return () => {
      alive = false;
    };
  }, [email, enabled]);
  return state;
}

const HIST_PAGE_SIZE = 5;

/** A signed peso figure the way the statement prints it: "−₱1,000.00" when negative. */
function signedPhp(n: number): string {
  return n < 0 ? `−${fmtMoney(Math.abs(n), 'PHP')}` : fmtMoney(n, 'PHP');
}

/**
 * The Payroll tab: every week, newest first, each HEADLINED BY WHAT THE WEEK PAID.
 *
 * The headline is never the weekly record's hourly pay unless that is all there
 * is, and then it says so. `people-payroll-history.md` holds the precedence:
 * the statement's Net pay with its bonus lines, else the paid dispatch total
 * with its bonus total (not itemised), else hourly pay under that name, with the
 * bonus "not on record" and never ₱0.
 */
export function PayrollHistoryList({
  email,
  state,
  page,
  onPage,
  reduceMotion,
}: {
  email: string;
  state: PayWeeksState;
  /** 1-based, held by the host so it survives a tab switch. */
  page: number;
  onPage: (page: number) => void;
  reduceMotion: boolean;
}) {
  const dirRef = useRef<1 | -1>(1);
  const [statementWeek, setStatementWeek] = useState<PayrollHistoryWeek | null>(null);

  if (!email) {
    return <p className="py-3 text-xs text-zinc-400">No work email on file, so the pay history cannot be looked up.</p>;
  }

  if (state.status === 'idle' || state.status === 'loading') {
    return (
      <ul className="space-y-1.5" aria-busy>
        {Array.from({ length: 3 }).map((_, i) => (
          <li key={i} className="rounded-lg border border-zinc-200 px-3 py-2.5 dark:border-zinc-800">
            <div className="flex items-center justify-between">
              <div className="space-y-1.5">
                <Skeleton className="h-3.5 w-44" />
                <Skeleton className="h-2.5 w-24" />
              </div>
              <div className="space-y-1.5">
                <Skeleton className="ml-auto h-3.5 w-20" />
                <Skeleton className="ml-auto h-2.5 w-12" />
              </div>
            </div>
            <Skeleton className="mt-2 h-4 w-40 rounded-full" />
          </li>
        ))}
      </ul>
    );
  }

  if (state.status === 'failed') {
    return (
      <p className="rounded-lg border border-rose-200 bg-rose-50 px-3 py-2 text-xs text-rose-700 dark:border-rose-900/50 dark:bg-rose-950/30 dark:text-rose-300">
        The pay history could not be loaded, so nothing is shown rather than an incomplete one: {state.error}
      </p>
    );
  }

  const weeks = state.weeks;
  if (weeks.length === 0) return <p className="py-3 text-xs text-zinc-400">No payroll records yet.</p>;

  const totalPages = Math.max(1, Math.ceil(weeks.length / HIST_PAGE_SIZE));
  const safePage = Math.min(Math.max(1, page), totalPages);
  const start = (safePage - 1) * HIST_PAGE_SIZE;
  const paged = weeks.slice(start, start + HIST_PAGE_SIZE);
  const go = (dir: 1 | -1) => {
    dirRef.current = dir;
    onPage(Math.min(totalPages, Math.max(1, safePage + dir)));
  };

  return (
    <>
      <AnimatePresence mode="wait" custom={dirRef.current} initial={false}>
        <motion.ul
          key={safePage}
          custom={dirRef.current}
          variants={{
            enter: (d: number) => (reduceMotion ? { opacity: 0 } : { opacity: 0, x: d * 18 }),
            center: { opacity: 1, x: 0 },
            exit: (d: number) => (reduceMotion ? { opacity: 0 } : { opacity: 0, x: d * -18 }),
          }}
          initial="enter"
          animate="center"
          exit="exit"
          transition={{ duration: 0.2, ease: [0.22, 1, 0.36, 1] }}
          className="space-y-1.5"
        >
          {paged.map((w) => (
            <PayWeekRow key={w.key} week={w} onOpenStatement={() => setStatementWeek(w)} />
          ))}
        </motion.ul>
      </AnimatePresence>
      {totalPages > 1 && (
        <div data-readonly-allow className="mt-2 flex items-center justify-between text-[11px] text-zinc-500">
          <span>
            Showing {start + 1}–{Math.min(start + HIST_PAGE_SIZE, weeks.length)} of {weeks.length}
          </span>
          <div className="flex items-center gap-2">
            <Button type="button" size="sm" variant="outline" className="h-7 px-2 text-[12px]" disabled={safePage <= 1} onClick={() => go(-1)}>
              Prev
            </Button>
            <span className="tabular-nums text-zinc-600 dark:text-zinc-300">
              {safePage} / {totalPages}
            </span>
            <Button type="button" size="sm" variant="outline" className="h-7 px-2 text-[12px]" disabled={safePage >= totalPages} onClick={() => go(1)}>
              Next
            </Button>
          </div>
        </div>
      )}
      {statementWeek?.statement && (
        <Dialog open onOpenChange={(o) => { if (!o) setStatementWeek(null); }}>
          <DialogContent className="max-h-[90vh] overflow-y-auto sm:max-w-[600px]">
            <DialogHeader>
              <DialogTitle>Pay statement</DialogTitle>
              <DialogDescription>
                {statementWeek.statement.weekHuman || formatPeriodRange(statementWeek.periodStart, statementWeek.periodEnd)} · the
                statement as sent to {statementWeek.statement.name || 'them'}.
              </DialogDescription>
            </DialogHeader>
            <div className="flex justify-center">
              <PayStubStatement
                view={statementWeek.statement}
                paidAt={statementWeek.paidAt}
                status={statementWeek.status === 'paid' ? 'paid' : 'issued'}
              />
            </div>
          </DialogContent>
        </Dialog>
      )}
    </>
  );
}

function PayWeekRow({ week: w, onOpenStatement }: { week: PayrollHistoryWeek; onOpenStatement: () => void }) {
  const special = w.source === 'special';
  // What the right-hand figure IS. Hourly pay is printed as the headline only
  // when nothing else is on record, and the caption then says exactly that.
  const headline = w.source === 'hourly_only' ? w.hourlyPayPhp : w.totalPhp;
  const caption =
    w.source === 'statement'
      ? 'Net pay'
      : w.source === 'dispatch'
        ? 'Paid out · no statement on record'
        : 'Hourly pay only · no statement on record';
  const showChips =
    w.bonusLines.length > 0 ||
    w.statement != null ||
    (w.source === 'dispatch' && w.bonusTotalPhp != null && w.bonusTotalPhp !== 0);

  return (
    <li
      className={cn(
        'rounded-lg border px-3 py-2 text-[13px]',
        special
          ? 'border-violet-200 bg-violet-50/60 dark:border-violet-900/40 dark:bg-violet-950/20'
          : 'border-zinc-200 bg-white dark:border-zinc-800 dark:bg-zinc-950',
      )}
    >
      <div className="flex items-center justify-between gap-3">
        <div className="min-w-0">
          <div className="flex items-center gap-2">
            {special && (
              <span className="inline-flex items-center gap-1 rounded bg-violet-100 px-1.5 py-0.5 text-[10px] font-semibold text-violet-700 dark:bg-violet-900/40 dark:text-violet-200">
                <Sparkles className="h-2.5 w-2.5" /> Special
              </span>
            )}
            <span className="truncate font-medium text-zinc-800 dark:text-zinc-100">
              {special ? (w.note || 'Special transfer') : formatPeriodRange(w.periodStart, w.periodEnd)}
            </span>
          </div>
          <div className="mt-0.5 text-[11px] text-zinc-400">
            {special ? formatDay(w.paidAt ?? w.periodStart) : `${fmtHours(w.totalHours)} · ${caption}`}
          </div>
        </div>
        <div className="shrink-0 text-right">
          <div className="font-semibold tabular-nums text-zinc-900 dark:text-zinc-100">{fmtMoney(headline, 'PHP')}</div>
          <div
            className={cn(
              'text-[10.5px] font-medium',
              w.status === 'paid' ? 'text-emerald-600 dark:text-emerald-400' : 'text-amber-600 dark:text-amber-400',
            )}
          >
            {w.status ?? 'pending'}
          </div>
        </div>
      </div>

      {showChips && (
        <div className="mt-1.5 flex flex-wrap items-center gap-1.5">
          {w.bonusLines.map((l) => (
            <span
              key={l.key}
              className={cn(
                'rounded-full px-2 py-0.5 text-[11px] font-medium tabular-nums',
                l.amountPhp < 0
                  ? 'bg-rose-50 text-rose-700 dark:bg-rose-950/40 dark:text-rose-300'
                  : 'bg-emerald-50 text-emerald-700 dark:bg-emerald-950/40 dark:text-emerald-300',
              )}
            >
              {l.label} {signedPhp(l.amountPhp)}
            </span>
          ))}
          {w.source === 'statement' && w.bonusLines.length === 0 && (
            <span className="text-[11px] text-zinc-400">No bonuses this week</span>
          )}
          {w.source === 'dispatch' && w.bonusTotalPhp != null && w.bonusTotalPhp !== 0 && (
            <span
              className="rounded-full bg-emerald-50 px-2 py-0.5 text-[11px] font-medium tabular-nums text-emerald-700 dark:bg-emerald-950/40 dark:text-emerald-300"
              title="The dispatch recorded this bonus total without a statement, so it cannot be split into its parts"
            >
              Bonus {signedPhp(w.bonusTotalPhp)} · not itemised
            </span>
          )}
          {w.statement && (
            <button
              type="button"
              onClick={onOpenStatement}
              className="ml-auto inline-flex items-center gap-1 rounded-md px-1.5 py-0.5 text-[11px] font-medium text-zinc-500 transition-colors hover:bg-zinc-100 hover:text-zinc-800 dark:text-zinc-400 dark:hover:bg-zinc-800 dark:hover:text-zinc-200"
            >
              <FileText className="h-3 w-3" /> Statement
            </button>
          )}
        </div>
      )}

      {w.disagreement && (
        <p className="mt-1.5 rounded-md bg-amber-50 px-2 py-1 text-[11px] text-amber-800 dark:bg-amber-950/30 dark:text-amber-300">
          {w.disagreement}
        </p>
      )}
    </li>
  );
}

/* ── PAB Calendar ─────────────────────────────────────────────────────────── */

/**
 * The PAB calendar with its in-box loader. The progress bar sits INSIDE the
 * calendar box, centred over the skeleton (which stays visible around it); they
 * load together, and the bar only completes once the data actually lands.
 */
export function PersonPabPanel({ email, isHsl, accent }: { email: string; isHsl: boolean; accent: Accent }) {
  const [pabLoading, setPabLoading] = useState(true);
  const [pabProgress, setPabProgress] = useState(0);
  const [showPabLoader, setShowPabLoader] = useState(true);
  const handlePabLoaderDone = useCallback(() => setShowPabLoader(false), []);
  return (
    <div className="relative">
      {showPabLoader && (
        <PabCalendarLoader progress={pabProgress} done={!pabLoading} barClassName={accent.bar} onDone={handlePabLoaderDone} />
      )}
      <EmployeePabCalendar
        employeeEmail={email}
        isHsl={isHsl}
        trimToElapsedWeeks={false}
        onLoadingChange={setPabLoading}
        onProgress={setPabProgress}
      />
    </div>
  );
}
