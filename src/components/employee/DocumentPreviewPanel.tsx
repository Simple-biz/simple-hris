'use client';

import React from 'react';
import { AlertTriangle, FileCheck2, FileQuestionMark, LayoutTemplate, Loader2 } from 'lucide-react';
import { isSystemGeneratedType, type CoePreviewFacts, type DocumentRequestType } from '@/lib/documents/types';

/** Two made-up weeks, illustrative only — never a real employee's figures.
 *  Mirrors the branded PDF's current column set (Period / Regular / Overtime /
 *  Weekend / Net) so the mockup doesn't promise columns the real export
 *  doesn't have. */
const SAMPLE_ROWS: Array<{ period: string; regular: string; overtime: string; weekend: string; net: string }> = [
  { period: 'Jul 21 - 27, 2026', regular: '4,200.00', overtime: '350.00', weekend: '-', net: '4,550.00' },
  { period: 'Jul 14 - 20, 2026', regular: '4,200.00', overtime: '-', weekend: '620.00', net: '4,820.00' },
];

function PaystubMockup() {
  return (
    <div className="overflow-hidden rounded-lg border border-zinc-200 dark:border-zinc-800">
      <div className="flex items-center justify-between bg-[#212354] px-3 py-2">
        <span className="text-[11.5px] font-semibold text-white">Simple</span>
        <span className="rounded-full bg-white/15 px-2 py-0.5 text-[9.5px] font-semibold uppercase tracking-wide text-white/80">
          Sample
        </span>
      </div>
      <div className="overflow-x-auto px-3 py-2.5">
        <table className="w-full min-w-[420px] border-collapse text-[10.5px]">
          <thead>
            <tr className="text-left text-zinc-400 dark:text-zinc-500">
              <th className="pb-1.5 font-medium">Period Ending</th>
              <th className="pb-1.5 text-right font-medium">Regular</th>
              <th className="pb-1.5 text-right font-medium">Overtime</th>
              <th className="pb-1.5 text-right font-medium">Weekend</th>
              <th className="pb-1.5 text-right font-medium">Net (PHP)</th>
            </tr>
          </thead>
          <tbody>
            {SAMPLE_ROWS.map((r) => (
              <tr
                key={r.period}
                className="border-t border-zinc-100 text-zinc-600 dark:border-zinc-800/70 dark:text-zinc-400"
              >
                <td className="py-1.5 whitespace-nowrap">{r.period}</td>
                <td className="py-1.5 text-right">{r.regular}</td>
                <td className="py-1.5 text-right">{r.overtime}</td>
                <td className="py-1.5 text-right">{r.weekend}</td>
                <td className="py-1.5 text-right font-medium text-zinc-800 dark:text-zinc-200">{r.net}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}

function EmptyPreview({ text }: { text: string }) {
  return (
    <div className="flex h-full flex-col items-center justify-center gap-2 py-8 text-center">
      <FileQuestionMark className="h-6 w-6 text-zinc-300 dark:text-zinc-700" />
      <p className="max-w-[220px] text-[12px] leading-relaxed text-zinc-400 dark:text-zinc-500">{text}</p>
    </div>
  );
}

/** The live "what this certificate will say" content — moved here verbatim
 *  from the old inline block so the preview panel is a straight relocation,
 *  not a behavior change. */
function CoePreview({
  loading,
  blocked,
  facts,
}: {
  loading: boolean;
  blocked: string | null;
  facts: CoePreviewFacts | null;
}) {
  if (loading) {
    return (
      <div className="flex items-center gap-2 py-2 text-[12.5px] text-zinc-500 dark:text-zinc-400">
        <Loader2 className="h-3.5 w-3.5 animate-spin" />
        Loading your details…
      </div>
    );
  }
  if (blocked) {
    return (
      <div className="flex items-start gap-2.5">
        <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0 text-amber-500" />
        <div className="min-w-0 flex-1">
          <p className="text-[12.5px] font-medium text-zinc-800 dark:text-zinc-200">
            This certificate can&rsquo;t be issued yet
          </p>
          <p className="mt-0.5 text-[12px] leading-relaxed text-zinc-500 dark:text-zinc-400">{blocked}</p>
        </div>
      </div>
    );
  }
  if (!facts) return null;
  return (
    <>
      <div className="flex items-start gap-2.5">
        <FileCheck2 className="mt-0.5 h-4 w-4 shrink-0 text-emerald-500" />
        <div className="min-w-0 flex-1">
          <p className="text-[12.5px] font-medium text-zinc-800 dark:text-zinc-200">
            Nothing to attach — we generate this for you
          </p>
          <p className="mt-0.5 text-[12px] leading-relaxed text-zinc-500 dark:text-zinc-400">
            Taken from your records. Check it over, then submit — Accounting reviews and signs it.
          </p>
        </div>
      </div>
      <dl className="mt-3 grid grid-cols-1 gap-x-6 gap-y-2 border-t border-zinc-200/70 pt-3 dark:border-zinc-800/70 sm:grid-cols-[auto_1fr]">
        {(
          [
            ['Worker', facts.employeeId ? `${facts.workerName} · ${facts.employeeId}` : facts.workerName],
            ['Engaged since', facts.startDateLabel],
            ['Team', facts.team],
            ['Hourly / OT', `${facts.hourlyRate} · ${facts.overtimeRate} per hour`],
            ['Schedule', `${facts.weeklyHours} hours per week`],
          ] as const
        ).map(([label, value]) => (
          <React.Fragment key={label}>
            <dt className="text-[11.5px] font-medium uppercase tracking-wide text-zinc-400 dark:text-zinc-500">
              {label}
            </dt>
            <dd className="mb-1 text-[12.5px] text-zinc-800 dark:text-zinc-200 sm:mb-0">{value}</dd>
          </React.Fragment>
        ))}
        <dt className="text-[11.5px] font-medium uppercase tracking-wide text-zinc-400 dark:text-zinc-500">
          Bonuses
        </dt>
        <dd className="text-[12.5px] leading-relaxed text-zinc-800 dark:text-zinc-200">
          {facts.standardBonuses.length === 0 && facts.performanceBonuses.length === 0 ? (
            <span className="text-zinc-400 dark:text-zinc-500">None you currently qualify for</span>
          ) : (
            <>
              {facts.standardBonuses.map((b) => (
                <div key={b.label}>
                  {b.label}: {b.amount}
                </div>
              ))}
              <div>
                Performance:{' '}
                {facts.performanceBonuses.length > 0 ? (
                  facts.performanceBonuses.map((b) => (b.amount ? `${b.label} (${b.amount})` : b.label)).join(', ')
                ) : (
                  <span className="text-zinc-400 dark:text-zinc-500">none assigned</span>
                )}
              </div>
            </>
          )}
        </dd>
      </dl>
      <p className="mt-3 border-t border-zinc-200/70 pt-2.5 text-[11px] leading-relaxed text-zinc-400 dark:border-zinc-800/70 dark:text-zinc-500">
        Something wrong here? Contact Accounting before submitting — the signed certificate states these figures.
      </p>
    </>
  );
}

/**
 * Right-hand column of the Request Documents form — shows what the selected
 * document type looks like. Paystub gets an illustrative sample-data mockup
 * (the real file only exists after "Generate & attach PDF"); COE gets the
 * real live facts card (system-generated, so the facts ARE the preview);
 * everything else (award, other) gets a plain placeholder since there's
 * nothing to preview until the employee attaches their own PDF.
 */
export function DocumentPreviewPanel({
  docType,
  coeLoading,
  coeBlocked,
  coeFacts,
}: {
  docType: '' | DocumentRequestType;
  coeLoading: boolean;
  coeBlocked: string | null;
  coeFacts: CoePreviewFacts | null;
}) {
  return (
    <div className="flex h-full flex-col rounded-xl border border-zinc-200/80 bg-zinc-50/60 dark:border-zinc-800/80 dark:bg-zinc-900/40">
      <div className="flex items-center gap-1.5 border-b border-zinc-200/70 px-4 py-3 dark:border-zinc-800/70">
        <LayoutTemplate className="h-3.5 w-3.5 text-zinc-400" />
        <span className="text-[12px] font-medium text-zinc-700 dark:text-zinc-200">Document preview</span>
      </div>
      <div className="flex-1 px-4 py-3.5">
        {!docType ? (
          <EmptyPreview text="Select a document type above to see a preview." />
        ) : docType === 'paystub' ? (
          <>
            <PaystubMockup />
            <p className="mt-2.5 text-[11px] leading-relaxed text-zinc-400 dark:text-zinc-500">
              Illustrative layout with sample figures. Your real statement is built when you click
              &ldquo;Generate &amp; attach PDF.&rdquo;
            </p>
          </>
        ) : isSystemGeneratedType(docType) ? (
          <CoePreview loading={coeLoading} blocked={coeBlocked} facts={coeFacts} />
        ) : (
          <EmptyPreview text="No preview available — attach your PDF on the left for Accounting to review." />
        )}
      </div>
    </div>
  );
}
