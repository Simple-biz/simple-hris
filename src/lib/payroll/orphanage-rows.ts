/**
 * Orphanage hours → priced, matched rows. ONE resolver for both ways hours reach
 * the Orphanage step:
 *
 *   - the paste tool  — `tokenizeOrphanagePaste(text)` turns the sheet paste into rows
 *   - the OMS pull    — the Orphanage Management System tab hands rows straight in
 *
 * Both feed `resolveOrphanageHourRows`, so an approved OMS row and a pasted line for
 * the same person cannot come out as different money. The loop here is the paste
 * parser that lived inline in `PayrollWizard.tsx` (`orphanagePasteParse`) until
 * 2026-09-16, lifted verbatim behind an input shape; the arithmetic still belongs to
 * `orphanage-pay-pricing.ts` and nothing in this file multiplies anything.
 *
 * What "overtime" means is decided HERE, by the HRIS: `priceOrphanageHours` stacks the
 * hours on what the person already worked this pay week against the 40h cap, honouring
 * the global and per-department OT switches. OMS never says which hours are overtime.
 *
 * The doors differ in ONE thing, what a person's second line means (2026-09-29): the
 * paste ADDS it (`repeats: 'combine'` — summed, then priced once), OMS refuses it as a
 * duplicate (`'refuse'`, the default). See {@link OrphanageRepeatPolicy}.
 *
 * Doc: docs/features/orphanage-pay-step.md · docs/features/orphanage-oms-pull.md
 */

import { normEmail } from '@/lib/email/norm-email';

import { priceOrphanageHours, type OrphanagePriceOk, type OrphanagePriceRefusal } from './orphanage-pay-pricing';

/** One candidate row before matching: where it came from is irrelevant here. */
export interface OrphanageHourRow {
  /** 1-based position in its source (paste line, or OMS row order) — for the skipped list. */
  line: number;
  /** The source's pay-week label. Informational — never used to choose the period. */
  payWeek: string;
  email: string;
  /** Raw hours as the source gave them; strings keep the paste's `"1,234.5"` tolerance. */
  hours: string | number;
}

/** The Additions row a matched email lands on — the fields pricing and keying need. */
export interface OrphanageRowTarget {
  /** The Additions row's literal `.email` — the key `orphanageAmounts` uses. */
  email: string;
  name: string;
  regularRate: number | null;
  otRate: number | null;
  /** HSL sheet-form row ⇒ the OT rate is DERIVED (regular × 1.5), never read. */
  isHslSheetForm: boolean;
  /** Hours already worked this pay week — what the orphanage hours stack on. */
  workedRegularHours: number;
  deptKey: string | undefined;
  /** The row is priced as a flat SALARY this week (salaried-pay-basis.md): it has no hourly
   *  rate, so orphanage hours cannot be priced and the line is refused, never priced at ₱0. */
  salaried?: boolean;
}

export interface OrphanageResolveContext {
  /** Every Additions row, indexed by each normalized email that reaches it. */
  rowByEmail: ReadonlyMap<string, OrphanageRowTarget>;
  /**
   * The master-list bridge: for a normalized email that missed `rowByEmail`, the
   * normalized emails of the master record it belongs to (work, personal, alternates),
   * or null when no master record carries that address.
   */
  masterAliasesFor: (emailKey: string) => readonly string[] | null;
  /** PHP regular rate when the row itself has none — the rates index, by either key. */
  regularRateFallback: (rowEmail: string, matchedEmailKey: string) => number | null;
  /** The Initial Calculation's OT switches, global and per department. */
  overtimeEnabledFor: (deptKey: string | undefined) => boolean;
}

export interface OrphanageResolvedOk {
  line: number;
  payWeek: string;
  /** The Additions row's literal `.email` — the key {@link orphanageAmounts} uses. */
  emailKey: string;
  matchedEmail: string;
  name: string;
  hours: number;
  /** Regular hourly rate (PHP). */
  rate: number;
  /** OT hourly rate (PHP) actually paid for the OT-crossing hours, or null when none
   *  on file. Always the FULL rate: on HSL sheet-form rows this is regular × 1.5,
   *  never the weekly 0.5× differential (orphanage hours have no base leg). */
  otRate: number | null;
  /** Split of the hours after stacking on worked hours against the 40h/week cap. */
  regH: number;
  otH: number;
  amount: number;
  /**
   * Set only when this person's hours were ADDED from more than one source line
   * (`repeats: 'combine'`, the paste door): each line and its hours, in source order.
   * `hours` above is their sum and the amount prices that sum ONCE. Absent ⇒ one line.
   */
  combinedFrom?: readonly { line: number; hours: number }[];
}

