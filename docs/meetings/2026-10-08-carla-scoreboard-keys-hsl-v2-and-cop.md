# 2026-10-08: Carla and Kane: scoreboard Keys, HSL deferred to V2, a COP payee, and manager training

Google Meet call, **Thursday 2026-10-08, 16:48 EDT, about 30 minutes**. Kane R, Carla T.
Source: the meeting's auto-generated transcript, pasted by Kane on 2026-10-09 (it is computer
generated and garbles names; see Reference notes). Carla opened with one new scoreboard feature,
then went through her readiness list: HSL, COP, time adjustments, contractors, the payout
guardrail and the onboarding timing log. The last third was a demo of a gamified Monday board
built outside the HRIS. **Nothing was built in this session.** This note records the asks and
routes them as Open items **424–428** in the
[Sep 29 log](../audits/audit-2026-09-29-session-log.md), with dated notes on items 374, 390, 391
and 401. Every production figure below comes from a read-only probe run by session `24ba2a0d` on
2026-10-09 between 11:3xZ and 11:45Z (SELECTs only).

## Summary

**One new build, with a deadline that has not been met.** Carla wants **Keys** on the Accounting
Scoreboard: an Admin-only list of the paid platforms each person holds a seat on (QBO, Stripe and
others), so that offboarding someone shows every seat to remove (item 424). Kane said he would have
it done *"by 9"*, and Carla needs it *"before 9:00 a.m. tomorrow for Karen"*. **At 11:44Z on 10-09
(07:44 EDT) it is not built**: no commit after `f0eac591`, and no keys table or route in the tree.

**Two scoreboard follow-ups and one re-ask** (item 425): a block on the scoreboard summarising how
each person is doing on their tasks; Carla moved Julia from Assistant to **Admin** so she could
edit people's tasks (measured, 19:47Z 10-08, so the board now has **five live Admins**); and Joana
is still waiting on the Sales payments timing log from item 391.

**HSL is mostly V2** (items 426, 427). Carla proposes that HSL's managers keep the new-hire
checklist, transfers and offboarding, but **lose KPI entry**, keeping a read-only view of the
history, because HSL is billed for its staff bonuses. Not decided on the call. Measured: Jid holds
one of **19 live `edit` grants** on HSL KPI entry, and every write route checks `edit`, so a
`view` grant may be all the change needs. Kane: HSL scheduling and per-department manager views
are V2. Carla wants schedules with exceptions for every team, later, to settle PAB disputes, which
is a money rule.

**COP (item 428, OPEN MONEY).** The COP payee they checked no longer shows a figure near a million,
which matches item 407. Her stored rate is now in COP and equals the figure Carla read from her
sheet. A peso equivalent still shows on screen, NPD and the HRIS differ by about $2 for her week,
and Kane said he would change "that COP value" and her rate. What exactly he will change is not
clear, because the stored rate already matches.

