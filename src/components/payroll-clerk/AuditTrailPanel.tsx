'use client';

/**
 * AuditTrailPanel — drop-in section that renders the audit timeline for a
 * single payroll cycle.
 *
 * Accepts EITHER a `cycleId` (when invoked from a disbursement report where a
 * cycle_id already exists) OR a `sourceFile` (when invoked from the Payroll
 * Wizard, which only knows the active Hubstaff filename). The component picks
 * the matching API route and renders the same UI.
 */

import React, { useEffect, useMemo, useState } from 'react';
import {
  CheckCircle2,
  ChevronLeft,
  ChevronRight,
  Coins,
  FileText,
  History,
  Loader2,
  Search,
  User as UserIcon,
  X,
} from 'lucide-react';
import { cn } from '@/lib/utils';
import { Button } from '@/components/ui/button';

export type AuditEvent = {
  id: string;
  created_at: string;
  user_name: string;
  user_role: string;
  action: string;
  resource: string;
  resource_id: string | null;
  details: Record<string, unknown> | null;
  ip_address: string | null;
  matched_via: 'cycle_context' | 'time_window';
};

export type AuditBundle = {
  cycleId: string | null;
  sourceFile: string | null;
  periodStart: string | null;
  periodEnd: string | null;
  reportName: string;
  events: AuditEvent[];
};

const AUDIT_PAGE_SIZE = 12;

const ACTION_PRESENTATION: Record<string, { label: string; tone: string }> = {
  'wizard.opened':            { label: 'Wizard opened',      tone: 'bg-sky-50 text-sky-700 border-sky-200 dark:bg-sky-500/10 dark:text-sky-300 dark:border-sky-500/30' },
  'wizard.cycle_selected':    { label: 'Cycle selected',     tone: 'bg-sky-50 text-sky-700 border-sky-200 dark:bg-sky-500/10 dark:text-sky-300 dark:border-sky-500/30' },
  'wizard.edited':            { label: 'Wizard edit',        tone: 'bg-violet-50 text-violet-700 border-violet-200 dark:bg-violet-500/10 dark:text-violet-300 dark:border-violet-500/30' },
  'wizard.bonus_edited':      { label: 'Bonus edited',       tone: 'bg-violet-50 text-violet-700 border-violet-200 dark:bg-violet-500/10 dark:text-violet-300 dark:border-violet-500/30' },
  'wizard.addition_edited':   { label: 'Addition edited',    tone: 'bg-violet-50 text-violet-700 border-violet-200 dark:bg-violet-500/10 dark:text-violet-300 dark:border-violet-500/30' },
  'wizard.fx_rate_changed':   { label: 'FX rate changed',    tone: 'bg-amber-50 text-amber-700 border-amber-200 dark:bg-amber-500/10 dark:text-amber-300 dark:border-amber-500/30' },
  'contractor.decided':       { label: 'Contractor decision',tone: 'bg-fuchsia-50 text-fuchsia-700 border-fuchsia-200 dark:bg-fuchsia-500/10 dark:text-fuchsia-300 dark:border-fuchsia-500/30' },
  'orphanage.budget_decided': { label: 'Orphanage decision', tone: 'bg-teal-50 text-teal-700 border-teal-200 dark:bg-teal-500/10 dark:text-teal-300 dark:border-teal-500/30' },
  'orphanage_budget.approved':{ label: 'Orphanage approved', tone: 'bg-emerald-50 text-emerald-700 border-emerald-200 dark:bg-emerald-500/10 dark:text-emerald-300 dark:border-emerald-500/30' },
  'orphanage_budget.rejected':{ label: 'Orphanage rejected', tone: 'bg-rose-50 text-rose-700 border-rose-200 dark:bg-rose-500/10 dark:text-rose-300 dark:border-rose-500/30' },
  'orphanage.dispatched':     { label: 'Orphanage paid',     tone: 'bg-teal-50 text-teal-700 border-teal-200 dark:bg-teal-500/10 dark:text-teal-300 dark:border-teal-500/30' },
  'tenure.gift_decided':      { label: 'Tenure gift',        tone: 'bg-pink-50 text-pink-700 border-pink-200 dark:bg-pink-500/10 dark:text-pink-300 dark:border-pink-500/30' },
  'gift.payment_edited':      { label: 'Gift payment edit',  tone: 'bg-pink-50 text-pink-700 border-pink-200 dark:bg-pink-500/10 dark:text-pink-300 dark:border-pink-500/30' },
  'dispatch.lock_acquired':   { label: 'Start Processing',   tone: 'bg-orange-50 text-orange-700 border-orange-200 dark:bg-orange-500/10 dark:text-orange-300 dark:border-orange-500/30' },
  'dispatch.lock_released':   { label: 'Stop Processing',    tone: 'bg-orange-50 text-orange-700 border-orange-200 dark:bg-orange-500/10 dark:text-orange-300 dark:border-orange-500/30' },
  'payment.dispatched':       { label: 'Payment dispatched', tone: 'bg-emerald-50 text-emerald-700 border-emerald-200 dark:bg-emerald-500/10 dark:text-emerald-300 dark:border-emerald-500/30' },
  'paystubs.dispatched':      { label: 'Paystubs dispatched',tone: 'bg-emerald-50 text-emerald-700 border-emerald-200 dark:bg-emerald-500/10 dark:text-emerald-300 dark:border-emerald-500/30' },
};

