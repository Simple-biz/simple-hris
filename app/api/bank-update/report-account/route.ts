import { NextResponse } from "next/server";
import { resolveSessionToken, findActiveEmployeeByEmail } from "@/lib/bank-update/otp";
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
 * The public /update-bank-info page's "report a problem with this account"
 * (docs/features/payout-account-reports.md). Under /api/bank-update/* because that
 * is the only API prefix the isolated public host serves (update-bank-info.md
 * rule 11), so the proxy's per-IP limiter covers it too.
 *
 * Identity comes ONLY from the verified session token, never the body — exactly
 * like the save (rule 1). It writes `payout_account_reports` and nothing else:
 * no payout field, no routing. NOT gated on the payroll dispatch lock: a report
 * moves no money, and mid-dispatch is when Accounting most needs to hear it.
 *
 *   { session_token, action: "report", account_kind, status, note? }
 *   { session_token, action: "withdraw", report_id }
 * → { ok: true, account_reports }  (the refreshed view)
 */
export async function POST(req: Request) {
  const body = (await req.json().catch(() => ({}))) as Record<string, unknown>;
  const workEmail = await resolveSessionToken(String(body.session_token ?? ""));
  if (!workEmail) {
    return NextResponse.json(
      { error: "Your verification expired. Please request a new code and try again." },
      { status: 401 },
    );
  }
  const ip = clientIp(req);
  const match = await findActiveEmployeeByEmail(workEmail);
  const { row, rail, error } = await loadPayoutRowAndRail(workEmail);
  if (error) {
    return NextResponse.json(
      { error: "We couldn't read your payout record. Please try again in a minute." },
      { status: 503 },
    );
  }

  const result =
    body.action === "withdraw"
      ? await withdrawAccountReport({
          workEmails: [workEmail, match?.personalEmail],
          displayName: match?.name ?? null,
          reportId: String(body.report_id ?? ""),
          via: "external_link",
          ip,
        })
      : await (async () => {
          const input = validateReportInput(body);
          if (!input.ok) return { ok: false as const, status: 400, error: input.error };
          return fileAccountReport({
            workEmail,
            displayName: match?.name ?? null,
            row,
            rail,
            kind: input.kind,
            status: input.status,
            note: input.note,
            via: "external_link",
            ip,
          });
        })();
  if (!result.ok) return NextResponse.json({ error: result.error }, { status: result.status });

  const accountReports = await readAccountReportsView({
    emails: [workEmail, match?.personalEmail, row?.personal_email as string | null | undefined],
    row,
    rail,
  });
  return NextResponse.json({ ok: true, account_reports: accountReports });
}
