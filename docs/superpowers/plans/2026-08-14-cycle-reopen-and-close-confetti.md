# Plan — Reopen a closed pay cycle, + confetti on a clean close

2026-08-14. Approved shape: resolution **(b)** of the blueprint conflict — `cycle-closeout.md:104`'s
"there is no reopen" is superseded, but only in the **archive-then-delete** form: the filed record is
moved aside, never destroyed. Kane's three answers:

1. Reopen **exists**, archive-then-delete (not a hard delete).
2. Confetti fires **only when nothing is owed** — the same `isCycleFullyPaid` rule as the email.
3. Reopen is **admin / payroll_manager only**, and the control lives **on the Payment Dispatch
   screen** near Start/Stop, not inside the Stop dialog (the dialog's close-out block renders only
   on the STOP side, so a button there is unreachable once you have stopped).

## Tasks

- [x] 1. `src/lib/payroll/cycle-closeout.ts` — pure additions: `CYCLE_REOPENED_PREFIX`,
      `cycleReopenedKey()`, `CYCLE_REOPEN_ROLES`, `canReopenCycle()`.
- [x] 2. `src/lib/payroll/cycle-closeout.test.ts` — extend: archive key never matches the
      `dispatch.cycle_closeout.%` prefix scan; role gate admits exactly two roles.
- [x] 3. `src/lib/payroll/cycle-closeout-store.ts` — `reopenCycle()`: burn the celebration claim →
      archive the record → delete the live key, in that order.
- [x] 4. `app/api/payment-dispatches/cycle-closeout/route.ts` — `DELETE`, role-gated, awaited audit
      `payment_cycle.reopened` carrying the full prior record.
- [x] 5. `src/components/payroll-clerk/PayrollDispatch.tsx` — the `Closed · Reopen` control with a
      two-step confirm, plus `ConfettiBurst` on a clean close.
- [x] 6. Typecheck + full suite.
- [x] 7. `docs/features/cycle-closeout.md` (§ "Closing is once" rewritten, § Reopen added),
      the store's header comment, INDEX invariant, both memory entries, `MEMORY.md`.

## Decisions taken

- **Reopen never destroys the declaration.** The record moves to
  `dispatch.cycle_reopened.<source_file>.<iso>` before the live key is deleted. A prefix
  deliberately OUTSIDE `dispatch.cycle_closeout.` — sharing it would make every archived record
  read as "this week is still closed" in `listCycleCloseouts`, which a test pins.
- **Reopen burns the celebration claim.** `dispatch.cycle_complete_notified.<source_file>` is
  INSERTed (if absent) with `suppressed_by: 'reopen'`. Both celebration triggers already check that
  key and both go silent on `23505`, so "the automation won't fire again" needs no new gate — and
  cannot be forgotten by a future caller.
  **Consequence, accepted:** a week whose email never actually delivered (the marker is released on
  delivery failure) will never get one after a reopen either. Kane's instruction is unconditional.
- **Claim first, then archive, then delete.** If the archive write fails the reopen aborts with the
  week still closed — the only loss is a burned celebration, never the record.
- **Confetti is gated, the close is not.** Closing stays gate-free; the confetti is a consequence of
  the numbers. A close owing money files exactly as readily, in silence.
- **No migration.** `app_settings` only, two key families, no DDL, no n8n step.

## Out of scope (contract)

The close-out record's shape · the close POST → `setLocked` ordering · the download artifacts ·
`cycle-complete-notify.ts` and its route · the Payroll Wizard's dialog (passes no `closeOut`).
