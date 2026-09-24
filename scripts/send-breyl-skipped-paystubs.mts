/**
 * Re-sends the paystubs breyl@simple.biz never received (Open item 199): the
 * weeks n8n skipped because his Personal Email held his name. Kane asked for it
 * on 2026-09-24 after the address was corrected (fix-breyl-personal-email.mjs).
 *
 *   node --import tsx scripts/send-breyl-skipped-paystubs.mts          # DRY RUN
 *   node --import tsx scripts/send-breyl-skipped-paystubs.mts --send   # email them
 *
 * This walks the SAME steps as the per-employee send in
 * app/api/payment-dispatches/route.ts, minus the payment write (the money
 * already moved) and the in-app "Salary Paid" notification (it is de-duped
 * per week and already fired when he was paid):
 *   getFreshPaystubEntry → reconcile the stub against the PAID amount (fall
 *   back to the staged payload if that is what was paid) → persist refreshed
 *   figures → nextIssueNo / classifyIssue → forwardPaystubDispatch →
 *   delivery test (succeeded > 0, failed 0) → markPaystubSent + recordPaystubIssue,
 *   or markPaystubSendError → audit log.
 *
 * Refuses a week that is not PAID in payment_dispatches, one whose queue row
 * already has `sent_at` (that would be a reissue, which the clerk decides), and
 * one whose queued address is not mailable.
 */
import dotenv from "dotenv";
dotenv.config({ path: ".env.local", quiet: true });

const { createSupabaseServiceRoleClient } = await import("@/lib/supabase/server");
const { getFreshPaystubEntry } = await import("@/lib/payroll/paystub-fresh");
const { forwardPaystubDispatch } = await import("@/lib/payroll/paystub-dispatch");
const { mapPayloadToPayStub } = await import("@/lib/payroll/paystub-view");
const { classifyIssue, issueChipText, issueNote, nextIssueNo } = await import("@/lib/payroll/paystub-issue");
const { listIssuesForStatement, recordPaystubIssue } = await import("@/lib/supabase/paystub-issues");
const { refreshPaystubQueuePayload, markPaystubSent, markPaystubSendError } = await import(
  "@/lib/supabase/paystub-dispatch-queue"
);
const { insertAuditLog } = await import("@/lib/supabase/audit-log");
const { mailableEmail } = await import("@/lib/email/norm-email");

const RECIPIENT = "breyl@simple.biz";
const ACTOR = "kaner@simple.biz";
const SEND = process.argv.includes("--send");
// The five weeks still skipped after 09-13 was sent from Payment Dispatch.
const WEEKS = [
  "simple-biz_daily_report_2026-09-06_to_2026-09-12.csv",
  "simple-biz_daily_report_2026-08-30_to_2026-09-05 4.csv",
  "simple-biz_daily_report_2026-08-23_to_2026-08-29 (1).csv",
  "simple-biz_daily_report_2026-08-16_to_2026-08-22.csv",
  "simple-biz_daily_report_2026-08-09_to_2026-08-15.csv",
];

const sb = createSupabaseServiceRoleClient();
if (!sb) throw new Error("no service-role client");

