'use client';

import { useCallback, useEffect, useMemo, useState } from 'react';
import {
  AlertTriangle,
  ArrowDown,
  ArrowUp,
  ChevronLeft,
  ChevronRight,
  ChevronsLeft,
  ChevronsRight,
  ClipboardList,
  Clock,
  Loader2,
  RefreshCw,
  Trash2,
} from 'lucide-react';
import { cn } from '@/lib/utils';
import { toast } from 'sonner';
import type { AuditLogEntry } from '@/lib/supabase/audit-log';

type SortKey = 'created_at' | 'action' | 'user_name';
type SortDir = 'asc' | 'desc';
const PAGE_SIZE_OPTIONS = [10, 25, 50, 100] as const;

async function loadAuditLog(limit = 500): Promise<AuditLogEntry[]> {
  const res = await fetch(`/api/audit-log?limit=${limit}`, { cache: 'no-store' });
  const json = (await res.json()) as { rows: AuditLogEntry[]; error: string | null };
  return json.rows ?? [];
}

function formatAbsoluteTime(iso: string): string {
  return new Date(iso).toLocaleString('en-PH', {
    month: 'short',
    day: 'numeric',
    year: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
    hour12: true,
  });
}

function formatRelativeTime(iso: string): string {
  const diffMs = Date.now() - new Date(iso).getTime();
  const minutes = Math.floor(diffMs / 60_000);
  if (minutes < 1) return 'Just now';
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.floor(hours / 24);
  return `${days}d ago`;
}

function formatActionLabel(action: string, details: Record<string, unknown> | null): string {
  switch (action) {
    case 'settings.rule.toggle':
      return `${details?.setting ?? 'Rule'} → ${details?.value ? 'Enabled' : 'Disabled'}`;
    case 'settings.ot.global':
      return `Global OT Suspension → ${details?.suspended ? 'On' : 'Off'}`;
    case 'settings.ot.department':
      return `${details?.department ?? 'Dept'} Overtime → ${details?.enabled ? 'On' : 'Off'}`;
    case 'csv.upload': {
      const mode = details?.mode === 'replace' ? 'replaced' : 'appended';
      return `CSV ${mode}: ${details?.file ?? 'file'} (${details?.rows ?? '?'} rows)`;
    }
    case 'csv.delete':
      return `CSV deleted: ${details?.file ?? details?.resource_id ?? 'file'}`;
    case 'employee.create':
      return `Employee added: ${details?.name ?? details?.work_email ?? 'Unknown'}`;
    case 'employee.delete':
      return `Employee deleted: ${details?.name ?? details?.work_email ?? details?.personal_email ?? 'Unknown'}`;
    case 'employee.rates.update': {
      const emp = details?.employee ?? 'Unknown';
      const after = details?.after as Record<string, unknown> | null;
      return `Rates updated: ${emp} → ₱${after?.regular_rate ?? '?'} reg / ₱${after?.ot_rate ?? '?'} OT`;
    }
    case 'employee.profile.update': {
      const emp = details?.employee ?? 'Unknown';
      const fields = Object.keys((details?.changes as object) ?? {}).join(', ');
      return `Profile updated: ${emp}${fields ? ` (${fields})` : ''}`;
    }
    case 'employee.suspend':
      return `Account suspended: ${details?.name ?? details?.work_email ?? 'Unknown'}`;
    case 'employee.unsuspend':
      return `Account reinstated: ${details?.name ?? details?.work_email ?? 'Unknown'}`;
    case 'employee.login.success':
      return `Login success: ${details?.work_email ?? '—'}`;
    case 'employee.login.failed':
      return `Login failed: ${details?.work_email ?? '—'}`;
    case 'employee.password_reset.requested':
      return `Password reset requested: ${details?.work_email ?? '—'}`;
    case 'employee.password_reset.identity_failed':
      return `Password reset identity check failed: ${details?.work_email ?? '—'}`;
    case 'rbac.role.granted':
      return `Role granted: ${String(details?.role ?? '?')} → ${String(details?.target_email ?? '?')}`;
    case 'rbac.role.revoked':
      return `Role revoked: ${String(details?.role ?? '?')} ← ${String(details?.target_email ?? '?')}`;
    case 'leave.request':
      return `Leave filed: ${String(details?.employee_name ?? details?.employee_email ?? '?')} (${String(details?.leave_type ?? '?')}) ${String(details?.start_date ?? '')}–${String(details?.end_date ?? '')}`;
    case 'leave.approved':
      return `Leave approved: ${String(details?.employee_email ?? '?')} by ${String(details?.approver_email ?? '?')}`;
    case 'leave.rejected':
      return `Leave rejected: ${String(details?.employee_email ?? '?')} by ${String(details?.approver_email ?? '?')}`;
    case 'leave.cancelled':
      return `Leave cancelled: ${String(details?.employee_email ?? '?')}`;
    case 'pab_dispute.submitted':
      return `PAB dispute filed: ${String(details?.employee ?? '?')} — ${String(details?.reason ?? '?')} on ${String(details?.dispute_date ?? '?')}`;
    case 'pab_dispute.approved':
      return `PAB dispute approved: ${String(details?.employee ?? '?')} ${String(details?.dispute_date ?? '?')} by ${String(details?.decided_by ?? '?')}`;
    case 'pab_dispute.denied':
      return `PAB dispute denied: ${String(details?.employee ?? '?')} ${String(details?.dispute_date ?? '?')} by ${String(details?.decided_by ?? '?')}`;
    case 'pab_dispute.withdrawn':
      return `PAB dispute withdrawn: ${String(details?.employee ?? '?')} ${String(details?.dispute_date ?? '?')}`;
    default:
      return action;
  }
}

