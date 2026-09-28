/**
 * The PAB period's live channel — browser-safe constants shared by the route
 * that writes the period (`POST /api/app-settings` broadcasts from the server)
 * and the employee Overview that listens (`usePabPeriodSettings({ live: true })`).
 *
 * Why Broadcast and not `postgres_changes`: the browser is `anon` and
 * `app_settings` is RLS "Admins only", so a row event can never reach a
 * dashboard (memory/supabase-realtime-anon-rls-dead). The route that just wrote
 * the key announces it instead; the listener also keeps a poll floor and a
 * tab-focus re-read, so a lost message costs minutes, never correctness.
 *
 * OWN topic — never reuse dispatch / paid / start-processing / FPU /
 * `payroll-wizard-pab-decisions`: realtime-js keeps one channel per topic per
 * client, and a second `.channel()` on a topic the page already joined
 * collides with it.
 *
 * The payload names the key and nothing else. It is a "re-read" signal, never
 * the value — the listener always fetches the stored settings, so a forged or
 * stale message can cost a re-read but can never paint a window.
 */
import {
  PAB_PERIOD_ACTIVE_MONTH_KEY,
  PAB_PERIOD_END_KEY,
  PAB_PERIOD_MANUAL_KEY,
  PAB_PERIOD_OVERRIDES_KEY,
  PAB_PERIOD_START_KEY,
} from '@/lib/pab-period-settings';

export const PAB_PERIOD_LIVE_TOPIC = 'pab-period-sync';
export const PAB_PERIOD_LIVE_EVENT = 'changed';

/**
 * The keys whose write moves the PAB window an employee is shown: the
 * per-month overrides, the month the wizard evaluates, and the legacy
 * single-range trio `fetchPabPeriodSettings` still migrates on read.
 */
export const PAB_PERIOD_LIVE_KEYS: readonly string[] = [
  PAB_PERIOD_OVERRIDES_KEY,
  PAB_PERIOD_ACTIVE_MONTH_KEY,
  PAB_PERIOD_MANUAL_KEY,
  PAB_PERIOD_START_KEY,
  PAB_PERIOD_END_KEY,
];

/** Exact key match — the period keys are fixed names, never a family prefix. */
export function isPabPeriodLiveKey(key: string): boolean {
  return PAB_PERIOD_LIVE_KEYS.includes(key.trim());
}

export interface PabPeriodLivePayload {
  key: string;
  ts: number;
}

/** Fallback cadence when the socket is down or a message was lost. */
export const PAB_PERIOD_LIVE_POLL_MS = 5 * 60_000;
/** Coalesce a save burst (overrides write + active-month write) into one re-read. */
export const PAB_PERIOD_LIVE_DEBOUNCE_MS = 400;
