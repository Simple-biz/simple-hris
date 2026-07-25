import { NextResponse } from "next/server";
import { getServerSession } from "next-auth/next";
import { authOptions } from "@/lib/auth/auth-options";
import { getEmployeeMasterRecord } from "@/lib/supabase/employees";
import { listAllOrphanagePayHours } from "@/lib/supabase/orphanage-pay-db";
import { normEmail } from "@/lib/email/norm-email";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

/**
 * GET — the CALLER's own locked-in orphanage hours across every pay week
 * (`{ source_file, hours }[]`). Session-scoped: an employee only sees their own
 * rows, bridged across their master-list aliases (work / personal / alternates).
 *
 * Powers the TEMPORARY orphanage → PAB coverage on the employee side
 * (My Hours / Dashboard calendars + the "Orphanage – Visits" section): the
 * client pairs these hours with the employee's approved orphanage-visit dates
 * to top an excused day up to the 7h PAB threshold. See orphanage-pab-coverage.ts.
 */
export async function GET() {
  const session = await getServerSession(authOptions);
  const sessionEmail = (session?.user as { email?: string | null } | undefined)?.email ?? null;
  const norm = normEmail(sessionEmail);
  if (!norm) {
    return NextResponse.json({ rows: [], error: "Not signed in" }, { status: 401 });
  }

  const aliases = new Set<string>([norm]);
  try {
    const { employee: master } = await getEmployeeMasterRecord(norm);
    for (const e of [
      master?.work_email,
      master?.personal_email,
      master?.alternate_work_email,
      master?.alternate_work_email_2,
    ]) {
      const n = normEmail(e ?? null);
      if (n) aliases.add(n);
    }
  } catch {
    /* master lookup best-effort — fall back to the session email alone */
  }

  try {
    const rows = await listAllOrphanagePayHours(aliases);
    // Only expose what the client needs (source_file + hours); the email is the
    // caller's own and adds nothing.
    return NextResponse.json({
      rows: rows.map((r) => ({ source_file: r.source_file, hours: r.hours })),
      error: null,
    });
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    return NextResponse.json({ rows: [], error: msg }, { status: 500 });
  }
}
