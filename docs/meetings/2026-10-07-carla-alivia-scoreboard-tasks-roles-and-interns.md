# 2026-10-07: Carla, Alivia and Kane: Accounting Scoreboard round 4 (tasks, roles, lock-in), plus NCNS, interns and Arriola

Google Meet call, **Wednesday 2026-10-07, 12:50 EDT, about 44 minutes**. Kane R, Carla T, Alivia H.
Source: the meeting's auto-generated transcript, pasted by Kane the same day (it is computer
generated and garbles names; see Reference notes). Most of the call was Carla walking the
Accounting Scoreboard tab by tab with change requests. Then she described the per-person task
boards she wants moved onto it, and four HR and payroll threads came up. **Nothing was built in
this session.** This note records the asks and routes them as Open items **391–397** in the
[Sep 29 log](../audits/audit-2026-09-29-session-log.md). It is the first note filed with the
`meeting-notes` skill.

## Summary

**The scoreboard is in daily use and Carla wants the rest of her sheet on it.** She asked for
five changes to shipped sections (item 391): Sales Onboarding becomes a per-payment **timing
log**, Setup → Sections gets a **hide from Overview** switch, the No Meeting Streak is made
prettier, Monday's untyped Payroll Problems become editable, and the heart icons should match.
She then asked for three new features (item 393): **per-person task boards** replacing her
sheet's person tabs, with a Google Chat progress message, **board-local roles** (Team member /
Assistant / Admin), and an **Admin-only weekly lock-in** with an Admin-only reopen. Compliance
should fill itself from Kentshin's compliance report instead of being typed in by hand
(item 394).

**Two asks contradict documented rules, and neither is picked here.** (1) Carla said Pre-arb
*"is still considered a loss"*, but item 387's CHOSEN win ratio leaves Pre-arb out (item 392).
(2) Making Monday's old-grid Payroll Problems editable collides with item 379's rule that *"the
grid takes no writes"* (item 391).

**Teal's NCNS question (item 343) got its real reason.** HR wants to look a candidate up while
interviewing. Kane said the job portal already receives the offboarded list (item 389) and blocks
reapplying. **The code is on `origin/main`. That Rainer's key actually reads it is NOT verified**
(item 395).

**Interns are an open money question waiting on Ralph** (item 396): hours over 5 were not paid,
the program has moved to a monthly payout, and the call could not settle whether the past weeks
were over- or under-paid. **Jackie wants a notification when a queue row is returned to her**,
raised by the Mark Arriola cleanup (item 397, follows 384).

## Accounting Scoreboard: changes to shipped sections (item 391)

Surface: [accounting-scoreboard.md](../features/accounting-scoreboard.md). Every part of this
item is a `hardening` change to a shipped surface.

### Sales Onboarding becomes a payment-timing log

> "this just tracks what they ran. Okay, the sales reps are the ones that sold these deals, but
> that it doesn't account for like scheduled is the ones that are on our calendar to run. So, we
> can run them whenever we want to on that specific day. Urgent is when the sales reps actually
> has like a fish on the hook and we're trying to run a payment right now. And so, these are all
> about timing."

She wants it **set up like Collections, a log the team fills in**, with these columns (she said
she would send them in chat): **Date · Sales rep · Amount · Time the sales message came in ·
Billing rep (who ran the payment) · Time start (accounting) · Time end (accounting) · Total
duration · Result.** The measure is the **average duration per payment, per week**:

> "As long as payments stay with under three minutes average a week per payment, that's good.
> That's like amazing. And if we're like at one or two minutes, that's even more amazing. […]
> Three is like bottom. Two is like wow. One is perfect."

Sales reps will never have access: *"don't ask me to cuz I'm not going to train 50-year-old dudes
how to use my scoreboard."* Joana keeps the sales spreadsheet today and *"can just log them in
here. […] Or you can connect this to here."* During the call Carla shared that sheet with the
HRIS Google service account at Kane's request (*"put the global master list service account on
the sheet"*). **The sheet's link is not in the transcript.**

Today (item 385) the built-in `onboarding` section is titled "Sales — Payments" and counts
Scheduled and Urgent rows. Its weeks before 10-01 are the sheet's per-closer counts. Open: see
questions 5 and 10.

### Hide a section from the Overview

On "Sales Projects Onboarded": *"I don't want this on here because this is kind of just again
telling me how many products we added, but it doesn't really do anything for my team. […]
Joanna thinks she we need it. And I'm like whatever. I'm not arguing with her. Um but I want to
take it off of here."* Later, on a second section: *"I don't want this one on the overview, but I
don't have a hide option."* Kane: *"setup will have an option to hide it from the overview."*
Carla: *"Under sections."*

