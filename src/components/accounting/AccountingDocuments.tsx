'use client';

import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { motion } from 'motion/react';
import {
  AlertTriangle,
  CheckCircle2,
  Download,
  Eye,
  FileSignature,
  FileSpreadsheet,
  Inbox,
  Loader2,
  PenLine,
  RefreshCw,
  ShieldCheck,
  Trash2,
  XCircle,
} from 'lucide-react';
import { toast } from 'sonner';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Switch } from '@/components/ui/switch';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { cn } from '@/lib/utils';
import { useLiveRefresh } from '@/hooks/useLiveRefresh';
import SignaturePad from '@/components/common/SignaturePad';
import PayCycleReports from '@/components/accounting/PayCycleReports';
import {
  DOCUMENT_STATUS_LABELS,
  documentTypeLabel,
  formatDocumentDate,
  formatFileSize,
  type DocumentRequestRow,
  type DocumentRequestStatus,
  type DocumentSignatureRow,
} from '@/lib/documents/types';

type Filter = DocumentRequestStatus | 'all';

const STATUS_STYLE: Record<DocumentRequestStatus, string> = {
  pending: 'bg-amber-100 text-amber-700 dark:bg-amber-500/15 dark:text-amber-300',
  signed: 'bg-emerald-100 text-emerald-700 dark:bg-emerald-500/15 dark:text-emerald-300',
  rejected: 'bg-rose-100 text-rose-700 dark:bg-rose-500/15 dark:text-rose-300',
};

type DocumentsTab = 'queue' | 'reports';
const DOCUMENTS_TAB_STORAGE_KEY = 'accounting-documents-tab';

/**
 * Accounting → Documents. Three jobs, split across two tabs:
 *   1. The signing queue — employee-submitted PDFs (pay stubs, COEs, awards)
 *      that Accounting reviews and either signs (stamping the saved signature +
 *      requested/signed dates into the PDF, returned to the employee) or
 *      rejects with a note.
 *   2. The signature manager — the Accounting Head draws their signature once,
 *      it's saved to Supabase, and the switch revokes it at any time. With the
 *      switch off (or no signature saved) approvals are blocked.
 *   3. The Reports tab — pay cycle reports Accounting publishes once every
 *      payment in a cycle has gone out, with CSV/XLSX/PDF export. Rendered by
 *      PayCycleReports; this file only owns the tab shell, the badge count,
 *      and routing Refresh to whichever tab is active.
 * Jobs 1 and 2 live on the "Signing queue" tab (the default); job 3 is its
 * own "Reports" tab.
 */
