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
 * MULTI-WORD FIRST NAMES (the First/Middle boundary marker). The master "Name"
 * is a single string, so a compound first name ("Jan Kane Teves") and a
 * first+middle ("Jan" / "Kane Teves") are indistinguishable once the given
 * names are space-joined - the naive re-parse always makes the FIRST token the
 * first name and the rest the middle. To keep a multi-word first name intact
 * across a save + reload, compose records the middle name to the LEFT of the
 * comma, in parentheses adjacent to the surname, and puts the WHOLE first name
 * to the right:
 *
 *     first="Jan Kane Teves" middle="Miguel" last="Reroma"
 *        ->  Reroma (Miguel), Jan Kane Teves "Kane"
 *     first="Jan Kane Teves" middle=""       last="Reroma"
 *        ->  Reroma (), Jan Kane Teves "Kane"     (empty () = "middle is empty")
 *
 * The marker is emitted ONLY when the first name is multi-word (contains a
 * space) - the sole case the naive re-split gets wrong. A single-word first
 * (with or without a middle) re-splits correctly, so it stays in the plain
 * legacy form `Surname[ Suffix], Given... "GoBy"` byte-for-byte - every
 * pre-existing name and every existing test is untouched. On parse, a left-of-
 * comma `(...)` group (even empty) is the signal to take the entire right side
 * as the first name and read the middle out of the parens; its ABSENCE keeps
 * the legacy first-token/rest split. The two paren forms never collide: the
 * left marker is parsed by dedicated left-side logic and is NEVER fed to the
 * go-by matcher (NICKNAME_RE), which only ever runs on the right-of-comma
 * section (or a plain no-comma name, e.g. `Juan (JJ) Cruz`).
 *
 * Other readers of the master name that slice the surname off the LEFT of the
 * comma must strip this `(...)` group first - see stripMiddleMarker below and
 * its uses in calltools-username.ts and payroll-wizard-notes.ts.
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
// The First/Middle boundary marker: a parenthesized middle name (possibly
// empty) stashed on the surname side of the comma. See the file header.
const MIDDLE_MARKER_RE = /\(([^)]*)\)/;

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

/** Remove the First/Middle boundary marker - a parenthesized middle name that
 *  {@link composeMasterListName} stashes on the surname side of the comma (e.g.
 *  `Reroma (Miguel)` -> `Reroma`, `Reroma ()` -> `Reroma`). Any reader that
 *  takes the surname from the LEFT of the comma must run this first, or the
 *  `(...)` leaks into the surname. A string with no marker is returned as-is
 *  (whitespace-collapsed). This is deliberately targeted at the marker only -
 *  a legitimate paren-nickname in a plain no-comma name is a separate concern
 *  handled by the go-by matchers. */
