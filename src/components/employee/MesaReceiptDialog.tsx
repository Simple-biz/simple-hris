'use client';

/**
 * MESA disbursement receipts — the member's upload surface.
 *
 * Opened from the Receipt column in Employee → MESA → Request → Past requests.
 * Up to three files (photos or PDFs) per disbursement request; the point of them
 * is Accounting: a request with its receipt attached is one they can confirm was
 * legitimate without chasing an email thread.
 *
 * Portaled to <body> on purpose. The MESA tab's content sits inside a
 * `motion.div` that animates `filter`, and a non-`none` filter makes an element
 * the containing block for its fixed-position descendants — an in-place overlay
 * would be clipped to the tab panel instead of covering the viewport.
 */

import React from 'react';
import { createPortal } from 'react-dom';
import { AnimatePresence, motion, useReducedMotion } from 'motion/react';
import {
  CheckCircle2,
  ExternalLink,
  FileText,
  ImageIcon,
  Loader2,
  Paperclip,
  ReceiptText,
  ShieldCheck,
  Trash2,
  UploadCloud,
  X,
} from 'lucide-react';
import { toast } from 'sonner';
import { Button } from '@/components/ui/button';
import { cn } from '@/lib/utils';
import { parseDateOnlyLocal } from '@/lib/date-only';
import {
  MAX_MESA_RECEIPTS,
  MAX_MESA_RECEIPT_BYTES,
  MESA_RECEIPT_ACCEPT,
  formatReceiptSize,
  isAllowedMesaReceiptType,
  isMesaReceiptImage,
  mesaReceiptMimeOf,
  type MesaReceiptWithUrl,
} from '@/lib/mesa/receipt-types';

/** The parent request, as much of it as the dialog header needs. */
export interface MesaReceiptRequest {
  id: string;
  disbursement_reason: string | null;
  amount_needed: number | null;
  created_at: string;
  status: string;
}

/** A file the member has picked but not yet sent. */
type StagedFile = {
  key: string;
  file: File;
  mime: string;
  /** Object URL for the thumbnail; images only. */
  previewUrl: string | null;
};

const formatPeso = (n: number) =>
  `₱${n.toLocaleString('en-PH', {
    minimumFractionDigits: Number.isInteger(n) ? 0 : 2,
    maximumFractionDigits: 2,
  })}`;

const formatDay = (raw: string | null | undefined) => {
  if (!raw) return '—';
  const d = parseDateOnlyLocal(raw) ?? new Date(raw);
  return Number.isNaN(d.getTime())
    ? '—'
    : d.toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' });
};

