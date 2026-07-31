'use client';

import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  HeartHandshake,
  CheckCircle2,
  XCircle,
  Clock,
  RefreshCw,
  Search,
  Inbox,
  ChevronLeft,
  ChevronRight,
  Filter,
  X,
  Undo2,
  Trash2,
  ClipboardList,
  Wallet,
  PiggyBank,
  Building2,
  Eye,
  CalendarClock,
  ArrowDownCircle,
  ArrowUpCircle,
  Users,
  UserPlus,
  UserMinus,
  StickyNote,
  Download,
  ChevronDown,
  FileText,
  FileSpreadsheet,
  Table2,
  Loader2,
  AlertTriangle,
  ReceiptText,
  ExternalLink,
  ImageIcon,
  FileWarning,
  Maximize2,
} from 'lucide-react';
import { createPortal } from 'react-dom';
import { AnimatePresence, motion, useReducedMotion } from 'motion/react';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { SmoothSelect } from '@/components/ui/smooth-select';
import { cn } from '@/lib/utils';
import { DatePicker, toIso } from '@/components/ui/date-picker';
import { parseDateOnlyLocal } from '@/lib/date-only';
import { toast } from 'sonner';
import { clearTabCache, getTabCache, hasTabCache, setTabCache, TAB_CACHE_KEYS } from '@/lib/accounting/tab-cache';
import {
  downloadMesaCsv,
  downloadMesaPdf,
  downloadMesaXlsx,
  type MesaExportSpec,
} from '@/lib/accounting/mesa-export';
import { fetchRosterEmailSet, isOnRoster } from '@/lib/roster/roster-emails';
import type { MesaLedgerEvent, MesaMemberSummary } from '@/lib/mesa/ledger';
import {
  formatReceiptSize,
  isMesaReceiptImage,
  mesaReceiptDownloadUrl,
  MAX_MESA_RECEIPTS,
  type MesaReceiptWithUrl,
} from '@/lib/mesa/receipt-types';
import type { EmployeeRow } from '@/lib/supabase/employees';
import type { EmployeeHourlyRateRow } from '@/lib/supabase/employee-hourly-rates';

type MesaView = 'requests' | 'non-members' | 'active-members';

