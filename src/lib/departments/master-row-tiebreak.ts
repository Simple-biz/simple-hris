import { isHslFamilyLabel } from '@/lib/departments/hsl-subdept';

/**
 * Which of two duplicate `global_master_list` rows for the SAME work email wins.
 *
 * Measured 2026-09-08: 267 active people carry more than one master row with
 * different departments, and 138 of those straddle an `hsl:*` department and a
 * non-HSL one (`reat@simple.biz` = hsl:callback_team + Lead Gen,
 * `hansc@simple.biz` = hsl:filing_specialist + Client - VA). The index that
 * resolves a person to a department took the FIRST row it saw, with no ORDER BY
 * behind the query — so the winner could change between loads.
 *
 * That is not cosmetic, because PAB grades the two families by different rules:
 * non-HSL must clear EVERY Mon–Fri at ≥7h, HSL needs 5 of 7 Mon–Sun days with
 * weekends droppable. A Lead Gen row winning grades an HSL person harshly and
 * costs them the bonus; an HSL row winning grades a Lead Gen person leniently
 * and pays a bonus they did not earn. Same coin-flip that made HSL KPI pay
 * people "one week and drop them the next" (`hsl-kpi-payout.ts`).
 *
 * **HSL wins (Kane, 2026-09-08).** It is deterministic, and it matches the
 * documented invariant that an HSL person carries ONE department plus a required
 * sub-department (`hsl-subdept-restructure`): the `hsl:*` row is the deliberately
 * set one, while the surviving non-HSL row is the sheet sync clobbering HRIS
 * (`hris-is-dept-source-of-truth`, still open). Nobody loses PAB to a tie-break.
 *
 * This resolves the AMBIGUITY; it does not repair the DATA. The duplicate rows
 * are still invalid and still need deduping — `isAmbiguousDeptPair` is what the
 * PAB step flags so the operator can see whose department was guessed.
 */

/** The row that should win, given the one already indexed and a new candidate. */
export function pickMasterRowForWorkEmail<T extends { department?: string | null }>(
  existing: T | undefined,
  candidate: T,
): T {
  // No incumbent — the candidate is the only row so far.
  if (!existing) return candidate;
  // Incumbent already HSL: nothing outranks it, and a second HSL row is a
  // sub-department duplicate whose family verdict is identical either way.
  if (isHslFamilyLabel(existing.department)) return existing;
  // First HSL row to arrive displaces a non-HSL incumbent.
  if (isHslFamilyLabel(candidate.department)) return candidate;
  // Neither is HSL — keep first-occurrence-wins, the long-standing behaviour.
  return existing;
}

/**
 * True when two rows for one person disagree about the PAB rule that grades
 * them — i.e. one is HSL and the other is not. Two non-HSL departments are a
 * data problem too, but they do not change which attendance rule applies, so
 * they are not flagged as a pay-affecting ambiguity here.
 */
export function isAmbiguousDeptPair(
  a: string | null | undefined,
  b: string | null | undefined,
): boolean {
  return isHslFamilyLabel(a) !== isHslFamilyLabel(b);
}
