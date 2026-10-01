# Accounting Scoreboard — what the sheet does, and what an HRIS rebuild must carry (analysis, 2026-10-01)

Carla's accounting team runs its week on a Google Sheet titled **"Accounting Scoreboard"** (38 tabs;
the sheet ID is in memory `carla-accounting-scoreboard-sheet`). Kane, 2026-10-01: rebuild it
**inside this Next.js project, served on its own domain, no Apps Script**. This note is the analysis
that rebuild starts from. It was read on 2026-10-01 by session `9fe90c48` with the HRIS service
account (read-only Sheets scope), plus read-only roster and bonus queries. No code was written and
nothing was written to any database. **Staff names are left out on purpose:** the repo is public
(Open item 307). The person-by-person mapping is in the memory file.

## 1. The bonus structure

**The sheet holds no money.** Only one of its numbers reaches pay, and it gets there through HRIS:

- HRIS pays a Payment Catalog formula bonus called **"Dancing Queen Bonus"** (department
  `accounting`), with day variables Monday to Friday. Each day pays on a tier: **≥30 → ₱450, ≥22 →
  ₱300, ≥17 → ₱200, otherwise ₱0**. The five days are summed, so the most it pays is ₱2,250 a week,
  and **every member of the HRIS department gets the same amount**
  (`src/lib/payroll/department-bonus.ts:176-180`, `:372-395`).
- The five day values are the Collections section's **Day Total** row, typed into HRIS each week.
  That row is a sum of **points** from the Collection Count log. Measured in `bonus_catalog_applied`
  for the weeks 2026-08-02 → 2026-09-20 (8 weeks, 17–18 people each): the amount paid matches the
  points totals **in all 8 weeks**. Had the tier counted collected **accounts**, all 8 weeks would
  have paid less, by ₱150–₱800 per person per week.
- The code calls these values "collection counts" (`department-bonus.ts:120`, hint `collections` at
  `:178`). What is actually entered and paid is points. Most accounts score 1 point, but 41 log rows
  are worth 12, so a single account can push a day up a tier. **Which unit should pay is a money
  ruling** (Open item 315).
- The bonus goes to the HRIS **`Accounting Team`** department (18 active). Three of them appear
  nowhere on the scoreboard. The US leads and the Florida office staff who fill in much of the
  scoreboard are in HRIS **`USEE`**, so they receive none of it through HRIS.
- **Nothing else on the scoreboard is tied to money.** Buckets, inbox, chargebacks, PM buckets,
  onboarding, compliance, cancellations, and payroll timing and problems are scores and goals only.
  The person tabs mention other bonuses: a PM bonus sheet, tech and attendance bonus reports, two
  named people's monthly bonuses, HSL bonuses over $75, and SmartStaff OT/bonus. Those are bonuses
  this team **processes for other departments**. None of them is the team's own.

## 2. The sections of the main tab

