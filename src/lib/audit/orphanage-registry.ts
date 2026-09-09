import type { OrphanageRow } from '@/lib/supabase/orphanages';
import { maskAccountLast4 } from '@/lib/payroll/mask-account';

/**
 * The audit-safe shape of an orphanage row.
 *
 * The row carries the RECEIVING bank for the interns' orphanage share, so an
 * edit here can redirect money — the trail has to hold enough to reconstruct
 * what changed, and no more than that. The account number is reduced to its
 * last four the same way every other artifact does it (`maskAccountLast4`, the
 * one masker: see its header for why it lives alone).
 */
export function orphanageAuditSnapshot(row: OrphanageRow): Record<string, unknown> {
  return {
    id: row.id,
    name: row.name,
    location: row.location,
    children: row.children,
    phone: row.phone,
    email: row.email,
    leftover_budget: row.leftover_budget,
    bank_name: row.bank_name || null,
    bank_account_name: row.bank_account_name || null,
    bank_account_last4: maskAccountLast4(row.bank_account_number),
    swift_code: row.swift_code || null,
    has_image: Boolean(row.image_url),
    created_by: row.created_by,
    created_at: row.created_at,
  };
}

/**
 * Which fields an edit actually changed, before→after, masked.
 *
 * Names the fields even when a value is identical-but-retyped is NOT wanted —
 * only real changes are listed, so "who touched the bank details" has a
 * truthful answer.
 */
export function orphanageAuditDiff(
  before: OrphanageRow,
  after: OrphanageRow,
): Array<{ field: string; from: unknown; to: unknown }> {
  const b = orphanageAuditSnapshot(before);
  const a = orphanageAuditSnapshot(after);
  const changes: Array<{ field: string; from: unknown; to: unknown }> = [];
  for (const key of Object.keys(a)) {
    // Identity and stamps are context, not edits.
    if (key === 'id' || key === 'created_by' || key === 'created_at') continue;
    if (JSON.stringify(b[key]) !== JSON.stringify(a[key])) {
      changes.push({ field: key, from: b[key] ?? null, to: a[key] ?? null });
    }
  }
  return changes;
}
