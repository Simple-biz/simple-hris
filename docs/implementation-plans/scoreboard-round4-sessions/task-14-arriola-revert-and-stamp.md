# Session: Task 14, the Arriola ghost row: revert the 10-06 edit, then stamp it (Open item 384)

Lane B: this may run while a scoreboard session is running. Use the **`hardening`** skill first.

**Meeting notes (read first):** `docs/meetings/2026-10-07-carla-alivia-scoreboard-tasks-roles-and-interns.md` § "Offboarding queue: returned to manager without a notification (item 397; follows 384)". Then read Open item **384** in `docs/audits/audit-2026-09-29-session-log.md` (and 244 / 364 before it) and memory `arriola-lead-gen-master-row-name-as-email` in full.

**Kane's ruling (2026-10-07, option (a)):** revert the three fields written onto the ghost GML row `327a7857` on 2026-10-06
at 16:27Z (Work Email, Personal Email, Alternate Work Email), back to their values in the **pre-edit** backup
`docs/audits/backups/2026-10-06T14-04-17-601Z-arriola-ghost-stamp.json`. Then run `scripts/stamp-arriola-ghost-row.mts`,
which stamps the ghost off-boarded dated **07-16** (never today: `listOffboardedSince` would re-deal it). **The HR queue
does NOT offboard it**, because that would re-fire `offboarding_delete` for a teardown that is already done.

**Out of scope, still Kane's:** the 09-20 ₱750 on the ghost key (delete it, or re-attribute it). Do not touch it, and say in
your reply that it is still owed.

## Steps
1. **Step 0:** read `scripts/stamp-arriola-ghost-row.mts` (its guards, its backup, its `--revert`), the three backups in
   `docs/audits/backups/*arriola-ghost-stamp.json`, and how People writes those three columns. Cite `file:line`. Confirm
   that the 14:04Z backup predates the 16:27Z edit and holds the original three values. If it doesn't, stop.
2. Write `scripts/revert-arriola-ghost-fields.mts`, **dry by default**. It reads the live row and refuses unless the three
   fields still hold exactly what the 16:27Z edit wrote (so it never clobbers a later change). It writes a fresh backup of
   the live row, then shows the before → after for the three fields. `--apply` writes only those three columns on that one
   id (`.eq('id', …)`, never `.in()`: a name key inside `.in()` silently matches 0 rows), and `--revert <backup>` puts them
   back. Set `TSX_TSCONFIG_PATH=tsconfig.readiness-verify.json` if it imports anything `server-only`.
3. Dry-run it. Then dry-run (plan-run) the stamp script: with the fields reverted in a dry state it cannot pass, so report
   which guards it will check after the revert.
4. **Stop and show Kane both dry runs.** On his go: revert `--apply`, then stamp plan run, then stamp `--apply`. Verify
   read-only afterwards: the ghost has `off_boarded_at` = 07-16 and is off `active_employees`, and the real Mark's row
   (`5dba371f`) is unchanged.
5. **Tell HR to Dismiss the returned queue row `cf57ab93`**, never to process it.

## Rules for this session
- `.env.local` is **production**. Every write is backed up first and gated on `--apply` with Kane's go **in this session**.
- **Never loosen a guard in either script to make it pass.** If a guard refuses, stop and report it.
- Kane pushes. You never push. Stage by explicit path, re-run `git status` right before committing, commit to `main`.

## Done means
1. `npm run lint` passes, and the script is committed (backups stay gitignored).
2. Memory `arriola-lead-gen-master-row-name-as-email` gets a dated paragraph: what was reverted, the stamp, the verification.
3. Open item **384**'s row gets a dated note: done or not, the commit, and that the ₱750 is still owed.
4. Reply to Kane in a few lines: done or not, the exact commands if he still has to run them, "HR: Dismiss `cf57ab93`", and
   that the ₱750 is his.
