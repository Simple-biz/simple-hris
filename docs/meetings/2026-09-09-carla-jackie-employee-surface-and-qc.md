# Employee surface review + Lead Gen QC hand-off

**Date:** September 9, 2026, 10:33 EDT
**Participants:** Carla T (Accounting/HR owner), Kane R (engineering), Alivia H, Jackie Z (Lead Gen · Callback · Discovery manager, joined ~00:31)
**Source:** meeting transcript, processed 2026-09-09. The transcript as received is **truncated** mid-answer — see §9.

> Every "current behavior" statement below was verified against the working tree on 2026-09-09 by a
> read-only audit of 13 surfaces (code + governing docs + memory). Where the room's premise was
> wrong, §6 says so with the file and line. **Three of the meeting's decisions rest on a false
> premise** and cannot be executed as stated.

-----

## Executive summary

Carla's frame: the HRIS is **85% shipped-ready**. Payroll/accounting (wizard, PAB, tech bonuses) is
"perfectly perfect"; onboarding and offboarding are "very spot-on". The remaining 15% is the
**Employee** surface, which is what the meeting walked. Separately, Jackie's Lead Gen bonus entry
moves off her weekend copy-paste ritual and into HRIS via a new **paste → Compare → Override** step.

One thing was unambiguously **approved for build**: the per-day time-adjustment nudge (§2.4).
Everything else is a ruling, a rename, or an open question.

## 1. Readiness framing

Carla: *"we're 85% there to being finished with shipping this out to everybody. The main concerns
though are under employee."* Surfaces she declared done: Payroll Wizard, PAB, tech bonuses,
onboarding, offboarding. Kane's opening caveat: *"he's not going to catch everything. We've missed a
lot already."*

**This readiness picture and the engineering release gate do not overlap.** Carla's 85% is
functional completeness on the surfaces she owns. The release-blocking work is auth, API
authorization, headers and compliance artifacts — none of it in the surfaces she named, and none of
it raised in the meeting. Verified state as of this meeting:

- The **shared-password impersonation backdoor is still present and still default-ON.**
  `src/lib/auth/auth-options.ts:44` falls back to the committed literal `'super-admin'`;
  `:45` `IMPERSONATION_ENABLED = process.env.SUPER_ADMIN_IMPERSONATION !== 'off'` — absence means ON.
  Neither key is set in `.env.local` or `.env`, so both fallbacks are what run locally.
  `.env.example:69` still ships the password **uncommented**. `/login` is public
  (`proxy.ts:151-154`) and `app/login/page.tsx:588-627` advertises *"Sign in as any @simple.biz
  account"* — and that panel is gated only by local React state, never by `IMPERSONATION_ENABLED`,
  so even a production `=off` leaves the invitation on the public page.
- **4 of the 6 named ungated API routes remain** (2 closed earlier the same day in `ddf4c790`).
  Three of the four sit in areas Carla called finished or fine:
  `manager/member-monthly-pay`, `hr/fpu-enrollments`, `hsl-bonus/period-summary`, plus presence.
- `SHOW_UNPAID_STAGED_PAYSTUBS = true` sits in **exactly the Employee surface Carla calls the
  remaining 15%**, showing unpaid and snapshot-recovered weeks to every employee as final.

**Decision needed (nobody raised it):** does the end-of-month company-wide release wait on those two
blocking items, or ship alongside them? Widening the audience to everybody is what converts the
backdoor from an internal-tool risk into a company-wide one.

## 2. Employee surface — the remaining 15%

### 2.1 Profile — Overview + ID + Compensation into one pane

**Ask (Carla):** *"the profile under employee — overview, ID and compensation all need to be one tab."*

Overview, ID and Compensation are **already inside the single Profile page** — they are three of nine
in-page section chips (`EmployeeProfile.tsx:151`, strip at `:507-517`), not tabs and not routes. The
sidebar has one Profile item (`EmployeeSidebar.tsx:78`) and the Pages registry one `profile` key
(`visibility.ts:147`). The chips are a real ARIA tablist with an animated underline, so they *read*
as tabs — Carla's wording matches what she sees.

So the ask is: **collapse the three chips into one pane**, 9 chips → 7. It is a presentational
reshuffle inside one file; no data loading, caching, auth or routing moves. Two things it forces:

