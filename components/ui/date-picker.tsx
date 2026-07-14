'use client';

import { useEffect, useMemo, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { AnimatePresence, motion, useReducedMotion } from 'motion/react';
import { CalendarDays, CalendarRange, ChevronLeft, ChevronRight, X } from 'lucide-react';
import { cn } from '@/lib/utils';

/* ------------------------------------------------------------------ */
/* Date helpers (ISO "YYYY-MM-DD" strings, local time — no libraries)  */
/* ------------------------------------------------------------------ */

const p2 = (x: number) => String(x).padStart(2, '0');
export const toIso = (d: Date) => `${d.getFullYear()}-${p2(d.getMonth() + 1)}-${p2(d.getDate())}`;
export const fromIso = (iso: string): Date | null => {
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(iso ?? '');
  return m ? new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3])) : null;
};
const startOfMonth = (d: Date) => new Date(d.getFullYear(), d.getMonth(), 1);
const addMonths = (d: Date, n: number) => new Date(d.getFullYear(), d.getMonth() + n, 1);
const addDays = (d: Date, n: number) => new Date(d.getFullYear(), d.getMonth(), d.getDate() + n);
const sameMonth = (a: Date, b: Date) => a.getFullYear() === b.getFullYear() && a.getMonth() === b.getMonth();

const DOW = ['Su', 'Mo', 'Tu', 'We', 'Th', 'Fr', 'Sa'];
const MONTHS_SHORT = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

function formatDay(iso: string): string {
  const d = fromIso(iso);
  return d ? d.toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' }) : iso;
}

export function formatRange(start: string, end: string): string {
  const s = fromIso(start);
  const e = fromIso(end);
  if (!s || !e) return `${start} – ${end}`;
  const mShort = (d: Date) => d.toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
  const withYear = (d: Date) => d.toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' });
  if (s.getFullYear() !== e.getFullYear()) return `${withYear(s)} – ${withYear(e)}`;
  if (s.getMonth() === e.getMonth()) return `${mShort(s)} – ${e.getDate()}, ${e.getFullYear()}`;
  return `${mShort(s)} – ${mShort(e)}, ${e.getFullYear()}`;
}

/* ------------------------------------------------------------------ */
/* Accent (class-string theming, same shape PeopleTab already passes)  */
/* ------------------------------------------------------------------ */

export interface PickerAccent {
  /** Focus ring classes for the trigger. */
  ring: string;
  /** Soft tint for in-range days / active-filter trigger chip. */
  chipBg: string;
  chipText: string;
  /** Kept for compatibility with existing dashboard accent objects. */
  btn: string;
  /** Solid fill for selected day / range edges. */
  bar: string;
  /** Text on top of `bar` (defaults to white). */
  barText?: string;
  /** Focus ring for controls *inside* the panel (nav, presets, day cells).
   *  Falls back to the brand default so a themed picker stays cohesive. */
  focusRing?: string;
  /** Text color for the "today" marker (number + dot). Falls back to brand. */
  today?: string;
}

/** Brand-orange default (see `--primary` in index.css). Every emphasis color
 *  is AA-legible in both themes; picking a hue keeps the whole popover on one
 *  color story instead of leaking a stray accent into focus/today/month cells. */
const DEFAULT_ACCENT: PickerAccent = {
  ring: 'focus-visible:ring-orange-500/30 focus-visible:border-orange-500',
  chipBg: 'bg-orange-50 dark:bg-orange-950/40',
  chipText: 'text-orange-800 dark:text-orange-200',
  btn: '',
  bar: 'bg-orange-700 dark:bg-orange-500',
  barText: 'text-white dark:text-orange-950',
  focusRing: 'focus-visible:ring-orange-500/50',
  today: 'text-orange-700 dark:text-orange-300',
};

/** Every emphasis color MonthGrid needs, with the optional interior fields
 *  (focus ring + today marker) resolved from the brand default. */
type GridAccent = { bar: string; barText: string; chipBg: string; chipText: string; focusRing: string; today: string };
const resolveGridAccent = (a: PickerAccent): GridAccent => ({
  bar: a.bar,
  barText: a.barText ?? 'text-white',
  chipBg: a.chipBg,
  chipText: a.chipText,
  focusRing: a.focusRing ?? DEFAULT_ACCENT.focusRing!,
  today: a.today ?? DEFAULT_ACCENT.today!,
});
const DEFAULT_GRID = resolveGridAccent(DEFAULT_ACCENT);

/* ------------------------------------------------------------------ */
/* Popover shell: outside-click / Escape close + edge-aware placement  */
/* ------------------------------------------------------------------ */

function usePickerPopover(panelWidthPx: number) {
  const [open, setOpen] = useState(false);
  const [placement, setPlacement] = useState<{ up: boolean; right: boolean }>({ up: false, right: false });
  const rootRef = useRef<HTMLDivElement>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);

  const openPanel = () => {
    const rect = rootRef.current?.getBoundingClientRect();
    if (rect) {
      const spaceBelow = window.innerHeight - rect.bottom;
      setPlacement({
        up: spaceBelow < 400 && rect.top > spaceBelow,
        right: rect.left + panelWidthPx > window.innerWidth - 16,
      });
    }
    setOpen(true);
  };
  const closePanel = (refocus = false) => {
    setOpen(false);
    if (refocus) triggerRef.current?.focus();
  };

  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => {
      if (rootRef.current && !rootRef.current.contains(e.target as Node)) closePanel();
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') closePanel(true);
    };
    document.addEventListener('mousedown', onDown);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('mousedown', onDown);
      document.removeEventListener('keydown', onKey);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);

  return { open, openPanel, closePanel, placement, rootRef, triggerRef };
}

const panelClass = (up: boolean, right: boolean) =>
  cn(
    'absolute z-50 rounded-xl border border-zinc-200 bg-white p-3 shadow-xl shadow-zinc-900/10',
    'dark:border-zinc-800 dark:bg-zinc-950 dark:shadow-black/40',
    'motion-safe:animate-in motion-safe:fade-in-0 motion-safe:zoom-in-95 motion-safe:duration-150',
    up ? 'bottom-full mb-2 motion-safe:slide-in-from-bottom-1' : 'top-full mt-2 motion-safe:slide-in-from-top-1',
    right ? 'right-0' : 'left-0',
    'max-w-[calc(100vw-2rem)]',
  );

const navBtnClass = (focusRing: string) =>
  cn(
    'flex h-7 w-7 items-center justify-center rounded-md text-zinc-500 transition-colors hover:bg-zinc-100 hover:text-zinc-700 focus-visible:outline-none focus-visible:ring-2 dark:text-zinc-400 dark:hover:bg-zinc-800 dark:hover:text-zinc-200',
    focusRing,
  );

