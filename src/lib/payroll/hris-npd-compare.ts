/**
 * HRIS vs NPD — the Payroll Wizard Validation step's side-by-side of what HRIS will pay
 * each person against what the NPD sheet says, in US dollars, keyed on work email.
 *
 * PURE: no React, no fetch, no Date. The wizard hands in the Validation rows, the pasted
 * text, the cycle FX and the load state; this module decides every row and verdict, so the
 * rules below are testable without a browser.
 *
 * THE RULES (docs/features/payroll-wizard-hris-vs-npd.md)
 * -------------------------------------------------------
 * 1. **No row is ever dropped.** The result is the UNION of both sides: every HRIS row and
 *    every NPD line that parsed. A person missing on one side is labelled `not_in_hris` /
 *    `not_in_npd`, never filtered out. A pasted line that could not be read is a
 *    REFUSAL, listed with its line number and reason — never silently skipped.
 *    **The one exception is people configured not to be paid this week** (Excluded on
 *    Final Pay, or a department paused in Configuration; Kane, 2026-09-30). They are not
 *    compared at all, and they are listed in `leftOut` so the table can say so.
 * 2. **HRIS's dollar figure is the one Payment Dispatch stages.** `stagedUsdCents` is the
 *    `amount_usd` expression from the wizard's Send to Payment Dispatch, verbatim
 *    (`Math.round((php / fx) * 100) / 100`), applied per HRIS row and then summed — the
 *    test file pins that the wizard still stages it that way.
 * 3. **Match means within N cents, inclusive: N is the operator's, default 3**
 *    (`toleranceCents`, `DEFAULT_MATCH_TOLERANCE_CENTS`; Kane, 2026-09-30: first "make it
 *    match if the difference is just 3 cents", then a box "where the user can set the off by
 *    how many cents"). At the default, |NPD − HRIS| ≤ $0.03 is a match and $0.04 is not, so
 *    the 2026-08-18 NPD gaps ($0.81–$2.68) and that week's $0.07 residue are mismatches. A
 *    within-tolerance match keeps its `deltaCents`, so the difference is shown, never erased.
 * 4. **No verdict before the figures can be judged.** While any input behind the dollar
 *    figure is loading, has failed, or the cycle rate is still 0, every row keeps its
 *    figures and loses its verdict (`status: null`), and `hold` says why. A red row painted
 *    over an unloaded bonus is a false alarm; a green one over an unloaded figure is worse.
 * 5. **Absence is not zero.** With nothing pasted there are no rows at all — "everyone is
 *    Not in NPD" would be a claim about NPD that an empty box cannot support.
 * 6. **The join is the WORK EMAIL, exactly.** No master-list bridge and no personal or
 *    alternate address (Kane, 2026-09-30: "we are connecting this to the work email").
 */

import { normEmail } from '@/lib/email/norm-email';

import type { PayStubFieldState, PayStubSourceKey } from './paystub-field-state';

// ─── Parsing the NPD paste ────────────────────────────────────────────────────

export interface NpdPasteRow {
  /** 1-based line in the ORIGINAL paste, blank lines included, for messages. */
  line: number;
  /** The key cell, trimmed and lowercased. */
  email: string;
  /** The dollar figure in whole cents (exact decimal parse, half-up past the cent). */
  cents: number;
}

export interface NpdPasteRefusal {
  line: number;
  /** The raw line, so the refusal can be shown next to what was actually pasted. */
  raw: string;
  reason: string;
}

export interface NpdPasteParse {
  rows: NpdPasteRow[];
  refusals: NpdPasteRefusal[];
  /** True when the first content line had no email in it and was skipped as a header. */
  headerSkipped: boolean;
  /**
   * `tsv` — pasted from a spreadsheet (tab-separated). `typed` — no tab anywhere, so each
   * line is read as "email amount". Null when nothing was pasted.
   */
  mode: 'tsv' | 'typed' | null;
  /**
   * 0-based column the dollar figures were read from (TSV only): the RIGHTMOST column
   * that holds a value on any line with an email. Null in typed mode or when no line
   * had one.
   */
  amountColumn: number | null;
}

