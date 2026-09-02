'use client';

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { AnimatePresence, motion } from 'motion/react';
import {
  AlertCircle,
  ArrowLeft,
  ArrowRight,
  CalendarCheck,
  Check,
  ClipboardCheck,
  Clock,
  FileUp,
  Loader2,
  Lock,
  RefreshCw,
  Search,
  Undo2,
  Upload,
  X,
} from 'lucide-react';
import { toast } from 'sonner';
import { cn } from '@/lib/utils';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import InternLockConfirmDialog from './InternLockConfirmDialog';
import { formatInternPHP, type InternHoursByDayEntry, type OrphanageInternHoursUploadRow, type OrphanageInternPayRow } from '@/lib/interns/intern-types';
import type { InternWeekPreview, InternWeekPricedRow } from '@/lib/interns/intern-week-server';

/**
 * The Interns mini Payroll Wizard — Orphanage dashboard → Interns → Pay week.
 *
 * It must READ as the Payroll Wizard, smaller (Kane 2026-09-02): the same step
 * rail (numbered steps, description, status), per-step KPI strip, the data
 * table with a display-only search whose footer stays the period total, "Lock
 * in values" behind the shared confirm-dialog vocabulary, and a replay banner
 * on a locked week — in the Orphanage dashboard's pink. What renders is what
 * matters (same-means-rendered-not-classnames); nothing is extracted OUT of
 * PayrollWizard.tsx.
 *
 * Every number comes from the server (`/pay-weeks/preview`), which runs the ONE
 * pricer. Lock in POSTs the file name only; the route recomputes and refuses on
 * exactly the gates shown here.
 */

type StepId = 1 | 2 | 3 | 4;
const STEPS: Array<{ id: StepId; label: string; icon: typeof Upload; description: string }> = [
  { id: 1, label: 'Week', icon: Upload, description: "Upload the interns' Hubstaff report and pick the week" },
  { id: 2, label: 'Hours & pay', icon: Clock, description: 'Capped hours × the rate in force, per intern' },
  { id: 3, label: 'PAB', icon: CalendarCheck, description: 'Payout week only — ₱1,000 for 5 paid hours every week' },
  { id: 4, label: 'Review & lock in', icon: ClipboardCheck, description: 'Totals, then hand the week to Accounting' },
];

interface DisplayRow {
  key: string;
  name: string;
  email: string;
  refusal: string | null;
  hoursByDay: Record<string, InternHoursByDayEntry>;
  hoursRaw: number;
  hoursPaid: number;
  cappedOff: number;
  ratePhp: number | null;
  mixedRates: boolean;
  payPhp: number;
  pabPhp: number;
  grossPhp: number;
  orphanagePhp: number;
  internPhp: number;
  pab: InternWeekPricedRow['pab'];
}

const round2 = (n: number) => Math.round((n + Number.EPSILON) * 100) / 100;

function fromLive(r: InternWeekPricedRow): DisplayRow {
  return {
    key: r.email,
    name: r.name,
    email: r.email,
    refusal: r.refusal?.reason ?? null,
    hoursByDay: Object.fromEntries(Object.entries(r.hoursByDay).map(([k, v]) => [k, { raw: v.raw, paid: v.paid, rate_php: v.ratePhp }])),
    hoursRaw: r.hoursRaw,
    hoursPaid: r.hoursPaid,
    cappedOff: r.cappedOffHours,
    ratePhp: r.ratePhp,
    mixedRates: r.mixedRates,
    payPhp: r.payPhp,
    pabPhp: r.pabPhp,
    grossPhp: r.grossPhp,
    orphanagePhp: r.orphanageSharePhp,
    internPhp: r.internSharePhp,
    pab: r.pab,
  };
}

function fromStored(r: OrphanageInternPayRow): DisplayRow {
  const rates = new Set(Object.values(r.hours_by_day).filter((d) => d.paid > 0).map((d) => d.rate_php));
  return {
    key: r.intern_email,
    name: r.intern_name,
    email: r.intern_email,
    refusal: null,
    hoursByDay: r.hours_by_day,
    hoursRaw: r.hours_raw,
    hoursPaid: r.hours_paid,
    cappedOff: round2(Math.max(0, Object.values(r.hours_by_day).reduce((s, d) => s + round2(d.raw), 0) - r.hours_paid)),
    ratePhp: r.rate_php,
    mixedRates: rates.size > 1,
    payPhp: r.pay_php,
    pabPhp: r.pab_php,
    grossPhp: r.gross_php,
    orphanagePhp: r.orphanage_share_php,
    internPhp: r.intern_share_php,
    pab: null,
  };
}

function weekLabel(start: string, end: string): string {
  const f = (iso: string) => {
    const [y, m, d] = iso.split('-').map(Number);
    return new Date(y, m - 1, d).toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
  };
  return `${f(start)} – ${f(end)}`;
}
function shortDay(iso: string): string {
  const [y, m, d] = iso.split('-').map(Number);
  return new Date(y, m - 1, d).toLocaleDateString('en-US', { weekday: 'short' });
}
function weekDays(start: string): string[] {
  const [y, m, d] = start.split('-').map(Number);
  return Array.from({ length: 7 }, (_, i) => {
    const x = new Date(y, m - 1, d + i);
    return `${x.getFullYear()}-${String(x.getMonth() + 1).padStart(2, '0')}-${String(x.getDate()).padStart(2, '0')}`;
  });
}
function fmtHours(h: number): string {
  return h.toFixed(2);
}