/* ------------------------------------------------------------------ */
/* Month grid (shared by single + range pickers)                       */
/* ------------------------------------------------------------------ */

interface MonthGridProps {
  month: Date;
  todayIso: string;
  /** Inclusive selection bounds; for a single picker lo === hi. */
  lo: string | null;
  hi: string | null;
  isDisabled: (iso: string) => boolean;
  onPick: (iso: string) => void;
  onHover?: (iso: string | null) => void;
  focusIso: string | null;
  accent: GridAccent;
  range: boolean;
  /** Render out-of-month cells as empty space (two-month layouts). */
  hideOutside?: boolean;
}

function MonthGrid({ month, todayIso, lo, hi, isDisabled, onPick, onHover, focusIso, accent, range, hideOutside }: MonthGridProps) {
  const cells = useMemo(() => {
    const first = startOfMonth(month);
    const gridStart = addDays(first, -first.getDay());
    return Array.from({ length: 42 }, (_, i) => addDays(gridStart, i));
  }, [month]);

  return (
    <div>
      <div className="grid grid-cols-7 text-center text-[10px] font-medium uppercase tracking-wide text-zinc-500 dark:text-zinc-400">
        {DOW.map((d) => (
          <div key={d} className="py-1">
            {d}
          </div>
        ))}
      </div>
      <div className="grid grid-cols-7 gap-y-1" onMouseLeave={() => onHover?.(null)}>
        {cells.map((d) => {
          const iso = toIso(d);
          const inMonth = sameMonth(d, month);
          if (hideOutside && !inMonth) return <div key={iso} aria-hidden className="h-9" />;
          const disabled = isDisabled(iso);
          const isToday = iso === todayIso;
          const inRange = !!(lo && hi && iso >= lo && iso <= hi);
          const isStart = iso === lo;
          const isEnd = iso === hi;
          const isEdge = isStart || isEnd;
          const spanned = range && inRange && lo !== hi;
          return (
            <button
              key={iso}
              type="button"
              data-iso={iso}
              disabled={disabled}
              tabIndex={focusIso === iso ? 0 : -1}
              aria-label={d.toLocaleDateString('en-US', { weekday: 'long', month: 'long', day: 'numeric', year: 'numeric' })}
              aria-pressed={isEdge}
              onClick={() => onPick(iso)}
              onMouseEnter={onHover ? () => onHover(iso) : undefined}
              className={cn(
                'relative h-9 w-full text-[13px] tabular-nums transition-colors focus-visible:outline-none',
                disabled && 'cursor-not-allowed text-zinc-300 dark:text-zinc-700',
                !disabled && !inMonth && !inRange && 'text-zinc-400 dark:text-zinc-600',
                !disabled && inMonth && !inRange && 'text-zinc-700 dark:text-zinc-200',
                !disabled && !isEdge && 'rounded-lg hover:bg-zinc-100 dark:hover:bg-zinc-800',
                inRange && !isEdge && cn('rounded-none', accent.chipBg, accent.chipText, 'font-medium'),
                !disabled && cn('focus-visible:ring-2 focus-visible:ring-inset', accent.focusRing),
              )}
            >
              {/* Continuous tint behind the edge days of a multi-day range. */}
              {spanned && isStart && !isEnd && <span aria-hidden className={cn('absolute inset-y-0 right-0 w-1/2', accent.chipBg)} />}
              {spanned && isEnd && !isStart && <span aria-hidden className={cn('absolute inset-y-0 left-0 w-1/2', accent.chipBg)} />}
              <span
                className={cn(
                  'relative z-10 mx-auto flex h-9 w-9 items-center justify-center rounded-lg',
                  isEdge && cn('font-semibold', accent.bar, accent.barText),
                  !isEdge && isToday && !disabled && cn('font-semibold', accent.today),
                )}
              >
                {d.getDate()}
                {isToday && (
                  <span
                    aria-hidden
                    className={cn('absolute bottom-1 h-1 w-1 rounded-full bg-current', isEdge && 'opacity-80')}
                  />
                )}
              </span>
            </button>
          );
        })}
      </div>
    </div>
  );
}

/** Roving-focus keyboard navigation for the day grid. */
function useGridKeyNav({
  focusIso,
  setFocusIso,
  clampToView,
  isDisabled,
  panelRef,
  active,
}: {
  focusIso: string | null;
  setFocusIso: (iso: string) => void;
  /** Ensure the visible month(s) contain the target day. */
  clampToView: (target: Date) => void;
  isDisabled: (iso: string) => boolean;
  panelRef: React.RefObject<HTMLDivElement | null>;
  active: boolean;
}) {
  // Keep DOM focus glued to the roving cell.
  useEffect(() => {
    if (!active || !focusIso) return;
    const el = panelRef.current?.querySelector<HTMLButtonElement>(`[data-iso="${focusIso}"]`);
    if (el && document.activeElement !== el && panelRef.current?.contains(document.activeElement)) {
      el.focus();
    }
  }, [focusIso, active, panelRef]);

  return (e: React.KeyboardEvent) => {
    if (!focusIso) return;
    const cur = fromIso(focusIso);
    if (!cur) return;
    let target: Date | null = null;
    switch (e.key) {
      case 'ArrowLeft':
        target = addDays(cur, -1);
        break;
      case 'ArrowRight':
        target = addDays(cur, 1);
        break;
      case 'ArrowUp':
        target = addDays(cur, -7);
        break;
      case 'ArrowDown':
        target = addDays(cur, 7);
        break;
      case 'PageUp':
        target = new Date(cur.getFullYear(), cur.getMonth() - (e.shiftKey ? 12 : 1), cur.getDate());
        break;
      case 'PageDown':
        target = new Date(cur.getFullYear(), cur.getMonth() + (e.shiftKey ? 12 : 1), cur.getDate());
        break;
      case 'Home':
        target = startOfMonth(cur);
        break;
      case 'End':
        target = addDays(addMonths(cur, 1), -1);
        break;
      default:
        return;
    }
    e.preventDefault();
    const iso = toIso(target);
    if (isDisabled(iso)) return;
    clampToView(target);
    setFocusIso(iso);
    requestAnimationFrame(() => {
      panelRef.current?.querySelector<HTMLButtonElement>(`[data-iso="${iso}"]`)?.focus();
    });
  };
}

/* ------------------------------------------------------------------ */
/* Single-date picker                                                  */
/* ------------------------------------------------------------------ */

