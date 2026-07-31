'use client';

import React from 'react';
import {
  AlertTriangle,
  CheckCircle2,
  Clock,
  Download,
  Eye,
  FileCheck2,
  FileSignature,
  FileText,
  Loader2,
  Paperclip,
  Send,
  Trash2,
  Wand2,
  X,
  XCircle,
} from 'lucide-react';
import { toast } from 'sonner';
import { Button } from '@/components/ui/button';
import { SmoothSelect } from '@/components/ui/smooth-select';
import { cn } from '@/lib/utils';
import { generatePayStubsPdf, type PayStubWeek } from '@/lib/payroll/paystub-export';
import {
  DOCUMENT_STATUS_LABELS,
  DOCUMENT_TYPE_LABELS,
  documentTypeLabel,
  formatDocumentDate,
  formatFileSize,
  isSystemGeneratedType,
  type CoePreviewFacts,
  type DocumentRequestRow,
  type DocumentRequestStatus,
  type DocumentRequestType,
} from '@/lib/documents/types';

/** Practical upload cap (Vercel request-body limit is ~4.5 MB; bucket allows 10). */
const MAX_UPLOAD_BYTES = 4 * 1024 * 1024;

const PAYSTUB_PERIODS = [
  { value: '3', label: 'Last 3 months' },
  { value: '6', label: 'Last 6 months' },
  { value: '12', label: 'Last 12 months' },
  { value: 'all', label: 'All weeks on record' },
] as const;

const STATUS_STYLE: Record<DocumentRequestStatus, string> = {
  pending: 'border-amber-200 bg-amber-50 text-amber-700 dark:border-amber-500/30 dark:bg-amber-500/10 dark:text-amber-300',
  signed: 'border-emerald-200 bg-emerald-50 text-emerald-700 dark:border-emerald-500/30 dark:bg-emerald-500/10 dark:text-emerald-300',
  rejected: 'border-rose-200 bg-rose-50 text-rose-700 dark:border-rose-500/30 dark:bg-rose-500/10 dark:text-rose-300',
};

const STATUS_ICON: Record<DocumentRequestStatus, typeof Clock> = {
  pending: Clock,
  signed: CheckCircle2,
  rejected: XCircle,
};

function Section({
  title,
  description,
  children,
}: {
  title: string;
  description?: string;
  children: React.ReactNode;
}) {
  return (
    <section className="rounded-2xl border border-zinc-200/80 bg-white transition-colors duration-200 hover:border-zinc-300/80 dark:border-zinc-800/80 dark:bg-zinc-950/40 dark:hover:border-zinc-700/80">
      <header className="border-b border-zinc-100 px-5 py-4 dark:border-zinc-800/60 sm:px-6">
        <h3 className="text-[14px] font-semibold tracking-[-0.01em] text-zinc-900 dark:text-zinc-100">
          {title}
        </h3>
        {description && (
          <p className="mt-0.5 text-[12.5px] leading-relaxed text-zinc-500 dark:text-zinc-400">
            {description}
          </p>
        )}
      </header>
      <div className="px-5 py-2 sm:px-6">{children}</div>
    </section>
  );
}

/**
 * Profile → Request Documents. The employee attaches a PDF — their Pay Stubs
 * export (auto-generated here from the same statements as the Pay Stubs tab),
 * a COE, or an award — and submits it to Accounting for signing. The request
 * shows in Accounting → Documents; once approved, the signed copy (signature +
 * requested/signed dates stamped in) is downloadable right here.
 */
