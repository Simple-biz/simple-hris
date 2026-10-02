'use client';

import { useEffect, useRef, useState } from 'react';
import { CircleCheck, Clock, LoaderCircle, RefreshCw, TriangleAlert, X } from 'lucide-react';

import { cn } from '@/lib/utils';
import { NPD_SHEET_LABELS, type NpdSheetKind } from '@/lib/npd/columns';
import { GOOGLE_SHEET_TABS, type NpdImportSummary } from '@/lib/npd/google-sheet-import';
import { weekLabel } from '@/lib/npd/sheet';
import type { LockResult, NpdImportPayload, NpdSyncStamp } from './useNpdSheet';

/**
 * NPD's Google Sheet sync: "All Dept Payroll CSV" (moved here from Payroll Wizard →
 * Initialize Payroll Data, 2026-10-02) and "Hogan Payroll Sync". Each loads ITS
 * tab of the Google Sheet for the week the Payroll Wizard is on, onto its NPD tab.
 * Each button lives on its own tab only (Kane, 2026-10-02: "Separate each sync
 * button please put them in their respective tabs"): All Departments shows All
 * Dept Payroll CSV, HSL shows Hogan Payroll Sync, and a sync only ever fills the
 * tab it was clicked on. Governing doc: docs/features/npd-dashboard.md § Google Sheet sync.
 *
 * ONLY THE CURRENT WEEK (Kane, 2026-10-02): the week is always the wizard's live one,
 * never the week on screen, and the save refuses a sync for any other week. The bar
 * shows when this tab last synced that week ("Last synced …"), stamped by the server
 * when the sync's save landed.
 *
 * Read first, then confirm: the rows are fetched (GET /api/accounting/npd/google-sheet),
 * and a week that already has saved rows asks before they are replaced. A locked
 * week is refused here and again by the server's save. Shown to edit grants only.
 */

export type NpdSyncData = NpdImportPayload & {
  week: string;
  sourceFile: string;
  tab: string;
  summary: NpdImportSummary;
};

/** What NPD holds for a tab × week: saved rows (null = unknown) and its lock. */
export type NpdSyncTarget = { rows: number | null; locked: boolean };

type Busy = { kind: NpdSheetKind; step: 'reading' | 'applying' };
type LastSync = { at: string; by: string; tab: string | null };
type WizardWeek = {
  week: string;
  sourceFile: string;
  /** null = could not be read (lastSyncError says why); a tab's null = never synced this week. */
  lastSync: Record<NpdSheetKind, LastSync | null> | null;
  lastSyncError: string | null;
};