/** A single `@`, a dot in the domain, no whitespace or list punctuation. The real check is
 *  whether it reaches a person, which is `compareHrisNpd`'s job. */
const LOOKS_LIKE_EMAIL = /^[^\s@,;<>()"']+@[^\s@,;<>()"']+\.[^\s@,;<>()"']+$/;

/** Whole dollars with optional well-formed thousands commas, optional decimals. */
const PLAIN_DECIMAL = /^(?:\d+|\d{1,3}(?:,\d{3})+)(?:\.\d+)?$|^\.\d+$/;

function looksLikeEmail(cell: string): boolean {
  return LOOKS_LIKE_EMAIL.test(cell.trim().toLowerCase());
}

/**
 * One dollar cell → cents, or the reason it is not a dollar amount.
 *
 * Tolerates what a sheet or a person puts around a number: `$`, `US$`, `USD` before or
 * after it, a trailing `$` ("250$"), thousands commas, spaces, a leading minus and
 * accounting parentheses. Refuses anything that says pesos — a PHP column pasted as
 * the dollar column is the likeliest wrong paste, and its figures would be ~60× too big —
 * and anything that is not a plain decimal after the wrapping is removed (`#N/A`,
 * `12,50`, `n/a`).
 *
 * Parsed from the decimal STRING, never through float × 100, so `1.005` is 101 cents
 * (half-up on the third decimal), not the 100 that `Math.round(1.005 * 100)` gives.
 */
export function parseUsdCell(raw: string): { ok: true; cents: number } | { ok: false; reason: string } {
  const shown = raw.trim();
  if (shown === '') return { ok: false, reason: 'No dollar amount' };
  if (/₱|\bphp\b|\bpesos?\b/i.test(shown)) {
    return { ok: false, reason: `"${shown}" looks like pesos — paste NPD's dollar (USD) column` };
  }
  if (/\bcop\b|col\$/i.test(shown)) {
    return { ok: false, reason: `"${shown}" looks like Colombian pesos — paste NPD's dollar (USD) column` };
  }

  let t = shown.replace(/\s+/g, '').replace(/−/g, '-');
  let negative = false;
  const paren = /^\((.*)\)$/.exec(t);
  if (paren) {
    negative = true;
    t = paren[1];
  }
  // A sign may sit either side of the currency marker: "-$250", "$-250", "+$250".
  const takeSign = () => {
    if (t.startsWith('-')) {
      negative = !negative;
      t = t.slice(1);
    } else if (t.startsWith('+')) {
      t = t.slice(1);
    }
  };
  takeSign();
  t = t.replace(/^(?:us\$|usd|\$)/i, '');
  takeSign();
  t = t.replace(/(?:usd|\$)$/i, '');

  if (!PLAIN_DECIMAL.test(t)) return { ok: false, reason: `"${shown}" is not a dollar amount` };

  const [intRaw, frac = ''] = t.split('.');
  const intPart = intRaw.replace(/,/g, '') || '0';
  const cents2 = (frac + '00').slice(0, 2);
  let cents = Number(intPart) * 100 + Number(cents2);
  if (frac.length > 2 && frac[2] >= '5') cents += 1;
  if (!Number.isSafeInteger(cents)) return { ok: false, reason: `"${shown}" is too large to be a pay figure` };
  return { ok: true, cents: negative && cents !== 0 ? -cents : cents };
}

/**
 * The NPD paste → one row per readable line, a refusal per unreadable one.
 *
 * Spreadsheet paste is TAB-separated, and Google Sheets cannot copy two columns that are
 * not next to each other. So the clerk selects ONE block, from the Work Email column
 * across to the dollar column, and this reads it as:
 *   - the KEY is the first cell on the line that looks like an email;
 *   - the DOLLARS are in the block's rightmost column — the rightmost column that holds a
 *     value on ANY line with an email — and that column is FIXED for every line.
 * Fixing the column is what stops a person whose dollar cell is blank being read from the
 * cell beside it (their pesos, their hours): their line is refused instead. It also
 * makes a selection wider than the data harmless, because empty trailing columns never
 * hold a value. A total row (no email) cannot move the column either.
 *
 * With no tab anywhere (typed by hand) each line is "email amount", split at the first
 * space, comma or semicolon.
 *
 * The first content line is skipped as a header when it has no email in it; later lines
 * without an email are refused, so a stray total or note row is visible, not swallowed.
 * Repeated emails are NOT refused here — what a second line for one person means is the
 * comparison's call (it adds them), and it can see aliases this parser cannot.
 */