**Three claims checked and confirmed.** The attorneys are on a weekly salary (set by Aliviah on
10-07, item 374). The second approver now shows on time adjustments (item 390's code is pushed).
The scoreboard work is already on the HRIS Monday board. Carla **accepted the payout guardrail as
built**: a mismatched account is confirmed, not blocked (item 401).

## Accounting Scoreboard: Keys, the platforms each person holds a seat on (item 424)

Surface: [accounting-scoreboard.md](../features/accounting-scoreboard.md). New (`blueprint`).

> "I need one more feature on the admin side and it can reside under setup members and what I
> would love is to be able to assign tags and those tags would be the platforms that my people have
> access to. So like there's roboform right and roboform holds all the passwords and when someone
> gets offboarded their roboform is disabled they lose all their credentials but they still have a
> seat on the platform unless somebody goes back and deletes them and removes them from that
> platform. QBO charges us per seat. Uh Stripe charges us per seat. So we lose money if we don't
> offboard them from all these other platforms."

> "if I ever needed to offboard [a teammate], I could click on his name. It would show me all the
> tags and I would be able to action all of that before kicking him off the team essentially."

> "you can maybe add another one that says keys. We can call them keys like I can create a key to
> QBO and you have a key to access QBO. And I can just make a bunch of keys and add it to one
> specific person."

- **What it is:** an Admin creates a key (a platform), assigns keys to people on the board, and
  sees a person's keys when offboarding them. Carla: *"this is more like a managerial tool. It's not
  for the team."* Kane: *"So, [Claire] has access to that."* Carla: *"Yes, Claire can have access to
  that."* Kane: *"So, whatever admin is in there."*
- **Where:** under Setup → Members, or a new Setup section named Keys.
- **What it replaces:** a sheet Carla keeps by hand, one column per platform, with *"done Carla"*
  typed in each cell (*"That's annoying."*). She asked Kane to pre-seed from it: *"If you could
  like preede everything that would be awesome."* She said the sheet is not sensitive (*"It's not
  credit cards"*) and that she would share it with Kane. **Its link is not in the transcript.**
- **Which platforms:** named on the call: QBO, FMS, Stripe, "PA" (or "PEA"), Bitrix, Wise and
  Chase. Carla left out Gmail, Hubstaff, RoboForm and CallTools: *"All that stuff I think gets
  deleted at some point. So, it's not really something I need to worry about."* "FMS" and "PA" are
  not expanded anywhere in the transcript.
- **Deadline:** Kane, early in the call: *"before 9"*; at the end: *"I'll have it done by 9."*
  Carla: *"I need to have it ready before 9:00 a.m. tomorrow for Karen."* That her "it" is this
  feature is inferred from the order of the call, not stated.
- **Measured 2026-10-09 11:44Z:** not built. `git log` has nothing after `f0eac591` (10-08), and a
  grep of `app/api/accounting-scoreboard` and `src` finds no keys or platform-tag code.
- **Documented rules a build must follow:** access to the board is its member list and roles are
  board-local grants (item 393); the grants table is append-only with a revoke stamp; and Kane's
  item 410 keeps all scoreboard data. Removing a key at offboarding should therefore be a stamp
  (who and when), not a delete. The HRIS Offboarding queue knows nothing about these platforms.
  Whether keys should appear there was not asked.
- **Kane, unresolved:** *"We got that automated"*, said while Carla described the sheet. What it
  refers to is not clear.

## Accounting Scoreboard: a task summary block, Julia as Admin, the timing log (item 425; follows 391, 393, 412, 421)

Surface: [accounting-scoreboard-tasks.md](../features/accounting-scoreboard-tasks.md).

### A block summarising tasks

> "I would love to have another block with the task on here with the summary of like how well
> they're doing on the task right here. One more block."

This is a change to a shipped surface (`hardening`). Where "here" is cannot be told from the
transcript; the Overview is the likely place. **A documented rule bounds it:** tasks are not in
`readBoard`. They have their own route, their own load line, and are never inside the board's
cached blob (memory `accounting-scoreboard-tasks`). A summary block must read the tasks route, or a
summary read of its own, and must not fold tasks into the board read. Whether it counts toward the
Team Score (item 388) is open.

### Julia is an Admin now (measured)

> "I actually made Julia admin because she wasn't able to um edit people's task, which I think I
> told you not to to not do, so don't worry about it. But I made her an admin for now and I can
> look at that later, but I don't really care."

- **Measured:** Julia's Assistant grant was revoked by Carla at 2026-10-08 19:47:07Z, and an Admin
  grant from Carla followed at 19:47:22Z. The live Admin grants are now **five**: Carla and Claire
  (the 10-08 migration), `accounting@` (granted by Carla, 12:17Z), Kane (self-granted, 13:11Z) and
  Julia.
- **This is the board working as built, not a bug.** Adding, renaming and removing tasks are
  Admin-only, by Carla's own round-4 rule. Granting Admin also gives Julia Setup, role grants, and
  the weekly lock once it ships. Whether Carla wants a narrower "edit tasks" power is a question for
  her, not an ask (*"I can look at that later"*).

### The Chat post is in use

> "They are amazed at that message that comes in that tells them about their task."
> "It was so easy. I didn't even have to ask you anything." "Julia's going to be in charge of
> that."

Measured: `accounting_scoreboard_chat_posts` holds one scheduled post, the 10-08 15:00 ET daily
slot, `posted`. Item 421's bars card (`4884086a`, `b7cfe890`) is on `origin/main`. Whether Google
renders the card is still unproven until a post sent after the deploy is read back. The first
weekly slot (Fri 09:00 ET = 13:00Z) had not come yet when this was measured.

### The Sales payments timing log, asked again (item 391 (1))

> "for on boarding I want it to be similar to collections in which like it tracks the speed. I
> shared you into that one sheet that I had." Kane: "Urgent payments." Carla: "Yeah, that one."
> Kane: "Yeah, I forgot." Carla: "It's not really urgent. Joanna just kept asking me today about
> it. She was like, I'm so excited to finally have a goal."

This is item 391 (1), the per-payment timing log that Carla described on 10-07. It is **not
built**, and the sheet's link is still not in the record. Carla calls it not urgent.

### Kane on polish

*"I haven't given much attention to this so I think it's some of part of some part of it is still
ugly."* No specific ask.

## HSL: KPI entry taken away from HSL's managers (item 426, provisional, Kane's ruling owed)

Surfaces: [hsl-kpi-calculator-2026-07.md](../features/hsl-kpi-calculator-2026-07.md) ·
[rbac-feature-permissions.md](../features/rbac-feature-permissions.md).

> "I probably am going to remove the KPI calculator from the HSL team only because HSL like they pay
> for all of the staff bonuses there and I would rather us be the ones taking the fall for any
> errors in the mistakes. I don't want like Jid to apply herself some other kind of crazy bonus and
> then we don't find it until somewhere in the audit logs that she had, you know, paid herself extra
> or that she paid anybody else extra and then we charged the customer for it and then we lose
> Hogan and then we're broke."

> "I'm kind of very tempted to just let HSL have offboarding, onboarding, new hire stuff like all
> that but not the KPI calculator. Thoughts on that?"
> "they would have that but they wouldn't have KPI calculator. They would be able to see the
> history and like all of that but they wouldn't be able to like actually put in numbers."

**Not decided.** Kane asked whether HSL has HR access, and the call moved on. Carla then: *"I think
honestly all the HSL stuff should be V2. Like we just showed Jid the basics of like transferring and
offboarding and that's it."*

What is true today (measured and read):

- **19 people hold a live `edit` grant on `manager` → `hsl_bonus`** (the HSL KPI Calculator),
  Jid's among them, plus Carla, Claire, Aliviah, Jackie, Thomas and others.
- Every HSL KPI write checks `edit` on the server: `hsl-bonus/entries` POST and DELETE,
  `hsl-bonus/period` DELETE, `hsl-bonus/period-status` POST, `bonus-catalog-applied` POST, and the
  QC review and compare-paste writes. A `view` grant opens the tab read-only through `ReadOnlyTab`
  (`rbac-feature-permissions.md`).
- **So "see the history, no numbers" may be an access change, not code**: move the grant from
  `edit` to `view` for the HSL managers. That is not exercised. The same key also gates the QC
  review and compare-paste writes, so check who else relies on it before changing anyone's grant.
- `GET /api/hsl-bonus/entries` has no auth check at all (already on record as `SECURITY_AUDIT.md`
  #37 and item 251). History reads work under `view` for that reason too.
- **Who enters HSL's KPIs instead** was not said. If Accounting does, that is new weekly work for
  Carla's team.

Carla also floated reading HSL's own scoreboards instead (*"what if we could connect their
scoreboards?"*). Kane: *"as long as they're in a proper column"*. Carla: *"They're ugly … they'll
put like this is for Jerry. Who is Jerry?"* Not an ask.

## V1 and V2: what was deferred (item 427)

> Kane: "pretty much the MVP is done." "whatever we're doing right now it gets mushed into one
> that's going to be the project SP and that's V1 the V2 will be after." "So I think the scheduling
> for HSL will fall into V2 I think." Carla: "Okay. Got it. Yeah. Because I don't think we're ready
> for for that whole thing."
> Kane: "I think part of [V2] is all manager view should have their own unique view for each
> department just going to be very unique."

Deferred to V2 on the call:

1. **HSL scheduling** (Kane). Today's state: HSL → Scheduling saves to `employee_schedule_periods`,
   which held 0 rows at the last probe (memory `hsl-scheduling-in-department`).
2. **A unique manager view per department** (Kane).
3. **Most of HSL** beyond transfers and offboarding (Carla).
4. **Onboarding Claire's PH contractors into the HRIS** (Carla: *"I have been begging Claire to
   start onboarding her contractors on here … She will not … It's like maybe what 20 or 30 invoices
   a week. It's a copy paste job … It could be a V2 thing"*).
5. **Schedules for every team, with exceptions** (Carla): *"that scheduling thing that you did for
   Jid should be applicable to all teams … they can set their normal schedule and then this person
   though works this days instead. And that would help us with the PAB stuff because we had several
   people say, 'Oh, I work Wednesday to Sunday on the edit team.'"* **Money when built:** judging
   PAB against a person's schedule changes who qualifies. That is Kane's ruling before any build.

Kane said he told Cobb the HRIS would be packaged *"within the month"*. Item 340 holds the project
SP (3,289 total, 2,999 completed, re-measured 10-08).

## COP: one payee's rate, a peso equivalent, and a $2 gap (item 428, OPEN MONEY; follows 373, 407)

Surface: [cop-country-payees.md](../features/cop-country-payees.md).

They looked up a COP-paid client VA in Payment Dispatch.

> Kane: "the COP is 22,000 P cop dollars per hour. Is that right?" Carla: "It's like 22. Hold on.
> Yeah. 22,200 COP per hour." Kane: "But look, it's not anymore half a million or a million."
> Carla: "But you see it still has her like PHP equivalent up here." Kane: "Yeah. Yeah. Yeah. I'll
> I'll change that [COP] value." Carla: "Another thing is that her rate, right? You're going to
> change that too." Kane: "Yeah."
> Carla: "it's not off by much. is off by like $2. We paid her $2 more on our payroll dashboard, $2
> less on HR. So, I think it would just be like conversions."

- **Measured:** her employee Pay Structure reads **currency COP**, at the same hourly figure Carla
  read from her sheet, last written by item 373's `--apply` on 2026-10-07 13:56Z. Her
  `employee_rate_history` rows still hold that figure in the peso-denominated column (newest
  effective 09-07). That is item 373's known leftover: *"screens that read only the history (they
  still show [the COP figure] as ₱)"*. Which screen showed the peso equivalent was not identified.
- **Not clear:** what Kane will change. The stored structure already equals Carla's rate.
- **Not measured:** the $2 gap between NPD and the HRIS for her week, and Carla's guess that it is
  conversion.
- **Still standing from item 373:** confirm which system pays a COP payee for a week before anyone
  marks the HRIS row paid. Carla's "we paid her $2 more on our payroll dashboard" reads as NPD,
  which is how these payees have been paid since August.

## Payout change safety: Carla accepts the guardrail (item 401)

> Kane: "you said user error, so I've added a guardrail for that. Don't put your spouse's credit
> card in here." Carla: "I like that guard rail. I'm cool with it." "We're confirming with that
> person to make sure that that account is supposed to be where we're sending to stuff to."

Earlier, on a bank record in someone else's name: *"if I clicked on this guy's name, it wouldn't
match whatever he has right here, right? … And then we would just have to go stop cycle and update
it."* Kane: *"if they intentionally did it, you see in the people."* This matches item 401 as built:
a card-shaped number and a holder who is not the employee are **confirmed, never blocked**, and
Accounting sees the flags. Carla's acceptance is recorded on item 401. Which screen she was reading
was not identified.

## Time adjustments: a manager email, considered and dropped (item 390)

> "I feel like we need a notification system. Like me as a manager, I don't know about any of these
> until I actually catch myself looking at it." "But the only thing about that is I would get time
> adjustments for everybody because I'm a manager for everybody."

She then floated Accounting logging requests directly instead of employees filing in Hubstaff, and
withdrew both: *"I'll leave it alone. I don't think we need to change it."* **No ask.** On the
second approver: *"I think I had two where I couldn't see the second approver on it … Yeah, it's
fixed now."* That is item 390's bug (alias-filed requests showed an empty approver list). Its code
is on `origin/main` (0 commits ahead, measured). **Item 390's OPEN MONEY half is unchanged**: an
approved alias-filed request still does not reach pay.

## Status Carla read out (checked where cheap)

- **Attorneys (item 374):** *"I think you did fix the attorneys now. They're good, right?"*
  **Measured true in the data:** nine weekly salary structures at ₱23,080, all updated by Aliviah
  through the Payment Catalog on 2026-10-07 between 14:47Z and 14:50Z, including the one attorney
  whose hourly rate was higher. Kane's "go", which item 374 waited on, is not on record. The
  salaried build's own open NEEDS still apply (a partial week is held, and a salaried person
  missing from the week's Hubstaff export is not paid).
- **Interns:** *"the interns have been fixed"*. Item 417, applied 10-08.
- **Orphanage hours:** *"we're going to test out the orphanage hours"*. The OMS side-by-side, item
  334. No change.
- **New payroll dashboard (NPD):** named as done. No change.
- **Employee view:** *"I think the employee view though is perfect. It's ready to go. I have no
  complaints about it."*
- **Jackie's side:** *"Jackie's fine."*
- **Gift tracker:** waiting on Ellie, who *"now has to connect with the vendor before she could
  place the order."* Carla wants the orders cleaned up first.
- **Help:** Kane pointed at the help ticket and Penny for questions.

## Managers, Cobb and Monday

- **Manager training:** *"I need to connect with all these freaking managers … I need to do that
  starting next week."* Carla set her own deadline: *"I'm going to put a deadline on this by the 16th
  of next week."* Kane: *"tell Thomas to put the KPIs himself."*
- **Monday:** Carla asked Kane to make sure Cobb puts the scoreboard on his Monday board so the work
  is paid. **Measured:** the scoreboard is already on the HRIS board, with 24 mentions in
  `src/lib/monday/hris-plan.ts` (round 3, the problems log, the cache, the loading modal, Shown in,
  and others), written through the `monday-board-sync` skill.
- **The gamified Monday (Cobb's build):** a pixel office where each teammate's avatar works their
  Monday tasks and earns SP for hats. Not an HRIS surface.

## Not HRIS, recorded for context

- **The payment cycle close:** Carla will close the cycle in Payment Dispatch on 10-09, aiming for
  before 11:30. Several new hires sent wrong accounts, and her team has asked them for new ones.
- **A missed team bonus:** *"[Jid] forgot to send us this big ass bonus for an entire team. So,
  that's going to mess up and give us a bunch of scoreboard errors."* How and when it is paid was
  not discussed, and nothing was asked of the HRIS.
- **Kane:** *"just make sure to log all problems from this week because I'm so confused what we did
  wrong."*

## Decisions made on the call

These are asks accepted, not designs ruled. Nothing is built.

1. **The new feature is called Keys and is Admin-only** (Carla: *"We can call them keys"*, *"It's
   not for the team"*; Kane: *"whatever admin is in there"*).
2. **The payout guardrail stays as built**, confirm and not block (Carla: *"I like that guard rail.
   I'm cool with it."*).
3. **Time adjustments are unchanged**, no manager email (Carla: *"I'll leave it alone"*).
4. **V2, not V1:** HSL scheduling and a unique manager view per department (Kane); most of HSL,
   and Claire's contractors (Carla).
5. **Manager training by 10-16** (Carla, for herself).

## Open questions

1. **Keys:** the full platform list, and what "FMS" and "PA" are. The link to Carla's sheet. What
   "action" means at offboarding (a checklist the Admin ticks, stamped with who and when?). Does an
   Assistant see keys? Should keys show in the HRIS Offboarding queue?
2. Was the 9 AM deadline for Keys?
3. **HSL KPI entry** (Kane): view-only for HSL's managers or not; all HSL managers or one; and who
   enters HSL's numbers instead.
4. **The task summary block:** where it sits, and does it count toward the Team Score?
5. **Julia:** is Admin what Carla wants, or only the power to edit tasks?
6. **COP:** what Kane changes when the stored rate already matches; where the $2 comes from; which
   system pays her this week.
7. **Schedules for every team (V2):** would PAB be judged against a person's schedule?
8. What Kane meant by *"We got that automated"*.

## Action items

| # | Owner | Action | Status |
|---|---|---|---|
| 1 | Kane | Build Keys on the scoreboard (`blueprint`) | **NOT built** at 07:44 EDT 10-09; promised "by 9" (424) |
| 2 | Carla | Share the platform-access sheet so Keys can be pre-seeded | Promised on the call; link not in the transcript |
| 3 | Kane | Rule on HSL KPI entry (view-only for HSL's managers) | Open (426) |
| 4 | Kane | The COP payee: the peso equivalent, her rate, and the $2 gap | OPEN MONEY (428) |
| 5 | Kane | The task summary block (`hardening`) | Not started (425) |
| 6 | Kane | The Sales payments timing log; Joana is waiting | Not built (391 (1)) |
| 7 | Carla | Train the managers on the HRIS | Deadline 2026-10-16 |
| 8 | Carla | Tell Thomas to enter his team's KPIs himself | Asked by Kane |
| 9 | Carla | Close the payment cycle in Payment Dispatch | Planned for 10-09, before 11:30 |
| 10 | Carla's team | Log every payroll problem from this week | Asked by Kane |
| 11 | Ellie | Connect with the gift vendor and place the order | Waiting (Ellie) |

## Reference notes

- **Transcript garbles, corrected in the body:** "HIS" / "HR" (on screen) = the HRIS; "cleric" =
  Claire; "Aninssley" = Ainsley; "Alyssa" = Alissa; "cooper value" and "C O P" = COP; "22,000 P cop
  dollars" = 22,200 COP; "B2" = V2; "Benny" = Penny; "Joanna" = Joana; "preede" = pre-seed. "Jid" /
  "JID" is HSL's office manager (see the [2026-04-29 note](./meeting-with-carla-2026-04-29.md));
  her grant was identified from the 19 `hsl_bonus` edit grants by name, which is an inference.
- **Unresolved:** the "Jade" who *"forgot to send us this big ass bonus"* is read as Jid (the next
  sentence says *"all of them would be JID errors"*), which is inferred. The "Jade … doing the
  charge back" in the Monday demo is someone else. "FMS", "PA" / "PEA", "the P the PAL lab has to
  reflect their native hours. Right now it's in page P" (possibly the pay slip in PHP), "Karen"
  (who Carla needs Keys ready for), "Ellie", "Cobb" / "Cob" / "Cubs", "Christian Adrian", "Jeff" and
  the example teammate named for offboarding.
- **Kept out on purpose:** the COP payee's rate and pay figures (they are in item 373 and memory),
  and personal remarks about employees made on the call.
- **Not checked:** which screen showed the COP peso equivalent; the NPD vs HRIS $2 gap; whether the
  bars card renders in Google Chat; who else relies on `hsl_bonus` edit besides the KPI Calculator
  (QC uses it); and whether any keys work exists outside this checkout.
- **Related:** [2026-10-07 Carla and Alivia](./2026-10-07-carla-alivia-scoreboard-tasks-roles-and-interns.md)
  · [accounting-scoreboard.md](../features/accounting-scoreboard.md) ·
  [accounting-scoreboard-tasks.md](../features/accounting-scoreboard-tasks.md) ·
  [cop-country-payees.md](../features/cop-country-payees.md) ·
  [salaried-pay-basis.md](../features/salaried-pay-basis.md) ·
  [update-bank-info.md](../features/update-bank-info.md) ·
  [manager-scheduling.md](../features/manager-scheduling.md) ·
  [time-adjustment-requests.md](../features/time-adjustment-requests.md) · Open items 251, 334, 340,
  373, 374, 388, 390, 391, 393, 401, 407, 410, 412, 417, 421.
