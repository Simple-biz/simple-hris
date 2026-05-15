/**
 * Stamps `employee_id` onto every `global_master_list` row currently lacking
 * one. Pulls the full roster so YYMM-NNNN numbering is deterministic across
 * same-month starters (the in-memory rule lives in `generateEmployeeIds`).
 *
 * Idempotent — rows that already have an `employee_id` pass through unchanged.
 * Used by:
 *   - POST /api/admin/backfill-employee-ids (one-shot fill after migration)
 *   - replaceGlobalMasterListFromCsvText (called after each upload so new
 *     hires get an ID before they're visible in the UI)
 *
 * Requires the column-add migration first:
 *   references/add_employee_id_to_global_master_list.sql
 *
 * Caller is responsible for providing a service-role client.
 */

import type { SupabaseClient } from '@supabase/supabase-js';
import { generateEmployeeIds, type EmployeeRow } from './employees';

const MASTER_TABLE =
  process.env.NEXT_PUBLIC_SUPABASE_EMPLOYEES_TABLE?.trim() || 'global_master_list';

export async function backfillEmployeeIds(
  supabase: SupabaseClient,
): Promise<{ assigned: number; skipped: number; error: string | null }> {
  const PAGE = 1000;
  const rows: {
    id: unknown;
    Name: string | null;
    'Start Date': string | null;
    employee_id: string | null;
  }[] = [];
  let from = 0;
  while (true) {
    const { data, error } = await supabase
      .from(MASTER_TABLE)
      .select('id,"Name","Start Date",employee_id')
      .range(from, from + PAGE - 1);
    if (error) return { assigned: 0, skipped: 0, error: error.message };
    const page = (data ?? []) as typeof rows;
    rows.push(...page);
    if (page.length < PAGE) break;
    from += PAGE;
  }

  const stubs: (EmployeeRow & { __dbId: unknown })[] = rows.map((r) => ({
    employee_id: r.employee_id?.trim() || null,
    department: null,
    name: r.Name ?? null,
    personal_email: null,
    start_date: r['Start Date'] ?? null,
    hourlyRate: null,
    bankInfo: null,
    __dbId: r.id,
  }));

  generateEmployeeIds(stubs);

  const updates = stubs
    .map((s, i) => {
      const before = rows[i].employee_id?.trim() || null;
      const after = s.employee_id;
      if (!before && after) return { id: s.__dbId, employee_id: after };
      return null;
    })
    .filter((x): x is { id: unknown; employee_id: string } => x !== null);

  let assigned = 0;
  const CONCURRENCY = 20;
  for (let start = 0; start < updates.length; start += CONCURRENCY) {
    const chunk = updates.slice(start, start + CONCURRENCY);
    const results = await Promise.all(
      chunk.map(({ id, employee_id }) =>
        supabase.from(MASTER_TABLE).update({ employee_id }).eq('id', id),
      ),
    );
    for (const res of results) {
      if (res.error) {
        return {
          assigned,
          skipped: rows.length - assigned,
          error: res.error.message,
        };
      }
    }
    assigned += chunk.length;
  }

  return {
    assigned,
    skipped: rows.length - assigned,
    error: null,
  };
}
