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
import { collapseToSingleUploadBatch, listHubstaffUploads } from "@/lib/supabase/hubstaff-hours-db";
import {
  parseDateRangeFromFilename,
  payWeekFromUploadStart,
  resolveCanonicalColumnsToIso,
} from "@/lib/hubstaff/calendar-column-dedupe";
import { processorIdFromBankPreferred } from "@/components/payroll-clerk/mock-queue";
import { normEmail } from "@/lib/email/norm-email";
import { buildFxRates } from "@/lib/fx/currency-fx";
import { listPayStructures } from "@/lib/supabase/pay-structures-db";
import {
  buildCatalogRateIndex,
  resolveEmployeeCatalogRate,
  resolveDeptCatalogRate,
} from "@/lib/payroll/resolve-rate";
import { fetchAllRateHistory } from "@/lib/payroll/rate-history";
import { getEmployeeHourlyRatesRows } from "@/lib/supabase/employee-hourly-rates";
import { selectAllPaged } from "@/lib/supabase/select-all-paged";
import { computeProratedRowPay } from "@/lib/payroll/current-pay";
import { resolveHslWeekScope } from "@/lib/payroll/hsl-week-model";
import { fetchHslTransferEffectiveByEmail } from "@/lib/payroll/hsl-transfer-effective";
import { normalizeDeptToKey } from "@/lib/payroll/normalize-dept-key";
import {
  URGENT_SOURCE_FILE_PREFIX,
  isUrgentSourceFile,
  sundayWeekRange,
  urgentCycleSourceFile,
} from "@/lib/payroll/urgent-cycle";
import type {
  PaymentDispatchRow,
  PaymentDispatchStatus,
} from "@/lib/supabase/payment-dispatches";

