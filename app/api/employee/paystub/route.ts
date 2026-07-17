import { NextRequest, NextResponse } from "next/server";
import { getServerSession } from "next-auth/next";
import { authOptions } from "@/lib/auth/auth-options";
import { listPaymentDispatches } from "@/lib/supabase/payment-dispatches";
import {
  getPaystubDispatchEntry,
  listPaystubEntriesForEmployee,
  listPaystubPayloadsForEmployee,
} from "@/lib/supabase/paystub-dispatch-queue";
import { mapPayloadToPayStub, formatWeekHuman, type PayStubView } from "@/lib/payroll/paystub-view";
import { computeCurrentPay, type CurrentPayEntry } from "@/lib/payroll/current-pay";
import { getEmployeeMasterRecord } from "@/lib/supabase/employees";
import { listHubstaffUploads, getUploadedSourceFiles } from "@/lib/supabase/hubstaff-hours-db";
import { normEmail } from "@/lib/email/norm-email";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

/**
 * TEMPORARY — until the HRIS payroll flow is the system of record.
 *
 * Pre-launch, the `payment_dispatches` "paid" mark isn't reliably set, so gating
 * pay stubs on a PAID dispatch would hide most (or all) of an employee's weeks.
 * While this is `true`, the Pay Stubs profile tab + its per-week modal surface
 * EVERY staged statement for the caller (paid or not). Flip back to `false` at
 * HRIS launch to restore the strict paid-only rule.
 *
 * Scope: the Pay Stubs tab paths only (`?all=1` + `?source_file=`). The Overview
 * quick-button (`{ weeks }` mode) stays deliberately paid-only.
 */
const SHOW_UNPAID_STAGED_PAYSTUBS = true;

/** One employee-facing stub: a rendered statement + its provenance flags. */
interface EmployeePayStub {
  sourceFile: string;
  paidAt: string | null;
  /** True when reconstructed from hours (not locked through the wizard) — its
   *  discretionary bonuses/adjustments/MESA reimbursements are unknown (0). */
  estimated: boolean;
  view: PayStubView;
}

/** Run `fn` over `items` with at most `limit` in flight — keeps the pay
 *  reconstruction from firing one heavy `computeCurrentPay` per week all at once. */
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

/**
 * Reconstruct one week's stub for `emails` from raw hours, for a week that was
 * never locked through the Payroll Wizard. Uses `computeCurrentPay` (the same
 * deterministic engine payroll runs on) so regular/OT pay, PAB + Tech bonuses,
 * the MESA deduction, FX and net all match a real run. Discretionary items
 * (performance/other bonuses, manual adjustments, MESA reimbursements) are NOT
 * recoverable for an unlocked week and stay 0 — hence `estimated: true`. Returns
 * null when the employee had no hours that week (they simply aren't in it).
 */
async function reconstructStubForWeek(params: {
  sourceFile: string;
  emails: string[];
  name: string;
  department: string;
}): Promise<EmployeePayStub | null> {
  let result;
  try {
    result = await computeCurrentPay({ sourceFile: params.sourceFile });
  } catch {
    return null;
  }
  let entry: CurrentPayEntry | undefined;
  for (const e of params.emails) {
    entry = result.byEmail[e];
    if (entry) break;
  }
  if (!entry || entry.totalHours <= 0) return null;

  const weekStart = result.period.start;
  const weekEnd = result.period.end;
  const fxRate = result.fxRate > 0 ? result.fxRate : 58;
  const mfPay = entry.regularPayPHP ?? 0;
  const otPay = entry.otPayPHP ?? 0;
  const totalPayPhp = entry.totalPayPHP ?? 0;
  const round2 = (n: number) => Math.round(n * 100) / 100;

  const view: PayStubView = {
    name: params.name || "—",
    department: params.department || "—",
    weekStart,
    weekEnd,
    weekHuman: formatWeekHuman(weekStart, weekEnd),
    salaryDate: null,
    mfHours: entry.regularHours,
    mfOtHours: entry.otHours,
    // Effective rate paid this week (pay ÷ hours) — matches the "h × rate" line.
    mfRate: entry.regularHours > 0 ? round2(mfPay / entry.regularHours) : 0,
    otRate: entry.otHours > 0 ? round2(otPay / entry.otHours) : 0,
    mfPay,
    otPay,
    techBonus: entry.techBonusPHP,
    attendanceBonus: entry.pabBonusPHP,
    performanceBonus: 0,
    adjustment: 0,
    adjustmentNote: null,
    mesaDisbursement: 0,
    mesaDeduction: entry.mesaDeductionPHP,
    totalPayPhp,
    fxRate,
    totalPayUsd: entry.totalPayUSD ?? round2(totalPayPhp / fxRate),
  };
  return { sourceFile: params.sourceFile, paidAt: null, estimated: true, view };
}

/** The caller's own emails (session + master work/personal), normalized + unique.
 *  `computeCurrentPay` keys entries by lowercased work_email. */
function callerEmails(
  sessionEmail: string,
  master: { work_email?: string | null; personal_email?: string | null } | null,
): string[] {
  const out = new Set<string>();
  const add = (e: string | null | undefined) => {
    const n = e ? normEmail(e) : null;
    if (n) out.add(n);
  };
  add(sessionEmail);
  add(master?.work_email);
  add(master?.personal_email);
  return [...out];
}

