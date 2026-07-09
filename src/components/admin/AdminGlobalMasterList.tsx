'use client';

import { useCallback, useEffect, useMemo, useState } from 'react';
import { toast } from 'sonner';
import {
  Building2,
  Calendar,
  ChevronLeft,
  ChevronRight,
  Clock,
  Eye,
  IdCard,
  Loader2,
  LogOut,
  Mail,
  MapPin,
  MessageCircle,
  MonitorPlay,
  Radio,
  RefreshCw,
  Search,
  Send,
  Sheet,
  Users,
} from 'lucide-react';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { SmoothSelect } from '@/components/ui/smooth-select';
import { cn } from '@/lib/utils';
import { normEmail } from '@/lib/email/norm-email';
import type { EmployeeRow } from '@/lib/supabase/employees';
import EmployeeAvatar from '@/components/employee/EmployeeAvatar';
import { useLiveRefresh } from '@/hooks/useLiveRefresh';
import { formatLastSeen } from '@/components/team/team-ui';
import { dashboardLabelForPathname } from '@/lib/presence/page-label';
import { usePresenceDetails, useSelfEmail, type PresenceDetail } from '@/components/presence/PresenceProvider';
import { useAdminPingSender } from '@/components/presence/GlobalPingListener';
import { useWatchScreen } from '@/components/presence/CobrowseProvider';

const PAGE_SIZE = 10;

type DepartmentFilter = '__all__' | '__unassigned__' | string;
type ViewFilter = 'all' | 'online';

function employeeIdentityEmail(e: EmployeeRow): string {
  return (e.work_email?.trim() || e.personal_email?.trim() || '').trim();
}

function initialsFromEmployee(e: EmployeeRow): string {
  const base = (e.name?.trim() || e.work_email || e.personal_email || '?').replace(/\s+/g, ' ');
  const parts = base.split(' ').filter(Boolean);
  if (parts.length >= 2) return (parts[0]![0]! + parts[1]![0]!).toUpperCase().slice(0, 2);
  return base.slice(0, 2).toUpperCase();
}

function fmtDate(iso: string | null | undefined): string {
  if (!iso) return '—';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  return d.toLocaleDateString('en-US', { year: 'numeric', month: 'short', day: 'numeric' });
}

function tenure(iso: string | null | undefined): string {
  if (!iso) return '—';
  const start = new Date(iso);
  if (Number.isNaN(start.getTime())) return '—';
  const now = new Date();
  let years = now.getFullYear() - start.getFullYear();
  let months = now.getMonth() - start.getMonth();
  if (months < 0) {
    years -= 1;
    months += 12;
  }
  if (years > 0 && months > 0) return `${years}y ${months}m`;
  if (years > 0) return `${years}y`;
  if (months > 0) return `${months}mo`;
  const days = Math.floor((now.getTime() - start.getTime()) / 86_400_000);
  return days <= 0 ? 'New' : `${days}d`;
}

/** Presence status label. Online → "HR Dashboard · Onboarding"; otherwise last-seen. */
function statusLabel(detail: PresenceDetail | null, lastSeenIso: string | null): string {
  if (detail) {
    return dashboardLabelForPathname(detail.path) + (detail.tab ? ` · ${detail.tab}` : '');
  }
  if (lastSeenIso) return `Last seen ${formatLastSeen(lastSeenIso) ?? '—'}`;
  return 'Offline';
}

/** One labelled read-only field in the detail record grid. */
function Field({
  icon: Icon,
  label,
  value,
  mono,
}: {
  icon: typeof Mail;
  label: string;
  value: string | null | undefined;
  mono?: boolean;
}) {
  const shown = value && value.trim() ? value : '—';
  return (
    <div className="min-w-0 rounded-xl border border-zinc-200/90 bg-white/70 px-3 py-2 dark:border-zinc-800 dark:bg-zinc-900/40">
      <p className="flex items-center gap-1.5 text-[10px] font-semibold uppercase tracking-wide text-zinc-500 dark:text-zinc-500">
        <Icon className="h-3 w-3" aria-hidden />
        {label}
      </p>
      <p
        className={cn(
          'mt-0.5 truncate text-[13px] text-zinc-900 dark:text-zinc-100',
          mono && 'font-mono text-[12px]',
          shown === '—' && 'text-zinc-400 dark:text-zinc-600',
        )}
        title={shown === '—' ? undefined : shown}
      >
        {shown}
      </p>
    </div>
  );
}

