'use client';

import React, { useCallback, useEffect, useRef, useState } from 'react';
import { motion } from 'motion/react';
import {
  AlertTriangle,
  CheckCircle2,
  Clock,
  Coins,
  FileCheck2,
  FileSpreadsheet,
  Loader2,
  Send,
  Sparkles,
  Trash2,
  Users,
} from 'lucide-react';
import { toast } from 'sonner';
import { cn } from '@/lib/utils';
import { Button } from '@/components/ui/button';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { formatPHP, formatUSD } from '@/components/payroll-clerk/mock-queue';
import PayCycleReportDetail from '@/components/accounting/PayCycleReportDetail';
import type {
  CycleCompleteness,
  PayCycleReportSnapshot,
  PayCycleReportSummary,
} from '@/lib/accounting/pay-cycle-report-snapshot';

/**
 * Accounting → Documents → Reports.
 *
 * List view for published pay-cycle reports, plus the "payment cycle
 * complete" publish flow: a clerk confirms a finished cycle, which freezes
 * exactly who got paid into a permanent snapshot (Tasks 1–3). This file is
 * the client surface only — every mutation rides the Task 3 API routes.
 *
 * Visual and structural language is deliberately borrowed from the shipped
 * sibling tab, DispatchReports.tsx (Payment Dispatch → Reports): the
 * abort-controlled loader, the report-card grid, the mini-stat tiles, and the
 * arm-then-confirm button all follow that file's patterns rather than
 * reinventing them.
 */

// `pay-cycle-reports.ts` (the persistence module) is `server-only` —
// importing it here would break the client bundle. These two types are its
// public eligibility return shapes; re-declared verbatim rather than
// imported.
interface PublishableCycle {
  sourceFile: string;
  cycleId: string;
  label: string;
  periodStart: string | null;
  periodEnd: string | null;
  payeeCount: number;
  paidUSD: number;
  paidPHP: number;
}

interface IncompleteCycle {
  sourceFile: string;
  label: string;
  periodStart: string | null;
  periodEnd: string | null;
  paidCount: number;
  pendingCount: number;
  blockedCount: number;
  totalCount: number;
  paidPct: number;
}

/** Mirrors PAY_CYCLE_REPORT_PREFIX in pay-cycle-reports.ts (also server-only
 *  and therefore not imported). `unreadable` entries arrive as full
 *  app_settings keys, but the DELETE route takes a bare source_file — this
 *  recovers one from the other client-side. */
const PAY_CYCLE_REPORT_KEY_PREFIX = 'documents.pay_cycle_report.';

function sourceFileFromUnreadableKey(key: string): string {
  return key.startsWith(PAY_CYCLE_REPORT_KEY_PREFIX)
    ? key.slice(PAY_CYCLE_REPORT_KEY_PREFIX.length)
    : key;
}

function formatDateLong(iso: string | null): string {
  if (!iso) return '—';
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(iso);
  if (!m) return iso;
  const d = new Date(Date.UTC(+m[1], +m[2] - 1, +m[3]));
  return d.toLocaleDateString('en-US', {
    month: 'short',
    day: 'numeric',
    year: 'numeric',
    timeZone: 'UTC',
  });
}

function formatTimestamp(iso: string): string {
  try {
    const d = new Date(iso);
    return d.toLocaleString('en-US', {
      month: 'short',
      day: 'numeric',
      year: 'numeric',
      hour: 'numeric',
      minute: '2-digit',
    });
  } catch {
    return iso;
  }
}

