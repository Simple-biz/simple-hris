# Employee → Profile — the five-chip shell

The employee's own record, as one page with five in-page chips. Nothing here is a route
and nothing here is a dashboard tab: the sidebar has a single **Profile** item
(`EmployeeSidebar.tsx`) and the Pages registry a single `profile` key (`visibility.ts`),
so feature permissions gate the whole surface, never one chip.

Merged from **nine chips to five** on 2026-09-12 (Kane, on Carla's 2026-09-09 ask
*"the profile under employee — overview, ID and compensation all need to be one tab"*).
Spec: [`2026-09-12-employee-profile-tab-merge-design.md`](../superpowers/specs/2026-09-12-employee-profile-tab-merge-design.md).
Built across `d0231195`…`a9ce49bd`.

Before the merge this surface had **no feature doc and no INDEX row** — seven sub-surfaces,
zero governing documents. That is what this file exists to end.

## Key files

| Piece | File |
| --- | --- |
| The shell, every pane, every save path | `src/components/employee/EmployeeProfile.tsx` |
| The ONE tab / section / intent vocabulary | `src/lib/employee/profile-tabs.ts` (+ `.test.ts`) |
| Compensation's inner strip — order, derivation, slide direction | `src/lib/employee/compensation-sections.ts` (+ `.test.ts`) |
| That strip, rendered | `src/components/employee/CompensationSections.tsx` |
| The ID card (a section of Overview, not a chip) | `src/components/employee/EmployeeIdCard.tsx` · `src/lib/employee/id-card.ts` |
| The payout read view's card | `src/components/banking/bank-card.tsx` |
| That card's deck, when a second account exists (§6.2) | `src/components/banking/bank-card-deck.tsx` |
| Which rail gets a card, which gets wallet fields | `src/lib/banking/payout-rail-view.ts` (+ `.test.ts`) |
| The cross-slot preferred-bank rule (shared with Accounting) | `src/lib/banking/preferred-bank.ts` (+ `.test.ts`) |
| The RAW per-slot read the backup card is built from | `readBankSlot` in the same file (+ `bank-slot-deck.test.ts`) |
| "Can this person actually be paid?" | `src/lib/employee/payout-completeness.ts` |
| The reload cache this surface conforms to | `src/lib/employee/tab-cache.ts` — see [employee-dashboard-cache.md](./employee-dashboard-cache.md) |
| Guards | `profile-hook-order.test.ts` · `profile-cache-conformance.test.ts` · `profile-date-render.test.ts` |

## 1. The five chips

| Chip | Sub-label | What is inside |
| --- | --- | --- |
| **Overview** | Identity, employment & ID | Personal · Employment · Address (still `hasAnyAddress`-gated) · the **ID card** |
| **Compensation** | Rates, stubs & payout | An inner strip: **Rates · Pay Stubs · Payout** |
| **Skill Sets** | Skills & commendations | The skill-set editor and the commendations list, stacked on one page |
| **Request Documents** | COE, pay stubs & certificates | unchanged |
| **Resign** | End your employment | unchanged |

Retired as chips: `id`, the old rates-only `compensation` pane, `payStubs`, `payment`,
`reports`. All of their content still ships — as sections, in the table above.

**`label: 'Pay Stubs'` and `label: 'Request Documents'` are source-scanned by a
build-failing test** (`src/lib/penny/employee-guides.test.ts`). `Request Documents` is still
a tab label in `EmployeeProfile.tsx`; `Pay Stubs` is now a **section** label in
`compensation-sections.ts`, and the test follows it there. It additionally asserts that
`title="Pay Stubs"` renders in the Profile, because between the tab's retirement and the
section's arrival there was a window where the strip offered a live chip that led to an
empty pane and every assertion stayed green.

### 1.1 Why Compensation is the only tab with a sub-strip

Skill Sets and Overview **stack**; Compensation **switches**. The rule is what the sections
cost, not how many there are:

- Overview's four blocks and Skill Sets' two are already in memory when the pane paints (one
  `Promise.all` on mount, plus the session cache). Stacking them costs nothing, and a strip
  would add a click to reach content that has already rendered.
- Compensation's three sections are not equivalent. **Pay Stubs owns a lazy fetch** and
  **Payout owns the one dataset that is never cached.** Stacking them would fire
  `/api/employee/paystub?summary=1` for every employee who opened the tab to read a rate, and
  would put the payout skeleton on screen underneath content that had already painted. The
  strip is what keeps each section's cost attached to that section.

