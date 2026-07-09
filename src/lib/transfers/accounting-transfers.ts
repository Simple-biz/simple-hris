import { createSupabaseServiceRoleClient, createSupabaseServerClient } from '@/lib/supabase/server';
import {
  listAllTransferRequests,
  type DepartmentTransferRequestRow,
  type TransferRequestStatus,
} from '@/lib/supabase/department-transfer-requests';

/** The rate change linked to a transfer, resolved from employee_rate_history by
 *  the transfer's effective date. Null when Accounting hasn't set one yet. */
export interface TransferRateChange {
  effective_from: string;
  old_regular: number | null;
  old_ot: number | null;
  new_regular: number | null;
  new_ot: number | null;
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

type RateRow = { regular: number | null; ot: number | null; effective_from: string };

function parseNum(v: unknown): number | null {
  if (v == null || v === '') return null;
  const n = parseFloat(String(v).replace(/,/g, ''));
  return Number.isFinite(n) ? n : null;
}

/** All emails that could identify one transfer's employee in rate history. */
function candidateEmails(t: DepartmentTransferRequestRow): string[] {
  return [t.employee_work_email, t.employee_personal_email, t.employee_email]
    .map((e) => (e ?? '').trim().toLowerCase())
    .filter(Boolean);
}

/**
 * Resolve the rate change a transfer produced: the first rate-history entry
 * effective ON/AFTER the transfer's effective date is the "new" rate; the entry
 * in effect just before it is the "old" rate. Rows are ascending by date.
 */
function resolveRateChange(rows: RateRow[] | undefined, effDate: string): TransferRateChange | null {
  if (!rows || rows.length === 0) return null;
  const sorted = [...rows].sort((a, b) => a.effective_from.localeCompare(b.effective_from));
  const newIdx = sorted.findIndex((r) => r.effective_from >= effDate);
  if (newIdx < 0) return null; // no change on/after the transfer date yet
  const next = sorted[newIdx];
  const prev = newIdx > 0 ? sorted[newIdx - 1] : null;
  return {
    effective_from: next.effective_from,
    old_regular: prev?.regular ?? null,
    old_ot: prev?.ot ?? null,
    new_regular: next.regular,
    new_ot: next.ot,
  };
}

/**
 * Builds the Accounting Transfers view: every transfer request joined to the
 * pay-rate change it triggered (resolved from employee_rate_history by the
 * effective date). Pay-bearing — callers must gate to rate-visible roles.
 */
export async function buildAccountingTransfers(): Promise<{
  rows: AccountingTransferRow[];
  error: string | null;
}> {
  const { rows: transfers, error } = await listAllTransferRequests();
  if (error) return { rows: [], error };
  if (transfers.length === 0) return { rows: [], error: null };

  // Rate history for just the involved employees, indexed by lowercased email.
  const supabase = createSupabaseServiceRoleClient() ?? createSupabaseServerClient();
  const byEmail = new Map<string, RateRow[]>();
  if (supabase) {
    const emails = Array.from(new Set(transfers.flatMap((t) => candidateEmails(t))));
    if (emails.length > 0) {
      const { data } = await supabase
        .from('employee_rate_history')
        .select('employee_email, regular_rate, ot_rate, effective_from')
        .in('employee_email', emails);
      for (const r of (data ?? []) as Array<Record<string, unknown>>) {
        const em = String(r['employee_email'] ?? '').trim().toLowerCase();
        const eff = String(r['effective_from'] ?? '').slice(0, 10);
        if (!em || !eff) continue;
        const row: RateRow = {
          regular: parseNum(r['regular_rate']),
          ot: parseNum(r['ot_rate']),
          effective_from: eff,
        };
        const list = byEmail.get(em);
        if (list) list.push(row);
        else byEmail.set(em, [row]);
      }
    }
  }

  const rows: AccountingTransferRow[] = transfers.map((t) => {
    // Effective date drives the rate link (fall back to proposed for a request
    // still awaiting release, so Accounting sees the anticipated change).
    const effDate = t.effective_date || t.proposed_effective_date;
    let rateChange: TransferRateChange | null = null;
    if (effDate) {
      for (const em of candidateEmails(t)) {
        const hit = resolveRateChange(byEmail.get(em), effDate);
        if (hit) {
          rateChange = hit;
          break;
        }
      }
    }
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