export default function RequestDocumentsTab({
  employeeEmail,
  employeeName,
  department,
}: {
  employeeEmail: string;
  employeeName: string | null;
  department: string | null;
}) {
  const [docType, setDocType] = React.useState<'' | DocumentRequestType>('');
  const [note, setNote] = React.useState('');
  const [file, setFile] = React.useState<File | null>(null);
  const [periodLabel, setPeriodLabel] = React.useState<string | null>(null);
  const [paystubPeriod, setPaystubPeriod] = React.useState<string>('6');
  const [generating, setGenerating] = React.useState(false);
  const [submitting, setSubmitting] = React.useState(false);
  const fileInputRef = React.useRef<HTMLInputElement>(null);

  const [requests, setRequests] = React.useState<DocumentRequestRow[]>([]);
  const [requestsLoading, setRequestsLoading] = React.useState(true);
  const [cancellingId, setCancellingId] = React.useState<string | null>(null);
  const [downloadingKey, setDownloadingKey] = React.useState<string | null>(null);

  // Certificate of Engagement: the HRIS writes it, so instead of a file input we
  // show what it will say. `coeBlocked` carries the server's reason when the
  // certificate can't honestly be issued (no start date / department / rate).
  const [coeFacts, setCoeFacts] = React.useState<CoePreviewFacts | null>(null);
  const [coeBlocked, setCoeBlocked] = React.useState<string | null>(null);
  const [coeLoading, setCoeLoading] = React.useState(false);

  const generated = isSystemGeneratedType(docType);

  const refreshRequests = React.useCallback(async () => {
    try {
      const res = await fetch('/api/employee/documents', { cache: 'no-store' });
      const json = (await res.json()) as { rows?: DocumentRequestRow[]; error?: string };
      if (!res.ok) throw new Error(json.error || `Request failed (${res.status})`);
      setRequests(json.rows ?? []);
    } catch {
      /* non-fatal — the submit form still renders */
    } finally {
      setRequestsLoading(false);
    }
  }, []);

  React.useEffect(() => {
    void refreshRequests();
  }, [refreshRequests]);

  const clearAttachment = () => {
    setFile(null);
    setPeriodLabel(null);
    if (fileInputRef.current) fileInputRef.current.value = '';
  };

  /** Load the facts the certificate will state, so a wrong start date or a stale
   *  rate is caught here rather than after Accounting signs it. */
  const loadCoePreview = React.useCallback(async () => {
    setCoeLoading(true);
    setCoeFacts(null);
    setCoeBlocked(null);
    try {
      const res = await fetch('/api/employee/documents/coe-preview', { cache: 'no-store' });
      const json = (await res.json()) as {
        facts?: CoePreviewFacts;
        blocked?: string;
        error?: string;
      };
      if (res.status === 422 && json.blocked) {
        setCoeBlocked(json.blocked);
        return;
      }
      if (!res.ok || !json.facts) throw new Error(json.error || 'Could not load your details');
      setCoeFacts(json.facts);
    } catch (e) {
      setCoeBlocked(
        e instanceof Error ? e.message : 'Could not load your details — please try again.',
      );
    } finally {
      setCoeLoading(false);
    }
  }, []);

  const onTypeChange = (v: string) => {
    const next = v as '' | DocumentRequestType;
    setDocType(next);
    clearAttachment();
    setCoeFacts(null);
    setCoeBlocked(null);
    if (isSystemGeneratedType(next)) void loadCoePreview();
  };

  /** Build the same all-weeks Pay Stubs PDF the Pay Stubs tab exports, scoped
   *  to the chosen period, and attach it to this request. */
  const generatePaystubPdf = async () => {
    setGenerating(true);
    try {
      const res = await fetch('/api/employee/paystub?all=1', { cache: 'no-store' });
      const json = (await res.json()) as { stubs?: PayStubWeek[]; error?: string };
      if (!res.ok) throw new Error(json.error || 'Could not load your pay stubs');
      const all = json.stubs ?? [];

      let weeks = all;
      const months = paystubPeriod === 'all' ? null : parseInt(paystubPeriod, 10);
      if (months) {
        const cutoff = new Date();
        cutoff.setMonth(cutoff.getMonth() - months);
        const cutoffIso = `${cutoff.getFullYear()}-${String(cutoff.getMonth() + 1).padStart(2, '0')}-${String(cutoff.getDate()).padStart(2, '0')}`;
        weeks = all.filter((w) => (w.view.weekEnd ?? w.view.weekStart ?? '') >= cutoffIso);
      }
      if (weeks.length === 0) {
        toast.error('No pay-stub weeks found for that period');
        return;
      }

      const bytes = await generatePayStubsPdf(
        weeks,
        { employeeName: employeeName || employeeEmail, department },
        new Date(),
      );
      const ab = new ArrayBuffer(bytes.byteLength);
      new Uint8Array(ab).set(bytes);
      const label = PAYSTUB_PERIODS.find((p) => p.value === paystubPeriod)?.label ?? 'Pay stubs';
      setFile(new File([ab], 'pay-stubs.pdf', { type: 'application/pdf' }));
      setPeriodLabel(`${label} · ${weeks.length} ${weeks.length === 1 ? 'week' : 'weeks'}`);
      toast.success(`Pay Stubs PDF ready (${weeks.length} ${weeks.length === 1 ? 'week' : 'weeks'})`);
    } catch (e) {
      toast.error(e instanceof Error ? e.message : 'Could not generate the PDF');
    } finally {
      setGenerating(false);
    }
  };

  const onPickFile = (e: React.ChangeEvent<HTMLInputElement>) => {
    const f = e.target.files?.[0] ?? null;
    if (!f) return;
    if (f.type !== 'application/pdf' && !f.name.toLowerCase().endsWith('.pdf')) {
      toast.error('Only PDF files can be submitted for signing');
      e.target.value = '';
      return;
    }
    if (f.size > MAX_UPLOAD_BYTES) {
      toast.error('Max 4 MB per PDF — compress the file and try again');
      e.target.value = '';
      return;
    }
    setFile(f);
    setPeriodLabel(null);
  };

  const submit = async () => {
    if (!docType) {
      toast.error('Choose a document type');
      return;
    }
    // Generated types carry no attachment — the server builds the document.
    if (!generated && !file) {
      toast.error(docType === 'paystub' ? 'Generate your Pay Stubs PDF first' : 'Attach the PDF to sign');
      return;
    }
    setSubmitting(true);
    try {
      const form = new FormData();
      if (!generated && file) form.set('file', file, file.name);
      form.set('document_type', docType);
      if (!generated && periodLabel) form.set('period_label', periodLabel);
      if (note.trim()) form.set('note', note.trim());

      const res = await fetch('/api/employee/documents', { method: 'POST', body: form });
      const json = (await res.json()) as {
        row?: DocumentRequestRow;
        blocked?: string;
        error?: string;
      };
      if (res.status === 422 && json.blocked) {
        setCoeBlocked(json.blocked);
        toast.error('Certificate cannot be issued yet', { description: json.blocked });
        return;
      }
      if (!res.ok || json.error) throw new Error(json.error || 'Submit failed');

      toast.success(
        generated ? 'Certificate requested' : 'Request submitted to Accounting',
        {
          description: generated
            ? 'Accounting will review and sign it — you will be notified when it is ready.'
            : 'You will be notified when the signed document is returned.',
        },
      );
      setDocType('');
      setNote('');
      clearAttachment();
      setCoeFacts(null);
      setCoeBlocked(null);
      await refreshRequests();
    } catch (e) {
      toast.error(e instanceof Error ? e.message : 'Could not submit the request');
    } finally {
      setSubmitting(false);
    }
  };

  const cancelRequest = async (row: DocumentRequestRow) => {
    setCancellingId(row.id);
    try {
      const res = await fetch(`/api/employee/documents/${row.id}`, { method: 'DELETE' });
      const json = (await res.json()) as { error?: string };
      if (!res.ok) throw new Error(json.error || 'Cancel failed');
      toast.success('Request cancelled');
      await refreshRequests();
    } catch (e) {
      toast.error(e instanceof Error ? e.message : 'Could not cancel the request');
    } finally {
      setCancellingId(null);
    }
  };

  const download = async (row: DocumentRequestRow, which: 'original' | 'signed') => {
    setDownloadingKey(`${row.id}:${which}`);
    try {
      const res = await fetch(`/api/employee/documents/${row.id}?which=${which}`, { cache: 'no-store' });
      const json = (await res.json()) as { url?: string; error?: string };
      if (!res.ok || !json.url) throw new Error(json.error || 'Could not open the file');
      window.open(json.url, '_blank', 'noopener,noreferrer');
    } catch (e) {
      toast.error(e instanceof Error ? e.message : 'Could not open the file');
    } finally {
      setDownloadingKey(null);
    }
  };

  return (
    <>
      <Section
        title="Request a document"
        description="Get paperwork signed by Accounting for banks, taxes or immigration. A Certificate of Engagement is written for you from your records — nothing to attach. For pay stubs and awards, attach the PDF. The signed copy comes back here with the requested and signed dates stamped in."
      >
        <div className="space-y-5 py-4">
          <label className="block">
            <div className="mb-1.5 flex items-center gap-1.5 text-[12px] font-medium text-zinc-700 dark:text-zinc-200">
              <FileCheck2 className="h-3.5 w-3.5 text-zinc-400" />
              Document type
            </div>
            <SmoothSelect
              aria-label="Document type"
              value={docType}
              onChange={onTypeChange}
              triggerClassName="w-full"
              options={[
                { value: '', label: 'Select a document…' },
                ...Object.entries(DOCUMENT_TYPE_LABELS).map(([value, label]) => ({ value, label })),
              ]}
            />
          </label>

          {docType === 'paystub' && (
            <div className="rounded-xl border border-orange-200/70 bg-orange-50/50 px-4 py-3.5 dark:border-orange-500/25 dark:bg-orange-500/5">
              <div className="flex items-start gap-2.5">
                <Wand2 className="mt-0.5 h-4 w-4 shrink-0 text-orange-500" />
                <div className="min-w-0 flex-1">
                  <p className="text-[12.5px] font-medium text-zinc-800 dark:text-zinc-200">
                    Auto-generate from your pay stubs
                  </p>
                  <p className="mt-0.5 text-[12px] leading-relaxed text-zinc-500 dark:text-zinc-400">
                    Builds the same statement PDF as your Pay Stubs tab, covering the period you
                    pick, and attaches it to this request.
                  </p>
                  <div className="mt-2.5 flex flex-col gap-2 sm:flex-row sm:items-center">
                    <SmoothSelect
                      aria-label="Pay stub period"
                      value={paystubPeriod}
                      onChange={setPaystubPeriod}
                      triggerClassName="w-full sm:w-56"
                      options={PAYSTUB_PERIODS.map((p) => ({ value: p.value, label: p.label }))}
                    />
                    <Button
                      type="button"
                      variant="outline"
                      onClick={() => void generatePaystubPdf()}
                      disabled={generating}
                      className="h-9 gap-1.5 border-orange-300 text-[12.5px] font-semibold text-orange-700 hover:bg-orange-100/60 dark:border-orange-700 dark:text-orange-300"
                    >
                      {generating ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <FileText className="h-3.5 w-3.5" />}
                      {file && periodLabel ? 'Regenerate PDF' : 'Generate & attach PDF'}
                    </Button>
                  </div>
                </div>
              </div>
            </div>
          )}

          {generated && (
            <div className="rounded-xl border border-zinc-200/80 bg-zinc-50/60 px-4 py-3.5 dark:border-zinc-800/80 dark:bg-zinc-900/40">
              {coeLoading ? (
                <div className="flex items-center gap-2 py-2 text-[12.5px] text-zinc-500 dark:text-zinc-400">
                  <Loader2 className="h-3.5 w-3.5 animate-spin" />
                  Loading your details…
                </div>
              ) : coeBlocked ? (
                <div className="flex items-start gap-2.5">
                  <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0 text-amber-500" />
                  <div className="min-w-0 flex-1">
                    <p className="text-[12.5px] font-medium text-zinc-800 dark:text-zinc-200">
                      This certificate can&rsquo;t be issued yet
                    </p>
                    <p className="mt-0.5 text-[12px] leading-relaxed text-zinc-500 dark:text-zinc-400">
                      {coeBlocked}
                    </p>
                  </div>
                </div>
              ) : coeFacts ? (
                <>
                  <div className="flex items-start gap-2.5">
                    <FileCheck2 className="mt-0.5 h-4 w-4 shrink-0 text-emerald-500" />
                    <div className="min-w-0 flex-1">
                      <p className="text-[12.5px] font-medium text-zinc-800 dark:text-zinc-200">
                        Nothing to attach — we generate this for you
                      </p>
                      <p className="mt-0.5 text-[12px] leading-relaxed text-zinc-500 dark:text-zinc-400">
                        Taken from your records. Check it over, then submit — Accounting reviews and
                        signs it.
                      </p>
                    </div>
                  </div>
                  <dl className="mt-3 grid grid-cols-1 gap-x-6 gap-y-2 border-t border-zinc-200/70 pt-3 dark:border-zinc-800/70 sm:grid-cols-[auto_1fr]">
                    {[
                      [
                        'Worker',
                        coeFacts.employeeId
                          ? `${coeFacts.workerName} · ${coeFacts.employeeId}`
                          : coeFacts.workerName,
                      ],
                      ['Engaged since', coeFacts.startDateLabel],
                      ['Team', coeFacts.team],
                      [
                        'Hourly / OT',
                        `${coeFacts.hourlyRate} · ${coeFacts.overtimeRate} per hour`,
                      ],
                      ['Schedule', `${coeFacts.weeklyHours} hours per week`],
                    ].map(([label, value]) => (
                      <React.Fragment key={label}>
                        <dt className="text-[11.5px] font-medium uppercase tracking-wide text-zinc-400 dark:text-zinc-500">
                          {label}
                        </dt>
                        <dd className="mb-1 text-[12.5px] text-zinc-800 dark:text-zinc-200 sm:mb-0">
                          {value}
                        </dd>
                      </React.Fragment>
                    ))}
                    <dt className="text-[11.5px] font-medium uppercase tracking-wide text-zinc-400 dark:text-zinc-500">
                      Bonuses
                    </dt>
                    <dd className="text-[12.5px] leading-relaxed text-zinc-800 dark:text-zinc-200">
                      {coeFacts.standardBonuses.length === 0 &&
                      coeFacts.performanceBonuses.length === 0 ? (
                        <span className="text-zinc-400 dark:text-zinc-500">
                          None you currently qualify for
                        </span>
                      ) : (
                        <>
                          {coeFacts.standardBonuses.map((b) => (
                            <div key={b.label}>
                              {b.label}: {b.amount}
                            </div>
                          ))}
                          <div>
                            Performance:{' '}
                            {coeFacts.performanceBonuses.length > 0 ? (
                              coeFacts.performanceBonuses
                                .map((b) => (b.amount ? `${b.label} (${b.amount})` : b.label))
                                .join(', ')
                            ) : (
                              <span className="text-zinc-400 dark:text-zinc-500">
                                none assigned
                              </span>
                            )}
                          </div>
                        </>
                      )}
                    </dd>
                  </dl>
                  <p className="mt-3 border-t border-zinc-200/70 pt-2.5 text-[11px] leading-relaxed text-zinc-400 dark:border-zinc-800/70 dark:text-zinc-500">
                    Something wrong here? Contact Accounting before submitting — the signed
                    certificate states these figures.
                  </p>
                </>
              ) : null}
            </div>
          )}

          {docType && docType !== 'paystub' && !generated && (
            <label className="block">
              <div className="mb-1.5 flex items-center gap-1.5 text-[12px] font-medium text-zinc-700 dark:text-zinc-200">
                <Paperclip className="h-3.5 w-3.5 text-zinc-400" />
                Attach the PDF to be signed
              </div>
              <input
                ref={fileInputRef}
                type="file"
                accept="application/pdf,.pdf"
                onChange={onPickFile}
                className="block w-full cursor-pointer rounded-lg border border-zinc-200 bg-white text-[12.5px] text-zinc-600 file:mr-3 file:cursor-pointer file:rounded-l-lg file:border-0 file:bg-zinc-100 file:px-3.5 file:py-2.5 file:text-[12px] file:font-semibold file:text-zinc-700 hover:file:bg-zinc-200 dark:border-zinc-800 dark:bg-zinc-950/60 dark:text-zinc-300 dark:file:bg-zinc-800 dark:file:text-zinc-200"
              />
              <p className="mt-1 text-[11px] text-zinc-400 dark:text-zinc-500">PDF only, up to 4 MB.</p>
            </label>
          )}

          {file && (
            <div className="flex items-center gap-2.5 rounded-xl border border-emerald-200 bg-emerald-50/70 px-3.5 py-2.5 dark:border-emerald-500/30 dark:bg-emerald-500/10">
              <FileText className="h-4 w-4 shrink-0 text-emerald-600 dark:text-emerald-400" />
              <div className="min-w-0 flex-1 text-[12.5px]">
                <span className="font-medium text-emerald-900 dark:text-emerald-200">{file.name}</span>
                <span className="ml-1.5 text-emerald-700/70 dark:text-emerald-300/60">
                  {formatFileSize(file.size)}
                  {periodLabel ? ` · ${periodLabel}` : ''}
                </span>
              </div>
              <button
                type="button"
                onClick={clearAttachment}
                aria-label="Remove attachment"
                className="shrink-0 rounded-md p-1 text-emerald-700/60 transition-colors hover:bg-emerald-100 hover:text-emerald-800 dark:text-emerald-300/60 dark:hover:bg-emerald-500/20"
              >
                <X className="h-3.5 w-3.5" />
              </button>
            </div>
          )}

          <label className="block">
            <div className="mb-1.5 text-[12px] font-medium text-zinc-700 dark:text-zinc-200">
              Additional details{' '}
              <span className="font-normal text-zinc-400 dark:text-zinc-500">(optional)</span>
            </div>
            <textarea
              value={note}
              onChange={(e) => setNote(e.target.value)}
              rows={3}
              maxLength={2000}
              placeholder="e.g. the purpose of the document (bank loan, visa application) or anything Accounting should know."
              className="w-full resize-y rounded-lg border border-zinc-200 bg-white px-3 py-2 text-[13.5px] leading-relaxed text-zinc-900 placeholder:text-zinc-400 transition-colors focus:border-orange-300 focus:outline-none focus:ring-1 focus:ring-orange-200 dark:border-zinc-800 dark:bg-zinc-950/60 dark:text-zinc-100 dark:focus:border-orange-500/40 dark:focus:ring-orange-500/20"
            />
          </label>

          <div className="flex flex-col items-start gap-2 sm:flex-row sm:items-center sm:justify-between">
            <p className="text-[11.5px] text-zinc-400 dark:text-zinc-600">
              Goes to Accounting for review — you&rsquo;ll get a notification when it&rsquo;s signed.
            </p>
            <Button
              type="button"
              onClick={() => void submit()}
              disabled={
                submitting ||
                !docType ||
                (generated ? coeLoading || !!coeBlocked || !coeFacts : !file)
              }
              className="h-11 w-full gap-2 rounded-xl bg-orange-500 text-sm font-semibold text-white shadow-sm shadow-orange-500/20 transition-colors hover:bg-orange-600 disabled:opacity-50 dark:bg-orange-500 dark:hover:bg-orange-400 sm:w-auto"
            >
              {submitting ? <Loader2 className="h-4 w-4 animate-spin" /> : <Send className="h-4 w-4" />}
              {generated ? 'Request certificate' : 'Submit request'}
            </Button>
          </div>
        </div>
      </Section>

      <div className="mt-4">
        <Section
          title="My document requests"
          description="Everything you've submitted, with the signed copies once Accounting approves."
        >
          {requestsLoading ? (
            <div className="flex items-center justify-center gap-2 py-10 text-sm text-zinc-400">
              <Loader2 className="h-4 w-4 animate-spin" />
              Loading your requests…
            </div>
          ) : requests.length === 0 ? (
            <div className="flex flex-col items-center gap-2 py-10 text-center">
              <FileSignature className="h-7 w-7 text-zinc-300 dark:text-zinc-700" />
              <p className="text-sm text-zinc-500 dark:text-zinc-400">No document requests yet.</p>
              <p className="max-w-xs text-xs text-zinc-400 dark:text-zinc-600">
                Submit one above — signed documents come back here with an official certification page.
              </p>
            </div>
          ) : (
            <ul className="divide-y divide-zinc-100 dark:divide-zinc-800/60">
              {requests.map((r) => {
                const Icon = STATUS_ICON[r.status];
                return (
                  <li key={r.id} className="flex flex-col gap-2 py-3.5 sm:flex-row sm:items-start sm:justify-between">
                    <div className="min-w-0">
                      <div className="flex flex-wrap items-center gap-2">
                        <span className="text-[13.5px] font-medium text-zinc-900 dark:text-zinc-100">
                          {documentTypeLabel(r.document_type)}
                        </span>
                        {r.period_label && (
                          <span className="rounded bg-zinc-100 px-1.5 py-0.5 text-[10.5px] font-medium text-zinc-500 dark:bg-zinc-800 dark:text-zinc-400">
                            {r.period_label}
                          </span>
                        )}
                        <span className={cn(
                          'inline-flex items-center gap-1 rounded-full border px-2 py-0.5 text-[10.5px] font-semibold uppercase tracking-wide',
                          STATUS_STYLE[r.status],
                        )}>
                          <Icon className="h-3 w-3" />
                          {DOCUMENT_STATUS_LABELS[r.status]}
                        </span>
                      </div>
                      <p className="mt-1 text-[11.5px] text-zinc-400 dark:text-zinc-500">
                        Requested {formatDocumentDate(r.requested_at)}
                        {r.status === 'signed' && r.signed_at && (
                          <> · Signed {formatDocumentDate(r.signed_at)}{r.signed_by_name ? ` by ${r.signed_by_name}` : ''}</>
                        )}
                      </p>
                      {r.status === 'rejected' && r.decision_note && (
                        <p className="mt-1 flex items-start gap-1 text-[12px] text-rose-600 dark:text-rose-400">
                          <AlertTriangle className="mt-0.5 h-3 w-3 shrink-0" />
                          {r.decision_note}
                        </p>
                      )}
                    </div>
                    <div className="flex shrink-0 flex-wrap items-center gap-1.5">
                      {r.status === 'signed' && (
                        <Button
                          type="button"
                          size="sm"
                          onClick={() => void download(r, 'signed')}
                          disabled={downloadingKey === `${r.id}:signed`}
                          className="h-8 gap-1.5 bg-emerald-600 text-xs font-semibold text-white hover:bg-emerald-700"
                        >
                          {downloadingKey === `${r.id}:signed`
                            ? <Loader2 className="h-3.5 w-3.5 animate-spin" />
                            : <Download className="h-3.5 w-3.5" />}
                          Signed document
                        </Button>
                      )}
                      <Button
                        type="button"
                        variant="outline"
                        size="sm"
                        onClick={() => void download(r, 'original')}
                        disabled={downloadingKey === `${r.id}:original`}
                        className="h-8 gap-1.5 text-xs"
                      >
                        {downloadingKey === `${r.id}:original`
                          ? <Loader2 className="h-3.5 w-3.5 animate-spin" />
                          : <Eye className="h-3.5 w-3.5" />}
                        {isSystemGeneratedType(r.document_type)
                          ? (r.status === 'signed' ? 'Unsigned draft' : 'Preview draft')
                          : 'Submitted file'}
                      </Button>
                      {r.status === 'pending' && (
                        <Button
                          type="button"
                          variant="outline"
                          size="sm"
                          onClick={() => void cancelRequest(r)}
                          disabled={cancellingId === r.id}
                          className="h-8 gap-1.5 border-rose-200 text-xs text-rose-600 hover:bg-rose-50 dark:border-rose-900/50 dark:text-rose-400"
                        >
                          {cancellingId === r.id
                            ? <Loader2 className="h-3.5 w-3.5 animate-spin" />
                            : <Trash2 className="h-3.5 w-3.5" />}
                          Cancel
                        </Button>
                      )}
                    </div>
                  </li>
                );
              })}
            </ul>
          )}
        </Section>
      </div>
    </>
  );
}