- **Start Date appears twice** on the merged pane (Overview row + the ID card). `formatStartDate`
  (`EmployeeProfile.tsx:133-141`) uses `new Date(s)` while the card's `formatIdCardDate`
  (`src/lib/employee/id-card.ts:89-95`) uses `parseDateOnlyLocal` — so for any viewer west of UTC
  the merged pane will **contradict itself by one day**. The off-by-one is still open, flagged
  2026-09-04 rather than fixed. Merging makes it visible side-by-side.
- **Payment must NOT be folded in.** It is the editable payout form, deliberately uncached because it
  carries account numbers (`employee-dashboard-cache.md:121-126`), and it is the bank-preferred
  dropdown's documented home (`bank-preferred-routing.md` §1).

Do not move the `label: 'Pay Stubs'` or `label: 'Request Documents'` strings: a Penny guides test
source-scans this file for both (`src/lib/penny/employee-guides.test.ts:166-169`) and fails the build
if either moves.

### 2.2 Skill Sets — trim it down

**Ask (Carla):** *"trim this down… I just need it to be less busy. I don't need people spending all
day typing about their life… maybe set caps, like 10 on each of these, so they can only have a
limited space and not write a whole book."*

A blanket cap of 10 is incoherent against the current shape: Role/Title is a single value, **Current
projects is already capped at 2** (so "10" would be a *loosening*), and Skills and Strengths are
single free-text blobs with no item concept at all — today the only limit is 4000 characters per
whole field (`app/api/employee-skill-sets/route.ts:13`) with **no client cap whatsoever**.

Note the likelier read: *"less busy"* describes the **display**, and the two modal call sites
deliberately widen the chip page from 12 to 60 (`team-ui.tsx:111` vs `EmployeeTeam.tsx:1158`,
`ManagerMemberDialog.tsx:298`). Lowering those is a display trim that needs no cap — and a cap does
nothing to quieten a 40-chip row that already exists.

### 2.3 Reports → "Badges and Certificates"; awards move to the manager

**Asks (Carla):**
1. Rename the employee Reports tab: *"it should be like Badges and Certificates."*
2. *"Award and certificate should be put in under manager. So managers have the option to generate a
   certificate and give it to one of their people on their team. And that award or certificate would
   also be looped in with their badges and certificates."*
3. Payroll summary, pay slips, COE and Resign in Request Documents are all **fine as-is**.

The rename removes a real collision — "Reports" already names the retired Pay Cycle Reports, the
wizard's step-9 Reports table, and CEO → Financial Reports.

Manager-generated certificates are a **new build**, and the largest unscoped item after QC. Nothing
today stores a certificate: `employee_medals` hard-codes `['commend','flag']`
(`app/api/manager/medals/route.ts:66`) and has no file column. Two gaps worth naming before any
code: `POST /api/manager/medals` currently accepts **any** `employee_email` from the body under the
`manager/team` grant with **no own-team check** — "one of their people on their team" implies a
roster scope that does not exist on that write path; and there is no template, title, or reason
field anywhere, so "what does the certificate say" is unanswered.

### 2.4 My Hours and time adjustments — APPROVED FOR BUILD

**This is the meeting's top priority.** Employees cannot find how to submit a time adjustment.
Carla: *"just make it dummy proof. I don't really care how you do it. You could put a big giant
button right here for all I care. I just think people are not going to do this right here."* Her
analogy: it is the one brand on the bottom back shelf — you have to hover and read before you find it.

**Approved (the only build approval in the meeting):** Kane's per-day nudge —
*"any day that they missed the pay that disqualifies them… I'll add, you see that chat bubble on
comics, where it will pop up: do you need a time adjustment, click here."* Carla: *"Yeah. Okay. Just
do it and then show me when it's done."*

**Floated and NOT decided** (do not treat either as approved):
- Kane: *"replace the My Hours with Time Adjustment and the rest of those things are just bonuses."*
- Carla: My Hours with sub-navigation — **My Hours / Time Adjustments / PAB Calendar**, where the PAB
  calendar is view-only and Time Adjustments carries the form.

Two facts that shape the build:

- **The nudge trigger Kane named does not cover the case Carla demonstrated.** Red is `<7h WITH data`
  (`EmployeeMyHours.tsx:1780`). Carla's failed click was on a **zero-hours** day, which renders sky
  "Processing" (`:1770`) or orange "Pending" (`:1773`) — **never red**. If the nudge keys on red only,
  it will not appear on the day she was trying to fix.
