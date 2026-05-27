# Meeting with Carla — May 7, 2026

*Working session. Attendees: Kane (dev), Carla (payroll coordinator).*
*Outcome: a new **Orphanage Budget** tab on the Orphanage Manager dashboard,
covering both a visit-type-aware request form and a directory of partner
orphanages with editable leftover-budget tracking. Static (in-component) state
only — no Supabase persistence yet.*

---

## I. Scope

The Orphanage Manager dashboard now has three tabs in its sidebar:

| Tab | Purpose |
|---|---|
| **Dispute queue** | Existing — verify/deny orphanage-style PAB disputes routed in by accounting. |
| **Orphanage Budget** *(new)* | Submit funding requests + maintain a directory of orphanages and their leftover balances. |
| **S-Wall** | Existing — company-wide social feed. |

The new tab keeps the pink/rose accent so it visually fits the rest of the
orphanage workspace (no amber/orange one-off — see §V for the reason that
reverted).

Inside Orphanage Budget there are two **sub-tabs**, switched via a pill toggle
under the hero header:

1. **Budget request** — form for a single funding ask.
2. **Orphanages** — directory of 14 partner orphanages with an editable
   leftover-budget field per row.

---

## II. Budget request form (sub-tab 1)

### Layout

Three layers, stacked top-to-bottom inside one card:

1. **Always-visible header block**
   - Simple Email (required)
   - Date Requested (required)
   - Type of Visit (required, radio: Monthly Visit · Frequent Travelers Budget · Special Project)
   - Notes for Bob (optional textarea)
   - Is this a Mission Trip? (required Yes/No)
2. **Type-specific block** — the picked Type of Visit decides which fields render here.
3. **Always-visible footer block**
   - Bank Account Information (Account Name · Account Number · Bank Name · Swift Code, all required)
   - Cancel · Submit Request (submit is disabled until a visit type is picked).

When no visit type is picked yet, a dashed-border placeholder card sits where
the type-specific block would go: *"Pick a Type of Visit above to see the
relevant fields."*

### Type-specific block · Monthly Visit

| Field | Notes |
|---|---|
| Date of Visit, No. of Children, No. of Celebrants | All required. |
| Gift Amount, Lootbag Amount, Cake Amount, Grocery Amount, Prepared Food Amount, Travel Amount, Misc. Amount | All required. ₱-prefixed currency inputs, all controlled. |
| If misc, please explain | Free text. Optional. |
| Collaborators | Textarea — one name per line. |
| **Amount** | **Read-only · auto-summed live** from the seven amount fields above. |
| Leftover from prev month | Required. Drives the Final Amount calculation below. |

### Type-specific block · Frequent Travelers Budget

| Field | Notes |
|---|---|
| Frequent Travelers' Budget | Required textarea, format `Name, Accommodation Amount, Travel Amount`, one row per traveler. |
| Total Travel Amount | Required. |
| Leftover from prev month | Required. |

### Type-specific block · Special Project

| Field | Notes |
|---|---|
| Special Project | Required textarea — purpose, scope, beneficiaries, timeline. |
| Amount | Required. |
| Leftover from prev month | Required. |

### Calculations

The Monthly Visit block has a dedicated Calculations panel with three
click-to-snapshot rows + two summary fields. All three sub-tabs share the
same `Final Amount` formula at the end.

| Row / Field | Formula | Trigger | Notes |
|---|---|---|---|
| Total for Gifts, Lootbags, and Cakes | `gift + lootbag + cake` | Calculate button | Red-lock 🔒 — auto-calculated, not user-typed. |
| Subtotal | `Amount` (sum of all 7 budget items) | Calculate button | Equivalent to the live Amount field above. |
| Gift Efficiency | `(GLC ÷ Subtotal) × 100` | Calculate button | Red-lock 🔒. Rendered as a percentage (e.g. `34.48%`). Subtotal is the 100% baseline; GLC is the share that went directly to gifts. Guarded against divide-by-zero. |
| **Final Amount** | `Amount − Leftover from prev month` | Live | Auto-updates as inputs change. Same formula on Frequent Travelers (`Total Travel Amount − Leftover`) and Special Project (`Amount − Leftover`). |
| Estimated Total (Monthly Visit) | *not specified yet* | Calculate button | Static `0.00` until Carla confirms what this should compute. |

