// Admin kill-switches for the live-collaboration layer (presence avatar rail,
// live cursors, ping, screen-observe) on the Accounting and HR dashboards.
// Added after these always-on Supabase Realtime channels turned out to be the
// dominant driver of a 300% Realtime message-quota overage — CollabLayer
// broadcasts cursor position at ~60fps unconditionally, even with nobody else
// in the room to see it. Absent/'true' -> collab stays on (today's behavior);
// 'false' -> that dashboard's CollabLayer never mounts, so it opens zero
// channels and sends zero messages.
//
// Client-safe: constants + pure parsing only, no Supabase imports (mirrors the
// convention in dept-pay-config.ts).

export const COLLAB_ACCOUNTING_ENABLED_KEY = 'collab.accounting.enabled';
export const COLLAB_HR_ENABLED_KEY = 'collab.hr.enabled';

/** Absent or malformed reads as enabled (the safe default — collab stays on). */
export function parseCollabEnabled(raw: string | null | undefined): boolean {
  return raw !== 'false';
}
