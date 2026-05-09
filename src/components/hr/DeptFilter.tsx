'use client';

import { useMemo } from 'react';
import { Select as SelectPrimitive } from '@base-ui/react/select';
import { Building2, CheckIcon, ChevronDownIcon } from 'lucide-react';
import { cn } from '@/lib/utils';

const ALL = '__all_depts__';

/**
 * Compact department filter dropdown shared across HR tables (Overview roster,
 * Onboarding queue, Offboarding active + history). Built on raw Base-UI Select
 * primitives so the trigger layout (icon + label + chevron) and popup width
 * are predictable; the wrapped `<Select>` shadcn helpers in `components/ui/select`
 * bake in `*:data-[slot=select-value]:line-clamp-1` and `h-8` defaults that
 * fight an in-trigger icon at compact sizes.
 *
 * Pass the full row list and a `getDept` accessor — the dropdown derives the
 * unique sorted list of departments itself so callers don't have to memoize.
 */
export default function DeptFilter<T>({
  rows,
  getDept,
  value,
  onChange,
  className,
}: {
  rows: readonly T[];
  getDept: (row: T) => string | null | undefined;
  /** Empty string = "All departments". */
  value: string;
  onChange: (v: string) => void;
  className?: string;
}) {
  const departments = useMemo(() => {
    const seen = new Set<string>();
    for (const r of rows) {
      const d = (getDept(r) ?? '').trim();
      if (d) seen.add(d);
    }
    return Array.from(seen).sort((a, b) => a.localeCompare(b));
  }, [rows, getDept]);

  const labelFor = (v: string) => (v && v !== ALL ? v : 'All departments');

  return (
    <SelectPrimitive.Root
      value={value || ALL}
      onValueChange={(v) => onChange(!v || v === ALL ? '' : String(v))}
    >
      <SelectPrimitive.Trigger
        className={cn(
          'inline-flex h-9 min-w-[168px] max-w-[220px] items-center gap-1.5 rounded-lg border border-emerald-100/70 bg-white px-2.5 text-xs text-zinc-700 outline-none transition-colors hover:bg-emerald-50/50 focus-visible:ring-2 focus-visible:ring-emerald-500/40 dark:border-emerald-900/50 dark:bg-zinc-900 dark:text-zinc-200 dark:hover:bg-zinc-800/60',
          className,
        )}
      >
        <Building2 className="h-3.5 w-3.5 shrink-0 text-zinc-400 dark:text-zinc-500" />
        <span className="min-w-0 flex-1 truncate text-left">{labelFor(value)}</span>
        <ChevronDownIcon className="h-3.5 w-3.5 shrink-0 text-zinc-400 dark:text-zinc-500" />
      </SelectPrimitive.Trigger>

      <SelectPrimitive.Portal>
        <SelectPrimitive.Positioner
          side="bottom"
          sideOffset={6}
          align="start"
          alignItemWithTrigger={false}
          className="isolate z-50"
        >
          <SelectPrimitive.Popup className="w-(--anchor-width) min-w-[220px] max-w-[320px] overflow-hidden rounded-xl border border-zinc-200 bg-white shadow-lg shadow-black/8 dark:border-zinc-700 dark:bg-zinc-900 data-open:animate-in data-open:fade-in-0 data-open:zoom-in-95 data-closed:animate-out data-closed:fade-out-0 data-closed:zoom-out-95">
            <SelectPrimitive.List className="max-h-[280px] overflow-y-auto p-1">
              <SelectPrimitive.Item
                value={ALL}
                className="flex cursor-pointer items-center gap-2 rounded-md px-2 py-1.5 text-xs text-zinc-600 outline-none data-highlighted:bg-emerald-50 data-highlighted:text-emerald-900 data-selected:font-medium data-selected:text-emerald-700 dark:text-zinc-400 dark:data-highlighted:bg-emerald-950/40 dark:data-highlighted:text-emerald-100 dark:data-selected:text-emerald-300"
              >
                <SelectPrimitive.ItemText className="min-w-0 flex-1 truncate">
                  All departments
                </SelectPrimitive.ItemText>
                <SelectPrimitive.ItemIndicator className="flex h-3.5 w-3.5 items-center justify-center">
                  <CheckIcon className="h-3 w-3" />
                </SelectPrimitive.ItemIndicator>
              </SelectPrimitive.Item>

              {departments.length > 0 && (
                <div className="my-1 h-px bg-zinc-100 dark:bg-zinc-800" />
              )}

              {departments.map((d) => (
                <SelectPrimitive.Item
                  key={d}
                  value={d}
                  className="flex cursor-pointer items-center gap-2 rounded-md px-2 py-1.5 text-xs text-zinc-700 outline-none data-highlighted:bg-emerald-50 data-highlighted:text-emerald-900 data-selected:font-medium data-selected:text-emerald-700 dark:text-zinc-300 dark:data-highlighted:bg-emerald-950/40 dark:data-highlighted:text-emerald-100 dark:data-selected:text-emerald-300"
                >
                  <SelectPrimitive.ItemText className="min-w-0 flex-1 truncate">
                    {d}
                  </SelectPrimitive.ItemText>
                  <SelectPrimitive.ItemIndicator className="flex h-3.5 w-3.5 items-center justify-center">
                    <CheckIcon className="h-3 w-3" />
                  </SelectPrimitive.ItemIndicator>
                </SelectPrimitive.Item>
              ))}
            </SelectPrimitive.List>
          </SelectPrimitive.Popup>
        </SelectPrimitive.Positioner>
      </SelectPrimitive.Portal>
    </SelectPrimitive.Root>
  );
}
