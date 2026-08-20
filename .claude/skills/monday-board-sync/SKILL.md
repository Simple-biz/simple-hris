---
name: monday-board-sync
description: Use when putting HRIS work onto the Monday.com board — the weekly sprint update, an end-of-day "we shipped X" pass, grooming the Backlog, filling in Estimated SP, or answering the SP auditor about a high-SP row. Fires on "update Monday", "update the board", "log what we shipped", "what did I work on this sprint", "estimate the backlog", "break down this epic", "8 SP", "story points", "Abby", or any mention of the sprint board or bonus-eligible work. Shows the sprint's work for review and HARD-STOPS for approval before any board write.
user-invocable: true
argument-hint: "[optional — a commit range, sprint, or 'audit only']"
---

# Monday Board Sync

HRIS work lives on a **shared** Monday board: 2,172 items on Sprint Tasks and 208 on Roadmap &
Epics, most of it other teams'. This skill keeps our slice accurate — what shipped, what is queued,
and what it is worth — without ever becoming a second source of truth.

Three rules govern everything below.

1. **Done means shipped, and shipped means proven.** Bonuses ride on Done. A row goes Done only with
   evidence, and Kane's own confirmation counts as that evidence — but it must be **asked for and
   recorded**, never assumed.
2. **Show the work, then stop.** Every pass renders a review and waits for Kane. Approval is a
   message bound to a proposal hash; silence is not approval.
3. **Over 8 SP is an epic, not a task.** 8 SP is a legal task score (Fibonacci: the next step is 13,
   so "over 8" and "≥ 13" are the same rule).

## Architecture — why there are two writers and why that is safe

The app already syncs this board: `src/lib/monday/hris-plan.ts` is the declared plan, `sync.ts` the
reconciler, `POST/GET /api/admin/monday-sync` the route, and a button in Admin → Design &
Specifications. **The reconciler matches items by exact name**, so a row created by any other tool
with a non-identical name gets recreated forever.

So the split is by **column**, which is the boundary `sync.ts:5-10` already declares:

| Owner | Writes | Where it lives |
|---|---|---|
| the reconciler | existence, Estimated SP, Type, Sprint, Quarter, both relations, project rollup | `hris-plan.ts` → `sync.ts` |
| this skill's corrector | Status, Actual SP, Completed Date, item updates | `scripts/pass.mts` → `apply.mts` |

`apply.mts` runs the **real** `syncHrisBoard` for structure — not a reimplementation — then corrects.
`apply.mts` asserts at runtime that its column set is disjoint from the reconciler's update payload.

**`done: true` in `hris-plan.ts` is a claim of shipped-and-proven, nothing else.** It writes Done plus
an Actual SP. Pending Deploy / Waiting for Review / In Progress are execution state, written by the
corrector — which is why an unproven row can never carry an invented Actual SP, and why `sync.ts`
needs no edit.

## The honesty gate

Before any row goes Done, run the check that matches the work. Kane commits direct to `main` and
pushes manually, and Vercel's Git integration deploys `main`, so **being on `origin/main` is
necessary but not sufficient**.

| Situation | Status | Proof |
|---|---|---|
| Committed on local `main`, not pushed | **In Progress** | `git merge-base --is-ancestor <sha> origin/main` fails |
| On `origin/main`, not confirmed live | **Pending Deploy** | ancestor check passes, no click-through |
| Deployed and clicked through in prod | **Done** | Kane says so — record that as the basis |
| Code done, Supabase migration not applied | **Pending Deploy** | a `.sql` under `references/sql/` or a `scripts/apply-*.mjs` in the diff |
| Code done, n8n workflow not imported | **Pending Deploy** | a `references/n8n/*.workflow.json` in the diff, or a doc saying the import is PENDING |
| Waiting on Kane to click through it | **Waiting for Review** | — |

The last two matter more here than anywhere: plenty of HRIS features are code-complete and
**functionally dead** until the migration runs or the workflow is imported. The clearest example
shipped 2026-08-10 — HSL sub-departments was complete, and paid nobody differently, because zero
`hsl:*` rate rows existed.

### Rationalizations that mean STOP