export default function MesaReceiptDialog({
  request,
  open,
  onClose,
  onCountChange,
}: {
  request: MesaReceiptRequest | null;
  open: boolean;
  onClose: () => void;
  /** Fired after every successful upload/removal so the Past requests row can
   *  re-render its chip without re-fetching the whole list. */
  onCountChange?: (requestId: string, count: number) => void;
}) {
  const reduceMotion = useReducedMotion();
  const [mounted, setMounted] = React.useState(false);
  const [receipts, setReceipts] = React.useState<MesaReceiptWithUrl[]>([]);
  const [loading, setLoading] = React.useState(true);
  const [loadError, setLoadError] = React.useState<string | null>(null);
  const [staged, setStaged] = React.useState<StagedFile[]>([]);
  const [dragOver, setDragOver] = React.useState(false);
  /** null = idle; otherwise "uploading file `done+1` of `total`". */
  const [progress, setProgress] = React.useState<{ done: number; total: number } | null>(null);
  const [removingId, setRemovingId] = React.useState<string | null>(null);
  /** Thumbnails that failed to decode (HEIC, mostly) fall back to the file icon. */
  const [brokenThumbs, setBrokenThumbs] = React.useState<Set<string>>(new Set());

  const fileInputRef = React.useRef<HTMLInputElement | null>(null);
  const panelRef = React.useRef<HTMLDivElement | null>(null);
  /** Object URLs to revoke — read in cleanup, so it must not be state. */
  const objectUrlsRef = React.useRef<Set<string>>(new Set());
  /** Monotonic id for staged files. Name+size+mtime is NOT unique — picking the
   *  same file in two separate batches would collide, giving duplicate React keys
   *  and making one "remove" drop both rows. */
  const stagedSeqRef = React.useRef(0);

  const uploading = progress !== null;
  const busy = uploading || removingId !== null;
  const used = receipts.length + staged.length;
  const slotsLeft = Math.max(0, MAX_MESA_RECEIPTS - used);
  const requestId = request?.id ?? null;
  // Also closed while the already-attached files are still loading: until they
  // land, `slotsLeft` is a guess, and picking against a guess is how a member
  // stages a fourth file only to have the server refuse it.
  const dropDisabled = busy || loading || slotsLeft === 0;

  React.useEffect(() => setMounted(true), []);

  // Revoke every object URL this dialog ever made, once, on unmount. Per-file
  // revocation happens in removeStaged/clearStaged; this is the backstop for a
  // dialog closed mid-stage.
  React.useEffect(() => {
    const urls = objectUrlsRef.current;
    return () => {
      urls.forEach((u) => URL.revokeObjectURL(u));
      urls.clear();
    };
  }, []);

  const clearStaged = React.useCallback(() => {
    setStaged((prev) => {
      prev.forEach((s) => {
        if (s.previewUrl) {
          URL.revokeObjectURL(s.previewUrl);
          objectUrlsRef.current.delete(s.previewUrl);
        }
      });
      return [];
    });
  }, []);

  // Load on open. Closing clears staged files so re-opening never shows a file
  // the member abandoned last time.
  React.useEffect(() => {
    if (!open || !requestId) return;
    let cancelled = false;
    setLoading(true);
    setLoadError(null);
    // Drop the previous request's files rather than counting them toward this
    // one's three slots while the fetch is in flight.
    setReceipts([]);
    fetch(`/api/mesa-requests/${requestId}/receipts`, { cache: 'no-store' })
      .then(async (r) => {
        const json = (await r.json().catch(() => ({}))) as {
          rows?: MesaReceiptWithUrl[];
          error?: string;
        };
        if (!r.ok) throw new Error(json.error ?? `HTTP ${r.status}`);
        return json.rows ?? [];
      })
      .then((rows) => {
        if (cancelled) return;
        setReceipts(rows);
        onCountChange?.(requestId, rows.length);
      })
      .catch((e: unknown) => {
        if (!cancelled) setLoadError(e instanceof Error ? e.message : 'Could not load your receipts');
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
    // onCountChange is a stable callback from the parent; re-running on it would
    // re-fetch on every parent render.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, requestId]);

  React.useEffect(() => {
    if (!open) clearStaged();
  }, [open, clearStaged]);

  // Escape closes (never mid-upload — that would orphan the in-flight file), and
  // the page behind the dialog must not scroll under it.
  React.useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape' && !busy) {
        e.stopPropagation();
        onClose();
      }
    };
    window.addEventListener('keydown', onKey);
    const prevOverflow = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    // Focus the panel so Escape and Tab land inside the dialog, not on whatever
    // the member last clicked in the table behind it.
    const t = window.setTimeout(() => panelRef.current?.focus(), 40);
    return () => {
      window.removeEventListener('keydown', onKey);
      document.body.style.overflow = prevOverflow;
      window.clearTimeout(t);
    };
  }, [open, busy, onClose]);

  /** Validate + stage picked files, respecting the remaining slots. */
  const addFiles = (incoming: FileList | File[]) => {
    const list = Array.from(incoming);
    if (list.length === 0) return;

    const accepted: StagedFile[] = [];
    const rejected: string[] = [];
    let overflowed = 0;

    for (const file of list) {
      const mime = mesaReceiptMimeOf(file);
      if (!isAllowedMesaReceiptType(mime)) {
        rejected.push(`${file.name} — needs to be a photo or a PDF`);
        continue;
      }
      if (file.size > MAX_MESA_RECEIPT_BYTES) {
        rejected.push(`${file.name} — over 5 MB`);
        continue;
      }
      if (accepted.length >= slotsLeft) {
        overflowed += 1;
        continue;
      }
      const previewUrl = isMesaReceiptImage(mime) ? URL.createObjectURL(file) : null;
      if (previewUrl) objectUrlsRef.current.add(previewUrl);
      stagedSeqRef.current += 1;
      accepted.push({
        key: `staged-${stagedSeqRef.current}`,
        file,
        mime,
        previewUrl,
      });
    }

    if (accepted.length > 0) setStaged((prev) => [...prev, ...accepted]);
    for (const reason of rejected) toast.error(reason);
    if (overflowed > 0) {
      toast.error(
        slotsLeft === 0
          ? `This request already has ${MAX_MESA_RECEIPTS} receipts. Remove one to add another.`
          : `Only ${slotsLeft} more file${slotsLeft === 1 ? '' : 's'} fit — ${overflowed} skipped.`,
      );
    }
  };

  const removeStaged = (key: string) => {
    setStaged((prev) =>
      prev.filter((s) => {
        if (s.key !== key) return true;
        if (s.previewUrl) {
          URL.revokeObjectURL(s.previewUrl);
          objectUrlsRef.current.delete(s.previewUrl);
        }
        return false;
      }),
    );
  };

  /**
   * Upload the staged files one request at a time. Sequential rather than
   * parallel because each file gets its own request (three 5 MB parts in one
   * body would sit past the serverless limit) and because the server assigns
   * slots 1–3 — serialising means a member never races themselves for a slot.
   * A failure stops the run and keeps everything not yet sent staged, so
   * "Retry" is just pressing the button again.
   */
  const uploadStaged = async () => {
    if (!requestId || staged.length === 0) return;
    const queue = [...staged];
    setProgress({ done: 0, total: queue.length });

    let latest: MesaReceiptWithUrl[] = receipts;
    let uploaded = 0;

    for (const item of queue) {
      try {
        const fd = new FormData();
        fd.append('file', item.file, item.file.name);
        const res = await fetch(`/api/mesa-requests/${requestId}/receipts`, {
          method: 'POST',
          body: fd,
        });
        const json = (await res.json().catch(() => ({}))) as {
          rows?: MesaReceiptWithUrl[];
          error?: string;
        };
        if (!res.ok) throw new Error(json.error ?? `HTTP ${res.status}`);
        if (json.rows) latest = json.rows;
        uploaded += 1;
        removeStaged(item.key);
        setReceipts(latest);
        setProgress({ done: uploaded, total: queue.length });
      } catch (e) {
        setProgress(null);
        setReceipts(latest);
        onCountChange?.(requestId, latest.length);
        toast.error(e instanceof Error ? e.message : `Could not upload ${item.file.name}`);
        return;
      }
    }

    setProgress(null);
    setReceipts(latest);
    onCountChange?.(requestId, latest.length);
    toast.success(
      uploaded === 1 ? 'Receipt attached — Accounting can see it now.' : `${uploaded} receipts attached.`,
    );
  };

  const removeReceipt = async (receipt: MesaReceiptWithUrl) => {
    if (!requestId) return;
    setRemovingId(receipt.id);
    try {
      const res = await fetch(
        `/api/mesa-requests/${requestId}/receipts?receipt_id=${encodeURIComponent(receipt.id)}`,
        { method: 'DELETE' },
      );
      const json = (await res.json().catch(() => ({}))) as {
        rows?: MesaReceiptWithUrl[];
        error?: string;
      };
      if (!res.ok) throw new Error(json.error ?? `HTTP ${res.status}`);
      const rows = json.rows ?? receipts.filter((r) => r.id !== receipt.id);
      setReceipts(rows);
      onCountChange?.(requestId, rows.length);
      toast.success('Receipt removed.');
    } catch (e) {
      toast.error(e instanceof Error ? e.message : 'Could not remove that receipt');
    } finally {
      setRemovingId(null);
    }
  };

  const markThumbBroken = (key: string) =>
    setBrokenThumbs((prev) => (prev.has(key) ? prev : new Set(prev).add(key)));

  if (!mounted) return null;

  const spring = reduceMotion
    ? { duration: 0 }
    : { type: 'spring' as const, stiffness: 320, damping: 30, mass: 0.7 };

  return createPortal(
    <AnimatePresence>
      {open && request && (
        <motion.div
          key="mesa-receipts"
          className="fixed inset-0 z-[9999] flex items-end justify-center p-0 sm:items-center sm:p-4"
          initial={{ opacity: 0 }}
          animate={{ opacity: 1 }}
          exit={{ opacity: 0 }}
          transition={{ duration: reduceMotion ? 0 : 0.18, ease: 'easeOut' }}
        >
          {/* Backdrop — its own node so the panel's spring doesn't drag the blur. */}
          <div
            aria-hidden
            onClick={() => { if (!busy) onClose(); }}
            className="absolute inset-0 bg-zinc-900/45 backdrop-blur-[3px] dark:bg-black/70"
          />

          <motion.div
            ref={panelRef}
            role="dialog"
            aria-modal="true"
            aria-labelledby="mesa-receipt-title"
            tabIndex={-1}
            initial={reduceMotion ? { opacity: 0 } : { opacity: 0, y: 24, scale: 0.97 }}
            animate={{ opacity: 1, y: 0, scale: 1 }}
            exit={reduceMotion ? { opacity: 0 } : { opacity: 0, y: 16, scale: 0.98 }}
            transition={spring}
            className={cn(
              'relative flex max-h-[92vh] w-full flex-col overflow-hidden rounded-t-2xl border border-teal-100/80 shadow-2xl outline-none sm:max-h-[88vh] sm:max-w-lg sm:rounded-2xl',
              'bg-gradient-to-br from-white via-teal-50/50 to-emerald-50/30',
              'dark:border-teal-900/50 dark:from-[#0d1117] dark:via-[#0d1117] dark:to-teal-950/25',
            )}
          >
            {/* Header */}
            <div className="flex shrink-0 items-start justify-between gap-3 border-b border-teal-100/80 bg-white/60 px-5 py-4 backdrop-blur dark:border-teal-900/40 dark:bg-zinc-900/40">
              <div className="flex min-w-0 items-start gap-3">
                <div className="flex h-9 w-9 shrink-0 items-center justify-center rounded-xl bg-gradient-to-br from-teal-50 to-emerald-100/70 text-teal-600 ring-1 ring-teal-100 dark:from-teal-950/60 dark:to-emerald-950/40 dark:text-teal-300 dark:ring-teal-900/60">
                  <ReceiptText className="h-4 w-4" />
                </div>
                <div className="min-w-0">
                  <p className="text-[10.5px] font-semibold uppercase tracking-[0.16em] text-teal-700 dark:text-teal-300">
                    Disbursement receipt
                  </p>
                  <h2
                    id="mesa-receipt-title"
                    className="mt-0.5 truncate text-base font-bold tracking-tight text-zinc-900 dark:text-white"
                  >
                    {request.disbursement_reason || 'Disbursement request'}
                  </h2>
                  <p className="mt-0.5 text-[11.5px] text-zinc-500 dark:text-zinc-400">
                    {request.amount_needed != null ? formatPeso(request.amount_needed) : 'No amount on file'}
                    {' · requested '}
                    {formatDay(request.created_at)}
                  </p>
                </div>
              </div>
              <button
                type="button"
                onClick={onClose}
                disabled={busy}
                aria-label="Close"
                className="shrink-0 rounded-md p-1.5 text-zinc-400 transition-colors hover:bg-teal-50 hover:text-teal-700 disabled:opacity-40 dark:hover:bg-teal-950/40 dark:hover:text-teal-200"
              >
                <X className="h-4 w-4" />
              </button>
            </div>

            {/* Body */}
            <div className="min-h-0 flex-1 space-y-4 overflow-y-auto px-5 py-4">
              {/* The program rule, restated where it actually applies. */}
              <p className="flex items-start gap-2 rounded-lg border border-teal-100 bg-teal-50/60 p-3 text-[11.5px] leading-relaxed text-teal-900 dark:border-teal-900/50 dark:bg-teal-950/30 dark:text-teal-100">
                <ShieldCheck aria-hidden className="mt-px h-3.5 w-3.5 shrink-0 text-teal-600 dark:text-teal-300" />
                <span>
                  Receipts must be submitted within <strong className="font-semibold">14 days</strong>, be
                  valid, and show the <strong className="font-semibold">merchant&rsquo;s name</strong>. This is
                  what Accounting checks the disbursement against.
                </span>
              </p>

              {/* Drop zone */}
              <div
                onDragOver={(e) => {
                  if (dropDisabled) return;
                  e.preventDefault();
                  if (e.dataTransfer.types.includes('Files')) setDragOver(true);
                }}
                onDragLeave={(e) => {
                  e.preventDefault();
                  setDragOver(false);
                }}
                onDrop={(e) => {
                  e.preventDefault();
                  setDragOver(false);
                  if (dropDisabled) return;
                  if (e.dataTransfer.files.length > 0) addFiles(e.dataTransfer.files);
                }}
              >
                <button
                  type="button"
                  onClick={() => fileInputRef.current?.click()}
                  disabled={dropDisabled}
                  className={cn(
                    'group flex w-full flex-col items-center justify-center gap-1.5 rounded-xl border-2 border-dashed px-4 py-6 text-center transition-all duration-200',
                    'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-teal-500 focus-visible:ring-offset-2 dark:focus-visible:ring-offset-zinc-900',
                    dropDisabled
                      ? 'cursor-not-allowed border-zinc-200 bg-zinc-50/60 dark:border-zinc-800 dark:bg-zinc-900/40'
                      : dragOver
                        ? 'scale-[1.01] border-teal-400 bg-teal-50 shadow-sm dark:border-teal-500/70 dark:bg-teal-950/40'
                        : 'border-teal-200/90 bg-white/70 hover:border-teal-400 hover:bg-teal-50/60 dark:border-teal-900/60 dark:bg-zinc-900/40 dark:hover:border-teal-700 dark:hover:bg-teal-950/25',
                  )}
                >
                  <UploadCloud
                    aria-hidden
                    className={cn(
                      'h-6 w-6 transition-transform duration-200',
                      dropDisabled
                        ? 'text-zinc-300 dark:text-zinc-700'
                        : cn(
                            'text-teal-500 dark:text-teal-400',
                            dragOver ? '-translate-y-0.5 scale-110' : 'group-hover:-translate-y-0.5',
                          ),
                    )}
                  />
                  <span className="text-sm font-semibold text-zinc-800 dark:text-zinc-100">
                    {slotsLeft === 0 && !loading
                      ? `All ${MAX_MESA_RECEIPTS} slots are full`
                      : dragOver
                        ? 'Drop to attach'
                        : 'Drag receipts here, or browse'}
                  </span>
                  {/* On drag-over the whole zone turns teal, so the hint takes a
                      teal ink — zinc-500 on a teal wash reads as washed out. */}
                  <span
                    className={cn(
                      'text-[11px]',
                      dragOver && !dropDisabled
                        ? 'text-teal-700 dark:text-teal-200'
                        : 'text-zinc-500 dark:text-zinc-400',
                    )}
                  >
                    {loading
                      ? 'Checking what’s already attached…'
                      : slotsLeft === 0
                        ? 'Remove one below to attach a different file'
                        : `Photos or PDFs · up to 5 MB each · ${slotsLeft} slot${slotsLeft === 1 ? '' : 's'} left`}
                  </span>
                </button>
                <input
                  ref={fileInputRef}
                  type="file"
                  multiple
                  accept={MESA_RECEIPT_ACCEPT}
                  className="hidden"
                  onChange={(e) => {
                    if (e.target.files) addFiles(e.target.files);
                    // Reset so re-picking the same file still fires onChange.
                    e.target.value = '';
                  }}
                />
              </div>

              {/* Attached + staged files */}
              {loading ? (
                <div className="space-y-2">
                  {[0, 1].map((i) => (
                    <div
                      key={i}
                      className="h-14 w-full animate-pulse rounded-xl bg-zinc-100 dark:bg-zinc-800/60"
                      style={{ animationDelay: `${i * 90}ms` }}
                    />
                  ))}
                </div>
              ) : loadError ? (
                <p className="rounded-lg border border-amber-200 bg-amber-50 p-3 text-[12px] leading-relaxed text-amber-900 dark:border-amber-500/40 dark:bg-amber-950/30 dark:text-amber-100">
                  {loadError}
                </p>
              ) : used === 0 ? (
                <p className="flex items-center justify-center gap-2 rounded-xl border border-zinc-200/70 bg-white/60 py-5 text-[12px] text-zinc-500 dark:border-zinc-800 dark:bg-zinc-900/30 dark:text-zinc-400">
                  <Paperclip aria-hidden className="h-3.5 w-3.5" />
                  Nothing attached yet.
                </p>
              ) : (
                <ul className="space-y-2">
                  <AnimatePresence initial={false} mode="popLayout">
                    {receipts.map((r) => (
                      <motion.li
                        key={r.id}
                        layout={!reduceMotion}
                        initial={reduceMotion ? { opacity: 0 } : { opacity: 0, y: 8, scale: 0.98 }}
                        animate={{ opacity: 1, y: 0, scale: 1 }}
                        exit={reduceMotion ? { opacity: 0 } : { opacity: 0, x: -12, scale: 0.97 }}
                        transition={spring}
                      >
                        <FileRow
                          name={r.file_name || `Receipt ${r.slot}`}
                          meta={`${formatReceiptSize(r.file_size)} · attached ${formatDay(r.uploaded_at)}`}
                          mime={r.mime_type}
                          thumbUrl={isMesaReceiptImage(r.mime_type) ? r.url : null}
                          thumbBroken={brokenThumbs.has(r.id)}
                          onThumbError={() => markThumbBroken(r.id)}
                          state="attached"
                          href={r.url}
                          busy={removingId === r.id}
                          disabled={busy}
                          onRemove={() => removeReceipt(r)}
                        />
                      </motion.li>
                    ))}
                    {staged.map((s) => (
                      <motion.li
                        key={s.key}
                        layout={!reduceMotion}
                        initial={reduceMotion ? { opacity: 0 } : { opacity: 0, y: 8, scale: 0.98 }}
                        animate={{ opacity: 1, y: 0, scale: 1 }}
                        exit={reduceMotion ? { opacity: 0 } : { opacity: 0, x: -12, scale: 0.97 }}
                        transition={spring}
                      >
                        <FileRow
                          name={s.file.name}
                          meta={`${formatReceiptSize(s.file.size)} · ready to upload`}
                          mime={s.mime}
                          thumbUrl={s.previewUrl}
                          thumbBroken={brokenThumbs.has(s.key)}
                          onThumbError={() => markThumbBroken(s.key)}
                          state="staged"
                          busy={false}
                          disabled={busy}
                          onRemove={() => removeStaged(s.key)}
                        />
                      </motion.li>
                    ))}
                  </AnimatePresence>
                </ul>
              )}
            </div>

            {/* Footer */}
            <div className="flex shrink-0 flex-wrap items-center justify-between gap-3 border-t border-teal-100/80 bg-white/70 px-5 py-3.5 backdrop-blur dark:border-teal-900/40 dark:bg-zinc-900/50">
              <span className="text-[11px] font-medium tabular-nums text-zinc-500 dark:text-zinc-400">
                {used} of {MAX_MESA_RECEIPTS} attached
                {staged.length > 0 && (
                  <span className="text-teal-700 dark:text-teal-300">
                    {' '}· {staged.length} pending
                  </span>
                )}
              </span>
              <div className="flex items-center gap-2">
                <Button type="button" variant="outline" size="sm" onClick={onClose} disabled={busy}>
                  {staged.length > 0 ? 'Cancel' : 'Done'}
                </Button>
                {/* With nothing staged there is nothing to upload, so the primary
                    becomes the picker rather than a dead "Upload" — and it drops
                    away entirely once all three slots are full. */}
                {(staged.length > 0 || slotsLeft > 0) && (
                  <Button
                    type="button"
                    size="sm"
                    onClick={staged.length > 0 ? uploadStaged : () => fileInputRef.current?.click()}
                    disabled={busy || loading}
                    className="bg-gradient-to-r from-teal-600 to-emerald-600 text-white shadow-sm hover:from-teal-500 hover:to-emerald-500 disabled:cursor-not-allowed disabled:opacity-50"
                  >
                    {uploading ? (
                      <>
                        <Loader2 className="mr-1.5 h-3.5 w-3.5 animate-spin" />
                        Uploading {Math.min(progress.done + 1, progress.total)} of {progress.total}…
                      </>
                    ) : (
                      <>
                        <UploadCloud className="mr-1.5 h-3.5 w-3.5" />
                        {staged.length === 0
                          ? 'Choose files'
                          : `Upload ${staged.length} file${staged.length === 1 ? '' : 's'}`}
                      </>
                    )}
                  </Button>
                )}
              </div>
            </div>
          </motion.div>
        </motion.div>
      )}
    </AnimatePresence>,
    document.body,
  );
}