/** Peso, two decimals — follows the app-wide money convention. */
const formatPHP = (n: number) =>
  `₱${n.toLocaleString('en-PH', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;

/** A bare DATE column ("2026-08-05") as "Aug 5, 2026" — parsed LOCAL, since
 *  `new Date(iso)` reads a date-only string as UTC and renders a day early
 *  west of UTC. */
const formatDateOnly = (d: string | null | undefined) =>
  d
    ? (parseDateOnlyLocal(d) ?? new Date(d)).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' })
    : '—';

export type MesaRequestType = 'opt_in' | 'opt_out' | 'disbursement' | 'return';
export type MesaRequestStatus = 'pending' | 'approved' | 'denied';

interface MesaRequest {
  id: string;
  work_email: string;
  full_name: string;
  department: string;
  request_type: MesaRequestType;
  fpu_date: string | null;
  /** Opt-out only: the day the member's participation ends. */
  effective_date: string | null;
  disbursement_reason: string | null;
  explanation: string | null;
  amount_needed: number | null;
  status: MesaRequestStatus;
  review_notes: string | null;
  reviewed_by: string | null;
  reviewed_at: string | null;
  dispatched_at: string | null;
  created_at: string;
  /** Disbursement only: attached receipt files (0–3), derived on read from
   *  mesa_request_receipts. This is the "was this legitimate" signal — a member
   *  substantiating their claim, visible before the row is even opened. */
  receipt_count?: number;
  /** Newest receipt's upload time. The program requires receipts within 14 days,
   *  so this — not created_at — is what that rule is measured against. */
  receipt_last_uploaded_at?: string | null;
}

interface MesaNote {
  id: string;
  member_email: string;
  body: string;
  author_email: string;
  author_name: string | null;
  created_at: string;
}

const PAGE_SIZE = 15;

const TYPE_LABELS: Record<MesaRequestType, string> = {
  opt_in: 'Opt-in',
  opt_out: 'Opt-out',
  disbursement: 'Disbursement',
  return: 'Return',
};

const TYPE_COLORS: Record<MesaRequestType, string> = {
  opt_in: 'border-teal-200 bg-teal-50 text-teal-700 dark:border-teal-500/40 dark:bg-teal-500/15 dark:text-teal-200',
  opt_out: 'border-zinc-200 bg-zinc-50 text-zinc-700 dark:border-zinc-600 dark:bg-zinc-800/50 dark:text-zinc-300',
  disbursement: 'border-amber-200 bg-amber-50 text-amber-700 dark:border-amber-500/40 dark:bg-amber-500/15 dark:text-amber-200',
  return: 'border-violet-200 bg-violet-50 text-violet-700 dark:border-violet-500/40 dark:bg-violet-500/15 dark:text-violet-200',
};

// ── Bulk row selection ───────────────────────────────────────────────────────

/** Checkbox multi-select over a list of rows keyed by a stable string.
 *  `rows` should be the *filtered* set, so select-all covers everything the
 *  user can currently see (across pages) and `selectedRows` never includes a
 *  row hidden by the active search/filter. */
function useRowSelection<T>(rows: T[], keyOf: (t: T) => string) {
  const [selectedKeys, setSelectedKeys] = useState<Set<string>>(new Set());
  const keys = rows.map(keyOf);
  const allSelected = keys.length > 0 && keys.every((k) => selectedKeys.has(k));
  const someSelected = keys.some((k) => selectedKeys.has(k));
  const toggle = (k: string) =>
    setSelectedKeys((prev) => {
      const next = new Set(prev);
      if (next.has(k)) next.delete(k);
      else next.add(k);
      return next;
    });
  const toggleAll = () =>
    setSelectedKeys((prev) => {
      const next = new Set(prev);
      if (keys.every((k) => next.has(k))) keys.forEach((k) => next.delete(k));
      else keys.forEach((k) => next.add(k));
      return next;
    });
  const clear = () => setSelectedKeys(new Set());
  const selectedRows = rows.filter((r) => selectedKeys.has(keyOf(r)));
  return { selectedKeys, selectedRows, allSelected, someSelected, toggle, toggleAll, clear };
}

function SelectCheckbox({
  checked,
  indeterminate,
  onChange,
  ariaLabel,
}: {
  checked: boolean;
  indeterminate?: boolean;
  onChange: () => void;
  ariaLabel: string;
}) {
  const ref = useRef<HTMLInputElement>(null);
  useEffect(() => {
    if (ref.current) ref.current.indeterminate = !!indeterminate && !checked;
  }, [indeterminate, checked]);
  return (
    <input
      ref={ref}
      type="checkbox"
      checked={checked}
      onChange={onChange}
      aria-label={ariaLabel}
      onClick={(e) => e.stopPropagation()}
      className="h-3.5 w-3.5 cursor-pointer rounded border-zinc-300 accent-teal-600 dark:border-zinc-600"
    />
  );
}

/** Sticky bar shown above a table when ≥1 row is selected. */
function BulkBar({ count, children, onClear }: { count: number; children: React.ReactNode; onClear: () => void }) {
  return (
    <div className="flex flex-wrap items-center justify-between gap-2 border-b border-teal-100/80 bg-teal-50/70 px-4 py-2 dark:border-teal-900/40 dark:bg-teal-950/40">
      <span className="text-xs font-semibold text-zinc-700 dark:text-zinc-200">{count} selected</span>
      <div className="flex flex-wrap items-center gap-1.5">
        {children}
        <Button type="button" size="sm" variant="ghost" onClick={onClear} className="h-7 text-[11px] text-zinc-500 hover:text-zinc-700 dark:text-zinc-400">
          Clear
        </Button>
      </div>
    </div>
  );
}

/** Run an async op over each item sequentially, tallying success/failure. */
async function runBulk<T>(items: T[], fn: (item: T) => Promise<void>): Promise<{ ok: number; fail: number }> {
  let ok = 0;
  let fail = 0;
  for (const item of items) {
    try {
      await fn(item);
      ok += 1;
    } catch {
      fail += 1;
    }
  }
  return { ok, fail };
}

/** Summarize a bulk run as a toast. */
function reportBulk(verb: string, ok: number, fail: number) {
  if (ok && !fail) toast.success(`${verb} ${ok}`);
  else if (ok && fail) toast.warning(`${verb} ${ok}, ${fail} failed`);
  else toast.error(`Nothing ${verb.toLowerCase()} — ${fail} failed`);
}

/** POST the enrollment flip for one roster row. Throws on non-OK. */
async function postToggleMesa(row: MesaRosterRow, mesaMember: boolean): Promise<void> {
  const res = await fetch('/api/toggle-mesa-member', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      workEmail: row.workEmail ?? undefined,
      personalEmail: row.workEmail ? undefined : row.personalEmail ?? undefined,
      mesaMember,
      name: row.name,
    }),
  });
  if (!res.ok) {
    const j = (await res.json().catch(() => ({}))) as { error?: string };
    throw new Error(j.error ?? `HTTP ${res.status}`);
  }
}

// ── Export menu (PDF · XLSX · CSV — themed like the CEO dashboard) ──────────
//
// Same interaction + look as the HR Global Master List's ExportMenu: an
// outline trigger opening a small menu whose icons carry the CEO dashboard's
// orange→rose gradient. Each tab builds its own MesaExportSpec (columns, stat
// band, scope label) over its *filtered* rows, so what you see is what exports.

/** 'PHP 1,234.56' — exports spell out the currency code because the ₱ glyph
 *  isn't in the PDF's WinAnsi Helvetica encoding. */
const formatPhpExport = (n: number) =>
  `PHP ${n.toLocaleString('en-PH', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;

const EXPORT_EASE = [0.22, 1, 0.36, 1] as const;

type ExportFormat = 'pdf' | 'xlsx' | 'csv';

function MesaExportMenu({ spec }: { spec: MesaExportSpec }) {
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState<ExportFormat | null>(null);
  const wrapRef = useRef<HTMLDivElement>(null);
  const reduce = useReducedMotion();

  // Close on outside click / Escape.
  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => {
      if (wrapRef.current && !wrapRef.current.contains(e.target as Node)) setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setOpen(false);
    };
    document.addEventListener('mousedown', onDown);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('mousedown', onDown);
      document.removeEventListener('keydown', onKey);
    };
  }, [open]);

  const noun = spec.rows.length === 1 ? spec.countNoun[0] : spec.countNoun[1];

  const runExport = useCallback(
    async (format: ExportFormat) => {
      if (spec.rows.length === 0) {
        toast.error('Nothing to export in this view.');
        return;
      }
      setBusy(format);
      setOpen(false);
      try {
        if (format === 'csv') {
          downloadMesaCsv(spec);
        } else if (format === 'xlsx') {
          downloadMesaXlsx(spec);
        } else {
          await downloadMesaPdf(spec);
        }
        const n = spec.rows.length;
        toast.success(`Exported ${n.toLocaleString()} ${n === 1 ? spec.countNoun[0] : spec.countNoun[1]} as ${format.toUpperCase()}.`);
      } catch (e) {
        toast.error(e instanceof Error ? e.message : `Failed to export ${format.toUpperCase()}`);
      } finally {
        setBusy(null);
      }
    },
    [spec],
  );

  const items: { format: ExportFormat; label: string; hint: string; Icon: typeof FileText }[] = [
    { format: 'pdf', label: 'PDF', hint: 'Branded document', Icon: FileText },
    { format: 'xlsx', label: 'Excel', hint: 'XLSX workbook', Icon: FileSpreadsheet },
    { format: 'csv', label: 'CSV', hint: 'Plain data', Icon: Table2 },
  ];

  return (
    <div ref={wrapRef} className="relative">
      <Button
        type="button"
        variant="outline"
        size="sm"
        onClick={() => setOpen((o) => !o)}
        disabled={busy !== null}
        aria-haspopup="menu"
        aria-expanded={open}
        className="gap-1.5"
      >
        {busy ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Download className="h-3.5 w-3.5" />}
        {busy ? `Exporting ${busy.toUpperCase()}…` : 'Export'}
        <ChevronDown className={cn('h-3.5 w-3.5 transition-transform', open && 'rotate-180')} aria-hidden />
      </Button>

      <AnimatePresence>
        {open && (
          <motion.div
            role="menu"
            initial={reduce ? { opacity: 0 } : { opacity: 0, y: -6, scale: 0.98 }}
            animate={{ opacity: 1, y: 0, scale: 1 }}
            exit={reduce ? { opacity: 0 } : { opacity: 0, y: -6, scale: 0.98 }}
            transition={{ duration: 0.15, ease: EXPORT_EASE }}
            className="absolute right-0 z-30 mt-2 w-56 overflow-hidden rounded-xl border border-zinc-200 bg-white p-1 shadow-xl shadow-zinc-900/10 dark:border-zinc-700 dark:bg-zinc-900"
          >
            <p className="px-2.5 pb-1 pt-1.5 text-[10px] font-semibold uppercase tracking-[0.14em] text-zinc-400 dark:text-zinc-500">
              Export {spec.rows.length.toLocaleString()} {noun}
            </p>
            {items.map(({ format, label, hint, Icon }) => (
              <button
                key={format}
                type="button"
                role="menuitem"
                onClick={() => void runExport(format)}
                className="flex w-full items-center gap-2.5 rounded-lg px-2.5 py-2 text-left transition-colors hover:bg-amber-50 dark:hover:bg-amber-950/30"
              >
                <span className="flex h-8 w-8 shrink-0 items-center justify-center rounded-lg bg-gradient-to-br from-orange-500 to-rose-500 text-white shadow-sm">
                  <Icon className="h-4 w-4" aria-hidden />
                </span>
                <span className="min-w-0">
                  <span className="block text-sm font-medium text-zinc-900 dark:text-zinc-100">{label}</span>
                  <span className="block text-[11px] text-zinc-500 dark:text-zinc-400">{hint}</span>
                </span>
              </button>
            ))}
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  );
}

export default function AccountingMesa() {
  const [view, setView] = useState<MesaView>('requests');
  const [rows, setRows] = useState<MesaRequest[]>(
    () => getTabCache<MesaRequest[]>(TAB_CACHE_KEYS.mesaRequests) ?? [],
  );
  const [loading, setLoading] = useState(!hasTabCache(TAB_CACHE_KEYS.mesaRequests));
  const [refreshing, setRefreshing] = useState(false);
  /** Requests dropped by the roster gate on the last successful load. */
  const [hiddenCount, setHiddenCount] = useState(0);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [query, setQuery] = useState('');
  const [filterStatus, setFilterStatus] = useState<MesaRequestStatus | ''>('');
  const [filterType, setFilterType] = useState<MesaRequestType | ''>('');
  const [filterDepartment, setFilterDepartment] = useState('');
  const [page, setPage] = useState(0);
  const [reviewTarget, setReviewTarget] = useState<MesaRequest | null>(null);
  const [reviewNotes, setReviewNotes] = useState('');
  const [reviewing, setReviewing] = useState(false);
  const [savingEffective, setSavingEffective] = useState(false);
  /** MESA rollup for the member under review — the balance a disbursement is
   *  judged against. Loaded per-modal-open, so it's fresh at decision time. */
  const [reviewLedger, setReviewLedger] = useState<MesaMemberSummary | null>(null);
  const [reviewLedgerState, setReviewLedgerState] = useState<'loading' | 'ready' | 'error'>('loading');
  const [busyId, setBusyId] = useState<string | null>(null);
  const [deleteTarget, setDeleteTarget] = useState<MesaRequest | null>(null);
  const [bulkBusy, setBulkBusy] = useState(false);

  const load = async (showSpinner = true) => {
    if (showSpinner) setLoading(true); else setRefreshing(true);
    try {
      // Accounting only handles money-related requests.
      // Opt-in requests are routed to HR.
      const params = new URLSearchParams();
      ['opt_out', 'disbursement', 'return'].forEach((t) => params.append('request_type', t));
      const [res, rosterEmails] = await Promise.all([
        fetch(`/api/mesa-requests?${params}`, { cache: 'no-store' }),
        fetchRosterEmailSet(),
      ]);
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const json = (await res.json()) as { rows?: MesaRequest[] };
      // The Global Master List is the source of truth for MESA — requests from
      // people no longer on the active roster are hidden (the request row
      // itself is kept; it reappears if they're restored to the roster). The
      // hidden count is surfaced above the table so a drop never goes unseen —
      // e.g. an approved-but-unpaid disbursement, or a sync race transiently
      // shrinking the roster (memory/master-list-sync-race.md).
      const accountingRows = (json.rows ?? []).filter(
        (r) => r.request_type === 'opt_out' || r.request_type === 'disbursement' || r.request_type === 'return',
      );
      const data = accountingRows.filter((r) => isOnRoster(rosterEmails, r.work_email));
      setHiddenCount(accountingRows.length - data.length);
      setLoadError(null);
      setTabCache(TAB_CACHE_KEYS.mesaRequests, data);
      setRows(data);
    } catch (e) {
      const msg = e instanceof Error ? e.message : 'Failed to load MESA requests';
      setLoadError(msg);
      toast.error(msg);
    } finally {
      setLoading(false);
      setRefreshing(false);
    }
  };

  useEffect(() => {
    // Revalidate on every mount, but only show the full spinner when there's
    // no cached data to paint — a warm cache refreshes quietly in the
    // background so switching back to this tab feels instant.
    void load(!hasTabCache(TAB_CACHE_KEYS.mesaRequests));
  }, []);

  const departments = useMemo(
    () => Array.from(new Set(rows.map((r) => r.department).filter(Boolean))).sort((a, b) => a.localeCompare(b)),
    [rows],
  );

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    return rows.filter((r) => {
      if (filterStatus && r.status !== filterStatus) return false;
      if (filterType && r.request_type !== filterType) return false;
      if (filterDepartment && r.department !== filterDepartment) return false;
      if (q) {
        return (
          r.work_email.toLowerCase().includes(q) ||
          r.full_name.toLowerCase().includes(q) ||
          r.department.toLowerCase().includes(q) ||
          (r.disbursement_reason ?? '').toLowerCase().includes(q)
        );
      }
      return true;
    });
  }, [rows, query, filterStatus, filterType, filterDepartment]);

  useEffect(() => { setPage(0); }, [query, filterStatus, filterType, filterDepartment]);

  const totalPages = Math.max(1, Math.ceil(filtered.length / PAGE_SIZE));
  const safePage = Math.min(page, totalPages - 1);
  const pageRows = filtered.slice(safePage * PAGE_SIZE, (safePage + 1) * PAGE_SIZE);

  const sel = useRowSelection(filtered, (r) => r.id);

  const stats = useMemo(() => ({
    total: rows.length,
    pending: rows.filter((r) => r.status === 'pending').length,
    approved: rows.filter((r) => r.status === 'approved').length,
    denied: rows.filter((r) => r.status === 'denied').length,
  }), [rows]);

  // Export of the rows currently in view — stat band recomputed over the
  // filtered set so the document is internally consistent with its row count.
  const exportSpec = useMemo<MesaExportSpec>(() => {
    const scopeParts = [
      filterType ? TYPE_LABELS[filterType] : null,
      filterStatus ? filterStatus.charAt(0).toUpperCase() + filterStatus.slice(1) : null,
      filterDepartment || null,
      query.trim() ? `matching "${query.trim()}"` : null,
    ].filter(Boolean);
    const details = (r: MesaRequest): string => {
      if (r.request_type === 'disbursement')
        return [r.disbursement_reason, r.explanation].filter(Boolean).join(' — ') || '-';
      if (r.request_type === 'return') return r.explanation || '-';
      if (r.request_type === 'opt_in' && r.fpu_date) return `FPU: ${r.fpu_date}`;
      if (r.request_type === 'opt_out' && r.effective_date)
        return `Effective: ${formatDateOnly(r.effective_date)}`;
      return '-';
    };
    return {
      eyebrow: 'Accounting - MESA',
      title: 'MESA Requests',
      sheetName: 'MESA Requests',
      fileBase: 'mesa-requests',
      scopeLabel: scopeParts.length ? scopeParts.join(' · ') : 'All money-related requests',
      countNoun: ['request', 'requests'],
      stats: [
        { label: 'In this export', value: filtered.length.toLocaleString() },
        { label: 'Pending', value: filtered.filter((r) => r.status === 'pending').length.toLocaleString() },
        { label: 'Approved', value: filtered.filter((r) => r.status === 'approved').length.toLocaleString() },
        { label: 'Denied', value: filtered.filter((r) => r.status === 'denied').length.toLocaleString() },
      ],
      columns: [
        { header: 'Employee', pdfWeight: 78, xlsxWidth: 26 },
        { header: 'Email', pdfWeight: 105, xlsxWidth: 32 },
        { header: 'Department', pdfWeight: 60, xlsxWidth: 20 },
        { header: 'Type', pdfWeight: 52, xlsxWidth: 14 },
        { header: 'Details', pdfWeight: 95, xlsxWidth: 40 },
        { header: 'Amount', align: 'right', pdfWeight: 58, xlsxWidth: 15 },
        { header: 'Receipts', align: 'right', pdfWeight: 44, xlsxWidth: 11 },
        { header: 'Status', pdfWeight: 46, xlsxWidth: 12 },
        { header: 'Submitted', pdfWeight: 52, xlsxWidth: 14 },
        { header: 'Reviewed by', pdfWeight: 62, xlsxWidth: 22 },
      ],
      rows: filtered.map((r) => [
        r.full_name,
        r.work_email,
        r.department || '-',
        TYPE_LABELS[r.request_type],
        details(r),
        r.amount_needed != null ? formatPhpExport(r.amount_needed) : '-',
        // Only a disbursement can carry a receipt; "-" for the rest, and for a
        // list served before the receipts migration ran (count undefined) so the
        // export never reports a 0 it can't actually vouch for.
        r.request_type === 'disbursement' && r.receipt_count != null ? String(r.receipt_count) : '-',
        r.status.charAt(0).toUpperCase() + r.status.slice(1),
        new Date(r.created_at).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' }),
        r.reviewed_by ?? '-',
      ]),
    };
  }, [filtered, filterStatus, filterType, filterDepartment, query]);

  const handleRefresh = async () => {
    clearTabCache(TAB_CACHE_KEYS.mesaRequests);
    await load(false);
    toast.success('Refreshed MESA requests');
  };

  const openReview = (r: MesaRequest) => {
    setReviewTarget(r);
    setReviewNotes('');
  };

  // Accounting can correct an opt-out's effective date — the member picks it,
  // but they get it wrong, ask for a different day, or agree a new one over
  // email. Saves on pick (the picker closes on a day click, so there's nothing
  // else to confirm) and rolls back if the write fails, rather than leaving the
  // modal showing a date the row doesn't have.
  const saveEffectiveDate = async (iso: string) => {
    if (!reviewTarget || !iso || iso === reviewTarget.effective_date) return;
    const { id } = reviewTarget;
    const previous = reviewTarget.effective_date;
    const apply = (value: string | null) => {
      setReviewTarget((t) => (t && t.id === id ? { ...t, effective_date: value } : t));
      setRows((rs) => rs.map((r) => (r.id === id ? { ...r, effective_date: value } : r)));
    };

    apply(iso);
    setSavingEffective(true);
    try {
      const res = await fetch(`/api/mesa-requests/${id}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ effective_date: iso }),
      });
      if (!res.ok) {
        const j = (await res.json().catch(() => ({}))) as { error?: string };
        throw new Error(j.error ?? `HTTP ${res.status}`);
      }
      clearTabCache(TAB_CACHE_KEYS.mesaRequests);
      toast.success(`Effective date set to ${formatDateOnly(iso)}`);
    } catch (e) {
      apply(previous);
      toast.error(e instanceof Error ? e.message : 'Could not update the effective date');
    } finally {
      setSavingEffective(false);
    }
  };

  // Pull the reviewed member's MESA rollup when the modal opens. Keyed on the
  // email STRING, not the row object, so parent re-renders don't re-fetch. The
  // ledger route follows pre-drift email aliases, so the request's work_email is
  // enough even when contributions were recorded under an older address.
  const reviewEmail = reviewTarget?.work_email ?? null;
  useEffect(() => {
    if (!reviewEmail) return;
    let cancelled = false;
    setReviewLedger(null);
    setReviewLedgerState('loading');
    fetch(`/api/mesa-ledger?email=${encodeURIComponent(reviewEmail)}&events=0`, { cache: 'no-store' })
      .then((r) => (r.ok ? r.json() : Promise.reject(new Error(`HTTP ${r.status}`))))
      .then((j: { summary?: MesaMemberSummary | null }) => {
        if (cancelled) return;
        setReviewLedger(j.summary ?? null);
        setReviewLedgerState('ready');
      })
      .catch(() => {
        if (!cancelled) setReviewLedgerState('error');
      });
    return () => { cancelled = true; };
  }, [reviewEmail]);

  // Other disbursements from the same member that will still draw on this
  // balance — pending, or approved but not yet paid out. The ledger can't know
  // about them (a payout only lands there once recorded), so the projection in
  // the modal would overstate what's left; surfaced as a caveat instead of
  // being folded into the arithmetic.
  const otherOpenDraws = useMemo(() => {
    if (!reviewTarget) return { count: 0, amount: 0 };
    const email = reviewTarget.work_email.toLowerCase();
    const open = rows.filter(
      (r) =>
        r.id !== reviewTarget.id &&
        r.work_email.toLowerCase() === email &&
        r.request_type === 'disbursement' &&
        !r.dispatched_at &&
        (r.status === 'pending' || r.status === 'approved'),
    );
    return { count: open.length, amount: open.reduce((s, r) => s + (r.amount_needed ?? 0), 0) };
  }, [rows, reviewTarget]);

  const submitReview = async (status: 'approved' | 'denied') => {
    if (!reviewTarget) return;
    setReviewing(true);
    try {
      const res = await fetch(`/api/mesa-requests/${reviewTarget.id}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ status, review_notes: reviewNotes.trim() || null }),
      });
      if (!res.ok) {
        const j = (await res.json()) as { error?: string };
        throw new Error(j.error ?? `HTTP ${res.status}`);
      }
      // On an approved opt-out, unenroll the member so the Payroll Wizard MESA
      // column stops applying the -PHP100 deduction. (Disbursement/return keep
      // the member enrolled — those withdraw/return funds, not membership.)
      if (status === 'approved' && reviewTarget.request_type === 'opt_out') {
        try {
          await fetch('/api/toggle-mesa-member', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
              workEmail: reviewTarget.work_email,
              mesaMember: false,
              name: reviewTarget.full_name,
            }),
          });
        } catch {
          toast.error('Approved, but could not auto-unenroll from MESA — please toggle manually in Rates.');
        }
      }
      toast.success(`Request ${status}`);
      setReviewTarget(null);
      clearTabCache(TAB_CACHE_KEYS.mesaRequests);
      await load(false);
    } catch (e) {
      toast.error(e instanceof Error ? e.message : 'Review failed');
    } finally {
      setReviewing(false);
    }
  };

  // Revoke a prior decision — reverts the request to pending. For a previously
  // approved opt-out, re-enroll the member so the MESA -PHP100 deduction resumes.
  const revokeRequest = async (r: MesaRequest) => {
    setBusyId(r.id);
    try {
      const res = await fetch(`/api/mesa-requests/${r.id}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ status: 'pending' }),
      });
      if (!res.ok) {
        const j = (await res.json()) as { error?: string };
        throw new Error(j.error ?? `HTTP ${res.status}`);
      }
      if (r.status === 'approved' && r.request_type === 'opt_out') {
        try {
          await fetch('/api/toggle-mesa-member', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ workEmail: r.work_email, mesaMember: true, name: r.full_name }),
          });
        } catch {
          toast.error('Revoked, but could not re-enroll in MESA — please toggle manually in Rates.');
        }
      }
      toast.success('Decision revoked — request is pending again');
      clearTabCache(TAB_CACHE_KEYS.mesaRequests);
      await load(false);
    } catch (e) {
      toast.error(e instanceof Error ? e.message : 'Revoke failed');
    } finally {
      setBusyId(null);
    }
  };

  const confirmDelete = async () => {
    if (!deleteTarget) return;
    setBusyId(deleteTarget.id);
    try {
      const res = await fetch(`/api/mesa-requests/${deleteTarget.id}`, { method: 'DELETE' });
      if (!res.ok) {
        const j = (await res.json()) as { error?: string };
        throw new Error(j.error ?? `HTTP ${res.status}`);
      }
      toast.success('Request deleted');
      setDeleteTarget(null);
      clearTabCache(TAB_CACHE_KEYS.mesaRequests);
      await load(false);
    } catch (e) {
      toast.error(e instanceof Error ? e.message : 'Delete failed');
    } finally {
      setBusyId(null);
    }
  };

  // Bulk approve/deny — only acts on the selected rows that are still pending.
  // Approving an opt_out also unenrolls the member (mirrors submitReview).
  const bulkReview = async (status: 'approved' | 'denied') => {
    const targets = sel.selectedRows.filter((r) => r.status === 'pending');
    if (targets.length === 0) {
      toast.error('No pending requests selected');
      return;
    }
    setBulkBusy(true);
    const { ok, fail } = await runBulk(targets, async (r) => {
      const res = await fetch(`/api/mesa-requests/${r.id}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ status, review_notes: null }),
      });
      if (!res.ok) {
        const j = (await res.json().catch(() => ({}))) as { error?: string };
        throw new Error(j.error ?? `HTTP ${res.status}`);
      }
      if (status === 'approved' && r.request_type === 'opt_out') {
        // Best-effort unenroll; don't fail the whole request on this.
        await fetch('/api/toggle-mesa-member', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ workEmail: r.work_email, mesaMember: false, name: r.full_name }),
        }).catch(() => {});
      }
    });
    reportBulk(status === 'approved' ? 'Approved' : 'Denied', ok, fail);
    sel.clear();
    setBulkBusy(false);
    clearTabCache(TAB_CACHE_KEYS.mesaRequests);
    await load(false);
  };

  // Bulk delete — skips rows already dispatched (the API blocks those).
  const bulkDelete = async () => {
    const targets = sel.selectedRows.filter((r) => !r.dispatched_at);
    if (targets.length === 0) {
      toast.error('Selected requests are already paid out and cannot be deleted');
      return;
    }
    setBulkBusy(true);
    const { ok, fail } = await runBulk(targets, async (r) => {
      const res = await fetch(`/api/mesa-requests/${r.id}`, { method: 'DELETE' });
      if (!res.ok) {
        const j = (await res.json().catch(() => ({}))) as { error?: string };
        throw new Error(j.error ?? `HTTP ${res.status}`);
      }
    });
    reportBulk('Deleted', ok, fail);
    sel.clear();
    setBulkBusy(false);
    clearTabCache(TAB_CACHE_KEYS.mesaRequests);
    await load(false);
  };

  return (
    <div className="flex h-full min-h-0 flex-col overflow-y-auto bg-gradient-to-br from-white via-teal-50/30 to-emerald-50/20 p-4 sm:p-6 dark:bg-none dark:bg-[#0d1117]">
      <div className="w-full space-y-5">

        {/* Header */}
        <div className="flex items-start gap-3">
          <div className="flex h-10 w-10 shrink-0 items-center justify-center rounded-xl bg-gradient-to-br from-teal-100 to-emerald-100 text-teal-700 ring-1 ring-teal-100 dark:from-teal-950/60 dark:to-emerald-950/40 dark:text-teal-300 dark:ring-teal-900/60">
            <HeartHandshake className="h-5 w-5" />
          </div>
          <div className="min-w-0">
            <p className="text-[11px] font-semibold uppercase tracking-[0.18em] text-teal-700 dark:text-teal-300">
              Medical Emergency Savings Account
            </p>
            <h2 className="mt-0.5 text-2xl font-bold tracking-tight text-zinc-900 dark:text-white">
              MESA — Disbursements &amp; Changes
            </h2>
            <p className="mt-1 max-w-2xl text-sm leading-relaxed text-zinc-600 dark:text-zinc-400">
              {view === 'requests'
                ? 'Opt-out, disbursement, and return requests submitted by members. Opt-in requests are handled by HR.'
                : view === 'non-members'
                ? 'Employees not enrolled in MESA — those who never joined, plus opted-out ex-members (last status: Opted out). Temporary manual Opt In until members self-serve from the Employee Dashboard.'
                : 'Employees currently enrolled in MESA, with their contribution, match, and balance to date.'}
            </p>
          </div>
        </div>

        {/* View switcher */}
        <div
          role="tablist"
          aria-label="MESA sections"
          className="relative inline-flex items-center gap-1 self-start rounded-lg border border-teal-100/80 bg-white/70 p-1 shadow-sm backdrop-blur dark:border-teal-900/40 dark:bg-zinc-900/60"
        >
          <ViewTabButton active={view === 'requests'} onClick={() => setView('requests')} icon={ClipboardList} label="Requests" />
          <ViewTabButton active={view === 'non-members'} onClick={() => setView('non-members')} icon={Users} label="Non Members" />
          <ViewTabButton active={view === 'active-members'} onClick={() => setView('active-members')} icon={Wallet} label="MESA Active Members" />
        </div>

        {view === 'non-members' ? (
          <MesaNonMembers />
        ) : view === 'active-members' ? (
          <MesaActiveMembers />
        ) : (
        <>
        {/* Stats */}
        <div className="grid gap-3 sm:grid-cols-4">
          <StatCard label="Total" value={stats.total} tone="zinc" />
          <StatCard label="Pending" value={stats.pending} tone="amber" />
          <StatCard label="Approved" value={stats.approved} tone="teal" />
          <StatCard label="Denied" value={stats.denied} tone="rose" />
        </div>

        {/* Toolbar */}
        <div className="flex flex-wrap items-center gap-2">
          <div className="relative min-w-[200px] flex-1">
            <Search className="pointer-events-none absolute left-3 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-zinc-400" />
            <Input
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              placeholder="Search name, email, department..."
              className="h-9 border-zinc-200 bg-white pl-9 text-sm focus:border-teal-500 focus:ring-2 focus:ring-teal-500/20 dark:border-zinc-800 dark:bg-zinc-900/60"
            />
          </div>
          <div className="flex items-center gap-1.5">
            <Filter className="h-3.5 w-3.5 text-zinc-400" />
            <SmoothSelect
              aria-label="Filter by status"
              value={filterStatus}
              onChange={(v) => setFilterStatus(v as MesaRequestStatus | '')}
              triggerClassName="w-36"
              options={[
                { value: '', label: 'All statuses' },
                { value: 'pending', label: 'Pending' },
                { value: 'approved', label: 'Approved' },
                { value: 'denied', label: 'Denied' },
              ]}
            />
            <SmoothSelect
              aria-label="Filter by type"
              value={filterType}
              onChange={(v) => setFilterType(v as MesaRequestType | '')}
              triggerClassName="w-36"
              options={[
                { value: '', label: 'All types' },
                { value: 'opt_out', label: 'Opt-out' },
                { value: 'disbursement', label: 'Disbursement' },
                { value: 'return', label: 'Return' },
              ]}
            />
            <SmoothSelect
              aria-label="Filter by department"
              value={filterDepartment}
              onChange={setFilterDepartment}
              triggerClassName="w-44"
              options={[
                { value: '', label: 'All departments' },
                ...departments.map((d) => ({ value: d, label: d })),
              ]}
            />
          </div>
          <Button
            type="button"
            variant="outline"
            size="sm"
            onClick={handleRefresh}
            disabled={refreshing || loading}
            className="gap-1.5"
          >
            <RefreshCw className={cn('h-3.5 w-3.5', refreshing && 'animate-spin')} />
            Refresh
          </Button>
          <MesaExportMenu spec={exportSpec} />
        </div>

        {/* Table */}
        <Card className="overflow-hidden border-teal-100/80 shadow-sm dark:border-teal-900/40">
          <CardHeader className="border-b border-teal-100/80 bg-teal-50/30 px-5 py-3 dark:border-teal-900/40 dark:bg-teal-950/20">
            <CardTitle className="text-sm font-semibold text-zinc-900 dark:text-white">
              {loading ? 'Loading...' : `${filtered.length} request${filtered.length === 1 ? '' : 's'}`}
            </CardTitle>
            {!loading && hiddenCount > 0 && (
              <p className="text-[11px] font-medium text-amber-700 dark:text-amber-400">
                {hiddenCount} request{hiddenCount === 1 ? '' : 's'} hidden — requester not on the Global Master List
              </p>
            )}
          </CardHeader>
          <CardContent className="p-0">
            {sel.selectedRows.length > 0 && (
              <BulkBar count={sel.selectedRows.length} onClear={sel.clear}>
                <Button type="button" size="sm" disabled={bulkBusy} onClick={() => bulkReview('approved')} className="h-7 bg-teal-600 text-[11px] text-white hover:bg-teal-700 dark:bg-teal-600 dark:hover:bg-teal-500">
                  <CheckCircle2 className="mr-1 h-3 w-3" />Approve
                </Button>
                <Button type="button" size="sm" variant="outline" disabled={bulkBusy} onClick={() => bulkReview('denied')} className="h-7 border-rose-200 bg-rose-50 text-[11px] text-rose-700 hover:bg-rose-100 dark:border-rose-700/50 dark:bg-rose-950/30 dark:text-rose-300">
                  <XCircle className="mr-1 h-3 w-3" />Deny
                </Button>
                <Button type="button" size="sm" variant="outline" disabled={bulkBusy} onClick={bulkDelete} className="h-7 border-rose-200 bg-rose-50 text-[11px] text-rose-700 hover:bg-rose-100 dark:border-rose-700/50 dark:bg-rose-950/30 dark:text-rose-300">
                  <Trash2 className="mr-1 h-3 w-3" />Delete
                </Button>
              </BulkBar>
            )}
            {loading ? (
              <SkeletonRows count={6} />
            ) : filtered.length === 0 ? (
              <div className="flex flex-col items-center justify-center gap-2 px-5 py-12 text-center text-sm text-zinc-500 dark:text-zinc-400">
                <Inbox className="h-6 w-6 text-zinc-400" />
                {rows.length === 0
                  ? loadError
                    ? `Couldn't load requests — ${loadError}. Use Refresh to retry.`
                    : 'No MESA requests yet.'
                  : 'No results match your filters.'}
              </div>
            ) : (
              <div className="overflow-x-auto">
                <table className="w-full text-left text-xs">
                  <thead className="border-b border-teal-100/80 bg-teal-50/40 text-[11px] font-semibold uppercase tracking-wide text-teal-700 dark:border-teal-900/40 dark:bg-teal-950/30 dark:text-teal-300">
                    <tr>
                      <th className="w-8 px-3 py-2.5">
                        <SelectCheckbox checked={sel.allSelected} indeterminate={sel.someSelected} onChange={sel.toggleAll} ariaLabel="Select all requests" />
                      </th>
                      <th className="px-4 py-2.5">Employee</th>
                      <th className="px-4 py-2.5">Department</th>
                      <th className="px-4 py-2.5">Type</th>
                      <th className="px-4 py-2.5">Details</th>
                      <th className="px-4 py-2.5">Receipt</th>
                      <th className="px-4 py-2.5 text-right">Amount</th>
                      <th className="px-4 py-2.5 text-right">Status</th>
                      <th className="px-4 py-2.5 text-right">Submitted</th>
                      <th className="px-4 py-2.5 text-right">Action</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-teal-100/60 dark:divide-teal-900/40">
                    {pageRows.map((r) => (
                      <tr
                        key={r.id}
                        className={cn('transition-colors hover:bg-teal-50/40 dark:hover:bg-teal-950/20', sel.selectedKeys.has(r.id) && 'bg-teal-50/60 dark:bg-teal-950/30')}
                      >
                        <td className="px-3 py-3" data-label="Select">
                          <SelectCheckbox checked={sel.selectedKeys.has(r.id)} onChange={() => sel.toggle(r.id)} ariaLabel={`Select ${r.full_name}`} />
                        </td>
                        <td className="px-4 py-3" data-label="Employee">
                          <div className="font-medium text-zinc-900 dark:text-zinc-100">{r.full_name}</div>
                          <div className="mt-0.5 font-mono text-[11px] text-zinc-500 dark:text-zinc-500">
                            {r.work_email}
                          </div>
                        </td>
                        <td className="px-4 py-3 text-zinc-600 dark:text-zinc-400" data-label="Department">
                          {r.department}
                        </td>
                        <td className="px-4 py-3" data-label="Type">
                          <Badge
                            variant="outline"
                            className={cn('text-[10.5px] font-semibold uppercase tracking-wide', TYPE_COLORS[r.request_type])}
                          >
                            {TYPE_LABELS[r.request_type]}
                          </Badge>
                        </td>
                        <td className="max-w-[180px] px-4 py-3" data-label="Details">
                          {r.request_type === 'opt_in' && r.fpu_date && (
                            <span className="text-zinc-600 dark:text-zinc-400">FPU: {r.fpu_date}</span>
                          )}
                          {r.request_type === 'disbursement' && (
                            <div>
                              <div className="font-medium text-zinc-700 dark:text-zinc-300">{r.disbursement_reason}</div>
                              {r.explanation && (
                                <div className="mt-0.5 line-clamp-2 text-zinc-500 dark:text-zinc-500">
                                  {r.explanation}
                                </div>
                              )}
                            </div>
                          )}
                          {r.request_type === 'return' && r.explanation && (
                            <span className="line-clamp-2 text-zinc-500 dark:text-zinc-500">{r.explanation}</span>
                          )}
                          {r.request_type === 'opt_out' ? (
                            r.effective_date ? (
                              <span className="text-zinc-600 dark:text-zinc-400">
                                Effective {formatDateOnly(r.effective_date)}
                              </span>
                            ) : (
                              <span className="text-zinc-400">—</span>
                            )
                          ) : (
                            !r.fpu_date && !r.disbursement_reason && !r.explanation && (
                              <span className="text-zinc-400">—</span>
                            )
                          )}
                        </td>
                        <td className="px-4 py-3" data-label="Receipt">
                          <ReceiptCell request={r} onOpen={() => openReview(r)} />
                        </td>
                        <td className="px-4 py-3 text-right tabular-nums text-zinc-700 dark:text-zinc-300" data-label="Amount">
                          {r.amount_needed != null
                            ? `PHP ${r.amount_needed.toLocaleString('en-PH', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`
                            : '—'}
                        </td>
                        <td className="px-4 py-3 text-right" data-label="Status">
                          <StatusBadge status={r.status} />
                        </td>
                        <td className="px-4 py-3 text-right text-zinc-500 dark:text-zinc-500" data-label="Submitted">
                          {new Date(r.created_at).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' })}
                        </td>
                        <td className="px-4 py-3 text-right" data-label="Action">
                          {r.status === 'pending' ? (
                            <div className="flex items-center justify-end gap-1.5">
                              <Button
                                type="button"
                                size="sm"
                                variant="outline"
                                onClick={() => openReview(r)}
                                className="h-7 border-teal-200 bg-teal-50/60 text-[11px] font-semibold text-teal-700 hover:bg-teal-100 dark:border-teal-700/50 dark:bg-teal-950/30 dark:text-teal-300 dark:hover:bg-teal-950/60"
                              >
                                Review
                              </Button>
                              <button
                                type="button"
                                title="Delete request"
                                disabled={busyId === r.id}
                                onClick={() => setDeleteTarget(r)}
                                className="inline-flex h-7 w-7 items-center justify-center rounded-md border border-zinc-200 text-zinc-400 transition-colors hover:border-rose-300 hover:bg-rose-50 hover:text-rose-600 disabled:opacity-40 dark:border-zinc-700 dark:hover:border-rose-700/50 dark:hover:bg-rose-950/30 dark:hover:text-rose-400"
                              >
                                <Trash2 className="h-3.5 w-3.5" />
                              </button>
                            </div>
                          ) : (
                            <div className="flex items-center justify-end gap-2">
                              <span className="text-[11px] text-zinc-400">
                                {r.reviewed_by ? `by ${r.reviewed_by.split('@')[0]}` : '—'}
                              </span>
                              {/* A decided opt-out still needs its effective date
                                  editable — the member's leaving date can move
                                  after the decision. */}
                              {r.request_type === 'opt_out' && (
                                <button
                                  type="button"
                                  title="Edit effective date"
                                  onClick={() => openReview(r)}
                                  className="inline-flex h-7 w-7 items-center justify-center rounded-md border border-zinc-200 text-zinc-400 transition-colors hover:border-teal-300 hover:bg-teal-50 hover:text-teal-600 dark:border-zinc-700 dark:hover:border-teal-700/50 dark:hover:bg-teal-950/30 dark:hover:text-teal-400"
                                >
                                  <CalendarClock className="h-3.5 w-3.5" />
                                </button>
                              )}
                              <button
                                type="button"
                                title={r.dispatched_at ? 'Already paid out — cannot revoke' : 'Revoke decision (back to pending)'}
                                disabled={busyId === r.id || !!r.dispatched_at}
                                onClick={() => revokeRequest(r)}
                                className="inline-flex h-7 w-7 items-center justify-center rounded-md border border-zinc-200 text-zinc-400 transition-colors hover:border-amber-300 hover:bg-amber-50 hover:text-amber-600 disabled:cursor-not-allowed disabled:opacity-30 dark:border-zinc-700 dark:hover:border-amber-700/50 dark:hover:bg-amber-950/30 dark:hover:text-amber-400"
                              >
                                <Undo2 className="h-3.5 w-3.5" />
                              </button>
                              <button
                                type="button"
                                title={r.dispatched_at ? 'Already paid out — cannot delete' : 'Delete request'}
                                disabled={busyId === r.id || !!r.dispatched_at}
                                onClick={() => setDeleteTarget(r)}
                                className="inline-flex h-7 w-7 items-center justify-center rounded-md border border-zinc-200 text-zinc-400 transition-colors hover:border-rose-300 hover:bg-rose-50 hover:text-rose-600 disabled:cursor-not-allowed disabled:opacity-30 dark:border-zinc-700 dark:hover:border-rose-700/50 dark:hover:bg-rose-950/30 dark:hover:text-rose-400"
                              >
                                <Trash2 className="h-3.5 w-3.5" />
                              </button>
                            </div>
                          )}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
            {!loading && filtered.length > PAGE_SIZE && (
              <div data-readonly-allow className="flex items-center justify-between border-t border-teal-100/80 px-5 py-2.5 dark:border-teal-900/40">
                <p className="text-[11px] text-zinc-400">
                  {safePage * PAGE_SIZE + 1}–{Math.min((safePage + 1) * PAGE_SIZE, filtered.length)} of{' '}
                  {filtered.length}
                </p>
                <div className="flex items-center gap-1">
                  <Button variant="outline" size="icon" className="h-7 w-7" disabled={safePage === 0} onClick={() => setPage(0)} aria-label="First page">
                    <ChevronLeft className="h-3 w-3" /><ChevronLeft className="-ml-2 h-3 w-3" />
                  </Button>
                  <Button variant="outline" size="icon" className="h-7 w-7" disabled={safePage === 0} onClick={() => setPage((p) => Math.max(0, p - 1))} aria-label="Previous page">
                    <ChevronLeft className="h-3 w-3" />
                  </Button>
                  <span className="min-w-[4rem] text-center text-[11px] text-zinc-500">{safePage + 1} / {totalPages}</span>
                  <Button variant="outline" size="icon" className="h-7 w-7" disabled={safePage >= totalPages - 1} onClick={() => setPage((p) => Math.min(totalPages - 1, p + 1))} aria-label="Next page">
                    <ChevronRight className="h-3 w-3" />
                  </Button>
                  <Button variant="outline" size="icon" className="h-7 w-7" disabled={safePage >= totalPages - 1} onClick={() => setPage(totalPages - 1)} aria-label="Last page">
                    <ChevronRight className="h-3 w-3" /><ChevronRight className="-ml-2 h-3 w-3" />
                  </Button>
                </div>
              </div>
            )}
          </CardContent>
        </Card>
        </>
        )}
      </div>

      {/* Review modal */}
      {reviewTarget && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 backdrop-blur-[2px] p-4 animate-in fade-in duration-200 ease-out motion-reduce:animate-none">
          {/* Column layout with a scrolling body: the balance panel + a long
              explanation can outgrow a short viewport, and the decision buttons
              must stay reachable. A disbursement widens on desktop to seat the
              receipt gallery beside the details it substantiates. */}
          <div
            className={cn(
              'flex max-h-[88vh] w-full max-w-md flex-col overflow-hidden rounded-2xl border border-zinc-200 bg-white shadow-2xl dark:border-zinc-800 dark:bg-zinc-950 animate-in fade-in zoom-in-95 slide-in-from-bottom-2 duration-200 ease-out motion-reduce:animate-none',
              reviewTarget.request_type === 'disbursement' && 'lg:max-w-4xl',
            )}
          >
            <div className="flex shrink-0 items-center justify-between border-b border-zinc-200 px-5 py-4 dark:border-zinc-800">
              <div>
                <p className="text-[11px] font-semibold uppercase tracking-wide text-teal-600 dark:text-teal-400">
                  {TYPE_LABELS[reviewTarget.request_type]} Request
                </p>
                <h3 className="mt-0.5 text-base font-bold text-zinc-900 dark:text-white">
                  {reviewTarget.status === 'pending' ? 'Review' : 'Details'} — {reviewTarget.full_name}
                </h3>
              </div>
              <button
                type="button"
                onClick={() => setReviewTarget(null)}
                className="rounded-md p-1.5 text-zinc-400 hover:bg-zinc-100 hover:text-zinc-600 dark:hover:bg-zinc-800 dark:hover:text-zinc-300"
                aria-label="Close"
              >
                <X className="h-4 w-4" />
              </button>
            </div>
            {/* Details, and — for a disbursement — the receipt gallery beside
                them. Mobile scrolls the pair as one column; from lg each pane
                scrolls on its own so the evidence stays put while the details
                are read. */}
            <div className="flex min-h-0 flex-1 flex-col overflow-y-auto lg:flex-row lg:overflow-hidden">
              <div className="space-y-3 px-5 py-4 lg:min-h-0 lg:flex-1 lg:overflow-y-auto">
                <InfoRow label="Email" value={reviewTarget.work_email} />
                <InfoRow label="Department" value={reviewTarget.department} />
                {reviewTarget.fpu_date && <InfoRow label="FPU Completed" value={reviewTarget.fpu_date} />}
                {reviewTarget.request_type === 'opt_out' && (
                  <div>
                    <div className="flex items-baseline justify-between gap-2">
                      <label
                        htmlFor="mesa-review-effective"
                        className="text-[11px] font-semibold uppercase tracking-wide text-zinc-400 dark:text-zinc-500"
                      >
                        Effective Date
                      </label>
                      <span className="text-[10.5px] text-zinc-400 dark:text-zinc-500">
                        {savingEffective ? 'Saving…' : 'Editable — saves on pick'}
                      </span>
                    </div>
                    <DatePicker
                      id="mesa-review-effective"
                      value={reviewTarget.effective_date ?? ''}
                      onChange={saveEffectiveDate}
                      disabled={savingEffective}
                      required
                      placeholder="Not set — pick a date"
                      className="mt-1 dark:bg-zinc-900"
                    />
                    {/* Approving unenrolls immediately — there's no scheduler that
                        holds a future-dated opt-out, so say so rather than let the
                        date imply one. */}
                    {reviewTarget.effective_date && reviewTarget.effective_date > toIso(new Date()) && (
                      <p className="mt-2 flex items-start gap-1.5 rounded-md border border-amber-200 bg-amber-50 p-2.5 text-[11.5px] leading-relaxed text-amber-900 dark:border-amber-500/40 dark:bg-amber-950/30 dark:text-amber-100">
                        <AlertTriangle className="mt-px h-3.5 w-3.5 shrink-0" />
                        <span>
                          Requested for a future date. Approving now unenrolls them right away — hold
                          the decision until {formatDateOnly(reviewTarget.effective_date)} if the
                          deduction should keep running until then.
                        </span>
                      </p>
                    )}
                  </div>
                )}
                {reviewTarget.disbursement_reason && <InfoRow label="Reason" value={reviewTarget.disbursement_reason} />}
                {reviewTarget.explanation && (
                  <div>
                    <p className="text-[11px] font-semibold uppercase tracking-wide text-zinc-400 dark:text-zinc-500">Explanation</p>
                    <p className="mt-1 text-sm leading-relaxed text-zinc-700 dark:text-zinc-300">{reviewTarget.explanation}</p>
                  </div>
                )}
                <MesaBalanceImpact
                  request={reviewTarget}
                  ledger={reviewLedger}
                  state={reviewLedgerState}
                  otherOpen={otherOpenDraws}
                />
                {/* A decided request is opened to read it (and to fix an opt-out
                    date) — not to re-review it, so the note becomes a record of
                    what was said. Revoke from the row to reopen the decision. */}
                {reviewTarget.status === 'pending' ? (
                  <div>
                    <label className="text-[11px] font-semibold uppercase tracking-wide text-zinc-400 dark:text-zinc-500">
                      Review Notes (optional)
                    </label>
                    <textarea
                      value={reviewNotes}
                      onChange={(e) => setReviewNotes(e.target.value)}
                      rows={3}
                      placeholder="Add a note for the employee..."
                      className="mt-1 w-full rounded-md border border-zinc-200 bg-white px-3 py-2 text-sm text-zinc-900 placeholder-zinc-400 focus:border-teal-500 focus:outline-none focus:ring-2 focus:ring-teal-500/20 dark:border-zinc-700 dark:bg-zinc-900 dark:text-zinc-100"
                    />
                  </div>
                ) : (
                  <>
                    <InfoRow
                      label={reviewTarget.status === 'approved' ? 'Approved by' : 'Denied by'}
                      value={reviewTarget.reviewed_by ?? '—'}
                    />
                    {reviewTarget.review_notes && (
                      <div>
                        <p className="text-[11px] font-semibold uppercase tracking-wide text-zinc-400 dark:text-zinc-500">Review Notes</p>
                        <p className="mt-1 text-sm leading-relaxed text-zinc-700 dark:text-zinc-300">{reviewTarget.review_notes}</p>
                      </div>
                    )}
                  </>
                )}
              </div>
            {/* The member's evidence, in its own pane: whether the claim is
                substantiated should be readable at a glance, not one file-row
                click at a time. */}
            {reviewTarget.request_type === 'disbursement' && (
              <div className="border-t border-zinc-200 bg-zinc-50/70 lg:min-h-0 lg:w-[25rem] lg:shrink-0 lg:overflow-hidden lg:border-l lg:border-t-0 dark:border-zinc-800 dark:bg-zinc-900/40">
                <MesaReceiptGallery
                  requestId={reviewTarget.id}
                  submittedAt={reviewTarget.created_at}
                />
              </div>
            )}
            </div>
            <div className="flex shrink-0 items-center justify-end gap-2 border-t border-zinc-200 px-5 py-4 dark:border-zinc-800">
              <Button
                type="button"
                variant="outline"
                size="sm"
                onClick={() => setReviewTarget(null)}
                disabled={reviewing || savingEffective}
              >
                {reviewTarget.status === 'pending' ? 'Cancel' : 'Close'}
              </Button>
              {reviewTarget.status === 'pending' && (
                <>
                  <Button
                    type="button"
                    size="sm"
                    disabled={reviewing || savingEffective}
                    onClick={() => submitReview('denied')}
                    className="border-rose-200 bg-rose-50 text-rose-700 hover:bg-rose-100 dark:border-rose-700/50 dark:bg-rose-950/30 dark:text-rose-300 dark:hover:bg-rose-950/60"
                    variant="outline"
                  >
                    <XCircle className="mr-1.5 h-3.5 w-3.5" />
                    Deny
                  </Button>
                  <Button
                    type="button"
                    size="sm"
                    disabled={reviewing || savingEffective}
                    onClick={() => submitReview('approved')}
                    className="bg-teal-600 text-white hover:bg-teal-700 dark:bg-teal-600 dark:hover:bg-teal-500"
                  >
                    <CheckCircle2 className="mr-1.5 h-3.5 w-3.5" />
                    Approve
                  </Button>
                </>
              )}
            </div>
          </div>
        </div>
      )}

      {/* Delete confirmation */}
      {deleteTarget && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 backdrop-blur-[2px] p-4 animate-in fade-in duration-200 ease-out motion-reduce:animate-none">
          <div className="w-full max-w-sm rounded-2xl border border-zinc-200 bg-white shadow-2xl dark:border-zinc-800 dark:bg-zinc-950 animate-in fade-in zoom-in-95 slide-in-from-bottom-2 duration-200 ease-out motion-reduce:animate-none">
            <div className="flex items-start gap-3 px-5 py-5">
              <div className="flex h-10 w-10 shrink-0 items-center justify-center rounded-full bg-rose-100 text-rose-600 dark:bg-rose-950/40 dark:text-rose-400">
                <Trash2 className="h-5 w-5" />
              </div>
              <div className="min-w-0">
                <h3 className="text-base font-bold text-zinc-900 dark:text-white">Delete this request?</h3>
                <p className="mt-1 text-sm leading-relaxed text-zinc-600 dark:text-zinc-400">
                  {TYPE_LABELS[deleteTarget.request_type]} request from{' '}
                  <span className="font-medium text-zinc-800 dark:text-zinc-200">{deleteTarget.full_name}</span>.
                  This permanently removes it and cannot be undone.
                </p>
              </div>
            </div>
            <div className="flex items-center justify-end gap-2 border-t border-zinc-200 px-5 py-4 dark:border-zinc-800">
              <Button
                type="button"
                variant="outline"
                size="sm"
                onClick={() => setDeleteTarget(null)}
                disabled={busyId === deleteTarget.id}
              >
                Cancel
              </Button>
              <Button
                type="button"
                size="sm"
                disabled={busyId === deleteTarget.id}
                onClick={confirmDelete}
                className="bg-rose-600 text-white hover:bg-rose-700 dark:bg-rose-600 dark:hover:bg-rose-500"
              >
                <Trash2 className="mr-1.5 h-3.5 w-3.5" />
                Delete
              </Button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

function StatusBadge({ status }: { status: string }) {
  if (status === 'approved') {
    return (
      <Badge variant="outline" className="border-teal-200 bg-teal-50 text-[10.5px] font-semibold uppercase tracking-wide text-teal-700 dark:border-teal-500/40 dark:bg-teal-500/15 dark:text-teal-200">
        <CheckCircle2 className="mr-1 h-3 w-3" />Approved
      </Badge>
    );
  }
  if (status === 'denied') {
    return (
      <Badge variant="outline" className="border-rose-200 bg-rose-50 text-[10.5px] font-semibold uppercase tracking-wide text-rose-700 dark:border-rose-500/40 dark:bg-rose-500/15 dark:text-rose-200">
        <XCircle className="mr-1 h-3 w-3" />Denied
      </Badge>
    );
  }
  return (
    <Badge variant="outline" className="border-amber-200 bg-amber-50 text-[10.5px] font-semibold uppercase tracking-wide text-amber-700 dark:border-amber-500/40 dark:bg-amber-500/15 dark:text-amber-200">
      <Clock className="mr-1 h-3 w-3" />Pending
    </Badge>
  );
}

function StatCard({ label, value, tone }: { label: string; value: number; tone: 'teal' | 'zinc' | 'amber' | 'rose' }) {
  const styles = {
    teal: 'border-teal-200 bg-gradient-to-br from-teal-50 to-white text-teal-900 dark:border-teal-700/40 dark:from-teal-950/40 dark:to-zinc-950 dark:text-teal-100',
    zinc: 'border-zinc-200 bg-white text-zinc-900 dark:border-zinc-800 dark:bg-zinc-900/40 dark:text-zinc-100',
    amber: 'border-amber-200 bg-gradient-to-br from-amber-50 to-white text-amber-900 dark:border-amber-700/40 dark:from-amber-950/40 dark:to-zinc-950 dark:text-amber-100',
    rose: 'border-rose-200 bg-gradient-to-br from-rose-50 to-white text-rose-900 dark:border-rose-700/40 dark:from-rose-950/40 dark:to-zinc-950 dark:text-rose-100',
  }[tone];
  return (
    <div className={`rounded-xl border p-4 shadow-sm ${styles}`}>
      <p className="text-[11px] font-medium uppercase tracking-wide opacity-70">{label}</p>
      <p className="mt-1 font-mono text-2xl font-bold tabular-nums">{value}</p>
    </div>
  );
}

function InfoRow({ label, value }: { label: string; value: string }) {
  return (
    <div>
      <p className="text-[11px] font-semibold uppercase tracking-wide text-zinc-400 dark:text-zinc-500">{label}</p>
      <p className="mt-0.5 text-sm text-zinc-800 dark:text-zinc-200">{value}</p>
    </div>
  );
}

// ── Receipts ─────────────────────────────────────────────────────────────────
//
// Members attach up to three receipt files to a disbursement request (Employee →
// MESA → Request → Past requests → Receipt). This is the "was it legitimate"
// evidence: MESA has always required receipts within 14 days showing the
// merchant's name, but until there was somewhere to put them the request under
// review carried no proof of anything.

/** How long after the request the receipt landed — the program allows 14 days. */
function receiptLagDays(submittedAt: string, uploadedAt: string): number | null {
  const from = new Date(submittedAt).getTime();
  const to = new Date(uploadedAt).getTime();
  if (Number.isNaN(from) || Number.isNaN(to)) return null;
  return Math.floor((to - from) / 86_400_000);
}

/** "Jul 28" — the newest receipt's day, compact enough for a table cell. */
const formatReceiptDay = (iso: string) => {
  const d = new Date(iso);
  return Number.isNaN(d.getTime())
    ? '—'
    : d.toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
};

/**
 * The **Receipt** column (2026-07-31). This used to be a chip under the reason in
 * the Details cell; it earns its own column because "which of these thirty draws
 * is substantiated, and which is past the 14-day window" is a question the
 * reviewer scans for down the table — not one they should have to read thirty
 * Details cells to answer.
 *
 * Only a disbursement can carry a receipt, and an unknown count (a list served
 * before the receipts migration ran) renders as a neutral dash rather than a
 * "None" that would accuse every request of missing its proof.
 */
function ReceiptCell({ request, onOpen }: { request: MesaRequest; onOpen: () => void }) {
  const count = request.receipt_count;

  if (request.request_type !== 'disbursement' || count == null) {
    return (
      <span
        title={
          request.request_type === 'disbursement'
            ? 'Receipt count unavailable'
            : 'Receipts apply to disbursements only'
        }
        className="text-zinc-300 dark:text-zinc-600"
      >
        —
      </span>
    );
  }

  if (count === 0) {
    // A denied request never released money, so no receipt is owed — only a
    // pending or approved draw can be overdue against the 14-day rule.
    const age = request.status === 'denied' ? null : receiptLagDays(request.created_at, new Date().toISOString());
    const overdue = age != null && age > 14;
    return (
      <span
        title={
          overdue
            ? `No receipt after ${age} days — the program allows 14`
            : 'No receipt attached yet — the program allows 14 days'
        }
        className={cn(
          'inline-flex items-center gap-1 text-[10.5px] font-medium',
          overdue
            ? 'text-amber-700 dark:text-amber-300'
            : 'text-zinc-400 dark:text-zinc-500',
        )}
      >
        <FileWarning aria-hidden className="h-3 w-3 shrink-0" />
        None
        {overdue && <span className="tabular-nums">· {age}d</span>}
      </span>
    );
  }

  const uploadedAt = request.receipt_last_uploaded_at ?? null;
  const lag = uploadedAt ? receiptLagDays(request.created_at, uploadedAt) : null;
  const late = lag != null && lag > 14;

  return (
    <button
      type="button"
      onClick={onOpen}
      title={[
        `${count} receipt${count === 1 ? '' : 's'} attached — open the request to view`,
        lag != null
          ? `newest ${lag <= 0 ? 'the same day' : `${lag}d after the request`}${late ? ' (past 14 days)' : ''}`
          : null,
      ]
        .filter(Boolean)
        .join('; ')}
      className="group inline-flex flex-col items-start gap-0.5 text-left"
    >
      <span
        className={cn(
          'inline-flex items-center gap-1 rounded-md border px-1.5 py-0.5 text-[10.5px] font-semibold tabular-nums transition-colors',
          late
            ? 'border-amber-200 bg-amber-50 text-amber-800 group-hover:bg-amber-100 dark:border-amber-500/40 dark:bg-amber-500/15 dark:text-amber-100 dark:group-hover:bg-amber-500/25'
            : 'border-teal-200 bg-teal-50 text-teal-800 group-hover:bg-teal-100 dark:border-teal-500/40 dark:bg-teal-500/15 dark:text-teal-100 dark:group-hover:bg-teal-500/25',
        )}
      >
        <ReceiptText aria-hidden className="h-3 w-3 shrink-0" />
        {count} file{count === 1 ? '' : 's'}
      </span>
      {uploadedAt && (
        <span
          className={cn(
            'text-[10px] tabular-nums',
            late ? 'font-semibold text-amber-700 dark:text-amber-300' : 'text-zinc-400 dark:text-zinc-500',
          )}
        >
          {formatReceiptDay(uploadedAt)}
          {late ? ' · late' : ''}
        </span>
      )}
    </button>
  );
}

/** The stored file name, or a slot label when the upload carried none. */
const receiptLabel = (r: MesaReceiptWithUrl) => r.file_name || `Receipt ${r.slot}`;

const isPdfReceipt = (r: MesaReceiptWithUrl) => (r.mime_type ?? '') === 'application/pdf';

/** Maximize / new tab / download, all three the same size under the preview. */
const RECEIPT_ACTION_CLASS =
  'inline-flex h-7 items-center justify-center gap-1 rounded-lg border border-zinc-200 bg-white text-[10.5px] font-semibold text-zinc-600 transition-colors hover:border-teal-300 hover:bg-teal-50 hover:text-teal-700 dark:border-zinc-700 dark:bg-zinc-900 dark:text-zinc-300 dark:hover:border-teal-700/60 dark:hover:bg-teal-950/40 dark:hover:text-teal-300';

/** Size/date/lag line, shared by the gallery caption and the lightbox bar. */
function ReceiptMetaLine({
  receipt,
  submittedAt,
  className,
  lateClassName,
}: {
  receipt: MesaReceiptWithUrl;
  submittedAt: string;
  className?: string;
  /** Amber treatment differs on white vs. the lightbox's black. */
  lateClassName: string;
}) {
  const lag = receiptLagDays(submittedAt, receipt.uploaded_at);
  const late = lag != null && lag > 14;
  return (
    <span className={className}>
      {formatReceiptSize(receipt.file_size)} · {formatDateOnly(receipt.uploaded_at)}
      {lag != null && (
        <span className={cn(late && lateClassName)}>
          {' · '}
          {lag <= 0 ? 'same day' : `${lag}d after request`}
          {late ? ' (past 14 days)' : ''}
        </span>
      )}
    </span>
  );
}

/** Strip thumbnail: the image itself, or a type icon when it isn't one (or the
 *  signed URL failed to load). */
function ReceiptThumb({
  receipt,
  broken,
  onBroken,
}: {
  receipt: MesaReceiptWithUrl;
  broken: boolean;
  onBroken: () => void;
}) {
  if (isMesaReceiptImage(receipt.mime_type) && receipt.url && !broken) {
    return (
      // eslint-disable-next-line @next/next/no-img-element
      <img
        src={receipt.url}
        alt=""
        loading="lazy"
        onError={onBroken}
        className="h-full w-full object-cover"
      />
    );
  }
  return (
    <span className="flex h-full w-full items-center justify-center">
      {isPdfReceipt(receipt) ? (
        <FileText aria-hidden className="h-4 w-4 text-rose-500 dark:text-rose-300" />
      ) : (
        <ImageIcon aria-hidden className="h-4 w-4 text-zinc-400 dark:text-zinc-500" />
      )}
    </span>
  );
}

/**
 * The receipt gallery — the review modal's right-hand pane (2026-07-31).
 *
 * Receipts used to be a stack of 40px file rows sharing the details' scroller,
 * which meant the evidence was actually read by opening every file in a new tab.
 * Now the active receipt is displayed large beside the request it substantiates,
 * the others are one click away in the strip, and Maximize / new tab / download
 * sit under the preview. Still read-only for Accounting on purpose: this is what
 * the decision rests on, so the reviewer views it, they don't edit it.
 */
function MesaReceiptGallery({
  requestId,
  submittedAt,
}: {
  requestId: string;
  /** The request's created_at, so "attached 3 days later" can be stated. */
  submittedAt: string;
}) {
  const [rows, setRows] = useState<MesaReceiptWithUrl[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [broken, setBroken] = useState<Set<string>>(new Set());
  const [activeIdx, setActiveIdx] = useState(0);
  /** Index being viewed full-screen, or null when the lightbox is closed. */
  const [zoomIdx, setZoomIdx] = useState<number | null>(null);

  useEffect(() => {
    let cancelled = false;
    setRows(null);
    setError(null);
    setActiveIdx(0);
    setZoomIdx(null);
    fetch(`/api/mesa-requests/${requestId}/receipts`, { cache: 'no-store' })
      .then(async (r) => {
        const json = (await r.json().catch(() => ({}))) as {
          rows?: MesaReceiptWithUrl[];
          error?: string;
        };
        if (!r.ok) throw new Error(json.error ?? `HTTP ${r.status}`);
        return json.rows ?? [];
      })
      .then((data) => { if (!cancelled) setRows(data); })
      .catch((e: unknown) => {
        if (!cancelled) setError(e instanceof Error ? e.message : 'Could not load receipts');
      });
    return () => { cancelled = true; };
  }, [requestId]);

  const files = rows ?? [];
  // Clamped rather than trusted: a slow response can land after a click.
  const safeIdx = files.length === 0 ? 0 : Math.min(activeIdx, files.length - 1);
  const active = files[safeIdx] ?? null;
  const markBroken = (id: string) =>
    setBroken((p) => (p.has(id) ? p : new Set(p).add(id)));

  const activeUrl = active?.url ?? null;
  const activeIsPdf = active ? isPdfReceipt(active) : false;
  const showActiveImage =
    !!active && isMesaReceiptImage(active.mime_type) && !!activeUrl && !broken.has(active.id);

  return (
    <div className="flex h-full min-h-0 flex-col">
      <header className="flex shrink-0 items-baseline justify-between gap-2 border-b border-zinc-200/80 px-4 py-2.5 dark:border-zinc-800">
        <p className="inline-flex items-center gap-1.5 text-[11px] font-semibold uppercase tracking-wide text-zinc-500 dark:text-zinc-400">
          <ReceiptText aria-hidden className="h-3.5 w-3.5 text-teal-600 dark:text-teal-400" />
          Receipts
        </p>
        {rows !== null && (
          <span className="text-[10.5px] tabular-nums text-zinc-400 dark:text-zinc-500">
            {rows.length} of {MAX_MESA_RECEIPTS}
          </span>
        )}
      </header>

      <div className="min-h-0 flex-1 space-y-2.5 overflow-y-auto p-4">
        {rows === null && !error && (
          <>
            <div className="aspect-[4/3] w-full animate-pulse rounded-xl bg-zinc-200/70 dark:bg-zinc-800/60" />
            <div className="h-3 w-2/3 animate-pulse rounded bg-zinc-200/70 dark:bg-zinc-800/60" />
          </>
        )}

        {error && (
          <p className="rounded-lg border border-amber-200 bg-amber-50 p-2.5 text-[11.5px] leading-relaxed text-amber-900 dark:border-amber-500/40 dark:bg-amber-950/30 dark:text-amber-100">
            {error}
          </p>
        )}

        {rows !== null && rows.length === 0 && (
          <p className="flex items-start gap-2 rounded-lg border border-zinc-200 bg-white p-2.5 text-[11.5px] leading-relaxed text-zinc-600 dark:border-zinc-800 dark:bg-zinc-900/60 dark:text-zinc-400">
            <FileWarning aria-hidden className="mt-px h-3.5 w-3.5 shrink-0 text-zinc-400 dark:text-zinc-500" />
            <span>
              No receipt attached. The member can add one from{' '}
              <strong className="font-semibold text-zinc-700 dark:text-zinc-300">
                MESA → Request → Past requests
              </strong>{' '}
              — the program allows 14 days.
            </span>
          </p>
        )}

        {active && (
          <>
            {/* Hero preview. The whole tile maximizes — the reviewer's instinct
                on a receipt too small to read is to click it. */}
            <button
              type="button"
              onClick={() => setZoomIdx(safeIdx)}
              disabled={!activeUrl}
              title={activeUrl ? 'Maximize' : 'Preview unavailable — the signed link expired'}
              className="group relative block w-full overflow-hidden rounded-xl border border-zinc-200 bg-white shadow-sm transition-colors hover:border-teal-300 disabled:cursor-default dark:border-zinc-800 dark:bg-zinc-950/60 dark:hover:border-teal-700/60"
            >
              <span className="flex aspect-[4/3] items-center justify-center bg-zinc-100 p-1.5 dark:bg-zinc-900">
                {showActiveImage ? (
                  // eslint-disable-next-line @next/next/no-img-element
                  <img
                    src={activeUrl as string}
                    alt={receiptLabel(active)}
                    onError={() => markBroken(active.id)}
                    className="max-h-full max-w-full rounded-md object-contain"
                  />
                ) : (
                  <span className="flex flex-col items-center gap-1.5 px-4 text-center">
                    {activeIsPdf ? (
                      <FileText aria-hidden className="h-9 w-9 text-rose-500 dark:text-rose-300" />
                    ) : (
                      <ImageIcon aria-hidden className="h-9 w-9 text-zinc-400 dark:text-zinc-500" />
                    )}
                    <span className="text-[11px] font-semibold uppercase tracking-wide text-zinc-500 dark:text-zinc-400">
                      {activeIsPdf ? 'PDF' : 'No preview'}
                    </span>
                    <span className="text-[10.5px] text-zinc-400 dark:text-zinc-500">
                      {activeIsPdf
                        ? 'Maximize to read it here'
                        : activeUrl
                          ? 'Open it in a new tab'
                          : 'The signed link expired — reopen the request'}
                    </span>
                  </span>
                )}
              </span>
              {activeUrl && (
                <span className="pointer-events-none absolute right-2 top-2 inline-flex items-center gap-1 rounded-md bg-black/55 px-1.5 py-1 text-[10px] font-semibold text-white opacity-0 backdrop-blur-sm transition-opacity group-hover:opacity-100 group-focus-visible:opacity-100">
                  <Maximize2 aria-hidden className="h-3 w-3" />
                  Maximize
                </span>
              )}
              {files.length > 1 && (
                <span className="pointer-events-none absolute bottom-2 left-2 rounded-md bg-black/50 px-1.5 py-0.5 text-[10px] font-semibold tabular-nums text-white backdrop-blur-sm">
                  {safeIdx + 1} / {files.length}
                </span>
              )}
            </button>

            <div className="min-w-0">
              <p className="truncate text-[12.5px] font-semibold text-zinc-900 dark:text-zinc-100">
                {receiptLabel(active)}
              </p>
              <ReceiptMetaLine
                receipt={active}
                submittedAt={submittedAt}
                className="mt-0.5 block truncate text-[10.5px] text-zinc-500 dark:text-zinc-500"
                lateClassName="font-semibold text-amber-700 dark:text-amber-300"
              />
            </div>

            <div className="grid grid-cols-3 gap-1.5">
              <button
                type="button"
                onClick={() => setZoomIdx(safeIdx)}
                disabled={!activeUrl}
                className={cn(RECEIPT_ACTION_CLASS, !activeUrl && 'pointer-events-none opacity-50')}
              >
                <Maximize2 aria-hidden className="h-3 w-3" />
                Maximize
              </button>
              <a
                href={activeUrl ?? undefined}
                target="_blank"
                rel="noopener noreferrer"
                title="Open in a new tab"
                className={cn(RECEIPT_ACTION_CLASS, !activeUrl && 'pointer-events-none opacity-50')}
              >
                <ExternalLink aria-hidden className="h-3 w-3" />
                New tab
              </a>
              <a
                href={mesaReceiptDownloadUrl(activeUrl, active.file_name) ?? undefined}
                title={`Download ${receiptLabel(active)}`}
                className={cn(RECEIPT_ACTION_CLASS, !activeUrl && 'pointer-events-none opacity-50')}
              >
                <Download aria-hidden className="h-3 w-3" />
                Download
              </a>
            </div>

            {files.length > 1 && (
              <div className="flex gap-2 pt-0.5">
                {files.map((f, i) => (
                  <button
                    key={f.id}
                    type="button"
                    onClick={() => setActiveIdx(i)}
                    title={receiptLabel(f)}
                    aria-label={`Show ${receiptLabel(f)}`}
                    aria-current={i === safeIdx}
                    className={cn(
                      'h-14 w-14 shrink-0 overflow-hidden rounded-lg border-2 bg-zinc-100 transition-colors dark:bg-zinc-800/70',
                      i === safeIdx
                        ? 'border-teal-500 dark:border-teal-400'
                        : 'border-transparent ring-1 ring-zinc-200 hover:border-teal-300 dark:ring-zinc-700 dark:hover:border-teal-700',
                    )}
                  >
                    <ReceiptThumb receipt={f} broken={broken.has(f.id)} onBroken={() => markBroken(f.id)} />
                  </button>
                ))}
              </div>
            )}
          </>
        )}
      </div>

      {/* Portaled: this modal is itself fixed and the app shell isolates its
          stacking context, so an in-place overlay would render underneath one of
          them. AnimatePresence stays mounted so the exit animation can run. */}
      {typeof document !== 'undefined' &&
        createPortal(
          <AnimatePresence>
            {zoomIdx != null && files[zoomIdx] && (
              <MesaReceiptLightbox
                key="mesa-receipt-lightbox"
                files={files}
                index={zoomIdx}
                submittedAt={submittedAt}
                onIndex={(i) => { setZoomIdx(i); setActiveIdx(i); }}
                onClose={() => setZoomIdx(null)}
              />
            )}
          </AnimatePresence>,
          document.body,
        )}
    </div>
  );
}

/**
 * Full-screen receipt viewer. A photographed receipt is unreadable at gallery
 * size, so this is where the reviewer actually reads the merchant's name and
 * the amount: the image fills the viewport, a PDF is embedded rather than
 * bounced to a new tab, Escape closes, ←/→ walk the (at most three) files, and
 * new tab + download stay in the bar.
 */
function MesaReceiptLightbox({
  files,
  index,
  submittedAt,
  onIndex,
  onClose,
}: {
  files: MesaReceiptWithUrl[];
  index: number;
  submittedAt: string;
  onIndex: (i: number) => void;
  onClose: () => void;
}) {
  const reduceMotion = useReducedMotion();
  const count = files.length;
  const file = files[index] ?? null;

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        onClose();
        return;
      }
      if (count < 2) return;
      if (e.key === 'ArrowRight') onIndex((index + 1) % count);
      if (e.key === 'ArrowLeft') onIndex((index - 1 + count) % count);
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [index, count, onClose, onIndex]);

  if (!file) return null;

  const isPdf = isPdfReceipt(file);
  const stop = (e: React.MouseEvent) => e.stopPropagation();
  const navClass =
    'flex h-9 w-9 shrink-0 items-center justify-center rounded-full bg-white/10 text-white ring-1 ring-white/20 backdrop-blur-md transition hover:bg-white/20';
  const barClass =
    'inline-flex h-8 shrink-0 items-center gap-1.5 rounded-lg bg-white/10 px-2.5 text-[11px] font-semibold text-white ring-1 ring-white/20 backdrop-blur-md transition hover:bg-white/20';

  return (
    <motion.div
      initial={{ opacity: 0 }}
      animate={{ opacity: 1 }}
      exit={{ opacity: 0 }}
      transition={{ duration: reduceMotion ? 0 : 0.18, ease: 'easeOut' }}
      onClick={onClose}
      role="dialog"
      aria-modal="true"
      aria-label={`Receipt ${index + 1} of ${count}`}
      className="fixed inset-0 z-[9999] flex flex-col gap-3 bg-black/85 p-3 backdrop-blur-sm sm:p-6"
    >
      <div className="flex shrink-0 items-center gap-2" onClick={stop}>
        <div className="min-w-0 flex-1">
          <p className="truncate text-[12.5px] font-semibold text-white">{receiptLabel(file)}</p>
          <p className="mt-0.5 truncate text-[10.5px] text-white/60">
            <ReceiptMetaLine
              receipt={file}
              submittedAt={submittedAt}
              lateClassName="font-semibold text-amber-300"
            />
            {count > 1 && <span className="tabular-nums">{` · ${index + 1} of ${count}`}</span>}
          </p>
        </div>
        <a href={file.url ?? undefined} target="_blank" rel="noopener noreferrer" className={barClass}>
          <ExternalLink aria-hidden className="h-3.5 w-3.5" />
          <span className="hidden sm:inline">New tab</span>
        </a>
        <a
          href={mesaReceiptDownloadUrl(file.url, file.file_name) ?? undefined}
          className={barClass}
        >
          <Download aria-hidden className="h-3.5 w-3.5" />
          <span className="hidden sm:inline">Download</span>
        </a>
        <button type="button" onClick={onClose} className={barClass} aria-label="Close">
          <X aria-hidden className="h-3.5 w-3.5" />
        </button>
      </div>

      <div className="flex min-h-0 flex-1 items-center justify-center gap-2 sm:gap-4">
        {count > 1 && (
          <button
            type="button"
            onClick={(e) => { stop(e); onIndex((index - 1 + count) % count); }}
            className={navClass}
            aria-label="Previous receipt"
          >
            <ChevronLeft aria-hidden className="h-5 w-5" />
          </button>
        )}

        {isPdf ? (
          <iframe
            src={file.url ?? undefined}
            title={receiptLabel(file)}
            onClick={stop}
            className="h-full w-full max-w-4xl rounded-xl bg-white shadow-2xl"
          />
        ) : (
          <motion.img
            key={file.id}
            initial={{ opacity: 0, scale: reduceMotion ? 1 : 0.94, y: reduceMotion ? 0 : 10 }}
            animate={{ opacity: 1, scale: 1, y: 0 }}
            transition={{ duration: reduceMotion ? 0 : 0.22, ease: [0.22, 1, 0.36, 1] }}
            src={file.url ?? undefined}
            alt={receiptLabel(file)}
            onClick={stop}
            className="max-h-full max-w-full rounded-xl object-contain shadow-2xl"
          />
        )}

        {count > 1 && (
          <button
            type="button"
            onClick={(e) => { stop(e); onIndex((index + 1) % count); }}
            className={navClass}
            aria-label="Next receipt"
          >
            <ChevronRight aria-hidden className="h-5 w-5" />
          </button>
        )}
      </div>
    </motion.div>
  );
}

/**
 * Balance impact of a money request, shown inside the review modal: what's in
 * the member's MESA account now, what this request takes out, and what would be
 * left. Reviewing a disbursement without this meant approving blind — a request
 * larger than the account balance is exactly what this panel exists to catch.
 *
 * The requested amount comes from the request row, so it renders even when the
 * ledger fetch is still in flight or has failed; only the balance-derived lines
 * wait on `state`.
 */
function MesaBalanceImpact({
  request,
  ledger,
  state,
  otherOpen,
}: {
  request: MesaRequest;
  ledger: MesaMemberSummary | null;
  state: 'loading' | 'ready' | 'error';
  /** Same member's other not-yet-paid disbursements, absent from the ledger. */
  otherOpen: { count: number; amount: number };
}) {
  const isReturn = request.request_type === 'return';
  const isOptOut = request.request_type === 'opt_out';
  // Legacy/partial rows: a disbursement that never captured an amount can't be
  // subtracted, so the projection is suppressed rather than shown as −PHP0.00.
  const amountMissing = request.request_type === 'disbursement' && request.amount_needed == null;
  const balance = ledger?.balance ?? 0;
  // An approved opt-out settles the whole account, so the draw is the entire
  // balance; a disbursement takes only what was asked for. A return is an
  // inflow and carries no amount on the request row.
  const draw = isReturn ? 0 : isOptOut ? balance : request.amount_needed ?? 0;
  const ready = state === 'ready';
  // Balance is only known once the ledger resolves, so an opt-out's draw is too.
  const drawKnown = ready || !isOptOut;
  const showProjection = !isReturn && !amountMissing;
  const remaining = balance - draw;
  const shortfall = draw - balance;
  // Half-centavo epsilon — float sums of peso figures shouldn't trip a warning.
  const insufficient = ready && showProjection && shortfall > 0.005;

  const shimmer = (
    <span className="inline-block h-4 w-24 animate-pulse rounded bg-teal-200/60 align-middle dark:bg-teal-800/50" />
  );
  const figure = (value: number) => (ready ? formatPHP(value) : state === 'loading' ? shimmer : '—');

  return (
    <div
      className={cn(
        'rounded-xl border p-3.5',
        insufficient
          ? 'border-rose-200 bg-rose-50/60 dark:border-rose-800/50 dark:bg-rose-950/20'
          : 'border-teal-200 bg-teal-50/50 dark:border-teal-800/50 dark:bg-teal-950/20',
      )}
    >
      <div className="flex items-center justify-between gap-2">
        <p className="inline-flex items-center gap-1.5 text-[11px] font-semibold uppercase tracking-wide text-teal-700 dark:text-teal-300">
          <PiggyBank className="h-3.5 w-3.5" />
          MESA account
        </p>
        {ledger?.accountNumber && (
          <span className="font-mono text-[10.5px] text-zinc-500 dark:text-zinc-400">
            Acct {ledger.accountNumber}
          </span>
        )}
      </div>

      <dl className="mt-2.5 space-y-1.5 text-sm">
        <div className="flex items-baseline justify-between gap-3">
          <dt className="text-zinc-600 dark:text-zinc-400">Current balance</dt>
          <dd className="font-mono font-semibold tabular-nums text-zinc-900 dark:text-zinc-100">
            {figure(balance)}
          </dd>
        </div>

        {showProjection && (
          <>
            <div className="flex items-baseline justify-between gap-3">
              <dt className="text-zinc-600 dark:text-zinc-400">
                {isOptOut ? 'Full payout on opt-out' : 'This disbursement request'}
              </dt>
              <dd className="font-mono font-semibold tabular-nums text-rose-600 dark:text-rose-400">
                {drawKnown ? `− ${formatPHP(draw)}` : state === 'loading' ? shimmer : '—'}
              </dd>
            </div>
            <div className="flex items-baseline justify-between gap-3 border-t border-teal-200/70 pt-1.5 dark:border-teal-800/40">
              <dt className="font-semibold text-zinc-800 dark:text-zinc-200">
                {isOptOut ? 'Balance after closing' : 'Balance after payout'}
              </dt>
              <dd
                className={cn(
                  'font-mono text-base font-bold tabular-nums',
                  !ready
                    ? 'text-zinc-400 dark:text-zinc-500'
                    : insufficient
                      ? 'text-rose-600 dark:text-rose-400'
                      : 'text-teal-700 dark:text-teal-300',
                )}
              >
                {figure(remaining)}
              </dd>
            </div>
          </>
        )}
      </dl>

      {insufficient && (
        <p className="mt-2.5 flex items-start gap-1.5 text-[11.5px] font-medium leading-relaxed text-rose-700 dark:text-rose-300">
          <AlertTriangle className="mt-px h-3.5 w-3.5 shrink-0" />
          <span>
            Exceeds the available balance by {formatPHP(shortfall)} — approving this would overdraw
            the account.
          </span>
        </p>
      )}

      {showProjection && otherOpen.count > 0 && (
        <p className="mt-2 flex items-start gap-1.5 text-[11.5px] leading-relaxed text-amber-700 dark:text-amber-300">
          <AlertTriangle className="mt-px h-3.5 w-3.5 shrink-0" />
          <span>
            {otherOpen.count} other unpaid disbursement request
            {otherOpen.count === 1 ? '' : 's'} totalling {formatPHP(otherOpen.amount)} — not counted
            above.
          </span>
        </p>
      )}

      {ready && !ledger && (
        <p className="mt-2 text-[11.5px] leading-relaxed text-zinc-500 dark:text-zinc-400">
          No MESA ledger history for this member yet, so the balance reads as {formatPHP(0)}.
        </p>
      )}

      {state === 'error' && (
        <p className="mt-2 text-[11.5px] leading-relaxed text-rose-600 dark:text-rose-400">
          Couldn&apos;t load the MESA ledger — balance unavailable. Check the member&apos;s account
          on the MESA Active Members tab before deciding.
        </p>
      )}

      {isReturn && (
        <p className="mt-2 text-[11.5px] leading-relaxed text-zinc-500 dark:text-zinc-400">
          A return adds funds back — the balance above updates once Accounting records the deposit.
        </p>
      )}

      {amountMissing && (
        <p className="mt-2 text-[11.5px] leading-relaxed text-amber-700 dark:text-amber-300">
          This request has no amount recorded, so the balance after payout can&apos;t be projected.
        </p>
      )}

      {ready && ledger && (
        <p className="mt-2.5 border-t border-teal-200/60 pt-2 font-mono text-[10.5px] text-zinc-500 dark:border-teal-800/40 dark:text-zinc-400">
          Contributed {formatPHP(ledger.contributed)} · Matched {formatPHP(ledger.matched)}
          {ledger.disbursed > 0 ? ` · Disbursed ${formatPHP(ledger.disbursed)}` : ''}
        </p>
      )}
    </div>
  );
}

function SkeletonRows({ count }: { count: number }) {
  return (
    <div className="divide-y divide-teal-100/60 dark:divide-teal-900/40">
      {Array.from({ length: count }).map((_, i) => (
        <div key={i} className="flex items-center gap-4 px-4 py-3">
          <div className="h-4 w-32 animate-pulse rounded bg-zinc-100 dark:bg-zinc-800" />
          <div className="h-3 w-24 animate-pulse rounded bg-zinc-100 dark:bg-zinc-800" />
          <div className="h-5 w-16 animate-pulse rounded-full bg-teal-100/60 dark:bg-teal-900/30" />
          <div className="ml-auto h-4 w-20 animate-pulse rounded bg-zinc-100 dark:bg-zinc-800" />
        </div>
      ))}
    </div>
  );
}

// ── View switcher pill ───────────────────────────────────────────────────────

function ViewTabButton({
  active,
  onClick,
  icon: Icon,
  label,
  layoutId = 'accounting-mesa-view-pill',
}: {
  active: boolean;
  onClick: () => void;
  icon: React.ComponentType<{ className?: string }>;
  label: string;
  /** Distinct per independent tab group — two groups sharing one id (e.g. the
   *  outer switcher and a modal's tabs open at the same time) would fight
   *  each other for the same framer-motion layout animation. */
  layoutId?: string;
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
          : 'text-zinc-600 hover:bg-teal-50/70 hover:text-teal-700 dark:text-zinc-400 dark:hover:bg-teal-950/40 dark:hover:text-teal-200',
      )}
    >
      {active && (
        <motion.span
          layoutId={layoutId}
          aria-hidden
          className="absolute inset-0 rounded-md bg-gradient-to-r from-teal-500 to-emerald-500 shadow-sm"
          transition={{ type: 'spring', stiffness: 380, damping: 32 }}
        />
      )}
      <span className="relative z-10 inline-flex items-center gap-1.5">
        <Icon className="h-3.5 w-3.5" />
        {label}
      </span>
    </button>
  );
}

// ── Shared roster join (Global Master List × MESA enrollment × ledger) ─────
//
// Both tabs below are grounded in the current employee roster (not just the
// mesa_ledger backfill), so someone with no ledger history yet — a brand-new
// hire, or someone opted in today — still shows up. Mirrors the join
// HrMesa.tsx's MesaEligibleList already does (roster × employee_hourly_rates
// .mesa_member × mesa_ledger), minus its mesa_member=true pre-filter.

interface MesaRosterRow {
  key: string;
  name: string;
  workEmail: string | null;
  personalEmail: string | null;
  department: string | null;
  mesaMember: boolean;
  mesaMemberSince: string | null;
  /** Current (open) MESA account number, "YY-MM-#####" — null until the
   *  mesa_accounts migration + seed have run (or when not enrolled). */
  accountNumber: string | null;
  ledger: MesaMemberSummary | null;
}

async function fetchMesaRoster(): Promise<MesaRosterRow[]> {
  const [employeesRes, ratesRes, ledgerRes] = await Promise.all([
    fetch('/api/employees', { cache: 'no-store' }),
    fetch('/api/employee-hourly-rates', { cache: 'no-store' }),
    fetch('/api/mesa-ledger', { cache: 'no-store' }),
  ]);
  if (!employeesRes.ok) throw new Error(`employees HTTP ${employeesRes.status}`);
  if (!ratesRes.ok) throw new Error(`rates HTTP ${ratesRes.status}`);
  const employeesJson = (await employeesRes.json()) as { employees?: EmployeeRow[]; error?: string | null };
  const ratesJson = (await ratesRes.json()) as { rows?: EmployeeHourlyRateRow[] };
  // /api/employees reports DB failures as 200 + { employees: [], error }, and
  // a real roster is never empty — fail loudly instead of rendering (and
  // caching) an empty MESA roster. Mirrors fetchRosterEmailSet.
  if ((employeesJson.employees ?? []).length === 0) {
    throw new Error(employeesJson.error ?? 'Employee roster unavailable');
  }
  // Ledger is best-effort — a failure here shouldn't blank out the roster.
  const ledgerJson = ledgerRes.ok
    ? ((await ledgerRes.json()) as { members?: MesaMemberSummary[] })
    : { members: [] };

  const ledgerByEmail = new Map<string, MesaMemberSummary>();
  for (const m of ledgerJson.members ?? []) {
    if (m.email) ledgerByEmail.set(m.email.toLowerCase(), m);
  }
  const rateByEmail = new Map<string, EmployeeHourlyRateRow>();
  for (const r of ratesJson.rows ?? []) {
    const we = r.work_email?.toLowerCase().trim();
    const pe = r.personal_email?.toLowerCase().trim();
    if (we) rateByEmail.set(we, r);
    if (pe) rateByEmail.set(pe, r);
  }

  return (employeesJson.employees ?? [])
    .map((e) => {
      const we = e.work_email?.toLowerCase().trim() || null;
      const pe = e.personal_email?.toLowerCase().trim() || null;
      if (!we && !pe) return null; // nothing to key an enrollment toggle on
      // Match rates + ledger on ALL of the person's emails, including alternate
      // work emails. MESA contributions are sometimes recorded under an old
      // address the roster now carries as an alternate (e.g. jennb@ for
      // jeanneb@); without this their savings detach and they look unenrolled.
      const aw1 = e.alternate_work_email?.toLowerCase().trim() || null;
      const aw2 = e.alternate_work_email_2?.toLowerCase().trim() || null;
      const emails = [we, pe, aw1, aw2].filter((x): x is string => !!x);
      let rate: EmployeeHourlyRateRow | null = null;
      let ledger: MesaMemberSummary | null = null;
      for (const em of emails) {
        if (!rate) rate = rateByEmail.get(em) ?? null;
        if (!ledger) ledger = ledgerByEmail.get(em) ?? null;
      }
      return {
        key: we || pe!,
        name: e.name ?? we ?? pe!,
        workEmail: e.work_email ?? null,
        personalEmail: e.personal_email ?? null,
        department: e.department ?? rate?.department ?? null,
        mesaMember: rate?.mesa_member === true,
        mesaMemberSince: rate?.mesa_member_since ?? null,
        accountNumber: rate?.mesa_account_number ?? ledger?.accountNumber ?? null,
        ledger,
      } as MesaRosterRow;
    })
    .filter((r): r is MesaRosterRow => r !== null)
    .sort((a, b) => a.name.localeCompare(b.name));
}

/** Stub summary for a roster row with no mesa_ledger history yet, so the
 *  View drill-down (which fetches its own data by email anyway) always has a
 *  valid starting shape to render before that fetch resolves. */
function rosterRowToSummary(row: MesaRosterRow): MesaMemberSummary {
  if (row.ledger) {
    return { ...row.ledger, accountNumber: row.ledger.accountNumber ?? row.accountNumber };
  }
  return {
    email: row.workEmail ?? row.personalEmail ?? '',
    name: row.name,
    department: row.department,
    status: null,
    isActive: row.mesaMember,
    contributed: 0,
    matched: 0,
    deposited: 0,
    disbursed: 0,
    balance: 0,
    depositCount: 0,
    disbursementCount: 0,
    firstDeposit: null,
    lastDeposit: null,
    lastDisbursement: null,
    lastEventOptedOut: false,
    accountNumber: row.accountNumber,
  };
}

const BALANCES_PAGE_SIZE = 20;

// ── Non Members ────────────────────────────────────────────────────────────
//
// Everyone NOT currently in MESA. Membership is judged by CONTRIBUTIONS first,
// not the mesa_member flag: if a person is actively saving (has ledger deposits)
// and has NOT opted out, they're an active member — full stop — even if the flag
// drifted false. So a contributor lands here ONLY when their last ledger entry
// is an opt-out. That leaves two standings on this tab, told apart by a per-row
// Status badge:
//   • Never joined — no deposits, not flagged, no MESA start date.
//   • Opted out    — they left the program. Either the ledger's last entry is an
//       Opt-out/Termination ('Inactive' status counts too — ledger.lastEventOptedOut),
//       or the flag was cleared with a lingering mesa_member_since. A member whose
//       flag drifted (last entry is an opt-out but flag never flipped) still shows
//       here, off the Active tab.
// Opted-out members used to fall through to neither tab; now they're here. Each
// row has a temporary manual Opt In — a stopgap so Accounting can enroll (or
// re-enroll) anyone right now, before employees self-serve via the Employee
// Dashboard's MESA Request tab (EmployeeMesa.tsx), which goes through the
// mesa_requests review queue. Opting a former member back in mints a fresh
// account (see toggle-mesa-member). Remove this direct-toggle path once
// self-serve is the primary way members join.

/** Has real MESA savings attached (≥1 weekly deposit in the ledger). */
const hasContributions = (r: MesaRosterRow): boolean => (r.ledger?.depositCount ?? 0) > 0;
/** Their most recent ledger entry is an opt-out/termination — they left. */
const ledgerOptedOut = (r: MesaRosterRow): boolean => r.ledger?.lastEventOptedOut === true;
/**
 * Currently in MESA. Contributions PROVE membership on their own: a member who
 * is actively saving (has deposits) and has NOT opted out is active even if the
 * mesa_member flag drifted false. A freshly-flagged member with no deposits yet
 * also counts. The only thing that removes an active saver is a trailing opt-out
 * in the ledger.
 */
const isActiveMember = (r: MesaRosterRow): boolean =>
  !ledgerOptedOut(r) && (r.mesaMember || hasContributions(r));
/** Left the program — a trailing opt-out in the ledger, or the flag was cleared
 *  with a lingering start date. Only meaningful for non-active (Non Members)
 *  rows; a contributor can only be here if they opted out. */
const isOptedOut = (r: MesaRosterRow): boolean =>
  ledgerOptedOut(r) || (!r.mesaMember && !!r.mesaMemberSince);
/** Not currently enrolled — the complement of active. */
const isNonMember = (r: MesaRosterRow): boolean => !isActiveMember(r);

function MesaNonMembers() {
  const [rows, setRows] = useState<MesaRosterRow[]>(
    () => getTabCache<MesaRosterRow[]>(TAB_CACHE_KEYS.mesaNonMembers) ?? [],
  );
  const [loading, setLoading] = useState(!hasTabCache(TAB_CACHE_KEYS.mesaNonMembers));
  const [refreshing, setRefreshing] = useState(false);
  const [query, setQuery] = useState('');
  const [filterDepartment, setFilterDepartment] = useState('');
  const [page, setPage] = useState(0);
  const [viewTarget, setViewTarget] = useState<MesaRosterRow | null>(null);
  const [optInTargets, setOptInTargets] = useState<MesaRosterRow[] | null>(null);
  const [toggling, setToggling] = useState(false);

  const load = async (showSpinner = true) => {
    if (showSpinner) setLoading(true); else setRefreshing(true);
    try {
      const data = await fetchMesaRoster();
      setTabCache(TAB_CACHE_KEYS.mesaNonMembers, data);
      setRows(data);
    } catch (e) {
      toast.error(e instanceof Error ? e.message : 'Failed to load employee roster');
    } finally {
      setLoading(false);
      setRefreshing(false);
    }
  };

  useEffect(() => {
    void load(!hasTabCache(TAB_CACHE_KEYS.mesaNonMembers));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Non Members = everyone NOT currently enrolled (mesa_member = false): both
  // never-joined employees and opted-out ex-members (who retain their start
  // date). Enrolled members live on the "MESA Active Members" tab.
  const departments = useMemo(
    () =>
      Array.from(
        new Set(
          rows
            .filter(isNonMember)
            .map((r) => r.department)
            .filter((d): d is string => !!d),
        ),
      ).sort((a, b) => a.localeCompare(b)),
    [rows],
  );

  const filtered = useMemo(() => {
    let base = rows.filter(isNonMember);
    if (filterDepartment) base = base.filter((r) => r.department === filterDepartment);
    const q = query.trim().toLowerCase();
    if (!q) return base;
    return base.filter(
      (r) =>
        r.name.toLowerCase().includes(q) ||
        (r.workEmail ?? '').toLowerCase().includes(q) ||
        (r.department ?? '').toLowerCase().includes(q),
    );
  }, [rows, query, filterDepartment]);

  useEffect(() => { setPage(0); }, [query, filterDepartment]);

  const enrolledCount = useMemo(() => rows.filter(isActiveMember).length, [rows]);
  // Non-members = everyone not currently enrolled — matches the filtered table
  // above, so the stat card can't disagree with the list.
  const nonMemberCount = useMemo(() => rows.filter(isNonMember).length, [rows]);
  // Of those non-members, how many are opted-out ex-members (vs. never joined).
  const optedOutCount = useMemo(() => rows.filter((r) => isNonMember(r) && isOptedOut(r)).length, [rows]);

  const exportSpec = useMemo<MesaExportSpec>(() => {
    const scopeParts = [
      filterDepartment || null,
      query.trim() ? `matching "${query.trim()}"` : null,
    ].filter(Boolean);
    return {
      eyebrow: 'Accounting - MESA',
      title: 'MESA Non Members',
      sheetName: 'MESA Non Members',
      fileBase: 'mesa-non-members',
      scopeLabel: scopeParts.length ? scopeParts.join(' · ') : 'All departments',
      countNoun: ['employee', 'employees'],
      stats: [
        // Non-member figures track the EXPORTED (filtered) rows so the document
        // is internally consistent; enrolled is a whole-roster cross-reference.
        { label: 'Non members', value: filtered.length.toLocaleString() },
        { label: 'Opted out', value: filtered.filter(isOptedOut).length.toLocaleString() },
        { label: 'Enrolled (MESA Active)', value: enrolledCount.toLocaleString() },
      ],
      columns: [
        { header: 'Name', pdfWeight: 140, xlsxWidth: 26 },
        { header: 'Status', pdfWeight: 80, xlsxWidth: 14 },
        { header: 'Department', pdfWeight: 100, xlsxWidth: 20 },
        { header: 'Email', pdfWeight: 190, xlsxWidth: 32 },
      ],
      rows: filtered.map((r) => [
        r.name,
        isOptedOut(r) ? 'Opted out' : 'Never joined',
        r.department ?? '-',
        r.workEmail ?? r.personalEmail ?? '-',
      ]),
      notes: [
        'Non members = employees not currently enrolled in MESA: never joined (no MESA start date) or opted out (was a member, since removed). Opting a former member back in opens a fresh account; their prior closed account stays on record in the MESA ledger.',
      ],
    };
  }, [filtered, nonMemberCount, enrolledCount, filterDepartment, query]);

  const totalPages = Math.max(1, Math.ceil(filtered.length / BALANCES_PAGE_SIZE));
  const safePage = Math.min(page, totalPages - 1);
  const pageRows = filtered.slice(safePage * BALANCES_PAGE_SIZE, (safePage + 1) * BALANCES_PAGE_SIZE);

  const sel = useRowSelection(filtered, (r) => r.key);

  const handleRefresh = async () => {
    clearTabCache(TAB_CACHE_KEYS.mesaNonMembers);
    await load(false);
    toast.success('Refreshed employee roster');
  };

  // Opt one or many not-yet-enrolled employees into MESA. Direct enrollment
  // flip — bypasses the mesa_requests review queue (temporary bridge).
  const confirmOptIn = async () => {
    if (!optInTargets || optInTargets.length === 0) return;
    setToggling(true);
    const { ok, fail } = await runBulk(optInTargets, (t) => postToggleMesa(t, true));
    reportBulk('Opted in', ok, fail);
    setOptInTargets(null);
    sel.clear();
    setToggling(false);
    clearTabCache(TAB_CACHE_KEYS.mesaNonMembers);
    clearTabCache(TAB_CACHE_KEYS.mesaActiveMembers);
    await load(false);
  };

  return (
    <div className="space-y-5">
      {/* Summary */}
      <div className="grid gap-3 sm:grid-cols-3">
        <StatCard label="Non members" value={nonMemberCount} tone="zinc" />
        <StatCard label="Opted out" value={optedOutCount} tone="amber" />
        <StatCard label="Enrolled (MESA Active)" value={enrolledCount} tone="teal" />
      </div>

      {/* Toolbar */}
      <div className="flex flex-wrap items-center gap-2">
        <div className="relative min-w-[200px] flex-1">
          <Search className="pointer-events-none absolute left-3 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-zinc-400" />
          <Input
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="Search name, email, department..."
            className="h-9 border-zinc-200 bg-white pl-9 text-sm focus:border-teal-500 focus:ring-2 focus:ring-teal-500/20 dark:border-zinc-800 dark:bg-zinc-900/60"
          />
        </div>
        <div className="flex items-center gap-1.5">
          <Filter className="h-3.5 w-3.5 text-zinc-400" />
          <SmoothSelect
            aria-label="Filter by department"
            value={filterDepartment}
            onChange={setFilterDepartment}
            triggerClassName="w-44"
            options={[
              { value: '', label: 'All departments' },
              ...departments.map((d) => ({ value: d, label: d })),
            ]}
          />
        </div>
        <Button type="button" variant="outline" size="sm" onClick={handleRefresh} disabled={refreshing || loading} className="gap-1.5">
          <RefreshCw className={cn('h-3.5 w-3.5', refreshing && 'animate-spin')} />
          Refresh
        </Button>
        <MesaExportMenu spec={exportSpec} />
      </div>

      {/* Table */}
      <Card className="overflow-hidden border-teal-100/80 shadow-sm dark:border-teal-900/40">
        <CardHeader className="border-b border-teal-100/80 bg-teal-50/30 px-5 py-3 dark:border-teal-900/40 dark:bg-teal-950/20">
          <CardTitle className="text-sm font-semibold text-zinc-900 dark:text-white">
            {loading ? 'Loading employees...' : `${filtered.length} employee${filtered.length === 1 ? '' : 's'}`}
          </CardTitle>
        </CardHeader>
        <CardContent className="p-0">
          {sel.selectedRows.length > 0 && (
            <BulkBar count={sel.selectedRows.length} onClear={sel.clear}>
              <Button type="button" size="sm" disabled={toggling} onClick={() => setOptInTargets(sel.selectedRows)} className="h-7 bg-teal-600 text-[11px] text-white hover:bg-teal-700 dark:bg-teal-600 dark:hover:bg-teal-500">
                <UserPlus className="mr-1 h-3 w-3" />Opt In
              </Button>
            </BulkBar>
          )}
          {loading ? (
            <SkeletonRows count={8} />
          ) : filtered.length === 0 ? (
            <div className="flex flex-col items-center justify-center gap-2 px-5 py-12 text-center text-sm text-zinc-500 dark:text-zinc-400">
              <Inbox className="h-6 w-6 text-zinc-400" />
              {nonMemberCount === 0 ? 'No non-members — everyone on the roster is currently enrolled in MESA.' : 'No results match your search.'}
            </div>
          ) : (
            <div className="overflow-x-auto">
              <table className="w-full text-left text-xs">
                <thead className="border-b border-teal-100/80 bg-teal-50/40 text-[11px] font-semibold uppercase tracking-wide text-teal-700 dark:border-teal-900/40 dark:bg-teal-950/30 dark:text-teal-300">
                  <tr>
                    <th className="w-8 px-3 py-2.5">
                      <SelectCheckbox checked={sel.allSelected} indeterminate={sel.someSelected} onChange={sel.toggleAll} ariaLabel="Select all employees" />
                    </th>
                    <th className="px-4 py-2.5">Name</th>
                    <th className="px-4 py-2.5">Status</th>
                    <th className="px-4 py-2.5">Department</th>
                    <th className="px-4 py-2.5">Email</th>
                    <th className="px-4 py-2.5 text-right">Actions</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-teal-100/60 dark:divide-teal-900/40">
                  {pageRows.map((r) => (
                    <tr key={r.key} className={cn('transition-colors hover:bg-teal-50/40 dark:hover:bg-teal-950/20', sel.selectedKeys.has(r.key) && 'bg-teal-50/60 dark:bg-teal-950/30')}>
                      <td className="px-3 py-3" data-label="Select">
                        <SelectCheckbox checked={sel.selectedKeys.has(r.key)} onChange={() => sel.toggle(r.key)} ariaLabel={`Select ${r.name}`} />
                      </td>
                      <td className="px-4 py-3 font-medium text-zinc-900 dark:text-zinc-100" data-label="Name">
                        {r.name}
                      </td>
                      <td className="px-4 py-3" data-label="Status">
                        {isOptedOut(r) ? (
                          <Badge
                            variant="outline"
                            className="border-amber-200 bg-amber-50 text-[10.5px] font-semibold uppercase tracking-wide text-amber-700 dark:border-amber-500/40 dark:bg-amber-500/15 dark:text-amber-200"
                          >
                            Opted out
                          </Badge>
                        ) : (
                          <Badge
                            variant="outline"
                            className="border-zinc-200 bg-zinc-50 text-[10.5px] font-semibold uppercase tracking-wide text-zinc-600 dark:border-zinc-600 dark:bg-zinc-800/50 dark:text-zinc-300"
                          >
                            Never joined
                          </Badge>
                        )}
                      </td>
                      <td className="px-4 py-3 text-zinc-600 dark:text-zinc-400" data-label="Department">
                        {r.department ? (
                          <span className="inline-flex items-center gap-1"><Building2 className="h-3 w-3 text-zinc-400" />{r.department}</span>
                        ) : <span className="text-zinc-400">—</span>}
                      </td>
                      <td className="px-4 py-3 font-mono text-[11px] text-zinc-500 dark:text-zinc-500" data-label="Email">
                        {r.workEmail ?? r.personalEmail ?? '—'}
                      </td>
                      <td className="px-4 py-3 text-right" data-label="Actions">
                        <div className="flex items-center justify-end gap-1.5">
                          <Button
                            type="button"
                            size="sm"
                            variant="outline"
                            onClick={() => setViewTarget(r)}
                            className="h-7 gap-1 border-teal-200 bg-teal-50/60 text-[11px] font-semibold text-teal-700 hover:bg-teal-100 dark:border-teal-700/50 dark:bg-teal-950/30 dark:text-teal-300 dark:hover:bg-teal-950/60"
                          >
                            <Eye className="h-3 w-3" />
                            View
                          </Button>
                          {/* Everyone here is not currently enrolled (never joined or opted out), so the row action is always Opt In — for a former member it re-enrols them on a fresh account. */}
                          <Button
                            type="button"
                            size="sm"
                            variant="outline"
                            onClick={() => setOptInTargets([r])}
                            className="h-7 gap-1 border-teal-200 bg-teal-50/60 text-[11px] font-semibold text-teal-700 hover:bg-teal-100 dark:border-teal-700/50 dark:bg-teal-950/30 dark:text-teal-300 dark:hover:bg-teal-950/60"
                          >
                            <UserPlus className="h-3 w-3" />
                            Opt In
                          </Button>
                        </div>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
          {!loading && filtered.length > BALANCES_PAGE_SIZE && (
            <div data-readonly-allow className="flex items-center justify-between border-t border-teal-100/80 px-5 py-2.5 dark:border-teal-900/40">
              <p className="text-[11px] text-zinc-400">
                {safePage * BALANCES_PAGE_SIZE + 1}–{Math.min((safePage + 1) * BALANCES_PAGE_SIZE, filtered.length)} of {filtered.length}
              </p>
              <div className="flex items-center gap-1">
                <Button variant="outline" size="icon" className="h-7 w-7" disabled={safePage === 0} onClick={() => setPage(0)} aria-label="First page">
                  <ChevronLeft className="h-3 w-3" /><ChevronLeft className="-ml-2 h-3 w-3" />
                </Button>
                <Button variant="outline" size="icon" className="h-7 w-7" disabled={safePage === 0} onClick={() => setPage((p) => Math.max(0, p - 1))} aria-label="Previous page">
                  <ChevronLeft className="h-3 w-3" />
                </Button>
                <span className="min-w-[4rem] text-center text-[11px] text-zinc-500">{safePage + 1} / {totalPages}</span>
                <Button variant="outline" size="icon" className="h-7 w-7" disabled={safePage >= totalPages - 1} onClick={() => setPage((p) => Math.min(totalPages - 1, p + 1))} aria-label="Next page">
                  <ChevronRight className="h-3 w-3" />
                </Button>
                <Button variant="outline" size="icon" className="h-7 w-7" disabled={safePage >= totalPages - 1} onClick={() => setPage(totalPages - 1)} aria-label="Last page">
                  <ChevronRight className="h-3 w-3" /><ChevronRight className="-ml-2 h-3 w-3" />
                </Button>
              </div>
            </div>
          )}
        </CardContent>
      </Card>

      {viewTarget && (
        <MesaMemberDetail member={rosterRowToSummary(viewTarget)} onClose={() => setViewTarget(null)} />
      )}

      {/* Opt In confirmation — direct enrollment flip for one or many, bypassing
          the mesa_requests review queue. Temporary bridge (see comment above). */}
      {optInTargets && optInTargets.length > 0 && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 backdrop-blur-[2px] p-4 animate-in fade-in duration-200 ease-out motion-reduce:animate-none">
          <div className="w-full max-w-sm rounded-2xl border border-zinc-200 bg-white shadow-2xl dark:border-zinc-800 dark:bg-zinc-950 animate-in fade-in zoom-in-95 slide-in-from-bottom-2 duration-200 ease-out motion-reduce:animate-none">
            <div className="flex items-start gap-3 px-5 py-5">
              <div className="flex h-10 w-10 shrink-0 items-center justify-center rounded-full bg-teal-100 text-teal-600 dark:bg-teal-950/40 dark:text-teal-400">
                <UserPlus className="h-5 w-5" />
              </div>
              <div className="min-w-0">
                <h3 className="text-base font-bold text-zinc-900 dark:text-white">
                  {optInTargets.length === 1 ? 'Opt in to MESA?' : `Opt ${optInTargets.length} employees in to MESA?`}
                </h3>
                <p className="mt-1 text-sm leading-relaxed text-zinc-600 dark:text-zinc-400">
                  Starts the ₱100 weekly deduction (+ ₱300 Simple.biz match)
                  {optInTargets.length === 1 ? (
                    <> for <span className="font-medium text-zinc-800 dark:text-zinc-200">{optInTargets[0].name}</span></>
                  ) : (
                    <> for the selected employees</>
                  )}, effective today.
                  {' '}This is a direct enrollment change — it does not go through the request queue.
                </p>
              </div>
            </div>
            <div className="flex items-center justify-end gap-2 border-t border-zinc-200 px-5 py-4 dark:border-zinc-800">
              <Button type="button" variant="outline" size="sm" onClick={() => setOptInTargets(null)} disabled={toggling}>
                Cancel
              </Button>
              <Button
                type="button"
                size="sm"
                disabled={toggling}
                onClick={confirmOptIn}
                className="bg-teal-600 text-white hover:bg-teal-700 dark:bg-teal-600 dark:hover:bg-teal-500"
              >
                <UserPlus className="mr-1.5 h-3.5 w-3.5" />
                {optInTargets.length === 1 ? 'Opt In' : `Opt In (${optInTargets.length})`}
              </Button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

// ── MESA Active Members ──────────────────────────────────────────────────────
//
// Employees currently enrolled: employee_hourly_rates.mesa_member = true AND no
// trailing opt-out in the ledger (isActiveMember). The ledger guard keeps a
// former member off this tab when their flag drifted out of sync (last ledger
// entry is an Opt-out but the flag was never cleared) — they belong on Non
// Members instead. Roster-grounded so a brand-new enrollee shows up at ₱0 even
// before their first ledger row lands. Financial rollup comes from mesa_ledger
// when present. Read-only here — enrollment changes happen on the Non Members
// tab (temporary) or via the mesa_requests review queue.

function MesaActiveMembers() {
  const [rows, setRows] = useState<MesaRosterRow[]>(
    () => getTabCache<MesaRosterRow[]>(TAB_CACHE_KEYS.mesaActiveMembers) ?? [],
  );
  const [loading, setLoading] = useState(!hasTabCache(TAB_CACHE_KEYS.mesaActiveMembers));
  const [refreshing, setRefreshing] = useState(false);
  const [query, setQuery] = useState('');
  const [filterDepartment, setFilterDepartment] = useState('');
  const [page, setPage] = useState(0);
  const [viewTarget, setViewTarget] = useState<MesaRosterRow | null>(null);
  const [optOutTargets, setOptOutTargets] = useState<MesaRosterRow[] | null>(null);
  const [toggling, setToggling] = useState(false);

  const load = async (showSpinner = true) => {
    if (showSpinner) setLoading(true); else setRefreshing(true);
    try {
      const data = (await fetchMesaRoster()).filter(isActiveMember);
      setTabCache(TAB_CACHE_KEYS.mesaActiveMembers, data);
      setRows(data);
    } catch (e) {
      toast.error(e instanceof Error ? e.message : 'Failed to load MESA balances');
    } finally {
      setLoading(false);
      setRefreshing(false);
    }
  };

  useEffect(() => {
    void load(!hasTabCache(TAB_CACHE_KEYS.mesaActiveMembers));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const departments = useMemo(
    () =>
      Array.from(new Set(rows.map((r) => r.department).filter((d): d is string => !!d))).sort((a, b) =>
        a.localeCompare(b),
      ),
    [rows],
  );

  const filtered = useMemo(() => {
    const base = filterDepartment ? rows.filter((r) => r.department === filterDepartment) : rows;
    const q = query.trim().toLowerCase();
    if (!q) return base;
    return base.filter(
      (r) =>
        r.name.toLowerCase().includes(q) ||
        (r.workEmail ?? '').toLowerCase().includes(q) ||
        (r.department ?? '').toLowerCase().includes(q) ||
        (r.accountNumber ?? '').toLowerCase().includes(q),
    );
  }, [rows, query, filterDepartment]);

  useEffect(() => { setPage(0); }, [query, filterDepartment]);

  const totals = useMemo(() => {
    let contributed = 0, matched = 0, disbursed = 0, balance = 0;
    for (const r of rows) {
      if (!r.ledger) continue;
      contributed += r.ledger.contributed;
      matched += r.ledger.matched;
      disbursed += r.ledger.disbursed;
      balance += r.ledger.balance;
    }
    return { contributed, matched, disbursed, balance };
  }, [rows]);

  const totalPages = Math.max(1, Math.ceil(filtered.length / BALANCES_PAGE_SIZE));
  const safePage = Math.min(page, totalPages - 1);
  const pageRows = filtered.slice(safePage * BALANCES_PAGE_SIZE, (safePage + 1) * BALANCES_PAGE_SIZE);

  const sel = useRowSelection(filtered, (r) => r.key);

  const handleRefresh = async () => {
    clearTabCache(TAB_CACHE_KEYS.mesaActiveMembers);
    await load(false);
    toast.success('Refreshed MESA balances');
  };

  // Opt one or many enrolled members out of MESA. Direct enrollment flip —
  // bypasses the mesa_requests review queue (temporary bridge).
  const confirmOptOut = async () => {
    if (!optOutTargets || optOutTargets.length === 0) return;
    setToggling(true);
    const { ok, fail } = await runBulk(optOutTargets, (t) => postToggleMesa(t, false));
    reportBulk('Opted out', ok, fail);
    setOptOutTargets(null);
    sel.clear();
    setToggling(false);
    clearTabCache(TAB_CACHE_KEYS.mesaActiveMembers);
    clearTabCache(TAB_CACHE_KEYS.mesaNonMembers);
    await load(false);
  };

  const fmtSince = formatDateOnly;

  // Export of the members currently in view. Money figures are recomputed over
  // the filtered set so the stat band always matches the exported rows. The
  // per-stint account caveat rides along as a note: opt-out closes the account
  // (history retained under the old number), re-join mints a fresh one.
  const exportSpec = useMemo<MesaExportSpec>(() => {
    const scopeParts = [
      filterDepartment || null,
      query.trim() ? `matching "${query.trim()}"` : null,
    ].filter(Boolean);
    let contributed = 0;
    let matched = 0;
    let balance = 0;
    for (const r of filtered) {
      if (!r.ledger) continue;
      contributed += r.ledger.contributed;
      matched += r.ledger.matched;
      balance += r.ledger.balance;
    }
    return {
      eyebrow: 'Accounting - MESA',
      title: 'MESA Active Members',
      sheetName: 'MESA Active Members',
      fileBase: 'mesa-active-members',
      scopeLabel: scopeParts.length ? scopeParts.join(' · ') : 'All departments',
      countNoun: ['member', 'members'],
      stats: [
        { label: 'Members contributed', value: formatPhpExport(contributed) },
        { label: 'Simple.biz matched', value: formatPhpExport(matched) },
        { label: 'Total balance', value: formatPhpExport(balance) },
        { label: 'Members', value: filtered.length.toLocaleString() },
      ],
      columns: [
        { header: 'Member', pdfWeight: 84, xlsxWidth: 26 },
        { header: 'Email', pdfWeight: 108, xlsxWidth: 32 },
        { header: 'Account #', pdfWeight: 58, xlsxWidth: 14 },
        { header: 'Department', pdfWeight: 58, xlsxWidth: 20 },
        { header: 'Contributed', align: 'right', pdfWeight: 56, xlsxWidth: 15 },
        { header: 'Matched', align: 'right', pdfWeight: 54, xlsxWidth: 15 },
        { header: 'Disbursed', align: 'right', pdfWeight: 54, xlsxWidth: 15 },
        { header: 'Balance', align: 'right', pdfWeight: 56, xlsxWidth: 15 },
        { header: 'Member since', pdfWeight: 56, xlsxWidth: 14 },
      ],
      rows: filtered.map((r) => [
        r.name,
        r.workEmail ?? r.personalEmail ?? '-',
        r.accountNumber ?? '-',
        r.department ?? '-',
        formatPhpExport(r.ledger?.contributed ?? 0),
        formatPhpExport(r.ledger?.matched ?? 0),
        (r.ledger?.disbursed ?? 0) > 0 ? formatPhpExport(r.ledger!.disbursed) : '-',
        formatPhpExport(r.ledger?.balance ?? 0),
        r.mesaMemberSince
          ? (parseDateOnlyLocal(r.mesaMemberSince) ?? new Date(r.mesaMemberSince)).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' })
          : '-',
      ]),
      notes: [
        "Figures are scoped to each member's current (open) MESA account number. Opting out closes that account — its history is retained in the MESA ledger under the previous account number (nothing is deleted) — and a re-join opens a fresh account number starting from PHP 0.00.",
      ],
    };
  }, [filtered, filterDepartment, query]);

  return (
    <div className="space-y-5">
      {/* Summary cards */}
      <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
        <BalanceStat icon={PiggyBank} label="Members contributed" value={formatPHP(totals.contributed)} tone="zinc" />
        <BalanceStat icon={HeartHandshake} label="Simple.biz matched" value={formatPHP(totals.matched)} tone="teal" />
        <BalanceStat icon={Wallet} label="Total balance" value={formatPHP(totals.balance)} tone="teal" />
        <BalanceStat icon={CheckCircle2} label="Enrolled members" value={String(rows.length)} tone="amber" />
      </div>

      {/* Toolbar */}
      <div className="flex flex-wrap items-center gap-2">
        <div className="relative min-w-[200px] flex-1">
          <Search className="pointer-events-none absolute left-3 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-zinc-400" />
          <Input
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="Search name, email, department..."
            className="h-9 border-zinc-200 bg-white pl-9 text-sm focus:border-teal-500 focus:ring-2 focus:ring-teal-500/20 dark:border-zinc-800 dark:bg-zinc-900/60"
          />
        </div>
        <div className="flex items-center gap-1.5">
          <Filter className="h-3.5 w-3.5 text-zinc-400" />
          <SmoothSelect
            aria-label="Filter by department"
            value={filterDepartment}
            onChange={setFilterDepartment}
            triggerClassName="w-44"
            options={[
              { value: '', label: 'All departments' },
              ...departments.map((d) => ({ value: d, label: d })),
            ]}
          />
        </div>
        <Button type="button" variant="outline" size="sm" onClick={handleRefresh} disabled={refreshing || loading} className="gap-1.5">
          <RefreshCw className={cn('h-3.5 w-3.5', refreshing && 'animate-spin')} />
          Refresh
        </Button>
        <MesaExportMenu spec={exportSpec} />
      </div>

      {/* Table */}
      <Card className="overflow-hidden border-teal-100/80 shadow-sm dark:border-teal-900/40">
        <CardHeader className="border-b border-teal-100/80 bg-teal-50/30 px-5 py-3 dark:border-teal-900/40 dark:bg-teal-950/20">
          <CardTitle className="text-sm font-semibold text-zinc-900 dark:text-white">
            {loading ? 'Loading balances...' : `${filtered.length} member${filtered.length === 1 ? '' : 's'}`}
          </CardTitle>
        </CardHeader>
        <CardContent className="p-0">
          {sel.selectedRows.length > 0 && (
            <BulkBar count={sel.selectedRows.length} onClear={sel.clear}>
              <Button type="button" size="sm" variant="outline" disabled={toggling} onClick={() => setOptOutTargets(sel.selectedRows)} className="h-7 border-amber-200 bg-amber-50 text-[11px] text-amber-700 hover:bg-amber-100 dark:border-amber-700/50 dark:bg-amber-950/30 dark:text-amber-300">
                <UserMinus className="mr-1 h-3 w-3" />Opt Out
              </Button>
            </BulkBar>
          )}
          {loading ? (
            <SkeletonRows count={8} />
          ) : filtered.length === 0 ? (
            <div className="flex flex-col items-center justify-center gap-2 px-5 py-12 text-center text-sm text-zinc-500 dark:text-zinc-400">
              <Inbox className="h-6 w-6 text-zinc-400" />
              {rows.length === 0 ? 'No MESA members enrolled yet.' : 'No results match your search.'}
            </div>
          ) : (
            <div className="overflow-x-auto">
              <table className="w-full text-left text-xs">
                <thead className="border-b border-teal-100/80 bg-teal-50/40 text-[11px] font-semibold uppercase tracking-wide text-teal-700 dark:border-teal-900/40 dark:bg-teal-950/30 dark:text-teal-300">
                  <tr>
                    <th className="w-8 px-3 py-2.5">
                      <SelectCheckbox checked={sel.allSelected} indeterminate={sel.someSelected} onChange={sel.toggleAll} ariaLabel="Select all members" />
                    </th>
                    <th className="px-4 py-2.5">Member</th>
                    <th className="px-4 py-2.5">Account #</th>
                    <th className="px-4 py-2.5">Department</th>
                    <th className="px-4 py-2.5 text-right">Contributed</th>
                    <th className="px-4 py-2.5 text-right">Matched</th>
                    <th className="px-4 py-2.5 text-right">Disbursed</th>
                    <th className="px-4 py-2.5 text-right">Balance</th>
                    <th className="px-4 py-2.5 text-right">Member since</th>
                    <th className="px-4 py-2.5 text-right">Actions</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-teal-100/60 dark:divide-teal-900/40">
                  {pageRows.map((r) => (
                    <tr key={r.key} className={cn('transition-colors hover:bg-teal-50/40 dark:hover:bg-teal-950/20', sel.selectedKeys.has(r.key) && 'bg-teal-50/60 dark:bg-teal-950/30')}>
                      <td className="px-3 py-3" data-label="Select">
                        <SelectCheckbox checked={sel.selectedKeys.has(r.key)} onChange={() => sel.toggle(r.key)} ariaLabel={`Select ${r.name}`} />
                      </td>
                      <td className="px-4 py-3" data-label="Member">
                        <div className="font-medium text-zinc-900 dark:text-zinc-100">{r.name}</div>
                        <div className="mt-0.5 font-mono text-[11px] text-zinc-500 dark:text-zinc-500">{r.workEmail ?? r.personalEmail}</div>
                      </td>
                      <td className="px-4 py-3" data-label="Account #">
                        {r.accountNumber ? (
                          <span className="inline-flex rounded-md border border-teal-200 bg-teal-50/60 px-1.5 py-0.5 font-mono text-[11px] font-semibold tabular-nums text-teal-700 dark:border-teal-700/50 dark:bg-teal-950/30 dark:text-teal-300">
                            {r.accountNumber}
                          </span>
                        ) : <span className="text-zinc-400">—</span>}
                      </td>
                      <td className="px-4 py-3 text-zinc-600 dark:text-zinc-400" data-label="Department">
                        {r.department ? (
                          <span className="inline-flex items-center gap-1"><Building2 className="h-3 w-3 text-zinc-400" />{r.department}</span>
                        ) : <span className="text-zinc-400">—</span>}
                      </td>
                      <td className="px-4 py-3 text-right font-mono tabular-nums text-zinc-700 dark:text-zinc-300" data-label="Contributed">
                        {formatPHP(r.ledger?.contributed ?? 0)}
                        <div className="text-[10px] font-normal text-zinc-400">{r.ledger?.depositCount ?? 0} wk{(r.ledger?.depositCount ?? 0) === 1 ? '' : 's'}</div>
                      </td>
                      <td className="px-4 py-3 text-right font-mono tabular-nums text-teal-700 dark:text-teal-300" data-label="Matched">
                        {formatPHP(r.ledger?.matched ?? 0)}
                      </td>
                      <td className="px-4 py-3 text-right font-mono tabular-nums text-amber-700 dark:text-amber-300" data-label="Disbursed">
                        {(r.ledger?.disbursed ?? 0) > 0 ? formatPHP(r.ledger!.disbursed) : <span className="text-zinc-400">—</span>}
                      </td>
                      <td className="px-4 py-3 text-right font-mono font-semibold tabular-nums text-zinc-900 dark:text-white" data-label="Balance">
                        {formatPHP(r.ledger?.balance ?? 0)}
                      </td>
                      <td className="px-4 py-3 text-right text-zinc-500 dark:text-zinc-400" data-label="Member since">
                        {fmtSince(r.mesaMemberSince)}
                      </td>
                      <td className="px-4 py-3 text-right" data-label="Actions">
                        <div className="flex items-center justify-end gap-1.5">
                          <Button
                            type="button"
                            size="sm"
                            variant="outline"
                            onClick={() => setViewTarget(r)}
                            className="h-7 gap-1 border-teal-200 bg-teal-50/60 text-[11px] font-semibold text-teal-700 hover:bg-teal-100 dark:border-teal-700/50 dark:bg-teal-950/30 dark:text-teal-300 dark:hover:bg-teal-950/60"
                          >
                            <Eye className="h-3 w-3" />
                            View
                          </Button>
                          <Button
                            type="button"
                            size="sm"
                            variant="outline"
                            onClick={() => setOptOutTargets([r])}
                            className="h-7 gap-1 border-amber-200 bg-amber-50/60 text-[11px] font-semibold text-amber-700 hover:bg-amber-100 dark:border-amber-700/50 dark:bg-amber-950/30 dark:text-amber-300 dark:hover:bg-amber-950/60"
                          >
                            <UserMinus className="h-3 w-3" />
                            Opt Out
                          </Button>
                        </div>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
          {!loading && filtered.length > BALANCES_PAGE_SIZE && (
            <div data-readonly-allow className="flex items-center justify-between border-t border-teal-100/80 px-5 py-2.5 dark:border-teal-900/40">
              <p className="text-[11px] text-zinc-400">
                {safePage * BALANCES_PAGE_SIZE + 1}–{Math.min((safePage + 1) * BALANCES_PAGE_SIZE, filtered.length)} of {filtered.length}
              </p>
              <div className="flex items-center gap-1">
                <Button variant="outline" size="icon" className="h-7 w-7" disabled={safePage === 0} onClick={() => setPage(0)} aria-label="First page">
                  <ChevronLeft className="h-3 w-3" /><ChevronLeft className="-ml-2 h-3 w-3" />
                </Button>
                <Button variant="outline" size="icon" className="h-7 w-7" disabled={safePage === 0} onClick={() => setPage((p) => Math.max(0, p - 1))} aria-label="Previous page">
                  <ChevronLeft className="h-3 w-3" />
                </Button>
                <span className="min-w-[4rem] text-center text-[11px] text-zinc-500">{safePage + 1} / {totalPages}</span>
                <Button variant="outline" size="icon" className="h-7 w-7" disabled={safePage >= totalPages - 1} onClick={() => setPage((p) => Math.min(totalPages - 1, p + 1))} aria-label="Next page">
                  <ChevronRight className="h-3 w-3" />
                </Button>
                <Button variant="outline" size="icon" className="h-7 w-7" disabled={safePage >= totalPages - 1} onClick={() => setPage(totalPages - 1)} aria-label="Last page">
                  <ChevronRight className="h-3 w-3" /><ChevronRight className="-ml-2 h-3 w-3" />
                </Button>
              </div>
            </div>
          )}
        </CardContent>
      </Card>

      {viewTarget && (
        <MesaMemberDetail member={rosterRowToSummary(viewTarget)} onClose={() => setViewTarget(null)} />
      )}

      {/* Opt Out confirmation — direct enrollment flip for one or many,
          bypassing the mesa_requests review queue. Temporary bridge. */}
      {optOutTargets && optOutTargets.length > 0 && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 backdrop-blur-[2px] p-4 animate-in fade-in duration-200 ease-out motion-reduce:animate-none">
          <div className="w-full max-w-sm rounded-2xl border border-zinc-200 bg-white shadow-2xl dark:border-zinc-800 dark:bg-zinc-950 animate-in fade-in zoom-in-95 slide-in-from-bottom-2 duration-200 ease-out motion-reduce:animate-none">
            <div className="flex items-start gap-3 px-5 py-5">
              <div className="flex h-10 w-10 shrink-0 items-center justify-center rounded-full bg-amber-100 text-amber-600 dark:bg-amber-950/40 dark:text-amber-400">
                <UserMinus className="h-5 w-5" />
              </div>
              <div className="min-w-0">
                <h3 className="text-base font-bold text-zinc-900 dark:text-white">
                  {optOutTargets.length === 1 ? 'Opt out of MESA?' : `Opt ${optOutTargets.length} members out of MESA?`}
                </h3>
                <p className="mt-1 text-sm leading-relaxed text-zinc-600 dark:text-zinc-400">
                  Stops the ₱100 weekly deduction
                  {optOutTargets.length === 1 ? (
                    <> for <span className="font-medium text-zinc-800 dark:text-zinc-200">{optOutTargets[0].name}</span></>
                  ) : (
                    <> for the selected members</>
                  )} going forward.
                  {' '}This is a direct enrollment change — it does not go through the request queue.
                </p>
              </div>
            </div>
            <div className="flex items-center justify-end gap-2 border-t border-zinc-200 px-5 py-4 dark:border-zinc-800">
              <Button type="button" variant="outline" size="sm" onClick={() => setOptOutTargets(null)} disabled={toggling}>
                Cancel
              </Button>
              <Button
                type="button"
                size="sm"
                disabled={toggling}
                onClick={confirmOptOut}
                className="bg-amber-600 text-white hover:bg-amber-700 dark:bg-amber-600 dark:hover:bg-amber-500"
              >
                <UserMinus className="mr-1.5 h-3.5 w-3.5" />
                {optOutTargets.length === 1 ? 'Opt Out' : `Opt Out (${optOutTargets.length})`}
              </Button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

// Drill-down modal: a member's full MESA history — contribution timeline,
// request history, and internal notes. Fetches /api/mesa-ledger,
// /api/mesa-requests, and /api/mesa-notes (all ?email=) in parallel on open.
function MesaMemberDetail({
  member,
  onClose,
}: {
  member: MesaMemberSummary;
  onClose: () => void;
}) {
  const [events, setEvents] = useState<MesaLedgerEvent[]>([]);
  const [summary, setSummary] = useState<MesaMemberSummary>(member);
  const [requests, setRequests] = useState<MesaRequest[]>([]);
  const [notes, setNotes] = useState<MesaNote[]>([]);
  const [loading, setLoading] = useState(true);
  const [tab, setTab] = useState<'timeline' | 'requests' | 'notes'>('timeline');
  const [noteBody, setNoteBody] = useState('');
  const [postingNote, setPostingNote] = useState(false);

  // Fetch the member's history ONCE per opened member. Keyed on the email
  // string only — NOT the `member` object: the parent rebuilds a fresh summary
  // object (rosterRowToSummary) on every render, so depending on the object
  // would re-run this on each parent re-render and the modal would visibly
  // reload (skeletons flashing, endpoints re-hit). The initial `member` already
  // seeds `summary` via useState, so a failed fetch simply keeps it.
  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    const email = encodeURIComponent(member.email);
    Promise.all([
      fetch(`/api/mesa-ledger?email=${email}`, { cache: 'no-store' })
        .then((r) => (r.ok ? r.json() : { summary: null, events: [] }))
        .catch(() => ({ summary: null, events: [] })) as Promise<{
        summary?: MesaMemberSummary | null;
        events?: MesaLedgerEvent[];
      }>,
      fetch(`/api/mesa-requests?email=${email}`, { cache: 'no-store' })
        .then((r) => (r.ok ? r.json() : { rows: [] }))
        .catch(() => ({ rows: [] })) as Promise<{ rows?: MesaRequest[] }>,
      fetch(`/api/mesa-notes?email=${email}`, { cache: 'no-store' })
        .then((r) => (r.ok ? r.json() : { notes: [] }))
        .catch(() => ({ notes: [] })) as Promise<{ notes?: MesaNote[] }>,
    ])
      .then(([ledgerJson, requestsJson, notesJson]) => {
        if (cancelled) return;
        if (ledgerJson.summary) setSummary(ledgerJson.summary);
        setEvents(ledgerJson.events ?? []);
        setRequests(requestsJson.rows ?? []);
        setNotes(notesJson.notes ?? []);
      })
      .finally(() => { if (!cancelled) setLoading(false); });
    return () => { cancelled = true; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [member.email]);

  // Build a unified, newest-first timeline of deposits and disbursements,
  // carrying along each event's frozen legacy notes (if any).
  const lines = useMemo(() => {
    const out: {
      key: string;
      date: string | null;
      kind: 'deposit' | 'disbursement';
      you: number;
      company: number;
      total: number;
      label: string | null;
      notes: string | null;
      additionalNotes: string | null;
    }[] = [];
    for (const e of events) {
      if ((e.total_daily_deposit_php ?? 0) > 0 && e.deposit_date) {
        out.push({
          key: `d-${e.id}`,
          date: e.deposit_date,
          kind: 'deposit',
          you: e.worker_contribution_php ?? 0,
          company: e.simple_match_php ?? 0,
          total: e.total_daily_deposit_php ?? 0,
          label: null,
          notes: e.notes,
          additionalNotes: e.additional_notes,
        });
      }
      if ((e.disbursement_amount_php ?? 0) > 0 && e.disbursement_date) {
        out.push({
          key: `x-${e.id}`,
          date: e.disbursement_date,
          kind: 'disbursement',
          you: 0,
          company: 0,
          total: -(e.disbursement_amount_php ?? 0),
          label: e.disbursement_type || 'Disbursement',
          notes: e.notes,
          additionalNotes: e.additional_notes,
        });
      }
    }
    out.sort((a, b) => (b.date ?? '').localeCompare(a.date ?? ''));
    return out;
  }, [events]);

  const submitNote = async () => {
    const trimmed = noteBody.trim();
    if (!trimmed) return;
    setPostingNote(true);
    try {
      const res = await fetch('/api/mesa-notes', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ member_email: member.email, body: trimmed }),
      });
      const j = (await res.json()) as { note?: MesaNote; error?: string };
      if (!res.ok) throw new Error(j.error ?? `HTTP ${res.status}`);
      if (j.note) setNotes((prev) => [j.note!, ...prev]);
      setNoteBody('');
      toast.success('Note added');
    } catch (e) {
      toast.error(e instanceof Error ? e.message : 'Failed to add note');
    } finally {
      setPostingNote(false);
    }
  };

  const fmtDate = formatDateOnly;

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4 backdrop-blur-[2px] animate-in fade-in duration-200 ease-out motion-reduce:animate-none">
      <div className="flex max-h-[85vh] w-full max-w-2xl flex-col overflow-hidden rounded-2xl border border-zinc-200 bg-white shadow-2xl dark:border-zinc-800 dark:bg-zinc-950 animate-in fade-in zoom-in-95 slide-in-from-bottom-2 duration-200 ease-out motion-reduce:animate-none">
        {/* Header */}
        <div className="flex items-start justify-between border-b border-zinc-200 px-5 py-4 dark:border-zinc-800">
          <div className="min-w-0">
            <p className="text-[11px] font-semibold uppercase tracking-wide text-teal-600 dark:text-teal-400">
              MESA contribution history
            </p>
            <h3 className="mt-0.5 truncate text-base font-bold text-zinc-900 dark:text-white">
              {summary.name ?? summary.email}
            </h3>
            <p className="mt-0.5 truncate font-mono text-[11px] text-zinc-500 dark:text-zinc-500">
              {summary.email}
              {summary.department ? ` · ${summary.department}` : ''}
              {summary.accountNumber ? ` · Acct ${summary.accountNumber}` : ''}
            </p>
          </div>
          <button
            type="button"
            onClick={onClose}
            className="rounded-md p-1.5 text-zinc-400 hover:bg-zinc-100 hover:text-zinc-600 dark:hover:bg-zinc-800 dark:hover:text-zinc-300"
            aria-label="Close"
          >
            <X className="h-4 w-4" />
          </button>
        </div>

        {/* Summary cards */}
        <div className="grid grid-cols-2 gap-3 border-b border-zinc-100 px-5 py-4 sm:grid-cols-4 dark:border-zinc-800/80">
          <DetailStat label="Contributed" value={formatPHP(summary.contributed)} sub={`${summary.depositCount} wk${summary.depositCount === 1 ? '' : 's'}`} />
          <DetailStat label="Simple.biz matched" value={formatPHP(summary.matched)} sub="3× match" accent />
          <DetailStat label="Disbursed" value={summary.disbursed > 0 ? formatPHP(summary.disbursed) : '—'} sub={summary.disbursementCount > 0 ? `${summary.disbursementCount}×` : 'none'} />
          <DetailStat label="Balance" value={formatPHP(summary.balance)} sub="current" strong />
        </div>

        {/* Date range */}
        <div className="flex flex-wrap items-center gap-x-5 gap-y-1 border-b border-zinc-100 px-5 py-2.5 text-[11px] text-zinc-500 dark:border-zinc-800/80 dark:text-zinc-400">
          <span className="inline-flex items-center gap-1"><CalendarClock className="h-3 w-3" /> First deposit: <span className="font-medium text-zinc-700 dark:text-zinc-300">{fmtDate(summary.firstDeposit)}</span></span>
          <span className="inline-flex items-center gap-1">Last deposit: <span className="font-medium text-zinc-700 dark:text-zinc-300">{fmtDate(summary.lastDeposit)}</span></span>
          {summary.lastDisbursement && (
            <span className="inline-flex items-center gap-1">Last disbursement: <span className="font-medium text-zinc-700 dark:text-zinc-300">{fmtDate(summary.lastDisbursement)}</span></span>
          )}
        </div>

        {/* Tabs */}
        <div className="border-b border-zinc-100 px-5 py-2 dark:border-zinc-800/80">
          <div
            role="tablist"
            aria-label="Member detail sections"
            className="inline-flex items-center gap-1 rounded-lg border border-zinc-200 bg-zinc-50/70 p-1 dark:border-zinc-800 dark:bg-zinc-900/40"
          >
            <ViewTabButton active={tab === 'timeline'} onClick={() => setTab('timeline')} icon={Wallet} label={`Timeline (${lines.length})`} layoutId="mesa-detail-tab-pill" />
            <ViewTabButton active={tab === 'requests'} onClick={() => setTab('requests')} icon={ClipboardList} label={`Requests (${requests.length})`} layoutId="mesa-detail-tab-pill" />
            <ViewTabButton active={tab === 'notes'} onClick={() => setTab('notes')} icon={StickyNote} label={`Notes (${notes.length})`} layoutId="mesa-detail-tab-pill" />
          </div>
        </div>

        {/* Tab content */}
        <div className="flex min-h-0 flex-1 flex-col overflow-hidden">
          {tab === 'timeline' && (
            <div className="min-h-0 flex-1 overflow-y-auto">
              {loading ? (
                <div className="space-y-2 p-5">
                  {[1, 2, 3, 4].map((i) => (
                    <div key={i} className="h-9 w-full animate-pulse rounded-lg bg-zinc-100 dark:bg-zinc-800" />
                  ))}
                </div>
              ) : lines.length === 0 ? (
                <div className="flex flex-col items-center justify-center gap-2 px-5 py-12 text-center text-sm text-zinc-500 dark:text-zinc-400">
                  <Inbox className="h-6 w-6 text-zinc-400" />
                  No recorded deposits or disbursements.
                </div>
              ) : (
                <table className="w-full text-left text-xs">
                  <thead className="sticky top-0 border-b border-zinc-100 bg-zinc-50/95 text-[11px] font-semibold uppercase tracking-wide text-zinc-500 backdrop-blur dark:border-zinc-800/80 dark:bg-zinc-900/95 dark:text-zinc-400">
                    <tr>
                      <th className="px-5 py-2">Date</th>
                      <th className="px-4 py-2">Type</th>
                      <th className="px-4 py-2 text-right">You</th>
                      <th className="px-4 py-2 text-right">Simple.biz</th>
                      <th className="px-5 py-2 text-right">Amount</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-zinc-100 dark:divide-zinc-800/80">
                    {lines.map((l) => (
                      <React.Fragment key={l.key}>
                        <tr className={cn(l.kind === 'disbursement' && 'bg-amber-50/40 dark:bg-amber-500/5')}>
                          <td className="px-5 py-2 font-medium text-zinc-700 dark:text-zinc-300" data-label="Date">{fmtDate(l.date)}</td>
                          <td className="px-4 py-2" data-label="Type">
                            {l.kind === 'deposit' ? (
                              <span className="inline-flex items-center gap-1 text-teal-700 dark:text-teal-300">
                                <ArrowDownCircle className="h-3 w-3" /> Deposit
                              </span>
                            ) : (
                              <span className="inline-flex items-center gap-1 text-amber-700 dark:text-amber-300">
                                <ArrowUpCircle className="h-3 w-3" /> {l.label}
                              </span>
                            )}
                          </td>
                          <td className="px-4 py-2 text-right tabular-nums text-zinc-600 dark:text-zinc-400" data-label="You">
                            {l.kind === 'deposit' ? formatPHP(l.you) : '—'}
                          </td>
                          <td className="px-4 py-2 text-right tabular-nums text-zinc-600 dark:text-zinc-400" data-label="Simple.biz">
                            {l.kind === 'deposit' ? formatPHP(l.company) : '—'}
                          </td>
                          <td className={cn('px-5 py-2 text-right font-semibold tabular-nums', l.total < 0 ? 'text-amber-700 dark:text-amber-300' : 'text-zinc-900 dark:text-white')} data-label="Amount">
                            {l.total < 0 ? `−${formatPHP(Math.abs(l.total))}` : formatPHP(l.total)}
                          </td>
                        </tr>
                        {(l.notes || l.additionalNotes) && (
                          <tr className={cn(l.kind === 'disbursement' && 'bg-amber-50/40 dark:bg-amber-500/5')}>
                            <td colSpan={5} className="px-5 pb-2 text-[11px] italic text-zinc-500 dark:text-zinc-500">
                              {l.notes && <div>Note: {l.notes}</div>}
                              {l.additionalNotes && <div>Additional: {l.additionalNotes}</div>}
                            </td>
                          </tr>
                        )}
                      </React.Fragment>
                    ))}
                  </tbody>
                </table>
              )}
            </div>
          )}

          {tab === 'requests' && (
            <div className="min-h-0 flex-1 overflow-y-auto">
              {loading ? (
                <div className="space-y-2 p-5">
                  {[1, 2, 3].map((i) => (
                    <div key={i} className="h-9 w-full animate-pulse rounded-lg bg-zinc-100 dark:bg-zinc-800" />
                  ))}
                </div>
              ) : requests.length === 0 ? (
                <div className="flex flex-col items-center justify-center gap-2 px-5 py-12 text-center text-sm text-zinc-500 dark:text-zinc-400">
                  <Inbox className="h-6 w-6 text-zinc-400" />
                  No MESA requests from this member yet.
                </div>
              ) : (
                <div className="divide-y divide-zinc-100 dark:divide-zinc-800/80">
                  {requests.map((r) => (
                    <div key={r.id} className="px-5 py-3">
                      <div className="flex items-center justify-between gap-2">
                        <div className="flex items-center gap-2">
                          <Badge variant="outline" className={cn('text-[10.5px] font-semibold uppercase tracking-wide', TYPE_COLORS[r.request_type])}>
                            {TYPE_LABELS[r.request_type]}
                          </Badge>
                          <StatusBadge status={r.status} />
                        </div>
                        <span className="text-[11px] text-zinc-400">
                          {new Date(r.created_at).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' })}
                        </span>
                      </div>
                      {r.amount_needed != null && (
                        <p className="mt-1 font-mono text-xs text-zinc-700 dark:text-zinc-300">{formatPHP(r.amount_needed)}</p>
                      )}
                      {r.disbursement_reason && (
                        <p className="mt-1 text-xs text-zinc-600 dark:text-zinc-400">{r.disbursement_reason}</p>
                      )}
                      {r.explanation && (
                        <p className="mt-1 text-xs italic text-zinc-500 dark:text-zinc-500">{r.explanation}</p>
                      )}
                      {r.status !== 'pending' && r.review_notes && (
                        <p className="mt-1 text-xs italic text-zinc-500 dark:text-zinc-500">Review: {r.review_notes}</p>
                      )}
                    </div>
                  ))}
                </div>
              )}
            </div>
          )}

          {tab === 'notes' && (
            <>
              <div className="border-b border-zinc-100 p-4 dark:border-zinc-800/80">
                <textarea
                  value={noteBody}
                  onChange={(e) => setNoteBody(e.target.value.slice(0, 500))}
                  rows={3}
                  placeholder="Add an internal note about this member..."
                  className="w-full rounded-md border border-zinc-200 bg-white px-3 py-2 text-sm text-zinc-900 placeholder-zinc-400 focus:border-teal-500 focus:outline-none focus:ring-2 focus:ring-teal-500/20 dark:border-zinc-700 dark:bg-zinc-900 dark:text-zinc-100"
                />
                <div className="mt-1.5 flex items-center justify-between">
                  <span className="text-[11px] text-zinc-400">{noteBody.length}/500 characters</span>
                  <Button
                    type="button"
                    size="sm"
                    disabled={!noteBody.trim() || postingNote}
                    onClick={submitNote}
                    className="h-7 bg-teal-600 text-white hover:bg-teal-700 dark:bg-teal-600 dark:hover:bg-teal-500"
                  >
                    Add note
                  </Button>
                </div>
              </div>
              <div className="min-h-0 flex-1 overflow-y-auto">
                {loading ? (
                  <div className="space-y-2 p-5">
                    {[1, 2].map((i) => (
                      <div key={i} className="h-9 w-full animate-pulse rounded-lg bg-zinc-100 dark:bg-zinc-800" />
                    ))}
                  </div>
                ) : notes.length === 0 ? (
                  <div className="flex flex-col items-center justify-center gap-2 px-5 py-12 text-center text-sm text-zinc-500 dark:text-zinc-400">
                    <Inbox className="h-6 w-6 text-zinc-400" />
                    No notes yet — add the first one above.
                  </div>
                ) : (
                  <div className="divide-y divide-zinc-100 dark:divide-zinc-800/80">
                    {notes.map((n) => (
                      <div key={n.id} className="px-5 py-3">
                        <p className="text-sm text-zinc-700 dark:text-zinc-300">{n.body}</p>
                        <p className="mt-1 text-[11px] text-zinc-400">
                          {n.author_name ?? n.author_email} · {new Date(n.created_at).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' })}
                        </p>
                      </div>
                    ))}
                  </div>
                )}
              </div>
            </>
          )}
        </div>

        {/* Footer */}
        <div className="flex items-center justify-between border-t border-zinc-200 px-5 py-3 dark:border-zinc-800">
          <span className="text-[11px] text-zinc-400">
            {loading
              ? 'Loading…'
              : tab === 'timeline'
              ? `${lines.length} event${lines.length === 1 ? '' : 's'}`
              : tab === 'requests'
              ? `${requests.length} request${requests.length === 1 ? '' : 's'}`
              : `${notes.length} note${notes.length === 1 ? '' : 's'}`}
          </span>
          <Button type="button" variant="outline" size="sm" onClick={onClose}>Close</Button>
        </div>
      </div>
    </div>
  );
}

function DetailStat({
  label,
  value,
  sub,
  accent,
  strong,
}: {
  label: string;
  value: string;
  sub?: string;
  accent?: boolean;
  strong?: boolean;
}) {
  return (
    <div className="min-w-0">
      <p className="truncate text-[10.5px] font-medium uppercase tracking-wide text-zinc-400 dark:text-zinc-500">{label}</p>
      <p className={cn(
        'mt-0.5 truncate font-mono text-base font-bold tabular-nums',
        accent ? 'text-teal-700 dark:text-teal-300' : strong ? 'text-zinc-900 dark:text-white' : 'text-zinc-800 dark:text-zinc-200',
      )}>
        {value}
      </p>
      {sub && <p className="truncate text-[10px] text-zinc-400">{sub}</p>}
    </div>
  );
}

function BalanceStat({
  icon: Icon,
  label,
  value,
  tone,
}: {
  icon: React.ComponentType<{ className?: string }>;
  label: string;
  value: string;
  tone: 'teal' | 'zinc' | 'amber';
}) {
  const styles = {
    teal: 'border-teal-200 bg-gradient-to-br from-teal-50 to-white text-teal-900 dark:border-teal-700/40 dark:from-teal-950/40 dark:to-zinc-950 dark:text-teal-100',
    zinc: 'border-zinc-200 bg-white text-zinc-900 dark:border-zinc-800 dark:bg-zinc-900/40 dark:text-zinc-100',
    amber: 'border-amber-200 bg-gradient-to-br from-amber-50 to-white text-amber-900 dark:border-amber-700/40 dark:from-amber-950/40 dark:to-zinc-950 dark:text-amber-100',
  }[tone];
  return (
    <div className={`rounded-xl border p-4 shadow-sm ${styles}`}>
      <div className="flex items-center gap-1.5 opacity-70">
        <Icon className="h-3.5 w-3.5" />
        <p className="text-[11px] font-medium uppercase tracking-wide">{label}</p>
      </div>
      <p className="mt-1 font-mono text-xl font-bold tabular-nums">{value}</p>
    </div>
  );
}