- **The per-day entry point was removed on purpose.** Kane: *"before, but I removed that."* The
  server still accepts any past date (`app/api/time-adjustments/route.ts:94`), so only the UI is
  missing. Note `canRequestAdjust` requires `inMonth` (`:1704`) while the server has no month
  restriction — filing for the last days of the previous month means paging the calendar back first.

Related, and unresolved at root cause: a **blank calendar day can be an ingest artifact, not an
absence** (`docs/notes/hubstaff-sunday-overlap.md` — 98 people worked Sunday May 10 and every
surface showed nothing). A nudge that reads a blank cell as a missed day will sometimes invite an
adjustment for a day the person actually worked.

### 2.5 PAB card, calendar and "Details" → "FAQs"

**Asks:** a view-only PAB calendar employees can toggle to (*"it gives them like, you're eligible
this day, this day, this day"*); redo the wrong explainer line; rename **Details → FAQs** (Kane
proposed, Carla agreed); and **keep** the explicit qualify/not-qualify statements —
*"I like this part that it tells me… because then if they don't get it they can say hey, it says I do."*

**The premise is wrong.** Kane concluded *"there's no calendar there as well… it's worse than I
thought."* A full, HSL-aware **PAB Calendar already ships on the employee Overview**
(`EmployeeDashboard.tsx:3385-3796`), and employees have a **second, month-navigable** one in My Hours.
Three code paths already tell employees to look there, and a test pins the wording
(`employee-tools.test.ts:157`).

What is genuinely missing is narrower and cheaper than a new calendar:
- **The drill-in.** The PAB stat cell (`EmployeeDashboard.tsx:2870-2903`) is a plain `<div>` — no
  `onClick`, no `role`, no `tabIndex`. Clicking "Not met" is **inert**.
- **A calendar inside the popup.** The Details dialog (`:3844`, title "PAB & bonuses" at `:3850`) has
  the explainer, the status rows and the pay snapshot — and **no calendar**. On mobile the popup *is*
  the PAB surface, so there the calendar really is absent.

**Carla is right about the copy, and it is wrong three ways** (`EmployeeDashboard.tsx:3859-3864`,
the only occurrence in the repo):

1. *"counting starts on the second Monday"* is **never** correct. The code takes the **first Monday
   on or after the 1st** (`calendar-column-dedupe.ts:175-192`, and its own docstring says so).
2. The worked example is off by a week: March 2026 is **Mar 2 – Apr 3**, not the printed *"Mar 9–Apr 3"*.
   `docs/reference/business-logic.md:76-79` already prints `Start = March 2`.
3. It asserts Mon–Fri for everyone, which is **false for HSL** (5-of-7 over whole Sun–Sat weeks).
   `isHsl` is in scope on the same screen and the shipped calendar already branches on it — only the
   copy does not.

**Also:** the eligible/pending statements Carla explicitly wants **kept** (`:2296-2298`, `:2314-2319`)
carry the *same* Mon–Fri-only framing and are wrong for HSL for the same reason. The meeting flagged
one line; the defect is in three places.

### 2.6 Team directory — peers should not see legal names

**Ruling (Carla), on safety grounds:** *"we got some really creepy people here sometimes and they
shouldn't be able to see full names on their team. They should only see like their nickname, the
whatever is in quotation marks, and their email… this should be shortened down to just say Carla."*

The ask is well-founded and **larger than she thought**. The directory's only identity string is the
master-list `Name` column passed through untouched — there is no nickname extraction in the component
at all. A peer currently sees the full surname-first legal name in **five** places:
the card headline (`EmployeeTeam.tsx:935`), the profile-modal title (`:1101`), the screen-reader
description (`:1148`), the avatar initials (`:916`, `:1090` — surname initial **first**), and the
Rankings rows (`:336`, `:341`, currently allow-listed to one reader).

Two exposures beyond the rendered name:
- **Personal email leaks by fallback.** Card and modal both do `t.workEmail ?? t.personalEmail`
  (`:892`, `:1082`) — a teammate with no work email has their **personal** address shown to the whole
  team. Carla said *"their email… all of this is fine"*; she was almost certainly talking about the
  work email.
- **Search matches the hidden fields** (`:680-682`), including personal email — so a peer can confirm
  a guessed legal name or personal address by typing it. Redaction that leaves search alone is cosmetic.

Two decisions this needs: **the fallback token**, because the go-by is *derived* as "the last given
token that is not a bare initial" (`src/lib/name/display-name.ts:36`) — rendering the quoted token
alone would introduce *Jane Marie Santos* to her whole team as **"Marie"**; and **client vs server
redaction**, because Carla's safety framing argues the legal name should never reach the peer's
browser.

