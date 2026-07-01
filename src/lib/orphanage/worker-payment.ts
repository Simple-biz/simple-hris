// Client-safe types + pure helpers for orphanage worker payments (carpenters /
// handymen / musicians who aren't on payroll). Kept free of any server-only
// import (no Supabase client) so client components can use `workerTypeLabel`
// without pulling server code into the browser bundle. The DB access layer
// lives in `src/lib/supabase/orphanage-worker-payments.ts`, which re-exports
// these for server callers.

export type OrphanageWorkerType = 'handyman' | 'musician' | 'other';

export interface OrphanageWorkerPaymentRow {
  id: string;
  recipient_name: string;
  worker_type: OrphanageWorkerType;
  /** Free-text label when worker_type === 'other' (e.g. "Gardener"). */
  type_label: string | null;
  /** Informational period label the clerk typed ("Jun 8–14"). */
  pay_week: string | null;
  amount_php: number;
  bank_name: string;
  bank_account_name: string;
  bank_account_number: string;
  swift_code: string;
  note: string | null;
  created_by: string | null;
  created_at: string;
  updated_at: string;
}

export interface UpsertOrphanageWorkerPaymentInput {
  recipient_name: string;
  worker_type: OrphanageWorkerType;
  type_label?: string | null;
  pay_week?: string | null;
  amount_php: number;
  bank_name?: string | null;
  bank_account_name?: string | null;
  bank_account_number?: string | null;
  swift_code?: string | null;
  note?: string | null;
  created_by?: string | null;
}

/** Human display label for a worker: the custom label for 'other', else the category. */
export function workerTypeLabel(row: {
  worker_type: OrphanageWorkerType;
  type_label?: string | null;
}): string {
  if (row.worker_type === 'handyman') return 'Handyman';
  if (row.worker_type === 'musician') return 'Musician';
  return row.type_label?.trim() || 'Other';
}
