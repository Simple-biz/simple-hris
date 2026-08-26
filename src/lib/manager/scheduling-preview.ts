/**
 * PREVIEW DATA — invented, not read from anything.
 *
 * The Scheduling tab ships UI-first, deliberately: no API route, no table, no
 * migration. Nothing in this file has ever been in the database, and no employee
 * named here exists. The panel renders a permanent banner saying so, and every
 * figure it shows is derived from this file alone.
 *
 * Two things ARE real and were kept real on purpose, because they are what the
 * screen has to fit:
 *
 *  - **The department keys.** `hsl:intake_specialist` and friends are the actual
 *    master-list `Department` cells (`hsl-subdept.ts`), so the labels, the sort
 *    order and the column widths are sized against the strings that will really
 *    arrive.
 *  - **The team sizes.** The per-team totals below are the live 2026-08-26 active
 *    counts — Intake 187, Filing 81, SSD Medical Records 56, Case Managers 55,
 *    Attestation 51. They are here so the "not yet scheduled" backlog looks like
 *    the real backlog rather than a tidy demo number: a seeding job of ~430 people
 *    is the actual problem this surface has to solve, and a preview that hides
 *    that would be designing against a fantasy.
 *
 * When the backend lands, delete this file and feed `SchedulingPanel` from the
 * route. Nothing else in the panel should need to change — it is already written
 * against `SchedulePeriod`, which mirrors the proposed table shape.
 */

import { parseShiftWindow } from '@/lib/manager/shift-window';
import type { SchedulePeriod, TeamDefault, Weekday } from '@/lib/manager/scheduling';

const MON_FRI: Weekday[] = [0, 6];
const SUN_THU: Weekday[] = [5, 6];
const TUE_WED_OFF: Weekday[] = [2, 3];

const EST = 'America/New_York';

/** Live active headcount per HSL sub-team, measured 2026-08-26. The denominator
 *  every "scheduled / not yet scheduled" figure on the panel divides by. */
export const PREVIEW_TEAM_SIZES: Record<string, number> = {
  'hsl:intake_specialist': 187,
  'hsl:filing_specialist': 81,
  'hsl:ssd_medical_records': 56,
  'hsl:case_managers': 55,
  'hsl:attestation': 51,
};

export const PREVIEW_DEPARTMENTS = Object.keys(PREVIEW_TEAM_SIZES);

/**
 * Per-team starting points. This is the capture strategy in one object: five
 * defaults reach ~70% of the HSL roster in one pass, and per-person periods exist
 * only where someone differs from their team.
 */
export const PREVIEW_TEAM_DEFAULTS: TeamDefault[] = [
  {
    department: 'hsl:intake_specialist',
    restDays: MON_FRI,
    shiftWindow: parseShiftWindow('8:00 AM - 4:00 PM'),
    timezone: EST,
  },
  {
    department: 'hsl:filing_specialist',
    restDays: MON_FRI,
    shiftWindow: parseShiftWindow('9:00 AM - 5:00 PM'),
    timezone: EST,
  },
  {
    department: 'hsl:ssd_medical_records',
    restDays: SUN_THU,
    shiftWindow: parseShiftWindow('10:00 AM - 6:00 PM'),
    timezone: EST,
  },
  {
    department: 'hsl:case_managers',
    restDays: MON_FRI,
    shiftWindow: parseShiftWindow('8:00 AM - 4:00 PM'),
    timezone: EST,
  },
  {
    // Deliberately window-less: a team whose days are known and whose hours are
    // not is a real and common state, and the panel must render it as "not set"
    // rather than defaulting it to midnight.
    department: 'hsl:attestation',
    restDays: MON_FRI,
    shiftWindow: null,
    timezone: EST,
  },
];

function p(
  id: string,
  name: string,
  department: string,
  restDays: Weekday[],
  window: string | null,
  effectiveFrom: string,
  effectiveTo: string | null = null,
): SchedulePeriod {
  return {
    id,
    workEmail: `${name.toLowerCase().replace(/[^a-z]/g, '').slice(0, 7)}@simple.biz`,
    name,
    department,
    restDays,
    shiftWindow: window ? parseShiftWindow(window) : null,
    timezone: EST,
    effectiveFrom,
    effectiveTo,
  };
}