export default function PayCycleReports({
  canEdit,
  onReadyCountChange,
}: {
  canEdit: boolean;
  onReadyCountChange?: (n: number) => void;
}): React.JSX.Element {
  const [published, setPublished] = useState<PayCycleReportSummary[]>([]);
  const [publishable, setPublishable] = useState<PublishableCycle[]>([]);
  const [incomplete, setIncomplete] = useState<IncompleteCycle | null>(null);
  const [unreadable, setUnreadable] = useState<string[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const [publishTarget, setPublishTarget] = useState<PublishableCycle | null>(null);
  const [publishing, setPublishing] = useState(false);
  const [publishError, setPublishError] = useState<string | null>(null);

  const [selected, setSelected] = useState<PayCycleReportSnapshot | null>(null);
  const [selectedLoading, setSelectedLoading] = useState(false);
  const [selectedError, setSelectedError] = useState<string | null>(null);

  const [unpublishing, setUnpublishing] = useState<string | null>(null);

  // Stashed in a ref so `load`'s identity (and therefore the mount effect
  // below) stays stable even if the parent re-creates its callback every
  // render — Task 7 wires this to a tab badge, and this component shouldn't
  // care how that prop is authored.
  const onReadyCountChangeRef = useRef(onReadyCountChange);
  useEffect(() => {
    onReadyCountChangeRef.current = onReadyCountChange;
  }, [onReadyCountChange]);

  const load = useCallback(async (signal?: AbortSignal) => {
    setLoading(true);
    setError(null);
    try {
      const res = await fetch('/api/accounting/pay-cycle-reports', {
        cache: 'no-store',
        signal,
      });
      const json = (await res.json()) as {
        published?: PayCycleReportSummary[];
        unreadable?: string[];
        publishable?: PublishableCycle[];
        incomplete?: IncompleteCycle | null;
        error?: string | null;
      };
      if (signal?.aborted) return;
      if (!res.ok) {
        // Hard failure — the persistence read itself failed, so the API sent
        // only `{ error }`. Nothing else in the payload can be trusted.
        setPublished([]);
        setUnreadable([]);
        setPublishable([]);
        setIncomplete(null);
        setError(json.error || `Request failed (${res.status})`);
        onReadyCountChangeRef.current?.(0);
        return;
      }
      // 200 — `error` here is the *eligibility* read's error only. `published`
      // can be populated even when it's set, so the lists are never discarded
      // just because eligibility failed to compute.
      const nextPublishable = json.publishable ?? [];
      setPublished(json.published ?? []);
      setUnreadable(json.unreadable ?? []);
      setPublishable(nextPublishable);
      setIncomplete(json.incomplete ?? null);
      setError(json.error ?? null);
      onReadyCountChangeRef.current?.(nextPublishable.length);
    } catch (e) {
      if (signal?.aborted) return;
      if (e instanceof DOMException && e.name === 'AbortError') return;
      // Network-level failure (fetch itself rejected, not an HTTP error
      // status) — mirror the `!res.ok` branch above: clear the lists and
      // zero the ready-count badge rather than leaving stale data (and a
      // stale badge) with no visible error.
      setPublished([]);
      setUnreadable([]);
      setPublishable([]);
      setIncomplete(null);
      setError(e instanceof Error ? e.message : 'Could not load reports');
      onReadyCountChangeRef.current?.(0);
    } finally {
      if (!signal?.aborted) setLoading(false);
    }
  }, []);

  useEffect(() => {
    const controller = new AbortController();
    void load(controller.signal);
    return () => controller.abort();
  }, [load]);

  const openReport = useCallback(async (sourceFile: string) => {
    setSelectedLoading(true);
    setSelectedError(null);
    setSelected(null);
    try {
      const res = await fetch(
        `/api/accounting/pay-cycle-reports/${encodeURIComponent(sourceFile)}`,
        { cache: 'no-store' },
      );
      const json = (await res.json()) as { report?: PayCycleReportSnapshot; error?: string | null };
      if (!res.ok || json.error || !json.report) {
        setSelectedError(json.error || 'Could not load report');
        return;
      }
      setSelected(json.report);
    } catch (e) {
      setSelectedError(e instanceof Error ? e.message : 'Could not load report');
    } finally {
      setSelectedLoading(false);
    }
  }, []);

  const publish = useCallback(async () => {
    if (!publishTarget) return;
    const { sourceFile, label } = publishTarget;
    setPublishing(true);
    setPublishError(null);
    try {
      const res = await fetch('/api/accounting/pay-cycle-reports', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ source_file: sourceFile }),
      });
      const json = (await res.json()) as {
        report?: PayCycleReportSnapshot | null;
        already?: boolean;
        error?: string | null;
        notComplete?: CycleCompleteness | null;
      };
      if (res.status === 409) {
        // The cycle regressed since the card was drawn — reload so it
        // re-renders in its not-ready state instead of staying stale.
        toast.error(
          json.error || 'This cycle is no longer fully paid — refresh and check Payment Dispatch.',
        );
        setPublishTarget(null);
        await load();
        return;
      }
      if (!res.ok || json.error) {
        setPublishError(json.error || 'Could not publish this report');
        return;
      }
      if (json.already) {
        toast.success('Report already published');
        setPublishTarget(null);
        await load();
        return;
      }
      toast.success(`${label} published`, {
        description: 'The frozen report is ready in Reports.',
      });
      setPublishTarget(null);
      await load();
      await openReport(sourceFile);
    } catch (e) {
      setPublishError(e instanceof Error ? e.message : 'Could not publish this report');
    } finally {
      setPublishing(false);
    }
  }, [publishTarget, load, openReport]);

  const unpublish = useCallback(async (sourceFile: string) => {
    setUnpublishing(sourceFile);
    try {
      const res = await fetch(
        `/api/accounting/pay-cycle-reports/${encodeURIComponent(sourceFile)}`,
        { method: 'DELETE' },
      );
      const json = (await res.json()) as { deleted?: boolean; error?: string | null };
      if (!res.ok || json.error) {
        toast.error(json.error || 'Could not unpublish this report');
        return;
      }
      setSelected(null);
      await load();
    } catch (e) {
      toast.error(e instanceof Error ? e.message : 'Could not unpublish this report');
    } finally {
      setUnpublishing(null);
    }
  }, [load]);

  // ── Detail in-place swap — mirrors DispatchReports.tsx:315. ────────────────
  if (selected || selectedLoading || selectedError) {
    return (
      <PayCycleReportDetail
        report={selected}
        loading={selectedLoading}
        error={selectedError}
        canEdit={canEdit}
        onBack={() => {
          setSelected(null);
          setSelectedError(null);
        }}
        onUnpublish={unpublish}
      />
    );
  }

  const hasAnyData =
    published.length > 0 || unreadable.length > 0 || publishable.length > 0 || incomplete !== null;

  return (
    <div className="flex h-full min-h-0 flex-col">
      <div className="shrink-0 border-b border-orange-100/80 bg-white px-4 py-3 sm:px-6 sm:py-4 dark:border-orange-950/40 dark:bg-[#0d1117]">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <div>
            <h1 className="flex items-center gap-2 text-base font-semibold tracking-tight text-zinc-900 sm:text-xl dark:text-white">
              <FileCheck2 className="h-5 w-5 text-orange-600 dark:text-orange-400" />
              Reports
            </h1>
            <p className="mt-0.5 text-xs text-zinc-500 dark:text-zinc-500">
              Frozen, published records of who got paid each completed cycle.
            </p>
          </div>
          <div className="hidden items-center gap-1.5 rounded-full border border-orange-200/80 bg-white/70 px-2.5 py-1 text-[10px] font-semibold uppercase tracking-[0.14em] text-orange-700 backdrop-blur-md dark:border-orange-900/40 dark:bg-orange-950/30 dark:text-orange-300 sm:inline-flex">
            <Sparkles className="h-3 w-3" />
            {published.length} published
          </div>
        </div>
      </div>

      <div className="min-h-0 flex-1 overflow-y-auto bg-[#fafaf8] px-3 py-4 sm:px-6 sm:py-6 dark:bg-[#0d1117]">
        {loading ? (
          <ReportsSkeleton />
        ) : error && !hasAnyData ? (
          <FullPageError message={error} />
        ) : (
          <>
            <PublishCard
              publishable={publishable}
              incomplete={incomplete}
              error={error}
              canEdit={canEdit}
              onPublishClick={(cycle) => {
                setPublishTarget(cycle);
                setPublishError(null);
              }}
            />

            {unreadable.length > 0 && (
              <UnreadableStrip
                unreadableKeys={unreadable}
                canEdit={canEdit}
                unpublishing={unpublishing}
                onUnpublish={(sourceFile) => void unpublish(sourceFile)}
              />
            )}

            {published.length === 0 ? (
              <EmptyReportsState />
            ) : (
              <ul className="grid gap-3 sm:grid-cols-2 xl:grid-cols-3">
                {published.map((r) => (
                  <ReportCard
                    key={r.source_file}
                    report={r}
                    onOpen={() => void openReport(r.source_file)}
                  />
                ))}
              </ul>
            )}
          </>
        )}
      </div>

      {/* ── Publish confirmation ─────────────────────────────────────────── */}
      <Dialog
        open={!!publishTarget}
        onOpenChange={(o) => {
          // While publishing, the clerk is committed — the POST is already in
          // flight server-side and the report either exists or it doesn't.
          // Block Escape/backdrop-click/X uniformly through this one prop so
          // the dialog can't vanish out from under an in-flight request.
          if (publishing) return;
          if (!o) setPublishTarget(null);
        }}
      >
        <DialogContent className="sm:max-w-md">
          <DialogHeader>
            <DialogTitle>Has this payment cycle been completed?</DialogTitle>
            <DialogDescription>
              This freezes the cycle exactly as it stands now and posts it to Reports.
              Later undos or re-marks won&rsquo;t change the published report.
            </DialogDescription>
          </DialogHeader>
          {publishTarget && (
            <div className="rounded-xl border border-zinc-200 bg-zinc-50/70 px-4 py-3 text-[12.5px] leading-relaxed dark:border-zinc-800 dark:bg-zinc-900/40">
              <div className="font-medium text-zinc-800 dark:text-zinc-200">{publishTarget.label}</div>
              <div className="mt-0.5 text-zinc-500 dark:text-zinc-400">
                {publishTarget.payeeCount} payee{publishTarget.payeeCount === 1 ? '' : 's'} ·{' '}
                {formatUSD(publishTarget.paidUSD)} · {formatPHP(publishTarget.paidPHP)}
              </div>
            </div>
          )}
          {publishError && (
            <div className="rounded-xl border border-rose-200 bg-rose-50/80 px-3 py-2 text-xs text-rose-700 dark:border-rose-500/30 dark:bg-rose-950/30 dark:text-rose-300">
              {publishError}
            </div>
          )}
          <DialogFooter>
            <Button
              type="button"
              variant="outline"
              disabled={publishing}
              onClick={() => setPublishTarget(null)}
            >
              Cancel
            </Button>
            <Button
              type="button"
              onClick={() => void publish()}
              disabled={publishing}
              className="gap-1.5 bg-gradient-to-r from-orange-500 to-rose-500 text-white"
            >
              {publishing ? (
                <Loader2 className="h-3.5 w-3.5 animate-spin" />
              ) : (
                <CheckCircle2 className="h-3.5 w-3.5" />
              )}
              Yes — publish report
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}

