'use client';

/**
 * System Diagnostics — Admin-only health map.
 *
 * Visibility: rendered only when activeTab === 'diagnostics' inside the Admin shell
 * (app/admin/page.tsx). The Accounting / Employee / Manager / Orphanage portals do NOT
 * mount this component.
 *
 * TODO: enforce full RBAC once admin auth gate is wired. Today the page-level admin
 * gate is best-effort, so secrets must stay out of this UI per the security rules
 * (no hashes, no service keys, no DATABASE_URL, no employee PII, no SQL text or
 * stack traces).
 *
 * Data source: today this is a local mock (`buildMockDiagnostics`). When real
 * monitoring lands (a `/api/admin/diagnostics` endpoint), swap the fetch in
 * `loadDiagnostics()` and keep the same shape.
 *
 * Service map visual: modeled after the Supabase Schema Visualiser. Each node is a
 * draggable "table card" with a status-tinted header and rows that resemble columns.
 * Edges connect right→left handles. The initial layout (`NODE_POSITIONS`) is a
 * "template" — users can drag freely, positions persist to localStorage by node id,
 * and a Reset Layout button restores the template.
 */

import React, { useCallback, useEffect, useMemo, useState } from 'react';
import {
  ReactFlow,
  BaseEdge,
  Background,
  Controls,
  Handle,
  MarkerType,
  MiniMap,
  Panel,
  Position,
  getBezierPath,
  useNodesState,
  type Edge,
  type EdgeProps,
  type EdgeTypes,
  type Node,
  type NodeChange,
  type NodeProps,
} from '@xyflow/react';
import '@xyflow/react/dist/style.css';
import { motion, AnimatePresence } from 'motion/react';
import {
  Activity,
  AlertTriangle,
  BarChart3,
  Banknote,
  CheckCircle2,
  CircleDashed,
  Clock,
  Database,
  DollarSign,
  FileSpreadsheet,
  FileText,
  Image as ImageIcon,
  KeyRound,
  LayoutDashboard,
  Plug,
  Settings,
  RefreshCw,
  Radar as RadarIcon,
  RotateCcw,
  ScrollText,
  Server,
  ShieldAlert,
  Sparkles,
  Tag,
  Users,
  Wrench,
  XCircle,
} from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { Card } from '@/components/ui/card';
import { ScrollArea } from '@/components/ui/scroll-area';
import { Separator } from '@/components/ui/separator';
import { cn } from '@/lib/utils';

/* ────────────────── Types ────────────────── */

export type DiagnosticStatus = 'healthy' | 'warning' | 'critical' | 'unknown';

export type DiagnosticCategory =
  | 'admin-ui'
  | 'payroll'
  | 'rates'
  | 'csv'
  | 'employee-data'
  | 'database'
  | 'auth'
  | 'audit'
  | 'reports'
  | 'infra'
  | 'config'
  | 'integration'
  | 'manager';

/** A concrete remediation step. `kind` lets the UI hint at the type of action:
 *  config = settings/env tweak, code = source change, db = SQL/migration,
 *  ops = operational/manual step, monitor = observability/audit-only. */
export type DiagnosticFix = {
  title: string;
  description: string;
  kind?: 'config' | 'code' | 'db' | 'ops' | 'monitor';
  /** Optional file path or command shown verbatim under the fix. */
  hint?: string;
};

export type DiagnosticNode = {
  id: string;
  label: string;
  category: DiagnosticCategory;
  status: DiagnosticStatus;
  summary: string;
  details: string[];
  suggestedChecks: string[];
  /** Concrete fixes/remediations for this node. Optional — older API responses
   *  without this field keep working; the UI just hides the section. */
  suggestedFixes?: DiagnosticFix[];
  lastChecked: string;
};

export type DiagnosticAlert = {
  id: string;
  severity: DiagnosticStatus;
  title: string;
  description: string;
  nodeId: string;
  timestamp: string;
};

export type DiagnosticsHealthResponse = {
  overallStatus: DiagnosticStatus;
  nodes: DiagnosticNode[];
  alerts: DiagnosticAlert[];
};

/* ────────────────── Status palette ────────────────── */

const STATUS_LABEL: Record<DiagnosticStatus, string> = {
  healthy: 'Healthy',
  warning: 'Warning',
  critical: 'Critical',
  unknown: 'Unknown',
};

/** Tailwind class bundles + edge stroke for each status. Tokens follow the rest of
 *  the dashboard (orange/zinc light, blue/zinc dark). */
const STATUS_CLASSES: Record<
  DiagnosticStatus,
  {
    badge: string;
    headerBg: string;
    headerBorder: string;
    headerText: string;
    accentDot: string;
    edge: string;
    iconColor: string;
    softTint: string;
  }
> = {
  healthy: {
    badge:
      'border-emerald-200 bg-emerald-50 text-emerald-700 dark:border-emerald-900/60 dark:bg-emerald-950/40 dark:text-emerald-400',
    headerBg:
      'bg-gradient-to-r from-emerald-500/10 via-emerald-500/5 to-transparent dark:from-emerald-500/20 dark:via-emerald-500/10',
    headerBorder: 'border-emerald-200/70 dark:border-emerald-800/50',
    headerText: 'text-emerald-900 dark:text-emerald-100',
    accentDot: 'bg-emerald-500',
    edge: '#10b981',
    iconColor: 'text-emerald-600 dark:text-emerald-400',
    softTint: 'bg-emerald-50/40 dark:bg-emerald-950/20',
  },
  warning: {
    badge:
      'border-amber-200 bg-amber-50 text-amber-800 dark:border-amber-900/60 dark:bg-amber-950/40 dark:text-amber-300',
    headerBg:
      'bg-gradient-to-r from-amber-500/10 via-amber-500/5 to-transparent dark:from-amber-500/20 dark:via-amber-500/10',
    headerBorder: 'border-amber-200/70 dark:border-amber-800/50',
    headerText: 'text-amber-900 dark:text-amber-100',
    accentDot: 'bg-amber-500',
    edge: '#f59e0b',
    iconColor: 'text-amber-600 dark:text-amber-400',
    softTint: 'bg-amber-50/40 dark:bg-amber-950/20',
  },
  critical: {
    badge:
      'border-rose-200 bg-rose-50 text-rose-700 dark:border-rose-900/60 dark:bg-rose-950/40 dark:text-rose-400',
    headerBg:
      'bg-gradient-to-r from-rose-500/10 via-rose-500/5 to-transparent dark:from-rose-500/20 dark:via-rose-500/10',
    headerBorder: 'border-rose-200/70 dark:border-rose-800/50',
    headerText: 'text-rose-900 dark:text-rose-100',
    accentDot: 'bg-rose-500',
    edge: '#ef4444',
    iconColor: 'text-rose-600 dark:text-rose-400',
    softTint: 'bg-rose-50/40 dark:bg-rose-950/20',
  },
  unknown: {
    badge:
      'border-zinc-200 bg-zinc-50 text-zinc-600 dark:border-zinc-800 dark:bg-zinc-900/60 dark:text-zinc-400',
    headerBg:
      'bg-gradient-to-r from-zinc-200/50 via-zinc-200/20 to-transparent dark:from-zinc-700/30 dark:via-zinc-700/15',
    headerBorder: 'border-zinc-200 dark:border-zinc-800',
    headerText: 'text-zinc-800 dark:text-zinc-200',
    accentDot: 'bg-zinc-400',
    edge: '#71717a',
    iconColor: 'text-zinc-500 dark:text-zinc-400',
    softTint: 'bg-zinc-50/60 dark:bg-zinc-900/40',
  },
};

const CATEGORY_LABEL: Record<DiagnosticCategory, string> = {
  'admin-ui': 'admin_ui',
  payroll: 'payroll',
  rates: 'rates',
  csv: 'csv_import',
  'employee-data': 'employee_data',
  database: 'database',
  auth: 'auth',
  audit: 'audit',
  reports: 'reports',
  infra: 'infra',
  config: 'config',
  integration: 'integration',
  manager: 'manager',
};

/** Category-specific glyph for the node header — gives each card a visual
 *  fingerprint so admins can pick services out of the map at a glance instead
 *  of reading every label. */
const CATEGORY_ICON: Record<DiagnosticCategory, React.ComponentType<{ className?: string }>> = {
  'admin-ui': LayoutDashboard,
  payroll: Banknote,
  rates: DollarSign,
  csv: FileSpreadsheet,
  'employee-data': Users,
  database: Database,
  auth: KeyRound,
  audit: ScrollText,
  reports: BarChart3,
  infra: Server,
  config: Settings,
  integration: Plug,
  manager: ImageIcon,
};

const FIX_KIND_LABEL: Record<NonNullable<DiagnosticFix['kind']>, string> = {
  config: 'config',
  code: 'code',
  db: 'db',
  ops: 'ops',
  monitor: 'monitor',
};

/* ────────────────── Mock data ────────────────── */

