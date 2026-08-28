# Monday board sync — how HRIS work reaches the Monday.com sprint board

HRIS work is tracked on a **shared** Monday board in the *Ai & Automation Operations* workspace
(`16165131`): Sprint Tasks holds ~2,172 items of which 135 are ours, Roadmap & Epics 208 of which 37
are ours. Two things write to it, and they own **different columns**: the in-app reconciler owns
whether a row exists and its structure; the `monday-board-sync` skill owns execution state. Anyone
adding board writes must keep that split or the board grows permanent duplicate rows.

Shipped 2026-08-11 (skill + 2026-08-11 pass: 12 rows created, 7 Done, 5 Backlog, verified by re-read).

## Key files

| Piece | File |
| --- | --- |
| Declared plan — source of truth for board structure | `src/lib/monday/hris-plan.ts` |
| Reconciler (create missing, patch structure, rollup) | `src/lib/monday/sync.ts` |
| Route — `GET` dry-run preview, `POST` reconcile | `app/api/admin/monday-sync/route.ts` |
| Button — Admin → Design & Specifications | `src/components/admin/AdminDesignSpecs.tsx` |
| Skill (honesty gate, review-then-approve protocol) | `.claude/skills/monday-board-sync/SKILL.md` |
| Shared API lib — retries, budget fast-fail, label assertions | `.claude/skills/monday-board-sync/scripts/monday.mts` |
| Per-pass data + `selfcheck()` | `.claude/skills/monday-board-sync/scripts/pass.mts` |
| The review Kane approves (writes `proposal.json` + hash) | `.claude/skills/monday-board-sync/scripts/review.mts` |
| The only writer (`--only-new` = the 6-call lean path) | `.claude/skills/monday-board-sync/scripts/apply.mts` |
| One-shot runner for an approved-but-unwritten pass | `.claude/skills/monday-board-sync/scripts/run-approved-pass.mts` |
| Re-read verification / standalone audit | `.claude/skills/monday-board-sync/scripts/verify.mts` |
| Re-read ONE row in a single call (after `--only-new`) | `.claude/skills/monday-board-sync/scripts/verify-one.mts` |
| Read-only board dump, groups, live labels | `.claude/skills/monday-board-sync/scripts/pull-state.mts` |
| Read-only git evidence for a sprint | `.claude/skills/monday-board-sync/scripts/sprint-evidence.mts` |
| CSV export of a pass | `.claude/skills/monday-board-sync/scripts/export-csv.mts` |

## Items are matched by exact name — this is the rule everything else protects

`sync.ts:167-168` builds `new Map(items.map(i => [i.name, i]))`. No `trim()`, no case folding, no
unicode normalisation. Consequences, all of which have bitten:

- A row created by any other tool whose name is not byte-identical to `taskItemName(t)` is invisible
  to the reconciler, which then **creates its own copy, forever**.
- **Never put angle brackets in an item name.** Monday strips HTML tags on create, so the stored name
  differs from the sent name — permanently unmatchable.
- **Never normalise a name.** Plan names legitimately contain em-dashes, curly quotes, `₱`, `→`, `⊕`,
  `⇄`, `≈`, `×`, and an en-dash inside "Sun–Sat".
- **Renaming a plan title does not rename the board row.** Item names are only ever set at create, so
  a rename creates a new row and orphans the old one with its execution state intact. `verify.mts`
  checks name parity in both directions to catch this.
- **Never import a CSV of these rows into Monday.** The importer may normalise a character; rows reach
  the board through `apply.mts` only.

## Column ownership — why two writers is safe

The boundary is the one `sync.ts:5-10` already declares: *the board owns execution state*.

| Column | Owner | Note |
| --- | --- | --- |
| existence, group placement, item name | reconciler | create only — existing rows are never moved |
| Estimated SP, Type, Sprint, Priority, both relations | reconciler | create **and** update |
| Status, Actual SP | reconciler on **create only** → skill thereafter | this is the seam |
| Completed Date | skill only | reconciler never writes it |
| item updates (the audit trail) | skill only | — |
| Projects Portfolio Status / Total SP / SP Completed | reconciler | **every** pass |

`apply.mts` asserts at runtime that its column set is disjoint from the reconciler's update payload.

**`done: true` in `hris-plan.ts` is a claim of shipped-and-proven, nothing else.** It writes Done plus
an Actual SP. Pending Deploy / Waiting for Review / In Progress are written by the skill's corrector
after creation — which is why an unproven row can never carry an invented Actual SP, and why adding
the honesty gate required **no change to `sync.ts`**.

### The Actual SP hole, and why `done: true` alone never moves an existing row (2026-08-12)

The row above was the *intent*; for the skill's first three weeks it was not the *behaviour*. Nobody
wrote Actual SP on a row that already existed:

- `sync.ts` writes it **only** in its create payload (`sync.ts:256`); its update payload
  (`sync.ts:239-245`) is type / Estimated SP / sprint / priority / relations and omits it.
- `apply.mts`'s corrector wrote only Status and Completed Date.

So a row created as Pending Deploy and later flipped to `done: true` in the plan kept a **blank
Actual SP forever**, and flipping the plan alone changed nothing on the board at all — `done: true`
has no effect outside the create path. That is not cosmetic: Actual SP is what SP Completed and the
bonus rollup read.

It surfaced on `12788029554` (Payment Dispatch wizard-values). Commit `0cafeff` flipped it to
`done: true` on Kane's prod confirmation, and the board sat on Pending Deploy with a blank Actual SP
because the row had been created a pass earlier and the Done had nowhere to land.

The fix keeps both writers disjoint, because Actual SP was never in the reconciler's update set:

- `CORRECTOR_COLS` gains `TASK_COLS.actualSp`, so gate 4's runtime collision assert still covers it.
- One shared `correctionValues(row, plan.sp)` builds the payload for **both** write paths, so the
  full path and `--only-new` cannot drift apart.
- Actual SP is always `plan.sp` — never a number chosen at the call site — matching what the create
  path writes for the same row.
- A row moving **off** Done has its Actual SP and Completed Date **cleared**, not left behind: a
  non-Done row carrying either is exactly the phantom `verify.mts` sweeps for.

`review.mts` prints the Actual SP transition and includes it in the hashed proposal, so an approval
covers the score being written rather than just the status.

**Still open:** the 74 pre-existing Done rows with no Completed Date (and now visibly no Actual SP)
predate the corrector. Backfilling them is a separate pass, and it must refuse to write a date inside
the live sprint so a historical backfill can never read as a fresh claim.

### Three traps that look like bugs but are not

1. **Projects Portfolio Status is not create-only.** `sync.ts:313` rewrites it to `Live` on every
   non-dry-run pass. A corrector that "fixes status columns" across all three boards collides there
   silently, last-writer-wins. The skill excludes board `18419115953` entirely.
2. **Both relation columns are full-set overwrites, never additive.** Anything written to Linked Tasks
   (`board_relation_mm4mhvs2`) or the project's Sprint Tasks (`board_relation_mm4mwppe`) is erased by
   the next reconcile. The skill never writes a relation. The upside: a single reconcile self-heals
   the whole relation graph — one run in Aug 2026 took the project relation from 77 to 135 tasks.
3. **`report.tasksCreated` holds the UNPREFIXED plan name** (`sync.ts:250`), not a board name and not
   an id. Using it as a lookup key silently matches nothing. Re-read the board for ids.

## Done means shipped, and shipped means proven

Bonuses ride on Done, so a false Done is a false claim on money. Kane commits direct to `main`, pushes
manually, and Vercel's Git integration deploys `main` — so **on `origin/main` is necessary but never
sufficient** for Done.

| Situation | Status |
| --- | --- |
| Committed on local `main`, not pushed | In Progress |
| On `origin/main`, not confirmed live | Pending Deploy |
| Deployed **and** clicked through in prod | Done |
| Code done, Supabase migration not applied | Pending Deploy |
| Code done, n8n workflow not imported | Pending Deploy |
| Waiting on Kane to click through it | Waiting for Review |

The migration and n8n rows matter more here than anywhere: HRIS features are routinely code-complete
and **functionally dead** until an external step runs. HSL sub-departments shipped complete on
2026-08-10 and paid nobody differently, because zero `hsl:*` rate rows existed.

**Kane's own confirmation is valid evidence of a prod click-through — it must be asked for and
recorded as the basis, never assumed.** When he says "mark them Done", ask *which*, and never extend
it to a row with an open external step: an assertion cannot import a workflow. Every row the skill
touches gets an item update stating what the claim rests on.

