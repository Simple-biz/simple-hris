# HRIS V1 close-out — every HRIS row on the Monday board as CSV, and the project's SP

HRIS V1 was packaged on 2026-10-09. Kane: *"We are packaging HRIS for monday I want you to create a
CSV for all the pushed data in monday and how many SP we have worked on this project and that. we can
mark this v1 as done"*. Two read-only files under `docs/audits/` record it:
- **the rows file:** all 37 epics and every `[HRIS]` task row.
- **the summary:** the project's Total and Completed SP, by sprint, by epic, and the open rows.

`export-board-csv.mts` writes both. On the 10-08 call Kane said "pretty much the MVP is done", with
**V1 = the current project SP** (session log item 427). Session `85af82ec`, built with `blueprint`.

## Key files

| Piece | File |
| --- | --- |
| Exporter (offline default, `--board` live) | `.claude/skills/monday-board-sync/scripts/export-board-csv.mts` |
| The SP method, pure + tested | `src/lib/monday/project-sp.ts` · `project-sp.test.ts` |
| The V1 files | `docs/audits/2026-10-09-hris-v1-monday-board.csv` · `docs/audits/2026-10-09-hris-v1-sp-summary.csv` |
| The pass that puts V1's last rows on the board | `scripts/pass.mts` pass 44 · `src/lib/monday/hris-plan.ts` |
| Plan | `docs/superpowers/plans/2026-10-09-hris-v1-closeout.md` |

## The SP figures, and the one definition that makes them

`projectSp()` is session log item 340's **additive** method. Kane approved it as the project figure on
2026-10-08 (*"yep"*, answering item 154 (a)). Per epic:

- **Total** = max(epic forecast, child SP filed before Sprint 26) + child SP filed from Sprint 26 on.
  Backlog counts as post-Aug-4.
- **Uncovered** applies to an epic that is not Shipped: max(0, forecast − **all** child SP).
- **Completed** = Total − open task SP − uncovered.

**Uncovered is measured against ALL children, not only the pre-Sprint-26 ones.** That definition
reproduces item 340's recorded 3,289 / 2,999 on the 10-08 plan (`f0eac591`) exactly. A scratch copy of
the instrument had drifted to "forecast − pre-Sprint-26 children" and reported 485 uncovered instead of
150. If the number moves by hundreds, check that definition first.

**V1, as filed 2026-10-09 (plan + pass 44 counted as applied):**

| | SP |
| --- | --- |
| Total Project SP | **3,329** (Σ epic forecast 1,569 + 1,760 SP of task rows since Aug 4) |
| SP Completed, as recorded | **3,165** (− 14 open task SP − 150 uncovered forecast) |
| SP Completed if the 11 In Progress epics are marked Shipped | **3,315** |
| Task rows | 559 rows / 2,151 SP · 555 Done / 2,137 SP · 4 open / 14 SP |

**Not V1 done (the 4 open rows):**
- Tickets emails (5, S30, webhooks inactive).
- The legacy rates-sheet spike (2, S30, not started).
- HSL scheduling (5, Backlog, V2 by Kane's ruling).
- The bare `hsl` overrides (2, Backlog, a money ruling).

**This is not the Projects Portfolio number.** `sync.ts` rolls up Σ epic forecast (1,569) and Σ Shipped
forecast. Showing item 340's figure there is item 154's formula change, and writing the portfolio row is
the open CONFLICT at item 340. Neither is done here.

## Where each row's values come from

Every row carries a **Source** column.
- **Offline:** existence comes from the plan. Status, Completed Date and commits come from the repo's
  own record: every historical `pass.mts` version in git, then the 2026-10-02 hand-paste TSVs. A row
  the current pass names is labelled `pass <date> (written when applied)`.
- **`--board`:** reads the live board and takes status, SP, sprint and date from it. It lists every
  plan-vs-board difference in the **Plan vs board** column, including duplicates, rows on the board but
  not in the plan, and Done with no date.

**A blank Completed Date in the offline file is not missing work.** 92 Done rows have no date the repo
can show: 63 were Done at create and 29 were closed through pass 38b and pass 39's hand entries. The
board has had a date on every Done row since 2026-08-20. Only `--board` fills them, and the live board is
the record.

Completed Date and Actual SP are written **only** for Done rows (`export-csv.mts:9-10`). HRIS-22 is
`Shipped` in the plan and `Cancelled` on the board (`SKILL.md:397`). The offline file notes the drift;
the rollup uses the plan, as item 340 did.

## Never import these files into Monday

The importer may normalise a character, and the reconciler matches names byte-exact. An altered name
becomes a duplicate row forever (`export-csv.mts:13`). Rows reach the board through `apply.mts` only.
The files are a record for people, not an input.

## What "mark V1 as done" did, and did not, do

- **Done:**
  - Every V1 task row goes Done in pass 44 (53 rows, applied after the 2026-10-10 00:00 UTC reset).
    That includes the 10 commits pushed on 10-09: Keys on measured use, and the rest on Kane's
    V1 word.
  - The 4 open rows are named as not done.
  - This record exists.
- **Proposed, not built:** moving the 11 In Progress epics to Shipped. That adds +150 SP of forecast to
  Completed. It needs a new epic-status writer (the corrector writes task columns only, and the
  reconciler writes epic status at create only), and the skill's rule is that Kane sees the shape first.
- **Not done:** the Projects Portfolio row. That is the item 340 CONFLICT: INDEX:97 says the skill never
  writes that board, and Kane's (a)/(b) is still owed.

## Deploy notes

**No migration. No database access.** Offline mode makes no network call. `--board` costs about
15 Monday calls (`listBoardItems`, 250 items per page).

**PENDING:** `export-board-csv.mts --board` after pass 44's apply. That run makes the V1 files board-true.
It is in the session cron for 2026-10-09 20:07 EDT (08:07 PHT), which runs only if the session is open.
Otherwise run it by hand after the apply. It overwrites the two dated files, and git keeps the offline
version.
