'use client';

import { useEffect, useMemo, useRef, useState } from 'react';
import { CalendarRange, ChevronLeft, ChevronRight, X } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { cn } from '@/lib/utils';

export interface DateRange {
  /** Inclusive start, "YYYY-MM-DD". */
  start: string;
  /** Inclusive end, "YYYY-MM-DD". */
  end: string;
}

/** Just the accent class-strings this picker needs (a subset of PeopleTab's Accent). */
interface PickerAccent {
  ring: string;
  chipBg: string;
  chipText: string;
  btn: string;
  bar: string;
}

const DOW = ['S', 'M', 'T', 'W', 'T', 'F', 'S'];
const p2 = (x: number) => String(x).padStart(2, '0');
const toIso = (d: Date) => `${d.getFullYear()}-${p2(d.getMonth() + 1)}-${p2(d.getDate())}`;
const fromIso = (iso: string): Date | null => {
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(iso);
  return m ? new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3])) : null;
};
const startOfMonth = (d: Date) => new Date(d.getFullYear(), d.getMonth(), 1);
const addMonths = (d: Date, n: number) => new Date(d.getFullYear(), d.getMonth() + n, 1);
const addDays = (d: Date, n: number) => new Date(d.getFullYear(), d.getMonth(), d.getDate() + n);

function formatRange(start: string, end: string): string {
  const s = fromIso(start);
  const e = fromIso(end);
  if (!s || !e) return `${start} – ${end}`;
  const mShort = (d: Date) => d.toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
  const withYear = (d: Date) => d.toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' });
  if (s.getFullYear() !== e.getFullYear()) return `${withYear(s)} – ${withYear(e)}`;
  return `${mShort(s)} – ${mShort(e)}, ${e.getFullYear()}`;
}

/**
 * Calendar-based custom date-range picker. Click a start day then an end day
 * (order-independent — they're sorted), with a live hover preview of the span.
 * Quick presets cover the common payroll windows. Bounded by `min`/`max` ISO
 * dates so you can't range past the available data or into the future.
 */
