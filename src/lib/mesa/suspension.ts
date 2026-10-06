// MESA contribution suspensions — the rules, browser-safe.
//
// Kane, 2026-10-06: "Accounting - MESA - Lets add a suspend button with an
// effectivity date picker that would suspend the mesa contribution without
// having to opt-out to remove the -100".
//
// A suspension stops the weekly ₱100 deduction AND the ₱100 + ₱300 deposit for
// pay weeks whose FRIDAY deposit date falls inside it. The member stays
// enrolled: same account, same number, balance untouched, nothing released.
// WHICH weeks is decided in exactly one place — `mesaContributesForWeek` in
// ./deposit-date — and this module only finds a member's windows and decides
// whether a new suspend/resume is allowed. The Active Members dialog and the
// routes both import it, so the button can never offer what the route refuses.
//
// docs/features/mesa-suspension.md

import { normEmail } from '@/lib/email/norm-email';
import {
  mesaDepositDateFor,
  type MesaSuspensionWindow,
} from './deposit-date';
import { isCalendarDate } from './enrollment-date';

export type { MesaSuspensionWindow } from './deposit-date';

/** Longest reason Accounting may type (also a CHECK on the table). */
export const MESA_SUSPENSION_REASON_MAX = 250;

/** Shown while the table does not exist yet (migration PENDING) — by the routes and the disabled button. */
export const MESA_SUSPENSIONS_NOT_SET_UP =
  'MESA suspensions are not set up yet — run scripts/apply-mesa-suspensions-migration.mts --apply.';

/** A suspension window as `/api/mesa-suspensions` returns it. */
export interface MesaSuspension extends MesaSuspensionWindow {
  id: string;
  accountNumber: string;
  /** `mesa_accounts.email` at suspend time — the ledger/account key. */
  email: string;
  /** The roster address Accounting acted on. */
  rosterEmail: string | null;
  reason: string | null;
  suspendedBy: string;
  suspendedAt: string;
  resumedBy: string | null;
  resumedAt: string | null;
  /**
   * Every address this suspension answers to, lowercased: the account email,
   * the roster email and each one's MESA aliases. A payroll row keyed on ANY
   * of them is covered — the same breadth `isMesaOptedOut` matches on.
   */
  emails: string[];
}

// ── Finding a member's windows ────────────────────────────────────────────────

export interface MesaSuspensionIndex {
  byEmail: Map<string, MesaSuspension[]>;
  byAccount: Map<string, MesaSuspension[]>;
}

export const EMPTY_MESA_SUSPENSION_INDEX: MesaSuspensionIndex = Object.freeze({
  byEmail: new Map<string, MesaSuspension[]>(),
  byAccount: new Map<string, MesaSuspension[]>(),
}) as MesaSuspensionIndex;

function push<K>(map: Map<K, MesaSuspension[]>, key: K, s: MesaSuspension): void {
  const list = map.get(key);
  if (list) list.push(s);
  else map.set(key, [s]);
}

/** Index suspensions by every address they answer to AND by account number. */
export function indexMesaSuspensions(list: readonly MesaSuspension[]): MesaSuspensionIndex {
  const byEmail = new Map<string, MesaSuspension[]>();
  const byAccount = new Map<string, MesaSuspension[]>();
  for (const s of list) {
    const seen = new Set<string>();
    for (const raw of [s.email, s.rosterEmail, ...s.emails]) {
      const e = normEmail(raw);
      if (!e || seen.has(e)) continue;
      seen.add(e);
      push(byEmail, e, s);
    }
    if (s.accountNumber) push(byAccount, s.accountNumber.trim(), s);
  }
  return { byEmail, byAccount };
}

/**
 * A member's suspension windows: every window matching ANY of their addresses
 * or their rate row's account number, de-duplicated, oldest first. Matching on
 * either is deliberate — a rate row can lack `mesa_account_number` (pre-account
 * history) and a member's MESA identity can be an earlier address; the union is
 * what keeps a suspension from silently missing the person it was put on.
 */
export function mesaSuspensionsFor(
  index: MesaSuspensionIndex,
  keys: { emails: ReadonlyArray<string | null | undefined>; accountNumber?: string | null },
): MesaSuspension[] {
  const out = new Map<string, MesaSuspension>();
  for (const raw of keys.emails) {
    const e = normEmail(raw);
    if (!e) continue;
    for (const s of index.byEmail.get(e) ?? []) out.set(s.id, s);
  }
  const acct = keys.accountNumber?.trim();
  if (acct) for (const s of index.byAccount.get(acct) ?? []) out.set(s.id, s);
  return [...out.values()].sort((a, b) => a.suspendedFrom.localeCompare(b.suspendedFrom));
}

/** The still-open window (no resume yet), if any — what Resume ends. */
export function openMesaSuspension<T extends MesaSuspensionWindow>(windows: readonly T[]): T | null {
  return windows.find((w) => w.resumedOn === null) ?? null;
}

// ── Validation (shared by the dialog and the routes) ──────────────────────────

export type SuspensionCheck<T> =
  | ({ ok: true } & T)
  | { ok: false; status: 400 | 409; error: string };

/** Optional free-text reason: trimmed, blank → null, at most 250 characters. */
export function checkSuspensionReason(raw: unknown): SuspensionCheck<{ reason: string | null }> {
  if (raw === undefined || raw === null) return { ok: true, reason: null };
  if (typeof raw !== 'string') return { ok: false, status: 400, error: 'reason must be text' };
  const t = raw.trim();
  if (!t) return { ok: true, reason: null };
  if (t.length > MESA_SUSPENSION_REASON_MAX) {
    return {
      ok: false,
      status: 400,
      error: `The reason is ${t.length} characters; the limit is ${MESA_SUSPENSION_REASON_MAX}.`,
    };
  }
  return { ok: true, reason: t };
}

