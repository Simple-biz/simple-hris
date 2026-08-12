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

## API budget

The account has a **daily** complexity budget. Exceeding it returns `429 DAILY_LIMIT_EXCEEDED` and
nothing succeeds until reset — **including read-only verification**. Budget the verify, not just the
write. Ask only for the columns you read: pulling all ~21 columns across 2,172 items is the most
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
- **PENDING (Kane, by 2026-08-15):** there is no **Sprint 27** label or group, and the API cannot
  create one. Add both on the board, then add the key to `TASK_GROUPS`, `TASK_SPRINT_INDEX` and
  `TASK_SPRINT_LABELS`. Until then the skill hard-stops rather than dumping new work into Backlog.
- **Known drift:** HRIS-22 is `Cancelled` on the board but `Shipped` in `hris-plan.ts`. The reconciler
  writes epic Status at create only, so the board wins and this drifts until one side is corrected by
  hand. It currently withholds 12 SP from SP Completed.
- **Known gap:** 74 pre-existing Done rows have no Completed Date — HRIS never wrote the column before
  this skill. If backfilling, refuse to write a date inside the live sprint so a historical backfill
  can never read as a fresh claim.
- Nine epics carry 220 SP with zero task rows (HRIS-01, 16, 17, 22, 23, 25, 29, 31, 32).

## Cross-links

`docs/features/INDEX.md` · memory `monday-hris-board-sync` · pass evidence
`docs/audits/2026-08-11-monday-board-pass.csv` · plan
`docs/superpowers/plans/2026-08-11-monday-board-sync-skill.md`
