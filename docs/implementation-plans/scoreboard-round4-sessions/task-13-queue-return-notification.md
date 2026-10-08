# Session: Task 13, notify when an offboarding queue row is returned (Open item 397)

Lane B: this may run while a scoreboard session is running. Use the **`hardening`** skill first.

**Meeting notes (read first):** `docs/meetings/2026-10-07-carla-alivia-scoreboard-tasks-roles-and-interns.md` § "Offboarding queue: returned to manager without a notification (item 397; follows 384)". Read that section word for word, plus the note's **Decisions made on the call**, **Open questions** and **Reference notes** (the transcript's name garbles, e.g. Kenchin = Kentshin, Olivia = Alivia). Carla will judge the result against her quotes there, and the plan only restates them.

**Your scope:** Task 13 of `docs/implementation-plans/implementation-plan-scoreboard-round4-and-oct7-asks.md`. Read that task
in full, plus the plan's **Global Constraints** and **Review Focus 5**. Build only Task 13.

**What Carla asked (2026-10-07):** *"he returned it to manager. Jackie didn't get a notification on that and that's she wants
one set up."* **Who gets told (the plan's design):** the person who raised the request **and** the managers of the departing
person's department, de-duplicated, never the person who did the return. In the Arriola case Carla raised the row and
Jackie (the department's manager) is the one who was left out, so notifying the requester alone would not have fixed it.

**Doc gap to close in the same commit:** `docs/features/offboarding-automation.md` never mentions a return-to-manager action.
Its pipeline goes queue → HR offboard. Add a § "Returned to the manager".

**Out of scope:** Open item 384 (the Arriola ghost row itself). That ruling is Kane's. Do not touch the row, the queue
entry, or `scripts/stamp-arriola-ghost-row.mts`.

## Rules for this session
- **Step 0 is mandatory.** The plan was written without reading the code. Find the return action (route, status value,
  whether a note is stored), the `offboarding.requested` notification insert (its columns) and how a department's managers
  are listed, and cite `file:line`. Where the code disagrees with the plan, the code wins: correct Task 13 in the plan in the
  same commit, and say so.
- The notification is best-effort: a failed insert is logged and reported in the response, and never undoes the return.
- Kane pushes. You never push. Stage by explicit path, re-run `git status` right before committing, commit to `main`.

## Done means
1. The task's tests pass, then `npm test` and `npm run lint` (give the counts; name any pre-existing failure).
2. `docs/features/offboarding-automation.md` (new §), `docs/features/notification-alerts.md` (the new type), the Offboarding
   INDEX row, and memories `arriola-lead-gen-master-row-name-as-email` and `offboard-delete-only-routing` (or whichever
   Step 0 shows governs the queue) are updated in the same commit.
3. Open item **397**'s row in `docs/audits/audit-2026-09-29-session-log.md` gets a dated note: what shipped and the commit.
4. Reply to Kane in a few lines: the commit hash, and "push".
