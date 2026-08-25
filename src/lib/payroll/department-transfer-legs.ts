/**
 * Mid-week department transfers, as a paystub disclosure.
 *
 * A transfer moves the department **label** the moment the source manager
 * releases it; the `effective_date` is only the anchor payroll prices by
 * (`docs/features/department-transfers.md` §2). So the statement's Department
 * line shows where the person *ended up*, and a week whose effective date fell
 * inside it silently reads as if they had been there all along — the same class
 * of "my paystub doesn't explain itself" gap the proration chip closed for
 * money.
 *
 * This module derives the disclosure: **"Lead Gen to HSL"** under the
 * Department, for every transfer whose effective date lands inside the pay week.
 *
 * Deliberately NOT sourced from the payload's `proration` block. *"A transfer is
 * a relabel, only a rate change prorates"* — `department-transfers.md`:280.
 * raymandc@ and janrielr@ moved into HSL and back out inside one week with no
 * rate on either side, so they carry no proration block at all and would have
 * been exactly the people this label exists for. The source of truth is
 * `department_transfer_requests`.
 *
 * PURE + client-safe (the Payroll Wizard builds the payload in the browser).
 * The server fetch lives in `hsl-transfer-effective.ts` beside the into-HSL map,
 * so both maps come from ONE paginated read of the same table.
 */

import { formatDeptLabel } from '@/lib/departments/hsl-subdept';

/** One department move whose effective date lands inside a pay week. */
export interface DepartmentTransferLegRaw {
  /** Raw `from_department` cell — `Lead Gen`, `HSL`, `hsl:intake_specialist`. */
  from: string;
  /** Raw `to_department` cell. */
  to: string;
  /** `YYYY-MM-DD`, verbatim from the transfer (never snapped — see the 2026-08-18 ruling). */
  effective_date: string;
}

/**
 * The payload block. An OBJECT rather than a bare array, matching `weekend` /
 * `proration` / `hogan_sheet`, so a future field lands without a shape
 * migration on nine thousand staged rows.
 *
 * Absent or null — every payload staged before 2026-08-25, and every week
 * without a transfer — renders the classic statement, byte-identical.
 */
export interface DepartmentTransferBlockRaw {
  legs: DepartmentTransferLegRaw[];
}

/** The subset of a `department_transfer_requests` row this needs. */
export interface TransferLegRowLike {
  employee_email: string | null;
  employee_work_email: string | null;
  from_department: string | null;
  to_department: string | null;
  effective_date: string | null;
  status: string | null;
}

const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;

/** Lowercase + trim, the same key shape `buildHslTransferEffectiveMap` uses. */
function key(email: string | null | undefined): string | null {
  const s = (email ?? '').trim().toLowerCase();
  return s || null;
}

function legId(l: DepartmentTransferLegRaw): string {
  return `${l.effective_date}|${l.from}|${l.to}`;
}

/**
 * Order legs the way the week ran: by effective date, then by the raw pair so
 * two moves dated the same day still land in a stable order (a jsonb round-trip
 * and a re-stage must produce the identical block, or the freshness compare
 * churns forever).
 */
function sortLegs(legs: DepartmentTransferLegRaw[]): DepartmentTransferLegRaw[] {
  return [...legs].sort(
    (a, b) =>
      a.effective_date.localeCompare(b.effective_date) ||
      a.from.localeCompare(b.from) ||
      a.to.localeCompare(b.to),
  );
}

/**
 * PURE builder: rows → Map<lowercased email, every leg that person has>.
 *
 * **`applied` ONLY — deliberately narrower than the into-HSL premium map**,
 * which trusts `applied` *and* `approved`. The two gates answer different
 * questions and must not be unified:
 *
 * - the premium map asks *"when did HSL work start?"*, which the effective date
 *   answers whether or not the master row was ever written;
 * - this asks *"why does the Department line say what it says?"* — and the
 *   Department line only moves when `applyApprovedTransfer` writes
 *   `global_master_list."Department"`, i.e. at `applied`.
 *
 * A row stuck at `approved` is one whose apply FAILED (release applies
 * immediately — `department-transfers.md` §2); its label never moved. Measured
 * 2026-08-25: 276 `applied`, **6 `approved` with a null `applied_at`** — every
 * one of them still sitting in the old department. Disclosing those would print
 * "Lead Gen to HSL" under a Department line that still reads Lead Gen.
 *
 * Unlike the into-HSL map this keeps **every** move: a Lead Gen → Client VA
 * transfer is exactly as disclosable as a move into HSL, and an intra-HSL
 * sub-team reshuffle is a real relabel the employee can see on their roster.
 * (The into-HSL map skips those because a reshuffle is not an *arrival*, which
 * is a question about the weekend premium, not about disclosure.)
 *
 * Keyed on both `employee_email` and `employee_work_email`, like the into-HSL
 * map; callers bridge the rest of a person's aliases from the master list.
 */
