'use client';

import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  AlertTriangle,
  CheckCircle2,
  Clock,
  Download,
  ExternalLink,
  Eye,
  FileSignature,
  FileText,
  Hash,
  Inbox,
  Loader2,
  PenLine,
  RefreshCw,
  Search,
  ShieldCheck,
  Timer,
  Trash2,
  X,
  XCircle,
} from 'lucide-react';
import { toast } from 'sonner';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
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
import {
  DOCUMENT_STATUS_LABELS,
  documentTypeLabel,
  elapsedLabel,
  formatDocumentDate,
  formatDocumentDateTime,
  formatFileSize,
  formatRelativeTime,
  isSystemGeneratedType,
  shortReferenceId,
  type DocumentRequestRow,
  type DocumentRequestStatus,
  type DocumentSignatureRow,
} from '@/lib/documents/types';
// [TERMINATION-DOCS]
import TerminationDocsTabRow from '@/components/accounting/termination-docs/TerminationDocsTabRow';
import TerminationDocsPanel from '@/components/accounting/termination-docs/TerminationDocsPanel'; // [TERMINATION-DOCS]

type Filter = DocumentRequestStatus | 'all';

const STATUS_STYLE: Record<DocumentRequestStatus, string> = {
  pending: 'border-amber-200 bg-amber-50 text-amber-700 dark:border-amber-500/30 dark:bg-amber-500/10 dark:text-amber-300',
  signed: 'border-emerald-200 bg-emerald-50 text-emerald-700 dark:border-emerald-500/30 dark:bg-emerald-500/10 dark:text-emerald-300',
  rejected: 'border-rose-200 bg-rose-50 text-rose-700 dark:border-rose-500/30 dark:bg-rose-500/10 dark:text-rose-300',
};

