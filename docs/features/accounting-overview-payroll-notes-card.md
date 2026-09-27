# Accounting Overview — "Payroll Notes" card (Steps 1–8)

> **Status:** Built 2026-09-26, committed locally, **not pushed / not deployed**. No migration,
> no route change, no new grant.
> Replaces the **New hires** and **Attrition** cards in the Overview's attention row.

Kane, 2026-09-26: *"remove the New Hires and Attrition Cards in here and change it [to]
something meaningful for accounting like the first data that they have to see like Payroll Notes
— Step 1 to 8 … animated inside where it changes data … we prioritize Not yet done steps and it
should switch smoothly."*

The attention row under the Overview hero is now two cards: **Needs your decision** (unchanged,
one column) and **Payroll Notes · Steps 1–8** (two columns from `md` up). Headcount and
attrition were HR figures that Accounting could not act on. They are still on `/hr`
(`HrOverview`'s Attrition 12mo tile, `OffboardingWeeklyPulse`), and nothing else read the
Overview's copies.

---

## 1 · What it shows

The Payroll Wizard's **Wizard Setup checklist**, the same seven rows as the first tab of Payroll
Notes → Readiness ([payroll-readiness.md § Wizard setup checklist](./payroll-readiness.md)), for
the cycle the Overview is on:

| Step | Row |
|---|---|
| 1 | Hubstaff CSV |
| 2 | USD rate confirmed |
| 3 | Orphanage hours |
| 5 | KPI bonuses |
| 5 | Notes adjustments |
| 6 | Contractor invoices |
| 8 | Sent to dispatch |

Step 4 (PAB) and step 7 (Validation) have no row. PAB forgiveness is a judgment call, not a
prerequisite, and Validation is the check itself. The numbers are the server's `stepNo`, so the
card follows the wizard rail when it changes. It never hard-codes one.

- **Left:** `doneCount / totalCount done`, "N steps still open" (or "Every setup step is done."),
  and a **step rail**: one segment per row in rail order, coloured by status (emerald done, amber
  attention, rose blocked, sky pending), with the step number under each. The rail is also the
  slide picker. Clicking a segment jumps to that step's slide, or to the recap slide that holds it.
- **Right, the spotlight:** one slide at a time. Each slide shows the step number, its position
  among the open steps ("1 of 3 open"), the status pill, the label, and the row's detail text as
  the server wrote it ("PHP still 0 — Step 2", "2/9 ready · QC, HR +1 more", "Locked by … · Sep 20").
- **Awaiting week:** when `wizardSetup.awaitingWeekLabel` is set (a later pay week closed with no
  CSV), an amber line names it. The card itself stays on the week in view, the same rule the pane
  follows.
- **Footer:** **Open Payroll Wizard →** calls `onNavigate('payroll-wizard')`, which the
  Accounting shell's tab gate still checks. The **"as of HH:MM"** time is when that data left the
  server, which for a cached paint is the cache's own stamp.

The card is **read-only**, like the pane's rows: every fix lives on the wizard step the detail names.

## 2 · Rotation — open steps first

The pure rule lives in `src/lib/payroll/wizard-setup-spotlight.ts` and is pinned by
`wizard-setup-spotlight.test.ts`:

- **Anything open** → every open step, **most severe first** (`blocked` → `attention` →
  `pending`, with rail order breaking ties), then **one** "Done so far" recap slide listing the
  done steps. A done step never gets a slide of its own while anything is open. With 1 of 7 open,
  that open step is on screen half the time rather than a seventh.
- **Everything done** → each step in rail order, so the card still shows the week's facts instead
  of freezing on a single slide.
- **Status is never re-derived.** The card reads `WizardSetupStep.status` exactly as
  `deriveWizardSetupSteps` produced it, so the card and the pane cannot disagree. A row whose read
  failed arrives as `pending` ("Couldn't read…") and plays as **open**. It is never folded into
  the done recap, because a failed read is never green.
- **A refresh keeps your place.** If the slide on screen still exists after a poll, it stays;
  if its step got fixed (it moved into the recap), the rotation restarts at the most urgent slide.
  Switching the Overview's cycle resets to the first slide.

Motion: each slide holds **5.2s**, then crossfades (opacity + 14px rise + slight blur, 0.42s,
the app's `[0.22, 1, 0.36, 1]` ease). Under reduced motion it is an opacity crossfade only.
**Hovering the card, or keyboard focus inside it, holds the current slide.** A mouse click on a
segment does not, so the card cannot stay frozen after the pointer leaves. The spotlight is
`aria-live="off"` while it rotates on its own and `polite` while it is held, following the ARIA
carousel pattern: a 5-second announcement loop would be noise.

## 3 · Data, cache, week

- **Source:** `GET /api/payroll-wizard/readiness[?source_file=]`, the same route and the same
  `payroll_wizard` **view** grant the pane uses. Only `readiness.wizardSetup` is rendered.
- **Week:** `setupSourceFile` is the Overview's **cycle selection**. A specific upload uses that
  file. All Time and the default (latest) send **no** `source_file`, so the server uses its live
  `is_current` week and the card's week tag says which one that is. It comes from the selection,
  not from `activeSourceFile`, because a failed Hubstaff-hours fetch nulls `activeSourceFile`, and
  that must not move this card to another week.
- **Cache:** the **same per-week entry** as the FAB's score ring and the Readiness pane
  (`TAB_CACHE_KEYS.payrollReadiness`), through `src/lib/payroll/readiness-cache.ts`. That is the
  FAB's former private helpers, moved unchanged, so all three readers share one 30s fresh window,
  one 6h ceiling and one 4-week trim. On mount, or when the week changes, the card paints the
  cached snapshot and then revalidates, unless the snapshot is under 30s old
  ([payroll-wizard-notes.md:119](./payroll-wizard-notes.md)). The key is on
  `tab-cache.test.ts`'s banned list, so no skip flag is involved.
- **Hydration:** the cache is read in a layout effect, never in `useState`'s initialiser. The
  `/accounting` shell renders server-side, where `sessionStorage` does not exist.
- **Freshness:** a background refresh every **2 minutes** while the page is visible, plus a
  refetch on focus or visibility return once the snapshot is 30s old. This is slower than the open
  pane's 30s poll on purpose. The snapshot is an expensive aggregate, and the pane owns the live
  view once someone is working the wizard.
- **Failures:** a background blip keeps the steps already on screen, and the "as of" time stays
  honest. A load with nothing to paint shows "Couldn't load this week's steps" with **Try again**.
  A **401/403 drops the painted data** and shows a locked "Payroll Wizard access needed" state.
  The route's grant decides. The card never loosens it and never shows a cached snapshot to a
  viewer the server has refused.

## 4 · What was removed

- `SimpleViewProps.attrition` / `.newHires`, their tone logic, and the two `AttentionCard`s.
- The parent's `attrition` state, its `newHires` memo, and the **`/api/employees`** headcount pull
  that fed only the attrition rate.
- **Kept:** the `/api/hr/offboard-history` read in the same effect. It also builds
  `offboardedByEmail`, which the Hubstaff ↔ Master reconciliation needs to treat an already
  off-boarded worker as an expected exception.

## 5 · Files

| Path | Role |
|---|---|
| `src/components/accounting/PayrollNotesSetupCard.tsx` | the card: fetch, cache, poll, rotation timer, render |
| `src/lib/payroll/wizard-setup-spotlight.ts` (+ `.test.ts`) | pure slide order, active/next key, card tone |
| `src/lib/payroll/readiness-cache.ts` | the shared per-week readiness cache (moved out of the FAB) |
| `src/components/accounting/wizard-setup-meta.ts` | `SETUP_STATUS_PILL` / `SETUP_STEP_ICON`, shared with the pane so a status looks the same in both places |
| `src/components/Overview.tsx` | the attention row; `setupSourceFile` from the cycle selection |

## 6 · Not done

- **Not verified in a browser.** `tsc` is clean, the new spotlight tests pass (10/10), the full
  suite is 4655/4657 (the two failures are the pre-existing `dept-label-render` and
  `manager-time-adjustments-live`, in files this change does not touch), and a server-side render
  of the card produces its header and loading skeleton without error. The populated rotation, the
  locked state, and dark mode were not clicked through, because that needs Google SSO. `next build`
  was not run, because a `next dev` server was live on :3000 and the two share `.next/`.
- The step numbers shown are only as current as `stepNo` in `wizard-setup-steps.ts`. If the wizard
  rail is renumbered, that file moves with it, as its header says, and the card follows.
