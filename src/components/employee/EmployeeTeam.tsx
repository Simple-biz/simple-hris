'use client';

import { useEffect, useMemo, useState } from 'react';
import { ChevronDown, ChevronRight, Loader2, Search, Shield, Sparkles, Users, WifiOff } from 'lucide-react';
import { Badge } from '@/components/ui/badge';
import { Card, CardContent } from '@/components/ui/card';
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

function SkillBlock({ label, value }: { label: string; value: string }) {
  const text = value?.trim();
  return (
    <div className="rounded-xl border border-orange-100/80 bg-white/80 px-3 py-2.5 dark:border-blue-950/60 dark:bg-[#0d1117]/60">
      <div className="text-[10px] font-semibold uppercase tracking-wider text-zinc-500 dark:text-zinc-400">
        {label}
      </div>
      {text ? (
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

interface ProfileSummary {
  id: string;
  displayName: string;
  workEmail: string | null;
  personalEmail: string | null;
  department: string | null;
  suspended: boolean;
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

function TeamAvatar({ name, email }: { name: string; email: string | null }) {
  const [failed, setFailed] = useState(false);
  const seed = email ?? name;

  if (email && !failed) {
    return (
      // eslint-disable-next-line @next/next/no-img-element -- internal photo proxy
      <img
        src={`/api/employee-profile-photo?email=${encodeURIComponent(email)}&_fmt=img`}
        alt=""
        width={44}
        height={44}
        className="h-11 w-11 shrink-0 rounded-full object-cover"
        onError={() => setFailed(true)}
      />
    );
  }
  return (
    <div
      aria-hidden
      className={cn(
        'flex h-11 w-11 shrink-0 items-center justify-center rounded-full bg-gradient-to-br text-sm font-bold text-white shadow-sm',
        gradientFor(seed),
      )}
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

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setError(null);
    // Roster = same-department profiles, UNIONed with the department's assigned
    // managers (department_managers), since a manager's own profile department
    // may differ from the team they oversee.
    Promise.all([
      fetch('/api/employee-rate-profiles/summary', { cache: 'no-store' }).then((r) => r.json()),
      deptNorm
        ? fetch(
            `/api/department-managers/by-department?department=${encodeURIComponent(selectedDept)}`,
            { cache: 'no-store' },
          ).then((r) => r.json())
        : Promise.resolve({ emails: [] as string[] }),
    ])
      .then(
        ([summary, mgr]: [
          { profiles?: ProfileSummary[]; error?: string | null },
          { emails?: string[] },
        ]) => {
          if (cancelled) return;
          if (summary.error) setError(summary.error);

          const managerNorms = new Set(
            (mgr.emails ?? [])
              .map((e) => normEmail(e) ?? e.trim().toLowerCase())
              .filter(Boolean),
          );

          const profileIsManager = (p: ProfileSummary): boolean => {
            const w = normEmail(p.workEmail ?? '');
            const pe = normEmail(p.personalEmail ?? '');
            return (!!w && managerNorms.has(w)) || (!!pe && managerNorms.has(pe));
          };

          const rows = (summary.profiles ?? [])
            .filter((p) => !p.suspended)
            .filter((p) => p.workEmail || p.personalEmail)
            // Same-department teammates, plus this department's manager(s). When
            // the viewer has no department on file, fall back to the full roster.
            .filter(
              (p) =>
                !deptNorm ||
                (p.department?.trim().toLowerCase() ?? '') === deptNorm ||
                profileIsManager(p),
            )
            .map<Teammate>((p) => ({
              id: p.id,
              name: p.displayName,
              workEmail: p.workEmail,
              personalEmail: p.personalEmail,
              department: p.department,
              suspended: p.suspended,
              isManager: profileIsManager(p),
            }));
          setTeammates(rows);
        },
      )
      .catch((e) => {
        if (!cancelled) setError(e instanceof Error ? e.message : 'Failed to load your team');
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [deptNorm, selectedDept]);

  // Fetch last-seen timestamps for every teammate whenever the roster changes.
  // Also poll on a slow interval so "Last seen 1m ago" creeps forward without
  // the user reloading the page.
  useEffect(() => {
    if (teammates.length === 0) {
      setLastSeen({});
      return;
    }
    const emails = teammates.flatMap((t) => [
      normEmail(t.workEmail ?? '') ?? '',
      normEmail(t.personalEmail ?? '') ?? '',
    ]).filter(Boolean);
    if (emails.length === 0) return;

    let cancelled = false;
    const fetchLastSeen = () => {
      fetch(`/api/presence/last-seen?emails=${encodeURIComponent(emails.join(','))}`, {
        cache: 'no-store',
      })
        .then((r) => r.json())
        .then((j: { lastSeen?: Record<string, string> }) => {
          if (!cancelled) setLastSeen(j.lastSeen ?? {});
        })
        .catch(() => {
          /* non-fatal — UI just falls back to the dot/pill */
        });
    };
    fetchLastSeen();
    const interval = window.setInterval(fetchLastSeen, 60_000);
    return () => {
      cancelled = true;
      window.clearInterval(interval);
    };
  }, [teammates]);

  // Read-only Skill Sets shared by teammates. Bulk-fetched once per roster so
  // each row can lazy-render an expanded panel without a per-click roundtrip.
  // Keyed by lower-cased work email.
  const [skillSets, setSkillSets] = useState<Record<string, SkillSetEntry>>({});
  const [expanded, setExpanded] = useState<Record<string, boolean>>({});

  useEffect(() => {
    if (teammates.length === 0) {
      setSkillSets({});
      return;
    }
    const emails = teammates
      .map((t) => normEmail(t.workEmail ?? '') ?? '')
      .filter(Boolean);
    if (emails.length === 0) return;
    let cancelled = false;
    fetch(`/api/employee-skill-sets?emails=${encodeURIComponent(emails.join(','))}`, {
      cache: 'no-store',
    })
      .then((r) => (r.ok ? r.json() : { rows: [] }))
      .then((j: { rows?: (SkillSetEntry & { work_email: string })[] }) => {
        if (cancelled) return;
        const map: Record<string, SkillSetEntry> = {};
        for (const row of j.rows ?? []) {
          map[row.work_email] = {
            currently_working_on: row.currently_working_on ?? '',
            skills: row.skills ?? '',
            strengths: row.strengths ?? '',
            member_notes: row.member_notes ?? '',
          };
        }
        setSkillSets(map);
      })
      .catch(() => {
        /* non-fatal */
      });
    return () => {
      cancelled = true;
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

  const toggleExpanded = (id: string) => {
    setExpanded((prev) => ({ ...prev, [id]: !prev[id] }));
  };

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

  return (
    <div className="flex h-full min-h-0 flex-col overflow-y-auto bg-gradient-to-br from-white via-orange-50/30 to-blue-50/20 p-4 sm:p-6 dark:bg-none dark:bg-[#0d1117]">
      <div className="mx-auto w-full max-w-4xl space-y-6">
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
          <div className="flex items-center justify-center gap-2 py-16 text-sm text-zinc-500">
            <Loader2 className="h-4 w-4 animate-spin" />
            Loading your team...
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
          <Card className="overflow-hidden border-orange-100/80 shadow-sm dark:border-blue-950/60">
            <CardContent className="divide-y divide-orange-100/80 p-0 dark:divide-blue-950/60">
              {filtered.map((t) => {
                const online = isOnline(t);
                const self = isSelf(t);
                const email = t.workEmail ?? t.personalEmail;
                const seenRel = online ? null : formatLastSeen(lastSeenFor(t));
                const seenIso = online ? null : lastSeenFor(t);
                const ss = skillSetFor(t);
                const hasSS = hasAnySkillSet(ss);
                const isOpen = !!expanded[t.id];
                return (
                  <div key={t.id}>
                    <div
                      className={cn(
                        'flex items-center gap-4 p-4 transition-colors',
                        hasSS
                          ? 'cursor-pointer hover:bg-orange-50/40 dark:hover:bg-blue-950/20'
                          : 'hover:bg-orange-50/20 dark:hover:bg-blue-950/10',
                      )}
                      onClick={hasSS ? () => toggleExpanded(t.id) : undefined}
                      role={hasSS ? 'button' : undefined}
                      tabIndex={hasSS ? 0 : undefined}
                      aria-expanded={hasSS ? isOpen : undefined}
                      onKeyDown={
                        hasSS
                          ? (e) => {
                              if (e.key === 'Enter' || e.key === ' ') {
                                e.preventDefault();
                                toggleExpanded(t.id);
                              }
                            }
                          : undefined
                      }
                    >
                      <div className="relative shrink-0">
                        <TeamAvatar name={t.name} email={email} />
                        {/* Presence dot on the avatar */}
                        <span
                          className={cn(
                            'absolute -bottom-0.5 -right-0.5 h-3.5 w-3.5 rounded-full ring-2 ring-white dark:ring-[#0d1117]',
                            online ? 'bg-emerald-500' : 'bg-zinc-300 dark:bg-zinc-600',
                          )}
                          aria-hidden
                        />
                      </div>

                      <div className="min-w-0 flex-1">
                        <div className="flex items-center gap-2">
                          <h4 className="truncate text-[0.95rem] font-semibold leading-snug text-zinc-900 dark:text-white">
                            {t.name}
                          </h4>
                          {t.isManager && (
                            <span className="inline-flex shrink-0 items-center gap-1 rounded-md bg-violet-100 px-1.5 py-0.5 text-[10px] font-semibold uppercase tracking-wide text-violet-700 dark:bg-violet-950/50 dark:text-violet-300">
                              <Shield className="h-2.5 w-2.5" />
                              Manager
                            </span>
                          )}
                          {self && (
                            <span className="shrink-0 rounded-md bg-orange-100 px-1.5 py-0.5 text-[10px] font-semibold uppercase tracking-wide text-orange-700 dark:bg-blue-950/50 dark:text-orange-300">
                              You
                            </span>
                          )}
                          {hasSS && (
                            <span
                              className="inline-flex shrink-0 items-center gap-1 rounded-md bg-sky-100 px-1.5 py-0.5 text-[10px] font-semibold uppercase tracking-wide text-sky-700 dark:bg-sky-950/50 dark:text-sky-300"
                              title="Shared a skill set"
                            >
                              <Sparkles className="h-2.5 w-2.5" />
                              Skills
                            </span>
                          )}
                        </div>
                        <p className="truncate text-sm text-zinc-500 dark:text-zinc-400">
                          {email ?? 'No email on file'}
                        </p>
                        {!online && seenRel && (
                          <p
                            className="mt-0.5 truncate text-xs text-zinc-400 dark:text-zinc-500"
                            title={seenIso ? new Date(seenIso).toLocaleString() : undefined}
                          >
                            Last seen {seenRel}
                          </p>
                        )}
                      </div>

                      {/* Status pill */}
                      <span
                        className={cn(
                          'inline-flex shrink-0 items-center gap-1.5 rounded-full px-2.5 py-1 text-xs font-medium',
                          online
                            ? 'bg-emerald-50 text-emerald-700 dark:bg-emerald-500/10 dark:text-emerald-300'
                            : 'bg-zinc-100 text-zinc-500 dark:bg-zinc-800/60 dark:text-zinc-400',
                        )}
                        title={!online && seenIso ? new Date(seenIso).toLocaleString() : undefined}
                      >
                        <span
                          className={cn(
                            'h-1.5 w-1.5 rounded-full',
                            online ? 'bg-emerald-500' : 'bg-zinc-400 dark:bg-zinc-500',
                          )}
                        />
                        {online ? 'Online' : seenRel ? seenRel : 'Offline'}
                      </span>

                      {hasSS && (
                        <ChevronRight
                          className={cn(
                            'h-4 w-4 shrink-0 text-zinc-400 transition-transform dark:text-zinc-600',
                            isOpen && 'rotate-90 text-orange-500 dark:text-orange-400',
                          )}
                          aria-hidden
                        />
                      )}
                    </div>

                    {hasSS && isOpen && ss && (
                      <div className="border-t border-orange-100/80 bg-gradient-to-br from-orange-50/40 via-white to-sky-50/30 px-4 py-4 dark:border-blue-950/60 dark:from-blue-950/30 dark:via-[#0d1117] dark:to-blue-950/20 sm:px-6">
                        <div className="grid gap-3 sm:grid-cols-2">
                          <SkillBlock label="Currently Working On" value={ss.currently_working_on} />
                          <SkillBlock label="Skills" value={ss.skills} />
                          <SkillBlock label="Strengths" value={ss.strengths} />
                          <SkillBlock label="Member Notes" value={ss.member_notes} />
                        </div>
                      </div>
                    )}
                  </div>
                );
              })}
            </CardContent>
          </Card>
        )}
      </div>
    </div>
  );
}