export interface DatePickerProps {
  /** Selected day as "YYYY-MM-DD", or "" for none. */
  value: string;
  onChange: (iso: string) => void;
  id?: string;
  min?: string;
  max?: string;
  disabled?: boolean;
  required?: boolean;
  /** Name for the hidden form field (form submission / validation). */
  name?: string;
  placeholder?: string;
  /** Show an inline × to clear the value (default: true when not required). */
  clearable?: boolean;
  /** Classes for the trigger button (borders, height, focus ring, …). */
  className?: string;
  /** Classes for the outer wrapper (width / flex sizing). */
  containerClassName?: string;
  'aria-label'?: string;
  'aria-invalid'?: React.AriaAttributes['aria-invalid'];
}

type PaneView = 'days' | 'months' | 'years';

export function DatePicker({
  value,
  onChange,
  id,
  min,
  max,
  disabled = false,
  required = false,
  name,
  placeholder = 'Pick a date',
  clearable,
  className,
  containerClassName,
  'aria-label': ariaLabel,
  'aria-invalid': ariaInvalid,
}: DatePickerProps) {
  const { open, openPanel, closePanel, placement, rootRef, triggerRef } = usePickerPopover(304);
  const panelRef = useRef<HTMLDivElement>(null);
  const [viewMonth, setViewMonth] = useState<Date>(() => startOfMonth(new Date()));
  const [view, setView] = useState<PaneView>('days');
  const [focusIso, setFocusIso] = useState<string | null>(null);
  const [yearBase, setYearBase] = useState(0);

  const minIso = (min ?? '').trim() || null;
  const maxIso = (max ?? '').trim() || null;
  const canClear = clearable ?? !required;
  const isDisabled = (iso: string) => !!((minIso && iso < minIso) || (maxIso && iso > maxIso));

  const clampIso = (iso: string) => (minIso && iso < minIso ? minIso : maxIso && iso > maxIso ? maxIso : iso);

  const show = () => {
    const todayIso = toIso(new Date());
    const anchor = value && fromIso(value) ? value : clampIso(todayIso);
    const anchorDate = fromIso(anchor) ?? new Date();
    setViewMonth(startOfMonth(anchorDate));
    setView('days');
    setFocusIso(anchor);
    setYearBase(Math.floor(anchorDate.getFullYear() / 12) * 12);
    openPanel();
    requestAnimationFrame(() => {
      panelRef.current?.querySelector<HTMLButtonElement>(`[data-iso="${anchor}"]`)?.focus();
    });
  };

  const pick = (iso: string) => {
    if (isDisabled(iso)) return;
    onChange(iso);
    closePanel(true);
  };

  const onGridKeys = useGridKeyNav({
    focusIso,
    setFocusIso,
    clampToView: (t) => {
      if (!sameMonth(t, viewMonth)) setViewMonth(startOfMonth(t));
    },
    isDisabled,
    panelRef,
    active: open && view === 'days',
  });

  const todayIso = toIso(new Date());
  const monthDisabled = (y: number, m: number) => {
    const first = toIso(new Date(y, m, 1));
    const last = toIso(addDays(new Date(y, m + 1, 1), -1));
    return !!((maxIso && first > maxIso) || (minIso && last < minIso));
  };
  const yearDisabled = (y: number) => monthDisabled(y, 0) && monthDisabled(y, 11);

  return (
    <div ref={rootRef} className={cn('relative w-full', containerClassName)}>
      <button
        ref={triggerRef}
        type="button"
        id={id}
        disabled={disabled}
        aria-haspopup="dialog"
        aria-expanded={open}
        aria-label={ariaLabel}
        aria-invalid={ariaInvalid}
        onClick={() => (open ? closePanel() : show())}
        className={cn(
          'flex h-9 w-full min-w-0 items-center gap-2 rounded-lg border border-zinc-300 bg-transparent px-2.5 text-left text-sm text-zinc-900 transition-colors outline-none',
          'focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring/50',
          'disabled:pointer-events-none disabled:cursor-not-allowed disabled:bg-input/50 disabled:opacity-50',
          'aria-invalid:border-destructive aria-invalid:ring-3 aria-invalid:ring-destructive/20',
          'dark:border-input dark:bg-input/30 dark:text-zinc-100 dark:disabled:bg-input/80',
          'hover:border-zinc-400 dark:hover:border-zinc-600',
          className,
        )}
      >
        <CalendarDays className="h-4 w-4 shrink-0 text-zinc-400 dark:text-zinc-500" aria-hidden />
        <span className={cn('min-w-0 flex-1 truncate', !value && 'text-zinc-500 dark:text-zinc-400')}>
          {value ? formatDay(value) : placeholder}
        </span>
        {canClear && value && !disabled && (
          <span
            role="button"
            tabIndex={0}
            aria-label="Clear date"
            onClick={(e) => {
              e.stopPropagation();
              onChange('');
            }}
            onKeyDown={(e) => {
              if (e.key === 'Enter' || e.key === ' ') {
                e.preventDefault();
                e.stopPropagation();
                onChange('');
              }
            }}
            className="shrink-0 rounded p-0.5 text-zinc-400 transition-colors hover:text-zinc-600 dark:hover:text-zinc-300"
          >
            <X className="h-3.5 w-3.5" />
          </span>
        )}
      </button>

      {/* Invisible mirror input so native form `required` validation still works. */}
      {(required || name) && (
        <input
          type="text"
          tabIndex={-1}
          aria-hidden="true"
          required={required}
          name={name}
          value={value}
          onChange={() => {}}
          className="pointer-events-none absolute inset-0 h-full w-full opacity-0"
        />
      )}

      {open && (
        <div ref={panelRef} role="dialog" aria-label="Choose a date" className={cn(panelClass(placement.up, placement.right), 'w-[19rem]')}>
          {/* Header: month/year drill-down + paging */}
          <div className="mb-1 flex items-center justify-between">
            <button
              type="button"
              aria-label={view === 'years' ? 'Previous years' : view === 'months' ? 'Previous year' : 'Previous month'}
              onClick={() => {
                if (view === 'days') setViewMonth((m) => addMonths(m, -1));
                else if (view === 'months') setViewMonth((m) => new Date(m.getFullYear() - 1, m.getMonth(), 1));
                else setYearBase((b) => b - 12);
              }}
              className={navBtnClass(DEFAULT_GRID.focusRing)}
            >
              <ChevronLeft className="h-4 w-4" />
            </button>
            <button
              type="button"
              onClick={() => setView((v) => (v === 'days' ? 'months' : v === 'months' ? 'years' : 'days'))}
              aria-label="Choose month and year"
              className={cn(
                'rounded-md px-2 py-1 text-[13px] font-semibold text-zinc-800 transition-colors hover:bg-zinc-100 focus-visible:outline-none focus-visible:ring-2 dark:text-zinc-100 dark:hover:bg-zinc-800',
                DEFAULT_GRID.focusRing,
              )}
            >
              {view === 'years'
                ? `${yearBase}–${yearBase + 11}`
                : view === 'months'
                  ? viewMonth.getFullYear()
                  : viewMonth.toLocaleDateString('en-US', { month: 'long', year: 'numeric' })}
            </button>
            <button
              type="button"
              aria-label={view === 'years' ? 'Next years' : view === 'months' ? 'Next year' : 'Next month'}
              onClick={() => {
                if (view === 'days') setViewMonth((m) => addMonths(m, 1));
                else if (view === 'months') setViewMonth((m) => new Date(m.getFullYear() + 1, m.getMonth(), 1));
                else setYearBase((b) => b + 12);
              }}
              className={navBtnClass(DEFAULT_GRID.focusRing)}
            >
              <ChevronRight className="h-4 w-4" />
            </button>
          </div>

          {view === 'days' && (
            <div onKeyDown={onGridKeys}>
              <MonthGrid
                month={viewMonth}
                todayIso={todayIso}
                lo={value || null}
                hi={value || null}
                isDisabled={isDisabled}
                onPick={pick}
                focusIso={focusIso}
                accent={DEFAULT_GRID}
                range={false}
              />
            </div>
          )}

          {view === 'months' && (
            <div className="grid grid-cols-3 gap-1 py-1">
              {MONTHS_SHORT.map((label, m) => {
                const off = monthDisabled(viewMonth.getFullYear(), m);
                const isCurrent = viewMonth.getMonth() === m;
                return (
                  <button
                    key={label}
                    type="button"
                    disabled={off}
                    onClick={() => {
                      setViewMonth(new Date(viewMonth.getFullYear(), m, 1));
                      setView('days');
                    }}
                    className={cn(
                      'h-9 rounded-lg text-[13px] transition-colors focus-visible:outline-none focus-visible:ring-2',
                      DEFAULT_GRID.focusRing,
                      off && 'cursor-not-allowed text-zinc-300 dark:text-zinc-700',
                      !off && isCurrent && cn('font-semibold', DEFAULT_GRID.bar, DEFAULT_GRID.barText),
                      !off && !isCurrent && 'text-zinc-700 hover:bg-zinc-100 dark:text-zinc-200 dark:hover:bg-zinc-800',
                    )}
                  >
                    {label}
                  </button>
                );
              })}
            </div>
          )}

          {view === 'years' && (
            <div className="grid grid-cols-3 gap-1 py-1">
              {Array.from({ length: 12 }, (_, i) => yearBase + i).map((y) => {
                const off = yearDisabled(y);
                const isCurrent = viewMonth.getFullYear() === y;
                return (
                  <button
                    key={y}
                    type="button"
                    disabled={off}
                    onClick={() => {
                      setViewMonth(new Date(y, viewMonth.getMonth(), 1));
                      setView('months');
                    }}
                    className={cn(
                      'h-9 rounded-lg text-[13px] tabular-nums transition-colors focus-visible:outline-none focus-visible:ring-2',
                      DEFAULT_GRID.focusRing,
                      off && 'cursor-not-allowed text-zinc-300 dark:text-zinc-700',
                      !off && isCurrent && cn('font-semibold', DEFAULT_GRID.bar, DEFAULT_GRID.barText),
                      !off && !isCurrent && 'text-zinc-700 hover:bg-zinc-100 dark:text-zinc-200 dark:hover:bg-zinc-800',
                    )}
                  >
                    {y}
                  </button>
                );
              })}
            </div>
          )}

          {/* Footer */}
          <div className="mt-2 flex items-center justify-between border-t border-zinc-100 pt-2 dark:border-zinc-800">
            <button
              type="button"
              disabled={isDisabled(todayIso)}
              onClick={() => pick(todayIso)}
              className={cn(
                'rounded-md px-1.5 py-0.5 text-[12px] font-medium transition-colors hover:bg-zinc-100 focus-visible:outline-none focus-visible:ring-2 disabled:cursor-not-allowed disabled:text-zinc-300 dark:hover:bg-zinc-800 dark:disabled:text-zinc-700',
                DEFAULT_GRID.today,
                DEFAULT_GRID.focusRing,
              )}
            >
              Today
            </button>
            {canClear && value ? (
              <button
                type="button"
                onClick={() => {
                  onChange('');
                  closePanel(true);
                }}
                className={cn(
                  'rounded-md px-1.5 py-0.5 text-[12px] font-medium text-zinc-500 transition-colors hover:bg-zinc-100 focus-visible:outline-none focus-visible:ring-2 dark:text-zinc-400 dark:hover:bg-zinc-800',
                  DEFAULT_GRID.focusRing,
                )}
              >
                Clear
              </button>
            ) : (
              <span className="text-[11px] text-zinc-500 dark:text-zinc-400">{value ? formatDay(value) : ''}</span>
            )}
          </div>
        </div>
      )}
    </div>
  );
}