export function buildTransferLegsByEmail(
  rows: TransferLegRowLike[],
): Map<string, DepartmentTransferLegRaw[]> {
  const byEmail = new Map<string, Map<string, DepartmentTransferLegRaw>>();

  for (const r of rows) {
    if ((r.status ?? '').trim().toLowerCase() !== 'applied') continue;

    const from = (r.from_department ?? '').trim();
    const to = (r.to_department ?? '').trim();
    if (!from || !to) continue;

    const eff = (r.effective_date ?? '').slice(0, 10);
    if (!ISO_DATE.test(eff)) continue;

    const leg: DepartmentTransferLegRaw = { from, to, effective_date: eff };
    const id = legId(leg);

    for (const raw of [r.employee_email, r.employee_work_email]) {
      const em = key(raw);
      if (!em) continue;
      let bucket = byEmail.get(em);
      if (!bucket) {
        bucket = new Map();
        byEmail.set(em, bucket);
      }
      // Same move reachable under two emails, or duplicated rows: one leg.
      bucket.set(id, leg);
    }
  }

  const out = new Map<string, DepartmentTransferLegRaw[]>();
  for (const [em, bucket] of byEmail) out.set(em, sortLegs([...bucket.values()]));
  return out;
}

/**
 * The legs of one person's week: effective date inside `[weekStart, weekEnd]`,
 * both ends INCLUSIVE. Dates are `YYYY-MM-DD` so the compare is lexical — no
 * `Date` parsing, hence no timezone drift between the browser that stages the
 * payload and the server that re-prices it.
 *
 * A transfer effective BEFORE the week is not disclosed: the person worked the
 * whole week in the department the statement already names. One effective AFTER
 * the week is not disclosed either — the label moved early (release is
 * immediate), and the week itself was worked entirely in the old department.
 * That second case is a real reporting gap and it is NOT this block's to fix:
 * it needs the Department line itself to be as-of-the-week, which changes what
 * nine thousand staged payloads mean.
 */
export function transferLegsInWeek(
  legs: readonly DepartmentTransferLegRaw[] | undefined,
  weekStart: string | null | undefined,
  weekEnd: string | null | undefined,
): DepartmentTransferLegRaw[] {
  const start = (weekStart ?? '').slice(0, 10);
  const end = (weekEnd ?? '').slice(0, 10);
  if (!ISO_DATE.test(start) || !ISO_DATE.test(end) || !legs?.length) return [];
  return sortLegs(
    legs.filter((l) => ISO_DATE.test(l.effective_date) && l.effective_date >= start && l.effective_date <= end),
  );
}

/** Build the payload block, or null when the week carries no transfer. */
export function transferBlockForWeek(
  legs: readonly DepartmentTransferLegRaw[] | undefined,
  weekStart: string | null | undefined,
  weekEnd: string | null | undefined,
): DepartmentTransferBlockRaw | null {
  const inWeek = transferLegsInWeek(legs, weekStart, weekEnd);
  return inWeek.length ? { legs: inWeek } : null;
}

/** Tolerant parse of a jsonb-round-tripped block (payload or snapshot). */
export function parseTransferBlock(raw: unknown): DepartmentTransferBlockRaw | null {
  if (!raw || typeof raw !== 'object') return null;
  const legsRaw = (raw as { legs?: unknown }).legs;
  if (!Array.isArray(legsRaw)) return null;

  const legs: DepartmentTransferLegRaw[] = [];
  for (const item of legsRaw) {
    if (!item || typeof item !== 'object') continue;
    const o = item as Record<string, unknown>;
    const from = typeof o.from === 'string' ? o.from.trim() : '';
    const to = typeof o.to === 'string' ? o.to.trim() : '';
    const eff = typeof o.effective_date === 'string' ? o.effective_date.slice(0, 10) : '';
    if (!from || !to || !ISO_DATE.test(eff)) continue;
    legs.push({ from, to, effective_date: eff });
  }
  return legs.length ? { legs: sortLegs(legs) } : null;
}

/**
 * The human string under the Department: **"Lead Gen to HSL"**.
 *
 * Both sides go through `formatDeptLabel`, per `hsl-subdepartments.md` §12 —
 * *"wraps every department value on its way to a human … the paystub statement,
 * its email and its export"*. So a move into a sub-team reads **"Lead Gen to
 * HSL — Intake Specialist"**, never the `hsl:intake_specialist` storage key.
 * `collapseHslFamilyLabel` is deliberately NOT used: it is documented for
 * pickers and filters, where one HSL entry is the point.
 *
 * Several legs in one week are real — five people-weeks in production, e.g.
 * raymandc@ (Lead Gen → HSL Tue, HSL → Lead Gen Thu, 2026-08-09 week):
 *
 * - legs that chain, where each `from` displays identically to the previous
 *   `to`, collapse into the round trip a human would actually say:
 *   **"Lead Gen to HSL to Lead Gen"**;
 * - legs that do NOT chain are printed separately, joined by ` · `. hansc@'s
 *   2026-08-16 week is exactly this (Client VA → Lead Gen, then
 *   hsl:filing_specialist → Lead Gen): pretending it is one journey would
 *   invent a move that never happened.
 *
 * Chaining is decided on the DISPLAYED label, not a normalized key, so the
 * printed chain can only ever collapse two labels a reader sees as the same
 * word. `HSL` followed by `HSL — Intake Specialist` stays two legs.
 */
export function formatTransferLabel(
  block: DepartmentTransferBlockRaw | null | undefined,
): string {
  const legs = block?.legs;
  if (!legs?.length) return '';

  const shown = legs.map((l) => ({
    from: formatDeptLabel(l.from) || l.from,
    to: formatDeptLabel(l.to) || l.to,
  }));

  const chains = shown.every(
    (l, i) => i === 0 || l.from.trim().toLowerCase() === shown[i - 1].to.trim().toLowerCase(),
  );

  if (chains) {
    const hops = [shown[0].from, ...shown.map((l) => l.to)];
    return hops.join(' to ');
  }
  return shown.map((l) => `${l.from} to ${l.to}`).join(' · ');
}
