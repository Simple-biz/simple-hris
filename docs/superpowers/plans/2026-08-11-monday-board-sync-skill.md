# Monday board sync skill — implementation plan (2026-08-11)

Install `.claude/skills/monday-board-sync/`, rewritten from the Gridline skill for HRIS.

**Architecture decision (option A + status-only corrector).** The repo already syncs to this board
from inside the app: `src/lib/monday/hris-plan.ts` is the declared plan, `src/lib/monday/sync.ts`
the reconciler, `POST/GET /api/admin/monday-sync` the route. The reconciler matches items **by exact
name**, so any row created by a second tool with a non-identical name is recreated forever. Therefore:

- `hris-plan.ts` owns **existence + structure**. Written only by the real reconciler.
- The skill's corrector owns **execution state** (Status, Actual SP, Completed Date, item updates).
  It never creates an item, never writes a relation, and never touches the Projects Portfolio board.

The boundary is the one `sync.ts:5-10` already declares. It is mechanically checkable: the corrector
imports the same `TASK_COLS` object and asserts its write set is disjoint from the reconciler's.

Scripts are `.mts` (not Python, unlike Gridline) so they can **import the board IDs** from
`hris-plan.ts` instead of duplicating them. Precedent: `scripts/verify-readiness.mts`.

## Tasks

- [x] 1. `src/lib/monday/hris-plan.ts` — additive constants only
  - [x] `TASK_COLS.completed = 'date_mm5qj7vm'` (column exists; HRIS has never written it)
  - [x] `TASK_STATUS_INDEX` full map: Ready to Start 0, In Progress 1, Waiting for Review 2,
        Pending Deploy 3, Done 4 (keep `TASK_STATUS_DONE`/`TASK_STATUS_READY` for sync.ts)
  - [x] `EpicStatus` += `'Cancelled'`, `EPIC_STATUS_INDEX.Cancelled = 3`
  - [x] `TaskType` += `'n8n Workflow'` (3), `'PR Review'` (7) — both exist as live labels
  - [x] `TASK_SPRINT_LABELS` — the live label text per sprint key, so a pass can assert the board's
        label set still matches before writing
  - [x] fix the `sp: number; // < 8 by definition` comment → over-8 is an epic, 8 SP is a legal task
- [x] 2. `.claude/skills/monday-board-sync/scripts/monday.mts` — shared lib. Retrying `gql`,
      `DailyLimitExceeded` fast-fail, paged board reads, `items(ids:)` batched ≤25, board-relation
      handling via `linked_item_ids`, `.env` loader, proposal hashing, local lockfile.
- [x] 3. `scripts/pull-state.mts` — read-only. Dumps HRIS rows only. Re-queries `groups{id title}`
      every run and asserts live labels match the constants.
- [x] 4. `scripts/sprint-evidence.mts` — read-only git evidence: commit range, per-commit file lists,
      `merge-base --is-ancestor origin/main` per sha, new `.sql` / `apply-*.mjs` / n8n slug detection.
- [x] 5. ~~`scripts/audit-board.mts`~~ — **folded into `verify.mts`.** Its sections 2–4 (name parity
      both directions, the invariant sweep, the rollup check) read the board independently of the
      pass, so with an empty `ROWS` it already *is* the standalone audit. A second script would have
      duplicated the queries and doubled the cost of the most expensive read in the skill.
- [x] 6. `scripts/pass.mts` — the per-pass data file + `selfcheck()`.
- [x] 7. `scripts/review.mts` — the review Kane sees; writes `proposal.json` + prints approval hash.
- [x] 8. `scripts/apply.mts` — the ONLY writer. `--apply --approve <hash>`.
- [x] 9. `scripts/verify.mts` — re-read verification, never off the write log.
- [x] 10. `SKILL.md` — honesty gate, review-then-approve protocol, budget, traps.
- [x] 11. `docs/features/monday-board-sync.md` + `docs/features/INDEX.md` row + memory update.
- [x] 12. Typecheck (`tsc --noEmit`). **A dev server is running — do not run `next build`.**

## Invariants that must survive

1. **Done means shipped and shipped means proven.** Never invent an Actual SP.
2. `done: true` in `hris-plan.ts` is a claim of shipped-and-proven, nothing else. Pending Deploy /
   Waiting for Review / In Progress are written by the corrector, so an unproven row gets no Actual SP.
   This is why `sync.ts` needs no edit.
3. **Over 8 SP is an epic**, not a task (Abby's company rule). 8 SP is a legal task. Children of a
   split do **not** have to sum to the parent — HRIS epic SP is an independent rollup (HRIS-01 is
   101 SP with zero task rows), so Gridline's sum-to-parent check is deliberately NOT ported.
4. `create_labels_if_missing: false` always. The board is structure-locked; `true` 403s.
5. Never write to Monday without a message of approval from Kane, bound to a proposal hash.
6. Never `git push`.

## Traps (verified against the live board 2026-08-11)

- Projects Portfolio `color_mm4mfemh` Status is **not** create-only — `sync.ts:313` rewrites it every
  pass. The corrector must exclude board `18419115953` entirely.
- `board_relation_mm4mhvs2` (Linked Tasks) and `board_relation_mm4mwppe` (Sprint Tasks) are full-set
  overwrites, never additive. Anything the corrector links there is erased next sync.
- `report.tasksCreated` holds the **unprefixed** `task.name` (`sync.ts:250`), not board names or ids.
  `apply.mts` must re-read the board after the structure pass to resolve names → ids.
- Item names are set only at create. Renaming a plan title creates a NEW row and orphans the old one
  with its execution state intact → name parity must be an audit invariant in both directions.
- Names carry load-bearing non-ASCII: em-dashes, curly quotes, `₱`, `→`, `⊕`, `⇄`, `≈`, `×`, and one
  en-dash inside "Sun–Sat". Never normalise. Monday strips `<tags>` — never put angle brackets in a name.
- `items(ids:)` silently caps at 25. Board relations return empty `text` — use `linked_item_ids`.
- No Sprint 27 label or group exists and the API cannot create one (structure-locked).

## Known drift recorded, not fixed here

- HRIS-22 is `Cancelled` on the board, `Shipped` in the plan. Awaiting Kane's call on which wins.
- The project item's Sprint Tasks relation holds 77 of 123 tasks; Total SP 1556 vs plan 1569;
  SP Completed 873 vs 874. One reconciler run fixes all three.
- 9 shipped epics carry 220 SP with zero task rows.
- `MONDAY` is still unset in Vercel, so the in-app button 502s in production. The skill is unaffected
  because it reads `.env` locally.
