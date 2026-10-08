# Session: Task 10, Compliance filled from Kentshin's portal (Open item 394)

**Paste this only after Kentshin's endpoint exists (W0.7).** Paste his API doc for it below this file, or the session
stops. Use the **`blueprint`** skill first.

**Meeting notes (read first):** `docs/meetings/2026-10-07-carla-alivia-scoreboard-tasks-roles-and-interns.md` § "Accounting Scoreboard: Compliance from Kentshin's compliance report (item 394)". Read that section word for word, plus the note's **Decisions made on the call**, **Open questions** and **Reference notes** (the transcript's name garbles, e.g. Kenchin = Kentshin, Olivia = Alivia). Carla will judge the result against her quotes there, and the plan only restates them.

**Your scope:** Task 10 of `docs/implementation-plans/implementation-plan-scoreboard-round4-and-oct7-asks.md`. Read that
task in full, plus the plan's **Global Constraints**, memory `compliance-portal-pab-disqualifications` (the same portal,
item 312) and memory `orphanage-oms-pull` (the manual-pull precedent).

**What Carla asked (2026-10-07):** the scoreboard's Compliance section shows 1st, 2nd and 3+ violations and offboardings
without Kristine looking each person up. *"if I could just get both scoreboards to talk to each other, then I don't have to
have Christine do anything."*

**The shape (from the plan):** env `COMPLIANCE_PORTAL_URL` + `COMPLIANCE_PORTAL_SECRET` (shared with item 312), a
server-only Admin route that calls the portal, a **manual "Load from compliance portal" button, never polling**, a
portal-vs-typed comparison per day, and an **Apply** that writes only through the existing entries path (lock-aware,
stamped). The four lines are marked by a row flag, never by their label.

**NEEDS before the build if still open:** which of the four counts the ≥ 30 goal judges (Carla, W0.3 i). If the endpoint
Kentshin built differs from the plan's spec, his doc wins. Say what changed in your brief.

## Check before you start (stop and tell Kane if one fails)
- Kentshin's API doc is pasted below this file, and Kane has put the secret in `.env.local` (`grep -c "^COMPLIANCE_PORTAL_SECRET=." .env.local` prints 1; never print it).
- Lane A runs one session at a time. `git status --short -- src/lib/accounting-scoreboard src/components/accounting-scoreboard app/api/accounting-scoreboard app/accounting-scoreboard references/sql/create docs/features/accounting-scoreboard.md` must show nothing.

## Rules for this session
- **Step 0 is mandatory.** Read the Compliance section, the entries write path and the OMS pull route, and cite
  `file:line`. Where the code disagrees with the plan, the code wins: correct Task 10 in the plan in the same commit, and
  say so.
- The secret never reaches the browser and is never echoed in an error.
- Kane pushes. You never push. Stage by explicit path, re-run `git status` right before committing, commit to `main`.

## Done means
1. The task's tests pass, then `npm test` and `npm run lint` (give the counts; name any pre-existing failure).
2. `docs/features/accounting-scoreboard.md` (§ Compliance), the INDEX row, `.env.example`, and memories `accounting-scoreboard`
   and `compliance-portal-pab-disqualifications` are updated in the same commit.
3. Open item **394**'s row gets a dated note: what shipped and the commit.
4. Reply to Kane in a few lines: the commit hash, then his next steps (the Vercel env vars, push).
