# Employee — team directory, rankings & policies

The employee portal's **team tab**: a directory of the viewer's own department, the
department's weekly SP rankings, and the policies published for that team.

Shipped 2026-08-14. Before this, the tab was a single roster grid labelled
"My Team" with a one-option department dropdown.

Key files:

- `src/components/employee/EmployeeTeam.tsx` — the whole tab (three sub-tab panes).
- `src/lib/name/team-display-name.ts` — the peer-safe short name + collision ladder.
- `src/lib/supabase/team-roster.ts` — the roster read, and where redaction happens.
- `src/components/employee/EmployeeSidebar.tsx` — the nav label.
- `src/lib/policies/team-policies.ts` — per-department policy copy (display-only).
- `src/lib/supabase/team-rankings.ts` — ranking assembly (`buildRankingWeeks` is pure).
- `src/lib/rbac/rankings-viewers.ts` — who may see Rankings at all (allow-list).
- `app/api/team-rankings/route.ts` — the gated, scoped read.
- Tests: `src/lib/supabase/team-rankings.test.ts` · `src/lib/rbac/rankings-viewers.test.ts`
  · `src/lib/policies/team-policies.test.ts` · `src/lib/name/team-display-name.test.ts`
  · `src/lib/supabase/team-roster.test.ts`.

## The tab is named after the department

The sidebar entry and the page heading both render the viewer's own
`global_master_list."Department"` — "AI/API Team", "Accounting Team", "QC" — falling
back to **"My Team"** until the master record resolves (and for anyone with no
department). An `hsl:*` cell collapses to a single **"HSL"** via
`collapseHslFamilyLabel`, per [hsl-subdepartments.md](./hsl-subdepartments.md).

> **The Pages registry deliberately keeps the static label.**
> `src/lib/pages/visibility.ts` still lists `{ key: 'team', label: 'My Team' }`, and
> its header comment asks for sidebar/registry parity. That parity is **intentionally
> broken here**: Pages visibility is a *workspace-wide admin broadcast*, so it cannot
> carry a per-viewer name — an admin hiding "My Team" must see one row, not 25.
> `humanizeTabId('team')` is left alone for the same reason: it feeds presence
> ("who is on which page") and the document title, which stay comparable across the org.
>
> The tab **id** never changes. Only the rendered string does.

## Sub-tabs: Directory · Rankings · Policies

A §11.1 sliding-indicator pill row (`layoutId="employee-team-subtab"`), with the
panes doing a directional crossfade in an `overflow-x-clip` wrapper. Every
animation is gated on `useReducedMotion()`.

**Rankings only appears when the team actually has ranked weeks** — the pill is
absent otherwise, and an employee sitting on it when the data empties is bounced
back to Directory. That is driven by the returned data, not a department allowlist.

