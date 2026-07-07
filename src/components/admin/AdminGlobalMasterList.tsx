'use client';

import { memo, useCallback, useEffect, useMemo, useState } from 'react';
import { toast } from 'sonner';
import { motion, AnimatePresence } from 'motion/react';
import {
  Building2,
  ChevronLeft,
  ChevronRight,
  Loader2,
  LogOut,
  MessageCircle,
  Radio,
  RefreshCw,
  Search,
  Send,
  Sheet,
  X,
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

interface RowProps {
  row: EmployeeRow;
  detail: PresenceDetail | null;
  lastSeenIso: string | null;
  isSelf: boolean;
  isPinging: boolean;
  pingText: string;
  pingSending: boolean;
  forcingLogout: boolean;
  onPingTextChange: (v: string) => void;
  onStartPing: () => void;
  onCancelPing: () => void;
  onSendPing: () => void;
  onForceLogout: () => void;
}

const GmlRow = memo(function GmlRow({
  row,
  detail,
  lastSeenIso,
  isSelf,
  isPinging,
  pingText,
  pingSending,
  forcingLogout,
  onPingTextChange,
  onStartPing,
  onCancelPing,
  onSendPing,
  onForceLogout,
}: RowProps) {
  const email = employeeIdentityEmail(row) || null;
  const online = !!detail;
  const statusText = online
    ? dashboardLabelForPathname(detail!.path) + (detail!.tab ? ` · ${detail!.tab}` : '')
    : lastSeenIso
      ? `Last seen ${formatLastSeen(lastSeenIso) ?? '—'}`
      : 'Offline';

  return (
    <li>
      <div
        className={cn(
          'flex flex-col gap-2.5 rounded-xl border px-3 py-2.5 transition-all sm:flex-row sm:items-center sm:gap-3',
          online
            ? 'border-emerald-300/60 bg-emerald-50/40 dark:border-emerald-800/40 dark:bg-emerald-950/10'
            : 'border-zinc-200/90 bg-white/60 dark:border-zinc-800 dark:bg-zinc-900/40',
        )}
      >
        <div className="flex min-w-0 flex-1 items-center gap-3">
          <div
            className={cn(
              'relative shrink-0 rounded-xl ring-2',
              online ? 'ring-emerald-400/70 dark:ring-emerald-500/50' : 'ring-zinc-200/70 dark:ring-zinc-800',
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
            <p className="truncate text-sm font-semibold text-zinc-900 dark:text-white">
              {row.name || email || '—'}
            </p>
            <p className="truncate font-mono text-[11px] text-zinc-500 dark:text-zinc-400">{email ?? 'No email'}</p>
            <p className="mt-0.5 truncate text-[10px] text-zinc-400 dark:text-zinc-500">
              {row.department || '—'} · Since {fmtDate(row.start_date)}
            </p>
          </div>
        </div>

        <div className="flex items-center justify-between gap-2 sm:min-w-0 sm:flex-1 sm:justify-end sm:gap-4">
          <span className="flex min-w-0 items-center gap-1.5 text-[11.5px]" title={statusText}>
            <span
              className={cn('h-1.5 w-1.5 shrink-0 rounded-full', online ? 'bg-emerald-500' : 'bg-zinc-300 dark:bg-zinc-600')}
              aria-hidden
            />
            <span className={cn('truncate', online ? 'font-medium text-emerald-700 dark:text-emerald-400' : 'text-zinc-500 dark:text-zinc-400')}>
              {statusText}
            </span>
          </span>

          {isSelf ? (
            <span className="shrink-0 text-[10.5px] text-zinc-400">You</span>
          ) : (
            <div className="flex shrink-0 items-center gap-1">
              <button
                type="button"
                onClick={onStartPing}
                title="Ping"
                aria-label={`Ping ${row.name ?? email ?? 'this person'}`}
                className="inline-flex h-7 w-7 items-center justify-center rounded-md border border-zinc-200 bg-white text-zinc-500 transition-colors hover:border-orange-300 hover:bg-orange-50 hover:text-orange-700 dark:border-zinc-700 dark:bg-zinc-900 dark:text-zinc-400 dark:hover:bg-zinc-800 dark:hover:text-orange-300"
              >
                <MessageCircle className="h-3.5 w-3.5" />
              </button>
              <button
                type="button"
                onClick={onForceLogout}
                disabled={forcingLogout}
                title="Force logout — invalidate this person's active session"
                aria-label={`Force logout ${row.name ?? email ?? 'this person'}`}
                className="inline-flex h-7 w-7 items-center justify-center rounded-md border border-zinc-200 bg-white text-zinc-500 transition-colors hover:border-zinc-300 hover:bg-zinc-50 hover:text-zinc-900 disabled:opacity-50 dark:border-zinc-700 dark:bg-zinc-900 dark:text-zinc-400 dark:hover:bg-zinc-800"
              >
                {forcingLogout ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <LogOut className="h-3.5 w-3.5" />}
              </button>
            </div>
          )}
        </div>
      </div>

      {/* Ping composer */}
      <AnimatePresence initial={false}>
        {isPinging && (
          <motion.div
            initial={{ height: 0, opacity: 0 }}
            animate={{ height: 'auto', opacity: 1 }}
            exit={{ height: 0, opacity: 0 }}
            transition={{ duration: 0.18 }}
            className="overflow-hidden"
          >
            <form
              onSubmit={(e) => {
                e.preventDefault();
                onSendPing();
              }}
              className="mt-1.5 flex items-center gap-2 rounded-xl border border-orange-200/80 bg-orange-50/60 p-2 dark:border-orange-700/40 dark:bg-orange-950/20"
            >
              <MessageCircle className="h-3.5 w-3.5 shrink-0 text-orange-500 dark:text-orange-400" aria-hidden />
              <Input
                autoFocus
                value={pingText}
                onChange={(e) => onPingTextChange(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === 'Escape') onCancelPing();
                }}
                placeholder={`Message ${row.name?.split(' ')[0] || 'them'}…`}
                className="h-8 flex-1 border-orange-200 bg-white text-xs dark:border-orange-800/50 dark:bg-zinc-950"
              />
              <Button
                type="submit"
                size="sm"
                disabled={pingSending}
                className="h-8 gap-1.5 bg-orange-600 px-3 text-xs text-white hover:bg-orange-500 disabled:opacity-50 dark:bg-orange-600 dark:hover:bg-orange-500"
              >
                {pingSending ? <Loader2 className="h-3 w-3 animate-spin" /> : <Send className="h-3 w-3" />}
                Send
              </Button>
              <button
                type="button"
                onClick={onCancelPing}
                aria-label="Cancel"
                className="inline-flex h-8 w-8 shrink-0 items-center justify-center rounded-md text-zinc-400 hover:bg-white/60 hover:text-zinc-700 dark:hover:bg-zinc-900/60"
              >
                <X className="h-3.5 w-3.5" />
              </button>
            </form>
          </motion.div>
        )}
      </AnimatePresence>
    </li>
  );
});

export default function AdminGlobalMasterList() {
  const [roster, setRoster] = useState<EmployeeRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [syncing, setSyncing] = useState(false);
  const [search, setSearch] = useState('');
  const [departmentFilter, setDepartmentFilter] = useState<DepartmentFilter>('__all__');
  const [viewFilter, setViewFilter] = useState<ViewFilter>('all');
  const [page, setPage] = useState(1);
  const [lastSeen, setLastSeen] = useState<Record<string, string>>({});
  const [pingTarget, setPingTarget] = useState<string | null>(null);
  const [pingText, setPingText] = useState('');
  const [pingSending, setPingSending] = useState(false);
  const [forcingLogoutEmail, setForcingLogoutEmail] = useState<string | null>(null);

  const viewerEmail = useSelfEmail();
  const viewerNorm = viewerEmail ? normEmail(viewerEmail) ?? viewerEmail.trim().toLowerCase() : null;
  const presenceDetails = usePresenceDetails();
  const sendPing = useAdminPingSender();

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

  const detailFor = useCallback(
    (row: EmployeeRow): PresenceDetail | null => {
      const w = normEmail(row.work_email ?? '');
      const p = normEmail(row.personal_email ?? '');
      return (w && presenceDetails.get(w)) || (p && presenceDetails.get(p)) || null;
    },
    [presenceDetails],
  );

  const departmentOptions = useMemo(() => {
    const set = new Set<string>();
    for (const r of roster) {
      const d = (r.department ?? '').trim();
      if (d) set.add(d);
    }
    return [...set].sort((a, b) => a.localeCompare(b, undefined, { sensitivity: 'base' }));
  }, [roster]);

  const onlineCount = useMemo(() => roster.filter((r) => !!detailFor(r)).length, [roster, detailFor]);

  const filtered = useMemo(() => {
    const q = search.trim().toLowerCase();
    return roster.filter((r) => {
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
  }, [roster, search, departmentFilter, viewFilter, detailFor]);

  useEffect(() => {
    setPage(1);
  }, [search, departmentFilter, viewFilter]);

  const totalPages = Math.max(1, Math.ceil(filtered.length / PAGE_SIZE));
  const currentPage = Math.min(page, totalPages);
  const pageStart = (currentPage - 1) * PAGE_SIZE;
  const pageRows = filtered.slice(pageStart, pageStart + PAGE_SIZE);

  // Last-seen is only meaningful for offline rows and only needs to cover the
  // rows currently on screen — fetching it for the whole ~1000-row roster would
  // blow past the endpoint's 500-email cap for no benefit.
  useEffect(() => {
    const emails = pageRows
      .flatMap((r) => [r.work_email, r.personal_email])
      .filter((e): e is string => !!e);
    if (emails.length === 0) return;
    let cancelled = false;
    fetch(`/api/presence/last-seen?emails=${encodeURIComponent(emails.join(','))}`, { cache: 'no-store' })
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
    // Re-key on the visible identities, not the whole `pageRows` array/object identity.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [pageRows.map((r) => r.work_email ?? r.personal_email ?? '').join('|')]);

  const lastSeenFor = useCallback(
    (row: EmployeeRow): string | null => {
      const w = row.work_email ? normEmail(row.work_email) : null;
      const p = row.personal_email ? normEmail(row.personal_email) : null;
      return (w && lastSeen[w]) || (p && lastSeen[p]) || null;
    },
    [lastSeen],
  );

  const emailKeyFor = (row: EmployeeRow): string => normEmail(employeeIdentityEmail(row)) ?? '';

  const forceLogout = useCallback(async (email: string) => {
    setForcingLogoutEmail(email);
    try {
      const res = await fetch('/api/auth/force-logout', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ email, reason: 'manual session reset — Global Master List' }),
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
      setForcingLogoutEmail(null);
    }
  }, []);

  const handleSendPing = useCallback(() => {
    if (!pingTarget) return;
    const text = pingText.trim() || '👋 Hi';
    setPingSending(true);
    sendPing(pingTarget, text);
    setTimeout(() => setPingSending(false), 300);
    setPingTarget(null);
    setPingText('');
    toast.success("Pinged — it will land instantly if they're online.");
  }, [pingTarget, pingText, sendPing]);

  if (loading) {
    return (
      <div className="flex h-full min-h-0 flex-1 items-center justify-center bg-gradient-to-b from-zinc-50/80 to-transparent dark:from-zinc-950/50">
        <Loader2 className="h-6 w-6 animate-spin text-zinc-400" />
      </div>
    );
  }

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
              The synced roster, with who&apos;s online, where they are, and the tools to reach or reset them.
            </p>
          </div>
          <div className="flex flex-wrap gap-2">
            <div className="flex items-center gap-2 rounded-xl border border-zinc-200/90 bg-white/90 px-3 py-2 shadow-sm dark:border-zinc-800 dark:bg-zinc-900/60">
              <Sheet className="h-4 w-4 text-zinc-400" aria-hidden />
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

      <Card className="flex h-full min-h-0 flex-1 flex-col overflow-hidden border-zinc-200/90 shadow-sm dark:border-zinc-800/80">
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
              Sync from Google Sheet
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
            <label className="flex shrink-0 items-center gap-2">
              <span className="flex items-center gap-1 whitespace-nowrap text-[11px] font-medium text-zinc-500 dark:text-zinc-400">
                <Building2 className="h-3.5 w-3.5" aria-hidden />
                Department
              </span>
              <SmoothSelect
                aria-label="Filter by department"
                value={departmentFilter}
                onChange={(v) => setDepartmentFilter(v)}
                triggerClassName="min-w-[10.5rem]"
                options={[
                  { value: '__all__', label: 'All departments' },
                  { value: '__unassigned__', label: 'Unassigned' },
                  ...departmentOptions.map((dep) => ({ value: dep, label: dep })),
                ]}
              />
            </label>
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
              <span className="min-w-[4.5rem] text-center font-mono text-xs text-zinc-600 dark:text-zinc-400">
                {currentPage} / {totalPages}
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
              {pageRows.map((row) => {
                const key = emailKeyFor(row);
                return (
                  <GmlRow
                    key={key || row.employee_id || row.name}
                    row={row}
                    detail={detailFor(row)}
                    lastSeenIso={lastSeenFor(row)}
                    isSelf={!!viewerNorm && key === viewerNorm}
                    isPinging={pingTarget === key}
                    pingText={pingTarget === key ? pingText : ''}
                    pingSending={pingSending}
                    forcingLogout={forcingLogoutEmail === key}
                    onPingTextChange={setPingText}
                    onStartPing={() => {
                      setPingTarget(key);
                      setPingText('');
                    }}
                    onCancelPing={() => setPingTarget(null)}
                    onSendPing={handleSendPing}
                    onForceLogout={() => void forceLogout(key)}
                  />
                );
              })}
            </ul>
          )}
        </CardContent>
      </Card>
    </div>
  );
}