/** One row in the attached/staged list. */
function FileRow({
  name,
  meta,
  mime,
  thumbUrl,
  thumbBroken,
  onThumbError,
  state,
  href,
  busy,
  disabled,
  onRemove,
}: {
  name: string;
  meta: string;
  mime: string | null;
  thumbUrl: string | null;
  thumbBroken: boolean;
  onThumbError: () => void;
  state: 'attached' | 'staged';
  href?: string | null;
  busy: boolean;
  disabled: boolean;
  onRemove: () => void;
}) {
  const isPdf = (mime ?? '') === 'application/pdf';
  const showThumb = !!thumbUrl && !thumbBroken;

  return (
    <div
      className={cn(
        'flex items-center gap-3 rounded-xl border p-2.5 transition-colors',
        state === 'attached'
          ? 'border-teal-100 bg-white/80 dark:border-teal-900/50 dark:bg-zinc-900/50'
          : 'border-dashed border-teal-300/80 bg-teal-50/40 dark:border-teal-700/60 dark:bg-teal-950/20',
      )}
    >
      {/* Thumbnail */}
      <div
        className={cn(
          'flex h-11 w-11 shrink-0 items-center justify-center overflow-hidden rounded-lg ring-1',
          isPdf
            ? 'bg-rose-50 text-rose-600 ring-rose-100 dark:bg-rose-950/30 dark:text-rose-300 dark:ring-rose-900/50'
            : 'bg-zinc-100 text-zinc-400 ring-zinc-200 dark:bg-zinc-800/70 dark:text-zinc-500 dark:ring-zinc-700/70',
        )}
      >
        {showThumb ? (
          // eslint-disable-next-line @next/next/no-img-element
          <img
            src={thumbUrl}
            alt=""
            loading="lazy"
            onError={onThumbError}
            className="h-full w-full object-cover"
          />
        ) : isPdf ? (
          <FileText aria-hidden className="h-5 w-5" />
        ) : (
          <ImageIcon aria-hidden className="h-5 w-5" />
        )}
      </div>

      {/* Name + meta. A staged row sits on a teal wash, so its ink is teal too —
          zinc-500 on a tinted card reads as disabled rather than pending. */}
      <div className="min-w-0 flex-1">
        <p
          className={cn(
            'truncate text-[13px] font-medium',
            state === 'attached'
              ? 'text-zinc-900 dark:text-zinc-100'
              : 'text-teal-950 dark:text-teal-50',
          )}
        >
          {name}
        </p>
        <p
          className={cn(
            'mt-0.5 flex items-center gap-1 truncate text-[11px]',
            state === 'attached'
              ? 'text-zinc-500 dark:text-zinc-400'
              : 'text-teal-700 dark:text-teal-200/90',
          )}
        >
          {state === 'attached' && (
            <CheckCircle2 aria-hidden className="h-3 w-3 shrink-0 text-teal-500 dark:text-teal-400" />
          )}
          {meta}
        </p>
      </div>

      {/* Actions */}
      <div className="flex shrink-0 items-center gap-1">
        {state === 'attached' && href && (
          <a
            href={href}
            target="_blank"
            rel="noopener noreferrer"
            title="Open in a new tab"
            className="inline-flex h-7 w-7 items-center justify-center rounded-md text-zinc-400 transition-colors hover:bg-teal-50 hover:text-teal-700 dark:hover:bg-teal-950/40 dark:hover:text-teal-200"
          >
            <ExternalLink className="h-3.5 w-3.5" />
            <span className="sr-only">Open {name}</span>
          </a>
        )}
        <button
          type="button"
          onClick={onRemove}
          disabled={disabled || busy}
          title={state === 'attached' ? 'Remove this receipt' : 'Discard this file'}
          className="inline-flex h-7 w-7 items-center justify-center rounded-md text-zinc-400 transition-colors hover:bg-rose-50 hover:text-rose-600 disabled:opacity-40 dark:hover:bg-rose-950/30 dark:hover:text-rose-400"
        >
          {busy ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Trash2 className="h-3.5 w-3.5" />}
          <span className="sr-only">Remove {name}</span>
        </button>
      </div>
    </div>
  );
}