/** One row in `public.disbursement_records`. */
export interface DisbursementRecordRow {
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

/** A single recipient who received pay this cycle. Surfaced on the report
 *  card so admins can see *who* was paid without having to drill in. */
export interface DisbursementReportRecipient {
  email: string;
  name: string | null;
  amountUSD: number;
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
  byProcessor: Record<string, { count: number; usd: number; php: number }>;
  /** Every recipient with status='paid' for this cycle, sorted by name. Used
   *  on the report card so admins can scan who actually got paid that week. */
  paidRecipients: DisbursementReportRecipient[];
}

/**
 * A Hubstaff upload that has hours data but no `disbursement_records` rows yet.
 * Since 2026-08-12 new uploads are seeded automatically at ingest time
 * (see the seed calls in /api/hubstaff-hours and run-weekly-sync), so this
 * surfaces only historical gaps.
 */
export interface UnseededUpload {
  /** hubstaff_uploads.id */
  id: string;
  sourceFile: string;
  periodStart: string | null;
  periodEnd: string | null;
  uploadedAt: string;
  uploadedBy: string | null;
  rowCount: number | null;
  /** Human-friendly cycle name, same formatter the report cards use. */
  reportName: string;
  /**
   * Whether {@link seedMissingDisbursementRecords} would actually process this
   * upload. Backfills, "(2)" re-uploads, the time-activity export, and non-weekly
   * ranges are counted-but-skipped — surfaced here (seedable=false) so the count
   * can't silently disagree with what "Seed all" does.
   */
  seedable: boolean;
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
/** Fetch every `disbursement_records` row tied to a single cycle's source CSV.
 *  Used by the per-report CSV export route. */
export async function loadDisbursementRecordsForCycle(
  sourceFile: string,
): Promise<DisbursementRecordRow[]> {
  const supabase = createSupabaseServiceRoleClient() ?? createSupabaseServerClient();
  if (!supabase) return [];
  const PAGE = 1000;
  const out: DisbursementRecordRow[] = [];
  let from = 0;
  while (true) {
    const { data, error } = await supabase
      .from("disbursement_records")
      .select("*")
      .eq("source_file", sourceFile)
      .order("recipient_email", { ascending: true })
      .range(from, from + PAGE - 1);
    if (error) throw new Error(error.message);
    const page = (data ?? []) as DisbursementRecordRow[];
    out.push(...page);
    if (page.length < PAGE) break;
    from += PAGE;
  }
  return out;
}

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
  const out = new Map<string, string>();
  // Hardened reader (dedup current-upload view + paginated fallback): the old
  // raw select on employee_hourly_rates returned 1,000 of 22,091 per-upload
  // rows — oldest uploads first — so the By-Processor breakdown attributed
  // most direct-UPDATE-paid recipients to no/stale processors.
  const { rows, error } = await getEmployeeHourlyRatesRows();
  if (error) {
    console.warn("[disbursement-reports] loadProcessorByEmail failed:", error);
    return out;
  }
  for (const r of rows) {
    const proc = processorIdFromBankPreferred(r.bank_preferred);
    if (!proc) continue;
    const we = r.work_email?.trim().toLowerCase();
    const pe = r.personal_email?.trim().toLowerCase();
    if (we) out.set(we, proc);
    if (pe && !out.has(pe)) out.set(pe, proc);
  }
  return out;
}

/**
 * Loads every "urgent" dispatch row, normalized to PaymentDispatchRow shape:
 *   • Real `payment_dispatches` tagged urgent by `cycle_source_file`
 *     (MESA disbursements + one-off People-tab payments).
 *   • Approved orphanage BUDGET REQUESTS paid via `orphanage_dispatches`
 *     (dispatch_type='budget_request'), synthesized into PaymentDispatchRow
 *     entries: processor='wires' (paid by wire to the orphanage bank), PHP→USD
 *     via the active FX rate, and bucketed into the Sun→Sat week they were sent
 *     (cycle_source_file = `urgent_<weekStart>_to_<weekEnd>`) so they merge into
 *     the same weekly bucket as MESA payouts. Gift purchases are NOT urgent and
 *     are excluded.
 * `buildUrgentWeeklyReports` (summary) consumes this.
 * Exported for /api/urgent-payments/dispatches, which shows the current week's
 * slice of the same rows inside the Payment Dispatch Urgent bucket — one loader
 * so the bucket's Paid/Not paid views can never disagree with the weekly report.
 */
export async function loadUrgentDispatchRows(): Promise<PaymentDispatchRow[]> {
  const supabase = createSupabaseServiceRoleClient() ?? createSupabaseServerClient();
  if (!supabase) return [];

  const rows: PaymentDispatchRow[] = [];

  // 1. Real urgent payment_dispatches (MESA + one-off), identified by the
  //    `urgent_` cycle_source_file prefix. NOT by cycle_id: that column is
  //    `uuid REFERENCES hubstaff_uploads(id)`, so the old `.eq("cycle_id","urgent")`
  //    made Postgres reject this query outright (22P02) and the discarded error
  //    left the weekly Urgent report silently empty. See @/lib/payroll/urgent-cycle.
  //
  //    `_` is a single-char wildcard in LIKE, so the server-side filter is a
  //    prefilter; isUrgentSourceFile re-checks it exactly.
  const { data: pd, error: pdErr } = await supabase
    .from("payment_dispatches")
    .select("*")
    .like("cycle_source_file", `${URGENT_SOURCE_FILE_PREFIX}%`)
    .order("created_at", { ascending: false });
  if (pdErr) {
    // Never swallow this again — an empty urgent report must not be indistinguishable
    // from a failed query.
    console.warn("[disbursement-reports] urgent payment_dispatches query failed:", pdErr.message);
  }
  rows.push(
    ...((pd ?? []) as PaymentDispatchRow[]).filter((r) => isUrgentSourceFile(r.cycle_source_file)),
  );

  // 2. FX rate (PHP → USD) for converting orphanage budget amounts.
  const { data: fxData } = await supabase
    .from("app_settings")
    .select("value")
    .eq("key", "usd_to_php_rate")
    .maybeSingle();
  const fx = parseFloat((fxData as { value?: string } | null)?.value ?? "0") || 0;

  // 3. Paid/problem orphanage BUDGET requests → synthetic urgent rows.
  const { data: orph } = await supabase
    .from("orphanage_dispatches")
    .select(
      "id, label, submitter_email, bank_name, bank_account_name, bank_account_number, swift_code, amount_php, status, transaction_id, bank_used, sent_date, note, paid_by, created_by, paid_at, created_at",
    )
    .eq("dispatch_type", "budget_request")
    .in("status", ["paid", "problem"]);

  for (const o of (orph ?? []) as Array<{
    id: string;
    label: string | null;
    submitter_email: string;
    bank_name: string | null;
    bank_account_name: string | null;
    bank_account_number: string | null;
    swift_code: string | null;
    amount_php: number | string | null;
    status: "paid" | "problem";
    transaction_id: string | null;
    bank_used: string | null;
    sent_date: string | null;
    note: string | null;
    paid_by: string | null;
    created_by: string | null;
    paid_at: string | null;
    created_at: string;
  }>) {
    const basis =
      o.sent_date ??
      (o.paid_at ? o.paid_at.slice(0, 10) : null) ??
      (o.created_at ? o.created_at.slice(0, 10) : null);
    const wk = basis ? sundayWeekRange(basis) : null;
    const amountPhp = num(o.amount_php);
    rows.push({
      id: o.id,
      // Synthetic row (never inserted), but kept consistent with what the urgent
      // dispatch routes now write: no Hubstaff upload, so no cycle_id.
      cycle_id: null,
      cycle_period_start: wk?.start ?? null,
      cycle_period_end: wk?.end ?? null,
      cycle_source_file: urgentCycleSourceFile(basis),
      recipient_email: o.submitter_email,
      recipient_name: o.label,
      processor: "wires",
      bank_preferred_raw: null,
      recipient_preferred_bank: o.bank_name ?? null,
      recipient_account_number: o.bank_account_number ?? null,
      recipient_account_holder: o.bank_account_name ?? null,
      recipient_swift_code: o.swift_code ?? null,
      amount_usd: fx > 0 ? Math.round((amountPhp / fx) * 100) / 100 : null,
      amount_php: amountPhp,
      amount_cop: null,
      transaction_id: o.transaction_id ?? "",
      bank_used: o.bank_used ?? "",
      sent_date: basis ?? "",
      arrival_date: null,
      status: o.status,
      note: o.note,
      // Synthesized from a one-off/MESA urgent payment, not a contractor invoice.
      payee_type: "employee",
      contractor_invoice_id: null,
      // Synthetic row — these payment types never carry a PAB/Tech bonus.
      system_bonus_php: null,
      system_bonus_label: null,
      created_by: o.paid_by ?? o.created_by ?? null,
      created_at: o.created_at,
    });
  }

  return rows;
}

/**
 * Synthesizes weekly "Urgent Payments" report summaries from the combined
 * urgent dispatch rows (MESA disbursements + orphanage budget requests, see
 * `loadUrgentDispatchRows`). Each is bucketed into the Sun→Sat week it was sent
 * (cycle_source_file = `urgent_<weekStart>_to_<weekEnd>`), so grouping by
 * cycle_source_file yields one report per week — listed alongside the regular
 * Hubstaff cycle reports. There are no disbursement_records for these, so the
 * detail view's outstanding query simply returns empty for them.
 */
async function buildUrgentWeeklyReports(): Promise<DisbursementReportSummary[]> {
  const data = await loadUrgentDispatchRows();
  if (data.length === 0) return [];

  type Bucket = {
    sourceFile: string;
    periodStart: string | null;
    periodEnd: string | null;
    latestCreatedAt: string;
    latestCreatedBy: string | null;
    totals: DisbursementReportTotals;
    byProcessor: Record<string, { count: number; usd: number; php: number }>;
    paidByEmail: Map<string, DisbursementReportRecipient>;
  };
  const buckets = new Map<string, Bucket>();

  for (const d of data) {
    // Fall back to a name that still carries the `urgent_` prefix — the report
    // detail lookup finds an urgent week by that prefix alone, so the old
    // "mesa_urgent" made such a bucket unopenable.
    const sourceFile = d.cycle_source_file || urgentCycleSourceFile(null);
    let bucket = buckets.get(sourceFile);
    if (!bucket) {
      bucket = {
        sourceFile,
        periodStart: d.cycle_period_start || null,
        periodEnd: d.cycle_period_end || null,
        latestCreatedAt: d.created_at,
        latestCreatedBy: d.created_by,
        totals: EMPTY_TOTALS(),
        byProcessor: {},
        paidByEmail: new Map(),
      };
      buckets.set(sourceFile, bucket);
    }
    if (d.created_at > bucket.latestCreatedAt) {
      bucket.latestCreatedAt = d.created_at;
      bucket.latestCreatedBy = d.created_by;
    }

    const owedUSD = num(d.amount_usd);
    const t = bucket.totals;
    t.totalRecipients += 1;
    t.totalOwedUSD += owedUSD;
    t.sentCount += 1;
    t.totalDispatchedUSD += owedUSD;
    if (d.status === "paid") {
      t.paidCount += 1;
      t.paidUSD += owedUSD;
      t.paidPHP += num(d.amount_php);
      const proc = d.processor || "unknown";
      const acc = bucket.byProcessor[proc] ?? { count: 0, usd: 0, php: 0 };
      acc.count += 1;
      acc.usd += owedUSD;
      acc.php += num(d.amount_php);
      bucket.byProcessor[proc] = acc;
      const emailKey = d.recipient_email.trim().toLowerCase();
      const existing = bucket.paidByEmail.get(emailKey);
      if (existing) {
        existing.amountUSD += owedUSD;
        if (!existing.name && d.recipient_name) existing.name = d.recipient_name;
      } else {
        bucket.paidByEmail.set(emailKey, {
          email: d.recipient_email,
          name: d.recipient_name,
          amountUSD: owedUSD,
        });
      }
    } else {
      if (d.status === "not_paid") t.notPaidCount += 1;
      else if (d.status === "threshold") t.thresholdCount += 1;
      else if (d.status === "problem") t.problemCount += 1;
      t.pendingDispatchedUSD += owedUSD;
    }
  }

  const out: DisbursementReportSummary[] = [];
  for (const bucket of buckets.values()) {
    let { periodStart, periodEnd } = bucket;
    if (!periodStart || !periodEnd) {
      const fromName = periodFromFilename(bucket.sourceFile);
      periodStart = periodStart ?? fromName.start;
      periodEnd = periodEnd ?? fromName.end;
    }
    const range = formatDisbursementReportName(periodStart, periodEnd, bucket.sourceFile);
    const paidRecipients = Array.from(bucket.paidByEmail.values()).sort((a, b) => {
      const an = (a.name ?? a.email).toLocaleLowerCase();
      const bn = (b.name ?? b.email).toLocaleLowerCase();
      return an.localeCompare(bn);
    });
    out.push({
      cycleId: `source:${bucket.sourceFile}`,
      periodStart,
      periodEnd,
      sourceFile: bucket.sourceFile,
      uploadedAt: bucket.latestCreatedAt,
      uploadedBy: bucket.latestCreatedBy,
      rowCount: bucket.totals.totalRecipients,
      isCurrent: false,
      reportName: `Urgent · ${range}`,
      totals: bucket.totals,
      byProcessor: bucket.byProcessor,
      paidRecipients,
    });
  }
  return out;
}

export async function listDisbursementReports(): Promise<{
  reports: DisbursementReportSummary[];
  error: string | null;
  /** Uploads with hours but no disbursement_records yet (see UnseededUpload). */
  unseeded: UnseededUpload[];
  /** Convenience alias for unseeded.length (kept for existing callers). */
  unseededCount: number;
}> {
  let records: DisbursementRecordRow[];
  try {
    records = await loadAllDisbursementRecords();
  } catch (e) {
    return {
      reports: [],
      unseeded: [],
      unseededCount: 0,
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
    byProcessor: Record<string, { count: number; usd: number; php: number }>;
    /** Map keyed by lowercased email so each recipient is counted once even if
     *  they appear in multiple disbursement_records rows for the same cycle. */
    paidByEmail: Map<string, DisbursementReportRecipient>;
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
        paidByEmail: new Map(),
      };
      buckets.set(r.source_file, bucket);
    }
    tallyRecord(bucket.totals, r);

    if (r.status === "paid") {
      const emailKey = r.recipient_email.trim().toLowerCase();
      const proc = processorByEmail.get(emailKey) ?? "unknown";
      const acc = bucket.byProcessor[proc] ?? { count: 0, usd: 0, php: 0 };
      acc.count += 1;
      acc.usd += num(r.paid_amount_usd) || num(r.amount_usd);
      acc.php += num(r.amount_php);
      bucket.byProcessor[proc] = acc;

      const paidUSD = num(r.paid_amount_usd) || num(r.amount_usd);
      const existing = bucket.paidByEmail.get(emailKey);
      if (existing) {
        existing.amountUSD += paidUSD;
        if (!existing.name && r.recipient_name) existing.name = r.recipient_name;
      } else {
        bucket.paidByEmail.set(emailKey, {
          email: r.recipient_email,
          name: r.recipient_name,
          amountUSD: paidUSD,
        });
      }
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

    const paidRecipients = Array.from(bucket.paidByEmail.values()).sort((a, b) => {
      const an = (a.name ?? a.email).toLocaleLowerCase();
      const bn = (b.name ?? b.email).toLocaleLowerCase();
      return an.localeCompare(bn);
    });

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
      paidRecipients,
    });
  }

  // Uploads that have no disbursement_records rows yet (need seeding). We surface
  // the full list — not just a count — so the UI can show which uploads are
  // missing and seed them individually. `seedable` mirrors the same predicate the
  // seed function uses, so non-seedable uploads (backfills, "(2)" re-uploads, the
  // time-activity export) show tagged rather than silently inflating the count.
  const seededSources = new Set(reports.map((r) => r.sourceFile));
  const unseeded: UnseededUpload[] = uploads
    .filter((u) => u.source_file && !seededSources.has(u.source_file))
    .map((u) => {
      const sourceFile = u.source_file as string;
      const fromName = periodFromFilename(sourceFile);
      const fallbackName = sourceFile.replace(/\.csv$/i, "");
      return {
        id: u.id,
        sourceFile,
        periodStart: fromName.start,
        periodEnd: fromName.end,
        uploadedAt: u.uploaded_at,
        uploadedBy: u.uploaded_by,
        rowCount: u.row_count,
        reportName: formatDisbursementReportName(fromName.start, fromName.end, fallbackName),
        seedable: isSeedableWeeklyUpload(sourceFile),
      };
    })
    // Seedable first, then newest period first — so the actionable ones lead.
    .sort((a, b) => {
      if (a.seedable !== b.seedable) return a.seedable ? -1 : 1;
      return (b.periodStart ?? "").localeCompare(a.periodStart ?? "");
    });
  const unseededCount = unseeded.length;

  // Append synthesized weekly urgent (MESA) reports — these live in
  // payment_dispatches (urgent_ cycle_source_file), not disbursement_records, and are
  // additive: a failure here must not break the regular cycle reports.
  try {
    reports.push(...(await buildUrgentWeeklyReports()));
  } catch (e) {
    console.warn("[disbursement-reports] buildUrgentWeeklyReports failed:", e);
  }

  // Newest period first.
  reports.sort((a, b) => (b.periodStart ?? "").localeCompare(a.periodStart ?? ""));

  return { reports, error: null, unseeded, unseededCount };
}