> **RESOLVED AND SHIPPED 2026-09-12.** Kane: *"let us only use the first name for our team members
> please as to cover them because there are some creepy people around so just use the one inside the
> quotation marks, if there is none inside there please make sure to just use the first name."*
>
> - **Fallback token:** the literal quoted go-by, else the **FIRST name** — never the derived go-by
>   and never every-given-token. `shortDisplayName` in `src/lib/name/team-display-name.ts`.
> - **Client vs server:** **server**. `TeamRosterProfile` no longer has a `name` or a
>   `personalEmail` field at all, so search, sorting and the `??` fallback were all closed by the
>   same change.
> - **Collisions** (Kane delegated the rule): surname initial → work-email local part → index.
>
> **The blocker in the paragraph above was FALSE and is retracted.** `/api/team-roster` does **not**
> feed the manager roster — `getTeamRoster` has exactly one caller
> (`app/api/team-roster/route.ts`), and that route has exactly one client caller
> (`EmployeeTeam.tsx`). ManagerApp's roster is a different source, and Jackie's June "Full Name +
> Work Email" request is untouched. No per-caller branch was needed; the redaction is blanket.
>
> Full spec: `docs/features/employee-team-directory.md` § "Identity redaction".

### 2.7 Leave request filing — STAYS ENABLED (ruling)

Kane wanted it withheld: *"it will mess it up because… we have an exceptions thing in accounting and
they're exempted… and that will feed HRIS."*

**Carla overruled him, with reasoning Kane accepted** (*"Yeah, that's right"*): a leave can only be
filed **forward-dated**, so it can never touch the cycle being paid. *"If I go on leave today all the
way until the 11th, we're not paying that cycle out yet… I have hours from Monday until the 8th…
I'm still going to be in payroll because I have hours for that week."* And her reason for wanting it
visible: **leave is the signal that someone is not offboarded.** *"If I see that you're not logging
hours but you still have Hubstaff, I'm going to delete you out of Hubstaff and delete your email.
But if I see that you're on leave, then I don't care."*

Kane's follow-up was *"I'll check with Claude as well, make sure he sees all."* This is that check:

- **Her conclusion is correct, and the code already agrees with her.** `classifyZeroHours` already
  treats approved vacation leave as a legitimate explanation for a zero-hours week
  (`zero-hours-gap.ts:25-27`), and Readiness deliberately hides on-leave people. Nothing in the
  payroll or PAB path exempts a person because of a leave row. Kane's fear is unfounded.
- **But the forward-dated guarantee her argument rests on is not real.** It exists **only in the
  browser picker** — `min={today}` at `EmployeeLeaves.tsx:360`/`:371`. Submit-time validation checks
  only that end ≥ start (`:187-193`); the **API POST has no lower bound at all**
  (`app/api/leave-requests/route.ts:118-131`); and the DDL has **no CHECK, not even end ≥ start**
  (`references/sql/create/leave_requests.sql:8-9`). A hand-rolled POST files a backdated leave and it
  inserts. Additionally `today` is computed with `toISOString()` (UTC), not the house Manila helper
  (`src/lib/payroll/manila-week.ts:20`) — so **for eight hours of every day the picker's own minimum
  is yesterday.**
- **Do not "fix" this by adding a hard floor without a ruling.** **Sick** and **Bereavement** are two
  of the five offered leave types (`EmployeeLeaves.tsx:53-70`) and both are inherently filed *after*
  the fact. A server-side floor would break them.

Open and unruled: **nobody decided whether an approved leave should forgive a PAB day.** Today it
never does — forgiveness is disputes ⊕ time adjustments — and `employee-guides.ts:126` tells
employees so. An employee who files leave and still loses the attendance bonus is a predictable HR
ticket now that filing is officially blessed.

### 2.8 PAB issue submissions — left alone, but the payout question is real

Carla: *"I don't really care about this one either… if they have an issue, it's going to apply to the
next cycle. It can't be applied in the current cycle that I'm paying."* Ruling: **not a blocker,
leave as-is.**

She then asked a question that nobody answered: *"let's say I forgot to request a time adjustment on
one day and that's why I'm ineligible for the PAB. If I submit a request… and accounting says oh yeah
you're right… you DO get the PAB. Where does that go? Do they get the 5,000? How does that work? I'm
still a little confused on that process."*

