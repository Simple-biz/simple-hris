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
  mergeSnapshotIntoStaged,
  finalPaySnapshotKey,
  getCatalogRateClaimsByEmail,
  catalogClaimForEmails,
} from "@/lib/payroll/paystub-fresh";
import {
  mapPayloadToPayStub,
  formatWeekHuman,
  parseProrationBlock,
  deriveProrationFields,
  applyCopEquivalent,
  type PayStubView,
  type ProrationBlockRaw,
} from "@/lib/payroll/paystub-view";
import {
  resolveCountryCurrencyForEmails,
  getUsdToCopRate,
} from "@/lib/payroll/cop-country";
import {
  computeCurrentPay,
  type CurrentPayEntry,
  type CurrentPayResult,
} from "@/lib/payroll/current-pay";
import { loadWeekDiscretionary, loadFinalPayForWeeks } from "@/lib/payroll/paystub-recovery";
import { resolveEmployeeProcessor, resolvePayDateIso } from "@/lib/payroll/pay-schedule";
import { getEmployeeMasterRecord } from "@/lib/supabase/employees";
import { getAppSetting, getAppSettingsWithMeta } from "@/lib/supabase/app-settings";
import { listHubstaffUploads, getUploadedSourceFiles } from "@/lib/supabase/hubstaff-hours-db";
import { parseDateRangeFromFilename } from "@/lib/hubstaff/calendar-column-dedupe";
import { normEmail } from "@/lib/email/norm-email";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

/**
 * TEMPORARY — until the HRIS payroll flow is the system of record.
 *
 * Pre-launch, the `payment_dispatches` "paid" mark isn't reliably set, so gating
 * pay stubs on a PAID dispatch would hide most (or all) of an employee's weeks.
 * While this is `true`, the Pay Stubs tab surfaces EVERY week — locked/staged
 * weeks render byte-exact from their staged payload, and every OTHER Hubstaff-
 * upload week is recovered from the wizard's persisted per-week snapshot (see
 * `paystub-recovery.ts`). Per the owner's decision these recovered weeks are
 * treated as final ("locked, paid out via Payment Dispatch") — no "estimate".
 *
 * Flip to `false` at HRIS launch to restore the strict paid-only rule: only weeks
 * with a real staged payload (and a paid dispatch) show, and no recovery runs.
 */
const SHOW_UNPAID_STAGED_PAYSTUBS = true;

/** One employee-facing stub: a rendered statement + its provenance dates. */
interface EmployeePayStub {
  sourceFile: string;
  /** Real paid date from a paid dispatch, else null. */
  paidAt: string | null;
  /** Display pay date: real paid date, else the scheduled Tue/Thu for this week. */
  payDate: string | null;
  view: PayStubView;
}

/** Lightweight per-week row for the paginated list + stat band. No itemized
 *  breakdown — just the total + dates — so it renders WITHOUT `computeCurrentPay`
 *  for any week that has a staged payload or a wizard snapshot. */
interface PayStubSummary {
  sourceFile: string;
  weekStart: string | null;
  weekEnd: string | null;
  weekHuman: string;
  totalPayPhp: number;
  totalPayUsd: number;
  paidAt: string | null;
  payDate: string | null;
}

/** Run `fn` over `items` with at most `limit` in flight — keeps the pay recovery
 *  from firing one heavy `computeCurrentPay` per week all at once. */
async function mapWithConcurrency<T, R>(
  items: T[],
  limit: number,
  fn: (item: T, index: number) => Promise<R>,
): Promise<R[]> {
  const results = new Array<R>(items.length);
  let cursor = 0;
  const worker = async () => {
    while (cursor < items.length) {
      const i = cursor++;
      results[i] = await fn(items[i], i);
    }
  };
  await Promise.all(
    Array.from({ length: Math.max(1, Math.min(limit, items.length)) }, worker),
  );
  return results;
}

/** All source-file (week) keys that exist, newest-first. Best-effort — falls back
 *  through the upload archive → distinct hours source_files → empty. */