// ─── Publish card (three states) + "also unpublished" list ──────────────────

function PublishCard({
  publishable,
  incomplete,
  error,
  canEdit,
  onPublishClick,
}: {
  publishable: PublishableCycle[];
  incomplete: IncompleteCycle | null;
  error: string | null;
  canEdit: boolean;
  onPublishClick: (cycle: PublishableCycle) => void;
}) {
  const primary = publishable[0] ?? null;
  const rest = publishable.slice(1);

  return (
    <div className="mb-4 space-y-3">
      {primary ? (
        <div className="relative rounded-2xl border border-amber-300 bg-white p-4 ring-2 ring-amber-200/60 sm:p-5 dark:border-amber-500/40 dark:bg-zinc-950 dark:ring-amber-500/20">
          <motion.div
            aria-hidden
            className="pointer-events-none absolute inset-0 rounded-2xl ring-2 ring-amber-300/80 dark:ring-amber-400/40"
            animate={{ opacity: [0.35, 0.9, 0.35] }}
            transition={{ duration: 2.6, repeat: Infinity, ease: 'easeInOut' }}
          />
          <div className="relative flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
            <div className="min-w-0">
              <span className="inline-flex items-center gap-1 rounded-full border border-emerald-200 bg-emerald-50 px-2 py-0.5 text-[10px] font-semibold uppercase tracking-wide text-emerald-700 dark:border-emerald-500/30 dark:bg-emerald-500/10 dark:text-emerald-300">
                <CheckCircle2 className="h-3 w-3" />
                100% paid
              </span>
              <h2 className="mt-1.5 truncate text-base font-semibold tracking-tight text-zinc-900 dark:text-white">
                {primary.label}
              </h2>
              <p className="mt-0.5 text-xs text-zinc-500 dark:text-zinc-400">
                {primary.payeeCount} payee{primary.payeeCount === 1 ? '' : 's'} ·{' '}
                {formatUSD(primary.paidUSD)} · {formatPHP(primary.paidPHP)}
              </p>
            </div>
            <Button
              type="button"
              onClick={() => onPublishClick(primary)}
              disabled={!canEdit}
              title={!canEdit ? 'You have view-only access' : undefined}
              className="h-10 shrink-0 gap-2 bg-gradient-to-r from-orange-500 to-rose-500 px-4 text-sm font-semibold text-white shadow-md shadow-orange-500/20 hover:brightness-105"
            >
              <CheckCircle2 className="h-4 w-4" />
              Payment cycle complete
            </Button>
          </div>
        </div>
      ) : incomplete ? (
        <div className="rounded-2xl border border-zinc-200 bg-white p-4 sm:p-5 dark:border-zinc-800 dark:bg-zinc-950">
          <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
            <div className="min-w-0 opacity-70">
              <h2 className="truncate text-sm font-semibold text-zinc-700 dark:text-zinc-300">
                {incomplete.label}
              </h2>
              <p className="mt-0.5 text-xs text-zinc-500 dark:text-zinc-500">
                {incomplete.paidPct}% paid
                {' · '}
                {[
                  incomplete.pendingCount > 0 ? `${incomplete.pendingCount} still pending` : null,
                  incomplete.blockedCount > 0 ? `${incomplete.blockedCount} blocked` : null,
                ]
                  .filter(Boolean)
                  .join(' · ')}
              </p>
              <p className="mt-1 text-[11px] italic text-zinc-400 dark:text-zinc-600">
                Finish the queue in Payment Dispatch first.
              </p>
            </div>
            <Button
              type="button"
              disabled
              className="h-10 shrink-0 gap-2 bg-zinc-200 px-4 text-sm font-semibold text-zinc-500 dark:bg-zinc-800 dark:text-zinc-500"
            >
              <CheckCircle2 className="h-4 w-4" />
              Payment cycle complete
            </Button>
          </div>
        </div>
      ) : error ? (
        <div className="flex items-start gap-3 rounded-2xl border border-rose-200 bg-rose-50/60 p-4 sm:p-5 dark:border-rose-500/25 dark:bg-rose-500/5">
          <AlertTriangle className="mt-0.5 h-5 w-5 shrink-0 text-rose-500" />
          <div>
            <h2 className="text-sm font-semibold text-rose-800 dark:text-rose-300">
              Couldn&apos;t check what&apos;s publishable
            </h2>
            <p className="mt-0.5 text-xs text-rose-700/80 dark:text-rose-400/80">{error}</p>
          </div>
        </div>
      ) : (
        <div className="flex items-center gap-3 rounded-2xl border border-dashed border-emerald-300 bg-emerald-50/40 p-4 sm:p-5 dark:border-emerald-500/30 dark:bg-emerald-500/5">
          <CheckCircle2 className="h-5 w-5 shrink-0 text-emerald-500" />
          <p className="text-sm font-medium text-emerald-800 dark:text-emerald-300">
            Every completed cycle has been reported.
          </p>
        </div>
      )}

      {rest.length > 0 && (
        <div className="overflow-hidden rounded-xl border border-zinc-200 bg-white dark:border-zinc-800 dark:bg-zinc-950">
          <div className="border-b border-zinc-100 px-3 py-1.5 text-[10px] font-semibold uppercase tracking-wide text-zinc-400 dark:border-zinc-800 dark:text-zinc-500">
            Also unpublished
          </div>
          <ul className="divide-y divide-zinc-100 dark:divide-zinc-800">
            {rest.map((c) => (
              <li key={c.sourceFile} className="flex items-center justify-between gap-2 px-3 py-2">
                <div className="min-w-0">
                  <div className="truncate text-xs font-medium text-zinc-800 dark:text-zinc-200">
                    {c.label}
                  </div>
                  <div className="text-[10.5px] text-zinc-400 dark:text-zinc-500">
                    {formatDateLong(c.periodStart)} → {formatDateLong(c.periodEnd)} · 100% paid
                  </div>
                </div>
                <Button
                  type="button"
                  size="sm"
                  variant="outline"
                  disabled={!canEdit}
                  title={!canEdit ? 'You have view-only access' : undefined}
                  onClick={() => onPublishClick(c)}
                  className="h-7 shrink-0 gap-1 text-[11px]"
                >
                  <FileCheck2 className="h-3 w-3" />
                  Publish
                </Button>
              </li>
            ))}
          </ul>
        </div>
      )}
    </div>
  );
}

