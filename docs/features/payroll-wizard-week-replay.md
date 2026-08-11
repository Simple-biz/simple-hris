# Payroll Wizard — week selector & replay fidelity

The pay-period dropdown in the wizard's header (`PayrollWizard.tsx`, "Replay a
past payroll period") switches `calcSourceFile` to any uploaded Hubstaff file.
Anything other than the newest upload is a **replay**: `isReplay` is true, every
write path is disabled, and an amber banner explains what is on screen.

This doc owns **what a replay is allowed to show**. The rules were previously
scattered across `docs/reference/business-logic.md` (two separate notes) and the
`paystub-tab-exact-recovery` memory, with nothing joining them — which is how the
bonus-toggle leak below survived.

Hardened **2026-08-11**. Pure rules + truth tables:
[`src/lib/payroll/replay-bonus-toggles.ts`](../../src/lib/payroll/replay-bonus-toggles.ts)
(+ `.test.ts`).

---

## The contract

**A replay shows the week as it was paid, or says it can't.**

Three rules, in precedence order. They are not new — they are the existing rules
of this codebase, finally applied to the wizard's own replay:

1. **Live data may not leak into a replay.** Today's rates, catalog, exclusions,
   holidays and disputes describe today, not a closed week.
   (`docs/reference/business-logic.md` → the pay-structure overlay applies "only
   when `!isReplay`, so historical replays of past periods stay accurate";
   `docs/reference/data-sources.md` §Pay structures.)
2. **What was saved is read verbatim, never re-derived.** Re-derivation
   "diverges on manual toggles / post-hoc dispute/config drift and produced
   phantom bonus lines" — the finding that reshaped the employee paystub recovery
   path (memory `paystub-tab-exact-recovery`).
3. **An absent or empty saved value counts as ABSENT and falls back to live
   computation — never to ₱0.** Suppressing live computation on an empty `{}`
   snapshot once made a payout week read ₱0/"In Progress" for everyone
   (`business-logic.md` → "Replay", 2026-07-17). Rule 3 outranks rule 2: a
   missing snapshot is a reason to estimate and **say so**, never a reason to
   invent a zero.

## What replays from the week's own data

Per-`sourceFile` state, hydrated on every selector change:

| Value | Source |
| --- | --- |
| Adj. amounts + notes (`bonusOverrides` / `bonusOverrideNotes`) | `payroll.wizard.additions.<sourceFile>` |
| Orphanage amounts, per-employee & per-dept metrics | same blob |
| Dept-bonus toggles, Tech manual grants/revokes | same blob |
| **PAB + Tech toggles** (`employeeBonuses`) | same blob — see below |
| Dept assignments (`employeeDepts` / `employeeDeptsManual`) | same blob |
| PAB verdict pills (`lockedPabSnapshot`) | same blob's `pabStatusSnapshot` |
| Do-not-pay exclusions | `payroll.wizard.exclusions.<sourceFile>` |
| Pay-this-week / OT config | `payroll.wizard.dept_pay_paused.<sourceFile>` |
| Cycle FX legs | `payroll.wizard.fx.<sourceFile>` (read-only on replay) |
| Reports salary figures | `payroll.wizard.final_pay.<sourceFile>` overlay |
| Manager KPI amounts | `bonus_catalog_applied`, pinned to the file's week |
| HSL KPI amounts | `hsl_bonus_entries`, pinned to the file's week |
| Hours, rates | the file's own `hubstaff_hours` + `employee_rate_history` (the catalog overlay is skipped while `isReplay`) |

## PAB / Tech toggles — the leak this doc was written for

`employeeBonuses` is saved per week, and it hydrates correctly. But two effects
(`perfect_attendance` and `tech_bonus` auto-toggle) re-derive eligibility from
**today's** inputs — live PAB exclusions, the current US-holiday list, the
current dispute/time-adjustment set, current master start dates — and they ran on
replays too, overwriting the hydrated blob a beat after it landed.

Consequences, both real:

- Replaying a closed week showed the bonuses that week **would earn if it were
  run today**, not the ones it was paid.
- Any later change to those inputs — one PAB exclusion, one approved dispute, one
  corrected start date — silently rewrote what history appeared to say.