Each Calculate button **snapshots the current input state** when clicked. If
the user edits an input afterwards, the row stays at the prior snapshot until
they click Calculate again. (The Final Amount field is the only one that
live-updates, since it's derived from the same Amount sum that already
live-updates.)

### Submit behavior

Static. `onSubmit` is a `preventDefault` no-op. The Submit Request button
visually enables only when a Type of Visit is selected, but clicking does
nothing yet. Wiring to Supabase + a notification to Bob is a follow-up.

---

## III. Orphanages directory (sub-tab 2)

A fixed list of **14 mock partner orphanages** rendered as cards in a 1/2/3-up
responsive grid (mobile / tablet / desktop). Above the grid sits a summary
strip with three tiles: Orphanages tracked, With leftover funds, Total
leftover.

| # | Name | Location |
|---|---|---|
| 1 | Tahanang Walang Hagdanan | Cainta, Rizal |
| 2 | SOS Children's Village — Lipa | Lipa City, Batangas |
| 3 | Kanlungan sa Erma | Manila |
| 4 | Bahay Tuluyan | Malate, Manila |
| 5 | Boys Town Manila | Marikina City |
| 6 | Hospicio de San José | Isla de Convalecencia, Manila |
| 7 | Asilo de Molo | Iloilo City |
| 8 | Bahay Kalinga | Quezon City |
| 9 | House of Refuge Foundation | Antipolo, Rizal |
| 10 | Kanlungan ni María | Cebu City |
| 11 | Children's Joy Foundation | Cavite |
| 12 | Norfil Foundation | Quezon City |
| 13 | ChildHope Asia | Manila |
| 14 | Bantay Bata Foundation | Makati City |

Each card carries:
- Name + optional notes line (e.g. *"Wheelchair-accessible facility"*).
- Address, contact person + child count, phone, email.
- **Leftover Budget** — editable ₱-prefixed currency input with a *Clear*
  button. Shows current persisted value below the input as a sanity check.

State lives in `useState` inside the component. Edits stick for the session
but reset on reload. The mock initial values are seeded in
`INITIAL_ORPHANAGES` at the top of the file.

---

## IV. Files touched / added

| File | Change |
|---|---|
| `src/components/orphanage/OrphanageApp.tsx` | New `'budget'` tab in the sidebar nav (pink, `PiggyBank` icon). New `budgetSubTab` state for the in-tab pill toggle. New `BudgetSubTabButton` helper. The budget panel now switches between the form and the orphanages directory based on `budgetSubTab`. Hero header title/subtitle adapts to which sub-tab is active. |
| `src/components/orphanage/OrphanageBudgetForm.tsx` | New file — the visit-type-driven form. Module-level `toNumber` helper. Three internal components (`MonthlyVisitFields`, `FrequentTravelersFields`, `SpecialProjectFields`) plus `PickTypeHint` empty state. `CalculationRow` extended with `value`, `onCalculate`, and `unit` props (the `%` suffix for Gift Efficiency). |
| `src/components/orphanage/OrphanagesPanel.tsx` | New file — 14-orphanage mock directory with summary tiles, responsive card grid, editable leftover-budget input per card, formatPHP helper. |
| `docs/meeting-with-carla-2026-05-07.md` | This document. |

No Supabase tables, API routes, or env vars were added in this session.

---

## V. Decisions reached during the session

1. **Pink, not amber.** Initial draft used amber/orange for the new Orphanage
   Budget tab; consensus was that the orphanage workspace should keep one
   visual identity (pink/rose), so all accents in the new tab were swapped to
   match the existing Dispute queue.
2. **Type-of-visit drives the form.** Carla flagged that the original
   single-page form forced staff to scan past fields that didn't apply
   (Frequent Travelers' textarea is irrelevant when filing a Monthly Visit,
   and vice versa). Splitting by visit type made the form feel half as long
   and removed the cognitive cost of "is this section for me?".
