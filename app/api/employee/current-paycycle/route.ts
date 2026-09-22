import { NextResponse } from "next/server";
import { getServerSession } from "next-auth/next";
import { authOptions } from "@/lib/auth/auth-options";
import { createSupabaseServiceRoleClient, createSupabaseServerClient } from "@/lib/supabase/server";
import { getEmployeeMasterRecord } from "@/lib/supabase/employees";
import { getAppSettings } from "@/lib/supabase/app-settings";
import { listPaymentDispatches } from "@/lib/supabase/payment-dispatches";
import { listPaystubPayloadsForEmployee } from "@/lib/supabase/paystub-dispatch-queue";
import { listAllOrphanagePayHours } from "@/lib/supabase/orphanage-pay-db";
import { getEmployeeKpiResults } from "@/lib/supabase/employee-kpi-results";
import { loadRecoveryForWeeks } from "@/lib/payroll/paystub-recovery";
import { mapPayloadToPayStub, formatWeekHuman, type PayStubView } from "@/lib/payroll/paystub-view";
import { resolveEmployeeProcessor } from "@/lib/payroll/pay-schedule";
import { parseDateRangeFromFilename } from "@/lib/hubstaff/calendar-column-dedupe";
import { collapseToSingleUploadBatch } from "@/lib/supabase/hubstaff-hours-db";
import { buildPaycycleDays } from "@/lib/employee/paycycle-days";
import {
  cycleFxSettingKey,
  orphanageConfirmedSettingKey,
  parseCycleFxRecord,
  parseOrphanageNoneMarker,
  parseDispatchLockValue,
} from "@/lib/payroll/wizard-setup-steps";
import { parseAdditionsBlob, pickAdditionsOverlay } from "@/lib/payroll/paystub-recovered";
import {
  callerEmails,
  currentFxRate,
  listUploadIndex,
  reconstructStubForWeek,
} from "@/lib/payroll/employee-paystubs";
import { isProcessorId, type ProcessorId } from "@/lib/employee-payment-processors";
import {
  derivePaycycleSteps,
  type PaycycleStepKey,
  type PaycycleTrackInput,
} from "@/lib/employee/paycycle-steps";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

/**
 * GET — the CALLER's own in-flight pay week, disassembled, plus the eight-step
 * payroll track. Powers Profile → Compensation → Current Paycycle.
 *
 * SESSION-SCOPED, and it accepts NO email. Every lookup is filtered by the
 * address set the SERVER derives from the session (`callerEmails`), mirroring
 * `app/api/employee/orphanage-hours/route.ts` and `app/api/employee/paystub`.
 * There is no `?email=` parameter, so there is nothing to forge — which matters
 * more here than on most routes, because several of the underlying carriers
 * (the additions blob, the FX record, the dispatch lock) are COMPANY-WIDE
 * objects. They are read server-side and only this caller's slice leaves the
 * building. The blob itself must never reach a browser.
 *
 * WHICH WEEK: the newest Hubstaff upload (Kane, 2026-09-22: *"Just show the
 * latest hubstaff week"*). `listUploadIndex()` returns files newest-first, so
 * `files[0]` IS that week. Deliberately NOT the accounting `is_current` fork —
 * `hubstaff-hours-db.ts:510-518` records that the two answers are separate on
 * purpose and must not be harmonized — and deliberately not
 * `payrollNotesWeekStart()`, which is a third answer again.
 *
 * DEGRADED READS: every read below is individually try/caught into
 * `degradedKeys`. One failed read degrades ONE step to `pending`; it never
 * fails the response and it never becomes a green dot. See `paycycle-steps.ts`
 * for why that distinction is the whole point of the module.
 */

/** Sunday ISO of a week, from the upload filename.
 *
 *  Do NOT Monday-anchor this. Pay weeks are Sunday-anchored (the uploader
 *  refuses a filename whose range does not start on a Sunday) and the
 *  `payroll.wizard.orphanage_confirmed.<Sunday ISO>` marker is keyed on exactly
 *  this value. An ISO/Monday week start would pull the Sunday back a full week
 *  and read an empty marker — the same bug `weekKeyFromSourceFile` in
 *  payroll-readiness.ts:400-408 documents. */
