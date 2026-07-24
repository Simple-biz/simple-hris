/**
 * CallTools dialer-username minting for Lead Gen hires.
 *
 * Rule (per HR): a Lead Gen hire types their own Nickname on the onboarding
 * paperwork (how they want to be called on the dialer — it is NOT derived from
 * their legal first name), and the system builds their CallTools username as
 *
 *     "<Nickname> <first-name initial>. <surname slice>."
 *
 * e.g. James Thomas who goes by "Mikey" -> "Mikey J. T.". When that username is
 * already in use, the surname slice lengthens one letter at a time until it is
 * unique — the second "Mikey J. T." becomes "Mikey J. TH.", then "Mikey J. THO.",
 * and so on. This mirrors the @simple.biz work-email rule (work-email.ts):
 * progressive surname slices, and NO numeric fallback — if every slice collides
 * the longest one (the full surname) is used rather than leaking "Nickname 2".
 *
 * These are pure functions: the caller supplies the set of taken usernames
 * (see /api/onboarding/[token]/calltools-username, which reads the usernames
 * already minted on onboarding submissions).
 */

import { normalizeNamePart, splitFullName } from "./work-email";
import { stripMiddleMarker } from "@/lib/name/name-parts";

/** Department labels that identify a Lead Gen hire (matches the bulk-invite
 *  check in HR > Onboarding and normalizeDeptToKey's lead_gen mapping). */
export function isLeadGenDepartment(dept: string | null | undefined): boolean {
  return ["lead gen", "lead generation"].includes(
    (dept ?? "").trim().toLowerCase(),
  );
}

/** Straight + curly double quotes — the checklist wraps go-by nicknames in
 *  either ('Joan "Andy" Raguindin', 'Caraga, Siegmond Lois “Siegmond”'). */
const QUOTED_NICK = /["“”]\s*([^"“”]+?)\s*["“”]/;

/**
 * Dialer identity for a hire whose paperwork predates the self-chosen-nickname
 * feature (nothing stored to mint from): derived from their roster name, which
 * follows the New Hire Checklist conventions. Preference order for the
 * nickname: the quoted go-by name, else the first given name. Handles both
 * given-first ("Joan \"Andy\" Raguindin") and surname-first
 * ("Caraga, Siegmond Lois “Siegmond”") forms; generational suffixes
 * are never mistaken for a surname.
 */
export function fallbackDialerIdentity(name: string | null | undefined): {
  nickname: string;
  first: string;
  last: string;
} {
  const raw = (name ?? "").trim();
  const nickFromQuotes = raw.match(QUOTED_NICK)?.[1]?.trim() ?? "";
  // Drop the quoted go-by AND the parenthesized First/Middle boundary marker
  // (see name-parts.ts) before splitting, so neither the nickname nor a stashed
  // middle name pollutes the surname/first-name derivation. Without the marker
  // strip, a surname-first name like `Reroma (Miguel), Jan Kane Teves "Kane"`
  // would mint the surname as "Reroma (Miguel)".
  const bare = stripMiddleMarker(
    raw.replace(/["“”][^"“”]*["“”]/g, " "),
  )
    .replace(/\s+/g, " ")
    .trim();
  let first = "";
  let last = "";
  const comma = bare.indexOf(",");
  if (comma >= 0) {
    // Surname-first: everything before the comma is the surname; the first
    // token after it is the given name.
    last = bare.slice(0, comma).trim();
    first = bare.slice(comma + 1).trim().split(/\s+/)[0] ?? "";
  } else {
    const split = splitFullName(bare);
    first = split.first;
    last = split.last;
  }
  return { nickname: nickFromQuotes || first, first, last };
}

/** Collapse inner whitespace and trim — a nickname is stored/compared as one
 *  spaced token run ("Mikey  Boy" -> "Mikey Boy"). */
function cleanNickname(nickname: string | null | undefined): string {
  return (nickname ?? "").replace(/\s+/g, " ").trim();
}

/** UPPER-cased ASCII initial of the first first-name token ("James" -> "J",
 *  accented letters fold to plain ASCII). Empty when there is none. */
export function firstNameInitial(first: string | null | undefined): string {
  const token = (first ?? "").trim().split(/\s+/)[0] ?? "";
  return normalizeNamePart(token).charAt(0).toUpperCase();
}

/** Assemble "<Nickname> <F>. <SLICE>." — the surname part is omitted entirely
 *  when the hire has no usable surname letters (never a dangling "."). */
export function formatCallToolsUsername(
  nickname: string,
  firstInitial: string,
  surnameSlice: string,
): string {
  const parts = [cleanNickname(nickname)];
  if (firstInitial) parts.push(`${firstInitial.toUpperCase()}.`);
  if (surnameSlice) parts.push(`${surnameSlice.toUpperCase()}.`);
  return parts.join(" ");
}

/**
 * The ordered, most-preferred-first list of candidate usernames for a hire —
 * "<Nick> <F>. <S>.", "<Nick> <F>. <SU>.", … up to the full surname — BEFORE
 * any taken-filtering, so a caller can walk them with its own availability
 * test. Empty when there is no usable nickname or first-name initial.
 */
export function calltoolsUsernameCandidates(
  nickname: string,
  first: string,
  last: string,
): string[] {
  const nick = cleanNickname(nickname);
  const f = firstNameInitial(first);
  if (!nick || !f) return [];
  const l = normalizeNamePart(last);
  if (!l) return [formatCallToolsUsername(nick, f, "")];
  const out: string[] = [];
  for (let i = 1; i <= l.length; i++) {
    out.push(formatCallToolsUsername(nick, f, l.slice(0, i)));
  }
  return out;
}

/**
 * Suggest the shortest available CallTools username.
 *
 * @param nickname  The hire's self-chosen nickname (raw; whitespace collapsed).
 * @param first     Legal first name — only its initial is used.
 * @param last      Legal last name — sliced progressively for uniqueness.
 * @param taken     Already-used usernames. Compared case-insensitively, so
 *                  callers may pass any casing.
 * @returns the username, or null when nickname / first initial are missing.
 *          When every slice collides the LONGEST candidate (full surname) is
 *          returned — deliberately no numeric suffix, mirroring the
 *          gmail-surname rule.
 */
export function suggestCallToolsUsername(
  nickname: string,
  first: string,
  last: string,
  taken: Set<string>,
): string | null {
  const candidates = calltoolsUsernameCandidates(nickname, first, last);
  if (candidates.length === 0) return null;
  const lower = new Set([...taken].map((t) => t.trim().toLowerCase()));
  return (
    candidates.find((c) => !lower.has(c.toLowerCase())) ??
    candidates[candidates.length - 1]!
  );
}
