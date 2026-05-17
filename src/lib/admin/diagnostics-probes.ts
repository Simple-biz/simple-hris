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
        'Per-(week, employee) snapshot powering Reports tab.',
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

/** manager_team_wallpapers: per-department "My Team" banner. Optional table. */
export async function probeManagerWallpapers(): Promise<ProbeResult> {
  const supabase = createSupabaseServiceRoleClient() ?? createSupabaseServerClient();
  if (!supabase) {
    return { status: 'unknown', summary: 'No Supabase client.', details: [], suggestedChecks: [] };
  }
  try {
    const { count, error } = await supabase
      .from('manager_team_wallpapers')
      .select('*', { head: true, count: 'exact' });
    if (error) {
      return {
        status: 'warning',
        summary: 'manager_team_wallpapers not reachable.',
        details: [
          trimError(error),
          'Department banners fall back to default styling when this table is missing.',
        ],
        suggestedChecks: [
          'Apply references/create_manager_team_wallpapers.sql.',
        ],
      };
    }
    return {
      status: 'healthy',
      summary: `${count ?? 0} department banner${count === 1 ? '' : 's'} on file.`,
      details: [
        'Inline data-URL image per department; capped ~10 MB by the API.',
        'background_position column added via idempotent ALTER.',
      ],
      suggestedChecks: [
        'Spot-check a banner renders for one department.',
      ],
    };
  } catch (e) {
    return {
      status: 'unknown',
      summary: 'Wallpapers probe error.',
      details: [trimError(e)],
      suggestedChecks: [],
    };
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
