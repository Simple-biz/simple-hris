/**
 * System Diagnostics — server-side probe helpers.
 *
 * Each probe returns a partial DiagnosticNode (status + summary + details +
 * suggestedChecks). The route handler at app/api/admin/diagnostics combines
 * these into a full DiagnosticsHealthResponse.
 *
 * Security: probes never return raw error stacks, SQL text, secrets, or PII.
 * Error messages are truncated. PostgREST error codes pass through (they're
 * useful and not sensitive). Counts and ages are aggregate metrics.
 */

import {
  createSupabaseServerClient,
  createSupabaseServiceRoleClient,
} from '@/lib/supabase/server';
import { normEmail } from '@/lib/email/norm-email';
import { selectAllPaged } from '@/lib/supabase/select-all-paged';
// Imported, never retyped: a reopen archives the record under the DIFFERENT
// prefix `dispatch.cycle_reopened.`, so a literal here that drifted would start
// counting archived declarations as live ones.
import { CYCLE_CLOSEOUT_PREFIX } from '@/lib/payroll/cycle-closeout';
import { judgeRosterDrift } from '@/lib/roster/roster-drift';

export type ProbeStatus = 'healthy' | 'warning' | 'critical' | 'unknown';

export type ProbeResult = {
  status: ProbeStatus;
  summary: string;
  details: string[];
  suggestedChecks: string[];
};

const TIMEOUT_MS = 4000;

/** Safely race a probe against a timeout so a hung Supabase doesn't stall the route. */
export async function withProbeTimeout<T extends ProbeResult>(
  probe: Promise<T>,
  fallback: T,
): Promise<T> {
  return Promise.race([
    probe,
    new Promise<T>((resolve) =>
      setTimeout(
        () =>
          resolve({
            ...fallback,
            status: 'critical',
            summary: 'Probe timed out.',
            details: [`Did not complete within ${TIMEOUT_MS}ms.`],
          } as T),
        TIMEOUT_MS,
      ),
    ),
  ]);
}

/** Trim long error messages and never echo back stack traces. */
function trimError(err: unknown): string {
  const raw = (err as { message?: string } | null)?.message ?? String(err ?? 'unknown');
  // Strip any newlines (stack traces, multi-line errors) and cap length.
  const oneLine = raw.replace(/\s*\n[\s\S]*$/, '').trim();
  return oneLine.length > 120 ? oneLine.slice(0, 120) + '…' : oneLine;
}

/* ────────────────── Individual probes ────────────────── */

/** Round-trip a small read against PostgREST. Latency thresholds:
 *  <500ms healthy, 500–2000ms warning, error/timeout/>2000ms warning→critical. */
export async function probeSupabase(): Promise<ProbeResult> {
  const t0 = Date.now();
  const supabase = createSupabaseServerClient();
  if (!supabase) {
    return {
      status: 'critical',
      summary: 'Supabase client could not initialise.',
      details: ['NEXT_PUBLIC_SUPABASE_URL or NEXT_PUBLIC_SUPABASE_ANON_KEY missing.'],
      suggestedChecks: [
        'Verify Supabase env vars in deployment.',
        'Redeploy after rotating keys.',
      ],
    };
  }
  try {
    const { error } = await supabase
      .from('app_settings')
      .select('key', { head: true, count: 'exact' })
      .limit(1);
    const ms = Date.now() - t0;
    if (error) {
      return {
        status: 'critical',
        summary: `PostgREST error after ${ms}ms.`,
        details: [trimError(error), `Code: ${error.code ?? 'unknown'}`],
        suggestedChecks: [
          'Check Supabase project status page.',
          'Verify anon key has SELECT on app_settings.',
        ],
      };
    }
    if (ms > 2000) {
      return {
        status: 'warning',
        summary: `Slow response: ${ms}ms.`,
        details: [`Round-trip exceeded 2s threshold.`],
        suggestedChecks: [
          'Inspect Supabase project metrics.',
          'Check for long-running queries blocking PostgREST.',
        ],
      };
    }
    if (ms > 500) {
      return {
        status: 'warning',
        summary: `Latency elevated: ${ms}ms.`,
        details: [`Above 500ms healthy threshold.`],
        suggestedChecks: ['Re-run probe; investigate if persistent.'],
      };
    }
    return {
      status: 'healthy',
      summary: `Round-trip ${ms}ms.`,
      details: ['Anon-key read succeeded against app_settings.'],
      suggestedChecks: ['Periodically verify service-role usage list.'],
    };
  } catch (e) {
    return {
      status: 'critical',
      summary: 'Supabase unreachable.',
      details: ['Connection failed (network or DNS).', trimError(e)],
      suggestedChecks: [
        'Check Supabase project status page.',
        'Confirm outbound network rules from the deployment.',
      ],
    };
  }
}

/** Direct pg pool — only meaningful when DATABASE_URL is set. */
export async function probePgPool(): Promise<ProbeResult> {
  if (!process.env.DATABASE_URL) {
    return {
      status: 'unknown',
      summary: 'DATABASE_URL not configured.',
      details: ['Direct Postgres path is optional; PostgREST handles all reads.'],
      suggestedChecks: ['Set DATABASE_URL if direct pg access is needed.'],
    };
  }
  const t0 = Date.now();
  try {
    // Dynamic import so non-Node runtimes aren't forced to load `pg`.
    const pgModule = (await import('pg')) as typeof import('pg');
    const Pool = pgModule.Pool;
    const pool = new Pool({
      connectionString: process.env.DATABASE_URL,
      max: 1,
      idleTimeoutMillis: 1000,
      connectionTimeoutMillis: 3000,
    });
    try {
      await pool.query('SELECT 1');
      const ms = Date.now() - t0;
      if (ms > 1500) {
        return {
          status: 'warning',
          summary: `Slow direct pg: ${ms}ms.`,
          details: ['Above 1.5s threshold.'],
          suggestedChecks: ['Inspect pool size and Postgres CPU usage.'],
        };
      }
      return {
        status: 'healthy',
        summary: `pg pool round-trip ${ms}ms.`,
        details: ['SELECT 1 succeeded over direct connection.'],
        suggestedChecks: ['Verify pool caps match deployment plan.'],
      };
    } finally {
      await pool.end().catch(() => undefined);
    }
  } catch (e) {
    return {
      status: 'critical',
      summary: 'pg pool failed.',
      details: ['Could not establish a direct Postgres connection.', trimError(e)],
      suggestedChecks: [
        'Verify DATABASE_URL is valid.',
        'Confirm SSL settings if Supabase requires sslmode=require.',
      ],
    };
  }
}

