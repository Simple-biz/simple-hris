# 2026-10-09: call notes (participants not given): an ex-employee received a current holder's paystub (item 432)

Kane pasted a four-bullet call summary into session `fa7e8cda` on 2026-10-09. It carries no date,
no participants and no duration, so it is filed under the day it arrived. The source is a relayed
summary (bold topic labels, likely auto-generated), not a transcript: the quotes below are the
summary's words, not anyone's speech. Filed with the `meeting-notes` skill; nothing was built.
The call does not change the defect in item 432. It adds four follow-ups (an inbox review, a
security check, confirming delivery to the current holders, a mistaken off-boarding), measured
below where the repo or a read-only probe could reach them, and recorded as items 433 to 435.

## Summary

- **An off-boarded person wrote in** about receiving a paystub long after leaving. That is item
  432: 14 recycled work emails mail the current holder's paystub to the previous holder's
  personal inbox, 45 statements since 08-30. **Measured:** none of the 14 previous holders left
  "over a year prior". The earliest `off_boarded_at` is 2025-12-22. Which person wrote is not in
  the notes.
- **Measured: the 14 current holders have received 0 of those 45 statements.** Re-sending them
  waits on two picks from Kane: scope and the Reissued label (item 433).
- **Login security and password resets:** HRIS sign-in is Google Workspace only, so the reset is
  a Workspace admin job outside the repo. NOT verified (item 434).
- **"Mistakenly off-boarded":** a worker shares a work email with someone off-boarded by mistake.
  The address is not named; unresolved (item 435).
- **Fix status:** an uncommitted build sits in the working tree (another session, 10:51 to 10:57).
  It is not committed or deployed, and every rate row on the 14 addresses still carries the old
  holder's address, so the next lock repeats the misdelivery.

## Paystubs: an off-boarded person received a current holder's paystub (item 432)

- **Said:** *"An off-boarded employee reached out via email to report receiving a pay stub even
  though they left the company over a year prior."* And: *"Although the HRIS correctly displays
  the personal email for the active employee, pay stubs were improperly routed."*
- **True (measured 2026-10-09, read-only):**
  - The second sentence matches item 432. The master row holds the current holder's personal
    email. The `employee_hourly_rates` rows keyed by the same work email still hold the previous
    holder's, and `resolvePersonalEmail` reads the rate row first (`paystub-dispatch.md:454`).
  - Previous holders' `off_boarded_at` on the 14 addresses runs 2025-12-22 (`dennisc@`) to
    2026-08-10 (`markp@`). `krisd@`'s left 2026-01-12, about nine months ago. So "over a year"
    matches none of the 14. Either the summary rounded, the person's last day predates their
    `offboarded_sheet` row, or they sit outside the 432 sweep (which covers queue rows since
    08-30 only). NOT resolved.
  - What a misdelivered statement shows: the current holder's name, department, hours, rates and
    week's pay. A grep of `src/lib/payroll/paystub-view.ts` found no bank or account fields. The
    n8n email template was not read.
- **Needs:** Kane's (a)/(b) pick on item 432 (data re-point, or data plus the master row winning).
  The working tree holds an uncommitted build whose header reads *"Kane ruled (b) on 432"*
  (`src/lib/payroll/paystub-delivery-address.ts`). That ruling is not yet in the session log and
  the build is not committed, so it is NOT recorded here as a decision.

## Payroll inbox review

- **Said:** the report was *"prompting a review of the payroll inbox and system records."*
- **True:** the repo cannot see the inbox. The system-records half is item 432's sweep.
- **Needs:** an owner, not named in the notes. Worth counting how many of the other 13 previous
  holders also wrote in.

## Security: verify sign-in, reset passwords (item 434)

- **Said:** *"Plans were made to verify login security, perform password resets, and confirm
  whether active staff received their correct documentation."*
- **True:** HRIS sign-in is Google OAuth on an Internal consent screen
  (`src/lib/auth/auth-options.ts:5`, `:138`). A previous holder who has only a personal Gmail
  cannot sign in to the HRIS from the paystub email. The exposure is the Google Workspace account
  behind a recycled address, if it was handed over without a password reset. That is a Workspace
  admin action and is NOT verified from the repo.