A doc or memory line saying PENDING is **evidence, not proof** — several such claims in this repo are
contradicted by later evidence. A wrongly-blocked row is also a wrong board; show it as `UNVERIFIED`
and ask rather than silently downgrading.

### The push check needs two reads in a shared checkout (2026-08-12)

`git merge-base --is-ancestor <sha> origin/main` is not trustworthy on its own here. Three sessions
share this working tree, and mid-flight ref churn produced flatly contradictory answers for one sha:
both `--is-ancestor` directions returned "yes", `git log -4 main` showed a lineage that did not
contain the commit at all (it lists by commit DATE, and concurrent commits carried later dates), and
`git branch --contains` disagreed with `merge-base`.

Settle it with **membership plus content**, both cheap and both immune to date ordering:

```bash
git rev-list origin/main | grep -q "^<full-sha>$"        # is it on the remote at all
git cat-file -e origin/main:<a file the commit added>    # is the work in the remote TREE
```

Reading a distinctive line back out of `origin/main:<file>` is the strongest form — it proves the
deployed branch carries the actual change, not merely a sha with the right ancestry.

## Story points

Fibonacci only (1, 2, 3, 5, 8), per dev-resources.simple.biz/story-points. **Over 8 is an epic**, so
8 is a legal task score — on a Fibonacci scale the next step is 13, so "over 8" and "≥ 13" are the
same rule. Calibrate against current-sprint neighbours (Sprint 26 rows run 1–5, averaging ~3.5),
never against the bulk-import epics, which were scored at whole-feature granularity.

**Epic SP is an independent rollup and does NOT equal the sum of its task rows** — HRIS-01 is 101 SP
with zero task rows. The Gridline sum-to-parent invariant is deliberately not implemented here;
asserting it would fail on almost every epic.

### An external step can be a row

Work tracked here is normally a commit cluster, but an action in an external system can earn its own
row when it blocks scored work. Item `12789862863` (2026-08-12, Sprint 26, `n8n Workflow`, 2 SP) is
the live import of `references/n8n/paystub-dispatch.workflow.json`; it is the named blocker on three
Pending Deploy rows worth 21 SP.

Two rules that case established:

- **Status is `Ready to Start`, never `Pending Deploy`.** Pending Deploy means code is complete and
  waiting on an external step. When the row *is* the external step, Pending Deploy would leave the
  board showing four rows waiting on each other with nothing naming the actual next action.
- **Cite the commit that produced the artefact**, not a commit that implements the row — `selfcheck()`
  requires evidence, and for this class the honest evidence is provenance. Check the artefact for
  staleness explicitly rather than assuming: the workflow JSON predates three later statement commits
  and is still current, because the Gmail node is now a `{{ $json.paystub_html }}` pipe.

Prefer a dedicated row over an existing catch-all. `HRIS-15`'s "Run outstanding Supabase migrations +
re-import n8n workflows" nominally covered this, but it sits in a closed sprint, its premise is
largely folklore (21 of 25 "pending" migrations were already applied), and nobody would mark it Done
for importing one specific workflow.

## Never group a commit audit by message

Cluster by **file overlap**. In the 78-commit range audited 2026-08-11, message-based grouping would
have been wrong five times: `488cf44` "HSL Weekend Hours Fix" contained no code at all (settings and
build artefacts only), `02dc5aa` "Massiv Update" carried two unrelated features, `a7ecd4c` "Callback"
carried three and named a department that was a different commit, `0b66a8e` "HSL - ANNOYANCE" was an
offboarding n8n workflow, and `5eb398a`'s weekend-OT pricing was **reversed** by `e0028b8` — so one
row must describe the current rule rather than two contradictory rows.

## A sprint label is a claim about dates, and it is now checked (2026-08-13)

Sprint windows are **board facts** — they are in the group titles: `Sprint 26 · Aug 4-15 · Backlog
Pull`, `Sprint 25 · Jul 21-Aug 1`, `Sprint 24 · Jul 7-18`, back to Sprint 7. They are mirrored into
`TASK_SPRINT_WINDOWS` in `hris-plan.ts` so a Completed Date can be checked against the sprint it is
filed under, and `pass.mts`'s `selfcheck()` **refuses** a row whose date falls outside its sprint.

That check exists because filing by feel failed at scale. `5a6c52f` (2026-08-05) filed *"1 epic + 46
tasks for Jul 29–Aug 5"* into Sprint 26 in a single pass. Sprint 25 ran to Aug 1, so most of that span
was already Sprint 25's. Re-measured per row against git on 2026-08-13: **37 of the 57 Sprint 26 rows
had finished before Aug 4** — 94 SP of Sprint 25's work credited to Sprint 26 for eight days. A sprint
label is not a filing convenience; it is an assertion that the work happened in that window.

### Two guards, and why neither can be relaxed