/**
 * Employee self-serve pay-stub reader. Always scoped to the CALLER's own pay via
 * the NextAuth session email — never a query param — so one employee can't read
 * another's statement.
 *
 * Three modes:
 *   • ?source_file=<file>  → the full paystub for that week (drives the modal).
 *   • ?all=1               → { stubs: [{ sourceFile, paidAt, view }] } every
 *                            staged week's full statement (drives the Pay Stubs
 *                            profile tab's list + all-weeks PDF/XLSX export).
 *   • (no params)          → { weeks: [...] } every PAID week the caller can open
 *                            (drives the Overview button's enabled state).
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

    // 1) Prefer a locked/staged payload — byte-identical to the emailed stub and
    //    it carries the discretionary items an estimate can't. Pre-launch we
    //    render any staged week; post-launch, paid weeks only.
    const { row: staged } = await getPaystubDispatchEntry(sourceFile, email);
    if (staged?.payload && (SHOW_UNPAID_STAGED_PAYSTUBS || paid)) {
      const paystub = mapPayloadToPayStub(staged.payload, staged.pay_period);
      return NextResponse.json({
        paystub,
        available: true,
        paidAt: paid?.sent_date ?? null,
        status: paid ? "paid" : "issued",
        estimated: false,
      });
    }

    // 2) Pre-launch: reconstruct an unlocked week from hours so "View" works on
    //    every listed week. (Post-launch this stays paid-only → unavailable.)
    if (SHOW_UNPAID_STAGED_PAYSTUBS) {
      const { employee: master } = await getEmployeeMasterRecord(email);
      const recon = await reconstructStubForWeek({
        sourceFile,
        emails: callerEmails(email, master),
        name: master?.name ?? "",
        department: master?.department ?? "",
      });
      if (recon) {
        return NextResponse.json({
          paystub: recon.view,
          available: true,
          paidAt: null,
          status: "estimate",
          estimated: true,
        });
      }
    }

    return NextResponse.json({ paystub: null, available: false, paidAt: null });
  }

  // ── All-weeks mode: a stub for every week ─────────────────────────────────
  // Drives the Pay Stubs profile tab (list + PDF/XLSX export). Locked/staged
  // weeks render exact ("official"); pre-launch, every OTHER Hubstaff upload the
  // caller worked is reconstructed from hours and flagged `estimated`. Post-HRIS
  // launch (SHOW_UNPAID_STAGED_PAYSTUBS=false) it narrows to the paid ∩ staged
  // set — no reconstruction. `paidAt` is the paid dispatch date, else null.
  if (req.nextUrl.searchParams.get("all")) {
    const [{ rows: dispatches }, { rows: payloads }] = await Promise.all([
      listPaymentDispatches({ recipientEmail: email }),
      listPaystubPayloadsForEmployee(email),
    ]);

    // Latest paid sent_date per cycle (a cycle can have >1 dispatch row).
    const paidAtByFile = new Map<string, string | null>();
    for (const r of dispatches) {
      if (r.status === "paid" && r.cycle_source_file) {
        const prev = paidAtByFile.get(r.cycle_source_file);
        const next = r.sent_date ?? null;
        if (!paidAtByFile.has(r.cycle_source_file) || (next && (!prev || next > prev))) {
          paidAtByFile.set(r.cycle_source_file, next);
        }
      }
    }

    // Locked/staged weeks — the source of truth. Pre-launch: all; post: paid only.
    const staged = payloads.filter(
      (p) => p.payload && (SHOW_UNPAID_STAGED_PAYSTUBS || paidAtByFile.has(p.cycle_source_file)),
    );
    const stagedFiles = new Set(staged.map((p) => p.cycle_source_file));
    const officialStubs: EmployeePayStub[] = staged.map((p) => ({
      sourceFile: p.cycle_source_file,
      paidAt: paidAtByFile.get(p.cycle_source_file) ?? null,
      estimated: false,
      view: mapPayloadToPayStub(p.payload, p.pay_period),
    }));

    // Pre-launch: backfill every OTHER uploaded week from hours (estimates).
    let estimatedStubs: EmployeePayStub[] = [];
    if (SHOW_UNPAID_STAGED_PAYSTUBS) {
      const [{ employee: master }, allFiles] = await Promise.all([
        getEmployeeMasterRecord(email),
        listAllSourceFiles(),
      ]);
      const emails = callerEmails(email, master);
      const toReconstruct = allFiles.filter((f) => !stagedFiles.has(f));
      const reconstructed = await mapWithConcurrency(toReconstruct, 6, (file) =>
        reconstructStubForWeek({
          sourceFile: file,
          emails,
          name: master?.name ?? "",
          department: master?.department ?? "",
        }),
      );
      estimatedStubs = reconstructed.filter((s): s is EmployeePayStub => s !== null);
    }

    const stubs = [...officialStubs, ...estimatedStubs].sort((a, b) =>
      (b.view.weekEnd ?? "").localeCompare(a.view.weekEnd ?? ""),
    );

    return NextResponse.json({ stubs });
  }

  // ── List mode: which weeks can this employee open? ────────────────────────
  const [{ rows: dispatches }, { rows: staged }] = await Promise.all([
    listPaymentDispatches({ recipientEmail: email }),
    listPaystubEntriesForEmployee(email),
  ]);

  const paidFiles = new Set(
    dispatches
      .filter((r) => r.status === "paid" && r.cycle_source_file)
      .map((r) => r.cycle_source_file as string),
  );
  const stagedFiles = new Set(staged.map((r) => r.cycle_source_file));
  const weeks = [...paidFiles].filter((f) => stagedFiles.has(f));

  return NextResponse.json({ weeks });
}
