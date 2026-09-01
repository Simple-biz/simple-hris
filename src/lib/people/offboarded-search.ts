/**
 * People → Offboarded tab: pure search + bank-status assembly.
 *
 * The tab searches the WHOLE `offboarded_sheet` ledger at ROW grain — a
 * recycled work email deliberately returns every record that ever carried it
 * (they are different people; the row id is the identity). Matching and
 * bank-status folding live here, pure and node:test-able; the route
 * (`app/api/people/offboarded`) owns the reads.
 *
 * Bank status mirrors `offboarded-payroll-candidates.ts` exactly, because the
 * two surfaces must never disagree about whether a leaver is payable:
 *   - live `employee_ids` resolves a rail and passes `isPayoutComplete` → 'ok',
 *     and the LIVE processor is the one allowed to lock the Set Bank picker;
 *   - only an offboard snapshot resolves → 'missing_has_snapshot' with a
 *     prefill whose processor seeds the picker WITHOUT locking it (a locked
 *     picker skips writing `preferred_processor`, leaving the person unpayable);
 *   - neither → 'missing' ("No Bank").
 */

import {
  isPayoutComplete,
  resolveEffectivePayoutProcessor,
  payoutDraftFromIdsRow,
  type PayoutLegacyExtras,
} from '@/lib/employee/payout-completeness';
import type { OffboardedBankPrefill } from '@/lib/payroll/offboarded-payroll-candidates';

/** One `offboarded_sheet` ledger row, as the search route serves it. */
export interface OffboardedSearchHit {
  /** offboarded_sheet.id — THE row identity. Recycled work emails share
   *  nothing else, so every action on a row must carry this id's fields, never
   *  re-derive them from the email. */
  id: string;
  name: string | null;
  workEmail: string | null;
  personalEmail: string | null;
  department: string | null;
  /** Raw ledger "Start Date" (US-format, as stored). Populated on ~17% of rows
   *  — displayed when present, never a key. */
  startDate: string | null;
  offBoardedAt: string | null;
  origin: 'hris' | 'google_sheet';
}

export const OFFBOARDED_SEARCH_MIN_QUERY = 2;
export const OFFBOARDED_SEARCH_CAP = 50;

/**
 * Case-insensitive substring match on NAME and WORK EMAIL (the two fields Kane
 * named), preserving the caller's order (the ledger read is newest-departure
 * first). Under-length queries return nothing — the tab is search-first and a
 * 1-character query over 4,000+ rows is noise, not a result set.
 */
export function matchOffboardedRows<T extends { name: string | null; workEmail: string | null }>(
  rows: T[],
  query: string,
): { rows: T[]; total: number } {
  const q = query.trim().toLowerCase();
  if (q.length < OFFBOARDED_SEARCH_MIN_QUERY) return { rows: [], total: 0 };
  const matched = rows.filter(
    (r) =>
      (r.name ?? '').toLowerCase().includes(q) ||
      (r.workEmail ?? '').toLowerCase().includes(q),
  );
  return { rows: matched.slice(0, OFFBOARDED_SEARCH_CAP), total: matched.length };
}

export type OffboardedBankStatus = 'ok' | 'missing' | 'missing_has_snapshot';

export interface FoldedBankStatus {
  bankStatus: OffboardedBankStatus;
  /** LIVE-resolved rail only — the value that may LOCK the Set Bank picker.
   *  A snapshot processor deliberately never lands here (see module doc). */
  bankProcessor: string | null;
  /** Present only when bankStatus is 'missing_has_snapshot'. */
  bankPrefill: OffboardedBankPrefill | null;
}

/** Picks the first snapshot `employee_ids` row that actually resolves a
 *  processor — a person can carry more than one row (dual-department), and an
 *  empty/legacy row must not shadow a usable one. Mirrors
 *  offboarded-payroll-candidates.ts. */
export function pickSnapshotIdRow(
  rows: Record<string, unknown>[],
): Record<string, unknown> | null {
  return rows.find((r) => resolveEffectivePayoutProcessor(r)) ?? rows[0] ?? null;
}

/**
 * Fold one person's live `employee_ids` row (+ legacy rates-sheet fallbacks)
 * and their offboard snapshot into the tab's bank chip + Set Bank prefill.
 */
export function foldBankStatus(args: {
  idRow: Record<string, unknown> | null;
  extras?: PayoutLegacyExtras;
  snapshotIdRows: Record<string, unknown>[] | null;
}): FoldedBankStatus {
  const { idRow, extras, snapshotIdRows } = args;
  const payable = isPayoutComplete(idRow, extras);
  const bankProcessor = resolveEffectivePayoutProcessor(idRow, extras);
  if (payable) return { bankStatus: 'ok', bankProcessor, bankPrefill: null };

  const snapshotIdRow = snapshotIdRows ? pickSnapshotIdRow(snapshotIdRows) : null;
  const snapshotProcessor = snapshotIdRow ? resolveEffectivePayoutProcessor(snapshotIdRow) : null;
  if (snapshotIdRow && snapshotProcessor) {
    const draft = payoutDraftFromIdsRow(snapshotIdRow).payout;
    return {
      bankStatus: 'missing_has_snapshot',
      bankProcessor,
      bankPrefill: {
        processor: snapshotProcessor,
        walletEmail:
          snapshotProcessor === 'hurupay'
            ? draft.hurupayEmail
            : snapshotProcessor === 'wepay'
              ? draft.wepayEmail
              : snapshotProcessor === 'higlobe'
                ? draft.higlobeEmail
                : '',
        walletName: draft.higlobeAccountName,
        bankName: draft.bankName || draft.altBankName,
        accountHolder: draft.accountHolderName || draft.altAccountHolderName,
        accountNumber: draft.accountNumber || draft.altAccountNumber,
        swiftCode: draft.swiftCode || draft.altSwiftCode,
      },
    };
  }
  return { bankStatus: 'missing', bankProcessor, bankPrefill: null };
}
