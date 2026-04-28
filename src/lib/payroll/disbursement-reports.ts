/**
 * Reads weekly disbursement reports from `public.disbursement_records` —
 * one row per (week, employee) — and joins upload metadata from
 * `hubstaff_uploads` plus full dispatch detail from `payment_dispatches`.
 *
 * The flat `disbursement_records` table is seeded by
 * `references/seed_disbursement_records.sql` and kept in sync with
 * `payment_dispatches` by the trigger in
 * `references/seed_disbursement_records_sync.sql`.
 */
import {
  createSupabaseServerClient,
  createSupabaseServiceRoleClient,
} from "@/lib/supabase/server";
import { listHubstaffUploads } from "@/lib/supabase/hubstaff-hours-db";
import { parseDateRangeFromFilename } from "@/lib/hubstaff/calendar-column-dedupe";
import { processorIdFromBankPreferred } from "@/components/payroll-clerk/mock-queue";
import type {
  PaymentDispatchRow,
  PaymentDispatchStatus,
} from "@/lib/supabase/payment-dispatches";

/** One row in `public.disbursement_records`. */
interface DisbursementRecordRow {
  id: string;
  cycle_period_start: string;
  cycle_period_end: string;
  source_file: string;
  upload_id: string | null;
  recipient_email: string;
  recipient_name: string | null;
  total_hours: number | string;
  regular_hours: number | string;
  ot_hours: number | string;
  regular_rate_php: number | string | null;
  ot_rate_php: number | string | null;
  amount_php: number | string | null;
  amount_usd: number | string | null;
  fx_rate: number | string | null;
  status: PaymentDispatchStatus | "pending";
  paid_amount_usd: number | string | null;
  paid_at: string | null;
  bank_used: string | null;
  transaction_id: string | null;
  dispatch_id: string | null;
}

function num(v: number | string | null | undefined): number {
  if (v == null) return 0;
  if (typeof v === "number") return v;
  const n = parseFloat(v);
  return Number.isFinite(n) ? n : 0;
}

export interface DisbursementReportTotals {
  paidCount: number;
  paidUSD: number;
  paidPHP: number;
  notPaidCount: number;
  thresholdCount: number;
  problemCount: number;
  /** Sum across rows whose status != 'paid' (still owed / blocked). */
  pendingDispatchedUSD: number;
  /** Total dispatch records, regardless of status. */
  sentCount: number;
  /** Total USD across every dispatch (paid + non-paid). */
  totalDispatchedUSD: number;
  /** Recipients with no dispatch row yet — status='pending'. */
  outstandingCount: number;
  /** Total USD owed for status='pending' rows. */
  outstandingUSD: number;
  /** Recipients in this cycle (paid + pending + blocked). */
  totalRecipients: number;
  /** Total USD owed for the entire cycle (snapshot from disbursement_records). */
  totalOwedUSD: number;
}

export interface DisbursementReportSummary {
  cycleId: string;
  /** ISO YYYY-MM-DD or null when no dispatches and not the current cycle. */
  periodStart: string | null;
  periodEnd: string | null;
  sourceFile: string | null;
  /** When the Hubstaff CSV was uploaded. */
  uploadedAt: string;
  uploadedBy: string | null;
  rowCount: number | null;
  isCurrent: boolean;
  /** "April 12-18, 2026" */
  reportName: string;
  totals: DisbursementReportTotals;
  /** Per-processor breakdown of paid amounts. */
  byProcessor: Record<string, { count: number; usd: number }>;
}

export interface DisbursementReportDetail extends DisbursementReportSummary {
  dispatches: PaymentDispatchRow[];
  /**
   * For the *current* cycle only — recipients who are eligible for pay but
   * have no dispatch row yet. Empty array for past cycles.
   */
  outstanding: Array<{
    email: string;
    amountUSD: number | null;
    amountPHP: number | null;
  }>;
  /** Total USD still owed for outstanding (not-yet-dispatched) recipients. */
  outstandingUSD: number;
}

const EMPTY_TOTALS = (): DisbursementReportTotals => ({
  paidCount: 0,
  paidUSD: 0,
  paidPHP: 0,
  notPaidCount: 0,
  thresholdCount: 0,
  problemCount: 0,
  pendingDispatchedUSD: 0,
  sentCount: 0,
  totalDispatchedUSD: 0,
  outstandingCount: 0,
  outstandingUSD: 0,
  totalRecipients: 0,
  totalOwedUSD: 0,
});