/** Latest hubstaff_uploads row + age. */
export async function probeHubstaffCsv(): Promise<ProbeResult> {
  const supabase = createSupabaseServiceRoleClient() ?? createSupabaseServerClient();
  if (!supabase) {
    return {
      status: 'unknown',
      summary: 'No Supabase client available.',
      details: [],
      suggestedChecks: [],
    };
  }
  try {
    const { data, error } = await supabase
      .from('hubstaff_uploads')
      .select('id, source_file, created_at')
      .order('created_at', { ascending: false })
      .limit(1);
    if (error) {
      return {
        status: 'warning',
        summary: 'Could not read hubstaff_uploads.',
        details: [trimError(error)],
        suggestedChecks: ['Verify table exists and service role has SELECT.'],
      };
    }
    const latest = data?.[0];
    if (!latest) {
      return {
        status: 'unknown',
        summary: 'No CSV uploads on file.',
        details: ['Table is empty — no payroll cycles imported yet.'],
        suggestedChecks: ['Run a Hubstaff CSV import to bootstrap.'],
      };
    }
    const ageMs = Date.now() - new Date(latest.created_at).getTime();
    const ageDays = Math.max(0, Math.floor(ageMs / 86_400_000));
    if (ageDays > 14) {
      return {
        status: 'warning',
        summary: `Latest upload is ${ageDays}d old.`,
        details: ['Hubstaff cycle imports may have stalled.'],
        suggestedChecks: ['Confirm payroll-clerk has been running weekly imports.'],
      };
    }
    return {
      status: ageDays > 7 ? 'warning' : 'healthy',
      summary: `Latest upload ${ageDays}d ago.`,
      details: [
        'Importer expects fixed daily slots; nulls slip through silently.',
        'Affects Payroll Wizard and Disbursement Records downstream.',
      ],
      suggestedChecks: [
        'Validate header detection on the latest upload.',
        'Reject rows with null daily totals before persistence.',
      ],
    };
  } catch (e) {
    return {
      status: 'unknown',
      summary: 'Hubstaff probe error.',
      details: [trimError(e)],
      suggestedChecks: [],
    };
  }
}

/** Master list / active_employees view row count. */
export async function probeMasterList(): Promise<ProbeResult> {
  const supabase = createSupabaseServiceRoleClient() ?? createSupabaseServerClient();
  if (!supabase) {
    return { status: 'unknown', summary: 'No Supabase client.', details: [], suggestedChecks: [] };
  }
  try {
    const { count, error } = await supabase
      .from('active_employees')
      .select('*', { head: true, count: 'exact' });
    if (error) {
      return {
        status: 'warning',
        summary: 'Could not read active_employees.',
        details: [trimError(error)],
        suggestedChecks: [
          'Verify view exists (see references/seed_global_master_list_*.sql).',
          'Refresh view after ALTER TABLE.',
        ],
      };
    }
    if (count == null || count === 0) {
      return {
        status: 'critical',
        summary: 'No active employees on roster.',
        details: ['Either the view is broken or no current upload is flagged.'],
        suggestedChecks: [
          'Check master_list_uploads.is_current = true on at least one row.',
          'Confirm a recent CSV import.',
        ],
      };
    }
    if (count < 50) {
      return {
        status: 'warning',
        summary: `Only ${count} active employees.`,
        details: ['Lower than expected for a full roster.'],
        suggestedChecks: ['Verify the latest CSV import populated the view.'],
      };
    }
    return {
      status: 'healthy',
      summary: `${count} active employees on roster.`,
      details: [
        'active_employees view filters to current upload’s last_seen_upload_id.',
        'Address + Google photo columns surfaced after migration refresh.',
      ],
      suggestedChecks: [
        'Confirm view exposes recently-added columns.',
        'Watch for duplicate Work Email rows after CSV import.',
      ],
    };
  } catch (e) {
    return { status: 'unknown', summary: 'Master list probe error.', details: [trimError(e)], suggestedChecks: [] };
  }
}

/**
 * HRIS adoption metric — how many roster members from the Global Master List
 * (active_employees view) have actually used the HRIS, plus the total roster
 * size, for the "Employees Onboarded" KPI card (rendered as onboarded / total).
 *
 * "Using the HRIS" = has a user_presence row. Presence is upserted per email on
 * every signed-in heartbeat (app/api/presence/heartbeat), so its email set is the
 * population of people who have opened the app while authenticated. There is no
 * DB FK between presence and the roster, so we match in-app by normalized email:
 * a member is counted as onboarded if EITHER their Work OR Personal email appears
 * in user_presence. Returns null on any failure so the card degrades to "—".
 */
export async function computeHrisAdoption(): Promise<{ onboarded: number; total: number } | null> {
  const supabase = createSupabaseServiceRoleClient() ?? createSupabaseServerClient();
  if (!supabase) return null;
  try {
    // Both paged: PostgREST silently caps reads at 1,000 rows (even explicit
    // ranges) and the roster is 1,296 — the KPI denominator froze at 1,000.
    const [rosterRes, presenceRes] = await Promise.all([
      selectAllPaged<{ 'Work Email'?: string | null; 'Personal Email'?: string | null }>((from, to) =>
        supabase
          .from('active_employees')
          .select('"Work Email", "Personal Email"')
          .order('Work Email', { ascending: true })
          .range(from, to),
      ),
      selectAllPaged<{ email: string | null }>((from, to) =>
        supabase.from('user_presence').select('email').order('email', { ascending: true }).range(from, to),
      ),
    ]);
    if (rosterRes.error || presenceRes.error) return null;

    const seen = new Set<string>();
    for (const r of presenceRes.rows) {
      const e = normEmail(r.email);
      if (e) seen.add(e);
    }

    const rows = rosterRes.rows;
    let onboarded = 0;
    for (const r of rows) {
      const w = normEmail(r['Work Email']);
      const p = normEmail(r['Personal Email']);
      if ((w && seen.has(w)) || (p && seen.has(p))) onboarded += 1;
    }
    return { onboarded, total: rows.length };
  } catch {
    return null;
  }
}

/** Most recent audit_log entry. Stale > 7d → warning. */
export async function probeAuditLog(): Promise<ProbeResult> {
  const supabase = createSupabaseServiceRoleClient() ?? createSupabaseServerClient();
  if (!supabase) {
    return { status: 'unknown', summary: 'No Supabase client.', details: [], suggestedChecks: [] };
  }
  try {
    const { data, error } = await supabase
      .from('audit_log')
      .select('id, created_at')
      .order('created_at', { ascending: false })
      .limit(1);
    if (error) {
      return {
        status: 'warning',
        summary: 'Could not read audit_log.',
        details: [trimError(error)],
        suggestedChecks: ['Verify audit_log table exists and service role has SELECT.'],
      };
    }
    const latest = data?.[0];
    if (!latest) {
      return {
        status: 'warning',
        summary: 'audit_log is empty.',
        details: ['No events recorded yet.'],
        suggestedChecks: ['Confirm insertAuditLog() is being called from action handlers.'],
      };
    }
    const ageMs = Date.now() - new Date(latest.created_at).getTime();
    const ageHours = Math.floor(ageMs / 3_600_000);
    if (ageHours > 168) {
      return {
        status: 'warning',
        summary: `Last entry ${Math.floor(ageHours / 24)}d ago.`,
        details: ['Audit pipeline may have stalled.'],
        suggestedChecks: ['Test an admin action and confirm a new audit row appears.'],
      };
    }
    return {
      status: 'healthy',
      summary: `Last entry ${ageHours}h ago.`,
      details: [
        'Login success/failure events are written to audit_log.',
        'Approve/deny/delete actions also logged with role + actor email.',
      ],
      suggestedChecks: [
        'Confirm retention policy on audit_log rows.',
        'Spot-check that admin_deleted entries include prior_status snapshot.',
      ],
    };
  } catch (e) {
    return { status: 'unknown', summary: 'Audit log probe error.', details: [trimError(e)], suggestedChecks: [] };
  }
}