function buildMockDiagnostics(now = new Date()): DiagnosticsHealthResponse {
  const iso = now.toISOString();

  const nodes: DiagnosticNode[] = [
    {
      id: 'admin-shell',
      label: 'Admin SPA Shell',
      category: 'admin-ui',
      status: 'healthy',
      summary: 'Tab-based shell rendering normally.',
      details: [
        'src/App.tsx switches via activeTab; no URL routes for admin tabs.',
        'Sidebar nav and ViewSwitcher follow allowedAccountingTabsForRoles().',
      ],
      suggestedChecks: [
        'Verify activeTab default redirects when role lacks access.',
        'Confirm employee portal stays isolated under /employee.',
      ],
      lastChecked: iso,
    },
    {
      id: 'payroll-wizard',
      label: 'Payroll Wizard / Friday Path',
      category: 'payroll',
      status: 'warning',
      summary: 'Payroll workflow should be checked for CSV/date-column mismatches.',
      details: [
        'Friday cycle pulls Hubstaff CSV → Master List → Disbursement Records.',
        'Failure modes seen: missing daily columns, mis-dated totals.',
      ],
      suggestedChecks: [
        'Confirm Hubstaff export columns match expected daily slots.',
        'Verify the calendar-column-dedupe map for the latest upload.',
        'Spot-check totals against a single employee’s expected pay.',
      ],
      suggestedFixes: [
        {
          title: 'Re-import the latest Hubstaff CSV',
          description:
            'Pull a fresh export and re-run the import — fixes most stale-column / mis-dated total issues without code changes.',
          kind: 'ops',
          hint: 'Admin → Payroll Wizard → Import Hubstaff',
        },
        {
          title: 'Tighten daily-column header detection',
          description:
            'Reject rows where any expected daily slot maps to null instead of silently coercing to 0; surfaces broken exports immediately.',
          kind: 'code',
          hint: 'src/lib/payroll/hubstaff-import.ts',
        },
      ],
      lastChecked: iso,
    },
    {
      id: 'rates',
      label: 'Rates Management',
      category: 'rates',
      status: 'healthy',
      summary: 'Rates merge engine reading from rates + master list.',
      details: [
        'Cards/table toggle wired to /api/employee-rate-profiles.',
        'Suspended rows render dimmed; missing-rate badges surfaced.',
      ],
      suggestedChecks: [
        'Confirm “Missing Regular Rate” count matches HR’s expectation.',
        'Spot-check one employee end-to-end (Master → Rates → Profile).',
      ],
      lastChecked: iso,
    },
    {
      id: 'hubstaff-csv',
      label: 'Hubstaff CSV Import',
      category: 'csv',
      status: 'warning',
      summary: 'Daily columns may be missing or mapped to null.',
      details: [
        'Importer expects fixed daily slots; nulls slip through silently.',
        'Affects Payroll Wizard and Disbursement Records downstream.',
      ],
      suggestedChecks: [
        'Validate header detection on the latest upload.',
        'Reject rows with null daily totals before persistence.',
      ],
      suggestedFixes: [
        {
          title: 'Add a pre-persist null guard',
          description:
            'Throw before insert when any daily slot is null so the importer fails loudly rather than producing zero-pay rows downstream.',
          kind: 'code',
          hint: 'src/lib/payroll/hubstaff-import.ts → validateRow()',
        },
        {
          title: 'Surface a dry-run preview',
          description:
            'Show parsed rows + detected day columns before commit; admin clicks confirm only when the mapping is correct.',
          kind: 'code',
        },
      ],
      lastChecked: iso,
    },
    {
      id: 'master-list',
      label: 'Employee Master List',
      category: 'employee-data',
      status: 'healthy',
      summary: 'Master roster CSV replace working as expected.',
      details: [
        'active_employees view filters to current upload’s last_seen_upload_id.',
        'Address + Google photo columns surfaced after migration refresh.',
      ],
      suggestedChecks: [
        'Confirm view exposes recently-added columns.',
        'Watch for duplicate Work Email rows after CSV import.',
      ],
      lastChecked: iso,
    },
    {
      id: 'supabase-client',
      label: 'Supabase Client',
      category: 'infra',
      status: 'healthy',
      summary: 'Anon + service-role clients initialising on the server.',
      details: [
        'Env-driven configuration; routes select the appropriate role per intent.',
        'PostgREST handles select shape errors with try-with-fallback in lib code.',
      ],
      suggestedChecks: [
        'Periodically test anon-key reads from a non-elevated session.',
        'Audit which routes use service-role and why.',
      ],
      lastChecked: iso,
    },
    {
      id: 'supabase-postgres',
      label: 'Supabase Postgres / RLS',
      category: 'database',
      status: 'warning',
      summary: 'Service-role fallback paths require careful monitoring.',
      details: [
        'Several admin actions use the service-role client to bypass RLS.',
        'View definitions must be refreshed after table-level ADD COLUMN.',
      ],
      suggestedChecks: [
        'Review service-role usage list quarterly.',
        'Confirm pending migrations applied (see references/seed_*.sql).',
      ],
      suggestedFixes: [
        {
          title: 'Apply pending migrations',
          description:
            'Run the unapplied SQL files from the references/ folder against staging first, then prod.',
          kind: 'db',
          hint: 'references/seed_*.sql',
        },
        {
          title: 'Refresh dependent views after ADD COLUMN',
          description:
            'Re-create active_employees and any view that selects * from a changed table so new columns propagate.',
          kind: 'db',
        },
        {
          title: 'Audit service-role call sites',
          description:
            'List every route using the service-role client and confirm each one genuinely needs RLS bypass.',
          kind: 'code',
          hint: 'grep service-role-client',
        },
      ],
      lastChecked: iso,
    },
    {
      id: 'pg-pool',
      label: 'pg Pool / Direct Postgres',
      category: 'database',
      status: 'healthy',
      summary: 'Direct pg pool reads stable when DATABASE_URL is configured.',
      details: [
        'Used for table introspection and bulk import paths.',
        'Falls back to PostgREST when DATABASE_URL is absent.',
      ],
      suggestedChecks: [
        'Verify pool size and connection caps match deployment plan.',
      ],
      lastChecked: iso,
    },
    {
      id: 'daily-report',
      label: 'Daily Report Import',
      category: 'reports',
      status: 'warning',
      summary: 'Direct pg schema/table creation should be monitored.',
      details: [
        'Importer can create tables on demand based on report shape.',
        'Schema drift between imports needs human-readable change log.',
      ],
      suggestedChecks: [
        'Inspect the latest auto-created table’s column list.',
        'Confirm naming conventions match downstream readers.',
      ],
      suggestedFixes: [
        {
          title: 'Pin the import schema',
          description:
            'Switch from on-demand CREATE TABLE to a versioned schema with explicit migrations; auto-detected columns become opt-in additions, not silent mutations.',
          kind: 'db',
        },
        {
          title: 'Emit a schema-diff log line per import',
          description:
            'Record added/removed columns in audit_log so downstream readers can be patched before they break.',
          kind: 'monitor',
        },
      ],
      lastChecked: iso,
    },
    {
      id: 'auth-login',
      label: 'Employee / Accounting Login',
      category: 'auth',
      status: 'warning',
      summary: 'Admin gate is not fully enforced yet.',
      details: [
        'NextAuth + Google SSO restricted to the company workspace.',
        'Tab-level RBAC (allowedAccountingTabsForRoles) is best-effort today.',
      ],
      suggestedChecks: [
        'Add server-side admin checks on destructive routes.',
        'Audit sessionStorage-driven role lookups for tampering risk.',
      ],
      suggestedFixes: [
        {
          title: 'Wrap destructive routes with a server-side admin guard',
          description:
            'Every POST/DELETE under /api/admin should re-check the session role server-side; never trust the client tab gate.',
          kind: 'code',
          hint: 'middleware.ts + /api/admin/* handlers',
        },
        {
          title: 'Move role lookups off sessionStorage',
          description:
            'Resolve role from the signed JWT or a server-issued cookie so a user can\'t edit their role in DevTools.',
          kind: 'code',
        },
        {
          title: 'Log unauthorised attempts to audit_log',
          description:
            'Write a row whenever a non-admin hits a guarded endpoint; turns silent denials into something investigable.',
          kind: 'monitor',
        },
      ],
      lastChecked: iso,
    },
    {
      id: 'audit-log',
      label: 'Audit Log',
      category: 'audit',
      status: 'healthy',
      summary: 'Login success/failure events are written to audit_log.',
      details: [
        'Approve/deny/delete actions also logged with role + actor email.',
        'Useful for reconstructing destructive operations after the fact.',
      ],
      suggestedChecks: [
        'Confirm retention policy on audit_log rows.',
        'Spot-check that admin_deleted entries include prior_status snapshot.',
      ],
      lastChecked: iso,
    },
    {
      id: 'disbursement-records',
      label: 'Disbursement Records',
      category: 'reports',
      status: 'healthy',
      summary: 'Flat weekly report table available.',
      details: [
        'Per-(week, employee) snapshot powering Reports tab.',
        'Sync triggers from payment_dispatches keep statuses fresh.',
      ],
      suggestedChecks: [
        'Verify trigger health after any payment_dispatches schema change.',
      ],
      lastChecked: iso,
    },
    {
      id: 'app-settings',
      label: 'App Settings (config bag)',
      category: 'config',
      status: 'healthy',
      summary: 'Runtime config table reachable.',
      details: [
        'Backs PAB period, dispatch lock, feature permissions, force-logout map.',
        'Prefer /api/app-settings?keys=a,b,c for multi-key reads.',
      ],
      suggestedChecks: [
        'Confirm auth.force_logout_map row is a valid JSON object.',
      ],
      lastChecked: iso,
    },
    {
      id: 'google-sheet-sync',
      label: 'Google Sheet Sync',
      category: 'integration',
      status: 'warning',
      summary: 'Manual sync — recency depends on operator action.',
      details: [
        'Master + rates each pulled via a button in Admin → CSV Imports.',
        'Not on cron; staleness here is a heads-up, not a failure.',
      ],
      suggestedChecks: [
        'Run a manual sync if the last run is older than a week.',
        'Verify GOOGLE_SHEETS_* env vars when a sync fails.',
      ],
      lastChecked: iso,
    },
    {
      id: 'rate-history',
      label: 'Rate History',
      category: 'rates',
      status: 'healthy',
      summary: 'Per-day rate resolution table available.',
      details: [
        'Authoritative source for mid-cycle prorating.',
        'Used by current-pay.ts + member-monthly-pay.ts.',
      ],
      suggestedChecks: [
        'Confirm effectiveDate is passed when editing a rate mid-cycle.',
      ],
      lastChecked: iso,
    },
    {
      id: 'manager-wallpapers',
      label: 'Manager Team Wallpapers',
      category: 'manager',
      status: 'healthy',
      summary: 'Per-department banner table reachable.',
      details: [
        'Inline data-URL images (~10 MB cap per row).',
        'background_position column added via idempotent ALTER.',
      ],
      suggestedChecks: [
        'Spot-check one banner renders for the corresponding department.',
      ],
      lastChecked: iso,
    },
  ];

  const alerts: DiagnosticAlert[] = [
    {
      id: 'alert-admin-gate',
      severity: 'warning',
      title: 'Admin gate not fully enforced',
      description:
        'Tab visibility is gated client-side; destructive endpoints still need server-side admin checks.',
      nodeId: 'auth-login',
      timestamp: iso,
    },
    {
      id: 'alert-csv-nulls',
      severity: 'warning',
      title: 'CSV daily values may be null after upload',
      description:
        'Daily column detection occasionally maps to null, silently skewing Payroll Wizard totals.',
      nodeId: 'hubstaff-csv',
      timestamp: iso,
    },
    {
      id: 'alert-service-role',
      severity: 'warning',
      title: 'Service-role client fallback should be reviewed',
      description:
        'Several admin paths use the service-role client to bypass RLS. Review usage and tighten where possible.',
      nodeId: 'supabase-postgres',
      timestamp: iso,
    },
    {
      id: 'alert-direct-pg',
      severity: 'warning',
      title: 'Direct Postgres import path needs monitoring',
      description:
        'Daily report import can auto-create tables. Track schema drift to avoid downstream breakage.',
      nodeId: 'daily-report',
      timestamp: iso,
    },
  ];

  const overall: DiagnosticStatus = nodes.some((n) => n.status === 'critical')
    ? 'critical'
    : nodes.some((n) => n.status === 'warning')
      ? 'warning'
      : nodes.every((n) => n.status === 'healthy')
        ? 'healthy'
        : 'unknown';

  return { overallStatus: overall, nodes, alerts };
}

