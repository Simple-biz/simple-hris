'use client';

import React, { useEffect, useState } from 'react';
import {
  HeartHandshake,
  Stethoscope,
  CloudRainWind,
  Laptop,
  PiggyBank,
  CalendarClock,
  ReceiptText,
  ShieldAlert,
  Users,
  CheckCircle2,
  Sparkles,
  ArrowRight,
  History as HistoryIcon,
  Lock,
  ClipboardList,
  ChevronDown,
  Loader2,
  Clock,
  XCircle,
} from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Card, CardContent } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { AnimatePresence, motion } from 'motion/react';
import { cn } from '@/lib/utils';
import { toast } from 'sonner';
import type { EmployeeHourlyRateRow } from '@/lib/supabase/employee-hourly-rates';

interface Props {
  employeeEmail: string;
  employeeName?: string | null;
  department?: string | null;
  startDate?: string | null;
}

type SubTab = 'about' | 'request' | 'history';

// Weekly contribution shape — employee ₱100, company (Simple.biz) ₱400.
// The "matched four times over" copy in About is the source of truth here:
// 4× the employee's ₱100 = ₱400 from the company → ₱500 total per week.
const WEEKLY_EMPLOYEE_CONTRIB = 100;
const WEEKLY_COMPANY_MATCH = 400;
const WEEKLY_TOTAL = WEEKLY_EMPLOYEE_CONTRIB + WEEKLY_COMPANY_MATCH;

const formatPHP = (n: number) =>
  `₱${n.toLocaleString('en-PH', { minimumFractionDigits: 0, maximumFractionDigits: 0 })}`;

export default function EmployeeMesa({
  employeeEmail,
  employeeName,
  department,
  startDate,
}: Props) {
  const [isMember, setIsMember] = useState<boolean | null>(null);
  const [subTab, setSubTab] = useState<SubTab>('about');

  // Look up the current user's mesa_member flag — server-side ?email= filter
  // returns just this employee's row. See memory/project_employee_portal_filtered_endpoints.md.
  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const res = await fetch(
          `/api/employee-hourly-rates?email=${encodeURIComponent(employeeEmail)}`,
          { cache: 'no-store' },
        );
        if (!res.ok) {
          if (!cancelled) setIsMember(false);
          return;
        }
        const json = (await res.json()) as { rows?: EmployeeHourlyRateRow[] };
        const mine = (json.rows ?? [])[0];
        if (!cancelled) setIsMember(!!mine?.mesa_member);
      } catch {
        if (!cancelled) setIsMember(false);
      }
    })();
    return () => { cancelled = true; };
  }, [employeeEmail]);

  return (
    <div className="flex h-full min-h-0 flex-col overflow-y-auto bg-gradient-to-br from-white via-teal-50/40 to-emerald-50/20 p-4 sm:p-6 dark:bg-none dark:bg-[#0d1117]">
      <div className="mx-auto w-full max-w-4xl space-y-6">
        {/* Sub-tab switcher */}
        <div
          role="tablist"
          aria-label="MESA sections"
          className="relative inline-flex items-center gap-1 self-start rounded-lg border border-teal-100/80 bg-white/70 p-1 shadow-sm backdrop-blur dark:border-teal-900/40 dark:bg-zinc-900/60"
        >
          <SubTabButton
            active={subTab === 'about'}
            onClick={() => setSubTab('about')}
            icon={HeartHandshake}
            label="About MESA"
            tabKey="about"
          />
          <SubTabButton
            active={subTab === 'request'}
            onClick={() => setSubTab('request')}
            icon={ClipboardList}
            label="Request"
            tabKey="request"
          />
          <SubTabButton
            active={subTab === 'history'}
            onClick={() => setSubTab('history')}
            icon={HistoryIcon}
            label="History"
            tabKey="history"
          />
        </div>

        <AnimatePresence mode="wait" initial={false}>
          <motion.div
            key={subTab}
            initial={{ opacity: 0, y: 8, filter: 'blur(2px)' }}
            animate={{ opacity: 1, y: 0, filter: 'blur(0px)' }}
            exit={{ opacity: 0, y: -6, filter: 'blur(2px)' }}
            transition={{ duration: 0.28, ease: [0.22, 1, 0.36, 1] }}
          >
            {subTab === 'request' ? (
              <MesaRequestForm
                employeeEmail={employeeEmail}
                employeeName={employeeName ?? null}
                department={department ?? null}
                isMember={isMember}
              />
            ) : subTab === 'history' ? (
              <MesaHistory
                isMember={isMember}
                startDate={startDate ?? null}
                onGoToRequest={() => setSubTab('request')}
              />
            ) : (
              <AboutMesa
                isMember={isMember}
                onGoToRequest={() => setSubTab('request')}
              />
            )}
          </motion.div>
        </AnimatePresence>
      </div>
    </div>
  );
}

function SubTabButton({
  active,
  onClick,
  icon: Icon,
  label,
  tabKey,
}: {
  active: boolean;
  onClick: () => void;
  icon: React.ComponentType<{ className?: string }>;
  label: string;
  tabKey: string;
}) {
  return (
    <button
      type="button"
      role="tab"
      aria-selected={active}
      onClick={onClick}
      className={cn(
        'relative inline-flex items-center gap-1.5 rounded-md px-3 py-1.5 text-xs font-semibold transition-colors duration-200',
        active
          ? 'text-white'
          : 'text-zinc-600 hover:bg-teal-50/70 hover:text-teal-700 dark:text-zinc-400 dark:hover:bg-teal-950/40 dark:hover:text-teal-200',
      )}
    >
      {active && (
        <motion.span
          layoutId="mesa-subtab-pill"
          aria-hidden
          className="absolute inset-0 rounded-md bg-gradient-to-r from-teal-500 to-emerald-500 shadow-sm"
          transition={{ type: 'spring', stiffness: 380, damping: 32 }}
        />
      )}
      <span className="relative z-10 inline-flex items-center gap-1.5">
        <Icon className="h-3.5 w-3.5" />
        {label}
      </span>
      <span className="sr-only">{tabKey}</span>
    </button>
  );
}

