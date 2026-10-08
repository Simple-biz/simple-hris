import { NextResponse } from "next/server";
import { authorizeEmailAccess, deniedResponse } from "@/lib/auth/authorize-email";
import { findActiveEmployeeByEmail } from "@/lib/bank-update/otp";
import { validateReportInput } from "@/lib/banking/payout-account-reports";
import {
  fileAccountReport,
  loadPayoutRowAndRail,
  readAccountReportsView,
  withdrawAccountReport,
} from "@/lib/supabase/payout-account-reports";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

function clientIp(req: Request): string | null {
  const xff = req.headers.get("x-forwarded-for");
  if (xff) return xff.split(",")[0]?.trim() || null;
  return req.headers.get("x-real-ip");
}

/**
 * Profile → Payout's "report a problem with this account"
 * (docs/features/payout-account-reports.md). The employee's OWN accounts only:
 * a report is the employee's statement about their account, so staff, who may
 * read anyone's row through `authorizeEmailAccess`, cannot file one for them
 * (403). Writes `payout_account_reports` and nothing else, and is not gated on
 * the payroll lock, same as the external link.
 *
 *   { email, action: "report", account_kind, status, note? }
 *   { email, action: "withdraw", report_id }
 * → { ok: true, accountReports }
 */
export async function POST(req: Request) {
  const body = (await req.json().catch(() => ({}))) as Record<string, unknown>;
  const email = typeof body.email === "string" ? body.email.trim() : "";
  if (!email) return NextResponse.json({ error: "email is required" }, { status: 400 });

  const authz = await authorizeEmailAccess(email);
  if (!authz.ok) return deniedResponse(authz);
  if (authz.effectiveEmail.toLowerCase() !== authz.sessionEmail.toLowerCase()) {
    return NextResponse.json(
      { error: "Only the employee can report a problem with their own account." },
      { status: 403 },
    );
  }

  const ip = clientIp(req);
  const { row, rail, error } = await loadPayoutRowAndRail(authz.effectiveEmail);
  if (error) {
    return NextResponse.json(
      { error: "We couldn't read your payout record. Please try again in a minute." },
      { status: 503 },
    );
  }
  const roster = await findActiveEmployeeByEmail(authz.effectiveEmail);
  const workEmail = (row?.work_email as string | null | undefined) || roster?.workEmail || authz.effectiveEmail;
  const displayName = roster?.name ?? ((row?.name as string | null | undefined) || null);
  const emails = [authz.effectiveEmail, workEmail, roster?.personalEmail, row?.personal_email as string | null | undefined];

  const result =
    body.action === "withdraw"
      ? await withdrawAccountReport({
          workEmails: emails,
          displayName,
          reportId: String(body.report_id ?? ""),
          via: "employee_dashboard",
          ip,
        })
      : await (async () => {
          const input = validateReportInput(body);
          if (!input.ok) return { ok: false as const, status: 400, error: input.error };
          return fileAccountReport({
            workEmail,
            displayName,
            row,
            rail,
            kind: input.kind,
            status: input.status,
            note: input.note,
            via: "employee_dashboard",
            ip,
          });
        })();
  if (!result.ok) return NextResponse.json({ error: result.error }, { status: result.status });

  const accountReports = await readAccountReportsView({ emails, row, rail });
  return NextResponse.json({ ok: true, accountReports });
}
