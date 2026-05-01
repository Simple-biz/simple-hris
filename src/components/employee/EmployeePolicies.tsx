'use client';

import {
  Clock,
  Languages,
  Video,
  TimerReset,
  MonitorCheck,
  CalendarCheck,
  ShieldAlert,
  Repeat2,
  HeartHandshake,
  Ban,
  HandHeart,
} from 'lucide-react';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';

type Policy = {
  title: string;
  body: string;
  icon: React.ComponentType<{ className?: string }>;
};

type Section = {
  id: string;
  label: string;
  description: string;
  policies: Policy[];
};

const sections: Section[] = [
  {
    id: 'schedule',
    label: 'Work schedule & availability',
    description: 'When and how you should be reachable.',
    policies: [
      {
        title: '9 AM to 5 PM Workday',
        icon: Clock,
        body: 'You are expected to work and be available 9 AM to 5 PM Eastern (NYC time). Quickly reply to requests from customers or team members.',
      },
      {
        title: 'Overtime Approval',
        icon: TimerReset,
        body: 'The weekly cap is 45 hours. Any overtime beyond 45 hours per week must be approved by your manager.',
      },
      {
        title: 'Attendance Policies',
        icon: CalendarCheck,
        body: 'Reach out to us two weeks in advance for planned time off. You will receive a bonus if you do not miss a workday (requires working at least 7 hours on all five days of the work week).',
      },
      {
        title: 'Time/Screen Tracking',
        icon: MonitorCheck,
        body: 'Clock in when you’re working. Clock out when you’re on a break. Review your screenshots, ensure your work matches what is shown, and provide receipts if anything appears incorrect.',
      },
    ],
  },
  {
    id: 'communication',
    label: 'Communication',
    description: 'How we talk to teammates and clients.',
    policies: [
      {
        title: 'English Only',
        icon: Languages,
        body: 'Always use English in all company communications.',
      },
      {
        title: 'Cameras On',
        icon: Video,
        body: 'Cameras must be on for every meeting. Your full face must be visible on camera at all times.',
      },
      {
        title: 'Always Close the Loop',
        icon: Repeat2,
        body: 'Overcommunicate between team members and clients. We always want to keep our team members and clients updated every step of the way.',
      },
    ],
  },
  {
    id: 'conduct',
    label: 'Conduct & culture',
    description: 'How we treat each other day to day.',
    policies: [
      {
        title: 'Take Responsibility for Mistakes',
        icon: ShieldAlert,
        body: 'We do not make excuses. We take responsibility for our mistakes.',
      },
      {
        title: 'Be Humble',
        icon: HeartHandshake,
        body: 'Avoid talking down to others. Do unto others what you would have others do unto you.',
      },
      {
        title: 'No Soliciting',
        icon: Ban,
        body: 'No lending, borrowing, buying, or selling among team members.',
      },
      {
        title: 'No Flirting',
        icon: HandHeart,
        body: 'No flirting, intrusive questioning, or other interactions that may be interpreted as approach behaviors for dating.',
      },
    ],
  },
];

interface Props {
  department?: string | null;
}

export default function EmployeePolicies({ department }: Props) {
  const total = sections.reduce((n, s) => n + s.policies.length, 0);
  const deptLabel = department?.trim() || 'Your Team';

  return (
    <div className="flex h-full min-h-0 flex-col overflow-y-auto bg-gradient-to-br from-white via-orange-50/30 to-blue-50/20 p-4 sm:p-6 dark:bg-none dark:bg-[#0d1117]">
      <div className="mx-auto w-full max-w-4xl space-y-6">
        <div>
          <div className="flex items-center gap-2">
            <h2 className="text-2xl font-bold tracking-tight text-zinc-900 dark:text-white">
              Company Policies
            </h2>
            <Badge
              variant="outline"
              className="border-orange-200 bg-orange-50 text-orange-700 dark:border-blue-900/60 dark:bg-blue-950/40 dark:text-orange-300"
            >
              {deptLabel}
            </Badge>
          </div>
          <p className="mt-1 max-w-2xl text-sm leading-relaxed text-zinc-600 dark:text-zinc-500">
            The {total} expectations every team member is asked to follow. Read through them so
            you know what to count on from your teammates—and what they count on from you.
          </p>
        </div>

        {sections.map((section) => (
          <section key={section.id} className="space-y-3">
            <div className="flex items-baseline justify-between gap-3 px-1">
              <h3 className="text-sm font-semibold uppercase tracking-wide text-zinc-700 dark:text-zinc-300">
                {section.label}
              </h3>
              <span className="text-xs text-zinc-500 dark:text-zinc-500">
                {section.description}
              </span>
            </div>

            <Card className="overflow-hidden border-orange-100/80 shadow-sm dark:border-blue-950/60">
              <CardContent className="divide-y divide-orange-100/80 p-0 dark:divide-blue-950/60">
                {section.policies.map((p) => (
                  <div
                    key={p.title}
                    className="flex gap-4 p-4 transition-colors hover:bg-orange-50/40 dark:hover:bg-blue-950/20 sm:p-5"
                  >
                    <div className="flex h-9 w-9 shrink-0 items-center justify-center rounded-lg bg-gradient-to-br from-orange-50 to-orange-100/70 text-orange-600 ring-1 ring-orange-100 dark:from-blue-950/60 dark:to-blue-950/40 dark:text-orange-300 dark:ring-blue-900/60">
                      <p.icon className="h-4 w-4" />
                    </div>
                    <div className="min-w-0 flex-1">
                      <h4 className="text-[0.95rem] font-semibold leading-snug text-zinc-900 dark:text-white">
                        {p.title}
                      </h4>
                      <p className="mt-1 text-sm leading-relaxed text-zinc-600 dark:text-zinc-400">
                        {p.body}
                      </p>
                    </div>
                  </div>
                ))}
              </CardContent>
            </Card>
          </section>
        ))}

        <Card className="border-orange-100/80 bg-orange-50/40 shadow-sm dark:border-blue-950/60 dark:bg-blue-950/20">
          <CardHeader className="pb-2">
            <CardTitle className="text-sm font-semibold text-zinc-900 dark:text-white">
              Questions?
            </CardTitle>
          </CardHeader>
          <CardContent className="pt-0 text-sm text-zinc-600 dark:text-zinc-400">
            If anything here is unclear or you think a situation falls in a grey area, reach out
            to your manager before acting—it’s always better to ask early.
          </CardContent>
        </Card>
      </div>
    </div>
  );
}