**The code's answer: nothing pays it.** PAB is computed at dispatch gated on
`weekEnd >= pabPeriodEnd` (`payment-dispatch.md:444`), and a grant that arrives after that week has
no line. The only ungated path is the Accounting **Adjustment** column
(`PayrollWizard.tsx:9385`), which prints as an unlabelled *"Adjustment (PHP)"* with no link back to
the dispute. Meanwhile the approval notification already promises the employee
*"This day now counts toward your PAB eligibility"* (`pab-disputes/[id]/route.ts:204`) —
**unconditionally**, whether or not the payout week has passed.

Also worth knowing: `PabDisputeQueue` has **no period-closed awareness**, so an approval for an
already-paid month is indistinguishable from one for a live month, and nothing flags the rows already
in that state.

### 2.9 Gift tracker — stale, and it is not only a data problem

Carla's first-listed concern: *"we need to hunt Ellie down because the gift tracker is out of date.
We need to get caught up on who has and hasn't received a gift so that the HR is correct."*
Alivia messaged Ellie last Thursday; Ellie replied that the tab copy of active people is done, *"not
sure what the next step is, I'll get with Kane"* — and did not. Ellie has Jake, Julia and Mary
helping, and Bob travels to the Philippines in October.

**HRIS has no concept of a gift being shipped or received.** The only lifecycle on
`employee_gift_shipping_details` is address review — `'pending' | 'approved' | 'rejected'`
(`employee-gift-shipping.ts:4`, DDL `:26-27`) — and there is **no `shipped_at`, `received_at`,
courier or tracking column anywhere**. "Approve" is documented as *"lock the submitted details. Gifts
are informational — no price, no gift assignment"*. Who gets **asked** is pure tenure arithmetic on
`start_date` (`gift-milestones.ts:77-93`), suppressed only by the existence of a submission row.

So: the question *"who has and hasn't received a gift"* **cannot be answered from HRIS**, Ellie's
catch-up has **nowhere to land**, and nobody — Ellie included — has any affordance to record
"I shipped this." Chasing Ellie will not fix it; a receipt state has to exist first. That is a
migration plus a route plus a control, and a decision about whether HRIS or Ellie's sheet is the
ledger (today the doc says the sheet is).

## 3. Lead Gen QC hand-off — paste, Compare, Override

### The manual reality today (Jackie, correcting Carla's guess)

Carla assumed an automation tied to Thomas's email updated the appointment column. Jackie: **"No.
It's all manually entered information daily."** Every day a *different* QC person tallies approved
appointments on the appointment sheet (today Enzy). On the weekend Jackie sorts her team sheet by
column D and the scorecard by column B, both alphabetically by **scorecard name**, then pastes
**10–15 rows at a time**, cross-checking each paste.

### What was decided

- **NEW FEATURE — paste → Compare → Override**, in Manager → KPI Calculator, using the same paste UX
  as the payroll wizard's orphanage-hours step. Kane: *"there's going to be a button called Compare
  and it will show you a list of inaccurate. And then a next button called Override where it will
  replace whatever [the QC] added."* Plus **a histogram of which QC officer is most inaccurate.**
  Carla's requirement: *"without her having to manually go through each single one."*
- **Paste format = Jackie's weekly payroll email: work email, full name, total appointments.**
  Kane: *"as long as the three columns exist, that's all I need"*; **work email is the join key**.
  Jackie emailed samples during the call.
- **Randomize QC assignment every week.** Carla's reason: *"I would rather have it randomized so that
  no one has a buddy on a certain team and they're like, oh I'm going to give them 10 appointments."*
  Jackie: *"Great point. Let's do that."*
- **Remove Alivia from the QC role** — she is not QC.
- **Remove Callback from QC scope** — *"just Lead Gen needs to be QCed."* Callback stays Jackie's
  alone; she declined putting Jerome on it since it would be only him.
- **No daily entry into the calculator.** Kane: *"the higher the frequency that they type in the
  calculator, they will mess it up 100%. That's why I do it after the week is done, so they only have
  to go in there once."* The daily tally stays on the Google sheet.
