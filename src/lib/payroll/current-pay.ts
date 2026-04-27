/**
 * Server-side calculator that turns the **latest Hubstaff upload** + the
 * `employee_hourly_rates` table into a per-employee initial-pay summary.
 *
 * This is intentionally a simplified version of what `PayrollWizard` shows in
 * Step 2 — it does not apply department-specific bonuses, the OT-suppression
 * toggle, or any manual hour overrides. It's meant for the Payment Dispatch
 * view so Lenny can see roughly how much each person is owed for the current
 * cycle. The wizard remains the source of truth for the final paystub.
 */
import {
  fetchHubstaffRowsOrdered,
  getCurrentHubstaffUploadId,
} from "@/lib/supabase/hubstaff-hours-db";
import { getEmployeeHourlyRatesRows } from "@/lib/supabase/employee-hourly-rates";
import { mapHubstaffHoursRow } from "@/lib/supabase/hubstaff-hours";
import { getAppSetting } from "@/lib/supabase/app-settings";
import {
  createSupabaseServerClient,
  createSupabaseServiceRoleClient,
} from "@/lib/supabase/server";
import { effectiveUsdToPhpRateFromStored } from "@/lib/fx/usd-php";
import { normEmail } from "@/lib/email/norm-email";

export interface PayrollPeriod {
  /** UUID of the active hubstaff_uploads row — null if no upload exists yet. */
  cycleId: string | null;
  /** ISO date (YYYY-MM-DD) — Sunday of the period, derived from Hubstaff date columns. */
  start: string | null;
  /** ISO date (YYYY-MM-DD) — Saturday of the period, derived from Hubstaff date columns. */
  end: string | null;
  /** Filename of the CSV that produced this upload, when available. */
  sourceFile: string | null;
}

export interface CurrentPayEntry {
  totalHours: number;
  regularHours: number;
  otHours: number;
  regularPayPHP: number | null;
  otPayPHP: number | null;
  initialPayPHP: number | null;
  /** initialPayPHP / fxRate — null when either input is missing. */
  initialPayUSD: number | null;
  hasRate: boolean;
}

export interface CurrentPayResult {
  period: PayrollPeriod;
  fxRate: number;
  /** Keyed by lowercased work_email (the canonical join key). */
  byEmail: Record<string, CurrentPayEntry>;
}

function parseRateText(v: string | null | undefined): number | null {
  if (v == null) return null;
  const s = String(v).trim().replace(/,/g, "");
  if (!s) return null;
  const n = parseFloat(s);
  return Number.isFinite(n) ? n : null;
}

export async function computeCurrentPay(): Promise<CurrentPayResult> {
  const supabase = createSupabaseServiceRoleClient() ?? createSupabaseServerClient();
  const cycleIdPromise = supabase
    ? getCurrentHubstaffUploadId(supabase)
    : Promise.resolve(null);

  const [hubstaff, rates, fxValue, cycleId] = await Promise.all([
    fetchHubstaffRowsOrdered(),
    getEmployeeHourlyRatesRows(),
    getAppSetting("usd_to_php_rate"),
    cycleIdPromise,
  ]);

  const fxRate = effectiveUsdToPhpRateFromStored(fxValue);

  // Index rates by both work_email and personal_email (lowercased) so a
  // hubstaff row keyed on either still resolves to a rate.
  const rateByEmail = new Map<string, { reg: number | null; ot: number | null }>();
  for (const r of rates.rows) {
    const reg = parseRateText(r.regular_rate);
    const ot = parseRateText(r.ot_rate);
    const we = normEmail(r.work_email);
    const pe = normEmail(r.personal_email);
    const entry = { reg, ot };
    if (we) rateByEmail.set(we, entry);
    if (pe && !rateByEmail.has(pe)) rateByEmail.set(pe, entry);
  }

  const byEmail: Record<string, CurrentPayEntry> = {};

  for (const raw of hubstaff.rows) {
    const mapped = mapHubstaffHoursRow(raw);
    const em = normEmail(mapped.email);
    if (!em) continue;

    const rate = rateByEmail.get(em);
    const totalHours = mapped.hoursDecimal;
    const otHours = mapped.overtimeDecimal;
    const regularHours = Math.max(0, totalHours - otHours);
    const reg = rate?.reg ?? null;
    const ot = rate?.ot ?? null;

    const regularPayPHP = reg != null ? regularHours * reg : null;
    const otPayPHP = ot != null ? otHours * ot : null;
    const initialPayPHP =
      regularPayPHP != null && otPayPHP != null ? regularPayPHP + otPayPHP : null;
    const initialPayUSD =
      initialPayPHP != null && fxRate > 0 ? initialPayPHP / fxRate : null;

    byEmail[em] = {
      totalHours: Math.round(totalHours * 100) / 100,
      regularHours: Math.round(regularHours * 100) / 100,
      otHours: Math.round(otHours * 100) / 100,
      regularPayPHP: regularPayPHP != null ? Math.round(regularPayPHP * 100) / 100 : null,
      otPayPHP: otPayPHP != null ? Math.round(otPayPHP * 100) / 100 : null,
      initialPayPHP:
        initialPayPHP != null ? Math.round(initialPayPHP * 100) / 100 : null,
      initialPayUSD:
        initialPayUSD != null ? Math.round(initialPayUSD * 100) / 100 : null,
      hasRate: reg != null,
    };
  }

  // Period — derive from the date columns Hubstaff CSVs include (e.g. 2026-03-22).
  // The columns are sorted Sun→Sat by `sortHubstaffColumnsForDisplay`, but we
  // don't depend on that here: we just take min/max of any ISO-date-shaped
  // column names we recognise.
  const dateCols = hubstaff.columns
    .filter((c) => /^\d{4}-\d{2}-\d{2}$/.test(c))
    .sort();
  const start = dateCols[0] ?? null;
  const end = dateCols[dateCols.length - 1] ?? null;

  // source_file is repeated on every row in the current upload — sample one.
  const sourceFile = (() => {
    for (const r of hubstaff.rows) {
      const v = r.source_file;
      if (v != null && String(v).trim() !== "") return String(v).trim();
    }
    return null;
  })();

  return {
    period: { cycleId, start, end, sourceFile },
    fxRate,
    byEmail,
  };
}