/**
 * May this account be suspended from `from`?
 *
 * - `from` must be a real calendar day (400).
 * - Not before the account opened (400): there is no contribution to suspend,
 *   and a window reaching into a closed stint would read as if it applied there.
 * - Not while another window is still open (409): Resume it first. The table
 *   enforces this too (one open window per account).
 * - Not inside a window that already ended (409): from must be on/after the
 *   latest resume. Overlap could not change money — windows union — but two
 *   rows claiming the same weeks make the history unreadable.
 *
 * NOT floored at today. Accounting back-dates corrections, as on Opt In and the
 * opt-out date (docs/features/mesa.md:103,105). A back-dated suspension never
 * refunds a week already snapshotted — payroll rule changes are forward-only.
 */
export function checkSuspend(args: {
  from: unknown;
  accountOpenedOn: string;
  existing: readonly MesaSuspensionWindow[];
}): SuspensionCheck<{ from: string }> {
  const { from, accountOpenedOn, existing } = args;
  if (typeof from !== 'string' || !isCalendarDate(from.trim())) {
    return { ok: false, status: 400, error: 'Pick the effective date (YYYY-MM-DD).' };
  }
  const f = from.trim();
  if (f < accountOpenedOn) {
    return {
      ok: false,
      status: 400,
      error: `The account opened on ${accountOpenedOn}; a suspension cannot start before it.`,
    };
  }
  const open = openMesaSuspension(existing);
  if (open) {
    return {
      ok: false,
      status: 409,
      error: `Already suspended from ${open.suspendedFrom}. Resume it first.`,
    };
  }
  let latestResume: string | null = null;
  for (const w of existing) {
    if (w.resumedOn && (latestResume === null || w.resumedOn > latestResume)) latestResume = w.resumedOn;
  }
  if (latestResume && f < latestResume) {
    return {
      ok: false,
      status: 409,
      error: `The previous suspension ran until ${latestResume}; a new one can start on ${latestResume} or later.`,
    };
  }
  return { ok: true, from: f };
}

/**
 * May this open window be resumed on `resumeOn`?
 *
 * - A real calendar day (400).
 * - Not already resumed (409).
 * - Not before the suspension started (400). ON the start date is allowed and
 *   is how a mistaken suspension is cancelled: the window is empty, no week is
 *   skipped.
 */
export function checkResume(args: {
  resumeOn: unknown;
  window: MesaSuspensionWindow;
}): SuspensionCheck<{ resumeOn: string }> {
  const { resumeOn, window } = args;
  if (typeof resumeOn !== 'string' || !isCalendarDate(resumeOn.trim())) {
    return { ok: false, status: 400, error: 'Pick the resume date (YYYY-MM-DD).' };
  }
  const r = resumeOn.trim();
  if (window.resumedOn !== null) {
    return { ok: false, status: 409, error: `This suspension was already resumed on ${window.resumedOn}.` };
  }
  if (r < window.suspendedFrom) {
    return {
      ok: false,
      status: 400,
      error: `The suspension starts ${window.suspendedFrom}; resume on that date or later (on it cancels the suspension).`,
    };
  }
  return { ok: true, resumeOn: r };
}

// ── What the dialog tells Accounting ─────────────────────────────────────────

function isoPlusDays(iso: string, days: number): string {
  return new Date(Date.parse(`${iso}T00:00:00Z`) + days * 86_400_000).toISOString().slice(0, 10);
}

/**
 * The first Sun–Sat pay week an effective date reaches: the week whose FRIDAY
 * deposit date is the first Friday on/after `date`. For a suspend date that is
 * the first week without the ₱100; for a resume date, the first week charged
 * again. (An HSL Mon–Sun week shares the same Friday, so it is the same week.)
 */
export function firstAffectedWeek(date: string): { weekStart: string; weekEnd: string; deposit: string } {
  if (!isCalendarDate(date)) throw new Error(`date must be YYYY-MM-DD, got ${JSON.stringify(date)}`);
  // The Friday on/after `date`: the Friday on/before date + 6.
  const deposit = mesaDepositDateFor(isoPlusDays(date, 6));
  return { weekStart: isoPlusDays(deposit, -5), weekEnd: isoPlusDays(deposit, 1), deposit };
}

export type MesaSuspensionStatus<T extends MesaSuspensionWindow = MesaSuspensionWindow> =
  | { kind: 'none' }
  /** In effect on `today`. `window.resumedOn` set = a resume is already scheduled. */
  | { kind: 'suspended'; window: T }
  /** Starts after `today`. */
  | { kind: 'scheduled'; window: T };

/**
 * What the Active Members badge says on `today` (Manila). Empty (cancelled)
 * windows and windows that already ended are ignored; of the rest, the
 * earliest-starting one wins.
 */
export function mesaSuspensionStatusOn<T extends MesaSuspensionWindow>(
  windows: readonly T[],
  today: string,
): MesaSuspensionStatus<T> {
  const live = windows
    .filter((w) => (w.resumedOn === null || w.suspendedFrom < w.resumedOn) && (w.resumedOn === null || today < w.resumedOn))
    .sort((a, b) => a.suspendedFrom.localeCompare(b.suspendedFrom));
  const w = live[0];
  if (!w) return { kind: 'none' };
  return w.suspendedFrom <= today ? { kind: 'suspended', window: w } : { kind: 'scheduled', window: w };
}