The strip is a **bordered segmented control**, not a second underline — the house rule stated
verbatim at `PayProcessorsTab.tsx:1329-1330`, with the employee portal's own border tokens
(`EmployeeLeaves.tsx:300`) rather than Accounting's. It carries its own `LayoutGroup` id and
its own `layoutId`: reusing the outer strip's would let Framer animate the outer orange
underline down into the inner strip on mount.

## 2. Deep links name an INTENT, never a tab id

`src/lib/employee/profile-tabs.ts` is the only place the tab union exists. Before the merge it
was copied by hand in five places (`EmployeeApp.tsx`, `EmployeeDashboard.tsx`,
`ProfileCompletionCard.tsx` twice, and the component itself), and the callers named tab ids
directly. A narrow union satisfies a wide one, and the render chain is a series of bare
`activeTab === '…' &&` guards with **no default branch** — so retiring a tab left a nudge
pointing at an id nothing matched, the employee got a **silently empty pane**, and `tsc` said
nothing.

Callers now name one of three intents and stay ignorant of the layout:

```
INTENT_TARGET = {
  photo:    { tab: 'overview' },
  bank:     { tab: 'compensation', section: 'payout' },
  skillSet: { tab: 'skills',       section: 'skillSets' },
}
```

**The nonce is load-bearing.** `EmployeeApp` never unmounts a visited tab, and the Profile
applies the target with a value-keyed effect — so without a nonce, firing the same nudge twice
writes the value the state already holds, React bails out of the re-render, and the employee
does not move. `nextProfileTarget` always advances it.

**The scroll is a callback ref, not an effect.** The tab body is
`<AnimatePresence mode="wait"><motion.div key={activeTab}>`: under `mode="wait"` only the
*exiting* pane renders until its ~0.22s exit finishes, so the incoming pane's anchors do not
exist when an effect would fire. The same gap opens on a cold mount while `ProfileSkeleton`
stands in. An effect fires into empty air and — if it clears the pending target
unconditionally — destroys it, so the **first** nudge from any other tab never scrolls. A
callback ref is only invoked against a node that actually mounted. Each pane has its own copy,
scoped to its own `PROFILE_SECTIONS` entry, and clears the pending target **only on an exact
id match**, so the two panes cannot consume each other's. Compensation's copy additionally
hands the section over to `storedSection` **before** clearing, or a bank nudge would snap back
to Rates the instant it finished scrolling.

Anchor ids (`profile-section-<id>`) and the matching tab-button ids
(`profile-section-tab-<id>`) are **derived**, never spelled out at either end — the button
lives in `CompensationSections.tsx` and the panel in `EmployeeProfile.tsx`, and an
`aria-controls` that points at nothing is invisible to everyone except the screen-reader user
it strands.

## 3. The three hard conditions on the money tab

Kane approved folding Payment into Compensation on 2026-09-12 **with three conditions**. They
are not style; each one is the reason the fold is safe.

1. **Three independent readiness states.** Rates and Pay Stubs paint from the session cache
   instantly. The **Payout section alone** renders its own skeleton behind `bankInfoLoaded`.
   The merged pane never awaits `bankInfoLoaded`, and the page-level `loading` is never
   widened to cover it. `payoutPaneVisible` is ONE derived const read by both the skeleton and
   the form, so the matched pair cannot drift into stacking two cards or rendering none — and
   it deliberately does **not** fold in `bankInfoLoaded`, which would make Rates and Pay Stubs
   wait on the one uncacheable call in the wave.
2. **No cache key touches `/api/employee-ids`.** `bankInfo`, `payout`, `walletRailEffective`,
   `bankPreferred` and `pendingBankPreferred` stay on plain `useState`. Pinned by
   `profile-cache-conformance.test.ts`, which fails if any of those five is ever bound to
   `useEmployeeCachedState`.
3. **The pay-stub fetch is gated on the SECTION, not the tab.** Gated on the tab, every
   employee opening Compensation to check a bank detail fires
   `/api/employee/paystub?summary=1` — and while `SHOW_UNPAID_STAGED_PAYSTUBS` is `true` that
   route runs per-week recovery, so the wasted call is expensive, not merely wasted. The
   `activeTab !== 'compensation'` line above it is a **second lock, not the gate**: the chosen
   section is remembered across tab switches, so a viewer who opened Pay Stubs and then left
   still has `activeCompensationSection === 'payStubs'`.