/** Disbursement records row count. */
export async function probeDisbursementRecords(): Promise<ProbeResult> {
  const supabase = createSupabaseServiceRoleClient() ?? createSupabaseServerClient();
  if (!supabase) {
    return { status: 'unknown', summary: 'No Supabase client.', details: [], suggestedChecks: [] };
  }
  try {
    const { count, error } = await supabase
      .from('disbursement_records')
      .select('*', { head: true, count: 'exact' });
    if (error) {
      return {
        status: 'warning',
        summary: 'Could not read disbursement_records.',
        details: [trimError(error)],
        suggestedChecks: [
          'Verify references/seed_disbursement_records.sql has been applied.',
        ],
      };
    }
    return {
      status: 'healthy',
      summary: `${count ?? 0} disbursement rows on file.`,
      details: [
        'Per-(week, employee) snapshot powering CEO financial reports and People payroll history.',
        'Sync triggers from payment_dispatches keep statuses fresh.',
      ],
      suggestedChecks: [
        'Verify trigger health after any payment_dispatches schema change.',
      ],
    };
  } catch (e) {
    return {
      status: 'unknown',
      summary: 'Disbursement probe error.',
      details: [trimError(e)],
      suggestedChecks: [],
    };
  }
}

/** Auth — keep at warning until the admin gate is enforced server-side; layer on
 *  recent-login activity from the audit log for context. */
export async function probeAuth(): Promise<ProbeResult> {
  const supabase = createSupabaseServiceRoleClient() ?? createSupabaseServerClient();
  let recentLoginCount = 0;
  let probeError: string | null = null;

  if (supabase) {
    try {
      const since = new Date(Date.now() - 86_400_000).toISOString();
      const { count, error } = await supabase
        .from('audit_log')
        .select('*', { head: true, count: 'exact' })
        .ilike('action', 'auth.login.%')
        .gte('created_at', since);
      if (error) probeError = trimError(error);
      else recentLoginCount = count ?? 0;
    } catch (e) {
      probeError = trimError(e);
    }
  }

  const details = [
    'NextAuth + Google SSO restricted to the company workspace.',
    'Tab-level RBAC (allowedAccountingTabsForRoles) is best-effort today.',
  ];
  if (probeError) {
    details.push(`Login activity probe failed: ${probeError}`);
  } else {
    details.push(`Recent login events (24h): ${recentLoginCount}.`);
  }

  return {
    status: 'warning',
    summary: 'Admin gate is not fully enforced yet.',
    details,
    suggestedChecks: [
      'Add server-side admin checks on destructive routes.',
      'Audit sessionStorage-driven role lookups for tampering risk.',
    ],
  };
}

/** Daily report import — recent activity from audit_log. */
export async function probeDailyReport(): Promise<ProbeResult> {
  const supabase = createSupabaseServiceRoleClient() ?? createSupabaseServerClient();
  if (!supabase) {
    return { status: 'unknown', summary: 'No Supabase client.', details: [], suggestedChecks: [] };
  }
  try {
    const { data, error } = await supabase
      .from('audit_log')
      .select('created_at')
      .ilike('action', 'daily_reports.%')
      .order('created_at', { ascending: false })
      .limit(1);
    if (error) {
      return {
        status: 'unknown',
        summary: 'Daily report activity unknown.',
        details: [trimError(error)],
        suggestedChecks: [],
      };
    }
    const latest = data?.[0];
    if (!latest) {
      return {
        status: 'warning',
        summary: 'No daily reports recorded.',
        details: [
          'Either no imports have run yet, or the importer does not call insertAuditLog().',
        ],
        suggestedChecks: [
          'Run a daily report import.',
          'Confirm importer logs to audit_log.',
        ],
      };
    }
    const ageMs = Date.now() - new Date(latest.created_at).getTime();
    const ageHours = Math.floor(ageMs / 3_600_000);
    if (ageHours > 48) {
      return {
        status: 'warning',
        summary: `Last import ${Math.floor(ageHours / 24)}d ago.`,
        details: ['Schema drift may accumulate between imports.'],
        suggestedChecks: ['Run today’s import.'],
      };
    }
    return {
      status: 'healthy',
      summary: `Last import ${ageHours}h ago.`,
      details: [
        'Importer can create tables on demand based on report shape.',
        'Schema drift between imports needs human-readable change log.',
      ],
      suggestedChecks: [
        'Inspect the latest auto-created table’s column list.',
        'Confirm naming conventions match downstream readers.',
      ],
    };
  } catch (e) {
    return { status: 'unknown', summary: 'Daily report probe error.', details: [trimError(e)], suggestedChecks: [] };
  }
}

/** app_settings: confirms the bag-of-config table is readable and that the
 *  force-logout map (if present) is a valid JSON object. Critical because most
 *  runtime knobs (pab period, dispatch lock, feature permissions) live here. */
export async function probeAppSettings(): Promise<ProbeResult> {
  const supabase = createSupabaseServiceRoleClient() ?? createSupabaseServerClient();
  if (!supabase) {
    return { status: 'unknown', summary: 'No Supabase client.', details: [], suggestedChecks: [] };
  }
  try {
    const { count, error: countErr } = await supabase
      .from('app_settings')
      .select('*', { head: true, count: 'exact' });
    if (countErr) {
      return {
        status: 'critical',
        summary: 'Could not read app_settings.',
        details: [trimError(countErr)],
        suggestedChecks: ['Verify app_settings table exists and service role has SELECT.'],
      };
    }
    const { data, error: rowErr } = await supabase
      .from('app_settings')
      .select('value')
      .eq('key', 'auth.force_logout_map')
      .maybeSingle();
    if (rowErr && rowErr.code !== 'PGRST116') {
      return {
        status: 'warning',
        summary: 'app_settings reachable but force-logout map unreadable.',
        details: [trimError(rowErr), `${count ?? 0} keys on file.`],
        suggestedChecks: ['Confirm auth.force_logout_map row schema (key text, value text).'],
      };
    }
    let logoutEntries = 0;
    let logoutShapeOk = true;
    if (data?.value) {
      try {
        const parsed = JSON.parse(data.value);
        logoutShapeOk = !!parsed && typeof parsed === 'object' && !Array.isArray(parsed);
        if (logoutShapeOk) logoutEntries = Object.keys(parsed).length;
      } catch {
        logoutShapeOk = false;
      }
    }
    if (!logoutShapeOk) {
      return {
        status: 'warning',
        summary: 'auth.force_logout_map is not a valid JSON object.',
        details: [
          `${count ?? 0} keys on file.`,
          'Force-logout writes will reset the map on next bump.',
        ],
        suggestedChecks: [
          'Repair the row manually or clear it; bumpForceLogoutFor() rebuilds on next call.',
        ],
      };
    }
    return {
      status: 'healthy',
      summary: `${count ?? 0} keys on file.`,
      details: [
        'Backs PAB period, dispatch lock, feature permissions, force-logout map.',
        `Force-logout entries currently tracked: ${logoutEntries}.`,
      ],
      suggestedChecks: [
        'Use /api/app-settings?keys=a,b,c for multi-key reads instead of fan-out.',
      ],
    };
  } catch (e) {
    return { status: 'unknown', summary: 'app_settings probe error.', details: [trimError(e)], suggestedChecks: [] };
  }
}

/** Google Sheet → rates + master sync. Recency comes from audit_log
 *  (`csv.master.sync` / `csv.rates.sync`). Stale > 7d → warning, > 30d → critical. */