Documented: a hosted custom section **keeps its Overview card** (item 385), and the Team Score
(item 388) is built from those cards per tab. That is described behaviour, not a rule against
hiding, but the build must decide whether a hidden card still counts toward the Team Score
(question 4). The second section is not identifiable from the transcript (question 6).

### PM Buckets: the No Meeting Streak, prettier

> "Can you make this prettier? Just like we want it to be like, yes, five days, no meeting. Keep
> it going, guys. Like, and then right now it's like no meeting streak. Five days."

Kane's note on the call: *"PM buckets and pills […] date pills."* This is display only. The streak
is already computed (item 379).

### Payroll Problems: Monday's untyped entries cannot be edited

> "we had added like the types after Monday and so the Monday ones have no type and I don't have
> a way of pulling those again. […] I don't have an option to edit or delete the Monday problems
> because they're not under the log. And I don't know how to like clear out Monday"

**Contradiction, not picked.** Item 379 and the surface's memory say: *"Payroll Problems is an
append-only LOG […] The 22 old grid counts still count as 'No type' and the grid takes no
writes."* Carla's ask needs either a write to the old grid or a one-off removal of those counts so
they can be re-logged with a type. Kane's options: (a) a one-off Node script with `--apply` that
backs up and removes that week's grid counts, after which the team re-logs them typed; (b) open
the grid to Admin edits; (c) leave them as "No type". It is **inferred, not measured**, that
Monday 10-05's entries are old-grid rows: the round-3 migration was applied 10-06.

### Smaller

- **A score that would not save now saves.** *"I kept putting eight and it wouldn't save, but
  it's good. It's 10 out of 10 works now."* The section is not named. No action.
- **Heart icons.** *"I just wish these hearts were the same as these hearts and these hearts were
  the same as all hearts. Now it stresses me out that the hearts aren't matching."* This is
  cosmetic, and which elements she meant is not clear from the transcript.
- **Unchanged:** Payroll Timing (*"This is perfect"*), Inbox (*"fine"*), and Chargebacks apart
  from item 392.

## Accounting Scoreboard: Chargebacks negatives and Pre-arb (item 392)

> Carla: "a loss is a negative, but I can't put a dash right here to put that. I want to show
> like it's actually we're in the hole."
> Kane: "Wins positive. PR losses have negative." Carla: "Yes."
> Carla: "if we win, they give it back. If we lose, we lose that and $25 on top of that."
> Carla: "We consider prearb as a loss, but prearb just means that the bank can't decide who's
> going to win or lose this and they're going to keep investigating. So, it's technically we
> haven't gotten our money back, so it's still considered a loss."

This answers the round-2 question that stopped the build (item 317 (a): pre-arbitrations
negative, but the readings gave different totals). **Wins are positive; Pre-arb and Losses are
negative.**

**Contradiction, not picked.** Item 387's CHOSEN rule is: *"Win ratio = Σ count of
`outcome='win'` lines ÷ Σ(win + loss), by COUNT, Pre-arb left out."* Carla's *"still considered a
loss"* would put Pre-arb in the denominator. These are different ratios on the live board. Also
open: is the $25 fee added per loss automatically, or typed into the amount (question 2)?

## Accounting Scoreboard: task boards, roles and weekly lock-in (item 393)

All three are new (`blueprint`). The memory records *"Not built: status strip, task checklists,
and per-person bonuses."*

### Per-person task boards

> "every person has a task board and it has a collage of different things. They're either daily
> task, weekly task, bi-weekly, monthly, bimonthly, quarterly, annually. And then there's tasks
> that just come up on our desk and we do them as they are needed. Before we end the day, we want
> to make sure that our as needed is looked at […] all of these daily need to be done daily. And
> then these need to be checked at least once a week."

> "I just want to replace that where everybody's task board is on our scoreboard, but somehow get
> it to where like we have this as a drop down or like a switch that says scoreboard task"

- **Per person, by Google sign-in.** Each person sees their own board. Carla *"would have a view
  of everybody's taskboard and I should be able to add task, remove task and create all that
  stuff and then have a place where just tell me like a summary."*
- **The reminder.** Today someone posts the progress in the team chat by hand: *"Current
  progress, 98 out of 170 daily tasks and 13 of 80 weekly tasks have been completed."* She wants
  *"some kind of like message or email, whatever that says, 'Hey, you still got task left to
  do.'"* Kane: Google Chat. During the call he opened the team space's Apps & integrations → Add
  webhook, and said *"I'll deal with this later"*, then noted *"Connect accounting scoreboard to
  accounting group chat."* Carla is fine either way: *"Or it could be a copy paste note that this
  thing generates for me and I paste it in there."*
