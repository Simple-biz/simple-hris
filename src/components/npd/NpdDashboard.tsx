'use client';

import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { motion, useReducedMotion } from 'motion/react';
import {
  ChevronLeft,
  ChevronRight,
  CircleCheck,
  CloudAlert,
  Eye,
  LoaderCircle,
  Lock,
  LockOpen,
  RefreshCw,
  Sheet,
  TriangleAlert,
} from 'lucide-react';

import { cn } from '@/lib/utils';
import { manilaTodayIso } from '@/lib/payroll/manila-week';
import { NPD_COLUMNS, NPD_SHEETS, NPD_SHEET_LABELS, isNpdSheetKind, type NpdSheetKind } from '@/lib/npd/columns';
import { defaultNpdWeek, isBlankRow, shiftWeek, weekLabel } from '@/lib/npd/sheet';
import { TAB_CACHE_KEYS, getTabCache, setTabCache } from '@/lib/accounting/tab-cache';
import { parseNpdView, parseNpdWeeks } from '@/lib/npd/npd-cache';
import NpdGoogleSheetSync, { type NpdSyncData, type NpdSyncTarget } from './NpdGoogleSheetSync';
import NpdLockDialog from './NpdLockDialog';
import NpdSheetGrid from './NpdSheetGrid';
import NpdSheetSkeleton from './NpdSheetSkeleton';
import { contextOf, useNpdSheet, type LockResult } from './useNpdSheet';

/**
 * Accounting → NPD (New Payroll Dashboard). The manual version of the Payroll
 * Wizard: a sheet per tab (All Departments | HSL) per pay week that Accounting
 * pastes from Google Sheets, or syncs from it (All Dept Payroll CSV · Hogan Payroll
 * Sync, for the Payroll Wizard's week). Nothing is imported from HRIS and nothing
 * here pays anyone. Governing doc: docs/features/npd-dashboard.md.
 *
 * Formulas: every calculated column follows the Google Sheet's formula (right-click
 * a cell to see or edit it); this sheet's PHP→USD rate is typed here, per tab per
 * week, never carried over (the Google Sheet typed it into each week's formula).
 *
 * Lock in freezes the tab on screen for the week on screen. The database refuses
 * every save on a locked sheet; this page only mirrors that (read-only grid, the
 * Locked in pill) and never decides it.
 */

type WeekEntry = {
  sheet: NpdSheetKind;
  week: string;
  rowCount: number;
  updatedAt: string;
  updatedBy: string;
  lockedAt: string | null;
};

const SHEET_STORAGE_KEY = 'accounting.npd.sheet';

function readStoredSheet(): NpdSheetKind {
  try {
    const v = sessionStorage.getItem(SHEET_STORAGE_KEY);
    return isNpdSheetKind(v) ? v : 'all_departments';
  } catch {
    return 'all_departments';
  }
}

