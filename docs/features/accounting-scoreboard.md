# Accounting Scoreboard — Carla's team scoreboard, rebuilt in HRIS, on its own domain

The Accounting Scoreboard replaces Carla's "Accounting Scoreboard" Google Sheet. Her team types its
daily numbers (bucket and inbox counts at AM and PM, collections, compliance, payroll timing and
problems, PM buckets, sales onboarding, cancellations), and the board adds them up, keeps last week and
all-time on its own, and checks each section against the sheet's goals. Nobody copies and pastes at the
end of the week. It lives at `/accounting-scoreboard`, and on `ACCOUNTING_SCOREBOARD_HOST`
(`accounting-bonus.vercel.app`) it is the whole site. Built 2026-10-01 (session `9fe90c48`) on Kane's
*"just nextjs typescript … basically its in this project … just on a different domain"*. The analysis it
starts from, covering what every sheet section measures, who is in it and the sheet's own bugs, is
`docs/notes/2026-10-01-accounting-scoreboard-analysis.md`.

## Key files

| Piece | File |
| --- | --- |
| Tables, guards, lock-down | `references/sql/create/2026-10-01_accounting_scoreboard.sql` |
| Apply / verify (dry by default) | `scripts/apply-accounting-scoreboard-migration.mts` |
| The 10 sections (kind, days, slots, goals) | `src/lib/accounting-scoreboard/sections.ts` |
| Weeks (Sunday key) and days (US Eastern) | `src/lib/accounting-scoreboard/week.ts` |
| The sheet's math | `src/lib/accounting-scoreboard/scoring.ts` |
| One headline and one stop light per section | `src/lib/accounting-scoreboard/board.ts` |
| The stop light (green / amber / red, paced) | `src/lib/accounting-scoreboard/stoplight.ts` |
| Payroll Timing from HRIS (cycle, deadlines, score) | `src/lib/accounting-scoreboard/payroll-cycle.ts` |
| Dancing Queen preview | `src/lib/accounting-scoreboard/bonus-preview.ts` |
| Host rule for the domain | `src/lib/accounting-scoreboard/host.ts`, called from `proxy.ts` |
| Request parsing | `src/lib/accounting-scoreboard/validate.ts` |
| Member check, reads and writes | `src/lib/accounting-scoreboard/server.ts` (server-only) |
| Wire types | `src/lib/accounting-scoreboard/types.ts` |
| Routes | `app/api/accounting-scoreboard/` (`route.ts` GET board · `entries` PUT · `collections` POST/DELETE · `rows` POST/PATCH · `members` POST/DELETE · `sections` PATCH · `roster` GET) |
| Page (server guard) | `app/accounting-scoreboard/page.tsx` |
| UI | `src/components/accounting-scoreboard/` (`ScoreboardApp` with `Overview` · `SectionGrid` · `CollectionsPanel` · `PayrollCyclePanel` · `SetupPanel` · `SectionsDrawer` (the phone menu) · `shared`) |
| Tests | `src/lib/accounting-scoreboard/*.test.ts` (sections ↔ SQL pin, week, scoring, board, stoplight, payroll cycle, bonus preview, host, validate, names) |

## Who may open it: the board's member list, never an HRIS role

- **Managers** are the `admin` and `accounting` roles. They see Setup (rows, section switches and
  goals, extra members) and may delete anyone's logged collection.
- **Members** are everyone whose work email, or one of its alternates (`expandWorkEmailAliases`, the
  same identity bridge RBAC uses), is on a live **person row**, plus anyone on
  `accounting_scoreboard_members`. A member may edit any cell, as on the sheet, because one person
  routinely collects numbers for others. Every write is stamped with the session email.
- **Why not a role:** on 2026-10-01 only 11 people held `accounting`, and most of the PH team who type
  the numbers hold no HRIS role at all. `accounting` also opens payroll and bank data. Do not "simplify"
  this into `requirePageRoles(['accounting'])`.