export function parseNpdPaste(text: string): NpdPasteParse {
  const rows: NpdPasteRow[] = [];
  const refusals: NpdPasteRefusal[] = [];
  const lines = text.split(/\r?\n/);
  const content = lines
    .map((raw, i) => ({ raw, line: i + 1 }))
    .filter((l) => l.raw.trim() !== '');
  if (content.length === 0) {
    return { rows, refusals, headerSkipped: false, mode: null, amountColumn: null };
  }

  const tsv = content.some((l) => l.raw.includes('\t'));
  let headerSkipped = false;

  if (!tsv) {
    content.forEach((l, idx) => {
      const trimmed = l.raw.trim();
      const m = /^([^\s,;]+)(?:[\s,;]+(.*))?$/.exec(trimmed);
      const first = (m?.[1] ?? '').toLowerCase();
      if (!looksLikeEmail(first)) {
        if (idx === 0) {
          headerSkipped = true;
          return;
        }
        refusals.push({ line: l.line, raw: l.raw, reason: 'Start each line with the work email, then the dollar amount' });
        return;
      }
      const amount = parseUsdCell(m?.[2] ?? '');
      if (!amount.ok) {
        refusals.push({ line: l.line, raw: l.raw, reason: amount.reason });
        return;
      }
      rows.push({ line: l.line, email: first, cents: amount.cents });
    });
    return { rows, refusals, headerSkipped, mode: 'typed', amountColumn: null };
  }

  type Split = { raw: string; line: number; cells: string[]; emailAt: number };
  const split: Split[] = content.map((l) => {
    const cells = l.raw.split('\t').map((c) => c.trim());
    return { raw: l.raw, line: l.line, cells, emailAt: cells.findIndex((c) => looksLikeEmail(c)) };
  });

  let body = split;
  if (split[0].emailAt === -1) {
    headerSkipped = true;
    body = split.slice(1);
  }

  let amountColumn = -1;
  for (const s of body) {
    if (s.emailAt === -1) continue;
    for (let c = s.cells.length - 1; c >= 0; c -= 1) {
      if (s.cells[c] !== '') {
        if (c > amountColumn) amountColumn = c;
        break;
      }
    }
  }

  for (const s of body) {
    if (!s.raw.includes('\t')) {
      refusals.push({ line: s.line, raw: s.raw, reason: 'Expected tab-separated cells like the other lines — paste straight from the sheet' });
      continue;
    }
    if (s.emailAt === -1) {
      refusals.push({ line: s.line, raw: s.raw, reason: 'No work email on this line' });
      continue;
    }
    if (s.emailAt >= amountColumn) {
      refusals.push({
        line: s.line,
        raw: s.raw,
        reason: 'No dollar amount to the right of the email — select from the Work Email column across to the dollar column',
      });
      continue;
    }
    const cell = s.cells[amountColumn] ?? '';
    const amount = parseUsdCell(cell);
    if (!amount.ok) {
      refusals.push({
        line: s.line,
        raw: s.raw,
        reason: cell === ''
          ? `No dollar amount in column ${amountColumn + 1} (the rightmost column of the paste)`
          : `${amount.reason} (column ${amountColumn + 1}, the rightmost column of the paste)`,
      });
      continue;
    }
    rows.push({ line: s.line, email: s.cells[s.emailAt].toLowerCase(), cents: amount.cents });
  }

  return {
    rows,
    refusals,
    headerSkipped,
    mode: 'tsv',
    amountColumn: amountColumn >= 0 ? amountColumn : null,
  };
}

// ─── HRIS's dollar figure ─────────────────────────────────────────────────────

