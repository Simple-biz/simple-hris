import { createSupabaseServerClient, createSupabaseServiceRoleClient } from "@/lib/supabase/server";
import { mapHubstaffHoursRow } from "@/lib/supabase/hubstaff-hours";
import {
  deleteHubstaffRowsBySourceFile,
  fetchHubstaffRowsOrdered,
  fetchHubstaffRowsBySourceFile,
  fetchHubstaffRowsGroupedBySourceFile,
  getCurrentHubstaffUploadId,
  getUploadedSourceFiles,
  listHubstaffUploads,
  renameHubstaffSourceFile,
  setHubstaffUploadCurrentBySourceFile,
  replaceHubstaffHoursFromCsvText,
  rowsToPayrollRows,
  sortHubstaffColumnsForDisplay,
} from "@/lib/supabase/hubstaff-hours-db";
import { insertAuditLog } from "@/lib/supabase/audit-log";
import {
  notifyPayrollAvailable,
  deletePayrollAvailableNotifications,
} from "@/lib/notifications/payroll-available";
import {
  recordMesaWeeklyContributions,
  deleteMesaWeeklyContributions,
} from "@/lib/mesa/record-weekly-contributions";
import {
  fetchDailyActivitiesCached,
  getHubstaffOrgId,
  hubstaffApiConfigured,
} from "@/lib/hubstaff/api-client";
import { normEmail } from "@/lib/email/norm-email";
import { getSessionActor } from "@/lib/auth/session-actor";
import { requireFeatureEdit } from "@/lib/auth/authorize-feature";
import { authorizeEmailAccess, deniedResponse } from "@/lib/auth/authorize-email";
import { NextRequest, NextResponse } from "next/server";
import { cleanErrorMessage } from "@/lib/clean-error-message";
import { selectAllPaged } from "@/lib/supabase/select-all-paged";

// Columns on the hubstaff_hours row that may carry an employee's email.
// Mirrors `HUBSTAFF_EMAIL_KEYS` + the case-insensitive aliases used client-side
// in src/components/employee/EmployeeDashboard.tsx — keep in sync.
const HUBSTAFF_ROW_EMAIL_KEYS = [
  'Email', 'email',
  'Work Email', 'work_email',
  'Personal Email', 'personal_email',
  'user_email',
] as const;

function rowMatchesAnyEmail(row: Record<string, unknown>, normTargets: Set<string>): boolean {
  const lowerIdx = new Map<string, unknown>();
  for (const [k, v] of Object.entries(row)) lowerIdx.set(k.toLowerCase(), v);
  for (const key of HUBSTAFF_ROW_EMAIL_KEYS) {
    const v = Object.prototype.hasOwnProperty.call(row, key)
      ? row[key]
      : lowerIdx.get(key.toLowerCase());
    if (v == null) continue;
    const n = normEmail(String(v));
    if (n && normTargets.has(n)) return true;
  }
  return false;
}

/**
 * Expand a single email to the full set of a person's emails using the master
 * list. Hubstaff rows are sometimes keyed on a gsuite alternate work email
 * (e.g. kevin@) while the caller looks up by the primary work email (kevt@), so
 * matching only the literal email misses their hours. Returns at least the input
 * email; on any failure it degrades to just that. The Global Master List is the
 * source of truth for which addresses belong to one human.
 */
async function expandEmailAliases(norm: string): Promise<Set<string>> {
  const set = new Set<string>([norm]);
  try {
    const supabase = createSupabaseServiceRoleClient() ?? createSupabaseServerClient();
    if (!supabase) return set;
    // Paged: the roster passed 1,000 people and PostgREST silently caps
    // un-ranged selects there — a person whose row sorted past the cap got no
    // alias expansion, so their My Hours view missed alias-keyed rows.
    const { rows } = await selectAllPaged<Record<string, unknown>>((from, to) =>
      supabase
        .from("active_employees")
        .select('"Work Email","Personal Email","Alternate Work Email","Alternate Work Email 2"')
        .order("Work Email", { ascending: true })
        .range(from, to),
    );
    for (const raw of rows) {
      const emails = [
        raw["Work Email"],
        raw["Personal Email"],
        raw["Alternate Work Email"],
        raw["Alternate Work Email 2"],
      ]
        .map((v) => (typeof v === "string" ? normEmail(v) : null))
        .filter((v): v is string => !!v);
      if (emails.includes(norm)) {
        for (const e of emails) set.add(e);
        break;
      }
    }
  } catch {
    /* non-fatal — fall back to the single email */
  }
  return set;
}

