# HRIS V1 close-out: the Monday board as CSV + the project SP

Kane, 2026-10-09: *"We are packaging HRIS for monday I want you to create a CSV for all the pushed data
in monday and how many SP we have worked on this project and that. we can mark this v1 as done"*.
Session `85af82ec`, `blueprint`. The Monday budget is dead until 00:00 UTC, so everything here is
offline. A `--board` mode re-reads the live board after tonight's pass 44 apply.

## Tasks

- [ ] **1. Rollup module.** `src/lib/monday/project-sp.ts` is item 340's additive method as one pure
  function, and `project-sp.test.ts` covers it with `node:test`. Total = Σ per epic of
  max(forecast, pre-Aug-4 child SP) + post-Aug-4 child SP. Uncovered = for each non-Shipped epic,
  max(0, forecast − all child SP). Completed = Total − open task SP − uncovered. It also takes an
  `asShipped` list, so it can answer "if these epics were Shipped".
- [ ] **2. Reproduce the approved figures.** The module must give 3,289 / 2,999 on the 10-08 plan
  (`f0eac591`). The scratch instrument had drifted to "forecast − pre-Aug-4 children" (485 uncovered,
  not 150), so it is not a reference.
- [ ] **3. Pass 44 grows by the 10 commits pushed 10-09.** These go into `hris-plan.ts` and `pass.mts`
  as 5 rows / 30 SP, all Done, Sprint 30:
  - Keys: done on measured use.
  - Scheduled Posts, History, the database signal and the wordmark: done on Kane's "V1 done".
  Run `selfcheck`.
- [ ] **4. Exporter.** `.claude/skills/monday-board-sync/scripts/export-board-csv.mts` has two modes.
  - **Offline (default):** reads PLAN_EPICS + PLAN_TASKS. Status, Completed Date and evidence come from
    every historical `pass.mts` version in git, and the 10-02 paste TSVs fill gaps. Every row is
    labelled with its source.
  - **`--board`:** reads our epics and tasks off the live board (`listBoardItems`, about 15 calls). It
    writes board values and lists every plan-vs-board difference.
  - **Output:** one rows CSV (epics + tasks, a Kind column, Code and Title separate) and one summary
    CSV (by sprint, by epic, project rollup, open rows). Both get a UTF-8 BOM.
- [ ] **5. Run offline.** Write the two files under `docs/audits/`.
- [ ] **6. Tonight's cron.** The shape becomes 23 created / 30 corrected, then the mover, then the
  read-back, then `export-board-csv.mts --board`.
- [ ] **7. Docs.** `docs/features/hris-v1-closeout.md`, its INDEX row, memory `hris-v1-closeout`, and
  Open items (item 340's CONFLICT stays open; the epic flip is proposed). One commit, explicit paths.

## Not in this plan

- The Projects Portfolio row (item 340 CONFLICT, Kane's (a)/(b)).
- Moving the 11 In Progress epics to Shipped. That needs a new writer and Kane's go on the shape.