export interface OrphanageResolvedErr {
  line: number;
  email: string;
  reason: string;
}

export interface OrphanageResolveResult {
  ok: OrphanageResolvedOk[];
  errors: OrphanageResolvedErr[];
}

/**
 * The paste tool's tokenizer. Spreadsheet paste is tab-delimited; comma / 2+ spaces
 * only when a line has no tabs at all (hand-typed input). The first content line may
 * be a header ("Pay week / Email / Hours") and is dropped when it looks like one.
 * A line with fewer than three cells is an error row, not a skipped line — the clerk
 * sees every line that did not become money.
 */
export function tokenizeOrphanagePaste(text: string): { rows: OrphanageHourRow[]; errors: OrphanageResolvedErr[] } {
  const rows: OrphanageHourRow[] = [];
  const errors: OrphanageResolvedErr[] = [];
  if (!text.trim()) return { rows, errors };

  let headerHandled = false;
  const lines = text.split(/\r?\n/);
  for (let i = 0; i < lines.length; i++) {
    const raw = lines[i];
    if (!raw || !raw.trim()) continue;
    const cells = (raw.includes('\t') ? raw.split('\t') : raw.split(/,|\s{2,}/)).map((c) => c.trim());
    const payWeekRaw = cells[0] ?? '';
    const emailRaw = cells[1] ?? '';
    const hoursRaw = cells[2] ?? '';

    if (!headerHandled) {
      headerHandled = true;
      if (!emailRaw.includes('@') && (/pay\s*week/i.test(payWeekRaw) || /e-?mail/i.test(emailRaw))) continue;
    }

    if (cells.filter(Boolean).length < 3) {
      errors.push({ line: i + 1, email: emailRaw, reason: 'Expected 3 columns: Pay week, Work email, Hours' });
      continue;
    }

    rows.push({ line: i + 1, payWeek: payWeekRaw, email: emailRaw, hours: hoursRaw });
  }
  return { rows, errors };
}

/**
 * What a second line for a person who is already in the list means.
 *
 * - `refuse`  — the second line is skipped as a duplicate. The OMS door: its Save keys
 *               ONE result per OMS row (`oms-save.ts`), and a repeat there is a fix in OMS
 *               (orphanage-oms-pull.md § Skipped rows). The default, and byte-for-byte the
 *               loop that has always run.
 * - `combine` — the lines' hours are ADDED and the total is priced ONCE (Kane 2026-09-29,
 *               the paste door: *"if there are two line items just add them both and
 *               calculate properly"*).
 */
export type OrphanageRepeatPolicy = 'refuse' | 'combine';

/**
 * Match each row to an Additions row and price it. Refusals are reported per row and
 * never block other people; a row we cannot price is not worth a smaller number.
 */
export function resolveOrphanageHourRows(
  rows: readonly OrphanageHourRow[],
  ctx: OrphanageResolveContext,
  opts: { repeats: OrphanageRepeatPolicy } = { repeats: 'refuse' },
): OrphanageResolveResult {
  return opts.repeats === 'combine' ? resolveCombiningRepeats(rows, ctx) : resolveRefusingRepeats(rows, ctx);
}