- So the route is **not role-gated at the edge**. `/accounting-scoreboard` is deliberately absent from
  `ROUTE_REQUIRED_ROLES` (`route-access.ts`), and `host.test.ts` pins that the `/accounting` prefix does
  not swallow it. The **page server component** (`app/accounting-scoreboard/page.tsx`) is the gate. It
  runs the member check before the client shell renders or fetches, and every API route re-checks on
  every call.
- Anyone with a @simple.biz Google sign-in can authenticate (`auth-options.ts:199-207`). A person who is
  not on the roster gets in only through Setup → Members.

## Its own domain

- `proxy.ts` calls `decideScoreboardHost()` right after the bank and gift host blocks and before
  `PUBLIC_PATHS`, for the same reason they sit there: the rest of HRIS must never surface on a domain
  handed to a team. **Inert until `ACCOUNTING_SCOREBOARD_HOST` is set**, and only when the request's
  host matches it. On that host:
  - `/accounting-scoreboard`, `/api/accounting-scoreboard/*`, `/login`, `/auth-callback` and
    `/api/auth/*` **pass**, and the normal session gate still runs for them.
  - Any other page **redirects** to the board, so the bare host lands somewhere useful.
  - Any other API gets **403** `host_scoped`, not 404. HRIS's global pollers (the dispatch paid toast)
    stop on 401/403 and would retry a 404 for as long as the tab is open.
- **Unlike the bank and gift hosts, this one is signed-in.** `/auth-callback` must pass: the Google
  sign-in popup returns there, posts `oauth_done` and closes.
- **Sign-in needs no auth change.** On Vercel, NextAuth v4 takes its origin from the request's
  `x-forwarded-host` (`node_modules/next-auth/utils/detect-origin.js`, `process.env.VERCEL`), so the
  Google callback and the session cookie land on the scoreboard host. The one outside step is adding
  that host's callback URI to the Google OAuth client (Deploy notes). The cookie is per host, so a
  person signs in once on each domain.
- A separate Tickets domain was dropped on 2026-07-15 for the OAuth-redirect hassle
  (memory `tickets-board-deploy-steps`). This domain was Kane's own ask on 2026-10-01, and the hassle
  turned out to be one redirect URI.

## Sections and scoring

The sections, their days and their goals are code (`sections.ts`), pinned to the SQL CHECKs by
`sections.test.ts`. A manager can switch any section off, and its rows and numbers are kept, or
override its goal. Carla asked to track less than the sheet does, so the switch exists instead of a
hard-coded subset.

| Section | Kind | Days | Score / headline | Goal |
|---|---|---|---|---|
| Accounting Buckets | AM/PM | Mon–Fri | Comp = Σ(AM − PM) → tiers <0 → 1, 0 → 2, 1–5 → 4, 6–10 → 6, 11–15 → 8, >15 → 10; headline = average row score | ≥ 8 |
| Collections | log | Mon–Fri | team points | ≥ 85 |
| PM Buckets | daily + meeting tick | Mon–Fri | Σ of each PM's daily average | — |
| Customer Sales Onboarding | daily | Mon–Fri | week total | — |
| Email Inbox | AM/PM | Mon–Fri | 10 − average PM count (0 → 10, ≥ 9 → 1); headline = score of the team average | ≥ 9 |
| Chargebacks | AM/PM | Mon–Fri | net cleared Σ(AM − PM) | — |
| Compliance | daily | Mon–Fri | week total | ≥ 30 |
| Cancellation Call Recordings | daily | Mon–Fri | week total + share | — |
| Payroll Timing | **from HRIS, nothing typed** (§ Payroll Timing fills itself) | Tue · Fri (its deadlines) | cycle score 0–100% | ≥ 100% |
| Payroll Problems | daily | Mon–Fri | week total | < 20 |

