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
 * 2. **HRIS's dollar figure is the one Payment Dispatch stages.** `stagedUsdCents` is the
 *    `amount_usd` expression from the wizard's Send to Payment Dispatch, verbatim
 *    (`Math.round((php / fx) * 100) / 100`), applied per HRIS row and then summed — the
 *    test file pins that the wizard still stages it that way.
 * 3. **Match means within 3 cents** (`MATCH_TOLERANCE_CENTS`, Kane, 2026-09-30: "make it
 *    match if the difference is just 3 cents"). Inclusive: |NPD − HRIS| ≤ $0.03 is a match,
 *    $0.04 is not. It replaced "equal to the cent". The 2026-08-18 NPD gaps ($0.81–$2.68)
 *    and that week's $0.07 residue are still mismatches under it. A within-tolerance match
 *    keeps its `deltaCents`, so the difference is still shown, never erased.
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
  /** Accounting ticked Exclude ("do not pay") on the Validation step. */
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
  // There is deliberately NO alias / master-list bridge here. Kane, 2026-09-30: "We are not
  // connecting this with the personal email please we are connecting this to the work
  // email". A line reaches an HRIS row by its work email, exactly, or not at all.
  /** Normalized work emails of people whose department is paused this week ("Pay this week" off). */
  pausedEmails?: ReadonlySet<string>;
}

export type HrisNpdStatus = 'match' | 'mismatch' | 'not_in_hris' | 'not_in_npd';

export const HRIS_NPD_STATUSES: readonly HrisNpdStatus[] = ['match', 'mismatch', 'not_in_hris', 'not_in_npd'];

/**
 * The most NPD and HRIS may differ by and still be a match, in cents, inclusive.
 * Kane, 2026-09-30: "now lets make it match if the difference is just 3 cents". It was 0
 * ("equal to the cent") before that. A match inside it still carries its `deltaCents`.
 */
export const MATCH_TOLERANCE_CENTS = 3;

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
  /** How many Validation rows carry this email (normally 1; 0 when not in HRIS). */
  hrisRowCount: number;
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
   *  within `MATCH_TOLERANCE_CENTS` but not equal — the table still shows it. */
  deltaCents: number | null;
  /** PHP per $1 that NPD's figure implies against HRIS's pesos. Set on a `mismatch` only. */
  impliedNpdRate: number | null;
  /** A fact about the row the table should say out loud, or null. */
  note: string | null;
}

export type HrisNpdHold =
  | { kind: 'no_npd_rows' }
  | { kind: 'loading' }
  | { kind: 'unavailable'; sources: readonly PayStubSourceKey[] }
  | { kind: 'no_fx' };

export interface HrisNpdComparison {
  /** Sorted by `workEmail`. The union of both sides — see rule 1. */
  rows: HrisNpdRow[];
  /** Null while verdicts are held. */
  counts: Record<HrisNpdStatus, number> | null;
  /** Whole-comparison sums. They never follow a filter or a search. */
  totals: {
    /** Null when there is no rate. */
    hrisCents: number | null;
    npdCents: number;
    /** The HRIS total's share that belongs to rows Accounting excluded from pay. */
    excludedHrisCents: number;
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
  note: string | null;
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
 * - HRIS rows are grouped by normalized email. Two Validation rows on one email are both
 *   staged, so both are paid — their staged cents are summed, never deduplicated.
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

  if (input.npdRows.length === 0) {
    return {
      rows: [],
      counts: null,
      totals: { hrisCents: null, npdCents: 0, excludedHrisCents: 0, people: 0 },
      hold,
    };
  }

  const hris = new Map<string, HrisGroup>();
  input.hrisRows.forEach((r, i) => {
    const k = keyOf(r.email) ?? `__hris_row_${i}`;
    const cents = fxOk ? stagedUsdCents(r.php, input.fxRate) : null;
    const g = hris.get(k);
    if (g) {
      g.php += r.php;
      g.stagedCents = g.stagedCents == null || cents == null ? null : g.stagedCents + cents;
      g.rowCount += 1;
      if (r.excluded) g.excludedRowCount += 1;
      if (!r.dispatchable) g.noPayoutRowCount += 1;
      if (!g.name && r.name) g.name = r.name;
    } else {
      hris.set(k, {
        email: r.email.trim() || '—',
        name: r.name,
        php: r.php,
        stagedCents: cents,
        rowCount: 1,
        excludedRowCount: r.excluded ? 1 : 0,
        noPayoutRowCount: r.dispatchable ? 0 : 1,
      });
    }
  });

  const npd = new Map<string, NpdGroup>();
  for (const line of input.npdRows) {
    const k = keyOf(line.email);
    if (!k) continue; // the parser never emits one; kept so a caller's row cannot throw
    // Work email, exactly. Nothing else reaches an HRIS row.
    const target: string | null = hris.has(k) ? k : null;
    const note: string | null =
      target == null && input.pausedEmails?.has(k)
        ? 'In HRIS, but their department is paused this week (Step 1 → Configuration → “Pay this week”)'
        : null;
    const gk = target != null ? `hris:${target}` : `npd:${k}`;
    const g = npd.get(gk);
    if (g) {
      g.cents += line.cents;
      g.lines.push(line.line);
    } else {
      npd.set(gk, { target, firstEmail: k, cents: line.cents, lines: [line.line], note });
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
          : deltaCents != null && Math.abs(deltaCents) <= MATCH_TOLERANCE_CENTS
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
      note: null,
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
      note: n.note,
    });
  }

  rows.sort((a, b) => a.workEmail.localeCompare(b.workEmail) || a.key.localeCompare(b.key));

  let counts: Record<HrisNpdStatus, number> | null = null;
  if (judged) {
    counts = { match: 0, mismatch: 0, not_in_hris: 0, not_in_npd: 0 };
    for (const r of rows) if (r.status) counts[r.status] += 1;
  }

  let hrisTotal: number | null = fxOk ? 0 : null;
  let excludedHrisCents = 0;
  let npdTotal = 0;
  for (const r of rows) {
    if (hrisTotal != null && r.inHris) {
      if (r.hrisCents == null) hrisTotal = null;
      else hrisTotal += r.hrisCents;
    }
    if (r.inHris && r.excludedRowCount > 0 && r.hrisCents != null && r.excludedRowCount === r.hrisRowCount) {
      excludedHrisCents += r.hrisCents;
    }
    if (r.npdCents != null) npdTotal += r.npdCents;
  }

  return {
    rows,
    counts,
    totals: { hrisCents: hrisTotal, npdCents: npdTotal, excludedHrisCents, people: rows.length },
    hold,
  };
}

// ─── Display filter ───────────────────────────────────────────────────────────

export type HrisNpdFilter = 'all' | HrisNpdStatus;

/**
 * The table's search + status chips. DISPLAY ONLY: totals and counts are always the whole
 * comparison's. The needle matches the row's work email and its name.
 */
export function filterHrisNpdRows(
  rows: readonly HrisNpdRow[],
  opts: { needle?: string; status?: HrisNpdFilter },
): HrisNpdRow[] {
  const needle = (opts.needle ?? '').trim().toLowerCase();
  const status = opts.status ?? 'all';
  return rows.filter((r) => {
    if (status !== 'all' && r.status !== status) return false;
    if (!needle) return true;
    return `${r.workEmail} ${r.name ?? ''}`.toLowerCase().includes(needle);
  });
}

/** Cents → the number `formatMoney(…, 'USD')` renders. */
export function centsToDollars(cents: number): number {
  return cents / 100;
}