function actionDot(action: string): string {
  if (action === 'settings.ot.global') return 'bg-red-500';
  if (action === 'settings.ot.department') return 'bg-orange-400';
  if (action === 'settings.rule.toggle') return 'bg-violet-500';
  if (action === 'csv.upload') return 'bg-blue-500';
  if (action === 'csv.delete') return 'bg-rose-500';
  if (action === 'employee.create') return 'bg-emerald-500';
  if (action === 'employee.delete') return 'bg-red-600';
  if (action === 'employee.rates.update') return 'bg-amber-500';
  if (action === 'employee.profile.update') return 'bg-sky-500';
  if (action === 'employee.suspend') return 'bg-orange-600';
  if (action === 'employee.unsuspend') return 'bg-teal-500';
  if (action === 'employee.login.success') return 'bg-cyan-500';
  if (action === 'employee.login.failed') return 'bg-red-500';
  if (action === 'employee.password_reset.requested') return 'bg-indigo-400';
  if (action === 'employee.password_reset.identity_failed') return 'bg-orange-700';
  if (action === 'rbac.role.granted') return 'bg-fuchsia-500';
  if (action === 'rbac.role.revoked') return 'bg-pink-600';
  if (action === 'leave.request') return 'bg-lime-500';
  if (action === 'leave.approved') return 'bg-green-600';
  if (action === 'leave.rejected') return 'bg-rose-600';
  if (action === 'leave.cancelled') return 'bg-zinc-500';
  if (action === 'pab_dispute.submitted') return 'bg-amber-500';
  if (action === 'pab_dispute.approved') return 'bg-green-600';
  if (action === 'pab_dispute.denied') return 'bg-rose-600';
  if (action === 'pab_dispute.withdrawn') return 'bg-zinc-500';
  return 'bg-zinc-400';
}