/* ────────────────── Layout template ──────────────────
 * Curated default positions — the "template arrangement" the user can reset to.
 * Spaced so 280-wide cards don't overlap.
 */

const NODE_POSITIONS: Record<string, { x: number; y: number }> = {
  'admin-shell':           { x: 40,   y: 320 },
  'payroll-wizard':        { x: 380,  y: 60  },
  rates:                   { x: 380,  y: 600 },
  'hubstaff-csv':          { x: 740,  y: -40 },
  'master-list':           { x: 740,  y: 200 },
  'disbursement-records':  { x: 740,  y: 440 },
  'supabase-client':       { x: 1100, y: 380 },
  'supabase-postgres':     { x: 1460, y: 380 },
  'pg-pool':               { x: 1100, y: 660 },
  'daily-report':          { x: 740,  y: 660 },
  'auth-login':            { x: 380,  y: 880 },
  'audit-log':             { x: 1100, y: 880 },
  'app-settings':          { x: 1460, y: 60  },
  'google-sheet-sync':     { x: 40,   y: 60  },
  'rate-history':          { x: 1100, y: 600 },
  'manager-wallpapers':    { x: 40,   y: 600 },
};

const EDGES: { source: string; target: string }[] = [
  { source: 'admin-shell', target: 'payroll-wizard' },
  { source: 'admin-shell', target: 'rates' },
  { source: 'payroll-wizard', target: 'hubstaff-csv' },
  { source: 'payroll-wizard', target: 'master-list' },
  { source: 'payroll-wizard', target: 'disbursement-records' },
  { source: 'rates', target: 'supabase-client' },
  { source: 'hubstaff-csv', target: 'supabase-client' },
  { source: 'master-list', target: 'supabase-client' },
  { source: 'supabase-client', target: 'supabase-postgres' },
  { source: 'daily-report', target: 'pg-pool' },
  { source: 'pg-pool', target: 'supabase-postgres' },
  { source: 'auth-login', target: 'audit-log' },
  { source: 'auth-login', target: 'supabase-postgres' },
  { source: 'google-sheet-sync', target: 'master-list' },
  { source: 'google-sheet-sync', target: 'rates' },
  { source: 'app-settings', target: 'supabase-postgres' },
  { source: 'auth-login', target: 'app-settings' },
  { source: 'rates', target: 'rate-history' },
  { source: 'rate-history', target: 'supabase-client' },
  { source: 'manager-wallpapers', target: 'supabase-client' },
];

const POSITIONS_STORAGE_KEY = 'system-diagnostics-positions-v1';

function loadStoredPositions(): Record<string, { x: number; y: number }> {
  if (typeof window === 'undefined') return {};
  try {
    const raw = window.localStorage.getItem(POSITIONS_STORAGE_KEY);
    if (!raw) return {};
    const parsed = JSON.parse(raw) as Record<string, { x: number; y: number }>;
    return parsed && typeof parsed === 'object' ? parsed : {};
  } catch {
    return {};
  }
}

function persistPositions(positions: Record<string, { x: number; y: number }>) {
  if (typeof window === 'undefined') return;
  try {
    window.localStorage.setItem(POSITIONS_STORAGE_KEY, JSON.stringify(positions));
  } catch {
    /* ignore storage quota / privacy mode */
  }
}

/* ────────────────── Schema-style node ────────────────── */

type DiagNodeData = {
  diag: DiagnosticNode;
  selected: boolean;
};

/** A small left-icon + name + value row, modeled after Supabase column rows. */
function SchemaRow({
  icon: Icon,
  name,
  type,
  value,
  valueClassName,
  hairline = true,
}: {
  icon: React.ComponentType<{ className?: string }>;
  name: string;
  type?: string;
  value: React.ReactNode;
  valueClassName?: string;
  hairline?: boolean;
}) {
  return (
    <div
      className={cn(
        'flex items-center gap-2 px-3 py-1.5',
        hairline && 'border-t border-zinc-100 first:border-t-0 dark:border-zinc-800/60',
      )}
    >
      <Icon className="h-3 w-3 shrink-0 text-zinc-400 dark:text-zinc-500" />
      <span className="font-mono text-[10.5px] text-zinc-500 dark:text-zinc-400">{name}</span>
      {type && (
        <span className="font-mono text-[9.5px] uppercase tracking-wider text-zinc-300 dark:text-zinc-600">
          {type}
        </span>
      )}
      <span
        className={cn(
          'ml-auto truncate text-right text-[11px] text-zinc-700 dark:text-zinc-200',
          valueClassName,
        )}
      >
        {value}
      </span>
    </div>
  );
}

const DiagFlowNode = React.memo(function DiagFlowNode({
  data,
  selected: rfSelected,
}: NodeProps<Node<DiagNodeData>>) {
  const { diag, selected } = data;
  const palette = STATUS_CLASSES[diag.status];
  const isSelected = selected || rfSelected;
  const isAttention = diag.status === 'warning' || diag.status === 'critical';
  const fixCount = diag.suggestedFixes?.length ?? 0;
  const CategoryGlyph = CATEGORY_ICON[diag.category] ?? Database;
  return (
    <div
      className={cn(
        'group relative w-[284px] overflow-hidden rounded-xl border bg-white shadow-md transition-all duration-200 dark:bg-zinc-950',
        'border-zinc-200/90 dark:border-zinc-800',
        // Soft status glow on warning/critical so trouble spots are visible at a
        // glance even when zoomed out — kept low-opacity so it doesn't dominate.
        isAttention && diag.status === 'warning' && 'shadow-amber-500/10 dark:shadow-amber-500/15',
        isAttention && diag.status === 'critical' && 'shadow-rose-500/15 dark:shadow-rose-500/20',
        isSelected
          ? 'ring-2 ring-orange-500/60 shadow-lg shadow-orange-500/15 dark:ring-orange-400/50'
          : 'hover:shadow-lg hover:-translate-y-px hover:shadow-zinc-900/10 dark:hover:shadow-black/40',
      )}
    >
      {/* Status accent stripe — full-height bar on the left edge, color-matched
          to the node status. Reads as a "tab" you'd see in an IDE / error list. */}
      <span
        aria-hidden
        className={cn('absolute inset-y-0 left-0 w-[3px]', palette.accentDot)}
      />

      {/* Edge handles — anchored to the card sides so connections stay stable
          while users drag. Made visually invisible (transparent + no border) so
          edges appear to dock directly to the card edge instead of into a dot. */}
      <Handle
        type="target"
        position={Position.Left}
        className="!h-2 !w-2 !-translate-x-[1px] !border-0 !bg-transparent !opacity-0"
        style={{ top: '50%' }}
      />
      <Handle
        type="source"
        position={Position.Right}
        className="!h-2 !w-2 !translate-x-[1px] !border-0 !bg-transparent !opacity-0"
        style={{ top: '50%' }}
      />

      {/* Header — drag handle (the whole card is draggable; this just looks like one). */}
      <div
        className={cn(
          'relative flex items-center gap-2 border-b px-3 py-2.5 pl-3.5',
          palette.headerBg,
          palette.headerBorder,
        )}
      >
        <span
          className={cn(
            'relative inline-flex h-6 w-6 shrink-0 items-center justify-center rounded-md ring-1 ring-inset',
            'bg-white/70 dark:bg-zinc-900/60',
            diag.status === 'healthy' && 'ring-emerald-200/70 dark:ring-emerald-800/50',
            diag.status === 'warning' && 'ring-amber-200/70 dark:ring-amber-800/50',
            diag.status === 'critical' && 'ring-rose-200/70 dark:ring-rose-800/50',
            diag.status === 'unknown' && 'ring-zinc-200 dark:ring-zinc-800',
          )}
          aria-hidden
        >
          <CategoryGlyph className={cn('h-3.5 w-3.5', palette.iconColor)} />
        </span>
        <div className="flex min-w-0 flex-1 flex-col gap-0.5">
          <span
            className={cn(
              'min-w-0 truncate text-[12.5px] font-semibold leading-none tracking-tight',
              palette.headerText,
            )}
            title={diag.label}
          >
            {diag.label}
          </span>
          <span className="font-mono text-[9px] uppercase tracking-[0.14em] text-zinc-500/80 dark:text-zinc-500">
            {CATEGORY_LABEL[diag.category]}
          </span>
        </div>
        <div className="flex shrink-0 flex-col items-end gap-1">
          <span
            className={cn(
              'rounded-full border px-1.5 py-0 font-mono text-[8.5px] font-semibold uppercase tracking-wider',
              palette.badge,
            )}
          >
            {STATUS_LABEL[diag.status]}
          </span>
          {fixCount > 0 && isAttention && (
            <span
              className="inline-flex items-center gap-0.5 rounded-full border border-orange-200 bg-orange-50 px-1.5 py-px font-mono text-[8.5px] font-semibold uppercase tracking-wider text-orange-700 dark:border-orange-900/60 dark:bg-orange-950/40 dark:text-orange-300"
              title={`${fixCount} suggested fix${fixCount === 1 ? '' : 'es'}`}
            >
              <Wrench className="h-2.5 w-2.5" />
              {fixCount}
            </span>
          )}
        </div>
      </div>

      {/* Body — Supabase-style "column" rows. */}
      <div className="bg-white py-1 dark:bg-zinc-950">
        <SchemaRow
          icon={Tag}
          name="category"
          type="enum"
          value={CATEGORY_LABEL[diag.category]}
          valueClassName="font-mono text-[11px]"
          hairline={false}
        />
        <SchemaRow
          icon={Activity}
          name="status"
          type="status"
          value={
            <span className="inline-flex items-center gap-1">
              <span className={cn('inline-block h-1.5 w-1.5 rounded-full', palette.accentDot)} />
              <span className="font-mono text-[11px] uppercase tracking-wider">{diag.status}</span>
            </span>
          }
        />
        <SchemaRow
          icon={FileText}
          name="summary"
          type="text"
          value={diag.summary}
          valueClassName="max-w-[150px]"
        />
        <SchemaRow
          icon={Clock}
          name="checked_at"
          type="timestamp"
          value={
            <span className="font-mono text-[10.5px] text-zinc-500 dark:text-zinc-400">
              {formatTimestamp(diag.lastChecked)}
            </span>
          }
        />
      </div>
    </div>
  );
});

