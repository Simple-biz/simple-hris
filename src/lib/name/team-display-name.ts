/**
 * The ONLY identity string a peer may see for a teammate.
 *
 * Ruling (Carla, 2026-09-09, on safety grounds — `docs/meetings/
 * 2026-09-09-carla-jackie-employee-surface-and-qc.md` §2.6): *"we got some
 * really creepy people here sometimes and they shouldn't be able to see full
 * names on their team. They should only see like their nickname, the whatever
 * is in quotation marks, and their email."* Kane pinned the fallback on
 * 2026-09-12: **the quoted go-by, else the FIRST name.**
 *
 * That second half is the whole point of this module existing. The master
 * "Name" is stored surname-first (`Reroma, Jan Kane "Kane"`), and the two
 * nickname resolvers already in `src/lib/name/` both do the wrong thing here:
 *
 *   - `parseNameParts(...).nickname` DERIVES a go-by when none is quoted ("the
 *     last given token that is not a bare initial"), so *Jane Marie Santos*
 *     would be introduced to her entire team as **"Marie"** — her middle name.
 *   - `resolveFirstName(...)` returns EVERY given token before the surname, so
 *     the same person becomes **"Jane Marie"** — the middle name again, just
 *     attached.
 *
 * So: {@link quotedGoByOf} for the literal quoted token (never a derived one),
 * and `parseNameParts(...).first` — the field the People profile editor labels
 * "First" — for the fallback. The surname never appears, and no caller may
 * pass a personal email in: the only address this module will read from is the
 * WORK email, which the same ruling explicitly permits.
 *
 * Collisions (Kane, 2026-09-12: *"if there are conflicts use the
 * recommendation"*) are resolved by {@link teamDisplayNames} over the WHOLE
 * roster at once, server-side — so a label is stable no matter which page of
 * the directory it lands on or what the viewer has typed into search. A name
 * nobody else shares is never suffixed.
 */
import { parseNameParts, quotedGoByOf } from './name-parts';
import { toTitleCaseName } from '@/lib/text/sanitize-name';

/** Shown when a person has no usable name and no work email at all. Never an
 *  email local part from the PERSONAL address — that is the exposure the same
 *  ruling closes. */
const NO_IDENTITY = 'Teammate';

export interface TeamIdentity {
  /** The raw master-list "Name" cell, in either stored shape. */
  name: string | null | undefined;
  /** WORK email only. A personal address must never reach this module. */
  workEmail: string | null | undefined;
}

/**
 * Re-case a go-by that was typed in a different case from the rest of its name.
 *
 * `toTitleCaseName` (which every parse here runs first) returns a MIXED-case
 * string verbatim, so `Santos, Carla "CARLA"` keeps its SHOUTED go-by — which
 * did not matter while the go-by was a detail inside a longer rendered name and
 * matters now that it IS the name. So the token is re-cased on its own.
 *
 * All-caps is only flattened at **4+ letters**. Short all-caps go-bys are
 * initials — JJ, AJ, KC, CJ, TJ — and "Jj" would be worse than leaving them.
 * All-lowercase is always title-cased: there is no lowercase-acronym
 * convention in a nickname. Mixed case ("McD", "JoAnn") is left alone, the same
 * rule `toTitleCaseName` follows.
 */
function normalizeGoByCase(goby: string): string {
  if (/\s/.test(goby)) return toTitleCaseName(goby) || goby;
  const hasLower = /\p{Ll}/u.test(goby);
  const hasUpper = /\p{Lu}/u.test(goby);
  if (hasLower === hasUpper) return goby; // mixed, or no cased letters
  if (hasUpper && (goby.match(/\p{L}/gu)?.length ?? 0) < 4) return goby; // initials
  return toTitleCaseName(goby) || goby;
}

/** The local part's first word, proper-cased — `kaner@` -> "Kaner". Used only
 *  as a last resort, and only for a work address. */
function workEmailWord(email: string | null | undefined): string {
  const e = (email ?? '').trim();
  if (!e.includes('@')) return '';
  const word = (e.split('@')[0] ?? '').replace(/[._-]+/g, ' ').trim().split(/\s+/)[0] ?? '';
  return word ? word.charAt(0).toUpperCase() + word.slice(1) : '';
}