function ActionBadge({ action }: { action: string }) {
  const meta = ACTION_PRESENTATION[action] ?? {
    label: action,
    tone: 'bg-zinc-50 text-zinc-700 border-zinc-200 dark:bg-zinc-800 dark:text-zinc-300 dark:border-zinc-700',
  };
  return (
    <span className={cn('inline-flex items-center gap-1 rounded-full border px-1.5 py-0.5 text-[10px] font-semibold uppercase tracking-wide', meta.tone)}>
      {meta.label}
    </span>
  );
}

function formatAuditTimestamp(iso: string): string {
  try {
    const d = new Date(iso);
    return d.toLocaleString('en-US', {
      month: 'short',
      day: 'numeric',
      year: 'numeric',
      hour: 'numeric',
      minute: '2-digit',
      second: '2-digit',
    });
  } catch {
    return iso;
  }
}

function describeEventTarget(ev: AuditEvent): string {
  const d = ev.details ?? {};
  const employee =
    (d.employee_email as string | undefined) ??
    (d.recipient_email as string | undefined) ??
    (d.submitter_email as string | undefined) ??
    (d.contractor_email as string | undefined) ??
    null;
  if (employee) return employee;
  const label = (d.label as string | undefined) ?? (d.field as string | undefined);
  if (label) return label;
  return ev.resource_id ?? ev.resource;
}