| Excuse | Reality |
|---|---|
| "It's pushed, so it's live" | Pushed is `Pending Deploy`. Vercel deploying is not you having looked. |
| "It obviously works" | Then say who looked at it in prod. That name is the evidence. |
| "The migration is trivial" | Un-run is un-run. `Pending Deploy`. |
| "The n8n import is a five-minute job" | Until it happens the feature is dead. `Pending Deploy`. |
| "Kane said mark everything Done" | Ask **which ones**, then record his answer as the basis. Do not blanket-apply it to rows with an open external step — an assertion cannot import a workflow. |
| "Memory says it shipped" | Memory is a point-in-time note. Re-run the check. |
| "It's 95% done" | Statuses do not round. |
| "The whole cluster shipped except one surface" | Split it: Done for the live part, Backlog for the rest. |

**Never invent an Actual SP.** Estimated SP is a forecast and belongs on open rows; Actual SP is a
record and belongs only on shipped ones.

**A migration audit is only as good as its probe.** `scripts/audit-pending-migrations.mts` is the
tool that replaces a PENDING claim with an observation, and for TABLES it returned the wrong answer:
`probeTable()` uses `select('*', { head: true })` and treats a falsy error as APPLIED, but under
`head: true` PostgREST returns **no error at all** for a table that does not exist — just
`count: null`. Proven 2026-08-20 on `penny_employee_usage` and on a control table named
`definitely_not_a_table_xyz`; the positive control returns `count=181799`, which is why it went
unnoticed. `probeColumn()` is wrong differently — a missing column errors with `code: undefined` and
an empty message, so it lands INCONCLUSIVE rather than NOT APPLIED. **Probe existence WITHOUT
`head: true`** (a plain `.limit(1)` errors correctly with `42703` / `PGRST205`), and never close a
migrations row on an audit whose probe shape you have not checked — pass 4 did, and pass 5 had to
reopen it.

And the corollary that runs the other way: **do not assume a PENDING claim is stale either.** Measured
2026-08-20, two of three were TRUE (Penny AI and the time-adjustment second approver were both
genuinely un-run). Measure; do not assume in either direction.

A doc or memory line saying PENDING is **evidence, not proof** — five such claims in this repo are
contradicted by later evidence. A wrongly-blocked row is also a wrong board. When it cannot be
settled, show it as `UNVERIFIED` and ask; never silently downgrade.

## Workflow

### 1. Read before you write
`pull-state.mts` dumps our rows only. **Filter by name** — Sprint Tasks is 2,172 items of which 135
are ours (`[HRIS] ` prefix), and Roadmap & Epics is 208 of which 37 are ours (`HRIS-<nn>` + TAB).

### 2. Establish what actually shipped
`sprint-evidence.mts` gathers the mechanical part: commit range, per-commit file lists, the
ancestor-of-`origin/main` check per sha, and detection of new `.sql` / `apply-*.mjs` / n8n files.

Then **cluster by file overlap, never by commit message.** This is not optional pedantry — in one
78-commit range: `488cf44` "HSL Weekend Hours Fix" contained no code at all, `02dc5aa` "Massiv
Update" carried two unrelated features, `a7ecd4c` "Callback" carried three and named the wrong
department, `0b66a8e` "HSL - ANNOYANCE" was an offboarding workflow, and `5eb398a`'s pricing was
reversed by a later commit — so one row must describe the current rule, not both. And again in an
83-commit range on 2026-08-20: `4e8309af` "Push" carried an entire shipped feature (view-scoped
notification chimes, plus a 100-line doc), `4447e404` "ss" carried an unapplied payroll fix script,
and `6d3be952` "Push" / `0e402a0d` "s" carried nothing but settings and backup JSON — pure noise. A
message-clustered pass would have invented two rows for the noise and missed the feature.

**AUTHOR DATE IS NOT LANDING DATE, and `selfcheck()` cannot catch the difference.** `sprint-evidence`
prints `--date=short`, which is the AUTHOR date. A branch merged this week therefore reads as work
from whenever it was written: `4a15db2c` merged the HSL GML roster on 2026-08-19 with eleven commits
authored *and committed* 2026-08-03. Ending that row's sha list on the branch tip gives a Completed
Date of Aug 3 — a real commit date, so selfcheck ACCEPTS it — and files a fortnight of unmerged work
into the wrong sprint. **For work that landed via a merge, the row's last sha is the MERGE commit;**
branch shas stay in the list as evidence but never last.

### 2b. Rolling into a new sprint

"Pull the backlog into Sprint N" is a **grooming** pass, not a status pass. Three rules, all learned
the hard way on 2026-08-19:

- **Only OPEN rows move forward.** The Backlog group is mostly archaeology — on 2026-08-19 it held 22
  rows of which **21 were Done**, shipped Apr–Jul, worth 85 SP. Pulling those into the live sprint
  would credit four months of history to a two-week window and inflate its velocity. Done rows get
  re-filed to the sprint they *finished* in; open rows roll forward. `selfcheck()` refuses a Completed
  Date outside its sprint, so the lie fails closed — but only if someone attaches a date at all.
- **Scheduling a row is not a claim about how far along it is.** "Mark them Ready to Start" applies to
  rows that have not started. A row already at Pending Deploy or Waiting for Review keeps that status:
  writing Ready to Start on it moves it BACKWARDS and discards a true status to satisfy the letter of
  an instruction. Statuses only ever move forward on evidence — the honesty gate is unchanged by a
  sprint move.
- **Say what is NOT in the pull, and why.** An empty rollover is a finding too: Sprint 26 closed 23/23
  with nothing to carry, and recording that stops the next reader hunting for a backlog that never
  existed.

Check the candidate pool against recent velocity before calling the sprint planned — S24/S25/S26 ran
84 / 167 / 100 SP, so a 31 SP pull is a thin sprint that needs scope from somewhere other than the
backlog.

### 3. Estimate
Fibonacci only (1, 2, 3, 5, 8), per dev-resources.simple.biz/story-points. Calibrate against
**current-sprint neighbours** — the Sprint 26 rows run 1–5, averaging ~3.5 — never against the bulk
import epics, which were scored at whole-feature granularity. Over 8 becomes an epic on Roadmap &
Epics with child tasks.

**Do not port Gridline's children-sum-to-parent rule.** HRIS Epic SP is an independent rollup of
sub-features: HRIS-01 is 101 SP with zero task rows. Asserting the sum would fail on almost every epic.

### 4. Review — and stop
`review.mts` is read-only. It prints what would be created, patched and corrected, **every row whose
sprint changes**, each row's proposed status with its proof and its blockers, and the rollup. It
writes `proposal.json` and an **approval hash**.

The sprint moves are listed and hashed as of 2026-08-19. They were not before: "tasks to patch: 139"
cannot distinguish re-asserting 139 correct values from re-filing 59 rows into different sprints, and
`sprint` was absent from the hashed payload entirely — so an approval did not bind the re-filings it
authorised. Two passes were approved through that hole. A sprint label asserts a date range, so a
wrong one is the same class of falsehood as a wrong Completed Date.

Show that output to Kane. Wait for a message. `apply.mts --apply` refuses without `--approve <hash>`,
refuses on mismatch, and refuses if the proposal was generated for a different pass date — so what
gets written is provably what he saw.

### 5. Apply
`apply.mts --apply --approve <hash>`. Structure first, then a board re-read to resolve names → ids,
then corrections plus an evidence update on every row it touches. Keep that update habit: it is what
lets anyone reconstruct the claim later, including *why* a row is Done.

### 6. Verify by re-reading
`verify.mts`. **Never report a sync as done off the write log** — the log says what was sent, not what
the board holds. With an empty `ROWS` it also serves as the standalone board audit: name parity both
directions, the SP-cap sweep, blank Estimated SP, phantom Actual SP, and the project rollup.

### 7. Record it
Update `docs/features/monday-board-sync.md` and the `monday-hris-board-sync` memory entry.

## API budget — plan the pass around it

The account has a **daily** complexity budget, not just per-minute. Exceeding it returns
`429 DAILY_LIMIT_EXCEEDED` and **nothing** succeeds until reset, including read-only verification.
One Gridline pass left verification dead for 5.5 hours.

- **The error tells you when it resets — read it.** The `DAILY_LIMIT_EXCEEDED` body carries
  `retry_in_seconds`, mirrored in a `retry-after` header, and `monday.mts` now prints both. Measured
  2026-08-13: observed 13:09:02Z with `retry_in_seconds: 39057`, which lands on **00:00 UTC** — so the
  budget is a clean UTC-day bucket (20:00 EDT / 21:00 EST). Never guess this again; the number is free.
- **A whole day's budget can vanish before you start.** On 2026-08-13 it was already spent by 12:00 UTC
  with no pass having run that UTC day, and the cause was never identified. Assume nothing about how
  much is left: probe with one cheap call (`boardGroups`) before planning a 300-call pass.
