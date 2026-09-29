/**
 * The KPI bonus live channel — browser-safe constants shared by the routes that
 * change what a published KPI week pays (they broadcast from the server,
 * `kpi-live-server.ts`) and every dashboard that shows a KPI figure or a KPI
 * week's status (they listen through `useKpiLive`).
 *
 * Why Broadcast and not `postgres_changes`: the browser client is `anon`, and a
 * row event on an RLS-guarded table never reaches it
 * (memory/supabase-realtime-anon-rls-dead). Every KPI surface that "subscribed"
 * to `hsl_bonus_period_status` / `bonus_catalog_applied` / `hsl_bonus_entries`
 * was in practice running on its poll. The route that just wrote the row
 * announces it instead, so a Lock reaches every open dashboard in about a second.
 *
 * OWN topic — never reuse the dispatch / paid / start-processing / PAB / FPU /
 * gift / support topics: realtime-js keeps one channel per topic per client, and
 * a second `.channel()` on a topic the page already joined collides with it.
 *
 * The payload is a RE-READ signal, never the value. A listener always fetches
 * the figure from its own gated route, so a forged or stale message can cost a
 * re-read but can never paint a number.
 */

export const KPI_LIVE_TOPIC = 'kpi-bonus-sync';
export const KPI_LIVE_EVENT = 'changed';

export type KpiLiveStatus = 'draft' | 'ready' | 'locked';

export interface KpiLivePayload {
  /** `status` = Mark Ready / Lock / reopen; `bonus` = a bonus row changed on a
   *  week that is already ready or locked. */
  kind: 'status' | 'bonus';
  /** `hsl_bonus_period_status.department` — a catalog dept key or `hsl:<key>`. */
  department: string;
  /** ISO `period_start` of the dept-week. */
  periodStart: string;
  /** The status the week now has, when the writer knows it. */
  status: KpiLiveStatus | null;
  ts: number;
}

/**
 * Parse a received payload. Anything malformed becomes `null` — still a valid
 * "something changed, re-read" signal, never a reason to drop the refresh.
 */
export function parseKpiLivePayload(raw: unknown): KpiLivePayload | null {
  if (!raw || typeof raw !== 'object') return null;
  const p = raw as Record<string, unknown>;
  const kind = p.kind === 'status' || p.kind === 'bonus' ? p.kind : null;
  if (!kind || typeof p.department !== 'string' || typeof p.periodStart !== 'string') return null;
  const status =
    p.status === 'draft' || p.status === 'ready' || p.status === 'locked' ? p.status : null;
  const ts = typeof p.ts === 'number' && Number.isFinite(p.ts) ? p.ts : Date.now();
  return { kind, department: p.department, periodStart: p.periodStart, status, ts };
}

/** A status write always announces — a reopen takes a week OUT of every view,
 *  which is as much a change as a Lock. A bonus write announces only on a
 *  published week: drafts are invisible to employees, the wizard and rankings,
 *  and the KPI Calculator autosaves drafts on every debounced keystroke. */
export function bonusWriteAnnounces(status: string | null | undefined): boolean {
  return status === 'ready' || status === 'locked';
}

/** Coalesce a burst (a Lock that also re-saves the week's bonus rows) into one
 *  re-read per surface. */
export const KPI_LIVE_DEBOUNCE_MS = 400;

/**
 * Employee surfaces add a random 0..N ms spread before the re-read. The topic is
 * company-wide, so one Lock reaches every open employee tab at once; the spread
 * turns that into a trickle and still lands inside two seconds.
 */
export const KPI_LIVE_EMPLOYEE_SPREAD_MS = 1500;
