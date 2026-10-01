'use client';

/**
 * Accounting Scoreboard UI pieces shared by every panel: the API helper, number formatting, and
 * the autosaving cells. Governing doc: docs/features/accounting-scoreboard.md § The page.
 */

import { useEffect, useRef, useState, type ReactNode } from 'react';
import { toast } from 'sonner';
import { cn } from '@/lib/utils';
import type { GoalRule } from '@/lib/accounting-scoreboard/sections';
import { goalText, minutesToTimeInput, timeInputToMinutes } from '@/lib/accounting-scoreboard/scoring';

export type ApiResult<T> = { ok: true; data: T } | { ok: false; status: number; error: string; code: string };

/** JSON fetch that never throws and never hands back an HTML page as data. */
export async function api<T>(url: string, init?: RequestInit): Promise<ApiResult<T>> {
  try {
    const res = await fetch(url, {
      cache: 'no-store',
      ...init,
      headers: { 'Content-Type': 'application/json', ...(init?.headers ?? {}) },
    });
    const body = (await res.json().catch(() => null)) as (T & { error?: string; code?: string }) | null;
    if (!res.ok || body === null) {
      return {
        ok: false,
        status: res.status,
        error: body?.error ?? `The server answered ${res.status}.`,
        code: body?.code ?? 'http_error',
      };
    }
    return { ok: true, data: body };
  } catch (e) {
    return { ok: false, status: 0, error: e instanceof Error ? e.message : 'Network error', code: 'network' };
  }
}

/** "—" for absence, never 0 (ui-standards § 12.5). Up to 2 decimals, trailing zeros dropped. */
export function fmtNum(n: number | null | undefined): string {
  if (n === null || n === undefined || !Number.isFinite(n)) return '—';
  return Number.isInteger(n) ? n.toLocaleString('en-US') : n.toLocaleString('en-US', { maximumFractionDigits: 2 });
}

/** Scores print with one decimal, as the sheet does (8.3, 10.0). */
export function fmtScore(n: number | null | undefined): string {
  if (n === null || n === undefined || !Number.isFinite(n)) return '—';
  return (Math.round(n * 10) / 10).toFixed(1);
}

export function fmtPhp(n: number): string {
  return `₱${n.toLocaleString('en-US', { maximumFractionDigits: 2 })}`;
}

