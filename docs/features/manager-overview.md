# Manager dashboard — Overview (the front page)

Kane, 2026-09-02: *"Manager - Overview - Please redesign this and make it look like this
please but use our color theme"* → *"Make this fit in 1 view port please"*.

The manager's front page, rebuilt in session `3dab3af5`. **Its ship commit is `f36a97ce`
("Push", 358 files) — a catch-all sweep that also carried a plugin upgrade and another
session's KPI-calculator work.** `git log` will not lead you here; this doc is the only
pointer. See [[multi-session-shared-checkout]].

Key files:

- `src/components/manager/ManagerApp.tsx` — `Overview`, `NeedsPanel`, `StatCell`,
  `ApprovalRow`, `BonusRow`, and the roster panel. The whole surface lives in this file.
- `src/lib/manager/use-bonus-scoring-queue.ts` — the one fetch behind both the
  "Bonuses to score" stat and the bonus rows.
- `src/lib/manager/tab-cache.ts` + `useManagerCachedState` — every dataset here is
  cached; see `manager-dashboard-cache.md`.
- Scoped CSS lives in a `<style>` block inside the component (`ov-root`, `ov-scroll`),
  not `index.css` — the selection colour, caret and thin scrollbar are Overview-only.

## The page answers exactly two questions

*What needs me* on the left, *who is on my roster* on the right. Above them, a greeting
and a divided band of four numbers.

**Two streams are merged into one queue.** Pending time adjustments and bonus departments
still owed to payroll used to be separate cards. They are now one ordered "Needs you"
list with an All / Approvals / Bonuses filter, so the manager reads one queue instead of
triaging across panels. `NEEDS_PREVIEW = 8` rows render; the rest becomes `+N more waiting`.

**Nothing on this page decides anything.** Every row is a link into the surface that owns
the decision — an approval opens the Time Adjustments queue *because the evidence photo
lives there*, a bonus row opens that department's KPI Calculator card. Do not add a
verdict control here; the decision needs context this page deliberately does not carry.

The four stat cells: **Pending approvals** (→ approvals), **Bonuses to score**
(→ KPI Calculator, only when `canScoreBonuses`), **Active right now** (tracking time this
hour), **On your roster** (→ My Team). Each shows an em-dash while its gate is loading,
never a zero — a zero here reads as an answer.

## The viewport lock — the rule most likely to be violated

**At `lg` and up the page must not scroll. Both panels scroll internally instead.**

`ov-root` carries `lg:min-h-0 lg:overflow-hidden`; the two-panel grid carries
`lg:min-h-0`; each panel's list is the `ov-scroll` element with `lg:overflow-y-auto`.
The greeting, the four numbers and both panel headers stay put while only the lists move.

Verified at ship: **0px page scroll at 1440×900, 1366×768 and 1280×720**, with three full
rows visible even at 720px. Anything added to the header band comes out of the rows.

Two consequences that look like omissions and are not:

- **Two explanatory paragraphs were deleted.** "Every row opens where the decision
  lives…" and "Search 1,272 people by name or team." cost ~90px of permanent height to
  explain what the UI already shows — the rows carry `Review →`, and the roster total
  still reads in the search panel. Restoring them costs a full row at short heights.
- **`+N more waiting` and the scoring error are pinned *below* the scroll area**, not
  inside it. They must stay visible however far the list is scrolled.

**Mobile still scrolls, deliberately.** The lock is gated behind `lg:` because a 4-stat
band plus two lists cannot fit 844px of phone height, and stacking two nested scroll
panes on a touch device is a trap. Below `lg` the page grows and scrolls as before.

## Colour

The accent is the theme's own `--secondary` blue. **`--primary` orange is reserved
app-wide and measures 2.7:1 on these surfaces — it cannot carry small text at AA.**
Presence stays emerald because "online" is its own meaning, not an accent. Radii follow
the app's `--radius`, matching the sibling tabs.

The greeting sits on a coloured ground (`bg-secondary/[0.06]`) and its text is drawn
from that ground's own hue (slate, ~7.3:1), not neutral zinc — the same rule that the
Time Adjustments explanation ink follows (`b97637e3`).

## Name resolution

The email local part alone is unreliable (`j.delacruz@…` → "J"), so the greeting looks up
the employee record and takes the first token of its "First Last" name, with an
email-local-part fallback and ALL-CAPS proper-casing (`resolveFirstName`). The looked-up
name is cached under `MANAGER_CACHE_KEYS.viewerName`.

## Known state

- Two test failures pre-date this work and were reported by three separate sessions: a
  raw department cell in `ManagerApp.tsx` and an unformatted hours interpolation in the
  Overview gallery. Suite otherwise 2,098 passing.

See also: `manager-dashboard-cache.md` · `time-adjustment-requests.md` ·
`hsl-kpi-calculator-2026-07.md` · `manager-my-team.md`.