export default function PeopleDateRangePicker({
  value,
  onChange,
  accent,
  min,
  max,
  className,
}: {
  value: DateRange | null;
  onChange: (v: DateRange | null) => void;
  accent: PickerAccent;
  /** Earliest selectable day (YYYY-MM-DD). */
  min?: string | null;
  /** Latest selectable day (YYYY-MM-DD); defaults to today. */
  max?: string | null;
  className?: string;
}) {
  const [open, setOpen] = useState(false);
  const [viewMonth, setViewMonth] = useState<Date | null>(null);
  // First click of an in-progress selection (null = none pending / range complete).
  const [pendingStart, setPendingStart] = useState<string | null>(null);
  const [hoverDay, setHoverDay] = useState<string | null>(null);
  const rootRef = useRef<HTMLDivElement>(null);

  const maxIso = (max ?? '').trim() || null;
  const minIso = (min ?? '').trim() || null;

  // Close on outside click / Escape while open.
  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => {
      if (rootRef.current && !rootRef.current.contains(e.target as Node)) closePicker();
    };
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') closePicker(); };
    document.addEventListener('mousedown', onDown);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('mousedown', onDown);
      document.removeEventListener('keydown', onKey);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);

  const openPicker = () => {
    const anchor = value ? fromIso(value.end) : maxIso ? fromIso(maxIso) : new Date();
    setViewMonth(startOfMonth(anchor ?? new Date()));
    setPendingStart(null);
    setHoverDay(null);
    setOpen(true);
  };
  const closePicker = () => {
    setOpen(false);
    setPendingStart(null);
    setHoverDay(null);
  };

  const grid = useMemo(() => {
    if (!viewMonth) return [] as Date[];
    const first = startOfMonth(viewMonth);
    const gridStart = addDays(first, -first.getDay()); // back to Sunday
    return Array.from({ length: 42 }, (_, i) => addDays(gridStart, i));
  }, [viewMonth]);

  // Highlighted span: the pending selection (start + hover) while choosing, else
  // the committed value.
  let lo: string | null = null;
  let hi: string | null = null;
  if (pendingStart) {
    const other = hoverDay ?? pendingStart;
    lo = pendingStart < other ? pendingStart : other;
    hi = pendingStart < other ? other : pendingStart;
  } else if (value) {
    lo = value.start;
    hi = value.end;
  }

  const isDisabled = (iso: string) => (minIso && iso < minIso) || (maxIso && iso > maxIso);

  const pickDay = (iso: string) => {
    if (isDisabled(iso)) return;
    if (!pendingStart) {
      setPendingStart(iso);
      return;
    }
    const start = pendingStart < iso ? pendingStart : iso;
    const end = pendingStart < iso ? iso : pendingStart;
    onChange({ start, end });
    closePicker();
  };

  const applyPreset = (start: string, end: string) => {
    const clampedEnd = maxIso && end > maxIso ? maxIso : end;
    const clampedStart = minIso && start < minIso ? minIso : start;
    onChange({ start: clampedStart, end: clampedEnd });
    closePicker();
  };

  // Presets relative to "today" — computed on click (never during render) so a
  // server/client clock mismatch can't desync hydration.
  const presets: { label: string; make: () => { start: string; end: string } }[] = [
    {
      label: 'Last 4 weeks',
      make: () => { const t = new Date(); return { start: toIso(addDays(t, -27)), end: toIso(t) }; },
    },
    {
      label: 'Last 8 weeks',
      make: () => { const t = new Date(); return { start: toIso(addDays(t, -55)), end: toIso(t) }; },
    },
    {
      label: 'This month',
      make: () => { const t = new Date(); return { start: toIso(startOfMonth(t)), end: toIso(t) }; },
    },
    {
      label: 'Last month',
      make: () => {
        const t = new Date();
        const firstThis = startOfMonth(t);
        const lastPrev = addDays(firstThis, -1);
        return { start: toIso(startOfMonth(lastPrev)), end: toIso(lastPrev) };
      },
    },
  ];

  return (
    <div ref={rootRef} className={cn('relative', className)}>
      <button
        type="button"
        onClick={() => (open ? closePicker() : openPicker())}
        aria-haspopup="dialog"
        aria-expanded={open}
        className={cn(
          'flex h-9 w-full items-center gap-2 rounded-md border bg-white px-2.5 text-[13px] transition-colors dark:bg-zinc-950',
          'focus:outline-none focus-visible:ring-2',
          accent.ring,
          value
            ? cn('border-transparent font-medium', accent.chipBg, accent.chipText)
            : 'border-zinc-300 text-zinc-600 hover:border-zinc-400 dark:border-zinc-700 dark:text-zinc-300 dark:hover:border-zinc-600',
        )}
        title="Aggregate hours & pay across a custom date range"
      >
        <CalendarRange className="h-4 w-4 shrink-0 opacity-70" />
        <span className="min-w-0 flex-1 truncate text-left">
          {value ? formatRange(value.start, value.end) : 'Custom date range'}
        </span>
        {value && (
          <span
            role="button"
            tabIndex={0}
            aria-label="Clear date range"
            onClick={(e) => { e.stopPropagation(); onChange(null); }}
            onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') { e.stopPropagation(); onChange(null); } }}
            className="shrink-0 rounded p-0.5 opacity-70 transition-opacity hover:opacity-100"
          >
            <X className="h-3.5 w-3.5" />
          </span>
        )}
      </button>

      {open && viewMonth && (
        <div
          role="dialog"
          aria-label="Choose a date range"
          className="absolute right-0 z-50 mt-2 w-[20rem] max-w-[calc(100vw-2rem)] rounded-xl border border-zinc-200 bg-white p-3 shadow-xl dark:border-zinc-800 dark:bg-zinc-950"
        >
          {/* Presets */}
          <div className="mb-2 flex flex-wrap gap-1.5">
            {presets.map((p) => (
              <button
                key={p.label}
                type="button"
                onClick={() => { const r = p.make(); applyPreset(r.start, r.end); }}
                className="rounded-full border border-zinc-200 px-2.5 py-1 text-[11px] font-medium text-zinc-600 transition-colors hover:bg-zinc-50 dark:border-zinc-700 dark:text-zinc-300 dark:hover:bg-zinc-900"
              >
                {p.label}
              </button>
            ))}
          </div>

          {/* Month header + nav */}
          <div className="mb-2 flex items-center justify-between">
            <button
              type="button"
              onClick={() => setViewMonth((m) => (m ? addMonths(m, -1) : m))}
              className="rounded-md p-1 text-zinc-500 transition-colors hover:bg-zinc-100 dark:hover:bg-zinc-800"
              aria-label="Previous month"
            >
              <ChevronLeft className="h-4 w-4" />
            </button>
            <span className="text-[13px] font-semibold text-zinc-800 dark:text-zinc-100">
              {viewMonth.toLocaleDateString('en-US', { month: 'long', year: 'numeric' })}
            </span>
            <button
              type="button"
              onClick={() => setViewMonth((m) => (m ? addMonths(m, 1) : m))}
              className="rounded-md p-1 text-zinc-500 transition-colors hover:bg-zinc-100 dark:hover:bg-zinc-800"
              aria-label="Next month"
            >
              <ChevronRight className="h-4 w-4" />
            </button>
          </div>

          {/* Day-of-week header */}
          <div className="grid grid-cols-7 text-center text-[10px] font-medium uppercase text-zinc-400">
            {DOW.map((d, i) => <div key={i} className="py-1">{d}</div>)}
          </div>

          {/* Day grid */}
          <div className="grid grid-cols-7 gap-y-0.5" onMouseLeave={() => setHoverDay(null)}>
            {grid.map((d) => {
              const iso = toIso(d);
              const inMonth = d.getMonth() === viewMonth.getMonth();
              const disabled = !!isDisabled(iso);
              const inRange = lo && hi && iso >= lo && iso <= hi;
              const isEdge = iso === lo || iso === hi;
              return (
                <button
                  key={iso}
                  type="button"
                  disabled={disabled}
                  onClick={() => pickDay(iso)}
                  onMouseEnter={() => setHoverDay(iso)}
                  className={cn(
                    'mx-auto flex h-8 w-8 items-center justify-center rounded-md text-[12px] tabular-nums transition-colors',
                    disabled && 'cursor-not-allowed text-zinc-300 dark:text-zinc-700',
                    !disabled && !inMonth && 'text-zinc-300 dark:text-zinc-600',
                    !disabled && inMonth && !inRange && 'text-zinc-700 hover:bg-zinc-100 dark:text-zinc-200 dark:hover:bg-zinc-800',
                    inRange && !isEdge && cn(accent.chipBg, accent.chipText),
                    isEdge && cn('font-semibold text-white', accent.bar),
                  )}
                >
                  {d.getDate()}
                </button>
              );
            })}
          </div>

          {/* Footer — selection hint + clear */}
          <div className="mt-2 flex items-center justify-between gap-2 border-t border-zinc-100 pt-2 dark:border-zinc-800">
            <span className="text-[11px] text-zinc-500">
              {pendingStart
                ? 'Pick the end date…'
                : value
                  ? formatRange(value.start, value.end)
                  : 'Pick a start date'}
            </span>
            {value && (
              <Button
                type="button"
                size="sm"
                variant="ghost"
                className="h-7 px-2 text-[12px] text-zinc-500"
                onClick={() => { onChange(null); closePicker(); }}
              >
                Clear
              </Button>
            )}
          </div>
        </div>
      )}
    </div>
  );
}
