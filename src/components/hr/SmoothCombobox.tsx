'use client';

import { useCallback, useEffect, useId, useMemo, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { AnimatePresence, motion, useReducedMotion } from 'motion/react';
import { Check, ChevronDown, Plus } from 'lucide-react';
import type { LucideIcon } from 'lucide-react';
import { cn } from '@/lib/utils';

/**
 * A smooth, animated select / combobox. The trigger is a real <input> rendered
 * inline (so it plays nice with a modal's focus trap), while the option list is
 * a motion-animated popover PORTALLED to <body> — so it never gets clipped by a
 * scrolling modal body, and it carries no focusable children (options commit on
 * mousedown without stealing focus), which keeps Tab/Esc behaving.
 *
 * - `searchable` (default): typeable — filters options as you type and keeps a
 *   CUSTOM value that isn't in the list (with a "Use …" affordance).
 * - `searchable={false}`: pick-only (read-only input that toggles the list).
 *
 * Keyboard: ↑/↓ move the highlight, Enter commits it (or keeps a custom value),
 * Esc closes just the popover (never the surrounding modal).
 */

const POPOVER_MAX_H = 264;

const INPUT_CLASS =
  'h-10 w-full cursor-pointer rounded-xl border bg-white pr-9 text-[13.5px] text-zinc-900 outline-none transition placeholder:text-zinc-400 focus:ring-2 dark:bg-zinc-900 dark:text-zinc-100';

interface Props {
  value: string;
  onChange: (v: string) => void;
  options: readonly string[];
  placeholder?: string;
  /** true (default) = typeable + custom values; false = pick-only. */
  searchable?: boolean;
  icon?: LucideIcon;
  id?: string;
  ariaLabel?: string;
  invalid?: boolean;
  disabled?: boolean;
  /** Show the "Use <typed> (custom)" row ABOVE the matches instead of below —
   *  handy for long lists (e.g. Referred By) where a custom value would
   *  otherwise be buried under many suggestions. */
  customFirst?: boolean;
}

export default function SmoothCombobox({
  value,
  onChange,
  options,
  placeholder,
  searchable = true,
  icon: Icon,
  id,
  ariaLabel,
  invalid,
  disabled,
  customFirst,
}: Props) {
  const reduceMotion = useReducedMotion();
  const autoId = useId();
  const fieldId = id ?? `combo-${autoId}`;
  const inputRef = useRef<HTMLInputElement>(null);
  const wrapRef = useRef<HTMLDivElement>(null);
  const popRef = useRef<HTMLDivElement>(null);
  const typedRef = useRef(false); // did the user type since opening? (drives filtering)
  const navByKeyRef = useRef(false); // last active-option change came from the keyboard (drives scroll-into-view)
  const [open, setOpen] = useState(false);
  const [activeIndex, setActiveIndex] = useState(-1);
  const [pos, setPos] = useState<{ topPx: number; bottomPx: number; left: number; width: number; flip: boolean } | null>(
    null,
  );

  const q = value.trim().toLowerCase();

  const filtered = useMemo(() => {
    if (!searchable || !typedRef.current || q === '') return [...options];
    return options.filter((o) => o.toLowerCase().includes(q));
    // `open` is a dep so a fresh open (typedRef reset) re-shows the full list.
  }, [options, q, searchable, open]);

  const isCustom = searchable && q !== '' && !options.some((o) => o.toLowerCase() === q);

  const place = useCallback(() => {
    const el = inputRef.current;
    if (!el || typeof window === 'undefined') return;
    const r = el.getBoundingClientRect();
    const below = window.innerHeight - r.bottom;
    const flip = below < POPOVER_MAX_H + 12 && r.top > below;
    setPos({
      topPx: r.bottom + 4,
      bottomPx: window.innerHeight - r.top + 4,
      left: r.left,
      width: r.width,
      flip,
    });
  }, []);

  const openMenu = useCallback(() => {
    if (disabled) return;
    typedRef.current = false;
    place();
    setActiveIndex(-1);
    setOpen(true);
  }, [disabled, place]);

  const close = useCallback(() => {
    setOpen(false);
    setActiveIndex(-1);
  }, []);

  const commit = useCallback(
    (opt: string) => {
      onChange(opt);
      typedRef.current = false;
      close();
      requestAnimationFrame(() => inputRef.current?.focus());
    },
    [onChange, close],
  );

  const onType = useCallback(
    (v: string) => {
      typedRef.current = true;
      onChange(v);
      setActiveIndex(-1);
      if (!open) {
        place();
        setOpen(true);
      }
    },
    [onChange, open, place],
  );

  // Close on outside click / resize, and when the PAGE/modal BEHIND the popover
  // scrolls (the fixed popover would otherwise detach). Crucially, IGNORE the
  // popover's OWN scroll — wheel-scrolling a long list, or scrollIntoView on
  // keyboard nav, must NOT slam it shut (that was the "disappears when I move
  // the mouse" bug on long lists like Department).
  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => {
      const t = e.target as Node;
      if (wrapRef.current?.contains(t) || popRef.current?.contains(t)) return;
      close();
    };
    const onScroll = (e: Event) => {
      const t = e.target as Node | null;
      if (t && popRef.current?.contains(t)) return; // the popover scrolled itself — keep it open
      close();
    };
    const onResize = () => close();
    document.addEventListener('mousedown', onDown);
    window.addEventListener('scroll', onScroll, true);
    window.addEventListener('resize', onResize);
    return () => {
      document.removeEventListener('mousedown', onDown);
      window.removeEventListener('scroll', onScroll, true);
      window.removeEventListener('resize', onResize);
    };
  }, [open, close]);

  // Keep the highlighted option in view — but ONLY for keyboard nav. Doing this
  // on mouse hover would scroll the list under the cursor (jitter) and, on a
  // long list, trip the scroll-close above.
  useEffect(() => {
    if (!open || activeIndex < 0 || !navByKeyRef.current) return;
    popRef.current?.querySelector(`[data-idx="${activeIndex}"]`)?.scrollIntoView({ block: 'nearest' });
  }, [activeIndex, open]);

  const onKeyDown = (e: React.KeyboardEvent<HTMLInputElement>) => {
    if (e.key === 'ArrowDown') {
      e.preventDefault();
      if (!open) { openMenu(); return; }
      navByKeyRef.current = true;
      setActiveIndex((i) => Math.min(i + 1, filtered.length - 1));
    } else if (e.key === 'ArrowUp') {
      e.preventDefault();
      if (!open) { openMenu(); return; }
      navByKeyRef.current = true;
      setActiveIndex((i) => Math.max(i - 1, 0));
    } else if (e.key === 'Enter') {
      if (open) {
        // Never let Enter submit the surrounding modal form while choosing.
        e.preventDefault();
        e.stopPropagation();
        if (activeIndex >= 0 && activeIndex < filtered.length) commit(filtered[activeIndex]!);
        else close(); // keep whatever custom value was typed
      } else if (!searchable) {
        e.preventDefault(); // pick-only field: open the picker instead of submitting
        openMenu();
      }
    } else if (e.key === 'Escape') {
      if (open) {
        e.preventDefault();
        e.stopPropagation(); // close only the popover, not the modal
        close();
      }
    } else if (e.key === ' ' && !searchable && !open) {
      e.preventDefault();
      openMenu();
    }
  };

  // The "Use <typed> (custom)" affordance — placed ABOVE the matches when
  // `customFirst` (Referred By, long GML list), else below them.
  const customRow = isCustom ? (
    <button
      type="button"
      onMouseDown={(e) => e.preventDefault()}
      onClick={() => { close(); requestAnimationFrame(() => inputRef.current?.focus()); }}
      className={cn(
        'flex w-full shrink-0 items-center gap-2 px-3 py-2 text-left text-[13.5px] text-emerald-700 transition-colors hover:bg-emerald-50 dark:text-emerald-300 dark:hover:bg-emerald-950/50',
        customFirst ? 'border-b border-zinc-100 dark:border-zinc-800' : 'border-t border-zinc-100 dark:border-zinc-800',
      )}
    >
      <span className="flex h-4 w-4 shrink-0 items-center justify-center">
        <Plus className="h-4 w-4" />
      </span>
      <span className="truncate">
        Use &ldquo;{value.trim()}&rdquo; <span className="text-zinc-400">(custom)</span>
      </span>
    </button>
  ) : null;

  return (
    <div ref={wrapRef} className="relative">
      {Icon && <Icon className="pointer-events-none absolute left-3 top-1/2 z-[1] h-4 w-4 -translate-y-1/2 text-zinc-400" />}
      <input
        ref={inputRef}
        id={fieldId}
        role="combobox"
        aria-expanded={open}
        aria-controls={`${fieldId}-list`}
        aria-autocomplete={searchable ? 'list' : 'none'}
        aria-label={ariaLabel}
        readOnly={!searchable}
        disabled={disabled}
        value={value}
        placeholder={placeholder}
        onChange={(e) => onType(e.target.value)}
        onClick={() => { if (!open) openMenu(); else if (!searchable) close(); }}
        onKeyDown={onKeyDown}
        className={cn(
          INPUT_CLASS,
          Icon ? 'pl-9' : 'pl-3',
          invalid
            ? 'border-amber-400 focus:border-amber-400 focus:ring-amber-300/50 dark:border-amber-500/60'
            : 'border-zinc-300 focus:border-emerald-400 focus:ring-emerald-300/50 dark:border-zinc-700 dark:focus:border-emerald-500',
          disabled && 'cursor-not-allowed opacity-60',
        )}
      />
      <button
        type="button"
        tabIndex={-1}
        aria-hidden
        disabled={disabled}
        onMouseDown={(e) => { e.preventDefault(); if (open) close(); else openMenu(); }}
        className="absolute right-2 top-1/2 -translate-y-1/2 rounded-md p-1 text-zinc-400 transition hover:text-zinc-600 dark:hover:text-zinc-200"
      >
        <ChevronDown className={cn('h-4 w-4 transition-transform duration-200', open && 'rotate-180')} />
      </button>

      {typeof document !== 'undefined' &&
        createPortal(
          <AnimatePresence>
            {open && pos && (
              <motion.div
                ref={popRef}
                id={`${fieldId}-list`}
                role="listbox"
                initial={reduceMotion ? { opacity: 0 } : { opacity: 0, y: pos.flip ? 4 : -4, scale: 0.98 }}
                animate={reduceMotion ? { opacity: 1 } : { opacity: 1, y: 0, scale: 1 }}
                exit={reduceMotion ? { opacity: 0 } : { opacity: 0, y: pos.flip ? 4 : -4, scale: 0.98 }}
                transition={{ duration: reduceMotion ? 0 : 0.15, ease: [0.22, 1, 0.36, 1] }}
                style={{
                  position: 'fixed',
                  left: pos.left,
                  width: pos.width,
                  maxHeight: POPOVER_MAX_H,
                  ...(pos.flip ? { bottom: pos.bottomPx } : { top: pos.topPx }),
                }}
                className="z-[140] overflow-auto overscroll-contain rounded-xl border border-zinc-200 bg-white py-1 shadow-xl shadow-black/15 dark:border-zinc-700 dark:bg-zinc-900"
              >
                {customFirst && customRow}
                {filtered.map((opt, i) => {
                  const selected = opt.toLowerCase() === q;
                  const active = i === activeIndex;
                  return (
                    <button
                      key={opt}
                      type="button"
                      data-idx={i}
                      role="option"
                      aria-selected={selected}
                      onMouseDown={(e) => e.preventDefault()} // keep input focused
                      onMouseEnter={() => { navByKeyRef.current = false; setActiveIndex(i); }}
                      onClick={() => commit(opt)}
                      className={cn(
                        'flex w-full items-center gap-2 px-3 py-2 text-left text-[13.5px] transition-colors',
                        active ? 'bg-emerald-50 dark:bg-emerald-950/50' : 'bg-transparent',
                        selected ? 'font-semibold text-emerald-700 dark:text-emerald-300' : 'text-zinc-700 dark:text-zinc-200',
                      )}
                    >
                      <span className="flex h-4 w-4 shrink-0 items-center justify-center text-emerald-600 dark:text-emerald-400">
                        {selected && <Check className="h-4 w-4" />}
                      </span>
                      <span className="truncate">{opt}</span>
                    </button>
                  );
                })}

                {!customFirst && customRow}

                {filtered.length === 0 && !isCustom && (
                  <div className="px-3 py-2 text-[13px] text-zinc-400">No matches</div>
                )}
              </motion.div>
            )}
          </AnimatePresence>,
          document.body,
        )}
    </div>
  );
}