function tallyRecord(
  totals: DisbursementReportTotals,
  r: DisbursementRecordRow,
): void {
  totals.totalRecipients += 1;
  const owedUSD = num(r.amount_usd);
  totals.totalOwedUSD += owedUSD;

  switch (r.status) {
    case "paid": {
      const paidUSD = num(r.paid_amount_usd) || owedUSD;
      totals.paidCount += 1;
      totals.paidUSD += paidUSD;
      totals.paidPHP += num(r.amount_php);
      totals.sentCount += 1;
      totals.totalDispatchedUSD += paidUSD;
      break;
    }
    case "not_paid":
      totals.notPaidCount += 1;
      totals.pendingDispatchedUSD += owedUSD;
      totals.sentCount += 1;
      totals.totalDispatchedUSD += owedUSD;
      break;
    case "threshold":
      totals.thresholdCount += 1;
      totals.pendingDispatchedUSD += owedUSD;
      totals.sentCount += 1;
      totals.totalDispatchedUSD += owedUSD;
      break;
    case "problem":
      totals.problemCount += 1;
      totals.pendingDispatchedUSD += owedUSD;
      totals.sentCount += 1;
      totals.totalDispatchedUSD += owedUSD;
      break;
    default: // 'pending'
      totals.outstandingCount += 1;
      totals.outstandingUSD += owedUSD;
      break;
  }
}

const MONTH_LONG = [
  "January",
  "February",
  "March",
  "April",
  "May",
  "June",
  "July",
  "August",
  "September",
  "October",
  "November",
  "December",
];

function parseISODate(iso: string): Date | null {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(iso);
  if (!m) return null;
  const d = new Date(Date.UTC(+m[1], +m[2] - 1, +m[3]));
  return Number.isNaN(d.getTime()) ? null : d;
}

/**
 * "April 12-18, 2026" — same-month range.
 * "April 30 - May 3, 2026" — month boundary.
 * "December 30, 2025 - January 5, 2026" — year boundary.
 */
export function formatDisbursementReportName(
  start: string | null,
  end: string | null,
  fallback: string,
): string {
  if (!start || !end) return fallback;
  const s = parseISODate(start);
  const e = parseISODate(end);
  if (!s || !e) return fallback;
  const sm = MONTH_LONG[s.getUTCMonth()];
  const em = MONTH_LONG[e.getUTCMonth()];
  const sd = s.getUTCDate();
  const ed = e.getUTCDate();
  const sy = s.getUTCFullYear();
  const ey = e.getUTCFullYear();
  if (sy === ey && sm === em) {
    return `${sm} ${sd}-${ed}, ${ey}`;
  }
  if (sy === ey) {
    return `${sm} ${sd} - ${em} ${ed}, ${ey}`;
  }
  return `${sm} ${sd}, ${sy} - ${em} ${ed}, ${ey}`;
}

/** Pad a numeric month/day to 2 digits, no timezone math. */
function pad2(n: number): string {
  return String(n).padStart(2, "0");
}

/**
 * Pull period dates directly from the Hubstaff CSV filename. Hubstaff's
 * weekly export is named `simple-biz_daily_report_YYYY-MM-DD_to_YYYY-MM-DD.csv`
 * so the dates are already there — no row scan needed.
 */
function periodFromFilename(
  sourceFile: string | null,
): { start: string | null; end: string | null } {
  if (!sourceFile) return { start: null, end: null };
  const range = parseDateRangeFromFilename(sourceFile);
  if (!range) return { start: null, end: null };
  return {
    start: `${range.start.getFullYear()}-${pad2(range.start.getMonth() + 1)}-${pad2(range.start.getDate())}`,
    end: `${range.end.getFullYear()}-${pad2(range.end.getMonth() + 1)}-${pad2(range.end.getDate())}`,
  };
}

type UploadRowShape = {
  id: string;
  source_file: string | null;
  uploaded_at: string;
  uploaded_by: string | null;
  row_count: number | null;
  is_current: boolean;
};