The active section is **derived on every render, never stored as the truth**
(`resolveCompensationSection`) — a stored section can outlive the condition that offered it,
and this Profile already hides content by state. Slide direction comes from the **canonical**
`COMPENSATION_SECTIONS` order, never a filtered view, so a hidden section cannot reverse the
direction of a swap.

## 4. Caching — conform only

Kane's ruling on *"proper caching practices"* was **conform**, not extend: reuse
`src/lib/employee/tab-cache.ts`, **no new keys, no fifth store**. The merge changed which gate
fires a fetch; it never changed what is stored, so `SCHEMA_VERSION` is correctly **not**
bumped.

Four keys serve this surface — `profileMaster`, `profileRate`, `paystubSummary`,
`profileSkillSet` — and each still has exactly one live call site (asserted by
`profile-cache-conformance.test.ts`: a key whose call site a merge collapses must be
**deleted**, not left orphaned). `sessionStorage` only, identity-stamped, 12 h ceiling, and
**a cached value paints, it never decides** — every fetch still runs unconditionally and
overwrites. There is no skip/freshness flag on this store and none may be added; the test
scans the call sites for one.

**`/api/employee-ids` is NEVER cached.** It carries account numbers, and they stay out of
storage. That is the whole reason the Payout section has its own readiness state: when the
rest of the Profile paints from cache, Payout alone waits for the live row and shows a
skeleton — never the empty *"add your payout details"* copy flashing over saved details.

## 5. Hook order — nothing below the bail-out

`if (loading) return <ProfileSkeleton />;` is a real early return, and `loading` seeds from
`master === null` where `master` is cache-seeded. So on a **cold** load render 1 returns early
with N hooks and render 2 runs N+k, React throws *"Rendered more hooks than during the
previous render"*, and — because **there is still no error boundary anywhere in `app/` or
`src/`** — the throw blanks the whole `/employee` route. That was live on `main` before this
work (2026-09-12 session log, row 31).

Every hook this surface declares now sits in the state block **above** that return, including
`pendingSection`, `storedSection` and both scroll refs. `profile-hook-order.test.ts`
source-scans the file and fails on any hook below it.

Two things about that guard a future editor needs:

- It anchors on the `if (loading)` early return, so **do not spell that string out in a comment
  nearby**, and do not add a second top-level early return without teaching the guard about it.
- Its detector regex tolerates one flat type argument. A hook whose generic contains parens or
  nested angle brackets — `useCallback<(x: string) => void>(…)`, `useState<Map<string,
  number>>(…)` — is still invisible to it. None exists in this file today. If you add one,
  confirm the guard actually sees it before trusting a green run.

## 6. The payout read view

The Payout section was already read-with-an-Edit-button. What changed is what the read state
looks like: it is now the **same bank card** Accounting's People → Banking pane shows
([people-bank-card.md](./people-bank-card.md)) — one component, one resolver.

**Masked by default.** The employee's card passes `masked`, which prints the account number
and the wire code as last-4 with an in-card reveal, and **disables the copy button while
masked** — handing `••••••7890` to the clipboard silently, on a money field, is worse than no
button. The reveal is **client-side only**: no route, no audit row.
`/api/people/[email]/reveal-banking` writes an audit row because it records someone reading
*another* person's record, and a payee reading their own is not that event. It also passes
`animateIn={false}`, because this host animates the card's arrival itself (the section pane is
a keyed `motion.div` under `AnimatePresence`) and two entrances composed onto one arrival read
as a glitch.

**Fed from `bankInfo`, never from the `payout` draft.** That draft collapses
`swift_code ?? routing_number` into one field, so feeding it here would print a routing number
in the SWIFT position — with a working copy button.

**Fed the PAID slot, never `bank_name`.** `pickPreferredBank(row)` is the one cross-slot rule,
shared with Accounting's card and matching Payment Dispatch's own chain (including the third
`routing_number` rung on SWIFT). Reading `bank_name` directly would put a bank's logo and
colours on an account the money is not going to.

### 6.1 The four-way rail gate

The card is gated on **`walletRailEffective`** — the server-resolved rail across all three
routing tiers (`bank_preferred` → `preferred_processor` → the legacy rates cell). **Never**
the raw Disbursement pick and never `bankPreferred`: the three are distinct stored values and
changing one never changes the other.