- **Source:** the person tabs of the same scoreboard sheet (`1JqLyLtO…`, memory
  `carla-accounting-scoreboard-sheet`: *"Person tabs = task checklists; Carla's Tracker counts
  checked vs total"*). **The Florida tabs differ.** They have an extra column, with Monday in a
  different place: *"Florida is the only people that have this setup."* An import must read both
  layouts.
- NEEDS: the Google Chat webhook URL (a secret that Kane or Carla holds) and which space it
  posts to.

### Board-local roles in Setup

> Carla: "I would love for this not to be available to anybody except Claire. I don't want
> anybody to change anything."

- **Team member:** edits everything except Setup (*"I would be okay with all of this being
  editable under a team member"*).
- **Assistant:** sees Setup but cannot change it, and *"would also be able to view the task list
  of everybody else."*
- **Admin:** full write.
- Kane offered the HSL admin dashboard's edit / view / hidden matrix. Carla: *"Nah."*

Documented today: access is the board's member list, and **managers are the HRIS `accounting` /
`admin` roles** (item 315). Board-local roles change who counts as a manager. They do not
contradict the rule that access is never an HRIS role. The build must say what happens to the 11
people who hold `accounting`. NEEDS: who holds Admin besides Carla (question 7). She wants a
second one: *"in case I get kicked off the team and at least the admin can do all this."*

### Weekly lock-in, Admin only

> Carla: "The only thing I want is to be able to lock the numbers in. I don't need anybody being
> able to go to the previous week and changing anything. If I've locked it in, it's you can't
> change it anymore, but I can still change all this stuff."
> Kane: "Lock in weekly results. Only Carla, our admin. Reopen."
> Carla: "reopen and it would have to be only admin only."

Open: does a locked week also refuse a Collections soft delete and a Payment Verified stamp
(question 8)?

## Accounting Scoreboard: Compliance from Kentshin's compliance report (item 394)

Carla showed Kentshin's compliance tool listing **eight** violations on the 5th. Her board needs
**first, second, and three-or-more violations, and how many became offboardings.** Kentshin's
tool has no first-violation field, so today Kristine looks each person up in the compliance
report's history and logs the result on the scoreboard by hand.

> "if I could just get both scoreboards to talk to each other, then I don't have to have
> Christine do anything. It would just automatically do it itself. But I talked to Kenchin and I
> don't think Kenchin has seen my scoreboard"

Kane: *"I'll see what I can do with Kentshin […] with compliance integration in there."* This is
new (`blueprint`) and **blocked on an outside party**: what Kentshin's system exposes (rows per
violation with the person and the offense number, or only daily counts). Related: a different
ask against the same portal, PAB disqualifications (item 312), is also unbuilt. Whether the portal
has an API was not checked this session.

## HR: Teal's orientation NCNS on the Offboarding list (item 395; follows 343 and 389)

> Alivia: "Teal got back to me. She was just wondering about […] so they get offboarded but they
> don't get put onto the offboarding list"
> Carla: "the people that […] do not come to orientation and Jackie marks them as not attended
> that they get posted under offboarding here so that when they are interviewing people they can
> search here to see if that person has ever been here and including the people that had like
> attended orientation for like five minutes or didn't come at [all]"
> Kane: "can you go to admin web hooks and integration […] So it's it has the offboarded people
> being fed already in there. […] it's already connected to the job portal where they can't
> reapply if if they're offboarded." […] "Unless Rainer is not done with us yet."
> Carla: "Oh, so this is done. We don't have to worry about it." Kane: "Yeah."

- **Measured:** item 389's commit `4cf42388` (the `offboarded.read` scope) is on `origin/main`:
  `git rev-list --count origin/main..main` = 0 on 2026-10-07, and that commit is in
  `git log origin/main`. Whether it is deployed cannot be measured from here.
- **NOT verified:** that Rainer's job-portal key holds `offboarded.read` and has called it. The
  read-only production probe (key scopes, and requests on the offboarded path since 10-06) was
  refused by this session's permission check, and was not retried another way. *"It's already
  connected"* stands as Kane's word until that probe runs.
- **Still true (item 343):** inside the HRIS all 62 NCNS are on the ledger. A hire who attends
  orientation and then stops coming is **not** written by *Did not attend*. Carla's *"attended
  orientation for like five minutes"* case is covered only if Jackie marks them not attended.
- Carla asked Alivia to close the loop with Teal.

## Offboarding queue: returned to manager without a notification (item 397; follows 384)

> Carla: "He was offboard in like June or something and in the HR he was just sitting there but
> he didn't have any credentials and so like when I sent him to offboard he couldn't be
> offboarded so Jake I had to add in his information and then he returned it to manager. Jackie
> didn't get a notification on that and that's she wants one set up. I thought like you would get
> a notification under your manager that somebody's been sent back but I don't."

This is the Arriola ghost row from item 384: the row was edited through People on 10-06 and the
queue row returned the same afternoon. Carla: *"His credentials aren't even active."* Item 384's
state is unchanged. The ghost is still not off-boarded, the stamp script refuses after the edit,
and **Kane's ruling (revert the three fields and stamp, or let the queue offboard it) is still
owed.** The new ask: **notify the manager when a queue row is returned to them.** Whether any
such notification exists was not checked (a code read was refused this session). That decides
whether this is `hardening` or `blueprint`.

## Orphanage interns: hours over 5, monthly payout, what was paid (item 396, OPEN MONEY)

Surface: [orphanage-interns.md](../features/orphanage-interns.md). **Waiting on Ralph.** Alivia:
he *"needs to communicate his query first and he will get back to my email shortly."*

- **Hours over 5.** Carla: *"Hub staff showed like 5 something, 6 point something. And then you go
  back and look at the HR and it literally maxes them out at 5 hours."* *"The people that worked
  under were paid exactly how they should have been, but I don't know about the people that
  worked more."* Alivia: *"Basically everybody"* worked over.
- **The popup reads as a lump sum.** Alivia read the Review & lock-in popup's *"to the interns"*
  figure (4,164) as all weeks, but it is **one week's total for all interns**: *"It doesn't
  specify like […] this intern receives a little bit less than that or it just says like to the
  interns that straight number."* That is a display ask (`hardening`).
- **Paid or not.** Allison told Carla the interns had not been paid; Carla says they had.
- **Over or under.** The call says both: *"we owe people a little bit of money on this"*, then
  *"So we did overpay them"*, then *"they have been overpaid and that's fine. We'll just adjust
  it."* Some of it *"could be considered PAB"* (the ₱1,000, *"the 1K"*). Recorded as said;
  **not computed**.
- **Monthly payout.** *"they have switched to a monthly payout. So it's not per week anymore."*
  The intern system is weekly by design.

Documented: intern pay is a daily cap, then a weekly cap (`intern-week-pay.ts`); PAB is ₱1,000
when every Sun–Sat week has at least 5 paid hours (Ralph). The configured cap values were not
checked this session. **OPEN MONEY, owner Kane, rule from Ralph:** are hours over 5 payable, what
is owed or recovered for the weeks already paid, and what does a monthly payout change?

## Orphanage Management System: a side-by-side test next week (item 334)

Kane: *"we're not going to use it […] probably for testing, but let's see if it matches from the
manual pasting versus the automatic."* Carla: the test has to happen early, and *"Allison turns
in her hours early so that we have real numbers to play with."* State (item 334, memory
`orphanage-oms-pull`, 10-07): `.env.local` now points at OMS's `pymcf` project, which holds **0
rows in every table**, and Vercel is not updated. A side-by-side test needs OMS's live project to
hold the week's hours, and the Vercel env swap.