/** Pages through `disbursement_records` (Supabase has a 1k default cap). */
async function loadAllDisbursementRecords(): Promise<DisbursementRecordRow[]> {
  const supabase = createSupabaseServiceRoleClient() ?? createSupabaseServerClient();
  if (!supabase) return [];
  const PAGE = 1000;
  const out: DisbursementRecordRow[] = [];
  let from = 0;
  while (true) {
    const { data, error } = await supabase
      .from("disbursement_records")
      .select("*")
      .order("cycle_period_start", { ascending: false })
      .range(from, from + PAGE - 1);
    if (error) throw new Error(error.message);
    const page = (data ?? []) as DisbursementRecordRow[];
    out.push(...page);
    if (page.length < PAGE) break;
    from += PAGE;
  }
  return out;
}

/** Loads `hubstaff_uploads` for upload metadata (uploaded_at, is_current, …). */
async function safeListHubstaffUploads(): Promise<UploadRowShape[]> {
  try {
    return await listHubstaffUploads();
  } catch (e) {
    console.warn("[disbursement-reports] listHubstaffUploads failed:", e);
    return [];
  }
}

/**
 * Builds a `email → processor` map from `employee_hourly_rates."Bank Preferred"`.
 * Used to derive the byProcessor breakdown from disbursement_records when no
 * payment_dispatches row exists yet (e.g. when paid status was set via direct
 * UPDATE rather than the Mark Paid flow).
 */
async function loadProcessorByEmail(): Promise<Map<string, string>> {
  const supabase = createSupabaseServiceRoleClient() ?? createSupabaseServerClient();
  const out = new Map<string, string>();
  if (!supabase) return out;
  const { data, error } = await supabase
    .from("employee_hourly_rates")
    .select('"Work Email", "Personal Email", "Bank Preferred"');
  if (error) {
    console.warn("[disbursement-reports] loadProcessorByEmail failed:", error);
    return out;
  }
  for (const r of (data ?? []) as Array<{
    "Work Email": string | null;
    "Personal Email": string | null;
    "Bank Preferred": string | null;
  }>) {
    const proc = processorIdFromBankPreferred(r["Bank Preferred"]);
    if (!proc) continue;
    const we = r["Work Email"]?.trim().toLowerCase();
    const pe = r["Personal Email"]?.trim().toLowerCase();
    if (we) out.set(we, proc);
    if (pe && !out.has(pe)) out.set(pe, proc);
  }
  return out;
}

export async function listDisbursementReports(): Promise<{
  reports: DisbursementReportSummary[];
  error: string | null;
}> {
  let records: DisbursementRecordRow[];
  try {
    records = await loadAllDisbursementRecords();
  } catch (e) {
    return {
      reports: [],
      error: e instanceof Error ? e.message : "Failed to load disbursement_records",
    };
  }

  const [uploads, processorByEmail] = await Promise.all([
    safeListHubstaffUploads(),
    loadProcessorByEmail(),
  ]);

  // Index uploads by both id and source_file so we can attach metadata.
  const uploadById = new Map<string, UploadRowShape>();
  const uploadBySource = new Map<string, UploadRowShape>();
  for (const u of uploads) {
    uploadById.set(u.id, u);
    if (u.source_file) uploadBySource.set(u.source_file, u);
  }

  // Group disbursement_records by source_file (each cycle). byProcessor is
  // tallied inline against the same loop, deriving processor from the
  // recipient's "Bank Preferred" so the breakdown survives even when paid
  // status was set via direct UPDATE rather than Mark Paid.
  type Bucket = {
    sourceFile: string;
    periodStart: string;
    periodEnd: string;
    uploadId: string | null;
    totals: DisbursementReportTotals;
    byProcessor: Record<string, { count: number; usd: number }>;
  };
  const buckets = new Map<string, Bucket>();
  for (const r of records) {
    if (!r.source_file) continue;
    let bucket = buckets.get(r.source_file);
    if (!bucket) {
      bucket = {
        sourceFile: r.source_file,
        periodStart: r.cycle_period_start,
        periodEnd: r.cycle_period_end,
        uploadId: r.upload_id,
        totals: EMPTY_TOTALS(),
        byProcessor: {},
      };
      buckets.set(r.source_file, bucket);
    }
    tallyRecord(bucket.totals, r);

    if (r.status === "paid") {
      const proc = processorByEmail.get(r.recipient_email.trim().toLowerCase()) ?? "unknown";
      const acc = bucket.byProcessor[proc] ?? { count: 0, usd: 0 };
      acc.count += 1;
      acc.usd += num(r.paid_amount_usd) || num(r.amount_usd);
      bucket.byProcessor[proc] = acc;
    }
  }

  const reports: DisbursementReportSummary[] = [];
  for (const bucket of buckets.values()) {
    // Prefer an upload row for upload metadata; fall back to source_file lookup.
    const upload =
      (bucket.uploadId ? uploadById.get(bucket.uploadId) : null) ??
      uploadBySource.get(bucket.sourceFile) ??
      null;

    // Period-resolution chain:
    //   1. disbursement_records (already DATE-typed).
    //   2. Filename parser as a sanity backup if the row is malformed.
    let periodStart: string | null = bucket.periodStart || null;
    let periodEnd: string | null = bucket.periodEnd || null;
    if (!periodStart || !periodEnd) {
      const fromName = periodFromFilename(bucket.sourceFile);
      periodStart = periodStart ?? fromName.start;
      periodEnd = periodEnd ?? fromName.end;
    }

    const fallbackName = bucket.sourceFile.replace(/\.csv$/i, "");
    const reportName = formatDisbursementReportName(periodStart, periodEnd, fallbackName);

    reports.push({
      cycleId: upload?.id ?? bucket.uploadId ?? `source:${bucket.sourceFile}`,
      periodStart,
      periodEnd,
      sourceFile: bucket.sourceFile,
      uploadedAt: upload?.uploaded_at ?? new Date().toISOString(),
      uploadedBy: upload?.uploaded_by ?? null,
      rowCount: upload?.row_count ?? bucket.totals.totalRecipients,
      isCurrent: upload?.is_current ?? false,
      reportName,
      totals: bucket.totals,
      byProcessor: bucket.byProcessor,
    });
  }

  // Newest period first.
  reports.sort((a, b) => (b.periodStart ?? "").localeCompare(a.periodStart ?? ""));

  return { reports, error: null };
}

