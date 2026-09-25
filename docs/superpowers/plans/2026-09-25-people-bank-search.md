# People → Search Bar (bank lookup) — plan

Approved 2026-09-25 (Kane: *"name and work email then we can see their bank details when we view
it similar from payment catalog"*, then *"RECOMENDATIONS PLEASE"* for Q3–Q5). A fifth People tab,
styled like Payment Catalog → Search: find someone by **name or work email**, then View opens an
**inline** bank page rather than a popup.

Decisions taken with the approval:
- **Q1:** it matches name and work email only. Personal and alternate emails, the ID and the
  department are deliberately not matched, so no roster data changes.
- **Q2:** View is an inline page, as in the catalog. The popup's read-only payout body moves into a
  shared component so both places render the same thing.
- **Q3:** active roster only. A hint points leavers to the Offboarded tab.
- **Q4:** the tab also shows on the CEO's People tab (same component, same access check).
- **Q5:** click to reveal, same as the popup. The logged reveal-banking route stays the only way
  to see a full number.

## Task 1 — pure matcher

- [x] `src/lib/people/bank-search.ts`: `searchPeopleByNameOrEmail(rows, query)` ranks name prefix,
      then word prefix, then name contains, then work email contains; ties break A→Z; empty query → []
- [x] `src/lib/people/bank-search.test.ts` (node:test): ranking order, case-insensitive match,
      personal email never matched, no cap (every match returned), no-name rows handled

## Task 2 — move the popup's read-only payout body (a move, not a rewrite)

- [x] `src/components/people/payout-record.tsx`: `Banking` type, `Field`, `Disclosure`,
      `REVEAL_SKELETON_WIDTHS` + `PayoutRevealSkeletonContent`, and `PayoutRecordBody` (setup code from
      PeopleTab.tsx:3203-3234, markup from :3786-3893), each carried over verbatim
- [x] `PeopleTab.tsx` imports them and renders `<PayoutRecordBody>` where the body was
- [x] The Routing fold is CONTROLLED (`routingOpen` / `onToggleRouting`): the popup keeps its `showRouting`
      state, so the fold still survives a tab switch; the Search Bar page holds its own (starts closed)

## Task 3 — the tab

- [x] `src/components/people/PeopleBankSearch.tsx`: Simple logo, the bar that moves up when you
      type, results 15 per page with the true total, rail chip, ···1234, "No bank info"
- [x] Inline page: Back button, header, GET `/api/people/[email]`, Reveal → POST `reveal-banking`
      (skeleton while it loads), `PayoutRecordBody`, "Open full profile" → the popup on Banking
- [x] No work email → View disabled, with a tooltip
- [x] `PeopleTab.tsx`: a `'search'` mode, a "Search Bar" tab button, and an `initialTab` prop on
      `PersonDetailDialog` (defaults to `'profile'`)

## Task 4 — verify

- [x] `node --test` on bank-search, then `tsc --noEmit`
- [x] Check for a running dev server before any build (one IS running on :3000, so no build was run)
- [ ] Browser comparison of the popup's Banking view and the new tab: NOT DONE (the page needs a signed-in session; owed to Kane, item 217)

## Task 5 — record (same commit)

- [x] `docs/features/people-bank-search.md`, plus rows in INDEX and `docs/README.md`
- [x] `people-bank-card.md`: Key files + §9 (the read-only body now shows in a second Accounting place) · INDEX row 77
- [x] `docs/reference/components.md` rows
- [x] memory `people-bank-search` + MEMORY.md pointer at the top; INDEX Memory cell
- [x] Open items 217 → built and committed, not pushed
- [x] One commit, staged by explicit path