- **Jackie's KPI ownership is now: Callback, Discovery, Lead Gen, QC, and Sales Assistants** —
  Sales Assistants moved from Carla (*"I just don't think if I pass this on to Justin… it's not going
  to end well"*).
- **Testing Monday** with real data, all QCs in a chat. **Scheduling is unresolved** — Jackie's
  training is also Monday (see §9).

### Two of these rest on a false premise

**Randomization does not exist.** Kane said *"it's randomized already"* and offered it as the reason
Carla's anti-buddy requirement was satisfied. The code is a **deterministic alphabetical
round-robin** (`qc-db.ts:304-306`): member slots sorted by email ascending, dealt `i % officers.length`
against an officer list ordered by `assigned_at`. A repo-wide search for `Math.random|shuffle|randomi`
across the QC data layer, lib, components and routes returns exactly one hit — a welcome message.
**Officer #1 gets the alphabetically-first slice of Lead Gen every single week** — precisely the buddy
risk Carla ratified randomization to kill. The *even* half of Kane's claim is true (counts differ by
at most 1). It is also weekly-keyed but **not weekly re-dealt**: an existing week re-splits only when
the active officer set changes.

**"People with hours will be checked" is not implemented either.** The only eligibility filter is
start date (`qc-db.ts:253-258`); the roster is the full active master list filtered by department,
with **no Hubstaff join anywhere in the file**. Lead Gen carries ~193/week "listed never scored", so
zero-hours Lead Gen people are being dealt to QC officers today.

### Before any code (the blueprint brief owes these)

- **The QC surface is effectively undocumented**: a 623-line data layer, four API routes, a 1033-line
  dashboard and a shared 5360-line calculator, and the entire written record is two clauses in
  `INDEX.md:24` plus three sentences in `hsl-kpi-calculator-2026-07.md:573-575`. The doc that INDEX
  row names (`bonus-calculator.md`) is an April PAB/Tech reference with **zero** QC mentions.
- **Which formula variable holds the Lead Gen appointment count in `qc_kpi_submissions.vars` is not
  declared anywhere.** Compare cannot be built until it is pinned — and pinned by a test.
- **What counts as "inaccurate"** is undefined. A one-appointment miss across the 9/10 boundary is
  worth ₱2,500; the same miss at 3 appointments is worth ₱250.
- **Absence is not zero.** `saveDeptPeriodApplied` is a replace-set, and the panel paginates at 8
  while Jackie's sheet is 280+ rows — an Override built from a partial paste that treats
  absent-as-zero would **silently clear real scores**.
- **The QC dashboard is locked out during dispatch** (`payment-dispatch.md` §6.3): full client
  takeover on `dispatch_locked`, and `/api/qc/{submissions,lock,review}` return 423. Compare/Override
  inherits that.
- **QC is a non-announcing dashboard** (`notification-alerts.md:89`) — only HR, Accounting and
  Employee announce. Load-bearing if Compare is meant to notify anyone.
- **Who may see the per-officer inaccuracy histogram?** It names individual officers' error rates to a
  manager who is not their manager. Nobody said whether officers see their own number, each other's,
  or whether it is manager-only.

## 4. Bonus structures

**Jerome (Callback) has two bonuses** — an appointment bonus and a **lead receptionist** bonus set on
**units sold**. The second is added via an empty checkbox that reveals a second line. Open: whether
Jerome's live master-list department is actually `callback` — the transfer is recorded but was once
silently reverted, and the only snapshot in the repo still says QC. Stale QC-scoped statements for
his `₱30/unit` leg remain in five places and should be corrected or deleted.

**Sales Assistants — the split rule.** A rep's units sold are **divided equally among their VAs**:
Justin at 20 → Deb 10, Dean 10; at 53.5 → 26.75 each. Carla: *"it gets split in half against all of
their VAs."* Rationale: *"if they have two VAs and they're doing less work each, they don't get the
entire thing."* Justin currently has **two** VAs, not three. Nothing in the repo expresses a
rep→VA mapping, and the US `sales` department is retired from the KPI Calculator with no scoring
surface — so **the meeting stated a rule but never asked for a feature**. Whether HRIS computes the
split or Jackie types the halved number decides whether this is trivial or a new build.

### ⚠ Pre/Post-Hearing: ₱2,500 vs ₱3,500 — DO NOT PICK ONE

A payroll-inbox email went out with the wrong amount. Carla: *"It was supposed to be 3500, bro. They
had 2500 on their sheet."* Alivia, reading the HRIS value: *"Yeah, it says 2500 max."* Action taken
in the room: screenshot what HRIS shows, send it over, and ask them to reach out to Jackie about why
it was not updated.

