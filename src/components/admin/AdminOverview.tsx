'use client';

import { useCallback, useEffect, useMemo, useRef, useState, type ChangeEvent } from 'react';
import {
  type LucideIcon,
  Activity,
  ArrowRight,
  Banknote,
  Clock,
  CloudUpload,
  Cpu,
  Database,
  Download,
  GitCommit,
  Radio,
  Search,
  Shield,
  Terminal,
  UserPlus,
  Users,
  Webhook,
  Zap,
} from 'lucide-react';
import { cn } from '@/lib/utils';
import type { AuditLogEntry } from '@/lib/supabase/audit-log';
import { formatActionLabel, formatRelativeTime } from '@/components/audit/AuditLogPanel';
import { toast } from 'sonner';

const ROLE_ORDER = [
  { key: 'admin', label: 'admin', blurb: 'Full system access', color: '#a1a1aa' },
  { key: 'payroll_manager', label: 'payroll_mgr', blurb: 'Edit rates · dispatch payroll', color: '#fb923c' },
  { key: 'finance', label: 'finance', blurb: 'Accounting dashboard', color: '#60a5fa' },
  { key: 'payroll_coordinator', label: 'payroll_coord', blurb: 'CSV upload · pre-flight', color: '#c084fc' },
  { key: 'hr_coordinator', label: 'hr_coord', blurb: 'Edit employee profiles', color: '#34d399' },
  { key: 'viewer', label: 'viewer', blurb: 'Read-only dashboards', color: '#71717a' },
] as const;

type RoleKey = (typeof ROLE_ORDER)[number]['key'];

interface RoleRow {
  role: string;
}

interface WebhookEntry {
  slug: string;
  label: string;
  url: string;
  active: boolean;
}

interface CoreTableStatusRow {
  id: string;
  label: string;
  tableName: string;
  rowCount: number | null;
  error: string | null;
  status: 'ok' | 'warn' | 'error';
  detail: string;
}

interface CoreTablesPayload {
  tables: CoreTableStatusRow[];
  hints: string[];
  usedServiceRole: boolean;
}

function auditRowKind(action: string): 'danger' | 'warn' | 'info' | 'ok' {
  if (
    action === 'employee.login.failed' ||
    action === 'employee.delete' ||
    action === 'pab_dispute.denied'
  )
    return 'danger';
  if (
    action === 'employee.rates.update' ||
    action === 'employee.login.success' ||
    action === 'rbac.role.granted' ||
    action === 'rbac.role.revoked' ||
    action === 'pab_dispute.submitted' ||
    action === 'csv.master.upload'
  )
    return 'warn';
  if (
    action === 'employee.create' ||
    action === 'leave.approved' ||
    action === 'pab_dispute.approved'
  )
    return 'ok';
  return 'info';
}

function levelTag(kind: 'danger' | 'warn' | 'info' | 'ok'): string {
  switch (kind) {
    case 'danger':
      return 'ERR';
    case 'warn':
      return 'WRN';
    case 'ok':
      return 'OK';
    default:
      return 'INF';
  }
}

function greetingFromEmail(email: string | null): string {
  if (!email) return 'there';
  const local = email.split('@')[0]?.trim() ?? '';
  if (!local) return 'there';
  const word = local.replace(/[._-]+/g, ' ').split(/\s+/)[0] ?? local;
  if (!word) return 'there';
  return word.slice(0, 1).toUpperCase() + word.slice(1).toLowerCase();
}

function coreTableIcon(id: string): LucideIcon {
  switch (id) {
    case 'global_master_list':
      return Users;
    case 'employee_hourly_rates':
      return Banknote;
    case 'hubstaff_hours':
      return Clock;
    default:
      return Database;
  }
}

export type AdminOverviewProps = {
  userEmail: string | null;
  onNavigate: (tab: string) => void;
};

const card =
  'flex min-h-0 min-w-0 flex-col overflow-hidden rounded-lg border border-zinc-200/90 bg-white/90 shadow-sm dark:border-zinc-800/80 dark:bg-zinc-900/40 dark:shadow-none';
const panelHead =
  'flex h-9 shrink-0 items-center justify-between gap-2 border-b border-zinc-200/90 bg-zinc-50/90 px-3 dark:border-zinc-800/90 dark:bg-zinc-900/60';
const statCard =
  'group relative flex min-h-0 min-w-0 flex-col overflow-hidden rounded-lg border border-zinc-200/90 bg-white/95 p-3 shadow-sm transition-colors hover:border-zinc-300/90 dark:border-zinc-800/80 dark:bg-zinc-900/50 dark:hover:border-zinc-700/80';

