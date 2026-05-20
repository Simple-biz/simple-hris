/**
 * Work-email minting for new hires.
 *
 * Rule (per HR): the local part is the first name followed by the first letter
 * of the last name - e.g. Kane Reroma -> "kaner". When that collides with an
 * address already in use, we lengthen the last-name slice one letter at a time
 * until it is unique: a second "Kane Re..." (e.g. Kane Resma) becomes "kanere",
 * then "kanerer", and so on. The full name is a single field, so we treat the
 * first whitespace token as the first name and the LAST token as the last name
 * ("Jane Dela Cruz" -> first "Jane", last "Cruz" -> "janec").
 *
 * These are pure functions: the caller supplies the set of taken addresses
 * (see /api/hr/work-email/suggest, which excludes off-boarded rows so their
 * addresses can be recycled).
 */

export const WORK_EMAIL_DOMAIN = "simple.biz";

/** First whitespace token = first name; last token = last name. */
export function splitFullName(full: string | null | undefined): {
  first: string;
  last: string;
} {
  const tokens = (full ?? "").trim().split(/\s+/).filter(Boolean);
  if (tokens.length === 0) return { first: "", last: "" };
  if (tokens.length === 1) return { first: tokens[0], last: "" };
  return { first: tokens[0], last: tokens[tokens.length - 1] };
}

/**
 * Lowercase, strip the combining diacritical marks left behind by NFD
 * normalization (so an accented name folds to plain ASCII), and drop anything
 * that is not a latin letter or digit - the local part is always [a-z0-9]+.
 */
export function normalizeNamePart(s: string | null | undefined): string {
  return (s ?? "")
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]/g, "");
}

export type WorkEmailSuggestion = {
  /** Full address, e.g. "kaner@simple.biz". */
  email: string;
  /** Local part only, e.g. "kaner". */
  localPart: string;
};

/**
 * Suggest the shortest available <first><lastSlice>@domain address.
 *
 * @param first        First name (raw; will be normalized).
 * @param last         Last name (raw; will be normalized). May be empty.
 * @param takenEmails  Set of already-used full addresses. Compared
 *                     case-insensitively, so callers may pass any casing.
 * @returns the suggestion, or null when there is no usable first name.
 */
export function suggestWorkEmail(
  first: string,
  last: string,
  takenEmails: Set<string>,
  domain: string = WORK_EMAIL_DOMAIN,
): WorkEmailSuggestion | null {
  const f = normalizeNamePart(first);
  const l = normalizeNamePart(last);
  if (!f) return null;

  const make = (local: string): WorkEmailSuggestion => ({
    email: `${local}@${domain}`,
    localPart: local,
  });
  const isTaken = (local: string) =>
    takenEmails.has(`${local}@${domain}`.toLowerCase());

  // Progressive last-name slices: f+l[0], f+l[0..1], ... up to the whole
  // surname. With no surname, the only base candidate is the first name alone.
  const candidates: string[] = [];
  if (l) {
    for (let i = 1; i <= l.length; i++) candidates.push(f + l.slice(0, i));
  } else {
    candidates.push(f);
  }
  for (const local of candidates) {
    if (!isTaken(local)) return make(local);
  }

  // Surname exhausted and still colliding - fall back to a numeric suffix on
  // the fullest form so we always return something unique.
  const base = l ? f + l : f;
  let n = 2;
  while (isTaken(`${base}${n}`)) n++;
  return make(`${base}${n}`);
}