- **Budget the verify, not just the write.** A write you cannot verify is not done. **Measured
  2026-08-20: a 28-row pass exhausted the day.** `apply.mts` finished clean, then `verify.mts` died
  immediately on `DAILY_LIMIT_EXCEEDED` (`retry_in_seconds: 39234` at 13:06:06Z → 00:00Z, the clean
  UTC bucket a third time). A big pass costs a full day once the reconciler's 142-row patch is
  counted. So on any pass creating more than a handful of rows: **spot-check with `verify-one.mts`
  (1 call each) between phase 2 and the full `verify.mts`**, or split it across two UTC days. The
  cheapest moment to verify is before the budget is gone.
- **Phase 2 is partial verification, and may be credited as exactly that.** It re-reads the board
  after phase 1 to resolve ids, so every correction target resolving by byte-exact name proves the
  rows EXIST, that the reconciler adopted them rather than minting duplicates (the `hit.count > 1`
  guard), and that the corrections addressed real ids. It proves nothing about the VALUES written —
  those are acknowledged mutations, not re-reads. Report the two halves separately.
- Ask only for the columns you read — `column_values(ids: [...])`. Pulling all ~21 columns across
  2,172 items is the most expensive thing these scripts can do.
- A full `apply.mts` is ~200 calls: the reconciler patches all 135 tasks and 37 epics every run.
  That is the honest cost of driving the app path. Do not run it repeatedly to poke at one row.
- **`apply.mts --only-new` is 6 calls** — use it when the pass only ADDS rows and corrects them
  (3 label-gate reads, 1 exact-name lookup, 1 `create_item` carrying every reconciler-owned column,
  1 evidence update). Verify with `verify-one.mts <itemId>` (1 call), never `verify.mts`, which
  pages the whole board. It is safe only because the name it creates is `taskItemName(plan.name)`
  from the same `PLAN_TASKS` entry the reconciler matches byte-exact on, so a later full sync
  ADOPTS the row instead of recreating it — the writer re-asserts that plan lookup and refuses a
  name it cannot find. **It still writes no relation**, so the row is correctly grouped, typed,
  scored and statused but NOT linked to its epic until a full reconcile runs. Reach for the full
  path when the pass changes structure (new epic, re-scored rows, a sprint move).
- `monday.mts` raises `DailyLimitExceeded` immediately instead of retrying, so a blown budget is loud.

## Traps — all verified against the live board 2026-08-11

- **Projects Portfolio Status is NOT create-only.** `sync.ts:313` rewrites `color_mm4mfemh` to Live
  every pass. The corrector must exclude board `18419115953` entirely; the collision would be silent.
- **Both relation columns are full-set overwrites, never additive.** Anything the corrector writes to
  Linked Tasks or Sprint Tasks is erased by the next reconcile. It must never write a relation.
- **`report.tasksCreated` holds the UNPREFIXED plan name** (`sync.ts:250`), not a board name or id.
  Always re-read the board to resolve ids.
- **Renaming a plan title creates a NEW row** and orphans the old one with its execution state intact
  — item names are only ever set at create. Name parity is an audit invariant in both directions.
- **Never put angle brackets in an item name.** Monday strips HTML tags on create, so the stored name
  differs from the sent name and the row is recreated forever.
- **Never normalise a name.** `sync.ts:167-168` matches byte-exact with no trim, case fold or unicode
  normalisation. Plan names legitimately contain em-dashes, curly quotes, `₱`, `→`, `⊕`, `⇄`, `≈`, `×`
  and an en-dash inside "Sun–Sat".
- **Duplicate names shadow each other** — the reconciler's Map keeps the last one. `apply.mts` refuses
  an ambiguous target rather than guessing.
- **`create_labels_if_missing: true` returns 403** on this board even when nothing is missing.
- **`items(ids:)` silently caps at 25** — ask for 40, get 25 back with no error.
- **Board relations return an empty `text`** — use `linked_item_ids`.
- **Re-query `groups{id title}` every pass.** A cached list goes stale; Sprint 26 was absent from the
  earlier notes entirely.