/**
 * Detail view for a single cycle. Pulls:
 *   • Summary + outstanding from `disbursement_records`.
 *   • Full dispatch detail (with processor + banking) from
 *     `payment_dispatches` so the table can show what we sent.
 *
 * `cycleId` may be either a `hubstaff_uploads.id` (UUID) or a
 * `source:<filename>` synthetic id from the list endpoint.
 */
export async function getDisbursementReportDetail(
  cycleId: string,
): Promise<{ report: DisbursementReportDetail | null; error: string | null }> {
  const { reports, error } = await listDisbursementReports();
  if (error) return { report: null, error };
  const summary = reports.find((r) => r.cycleId === cycleId);
  if (!summary || !summary.sourceFile) {
    return { report: null, error: "Cycle not found" };
  }

  const supabase = createSupabaseServiceRoleClient() ?? createSupabaseServerClient();
  if (!supabase) {
    return {
      report: { ...summary, dispatches: [], outstanding: [], outstandingUSD: 0 },
      error: null,
    };
  }

  // Fetch dispatches + outstanding records in parallel.
  const [{ data: dispatchData, error: dErr }, { data: outstandingData, error: oErr }] =
    await Promise.all([
      supabase
        .from("payment_dispatches")
        .select("*")
        .eq("cycle_source_file", summary.sourceFile)
        .order("created_at", { ascending: false }),
      supabase
        .from("disbursement_records")
        .select("recipient_email, amount_usd, amount_php, status")
        .eq("source_file", summary.sourceFile)
        .eq("status", "pending")
        .order("amount_usd", { ascending: false, nullsFirst: false })
        .limit(500),
    ]);

  if (dErr) return { report: null, error: dErr.message };
  if (oErr) return { report: null, error: oErr.message };

  const dispatches = (dispatchData ?? []) as PaymentDispatchRow[];
  const outstanding = ((outstandingData ?? []) as Array<{
    recipient_email: string;
    amount_usd: number | string | null;
    amount_php: number | string | null;
  }>).map((r) => ({
    email: r.recipient_email,
    amountUSD: r.amount_usd == null ? null : num(r.amount_usd),
    amountPHP: r.amount_php == null ? null : num(r.amount_php),
  }));

  const outstandingUSD = outstanding.reduce((sum, r) => sum + (r.amountUSD ?? 0), 0);

  return {
    report: { ...summary, dispatches, outstanding, outstandingUSD },
    error: null,
  };
}
