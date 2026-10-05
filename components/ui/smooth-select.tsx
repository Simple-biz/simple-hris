'use client';

import { useEffect, useId, useMemo, useRef, useState, type ReactNode } from 'react';
import { AnimatePresence, motion, useReducedMotion } from 'motion/react';
import { AlertTriangle, Check, ChevronDown, Search } from 'lucide-react';
import { cn } from '@/lib/utils';
import { useEscapingPopup } from '@/components/ui/popup-layer';

/** Exponential ease-out — the same curve the My Team panes rise on. */
const EASE_OUT = [0.22, 1, 0.36, 1] as const;

/**
 * Accent families. `teal` is the house default; `blue` matches surfaces whose
 * other controls are blue (My Team's Rankings toggles), so the open trigger and the
 * highlighted row read as one control set rather than two. `orange` is the same
 * rule for the orange Accounting family (first user: the Accounting Scoreboard).
 */
const ACCENTS = {
  teal: {
    trigger: 'hover:border-teal-300 focus-visible:border-teal-500 focus-visible:ring-teal-500/20 dark:hover:border-teal-700',
    open: 'border-teal-400 ring-2 ring-teal-500/20',
    chevron: 'text-teal-500',
    active: 'bg-teal-50 text-teal-800 dark:bg-teal-950/40 dark:text-teal-200',
    check: 'text-teal-500 dark:text-teal-400',
    search: 'focus:border-teal-300 focus:ring-teal-200',
  },
  blue: {
    trigger: 'hover:border-blue-300 focus-visible:border-blue-500 focus-visible:ring-blue-500/20 dark:hover:border-blue-800',
    open: 'border-blue-400 ring-2 ring-blue-500/20 dark:border-blue-700',
    chevron: 'text-blue-600 dark:text-blue-400',
    active: 'bg-blue-50 text-blue-800 dark:bg-blue-950/50 dark:text-blue-200',
    check: 'text-blue-600 dark:text-blue-400',
    search: 'focus:border-blue-300 focus:ring-blue-200',
  },
  orange: {
    trigger: 'hover:border-orange-300 focus-visible:border-orange-500 focus-visible:ring-orange-500/20 dark:hover:border-orange-800',
    open: 'border-orange-400 ring-2 ring-orange-500/20 dark:border-orange-700',
    chevron: 'text-orange-600 dark:text-orange-400',
    active: 'bg-orange-50 text-orange-900 dark:bg-orange-950/40 dark:text-orange-200',
    check: 'text-orange-600 dark:text-orange-400',
    search: 'focus:border-orange-300 focus:ring-orange-200',
  },
  /** The Orphanage family's pink/rose (orphanage-dashboard-standards.md § Color). */
  pink: {
    trigger: 'hover:border-pink-300 focus-visible:border-pink-500 focus-visible:ring-pink-500/20 dark:hover:border-pink-800',
    open: 'border-pink-400 ring-2 ring-pink-500/20 dark:border-pink-700',
    chevron: 'text-pink-600 dark:text-pink-400',
    active: 'bg-pink-50 text-pink-900 dark:bg-pink-950/40 dark:text-pink-200',
    check: 'text-pink-600 dark:text-pink-400',
    search: 'focus:border-pink-300 focus:ring-pink-200',
  },
} as const;

const SIZES = {
  md: {
    trigger: 'h-9 rounded-lg px-3 text-xs font-medium',
    option: 'px-2.5 py-1.5 text-xs',
  },
  /** Sits beside the 26px segmented toggles (`text-[11px]`, `rounded-md`). */
  sm: {
    trigger: 'h-[26px] rounded-md px-2 text-[11px] font-semibold',
    option: 'px-2 py-1.5 text-[11.5px]',
  },
} as const;

export interface SmoothSelectOption<T extends string = string> {
  value: T;
  label: string;
  /** Render greyed-out and unselectable, with a warning glyph next to the label. */
  disabled?: boolean;
}