**The date must be git-provable.** `selfcheck()` runs `git log -1` on the row's last sha and refuses a
Completed Date that disagrees with it. This **replaced** the older rule ("never write a date inside the
live sprint"), which was aimed at stopping a historical backfill from reading as fresh work but would
also have blocked the 20 rows that genuinely finished inside the live sprint. Tying the date to the
evidence is strictly stronger — it rejects a stale backfill *and* a flattering guess.

The one exemption is `dateBasis: 'external'`, for a row whose work is an action in another system (an
n8n import, a migration run) where the shas produced the artefact and the completion is the day
someone did the thing. It still must fall inside the sprint window, and `selfcheck()` refuses the
exemption unless `basis` actually names a confirmation. Exactly one row uses it: the live n8n paystub
import, Done 2026-08-12 on Kane's confirmation, whose newest commit landed 08-11.

**Gap days belong to the sprint that closed.** Sprints run **Tuesday → Saturday**, so the Sunday and
Monday between two of them fall in no window — and 10 rows finished on Monday 2026-08-03. Kane's
ruling: Sprint 26 is Aug 4-15 **only**, so gap work is filed under the sprint that just closed.
`taskSprintAttribution()` encodes that: a sprint accepts dates through *the day before the next sprint
starts*, or through its own end when it has no successor. The ranges therefore tile the calendar with
no gaps and no overlaps — S24 accepts to Jul 20, S25 to **Aug 3**, S26 to Aug 15 — and the live sprint
is never widened past its stated end, because its own gap has not happened yet. Adding Sprint 27 later
extends Sprint 26 by its gap automatically, the same treatment every closed sprint got.

### The group and the Sprint label are one fact

Re-attributing a row needs **both**, and until 2026-08-13 the reconciler could only write one:
`TASK_GROUPS[task.sprint]` appeared solely in the create payload, so an existing row kept its original
group forever. A plan-only relabel would have left 37 rows sitting under the "Sprint 26 · Aug 4-15"
heading with a Sprint column reading "Sprint 25" — a half-move that reads worse on the board than no
move at all.

`sync.ts` now issues `move_item_to_group` from its **update** path, and only when the live group
disagrees with the plan's sprint, so a steady-state pass costs zero extra calls. Moves are reported as
`SyncReport.tasksMoved` and appear in the `GET` dry-run preview, because a silent re-grouping is
indistinguishable from someone hand-dragging rows. Ownership is unchanged: group placement was always
the reconciler's, and the corrector still never touches it — the runtime disjointness assert in
`apply.mts` is unaffected because a group is not a column.

**Still open:** epics are not moved between quarter groups. The identical gap exists on the epic path;
no plan quarter has changed yet, so nothing is wrong today.

### Backlog is not a status (2026-08-14)

The same bug has a mirror image, and it hides in the Backlog. A row parked there because it was
*blocked* stays there after the blocker clears, because clearing a blocker moves the Status and
nothing moves the sprint. Three rows worth **21 SP** sat in the Backlog for two days after going Done
— all three held on one shared external step, the n8n paystub import, which landed 2026-08-12.

So the rule has two directions, not one:

- a row filed in a sprint asserts its work finished in that window (`selfcheck()` enforces it), and
- **a Done row filed in the Backlog asserts its work finished nowhere** — which is only ever true of
  work that predates sprint tracking.

`selfcheck()` cannot catch the second: Backlog is deliberately exempt from the window check, because
it is unscheduled and no date can be wrong for it. That exemption is right, and it is exactly what
lets a Done row hide there. **The check is a review-time question, not a code guard:** every pass
should ask which Backlog rows are Done, and re-file the ones whose work has a date.

When re-filing, the completion is often an action in another system rather than a commit, so
`dateBasis: 'external'` is the normal case here, not the exception — the code lands days before the
import or migration that makes it real, and dating the row to its ship date would back-date a
completion to before its own evidence existed.

**Backlog rows that are NOT Done stay put, and a stale-looking blocker is not a promotion.** A row is
only ever moved to Done by evidence, never because its recorded blocker appears to have been overtaken
by later work.

**What the Backlog actually holds** (audited in full 2026-08-14, 47 rows): 2 genuinely open, and 42
Done rows of pre-sprint history dating 2026-04-07 … 2026-07-24, worth 163 SP. All 42 are datable from
git — 14 are title-cased **feature-doc slugs**, so the commit that added the doc dates them (use
`git log --follow --diff-filter=A`; without `--follow`, the `4b323de` docs reorganisation masquerades
as three features shipping on 2026-05-27), and 16 more are dated by the commit that introduced their
API route directory. Filing them needs group ids and label indices for Sprints 17-23, which are not in
`hris-plan.ts`, and rewrites nine sprints' recorded velocity — deferred, not forgotten.

## API budget

The account has a **daily** complexity budget. Exceeding it returns `429 DAILY_LIMIT_EXCEEDED` and
nothing succeeds until reset — **including read-only verification**. Budget the verify, not just the
write.

**The reset time is in the error, so stop guessing it.** The response body carries
`extensions.retry_in_seconds` and a matching `retry-after` header; `monday.mts` prints both plus the
observation timestamp. Measured 2026-08-13: observed `13:09:02Z` with `retry_in_seconds: 39057`, which
lands on **00:00 UTC** — the budget is a clean UTC-day bucket (20:00 EDT / 21:00 EST).

**A full day's budget can be gone before you make a call.** On 2026-08-13 the first read of the day
failed at 12:00 UTC even though no pass had run in that UTC window, and the cause was never
identified. So probe with one cheap `boardGroups` call before committing to a ~300-call pass, and treat
a big pass as the day's only board work. Ask only for the columns you read: pulling all ~21 columns across 2,172 items is the most
expensive call available. A full `apply.mts` is ~200 calls because the reconciler patches all 135
tasks and 37 epics every run — the honest cost of driving the app path. `monday.mts` raises
`DailyLimitExceeded` immediately rather than retrying into a wall.

### `--only-new` — the lean path for an add-and-correct pass

Added 2026-08-12 (Kane: "we can't just add 1 run and 1 api call?"). For a pass that only creates
rows and sets their execution state, ~199 of those 200 calls re-assert values that are already
correct. `apply.mts --only-new` skips the reconciler and does the job in **6 calls**: 3 for the
label gate, 1 exact-name lookup (`items_page_by_column_values`, not a full board page), 1
`create_item` carrying **every** reconciler-owned column at once, 1 evidence update. Verify with
`verify-one.mts <itemId>` (1 call) rather than `verify.mts`, which pages the whole board.

It is safe against the recreate-forever trap for one reason: the name it creates is
`taskItemName(plan.name)` read from the same `PLAN_TASKS` entry the reconciler matches on, so a
later full sync **adopts** the row. A hand-typed name would not be safe, which is why the writer
re-asserts the plan lookup and refuses a name it cannot find.

What it deliberately does not write: **board relations** (the epic link and the project rollup are
full-set overwrites — writing one erases the rest), epic creation, and any re-patch of rows the
pass does not name. Those stay unset until a full reconcile runs. A row created this way is
correctly grouped, typed, scored and statused, but **not yet linked to its epic** — so the Roadmap
& Epics rollup lags until then.

Exercised three times on 2026-08-12 (items `12786252360`, `12788029554`, `12789400254`), each
verified by re-read. **Three Sprint 26 rows are therefore unlinked from their epics** (HRIS-01a,
HRIS-03a, HRIS-18) and will stay that way until the next full `apply.mts` adopts them by name.

It also serves a **correct-only** pass, where every row already exists and nothing is created. The
Sprint 26 close-out later the same day took all three of those rows in one run — two to Done with an
Actual SP and a Completed Date, one from In Progress to Pending Deploy — in **12 calls**: 3 for the
label gate, then per row 1 exact-name lookup + 1 `change_multiple_column_values` + 1 evidence update.
The full path would have cost ~200 to write the same three rows. It is the right mode whenever the
pass changes no structure: no new row, no re-score, no sprint move. Flipping `done: true` in the plan
is **not** a structural change — the reconciler's update payload ignores it (see the Actual SP hole
above), so it needs the corrector either way.

## Deploy notes

**No migration.** No Supabase involvement anywhere in this feature.

- `MONDAY` must be set in `.env` (present). **PENDING:** it is still not set in the Vercel dashboard,
  so the in-app Admin button 502s in production. The skill is unaffected — it reads `.env` locally.
- Labels and groups are **structure-locked**: `create_labels_if_missing: true` returns 403 even when
  nothing is missing. New Status/Sprint/Type labels are added on the board by hand, then mirrored into
  `hris-plan.ts`.
- **Sprint 27 exists — DONE 2026-08-19.** Someone added `group_mm66ce8q` ("Sprint 27 · Aug 18-Aug 29",
  label index **103**) on the board, and it is now mirrored into all four tables. Mirroring the
  **window** is the load-bearing half: it re-bounds Sprint 26's attribution to Aug 4-**17**, which is
  what finally gives Aug 16-17 a sprint instead of nothing.
- **Sprints 17-23 are mirrored too** (2026-08-19), which is what the Backlog backfill was blocked on.
  The label indices are the board's own and are **NOT sequential** — S22 is `3` and S23 is `4` while
  S19-S21 run `10`-`12`. Read them off `settings_str`; never guess one. **S18 carries no HRIS row but
  must still exist**: `taskSprintAttribution()` ends a sprint the day before the next one *starts*, so
  omitting S18 would let S17 absorb Apr 12-27 and silently accept a date belonging to a sprint the plan
  cannot name.
- **Known drift:** HRIS-22 is `Cancelled` on the board but `Shipped` in `hris-plan.ts`. The reconciler
  writes epic Status at create only, so the board wins and this drifts until one side is corrected by
  hand. It currently withholds 12 SP from SP Completed.
- **Completed Date backfill — 43 of 73 written 2026-08-19, 30 still pending.** HRIS never wrote the
  column before this skill. **The old rule here ("refuse to write a date inside the live sprint") is
  SUPERSEDED and was wrong** — it would have blocked rows that genuinely finished inside the live
  sprint. What replaced it is stronger, not looser: `selfcheck()` runs `git log` and refuses any
  Completed Date that is not the commit date of the row's last sha, *and* refuses one outside its
  sprint's `taskSprintAttribution()` range. A stale backfill cannot read as fresh and a flattering
  guess cannot pass either. `dateBasis: 'external'` is the one exemption and must name a confirmation.
- Nine epics carry 220 SP with zero task rows (HRIS-01, 16, 17, 22, 23, 25, 29, 31, 32).

## `groupPinned` — protecting a human triage lane

A row's GROUP and its Sprint label are normally the same fact stated twice, so `sync.ts` reconciles the
group to the label. That is **wrong** for a row someone has deliberately parked in a triage group that
has no Sprint label at all.

On 2026-08-19 a group that had not existed before — **"For Re-scoping"** (`group_mm65rmf9`) — held three
of our rows, while their Sprint labels still read Sprint 25 / Backlog / Backlog. The next full reconcile
would have dragged all three back out and erased the triage silently.

- `PlanTask.groupPinned?: boolean` means **the board owns this row's group**; the reconciler never moves
  it. The **label stays reconciler-owned** — only the move is suppressed.
- A suppressed move is **reported**, not hidden: `SyncReport.tasksGroupPinned`. Suppressing silently
  would be the same class of invisible act the move-reporting exists to prevent.
- It worked on its first run: `tasksGroupPinned: 3`.

**All three pins were released the next day**, 2026-08-20, when the Sprint 27 pull scheduled those rows
— a scheduled row belongs in its sprint group, not in triage. **No row sets `groupPinned` today.** The
capability is kept rather than deleted: "For Re-scoping" still exists on the board, so the next row a
human drags there needs the same protection, and deleting the flag would re-open the hole within a week.

## Sprint 27 pull — the rollover rules (2026-08-20)

Kane: *"any backlog or any future task that we may be possible to achieve … or any task from Sprint 26
that were not achieved there just move it to this period."* Applied as **6 open rows / 31 SP** into
Sprint 27 (Aug 18–29), folded into the same apply as the Completed-Date backfill so one reconcile served
both (~200 calls instead of ~400). Result: **0 created · 139 patched · 26 re-filed · 36 corrected · 0
status transitions**, rollup unchanged at 1569 / 874, and the Backlog and For Re-scoping groups now hold
**zero** of our rows.