| Effective rail | Card | Wallet fields |
| --- | --- | --- |
| `wires` | yes | no |
| `wise` | **yes** | no |
| `jeeves` | yes | yes (phone) |
| `hurupay` (Kolan) · `wepay` · `higlobe` | no | yes |

**Wise gets a card.** Wise payees are paid into their bank account, never to a Wise handle —
the same field set as `wires`. This is the row that is easy to get backwards, so the table is
pinned by `payout-rail-view.test.ts`.

**The wallet fields are never folded away.** For a Kolan, HiGlobe, WePay or Jeeves payee the
wallet address **is** the payout record; collapsing it leaves the panel showing nothing but a
button.

**A missing rail fails closed, and an unrecognised one fails closed harder.** `null` means
either "the payload never arrived" or "no tier resolved" — indistinguishable here, so neither
is treated as "no rail, show everything": nothing wallet-shaped is invented, and a card
appears only when there is an actual bank name on the paid slot. `'unrecognised'` is its own
third state because `employee_ids.preferred_processor` also carries `'ach'`, the contractor US
rail; an `'ach'` payee is not paid into the employee bank slot and must not be handed a bank
card.

**One home per value.** Bank, account holder, account number and SWIFT live on the card and
nowhere else below it. Routing number and Address are wire instructions, not card-face values,
so they stay in the grid — and the Routing row drops itself when it would print the exact
string the card face is already showing (for an alternative-slot payee `alt_routing_number` is
both the card's SWIFT source and this row's source; there is no separate alt-slot routing
column).

### 6.2 The deck — a second account sits BEHIND the first

