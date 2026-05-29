'use client';

import { useEffect, useState } from 'react';
import { ChevronLeft, ChevronRight } from 'lucide-react';
import { cn } from '@/lib/utils';

/* ── Avatar (photo endpoint with styled-initials fallback) ─────────────── */

const AVATAR_GRADIENTS = [
  'from-orange-400 to-amber-500',
  'from-blue-500 to-indigo-600',
  'from-emerald-500 to-teal-600',
  'from-rose-500 to-pink-600',
  'from-violet-500 to-purple-600',
  'from-sky-500 to-cyan-600',
] as const;

export function gradientFor(seed: string): string {
  let h = 0;
  for (let i = 0; i < seed.length; i += 1) h = (seed.charCodeAt(i) + ((h << 5) - h)) | 0;
  return AVATAR_GRADIENTS[Math.abs(h) % AVATAR_GRADIENTS.length]!;
}

export function initialsOf(name: string, email: string | null): string {
  const fromName = name.trim().split(/\s+/).slice(0, 2).map((w) => w[0] ?? '').join('');
  if (fromName) return fromName.toUpperCase();
  const local = (email ?? '').split('@')[0] ?? '';
  return (local.slice(0, 2) || '?').toUpperCase();
}

export function TeamAvatar({
  name,
  email,
  size = 'md',
}: {
  name: string;
  email: string | null;
  size?: 'md' | 'xl';
}) {
  const [failed, setFailed] = useState(false);
  const seed = email ?? name;
  const px = size === 'xl' ? 88 : 44;
  const sizeClass = size === 'xl' ? 'h-22 w-22 text-2xl' : 'h-11 w-11 text-sm';

  if (email && !failed) {
    return (
      // eslint-disable-next-line @next/next/no-img-element -- internal photo proxy
      <img
        src={`/api/employee-profile-photo?email=${encodeURIComponent(email)}&_fmt=img`}
        alt=""
        width={px}
        height={px}
        className={cn(
          'shrink-0 rounded-full object-cover',
          size === 'xl' ? 'h-22 w-22' : 'h-11 w-11',
        )}
        style={size === 'xl' ? { height: 88, width: 88 } : undefined}
        onError={() => setFailed(true)}
      />
    );
  }
  return (
    <div
      aria-hidden
      className={cn(
        'flex shrink-0 items-center justify-center rounded-full bg-gradient-to-br font-bold text-white shadow-sm',
        sizeClass,
        gradientFor(seed),
      )}
      style={size === 'xl' ? { height: 88, width: 88 } : undefined}
    >
      {initialsOf(name, email)}
    </div>
  );
}

/* ── "Last seen" formatting ─────────────────────────────────────────────── */

/** "just now" / "5m ago" / "3h ago" / "2d ago" / dated for older than a week.
 *  Returns null when the timestamp is missing or unparseable so callers can
 *  decide whether to fall back to a plain "Offline" label. */
export function formatLastSeen(iso: string | null): string | null {
  if (!iso) return null;
  const t = new Date(iso).getTime();
  if (Number.isNaN(t)) return null;
  const secs = Math.max(0, Math.round((Date.now() - t) / 1000));
  if (secs < 60) return 'just now';
  const mins = Math.round(secs / 60);
  if (mins < 60) return `${mins}m ago`;
  const hrs = Math.round(mins / 60);
  if (hrs < 24) return `${hrs}h ago`;
  const days = Math.round(hrs / 24);
  if (days < 7) return `${days}d ago`;
  return new Date(t).toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
}

/* ── SkillBlock — read-only labelled value (text or paginated chips) ─────── */

const CHIP_PAGE_SIZE = 12;