- **The sheet's formulas are kept exactly**, apart from one deliberate change. The sheet's `SUM`
  treated a blank PM as 0, so a day with an AM count and no PM was credited as fully cleared
  (Thursday's bucket showed +68 with nothing typed). **Here a day counts only when both numbers are in.**
  An AM without a PM shows as *PM pending* today and *PM missing* once the day is over, and is never
  credited. Do not "fix" a low score by counting those days.
- The other quirks are the sheet's rules, kept for Carla to change: a day bucket's fill on the day
  before counts against it, an empty bucket all week scores 2, and the paid tier counts points.
- **The sheet's seven cell-reference bugs cannot recur** (§ 6 of the analysis): every total is computed
  once over every row. `scoring.test.ts` pins that a total includes the last row (the sheet's WTD dropped
  Shayla, 95 instead of 113).
- **Absence is not zero** (`ui-standards.md` § 12.5). A cleared cell is a **deleted** entry, never a
  stored 0, and anything never typed prints "—". Nothing logged is "—", not 0 points.

## Payroll Timing fills itself

Kane, 2026-10-01, with a screenshot of Carla's "Payroll Scoreboard (Timing)": per week, when the cycle
**started** (goal Tuesday 12:00 PM) and **closed** (goal Friday 12:00 PM), each on time or not, a cycle score,
and an Average over This week / Last week / Two weeks ago. Every time on that sheet is one of HRIS's **own
audit events** (read-only check, 2026-10-01: all five sheet times matched to the minute, Eastern), so nobody
types this section. The same day it replaced a per-person start/end-time grid (goal "< 20 hours").

- **Started = the week's FIRST `payroll.dispatch.locked`.** Start Processing turns on the wizard's
  `payroll.dispatch_locked` lock (`processing-guard.ts`). A later re-lock in the same week does not move it.
- **Closed = the `payment_cycle.closed` of the cycle that week PAYS**, the Sunday–Saturday before it, matched on
  the **parsed date range** in the source file and never on the file name (memory
  `orphanage-source-file-drift-hides-a-week`). A `payment_cycle.reopened` after the close opens it again
  (`cycle-closeout.md`), and the close that sticks is the one judged.
- Deadlines are noon **Eastern**, and on the dot is on time. Each check is `on_time`, `late`, `pending` (not
  yet, deadline still ahead) or `missed` (not yet, deadline passed, so it counts as late). Pending prints "—",
  never Late.
- **Cycle score = 25% for starting on time + 75% for closing on time**, scored only once both are decided.
  This is CHOSEN, not read from the sheet: it reproduces the sheet's two scored rows (start on time, close
  late = 25%; both late = 0%). The panel prints the formula. If Carla's real formula differs, change
  `SCORE_WEIGHTS` and the test that pins it.
- The Average row is the sheet's: each column over the weeks where it is decided (start 2 of 3 = 67%, close
  0 of 2 = 0%, score (25 + 0) ÷ 2 = 13%). `payroll-cycle.test.ts` replays the real events and asserts the
  sheet cell for cell.
- The board reads four columns (`action`, `created_at`, `resource_id`, `details->>source_file`) of three
  actions from `audit_log`, two weeks either side of the week shown, paged. It never reads or writes the
  close-out record. The 3 rows and 1 entry typed under the old grid are kept and not shown.

## Stop light

Kane, 2026-10-01: *"if its performing badly lets make the feel look that we are failing kind of RED and if its
GOOD then its green and orange is for middle … kinda like a stop light"*. One rule (`stoplight.ts`) feeds the
Overview cards, every goal chip and every row score, so a card and its tab can never disagree.

- **green** = goal met, or on pace. **amber** = close: at least 80% of an "at least" goal, or under 120% of
  a "below" goal. Amber is the stop light's middle and ui-standards § 6.3's caution tone. **red** = behind.
  **none** = no numbers, no goal, or too early to call. Absence is never a colour.