function AboutMesa({
  isMember,
  onGoToRequest,
}: {
  isMember: boolean | null;
  onGoToRequest: () => void;
}) {
  return (
    <div className="space-y-6">
        {/* Hero */}
        <div className="overflow-hidden rounded-2xl border border-teal-100/80 bg-gradient-to-br from-teal-50/80 via-white to-emerald-50/60 p-6 shadow-sm dark:border-teal-900/40 dark:from-teal-950/40 dark:via-[#0d1117] dark:to-emerald-950/30 sm:p-8">
          <div className="flex flex-wrap items-start justify-between gap-4">
            <div className="min-w-0">
              <p className="text-[11px] font-semibold uppercase tracking-[0.18em] text-teal-700 dark:text-teal-300">
                Medical Emergency Savings Account
              </p>
              <h2 className="mt-1 text-2xl font-bold tracking-tight text-zinc-900 sm:text-3xl dark:text-white">
                MESA Program
              </h2>
              <p className="mt-2 max-w-xl text-sm leading-relaxed text-zinc-600 dark:text-zinc-400">
                A benefit we value deeply — built to support you and your family during
                unexpected emergencies. We walk alongside you when sudden needs arise.
              </p>
            </div>
            <EnrollmentBadge isMember={isMember} />
          </div>
        </div>

        {/* Why MESA exists */}
        <Section
          icon={HeartHandshake}
          eyebrow="Why MESA exists"
          title="Support when it matters most"
        >
          <p className="text-sm leading-relaxed text-zinc-700 dark:text-zinc-300">
            MESA was created to support you and your family during{' '}
            <strong className="font-semibold text-zinc-900 dark:text-white">
              unexpected emergencies
            </strong>
            . We understand how important it is to care for your loved ones and to have help
            when sudden needs arise. This program is our way of walking alongside you during
            difficult moments.
          </p>
        </Section>

        {/* When MESA can be used */}
        <Section
          icon={ReceiptText}
          eyebrow="When MESA can be used"
          title="What MESA covers"
        >
          <div className="grid gap-3 sm:grid-cols-3">
            <UseCard
              icon={Stethoscope}
              title="Medical emergencies"
              body="For you or your immediate family."
            />
            <UseCard
              icon={CloudRainWind}
              title="Natural disasters"
              body="Damage or displacement caused by storms, floods, or similar events."
            />
            <UseCard
              icon={Laptop}
              title="Necessary computer repairs"
              body="Repairs that affect your ability to work."
            />
          </div>

          <div className="mt-4 rounded-lg border border-amber-200/80 bg-amber-50/70 p-4 dark:border-amber-500/30 dark:bg-amber-500/10">
            <h4 className="flex items-center gap-2 text-sm font-semibold text-amber-900 dark:text-amber-100">
              <ShieldAlert className="h-4 w-4" />
              Who counts as immediate family
            </h4>
            <ul className="mt-2 space-y-1.5 pl-6 text-sm leading-relaxed text-amber-900/90 dark:text-amber-100/90">
              <li className="list-disc">
                Immediate family <strong>only</strong> contains your spouse and your children.
              </li>
              <li className="list-disc">
                Even if you are unmarried, your parents and siblings are{' '}
                <strong>ineligible</strong> for MESA disbursement assistance.
              </li>
            </ul>
          </div>

          <p className="mt-3 text-xs italic text-zinc-500 dark:text-zinc-500">
            These guidelines help ensure the program remains available when it is truly needed.
          </p>
        </Section>

        {/* A strong benefit for your future */}
        <Section
          icon={PiggyBank}
          eyebrow="A strong benefit for your future"
          title="Your savings, matched four times over"
        >
          <div className="grid gap-3 sm:grid-cols-3">
            <ContribCard
              label="You contribute"
              amount={formatPHP(WEEKLY_EMPLOYEE_CONTRIB)}
              sub="per week"
              tone="muted"
            />
            <ContribCard
              label="We contribute"
              amount={formatPHP(WEEKLY_COMPANY_MATCH)}
              sub="per week"
              tone="accent"
            />
            <ContribCard
              label="Your savings grow by"
              amount={formatPHP(WEEKLY_TOTAL)}
              sub="every week"
              tone="hero"
            />
          </div>
          <div className="mt-4 flex items-center gap-2 rounded-lg bg-teal-50/60 px-4 py-3 text-sm text-teal-900 dark:bg-teal-950/30 dark:text-teal-100">
            <Sparkles className="h-4 w-4 shrink-0 text-teal-600 dark:text-teal-300" />
            <span>
              We are matching your effort <strong>four times over</strong>. This reflects our
              commitment to your well-being and long-term security.
            </span>
          </div>
        </Section>

        {/* Important program expectations */}
        <Section
          icon={CalendarClock}
          eyebrow="Important program expectations"
          title="To keep MESA fair and sustainable"
        >
          <div className="space-y-2">
            <Rule
              title="Once every 90 days"
              body="Requests may be made once every 90 days."
            />
            <Rule
              title="Receipts within 14 days"
              body="Receipts must be submitted within 14 days. All receipts must be valid and include the merchant’s name."
            />
            <Rule
              title="Submission deadline: 30 calendar days"
              body="All receipts must be submitted within 30 calendar days of the date the service was provided or the expense was incurred."
            />
            <Rule
              title="Temporary removal"
              body="Not following these guidelines may result in temporary removal from the program."
              warn
            />
          </div>
          <p className="mt-4 text-sm leading-relaxed text-zinc-600 dark:text-zinc-400">
            If removal happens, you may rejoin during the next{' '}
            <strong className="font-semibold text-zinc-900 dark:text-white">
              enrollment period
            </strong>
            , which takes place three times per year following our FPU classes.
          </p>
        </Section>

        {/* Shared responsibility */}
        <Section
          icon={Users}
          eyebrow="A shared responsibility"
          title="Built on trust, fairness, and mutual support"
        >
          <p className="text-sm leading-relaxed text-zinc-700 dark:text-zinc-300">
            MESA is built on <strong>trust, fairness, and mutual support</strong>. By
            participating, you help protect this benefit for yourself and your fellow team
            members.
          </p>
        </Section>

        {/* How to join */}
        <section className="space-y-3">
          <div className="flex items-center gap-3 px-1">
            <div className="flex h-9 w-9 shrink-0 items-center justify-center rounded-lg bg-gradient-to-br from-orange-50 to-amber-100/70 text-orange-600 ring-1 ring-orange-100 dark:from-orange-950/60 dark:to-amber-950/40 dark:text-orange-300 dark:ring-orange-900/60">
              <ClipboardList className="h-4 w-4" />
            </div>
            <div className="min-w-0">
              <p className="text-[11px] font-semibold uppercase tracking-wide text-orange-700 dark:text-orange-300">
                How to join MESA
              </p>
              <h3 className="text-base font-semibold text-zinc-900 dark:text-white">
                Complete FPU, then submit an Opt-in request
              </h3>
            </div>
          </div>
          <Card className="overflow-hidden border-orange-100/80 shadow-sm dark:border-orange-900/40">
            <CardContent className="p-5 sm:p-6">
              <p className="text-sm leading-relaxed text-zinc-700 dark:text-zinc-300">
                The <strong>only way to join MESA</strong> is to complete a Financial Peace
                University (FPU) class. Once you finish, submit an <strong>Opt-in request</strong>{' '}
                using the Request tab — HR will review and enroll you.
              </p>
              <div className="mt-4 flex flex-wrap items-center gap-3">
                <Button
                  type="button"
                  onClick={onGoToRequest}
                  className="bg-orange-500 text-white shadow-sm hover:bg-orange-600 focus-visible:ring-orange-500/40 dark:bg-orange-500 dark:hover:bg-orange-400"
                >
                  Apply for MESA
                  <ArrowRight className="ml-1.5 h-4 w-4" />
                </Button>
                <span className="text-xs text-zinc-500 dark:text-zinc-500">
                  Opens the Request tab to submit your opt-in.
                </span>
              </div>
            </CardContent>
          </Card>
        </section>

        {/* Closing */}
        <Card className="border-teal-100/80 bg-gradient-to-br from-teal-50/60 to-emerald-50/40 shadow-sm dark:border-teal-900/40 dark:from-teal-950/30 dark:to-emerald-950/20">
          <CardContent className="p-6 sm:p-7">
            <div className="flex items-start gap-3">
              <div className="flex h-10 w-10 shrink-0 items-center justify-center rounded-xl bg-white text-teal-600 shadow-sm ring-1 ring-teal-100 dark:bg-teal-950/60 dark:text-teal-300 dark:ring-teal-900/60">
                <CheckCircle2 className="h-5 w-5" />
              </div>
              <div className="min-w-0">
                <h3 className="text-base font-semibold text-zinc-900 dark:text-white">
                  Thank you for your hard work and dedication
                </h3>
                <p className="mt-1 text-sm leading-relaxed text-zinc-600 dark:text-zinc-400">
                  We are grateful to support you and your family when it matters most. If you
                  understand and agree to these guidelines, you may proceed with enrollment
                  during the next enrollment window.
                </p>
              </div>
            </div>
          </CardContent>
        </Card>
    </div>
  );
}