export async function probeGoogleSheetsSync(): Promise<ProbeResult> {
  const supabase = createSupabaseServiceRoleClient() ?? createSupabaseServerClient();
  if (!supabase) {
    return { status: 'unknown', summary: 'No Supabase client.', details: [], suggestedChecks: [] };
  }
  try {
    const [masterRes, ratesRes] = await Promise.all([
      supabase
        .from('audit_log')
        .select('created_at')
        .eq('action', 'csv.master.sync')
        .order('created_at', { ascending: false })
        .limit(1),
      supabase
        .from('audit_log')
        .select('created_at')
        .eq('action', 'csv.rates.sync')
        .order('created_at', { ascending: false })
        .limit(1),
    ]);
    if (masterRes.error || ratesRes.error) {
      return {
        status: 'unknown',
        summary: 'Sheet sync history unreadable.',
        details: [trimError(masterRes.error ?? ratesRes.error)],
        suggestedChecks: ['Verify audit_log reads work.'],
      };
    }
    const masterAt = masterRes.data?.[0]?.created_at as string | undefined;
    const ratesAt = ratesRes.data?.[0]?.created_at as string | undefined;
    const ageHours = (iso: string | undefined) =>
      iso ? Math.floor((Date.now() - new Date(iso).getTime()) / 3_600_000) : null;
    const masterAge = ageHours(masterAt);
    const ratesAge = ageHours(ratesAt);
    const fmt = (h: number | null) =>
      h == null ? 'never' : h < 48 ? `${h}h ago` : `${Math.floor(h / 24)}d ago`;
    const details = [
      `Master list last sync: ${fmt(masterAge)}.`,
      `Rates last sync: ${fmt(ratesAge)}.`,
      'Both sync paths are manual buttons in AdminCsvImports, not cron.',
    ];
    const worstAge = Math.max(masterAge ?? Infinity, ratesAge ?? Infinity);
    if (worstAge === Infinity) {
      return {
        status: 'warning',
        summary: 'Sheet sync has never run.',
        details,
        suggestedChecks: [
          'Click "Sync from Google Sheet" in Admin → CSV Imports.',
          'Verify GOOGLE_SHEETS_* env vars are set.',
        ],
      };
    }
    if (worstAge > 24 * 30) {
      return {
        status: 'critical',
        summary: `Stalest sync ${Math.floor(worstAge / 24)}d ago.`,
        details,
        suggestedChecks: [
          'Trigger a manual sync — rates and master are drifting from the source of truth.',
        ],
      };
    }
    if (worstAge > 24 * 7) {
      return {
        status: 'warning',
        summary: `Stalest sync ${Math.floor(worstAge / 24)}d ago.`,
        details,
        suggestedChecks: ['Manual syncs older than a week — consider running one.'],
      };
    }
    return {
      status: 'healthy',
      summary: `Latest sync ${fmt(Math.min(masterAge ?? Infinity, ratesAge ?? Infinity))}.`,
      details,
      suggestedChecks: [
        'Confirm GOOGLE_SHEETS_* env vars and service-account permissions if a sync fails.',
      ],
    };
  } catch (e) {
    return { status: 'unknown', summary: 'Sheet sync probe error.', details: [trimError(e)], suggestedChecks: [] };
  }
}

/** employee_rate_history: authoritative source for per-day rate resolution. */
export async function probeRateHistory(): Promise<ProbeResult> {
  const supabase = createSupabaseServiceRoleClient() ?? createSupabaseServerClient();
  if (!supabase) {
    return { status: 'unknown', summary: 'No Supabase client.', details: [], suggestedChecks: [] };
  }
  try {
    const { count, error } = await supabase
      .from('employee_rate_history')
      .select('*', { head: true, count: 'exact' });
    if (error) {
      return {
        status: 'warning',
        summary: 'Could not read employee_rate_history.',
        details: [trimError(error)],
        suggestedChecks: [
          'Verify employee_rate_history table exists.',
          'Without it, mid-cycle prorating falls back to current rate only.',
        ],
      };
    }
    if (!count || count === 0) {
      return {
        status: 'warning',
        summary: 'No rate-history rows on file.',
        details: ['Mid-cycle rate changes will not prorate correctly.'],
        suggestedChecks: [
          'Backfill from employee_hourly_rates if this is a fresh environment.',
        ],
      };
    }
    return {
      status: 'healthy',
      summary: `${count} rate-history rows on file.`,
      details: [
        'Authoritative source for per-day rate resolution.',
        'Used by current-pay.ts and member-monthly-pay.ts.',
      ],
      suggestedChecks: [
        'Confirm effectiveDate is passed when editing a rate mid-cycle.',
      ],
    };
  } catch (e) {
    return { status: 'unknown', summary: 'Rate history probe error.', details: [trimError(e)], suggestedChecks: [] };
  }
}

/**
 * New Hire Checklist — HR's weekly intake grid and its Lock-in, the event that
 * actually mails the Lead Gen orientation invite.
 *
 * Deliberately NOT folded into `probeHrOnboarding`: that probe reads the
 * STAGING tables (`hr_onboarding_submissions`, `hr_pending_employees`) a listed
 * hire still has to reach. Live those are different populations — 1,479 listed
 * against 1,049 staged — and the gap is the largest single loss in the hiring
 * funnel. One node covering both would hide it.
 *
 * Counts come back via `head: true` and the newest week via `limit(1)`, so this
 * probe never fetches rows and the 1,000-row PostgREST cap is unreachable —
 * `hr_new_hire_checklist` is already past it.
 */