/** `refuse`: one pass, a person's second line is a duplicate once their first has priced. */
function resolveRefusingRepeats(rows: readonly OrphanageHourRow[], ctx: OrphanageResolveContext): OrphanageResolveResult {
  const ok: OrphanageResolvedOk[] = [];
  const errors: OrphanageResolvedErr[] = [];
  const seenKeys = new Set<string>();

  for (const r of rows) {
    const emailRaw = r.email.trim();
    const emKey = normEmail(emailRaw);
    if (!emKey) {
      errors.push({ line: r.line, email: emailRaw, reason: 'Missing or invalid email' });
      continue;
    }

    const { hoursRaw, hours } = parseHours(r.hours);
    if (hours === null) {
      errors.push({ line: r.line, email: emailRaw, reason: `Invalid hours: "${hoursRaw}"` });
      continue;
    }

    const row = resolveTarget(emKey, ctx);
    if (!row) {
      errors.push({ line: r.line, email: emailRaw, reason: 'No employee in this pay period matches that work email' });
      continue;
    }

    // The Orphanage column holds one value per person, so a repeat is an error.
    if (seenKeys.has(row.email)) {
      errors.push({ line: r.line, email: emailRaw, reason: 'Duplicate — this employee already appears above in the list' });
      continue;
    }

    const priced = priceForTarget(row, hours, emKey, ctx);
    if (!priced.ok) {
      errors.push({ line: r.line, email: emailRaw, reason: priced.reason });
      continue;
    }

    seenKeys.add(row.email);
    ok.push(resolvedOk({ line: r.line, payWeek: r.payWeek, emKey }, row, priced));
  }

  return { ok, errors };
}

/** One line after matching, before pricing. */
interface MatchedLine {
  line: number;
  payWeek: string;
  emailRaw: string;
  emKey: string;
  /** Null when the hours cell was invalid — the line already carries its error. */
  hours: number | null;
}

/**
 * `combine`: "properly" means the hours are summed BEFORE pricing. The 40h cap is
 * consumed once by the person's total, never once per line — pricing each line against
 * the same worked hours would pay the regular capacity twice. And a person is priced
 * from ALL their lines or not at all: if any line is refused (bad hours), the others are
 * held with a reason, because locking in the good line alone pays less than the sheet
 * and a later re-paste of just the fixed line would REPLACE that amount, not add to it.
 */
function resolveCombiningRepeats(rows: readonly OrphanageHourRow[], ctx: OrphanageResolveContext): OrphanageResolveResult {
  const errors: OrphanageResolvedErr[] = [];
  // Keyed on the Additions row's literal `.email`, so two addresses (or two casings) of
  // one person land together. Insertion order = first appearance, so `ok` keeps source order.
  const groups = new Map<string, { target: OrphanageRowTarget; lines: MatchedLine[]; refused: number[] }>();

  for (const r of rows) {
    const emailRaw = r.email.trim();
    const emKey = normEmail(emailRaw);
    if (!emKey) {
      errors.push({ line: r.line, email: emailRaw, reason: 'Missing or invalid email' });
      continue;
    }

    const { hoursRaw, hours } = parseHours(r.hours);
    // A bad hours cell is reported, and the line is STILL matched so it can hold the
    // person's other lines instead of letting them pay short.
    if (hours === null) errors.push({ line: r.line, email: emailRaw, reason: `Invalid hours: "${hoursRaw}"` });

    const target = resolveTarget(emKey, ctx);
    if (!target) {
      if (hours !== null) {
        errors.push({ line: r.line, email: emailRaw, reason: 'No employee in this pay period matches that work email' });
      }
      continue;
    }

    const matched: MatchedLine = { line: r.line, payWeek: r.payWeek, emailRaw, emKey, hours };
    const group = groups.get(target.email);
    if (group) {
      group.lines.push(matched);
      if (hours === null) group.refused.push(r.line);
    } else {
      groups.set(target.email, { target, lines: [matched], refused: hours === null ? [r.line] : [] });
    }
  }

  const ok: OrphanageResolvedOk[] = [];
  for (const { target, lines, refused } of groups.values()) {
    if (refused.length > 0) {
      const which = refused.map((l) => `L${l}`).join(', ');
      for (const l of lines) {
        if (l.hours === null) continue; // already reported with its own reason
        errors.push({
          line: l.line,
          email: l.emailRaw,
          reason: `Held — this person's ${which} was skipped, so none of their hours are locked in. Fix it and paste again`,
        });
      }
      continue;
    }

    const parts = lines.map((l) => ({ line: l.line, hours: l.hours as number }));
    // One line: its hours untouched. Several: summed, then de-noised at 6dp exactly as
    // `priceOrphanageHours` de-noises its own float subtraction (2.1 + 3.2 ≠ 5.3 in IEEE).
    const hours = parts.length === 1
      ? parts[0].hours
      : Math.round(parts.reduce((s, p) => s + p.hours, 0) * 1e6) / 1e6;

    const first = lines[0];
    const priced = priceForTarget(target, hours, first.emKey, ctx);
    if (!priced.ok) {
      // Every line that did not become money is listed — the clerk sees each one.
      for (const l of lines) errors.push({ line: l.line, email: l.emailRaw, reason: priced.reason });
      continue;
    }

    const payWeek = parts.length === 1
      ? first.payWeek
      : [...new Set(lines.map((l) => l.payWeek.trim()).filter(Boolean))].join(', ');
    ok.push({
      ...resolvedOk({ line: first.line, payWeek, emKey: first.emKey }, target, priced),
      ...(parts.length > 1 ? { combinedFrom: parts } : {}),
    });
  }

  return { ok, errors: errors.sort((a, b) => a.line - b.line) };
}

