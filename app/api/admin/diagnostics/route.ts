/**
 * GET /api/admin/diagnostics — admin-only health probe.
 *
 * Runs server-side probes against Supabase, pg pool, audit_log, and the data
 * tables that the Diagnostics map cares about. Returns a `DiagnosticsHealthResponse`
 * the client renders directly — same shape as the local mock so the UI is
 * unchanged whether it's live or fallback.
 *
 * Authorization: admin role required (matches the `'diagnostics'` tab gate, plus
 * a server-side belt-and-suspenders so the data is never readable from non-admin
 * sessions even if the client-side gate is bypassed).
 *
 * Security: probe results never include raw stack traces, SQL text, secrets, or
 * employee PII (no emails, no names). Counts and ages only. See the helpers in
 * src/lib/admin/diagnostics-probes.ts for the truncation policy.
 */

import { NextResponse } from 'next/server';
import { getServerSession } from 'next-auth/next';
import { authOptions } from '@/lib/auth/auth-options';
import { requireElevatedSession, deniedResponse } from '@/lib/auth/authorize-email';
import {
  probeAppSettings,
  probeAuditLog,
  probeAuth,
  probeDailyReport,
  probeDisbursementRecords,
  probeGoogleSheetsSync,
  probeHrOffboarding,
  probeHrOnboarding,
  probeHubstaffCsv,
  probeManagerWallpapers,
  probeMasterList,
  probePgPool,
  probeRateHistory,
  probeRates,
  probeSupabase,
  withProbeTimeout,
  type ProbeResult,
  type ProbeStatus,
} from '@/lib/admin/diagnostics-probes';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

type DiagnosticCategory =
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
  | 'manager'
  | 'hr-onboarding'
  | 'hr-offboarding';

type DiagnosticNode = {
  id: string;
  label: string;
  category: DiagnosticCategory;
  status: ProbeStatus;
  summary: string;
  details: string[];
  suggestedChecks: string[];
  lastChecked: string;
};

type DiagnosticAlert = {
  id: string;
  severity: ProbeStatus;
  title: string;
  description: string;
  nodeId: string;
  timestamp: string;
};

type DiagnosticsHealthResponse = {
  overallStatus: ProbeStatus;
  source: 'live' | 'mock';
  generatedAt: string;
  nodes: DiagnosticNode[];
  alerts: DiagnosticAlert[];
};

async function requireAdmin() {
  const authz = await requireElevatedSession();
  if (!authz.ok) return { ok: false as const, response: deniedResponse(authz) };
  const session = await getServerSession(authOptions);
  const roles = ((session?.user as { roles?: string[] } | undefined)?.roles ?? []) as string[];
  if (!roles.includes('admin')) {
    return {
      ok: false as const,
      response: NextResponse.json({ error: 'Admin role required' }, { status: 403 }),
    };
  }
  return { ok: true as const };
}

/** Worse of two statuses; used to derive composite node statuses. */
function worseStatus(a: ProbeStatus, b: ProbeStatus): ProbeStatus {
  const order: ProbeStatus[] = ['healthy', 'unknown', 'warning', 'critical'];
  return order[Math.max(order.indexOf(a), order.indexOf(b))];
}