const NODE_TYPES = { diag: DiagFlowNode };

/* ────────────────── Edge animations ──────────────────
 * Each edge animation reflects the *kind of relationship* between two services:
 *
 *   - mount  — UI shell hosts/contains a feature. Slow dashes flowing source→target.
 *   - flow   — feature pushes data into a downstream sink (CSV → master, payroll →
 *              disbursement). A small particle travels along the path.
 *   - query  — feature reads from / talks to the DB layer. Faster dashes — "live".
 *   - event  — discrete event fires (login → audit_log). Particle bursts with a
 *              long pause, like an event log entry being appended.
 *
 * Critical-status edges keep the chosen animation but tighten the timing so they
 * feel more urgent than warning/healthy.
 */

type RelationshipType = 'mount' | 'flow' | 'query' | 'event';

const RELATIONSHIP_LABEL: Record<RelationshipType, string> = {
  mount: 'Mount',
  flow: 'Data flow',
  query: 'Query',
  event: 'Event',
};

function relationshipFor(source: string, target: string): RelationshipType {
  if (source === 'admin-shell') return 'mount';
  if (target === 'audit-log') return 'event';
  if (target === 'supabase-client' || target === 'supabase-postgres' || target === 'pg-pool') {
    return 'query';
  }
  return 'flow';
}

type DiagEdgeData = {
  status: DiagnosticStatus;
  relationship: RelationshipType;
  /** Source-side and target-side status colors. Used to render a directional
   *  gradient stroke that fades from where the call originates → where it lands,
   *  so the relationship reads as "this → that" rather than a single-color line. */
  colorFrom: string;
  colorTo: string;
  /** True while ANY node is being dragged. We drop particle <circle>s and pause
   *  dash animations during drag to avoid SVG <animateMotion> twitching when its
   *  path string changes 60× per second. Particles re-mount cleanly on drag-stop. */
  dragging?: boolean;
};

/** Curvature for our bezier edges. Subtle enough to feel structural, generous
 *  enough that overlapping edges fan apart visually instead of stacking. */
const EDGE_CURVATURE = 0.32;

/** Per-edge linear gradient. Anchored to userspace coordinates so the fade
 *  follows the actual source→target geometry of the path, not the bounding
 *  box. The id is unique per edge so multiple edges can coexist. */
function EdgeGradient({
  id,
  sourceX,
  sourceY,
  targetX,
  targetY,
  fromColor,
  toColor,
  fromOpacity = 0.55,
  toOpacity = 0.95,
}: {
  id: string;
  sourceX: number;
  sourceY: number;
  targetX: number;
  targetY: number;
  fromColor: string;
  toColor: string;
  fromOpacity?: number;
  toOpacity?: number;
}) {
  return (
    <defs>
      <linearGradient
        id={id}
        gradientUnits="userSpaceOnUse"
        x1={sourceX}
        y1={sourceY}
        x2={targetX}
        y2={targetY}
      >
        <stop offset="0%" stopColor={fromColor} stopOpacity={fromOpacity} />
        <stop offset="100%" stopColor={toColor} stopOpacity={toOpacity} />
      </linearGradient>
    </defs>
  );
}

/** Common path style: gradient stroke + non-scaling so the line stays crisp at
 *  any zoom, plus a soft tint-matched drop shadow on critical edges. */
function edgePathStyle(
  base: React.CSSProperties | undefined,
  gradId: string,
  status: DiagnosticStatus,
  toColor: string,
): React.CSSProperties {
  return {
    ...base,
    stroke: `url(#${gradId})`,
    strokeLinecap: 'round',
    vectorEffect: 'non-scaling-stroke' as React.CSSProperties['vectorEffect'],
    filter:
      status === 'critical'
        ? `drop-shadow(0 0 4px ${toColor}55)`
        : status === 'warning'
          ? `drop-shadow(0 0 2px ${toColor}33)`
          : undefined,
  };
}

/** Mount — slow flowing dashes; the structural / "contains" relationship. */
function MountEdge({
  id, sourceX, sourceY, sourcePosition, targetX, targetY, targetPosition, style, markerEnd, data,
}: EdgeProps<Edge<DiagEdgeData>>) {
  const [edgePath] = getBezierPath({
    sourceX, sourceY, sourcePosition, targetX, targetY, targetPosition, curvature: EDGE_CURVATURE,
  });
  const gradId = `sd-grad-${id}`;
  const fromColor = data?.colorFrom ?? '#a1a1aa';
  const toColor = data?.colorTo ?? '#a1a1aa';
  return (
    <>
      <EdgeGradient
        id={gradId}
        sourceX={sourceX} sourceY={sourceY} targetX={targetX} targetY={targetY}
        fromColor={fromColor} toColor={toColor}
      />
      <BaseEdge
        id={id}
        path={edgePath}
        markerEnd={markerEnd}
        style={edgePathStyle(style, gradId, data?.status ?? 'unknown', toColor)}
      />
    </>
  );
}

/** Query — faster flowing dashes; live reads talking to the DB layer. */
function QueryEdge({
  id, sourceX, sourceY, sourcePosition, targetX, targetY, targetPosition, style, markerEnd, data,
}: EdgeProps<Edge<DiagEdgeData>>) {
  const [edgePath] = getBezierPath({
    sourceX, sourceY, sourcePosition, targetX, targetY, targetPosition, curvature: EDGE_CURVATURE,
  });
  const gradId = `sd-grad-${id}`;
  const fromColor = data?.colorFrom ?? '#a1a1aa';
  const toColor = data?.colorTo ?? '#a1a1aa';
  return (
    <>
      <EdgeGradient
        id={gradId}
        sourceX={sourceX} sourceY={sourceY} targetX={targetX} targetY={targetY}
        fromColor={fromColor} toColor={toColor}
        fromOpacity={0.45} toOpacity={1}
      />
      <BaseEdge
        id={id}
        path={edgePath}
        markerEnd={markerEnd}
        style={edgePathStyle(style, gradId, data?.status ?? 'unknown', toColor)}
      />
    </>
  );
}

/** Flow — solid line + a small particle traveling along the path. */
function FlowEdge({
  id, sourceX, sourceY, sourcePosition, targetX, targetY, targetPosition, style, markerEnd, data,
}: EdgeProps<Edge<DiagEdgeData>>) {
  const [edgePath] = getBezierPath({
    sourceX, sourceY, sourcePosition, targetX, targetY, targetPosition, curvature: EDGE_CURVATURE,
  });
  const gradId = `sd-grad-${id}`;
  const fromColor = data?.colorFrom ?? '#a1a1aa';
  const toColor = data?.colorTo ?? '#a1a1aa';
  const isCritical = data?.status === 'critical';
  const isDragging = data?.dragging === true;
  return (
    <>
      <EdgeGradient
        id={gradId}
        sourceX={sourceX} sourceY={sourceY} targetX={targetX} targetY={targetY}
        fromColor={fromColor} toColor={toColor}
      />
      <BaseEdge
        id={id}
        path={edgePath}
        markerEnd={markerEnd}
        style={edgePathStyle(style, gradId, data?.status ?? 'unknown', toColor)}
      />
      {!isDragging && (
        <>
          <circle r={isCritical ? 6 : 5} fill={toColor} opacity={0.18} className="sd-particle-halo">
            <animateMotion
              dur={isCritical ? '2.2s' : '3.4s'}
              repeatCount="indefinite"
              path={edgePath}
              rotate="auto"
            />
          </circle>
          <circle r={isCritical ? 3.4 : 3} fill={toColor}>
            <animateMotion
              dur={isCritical ? '2.2s' : '3.4s'}
              repeatCount="indefinite"
              path={edgePath}
              rotate="auto"
            />
          </circle>
        </>
      )}
    </>
  );
}

/** Event — discrete burst. Particle fires, fades, long pause, fires again. */
function EventEdge({
  id, sourceX, sourceY, sourcePosition, targetX, targetY, targetPosition, style, markerEnd, data,
}: EdgeProps<Edge<DiagEdgeData>>) {
  const [edgePath] = getBezierPath({
    sourceX, sourceY, sourcePosition, targetX, targetY, targetPosition, curvature: EDGE_CURVATURE,
  });
  const gradId = `sd-grad-${id}`;
  const fromColor = data?.colorFrom ?? '#a1a1aa';
  const toColor = data?.colorTo ?? '#a1a1aa';
  const isDragging = data?.dragging === true;
  const cycle = data?.status === 'critical' ? 2.6 : 4.0;
  const burst = 1.4;
  return (
    <>
      <EdgeGradient
        id={gradId}
        sourceX={sourceX} sourceY={sourceY} targetX={targetX} targetY={targetY}
        fromColor={fromColor} toColor={toColor}
        fromOpacity={0.35} toOpacity={0.85}
      />
      <BaseEdge
        id={id}
        path={edgePath}
        markerEnd={markerEnd}
        style={{
          ...edgePathStyle(style, gradId, data?.status ?? 'unknown', toColor),
          strokeWidth: 1.4,
        }}
      />
      {!isDragging && (
        <circle r="3" fill={toColor}>
          <animateMotion
            dur={`${burst}s`}
            begin="0s"
            repeatCount="indefinite"
            path={edgePath}
          />
          <animate
            attributeName="opacity"
            values="0;1;1;0;0"
            keyTimes={`0;${0.05 / cycle};${burst / cycle};${(burst + 0.2) / cycle};1`}
            dur={`${cycle}s`}
            repeatCount="indefinite"
          />
          <animate
            attributeName="r"
            values="2;3.4;3.4;0"
            keyTimes={`0;${burst / cycle / 2};${burst / cycle};1`}
            dur={`${cycle}s`}
            repeatCount="indefinite"
          />
        </circle>
      )}
    </>
  );
}