- **Needs:** a named owner with Workspace admin, and the list: the 14 addresses in item 432 (the
  four same-person rehires the sweep dropped, `jebr@`, `lanym@`, `joyces@`, `andreac@`, are the
  same person and need nothing).

## Confirm the current holders received their paystubs (item 433)

- **Said:** *"confirm whether active staff received their correct documentation."*
- **True (measured 2026-10-09):** 0 of 45. For `krisd@`, no queued or sent statement carries the
  current holder's own address, checked by address, by `payload.personal_email` and by name.
- **How a re-send works today:** only Mark Paid in Payment Dispatch emails a statement through
  n8n, one person at a time. An already-sent statement goes again only on undo then Mark Paid,
  behind a prompt (`app/api/payment-dispatches/route.ts:460`). There is no Re-send button. The
  precedent is `scripts/send-breyl-skipped-paystubs.mts` (09-24, item 199): the same steps as
  Mark Paid without the payment write, dry run by default, `--send` to email.
- **Two constraints the re-send hits:**
  - A re-send reads the QUEUED `payload.personal_email` (`paystub-dispatch.md:454`), so the 45
    queue rows must be re-pointed first, or the re-send mails the previous holder again.
  - All 45 rows carry `sent_at`, so the system counts a re-send as issue 2 and stamps it
    Reissued (`paystub-dispatch.md` § Reissues), though it is the first copy the worker gets. The
    breyl script refuses `sent_at` rows for exactly this reason.
- **Needs (Kane):** scope (`krisd@`'s 4, or all 45) and the label (Reissued, or recorded as a
  first delivery). Asked in session `fa7e8cda`, unanswered. "Documentation" may mean more than
  paystubs (COE, contracts); only paystubs were measured.

## Offboarding: a worker sharing a work email with someone "mistakenly off-boarded" (item 435)

- **Said:** *"Additional confusion arose from a worker's account sharing a work email address with
  an individual who was mistakenly off-boarded."*
- **True:** the address is not named, so nothing was measured. Two readings: the previous holder
  was off-boarded in error (then it may be a rehire, the class the 432 sweep dropped), or the
  current worker reads as off-boarded because `offboarded_sheet` carries the same work email.
  Related, already recorded: item 344 (`syncStartDateToMaster` overwrote the old holders' Start
  Dates on recycled addresses) and `clearoffboarded-reactivation-collision`.
- **Needs:** Kane to name the address. Any change after that is a `hardening` change on
  offboarding.

## Decisions made on the call

None recorded. The notes list plans (inbox review, sign-in checks, password resets, confirming
delivery) with no owner named.

## Open questions

1. Who wrote in, and under which work email? "Over a year" matches none of the 14.
2. Who runs the Workspace checks and resets, and on which accounts?
3. Re-send scope and label (433).
4. Which address is the "mistakenly off-boarded" one (435)?
5. Does "documentation" cover anything besides paystubs?

## Action items

| # | Owner | Action | Status |
|---|---|---|---|
| 1 | Kane | Name the ex-employee who wrote in, or their work email | Open |
| 2 | Not named | Review the payroll inbox for replies from the other previous holders | Open |
| 3 | Workspace admin (not named) | Verify sign-in and reset passwords on the recycled accounts (434) | Open, NOT verified |
| 4 | Kane | Approve the write: re-point the rate rows and the 45 queue rows (432) | Waiting (Kane) |
| 5 | Kane | Pick re-send scope and label (433) | Waiting (Kane) |
| 6 | Other session, then Kane | Commit the uncommitted 432 build; Kane pushes | Waiting |
| 7 | Kane | Name the address behind the mistaken off-boarding (435) | Open |

## Reference notes

- Source is a summary, not a transcript. No speakers, no garbles to map.
- `off_boarded_at` is the date on the `offboarded_sheet` row and may differ from a person's last day.
- Not checked: the payroll inbox, Google Workspace, the n8n email template, and documents other
  than paystubs.
- Names and personal emails are kept out of this note; item 432 holds what is needed.
- Related: [2026-10-08 Carla call](./2026-10-08-carla-scoreboard-keys-hsl-v2-and-cop.md) (none of
  this came up there), [`paystub-dispatch.md`](../features/paystub-dispatch.md), Open items 199,
  344, 432.