type Tone = 'pink' | 'emerald' | 'amber' | 'rose' | 'zinc' | 'blue';
const TONE: Record<Tone, string> = {
  pink: 'border-pink-200/80 bg-pink-50/60 text-pink-900 dark:border-pink-900/40 dark:bg-pink-950/20 dark:text-pink-100',
  emerald: 'border-emerald-200/80 bg-emerald-50/60 text-emerald-900 dark:border-emerald-900/40 dark:bg-emerald-950/20 dark:text-emerald-100',
  amber: 'border-amber-300/70 bg-amber-50/60 text-amber-900 dark:border-amber-800/50 dark:bg-amber-950/20 dark:text-amber-100',
  rose: 'border-rose-200/80 bg-rose-50/60 text-rose-900 dark:border-rose-900/40 dark:bg-rose-950/20 dark:text-rose-100',
  zinc: 'border-zinc-200 bg-zinc-50/60 text-zinc-900 dark:border-zinc-800 dark:bg-zinc-900/30 dark:text-zinc-100',
  blue: 'border-sky-200/80 bg-sky-50/60 text-sky-900 dark:border-sky-900/40 dark:bg-sky-950/20 dark:text-sky-100',
};

function KpiCard({ label, value, hint, tone = 'pink' }: { label: string; value: string | number; hint?: string; tone?: Tone }) {
  return (
    <div className={cn('rounded-xl border px-4 py-3', TONE[tone])}>
      <div className="text-[10px] font-semibold uppercase tracking-[0.14em] opacity-70">{label}</div>
      <div className="mt-1 text-xl font-bold tabular-nums leading-none">{value}</div>
      {hint && <div className="mt-1.5 text-[11px] leading-snug opacity-70">{hint}</div>}
    </div>
  );
}