/**
 * What Payment Dispatch is sent for one staged row, in cents. The wizard stages
 * `amount_usd: usdToPhpRate > 0 ? Math.round((e.pay_php.final / usdToPhpRate) * 100) / 100 : null`
 * (PayrollWizard.tsx, "Send to Payment Dispatch"); this is that expression before the
 * final `/ 100`, so it is the same integer. Null when there is no usable rate — never a
 * figure divided by the ₱1 placeholder or by zero.
 *
 * Keep it identical to the staging line. `hris-npd-compare.test.ts` reads the wizard's
 * source and fails if that line changes without this one.
 */
export function stagedUsdCents(php: number, fxRate: number): number | null {
  if (!(fxRate > 0) || !Number.isFinite(php)) return null;
  return Math.round((php / fxRate) * 100);
}

// ─── The comparison ───────────────────────────────────────────────────────────

/** One Validation-step row, reduced to what the comparison needs. */
export interface HrisCompareInput {
  /** The row's email — the calc-result key, normally the work email. */
  email: string;
  name: string;
  /** The PHP HRIS pays: the staged final, or the row's Gross when nothing is staged. */
  php: number;
  /** False when no dispatch payload exists (no personal email): dispatch sends nothing. */
  dispatchable: boolean;
  /** Accounting ticked Exclude ("do not pay") on the Validation step. Such a row is not
   *  compared; see `HrisNpdComparison.leftOut`. */
  excluded: boolean;
}

export interface CompareHrisNpdInput {
  hrisRows: readonly HrisCompareInput[];
  npdRows: readonly NpdPasteRow[];
  /** This cycle's USD→PHP rate (PHP per $1). 0 = not set yet. */
  fxRate: number;
  /** Whether every input behind the HRIS dollar figure has landed. */
  hrisState: PayStubFieldState;
  /** The inputs that failed, named in the banner. Read only when `hrisState` is `unavailable`. */
  unavailableSources?: readonly PayStubSourceKey[];
  /** The operator's "off by" setting, in whole cents (0–99). Anything unusable, or absent,
   *  means `DEFAULT_MATCH_TOLERANCE_CENTS`. */
  toleranceCents?: number;
  // There is deliberately NO alias / master-list bridge here. Kane, 2026-09-30: "We are not
  // connecting this with the personal email please we are connecting this to the work
  // email". A line reaches an HRIS row by its work email, exactly, or not at all.
  /** Normalized work emails of people whose department is paused this week ("Pay this week"
   *  off). NPD lines for them are LEFT OUT (`leftOut`, reason `paused`), not compared. */
  pausedEmails?: ReadonlySet<string>;
}

export type HrisNpdStatus = 'match' | 'mismatch' | 'not_in_hris' | 'not_in_npd';

export const HRIS_NPD_STATUSES: readonly HrisNpdStatus[] = ['match', 'mismatch', 'not_in_hris', 'not_in_npd'];

/**
 * The DEFAULT for how far NPD and HRIS may differ and still be a match, in cents, inclusive.
 * Kane, 2026-09-30: "now lets make it match if the difference is just 3 cents" (it was 0,
 * "equal to the cent", before that). Then, the same day: "Lets add a user input at the top
 * please after the load output where the user can set the off by how many cents". So the
 * operator sets it on the output (`CompareHrisNpdInput.toleranceCents`), this is what it
 * starts at, and nothing saves the choice. A match inside it still carries its `deltaCents`.
 */
export const DEFAULT_MATCH_TOLERANCE_CENTS = 3;

/** The highest the output's "off by" box accepts: whole cents, under a dollar. */
export const MAX_MATCH_TOLERANCE_CENTS = 99;

/**
 * A usable tolerance, or null. Whole cents from 0 to `MAX_MATCH_TOLERANCE_CENTS` only. A
 * fraction, a negative, NaN or anything above the cap is refused, never rounded or clamped
 * into range, so the box only ever applies exactly what the operator typed.
 */
export function parseToleranceCents(raw: unknown): number | null {
  const n = typeof raw === 'string' ? (raw.trim() === '' ? NaN : Number(raw.trim())) : raw;
  return typeof n === 'number' && Number.isInteger(n) && n >= 0 && n <= MAX_MATCH_TOLERANCE_CENTS ? n : null;
}

