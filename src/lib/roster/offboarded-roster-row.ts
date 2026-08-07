/**
 * The final-pay roster overlay row — recently-offboarded people who may still
 * be owed a paycheck for the pay week in view.
 *
 * A plain module (NO `import 'server-only'`) on purpose: this is the shared
 * contract between `GET /api/payroll-wizard/offboarded-roster` and the Payroll
 * Wizard, which is a `'use client'` component and therefore cannot import
 * `src/lib/roster/recently-offboarded.ts` — where this data is actually built —
 * even for its types.
 *
 * Why the overlay exists: the wizard resolves everyone's department from
 * `active_employees`, and that view carries NO offboarded rows. Tier 1 of the
 * department resolver is the only tier allowed to overwrite, so for a leaver it
 * is silent, and whatever department the wizard recorded before they left is
 * frozen forever — even after HR corrects the master list. Since department
 * selects the pay week (HSL Mon–Sun vs Sun–Sat), the HSL weekend premium, the
 * OT convention and KPI eligibility, a leaver with hours gets computed on the
 * wrong basis. This overlay gives tier 1 something to say about them.
 *
 * It can only ever ANNOTATE an email that already has a Hubstaff calc row — it
 * never adds a row — so it cannot resurrect anyone into a week they didn't work.
 */
export interface OffboardedRosterRow {
  name: string;
  /** Master-list Department as of the CURRENT sheet upload (see the
   *  current-upload promotion in recently-offboarded.ts — a retired duplicate
   *  row must never describe someone the sheet still carries). */
  department: string | null;
  work_email: string | null;
  personal_email: string | null;
  alternate_work_email: string | null;
  alternate_work_email_2: string | null;
  /** The email their Hubstaff hours are keyed on — THE payable identity, and
   *  not always the master work email (master `cathyp@` vs Hubstaff `cathypa@`).
   *  Indexed alongside the work email so a calc row keyed on it still matches. */
  hubstaff_email: string | null;
  /** Raw master-list "Start Date" (US-format, as stored). Lets tenure-gated pay
   *  still resolve on a final check. */
  start_date: string | null;
  off_boarded_at: string | null;
  last_hours_week_start: string | null;
}
