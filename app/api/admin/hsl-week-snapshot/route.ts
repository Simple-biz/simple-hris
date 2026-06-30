/**
 * HSL "Sunday-to-Sunday" (Mon→Sun) pre-change snapshot.
 *
 *   GET  /api/admin/hsl-week-snapshot
 *     → lists every historical upload and whether it has been snapshotted yet.
 *       Use it to see progress / drive the backfill in chunks.
 *
 *   POST /api/admin/hsl-week-snapshot
 *     body (optional): { "sourceFiles": ["...csv", ...] }
 *     → snapshots those uploads (or ALL of them when omitted), reusing
 *       computeCurrentPay so the frozen numbers match Payment Dispatch exactly.
 *       Idempotent: re-running upserts. HSL employees only.
 *
 * RUN THIS BEFORE shipping the Sun→Sat cutover so the baseline is pure Mon→Sun.
 * Admin-only; service role required.
 *
 * Table: references/sql/create/create_hsl_week_model_snapshot.sql
 * Logic: src/lib/payroll/hsl-week-snapshot.ts
 */
import { NextResponse } from "next/server";
import { requireAdminSession, deniedResponse } from "@/lib/auth/authorize-email";
import {
  listHslSnapshotTargets,
  runHslWeekSnapshot,
} from "@/lib/payroll/hsl-week-snapshot";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";
// All-history backfill recomputes pay per upload; give it room. Drive in chunks
// via { sourceFiles } if a single run still exceeds the platform limit.
export const maxDuration = 300;

export async function GET() {
  const authz = await requireAdminSession();
  if (!authz.ok) return deniedResponse(authz);

  const targets = await listHslSnapshotTargets();
  const done = targets.filter((t) => t.snapshotted).length;
  return NextResponse.json({
    totalUploads: targets.length,
    snapshotted: done,
    pending: targets.length - done,
    targets,
  });
}

export async function POST(req: Request) {
  const authz = await requireAdminSession();
  if (!authz.ok) return deniedResponse(authz);

  let sourceFiles: string[] | undefined;
  try {
    const body = (await req.json()) as { sourceFiles?: unknown } | null;
    if (body && Array.isArray(body.sourceFiles)) {
      sourceFiles = body.sourceFiles.filter((s): s is string => typeof s === "string" && s.trim() !== "");
    }
  } catch {
    // no body → snapshot everything
  }

  const result = await runHslWeekSnapshot({
    sourceFiles,
    capturedBy: authz.sessionEmail,
  });
  return NextResponse.json(result);
}
