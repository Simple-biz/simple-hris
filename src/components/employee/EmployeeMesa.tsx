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
} from 'lucide-react';
import { Card, CardContent } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { normEmail } from '@/lib/email/norm-email';
import type { EmployeeHourlyRateRow } from '@/lib/supabase/employee-hourly-rates';

interface Props {
  employeeEmail: string;
}

const WEEKLY_EMPLOYEE_CONTRIB = 100;
const WEEKLY_COMPANY_MATCH = 300;
const WEEKLY_TOTAL = WEEKLY_EMPLOYEE_CONTRIB + WEEKLY_COMPANY_MATCH;

const formatPHP = (n: number) =>
  `₱${n.toLocaleString('en-PH', { minimumFractionDigits: 0, maximumFractionDigits: 0 })}`;

export default function EmployeeMesa({ employeeEmail }: Props) {
  const [isMember, setIsMember] = useState<boolean | null>(null);

  // Look up the current user's mesa_member flag from their rates row.
  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const res = await fetch('/api/employee-hourly-rates', { cache: 'no-store' });
        if (!res.ok) {
          if (!cancelled) setIsMember(false);
          return;
        }
        const json = (await res.json()) as { rows?: EmployeeHourlyRateRow[] };
        const target = normEmail(employeeEmail);
        const mine = (json.rows ?? []).find((r) => {
          const w = normEmail(r.work_email ?? null);
          const p = normEmail(r.personal_email ?? null);
          return (w && w === target) || (p && p === target);
        });
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