function PageBtn({ children, onClick, disabled }: { children: React.ReactNode; onClick: () => void; disabled?: boolean }) {
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      className="flex h-6 w-6 items-center justify-center rounded border border-zinc-200 bg-white text-zinc-600 transition hover:bg-zinc-100 disabled:cursor-not-allowed disabled:opacity-40 dark:border-zinc-700 dark:bg-zinc-900 dark:text-zinc-400 dark:hover:bg-zinc-800"
    >
      {children}
    </button>
  );
}

function AuditRow({ entry }: { entry: AuditLogEntry }) {
  const details = entry.details as Record<string, unknown> | null;

  return (
    <div className="flex items-start gap-3 rounded-lg border border-zinc-100 bg-white px-3 py-2.5 dark:border-zinc-800 dark:bg-zinc-900/40">
      <span className={cn('mt-1.5 h-2 w-2 flex-shrink-0 rounded-full', actionDot(entry.action))} />

      <div className="min-w-0 flex-1">
        <p className="text-xs font-semibold leading-snug text-zinc-800 dark:text-zinc-100">
          {formatActionLabel(entry.action, details)}
        </p>
        <div className="mt-0.5 flex flex-wrap items-center gap-x-2 gap-y-0.5">
          <span className="text-[10px] font-medium text-zinc-500 dark:text-zinc-400">{entry.user_name}</span>
          <span className="text-[9px] text-zinc-300 dark:text-zinc-600">·</span>
          <span className="text-[10px] text-zinc-400 dark:text-zinc-500">{entry.user_role}</span>
          {entry.ip_address && (
            <>
              <span className="text-[9px] text-zinc-300 dark:text-zinc-600">·</span>
              <span className="font-mono text-[10px] text-zinc-400 dark:text-zinc-500">{entry.ip_address}</span>
            </>
          )}
        </div>
      </div>

      <div className="flex-shrink-0 text-right">
        <p className="text-[10px] font-medium text-zinc-500 dark:text-zinc-400">{formatRelativeTime(entry.created_at)}</p>
        <p className="whitespace-nowrap text-[9px] text-zinc-400 dark:text-zinc-500">{formatAbsoluteTime(entry.created_at)}</p>
      </div>
    </div>
  );
}

const LEGEND = [
  { dot: 'bg-violet-500', label: 'Payroll Rule' },
  { dot: 'bg-red-500', label: 'Global OT' },
  { dot: 'bg-orange-400', label: 'Dept OT' },
  { dot: 'bg-blue-500', label: 'CSV Upload' },
  { dot: 'bg-rose-500', label: 'CSV Deleted' },
  { dot: 'bg-emerald-500', label: 'Employee Added' },
  { dot: 'bg-red-600', label: 'Employee Deleted' },
  { dot: 'bg-amber-500', label: 'Rate Change' },
  { dot: 'bg-sky-500', label: 'Profile Edit' },
  { dot: 'bg-orange-600', label: 'Suspended' },
  { dot: 'bg-teal-500', label: 'Reinstated' },
  { dot: 'bg-cyan-500', label: 'Login OK' },
  { dot: 'bg-red-500', label: 'Login Fail' },
  { dot: 'bg-indigo-400', label: 'Pwd Reset' },
  { dot: 'bg-fuchsia-500', label: 'Role Granted' },
  { dot: 'bg-pink-600', label: 'Role Revoked' },
  { dot: 'bg-lime-500', label: 'Leave filed' },
  { dot: 'bg-green-600', label: 'Leave approved' },
  { dot: 'bg-rose-600', label: 'Leave rejected' },
  { dot: 'bg-zinc-500', label: 'Leave cancelled' },
] as const;

export type AuditLogPanelProps = {
  /** System Settings only: show “OT Settings” and call when clicked */
  onNavigateToOtSettings?: () => void;
  className?: string;
};