function clientIp(req: NextRequest): string | null {
  const fwd = req.headers.get('x-forwarded-for');
  return fwd ? fwd.split(',')[0].trim() : (req.headers.get('x-real-ip') ?? null);
}

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export async function GET(req: NextRequest) {
  const { searchParams } = new URL(req.url);

  // Live current-hours overlay for the employee "My Hours" surface. Returns this
  // person's per-day tracked seconds for the trailing two weeks straight from the
  // Hubstaff API (org-timezone bucketed, same as uploads) — so today's time shows
  // up in near-real-time instead of waiting for the weekly batch. Self-scoped:
  // employees can only request their own hours; elevated roles may request anyone.
  // The org-wide fetch is cached server-side (~3 min) to respect Hubstaff rate limits.
  if (searchParams.get("live") === "1") {
    const requested = searchParams.get("email")?.trim() || null;
    const authz = await authorizeEmailAccess(requested);
    if (!authz.ok) return deniedResponse(authz);

    if (!hubstaffApiConfigured()) {
      // Not an error — environments without credentials simply have no overlay.
      return NextResponse.json({ configured: false, days: {}, totalSeconds: 0, error: null });
    }

    try {
      const norm = normEmail(authz.effectiveEmail) ?? authz.effectiveEmail.toLowerCase();
      const aliasSet = await expandEmailAliases(norm);

      // Trailing window: 13 days back through tomorrow. The +1 day absorbs the
      // org-timezone date running ahead of the server's UTC date; Hubstaff just
      // returns nothing for a date with no activity yet.
      const DAY_MS = 86_400_000;
      const todayUtc = new Date();
      const iso = (offsetDays: number) =>
        new Date(todayUtc.getTime() + offsetDays * DAY_MS).toISOString().slice(0, 10);
      const rangeStart = iso(-13);
      const rangeStop = iso(1);

      const { activities, users } = await fetchDailyActivitiesCached(
        getHubstaffOrgId()!,
        rangeStart,
        rangeStop,
      );

      const myUserIds = new Set<number>();
      for (const u of users) {
        const e = u.email ? normEmail(u.email) : null;
        if (e && aliasSet.has(e)) myUserIds.add(u.id);
      }

      const days: Record<string, number> = {};
      let totalSeconds = 0;
      for (const a of activities) {
        if (!myUserIds.has(a.user_id)) continue;
        const tracked = typeof a.tracked === "number" && Number.isFinite(a.tracked) ? a.tracked : 0;
        days[a.date] = (days[a.date] ?? 0) + tracked;
        totalSeconds += tracked;
      }

      return NextResponse.json({
        configured: true,
        days,
        totalSeconds,
        rangeStart,
        rangeStop,
        asOf: new Date().toISOString(),
        error: null,
      });
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      console.error("[GET /api/hubstaff-hours?live=1]", msg);
      return NextResponse.json(
        { configured: true, days: {}, totalSeconds: 0, error: cleanErrorMessage(msg) },
        { status: 502 },
      );
    }
  }

  // Return list of uploaded source files. Shape:
  //   {
  //     files:   string[] (newest first, for legacy consumers),
  //     uploads: { id, source_file, uploaded_at, uploaded_by, row_count, is_current }[]
  //   }
  // `uploads` is the richer row set from `hubstaff_uploads`; Payroll Wizard uses
  // this to show filename + timestamp + current-upload badge. Falls back to the
  // legacy source_file scan if the archive table is empty / unavailable.
  if (searchParams.get("source_files") === "1") {
    try {
      let uploads: Awaited<ReturnType<typeof listHubstaffUploads>> = [];
      try {
        uploads = await listHubstaffUploads();
      } catch (uploadsErr) {
        console.warn("[GET /api/hubstaff-hours] listHubstaffUploads failed:", uploadsErr);
      }
      let files: string[];
      if (uploads.length > 0) {
        const seen = new Set<string>();
        files = [];
        for (const u of uploads) {
          const f = (u.source_file ?? "").trim();
          if (!f || seen.has(f)) continue;
          seen.add(f);
          files.push(f);
        }
      } else {
        files = await getUploadedSourceFiles();
      }
      return NextResponse.json({ files, uploads, error: null });
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      return NextResponse.json({ files: [], uploads: [], error: cleanErrorMessage(msg) });
    }
  }

  // Cross-file batch for ALL employees: one scan of hubstaff_hours grouped by
  // source_file, returning the same per-file { source_file, columns, rows } shape
  // the Accounting Overview used to assemble from an N-parallel `?source_file=…`
  // fan-out. One browser round-trip instead of one-per-week (the dominant cause
  // of the ~1 min Overview load). Same data exposure as the per-file path — no
  // extra auth surface; the edge proxy already gates the route.
  if (searchParams.get("all_files") === "1") {
    try {
      const { files } = await fetchHubstaffRowsGroupedBySourceFile();
      return NextResponse.json({ files, error: null });
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      return NextResponse.json({ files: [], error: cleanErrorMessage(msg) });
    }
  }

  // Cross-file merge for a single employee. Server-side replacement for the
  // client's old N-parallel `?source_file=...` fan-out — see
  // src/components/employee/EmployeeDashboard.tsx (PAB merge useEffect).
  // Returns the union of columns across uploads + this employee's rows keyed
  // by source_file. The client still resolves canonical weekday columns to ISO
  // dates from the filename, so we don't duplicate that logic here.
  const mergeEmail = searchParams.get("email")?.trim();
  if (searchParams.get("merge_all") === "1" && mergeEmail) {
    try {
      const norm = normEmail(mergeEmail) ?? mergeEmail.toLowerCase();
      const aliasSet = await expandEmailAliases(norm);
      const aliases = [...aliasSet].filter(Boolean);

      const supabase = createSupabaseServiceRoleClient() ?? createSupabaseServerClient();
      if (!supabase) throw new Error("Supabase client unavailable");
      const table =
        process.env.NEXT_PUBLIC_SUPABASE_HUBSTAFF_HOURS_TABLE?.trim() || "hubstaff_hours";

      // One email-filtered query for this employee's rows across ALL uploads,
      // instead of reading every weekly file's full roster (~13 sequential full
      // scans) just to pick out one row. Matches on the Hubstaff "Email" column
      // (capital E, per CSV mapping) — the same column the authoritative pay
      // calculator (member-monthly-pay `fetchHubstaffRowsForEmail`) filters on.
      const orFilter = aliases.map((e) => `"Email".eq.${e}`).join(",");
      const PAGE = 1000;
      const rows: Record<string, unknown>[] = [];
      let from = 0;
      while (true) {
        const { data, error } = await supabase
          .from(table)
          .select("*")
          .or(orFilter)
          .range(from, from + PAGE - 1);
        if (error) throw new Error(error.message);
        const page = (data ?? []) as Record<string, unknown>[];
        rows.push(...page);
        if (page.length < PAGE) break;
        from += PAGE;
        if (from > 10_000) break; // one employee won't have >10k weekly rows
      }

      // Group into one row per source_file (last wins on the rare duplicate),
      // preserving the { columns, perFile } shape both clients already consume.
      const allCols = new Set<string>();
      const byFile = new Map<string, Record<string, unknown>>();
      for (const row of rows) {
        for (const k of Object.keys(row)) allCols.add(k);
        const sf =
          typeof row["source_file"] === "string" ? (row["source_file"] as string).trim() : "";
        if (!sf) continue;
        byFile.set(sf, row);
      }
      const perFile = [...byFile.entries()].map(([source_file, row]) => ({ source_file, row }));

      return NextResponse.json({ columns: [...allCols], perFile, error: null });
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      return NextResponse.json({ columns: [], perFile: [], error: cleanErrorMessage(msg) });
    }
  }

  // Return rows filtered by a specific source file. Accepts optional `email`
  // to return only the matching employee's row (used by the employee portal
  // so it doesn't download the whole roster for every weekly file).
  const sourceFileFilter = searchParams.get("source_file");
  if (sourceFileFilter) {
    try {
      const { columns, rows } = await fetchHubstaffRowsBySourceFile(sourceFileFilter);
      const emailFilter = searchParams.get("email")?.trim();
      let outRows = rows;
      if (emailFilter) {
        const norm = normEmail(emailFilter) ?? emailFilter.toLowerCase();
        const aliasSet = await expandEmailAliases(norm);
        const match = rows.find((r) => rowMatchesAnyEmail(r, aliasSet));
        outRows = match ? [match] : [];
      }
      const payrollRows = rowsToPayrollRows(outRows);
      return NextResponse.json({ columns, rows: outRows, payrollRows, error: null });
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      return NextResponse.json({ columns: null, rows: null, payrollRows: [], error: cleanErrorMessage(msg) });
    }
  }

  // Service role path: full ordered fetch with OpenAPI column discovery
  if (process.env.SUPABASE_SERVICE_ROLE_KEY?.trim()) {
    try {
      const { columns, rows } = await fetchHubstaffRowsOrdered();
      const payrollRows = rowsToPayrollRows(rows);
      return NextResponse.json({ columns, rows, payrollRows, error: null });
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      return NextResponse.json({ columns: null, rows: null, payrollRows: [], error: cleanErrorMessage(msg) });
    }
  }

  // Anon key path: also return raw rows so PA daily-column detection works in the UI.
  // Filter to the current upload so the wizard never sees stale archived data.
  try {
    const supabase = createSupabaseServerClient();
    if (!supabase) throw new Error("Supabase client unavailable");
    const table =
      process.env.NEXT_PUBLIC_SUPABASE_HUBSTAFF_HOURS_TABLE?.trim() || "hubstaff_hours";

    const currentUploadId = await getCurrentHubstaffUploadId(supabase);
    let q = supabase.from(table).select("*");
    if (currentUploadId) q = q.eq("upload_id", currentUploadId);
    const { data, error } = await q;
    if (error) throw new Error(error.message);

    const rawRows = ((data ?? []) as Record<string, unknown>[]).filter((r) =>
      Object.values(r).some((v) => v != null && String(v).trim() !== ""),
    );
    const columns =
      rawRows.length > 0 ? sortHubstaffColumnsForDisplay(Object.keys(rawRows[0])) : [];
    const payrollRows = rawRows.map((r) => mapHubstaffHoursRow(r));
    return NextResponse.json({ columns, rows: rawRows, payrollRows, error: null });
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    return NextResponse.json({ columns: null, rows: null, payrollRows: [], error: msg });
  }
}