function formatStamp(iso: string | null): string {
  if (!iso) return '';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '';
  return d.toLocaleString('en-US', { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' });
}

/** The house tab ease (accounting-scoreboard SlidingPill): a confident arrival. */
const EASE_TAB = [0.22, 1, 0.36, 1] as const;

export default function NpdDashboard({ canEdit }: { canEdit: boolean }) {
  const reduceMotion = useReducedMotion() ?? false;
  const [sheet, setSheet] = useState<NpdSheetKind>(readStoredSheet);
  // Seen before: the week menu and the opening week paint from the cache at once; the
  // live list is still read on every open (docs/features/npd-dashboard.md § Caching).
  const [weeks, setWeeks] = useState<WeekEntry[] | null>(() => parseNpdWeeks(getTabCache(TAB_CACHE_KEYS.npdWeeks)));
  // Returning in the same browser session lands on the week you left (whose sheet the cache
  // holds); otherwise the newest week the cached list knew; otherwise the live rule below.
  const [week, setWeek] = useState<string | null>(
    () => parseNpdView(getTabCache(TAB_CACHE_KEYS.npdView))?.week ?? weeks?.find((w) => w.rowCount > 0)?.week ?? null,
  );
  useEffect(() => {
    if (week) setTabCache(TAB_CACHE_KEYS.npdView, { week });
  }, [week]);
  const [weeksError, setWeeksError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [switching, setSwitching] = useState(false);
  const noticeTimer = useRef<number | null>(null);

  const ctl = useNpdSheet(sheet, week, canEdit);
  const columns = NPD_COLUMNS[sheet];
  const readOnly = !canEdit;
  // Memoised: the grid re-derives every row's formulas when this changes.
  const ctx = useMemo(() => contextOf(ctl.settings), [ctl.settings]);
  const [rateDraft, setRateDraft] = useState<string | null>(null);
  const [rateError, setRateError] = useState<string | null>(null);
  const rateEditable = canEdit && !ctl.locked && !ctl.conflict && ctl.loadState === 'ready' && !ctl.refreshing;
  const commitRate = () => {
    if (rateDraft === null) return;
    const problem = ctl.setRate(rateDraft);
    setRateError(problem);
    if (!problem) setRateDraft(null);
  };

  const showNotice = useCallback((message: string) => {
    setNotice(message);
    if (noticeTimer.current != null) window.clearTimeout(noticeTimer.current);
    noticeTimer.current = window.setTimeout(() => setNotice(null), 9000);
  }, []);

  useEffect(() => () => {
    if (noticeTimer.current != null) window.clearTimeout(noticeTimer.current);
  }, []);

  // ── Weeks with a sheet ──────────────────────────────────────────────────
  const loadWeeks = useCallback(async (): Promise<WeekEntry[] | null> => {
    try {
      const res = await fetch('/api/accounting/npd?list=weeks', { cache: 'no-store' });
      const j = (await res.json().catch(() => ({}))) as { weeks?: WeekEntry[]; error?: string };
      if (!res.ok || !Array.isArray(j.weeks)) {
        setWeeksError(j.error ?? `Could not load the weeks (${res.status})`);
        return null;
      }
      setWeeks(j.weeks);
      setTabCache(TAB_CACHE_KEYS.npdWeeks, j.weeks);
      setWeeksError(null);
      return j.weeks;
    } catch (e) {
      setWeeksError(e instanceof Error ? e.message : 'Could not load the weeks');
      return null;
    }
  }, []);

  // First open: the newest week that has rows on either tab, else the week
  // payroll is being run for (the last completed Sun–Sat week).
  useEffect(() => {
    let cancelled = false;
    void loadWeeks().then((list) => {
      if (cancelled) return;
      const newest = (list ?? []).find((w) => w.rowCount > 0);
      setWeek((cur) => cur ?? newest?.week ?? defaultNpdWeek(manilaTodayIso()));
    });
    return () => {
      cancelled = true;
    };
  }, [loadWeeks]);

  // A save can create or empty a week; keep the menu honest.
  const savedVersion = ctl.meta?.version ?? null;
  useEffect(() => {
    if (savedVersion != null && savedVersion > 0) void loadWeeks();
  }, [savedVersion, loadWeeks]);

  const weekOptions = useMemo(() => {
    const byWeek = new Map<string, Partial<Record<NpdSheetKind, { rows: number; locked: boolean }>>>();
    for (const w of weeks ?? []) {
      if (w.rowCount <= 0) continue;
      const e = byWeek.get(w.week) ?? {};
      e[w.sheet] = { rows: w.rowCount, locked: !!w.lockedAt };
      byWeek.set(w.week, e);
    }
    if (week && !byWeek.has(week)) byWeek.set(week, {});
    return [...byWeek.entries()]
      .sort((x, y) => (x[0] < y[0] ? 1 : -1))
      .map(([wk, counts]) => {
        const parts = NPD_SHEETS.filter((s) => counts[s]).map(
          (s) => `${NPD_SHEET_LABELS[s]} ${counts[s]!.rows}${counts[s]!.locked ? ' (locked)' : ''}`,
        );
        return { week: wk, label: `${weekLabel(wk)}${parts.length ? ` · ${parts.join(' · ')}` : ' · no sheet yet'}` };
      });
  }, [weeks, week]);

  // ── Lock in ─────────────────────────────────────────────────────────────
  const onLock = useCallback(async (): Promise<LockResult> => {
    const r = await ctl.lock();
    if (r.message) showNotice(r.message);
    if (r.ok) void loadWeeks();
    return r;
  }, [ctl, showNotice, loadWeeks]);

  const onUnlock = useCallback(
    async (reason: string): Promise<LockResult> => {
      const r = await ctl.unlock(reason);
      if (r.message) showNotice(r.message);
      if (r.ok) void loadWeeks();
      return r;
    },
    [ctl, showNotice, loadWeeks],
  );

  const hasSavedRows = !!ctl.meta && ctl.meta.version > 0 && ctl.meta.rowCount > 0;
  const lockBlockedBy =
    ctl.loadState !== 'ready' || ctl.refreshing
      ? 'The sheet is still loading.'
      : !hasSavedRows
        ? 'Nothing to lock yet: paste or type the sheet first.'
        : ctl.saveState === 'conflict' || ctl.saveState === 'error' || ctl.saveState === 'locked'
          ? 'Resolve the message below first.'
          : switching
            ? 'Saving…'
            : null;

  // Which way the last switch went (-1 back / +1 forward), so the sheet glides in from that side.
  const [switchDir, setSwitchDir] = useState(0);

  // ── Switching tab or week: save first, never drop edits ─────────────────
  /** Resolves false when the switch did not happen (unsaved edits on this sheet). */
  const switchTo = useCallback(
    async (next: { sheet?: NpdSheetKind; week?: string }): Promise<boolean> => {
      if ((next.sheet ?? sheet) === sheet && (next.week ?? week) === week) return true;
      setSwitching(true);
      const ok = await ctl.flush();
      setSwitching(false);
      if (!ok) {
        showNotice('Not switched: your latest edits on this sheet are not saved yet. Resolve the message above first.');
        return false;
      }
      const nextSheet = next.sheet ?? sheet;
      const nextWeek = next.week ?? week;
      setSwitchDir(
        nextSheet !== sheet
          ? Math.sign(NPD_SHEETS.indexOf(nextSheet) - NPD_SHEETS.indexOf(sheet))
          : nextWeek && week
            ? nextWeek > week
              ? 1
              : -1
            : 0,
      );
      if (next.sheet) {
        setSheet(next.sheet);
        try {
          sessionStorage.setItem(SHEET_STORAGE_KEY, next.sheet);
        } catch {
          /* ignore */
        }
      }
      if (next.week) setWeek(next.week);
      setNotice(null);
      return true;
    },
    [ctl, sheet, week, showNotice],
  );

  // ── Google Sheet sync (All Dept Payroll CSV · Hogan Payroll Sync) ────────
  /** What a sync would replace: the rows on screen for the open sheet, else the saved count. */
  const syncTargetOf = useCallback(
    (kind: NpdSheetKind, wk: string): NpdSyncTarget => {
      if (kind === sheet && wk === week && ctl.loadState === 'ready') {
        const onScreen = ctl.rows.filter((r) => !isBlankRow(r)).length;
        return { rows: Math.max(onScreen, ctl.meta?.rowCount ?? 0), locked: ctl.locked };
      }
      if (!weeks) return { rows: null, locked: false };
      const entry = weeks.find((w) => w.sheet === kind && w.week === wk);
      return { rows: entry?.rowCount ?? 0, locked: !!entry?.lockedAt };
    },
    [sheet, week, weeks, ctl.loadState, ctl.rows, ctl.meta, ctl.locked],
  );

  const onSyncApply = useCallback(
    async (kind: NpdSheetKind, data: NpdSyncData): Promise<LockResult> => {
      const notSaved = { ok: false, message: 'Not synced: your latest edits on this sheet are not saved yet. Resolve the message above first.' };
      // Edits on screen are saved before anything replaces them, even on the same sheet.
      if (!(await ctl.flush())) return notSaved;
      if (!(await switchTo({ sheet: kind, week: data.week }))) return notSaved;
      return ctl.importSheet(
        { sheet: kind, week: data.week },
        { rows: data.rows, rateText: data.rateText, tab: data.tab, sourceFile: data.sourceFile || null },
      );
    },
    [ctl, switchTo],
  );

  return (
    <div className="flex min-h-0 flex-1 flex-col gap-4 overflow-y-auto p-4 md:p-6">
      {/* ── Header ──────────────────────────────────────────────────────── */}
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="flex min-w-0 items-start gap-3">
          <div className="flex h-10 w-10 shrink-0 items-center justify-center rounded-xl bg-gradient-to-br from-orange-100 to-amber-100 text-orange-700 ring-1 ring-orange-100 dark:from-orange-950/60 dark:to-amber-950/40 dark:text-orange-300 dark:ring-orange-900/60">
            <Sheet className="h-5 w-5" />
          </div>
          <div className="min-w-0">
            <p className="text-[11px] font-semibold uppercase tracking-[0.18em] text-orange-700 dark:text-orange-300">NPD</p>
            <h2 className="mt-0.5 text-2xl font-bold tracking-tight text-zinc-900 dark:text-white">New Payroll Dashboard</h2>
          </div>
        </div>
        <SaveStatus
          readOnly={readOnly}
          cachedCopy={ctl.refreshing ? (ctl.refreshError ? 'failed' : 'refreshing') : null}
          locked={ctl.locked}
          loading={ctl.loadState === 'loading'}
          saveState={ctl.saveState}
          version={ctl.meta?.version ?? 0}
          onRetry={ctl.retrySave}
        />
      </div>

      {/* ── Tab + week ──────────────────────────────────────────────────── */}
      <div className="flex flex-wrap items-center gap-3">
        <div role="tablist" aria-label="NPD sheet" className="inline-flex rounded-xl border border-zinc-200 bg-zinc-50 p-1 dark:border-zinc-800 dark:bg-zinc-900/60">
          {NPD_SHEETS.map((s) => (
            <button
              key={s}
              role="tab"
              type="button"
              aria-selected={sheet === s}
              disabled={switching}
              onClick={() => void switchTo({ sheet: s })}
              className={cn(
                'relative rounded-lg px-3 py-1.5 text-xs font-semibold transition-colors duration-200',
                sheet === s
                  ? 'text-orange-700 dark:text-orange-300'
                  : 'text-zinc-500 hover:text-zinc-800 dark:text-zinc-400 dark:hover:text-zinc-200',
              )}
            >
              {/* The white tab slides to the one you picked (same motion as the scoreboard's SlidingPill). */}
              {sheet === s && (
                <motion.span
                  layoutId="npd-sheet-tab"
                  aria-hidden
                  className="absolute inset-0 rounded-lg bg-white shadow-sm dark:bg-zinc-950"
                  transition={{ duration: reduceMotion ? 0 : 0.28, ease: EASE_TAB }}
                />
              )}
              <span className="relative z-10">{NPD_SHEET_LABELS[s]}</span>
            </button>
          ))}
        </div>

        <div className="flex min-w-0 max-w-full items-center gap-1.5" data-readonly-allow>
          <button
            type="button"
            aria-label="Previous week"
            title="Previous week"
            disabled={!week || switching}
            onClick={() => week && void switchTo({ week: shiftWeek(week, -1) })}
            className="inline-flex h-8 w-8 shrink-0 items-center justify-center rounded-lg border border-zinc-200 bg-white text-zinc-600 enabled:hover:border-orange-300 enabled:hover:text-orange-700 disabled:opacity-40 dark:border-zinc-800 dark:bg-zinc-950 dark:text-zinc-300"
          >
            <ChevronLeft className="h-4 w-4" />
          </button>
          <label className="sr-only" htmlFor="npd-week">
            Pay week
          </label>
          <select
            id="npd-week"
            value={week ?? ''}
            disabled={!week || switching}
            onChange={(e) => void switchTo({ week: e.target.value })}
            className="h-8 min-w-0 flex-1 rounded-lg border border-zinc-200 bg-white px-2.5 text-sm font-medium text-zinc-800 sm:max-w-[27rem] sm:flex-none dark:border-zinc-800 dark:bg-zinc-950 dark:text-zinc-100"
          >
            {!week && <option value="">Loading weeks…</option>}
            {weekOptions.map((o) => (
              <option key={o.week} value={o.week}>
                {o.label}
              </option>
            ))}
          </select>
          <button
            type="button"
            aria-label="Next week"
            title="Next week"
            disabled={!week || switching}
            onClick={() => week && void switchTo({ week: shiftWeek(week, 1) })}
            className="inline-flex h-8 w-8 shrink-0 items-center justify-center rounded-lg border border-zinc-200 bg-white text-zinc-600 enabled:hover:border-orange-300 enabled:hover:text-orange-700 disabled:opacity-40 dark:border-zinc-800 dark:bg-zinc-950 dark:text-zinc-300"
          >
            <ChevronRight className="h-4 w-4" />
          </button>
          {switching && <LoaderCircle className="h-4 w-4 animate-spin text-zinc-400" aria-label="Saving before switching" />}
        </div>

        <p className="text-xs text-zinc-500 dark:text-zinc-400">
          {ctl.meta && ctl.meta.version > 0 && ctl.meta.updatedBy ? (
            <>
              Last saved by <span className="font-medium text-zinc-700 dark:text-zinc-300">{ctl.meta.updatedBy}</span>
              {ctl.meta.updatedAt ? ` · ${formatStamp(ctl.meta.updatedAt)}` : ''}
            </>
          ) : ctl.loadState === 'ready' ? (
            'Nothing saved for this tab and week yet.'
          ) : ctl.loadState === 'loading' ? (
            <span aria-hidden className="inline-block h-2.5 w-52 animate-pulse rounded-full bg-zinc-200 align-middle motion-reduce:animate-none dark:bg-zinc-800" />
          ) : null}
        </p>
        {weeksError && (
          <p className="text-xs text-amber-700 dark:text-amber-300" role="status">
            The week list could not be loaded ({weeksError}). The arrows still work.
          </p>
        )}
        {/* Shown while loading too (disabled), so the row keeps its height and the grid does not jump. */}
        {(ctl.loadState === 'ready' || ctl.loadState === 'loading') && (
          <div className="flex flex-col gap-0.5" data-readonly-allow>
            <label className="flex items-center gap-1.5 text-xs text-zinc-600 dark:text-zinc-400">
              <span className="whitespace-nowrap" title="Dollars per peso. Total Pay PHP × this rate = PHP USD Conversion. Typed for this tab and week only.">
                PHP→USD rate
              </span>
              <input
                value={rateDraft ?? ctl.settings.rateText}
                disabled={!rateEditable}
                inputMode="decimal"
                placeholder="e.g. 0.0162575"
                onChange={(e) => {
                  setRateDraft(e.target.value);
                  setRateError(null);
                }}
                onBlur={commitRate}
                onKeyDown={(e) => {
                  if (e.key === 'Enter') {
                    e.preventDefault();
                    commitRate();
                  }
                  if (e.key === 'Escape') {
                    setRateDraft(null);
                    setRateError(null);
                  }
                }}
                aria-invalid={!!rateError}
                className={cn(
                  'h-8 w-32 rounded-lg border bg-white px-2 font-mono text-xs text-zinc-900 outline-none focus:ring-2 disabled:opacity-60 dark:bg-zinc-950 dark:text-zinc-100',
                  rateError
                    ? 'border-red-400 focus:ring-red-400/30'
                    : 'border-zinc-200 focus:border-sky-400 focus:ring-sky-400/30 dark:border-zinc-800',
                )}
              />
              {ctl.loadState === 'ready' && !ctl.settings.rateText && !rateError && (
                <span className="text-[11px] text-amber-700 dark:text-amber-300">none yet: USD stays blank</span>
              )}
            </label>
            {rateError && (
              <p className="max-w-md text-[11px] text-red-700 dark:text-red-300" role="alert">
                {rateError}
              </p>
            )}
          </div>
        )}
        {(ctl.loadState === 'ready' || ctl.loadState === 'loading') && week && (
          <LockControl
            key={`${sheet}:${week}`}
            locked={ctl.locked}
            canEdit={canEdit}
            blockedBy={lockBlockedBy}
            sheetLabel={NPD_SHEET_LABELS[sheet]}
            weekText={weekLabel(week)}
            rowCount={ctl.meta?.rowCount ?? 0}
            rateText={ctl.settings.rateText}
            lockedAt={ctl.meta?.lockedAt ?? null}
            lockedBy={ctl.meta?.lockedBy ?? null}
            onLock={onLock}
            onUnlock={onUnlock}
          />
        )}
      </div>

      {canEdit && (
        <NpdGoogleSheetSync
          sheet={sheet}
          stamp={ctl.syncStamp}
          saveFailed={ctl.saveState === 'error' || ctl.saveState === 'conflict' || ctl.saveState === 'locked'}
          targetOf={syncTargetOf}
          onApply={onSyncApply}
          disabled={switching}
        />
      )}

      {/* ── Messages ────────────────────────────────────────────────────── */}
      {ctl.loadState === 'missing' && (
        <Banner tone="amber" icon={<TriangleAlert className="h-4 w-4" />}>
          <p className="font-semibold">NPD is not set up yet.</p>
          <p>Its database tables have not been created, so there is nothing to show and nothing can be saved. An admin needs to run the NPD migration.</p>
        </Banner>
      )}
      {ctl.loadState === 'error' && (
        <Banner tone="red" icon={<CloudAlert className="h-4 w-4" />}>
          <p className="font-semibold">This sheet could not be loaded.</p>
          <p>{ctl.loadError} It is not empty — it simply could not be read. Nothing has been changed.</p>
          <button type="button" onClick={ctl.reload} className="mt-2 inline-flex items-center gap-1.5 rounded-md bg-red-600 px-2.5 py-1 text-xs font-semibold text-white hover:bg-red-700">
            <RefreshCw className="h-3.5 w-3.5" /> Try again
          </button>
        </Banner>
      )}
      {ctl.conflict && (
        <Banner tone="red" icon={<TriangleAlert className="h-4 w-4" />}>
          <p className="font-semibold">
            {ctl.conflict.updatedBy ?? 'Someone else'} saved this sheet
            {ctl.conflict.updatedAt ? ` at ${formatStamp(ctl.conflict.updatedAt)}` : ''} while you were editing.
          </p>
          <p>Your edits are still on screen and have not been saved. Choose which version this week keeps.</p>
          <div className="mt-2 flex flex-wrap gap-2">
            <button type="button" onClick={ctl.loadTheirs} className="rounded-md border border-red-300 bg-white px-2.5 py-1 text-xs font-semibold text-red-700 hover:bg-red-50 dark:border-red-800 dark:bg-zinc-950 dark:text-red-300">
              Load their version (drop mine)
            </button>
            <button type="button" onClick={ctl.keepMine} className="rounded-md bg-red-600 px-2.5 py-1 text-xs font-semibold text-white hover:bg-red-700">
              Keep mine (replace theirs)
            </button>
          </div>
        </Banner>
      )}
      {ctl.saveState === 'locked' && (
        <Banner tone="red" icon={<Lock className="h-4 w-4" />}>
          <p className="font-semibold">
            {ctl.meta?.lockedBy ?? 'Someone'} locked this sheet in while your edits were waiting to save.
          </p>
          <p>Your latest edits were NOT saved. They are still on screen; the locked values are what the sheet holds.</p>
          <button type="button" onClick={ctl.reload} className="mt-2 inline-flex items-center gap-1.5 rounded-md bg-red-600 px-2.5 py-1 text-xs font-semibold text-white hover:bg-red-700">
            <RefreshCw className="h-3.5 w-3.5" /> Show the locked sheet
          </button>
        </Banner>
      )}
      <LockedBar
        show={ctl.locked && ctl.saveState !== 'locked'}
        lockedBy={ctl.meta?.lockedBy ?? null}
        lockedAt={ctl.meta?.lockedAt ?? null}
      />
      {ctl.refreshing && ctl.refreshError && (
        <Banner tone="amber" icon={<CloudAlert className="h-4 w-4" />}>
          <p className="font-semibold">This sheet could not be refreshed.</p>
          <p>
            {ctl.refreshError} You are looking at the copy saved on this device
            {ctl.cachedAt ? ` at ${formatStamp(new Date(ctl.cachedAt).toISOString())}` : ''}. It stays read-only until the
            latest copy loads, so nothing is typed over an old one.
          </p>
          <button type="button" onClick={ctl.reload} className="mt-2 inline-flex items-center gap-1.5 rounded-md bg-amber-600 px-2.5 py-1 text-xs font-semibold text-white hover:bg-amber-700">
            <RefreshCw className="h-3.5 w-3.5" /> Try again
          </button>
        </Banner>
      )}
      {ctl.saveState === 'error' && (
        <Banner tone="red" icon={<CloudAlert className="h-4 w-4" />}>
          <p className="font-semibold">Your latest edits are not saved.</p>
          <p>{ctl.saveError} They are still on screen; the next edit tries again.</p>
          <button type="button" onClick={ctl.retrySave} className="mt-2 inline-flex items-center gap-1.5 rounded-md bg-red-600 px-2.5 py-1 text-xs font-semibold text-white hover:bg-red-700">
            <RefreshCw className="h-3.5 w-3.5" /> Retry now
          </button>
        </Banner>
      )}
      <p aria-live="polite" className={cn('min-h-4 text-xs text-zinc-600 dark:text-zinc-400', !notice && 'sr-only')}>
        {notice}
      </p>

      {/* ── The sheet ───────────────────────────────────────────────────── */}
      {/* Keyed by tab × week: a switch glides the new sheet in from the side it came from.
          The skeleton turning into the grid happens inside one key, so loading never re-animates. */}
      <motion.div
        key={`${sheet}:${week}`}
        className="flex min-h-0 flex-1 flex-col"
        initial={reduceMotion || switchDir === 0 ? false : { opacity: 0, x: switchDir * 14 }}
        animate={{ opacity: 1, x: 0 }}
        transition={{ duration: 0.24, ease: EASE_TAB }}
        data-testid="npd-sheet-area"
      >
      {ctl.loadState === 'ready' ? (
        <NpdSheetGrid
          key={`${sheet}:${week}`}
          sheet={sheet}
          ctx={ctx}
          onCellFormula={ctl.setCellFormula}
          onColumnFormula={ctl.setColumnFormula}
          onUseFormulaAgain={ctl.useFormulaAgain}
          columns={columns}
          rows={ctl.rows}
          readOnly={readOnly || !!ctl.conflict || ctl.locked || ctl.refreshing}
          readOnlyNotice={
            ctl.locked
              ? 'This sheet is locked in. Unlock it to make changes.'
              : ctl.refreshing
                ? 'Checking this is the latest copy. You can edit it as soon as it loads.'
                : undefined
          }
          canUndo={ctl.canUndo}
          canRedo={ctl.canRedo}
          onCommit={ctl.commit}
          onUndo={ctl.undo}
          onRedo={ctl.redo}
          onNotice={showNotice}
        />
      ) : ctl.loadState === 'loading' ? (
        <NpdSheetSkeleton key={sheet} sheet={sheet} columns={columns} />
      ) : null}
      </motion.div>
    </div>
  );
}

/**
 * The "Locked in by … · when" bar. Grows in and collapses (grid-rows 0fr ⇄ 1fr) rather
 * than jumping, and keeps its last text while it collapses. Reduced motion: no transition.
 *
 * The transition is an INLINE style on purpose: src/index.css's global, unlayered
 * `*, *::before, *::after { transition-property: background-color, color, … }` beats every
 * Tailwind `transition-*` utility (unlayered CSS outranks @layer utilities), so a class
 * here would silently do nothing. Its reduced-motion `transition: none !important` still wins.
 */
function LockedBar({ show, lockedBy, lockedAt }: { show: boolean; lockedBy: string | null; lockedAt: string | null }) {
  const last = useRef({ lockedBy, lockedAt });
  if (show) last.current = { lockedBy, lockedAt };
  const { lockedBy: by, lockedAt: at } = last.current;
  return (
    <div
      className={cn('grid', show ? 'grid-rows-[1fr] opacity-100' : '-mt-4 grid-rows-[0fr] opacity-0')}
      style={{
        transitionProperty: 'grid-template-rows, opacity, margin-top',
        transitionDuration: '320ms',
        transitionTimingFunction: 'cubic-bezier(0.22, 1, 0.36, 1)',
      }}
      aria-hidden={!show}
      data-testid="npd-locked-bar"
      data-show={show ? 'yes' : 'no'}
    >
      <div className="min-h-0 overflow-hidden">
        <div
          className="flex items-center gap-2 rounded-xl border border-indigo-200 bg-indigo-50 px-3.5 py-2.5 text-sm text-indigo-900 dark:border-indigo-900/60 dark:bg-indigo-950/30 dark:text-indigo-100"
          role={show ? 'status' : undefined}
        >
          <Lock className="h-4 w-4 shrink-0" />
          <p>
            Locked in{by ? <> by <span className="font-semibold">{by}</span></> : null}
            {at ? ` · ${formatStamp(at)}` : ''}. Every value on this sheet is read-only until it is unlocked.
          </p>
        </div>
      </div>
    </div>
  );
}

function SaveStatus({
  readOnly,
  cachedCopy,
  locked,
  loading,
  saveState,
  version,
  onRetry,
}: {
  readOnly: boolean;
  /** A cached copy is painted: its live read is on its way, or it failed. Never green: nothing was confirmed. */
  cachedCopy: 'refreshing' | 'failed' | null;
  locked: boolean;
  loading: boolean;
  saveState: ReturnType<typeof useNpdSheet>['saveState'];
  version: number;
  onRetry: () => void;
}) {
  // Each state is its own keyed element, so a change (Saving… → Saved → Locked in) fades in, not snaps.
  const base =
    'inline-flex items-center gap-1.5 rounded-full border px-2.5 py-1 text-xs font-medium animate-in fade-in-0 zoom-in-95 duration-200 motion-reduce:animate-none';
  if (readOnly) {
    return (
      <span key="view-only" className={cn(base, 'border-zinc-200 bg-zinc-50 text-zinc-600 dark:border-zinc-800 dark:bg-zinc-900 dark:text-zinc-400')}>
        <Eye className="h-3.5 w-3.5" /> View only
      </span>
    );
  }
  if (loading) {
    // Same size as the pill that follows, so the header never re-wraps when the sheet lands.
    return (
      <span key="loading" className={cn(base, 'border-zinc-200 bg-white text-zinc-500 dark:border-zinc-800 dark:bg-zinc-950 dark:text-zinc-400')} role="status">
        <LoaderCircle className="h-3.5 w-3.5 animate-spin motion-reduce:animate-none" /> Loading…
      </span>
    );
  }
  if (cachedCopy === 'refreshing') {
    return (
      <span key="refreshing" className={cn(base, 'border-zinc-200 bg-white text-zinc-600 dark:border-zinc-800 dark:bg-zinc-950 dark:text-zinc-300')} role="status">
        <LoaderCircle className="h-3.5 w-3.5 animate-spin motion-reduce:animate-none" /> Refreshing…
      </span>
    );
  }
  if (cachedCopy === 'failed') {
    return (
      <span key="not-refreshed" className={cn(base, 'border-amber-200 bg-amber-50 text-amber-800 dark:border-amber-900/60 dark:bg-amber-950/40 dark:text-amber-200')} role="status">
        <CloudAlert className="h-3.5 w-3.5" /> Not refreshed
      </span>
    );
  }
  if (locked && saveState !== 'locked') {
    return (
      <span key="locked" className={cn(base, 'border-indigo-200 bg-indigo-50 text-indigo-700 dark:border-indigo-900/60 dark:bg-indigo-950/40 dark:text-indigo-300')} role="status">
        <Lock className="h-3.5 w-3.5" /> Locked in
      </span>
    );
  }
  if (saveState === 'saving') {
    return (
      <span key="saving" className={cn(base, 'border-zinc-200 bg-white text-zinc-600 dark:border-zinc-800 dark:bg-zinc-950 dark:text-zinc-300')} role="status">
        <LoaderCircle className="h-3.5 w-3.5 animate-spin" /> Saving…
      </span>
    );
  }
  if (saveState === 'pending') {
    return (
      <span key="pending" className={cn(base, 'border-amber-200 bg-amber-50 text-amber-800 dark:border-amber-900/60 dark:bg-amber-950/40 dark:text-amber-200')} role="status">
        <span className="h-1.5 w-1.5 rounded-full bg-amber-500" aria-hidden /> Unsaved changes
      </span>
    );
  }
  if (saveState === 'error' || saveState === 'conflict' || saveState === 'locked') {
    return (
      <button key="not-saved" type="button" onClick={saveState === 'error' ? onRetry : undefined} className={cn(base, 'border-red-200 bg-red-50 text-red-700 dark:border-red-900/60 dark:bg-red-950/40 dark:text-red-300')} role="status">
        <CloudAlert className="h-3.5 w-3.5" /> Not saved
      </button>
    );
  }
  if (version === 0) {
    // Green means "the server confirmed a save". A week nobody has saved is not that.
    return (
      <span key="nothing-saved" className={cn(base, 'border-zinc-200 bg-zinc-50 text-zinc-600 dark:border-zinc-800 dark:bg-zinc-900 dark:text-zinc-400')} role="status">
        Nothing saved yet
      </span>
    );
  }
  return (
    <span key="saved" className={cn(base, 'border-emerald-200 bg-emerald-50 text-emerald-700 dark:border-emerald-900/60 dark:bg-emerald-950/40 dark:text-emerald-300')} role="status">
      <CircleCheck className="h-3.5 w-3.5" /> Saved
    </span>
  );
}

/**
 * Lock in / Unlock for the tab and week on screen. Each opens NpdLockDialog (the house
 * Dialog, never `window.confirm`; Kane, 2026-10-02: "add a modal that has a time stamp
 * on it"), which shows the timestamps. Unlock needs a written reason, which the route
 * records before it unlocks anything. The modal stays open on its done step after the
 * lock state flips underneath it.
 */
function LockControl({
  locked,
  canEdit,
  blockedBy,
  sheetLabel,
  weekText,
  rowCount,
  rateText,
  lockedAt,
  lockedBy,
  onLock,
  onUnlock,
}: {
  locked: boolean;
  canEdit: boolean;
  /** Why Lock in is unavailable right now, or null. */
  blockedBy: string | null;
  sheetLabel: string;
  weekText: string;
  rowCount: number;
  rateText: string;
  lockedAt: string | null;
  lockedBy: string | null;
  onLock: () => Promise<LockResult>;
  onUnlock: (reason: string) => Promise<LockResult>;
}) {
  const [dialog, setDialog] = useState<'lock' | 'unlock' | null>(null);
  const [lastMode, setLastMode] = useState<'lock' | 'unlock'>('lock');
  if (!canEdit) return null;
  const open = (mode: 'lock' | 'unlock') => {
    setLastMode(mode);
    setDialog(mode);
  };
  const btn =
    'inline-flex h-8 items-center gap-1.5 rounded-lg px-3 text-xs font-semibold transition-colors animate-in fade-in-0 zoom-in-95 duration-200 motion-reduce:animate-none disabled:cursor-not-allowed disabled:opacity-50';
  return (
    <div className="flex flex-wrap items-center gap-2 sm:ml-auto">
      {locked ? (
        <button
          key="unlock"
          type="button"
          onClick={() => open('unlock')}
          className={cn(btn, 'border border-zinc-200 bg-white text-zinc-700 enabled:hover:border-indigo-300 enabled:hover:text-indigo-700 dark:border-zinc-800 dark:bg-zinc-950 dark:text-zinc-300')}
        >
          <LockOpen className="h-3.5 w-3.5" /> Unlock…
        </button>
      ) : (
        <button
          key="lock"
          type="button"
          disabled={!!blockedBy}
          title={blockedBy ?? `Lock in ${sheetLabel} for ${weekText}`}
          onClick={() => open('lock')}
          className={cn(btn, 'border border-indigo-200 bg-indigo-50 text-indigo-700 enabled:hover:border-indigo-300 enabled:hover:bg-indigo-100 dark:border-indigo-900/60 dark:bg-indigo-950/40 dark:text-indigo-300')}
        >
          <Lock className="h-3.5 w-3.5" /> Lock in…
        </button>
      )}
      <NpdLockDialog
        mode={dialog ?? lastMode}
        open={dialog !== null}
        onOpenChange={(o) => {
          if (!o) setDialog(null);
        }}
        sheetLabel={sheetLabel}
        weekText={weekText}
        rowCount={rowCount}
        rateText={rateText}
        lockedAt={lockedAt}
        lockedBy={lockedBy}
        onLock={onLock}
        onUnlock={onUnlock}
      />
    </div>
  );
}

function Banner({ tone, icon, children }: { tone: 'red' | 'amber'; icon: ReactNode; children: ReactNode }) {
  return (
    <div
      role="alert"
      className={cn(
        'flex gap-2.5 rounded-xl border px-3.5 py-3 text-sm',
        tone === 'red'
          ? 'border-red-200 bg-red-50 text-red-800 dark:border-red-900/60 dark:bg-red-950/30 dark:text-red-200'
          : 'border-amber-200 bg-amber-50 text-amber-900 dark:border-amber-900/60 dark:bg-amber-950/30 dark:text-amber-100',
      )}
    >
      <span className="mt-0.5 shrink-0">{icon}</span>
      <div className="min-w-0 space-y-0.5">{children}</div>
    </div>
  );
}
