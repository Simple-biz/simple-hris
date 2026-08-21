# Payment Catalog → Pay Structure — department members + a retractable HSL group

Requested by Kane 2026-08-21: *"We should be able to see all the members for that
department in here"*, then *"I want the Hogan Smith Law to be a drop down where when
toggled we can see the Sub departments below it"*, then — after spotting it live —
*"'Baldonebro' has a subdepartment of her own so she shouldnt have appeared under
hogan smith law as she is a case manager already"*.

Today the tab shows a department's base rate plus **only** the people who already have
an individual pay structure. There is no way to see who is actually in the department,
and the rail is a flat list of 34 entries in which the 16 `hsl:*` sub-teams sit as
siblings of their own parent.

Blueprint brief approved 2026-08-21, all four questions answered:

- **Q1** the member list is **read-only**; each row's "Set rate" opens the editor the
  tab already has. No new write path, so the documented clobber trap (confirming a
  department base into an individual override that silently beats a sheet rate) gains
  no new doorway.
- **Q2** the 61 people whose department label resolves to no rail entry get a
  **"No department"** entry at the foot of the rail — mirroring the People rail-mix
  band's own bucket, because a filter never hides a row. Measured: USEE 26, Site
  Building (US - Freelance) 20, Site Building (PH - Freelancer) 13, Orphan Ministry 1,
  Manager 1.
- **Q3** **Hogan Smith Law becomes a retractable group.** The 16 `hsl:*` entries nest
  under it and are revealed by toggling. The same treatment covers the custom-registry
  `<parent>:<sub>` family, which already existed in the same rail.
- **Q4** the 65 individual structures filed under `hogan_smith_law` whose owner is
  really on a sub-team are re-homed by **DISPLAY ONLY**. No DB rewrite: display-only
  self-heals on every transfer, whereas a script has to be re-run after each one. Rows
  belonging to the 50 people no longer on the roster stay visible under the parent so
  nothing disappears.

## What was measured first (all read-only, production)

- `active_employees` = 1,287 people; **565** are HSL-family and **all 565 are placed**
  on one of the 16 sub-teams. **Zero** people on the live roster lack a sub-department.
  Verified with a negative control: the probe fires on 10 synthetic bare-`HSL` shapes.
- The 108 bare-`HSL` rows are `global_master_list` only — 69 off-boarded, 39 not, and
  **none on the active roster**. So the memory line *"39 active rows are back on plain
  HSL"* is wrong and gets corrected in this commit. Of the 39: 13 transferred out, 3
  are stale duplicates of placed people, 21 are off the roster with no off-board stamp,
  and **2 are working right now while invisible to every roster surface**
  (`lawangc@`, `shainan@`).
- The `hogan_smith_law` rail entry lists **124** individual structures: **65** belong to
  people placed on an `hsl:*` sub-team, **9** to people now in a non-HSL department,
  **50** to people not on the live roster. Baldonebro is a split identity —
  `joy@hogansmith.com` filed correctly under `hsl:case_managers`, plus a stale
  `joyb@simple.biz` row under the parent at the same ₱305/₱457.50.
- Cause: `normalizeDeptToKey` collapses every `hsl:*` cell to `hogan_smith_law`, and
  that is the key the Search person card writes under. **No money is affected** —
  `buildCatalogRateIndex` indexes employee structures `byEmail` and never reads
  `departmentKey` (`resolve-rate.ts:70-80`, `:119`).
- All 16 sub-teams have a dept-scope rate (₱175–₱500); the parent has **none** (deleted
  in the Aug-14 cutover), so a "Hogan Smith Law" header must not imply a base rate.

## Tasks

- [ ] 1. `src/lib/payment-catalog/dept-rail.ts` — pure, no I/O, client-safe.
      - `RAIL_NO_DEPARTMENT_KEY` sentinel for the Q2 bucket.
      - `parentOfDeptKey(key, customParents)` — a **declared** parent map, never a
        split-on-colon: the HSL children are `hsl:<sub>` while their parent is
        `hogan_smith_law` (the prefix is NOT the parent key), whereas custom registry
        subs are `<parentKey>:<subKey>` where it is. One function so the two families
        cannot diverge.
      - `buildDeptRail(entries, customParents)` → ordered groups `{ parent, children }`.
      - `deptMembersOf(roster, entry)` — lifted verbatim from `IndividualPayAdder`'s
        `deptMatched`, which already handles built-in / custom / namespaced cells.
      - `assignRosterToRail(roster, rail)` — every person to exactly ONE entry
        (most-specific wins: a sub-team beats its parent), leftovers to
        `RAIL_NO_DEPARTMENT_KEY`. This is what stops the parent claiming 565 people.
      - `rollUpCounts(counts, rail)` — a collapsed parent shows its own + children's.
- [ ] 2. `src/lib/payment-catalog/dept-rail.test.ts` — node:test. Pin: the HSL prefix
      ≠ parent key trap; a person lands in exactly one entry; a sub-team person is NOT
      in the parent; bare `HSL` falls to the parent (not "No department"); the 61
      unresolvable people reach the sentinel; count rollup; custom `<parent>:<sub>`
      nests the same way.
- [ ] 3. `BonusCatalog.tsx` — hoist `compIndexes` out of `SearchTab` to the parent so
      both tabs share one index; thread `hourlyRates` + `compIndexes` into
      `PayStructureTab`.
- [ ] 4. `BonusCatalog.tsx` — the rail becomes grouped: parent row carries a chevron
      (toggle) and a label (select) as two hit targets, `aria-expanded`, children in the
      file's existing `Expand` wrapper on the file's existing `EASE`. A group
      auto-opens when one of its children is selected, and when `deptSearch` matches a
      child — otherwise a child-only match would vanish behind a closed parent.
- [ ] 5. `BonusCatalog.tsx` — the member table under "Individual pay structure":
      read-only rows via `computePersonComp` + `winningRate` (individual / sheet /
      dept / none, same chip vocabulary as the Search tab), each with a "Set rate"
      button that opens the editor already on the tab.
- [ ] 6. `BonusCatalog.tsx` — `individualForDept` selects by the person's CURRENT
      placement, falling back to the stored `departmentKey` when they are off-roster.
      This is the Baldonebro fix and it is display-only; `onUpsert` still writes
      `departmentKey: selectedDept`.
- [ ] 7. `npm run lint` (= `tsc --noEmit`) and `npm test`. Check for a running
      `next dev` before any build — it shares `.next/`.
- [ ] 8. Docs in the same commit: `bonus-catalog.md` §5 section, `INDEX.md` row 21,
      memory `pay-structure-department-members` + `MEMORY.md` pointer, and the
      correction to `hsl-subdept-restructure`'s stale "39 active rows" line.

## Not in scope

Every write path (`onUpsert`, `PayRateEditor`, `IndividualPayAdder` all keep filing
under `selectedDept`), `resolve-rate.ts`, any DB rewrite of `departmentKey`, and the
Search / Assignments / Department / Summary tabs.