export async function DELETE(req: NextRequest) {
  try {
    const authz = await requireFeatureEdit('accounting', 'payroll_wizard');
    if (!authz.ok) return deniedResponse(authz);

    if (!process.env.SUPABASE_SERVICE_ROLE_KEY?.trim()) {
      return NextResponse.json(
        {
          success: false,
          error:
            "SUPABASE_SERVICE_ROLE_KEY is required. Add it to .env — Supabase → Project Settings → API → service_role (secret) key.",
        },
        { status: 400 },
      );
    }

    const sourceFile = new URL(req.url).searchParams.get("source_file")?.trim();
    if (!sourceFile) {
      return NextResponse.json({ success: false, error: "Missing source_file query parameter." }, { status: 400 });
    }

    const { deleted, uploadsDeleted, repointedTo } = await deleteHubstaffRowsBySourceFile(sourceFile);

    // Mirror the upload's side-effects: this batch also wrote the week's MESA
    // deposits and "Salary Ready to View" notifications, so they leave with it.
    // Best-effort — the hours are already gone, so a cleanup failure is warned
    // and reported rather than failing the whole delete.
    let mesaDeleted: Awaited<ReturnType<typeof deleteMesaWeeklyContributions>> | null = null;
    try {
      mesaDeleted = await deleteMesaWeeklyContributions({ sourceFile });
    } catch (mesaErr) {
      console.warn("[DELETE /api/hubstaff-hours] MESA weekly deposit cleanup failed:", mesaErr);
    }
    let notificationsDeleted: number | null = null;
    try {
      ({ deleted: notificationsDeleted } = await deletePayrollAvailableNotifications({ sourceFile }));
    } catch (notifyErr) {
      console.warn("[DELETE /api/hubstaff-hours] payroll.available cleanup failed:", notifyErr);
    }

    const actor = await getSessionActor();
    void insertAuditLog({
      user_name:   actor.user_name,
      user_role:   actor.user_role,
      action:      'csv.delete',
      resource:    'hubstaff_hours',
      resource_id: sourceFile,
      details:     {
        file: sourceFile,
        rows_deleted: deleted,
        uploads_deleted: uploadsDeleted,
        repointed_to: repointedTo,
        mesa_deposits_deleted: mesaDeleted?.deleted ?? null,
        mesa_week_still_covered: mesaDeleted?.weekStillCovered ?? null,
        notifications_deleted: notificationsDeleted,
      },
      ip_address:  clientIp(req),
    });

    return NextResponse.json({
      success: true,
      deleted,
      uploadsDeleted,
      repointedTo,
      mesaDeleted,
      notificationsDeleted,
    });
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    console.error("[DELETE /api/hubstaff-hours]", msg);
    return NextResponse.json({ success: false, error: msg }, { status: 500 });
  }
}