Three rules generalised out of it, now in `SKILL.md`:

- **Only OPEN rows roll forward.** The Backlog group was 22 rows of which **21 were Done** — Apr–Jul
  history worth 85 SP. Pulling those into the live sprint would credit four months of work to a
  two-week window. Done rows get re-filed to the sprint they *finished* in; open rows roll forward.
- **Scheduling a row is not a claim about how far along it is.** "Mark them Ready to Start" applied to
  the four rows that had not started. The two offboarding/HSL rows stayed at **Pending Deploy** — their
  code is on `origin/main` and only the prod click-through is missing, so Ready to Start would have
  moved them *backwards* and discarded a true status to satisfy the letter of an instruction.
- **An empty rollover is a finding.** Sprint 26 closed **23/23, 100 SP** with nothing to carry. Recorded
  so nobody hunts for a backlog that never existed.

Velocity context for planning: S24 / S25 / S26 ran **84 / 167 / 100 SP**, so a 31 SP pull is a thin
sprint that needs scope from somewhere other than the backlog.

## Two holes in the approval gate, both closed 2026-08-20

1. **Sprint moves were invisible, and unbound.** `review.mts` printed `tasks to patch: 139`, which
   cannot distinguish re-asserting 139 correct values from re-filing 59 rows into different sprints —
   and `sprint` was absent from the **hashed** proposal entirely, so an approval hash did not bind the
   re-filings it authorised. Two passes were approved through that hole. There is now a **SPRINT MOVES**
   section listing every row whose sprint changes, it is part of the hashed payload, and a Done row
   moving *into* the live sprint is flagged inline. A sprint label asserts a date range, so a wrong one
   is the same class of falsehood as a wrong Completed Date.
2. **The hash bound the file, not the working tree.** `apply.mts` compared the approved hash against
   `proposal.json` and then wrote whatever `hris-plan.ts` said at run time. Observed live: a proposal
   minted 13:30 was still on disk after a concurrent session re-filed six rows into Sprint 27, and the
   stored hash described none of it. `review.mts` now also stores an **`inputsHash`** over
   `{passDate, PLAN_TASKS, ROWS}`; `apply.mts` recomputes it offline and refuses on mismatch. A proposal
   predating the check has no `inputsHash` and is treated as stale — fail closed.

Also fixed: a **claimed write that never happened**. A pass header stated the phantom Actual SP 5 on
"Google Sheet sync crons" had been cleared, but the row was never added to `ROWS`, and `sync.ts` cannot
clear it because Actual SP is corrector-owned. Adding the row for its Sprint 27 evidence update is what
actually closed it — `verify.mts` now reports `unshipped rows carrying an Actual SP: 0`. **A pass header
is a claim like any other; read the write path.**

## Concurrent sessions share `proposal.json`

`proposal.json` and its approval hash are **one file**, and this checkout is shared. A second session
running `review.mts` overwrites the proposal the first one showed Kane, so an approved hash can be
silently replaced by a different pass's. Observed 2026-08-19: hash `3578fe5c294f` was applied at 13:19
and a concurrent session had minted `e9280075d85c` over it by 13:30.

Before proposing, `ls` the mtimes of `proposal.json` / `pass.mts` / `hris-plan.ts`. If they moved in the
last few minutes another session is mid-pass — **fold into it or wait, never race it.** Two full applies
also cost ~400 calls against a daily budget one pass nearly fills.

## Rate limits: 429 is a WINDOW, not a pause

`sync.ts` has its own `gql` (separate from the skill's `monday.mts`). It used to back off
`1200ms * attempt` over 4 attempts — about 12s total — but **Monday's rate-limit window is a full
minute**, so all four attempts fell inside one window and it threw. A ~200-call reconcile died
mid-structure this way on 2026-08-19, leaving the board half-patched.

Fixed: a **429** now honours `retry-after` when present and otherwise waits the minute out, over 6
attempts; **5xx and network faults keep the short backoff** because those are genuinely transient. A
partial reconcile is *incomplete, never wrong* — the reconciler writes desired state and is idempotent,
so re-running completes it.

## Pass 4, 2026-08-20 — what closing one row uncovered

`--only-new`, 6 calls, hash `98579ab77d67`, every row verified with `verify-one.mts`.

The Sprint 27 row *"Run outstanding Supabase migrations + re-import n8n workflows (12+ pending SQL
files)"* closed **Done**. The parenthetical was folklore: measured, it was **one**. But the three rows
`audit-pending-migrations.mts` could not settle read-only were hiding the real finding — two shipped,
board-**Done** features had never delivered a single notification. `pab.excluded` / `pab.restored` were
dead 17 days and `kpi.scored` 3, at **0 rows each** against 3,694 for `payroll.available`, because the
type CHECK rejected every insert and all four call sites swallow a failed notify into `console.warn`.

Three consequences worth carrying forward:

- **A wrong row title stays wrong.** Item names are set at CREATE only, so renaming orphans the row and
  mints a duplicate. Put the correction in the evidence update, never in the name.
- **`ROWS` is rewritten per pass, not appended to.** Keeping the previous pass's 30 applied rows would
  have stamped "board sync pass 2026-08-20" onto work that finished in April for zero board change — a
  false audit trail is worse than a short one.
- **`--only-new` writes no epic relation, and that is now confirmed live**, not just documented: all
  three created rows read `epic rel: (unset)`. Correctly grouped, typed, scored and statused; unlinked
  until a full reconcile adopts them by name.

The `inputsHash` gate added earlier the same day fired on its first real use —
`approval accepted: 98579ab77d67 (source verified: 7eb9bf9db186)`.

One soft spot is recorded rather than glossed: the independent `pg_constraint` re-read after the final
DDL was never obtained, so that write rests on Kane's report that it succeeded. Admissible under the
honesty gate — his confirmation counts and is **named** as the basis — but weaker than the three-way
proof the view fix got, and the row says so.

## Pass 5, 2026-08-20 — the undocumented week, and what measuring it cost

Kane: *"for the past week or so we have undocumented features and commits might be chores."* Range
`9fe6504c..HEAD`, 83 commits, Aug 13–20. Hash `ddfcf89d9558`, source-bound to `245f6bff9e15`.
**28 rows created, 142 patched, 0 re-filed, 29 corrections written. 23 Done, 80 SP newly credited.**

Sprint 26 went 23→35 rows and 100→146 SP; Sprint 27 went 9→22 and 38→90; the Backlog went from
empty to 3. Nothing already on the board changed sprint, so no existing row was silently
re-attributed.

### Four more commit messages that lied

The rule "cluster by file overlap, never by message" earned its keep again. In this range:

| sha | message | contents |
|---|---|---|
| `4e8309af` | `Push` | the entire view-scoped notification-chime feature, plus a 100-line doc |
| `4447e404` | `ss` | `scripts/fix-lawang-rate-shadow.mts` — an unapplied payroll fix |
| `6d3be952` | `Push` | settings + a backup JSON — **noise, no row** |
| `0e402a0d` | `s` | settings + one `cycle_complete_claim` backup — **noise, no row** |

A message-clustered pass would have created two rows for noise and missed a shipped feature. The
chime row exists today only because the file list was read.

### Author date is not landing date

`4a15db2c` merged the HSL GML roster branch on **Aug 19**. Every commit on that branch is authored
*and committed* **Aug 3**, so `sprint-evidence.mts` — which prints `--date=short`, the author date —
showed eleven commits two weeks older than the work.

This is worse than cosmetic, because **`selfcheck()` would have accepted the lie.** It checks that the
Completed Date equals the commit date of the row's last sha; ending the sha list on the branch tip
`01c97f6d` gives Aug 3, which is a real commit date, so the row would have passed selfcheck and filed
a fortnight of unmerged work into Sprint 25.

The rule: **for work that landed via a merge, the row's last sha is the MERGE commit.** The branch
shas stay in the list as evidence, but never last.

### Three "PENDING" claims, and this time two were true

The standing warning is that PENDING claims in docs and memory go stale — five have. This pass is the
counterweight: measured read-only against production, two of three were **accurate**.

| Feature | Claim | Measured 2026-08-20 |
|---|---|---|
| Employee Penny AI | migration PENDING | **TRUE** — `penny_employee_usage` absent (PGRST205) |
| Time adjustments 2nd approver | migration PENDING | **TRUE** — all four columns absent |
| `kpi.scored` notification | DDL applied 08-20 | applied, but **0 rows ever delivered** |