/* ------------------------------------------------------------------ */
/* Date-range picker                                                   */
/* ------------------------------------------------------------------ */

export interface DateRange {
  /** Inclusive start, "YYYY-MM-DD". */
  start: string;
  /** Inclusive end, "YYYY-MM-DD". */
  end: string;
}

export interface RangePreset {
  label: string;
  make: () => DateRange;
}

/** Presets covering the common payroll windows; computed on click (never
 *  during render) so a server/client clock mismatch can't desync hydration. */
export const DEFAULT_RANGE_PRESETS: RangePreset[] = [
  { label: 'Last 4 weeks', make: () => ({ start: toIso(addDays(new Date(), -27)), end: toIso(new Date()) }) },
  { label: 'Last 8 weeks', make: () => ({ start: toIso(addDays(new Date(), -55)), end: toIso(new Date()) }) },
  { label: 'This month', make: () => ({ start: toIso(startOfMonth(new Date())), end: toIso(new Date()) }) },
  {
    label: 'Last month',
    make: () => {
      const lastPrev = addDays(startOfMonth(new Date()), -1);
      return { start: toIso(startOfMonth(lastPrev)), end: toIso(lastPrev) };
    },
  },
];

export interface DateRangePickerProps {
  value: DateRange | null;
  onChange: (v: DateRange | null) => void;
  accent?: PickerAccent;
  /** Earliest selectable day (YYYY-MM-DD). */
  min?: string | null;
  /** Latest selectable day (YYYY-MM-DD). */
  max?: string | null;
  presets?: RangePreset[];
  placeholder?: string;
  className?: string;
  title?: string;
}