export default function InternsWizard({
  viewerEmail,
  canEdit,
  onGoToProfiles,
}: {
  viewerEmail: string | null;
  canEdit: boolean;
  onGoToProfiles: () => void;
}) {
  const [uploads, setUploads] = useState<OrphanageInternHoursUploadRow[]>([]);
  const [uploadsLoading, setUploadsLoading] = useState(true);
  const [sourceFile, setSourceFile] = useState<string | null>(null);
  const [preview, setPreview] = useState<InternWeekPreview | null>(null);
  const [previewLoading, setPreviewLoading] = useState(false);
  const [previewError, setPreviewError] = useState<string | null>(null);
  const [step, setStep] = useState<StepId>(1);
  const [search, setSearch] = useState('');
  const [uploading, setUploading] = useState(false);
  const [lastUpload, setLastUpload] = useState<{ stored: number; refused: Array<{ email: string | null; name: string | null }>; replaced: boolean; file: string } | null>(null);
  const [confirmOpen, setConfirmOpen] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [withdrawing, setWithdrawing] = useState(false);
  const fileInputRef = useRef<HTMLInputElement | null>(null);

  const loadUploads = useCallback(async (): Promise<OrphanageInternHoursUploadRow[]> => {
    setUploadsLoading(true);
    try {
      const res = await fetch(`/api/orphanage-interns/hours?_=${Date.now()}`, { cache: 'no-store' });
      const json = (await res.json()) as { uploads?: OrphanageInternHoursUploadRow[]; error?: string | null };
      if (!res.ok || json.error) throw new Error(json.error ?? 'Could not load uploads');
      setUploads(json.uploads ?? []);
      return json.uploads ?? [];
    } catch (e) {
      toast.error(e instanceof Error ? e.message : 'Could not load uploads');
      return [];
    } finally {
      setUploadsLoading(false);
    }
  }, []);

  const loadPreview = useCallback(async (file: string) => {
    setPreviewLoading(true);
    setPreviewError(null);
    try {
      const res = await fetch(`/api/orphanage-interns/pay-weeks/preview?source_file=${encodeURIComponent(file)}&_=${Date.now()}`, { cache: 'no-store' });
      const json = (await res.json()) as { preview?: InternWeekPreview | null; error?: string | null };
      if (!res.ok || json.error || !json.preview) throw new Error(json.error ?? 'Could not price this week');
      setPreview(json.preview);
    } catch (e) {
      setPreview(null);
      setPreviewError(e instanceof Error ? e.message : 'Could not price this week');
    } finally {
      setPreviewLoading(false);
    }
  }, []);

  useEffect(() => {
    void (async () => {
      const list = await loadUploads();
      if (list.length > 0 && !sourceFile) setSourceFile(list[0].source_file);
    })();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [loadUploads]);

  useEffect(() => {
    if (sourceFile) void loadPreview(sourceFile);
    else setPreview(null);
  }, [sourceFile, loadPreview]);

  const handleFileChosen = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    e.target.value = '';
    if (!file) return;
    setUploading(true);
    try {
      const form = new FormData();
      form.append('file', file, file.name);
      const res = await fetch('/api/orphanage-interns/hours', { method: 'POST', body: form });
      const json = (await res.json()) as {
        upload?: OrphanageInternHoursUploadRow;
        stored?: number;
        refused?: Array<{ email: string | null; name: string | null }>;
        replaced?: boolean;
        error?: string | null;
      };
      if (!res.ok || json.error || !json.upload) throw new Error(json.error ?? 'Upload failed');
      setLastUpload({ stored: json.stored ?? 0, refused: json.refused ?? [], replaced: !!json.replaced, file: json.upload.source_file });
      toast.success(json.replaced ? 'Report replaced' : 'Report uploaded', {
        description: `${json.stored ?? 0} intern row${json.stored === 1 ? '' : 's'} stored${(json.refused?.length ?? 0) > 0 ? ` · ${json.refused!.length} non-intern row${json.refused!.length === 1 ? '' : 's'} refused` : ''}.`,
      });
      await loadUploads();
      setSourceFile(json.upload.source_file);
      setStep(1);
    } catch (err) {
      toast.error('Upload failed', { description: err instanceof Error ? err.message : 'Upload failed' });
    } finally {
      setUploading(false);
    }
  };

  const status = preview?.existing.status ?? null;
  const replay = status === 'submitted' || status === 'accepted';
  const rows: DisplayRow[] = useMemo(() => {
    if (!preview) return [];
    return replay ? preview.existing.rows.map(fromStored) : preview.rows.map(fromLive);
  }, [preview, replay]);
  const pricedRows = rows.filter((r) => !r.refusal);
  const refusedRows = rows.filter((r) => r.refusal);
  const visibleRows = useMemo(() => {
    const q = search.trim().toLowerCase();
    return q ? rows.filter((r) => r.name.toLowerCase().includes(q) || r.email.toLowerCase().includes(q)) : rows;
  }, [rows, search]);

  const totals = useMemo(() => {
    const sum = (f: (r: DisplayRow) => number) => round2(pricedRows.reduce((s, r) => s + f(r), 0));
    return {
      interns: pricedRows.length,
      hoursPaid: sum((r) => r.hoursPaid),
      cappedOff: sum((r) => r.cappedOff),
      payPhp: sum((r) => r.payPhp),
      pabPhp: sum((r) => r.pabPhp),
      grossPhp: sum((r) => r.grossPhp),
      orphanagePhp: sum((r) => r.orphanagePhp),
      internPhp: sum((r) => r.internPhp),
    };
  }, [pricedRows]);

  const days = preview ? weekDays(preview.weekStart) : [];
  const payoutWeek = preview?.pab.payoutWeek ?? false;
  const visibleSteps = STEPS;
  const canLock = !!preview && canEdit && !replay && preview.blockers.length === 0;

  const lockIn = async () => {
    if (!preview) return;
    setSubmitting(true);
    try {
      const res = await fetch('/api/orphanage-interns/pay-weeks', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ source_file: preview.sourceFile }),
      });
      const json = (await res.json()) as { rows?: unknown[]; error?: string | null; blockers?: string[] };
      if (!res.ok || json.error) throw new Error(json.error ?? 'Lock in failed');
      toast.success('Week locked in', { description: `${json.rows?.length ?? 0} intern${json.rows?.length === 1 ? '' : 's'} sent to Accounting.` });
      setConfirmOpen(false);
      await loadPreview(preview.sourceFile);
    } catch (e) {
      toast.error('Lock in refused', { description: e instanceof Error ? e.message : 'Lock in failed' });
    } finally {
      setSubmitting(false);
    }
  };

  const withdraw = async () => {
    if (!preview) return;
    if (!window.confirm(`Withdraw ${weekLabel(preview.weekStart, preview.weekEnd)} from Accounting? The locked values are removed and you can lock in again.`)) return;
    setWithdrawing(true);
    try {
      const res = await fetch(`/api/orphanage-interns/pay-weeks?source_file=${encodeURIComponent(preview.sourceFile)}&all=1`, { method: 'DELETE' });
      const json = (await res.json()) as { ok?: boolean; error?: string | null };
      if (!res.ok || json.error) throw new Error(json.error ?? 'Withdraw failed');
      toast.success('Week withdrawn');
      await loadPreview(preview.sourceFile);
    } catch (e) {
      toast.error(e instanceof Error ? e.message : 'Withdraw failed');
    } finally {
      setWithdrawing(false);
    }
  };

  const goto = (s: StepId) => setStep(s);
  const next = () => setStep((s) => (Math.min(4, s + 1) as StepId));
  const prev = () => setStep((s) => (Math.max(1, s - 1) as StepId));

  return (
    <div className="flex min-h-0 flex-1 flex-col gap-3 p-6">
      {/* Replay / status banner — the Payroll Wizard's amber "view-only" strip. */}
      {preview && status && (
        <div
          className={cn(
            'flex flex-wrap items-center gap-2 rounded-xl border px-4 py-2.5 text-xs',
            status === 'rejected' ? TONE.rose : status === 'accepted' ? TONE.emerald : TONE.amber,
          )}
        >
          <AlertCircle className="h-4 w-4 shrink-0" />
          <span>
            {status === 'submitted' && (
              <>Showing the values <strong>locked in</strong> {preview.existing.rows[0]?.submitted_at ? `on ${new Date(preview.existing.rows[0].submitted_at).toLocaleString()}` : ''}{preview.existing.rows[0]?.submitted_by ? ` by ${preview.existing.rows[0].submitted_by}` : ''}. Waiting on Accounting — withdraw to edit.</>
            )}
            {status === 'accepted' && (
              <>Showing the values <strong>accepted by Accounting</strong>{preview.existing.rows[0]?.decided_by ? ` (${preview.existing.rows[0].decided_by})` : ''}. Only Accounting can reopen this week.</>
            )}
            {status === 'rejected' && (
              <><strong>Sent back by Accounting</strong>{preview.existing.rows[0]?.decided_by ? ` (${preview.existing.rows[0].decided_by})` : ''}: &ldquo;{preview.existing.rows[0]?.decision_note ?? 'no note'}&rdquo;. Fix what was flagged and lock in again — the live figures below replace the rejected ones.</>
            )}
          </span>
          {status === 'submitted' && canEdit && (
            <Button size="sm" variant="outline" onClick={withdraw} disabled={withdrawing} className="ml-auto h-7 gap-1 text-xs">
              {withdrawing ? <Loader2 className="h-3 w-3 animate-spin" /> : <Undo2 className="h-3 w-3" />} Withdraw
            </Button>
          )}
        </div>
      )}

      <div className="flex min-h-0 flex-1 flex-col gap-3 md:flex-row md:gap-6">
        {/* Step rail — the Payroll Wizard's, in pink. */}
        <div className="flex shrink-0 gap-2 overflow-x-auto pb-1 [-ms-overflow-style:none] [scrollbar-width:none] [&::-webkit-scrollbar]:hidden md:w-60 md:flex-col md:gap-3 md:overflow-visible md:pb-0">
          {visibleSteps.map((s) => {
            const active = step === s.id;
            const done = step > s.id;
            const pabOff = s.id === 3 && preview && !payoutWeek;
            return (
              <div key={s.id} className="relative shrink-0">
                <button
                  type="button"
                  onClick={() => goto(s.id)}
                  className={cn(
                    'relative flex w-full shrink-0 items-center gap-2 rounded-xl border px-2.5 py-2 text-left transition-all duration-300 md:items-start md:gap-3 md:p-3.5',
                    active
                      ? 'border-pink-500/50 bg-pink-500/10 shadow-[0_0_20px_rgba(236,72,153,0.12)]'
                      : done
                        ? 'border-emerald-500/20 bg-emerald-50/80 opacity-70 dark:bg-zinc-900/50'
                        : 'border-zinc-200 bg-zinc-100/80 opacity-60 dark:border-zinc-800 dark:bg-zinc-900/30',
                    pabOff && !active && 'opacity-40',
                  )}
                >
                  <div
                    className={cn(
                      'flex h-6 w-6 shrink-0 items-center justify-center rounded-full transition-colors md:h-8 md:w-8',
                      active ? 'bg-pink-600 text-white' : done ? 'bg-emerald-500 text-white' : 'bg-zinc-300 text-zinc-600 dark:bg-zinc-800 dark:text-zinc-500',
                    )}
                  >
                    {done ? <Check className="h-3 w-3 md:h-4 md:w-4" /> : <s.icon className="h-3 w-3 md:h-4 md:w-4" />}
                  </div>
                  <div className="flex min-w-0 flex-col">
                    <span className={cn('truncate text-[11px] font-bold md:text-sm', active ? 'text-zinc-900 dark:text-white' : 'text-zinc-500 dark:text-zinc-400')}>
                      {s.label}
                    </span>
                    <span className="mt-0.5 hidden truncate text-[10px] leading-tight text-zinc-500 md:block">
                      {pabOff ? 'Not the payout week — nothing to decide' : s.description}
                    </span>
                  </div>
                  {active && (
                    <motion.div
                      layoutId="interns-active-indicator"
                      className="absolute -bottom-1 left-1/2 h-1 w-6 -translate-x-1/2 rounded-full bg-pink-600 md:-left-1 md:bottom-auto md:top-1/2 md:h-8 md:w-2 md:-translate-x-0 md:-translate-y-1/2"
                    />
                  )}
                </button>
                {s.id === 3 && payoutWeek && (
                  <span className="pointer-events-none absolute -right-1 -top-1 flex h-3 w-3" aria-hidden>
                    <span className="absolute inline-flex h-full w-full rounded-full bg-emerald-400 opacity-75 motion-safe:animate-ping" />
                    <span className="relative inline-flex h-3 w-3 rounded-full border border-white bg-emerald-500 dark:border-zinc-950" />
                  </span>
                )}
              </div>
            );
          })}
        </div>

        {/* Main content */}
        <div className="flex min-h-0 flex-1 flex-col overflow-hidden rounded-2xl border border-zinc-200 bg-white/80 dark:border-zinc-800 dark:bg-zinc-900/30">
          <div className="h-1 w-full bg-zinc-100 dark:bg-zinc-800">
            <div className={cn('h-full transition-all duration-500', step === 4 ? 'bg-emerald-500' : 'bg-pink-500')} style={{ width: `${(step / 4) * 100}%` }} />
          </div>
          <div className="flex min-h-0 flex-1 flex-col gap-4 overflow-y-auto p-5">
            <div className="flex items-center gap-2 text-[11px] font-semibold uppercase tracking-[0.16em] text-pink-700 dark:text-pink-300">
              {STEPS[step - 1].label}
              {preview && <span className="text-zinc-400">· {weekLabel(preview.weekStart, preview.weekEnd)}</span>}
            </div>

            {/* ── Step 1 · Week ─────────────────────────────────────────────── */}
            {step === 1 && (
              <>
                <div className="grid gap-4 lg:grid-cols-2">
                  <div className="rounded-2xl border border-pink-100 bg-pink-50/40 p-4 dark:border-pink-900/40 dark:bg-pink-950/10">
                    <div className="flex items-center gap-2 text-sm font-semibold text-zinc-900 dark:text-zinc-100">
                      <FileUp className="h-4 w-4 text-pink-600" /> Interns&apos; weekly Hubstaff report
                    </div>
                    <p className="mt-1 text-[11px] leading-relaxed text-zinc-500 dark:text-zinc-400">
                      Same columns as the Payroll Wizard&apos;s report. The filename must carry the Sunday-to-Saturday week
                      (…<span className="font-mono">_2026-08-30_to_2026-09-05.csv</span>). Any @simple.biz row is refused
                      and listed; re-uploading a week replaces it.
                    </p>
                    <input ref={fileInputRef} type="file" accept=".csv,text/csv" className="hidden" onChange={handleFileChosen} />
                    <Button
                      size="sm"
                      disabled={!canEdit || uploading}
                      onClick={() => fileInputRef.current?.click()}
                      className="mt-3 h-8 gap-1.5 bg-pink-600 text-xs text-white hover:bg-pink-700"
                    >
                      {uploading ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Upload className="h-3.5 w-3.5" />}
                      {uploading ? 'Uploading…' : 'Upload CSV'}
                    </Button>
                    {lastUpload && (
                      <div className={cn('mt-3 rounded-xl border px-3 py-2 text-[11px]', lastUpload.refused.length > 0 ? TONE.amber : TONE.emerald)}>
                        <div className="font-semibold">
                          {lastUpload.replaced ? 'Replaced' : 'Saved'} {lastUpload.file}: {lastUpload.stored} intern row{lastUpload.stored === 1 ? '' : 's'}
                          {lastUpload.refused.length > 0 && ` · ${lastUpload.refused.length} refused`}
                        </div>
                        {lastUpload.refused.length > 0 && (
                          <ul className="mt-1 list-disc pl-4">
                            {lastUpload.refused.map((r, i) => (
                              <li key={i}>
                                <span className="font-mono">{r.email ?? '(no email)'}</span>{r.name ? ` — ${r.name}` : ''} is not an @pathway.ph intern; not stored.
                              </li>
                            ))}
                          </ul>
                        )}
                      </div>
                    )}
                  </div>

                  <div className="rounded-2xl border border-zinc-200 p-4 dark:border-zinc-800">
                    <div className="flex items-center justify-between">
                      <div className="text-sm font-semibold text-zinc-900 dark:text-zinc-100">Uploaded weeks</div>
                      <button type="button" onClick={() => loadUploads()} className="text-zinc-400 hover:text-pink-600" title="Refresh">
                        <RefreshCw className={cn('h-3.5 w-3.5', uploadsLoading && 'animate-spin')} />
                      </button>
                    </div>
                    {uploadsLoading && uploads.length === 0 ? (
                      <div className="flex items-center gap-2 py-6 text-xs text-zinc-500"><Loader2 className="h-4 w-4 animate-spin" /> Loading…</div>
                    ) : uploads.length === 0 ? (
                      <p className="py-6 text-center text-xs text-zinc-500">No intern report uploaded yet.</p>
                    ) : (
                      <ul className="mt-2 max-h-64 divide-y divide-zinc-100 overflow-y-auto rounded-lg border border-zinc-200 text-xs dark:divide-zinc-800 dark:border-zinc-800">
                        {uploads.map((u) => (
                          <li key={u.id}>
                            <button
                              type="button"
                              onClick={() => { setSourceFile(u.source_file); setStep(1); }}
                              className={cn(
                                'flex w-full items-center justify-between gap-2 px-3 py-2 text-left hover:bg-pink-50/60 dark:hover:bg-pink-950/20',
                                sourceFile === u.source_file && 'bg-pink-50 dark:bg-pink-950/30',
                              )}
                            >
                              <span className="min-w-0">
                                <span className="block font-semibold text-zinc-900 dark:text-zinc-100">{weekLabel(u.week_start, u.week_end)}</span>
                                <span className="block truncate font-mono text-[10px] text-zinc-400">{u.source_file}</span>
                              </span>
                              <span className="shrink-0 text-right text-[10px] text-zinc-500">
                                {u.row_count} intern{u.row_count === 1 ? '' : 's'}
                                {u.refused_count > 0 && <span className="block text-amber-600">{u.refused_count} refused</span>}
                              </span>
                            </button>
                          </li>
                        ))}
                      </ul>
                    )}
                  </div>
                </div>

                {previewLoading ? (
                  <div className="flex items-center gap-2 rounded-xl border border-zinc-200 bg-zinc-50/60 px-4 py-6 text-xs text-zinc-500 dark:border-zinc-800 dark:bg-zinc-900/30">
                    <Loader2 className="h-4 w-4 animate-spin text-pink-500" /> Pricing the week…
                  </div>
                ) : previewError ? (
                  <div className={cn('rounded-xl border px-4 py-3 text-xs', TONE.rose)}>{previewError}</div>
                ) : preview ? (
                  <>
                    <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
                      <KpiCard label="Interns with hours" value={preview.rows.filter((r) => r.hasProfile).length} tone="pink" hint={`${preview.rows.filter((r) => !r.refusal).length} priced`} />
                      <KpiCard label="Active, no hours" value={preview.internsWithoutHours.length} tone="zinc" hint={preview.internsWithoutHours.slice(0, 3).map((i) => i.name).join(', ') || 'everyone logged time'} />
                      <KpiCard label="Unknown @pathway.ph" value={preview.unknownEmails.length} tone={preview.unknownEmails.length > 0 ? 'rose' : 'emerald'} hint={preview.unknownEmails.length > 0 ? 'rows with no profile — a lock-in blocker' : 'every row has a profile'} />
                      <KpiCard label="Share mode" value={preview.config.shareMode === 'system_split' ? 'Split' : preview.config.shareMode === 'intern_remits' ? 'Intern remits' : 'Not set'} tone={preview.config.shareMode ? 'emerald' : 'amber'} hint={preview.config.shareMode ? 'set by Accounting' : 'Accounting sets this in Payroll Wizard → Interns → Setup'} />
                    </div>
                    {preview.unknownEmails.length > 0 && (
                      <div className={cn('rounded-xl border px-4 py-3 text-xs', TONE.rose)}>
                        <div className="font-semibold">These @pathway.ph rows have no intern profile</div>
                        <ul className="mt-1 list-disc pl-4">
                          {preview.unknownEmails.map((u) => (
                            <li key={u.email}><span className="font-mono">{u.email}</span>{u.name ? ` — ${u.name}` : ''}</li>
                          ))}
                        </ul>
                        <button type="button" onClick={onGoToProfiles} className="mt-2 font-semibold underline underline-offset-2">Add them in Profiles</button>
                      </div>
                    )}
                  </>
                ) : null}
              </>
            )}

            {/* ── Step 2 · Hours & pay ──────────────────────────────────────── */}
            {step === 2 && preview && (
              <>
                <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
                  <KpiCard label="Interns priced" value={totals.interns} tone="pink" hint={refusedRows.length > 0 ? `${refusedRows.length} could not be priced` : 'every row priced'} />
                  <KpiCard label="Paid hours" value={fmtHours(totals.hoursPaid)} tone="emerald" hint="after the daily and weekly caps" />
                  <KpiCard label="Capped off" value={fmtHours(totals.cappedOff)} tone={totals.cappedOff > 0 ? 'amber' : 'zinc'} hint="logged hours the caps removed — shown, never paid" />
                  <KpiCard label="Pay" value={formatInternPHP(totals.payPhp)} tone="blue" hint="hours × the rate in force each day" />
                </div>
                {refusedRows.length > 0 && (
                  <div className={cn('rounded-xl border px-4 py-3 text-xs', TONE.amber)}>
                    <div className="font-semibold">Not priced</div>
                    <ul className="mt-1 list-disc pl-4">
                      {refusedRows.map((r) => (
                        <li key={r.key}><span className="font-medium">{r.name}</span> — {r.refusal}</li>
                      ))}
                    </ul>
                  </div>
                )}
                <div className="relative w-full sm:w-72">
                  <Search className="pointer-events-none absolute left-2.5 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-zinc-400" />
                  <Input type="search" value={search} onChange={(e) => setSearch(e.target.value)} placeholder="Search intern" className="h-8 pl-8 text-xs" />
                </div>
                <div className="overflow-x-auto rounded-xl border border-zinc-200 dark:border-zinc-800">
                  <table className="w-full min-w-[860px] text-xs">
                    <thead className="bg-zinc-50 text-[10px] uppercase tracking-wider text-zinc-500 dark:bg-zinc-900/60">
                      <tr>
                        <th className="px-3 py-2 text-left">Intern</th>
                        {days.map((d) => <th key={d} className="px-2 py-2 text-right">{shortDay(d)}</th>)}
                        <th className="px-2 py-2 text-right">Paid h</th>
                        <th className="px-2 py-2 text-right">Rate</th>
                        <th className="px-3 py-2 text-right">Pay</th>
                      </tr>
                    </thead>
                    <tbody className="divide-y divide-zinc-100 dark:divide-zinc-800">
                      {visibleRows.map((r) => (
                        <tr key={r.key} className={cn(r.refusal && 'opacity-50')}>
                          <td className="px-3 py-2">
                            <div className="font-semibold text-zinc-900 dark:text-zinc-100">{r.name}</div>
                            <div className="font-mono text-[10px] text-zinc-400">{r.email}</div>
                          </td>
                          {days.map((d) => {
                            const c = r.hoursByDay[d];
                            const capped = c && c.paid < round2(c.raw);
                            return (
                              <td key={d} className={cn('px-2 py-2 text-right font-mono tabular-nums', capped && 'bg-amber-50/70 dark:bg-amber-950/20')}>
                                {!c || (c.raw === 0 && c.paid === 0) ? <span className="text-zinc-300 dark:text-zinc-700">—</span> : (
                                  <>
                                    <span className="font-semibold">{fmtHours(c.paid)}</span>
                                    {capped && <span className="block text-[10px] text-amber-600 dark:text-amber-400">of {fmtHours(c.raw)}</span>}
                                  </>
                                )}
                              </td>
                            );
                          })}
                          <td className="px-2 py-2 text-right font-mono font-semibold tabular-nums">{r.refusal ? '—' : fmtHours(r.hoursPaid)}</td>
                          <td className="px-2 py-2 text-right font-mono tabular-nums">
                            {r.ratePhp == null ? '—' : formatInternPHP(r.ratePhp)}
                            {r.mixedRates && <span className="block text-[10px] text-zinc-400">changed mid-week</span>}
                          </td>
                          <td className="px-3 py-2 text-right font-mono font-semibold tabular-nums">{r.refusal ? '—' : formatInternPHP(r.payPhp)}</td>
                        </tr>
                      ))}
                      {visibleRows.length === 0 && (
                        <tr><td colSpan={days.length + 4} className="px-3 py-6 text-center text-zinc-500">No interns match.</td></tr>
                      )}
                    </tbody>
                    <tfoot className="bg-zinc-50 font-semibold dark:bg-zinc-900/60">
                      <tr>
                        <td className="px-3 py-2">{search.trim() ? 'Period total' : 'Total'} · {totals.interns} intern{totals.interns === 1 ? '' : 's'}</td>
                        <td colSpan={days.length} />
                        <td className="px-2 py-2 text-right font-mono tabular-nums">{fmtHours(totals.hoursPaid)}</td>
                        <td />
                        <td className="px-3 py-2 text-right font-mono tabular-nums">{formatInternPHP(totals.payPhp)}</td>
                      </tr>
                    </tfoot>
                  </table>
                </div>
              </>
            )}

            {/* ── Step 3 · PAB ──────────────────────────────────────────────── */}
            {step === 3 && preview && (
              <>
                {!payoutWeek ? (
                  <div className={cn('rounded-xl border px-4 py-6 text-xs', TONE.zinc)}>
                    <div className="font-semibold">Not the payout week</div>
                    <p className="mt-1 leading-relaxed">
                      Intern PAB (₱1,000 for at least {preview.pab.minWeeklyHours} paid hours every week) is decided on the week that contains the end of
                      the {preview.pab.month} PAB period ({preview.pab.periodEnd}) — the same period Simple uses. This week records ₱0 PAB.
                    </p>
                  </div>
                ) : (
                  <>
                    <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
                      <KpiCard label="Eligible" value={pricedRows.filter((r) => (replay ? r.pabPhp > 0 : r.pab?.verdict.status === 'eligible')).length} tone="emerald" hint={`${preview.pab.minWeeklyHours}+ paid hours every week of ${preview.pab.month}`} />
                      <KpiCard label="Ineligible" value={pricedRows.filter((r) => !replay && r.pab?.verdict.status === 'ineligible').length} tone="rose" hint="one short week loses the month" />
                      <KpiCard label="Weeks missing" value={pricedRows.filter((r) => !replay && r.pab?.verdict.status === 'weeks_missing').length} tone={pricedRows.some((r) => !replay && r.pab?.verdict.status === 'weeks_missing') ? 'amber' : 'zinc'} hint="an earlier week of the period was never locked in — ₱0 until it is" />
                      <KpiCard label="PAB total" value={formatInternPHP(totals.pabPhp)} tone="blue" hint={`period ${preview.pab.periodStart} → ${preview.pab.periodEnd}`} />
                    </div>
                    <div className="overflow-x-auto rounded-xl border border-zinc-200 dark:border-zinc-800">
                      <table className="w-full min-w-[640px] text-xs">
                        <thead className="bg-zinc-50 text-[10px] uppercase tracking-wider text-zinc-500 dark:bg-zinc-900/60">
                          <tr>
                            <th className="px-3 py-2 text-left">Intern</th>
                            <th className="px-3 py-2 text-left">Weeks in the period</th>
                            <th className="px-3 py-2 text-left">Verdict</th>
                            <th className="px-3 py-2 text-right">PAB</th>
                          </tr>
                        </thead>
                        <tbody className="divide-y divide-zinc-100 dark:divide-zinc-800">
                          {pricedRows.map((r) => {
                            const v = r.pab?.verdict;
                            return (
                              <tr key={r.key}>
                                <td className="px-3 py-2 font-semibold text-zinc-900 dark:text-zinc-100">{r.name}</td>
                                <td className="px-3 py-2">
                                  {replay ? (
                                    <span className="text-zinc-500">{r.pabPhp > 0 ? 'qualified at lock-in' : 'did not qualify at lock-in'}</span>
                                  ) : v?.status === 'ineligible' ? (
                                    <span className="text-rose-700 dark:text-rose-300">short: {v.failedWeekStarts.map((w) => weekLabel(w, w).split(' – ')[0]).join(', ')}</span>
                                  ) : v?.status === 'weeks_missing' ? (
                                    <span className="text-amber-700 dark:text-amber-300">not locked: weeks ending {v.missingWeekEnds.join(', ')}</span>
                                  ) : (
                                    <span className="text-emerald-700 dark:text-emerald-300">every week ≥ {preview.pab.minWeeklyHours}h</span>
                                  )}
                                </td>
                                <td className="px-3 py-2">
                                  <span
                                    className={cn(
                                      'rounded-full px-2 py-0.5 text-[10px] font-bold uppercase tracking-wider',
                                      (replay ? r.pabPhp > 0 : v?.status === 'eligible')
                                        ? 'bg-emerald-100 text-emerald-700 dark:bg-emerald-900/30 dark:text-emerald-300'
                                        : v?.status === 'weeks_missing'
                                          ? 'bg-amber-100 text-amber-700 dark:bg-amber-900/30 dark:text-amber-300'
                                          : 'bg-rose-100 text-rose-700 dark:bg-rose-900/30 dark:text-rose-300',
                                    )}
                                  >
                                    {replay ? (r.pabPhp > 0 ? 'Eligible' : 'Ineligible') : v?.status === 'eligible' ? 'Eligible' : v?.status === 'weeks_missing' ? 'Weeks missing' : 'Ineligible'}
                                  </span>
                                </td>
                                <td className="px-3 py-2 text-right font-mono font-semibold tabular-nums">{formatInternPHP(r.pabPhp)}</td>
                              </tr>
                            );
                          })}
                        </tbody>
                      </table>
                    </div>
                  </>
                )}
              </>
            )}

            {/* ── Step 4 · Review & lock in ─────────────────────────────────── */}
            {step === 4 && preview && (
              <>
                <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-5">
                  <KpiCard label="Pay" value={formatInternPHP(totals.payPhp)} tone="pink" hint={`${fmtHours(totals.hoursPaid)} paid hours`} />
                  <KpiCard label="PAB" value={formatInternPHP(totals.pabPhp)} tone={totals.pabPhp > 0 ? 'emerald' : 'zinc'} hint={payoutWeek ? 'payout week' : 'not the payout week'} />
                  <KpiCard label="Gross" value={formatInternPHP(totals.grossPhp)} tone="blue" hint="pay + PAB" />
                  <KpiCard label="To the orphanage" value={formatInternPHP(totals.orphanagePhp)} tone="pink" hint={preview.config.shareMode === 'intern_remits' ? 'remitted by the interns' : preview.config.shareMode === 'system_split' ? 'paid to the orphanage by Accounting' : 'share mode not set'} />
                  <KpiCard label="To the interns" value={formatInternPHP(totals.internPhp)} tone="emerald" hint="the remainder — shares always sum to gross" />
                </div>

                {!replay && preview.blockers.length > 0 && (
                  <div className={cn('rounded-xl border px-4 py-3 text-xs', TONE.rose)}>
                    <div className="flex items-center gap-1.5 font-semibold"><X className="h-3.5 w-3.5" /> Lock in is refused until:</div>
                    <ul className="mt-1 list-disc pl-4">
                      {preview.blockers.map((b) => <li key={b}>{b}</li>)}
                    </ul>
                  </div>
                )}

                <div className="overflow-x-auto rounded-xl border border-zinc-200 dark:border-zinc-800">
                  <table className="w-full min-w-[720px] text-xs">
                    <thead className="bg-zinc-50 text-[10px] uppercase tracking-wider text-zinc-500 dark:bg-zinc-900/60">
                      <tr>
                        <th className="px-3 py-2 text-left">Intern</th>
                        <th className="px-2 py-2 text-right">Paid h</th>
                        <th className="px-2 py-2 text-right">Pay</th>
                        <th className="px-2 py-2 text-right">PAB</th>
                        <th className="px-2 py-2 text-right">Gross</th>
                        <th className="px-2 py-2 text-right">Orphanage</th>
                        <th className="px-3 py-2 text-right">Intern</th>
                      </tr>
                    </thead>
                    <tbody className="divide-y divide-zinc-100 dark:divide-zinc-800">
                      {pricedRows.map((r) => (
                        <tr key={r.key}>
                          <td className="px-3 py-2">
                            <div className="font-semibold text-zinc-900 dark:text-zinc-100">{r.name}</div>
                            <div className="font-mono text-[10px] text-zinc-400">{r.email}</div>
                          </td>
                          <td className="px-2 py-2 text-right font-mono tabular-nums">{fmtHours(r.hoursPaid)}</td>
                          <td className="px-2 py-2 text-right font-mono tabular-nums">{formatInternPHP(r.payPhp)}</td>
                          <td className="px-2 py-2 text-right font-mono tabular-nums">{formatInternPHP(r.pabPhp)}</td>
                          <td className="px-2 py-2 text-right font-mono font-semibold tabular-nums">{formatInternPHP(r.grossPhp)}</td>
                          <td className="px-2 py-2 text-right font-mono tabular-nums">{formatInternPHP(r.orphanagePhp)}</td>
                          <td className="px-3 py-2 text-right font-mono tabular-nums">{formatInternPHP(r.internPhp)}</td>
                        </tr>
                      ))}
                    </tbody>
                    <tfoot className="bg-zinc-50 font-semibold dark:bg-zinc-900/60">
                      <tr>
                        <td className="px-3 py-2">Total · {totals.interns} intern{totals.interns === 1 ? '' : 's'}</td>
                        <td className="px-2 py-2 text-right font-mono tabular-nums">{fmtHours(totals.hoursPaid)}</td>
                        <td className="px-2 py-2 text-right font-mono tabular-nums">{formatInternPHP(totals.payPhp)}</td>
                        <td className="px-2 py-2 text-right font-mono tabular-nums">{formatInternPHP(totals.pabPhp)}</td>
                        <td className="px-2 py-2 text-right font-mono tabular-nums">{formatInternPHP(totals.grossPhp)}</td>
                        <td className="px-2 py-2 text-right font-mono tabular-nums">{formatInternPHP(totals.orphanagePhp)}</td>
                        <td className="px-3 py-2 text-right font-mono tabular-nums">{formatInternPHP(totals.internPhp)}</td>
                      </tr>
                    </tfoot>
                  </table>
                </div>

                <div className="flex flex-wrap items-center justify-end gap-2">
                  {status === 'submitted' && canEdit && (
                    <Button variant="outline" onClick={withdraw} disabled={withdrawing} className="gap-1.5">
                      {withdrawing ? <Loader2 className="h-4 w-4 animate-spin" /> : <Undo2 className="h-4 w-4" />} Withdraw
                    </Button>
                  )}
                  {!replay && (
                    <Button
                      onClick={() => setConfirmOpen(true)}
                      disabled={!canLock || submitting}
                      title={canLock ? undefined : preview.blockers[0] ?? (canEdit ? undefined : 'View-only access')}
                      className="gap-2 bg-pink-600 text-white hover:bg-pink-700"
                    >
                      <Lock className="h-4 w-4" /> Lock in values
                    </Button>
                  )}
                </div>
              </>
            )}

            {step > 1 && !preview && !previewLoading && (
              <div className={cn('rounded-xl border px-4 py-6 text-xs', TONE.zinc)}>Pick or upload a week on step 1 first.</div>
            )}
          </div>

          <div className="flex items-center justify-between border-t border-zinc-200 px-5 py-3 dark:border-zinc-800">
            <Button variant="outline" size="sm" onClick={prev} disabled={step === 1} className="gap-1.5 text-xs">
              <ArrowLeft className="h-3.5 w-3.5" /> Back
            </Button>
            <span className="text-[11px] text-zinc-400">Step {step} of 4{viewerEmail ? '' : ''}</span>
            <Button size="sm" onClick={next} disabled={step === 4 || !preview} className="gap-1.5 bg-pink-600 text-xs text-white hover:bg-pink-700">
              Next <ArrowRight className="h-3.5 w-3.5" />
            </Button>
          </div>
        </div>
      </div>

      <AnimatePresence>
        {preview && (
          <InternLockConfirmDialog
            open={confirmOpen}
            busy={submitting}
            weekLabel={weekLabel(preview.weekStart, preview.weekEnd)}
            internCount={totals.interns}
            totals={totals}
            relock={status === 'rejected'}
            onCancel={() => setConfirmOpen(false)}
            onConfirm={lockIn}
          />
        )}
      </AnimatePresence>
    </div>
  );
}