export function SkillBlock({
  label,
  value,
  chip = false,
  chipPageSize = CHIP_PAGE_SIZE,
}: {
  label: string;
  value: string;
  chip?: boolean;
  /** Chips shown before pagination. Higher values let a modal fill before it paginates. */
  chipPageSize?: number;
}) {
  const text = value?.trim();
  const items = chip && text
    ? text
        .split(/[,;\n]+/)
        .map((s) => s.trim())
        .filter(Boolean)
    : [];
  const [chipPage, setChipPage] = useState(1);
  const chipTotalPages = Math.max(1, Math.ceil(items.length / chipPageSize));
  useEffect(() => {
    if (chipPage > chipTotalPages) setChipPage(chipTotalPages);
  }, [chipPage, chipTotalPages]);
  const chipStart = (chipPage - 1) * chipPageSize;
  const chipEnd = Math.min(chipStart + chipPageSize, items.length);
  const visibleChips = chip ? items.slice(chipStart, chipEnd) : [];

  return (
    <div className="rounded-xl border border-orange-100/80 bg-white/80 px-3 py-2.5 dark:border-blue-950/60 dark:bg-[#0d1117]/60">
      <div className="flex items-center justify-between gap-2">
        <div className="text-[10px] font-semibold uppercase tracking-wider text-zinc-500 dark:text-zinc-400">
          {label}
        </div>
        {chip && items.length > 0 && (
          <span className="inline-flex h-5 min-w-[1.5rem] items-center justify-center rounded-full bg-zinc-100 px-1.5 text-[10px] font-semibold text-zinc-600 dark:bg-zinc-800 dark:text-zinc-300">
            {items.length}
          </span>
        )}
      </div>
      {chip ? (
        items.length > 0 ? (
          <>
            <div
              key={`chips-${chipPage}`}
              className="mt-2 flex flex-wrap gap-1.5 animate-in fade-in slide-in-from-bottom-1 duration-200 ease-out motion-reduce:animate-none"
            >
              {visibleChips.map((item, i) => (
                <span
                  key={`${item}-${chipStart + i}`}
                  className="inline-flex items-center rounded-full border border-zinc-200 bg-zinc-50 px-2.5 py-0.5 text-[12px] font-medium text-zinc-700 transition-colors hover:border-orange-200 hover:bg-orange-50 hover:text-orange-700 dark:border-zinc-800 dark:bg-zinc-900/60 dark:text-zinc-200 dark:hover:border-orange-500/40 dark:hover:bg-orange-500/10 dark:hover:text-orange-200"
                >
                  {item}
                </span>
              ))}
            </div>
            {chipTotalPages > 1 && (
              <div className="mt-2.5 flex items-center justify-between gap-2">
                <span className="text-[10px] text-zinc-400 dark:text-zinc-500">
                  {chipStart + 1}–{chipEnd} of {items.length}
                </span>
                <div className="inline-flex items-center gap-1 rounded-full border border-orange-100/80 bg-white px-1 py-0.5 dark:border-blue-950/60 dark:bg-[#0d1117]">
                  <button
                    type="button"
                    onClick={(e) => {
                      e.stopPropagation();
                      setChipPage((p) => Math.max(1, p - 1));
                    }}
                    disabled={chipPage === 1}
                    aria-label="Previous skills"
                    className="inline-flex h-5 w-5 items-center justify-center rounded-full text-zinc-500 transition-colors hover:bg-orange-50 hover:text-orange-600 disabled:cursor-not-allowed disabled:opacity-40 disabled:hover:bg-transparent disabled:hover:text-zinc-500 dark:text-zinc-400 dark:hover:bg-blue-950/40 dark:hover:text-orange-300"
                  >
                    <ChevronLeft className="h-3 w-3" />
                  </button>
                  <span className="px-1 text-[10px] font-semibold tabular-nums text-zinc-600 dark:text-zinc-300">
                    {chipPage} / {chipTotalPages}
                  </span>
                  <button
                    type="button"
                    onClick={(e) => {
                      e.stopPropagation();
                      setChipPage((p) => Math.min(chipTotalPages, p + 1));
                    }}
                    disabled={chipPage === chipTotalPages}
                    aria-label="Next skills"
                    className="inline-flex h-5 w-5 items-center justify-center rounded-full text-zinc-500 transition-colors hover:bg-orange-50 hover:text-orange-600 disabled:cursor-not-allowed disabled:opacity-40 disabled:hover:bg-transparent disabled:hover:text-zinc-500 dark:text-zinc-400 dark:hover:bg-blue-950/40 dark:hover:text-orange-300"
                  >
                    <ChevronRight className="h-3 w-3" />
                  </button>
                </div>
              </div>
            )}
          </>
        ) : (
          <p className="mt-1 text-[12.5px] italic text-zinc-400 dark:text-zinc-600">Not shared</p>
        )
      ) : text ? (
        <p className="mt-1 whitespace-pre-wrap break-words text-[13px] leading-relaxed text-zinc-800 dark:text-zinc-200">
          {text}
        </p>
      ) : (
        <p className="mt-1 text-[12.5px] italic text-zinc-400 dark:text-zinc-600">Not shared</p>
      )}
    </div>
  );
}