So the rule is not "PENDING claims are stale". It is **measure, and do not assume in either
direction.** All three rows are Pending Deploy with the measurement as the basis — the Penny AI one
matters most, because nine commits of polish sit on top of a feature that cannot serve one prompt.

### The auditor that made the previous pass's evidence unsafe

`scripts/audit-pending-migrations.mts` is how this project replaces PENDING folklore with an
observation, and **for tables it returns the wrong answer.**

`probeTable()` does `select('*', { head: true, count: 'exact' })` and treats a falsy error as APPLIED.
Under `head: true` PostgREST returns **no error at all** for a table that does not exist — just
`count: null`. Proven twice: `penny_employee_usage` (genuinely absent) and a control table named
`definitely_not_a_table_xyz` both come back clean, while the positive control
`employee_notifications` returns `count=181799`. That positive result is exactly why it was never
noticed.

`probeColumn()` fails differently. A missing column errors with `code: undefined` and an **empty
message**, matching neither the `42703` branch, nor the regex, nor `PGRST205` — so it lands
INCONCLUSIVE instead of NOT APPLIED. A plain `.limit(1)` without `head` errors correctly with `42703`.

**Consequence, stated rather than glossed:** any table-creating migration that never ran was counted
APPLIED, and pass 4 closed the Sprint 27 migrations row **Done** on that audit's
`APPLIED 21 / NOT APPLIED 1 / INCONCLUSIVE 3`. That row was left Done here and the re-adjudication put
into the new Critical Backlog row's blockers — fixing the auditor is a non-trivial correctness edit to
existing code and belongs behind the `hardening` skill, not inside a board pass.

### The pass exhausted the day's budget and stranded its own verification

`apply.mts` finished clean (exit 0, 28 created / 142 patched / 29 corrected). `verify.mts`, run
immediately after, died on `DAILY_LIMIT_EXCEEDED` — `retry_in_seconds: 39234` observed at
`13:06:06Z`, which lands on **2026-08-21T00:00:00Z** and confirms the clean UTC-day bucket a third
time.

So this pass is **applied and partially verified**, and the doc says so rather than rounding up:

- **Independently confirmed.** Phase 2 re-reads the board after phase 1 creates rows, resolving every
  correction target by byte-exact name. All 29 resolved, none landed in `skipped`, none tripped the
  `hit.count > 1` duplicate guard. So all 28 rows exist, the reconciler adopted them by name rather
  than minting duplicates, and the corrections addressed real ids.
- **Acknowledged but not re-read.** The status / Actual SP / Completed Date values. Each mutation
  returned success — `gql` throws otherwise — but no independent read confirms what the board holds.

What this changes for the next big pass: a 28-row pass costs roughly a full day's budget once the
reconciler's 142-row patch is included. **Verify a sample with `verify-one.mts` (1 call each) between
phase 2 and the full `verify.mts`**, or split a pass of this size across two UTC days. A write you
cannot verify is not done — and the cheapest moment to verify is before the budget is gone.

### The concurrency heuristic false-positived on its own residue

SKILL.md says: if `proposal.json` / `pass.mts` / `hris-plan.ts` moved in the last few minutes, another
session is mid-pass. At the start of this pass all three had moved **6 minutes** earlier — but that was
pass 4's own residue: the working tree was clean and `f51b4cd5` already contained it.

Recent mtimes alone cannot tell "a session is writing right now" from "a session just finished and
committed". The tree state is what separates them, and it is free to check.

## The pending-SP ledger — 2026-08-21

Kane: *"if the Monday API Budget is exhausted we would store our SP and when I call to push it you
will push our pending SP to Monday."* Built as `pending-sp.json` (tracked in git) plus
`scripts/flush-pending.mts`.

### The hole it closes

A full pass is ~200 calls against a UTC-day bucket. The 08-20 failure was the *lucky* shape: the
apply finished and only `verify.mts` died. The unlucky shape is the budget dying **between
corrections** — the run ends, the tail is never written, and the SP is recoverable only by
re-deriving the whole pass from git.

### Why a one-command flush does not defeat the approval gate

A queued entry carries the approval hash it was born under, so flushing it **completes an
already-approved write that the budget interrupted**. That is the entire justification, and it is
why an entry with **no hash** is refused rather than written — `review.mts` is the only path to
approval.

### Time is the new adversary, so the flush re-derives

`apply.mts` refuses a proposal minted for a different pass date, and that gate stays. `revalidate()`
re-checks against the current repo and plan and refuses on: no approval hash · re-scored since
queueing · name no longer in the plan byte-exact · Done with no Completed Date or with an open
blocker · **Completed Date no longer equal to the last sha's commit date** · a sha git cannot
resolve or that is no longer an ancestor of `origin/main`.

That fifth one is the point. A Completed Date is a claim about when work became provable, and a
rebase or amend between queue and flush would let a stale date land looking fresh. All seven classes
were exercised against synthetic entries; only the still-true entry passed.

**The Completed Date is never moved to the flush day.** The lag goes into the evidence update
instead — queue date, original approval hash, and how many days late — so the trail shows the board
caught up after the fact rather than pretending it was current.

### Two things building it taught

**A queue that only covers a mid-loop death is not a queue.** The first version hooked the
corrections loop. Then the real budget was already dead when I tested — other sessions had spent it
by 13:17Z — and `apply.mts` died on the **phase-1 label gate**, before a single correction, so the
hook never fired and nothing was queued. Fixed by hoisting a module-level `WRITTEN_ITEM_NAMES` set
and putting **one** handler around everything from the label gate onward: whatever landed is known,
so whatever did not can be queued from any death point.

**`correctionValues()` moved to `monday.mts`.** It was private to `apply.mts`, which runs a pass at
import time — so the flush could not import it without triggering one. Copying it would have given
the board two write rules that could drift, which the two-writer split exists to prevent. Now all
three write paths import the same function.

Cost: 1 budget probe + ~2 calls per row, so a 10-row flush is ~21 calls against the ~200 a reconcile
needs — affordable on a partly-spent budget. It takes the same `.apply.lock`, writes only corrector
columns, and marks entries flushed **one at a time** so a mid-flush death leaves an accurate ledger.

## Pass 10, 2026-08-24 — "update the board from pending last week"

Eight rows created, 33 SP, all Sprint 27. Approval `cd3cedd008a1`, applied clean, all eight verified
by re-read. **Zero reached Done**, and that is the honest result: seven are pushed but nobody has
looked in production, and the eighth is not pushed at all.

### What "pending" turned out to mean

Three rows were staged in the plan on 2026-08-21 and never written, because the daily budget died
**twice** that day — `e8feba9c` at 13:07Z and `6e9564f9` at 17:33Z, both `retry_in_seconds` landing
on 00:00Z, the clean UTC bucket for the third and fourth measured time. `pending-sp.json` was empty
throughout and correctly so: the flush refuses a row that is not on the board yet, and refuses an
entry with no approval hash, so queueing a NEW row would only have produced guaranteed refusals.
**Staging the plan is the pending state for a row that does not exist yet; the ledger is for
corrections to rows that do.** That distinction is now load-bearing and worth keeping straight.

Reading the range then turned up the larger half of the answer: **five shipped features had no board
row at all.** "Pending" was three staged rows plus five undeclared ones.

### A staged status was already false when it was written down

The tickets row was staged saying "NOT STARTED — no code exists for it yet; the sha is the commit
that opened the plan row." Hours later `90fb23fa` shipped the entire feature — 17 files, 827
insertions, `notify.ts` hooks, a tested `recipients.ts`, `ticket.moved` through the notification
actions and views, and both n8n workflow files. Applying the staged text verbatim would have written
a lie onto the board on a row that was, by then, code-complete.

**A staged row is a snapshot of a claim, and a claim decays.** The queue-and-flush machinery
re-derives at flush time for exactly this reason, but a row staged in `pass.mts` rather than in the
ledger gets no such re-check — nothing re-reads its `basis` prose. So the rule that pays for itself:
**re-derive every staged row's status from git before proposing it, never carry the staged wording
forward.** Corrected to Pending Deploy with its two real external blockers.

### Clustering, and where the file lists overruled the messages

- **Three catalog commits, one row.** `24d6d0a1` built `dept-rail.ts` (264 lines + 269 of test, a
  598-line screen change), then `6cb643b2` and `47e84590` hardened the same module and the same
  screen the same day — owner-by-identity, then an adder guard that could overwrite a live rate from
  a blank form. Three commit messages that each read like a separate fix; one feature by file overlap.