export interface HrisNpdRow {
  /** Stable React key. */
  key: string;
  /** HRIS's address when the person is in HRIS; otherwise the NPD address as pasted. */
  workEmail: string;
  /** HRIS's display name. Null for an NPD-only row. */
  name: string | null;
  inHris: boolean;
  inNpd: boolean;
  /** HRIS dollars, in cents — every HRIS row on this email, each rounded as staged, summed. Null when not in HRIS or when there is no rate. */
  hrisCents: number | null;
  /** HRIS pesos (the pivot), for NPD's implied rate. Null when not in HRIS. */
  hrisPhp: number | null;
  /** How many PAYABLE Validation rows carry this email (normally 1; 0 when not in HRIS). */
  hrisRowCount: number;
  /**
   * Excluded ("do not pay") rows on this same work email that were LEFT OUT of HRIS's
   * figure because the person also has a payable row. Normally 0. A person whose every row
   * is excluded is not a row at all: they are in `HrisNpdComparison.leftOut`.
   */
  excludedRowCount: number;
  /** Rows with no staged payload — dispatch will send them nothing. */
  noPayoutRowCount: number;
  /** NPD dollars in cents — every pasted line that landed here, summed. Null when not in NPD. */
  npdCents: number | null;
  /** The paste lines that landed on this row, in paste order. */
  npdLines: readonly number[];
  /** Null while verdicts are held (see `HrisNpdComparison.hold`). */
  status: HrisNpdStatus | null;
  /** NPD − HRIS, in cents, when both figures exist. Non-zero on a `match` when the two are
   *  within the tolerance (`HrisNpdComparison.toleranceCents`) but not equal — the table
   *  still shows it. */
  deltaCents: number | null;
  /** PHP per $1 that NPD's figure implies against HRIS's pesos. Set on a `mismatch` only. */
  impliedNpdRate: number | null;
}

/** Why a person is not compared at all. Both are the wizard's own do-not-pay configuration
 *  for the week (payroll-wizard-configuration-tab.md § "Pay this week"). */
export type HrisNpdLeftOutReason =
  /** Accounting ticked Exclude ("do not pay") on the Final Pay table. */
  | 'excluded'
  /** Their department is paused this week (Step 1 → Configuration → "Pay this week" off). */
  | 'paused';

/** A person left OUT of the comparison because they are configured not to be paid. */
export interface HrisNpdLeftOut {
  workEmail: string;
  /** HRIS's name when known (an excluded row); null for a paused-department NPD line. */
  name: string | null;
  reason: HrisNpdLeftOutReason;
  /** What NPD lists for them, in cents, or null when NPD does not list them. */
  npdCents: number | null;
  npdLines: readonly number[];
}

export type HrisNpdHold =
  | { kind: 'no_npd_rows' }
  | { kind: 'loading' }
  | { kind: 'unavailable'; sources: readonly PayStubSourceKey[] }
  | { kind: 'no_fx' };

export interface HrisNpdComparison {
  /** Sorted by `workEmail`. The union of both sides, minus `leftOut` — see rule 1. */
  rows: HrisNpdRow[];
  /**
   * People configured not to be paid this week, left OUT of `rows` (Kane, 2026-09-30:
   * "If they are configured not to be paid please lets not include them here"). They are
   * never a table row and never a line of the export (Kane, 2026-10-06: "they should not
   * reach the validation step … because they are not getting paid for that week"). Kept
   * here so the output can state how many were left out (never silent) and so Save output
   * stores them as `left_out`. Sorted by `workEmail`.
   */
  leftOut: HrisNpdLeftOut[];
  /** Null while verdicts are held. */
  counts: Record<HrisNpdStatus, number> | null;
  /** The tolerance these verdicts were given with — what the table says "within N¢" by. */
  toleranceCents: number;
  /** Whole-comparison sums over `rows`. They never follow a filter or a search. */
  totals: {
    /** Null when there is no rate. */
    hrisCents: number | null;
    npdCents: number;
    people: number;
  };
  /** Why no row has a verdict, or null when every row has one. */
  hold: HrisNpdHold | null;
}

/** Readable names for the loaders, for the "couldn't load" banner. A new source key is a
 *  type error here until it is named. */
