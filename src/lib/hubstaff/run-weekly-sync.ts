import "server-only";

import {
  fetchDailyActivities,
  getHubstaffOrgId,
  hubstaffApiConfigured,
} from "@/lib/hubstaff/api-client";
import { apiSyncFileName, buildWeeklySummaryCsv } from "@/lib/hubstaff/build-weekly-summary";
import { replaceHubstaffHoursFromCsvText } from "@/lib/supabase/hubstaff-hours-db";
import { seedMissingDisbursementRecords } from "@/lib/payroll/disbursement-reports";
import { insertAuditLog } from "@/lib/supabase/audit-log";
import { notifyPayrollAvailable } from "@/lib/notifications/payroll-available";
import { recordMesaWeeklyContributions } from "@/lib/mesa/record-weekly-contributions";

const DAY_MS = 86_400_000;

function isoUtc(d: Date): string {
  return d.toISOString().slice(0, 10);
}

/**
 * The most-recently-*completed* Sunday→Saturday pay week relative to `now`.
 *
 * The auto-sync cron fires early Sunday UTC (05:00 UTC = 00:00 EST / 01:00 EDT
 * Sunday), so at fire time the current Sun→Sat week has only just begun and has no
 * data yet — the week worth syncing is the one that ended the day before. Computed
 * purely in UTC (no local-time / DST dependence), always returning a Sunday
 * weekStart and the following Saturday, so it satisfies the Sun→Sat 7-day contract
 * enforced in {@link runHubstaffWeeklySync}.
 *
 * A manual off-schedule trigger on any other weekday degrades gracefully: it
 * returns the last fully-completed week *before* the in-progress one.
 */
export function mostRecentlyCompletedPayWeek(now: Date): { weekStart: string; weekEnd: string } {
  const today = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));
  const dow = today.getUTCDay(); // 0=Sun … 6=Sat
  const thisWeekSunday = new Date(today.getTime() - dow * DAY_MS);
  const weekStart = new Date(thisWeekSunday.getTime() - 7 * DAY_MS);
  const weekEnd = new Date(weekStart.getTime() + 6 * DAY_MS);
  return { weekStart: isoUtc(weekStart), weekEnd: isoUtc(weekEnd) };
}

export type WeeklySyncActor = {
  user_name: string;
  user_role: string;
  ip_address?: string | null;
};

export type WeeklySyncResult = {
  rowCount: number;
  uploadId: string;
  fileName: string;
  csvText: string;
  memberCount: number;
  notified: Awaited<ReturnType<typeof notifyPayrollAvailable>> | null;
  mesaRecorded: Awaited<ReturnType<typeof recordMesaWeeklyContributions>> | null;
  /** disbursement_records rows seeded for this new week (null = seed failed). */
  seeded: number | null;
};

/** Error carrying an HTTP `status` (and optional `code`) for the route to map. */
function syncError(message: string, status: number, code?: string): Error {
  return Object.assign(new Error(message), code ? { status, code } : { status });
}

/**
 * Live Hubstaff pull for one Sun→Sat pay week, driven by the weekly auto-sync cron
 * (/api/cron/sync-hubstaff-week) — the only remaining caller since the Payroll
 * Wizard's manual "Sync from Hubstaff" button was removed (the API's 1000 req/hour
 * cap made on-demand pulls unreliable). An API batch is archived,
 * promoted-to-current, notified (`payroll.available`) and MESA-credited exactly
 * like a manual CSV upload.
 *
 * Throws (never returns a partial success):
 *   - status 400 for a malformed / non-Sunday-to-Saturday week (code `no_data`
 *     when the week simply had no tracked time),
 *   - status 503 when Hubstaff API credentials are missing,
 *   - the api-client's upstream error (`.status` + `.upstream`) for a Hubstaff
 *     429/5xx so the caller can answer 429 (retryable) / 502.
 * See {@link classifySyncError} for the caller-side mapping.
 */
