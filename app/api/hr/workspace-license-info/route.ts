import { NextResponse } from "next/server";
import { createSupabaseServiceRoleClient } from "@/lib/supabase/server";
import { requireElevatedSession } from "@/lib/auth/authorize-email";
import {
  fetchAssignedLicenseCount,
  isLicenseAutoCountConfigured,
} from "@/lib/google-workspace/licenses";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

/**
 * GET /api/hr/workspace-license-info
 *
 * Returns Google Workspace license availability for the HR dashboard.
 *
 * `total_licenses` is always the manually-entered number from the Admin panel
 * (Google has no public API for total purchased seats for direct customers).
 *
 * `assigned_licenses` is fetched LIVE from the Enterprise License Manager API
 * when domain-wide delegation is configured; otherwise we fall back to the
 * manual value (total - stored available). `available_licenses` is then
 * computed as total - assigned.
 *
 * Stored in app_settings.workspace.license_info as a JSON string:
 *   { available_licenses, total_licenses, last_updated }
 */

interface StoredLicenseInfo {
  available_licenses?: number;
  total_licenses?: number;
  last_updated?: string;
}

function notConfigured() {
  return NextResponse.json({
    available_licenses: null,
    total_licenses: null,
    assigned_licenses: null,
    source: "manual" as const,
    last_updated: null,
    note: "License info not configured. Set the total in Admin > Google Workspace.",
  });
}

export async function GET() {
  const authz = await requireElevatedSession();
  if (!authz.ok) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 403 });
  }

  const supabase = createSupabaseServiceRoleClient();
  if (!supabase) {
    return NextResponse.json({ error: "Database unavailable" }, { status: 500 });
  }

  try {
    const { data, error } = await supabase
      .from("app_settings")
      .select("value")
      .eq("key", "workspace.license_info")
      .single();

    if (error || !data?.value) {
      return notConfigured();
    }

    // app_settings.value is a TEXT column app-wide — settings are stored as
    // JSON strings (see lib/supabase/app-settings.ts). Parse it back; tolerate
    // the case where a future migration switches the column to JSONB (object).
    const raw = data.value as unknown;
    let info: StoredLicenseInfo = {};
    if (typeof raw === "string") {
      try {
        info = JSON.parse(raw) as StoredLicenseInfo;
      } catch {
        info = {};
      }
    } else if (raw && typeof raw === "object") {
      info = raw as StoredLicenseInfo;
    }

    const total = typeof info.total_licenses === "number" ? info.total_licenses : null;

    // Manual fallback values (used when the Google API isn't wired up yet).
    const manualAvailable =
      typeof info.available_licenses === "number" ? info.available_licenses : null;
    const manualAssigned =
      total !== null && manualAvailable !== null ? total - manualAvailable : null;

    // Try the live assigned-license count. Any failure (not configured, scope
    // not granted, transient API error) falls back to the manual numbers so the
    // HR surfaces never break.
    let assigned = manualAssigned;
    let source: "google" | "manual" = "manual";
    let googleError: string | undefined;

    if (isLicenseAutoCountConfigured()) {
      try {
        const result = await fetchAssignedLicenseCount();
        assigned = result.assigned;
        source = "google";
      } catch (e) {
        googleError = e instanceof Error ? e.message : "Licensing API error";
        console.error("Live license count failed, using manual numbers:", googleError);
      }
    }

    const available =
      total !== null && assigned !== null ? Math.max(0, total - assigned) : manualAvailable;

    return NextResponse.json({
      available_licenses: available,
      total_licenses: total,
      assigned_licenses: assigned,
      source,
      last_updated: info.last_updated ?? null,
      ...(googleError ? { google_error: googleError } : {}),
    });
  } catch (e) {
    console.error("Unexpected error fetching license info:", e);
    return NextResponse.json({
      available_licenses: null,
      total_licenses: null,
      assigned_licenses: null,
      source: "manual" as const,
      last_updated: null,
      error: e instanceof Error ? e.message : "Failed to fetch license info",
    });
  }
}