3. **Calculations stay click-to-snapshot.** Live-updating every calc row was
   considered but rejected — Carla wanted explicit "Calculate" affordances so
   numbers don't move under her cursor while she's reviewing. The exception
   is **Final Amount**, which is derived from data already live-updating
   elsewhere (Amount), so making it click-only would have been odd.
4. **Gift Efficiency formula = `GLC ÷ Subtotal × 100`.** First pass had it as
   `Subtotal ÷ GLC × 100` (which gives values > 100% and is harder to read).
   Carla pointed out that Subtotal should be the 100% baseline and GLC the
   share that reached the kids — flipping the formula puts the value in the
   intuitive 0–100% range.
5. **"Estimated Total" → "Final Amount"** rename across all three sub-forms.
   Internal variable names (`estimatedTotal*`) kept as-is to avoid churn.
6. **Mock first, Supabase later.** Both the budget form and the orphanages
   list are deliberately static for this session. Wiring to Supabase requires
   data-shape decisions Carla wants to bring back to Bob: who can edit the
   orphanage list, whether the leftover budget rolls forward automatically,
   what state machine the request should follow (draft → submitted →
   approved → released).

---

## VI. Open follow-ups for Carla / Bob

- [ ] **Submit endpoint.** Where should the budget request row land? New
      Supabase table? Audit log only? Email to Bob?
- [ ] **Estimated Total (Monthly Visit) formula.** Currently static. The
      duplicate "Estimated Total" labelled `(Monthly Visit)` exists in the
      original paper form but its formula wasn't defined.
- [ ] **Subtotal vs Amount semantics.** They share a formula today
      (`sum of all 7 budget items`). Confirm whether Subtotal should remain
      a click-to-snapshot mirror of Amount, or if it should mean something
      different (e.g. amount excluding travel, or amount excluding misc).
- [ ] **Orphanage data ownership.** Static seed of 14 in the panel. Which
      table should this live in? Who edits the directory itself (vs editing
      the leftover budget, which the manager handles)?
- [ ] **Leftover budget rollforward rule.** When a budget request is
      submitted/approved, should the orphanage's leftover balance auto-
      decrement? Or does Carla update it manually after disbursement?
- [ ] **Mission Trip handling.** The flag is captured but no downstream
      logic uses it yet. Confirm what changes when Mission Trip = Yes.
- [ ] **Collaborators field shape.** Free-text textarea today. Should it
      become a multi-select against `active_employees`?
- [ ] **Gift Efficiency benchmark.** Now that it's a clean 0–100%, is there
      a target? (Highlight under-target syncs in red, etc.)
- [ ] **Audit trail.** Each request should log who submitted, when, and what
      values went in. Pattern same as `csv.master.upload` etc.

---

## VII. Acceptance walkthrough Carla can run today

1. Sign in as an Orphanage Manager.
2. Sidebar → **Orphanage Budget**. Hero pink, no amber regression.
3. **Pill toggle: Budget request → Orphanages**. Both render.
4. **Budget request → Type of Visit = Monthly Visit.**
   - Empty hint replaced with the Monthly block.
   - Type values into Gift / Lootbag / Cake / Grocery / Food / Travel /
     Misc — Amount auto-sums live.
   - Type a Leftover from prev month — Final Amount auto-shows
     `Amount − Leftover`.
   - Calculations panel: click each Calculate button in turn — confirm
     Total for G/L/C, Subtotal, and Gift Efficiency (%) all show
     reasonable numbers.
5. **Switch Type of Visit → Frequent Travelers Budget.** Monthly block
   disappears, the travelers textarea + Total Travel Amount + Leftover +
   Final Amount block takes its place.
6. **Switch Type of Visit → Special Project.** Travelers block swaps for
   the Special Project textarea + amount fields.
7. **Sub-tab → Orphanages.** 14 cards visible. Edit a Leftover Budget on
   any card — Total leftover tile at the top updates live. Click Clear on
   one card — that card's value goes to 0 and the total reduces. Reload
   the page — values reset to the seed (no persistence, as expected).
