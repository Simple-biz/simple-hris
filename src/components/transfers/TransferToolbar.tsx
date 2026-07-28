'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import { AnimatePresence, motion, useReducedMotion } from 'motion/react';
import {
  ChevronDown,
  Download,
  FileSpreadsheet,
  FileText,
  Loader2,
  Table2,
} from 'lucide-react';
import { toast } from 'sonner';
import { Button } from '@/components/ui/button';
import { cn } from '@/lib/utils';
import {
  buildTransferExport,
  downloadTransfersCsv,
  downloadTransfersPdf,
  downloadTransfersXlsx,
  type TransferExportSource,
  type TransferPdfTheme,
} from '@/lib/transfers/transfers-export';

/* ──────────────────────────────────────────────────────────────────────────
 * Shared Transfers toolbar pieces — the click-to-filter KPI card and the
 * CSV / Excel / PDF export menu, both accent-parameterized so each surface
 * keeps its own dashboard colour (Accounting orange, Manager blue).
 *
 * Extracted from the Accounting Transfers tab, which still carries its own
 * local copies; this module is the home the two should converge on.
 * ────────────────────────────────────────────────────────────────────────── */

/** Which dashboard palette the toolbar wears. */
export type ToolbarAccent = 'orange' | 'blue';

const TOOLBAR_ACCENT: Record<
  ToolbarAccent,
  { button: string; menuHover: string; iconGradient: string }
> = {
  orange: {
    button:
      'border-orange-200 text-orange-700 hover:bg-orange-50 dark:border-orange-800 dark:text-orange-300',
    menuHover: 'hover:bg-orange-50 dark:hover:bg-orange-950/30',
    iconGradient: 'from-orange-500 to-rose-500',
  },
  blue: {
    button: 'border-blue-200 text-blue-700 hover:bg-blue-50 dark:border-blue-800 dark:text-blue-300',
    menuHover: 'hover:bg-blue-50 dark:hover:bg-blue-950/30',
    iconGradient: 'from-blue-500 to-sky-500',
  },
};

// ── KPI card ────────────────────────────────────────────────────────────────

/**
 * Per-tone palettes in the MESA stat-card language: a soft gradient wash to
 * white, a matching border, and tone-tinted ink — so the numbers read as one
 * family across MESA and Transfers. `ring` is the "this card is filtering"
 * state, drawn in the card's own tone so it never introduces a new colour.
 */
const KPI_TONE = {
  teal: {
    card: 'border-teal-200 bg-gradient-to-br from-teal-50 to-white text-teal-900 dark:border-teal-700/40 dark:from-teal-950/40 dark:to-zinc-950 dark:text-teal-100',
    ring: 'ring-teal-400/70 dark:ring-teal-500/50',
  },
  emerald: {
    card: 'border-emerald-200 bg-gradient-to-br from-emerald-50 to-white text-emerald-900 dark:border-emerald-700/40 dark:from-emerald-950/40 dark:to-zinc-950 dark:text-emerald-100',
    ring: 'ring-emerald-400/70 dark:ring-emerald-500/50',
  },
  sky: {
    card: 'border-sky-200 bg-gradient-to-br from-sky-50 to-white text-sky-900 dark:border-sky-700/40 dark:from-sky-950/40 dark:to-zinc-950 dark:text-sky-100',
    ring: 'ring-sky-400/70 dark:ring-sky-500/50',
  },
  blue: {
    card: 'border-blue-200 bg-gradient-to-br from-blue-50 to-white text-blue-900 dark:border-blue-700/40 dark:from-blue-950/40 dark:to-zinc-950 dark:text-blue-100',
    ring: 'ring-blue-400/70 dark:ring-blue-500/50',
  },
  amber: {
    card: 'border-amber-200 bg-gradient-to-br from-amber-50 to-white text-amber-900 dark:border-amber-700/40 dark:from-amber-950/40 dark:to-zinc-950 dark:text-amber-100',
    ring: 'ring-amber-400/70 dark:ring-amber-500/50',
  },
  rose: {
    card: 'border-rose-200 bg-gradient-to-br from-rose-50 to-white text-rose-900 dark:border-rose-700/40 dark:from-rose-950/40 dark:to-zinc-950 dark:text-rose-100',
    ring: 'ring-rose-400/70 dark:ring-rose-500/50',
  },
  zinc: {
    card: 'border-zinc-200 bg-white text-zinc-900 dark:border-zinc-800 dark:bg-zinc-900/40 dark:text-zinc-100',
    ring: 'ring-zinc-400/70 dark:ring-zinc-500/50',
  },
} as const;

