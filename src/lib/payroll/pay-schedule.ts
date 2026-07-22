/**
 * Disbursement-date schedule by payout method.
 *
 * Operational rule (owner): payroll is disbursed the week AFTER the pay period —
 * HuruPay on Tuesday, wires on Thursday. So a stub's "pay date" is the Tuesday
 * (HuruPay / default) or Thursday (wires) of the week following the pay week.
 * This mirrors the wizard's existing `salary_date = weekStart + 8` intent
 * (documented as "the Tuesday after the pay period's Sunday").
 *
 * Method comes from `employee_ids.preferred_processor` (falling back to the
 * legacy `employee_hourly_rates.bank_preferred`), the same source of truth
 * Payment Dispatch uses to bucket people into processor tabs.
 */
import {
  createSupabaseServiceRoleClient,
  createSupabaseServerClient,
} from "@/lib/supabase/server";

const SUN = 0;
const TUESDAY = 2;
const THURSDAY = 4;

/** Parse "YYYY-MM-DD" to a local Date (no TZ drift), null on failure. */
function parseYmdLocal(iso: string | null | undefined): Date | null {
  if (!iso) return null;
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(iso.trim());
  if (!m) return null;
  const d = new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3]));
  return Number.isNaN(d.getTime()) ? null : d;
}

function fmtYmd(d: Date): string {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(
    d.getDate(),
  ).padStart(2, "0")}`;
}

/** The first date with day-of-week `targetDow` STRICTLY after `d`. */
function nextWeekday(d: Date, targetDow: number): Date {
  const r = new Date(d.getFullYear(), d.getMonth(), d.getDate());
  let delta = (targetDow - r.getDay() + 7) % 7;
  if (delta === 0) delta = 7;
  r.setDate(r.getDate() + delta);
  return r;
}

/** True when this processor is paid by wire (Thursday); everything else (HuruPay
 *  and other rails) defaults to Tuesday. */
export function isWireProcessor(processor: string | null | undefined): boolean {
  const v = (processor ?? "").trim().toLowerCase();
  return v === "wires" || v === "wire" || v.startsWith("wire");
}

/**
 * The scheduled pay date (ISO YYYY-MM-DD) for a pay week + method: the Tuesday
 * (HuruPay / default) or Thursday (wires) of the week AFTER the pay week ends.
 * `weekEndIso` is the pay-period end (Saturday for non-HSL). Null when the week
 * end can't be parsed.
 */
export function scheduledPayDateIso(
  weekEndIso: string | null | undefined,
  processor: string | null | undefined,
): string | null {
  const end = parseYmdLocal(weekEndIso);
  if (!end) return null;
  return fmtYmd(nextWeekday(end, isWireProcessor(processor) ? THURSDAY : TUESDAY));
}

/**
 * The pay date to display: the real disbursement date when Payment Dispatch has
 * recorded one, otherwise the scheduled Tuesday/Thursday for this week + method.
 */
export function resolvePayDateIso(
  sentDate: string | null | undefined,
  weekEndIso: string | null | undefined,
  processor: string | null | undefined,
): string | null {
  if (sentDate && sentDate.trim()) return sentDate;
  return scheduledPayDateIso(weekEndIso, processor);
}

/** Map a legacy free-text `bank_preferred` cell to a processor id (subset — we
 *  only need to tell wires apart from the rest). Mirrors
 *  `processorIdFromBankPreferred` in mock-queue.ts without importing that
 *  client module into a server route. */
function processorFromBankPreferred(raw: string | null | undefined): string | null {
  if (!raw) return null;
  const v = String(raw).trim().toLowerCase().replace(/\s+/g, "");
  if (!v) return null;
  if (v === "hurupay" || v === "huru" || v === "huropay") return "hurupay";
  if (v === "wepay") return "wepay";
  if (v === "higlobe" || v === "higloble" || v === "higlobel") return "higlobe";
  if (v === "wise" || v === "transferwise") return "wise";
  if (v === "jeeves") return "jeeves";
  if (/^x?\d{3,5}$/.test(v) || v === "wire" || v === "wires" || v.startsWith("wire")) return "wires";
  return null;
}

/**
 * Resolve an employee's payout processor from any of their emails. Explicit
 * `employee_ids.preferred_processor` wins; otherwise the legacy
 * `employee_hourly_rates.bank_preferred` free-text cell. Returns null when
 * neither is set (callers default to the Tuesday schedule). Best-effort: any DB
 * error resolves to null rather than throwing.
 */
export async function resolveEmployeeProcessor(emails: string[]): Promise<string | null> {
  const lc = [...new Set(emails.map((e) => e.trim().toLowerCase()).filter(Boolean))];
  if (lc.length === 0) return null;
  const supabase = createSupabaseServiceRoleClient() ?? createSupabaseServerClient();
  if (!supabase) return null;

  // 1) Explicit pick on employee_ids (case-insensitive match on work email).
  //    "Bank Preferred" wins over the Disbursement channel; both live here.
  try {
    const or = lc.map((e) => `work_email.ilike.${e}`).join(",");
    const { data } = await supabase
      .from("employee_ids")
      .select("bank_preferred, preferred_processor")
      .or(or)
      .limit(5);
    const rows = (data ?? []) as Array<{
      bank_preferred?: string | null;
      preferred_processor?: string | null;
    }>;
    for (const r of rows) {
      const p = (r.bank_preferred ?? "").trim().toLowerCase();
      if (p) return p;
    }
    for (const r of rows) {
      const p = (r.preferred_processor ?? "").trim().toLowerCase();
      if (p) return p;
    }
  } catch {
    /* fall through to the legacy fallback */
  }

  // 2) Legacy free-text bank_preferred on employee_hourly_rates.
  try {
    const or = lc
      .flatMap((e) => [`work_email.ilike.${e}`, `personal_email.ilike.${e}`])
      .join(",");
    const { data } = await supabase
      .from("employee_hourly_rates")
      .select("bank_preferred")
      .or(or)
      .limit(5);
    for (const r of (data ?? []) as Array<{ bank_preferred?: string | null }>) {
      const p = processorFromBankPreferred(r.bank_preferred);
      if (p) return p;
    }
  } catch {
    /* best-effort — default schedule applies */
  }

  return null;
}

// Re-export the Sunday constant only to document the week anchor for callers that
// reason about the pay-week convention alongside this schedule.
export const WEEK_START_DOW = SUN;