Since **2026-08-29** it is also allow-listed to a single reader (see
[Authorization](#authorization)). Everyone else's fetch comes back `{ weeks: [] }`,
so the pill vanishes through the same code path as an unscored team — there is no
second hiding mechanism and no "restricted" state. The header sentence under the
page title drops the words "weekly rankings" for the same reason: the copy must not
name a section the viewer cannot open.

### Directory

Same roster source as before (`/api/team-roster`, one roundtrip for profiles +
skill sets + last-seen), **redacted since 2026-09-12** — see
[Identity redaction](#identity-redaction). What changed in the 2026-08-14 redesign:

- The one-option department **dropdown is gone** — the heading names the department.
- **Every card opens the profile modal**, not just people who filled in a skill set;
  the modal already had the "hasn't shared any profile details yet" state. Cards are
  real `<button>`s now (keyboard + focus ring for free).
- The in-card shimmer placeholders for people with no profile are gone — a directory
  should not imply half its rows are still loading.
- Denser grid (`sm:2 / lg:3 / xl:4`), page size 10 → 12.

#### Identity redaction

> **A peer sees a short name and a work email. Nothing else identifies anyone.**
>
> Ruling (Carla, 2026-09-09, on safety grounds — meeting doc §2.6): *"we got some
> really creepy people here sometimes and they shouldn't be able to see full names
> on their team. They should only see like their nickname, the whatever is in
> quotation marks, and their email."* Kane pinned the undecided half on
> 2026-09-12: **the quoted go-by, else the FIRST name.**

`shortDisplayName` (`src/lib/name/team-display-name.ts`) is the single resolver.
It exists because **neither** name helper already in `src/lib/name/` is safe here:

| Helper | `Jane Marie Santos` | Why it is wrong here |
|---|---|---|
| `parseNameParts(...).nickname` | **"Marie"** | *derives* a go-by ("last given token that is not a bare initial") — her middle name |
| `resolveFirstName(...)` | **"Jane Marie"** | returns every given token before the surname — her middle name again |
| **`shortDisplayName`** | **"Jane"** | the literal quoted go-by (`quotedGoByOf`), else `parseNameParts(...).first` |

Four rules that are not obvious and are all pinned by tests:

- **The quoted go-by must be *literally* quoted.** `quotedGoByOf` never derives
  one — that distinction is the entire difference between "Jane" and "Marie".
- **A go-by that IS the surname is refused** and the first name used instead.
  `Lagunero, Joshua "Lagunero"` is a real roster row; the ruling is about the
  surname, not about which field it arrived in. A *middle* name used as a go-by
  (`Avellaneda, Sonia Cardenas "Cardenas"`) is the person's own choice and stands.
- **The go-by is re-cased on its own.** `toTitleCaseName` returns a mixed-case
  string verbatim, so `Santos, Carla "CARLA"` used to keep its SHOUTED go-by —
  harmless inside a longer name, not harmless when it *is* the name. All-caps is
  only flattened at 4+ letters, because short all-caps go-bys are initials
  (JJ, KC, CJ) and "Jj" would be worse.
- **An `@`-address parked in the name column is never rendered** — it may well be
  the personal address. The work email supplies the label instead, and a person
  with neither is shown as **"Teammate"** rather than given an invented identity.

##### Collisions

Kane, 2026-09-12: *"if there are conflicts use the recommendation."*
`teamDisplayNames` resolves the WHOLE roster at once, server-side, so a label is
stable no matter which page it lands on or what is typed into search. Only people
who actually collide are suffixed — a unique "Carla" stays "Carla". Cheapest
disclosure first:

| Rung | Renders | When |
|---|---|---|
| 1 | `Kane R.` | two people share a short name — one letter is the most of a surname that may ever be shown |
| 2 | `Kane R. (kaner)` | the surname initial collides too; the work email is already on the card, so this discloses nothing new |
| 3 | `Kane R. 1` | …and neither has a work email |

Measured over the live roster on 2026-09-12: **195 of 1,343** active people need a
suffix, **0** degrade to "Teammate", and **0** labels contain a surname.

##### It happens on the server, and that is the point

`/api/team-roster` is reachable directly and `route-access.ts` gates **pages, not
APIs** — so a client-side trim would leave the legal name and the personal address
one `fetch` away. `TeamRosterProfile` therefore has **no `name` and no
`personalEmail` field at all**; `team-roster.test.ts` scans the interface and
fails if either comes back.

Three things fall out of that, and all three were part of the same ruling:

- **Search can only match what the card shows** (short name + work email).
  Matching a hidden field let a peer confirm a guessed legal name or personal
  address by typing it, which made the redaction cosmetic.
- **The directory sorts by the displayed name**, not by the legal surname it used
  to order on — a surname the viewer cannot see.
- **The `workEmail ?? personalEmail` fallback is gone.** A teammate with no work
  email had their *personal* address shown to the whole team.

Two things the client no longer has the addresses to compute, so the server sends
them as plain values: **`lastSeenAt`** (resolved over both addresses, so nobody
reads as never-seen) and **`isSelf`** (the "You" badge).

> **Known cost, accepted.** The live online dot and the avatar photo both key on
> an email, and 7 active people (all in `USEE`) have only a personal one. They
> show a grey dot and styled initials on this surface. They are also precisely
> the people whose personal address was being broadcast, so protecting them is
> the point rather than a side effect.

### Rankings

Weekly standings for the department, newest week first, with prev/next week
navigation. Each row shows **position, name, SP, project SP, and the tier badge**.

`bonus_catalog_applied.employee_name` is the master-list legal name, so
`buildRankingWeeks` runs it through the same `teamDisplayNames` resolver — over
**every** week at once, keyed by email, so one person carries one label through
the whole week scroller instead of gaining a disambiguating suffix only in the
weeks a namesake happened to be scored. Rankings are allow-listed to one reader
today, so this changes almost nothing visible — which is exactly why it is here:
a future widening of `canViewTeamRankings()` must not silently reopen the leak.

> **No peso amounts, anywhere.** [manager-my-team.md](./manager-my-team.md) (§"Managers
> do not see rates or pay") strips comp from every My Team surface, and this is the
> first roster surface where one teammate can see another's KPI row. Kane confirmed
> 2026-08-14: SP + tier only. Each person's own ₱ stays on the **KPI Results** tab,
> which is self-scoped.
>
> `bonus_catalog_applied.amount` is **not in the SELECT** — not selected-then-dropped.
> A test asserts both the returned row shape and the projection string, because a
> widened SELECT would ship pay over the wire even with a clean render.

### Policies

The department's policies, mirrored **verbatim** from the published pages under
`https://www.simple.biz/team-company-policies`. Grouped into
schedule / communication / conduct, with a link to the source page.

## Where rankings come from

A manager scores the week in the KPI Calculator, which writes one
`bonus_catalog_applied` row per member with the raw inputs in `vars`. For the
AI/API Team the assignment is the Payment Catalog's **"AI Team Bonus"**
(`bonus_msnh45vwee38zn33`, department-scoped to `devs`, weekly, PHP, created by
carla@simple.biz 2026-08-10):

```
=SP*15 + Project_SP*80
  + IF(Ranking=25, 1325, IF(Ranking=50, 530, IF(Ranking=1, 2650, 0)))
```

So `vars` is `{ SP, Ranking, Project_SP }`, and **`Ranking` is a tier flag, not a
position**:

| `vars.Ranking` | Badge | Adds |
|---|---|---|
| `1` | Rank 1 | ₱2,650 |
| `25` | Top 25% | ₱1,325 |
| `50` | Top 50% | ₱530 |
| `0` | *(no badge)* | ₱0 |

The **displayed position** (#1, #2, …) is derived by sorting on SP descending
(then project SP, then name — a stable order, so two people on equal SP never swap
between renders). It is not stored. A `Ranking` value outside the four above
degrades to unranked rather than inventing a tier.

> As of 2026-08-14 exactly **one** week exists (`2026-08-02`, 25 rows). The week
> scroller is built for the history to accumulate.

### Visibility

A week appears only once its `hsl_bonus_period_status` row for
`(department, period_start)` is **`ready` or `locked`** — mirroring
`getEmployeeKpiResults` exactly. A `draft` week is a manager mid-scoring and must
never reach the team. Rows with no `employee_email` are dropped rather than given a
placeholder identity.

### Which departments get a Rankings tab

`hasSpRankings()` tests the **data** — does any applied row carry a `vars.SP` key —
rather than a hardcoded department list. A second team put on the same bonus shape
lights up with no code change. Scoping (who may *read* whose department) is enforced
separately in the route.

That is still true after the 2026-08-29 allow-list: it gates the **viewer**, never
the department, so the "second team lights up" property survives — such a team would
light up for the allow-list only.

## Authorization

`GET /api/team-rankings?department=X` applies **two gates, in this order**.

### 1 — Rankings are allow-listed to one reader (2026-08-29)

Kane: *"Employee - AI/API Team - Rankings lets hide this please for everyone else
except kaner@simple.biz"* — confirmed the same day to mean **every department**, not
just `devs`, and **no elevated bypass**. `canViewTeamRankings()`
(`src/lib/rbac/rankings-viewers.ts`) runs before anything else; a caller who is not
on the list gets `{ weeks: [] }` and costs no query.

> **This is where the route stops mirroring `/api/team-roster`.** It used to match it
> exactly and this section used to say so — that is no longer true. An admin,
> payroll, finance, hr or viewer session now reads an empty list *here* while still
> reading any department's **roster**. The gate sits **above** the elevated-role
> branch deliberately: below it, those five roles would be the only people who kept
> full access, which is the opposite of the ask.
>
> It allow-lists the **viewer**, never the department — see
> [Which departments get a Rankings tab](#which-departments-get-a-rankings-tab).

The employee portal has no `FeatureViewKey` in `FEATURE_CATALOG`
(`src/lib/rbac/feature-permissions.ts`), so the admin per-tab permission grid cannot
express this today and a named constant is the honest form. Moving it into the grid
would mean adding an `employee` view there first.

### 2 — Department scoping (unchanged)

Still identical to `/api/team-roster`: elevated roles may read any department;
everyone else is limited to their own home department plus any department they
manage. An out-of-scope or empty `?department=` degrades to `{ weeks: [] }` rather
than 403, so the tab renders cleanly. Neither route is in `route-access.ts` — both do
their own in-route scoping, which is the established pattern for these
personal-portal reads.

The raw department label is sent to both routes; only the *display* label collapses
(`hsl:filing_specialist` scopes as itself, renders as "HSL").

Both gates return the same empty shape on purpose, so a denied viewer and a team
that was never scored are indistinguishable to the client. `rankings-viewers.test.ts`
pins the ordering against the source, because a gate that drifts below
`hasElevatedRole` still passes every behavioural test while leaking to five roles.

## Policies are display-only

> **Nothing in `team-policies.ts` drives logic.** Not payroll, not attendance, not
> PAB, not Hubstaff ingest, not any bonus. Kane, 2026-08-14: *"this will not affect
> any logic in the system this is mainly read only as to avoid confusion."*
>
> In particular the **"40 hours" in the Overtime Approval copy is NOT the payroll
> overtime threshold**, and the workday windows are NOT shift definitions. Do not
> wire a value from this file into a calculation.

The website is the source of truth for the text; the app mirrors it (captured
2026-08-14). There is no runtime fetch — this is static marketing copy that changes
approximately never, and a per-view outbound call to an external host would be a
needless dependency. When the site changes, update the bodies here.

### Ten published pages, twenty-five roster labels

| Roster label | key | Published as |
|---|---|---|
| AI/API Team | `devs` | AI/Automation |
| Accounting Team | `accounting` | Accounting |
| Callback Team | `callback` | Call Back |
| Discovery | `discovery` | Discovery |
| Edit Team | `edit` | Editors |
| Lead Gen | `lead_gen` | Lead Gen |
| PM Team | `pm_team` | Project Management |
| QC | `qc` | QC |
| Sales Assistant | `sales_assistant` | Sales Assistants |
| Social Media Team | `smm` | Social Media |

Note the rename in row one: the **roster** says "AI/API Team", the **website** says
"AI/Automation". Same team. `normalizeDeptToKey('AI/API Team') === 'devs'` is the hop,
and a test pins it.

Everything else — the HSL sub-teams, Client VA, HR, Site Building, Smart Staff,
Sales, Executive Assistants, the freelancer cohorts — has no published page and gets
`COMPANY_WIDE_POLICIES`.

> **The fallback deliberately omits the workday window and the time-off notice
> period.** Those are exactly the two policies that differ per team, and a default
> would tell someone the wrong shift. It shows the ten universal rules and points at
> their manager. A test pins the omission.

### Divergence from the S-Wall panel

`SWall.tsx`'s `CompanyPoliciesPanel` still carries an older company-wide set whose
Overtime Approval reads *"The weekly cap is 45 hours … beyond 45 hours"*. **Every**
published department page says **40**. That panel is a separate surface and was left
alone here deliberately — it is out of this change's scope, not agreed-stale. A test
pins all ten sets at 40 so the retired wording cannot creep back in through this file.

`src/components/employee/EmployeePolicies.tsx` was **dead code** (never imported
anywhere) and is superseded by this tab.

## Returning to the tab does not reload it

`EmployeeApp.tsx` keeps every visited tab mounted and merely hides the inactive ones
(`mountedTabs`), so `EmployeeTeam` is constructed once per session. Both of its
fetches key on the **raw department label**, which is stable for the life of the
session — so leaving and returning re-runs nothing.

Two things follow, and both are load-bearing:

- **Any new fetch here must key on something equally stable.** Keying on the active
  sub-tab, a page number, or an object identity would reintroduce a per-visit reload.
- **Sub-tab panes unmount** (they are swapped through `AnimatePresence`), so state
  that should survive a sub-tab hop lives in the parent. That is why the selected
  week index is held in `EmployeeTeam`, not in `RankingsPane`.

## Responsive & motion

- The tab is a **single scroll surface** —
  `flex h-full min-h-0 flex-col overflow-y-auto overscroll-y-contain [scrollbar-gutter:stable]`
  — per [responsive-design.md](../design/responsive-design.md) § "Whole-page scroll on
  mobile". The header scrolls with the content; nothing is pinned. (The previous
  version was missing `overscroll-y-contain` and the scrollbar gutter.)
- Content is capped at `max-w-7xl` and centred, so the grid does not stretch to
  absurd column widths on wide monitors.
- The sub-tab row scrolls horizontally on narrow phones with the scrollbar hidden.
- Only the two sanctioned ease curves are used (`[0.22, 1, 0.36, 1]`), with the
  §14.3 capped per-row stagger (`Math.min(i * 0.02, 0.2)`) on ranking rows.

## Related

- [manager-my-team.md](./manager-my-team.md) — the manager-side roster; the no-pay rule.
- [bonus-catalog.md](./bonus-catalog.md) · [payment-catalog-departments.md](./payment-catalog-departments.md) — where the AI Team Bonus is defined.
- [hsl-subdepartments.md](./hsl-subdepartments.md) — why `hsl:*` collapses to one label.