export default function AdminGlobalMasterList() {
  const [roster, setRoster] = useState<EmployeeRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [syncing, setSyncing] = useState(false);
  const [search, setSearch] = useState('');
  const [departmentFilter, setDepartmentFilter] = useState<DepartmentFilter>('__all__');
  const [viewFilter, setViewFilter] = useState<ViewFilter>('all');
  const [page, setPage] = useState(1);
  const [selectedKey, setSelectedKey] = useState<string | null>(null);
  const [lastSeen, setLastSeen] = useState<Record<string, string>>({});
  const [pingText, setPingText] = useState('');
  const [pingSending, setPingSending] = useState(false);
  const [forcingLogout, setForcingLogout] = useState(false);

  const viewerEmail = useSelfEmail();
  const viewerNorm = viewerEmail ? normEmail(viewerEmail) ?? viewerEmail.trim().toLowerCase() : null;
  const presenceDetails = usePresenceDetails();
  const sendPing = useAdminPingSender();
  const { observe, observedEmail: watchingEmail } = useWatchScreen();

  const fetchRoster = useCallback(async () => {
    try {
      const res = await fetch('/api/employees', { cache: 'no-store' });
      const json = (await res.json()) as { employees?: EmployeeRow[]; error?: string };
      if (json.error) throw new Error(json.error);
      setRoster(Array.isArray(json.employees) ? json.employees : []);
    } catch (e) {
      toast.error(e instanceof Error ? e.message : 'Failed to load the master list');
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void fetchRoster();
  }, [fetchRoster]);

  useLiveRefresh({
    tables: ['global_master_list'],
    channel: 'admin-global-master-list',
    onRefresh: () => void fetchRoster(),
  });

  const handleSync = useCallback(async () => {
    setSyncing(true);
    try {
      const res = await fetch('/api/cron/sync-master-from-sheet', { method: 'POST' });
      const json = (await res.json()) as {
        success?: boolean;
        error?: string;
        inserted?: number;
        updated?: number;
        activeCount?: number | null;
      };
      if (!res.ok || !json.success) throw new Error(json.error || 'Sync failed');
      const parts: string[] = [];
      if (typeof json.inserted === 'number') parts.push(`${json.inserted} added`);
      if (typeof json.updated === 'number') parts.push(`${json.updated} updated`);
      if (typeof json.activeCount === 'number') parts.push(`${json.activeCount} active`);
      toast.success(`Synced from Google Sheet${parts.length ? ` · ${parts.join(' · ')}` : ''}`);
      await fetchRoster();
    } catch (e) {
      toast.error(e instanceof Error ? e.message : 'Sync failed');
    } finally {
      setSyncing(false);
    }
  }, [fetchRoster]);

  const emailKeyFor = useCallback(
    (row: EmployeeRow): string => normEmail(employeeIdentityEmail(row)) ?? '',
    [],
  );

  const detailFor = useCallback(
    (row: EmployeeRow): PresenceDetail | null => {
      const w = normEmail(row.work_email ?? '');
      const p = normEmail(row.personal_email ?? '');
      return (w && presenceDetails.get(w)) || (p && presenceDetails.get(p)) || null;
    },
    [presenceDetails],
  );

  const lastSeenFor = useCallback(
    (row: EmployeeRow): string | null => {
      const w = row.work_email ? normEmail(row.work_email) : null;
      const p = row.personal_email ? normEmail(row.personal_email) : null;
      return (w && lastSeen[w]) || (p && lastSeen[p]) || null;
    },
    [lastSeen],
  );

  const departmentOptions = useMemo(() => {
    const set = new Set<string>();
    for (const r of roster) {
      const d = (r.department ?? '').trim();
      if (d) set.add(d);
    }
    return [...set].sort((a, b) => a.localeCompare(b, undefined, { sensitivity: 'base' }));
  }, [roster]);

  // Admin/workspace accounts that are ONLINE but not on the payroll roster
  // (e.g. kaner@simple.biz) have no `/api/employees` row, so they'd never show
  // up here. Surface them as synthetic rows — this is an admin oversight tool,
  // so "who's online" must include people the master list doesn't track.
  const rosterEmailSet = useMemo(() => {
    const s = new Set<string>();
    for (const r of roster) {
      const w = normEmail(r.work_email ?? '');
      const p = normEmail(r.personal_email ?? '');
      if (w) s.add(w);
      if (p) s.add(p);
    }
    return s;
  }, [roster]);

  const extraOnlineRows = useMemo(() => {
    const rows: EmployeeRow[] = [];
    for (const [email, detail] of presenceDetails) {
      if (!email || rosterEmailSet.has(email)) continue;
      rows.push({
        employee_id: null,
        department: null,
        name: detail.name || email,
        personal_email: null,
        work_email: email,
        start_date: null,
      } as EmployeeRow);
    }
    return rows.sort((a, b) => (a.name ?? '').localeCompare(b.name ?? ''));
  }, [presenceDetails, rosterEmailSet]);

  const extraOnlineKeySet = useMemo(
    () => new Set(extraOnlineRows.map((r) => emailKeyFor(r))),
    [extraOnlineRows, emailKeyFor],
  );

  // The list the UI works over: online-but-unlisted accounts first, then roster.
  const fullRoster = useMemo(() => [...extraOnlineRows, ...roster], [extraOnlineRows, roster]);

  const onlineCount = useMemo(() => fullRoster.filter((r) => !!detailFor(r)).length, [fullRoster, detailFor]);

  const filtered = useMemo(() => {
    const q = search.trim().toLowerCase();
    return fullRoster.filter((r) => {
      if (viewFilter === 'online' && !detailFor(r)) return false;
      if (departmentFilter !== '__all__') {
        const dep = (r.department ?? '').trim();
        if (departmentFilter === '__unassigned__' ? dep !== '' : dep !== departmentFilter) return false;
      }
      if (!q) return true;
      return [r.name, r.work_email, r.personal_email, r.department, r.employee_id]
        .filter(Boolean)
        .some((s) => s!.toLowerCase().includes(q));
    });
  }, [fullRoster, search, departmentFilter, viewFilter, detailFor]);

  useEffect(() => {
    setPage(1);
  }, [search, departmentFilter, viewFilter]);

  const totalPages = Math.max(1, Math.ceil(filtered.length / PAGE_SIZE));
  const currentPage = Math.min(page, totalPages);
  const pageStart = (currentPage - 1) * PAGE_SIZE;
  const pageRows = filtered.slice(pageStart, pageStart + PAGE_SIZE);

  const selected = useMemo(
    () => fullRoster.find((r) => emailKeyFor(r) === selectedKey) ?? null,
    [fullRoster, selectedKey, emailKeyFor],
  );

  // Auto-select the first visible person on first load so the detail pane isn't
  // empty (matches how a directory naturally opens on something).
  useEffect(() => {
    if (selectedKey || filtered.length === 0) return;
    setSelectedKey(emailKeyFor(filtered[0]!));
  }, [selectedKey, filtered, emailKeyFor]);

  // Last-seen is only meaningful for offline rows, and only for what's on screen
  // (the visible page + whoever is selected) — fetching the whole ~1000-row
  // roster would blow past the endpoint's 500-email cap for no benefit.
  const lastSeenEmailKey = useMemo(() => {
    const rows = selected ? [...pageRows, selected] : pageRows;
    return Array.from(
      new Set(rows.flatMap((r) => [r.work_email, r.personal_email]).filter((e): e is string => !!e)),
    ).join(',');
  }, [pageRows, selected]);

  useEffect(() => {
    if (!lastSeenEmailKey) return;
    let cancelled = false;
    fetch(`/api/presence/last-seen?emails=${encodeURIComponent(lastSeenEmailKey)}`, { cache: 'no-store' })
      .then((res) => res.json())
      .then((json: { lastSeen?: Record<string, string> }) => {
        if (!cancelled) setLastSeen(json.lastSeen ?? {});
      })
      .catch(() => {
        /* non-fatal — status falls back to "Offline" */
      });
    return () => {
      cancelled = true;
    };
  }, [lastSeenEmailKey]);

  const selectedDetail = selected ? detailFor(selected) : null;
  const selectedOnline = !!selectedDetail;
  const selectedIsSelf = !!selected && !!viewerNorm && emailKeyFor(selected) === viewerNorm;
  const selectedEmail = selected ? employeeIdentityEmail(selected) || null : null;
  const selectedIsExtra = !!selected && extraOnlineKeySet.has(emailKeyFor(selected));

  const forceLogoutSelected = useCallback(async () => {
    if (!selectedEmail) return;
    setForcingLogout(true);
    try {
      const res = await fetch('/api/auth/force-logout', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ email: selectedEmail, reason: 'manual session reset — Global Master List' }),
      });
      const json = (await res.json()) as { success?: boolean; error?: string; skipped?: string };
      if (!res.ok || !json.success) {
        toast.error(json.error || 'Failed to reset session');
        return;
      }
      if (json.skipped === 'self') {
        toast.info("That's your own account — your session was left intact.");
        return;
      }
      toast.success('Session reset — they will be signed out momentarily.');
    } catch (e) {
      toast.error(e instanceof Error ? e.message : 'Failed to reset session');
    } finally {
      setForcingLogout(false);
    }
  }, [selectedEmail]);

  const handleSendPing = useCallback(() => {
    if (!selectedEmail) return;
    const text = pingText.trim() || '👋 Hi';
    setPingSending(true);
    sendPing(selectedEmail, text);
    setTimeout(() => setPingSending(false), 300);
    setPingText('');
    toast.success(
      selectedOnline
        ? 'Pinged — it just landed on their screen.'
        : "Pinged — but they're offline, so it may not have been received.",
    );
  }, [selectedEmail, pingText, sendPing, selectedOnline]);

  // Clear the composer when switching people.
  useEffect(() => {
    setPingText('');
  }, [selectedKey]);

  if (loading) {
    return (
      <div className="flex h-full min-h-0 flex-1 items-center justify-center bg-gradient-to-b from-zinc-50/80 to-transparent dark:from-zinc-950/50">
        <Loader2 className="h-6 w-6 animate-spin text-zinc-400" />
      </div>
    );
  }

  const alternateEmails = [selected?.alternate_work_email, selected?.alternate_work_email_2]
    .map((e) => e?.trim())
    .filter(Boolean)
    .join(', ');
  const location = [selected?.city, selected?.province].map((s) => s?.trim()).filter(Boolean).join(', ') ||
    selected?.full_address?.trim() ||
    '';

  return (
    <div className="flex h-full min-h-0 flex-col gap-4 overflow-hidden bg-gradient-to-b from-zinc-50/80 to-transparent p-4 sm:p-6 dark:from-zinc-950/50">
      <header className="shrink-0 space-y-3">
        <div className="flex flex-col gap-3 sm:flex-row sm:items-end sm:justify-between">
          <div className="space-y-1">
            <h1 className="flex items-center gap-2.5 text-2xl font-semibold tracking-tight text-zinc-900 dark:text-white">
              <span className="flex h-10 w-10 items-center justify-center rounded-xl bg-orange-500/15 ring-1 ring-orange-500/25">
                <Sheet className="h-5 w-5 text-orange-600 dark:text-orange-400" aria-hidden />
              </span>
              Global Master List
            </h1>
            <p className="max-w-xl text-sm leading-relaxed text-zinc-600 dark:text-zinc-400">
              The synced roster, with who&apos;s online, which page they&apos;re on, and the tools to reach or reset them.
            </p>
          </div>
          <div className="flex flex-wrap gap-2">
            <div className="flex items-center gap-2 rounded-xl border border-zinc-200/90 bg-white/90 px-3 py-2 shadow-sm dark:border-zinc-800 dark:bg-zinc-900/60">
              <Users className="h-4 w-4 text-zinc-400" aria-hidden />
              <div>
                <p className="text-[10px] font-semibold uppercase tracking-wide text-zinc-500">Roster</p>
                <p className="font-mono text-sm font-semibold tabular-nums text-zinc-900 dark:text-zinc-100">
                  {roster.length}
                </p>
              </div>
            </div>
            <div className="flex items-center gap-2 rounded-xl border border-zinc-200/90 bg-white/90 px-3 py-2 shadow-sm dark:border-zinc-800 dark:bg-zinc-900/60">
              <Radio className="h-4 w-4 text-emerald-500" aria-hidden />
              <div>
                <p className="text-[10px] font-semibold uppercase tracking-wide text-zinc-500">Online now</p>
                <p className="font-mono text-sm font-semibold tabular-nums text-zinc-900 dark:text-zinc-100">
                  {onlineCount}
                </p>
              </div>
            </div>
            <div className="flex items-center gap-2 rounded-xl border border-zinc-200/90 bg-white/90 px-3 py-2 shadow-sm dark:border-zinc-800 dark:bg-zinc-900/60">
              <Building2 className="h-4 w-4 text-zinc-400" aria-hidden />
              <div>
                <p className="text-[10px] font-semibold uppercase tracking-wide text-zinc-500">Departments</p>
                <p className="font-mono text-sm font-semibold tabular-nums text-zinc-900 dark:text-zinc-100">
                  {departmentOptions.length}
                </p>
              </div>
            </div>
          </div>
        </div>
      </header>

      <div className="grid min-h-0 flex-1 grid-cols-1 gap-4 lg:grid-cols-[minmax(0,1fr)_minmax(0,1.15fr)]">
        {/* LEFT — roster list */}
        <Card className="flex h-full min-h-0 flex-col overflow-hidden border-zinc-200/90 shadow-sm dark:border-zinc-800/80">
          <CardHeader className="shrink-0 space-y-3 border-b border-zinc-100 pb-4 dark:border-zinc-800/80">
            <div className="flex flex-wrap items-center justify-between gap-2">
              <div className="flex items-center gap-2">
                <CardTitle className="text-base font-semibold text-zinc-900 dark:text-white">Roster</CardTitle>
                <Badge variant="outline" className="font-mono text-[10px] text-zinc-600 dark:text-zinc-400">
                  {filtered.length} shown
                </Badge>
                <div
                  role="tablist"
                  aria-label="Roster view"
                  className="ml-1 inline-flex items-center rounded-md border border-zinc-200 bg-white p-0.5 dark:border-zinc-800 dark:bg-zinc-900"
                >
                  {(['all', 'online'] as const).map((mode) => {
                    const active = viewFilter === mode;
                    const label = mode === 'all' ? 'All' : 'Online';
                    const count = mode === 'all' ? roster.length : onlineCount;
                    return (
                      <button
                        key={mode}
                        type="button"
                        role="tab"
                        aria-selected={active}
                        onClick={() => setViewFilter(mode)}
                        className={cn(
                          'inline-flex items-center gap-1.5 rounded px-2 py-1 text-[11px] font-medium transition-colors',
                          active
                            ? 'bg-zinc-900 text-white shadow-sm dark:bg-zinc-100 dark:text-zinc-900'
                            : 'text-zinc-600 hover:text-zinc-900 dark:text-zinc-400 dark:hover:text-zinc-100',
                        )}
                      >
                        {label}
                        <span
                          className={cn(
                            'inline-flex min-w-[1.25rem] items-center justify-center rounded-full px-1 py-px font-mono text-[9.5px] font-semibold tabular-nums',
                            active
                              ? 'bg-white/20 text-white dark:bg-zinc-900/20 dark:text-zinc-900'
                              : 'bg-zinc-100 text-zinc-700 dark:bg-zinc-800 dark:text-zinc-300',
                          )}
                        >
                          {count}
                        </span>
                      </button>
                    );
                  })}
                </div>
              </div>
              <Button
                type="button"
                variant="outline"
                size="sm"
                onClick={() => void handleSync()}
                disabled={syncing}
                className="h-8 gap-1.5 border-zinc-200 text-xs text-zinc-700 dark:border-zinc-700 dark:text-zinc-200"
              >
                {syncing ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <RefreshCw className="h-3.5 w-3.5" />}
                Sync
              </Button>
            </div>
            <div className="flex flex-col gap-2 sm:flex-row sm:items-center">
              <div className="relative min-w-0 flex-1">
                <Search className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-zinc-400" />
                <Input
                  value={search}
                  onChange={(e) => setSearch(e.target.value)}
                  placeholder="Search name, email, ID…"
                  className="h-9 rounded-lg border-zinc-200 bg-white pl-9 dark:border-zinc-800 dark:bg-zinc-950/50"
                />
              </div>
              <SmoothSelect
                aria-label="Filter by department"
                value={departmentFilter}
                onChange={(v) => setDepartmentFilter(v)}
                triggerClassName="h-9 min-w-[9.5rem] shrink-0"
                options={[
                  { value: '__all__', label: 'All departments' },
                  { value: '__unassigned__', label: 'Unassigned' },
                  ...departmentOptions.map((dep) => ({ value: dep, label: dep })),
                ]}
              />
              <div className="flex shrink-0 items-center justify-center gap-1 rounded-lg border border-zinc-200 bg-zinc-50/80 p-0.5 dark:border-zinc-800 dark:bg-zinc-900/40">
                <Button
                  type="button"
                  variant="ghost"
                  size="sm"
                  className="h-8 px-2"
                  disabled={currentPage <= 1}
                  onClick={() => setPage((p) => Math.max(1, p - 1))}
                  aria-label="Previous page"
                >
                  <ChevronLeft className="size-4" />
                </Button>
                <span className="min-w-[3.5rem] text-center font-mono text-xs text-zinc-600 dark:text-zinc-400">
                  {currentPage}/{totalPages}
                </span>
                <Button
                  type="button"
                  variant="ghost"
                  size="sm"
                  className="h-8 px-2"
                  disabled={currentPage >= totalPages}
                  onClick={() => setPage((p) => Math.min(totalPages, p + 1))}
                  aria-label="Next page"
                >
                  <ChevronRight className="size-4" />
                </Button>
              </div>
            </div>
          </CardHeader>
          <CardContent className="min-h-0 flex-1 overflow-y-auto px-3 pb-4 pt-2 sm:px-4">
            {pageRows.length === 0 ? (
              <p className="py-10 text-center text-xs text-zinc-400">
                {roster.length === 0 ? 'No active employees on record.' : 'No rows match your search.'}
              </p>
            ) : (
              <ul className="space-y-1.5" role="list">
                {pageRows.map((row, i) => {
                  const key = emailKeyFor(row);
                  const isSel = key === selectedKey;
                  const detail = detailFor(row);
                  const online = !!detail;
                  const email = employeeIdentityEmail(row) || null;
                  const isExtra = extraOnlineKeySet.has(key);
                  return (
                    <li key={`${key || row.employee_id || row.name}-${pageStart + i}`}>
                      <button
                        type="button"
                        onClick={() => setSelectedKey(key)}
                        className={cn(
                          'flex w-full items-center gap-3 rounded-xl border px-3 py-2.5 text-left transition-all',
                          isSel
                            ? 'border-orange-500/55 bg-orange-50/90 shadow-md shadow-orange-500/10 ring-1 ring-orange-500/20 dark:border-orange-500/45 dark:bg-orange-950/35 dark:shadow-none'
                            : 'border-zinc-200/90 bg-white/60 hover:border-zinc-300 hover:bg-white dark:border-zinc-800 dark:bg-zinc-900/40 dark:hover:border-zinc-700 dark:hover:bg-zinc-900/70',
                        )}
                      >
                        <div
                          className={cn(
                            'relative shrink-0 rounded-xl ring-2',
                            isSel
                              ? 'ring-orange-400/70 dark:ring-orange-500/55'
                              : online
                                ? 'ring-emerald-400/70 dark:ring-emerald-500/45'
                                : 'ring-zinc-200/70 dark:ring-zinc-800',
                          )}
                        >
                          <EmployeeAvatar
                            photoUrl={row.profile_photo_url ?? null}
                            googlePhotoUrl={row.google_photo_url ?? null}
                            email={email}
                            initials={initialsFromEmployee(row)}
                            className="!rounded-xl h-10 w-10 text-xs"
                          />
                          <span
                            className={cn(
                              'absolute -bottom-0.5 -right-0.5 h-3 w-3 rounded-full ring-2 ring-white dark:ring-zinc-950',
                              online ? 'bg-emerald-500' : 'bg-zinc-300 dark:bg-zinc-600',
                            )}
                            aria-hidden
                          />
                        </div>
                        <div className="min-w-0 flex-1">
                          <p className="flex items-center gap-1.5 truncate text-sm font-semibold text-zinc-900 dark:text-white">
                            <span className="truncate">{row.name || email || '—'}</span>
                            {isExtra && (
                              <span
                                className="shrink-0 rounded-md border border-sky-300/80 bg-sky-50 px-1.5 py-px text-[9px] font-bold uppercase tracking-wider text-sky-700 dark:border-sky-700/60 dark:bg-sky-950/40 dark:text-sky-300"
                                title="Online, but not on the master list (e.g. an admin / workspace account)"
                              >
                                Off-roster
                              </span>
                            )}
                          </p>
                          <p className="truncate font-mono text-[11px] text-zinc-500 dark:text-zinc-400">
                            {email ?? 'No email'}
                          </p>
                          {online ? (
                            <p className="mt-0.5 flex items-center gap-1 truncate text-[10.5px] font-medium text-emerald-600 dark:text-emerald-400">
                              <span className="inline-block h-1.5 w-1.5 shrink-0 rounded-full bg-emerald-500" aria-hidden />
                              {statusLabel(detail, null)}
                            </p>
                          ) : (
                            row.department && (
                              <p className="mt-0.5 truncate text-[10px] text-zinc-400 dark:text-zinc-500">
                                {row.department}
                              </p>
                            )
                          )}
                        </div>
                      </button>
                    </li>
                  );
                })}
              </ul>
            )}
          </CardContent>
        </Card>

        {/* RIGHT — selected person's record + admin functions */}
        <Card className="flex h-full min-h-0 flex-col overflow-hidden border-zinc-200/90 shadow-sm dark:border-zinc-800/80">
          <CardHeader className="shrink-0 border-b border-zinc-100 pb-4 dark:border-zinc-800/80">
            <CardTitle className="flex items-center gap-2 text-base font-semibold text-zinc-900 dark:text-white">
              <span className="flex h-8 w-8 items-center justify-center rounded-lg bg-zinc-100 dark:bg-zinc-800">
                <IdCard className="h-4 w-4 text-orange-600 dark:text-orange-400" aria-hidden />
              </span>
              {selected ? 'Master list record' : 'Choose someone'}
            </CardTitle>
            {selected && (
              <div className="flex flex-wrap items-center gap-2 pt-2">
                <div className="flex min-w-0 flex-1 items-center gap-2 rounded-xl border border-zinc-200/90 bg-zinc-50/80 px-3 py-2 dark:border-zinc-800 dark:bg-zinc-900/50">
                  <div
                    className={cn(
                      'relative shrink-0 rounded-lg ring-1',
                      selectedOnline ? 'ring-emerald-400/70 dark:ring-emerald-500/45' : 'ring-zinc-200/70 dark:ring-zinc-800',
                    )}
                  >
                    <EmployeeAvatar
                      photoUrl={selected.profile_photo_url ?? null}
                      googlePhotoUrl={selected.google_photo_url ?? null}
                      email={selectedEmail}
                      initials={initialsFromEmployee(selected)}
                      className="rounded-lg h-9 w-9 text-xs"
                    />
                    <span
                      className={cn(
                        'absolute -bottom-0.5 -right-0.5 h-2.5 w-2.5 rounded-full ring-2 ring-white dark:ring-zinc-950',
                        selectedOnline ? 'bg-emerald-500' : 'bg-zinc-300 dark:bg-zinc-600',
                      )}
                      aria-hidden
                    />
                  </div>
                  <div className="min-w-0">
                    <p className="truncate text-sm font-semibold text-zinc-900 dark:text-white">
                      {selected.name || selectedEmail || '—'}
                    </p>
                    <p className="truncate font-mono text-[11px] text-zinc-500">{selectedEmail || 'No email on file'}</p>
                  </div>
                </div>
                {selectedIsExtra && (
                  <Badge
                    variant="outline"
                    className="shrink-0 border-sky-300/80 bg-sky-50 text-[10px] text-sky-700 dark:border-sky-700/60 dark:bg-sky-950/40 dark:text-sky-300"
                    title="Online, but not on the master list (e.g. an admin / workspace account)"
                  >
                    Off-roster
                  </Badge>
                )}
                {selectedIsSelf && (
                  <Badge variant="outline" className="shrink-0 text-[10px] text-zinc-500">
                    You
                  </Badge>
                )}
              </div>
            )}
          </CardHeader>
          <CardContent className="min-h-0 flex-1 overflow-y-auto px-3 pb-4 pt-3 sm:px-4">
            {!selected ? (
              <div className="flex h-full min-h-[240px] flex-col items-center justify-center gap-3 rounded-xl border border-dashed border-zinc-200 bg-zinc-50/50 px-6 py-10 text-center dark:border-zinc-800 dark:bg-zinc-900/30">
                <Users className="h-10 w-10 text-zinc-300 dark:text-zinc-600" aria-hidden />
                <div className="space-y-1">
                  <p className="text-sm font-medium text-zinc-700 dark:text-zinc-300">Select a person</p>
                  <p className="max-w-xs text-xs text-zinc-500 dark:text-zinc-500">
                    Pick someone from the roster to see their master-list record, whether they&apos;re
                    online and which page they&apos;re on, and to ping or reset their session.
                  </p>
                </div>
              </div>
            ) : (
              <div className="space-y-5">
                {/* Live status */}
                <section
                  className={cn(
                    'rounded-xl border px-3.5 py-3',
                    selectedOnline
                      ? 'border-emerald-300/70 bg-emerald-50/70 dark:border-emerald-800/50 dark:bg-emerald-950/20'
                      : 'border-zinc-200/90 bg-zinc-50/70 dark:border-zinc-800 dark:bg-zinc-900/40',
                  )}
                >
                  <div className="flex items-center justify-between gap-2">
                    <p className="flex items-center gap-1.5 text-[10px] font-semibold uppercase tracking-wide text-zinc-500 dark:text-zinc-500">
                      <Radio className="h-3 w-3" aria-hidden />
                      Live status
                    </p>
                    <span
                      className={cn(
                        'inline-flex items-center gap-1.5 rounded-full px-2 py-0.5 text-[10px] font-semibold',
                        selectedOnline
                          ? 'bg-emerald-500/15 text-emerald-700 dark:text-emerald-300'
                          : 'bg-zinc-200/70 text-zinc-600 dark:bg-zinc-800 dark:text-zinc-400',
                      )}
                    >
                      <span
                        className={cn(
                          'h-1.5 w-1.5 rounded-full',
                          selectedOnline ? 'animate-pulse bg-emerald-500' : 'bg-zinc-400 dark:bg-zinc-500',
                        )}
                        aria-hidden
                      />
                      {selectedOnline ? 'Online' : 'Offline'}
                    </span>
                  </div>
                  {selectedOnline ? (
                    <div className="mt-1.5 flex items-baseline gap-2">
                      <p className="min-w-0 truncate text-[15px] font-semibold text-zinc-900 dark:text-white">
                        {dashboardLabelForPathname(selectedDetail!.path)}
                      </p>
                      {selectedDetail!.tab && (
                        <span className="inline-flex shrink-0 items-center gap-1 rounded-md bg-white/70 px-1.5 py-0.5 font-mono text-[11px] font-medium text-emerald-700 ring-1 ring-emerald-300/60 dark:bg-zinc-900/60 dark:text-emerald-300 dark:ring-emerald-800/50">
                          {selectedDetail!.tab}
                        </span>
                      )}
                    </div>
                  ) : (
                    <p className="mt-1.5 text-[13px] text-zinc-600 dark:text-zinc-400">
                      {statusLabel(null, lastSeenFor(selected))}
                    </p>
                  )}
                </section>

                {/* Admin functions */}
                <section className="space-y-2">
                  <h3 className="border-b border-zinc-100 pb-1 text-xs font-bold uppercase tracking-wide text-zinc-800 dark:border-zinc-800/80 dark:text-zinc-200">
                    Admin functions
                  </h3>
                  {selectedIsSelf ? (
                    <p className="rounded-lg border border-zinc-200/90 bg-zinc-50/70 px-3 py-2.5 text-[12px] text-zinc-500 dark:border-zinc-800 dark:bg-zinc-900/40">
                      This is your own account — ping and session-reset are disabled for yourself.
                    </p>
                  ) : (
                    <>
                      {/* Ping */}
                      <form
                        onSubmit={(e) => {
                          e.preventDefault();
                          handleSendPing();
                        }}
                        className="flex items-center gap-2 rounded-xl border border-orange-200/80 bg-orange-50/50 p-2 dark:border-orange-700/40 dark:bg-orange-950/20"
                      >
                        <MessageCircle className="ml-1 h-4 w-4 shrink-0 text-orange-500 dark:text-orange-400" aria-hidden />
                        <Input
                          value={pingText}
                          onChange={(e) => setPingText(e.target.value)}
                          placeholder={`Message ${selected.name?.split(' ')[0] || 'them'}…`}
                          className="h-8 flex-1 border-orange-200 bg-white text-xs dark:border-orange-800/50 dark:bg-zinc-950"
                        />
                        <Button
                          type="submit"
                          size="sm"
                          disabled={pingSending}
                          className="h-8 gap-1.5 bg-orange-600 px-3 text-xs text-white hover:bg-orange-500 disabled:opacity-50 dark:bg-orange-600 dark:hover:bg-orange-500"
                        >
                          {pingSending ? <Loader2 className="h-3 w-3 animate-spin" /> : <Send className="h-3 w-3" />}
                          Ping
                        </Button>
                      </form>
                      <p className="px-1 text-[10.5px] text-zinc-400 dark:text-zinc-600">
                        A ping pops up on their screen wherever they are — but only if they&apos;re online right now (nothing is saved).
                      </p>

                      {/* Watch screen (live co-browse) */}
                      {watchingEmail && watchingEmail === emailKeyFor(selected) ? (
                        <Button
                          type="button"
                          onClick={() => observe(null)}
                          className="w-full justify-center gap-2 bg-orange-600 text-white hover:bg-orange-500"
                          title="Stop mirroring their screen"
                        >
                          <Eye className="h-4 w-4" aria-hidden />
                          Stop watching screen
                        </Button>
                      ) : (
                        <Button
                          type="button"
                          variant="outline"
                          onClick={() =>
                            selectedEmail && observe({ email: selectedEmail, name: selected.name || selectedEmail })
                          }
                          disabled={!selectedOnline || !selectedEmail}
                          className="w-full justify-center gap-2 border-orange-200 text-orange-700 hover:bg-orange-50 disabled:opacity-50 dark:border-orange-800/50 dark:text-orange-300 dark:hover:bg-orange-950/30"
                          title={
                            selectedOnline
                              ? "Live-mirror this person's screen (view-only)"
                              : 'They must be online to mirror their screen'
                          }
                        >
                          <MonitorPlay className="h-4 w-4" aria-hidden />
                          {selectedOnline ? 'Watch screen' : 'Watch screen (offline)'}
                        </Button>
                      )}
                      <p className="px-1 text-[10.5px] text-zinc-400 dark:text-zinc-600">
                        Opens a live, view-only mirror of their screen with a chat window so you can tutor them. They aren&apos;t notified until you send your first message; recording only runs while you watch.
                      </p>

                      {/* Force logout */}
                      <Button
                        type="button"
                        variant="outline"
                        onClick={() => void forceLogoutSelected()}
                        disabled={forcingLogout || !selectedEmail}
                        className="w-full justify-center gap-2 border-zinc-200 text-zinc-700 hover:bg-red-500/10 hover:text-red-600 dark:border-zinc-700 dark:text-zinc-200 dark:hover:text-red-400"
                        title="Invalidate this person's active session — they'll be signed out and bounced to /login, live."
                      >
                        {forcingLogout ? (
                          <Loader2 className="h-4 w-4 animate-spin" aria-hidden />
                        ) : (
                          <LogOut className="h-4 w-4" aria-hidden />
                        )}
                        Force logout / reset session
                      </Button>
                    </>
                  )}
                </section>

                {/* Master list information */}
                <section className="space-y-2">
                  <h3 className="border-b border-zinc-100 pb-1 text-xs font-bold uppercase tracking-wide text-zinc-800 dark:border-zinc-800/80 dark:text-zinc-200">
                    Master list information
                  </h3>
                  <div className="grid grid-cols-1 gap-2 sm:grid-cols-2">
                    <Field icon={IdCard} label="Employee ID" value={selected.employee_id} mono />
                    <Field icon={Building2} label="Department" value={selected.department} />
                    <Field icon={Mail} label="Work email" value={selected.work_email} mono />
                    <Field icon={Mail} label="Personal email" value={selected.personal_email} mono />
                    {alternateEmails && (
                      <Field icon={Mail} label="Alternate emails" value={alternateEmails} mono />
                    )}
                    <Field icon={Calendar} label="Start date" value={fmtDate(selected.start_date)} />
                    <Field icon={Clock} label="Tenure" value={tenure(selected.start_date)} />
                    {location && <Field icon={MapPin} label="Location" value={location} />}
                  </div>
                </section>
              </div>
            )}
          </CardContent>
        </Card>
      </div>
    </div>
  );
}
