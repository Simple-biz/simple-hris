# Accounting → People → View → Banking — the payee's bank card

The revealed payout record, printed as the object it describes: a landscape card in
the payee's own bank's colours, with the bank's logo where an issuer's mark sits and
the account number as the hero datum. Built for Kane, 2026-09-11: *"when we reveal the
bank info there should be the logo of the bank to be revealed as well… make sure to
check the Payment Catalog, the logos exist there, this way we can identify the bank
that they are on"*, then *"make the whole container of it look like the card for the
actual bank so if it's GoTyme it will look like a GoTyme card with the info on it"*.

Shipped 2026-09-11.

## Key files

| Piece | File |
| --- | --- |
| The card, its copy controls and the EMV chip | `src/components/banking/bank-card.tsx` |
| The cross-slot preferred-bank rule (name/holder/account/swift), shared with the employee's own Profile | `src/lib/banking/preferred-bank.ts` (+ `.test.ts`) |
| Spelling → bank + logo (one resolver, shared with Current Banks) | `src/lib/payment-catalog/banks.ts` → `resolveBankBrand` |
| Card colour, contrast maths (client-safe, pure) | `src/lib/payment-catalog/bank-card-palette.ts` (+ `.test.ts`) |
| Brand-colour measurement off the artwork | `src/lib/images/decode-png.ts` → `dominantInkColor` |
| Regenerates the colour table (READ-ONLY, no `--apply` needed) | `scripts/derive-bank-brand-colors.mts` |
| Host — reveal, loading state, disclosures | `src/components/people/PeopleTab.tsx` |
| Shipped brand logos + provenance | `public/banks/*.png` · `public/banks/SOURCES.json` |

## 1. Nothing new is exposed, and the reveal is still the audited path

The card is drawn entirely from data the browser **already holds**. `bank_name` is not
masked by `maskBanking` (`people-banking.ts:90`) — only account numbers, routing, SWIFT
and wallet emails are — so resolving a logo adds no field to any payload, no endpoint
and no new read. `payment-catalog-current-banks.md` §5 is unchanged: *"the audited
reveal-banking endpoint stays the only path to a full number"*, and it still is.

`bank-preferred-routing.md` §10.1's ban is also untouched. That ban is on a **bank-name
breakdown on the People KPI band** — an aggregate leaderboard over a free-text column.
This is one person's own record, where the bank name was already printed before this
change. No aggregate, no leaderboard, and nothing here feeds the band, Payment Dispatch,
or any rail calculation.

## 2. The card shows the bank the money GOES to

The card is fed `prefBank`, the slot-aware value the Bank field already used: the
person's **paid** slot (`preferred_bank_slot`), falling back across slots with Payment
Dispatch's own pickFirst rule (`bank-preferred-routing.md` §8). Reading
`employee_ids.bank_name` directly would put a bank's logo and colours on an account the
payment is not going to — the slot-awareness bug class §3 of the Current Banks doc and
the roster export's account column both call out. Eight people sit on the alternative
slot with a different alt bank, and the card marks that case with an **Alternative
account** chip rather than staying silent.

## 3. One resolver, so the profile and the catalog cannot disagree

`resolveBankBrand(spelling, registry?)` routes through the **same** `groupKeyResolver`
the Current Banks fold uses. Registry aliases outrank the declared table in both;
subsidiaries stay apart in both (BDO Network ≠ BDO Unibank, BanKo ≠ BPI); a spelling
nobody claims gets nothing in both. A test asserts the two agree on every spelling, with
and without a registry, so a profile can never name a different bank than the card on
the catalog tab.

**No logo is a normal outcome and it draws no brand.** Three cases land there and all
three are correct:

