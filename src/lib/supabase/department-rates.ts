import { getEmployeeHourlyRatesRows } from "./employee-hourly-rates";
import { listPayStructures } from "./pay-structures-db";
import { DEPARTMENTS } from "@/lib/payroll/department-bonus";
import { getDepartmentRegistry } from "@/lib/departments/registry-db";
import type { PayCurrency } from "@/lib/payment-catalog/pay-structure";

export type DepartmentRateSummary = {
  department: string;
  /** Most-frequent regular_rate seen in this department; null when no rates on file. */
  regular_rate: string | null;
  /** Most-frequent ot_rate seen in this department. */
  ot_rate: string | null;
  /** How many rate rows we found for the department — UI hint when the modal
   *  rate is based on a tiny sample. */
  count: number;
  /**
   * Where the rate came from. `catalog` means an authoritative Payment Catalog
   * pay structure (source of truth) overrode the observed mode; `observed` is
   * the historical most-common-value heuristic.
   */
  source: "catalog" | "observed";
  /** Currency of the rate. Observed rates carry no currency (null). */
  currency: PayCurrency | null;
};

/**
 * Computes a department → typical-rate map from `employee_hourly_rates`.
 *
 * "Typical" = mode (most-common value). Median would be more robust to outliers
 * but rates within a department are usually clustered tightly; the mode pre-fill
 * matches what HR would copy from a peer's row anyway. Form lets the user override.
 */
export async function getDepartmentRateSummaries(): Promise<{
  departments: DepartmentRateSummary[];
  error: string | null;
}> {
  const { rows, error } = await getEmployeeHourlyRatesRows();
  if (error) return { departments: [], error };

  const buckets = new Map<
    string,
    { regularCounts: Map<string, number>; otCounts: Map<string, number>; count: number }
  >();

  for (const r of rows) {
    const dept = r.department?.trim();
    if (!dept) continue;
    let bucket = buckets.get(dept);
    if (!bucket) {
      bucket = {
        regularCounts: new Map(),
        otCounts: new Map(),
        count: 0,
      };
      buckets.set(dept, bucket);
    }
    bucket.count += 1;
    const reg = r.regular_rate?.trim();
    if (reg) bucket.regularCounts.set(reg, (bucket.regularCounts.get(reg) ?? 0) + 1);
    const ot = r.ot_rate?.trim();
    if (ot) bucket.otCounts.set(ot, (bucket.otCounts.get(ot) ?? 0) + 1);
  }

  function pickMode(counts: Map<string, number>): string | null {
    let best: string | null = null;
    let bestN = 0;
    for (const [val, n] of counts) {
      if (n > bestN) {
        best = val;
        bestN = n;
      }
    }
    return best;
  }

  const byName = new Map<string, DepartmentRateSummary>();
  for (const [department, b] of buckets) {
    byName.set(department.trim().toLowerCase(), {
      department,
      regular_rate: pickMode(b.regularCounts),
      ot_rate: pickMode(b.otCounts),
      count: b.count,
      source: "observed",
      currency: null,
    });
  }

  // Overlay authoritative Payment Catalog department pay structures. Catalog
  // wins where defined; departments with no catalog entry keep the observed
  // mode. Best-effort: if the catalog table is missing/unreachable, fall back
  // to the observed rates rather than failing the onboarding prefill.
  try {
    const { structures } = await listPayStructures();
    const deptName = new Map(DEPARTMENTS.map((d) => [d.key, d.name] as const));
    // Custom (Department-tab) departments key their structures by a slug the
    // built-in map doesn't know -- resolve those to the real roster label so
    // the onboarding prefill finds them. Best-effort: a registry read failure
    // must not cost the built-in overlay.
    try {
      for (const entry of await getDepartmentRegistry()) {
        if (!deptName.has(entry.key)) deptName.set(entry.key, entry.name);
      }
    } catch {
      /* built-in departments only */
    }
    for (const s of structures) {
      if (s.scope !== "department") continue;
      const name = deptName.get(s.departmentKey) ?? s.departmentKey;
      const key = name.trim().toLowerCase();
      const prior = byName.get(key);
      byName.set(key, {
        department: prior?.department ?? name,
        regular_rate: String(s.regularRate),
        ot_rate: s.otRate != null ? String(s.otRate) : null,
        count: prior?.count ?? 0,
        source: "catalog",
        currency: s.currency,
      });
    }
  } catch {
    /* keep observed rates */
  }

  const departments = [...byName.values()].sort((a, b) =>
    a.department.localeCompare(b.department, undefined, { sensitivity: "base" }),
  );
  return { departments, error: null };
}