const EDGE_TYPES: EdgeTypes = {
  mount: MountEdge,
  query: QueryEdge,
  flow: FlowEdge,
  event: EventEdge,
};

/** Keyframes + edge animation classes injected once when the diagnostics view mounts.
 *  Names are prefixed (`sd-`) so they don't collide with anything else in globals.
 *
 *  Why CSS classes instead of inline style.animation?
 *  Inline style.animation gets re-applied every render, which causes the dash flow
 *  to "reset" each time React Flow updates the path during drag (60×/sec). With
 *  the animation on a class on the edge wrapper, the rule is set once and stays
 *  stable while the path geometry changes — only the path's `d` attribute updates,
 *  not the animation declaration. */
function DiagnosticsKeyframes() {
  return (
    <style>{`
      @keyframes sd-dash-flow {
        from { stroke-dashoffset: 0; }
        to   { stroke-dashoffset: -18; }
      }

      /* Mount edges — slow flowing dashes (structural). */
      .react-flow__edge.sd-edge-mount > .react-flow__edge-path {
        stroke-dasharray: 7 6;
        stroke-linecap: round;
        animation: sd-dash-flow 7s linear infinite;
      }
      .react-flow__edge.sd-edge-mount.sd-critical > .react-flow__edge-path {
        animation-duration: 4s;
      }

      /* Query edges — faster flowing dashes (live DB reads). */
      .react-flow__edge.sd-edge-query > .react-flow__edge-path {
        stroke-dasharray: 4 4;
        stroke-linecap: round;
        animation: sd-dash-flow 1.6s linear infinite;
      }
      .react-flow__edge.sd-edge-query.sd-critical > .react-flow__edge-path {
        animation-duration: 1s;
      }

      /* Default — clean, slightly translucent endpoints so multiple edges
         landing on the same handle don't pile up into an opaque blob. */
      .react-flow__edge > .react-flow__edge-path {
        stroke-linecap: round;
      }

      /* Pause dash flow while any node is dragging — avoids visible "stutter"
         as the smoothstep path geometry recomputes 60× per second. */
      .react-flow__edge.sd-paused > .react-flow__edge-path {
        animation-play-state: paused;
      }

      .sd-particle-halo { filter: blur(2px); }

      /* ── Glowing scroll affordance for the right-side panels ──────────────
         Base UI's ScrollArea hides its scrollbar by default until scroll/hover,
         which made the Node details + Active alerts panels look "empty below."
         We force the bar to render whenever it can scroll, give the thumb an
         orange glow, and fade in/out a soft pulse so it reads as alive. */
      .sd-scroll [data-slot="scroll-area-scrollbar"] {
        opacity: 1 !important;
        width: 9px !important;
        padding: 2px 1px !important;
      }
      .sd-scroll [data-slot="scroll-area-scrollbar"][data-orientation="horizontal"] {
        height: 9px !important;
        width: auto !important;
      }
      .sd-scroll [data-slot="scroll-area-thumb"] {
        background: linear-gradient(180deg, #fdba74 0%, #f97316 50%, #ea580c 100%) !important;
        box-shadow:
          0 0 6px rgba(249, 115, 22, 0.55),
          0 0 14px rgba(249, 115, 22, 0.28),
          inset 0 0 0 1px rgba(255, 255, 255, 0.18);
        border-radius: 9999px;
        animation: sd-scroll-pulse 2.4s ease-in-out infinite;
      }
      .sd-scroll [data-slot="scroll-area-thumb"]:hover {
        background: linear-gradient(180deg, #fed7aa 0%, #fb923c 50%, #f97316 100%) !important;
        box-shadow:
          0 0 10px rgba(249, 115, 22, 0.75),
          0 0 22px rgba(249, 115, 22, 0.4),
          inset 0 0 0 1px rgba(255, 255, 255, 0.28);
      }
      .dark .sd-scroll [data-slot="scroll-area-thumb"] {
        background: linear-gradient(180deg, #fb923c 0%, #f97316 50%, #c2410c 100%) !important;
        box-shadow:
          0 0 8px rgba(249, 115, 22, 0.6),
          0 0 18px rgba(249, 115, 22, 0.32),
          inset 0 0 0 1px rgba(255, 255, 255, 0.12);
      }
      @keyframes sd-scroll-pulse {
        0%, 100% {
          box-shadow:
            0 0 6px rgba(249, 115, 22, 0.45),
            0 0 12px rgba(249, 115, 22, 0.22),
            inset 0 0 0 1px rgba(255, 255, 255, 0.18);
        }
        50% {
          box-shadow:
            0 0 11px rgba(249, 115, 22, 0.7),
            0 0 22px rgba(249, 115, 22, 0.4),
            inset 0 0 0 1px rgba(255, 255, 255, 0.25);
        }
      }

      /* Subtle "more content below" fade overlay at the bottom of the scroll
         viewport — purely decorative, sits above the content but below the
         scrollbar. Implemented as a ::after on the wrapping container. */
      .sd-scroll-wrap {
        position: relative;
      }
      .sd-scroll-wrap::after {
        content: '';
        position: absolute;
        left: 0;
        right: 10px; /* leave room for the scrollbar */
        bottom: 0;
        height: 22px;
        background: linear-gradient(to bottom, transparent, rgba(255, 255, 255, 0.85));
        pointer-events: none;
        border-radius: 0 0 0.5rem 0.5rem;
      }
      .dark .sd-scroll-wrap::after {
        background: linear-gradient(to bottom, transparent, rgba(9, 9, 11, 0.9));
      }

      /* Respect users who want reduced motion — disable all edge animation. */
      @media (prefers-reduced-motion: reduce) {
        .react-flow__edge-path,
        .sd-particle-halo,
        .react-flow__edge circle[fill],
        .sd-scroll [data-slot="scroll-area-thumb"] {
          animation: none !important;
        }
      }
    `}</style>
  );
}

/* ────────────────── Helpers ────────────────── */

function StatusIcon({ status, className }: { status: DiagnosticStatus; className?: string }) {
  const palette = STATUS_CLASSES[status];
  const Comp =
    status === 'healthy'
      ? CheckCircle2
      : status === 'warning'
        ? AlertTriangle
        : status === 'critical'
          ? XCircle
          : CircleDashed;
  return <Comp className={cn('h-4 w-4 shrink-0', palette.iconColor, className)} />;
}

function formatTimestamp(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  return d.toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit', second: '2-digit' });
}

/* ────────────────── Main component ────────────────── */

