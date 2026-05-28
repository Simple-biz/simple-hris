'use client';

import { useEffect, useMemo, useState } from 'react';
import { Briefcase, ChevronDown, ChevronLeft, ChevronRight, Mail, Search, Shield, Users, WifiOff } from 'lucide-react';
import { Badge } from '@/components/ui/badge';
import {
  Dialog,
  DialogContent,
  DialogTitle,
  DialogDescription,
} from '@/components/ui/dialog';
import { cn } from '@/lib/utils';
import { normEmail } from '@/lib/email/norm-email';
import { useOnlineEmails } from '@/components/presence/PresenceProvider';

interface SkillSetEntry {
  currently_working_on: string;
  skills: string;
  strengths: string;
  member_notes: string;
}

function hasAnySkillSet(s: SkillSetEntry | undefined): boolean {
  if (!s) return false;
  return Boolean(
    s.currently_working_on?.trim() ||
      s.skills?.trim() ||
      s.strengths?.trim() ||
      s.member_notes?.trim(),
  );
}


const CHIP_PAGE_SIZE = 12;

function SkillBlock({
  label,
  value,
  chip = false,
}: {
  label: string;
  value: string;
  chip?: boolean;
}) {
  const text = value?.trim();
  const items = chip && text
    ? text
        .split(/[,;\n]+/)
        .map((s) => s.trim())
        .filter(Boolean)
    : [];
  const [chipPage, setChipPage] = useState(1);
  const chipTotalPages = Math.max(1, Math.ceil(items.length / CHIP_PAGE_SIZE));
  useEffect(() => {
    if (chipPage > chipTotalPages) setChipPage(chipTotalPages);
  }, [chipPage, chipTotalPages]);
  const chipStart = (chipPage - 1) * CHIP_PAGE_SIZE;
  const chipEnd = Math.min(chipStart + CHIP_PAGE_SIZE, items.length);
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

interface Teammate {
  id: string;
  name: string;
  workEmail: string | null;
  personalEmail: string | null;
  department: string | null;
  suspended: boolean;
  /** True when this person manages the selected department (department_managers). */
  isManager: boolean;
}

interface Props {
  employeeEmail: string | null;
  department?: string | null;
}

/* ── Avatar (photo endpoint with styled-initials fallback) ─────────────── */

const AVATAR_GRADIENTS = [
  'from-orange-400 to-amber-500',
  'from-blue-500 to-indigo-600',
  'from-emerald-500 to-teal-600',
  'from-rose-500 to-pink-600',
  'from-violet-500 to-purple-600',
  'from-sky-500 to-cyan-600',
] as const;

function gradientFor(seed: string): string {
  let h = 0;
  for (let i = 0; i < seed.length; i += 1) h = (seed.charCodeAt(i) + ((h << 5) - h)) | 0;
  return AVATAR_GRADIENTS[Math.abs(h) % AVATAR_GRADIENTS.length]!;
}

function initialsOf(name: string, email: string | null): string {
  const fromName = name.trim().split(/\s+/).slice(0, 2).map((w) => w[0] ?? '').join('');
  if (fromName) return fromName.toUpperCase();
  const local = (email ?? '').split('@')[0] ?? '';
  return (local.slice(0, 2) || '?').toUpperCase();
}

function TeamAvatar({
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
function formatLastSeen(iso: string | null): string | null {
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

/* ── Main ──────────────────────────────────────────────────────────────── */

export default function EmployeeTeam({ employeeEmail, department }: Props) {
  const [teammates, setTeammates] = useState<Teammate[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [query, setQuery] = useState('');
  const [page, setPage] = useState(1);
  const [pageDir, setPageDir] = useState<'next' | 'prev'>('next');
  const PAGE_SIZE = 10;
  const goToPage = (n: number) => {
    setPage((prev) => {
      setPageDir(n >= prev ? 'next' : 'prev');
      return n;
    });
  };

  // Department picker. Scoped to the viewer's own department (the only option),
  // but kept as a dropdown so the selection drives both the roster filter and
  // the wallpaper banner. Wallpaper is read-only here — managers set it.
  const ownDept = department?.trim() || '';
  const [selectedDept, setSelectedDept] = useState(ownDept);
  useEffect(() => {
    setSelectedDept(department?.trim() || '');
  }, [department]);

  // Department options the employee may pick from. Own department only.
  const deptOptions = useMemo(() => (ownDept ? [ownDept] : []), [ownDept]);

  // Read-only wallpaper banner for the selected department (shared system with
  // the Manager My Team view: manager_team_wallpapers / /api/manager/team-wallpaper).
  const [wallpaperUrl, setWallpaperUrl] = useState<string | null>(null);
  const [wallpaperPos, setWallpaperPos] = useState('50% 50%');
  const [wallpaperLoading, setWallpaperLoading] = useState(true);

  useEffect(() => {
    if (!selectedDept) {
      setWallpaperUrl(null);
      setWallpaperPos('50% 50%');
      setWallpaperLoading(false);
      return;
    }
    let cancelled = false;
    setWallpaperLoading(true);
    fetch(`/api/manager/team-wallpaper?department=${encodeURIComponent(selectedDept)}`, {
      cache: 'no-store',
    })
      .then((r) => r.json())
      .then((j: { url?: string | null; position?: string | null }) => {
        if (cancelled) return;
        setWallpaperUrl(j.url ?? null);
        setWallpaperPos(j.position?.trim() || '50% 50%');
      })
      .catch(() => {
        if (!cancelled) setWallpaperUrl(null);
      })
      .finally(() => {
        if (!cancelled) setWallpaperLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [selectedDept]);

  const onlineEmails = useOnlineEmails();
  const selfNorm = normEmail(employeeEmail ?? '') ?? employeeEmail?.trim().toLowerCase() ?? null;
  const deptNorm = selectedDept.trim().toLowerCase() || null;

  // Last-seen lookup: { normEmail -> ISO timestamp }. Empty until fetched and
  // refreshed each time the roster changes (or on a slow tick so a teammate
  // who just went offline shows "Last seen just now" rather than the old
  // value from minutes ago).
  const [lastSeen, setLastSeen] = useState<Record<string, string>>({});

  const [skillSets, setSkillSets] = useState<Record<string, SkillSetEntry>>({});
  const [activeProfileId, setActiveProfileId] = useState<string | null>(null);
  // Sticky teammate keeps the modal content rendered through the close
  // animation. We only update it when activeProfileId is set; closing the
  // dialog leaves the last-shown teammate around so base-ui can play its
  // exit animation against real content rather than an unmounted node.
  const [stickyTeammate, setStickyTeammate] = useState<Teammate | null>(null);

  // Single roundtrip for roster + skill sets + initial last-seen, replacing
  // the old fan-out across /summary, /by-department, /employee-skill-sets, and
  // /presence/last-seen. /api/team-roster filters to same-dept + dept managers
  // server-side and skips the heavy rates merge entirely.
  useEffect(() => {
    let cancelled = false;
    const startedAt = Date.now();
    setLoading(true);
    setError(null);
    fetch(`/api/team-roster?department=${encodeURIComponent(selectedDept)}`, {
      cache: 'no-store',
    })
      .then((r) => r.json())
      .then(
        (
          j: {
            profiles?: {
              id: string;
              name: string;
              workEmail: string | null;
              personalEmail: string | null;
              department: string | null;
              isManager: boolean;
            }[];
            skillSets?: Record<string, SkillSetEntry>;
            lastSeen?: Record<string, string>;
            error?: string | null;
          },
        ) => {
          if (cancelled) return;
          if (j.error) setError(j.error);
          const rows: Teammate[] = (j.profiles ?? []).map((p) => ({
            id: p.id,
            name: p.name,
            workEmail: p.workEmail,
            personalEmail: p.personalEmail,
            department: p.department,
            suspended: false,
            isManager: p.isManager,
          }));
          setTeammates(rows);
          setSkillSets(j.skillSets ?? {});
          setLastSeen(j.lastSeen ?? {});
        },
      )
      .catch((e) => {
        if (!cancelled) setError(e instanceof Error ? e.message : 'Failed to load your team');
      })
      .finally(() => {
        // Keep skeletons on screen for at least 500ms so the shimmer is
        // perceptible even when the endpoint resolves quickly — flashing
        // skeletons read as jank, holding briefly reads as polished.
        const MIN_MS = 500;
        const elapsed = Date.now() - startedAt;
        const wait = Math.max(0, MIN_MS - elapsed);
        window.setTimeout(() => {
          if (!cancelled) setLoading(false);
        }, wait);
      });
    return () => {
      cancelled = true;
    };
  }, [deptNorm, selectedDept]);

  // Slow-tick refresh for last-seen so "Last seen 1m ago" creeps forward
  // without the user reloading the page. Initial values arrive bundled with
  // the team-roster fetch above; this only handles the polling.
  useEffect(() => {
    if (teammates.length === 0) return;
    const emails = teammates.flatMap((t) => [
      normEmail(t.workEmail ?? '') ?? '',
      normEmail(t.personalEmail ?? '') ?? '',
    ]).filter(Boolean);
    if (emails.length === 0) return;

    let cancelled = false;
    const interval = window.setInterval(() => {
      fetch(`/api/presence/last-seen?emails=${encodeURIComponent(emails.join(','))}`, {
        cache: 'no-store',
      })
        .then((r) => r.json())
        .then((j: { lastSeen?: Record<string, string> }) => {
          if (!cancelled) setLastSeen(j.lastSeen ?? {});
        })
        .catch(() => {
          /* non-fatal */
        });
    }, 60_000);
    return () => {
      cancelled = true;
      window.clearInterval(interval);
    };
  }, [teammates]);

  const isOnline = (t: Teammate): boolean => {
    const w = normEmail(t.workEmail ?? '');
    const p = normEmail(t.personalEmail ?? '');
    return (!!w && onlineEmails.has(w)) || (!!p && onlineEmails.has(p));
  };

  const skillSetFor = (t: Teammate): SkillSetEntry | undefined => {
    const w = normEmail(t.workEmail ?? '');
    return w ? skillSets[w] : undefined;
  };

  const openProfile = (id: string) => setActiveProfileId(id);

  const lastSeenFor = (t: Teammate): string | null => {
    const w = normEmail(t.workEmail ?? '');
    const p = normEmail(t.personalEmail ?? '');
    return (w && lastSeen[w]) || (p && lastSeen[p]) || null;
  };

  const isSelf = (t: Teammate): boolean => {
    if (!selfNorm) return false;
    const w = normEmail(t.workEmail ?? '');
    const p = normEmail(t.personalEmail ?? '');
    return w === selfNorm || p === selfNorm;
  };

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    const matches = q
      ? teammates.filter(
          (t) =>
            t.name.toLowerCase().includes(q) ||
            (t.workEmail?.toLowerCase().includes(q) ?? false) ||
            (t.personalEmail?.toLowerCase().includes(q) ?? false),
        )
      : teammates;
    // Managers first, then online, then alphabetical by name.
    return [...matches].sort((a, b) => {
      const am = a.isManager ? 0 : 1;
      const bm = b.isManager ? 0 : 1;
      if (am !== bm) return am - bm;
      const ao = isOnline(a) ? 0 : 1;
      const bo = isOnline(b) ? 0 : 1;
      if (ao !== bo) return ao - bo;
      return a.name.localeCompare(b.name, undefined, { sensitivity: 'base' });
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [teammates, query, onlineEmails, selfNorm]);

  const onlineCount = useMemo(() => teammates.filter(isOnline).length, [teammates, onlineEmails]);
  const deptLabel = selectedDept.trim() || 'Your team';

  useEffect(() => {
    if (!activeProfileId) return;
    const found = teammates.find((t) => t.id === activeProfileId);
    if (found) setStickyTeammate(found);
  }, [activeProfileId, teammates]);

  const totalPages = Math.max(1, Math.ceil(filtered.length / PAGE_SIZE));
  useEffect(() => {
    setPage(1);
  }, [query, selectedDept]);
  useEffect(() => {
    if (page > totalPages) setPage(totalPages);
  }, [page, totalPages]);
  const pageStart = (page - 1) * PAGE_SIZE;
  const pageEnd = Math.min(pageStart + PAGE_SIZE, filtered.length);
  const pageItems = filtered.slice(pageStart, pageEnd);

  function pageNumbers(current: number, total: number): (number | 'gap')[] {
    if (total <= 7) return Array.from({ length: total }, (_, i) => i + 1);
    const out: (number | 'gap')[] = [1];
    const start = Math.max(2, current - 1);
    const end = Math.min(total - 1, current + 1);
    if (start > 2) out.push('gap');
    for (let i = start; i <= end; i += 1) out.push(i);
    if (end < total - 1) out.push('gap');
    out.push(total);
    return out;
  }

  return (
    <div className="flex h-full min-h-0 flex-col overflow-y-auto bg-gradient-to-br from-white via-orange-50/30 to-blue-50/20 p-4 sm:p-6 dark:bg-none dark:bg-[#0d1117]">
      <div className="w-full space-y-6">
        {/* Department wallpaper banner — read-only. Managers assign it; here we
            just display the image saved for the selected department. */}
        <div
          className={cn(
            'relative h-32 overflow-hidden rounded-2xl border border-orange-100/80 sm:h-40',
            'dark:border-blue-950/60',
          )}
          style={
            wallpaperUrl
              ? {
                  backgroundImage: `url(${wallpaperUrl})`,
                  backgroundSize: 'cover',
                  backgroundPosition: wallpaperPos,
                  backgroundRepeat: 'no-repeat',
                }
              : undefined
          }
        >
          {!wallpaperUrl && (
            <div className="absolute inset-0 bg-gradient-to-br from-orange-100 via-amber-50 to-blue-50 dark:from-blue-950/60 dark:via-indigo-950/30 dark:to-zinc-950" />
          )}
          {/* Bottom fade keeps the scope label legible over busy images */}
          <div className="pointer-events-none absolute inset-x-0 bottom-0 h-1/2 bg-gradient-to-t from-black/30 to-transparent" />

          {/* Loading overlay while the wallpaper is fetched (department switch / mount) */}
          {wallpaperLoading && (
            <div
              className="pointer-events-none absolute inset-0 z-10 overflow-hidden"
              aria-live="polite"
              aria-busy="true"
            >
              <div className="absolute inset-0 bg-gradient-to-br from-slate-950/85 via-blue-950/80 to-cyan-950/80" />
              <div
                className="absolute inset-0 opacity-30 mix-blend-screen"
                style={{
                  backgroundImage:
                    'linear-gradient(rgba(34,211,238,0.15) 1px, transparent 1px), linear-gradient(90deg, rgba(34,211,238,0.15) 1px, transparent 1px)',
                  backgroundSize: '32px 32px',
                  animation: 'wallpaper-pulse 2.2s ease-in-out infinite',
                }}
              />
              <div
                className="absolute inset-0 opacity-50"
                style={{
                  background:
                    'linear-gradient(115deg, transparent 30%, rgba(34,211,238,0.35) 50%, transparent 70%)',
                  animation: 'wallpaper-shimmer 2.4s linear infinite',
                  width: '200%',
                  left: '-50%',
                }}
              />
              <div
                className="absolute inset-x-0 top-0 h-0.5 bg-gradient-to-r from-transparent via-cyan-300 to-transparent shadow-[0_0_18px_4px_rgba(34,211,238,0.7)]"
                style={{ animation: 'wallpaper-scan 1.8s ease-in-out infinite' }}
              />
            </div>
          )}

          {/* Scope label */}
          <div className="pointer-events-none absolute bottom-2 left-3 inline-flex items-center gap-1.5 rounded-md bg-white/70 px-2 py-0.5 text-[10px] font-medium uppercase tracking-wider text-zinc-700 backdrop-blur dark:bg-zinc-900/60 dark:text-zinc-300">
            <span className="opacity-70">Team</span>
            <span className="text-zinc-300 dark:text-zinc-600">&middot;</span>
            <span>{deptLabel}</span>
          </div>
        </div>

        {/* Header */}
        <div>
          <div className="flex flex-wrap items-center gap-2">
            <h2 className="text-2xl font-bold tracking-tight text-zinc-900 dark:text-white">
              My Team
            </h2>

            {/* Department dropdown — own department only */}
            {deptOptions.length > 0 ? (
              <div className="relative">
                <select
                  value={selectedDept}
                  onChange={(e) => setSelectedDept(e.target.value)}
                  aria-label="Select department"
                  className="appearance-none rounded-md border border-orange-200 bg-orange-50 py-1 pl-2.5 pr-7 text-xs font-medium text-orange-700 focus:border-orange-300 focus:outline-none focus:ring-1 focus:ring-orange-200 dark:border-blue-900/60 dark:bg-blue-950/40 dark:text-orange-300"
                >
                  {deptOptions.map((d) => (
                    <option key={d} value={d}>
                      {d}
                    </option>
                  ))}
                </select>
                <ChevronDown className="pointer-events-none absolute right-2 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-orange-500/70 dark:text-orange-300/70" />
              </div>
            ) : (
              <Badge
                variant="outline"
                className="border-orange-200 bg-orange-50 text-orange-700 dark:border-blue-900/60 dark:bg-blue-950/40 dark:text-orange-300"
              >
                {deptLabel}
              </Badge>
            )}
            {!loading && (
              <span className="inline-flex items-center gap-1.5 rounded-full border border-emerald-200 bg-emerald-50 px-2.5 py-0.5 text-xs font-medium text-emerald-700 dark:border-emerald-500/30 dark:bg-emerald-500/10 dark:text-emerald-300">
                <span className="relative flex h-2 w-2">
                  <span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-emerald-400/70" />
                  <span className="relative inline-flex h-2 w-2 rounded-full bg-emerald-500" />
                </span>
                {onlineCount} online
              </span>
            )}
          </div>
          <p className="mt-1 max-w-2xl text-sm leading-relaxed text-zinc-600 dark:text-zinc-500">
            Your teammates and their work emails. A green dot means they are signed in to the HRIS
            right now.
          </p>
        </div>

        {/* Search */}
        <div className="relative">
          <Search className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-zinc-400" />
          <input
            type="text"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="Search by name or email"
            className="w-full rounded-xl border border-orange-100 bg-white py-2.5 pl-9 pr-3 text-sm text-zinc-900 placeholder:text-zinc-400 focus:border-orange-300 focus:outline-none focus:ring-1 focus:ring-orange-200 dark:border-blue-950/60 dark:bg-[#0d1117] dark:text-zinc-100 dark:focus:border-blue-800 dark:focus:ring-blue-900/40"
          />
        </div>

        {/* Body */}
        {loading ? (
          <div
            className="grid grid-cols-1 items-start gap-4 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4 2xl:grid-cols-5"
            aria-busy="true"
            aria-live="polite"
          >
            <span className="sr-only">Loading your team…</span>
            {Array.from({ length: 8 }).map((_, i) => (
              <div
                key={i}
                className="min-h-[210px] overflow-hidden rounded-2xl border border-zinc-200/80 bg-white p-5 shadow-sm dark:border-blue-950/60 dark:bg-[#0d1117]"
                style={{ animationDelay: `${i * 60}ms` }}
              >
                {/* Header: avatar + name/role */}
                <div className="flex items-start gap-3">
                  <div className="skeleton-shimmer h-11 w-11 shrink-0 rounded-full" />
                  <div className="flex-1 space-y-2 pt-1">
                    <div className="skeleton-shimmer h-3.5 w-3/5 rounded" />
                    <div className="skeleton-shimmer h-3 w-2/5 rounded" />
                  </div>
                </div>
                {/* Email row */}
                <div className="mt-4 flex items-center gap-2">
                  <div className="skeleton-shimmer h-3 w-3 rounded-sm" />
                  <div className="skeleton-shimmer h-3 w-4/5 rounded" />
                </div>
                {/* Working-on row */}
                <div className="mt-2 flex items-start gap-2">
                  <div className="skeleton-shimmer mt-0.5 h-3 w-3 rounded-sm" />
                  <div className="flex-1 space-y-1.5">
                    <div className="skeleton-shimmer h-3 w-full rounded" />
                    <div className="skeleton-shimmer h-3 w-3/4 rounded" />
                  </div>
                </div>
                {/* Hint row */}
                <div className="mt-6 flex items-center justify-between border-t border-zinc-100 pt-2.5 dark:border-zinc-800/60">
                  <div className="skeleton-shimmer h-3 w-24 rounded" />
                  <div className="skeleton-shimmer h-3 w-3 rounded-sm" />
                </div>
              </div>
            ))}
          </div>
        ) : error ? (
          <div className="flex flex-col items-center gap-2 rounded-2xl border border-dashed border-orange-200 bg-white py-14 text-center dark:border-blue-950/60 dark:bg-[#0d1117]">
            <WifiOff className="h-7 w-7 text-zinc-300 dark:text-zinc-700" />
            <p className="text-sm text-zinc-500">{error}</p>
          </div>
        ) : filtered.length === 0 ? (
          <div className="flex flex-col items-center gap-2 rounded-2xl border border-dashed border-orange-200 bg-white py-16 text-center dark:border-blue-950/60 dark:bg-[#0d1117]">
            <div className="flex h-12 w-12 items-center justify-center rounded-2xl bg-orange-50 text-orange-400 dark:bg-blue-950/40">
              <Users className="h-5 w-5" />
            </div>
            <p className="text-sm font-medium text-zinc-600 dark:text-zinc-400">
              {query ? 'No teammates match your search.' : 'No teammates to show yet.'}
            </p>
          </div>
        ) : (
          <div
            key={`page-${page}-${selectedDept}-${query}`}
            className={cn(
              'grid grid-cols-1 items-start gap-4 animate-in fade-in duration-300 ease-out motion-reduce:animate-none sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4 2xl:grid-cols-5',
              pageDir === 'next' ? 'slide-in-from-right-12' : 'slide-in-from-left-12',
            )}
          >
            {pageItems.map((t) => {
              const online = isOnline(t);
              const self = isSelf(t);
              const email = t.workEmail ?? t.personalEmail;
              const seenRel = online ? null : formatLastSeen(lastSeenFor(t));
              const seenIso = online ? null : lastSeenFor(t);
              const ss = skillSetFor(t);
              const hasSS = hasAnySkillSet(ss);
              const roleLine = t.department?.trim() || null;
              const workingOn = ss?.currently_working_on?.trim() || null;
              const interactive = hasSS;
              return (
                <div
                  key={t.id}
                  className={cn(
                    'group relative min-h-[210px] overflow-hidden rounded-2xl border border-zinc-200/80 bg-white shadow-sm transition-[transform,box-shadow,border-color] duration-[420ms] ease-[cubic-bezier(0.22,1,0.36,1)] motion-reduce:transition-none dark:border-blue-950/60 dark:bg-[#0d1117]',
                    interactive && 'hover:-translate-y-0.5 hover:border-orange-200 hover:shadow-md hover:shadow-orange-100/40 dark:hover:border-blue-900 dark:hover:shadow-blue-950/40',
                  )}
                >
                  <div
                    className={cn(
                      'p-5 transition-colors',
                      interactive ? 'cursor-pointer' : '',
                    )}
                    onClick={interactive ? () => openProfile(t.id) : undefined}
                    role={interactive ? 'button' : undefined}
                    tabIndex={interactive ? 0 : undefined}
                    aria-haspopup="dialog"
                    onKeyDown={
                      interactive
                        ? (e) => {
                            if (e.key === 'Enter' || e.key === ' ') {
                              e.preventDefault();
                              openProfile(t.id);
                            }
                          }
                        : undefined
                    }
                  >
                    {/* Header: avatar + name + role */}
                    <div className="flex items-start gap-3">
                      <div className="relative shrink-0">
                        <TeamAvatar name={t.name} email={email} />
                        <span
                          className={cn(
                            'absolute -bottom-0.5 -right-0.5 h-3 w-3 rounded-full ring-2 ring-white dark:ring-[#0d1117]',
                            online ? 'bg-emerald-500' : 'bg-zinc-300 dark:bg-zinc-600',
                          )}
                          title={
                            online
                              ? 'Online'
                              : seenIso
                              ? `Last seen ${new Date(seenIso).toLocaleString()}`
                              : 'Offline'
                          }
                          aria-hidden
                        />
                      </div>
                      <div className="min-w-0 flex-1">
                        <div className="flex items-center gap-1.5">
                          <h4 className="truncate text-[0.95rem] font-semibold leading-snug text-zinc-900 dark:text-white">
                            {t.name}
                          </h4>
                          {t.isManager && (
                            <Shield
                              className="h-3.5 w-3.5 shrink-0 text-violet-500 dark:text-violet-400"
                              aria-label="Manager"
                            />
                          )}
                          {self && (
                            <span className="shrink-0 rounded bg-orange-100 px-1 text-[9px] font-semibold uppercase tracking-wide text-orange-700 dark:bg-blue-950/50 dark:text-orange-300">
                              You
                            </span>
                          )}
                        </div>
                        {roleLine && (
                          <p
                            className="mt-0.5 truncate text-[12.5px] leading-snug text-zinc-500 dark:text-zinc-400"
                            title={roleLine}
                          >
                            {roleLine}
                          </p>
                        )}
                      </div>
                    </div>

                    {/* Email */}
                    <div className="mt-3 flex items-center gap-2 text-[12.5px] text-zinc-500 dark:text-zinc-400">
                      <Mail className="h-3.5 w-3.5 shrink-0" />
                      <span className="truncate" title={email ?? undefined}>
                        {email ?? 'No email on file'}
                      </span>
                    </div>

                    {/* Currently working on */}
                    {workingOn && (
                      <div className="mt-1.5 flex items-start gap-2 text-[12.5px] text-zinc-500 dark:text-zinc-400">
                        <Briefcase className="mt-0.5 h-3.5 w-3.5 shrink-0" />
                        <span className="line-clamp-2 leading-snug" title={workingOn}>
                          {workingOn}
                        </span>
                      </div>
                    )}

                    {/* Skeleton placeholder for teammates who haven't shared
                        a profile yet — keeps card heights visually consistent
                        across the grid and signals "nothing here yet". */}
                    {!hasSS && (
                      <div
                        className="mt-2 space-y-2"
                        aria-label="No profile shared yet"
                      >
                        <div className="flex items-start gap-2">
                          <div className="skeleton-shimmer mt-0.5 h-3.5 w-3.5 shrink-0 rounded-sm" />
                          <div className="flex-1 space-y-1.5">
                            <div className="skeleton-shimmer h-3 w-full rounded" />
                            <div className="skeleton-shimmer h-3 w-3/5 rounded" />
                          </div>
                        </div>
                      </div>
                    )}

                    {/* Hint to open profile modal */}
                    {hasSS && (
                      <div className="mt-4 flex items-center justify-between border-t border-zinc-100 pt-2.5 text-[11px] text-zinc-400 dark:border-zinc-800/60 dark:text-zinc-500">
                        <span className="transition-colors duration-300 group-hover:text-orange-600 dark:group-hover:text-orange-300">
                          View full profile
                        </span>
                        <ChevronRight
                          className="h-3.5 w-3.5 transition-transform duration-300 ease-out motion-reduce:transition-none group-hover:translate-x-0.5 group-hover:text-orange-500 dark:group-hover:text-orange-400"
                          aria-hidden
                        />
                      </div>
                    )}
                    {!hasSS && (
                      <div className="mt-4 flex items-center justify-between border-t border-zinc-100 pt-2.5 dark:border-zinc-800/60">
                        <div className="skeleton-shimmer h-3 w-24 rounded" />
                        <div className="skeleton-shimmer h-3 w-3 rounded-sm" />
                      </div>
                    )}
                  </div>

                </div>
              );
            })}
          </div>
        )}

        {!loading && !error && filtered.length > PAGE_SIZE && (
          <div className="flex flex-col items-center justify-between gap-3 sm:flex-row">
            <p className="text-xs text-zinc-500 dark:text-zinc-400">
              Showing <span className="font-semibold text-zinc-700 dark:text-zinc-200">{pageStart + 1}</span>
              –<span className="font-semibold text-zinc-700 dark:text-zinc-200">{pageEnd}</span>{' '}
              of <span className="font-semibold text-zinc-700 dark:text-zinc-200">{filtered.length}</span>
            </p>
            <nav
              role="navigation"
              aria-label="Pagination"
              className="inline-flex items-center gap-1 rounded-xl border border-orange-100/80 bg-white p-1 shadow-sm dark:border-blue-950/60 dark:bg-[#0d1117]"
            >
              <button
                type="button"
                onClick={() => goToPage(Math.max(1, page - 1))}
                disabled={page === 1}
                aria-label="Previous page"
                className="inline-flex h-8 w-8 items-center justify-center rounded-lg text-zinc-500 transition-colors hover:bg-orange-50 hover:text-orange-600 disabled:cursor-not-allowed disabled:opacity-40 disabled:hover:bg-transparent disabled:hover:text-zinc-500 dark:text-zinc-400 dark:hover:bg-blue-950/40 dark:hover:text-orange-300"
              >
                <ChevronLeft className="h-4 w-4" />
              </button>
              {pageNumbers(page, totalPages).map((n, i) =>
                n === 'gap' ? (
                  <span
                    key={`gap-${i}`}
                    className="px-1.5 text-xs text-zinc-400 dark:text-zinc-600"
                    aria-hidden
                  >
                    …
                  </span>
                ) : (
                  <button
                    key={n}
                    type="button"
                    onClick={() => goToPage(n)}
                    aria-current={n === page ? 'page' : undefined}
                    className={cn(
                      'inline-flex h-8 min-w-[2rem] items-center justify-center rounded-lg px-2 text-xs font-semibold transition-colors',
                      n === page
                        ? 'bg-gradient-to-br from-orange-500 to-amber-500 text-white shadow-sm dark:from-orange-500 dark:to-amber-600'
                        : 'text-zinc-600 hover:bg-orange-50 hover:text-orange-600 dark:text-zinc-300 dark:hover:bg-blue-950/40 dark:hover:text-orange-300',
                    )}
                  >
                    {n}
                  </button>
                ),
              )}
              <button
                type="button"
                onClick={() => goToPage(Math.min(totalPages, page + 1))}
                disabled={page === totalPages}
                aria-label="Next page"
                className="inline-flex h-8 w-8 items-center justify-center rounded-lg text-zinc-500 transition-colors hover:bg-orange-50 hover:text-orange-600 disabled:cursor-not-allowed disabled:opacity-40 disabled:hover:bg-transparent disabled:hover:text-zinc-500 dark:text-zinc-400 dark:hover:bg-blue-950/40 dark:hover:text-orange-300"
              >
                <ChevronRight className="h-4 w-4" />
              </button>
            </nav>
          </div>
        )}

        <Dialog
          open={!!activeProfileId}
          onOpenChange={(o) => {
            if (!o) setActiveProfileId(null);
          }}
        >
          {stickyTeammate && (() => {
            const t = stickyTeammate;
            const ss = skillSetFor(t);
            const email = t.workEmail ?? t.personalEmail;
            const online = isOnline(t);
            const seenRel = online ? null : formatLastSeen(lastSeenFor(t));
            return (
              <DialogContent className="gap-0 overflow-hidden border-orange-100/80 bg-white p-0 sm:max-w-4xl dark:border-blue-950/60 dark:bg-[#0d1117]">
                <div className="grid sm:grid-cols-[280px_1fr]">
                  {/* Identity column */}
                  <div className="flex flex-col gap-3 bg-gradient-to-br from-orange-50 via-white to-blue-50/60 p-6 sm:border-r sm:border-orange-100/60 dark:from-blue-950/40 dark:via-[#0d1117] dark:to-blue-950/30 dark:sm:border-blue-950/40">
                    <div className="relative self-start">
                      <TeamAvatar name={t.name} email={email} size="xl" />
                      <span
                        className={cn(
                          'absolute bottom-1 right-1 h-4 w-4 rounded-full ring-2 ring-white dark:ring-[#0d1117]',
                          online ? 'bg-emerald-500' : 'bg-zinc-300 dark:bg-zinc-600',
                        )}
                        aria-hidden
                      />
                    </div>
                    <div className="space-y-1">
                      <DialogTitle className="text-xl font-bold leading-tight text-zinc-900 dark:text-white">
                        {t.name}
                      </DialogTitle>
                      {t.department && (
                        <p className="text-sm text-zinc-500 dark:text-zinc-400">
                          {t.department}
                        </p>
                      )}
                      <div className="flex flex-wrap gap-1.5 pt-1">
                        {t.isManager && (
                          <span className="inline-flex items-center gap-1 rounded-md bg-violet-100 px-1.5 py-0.5 text-[10px] font-semibold uppercase tracking-wide text-violet-700 dark:bg-violet-950/50 dark:text-violet-300">
                            <Shield className="h-2.5 w-2.5" />
                            Manager
                          </span>
                        )}
                        {isSelf(t) && (
                          <span className="rounded-md bg-orange-100 px-1.5 py-0.5 text-[10px] font-semibold uppercase tracking-wide text-orange-700 dark:bg-blue-950/50 dark:text-orange-300">
                            You
                          </span>
                        )}
                      </div>
                    </div>
                    <div className="mt-1 space-y-2 border-t border-zinc-200/60 pt-3 text-sm dark:border-zinc-800/60">
                      {email && (
                        <div className="flex items-start gap-2 text-zinc-600 dark:text-zinc-300">
                          <Mail className="mt-0.5 h-3.5 w-3.5 shrink-0 text-zinc-400" />
                          <span className="break-all">{email}</span>
                        </div>
                      )}
                      <div className="flex items-center gap-2 text-zinc-600 dark:text-zinc-300">
                        <span
                          className={cn(
                            'h-2 w-2 rounded-full',
                            online ? 'bg-emerald-500' : 'bg-zinc-400 dark:bg-zinc-500',
                          )}
                        />
                        <span>
                          {online ? 'Online now' : seenRel ? `Last seen ${seenRel}` : 'Offline'}
                        </span>
                      </div>
                    </div>
                  </div>

                  {/* Details column */}
                  <div className="max-h-[75vh] overflow-y-auto p-6">
                    <DialogDescription className="sr-only">
                      Full profile and skill set for {t.name}.
                    </DialogDescription>
                    {ss ? (
                      <div className="space-y-4">
                        <SkillBlock label="Currently Working On" value={ss.currently_working_on} />
                        <SkillBlock label="Skills" value={ss.skills} chip />
                        <div className="grid gap-4 sm:grid-cols-2">
                          <SkillBlock label="Strengths" value={ss.strengths} />
                          <SkillBlock label="Member Notes" value={ss.member_notes} />
                        </div>
                      </div>
                    ) : (
                      <p className="text-sm italic text-zinc-400 dark:text-zinc-600">
                        This teammate hasn&apos;t shared any profile details yet.
                      </p>
                    )}
                  </div>
                </div>
              </DialogContent>
            );
          })()}
        </Dialog>
      </div>
    </div>
  );
}