function parseWorkedHours(raw: string | null | undefined): number {
  if (!raw) return 0;
  const parts = raw.split(":");
  const h = parseFloat(parts[0] ?? "0") || 0;
  const m = parseFloat(parts[1] ?? "0") || 0;
  const s = parseFloat(parts[2] ?? "0") || 0;
  return h + m / 60 + s / 3600;
}

/** Parse a sheet rate to a number, or null when blank/invalid — mirrors
 *  current-pay.ts's `parseRateText` so empty cells fall through to the
 *  catalog/department fallback instead of pinning the rate to 0. */
function parseSeedRate(v: string | number | null | undefined): number | null {
  if (v == null) return null;
  const s = String(v).trim().replace(/,/g, "");
  if (!s) return null;
  const n = parseFloat(s);
  return Number.isFinite(n) ? n : null;
}

/** Parse a YYYY-MM-DD string to a LOCAL-midnight Date (matches the pay-week
 *  window math in calendar-column-dedupe / current-pay). */
function parseLocalIsoDate(iso: string | null | undefined): Date | null {
  if (!iso) return null;
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(iso);
  if (!m) return null;
  const d = new Date(+m[1], +m[2] - 1, +m[3]);
  return Number.isNaN(d.getTime()) ? null : d;
}

/**
 * True only for a standard single-week Hubstaff payroll upload. Excludes the
 * additive Sunday-overlap backfills (`backfill-*`), the multi-week
 * `time-activity-report-*` export, and accidental duplicate re-uploads
 * (`… (2).csv`) — none of which represent a payable weekly cycle, so none should
 * ever seed a phantom cycle into `disbursement_records` (CEO financial
 * reports + People payroll history).
 */