export default function SystemDiagnostics() {
  const [data, setData] = useState<DiagnosticsHealthResponse>(() => buildMockDiagnostics());
  const [selectedNodeId, setSelectedNodeId] = useState<string | null>(null);
  const [refreshing, setRefreshing] = useState(false);
  // Initial positions snapshot — used at first paint and as the "template" we can
  // restore via Reset Layout. Live positions live inside the React Flow node state
  // (see `flowNodes` below) so position changes don't trigger top-level rerenders.
  const initialPositions = useMemo<Record<string, { x: number; y: number }>>(
    () => ({ ...NODE_POSITIONS, ...loadStoredPositions() }),
    [],
  );
  const [hasCustomLayout, setHasCustomLayout] = useState(() => {
    const stored = loadStoredPositions();
    return Object.keys(stored).length > 0;
  });
  /** True from `onNodeDragStart` to `onNodeDragStop`. Edge components conditionally
   *  drop their <animateMotion> particles while this is true, and CSS `.sd-paused`
   *  pauses the dash flow on edge paths so the geometry can recompute without
   *  visual stutter. */
  const [dragging, setDragging] = useState(false);
  /** 'live' once the /api/admin/diagnostics fetch succeeds. 'mock' on first paint
   *  and any time the live probe fails — surfaced as a small chip so admins know
   *  whether they're looking at real data. */
  const [dataSource, setDataSource] = useState<'live' | 'mock'>('mock');
  const [probeError, setProbeError] = useState<string | null>(null);

  const lastRefreshed = useMemo(() => formatTimestamp(new Date().toISOString()), [data]);

  const loadDiagnostics = useCallback(async () => {
    setRefreshing(true);
    setProbeError(null);
    try {
      const res = await fetch('/api/admin/diagnostics', { cache: 'no-store' });
      if (!res.ok) {
        // 401/403 → admin gate; 5xx → server problem. Either way, fall back to mock
        // so the UI keeps functioning, and surface the reason in the chip.
        const body = (await res.json().catch(() => ({}))) as { error?: string };
        setDataSource('mock');
        setProbeError(body.error ?? `Probe failed (HTTP ${res.status})`);
        setData(buildMockDiagnostics());
        return;
      }
      const json = (await res.json()) as DiagnosticsHealthResponse & { source?: 'live' | 'mock' };
      setData(json);
      setDataSource(json.source ?? 'live');
    } catch (e) {
      setDataSource('mock');
      setProbeError(e instanceof Error ? e.message : 'Probe failed');
      setData(buildMockDiagnostics());
    } finally {
      setRefreshing(false);
    }
  }, []);

  // Fetch live data on mount.
  useEffect(() => {
    void loadDiagnostics();
  }, [loadDiagnostics]);

  // React Flow-managed node state. `useNodesState` exposes a change handler that
  // applies position updates in-place and only mutates the moving node's reference,
  // so unaffected node components (memoized via React.memo) skip re-render during
  // drag. This is the single biggest drag-perf win versus rebuilding the array
  // through useMemo on every position event.
  const [flowNodes, setFlowNodes, onNodesChangeRf] = useNodesState<Node<DiagNodeData>>(
    data.nodes.map((diag) => ({
      id: diag.id,
      type: 'diag',
      position: initialPositions[diag.id] ?? NODE_POSITIONS[diag.id] ?? { x: 0, y: 0 },
      data: { diag, selected: diag.id === selectedNodeId },
      draggable: true,
      selectable: true,
    })),
  );

  // Sync data refreshes (every 60s) into nodes without disturbing positions or
  // re-creating data objects unless the underlying diag actually changed.
  useEffect(() => {
    setFlowNodes((prev) => {
      const prevById = new Map(prev.map((n) => [n.id, n]));
      let changed = false;
      const next = data.nodes.map((diag) => {
        const existing = prevById.get(diag.id);
        if (existing && existing.data.diag === diag) return existing;
        changed = true;
        return {
          id: diag.id,
          type: 'diag' as const,
          position:
            existing?.position ??
            initialPositions[diag.id] ??
            NODE_POSITIONS[diag.id] ?? { x: 0, y: 0 },
          data: { diag, selected: diag.id === selectedNodeId },
          draggable: true,
          selectable: true,
        };
      });
      return changed || next.length !== prev.length ? next : prev;
    });
  }, [data.nodes, initialPositions, selectedNodeId, setFlowNodes]);

  // Selection-only updates: flip `data.selected` on just the two nodes whose
  // selection state changed. Preserves reference identity for everyone else so
  // React.memo can short-circuit them.
  useEffect(() => {
    setFlowNodes((prev) =>
      prev.map((n) => {
        const isSel = n.id === selectedNodeId;
        if (n.data.selected === isSel) return n;
        return { ...n, data: { ...n.data, selected: isSel } };
      }),
    );
  }, [selectedNodeId, setFlowNodes]);

  const resetLayout = useCallback(() => {
    setFlowNodes((prev) =>
      prev.map((n) => {
        const tpl = NODE_POSITIONS[n.id];
        if (!tpl || (n.position.x === tpl.x && n.position.y === tpl.y)) return n;
        return { ...n, position: { ...tpl } };
      }),
    );
    setHasCustomLayout(false);
    if (typeof window !== 'undefined') {
      try {
        window.localStorage.removeItem(POSITIONS_STORAGE_KEY);
      } catch {
        /* ignore */
      }
    }
  }, [setFlowNodes]);

  const flowEdges: Edge<DiagEdgeData>[] = useMemo(() => {
    const byId = new Map(data.nodes.map((n) => [n.id, n]));
    const order: DiagnosticStatus[] = ['healthy', 'unknown', 'warning', 'critical'];
    return EDGES.map((e) => {
      const a = byId.get(e.source)?.status ?? 'unknown';
      const b = byId.get(e.target)?.status ?? 'unknown';
      const worst = order[Math.max(order.indexOf(a), order.indexOf(b))];
      const colorFrom = STATUS_CLASSES[a].edge;
      const colorTo = STATUS_CLASSES[b].edge;
      const relationship = relationshipFor(e.source, e.target);
      // Stroke width scales with severity so critical edges visually dominate
      // without us having to color the whole map red.
      const strokeWidth = worst === 'critical' ? 2.4 : worst === 'warning' ? 1.9 : 1.6;
      return {
        id: `${e.source}__${e.target}`,
        source: e.source,
        target: e.target,
        type: relationship,
        data: { status: worst, relationship, colorFrom, colorTo, dragging },
        // className lives on the wrapping <g class="react-flow__edge"> — used by
        // CSS to apply the dash animations once and pause them during drag.
        className: cn(
          `sd-edge-${relationship}`,
          worst === 'critical' && 'sd-critical',
          dragging && 'sd-paused',
        ),
        // The actual stroke color is overridden inside each edge component to a
        // gradient (url(#sd-grad-...)). We still set a fallback color here so the
        // path renders sanely if the gradient defs haven't mounted yet.
        style: { stroke: colorTo, strokeWidth, opacity: 0.95 },
        markerEnd: {
          type: MarkerType.ArrowClosed,
          width: 16,
          height: 16,
          color: colorTo,
        },
      };
    });
  }, [data.nodes, dragging]);

  // Defer to React Flow's built-in change applier (cheap — only the moving node's
  // ref is replaced). On drag end, snapshot all positions and persist to
  // localStorage; we don't write on every frame because writes are slow and we
  // don't need intermediate states.
  const handleNodesChange = useCallback(
    (changes: NodeChange<Node<DiagNodeData>>[]) => {
      onNodesChangeRf(changes);
      const dragStop = changes.some(
        (c) => c.type === 'position' && c.dragging === false,
      );
      if (dragStop) {
        setFlowNodes((prev) => {
          const snap: Record<string, { x: number; y: number }> = {};
          for (const n of prev) snap[n.id] = { x: n.position.x, y: n.position.y };
          persistPositions(snap);
          return prev;
        });
        setHasCustomLayout(true);
      }
    },
    [onNodesChangeRf, setFlowNodes],
  );

  const selectedNode = useMemo(
    () => (selectedNodeId ? data.nodes.find((n) => n.id === selectedNodeId) ?? null : null),
    [selectedNodeId, data.nodes],
  );

  const counts = useMemo(() => {
    const c: Record<DiagnosticStatus, number> = { healthy: 0, warning: 0, critical: 0, unknown: 0 };
    for (const n of data.nodes) c[n.status] += 1;
    return c;
  }, [data.nodes]);

  useEffect(() => {
    const t = setInterval(() => setData((prev) => ({ ...prev })), 60_000);
    return () => clearInterval(t);
  }, []);

  return (
    <div className="flex h-full min-h-0 flex-col gap-4 overflow-hidden bg-gradient-to-br from-white via-orange-50/20 to-blue-50/20 p-4 sm:p-5 dark:bg-none dark:bg-[#0d1117]">
      {/* ── Header ── */}
      <header className="flex shrink-0 flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
        <div className="flex min-w-0 items-start gap-3">
          <div className="flex h-10 w-10 shrink-0 items-center justify-center rounded-lg bg-gradient-to-br from-orange-500 to-orange-600 shadow-sm shadow-orange-500/20">
            <RadarIcon className="h-5 w-5 text-white" aria-hidden />
          </div>
          <div className="min-w-0">
            <h2 className="text-xl font-bold tracking-tight text-zinc-900 sm:text-2xl dark:text-white">
              System Diagnostics
            </h2>
            <p className="mt-0.5 max-w-2xl text-xs leading-relaxed text-zinc-500 dark:text-zinc-400">
              Admin-only health map for payroll, data, database, and security signals.
            </p>
          </div>
        </div>
        <div className="flex shrink-0 flex-wrap items-center justify-end gap-2">
          {/* Live / Mock data-source chip */}
          <span
            className={cn(
              'inline-flex items-center gap-1.5 rounded-full border px-2 py-0.5 font-mono text-[10px] font-semibold uppercase tracking-wider',
              dataSource === 'live'
                ? 'border-emerald-200 bg-emerald-50 text-emerald-700 dark:border-emerald-900/60 dark:bg-emerald-950/40 dark:text-emerald-400'
                : 'border-zinc-200 bg-zinc-50 text-zinc-600 dark:border-zinc-800 dark:bg-zinc-900/60 dark:text-zinc-400',
            )}
            title={
              dataSource === 'live'
                ? 'Data is from the live probe (/api/admin/diagnostics).'
                : probeError
                  ? `Live probe failed: ${probeError}. Showing mock baseline.`
                  : 'Showing mock baseline before first probe.'
            }
          >
            <span
              className={cn(
                'inline-block h-1.5 w-1.5 rounded-full',
                dataSource === 'live' ? 'bg-emerald-500' : 'bg-zinc-400',
              )}
            />
            {dataSource === 'live' ? 'Live probes' : 'Mock data'}
          </span>
          <span
            className="font-mono text-[10px] uppercase tracking-wider text-zinc-400 dark:text-zinc-500"
            title="Last refreshed"
          >
            Updated {lastRefreshed}
          </span>
          <Button
            variant="outline"
            size="sm"
            onClick={() => void loadDiagnostics()}
            disabled={refreshing}
            className="h-8 gap-1.5 text-[12px]"
          >
            <RefreshCw className={cn('h-3.5 w-3.5', refreshing && 'animate-spin')} />
            Refresh
          </Button>
        </div>
      </header>

      {probeError && dataSource === 'mock' && (
        <div className="flex shrink-0 items-start gap-2 rounded-lg border border-amber-200/80 bg-amber-50/70 px-3 py-2 text-[12px] dark:border-amber-900/50 dark:bg-amber-950/30">
          <AlertTriangle className="mt-0.5 h-3.5 w-3.5 shrink-0 text-amber-600 dark:text-amber-400" />
          <p className="leading-relaxed text-amber-900 dark:text-amber-200">
            Live probe failed — showing mock baseline. <span className="font-mono text-[11px]">{probeError}</span>
          </p>
        </div>
      )}

      {/* ── Summary cards ── */}
      <div className="grid shrink-0 grid-cols-2 gap-2 sm:grid-cols-4 sm:gap-3">
        <SummaryCard status="healthy" label="Healthy" value={counts.healthy} icon={<CheckCircle2 className="h-3.5 w-3.5" />} />
        <SummaryCard status="warning" label="Warnings" value={counts.warning} icon={<AlertTriangle className="h-3.5 w-3.5" />} />
        <SummaryCard status="critical" label="Critical" value={counts.critical} icon={<XCircle className="h-3.5 w-3.5" />} />
        <SummaryCard status="unknown" label="Unknown" value={counts.unknown} icon={<CircleDashed className="h-3.5 w-3.5" />} />
      </div>

      {/* ── Main: diagram + side panel ── */}
      <div className="grid min-h-0 flex-1 grid-cols-1 gap-3 overflow-hidden xl:grid-cols-[1fr_22rem]">
        {/* Diagram */}
        <Card className="relative flex min-h-[480px] flex-col overflow-hidden border border-zinc-200/80 bg-zinc-50/40 ring-0 backdrop-blur-sm dark:border-zinc-800 dark:bg-zinc-950/60">
          <div className="flex shrink-0 items-center justify-between gap-3 border-b border-zinc-100 px-4 py-2.5 dark:border-zinc-800/60">
            <div className="flex min-w-0 items-center gap-2">
              <Activity className="h-3.5 w-3.5 shrink-0 text-orange-500 dark:text-orange-400" />
              <span className="text-[12px] font-semibold tracking-tight text-zinc-900 dark:text-zinc-100">
                Service Map
              </span>
              <Badge
                variant="outline"
                className={cn(
                  'gap-1 font-mono text-[10px] uppercase tracking-wider',
                  STATUS_CLASSES[data.overallStatus].badge,
                )}
              >
                <span className={cn('inline-block h-1.5 w-1.5 rounded-full', STATUS_CLASSES[data.overallStatus].accentDot)} />
                Overall {STATUS_LABEL[data.overallStatus]}
              </Badge>
            </div>
            <div className="flex shrink-0 items-center gap-2">
              <span className="hidden text-[11px] text-zinc-400 sm:inline dark:text-zinc-500">
                Drag nodes · click for details
              </span>
              <Button
                variant="outline"
                size="sm"
                onClick={resetLayout}
                disabled={!hasCustomLayout}
                className="h-7 gap-1.5 text-[11px]"
                title={hasCustomLayout ? 'Restore template arrangement' : 'Already at template arrangement'}
              >
                <RotateCcw className="h-3 w-3" />
                Reset Layout
              </Button>
            </div>
          </div>
          <div className="schema-canvas relative min-h-0 flex-1">
            <DiagnosticsKeyframes />
            <ReactFlow
              nodes={flowNodes}
              edges={flowEdges}
              nodeTypes={NODE_TYPES}
              edgeTypes={EDGE_TYPES}
              onNodesChange={handleNodesChange}
              onNodeDragStart={() => setDragging(true)}
              onNodeDragStop={() => setDragging(false)}
              onNodeClick={(_, n) => setSelectedNodeId(n.id)}
              onPaneClick={() => setSelectedNodeId(null)}
              fitView
              fitViewOptions={{ padding: 0.18, minZoom: 0.35, maxZoom: 1.0 }}
              minZoom={0.3}
              maxZoom={1.5}
              proOptions={{ hideAttribution: true }}
              className="bg-transparent"
              nodesConnectable={false}
              elementsSelectable
              onlyRenderVisibleElements
            >
              <Background
                gap={28}
                size={1.4}
                color="currentColor"
                className="text-zinc-200 dark:text-zinc-800"
              />
              <Controls
                showInteractive={false}
                className="!border-zinc-200 !bg-white !text-zinc-700 dark:!border-zinc-800 dark:!bg-zinc-900 dark:!text-zinc-200"
              />
              {/* Translucent navigator — pannable so admins can scrub the canvas
                  without losing their dragged layout, status-tinted so trouble
                  spots are visible at a glance. */}
              <MiniMap
                position="top-right"
                pannable
                zoomable
                ariaLabel="Service map navigator"
                nodeStrokeWidth={2}
                nodeBorderRadius={6}
                nodeColor={(n) => {
                  const d = (n.data as DiagNodeData | undefined)?.diag;
                  return d ? STATUS_CLASSES[d.status].edge : '#a1a1aa';
                }}
                nodeStrokeColor={(n) => {
                  const d = (n.data as DiagNodeData | undefined)?.diag;
                  return d ? STATUS_CLASSES[d.status].edge : '#71717a';
                }}
                maskColor="rgba(244,244,245,0.55)"
                style={{
                  width: 168,
                  height: 112,
                  opacity: 0.78,
                  transition: 'opacity 160ms ease',
                }}
                onMouseEnter={(e) => {
                  (e.currentTarget as unknown as HTMLElement).style.opacity = '1';
                }}
                onMouseLeave={(e) => {
                  (e.currentTarget as unknown as HTMLElement).style.opacity = '0.78';
                }}
                className="!m-2 !rounded-lg !border !border-zinc-200/80 !bg-white/70 !shadow-sm backdrop-blur-md dark:!border-zinc-800/80 dark:!bg-zinc-950/60"
              />
              <Panel
                position="bottom-right"
                className="!m-2 rounded-lg border border-zinc-200 bg-white/95 p-2.5 shadow-sm backdrop-blur-sm dark:border-zinc-800 dark:bg-zinc-950/90"
              >
                <p className="mb-1.5 font-mono text-[9px] uppercase tracking-[0.16em] text-zinc-400 dark:text-zinc-500">
                  Edge legend
                </p>
                <div className="space-y-1.5">
                  <LegendRow type="mount" />
                  <LegendRow type="flow" />
                  <LegendRow type="query" />
                  <LegendRow type="event" />
                </div>
              </Panel>
            </ReactFlow>
          </div>
        </Card>

        {/* Right side stack: node details + alerts */}
        <div className="flex min-h-0 flex-col gap-3 overflow-hidden">
          {/* Node details */}
          <Card className="flex min-h-[260px] flex-1 flex-col overflow-hidden border border-zinc-200/80 bg-white/80 ring-0 backdrop-blur-sm dark:border-zinc-800 dark:bg-zinc-950/40">
            <div className="flex shrink-0 items-center gap-2 border-b border-zinc-100 px-4 py-3 dark:border-zinc-800/60">
              <ShieldAlert className="h-3.5 w-3.5 text-orange-500 dark:text-orange-400" />
              <span className="text-[12px] font-semibold tracking-tight text-zinc-900 dark:text-zinc-100">
                Node details
              </span>
            </div>
            <div className="sd-scroll-wrap min-h-0 flex-1">
            <ScrollArea className="sd-scroll h-full min-h-0">
              <div className="px-4 py-4">
                <AnimatePresence mode="wait" initial={false}>
                  {selectedNode ? (
                    <motion.div
                      key={selectedNode.id}
                      initial={{ opacity: 0, y: 4 }}
                      animate={{ opacity: 1, y: 0 }}
                      exit={{ opacity: 0, y: -2 }}
                      transition={{ duration: 0.16, ease: [0.22, 1, 0.36, 1] }}
                      className="space-y-3.5"
                    >
                      <div className="flex items-start justify-between gap-3">
                        <div className="min-w-0">
                          <h3 className="text-[14px] font-semibold leading-tight text-zinc-900 dark:text-zinc-100">
                            {selectedNode.label}
                          </h3>
                          <p className="mt-0.5 font-mono text-[10px] uppercase tracking-wider text-zinc-400 dark:text-zinc-500">
                            {CATEGORY_LABEL[selectedNode.category]} · id {selectedNode.id}
                          </p>
                        </div>
                        <Badge
                          variant="outline"
                          className={cn('gap-1 font-mono text-[10px] uppercase tracking-wider', STATUS_CLASSES[selectedNode.status].badge)}
                        >
                          <StatusIcon status={selectedNode.status} className="h-3 w-3" />
                          {STATUS_LABEL[selectedNode.status]}
                        </Badge>
                      </div>

                      <p className="text-[12.5px] leading-relaxed text-zinc-700 dark:text-zinc-300">
                        {selectedNode.summary}
                      </p>

                      {selectedNode.suggestedFixes && selectedNode.suggestedFixes.length > 0 && (
                        <>
                          <Separator className="bg-zinc-200/80 dark:bg-zinc-800/80" />
                          <SuggestedFixes fixes={selectedNode.suggestedFixes} />
                        </>
                      )}

                      <Separator className="bg-zinc-200/80 dark:bg-zinc-800/80" />

                      <div className="space-y-1.5">
                        <p className="text-[11px] font-semibold uppercase tracking-[0.14em] text-zinc-500 dark:text-zinc-400">
                          Details
                        </p>
                        <ul className="space-y-1.5 text-[12px] leading-relaxed text-zinc-600 dark:text-zinc-400">
                          {selectedNode.details.map((line, i) => (
                            <li key={i} className="flex gap-2">
                              <span className="mt-1.5 inline-block h-1 w-1 shrink-0 rounded-full bg-zinc-400 dark:bg-zinc-600" />
                              <span>{line}</span>
                            </li>
                          ))}
                        </ul>
                      </div>

                      <div className="space-y-1.5">
                        <p className="text-[11px] font-semibold uppercase tracking-[0.14em] text-zinc-500 dark:text-zinc-400">
                          Suggested checks
                        </p>
                        <ul className="space-y-1.5 text-[12px] leading-relaxed text-zinc-600 dark:text-zinc-400">
                          {selectedNode.suggestedChecks.map((line, i) => (
                            <li key={i} className="flex gap-2">
                              <span className="mt-1.5 inline-block h-1 w-1 shrink-0 rounded-full bg-orange-400 dark:bg-orange-500" />
                              <span>{line}</span>
                            </li>
                          ))}
                        </ul>
                      </div>

                      <p className="font-mono text-[10px] uppercase tracking-wider text-zinc-400 dark:text-zinc-500">
                        Last checked {formatTimestamp(selectedNode.lastChecked)}
                      </p>
                    </motion.div>
                  ) : (
                    <motion.div
                      key="empty"
                      initial={{ opacity: 0 }}
                      animate={{ opacity: 1 }}
                      exit={{ opacity: 0 }}
                      className="flex flex-col items-center gap-2 py-8 text-center"
                    >
                      <div className="flex h-9 w-9 items-center justify-center rounded-full bg-orange-50 ring-1 ring-orange-100 dark:bg-orange-500/10 dark:ring-orange-500/20">
                        <RadarIcon className="h-4 w-4 text-orange-500 dark:text-orange-400" />
                      </div>
                      <p className="text-[12.5px] font-medium text-zinc-700 dark:text-zinc-300">
                        Select a node
                      </p>
                      <p className="max-w-[18rem] text-[11.5px] leading-relaxed text-zinc-500 dark:text-zinc-400">
                        Click any card on the map for status, details, and the checks an admin should run. Drag cards to rearrange — your layout is saved locally.
                      </p>
                    </motion.div>
                  )}
                </AnimatePresence>
              </div>
            </ScrollArea>
            </div>
          </Card>

          {/* Alerts list */}
          <Card className="flex h-[280px] max-h-[40vh] min-h-[200px] shrink-0 flex-col overflow-hidden border border-zinc-200/80 bg-white/80 ring-0 backdrop-blur-sm dark:border-zinc-800 dark:bg-zinc-950/40">
            <div className="flex shrink-0 items-center justify-between border-b border-zinc-100 px-4 py-3 dark:border-zinc-800/60">
              <div className="flex items-center gap-2">
                <AlertTriangle className="h-3.5 w-3.5 text-amber-500" />
                <span className="text-[12px] font-semibold tracking-tight text-zinc-900 dark:text-zinc-100">
                  Active alerts
                </span>
              </div>
              <span className="font-mono text-[10px] text-zinc-400 dark:text-zinc-500">
                {data.alerts.length}
              </span>
            </div>
            <div className="sd-scroll-wrap min-h-0 flex-1">
            <ScrollArea className="sd-scroll h-full min-h-0">
              <div className="divide-y divide-zinc-100 dark:divide-zinc-800/60">
                {data.alerts.length === 0 ? (
                  <div className="flex flex-col items-center gap-1.5 py-8 text-center">
                    <CheckCircle2 className="h-4 w-4 text-emerald-500" />
                    <p className="text-[12px] text-zinc-500 dark:text-zinc-400">No active alerts.</p>
                  </div>
                ) : (
                  data.alerts.map((alert) => {
                    const palette = STATUS_CLASSES[alert.severity];
                    return (
                      <button
                        key={alert.id}
                        type="button"
                        onClick={() => setSelectedNodeId(alert.nodeId)}
                        className={cn(
                          'group block w-full px-4 py-3 text-left transition-colors duration-150',
                          'hover:bg-zinc-50/80 dark:hover:bg-zinc-900/60',
                          selectedNodeId === alert.nodeId && 'bg-orange-50/60 dark:bg-orange-500/5',
                        )}
                      >
                        <div className="flex items-start gap-2.5">
                          <StatusIcon status={alert.severity} className="mt-0.5" />
                          <div className="min-w-0 flex-1">
                            <p className="text-[12.5px] font-medium leading-tight text-zinc-900 dark:text-zinc-100">
                              {alert.title}
                            </p>
                            <p className="mt-0.5 line-clamp-2 text-[11.5px] leading-snug text-zinc-500 dark:text-zinc-400">
                              {alert.description}
                            </p>
                            <div className="mt-1 flex items-center gap-1.5 text-[10px] text-zinc-400 dark:text-zinc-500">
                              <Badge variant="outline" className={cn('h-4 gap-1 font-mono text-[9px] uppercase tracking-wider', palette.badge)}>
                                {STATUS_LABEL[alert.severity]}
                              </Badge>
                              <span>·</span>
                              <span className="font-mono">{alert.nodeId}</span>
                              <span>·</span>
                              <span className="font-mono">{formatTimestamp(alert.timestamp)}</span>
                            </div>
                          </div>
                        </div>
                      </button>
                    );
                  })
                )}
              </div>
            </ScrollArea>
            </div>
          </Card>
        </div>
      </div>
    </div>
  );
}