export async function GET() {
  const guard = await requireAdmin();
  if (!guard.ok) return guard.response;

  const now = new Date();
  const iso = now.toISOString();

  // Run probes in parallel; each has its own timeout so one slow probe can't stall.
  const fallback: ProbeResult = {
    status: 'unknown',
    summary: 'Probe did not return.',
    details: [],
    suggestedChecks: [],
  };
  const [
    supabaseProbe,
    pgPoolProbe,
    hubstaffProbe,
    masterListProbe,
    auditLogProbe,
    disbursementProbe,
    authProbe,
    dailyReportProbe,
    ratesProbe,
    appSettingsProbe,
    sheetsSyncProbe,
    rateHistoryProbe,
    wallpapersProbe,
    hrOnboardingProbe,
    hrOffboardingProbe,
  ] = await Promise.all([
    withProbeTimeout(probeSupabase(), fallback),
    withProbeTimeout(probePgPool(), fallback),
    withProbeTimeout(probeHubstaffCsv(), fallback),
    withProbeTimeout(probeMasterList(), fallback),
    withProbeTimeout(probeAuditLog(), fallback),
    withProbeTimeout(probeDisbursementRecords(), fallback),
    withProbeTimeout(probeAuth(), fallback),
    withProbeTimeout(probeDailyReport(), fallback),
    withProbeTimeout(probeRates(), fallback),
    withProbeTimeout(probeAppSettings(), fallback),
    withProbeTimeout(probeGoogleSheetsSync(), fallback),
    withProbeTimeout(probeRateHistory(), fallback),
    withProbeTimeout(probeManagerWallpapers(), fallback),
    withProbeTimeout(probeHrOnboarding(), fallback),
    withProbeTimeout(probeHrOffboarding(), fallback),
  ]);

  // Compose nodes — service-map identifiers must match the client's NODE_POSITIONS.
  const node = (
    id: string,
    label: string,
    category: DiagnosticCategory,
    p: ProbeResult,
  ): DiagnosticNode => ({
    id,
    label,
    category,
    status: p.status,
    summary: p.summary,
    details: p.details,
    suggestedChecks: p.suggestedChecks,
    lastChecked: iso,
  });

  // Composite statuses for nodes that don't have a dedicated probe — derived from
  // their immediate dependencies so the diagram still tells a coherent story.
  const payrollStatus = [hubstaffProbe.status, masterListProbe.status, disbursementProbe.status].reduce(
    worseStatus,
    'healthy' as ProbeStatus,
  );

  const nodes: DiagnosticNode[] = [
    {
      id: 'admin-shell',
      label: 'Admin SPA Shell',
      category: 'admin-ui',
      // If you can read this response, the shell rendered — always healthy here.
      status: 'healthy',
      summary: 'Tab-based shell rendering normally.',
      details: [
        'app/admin/page.tsx switches via activeTab; no URL routes for admin tabs.',
        'AdminSidebar reads roles from /api/employee-roles for tab visibility.',
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
      status: payrollStatus === 'healthy' ? 'warning' : payrollStatus,
      // Keep the warning floor — even when probes look good, CSV mismatches are subtle.
      summary:
        payrollStatus === 'critical'
          ? 'Upstream data sources are critical.'
          : 'Payroll workflow should be checked for CSV/date-column mismatches.',
      details: [
        'Friday cycle pulls Hubstaff CSV → Master List → Disbursement Records.',
        'Failure modes seen: missing daily columns, mis-dated totals.',
      ],
      suggestedChecks: [
        'Confirm Hubstaff export columns match expected daily slots.',
        'Verify the calendar-column-dedupe map for the latest upload.',
        'Spot-check totals against a single employee’s expected pay.',
      ],
      lastChecked: iso,
    },
    node('rates', 'Rates Management', 'rates', ratesProbe),
    node('hubstaff-csv', 'Hubstaff CSV Import', 'csv', hubstaffProbe),
    node('master-list', 'Employee Master List', 'employee-data', masterListProbe),
    node('supabase-client', 'Supabase Client', 'infra', supabaseProbe),
    node('supabase-postgres', 'Supabase Postgres / RLS', 'database', supabaseProbe),
    node('pg-pool', 'pg Pool / Direct Postgres', 'database', pgPoolProbe),
    node('daily-report', 'Daily Report Import', 'reports', dailyReportProbe),
    node('auth-login', 'Employee / Accounting Login', 'auth', authProbe),
    node('audit-log', 'Audit Log', 'audit', auditLogProbe),
    node('disbursement-records', 'Disbursement Records', 'reports', disbursementProbe),
    node('app-settings', 'App Settings (config bag)', 'config', appSettingsProbe),
    node('google-sheet-sync', 'Google Sheet Sync', 'integration', sheetsSyncProbe),
    node('rate-history', 'Rate History', 'rates', rateHistoryProbe),
    node('manager-wallpapers', 'Manager Team Wallpapers', 'manager', wallpapersProbe),
    node('hr-onboarding', 'HR Onboarding Pipeline', 'hr-onboarding', hrOnboardingProbe),
    node('hr-offboarding', 'HR Offboarding Pipeline', 'hr-offboarding', hrOffboardingProbe),
  ];

  // Generate alerts from any non-healthy node.
  const alerts: DiagnosticAlert[] = nodes
    .filter((n) => n.status === 'warning' || n.status === 'critical')
    .map((n) => ({
      id: `alert-${n.id}`,
      severity: n.status,
      title: n.summary,
      description: n.details[0] ?? n.summary,
      nodeId: n.id,
      timestamp: iso,
    }));

  const overallStatus: ProbeStatus = nodes.some((n) => n.status === 'critical')
    ? 'critical'
    : nodes.some((n) => n.status === 'warning')
      ? 'warning'
      : nodes.every((n) => n.status === 'healthy')
        ? 'healthy'
        : 'unknown';

  const body: DiagnosticsHealthResponse = {
    overallStatus,
    source: 'live',
    generatedAt: iso,
    nodes,
    alerts,
  };

  return NextResponse.json(body, {
    headers: {
      'Cache-Control': 'no-store, max-age=0',
    },
  });
}