**Shipped 2026-09-13** (Kane: *"if they have an alternate bank account it should be behind the
main card ... a button where we can switch banks from Main to Alternative like spin them ...
this way Accounting will have a secondary account if they have a problem in Payment
Dispatch"*). `src/components/banking/bank-card-deck.tsx`.

`employee_ids` has held two bank slots all along — `bank_name…swift_code` and
`alt_bank_name…alt_routing_number` — and the profile printed exactly one of them. **151 payees
already have a genuinely different second account on file** (measured 2026-09-13 over 2,065
`employee_ids` rows; 159 carry any `alt_*` value, 17 are paid *out of* the alternative slot).
Every one of those second accounts was invisible to the person who entered it.

**The front of the deck is never a new answer.** It is `pickPreferredBank(row)` — the same
card §6 has always printed, the account Payment Dispatch pays. The backup is read through
**`readBankSlot`**, which reads one slot and stops. That distinction is the whole safety
property: `pickPreferredBank` falls back field-by-field into the *other* slot so a half-filled
record still names the account PD pays, and reusing it for the backup card would let it borrow
the paid slot's bank name — two cards claiming one bank, which is the invented equivalence
[people-bank-card.md](./people-bank-card.md) §2 forbids, with the extra twist that Accounting
would then believe a fallback destination exists.

**A deck is earned, not assumed.** Three conditions, all pinned by `bank-slot-deck.test.ts`:
the rail already shows a card; the other slot names a bank or an account; and the two slots
are not the same account. A record whose details live only in one slot resolves — *through*
that cross-slot fallback — to the same account on both, so it correctly gets the single card
it always had. Two accounts at the **same bank** (UnionBank/UnionBank, GCash/GCash, BPI/BPI —
all real rows) are still two accounts and do get a deck.

**Which card is facing never implies where the money goes.** Flipping is a viewer, not a
routing change. The status line under the deck states the role of the card currently facing
and is the only place that claim is made: the paid card reads *"Payroll sends your salary
here"*, the backup reads *"Payroll does not send here — Accounting can switch to it if a
payment to your primary account fails."* **The payout destination is still changed only in the
edit form**, by the Primary/Alternative picker, through the save that has always filed it —
never by a spin.

**The facing state is lifted out of the deck** into `PayoutReadView`, because the rows under
it name a slot too. A "Routing number" with no slot in its label, printed off the paid account
while the backup card is the one on screen, is the same drift in a different costume. With a
deck the routing row is read **raw per slot**; without one it keeps the cross-slot fallback,
byte for byte as before.

**The tucked card is `inert`.** It is a few px of visible edge, but its copy buttons and its
reveal toggle are real controls behind the front card — without that attribute a keyboard user
tabs into "copy account number" for an account they cannot see.

**The spin is on the STACK, never on a card.** A card rotated past 90° shows its own back, and
there is no back face to show — these are two different accounts, not two faces of one.
Tipping the whole stack `rotateY: [0, -13, 0]` reads as the deck being turned over in the
hand, and no glyph is ever mirrored. The two cards share one CSS grid cell (`col-start-1
row-start-1`) so the stack is as tall as a card with nothing measured: `position: absolute`
would collapse the container, because the card has no fixed height below `sm`.

### 6.3 Editing ELONGATES the pane; it does not snap

The read ⇄ edit swap used to be a hard cut — the card vanished, a taller form appeared, and
everything below jumped. Now the body wrapper animates to its **measured natural height**
(ref callback + `ResizeObserver`, the same mechanism as the onboarding dialog's mode toggle in
`HrOnboardingForm.tsx`) while the two views cross-fade inside it under `AnimatePresence
mode="popLayout"`. `popLayout` is load-bearing: it lifts the leaving view out of flow the
instant the swap commits, which is what lets the measured height read the *incoming* view
immediately instead of waiting out an exit and collapsing to zero in between.

**The wrapper clips ONLY while it is travelling.** The bank picker inside the edit form is an
in-flow `absolute` popover, **not a portal** (`employee-payout-fields.tsx` — unlike the
onboarding dialog this borrows from), so a permanent `overflow-hidden` would cut its bank list
off at the panel edge: a functional regression dressed as polish. Nothing is open while the
box travels, so clipping is free exactly then and never after. A watchdog clears the clip
after 900ms because a height animation that resolves to the number it started from never fires
`onAnimationComplete`, and a stuck clip **is** that regression.

**The blur is on the way OUT only.** Motion leaves `transform: none` when every transform is
at its default, but it leaves a literal `filter: blur(0px)` behind — and a live `filter`
creates a stacking context the bank popover could not escape. Exiting nodes unmount, so the
softened cut costs nothing.

Direction carries meaning and is passed through `AnimatePresence`'s `custom`, which hands the
*current* value to the child that is leaving: entering edit, the form rises from below and the
card leaves upward; cancelling reverses both. Without `custom` the outgoing view would exit
the way it came in and the pair would read as two unrelated fades.

Edit and Cancel are **one slot**, not two conditions — `popLayout` again, so Save glides across
the width difference instead of being shoved sideways. `prefers-reduced-motion` keeps every
state change and every cross-fade and drops only the spatial travel: no height animation, no
`y`, no deck spin.

## 7. A neutral card is a CORRECT outcome — do not report it as a bug

This is the most likely false bug report on this surface, and it has two independent causes.
Both are deliberate.

**162 people correctly see a NEUTRAL card.** MariBank (104), Metrobank (31) and Security Bank
(16) are **claimed banks in the declared table that ship no artwork**. Counts measured on the
paid slot, 2026-09-11. The rule is stated at `banks.ts:297-300` and applies to every surface:
*"a wrong-bank logo is worse than none — it is a confident lie."* On the employee surface this
is the **majority** outcome for those staff, because each of them sees only their own card.

**An unclaimed spelling also correctly gets no brand.** A spelling nobody has declared
resolves to nothing — in this card and on the Payment Catalog's Current Banks tab alike, since
both go through the one `resolveBankBrand`, so the two can never name different banks.

**No logo ⇒ no brand, NEVER a monogram.** The mark on a neutral card is a plain `Landmark`
glyph, identical for every bank without artwork, so it can never be read as one particular
bank's. A monogram tile is the opposite: a coloured plate reading "RB" beside an account
number *looks like* a brand. This is escaped only through the card's exact `ProcessorLogo`
props — `monogram=""`, `fallback="icon"`, `FallbackIcon={Landmark}`. Re-wiring them silently
restores monograms.

**No fuzzy matching may ever be added to make more cards branded.** Claiming a spelling is a
**declared** edit to `OFFICIAL_BANKS` with `scripts/audit-bank-spellings.mts` re-run; guessing
is forbidden (`payment-catalog-current-banks.md` §2). The correct response to "this bank shows
no logo" is exactly one of two things: **ship the artwork**, or **declare the alias** — never
widen the matcher. Three real spellings were claimed that way on 2026-09-12 (`f2560d0`):
`GoTyme Bank, Inc. (GoTyme Bank Corporation)`, `CIMB Bank`, and `Philippines National Bank`
(the plural misspelling), all as aliases of **existing** entries, because adding them as new
entries would have split one institution into two.

The bank registry (`app_settings`) row still **does not exist in production**, so
`resolveBankBrand`'s `registry` argument stays **unpassed** on every call site. Wiring it on
one surface alone would make Accounting's card and the employee's card name different banks:
**both call sites together, or neither.**

## 8. Dates

`formatStartDate` in this file is a **direct alias** of `formatDateOnly`
(`src/lib/date-only.ts`) as of 2026-09-12 — not a second implementation. `start_date`,
pay-stub pay dates and resignation effective dates are all DATE columns, and
`new Date('2024-05-06')` parses as UTC midnight, rendering **the day before** for every viewer
west of UTC. The Employment row and the ID card now agree byte for byte.
`profile-date-render.test.ts` source-scans this file and fails if a bare `new Date(` reappears
beside them.

Two other functions named `formatStartDate` live elsewhere and are **not** fixed:
`src/components/Overview.tsx:216-224` (the admin roster) still carries the original
naive-parse bug, and `src/components/accounting/PayrollWizardNotesFab.tsx:1892-1899` parses
correctly but returns an em-dash for unparseable input, swallowing malformed roster data. So
the same person's start date can read Sep 1 on their Profile and Aug 31 on the admin roster.
Recorded in the 2026-09-12 session log; not closed here.

## Deploy notes

**No migration, no new route, no new env var, no new dependency, no n8n import.** This merge
moved panes, extracted a vocabulary and added two optional props to a shipped component. Every
endpoint it reads was already being read.

`BankCard`'s `masked` and `animateIn` both default to the shipped behaviour, so Accounting's
call site passes nothing and is byte-identical.

## Open

- **Offboarded employees + the bank card is UNRULED.** Nothing in `bank-card.tsx`,
  `resolveBankBrand` or any doc says whether an offboarded person's Payout section renders the
  card. `/api/employee-ids?email=` is gated by session, not by active status. Adjacent
  precedent cuts both ways. Needs Kane, not an inference. (Session log row 41.)
- **The ID card's 372px host requirement is violated at phone width**, and always has been. At
  a 400px viewport the content column computes to 360px, under the card's `max-w-[372px]`, so
  the badge shrinks on screen while the exported PNG does not. Pre-existing — true of the old
  standalone ID chip too. At ≥768px the sidebar becomes a 256px flex sibling, leaving ~448px
  (768) and ~1064px (1400); both clear it.
- **`needsPayoutSetup` has no `bankInfoLoaded` gate**, unlike its immediate neighbour
  `needsSkillSetSetup`, which is gated on `skillSetLoaded`. `bankInfo` is null until
  `/api/employee-ids` resolves, and on a cache-warm paint `loading` is already false — so the
  TabBar's bank dot, Accounting's rose escalation and the Compensation strip's Payout chip all
  assert "needs setup" **on screen** to an employee who already has details. Pre-existing and
  byte-identical through this merge.
- **`/employee` mounts sonner's `<Toaster>` twice** (`app/layout.tsx:60` and
  `EmployeeApp.tsx:686`), so every toast on this surface renders twice — including this
  surface's own copy-failure toast.
