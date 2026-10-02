/**
 * The HRIS task story-point scale. Every check that judges an SP imports it from here: selfcheck,
 * revalidate and verify. Before 2026-10-02, `pass.mts` and `pending-sp.mts` each declared their own
 * `FIB = {1, 2, 3, 5, 8}`.
 *
 * Kane, 2026-10-02: *"remove 1sp for sprint tasks all SP should be 2 above but 2SP Is rare like
 * documentation depending on volume but 3sp should be common"*. So a task scores **2, 3, 5 or 8**:
 * the Fibonacci steps of dev-resources.simple.biz/story-points, without its 1.
 *   - **3 is the default.** A normal task scores 3.
 *   - **2 is rare.** It is for small work such as documentation, and only when the volume is small.
 *     A large doc is a 3 or more.
 *   - **Over 8 is an epic, not a task.** The next Fibonacci step is 13, so "over 8" and "≥ 13" are the
 *     same rule.
 *
 * ── The 24 rows already scored 1 ─────────────────────────────────────────────────────────────────
 * The rule applies to new rows only. On 2026-10-02 the plan held 24 rows at 1 SP. 16 are Done, and
 * their Actual SP is a record of finished bonus-eligible work, so they are never re-scored. The other
 * 8 are open, and re-scoring them adds bonus SP, which is Kane's call (Open item 327). They are listed
 * here by exact name, so a pass can still move them, and **the list is CLOSED: it only ever shrinks.**
 * `planSpProblems()` fails any name here that is no longer in the plan at 1 SP. A row that is
 * re-scored or renamed has to leave the list, so the exemption never outlives its row.
 */

export const TASK_SP_SCALE: ReadonlySet<number> = new Set([2, 3, 5, 8]);
export const TASK_SP_CAP = 8;

/** Frozen 2026-10-02. Remove entries; never add one. Byte-exact plan names, like everything else here. */
export const LEGACY_ONE_SP_ROWS: ReadonlySet<string> = new Set([
  // Done: Actual SP 1 is a record, never re-scored.
  'Observe mirror portaled to the document body so the sidebar cannot overlap it', // S25
  'Employee payroll-processing bar sweeps one direction, driven by CSS', // S26
  'Salary “Ready to View” card discloses that bonuses are not in yet', // S26
  'Payment Catalog Bonus Library cards get an Edit button', // S27
  'Import orientation-email-leadgen-only.json into live n8n as the second-layer filter', // S27
  'Missing-CSV dialog stops claiming an auto-sync it never performs', // S27
  'Run dedupe-payment-dispatches --apply — 81 echo groups collapsed to the oldest row, alonzos@ left as divergent', // S28
  'Favicon becomes the Employee Penny chat-bubble heart', // S28
  'A failed Payment Catalog read no longer renders an empty catalog in silence', // S28
  'Payroll Wizard Reports step gets a search bar — display only, exports and the cycle Total never narrow', // S28
  'The Offboarded list shows the inbox that still reaches a leaver once the work account is gone', // S28
  'The Employee Support blueprint is posted and waiting on nine answers before any code is written', // S28
  'The Orphanage and Dispatch wizard steps lose a gradient banner and three blocks of prose', // S29
  'The Gift Tracker drops its hero banner for four stat tiles', // S29
  'Toasts no longer render twice — the per-dashboard Toasters that duplicated the root one are gone', // S29
  'The blueprint skill takes its own recommendations and builds, stopping only for a closed NEEDS list', // S29
  // Open: Estimated SP 1 stands until Kane rules on re-scoring (Open item 327).
  'The Accounting → People Pay button shows only for the CEO — the button, not the pay route', // S29
  'The Gift Tracker Submissions tab pages at 20', // S29
  'A failed pay read on Payment Dispatch shows an error instead of claiming no Hubstaff cycle was uploaded', // S29
  'The Current Banks Who banks here list has unique row keys', // S29
  'The offboarding queue dialogs render light in light mode', // S29
  'The Missing Bank Info email carries the same card-safety warning — the live n8n workflow takes the new Build Recipients code', // S30
  'The Start Processing cue plays one minute, then fades out', // S30
  'The Pending and Excluded queues swap their violet avatar gradient for lime → green', // S30
]);

/** Why one task's score is illegal. Empty means it is legal. */
export function taskSpProblems(name: string, sp: number): string[] {
  if (sp === 1 && LEGACY_ONE_SP_ROWS.has(name)) return [];
  const bad: string[] = [];
  if (sp === 1) {
    bad.push('1 SP is retired (Kane 2026-10-02). Score it 3, or 2 only if it is small work such as docs');
  } else if (!TASK_SP_SCALE.has(sp)) {
    bad.push(`${sp} SP is not on the task scale (2, 3, 5, 8)`);
  }
  if (sp > TASK_SP_CAP) bad.push(`over the 8-SP cap (${sp}). That is an epic, not a task`);
  return bad;
}

/**
 * Sweeps the WHOLE plan, not only the pass's rows. A full `apply.mts` runs the reconciler, which
 * creates every plan row that is missing from the board, so a 1-SP row added to `hris-plan.ts`
 * reaches the board whether or not the pass lists it.
 */
export function planSpProblems(tasks: readonly { name: string; sp: number }[]): string[] {
  const bad: string[] = [];
  const spByName = new Map(tasks.map((t) => [t.name, t.sp]));
  for (const t of tasks) {
    for (const p of taskSpProblems(t.name, t.sp)) bad.push(`${p}: ${t.name.slice(0, 55)}`);
  }
  for (const name of LEGACY_ONE_SP_ROWS) {
    const sp = spByName.get(name);
    if (sp === undefined) {
      bad.push(`LEGACY_ONE_SP_ROWS names a row the plan no longer declares (renamed?). Remove it: ${name.slice(0, 55)}`);
    } else if (sp !== 1) {
      bad.push(`LEGACY_ONE_SP_ROWS still lists a row now scored ${sp}. Remove it: ${name.slice(0, 55)}`);
    }
  }
  return bad;
}
