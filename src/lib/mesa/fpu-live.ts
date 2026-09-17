/**
 * The FPU surfaces' live channel — browser-safe constants shared by the routes
 * that write (they broadcast from the server) and the two views that listen.
 *
 * Why Broadcast and not `postgres_changes`: the browser is `anon`, and both
 * `fpu_classes` and `fpu_enrollments` have RLS on with zero policies, so a row
 * event can never reach a dashboard (memory/supabase-realtime-anon-rls-dead).
 * The route that just wrote the row announces it instead; every listener also
 * keeps a poll floor, so a lost message costs seconds, never correctness.
 *
 * OWN topic — never reuse dispatch / paid / start-processing: realtime-js keeps
 * one channel per topic per client, and a second `.channel()` on a topic the
 * page already joined collides with it.
 */
export const FPU_LIVE_TOPIC = 'fpu-classes-sync';
export const FPU_LIVE_EVENT = 'changed';

export interface FpuLivePayload {
  /** What moved: a class row or an enrollment row. */
  kind: 'class' | 'enrollment';
  /** The class the change belongs to, when known. */
  classId: string | null;
  /** Emails whose own enrollment moved (the employee view narrows on this). */
  emails?: string[];
  ts: number;
}

/** Fallback cadence when the socket is down or the change came from outside the app. */
export const FPU_LIVE_POLL_MS = 15_000;
/** Coalesce a bulk decision's burst into one reload. */
export const FPU_LIVE_DEBOUNCE_MS = 400;
