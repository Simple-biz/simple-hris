'use client';

/**
 * Small pieces shared by My Team's Rankings leaderboard (`AppointmentLeaderboardPane`)
 * and the modal its **View** button opens (`RankingHistoryModal`). Extracted, not
 * copied, so the board and the modal show the same toggle and the same dates.
 */
import { cn } from '@/lib/utils';

/** "2026-09-13" → "Sep 13" (or "Sep 13, 2026"). */
export function dateLabel(iso: string, withYear: boolean): string {
  const [y, m, d] = iso.split('-').map(Number);
  if (!y || !m || !d) return iso;
  return new Date(y, m - 1, d).toLocaleDateString(undefined, {
    month: 'short',
    day: 'numeric',
    ...(withYear ? { year: 'numeric' } : {}),
  });
}

export function addDaysIso(iso: string, n: number): string {
  const [y, m, d] = iso.split('-').map(Number);
  const dt = new Date(Date.UTC(y!, m! - 1, d! + n));
  return dt.toISOString().slice(0, 10);
}

/** A total count: whole numbers as they are, half credits (PM Team's Units) to one decimal. */
export function fmtCount(n: number): string {
  return Number.isInteger(n) ? String(n) : n.toFixed(1);
}

export function Segmented<T extends string>({
  label,
  value,
  options,
  onChange,
}: {
  label: string;
  value: T;
  options: readonly { value: T; label: string; disabled?: boolean; title?: string }[];
  onChange: (v: T) => void;
}) {
  return (
    <div
      role="tablist"
      aria-label={label}
      className="flex items-center gap-0.5 rounded-md border border-zinc-200 bg-zinc-50 p-0.5 dark:border-zinc-800 dark:bg-zinc-900"
    >
      {options.map((o) => (
        <button
          key={o.value}
          type="button"
          role="tab"
          aria-selected={value === o.value}
          disabled={o.disabled}
          title={o.title}
          onClick={() => onChange(o.value)}
          className={cn(
            'rounded-[5px] px-2.5 py-1 text-[11px] font-semibold transition-colors disabled:pointer-events-none disabled:opacity-40',
            value === o.value
              ? 'bg-white text-blue-700 shadow-sm dark:bg-zinc-950 dark:text-blue-300'
              : 'text-zinc-500 hover:text-zinc-800 dark:text-zinc-400 dark:hover:text-zinc-200',
          )}
        >
          {o.label}
        </button>
      ))}
    </div>
  );
}