export async function probeNewHireChecklist(): Promise<ProbeResult> {
  const supabase = createSupabaseServiceRoleClient() ?? createSupabaseServerClient();
  if (!supabase) {
    return { status: 'unknown', summary: 'No Supabase client.', details: [], suggestedChecks: [] };
  }
  try {
    const [listedRes, latestRes] = await Promise.all([
      supabase.from('hr_new_hire_checklist').select('*', { head: true, count: 'exact' }),
      supabase
        .from('hr_new_hire_checklist')
        .select('period_start')
        .order('period_start', { ascending: false })
        .limit(1),
    ]);

    if (listedRes.error) {
      return {
        status: 'warning',
        summary: 'Could not read hr_new_hire_checklist.',
        details: [trimError(listedRes.error)],
        suggestedChecks: ['Verify table exists and service role has SELECT.'],
      };
    }
    // A failed read of the newest week is NOT an empty table. Reporting "no
    // hiring weeks on file" because a query errored would be a lie about HR's
    // record, which is the exact failure class this map exists to catch.
    if (latestRes.error) {
      return {
        status: 'warning',
        summary: 'Checklist readable, newest week unreadable.',
        details: [trimError(latestRes.error), `${listedRes.count ?? 0} hire(s) listed across all weeks.`],
        suggestedChecks: ['Confirm period_start is still indexed and selectable.'],
      };
    }

    const listed = listedRes.count ?? 0;
    const latestWeek =
      (latestRes.data?.[0] as { period_start?: string | null } | undefined)?.period_start ?? null;

    if (!latestWeek) {
      return {
        status: 'unknown',
        summary: listed === 0 ? 'No hiring weeks on file.' : 'No week could be resolved.',
        details: [
          listed === 0
            ? 'hr_new_hire_checklist is empty — no recruits listed yet.'
            : `${listed} row(s) present but none carry a period_start.`,
        ],
        suggestedChecks: ['List a week of hires in HR → New Hire Checklist.'],
      };
    }

    const [weekRowsRes, periodRes] = await Promise.all([
      supabase
        .from('hr_new_hire_checklist')
        .select('*', { head: true, count: 'exact' })
        .eq('period_start', latestWeek),
      supabase
        .from('hr_new_hire_checklist_periods')
        .select('status, locked_at')
        .eq('period_start', latestWeek)
        .maybeSingle(),
    ]);

    const weekRows = weekRowsRes.count ?? 0;
    const period = periodRes.data as { status?: string | null } | null;
    // A week with no lock row is `open` by definition (getHrChecklistPeriod
    // returns that default), so absence is a state here, never an error.
    const lockUnreadable = !!periodRes.error;
    const locked = period?.status === 'locked';
    const ageDays = Math.max(
      0,
      Math.floor((Date.now() - new Date(`${latestWeek}T00:00:00Z`).getTime()) / 86_400_000),
    );

    const details = [
      `${listed} hire(s) listed across all weeks.`,
      `Newest week ${latestWeek}: ${weekRows} hire(s), ${
        lockUnreadable ? 'lock state unreadable' : locked ? 'locked' : 'open'
      }.`,
      'Lock-in mails the Lead Gen orientation invite from DB truth; a week left open sends nothing.',
      'Listed is not staged — a listed hire still has to reach hr_pending_employees.',
    ];
    if (lockUnreadable) details.push(trimError(periodRes.error));

    // The one condition worth amber: the week is over, it has hires, and it was
    // never locked — so nobody on it was emailed. Not a floor; a pipeline that
    // is working reads healthy, or the alerts list grows an entry nobody can
    // clear and the whole map stops meaning anything.
    if (!lockUnreadable && !locked && weekRows > 0 && ageDays > 7) {
      return {
        status: 'warning',
        summary: `Week ${latestWeek} still open ${ageDays}d on, with ${weekRows} hire(s).`,
        details,
        suggestedChecks: [
          'HR → New Hire Checklist → that week → Lock in (the dialog shows the date it will send).',
          'A hiring week that passed without a Lock-in never sent its orientation email.',
        ],
      };
    }

    return {
      status: 'healthy',
      summary: `${listed} listed; newest week ${latestWeek} ${locked ? 'locked' : 'open'}, ${weekRows} hire(s).`,
      details,
      suggestedChecks: [
        'Listed vs staged is the Never-staged card on Diagnostics → HR → HR Pipeline.',
        'Orientation shifts off an enabled US holiday — the Lock-in dialog shows the resolved date.',
      ],
    };
  } catch (e) {
    return {
      status: 'unknown',
      summary: 'New Hire Checklist probe error.',
      details: [trimError(e)],
      suggestedChecks: [],
    };
  }
}

/** HR Onboarding pipeline — form submissions + pending employee staging table. */
export async function probeHrOnboarding(): Promise<ProbeResult> {
  const supabase = createSupabaseServiceRoleClient() ?? createSupabaseServerClient();
  if (!supabase) {
    return { status: 'unknown', summary: 'No Supabase client.', details: [], suggestedChecks: [] };
  }
  try {
    const sevenDaysAgo = new Date(Date.now() - 7 * 86_400_000).toISOString();
    const [pendingFormsRes, stuckHiresRes, actionableHiresRes] = await Promise.all([
      supabase
        .from('hr_onboarding_submissions')
        .select('*', { head: true, count: 'exact' })
        .eq('status', 'pending'),
      supabase
        .from('hr_pending_employees')
        .select('*', { head: true, count: 'exact' })
        .eq('status', 'pending_work_email')
        .lt('created_at', sevenDaysAgo),
      supabase
        .from('hr_pending_employees')
        .select('*', { head: true, count: 'exact' })
        .in('status', ['pending_work_email', 'ready']),
    ]);

    if (pendingFormsRes.error) {
      return {
        status: 'warning',
        summary: 'Could not read hr_onboarding_submissions.',
        details: [trimError(pendingFormsRes.error)],
        suggestedChecks: ['Verify table exists and service role has SELECT.'],
      };
    }
    if (actionableHiresRes.error) {
      return {
        status: 'warning',
        summary: 'Could not read hr_pending_employees.',
        details: [trimError(actionableHiresRes.error)],
        suggestedChecks: ['Verify table exists and service role has SELECT.'],
      };
    }

    const pendingForms = pendingFormsRes.count ?? 0;
    const stuckHires = stuckHiresRes.count ?? 0;
    const actionableHires = actionableHiresRes.count ?? 0;

    const details = [
      `${pendingForms} form(s) sent and awaiting candidate submission.`,
      `${actionableHires} hire(s) in pending_work_email or ready status.`,
      stuckHires > 0
        ? `${stuckHires} hire(s) stuck in pending_work_email for >7 days.`
        : 'No hires stuck awaiting work-email assignment.',
      'Workspace setup webhook (n8n) fires when HR assigns a work email.',
    ];

    if (stuckHires > 0) {
      return {
        status: 'warning',
        summary: `${stuckHires} hire(s) awaiting work email for >7 days.`,
        details,
        suggestedChecks: [
          'Assign work emails in Admin → HR → Pending Employees.',
          'Use "Retry workspace setup" if the webhook previously failed.',
        ],
      };
    }

    return {
      status: 'healthy',
      summary: `${actionableHires} hire(s) in pipeline; ${pendingForms} form(s) outstanding.`,
      details,
      suggestedChecks: [
        'Verify workspace setup webhook fires after work-email assignment.',
        'Confirm bank/payment details carry over from onboarding form to employee portal.',
      ],
    };
  } catch (e) {
    return { status: 'unknown', summary: 'HR Onboarding probe error.', details: [trimError(e)], suggestedChecks: [] };
  }
}

/** HR Offboarding pipeline — recent offboard events + webhook fire health. */
export async function probeHrOffboarding(): Promise<ProbeResult> {
  const supabase = createSupabaseServiceRoleClient() ?? createSupabaseServerClient();
  if (!supabase) {
    return { status: 'unknown', summary: 'No Supabase client.', details: [], suggestedChecks: [] };
  }
  try {
    const since30d = new Date(Date.now() - 30 * 86_400_000).toISOString();
    const [offboardCountRes, webhookRes, offboardedTotalRes] = await Promise.all([
      supabase
        .from('audit_log')
        .select('*', { head: true, count: 'exact' })
        .eq('action', 'hr.employee.offboarded')
        .gte('created_at', since30d),
      supabase
        .from('audit_log')
        .select('created_at, details')
        .ilike('action', 'hr.employee.webhook_fired.%')
        .order('created_at', { ascending: false })
        .limit(20),
      supabase
        .from('global_master_list')
        .select('*', { head: true, count: 'exact' })
        .not('off_boarded_at', 'is', null),
    ]);

    if (webhookRes.error) {
      return {
        status: 'unknown',
        summary: 'Offboarding webhook history unreadable.',
        details: [trimError(webhookRes.error)],
        suggestedChecks: ['Verify audit_log access.'],
      };
    }

    const recentOffboards = offboardCountRes.count ?? 0;
    const totalOffboarded = offboardedTotalRes.count ?? 0;
    const recentWebhooks = webhookRes.data ?? [];

    const failedCount = recentWebhooks.filter((r) => {
      const d = (r as { details: Record<string, unknown> | null }).details;
      return d && typeof d === 'object' && d['webhook_fired'] === false;
    }).length;

    const details = [
      `${totalOffboarded} employee(s) offboarded total.`,
      `${recentOffboards} offboard event(s) in the last 30 days.`,
      recentWebhooks.length > 0
        ? `Last ${recentWebhooks.length} webhook fire(s) checked; ${failedCount} failed.`
        : 'No manual webhook re-fires on record.',
      'Deactivate + delete webhooks fire via n8n; re-fireable from HR → Offboarding tab.',
    ];

    if (failedCount > 0) {
      return {
        status: 'warning',
        summary: `${failedCount} recent offboard webhook failure(s).`,
        details,
        suggestedChecks: [
          'Use HR → Offboarding → "Re-fire webhook" for affected employees.',
          'Check n8n logs for OFFBOARD_DEACTIVATE_SLUG / OFFBOARD_DELETE_SLUG.',
        ],
      };
    }

    return {
      status: 'healthy',
      summary: `${recentOffboards} offboard(s) in 30d; webhook pipeline healthy.`,
      details,
      suggestedChecks: [
        'Confirm OFFBOARD_DEACTIVATE_SLUG and OFFBOARD_DELETE_SLUG env vars are set.',
        'Spot-check Google Sheet Master List rows after a delete event.',
      ],
    };
  } catch (e) {
    return { status: 'unknown', summary: 'HR Offboarding probe error.', details: [trimError(e)], suggestedChecks: [] };
  }
}