- **MV plus its animation, one row.** `de0fa485` only re-animates `ValidationFullScreen.tsx`, and git
  confirms `56390cb9` is that file's add-commit — the same feature finishing, not a second one.
- **The orphanage row is a SECOND row, not an edit.** The Done 2-SP S27 row was a seventeen-line
  price correction; `ae947bbc` is 1,763 insertions of hardening on top — pricing extracted as one
  tested rule, below-regular OT refused outright, an audit script, and the 2026-08-09 week repaired.
  It does not *reverse* the earlier row, it makes the same rule unfalsifiable, so both stand. The
  "one row must describe the current rule" rule applies to reversals; a hardening pass is new work.
- **`ef1b4d93` is noise.** One file, `.impeccable/config.json` — design tooling scope, no board row.

### The unpushed commit is why nothing was assumed

`2951167a` (Hurupay → Kolan) is `HEAD`, and `origin/main` is `ef1b4d93`. `git merge-base
--is-ancestor` fails, so it is **In Progress**, not Pending Deploy — 48 files and 576 insertions of
shipped-looking work that has not left the machine. It also carries an un-run `payout_brand`
migration, so it cannot reach Done on the push alone. Scored 3, not 5: wide and shallow, the stored
`hurupay` value never moves, and nothing reprices.

### Scoring note — line count is not complexity

MV is the second-largest diff of the week (~1,750 lines) and scored **5, not 8**. It records a human
judgement and never prices anything: no rate, no amount, no score component moves. The 8s on this
board are money-math (mid-week rate proration, the HSL sub-department cutover), and letting a large
but narrow-risk diff buy an 8 would make the top of the scale meaningless. Its one novel part is that
the validation cannot live on `payment_dispatches` — at the Validation step no dispatch row exists — so it rides
an `app_settings` blob written compare-and-swap.

### Budget

Probed alive with one `boardGroups` call before planning anything, which cost 1 call and settled it.
Full apply (~200 calls) then **eight `verify-one` calls instead of `verify.mts`** — the pass-5 lesson
applied: a 28-row pass plus a full board page exhausted the day and stranded its own verification.
Eight single-item re-reads proved the values for every row written, at ~4% of the page cost.

### A concurrent session moved HEAD mid-pass, and the range string is why that is survivable

`HEAD` was `2951167a` when the proposal was minted and applied. By the time the pass was being
recorded another session had committed `59dc91af` (Kolan/HiGlobe assignable when unrouted), so `HEAD`
had moved and `AUDIT_RANGE = '412af38f..HEAD'` no longer resolves to the 17 commits it named.

**`pass.mts` is deliberately left exactly as applied.** Its range string is reproduced verbatim in
every board update it wrote, so editing it now to pin the sha would make the local record disagree
with the board — a worse defect than a loose range. The rows themselves cite explicit shas, so
nothing about what was written is ambiguous. Re-checked after the move: `2951167a` is still not an
ancestor of `origin/main`, so the Kolan row's In Progress is still correct, and `59dc91af` touched no
Monday file, so there was no collision. **`59dc91af` is the next pass's work, not this one's.**

The concurrency heuristic behaved correctly here for the opposite reason it false-positived in pass 5:
`proposal.json`, `pass.mts` and `hris-plan.ts` all had mtimes three days old with a clean tree, which
is residue, not a live session. The other session was working in `src/lib/employee/`, nowhere near.

## Pass 13 — 2026-08-25 · twelve undeclared features, twelve closed, one refused on a measurement

Kane: *"Update our Monday Board if we have fixed anything and make sure we have completion dates."*
Then, after review: *"All of those are deployed already Ive tested them"* / *"mark them as done please
also add their priority levels."*

### The completion-date half was already true, and it was measured first

`verify.mts` ran **before** anything was written — the cheapest moment, per the pass-5 lesson.
**Done rows with no Completed Date: 0**, across all 188 rows, plus 0 over the 8-SP cap, 0 open rows
with a blank Estimated SP, 0 phantom Actual SP, and the rollup and relation both exact. The
74-row backfill in Known Drift stays closed. It also confirmed all 8 rows from pass 12 landed as
claimed. So nothing was missing a date — **twelve features had no board row at all**, which is the
different problem the ask actually surfaced.

### Message-versus-content fired three times in twenty commits

Clustering was done on file overlap, never on subject lines, and the range shows why:

| sha | says | is |
|---|---|---|
| `7b9fe312` | **ATTESTATION** | the Payroll Wizard step rail — **no attestation code at all** |
| `681662f7` | feat(kpi): Attestation… | the commit that *actually* changes Attestation |
| `667dfe9d` | **"Fix"** | the `sheet_synced` false-success repair (197 of 200 transfers claiming a sheet write that never happened) |

A message-clustered pass would have merged the first two and described neither. `7b9fe312` also
dragged five `.tmp-vfy-*.mjs` probes and two report JSONs into the tree as residue — noise, given no
row, but now committed and worth a cleanup.

Two multi-commit clusters collapsed to one row each for the same reason: four commits touching
nothing but `Overview.tsx` on one day are one screen built and finished, and `06f7f669` /
`d08a9948` / `d24b49a8` are one Orientation panel built, documented, then lifted into its own tab.

### One row landed in the gap between the previous review and its apply

`59dc91af` was committed after pass 12's `review.mts` minted its proposal (10:23) and before
`apply.mts` ran (10:49), so that pass could not have seen it. **The audit range ends at the review,
not at the apply** — a recurring shape, not a one-off.

### Kane's confirmation is the evidence, and it is quoted on every row

The honesty gate's "deployed and clicked through in prod / Kane says so / record that as the basis"
is exactly what happened: the pass **asked which ones** rather than guessing, and each closing basis
quotes the answer verbatim. Twelve rows closed, 40 SP.

### One row is held anyway, against an explicit "all of those"

`1f94ff70` (the dispatch export fix) is **not an ancestor of `origin/main`** — re-fetched *after*
that message specifically to be sure, and re-checked again at commit time after a concurrent session
moved HEAD. Vercel deploys `origin/main`, so the commit is not in production whatever the working
tree shows. **A blanket confirmation cannot push a commit.** Marking it Done would put a claim on the
board that one command disproves. It stays In Progress and advances the moment it is pushed.

### One blocker was closed by measurement, not by the confirmation

The Kolan rename was held on an un-run `payout_brand` migration, and **an assertion cannot run a
migration**. So it was probed read-only instead: `hr_onboarding_submissions.payout_brand` returns
rows, and a negative control on the same table returns `42703 column does not exist` — which is what
proves the probe can detect an absent column at all. It has been run. Probing **without `head: true`
and with a negative control** is the rule three separate incidents were needed to learn.

### Two external steps split into their own rows rather than blocking or vanishing

Both parent rows explicitly did not claim them, so closing the parent buries nothing:

- **the n8n orientation Filter node**, never imported — the deliberate *second* layer. The sender
  gate is the fix and Kane tested it, so the gate row closes and the import gets its own 1-SP row.
- **the 9 drifted master-sheet department cells** — the code fix stops *new* drift and repairs none
  of the old, so the data repair gets its own 3-SP row, ordered (flip the cell, re-stamp, **then**
  sync) because syncing first would mint 9 duplicates in pre-transfer departments.

Closing a row whose stated claim is met while carrying the open remainder forward under its own name
is the alternative to the two bad options: a false Done, or a real fix held hostage to someone else's
to-do list.

### Priority: the plan could not express what the board offers

The board's Priority column carries **four** labels (Critical 0 / High 1 / Medium 2 / Low 3), but
`TaskPriority` modelled only Critical and High — so every row below High was silently unlabelled.
The type and `TASK_PRIORITY_INDEX` are extended to all four. That is an **addition** to what the
reconciler can write, never a loosening of a guard.

Assigned: **High** to money, disclosure and live-incident rows; **Medium** to reporting and label
surfaces; **Low** to the wizard step rail.

### Budget and path — and why the lean path was not enough

Probed alive with one `boardGroups` call. Ran `--only-new` first (~45 calls) on the correct reading
that this pass had no new epic, no re-score and no sprint move. **`verify.mts` then failed 14 times
on "not linked to an epic"** — the disclosed trade of the lean path, which writes no relation.

Rather than leave a known-broken invariant, the budget was re-probed and the **full reconcile ran on
the same approval hash** — legitimate because the 188-row patch was already in the reviewed proposal.
Second verify: `202 of 202`, **VERIFY PASS**. Total ≈ 390 calls across two applies and three board
pages; the day's budget held.

