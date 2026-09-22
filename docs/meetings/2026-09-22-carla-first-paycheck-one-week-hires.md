# 2026-09-22 — Carla: one-week hires are missed on payroll; label everyone's first paycheck

Relayed by Kane on 2026-09-22. One topic, one decision, shipped the same day.

## What Carla described

New hires who leave or are off-boarded **inside their first week** — often after only a
few hours of work — are frequently missed on the payroll dashboard. They are separated so
quickly that they never appear on the standard new-hire lists the team pulls from the
wizard or the HR system: every one of those lists is built from **active** rosters and
excludes the off-boarded list. Accounting finds them by hand, cycle after cycle, and adds
missing rows manually.

Her ask: an option in the wizard that identifies **everyone's first paycheck** for the
cycle, regardless of whether they were subsequently off-boarded, so all new hires are
captured and paid without the manual sweep.

Kane's framing: *"Payroll wizard — Initial Calculation should have a label on the people
who got hired for like only one week and then get offboarded the next week."*

## What was true before this session

- The wizard **already had the row.** Pay rides Hubstaff hours, not the roster
  ([payroll-wizard-final-pay.md](../features/payroll-wizard-final-pay.md)): anyone with
  hours in the week's timesheet has a calc row on Step 2, off-boarded or not, and the
  final-pay overlay resolves their department and rate
  ([[final-pay-roster-overlay]]). Nothing said *which* rows were first checks.
- No doc or surface defined "first paycheck". Readiness defines the inverse —
  `started_this_week`, *"first pay period not closed"* — which is who is **not** paid
  yet, not who is being paid for the first time.
- A master-list **Start Date is not usable as the criterion**: it is sparse (690 of 4,045
  off-boarded rows carry one), hand-typed, and absent for exactly the people this is for.

## Decision

Define **first paycheck = no Hubstaff hours for any of the person's known email aliases in
any earlier upload on record.** Hours cannot be forged by a bad or missing date. Start
date is shown as detail only.

Shipped: a **"First paycheck"** label on the Step 2 name cell (rose **"First & final pay"**
when the same row is also on the final-pay overlay — the one-week hire), a
**First paycheck (N)** filter chip beside the department filter, the count in the header
line, and a new read-only index route. Display only: it adds no payee and never enters
the payload, the `final_pay` snapshot or dispatch. Details in
[payroll-wizard-final-pay.md](../features/payroll-wizard-final-pay.md) § *First paycheck
label*.

## Open

- Not verified in a browser this session (no session available here); `tsc` clean, rule
  module unit-tested.
- On the **oldest upload on record** everyone is trivially "first" — the label is
  suppressed there and the header says so.
- A person with **no roster row under either address** whose Hubstaff email changed would
  read as first. The alias bridge covers the master list and the final-pay overlay; the
  residue is disclosed in the header's tooltip as "unknown", never hidden.