- **A new sprint can only be created by hand on the board** — the API cannot add a Sprint label, and
  the board is structure-locked. Sprint 27 (`group_mm66ce8q`, label index **103**, "Sprint 27 ·
  Aug 18-Aug 29") was added by hand and mirrored on 2026-08-19; Sprint 28 will need the same. Mirror
  it into `TASK_GROUPS`, `TASK_SPRINT_INDEX`, `TASK_SPRINT_LABELS` **and `TASK_SPRINT_WINDOWS`**, and
  until it exists **hard-stop** rather than silently dumping new work into Backlog. Mirroring the
  window is not optional bookkeeping: adding S27's window is what re-bounded S26's attribution to
  Aug 4-17 instead of leaving Aug 16-17 belonging to nothing.
- **Label indices are the board's own and are NOT sequential.** S22 is 3, S23 is 4, S19-S21 run 10-12,
  S27 is 103. Read `settings_str`; never guess one, and never assume the next sprint is the next index.
- **A sprint label asserts a date range, and `selfcheck()` enforces it.** Windows live in
  `TASK_SPRINT_WINDOWS`, mirrored from the board group titles (`Sprint 26 · Aug 4-15`, …). A row whose
  Completed Date falls outside its sprint is refused. Sprints run **Tue → Sat**, so Sun+Mon between two
  sprints belong to no window; `taskSprintAttribution()` gives those gap days to the sprint that
  **closed** (Kane 2026-08-13: Sprint 26 is Aug 4-15 only), never to the one about to open.
- **A human triage group needs `groupPinned` or the reconciler erases it.** `sync.ts` reconciles a
  row's group to its Sprint label, which is wrong for a lane that has no Sprint label at all — "For
  Re-scoping" (`group_mm65rmf9`) is one. A pinned row keeps its group, keeps a reconciler-owned label,
  and is reported as `tasksGroupPinned` so the suppressed move is never invisible. No row sets it
  today (all three were released into Sprint 27 the same day) — keep the capability anyway, the group
  still exists.
- **`proposal.json` and its approval hash are ONE shared file, and sessions share this checkout.**
  A second session running `review.mts` overwrites the proposal the first one showed Kane, so an
  approved hash can be silently replaced by a different pass's. This happened on 2026-08-19: hash
  `3578fe5c294f` was applied at 13:19, and a concurrent session had minted `e9280075d85c` over it by
  13:30. Before proposing, `ls` the mtimes of `proposal.json` / `pass.mts` / `hris-plan.ts`; if they
  moved in the last few minutes, another session is mid-pass — **fold into it or wait**, never race it.
  **Recent mtimes alone are not the test — they false-positived on 2026-08-20.** All three had moved
  6 minutes earlier, but that was the PREVIOUS pass's own residue: `git status` was clean and
  `f51b4cd5` already contained it. Check the tree, not just the clock — mtime moved **and** the tree
  dirty (or no commit containing those paths) means a live session; mtime moved with a clean tree
  means a pass that already landed.
  Two full applies also cost ~400 calls against a daily budget that one pass nearly fills.
- **The board label is not what re-files a row — the GROUP is.** `sync.ts` writes the Sprint label on
  update but wrote the group only at create until 2026-08-13, so a plan relabel alone left rows filed
  under their old sprint heading. `move_item_to_group` now runs from the update path when the two
  disagree. Epics are still NOT moved between quarter groups — the same gap, unexercised so far.
- **Never `git push`.** Kane handles every push.

## Known drift

- **HRIS-22** "Hubstaff Live API Integration" is `Cancelled` on the board but `Shipped` in
  `hris-plan.ts`. The reconciler never overwrites board status, so this drifts until one side is
  corrected. It currently costs 12 SP of SP Completed.
- **Nine epics carry 220 SP with zero task rows** (HRIS-01, 16, 17, 22, 23, 25, 29, 31, 32).
- **74 pre-existing Done rows have no Completed Date** — HRIS never wrote the column before this
  skill. Backfilling is a separate pass. The old rule here — "refuse to write a date inside the live
  sprint" — is **superseded**: it would have blocked the 20 rows that genuinely finished inside the
  live sprint on 2026-08-13. What replaced it is stronger, not looser: `selfcheck()` runs `git log` and
  refuses any Completed Date that is not the commit date of the row's last sha, so a stale backfill
  cannot read as fresh *and* a flattering guess cannot pass either. `dateBasis: 'external'` is the one
  exemption, for work that is an action in another system, and it must name a confirmation.
- **`MONDAY` is still unset in Vercel**, so the in-app button 502s in production. This skill is
  unaffected — it reads `.env` locally.
