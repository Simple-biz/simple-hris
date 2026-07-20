/**
 * Split a stored person name into its editable parts - and put them back
 * together in the master-list's surname-first quoted form.
 *
 *     Reroma, Jan Kane "Kane"   <->   { first: Jan, middle: Kane, last: Reroma,
 *                                       extension: "", nickname: Kane }
 *
 * Powers the People -> Profile identity editor, where a clerk edits First /
 * Middle / Last / Extension / Nickname instead of one opaque "Full name" blob.
 *
 * {@link parseNameParts} accepts BOTH shapes a `name` column can hold:
 *   - the master-list surname-first form  `Surname[ Suffix], Given... "GoBy"`
 *   - a plain legal name                  `First [Middle...] Last [Suffix]`
 * and always fills `nickname` - with the quoted go-by when present, else the
 * one the name implies (last non-initial given), so an untouched round-trip
 * reproduces the canonical string exactly.
 *
 * {@link composeMasterListName} is the inverse: it emits the surname-first
 * quoted string the master list stores. The People profile composes with it
 * client-side and the server keeps a comma-bearing (already-surname-first)
 * value verbatim (see canonicalMasterName in master-list-profile.ts), so an
 * explicit nickname survives instead of being re-derived.
 *
 * Both directions SCRUB double-quotes out of the individual parts (see
 * {@link scrubQuotes}) so a value corrupted by a CSV / Sheet round-trip -
 * where RFC-4180 doubles a quote (`"GoBy"` -> `""GoBy""`) - is repaired on read
 * and can never multiply its quotes on the next save.
 *
 * Mirrors the go-by / suffix rules in display-name.ts and first-name.ts.
 */
import { toTitleCaseName } from '@/lib/text/sanitize-name';

// Generational suffixes (optional trailing dot) that travel with the surname.
const SUFFIX_RE = /^(jr|sr|ii|iii|iv|v)\.?$/i;
// A bare initial: one letter, optional trailing dot ("S" / "S.").
const INITIAL_RE = /^\p{L}\.?$/u;

// Curly (typographic) quote code points, expressed as escapes so NO literal
// curly-quote byte appears in this source file (editors/tools that "smarten"
// quotes would otherwise corrupt them). U+201C/U+201D = curly double, and
// U+2018/U+2019 = curly single.
const LDQUO = '“';
const RDQUO = '”';
const LSQUO = '‘';
const RSQUO = '’';

export interface NameParts {
  /** First given name. */
  first: string;
  /** Any middle given names (space-joined); '' when there are none. */
  middle: string;
  /** Surname - the whole thing for a compound surname ("Dela Cruz"). */
  last: string;
  /** Generational suffix (Jr / Sr / III ...); '' when there is none. */
  extension: string;
  /** Go-by / nickname (unwrapped); the quoted one, else the implied go-by. */
  nickname: string;
}

const EMPTY: NameParts = { first: '', middle: '', last: '', extension: '', nickname: '' };

/** Remove the double-quote go-by delimiters (straight and curly) that must never
 *  survive INSIDE a name part. A CSV / Sheet round-trip escapes a quote by
 *  DOUBLING it (RFC 4180: two quotes == one), so a value that took a bad trip can
 *  carry stray or doubled quotes; scrubbing them here stops the garbage from
 *  leaking into a field AND - critically - from multiplying every time the name
 *  is re-composed and saved. Apostrophes (O'Brien) and hyphens are left alone. */
function scrubQuotes(s: string): string {
  const DOUBLE_QUOTES = new RegExp('["' + LDQUO + RDQUO + ']', 'g');
  return s.replace(DOUBLE_QUOTES, '').replace(/\s+/g, ' ').trim();
}

// Match a go-by delimited by straight OR curly quotes, or parens. Each side uses
// one-or-more quotes (`"+ ... "+`) so DOUBLED quotes (`""GoBy""`, a CSV
// round-trip artifact) still capture the real go-by rather than the empty string
// between a doubled pair - which is what used to leak `GoBy""` into the givens.
const NICKNAME_RE = new RegExp(
  '"+([^"]*)"+' +
    "|'+([^']*)'+" +
    '|' + LDQUO + '+([^' + RDQUO + ']*)' + RDQUO + '+' +
    '|' + LSQUO + '+([^' + RSQUO + ']*)' + RSQUO + '+' +
    '|\\(([^)]*)\\)',
  'u',
);

/** Pull the go-by out of a section, returning it (unwrapped + scrubbed) and the
 *  section without it. */
