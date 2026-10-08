# Accounting Scoreboard — Carla's team scoreboard, rebuilt in HRIS, on its own domain

The Accounting Scoreboard replaces Carla's "Accounting Scoreboard" Google Sheet. Her team types its
daily numbers (bucket and inbox counts at AM and PM, collections, compliance, payroll timing and
problems, PM buckets, sales onboarding, cancellations), and the board adds them up, keeps last week and
all-time on its own, and checks each section against the sheet's goals. Nobody copies and pastes at the
end of the week. It lives at `/accounting-scoreboard`, and on `ACCOUNTING_SCOREBOARD_HOST`
(`accounting-bonus.vercel.app`) it is the whole site. Built 2026-10-01 (session `9fe90c48`) on Kane's
*"just nextjs typescript … basically its in this project … just on a different domain"*. The analysis it
starts from, covering what every sheet section measures, who is in it and the sheet's own bugs, is
`docs/notes/2026-10-01-accounting-scoreboard-analysis.md`. **Round 3** (2026-10-06, session `48c8828b`) built
Carla's email "SCOREBOARD UPDATES" (2026-10-02), forwarded by Kane: her Buckets score, Payment Verified on
collections, PM Buckets' No Meeting Streak, Chargebacks split into Open Disputes and Outcomes, a Problem Type on
every payroll problem, and custom sections.

## Key files

