import type { PaymentDispatchRow } from '@/lib/supabase/payment-dispatches';

/**
 * The Payment Dispatch queue's "who is already paid this cycle" read.
 *
 * Why this exists: until 2026-10-08 the queue read this list with
 * `json.rows ?? []` and ignored the error. When the database slowed down
 * (2026-10-08, load avg 43, trivial reads 1–20 s) the read timed out, the route
 * answered `{ rows: [], error }`, and the queue took that as "nobody has been
 * paid": paid people were painted back into Pending, where a clerk could pay
 * them again. The cycle-id lookup in front of it had the same hole, because a
 * failed read came back as "no cycle".
 *
 * So this read fails LOUD. Any failure throws, and `useDispatchQueue.load()`
 * keeps the last good queue on screen (or shows the error) instead of drawing
 * an empty paid list. Only a SUCCESSFUL "no cycle yet" answer means [].
 */
export async function fetchCyclePaidDispatches(
  fetchImpl: typeof fetch,
  /** `''` for the live cycle, or `?source_file=…` for a picked past week. */
  cycleQuery: string,
  signal?: AbortSignal,
): Promise<PaymentDispatchRow[]> {
  const cycleRes = await fetchImpl(`/api/current-cycle${cycleQuery}`, { cache: 'no-store', signal });
  const cycleJson = (await cycleRes.json().catch(() => ({}))) as {
    cycleId?: string | null;
    error?: string | null;
  };
  if (!cycleRes.ok || cycleJson.error) {
    throw new Error(
      `Could not read this week's cycle, so who is already paid is unknown: ${cycleJson.error || `HTTP ${cycleRes.status}`}`,
    );
  }
  const cycleId = cycleJson.cycleId ?? null;
  if (!cycleId) return [];

  const dispatchRes = await fetchImpl(
    `/api/payment-dispatches?cycle_id=${encodeURIComponent(cycleId)}`,
    { cache: 'no-store', signal },
  );
  const dispatchJson = (await dispatchRes.json().catch(() => ({}))) as {
    rows?: PaymentDispatchRow[];
    error?: string | null;
  };
  if (!dispatchRes.ok || dispatchJson.error || !Array.isArray(dispatchJson.rows)) {
    throw new Error(
      `Could not read who is already paid this week: ${dispatchJson.error || `HTTP ${dispatchRes.status}`}`,
    );
  }
  return dispatchJson.rows;
}
