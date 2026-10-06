import { NextResponse } from "next/server";
import { deniedResponse } from "@/lib/auth/authorize-email";
import { requireFeatureAccess } from "@/lib/auth/authorize-feature";
import { createSupabaseServiceRoleClient } from "@/lib/supabase/server";
import { selectAllPaged } from "@/lib/supabase/select-all-paged";
import {
  NPD_IDENTITY_MAX_EMAILS,
  matchNpdIdentities,
  normalizeIdentityEmails,
  type MasterIdentityRow,
} from "@/lib/payroll/hris-npd-identity";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

/**
 * POST { emails: string[] } — HRIS vs NPD's roster lookup for its **Not in HRIS** rows (Kane,
 * 2026-10-06: "Lets add the reason why they arent in HRIS please"). For each address NPD used,
 * every master-list row that carries it — active or offboarded — as its work, personal or
 * alternate work email, with the department, start date and offboarding date and reason.
 *
 * Why a route: the wizard's roster is `active_employees`, which carries nobody who has left, so
 * on its own it cannot tell "offboarded Sep 24 (resigned)" from "no such person".
 *
 * READ-ONLY, service role, no audit (like the wizard's other reads). Same gate as them:
 * `payroll_wizard` view. POST only so up to 500 addresses never ride in a URL.
 *
 * The master list is read WHOLE and paged (PostgREST caps every read at 1000 rows), then matched
 * in memory, so no `.in()` list can hit the URL ceiling. A failed or partial read is an ERROR
 * (502), never an empty answer: "not on the roster" must only ever mean the list was read and
 * the address is not on it (payroll-wizard-hris-vs-npd.md § Why).
 */
export async function POST(request: Request) {
  const authz = await requireFeatureAccess("accounting", "payroll_wizard", "view");
  if (!authz.ok) return deniedResponse(authz);

  let emails: string[];
  try {
    const body = (await request.json()) as { emails?: unknown };
    if (!Array.isArray(body.emails)) {
      return NextResponse.json({ error: "Body must be { emails: string[] }" }, { status: 400 });
    }
    emails = normalizeIdentityEmails(body.emails);
  } catch {
    return NextResponse.json({ error: "Malformed JSON body" }, { status: 400 });
  }
  if (emails.length > NPD_IDENTITY_MAX_EMAILS) {
    return NextResponse.json({ error: `At most ${NPD_IDENTITY_MAX_EMAILS} addresses per lookup` }, { status: 400 });
  }
  if (emails.length === 0) return NextResponse.json({ byEmail: {}, error: null });

  const supabase = createSupabaseServiceRoleClient();
  if (!supabase) return NextResponse.json({ error: "Supabase not configured" }, { status: 503 });

  const { rows, error } = await selectAllPaged<MasterIdentityRow>((from, to) =>
    supabase
      .from("global_master_list")
      .select(
        'id, Name, Department, "Work Email", "Personal Email", "Alternate Work Email", "Alternate Work Email 2", "Start Date", off_boarded_at, off_boarded_reason',
      )
      .order("id", { ascending: true })
      .range(from, to),
  );
  if (error) {
    return NextResponse.json({ error: `The master list could not be read: ${error}` }, { status: 502 });
  }

  return NextResponse.json({ byEmail: matchNpdIdentities(rows, emails), error: null });
}