function isSeedableWeeklyUpload(sourceFile: string): boolean {
  const name = sourceFile.toLowerCase();
  if (/backfill|time-activity|\(\d+\)|copy/.test(name)) return false;
  const range = parseDateRangeFromFilename(sourceFile);
  if (!range) return false;
  const days = Math.round((range.end.getTime() - range.start.getTime()) / 86_400_000) + 1;
  return days >= 6 && days <= 8;
}

/**
 * Seeds `disbursement_records` for all `hubstaff_uploads` that have no records yet.
 *
 * Pay is computed with the **Payroll Wizard's authoritative calculator**
 * (`computeProratedRowPay` from current-pay.ts): the Payment Catalog rate overlay
 * (individual → sheet → department base), per-day rate-history prorating, the
 * 40h/week regular cap applied chronologically, the HSL weekend premium, and
 * the same FX resolution. This keeps a report's pending-cycle estimate in lock-
 * step with what the live dispatch will actually pay — the two share one
 * function and can't silently diverge. Bonuses (PAB/Tech) and the MESA deduction
 * are NOT included here; those flow through the real `payment_dispatches` rows
 * synced into `paid_amount_usd`.
 *
 * Returns the total number of rows inserted/updated.
 */
export async function seedMissingDisbursementRecords(opts: {
  /**
   * When provided, only these source_files are processed (still gated by
   * isSeedableWeeklyUpload — a caller can't force a non-weekly file through).
   * An already-seeded file in this list is RE-seeded: estimates refresh from
   * the (possibly corrected) hours while paid state is preserved, and a
   * partially-failed earlier seed heals. A file whose pay week is already
   * seeded under a DIFFERENT filename is refused (double-count guard).
   * Omit to seed all unseeded seedable uploads, which never reprocesses an
   * already-seeded file — the original "Seed all" behaviour.
   */
  sourceFiles?: string[];
} = {}): Promise<{
  seeded: number;
  error: string | null;
}> {
  const supabase = createSupabaseServiceRoleClient() ?? createSupabaseServerClient();
  if (!supabase) return { seeded: 0, error: "No Supabase client" };

  const targetFiles = opts.sourceFiles && opts.sourceFiles.length > 0
    ? new Set(opts.sourceFiles)
    : null;

  // Which source_files are already in disbursement_records? Page through —
  // PostgREST caps a single select at 1000 rows, and an incomplete set here would
  // make the seed re-process (and recompute the pay of) already-seeded weeks.
  const seededFiles = new Set<string>();
  {
    const PAGE = 1000;
    let from = 0;
    for (;;) {
      const { data, error: pErr } = await supabase
        .from("disbursement_records")
        .select("source_file")
        .range(from, from + PAGE - 1);
      if (pErr) return { seeded: 0, error: pErr.message };
      for (const r of (data ?? []) as { source_file: string }[]) seededFiles.add(r.source_file);
      if (!data || data.length < PAGE) break;
      from += PAGE;
    }
  }

  // Week ranges of already-seeded files, for the twin-file guard below. Both
  // ingest paths produce a seedable file for the SAME pay week under different
  // names (`simple-biz_api_sync_…` from the cron, `simple-biz_daily_report_…`
  // from a manual upload) — seeding both would put two full cycles for one week
  // into every money reader (CEO Financial Reports sums per source_file), and
  // the sibling that dispatches don't key on would read as fully unpaid forever.
  const seededWeeks = new Map<string, string>(); // "startMs|endMs" → first seeded file
  for (const f of seededFiles) {
    const r = parseDateRangeFromFilename(f);
    if (r) {
      const key = `${r.start.getTime()}|${r.end.getTime()}`;
      if (!seededWeeks.has(key)) seededWeeks.set(key, f);
    }
  }

  // Candidate uploads. Only a canonical single-week payroll file becomes a
  // cycle (see {@link isSeedableWeeklyUpload}) — backfills, the time-activity
  // export, and "(2)" re-uploads are skipped. Already-seeded handling differs
  // by mode:
  //   • explicit sourceFiles (the ingest tails): a re-ingest of the SAME
  //     filename RE-SEEDS it — corrected hours land in the estimates (the whole
  //     point of sharing the wizard's calculator), and a partially-failed first
  //     seed heals on the next run. Paid state is preserved below.
  //   • seed-all (no targets): already-seeded files are never reprocessed, the
  //     original conservative behaviour.
  const uploads = await safeListHubstaffUploads();
  const unseeded = uploads.filter((u) => {
    if (!u.source_file || !isSeedableWeeklyUpload(u.source_file)) return false;
    if (targetFiles && !targetFiles.has(u.source_file)) return false;
    if (seededFiles.has(u.source_file)) return Boolean(targetFiles);
    const r = parseDateRangeFromFilename(u.source_file);
    const twin = r ? seededWeeks.get(`${r.start.getTime()}|${r.end.getTime()}`) : undefined;
    if (twin && twin !== u.source_file) {
      console.warn(
        `[disbursement-reports] NOT seeding ${u.source_file}: its pay week is already seeded under ${twin} — a second cycle would double-count the week in every reader`,
      );
      return false;
    }
    return true;
  });
  if (unseeded.length === 0) return { seeded: 0, error: null };

  // FX rates from app_settings — same effective resolution the wizard uses.
  const { data: fxRows } = await supabase
    .from("app_settings")
    .select("key,value")
    .in("key", ["usd_to_php_rate", "usd_to_cop_rate"]);
  const fxValues: Record<string, string | null> = {};
  for (const r of (fxRows ?? []) as { key: string; value: string | null }[]) fxValues[r.key] = r.value;
  const fx = buildFxRates(fxValues);
  const fxRate = fx.usdToPhp;

  // Pull the rest of the wizard's authoritative pay context in parallel:
  //  - Payment Catalog pay structures (individual + department) for the rate overlay,
  //  - the full employee_rate_history for mid-cycle per-day prorating,
  //  - the master list (active_employees) for HSL membership (weekend premium).
  // Paged roster read: the active roster passed 1,000 people in Jul 2026 and
  // PostgREST silently caps un-ranged selects there — an un-paged read dropped
  // the tail of the roster from HSL classification with no error.
  const fetchRosterPaged = async () => {
    const PAGE = 1000;
    const rows: Array<{
      "Work Email": string | null;
      "Personal Email": string | null;
      "Department": string | null;
    }> = [];
    for (let from = 0; ; from += PAGE) {
      const { data } = await supabase
        .from("active_employees")
        .select('"Work Email", "Personal Email", "Department"')
        .order("Work Email", { ascending: true })
        .range(from, from + PAGE - 1);
      rows.push(...((data ?? []) as typeof rows));
      if (!data || data.length < PAGE) break;
    }
    return rows;
  };

  const [payStructuresResult, rateHistory, masterRows, hslTransferEffective] = await Promise.all([
    listPayStructures(),
    fetchAllRateHistory(),
    fetchRosterPaged(),
    // Into-HSL transfer effective dates — day-scopes the weekend premium in a
    // transfer week (resolveHslWeekScope), matching current-pay.ts.
    fetchHslTransferEffectiveByEmail(),
  ]);
  const catalogIndex = buildCatalogRateIndex(payStructuresResult.structures);

  // HSL email set — drives the +15₱/h weekend premium, matching current-pay.ts:
  // normalized dept match so 'HSL', 'hsl:*' sub-teams and 'Hogan Smith Law'
  // all count. Keyed on work + personal email.
  const hslEmails = new Set<string>();
  for (const m of masterRows) {
    if (normalizeDeptToKey(m["Department"] ?? "") !== "hogan_smith_law") continue;
    const we = normEmail(m["Work Email"]);
    const pe = normEmail(m["Personal Email"]);
    if (we) hslEmails.add(we);
    if (pe) hslEmails.add(pe);
  }

  // Sheet rates + department, indexed by email (work + personal). Empty cells
  // resolve to null (not 0) so the catalog/department fallback can take over —
  // same null semantics as current-pay.ts's parseRateText.
  //
  // Read through getEmployeeHourlyRatesRows — the hardened reader current-pay
  // uses (dedup `employee_hourly_rates_current` view + paginated fallback). The
  // old raw `.select("*")` here hit PostgREST's silent 1,000-row cap against a
  // 22,000-row per-upload history table, building the seeding rate map from an
  // arbitrary slice spanning stale uploads.
  const { rows: ratesRows } = await getEmployeeHourlyRatesRows();
  const rateByEmail = new Map<string, { reg: number | null; ot: number | null }>();
  const deptByEmail = new Map<string, string>();
  for (const r of ratesRows) {
    const we = normEmail(r.work_email);
    const pe = normEmail(r.personal_email);
    const entry = {
      reg: parseSeedRate(r.regular_rate),
      ot: parseSeedRate(r.ot_rate),
    };
    if (we) rateByEmail.set(we, entry);
    if (pe && !rateByEmail.has(pe)) rateByEmail.set(pe, entry);
    const dept = r.department;
    if (dept) {
      if (we && !deptByEmail.has(we)) deptByEmail.set(we, dept);
      if (pe && !deptByEmail.has(pe)) deptByEmail.set(pe, dept);
    }
  }

  // Existing dispatches for unseeded source_files.
  const unseededFiles = unseeded.map((u) => u.source_file as string);
  // `payee_type` is selected so contractor-invoice payments can be skipped below.
  // It only exists once add_contractor_dispatch_link.sql has been applied, so fall
  // back to the old column list when it is missing — correct in that case, since no
  // contractor dispatch row can exist yet either.
  const DISPATCH_COLS =
    "id, recipient_email, cycle_source_file, status, amount_usd, sent_date, bank_used, transaction_id";
  // Paged: a single cycle pays 1,000+ people now, and this fetch spans EVERY
  // unseeded cycle at once — the un-paged read hit PostgREST's silent 1,000-row
  // cap, so tail dispatches never stamped their disbursement records paid.
  let dispatchData: unknown[] | null = null;
  {
    // Probe with the first page only, so the missing-column fallback decision
    // is made before draining every page.
    const firstPage = await supabase
      .from("payment_dispatches")
      .select(`${DISPATCH_COLS}, payee_type`)
      .in("cycle_source_file", unseededFiles)
      .order("created_at", { ascending: false })
      .order("id", { ascending: false })
      .range(0, 999);
    if (firstPage.error) {
      // ONLY a missing column may fall back. Falling back on any error (a network
      // blip, a timeout) would silently drop the payee filter and re-open the
      // clobber this guard exists to prevent — an invoice payment stamped onto an
      // employee's salary record.
      const isMissingColumn =
        firstPage.error.code === "42703" ||
        firstPage.error.code === "PGRST204" ||
        /payee_type/.test(firstPage.error.message ?? "");
      if (!isMissingColumn) throw new Error(firstPage.error.message);
      const fallback = await selectAllPaged<Record<string, unknown>>((from, to) =>
        supabase
          .from("payment_dispatches")
          .select(DISPATCH_COLS)
          .in("cycle_source_file", unseededFiles)
          .order("created_at", { ascending: false })
          .order("id", { ascending: false })
          .range(from, to),
      );
      if (fallback.error) throw new Error(fallback.error);
      dispatchData = fallback.rows;
    } else if ((firstPage.data ?? []).length < 1000) {
      dispatchData = firstPage.data ?? null;
    } else {
      const rest = await selectAllPaged<Record<string, unknown>>((from, to) =>
        supabase
          .from("payment_dispatches")
          .select(`${DISPATCH_COLS}, payee_type`)
          .in("cycle_source_file", unseededFiles)
          .order("created_at", { ascending: false })
          .order("id", { ascending: false })
          .range(from, to),
      );
      if (rest.error) throw new Error(rest.error);
      dispatchData = rest.rows;
    }
  }
  const dispatchMap = new Map<
    string,
    {
      id: string;
      status: string;
      amount_usd: number | null;
      sent_date: string | null;
      bank_used: string | null;
      transaction_id: string | null;
    }
  >();
  for (const d of (dispatchData ?? []) as Array<{
    id: string;
    recipient_email: string | null;
    cycle_source_file: string | null;
    status: string;
    amount_usd: number | null;
    sent_date: string | null;
    bank_used: string | null;
    transaction_id: string | null;
    payee_type?: string | null;
  }>) {
    // A contractor-invoice payment must NEVER seed an hourly disbursement record:
    // the map is keyed by (source_file, email), so for someone who both invoices
    // and draws a salary it would stamp their employee row status='paid' with the
    // INVOICE's amount and transaction id — salary that was never sent reading as
    // paid, and dropping out of `outstanding`. Same invariant the migration's
    // sync_disbursement_from_dispatch() guard enforces for the trigger path.
    if ((d.payee_type ?? "employee") !== "employee") continue;
    const key = `${d.cycle_source_file}|${d.recipient_email?.trim().toLowerCase()}`;
    if (!dispatchMap.has(key)) dispatchMap.set(key, d);
  }

  let seeded = 0;
  const chunkErrors: string[] = [];

  for (const upload of unseeded) {
    const sourceFile = upload.source_file as string;
    const period = periodFromFilename(sourceFile);
    if (!period.start || !period.end) continue;

    // Per-department pay-week windows from the upload's start date. An 8-day
    // Sun→Sun upload contributes exactly one 7-day week per department (HSL keeps
    // Mon→Sun, everyone else Sun→Sat), matching current-pay.ts so the estimate
    // counts the same days the live dispatch does.
    const periodStartDate = parseLocalIsoDate(period.start);
    const payWeekHsl = periodStartDate ? payWeekFromUploadStart(periodStartDate, true) : null;
    const payWeekNonHsl = periodStartDate ? payWeekFromUploadStart(periodStartDate, false) : null;

    // Fetch all hourly rows for this upload using select('*') — column names
    // in hubstaff_hours match the CSV headers (e.g. "Email", "Member", "Total worked").
    const PAGE = 1000;
    const fetchedHours: Record<string, unknown>[] = [];
    let from = 0;
    while (true) {
      const { data: hoursPage, error: hoursErr } = await supabase
        .from("hubstaff_hours")
        .select("*")
        .eq("source_file", sourceFile)
        .range(from, from + PAGE - 1);
      if (hoursErr) break;
      const page = (hoursPage ?? []) as Record<string, unknown>[];
      fetchedHours.push(...page);
      if (page.length < PAGE) break;
      from += PAGE;
    }
    // A cron retry / manual re-run of the same filename leaves rows from TWO
    // upload batches under one source_file (replaceHubstaffHoursFromCsvText
    // never deletes) — every canonical reader collapses to one batch, and the
    // seeder must too or it computes a person's week twice and the duplicate
    // pair aborts its upsert chunk (Postgres 21000). Prefer this upload's own
    // batch id, the same rule the paystub readers use.
    const allHours = collapseToSingleUploadBatch(fetchedHours, upload.id ?? null);
    if (allHours.length < fetchedHours.length) {
      console.warn(
        `[disbursement-reports] ${sourceFile}: collapsed ${fetchedHours.length} hubstaff_hours rows across multiple upload batches to ${allHours.length} (preferred batch ${upload.id})`,
      );
    }
    if (allHours.length === 0) continue;

    // On an explicit RE-seed of an already-seeded file, existing rows' paid
    // state must survive the refresh: a person whose status was set by a direct
    // UPDATE (no dispatch row to re-derive from) would otherwise be knocked
    // back to 'pending' by a hours correction. Live dispatch state still wins —
    // this is only the fallback between prior record and 'pending'.
    const priorByEmail = new Map<
      string,
      {
        status: string | null;
        paid_amount_usd: number | string | null;
        paid_at: string | null;
        bank_used: string | null;
        transaction_id: string | null;
        dispatch_id: string | null;
      }
    >();
    if (seededFiles.has(sourceFile)) {
      const priorRes = await selectAllPaged<{
        recipient_email: string;
        status: string | null;
        paid_amount_usd: number | string | null;
        paid_at: string | null;
        bank_used: string | null;
        transaction_id: string | null;
        dispatch_id: string | null;
      }>((f, t) =>
        supabase
          .from("disbursement_records")
          .select("recipient_email, status, paid_amount_usd, paid_at, bank_used, transaction_id, dispatch_id")
          .eq("source_file", sourceFile)
          .order("recipient_email", { ascending: true })
          .range(f, t),
      );
      if (priorRes.error) {
        // Refusing the refresh beats refreshing blind: without the prior rows we
        // could downgrade direct-UPDATE paid statuses to pending.
        console.warn(
          `[disbursement-reports] ${sourceFile}: could not read existing records before re-seed (${priorRes.error}) — skipping the refresh for this file`,
        );
        continue;
      }
      for (const r of priorRes.rows) priorByEmail.set(r.recipient_email, r);
    }

    const rows: Record<string, unknown>[] = [];
    const seenEmails = new Set<string>();
    for (const h of allHours) {
      const email = normEmail(h["Email"] as string | null);
      if (!email) continue;
      // One row per (source_file, email) — the table's unique key. A duplicate
      // email inside one batch (a malformed CSV) would abort its whole upsert
      // chunk with Postgres 21000; first row wins, loudly.
      if (seenEmails.has(email)) {
        console.warn(`[disbursement-reports] ${sourceFile}: duplicate hours row for ${email} — keeping the first`);
        continue;
      }
      seenEmails.add(email);

      // Day-scoped HSL-ness for a mid-week transfer INTO HSL — same rule as
      // current-pay.ts: weekend treatment from the effective date, none at all
      // when the label moved early (effective after this week). Without a
      // resolvable period window the scope can't be judged → keep the plain flag.
      const { isHsl: isHslEmp, hslFrom } = payWeekHsl
        ? resolveHslWeekScope(
            hslEmails.has(email),
            hslTransferEffective.get(email) ?? null,
            payWeekHsl.start,
            payWeekHsl.end,
          )
        : { isHsl: hslEmails.has(email), hslFrom: null };

      // Rate resolution — identical priority to the live dispatch
      // (current-pay.ts): individual catalog → sheet → department base. Only the
      // individual catalog rate OVERRIDES the per-day history; the department
      // rate is a pure fallback for employees with no sheet rate at all.
      const sheetRate = rateByEmail.get(email);
      const empCat = resolveEmployeeCatalogRate(catalogIndex, email, fx);
      const deptCat = resolveDeptCatalogRate(catalogIndex, deptByEmail.get(email) ?? null, fx);
      const catalogOverride = empCat ? { reg: empCat.regPhp, ot: empCat.otPhp } : null;
      const hasSheet = sheetRate != null && (sheetRate.reg != null || sheetRate.ot != null);
      const baseRate = hasSheet
        ? sheetRate
        : deptCat
          ? { reg: deptCat.regPhp, ot: deptCat.otPhp }
          : sheetRate;
      const effReg = empCat?.regPhp ?? baseRate?.reg ?? null;
      const effOt = empCat?.otPhp ?? baseRate?.ot ?? null;

      // Per-day prorated pay: resolve the rate as-of each day from history, apply
      // the 40h/week cap chronologically, clamp to this department's pay week,
      // and add the HSL weekend premium — the exact same calculator the wizard
      // uses. Falls back to the aggregate single-rate formula only when the row
      // has no resolvable per-day columns.
      const payWindow = isHslEmp ? payWeekHsl : payWeekNonHsl;
      const rowResolved = resolveCanonicalColumnsToIso(h, sourceFile);
      const prorated = computeProratedRowPay(
        rowResolved,
        rateHistory,
        email,
        baseRate,
        isHslEmp,
        payWindow,
        catalogOverride,
        // Native-currency twin of the override — same catalog-consistent
        // proration rule as live dispatch, so seeded estimates can't diverge.
        empCat ? { currency: empCat.currency, regular: empCat.regNative, ot: empCat.otNative } : null,
        // Mid-week transfer INTO HSL: premium only from the effective date on.
        hslFrom,
      );

      let totalHours: number;
      let regularHours: number;
      let otHours: number;
      let regularPayPHP: number | null;
      let otPayPHP: number | null;
      if (prorated) {
        totalHours = Math.round((prorated.totalSec / 3600) * 100) / 100;
        regularHours = Math.round((prorated.regularSec / 3600) * 100) / 100;
        otHours = Math.round((prorated.otSec / 3600) * 100) / 100;
        regularPayPHP = prorated.regularPayPHP;
        otPayPHP = prorated.otPayPHP;
      } else {
        totalHours =
          Math.round(parseWorkedHours(h["Total worked"] as string | null) * 100) / 100;
        regularHours = Math.round(Math.min(40, totalHours) * 100) / 100;
        otHours = Math.round(Math.max(0, totalHours - 40) * 100) / 100;
        regularPayPHP = effReg != null ? Math.round(regularHours * effReg * 100) / 100 : null;
        otPayPHP = effOt != null ? Math.round(otHours * effOt * 100) / 100 : null;
      }

      const amountPHP =
        regularPayPHP != null || otPayPHP != null
          ? Math.round(((regularPayPHP ?? 0) + (otPayPHP ?? 0)) * 100) / 100
          : null;
      const amountUSD =
        amountPHP != null && fxRate > 0
          ? Math.round((amountPHP / fxRate) * 100) / 100
          : null;

      const dispKey = `${sourceFile}|${email}`;
      const dispatch = dispatchMap.get(dispKey);
      // Paid-state precedence: live dispatch row → prior record when it had
      // already left 'pending' (direct-UPDATE statuses have no dispatch row to
      // re-derive from) → pending. Estimates always refresh from the hours.
      const prior = priorByEmail.get(email);
      const keepPrior = !dispatch && prior != null && prior.status != null && prior.status !== "pending";

      rows.push({
        cycle_period_start: period.start,
        cycle_period_end: period.end,
        source_file: sourceFile,
        upload_id: (h["upload_id"] as string | null) ?? upload.id,
        recipient_email: email,
        recipient_name: (h["Member"] as string | null)?.trim() || null,
        total_hours: totalHours,
        regular_hours: regularHours,
        ot_hours: otHours,
        regular_rate_php: effReg,
        ot_rate_php: effOt,
        amount_php: amountPHP,
        amount_usd: amountUSD,
        fx_rate: fxRate || null,
        status: dispatch?.status ?? (keepPrior ? prior.status : "pending"),
        paid_amount_usd: dispatch?.amount_usd ?? (keepPrior ? prior.paid_amount_usd : null),
        paid_at: dispatch?.sent_date ?? (keepPrior ? prior.paid_at : null),
        bank_used: dispatch?.bank_used ?? (keepPrior ? prior.bank_used : null),
        transaction_id: dispatch?.transaction_id ?? (keepPrior ? prior.transaction_id : null),
        dispatch_id: dispatch?.id ?? (keepPrior ? prior.dispatch_id : null),
      });
    }

    if (rows.length === 0) continue;

    const BATCH = 200;
    for (let i = 0; i < rows.length; i += BATCH) {
      const { error: upsertErr } = await supabase
        .from("disbursement_records")
        .upsert(rows.slice(i, i + BATCH), {
          onConflict: "source_file,recipient_email",
        });
      if (upsertErr) {
        // Never silent: a swallowed chunk failure reads as a fully-seeded week
        // while ~200 people are missing from every money reader. The error also
        // travels back to the ingest tail's log via the return value.
        console.warn(
          `[disbursement-reports] ${sourceFile}: upsert chunk ${i}-${Math.min(i + BATCH, rows.length)} failed: ${upsertErr.message}`,
        );
        chunkErrors.push(`${sourceFile} rows ${i}-${Math.min(i + BATCH, rows.length)}: ${upsertErr.message}`);
      } else {
        seeded += Math.min(BATCH, rows.length - i);
      }
    }
  }

  return {
    seeded,
    error: chunkErrors.length > 0
      ? `${chunkErrors.length} upsert chunk(s) failed — the week is PARTIALLY seeded and will heal on the next re-ingest of the same file. First: ${chunkErrors[0]}`
      : null,
  };
}