/**
 * Calendar-based date-range picker. Click a start day then an end day
 * (order-independent — they're sorted), with a live hover preview of the
 * span. Shows two months side by side on wider screens. Quick presets cover
 * the common payroll windows; `min`/`max` bound the selectable days.
 */
export function DateRangePicker({
  value,
  onChange,
  accent = DEFAULT_ACCENT,
  min,
  max,
  presets = DEFAULT_RANGE_PRESETS,
  placeholder = 'Custom date range',
  className,
  title,
}: DateRangePickerProps) {
  const { open, openPanel, closePanel, placement, rootRef, triggerRef } = usePickerPopover(576);
  const panelRef = useRef<HTMLDivElement>(null);
  const [viewMonth, setViewMonth] = useState<Date>(() => startOfMonth(new Date()));
  // First click of an in-progress selection (null = none pending / range complete).
  const [pendingStart, setPendingStart] = useState<string | null>(null);
  const [hoverDay, setHoverDay] = useState<string | null>(null);
  const [focusIso, setFocusIso] = useState<string | null>(null);

  const maxIso = (max ?? '').trim() || null;
  const minIso = (min ?? '').trim() || null;
  const isDisabled = (iso: string) => !!((minIso && iso < minIso) || (maxIso && iso > maxIso));

  const gridAccent = resolveGridAccent(accent);

  const show = () => {
    const anchorIso = value ? value.end : maxIso ?? toIso(new Date());
    const anchor = fromIso(anchorIso) ?? new Date();
    // Anchor the right-hand month at the range end so recent context is visible.
    setViewMonth(addMonths(startOfMonth(anchor), -1));
    setPendingStart(null);
    setHoverDay(null);
    setFocusIso(anchorIso);
    openPanel();
    requestAnimationFrame(() => {
      panelRef.current?.querySelector<HTMLButtonElement>(`[data-iso="${anchorIso}"]`)?.focus();
    });
  };
  const hide = (refocus = false) => {
    setPendingStart(null);
    setHoverDay(null);
    closePanel(refocus);
  };

  // Highlighted span: the pending selection (start + hover) while choosing,
  // else the committed value.
  let lo: string | null = null;
  let hi: string | null = null;
  if (pendingStart) {
    const other = hoverDay ?? focusIso ?? pendingStart;
    lo = pendingStart < other ? pendingStart : other;
    hi = pendingStart < other ? other : pendingStart;
  } else if (value) {
    lo = value.start;
    hi = value.end;
  }

  // Track hover in focusIso too, so the keyboard preview continues from the
  // pointer's last position instead of a stale anchor.
  const hoverDayTo = (iso: string | null) => {
    setHoverDay(iso);
    if (iso) setFocusIso(iso);
  };

  const pickDay = (iso: string) => {
    if (isDisabled(iso)) return;
    if (!pendingStart) {
      setPendingStart(iso);
      setFocusIso(iso);
      return;
    }
    const start = pendingStart < iso ? pendingStart : iso;
    const end = pendingStart < iso ? iso : pendingStart;
    onChange({ start, end });
    hide(true);
  };

  const applyPreset = (r: DateRange) => {
    onChange({
      start: minIso && r.start < minIso ? minIso : r.start,
      end: maxIso && r.end > maxIso ? maxIso : r.end,
    });
    hide(true);
  };

  const rightMonth = addMonths(viewMonth, 1);
  const onGridKeys = useGridKeyNav({
    focusIso,
    setFocusIso,
    clampToView: (t) => {
      if (toIso(t) < toIso(viewMonth)) setViewMonth(startOfMonth(t));
      else if (!sameMonth(t, viewMonth) && !sameMonth(t, rightMonth)) setViewMonth(addMonths(startOfMonth(t), -1));
    },
    isDisabled,
    panelRef,
    active: open,
  });

  const todayIso = toIso(new Date());

  return (
    <div ref={rootRef} className={cn('relative', className)}>
      <button
        ref={triggerRef}
        type="button"
        onClick={() => (open ? hide() : show())}
        aria-haspopup="dialog"
        aria-expanded={open}
        title={title}
        className={cn(
          'flex h-9 w-full items-center gap-2 rounded-lg border bg-white px-2.5 text-[13px] transition-colors dark:bg-zinc-950',
          'focus:outline-none focus-visible:ring-2',
          accent.ring,
          value
            ? cn('border-transparent font-medium', accent.chipBg, accent.chipText)
            : 'border-zinc-300 text-zinc-600 hover:border-zinc-400 dark:border-zinc-700 dark:text-zinc-300 dark:hover:border-zinc-600',
        )}
      >
        <CalendarRange className="h-4 w-4 shrink-0 opacity-70" aria-hidden />
        <span className="min-w-0 flex-1 truncate text-left">{value ? formatRange(value.start, value.end) : placeholder}</span>
        {value && (
          <span
            role="button"
            tabIndex={0}
            aria-label="Clear date range"
            onClick={(e) => {
              e.stopPropagation();
              onChange(null);
            }}
            onKeyDown={(e) => {
              if (e.key === 'Enter' || e.key === ' ') {
                e.preventDefault();
                e.stopPropagation();
                onChange(null);
              }
            }}
            className="shrink-0 rounded p-0.5 opacity-70 transition-opacity hover:opacity-100"
          >
            <X className="h-3.5 w-3.5" />
          </span>
        )}
      </button>

      {open && (
        <div
          ref={panelRef}
          role="dialog"
          aria-label="Choose a date range"
          className={cn(panelClass(placement.up, placement.right), 'w-[19rem] sm:w-[36rem]')}
        >
          {/* Presets */}
          {presets.length > 0 && (
            <div className="mb-2 flex flex-wrap gap-1.5">
              {presets.map((p) => (
                <button
                  key={p.label}
                  type="button"
                  onClick={() => applyPreset(p.make())}
                  className={cn(
                    'rounded-full border border-zinc-200 px-2.5 py-1 text-[11px] font-medium text-zinc-600 transition-colors hover:bg-zinc-50 focus-visible:outline-none focus-visible:ring-2 dark:border-zinc-700 dark:text-zinc-300 dark:hover:bg-zinc-900',
                    gridAccent.focusRing,
                  )}
                >
                  {p.label}
                </button>
              ))}
            </div>
          )}

          {/* Month headers + nav */}
          <div className="mb-1 flex items-center">
            <button type="button" onClick={() => setViewMonth((m) => addMonths(m, -1))} className={navBtnClass(gridAccent.focusRing)} aria-label="Previous month">
              <ChevronLeft className="h-4 w-4" />
            </button>
            <span className="flex-1 text-center text-[13px] font-semibold text-zinc-800 dark:text-zinc-100">
              {viewMonth.toLocaleDateString('en-US', { month: 'long', year: 'numeric' })}
            </span>
            <span className="hidden flex-1 text-center text-[13px] font-semibold text-zinc-800 sm:block dark:text-zinc-100">
              {rightMonth.toLocaleDateString('en-US', { month: 'long', year: 'numeric' })}
            </span>
            <button type="button" onClick={() => setViewMonth((m) => addMonths(m, 1))} className={navBtnClass(gridAccent.focusRing)} aria-label="Next month">
              <ChevronRight className="h-4 w-4" />
            </button>
          </div>

          {/* Day grids */}
          <div className="flex gap-4" onKeyDown={onGridKeys}>
            <div className="min-w-0 flex-1">
              <MonthGrid
                month={viewMonth}
                todayIso={todayIso}
                lo={lo}
                hi={hi}
                isDisabled={isDisabled}
                onPick={pickDay}
                onHover={hoverDayTo}
                focusIso={focusIso}
                accent={gridAccent}
                range
                hideOutside
              />
            </div>
            <div className="hidden min-w-0 flex-1 sm:block">
              <MonthGrid
                month={rightMonth}
                todayIso={todayIso}
                lo={lo}
                hi={hi}
                isDisabled={isDisabled}
                onPick={pickDay}
                onHover={hoverDayTo}
                focusIso={focusIso}
                accent={gridAccent}
                range
                hideOutside
              />
            </div>
          </div>

          {/* Footer — selection hint + clear */}
          <div className="mt-2 flex items-center justify-between gap-2 border-t border-zinc-100 pt-2 dark:border-zinc-800">
            <span className="text-[11px] text-zinc-500 dark:text-zinc-400" aria-live="polite">
              {pendingStart
                ? lo && hi && lo !== hi
                  ? `${formatRange(lo, hi)} — pick the end date`
                  : 'Pick the end date…'
                : value
                  ? formatRange(value.start, value.end)
                  : 'Pick a start date'}
            </span>
            {value && (
              <button
                type="button"
                onClick={() => {
                  onChange(null);
                  hide(true);
                }}
                className={cn(
                  'rounded-md px-1.5 py-0.5 text-[12px] font-medium text-zinc-500 transition-colors hover:bg-zinc-100 focus-visible:outline-none focus-visible:ring-2 dark:text-zinc-400 dark:hover:bg-zinc-800',
                  gridAccent.focusRing,
                )}
              >
                Clear
              </button>
            )}
          </div>
        </div>
      )}
    </div>
  );
}