/** employee_hourly_rates row count for the Rates Management node. */
export async function probeRates(): Promise<ProbeResult> {
  const supabase = createSupabaseServiceRoleClient() ?? createSupabaseServerClient();
  if (!supabase) {
    return { status: 'unknown', summary: 'No Supabase client.', details: [], suggestedChecks: [] };
  }
  try {
    const { count, error } = await supabase
      .from('employee_hourly_rates')
      .select('*', { head: true, count: 'exact' });
    if (error) {
      return {
        status: 'warning',
        summary: 'Could not read employee_hourly_rates.',
        details: [trimError(error)],
        suggestedChecks: ['Verify table exists.'],
      };
    }
    if (!count || count === 0) {
      return {
        status: 'warning',
        summary: 'No rate records on file.',
        details: ['Rates page will fall back to master-list-only profiles.'],
        suggestedChecks: ['Seed employee_hourly_rates from references/seed_employee_hourly_rates.sql.'],
      };
    }
    return {
      status: 'healthy',
      summary: `${count} rate records on file.`,
      details: [
        'Cards/table toggle wired to /api/employee-rate-profiles.',
        'Suspended rows render dimmed; missing-rate badges surfaced.',
      ],
      suggestedChecks: [
        'Confirm “Missing Regular Rate” count matches HR’s expectation.',
      ],
    };
  } catch (e) {
    return { status: 'unknown', summary: 'Rates probe error.', details: [trimError(e)], suggestedChecks: [] };
  }
}

/** Tickets Kanban board — `tickets` (+ ticket_comments / ticket_events). Reads
 *  the board so a missing migration or lost SELECT grant surfaces as a warning. */
export async function probeTickets(): Promise<ProbeResult> {
  const supabase = createSupabaseServiceRoleClient() ?? createSupabaseServerClient();
  if (!supabase) {
    return { status: 'unknown', summary: 'No Supabase client.', details: [], suggestedChecks: [] };
  }
  try {
    const [activeRes, doneRes] = await Promise.all([
      supabase
        .from('tickets')
        .select('*', { head: true, count: 'exact' })
        .is('archived_at', null),
      supabase
        .from('tickets')
        .select('*', { head: true, count: 'exact' })
        .is('archived_at', null)
        .eq('status', 'done'),
    ]);
    if (activeRes.error) {
      return {
        status: 'warning',
        summary: 'Could not read tickets.',
        details: [trimError(activeRes.error)],
        suggestedChecks: [
          'Verify the tickets table exists (run the tickets-board migration).',
          'Confirm service role has SELECT on tickets.',
        ],
      };
    }
    const active = activeRes.count ?? 0;
    const done = doneRes.count ?? 0;
    return {
      status: 'healthy',
      summary: `${active} active ticket(s) on the board.`,
      details: [
        `${done} in Done; ${Math.max(0, active - done)} still open.`,
        'Kanban board at /tickets — gated by the dedicated tickets role.',
        'Backed by tickets + ticket_comments + ticket_events.',
      ],
      suggestedChecks: [
        'Confirm ticket_comments and ticket_events tables also exist.',
        'Re-grant the tickets role to anyone who should keep board access.',
      ],
    };
  } catch (e) {
    return { status: 'unknown', summary: 'Tickets probe error.', details: [trimError(e)], suggestedChecks: [] };
  }
}

/** Time Adjustment Requests — `time_adjustment_requests`. Surfaces the two-stage
 *  review backlog; a request stuck > 14 days is a warning. */
export async function probeTimeAdjustments(): Promise<ProbeResult> {
  const supabase = createSupabaseServiceRoleClient() ?? createSupabaseServerClient();
  if (!supabase) {
    return { status: 'unknown', summary: 'No Supabase client.', details: [], suggestedChecks: [] };
  }
  try {
    const fourteenDaysAgo = new Date(Date.now() - 14 * 86_400_000).toISOString();
    const [awaitingMgrRes, awaitingAcctRes, staleRes] = await Promise.all([
      supabase
        .from('time_adjustment_requests')
        .select('*', { head: true, count: 'exact' })
        .eq('status', 'pending'),
      supabase
        .from('time_adjustment_requests')
        .select('*', { head: true, count: 'exact' })
        .eq('status', 'manager_approved'),
      supabase
        .from('time_adjustment_requests')
        .select('*', { head: true, count: 'exact' })
        .in('status', ['pending', 'manager_approved'])
        .lt('created_at', fourteenDaysAgo),
    ]);
    if (awaitingMgrRes.error) {
      return {
        status: 'warning',
        summary: 'Could not read time_adjustment_requests.',
        details: [trimError(awaitingMgrRes.error)],
        suggestedChecks: [
          'Verify the time_adjustment_requests table exists (run the create + requested_segments alter SQL).',
          'Confirm service role has SELECT.',
        ],
      };
    }
    const awaitingMgr = awaitingMgrRes.count ?? 0;
    const awaitingAcct = awaitingAcctRes.count ?? 0;
    const stale = staleRes.count ?? 0;
    const details = [
      `${awaitingMgr} awaiting manager review; ${awaitingAcct} awaiting Accounting.`,
      'Two-stage flow: employee → manager → Accounting; approval SET-overrides the day.',
      'Never mutates hubstaff_hours — overrides apply at pay-calc time.',
    ];
    if (stale > 0) {
      return {
        status: 'warning',
        summary: `${stale} request(s) pending > 14 days.`,
        details,
        suggestedChecks: [
          'Clear the backlog in Manager → Time Adjustments / the Accounting review panel.',
          'Confirm managers have department assignments so they can act.',
        ],
      };
    }
    return {
      status: 'healthy',
      summary: `${awaitingMgr + awaitingAcct} open request(s) in the queue.`,
      details,
      suggestedChecks: [
        'Spot-check that an approved override lands on the pay calc.',
        'Verify evidence images sign correctly in the review panel.',
      ],
    };
  } catch (e) {
    return { status: 'unknown', summary: 'Time adjustments probe error.', details: [trimError(e)], suggestedChecks: [] };
  }
}

/** Payroll Wizard Notes — `payroll_wizard_notes`. Low-risk carry-over checklist;
 *  a table read confirms the board + wizard bridge can load. */
