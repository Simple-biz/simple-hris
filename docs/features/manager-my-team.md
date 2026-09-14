# Managers — My Team logic

Reference for how the **Manager portal → My Team** surfaces a department manager's
roster, what each manager can and cannot see, and how the per-member dialog is
built.

Key files:

- `src/components/manager/ManagerApp.tsx` — the roster shell (cards, medal context, Active-now).
- `src/components/manager/ManagerMemberDialog.tsx` — the per-member detail modal.
- `src/components/manager/ManagerMemberHoursMini.tsx` — the attendance/PAB mini-calendar inside the modal.

## Managers do not see rates or pay (anywhere)

> **Source of truth:** managers see attendance, recognition, and shared profile
> data — never compensation. Rates and pay were stripped from every My Team
> surface; do **not** reintroduce them.

Removed from `ManagerApp.tsx`:

- The global **Show rates / Hide rates** toggle and its `ratesHidden` state.
- The per-card **rate footer** on each roster card. A quiet email/identity footer
  remains (see the inline comment near `ManagerApp.tsx:3061`, "rates removed:
  managers no longer see pay rates").
- The now-unused `AnimatedRate` / rate-formatting helpers.

Kept: the **Active now** control (`ActiveNowButton`, `ManagerApp.tsx:2694` /
`:3193`), which shows online presence and is unrelated to pay.

## Member dialog (`ManagerMemberDialog.tsx`)

The modal has a left **identity rail** and a right **tabbed detail panel**.

### Recognition card replaces the pay-rate card

The rail's old **Pay rates** card (with its show/hide toggle and `MaskedRate`) is
gone. In its place is a read-only **`RecognitionCard`** (`ManagerMemberDialog.tsx:167`)
that surfaces the medals awarded to the teammate from the roster:

- **Commendation** (green flag) and **flag-for-review** (red flag) groups, ordered
  by `MEDAL_ORDER = ['commend', 'flag']`.
- Per group: a **count** badge, the **latest note**, and **who/when** awarded
  (`by <awarded_by> — <date>`).
- Empty state: "No commendations or flags yet."

Data comes from a new optional **`medals?: MedalRecord[]`** prop
(`ManagerMemberDialog.tsx:54`), supplied by the roster's medal context. In
`ManagerApp.tsx` the medals map is read from `useMedalCtx()` (`:2008`) and the
selected member's medals are passed into the dialog keyed on personal/work email
(`:3159`). Awarding still happens via roster drag-drop, not in the dialog
(the card is read-only here).

### Tabs: Work · Notes · Hours

`TabId = 'work' | 'notes' | 'hours'` (`ManagerMemberDialog.tsx:31`). The former
**Payments** tab is renamed **Hours** (`CalendarDays` icon, `:227`) and is now
**attendance-only** — the pay summary was removed. The tab renders
`ManagerMemberHoursMini` (`:441`), passing `workEmail`, `personalEmail`,
`alternateWorkEmail`, `alternateWorkEmail2`, and the member's **`department`**
(`:447`).

## Attendance mini-calendar (`ManagerMemberHoursMini.tsx`)

This component was gutted of all pay. Removed: per-day rate badges/tooltips, the
rates + rate-history + `member-monthly-pay` fetches, the `monthPay` calc, and the
**Estimated pay / Bonuses / MESA / weekend pay** summary card. What remains is a
pure attendance view built from merged Hubstaff hours.

- **Hours-only fetch:** loads the merged Hubstaff row once per member open; month
  navigation is derived state (no refetch). Holiday settings are fetched once for
  the violet holiday cells.
- **Month picker** with sliding label animation, plus an "`Xh month`" total
  (`monthAllDaysTotalSeconds`).
- **Cell coloring:** emerald = pass, rose = fail, violet = holiday (overrides), and
  weekend handling. See `CalendarBody`.

### HSL PAB rule now derives from the `department` prop

Because the server pay payload was removed, the HSL-specific attendance rule
(weekend qualification + overnight-shift split) is now driven entirely by the new
**`department` prop**:

```ts
const isHslMember = (department ?? '').trim().toLowerCase() === 'hsl';
```

(`ManagerMemberHoursMini.tsx:312`, passed down as `isHsl`). HSL members qualify a
weekend day at `hours >= 7` and get the overnight rule (`hslOvernightQualifies`,
`:539`) that combines a short day with the adjacent day to reach the 7h threshold.

> **Caller invariant:** `ManagerMemberHoursMini` has exactly one caller —
> `ManagerMemberDialog`, which passes `department`. If you add another caller, it
> **must** pass `department` or HSL members will be mis-colored against the
> non-HSL rule.

## The department rail (there is no "All")

**The rail is the OUTER axis for all three inner tabs** (Kane, 2026-09-14: *"Put the New
Hire Checklist and Orientation and roster tabs within the departments"*). Roster, New Hire
Check List and Orientation all scope to the same selected entry through the one splitter
`scopeRowsToDept`, so the three cannot disagree about who is in a department — the same
reasoning that makes the Orientation cards and its tally read one week key. Scoping filters
each panel's INPUT rows; no model, rate or bucketing is department-aware. Hires whose
department has nobody on the active roster are named in an amber banner on every tab rather
than dropped — see
[manager-orientation-attendance.md](./manager-orientation-attendance.md) § *Department
scoping*.

Shipped 2026-09-14, replacing the **Department dropdown filter**. Kane: *"instead
of a filter we would have tabs arranged vertically on the left side where we can
select Department rather than showing everything in one page and filtering them
from there."* One department is on screen at a time; **there is deliberately no
"All" entry** (Kane's call when asked directly) and the rail opens on the
manager's **largest** department.

Geometry is the shared rail library, `src/lib/payment-catalog/dept-rail.ts` —
`buildDeptRail` / `assignRosterToRail` / `rollUpCounts`. That is what makes HSL
fold into one parent disclosing its sub-teams (Kane 2026-08-21) instead of 16
siblings, and what guarantees **a filter never hides a row**: `assignRosterToRail`
files every person in exactly one bucket and its sizes sum to `roster.length`.

`src/lib/manager/team-dept-rail.ts` supplies the half My Team cannot borrow — the
catalog's rail is driven by the pay-structure **registry**, and My Team has none:

- Entries are derived from the department cells the roster actually carries, plus
  the manager's granted departments. **A granted department with nobody in it
  still gets a tab reading 0** — it is how a mis-scoped grant becomes visible.
- **A label with no payroll key is still a department here.** `normalizeDeptToKey`
  returns null for USEE, Site Building (US/PH), Orphan Ministry and Manager — 61
  people measured 2026-09-14 — and the catalog sweeps them into "No department"
  because it is asking a payroll question. The manager is asking who is on their
  team, so each earns its own entry. `RAIL_NO_DEPARTMENT_KEY` is left to catch a
  genuinely **blank** cell (0 today) and is hidden while empty.
- **The HSL parent is synthesised** whenever any `hsl:*` child is present. Exactly
  one person carries the bare `HSL` label today; without this the rail would flatten
  to 16 top-level HSL rows the moment they left.
- **Ordering is by rolled-up headcount**, so HSL sorts on its ~625 people rather
  than on the one left on the bare parent label. That ordering also picks the
  default selection.
- **Selecting a parent shows the whole family** (`membersForRailKey`), so the
  number on the rail and the length of the list under it are the same number. A
  row reading 625 must never hand back the 1 person on the bare parent label.

> **Search stays GLOBAL while the roster does not.** The four row actions —
> including **Offboard** — are only reachable through a roster row, so scoping
> search to the selected tab would make a person unreachable unless the manager
> already knew their department. Every rail entry carries its own match count
> while a query is live, and the departments holding matches are offered as a jump
> under the toolbar. Do not "simplify" this to a per-department search.

Labels are formatted (`formatDeptLabel`) and **rail keys stay raw** — the
dept-label-display-sweep rule. This also closed a live defect: the old dropdown
built its option label from the raw cell, so an HSL manager read
`hsl:intake_specialist` in the filter. The source-scan guard never caught it
because it only inspects JSX children, and that label was an object property.

Selection is cached in the shell store (`MANAGER_CACHE_KEYS.teamDeptRailKey`) as a
**raw rail key** — never a resolved entry or a member list. A cached key that is no
longer on the rail resolves to the default before it renders, so a stale key costs
one redirect and can never decide which people are on screen.

Below `lg` the rail is replaced by a flat picker with the sub-teams **indented,
not dropped** — dropping them would make the whole HSL family unreachable on a
phone. A manager with a single department gets **no rail at all** (the old
dropdown was hidden in the same case). Pure logic is unit-tested in
`src/lib/manager/team-dept-rail.test.ts`.

## Per-department views (the department's own tabs)

Beside the department search sit the views that only *some* departments have. Two
exist:

| View | Appears when | Source |
| --- | --- | --- |
| **Scheduling** | the selected entry is in the HSL family | `departmentHasScheduling` |
| **Rankings** | the department has SP-scored weeks **and** the viewer may read them | the data, via `/api/team-rankings` |

> **Scheduling is gated by a PREDICATE; Rankings is gated by the DATA.** That
> difference is deliberate. Scheduling is a decision Kane made about HSL, so it is
> declared. Rankings must stay data-driven because `hasSpRankings` is what lets a
> second team adopting the AI Team Bonus shape light up **with no code change** —
> hardcoding `devs` would break that promise
> (`employee-team-directory.md`). Never turn the Rankings check into a department list.

### Rankings — SP and tier, never pesos, and not for everyone

Added 2026-09-14 (Kane: *"as for the AI/API Team the rankings should be shown here for
the KPI Results"*). It renders **the same `RankingsPane`** the employee team tab uses,
extracted to `src/components/team/RankingsPane.tsx` rather than copied — the
no-pesos rule has to hold identically on both surfaces, and two copies would be two
places for a peso column to appear.

- **`amount` is absent from the projection**, not selected-then-dropped, and a test
  pins the projection *string*. This surface reuses `/api/team-rankings` unchanged
  precisely so that control keeps covering it. **Do not write a manager-specific
  read.**
- **`vars.Ranking` is a TIER FLAG** (1 / 25 / 50 / 0). The `#1..#n` shown is derived
  by sorting SP descending and is never stored.
- **Who may see it is `canViewTeamRankings`** — a one-name allow-list above the
  elevated-role bypass (Kane 2026-08-29). Asked on 2026-09-14 whether managers of a
  department should gain access, **Kane said no**: the ruling stands. Measured that
  day, 8 people hold a live AI/API Team manager grant; seven of them see no Rankings
  toggle at all, because a denied viewer reads the same empty week list as an
  unscored team. **This surface therefore has no gate of its own and must not grow
  one.**
- `selfNorm` is null here: a manager is looking at their team, not finding themselves
  in it.

**The People view opens as the LIST** (Kane, 2026-09-14), switchable to cards. The
list is the denser of the two — it pages at 20 against the cards' 8 — so a department
opens showing more of itself, and the multi-select that queues offboarding is on
screen without a switch. Both views carry the identical action set; see *Suspend /
Reactivation* for why they stay in lockstep.

**The search box, the count and Export CSV belong to the People view only.** They
describe the roster list; on Scheduling or Rankings they would act on nothing, and a
search box that silently does nothing is worse than no search box.

## Motion — one idea, four selectors

Added 2026-09-14 (Kane: *"animate it properly please smoothen the tab switching within
the my team"*).

**The selection GLIDES; it never re-appears somewhere else.** My Team has four
selectors — the three inner tabs, the department rail, Cards/List, and HSL's
People/Scheduling — and each used to swap a static white pill instantly, which reads as
a flicker rather than a move. They now share one component, `SlidingTab`, and one
`layoutId` per group, so the indicator travels between siblings. That is the entire
motion idea on this surface, used in four places rather than four different ideas.

- **The rail is where it earns most.** Moving from a parent to a sub-team three rows
  down is a jump the eye would otherwise have to re-find.
- **The glide is a layout animation on a BACKGROUND element only**, never on text, so
  nothing reflows and no 300-row list is asked to move.
- **`mode="wait"` is deliberately NOT used on the panes.** Waiting for an exit before
  the next pane mounts doubles the perceived latency of every click, and this is a
  surface people work in rather than look at. Panes settle in; the old one is already
  gone.
- Pane keys cover **both axes** — which tab AND which department — so switching either
  explains itself. This changes no mounting model: those panes were already
  conditionally rendered, so nothing fetches twice.
- **One curve**, `TEAM_EASE = [0.22, 1, 0.36, 1]`, the same value the Payment Catalog
  surfaces use.
- The per-card stagger is **capped at 180ms**; uncapped, a large department would read
  as the page loading slowly.

> **Reduced motion drops the travel, never the state.** `useReducedMotion` collapses
> the glide to `duration: 0` and removes the y-rise, and the indicator still renders —
> which tab is selected is information, not decoration. Nothing here gates a count, a
> fetch or an error branch on an animation having finished.

## Suspend / Reactivation (the manager temporary-pause pair)

Row actions in the My Team **list** and in every roster **card footer** (kept in
lockstep): View · Suspend · Reactivation · Offboard. Suspend and Reactivation are
the manager-facing replacement for the `temporary_pause` reason, which is
deliberately `disabled:` in the manager offboard modal — see
[offboarding-automation.md](./offboarding-automation.md).

Both ride one route: `POST /api/manager/temp-pause` `{ email, action: 'suspend' | 'reactivate' }`.
Manager or admin only, dept-scoped; a **dual-department person authorizes on ANY
managed roster row** (`.filter` + `.some`, never `.find` — row-order dependence
was a real bug) and the envelope carries the **department union**.

> **Neither writes anything to the roster.** No `global_master_list` stamps, no
> queue row — `audit_log` only (`manager.suspended` / `manager.reactivated`,
> `resource_id` = work email). Account state lives on the n8n/Workspace side, so
> **the webhook IS the action**: a webhook failure fails the request (502).
> Reactivation is therefore always enabled — there is no DB flag to read.

### The two envelopes are NOT the same shape

Envelope builders are pure and unit-tested in
`src/lib/hr/manager-temp-pause-webhooks.ts` (`.test.ts` pins both contracts —
the reactivate test is a whole-object `deepEqual` on purpose).

| | Suspend | Reactivation |
|---|---|---|
| Slug | `manager_suspend` | `manager_reactivate` |
| Default URL | `.../webhook/offboarding-deactivate` (shared with HR temp pauses) | `.../webhook/hris-reactivate-suspended` |
| Envelope | the **exact HR `temporary_pause` offboard envelope** — `event employee.offboarded`, `phase deactivate`, `deletion_mode "none"`, `hubstaff_pay_rate 0`, `off_boarded_by/_at`, plus additive `source: "manager_suspend"` | its **own** envelope — `event employee.reactivate`, `phase reactivate`, `reactivated_by`, `reactivated_at`, `count`, `employees[]` |
| Per-item fields | identity + `reason: "temporary_pause"`, `note`, `off_boarded_by/_at`, `scheduled_deletion_at: null` | identity + `note`, `reactivated_by`, `reactivated_at` |

> **Source of truth:** the Reactivation envelope above is the contract Kane
> verified against the live flow on **2026-08-10**. It carries **no** `reason`,
> `action`, or `source` — the flow only re-enables the account and sends a
> confirmation email, so `note` is carried for shape but is always `null` (the
> button has no note input). Do not "harmonize" it back onto the offboard
> envelope.

Suspend keeps mirroring the offboard envelope because that is how the existing
n8n deactivate flow branches to suspend-only with zero n8n changes — changing
`deletion_mode`, `phase`, or `reason` there changes what happens to the person's
account. **Temp pause must never schedule a deletion.**

Changing either slug or URL means **five sync points**:
`src/lib/hr/offboard-webhooks.ts` (slug + default URL + env branch) ·
`AdminWebhooks.tsx` `KNOWN_SLUGS` · `src/lib/webhooks/sample-payloads.ts` ·
`references/sql/seed/seed_webhooks_config.sql` · `.env.example`.

## Related

- Medals / recognition: `src/components/manager/MedalRecognition.tsx` (`MedalRecord`, `MedalType`, `MEDALS`).
- Manager-authored member notes: `PUT /api/manager/member-notes` (Notes tab).
- Employee-facing attendance/PAB: see [bonus-calculator.md](./bonus-calculator.md) and [bonus-catalog.md](./bonus-catalog.md), plus the PAB calendar logic in `src/lib/hubstaff/calendar-column-dedupe.ts`.