/* ------------------------------------------------------------------ */
/* Week picker (Sun → Sat snap)                                        */
/* ------------------------------------------------------------------ */

/** The Sun→Sat week containing `iso` (start = Sunday, end = Saturday). */
export function weekRangeOfIso(iso: string): DateRange | null {
  const d = fromIso(iso);
  if (!d) return null;
  const sun = addDays(d, -d.getDay());
  return { start: toIso(sun), end: toIso(addDays(sun, 6)) };
}

export interface WeekPickerProps {
  /** Committed pay week — `start` is the Sunday, `end` the Saturday. */
  value: DateRange | null;
  /** Fired with the full snapped week whenever a day is picked. */
  onChange: (v: DateRange) => void;
  /** Days outside [min, max] can't be picked (the snapped week may still extend past them). */
  min?: string | null;
  max?: string | null;
  disabled?: boolean;
  accent?: PickerAccent;
  /** Wrapper classes (positioning / flex sizing). */
  className?: string;
  /** Full class override for the trigger button; defaults to the standard picker chip. */
  triggerClassName?: string;
  /** Trigger content; defaults to a calendar icon + the selected week's label. */
  children?: React.ReactNode;
  placeholder?: string;
  title?: string;
  /**
   * Confirm CTA rendered in the footer, labeled `"{actionLabel} {week label}"`
   * (e.g. "Sync Jul 5 – 11, 2026"). While set, picking a day only moves the
   * selection — the CTA commits it, so the operator always sees the exact
   * Sun→Sat cutoff they are about to act on.
   */
  actionLabel?: string;
  actionBusy?: boolean;
  onAction?: (v: DateRange) => void;
  'aria-label'?: string;
}

/**
 * Calendar popover that selects whole Sunday→Saturday pay weeks: hovering
 * previews the full week and one click selects both the start and the finish.
 * Same shell, grid, and keyboard model as {@link DateRangePicker}.
 */
