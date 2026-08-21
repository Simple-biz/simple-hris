/**
 * Manual validation ("MV") — the record that a human opened one person's pay for
 * one cycle, checked it by hand, and vouched for it.
 *
 * PURE: no React, no fetch, no Date.now(). Every instant is passed in by the
 * caller so the whole module is unit-testable and so the client and the route
 * cannot disagree about what a stored entry means.
 *
 * ## Where it lives, and why that shape
 *
 * One `app_settings` row per pay cycle, keyed {@link mvSettingKey} —
 * `payroll.wizard.mv.<sourceFile>` — holding a JSON object of
 * `lowercased work email → {by, at, note}`. This deliberately mirrors
 * `payroll.wizard.exclusions.<sourceFile>`, the store behind the Exclude
 * checkbox that MV sits beside, so the two controls on the same row share one
 * persistence model and one week scope.
 *
 * It is NOT a column on `payment_dispatches`. That table is an OUTCOME ledger:
 * measured 2026-08-21, all 6,932 rows are terminal (`paid` 6,880 / `threshold`
 * 44 / `problem` 8) and not one lacks a `sent_date`, because a row is inserted
 * only when money has already moved. MV is ticked in the wizard's Validation
 * step, BEFORE dispatch — so at tick time there is no row to write to.
 *
 * ## The two parse paths are not interchangeable
 *
 * Reading for DISPLAY is tolerant: {@link parseManualValidationMap} drops
 * entries it cannot understand and reports how many, because one corrupt entry
 * must not blank a whole cycle's validations on screen.
 *
 * Writing is NOT tolerant, and that asymmetry is the point.
 * {@link mergeIntoRawMvBlob} merges into the RAW parsed object and REFUSES
 * (`ok: false`) when the stored value is present but unparseable. A tolerant
 * write would round-trip an unreadable blob through `{}` and silently destroy
 * every validation in it — the same class of bug `getAppSettingStrict` exists to
 * prevent ("treating a transient read failure as 'no saved additions' would zero
 * the wizard state", `src/lib/supabase/app-settings.ts`). Merging raw also
 * preserves keys a future version adds, so an older deploy cannot strip them.
 */

/** Longest note we store. Past this the text is a document, not an annotation. */
export const MV_NOTE_MAX_LEN = 500;

/** One person's manual-validation record for one cycle. */
export type ManualValidation = {
  /** Work email of whoever ticked it, lowercased. Never blank. */
  by: string;
  /** ISO-8601 instant the tick was recorded, server-stamped. */
  at: string;
  /** Free text the validator typed. `null` when they left it blank — the note
   *  is deliberately optional, so absence is a normal state, not missing data. */
  note: string | null;
};

/** `lowercased work email → record`. Absence of a key means "not validated". */
export type ManualValidationMap = Record<string, ManualValidation>;

/** The `app_settings` key holding one cycle's validations. */
export function mvSettingKey(sourceFile: string): string {
  return `payroll.wizard.mv.${sourceFile}`;
}

/**
 * The map's key. Must stay byte-identical to how the wizard keys
 * `excludedEmails` (`normEmail(email) ?? email.trim().toLowerCase()`), because
 * the MV cell and the Exclude cell are looked up for the same table row — if the
 * two normalisations ever diverge, one of the two checkboxes silently reads as
 * unticked for anyone whose email differs only by case or padding.
 */
export function normalizeMvEmail(email: string | null | undefined): string | null {
  if (typeof email !== 'string') return null;
  const trimmed = email.trim().toLowerCase();
  return trimmed === '' ? null : trimmed;
}

/** Trim, collapse a blank to `null`, and cap the length. A note is optional, so
 *  "" and "   " are the same state as never typing one. */
export function normalizeMvNote(note: string | null | undefined): string | null {
  if (typeof note !== 'string') return null;
  const trimmed = note.trim();
  if (trimmed === '') return null;
  return trimmed.length > MV_NOTE_MAX_LEN ? trimmed.slice(0, MV_NOTE_MAX_LEN) : trimmed;
}

