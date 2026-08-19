/**
 * Employee Penny AI's daily allowance — pure arithmetic, shared by the route
 * (which enforces it) and the chat bubble (which displays it).
 *
 * Kane, 2026-08-19: ten prompts, on a DAILY cycle. The day is the Asia/Manila
 * calendar day — the company clock, the same reference the Admin Penny route
 * stamps "today" against and the same one payroll weeks are read in
 * (`src/lib/payroll/manila-week.ts`).
 *
 * No `server-only` here on purpose: the bubble renders `warnLevel` and
 * `resetsAtIso` client-side, and duplicating this arithmetic in the component is
 * how the displayed number drifts from the enforced one.
 */

/** Prompts per employee per Manila day. */
export const EMPLOYEE_PENNY_DAILY_LIMIT = 10;

/**
 * Manila is a fixed **UTC+08:00** with no daylight saving (and has been since
 * 1978), so the day boundary is safe to build from the offset literal. Doing it
 * this way — rather than nudging a UTC date by 8 hours — keeps the boundary
 * exact on the two days a DST-aware zone would shift, and makes the intent
 * legible in the ISO string itself.
 */
const MANILA_UTC_OFFSET = '+08:00';

/** Today's date in Manila, `YYYY-MM-DD`. `en-CA` formats exactly that way. */
export function manilaDayIso(now: Date = new Date()): string {
  return new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Manila' }).format(now);
}

/** The instant Manila's calendar day began — the lower bound of "today". */
export function manilaDayStartIso(now: Date = new Date()): string {
  return new Date(`${manilaDayIso(now)}T00:00:00${MANILA_UTC_OFFSET}`).toISOString();
}

/** The instant the allowance refills: next Manila midnight. */
export function nextManilaMidnightIso(now: Date = new Date()): string {
  const [y, m, d] = manilaDayIso(now).split('-').map(Number);
  // Date.UTC normalizes month/day overflow, so the 31st rolls into next month.
  const next = new Date(Date.UTC(y!, m! - 1, d! + 1)).toISOString().slice(0, 10);
  return new Date(`${next}T00:00:00${MANILA_UTC_OFFSET}`).toISOString();
}

/**
 * How loudly the UI should warn. Kane, 2026-08-19: *"there should be sufficient
 * warning before it greys out or locks out"* — so the panel escalates on the way
 * down instead of going quiet and then dead.
 */
export type PennyWarnLevel = 'none' | 'low' | 'last' | 'exhausted';

export interface EmployeePennyQuota {
  limit: number;
  used: number;
  remaining: number;
  exhausted: boolean;
  warnLevel: PennyWarnLevel;
  /** ISO instant the count resets (next Manila midnight). */
  resetsAtIso: string;
  /**
   * True when the asker holds an elevated role and is not metered at all
   * (Q3(a), Kane 2026-08-19). The UI hides the counter entirely for these.
   */
  exempt: boolean;
}

/**
 * Build the quota view from the number of CHARGED prompts used today.
 *
 * `used` is clamped into `[0, limit]` for display, so a ledger that somehow holds
 * more rows than the limit (two tabs racing past the pre-check, a limit lowered
 * after the fact) reads as "0 left" rather than a negative remaining. It is
 * never clamped for the *decision* — `exhausted` is `used >= limit`, so extra
 * rows still lock the composer.
 */
export function quotaFromUsed(
  used: number,
  opts: { now?: Date; limit?: number; exempt?: boolean } = {},
): EmployeePennyQuota {
  const limit = opts.limit ?? EMPLOYEE_PENNY_DAILY_LIMIT;
  const now = opts.now ?? new Date();
  const exempt = opts.exempt ?? false;
  const safeUsed = Number.isFinite(used) ? Math.max(0, Math.trunc(used)) : limit;
  const remaining = Math.max(0, limit - safeUsed);
  const exhausted = !exempt && safeUsed >= limit;

  return {
    limit,
    used: Math.min(safeUsed, limit),
    remaining,
    exhausted,
    warnLevel: exempt ? 'none' : warnLevelFor(remaining),
    resetsAtIso: nextManilaMidnightIso(now),
    exempt,
  };
}

function warnLevelFor(remaining: number): PennyWarnLevel {
  if (remaining <= 0) return 'exhausted';
  if (remaining === 1) return 'last';
  if (remaining <= 3) return 'low';
  return 'none';
}

/** "Resets 12:00 AM" — the reset instant in the reader's own locale. */
export function formatResetTime(resetsAtIso: string): string {
  const dt = new Date(resetsAtIso);
  if (Number.isNaN(dt.getTime())) return 'midnight';
  return dt.toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' });
}

/**
 * The one line the bubble shows under the composer. Kept here so the warning
 * copy can't drift between the header pill and the exhausted state.
 */
export function quotaMessage(q: EmployeePennyQuota): string | null {
  if (q.exempt) return null;
  switch (q.warnLevel) {
    case 'exhausted':
      return `You've used all ${q.limit} of today's questions. Penny is back at ${formatResetTime(q.resetsAtIso)} — for anything urgent, ask your manager or HR.`;
    case 'last':
      return `This is your last question today. Penny resets at ${formatResetTime(q.resetsAtIso)}.`;
    case 'low':
      return `${q.remaining} questions left today.`;
    default:
      return null;
  }
}

/** Wire shape for the `X-Penny-Quota` header / the GET endpoint. */
export interface PennyQuotaWire {
  limit: number;
  used: number;
  remaining: number;
  exhausted: boolean;
  resetsAt: string;
  exempt: boolean;
}

export function quotaToWire(q: EmployeePennyQuota): PennyQuotaWire {
  return {
    limit: q.limit,
    used: q.used,
    remaining: q.remaining,
    exhausted: q.exhausted,
    resetsAt: q.resetsAtIso,
    exempt: q.exempt,
  };
}

/**
 * Rebuild the full quota from a wire payload. `warnLevel` is recomputed rather
 * than transported so the escalation thresholds live in exactly one place.
 */
export function quotaFromWire(w: PennyQuotaWire): EmployeePennyQuota {
  return {
    limit: w.limit,
    used: w.used,
    remaining: w.remaining,
    exhausted: w.exhausted,
    warnLevel: w.exempt ? 'none' : warnLevelFor(w.remaining),
    resetsAtIso: w.resetsAt,
    exempt: w.exempt,
  };
}

/** Parse the `X-Penny-Quota` header. Returns null on anything unexpected. */
export function parseQuotaHeader(raw: string | null): EmployeePennyQuota | null {
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw) as Partial<PennyQuotaWire>;
    if (
      typeof parsed.limit !== 'number' ||
      typeof parsed.used !== 'number' ||
      typeof parsed.remaining !== 'number' ||
      typeof parsed.resetsAt !== 'string'
    ) {
      return null;
    }
    return quotaFromWire({
      limit: parsed.limit,
      used: parsed.used,
      remaining: parsed.remaining,
      exhausted: parsed.exhausted ?? parsed.remaining <= 0,
      resetsAt: parsed.resetsAt,
      exempt: parsed.exempt ?? false,
    });
  } catch {
    return null;
  }
}