export const HRIS_SOURCE_LABELS: Readonly<Record<PayStubSourceKey, string>> = {
  weekHours: 'Hubstaff hours',
  rates: 'pay rates',
  pabMerge: 'the PAB merge',
  pabPeriod: 'the PAB period',
  additions: 'the Additions values (adjustments, orphanage, bonus toggles)',
  managerKpi: 'manager KPI bonuses',
  hslKpi: 'HSL KPI bonuses',
  timeAdjustments: 'time adjustments',
  mesaDisbursements: 'MESA disbursements',
  mesaOptOut: 'the MESA opt-out ledger',
  masterRoster: 'the master roster',
  fx: 'this cycle’s USD→PHP rate',
};

function keyOf(email: string): string | null {
  return normEmail(email);
}

interface HrisGroup {
  email: string;
  name: string;
  php: number;
  stagedCents: number | null;
  rowCount: number;
  excludedRowCount: number;
  noPayoutRowCount: number;
}

interface NpdGroup {
  target: string | null;
  firstEmail: string;
  cents: number;
  lines: number[];
}

function resolveHold(input: CompareHrisNpdInput): HrisNpdHold | null {
  if (input.npdRows.length === 0) return { kind: 'no_npd_rows' };
  if (input.hrisState === 'pending') return { kind: 'loading' };
  if (input.hrisState === 'unavailable') return { kind: 'unavailable', sources: [...(input.unavailableSources ?? [])] };
  if (!(input.fxRate > 0)) return { kind: 'no_fx' };
  return null;
}

function round2(n: number): number {
  return Math.round((n + Number.EPSILON) * 100) / 100;
}

/**
 * Pair every HRIS row with NPD's figure for the same person. See the file header for
 * the rules; the ones that live only here:
 *
 * - **People configured not to be paid this week are not compared** (Kane, 2026-09-30:
 *   "If they are configured not to be paid please lets not include them here"). That is
 *   an Excluded ("do not pay") Validation row, and an NPD line for someone whose department
 *   is paused in Configuration. Neither becomes a row, and neither becomes a false "Not in
 *   HRIS": they go to `leftOut`, which the table discloses. A person with an excluded row
 *   AND a payable row on the same work email is compared on the payable one, and the row
 *   counts the excluded one it left out (`excludedRowCount`).
 * - HRIS rows are grouped by normalized email. Two payable Validation rows on one email
 *   are both staged, so both are paid — their staged cents are summed, never deduplicated.
 * - **An NPD line reaches an HRIS row by its WORK EMAIL, exactly (case- and
 *   whitespace-insensitive), or not at all.** No master-list bridge, no personal address,
 *   no alternate (Kane, 2026-09-30: "we are connecting this to the work email"). A line
 *   whose address is not an HRIS row's work email is its own Not-in-HRIS row, and the
 *   HRIS row stays Not in NPD — both visible, nothing guessed.
 * - Every NPD line on the same work email is ADDED (a person on two lines) — Kane's
 *   orphanage ruling of 2026-09-29, and HRIS pays one figure per person. Unmatched lines
 *   for one address are added too.
 */
