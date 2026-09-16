'use client';

/**
 * Checkbox multi-select + bulk-action plumbing shared by the MESA surfaces.
 * Lifted verbatim from `AccountingMesa.tsx` (2026-09-16) so HR → MESA → FPU can
 * bulk-approve the same way Accounting bulk-approves requests, instead of a
 * second copy drifting.
 */

import React, { useEffect, useRef, useState } from 'react';
import { Button } from '@/components/ui/button';
import { toast } from 'sonner';

/** Checkbox multi-select over a list of rows keyed by a stable string.
 *  `rows` should be the *filtered* set, so select-all covers everything the
 *  user can currently see (across pages) and `selectedRows` never includes a
 *  row hidden by the active search/filter. */
export function useRowSelection<T>(rows: T[], keyOf: (t: T) => string) {
  const [selectedKeys, setSelectedKeys] = useState<Set<string>>(new Set());
  const keys = rows.map(keyOf);
  const allSelected = keys.length > 0 && keys.every((k) => selectedKeys.has(k));
  const someSelected = keys.some((k) => selectedKeys.has(k));
  const toggle = (k: string) =>
    setSelectedKeys((prev) => {
      const next = new Set(prev);
      if (next.has(k)) next.delete(k);
      else next.add(k);
      return next;
    });
  const toggleAll = () =>
    setSelectedKeys((prev) => {
      const next = new Set(prev);
      if (keys.every((k) => next.has(k))) keys.forEach((k) => next.delete(k));
      else keys.forEach((k) => next.add(k));
      return next;
    });
  const clear = () => setSelectedKeys(new Set());
  const selectedRows = rows.filter((r) => selectedKeys.has(keyOf(r)));
  return { selectedKeys, selectedRows, allSelected, someSelected, toggle, toggleAll, clear };
}

export function SelectCheckbox({
  checked,
  indeterminate,
  onChange,
  ariaLabel,
}: {
  checked: boolean;
  indeterminate?: boolean;
  onChange: () => void;
  ariaLabel: string;
}) {
  const ref = useRef<HTMLInputElement>(null);
  useEffect(() => {
    if (ref.current) ref.current.indeterminate = !!indeterminate && !checked;
  }, [indeterminate, checked]);
  return (
    <input
      ref={ref}
      type="checkbox"
      checked={checked}
      onChange={onChange}
      aria-label={ariaLabel}
      onClick={(e) => e.stopPropagation()}
      className="h-3.5 w-3.5 cursor-pointer rounded border-zinc-300 accent-teal-600 dark:border-zinc-600"
    />
  );
}

/** Sticky bar shown above a table when ≥1 row is selected. */
export function BulkBar({ count, children, onClear }: { count: number; children: React.ReactNode; onClear: () => void }) {
  return (
    <div className="flex flex-wrap items-center justify-between gap-2 border-b border-teal-100/80 bg-teal-50/70 px-4 py-2 dark:border-teal-900/40 dark:bg-teal-950/40">
      <span className="text-xs font-semibold text-zinc-700 dark:text-zinc-200">{count} selected</span>
      <div className="flex flex-wrap items-center gap-1.5">
        {children}
        <Button type="button" size="sm" variant="ghost" onClick={onClear} className="h-7 text-[11px] text-zinc-500 hover:text-zinc-700 dark:text-zinc-400">
          Clear
        </Button>
      </div>
    </div>
  );
}

/** Run an async op over each item sequentially, tallying success/failure. The
 *  FIRST failure's message is kept: a refused request carries its reason (a
 *  400/409 from the server), and "1 failed" on its own throws that reason away. */
export async function runBulk<T>(
  items: T[],
  fn: (item: T) => Promise<void>,
): Promise<{ ok: number; fail: number; firstError: string | null }> {
  let ok = 0;
  let fail = 0;
  let firstError: string | null = null;
  for (const item of items) {
    try {
      await fn(item);
      ok += 1;
    } catch (e) {
      fail += 1;
      if (firstError === null) firstError = e instanceof Error ? e.message : String(e);
    }
  }
  return { ok, fail, firstError };
}

/** Summarize a bulk run as a toast. When a reason is passed it rides along as
 *  the toast description, so a refusal is readable rather than just counted. */
export function reportBulk(verb: string, ok: number, fail: number, firstError: string | null = null) {
  const reason = firstError ? { description: firstError } : undefined;
  if (ok && !fail) toast.success(`${verb} ${ok}`);
  else if (ok && fail) toast.warning(`${verb} ${ok}, ${fail} failed`, reason);
  else toast.error(`Nothing ${verb.toLowerCase()} — ${fail} failed`, reason);
}