export async function probePayrollWizardNotes(): Promise<ProbeResult> {
  const supabase = createSupabaseServiceRoleClient() ?? createSupabaseServerClient();
  if (!supabase) {
    return { status: 'unknown', summary: 'No Supabase client.', details: [], suggestedChecks: [] };
  }
  try {
    const [totalRes, openRes] = await Promise.all([
      supabase.from('payroll_wizard_notes').select('*', { head: true, count: 'exact' }),
      supabase
        .from('payroll_wizard_notes')
        .select('*', { head: true, count: 'exact' })
        .eq('done', false),
    ]);
    if (totalRes.error) {
      return {
        status: 'warning',
        summary: 'Could not read payroll_wizard_notes.',
        details: [trimError(totalRes.error)],
        suggestedChecks: [
          'Verify the payroll_wizard_notes table exists (run create + the adjustment/week_start alter SQL).',
          'Confirm service role has SELECT.',
        ],
      };
    }
    const total = totalRes.count ?? 0;
    const open = openRes.count ?? 0;
    return {
      status: 'healthy',
      summary: `${open} open note(s); ${total} total.`,
      details: [
        'Carry-over checklist for the payroll week — missed bonuses, rate changes, deductions.',
        'Bridges the wizard Additions "Adj." column both ways.',
        'week_start = Manila Monday; blank rows seed per edit-granted clerk.',
      ],
      suggestedChecks: [
        'Confirm the week selector shows the current Manila week.',
        'Verify a wizard Adj. override mirrors onto the board.',
      ],
    };
  } catch (e) {
    return { status: 'unknown', summary: 'Payroll notes probe error.', details: [trimError(e)], suggestedChecks: [] };
  }
}

/** MESA program — `mesa_ledger` (event backfill) plus the optional `mesa_accounts`
 *  registry. Accounts read is best-effort so a pre-migration env still probes. */
export async function probeMesa(): Promise<ProbeResult> {
  const supabase = createSupabaseServiceRoleClient() ?? createSupabaseServerClient();
  if (!supabase) {
    return { status: 'unknown', summary: 'No Supabase client.', details: [], suggestedChecks: [] };
  }
  try {
    const { count, error } = await supabase
      .from('mesa_ledger')
      .select('*', { head: true, count: 'exact' });
    if (error) {
      return {
        status: 'warning',
        summary: 'Could not read mesa_ledger.',
        details: [trimError(error)],
        suggestedChecks: [
          'Verify mesa_ledger exists (run references/sql/create/backfill_mesa_ledger.sql).',
          'Confirm service role has SELECT.',
        ],
      };
    }
    // Accounts registry is optional (per-stint migration may not have run yet).
    let accountsNote = 'mesa_accounts registry not detected (per-stint numbering off).';
    const acctRes = await supabase
      .from('mesa_accounts')
      .select('*', { head: true, count: 'exact' })
      .is('closed_on', null);
    if (!acctRes.error) accountsNote = `${acctRes.count ?? 0} open MESA account(s).`;
    if (!count || count === 0) {
      return {
        status: 'warning',
        summary: 'mesa_ledger is empty.',
        details: ['No MESA ledger events on file — the backfill may not have run.', accountsNote],
        suggestedChecks: ['Run references/sql/create/backfill_mesa_ledger.sql.'],
      };
    }
    return {
      status: 'healthy',
      summary: `${count} MESA ledger event(s) on file.`,
      details: [
        '1:1 backfill of the external MESA tracker: deposits, disbursements, status snapshots.',
        accountsNote,
        "Balances scope to each member's current (open) account number.",
      ],
      suggestedChecks: [
        'Spot-check a member rollup against the external tracker.',
        'Confirm opt-out closes the account and a re-join mints a new number.',
      ],
    };
  } catch (e) {
    return { status: 'unknown', summary: 'MESA probe error.', details: [trimError(e)], suggestedChecks: [] };
  }
}

/**
 * Payment Dispatch — `payment_dispatches`, the live dispatch log every money
 * surface reads its PAID figures from (Penny's pay breakdown, the CEO payments
 * feed, the close-out's frozen totals).
 *
 * Staleness is the real signal here: payroll runs weekly, so a newest dispatch
 * older than two weeks means two pay weeks went out somewhere other than this
 * system — which has happened, for four consecutive weeks in Jun–Jul 2026
 * (`diagnostics-performance-tabs.md` § `not_run`), and no screen announced it
 * at the time.
 *
 * It reports counts, never a rate. `payment_dispatches` cannot see a payable
 * person who was never dispatched, so any percentage over it sits at 97–99% by
 * construction and flatters every week — the Payroll Cycles tab owns rates, and
 * only over a close-out's payable denominator.
 */
export async function probePaymentDispatch(): Promise<ProbeResult> {
  const supabase = createSupabaseServiceRoleClient() ?? createSupabaseServerClient();
  if (!supabase) {
    return { status: 'unknown', summary: 'No Supabase client.', details: [], suggestedChecks: [] };
  }
  try {
    const [totalRes, paidRes, latestRes] = await Promise.all([
      supabase.from('payment_dispatches').select('*', { head: true, count: 'exact' }),
      supabase
        .from('payment_dispatches')
        .select('*', { head: true, count: 'exact' })
        .eq('status', 'paid'),
      supabase
        .from('payment_dispatches')
        .select('created_at')
        .order('created_at', { ascending: false })
        .limit(1),
    ]);

    if (totalRes.error) {
      return {
        status: 'warning',
        summary: 'Could not read payment_dispatches.',
        details: [trimError(totalRes.error)],
        suggestedChecks: ['Verify table exists and service role has SELECT.'],
      };
    }

    const total = totalRes.count ?? 0;
    const paid = paidRes.error ? null : paidRes.count ?? 0;
    const latest = (latestRes.data?.[0] as { created_at?: string | null } | undefined)?.created_at ?? null;

    if (total === 0) {
      return {
        status: 'unknown',
        summary: 'No dispatch rows on file.',
        details: ['payment_dispatches is empty — no pay has been staged through this system.'],
        suggestedChecks: ['Stage a cycle in Accounting → Payment Dispatch.'],
      };
    }

    const details = [
      `${total} dispatch row(s) on file${paid === null ? '' : `; ${paid} marked paid`}.`,
      latest ? `Newest dispatch logged ${latest.slice(0, 10)}.` : 'Newest dispatch timestamp unreadable.',
      'The live source for paid figures on Pay Stubs, Penny and the CEO payments feed.',
      'Counts only — a rate over this table cannot see a payable person who was never dispatched.',
    ];
    if (paidRes.error) details.push(`Paid count unreadable: ${trimError(paidRes.error)}`);

    if (latest) {
      const ageDays = Math.max(0, Math.floor((Date.now() - new Date(latest).getTime()) / 86_400_000));
      if (ageDays > 14) {
        return {
          status: 'warning',
          summary: `Newest dispatch is ${ageDays}d old.`,
          details,
          suggestedChecks: [
            'Payroll is weekly — two missed weeks means pay ran outside HRIS or stalled.',
            'Check Accounting → Payment Dispatch for an unstaged cycle.',
          ],
        };
      }
      return {
        status: 'healthy',
        summary: `${total} dispatch row(s); newest ${ageDays}d ago.`,
        details,
        suggestedChecks: [
          'Cross-check a week against Diagnostics → Accounting → Payroll Cycles.',
        ],
      };
    }

    return {
      status: 'healthy',
      summary: `${total} dispatch row(s) on file.`,
      details,
      suggestedChecks: ['Confirm created_at is populated so staleness can be measured.'],
    };
  } catch (e) {
    return {
      status: 'unknown',
      summary: 'Payment Dispatch probe error.',
      details: [trimError(e)],
      suggestedChecks: [],
    };
  }
}