// ─── Unreadable strip — corrupt app_settings rows, recoverable via unpublish ─

function UnreadableStrip({
  unreadableKeys,
  canEdit,
  unpublishing,
  onUnpublish,
}: {
  unreadableKeys: string[];
  canEdit: boolean;
  unpublishing: string | null;
  onUnpublish: (sourceFile: string) => void;
}) {
  return (
    <div className="mb-4 overflow-hidden rounded-2xl border border-amber-200 bg-amber-50/70 dark:border-amber-500/20 dark:bg-amber-500/5">
      <div className="flex items-start gap-2 px-4 py-3">
        <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0 text-amber-600 dark:text-amber-400" />
        <p className="text-[12px] font-semibold text-amber-800 dark:text-amber-300">
          {unreadableKeys.length} stored report{unreadableKeys.length === 1 ? '' : 's'} could not be read
        </p>
      </div>
      <ul className="divide-y divide-amber-200/60 dark:divide-amber-500/10">
        {unreadableKeys.map((key) => {
          const sourceFile = sourceFileFromUnreadableKey(key);
          return (
            <li key={key} className="flex items-center justify-between gap-2 px-4 py-2">
              <span className="truncate font-mono text-[11px] text-amber-700 dark:text-amber-400">
                {sourceFile}
              </span>
              {canEdit && (
                <UnpublishButton
                  busy={unpublishing === sourceFile}
                  onConfirm={() => onUnpublish(sourceFile)}
                />
              )}
            </li>
          );
        })}
      </ul>
    </div>
  );
}