export default function AuditLogPanel({ onNavigateToOtSettings, className }: AuditLogPanelProps) {
  const [auditLogs, setAuditLogs] = useState<AuditLogEntry[]>([]);
  const [auditLoading, setAuditLoading] = useState(false);
  const [auditError, setAuditError] = useState<string | null>(null);
  const [confirmClear, setConfirmClear] = useState(false);
  const [clearing, setClearing] = useState(false);
  const [sortKey, setSortKey] = useState<SortKey>('created_at');
  const [sortDir, setSortDir] = useState<SortDir>('desc');
  const [page, setPage] = useState(1);
  const [pageSize, setPageSize] = useState<(typeof PAGE_SIZE_OPTIONS)[number]>(25);

  const sortedLogs = useMemo(() => {
    const arr = [...auditLogs];
    arr.sort((a, b) => {
      const av = (a[sortKey] ?? '') as string;
      const bv = (b[sortKey] ?? '') as string;
      const cmp = av < bv ? -1 : av > bv ? 1 : 0;
      return sortDir === 'asc' ? cmp : -cmp;
    });
    return arr;
  }, [auditLogs, sortKey, sortDir]);

  const totalPages = Math.max(1, Math.ceil(sortedLogs.length / pageSize));
  const safePage = Math.min(page, totalPages);
  const pageStart = (safePage - 1) * pageSize;
  const pageRows = sortedLogs.slice(pageStart, pageStart + pageSize);

  useEffect(() => {
    setPage(1);
  }, [sortKey, sortDir, pageSize, auditLogs.length]);

  const toggleSort = (key: SortKey) => {
    if (sortKey === key) {
      setSortDir((d) => (d === 'asc' ? 'desc' : 'asc'));
    } else {
      setSortKey(key);
      setSortDir(key === 'created_at' ? 'desc' : 'asc');
    }
  };

  const refreshAuditLog = useCallback(async () => {
    setAuditLoading(true);
    setAuditError(null);
    try {
      const rows = await loadAuditLog();
      setAuditLogs(rows);
    } catch {
      setAuditError('Failed to load audit log.');
    } finally {
      setAuditLoading(false);
    }
  }, []);

  useEffect(() => {
    void refreshAuditLog();
  }, [refreshAuditLog]);

  const handleClearLog = useCallback(async () => {
    setClearing(true);
    try {
      const res = await fetch('/api/audit-log', { method: 'DELETE' });
      const json = (await res.json()) as { error: string | null };
      if (json.error) throw new Error(json.error);
      setAuditLogs([]);
      setConfirmClear(false);
      toast.success('Audit log cleared');
    } catch (e) {
      toast.error('Failed to clear log', { description: e instanceof Error ? e.message : 'Unknown error' });
    } finally {
      setClearing(false);
    }
  }, []);

  return (
    <div className={cn('flex min-h-0 flex-1 flex-col overflow-hidden', className)}>
      <div className="flex flex-shrink-0 items-center justify-between border-b border-zinc-100 px-5 py-3 dark:border-zinc-800">
        <div className="flex items-center gap-2.5">
          <div className="flex h-7 w-7 items-center justify-center rounded-lg bg-indigo-50 dark:bg-indigo-950/30">
            <ClipboardList className="h-3.5 w-3.5 text-indigo-500" />
          </div>
          <div>
            <p className="text-sm font-bold text-zinc-900 dark:text-white">Audit Log</p>
            <p className="text-[10px] text-zinc-400 dark:text-zinc-500">
              Same activity feed as System Settings — payroll, employees, CSV, login, roles, and leave
            </p>
          </div>
        </div>

        <div className="flex items-center gap-2">
          {onNavigateToOtSettings && (
            <button
              type="button"
              onClick={() => {
                setConfirmClear(false);
                onNavigateToOtSettings();
              }}
              className="flex items-center gap-1.5 rounded-lg border border-zinc-200 bg-zinc-50 px-2.5 py-1.5 text-[10px] font-medium text-zinc-600 transition-colors hover:bg-zinc-100 dark:border-zinc-700 dark:bg-zinc-800 dark:text-zinc-400 dark:hover:bg-zinc-700"
            >
              <Clock className="h-3 w-3" />
              OT Settings
            </button>
          )}
          <button
            type="button"
            onClick={() => void refreshAuditLog()}
            disabled={auditLoading || clearing}
            className="flex items-center gap-1.5 rounded-lg border border-indigo-200 bg-indigo-50 px-2.5 py-1.5 text-[10px] font-medium text-indigo-600 transition-colors hover:bg-indigo-100 disabled:opacity-50 dark:border-indigo-800/50 dark:bg-indigo-950/20 dark:text-indigo-400"
          >
            <RefreshCw className={cn('h-3 w-3', auditLoading && 'animate-spin')} />
            Refresh
          </button>
          {!confirmClear ? (
            <button
              type="button"
              onClick={() => setConfirmClear(true)}
              disabled={auditLoading || clearing || auditLogs.length === 0}
              className="flex items-center gap-1.5 rounded-lg border border-red-200 bg-red-50 px-2.5 py-1.5 text-[10px] font-medium text-red-500 transition-colors hover:bg-red-100 disabled:cursor-not-allowed disabled:opacity-40 dark:border-red-800/50 dark:bg-red-950/20 dark:text-red-400"
            >
              <Trash2 className="h-3 w-3" />
              Clear Log
            </button>
          ) : (
            <div className="flex items-center gap-1.5 rounded-lg border border-red-300 bg-red-50 px-2.5 py-1.5 dark:border-red-700 dark:bg-red-950/30">
              <span className="text-[10px] font-semibold text-red-600 dark:text-red-400">Sure?</span>
              <button
                type="button"
                onClick={() => void handleClearLog()}
                disabled={clearing}
                className="flex items-center gap-1 rounded-md bg-red-500 px-2 py-0.5 text-[10px] font-bold text-white transition-colors hover:bg-red-600 disabled:opacity-60"
              >
                {clearing ? <Loader2 className="h-2.5 w-2.5 animate-spin" /> : <Trash2 className="h-2.5 w-2.5" />}
                Yes, clear
              </button>
              <button
                type="button"
                onClick={() => setConfirmClear(false)}
                disabled={clearing}
                className="rounded-md px-2 py-0.5 text-[10px] font-medium text-zinc-500 transition-colors hover:text-zinc-700 dark:text-zinc-400"
              >
                Cancel
              </button>
            </div>
          )}
        </div>
      </div>

      <div className="flex min-h-0 flex-1 flex-col px-5 py-3">
        {auditLoading ? (
          <div className="flex items-center justify-center gap-2 py-12 text-zinc-400">
            <Loader2 className="h-4 w-4 animate-spin" />
            <span className="text-sm">Loading audit log…</span>
          </div>
        ) : auditError ? (
          <div className="flex items-center gap-2 rounded-lg border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-600 dark:border-red-800/50 dark:bg-red-950/20 dark:text-red-400">
            <AlertTriangle className="h-4 w-4 flex-shrink-0" />
            {auditError}
          </div>
        ) : auditLogs.length === 0 ? (
          <div className="flex flex-col items-center justify-center gap-2 py-16 text-center">
            <ClipboardList className="h-8 w-8 text-zinc-200 dark:text-zinc-700" />
            <p className="text-sm font-medium text-zinc-400">No activity recorded yet</p>
            <p className="max-w-sm text-xs text-zinc-300 dark:text-zinc-600">
              Settings changes, CSV uploads, employee updates, logins, and role changes will appear here.
            </p>
          </div>
        ) : (
          <div className="flex min-h-0 flex-1 flex-col">
            <div className="mb-2 flex flex-shrink-0 flex-wrap items-center gap-x-4 gap-y-1">
              {LEGEND.map(({ dot, label }) => (
                <div key={label} className="flex items-center gap-1.5">
                  <span className={cn('h-2 w-2 rounded-full', dot)} />
                  <span className="text-[10px] text-zinc-400">{label}</span>
                </div>
              ))}
              <span className="ml-auto text-[10px] text-zinc-400">
                {auditLogs.length} {auditLogs.length === 1 ? 'entry' : 'entries'}
              </span>
            </div>

            <div className="mb-2 flex flex-shrink-0 flex-wrap items-center gap-2 rounded-md border border-zinc-200 bg-zinc-50/60 px-2.5 py-1.5 dark:border-zinc-800 dark:bg-zinc-900/40">
              <span className="text-[10px] font-semibold uppercase tracking-wider text-zinc-500 dark:text-zinc-400">Sort</span>
              {([
                { k: 'created_at', label: 'Date' },
                { k: 'action',     label: 'Action' },
                { k: 'user_name',  label: 'User' },
              ] as { k: SortKey; label: string }[]).map(({ k, label }) => {
                const active = sortKey === k;
                return (
                  <button
                    key={k}
                    type="button"
                    onClick={() => toggleSort(k)}
                    className={cn(
                      'flex items-center gap-1 rounded px-2 py-1 text-[10px] font-medium transition',
                      active
                        ? 'bg-indigo-100 text-indigo-700 dark:bg-indigo-950/50 dark:text-indigo-300'
                        : 'text-zinc-500 hover:bg-zinc-100 dark:text-zinc-400 dark:hover:bg-zinc-800',
                    )}
                  >
                    {label}
                    {active && (sortDir === 'asc' ? <ArrowUp className="h-3 w-3" /> : <ArrowDown className="h-3 w-3" />)}
                  </button>
                );
              })}

              <div className="ml-auto flex items-center gap-1.5">
                <label className="flex items-center gap-1 text-[10px] text-zinc-500 dark:text-zinc-400">
                  Per page
                  <select
                    value={pageSize}
                    onChange={(e) => setPageSize(Number(e.target.value) as (typeof PAGE_SIZE_OPTIONS)[number])}
                    className="rounded border border-zinc-200 bg-white px-1 py-0.5 text-[10px] dark:border-zinc-700 dark:bg-zinc-900"
                  >
                    {PAGE_SIZE_OPTIONS.map((n) => (
                      <option key={n} value={n}>{n}</option>
                    ))}
                  </select>
                </label>
              </div>
            </div>

            <div className="min-h-0 flex-1 space-y-1.5 overflow-y-auto pr-1">
              {pageRows.map((entry) => (
                <AuditRow key={entry.id} entry={entry} />
              ))}
            </div>

            <div className="mt-2 flex flex-shrink-0 flex-wrap items-center justify-between gap-2 border-t border-zinc-100 pt-2 dark:border-zinc-800">
              <span className="text-[10px] text-zinc-500 dark:text-zinc-400">
                Showing <strong>{sortedLogs.length === 0 ? 0 : pageStart + 1}</strong>–<strong>{Math.min(pageStart + pageSize, sortedLogs.length)}</strong> of <strong>{sortedLogs.length}</strong>
              </span>
              <div className="flex items-center gap-1">
                <PageBtn onClick={() => setPage(1)} disabled={safePage === 1}><ChevronsLeft className="h-3 w-3" /></PageBtn>
                <PageBtn onClick={() => setPage((p) => Math.max(1, p - 1))} disabled={safePage === 1}><ChevronLeft className="h-3 w-3" /></PageBtn>
                <span className="px-2 text-[10px] font-medium text-zinc-600 dark:text-zinc-300">
                  Page {safePage} / {totalPages}
                </span>
                <PageBtn onClick={() => setPage((p) => Math.min(totalPages, p + 1))} disabled={safePage === totalPages}><ChevronRight className="h-3 w-3" /></PageBtn>
                <PageBtn onClick={() => setPage(totalPages)} disabled={safePage === totalPages}><ChevronsRight className="h-3 w-3" /></PageBtn>
              </div>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