/**
 * Invented people. The spread is chosen to exercise every state the panel has to
 * render, not to look tidy:
 *   - standard Mon–Fri on the team default
 *   - weekend cover (Tue/Wed off) — the people who make Saturday non-zero
 *   - an overnight window that crosses midnight
 *   - days known, hours not set
 *   - a superseded period plus its replacement, so effective dating is visible
 */
export const PREVIEW_PERIODS: SchedulePeriod[] = [
  p('s01', 'Marisol Danao', 'hsl:intake_specialist', MON_FRI, '8:00 AM - 4:00 PM', '2026-06-01'),
  p('s02', 'Teodoro Villareal', 'hsl:intake_specialist', MON_FRI, '8:00 AM - 4:00 PM', '2026-06-01'),
  p('s03', 'Aurelia Bongco', 'hsl:intake_specialist', TUE_WED_OFF, '8:00 AM - 4:00 PM', '2026-06-01'),
  p('s04', 'Ignacio Rubio', 'hsl:intake_specialist', TUE_WED_OFF, '12:00 PM - 8:00 PM', '2026-07-01'),
  p('s05', 'Perlita Manansala', 'hsl:intake_specialist', MON_FRI, null, '2026-06-15'),

  // One person, two periods — the reason the unit is a PERIOD. Her June–July
  // schedule is closed; her August one supersedes it without rewriting July.
  p('s06', 'Consuelo Arriola', 'hsl:filing_specialist', MON_FRI, '9:00 AM - 5:00 PM', '2026-06-01', '2026-07-31'),
  p('s07', 'Consuelo Arriola', 'hsl:filing_specialist', TUE_WED_OFF, '11:00 AM - 7:00 PM', '2026-08-01'),

  p('s08', 'Rodolfo Escalona', 'hsl:filing_specialist', MON_FRI, '9:00 AM - 5:00 PM', '2026-06-01'),
  p('s09', 'Benigna Talavera', 'hsl:filing_specialist', MON_FRI, '9:00 AM - 5:00 PM', '2026-06-01'),

  p('s10', 'Fidelio Cuenca', 'hsl:ssd_medical_records', SUN_THU, '10:00 AM - 6:00 PM', '2026-05-01'),
  p('s11', 'Amparo Lachica', 'hsl:ssd_medical_records', SUN_THU, '10:00 AM - 6:00 PM', '2026-05-01'),
  // Overnight — the window the formatter has to mark (+1d) rather than render backwards.
  p('s12', 'Gregorio Pineda', 'hsl:ssd_medical_records', TUE_WED_OFF, '10:00 PM - 6:00 AM', '2026-07-15'),

  p('s13', 'Leonora Baltazar', 'hsl:case_managers', MON_FRI, '8:00 AM - 4:00 PM', '2026-04-01'),
  p('s14', 'Emiliano Sarmiento', 'hsl:case_managers', MON_FRI, '8:00 AM - 4:00 PM', '2026-04-01'),
  p('s15', 'Rosalinda Fajardo', 'hsl:case_managers', TUE_WED_OFF, '8:00 AM - 4:00 PM', '2026-06-01'),

  // Attestation: days on file, hours deliberately absent.
  p('s16', 'Bienvenido Ocampo', 'hsl:attestation', MON_FRI, null, '2026-06-01'),
  p('s17', 'Herminia Zamora', 'hsl:attestation', MON_FRI, null, '2026-06-01'),
  p('s18', 'Norberto Aquino', 'hsl:attestation', MON_FRI, null, '2026-06-01'),
];

/** Total in-scope roster the preview divides by — the five live team sizes. */
export const PREVIEW_ROSTER_SIZE = Object.values(PREVIEW_TEAM_SIZES).reduce((a, b) => a + b, 0);
