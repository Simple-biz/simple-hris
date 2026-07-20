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

/**
 * Generational name suffixes (Jr./Sr./II/III/IV, optional trailing period). The
 * onboarding form captures these in a dedicated "Extension" box and folds them
 * into the legal full_name, so any name-splitting that drives work-email /
 * gmail-surname derivation must drop the suffix and key off the real surname —
 * an account must never be minted off "Jr.". Deliberately conservative (matches
 * toTitleCaseName's set; no single letters) so a real surname token is never
 * mistaken for a suffix.
 */
export const NAME_EXTENSIONS = new Set([
  "jr",
  "jr.",
  "sr",
  "sr.",
  "ii",
  "iii",
  "iv",
]);

/** True when `token` is a generational suffix we peel from a full name. */
export function isNameExtension(token: string | null | undefined): boolean {
  return NAME_EXTENSIONS.has((token ?? "").trim().toLowerCase());
}

/** First whitespace token = first name; last token = last name. A trailing
 *  generational suffix is dropped first so `last` is always the real surname. */
export function splitFullName(full: string | null | undefined): {
  first: string;
  last: string;
} {
  const tokens = (full ?? "").trim().split(/\s+/).filter(Boolean);
  // Peel a trailing suffix only when a first + last still remain (>= 3 tokens),
  // so a two-token name is never stripped down to a bare first name.
  if (tokens.length >= 3 && isNameExtension(tokens[tokens.length - 1])) tokens.pop();
  if (tokens.length === 0) return { first: "", last: "" };
  if (tokens.length === 1) return { first: tokens[0], last: "" };
  return { first: tokens[0], last: tokens[tokens.length - 1] };
}

/**
 * Compose the legacy combined name from the structured parts — the SAME string
 * the onboarding form used to build inline (`[first, last, ext].join(" ")`). The
 * split parts are the source of truth now; this keeps `full_name` / `name` (the
 * master-list Sheet column, payroll name-matching, the display trigger) in sync.
 */
export function composeFullName(
  first: string | null | undefined,
  last: string | null | undefined,
  extension?: string | null | undefined,
): string {
  return [first, last, extension]
    .map((s) => (s ?? "").trim())
    .filter(Boolean)
    .join(" ");
}

/**
 * First/last NAME TOKENS for work-email / gmail-surname / CallTools derivation,
 * sourced from the structured `first_name` / `last_name` columns when present
 * (no blob re-parsing, no suffix guessing) and falling back to
 * {@link splitFullName} for legacy rows that predate the split.
 *
 * It reduces multi-token parts to the SAME (first token, last token)
 * splitFullName yields, on purpose: the documented "<first><last-initial>"
 * address rule and the dialer surname slice must not shift for a compound
 * surname ("Dela Cruz" -> last token "Cruz"), and a live work email must never
 * change under a hire when their row gains the columns. For the RAW captured
 * parts (e.g. the CallTools-creation webhook), read the columns directly.
 */
export function derivationNameParts(parts: {
  first_name?: string | null;
  last_name?: string | null;
  full_name?: string | null;
}): { first: string; last: string } {
  const firstCol = (parts.first_name ?? "").trim();
  const lastCol = (parts.last_name ?? "").trim();
  if (firstCol || lastCol) {
    const firstTok = firstCol.split(/\s+/).filter(Boolean)[0] ?? "";
    const lastToks = lastCol.split(/\s+/).filter(Boolean);
    return { first: firstTok, last: lastToks[lastToks.length - 1] ?? "" };
  }
  return splitFullName(parts.full_name);
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
 * The ordered, most-preferred-first list of base candidate addresses for a name
 * (first + progressive last-name slices), BEFORE any taken filtering. Lets a
 * caller walk them and apply its own availability test — e.g. a Google
 * Workspace verify lookup that reclaims an address claimed by a stale pending
 * row whose account was never actually created. Does NOT include the numeric
 * fallback (use suggestWorkEmail for that).
 */
export function workEmailCandidates(
  first: string,
  last: string,
  domain: string = WORK_EMAIL_DOMAIN,
): WorkEmailSuggestion[] {
  const f = normalizeNamePart(first);
  const l = normalizeNamePart(last);
  if (!f) return [];
  const locals: string[] = [];
  if (l) {
    for (let i = 1; i <= l.length; i++) locals.push(f + l.slice(0, i));
  } else {
    locals.push(f);
  }
  return locals.map((local) => ({ email: `${local}@${domain}`, localPart: local }));
}

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

/**
 * The "Gmail surname" to provision the @simple.biz Google account with. It is
 * sent to the workspace webhook IN PLACE OF the legal last name, on purpose: the
 * account must never expose the hire's full surname (so they can't be looked up
 * / stalked elsewhere). It's the WORK EMAIL's local part with the first-name
 * prefix removed, UPPER-cased — e.g. first "Kane" + `kanere@simple.biz` -> "RE",
 * `kaneres@` -> "RES" — so the surname always matches the address.
 *
 * Falls back to the last-name INITIAL when the email doesn't start with the
 * first name (HR picked a custom address) — never the full surname.
 */
export function gmailSurnameFromWorkEmail(
  first: string,
  workEmail: string,
  lastNameFallback = "",
): string {
  const f = normalizeNamePart(first);
  const lnorm = normalizeNamePart(lastNameFallback);
  const local = (workEmail.split("@")[0] ?? "").trim().toLowerCase();
  const slice = f && local.startsWith(f) ? local.slice(f.length) : "";
  // Trust the slice only when it's a clean prefix of the last name (the standard
  // firstname+lastslice address). Anything else — a custom address, digits, a
  // dot — falls back to the last-name initial, so we never emit garbage.
  if (slice && lnorm && lnorm.startsWith(slice)) return slice.toUpperCase();
  return (lnorm[0] ?? "").toUpperCase();
}