/** The raw local part, for disambiguating two people who share a short name. */
function workEmailLocalPart(email: string | null | undefined): string {
  const e = (email ?? '').trim();
  if (!e.includes('@')) return '';
  return (e.split('@')[0] ?? '').trim().toLowerCase();
}

/**
 * One teammate's short name: the quoted go-by, else the first name.
 *
 * Never returns a surname, a middle name, or any part of a personal email. An
 * '@'-address parked in the name column is treated as no name at all rather
 * than rendered — it may well BE the personal address.
 */
export function shortDisplayName(
  name: string | null | undefined,
  workEmail: string | null | undefined,
): string {
  const raw = (name ?? '').trim();
  if (raw && !raw.includes('@')) {
    const parts = parseNameParts(raw);
    const first = parts.first.trim();
    const quoted = quotedGoByOf(raw);
    // A go-by that IS the surname puts the surname straight back on the card —
    // `Lagunero, Joshua "Lagunero"` is a real roster row. The ruling is about
    // the surname, not about which field it arrived in, so the first name wins.
    // (Only when there IS a first name; a mononym keeps what it has.)
    const goByIsSurname =
      !!quoted && !!parts.last && quoted.toLowerCase() === parts.last.trim().toLowerCase();
    if (quoted && !(goByIsSurname && first)) return normalizeGoByCase(quoted);
    if (first && !first.includes('@')) return first;
  }
  return workEmailWord(workEmail) || NO_IDENTITY;
}

/** The surname's first letter, for the first rung of the collision ladder.
 *  One letter is the most of a surname that may ever be shown. */
function surnameInitial(name: string | null | undefined): string {
  const raw = (name ?? '').trim();
  if (!raw || raw.includes('@')) return '';
  const ch = parseNameParts(raw).last.trim().charAt(0);
  return /\p{L}/u.test(ch) ? ch.toUpperCase() : '';
}

function allDistinct(labels: readonly string[]): boolean {
  return new Set(labels.map((l) => l.toLowerCase())).size === labels.length;
}

/**
 * Short names for a whole roster, in input order, with collisions resolved.
 *
 * Only people who actually collide are suffixed; a unique "Carla" stays
 * "Carla". The ladder, cheapest disclosure first:
 *
 *   1. surname INITIAL          — `Kane R.`
 *   2. work-email local part    — `Kane R. (kaner)`   (already on the card; new nothing)
 *   3. a positional index       — `Kane 2`            (only when there is no work email)
 *
 * Deterministic: it depends on input order alone, and `getTeamRoster` reads the
 * roster ordered by "Name" ascending.
 */
export function teamDisplayNames(people: readonly TeamIdentity[]): string[] {
  const base = people.map((p) => shortDisplayName(p.name, p.workEmail));
  const out = [...base];

  const groups = new Map<string, number[]>();
  base.forEach((label, i) => {
    const key = label.toLowerCase();
    const bucket = groups.get(key);
    if (bucket) bucket.push(i);
    else groups.set(key, [i]);
  });

  for (const idxs of groups.values()) {
    if (idxs.length < 2) continue;

    // 1 — surname initial.
    const tier1 = idxs.map((i) => {
      const ini = surnameInitial(people[i]!.name);
      return ini ? `${base[i]} ${ini}.` : base[i]!;
    });
    if (allDistinct(tier1)) {
      idxs.forEach((i, k) => {
        out[i] = tier1[k]!;
      });
      continue;
    }

    // 2 — work-email local part.
    const tier2 = idxs.map((i, k) => {
      const local = workEmailLocalPart(people[i]!.workEmail);
      return local ? `${tier1[k]} (${local})` : tier1[k]!;
    });
    if (allDistinct(tier2)) {
      idxs.forEach((i, k) => {
        out[i] = tier2[k]!;
      });
      continue;
    }

    // 3 — positional index. Reached only when two people share a short name,
    // a surname initial AND have no work email to tell them apart.
    idxs.forEach((i, k) => {
      out[i] = `${tier2[k]} ${k + 1}`;
    });
  }

  return out;
}