function EnrollmentBadge({ isMember }: { isMember: boolean | null }) {
  if (isMember === null) {
    return (
      <Badge
        variant="outline"
        className="border-zinc-200 bg-white/70 text-zinc-500 dark:border-zinc-700 dark:bg-zinc-900/40 dark:text-zinc-400"
      >
        Checking enrollment…
      </Badge>
    );
  }
  if (isMember) {
    return (
      <Badge
        variant="outline"
        className="border-teal-200 bg-teal-50 px-2.5 py-1 text-[11px] font-semibold uppercase tracking-wide text-teal-700 dark:border-teal-500/40 dark:bg-teal-500/15 dark:text-teal-200"
      >
        <CheckCircle2 className="mr-1 h-3 w-3" />
        Enrolled
      </Badge>
    );
  }
  return (
    <Badge
      variant="outline"
      className="border-zinc-300 bg-white px-2.5 py-1 text-[11px] font-semibold uppercase tracking-wide text-zinc-600 dark:border-zinc-700 dark:bg-zinc-900/50 dark:text-zinc-400"
    >
      Not enrolled
    </Badge>
  );
}

function Section({
  icon: Icon,
  eyebrow,
  title,
  children,
}: {
  icon: React.ComponentType<{ className?: string }>;
  eyebrow: string;
  title: string;
  children: React.ReactNode;
}) {
  return (
    <section className="space-y-3">
      <div className="flex items-center gap-3 px-1">
        <div className="flex h-9 w-9 shrink-0 items-center justify-center rounded-lg bg-gradient-to-br from-teal-50 to-emerald-100/70 text-teal-600 ring-1 ring-teal-100 dark:from-teal-950/60 dark:to-emerald-950/40 dark:text-teal-300 dark:ring-teal-900/60">
          <Icon className="h-4 w-4" />
        </div>
        <div className="min-w-0">
          <p className="text-[11px] font-semibold uppercase tracking-wide text-teal-700 dark:text-teal-300">
            {eyebrow}
          </p>
          <h3 className="text-base font-semibold text-zinc-900 dark:text-white">{title}</h3>
        </div>
      </div>
      <Card className="border-teal-100/80 shadow-sm dark:border-teal-900/40">
        <CardContent className="p-5 sm:p-6">{children}</CardContent>
      </Card>
    </section>
  );
}

function UseCard({
  icon: Icon,
  title,
  body,
}: {
  icon: React.ComponentType<{ className?: string }>;
  title: string;
  body: string;
}) {
  return (
    <div className="rounded-lg border border-zinc-100 bg-white p-4 transition-colors hover:border-teal-200 hover:bg-teal-50/30 dark:border-zinc-800/80 dark:bg-zinc-900/40 dark:hover:border-teal-700/50 dark:hover:bg-teal-950/20">
      <div className="flex h-9 w-9 items-center justify-center rounded-lg bg-teal-50 text-teal-600 ring-1 ring-teal-100 dark:bg-teal-950/50 dark:text-teal-300 dark:ring-teal-900/50">
        <Icon className="h-4 w-4" />
      </div>
      <h4 className="mt-3 text-sm font-semibold leading-snug text-zinc-900 dark:text-white">
        {title}
      </h4>
      <p className="mt-1 text-xs leading-relaxed text-zinc-600 dark:text-zinc-400">{body}</p>
    </div>
  );
}

function ContribCard({
  label,
  amount,
  sub,
  tone,
}: {
  label: string;
  amount: string;
  sub: string;
  tone: 'muted' | 'accent' | 'hero';
}) {
  const styles = {
    muted:
      'border-zinc-200 bg-white text-zinc-900 dark:border-zinc-800 dark:bg-zinc-900/40 dark:text-zinc-100',
    accent:
      'border-teal-200 bg-teal-50/80 text-teal-900 dark:border-teal-700/40 dark:bg-teal-950/30 dark:text-teal-100',
    hero:
      'border-emerald-300 bg-gradient-to-br from-emerald-50 to-teal-50 text-emerald-900 shadow-sm dark:border-emerald-600/40 dark:from-emerald-950/40 dark:to-teal-950/40 dark:text-emerald-100',
  }[tone];

  return (
    <div className={`rounded-xl border p-4 ${styles}`}>
      <p className="text-[11px] font-medium uppercase tracking-wide opacity-70">{label}</p>
      <p className="mt-1 font-mono text-2xl font-bold tabular-nums">{amount}</p>
      <p className="mt-0.5 text-xs opacity-70">{sub}</p>
    </div>
  );
}

function Rule({
  title,
  body,
  warn = false,
}: {
  title: string;
  body: string;
  warn?: boolean;
}) {
  return (
    <div
      className={`flex gap-3 rounded-lg border p-3 ${
        warn
          ? 'border-rose-200/80 bg-rose-50/50 dark:border-rose-500/30 dark:bg-rose-500/10'
          : 'border-zinc-100 bg-white dark:border-zinc-800/80 dark:bg-zinc-900/40'
      }`}
    >
      <div
        className={`mt-1 h-2 w-2 shrink-0 rounded-full ${
          warn ? 'bg-rose-500' : 'bg-teal-500'
        }`}
      />
      <div className="min-w-0">
        <p
          className={`text-sm font-semibold ${
            warn ? 'text-rose-900 dark:text-rose-100' : 'text-zinc-900 dark:text-white'
          }`}
        >
          {title}
        </p>
        <p
          className={`mt-0.5 text-sm leading-relaxed ${
            warn ? 'text-rose-800/90 dark:text-rose-100/90' : 'text-zinc-600 dark:text-zinc-400'
          }`}
        >
          {body}
        </p>
      </div>
    </div>
  );
}