export function fmtUsd(n: number | null): string {
  return n === null ? '—' : `$${n.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
}

export function handle(email: string): string {
  return email.split('@')[0];
}

export const DIM = 'text-zinc-400 dark:text-zinc-600';
export const TINY_CAPS = 'text-[10px] font-semibold uppercase tracking-[0.14em]';

/** Goal chip: the sheet's goal and whether this week meets it. Absence is neutral, never "met". */
export function GoalChip({ goal, met, value, unitFormat }: { goal?: GoalRule; met: boolean | null; value: number | null; unitFormat: (n: number | null) => string }) {
  if (!goal) return null;
  return (
    <span
      className={cn(
        'inline-flex items-center gap-1.5 rounded-full border px-2.5 py-1 text-[11px] font-medium',
        met === true && 'border-emerald-200 bg-emerald-50 text-emerald-800 dark:border-emerald-900 dark:bg-emerald-950/40 dark:text-emerald-300',
        met === false && 'border-amber-200 bg-amber-50 text-amber-800 dark:border-amber-900 dark:bg-amber-950/40 dark:text-amber-300',
        met === null && 'border-zinc-200 bg-zinc-50 text-zinc-600 dark:border-zinc-800 dark:bg-zinc-900 dark:text-zinc-400',
      )}
    >
      <span className="font-mono tabular-nums">{unitFormat(value)}</span>
      <span className="opacity-70">goal {goalText(goal)}</span>
    </span>
  );
}

export function SectionHeader({ title, help, right }: { title: string; help: string; right?: ReactNode }) {
  return (
    <div className="flex flex-wrap items-start justify-between gap-3">
      <div className="min-w-0">
        <h2 className="text-base font-semibold text-zinc-900 dark:text-zinc-100">{title}</h2>
        <p className="mt-0.5 text-xs text-zinc-500 dark:text-zinc-400">{help}</p>
      </div>
      {right ? <div className="flex flex-wrap items-center gap-2">{right}</div> : null}
    </div>
  );
}

/** Tracks how many cells are being edited, so a background refresh never lands mid-typing. */
export type EditingSignal = (delta: 1 | -1) => void;

const CELL =
  'h-8 rounded-md border border-zinc-200 bg-white px-1.5 text-right font-mono text-[13px] tabular-nums text-zinc-900 outline-none transition-colors placeholder:text-zinc-300 focus:border-orange-400 focus:ring-2 focus:ring-orange-200 disabled:cursor-not-allowed disabled:bg-zinc-50 disabled:text-zinc-400 dark:border-zinc-800 dark:bg-zinc-950 dark:text-zinc-100 dark:placeholder:text-zinc-700 dark:focus:ring-orange-900/60 dark:disabled:bg-zinc-900';

/**
 * A count that saves itself on blur or Enter. Empty = no number (the entry is deleted), never 0.
 * While focused it keeps its own draft, so a refresh from someone else never overwrites typing.
 */
export function NumberCell({
  value,
  label,
  onCommit,
  onEditing,
  disabled,
  warn,
  title,
  className,
}: {
  value: number | null;
  label: string;
  onCommit: (next: number | null) => Promise<boolean>;
  onEditing: EditingSignal;
  disabled?: boolean;
  warn?: boolean;
  title?: string;
  className?: string;
}) {
  const shown = value === null ? '' : String(value);
  const [draft, setDraft] = useState(shown);
  const [saving, setSaving] = useState(false);
  const focused = useRef(false);

  useEffect(() => {
    if (!focused.current && !saving) setDraft(shown);
  }, [shown, saving]);

  async function commit() {
    const text = draft.trim();
    const next = text === '' ? null : Number(text);
    if (next !== null && (!Number.isFinite(next) || next < 0)) {
      toast.error(`${label}: type a number, or leave it empty`);
      setDraft(shown);
      return;
    }
    if (next === value) {
      setDraft(shown);
      return;
    }
    setSaving(true);
    const ok = await onCommit(next);
    setSaving(false);
    if (!ok) setDraft(shown);
  }

  return (
    <input
      type="text"
      inputMode="decimal"
      aria-label={label}
      title={title ?? label}
      value={draft}
      disabled={disabled}
      placeholder="—"
      onFocus={(e) => {
        focused.current = true;
        onEditing(1);
        e.currentTarget.select();
      }}
      onBlur={() => {
        focused.current = false;
        onEditing(-1);
        void commit();
      }}
      onChange={(e) => setDraft(e.target.value.replace(/[^0-9.]/g, ''))}
      onKeyDown={(e) => {
        if (e.key === 'Enter') e.currentTarget.blur();
        if (e.key === 'Escape') {
          setDraft(shown);
          requestAnimationFrame(() => (e.target as HTMLInputElement).blur());
        }
      }}
      className={cn(
        CELL,
        'w-14',
        warn && 'border-amber-400 bg-amber-50/60 dark:border-amber-700 dark:bg-amber-950/30',
        saving && 'opacity-60',
        className,
      )}
    />
  );
}

/** A clock time that saves itself (stored as minutes after midnight). */
export function TimeCell({
  value,
  label,
  onCommit,
  onEditing,
  disabled,
  warn,
}: {
  value: number | null;
  label: string;
  onCommit: (next: number | null) => Promise<boolean>;
  onEditing: EditingSignal;
  disabled?: boolean;
  warn?: boolean;
}) {
  const shown = minutesToTimeInput(value);
  const [draft, setDraft] = useState(shown);
  const [saving, setSaving] = useState(false);
  const focused = useRef(false);

  useEffect(() => {
    if (!focused.current && !saving) setDraft(shown);
  }, [shown, saving]);

  async function commit() {
    const next = draft === '' ? null : timeInputToMinutes(draft);
    if (draft !== '' && next === null) {
      setDraft(shown);
      return;
    }
    if (next === value) return;
    setSaving(true);
    const ok = await onCommit(next);
    setSaving(false);
    if (!ok) setDraft(shown);
  }

  return (
    <input
      type="time"
      aria-label={label}
      title={label}
      value={draft}
      disabled={disabled}
      onFocus={() => {
        focused.current = true;
        onEditing(1);
      }}
      onBlur={() => {
        focused.current = false;
        onEditing(-1);
        void commit();
      }}
      onChange={(e) => setDraft(e.target.value)}
      className={cn(
        CELL,
        'w-[6.5rem] text-left',
        warn && 'border-amber-400 bg-amber-50/60 dark:border-amber-700 dark:bg-amber-950/30',
        saving && 'opacity-60',
      )}
    />
  );
}

export function EmptyRows({ noun, isManager }: { noun: string; isManager: boolean }) {
  return (
    <div className="rounded-xl border border-dashed border-zinc-200 px-6 py-10 text-center dark:border-zinc-800">
      <p className="text-sm font-medium text-zinc-700 dark:text-zinc-300">No {noun}s on this section yet</p>
      <p className="mt-1 text-xs text-zinc-500 dark:text-zinc-400">
        {isManager ? 'Add them under Setup → Rows.' : 'Carla or Claire can add them under Setup.'}
      </p>
    </div>
  );
}