export async function runHubstaffWeeklySync(params: {
  weekStart: string;
  weekEnd: string;
  uploadedBy: string | null;
  actor: WeeklySyncActor;
}): Promise<WeeklySyncResult> {
  const { weekStart, weekEnd, uploadedBy, actor } = params;

  if (!/^\d{4}-\d{2}-\d{2}$/.test(weekStart) || !/^\d{4}-\d{2}-\d{2}$/.test(weekEnd)) {
    throw syncError("weekStart and weekEnd must be YYYY-MM-DD dates.", 400);
  }

  // The pay week is strictly Sunday → Saturday: a precise 7-day cutoff keyed to the
  // Sun→Sat pay model. Rejecting anything else guarantees an API/cron batch can
  // never reintroduce the legacy 8-day Sun→Sun overlap (dropped-Sunday bug).
  const startMs = Date.parse(`${weekStart}T00:00:00Z`);
  const spanDays = Math.round((Date.parse(`${weekEnd}T00:00:00Z`) - startMs) / DAY_MS) + 1;
  if (new Date(startMs).getUTCDay() !== 0 || spanDays !== 7) {
    throw syncError(
      "Pick a Sunday-to-Saturday pay week — weekStart must be a Sunday and weekEnd the following Saturday.",
      400,
    );
  }

  if (!hubstaffApiConfigured()) {
    throw syncError(
      "Hubstaff API sync is not configured. Set HUBSTAFF_PAT (Personal Access Token from " +
        "developer.hubstaff.com) and HUBSTAFF_ORG_ID in the environment, then redeploy.",
      503,
    );
  }

  const startedAt = Date.now();
  const orgId = getHubstaffOrgId()!;

  // Upstream failures carry an HTTP `.status` + `.upstream` flag (see api-client)
  // so the route can answer 429 (transient/retryable) or 502 (gateway) rather than
  // a blanket 500. Only genuine bugs in this pipeline fall through as un-tagged.
  const { activities, users } = await fetchDailyActivities(orgId, weekStart, weekEnd);

  if (activities.length === 0) {
    throw syncError(
      `No Hubstaff time entries found between ${weekStart} and ${weekEnd}.`,
      400,
      "no_data",
    );
  }

  const { csvText, rowCount: memberCount } = buildWeeklySummaryCsv(
    users,
    activities,
    weekStart,
    weekEnd,
  );
  const fileName = apiSyncFileName(weekStart, weekEnd);

  // Deterministic filename → a re-run (cron retry / manual re-sync) replaces the
  // same batch rather than duplicating it.
  const { rowCount, uploadId } = await replaceHubstaffHoursFromCsvText(csvText, fileName, uploadedBy);

  console.log(
    `[hubstaff api_sync] ${weekStart}→${weekEnd} org=${orgId} members=${memberCount} rows=${rowCount} in ${Date.now() - startedAt}ms`,
  );

  void insertAuditLog({
    user_name: uploadedBy ?? actor.user_name,
    user_role: actor.user_role,
    action: "hubstaff.api_sync",
    resource: "hubstaff_hours",
    resource_id: fileName,
    details: {
      file: fileName,
      week_start: weekStart,
      week_end: weekEnd,
      members: memberCount,
      rows: rowCount,
      upload_id: uploadId,
    },
    ip_address: actor.ip_address ?? null,
  });

  // "Salary ready to view" alert — an API sync is a new payroll week too.
  // Best-effort; never fails the sync. De-dupes per (recipient, source_file).
  let notified: WeeklySyncResult["notified"] = null;
  try {
    notified = await notifyPayrollAvailable({ sourceFile: fileName, uploadId });
  } catch (notifyErr) {
    console.warn("[hubstaff api_sync] payroll.available notify failed:", notifyErr);
  }

  // Weekly MESA deposit — an API sync is a new payroll week too. weekEnd is known
  // exactly here (validated Sun→Sat above). Best-effort; idempotent per member/week.
  let mesaRecorded: WeeklySyncResult["mesaRecorded"] = null;
  try {
    mesaRecorded = await recordMesaWeeklyContributions({ uploadId, sourceFile: fileName, weekEnd });
  } catch (mesaErr) {
    console.warn("[hubstaff api_sync] MESA weekly contribution record failed:", mesaErr);
  }

  // Seed disbursement_records for the new week — an API sync is a new payroll
  // week too (replaces the removed Reports-tab "Seed" button, 2026-08-12).
  // Best-effort; never fails the sync. The seeder's own gates skip already-
  // seeded files and non-weekly uploads, so cron retries never recompute.
  let seeded: WeeklySyncResult["seeded"] = null;
  try {
    const seedRes = await seedMissingDisbursementRecords({ sourceFiles: [fileName] });
    if (seedRes.error) {
      console.warn("[hubstaff api_sync] disbursement seed failed:", seedRes.error);
    } else {
      seeded = seedRes.seeded;
    }
  } catch (seedErr) {
    console.warn("[hubstaff api_sync] disbursement seed failed:", seedErr);
  }

  return { rowCount, uploadId, fileName, csvText, memberCount, notified, mesaRecorded, seeded };
}

/**
 * Maps a {@link runHubstaffWeeklySync} throw to an HTTP status the route returns.
 * Upstream Hubstaff errors (`.upstream`) become 429 (retryable) / 502; our own
 * tagged validation/config errors keep their status; anything untagged is a genuine
 * bug (500) the caller should surface / rethrow.
 */
export function classifySyncError(e: unknown): {
  httpStatus: number;
  retryable: boolean;
  message: string;
} {
  const status = (e as { status?: number } | null)?.status;
  const upstream = (e as { upstream?: boolean } | null)?.upstream === true;
  const message = e instanceof Error ? e.message : String(e);
  if (upstream) return { httpStatus: status === 429 ? 429 : 502, retryable: status === 429, message };
  if (typeof status === "number") return { httpStatus: status, retryable: false, message };
  return { httpStatus: 500, retryable: false, message };
}