export function compareHrisNpd(input: CompareHrisNpdInput): HrisNpdComparison {
  const hold = resolveHold(input);
  const judged = hold === null;
  const fxOk = input.fxRate > 0;
  const toleranceCents = parseToleranceCents(input.toleranceCents) ?? DEFAULT_MATCH_TOLERANCE_CENTS;

  if (input.npdRows.length === 0) {
    return {
      rows: [],
      leftOut: [],
      counts: null,
      toleranceCents,
      totals: { hrisCents: null, npdCents: 0, people: 0 },
      hold,
    };
  }

  // Payable rows only. Excluded rows are set aside by work email.
  const hris = new Map<string, HrisGroup>();
  const excluded = new Map<string, { email: string; name: string; rows: number }>();
  input.hrisRows.forEach((r, i) => {
    const k = keyOf(r.email) ?? `__hris_row_${i}`;
    if (r.excluded) {
      const x = excluded.get(k);
      if (x) x.rows += 1;
      else excluded.set(k, { email: r.email.trim() || '—', name: r.name, rows: 1 });
      return;
    }
    const cents = fxOk ? stagedUsdCents(r.php, input.fxRate) : null;
    const g = hris.get(k);
    if (g) {
      g.php += r.php;
      g.stagedCents = g.stagedCents == null || cents == null ? null : g.stagedCents + cents;
      g.rowCount += 1;
      if (!r.dispatchable) g.noPayoutRowCount += 1;
      if (!g.name && r.name) g.name = r.name;
    } else {
      hris.set(k, {
        email: r.email.trim() || '—',
        name: r.name,
        php: r.php,
        stagedCents: cents,
        rowCount: 1,
        excludedRowCount: 0,
        noPayoutRowCount: r.dispatchable ? 0 : 1,
      });
    }
  });
  // A payable person keeps a count of the excluded rows their figure leaves out.
  for (const [k, x] of excluded) {
    const g = hris.get(k);
    if (g) g.excludedRowCount += x.rows;
  }

  /** Configured not to be paid — and so not compared — when no payable row carries the email. */
  const leftOutReason = (k: string): HrisNpdLeftOutReason | null =>
    hris.has(k) ? null : excluded.has(k) ? 'excluded' : input.pausedEmails?.has(k) ? 'paused' : null;

  const npd = new Map<string, NpdGroup>();
  const leftOutNpd = new Map<string, { cents: number; lines: number[] }>();
  for (const line of input.npdRows) {
    const k = keyOf(line.email);
    if (!k) continue; // the parser never emits one; kept so a caller's row cannot throw
    if (leftOutReason(k)) {
      const l = leftOutNpd.get(k);
      if (l) {
        l.cents += line.cents;
        l.lines.push(line.line);
      } else {
        leftOutNpd.set(k, { cents: line.cents, lines: [line.line] });
      }
      continue;
    }
    // Work email, exactly. Nothing else reaches an HRIS row.
    const target: string | null = hris.has(k) ? k : null;
    const gk = target != null ? `hris:${target}` : `npd:${k}`;
    const g = npd.get(gk);
    if (g) {
      g.cents += line.cents;
      g.lines.push(line.line);
    } else {
      npd.set(gk, { target, firstEmail: k, cents: line.cents, lines: [line.line] });
    }
  }

  const rows: HrisNpdRow[] = [];

  for (const [k, g] of hris) {
    const n = npd.get(`hris:${k}`) ?? null;
    const hrisCents = g.stagedCents;
    const npdCents = n ? n.cents : null;
    const deltaCents = hrisCents != null && npdCents != null ? npdCents - hrisCents : null;
    let status: HrisNpdStatus | null = null;
    if (judged) {
      status =
        n == null
          ? 'not_in_npd'
          : deltaCents != null && Math.abs(deltaCents) <= toleranceCents
            ? 'match'
            : 'mismatch';
    }
    const impliedNpdRate =
      status === 'mismatch' && npdCents != null && npdCents > 0 && g.php > 0
        ? round2(g.php / (npdCents / 100))
        : null;
    rows.push({
      key: `hris:${k}`,
      workEmail: g.email,
      name: g.name || null,
      inHris: true,
      inNpd: n != null,
      hrisCents,
      hrisPhp: round2(g.php),
      hrisRowCount: g.rowCount,
      excludedRowCount: g.excludedRowCount,
      noPayoutRowCount: g.noPayoutRowCount,
      npdCents,
      npdLines: n ? n.lines : [],
      status,
      deltaCents,
      impliedNpdRate,
    });
  }

  for (const [gk, n] of npd) {
    if (n.target != null) continue;
    rows.push({
      key: gk,
      workEmail: n.firstEmail,
      name: null,
      inHris: false,
      inNpd: true,
      hrisCents: null,
      hrisPhp: null,
      hrisRowCount: 0,
      excludedRowCount: 0,
      noPayoutRowCount: 0,
      npdCents: n.cents,
      npdLines: n.lines,
      status: judged ? 'not_in_hris' : null,
      deltaCents: null,
      impliedNpdRate: null,
    });
  }

  rows.sort((a, b) => a.workEmail.localeCompare(b.workEmail) || a.key.localeCompare(b.key));

  // Every excluded person (NPD lists them or not), then every paused-department person NPD
  // lists. A paused person NPD does not list was never going to be a row on this step.
  const leftOut: HrisNpdLeftOut[] = [];
  for (const [k, x] of excluded) {
    if (hris.has(k)) continue;
    const l = leftOutNpd.get(k);
    leftOut.push({ workEmail: x.email, name: x.name || null, reason: 'excluded', npdCents: l ? l.cents : null, npdLines: l ? l.lines : [] });
  }
  for (const [k, l] of leftOutNpd) {
    if (excluded.has(k)) continue;
    leftOut.push({ workEmail: k, name: null, reason: 'paused', npdCents: l.cents, npdLines: l.lines });
  }
  leftOut.sort((a, b) => a.workEmail.localeCompare(b.workEmail));

  let counts: Record<HrisNpdStatus, number> | null = null;
  if (judged) {
    counts = { match: 0, mismatch: 0, not_in_hris: 0, not_in_npd: 0 };
    for (const r of rows) if (r.status) counts[r.status] += 1;
  }

  let hrisTotal: number | null = fxOk ? 0 : null;
  let npdTotal = 0;
  for (const r of rows) {
    if (hrisTotal != null && r.inHris) {
      if (r.hrisCents == null) hrisTotal = null;
      else hrisTotal += r.hrisCents;
    }
    if (r.npdCents != null) npdTotal += r.npdCents;
  }

  return {
    rows,
    leftOut,
    counts,
    toleranceCents,
    totals: { hrisCents: hrisTotal, npdCents: npdTotal, people: rows.length },
    hold,
  };
}

