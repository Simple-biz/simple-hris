# People → Search Bar — find a person by name or work email, then view their bank details inline

The **first** tab on Accounting's People surface (**Search Bar** · Roster · Statistics · Bank changes ·
Offboarded), also on the CEO's People tab. Kane moved it to the front on 2026-09-25 (*"put the search
bar at the first part"*). **Roster is still the tab People opens on**: only the position changed. It is styled on Payment Catalog → Search: the
Simple logo over a centred bar that moves up once you type. Results are active-roster people, and
**View** replaces the search with that person's bank page, which has a Back button. Built for
Kane, 2026-09-25: *"lets add a new Tab called 'Search Bar' similar to the payment catalog where we
can search people but this part is bank"*, then *"name and work email then we can see their bank
details when we view it similar from payment catalog"*.

Shipped 2026-09-25 (commit in `git log -- src/components/people/PeopleBankSearch.tsx`). Plan:
`docs/superpowers/plans/2026-09-25-people-bank-search.md`.

## Key files

| Piece | File |
| --- | --- |
| Ranked matcher + the ONE Missing-bank-info rule (pure) | `src/lib/people/bank-search.ts` (+ `.test.ts`) |
| The tab: search landing, result rows, inline person page | `src/components/people/PeopleBankSearch.tsx` |
| The read-only payout body (card · wallet fields · Routing), shared with the popup | `src/components/people/payout-record.tsx` |
| Host: `mode === 'search'`, the tab button, `initialTab` on the popup | `src/components/people/PeopleTab.tsx` |
| The per-person read + the audited reveal (unchanged) | `app/api/people/[email]/route.ts` · `app/api/people/[email]/reveal-banking/route.ts` |
| The precedent it copies | `src/components/accounting/BonusCatalog.tsx` → `SearchTab` |

## 1. It matches name and work email, nothing else

Kane's ruling. `searchPeopleByNameOrEmail` ranks a **name prefix**, then a **word prefix**, then
**anywhere in the name**, then **the work email**, with ties A→Z. Personal and alternate emails,
the employee ID and the department are **deliberately not searched**: the tab answers "whose bank
details are these", and a hit on someone's personal address would put a stranger's name beside the
query. The Roster tab's own search still matches ID and department; the two bars are different
tools.

Words split on anything that is not a letter or digit, because roster names are surname-first with
punctuation (`Cargo, James Adrian "James"`). A whitespace split misses `"James"` for "james". A test
pins it.

**Nothing is capped.** The catalog trims to 30 rows. This tab pages at 15 and prints
*"Showing x–y of N"*, so a common first name never silently loses its 31st match: a filter never
hides a row. `bank-search.test.ts` asserts 75 matches come back as 75.

## 2. It searches the roster already on screen: active people only

No new request. It reads the `rows` PeopleTab already loaded from `/api/people`, which is the
active master list. **Leavers are searched on the Offboarded tab** (`people-offboarded-pay.md`),
whose rules are different (row grain over `offboarded_sheet`, recycled emails return every record).
The idle hint and the empty state both say so. Merging the two would mean a second data source,
and a Left chip resolved by someone other than the Offboarded tab. Kane took (a), active only,
2026-09-25.

The roster row's identity is its master-list `id`, falling back to email + name (the roster's own
dedupe key). A recycled work email therefore never opens the wrong person's page.

## 3. The result row prints only what the roster row already carries

| Chip | Source | Rule |
| --- | --- | --- |
| Rail (Kolan, Wires, Wise, HiGlobe…) | `processor`, the EFFECTIVE rail Payment Dispatch routes on | Label from `PROCESSOR_OPTIONS` (hurupay → **Kolan**), never the raw id. `null` prints *Not routed* |
| `···1234` | `accountLast4`, **masked on the server**, slot-aware | Printed **only on a bank rail** (`payoutRailView(rail, false).showBankCard`: wires, wise, jeeves) |
| Missing bank info | `isMissingBankInfo` | The same function the People **Missing bank info** card now filters with |

**Why last-4 is gated on the rail.** Some Kolan and HiGlobe payees still carry old bank details on
file (a bank name for hurupay 45 of 697 and higlobe 29 of 216, measured 2026-08-19,
`bank-preferred-routing.md` §10.2). Printing it beside their name reads as where their
money goes, and it does not go there. The inline page follows the same rule: `payoutRailView` gives
a wallet payee wallet fields and no card. Passing `false` for "has a bank name" makes an unrouted
person fail closed. Their bank, if any, shows on the page after reveal, where the full resolution
runs.

