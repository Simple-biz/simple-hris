'use client';

import { useEffect, useId, useRef, useState } from 'react';
import { Check, ChevronDown } from 'lucide-react';
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
}

/**
 * A lightweight, dependency-free dropdown with a smooth open/close animation,
 * teal selection accent, and full keyboard support. Replaces the generic
 * native <select> styling.
 */
export function SmoothSelect<T extends string = string>({
  value,
  options,
  onChange,
  className,
  triggerClassName,
  disabled = false,
  'aria-label': ariaLabel,
}: SmoothSelectProps<T>) {
  const [open, setOpen] = useState(false);
  const [active, setActive] = useState(0);
  const rootRef = useRef<HTMLDivElement | null>(null);
  const listRef = useRef<HTMLDivElement | null>(null);
  const baseId = useId();

  const selected = options.find((o) => o.value === value) ?? options[0];

  // Close on outside click.
  useEffect(() => {
    if (!open) return;
    const onPointer = (e: MouseEvent) => {
      if (rootRef.current && !rootRef.current.contains(e.target as Node)) {
        setOpen(false);
      }
    };
    document.addEventListener('mousedown', onPointer);
    return () => document.removeEventListener('mousedown', onPointer);
  }, [open]);

  // When opening, point the active row at the current value.
  useEffect(() => {
    if (open) {
      const idx = options.findIndex((o) => o.value === value);
      setActive(idx < 0 ? 0 : idx);
    }
  }, [open, options, value]);

  const commit = (idx: number) => {
    const opt = options[idx];
    if (opt) onChange(opt.value);
    setOpen(false);
  };

  const onKeyDown = (e: React.KeyboardEvent) => {
    if (!open) {
      if (e.key === 'Enter' || e.key === ' ' || e.key === 'ArrowDown') {
        e.preventDefault();
        setOpen(true);
      }
      return;
    }
    if (e.key === 'Escape') {
      e.preventDefault();
      setOpen(false);
    } else if (e.key === 'ArrowDown') {
      e.preventDefault();
      setActive((a) => Math.min(options.length - 1, a + 1));
    } else if (e.key === 'ArrowUp') {
      e.preventDefault();
      setActive((a) => Math.max(0, a - 1));
    } else if (e.key === 'Enter' || e.key === ' ') {
      e.preventDefault();
      commit(active);
    }
  };

  return (
    <div ref={rootRef} className={cn('relative', className)}>
      <button
        type="button"
        aria-haspopup="listbox"
        aria-expanded={open}
        aria-label={ariaLabel}
        disabled={disabled}
        onClick={() => !disabled && setOpen((o) => !o)}
        onKeyDown={onKeyDown}
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

      {open && (
        <div
          ref={listRef}
          role="listbox"
          tabIndex={-1}
          aria-label={ariaLabel}
          className={cn(
            'absolute right-0 z-50 mt-1.5 min-w-full origin-top overflow-hidden rounded-xl border border-zinc-200 bg-white p-1 shadow-xl shadow-zinc-900/10',
            'motion-safe:animate-in motion-safe:fade-in-0 motion-safe:zoom-in-95 motion-safe:slide-in-from-top-1 motion-safe:duration-150',
            'dark:border-zinc-800 dark:bg-zinc-950 dark:shadow-black/40',
          )}
        >
          {options.map((opt, idx) => {
            const isSelected = opt.value === value;
            const isActive = idx === active;
            return (
              <button
                key={opt.value}
                type="button"
                role="option"
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
          })}
        </div>
      )}
    </div>
  );
}