console.log(`${SEND ? "SEND" : "DRY RUN"} — ${RECIPIENT}\n`);
let sent = 0;
for (const sourceFile of WEEKS) {
  const tag = sourceFile.replace("simple-biz_daily_report_", "");
  const { data: pds, error: pdErr } = await sb
    .from("payment_dispatches")
    .select("id, status, amount_php, amount_usd, amount_cop, sent_date, cycle_id, cycle_period_start, cycle_period_end, payee_type")
    .eq("cycle_source_file", sourceFile)
    .ilike("recipient_email", RECIPIENT)
    .eq("status", "paid");
  if (pdErr) throw new Error(`${tag}: ${pdErr.message}`);
  const paidRows = (pds ?? []).filter((r) => r.payee_type !== "contractor");
  if (paidRows.length !== 1) {
    console.log(`  SKIP ${tag}: ${paidRows.length} paid dispatch rows (need exactly 1)`);
    continue;
  }
  const row = paidRows[0];

  const fresh = await getFreshPaystubEntry(sourceFile, RECIPIENT);
  const staged = fresh.staged;
  if (!staged || !fresh.payload) {
    console.log(`  SKIP ${tag}: no staged paystub (${fresh.error ?? "none"})`);
    continue;
  }
  if (staged.sent_at) {
    console.log(`  SKIP ${tag}: already sent ${staged.sent_at} — a reissue is the clerk's call`);
    continue;
  }
  const addr = mailableEmail((fresh.payload as { personal_email?: string }).personal_email);
  if (!addr) {
    console.log(`  SKIP ${tag}: queued address not mailable`);
    continue;
  }

  // Reconcile against the money that moved — same rule as the route.
  const paidAmount = row.amount_php != null ? Number(row.amount_php) : null;
  let stubPayload = fresh.payload;
  let stubPeriod = fresh.payPeriod;
  let view = mapPayloadToPayStub(stubPayload, stubPeriod);
  let doRefresh = fresh.refreshed;
  let mismatch: { paid: number; stub: number } | null = null;
  if (paidAmount != null && Number.isFinite(paidAmount) && Math.abs(view.totalPayPhp - paidAmount) >= 0.01) {
    const stagedView = mapPayloadToPayStub(staged.payload, staged.pay_period);
    if (Math.abs(stagedView.totalPayPhp - paidAmount) < 0.01) {
      stubPayload = staged.payload!;
      stubPeriod = staged.pay_period;
      view = stagedView;
      doRefresh = false;
    } else {
      mismatch = { paid: paidAmount, stub: view.totalPayPhp };
    }
  }
  if (mismatch) {
    console.log(`  SKIP ${tag}: stub ₱${mismatch.stub} ≠ paid ₱${mismatch.paid} — needs accounting, not a blind send`);
    continue;
  }

  console.log(`  ${tag}: paid ₱${paidAmount} · stub ₱${view.totalPayPhp} · → ${addr}${doRefresh ? " · refresh" : ""}`);
  if (!SEND) continue;

  if (doRefresh) {
    await refreshPaystubQueuePayload({
      sourceFile,
      recipientEmail: RECIPIENT,
      payload: stubPayload,
      payPeriod: stubPeriod,
      amountPhp: view.totalPayPhp,
      amountUsd: view.totalPayUsd,
    });
  }
  const emailView =
    row.amount_cop != null && Number.isFinite(Number(row.amount_cop))
      ? { ...view, totalPayCop: Number(row.amount_cop) }
      : view;
  const priorIssues = await listIssuesForStatement(sourceFile, RECIPIENT);
  const priorIssue = priorIssues[priorIssues.length - 1] ?? null;
  const issueNo = nextIssueNo(staged.send_count);
  const issueKind = classifyIssue({
    issueNo,
    previousAmountPhp: priorIssue?.amountPhp ?? null,
    newAmountPhp: emailView.totalPayPhp,
  });
  const issueChip = issueChipText(issueKind, issueNo);

  const result = await forwardPaystubDispatch({
    pay_period: stubPeriod,
    employees: [stubPayload],
    views: [emailView],
    emailOptions: {
      paidAt: row.sent_date ?? null,
      status: "paid",
      issueChip,
      issueNote: issueNote({ kind: issueKind, issueNo, previousIssuedAt: priorIssue?.issuedAt ?? null }),
    },
    cycle: {
      source_file: sourceFile,
      period_start: row.cycle_period_start ?? null,
      period_end: row.cycle_period_end ?? null,
      cycle_id: row.cycle_id ?? null,
    },
  });
  const summary =
    result.parsed && typeof result.parsed === "object"
      ? (result.parsed as { succeeded?: unknown; failed?: unknown; failed_emails?: unknown })
      : null;
  const failed = typeof summary?.failed === "number" ? summary.failed : 0;
  const succeeded = typeof summary?.succeeded === "number" ? summary.succeeded : null;
  const delivered = result.ok && failed === 0 && (succeeded === null || succeeded > 0);

  if (delivered) {
    sent++;
    await markPaystubSent({ sourceFile, recipientEmail: RECIPIENT, sentBy: ACTOR, sendCount: issueNo });
    await recordPaystubIssue({
      sourceFile,
      recipientEmail: RECIPIENT,
      issueNo,
      issuedBy: ACTOR,
      kind: issueKind,
      amountPhp: emailView.totalPayPhp,
      amountUsd: emailView.totalPayUsd,
      previousAmountPhp: priorIssue?.amountPhp ?? null,
      source: "mark_paid",
      reason: "first delivery after personal-email fix (Open item 199)",
    });
    console.log(`    SENT (issue ${issueNo})`);
  } else {
    const detail =
      result.ok && failed === 0 && succeeded === 0
        ? "Recipient was skipped by the paystub workflow — no email was sent"
        : result.detail ?? "Paystub send failed";
    await markPaystubSendError({ sourceFile, recipientEmail: RECIPIENT, error: detail });
    console.log(`    FAILED: ${detail} (HTTP ${result.status})`);
  }
  await insertAuditLog({
    user_name: ACTOR,
    user_role: "admin",
    action: delivered ? "paystub.sent" : "paystub.send_failed",
    resource: "paystub_dispatch_queue",
    resource_id: row.id,
    details: {
      recipient_email: RECIPIENT,
      source_file: sourceFile,
      http_status: result.status,
      stub_total_php: view.totalPayPhp,
      amount_php_paid: paidAmount ?? undefined,
      refreshed_from_snapshot: doRefresh || undefined,
      via: "scripts/send-breyl-skipped-paystubs.mts",
    },
  });
  // Gmail's per-user cap is ~2/sec; the workflow throttles, but be polite.
  await new Promise((r) => setTimeout(r, 1500));
}
console.log(SEND ? `\n${sent} of ${WEEKS.length} delivered.` : "\nNothing sent. Re-run with --send.");