async function listAllSourceFiles(): Promise<string[]> {
  try {
    const uploads = await listHubstaffUploads();
    const files = uploads.map((u) => u.source_file).filter((f): f is string => !!f);
    if (files.length > 0) return [...new Set(files)];
  } catch {
    /* fall through */
  }
  try {
    return [...new Set(await getUploadedSourceFiles())];
  } catch {
    return [];
  }
}

const round2 = (n: number) => Math.round((Number.isFinite(n) ? n : 0) * 100) / 100;

/** Format a local Date as YYYY-MM-DD (no TZ drift). */
function fmtIso(d: Date): string {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(
    d.getDate(),
  ).padStart(2, "0")}`;
}

/** Current USD→PHP rate (fallback for older snapshots that didn't store fx). */
async function currentFxRate(): Promise<number> {
  try {
    const raw = await getAppSetting("usd_to_php_rate");
    const n = raw ? Number(raw) : NaN;
    return Number.isFinite(n) && n > 0 ? n : 58;
  } catch {
    return 58;
  }
}

/** Assemble a PayStubView from the resolved scalar figures (shared by the fast +
 *  slow recovery paths). Orphanage is already folded into `totalPayPhp` and is
 *  ALSO carried as its own `orphanagePay` line (shown only when > 0), matching the
 *  staged-payload view + the emailed statement. */
function buildView(p: {
  name: string;
  department: string;
  weekStart: string | null;
  weekEnd: string | null;
  regularHours: number;
  otHours: number;
  mfPay: number;
  otPay: number;
  /** HSL weekend carve-out of mfPay/otPay (snapshots since 2026-07-30). The
   *  weekend hours/pay are already INSIDE the full figures — this only lets the
   *  statement split its earnings lines. Omit/null → classic two-line stub. */
  weekend?: {
    regularHours: number;
    otHours: number;
    regularPay: number;
    otPay: number;
  } | null;
  /** Mid-week proration block (snapshots since 2026-07-30) — drives the
   *  statement's "Prorated" chip + `₱old → ₱new` + hour basis on the affected
   *  lines. Omit/null → classic single-rate lines. */
  proration?: ProrationBlockRaw | null;
  pab: number;
  tech: number;
  performanceBonus: number;
  adjustment: number;
  adjustmentNote: string | null;
  orphanagePay: number;
  mesaDeduction: number;
  mesaDisbursement: number;
  totalPayPhp: number;
  fxRate: number;
}): PayStubView {
  const wknd = p.weekend ?? null;
  const weekdayHours = wknd ? Math.max(0, round2(p.regularHours - wknd.regularHours)) : round2(p.regularHours);
  const weekdayOtHours = wknd ? Math.max(0, round2(p.otHours - wknd.otHours)) : round2(p.otHours);
  const weekdayPay = wknd ? round2(p.mfPay - wknd.regularPay) : p.mfPay;
  const weekdayOtPay = wknd ? round2(p.otPay - wknd.otPay) : p.otPay;
  return {
    name: p.name || "—",
    department: p.department || "—",
    weekStart: p.weekStart,
    weekEnd: p.weekEnd,
    weekHuman: formatWeekHuman(p.weekStart, p.weekEnd),
    salaryDate: null,
    mfHours: round2(p.regularHours),
    mfOtHours: round2(p.otHours),
    // Effective rate paid this week (pay ÷ hours) — matches the "h × rate" line.
    // With a weekend split the Regular line shows the WEEKDAY figures, so its
    // rate is derived from those; the weekend lines get their own effective
    // rate (premium already inside the weekend pay).
    mfRate: wknd
      ? weekdayHours > 0
        ? round2(weekdayPay / weekdayHours)
        : 0
      : p.regularHours > 0
        ? round2(p.mfPay / p.regularHours)
        : 0,
    otRate: wknd
      ? weekdayOtHours > 0
        ? round2(weekdayOtPay / weekdayOtHours)
        : 0
      : p.otHours > 0
        ? round2(p.otPay / p.otHours)
        : 0,
    mfPay: p.mfPay,
    otPay: p.otPay,
    hasWeekend: wknd != null,
    weekendHours: wknd ? round2(wknd.regularHours) : 0,
    weekendOtHours: wknd ? round2(wknd.otHours) : 0,
    weekendRate: wknd && wknd.regularHours > 0 ? round2(wknd.regularPay / wknd.regularHours) : 0,
    weekendOtRate: wknd && wknd.otHours > 0 ? round2(wknd.otPay / wknd.otHours) : 0,
    weekendPay: wknd ? round2(wknd.regularPay) : 0,
    weekendOtPay: wknd ? round2(wknd.otPay) : 0,
    weekdayHours,
    weekdayOtHours,
    weekdayPay,
    weekdayOtPay,
    techBonus: p.tech,
    attendanceBonus: p.pab,
    performanceBonus: p.performanceBonus,
    adjustment: p.adjustment,
    adjustmentNote: p.adjustment !== 0 ? p.adjustmentNote : null,
    orphanagePay: p.orphanagePay,
    mesaDisbursement: p.mesaDisbursement,
    mesaDeduction: p.mesaDeduction,
    totalPayPhp: p.totalPayPhp,
    fxRate: p.fxRate,
    totalPayUsd: p.fxRate > 0 ? round2(p.totalPayPhp / p.fxRate) : 0,
    // COP-country payees get this stamped by the caller (applyCopEquivalent).
    totalPayCop: null,
    // Same derivation the payload path uses (parse → per-line views), so the
    // fast-path stub shows the identical chip/basis a staged payload would.
    proration: deriveProrationFields(
      parseProrationBlock({ proration: p.proration ?? null }),
      wknd
        ? {
            hours: wknd.regularHours,
            otHours: wknd.otHours,
            pay: wknd.regularPay,
            otPay: wknd.otPay,
            premiumPerHour: 15,
          }
        : null,
    ),
  };
}

/**
 * Build one week's full stub for a week that was never locked into the dispatch
 * queue, recovering the EXACT figures the wizard computed — not an estimate.
 *
 * FAST PATH: when the wizard snapshot carries the itemized bonus split (weeks from
 * 2026-07-18 on), the stub is reproduced verbatim from the snapshot with NO
 * `computeCurrentPay` call. SLOW PATH: older snapshots (bonus split absent) and
 * weeks with no snapshot fall back to the deterministic engine for the PAB/Tech
 * split + base pay, distributing the exact `final` so lines always reconcile.
 *
 * Returns null when the caller isn't in this week (no hours AND no snapshot).
 */
async function reconstructStubForWeek(params: {
  sourceFile: string;
  emails: string[];
  name: string;
  department: string;
  paidAt: string | null;
  processor: string | null;
  fallbackFxRate: number;
}): Promise<EmployeePayStub | null> {
  const disc = await loadWeekDiscretionary(params.sourceFile, params.emails);
  const fp = disc.finalPay;
  const itemized =
    !!fp &&
    typeof fp.perfectAttendanceBonus === "number" &&
    typeof fp.techBonus === "number" &&
    typeof fp.otherBonuses === "number";

  // Cheap dates from the filename (used directly on the fast path).
  let weekStart: string | null = null;
  let weekEnd: string | null = null;
  const range = parseDateRangeFromFilename(params.sourceFile);
  if (range) {
    weekStart = fmtIso(range.start);
    weekEnd = fmtIso(range.end);
  }

  const payDate = () => resolvePayDateIso(params.paidAt, weekEnd, params.processor);

  // ── FAST PATH: itemized snapshot → no computeCurrentPay ──────────────────────
  if (itemized && fp) {
    const fxRate = disc.fxRate && disc.fxRate > 0 ? disc.fxRate : params.fallbackFxRate;
    const mfPay = round2(fp.regularPay ?? 0);
    const otPay = round2(fp.otPay ?? 0);
    const view = buildView({
      name: params.name,
      department: params.department,
      weekStart,
      weekEnd,
      regularHours: fp.regularHours,
      otHours: fp.otHours,
      mfPay,
      otPay,
      // HSL weekend carve-out — present on snapshots since 2026-07-30; older
      // ones (and non-HSL rows) render the classic two-line stub.
      weekend:
        fp.weekendRegularHours != null
          ? {
              regularHours: fp.weekendRegularHours,
              otHours: fp.weekendOtHours ?? 0,
              regularPay: round2(fp.weekendRegularPay ?? 0),
              otPay: round2(fp.weekendOtPay ?? 0),
            }
          : null,
      // Mid-week proration — snapshots since 2026-07-30; older ones render classic.
      proration: fp.proration ?? null,
      pab: round2(fp.perfectAttendanceBonus as number),
      tech: round2(fp.techBonus as number),
      performanceBonus: round2(fp.otherBonuses as number),
      adjustment: round2(typeof fp.adjustment === "number" ? fp.adjustment : 0),
      adjustmentNote: disc.adjustmentNote,
      orphanagePay: round2(typeof fp.orphanagePay === "number" ? fp.orphanagePay : 0),
      mesaDeduction: round2(typeof fp.mesaDeduction === "number" ? fp.mesaDeduction : 0),
      mesaDisbursement: round2(typeof fp.mesaDisbursement === "number" ? fp.mesaDisbursement : 0),
      totalPayPhp: round2(fp.final),
      fxRate,
    });
    return { sourceFile: params.sourceFile, paidAt: params.paidAt, payDate: payDate(), view };
  }

  // ── SLOW PATH: engine needed for the split (old snapshot) or the whole week ──
  let result: CurrentPayResult | null = null;
  try {
    result = await computeCurrentPay({ sourceFile: params.sourceFile });
  } catch {
    result = null;
  }
  let entry: CurrentPayEntry | undefined;
  if (result) {
    for (const e of params.emails) {
      entry = result.byEmail[e];
      if (entry) break;
    }
  }

  // Not in this week unless the caller logged hours OR the wizard published a figure.
  if ((!entry || entry.totalHours <= 0) && !fp) return null;

  const fxRate =
    result && result.fxRate > 0
      ? result.fxRate
      : disc.fxRate && disc.fxRate > 0
        ? disc.fxRate
        : params.fallbackFxRate;
  if (result?.period.start) weekStart = result.period.start;
  if (result?.period.end) weekEnd = result.period.end;

  // Does this employee have a PH rate this week? The wizard drops the Adjustment
  // and Orphanage overlays for no-rate employees, so mirror that gate.
  const hasRate = entry ? entry.hasRate : fp ? fp.final !== 0 : false;

  let regularHours: number;
  let otHours: number;
  let mfPay: number;
  let otPay: number;
  let initial: number;
  let pab: number;
  let tech: number;
  let performanceBonus: number;
  let adjustment: number;
  let orphanage: number;
  let mesaDeduction: number;
  let mesaDisbursement: number;
  let totalPayPhp: number;

  if (fp) {
    // Old snapshot: exact total + base pay + MESA, but the bonus split isn't stored.
    regularHours = fp.regularHours;
    otHours = fp.otHours;
    mfPay = round2(fp.regularPay ?? entry?.regularPayPHP ?? 0);
    otPay = round2(fp.otPay ?? entry?.otPayPHP ?? 0);
    initial = round2(fp.initial ?? mfPay + otPay);
    mesaDeduction = round2(
      typeof fp.mesaDeduction === "number" ? fp.mesaDeduction : entry?.mesaDeductionPHP ?? 0,
    );
    mesaDisbursement = round2(typeof fp.mesaDisbursement === "number" ? fp.mesaDisbursement : 0);
    totalPayPhp = round2(fp.final);

    // Distribute the exact bonus pool so adjustment + pab + tech + performance ==
    // pool; the itemized lines then sum EXACTLY to fp.final − orphanage and can
    // never overstate the total.
    adjustment = hasRate ? disc.adjustment : 0;
    orphanage = hasRate ? disc.orphanage : 0;
    let pool = round2(fp.final - initial + mesaDeduction - mesaDisbursement - orphanage);
    // Negative pool = recovered deductions too low for this older snapshot (e.g. a
    // ₱100 MESA contribution the member has since opted out of). Fold it back into
    // the deduction so the stub reconciles instead of the earnings exceeding it.
    if (pool < 0) {
      mesaDeduction = round2(mesaDeduction - pool);
      pool = 0;
    }
    if (adjustment > pool) adjustment = pool;
    let remaining = round2(pool - adjustment);
    pab = Math.min(round2(entry?.pabBonusPHP ?? 0), remaining);
    remaining = round2(remaining - pab);
    tech = Math.min(round2(entry?.techBonusPHP ?? 0), remaining);
    remaining = round2(remaining - tech);
    performanceBonus = remaining < 0 ? 0 : remaining;
  } else {
    // No snapshot at all: best-effort from hours; overlays gated on a PH rate.
    regularHours = entry?.regularHours ?? 0;
    otHours = entry?.otHours ?? 0;
    mfPay = round2(entry?.regularPayPHP ?? 0);
    otPay = round2(entry?.otPayPHP ?? 0);
    initial = round2(entry?.initialPayPHP ?? mfPay + otPay);
    pab = round2(entry?.pabBonusPHP ?? 0);
    tech = round2(entry?.techBonusPHP ?? 0);
    mesaDeduction = round2(entry?.mesaDeductionPHP ?? 0);
    mesaDisbursement = 0;
    adjustment = hasRate ? disc.adjustment : 0;
    orphanage = hasRate ? disc.orphanage : 0;
    performanceBonus = 0;
    totalPayPhp = round2(
      initial + pab + tech + adjustment + orphanage - mesaDeduction + mesaDisbursement,
    );
  }

  const view = buildView({
    name: params.name,
    department: params.department,
    weekStart,
    weekEnd,
    regularHours,
    otHours,
    mfPay,
    otPay,
    pab,
    tech,
    performanceBonus,
    adjustment,
    adjustmentNote: disc.adjustmentNote,
    orphanagePay: orphanage,
    mesaDeduction,
    mesaDisbursement,
    totalPayPhp,
    fxRate,
  });
  return { sourceFile: params.sourceFile, paidAt: params.paidAt, payDate: payDate(), view };
}

/** The caller's own emails (session + master work/personal + gsuite alternates),
 *  normalized + unique. The wizard's snapshot + additions blob (and Hubstaff rows)
 *  can be keyed on ANY of a person's addresses, so include them all. */
function callerEmails(
  sessionEmail: string,
  master:
    | {
        work_email?: string | null;
        personal_email?: string | null;
        alternate_work_email?: string | null;
        alternate_work_email_2?: string | null;
      }
    | null,
): string[] {
  const out = new Set<string>();
  const add = (e: string | null | undefined) => {
    const n = e ? normEmail(e) : null;
    if (n) out.add(n);
  };
  add(sessionEmail);
  add(master?.work_email);
  add(master?.personal_email);
  add(master?.alternate_work_email);
  add(master?.alternate_work_email_2);
  return [...out];
}

/**
 * For a COP-country payee (Colombian staff riding the PHP rails), returns a
 * decorator stamping the native COP equivalent onto stub views — the same
 * USD-anchor figure Payment Dispatch pays. Identity for everyone else, so the
 * rate read only happens for the people who need it.
 */
async function copDecoratorForEmails(
  emails: Array<string | null | undefined>,
): Promise<(v: PayStubView) => PayStubView> {
  const cur = await resolveCountryCurrencyForEmails(emails);
  if (cur !== "COP") return (v) => v;
  const rate = await getUsdToCopRate();
  return (v) => applyCopEquivalent(v, rate);
}

/** Latest paid sent_date per cycle (a cycle can have >1 dispatch row). */
function paidAtByFileFrom(
  dispatches: Array<{ status?: string | null; cycle_source_file?: string | null; sent_date?: string | null }>,
): Map<string, string | null> {
  const m = new Map<string, string | null>();
  for (const r of dispatches) {
    if (r.status === "paid" && r.cycle_source_file) {
      const prev = m.get(r.cycle_source_file);
      const next = r.sent_date ?? null;
      if (!m.has(r.cycle_source_file) || (next && (!prev || next > prev))) {
        m.set(r.cycle_source_file, next);
      }
    }
  }
  return m;
}

/**
 * Employee self-serve pay-stub reader. Always scoped to the CALLER's own pay via
 * the NextAuth session email — never a query param.
 *
 * Modes:
 *   • ?source_file=<file> → the full paystub for one week (drives the modal).
 *   • ?summary=1          → { stubs: [lightweight] } every week's total + dates,
 *                           WITHOUT the heavy engine (drives the paginated list).
 *   • ?all=1              → { stubs: [full view] } every week's full statement
 *                           (drives the PDF/XLSX export; heavier, on-demand).
 *   • (no params)         → { weeks } every PAID week the caller can open.
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
      return NextResponse.json({
        paystub,
        available: true,
        paidAt,
        payDate: resolvePayDateIso(paidAt, paystub.weekEnd, processor),
        status: paid ? "paid" : "issued",
      });
    }

    // 2) Pre-launch: recover an unlocked week from the wizard snapshot + hours.
    if (SHOW_UNPAID_STAGED_PAYSTUBS) {
      const recon = await reconstructStubForWeek({
        sourceFile,
        emails,
        name: master?.name ?? "",
        department: master?.department ?? "",
        paidAt,
        processor,
        fallbackFxRate: await currentFxRate(),
      });
      if (recon) {
        return NextResponse.json({
          paystub: copDecorate(recon.view),
          available: true,
          paidAt,
          payDate: recon.payDate,
          status: paid ? "paid" : "issued",
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

  /** View for one staged week in the list/export modes — same freshness rule as
   *  the single-week modal: paid → the frozen as-paid payload; unpaid → the
   *  staged payload with any newer wizard-snapshot figures merged over it, so
   *  the row total, the modal, and the PDF/XLSX export all agree. */
  const freshStagedView = (
    p: {
      cycle_source_file: string;
      recipient_email: string;
      payload: Record<string, unknown> | null;
      pay_period: Record<string, unknown> | null;
      locked_at: string | null;
      excluded: boolean;
    },
    isPaid: boolean,
    snaps: Record<string, { value: string; updatedAt: string | null }>,
  ): PayStubView => {
    if (isPaid) return mapPayloadToPayStub(p.payload, p.pay_period);
    const snap = snaps[finalPaySnapshotKey(p.cycle_source_file)];
    const payloadEmail =
      p.payload && typeof p.payload.email === "string" ? p.payload.email : null;
    const claim = catalogClaimForEmails(catalogClaims, [p.recipient_email, payloadEmail]);
    const merged = mergeSnapshotIntoStaged(p, snap?.value ?? null, snap?.updatedAt ?? null, claim);
    return mapPayloadToPayStub(merged.payload, merged.payPeriod);
  };

  // ── Summary mode: lightweight per-week rows for the paginated list ─────────
  // Totals come from the staged payload or the wizard `final_pay` snapshot with
  // NO per-week `computeCurrentPay` — the slow engine runs ONLY for weeks that
  // have neither (oldest, pre-snapshot weeks). This is the fast path the tab uses.
  if (wantSummary) {
    const [{ rows: dispatches }, { rows: payloads }, { employee: master }, allFiles, fxFallback] =
      await Promise.all([
        listPaymentDispatches({ recipientEmail: email }),
        listPaystubPayloadsForEmployee(email),
        getEmployeeMasterRecord(email),
        listAllSourceFiles(),
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
      const others = allFiles.filter((f) => !stagedFiles.has(f));
      const snapshots = await loadFinalPayForWeeks(others, emails);
      const needEngine: string[] = [];
      for (const f of others) {
        const snap = snapshots.get(f) ?? { finalPay: null, fxRate: null };
        const fp = snap.finalPay;
        if (!fp) {
          needEngine.push(f);
          continue;
        }
        const range = parseDateRangeFromFilename(f);
        const weekStart = range ? fmtIso(range.start) : null;
        const weekEnd = range ? fmtIso(range.end) : null;
        const fx = snap.fxRate && snap.fxRate > 0 ? snap.fxRate : fxFallback;
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
      // Only weeks with neither a staged payload nor a snapshot need the engine.
      const heavy = await mapWithConcurrency(needEngine, 6, (f) =>
        reconstructStubForWeek({
          sourceFile: f,
          emails,
          name: master?.name ?? "",
          department: master?.department ?? "",
          paidAt: paidAtByFile.get(f) ?? null,
          processor,
          fallbackFxRate: fxFallback,
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
    return NextResponse.json({ stubs: rows });
  }

  // ── All-weeks mode: full statements for every week (drives the export) ─────
  if (wantAll) {
    const [{ rows: dispatches }, { rows: payloads }] = await Promise.all([
      listPaymentDispatches({ recipientEmail: email }),
      listPaystubPayloadsForEmployee(email),
    ]);
    const paidAtByFile = paidAtByFileFrom(dispatches);

    const staged = payloads.filter(
      (p) => p.payload && (SHOW_UNPAID_STAGED_PAYSTUBS || paidAtByFile.has(p.cycle_source_file)),
    );
    const stagedFiles = new Set(staged.map((p) => p.cycle_source_file));

    const [{ employee: master }, fxFallback] = await Promise.all([
      getEmployeeMasterRecord(email),
      currentFxRate(),
    ]);
    const emails = callerEmails(email, master);
    const [processor, copDecorate] = await Promise.all([
      resolveEmployeeProcessor(emails),
      copDecoratorForEmails(emails),
    ]);

    // Same freshness rule as the summary list — unpaid rows merge in any newer
    // wizard-snapshot figures so the export matches the modal and the list.
    const unpaidSnaps = await getAppSettingsWithMeta(
      staged
        .filter((p) => !paidAtByFile.has(p.cycle_source_file))
        .map((p) => finalPaySnapshotKey(p.cycle_source_file)),
    );
    const officialStubs: EmployeePayStub[] = staged.map((p) => {
      const pAt = paidAtByFile.get(p.cycle_source_file) ?? null;
      const view = freshStagedView(p, pAt != null, unpaidSnaps);
      return {
        sourceFile: p.cycle_source_file,
        paidAt: pAt,
        payDate: resolvePayDateIso(pAt, view.weekEnd, processor),
        view,
      };
    });

    let recoveredStubs: EmployeePayStub[] = [];
    if (SHOW_UNPAID_STAGED_PAYSTUBS) {
      const allFiles = await listAllSourceFiles();
      const toRecover = allFiles.filter((f) => !stagedFiles.has(f));
      const recovered = await mapWithConcurrency(toRecover, 6, (file) =>
        reconstructStubForWeek({
          sourceFile: file,
          emails,
          name: master?.name ?? "",
          department: master?.department ?? "",
          paidAt: paidAtByFile.get(file) ?? null,
          processor,
          fallbackFxRate: fxFallback,
        }),
      );
      recoveredStubs = recovered.filter((s): s is EmployeePayStub => s !== null);
    }

    const stubs = [...officialStubs, ...recoveredStubs]
      .map((s) => ({ ...s, view: copDecorate(s.view) }))
      .sort((a, b) => (b.view.weekEnd ?? "").localeCompare(a.view.weekEnd ?? ""));
    return NextResponse.json({ stubs });
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