// ── Request Form ───────────────────────────────────────────────────────────

type RequestType = 'opt_in' | 'opt_out' | 'disbursement' | 'return' | '';

const DISBURSEMENT_REASONS = [
  'Medical Emergency',
  'Natural Disaster',
  'Computer Repair',
  'Other',
];

const OPT_IN_AGREEMENTS = [
  'I understand the MESA terms provided above.',
  'I understand that PHP 100 will be deducted from my paycheck each week and put into my MESA account.',
  'I understand that when I contribute, Simple will match my contribution and put PHP 400 each week into my MESA account.',
  'I understand that distributions are only for medical emergencies for me or my immediate family, computer repairs for my primary device, or natural disasters. Disbursements outside of these reasons will make me ineligible for program participation.',
  'I understand that distributions are to be infrequent, as this program is intended to have me prepared for emergencies, which are also infrequent. More than one disbursement in a 90 day period will make me ineligible for program participation, even if the disbursements are for qualified reasons. I understand that since I am no longer contributing, Simple will no longer be contributing to my account as well.',
];

interface MesaRequestRow {
  id: string;
  request_type: string;
  status: string;
  disbursement_reason: string | null;
  amount_needed: number | null;
  created_at: string;
  review_notes: string | null;
}

function MesaRequestForm({
  employeeEmail,
  employeeName,
  department,
  isMember,
}: {
  employeeEmail: string;
  employeeName: string | null;
  department: string | null;
  isMember: boolean | null;
}) {
  const [requestType, setRequestType] = React.useState<RequestType>('');
  const [agreements, setAgreements] = React.useState<boolean[]>(OPT_IN_AGREEMENTS.map(() => false));
  const [optInChecked, setOptInChecked] = React.useState(false);
  const [optOutChecked, setOptOutChecked] = React.useState(false);
  const [disbursementChecked, setDisbursementChecked] = React.useState(false);
  const [fpuDate, setFpuDate] = React.useState('');
  const [disbursementReason, setDisbursementReason] = React.useState('');
  const [explanation, setExplanation] = React.useState('');
  const [amountNeeded, setAmountNeeded] = React.useState('');
  const [fullName, setFullName] = React.useState(employeeName ?? '');
  const [dept, setDept] = React.useState(department ?? '');
  const [submitting, setSubmitting] = React.useState(false);
  const [pastRequests, setPastRequests] = React.useState<MesaRequestRow[]>([]);
  const [loadingHistory, setLoadingHistory] = React.useState(true);

  React.useEffect(() => {
    setFullName(employeeName ?? '');
  }, [employeeName]);
  React.useEffect(() => {
    setDept(department ?? '');
  }, [department]);

  React.useEffect(() => {
    let cancelled = false;
    setLoadingHistory(true);
    fetch(`/api/mesa-requests?email=${encodeURIComponent(employeeEmail)}`, { cache: 'no-store' })
      .then((r) => r.json())
      .then((j: { rows?: MesaRequestRow[] }) => {
        if (!cancelled) setPastRequests(j.rows ?? []);
      })
      .catch(() => {})
      .finally(() => { if (!cancelled) setLoadingHistory(false); });
    return () => { cancelled = true; };
  }, [employeeEmail]);

  const resetForm = () => {
    setRequestType('');
    setAgreements(OPT_IN_AGREEMENTS.map(() => false));
    setOptInChecked(false);
    setOptOutChecked(false);
    setDisbursementChecked(false);
    setFpuDate('');
    setDisbursementReason('');
    setExplanation('');
    setAmountNeeded('');
  };

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!requestType) { toast.error('Please select an option'); return; }

    if (requestType === 'opt_in') {
      if (!optInChecked) { toast.error('Please check the enrollment confirmation'); return; }
      if (agreements.some((a) => !a)) { toast.error('Please agree to all terms'); return; }
      if (!fpuDate) { toast.error('Please enter your FPU completion date'); return; }
    }
    if (requestType === 'opt_out' && !optOutChecked) {
      toast.error('Please confirm opt-out'); return;
    }
    if (requestType === 'disbursement') {
      if (!disbursementChecked) { toast.error('Please confirm disbursement request'); return; }
      if (!disbursementReason) { toast.error('Please select a disbursement reason'); return; }
      if (!explanation.trim()) { toast.error('Please provide an explanation'); return; }
      if (!amountNeeded || isNaN(parseFloat(amountNeeded))) {
        toast.error('Please enter a valid amount'); return;
      }
    }
    if (!fullName.trim()) { toast.error('Please enter your full name'); return; }
    if (!dept.trim()) { toast.error('Please enter your department'); return; }

    setSubmitting(true);
    try {
      const res = await fetch('/api/mesa-requests', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          work_email: employeeEmail,
          full_name: fullName.trim(),
          department: dept.trim(),
          request_type: requestType,
          fpu_date: requestType === 'opt_in' ? fpuDate : null,
          disbursement_reason: requestType === 'disbursement' ? disbursementReason : null,
          explanation: requestType === 'disbursement' ? explanation.trim() : null,
          amount_needed: requestType === 'disbursement' ? parseFloat(amountNeeded) : null,
        }),
      });
      const json = (await res.json()) as { success?: boolean; error?: string };
      if (!res.ok || !json.success) {
        toast.error(json.error ?? 'Submission failed');
        return;
      }
      toast.success('Your request has been submitted. Accounting will review it shortly.');
      resetForm();
      // Refresh past requests
      fetch(`/api/mesa-requests?email=${encodeURIComponent(employeeEmail)}`, { cache: 'no-store' })
        .then((r) => r.json())
        .then((j: { rows?: MesaRequestRow[] }) => setPastRequests(j.rows ?? []))
        .catch(() => {});
    } catch {
      toast.error('An unexpected error occurred');
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <div className="space-y-6">
      {/* Hero */}
      <div className="overflow-hidden rounded-2xl border border-teal-100/80 bg-gradient-to-br from-teal-50/80 via-white to-emerald-50/60 p-6 shadow-sm dark:border-teal-900/40 dark:from-teal-950/40 dark:via-[#0d1117] dark:to-emerald-950/30 sm:p-8">
        <p className="text-[11px] font-semibold uppercase tracking-[0.18em] text-teal-700 dark:text-teal-300">
          MESA Program
        </p>
        <h2 className="mt-1 text-2xl font-bold tracking-tight text-zinc-900 dark:text-white">
          Submit a Request
        </h2>
        <p className="mt-2 max-w-xl text-sm leading-relaxed text-zinc-600 dark:text-zinc-400">
          Use this form to opt into or out of MESA, request a disbursement, or return funds.
          Accounting will review and process your request.
        </p>
        <p className="mt-1 text-xs text-zinc-500 dark:text-zinc-500">
          Questions? Email{' '}
          <a href="mailto:accounting@simple.biz" className="text-teal-600 underline dark:text-teal-400">
            accounting@simple.biz
          </a>
        </p>
      </div>

      {/* Form */}
      <Card className="border-teal-100/80 shadow-sm dark:border-teal-900/40">
        <CardContent className="p-5 sm:p-6">
          <form onSubmit={handleSubmit} className="space-y-5">
            {/* Option selector */}
            <div className="space-y-1.5">
              <label className="text-sm font-semibold text-zinc-900 dark:text-white">
                Options <span className="text-rose-500">*</span>
              </label>
              <div className="relative">
                <select
                  value={requestType}
                  onChange={(e) => {
                    setRequestType(e.target.value as RequestType);
                    setAgreements(OPT_IN_AGREEMENTS.map(() => false));
                    setOptInChecked(false);
                    setOptOutChecked(false);
                    setDisbursementChecked(false);
                  }}
                  className="w-full appearance-none rounded-md border border-zinc-200 bg-white py-2 pl-3 pr-8 text-sm text-zinc-900 focus:border-teal-500 focus:outline-none focus:ring-2 focus:ring-teal-500/20 dark:border-zinc-700 dark:bg-zinc-900 dark:text-zinc-100"
                >
                  <option value="">-- Select --</option>
                  <option value="opt_in">Opt-in</option>
                  <option value="opt_out">Opt-out</option>
                  <option value="disbursement">Disbursement Request</option>
                  <option value="return">Return</option>
                </select>
                <ChevronDown className="pointer-events-none absolute right-2.5 top-1/2 h-4 w-4 -translate-y-1/2 text-zinc-400" />
              </div>
            </div>

            {/* Option-specific section — keyed so React replaces the node on change,
                old section disappears instantly, new section fades in once (no cycling) */}
            {requestType && (
              <motion.div
                key={requestType}
                initial={{ opacity: 0, y: -8 }}
                animate={{ opacity: 1, y: 0 }}
                transition={{ duration: 0.22, ease: [0.22, 1, 0.36, 1] }}
              >
                {requestType === 'opt_in' && (
                  <div className="space-y-4 rounded-lg border border-teal-100 bg-teal-50/40 p-4 dark:border-teal-900/40 dark:bg-teal-950/20">
                    <label className="flex cursor-pointer items-start gap-2 text-sm font-medium text-zinc-900 dark:text-white">
                      <input
                        type="checkbox"
                        checked={optInChecked}
                        onChange={(e) => setOptInChecked(e.target.checked)}
                        className="mt-0.5 h-4 w-4 rounded border-zinc-300 accent-teal-600"
                      />
                      Select this option to enroll{' '}
                      <span className="text-rose-500">*</span>
                    </label>
                    <div className="space-y-2 border-t border-teal-100 pt-3 dark:border-teal-900/40">
                      {OPT_IN_AGREEMENTS.map((text, i) => (
                        <label key={i} className="flex cursor-pointer items-start gap-2 text-sm text-zinc-700 dark:text-zinc-300">
                          <input
                            type="checkbox"
                            checked={agreements[i]}
                            onChange={(e) => {
                              const next = [...agreements];
                              next[i] = e.target.checked;
                              setAgreements(next);
                            }}
                            className="mt-0.5 h-4 w-4 shrink-0 rounded border-zinc-300 accent-teal-600"
                          />
                          <span>
                            Agree <span className="text-rose-500">*</span>
                            <span className="ml-1 text-zinc-600 dark:text-zinc-400">&mdash; {text}</span>
                          </span>
                        </label>
                      ))}
                    </div>
                    <div className="space-y-1">
                      <label className="text-sm font-semibold text-zinc-900 dark:text-white">
                        Date you completed FPU <span className="text-rose-500">*</span>
                      </label>
                      <input
                        type="date"
                        value={fpuDate}
                        onChange={(e) => setFpuDate(e.target.value)}
                        className="w-full rounded-md border border-zinc-200 bg-white px-3 py-2 text-sm text-zinc-900 focus:border-teal-500 focus:outline-none focus:ring-2 focus:ring-teal-500/20 dark:border-zinc-700 dark:bg-zinc-900 dark:text-zinc-100"
                      />
                    </div>
                  </div>
                )}

                {requestType === 'opt_out' && (
                  <div className="rounded-lg border border-rose-100 bg-rose-50/40 p-4 dark:border-rose-900/40 dark:bg-rose-950/20">
                    <label className="flex cursor-pointer items-start gap-2 text-sm font-medium text-zinc-900 dark:text-white">
                      <input
                        type="checkbox"
                        checked={optOutChecked}
                        onChange={(e) => setOptOutChecked(e.target.checked)}
                        className="mt-0.5 h-4 w-4 rounded border-zinc-300 accent-rose-600"
                      />
                      Select this option to remove yourself from the MESA program{' '}
                      <span className="text-rose-500">*</span>
                    </label>
                  </div>
                )}

                {requestType === 'disbursement' && (
                  <div className="space-y-4 rounded-lg border border-amber-100 bg-amber-50/40 p-4 dark:border-amber-900/40 dark:bg-amber-950/20">
                    <label className="flex cursor-pointer items-start gap-2 text-sm font-medium text-zinc-900 dark:text-white">
                      <input
                        type="checkbox"
                        checked={disbursementChecked}
                        onChange={(e) => setDisbursementChecked(e.target.checked)}
                        className="mt-0.5 h-4 w-4 rounded border-zinc-300 accent-amber-600"
                      />
                      Select this option if you need your funds sent to you{' '}
                      <span className="text-rose-500">*</span>
                    </label>
                    <div className="space-y-1">
                      <label className="text-sm font-semibold text-zinc-900 dark:text-white">
                        Disbursement Reason <span className="text-rose-500">*</span>
                      </label>
                      <div className="relative">
                        <select
                          value={disbursementReason}
                          onChange={(e) => setDisbursementReason(e.target.value)}
                          className="w-full appearance-none rounded-md border border-zinc-200 bg-white py-2 pl-3 pr-8 text-sm text-zinc-900 focus:border-teal-500 focus:outline-none focus:ring-2 focus:ring-teal-500/20 dark:border-zinc-700 dark:bg-zinc-900 dark:text-zinc-100"
                        >
                          <option value="">Select reason</option>
                          {DISBURSEMENT_REASONS.map((r) => (
                            <option key={r} value={r}>{r}</option>
                          ))}
                        </select>
                        <ChevronDown className="pointer-events-none absolute right-2.5 top-1/2 h-4 w-4 -translate-y-1/2 text-zinc-400" />
                      </div>
                    </div>
                    <div className="space-y-1">
                      <label className="text-sm font-semibold text-zinc-900 dark:text-white">
                        Explanation <span className="text-rose-500">*</span>
                      </label>
                      <textarea
                        value={explanation}
                        onChange={(e) => setExplanation(e.target.value.slice(0, 250))}
                        rows={4}
                        placeholder="Briefly describe your situation..."
                        className="w-full rounded-md border border-zinc-200 bg-white px-3 py-2 text-sm text-zinc-900 placeholder-zinc-400 focus:border-teal-500 focus:outline-none focus:ring-2 focus:ring-teal-500/20 dark:border-zinc-700 dark:bg-zinc-900 dark:text-zinc-100"
                      />
                      <p className="text-right text-[11px] text-zinc-400">{explanation.length}/250 characters</p>
                    </div>
                    <div className="space-y-1">
                      <label className="text-sm font-semibold text-zinc-900 dark:text-white">
                        Amount Needed <span className="text-rose-500">*</span>
                      </label>
                      <div className="flex items-center gap-2">
                        <span className="rounded-md border border-zinc-200 bg-zinc-50 px-3 py-2 text-sm font-medium text-zinc-700 dark:border-zinc-700 dark:bg-zinc-800 dark:text-zinc-300">
                          PHP
                        </span>
                        <input
                          type="number"
                          min="0"
                          step="0.01"
                          value={amountNeeded}
                          onChange={(e) => setAmountNeeded(e.target.value)}
                          placeholder="0.00"
                          className="flex-1 rounded-md border border-zinc-200 bg-white px-3 py-2 text-sm text-zinc-900 focus:border-teal-500 focus:outline-none focus:ring-2 focus:ring-teal-500/20 dark:border-zinc-700 dark:bg-zinc-900 dark:text-zinc-100"
                        />
                      </div>
                      <p className="text-[11px] text-zinc-500">Please input numerical values.</p>
                    </div>
                    <div className="rounded-md border border-zinc-200 bg-white p-3 text-xs leading-relaxed text-zinc-600 dark:border-zinc-700 dark:bg-zinc-900/60 dark:text-zinc-400">
                      <strong>Note:</strong> If you are requesting a disbursement because you wish to
                      stop participating or need to close your account, please select{' '}
                      <strong>Opt-out</strong> above and follow those prompts.
                    </div>
                  </div>
                )}

                {requestType === 'return' && (
                  <div className="rounded-lg border border-zinc-200 bg-zinc-50/60 p-4 dark:border-zinc-700 dark:bg-zinc-900/40">
                    <p className="text-sm text-zinc-600 dark:text-zinc-400">
                      Use this option to return funds to your MESA account. Accounting will process
                      this request and update your balance accordingly.
                    </p>
                    <div className="mt-3 space-y-1">
                      <label className="text-sm font-semibold text-zinc-900 dark:text-white">
                        Notes (optional)
                      </label>
                      <textarea
                        value={explanation}
                        onChange={(e) => setExplanation(e.target.value.slice(0, 250))}
                        rows={3}
                        placeholder="Any additional information..."
                        className="w-full rounded-md border border-zinc-200 bg-white px-3 py-2 text-sm text-zinc-900 placeholder-zinc-400 focus:border-teal-500 focus:outline-none focus:ring-2 focus:ring-teal-500/20 dark:border-zinc-700 dark:bg-zinc-900 dark:text-zinc-100"
                      />
                    </div>
                  </div>
                )}
              </motion.div>
            )}

            {/* Common fields */}
            <div className="space-y-1">
              <label className="text-sm font-semibold text-zinc-900 dark:text-white">
                Simple.biz Email <span className="text-rose-500">*</span>
              </label>
              <input
                type="email"
                value={employeeEmail}
                readOnly
                className="w-full cursor-not-allowed rounded-md border border-zinc-200 bg-zinc-50 px-3 py-2 text-sm text-zinc-500 dark:border-zinc-700 dark:bg-zinc-800 dark:text-zinc-400"
              />
            </div>
            <div className="space-y-1">
              <label className="text-sm font-semibold text-zinc-900 dark:text-white">
                Full Name <span className="text-rose-500">*</span>
              </label>
              <input
                type="text"
                value={fullName}
                onChange={(e) => setFullName(e.target.value)}
                placeholder="Your full name"
                className="w-full rounded-md border border-zinc-200 bg-white px-3 py-2 text-sm text-zinc-900 placeholder-zinc-400 focus:border-teal-500 focus:outline-none focus:ring-2 focus:ring-teal-500/20 dark:border-zinc-700 dark:bg-zinc-900 dark:text-zinc-100"
              />
            </div>
            <div className="space-y-1">
              <label className="text-sm font-semibold text-zinc-900 dark:text-white">
                Department <span className="text-rose-500">*</span>
              </label>
              <input
                type="text"
                value={dept}
                onChange={(e) => setDept(e.target.value)}
                placeholder="Your department"
                className="w-full rounded-md border border-zinc-200 bg-white px-3 py-2 text-sm text-zinc-900 placeholder-zinc-400 focus:border-teal-500 focus:outline-none focus:ring-2 focus:ring-teal-500/20 dark:border-zinc-700 dark:bg-zinc-900 dark:text-zinc-100"
              />
            </div>

            <p className="text-xs text-zinc-500 dark:text-zinc-500">
              If you have any questions, please email{' '}
              <a href="mailto:accounting@simple.biz" className="text-teal-600 underline dark:text-teal-400">
                accounting@simple.biz
              </a>
              . Again, welcome to MESA!
            </p>

            <Button
              type="submit"
              disabled={submitting || !requestType}
              className="w-full bg-orange-500 text-white hover:bg-orange-600 disabled:opacity-50"
            >
              {submitting ? (
                <>
                  <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                  Submitting...
                </>
              ) : (
                'Submit'
              )}
            </Button>
          </form>
        </CardContent>
      </Card>

      {/* Past requests */}
      {(loadingHistory || pastRequests.length > 0) && (
        <Section icon={ClipboardList} eyebrow="My submissions" title="Past requests">
          {loadingHistory ? (
            <div className="space-y-2">
              {[1, 2].map((i) => (
                <div key={i} className="h-10 w-full animate-pulse rounded-lg bg-zinc-100 dark:bg-zinc-800" />
              ))}
            </div>
          ) : (
            <div className="overflow-hidden rounded-lg border border-zinc-100 dark:border-zinc-800/80">
              <table className="w-full text-sm">
                <thead className="bg-zinc-50/80 text-[11px] uppercase tracking-wide text-zinc-500 dark:bg-zinc-900/60 dark:text-zinc-400">
                  <tr>
                    <th className="px-3 py-2 text-left font-semibold">Type</th>
                    <th className="px-3 py-2 text-left font-semibold">Reason</th>
                    <th className="px-3 py-2 text-right font-semibold">Amount</th>
                    <th className="px-3 py-2 text-right font-semibold">Status</th>
                    <th className="px-3 py-2 text-right font-semibold">Submitted</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-zinc-100 dark:divide-zinc-800/80">
                  {pastRequests.map((r) => (
                    <tr key={r.id} className="hover:bg-teal-50/30 dark:hover:bg-teal-950/10">
                      <td className="px-3 py-2 capitalize text-zinc-700 dark:text-zinc-300" data-label="Type">
                        {r.request_type.replace('_', ' ')}
                      </td>
                      <td className="px-3 py-2 text-zinc-600 dark:text-zinc-400" data-label="Reason">
                        {r.disbursement_reason ?? '—'}
                      </td>
                      <td className="px-3 py-2 text-right tabular-nums text-zinc-700 dark:text-zinc-300" data-label="Amount">
                        {r.amount_needed != null ? `PHP ${r.amount_needed.toLocaleString()}` : '—'}
                      </td>
                      <td className="px-3 py-2 text-right" data-label="Status">
                        <RequestStatusBadge status={r.status} />
                      </td>
                      <td className="px-3 py-2 text-right text-zinc-500 dark:text-zinc-500" data-label="Submitted">
                        {new Date(r.created_at).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' })}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </Section>
      )}
    </div>
  );
}

function RequestStatusBadge({ status }: { status: string }) {
  if (status === 'approved') {
    return (
      <Badge variant="outline" className="border-teal-200 bg-teal-50 text-[10.5px] font-semibold uppercase tracking-wide text-teal-700 dark:border-teal-500/40 dark:bg-teal-500/15 dark:text-teal-200">
        <CheckCircle2 className="mr-1 h-3 w-3" />
        Approved
      </Badge>
    );
  }
  if (status === 'denied') {
    return (
      <Badge variant="outline" className="border-rose-200 bg-rose-50 text-[10.5px] font-semibold uppercase tracking-wide text-rose-700 dark:border-rose-500/40 dark:bg-rose-500/15 dark:text-rose-200">
        <XCircle className="mr-1 h-3 w-3" />
        Denied
      </Badge>
    );
  }
  return (
    <Badge variant="outline" className="border-amber-200 bg-amber-50 text-[10.5px] font-semibold uppercase tracking-wide text-amber-700 dark:border-amber-500/40 dark:bg-amber-500/15 dark:text-amber-200">
      <Clock className="mr-1 h-3 w-3" />
      Pending
    </Badge>
  );
}

// ── History ────────────────────────────────────────────────────────────────
//
// Weekly contribution ledger: ₱100 employee + ₱400 Simple.biz = ₱500 per week
// from the employee's start_date through today. Display-only — the program
// doesn't persist per-week rows yet, so this is a projection of "what your
// savings would look like if you've been enrolled since you joined".
//
// Gated on the `mesa_member` flag. Non-members see a "not enrolled" panel
// with a deep link into the FPU tab (FPU is the only path into MESA).
//
// Mon → Sun weeks. The current (in-progress) week is rendered with an
// "in progress" pill and excluded from cumulative totals — only fully-elapsed
// weeks count toward the ledger so we don't promise contributions that
// haven't been deducted yet.
function MesaHistory({
  isMember,
  startDate,
  onGoToRequest,
}: {
  isMember: boolean | null;
  startDate: string | null;
  onGoToRequest: () => void;
}) {
  if (isMember === null) {
    return (
      <div className="rounded-2xl border border-teal-100/80 bg-white/80 p-8 text-center text-sm text-zinc-500 shadow-sm dark:border-teal-900/40 dark:bg-zinc-900/40 dark:text-zinc-400">
        Loading your MESA history…
      </div>
    );
  }

  if (!isMember) {
    return (
      <div className="space-y-4">
        <div className="overflow-hidden rounded-2xl border border-zinc-200 bg-gradient-to-br from-zinc-50/80 via-white to-zinc-100/40 p-6 shadow-sm dark:border-zinc-800 dark:from-zinc-900/60 dark:via-[#0d1117] dark:to-zinc-900/30 sm:p-8">
          <div className="flex items-start gap-4">
            <div className="flex h-11 w-11 shrink-0 items-center justify-center rounded-xl bg-white text-zinc-500 shadow-sm ring-1 ring-zinc-200 dark:bg-zinc-900 dark:text-zinc-400 dark:ring-zinc-700">
              <Lock className="h-5 w-5" />
            </div>
            <div className="min-w-0">
              <p className="text-[11px] font-semibold uppercase tracking-[0.18em] text-zinc-500 dark:text-zinc-400">
                Not enrolled yet
              </p>
              <h2 className="mt-1 text-xl font-bold tracking-tight text-zinc-900 dark:text-white">
                No MESA history to show
              </h2>
              <p className="mt-2 max-w-xl text-sm leading-relaxed text-zinc-600 dark:text-zinc-400">
                Contributions begin once you've completed Financial Peace University and
                enrolled in MESA. Until then, this tab will be empty.
              </p>
              <div className="mt-4">
                <Button
                  type="button"
                  onClick={onGoToRequest}
                  className="bg-orange-500 text-white shadow-sm hover:bg-orange-600 focus-visible:ring-orange-500/40 dark:bg-orange-500 dark:hover:bg-orange-400"
                >
                  Apply for MESA
                  <ArrowRight className="ml-1.5 h-4 w-4" />
                </Button>
              </div>
            </div>
          </div>
        </div>
      </div>
    );
  }

  // Member — compute the ledger from start_date to today.
  const start = parseStartDate(startDate);
  if (!start) {
    return (
      <div className="rounded-2xl border border-amber-200/80 bg-amber-50/70 p-6 text-sm text-amber-900 shadow-sm dark:border-amber-500/30 dark:bg-amber-500/10 dark:text-amber-100">
        We couldn't read your hire date, so the contribution history can't be calculated yet.
        Please ask HR to update your start date.
      </div>
    );
  }

  const weeks = buildWeeklyLedger(start, new Date());
  const completed = weeks.filter((w) => !w.inProgress);
  const cumulativeEmployee = completed.length * WEEKLY_EMPLOYEE_CONTRIB;
  const cumulativeCompany = completed.length * WEEKLY_COMPANY_MATCH;
  const cumulativeTotal = completed.length * WEEKLY_TOTAL;

  return (
    <div className="space-y-6">
      {/* Hero — cumulative totals */}
      <div className="overflow-hidden rounded-2xl border border-teal-100/80 bg-gradient-to-br from-teal-50/80 via-white to-emerald-50/60 p-6 shadow-sm dark:border-teal-900/40 dark:from-teal-950/40 dark:via-[#0d1117] dark:to-emerald-950/30 sm:p-8">
        <div className="flex flex-wrap items-start justify-between gap-4">
          <div className="min-w-0">
            <p className="text-[11px] font-semibold uppercase tracking-[0.18em] text-teal-700 dark:text-teal-300">
              Contribution history
            </p>
            <h2 className="mt-1 text-2xl font-bold tracking-tight text-zinc-900 sm:text-3xl dark:text-white">
              Your MESA balance
            </h2>
            <p className="mt-2 max-w-xl text-sm leading-relaxed text-zinc-600 dark:text-zinc-400">
              {completed.length} completed week{completed.length === 1 ? '' : 's'} since{' '}
              <span className="font-semibold text-zinc-900 dark:text-white">
                {formatDateLong(start)}
              </span>
              .
            </p>
          </div>
          <Badge
            variant="outline"
            className="border-teal-200 bg-teal-50 px-2.5 py-1 text-[11px] font-semibold uppercase tracking-wide text-teal-700 dark:border-teal-500/40 dark:bg-teal-500/15 dark:text-teal-200"
          >
            <CheckCircle2 className="mr-1 h-3 w-3" />
            Enrolled
          </Badge>
        </div>

        <div className="mt-6 grid gap-3 sm:grid-cols-3">
          <ContribCard
            label="You've contributed"
            amount={formatPHP(cumulativeEmployee)}
            sub={`${completed.length} × ${formatPHP(WEEKLY_EMPLOYEE_CONTRIB)}`}
            tone="muted"
          />
          <ContribCard
            label="Simple.biz has matched"
            amount={formatPHP(cumulativeCompany)}
            sub={`${completed.length} × ${formatPHP(WEEKLY_COMPANY_MATCH)}`}
            tone="accent"
          />
          <ContribCard
            label="Total saved"
            amount={formatPHP(cumulativeTotal)}
            sub="Cumulative"
            tone="hero"
          />
        </div>
      </div>

      {/* Weekly ledger */}
      <Section
        icon={CalendarClock}
        eyebrow="Weekly ledger"
        title="Week-by-week contributions"
      >
        <div className="overflow-hidden rounded-lg border border-zinc-100 dark:border-zinc-800/80">
          <table className="w-full text-sm">
            <thead className="bg-zinc-50/80 text-[11px] uppercase tracking-wide text-zinc-500 dark:bg-zinc-900/60 dark:text-zinc-400">
              <tr>
                <th className="px-3 py-2 text-left font-semibold">Week of</th>
                <th className="px-3 py-2 text-right font-semibold">You</th>
                <th className="px-3 py-2 text-right font-semibold">Simple.biz</th>
                <th className="px-3 py-2 text-right font-semibold">Total</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-zinc-100 bg-white dark:divide-zinc-800/80 dark:bg-zinc-900/30">
              {weeks
                .slice()
                .reverse()
                .map((w) => (
                  <tr
                    key={w.weekStart.toISOString()}
                    className={cn(
                      'transition-colors',
                      w.inProgress
                        ? 'bg-amber-50/30 dark:bg-amber-500/5'
                        : 'hover:bg-teal-50/40 dark:hover:bg-teal-950/20',
                    )}
                  >
                    <td className="px-3 py-2 text-zinc-700 dark:text-zinc-300" data-label="Week of">
                      <span className="font-medium">{formatDateShort(w.weekStart)}</span>
                      {w.inProgress && (
                        <span className="ml-2 inline-flex items-center rounded-full bg-amber-100 px-1.5 py-0.5 text-[10px] font-semibold uppercase tracking-wide text-amber-800 dark:bg-amber-500/20 dark:text-amber-200">
                          In progress
                        </span>
                      )}
                    </td>
                    <td
                      className="px-3 py-2 text-right tabular-nums text-zinc-700 dark:text-zinc-300"
                      data-label="You"
                    >
                      {w.inProgress ? '—' : formatPHP(WEEKLY_EMPLOYEE_CONTRIB)}
                    </td>
                    <td
                      className="px-3 py-2 text-right tabular-nums text-zinc-700 dark:text-zinc-300"
                      data-label="Simple.biz"
                    >
                      {w.inProgress ? '—' : formatPHP(WEEKLY_COMPANY_MATCH)}
                    </td>
                    <td
                      className="px-3 py-2 text-right font-semibold tabular-nums text-zinc-900 dark:text-white"
                      data-label="Total"
                    >
                      {w.inProgress ? '—' : formatPHP(WEEKLY_TOTAL)}
                    </td>
                  </tr>
                ))}
            </tbody>
          </table>
        </div>
        <p className="mt-3 text-xs italic text-zinc-500 dark:text-zinc-500">
          This is a projected ledger based on your hire date and current enrollment — the
          program doesn't store individual weekly entries yet, so totals are computed from
          fully-elapsed weeks only.
        </p>
      </Section>
    </div>
  );
}

/**
 * Parses an arbitrary `start_date` string into a Date. Accepts ISO
 * (`YYYY-MM-DD`), US (`MM/DD/YYYY` or `MM/DD/YY`), and anything Date() understands.
 * Returns null for empty/unparseable input.
 */
function parseStartDate(input: string | null | undefined): Date | null {
  const s = input?.trim();
  if (!s) return null;
  const d = new Date(s);
  if (!Number.isNaN(d.getTime())) return d;
  // Fallback for MM/DD/YY → JS Date doesn't always parse 2-digit years correctly.
  const m = /^(\d{1,2})\/(\d{1,2})\/(\d{2,4})$/.exec(s);
  if (m) {
    const yy = parseInt(m[3], 10);
    const year = yy < 100 ? 2000 + yy : yy;
    const d2 = new Date(year, parseInt(m[1], 10) - 1, parseInt(m[2], 10));
    if (!Number.isNaN(d2.getTime())) return d2;
  }
  return null;
}

type LedgerWeek = { weekStart: Date; inProgress: boolean };

/**
 * Builds the Monday-anchored weekly ledger from `start` through `today`.
 * The week containing `today` is flagged `inProgress` and excluded from
 * cumulative totals upstream — we don't surface contributions that haven't
 * been collected yet.
 */
function buildWeeklyLedger(start: Date, today: Date): LedgerWeek[] {
  const firstMonday = mondayOf(start);
  const todayMonday = mondayOf(today);
  const weeks: LedgerWeek[] = [];
  const cursor = new Date(firstMonday);
  // Safety cap: 20 years of weeks. Stops any infinite-loop accidents from
  // a corrupted start_date (e.g. "1900") blowing up the page.
  const MAX_WEEKS = 52 * 20;
  let i = 0;
  while (cursor.getTime() <= todayMonday.getTime() && i < MAX_WEEKS) {
    weeks.push({
      weekStart: new Date(cursor),
      inProgress: cursor.getTime() === todayMonday.getTime(),
    });
    cursor.setDate(cursor.getDate() + 7);
    i += 1;
  }
  return weeks;
}

function mondayOf(d: Date): Date {
  const c = new Date(d.getFullYear(), d.getMonth(), d.getDate());
  // JS: Sunday = 0, Monday = 1 … Saturday = 6. Shift back to Monday.
  const dow = c.getDay();
  const delta = dow === 0 ? -6 : 1 - dow;
  c.setDate(c.getDate() + delta);
  return c;
}

function formatDateShort(d: Date): string {
  return d.toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' });
}

function formatDateLong(d: Date): string {
  return d.toLocaleDateString('en-US', { month: 'long', day: 'numeric', year: 'numeric' });
}