/** Arm-then-confirm, the same two-step shape as handleMarkAllPaid /
 *  markPaidConfirm in DispatchReports.tsx:994 — first click arms (label
 *  flips, an inline Cancel appears), second click actually sends. */
function UnpublishButton({ busy, onConfirm }: { busy: boolean; onConfirm: () => void }) {
  const [armed, setArmed] = useState(false);
  return (
    <div className="flex shrink-0 items-center gap-1.5">
      <Button
        type="button"
        variant="outline"
        size="sm"
        disabled={busy}
        onClick={() => {
          if (!armed) {
            setArmed(true);
            return;
          }
          onConfirm();
        }}
        className={cn(
          'h-7 gap-1 text-[11px]',
          armed
            ? 'border-rose-300 bg-rose-50 text-rose-700 hover:bg-rose-100 dark:border-rose-500/40 dark:bg-rose-950/30 dark:text-rose-300'
            : 'border-amber-300 bg-white text-amber-800 hover:bg-amber-100 dark:border-amber-500/40 dark:bg-transparent dark:text-amber-300 dark:hover:bg-amber-500/10',
        )}
      >
        {busy ? <Loader2 className="h-3 w-3 animate-spin" /> : <Trash2 className="h-3 w-3" />}
        {armed ? 'Confirm' : 'Unpublish'}
      </Button>
      {armed && !busy && (
        <button
          type="button"
          onClick={() => setArmed(false)}
          className="text-[10px] text-zinc-400 hover:text-zinc-600 dark:hover:text-zinc-300"
        >
          Cancel
        </button>
      )}
    </div>
  );
}