function extractNickname(section: string): { nickname: string; rest: string } {
  const m = section.match(NICKNAME_RE);
  if (!m || m.index === undefined) return { nickname: '', rest: section };
  const nickname = scrubQuotes(m[1] ?? m[2] ?? m[3] ?? m[4] ?? m[5] ?? '');
  const rest = (section.slice(0, m.index) + section.slice(m.index + m[0].length))
    .replace(/\s+/g, ' ')
    .trim();
  return { nickname, rest };
}

/** The go-by a name implies when none is quoted: the last given token that
 *  isn't a bare initial (else the last given). Mirrors display-name.ts. */
function deriveGoBy(givenTokens: string[]): string {
  if (givenTokens.length === 0) return '';
  for (let i = givenTokens.length - 1; i >= 0; i--) {
    if (!INITIAL_RE.test(givenTokens[i]!)) return givenTokens[i]!;
  }
  return givenTokens[givenTokens.length - 1]!;
}

/** Break a stored name into its parts (see the file header for the shapes and
 *  the nickname rule). A blank input yields all-empty parts; an '@'-address
 *  parked in a name column is returned whole in `first`, unsplit. */
export function parseNameParts(input: string | null | undefined): NameParts {
  const norm = toTitleCaseName(input);
  if (!norm) return { ...EMPTY };
  if (norm.includes('@')) return { ...EMPTY, first: norm };

  const commaAt = norm.indexOf(',');
  if (commaAt >= 0) {
    // Surname-first: "Surname[ Suffix], Given... \"GoBy\""
    // Scrub each token so any stray/doubled quote left over from a bad round-trip
    // never shows up in a field (e.g. Aeriele followed by "") or rides to the next save.
    const { nickname, rest } = extractNickname(norm.slice(commaAt + 1).trim());
    const given = rest.split(/\s+/).map(scrubQuotes).filter(Boolean);
    const leftToks = norm.slice(0, commaAt).trim().split(/\s+/).map(scrubQuotes).filter(Boolean);
    const suffixes: string[] = [];
    while (leftToks.length > 1 && SUFFIX_RE.test(leftToks[leftToks.length - 1]!)) {
      suffixes.unshift(leftToks.pop()!);
    }
    return {
      first: given[0] ?? '',
      middle: given.slice(1).join(' '),
      last: leftToks.join(' '),
      extension: suffixes.join(' '),
      nickname: nickname || deriveGoBy(given),
    };
  }

  // Plain legal name: "First [Middle...] Last [Suffix]" (possibly with an inline
  // quoted/paren nickname).
  const { nickname, rest } = extractNickname(norm);
  const core = rest.split(/\s+/).map(scrubQuotes).filter(Boolean);
  if (core.length === 0) return { ...EMPTY, nickname };
  if (core.length === 1) return { ...EMPTY, first: core[0]!, nickname };
  const suffixes: string[] = [];
  while (core.length > 2 && SUFFIX_RE.test(core[core.length - 1]!)) {
    suffixes.unshift(core.pop()!);
  }
  const last = core.pop() ?? '';
  const first = core.shift() ?? '';
  const middle = core.join(' ');
  const given = [first, ...(middle ? middle.split(/\s+/) : [])].filter(Boolean);
  return {
    first,
    middle,
    last,
    extension: suffixes.join(' '),
    nickname: nickname || deriveGoBy(given),
  };
}

/**
 * The master-list "Name" for a set of parts: `Surname[ Suffix], Given... "GoBy"`.
 * A parts set with no surname collapses to the given name / nickname alone (no
 * comma) so the server treats it as a plain name. The inverse of
 * {@link parseNameParts}: `compose(parse(name)) === name` for a canonical name.
 */
export function composeMasterListName(p: NameParts): string {
  // Scrub each part of stray double-quotes BEFORE assembling - especially the
  // nickname, which we wrap in quotes. This is the load-bearing guarantee that
  // the output carries exactly ONE clean quoted go-by and can never accumulate
  // doubled quotes, no matter how mangled the incoming parts were.
  const first = scrubQuotes(p.first);
  const middle = scrubQuotes(p.middle);
  const last = scrubQuotes(p.last);
  const extension = scrubQuotes(p.extension);
  const nickname = scrubQuotes(p.nickname);

  const given = [first, middle].filter(Boolean).join(' ');
  const nickPart = nickname ? ` "${nickname}"` : '';
  if (!last) return given || nickname; // mononym / given-only - no comma
  const suffix = extension ? ` ${extension}` : '';
  if (!given) return `${last}${suffix}${nickPart}`;
  return `${last}${suffix}, ${given}${nickPart}`;
}