**₱2,500 is pinned in six places, all sourced to Carla, all dated 2026-09-08 — one day before this
meeting:** `src/lib/hsl-bonus/schema.ts:279` (`amount: 2500`), its test
(`schema.test.ts:307-315`, `assert.equal(r.amount, 2500)`), `hsl-kpi-calculator-2026-07.md:23` and
`:91-113`, `INDEX.md:23`, the 2026-09-09 audit session log, and memory.

This is a **direct contradiction with a ruling Carla herself gave the previous day**, and it cannot
be satisfied without overwriting a pinned pay value **and rewriting its assertion** — which the
project rules forbid as a way to make an ask fit. It needs one explicit ruling before any edit.
Note the coincidence that makes it ambiguous: **₱3,500 is also the weekly KPI cap**
(`schema.ts:271`), and the flat is currently cap-exempt because a fixed ₱2,500 under a ₱3,500 cap
would eat the rest of the KPI. If the flat becomes ₱3,500 it exactly equals the cap — so it is
genuinely unclear whether the ₱2,500 flat, the ₱3,500 cap, or a manager band was the number meant.

**What would settle it:** one worked example for one named person for the 2026-08-30 final week —
what should their Monthly Bonus line read? Also unresolved: whose sheet had ₱2,500, and whether the
already-dispatched 2026-08-30 week gets reopened, back-paid, or left alone.

## 5. Employee score / compliance dashboard — idea only

Kane: *"we need to have as much data as possible to create an employee score or something. A point
system, like an SP."* His payoff example: Penny narrating *"why does this guy have no hours 9 to 10 —
because he filed a leave on that specific date, approved by his manager, received by Carla at this
time."* Carla connected it: *"that's what the compliance dashboard needs to be connected for."*

**Explicitly NOT a payroll gate.** Kane: *"I don't know if it's needed to be closed when
processing"*; Carla: *"I don't think so… it doesn't really affect the current cycle."* That ruling is
the important part to keep: nothing from this may reach the readiness blocker set or the wizard's
Setup checklist.

Reality check: **no compliance dashboard exists** — not built, not planned in-repo. The only prior
version of this ask is the never-built "Manager Scoreboard" from the 2026-06-16 meeting, so the
meeting connected a new ask to a plan that was never scoped. Camera/Hubstaff violations are **not
stored at all** — Carla receives them by email from the compliance team. And Kane's narrative is not
yet achievable: `leave_requests` has no `decided_at`/`decided_by`, and *"received by Carla at this
time"* corresponds to **no event in any form**. Also note **"SP" is already taken and already paid**
(`bonus_catalog_applied.vars.SP`, `=SP*15 + Project_SP*80`), so a second point system needs a
different name.

## 6. Corrections to what was said in the room

| Said in the meeting | Verified state |
|---|---|
| *"It's randomized already"* (QC assignment) | **False.** Deterministic alphabetical round-robin, `qc-db.ts:304-306`. No RNG in the QC surface. |
| *"People with hours will be checked"* (QC roster) | **Not implemented.** Start-date filter only; no Hubstaff join. |
| *"There's no calendar there as well"* (employee PAB) | **Wrong.** An HSL-aware PAB calendar ships on Overview, and a second one in My Hours. The **drill-in** and the **mobile popup** are what's missing. |
| Thomas has a formula/automation updating appointments | **No automation.** Jackie: *"it's all manually entered information daily."* |
| Leave can't be backdated, so it's safe | **True in the picker only.** No server or DB bound; `today` is UTC, so the picker itself permits a 1-day backdate 8 hours a day. |
| Nudge on "any red" day | **Misses Carla's own case.** A zero-hours day renders sky/orange, never red. |
| Pre/Post-Hearing *"was supposed to be 3500"* | **Conflicts** with ₱2,500 pinned in code + test + 2 docs + audit log, all sourced to Carla 2026-09-08. |
| `Alt+E+S+U` pastes values unformatted | Excel-only. In Sheets and Gmail it is **`Ctrl+Shift+V`** — as the room worked out live. |

## 7. Action items

**Kane**
1. **Build the per-day time-adjustment nudge** (§2.4) — the only approved build. Resolve which day
   states trigger it *before* coding; red alone misses the demonstrated case. Show Carla when done.
2. Rename **Details → FAQs** and **rewrite the PAB explainer line** (§2.5) — fix all three defects,
   and fix the two sibling statements that carry the same wrong HSL framing.
3. **Wire the PAB drill-in** (inert stat cell) and put a calendar in the mobile popup (§2.5).
4. **Merge Overview + ID + Compensation into one pane** (§2.1) — and decide the duplicate Start Date.
5. **Redact legal names from the employee peer directory** (§2.6) — pick the fallback token, decide
   client vs server, and handle search + the personal-email fallback.