/* ────────────────── Suggested fixes ──────────────────
 * Displays the actionable remediation list for the selected node. Each fix is
 * presented as a small card with a kind-tinted icon, title, description, and an
 * optional `hint` (file path / command) shown in a monospace pill. The block is
 * rendered above Details so admins see "what to do" before "why it's flagged."
 */

const FIX_KIND_CLASSES: Record<NonNullable<DiagnosticFix['kind']>, string> = {
  config: 'border-sky-200 bg-sky-50 text-sky-700 dark:border-sky-900/60 dark:bg-sky-950/40 dark:text-sky-300',
  code: 'border-violet-200 bg-violet-50 text-violet-700 dark:border-violet-900/60 dark:bg-violet-950/40 dark:text-violet-300',
  db: 'border-emerald-200 bg-emerald-50 text-emerald-700 dark:border-emerald-900/60 dark:bg-emerald-950/40 dark:text-emerald-300',
  ops: 'border-orange-200 bg-orange-50 text-orange-700 dark:border-orange-900/60 dark:bg-orange-950/40 dark:text-orange-300',
  monitor: 'border-zinc-200 bg-zinc-50 text-zinc-600 dark:border-zinc-800 dark:bg-zinc-900/60 dark:text-zinc-300',
};

function SuggestedFixes({ fixes }: { fixes: DiagnosticFix[] }) {
  return (
    <div className="space-y-2">
      <div className="flex items-center gap-1.5">
        <Sparkles className="h-3 w-3 text-orange-500 dark:text-orange-400" aria-hidden />
        <p className="text-[11px] font-semibold uppercase tracking-[0.14em] text-zinc-500 dark:text-zinc-400">
          Suggested fixes
        </p>
        <span className="font-mono text-[10px] text-zinc-400 dark:text-zinc-500">
          {fixes.length}
        </span>
      </div>
      <ul className="space-y-2">
        {fixes.map((fix, i) => (
          <li
            key={i}
            className={cn(
              'group/fix relative rounded-lg border bg-gradient-to-br from-white to-zinc-50/50 p-2.5 transition-colors',
              'border-zinc-200/80 hover:border-orange-300/70 hover:from-orange-50/30 hover:to-white',
              'dark:border-zinc-800 dark:from-zinc-950 dark:to-zinc-900/40',
              'dark:hover:border-orange-500/40 dark:hover:from-orange-500/5 dark:hover:to-zinc-950',
            )}
          >
            <div className="flex items-start gap-2">
              <span
                className="mt-0.5 inline-flex h-5 w-5 shrink-0 items-center justify-center rounded-md bg-orange-100/70 text-orange-600 ring-1 ring-orange-200/70 dark:bg-orange-500/15 dark:text-orange-400 dark:ring-orange-500/25"
                aria-hidden
              >
                <Wrench className="h-3 w-3" />
              </span>
              <div className="min-w-0 flex-1 space-y-1">
                <div className="flex items-center gap-1.5">
                  <p className="min-w-0 flex-1 text-[12px] font-semibold leading-tight text-zinc-900 dark:text-zinc-100">
                    {fix.title}
                  </p>
                  {fix.kind && (
                    <span
                      className={cn(
                        'shrink-0 rounded-full border px-1.5 py-0 font-mono text-[8.5px] font-semibold uppercase tracking-wider',
                        FIX_KIND_CLASSES[fix.kind],
                      )}
                    >
                      {FIX_KIND_LABEL[fix.kind]}
                    </span>
                  )}
                </div>
                <p className="text-[11.5px] leading-relaxed text-zinc-600 dark:text-zinc-400">
                  {fix.description}
                </p>
                {fix.hint && (
                  <p className="inline-flex items-center gap-1 rounded-md bg-zinc-100/80 px-1.5 py-0.5 font-mono text-[10px] text-zinc-700 dark:bg-zinc-900/80 dark:text-zinc-300">
                    {fix.hint}
                  </p>
                )}
              </div>
            </div>
          </li>
        ))}
      </ul>
    </div>
  );
}

