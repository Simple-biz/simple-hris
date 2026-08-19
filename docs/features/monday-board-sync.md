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

## Rate limits: 429 is a WINDOW, not a pause

`sync.ts` has its own `gql` (separate from the skill's `monday.mts`). It used to back off
`1200ms * attempt` over 4 attempts — about 12s total — but **Monday's rate-limit window is a full
minute**, so all four attempts fell inside one window and it threw. A ~200-call reconcile died
mid-structure this way on 2026-08-19, leaving the board half-patched.

Fixed: a **429** now honours `retry-after` when present and otherwise waits the minute out, over 6
attempts; **5xx and network faults keep the short backoff** because those are genuinely transient. A
partial reconcile is *incomplete, never wrong* — the reconciler writes desired state and is idempotent,
so re-running completes it.

## Cross-links

`docs/features/INDEX.md` · memory `monday-hris-board-sync` · pass evidence
`docs/audits/2026-08-11-monday-board-pass.csv` · plan
`docs/superpowers/plans/2026-08-11-monday-board-sync-skill.md`