**Missing bank info is ONE rule.** `isMissingBankInfo` = `!hasBanking` and department ≠ `USEE`
(US employees are paid through a separate channel). The predicate moved out of PeopleTab's
`noBankingRows` into `bank-search.ts`, and that card now calls it too, so the chip and the card
cannot disagree.

**No full number is on this list, or reachable from it.** `accountLast4` was already masked in
`people-roster.ts`. The only path to a full number is still the audited reveal on the person page.

## 4. View is an inline page, not the popup

Kane chose the inline page (Q2), like the catalog's person card. The page shows:

- a header with avatar, name, department · work email and the same chips;
- **Banking & payout**, hidden until **Reveal**;
- **Open full profile**, which opens the existing People popup **directly on its Banking tab**
  (`PersonDetailDialog`'s `initialTab`). Editing payout details and the **Bank change history** stay
  there. This page has no write path.

### 4.1 The reveal is the popup's reveal: click, audited, never automatic

Q5, Kane took (a). The page loads the **masked** record (`GET /api/people/[email]`). **Reveal**
calls `POST /api/people/[email]/reveal-banking`, which writes the audit row, and only then renders
the body. This is the same toggle the popup uses: a masked record reveals first and stays hidden if
that fails, and hiding is purely visual. Opening a page writes nothing. **Do not make View
auto-reveal**: every View would log a read of someone's bank record, whether or not anyone looked.

While the reveal is in flight, the in-place skeleton shows with the line *"Revealing payout details —
this is recorded in the audit log."* This is `people-bank-card.md` §6, through the shared
`PayoutRevealSkeletonContent`.

### 4.2 The body is never drawn from a masked record

`PayoutRecordBody` hands the account number to the card's copy button. A server-masked
`••••1234` there would put bullets on the clipboard of a money field. The body renders only after
the reveal has replaced the masked record, or when there is genuinely no record at all. **BankCard's
own `masked` prop is not a substitute**: its reveal is client-side only
(`bank-card.tsx`, `people-bank-card.md` §9) and would "reveal" a string that is already bullets.

### 4.3 A failed read is an error, never "no payout details on file"

`banking: null` from the per-person route means both *no record* and *the read failed*. The popup
treats a failed fetch as the former. This page requires `bankingResolved === true`, and anything
else renders a rose error box. Showing *"No payout details on file yet"* for a failed read is how a
payable person gets reported as unpayable.

### 4.4 The email is frozen for the page's lifetime

As in the popup, the page reads its `work_email` once. An email edited through **Open full
profile** must not re-fire the read and silently re-mask a reveal. The person object itself is
looked up live by key, so a name or department edit merged into the roster shows immediately. A
person who drops off the roster on a refresh returns the page to the search.

## 5. One read-only body, three places (the popup, the employee's Profile card, this page)

The popup's read-only payout body was **moved, not rewritten**, into
`src/components/people/payout-record.tsx` (`PayoutRecordBody`, with `Banking`, `Field`,
`Disclosure`, `REVEAL_SKELETON_WIDTHS`). The move was verified block by block against the prior
file: identical apart from indentation, `export`, and the Routing toggle becoming a prop. Every rule
`people-bank-card.md` states for that body therefore holds here by construction:

- the bank on the slot they're paid from via `pickPreferredBank` (§2);
- `payoutRailView` decides card vs wallet fields (§9);
- wallet fields are never folded, and Routing starts folded (§7);
- one home per value, where the Routing row drops only when it equals the card's SWIFT (§8).

**The Routing disclosure is controlled by the host.** The popup keeps that state on the dialog, so
it survives a tab switch or an edit round trip exactly as before the move, and this page holds its
own. Making it internal to the body would have silently reset the popup's fold on every remount.
**Never fork a copy of the body back into either host**: two copies of the paid-slot rule are the
drift `people-bank-card.md` §2 exists to prevent.

## 6. Who sees it

Everyone who sees People. `/api/people`, `/api/people/[email]` and `reveal-banking` are all gated
by `requireRateVisibilitySession` (admin / accounting / ceo). **The CEO's People tab shows it too**
(Q4, same component). The CEO's `canEdit` is false, which only matters inside the popup this page
opens. The People root carries `data-readonly-allow`, so View, Back, Reveal and the pager stay live
for a view-only viewer.

## Deploy notes

**No migration.** No env vars, no new endpoint, no new payload field, no n8n import. Nothing for
Kane to run by hand.
