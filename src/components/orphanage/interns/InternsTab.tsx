'use client';

import { useState } from 'react';
import { CalendarRange, Users } from 'lucide-react';
import { cn } from '@/lib/utils';
import InternsProfilesPanel from './InternsProfilesPanel';
import InternsWizard from './InternsWizard';

type Pane = 'profiles' | 'pay-week';

/**
 * Orphanage dashboard → Interns. Two panes:
 *   Profiles — the ONLY place intern personal data, bank details and rates change
 *              (Kane 2026-09-02). Accounting reads; it never edits.
 *   Pay week — the mini Payroll Wizard: upload the interns' Hubstaff report,
 *              price the week, lock it in for Accounting.
 * Doc: docs/features/orphanage-interns.md.
 */
export default function InternsTab({ viewerEmail, canEdit }: { viewerEmail: string | null; canEdit: boolean }) {
  const [pane, setPane] = useState<Pane>('profiles');

  const tabs: Array<{ id: Pane; label: string; Icon: typeof Users; hint: string }> = [
    { id: 'profiles', label: 'Profiles', Icon: Users, hint: 'Who the interns are, their rate and bank' },
    { id: 'pay-week', label: 'Pay week', Icon: CalendarRange, hint: 'Upload hours, price the week, lock in' },
  ];

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div className="border-b border-pink-100/70 px-6 pt-5 dark:border-pink-950/40">
        <div className="flex flex-wrap items-end justify-between gap-3 pb-4">
          <div>
            <h1 className="text-xl font-bold text-zinc-900 dark:text-zinc-50">Interns</h1>
            <p className="mt-0.5 text-xs text-zinc-500 dark:text-zinc-400">
              @pathway.ph interns — profiled here, paid through the Payroll Wizard&apos;s Interns view.
            </p>
          </div>
          <div role="tablist" aria-label="Interns sections" className="inline-flex rounded-xl border border-pink-100 bg-pink-50/60 p-1 dark:border-pink-950/50 dark:bg-pink-950/20">
            {tabs.map((t) => (
              <button
                key={t.id}
                role="tab"
                type="button"
                aria-selected={pane === t.id}
                onClick={() => setPane(t.id)}
                title={t.hint}
                className={cn(
                  'flex items-center gap-1.5 rounded-lg px-3 py-1.5 text-xs font-semibold transition-colors',
                  pane === t.id
                    ? 'bg-white text-pink-700 shadow-sm dark:bg-zinc-900 dark:text-pink-300'
                    : 'text-zinc-500 hover:text-pink-700 dark:text-zinc-400 dark:hover:text-pink-300',
                )}
              >
                <t.Icon className="h-3.5 w-3.5" />
                {t.label}
              </button>
            ))}
          </div>
        </div>
      </div>
      <div className="flex min-h-0 flex-1 flex-col">
        {pane === 'profiles' ? (
          <InternsProfilesPanel viewerEmail={viewerEmail} canEdit={canEdit} />
        ) : (
          <InternsWizard viewerEmail={viewerEmail} canEdit={canEdit} onGoToProfiles={() => setPane('profiles')} />
        )}
      </div>
    </div>
  );
}