export function stripMiddleMarker(s: string): string {
  return s
    .replace(MIDDLE_MARKER_RE, ' ')
    .replace(/\s+/g, ' ')
    .replace(/\s+,/g, ',') // the removed `(Middle) ` can leave a space before the comma
    .trim();
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
    // Surname-first: "Surname[ Suffix][ (Middle)], Given... \"GoBy\""
    // Scrub each token so any stray/doubled quote left over from a bad round-trip
    // never shows up in a field (e.g. Aeriele followed by "") or rides to the next save.
    const { nickname, rest } = extractNickname(norm.slice(commaAt + 1).trim());
    const given = rest.split(/\s+/).map(scrubQuotes).filter(Boolean);

    // Pull the First/Middle boundary marker out of the surname side FIRST (see
    // the file header). A `(...)` there - even empty - means the given section
    // is one WHOLE first name and the parens hold the middle. Extract it before
    // tokenizing, so a compound surname's own tokens are never confused with it,
    // and NEVER via the go-by matcher (which would swallow a real middle).
    const leftRaw = norm.slice(0, commaAt).trim();
    const markerMatch = leftRaw.match(MIDDLE_MARKER_RE);
    const hasMarker = markerMatch !== null;
    const markerMiddle = hasMarker ? scrubQuotes(markerMatch![1] ?? '') : '';
    const leftCore = hasMarker ? stripMiddleMarker(leftRaw) : leftRaw;

    const leftToks = leftCore.split(/\s+/).map(scrubQuotes).filter(Boolean);
    const suffixes: string[] = [];
    while (leftToks.length > 1 && SUFFIX_RE.test(leftToks[leftToks.length - 1]!)) {
      suffixes.unshift(leftToks.pop()!);
    }

    // Marker present: the whole right side is the first name; the middle came
    // from the parens. Absent: the legacy first-token / rest split (unchanged),
    // which is correct for every single-word first name.
    const first = hasMarker ? given.join(' ') : (given[0] ?? '');
    const middle = hasMarker ? markerMiddle : given.slice(1).join(' ');
    return {
      first,
      middle,
      last: leftToks.join(' '),
      extension: suffixes.join(' '),
      // Derive the implied go-by over the real given tokens (first + middle), so
      // a multi-word first still gets a sensible go-by when none is quoted.
      nickname: nickname || deriveGoBy([...first.split(/\s+/), ...(middle ? middle.split(/\s+/) : [])].filter(Boolean)),
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

/** Strip the marker delimiters () along with quotes from a raw part, so a user
 *  who types stray parens/quotes in a field can never forge or break the
 *  First/Middle boundary marker (the parens are STRUCTURAL in the composed
 *  string). Runs on top of {@link scrubQuotes}. */
function scrubPart(s: string): string {
  return scrubQuotes(s).replace(/[()]/g, '').replace(/\s+/g, ' ').trim();
}

/**
 * The master-list "Name" for a set of parts: `Surname[ Suffix], Given... "GoBy"`.
 * A parts set with no surname collapses to the given name / nickname alone (no
 * comma) so the server treats it as a plain name. The inverse of
 * {@link parseNameParts}: `compose(parse(name)) === name` for a canonical name.
 *
 * A MULTI-WORD first name is preserved across the round-trip by recording the
 * middle in parens on the surname side and putting the whole first name after
 * the comma - `Reroma (Miguel), Jan Kane Teves "Kane"` (empty `()` when there
 * is no middle). See the file header. A single-word first stays in the plain
 * legacy form, byte-identical to before.
 */
export function composeMasterListName(p: NameParts): string {
  // Scrub each part of stray double-quotes AND parens BEFORE assembling - the
  // nickname is wrapped in quotes and the middle-marker in parens, so this is
  // the load-bearing guarantee that the output carries exactly ONE clean quoted
  // go-by / ONE structural marker and can never accumulate stray delimiters, no
  // matter how mangled the incoming parts were.
  const first = scrubPart(p.first);
  const middle = scrubPart(p.middle);
  const last = scrubPart(p.last);
  const extension = scrubPart(p.extension);
  const nickname = scrubQuotes(p.nickname);

  const nickPart = nickname ? ` "${nickname}"` : '';
  if (!last) {
    // Mononym / given-only - no comma, so there is no surname side to hold a
    // marker; fall back to the plain space-joined given names.
    const given = [first, middle].filter(Boolean).join(' ');
    return given || nickname;
  }
  const suffix = extension ? ` ${extension}` : '';

  // Multi-word first is the ONLY case the naive re-split gets wrong, so it is
  // the only case that carries the marker. The marker (even empty `()`) tells
  // parse to keep the whole right side as the first name.
  if (first.includes(' ')) {
    return `${last}${suffix} (${middle}), ${first}${nickPart}`;
  }

  // Single-word first: legacy form. `given` re-splits correctly on read.
  const given = [first, middle].filter(Boolean).join(' ');
  if (!given) return `${last}${suffix}${nickPart}`;
  return `${last}${suffix}, ${given}${nickPart}`;
}
