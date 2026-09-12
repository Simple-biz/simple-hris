import { NextRequest, NextResponse } from "next/server";
import { getServerSession } from "next-auth/next";
import { authOptions } from "@/lib/auth/auth-options";
import { listPaymentDispatches } from "@/lib/supabase/payment-dispatches";
import {
  listPaystubEntriesForEmployee,
  listPaystubPayloadsForEmployee,
} from "@/lib/supabase/paystub-dispatch-queue";
import {
  getFreshPaystubEntry,
  finalPaySnapshotKey,
  getCatalogRateClaimsByEmail,
} from "@/lib/payroll/paystub-fresh";
import { mapPayloadToPayStub, formatWeekHuman } from "@/lib/payroll/paystub-view";
import { loadRecoveryForWeeks } from "@/lib/payroll/paystub-recovery";
import { resolveEmployeeProcessor, resolvePayDateIso } from "@/lib/payroll/pay-schedule";
import {
  dedupeOneRowPerWeek,
  dropDominatedCandidates,
  type WeekIdentity,
} from "@/lib/payroll/paystub-week-dedupe";
import { getEmployeeMasterRecord } from "@/lib/supabase/employees";
import { getAppSettingsWithMeta } from "@/lib/supabase/app-settings";
import { parseDateRangeFromFilename } from "@/lib/hubstaff/calendar-column-dedupe";
import { resolveIssueForDisplay } from '@/lib/payroll/paystub-issue';
import { listIssuesForStatement } from '@/lib/supabase/paystub-issues';
import {
  SHOW_UNPAID_STAGED_PAYSTUBS,
  callerEmails,
  candidateIdentity,
  copDecoratorForEmails,
  currentFxRate,
  emptyWeekDiscretionary,
  fmtIso,
  freshStagedViewWith,
  listEmployeePayStubs,
  listUploadIndex,
  mapWithConcurrency,
  paidAtByFileFrom,
  reconstructStubForWeek,
  round2,
  type PayStubSummary,
} from "@/lib/payroll/employee-paystubs";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

/**
 * The statement assembly (recovery tiers, `buildView`, `reconstructStubForWeek`,
 * the one-row-per-week guardrail) lives in `src/lib/payroll/employee-paystubs.ts`
 * since 2026-09-10 so the Certificate of Engagement can read the same weeks; the
 * `SHOW_UNPAID_STAGED_PAYSTUBS` launch switch is documented there. This file is
 * the HTTP shell: session → email, then the four read modes below.
 */