export default function AdminOverview({ userEmail, onNavigate }: AdminOverviewProps) {
  const [employeeCount, setEmployeeCount] = useState<number | null>(null);
  const [roleRows, setRoleRows] = useState<RoleRow[]>([]);
  const [webhooks, setWebhooks] = useState<WebhookEntry[]>([]);
  const [auditRows, setAuditRows] = useState<AuditLogEntry[]>([]);
  const [auditTotalHint, setAuditTotalHint] = useState<number>(0);
  const [loading, setLoading] = useState(true);
  const [search, setSearch] = useState('');
  const [timeZone, setTimeZone] = useState('');
  const [coreTables, setCoreTables] = useState<CoreTablesPayload | null>(null);
  const [masterUploading, setMasterUploading] = useState(false);
  const masterFileInputRef = useRef<HTMLInputElement>(null);
  const [ratesUploading, setRatesUploading] = useState(false);
  const ratesFileInputRef = useRef<HTMLInputElement>(null);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const [empRes, rolesRes, hookRes, auditRes, tablesRes] = await Promise.all([
        fetch('/api/employees', { cache: 'no-store' }),
        fetch('/api/employee-roles', { cache: 'no-store' }),
        fetch('/api/app-settings?key=webhooks.config', { cache: 'no-store' }),
        fetch('/api/audit-log?limit=500', { cache: 'no-store' }),
        fetch('/api/admin/data-tables-status', { cache: 'no-store' }),
      ]);
      const empJson = (await empRes.json()) as { employees?: unknown[] };
      const rolesJson = (await rolesRes.json()) as { rows?: RoleRow[] };
      const hookJson = (await hookRes.json()) as { value: string | null };
      const auditJson = (await auditRes.json()) as { rows?: AuditLogEntry[] };
      const tablesJson = (await tablesRes.json()) as CoreTablesPayload & { error?: string };

      setEmployeeCount((empJson.employees ?? []).length);
      setRoleRows(rolesJson.rows ?? []);

      let parsedHooks: WebhookEntry[] = [];
      if (hookJson.value) {
        try {
          const raw = JSON.parse(hookJson.value) as WebhookEntry[];
          parsedHooks = Array.isArray(raw) ? raw : [];
        } catch {
          parsedHooks = [];
        }
      }
      setWebhooks(parsedHooks);

      const aRows = auditJson.rows ?? [];
      setAuditTotalHint(aRows.length);
      setAuditRows(aRows.slice(0, 24));

      const hints = [...(tablesJson.hints ?? [])];
      if (tablesJson.error) hints.push(tablesJson.error);
      setCoreTables({
        tables: Array.isArray(tablesJson.tables) ? tablesJson.tables : [],
        hints,
        usedServiceRole: Boolean(tablesJson.usedServiceRole),
      });
    } catch {
      setEmployeeCount(0);
      setRoleRows([]);
      setWebhooks([]);
      setAuditRows([]);
      setAuditTotalHint(0);
      setCoreTables({
        tables: [],
        hints: ['Could not load core table status. Try Sync or check the network.'],
        usedServiceRole: false,
      });
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  useEffect(() => {
    try {
      setTimeZone(Intl.DateTimeFormat().resolvedOptions().timeZone ?? '');
    } catch {
      setTimeZone('');
    }
  }, []);

  const roleCounts = useMemo(() => {
    const m = new Map<string, number>();
    for (const k of ROLE_ORDER) m.set(k.key, 0);
    for (const r of roleRows) {
      const k = (r.role ?? '').toLowerCase();
      m.set(k, (m.get(k) ?? 0) + 1);
    }
    return m;
  }, [roleRows]);

  const rolesForDonut = useMemo(() => {
    return ROLE_ORDER.map((r) => ({
      ...r,
      count: roleCounts.get(r.key) ?? 0,
    })).filter((r) => r.count > 0);
  }, [roleCounts]);

  const elevatedTotal = useMemo(
    () => ROLE_ORDER.reduce((s, r) => s + (roleCounts.get(r.key) ?? 0), 0),
    [roleCounts],
  );

  const nonViewerElevated = useMemo(() => {
    return ROLE_ORDER.filter((r) => r.key !== 'viewer').reduce(
      (s, r) => s + (roleCounts.get(r.key) ?? 0),
      0,
    );
  }, [roleCounts]);

  const misconfiguredWebhooks = useMemo(
    () => webhooks.filter((w) => w.active && !String(w.url ?? '').trim()),
    [webhooks],
  );

  const paystub = useMemo(
    () => webhooks.find((w) => w.slug === 'paystub_dispatch'),
    [webhooks],
  );

  const filteredAudit = useMemo(() => {
    const q = search.trim().toLowerCase();
    if (!q) return auditRows;
    return auditRows.filter((e) => {
      const label = formatActionLabel(e.action, e.details).toLowerCase();
      const who = `${e.user_name} ${e.user_role}`.toLowerCase();
      const res = `${e.resource} ${e.resource_id ?? ''}`.toLowerCase();
      return label.includes(q) || who.includes(q) || res.includes(q);
    });
  }, [auditRows, search]);

  const exportAuditSnapshot = useCallback(() => {
    const payload = {
      exportedAt: new Date().toISOString(),
      source: 'admin-overview',
      rowCount: filteredAudit.length,
      rows: filteredAudit,
    };
    const blob = new Blob([JSON.stringify(payload, null, 2)], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `audit-overview-${new Date().toISOString().slice(0, 19).replace(/[:T]/g, '-')}.json`;
    a.click();
    URL.revokeObjectURL(url);
  }, [filteredAudit]);

  const webhookAttention = misconfiguredWebhooks.length > 0;

  const databaseServicesTile = useMemo(() => {
    const tables = coreTables?.tables ?? [];
    if (tables.length === 0) {
      return {
        ok: false as const,
        val: 'Unavailable',
        sub: 'Could not read Supabase',
      };
    }
    const errN = tables.filter((t) => t.status === 'error').length;
    const warnN = tables.filter((t) => t.status === 'warn').length;
    if (errN > 0) {
      return { ok: false as const, val: `${errN} error(s)`, sub: 'See core tables below' };
    }
    if (warnN > 0) {
      return { ok: false as const, val: `${warnN} warning(s)`, sub: 'See core tables below' };
    }
    return { ok: true as const, val: 'Healthy', sub: `${tables.length} payroll tables` };
  }, [coreTables]);

  const donutSegments = useMemo(() => {
    const list = rolesForDonut.length ? rolesForDonut : [];
    const total = list.reduce((s, r) => s + r.count, 0) || 1;
    let offset = 0;
    return list.map((r) => {
      const pct = (r.count / total) * 100;
      const seg = { ...r, pct, offset };
      offset += pct;
      return seg;
    });
  }, [rolesForDonut]);

  const hubstaffUrl =
    typeof window !== 'undefined' ? `${window.location.origin}/api/hubstaff-hours` : '/api/hubstaff-hours';
  const masterListUrl =
    typeof window !== 'undefined' ? `${window.location.origin}/api/global-master-list` : '/api/global-master-list';

  const onPickMasterCsv = useCallback(() => {
    masterFileInputRef.current?.click();
  }, []);

  const onMasterCsvSelected = useCallback(
    async (e: ChangeEvent<HTMLInputElement>) => {
      const input = e.target;
      const file = input.files?.[0];
      input.value = '';
      if (!file) return;
      setMasterUploading(true);
      try {
        const form = new FormData();
        form.set('file', file);
        const res = await fetch('/api/global-master-list', { method: 'POST', body: form });
        const json = (await res.json()) as {
          success?: boolean;
          rowCount?: number;
          error?: string;
          ratesReconcile?: {
            hint: string | null;
            ratesFewerThanMaster?: boolean;
          } | null;
        };
        if (!res.ok || !json.success) {
          toast.error('Master list import failed', { description: json.error ?? res.statusText });
          return;
        }
        toast.success('Master list replaced', {
          description: `${(json.rowCount ?? 0).toLocaleString()} rows written from ${file.name}`,
        });
        if (json.ratesReconcile?.hint) {
          toast.warning('Hourly rates coverage', { description: json.ratesReconcile.hint });
        }
        void load();
      } catch (err) {
        toast.error('Master list import failed', {
          description: err instanceof Error ? err.message : String(err),
        });
      } finally {
        setMasterUploading(false);
      }
    },
    [load],
  );

  const onPickRatesCsv = useCallback(() => {
    ratesFileInputRef.current?.click();
  }, []);

  const onRatesCsvSelected = useCallback(
    async (e: ChangeEvent<HTMLInputElement>) => {
      const input = e.target;
      const file = input.files?.[0];
      input.value = '';
      if (!file) return;
      setRatesUploading(true);
      try {
        const form = new FormData();
        form.set('file', file);
        const res = await fetch('/api/employee-hourly-rates-upload', {
          method: 'POST',
          body: form,
        });
        const json = (await res.json()) as {
          success?: boolean;
          rowCount?: number;
          inserted?: number;
          updated?: number;
          uniqueEmployees?: number;
          skippedNoWorkEmail?: number;
          skippedNoRate?: number;
          error?: string;
        };
        if (!res.ok || !json.success) {
          toast.error('Rates import failed', { description: json.error ?? res.statusText });
          return;
        }
        const parts = [
          `${(json.uniqueEmployees ?? 0).toLocaleString()} employees`,
          `${json.updated ?? 0} updated`,
          `${json.inserted ?? 0} new`,
        ];
        toast.success('Payroll rates imported', { description: parts.join(' · ') });
        if ((json.skippedNoWorkEmail ?? 0) > 0 || (json.skippedNoRate ?? 0) > 0) {
          toast.warning('Some rows skipped', {
            description: `No work email: ${json.skippedNoWorkEmail ?? 0} · No rate: ${json.skippedNoRate ?? 0}`,
          });
        }
        void load();
      } catch (err) {
        toast.error('Rates import failed', {
          description: err instanceof Error ? err.message : String(err),
        });
      } finally {
        setRatesUploading(false);
      }
    },
    [load],
  );

  const sessionChip = userEmail ?? 'anon';
  const activeWebhookCount = webhooks.filter((w) => w.active).length;
  const hookDenom = Math.max(webhooks.length, 1);
  const greet = greetingFromEmail(userEmail);

  return (
    <div className="flex h-full min-h-0 w-full min-w-0 flex-1 flex-col overflow-hidden bg-zinc-50 font-sans text-sm text-zinc-800 antialiased dark:bg-zinc-950 dark:text-zinc-300">
      <header className="flex shrink-0 flex-wrap items-center gap-x-4 gap-y-2 border-b border-zinc-200/90 bg-white/70 px-3 py-2.5 text-[11px] backdrop-blur-sm dark:border-zinc-800 dark:bg-zinc-950/70">
        <div className="flex items-center gap-1.5 text-zinc-500 dark:text-zinc-500">
          <Terminal className="h-3.5 w-3.5 shrink-0 text-emerald-600 dark:text-emerald-500" aria-hidden />
          <span className="font-medium text-emerald-700 dark:text-emerald-400/90">Admin</span>
          <span className="text-zinc-300 dark:text-zinc-600">/</span>
          <span className="font-medium text-zinc-800 dark:text-zinc-200">Overview</span>
        </div>
        <span className="hidden text-zinc-300 dark:text-zinc-700 sm:inline">|</span>
        <div className="flex min-w-0 max-w-[220px] items-center gap-1.5 text-zinc-500 lg:max-w-none">
          <Radio className="h-3.5 w-3.5 shrink-0 text-emerald-600/90 dark:text-emerald-500/80" aria-hidden />
          <span className="truncate font-mono text-[11px]" title={sessionChip}>
            <span className="text-zinc-800 dark:text-zinc-200">{sessionChip}</span>
          </span>
        </div>
        <span className="hidden text-zinc-300 dark:text-zinc-700 md:inline">|</span>
        <span className="hidden rounded-md border border-emerald-200/80 bg-emerald-50 px-2 py-0.5 text-[10px] font-semibold uppercase tracking-wide text-emerald-800 md:inline dark:border-emerald-800/60 dark:bg-emerald-950/35 dark:text-emerald-400/90">
          Live
        </span>
        <span className="hidden text-zinc-500 dark:text-zinc-600 md:inline" title="Browser timezone">
          {timeZone || 'Local time'}
        </span>
        <div className="ml-auto flex flex-wrap items-center gap-1.5">
          <button
            type="button"
            onClick={() => void load()}
            disabled={loading}
            title="Reload metrics, roles, webhooks, and audit sample"
            className="inline-flex items-center rounded-md border border-zinc-200 bg-white px-2.5 py-1 text-[10px] font-medium uppercase tracking-wide text-zinc-600 hover:border-zinc-300 hover:text-zinc-900 disabled:opacity-50 dark:border-zinc-800 dark:bg-zinc-900/60 dark:text-zinc-400 dark:hover:border-zinc-700 dark:hover:text-zinc-200"
          >
            <Activity className="mr-1 inline h-3 w-3" />
            Sync
          </button>
          <button
            type="button"
            onClick={() => exportAuditSnapshot()}
            disabled={loading || filteredAudit.length === 0}
            title="Download the visible audit rows as JSON"
            className="inline-flex items-center rounded-md border border-zinc-200 bg-white px-2.5 py-1 text-[10px] font-medium uppercase tracking-wide text-zinc-600 hover:border-zinc-300 hover:text-zinc-900 disabled:opacity-50 dark:border-zinc-800 dark:bg-zinc-900/60 dark:text-zinc-400 dark:hover:border-zinc-700 dark:hover:text-zinc-200"
          >
            <Download className="mr-1 inline h-3 w-3" />
            Export audit
          </button>
          <button
            type="button"
            onClick={() => onNavigate('roles')}
            title="Open roles and permissions"
            className="inline-flex items-center rounded-md border border-emerald-300/60 bg-emerald-50 px-2.5 py-1 text-[10px] font-medium uppercase tracking-wide text-emerald-800 hover:bg-emerald-100/80 dark:border-emerald-800/50 dark:bg-emerald-950/35 dark:text-emerald-300 dark:hover:bg-emerald-950/50"
          >
            <UserPlus className="mr-1 inline h-3 w-3" />
            Roles
          </button>
        </div>
      </header>

      {loading ? (
        <div className="flex min-h-0 flex-1 flex-col items-center justify-center gap-3 overflow-hidden px-4 text-zinc-500">
          <Cpu className="h-8 w-8 animate-pulse text-emerald-600/70" aria-hidden />
          <p className="text-sm font-medium text-zinc-600 dark:text-zinc-400">Loading overview…</p>
        </div>
      ) : (
        <div className="flex min-h-0 flex-1 flex-col gap-3 overflow-hidden p-3">
          <section className="shrink-0 rounded-lg border border-zinc-200/90 bg-gradient-to-br from-white via-white to-zinc-50/90 p-4 shadow-sm dark:border-zinc-800/80 dark:from-zinc-900/80 dark:via-zinc-900/60 dark:to-zinc-950/90">
            <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
              <div className="min-w-0 space-y-1">
                <p className="text-xs font-medium uppercase tracking-wide text-zinc-500 dark:text-zinc-500">Dashboard</p>
                <h1 className="text-xl font-semibold tracking-tight text-zinc-900 dark:text-zinc-50 sm:text-2xl">
                  Hi, {greet}
                </h1>
                <p className="max-w-xl text-[13px] leading-relaxed text-zinc-600 dark:text-zinc-400">
                  <span className="font-medium tabular-nums text-zinc-800 dark:text-zinc-200">{employeeCount ?? '—'}</span>{' '}
                  employees on record ·{' '}
                  <span className="font-medium tabular-nums text-zinc-800 dark:text-zinc-200">{nonViewerElevated}</span> with
                  elevated access ·{' '}
                  <span className="font-medium tabular-nums text-zinc-800 dark:text-zinc-200">
                    {activeWebhookCount}/{hookDenom}
                  </span>{' '}
                  webhooks active
                </p>
              </div>
              <div className="flex shrink-0 flex-col items-start gap-2 sm:items-end">
                <span
                  className={cn(
                    'inline-flex items-center gap-1.5 rounded-full border px-2.5 py-1 text-[11px] font-semibold',
                    webhookAttention
                      ? 'border-amber-300/80 bg-amber-50 text-amber-900 dark:border-amber-700/50 dark:bg-amber-950/40 dark:text-amber-200'
                      : 'border-emerald-200/80 bg-emerald-50 text-emerald-900 dark:border-emerald-800/50 dark:bg-emerald-950/35 dark:text-emerald-200',
                  )}
                >
                  <span
                    className={cn('size-1.5 rounded-full', webhookAttention ? 'bg-amber-500' : 'bg-emerald-500')}
                    aria-hidden
                  />
                  {webhookAttention ? 'Needs attention' : 'All clear'}
                </span>
                <button
                  type="button"
                  onClick={() => onNavigate(webhookAttention ? 'webhooks' : 'audit')}
                  className="inline-flex items-center gap-1 text-[11px] font-medium text-emerald-700 hover:text-emerald-600 dark:text-emerald-400 dark:hover:text-emerald-300"
                >
                  {webhookAttention ? 'Review webhooks' : 'Open audit log'}
                  <ArrowRight className="h-3 w-3" aria-hidden />
                </button>
              </div>
            </div>
          </section>

          <div className="flex min-h-0 flex-1 flex-col gap-3 overflow-hidden lg:flex-row lg:items-stretch">
          {/* Left — metrics + rbac / hooks */}
          <div className="flex min-h-0 min-w-0 flex-1 flex-col gap-3 lg:min-w-0">
          {/* Signals */}
          <div className="grid shrink-0 grid-cols-2 gap-3 sm:grid-cols-4">
            {[
              {
                k: 'Employees',
                v: employeeCount ?? '—',
                sub: 'directory records',
                ok: true,
                Icon: Users,
              },
              {
                k: 'Role grants',
                v: elevatedTotal,
                sub: 'total assignments',
                ok: true,
                Icon: Shield,
              },
              {
                k: 'Elevated',
                v: nonViewerElevated,
                sub: 'non-viewer roles',
                ok: true,
                Icon: Zap,
              },
              {
                k: 'Webhooks',
                v: `${activeWebhookCount}/${hookDenom}`,
                sub: webhookAttention ? 'fix configuration' : 'healthy',
                ok: !webhookAttention,
                Icon: Webhook,
              },
            ].map((cell) => (
              <div key={cell.k} className={statCard}>
                <div className="flex items-start justify-between gap-2">
                  <span className="text-[11px] font-semibold text-zinc-600 dark:text-zinc-400">{cell.k}</span>
                  <cell.Icon className="h-4 w-4 shrink-0 text-zinc-400 opacity-80 dark:text-zinc-500" aria-hidden />
                </div>
                <div className="mt-2 font-mono text-xl font-semibold tabular-nums text-zinc-900 dark:text-zinc-50">{cell.v}</div>
                <div className="mt-0.5 flex items-center justify-between gap-1">
                  <span className="text-[11px] text-zinc-500 dark:text-zinc-500">{cell.sub}</span>
                  <span
                    className={cn(
                      'text-[10px] font-bold',
                      cell.ok ? 'text-emerald-600 dark:text-emerald-500' : 'text-amber-600 dark:text-amber-400',
                    )}
                    aria-hidden
                  >
                    {cell.ok ? '●' : '◆'}
                  </span>
                </div>
              </div>
            ))}
          </div>

          {/* Core Supabase tables — row counts & health */}
          <div className={cn(card, 'shrink-0 overflow-hidden p-0')}>
            <div className={panelHead}>
              <span className="text-xs font-semibold text-zinc-700 dark:text-zinc-200">Core data tables</span>
              <span
                className="rounded-md bg-zinc-200/70 px-2 py-0.5 font-mono text-[10px] text-zinc-600 dark:bg-zinc-800 dark:text-zinc-400"
                title="PostgREST row counts (exact); service role avoids RLS hiding rows"
              >
                {coreTables?.usedServiceRole ? 'service role' : 'anon key'}
              </span>
            </div>
            <ul className="divide-y divide-zinc-200/80 dark:divide-zinc-800/60" role="list">
              {(coreTables?.tables ?? []).length === 0 && (
                <li className="px-3 py-4 text-center text-sm text-zinc-500 dark:text-zinc-500">
                  No table metrics yet. Use Sync or check the API route{' '}
                  <span className="font-mono text-xs">/api/admin/data-tables-status</span>.
                </li>
              )}
              {(coreTables?.tables ?? []).map((t) => {
                const Icon = coreTableIcon(t.id);
                return (
                  <li key={t.id} className="flex gap-3 px-3 py-2.5">
                    <div
                      className={cn(
                        'flex h-9 w-9 shrink-0 items-center justify-center rounded-md border',
                        t.status === 'ok' && 'border-emerald-200/80 bg-emerald-50/80 dark:border-emerald-900/50 dark:bg-emerald-950/30',
                        t.status === 'warn' &&
                          'border-amber-200/80 bg-amber-50/80 dark:border-amber-900/50 dark:bg-amber-950/30',
                        t.status === 'error' && 'border-rose-200/80 bg-rose-50/80 dark:border-rose-900/50 dark:bg-rose-950/30',
                      )}
                    >
                      <Icon
                        className={cn(
                          'h-4 w-4',
                          t.status === 'ok' && 'text-emerald-700 dark:text-emerald-400',
                          t.status === 'warn' && 'text-amber-700 dark:text-amber-400',
                          t.status === 'error' && 'text-rose-700 dark:text-rose-400',
                        )}
                        aria-hidden
                      />
                    </div>
                    <div className="min-w-0 flex-1">
                      <div className="flex flex-wrap items-center gap-x-2 gap-y-0.5">
                        <span className="text-sm font-semibold text-zinc-900 dark:text-zinc-100">{t.label}</span>
                        <span
                          className={cn(
                            'rounded px-1.5 py-px text-[10px] font-bold uppercase tracking-wide',
                            t.status === 'ok' && 'bg-emerald-100 text-emerald-800 dark:bg-emerald-950/50 dark:text-emerald-300',
                            t.status === 'warn' && 'bg-amber-100 text-amber-900 dark:bg-amber-950/50 dark:text-amber-200',
                            t.status === 'error' && 'bg-rose-100 text-rose-900 dark:bg-rose-950/50 dark:text-rose-300',
                          )}
                        >
                          {t.status === 'ok' ? 'Healthy' : t.status === 'warn' ? 'Attention' : 'Error'}
                        </span>
                      </div>
                      <p className="mt-0.5 text-[12px] text-zinc-600 dark:text-zinc-400">{t.detail}</p>
                      <p className="mt-0.5 font-mono text-[10px] text-zinc-400 dark:text-zinc-600" title="Configured table name">
                        {t.tableName}
                      </p>
                    </div>
                    {t.rowCount != null && (
                      <div className="hidden shrink-0 text-right sm:block">
                        <div className="font-mono text-lg font-semibold tabular-nums text-zinc-900 dark:text-zinc-50">
                          {t.rowCount.toLocaleString()}
                        </div>
                        <div className="text-[10px] text-zinc-500">rows</div>
                      </div>
                    )}
                  </li>
                );
              })}
            </ul>
            {(coreTables?.hints?.length ?? 0) > 0 && (
              <div className="border-t border-zinc-200/90 bg-amber-50/50 px-3 py-2 dark:border-zinc-800/90 dark:bg-amber-950/20">
                <p className="text-[10px] font-semibold uppercase tracking-wide text-amber-900 dark:text-amber-200/90">
                  Notes
                </p>
                <ul className="mt-1 list-inside list-disc space-y-0.5 text-[11px] text-amber-950/90 dark:text-amber-100/80">
                  {(coreTables?.hints ?? []).map((h, i) => (
                    <li key={i}>{h}</li>
                  ))}
                </ul>
              </div>
            )}
          </div>

          <div className={cn(card, 'shrink-0 overflow-hidden p-0')}>
            <div className={panelHead}>
              <span className="text-xs font-semibold text-zinc-700 dark:text-zinc-200">Global master list CSV</span>
              <span className="text-[10px] font-medium text-amber-800 dark:text-amber-200/90">Full replace</span>
            </div>
            <div className="space-y-2 px-3 py-3 text-[12px] leading-relaxed text-zinc-600 dark:text-zinc-400">
              <p>
                CSV must be the <span className="font-medium">MASTERLIST</span> export: rows 1–2 include <span className="font-mono">MASTERLIST</span>, row 3 is
                headers, row 4+ data. Clears <span className="font-mono text-[11px] text-zinc-700 dark:text-zinc-300">global_master_list</span>, then inserts
                this file (sets <span className="font-mono text-[11px]">import_batch_id</span> when present). Requires{' '}
                <span className="font-mono text-[11px]">SUPABASE_SERVICE_ROLE_KEY</span> and <span className="font-mono text-[11px]">id</span>.
              </p>
              <p className="text-[11px] text-amber-950/90 dark:text-amber-100/85">
                This does not update <span className="font-mono">employee_hourly_rates</span>. If rates row counts fall short after import,
                sync rates before payroll.
              </p>
              <input
                ref={masterFileInputRef}
                type="file"
                accept=".csv,text/csv"
                className="hidden"
                onChange={(ev) => void onMasterCsvSelected(ev)}
              />
              <button
                type="button"
                onClick={() => onPickMasterCsv()}
                disabled={masterUploading || loading}
                className="inline-flex items-center rounded-md border border-zinc-200 bg-white px-2.5 py-1.5 text-[11px] font-medium text-zinc-700 hover:border-zinc-300 hover:text-zinc-900 disabled:opacity-50 dark:border-zinc-700 dark:bg-zinc-900/60 dark:text-zinc-200 dark:hover:border-zinc-600"
              >
                <CloudUpload className="mr-1.5 h-3.5 w-3.5" aria-hidden />
                {masterUploading ? 'Uploading…' : 'Choose CSV & import'}
              </button>
            </div>
          </div>

          <div className={cn(card, 'shrink-0 overflow-hidden p-0')}>
            <div className={panelHead}>
              <span className="text-xs font-semibold text-zinc-700 dark:text-zinc-200">Payroll rates CSV</span>
              <span className="text-[10px] font-medium text-emerald-800 dark:text-emerald-200/90">Upsert by work email</span>
            </div>
            <div className="space-y-2 px-3 py-3 text-[12px] leading-relaxed text-zinc-600 dark:text-zinc-400">
              <p>
                Export the <span className="font-medium">All Dept</span> sheet from the Payroll Dashboard xlsx. Only{' '}
                <span className="font-mono text-[11px]">Work Email</span>, <span className="font-mono text-[11px]">Personal Email</span>,{' '}
                <span className="font-mono text-[11px]">Week</span>, <span className="font-mono text-[11px]">Regular Rate</span> (col AD), and{' '}
                <span className="font-mono text-[11px]">OT Rate</span> (col AF) are read — all calculations happen in the UI.
              </p>
              <p className="text-[11px] text-emerald-950/90 dark:text-emerald-100/85">
                Multiple weekly rows per employee are expected. For each work email, the latest week&apos;s rate wins. Prior
                uploads stay in <span className="font-mono">employee_hourly_rates</span> tagged with their old{' '}
                <span className="font-mono">upload_id</span>.
              </p>
              <input
                ref={ratesFileInputRef}
                type="file"
                accept=".csv,text/csv"
                className="hidden"
                onChange={(ev) => void onRatesCsvSelected(ev)}
              />
              <button
                type="button"
                onClick={() => onPickRatesCsv()}
                disabled={ratesUploading || loading}
                className="inline-flex items-center rounded-md border border-zinc-200 bg-white px-2.5 py-1.5 text-[11px] font-medium text-zinc-700 hover:border-zinc-300 hover:text-zinc-900 disabled:opacity-50 dark:border-zinc-700 dark:bg-zinc-900/60 dark:text-zinc-200 dark:hover:border-zinc-600"
              >
                <CloudUpload className="mr-1.5 h-3.5 w-3.5" aria-hidden />
                {ratesUploading ? 'Uploading…' : 'Choose CSV & import'}
              </button>
            </div>
          </div>

          {/* Subsystem — fixed 4-up grid so rows stay aligned */}
          <div className={cn(card, 'shrink-0 p-3')}>
            <p className="mb-2 text-[11px] font-semibold text-zinc-600 dark:text-zinc-400">Services</p>
            <div className="grid grid-cols-2 gap-2 sm:grid-cols-4">
            {(
              [
                {
                  icon: Database,
                  label: 'Database',
                  val: databaseServicesTile.val,
                  ok: databaseServicesTile.ok,
                  sub: databaseServicesTile.sub,
                  nav: undefined,
                },
                {
                  icon: Webhook,
                  label: 'Webhooks',
                  val: webhookAttention ? `${misconfiguredWebhooks.length} misconfigured` : 'Healthy',
                  ok: !webhookAttention,
                  sub: webhookAttention ? 'Fix endpoints' : 'Integrations',
                  nav: 'webhooks' as const,
                },
                { icon: CloudUpload, label: 'Backups', val: 'Provider', ok: true, sub: 'Managed', nav: undefined },
                { icon: GitCommit, label: 'Build', val: 'Development', ok: true, sub: 'Environment', nav: undefined },
              ] as const
            ).map(({ icon: I, label, val, ok, sub, nav }) => {
              const inner = (
                <>
                  <I className={cn('h-4 w-4 shrink-0', ok ? 'text-zinc-400 dark:text-zinc-500' : 'text-amber-600 dark:text-amber-400')} aria-hidden />
                  <div className="min-w-0">
                    <div className="text-[10px] font-semibold uppercase tracking-wide text-zinc-500 dark:text-zinc-500">{label}</div>
                    <div className={cn('truncate text-xs font-medium', ok ? 'text-zinc-800 dark:text-zinc-300' : 'text-amber-800 dark:text-amber-300')}>
                      {val}
                    </div>
                    <div className="truncate text-[10px] text-zinc-500 dark:text-zinc-600">{sub}</div>
                  </div>
                </>
              );
              const className = cn(
                'flex min-h-[3.5rem] items-center gap-2 rounded-md border border-zinc-200/90 bg-zinc-50/80 px-2.5 py-2 dark:border-zinc-800/80 dark:bg-zinc-950/40',
                nav && !ok && 'cursor-pointer hover:border-amber-300/80 dark:hover:border-amber-700/50',
              );
              if (nav && !ok) {
                return (
                  <button key={label} type="button" className={className} onClick={() => onNavigate(nav)}>
                    {inner}
                  </button>
                );
              }
              return (
                <div key={label} className={className}>
                  {inner}
                </div>
              );
            })}
            </div>
          </div>

          {/* RBAC + hooks — equal-height columns */}
          <div className="grid min-h-0 min-w-0 flex-1 grid-cols-1 gap-3 overflow-hidden sm:grid-cols-2">
          {/* RBAC */}
          <div className={cn(card, 'h-full min-h-[200px] sm:min-h-0')}>
            <div className={panelHead}>
              <span className="text-xs font-semibold text-zinc-700 dark:text-zinc-200">Role mix</span>
              <button
                type="button"
                onClick={() => onNavigate('roles')}
                className="inline-flex items-center gap-0.5 text-[11px] font-medium text-emerald-700 hover:text-emerald-600 dark:text-emerald-400 dark:hover:text-emerald-300"
              >
                Manage
                <ArrowRight className="h-3 w-3" aria-hidden />
              </button>
            </div>
            <div className="flex min-h-0 flex-1 flex-col gap-3 overflow-hidden p-3 sm:flex-row sm:items-start">
              <div className="mx-auto flex shrink-0 sm:mx-0">
                <div className="relative h-[80px] w-[80px]">
                  <svg viewBox="0 0 36 36" className="size-full -rotate-90 text-zinc-200 dark:text-zinc-800">
                    <circle cx="18" cy="18" r="15.915" fill="none" stroke="currentColor" strokeWidth="3" />
                    {donutSegments.map((s) => (
                      <circle
                        key={s.key}
                        cx="18"
                        cy="18"
                        r="15.915"
                        fill="none"
                        stroke={s.color}
                        strokeWidth="3"
                        strokeDasharray={`${s.pct} ${100 - s.pct}`}
                        strokeDashoffset={-s.offset}
                      />
                    ))}
                  </svg>
                  <div className="pointer-events-none absolute inset-0 flex flex-col items-center justify-center">
                    <span className="font-mono text-base font-bold leading-none text-zinc-900 tabular-nums dark:text-zinc-50">
                      {elevatedTotal}
                    </span>
                    <span className="mt-0.5 text-[8px] font-medium uppercase tracking-wider text-zinc-400 dark:text-zinc-500">
                      total
                    </span>
                  </div>
                </div>
              </div>
              <div className="min-h-0 min-w-0 w-full sm:flex-1">
                <div className="w-full min-w-0">
                  <div className="mb-1 grid min-h-6 grid-cols-[12px_1fr_2.5rem] items-end gap-x-2 border-b border-zinc-200/90 pb-1.5 text-[8px] font-semibold uppercase tracking-wider text-zinc-400 dark:border-zinc-700/80 dark:text-zinc-500">
                    <div className="w-3 shrink-0" aria-hidden />
                    <span>Role</span>
                    <span className="text-right">N</span>
                  </div>
                  <ul className="min-h-0 list-none" role="list">
                    {ROLE_ORDER.map((r) => {
                      const c = roleCounts.get(r.key as RoleKey) ?? 0;
                      return (
                        <li
                          key={r.key}
                          className="grid min-h-7 grid-cols-[12px_1fr_2.5rem] items-center gap-x-2 border-b border-zinc-100 text-zinc-800 last:border-b-0 dark:border-zinc-800/60 dark:text-zinc-200"
                          title={r.blurb}
                        >
                          <div className="flex h-full min-h-7 items-center justify-center">
                            <span
                              className="h-2 w-2 shrink-0 rounded-[2px] ring-1 ring-inset ring-black/10 dark:ring-white/15"
                              style={{ background: r.color }}
                            />
                          </div>
                          <span className="min-w-0 pr-0.5 font-mono text-[10px] leading-tight text-zinc-800 dark:text-zinc-200">
                            {r.label}
                          </span>
                          <span className="text-right font-mono text-[10px] font-semibold tabular-nums text-zinc-900 dark:text-zinc-100">
                            {c}
                          </span>
                        </li>
                      );
                    })}
                  </ul>
                </div>
              </div>
            </div>
          </div>

          {/* Hooks */}
          <div className={cn(card, 'h-full min-h-[200px] sm:min-h-0')}>
            <div className={panelHead}>
              <span className="text-xs font-semibold text-zinc-700 dark:text-zinc-200">Hooks</span>
              <button
                type="button"
                onClick={() => onNavigate('webhooks')}
                className="inline-flex items-center gap-0.5 text-[11px] font-medium text-emerald-700 hover:text-emerald-600 dark:text-emerald-400 dark:hover:text-emerald-300"
              >
                Configure
                <ArrowRight className="h-3 w-3" aria-hidden />
              </button>
            </div>
            <div className="flex min-h-0 flex-1 flex-col divide-y divide-zinc-200/80 overflow-hidden dark:divide-zinc-800/60">
              {[
                {
                  dot: paystub?.active && paystub.url?.trim() ? 'bg-emerald-500' : 'bg-rose-500',
                  name: 'paystub_dispatch',
                  meta: paystub?.url?.trim() ? paystub.url : '∅ url',
                  code: paystub?.active && paystub.url?.trim() ? '200' : '—',
                },
                { dot: 'bg-emerald-500', name: 'hubstaff_ingest', meta: hubstaffUrl, code: '200' },
                { dot: 'bg-emerald-500', name: 'master_list_ingest', meta: masterListUrl, code: '200' },
                { dot: 'bg-zinc-400 dark:bg-zinc-600', name: 'slack_notify', meta: 'off', code: '—' },
              ].map((row) => (
                <div key={row.name} className="grid grid-cols-[6px_1fr_auto] items-center gap-2 px-3 py-2">
                  <span className={cn('h-2 w-2 rounded-sm', row.dot)} />
                  <div className="min-w-0">
                    <div className="truncate font-mono text-[10px] text-zinc-800 dark:text-zinc-300">{row.name}</div>
                    <div className="truncate text-[9px] text-zinc-500 dark:text-zinc-600">{row.meta}</div>
                  </div>
                  <span className="font-mono text-[10px] tabular-nums text-zinc-500">{row.code}</span>
                </div>
              ))}
            </div>
          </div>
          </div>
          </div>

          {/* Right — audit (same height as left column) */}
          <div
            className={cn(
              card,
              'flex min-h-[280px] w-full min-w-0 shrink-0 flex-col lg:min-h-0 lg:w-0 lg:flex-1',
            )}
          >
            <div className={cn(panelHead, 'flex-wrap gap-y-2')}>
              <div className="flex items-center gap-2">
                <span className="text-xs font-semibold text-zinc-700 dark:text-zinc-200">Recent audit</span>
                <span className="hidden rounded bg-zinc-200/80 px-1.5 py-px font-mono text-[10px] text-zinc-600 dark:bg-zinc-800 dark:text-zinc-400 xl:inline">
                  {auditTotalHint} loaded
                </span>
              </div>
              <div className="flex min-w-[12rem] max-w-full flex-1 basis-full items-center gap-2 sm:basis-auto lg:min-w-0">
                <div className="flex min-w-0 flex-1 items-center gap-1.5 rounded-md border border-zinc-200 bg-white/90 px-2 py-1.5 dark:border-zinc-800 dark:bg-zinc-950/60">
                  <Search className="h-3.5 w-3.5 shrink-0 text-zinc-400 dark:text-zinc-600" aria-hidden />
                  <input
                    type="search"
                    value={search}
                    onChange={(e) => setSearch(e.target.value)}
                    placeholder="Filter events…"
                    className="min-w-0 flex-1 border-0 bg-transparent text-xs text-zinc-800 outline-none placeholder:text-zinc-400 dark:text-zinc-200 dark:placeholder:text-zinc-600"
                  />
                </div>
                <button
                  type="button"
                  onClick={() => onNavigate('audit')}
                  className="inline-flex shrink-0 items-center gap-0.5 text-[11px] font-medium text-emerald-700 hover:text-emerald-600 dark:text-emerald-400 dark:hover:text-emerald-300"
                >
                  Full log
                  <ArrowRight className="h-3 w-3" aria-hidden />
                </button>
              </div>
            </div>
            <div className="flex min-h-0 flex-1 flex-col overflow-hidden">
              {filteredAudit.length === 0 ? (
                <div className="flex min-h-[8rem] flex-1 items-center justify-center px-4 text-center text-xs text-zinc-500 dark:text-zinc-500">
                  {auditRows.length === 0 ? 'No audit events in this sample.' : 'No rows match your filter.'}
                </div>
              ) : (
                <ul className="min-h-0 flex-1 list-none overflow-y-auto overscroll-contain">
                  {filteredAudit.map((e) => {
                    const kind = auditRowKind(e.action);
                    const tag = levelTag(kind);
                    return (
                      <li
                        key={e.id}
                        className="flex shrink-0 items-center gap-2 border-b border-zinc-200/80 px-3 py-2 text-[11px] last:border-b-0 dark:border-zinc-800/40"
                      >
                        <span className="w-11 shrink-0 tabular-nums text-zinc-500 dark:text-zinc-600">
                          {formatRelativeTime(e.created_at)}
                        </span>
                        <span
                          className={cn(
                            'w-7 shrink-0 text-center font-bold',
                            kind === 'danger' && 'text-rose-600 dark:text-rose-400',
                            kind === 'warn' && 'text-amber-600 dark:text-amber-400',
                            kind === 'ok' && 'text-emerald-600 dark:text-emerald-400',
                            kind === 'info' && 'text-sky-600 dark:text-sky-400',
                          )}
                        >
                          {tag}
                        </span>
                        <span className="min-w-0 flex-1 truncate text-zinc-800 dark:text-zinc-300" title={formatActionLabel(e.action, e.details)}>
                          {formatActionLabel(e.action, e.details)}
                        </span>
                        <span className="hidden w-24 shrink-0 truncate text-right text-zinc-500 sm:block" title={e.user_name}>
                          {e.user_name || '—'}
                        </span>
                      </li>
                    );
                  })}
                </ul>
              )}
            </div>
            <div className="flex shrink-0 flex-wrap items-center justify-between gap-2 border-t border-zinc-200/90 bg-zinc-50/90 px-3 py-2 text-[11px] text-zinc-600 dark:border-zinc-800/90 dark:bg-zinc-900/50 dark:text-zinc-500">
              <span>
                Showing{' '}
                <span className="font-mono font-semibold tabular-nums text-zinc-800 dark:text-zinc-300">
                  {filteredAudit.length}
                </span>{' '}
                of{' '}
                <span className="font-mono tabular-nums text-zinc-700 dark:text-zinc-400">{auditRows.length}</span>{' '}
                in this preview
              </span>
              <button
                type="button"
                onClick={() => onNavigate('audit')}
                className="font-medium text-emerald-700 hover:underline dark:text-emerald-400"
              >
                Search and paginate in Audit log →
              </button>
            </div>
          </div>
        </div>
        </div>
      )}

      <footer className="flex shrink-0 items-center justify-between border-t border-zinc-200 px-3 py-1 text-[9px] text-zinc-500 dark:border-zinc-800 dark:text-zinc-600">
        <span>
          <span className="text-zinc-400 dark:text-zinc-700">#</span> simple-hris · ctlplane
        </span>
        <button
          type="button"
          onClick={() => void load()}
          className="text-zinc-500 hover:text-emerald-600 dark:hover:text-emerald-400"
        >
          refresh
        </button>
      </footer>
    </div>
  );
}