/**
 * Accounting → Documents. Three jobs:
 *   1. The signing queue — employee-submitted PDFs (pay stubs, COEs, awards)
 *      that Accounting reviews and either signs (stamping the saved signature +
 *      requested/signed dates into the PDF, returned to the employee) or
 *      rejects with a note.
 *   2. The signature manager — the Accounting Head draws their signature once,
 *      it's saved to Supabase, and the switch revokes it at any time. With the
 *      switch off (or no signature saved) approvals are blocked.
 *   3. The detail modal — the whole paper trail for one request (both PDFs
 *      rendered inline, both timestamps to the minute in Manila, the signer,
 *      the Reference ID, the stored paths). Read-only: it needs `view`, and it
 *      only offers a decision when the caller has `edit`.
 * A "Reports" tab (published pay-cycle reports) lived here until 2026-08-12;
 * that surface was removed along with the publish flow.
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
  const [query, setQuery] = useState('');
  // [TERMINATION-DOCS]
  const [docTab, setDocTab] = useState<'queue' | 'termination'>('queue'); // [TERMINATION-DOCS]

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
  /** Row open in the read-only detail modal. */
  const [viewTarget, setViewTarget] = useState<DocumentRequestRow | null>(null);
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

  // A refresh (or a Realtime nudge) can replace the row the modal is showing,
  // so re-point it at the live copy rather than leaving a stale snapshot open.
  useEffect(() => {
    if (!viewTarget) return;
    const fresh = rows.find((r) => r.id === viewTarget.id);
    if (!fresh) setViewTarget(null);
    else if (fresh !== viewTarget) setViewTarget(fresh);
  }, [rows, viewTarget]);

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
      setViewTarget((v) => (v?.id === row.id ? null : v));
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

  /** Queue health, straight off the loaded rows — no extra fetch. */
  const kpis = useMemo(() => {
    const pending = rows.filter((r) => r.status === 'pending');
    const signed = rows.filter((r) => r.status === 'signed');
    const rejected = rows.filter((r) => r.status === 'rejected');

    const oldestPending = pending.reduce<string | null>(
      (acc, r) => (acc == null || r.requested_at < acc ? r.requested_at : acc),
      null,
    );

    // Turnaround is only meaningful over rows that actually carry both stamps.
    const turnarounds = signed
      .map((r) => {
        if (!r.signed_at) return null;
        const from = new Date(r.requested_at).getTime();
        const to = new Date(r.signed_at).getTime();
        if (Number.isNaN(from) || Number.isNaN(to) || to < from) return null;
        return (to - from) / 3_600_000;
      })
      .filter((h): h is number => h != null);
    const avgHours = turnarounds.length
      ? turnarounds.reduce((a, b) => a + b, 0) / turnarounds.length
      : null;

    const monthStart = new Date();
    monthStart.setDate(1);
    monthStart.setHours(0, 0, 0, 0);
    const signedThisMonth = signed.filter(
      (r) => r.signed_at != null && new Date(r.signed_at) >= monthStart,
    ).length;

    const decided = signed.length + rejected.length;

    return {
      total: rows.length,
      people: new Set(rows.map((r) => r.employee_email.toLowerCase())).size,
      pending: pending.length,
      oldestPending,
      signed: signed.length,
      signedThisMonth,
      rejected: rejected.length,
      rejectedShare: decided ? Math.round((rejected.length / decided) * 100) : null,
      avgHours,
    };
  }, [rows]);

  const visible = useMemo(() => {
    const byStatus = filter === 'all' ? rows : rows.filter((r) => r.status === filter);
    const q = query.trim().toLowerCase();
    if (!q) return byStatus;
    return byStatus.filter((r) =>
      [
        r.employee_name,
        r.employee_email,
        documentTypeLabel(r.document_type),
        r.period_label,
        r.file_name,
        r.signed_by_name,
        r.signed_by,
        r.id,
      ]
        .filter(Boolean)
        .some((v) => String(v).toLowerCase().includes(q)),
    );
  }, [rows, filter, query]);

  const signingBlocked = !signature || !signature.enabled;

  return (
    <div className="flex h-full min-h-0 flex-col overflow-y-auto bg-gradient-to-br from-white via-orange-50/30 to-amber-50/20 p-4 sm:p-6 dark:bg-none dark:bg-[#0d1117]">
      <div className="w-full space-y-5">

        {/* [TERMINATION-DOCS] Inner tabs. The queue body below is HIDDEN, never
            unmounted: the signature-capture Dialog and the four confirm dialogs
            sit past this wrapper's close, and the Termination panel steers the
            rep into that same capture dialog. Unmounting the queue would take
            them with it. The wrapped lines are NOT reindented on purpose —
            reindenting them would replace a 12-line insertion with a 450-line
            diff and destroy the paired-marker delete ranges. */}
        <TerminationDocsTabRow value={docTab} onChange={setDocTab} />
        {/* A plain block div, never display:contents — `contents` defeats
            [hidden] outright, and it would also make the outer space-y-5 space
            THIS wrapper instead of the sections inside it. The inner space-y-5
            reproduces the current spacing exactly. */}
        <div hidden={docTab !== 'queue'} className="space-y-5">{/* [TERMINATION-DOCS] */}
        {/* ── Header ──────────────────────────────────────────────────────── */}
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div className="flex min-w-0 items-start gap-3">
            <div className="flex h-10 w-10 shrink-0 items-center justify-center rounded-xl bg-gradient-to-br from-orange-100 to-amber-100 text-orange-700 ring-1 ring-orange-100 dark:from-orange-950/60 dark:to-amber-950/40 dark:text-orange-300 dark:ring-orange-900/60">
              <FileSignature className="h-5 w-5" />
            </div>
            <div className="min-w-0">
              <p className="text-[11px] font-semibold uppercase tracking-[0.18em] text-orange-700 dark:text-orange-300">
                Signing queue
              </p>
              <h2 className="mt-0.5 text-2xl font-bold tracking-tight text-zinc-900 dark:text-white">
                Documents — Requests &amp; Signatures
              </h2>
              <p className="mt-1 max-w-3xl text-sm leading-relaxed text-zinc-600 dark:text-zinc-400">
                Employee-submitted documents (pay summaries, certificates of engagement, awards)
                awaiting the Accounting Head&rsquo;s signature. Signed copies carry the requested
                and signed dates plus a Reference ID, and are returned to the employee&rsquo;s
                profile.
              </p>
            </div>
          </div>
        </div>

        {/* ── Signature manager ───────────────────────────────────────────── */}
        <section className="rounded-2xl border border-orange-100/80 bg-white/80 p-4 shadow-sm backdrop-blur-sm sm:p-5 dark:border-orange-950/40 dark:bg-zinc-950">
          <div className="flex flex-col gap-4 sm:flex-row sm:items-start sm:justify-between">
            <div className="min-w-0">
              <h3 className="flex items-center gap-1.5 text-sm font-semibold text-zinc-900 dark:text-zinc-100">
                <ShieldCheck className="h-4 w-4 text-orange-500" />
                Your signing signature
              </h3>
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

        {/* ── KPIs ────────────────────────────────────────────────────────── */}
        <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-5">
          <DocStat
            Icon={FileText}
            tone="orange"
            label="Total requests"
            value={loading ? null : kpis.total.toLocaleString('en-US')}
            sub={
              kpis.people === 0
                ? 'no submissions yet'
                : `${kpis.people} employee${kpis.people === 1 ? '' : 's'}`
            }
          />
          <DocStat
            Icon={Clock}
            tone="amber"
            label="Awaiting signature"
            value={loading ? null : kpis.pending.toLocaleString('en-US')}
            sub={
              kpis.pending === 0
                ? 'queue clear'
                : `oldest ${formatRelativeTime(kpis.oldestPending)}`
            }
            emphasize={kpis.pending > 0}
          />
          <DocStat
            Icon={CheckCircle2}
            tone="emerald"
            label="Signed & returned"
            value={loading ? null : kpis.signed.toLocaleString('en-US')}
            sub={`${kpis.signedThisMonth} this month`}
          />
          <DocStat
            Icon={XCircle}
            tone="rose"
            label="Rejected"
            value={loading ? null : kpis.rejected.toLocaleString('en-US')}
            sub={
              kpis.rejectedShare == null
                ? 'nothing decided yet'
                : `${kpis.rejectedShare}% of decisions`
            }
          />
          <DocStat
            Icon={Timer}
            tone="sky"
            label="Avg. turnaround"
            value={
              loading
                ? null
                : kpis.avgHours == null
                  ? '—'
                  : kpis.avgHours < 48
                    ? `${Math.round(kpis.avgHours)}h`
                    : `${(kpis.avgHours / 24).toFixed(1)}d`
            }
            sub="requested → signed"
          />
        </div>

        {/* ── Toolbar ─────────────────────────────────────────────────────── */}
        <div className="flex flex-wrap items-center gap-2">
          <div className="flex flex-wrap items-center gap-1.5">
            {(['pending', 'signed', 'rejected', 'all'] as const).map((f) => (
              <button
                key={f}
                type="button"
                onClick={() => setFilter(f)}
                aria-pressed={filter === f}
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
          <div className="relative min-w-[220px] flex-1">
            <Search className="pointer-events-none absolute left-3 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-zinc-400" />
            <Input
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              placeholder="Search name, email, document, reference..."
              aria-label="Search document requests"
              className="h-9 border-zinc-200 bg-white pl-9 pr-8 text-sm focus:border-orange-500 focus:ring-2 focus:ring-orange-500/20 dark:border-zinc-800 dark:bg-zinc-900/60"
            />
            {query && (
              <button
                type="button"
                onClick={() => setQuery('')}
                aria-label="Clear search"
                className="absolute right-2 top-1/2 -translate-y-1/2 rounded p-0.5 text-zinc-400 hover:bg-zinc-100 hover:text-zinc-600 dark:hover:bg-zinc-800"
              >
                <X className="h-3.5 w-3.5" />
              </button>
            )}
          </div>
          <Button
            type="button"
            variant="outline"
            size="sm"
            onClick={() => void fetchRows()}
            disabled={loading}
            className="h-9 gap-1.5 border-orange-200 text-orange-700 hover:bg-orange-50 dark:border-orange-800 dark:text-orange-300"
          >
            <RefreshCw className={cn('h-3.5 w-3.5', loading && 'animate-spin')} />
            Refresh
          </Button>
        </div>

        {/* ── Requests table ──────────────────────────────────────────────── */}
        <Card className="overflow-hidden border-orange-100/80 py-0 shadow-sm dark:border-orange-950/40">
          <CardHeader className="border-b border-orange-100/80 bg-orange-50/40 px-5 py-3 dark:border-orange-950/40 dark:bg-orange-950/20">
            <CardTitle className="text-sm font-semibold text-zinc-900 dark:text-white">
              {loading
                ? 'Loading…'
                : `${visible.length} request${visible.length === 1 ? '' : 's'}`}
              {!loading && query.trim() && (
                <span className="ml-1.5 font-normal text-orange-900/65 dark:text-orange-200/70">
                  matching &ldquo;{query.trim()}&rdquo;
                </span>
              )}
            </CardTitle>
          </CardHeader>
          <CardContent className="p-0">
            {loading ? (
              <div className="space-y-2 p-5">
                {[1, 2, 3, 4, 5].map((i) => (
                  <div key={i} className="h-10 w-full animate-pulse rounded-lg bg-zinc-100 motion-reduce:animate-none dark:bg-zinc-800" />
                ))}
              </div>
            ) : error ? (
              <div className="flex flex-col items-center gap-2 py-14 text-center text-sm text-rose-600 dark:text-rose-400">
                <AlertTriangle className="h-6 w-6" />
                {error}
              </div>
            ) : visible.length === 0 ? (
              <div className="flex flex-col items-center gap-2 py-16 text-center">
                <Inbox className="h-7 w-7 text-orange-300 dark:text-orange-800" />
                <p className="text-sm text-zinc-500 dark:text-zinc-400">
                  {query.trim()
                    ? 'No requests match your search.'
                    : filter === 'pending'
                      ? 'No documents waiting for a signature.'
                      : 'Nothing here yet.'}
                </p>
                {query.trim() && (
                  <Button type="button" variant="outline" size="sm" onClick={() => setQuery('')} className="h-7 text-xs">
                    Clear search
                  </Button>
                )}
              </div>
            ) : (
              <div className="w-full overflow-x-auto">
                <table className="w-full min-w-[1080px] text-left text-sm">
                  {/* Tiny-caps header (ui-standards § 5.4), tinted into the orange
                      family rather than zinc so it reads as part of the accent wash
                      it sits on instead of washed-out gray. */}
                  <thead className="border-b border-orange-100/80 bg-orange-50/30 text-[10px] font-semibold uppercase tracking-[0.12em] text-orange-900/60 dark:border-orange-950/40 dark:bg-orange-950/10 dark:text-orange-200/65">
                    <tr>
                      <th className="px-4 py-2.5">Employee</th>
                      <th className="px-4 py-2.5">Document</th>
                      <th className="px-4 py-2.5">Reference</th>
                      <th className="px-4 py-2.5">Requested</th>
                      <th className="px-4 py-2.5">Decision</th>
                      <th className="px-4 py-2.5">Status</th>
                      <th className="px-4 py-2.5 text-right">Actions</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-orange-100/70 dark:divide-orange-950/40">
                    {visible.map((r) => {
                      const acting = actingId === r.id;
                      return (
                        <tr
                          key={r.id}
                          className="align-top transition-colors hover:bg-orange-50/40 dark:hover:bg-orange-950/10"
                        >
                          <td className="px-4 py-3">
                            <div className="font-medium text-zinc-900 dark:text-zinc-100">
                              {r.employee_name || r.employee_email}
                            </div>
                            <div className="font-mono text-[11px] text-zinc-400">{r.employee_email}</div>
                          </td>
                          <td className="max-w-[320px] px-4 py-3">
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
                              title="Open the submitted PDF in a new tab"
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
                          <td className="whitespace-nowrap px-4 py-3">
                            <span
                              className="font-mono text-[11.5px] text-zinc-600 dark:text-zinc-300"
                              title={`Reference ID ${r.id}`}
                            >
                              {shortReferenceId(r.id)}
                            </span>
                          </td>
                          <td className="whitespace-nowrap px-4 py-3 text-xs text-zinc-600 dark:text-zinc-300">
                            <div>{formatDocumentDate(r.requested_at)}</div>
                            <div className="text-[11px] text-zinc-400">
                              {formatRelativeTime(r.requested_at)}
                            </div>
                          </td>
                          <td className="px-4 py-3 text-xs text-zinc-600 dark:text-zinc-300">
                            {r.status === 'signed' ? (
                              <>
                                <div className="whitespace-nowrap">{formatDocumentDate(r.signed_at)}</div>
                                <div className="text-[11px] text-zinc-400">
                                  by {r.signed_by_name || r.signed_by}
                                  {elapsedLabel(r.requested_at, r.signed_at)
                                    ? ` · ${elapsedLabel(r.requested_at, r.signed_at)}`
                                    : ''}
                                </div>
                              </>
                            ) : r.status === 'rejected' && r.decision_note ? (
                              <span className="line-clamp-2 max-w-[220px] text-[11.5px] italic text-zinc-400" title={r.decision_note}>
                                &ldquo;{r.decision_note}&rdquo;
                              </span>
                            ) : (
                              <span className="text-zinc-400 dark:text-zinc-600">—</span>
                            )}
                          </td>
                          <td className="px-4 py-3">
                            <span className={cn(
                              'inline-flex items-center gap-1 rounded-full border px-1.5 py-0.5 text-[10px] font-semibold uppercase tracking-[0.12em]',
                              STATUS_STYLE[r.status],
                            )}>
                              {DOCUMENT_STATUS_LABELS[r.status]}
                            </span>
                          </td>
                          <td className="px-4 py-3">
                            <div className="flex items-center justify-end gap-1.5">
                              <Button
                                type="button"
                                variant="outline"
                                size="sm"
                                onClick={() => setViewTarget(r)}
                                className="h-7 gap-1 border-orange-200 text-xs text-orange-700 hover:bg-orange-50 dark:border-orange-900/50 dark:text-orange-300 dark:hover:bg-orange-950/30"
                              >
                                <Eye className="h-3 w-3" />
                                View
                              </Button>
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
          </CardContent>
        </Card>
        </div>{/* [TERMINATION-DOCS] closes the hidden queue wrapper */}
        {docTab === 'termination' && (
          <TerminationDocsPanel
            canEdit={canEdit}
            sessionEmail={sessionEmail}
            signature={signature}
            signatureLoaded={signatureLoaded}
            onSetUpSignature={openSignatureDialog}
          />
        )}{/* [TERMINATION-DOCS] */}
      </div>

      {/* ── Detail modal ──────────────────────────────────────────────────── */}
      <DocumentDetailDialog
        row={viewTarget}
        canEdit={canEdit}
        onClose={() => setViewTarget(null)}
        onSign={(r) => { setViewTarget(null); setSignTarget(r); }}
        onReject={(r) => { setViewTarget(null); setRejectTarget(r); setRejectNote(''); }}
        onDelete={(r) => { setViewTarget(null); setDeleteTarget(r); }}
      />

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
              Draw it, or type your name and pick a style. Either way it is saved once and
              stamped onto every document you approve — with the requested and signed dates so
              the document can be verified. You can revoke it any time with the switch.
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
            <SignaturePad onChange={setSigDraft} defaultName={sigName} />
            {signature && !sigDraft && (
              <p className="text-[11.5px] text-zinc-400">
                Leave this blank to keep your current signature and just update the name/title.
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

// ── KPI card ─────────────────────────────────────────────────────────────────

type StatTone = 'orange' | 'amber' | 'emerald' | 'rose' | 'sky';

/** Stat tile per ui-standards § 6.3 — ring wash + gradient icon tile + sub-line.
 *  Tones follow the house meaning: orange = hero, amber = caution/pending,
 *  emerald = success, rose = problem, sky = neutral info. */
const STAT_PALETTE: Record<StatTone, { ring: string; icon: string; text: string }> = {
  orange: {
    ring: 'from-orange-200/40 to-rose-200/40 dark:from-orange-900/25 dark:to-rose-900/20',
    icon: 'from-orange-500 to-rose-500',
    text: 'text-orange-700 dark:text-orange-300',
  },
  amber: {
    ring: 'from-amber-200/40 to-orange-200/40 dark:from-amber-900/25 dark:to-orange-900/20',
    icon: 'from-amber-500 to-orange-500',
    text: 'text-amber-700 dark:text-amber-300',
  },
  emerald: {
    ring: 'from-emerald-200/40 to-teal-200/40 dark:from-emerald-900/25 dark:to-teal-900/20',
    icon: 'from-emerald-500 to-teal-500',
    text: 'text-emerald-700 dark:text-emerald-300',
  },
  rose: {
    ring: 'from-rose-200/40 to-orange-200/40 dark:from-rose-900/25 dark:to-orange-900/20',
    icon: 'from-rose-500 to-orange-500',
    text: 'text-rose-700 dark:text-rose-300',
  },
  sky: {
    ring: 'from-sky-200/40 to-blue-200/40 dark:from-sky-900/25 dark:to-blue-900/20',
    icon: 'from-sky-500 to-blue-500',
    text: 'text-sky-700 dark:text-sky-300',
  },
};

function DocStat({
  Icon,
  tone,
  label,
  value,
  sub,
  emphasize,
}: {
  Icon: React.ComponentType<{ className?: string }>;
  tone: StatTone;
  label: string;
  /** `null` while the queue is still loading — renders a pulse in place. */
  value: string | null;
  sub: string;
  emphasize?: boolean;
}) {
  const palette = STAT_PALETTE[tone];
  return (
    <div
      className={cn(
        'relative overflow-hidden rounded-xl border bg-white/70 p-3 shadow-sm backdrop-blur-md dark:bg-zinc-900/60',
        emphasize
          ? 'border-amber-300/80 dark:border-amber-700/50'
          : 'border-white/60 dark:border-zinc-800',
      )}
    >
      <div className={cn('absolute inset-0 bg-gradient-to-br opacity-60', palette.ring)} aria-hidden />
      <div className="relative flex items-start justify-between gap-2">
        <div className="min-w-0">
          <div className={cn('text-[9px] font-semibold uppercase tracking-[0.14em]', palette.text)}>
            {label}
          </div>
          {value == null ? (
            <div className="mt-1.5 h-6 w-14 animate-pulse rounded bg-zinc-200/80 motion-reduce:animate-none dark:bg-zinc-700/60" />
          ) : (
            <div className="mt-0.5 font-mono text-xl font-bold tabular-nums tracking-tight text-zinc-900 sm:text-2xl dark:text-zinc-100">
              {value}
            </div>
          )}
          <div className="mt-0.5 truncate text-[10px] text-zinc-500 dark:text-zinc-400" title={sub}>
            {sub}
          </div>
        </div>
        <div
          className={cn(
            'hidden h-8 w-8 shrink-0 items-center justify-center rounded-lg bg-gradient-to-br text-white sm:flex',
            palette.icon,
          )}
        >
          <Icon className="h-4 w-4" />
        </div>
      </div>
    </div>
  );
}

// ── Detail modal ─────────────────────────────────────────────────────────────

type PreviewState =
  | { state: 'idle' }
  | { state: 'loading' }
  | { state: 'ready'; objectUrl: string; signedUrl: string }
  | { state: 'error'; message: string; signedUrl: string | null };

/**
 * Everything known about one request, read-only.
 *
 * Two things it must get right:
 *  - **It shows the signed copy when one exists.** A COE's stored `original.pdf`
 *    is a watermarked UNSIGNED DRAFT and the signed copy is re-rendered from
 *    live data at signing time (docs/features/documents-tab.md), so presenting
 *    the original as "the document that was signed" would be a lie. The signed
 *    copy is the default pane and the original is labelled "As submitted".
 *  - **It never offers a decision without `edit`.** Reads need `view`; signing,
 *    rejecting and deleting need `edit` — the same split the API enforces.
 *
 * The PDF is fetched through the normal 1-hour signed URL and then re-wrapped
 * as a `blob:` URL, because the signed copy's URL carries
 * `Content-Disposition: attachment` and an <iframe> would download it instead
 * of painting it. The raw signed URL is kept for "Open in new tab" / download.
 */
function DocumentDetailDialog({
  row,
  canEdit,
  onClose,
  onSign,
  onReject,
  onDelete,
}: {
  row: DocumentRequestRow | null;
  canEdit: boolean;
  onClose: () => void;
  onSign: (row: DocumentRequestRow) => void;
  onReject: (row: DocumentRequestRow) => void;
  onDelete: (row: DocumentRequestRow) => void;
}) {
  const hasSigned = !!row?.signed_file_path;
  const [pane, setPane] = useState<'original' | 'signed'>('original');
  const [preview, setPreview] = useState<PreviewState>({ state: 'idle' });

  // Opening a row picks the copy that actually represents the outcome.
  const rowId = row?.id ?? null;
  useEffect(() => {
    if (rowId) setPane(hasSigned ? 'signed' : 'original');
  }, [rowId, hasSigned]);

  useEffect(() => {
    if (!rowId) {
      setPreview({ state: 'idle' });
      return;
    }
    let cancelled = false;
    let objectUrl: string | null = null;
    setPreview({ state: 'loading' });

    (async () => {
      let signedUrl: string | null = null;
      try {
        const res = await fetch(`/api/accounting/documents/${rowId}?which=${pane}`, { cache: 'no-store' });
        const json = (await res.json()) as { url?: string; error?: string };
        if (!res.ok || !json.url) throw new Error(json.error || `Could not open the file (${res.status})`);
        signedUrl = json.url;

        const file = await fetch(json.url);
        if (!file.ok) throw new Error(`Storage returned ${file.status}`);
        // Force the PDF type: the signed copy is served as an attachment, and a
        // blob without an explicit type renders as a download prompt.
        const blob = new Blob([await file.arrayBuffer()], { type: 'application/pdf' });
        if (cancelled) return;
        objectUrl = URL.createObjectURL(blob);
        setPreview({ state: 'ready', objectUrl, signedUrl: json.url });
      } catch (e) {
        if (cancelled) return;
        setPreview({
          state: 'error',
          message: e instanceof Error ? e.message : 'Could not load the document',
          signedUrl,
        });
      }
    })();

    return () => {
      cancelled = true;
      if (objectUrl) URL.revokeObjectURL(objectUrl);
    };
  }, [rowId, pane]);

  if (!row) return null;

  const turnaround = elapsedLabel(row.requested_at, row.signed_at);
  const isGenerated = isSystemGeneratedType(row.document_type);
  const openHref = preview.state === 'ready' ? preview.signedUrl : preview.state === 'error' ? preview.signedUrl : null;

  return (
    <Dialog open onOpenChange={(o) => !o && onClose()}>
      <DialogContent
        showCloseButton={false}
        className="flex w-[min(96vw,1180px)] max-w-[min(96vw,1180px)] flex-col gap-0 overflow-hidden rounded-2xl p-0 sm:max-w-[min(96vw,1180px)]"
        style={{ maxHeight: 'min(92vh, 900px)' }}
      >
        {/* Header */}
        <DialogHeader className="shrink-0 flex-row items-start justify-between gap-3 space-y-0 border-b border-orange-100/80 bg-orange-50/40 px-5 py-4 text-left dark:border-orange-950/40 dark:bg-orange-950/20">
          <div className="min-w-0">
            <p className="text-[10px] font-semibold uppercase tracking-[0.18em] text-orange-700 dark:text-orange-300">
              Document request
            </p>
            <DialogTitle className="mt-0.5 truncate text-base font-bold text-zinc-900 dark:text-white">
              {documentTypeLabel(row.document_type)}
              {row.period_label ? ` — ${row.period_label}` : ''}
            </DialogTitle>
            <DialogDescription className="mt-0.5 truncate text-[12px] text-zinc-500 dark:text-zinc-400">
              {row.employee_name || row.employee_email}
              <span className="font-mono"> · {row.employee_email}</span>
            </DialogDescription>
          </div>
          <div className="flex shrink-0 items-center gap-2">
            <span className={cn(
              'inline-flex items-center gap-1 rounded-full border px-2 py-0.5 text-[10px] font-semibold uppercase tracking-[0.12em]',
              STATUS_STYLE[row.status],
            )}>
              {DOCUMENT_STATUS_LABELS[row.status]}
            </span>
            <button
              type="button"
              onClick={onClose}
              aria-label="Close"
              className="rounded-md p-1.5 text-zinc-400 hover:bg-zinc-100 hover:text-zinc-600 dark:hover:bg-zinc-800 dark:hover:text-zinc-300"
            >
              <X className="h-4 w-4" />
            </button>
          </div>
        </DialogHeader>

        {/* Timestamp strip */}
        <div className="grid shrink-0 grid-cols-2 gap-3 border-b border-zinc-100 px-5 py-3 sm:grid-cols-4 dark:border-zinc-800/80">
          <DetailStat label="Requested" value={formatDocumentDateTime(row.requested_at)} sub={formatRelativeTime(row.requested_at)} />
          <DetailStat
            label={row.status === 'rejected' ? 'Rejected' : 'Signed'}
            value={
              row.status === 'signed'
                ? formatDocumentDateTime(row.signed_at)
                : row.status === 'rejected'
                  ? formatDocumentDateTime(row.updated_at)
                  : 'Not yet'
            }
            sub={row.status === 'pending' ? 'awaiting a decision' : 'Manila time'}
            accent={row.status === 'signed'}
          />
          <DetailStat label="Turnaround" value={turnaround ?? '—'} sub="requested → signed" />
          <DetailStat label="Reference ID" value={shortReferenceId(row.id)} sub="printed on the PDF" mono />
        </div>

        {/* Body: viewer + metadata */}
        <div className="flex min-h-0 flex-1 flex-col lg:flex-row">
          {/* Viewer */}
          <div className="flex min-h-[320px] min-w-0 flex-1 flex-col bg-zinc-50/60 dark:bg-[#0a0d12]">
            <div className="flex shrink-0 flex-wrap items-center justify-between gap-2 border-b border-zinc-100 px-4 py-2 dark:border-zinc-800/80">
              <div
                role="tablist"
                aria-label="Which copy to preview"
                className="inline-flex items-center gap-1 rounded-lg border border-zinc-200 bg-white p-1 dark:border-zinc-800 dark:bg-zinc-900/60"
              >
                {hasSigned && (
                  <PaneButton active={pane === 'signed'} onClick={() => setPane('signed')} label="Signed copy" />
                )}
                <PaneButton
                  active={pane === 'original'}
                  onClick={() => setPane('original')}
                  label={isGenerated ? 'Generated draft' : 'As submitted'}
                />
              </div>
              <div className="flex items-center gap-1.5">
                {openHref && (
                  <a
                    href={openHref}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="inline-flex h-7 items-center gap-1 rounded-md border border-zinc-200 px-2 text-[11px] font-medium text-zinc-600 hover:bg-zinc-100 dark:border-zinc-700 dark:text-zinc-300 dark:hover:bg-zinc-800"
                  >
                    <ExternalLink className="h-3 w-3" />
                    Open in new tab
                  </a>
                )}
                {preview.state === 'ready' && (
                  <a
                    href={preview.objectUrl}
                    download={`${pane === 'signed' ? 'signed-' : ''}${documentTypeLabel(row.document_type)
                      .toLowerCase()
                      .replace(/[^a-z0-9]+/g, '-')}.pdf`}
                    className="inline-flex h-7 items-center gap-1 rounded-md border border-orange-200 px-2 text-[11px] font-medium text-orange-700 hover:bg-orange-50 dark:border-orange-900/50 dark:text-orange-300 dark:hover:bg-orange-950/30"
                  >
                    <Download className="h-3 w-3" />
                    Download
                  </a>
                )}
              </div>
            </div>

            {pane === 'original' && isGenerated && (
              <p className="shrink-0 border-b border-amber-200/70 bg-amber-50/70 px-4 py-2 text-[11.5px] leading-relaxed text-amber-900 dark:border-amber-500/30 dark:bg-amber-950/20 dark:text-amber-200">
                <AlertTriangle className="mr-1 inline h-3 w-3 align-[-2px]" />
                This copy is a watermarked <strong>UNSIGNED DRAFT</strong>. The certificate is
                re-rendered from live data when it&rsquo;s signed, so the signed copy — not this
                one — is what the employee can use.
              </p>
            )}

            <div className="min-h-0 flex-1 p-3">
              {preview.state === 'loading' || preview.state === 'idle' ? (
                <div className="flex h-full min-h-[280px] flex-col items-center justify-center gap-2">
                  <Loader2 className="h-4 w-4 animate-spin text-orange-500" />
                  <p className="font-mono text-[10px] uppercase tracking-[0.22em] text-zinc-400">
                    Loading document
                  </p>
                </div>
              ) : preview.state === 'error' ? (
                <div className="flex h-full min-h-[280px] flex-col items-center justify-center gap-3 px-6 text-center">
                  <div className="flex h-12 w-12 items-center justify-center rounded-2xl bg-gradient-to-br from-red-500 to-rose-600 text-white shadow-lg shadow-rose-500/30">
                    <AlertTriangle className="h-6 w-6" />
                  </div>
                  <h4 className="text-sm font-semibold text-zinc-900 dark:text-zinc-100">
                    Couldn&rsquo;t render the PDF here
                  </h4>
                  <p className="max-w-md text-xs text-zinc-500 dark:text-zinc-400">{preview.message}</p>
                  {preview.signedUrl && (
                    <a
                      href={preview.signedUrl}
                      target="_blank"
                      rel="noopener noreferrer"
                      className="inline-flex h-8 items-center gap-1.5 rounded-md bg-orange-500 px-3 text-xs font-semibold text-white hover:bg-orange-600"
                    >
                      <ExternalLink className="h-3.5 w-3.5" />
                      Open it in a new tab instead
                    </a>
                  )}
                </div>
              ) : (
                <iframe
                  key={preview.objectUrl}
                  src={preview.objectUrl}
                  title={`${documentTypeLabel(row.document_type)} — ${pane === 'signed' ? 'signed copy' : 'as submitted'}`}
                  className="h-full min-h-[280px] w-full rounded-lg border border-zinc-200 bg-white dark:border-zinc-800"
                />
              )}
            </div>
          </div>

          {/* Metadata */}
          <aside className="w-full shrink-0 overflow-y-auto border-t border-zinc-100 bg-white px-5 py-4 lg:w-[330px] lg:border-l lg:border-t-0 dark:border-zinc-800/80 dark:bg-zinc-950">
            <MetaSection title="Employee" icon={FileText}>
              <MetaRow label="Name" value={row.employee_name || '—'} />
              <MetaRow label="Work email" value={row.employee_email} mono />
            </MetaSection>

            <MetaSection title="Submission" icon={FileText}>
              <MetaRow label="Type" value={documentTypeLabel(row.document_type)} />
              {row.period_label && <MetaRow label="Period / summary" value={row.period_label} />}
              <MetaRow label="File" value={row.file_name || 'document.pdf'} mono />
              <MetaRow label="Size" value={formatFileSize(row.file_size)} />
              <MetaRow label="Submitted" value={formatDocumentDateTime(row.requested_at)} />
              {row.note && (
                <div className="mt-1.5 rounded-lg border border-zinc-200 bg-zinc-50/70 px-2.5 py-2 dark:border-zinc-800 dark:bg-zinc-900/40">
                  <p className="text-[10px] font-semibold uppercase tracking-[0.12em] text-zinc-400">
                    Employee&rsquo;s note
                  </p>
                  <p className="mt-0.5 text-[12px] italic leading-relaxed text-zinc-700 dark:text-zinc-300">
                    &ldquo;{row.note}&rdquo;
                  </p>
                </div>
              )}
            </MetaSection>

            {row.status === 'signed' && (
              <MetaSection title="Signature" icon={FileSignature}>
                <MetaRow label="Signed by" value={row.signed_by_name || row.signed_by || '—'} />
                {row.signed_by_title && <MetaRow label="Title" value={row.signed_by_title} />}
                {row.signed_by && <MetaRow label="Account" value={row.signed_by} mono />}
                <MetaRow label="Signed on" value={formatDocumentDateTime(row.signed_at)} accent />
                <MetaRow label="Turnaround" value={turnaround ?? '—'} />
              </MetaSection>
            )}

            {row.status === 'rejected' && (
              <MetaSection title="Rejection" icon={XCircle}>
                <MetaRow label="Decided" value={formatDocumentDateTime(row.updated_at)} />
                <div className="mt-1.5 rounded-lg border border-rose-200 bg-rose-50/70 px-2.5 py-2 dark:border-rose-500/30 dark:bg-rose-500/10">
                  <p className="text-[10px] font-semibold uppercase tracking-[0.12em] text-rose-500 dark:text-rose-300">
                    Reason sent to the employee
                  </p>
                  <p className="mt-0.5 text-[12px] italic leading-relaxed text-rose-800 dark:text-rose-200">
                    &ldquo;{row.decision_note || '—'}&rdquo;
                  </p>
                </div>
              </MetaSection>
            )}

            {row.status === 'pending' && (
              <MetaSection title="Decision" icon={Clock}>
                <p className="text-[12px] leading-relaxed text-zinc-500 dark:text-zinc-400">
                  Waiting for a signature since {formatDocumentDateTime(row.requested_at)} (
                  {formatRelativeTime(row.requested_at)}).
                </p>
              </MetaSection>
            )}

            <MetaSection title="Verification" icon={Hash}>
              <MetaRow label="Reference ID" value={row.id} mono />
              <MetaRow label="Original" value={row.file_path} mono wrap />
              <MetaRow label="Signed copy" value={row.signed_file_path || '— not generated —'} mono wrap />
              <MetaRow label="Last updated" value={formatDocumentDateTime(row.updated_at)} />
            </MetaSection>
          </aside>
        </div>

        {/* Footer */}
        <div className="flex shrink-0 flex-wrap items-center justify-between gap-2 border-t border-zinc-100 bg-white px-5 py-3 dark:border-zinc-800/80 dark:bg-zinc-950">
          <p className="text-[11px] text-zinc-400 dark:text-zinc-500">
            {canEdit
              ? 'Links expire after one hour.'
              : 'View-only access — signing and deletion are disabled.'}
          </p>
          <div className="flex flex-wrap items-center gap-1.5">
            <Button type="button" variant="outline" size="sm" onClick={onClose} className="h-8 text-xs">
              Close
            </Button>
            {canEdit && (
              <Button
                type="button"
                variant="ghost"
                size="sm"
                onClick={() => onDelete(row)}
                className="h-8 gap-1 px-2 text-xs text-zinc-600 hover:bg-rose-50 hover:text-rose-700 dark:text-zinc-300 dark:hover:bg-rose-500/10 dark:hover:text-rose-300"
              >
                <Trash2 className="h-3.5 w-3.5" />
                Delete
              </Button>
            )}
            {row.status === 'pending' && canEdit && (
              <>
                <Button
                  type="button"
                  variant="outline"
                  size="sm"
                  onClick={() => onReject(row)}
                  className="h-8 gap-1 border-rose-200 text-xs text-rose-600 hover:bg-rose-50 dark:border-rose-900/50 dark:text-rose-400"
                >
                  <XCircle className="h-3.5 w-3.5" />
                  Reject
                </Button>
                <Button
                  type="button"
                  size="sm"
                  onClick={() => onSign(row)}
                  className="h-8 gap-1 bg-emerald-600 text-xs font-semibold text-white hover:bg-emerald-700"
                >
                  <CheckCircle2 className="h-3.5 w-3.5" />
                  Approve &amp; sign
                </Button>
              </>
            )}
          </div>
        </div>
      </DialogContent>
    </Dialog>
  );
}

function PaneButton({ active, onClick, label }: { active: boolean; onClick: () => void; label: string }) {
  return (
    <button
      type="button"
      role="tab"
      aria-selected={active}
      onClick={onClick}
      className={cn(
        'rounded-md px-2.5 py-1 text-[11.5px] font-medium transition-colors',
        active
          ? 'bg-gradient-to-r from-orange-500 to-amber-500 text-white shadow-sm'
          : 'text-zinc-600 hover:bg-orange-50 hover:text-orange-800 dark:text-zinc-300 dark:hover:bg-orange-950/30 dark:hover:text-orange-200',
      )}
    >
      {label}
    </button>
  );
}

function DetailStat({
  label,
  value,
  sub,
  accent,
  mono,
}: {
  label: string;
  value: string;
  sub: string;
  accent?: boolean;
  mono?: boolean;
}) {
  return (
    <div className="min-w-0">
      <p className="text-[9px] font-semibold uppercase tracking-[0.14em] text-zinc-400 dark:text-zinc-500">
        {label}
      </p>
      <p
        className={cn(
          'mt-0.5 truncate text-[13px] font-semibold',
          mono && 'font-mono',
          accent ? 'text-emerald-700 dark:text-emerald-300' : 'text-zinc-900 dark:text-zinc-100',
        )}
        title={value}
      >
        {value}
      </p>
      <p className="truncate text-[10px] text-zinc-400 dark:text-zinc-500">{sub}</p>
    </div>
  );
}

function MetaSection({
  title,
  icon: Icon,
  children,
}: {
  title: string;
  icon: React.ComponentType<{ className?: string }>;
  children: React.ReactNode;
}) {
  return (
    <section className="mb-4 last:mb-0">
      <div className="mb-1.5 flex items-center gap-2 border-b border-zinc-200/70 pb-1.5 dark:border-zinc-800/70">
        <Icon className="h-3.5 w-3.5 text-zinc-400" aria-hidden />
        <p className="text-[10px] font-semibold uppercase tracking-[0.14em] text-zinc-500 dark:text-zinc-400">
          {title}
        </p>
      </div>
      <div className="space-y-1">{children}</div>
    </section>
  );
}

function MetaRow({
  label,
  value,
  mono,
  wrap,
  accent,
}: {
  label: string;
  value: string;
  mono?: boolean;
  wrap?: boolean;
  accent?: boolean;
}) {
  return (
    <div className="flex items-baseline gap-2">
      <span className="w-[92px] shrink-0 text-[11px] text-zinc-400 dark:text-zinc-500">{label}</span>
      <span
        className={cn(
          'min-w-0 flex-1 text-[12px] text-zinc-800 dark:text-zinc-200',
          mono && 'font-mono text-[11px]',
          wrap ? 'break-all' : 'truncate',
          accent && 'font-semibold text-emerald-700 dark:text-emerald-300',
        )}
        title={value}
      >
        {value}
      </span>
    </div>
  );
}
