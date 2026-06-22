import {
  getEmployeeRateProfiles,
  getEmployeeRateProfileByEmail,
} from "@/lib/supabase/employee-rate-profiles";
import { NextResponse } from "next/server";
import {
  authorizeEmailAccess,
  deniedResponse,
  requireRateVisibilitySession,
} from "@/lib/auth/authorize-email";
import { hasRateVisibility } from "@/lib/auth/elevated-roles";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export async function GET(req: Request) {
  try {
    const url = new URL(req.url);
    const emailQuery = url.searchParams.get("email")?.trim() ?? "";
    const idQuery = url.searchParams.get("id")?.trim() ?? "";

    // Scoping rules (pay rates are Accounting/CEO only):
    //  - `?email=` present → self-or-rate-visible: the person themselves, or a
    //    full-rate-visibility session (admin/accounting/ceo) reading anyone.
    //  - `?id=` present (opaque profile id) or no query (full profile list) →
    //    full rate visibility only.
    // NOTE: this used to admit any elevated role (incl. hr_coordinator); HR no
    // longer receives rate figures from this endpoint.
    const authz = emailQuery
      ? await authorizeEmailAccess(emailQuery)
      : await requireRateVisibilitySession();
    if (!authz.ok) return deniedResponse(authz);

    if (emailQuery) {
      const isSelf = authz.effectiveEmail.toLowerCase() === authz.sessionEmail.toLowerCase();
      if (!isSelf && !hasRateVisibility(authz.roles)) {
        return NextResponse.json({ error: "Forbidden" }, { status: 403 });
      }
    }

    // ── Fast path: single-email lookup. Avoids the multi-second
    //    paginated load + full-org merge that the bulk path runs.
    if (emailQuery && !idQuery) {
      const { profile, error, mergeNotes } = await getEmployeeRateProfileByEmail(
        authz.effectiveEmail,
      );
      return NextResponse.json({ profile, error, mergeNotes });
    }

    // ── Slow path: id-based lookup or full-list fetch — needs the
    //    cross-employee merge so id collisions resolve correctly.
    const { profiles, error, mergeNotes } = await getEmployeeRateProfiles();

    if (emailQuery || idQuery) {
      const emailLower = authz.effectiveEmail.toLowerCase();
      const profile =
        profiles.find((p) => {
          if (idQuery && p.id === idQuery) return true;
          if (!emailLower) return false;
          return [p.workEmail, p.personalEmail, p.subtitle]
            .filter((v): v is string => Boolean(v))
            .some((v) => v.toLowerCase() === emailLower);
        }) ?? null;
      return NextResponse.json({ profile, error, mergeNotes });
    }

    return NextResponse.json({ profiles, error, mergeNotes });
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    return NextResponse.json({ profiles: [], profile: null, error: msg, mergeNotes: [] });
  }
}