export type KpiTone = keyof typeof KPI_TONE;

/**
 * One at-a-glance metric card, in the MESA StatCard visual language (uppercase
 * label over a mono numeral on a tinted gradient). Unlike MESA's, this one can
 * be a filter toggle: pass `onClick` and it becomes a button that narrows the
 * table to its bucket, with `active` drawing the filtering ring. Without
 * `onClick` it renders as a plain, non-interactive card.
 */
export function TransferKpiCard({
  label,
  value,
  hint,
  tone,
  onClick,
  active,
}: {
  label: string;
  value: number;
  /** Optional sub-line — used to advertise the click-to-filter affordance. */
  hint?: string;
  tone: KpiTone;
  onClick?: () => void;
  active?: boolean;
}) {
  const t = KPI_TONE[tone];
  const body = (
    <>
      <p className="text-[11px] font-medium uppercase tracking-wide opacity-70">{label}</p>
      <p className="mt-1 font-mono text-2xl font-bold tabular-nums">{value}</p>
      {hint && <p className="mt-1 text-[11px] leading-tight opacity-60">{hint}</p>}
    </>
  );

  if (!onClick) {
    return <div className={cn('rounded-xl border p-4 shadow-sm', t.card)}>{body}</div>;
  }
  return (
    <motion.button
      type="button"
      onClick={onClick}
      whileHover={{ y: -2 }}
      whileTap={{ scale: 0.98 }}
      transition={{ type: 'spring', stiffness: 400, damping: 30 }}
      aria-pressed={!!active}
      className={cn(
        'cursor-pointer rounded-xl border p-4 text-left shadow-sm transition-shadow hover:shadow-md',
        t.card,
        active && cn('ring-2 ring-inset', t.ring),
      )}
    >
      {body}
    </motion.button>
  );
}

// ── Export menu (PDF · XLSX · CSV) ──────────────────────────────────────────

type ExportFormat = 'pdf' | 'xlsx' | 'csv';

/**
 * Download the transfers currently in view (respecting the active search and
 * KPI filter) as a branded PDF, an Excel workbook, or a flat CSV. Runs entirely
 * client-side — the rows are already loaded in the tab.
 */
