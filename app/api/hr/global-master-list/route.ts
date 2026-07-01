import { NextResponse } from "next/server";
import { createSupabaseServiceRoleClient, createSupabaseServerClient } from "@/lib/supabase/server";
import { insertAuditLog } from "@/lib/supabase/audit-log";
import { getCurrentMasterListUploadId } from "@/lib/supabase/global-master-list-db";
import { invalidateRateProfilesCache } from "@/lib/supabase/employee-rate-profiles";
import { appendMasterSheetRow } from "@/lib/google-sheets/append-master-sheet";
import { getSessionActor } from "@/lib/auth/session-actor";
import { requireFeatureEdit } from "@/lib/auth/authorize-feature";
import { deniedResponse } from "@/lib/auth/authorize-email";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

const MASTER_TABLE =
  process.env.NEXT_PUBLIC_SUPABASE_EMPLOYEES_TABLE?.trim() || "global_master_list";

/**
 * HR "Add to Global Master List" — inserts a new roster row AND mirrors it into
 * the master Google Sheet so the two stay in sync (bidirectional: sheet→DB is the
 * Sync button; DB→sheet is this append). Gated on the HR `global_master_list`
 * feature-edit grant (admin bypasses). Deliberately does NOT touch pay/rates —
 * HR must not set compensation (that lives in Accounting's Payment Catalog).
 *
 * The inserted row is stamped with the current `master_list_uploads` id as both
 * first_seen and last_seen so it appears in `active_employees` immediately.
 */
export async function POST(req: Request) {
  const authz = await requireFeatureEdit("hr", "global_master_list");
  if (!authz.ok) return deniedResponse(authz);

  try {
    const body = (await req.json()) as {
      name?: string;
      department?: string;
      workEmail?: string;
      personalEmail?: string;
      startDate?: string;
      location?: string;
      phoneNumber?: string;
    };

    const name = body.name?.trim() ?? "";
    const department = body.department?.trim() ?? "";
    const workEmail = body.workEmail?.trim() ?? "";
    const personalEmail = body.personalEmail?.trim() ?? "";
    const startDate = body.startDate?.trim() ?? "";
    const location = body.location?.trim() ?? "";
    const phoneNumber = body.phoneNumber?.trim() ?? "";

    if (!name) {
      return NextResponse.json({ error: "Name is required" }, { status: 400 });
    }
    if (!workEmail && !personalEmail) {
      return NextResponse.json(
        { error: "At least one email (work or personal) is required" },
        { status: 400 },
      );
    }

    const supabase = createSupabaseServiceRoleClient() ?? createSupabaseServerClient();
    if (!supabase) {
      return NextResponse.json(
        { error: "Supabase client not initialized. Check environment variables." },
        { status: 500 },
      );
    }

    // Guard against creating a duplicate active row (the roster's identity keys are
    // (Personal Email, Department) and the DB unique index is (Work Email, Department)).
    // Reject when an active row already owns either email so we don't seed the
    // wrong-person collisions documented in the master-list identity notes.
    //
    // Two separate `.ilike()` queries rather than one `.or(...)`: PostgREST's
    // logical-filter string mis-parses both a quoted spaced column ("Work Email")
    // and the dots inside email values — the same trap the offboarded-sheet
    // deletes hit. The two-argument `.ilike(column, value)` form takes each as a
    // parameter and handles them correctly.
    const dupChecks: { column: string; value: string }[] = [];
    if (workEmail) dupChecks.push({ column: '"Work Email"', value: workEmail });
    if (personalEmail) dupChecks.push({ column: '"Personal Email"', value: personalEmail });
    for (const { column, value } of dupChecks) {
      const { data: dupes } = await supabase
        .from("active_employees")
        .select('"Name"')
        .ilike(column, value)
        .limit(1);
      if ((dupes ?? []).length > 0) {
        const who = (dupes![0] as Record<string, unknown>)["Name"] ?? "an existing employee";
        return NextResponse.json(
          {
            error: `That email already belongs to an active roster row (${String(who)}). Use the Sync button or edit the existing record instead of adding a duplicate.`,
          },
          { status: 409 },
        );
      }
    }

    const masterRow: Record<string, string | null> = { Name: name };
    if (department) masterRow["Department"] = department;
    if (workEmail) masterRow["Work Email"] = workEmail;
    if (personalEmail) masterRow["Personal Email"] = personalEmail;
    if (startDate) masterRow["Start Date"] = startDate;
    if (location) masterRow["Location"] = location;
    if (phoneNumber) masterRow["Phone Number"] = phoneNumber;

    const currentUploadId = await getCurrentMasterListUploadId(supabase);
    if (currentUploadId) {
      masterRow["first_seen_upload_id"] = currentUploadId;
      masterRow["last_seen_upload_id"] = currentUploadId;
    }

    const { error: insertError } = await supabase.from(MASTER_TABLE).insert(masterRow);
    if (insertError) {
      return NextResponse.json(
        { error: `Could not add to the master list: ${insertError.message}` },
        { status: 500 },
      );
    }

    // Mirror into the Google Sheet (source of truth). Best-effort: a sheet write
    // failure must not roll back the DB row — the next Sync reconciles, and we
    // surface the outcome so HR knows whether it landed.
    let sheetAppended = false;
    let sheetReason: string | undefined;
    try {
      const res = await appendMasterSheetRow({
        name,
        personalEmail,
        workEmail,
        department,
        startDate: startDate || null,
        location: location || null,
        phoneNumber: phoneNumber || null,
      });
      sheetAppended = res.appended;
      sheetReason = res.reason;
    } catch (e) {
      sheetReason = e instanceof Error ? e.message : String(e);
    }

    invalidateRateProfilesCache();

    const actor = await getSessionActor();
    void insertAuditLog({
      user_name: actor.user_name,
      user_role: actor.user_role,
      action: "master.add",
      resource: "global_master_list",
      resource_id: workEmail || personalEmail,
      details: {
        name,
        department: department || null,
        work_email: workEmail || null,
        personal_email: personalEmail || null,
        start_date: startDate || null,
        location: location || null,
        phone_number: phoneNumber || null,
        upload_id: currentUploadId,
        sheet_appended: sheetAppended,
        sheet_reason: sheetReason ?? null,
        source: "hr_global_master_list_tab",
      },
    });

    return NextResponse.json({ success: true, sheetAppended, sheetReason });
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    return NextResponse.json({ error: msg }, { status: 500 });
  }
}