6. **Rename Reports → Badges and Certificates**; scope manager-generated certificates via `blueprint`.
7. **QC**: revoke Alivia's `qc` role; remove Callback from QC scope; **implement real weekly
   randomization** (it does not exist); decide the zero-hours question. Then `blueprint` the
   paste → Compare → Override step + histogram, and write the QC feature doc + INDEX row that the
   surface has never had.
8. Trim Skill Sets (§2.2) — confirm whether the complaint is input volume or render density first.
9. Connect with **Iris** about the classes for the Monday board (still not done as of this meeting).
10. Verify in the Vercel **production** environment whether `SUPER_ADMIN_IMPERSONATION=off`
    (§1) — unknowable from the repo. Until proven, treat production as exposed.

**Carla**
1. **Rule on Pre/Post-Hearing ₱2,500 vs ₱3,500** with one worked example (§4). Blocking.
2. Rule on the **retro-PAB payout path** — her own unanswered question (§2.8).
3. Decide whether the EOM company-wide release waits on the two blocking security items (§1).
4. Show Jackie the KPI Calculator and Jerome's second-bonus checkbox on Monday.
5. Decide whether she keeps or releases the Sales Assistant department grant (§4).

**Alivia**
1. Create the group chat — **Ellie, Kane, Carla, Alivia** — and keep following up on the gift tracker.
2. Screenshot the HRIS Pre/Post-Hearing amount, send it to the payroll inbox, and ask them to reach
   out to Jackie about why it was not updated.

**Jackie**
1. Send Kane the three-column sample (work email, full name, total appointments) — done in-call by email.
2. Confirm the Monday-vs-Friday testing slot against her Monday training (§9).

**Ellie** — catch up who has and hasn't received a gift. **Note:** there is nowhere in HRIS to record
it today (§2.9), so this needs Kane first.

## 8. Open questions requiring a ruling

1. **Pre/Post-Hearing: ₱2,500 or ₱3,500?** Which number, on which line, for which week. Blocking (§4).
2. **Retro PAB:** does a late-granted dispute pay the ₱5,000, on which week, as a PAB line or an
   Adjustment — and is there a cutoff after which Accounting declines? (§2.8)
3. **Does an approved leave forgive a PAB day?** Unruled; today it never does (§2.7).
4. **Should backdated leave be blocked server-side?** Sick and Bereavement argue against a hard
   floor (§2.7).
5. **EOM release vs the two blocking security items** (§1).
6. **Skill Sets:** what is one "entry", what is the character limit, and what happens to rows already
   over the cap? (§2.2)
7. **Certificates:** what is the artifact, who signs it, what does it say, and scoped to whose team?
   (§2.3)
8. **QC Compare:** what counts as "inaccurate", what happens to people absent from the paste, and who
   sees the officer histogram? (§3)
9. **Sales Assistant split:** does HRIS compute it, and where does the rep→VA mapping live? (§4)
10. **Gift receipt:** does HRIS become authoritative for "gifted", or does Ellie's sheet stay the
    ledger? (§2.9)
11. **Employee score:** per-person or per-manager, computed or curated, and who may see it? (§5)

## 9. What this meeting did not settle

- **The QC testing day.** The transcript as received **cuts off mid-answer**: Jackie raised that her
  training is on Mondays, said *"I would say Fridays, but I'm assuming y—"* and the record ends.
  Monday testing with real data was the plan; the conflict is unresolved. **Confirm before Monday.**
- **The My Hours information architecture.** Both the "replace My Hours with Time Adjustment" and the
  "My Hours / Time Adjustments / PAB Calendar" sub-nav were floated and neither accepted (§2.4).
- **Eight of the thirteen surfaces walked have no `docs/features/INDEX.md` row** — Profile, Skill
  Sets, Badges/Certificates, the employee PAB card, employee leave filing, the whole QC surface, the
  gift tracker's receipt question, and any compliance dashboard. The QC surface is the worst: a
  four-file, 7000-line feature with two clauses of written record.

-----

*Context mentioned in passing, recorded so it is not re-derived: Bob travels to the Philippines in
October (Ellie's bandwidth); Bob is speaking to Karen about making the bonus cap permanent, expected
within a week; Christine handles camera-violation checks, which moved off HR some time ago; the
Monday board API is mid-fix.*