interface SmoothSelectProps<T extends string = string> {
  /** `null` = nothing chosen yet; the trigger shows `placeholder`. */
  value: T | null;
  options: SmoothSelectOption<T>[];
  onChange: (value: T) => void;
  className?: string;
  /** Width of the trigger; menu matches it. */
  triggerClassName?: string;
  disabled?: boolean;
  /** Put on the trigger button, so a `<label htmlFor>` still points at the control. */
  id?: string;
  /** Shown, muted, while `value` matches no option ("Select a bank…"). Without it an
   *  unmatched value shows the first option's label, as it always has. */
  placeholder?: string;
  'aria-label'?: string;
  /** Opt-in: render a type-to-filter search box at the top of the menu (for long
   *  option lists, e.g. departments). Off by default so existing dropdowns are
   *  unchanged. Filters the list only — it never invents a value. */
  searchable?: boolean;
  /** Placeholder for the search box (searchable only). */
  searchPlaceholder?: string;
  /** Opt-in: ALWAYS render the menu in a layer, never in place. Without it the menu
   *  still leaves its spot on its own whenever an overflow-hidden / scrolling
   *  ancestor would clip it (`useEscapingPopup`), so this is only needed to skip
   *  the in-place judgement. A layer is the nearest dialog popup — keeping the
   *  menu inside the dialog's DOM so outside-press dismissal and focus traps keep
   *  working — or document.body; the menu is at least the trigger's width, follows
   *  it on scroll/resize, and flips upward when there is no room below. */
  portal?: boolean;
  /** `md` (default) or `sm`, a compact trigger that lines up with segmented toggles. */
  size?: keyof typeof SIZES;
  /** `teal` (default), `blue`, `orange` (the Accounting family) or `pink` (the Orphanage family). */
  accent?: keyof typeof ACCENTS;
  /** A muted prefix inside the trigger, before the selected label (e.g. "KPI"). */
  leading?: ReactNode;
  /** Non-portal menu edge: `end` (default, right-aligned) or `start` (left-aligned). */
  align?: 'start' | 'end';
}

/**
 * A lightweight dropdown with a smooth open AND close animation (`motion`; opacity
 * only under reduced motion), teal selection accent (or `accent="blue"`), and full
 * keyboard support. Replaces the generic
 * native <select> styling. The option list is capped in height and scrolls, so
 * long lists (e.g. departments) never overflow the viewport.
 */