// ─── Published-report grid ────────────────────────────────────────────────────

function ReportCard({ report, onOpen }: { report: PayCycleReportSummary; onOpen: () => void }) {
  const { totals } = report;
  return (
    <li>
      <button
        type="button"
        onClick={onOpen}
        className="group flex h-full w-full flex-col gap-3 rounded-2xl border border-orange-100/80 bg-white p-4 text-left shadow-[0_4px_16px_-8px_rgba(0,0,0,0.08)] transition-shadow hover:shadow-[0_10px_28px_-12px_rgba(255,138,76,0.25)] dark:border-orange-950/40 dark:bg-zinc-950"
      >
        <div className="flex items-start gap-3">
          <div className="flex h-10 w-10 shrink-0 items-center justify-center rounded-xl bg-gradient-to-br from-orange-500 to-rose-500 text-white shadow-md">
            <FileCheck2 className="h-5 w-5" />
          </div>
          <div className="min-w-0 flex-1">
            <div className="truncate text-sm font-semibold tracking-tight text-zinc-900 dark:text-white">
              {report.label}
            </div>
            <div className="mt-0.5 flex items-center gap-1 text-[11px] text-zinc-500 dark:text-zinc-500">
              <Clock className="h-3 w-3 shrink-0" />
              <span className="truncate">
                Published {formatTimestamp(report.published_at)} by {report.published_by}
              </span>
            </div>
          </div>
        </div>

        <div className="grid grid-cols-3 gap-2">
          <MiniStat
            label="Payees"
            value={totals.payeeCount.toLocaleString('en-US')}
            tone="violet"
            Icon={Users}
          />
          <MiniStat
            label="Payments"
            value={totals.dispatchCount.toLocaleString('en-US')}
            tone="amber"
            Icon={Send}
          />
          <MiniStat label="Total paid" value={formatUSD(totals.paidUSD)} tone="emerald" Icon={Coins} />
        </div>

        <div className="mt-auto flex items-center justify-between rounded-xl border border-orange-100/70 bg-[#fafaf8] px-3 py-2 dark:border-orange-950/30 dark:bg-zinc-900/50">
          <span className="font-mono text-[11px] text-zinc-500 dark:text-zinc-400">
            {formatPHP(totals.paidPHP)}
          </span>
          <div className="flex items-center gap-1 text-[11px] font-medium text-orange-600 transition-transform group-hover:translate-x-1 dark:text-orange-400">
            View report
            <span aria-hidden>→</span>
          </div>
        </div>
      </button>
    </li>
  );
}