function describeEventValue(ev: AuditEvent): string {
  const d = ev.details ?? {};
  const prev = d.previous_status ?? d.previous_value ?? d.old_value;
  const next = d.new_status ?? d.new_value ?? d.status;
  if (prev != null && next != null && String(prev) !== String(next)) {
    return `${prev} -> ${next}`;
  }
  if (next != null) return String(next);
  if (d.amount_usd != null) {
    return `USD ${Number(d.amount_usd).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
  }
  if (d.final_amount != null) {
    return `PHP ${Number(d.final_amount).toLocaleString('en-PH', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
  }
  const cycle = d.cycle as { fx_rate?: number | null } | undefined;
  if (cycle?.fx_rate != null) {
    return `FX ${Number(cycle.fx_rate).toFixed(4)} PHP/USD`;
  }
  if (typeof d.success === 'boolean') {
    return d.success ? 'success' : 'failed';
  }
  return '';
}

export type AuditTrailPanelProps = {
  /** Provide one of cycleId OR sourceFile. */
  cycleId?: string | null;
  sourceFile?: string | null;
  periodStart?: string | null;
  periodEnd?: string | null;
  /** When true, render an "Export Audit Trail" button in the header. */
  showExportButton?: boolean;
  /** Optional className override for the section wrapper. */
  className?: string;
};

export default function AuditTrailPanel({
  cycleId,
  sourceFile,
  periodStart,
  periodEnd,
  showExportButton = false,
  className,
}: AuditTrailPanelProps) {
  const [bundle, setBundle] = useState<AuditBundle | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [query, setQuery] = useState('');
  const [actionFilter, setActionFilter] = useState<string>('all');
  const [page, setPage] = useState(0);
  const [expandedId, setExpandedId] = useState<string | null>(null);

  // Build the fetch + export URLs from whichever identifier was provided.
  const { fetchUrl, exportUrl } = useMemo(() => {
    if (cycleId) {
      return {
        fetchUrl: `/api/payment-dispatches/reports/${encodeURIComponent(cycleId)}/audit`,
        exportUrl: `/api/payment-dispatches/reports/${encodeURIComponent(cycleId)}/audit/export`,
      };
    }
    if (sourceFile) {
      const params = new URLSearchParams({ source_file: sourceFile });
      if (periodStart) params.set('period_start', periodStart);
      if (periodEnd) params.set('period_end', periodEnd);
      const qs = params.toString();
      return {
        fetchUrl: `/api/payroll-wizard/audit?${qs}`,
        exportUrl: `/api/payroll-wizard/audit/export?${qs}`,
      };
    }
    return { fetchUrl: null, exportUrl: null };
  }, [cycleId, sourceFile, periodStart, periodEnd]);

  useEffect(() => {
    if (!fetchUrl) {
      setBundle(null);
      setLoading(false);
      setError('No cycle context');
      return;
    }
    let cancelled = false;
    setLoading(true);
    setError(null);
    fetch(fetchUrl, { cache: 'no-store' })
      .then(async (res) => {
        const json = (await res.json()) as { bundle?: AuditBundle; error?: string | null };
        if (cancelled) return;
        if (json.error || !json.bundle) {
          setError(json.error ?? 'Could not load audit trail');
          setBundle(null);
        } else {
          setBundle(json.bundle);
          setPage(0);
        }
      })
      .catch((e) => {
        if (cancelled) return;
        setError(e instanceof Error ? e.message : 'Could not load audit trail');
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [fetchUrl]);

  const events = bundle?.events ?? [];
  const actionOptions = useMemo(() => {
    const set = new Set(events.map((e) => e.action));
    return Array.from(set).sort();
  }, [events]);

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    return events.filter((ev) => {
      if (actionFilter !== 'all' && ev.action !== actionFilter) return false;
      if (!q) return true;
      const haystack = [
        ev.user_name,
        ev.action,
        ev.resource,
        ev.resource_id ?? '',
        describeEventTarget(ev),
        describeEventValue(ev),
        JSON.stringify(ev.details ?? {}),
      ]
        .join(' ')
        .toLowerCase();
      return haystack.includes(q);
    });
  }, [events, query, actionFilter]);

  const pageCount = Math.max(1, Math.ceil(filtered.length / AUDIT_PAGE_SIZE));
  const safePage = Math.min(page, pageCount - 1);
  const start = safePage * AUDIT_PAGE_SIZE;
  const visible = filtered.slice(start, start + AUDIT_PAGE_SIZE);

  const fxSnapshot = useMemo(() => {
    for (let i = events.length - 1; i >= 0; i--) {
      const d = events[i].details ?? {};
      const cycle = d.cycle as { fx_rate?: number | null } | undefined;
      if (cycle?.fx_rate != null) return Number(cycle.fx_rate);
      const direct = d.fx_rate as number | undefined;
      if (direct != null) return Number(direct);
    }
    return null;
  }, [events]);

  const startedEvent = useMemo(
    () => events.find((e) => e.action === 'wizard.opened') ?? null,
    [events],
  );

  const handleExport = () => {
    if (exportUrl) window.location.href = exportUrl;
  };

  return (
    <section
      className={cn(
        'rounded-2xl border border-indigo-200/70 bg-gradient-to-br from-indigo-50/40 to-white dark:border-indigo-500/20 dark:from-indigo-500/5 dark:to-zinc-950',
        className,
      )}
    >
      <div className="flex flex-wrap items-center justify-between gap-2 border-b border-indigo-100/80 px-4 py-2.5 dark:border-indigo-500/10">
        <div className="flex items-center gap-2">
          <h2 className="inline-flex items-center gap-1.5 text-[11px] font-semibold uppercase tracking-[0.14em] text-indigo-800 dark:text-indigo-300">
            <History className="h-3.5 w-3.5" />
            Audit Trail
          </h2>
          {loading && <Loader2 className="h-3.5 w-3.5 animate-spin text-indigo-500" />}
        </div>
        <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-[10px] tabular-nums text-indigo-800/80 dark:text-indigo-300/80">
          {startedEvent && (
            <span className="inline-flex items-center gap-1">
              <UserIcon className="h-3 w-3" />
              Started by <span className="font-semibold">{startedEvent.user_name}</span>
              {' · '}
              {formatAuditTimestamp(startedEvent.created_at)}
            </span>
          )}
          {fxSnapshot != null && (
            <span className="inline-flex items-center gap-1">
              <Coins className="h-3 w-3" />
              FX <span className="font-mono font-semibold">{fxSnapshot.toFixed(4)}</span> PHP/USD
            </span>
          )}
          <span>{events.length} event{events.length === 1 ? '' : 's'}</span>
          {showExportButton && exportUrl && (
            <Button
              variant="outline"
              size="sm"
              onClick={handleExport}
              className="h-7 gap-1.5 border-indigo-200 bg-white px-2.5 text-[11px] font-medium text-indigo-700 hover:border-indigo-300 hover:bg-indigo-50 dark:border-indigo-500/30 dark:bg-zinc-950 dark:text-indigo-300 dark:hover:bg-indigo-500/10"
              title="Download the full audit trail for this cycle (who edited what, FX rate, decisions, timestamps)"
            >
              <FileText className="h-3 w-3" />
              Export CSV
            </Button>
          )}
        </div>
      </div>

      {error ? (
        <div className="px-4 py-6 text-center text-xs text-rose-600 dark:text-rose-400">
          {error}
        </div>
      ) : (
        <>
          <div className="flex flex-wrap items-center gap-2 px-4 py-2.5">
            <div className="relative min-w-[180px] flex-1">
              <span className="pointer-events-none absolute inset-y-0 left-2.5 flex items-center">
                <Search className="h-3.5 w-3.5 text-indigo-500/60 dark:text-indigo-400/50" />
              </span>
              <input
                type="text"
                value={query}
                onChange={(e) => { setQuery(e.target.value); setPage(0); }}
                placeholder="Search by user, employee, action, or value..."
                className="w-full rounded-lg border border-indigo-200/80 bg-white/90 py-1.5 pl-7 pr-7 text-[12px] placeholder:text-zinc-400 focus:outline-none focus:ring-1 focus:ring-indigo-400/60 dark:border-indigo-500/20 dark:bg-zinc-950/60 dark:placeholder:text-zinc-600"
              />
              {query && (
                <button
                  type="button"
                  onClick={() => { setQuery(''); setPage(0); }}
                  className="absolute inset-y-0 right-2 flex items-center text-zinc-400 hover:text-zinc-600 dark:text-zinc-600 dark:hover:text-zinc-400"
                  aria-label="Clear search"
                >
                  <X className="h-3.5 w-3.5" />
                </button>
              )}
            </div>
            <select
              value={actionFilter}
              onChange={(e) => { setActionFilter(e.target.value); setPage(0); }}
              className="h-7 rounded-md border border-indigo-200/80 bg-white px-2 text-[11px] text-zinc-700 focus:outline-none focus:ring-1 focus:ring-indigo-400/60 dark:border-indigo-500/20 dark:bg-zinc-950/60 dark:text-zinc-300"
            >
              <option value="all">All actions</option>
              {actionOptions.map((a) => (
                <option key={a} value={a}>
                  {ACTION_PRESENTATION[a]?.label ?? a}
                </option>
              ))}
            </select>
          </div>

          {loading ? (
            <div className="px-4 py-8 text-center text-xs text-zinc-500 dark:text-zinc-500">
              Loading audit trail...
            </div>
          ) : filtered.length === 0 ? (
            <div className="px-4 py-8 text-center text-xs text-zinc-500 dark:text-zinc-500">
              {events.length === 0
                ? 'No audit events recorded for this cycle yet.'
                : 'No events match the current filters.'}
            </div>
          ) : (
            <div className="overflow-x-auto">
              <table className="w-full min-w-[760px] text-xs">
                <thead className="bg-indigo-50/60 text-[10px] uppercase tracking-wide text-indigo-800 dark:bg-indigo-950/30 dark:text-indigo-400">
                  <tr>
                    <th className="px-3 py-2 text-left font-medium">When</th>
                    <th className="px-3 py-2 text-left font-medium">User</th>
                    <th className="px-3 py-2 text-left font-medium">Action</th>
                    <th className="px-3 py-2 text-left font-medium">Target</th>
                    <th className="px-3 py-2 text-left font-medium">Change</th>
                    <th className="px-3 py-2 text-right font-medium" />
                  </tr>
                </thead>
                <tbody className="divide-y divide-indigo-100/60 dark:divide-indigo-900/20">
                  {visible.map((ev) => {
                    const isOpen = expandedId === ev.id;
                    return (
                      <React.Fragment key={ev.id}>
                        <tr className="hover:bg-indigo-50/40 dark:hover:bg-indigo-950/20">
                          <td className="px-3 py-2 align-top whitespace-nowrap font-mono text-[10px] text-zinc-600 dark:text-zinc-400">
                            {formatAuditTimestamp(ev.created_at)}
                          </td>
                          <td className="px-3 py-2 align-top">
                            <div className="font-medium text-zinc-900 dark:text-zinc-100">{ev.user_name}</div>
                            <div className="text-[10px] uppercase tracking-wide text-zinc-500 dark:text-zinc-500">{ev.user_role}</div>
                          </td>
                          <td className="px-3 py-2 align-top">
                            <ActionBadge action={ev.action} />
                          </td>
                          <td className="px-3 py-2 align-top">
                            <div className="font-mono text-[11px] text-zinc-700 dark:text-zinc-300 break-all">
                              {describeEventTarget(ev)}
                            </div>
                          </td>
                          <td className="px-3 py-2 align-top">
                            <div className="text-zinc-800 dark:text-zinc-200">
                              {describeEventValue(ev) || (
                                <span className="text-zinc-400 dark:text-zinc-600">{'—'}</span>
                              )}
                            </div>
                          </td>
                          <td className="px-3 py-2 align-top text-right">
                            <button
                              type="button"
                              onClick={() => setExpandedId(isOpen ? null : ev.id)}
                              className="text-[10px] font-semibold uppercase tracking-wide text-indigo-700 hover:text-indigo-900 dark:text-indigo-300 dark:hover:text-indigo-200"
                            >
                              {isOpen ? 'Hide' : 'Details'}
                            </button>
                          </td>
                        </tr>
                        {isOpen && (
                          <tr>
                            <td colSpan={6} className="bg-indigo-50/30 px-3 py-2 dark:bg-indigo-950/20">
                              <div className="grid grid-cols-1 gap-2 text-[10px] sm:grid-cols-2">
                                <div>
                                  <span className="font-semibold text-zinc-600 dark:text-zinc-400">Resource:</span>{' '}
                                  <span className="font-mono">{ev.resource}{ev.resource_id ? `/${ev.resource_id}` : ''}</span>
                                </div>
                                <div>
                                  <span className="font-semibold text-zinc-600 dark:text-zinc-400">IP:</span>{' '}
                                  <span className="font-mono">{ev.ip_address ?? '—'}</span>
                                </div>
                                <div>
                                  <span className="font-semibold text-zinc-600 dark:text-zinc-400">Matched via:</span>{' '}
                                  <span>{ev.matched_via === 'cycle_context' ? 'explicit cycle tag' : 'time window'}</span>
                                </div>
                              </div>
                              <pre className="mt-2 max-h-48 overflow-auto rounded-md border border-indigo-200/60 bg-white/80 p-2 font-mono text-[10px] leading-snug text-zinc-700 dark:border-indigo-500/20 dark:bg-zinc-950/60 dark:text-zinc-300">
{JSON.stringify(ev.details ?? {}, null, 2)}
                              </pre>
                            </td>
                          </tr>
                        )}
                      </React.Fragment>
                    );
                  })}
                </tbody>
              </table>
            </div>
          )}

          {filtered.length > AUDIT_PAGE_SIZE && (
            <div className="flex flex-wrap items-center justify-between gap-2 border-t border-indigo-100/60 px-3 py-2 text-[10px] tabular-nums text-zinc-500 dark:border-indigo-900/20 dark:text-zinc-500">
              <span>
                Showing <span className="font-semibold text-zinc-700 dark:text-zinc-300">{start + 1}</span>
                {' - '}
                <span className="font-semibold text-zinc-700 dark:text-zinc-300">{start + visible.length}</span>
                {' of '}
                <span className="font-semibold text-zinc-700 dark:text-zinc-300">{filtered.length}</span>
              </span>
              <div className="flex items-center gap-1.5">
                <button
                  type="button"
                  onClick={() => setPage((p) => Math.max(0, p - 1))}
                  disabled={safePage === 0}
                  className="flex h-6 w-6 items-center justify-center rounded-md border border-indigo-200/70 bg-white text-zinc-600 hover:bg-indigo-50 disabled:pointer-events-none disabled:opacity-40 dark:border-indigo-500/20 dark:bg-zinc-950 dark:text-zinc-400 dark:hover:bg-indigo-500/10"
                >
                  <ChevronLeft className="h-3.5 w-3.5" />
                </button>
                <span className="min-w-[4rem] text-center font-semibold">
                  {safePage + 1} / {pageCount}
                </span>
                <button
                  type="button"
                  onClick={() => setPage((p) => Math.min(pageCount - 1, p + 1))}
                  disabled={safePage >= pageCount - 1}
                  className="flex h-6 w-6 items-center justify-center rounded-md border border-indigo-200/70 bg-white text-zinc-600 hover:bg-indigo-50 disabled:pointer-events-none disabled:opacity-40 dark:border-indigo-500/20 dark:bg-zinc-950 dark:text-zinc-400 dark:hover:bg-indigo-500/10"
                >
                  <ChevronRight className="h-3.5 w-3.5" />
                </button>
              </div>
            </div>
          )}
        </>
      )}
      {/* Indicator chip for the cycle key — handy when the panel is rendered standalone. */}
      {bundle && (bundle.sourceFile || bundle.periodStart) && (
        <div className="flex flex-wrap items-center gap-2 border-t border-indigo-100/60 px-3 py-1.5 text-[10px] text-zinc-500 dark:border-indigo-900/20 dark:text-zinc-500">
          {bundle.sourceFile && (
            <span className="inline-flex items-center gap-1">
              <CheckCircle2 className="h-3 w-3 text-indigo-500/70" />
              <span className="font-mono">{bundle.sourceFile}</span>
            </span>
          )}
          {bundle.periodStart && bundle.periodEnd && (
            <span>
              {bundle.periodStart} {'→'} {bundle.periodEnd}
            </span>
          )}
        </div>
      )}
    </section>
  );
}
