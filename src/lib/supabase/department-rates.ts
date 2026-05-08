import { getEmployeeHourlyRatesRows } from "./employee-hourly-rates";

export type DepartmentRateSummary = {
  department: string;
  /** Most-frequent regular_rate seen in this department; null when no rates on file. */
  regular_rate: string | null;
  /** Most-frequent ot_rate seen in this department. */
  ot_rate: string | null;
  /** How many rate rows we found for the department — UI hint when the modal
   *  rate is based on a tiny sample. */
  count: number;
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

  const departments: DepartmentRateSummary[] = [];
  for (const [department, b] of buckets) {
    departments.push({
      department,
      regular_rate: pickMode(b.regularCounts),
      ot_rate: pickMode(b.otCounts),
      count: b.count,
    });
  }
  departments.sort((a, b) =>
    a.department.localeCompare(b.department, undefined, { sensitivity: "base" }),
  );
  return { departments, error: null };
}