function weekStartIsoFromSourceFile(sourceFile: string): string | null {
  const range = parseDateRangeFromFilename(sourceFile);
  if (!range?.start || Number.isNaN(range.start.getTime())) return null;
  return toIso(range.start);
}

function toIso(d: Date): string {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(
    d.getDate(),
  ).padStart(2, "0")}`;
}

/**
 * This caller's Hubstaff rows for ONE upload. Alias-filtered and PAGED —
 * PostgREST truncates at 1000 rows even with `.range()`.
 *
 * Returns the rows RAW. Parsing them into days is `buildPaycycleDays`'s job and
 * lives in a pure, tested module: the day columns are canonical weekday names
 * holding duration strings (`"8:20:29"`), and reading them with `Number()` is
 * exactly how this pane shipped blank on 2026-09-22.
 *
 * A double ingest leaves two `upload_id` batches under one `source_file`
 * (memory `hubstaff-double-ingest-duplicate-batch`), so the rows are collapsed
 * to the PREFERRED batch before anyone counts them — `INDEX.md:41`: *"A double
 * ingest must collapse to the preferred batch — readers dedupe, they do not
 * sum."* Picking the last row instead, as this first did, is the coin-flip that
 * rule exists to forbid.
 */
async function fetchHoursRows(
  emails: string[],
  sourceFile: string,
  preferredUploadId: string | null,
): Promise<Record<string, unknown>[]> {
  const supabase = createSupabaseServiceRoleClient() ?? createSupabaseServerClient();
  if (!supabase) throw new Error("Supabase client unavailable");
  const table =
    process.env.NEXT_PUBLIC_SUPABASE_HUBSTAFF_HOURS_TABLE?.trim() || "hubstaff_hours";
  // The Hubstaff CSV's own "Email" column (capital E), the same column the
  // authoritative pay calculator filters on.
  const orFilter = emails.map((e) => `"Email".eq.${e}`).join(",");
  const PAGE = 1000;
  const rows: Record<string, unknown>[] = [];
  let from = 0;
  while (true) {
    const { data, error } = await supabase
      .from(table)
      .select("*")
      .or(orFilter)
      .eq("source_file", sourceFile)
      .range(from, from + PAGE - 1);
    if (error) throw new Error(error.message);
    const page = (data ?? []) as Record<string, unknown>[];
    rows.push(...page);
    if (page.length < PAGE) break;
    from += PAGE;
    if (from > 10_000) break;
  }
  return collapseToSingleUploadBatch(rows, preferredUploadId);
}

/** Does the week's orphanage data exist AT ALL — for anyone? This is what makes
 *  "Not applicable" sayable (Kane, Q7). One row for the file is enough. */
async function orphanageWeekLanded(sourceFile: string): Promise<boolean> {
  const supabase = createSupabaseServiceRoleClient() ?? createSupabaseServerClient();
  if (!supabase) throw new Error("Supabase client unavailable");
  const { data, error } = await supabase
    .from("orphanage_pay")
    .select("source_file")
    .eq("source_file", sourceFile)
    .limit(1);
  if (error) throw new Error(error.message);
  return (data ?? []).length > 0;
}

export async function GET() {
  const session = await getServerSession(authOptions);
  const email = (session?.user as { email?: string | null } | undefined)?.email
    ?.trim()
    .toLowerCase();
  if (!email) {
    return NextResponse.json({ error: "Not authenticated" }, { status: 401 });
  }

  const degraded = new Set<PaycycleStepKey>();
  const mark = (...keys: PaycycleStepKey[]) => keys.forEach((k) => degraded.add(k));

  const { employee: master } = await getEmployeeMasterRecord(email).catch(() => ({
    employee: null,
  }));
  const emails = callerEmails(email, master);

  // ── The week ───────────────────────────────────────────────────────────────
  let sourceFile: string | null = null;
  let uploadIdByFile = new Map<string, string | null>();
  try {
    const index = await listUploadIndex();
    uploadIdByFile = index.uploadIdByFile;
    sourceFile = index.files[0] ?? null; // newest-first — Kane's Q1 ruling
  } catch {
    mark("hubstaff");
  }

  if (!sourceFile) {
    // No upload has ever landed (or the index read failed). Everything else is
    // keyed on the file, so there is nothing further to measure — the track
    // renders all-pending rather than inventing a week.
    const track = derivePaycycleSteps({
      hubstaffLoaded: false,
      hasHoursRow: false,
      fxSet: false,
      orphanageWeekKnown: false,
      hasOrphanageHours: false,
      kpiCredited: false,
      hasAdjustment: false,
      adjustmentsSettled: false,
      wizardLocked: false,
      stagedForDispatch: false,
      paid: false,
      degradedKeys: degraded,
    });
    return NextResponse.json({ week: null, days: [], stub: null, track, rail: null, error: null });
  }

  const weekStartIso = weekStartIsoFromSourceFile(sourceFile);
  const range = parseDateRangeFromFilename(sourceFile);
  const weekEndIso = range ? toIso(range.end) : null;

  // ── Everything else, in parallel; each read owns its own failure ───────────
  const settingKeys = [
    cycleFxSettingKey(sourceFile),
    `payroll.dispatch_lock.${sourceFile}`,
    `payroll.wizard.additions.${sourceFile}`,
    ...(weekStartIso ? [orphanageConfirmedSettingKey(weekStartIso)] : []),
  ];

  const [
    settings,
    hoursRows,
    orphanageRows,
    orphanageLanded,
    kpi,
    staged,
    dispatches,
    processor,
    fallbackFxRate,
  ] = await Promise.all([
    getAppSettings(settingKeys).catch(() => {
      mark("fx", "adjustments", "locked", "orphanage");
      return null;
    }),
    fetchHoursRows(emails, sourceFile, uploadIdByFile.get(sourceFile) ?? null).catch(() => {
      mark("hubstaff");
      return null;
    }),
    listAllOrphanagePayHours(emails).catch(() => {
      mark("orphanage");
      return null;
    }),
    orphanageWeekLanded(sourceFile).catch(() => {
      mark("orphanage");
      return null;
    }),
    getEmployeeKpiResults(emails).catch(() => {
      mark("kpi");
      return null;
    }),
    // The shipped queue reader matches ONE email with `.eq` and has no alias
    // expansion (paystub-dispatch-queue.ts:266-271), so an alias-keyed staged
    // row would be invisible. Folding identity here is what makes step 7 true.
    Promise.all(emails.map((e) => listPaystubPayloadsForEmployee(e))).catch(() => {
      mark("dispatch");
      return null;
    }),
    Promise.all(emails.map((e) => listPaymentDispatches({ recipientEmail: e }))).catch(() => {
      mark("payout");
      return null;
    }),
    resolveEmployeeProcessor(emails).catch(() => null),
    currentFxRate().catch(() => 58),
  ]);

  // FX — a broken leg parses to 0 and so reads UNSET, never set.
  const fx = settings ? parseCycleFxRecord(settings[cycleFxSettingKey(sourceFile)]) : null;
  const fxSet = !!fx && fx.php > 0 && fx.cop > 0;

  // Lock.
  const lock = settings
    ? parseDispatchLockValue(settings[`payroll.dispatch_lock.${sourceFile}`])
    : { locked: false, lockedAt: null, lockedBy: null };

  // Adjustment — read from the company-wide blob SERVER-side; only this
  // caller's overlay is returned.
  const blob = settings
    ? parseAdditionsBlob(settings[`payroll.wizard.additions.${sourceFile}`])
    : null;
  const overlay = pickAdditionsOverlay(blob, emails);

  // Orphanage. `orphanageWeekKnown` needs POSITIVE evidence the week's data
  // landed: real rows for the file, OR the clerk's confirm-none marker. Real
  // rows outrank the marker — evidence beats an assertion.
  const noneMarker =
    settings && weekStartIso
      ? parseOrphanageNoneMarker(settings[orphanageConfirmedSettingKey(weekStartIso)])
      : null;
  const myOrphanageHours = (orphanageRows ?? [])
    .filter((r) => r.source_file === sourceFile)
    .reduce((sum, r) => sum + (Number.isFinite(r.hours) ? r.hours : 0), 0);

  // KPI — a period is visible here only when its manager marked it ready or
  // locked; drafts are filtered upstream (Kane, Q6: the moment it is marked).
  const kpiCredited = (kpi?.periods ?? []).some(
    (p) => !!weekStartIso && p.periodStart <= weekStartIso && p.periodEnd >= weekStartIso,
  );
  if (kpi?.error) mark("kpi");

  // Staged for dispatch — a row for THIS week that is not excluded. Presence
  // alone is not payability; `excluded` means "do not pay".
  const stagedRows = (staged ?? []).flatMap((r) => r.rows);
  if ((staged ?? []).some((r) => r.error)) mark("dispatch");
  const stagedForDispatch = stagedRows.some(
    (r) => r.cycle_source_file === sourceFile && !r.excluded,
  );

  const dispatchRows = (dispatches ?? []).flatMap((d) => d.rows);
  const paidRow = dispatchRows.find(
    (r) => r.status === "paid" && r.cycle_source_file === sourceFile,
  );

  const trackInput: PaycycleTrackInput = {
    hubstaffLoaded: true, // the file exists — we resolved the week from it
    hasHoursRow: (hoursRows ?? []).length > 0,
    fxSet,
    orphanageWeekKnown: orphanageLanded === true || !!noneMarker,
    hasOrphanageHours: myOrphanageHours > 0,
    kpiCredited,
    hasAdjustment: Math.abs(overlay.adjustment) > 0.005,
    // The additions blob keeps moving until the week is locked, so "no
    // adjustment for you" is not a settled fact before then.
    adjustmentsSettled: lock.locked,
    wizardLocked: lock.locked,
    stagedForDispatch,
    paid: !!paidRow,
    degradedKeys: degraded,
  };

  // ── The statement, reused rather than re-derived ───────────────────────────
  // Kane, Q8: *"All of the fields that fill the paystub"*. `PayStubView` IS
  // that list, so this returns the same object the Pay Stubs pane renders —
  // which is also why the two panes can never disagree about a line.
  let stub: PayStubView | null = null;
  try {
    const mine = stagedRows.find((r) => r.cycle_source_file === sourceFile && r.payload);
    if (mine?.payload) {
      stub = mapPayloadToPayStub(mine.payload, mine.pay_period ?? null);
    } else {
      const discMap = await loadRecoveryForWeeks([sourceFile], emails, uploadIdByFile);
      const disc = discMap.get(sourceFile);
      const recon = disc
        ? await reconstructStubForWeek({
            sourceFile,
            emails,
            name: master?.name ?? "",
            department: master?.department ?? "",
            paidAt: paidRow?.sent_date ?? null,
            processor,
            fallbackFxRate,
            disc,
            uploadId: uploadIdByFile.get(sourceFile) ?? null,
          })
        : null;
      stub = recon?.view ?? null;
    }
  } catch {
    // A missing statement is a legitimate mid-cycle state, not an error — the
    // day ladder and the track still render.
    stub = null;
  }

  const rail: ProcessorId | null =
    processor && isProcessorId(processor) ? (processor as ProcessorId) : null;

  return NextResponse.json({
    week: {
      sourceFile,
      weekStart: weekStartIso,
      weekEnd: weekEndIso,
      weekHuman: formatWeekHuman(weekStartIso, weekEndIso),
    },
    days: buildPaycycleDays(sourceFile, hoursRows ?? []),
    stub,
    track: derivePaycycleSteps(trackInput),
    rail,
    error: null,
  });
}