function isIsoInstant(v: unknown): v is string {
  if (typeof v !== 'string' || v === '') return false;
  const t = Date.parse(v);
  return Number.isFinite(t);
}

/** Narrow one unknown value to a `ManualValidation`, or return null. */
function coerceEntry(v: unknown): ManualValidation | null {
  if (v == null || typeof v !== 'object' || Array.isArray(v)) return null;
  const o = v as Record<string, unknown>;
  const by = normalizeMvEmail(typeof o.by === 'string' ? o.by : null);
  if (by == null) return null;
  if (!isIsoInstant(o.at)) return null;
  return { by, at: o.at, note: normalizeMvNote(typeof o.note === 'string' ? o.note : null) };
}

/**
 * Tolerant read for display. A malformed entry is dropped and counted rather
 * than thrown, so one bad record cannot hide a cycle's worth of good ones.
 * `malformed > 0` is worth surfacing — it means the blob was written by
 * something that disagrees with this module.
 */
export function parseManualValidationMap(
  raw: string | null | undefined,
): { map: ManualValidationMap; malformed: number } {
  if (raw == null || raw === '') return { map: {}, malformed: 0 };
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return { map: {}, malformed: 0 };
  }
  if (parsed == null || typeof parsed !== 'object' || Array.isArray(parsed)) {
    return { map: {}, malformed: 0 };
  }
  const map: ManualValidationMap = {};
  let malformed = 0;
  for (const [rawKey, rawVal] of Object.entries(parsed as Record<string, unknown>)) {
    const key = normalizeMvEmail(rawKey);
    const entry = coerceEntry(rawVal);
    if (key == null || entry == null) {
      malformed += 1;
      continue;
    }
    map[key] = entry;
  }
  return { map, malformed };
}

export type MvMergeResult =
  | { ok: true; next: string }
  | { ok: false; reason: string };

/**
 * Set or clear ONE person's entry inside the stored blob, preserving everything
 * else byte-for-byte in meaning — including keys this version does not
 * recognise.
 *
 * Refuses when `raw` is a non-empty string that does not parse to a JSON object.
 * The caller must surface that as a conflict, never overwrite: a blob we cannot
 * read may still hold other people's validations, and clobbering it destroys
 * exactly the accountability record this feature exists to create.
 *
 * Passing `entry: null` removes the key (an un-tick), rather than storing a
 * falsy record — so "not validated" has one representation, not two.
 */
export function mergeIntoRawMvBlob(
  raw: string | null | undefined,
  email: string,
  entry: ManualValidation | null,
): MvMergeResult {
  const key = normalizeMvEmail(email);
  if (key == null) return { ok: false, reason: 'A validation needs an email to hang on.' };

  let base: Record<string, unknown> = {};
  if (raw != null && raw !== '') {
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch {
      return { ok: false, reason: 'The stored validations for this cycle are unreadable; refusing to overwrite them.' };
    }
    if (parsed == null || typeof parsed !== 'object' || Array.isArray(parsed)) {
      return { ok: false, reason: 'The stored validations for this cycle are not an object; refusing to overwrite them.' };
    }
    base = { ...(parsed as Record<string, unknown>) };
  }

  if (entry == null) {
    delete base[key];
  } else {
    const by = normalizeMvEmail(entry.by);
    if (by == null) return { ok: false, reason: 'A validation needs the validator’s email.' };
    if (!isIsoInstant(entry.at)) return { ok: false, reason: 'A validation needs a valid timestamp.' };
    base[key] = { by, at: entry.at, note: normalizeMvNote(entry.note) };
  }

  return { ok: true, next: JSON.stringify(base) };
}

/** How many people in this cycle carry a validation. */
export function countValidated(map: ManualValidationMap): number {
  return Object.keys(map).length;
}

/** Look one person up. Returns null when they have not been validated. */
export function validationFor(
  map: ManualValidationMap,
  email: string | null | undefined,
): ManualValidation | null {
  const key = normalizeMvEmail(email);
  if (key == null) return null;
  return map[key] ?? null;
}