**The lesson to carry:** `--only-new` is cheap because it skips the reconciler, and the relation gap
it leaves is not cosmetic — `verify.mts` fails on it. On a pass creating more than a handful of rows,
budget for the full reconcile from the start rather than paying for both.

## Pass 16 — 2026-08-27 · the flush: 9 owed rows land, 33 SP, all re-read

The first flush that ran the ledger to **zero**, and the first end-to-end proof that a dead budget
now *defers* SP rather than losing it.

Pass 15 (2026-08-26) died at correction 7 of 16 and queued **9 rows** under approval hash
`7378e56e5902`. Kane: *"All withheld SP — update the board now."* That is the flush trigger, and it
needed no new approval: every queued entry carries the hash it was born under, so writing it
**completes an already-approved write the budget interrupted** rather than inventing one.

### The gates that ran before anything was written

- **Concurrency.** `proposal.json` / `pass.mts` / `pending-sp.json` all had mtimes ~21h old — but
  mtime alone was the thing that false-positived on 2026-08-20, so the tree was checked too:
  `git status` clean under `.claude/skills/monday-board-sync/` and `src/lib/monday/`, and `baa43bda`
  already contains that residue and is an ancestor of `origin/main`. **Landed pass, not a live one.**
- **Budget.** One `boardGroups` probe: OK. The `retry_in_seconds: 21347` observed at 18:04:11Z on
  the 26th predicted a 00:00Z reset, and the budget was indeed back — the UTC-day bucket confirmed a
  **fifth** time, now by prediction rather than observation.
- **`revalidate()` on all 9: 0 refused.** Every entry re-derived against the *current* repo and plan —
  no re-score, name still byte-exact in `PLAN_TASKS`, every Done row carrying a Completed Date equal
  to its last sha's commit date **now**, every sha still resolvable and still an ancestor of
  `origin/main`, no Done row carrying an open blocker.

### 33 SP written, not 38 — and the gap is the point

The nine entries total **38** plan SP. Only **33** were written as Actual SP, because the Tickets
notification row is `Pending Deploy` and a non-Done row gets **no Actual SP and no Completed Date**.
`correctionValues()` enforces that, so the 5 SP is not lost — it is *not yet earned*, and it stays
visible as Estimated SP on an open row. A flush that had written 38 would have been the invented
Actual SP the skill forbids.

| Row | Status | SP | Completed |
|---|---|---|---|
| Exported pay stubs name the CURRENT department | Done | 3 | 2026-08-26 |
| Tickets board notifies the requester on every update | **Pending Deploy** | — | — |
| `kpi.scored` employee notification | Done | 5 | 2026-08-17 |
| Accounting is told who logged no Hubstaff hours | Done | 5 | 2026-08-21 |
| Hubstaff exempt-department list broke on a rename | Done | 2 | 2026-08-21 |
| Pay Structure shows a department's members | Done | 5 | 2026-08-21 |
| Offboarded people drop off the Payment Catalog | Done | 5 | 2026-08-21 |
| Payroll Wizard manual validation | Done | 5 | 2026-08-21 |
| Orphanage OT pricing extracted and tested | Done | 3 | 2026-08-21 |

The held row is held on a **measured** blocker, not an asserted one: `ticket_replied` and
`ticket_moved` are absent from `webhooks.config`, so the email leg no-ops. A delay cannot close that
— only the n8n import can. Note the direction of the risk: if the import had happened overnight the
row would now be *under*-stated, which is the fail-closed side and the correct one to err on.

### Completed Dates stayed put, and one row proves why that matters

None moved to the flush day. `kpi.scored` kept **2026-08-17**, which is what filed it under
**Sprint 26** (Aug 4–17 with the gap days) while the other eight sit in Sprint 27 — verified on the
board, not assumed. Had the flush stamped 08-27, that row would have been re-filed into the wrong
sprint and inflated S27's velocity with S26's work. The lag is recorded in `flushFootnote()` on each
item update instead: queue date, original approval hash, and the delay.

### Verified by re-reading, in full

`verify-one.mts` on all nine item ids — 9 calls, chosen over `verify.mts` because the flush changed
no structure and `verify.mts` pages the whole 3,133-item board. Every one matched: status, Actual SP,
Completed Date, sprint label, group, and epic relation intact (the flush writes no relation, and the
re-read confirms it erased none). **Nine of nine, VERIFY PASS.** Ledger now reads `total 9 · unflushed 0`.

Total cost ≈ 37 calls (1 probe + 9 dry-run lookups + 18 write + 9 verify) against a budget a full
reconcile would have spent outright — which is the whole argument for the flush path.

### Still undeclared, deliberately not folded in

Three commits landed after the pass commit and are **not in `hris-plan.ts`**: `d81ffecc` Manager
Scheduling tab (UI only, no backend) plus its two follow-ups `23c45325` and `850fdf22`. Clustered by
file overlap they are one row, not three. They are **out of scope for a flush** — the ledger is only
for corrections to rows that already exist, and queueing a new row produces a guaranteed refusal.
They need a `review.mts` pass and their own approval hash.

## Pass 17 — 2026-08-27 · the auditor declares itself · 2 rows, 8 SP, VERIFY PASS

Kane: *"add this skill to our Monday board."* HRIS-15 already carried a 3-SP Chore row for every
board-sync **pass** and one for the approval-gate fix — but the machine those sixteen passes all ran
through had **no row**. Sixteen passes credited; the tooling uncredited.

Found while flagging undeclared work at the end of the same morning's flush. That is worth naming:
the last three passes each found undeclared work in the **product**, and this one found it in the
**auditor**. Nothing in the skill checks whether the skill is on the board.

### Two rows, clustered on file overlap and not on the commit stream

Sixteen days and 33 commits separate them, which would tempt a single "the skill" row. `520a7755` and
`7e39a599` share almost no files, and the second adds a module the first deliberately did not have —
so they are two.

| Row | SP | Sprint | Completed | Evidence |
|---|---|---|---|---|
| The Monday board gets a writer that cannot lie | 5 | S26 | 2026-08-11 | `520a7755` — 15 files, 1,837 insertions |
| A dead API budget owes the SP instead of losing it | 3 | S27 | 2026-08-21 | `7e39a599` — 8 files, 634 insertions |

**Scoring, against neighbours rather than line count.** The build is the exact peer of the 5-SP
Payroll Wizard manual-validation row (13 files, ~1,750 lines, a new route plus a tested module).
**Not 8** — all seven 8-SP rows on this board move a rate, a dispatch row or a score component, and
this moves none; it is dev tooling. **Not 3** — the existing board-sync Chore rows at 3 SP are single
passes, and this is what they run on. The ledger is 3: two modules and a hook, no new surface, no
money path, but the seven refusal conditions are the substance and a deferred write with no gate is
worse than a lost one.

### Done, without pretending the gate maps

Neither row closes on an assertion, and neither claims a click-through. This is tooling with **no
deployed surface**, so the honesty gate's "deployed and clicked through in prod" does not apply — and
saying so is better than stretching it. What replaces it is stronger in both cases:

- the **build** has had sixteen passes run through it against the live board, results confirmed by
  re-read rather than by write log;
- the **ledger** was exercised in production *that same morning* — 9 owed rows, 33 SP, 0 refused,
  9/9 confirmed by re-read.

Completed Dates are the shas' commit dates, **not** the declaration day, which is what files the
build in S26 and the ledger in S27 — the sprints the work actually finished in. Declaring work late
does not re-date it.

### A slice bug nearly deleted a live row, and the numstat caught it

Staging the plan entries, a Python splice used `old[:-2].rstrip('\n')[:-0]`. **`-0 == 0`, so `[:-0]`
is `[:0]` — the empty string**, and the replacement silently dropped the preceding
`Exported pay stubs name the CURRENT department` plan row. That row is **live on the board**
(`12904913559`, Done, 3 SP, written by the flush hours earlier); item names are set at CREATE only,
so a plan row that vanishes orphans its board row permanently and name parity breaks in the
board→plan direction.

Caught by `git diff --numstat` on the edited file: the expected shape of a pure addition is
`N 0`, and any non-zero deletion count on a plan edit means a row was lost. After the restore:
**36 insertions, 0 deletions**. `review.mts` then independently confirmed it — *orphan rows on the
board, not in the plan: 0*.

**Carry this:** after any scripted edit to `hris-plan.ts`, assert `git diff --numstat` shows **zero
deletions** unless a deletion was the intent. The plan is append-mostly, and the reconciler cannot
tell a dropped row from a row that never existed.

