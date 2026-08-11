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
reversed by a later commit — so one row must describe the current rule, not both.

### 3. Estimate
Fibonacci only (1, 2, 3, 5, 8), per dev-resources.simple.biz/story-points. Calibrate against
**current-sprint neighbours** — the Sprint 26 rows run 1–5, averaging ~3.5 — never against the bulk
import epics, which were scored at whole-feature granularity. Over 8 becomes an epic on Roadmap &
Epics with child tasks.

**Do not port Gridline's children-sum-to-parent rule.** HRIS Epic SP is an independent rollup of
sub-features: HRIS-01 is 101 SP with zero task rows. Asserting the sum would fail on almost every epic.

### 4. Review — and stop
`review.mts` is read-only. It prints what would be created, patched and corrected, each row's
proposed status with its proof and its blockers, and the rollup. It writes `proposal.json` and an
**approval hash**.

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

- **Budget the verify, not just the write.** A write you cannot verify is not done.
- Ask only for the columns you read — `column_values(ids: [...])`. Pulling all ~21 columns across
  2,172 items is the most expensive thing these scripts can do.
- A full `apply.mts` is ~200 calls: the reconciler patches all 135 tasks and 37 epics every run.
  That is the honest cost of driving the app path. Do not run it repeatedly to poke at one row.
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
- **There is no Sprint 27 label or group**, and the API cannot create one. When Sprint 26 ends
  (Aug 15), someone adds it on the board by hand and mirrors it into `TASK_SPRINT_LABELS`. Until then,
  **hard-stop** rather than silently dumping new work into Backlog.
- **Never `git push`.** Kane handles every push.

## Known drift

- **HRIS-22** "Hubstaff Live API Integration" is `Cancelled` on the board but `Shipped` in
  `hris-plan.ts`. The reconciler never overwrites board status, so this drifts until one side is
  corrected. It currently costs 12 SP of SP Completed.
- **Nine epics carry 220 SP with zero task rows** (HRIS-01, 16, 17, 22, 23, 25, 29, 31, 32).
- **74 pre-existing Done rows have no Completed Date** — HRIS never wrote the column before this
  skill. Backfilling is a separate pass; if you do it, refuse to write a date inside the live sprint
  so a historical backfill can never read as a fresh claim.
- **`MONDAY` is still unset in Vercel**, so the in-app button 502s in production. This skill is
  unaffected — it reads `.env` locally.