/* ────────────────── Legend row ────────────────── */

/** Mini animated SVG sample for each edge type — same primitives as the real edges. */
function LegendRow({ type }: { type: RelationshipType }) {
  const stroke = '#71717a'; // zinc-500 — neutral so legend doesn't claim a status
  const path = 'M 4 8 L 56 8';
  return (
    <div className="flex items-center gap-2">
      <svg width="64" height="16" className="overflow-visible">
        {type === 'mount' && (
          <line
            x1="4"
            y1="8"
            x2="60"
            y2="8"
            stroke={stroke}
            strokeWidth="1.5"
            strokeDasharray="6 5"
            style={{ animation: 'sd-dash-flow 7s linear infinite' }}
          />
        )}
        {type === 'query' && (
          <line
            x1="4"
            y1="8"
            x2="60"
            y2="8"
            stroke={stroke}
            strokeWidth="1.8"
            strokeDasharray="4 3"
            style={{ animation: 'sd-dash-flow 1.6s linear infinite' }}
          />
        )}
        {type === 'flow' && (
          <>
            <line x1="4" y1="8" x2="60" y2="8" stroke={stroke} strokeWidth="1.5" />
            <circle r="2.5" fill={stroke}>
              <animateMotion dur="2.4s" repeatCount="indefinite" path={path} />
            </circle>
          </>
        )}
        {type === 'event' && (
          <>
            <line x1="4" y1="8" x2="60" y2="8" stroke={stroke} strokeWidth="1.4" opacity="0.6" />
            <circle r="2" fill={stroke}>
              <animateMotion dur="1.4s" begin="0s" repeatCount="indefinite" path={path} />
              <animate
                attributeName="opacity"
                values="0;1;1;0;0"
                keyTimes="0;0.04;0.5;0.55;1"
                dur="3.5s"
                repeatCount="indefinite"
              />
            </circle>
          </>
        )}
      </svg>
      <span className="text-[10.5px] text-zinc-600 dark:text-zinc-400">{RELATIONSHIP_LABEL[type]}</span>
    </div>
  );
}

/* ────────────────── Summary card ────────────────── */

function SummaryCard({
  status,
  label,
  value,
  icon,
}: {
  status: DiagnosticStatus;
  label: string;
  value: number;
  icon: React.ReactNode;
}) {
  const palette = STATUS_CLASSES[status];
  return (
    <div
      className={cn(
        'flex items-center justify-between gap-2 rounded-xl border bg-white/80 p-3 shadow-sm backdrop-blur-sm transition-shadow hover:shadow-md dark:bg-zinc-950/40',
        'border-zinc-200 dark:border-zinc-800',
      )}
    >
      <div className="flex flex-col gap-0.5">
        <span className="text-[10px] font-medium uppercase tracking-[0.14em] text-zinc-500 dark:text-zinc-400">
          {label}
        </span>
        <span className="font-mono text-xl font-bold tabular-nums leading-none text-zinc-900 dark:text-zinc-100">
          {value}
        </span>
      </div>
      <span
        className={cn(
          'flex h-8 w-8 items-center justify-center rounded-lg ring-1',
          palette.iconColor,
          status === 'healthy' && 'bg-emerald-50 ring-emerald-100 dark:bg-emerald-500/10 dark:ring-emerald-500/20',
          status === 'warning' && 'bg-amber-50 ring-amber-100 dark:bg-amber-500/10 dark:ring-amber-500/20',
          status === 'critical' && 'bg-rose-50 ring-rose-100 dark:bg-rose-500/10 dark:ring-rose-500/20',
          status === 'unknown' && 'bg-zinc-50 ring-zinc-100 dark:bg-zinc-900 dark:ring-zinc-800',
        )}
      >
        {icon}
      </span>
    </div>
  );
}
