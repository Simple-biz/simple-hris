# Session: Task 12, interns: measure the capped hours, label the lock-in popup (Open item 396)

Lane B: this may run while a scoreboard session is running. Use the **`hardening`** skill first.

**Meeting notes (read first):** `docs/meetings/2026-10-07-carla-alivia-scoreboard-tasks-roles-and-interns.md` § "Orphanage interns: hours over 5, monthly payout, what was paid (item 396, OPEN MONEY)". Read that section word for word, plus the note's **Decisions made on the call**, **Open questions** and **Reference notes** (the transcript's name garbles, e.g. Kenchin = Kentshin, Olivia = Alivia). Carla will judge the result against her quotes there, and the plan only restates them.

**Your scope:** Task 12 **Steps 1–5 only** of
`docs/implementation-plans/implementation-plan-scoreboard-round4-and-oct7-asks.md`. Read that task in full, plus the plan's
**Global Constraints**, `docs/features/orphanage-interns.md` and memory `orphanage-interns`.

**This is OPEN MONEY.** You change **no cap, no rate, no amount, no accepted week.** The work after Step 5 (hours over 5,
the monthly payout, any catch-up or recovery) waits on Ralph's answer and Kane's ruling (W0.8), and is a separate session.

**What was said (2026-10-07):** Hubstaff shows interns at 5.x and 6.x hours while the HRIS *"literally maxes them out at 5
hours"*. The call said both *"we owe people a little bit"* and *"we did overpay them"*, and nothing was computed. Alivia read
the Review & lock-in popup's *"to the interns"* figure (4,164) as all weeks, but it is one week's total for all interns.

## Steps (from the plan)
1. **Step 1:** read and cite `src/lib/interns/intern-week-pay.ts` (the daily and weekly cap **values** and where they come
   from), `intern-pab.ts` and `InternLockConfirmDialog.tsx`.
2. **Step 2:** `scripts/measure-intern-capped-hours.mts`, read-only. Per locked or accepted week, print interns, raw hours,
   paid hours, hours removed by the cap, and gross paid, as **totals only**. Per-intern detail goes to a gitignored file under
   `docs/audits/backups/`. Try running it once. **If the permission check refuses, do not retry another way:** ask Kane to
   run it.
3. **Steps 3–4:** a pure `internLockSummary(rows)` with tests. The dialog then reads *"To the interns, this week: ₱… across N
   interns"*, with per-intern lines (hours paid, hours capped, amount). Verify it rendered at 1360 and 390 px.
4. **Step 5:** commit.

## Rules for this session
- **Step 0 is mandatory.** Where the code disagrees with the plan, the code wins: correct Task 12 in the plan in the same
  commit, and say so.
- `.env.local` is **production**. Read-only. Never print intern names into the repo or the reply.
- Kane pushes. You never push. Stage by explicit path, re-run `git status` right before committing, commit to `main`.

## Done means
1. The task's tests pass, then `npm test` and `npm run lint` (give the counts; name any pre-existing failure).
2. `docs/features/orphanage-interns.md` (the cap values as measured, and the popup) and memory `orphanage-interns` are
   updated in the same commit.
3. Open item **396**'s row in `docs/audits/audit-2026-09-29-session-log.md` gets a dated note: the cap values, the
   measurement's totals (or "Kane to run"), and the commit. It stays OPEN MONEY.
4. Reply to Kane in a few lines: the cap values, the totals, the commit, and that the money part waits on Ralph.
