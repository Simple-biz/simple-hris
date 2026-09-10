/**
 * Parsing Jackie's Lead Gen appointment paste.
 *
 * The source is her weekly payroll email / team sheet, copied straight from a
 * spreadsheet, so it arrives TAB-separated with no header:
 *
 *   marcc@simple.biz  ⇥  Cahig, Marc Joseph            ⇥  32
 *   iked@simple.biz   ⇥  Dispo, Kenneth "Ike"          ⇥  21
 *   ricar@simple.biz  ⇥  Rabutin, Maria Fredericka "Rica"  ⇥  21
 *
 * Column 2 is the master-list display name — surname first, so it CONTAINS A
 * COMMA, and it may carry a quoted nickname. That single fact decides the whole
 * parser: nothing CSV-shaped may touch this text, and the orphanage paste's
 * fallback of splitting on commas when a line has no tabs
 * (`PayrollWizard.tsx:8331`) would shred "Cahig, Marc" into two cells and shift
 * the count into the name column. So this parser is TAB-ONLY and a line with no
 * tab is a refusal, never a guess.
 *
 * Pure. No I/O, no identity resolution — that is `compare.ts`'s job. This file
 * only decides whether a line is a well-formed (email, name, count) triple.
 *
 * Every rejection is a per-line refusal carrying the line number and the reason,
 * copied from the orphanage precedent: a row is never silently dropped and never
 * silently coerced. The orphanage parser's one real bug — a misaligned row prices
 * ₱0 because `Number('')` is 0 — is closed here by requiring the count to be a
 * whole number.
 */

export interface PastedAppointmentRow {
  /** 1-based line in the ORIGINAL paste, blank lines included, for error messages. */
  line: number;
  /** Column 1, trimmed and lowercased. The join key downstream. */
  email: string;
  /** Column 2, trimmed. Display only — never used to match a person. */
  displayName: string;
  /** Column 3 as a non-negative integer. */
  count: number;
}

export interface PasteRefusal {
  line: number;
  /** The raw line, so the refusal can be shown next to what was actually pasted. */
  raw: string;
  reason: string;
}

export interface PasteParse {
  rows: PastedAppointmentRow[];
  refusals: PasteRefusal[];
  /** True when the first content line looked like a header and was skipped. */
  headerSkipped: boolean;
}

/** A single `@` with something on both sides. Deliberately loose — the real
 *  check is whether it resolves to a member, and that is compare.ts's call. */
const LOOKS_LIKE_EMAIL = /^[^\s@]+@[^\s@]+$/;

/** Whole non-negative number. `"1,200"`, `"12.5"`, `""` and `"twelve"` all fail. */
const WHOLE_NUMBER = /^\d+$/;

export function parseAppointmentPaste(text: string): PasteParse {
  const rows: PastedAppointmentRow[] = [];
  const refusals: PasteRefusal[] = [];
  let headerSkipped = false;
  let headerConsidered = false;
  const firstLineByEmail = new Map<string, number>();

  const lines = text.split(/\r?\n/);
  for (let i = 0; i < lines.length; i += 1) {
    const raw = lines[i] ?? '';
    const line = i + 1;
    if (!raw.trim()) continue;

    if (!raw.includes('\t')) {
      refusals.push({
        line,
        raw,
        reason: 'Expected 3 tab-separated columns — paste straight from the sheet, not retyped',
      });
      continue;
    }

    // Trailing empty cells are a spreadsheet artefact (a selection wider than the
    // data); drop them before counting so "email ⇥ name ⇥ 32 ⇥" is still three.
    const cells = raw.split('\t').map((c) => c.trim());
    while (cells.length > 0 && cells[cells.length - 1] === '') cells.pop();

    const [emailRaw = '', nameRaw = '', countRaw = ''] = cells;

    // The first content line may be a header ("Email / Name / Appointments"): a
    // line whose first cell is not an email. Skip exactly one, and only at the top.
    if (!headerConsidered) {
      headerConsidered = true;
      if (!emailRaw.includes('@')) {
        headerSkipped = true;
        continue;
      }
    }

    if (cells.length !== 3) {
      refusals.push({
        line,
        raw,
        reason: `Expected 3 columns (work email, name, appointments) — got ${cells.length}`,
      });
      continue;
    }

    const email = emailRaw.toLowerCase();
    if (!LOOKS_LIKE_EMAIL.test(email)) {
      refusals.push({ line, raw, reason: `Column 1 must be a work email — got "${emailRaw}"` });
      continue;
    }

    if (!WHOLE_NUMBER.test(countRaw)) {
      refusals.push({
        line,
        raw,
        reason: `Appointments must be a whole number — got "${countRaw}"`,
      });
      continue;
    }

    const seenAt = firstLineByEmail.get(email);
    if (seenAt !== undefined) {
      refusals.push({ line, raw, reason: `Duplicate — ${email} already appears on line ${seenAt}` });
      continue;
    }
    firstLineByEmail.set(email, line);

    rows.push({ line, email, displayName: nameRaw, count: Number(countRaw) });
  }

  return { rows, refusals, headerSkipped };
}