// Rename a payroll week's source_file everywhere it is the key (hubstaff_uploads,
// hubstaff_hours, disbursement_records, payment_dispatches, final-pay snapshot).
// Body: { from: string, to: string }. The UI locks the embedded date range, so a
// rename only ever changes the descriptive prefix -- period parsing stays intact.
export async function PATCH(req: NextRequest) {
  try {
    const authz = await requireFeatureEdit('accounting', 'payroll_wizard');
    if (!authz.ok) return deniedResponse(authz);

    if (!process.env.SUPABASE_SERVICE_ROLE_KEY?.trim()) {
      return NextResponse.json(
        {
          success: false,
          error:
            "SUPABASE_SERVICE_ROLE_KEY is required. Add it to .env -- Supabase -> Project Settings -> API -> service_role (secret) key.",
        },
        { status: 400 },
      );
    }

    const body = (await req.json().catch(() => ({}))) as {
      action?: unknown;
      source_file?: unknown;
      from?: unknown;
      to?: unknown;
    };

    // Initialize: promote an existing batch to be the active source of truth.
    if (body.action === "set_current") {
      const sourceFile = typeof body.source_file === "string" ? body.source_file.trim() : "";
      if (!sourceFile) {
        return NextResponse.json(
          { success: false, error: "`source_file` is required to set the current batch." },
          { status: 400 },
        );
      }
      const result = await setHubstaffUploadCurrentBySourceFile(sourceFile);

      const actor = await getSessionActor();
      void insertAuditLog({
        user_name:   actor.user_name,
        user_role:   actor.user_role,
        action:      'csv.set_current',
        resource:    'hubstaff_uploads',
        resource_id: sourceFile,
        details:     { source_file: sourceFile, upload_id: result.uploadId },
        ip_address:  clientIp(req),
      });

      return NextResponse.json({ success: true, ...result });
    }

    const from = typeof body.from === "string" ? body.from.trim() : "";
    const to = typeof body.to === "string" ? body.to.trim() : "";
    if (!from || !to) {
      return NextResponse.json(
        { success: false, error: "Both `from` and `to` filenames are required." },
        { status: 400 },
      );
    }
    if (from === to) {
      return NextResponse.json(
        { success: false, error: "The new name is the same as the current name." },
        { status: 400 },
      );
    }

    const result = await renameHubstaffSourceFile(from, to);

    const actor = await getSessionActor();
    void insertAuditLog({
      user_name:   actor.user_name,
      user_role:   actor.user_role,
      action:      'csv.rename',
      resource:    'hubstaff_hours',
      resource_id: to,
      details:     { from, to, ...result },
      ip_address:  clientIp(req),
    });

    return NextResponse.json({ success: true, ...result });
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    console.error("[PATCH /api/hubstaff-hours]", msg);
    return NextResponse.json({ success: false, error: msg }, { status: 500 });
  }
}

