'use client';

import { useEffect, useId, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { Check, ChevronDown, Search } from 'lucide-react';
import { cn } from '@/lib/utils';

export interface SmoothSelectOption<T extends string = string> {
  value: T;
  label: string;
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
}

/**
 * A lightweight, dependency-free dropdown with a smooth open/close animation,
 * teal selection accent, and full keyboard support. Replaces the generic
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
}: SmoothSelectProps<T>) {
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
    if (!portal || !open) {
      setPortalHost(null);
      setMenuPos(null);
      return;
    }
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
    if (opt) onChange(opt.value);
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

  const menu = open ? (
    <div
      ref={menuRef}
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
          : 'absolute right-0 mt-1.5 min-w-full origin-top',
        'motion-safe:animate-in motion-safe:fade-in-0 motion-safe:zoom-in-95 motion-safe:duration-150',
        portal && menuPos?.up
          ? 'origin-bottom motion-safe:slide-in-from-bottom-1'
          : 'origin-top motion-safe:slide-in-from-top-1',
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
            className="h-8 w-full rounded-lg border border-zinc-200 bg-white pl-8 pr-2 text-xs text-zinc-800 placeholder:text-zinc-400 focus:border-teal-300 focus:outline-none focus:ring-1 focus:ring-teal-200 dark:border-zinc-700 dark:bg-zinc-900 dark:text-zinc-200"
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
                id={`${baseId}-opt-${idx}`}
                onMouseEnter={() => setActive(idx)}
                onClick={() => commit(idx)}
                className={cn(
                  'flex w-full items-center justify-between gap-3 rounded-lg px-2.5 py-1.5 text-left text-xs font-medium transition-colors duration-100',
                  isActive
                    ? 'bg-teal-50 text-teal-800 dark:bg-teal-950/40 dark:text-teal-200'
                    : 'text-zinc-700 dark:text-zinc-300',
                  isSelected && 'font-semibold',
                )}
              >
                <span className="truncate">{opt.label}</span>
                {isSelected && (
                  <Check className="h-3.5 w-3.5 shrink-0 text-teal-500 dark:text-teal-400" />
                )}
              </button>
            );
          })
        )}
      </div>
    </div>
  ) : null;

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
          'group flex h-9 w-full items-center justify-between gap-2 rounded-lg border bg-white px-3 text-xs font-medium text-zinc-700 shadow-sm transition-all duration-200',
          'hover:border-teal-300 hover:shadow-md',
          'focus:outline-none focus-visible:border-teal-500 focus-visible:ring-2 focus-visible:ring-teal-500/20',
          'disabled:cursor-not-allowed disabled:opacity-50 disabled:shadow-none disabled:hover:border-zinc-200 disabled:hover:shadow-none dark:disabled:hover:border-zinc-800',
          open
            ? 'border-teal-400 ring-2 ring-teal-500/20'
            : 'border-zinc-200 dark:border-zinc-800',
          'dark:bg-zinc-900/60 dark:text-zinc-300 dark:hover:border-teal-700',
          triggerClassName,
        )}
      >
        <span className="truncate">{selected?.label}</span>
        <ChevronDown
          className={cn(
            'h-3.5 w-3.5 shrink-0 text-zinc-400 transition-transform duration-200',
            open && 'rotate-180 text-teal-500',
          )}
        />
      </button>

      {portal ? (portalHost ? createPortal(menu, portalHost) : null) : menu}
    </div>
  );
}