**The rule now** (`shouldFreezeReplayBonusToggles`): on a replay whose blob
carried a **non-empty** `employeeBonuses` map, that map is authoritative and both
effects stand down. Mechanics worth knowing:

- **Non-empty only.** A blob written before any dept was assigned (an
  orphanage-only save, say) holds `{}`; freezing that would replay every bonus as
  ₱0 — rule 3 above. `savedBonusTogglesFor` is `null` in that case and the live
  derivation takes over.
- **The marker is compared against the selected file**, not merely checked
  non-null. It outlives a week switch by one render, and week A's marker must
  never authorize freezing week B.
- **Both orderings are safe.** An auto-toggle firing *before* hydration is
  overwritten by it (the load replaces the whole map); one firing *after* sees the
  freeze already set.
- **Frozen only ever fills a gap** (`resolveBonusToggle`). An employee the blob
  has a verdict for keeps it; one it never covered — joined the roster or the
  department after the lock-in — still gets their live verdict instead of a silent
  `false`. Same rule `effectivePabStatus` already applies to employees missing
  from a frozen PAB snapshot.
- **Never frozen on the live week.** Re-deriving is that week's entire job.
- **The banner tells the truth.** It used to promise "the adjustments, notes,
  bonuses and final pay saved for this period" unconditionally, including for a
  week that saved none. When the toggles aren't frozen it now says the bonuses are
  re-derived and may differ from what was paid.

## KPI amounts — no cross-week bleed

Both KPI loaders key on the file's week (`hubstaffWeekStart`) and load on their
own clock, independent of the additions blob. Two holes, both closed:

- **A failed manager-KPI read used to keep the previous week's amounts.** Its
  `catch` was empty, so a network failure left week A's `bonus_catalog_applied`
  sums applied to week B's rows. The HSL twin already refused to do this ("clear
  rather than keep a possibly-stale other-week amount"); the manager loader now
  matches it, and logs — an unreadable money input is never silent.
- **The in-flight window.** Neither loader cleared before awaiting, so the
  previous week's amounts stayed on screen — and inside `dispatchData` — across
  two round trips after a week switch. Both now clear **synchronously, before the
  first await**. The HSL spinner (`hslKpiLoading`) already covers the gap; the KPI
  Sub. column is gated on `managerBonusMeta` and simply hides.

## HSL KPI Bonus Period cards (step 4) — monthly depts ignored the selector

Two more holes in the step-4 loader, found by Kane testing the above
(2026-08-11): replaying **Jul 26 – Aug 1 2026** showed SSD Medical Records as
**"August 2026 · ₱463,750 · READY"**.

**Monthly depts were never week-scoped.** Weekly HSL depts pin to
`hubstaffWeekStart`; monthly ones took *"the latest ready/locked, full stop"* —
the newest period that exists anywhere, whatever week you were replaying. Live
data at the time held both a `2026-08-02` (August) and a `2026-07-26` (July)
ready period for each of the three monthly depts, so the August one always won.
It affected **SSD Medical Records, Collections and Healthcare Team Lead**
together.

These cards carry a `manual · Adjustment` badge — monthly HSL bonuses are **not**
auto-dispatched, Accounting applies them by hand from the Adjustment column. So
the wrong month is an actionable wrong number, even though nothing auto-flows
from it (the money path, `hslKpiAmounts`, is weekly-only and was already pinned).

**The rule now** (`relateMonthlyPeriodToWeek` in
[`bonus-cadence.ts`](../../src/lib/payroll/bonus-cadence.ts)):

- a monthly period from a month the viewed week **has not reached** is never a
  candidate;
- an **exact month match** outranks an earlier one, regardless of which has the
  later `period_start`;
- otherwise the previous latest-wins / locked-beats-ready tiebreak stands — so a
  month nobody submitted still falls back to the latest earlier period. The fix
  only ever removes **future** months.
- With no file loaded, or a date that will not parse, nothing is scoped
  (`'unknown'`). Failing **open** is deliberate: dropping candidates on a parse
  failure would hide a real bonus.

### Two month rules, on purpose