export default function AccountingDocuments({
  sessionEmail,
  canEdit,
}: {
  sessionEmail: string | null;
  canEdit: boolean;
}) {
  const [rows, setRows] = useState<DocumentRequestRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [filter, setFilter] = useState<Filter>('pending');

  // Tab shell (Task 7) — defaults to the signing queue so today's behaviour
  // is exactly what an existing user still sees on first load. Restored from
  // localStorage after mount (effect below) so SSR markup stays
  // deterministic. `readyCount` is the Reports badge; `reportsRefreshKey` is
  // bumped by the header's Refresh button while the Reports tab is active
  // (undefined until the first bump — see PayCycleReports' refreshKey prop).
  const [tab, setTab] = useState<DocumentsTab>('queue');
  const [readyCount, setReadyCount] = useState(0);
  const [reportsRefreshKey, setReportsRefreshKey] = useState<number | undefined>(undefined);

  const [signature, setSignature] = useState<DocumentSignatureRow | null>(null);
  const [signatureLoaded, setSignatureLoaded] = useState(false);
  const [sigDialogOpen, setSigDialogOpen] = useState(false);
  const [sigDraft, setSigDraft] = useState<string | null>(null);
  const [sigName, setSigName] = useState('');
  const [sigTitle, setSigTitle] = useState('Accounting Head');
  const [sigSaving, setSigSaving] = useState(false);
  const [sigToggling, setSigToggling] = useState(false);
  const promptedRef = useRef(false);

  const [signTarget, setSignTarget] = useState<DocumentRequestRow | null>(null);
  const [rejectTarget, setRejectTarget] = useState<DocumentRequestRow | null>(null);
  const [rejectNote, setRejectNote] = useState('');
  /** Row awaiting confirmation before it and its PDFs are destroyed. */
  const [deleteTarget, setDeleteTarget] = useState<DocumentRequestRow | null>(null);
  const [actingId, setActingId] = useState<string | null>(null);
  const [previewingId, setPreviewingId] = useState<string | null>(null);

  const fetchRows = useCallback(async (opts?: { silent?: boolean }) => {
    if (!opts?.silent) setLoading(true);
    setError(null);
    try {
      const res = await fetch('/api/accounting/documents', { cache: 'no-store' });
      const json = (await res.json()) as { rows?: DocumentRequestRow[]; error?: string };
      if (!res.ok || json.error) throw new Error(json.error || `Request failed (${res.status})`);
      setRows(json.rows ?? []);
    } catch (e) {
      if (!opts?.silent) setError(e instanceof Error ? e.message : 'Failed to load requests');
    } finally {
      if (!opts?.silent) setLoading(false);
    }
  }, []);

  const fetchSignature = useCallback(async () => {
    try {
      const res = await fetch('/api/accounting/documents/signature', { cache: 'no-store' });
      const json = (await res.json()) as { row?: DocumentSignatureRow | null; error?: string };
      if (!res.ok || json.error) throw new Error(json.error || `Request failed (${res.status})`);
      setSignature(json.row ?? null);
    } catch {
      /* the queue still renders; signing surfaces its own error */
    } finally {
      setSignatureLoaded(true);
    }
  }, []);

  useEffect(() => {
    void fetchRows();
    void fetchSignature();
  }, [fetchRows, fetchSignature]);

  // Restore the last-used tab after mount so SSR markup stays deterministic.
  useEffect(() => {
    try {
      const stored = window.localStorage.getItem(DOCUMENTS_TAB_STORAGE_KEY);
      if (stored === 'queue' || stored === 'reports') setTab(stored);
    } catch {
      /* storage unavailable — keep default */
    }
  }, []);

  const changeTab = (next: DocumentsTab) => {
    setTab(next);
    try {
      window.localStorage.setItem(DOCUMENTS_TAB_STORAGE_KEY, next);
    } catch {
      /* storage unavailable — preference just won't persist */
    }
  };

  // Refresh follows whichever tab is active: the signing queue re-fetches
  // its rows directly, while Reports has no fetch of its own here — it owns
  // that inside PayCycleReports, so bump the counter that component watches.
  const refreshActiveTab = () => {
    if (tab === 'queue') void fetchRows();
    else setReportsRefreshKey((k) => (k ?? 0) + 1);
  };

  // New submissions float in live (table is in the Realtime publication); the
  // poll + focus refresh are the backstop if the socket drops.
  useLiveRefresh({
    tables: ['document_requests'],
    onRefresh: () => void fetchRows({ silent: true }),
    channel: 'accounting-documents',
    pollMs: 60_000,
  });

  // "Carla would be prompted for her signature" — first visit with edit access
  // and no saved signature auto-opens the capture dialog, once.
  useEffect(() => {
    if (!signatureLoaded || !canEdit || promptedRef.current || signature) return;
    promptedRef.current = true;
    openSignatureDialog();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [signatureLoaded, signature, canEdit]);

  const openSignatureDialog = () => {
    setSigDraft(null);
    setSigName(signature?.owner_name ?? '');
    setSigTitle(signature?.title ?? 'Accounting Head');
    setSigDialogOpen(true);
  };

  const saveSignature = async () => {
    if (!sigDraft && !signature) {
      toast.error('Draw your signature first');
      return;
    }
    if (!sigName.trim()) {
      toast.error('Enter the name to print under the signature');
      return;
    }
    setSigSaving(true);
    try {
      const res = await fetch('/api/accounting/documents/signature', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          ...(sigDraft ? { image_data_url: sigDraft } : {}),
          owner_name: sigName.trim(),
          title: sigTitle.trim() || 'Accounting Head',
          enabled: true,
        }),
      });
      const json = (await res.json()) as { row?: DocumentSignatureRow; error?: string };
      if (!res.ok || json.error || !json.row) throw new Error(json.error || 'Save failed');
      setSignature(json.row);
      setSigDialogOpen(false);
      toast.success('Signature saved', {
        description: 'It will be stamped on documents you approve.',
      });
    } catch (e) {
      toast.error(e instanceof Error ? e.message : 'Could not save signature');
    } finally {
      setSigSaving(false);
    }
  };

  const toggleSignatureEnabled = async (next: boolean) => {
    if (!signature) return;
    setSigToggling(true);
    try {
      const res = await fetch('/api/accounting/documents/signature', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ enabled: next }),
      });
      const json = (await res.json()) as { row?: DocumentSignatureRow; error?: string };
      if (!res.ok || json.error || !json.row) throw new Error(json.error || 'Update failed');
      setSignature(json.row);
      toast.success(next ? 'Signature re-enabled' : 'Signature revoked', {
        description: next
          ? 'You can approve and sign documents again.'
          : 'Approvals are blocked until you switch it back on.',
      });
    } catch (e) {
      toast.error(e instanceof Error ? e.message : 'Could not update signature');
    } finally {
      setSigToggling(false);
    }
  };

  const previewFile = async (row: DocumentRequestRow, which: 'original' | 'signed') => {
    setPreviewingId(`${row.id}:${which}`);
    try {
      const res = await fetch(`/api/accounting/documents/${row.id}?which=${which}`, { cache: 'no-store' });
      const json = (await res.json()) as { url?: string; error?: string };
      if (!res.ok || !json.url) throw new Error(json.error || 'Could not open the file');
      window.open(json.url, '_blank', 'noopener,noreferrer');
    } catch (e) {
      toast.error(e instanceof Error ? e.message : 'Could not open the file');
    } finally {
      setPreviewingId(null);
    }
  };

  /** Remove a request and both PDFs. This also clears it from the employee's own
   *  list, so the dialog says so plainly before it happens. */
  const removeRow = async (row: DocumentRequestRow) => {
    setActingId(row.id);
    try {
      const res = await fetch(`/api/accounting/documents/${row.id}`, { method: 'DELETE' });
      const json = (await res.json()) as { error?: string };
      if (!res.ok) throw new Error(json.error || 'Delete failed');
      setDeleteTarget(null);
      toast.success('Request deleted', {
        description: `${row.employee_name || row.employee_email}'s ${documentTypeLabel(row.document_type)} and its files are gone.`,
      });
      await fetchRows({ silent: true });
    } catch (e) {
      toast.error(e instanceof Error ? e.message : 'Could not delete the request');
    } finally {
      setActingId(null);
    }
  };

  const decide = async (row: DocumentRequestRow, action: 'sign' | 'reject', note?: string) => {
    setActingId(row.id);
    try {
      const res = await fetch(`/api/accounting/documents/${row.id}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action, ...(note ? { note } : {}) }),
      });
      const json = (await res.json()) as { row?: DocumentRequestRow; error?: string };
      if (!res.ok || json.error || !json.row) {
        // 412 = no active signature — steer straight into the capture dialog.
        if (res.status === 412) {
          setSignTarget(null);
          openSignatureDialog();
        }
        throw new Error(json.error || 'Decision failed');
      }
      setSignTarget(null);
      setRejectTarget(null);
      setRejectNote('');
      toast.success(
        action === 'sign' ? 'Document signed & returned' : 'Request rejected',
        {
          description:
            action === 'sign'
              ? `${row.employee_name || row.employee_email} can now download the signed copy from their profile.`
              : `${row.employee_name || row.employee_email} has been notified.`,
        },
      );
      await fetchRows({ silent: true });
    } catch (e) {
      toast.error(e instanceof Error ? e.message : 'Decision failed');
    } finally {
      setActingId(null);
    }
  };

  const counts = useMemo(() => {
    const c: Record<Filter, number> = { pending: 0, signed: 0, rejected: 0, all: rows.length };
    for (const r of rows) c[r.status] += 1;
    return c;
  }, [rows]);

  const visible = useMemo(
    () => (filter === 'all' ? rows : rows.filter((r) => r.status === filter)),
    [rows, filter],
  );

  const signingBlocked = !signature || !signature.enabled;

  return (
    <div className="flex h-full min-h-0 flex-col">
      <div className="shrink-0 border-b border-orange-100/70 bg-white px-4 py-3 sm:px-6 sm:py-5 dark:border-orange-950/40 dark:bg-[#0d1117]">
        <div className="flex items-center justify-between gap-3">
          <div>
            <h1 className="flex items-center gap-2 text-base font-semibold tracking-tight text-zinc-900 sm:text-xl dark:text-white">
              <FileSignature className="h-5 w-5 text-orange-600 dark:text-orange-400" />
              Documents
            </h1>
            <p className="mt-0.5 text-xs text-zinc-500 dark:text-zinc-500">
              {tab === 'queue' ? (
                <>
                  Employee-submitted documents (pay stubs, COEs, awards) awaiting the Accounting
                  Head&rsquo;s signature. Signed copies are returned to the employee&rsquo;s profile.
                </>
              ) : (
                'Pay cycle reports published by Accounting once every payment in a cycle has gone out. Export any report as CSV, XLSX or PDF.'
              )}
            </p>
          </div>
          <Button
            type="button"
            variant="outline"
            size="sm"
            onClick={refreshActiveTab}
            className="h-8 gap-1.5 border-orange-200 text-orange-700 hover:bg-orange-50 dark:border-orange-800 dark:text-orange-300"
          >
            <RefreshCw className={cn('h-3.5 w-3.5', tab === 'queue' && loading && 'animate-spin')} />
            Refresh
          </Button>
        </div>

        <div role="tablist" className="mt-3 inline-flex items-center rounded-lg border border-orange-100 bg-orange-50/50 p-0.5 dark:border-orange-950/40 dark:bg-orange-950/20">
          <DocumentsTabButton
            active={tab === 'queue'}
            onClick={() => changeTab('queue')}
            icon={FileSignature}
            label="Signing queue"
            count={counts.pending}
          />
          <DocumentsTabButton
            active={tab === 'reports'}
            onClick={() => changeTab('reports')}
            icon={FileSpreadsheet}
            label="Reports"
            count={readyCount}
            highlight
          />
        </div>
      </div>

      {tab === 'queue' ? (
      <div className="min-h-0 flex-1 overflow-y-auto bg-[#fafaf8] px-3 py-4 sm:px-6 sm:py-6 dark:bg-[#0d1117]">
        <div className="mx-auto w-full max-w-6xl space-y-5">
          {/* ── Signature manager ─────────────────────────────────────────── */}
          <section className="rounded-2xl border border-orange-100/80 bg-white p-4 sm:p-5 dark:border-orange-950/40 dark:bg-zinc-950">
            <div className="flex flex-col gap-4 sm:flex-row sm:items-start sm:justify-between">
              <div className="min-w-0">
                <h2 className="flex items-center gap-1.5 text-sm font-semibold text-zinc-900 dark:text-zinc-100">
                  <ShieldCheck className="h-4 w-4 text-orange-500" />
                  Your signing signature
                </h2>
                <p className="mt-1 max-w-xl text-xs leading-relaxed text-zinc-500 dark:text-zinc-400">
                  Saved in Supabase and stamped onto every document you approve, together with the
                  requested and signed dates. Turn the switch off to revoke it — approvals are
                  blocked until it&rsquo;s back on.
                </p>
                {!canEdit && (
                  <p className="mt-2 text-[11.5px] italic text-zinc-400 dark:text-zinc-500">
                    You have view-only access — signing and signature changes are disabled.
                  </p>
                )}
              </div>

              {signatureLoaded && signature ? (
                <div className="flex shrink-0 flex-col items-stretch gap-2 sm:items-end">
                  <div className="rounded-xl border border-zinc-200 bg-white px-4 py-2 dark:border-zinc-700">
                    {/* Signature ink is dark navy — keep a light backing in dark mode. */}
                    {/* eslint-disable-next-line @next/next/no-img-element */}
                    <img
                      src={signature.image_data_url}
                      alt={`${signature.owner_name ?? 'Saved'} signature`}
                      className="h-12 w-auto max-w-[220px] object-contain"
                    />
                  </div>
                  <div className="text-right text-[11px] leading-tight text-zinc-500 dark:text-zinc-400">
                    <span className="font-medium text-zinc-700 dark:text-zinc-200">
                      {signature.owner_name ?? signature.owner_email}
                    </span>
                    {signature.title ? ` · ${signature.title}` : ''}
                  </div>
                  {canEdit && (
                    <div className="flex items-center justify-end gap-3">
                      <label className="flex cursor-pointer items-center gap-2 text-xs font-medium text-zinc-600 dark:text-zinc-300">
                        <Switch
                          checked={signature.enabled}
                          onCheckedChange={(v) => void toggleSignatureEnabled(v)}
                          disabled={sigToggling}
                          aria-label="Signature active"
                        />
                        {signature.enabled ? 'Active' : 'Revoked'}
                      </label>
                      <Button
                        type="button"
                        variant="outline"
                        size="sm"
                        onClick={openSignatureDialog}
                        className="h-7 gap-1.5 text-xs"
                      >
                        <PenLine className="h-3 w-3" />
                        Redraw
                      </Button>
                    </div>
                  )}
                  {!signature.enabled && (
                    <p className="flex items-center gap-1 text-[11px] font-medium text-rose-600 dark:text-rose-400">
                      <AlertTriangle className="h-3 w-3" />
                      Signature revoked — approvals are blocked.
                    </p>
                  )}
                </div>
              ) : signatureLoaded && canEdit ? (
                <div className="flex shrink-0 flex-col items-start gap-2 rounded-xl border border-dashed border-amber-300 bg-amber-50/70 px-4 py-3 dark:border-amber-500/40 dark:bg-amber-950/20 sm:items-end">
                  <p className="text-xs font-medium text-amber-900 dark:text-amber-200">
                    No signature on file yet.
                  </p>
                  <Button
                    type="button"
                    size="sm"
                    onClick={openSignatureDialog}
                    className="h-8 gap-1.5 bg-orange-500 text-xs font-semibold text-white hover:bg-orange-600"
                  >
                    <PenLine className="h-3.5 w-3.5" />
                    Set up my signature
                  </Button>
                </div>
              ) : signatureLoaded ? (
                <p className="text-xs italic text-zinc-400">No signature on file.</p>
              ) : (
                <Loader2 className="h-4 w-4 animate-spin text-zinc-400" />
              )}
            </div>
          </section>

          {/* ── Requests queue ────────────────────────────────────────────── */}
          <section>
            <div className="mb-3 flex flex-wrap items-center gap-1.5">
              {(['pending', 'signed', 'rejected', 'all'] as const).map((f) => (
                <button
                  key={f}
                  type="button"
                  onClick={() => setFilter(f)}
                  className={cn(
                    'rounded-full border px-3 py-1 text-xs font-medium transition-colors',
                    filter === f
                      ? 'border-orange-500 bg-orange-500 text-white shadow-sm'
                      : 'border-zinc-200 bg-white text-zinc-600 hover:border-orange-300 hover:text-orange-700 dark:border-zinc-700 dark:bg-zinc-900 dark:text-zinc-300',
                  )}
                >
                  {f === 'all' ? 'All' : DOCUMENT_STATUS_LABELS[f]}
                  <span className={cn('ml-1.5 tabular-nums', filter === f ? 'text-orange-100' : 'text-zinc-400')}>
                    {counts[f]}
                  </span>
                </button>
              ))}
            </div>

            {loading ? (
              <div className="flex items-center justify-center gap-2 py-16 text-sm text-zinc-500">
                <Loader2 className="h-4 w-4 animate-spin" />
                Loading document requests...
              </div>
            ) : error ? (
              <div className="rounded-xl border border-dashed border-rose-200 bg-white py-10 text-center text-sm text-rose-600 dark:border-rose-500/30 dark:bg-[#0d1117]">
                {error}
              </div>
            ) : visible.length === 0 ? (
              <div className="flex flex-col items-center gap-2 rounded-2xl border border-dashed border-orange-200 bg-white py-16 text-center dark:border-orange-950/40 dark:bg-[#0d1117]">
                <Inbox className="h-7 w-7 text-orange-300 dark:text-orange-800" />
                <p className="text-sm text-zinc-500">
                  {filter === 'pending'
                    ? 'No documents waiting for a signature.'
                    : 'Nothing here yet.'}
                </p>
              </div>
            ) : (
              <div className="overflow-x-auto rounded-2xl border border-orange-100/80 bg-white dark:border-orange-950/40 dark:bg-zinc-950">
                <table className="w-full min-w-[880px] text-left text-sm">
                  <thead className="bg-orange-50/60 text-xs text-zinc-600 dark:bg-orange-950/20 dark:text-zinc-400">
                    <tr>
                      <th className="px-3 py-2.5 font-semibold">Employee</th>
                      <th className="px-3 py-2.5 font-semibold">Document</th>
                      <th className="px-3 py-2.5 font-semibold">Requested</th>
                      <th className="px-3 py-2.5 font-semibold">Signed</th>
                      <th className="px-3 py-2.5 font-semibold">Status</th>
                      <th className="px-3 py-2.5 text-right font-semibold">Actions</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-orange-100/70 dark:divide-orange-950/40">
                    {visible.map((r) => {
                      const acting = actingId === r.id;
                      return (
                        <tr key={r.id} className="align-top hover:bg-orange-50/30 dark:hover:bg-orange-950/10">
                          <td className="px-3 py-2.5">
                            <div className="font-medium text-zinc-900 dark:text-zinc-100">
                              {r.employee_name || r.employee_email}
                            </div>
                            <div className="font-mono text-[11px] text-zinc-400">{r.employee_email}</div>
                          </td>
                          <td className="max-w-[260px] px-3 py-2.5">
                            <div className="text-[13px] font-medium text-zinc-800 dark:text-zinc-200">
                              {documentTypeLabel(r.document_type)}
                              {r.period_label && (
                                <span className="ml-1.5 rounded bg-zinc-100 px-1.5 py-0.5 text-[10.5px] font-medium text-zinc-500 dark:bg-zinc-800 dark:text-zinc-400">
                                  {r.period_label}
                                </span>
                              )}
                            </div>
                            <button
                              type="button"
                              onClick={() => void previewFile(r, 'original')}
                              disabled={previewingId === `${r.id}:original`}
                              className="mt-0.5 inline-flex max-w-full items-center gap-1 truncate text-[11.5px] text-orange-600 hover:underline disabled:opacity-50 dark:text-orange-400"
                              title="Open the submitted PDF"
                            >
                              {previewingId === `${r.id}:original`
                                ? <Loader2 className="h-3 w-3 shrink-0 animate-spin" />
                                : <Eye className="h-3 w-3 shrink-0" />}
                              <span className="truncate">{r.file_name || 'document.pdf'}</span>
                              <span className="shrink-0 text-zinc-400">({formatFileSize(r.file_size)})</span>
                            </button>
                            {r.note && (
                              <p className="mt-1 line-clamp-2 text-[11.5px] italic leading-snug text-zinc-500 dark:text-zinc-400" title={r.note}>
                                &ldquo;{r.note}&rdquo;
                              </p>
                            )}
                          </td>
                          <td className="whitespace-nowrap px-3 py-2.5 text-xs text-zinc-600 dark:text-zinc-300">
                            {formatDocumentDate(r.requested_at)}
                          </td>
                          <td className="px-3 py-2.5 text-xs text-zinc-600 dark:text-zinc-300">
                            {r.status === 'signed' ? (
                              <>
                                <div className="whitespace-nowrap">{formatDocumentDate(r.signed_at)}</div>
                                <div className="text-[11px] text-zinc-400">
                                  by {r.signed_by_name || r.signed_by}
                                </div>
                              </>
                            ) : r.status === 'rejected' && r.decision_note ? (
                              <span className="line-clamp-2 max-w-[180px] text-[11.5px] italic text-zinc-400" title={r.decision_note}>
                                &ldquo;{r.decision_note}&rdquo;
                              </span>
                            ) : (
                              '—'
                            )}
                          </td>
                          <td className="px-3 py-2.5">
                            <span className={cn(
                              'inline-flex rounded-full px-2 py-0.5 text-[10.5px] font-semibold uppercase tracking-wide',
                              STATUS_STYLE[r.status],
                            )}>
                              {DOCUMENT_STATUS_LABELS[r.status]}
                            </span>
                          </td>
                          <td className="px-3 py-2.5">
                            <div className="flex items-center justify-end gap-1.5">
                              {r.status === 'signed' && (
                                <Button
                                  type="button"
                                  variant="outline"
                                  size="sm"
                                  onClick={() => void previewFile(r, 'signed')}
                                  disabled={previewingId === `${r.id}:signed`}
                                  className="h-7 gap-1 text-xs"
                                >
                                  {previewingId === `${r.id}:signed`
                                    ? <Loader2 className="h-3 w-3 animate-spin" />
                                    : <Download className="h-3 w-3" />}
                                  Signed PDF
                                </Button>
                              )}
                              {r.status === 'pending' && canEdit && (
                                <>
                                  <Button
                                    type="button"
                                    size="sm"
                                    onClick={() => setSignTarget(r)}
                                    disabled={acting}
                                    className="h-7 gap-1 bg-emerald-600 text-xs font-semibold text-white hover:bg-emerald-700"
                                  >
                                    {acting ? <Loader2 className="h-3 w-3 animate-spin" /> : <CheckCircle2 className="h-3 w-3" />}
                                    Approve &amp; sign
                                  </Button>
                                  <Button
                                    type="button"
                                    variant="outline"
                                    size="sm"
                                    onClick={() => { setRejectTarget(r); setRejectNote(''); }}
                                    disabled={acting}
                                    className="h-7 gap-1 border-rose-200 text-xs text-rose-600 hover:bg-rose-50 dark:border-rose-900/50 dark:text-rose-400"
                                  >
                                    <XCircle className="h-3 w-3" />
                                    Reject
                                  </Button>
                                </>
                              )}
                              {canEdit && (
                                <Button
                                  type="button"
                                  variant="ghost"
                                  size="sm"
                                  onClick={() => setDeleteTarget(r)}
                                  disabled={acting}
                                  aria-label={`Delete ${documentTypeLabel(r.document_type)} for ${r.employee_name || r.employee_email}`}
                                  title="Delete this request and its files"
                                  // Readable at rest (zinc-600 ≈ 7:1) and rose only on
                                  // hover/focus — subordinate to Approve/Reject without
                                  // being an unreadable gray on a destructive action.
                                  className="h-7 gap-1 px-2 text-xs text-zinc-600 hover:bg-rose-50 hover:text-rose-700 focus-visible:bg-rose-50 focus-visible:text-rose-700 dark:text-zinc-300 dark:hover:bg-rose-500/10 dark:hover:text-rose-300 dark:focus-visible:bg-rose-500/10 dark:focus-visible:text-rose-300"
                                >
                                  <Trash2 className="h-3 w-3" />
                                  Delete
                                </Button>
                              )}
                            </div>
                          </td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              </div>
            )}
          </section>
        </div>
      </div>
      ) : (
        <PayCycleReports
          canEdit={canEdit}
          onReadyCountChange={setReadyCount}
          refreshKey={reportsRefreshKey}
        />
      )}

      {/* ── Delete confirmation ─────────────────────────────────────────────── */}
      <Dialog open={!!deleteTarget} onOpenChange={(o) => !o && setDeleteTarget(null)}>
        <DialogContent className="sm:max-w-md">
          <DialogHeader>
            <DialogTitle>Delete this request?</DialogTitle>
            <DialogDescription>
              {deleteTarget && (
                <>
                  This removes {deleteTarget.employee_name || deleteTarget.employee_email}&rsquo;s{' '}
                  {documentTypeLabel(deleteTarget.document_type)}
                  {deleteTarget.status === 'signed'
                    ? ', including the signed copy they downloaded from'
                    : ' from'}{' '}
                  their profile, along with the stored files. It cannot be undone — only the audit
                  log will show it existed.
                </>
              )}
            </DialogDescription>
          </DialogHeader>
          {deleteTarget?.status === 'signed' && (
            <p className="flex items-start gap-2 rounded-lg bg-rose-50 px-3 py-2.5 text-[12.5px] leading-relaxed text-rose-700 dark:bg-rose-500/10 dark:text-rose-300">
              <AlertTriangle className="mt-0.5 h-3.5 w-3.5 shrink-0" />
              This one was already signed
              {deleteTarget.signed_by_name ? ` by ${deleteTarget.signed_by_name}` : ''}. If the
              employee still needs it, they will have to request it again.
            </p>
          )}
          <DialogFooter>
            <Button
              type="button"
              variant="outline"
              onClick={() => setDeleteTarget(null)}
              disabled={!!actingId}
            >
              Keep it
            </Button>
            <Button
              type="button"
              onClick={() => deleteTarget && void removeRow(deleteTarget)}
              disabled={!!actingId}
              className="gap-1.5 bg-rose-600 text-white hover:bg-rose-700"
            >
              {actingId ? <Loader2 className="h-4 w-4 animate-spin" /> : <Trash2 className="h-4 w-4" />}
              Delete request
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* ── Approve & sign confirmation ─────────────────────────────────────── */}
      <Dialog open={!!signTarget} onOpenChange={(o) => !o && setSignTarget(null)}>
        <DialogContent className="sm:max-w-md">
          <DialogHeader>
            <DialogTitle>Sign this document?</DialogTitle>
            <DialogDescription>
              Your saved signature, the requested date and today&rsquo;s signed date are stamped
              into the PDF on a certification page, then the signed copy is returned to the
              employee.
            </DialogDescription>
          </DialogHeader>
          {signTarget && (
            <div className="space-y-3 text-sm">
              <div className="rounded-xl border border-zinc-200 bg-zinc-50/70 px-4 py-3 text-[12.5px] leading-relaxed dark:border-zinc-800 dark:bg-zinc-900/40">
                <div>
                  <span className="text-zinc-500">Employee:</span>{' '}
                  <span className="font-medium text-zinc-800 dark:text-zinc-200">
                    {signTarget.employee_name || signTarget.employee_email}
                  </span>
                </div>
                <div>
                  <span className="text-zinc-500">Document:</span>{' '}
                  <span className="font-medium text-zinc-800 dark:text-zinc-200">
                    {documentTypeLabel(signTarget.document_type)}
                    {signTarget.period_label ? ` — ${signTarget.period_label}` : ''}
                  </span>
                </div>
                <div>
                  <span className="text-zinc-500">Requested:</span>{' '}
                  <span className="font-medium text-zinc-800 dark:text-zinc-200">
                    {formatDocumentDate(signTarget.requested_at)}
                  </span>
                </div>
              </div>
              {signingBlocked ? (
                <div className="flex items-start gap-2 rounded-xl border border-amber-300 bg-amber-50/80 px-3 py-2.5 text-xs text-amber-900 dark:border-amber-500/40 dark:bg-amber-950/20 dark:text-amber-200">
                  <AlertTriangle className="mt-0.5 h-3.5 w-3.5 shrink-0" />
                  <span>
                    {!signature
                      ? 'No signature on file — set up your signature first.'
                      : 'Your signature is revoked — switch it back on to sign.'}
                  </span>
                </div>
              ) : (
                <div className="flex items-center gap-3 rounded-xl border border-zinc-200 bg-white px-4 py-2.5 dark:border-zinc-700">
                  {/* eslint-disable-next-line @next/next/no-img-element */}
                  <img
                    src={signature!.image_data_url}
                    alt="Your signature"
                    className="h-10 w-auto max-w-[160px] object-contain"
                  />
                  <div className="text-[11px] leading-tight text-zinc-500">
                    <div className="font-medium text-zinc-700 dark:text-zinc-300">{signature!.owner_name}</div>
                    <div>{signature!.title || 'Accounting Head'}</div>
                  </div>
                </div>
              )}
            </div>
          )}
          <DialogFooter>
            <Button type="button" variant="outline" onClick={() => setSignTarget(null)}>
              Cancel
            </Button>
            {signingBlocked ? (
              <Button
                type="button"
                onClick={() => { setSignTarget(null); openSignatureDialog(); }}
                className="gap-1.5 bg-orange-500 text-white hover:bg-orange-600"
              >
                <PenLine className="h-3.5 w-3.5" />
                Set up signature
              </Button>
            ) : (
              <Button
                type="button"
                onClick={() => signTarget && void decide(signTarget, 'sign')}
                disabled={!!actingId}
                className="gap-1.5 bg-emerald-600 text-white hover:bg-emerald-700"
              >
                {actingId ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <FileSignature className="h-3.5 w-3.5" />}
                Sign &amp; return
              </Button>
            )}
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* ── Reject dialog ───────────────────────────────────────────────────── */}
      <Dialog open={!!rejectTarget} onOpenChange={(o) => !o && setRejectTarget(null)}>
        <DialogContent className="sm:max-w-md">
          <DialogHeader>
            <DialogTitle>Reject this request?</DialogTitle>
            <DialogDescription>
              {rejectTarget
                ? `${rejectTarget.employee_name || rejectTarget.employee_email} will be notified with your reason.`
                : ''}
            </DialogDescription>
          </DialogHeader>
          <textarea
            value={rejectNote}
            onChange={(e) => setRejectNote(e.target.value)}
            rows={3}
            maxLength={500}
            placeholder="Reason (required) — e.g. wrong file attached, unreadable scan, request COE from HR instead."
            className="w-full resize-y rounded-lg border border-zinc-200 bg-white px-3 py-2 text-[13.5px] leading-relaxed text-zinc-900 placeholder:text-zinc-400 focus:border-rose-300 focus:outline-none focus:ring-1 focus:ring-rose-200 dark:border-zinc-800 dark:bg-zinc-950/60 dark:text-zinc-100"
          />
          <DialogFooter>
            <Button type="button" variant="outline" onClick={() => setRejectTarget(null)}>
              Cancel
            </Button>
            <Button
              type="button"
              onClick={() => rejectTarget && void decide(rejectTarget, 'reject', rejectNote.trim())}
              disabled={!rejectNote.trim() || !!actingId}
              className="gap-1.5 bg-rose-600 text-white hover:bg-rose-700"
            >
              {actingId ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <XCircle className="h-3.5 w-3.5" />}
              Reject request
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* ── Signature capture dialog ────────────────────────────────────────── */}
      <Dialog open={sigDialogOpen} onOpenChange={setSigDialogOpen}>
        <DialogContent className="sm:max-w-lg">
          <DialogHeader>
            <DialogTitle>{signature ? 'Update your signature' : 'Set up your signature'}</DialogTitle>
            <DialogDescription>
              Drawn once, saved to Supabase, and stamped onto every document you approve — with
              the requested and signed dates so the document can be verified. You can revoke it
              any time with the switch.
            </DialogDescription>
          </DialogHeader>
          <div className="space-y-3">
            <div className="grid gap-3 sm:grid-cols-2">
              <label className="block">
                <span className="mb-1 block text-[12px] font-medium text-zinc-700 dark:text-zinc-200">
                  Printed name
                </span>
                <Input
                  value={sigName}
                  onChange={(e) => setSigName(e.target.value)}
                  placeholder={sessionEmail ? sessionEmail.split('@')[0] : 'Full name'}
                  maxLength={80}
                />
              </label>
              <label className="block">
                <span className="mb-1 block text-[12px] font-medium text-zinc-700 dark:text-zinc-200">
                  Title
                </span>
                <Input
                  value={sigTitle}
                  onChange={(e) => setSigTitle(e.target.value)}
                  placeholder="Accounting Head"
                  maxLength={80}
                />
              </label>
            </div>
            <SignaturePad onChange={setSigDraft} />
            {signature && !sigDraft && (
              <p className="text-[11.5px] text-zinc-400">
                Leave the pad blank to keep your current drawing and just update the name/title.
              </p>
            )}
          </div>
          <DialogFooter>
            <Button type="button" variant="outline" onClick={() => setSigDialogOpen(false)}>
              Cancel
            </Button>
            <Button
              type="button"
              onClick={() => void saveSignature()}
              disabled={sigSaving || (!sigDraft && !signature) || !sigName.trim()}
              className="gap-1.5 bg-orange-500 text-white hover:bg-orange-600"
            >
              {sigSaving ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <PenLine className="h-3.5 w-3.5" />}
              Save signature
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}

function DocumentsTabButton({
  active, onClick, icon: Icon, label, count, highlight = false,
}: {
  active: boolean;
  onClick: () => void;
  icon: React.ComponentType<{ className?: string }>;
  label: string;
  count?: number;
  /** Amber-pulse the count when there is work waiting (Reports: cycles ready
   *  to publish), so the call to action is visible from the other tab. */
  highlight?: boolean;
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
          : 'text-zinc-600 hover:bg-orange-100/70 hover:text-orange-700 dark:text-zinc-400 dark:hover:bg-orange-950/40 dark:hover:text-orange-200',
      )}
    >
      {active && (
        <motion.span
          layoutId="accounting-documents-tab-pill"
          aria-hidden
          className="absolute inset-0 rounded-md bg-gradient-to-r from-orange-500 to-rose-500 shadow-sm"
          transition={{ type: 'spring', stiffness: 380, damping: 32 }}
        />
      )}
      <span className="relative z-10 inline-flex items-center gap-1.5">
        <Icon className="h-3.5 w-3.5" />
        {label}
        {count != null && count > 0 && (
          <span
            className={cn(
              'rounded-full px-1.5 py-0.5 text-[10px] font-bold tabular-nums',
              active
                ? 'bg-white/25 text-white'
                : highlight
                  ? 'animate-pulse bg-amber-200 text-amber-900 dark:bg-amber-500/25 dark:text-amber-200'
                  : 'bg-zinc-200 text-zinc-700 dark:bg-zinc-800 dark:text-zinc-300',
            )}
          >
            {count}
          </span>
        )}
      </span>
    </button>
  );
}