export function TransferExportMenu({
  rows,
  total,
  filterLabel,
  title,
  eyebrow,
  fileBase,
  includeRateChange = true,
  pdfTheme,
  accent = 'orange',
}: {
  /** The rows to export — already filtered/sorted to what's on screen. */
  rows: readonly TransferExportSource[];
  /** Rows loaded BEFORE filtering, for the "N of M" provenance line. */
  total: number;
  filterLabel: string;
  title?: string;
  eyebrow?: string;
  fileBase?: string;
  includeRateChange?: boolean;
  pdfTheme?: TransferPdfTheme;
  accent?: ToolbarAccent;
}) {
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState<ExportFormat | null>(null);
  const wrapRef = useRef<HTMLDivElement>(null);
  const menuRef = useRef<HTMLDivElement>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const reduce = useReducedMotion();
  const a = TOOLBAR_ACCENT[accent];
  const isEmpty = rows.length === 0;

  // Close on outside click / Escape (returning focus to the trigger, so keyboard
  // users aren't dumped at the top of the document).
  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => {
      if (wrapRef.current && !wrapRef.current.contains(e.target as Node)) setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        setOpen(false);
        triggerRef.current?.focus();
      }
    };
    document.addEventListener('mousedown', onDown);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('mousedown', onDown);
      document.removeEventListener('keydown', onKey);
    };
  }, [open]);

  // role="menu" carries a keyboard contract: focus enters the menu on open and
  // Arrow/Home/End move between items. Without this a screen-reader user is
  // switched into application mode and then finds the arrows do nothing.
  const menuItems = () =>
    Array.from(menuRef.current?.querySelectorAll<HTMLButtonElement>('[role="menuitem"]') ?? []);

  useEffect(() => {
    if (!open) return;
    const id = requestAnimationFrame(() => menuItems()[0]?.focus());
    return () => cancelAnimationFrame(id);
  }, [open]);

  const onMenuKeyDown = (e: React.KeyboardEvent) => {
    const items = menuItems();
    if (items.length === 0) return;
    const i = items.indexOf(document.activeElement as HTMLButtonElement);
    if (e.key === 'ArrowDown') {
      e.preventDefault();
      items[(i + 1 + items.length) % items.length]?.focus();
    } else if (e.key === 'ArrowUp') {
      e.preventDefault();
      items[(i - 1 + items.length) % items.length]?.focus();
    } else if (e.key === 'Home') {
      e.preventDefault();
      items[0]?.focus();
    } else if (e.key === 'End') {
      e.preventDefault();
      items[items.length - 1]?.focus();
    } else if (e.key === 'Tab') {
      setOpen(false);
    }
  };

  const runExport = useCallback(
    async (format: ExportFormat) => {
      if (rows.length === 0) {
        toast.error('Nothing to export in this view.');
        return;
      }
      setBusy(format);
      setOpen(false);
      try {
        const model = buildTransferExport({
          rows,
          total,
          filterLabel,
          title,
          eyebrow,
          fileBase,
          includeRateChange,
        });
        if (format === 'csv') {
          downloadTransfersCsv(model);
        } else if (format === 'xlsx') {
          downloadTransfersXlsx(model);
        } else {
          await downloadTransfersPdf(model, { theme: pdfTheme });
        }
        toast.success(
          `Exported ${rows.length.toLocaleString()} ${rows.length === 1 ? 'transfer' : 'transfers'} as ${format.toUpperCase()}.`,
        );
      } catch (e) {
        toast.error(e instanceof Error ? e.message : `Failed to export ${format.toUpperCase()}`);
      } finally {
        setBusy(null);
      }
    },
    [rows, total, filterLabel, title, eyebrow, fileBase, includeRateChange, pdfTheme],
  );

  const items: { format: ExportFormat; label: string; hint: string; Icon: typeof FileText }[] = [
    { format: 'pdf', label: 'PDF', hint: 'Branded document', Icon: FileText },
    { format: 'xlsx', label: 'Excel', hint: 'XLSX workbook', Icon: FileSpreadsheet },
    { format: 'csv', label: 'CSV', hint: 'Plain data', Icon: Table2 },
  ];

  return (
    <div ref={wrapRef} className="relative">
      <Button
        ref={triggerRef}
        type="button"
        size="sm"
        variant="outline"
        onClick={() => setOpen((o) => !o)}
        // Nothing in view means every format would fail — don't offer the menu.
        disabled={busy !== null || isEmpty}
        aria-haspopup="menu"
        aria-expanded={open}
        title={
          isEmpty
            ? 'Nothing to export — no transfers match this view'
            : 'Export the transfers in view (CSV · Excel · PDF)'
        }
        className={cn('h-8 gap-1.5 px-2.5 text-[12px]', a.button)}
      >
        {busy ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Download className="h-3.5 w-3.5" />}
        <span className="hidden sm:inline">{busy ? `Exporting ${busy.toUpperCase()}…` : 'Export'}</span>
        <ChevronDown className={cn('h-3.5 w-3.5 transition-transform', open && 'rotate-180')} aria-hidden />
      </Button>

      <AnimatePresence>
        {open && (
          <motion.div
            ref={menuRef}
            role="menu"
            aria-label="Export format"
            onKeyDown={onMenuKeyDown}
            initial={reduce ? { opacity: 0 } : { opacity: 0, y: -6, scale: 0.98 }}
            animate={{ opacity: 1, y: 0, scale: 1 }}
            exit={reduce ? { opacity: 0 } : { opacity: 0, y: -6, scale: 0.98 }}
            transition={{ duration: 0.15, ease: [0.22, 1, 0.36, 1] }}
            className="absolute right-0 z-30 mt-2 w-56 overflow-hidden rounded-xl border border-zinc-200 bg-white p-1 shadow-xl shadow-zinc-900/10 dark:border-zinc-700 dark:bg-zinc-900"
          >
            <p className="px-2.5 pb-1 pt-1.5 text-[10px] font-semibold uppercase tracking-[0.14em] text-zinc-400 dark:text-zinc-500">
              Export {rows.length.toLocaleString()} {rows.length === 1 ? 'transfer' : 'transfers'}
            </p>
            {items.map(({ format, label, hint, Icon }) => (
              <button
                key={format}
                type="button"
                role="menuitem"
                onClick={() => void runExport(format)}
                className={cn(
                  'flex w-full items-center gap-2.5 rounded-lg px-2.5 py-2 text-left transition-colors',
                  'focus:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-zinc-400 dark:focus-visible:ring-zinc-500',
                  a.menuHover,
                )}
              >
                <span
                  className={cn(
                    'flex h-8 w-8 shrink-0 items-center justify-center rounded-lg bg-gradient-to-br text-white shadow-sm',
                    a.iconGradient,
                  )}
                >
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