| # | Section (cells) | Rows | Typed, and when | Score | Goal | HRIS departments |
|---|---|---|---|---|---|---|
| 1 | Status strip (A1:AO5) | 20 people | Working / Lunch / Break / Clocked Out, typed live | — | — | Accounting Team, USEE, not on roster |
| 2 | **Accounting Buckets** (F7:S28) | 19 queues: 5 day-of-week collection buckets, 6 person-owned buckets, 1 labelled "DN", 7 functional (PM issues, Pre-screening, Reactivation, RTO, RTO: Add-On Only, Sales Problem, Successful Pymts) | Queue size at AM and at PM, each weekday | Comp = Σ(AM − PM). <0 → 1, 0 → 2, 1–5 → 4, 6–10 → 6, 11–15 → 8, >15 → 10. Last week typed in | 8 | Queues, not people. Task tabs say "Bitrix bucket", so likely CRM queue sizes (unconfirmed) |
| 3 | Chargebacks (U7:AH13) | Open disputes · Due in 7 days · Pre-arb | AM/PM per weekday. Win/loss all-time totals typed, stamped "updated: 9/30/2025" | Comp = Σ(AM − PM). Last week and All Time typed | — | Team-level |
| 4 | **PM Buckets** (U16:AH45), kept by two accounting members | 26 PM names | Daily count in each PM's bucket, plus a meeting checkbox per day. An "Updates back" row (daily) | WTD average. Last week typed. Day total. "Days w/o meeting" | — | HRIS `PM Team` (51 active), but only about half the 26 names match a PM Team nickname. The rest look like the customer-facing names PMs use (a separate 26-name "PM Email" list sits at A7:C34), and a few match US staff |
| 5 | **Collections Scoreboard** (AJ7:AR18) | 8 rep rows (one merges a rep with "Others") | Nothing typed here. Points per rep per day are pulled from the Collection Count log by `FILTER` on a **hard-coded `DATE()`** | WTD; last week typed; All Time since 2024-12-30; 1st/2nd/3rd; "RECORD: 129" typed | WTD ≥ 85 (= 5 × 17, the bottom bonus tier every day) | 5 rows `Accounting Team`, 2 people not on the roster, 1 "Others". **Not** HRIS `hsl:collections`, which is HSL's collections team (31 people, none of them on this board) |
| 6 | **Customer Sales Onboarding** (AJ20:AR34) | 7 closers, a reactivation row, "PMs", the CEO, "Add on", and a "FIRST PYMTS" row | Daily counts, typed | WTD; last week typed; All Time partly typed | — | The 8 named rows are the US-located HRIS `Sales` closers. The department's other 9 members are not on it. It measures the inflow the team onboarded, not the team's own output |
| 7 | Compliance Scoreboard (AJ36:AR42) | 4 people | Daily counts, typed. The sheet does not say what is counted | WTD | ≥ 30 | All `Accounting Team` |
| 8 | **Email Inbox** (F30:S59) | 27 rows: 25 people and 2 shared inboxes (Ministry, Payroll) | Inbox count at AM and at PM | EOD AVG = AVERAGE(PM counts). Score = 10 − avg (0 → 10, ≥9 → 1) | 9 | 15 `Accounting Team`, 6 `USEE`, 4 not on the roster |
| 9 | Cancellation Call Recordings (U47:AI52) | Green · Yellow · Red | Daily counts, typed | Week total, WTD average, last week typed, share % | — | Team-level |
| 10 | Payroll Scoreboard — Timing (U54:AH60) | 2 people, each with their own days (Sun–Tue, Tue–Thu) | Start and end time for each processing day | Hours = Σ(end − start) × 24 | < 20 | 1 `USEE`, 1 `Accounting Team` |
| 11 | Payroll Scoreboard — Problems (AJ54:AR60) | 4 rows (one is shared by the two US leads) | Daily counts, typed | WTD; last week and All Time typed | < 20 | `USEE` and 1 person not on the roster |

## 3. The other tabs

- **Collection Count** is the log: 9,984 rows since 2024-12-30, newest first, with columns Date · Rep
  · Business Name · **Points** · Amount Collected. Points are 1 on 9,433 rows, 2–9 on 394, 12 on 40,
  14 on 1, 0 on 95, and blank on 43. Another 21 rows are pre-dated blanks. **This is the only data on
  the sheet that drives pay**, so it is the one section where a mistake costs money.
- **For MAIN ACCT SCORECARD** is a daily company-level feed (352 rows). It records open
  collections, PM issues, cancellations, new chargebacks, CB wins and losses, websites on the edit
  report, the number at the bottom of the Collections EOD report, hires that started Monday, the
  number in Lead Gen (typed as a sum of three unlabelled numbers), and the customer count (Fridays
  only).
- **Carla's Tracker**, 29 person tabs and a TASK TEMPLATE hold recurring task checklists by cadence:
  daily, weekly, bi-weekly, monthly, bi-monthly, quarterly, annually and as needed. The tracker counts
  ticked versus total tasks for each of 25 people (7 are labelled "FL:") and each cadence. Its
  day, week and month headers are typed by hand: on Oct 1 it still said "September 30".
- **History** (daily rep history since 2025-01-06), **Totals - History** (weekly category totals
  since Dec 2024), **Sales** (onboarding history since 2025-01-13) and **Pauses** (pause start and
  end events, with weekly totals) are archives kept by hand. Only their first 5 rows were read (§ 11).