- **This week's running totals are judged on PACE**, against goal × the share of the section's days that are
  over (Thursday = 3 of 5). Without it every Monday is red. A past week is judged on the full goal. Scores
  and averages are never paced. For a "below" goal, going over the FULL goal is final whatever the pace.
- Payroll Timing's light comes from its checks: every decided check on time = green, none = red, a mix =
  amber. So a cycle that started on time is green until Friday decides the close.
- An Overview card shows the light as a real stop light (a dark housing, the live lamp glows) **and** the
  word (On track / Close / Behind). Colour is never the only signal. A card tints its border and background,
  never with a thick side border (the craft floor). Each card carries its KPI's own icon (`SECTION_ICON`)
  and a 5xl number (Kane, same day: *"make the numbers bigger … add like icons that match the kpi card"*).
  Until Payroll Timing is scored, its card shows when this week's cycle started.

## Weeks and days

- A week is keyed by its **Sunday**, the HRIS pay week and the `period_start` the KPI calculator uses, so
  a board week and the Dancing Queen week it feeds share a key. The board shows Mon–Fri, and no section
  keeps a weekend (`sections.test.ts`).
- Days are **US Eastern** dates (`todayEastern()`). A Manila evening shift entering Monday's numbers is
  still on Monday. Future dates are refused at write and disabled on screen.
- "Last week", WTD, All Time and the record are **computed from stored entries and never typed**. That
  is what replaces the sheet's typed "Lst Wk" columns and hand-filled History tabs.

## The collections log

- One line per collected account: day, rep row, business, points, optional USD amount. It replaces the
  sheet's Collection Count tab and its ~40 hard-coded `DATE()` formulas. Only Mon–Fri can be logged,
  the days the sheet and the bonus count.
- **Append-only.** Its day totals are the numbers the Dancing Queen Bonus is typed from. A trigger
  refuses every UPDATE except the one soft delete (`deleted_at` + `deleted_by` together), and an
  un-delete is refused. A mistake is deleted and logged again. Only the person who logged a line, or a
  manager, may delete it.
- A rep row archived mid-week still shows, read-only, for every week it has numbers in. Removing a rep
  never makes a collection drop out of a team total. Rows are archived, never deleted or un-archived.

## The bonus preview (display only)

- The board **writes no pay**. The Dancing Queen Bonus (Payment Catalog, formula, assigned to
  `accounting`, day variables Monday…Friday) is still applied in the KPI calculator by hand.
- The preview evaluates the **live catalog formula** (`evaluateFormula`), so a catalog edit shows up
  here with no code change. It runs the formula twice, **on points (what HRIS pays today) and on
  accounts**, and never picks one. Paid weeks 2026-08-02 → 09-20 matched points on all 8 weeks, and the
  code labels the inputs "collection counts". That is an open money ruling (audit Open item 315).
- It refuses to preview rather than guess: no formula bonus, two of them, an invalid formula, or one
  that reads any variable besides the five day names (a missing variable would silently read 0,
  `formula.ts:308-311`).
- **Wiring the day totals into `bonus_catalog_applied` is a money path.** It needs `hardening` and
  Item 315 ruled first.

## Writes

- Every body is parsed in `validate.ts` first, and the SQL CHECKs are the last line. Counts are 0–100,000
  (`MAX_COUNT`; the biggest typed by 2026-10-01 was 94) with at most 2 decimals, times are whole minutes
  0–1440, the meeting tick is 0/1, and dates run from 2024-01-01 to today.
- **Points are WHOLE numbers, 0–100.** Every point on the sheet's 9,984-row log and on the board is an
  integer, so a decimal in Points is a dollar amount typed into the wrong box. That was the "error
  mentioning decimals" Carla hit (meeting, 2026-10-01). The Points field takes digits only, and the server
  refuses a decimal with *"Points are a whole number, usually 1. The dollar amount goes in Amount (USD)."*
  Amounts are dollars and cents (at most 2 decimals, at most $10,000,000).
