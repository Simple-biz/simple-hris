import { getDepartmentRegistry } from '@/lib/departments/registry-db';
import {
  listAllTransferRequests,
  type TransferRequestStatus,
} from '@/lib/supabase/department-transfer-requests';
import { listPayStructures } from '@/lib/supabase/pay-structures-db';
import { buildCatalogRateIndex, type CatalogRateIndex } from '@/lib/payroll/resolve-rate';
import { normalizeDeptToKey } from '@/lib/payroll/normalize-dept-key';
import { hslSubKeyFromRaw, hslSubDeptLabel } from '@/lib/departments/hsl-subdept';
import type { PayCurrency, PayStructure } from '@/lib/payment-catalog/pay-structure';

/** The pay-rate change a transfer produces, read from the Payment Catalog: the
 *  base rate of the department the employee left ("old") vs. the base rate of
 *  the department they joined ("new"). Each side carries its own currency
 *  because departments can be paid in PHP or USD. A side is null when that
 *  department has no catalog rate set yet. */
export interface TransferRateChange {
  old_regular: number | null;
  old_ot: number | null;
  old_currency: PayCurrency | null;
  new_regular: number | null;
  new_ot: number | null;
  new_currency: PayCurrency | null;
}

export interface AccountingTransferRow {
  id: string;
  employee_name: string | null;
  employee_email: string;
  from_department: string;
  to_department: string;
  status: TransferRequestStatus;
  requested_by: string;
  /** Source manager who released/declined (reuses approver_email). */
  decided_by: string | null;
  effective_date: string | null;
  proposed_effective_date: string | null;
  applied_at: string | null;
  sheet_synced: boolean;
  sheet_sync_error: string | null;
  created_at: string;
  reason: string | null;
  /** Rate change effective on/after the transfer date, or null if none yet. */
  rate_change: TransferRateChange | null;
}

/** Look up a department-scoped catalog structure by its (possibly raw) name. */
function deptStructure(
  index: CatalogRateIndex,
  deptRaw: string | null | undefined,
): PayStructure | null {
  if (!deptRaw) return null;
  // Sub-department base first — MUST mirror resolveDeptCatalogRate, or a move
  // between two HSL sub-teams (or in/out of one) would report the parent's rate
  // on both sides and read as "no change" when the rate genuinely moves.
  const subKey = hslSubKeyFromRaw(deptRaw);
  if (subKey) {
    const sub = index.byDeptKey.get(hslSubDeptLabel(subKey));
    if (sub) return sub;
  }
  // Accept either a raw department name or an already-canonical key.
  const key = normalizeDeptToKey(deptRaw) ?? (index.byDeptKey.has(deptRaw) ? deptRaw : null);
  if (!key) return null;
  return index.byDeptKey.get(key) ?? null;
}

/**
 * Resolve the department-to-department rate change a transfer represents: the
 * Payment Catalog base rate of the FROM department vs. the base rate of the TO
 * department. Null when neither department has a catalog rate set.
 *
 * Note: this compares department BASE rates. An employee with a negotiated
 * individual rate keeps it across a move (individual wins over the department
 * base at pay time), so this column reflects the departmental rate difference,
 * not necessarily that one person's take-home change.
 */
function resolveDeptRateChange(
  index: CatalogRateIndex,
  fromDept: string | null | undefined,
  toDept: string | null | undefined,
): TransferRateChange | null {
  const from = deptStructure(index, fromDept);
  const to = deptStructure(index, toDept);
  if (!from && !to) return null;
  return {
    old_regular: from?.regularRate ?? null,
    old_ot: from?.otRate ?? null,
    old_currency: from?.currency ?? null,
    new_regular: to?.regularRate ?? null,
    new_ot: to?.otRate ?? null,
    new_currency: to?.currency ?? null,
  };
}

/**
 * Builds the Accounting Transfers view: every transfer request joined to the
 * department-to-department pay-rate change it represents (the Payment Catalog
 * base rate of the FROM department vs. the TO department). Pay-bearing —
 * callers must gate to rate-visible roles.
 */
export async function buildAccountingTransfers(): Promise<{
  rows: AccountingTransferRow[];
  error: string | null;
}> {
  const { rows: transfers, error } = await listAllTransferRequests();
  if (error) return { rows: [], error };
  if (transfers.length === 0) return { rows: [], error: null };

  // Payment Catalog department base rates drive the from/to rate comparison.
  const [{ structures }, deptRegistry] = await Promise.all([
    listPayStructures(),
    // Renamed in-app departments resolve their base rate by alias slug.
    getDepartmentRegistry().catch(() => []),
  ]);
  const catalogIndex = buildCatalogRateIndex(structures, deptRegistry);

  const rows: AccountingTransferRow[] = transfers.map((t) => {
    const rateChange = resolveDeptRateChange(catalogIndex, t.from_department, t.to_department);
    return {
      id: t.id,
      employee_name: t.employee_name,
      employee_email: t.employee_email,
      from_department: t.from_department,
      to_department: t.to_department,
      status: t.status,
      requested_by: t.requested_by,
      decided_by: t.approver_email,
      effective_date: t.effective_date,
      proposed_effective_date: t.proposed_effective_date,
      applied_at: t.applied_at,
      sheet_synced: t.sheet_synced,
      sheet_sync_error: t.sheet_sync_error,
      created_at: t.created_at,
      reason: t.reason,
      rate_change: rateChange,
    };
  });

  return { rows, error: null };
}