export function WeekPicker({
  value,
  onChange,
  min,
  max,
  disabled = false,
  accent = DEFAULT_ACCENT,
  className,
  triggerClassName,
  children,
  placeholder = 'Pick a pay week',
  title,
  actionLabel,
  actionBusy = false,
  onAction,
  'aria-label': ariaLabel,
}: WeekPickerProps) {
  // Renders as a centered modal (not an anchored popover): a focused surface
  // for picking the exact Sun→Sat pay week before syncing.
  const [open, setOpen] = useState(false);
  const panelRef = useRef<HTMLDivElement>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const reduceMotion = useReducedMotion();
  const [viewMonth, setViewMonth] = useState<Date>(() => startOfMonth(new Date()));
  const [hoverDay, setHoverDay] = useState<string | null>(null);
  const [focusIso, setFocusIso] = useState<string | null>(null);

  const minIso = (min ?? '').trim() || null;
  const maxIso = (max ?? '').trim() || null;
  const isDisabled = (iso: string) => !!((minIso && iso < minIso) || (maxIso && iso > maxIso));

  const gridAccent = resolveGridAccent(accent);

  const show = () => {
    const anchorIso = value ? value.start : maxIso ?? toIso(new Date());
    const anchor = fromIso(anchorIso) ?? new Date();
    // Left month = the selected week's month, so the selection is visible even
    // on mobile where only the left grid renders.
    setViewMonth(startOfMonth(anchor));
    setHoverDay(null);
    setFocusIso(anchorIso);
    setOpen(true);
    requestAnimationFrame(() => {
      panelRef.current?.querySelector<HTMLButtonElement>(`[data-iso="${anchorIso}"]`)?.focus();
    });
  };
  const hide = (refocus = false) => {
    setHoverDay(null);
    setOpen(false);
    if (refocus) triggerRef.current?.focus();
  };

  // Modal chrome: Escape closes, and the body scroll locks while it's open so
  // the calendar is the only thing the operator interacts with.
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.stopPropagation();
        hide(true);
        return;
      }
      // Keep Tab focus inside the dialog.
      if (e.key === 'Tab' && panelRef.current) {
        const focusables = Array.from(
          panelRef.current.querySelectorAll<HTMLElement>(
            'button:not([disabled]):not([tabindex="-1"]), [href], input:not([disabled]), [tabindex]:not([tabindex="-1"])',
          ),
        ).filter((el) => el.offsetParent !== null);
        if (focusables.length === 0) return;
        const first = focusables[0]!;
        const last = focusables[focusables.length - 1]!;
        const active = document.activeElement as HTMLElement | null;
        if (active && !panelRef.current.contains(active)) {
          e.preventDefault();
          first.focus();
        } else if (e.shiftKey && active === first) {
          e.preventDefault();
          last.focus();
        } else if (!e.shiftKey && active === last) {
          e.preventDefault();
          first.focus();
        }
      }
    };
    document.addEventListener('keydown', onKey);
    const prevOverflow = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    return () => {
      document.removeEventListener('keydown', onKey);
      document.body.style.overflow = prevOverflow;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);

  // Highlighted span: the hovered day's week while the pointer is in the grid,
  // else the committed value — never a stale focus position, so the highlighted
  // week and the confirm CTA can't disagree about what will be synced.
  const previewWeek = hoverDay ? weekRangeOfIso(hoverDay) : null;
  const shown = previewWeek ?? value;
  const lo = shown?.start ?? null;
  const hi = shown?.end ?? null;

  const hoverDayTo = (iso: string | null) => {
    setHoverDay(iso);
    if (iso) setFocusIso(iso);
  };

  const pickDay = (iso: string) => {
    if (isDisabled(iso)) return;
    const week = weekRangeOfIso(iso);
    if (!week) return;
    onChange(week);
    // With a confirm CTA the panel stays open so the operator can verify the
    // exact week before acting; without one, picking commits and closes.
    if (!onAction) hide(true);
  };

  /** Snap "today − offsetWeeks" to its week; clamp the anchor into [min, max]. */
  const pickRelativeWeek = (offsetWeeks: number) => {
    let anchor = toIso(addDays(new Date(), -7 * offsetWeeks));
    if (maxIso && anchor > maxIso) anchor = maxIso;
    if (minIso && anchor < minIso) anchor = minIso;
    const week = weekRangeOfIso(anchor);
    if (!week) return;
    const anchorDate = fromIso(week.start) ?? new Date();
    if (!sameMonth(anchorDate, viewMonth) && !sameMonth(anchorDate, addMonths(viewMonth, 1))) {
      setViewMonth(startOfMonth(anchorDate));
    }
    setFocusIso(week.start);
    onChange(week);
    if (!onAction) hide(true);
  };

  const rightMonth = addMonths(viewMonth, 1);
  const onGridKeys = useGridKeyNav({
    focusIso,
    setFocusIso,
    clampToView: (t) => {
      if (toIso(t) < toIso(viewMonth)) setViewMonth(startOfMonth(t));
      else if (!sameMonth(t, viewMonth) && !sameMonth(t, rightMonth)) setViewMonth(addMonths(startOfMonth(t), -1));
    },
    isDisabled,
    panelRef,
    active: open,
  });

  const todayIso = toIso(new Date());

  const weekLabel = value ? formatRange(value.start, value.end) : null;

  return (
    <div className={className}>
      <button
        ref={triggerRef}
        type="button"
        disabled={disabled}
        onClick={() => (open ? hide(true) : show())}
        aria-haspopup="dialog"
        aria-expanded={open}
        aria-label={ariaLabel}
        title={title}
        className={
          triggerClassName ??
          cn(
            'flex h-9 w-full items-center gap-2 rounded-lg border bg-white px-2.5 text-[13px] transition-colors dark:bg-zinc-950',
            'focus:outline-none focus-visible:ring-2',
            'disabled:pointer-events-none disabled:cursor-not-allowed disabled:opacity-50',
            accent.ring,
            value
              ? cn('border-transparent font-medium', accent.chipBg, accent.chipText)
              : 'border-zinc-300 text-zinc-600 hover:border-zinc-400 dark:border-zinc-700 dark:text-zinc-300 dark:hover:border-zinc-600',
          )
        }
      >
        {children ?? (
          <>
            <CalendarRange className="h-4 w-4 shrink-0 opacity-70" aria-hidden />
            <span className="min-w-0 flex-1 truncate text-left">
              {value ? formatRange(value.start, value.end) : placeholder}
            </span>
          </>
        )}
      </button>

      {typeof document !== 'undefined' &&
        createPortal(
          <AnimatePresence>
            {open && (
              <motion.div
                className="fixed inset-0 z-[120] flex items-center justify-center p-4 sm:p-6"
                initial={{ opacity: 0 }}
                animate={{ opacity: 1 }}
                exit={{ opacity: 0 }}
                transition={{ duration: reduceMotion ? 0 : 0.18 }}
              >
                {/* Backdrop */}
                <div
                  className="absolute inset-0 bg-zinc-950/50 backdrop-blur-sm"
                  onClick={() => hide(true)}
                  aria-hidden
                />

                {/* Card */}
                <motion.div
                  ref={panelRef}
                  role="dialog"
                  aria-modal="true"
                  aria-label="Choose a pay week"
                  tabIndex={-1}
                  onClick={(e) => e.stopPropagation()}
                  initial={reduceMotion ? { opacity: 0 } : { opacity: 0, scale: 0.96, y: 12 }}
                  animate={reduceMotion ? { opacity: 1 } : { opacity: 1, scale: 1, y: 0 }}
                  exit={reduceMotion ? { opacity: 0 } : { opacity: 0, scale: 0.97, y: 8 }}
                  transition={{ duration: reduceMotion ? 0 : 0.24, ease: [0.22, 1, 0.36, 1] }}
                  className="relative z-[1] flex max-h-[calc(100vh-2rem)] w-full max-w-[22rem] flex-col overflow-hidden rounded-2xl border border-zinc-200 bg-white shadow-2xl shadow-black/30 sm:max-w-2xl dark:border-zinc-800 dark:bg-[#0d1117]"
                >
                  {/* Header */}
                  <div className="flex items-start gap-3 border-b border-zinc-100 px-5 py-4 dark:border-zinc-800">
                    <span className={cn('flex h-9 w-9 shrink-0 items-center justify-center rounded-xl', gridAccent.chipBg, gridAccent.chipText)}>
                      <CalendarRange className="h-[18px] w-[18px]" aria-hidden />
                    </span>
                    <div className="min-w-0 flex-1">
                      <h2 className="text-[15px] font-semibold leading-tight text-zinc-900 dark:text-white">Select pay week</h2>
                      <p className="mt-0.5 text-[12.5px] leading-snug text-zinc-500 dark:text-zinc-400">
                        Pick any day and its whole Sunday → Saturday week is selected.
                      </p>
                    </div>
                    <button
                      type="button"
                      onClick={() => hide(true)}
                      aria-label="Close"
                      className={cn(
                        '-mr-1 -mt-1 shrink-0 rounded-lg p-1.5 text-zinc-400 transition-colors hover:bg-zinc-100 hover:text-zinc-600 focus-visible:outline-none focus-visible:ring-2 dark:hover:bg-zinc-800 dark:hover:text-zinc-300',
                        gridAccent.focusRing,
                      )}
                    >
                      <X className="h-4 w-4" />
                    </button>
                  </div>

                  {/* Body */}
                  <div className="min-h-0 flex-1 overflow-y-auto px-5 py-4">
                    {/* Presets — most syncs target the week that just closed. */}
                    <div className="mb-3 flex flex-wrap items-center gap-1.5">
                      {[
                        { label: 'Last week', offset: 1 },
                        { label: 'This week', offset: 0 },
                      ].map((p) => (
                        <button
                          key={p.label}
                          type="button"
                          onClick={() => pickRelativeWeek(p.offset)}
                          className={cn(
                            'rounded-full border border-zinc-200 px-3 py-1 text-[11px] font-medium text-zinc-600 transition-colors hover:bg-zinc-50 focus-visible:outline-none focus-visible:ring-2 dark:border-zinc-700 dark:text-zinc-300 dark:hover:bg-zinc-900',
                            gridAccent.focusRing,
                          )}
                        >
                          {p.label}
                        </button>
                      ))}
                      <span className="ml-auto flex items-center text-[10px] font-medium uppercase tracking-wide text-zinc-400 dark:text-zinc-500">
                        Sun → Sat
                      </span>
                    </div>

                    {/* Month headers + nav */}
                    <div className="mb-1 flex items-center">
                      <button type="button" onClick={() => setViewMonth((m) => addMonths(m, -1))} className={navBtnClass(gridAccent.focusRing)} aria-label="Previous month">
                        <ChevronLeft className="h-4 w-4" />
                      </button>
                      <span className="flex-1 text-center text-[13px] font-semibold text-zinc-800 dark:text-zinc-100">
                        {viewMonth.toLocaleDateString('en-US', { month: 'long', year: 'numeric' })}
                      </span>
                      <span className="hidden flex-1 text-center text-[13px] font-semibold text-zinc-800 sm:block dark:text-zinc-100">
                        {rightMonth.toLocaleDateString('en-US', { month: 'long', year: 'numeric' })}
                      </span>
                      <button type="button" onClick={() => setViewMonth((m) => addMonths(m, 1))} className={navBtnClass(gridAccent.focusRing)} aria-label="Next month">
                        <ChevronRight className="h-4 w-4" />
                      </button>
                    </div>

                    {/* Day grids — hovering any day previews its whole Sun→Sat week. */}
                    <div className="flex gap-5" onKeyDown={onGridKeys}>
                      <div className="min-w-0 flex-1">
                        <MonthGrid
                          month={viewMonth}
                          todayIso={todayIso}
                          lo={lo}
                          hi={hi}
                          isDisabled={isDisabled}
                          onPick={pickDay}
                          onHover={hoverDayTo}
                          focusIso={focusIso}
                          accent={gridAccent}
                          range
                          hideOutside
                        />
                      </div>
                      <div className="hidden min-w-0 flex-1 sm:block">
                        <MonthGrid
                          month={rightMonth}
                          todayIso={todayIso}
                          lo={lo}
                          hi={hi}
                          isDisabled={isDisabled}
                          onPick={pickDay}
                          onHover={hoverDayTo}
                          focusIso={focusIso}
                          accent={gridAccent}
                          range
                          hideOutside
                        />
                      </div>
                    </div>
                  </div>

                  {/* Footer — selected week + confirm CTA */}
                  <div className="flex items-center justify-between gap-3 border-t border-zinc-100 bg-zinc-50/70 px-5 py-3.5 dark:border-zinc-800 dark:bg-zinc-900/40">
                    <span className="min-w-0 flex-1 truncate text-[12px] text-zinc-500 dark:text-zinc-400" aria-live="polite">
                      {weekLabel ? (
                        <>
                          Selected: <span className="font-semibold text-zinc-700 dark:text-zinc-200">{weekLabel}</span>
                        </>
                      ) : (
                        'No week selected yet'
                      )}
                    </span>
                    <div className="flex shrink-0 items-center gap-2">
                      <button
                        type="button"
                        onClick={() => hide(true)}
                        className={cn(
                          'rounded-lg px-3 py-1.5 text-[12px] font-medium text-zinc-600 transition-colors hover:bg-zinc-100 focus-visible:outline-none focus-visible:ring-2 dark:text-zinc-300 dark:hover:bg-zinc-800',
                          gridAccent.focusRing,
                        )}
                      >
                        Cancel
                      </button>
                      {onAction && (
                        <button
                          type="button"
                          disabled={!value || actionBusy}
                          onClick={() => {
                            if (!value) return;
                            hide(true);
                            onAction(value);
                          }}
                          className={cn(
                            'inline-flex shrink-0 items-center gap-1.5 rounded-lg px-3.5 py-1.5 text-[12px] font-semibold shadow-sm transition-colors',
                            'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-offset-2 focus-visible:ring-offset-white dark:focus-visible:ring-offset-[#0d1117]',
                            gridAccent.focusRing,
                            'disabled:cursor-not-allowed disabled:opacity-50',
                            accent.bar,
                            accent.barText ?? 'text-white',
                          )}
                        >
                          {actionBusy && (
                            <span aria-hidden className="h-3 w-3 animate-spin rounded-full border-2 border-current border-t-transparent" />
                          )}
                          {actionLabel ?? 'Use'}
                          {weekLabel ? ` ${weekLabel}` : ''}
                        </button>
                      )}
                    </div>
                  </div>
                </motion.div>
              </motion.div>
            )}
          </AnimatePresence>,
          document.body,
        )}
    </div>
  );
}
