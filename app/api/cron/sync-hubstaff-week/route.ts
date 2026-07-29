import { NextRequest, NextResponse } from "next/server";
import { cronSessionElevated } from "@/lib/auth/cron-auth";
import { hubstaffApiConfigured } from "@/lib/hubstaff/api-client";
import {
  classifySyncError,
  mostRecentlyCompletedPayWeek,
  runHubstaffWeeklySync,
} from "@/lib/hubstaff/run-weekly-sync";
import { cleanErrorMessage } from "@/lib/clean-error-message";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";
// The Hubstaff pull paginates with inter-page gaps + retry backoff; give it room.
// (300s needs a Vercel Pro plan; drop to 60 on Hobby.)
export const maxDuration = 300;

const DAY_MS = 86_400_000;
const SYSTEM_ACTOR = { user_name: "Hubstaff Auto-Sync Cron", user_role: "System" } as const;

/** Same auth model as the other crons: Bearer CRON_SECRET (sent by Vercel Cron)
 *  OR an elevated in-app session (admin manual trigger). Fail-closed. */
function isAuthorized(req: NextRequest): boolean {
  const expected = process.env.CRON_SECRET?.trim();
  if (!expected) return false;
  return (req.headers.get("authorization") ?? "") === `Bearer ${expected}`;
}

function clientIp(req: NextRequest): string | null {
  const fwd = req.headers.get("x-forwarded-for");
  return fwd ? fwd.split(",")[0]!.trim() : req.headers.get("x-real-ip");
}

/**
 * GET/POST /api/cron/sync-hubstaff-week
 *
 * Weekly Vercel cron (see vercel.json): `0 5 * * 0` = 05:00 UTC Sunday = 00:00 EST
 * Sunday (01:00 EDT in summer — Vercel cron is UTC-only, no DST). At fire time the
 * new Sun→Sat week has only just begun, so it syncs the week that JUST COMPLETED
 * (previous Sun→Sat) — the batch payroll pays, one week in arrears — pulling it
 * live from the Hubstaff API and ingesting it exactly like a manual CSV upload
 * (archive + promote-to-current + `payroll.available` + MESA deposit).
 *
 * Idempotent: the batch filename is deterministic (`apiSyncFileName`), so a Vercel
 * retry or a manual re-run replaces the same batch instead of duplicating it.
 *
 * `?weekStart=YYYY-MM-DD` overrides the auto-computed week (must be a Sunday) — for
 * backfilling a missed week from an admin manual trigger.
 */
async function run(req: NextRequest): Promise<NextResponse> {
  if (!isAuthorized(req) && !(await cronSessionElevated())) {
    return NextResponse.json({ success: false, error: "Unauthorized" }, { status: 401 });
  }

  if (!hubstaffApiConfigured()) {
    return NextResponse.json(
      {
        success: false,
        error:
          "Hubstaff API sync is not configured. Set HUBSTAFF_PAT and HUBSTAFF_ORG_ID in the environment.",
      },
      { status: 503 },
    );
  }

  const override = new URL(req.url).searchParams.get("weekStart")?.trim() || "";
  let weekStart: string;
  let weekEnd: string;
  if (/^\d{4}-\d{2}-\d{2}$/.test(override)) {
    weekStart = override;
    weekEnd = new Date(Date.parse(`${override}T00:00:00Z`) + 6 * DAY_MS).toISOString().slice(0, 10);
  } else {
    ({ weekStart, weekEnd } = mostRecentlyCompletedPayWeek(new Date()));
  }

  try {
    const result = await runHubstaffWeeklySync({
      weekStart,
      weekEnd,
      uploadedBy: null,
      actor: { ...SYSTEM_ACTOR, ip_address: clientIp(req) },
    });
    return NextResponse.json({
      success: true,
      weekStart,
      weekEnd,
      fileName: result.fileName,
      members: result.memberCount,
      rows: result.rowCount,
      uploadId: result.uploadId,
      notified: result.notified,
      mesaRecorded: result.mesaRecorded,
    });
  } catch (e) {
    const code = (e as { code?: string } | null)?.code;
    const { httpStatus, retryable, message } = classifySyncError(e);
    // A week with no tracked time isn't a system failure — answer 200 so Vercel
    // doesn't flag the invocation, but warn loudly so an unexpected empty week is
    // still visible in the cron logs.
    if (code === "no_data") {
      console.warn(`[cron sync-hubstaff-week] no Hubstaff data for ${weekStart}→${weekEnd}`);
      return NextResponse.json({ success: false, skipped: true, reason: "no_data", weekStart, weekEnd, error: message });
    }
    console.error(`[cron sync-hubstaff-week] ${weekStart}→${weekEnd}:`, message);
    return NextResponse.json(
      { success: false, weekStart, weekEnd, error: cleanErrorMessage(message), retryable },
      { status: httpStatus },
    );
  }
}

export async function GET(req: NextRequest) {
  return run(req);
}
export async function POST(req: NextRequest) {
  return run(req);
}
