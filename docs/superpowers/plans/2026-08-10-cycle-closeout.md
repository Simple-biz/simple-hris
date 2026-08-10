# Plan — Cycle close-out ("Close Pay Cycle?" from Payment Dispatch)

2026-08-10. Approved shape: resolution **(a)** of the hardening conflict — the publish
gate in `documents-tab.md:246-253` stands untouched; closing a cycle with unpaid
payable people writes a **separate** close-out record instead of a published report.

## Tasks

- [x] 1. `src/lib/payroll/cycle-closeout.ts` — pure. Key helper, record shape,
      `normalizeReportedUnpaid` (boundary validator), `buildCycleCloseoutRecord`
      (paid side via the shared `tallyPaidDispatches`), `parseCycleCloseout`.
- [x] 2. `src/lib/payroll/cycle-closeout.test.ts` — `node:test`, 20 cases.
- [x] 3. `src/lib/payroll/cycle-closeout-store.ts` — `server-only`. Paged reads,
      plain INSERT, `disbursement_records` cross-check.
- [x] 4. `app/api/payment-dispatches/cycle-closeout/route.ts` — GET (list / one by
      `?source_file=`) + POST. Edit-gated on `accounting` / `payment_dispatch`.
- [x] 5. `src/components/payroll/LockToggleConfirmDialog.tsx` — optional `closeOut`
      prop. Wizard passes nothing, so its dialog is byte-identical to before.
- [x] 6. `src/components/payroll-clerk/PayrollDispatch.tsx` — toggle state, the
      unpaid-payable list, close-before-stop in `handleLockToggle`.
- [x] 7. `src/components/payroll-clerk/DispatchReports.tsx` — `Closed` badge on
      cards + table rows, `CloseoutPanel` at the top of the detail view.
- [x] 8. Typecheck (`tsc --noEmit`, exit 0) + full suite (838/838).
- [x] 9. `docs/features/cycle-closeout.md`, INDEX row, memory + `MEMORY.md` pointer.

## Decisions taken

- **Close-out ≠ published report.** Two artifacts, two promises. See the feature doc.
- **Close BEFORE the lock flips.** The record is the un-redoable half; a failed write
  aborts the whole action loudly rather than stopping processing and losing the
  declaration.
- **No confetti.** The `payment_cycle_complete` celebration stays on its own
  automatic 100% trigger — emailing the team a congratulations for a cycle closed
  with people unpaid would be a lie.
- **No migration.** One `app_settings` row per cycle, same reasoning as the
  pay-cycle report: nothing for Kane to run.

## Out of scope (contract)

The wizard's Setup panel · the per-cycle wizard lock · the confetti claim · publish
condition 3 · the Documents publish gate.
