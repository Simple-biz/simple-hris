import {
  getEmployeeRateProfiles,
  getEmployeeRateProfileByEmail,
} from "@/lib/supabase/employee-rate-profiles";
import { NextResponse } from "next/server";
import {
  authorizeEmailAccess,
  deniedResponse,
  requireElevatedSession,
} from "@/lib/auth/authorize-email";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export async function GET(req: Request) {
  try {
    const url = new URL(req.url);
    const emailQuery = url.searchParams.get("email")?.trim() ?? "";
    const idQuery = url.searchParams.get("id")?.trim() ?? "";

    // Scoping rules:
    //  - `?email=` present → self-or-elevated for that email.
    //  - `?id=` present (opaque profile id, not tied to the session) or no query at all
    //    (returns the full profile list) → elevated-only.
    const authz = emailQuery
      ? await authorizeEmailAccess(emailQuery)
      : await requireElevatedSession();
    if (!authz.ok) return deniedResponse(authz);

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