## 4. Sections do not map onto HRIS departments

- **`Accounting Team`** (18 active): 15 of them appear somewhere on the board, and 3 nowhere.
- **`USEE`**: the 2 US leads and the Florida office staff, in the inbox, payroll and tracker rows.
- **Not on the HRIS roster** under the name the sheet uses: **5 people**, who appear in collections,
  the inbox, payroll problems or the tracker. HRIS cannot list them today.
- **`PM Team`**: about 13 of the 26 PM rows match by nickname.
- **`Sales`**: all 8 named closers match.
- **Rows that are not people**: 19 buckets, 2 shared inboxes, 3 chargeback lines, 3 recording
  colours, "Others", "PMs" and "Add on".

So **picking a department is the right shortcut for adding rows, but it cannot define a section.**
Sections cross departments, they take part of a department (closers but not their VAs), and they
include rows that are not people.

## 5. The weekly manual work a rebuild removes

- About 40 Collections formulas hard-code a `DATE()` (AK9:AO16, 8 reps × 5 days) and are retyped
  every week.
- Every "Lst Wk", "Ls WTD Prod." and "Last Wk" column is typed by hand. That covers buckets,
  chargebacks, PM buckets, collections, onboarding, compliance, the inbox and payroll problems.
- History, Totals - History and Sales are filled in by hand.
- The five collection day totals are typed into HRIS for the Dancing Queen bonus.
- The checklists are reset by hand ("Create new week on all dashboards" is a Friday task).
- Each person types their AM and PM numbers twice a day, and one member has a daily task of
  "collecting numbers" for this sheet and for another dashboard.

## 6. Live formula bugs (2026-10-01)

1. The Collections WTD and All Time totals (AP17, AR17) sum rows 9–15 and drop row 16. This week
   shows **95 instead of 113**.
2. The Payroll Problems day totals (AK60:AO60) point at row 48, which is empty. They show 0 while WTD
   shows 31.
3. The inbox team average (Q59) skips rows 32 and 58, and the day totals (G59:P59) skip row 32.
4. Two bucket rows take Thursday's PM count from the neighbouring row (Q11 uses N12, Q25 uses N24).
5. The Ministry inbox average (Q49) uses Wednesday AM (K49) instead of Wednesday PM (L49).
6. The Onboarding WTD (AP33) drops the Add-on row that the day totals include. One All Time cell
   (AR22) is a running sum of last week only.
7. In the tracker, one row counts another person's tab (S14). Another row is shifted one cadence and
   skips its first task (row 12). One counts its own header (B14), and several cells are typed 0.

## 7. Scoring rules that misfire (fixing them is Carla's call)

- **A blank PM counts as 0.** Until the PM count is typed, the whole AM count is credited as
  cleared. Thursday's collection bucket already shows +68 though nothing has been entered for
  Thursday PM.
- **A day-of-week bucket fills up the day before its day, and that fill is subtracted.** One bucket
  went from 81 to 0 on its day and scored Comp 12. Another cleared 84 and scored Comp 6.
- **An empty bucket all week scores 2**, below the goal of 8, though there was nothing to do.
- **A typed 0 inbox scores 10.** Nothing separates "inbox cleared" from "PM never entered".
- **The paid tier counts points**, so one 12-point account weighs as much as 12 one-point accounts.

## 8. What HRIS could fill in by itself

- **Verified:** the roster (name and department) for every row that is a person on the Global Master
  List. Also the Dancing Queen day variables: a rebuild could write Monday to Friday directly and
  drop the weekly copy. That is a money path, so it needs `hardening` and the § 1 ruling.
- **The data exists, the definition needs confirming:** hires that started Monday (GML `Start
  Date`) and the Lead Gen headcount (GML `Department`). The sheet's Lead Gen number is a sum of three
  unlabelled typed numbers.
- **Not verified:** payroll processing time from the wizard or dispatch (no stored start/stop stamp
  was found by name), payroll "problems" from dispatch Problem rows (no per-person attribution), and
  live status from Hubstaff.
- **Outside HRIS:** bucket sizes and chargebacks (the CRM, likely Bitrix), the customer count, and
  inbox counts (Gmail, which would need mailbox-level access).