- **Every refusal names the rule it broke** (negative, too big, too many decimals), never a catch-all. The
  old single message blamed decimals for a range error. The Collections form checks the same rules before
  it sends and shows one line under the form naming the field, whose box gets the red `aria-invalid`
  border, so an error never pushes the boxes out of line.
- **Payroll Timing takes no writes**: it has no slots, so `entryAllowed()` refuses every one.
- `entryAllowed()` refuses a slot the row's section does not have, or a day that section does not keep.
  Archived rows are read-only.
- A row with a work email **is** that HRIS person, so the address must be on `active_employees`.
  Anyone else (a queue, an inbox, someone not on the roster) is a named row. The Setup picker filters
  by department but adds people one by one, because sections cross departments: Accounting Team, USEE,
  Sales and PM Team (analysis § 4).
- The roster picker selects `Name`, `Department` and `Work Email` only, paged, and prints departments
  through `formatDeptLabel` (`dept-label-render.test.ts`).

## Motion and controls (polished 2026-10-01)

- **Dropdowns are `SmoothSelect`** (`ui-standards.md` § 9.4), never a native `<select>`, whose popup
  ignores the app theme. Every one is `accent="orange" align="start" portal`, because the content
  area scrolls and would clip an in-flow menu. Long lists are `searchable`: Department always, and
  Rep when there are more than 8.
- **Every `<table>` carries `table-keep`.** Below 640 px, `src/index.css` collapses any table without
  it into stacked cards. These are computational grids, so on a phone they scroll sideways instead,
  with the row label stuck to the left. Drop the class and the grid falls apart on a phone.
- **Tabs glide** (§ 11.1): one orange indicator via `SlidingPill`, 0.28 s on `[0.22, 1, 0.36, 1]`.
  Each row has its own `layoutId` (`acct-sb-section-tab`, `acct-sb-setup-area`); a shared one would
  fly the indicator between rows. The panel slides toward where you moved (a later tab or week from
  the right, 0.22 s in and 0.14 s out), keyed on `` `${tab}:${weekStart}` ``, inside `overflow-x-clip`
  so the slide never spawns a scrollbar. A background refresh never changes that key, so it never
  replays the slide.
- **A total that changes sweeps orange once** (`Flash`, the Issues-tab settle curve). The sweep is
  scoped to the week, so switching weeks is new data and nothing sweeps. It shows which totals your
  number moved, and on refresh where a teammate's did. It is colour only, so it **stays on under
  reduced motion** (§ 14.3: the signal is the confirmation).
- **A cell answers its save** with an emerald ring that settles, or rose when the save is refused.
  Saving dims the cell gently instead of flickering.
- Log lines, Setup rows and members rise in and drift out while the rest close the gap
  (`layout="position"`), and the podium re-orders by gliding. All movement is gated on
  `useReducedMotion()`.
- **A box widens past 4 characters** (`w-14` → `w-20`), so a number up to the 100,000 limit is never cut
  off, and a day total sits in a box-wide span (`min-w-14`) that grows with it. That answers Carla's
  question about AM/PM limits (meeting, 2026-10-01).
- **A log line never cuts text off**: the business name wraps and the amount is never truncated (Carla:
  *"the text cuts off"*).
- **A failed week change** keeps the last good board under the "Couldn't refresh" bar, the same as a
  failed background refresh. It never shows the old week silently.