/**
 * Cycle close-out — the per-week declarations Accounting files from Payment
 * Dispatch, one `app_settings` row per cycle under `dispatch.cycle_closeout.`.
 * This is the only artifact in the system carrying a PAYABLE denominator, which
 * is why the Payroll Cycles tab can compute a rate at all.
 *
 * **There is deliberately no staleness warning.** Closing a week is a human
 * cadence, not a system function — live, 22 of 27 cycles pre-date the feature
 * existing — so an age threshold here would sit permanently amber and train
 * admins to ignore the map. Which cycles are still unclosed is a question the
 * Payroll Cycles tab already answers, over data this probe does not re-derive;
 * a second implementation of "is this week declared?" could only disagree with
 * the first.
 */
export async function probeCycleCloseout(): Promise<ProbeResult> {
  const supabase = createSupabaseServiceRoleClient() ?? createSupabaseServerClient();
  if (!supabase) {
    return { status: 'unknown', summary: 'No Supabase client.', details: [], suggestedChecks: [] };
  }
  try {
    const pattern = `${CYCLE_CLOSEOUT_PREFIX}%`;
    const [countRes, latestRes] = await Promise.all([
      supabase.from('app_settings').select('*', { head: true, count: 'exact' }).like('key', pattern),
      supabase
        .from('app_settings')
        .select('updated_at')
        .like('key', pattern)
        .order('updated_at', { ascending: false })
        .limit(1),
    ]);

    if (countRes.error) {
      return {
        status: 'warning',
        summary: 'Could not read close-out records.',
        details: [trimError(countRes.error)],
        suggestedChecks: ['Verify app_settings is readable by the service role.'],
      };
    }

    const declared = countRes.count ?? 0;
    const latest = (latestRes.data?.[0] as { updated_at?: string | null } | undefined)?.updated_at ?? null;

    const details = [
      `${declared} cycle(s) declared closed.`,
      latest ? `Newest declaration written ${latest.slice(0, 10)}.` : 'No declaration timestamp available.',
      'The only artifact carrying a payable denominator — every pay-cycle rate reads it.',
      'A reopen archives the record under dispatch.cycle_reopened.* and frees this key.',
    ];

    if (declared === 0) {
      return {
        status: 'unknown',
        summary: 'No cycle close-outs on file.',
        details: [
          'No pay week has been declared closed yet, so no cycle carries a payable denominator.',
          'Pre-close-out weeks are not failures — the feature post-dates most cycles.',
        ],
        suggestedChecks: ['Close a week from Accounting → Payment Dispatch.'],
      };
    }

    return {
      status: 'healthy',
      summary: `${declared} cycle(s) declared closed.`,
      details,
      suggestedChecks: [
        'Unclosed and pre-close-out weeks are listed on Diagnostics → Accounting → Payroll Cycles.',
      ],
    };
  } catch (e) {
    return {
      status: 'unknown',
      summary: 'Cycle close-out probe error.',
      details: [trimError(e)],
      suggestedChecks: [],
    };
  }
}

/**
 * Do the HRIS's two answers to "who is active" still agree?
 *
 * `active_employees` (unstamped AND on the current upload) versus what the
 * external API serves (unstamped, full stop). They differed by 508 rows on
 * 2026-09-21 — Admin → Integrations said 1,723, HR → Global Master List said
 * 1,215 — and nothing in the app was positioned to notice. This probe is the
 * "once and for all" half of that fix: the next divergence is visible the day
 * it starts.
 *
 * Identity is folded across all four email columns. A count keyed on one column
 * is unsound against this table: it is how an earlier pass reported 217 people
 * missing when the true number was 7.
 */
export async function probeRosterDrift(): Promise<ProbeResult> {
  const supabase = createSupabaseServiceRoleClient() ?? createSupabaseServerClient();
  if (!supabase) {
    return { status: 'unknown', summary: 'No Supabase client.', details: [], suggestedChecks: [] };
  }
  try {
    const current = await supabase
      .from('master_list_uploads')
      .select('id')
      .eq('is_current', true)
      .limit(1)
      .maybeSingle();
    if (current.error) {
      return {
        status: 'warning',
        summary: 'Could not read master_list_uploads.',
        details: [trimError(current.error)],
        suggestedChecks: ['Confirm exactly one upload is flagged is_current.'],
      };
    }
    const currentId = (current.data as { id?: string } | null)?.id ?? null;

    const { rows, error } = await selectAllPaged<Record<string, unknown>>((from, to) =>
      supabase
        .from('global_master_list')
        .select(
          '"Work Email","Personal Email","Alternate Work Email","Alternate Work Email 2",off_boarded_at,last_seen_upload_id',
        )
        .is('off_boarded_at', null)
        .order('id', { ascending: true })
        .range(from, to),
    );
    if (error) {
      return {
        status: 'warning',
        summary: 'Could not read the master list.',
        details: [error],
        suggestedChecks: ['Check service-role credentials and RLS on global_master_list.'],
      };
    }

    const cols = ['Work Email', 'Personal Email', 'Alternate Work Email', 'Alternate Work Email 2'];
    const parent = new Map<string, string>();
    const find = (x: string): string => {
      let r = x;
      while (parent.get(r) !== r) r = parent.get(r)!;
      return r;
    };
    const add = (x: string) => {
      if (!parent.has(x)) parent.set(x, x);
    };
    const emailsOf = (r: Record<string, unknown>): string[] =>
      cols.map((c) => normEmail(String(r[c] ?? ''))).filter((e): e is string => Boolean(e));
    for (const r of rows) {
      const es = emailsOf(r);
      es.forEach(add);
      for (let i = 1; i < es.length; i++) {
        const a = find(es[0]);
        const b = find(es[i]);
        if (a !== b) parent.set(a, b);
      }
    }
    const keyOf = (r: Record<string, unknown>, idx: number) => {
      const es = emailsOf(r);
      return es.length ? find(es[0]) : `row:${idx}`;
    };

    const onView = new Set<string>();
    let viewRows = 0;
    rows.forEach((r, i) => {
      if (currentId && r['last_seen_upload_id'] === currentId) {
        viewRows += 1;
        onView.add(keyOf(r, i));
      }
    });
    const allPeople = new Set(rows.map((r, i) => keyOf(r, i)));
    let unexplained = 0;
    for (const p of allPeople) if (!onView.has(p)) unexplained += 1;

    const verdict = judgeRosterDrift({ activeRows: rows.length, viewRows, unexplained });
    return {
      status: verdict.status,
      summary: verdict.summary,
      details: verdict.details,
      suggestedChecks:
        verdict.status === 'healthy'
          ? []
          : [
              'Rehearse scripts/reconcile-gml-active-only.mts — it splits the gap without writing.',
              'docs/features/gml-roster-source-of-truth.md explains the transfer-fork cause.',
            ],
    };
  } catch (e) {
    return { status: 'unknown', summary: 'Roster drift probe error.', details: [trimError(e)], suggestedChecks: [] };
  }
}