| Piece | File |
| --- | --- |
| Tables, guards, lock-down | `references/sql/create/2026-10-01_accounting_scoreboard.sql` |
| Round 3: custom sections, row flags, Outcomes slots, Payment Verified, the problem log and types | `references/sql/create/2026-10-06_accounting_scoreboard_round3.sql` |
| A custom section shown inside a built-in tab (`host_section_key`, 2026-10-07) | `references/sql/create/2026-10-07_accounting_scoreboard_custom_section_host.sql` |
| Win/loss flags on Outcomes lines (`rows.outcome`) + 0–1000 payroll problems (2026-10-07) | `references/sql/create/2026-10-07_accounting_scoreboard_outcomes_and_zero_problems.sql` |
| Hidden from the Overview (`show_on_overview` on both section tables, 2026-10-07) | `references/sql/create/2026-10-07_accounting_scoreboard_overview_visibility.sql` |
| A Pre-arb flag on Outcomes lines (`rows.outcome = 'pre_arb'`, 2026-10-07) | `references/sql/create/2026-10-07_accounting_scoreboard_pre_arb_flag.sql` |
| Apply / verify (dry by default) | `scripts/apply-accounting-scoreboard-migration.mts` · `scripts/apply-accounting-scoreboard-round3-migration.mts` · `scripts/apply-accounting-scoreboard-custom-host-migration.mts` · `scripts/apply-accounting-scoreboard-outcomes-zero-migration.mts` · `scripts/apply-accounting-scoreboard-overview-visibility-migration.mts` · `scripts/apply-accounting-scoreboard-pre-arb-flag-migration.mts` |
| The 11 built-in sections (kind, days, slots, goals), custom sections, tabs | `src/lib/accounting-scoreboard/sections.ts` |
| Weeks (Sunday key) and days (US Eastern) | `src/lib/accounting-scoreboard/week.ts` |
| The sheet's math | `src/lib/accounting-scoreboard/scoring.ts` |
| The No Meeting Streak's sentence and date pills | `src/lib/accounting-scoreboard/meeting-pills.ts` (+ `.test.ts`) |
| One headline and one stop light per section | `src/lib/accounting-scoreboard/board.ts` |
| The stop light (green / amber / red, paced) | `src/lib/accounting-scoreboard/stoplight.ts` |
| The Team Score (card → group → team, its bands) | `src/lib/accounting-scoreboard/team-score.ts` (+ `.test.ts`, Carla's worked example) |
| Payroll Timing from the Wizard (cycle match, deadlines, no_record, score) | `src/lib/accounting-scoreboard/payroll-cycle.ts` |
| Dancing Queen preview | `src/lib/accounting-scoreboard/bonus-preview.ts` |
| Host rule for the domain | `src/lib/accounting-scoreboard/host.ts`, called from `proxy.ts` |
| Request parsing | `src/lib/accounting-scoreboard/validate.ts` |
| Member check, reads and writes | `src/lib/accounting-scoreboard/server.ts` (server-only) |
| Browser cache (board per week, Setup's roster) | `src/lib/accounting-scoreboard/tab-cache.ts` (+ `.test.ts`), on `src/lib/dashboard-cache/create-tab-cache.ts` |
| Loading modal: lines ↔ reads, the stream, the fail-closed assembler | `src/lib/accounting-scoreboard/load-progress.ts` (+ `.test.ts`), on `src/lib/refresh-progress/refresh-progress.ts` · the dialog `src/components/accounting-scoreboard/ScoreboardLoadDialog.tsx` |
| Wire types | `src/lib/accounting-scoreboard/types.ts` |
| Routes | `app/api/accounting-scoreboard/` (`route.ts` GET board, `&stream=1` streams it for the loading modal · `entries` PUT · `collections` POST/DELETE · `collections/verify` POST · `problems` POST/DELETE · `problem-types` POST/PATCH · `custom-sections` POST/PATCH · `rows` POST/PATCH · `members` POST/DELETE · `sections` PATCH · `roster` GET) |
| Page (server guard) | `app/accounting-scoreboard/page.tsx` |
| UI | `src/components/accounting-scoreboard/` (`ScoreboardApp` with `Overview` · `SectionGrid` · `CollectionsPanel` · `ProblemsPanel` · `PayrollCyclePanel` · `SetupPanel` · `SectionsDrawer` (the phone menu) · `shared`) |
| Tests | `src/lib/accounting-scoreboard/*.test.ts` (sections ↔ SQL pin, week, scoring with Carla's reference code as the oracle, board, stoplight, payroll cycle, bonus preview, host, validate, names) |

## Who may open it: the board's member list, never an HRIS role

- **Managers** are the `admin` and `accounting` roles. They see Setup (rows, section switches and
  goals, their own custom sections, the Payroll Problems types, extra members), may delete anyone's
  logged collection or problem, and may uncheck anyone's Payment Verified tick. Carla's "Admins should be
  able to add new types" means these managers: the board has no other admin.
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

The built-in sections, their days and their goals are code (`sections.ts`), pinned to the SQL CHECKs by
`sections.test.ts`, which reads the CHECKs in force from the round-3 SQL and also pins that round 3 only
added to the 2026-10-01 lists. A manager can switch any section off, and its rows and numbers are kept, or
set its goal (§ Goals in Setup), or take its card off the Overview while it keeps its tab (§ Hidden from the
Overview). Carla asked to track less than the sheet does, so the switch exists instead of a hard-coded subset.
Managers can also add sections of their own (§ Custom sections).

| Section | Kind | Days | Score / headline | Goal |
|---|---|---|---|---|
| Accounting Buckets | AM/PM | Mon–Fri | **Carla's rule** (§ Buckets): Score = 10 × Completed ÷ (Completed + Open); headline = the overall, 10 × Σ Completed ÷ Σ(Completed + Open) over the scored buckets | ≥ 8 |
| Collections | log (+ Payment Verified) | Mon–Fri | team points | ≥ 85 |
| PM Buckets | daily + meeting tick | Mon–Fri | Σ of each PM's daily average (an average: never paced); No Meeting Streak over the grid, with the week's date pills | < 30 avg (Carla, 2026-10-07) |
| Sales — Payments (the Sales Onboarding tab; "Customer Sales Onboarding" until 2026-10-07) | daily | Mon–Fri | week total | none by default; "at least N payments", set in Setup |
| Email Inbox | AM/PM | Mon–Fri | 10 − average PM count (0 → 10, ≥ 9 → 1); headline = score of the team average | ≥ 9 |
| Chargebacks · Open Disputes | AM/PM | Mon–Fri | **scored like Buckets** since 2026-10-07: the overall 0–10, over the lines not marked "due in 7 days"; open now and the due-in-7-days line are called out beside it | none by default; a 0–10 score, set in Setup |
| Chargebacks · Outcomes | $ and # a day, shown inside the Chargebacks tab | Mon–Fri | **win ratio** = wins ÷ (wins + losses + Pre-arb), by count; per outcome: week $ (signed by its flag) and week #; **Net** = wins − losses − Pre-arb, in $ | ≥ 50% (Carla, 2026-10-07) |
| Compliance | daily | Mon–Fri | week total | ≥ 30 |
| Cancellation Call Recordings | daily | Mon–Fri | week total + share | none by default; "at least N reviewed", set in Setup |
| Payroll Timing | **from the Payroll Wizard, nothing typed** (§ Payroll Timing fills itself) | Tue · Fri (its deadlines) | cycle score 0–100% | ≥ 100% |
| Payroll Problems | **log**, one line per problem (or batch) with its type (§ Payroll Problems) | Mon–Fri | week total | < 20 |
| a manager's custom section | one number a day, or AM/PM scored like Buckets; a tab of its own or shown inside a built-in tab | Mon–Fri | week total, or the Buckets overall | optional |

- **A blank is never a 0.** The sheet's `SUM` treated a blank PM as 0, so a day with an AM count and no PM
  was credited as fully cleared (Thursday's bucket showed +68 with nothing typed). That cannot happen here:
  Buckets reads only the numbers somebody typed (§ Buckets), and an AM without a PM still shows as *PM pending*
  today and *PM missing* once the day is over. Do not "fix" a low score by reading a blank as 0.
- The scoring rules are Carla's to change. She changed Buckets' on 2026-10-02 (§ Buckets). The paid tier
  still counts points (Open item 315).
- **The sheet's seven cell-reference bugs cannot recur** (§ 6 of the analysis): every total is computed
  once over every row. `scoring.test.ts` pins that a total includes the last row (the sheet's WTD dropped
  Shayla, 95 instead of 113).
- **Absence is not zero** (`ui-standards.md` § 12.5). A cleared cell is a **deleted** entry, never a
  stored 0, and anything never typed prints "—". Nothing logged is "—", not 0 points or 0 problems.

## Buckets: Carla's Completed, Open and Score (2026-10-02)

Carla's email, § 1, replaced the sheet's Comp = Σ(AM − PM) and its tiers. Her reference code is
`clearedFromReadings` in `scoring.ts`, and `scoring.test.ts` runs her code verbatim as the oracle.

- **Readings** are Mon AM, Mon PM, Tue AM … Fri PM in order, **with every blank skipped**.
- **Completed** = the sum of every decrease between back-to-back readings, overnight included (Mon PM →
  Tue AM). An increase is new work and never counts against it.
- **Open** = the latest reading.
- **Score** = 10 × Completed ÷ (Completed + Open), one decimal (`+(…).toFixed(1)`). 80% cleared = 8.0, the goal.
- A bucket that was **0 all week** is **N/A**: no score, and left out of the overall. A bucket with nothing
  typed is "—".
- A **weekday Collections bucket** (the row's `bucket_day`, set in Setup → Rows; seeded 2026-10-06 on
  "Mon (Collections)" … "Fri (Collections)") is **Pending** until its own day's PM reading is in, and is left
  out of the overall. Once its day is over with no PM it says **PM missing** (the board's existing word for
  that state), still left out. A bucket's day is marked on the row, not read from its label, so a rename
  keeps it.
- **Overall** (the section headline, the Overview card and the goal) = 10 × Σ Completed ÷ Σ(Completed + Open)
  over the scored buckets only. It replaced the average of the row scores.
- What changed from the old rule, on purpose: a drop across a missing PM now counts, because both ends are
  real readings (Mon AM 50, Mon PM blank, Tue AM 40 → 10 completed); the old rule dropped that whole day. A
  blank is still never read as 0.
- **Seen on the first real week** (2026-10-06): a weekday bucket refilled late in the week for next week shows
  that refill as Open (last week's "Mon (Collections)": 94 completed, 76 open on Friday PM → 5.5). That is
  Carla's formula as written; whether her day buckets should stop at their own day is hers to say.

## Chargebacks: Open Disputes and Outcomes

Carla's email, § 4, split the tab in two. Both sections sit on the one Chargebacks tab.

- **Open Disputes** keeps its AM/PM grid and, since 2026-10-07, is **scored like Buckets** (Carla, via Kane:
  *"Chargebacks Disputes - productivity formula same as the regular buckets"*): Completed, Open and Score per
  line, and the headline is the overall, 10 × Σ Completed ÷ Σ(Completed + Open) over the scored lines (§ Buckets).
  Until then the headline was how many are open now. That number is still shown, as a chip beside the score and
  a line on the Overview card. There is no default goal; a manager sets one in Setup (§ Goals in Setup).
- The line that counts the disputes due in the next 7 days is marked on the row (`due_soon`, Setup → Rows;
  seeded on "Disputes due in 7 days") and is **called out**: an amber chip in the header, an amber line in the
  grid, and a line on the Overview card. **It is part of "open", so it is never added to it, never scored and
  never in the overall**. Its score cell says *Called out*. The Day total leaves it out: adding it would count those
  disputes twice. Before 2026-10-07 the grid had no Day total at all, for the same reason.
- **Outcomes** (section `chargeback_outcomes`) holds Pre-arb, Wins and Losses: per day, the **dollar amount**
  (`usd`, dollars and cents) and the **number of chargebacks** (`count`, a whole number). Carla's example:
  one dispute won for $99 → Wins: $99 / 1. Each outcome has its week $ and week #. Counts are never added across
  outcomes.
- **Signs and the Net** (Carla, 2026-10-07 meeting, item 392: *"a loss is a negative, but I can't put a dash right
  here […] I want to show like it's actually we're in the hole"*; Kane: *"Wins positive. PR losses have negative."*;
  Carla: *"Yes."*). **The sign comes from the line's flag, never from a typed minus** (CHOSEN in the plan): amounts
  are typed positive, every box keeps its 0–100,000 rule, and a typed minus beside a "loss" flag cannot
  double-negate. A Loss or Pre-arb line's week $ and last week's $ print with a minus, in rose ("−$244.00"); a win
  prints as typed; an unmarked line prints as typed and is left out of the Net (`signedOutcomeUsd`).
  - **Net = wins − losses − Pre-arb, in dollars** (`outcomesNet`, summed in whole cents): a footer line under the
    win ratio, this week and last, emerald at $0 or above and rose below ("+$19.00", "−$31.00"), and a header chip.
    Nothing marked or nothing typed is "—", never $0.00; a typed $0 is a real $0.00.
  - **The $25 fee per loss is NOT added** (plan W0.3 (d)): Carla said a loss costs *"that and $25 on top of
    that"*, but whether the fee is typed into the amount or added by the board is hers to say (meeting, question 2).
    Until she says, the Net is the typed amounts only, and the footer says so.
  - This replaced the rule that there was no total across outcomes (*"a win plus a loss means nothing"*, round 3,
    2026-10-06): Carla asked for the Net on 2026-10-07.
- **The win ratio** (Carla, via Kane, 2026-10-07: *"I need to get a win ratio of 50% or higher each week"*) is
  Outcomes' headline: **wins ÷ (wins + losses + Pre-arb), by COUNT** (the number of chargebacks, never dollars),
  one decimal. **Pre-arb counts as a loss** (below). Its goal is **≥ 50%**, a ratio, so it is never
  paced. Nothing decided is "—", never 0%; all lost is a real 0%. It shows as the grid's *Win ratio* footer, a
  header chip ("3 won · 1 lost"), and an Overview card.
- **What a line counts as is marked on the row** (`rows.outcome`: `win`, `loss`, `pre_arb` (since 2026-10-07) or
  null, Setup → Rows → "Counts as a win / a loss / Pre-arb / Not counted"), **never read from its label**, the same
  as `bucket_day` and `due_soon`, so a rename keeps it. CHECK `acct_sb_rows_outcome_valid` allows it only on an
  Outcomes line (and the server refuses it elsewhere, naming the rule). The 2026-10-07 outcomes migration flagged
  the live "Wins" and "Losses"; the Pre-arb flag migration flags the one live "Pre-arb" (its script refuses unless
  exactly one live line matches, and never overwrites a line a manager marked). Several lines may count as wins,
  and they add up. With no line marked, the footer says so instead of showing a ratio or a Net.
- **Pre-arb counts as a loss** (Carla, 2026-10-07 call: *"We consider prearb as a loss, but prearb just means that the
  bank can't decide who's going to win or lose this […] it's technically we haven't gotten our money back, so it's
  still considered a loss"*; **ruled by Kane on 2026-10-07**, W0.1 = (a), Open item 392). It replaced the CHOSEN
  *"Pre-arb left out"* (session `728157e2`, item 387). The header chip and the Overview card say how much of "lost"
  is Pre-arb ("2 lost (incl. 1 Pre-arb)"). On the 10-07 data it changed nothing: Pre-arb's count was 0.
- CHOSEN (session `728157e2`), not Carla's words: the count, not dollars. If she means dollars, change `winRatio` in
  `scoring.ts` and its test.
- Outcomes shows inside the Chargebacks tab while Open Disputes is on. If Open Disputes is switched off,
  Outcomes takes a tab of its own, so it never disappears silently (`tabSections`). It has its own switch, and
  since 2026-10-07 **its own Overview card** (the win ratio is its single number), right after Open Disputes'.
- The old AM/PM rows Pre-arb, Wins and Losses were **archived, not deleted**, on 2026-10-06. They still show,
  read-only, for the weeks that hold their numbers (all 0s typed on Oct 5), and then drop away.
- **Carla's 2026-10-01 asks (Open item 317 (a)) were answered on 2026-10-07 and built** (item 392): Pre-arb and
  Losses negative, wins positive (not "won chargebacks as negative losses"), and a Net. **Still not built:** the
  "two weeks ago" column; the grid shows this week and last.

## PM Buckets: the No Meeting Streak

Carla's email, § 3. **The number** is the calendar days since the last day **any** PM meeting was ticked,
counted to today (US Eastern). It is all time: it runs across weeks and drops to 0 only on a day a meeting is
ticked. Unticking the only meeting on a day moves it back to the one before. It is **computed from the ticks,
never stored** (`noMeetingStreak`; the board reads the latest ticked day through the row's section, archived
PM rows included, because the meeting happened). A tick re-reads it at once instead of waiting for the next
refresh. It turns amber once a week has gone by (7 days or more, `streakIsLong`). Before any meeting was ever
ticked it reads "—".

**How it is shown (2026-10-07, item 391).** Carla: *"Can you make this prettier? Just like we want it to be
like, yes, five days, no meeting. Keep it going, guys."* Kane: *"date pills"*. A strip between the tab's
header and the grid (`NoMeetingStreak` in `SectionGrid.tsx`, words and pills from `meeting-pills.ts`):

- **Her sentence:** *"5 days, no meeting. Keep it going!"*, the number set heavier. **0 has words of its own**
  (*"Meeting today. The streak starts again tomorrow."*), so the board never cheers "0 days, no meeting".
  Never ticked: *"— No meeting has been ticked yet."* Under it: *"Last meeting ticked Fri Oct 2. Counts every
  calendar day, all time."*
- **Date pills, one per day the section keeps** (`datesFor(weekStart, section.days)`, Mon–Fri), for **the week
  on screen**, captioned *This week* (Saturday included) or its range (*Sep 28 – Oct 2, 2026*). **The number
  stays all time**, so on a past week the pills change and the sentence does not. A day is **No meeting**
  (emerald, a check), **Meeting** (neutral, a calendar) or **Ahead** (dashed, a day after today). Today is
  *No meeting* until a meeting is ticked on it. It is outlined in the board's orange and reads *Today*
  (`aria-current="date"`).
- **The pills read the ticks the grid already holds**: the same rows, and the same "met" rule (value 1) as the
  Met column and the server's `lastMeetingDate` read (`dailySectionStats` → `meetingsByDay` →
  `meetingDaysOf`). A tick ticked off (0) is not a meeting. **No new read, nothing stored, no migration.**
- The pills cover workdays and the number counts calendar days, so a meeting last Friday reads *5 days* on
  Wednesday over three *No meeting* pills. That is the two rules as written, not a mismatch.
- **Colour is never the only signal.** Every pill prints its state word, and the icon joins it from `sm`. On a
  phone the word may wrap and never clips. Each pill carries a screen-reader line (*"Mon Oct 5: no meeting"*,
  *"Wed Oct 7, today: no meeting so far"*). When the streak is long, the amber also says **Over a week** in words.
- The pills rise in once (0.2 s, a 30 ms stagger) and **appear at once under reduced motion**. A background
  refresh never replays them, because the panel is keyed on the tab and the week (§ Motion).
- **OPEN, Carla to say:** her *"Keep it going"* treats a long streak as good, but the amber (round 3) reads as a
  caution after a week. The amber was kept as documented. If a long streak should read as a win, change
  `streakIsLong`'s use and its test.

## Payroll Problems: a log, every problem with its type

Carla's email, § 5. The daily count grid became a **log** on 2026-10-06, because a type belongs to each
problem, not to a person's day total.

- A line is a day (Mon–Fri), a person (a row of the section), a **Problem Type** and how many (a whole number
  **0–1000**, default 1; one person logged 51 in a day on the old grid). A person's day and the week add up from
  the log (`problemsWeekStats`), with chips per type.
- **0 is a real "0 problems"** since 2026-10-07. Kane: *"lets not limit it to 1 to 1000 lets start from 0 because
  0 can count as 0 problems"*. It was 1–1000 (`validate.ts`, the form, and CHECK `acct_sb_prob_count_range`, all
  three moved together). A 0 line still needs a type, like any line. A week whose only lines are 0s reads **0**,
  and is green against "< 20". It can still be deleted, like any line.
- **Append-only**, like the collections log: a trigger refuses every UPDATE except the one soft delete, and
  only the person who logged a line, or a manager, may delete it.
- **Types** are a list managers keep under Setup → Problem types. Carla's starting list (Account Error,
  Scoreboard Error, Other) was seeded by the migration. A type is archived, never deleted: it leaves the
  dropdown and every line already logged keeps it.
- **The counts typed into the old grid still count**, as **"No type"** (22 entries, 2026-09-28 → 10-05). They
  are read, never written: the grid takes no writes now (`problem_log` has no slots).
- **Nothing logged is still "—", not 0 problems**: the board cannot tell "no problems" from "nobody logged". So a
  week with no line has no stop light, the same rule as the collections log. To record a clean day, log a 0.

## Goals in Setup: every section can carry one (2026-10-07)

Carla, via Kane: *"for Sections, can you add an edit or button to set a goal for those without one?"* Until then a
section with no goal on the sheet could never get one (`parseSectionPatch` refused it). Now every built-in section has
something its goal is judged on, pinned in `sections.test.ts`:

- **A default goal** (`SectionDef.goal`): the sheet's (Buckets ≥ 8, Inbox ≥ 9, Collections ≥ 85, Compliance ≥ 30,
  Payroll Timing 100%, Payroll Problems < 20), or **Carla's own of 2026-10-07**: **PM Buckets < 30 avg** (*"less
  than 30 avg in the buckets weekly"*; the headline is the Σ of the PMs' daily averages, which read 24.6 and 28.5 on
  the weeks of 09-27 and 10-04) and **Outcomes ≥ 50%**. Setup shows the number and *Reset to* it. Carla's numbers
  are code defaults, so no database row was written for them.
- **Or a shape a manager fills in** (`SectionDef.goalShape`): Open Disputes (a 0–10 score to reach), Sales —
  Payments ("at least N payments" a week) and Cancellations ("at least N reviewed"). Setup shows a goal box,
  empty = no goal, and *Clear*. The direction is fixed in code (CHOSEN: more payments and more reviews are better).
  The number is stored where an override always was (`accounting_scoreboard_sections.goal`), so no migration was
  needed.
- **Ranges by what is measured** (`goalMax`): a score 0–10, a percentage 0–100 (win ratio, cycle score), anything
  else 0–100,000. The server refuses anything outside them, sheet goals included; before this, a Buckets goal of 11
  was accepted.
- **Pace** (§ Stop light): only a week total (`team_week`) is paced. An average (PM Buckets, `average`) and a
  percentage (`ratio`) are judged whole, like a score.

## Custom sections

Carla's email, § 6: "Add a button to create new sections". A manager adds one under **Setup → Sections →
Add section** (`accounting_scoreboard_custom_sections`).

- **"Your own sections" sit at the TOP of Setup → Sections**, the Add form first, above the scoreboard's
  built-in sections, and **a new section lands at the top of them** (Kane, 2026-10-06: *"Setup - Your own
  sections and created sections please PUT it on top and when a section gets added it will be placed at the
  top"*). `createCustomSection` gives it one below the lowest live sort order, and `boardSections` lists the
  lowest first, so the newest is first in Setup and first among the custom tabs (pinned in `sections.test.ts`).

- A custom section has a **name** (unique among live ones), one of **two kinds** and an optional **goal**:
  - **One number a day**: the headline is the week total; the goal is "at least" or "below".
  - **Start and end of day**: AM/PM readings scored exactly like Buckets (§ Buckets); the goal is a 0–10 score
    to reach.
- It gets a tab, an Overview card and a menu entry, after the built-ins (newest first), **or it is shown inside a
  built-in section's tab** (§ Shown in). Its rows are added under Setup → Rows like any section (`section_key 'custom'`
  + `custom_section_id`; uniqueness of a label or person is per custom section). Numbers are typed into its grid; the
  same write rules apply.
- It can be renamed, switched off, given or cleared a goal, or **removed (archived, never deleted)**: its
  rows and numbers stay in the tables. A removed section's rows take no writes.
- Built-in sections stay code. A custom section can never become a payroll, collections or log section.

### Shown in: a custom section inside a built-in tab (2026-10-07)

Carla, 2026-10-07 (forwarded by Kane, with screenshots of the Chargebacks and Sales Onboarding tabs): the Sales
Onboarding tab should hold two sections the way Chargebacks holds Open Disputes and Outcomes. They are **"Sales -
Payments"**, the section already tracked, and a new **"Sales - Projects Onboarded"**. She asked: *"Do I build it like
Sales Onboarding - Projects onboarded, then it would add to the correct tab?"* No. **A section's name never decides
where it is shown.** A name-prefix rule would break on a renamed tab, and it would swallow any title that happened to
start with a tab's label.

- **The built-in `onboarding` section is titled "Sales — Payments"** (it was the sheet's "Customer Sales Onboarding").
  The tab keeps its name, Sales Onboarding. Its Overview unit is "payments", and its help line says what is typed. Its
  live lines are Carla's own, "Scheduled" and "Urgent" (created 2026-10-01). **Known quirk:** the weeks before 2026-10-01
  hold the sheet's per-closer *customers onboarded* counts (the archived closer rows, `sheet-import`), and they now show
  under the new title. Whether those weeks belong to Payments or to Projects Onboarded is Carla's call.
- **Shown in** (Setup → Sections, on the Add form and on each of your own sections) is **"Its own tab"** (the default,
  and every section made before this) or a built-in section's tab. It is stored as
  `accounting_scoreboard_custom_sections.host_section_key`, and can be changed at any time; the rows and numbers do not
  move.
- **A host is any built-in section that has a tab of its own** (`HOST_SECTION_KEYS`; Outcomes is excluded because it is
  itself shown inside Chargebacks). The SQL CHECK `acct_sb_custom_host_valid` lists the same keys: `sections.test.ts`
  pins them, the apply script compares the live CHECK against the code, and `validate.ts` refuses anything else (an
  unknown key, `chargeback_outcomes`, `custom`, or a tab's label) before the database sees it.
- **Inside the host's tab** its grid sits under the host's own panel, after any built-in hosted section (Outcomes),
  newest first. This works under every panel: under a grid, the Collections log, Payroll Timing or Payroll Problems.
- **It keeps its Overview card**, placed right after its host's card, and the card opens the host's tab
  (`overviewSections`, `tabIdFor`). It has its own number and goal, so moving its grid never hides its stop light.
  Since 2026-10-07 every section shown inside another tab keeps a card, Outcomes included (its win ratio). It has
  **no tab and no phone-menu entry** of its own. Only a manager's **On Overview** switch takes the card away
  (§ Hidden from the Overview), and that switch is its own: hiding the host's card never hides it.
- **It never disappears silently** (the Outcomes rule): if its host is switched off, it takes a tab of its own. If it is
  switched off itself, it shows nowhere, like any section.
- Setup names a hosted section with its tab: "Sales Onboarding — Sales - Projects Onboarded", as for "Chargebacks —
  Outcomes" (`sectionLabel`).

## Hidden from the Overview (2026-10-07)

Carla, 2026-10-07 meeting (Open item 391), on "Sales Projects Onboarded": *"I don't want this on here because this is
kind of just again telling me how many products we added, but it doesn't really do anything for my team"*; on a second
section, *"I don't want this one on the overview, but I don't have a hide option."* Kane: *"setup will have an option to
hide it from the overview."* Carla: *"Under sections."*

- **Setup → Sections has an "On Overview" switch on every section**, built-in and custom, hosted ones included, beside
  its goal. It is a separate switch from on/off, with its own words beside it, because it does something else: off
  takes the section's **card off the Overview**, and nothing more. Its tab, its grid (inside its host's tab, for a hosted
  section), its phone-menu entry and stop light, its rows and its numbers are all unchanged.
- **A hidden card is left out of the Team Score** (CHOSEN, implementation plan Task 1 / W0.3 (a), for Carla to confirm),
  and out of the on track / close / behind count beside it. The Overview builds the cards, that count and the Team Score
  from **one list** (`overviewSections`; `Overview` in `ScoreboardApp.tsx`), so none of them can disagree with the cards
  on screen. A tab whose only scored card is hidden drops out of the Team Score, the same as a tab with no goal. Hiding
  Open Disputes leaves Chargebacks counted once, on Outcomes alone. `team-score.test.ts` replays the 10-07 board
  (87.1) with a card hidden and checks the score against the same board with that card removed.
- **Each section has its own switch.** Hiding a host never hides the cards of the sections shown inside its tab
  (`sections.test.ts`).
- **It never disappears silently** (the Outcomes rule): under the cards the Overview says *"Not on the Overview: …"*,
  naming every section that is on but hidden, that it keeps its tab and is left out of the Team Score, and that a
  manager can show it again in Setup → Sections (`hiddenFromOverview`). A section that is switched off shows nowhere,
  whatever this switch says, and is not named there.
- **Stored** as `show_on_overview boolean NOT NULL DEFAULT true` on `accounting_scoreboard_sections` (the built-in
  switch row; a missing row is still the code default: on, shown, default goal) and on
  `accounting_scoreboard_custom_sections`. A new custom section is shown. NULL is refused, so absence is never stored.
  `patchSection` writes the whole switch row, carrying the stored `show_on_overview` when only `enabled` or `goal`
  changes.
- **A board cached in the browser before this deploy has no `showOnOverview` key** (§ Browser cache). Only an explicit
  `false` hides a card (`shownOnOverview`), so an old cache paints every card as shown, never a blank, until the fetch
  replaces it (plan Review Focus 1; `sections.test.ts`).
- **The PATCH takes a real `true` or `false`.** `"no"`, `"false"`, `0`, `1` and `null` are refused with
  *"showOnOverview is true or false"* (`validate.ts`, both section PATCHes).
- Not built: which second section Carla meant is not in the transcript (meeting, question 6). She hides it herself.

## Payroll Timing fills itself, from the Payroll Wizard

Kane, 2026-10-01, with a screenshot of Carla's "Payroll Scoreboard (Timing)": per week, when the cycle
**started** (goal Tuesday 12:00 PM) and **closed** (goal Friday 12:00 PM), each on time or not, a cycle score,
and an Average over This week / Last week / Two weeks ago. Every time on that sheet is one of HRIS's **own
audit events**, so nobody types this section (the same day it replaced a per-person start/end-time grid, goal
"< 20 hours"). Later that day: *"lets connect this to the actual payroll Wizard where we first started
processing per week and close it"* and *"Make sure to check previous weeks"*.

- **Started = the FIRST `dispatch.lock_acquired` whose `details.cycle` names that week's pay cycle**,
  whenever it happened. The Payroll Wizard writes it on Start Processing, stamped with the file it is on
  (`handleLockToggle` in `PayrollWizard.tsx`; the cycle context of `cycle-audit.ts`). A cycle processed late
  belongs to its own week, never to the week the click happened in. A later re-start of the same cycle does
  not move it.
- **A start made only from Payment Dispatch does not count.** The processing lock (`payroll.dispatch_locked`)
  is global and names no week (`cycle-closeout.md` § Permissions). Both Start buttons flip it and write
  `payroll.dispatch.locked`, but only the Wizard records which cycle it was on. Do not "fix" a missing start
  by reading `payroll.dispatch.locked` again: until this change that rule put the Jun 14–20 cycle's start at
  a Payment Dispatch lock (6/24 12:17 PM, the Wizard opened only after it) and the Jul 19–25 cycle's at a
  lock on Mon 7/27 10:12 PM (on time). The Wizard first started Jul 19–25 on Tue 7/28 4:07 PM (late). That
  7/27 lock is the one ambiguous week: the same person had opened the Wizard four minutes before it, so it
  may be a Wizard start whose stamp never saved (see Known gap). It is not counted.
- **Closed = the `payment_cycle.closed` of the same cycle** (Close Pay Cycle, which lives only in Payment
  Dispatch's Stop dialog; the Wizard never closes, `cycle-closeout.md` § Downloadable report). A
  `payment_cycle.reopened` after the close opens it again, and the close that sticks is the one judged.
- **Every event is matched to its cycle on the parsed period**, by the Sunday the period starts (a cycle is
  a period, not a file: `diagnostics-performance-tabs.md` § A cycle is a PERIOD; memory
  `orphanage-source-file-drift-hides-a-week`). The " (1).csv" and " 4.csv" names and June's two 8-day
  files all land on their own week.
- Deadlines are noon **Eastern**, and on the dot is on time. Each check is `on_time`, `late`, `pending` (not
  yet, deadline still ahead), `missed` (not yet, deadline passed: counts as late) or **`no_record`**. Pending
  prints "—", never Late.
- **`no_record` is never judged**: never late, never in a score or an average, no colour. This copies
  Diagnostics' rule that a week the feature could not have measured is never flagged
  (`diagnostics-performance-tabs.md` § Three statuses, § `not_run`):
  - **"Not in Wizard"**: the processing week is over and the Wizard never started that cycle. Payroll ran
    outside HRIS (Jun 7–13 and Jun 28 – Jul 11 have no Start Processing of any kind), or it was started only
    from Payment Dispatch. While the week is still running, no start after Tuesday noon is `missed`, in red.
  - **"Before close-outs"**: the cycle ended before the first close-out was ever filed, so it could not have
    been closed. The boundary is `firstClosedPeriodEnd`, the earliest period end among every
    `payment_cycle.closed` ever written: Aug 8. It is read from the close events, not the live records,
    because a reopen frees a record while the close-out feature still existed. The comparison is Diagnostics'
    own (`periodEnd < firstClosedPeriodEnd`, `cycle-performance.ts`). With no close-out ever filed, nothing is
    exempt. Aug 23–29 ended after the boundary and was never closed (Open item 261), so it is `missed`.
- **Cycle score = 25% for starting on time + 75% for closing on time**, scored only once both checks are
  judged. This is CHOSEN, not read from the sheet: it reproduces the sheet's two scored rows (start on time,
  close late = 25%; both late = 0%). The panel prints the formula. If Carla's real formula differs, change
  `SCORE_WEIGHTS` and the test that pins it.
- The Average row is the sheet's: each column over the weeks where it is judged (start 2 of 3 = 67%, close
  0 of 2 = 0%, score (25 + 0) ÷ 2 = 13%).
- **Measured against production 2026-10-01** (read-only, the board's own query and rules): 62 events, every
  one naming a readable cycle, over 17 processing weeks from Jun 7 to Sep 27. `payroll-cycle.test.ts`
  replays them and asserts every week, starting with Carla's sheet cell for cell.
- The board reads six columns (`action`, `created_at`, `resource_id`, `details->>source_file`,
  `details->cycle->>source_file`, `details->cycle->>period_start`) of three actions from `audit_log`. The
  window starts three weeks before the week shown and has **no upper bound**, so a late start or close of a
  past week still lands. It also reads the file of every `payment_cycle.closed` for the boundary. Both reads
  are paged. It never reads or writes the close-out record, which holds unpaid payees. The 3 rows and 1
  entry typed under the old grid are kept and not shown.
- **Known gap (Open item 318):** the Wizard writes its stamp from the browser, fire-and-forget (`logAudit`
  in `client-log.ts`, `keepalive`; the POST needs only a signed-in session). If the write fails, that start
  is unrecorded, and the week shows the next stamped start or "Not in Wizard". Most weeks also hold global
  locks with no stamp beside them, which are Payment Dispatch's own starts. A lost stamp and a Dispatch start
  look the same, so the gap cannot be measured from the log.

## Stop light

Kane, 2026-10-01: *"if its performing badly lets make the feel look that we are failing kind of RED and if its
GOOD then its green and orange is for middle … kinda like a stop light"*. One rule (`stoplight.ts`) feeds the
Overview cards, every goal chip and every row score, so a card and its tab can never disagree.

- **green** = goal met, or on pace. **amber** = close: at least 80% of an "at least" goal, or under 120% of
  a "below" goal. Amber is the stop light's middle and ui-standards § 6.3's caution tone. **red** = behind.
  **none** = no numbers, no goal, or too early to call. Absence is never a colour.
- **This week's running totals are judged on PACE**, against goal × the share of the section's days that are
  over (Thursday = 3 of 5). Without it every Monday is red. A past week is judged on the full goal. Scores,
  averages (PM Buckets) and percentages (the win ratio) are never paced.
- **A "below" running total is judged against its allowance so far** (goal × pace): green under it, amber under
  120% of it, red past that. Going over the FULL goal is final: it is never green again, and it is never better
  than being over pace. Before any day is over (Monday) only the full goal is judged. **Fixed 2026-10-07**
  (session `728157e2`): the full-goal check used to run first and return amber, so by Wednesday 15 of 20 problems
  read Behind while 21 read Close, and more problems looked better. A past week reads as before. The test walks
  every count at every pace to check that a higher count never reads better.
- Payroll Timing's light comes from its checks: every judged check on time = green, none = red, a mix =
  amber, and a `no_record` check is left out. So a cycle that started on time is green until Friday decides the close.
- An Overview card shows the light as a real stop light (a dark housing, the live lamp glows) **and** the
  word (On track / Close / Behind). Colour is never the only signal. A card tints its border and background,
  never with a thick side border (the craft floor). Each card carries its KPI's own icon (`SECTION_ICON`)
  and a 5xl number (Kane, same day: *"make the numbers bigger … add like icons that match the kpi card"*).
  Until Payroll Timing is scored, its card shows when this week's cycle started.
- A card's word when its light is off (Carla's spec, 2026-10-07): **Waiting on data** when nothing is typed,
  **Not scored** when it has no goal, else *No call yet* (too early). Outcomes' card shows its sample size,
  "0 won · 1 lost (n = 1)".

## Team Score (Carla's spec, 2026-10-07)

Carla's "Accounting Scoreboard — Team Score & Overview Edits Spec" (Oct 7, 2026, forwarded by Kane): one **Team
Score (0–100)** at the top of the Overview, beside the on track / close / behind count, with last week's. It
rolls up every tab with a goal, **from the cards on the Overview**: a section a manager hid from the Overview is left
out of it (§ Hidden from the Overview, 2026-10-07) (`team-score.ts`). It is **display only**: it pays no one.

- **Card score** (0–100, "% of goal", **capped at 100** so one strong card can't hide a weak one), on the
  **same pace as the card's light**, so the score and the light always agree (her rule):
  - at least, a score, average or ratio (Buckets, Inbox, Open Disputes, Outcomes): MIN(actual ÷ goal, 1) × 100
  - at least, a running week total (Collections, Compliance): MIN(actual ÷ (goal × pace), 1) × 100
  - below, an average (PM Buckets): MIN(goal ÷ actual, 1) × 100; 0 scores 100
  - below, a running week total (Payroll Problems): MIN(goal × pace ÷ actual, 1) × 100; 0 scores 100.
    **CHOSEN, not her table:** her table gives Payroll Problems the unpaced form, which on 10-07 read 100 while its
    card said Close (9 problems against an allowance of 8 by Wednesday). Her own rule is that the two agree, so
    it is paced: 8 ÷ 9 = 88.9. That moves her worked 88.5 to **87.1**.
  - Payroll Timing (her "On time = 100, late = 0"): the share of its **judged** checks that were on time,
    weighted like the cycle score (start 25, close 75). Started on time with the close still ahead = 100 (her
    example); both judged = the cycle score itself (last week: 25); nothing judged or `no_record` = left out.
- **Left out, never 0:** a card with nothing typed ("Waiting on data"), no goal ("Not scored"; an "at least 0"
  goal counts as none), or nothing to judge yet: a running total under its full goal on Monday, when its pace
  goal is 0 and its light says "No call yet". A card hidden from the Overview is left out the same way.
- **Group** = the tab the card's grid sits on (`tabIdFor`). Its score is the mean of its scored cards, so
  Chargebacks (Open Disputes + Outcomes) counts once. A tab with no scored card drops out. A goal set later
  (Sales — Payments, a custom section) joins on its own.
- **Team Score** = Σ wᵍ × groupᵍ ÷ Σ wᵍ, every weight 1 (`GROUP_WEIGHTS` is empty; no Setup control), one
  decimal. **Its bands are its own**: 90–100 On track (green), 75–89.9 Close (amber), below 75 Behind (red).
- **Last week** is computed the same way on last week's final numbers, on the full goal (no pace). Browsing back
  with the week arrows shows that week's score the same way.
- The tile lists each counted tab with its score, coloured by the same bands, so what pulls it down is visible.
- **Measured on production, 2026-10-07 14:25Z** (read-only, `readBoard()`): every one of Carla's worked numbers
  matched the app's own (Buckets 7.4, Collections 90, PM Buckets 29.33, Inbox 9.8, Open Disputes 2.5 against her
  goal of 8, Outcomes 0 won · 1 lost, Compliance 13, Payroll Timing started on time, Payroll Problems 9). The
  Team Score read **87.1 (Close)**, and last week **76.5**. `team-score.test.ts` replays both 87.1 and her 88.5.
- **Not built (NEEDS Carla):** the spec's "nine fixes to the Overview cards" (edits 1–9) and its open
  questions. The PDF refers to "edit 5" and "open question 3", but its three pages hold neither. Only what its
  edge-case list states was built: "Waiting on data", "Not scored", and the "(n = N)" sample size.

## Weeks and days

- A week is keyed by its **Sunday**, the HRIS pay week and the `period_start` the KPI calculator uses, so
  a board week and the Dancing Queen week it feeds share a key. The board shows Mon–Fri, and no section
  keeps a weekend (`sections.test.ts`).
- Days are **US Eastern** dates (`todayEastern()`). A Manila evening shift entering Monday's numbers is
  still on Monday. Future dates are refused at write and disabled on screen.
- "Last week", WTD, All Time and the record are **computed from stored entries and never typed**. That
  is what replaces the sheet's typed "Lst Wk" columns and hand-filled History tabs.
- **The sheet's past is in those entries** (filled 2026-10-01): collections back to 2024-12-30, the grids back to
  January 2025, and "Totals - History" kept as typed at `/accounting-scoreboard/archive`. The current week was not
  filled, by rule. **All Time and the record read `accounting_scoreboard_collection_weeks`** (one row per rep row
  and week), never every log line: ~10k lines would be 10+ pages on every refresh. Both rules are in
  [accounting-scoreboard-backfill.md](accounting-scoreboard-backfill.md).

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
- **Payment Verified** (Carla's email, § 2): every log line has a tick. Any member may tick it, and it saves
  and shows **who** ticked it: the label of their own person row on the board, else their roster nickname,
  else their email handle, kept with the tick and their session email. Only whoever ticked it, or a manager,
  may uncheck it. The tick lives in its **own table** (`accounting_scoreboard_collection_verifications`, one
  live tick per collection), so the append-only log line is never updated and its trigger is untouched.
  Unchecking stamps the tick (`unverified_at/by`) and never deletes it, and a stamped tick cannot change
  again: ticking again adds a new one, so the history of who verified and who took it back is kept. It does
  not touch points, totals or the bonus preview.

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
- **Chargeback Outcomes' cells**: `usd` is dollars and cents (at most 2 decimals) under the table's 100,000
  ceiling, the same as every other box; `count` is a whole number (refused in `validate.ts` and by the CHECK
  `acct_sb_entries_count_whole`).
- **Payroll Timing and Payroll Problems take no grid writes**: neither has slots, so `entryAllowed()` refuses
  every one. Problems go to the log (`POST /problems`).
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

- **The No Meeting Streak's pills were verified 2026-10-07** in headless Chromium on the real `ScoreboardApp`, fed a
  **synthetic** board (fictional PMs and ticks, no production data) with the clock pinned to Wed 2026-10-07. 231
  scripted checks passed. They ran five streaks (5 days, a meeting on Tuesday, a meeting today, 12 days, never) at
  1360 px and 390 px, light and dark, and covered: the sentence, each pill's state and screen-reader line, one *Today*,
  *Over a week* only when long, no clipped pill text, pill and sub-line contrast ≥ 4.5 (lowest 4.83), no page-wide
  horizontal scroll, and no console errors. Also covered: ticking today's meeting turns today's pill and re-reads
  the sentence to *Meeting today*, and unticking goes back. The previous week shows its own pills under the same
  all-time number. Under reduced motion every pill is fully visible on the first frame. **Not clicked through
  signed in.**
- **Shown in was verified 2026-10-07** in headless Chromium on the real `ScoreboardApp`, fed the 2026-10-06 production
  board plus fixtures (Carla's section shown in Sales Onboarding, one under Collections, one with its own tab). 62
  scripted checks passed at 1360 px light and dark and at 390 px. They covered: the renamed card, the hosted card right
  after its host and opening the host's tab, no tab or menu entry for a hosted section, Payments above Projects
  Onboarded on one tab, a grid under the Collections log, the Shown in pickers, the POST and PATCH bodies, the Rows
  picker's label, no page-wide horizontal scroll, and no console errors. **Not clicked through signed in.**
- **Round 3 was verified 2026-10-06** in headless Chromium on the real `ScoreboardApp`, fed this week's board as
  `readBoard()` returns it from production (read-only), plus local fixtures for the states production does not
  hold yet: a verified line, problem lines, a custom section and an outcome. 69 scripted checks passed at 1360 px
  light and dark and at 390 px: Pending, N/A, the overall, the due-in-7-days callout, Outcomes on the Chargebacks
  tab, the streak, the verify call, the problem form and chips, a custom section scored like Buckets, Setup's
  areas, no page-wide horizontal scroll, and no console errors. A separate check confirmed "Your own sections"
  sits on top. **Not clicked through signed in.**

## Browser cache

Kane, 2026-10-06: *"Lets add caching to this whole thing all the tabs should be stored in browser cache i dont
wanna see loading every switch of tab"*. Measured first: a tab switch inside the board fetched nothing (every tab
renders from the one board payload). The loading people saw was the full-page "Loading the scoreboard" on every
page load, a week change waiting on the network, Setup → Rows re-reading the roster on every visit, and the
header spinner on every 45 s and focus refresh.

- **The board is cached per week** in `sessionStorage` (`acct-sb:board:<Sunday>`, the shared envelope:
  `create-tab-cache.ts`, governed by `qc-contractor-tickets-cache.md`). A page load or a week change **paints the
  cached week before the first paint**, and then fetches it anyway. Only the **4** most recently written weeks are
  kept (one board measured ~150k characters on 2026-10-06; on the HRIS domain this origin's storage is shared with
  People and NPD). Setup's roster picker is cached too (`acct-sb:roster`).
- **A cached value PAINTS, it never DECIDES.** Nothing can skip a fetch: every page load, week change, 45 s tick
  and focus still reads the board, and the fetched copy replaces the cached one. A number that moved meanwhile
  sweeps orange (§ Motion), which is how a teammate's typing shows up.
- **The viewer is never cached.** `viewer.isManager` shows Setup and the delete buttons, so it is a permission,
  and a cached permission is a cached value deciding (the Tickets `access` rule). The page server component
  resolves the viewer on every request and passes it to `ScoreboardApp`, which binds the cache to that email
  (a different viewer on the same tab purges it first) and lays it over a cached board.
- **Only the server's answer is written back**, plus edits made on top of it. The seed itself is never re-written,
  which would restamp stale data as fresh and stretch the 12 h ceiling.
- **The seed runs in a layout effect, never in the first render.** The page is server-rendered, and the first
  client render must match the server's (the loader). The layout effect lands before the browser paints, so the
  loader frame is never seen when there is a cache.
- **Loading indicators:** the loading modal (§ Loading the board) shows only when there is nothing to paint (the
  first visit in a browser tab, a week never opened, or after the 12 h ceiling). Revalidating a painted board is
  silent.
- `sessionStorage` is **per browser tab** (never `localStorage`, which outlives the browser on a shared machine):
  a new browser tab loads once, then everything in it is instant. A phone may keep it for weeks; the 12 h ceiling
  still applies.
- The board has **no sign-out control** to purge on (the HRIS sidebars purge their own stores). A different viewer
  binding purges, and a removed member never reaches `ScoreboardApp` (the page refuses first).
- The archive page is server-rendered and is not cached.
- Verified 2026-10-06 in headless Chromium against a 1.5 s API, 16 checks. The first visit shows the loader once.
  A reload paints within 400 ms with no loader or spinner and still fetches. Five tab switches make no fetch.
  An uncached week spins, stepping back to a cached week is instant, and the second Setup visit has no roster
  loader. A focus refresh is silent. The cached blob carries no viewer. **Not clicked through signed in.**

## Loading the board: a progress modal that is accurate

Kane, 2026-10-06: *"Onloading the dashboard lets add a progress bar modal that has appropriate texts inside it please
like collecting buckets and etc"*, then *"make sure the progress bar is accurate"*.

- **When:** a load with **nothing of the week on screen**: the first visit in a browser tab, a week never opened,
  after the 12 h cache ceiling, and *Try again* after a failed load. A board painted from the browser cache, the
  45 s tick and a focus stay silent (§ Browser cache; background work never reports, `table-refresh-progress.md`).
  The tick and a focus wait while a modal load is running; a newer load cancels it, and its modal closes with it.
- **What it says:** *Loading the scoreboard* (or *Loading Sep 28 – Oct 2, 2026* for another week), one bar, and a
  checklist. Each done line says what came back. Example from production, 2026-10-06:

  | Line, while it runs | Done, it says | What really happened |
  | --- | --- | --- |
  | Checking you're on the scoreboard | You're on the scoreboard | the route's member check (before it answers at all) |
  | Gathering the buckets, inboxes and people | Found 99 lines on the board (+ 3 removed lines with numbers) | the live rows, then the removed rows that still hold numbers |
  | Collecting the bucket, inbox and PM counts | Collected 866 numbers this week and last | the entries read |
  | Collecting the collections log | Collected 165 collections this week and last | the log and the all-time weekly view |
  | Collecting payroll problems | No payroll problems logged this week or last | the problem log and its types |
  | Checking Payroll Wizard starts and closes | Found 9 Payroll Wizard starts and closes | the audit events and the first close-out |
  | Reading goals, sections and the bonus formula | Read the goals, sections and the bonus formula | switches, custom sections, the catalog, the last PM meeting, the members (a manager's) |
  | Laying out the board | Board ready | the page putting the board on screen, then one painted frame |

- **Accurate means** the NPD card's rules (`npd-dashboard.md:470-476`) and `ui-standards.md` § 10.1, on the shared
  step model (`refresh-progress.ts`):
  - **Every line is real work, reported when it happened.** `GET /api/accounting-scoreboard?stream=1` answers NDJSON:
    a `line` the moment the LAST read of that group answers (`BOARD_READS` in `load-progress.ts`; a test reads
    `server.ts` and pins the reads ↔ lines both ways), then the `board`, or an `error` naming whose read failed. A
    read that failed is never reported as answered. The member check and the week are settled **before** the stream
    starts, so a refusal is still a plain 401 / 403 / 400.
  - Reads run side by side, so the lines tick in the order they really answer (production, a manager, 2026-10-06:
    payroll 481 ms, collections 526, problems 636, counts 688, lines 1054, setup 1378, the board at 1379).
  - **No percentage is printed.** Inside a line the fill is an estimate (a decelerating glide toward a ceiling it
    never passes); a line crosses its share only when it ticks. The bar **never moves backwards**, and it is **full
    and green only once the board has been committed and painted** (two animation frames; a timer in a hidden tab).
    *Scoreboard ready* holds 650 ms, then it closes itself.
  - **The board is assembled fail-closed** (`createBoardStreamAssembler`): a stream that stops early, a line it
    cannot read, an unknown line, a board missing a list, a board for another week, or anything after the board is
    a failed load, never a partial board.
  - A **tolerated** failure is said, never hidden: the board shows a failed Payment Catalog read in the bonus card,
    so the setup line stays done but says *the bonus formula could not be read*.
- **Failure:** the bar turns red where it stopped, **only the failed read's line** is marked (a line still in
  flight beside it is not blamed), and the modal stays open with the server's own sentence, **Close** and **Try
  again** (§ 10.1, § 12.4). The board's own failure handling is unchanged: the "Couldn't refresh" bar over the last
  good board, or the error card when there is none. A failure after the modal was closed is also said in a toast.
- **It never traps anyone:** ✕ and Escape close it, the load keeps going, and the board still appears.
- **It is the scoreboard's own dialog** (`ScoreboardLoadDialog`), in the board's orange, on the shared step model
  and the refresh modal's Web Animations fill. It is **not** `useTableRefresh`: that modal belongs to a table's
  Refresh button and nothing else (`table-refresh-progress.md` § Only the click reports).
- Verified 2026-10-06: 10 tests in `load-progress.test.ts`, the real `readBoard()` against production with the line
  tracker (read-only, manager and member), and 22 headless-Chromium checks replaying production's timings:
  - the opening line; the order the lines tick in; each done line's detail; no `%` anywhere;
  - the fill and the value never going backwards; never full before *done*; *Laying out the board* between the
    last read and done; the modal closing itself;
  - a cached reload opening no modal and making no streamed read; a week's own title;
  - a failed read blaming only its line, with its sentence and *Try again* kept on screen; Escape; closing it
    mid-load.
  The cache (16) and round-3 (69) suites re-passed. **Not clicked through signed in.**

## Live refresh

- A background refresh runs every 45 s while the tab is visible, and on focus, **silently** (the board is on
  screen; § Browser cache). It **never runs while a cell is being edited** (an editing counter). A focused cell
  also keeps its own draft, so someone else's save can never overwrite what you are typing.
- A failed refresh keeps the last good board on screen under a "Couldn't refresh" bar. It never blanks
  the board or shows zeros. There is no realtime: the tables are service-role only.

## Not built (on purpose)

- The sheet's status strip (Working / Lunch / Break) and the per-person task checklists (Carla's
  Tracker). Both are outside the bonus and can come later.
- Per-person or per-section bonuses after Carla's revamp, and any write to pay (Item 315).
- Charts. Carla's § 6 says "sections/charts"; a custom section is a tab, a grid and an Overview card, the same
  as a built-in one. No chart type was built.

## Deploy notes

- **Migration: APPLIED 2026-10-01** by session `9fe90c48` on Kane's *"run the migration yourself
  please"*. `--apply` committed after all 121 checks passed, `--verify` re-passed 121, the five tables
  hold 0 rows, and the anon key is refused (`42501`). Re-check any time with
  `node --import tsx scripts/apply-accounting-scoreboard-migration.mts --verify`. (Do not double-click
  the `.mts`: Windows opens it as video.)
- **The second domain: DONE (Kane confirmed 2026-10-02; steps 1, 2 and 4 also measured).** Kane, to
  session `d2ba4c35`, on the board's Pending Deploy rows: *"close them and end them they are already
  done"*.
  1. Vercel: `accounting-bonus.vercel.app` on this project. **Measured 2026-10-02 ~21:45Z:** the host
     is served by Vercel and answers `307` to `/accounting-scoreboard`, then `200` (a made-up
     `vercel.app` host answers `404`).
  2. Vercel env: `ACCOUNTING_SCOREBOARD_HOST=accounting-bonus.vercel.app` (Production), then redeploy.
     **Measured the same way:** the bare host lands on the board, which is the host rule in
     `decideScoreboardHost()` and is inert until that env var is set.
  3. Google Cloud → the HRIS OAuth client → Authorized redirect URIs:
     `https://accounting-bonus.vercel.app/api/auth/callback/google`. **On Kane's word only.** It cannot be
     checked without signing in, and on 2026-10-01 he saw `redirect_uri_mismatch` there. If that comes
     back, this is the step to re-check.
  4. The push. **Measured:** every commit is on origin/main.
- **Round 3 migration: APPLIED 2026-10-06** by session `48c8828b` on Kane's *"run the migration i give you my
  permission"*. Dry run 133/133, then `--apply` 133/133 (committed), then `--verify` 133/133; the 2026-10-01
  `--verify` re-passed after it. Before committing, the script wrote the 9 rows its data steps change to
  `docs/audits/backups/accounting-scoreboard-round3-rows-2026-10-06T18-04-22-038Z.json` (gitignored). Read back
  through the app's own `readBoard()` against production: the five weekday buckets carry their day, "Disputes
  due in 7 days" is flagged, Outcomes holds Pre-arb / Wins / Losses, the old three are archived, the three
  types are live, and the anon key is refused (`42501`) on all four new tables. The script holds the table
  locks for about 15 s (the pooler is ~240 ms away, so its checks and controls run batched) and sets
  `lock_timeout = 10s`. Re-check any time with
  `node --import tsx scripts/apply-accounting-scoreboard-round3-migration.mts --verify`.
- **The round-3 code needs that migration**, which is applied. **Pushed: measured 2026-10-08** (on origin/main; deploy not measured from here).
- **Win/loss flags + 0 payroll problems migration: APPLIED 2026-10-07 ~14:10 UTC** by session `48c8828b` on Kane's *"run
  this"*, sent with the board's live error. The code (`0b8748f6`) had been pushed BEFORE the migration ran, so until then
  every board read in production answered "not set up yet" (the deploy order below was not followed).
  `2026-10-07_accounting_scoreboard_outcomes_and_zero_problems.sql` adds `rows.outcome` and its CHECK, flags the live
  "Wins"/"Losses", and moves `acct_sb_prob_count_range` from 1–1000 to 0–1000. Dry run 38/38 (rolled back), then `--apply`
  38/38 (committed, after backing up the 2 flagged rows to
  `docs/audits/backups/accounting-scoreboard-outcomes-rows-2026-10-07T14-09-57-021Z.json`, gitignored), then `--verify`
  38/38. The round-3 `--verify` (now refusing a count of -1) re-passed 133/133, and the Shown in `--verify` re-passed.
  `readBoard()` against production then answered for a manager and a member (105 rows; Wins = win, Losses = loss, Pre-arb =
  neither). **Deploy order for any later scoreboard migration: apply it, THEN push.** The board selects every new column,
  and a missing one makes every read answer 503.
- **Shown in migration: APPLIED 2026-10-07** by session `728157e2` on Kane's *"I approve run it please I cant run it on my
  end"*. `2026-10-07_accounting_scoreboard_custom_section_host.sql` adds one nullable column and its CHECK. It has no data
  step, so there was nothing to back up. Dry run 21/21 (rolled back), then `--apply` 21/21 (committed), then `--verify`
  21/21; the round-3 `--verify` re-passed after it. The checks include the live CHECK listing exactly `HOST_SECTION_KEYS`,
  four refusals (Outcomes, `custom`, an unknown key, a tab label), and the table still service-role only. Read back through
  PostgREST: the board's exact custom-section select answers (0 rows), and the anon key is refused (`42501`). Re-check any
  time with `node --import tsx scripts/apply-accounting-scoreboard-custom-host-migration.mts --verify`. The column has to
  exist before this code is deployed: the board selects `host_section_key`, and a missing column makes every board read
  answer "not set up yet" (`isMissingTable`). **Pushed: measured 2026-10-08** (on origin/main; deploy not measured from here). Now Carla adds "Sales - Projects
  Onboarded" herself: Setup → Sections, Shown in = Sales Onboarding tab, then its lines under Rows.
- **Hidden-from-Overview migration: APPLIED 2026-10-07** by session `5fae2311` on Kane's *"APPLY THEN VERIFY"*.
  `2026-10-07_accounting_scoreboard_overview_visibility.sql` adds `show_on_overview boolean NOT NULL DEFAULT true` to
  `accounting_scoreboard_sections` and `accounting_scoreboard_custom_sections`. It has no data step, so there was nothing
  to back up. Dry run 37/37 (rolled back), then `--apply` 37/37 (committed), then `--verify` 35/35 (the two "every
  existing row reads true" checks run on dry/apply only: after that, hiding a section is the point). The checks cover
  the columns, RLS and zero policies, no anon/authenticated privilege, not in realtime, the board's exact selects,
  `SET ROLE anon` refused with `42501` on both tables, three positive controls, and NULL refused with `23502` on both.
  Read back through PostgREST: the service role reads both tables with the board's exact selects (2 switch rows and 1
  custom section, all `true`), and the anon key gets `401` / `42501` on both. The custom-host `--verify` re-passed.
  Re-check any time with `node --import tsx scripts/apply-accounting-scoreboard-overview-visibility-migration.mts --verify`.
  **Pushed: measured 2026-10-08** (on origin/main; deploy not measured from here). Now Carla turns **On Overview** off for
  "Sales - Projects Onboarded" and her second section under Setup → Sections.
- **The round-3 script's data checks run on a dry run and `--apply` only** (Open item 399, 2026-10-07). They assert
  what its one-off data step did (the weekday buckets' days, the "due in 7 days" flag, the Outcomes lines, Carla's
  three types live), and managers change all of that on purpose in Setup afterwards. Under `--verify` one of them
  failed on normal use (Carla archived "Other" on 2026-10-07 14:40Z and added "Late TTV"). `--verify` now checks what
  stays true for good: the three seeded types still exist, live or archived (a type is never deleted). It re-passed.
- **The No Meeting Streak's date pills (2026-10-07, item 391): no migration, no new read, display only.** **Pushed: measured 2026-10-08** (on origin/main; deploy not measured from here) (`f770d29b`).
- **Pre-arb flag migration: APPLIED 2026-10-08 ~11:13 UTC** by session `5fae2311` on Kane's *"go"*. **The push: PENDING** (Kane).
  `2026-10-07_accounting_scoreboard_pre_arb_flag.sql` re-declares CHECK `acct_sb_rows_outcome_valid` with `'pre_arb'`
  added (the 2026-10-07 text copied verbatim otherwise). Its script's data step flags the one live "Pre-arb" Outcomes
  line, after writing that row to `docs/audits/backups/` on `--apply`
  (`accounting-scoreboard-pre-arb-row-2026-10-08T11-13-13-954Z.json`, gitignored). Dry run 2026-10-07 23/23 (rolled
  back), `--apply` 23/23 (committed), `--verify` 19/19 (the four data-step checks run on dry/apply only); the
  2026-10-07 outcomes script's `--verify` re-passed. Read back through PostgREST: Pre-arb = `pre_arb`, Wins = `win`,
  Losses = `loss`, and the anon key gets `401` / `42501`. The dry run's checks (flagged `e740e66f…`; Wins and Losses unchanged; the CHECK in force lists exactly `OUTCOMES`; nothing off
  Outcomes carries a flag; RLS, zero policies and no anon/authenticated privilege; `SET ROLE anon` refused with
  `42501`; Pre-arb → win → loss → none writes; Pre-arb on a bucket, `'draw'` and the label `'Pre-arb'` refused).
  Re-check any time with `node --import tsx scripts/apply-accounting-scoreboard-pre-arb-flag-migration.mts --verify`.
  The deployed (pre-push) code reads the `pre_arb` flag as unmarked (its `isOutcome` knows only win/loss), so the
  live board is unchanged until the push. After it, the 2026-10-07 outcomes
  script is superseded: run only its `--verify` (its SQL would re-add the two-value CHECK).
- Locally, `.env.local` is **production**: numbers entered on `localhost:3000/accounting-scoreboard`
  are real board data.
- No n8n, no cron, no new notification type.
