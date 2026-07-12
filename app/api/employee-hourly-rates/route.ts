import {
  getEmployeeHourlyRateRowByEmail,
  getEmployeeHourlyRatesRows,
} from "@/lib/supabase/employee-hourly-rates";
import { getEmployeeMasterRecord } from "@/lib/supabase/employees";
import {
  authorizeEmailAccess,
  deniedResponse,
  getSessionRateVisibility,
} from "@/lib/auth/authorize-email";
import { hasRateVisibility } from "@/lib/auth/elevated-roles";
import { NextRequest, NextResponse } from "next/server";
import { cleanErrorMessage } from "@/lib/clean-error-message";
import { listPayStructures } from "@/lib/supabase/pay-structures-db";
import {
  buildCatalogRateIndex,
  resolveEmployeeCatalogRate,
  resolveDeptCatalogRate,
} from "@/lib/payroll/resolve-rate";
import { getAppSettings } from "@/lib/supabase/app-settings";
import { buildFxRates } from "@/lib/fx/currency-fx";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export async function GET(req: NextRequest) {
  try {
    const email = req.nextUrl.searchParams.get("email")?.trim();
    if (email) {
      // Self-or-elevated: a non-elevated caller may only read their own rate row;
      // the requested ?email= is resolved against the session, never trusted raw.
      const authz = await authorizeEmailAccess(email);
      if (!authz.ok) return deniedResponse(authz);
      // Pay rates are Accounting/CEO only. authorizeEmailAccess admits any
      // elevated role (incl. hr_coordinator) for cross-user reads — restrict
      // reading ANOTHER person's rate to full rate visibility. Self-view (own
      // email) is always allowed so the employee portal keeps showing own pay.
      const isSelf = authz.effectiveEmail.toLowerCase() === authz.sessionEmail.toLowerCase();
      if (!isSelf && !hasRateVisibility(authz.roles)) {
        return NextResponse.json({ rows: [], error: "Forbidden" }, { status: 403 });
      }
      const [{ row, error }, payStructures, fxValues] = await Promise.all([
        getEmployeeHourlyRateRowByEmail(authz.effectiveEmail),
        listPayStructures(),
        getAppSettings(["usd_to_php_rate", "usd_to_cop_rate"]),
      ]);
      // "Your current rate" with priority: individual catalog → sheet (the row)
      // → department base. The individual catalog rate overrides the row; the
      // department rate only fills in when the row has no rate at all. Returned
      // as PHP-equivalent. Historical per-day pay still resolves from rate
      // history elsewhere ("live cycle only").
      let outRow = row;
      const fx = buildFxRates(fxValues);
      const catIdx = buildCatalogRateIndex(payStructures.structures);
      const emails = [authz.effectiveEmail, row?.work_email ?? "", row?.personal_email ?? ""];
      const empCat = resolveEmployeeCatalogRate(catIdx, emails, fx);
      const hasSheet =
        !!row &&
        ((row.regular_rate != null && row.regular_rate !== "") ||
          (row.ot_rate != null && row.ot_rate !== ""));
      // Department base needs a department. Use the sheet row's when present,
      // otherwise resolve it from the master record — a catalog-only employee has
      // no rate row to carry it.
      let deptForFallback = row?.department ?? null;
      if (!hasSheet && !empCat && !deptForFallback) {
        const { employee } = await getEmployeeMasterRecord(authz.effectiveEmail);
        deptForFallback = employee?.department ?? null;
      }
      const deptCat = hasSheet ? null : resolveDeptCatalogRate(catIdx, deptForFallback, fx);
      const applied = empCat ?? deptCat;
      // The catalog is the source of truth: an individual/department structure
      // resolves a rate even when the employee has NO legacy sheet-cache row
      // (e.g. anyone onboarded after the Google-Sheet rates sync was disabled).
      // Without this a catalog-only employee saw "No rate" on their dashboard.
      if (applied) {
        outRow = {
          work_email: row?.work_email ?? null,
          personal_email: row?.personal_email ?? null,
          department: row?.department ?? deptForFallback ?? null,
          bank_preferred: row?.bank_preferred ?? null,
          hurupay_email: row?.hurupay_email ?? null,
          higlobe_email: row?.higlobe_email ?? null,
          higlobe_account_name: row?.higlobe_account_name ?? null,
          phone_number: row?.phone_number ?? null,
          full_address: row?.full_address ?? null,
          city: row?.city ?? null,
          province_state: row?.province_state ?? null,
          mesa_member: row?.mesa_member ?? null,
          mesa_member_since: row?.mesa_member_since ?? null,
          mesa_fpu_completed_on: row?.mesa_fpu_completed_on ?? null,
          regular_rate: String(applied.regPhp),
          ot_rate: String(applied.otPhp),
        };
      }
      return NextResponse.json({ rows: outRow ? [outRow] : [], error: error ? cleanErrorMessage(error) : null });
    }
    // Bulk (no ?email=): the whole rates table. Accounting (Payroll Wizard,
    // Overview) needs every numeric rate; the payroll-clerk dispatch queue and
    // HR (MESA enrollment) read only identity / mesa_member off these rows; an
    // employee (EmployeeMyHours) reads only their OWN rate to compute self-pay.
    // SECURITY: pay rates are Accounting/CEO only. A non-rate-visible caller
    // keeps ONLY their own rate row (matched on their gsuite aliases so a rate
    // row keyed on an alternate work email still resolves); every other person's
    // regular_rate/ot_rate is stripped. mesa_member, dispatch and identity
    // columns are always preserved.
    const { sessionEmail, rateVisible } = await getSessionRateVisibility();
    const { rows, error } = await getEmployeeHourlyRatesRows();
    let safeRows = rows;
    if (!rateVisible) {
      const aliases = new Set<string>();
      if (sessionEmail) {
        aliases.add(sessionEmail.toLowerCase());
        const { employee } = await getEmployeeMasterRecord(sessionEmail);
        for (const e of [
          employee?.work_email,
          employee?.personal_email,
          employee?.alternate_work_email,
          employee?.alternate_work_email_2,
        ]) {
          const n = (e ?? "").trim().toLowerCase();
          if (n) aliases.add(n);
        }
      }
      const isOwnRow = (r: { work_email?: string | null; personal_email?: string | null }): boolean => {
        const we = (r.work_email ?? "").trim().toLowerCase();
        const pe = (r.personal_email ?? "").trim().toLowerCase();
        return (!!we && aliases.has(we)) || (!!pe && aliases.has(pe));
      };
      safeRows = (rows ?? []).map((r) =>
        isOwnRow(r) ? r : { ...r, regular_rate: null, ot_rate: null },
      );
    }
    return NextResponse.json({ rows: safeRows, error: error ? cleanErrorMessage(error) : null });
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    return NextResponse.json({ rows: [], error: cleanErrorMessage(msg) });
  }
}