| Case | Live count (paid slot, 2026-09-11) | What renders |
| --- | --- | --- |
| Declared bank with a shipped logo | 765 | Its logo, its colours |
| Declared bank that ships no artwork | 162 (MariBank 104, Metrobank 31, Security Bank 16) | Neutral card, generic mark |
| Spelling nobody has claimed | 14 (8 are a person's name) | Neutral card, generic mark |
| No bank on the paid slot | 1,124 (wallet-routed, or nothing on file) | No card |

The mark on a neutral card is a plain `Landmark` glyph, **identical for every bank
without artwork**, so it can never be read as one particular bank's. A monogram tile
would be the opposite: a coloured plate reading "RB" beside an account number looks like
a brand, and §7 is explicit that *"a wrong-bank logo is worse than none — it is a
confident lie on a screen Accounting uses to reason about payouts"*.

## 4. The colours are MEASURED off the artwork, never recalled

A tint is a claim about an institution exactly as a logo is, so it gets the same
discipline §7 gives the images. `dominantInkColor` reads each shipped PNG and returns
its dominant ink; `scripts/derive-bank-brand-colors.mts` prints the table;
`BANK_BRAND_HEX` carries it; and `bank-card-palette.test.ts` **re-derives every value
from those same files on every run**. A hand-edited entry, a refreshed logo nobody
re-derived, or a colour someone remembered all fail there rather than shipping one
bank's card in another bank's colour.

Two tiers, and the second is load-bearing:

1. **Chromatic ink.** Pixels are bucketed on a coarse grid and scored by population
   **weighted by saturation** — most lockups are a coloured mark beside black wordmark
   text, and the black wins on raw count, so unweighted counting returns "black" for
   nearly every bank.
2. **No chroma at all.** A monochrome lockup is answered by the mean of its own ink.
   GoTyme — the bank Kane named — ships a near-black wordmark, `rgb(45,45,58)`. An
   earlier pass refused it and handed GoTyme a grey card while every neighbour wore its
   own colour. Near-black is a colour; it is the one GoTyme actually prints.

### 4.1 Contrast is guaranteed, not eyeballed

The measured brand colour is the **accent**, used only where no text sits on it (the
bottom edge). The card **face** keeps that hue, clamps saturation into a band, and then
darkens along the hue until white text clears **8.5:1** — well above AA, because the two
tinted ink levels are mixed down from white toward the face and still have to clear AA
themselves once they are.

Both tinted levels are computed by **searching** for the strongest mix that still clears
their floor (6:1 for data, 4.5:1 for captions), not by a constant. A flat 42 % mix reads
beautifully on BDO's navy and falls to **3.84:1 on AUB's red** — the test caught exactly
that, and the fix was the search, not a lower threshold.

Lightness only; the hue is never rotated. Maybank gold and Maya mint cannot host white
text at their own lightness (`#ffcf01` gives white 1.2:1), so they darken into a deep
gold and a deep green rather than flipping to dark ink — one card in the set using the
opposite text colour would read as a different component. A test pins five brands inside
their own hue bands, and another pins that **no two banks print the same face**.

## 5. The account number is never reformatted

No 4-4-4-4 grouping, whatever the card shape suggests. PH account numbers run 10–16
digits with no canonical grouping, and a clerk transcribing one has to read exactly what
is stored. Tabular figures, verbatim.

The **copy buttons hand over that same string** — untouched, leading zeros included
(`001234567890` is a real shape, and a spreadsheet eats those). Copy sits on the account
number, the account holder and SWIFT, because putting the number somewhere else is why
the record is revealed at all, and retyping 16 digits is where transposition errors come
from.

**A failed copy says so.** The two existing copy helpers in this codebase swallow the
rejection, and `MarkPaidDialog`'s flashes its confirmation tick even when the clipboard
API is absent. On a money field, a tick that means "possibly nothing happened" is worse
than no button; this one raises a toast naming the field.

## 6. Revealing has an in-place loading state

Before this change the only sign a reveal was in flight was a 3.5 px spinner inside the
Reveal button — the panel where the details were about to appear did not move, which
reads as a dead click on a round trip to an audited endpoint. `revealing` now takes
precedence over both other states and paints a skeleton of the field grid, with the line
**"Revealing payout details — this is recorded in the audit log."** It uses the shared
`.skeleton-shimmer` utility, which already handles dark mode and
`prefers-reduced-motion`, and the region is `aria-live="polite"` / `aria-busy`.

## 7. What folds away

Kane, 2026-09-11: the card answers the question the tab is opened for; everything else is
a follow-up. Two disclosures, both closed by default:

- **Routing & rail details** — Pays via, Bank Preferred, Disbursement pick, Routing,
  Address.
- **Bank change history** — the trigger carries the entry **count**, so a fold never
  hides that there is something behind it.

**The wallet identity fields are deliberately NOT folded.** A Kolan, HiGlobe, WePay or
Jeeves payee has no card at all, and their wallet address *is* their payout record —
collapsing it would leave the panel showing nothing but a button.

## 8. One home per value

Bank, account holder, account number and SWIFT live on the card **and were removed from
the field grid**. Two renderings of the same account number drift the first time either
is touched. Routing and Address stayed in the grid: they are wire instructions, not
anything a card face carries.

## Deploy notes

No migration, no env vars, no new endpoint, no new dependency. The brand logos and the
`public/banks/*.png` assets already shipped with the Current Banks tab.

To add or change a bank's card colour: ship its logo (`scripts/fetch-bank-logos.mts`,
per `payment-catalog-current-banks.md` §7), add the path to `BANK_LOGO_SRC`, run
`node --import tsx scripts/derive-bank-brand-colors.mts`, and paste the printed line
into `BANK_BRAND_HEX`. The test will tell you if you skipped the last step.

**Open:** three live spellings the declared table plausibly covers but does not claim —
`CIMB Bank` (1), `Philippines National Bank` (1), `GoTyme Bank, Inc. (GoTyme Bank
Corporation)` (1). Each would be a declared claim and needs
`scripts/audit-bank-spellings.mts` re-run; none was added here.