export function SmoothSelect<T extends string = string>({
  value,
  options,
  onChange,
  className,
  triggerClassName,
  disabled = false,
  id,
  placeholder,
  'aria-label': ariaLabel,
  searchable = false,
  searchPlaceholder = 'Search…',
  portal = false,
  size = 'md',
  accent = 'teal',
  leading,
  align = 'end',
}: SmoothSelectProps<T>) {
  const tone = ACCENTS[accent];
  const dims = SIZES[size];
  const reduceMotion = useReducedMotion() ?? false;
  const [open, setOpen] = useState(false);
  const [active, setActive] = useState(0);
  const [query, setQuery] = useState('');
  const rootRef = useRef<HTMLDivElement | null>(null);
  const menuRef = useRef<HTMLDivElement | null>(null);
  const listRef = useRef<HTMLDivElement | null>(null);
  const searchRef = useRef<HTMLInputElement | null>(null);
  const baseId = useId();

  // In place unless a clipping ancestor would cut the menu off (or `portal` forces a layer).
  const layer = useEscapingPopup({
    open,
    anchorRef: rootRef,
    panelRef: menuRef,
    force: portal,
    align,
    gap: 6,
    matchAnchorWidth: true,
    // In place: `absolute mt-1.5 min-w-full`, pinned to the trigger's left or right edge.
    inFlowBox: (a, w, h) => {
      const left = align === 'start' ? a.left : a.right - w;
      return { top: a.bottom + 6, left, right: left + w, bottom: a.bottom + 6 + h };
    },
  });
  const openMenu = () => {
    layer.beginOpen();
    setOpen(true);
  };

  const selected = options.find((o) => o.value === value) ?? (placeholder == null ? options[0] : undefined);

  const filtered = useMemo(() => {
    if (!searchable) return options;
    const q = query.trim().toLowerCase();
    if (!q) return options;
    return options.filter((o) => o.label.toLowerCase().includes(q));
  }, [options, query, searchable]);

  // Close on outside click. An escaped menu lives outside rootRef, so it
  // must count as "inside" or selecting an option would close on mousedown
  // before the click can commit.
  useEffect(() => {
    if (!open) return;
    const onPointer = (e: MouseEvent) => {
      const t = e.target as Node;
      if (rootRef.current?.contains(t) || menuRef.current?.contains(t)) return;
      setOpen(false);
    };
    document.addEventListener('mousedown', onPointer);
    return () => document.removeEventListener('mousedown', onPointer);
  }, [open]);

  // When opening: reset the search, point the active row at the current value,
  // and focus the search box if searchable.
  useEffect(() => {
    if (open) {
      setQuery('');
      const idx = options.findIndex((o) => o.value === value);
      setActive(idx < 0 ? 0 : idx);
      if (searchable) requestAnimationFrame(() => searchRef.current?.focus());
    }
  }, [open, options, value, searchable]);

  // Keep the active row within the filtered list as the query narrows it.
  useEffect(() => {
    setActive((a) => Math.min(Math.max(0, a), Math.max(0, filtered.length - 1)));
  }, [filtered.length]);

  const commit = (idx: number) => {
    const opt = filtered[idx];
    if (!opt || opt.disabled) return;
    onChange(opt.value);
    setOpen(false);
  };

  const onListKeyDown = (e: React.KeyboardEvent) => {
    if (!open) {
      if (e.key === 'Enter' || e.key === ' ' || e.key === 'ArrowDown') {
        e.preventDefault();
        openMenu();
      }
      return;
    }
    if (e.key === 'Escape') {
      e.preventDefault();
      e.stopPropagation();
      setOpen(false);
    } else if (e.key === 'ArrowDown') {
      e.preventDefault();
      setActive((a) => Math.min(filtered.length - 1, a + 1));
    } else if (e.key === 'ArrowUp') {
      e.preventDefault();
      setActive((a) => Math.max(0, a - 1));
    } else if (e.key === 'Enter') {
      e.preventDefault();
      commit(active);
    } else if (e.key === ' ' && !searchable) {
      e.preventDefault();
      commit(active);
    }
  };

  // Keep the highlighted option scrolled into view (keyboard nav on long lists).
  useEffect(() => {
    if (!open) return;
    listRef.current?.querySelector(`[data-idx="${active}"]`)?.scrollIntoView({ block: 'nearest' });
  }, [active, open]);

  const up = layer.up;
  const offset = reduceMotion ? 0 : up ? 4 : -4;
  const menu = (
    <AnimatePresence>
      {open && (
    <motion.div
      key="smooth-select-menu"
      ref={menuRef}
      initial={reduceMotion ? { opacity: 0 } : { opacity: 0, y: offset, scale: 0.97 }}
      animate={reduceMotion ? { opacity: 1 } : { opacity: 1, y: 0, scale: 1 }}
      exit={
        reduceMotion
          ? { opacity: 0, transition: { duration: 0.08 } }
          : { opacity: 0, y: offset, scale: 0.97, transition: { duration: 0.12, ease: EASE_OUT } }
      }
      transition={{ duration: reduceMotion ? 0.1 : 0.18, ease: EASE_OUT }}
      style={layer.style}
      className={cn(
        'z-50 rounded-xl border border-zinc-200 bg-white p-1 shadow-xl shadow-zinc-900/10',
        layer.escaped
          ? 'pointer-events-auto'
          : cn('absolute mt-1.5 min-w-full', align === 'start' ? 'left-0' : 'right-0'),
        up ? 'origin-bottom' : 'origin-top',
        'dark:border-zinc-800 dark:bg-zinc-950 dark:shadow-black/40',
      )}
    >
      {searchable && (
        <div className="relative mb-1">
          <Search className="pointer-events-none absolute left-2.5 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-zinc-400" />
          <input
            ref={searchRef}
            type="text"
            value={query}
            onChange={(e) => {
              setQuery(e.target.value);
              setActive(0);
            }}
            onKeyDown={onListKeyDown}
            placeholder={searchPlaceholder}
            className={cn(
              'h-8 w-full rounded-lg border border-zinc-200 bg-white pl-8 pr-2 text-xs text-zinc-800 placeholder:text-zinc-400 focus:outline-none focus:ring-1 dark:border-zinc-700 dark:bg-zinc-900 dark:text-zinc-200',
              tone.search,
            )}
          />
        </div>
      )}
      <div
        ref={listRef}
        role="listbox"
        tabIndex={-1}
        aria-label={ariaLabel}
        className="max-h-56 overflow-y-auto overscroll-contain"
      >
        {filtered.length === 0 ? (
          <div className="px-2.5 py-2 text-xs text-zinc-400">No matches</div>
        ) : (
          filtered.map((opt, idx) => {
            const isSelected = opt.value === value;
            const isActive = idx === active;
            return (
              <button
                key={opt.value}
                type="button"
                role="option"
                data-idx={idx}
                aria-selected={isSelected}
                aria-disabled={opt.disabled || undefined}
                id={`${baseId}-opt-${idx}`}
                onMouseEnter={() => setActive(idx)}
                onClick={() => commit(idx)}
                className={cn(
                  'flex w-full items-center justify-between gap-3 whitespace-nowrap rounded-lg text-left font-medium transition-colors duration-100',
                  dims.option,
                  opt.disabled
                    ? 'cursor-not-allowed text-zinc-400 dark:text-zinc-600'
                    : isActive
                      ? tone.active
                      : 'text-zinc-700 dark:text-zinc-300',
                  isSelected && !opt.disabled && 'font-semibold',
                )}
              >
                <span className="flex items-center gap-1.5 truncate">
                  <span className="truncate">{opt.label}</span>
                  {opt.disabled && (
                    <AlertTriangle className="h-3 w-3 shrink-0 text-amber-500" />
                  )}
                </span>
                {isSelected && !opt.disabled && (
                  <Check className={cn('h-3.5 w-3.5 shrink-0', tone.check)} />
                )}
              </button>
            );
          })
        )}
      </div>
    </motion.div>
      )}
    </AnimatePresence>
  );

  return (
    <div ref={rootRef} className={cn('relative', className)}>
      <button
        type="button"
        id={id}
        aria-haspopup="listbox"
        aria-expanded={open}
        aria-label={ariaLabel}
        disabled={disabled}
        onClick={() => {
          if (disabled) return;
          if (open) setOpen(false);
          else openMenu();
        }}
        onKeyDown={onListKeyDown}
        className={cn(
          'group flex w-full items-center justify-between gap-2 border bg-white text-zinc-700 shadow-sm transition-all duration-200',
          dims.trigger,
          'hover:shadow-md',
          'focus:outline-none focus-visible:ring-2',
          tone.trigger,
          'disabled:cursor-not-allowed disabled:opacity-50 disabled:shadow-none disabled:hover:border-zinc-200 disabled:hover:shadow-none dark:disabled:hover:border-zinc-800',
          open ? tone.open : 'border-zinc-200 dark:border-zinc-800',
          'dark:bg-zinc-900/60 dark:text-zinc-300',
          triggerClassName,
        )}
      >
        <span className="flex min-w-0 items-center gap-1.5">
          {leading != null && (
            <span className="shrink-0 text-[10px] font-semibold uppercase tracking-wide text-zinc-500 dark:text-zinc-400">
              {leading}
            </span>
          )}
          {selected ? (
            <span className="truncate">{selected.label}</span>
          ) : (
            <span className="truncate font-normal text-zinc-400 dark:text-zinc-500">{placeholder}</span>
          )}
        </span>
        <ChevronDown
          className={cn(
            'h-3.5 w-3.5 shrink-0 text-zinc-400 transition-transform duration-200 ease-out motion-reduce:transition-none',
            open && cn('rotate-180', tone.chevron),
          )}
        />
      </button>

      {layer.pending ? null : layer.escaped ? layer.portal(menu) : menu}
    </div>
  );
}