export async function GET(req: NextRequest) {
  const session = await getServerSession(authOptions);
  const email = (session?.user as { email?: string | null } | undefined)?.email
    ?.trim()
    .toLowerCase();
  if (!email) {
    return NextResponse.json({ error: "Not authenticated" }, { status: 401 });
  }

  const sourceFile = req.nextUrl.searchParams.get("source_file")?.trim();

  // ── Single-week mode: return the paystub for one week ─────────────────────
  if (sourceFile) {
    const { rows: dispatches } = await listPaymentDispatches({ recipientEmail: email });
    const paid = dispatches.find(
      (r) => r.status === "paid" && r.cycle_source_file === sourceFile,
    );
    const paidAt = paid?.sent_date ?? null;
    const { employee: master } = await getEmployeeMasterRecord(email);
    const emails = callerEmails(email, master);
    const [processor, copDecorate] = await Promise.all([
      resolveEmployeeProcessor(emails),
      copDecoratorForEmails(emails),
    ]);

    // 1) Prefer a locked/staged payload — byte-identical to the emailed stub.
    //    Paid → the frozen as-paid record (the mark-paid path persisted exactly
    //    what was emailed onto the queue row). Unpaid (pre-launch preview) → the
    //    staged payload with any NEWER wizard-snapshot figures merged over it, so
    //    the preview matches the wizard + Payment Dispatch (see paystub-fresh.ts).
    const fresh = await getFreshPaystubEntry(sourceFile, email);
    const staged = fresh.staged;
    if (staged?.payload && (SHOW_UNPAID_STAGED_PAYSTUBS || paid)) {
      const paystub = copDecorate(
        paid
          ? mapPayloadToPayStub(staged.payload, staged.pay_period)
          : mapPayloadToPayStub(fresh.payload, fresh.payPeriod),
      );
      // Which issue of this statement is the employee looking at? Recorded
      // history wins; `send_count` is the fallback that makes the 117
      // statements re-sent before 2026-09-12 legible as "Issue 2" — with no
      // word, since whether their figures moved was never recorded.
      const issue = resolveIssueForDisplay({
        issues: await listIssuesForStatement(sourceFile, email),
        sendCount: staged.send_count,
      });
      return NextResponse.json({
        paystub,
        available: true,
        paidAt,
        payDate: resolvePayDateIso(paidAt, paystub.weekEnd, processor),
        status: paid ? "paid" : "issued",
        currentDepartment: master?.department ?? null,
        issue,
      });
    }

    // 2) Pre-launch: recover an unlocked week from the wizard snapshot + hours.
    if (SHOW_UNPAID_STAGED_PAYSTUBS) {
      const [{ uploadIdByFile }, fallbackFxRate] = await Promise.all([
        listUploadIndex(),
        currentFxRate(),
      ]);
      const uploadId = uploadIdByFile.get(sourceFile) ?? null;
      const discMap = await loadRecoveryForWeeks([sourceFile], emails, uploadIdByFile);
      const disc = discMap.get(sourceFile);
      const recon = disc
        ? await reconstructStubForWeek({
            sourceFile,
            emails,
            name: master?.name ?? "",
            department: master?.department ?? "",
            paidAt,
            processor,
            fallbackFxRate,
            disc,
            uploadId,
          })
        : null;
      if (recon) {
        return NextResponse.json({
          paystub: copDecorate(recon.view),
          available: true,
          paidAt,
          payDate: recon.payDate,
          status: paid ? "paid" : "issued",
          currentDepartment: master?.department ?? null,
        });
      }
    }

    return NextResponse.json({ paystub: null, available: false, paidAt: null, payDate: null });
  }

  const wantSummary = !!req.nextUrl.searchParams.get("summary");
  const wantAll = !!req.nextUrl.searchParams.get("all");

  // Employee-scope catalog rate claims gate the snapshot merge below — a stale
  // wizard session's snapshot must not overwrite corrected staged figures
  // (see mergeSnapshotIntoStaged). One query, shared across every week's row.
  const catalogClaims = await getCatalogRateClaimsByEmail();
  const freshStagedView = freshStagedViewWith(catalogClaims);

  // ── Summary mode: lightweight per-week rows for the paginated list ─────────
  // Totals come from the staged payload or the wizard `final_pay` snapshot with
  // NO per-week `computeCurrentPay` — the slow engine runs ONLY for weeks that
  // have neither (oldest, pre-snapshot weeks). This is the fast path the tab uses.
  if (wantSummary) {
    const [
      { rows: dispatches },
      { rows: payloads },
      { employee: master },
      { files: allFiles, uploadIdByFile },
      fxFallback,
    ] = await Promise.all([
      listPaymentDispatches({ recipientEmail: email }),
      listPaystubPayloadsForEmployee(email),
      getEmployeeMasterRecord(email),
      listUploadIndex(),
      currentFxRate(),
    ]);
    const emails = callerEmails(email, master);
    const processor = await resolveEmployeeProcessor(emails);
    const paidAtByFile = paidAtByFileFrom(dispatches);

    const staged = payloads.filter(
      (p) => p.payload && (SHOW_UNPAID_STAGED_PAYSTUBS || paidAtByFile.has(p.cycle_source_file)),
    );
    const stagedFiles = new Set(staged.map((p) => p.cycle_source_file));
    // Snapshot metadata for the UNPAID staged weeks (one round-trip) so their
    // rows render the same merged figures the single-week modal shows.
    const unpaidSnaps = await getAppSettingsWithMeta(
      staged
        .filter((p) => !paidAtByFile.has(p.cycle_source_file))
        .map((p) => finalPaySnapshotKey(p.cycle_source_file)),
    );
    const rows: PayStubSummary[] = staged.map((p) => {
      const pAt = paidAtByFile.get(p.cycle_source_file) ?? null;
      const v = freshStagedView(p, pAt != null, unpaidSnaps);
      return {
        sourceFile: p.cycle_source_file,
        weekStart: v.weekStart,
        weekEnd: v.weekEnd,
        weekHuman: v.weekHuman,
        totalPayPhp: v.totalPayPhp,
        totalPayUsd: v.totalPayUsd,
        paidAt: pAt,
        payDate: resolvePayDateIso(pAt, v.weekEnd, processor),
      };
    });

    if (SHOW_UNPAID_STAGED_PAYSTUBS) {
      // Prune BEFORE any recovery work: a non-staged file whose week a staged
      // row (or a newer non-staged upload) already wins would be discarded by
      // the final dedupe below anyway — so never pay to build it. Same
      // precedence, applied early; the final dedupe still runs as the guardrail.
      const uploadRankEarly = new Map(allFiles.map((f, i) => [f, i] as const));
      const stagedIdentities: WeekIdentity[] = rows.map((r) => ({
        weekStart: r.weekStart,
        weekEnd: r.weekEnd,
        paid: r.paidAt != null,
        paidAt: r.paidAt,
        staged: true,
        rank: uploadRankEarly.get(r.sourceFile),
      }));
      const others = dropDominatedCandidates(
        allFiles.filter((f) => !stagedFiles.has(f)),
        (f) => candidateIdentity(f, paidAtByFile, uploadRankEarly),
        stagedIdentities,
      );
      // ONE app_settings round-trip for every tier of every candidate week
      // (wizard snapshot · recovered snapshot · additions blob).
      const recovery = await loadRecoveryForWeeks(others, emails, uploadIdByFile);
      const needEngine: string[] = [];
      for (const f of others) {
        const disc = recovery.get(f);
        const fp = disc?.finalPay ?? null;
        if (!fp) {
          // A matching recovered snapshot without this person = not in this
          // week; the engine already said so. Only a week with NO usable
          // snapshot at all still needs it.
          if (!disc?.recoveredWeekClosed) needEngine.push(f);
          continue;
        }
        const range = parseDateRangeFromFilename(f);
        let weekStart = range ? fmtIso(range.start) : null;
        let weekEnd = range ? fmtIso(range.end) : null;
        if (disc?.source === "recovered" && disc.period) {
          weekStart = disc.period.start ?? weekStart;
          weekEnd = disc.period.end ?? weekEnd;
        }
        const fx = disc?.fxRate && disc.fxRate > 0 ? disc.fxRate : fxFallback;
        const totalPayPhp = round2(fp.final);
        const pAt = paidAtByFile.get(f) ?? null;
        rows.push({
          sourceFile: f,
          weekStart,
          weekEnd,
          weekHuman: formatWeekHuman(weekStart, weekEnd),
          totalPayPhp,
          totalPayUsd: fx > 0 ? round2(totalPayPhp / fx) : 0,
          paidAt: pAt,
          payDate: resolvePayDateIso(pAt, weekEnd, processor),
        });
      }
      // Only weeks with neither a staged payload nor ANY snapshot need the engine.
      const heavy = await mapWithConcurrency(needEngine, 6, (f) =>
        reconstructStubForWeek({
          sourceFile: f,
          emails,
          name: master?.name ?? "",
          department: master?.department ?? "",
          paidAt: paidAtByFile.get(f) ?? null,
          processor,
          fallbackFxRate: fxFallback,
          disc: recovery.get(f) ?? emptyWeekDiscretionary(),
          uploadId: uploadIdByFile.get(f) ?? null,
        }),
      );
      for (const s of heavy) {
        if (!s) continue;
        rows.push({
          sourceFile: s.sourceFile,
          weekStart: s.view.weekStart,
          weekEnd: s.view.weekEnd,
          weekHuman: s.view.weekHuman,
          totalPayPhp: s.view.totalPayPhp,
          totalPayUsd: s.view.totalPayUsd,
          paidAt: s.paidAt,
          payDate: s.payDate,
        });
      }
    }

    rows.sort((a, b) => (b.weekEnd ?? "").localeCompare(a.weekEnd ?? ""));
    // Same one-row-per-week guardrail as the all-weeks export, so the list the
    // employee sees and the PDF/XLSX they download agree on the week set.
    const uploadRank = new Map(allFiles.map((f, i) => [f, i] as const));
    const dedupedRows = dedupeOneRowPerWeek(rows, (r) => ({
      weekStart: r.weekStart,
      weekEnd: r.weekEnd,
      paid: r.paidAt != null,
      paidAt: r.paidAt,
      staged: stagedFiles.has(r.sourceFile),
      rank: uploadRank.get(r.sourceFile),
    }));
    return NextResponse.json({ stubs: dedupedRows });
  }

  // ── All-weeks mode: full statements for every week (drives the export) ─────
  if (wantAll) {
    const { stubs, currentDepartment } = await listEmployeePayStubs(email);
    return NextResponse.json({ stubs, currentDepartment });
  }

  // ── List mode: which weeks can this employee open? ────────────────────────
  const [{ rows: dispatches }, { rows: staged }] = await Promise.all([
    listPaymentDispatches({ recipientEmail: email }),
    listPaystubEntriesForEmployee(email),
  ]);

  // Contractor-invoice settlements are excluded: they carry the live cycle's
  // source_file and the person's email, so for someone who both invoices and draws
  // a salary (e.g. a contractor-role holder who also logs hours) a settled invoice
  // would unlock an hourly PAY STUB for a week whose salary was never paid.
  // `payee_type` is absent pre-migration, and `undefined !== 'contractor'` keeps
  // today's behaviour exactly.
  const paidFiles = new Set(
    dispatches
      .filter((r) => r.status === "paid" && r.cycle_source_file && r.payee_type !== "contractor")
      .map((r) => r.cycle_source_file as string),
  );
  const stagedFiles = new Set(staged.map((r) => r.cycle_source_file));
  const weeks = [...paidFiles].filter((f) => stagedFiles.has(f));

  return NextResponse.json({ weeks });
}