The two sides of that comparison are different kinds of date and must not share
a rule:

| Side | Rule | Why |
| --- | --- | --- |
| the viewed **week** | month of its **owning Monday** (`payrollWeekMonthOrdinal`) | what `bonus-cadence.ts` already defines monthly payout against, and what `fileMonth` uses for every other month-scoped section |
| the **monthly period** | its own plain **calendar month** (`calendarMonthOrdinal`) | it is a month anchor, and this is how its visible label is rendered — scoping and label must agree |

The first cut of this fix ran both sides through the owning-Monday rule and
silently did nothing: `2026-08-01` is a **Saturday**, so the walk landed on Jul 27
and reported *July* for a period the UI labels "August 2026". Live rows are a mix
of month anchors (`2026-07-01`) and Sunday week dates (`2026-08-02`), so both
shapes have to land in the month they display. Pinned in
`bonus-cadence.test.ts`.

**`hubstaffWeekStart` was also missing from the loader's dep array**, so
switching the week selector while sitting on step 4 never reloaded — every card,
weekly ones included, stayed on the previously-viewed week until the step was
re-entered. Added.

### The publisher gate

That in-flight window was not only cosmetic. `publishFinalPaySnapshot` runs on a
1.5s debounce over `dispatchData` and writes
`payroll.wizard.final_pay.<sourceFile>` — which **Payment Dispatch prices from**
and the Employee Dashboard reads live. Long enough to persist week A's KPI
bonuses under week B's key.

It was already gated on `additionsHydratedFor === calcSourceFile`; it is now
gated on the two KPI loaders as well (`kpiAmountsMatchWeek`). The marker is
`{ week } | null` rather than `string | null` **on purpose**: `hubstaffWeekStart`
is itself nullable, so a bare string would make "loaded, no file selected" and
"not loaded" compare equal — exactly the comparison the gate depends on.

A *failed* load also lands on the closed side of this gate. That is deliberate:
holding the previous snapshot is better than overwriting it with a KPI-less total
that understates pay. Step 8's dispatch stages its own payload
(`paystub_dispatch_queue`) and is not blocked by this.

## Known gap — bonus AMOUNTS are still today's

PAB / Tech **amounts** and per-department eligibility resolve from `sysBonusCfg`
— the live Payment Catalog System Bonuses tab — on replay as on the live week.
The additions blob stores *toggles*, not amounts.

So after this hardening a replayed week's toggles are the week's own, but if a
catalog amount or dept allowlist changed since, the ₱ figure shown is today's.

Closing it properly is its own change, not a one-liner:
`payroll.wizard.final_pay.<sourceFile>` **already carries** the dispatched
`perfectAttendanceBonus` / `techBonus` per employee, and `replaySnapshotFinals`
already loads it on replay (today only the Reports step consumes it) — but that
map is email-keyed while `bonusTotals` resolves amounts per *dept*, and the pills
read a third source (`effectivePabStatus`). Making those three agree needs one
deliberate pass with the live path held byte-identical.

## Files

| Piece | File |
| --- | --- |
| Selector, `isReplay`, banner, both auto-toggle effects, publisher gate | `src/components/PayrollWizard.tsx` |
| Freeze + gap-fill + week-marker rules (pure, unit-tested) | `src/lib/payroll/replay-bonus-toggles.ts` (+ `.test.ts`) |
| Month-ownership + monthly-period scoping (pure, unit-tested) | `src/lib/payroll/bonus-cadence.ts` (+ `.test.ts`) |
| Payment-side KPI dept set | `src/lib/payroll/department-bonus.ts` (`WIZARD_PAYABLE_KPI_DEPT_KEYS`) |
| Dept-set invariants | `src/lib/payroll/kpi-calculator-depts.test.ts` |

Related: [payroll-wizard-final-pay.md](./payroll-wizard-final-pay.md) (the final-pay
formula and the snapshot it publishes) ·
[bonus-catalog.md](./bonus-catalog.md) §3.1 (why retiring a card must not narrow
the payable set) · [payroll-wizard-configuration-tab.md](./payroll-wizard-configuration-tab.md)
(the other per-week setting family).

No migration — every key already exists.