function MiniStat({
  label,
  value,
  tone,
  Icon,
}: {
  label: string;
  value: string;
  tone: 'emerald' | 'violet' | 'amber';
  Icon: React.ComponentType<{ className?: string }>;
}) {
  const palette = {
    emerald: 'text-emerald-700 bg-emerald-50 dark:text-emerald-300 dark:bg-emerald-500/10',
    violet: 'text-violet-700 bg-violet-50 dark:text-violet-300 dark:bg-violet-500/10',
    amber: 'text-amber-700 bg-amber-50 dark:text-amber-300 dark:bg-amber-500/10',
  }[tone];
  return (
    <div className={cn('flex items-center gap-2 rounded-lg px-2 py-1.5', palette)}>
      <Icon className="h-3.5 w-3.5 shrink-0" />
      <div className="min-w-0 leading-tight">
        <div className="text-[9px] font-semibold uppercase tracking-[0.1em] opacity-70">{label}</div>
        <div className="truncate text-sm font-bold tabular-nums">{value}</div>
      </div>
    </div>
  );
}

function EmptyReportsState() {
  return (
    <div className="flex flex-col items-center gap-2 rounded-2xl border border-dashed border-orange-200 bg-white py-16 text-center dark:border-orange-950/40 dark:bg-[#0d1117]">
      <FileSpreadsheet className="h-7 w-7 text-orange-300 dark:text-orange-800" />
      <p className="text-sm text-zinc-500 dark:text-zinc-500">No pay cycle reports published yet.</p>
    </div>
  );
}

function ReportsSkeleton() {
  return (
    <div className="space-y-4">
      <div className="h-28 animate-pulse rounded-2xl border border-orange-100/70 bg-white dark:border-orange-950/30 dark:bg-zinc-950" />
      <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-3">
        {[0, 1, 2].map((i) => (
          <div
            key={i}
            className="h-40 animate-pulse rounded-2xl border border-orange-100/70 bg-white dark:border-orange-950/30 dark:bg-zinc-950"
          />
        ))}
      </div>
    </div>
  );
}

function FullPageError({ message }: { message: string }) {
  return (
    <div className="flex h-full flex-col items-center justify-center gap-3 px-6 py-16 text-center">
      <div className="flex h-12 w-12 items-center justify-center rounded-2xl bg-gradient-to-br from-red-500 to-rose-600 text-white shadow-lg shadow-rose-500/30">
        <AlertTriangle className="h-6 w-6" />
      </div>
      <h2 className="text-base font-semibold text-zinc-900 dark:text-white">Couldn&apos;t load reports</h2>
      <p className="max-w-md text-xs text-zinc-500 dark:text-zinc-400">{message}</p>
    </div>
  );
}
