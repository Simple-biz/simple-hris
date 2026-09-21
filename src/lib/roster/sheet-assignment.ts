/**
 * Which roster row a master-sheet CSV line belongs to — the one decision that
 * stops a department transfer forking a person into two active rows.
 *
 * ## The defect this closes
 *
 * `replaceGlobalMasterListFromCsvText` keys a row on
 * `(personal_email, department)`. That key is deliberate: same personal email +
 * different departments is how a genuine dual-role person is represented. But it
 * also means a TRANSFER misses the key — the sheet now says Client VA, the key
 * `(them, Client VA)` matches nothing, so the sync INSERTS a second row and the
 * old Lead Gen row stays `off_boarded_at IS NULL` forever.
 *
 * Measured on production 2026-09-21: **301 people carried such a corpse**, and
 * **304 of the 314 duplicate groups differed only by Department**. The
 * `active_employees` view hid them (stale `last_seen_upload_id`); the external
 * API, which has no upload filter, served every one as a live person. That is
 * the entire 1,723-vs-1,215 discrepancy Kane opened as *"the OMS pulled 1667 not
 * 1143 … lets fix this data once and for all"*.
 *
 * ## The rule (Kane, 2026-09-21)
 *
 * Keep the composite key — it is what dual-role needs — and prevent the fork:
 *
 * | The sheet lists them | They already have | Result |
 * | --- | --- | --- |
 * | under a department they already hold | that row | `update` — unchanged |
 * | **ONCE**, under a different department | **exactly one** active row | **`adopt`** — reuse that row, and *keep its own Department* |
 * | twice or more (a multi-role assertion) | anything | `insert` as before |
 * | anything | nothing active | `insert` |
 * | once | two or more active rows | `insert` — ambiguous, never guess |
 *
 * ## Why `adopt` is not `update`
 *
 * They are separate actions so the caller physically cannot write the sheet's
 * department onto a row the HRIS owns. Kane ruled the sheet **input-only, never
 * overwrites Department**, and `memory/hris-is-dept-source-of-truth.md` records
 * that in all 7 measured mismatches the sheet was the stale side — every one of
 * them an applied HRIS transfer the sheet never received. An adopted row keeps
 * its Department and only has its `last_seen_upload_id` bumped, so a person the
 * HRIS transferred stays transferred and stays on the roster.
 *
 * Retiring the rows the sheet omits was considered and rejected: it would stamp
 * exactly those applied-transfer rows as gone. Existing corpses are cleaned up
 * once, by the `duplicate_cleanup` sweep, not by this function.
 *
 * Pure. The caller supplies **active rows only** — adopting a stamped row would
 * silently un-offboard someone (`memory/master-sync-never-un-offboards.md`).
 */

export type ExistingAssignment = {
  id: string;
  /** `global_master_list."Department"` as stored. */
  department: string;
};

export type SheetAssignmentInput = {
  /** The department on the CSV line being placed. */
  department: string;
  /** Every department this CSV lists for this person, this run. */
  csvDepartments: readonly string[];
  /** The person's ACTIVE `global_master_list` rows. Never includes leavers. */
  existing: readonly ExistingAssignment[];
};

export type SheetAssignment =
  /** Same department: write the CSV values onto this row, as always. */
  | { action: 'update'; id: string }
  /** Different department, one row, one sheet line: reuse the row and KEEP its Department. */
  | { action: 'adopt'; id: string }
  /** No safe row to reuse. */
  | { action: 'insert' };

function key(v: string): string {
  return v.trim().toLowerCase();
}

export function decideSheetAssignment(input: SheetAssignmentInput): SheetAssignment {
  const want = key(input.department);

  // 1. The person already holds this exact department — the ordinary path.
  const exact = input.existing.find((e) => key(e.department) === want);
  if (exact) return { action: 'update', id: exact.id };

  // 2. The sheet listing a person more than once is it ASSERTING a multi-role
  //    set, so a second row is what it is asking for. Only a single listing can
  //    be a transfer.
  const listedOnce = input.csvDepartments.filter((d) => key(d) === want).length === 1
    && input.csvDepartments.length === 1;
  if (!listedOnce) return { action: 'insert' };

  // 3. One sheet line, one active row ⇒ this is that person's row. Reuse it.
  //    Two or more active rows is ambiguous and we never guess: falling through
  //    to INSERT keeps today's behaviour and leaves it for the sweep.
  if (input.existing.length === 1) return { action: 'adopt', id: input.existing[0].id };

  return { action: 'insert' };
}