## Not HRIS, recorded for context

- **Customer billing terms.** The "order confirmation" sent when a customer buys a website was
  changed by someone. Carla does not know who. A customer who was charged only a $1 authorization
  is told he has paid in full. Kane: *"I don't know."* This is not an HRIS surface.
- **PAB around a month boundary.** An employee asked whether a week split across two months
  counts. Carla's rule as she stated it: *"we base it on payroll week, five days each week, unless
  it's a companywide day off."* No change was asked for.
- **Wise funding was late.** Carla held Wise payees rather than paying them early (*"Everybody's
  going to want to switch"*), and an alternative provider is being looked for. No HRIS action.
- **A bank account in someone else's name.** An employee's pay went to a relative's account and
  she cannot reach it. Carla floated a signed acknowledgment for mismatched account names. Alivia
  said they already confirm by email. Carla: *"I think emails exchange is just fine."* No change.

## Decisions made on the call

These are asks accepted, not designs ruled. Nothing is built.

1. **Setup → Sections gets a hide-from-Overview option** (Kane: *"setup will have an option to
   hide it from the overview"*; Carla: *"Under sections"*).
2. **Chargebacks:** wins positive, Pre-arb and Losses negative (Carla, Kane repeating it back).
3. **Roles:** three (Team member, Assistant, Admin), not an edit / view / hidden matrix (Carla).
4. **Lock-in and reopen are Admin only** (Carla).
5. **Sales reps never get board access** (Carla).
6. **Mismatched bank-account names:** keep the email confirmation, no signed form (Carla).
7. **OMS is test only next week**, compared against the manual paste (Kane).

## Open questions

1. **Pre-arb in the win ratio** (item 392): Carla's *"still considered a loss"* vs item 387's
   CHOSEN *"Pre-arb left out"*. Contradiction.
2. Is the $25 chargeback fee added per loss automatically, or typed into the amount?
3. **Monday's old-grid Payroll Problems** (item 391): an edit vs *"the grid takes no writes"*.
   Contradiction.
4. Does a card hidden from the Overview still count toward the Team Score?
5. Sales timing log: is duration end − accounting start only, or is the wait from the sales
   message tracked too? Do Scheduled / Urgent survive as a column? Does the log replace the
   "Sales — Payments" counts and their pre-10-01 history, or sit beside them?
6. Which second section does Carla want hidden from the Overview?
7. Who holds Admin besides Carla ("Claire" in the transcript, see Reference notes)?
8. Does a locked week also refuse a Collections soft delete and a Payment Verified stamp?
9. Google Chat: which space, and the webhook URL.
10. The link to Joana's sales sheet, and confirmation that this is the sheet she shared on the
    call.
11. What Kentshin's compliance system can expose.
12. Interns: hours over 5, the monthly payout, and the past weeks (Ralph, then Kane).
13. Does Rainer's job-portal key hold `offboarded.read`, and is it calling it?

## Action items

| # | Owner | Action | Status |
|---|---|---|---|
| 1 | Carla | Send Kane the edits and the sales-timing columns (*"I'll loop back Kane with these edits"*) | Promised on the call |
| 2 | Kane | Rule on Pre-arb in the win ratio, and on Monday's old-grid Payroll Problems | Open (392, 391) |
| 3 | Kane | Start the scoreboard work: `hardening` for 391 / 392, `blueprint` for 393 | Not started |
| 4 | Kane / Carla | Google Chat webhook URL and the target space | Waiting |
| 5 | Kane | Ask Kentshin what the compliance system can expose | Waiting (Kentshin) |
| 6 | Alivia | Tell Teal that NCNS are on the HRIS Offboarded list and that the job portal reads it | Open |
| 7 | Kane | Run the read-only probe: Rainer's key scopes and its calls on the offboarded route | NOT verified |
| 8 | Alivia | Total the intern weeks already paid | In progress |
| 9 | Ralph | Rule on hours over 5, confirm the monthly payout and the PAB amount | Waiting (Ralph) |
| 10 | Kane | Rule on the intern adjustment | OPEN MONEY (396) |
| 11 | Allison | Turn in orphanage hours early next week for the OMS side-by-side | Asked by Carla |
| 12 | Kane | Rule on item 384 (Arriola ghost row), and decide the return-to-manager notification | Open (384, 397) |

## Reference notes

- **Transcript garbles, corrected in the body:** Kenchin / Kension / Kenshin = Kentshin;
  Olivia = Alivia; Areola = Arriola; "HR" / "HRS" on screen = the HRIS; Christine = Kristine;
  Joanna = Joana; "prearm" / "pre-arpetration" = pre-arbitration (Pre-arb); "the global master
  list service account" = the HRIS Google service account (already shared on the scoreboard sheet,
  per memory `carla-accounting-scoreboard-sheet`); "HS" = HSL; "PR losses" = Pre-arb and losses.
- **Unresolved:** "Claire" in *"anybody except Claire"* may be Claire on Carla's US team or a
  garble of "Carla". "Atris", "Carlo", "Grace" (Kane: *"Okay, Grace."*) and "Cobb" (asked about the
  billing terms) are unresolved. "Allison" is the person who turns in orphanage hours; the spelling
  is unconfirmed.
- **Not checked this session:** the scoreboard's code (a code grep was refused by the session's
  permission check and was not retried another way), the production probe in item 395, the
  intern cap values, and whether a return-to-manager notification exists. Every claim above that
  rests on those is marked.
- **Related:** [2026-09-14 Carla QC start](./2026-09-14-carla-qc-start-and-offboarded-scoring.md)
  (Alivia, scoring) · [accounting-scoreboard.md](../features/accounting-scoreboard.md) ·
  [external-api-offboarded.md](../features/external-api-offboarded.md) ·
  [orphanage-interns.md](../features/orphanage-interns.md) ·
  [orphanage-oms-pull.md](../features/orphanage-oms-pull.md) · Open items 315, 317, 334, 343,
  379, 384, 385, 387, 388, 389.