/** "Oct 2, 3:14 PM EDT": the reader's clock, with its zone named. */
function formatSyncStamp(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  return d.toLocaleString('en-US', { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit', timeZoneName: 'short' });
}
type Confirm = { kind: NpdSheetKind; data: NpdSyncData; rows: number | null };
type Outcome = { kind: NpdSheetKind; ok: boolean; message: string };

const TONE: Record<NpdSheetKind, string> = {
  all_departments:
    'border-sky-200 bg-white text-sky-900 enabled:hover:border-sky-300 enabled:hover:bg-sky-50 dark:border-sky-900/60 dark:bg-zinc-950 dark:text-sky-100 dark:enabled:hover:bg-sky-950/40',
  hsl: 'border-violet-200 bg-white text-violet-900 enabled:hover:border-violet-300 enabled:hover:bg-violet-50 dark:border-violet-900/60 dark:bg-zinc-950 dark:text-violet-100 dark:enabled:hover:bg-violet-950/40',
};
const ICON_TONE: Record<NpdSheetKind, string> = {
  all_departments: 'text-sky-600 dark:text-sky-400',
  hsl: 'text-violet-600 dark:text-violet-400',
};

function summaryLine(d: NpdSyncData): string {
  const s = d.summary;
  const parts = [`${s.rows} row${s.rows === 1 ? '' : 's'} from “${d.tab}” for ${weekLabel(d.week)}`];
  parts.push(s.rate ? `rate ${s.rate}` : 'no rate in its USD formulas, so USD stays as the sheet has it');
  if (s.otherRates.length) {
    const n = s.otherRates.reduce((a, o) => a + o.rows, 0);
    parts.push(`${n} row${n === 1 ? '' : 's'} with another rate kept as typed`);
  }
  if (s.typedCells) parts.push(`${s.typedCells} typed cell${s.typedCells === 1 ? '' : 's'} kept as the sheet has them (amber)`);
  const skippedNoWeek = s.skipped.noWeek + s.skipped.unreadableWeek;
  if (skippedNoWeek) parts.push(`${skippedNoWeek} row${skippedNoWeek === 1 ? '' : 's'} in the tab with no readable week left out`);
  return parts.join(' · ');
}

export default function NpdGoogleSheetSync({
  sheet,
  stamp,
  targetOf,
  onApply,
  disabled,
}: {
  /** The tab on screen: the only one whose button is shown and which a sync fills. */
  sheet: NpdSheetKind;
  /** A sync whose save landed in this page: the server's timestamp (newer than the one read on load). */
  stamp: NpdSyncStamp | null;
  /** What NPD holds for that tab × week right now. */
  targetOf: (sheet: NpdSheetKind, week: string) => NpdSyncTarget;
  /** Switch to the tab × week and put the rows on it (saved straight away). */
  onApply: (sheet: NpdSheetKind, data: NpdSyncData) => Promise<LockResult>;
  disabled: boolean;
}) {
  const [wizardWeek, setWizardWeek] = useState<WizardWeek | null>(null);
  const [wizardError, setWizardError] = useState<string | null>(null);
  const [busy, setBusy] = useState<Busy | null>(null);
  const [confirm, setConfirm] = useState<Confirm | null>(null);
  const [outcome, setOutcome] = useState<Outcome | null>(null);

  // The tab on screen now, for a read that finishes after the person moved on.
  const sheetRef = useRef(sheet);
  sheetRef.current = sheet;

  // Another tab: its own button, and nothing left over from this one's.
  useEffect(() => {
    setConfirm(null);
    setOutcome(null);
  }, [sheet]);

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        const res = await fetch('/api/accounting/npd/google-sheet', { cache: 'no-store' });
        const j = (await res.json().catch(() => ({}))) as Partial<WizardWeek> & { error?: string };
        if (cancelled) return;
        if (res.ok && j.week && j.sourceFile) {
          setWizardWeek({
            week: j.week,
            sourceFile: j.sourceFile,
            lastSync: j.lastSync ?? null,
            lastSyncError: j.lastSyncError ?? (j.lastSync ? null : 'When this week was last synced could not be read.'),
          });
        } else setWizardError(j.error ?? `The Payroll Wizard's week could not be read (${res.status}).`);
      } catch (e) {
        if (!cancelled) setWizardError(e instanceof Error ? e.message : "The Payroll Wizard's week could not be read.");
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  const apply = async (kind: NpdSheetKind, data: NpdSyncData) => {
    setConfirm(null);
    setBusy({ kind, step: 'applying' });
    const r = await onApply(kind, data);
    setBusy(null);
    setOutcome({
      kind,
      ok: r.ok,
      message: r.ok ? `Synced ${summaryLine(data)}. Saving it to NPD now; the time below updates once it is saved.` : (r.message ?? 'Nothing was synced.'),
    });
  };

  const run = async (kind: NpdSheetKind) => {
    setOutcome(null);
    setConfirm(null);
    setBusy({ kind, step: 'reading' });
    let data: NpdSyncData | null = null;
    let error: string | null = null;
    try {
      const res = await fetch(`/api/accounting/npd/google-sheet?sheet=${kind}`, { cache: 'no-store' });
      const j = (await res.json().catch(() => ({}))) as Partial<NpdSyncData> & { error?: string };
      if (res.ok && Array.isArray(j.rows) && j.week && j.summary) {
        data = j as NpdSyncData;
        const week = j.week;
        // The wizard may have moved on since the page opened: keep its week current.
        setWizardWeek((w) =>
          w && w.week === week
            ? w
            : { week, sourceFile: j.sourceFile ?? '', lastSync: null, lastSyncError: 'When this week was last synced could not be read: reload the page.' },
        );
        setWizardError(null);
      } else error = j.error ?? `The Google Sheet could not be read (${res.status}).`;
    } catch (e) {
      error = e instanceof Error ? e.message : 'The Google Sheet could not be read.';
    }
    if (sheetRef.current !== kind) {
      // They moved to the other tab while the Google Sheet was being read: a sync
      // never pulls them back to fill a tab they left.
      setBusy(null);
      return;
    }
    if (!data) {
      setBusy(null);
      setOutcome({ kind, ok: false, message: `${error} Nothing was changed.` });
      return;
    }
    const target = targetOf(kind, data.week);
    if (target.locked) {
      setBusy(null);
      setOutcome({
        kind,
        ok: false,
        message: `${NPD_SHEET_LABELS[kind]} for ${weekLabel(data.week)} is locked in, so nothing was changed. Unlock it first.`,
      });
      return;
    }
    if (target.rows === 0) {
      await apply(kind, data);
      return;
    }
    setBusy(null);
    setConfirm({ kind, data, rows: target.rows });
  };

  const btn =
    'inline-flex h-8 items-center gap-1.5 rounded-lg border px-3 text-xs font-semibold transition-colors disabled:cursor-not-allowed disabled:opacity-50';

  // When THIS tab last synced the wizard's week: a save from this page beats what was read on load.
  const fromPage = stamp && wizardWeek && stamp.sheet === sheet && stamp.week === wizardWeek.week ? stamp : null;
  const fromServer = wizardWeek?.lastSync?.[sheet] ?? null;
  const last: LastSync | null =
    fromPage && (!fromServer || Date.parse(fromPage.at) >= Date.parse(fromServer.at)) ? { at: fromPage.at, by: fromPage.by, tab: fromPage.tab } : fromServer;

  return (
    <section
      aria-label="Sync from the Google Sheet"
      className="flex flex-col gap-2 rounded-xl border border-zinc-200 bg-zinc-50/70 px-3.5 py-3 dark:border-zinc-800 dark:bg-zinc-900/40"
    >
      <div className="flex flex-wrap items-center gap-x-3 gap-y-2">
        <div className="min-w-0 flex-1 basis-64">
          <p className="text-xs font-semibold text-zinc-800 dark:text-zinc-100">Sync from the Google Sheet</p>
          <p className="text-[11px] leading-relaxed text-zinc-500 dark:text-zinc-400">
            {wizardWeek ? (
              <>
                Loads the Payroll Wizard’s week,{' '}
                <span className="font-medium text-zinc-700 dark:text-zinc-300">{weekLabel(wizardWeek.week)}</span>, from the
                Google Sheet’s “{GOOGLE_SHEET_TABS[sheet].title}” tab onto {NPD_SHEET_LABELS[sheet]}. Formulas, the rate and
                every typed figure come across as the sheet has them.
              </>
            ) : wizardError ? (
              <span className="text-amber-700 dark:text-amber-300">{wizardError}</span>
            ) : (
              'Reading the Payroll Wizard’s week…'
            )}
          </p>
          {wizardWeek && (
            <p className="mt-0.5 flex items-center gap-1 text-[11px] text-zinc-500 dark:text-zinc-400" data-testid="npd-last-sync">
              <Clock className="h-3 w-3 shrink-0" aria-hidden />
              {last ? (
                <span>
                  Last synced <span className="font-medium text-zinc-700 dark:text-zinc-300">{formatSyncStamp(last.at)}</span>
                  {last.by ? <> by {last.by}</> : null}
                </span>
              ) : wizardWeek.lastSync === null && !fromPage ? (
                <span className="text-amber-700 dark:text-amber-300">{wizardWeek.lastSyncError ?? 'When this week was last synced could not be read.'}</span>
              ) : (
                <span>Not synced yet for {weekLabel(wizardWeek.week)}</span>
              )}
            </p>
          )}
        </div>
        <button
          type="button"
          disabled={disabled || !!busy || !!confirm}
          onClick={() => void run(sheet)}
          title={`Load the Google Sheet’s “${GOOGLE_SHEET_TABS[sheet].title}” tab for the Payroll Wizard’s week onto ${NPD_SHEET_LABELS[sheet]}`}
          className={cn(btn, TONE[sheet])}
        >
          {busy?.kind === sheet ? (
            <LoaderCircle className={cn('h-3.5 w-3.5 animate-spin', ICON_TONE[sheet])} />
          ) : (
            <RefreshCw className={cn('h-3.5 w-3.5', ICON_TONE[sheet])} />
          )}
          {GOOGLE_SHEET_TABS[sheet].button}
        </button>
      </div>

      {busy && busy.kind === sheet && (
        <p className="text-[11px] text-zinc-600 dark:text-zinc-400" role="status">
          {busy.step === 'reading'
            ? `Reading the Google Sheet’s “${GOOGLE_SHEET_TABS[busy.kind].title}” tab…`
            : `Putting the rows on ${NPD_SHEET_LABELS[busy.kind]}…`}
        </p>
      )}

      {confirm && confirm.kind === sheet && (
        <div
          role="alertdialog"
          aria-label="Replace this week's sheet?"
          className="flex flex-wrap items-center gap-2 rounded-lg border border-amber-200 bg-amber-50 px-3 py-2 text-xs text-amber-900 dark:border-amber-900/60 dark:bg-amber-950/30 dark:text-amber-100"
        >
          <p className="min-w-0 flex-1 basis-72">
            Replace {confirm.rows === null ? 'what is saved' : `the ${confirm.rows} saved row${confirm.rows === 1 ? '' : 's'}`} on{' '}
            <span className="font-semibold">
              {NPD_SHEET_LABELS[confirm.kind]} · {weekLabel(confirm.data.week)}
            </span>{' '}
            with the Google Sheet’s {confirm.data.summary.rows}? The rate and any column formulas are replaced too. Undo
            puts them back, and the rows it replaces are recorded first.
          </p>
          <button
            type="button"
            autoFocus
            onClick={() => void apply(confirm.kind, confirm.data)}
            className={cn(btn, 'border-amber-600 bg-amber-600 text-white enabled:hover:bg-amber-700')}
          >
            Replace
          </button>
          <button
            type="button"
            onClick={() => setConfirm(null)}
            className={cn(btn, 'border-transparent text-amber-900 hover:bg-amber-100 dark:text-amber-100 dark:hover:bg-amber-900/40')}
          >
            Cancel
          </button>
        </div>
      )}

      {outcome && outcome.kind === sheet && (
        <div
          role={outcome.ok ? 'status' : 'alert'}
          className={cn(
            'flex items-start gap-2 text-[11px] leading-relaxed',
            outcome.ok ? 'text-emerald-800 dark:text-emerald-300' : 'text-red-700 dark:text-red-300',
          )}
        >
          {outcome.ok ? <CircleCheck className="mt-0.5 h-3.5 w-3.5 shrink-0" /> : <TriangleAlert className="mt-0.5 h-3.5 w-3.5 shrink-0" />}
          <p className="min-w-0 flex-1">{outcome.message}</p>
          <button
            type="button"
            aria-label="Dismiss"
            onClick={() => setOutcome(null)}
            className="shrink-0 rounded p-0.5 text-current opacity-70 hover:opacity-100"
          >
            <X className="h-3 w-3" />
          </button>
        </div>
      )}
    </section>
  );
}
