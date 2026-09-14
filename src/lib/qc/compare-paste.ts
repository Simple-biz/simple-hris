/**
 * The manager's Compare sheet, SHARED per department-week.
 *
 * Until 2026-09-14 the text Jackie pasted into "Compare with your sheet" lived
 * only in her tab's React state. Kane: *"whatever was pasted in there should be
 * visible to all"* — modelled on the Payroll Wizard's Orphanage step, where the
 * paste is persisted on the deliberate click (Lock in) and everyone who opens
 * the step afterwards sees the same locked-in list.
 *
 * Here the deliberate click is **Compare**: the text that was compared is what
 * gets shared, stamped with who and when. The carrier is one `app_settings`
 * row per (dept, pay-week Sunday) — the same carrier the orphanage step uses,
 * so no migration stands between the ask and the deploy.
 *
 * This file is PURE and client-safe: key building, the stored shape and its
 * codec, and the request-body validation the route runs. The route
 * (`app/api/qc/compare-paste/route.ts`) owns I/O, the gate and the audit rows.
 *
 * Two facts the shape encodes on purpose:
 * - The value is ONE scalar replaced whole, never a map merged in place, so
 *   last-writer-wins is the documented-correct write for it
 *   (`app-settings.ts` → `casUpdateAppSetting`'s own header) and the
 *   attribution says who wrote last.
 * - `rowCount` is computed SERVER-side from the same parser the panel uses,
 *   never trusted from the body — the number on the attribution line must be
 *   the number Compare itself would see.
 */

import { isQcDeptKey } from './constants';
import { parseAppointmentPaste } from './paste';
import { qcPeriodStartError } from './period';

/** Key family. The trailing dot is part of the family test on purpose:
 *  `qc.compare_pastefoo` is not this family. */
export const COMPARE_PASTE_KEY_PREFIX = 'qc.compare_paste.';

/** Jackie's sheet is ~280 rows × ~60 chars ≈ 17 KB. This is a ceiling on
 *  abuse, not a working limit — ten times the largest real paste. */
export const COMPARE_PASTE_MAX_CHARS = 200_000;

export function comparePasteSettingKey(dept: string, periodStart: string): string {
  return `${COMPARE_PASTE_KEY_PREFIX}${dept}.${periodStart}`;
}

/** True for any key in the family — refused by the generic `/api/app-settings`
 *  route on read AND write, because that route cannot scope by department and
 *  the whole point of the sheet is that the QC officers never see it. */
export function isComparePasteKey(key: string): boolean {
  return key.trim().toLowerCase().startsWith(COMPARE_PASTE_KEY_PREFIX);
}

/** What the `app_settings` row holds, and what the route returns. */
export interface SharedComparePaste {
  v: 1;
  /** The pasted text, verbatim — tabs and all. Re-parsed by the panel. */
  text: string;
  /** Session email of whoever clicked Compare. Never from the body. */
  pastedBy: string;
  /** ISO timestamp of that click, stamped by the server. */
  pastedAt: string;
  /** `parseAppointmentPaste(text).rows.length`, computed server-side. */
  rowCount: number;
}

export function encodeSharedComparePaste(p: SharedComparePaste): string {
  return JSON.stringify({
    v: 1,
    text: p.text,
    pastedBy: p.pastedBy,
    pastedAt: p.pastedAt,
    rowCount: p.rowCount,
  });
}

/**
 * Decode a stored value. Anything that is not exactly the shape above comes
 * back `null` — a half-shaped row must never render as an attributed sheet.
 * The caller distinguishes "no row" from "unreadable row" by whether it had a
 * raw string to hand in.
 */