- **AM/PM columns share one centre line** (`PAIR_CELL` in `SectionGrid.tsx`): the AM/PM label, the
  3.5rem box and the day total. A footer number is a box-wide right-aligned span (`BoxAligned`: `w-14`,
  `pr-[7px]` = the box's 1px border + `px-1.5`), so total digits stack under the typed digits. The
  one-number grids use the same shape, and PM Buckets puts the day's meeting count under the tick
  column. Give the header or the body cell its own padding and the labels drift off the boxes again
  (Kane, 2026-10-01: *"align it to the actual boxes"*).
- **Log collection's disabled state is solid grey**, not the Button's default 50% opacity, which
  smeared the orange gradient over the orange-tinted form in dark mode (Kane's "Collections UI bug").
  The text fields' focus ring is orange, matching the dropdowns beside them. On a phone a log line
  gives the business name its own full-width line, and the "by" handle shows from `sm`.
- **Below `md` (768 px) the tabs are in a burger menu** (Kane, 2026-10-01: *"The mobile view please make
  sure the tabs are in burger"*). The tab row is `hidden md:flex`. On a phone the header has the burger,
  the title and the **name of the tab you are on** (the signed-in email moves to the menu's footer).
  `SectionsDrawer` is the dashboard shell's mobile drawer (ui-standards § 1.1, § 2, § 3.1, § 16): it slides
  in from the left over a backdrop, with `id="acct-sb-sidebar-nav"` and `role="navigation"`. The burger
  carries `aria-expanded` and `aria-controls`, and the burger and the close-X are outline icon Buttons.
  - **While it is open the page behind it is `inert`** (no focus, no clicks, nothing read out). Escape,
    the backdrop, the X and picking a tab all close it. Opening focuses the tab you are on, and closing
    hands focus back to the burger.
  - **Growing past `md` closes it.** The menu is `md:hidden`, so one left open across a resize would
    leave an inert page with no visible way out. Do not drop the `matchMedia` listener.
  - Each section in the menu carries its stop-light dot (with the word for screen readers) from
    `summarizeAll`, the same call as the Overview cards, so the menu and the cards never disagree.
    Overview and Setup carry none.
  - Reduced motion drops the slide and keeps a fade.
- Verified in headless Chromium against the compiled Tailwind stylesheet at 1360 px, 1100 px and a
  390 px frame (not signed in: the panels rendered on fixture data). The burger menu was verified on
  2026-10-01 against the real `ScoreboardApp`, bundled with a mocked board GET, with 26 scripted checks at
  390, 700, 1024 and 1360 px, light and dark, and under reduced motion.

## Live refresh

- A background refresh runs every 45 s while the tab is visible, and on focus. It **never runs while a
  cell is being edited** (an editing counter). A focused cell also keeps its own draft, so someone
  else's save can never overwrite what you are typing.
- A failed refresh keeps the last good board on screen under a "Couldn't refresh" bar. It never blanks
  the board or shows zeros. There is no realtime: the tables are service-role only.

## Not built (on purpose)

- The sheet's status strip (Working / Lunch / Break) and the per-person task checklists (Carla's
  Tracker). Both are outside the bonus and can come later.
- Importing the sheet's history (~10k collections log rows and past weeks) is a production write and
  was not approved, so All Time starts at go-live.
- Per-person or per-section bonuses after Carla's revamp, and any write to pay (Item 315).

## Deploy notes

- **Migration: APPLIED 2026-10-01** by session `9fe90c48` on Kane's *"run the migration yourself
  please"*. `--apply` committed after all 121 checks passed, `--verify` re-passed 121, the five tables
  hold 0 rows, and the anon key is refused (`42501`). Re-check any time with
  `node --import tsx scripts/apply-accounting-scoreboard-migration.mts --verify`. (Do not double-click
  the `.mts`: Windows opens it as video.)
- **PENDING (Kane):**
  1. Vercel: add `accounting-bonus.vercel.app` to this project.
  2. Vercel env: `ACCOUNTING_SCOREBOARD_HOST=accounting-bonus.vercel.app` (Production), then redeploy.
  3. Google Cloud → the HRIS OAuth client → Authorized redirect URIs: add
     `https://accounting-bonus.vercel.app/api/auth/callback/google`. Until then, sign-in on that host
     fails with `redirect_uri_mismatch`, but `/accounting-scoreboard` on the main HRIS host works.
  4. The push.
- Locally, `.env.local` is **production**: numbers entered on `localhost:3000/accounting-scoreboard`
  are real board data.
- No n8n, no cron, no new notification type.