export async function POST(req: NextRequest) {
  try {
    const authz = await requireFeatureEdit('accounting', 'payroll_wizard');
    if (!authz.ok) return deniedResponse(authz);

    if (!process.env.SUPABASE_SERVICE_ROLE_KEY?.trim()) {
      return NextResponse.json(
        {
          success: false,
          error:
            "SUPABASE_SERVICE_ROLE_KEY is required. Add it to .env — Supabase → Project Settings → API → service_role (secret) key.",
        },
        { status: 400 },
      );
    }

    // CSV upload (multipart) is the only ingest path. The manual "Sync from
    // Hubstaff" wizard action was removed — the Hubstaff API's 1000 req/hour cap
    // made an on-demand pull unreliable. The weekly auto-sync cron
    // (/api/cron/sync-hubstaff-week) still pulls live once per week.
    const form = await req.formData();
    const file = form.get("file");
    if (!file || typeof file === "string") {
      return NextResponse.json({ success: false, error: "Missing file" }, { status: 400 });
    }

    const text = await (file as Blob).text();
    const fileName = (file as File).name || form.get("fileName")?.toString() || undefined;
    const uploadedBy = form.get("uploaded_by")?.toString().trim() || null;
    // `mode` is retained in the form payload for back-compat but ignored: every upload
    // is archived and promoted to current. Latest always wins in the Payroll Wizard.
    const { rowCount, uploadId } = await replaceHubstaffHoursFromCsvText(text, fileName, uploadedBy);

    const actor = await getSessionActor();
    void insertAuditLog({
      user_name:   uploadedBy ?? actor.user_name,
      user_role:   actor.user_role,
      action:      'csv.upload',
      resource:    'hubstaff_hours',
      resource_id: fileName ?? null,
      details:     { file: fileName ?? 'unknown', rows: rowCount, upload_id: uploadId },
      ip_address:  clientIp(req),
    });

    // Tell every employee in this week's batch that their salary is ready to
    // view. Best-effort: a notification failure never fails the upload (the
    // hours already landed). See notifyPayrollAvailable for the alias-resolution
    // + per-week de-dupe rationale.
    let notified: Awaited<ReturnType<typeof notifyPayrollAvailable>> | null = null;
    try {
      notified = await notifyPayrollAvailable({ sourceFile: fileName ?? null, uploadId });
    } catch (notifyErr) {
      console.warn("[POST /api/hubstaff-hours] payroll.available notify failed:", notifyErr);
    }

    // Grow each opted-in member's MESA balance by this week's ₱100 + ₱300 match.
    // Best-effort: a ledger failure never fails the upload (the hours already
    // landed). Idempotent per (member, week), so a re-upload won't double-credit.
    let mesaRecorded: Awaited<ReturnType<typeof recordMesaWeeklyContributions>> | null = null;
    try {
      mesaRecorded = await recordMesaWeeklyContributions({ uploadId, sourceFile: fileName ?? null });
    } catch (mesaErr) {
      console.warn("[POST /api/hubstaff-hours] MESA weekly contribution record failed:", mesaErr);
    }

    return NextResponse.json({ success: true, rowCount, uploadId, notified, mesaRecorded });
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    console.error("[POST /api/hubstaff-hours]", msg);
    return NextResponse.json({ success: false, error: msg }, { status: 500 });
  }
}