## 9. A separate domain, inside this project

- **Precedent:** `proxy.ts:178-231` already serves two extra hostnames from this app,
  `BANK_UPDATE_PUBLIC_HOST` and `GIFT_ADDRESS_PUBLIC_HOST`. Each does nothing until its env var is
  set. On that host only the one page and its API exist, and every other path is a 404 or a redirect.
  Both are **public pages behind an email code**, not Google sign-in.
- **Sign-in** is NextAuth v4 Google SSO with one canonical origin: `NEXTAUTH_URL` =
  `https://simple-hris.vercel.app` (`src/lib/auth/auth-options.ts:13`). The session cookie set there
  is never sent to another domain. `vercel.app` is a public suffix, so the two hosts cannot share a
  parent domain either.
- A separate **Tickets** domain was dropped on 2026-07-15 for exactly this reason (*"OAuth redirect
  hassle"*, memory `tickets-board-deploy-steps`).
- So the new domain needs one of three setups:
  - **(a) Its own Google sign-in.** Add the new domain's callback to the Google OAuth client, and
    make NextAuth handle more than one host. That is a change to the auth core.
  - **(b) A public page behind an email code, like the gift host.** No Google console change is
    needed. People who are not on the roster cannot receive a code. Entering numbers twice a day
    means re-verifying each time, unless the code's session lasts long.
  - **(c) The domain forwards to a signed-in HRIS page.** No auth work, but the address bar ends up
    on the HRIS address.

## 10. Brief (blueprint), first HELD, then BUILT the same day

**Superseded 2026-10-01, same session.** Kane answered NEEDS 4 (*"accounting-bonus.vercel.app - lets
point that here"*). Re-scoped, NEEDS 1, 3 and 5 turned out not to shape the tables. The sections became
switchable, rows can be people or named rows, and nothing pays. So the board was built. Sign-in needed
no auth change, because NextAuth v4 on Vercel takes its origin from the request host. The live record
is `docs/features/accounting-scoreboard.md`. Still open from this brief: NEEDS 2 (points vs accounts,
Open item 315), NEEDS 5 (the bonus shape after the revamp), and the history import. The held brief
below is kept as it was posted.

```
BLUEPRINT  Accounting Scoreboard, in HRIS, on its own domain — HELD
READ    department-bonus.ts:120,176-180,372-395 · proxy.ts:178-231 · auth-options.ts:13 ·
        memory tickets-board-deploy-steps · external-api-integrations · kane-wants-terse-replies
LIKE    gift-address host isolation (GIFT_ADDRESS_PUBLIC_HOST) for the domain ·
        KPI calculator / bonus_catalog_applied for the Dancing Queen hand-off
SCOPE   in:  entry board (AM/PM pairs + daily counts) · collections log · automatic week rollover and
             history · per-person checklists · day totals → Dancing Queen variables
        out: payroll wizard · dispatch · the bonus formula itself
CHOSEN  1  Rows = HRIS people picked per section (department as the quick filter) plus named rows
           that are not people (buckets, shared inboxes). Why: sections cross departments (§ 4).
           Other way: department-only sections lose 5 people, every bucket and both inboxes.
        2  "Last week", "All Time" and history are computed from stored entries and never typed.
           Other way: weekly snapshots, which means more writes and a rollover job.
NEEDS   1  Carla: which sections stay (she asked not to track everything)
        2  Money: does the tier count points (paid today) or accounts?
        3  The 5 people not on the Global Master List: add them, or allow rows that are not on the roster?
        4  Kane: the domain, and sign-in option a, b or c (§ 9)
        5  Carla: after the revamp, is the bonus one team amount or paid per person / per section?
           This decides whether every row must be a person
```

*(As posted, before the domain answer:)* NEEDS 1, 3 and 5 decide the tables, so nothing is built
until they are answered (`.claude/skills/blueprint/SKILL.md`, the hard-stop row).

## 11. What was not read

- History, Totals - History, Sales and Pauses beyond row 5. The full re-fetch was refused by the
  auto-mode permission classifier, and it was not retried.
- The task tabs were read for their task text only.
