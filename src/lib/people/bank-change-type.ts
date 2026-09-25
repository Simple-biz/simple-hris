import { PROCESSOR_OPTIONS, processorIdFromBankPreferredText } from '@/lib/employee-payment-processors';

/**
 * Bank-type buckets for the People → Bank changes FEED filter
 * (bank-preferred-routing.md §10.7).
 *
 * The bucket is read off the change row's own `processor` — what
 * `bank_update_history` recorded at save time, which for every self-service and
 * People → Banking write is the RECEIVE election (`preferred_processor`), never
 * the send-from rail. So this scopes the feed only: it must never re-scope the
 * send-from KPI band (§10.3).
 *
 * A filter never hides a row: blank processors get their own bucket, and a
 * stored value no resolver recognises buckets under its own text rather than
 * vanishing.
 */

export const NO_BANK_TYPE = '__none__';

/** The bucket a change row files under. Normalised through the shared text
 *  resolver, so `kolan` / `x1153` land with `hurupay` / `wires`. */
export function bankTypeKey(processor: string | null | undefined): string {
  const raw = (processor ?? '').trim();
  if (!raw) return NO_BANK_TYPE;
  return processorIdFromBankPreferredText(raw) ?? raw.toLowerCase();
}

/** Human label for a bucket — the processor's post-rebrand label (hurupay → Kolan). */
export function bankTypeLabel(key: string): string {
  if (key === NO_BANK_TYPE) return 'No bank type recorded';
  return PROCESSOR_OPTIONS.find((p) => p.id === key)?.label ?? key;
}

/** One option per bucket present in `processors`: known processors in
 *  PROCESSOR_OPTIONS order, then unrecognised text alphabetically, then the
 *  blank bucket last. */
export function bankTypeOptions(
  processors: readonly (string | null | undefined)[],
): { value: string; label: string }[] {
  const keys = new Set(processors.map(bankTypeKey));
  const known = PROCESSOR_OPTIONS.map((p) => p.id as string).filter((id) => keys.has(id));
  const unknown = [...keys]
    .filter((k) => k !== NO_BANK_TYPE && !known.includes(k))
    .sort((a, b) => a.localeCompare(b));
  const ordered = [...known, ...unknown, ...(keys.has(NO_BANK_TYPE) ? [NO_BANK_TYPE] : [])];
  return ordered.map((value) => ({ value, label: bankTypeLabel(value) }));
}