### The full path, chosen deliberately

`--only-new` would have been ~6 calls against ~200. It writes **no relation**, so both rows would
have landed unlinked from HRIS-15 and `verify.mts` fails on exactly that — the trade that cost pass
13 two applies. With ~37 calls spent on the morning flush and the budget otherwise intact, the full
reconcile was the cheaper end state.

Applied on `f26aa6b3ebf4` (source verified `dc5b7adfe7ae`): 2 created, 37 epics + 208 tasks patched,
2 corrections. **`verify.mts`: VERIFY PASS** — 210/210 name parity, 0 orphans, 0 rows over the 8-SP
cap, 0 blank Estimated SP, 0 phantom Actual SP, 0 Done rows without a date, relation 210 of 210.

The rollup did **not** move (Total 1569, Completed 874) and that is correct, not a miss: Epic SP here
is an independent rollup, not a sum of children, so adding two task rows under an already-Shipped
HRIS-15 changes neither figure.

### Still undeclared after this pass

`blueprint` and `hardening` (both `2026-08-10`, referenced only in plan **comments**), and the
Manager Scheduling tab (`d81ffecc` + `23c45325` + `850fdf22`, one row by file overlap). Same class of
gap, left out because the ask was singular and deictic. Recorded here so the next pass does not have
to rediscover them.

## Pass 18 — 2026-08-28 · the undeclared fortnight · 10 rows, 45 SP, VERIFY PASS

Kane: *"Update our Monday board with all our withheld and Undeclared SP right now!"* — then, mid-pass,
the instruction that changed the result: *"check previous claude sessions it has data also make sure
git commits."*

### Reading the transcripts alongside the commits found a row the commits alone could not

The last three passes each clustered on file overlap and each caught a lying commit message. This one
caught a commit whose message was not merely wrong but **actively empty of its own contents**:
`cd681cf8` is titled **"Offboarded"** and contains **no offboarding code at all**. It carries the MESA
rebuild *and* — swept up from a different session hours earlier — the View Paystub accounting rail.

File overlap alone would have flagged the mixture; the **session transcript for `1eb1435a` named the
work**, which is what made the split confident rather than a guess. Two rows, 8 SP and 2 SP, out of one
commit. A message-clustered pass files one row there and silently loses 2 SP.

**Carry this:** the commit stream is the evidence, but `~/.claude/projects/<project>/*.jsonl` is the
*intent*. When a commit's file list is wider than its message, the transcript for that day says which
session wrote what. It is the only source that distinguishes "one feature, badly described" from "two
features, one commit".

### Ten rows, clustered on file overlap

| Row | Epic | SP | Sprint | Completed | Evidence |
|---|---|---|---|---|---|
| Manager Scheduling tab — UI first, no backend | HRIS-10 | 5 | S27 | 2026-08-26 | `d81ffecc`+`23c45325`+`850fdf22` |
| View Paystub accounting rail — log right, MV vouch joins it | HRIS-03a | 2 | S27 | 2026-08-28 | `cd681cf8` (half) |
| Second approver = the request's own team, derived seat | HRIS-04 | 5 | S27 | 2026-08-27 | `a9901284` |
| Every PAB calendar reads Sun–Sat, week model required | HRIS-02b | 5 | S27 | 2026-08-27 | `a73948a1` |
| Kolan's plated card takes the dark lockup | HRIS-03a | 2 | S27 | 2026-08-28 | `c229a2b8` |
| Offboarded is ONE tab, origin stored, backfill insert-only | HRIS-01a | 5 | S27 | 2026-08-28 | `a366c067` |
| Wizard: HSL + Additions one step, rail renumbered 1–8 | HRIS-02a | 5 | S27 | 2026-08-28 | `9a42f5f2`…`4b8f7177` |
| A signature can be TYPED, and the pointer lands on the ink | HRIS-18 | 5 | S27 | 2026-08-28 | `3fb27b1d` |
| MESA rebuilt from the CSV + disbursement guard | HRIS-07 | 8 | S27 | 2026-08-28 | `cd681cf8` (half) |
| `blueprint` + `hardening` — the two skills CLAUDE.md routes through | HRIS-15 | 3 | S26 | 2026-08-10 | `5120398d`…`606cd61e` |

Two clusters merge four shas into one row each, because **a row describes the current rule, not the
iterations that reached it**: the four wizard commits are all `PayrollWizard.tsx` plus wizard docs, and
the three Aug-10 skill commits all touch `CLAUDE.md` and `INDEX.md` — blueprint and hardening are a
single governing rule ("new → blueprint, existing → hardening") that only makes sense whole.

### The Done gate was asked, not assumed — and the difference from 08-26 is measurable

Asked which of the nine product rows he had looked at in production, Kane answered **"All nine — I've
tested everything."** Recorded on every row as the basis.

That blanket was applied to **all nine here**, where on 2026-08-26 the same blanket was deliberately
**not** applied to the Tickets row. The distinction is not judgement, it is measurement: **every
migration these rows depend on was probed APPLIED first**, with a passing negative control.

- `2026-08-28_offboarded_sheet_origin.sql` — `offboarded_sheet.origin` exists, **492 `hris` / 3,519
  `google_sheet`, 4,011 rows**, which is the pre-import 3,846 plus the 165 the backfill inserted. Both
  the migration *and* the backfill have run.
- `2026-08-27_mesa_receipt_shortfall_and_payouts.sql` — `amount_php` and `mesa_payroll_obligations`
  both present, `mesa_ledger` **9,883**, `mesa_accounts` **280**, matching the independent verify
  script exactly.

Probed **without `head: true`**, per the trap that made the old auditor report missing tables as
APPLIED. The negative control (a table and a column that cannot exist) reported both missing before
any real probe was believed.

### The withheld side: the ledger owes nothing, and one row is still correctly held

`pending-sp.json` reads **9 entries / 0 unflushed** — the 08-27 flush cleared all 33 SP. Nothing is
withheld there, and this pass queued nothing new (the apply finished without a budget death).

**The one genuinely withheld row stays withheld.** Tickets board notifications, 5 SP, Pending Deploy.
Re-measured today against the live `webhooks.config`: **22 slugs configured, `ticket_created` /
`ticket_assigned` / `ticket_done` all present and active, `ticket_replied` and `ticket_moved`
ABSENT.** The email leg still no-ops. A delay cannot close that — only the n8n import can, and an
assertion cannot import a workflow. Note the direction of the risk: it is the fail-closed side.

### Applied and verified

Applied on `74130e0cdeed` (source verified `846d3912d95b`) via the **full path** — 10 rows needing
epic relations, and `--only-new` writes none. 10 created, 37 epics + 210 tasks patched, 10 corrections.

Verified in two stages, cheapest first, per the budget rule: **`verify-one.mts` on all ten ids**
(10 calls) confirmed status, both SP columns, Completed Date, sprint label, group and epic relation on
every row — *then* the full `verify.mts`. **VERIFY PASS**: 220/220 name parity, 0 orphans, 0 over the
8-SP cap, 0 blank Estimated SP, 0 phantom Actual SP, 0 Done rows without a date, relation 220 of 220.

The plan edit went in at **157 insertions, 0 deletions** — the numstat guard from pass 17 — and
`review.mts` independently confirmed *orphans: 0*.

**The rollup did not move (Total 1569 / Completed 874) and that is correct**, not a miss: Epic SP is an
independent rollup, not a sum of children. The 45 SP lands as Actual SP on the rows and in the
sprints' velocity — **42 SP in Sprint 27, 3 SP in Sprint 26**.

### Still undeclared after this pass — deliberately

Two bodies of work are **in flight, not shipped**, and neither gets a row:

- **Payroll Wizard step "PAB"** (session `55e68129`) — a blueprint brief exists, revised twice against
  adversarial passes, but **no code**. A brief is not a commit.
- **Scheduling on the Admin dashboard** (session `fef33e68`) — went through blueprint into a discovery
  conversation with Carla about rest-day rotation and produced a *correction* (HSL overnight PAB is
  already handled, and better than the ticket asked), not a build.

Also unlogged, and not a board matter: **no session-log audit exists for 08-27 or 08-28**. The last is
`audit-2026-08-26-session-log.md`. Two days of sessions are undocumented.

## Cross-links

`docs/features/INDEX.md` · memory `monday-hris-board-sync` · pass evidence
`docs/audits/2026-08-11-monday-board-pass.csv` · plan
`docs/superpowers/plans/2026-08-11-monday-board-sync-skill.md`
