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
 * Doc: docs/features/orphanage-pay-step.md · docs/features/orphanage-oms-pull.md
 */

import { normEmail } from '@/lib/email/norm-email';

import { priceOrphanageHours } from './orphanage-pay-pricing';

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
 * Match each row to an Additions row and price it. Refusals are reported per row and
 * never block the rest; a row we cannot price is not worth a smaller number.
 */
export function resolveOrphanageHourRows(
  rows: readonly OrphanageHourRow[],
  ctx: OrphanageResolveContext,
): OrphanageResolveResult {
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

    const hoursRaw = typeof r.hours === 'number' ? String(r.hours) : r.hours.trim();
    const hours = Number(hoursRaw.replace(/,/g, ''));
    if (hoursRaw === '' || !Number.isFinite(hours) || hours < 0) {
      errors.push({ line: r.line, email: emailRaw, reason: `Invalid hours: "${hoursRaw}"` });
      continue;
    }

    // Resolve the email → an Additions row. Direct hit first, then bridge through the
    // master list (alternate / personal / Hubstaff-email mismatches).
    let row = ctx.rowByEmail.get(emKey) ?? null;
    if (!row) {
      const aliases = ctx.masterAliasesFor(emKey);
      if (aliases) {
        for (const c of aliases) {
          const hit = ctx.rowByEmail.get(c);
          if (hit) { row = hit; break; }
        }
      }
    }
    if (!row) {
      errors.push({ line: r.line, email: emailRaw, reason: 'No employee in this pay period matches that work email' });
      continue;
    }

    // The Orphanage column holds one value per person, so a repeat is an error.
    if (seenKeys.has(row.email)) {
      errors.push({ line: r.line, email: emailRaw, reason: 'Duplicate — this employee already appears above in the list' });
      continue;
    }

    // PHP regular rate. Prefer the row's computed rate; fall back to the rates index.
    const rate: number | null = row.regularRate ?? ctx.regularRateFallback(row.email, emKey);

    // All the arithmetic lives in `orphanage-pay-pricing.ts`. It owns the 40h cap, the
    // sheet's 2dp-hours rounding, and the rule this step exists to protect: orphanage
    // OT prices at the FULL 1.5× rate, never the weekly 0.5× differential. It REFUSES
    // a row it cannot price rather than returning a smaller number.
    const priced = priceOrphanageHours({
      hours,
      regularRatePhp: rate,
      storedOtRatePhp: row.otRate,
      isHslSheetForm: row.isHslSheetForm,
      workedRegularHours: row.workedRegularHours,
      overtimeEnabled: ctx.overtimeEnabledFor(row.deptKey),
    });
    if (!priced.ok) {
      errors.push({ line: r.line, email: emailRaw, reason: priced.reason });
      continue;
    }

    seenKeys.add(row.email);
    ok.push({
      line: r.line,
      payWeek: r.payWeek,
      emailKey: row.email,
      matchedEmail: emKey,
      name: row.name || row.email,
      hours: priced.hours,
      rate: priced.rate,
      otRate: priced.otRate,
      regH: priced.regH,
      otH: priced.otH,
      amount: priced.amount,
    });
  }

  return { ok, errors };
}

/** Merge tokenizer errors with resolver errors in source order — one skipped list. */
export function mergeOrphanageErrors(...lists: readonly OrphanageResolvedErr[][]): OrphanageResolvedErr[] {
  return lists.flat().sort((a, b) => a.line - b.line);
}