- **Visual verification is owed.** No browser pass was possible during the build; port 3000 was
  held by another session throughout. Unobserved: the 0.18s section slide and its direction,
  the layout at phone width, the throttled-network proof that the payout skeleton wins over the
  empty-state copy, and the DevTools proof that Rates fires no paystub request. **Still owed
  after 2026-09-13** — the deck (§6.2) and the read ⇄ edit elongation (§6.3) shipped without a
  browser pass either: employee sign-in could not be driven from this session and Playwright is
  not installed. Unobserved there: the deck's resting offset at phone width (the cards are
  `max-w-[440px]`, so at 400px they fill the column and the tucked card's 7 % inset is ~14px a
  side), the spin's read at 60fps, and the proof that the bank picker's popover is NOT clipped
  by the height wrapper once it settles.
- **Accounting's own card is still single.** §6.2 gives the EMPLOYEE the deck. People → Banking
  ([people-bank-card.md](./people-bank-card.md)) — the surface a clerk is actually on "if they
  have a problem in Payment Dispatch" — still prints only the paid slot. `BankCardDeck` is
  shared and its call site there is two lines. Kane's call, not an inference.
- The inner strip has a complete `role=tablist` / `tab` / `tabpanel` contract but **no roving
  tabindex** — arrow-key navigation between the three sections is absent. The outer TabBar has
  the same gap, so it is not a regression.
