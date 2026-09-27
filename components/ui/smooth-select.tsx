'use client';

import { useEffect, useId, useLayoutEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { createPortal } from 'react-dom';
import { AnimatePresence, motion, useReducedMotion } from 'motion/react';
import { AlertTriangle, Check, ChevronDown, Search } from 'lucide-react';
import { cn } from '@/lib/utils';

/** Exponential ease-out — the same curve the My Team panes rise on. */
const EASE_OUT = [0.22, 1, 0.36, 1] as const;

/**
 * Accent families. `teal` is the house default; `blue` matches surfaces whose
 * other controls are blue (My Team's Rankings toggles), so the open trigger and the
 * highlighted row read as one control set rather than two.
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
  value: T;
  options: SmoothSelectOption<T>[];
  onChange: (value: T) => void;
  className?: string;
  /** Width of the trigger; menu matches it. */
  triggerClassName?: string;
  disabled?: boolean;
  'aria-label'?: string;
  /** Opt-in: render a type-to-filter search box at the top of the menu (for long
   *  option lists, e.g. departments). Off by default so existing dropdowns are
   *  unchanged. Filters the list only — it never invents a value. */
  searchable?: boolean;
  /** Placeholder for the search box (searchable only). */
  searchPlaceholder?: string;
  /** Opt-in: render the menu in a portal so it can never be clipped by
   *  overflow-hidden / scroll ancestors (e.g. inside a dialog). The menu is
   *  portaled into the nearest `[data-slot="dialog-content"]` popup — keeping
   *  it inside the dialog's DOM so outside-press dismissal and focus traps
   *  keep working — or into document.body outside a dialog. It matches the
   *  trigger width, follows it on scroll/resize, and flips upward when there
   *  is no room below. */
  portal?: boolean;
  /** `md` (default) or `sm`, a compact trigger that lines up with segmented toggles. */
  size?: keyof typeof SIZES;
  /** `teal` (default) or `blue`. */
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

  // Portal mode: where the menu mounts, and its measured on-screen position.
  const [portalHost, setPortalHost] = useState<HTMLElement | null>(null);
  const [menuPos, setMenuPos] = useState<{ top: number; left: number; width: number; up: boolean } | null>(null);

  const selected = options.find((o) => o.value === value) ?? options[0];

  const filtered = useMemo(() => {
    if (!searchable) return options;
    const q = query.trim().toLowerCase();
    if (!q) return options;
    return options.filter((o) => o.label.toLowerCase().includes(q));
  }, [options, query, searchable]);

  // Close on outside click. The portaled menu lives outside rootRef, so it
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

  // Portal mode: mount the menu inside the nearest dialog popup (so Base UI's
  // outside-press dismissal and focus trap still see it as dialog content), or
  // document.body when not in a dialog.
  useLayoutEffect(() => {
    if (!portal) {
      setPortalHost(null);
      setMenuPos(null);
      return;
    }
    // Closing keeps the host and the last position so the menu can animate OUT
    // where it was; the next open re-measures before paint.
    if (!open) return;
    setPortalHost(
      (rootRef.current?.closest('[data-slot="dialog-content"]') as HTMLElement | null) ?? document.body,
    );
  }, [portal, open]);

  // Portal mode: place the menu under (or above) the trigger and keep it
  // anchored while ancestors scroll or the window resizes. Re-measures when
  // the filtered list changes since that changes the menu height.
  useLayoutEffect(() => {
    if (!portal || !open || !portalHost) return;
    const update = () => {
      const anchor = rootRef.current;
      const menu = menuRef.current;
      if (!anchor || !menu) return;
      const a = anchor.getBoundingClientRect();
      const gap = 6;
      const pad = 8;
      const menuH = menu.offsetHeight;
      // Flip upward only when the menu would spill past the viewport bottom
      // AND it actually fits above the trigger.
      const up = a.bottom + gap + menuH > window.innerHeight - pad && a.top - gap - menuH > pad;
      const topVp = up ? a.top - gap - menuH : a.bottom + gap;
      // document.body positions as fixed (viewport coords); a dialog popup is
      // a transformed containing block, so coords are relative to its rect.
      const host = portalHost === document.body ? null : portalHost.getBoundingClientRect();
      setMenuPos({
        top: topVp - (host?.top ?? 0),
        left: a.left - (host?.left ?? 0),
        width: a.width,
        up,
      });
    };
    update();
    window.addEventListener('scroll', update, true);
    window.addEventListener('resize', update);
    return () => {
      window.removeEventListener('scroll', update, true);
      window.removeEventListener('resize', update);
    };
  }, [portal, open, portalHost, filtered.length]);

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
        setOpen(true);
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

  const up = !!(portal && menuPos?.up);
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
      style={
        portal
          ? menuPos
            ? {
                position: portalHost === document.body ? 'fixed' : 'absolute',
                top: menuPos.top,
                left: menuPos.left,
                width: menuPos.width,
              }
            : { position: 'fixed', top: 0, left: 0, visibility: 'hidden' }
          : undefined
      }
      className={cn(
        'z-50 rounded-xl border border-zinc-200 bg-white p-1 shadow-xl shadow-zinc-900/10',
        portal
          ? 'pointer-events-auto z-[70]'
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
        aria-haspopup="listbox"
        aria-expanded={open}
        aria-label={ariaLabel}
        disabled={disabled}
        onClick={() => !disabled && setOpen((o) => !o)}
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
          <span className="truncate">{selected?.label}</span>
        </span>
        <ChevronDown
          className={cn(
            'h-3.5 w-3.5 shrink-0 text-zinc-400 transition-transform duration-200 ease-out motion-reduce:transition-none',
            open && cn('rotate-180', tone.chevron),
          )}
        />
      </button>

      {portal ? (portalHost ? createPortal(menu, portalHost) : null) : menu}
    </div>
  );
}