// ─── Display filter ───────────────────────────────────────────────────────────

/**
 * The table's chips: All and each verdict. There is no "Not paid" chip: people configured not
 * to be paid this week are never rows (Kane, 2026-10-06), so there is nothing for one to show.
 */
export type HrisNpdFilter = 'all' | HrisNpdStatus;

/**
 * The table's search + chips over the compared rows. DISPLAY ONLY: totals and counts are always
 * the whole comparison's. The needle matches the work email and the name.
 */
export function filterHrisNpdRows(
  rows: readonly HrisNpdRow[],
  opts: { needle?: string; status?: HrisNpdFilter },
): HrisNpdRow[] {
  const needle = (opts.needle ?? '').trim().toLowerCase();
  const status = opts.status ?? 'all';
  return rows.filter(
    (r) =>
      (status === 'all' || r.status === status) &&
      (!needle || `${r.workEmail} ${r.name ?? ''}`.toLowerCase().includes(needle)),
  );
}

// ─── Left out: how many, never who ───────────────────────────────────────────

/**
 * How many people were left out as configured not to be paid this week, by reason, and how
 * many of them NPD still lists. Kane, 2026-10-06: "they should not reach the validation step
 * … because they are not getting paid for that week", so they are never rows on screen or in
 * the export. This count is what is still said, by the output's notice line and the export's
 * notes alike, so leaving them out is never silent and NPD planning to pay someone HRIS will
 * not stays visible as a number.
 */
export interface HrisNpdLeftOutSummary {
  total: number;
  excluded: number;
  paused: number;
  /** Of `total`, how many NPD lists with a figure. */
  inNpd: number;
}

export function summarizeHrisNpdLeftOut(leftOut: readonly HrisNpdLeftOut[]): HrisNpdLeftOutSummary {
  const excluded = leftOut.filter((l) => l.reason === 'excluded').length;
  return {
    total: leftOut.length,
    excluded,
    paused: leftOut.length - excluded,
    inNpd: leftOut.filter((l) => l.npdCents != null).length,
  };
}

/** "2 excluded on Final Pay · 1 in a department paused in Step 1 → Configuration". */
export function hrisNpdLeftOutWhy(s: HrisNpdLeftOutSummary): string {
  return [
    s.excluded > 0 ? `${s.excluded} excluded on Final Pay` : null,
    s.paused > 0 ? `${s.paused} in a department paused in Step 1 → Configuration` : null,
  ]
    .filter(Boolean)
    .join(' · ');
}

/** Cents → the number `formatMoney(…, 'USD')` renders. */
export function centsToDollars(cents: number): number {
  return cents / 100;
}