/** The hours cell, with the paste's `"1,234.5"` tolerance. `hours` null ⇒ invalid. */
function parseHours(raw: string | number): { hoursRaw: string; hours: number | null } {
  const hoursRaw = typeof raw === 'number' ? String(raw) : raw.trim();
  const hours = Number(hoursRaw.replace(/,/g, ''));
  return { hoursRaw, hours: hoursRaw === '' || !Number.isFinite(hours) || hours < 0 ? null : hours };
}

/** Email → an Additions row. Direct hit first, then bridge through the master list
 *  (alternate / personal / Hubstaff-email mismatches). */
function resolveTarget(emKey: string, ctx: OrphanageResolveContext): OrphanageRowTarget | null {
  const direct = ctx.rowByEmail.get(emKey);
  if (direct) return direct;
  const aliases = ctx.masterAliasesFor(emKey);
  if (aliases) {
    for (const c of aliases) {
      const hit = ctx.rowByEmail.get(c);
      if (hit) return hit;
    }
  }
  return null;
}

function priceForTarget(target: OrphanageRowTarget, hours: number, emKey: string, ctx: OrphanageResolveContext) {
  // A salaried week has no hourly rate to price orphanage hours at, and the rates-index
  // fallback would read the salary structure's pinned 0. How a salaried person's orphanage
  // hours pay is not ruled (salaried-pay-basis.md), so the line is refused with that reason.
  if (target.salaried) {
    const refusal: OrphanagePriceRefusal = {
      ok: false,
      code: 'no_regular_rate',
      reason: 'Salaried this week — a salary has no hourly rate to price orphanage hours at. Enter the amount by hand.',
    };
    return refusal;
  }
  // PHP regular rate. Prefer the row's computed rate; fall back to the rates index.
  const rate: number | null = target.regularRate ?? ctx.regularRateFallback(target.email, emKey);

  // All the arithmetic lives in `orphanage-pay-pricing.ts`. It owns the 40h cap, the
  // sheet's 2dp-hours rounding, and the rule this step exists to protect: orphanage
  // OT prices at the FULL 1.5× rate, never the weekly 0.5× differential. It REFUSES
  // a row it cannot price rather than returning a smaller number.
  return priceOrphanageHours({
    hours,
    regularRatePhp: rate,
    storedOtRatePhp: target.otRate,
    isHslSheetForm: target.isHslSheetForm,
    workedRegularHours: target.workedRegularHours,
    overtimeEnabled: ctx.overtimeEnabledFor(target.deptKey),
  });
}

function resolvedOk(
  src: { line: number; payWeek: string; emKey: string },
  target: OrphanageRowTarget,
  priced: OrphanagePriceOk,
): OrphanageResolvedOk {
  return {
    line: src.line,
    payWeek: src.payWeek,
    emailKey: target.email,
    matchedEmail: src.emKey,
    name: target.name || target.email,
    hours: priced.hours,
    rate: priced.rate,
    otRate: priced.otRate,
    regH: priced.regH,
    otH: priced.otH,
    amount: priced.amount,
  };
}

/** Merge tokenizer errors with resolver errors in source order — one skipped list. */
export function mergeOrphanageErrors(...lists: readonly OrphanageResolvedErr[][]): OrphanageResolvedErr[] {
  return lists.flat().sort((a, b) => a.line - b.line);
}