export function decodeSharedComparePaste(raw: string | null | undefined): SharedComparePaste | null {
  if (typeof raw !== 'string' || raw === '') return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) return null;
  const o = parsed as Record<string, unknown>;
  if (o.v !== 1) return null;
  if (typeof o.text !== 'string') return null;
  if (typeof o.pastedBy !== 'string' || o.pastedBy.trim() === '') return null;
  if (typeof o.pastedAt !== 'string' || Number.isNaN(Date.parse(o.pastedAt))) return null;
  if (typeof o.rowCount !== 'number' || !Number.isInteger(o.rowCount) || o.rowCount < 0) return null;
  return { v: 1, text: o.text, pastedBy: o.pastedBy, pastedAt: o.pastedAt, rowCount: o.rowCount };
}

export type ComparePasteTarget =
  | { ok: true; dept: string; periodStart: string }
  | { ok: false; reason: string };

/**
 * The (dept, period_start) every verb takes. `dept` must be a department QC
 * scores — the family is scoped to the departments whose card carries the
 * Compare chip, nothing wider. `period_start` must be a pay-week Sunday,
 * the same lock `GET /api/qc/assignments` enforces before it deals
 * ([[qc-period-key-must-be-sunday]]) — a Monday key here would share a sheet
 * under a week nobody else will ever open.
 */
export function parseComparePasteTarget(dept: unknown, periodStart: unknown): ComparePasteTarget {
  const d = typeof dept === 'string' ? dept.trim() : '';
  if (!isQcDeptKey(d)) {
    return { ok: false, reason: `dept must be a QC-scored department key (got ${JSON.stringify(dept ?? null)})` };
  }
  const p = typeof periodStart === 'string' ? periodStart.trim() : null;
  const periodError = qcPeriodStartError(p);
  if (periodError) return { ok: false, reason: periodError };
  return { ok: true, dept: d, periodStart: p as string };
}

export type ComparePasteSaveBody =
  | { ok: true; dept: string; periodStart: string; text: string; rowCount: number }
  | { ok: false; reason: string };

/** Tab, LF and CR are the only control characters a spreadsheet paste carries.
 *  Anything else (NUL, escape sequences, DEL) is not a sheet. */
function hasForeignControlChars(s: string): boolean {
  for (let i = 0; i < s.length; i += 1) {
    const c = s.charCodeAt(i);
    if (c === 0x09 || c === 0x0a || c === 0x0d) continue;
    if (c < 0x20 || c === 0x7f) return true;
  }
  return false;
}

/**
 * Validate the PUT body `{ dept, period_start, text }`.
 *
 * The text is stored VERBATIM (the panel re-parses it, and a trimmed or
 * normalised copy would not be "what was pasted"), but it must be worth
 * sharing: non-blank, bounded, free of foreign control characters, and it must
 * parse to at least one row. A paste the parser refuses line by line is still
 * compared — the refusals are the point — but there is nothing in it for a
 * second manager to see, so it is not shared.
 */
export function parseComparePasteSaveBody(body: unknown): ComparePasteSaveBody {
  if (typeof body !== 'object' || body === null || Array.isArray(body)) {
    return { ok: false, reason: 'Invalid JSON body' };
  }
  const b = body as { dept?: unknown; period_start?: unknown; text?: unknown };
  const target = parseComparePasteTarget(b.dept, b.period_start);
  if (!target.ok) return target;

  if (typeof b.text !== 'string') return { ok: false, reason: 'text must be a string' };
  if (b.text.trim() === '') return { ok: false, reason: 'text is blank — nothing to share' };
  if (b.text.length > COMPARE_PASTE_MAX_CHARS) {
    return { ok: false, reason: `text is too long (${b.text.length} chars; the limit is ${COMPARE_PASTE_MAX_CHARS})` };
  }
  if (hasForeignControlChars(b.text)) {
    return { ok: false, reason: 'text contains control characters that a spreadsheet paste never carries' };
  }

  const rowCount = parseAppointmentPaste(b.text).rows.length;
  if (rowCount === 0) {
    return { ok: false, reason: 'no line parsed as a (work email ⇥ name ⇥ appointments) row — nothing to share' };
  }

  return { ok: true, dept: target.dept, periodStart: target.periodStart, text: b.text, rowCount };
}
