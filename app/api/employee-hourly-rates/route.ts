import {
  getEmployeeHourlyRateRowByEmail,
  getEmployeeHourlyRatesRows,
} from "@/lib/supabase/employee-hourly-rates";
import { authorizeEmailAccess, deniedResponse } from "@/lib/auth/authorize-email";
import { NextRequest, NextResponse } from "next/server";
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
      if (row) {
        const fx = buildFxRates(fxValues);
        const catIdx = buildCatalogRateIndex(payStructures.structures);
        const emails = [authz.effectiveEmail, row.work_email ?? "", row.personal_email ?? ""];
        const empCat = resolveEmployeeCatalogRate(catIdx, emails, fx);
        const hasSheet =
          (row.regular_rate != null && row.regular_rate !== "") ||
          (row.ot_rate != null && row.ot_rate !== "");
        const deptCat = hasSheet ? null : resolveDeptCatalogRate(catIdx, row.department, fx);
        const applied = empCat ?? deptCat;
        if (applied) {
          outRow = {
            ...row,
            regular_rate: String(applied.regPhp),
            ot_rate: String(applied.otPhp),
          };
        }
      }
      return NextResponse.json({ rows: outRow ? [outRow] : [], error });
    }
    const { rows, error } = await getEmployeeHourlyRatesRows();
    return NextResponse.json({ rows, error });
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    return NextResponse.json({ rows: [], error: msg });
  }
}
