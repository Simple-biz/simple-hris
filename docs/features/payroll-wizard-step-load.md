# Payroll Wizard — step-rail load progress

**Shipped** 2026-08-24 (inside the catch-all commit `7b9fe312`). **Documented** 2026-08-25.

Accounting kept reading a half-loaded wizard as a *wrong* wizard — glancing at the Additions
step before the PAB merge landed and concluding the numbers were broken. Every step from
**Initialize Payroll Data (1)** through **Dispatch (7)** now carries a determinate progress
line along its bottom edge while **its own** data is in flight, completing in green when that
data lands.

> **Step ids shifted down by one on 2026-08-28** when HSL and Additions merged into a single
> step 4 (`payroll-wizard-final-pay.md`). Every number on this page is the post-merge id.

> A tab going green is a statement that **its figures can now be judged**, not that the page
> finished mounting. That is the entire contract, and everything below exists to keep it true.

---

## 1. What the user sees

A 3 px line inset 12 px from each end of the step's bottom border, so it runs on the straight
part and is not tapered by the rounded corners.

| Phase | Appearance |
|---|---|
| `idle` | nothing rendered — a step that never waited shows no line at all |
| `loading` | neutral track (`rgba(113,113,122,0.28)`) with an **orange** (`#f97316`) fill, driven from a rAF loop |
| `done` | the fill runs the last stretch to 100% and eases to **emerald** (`#10b981`) over 600 ms |
| hold | green holds `STEP_PROGRESS_HOLD_MS` = **1700 ms**, then returns to `idle` |

Steps go green in a **wave**, and the ordering is the useful part — it tells Accounting *which*
tab is still cooking rather than just "something is". Step 1 first; then 2/3; then 5; then 4
and 6/7 last, because the all-weeks PAB merge fires one request per archived upload and is
reliably the straggler — and since the merge, step 4 waits on that merge **and** the HSL
amounts.

**Reports (step 8) is outside the range** — it is a post-dispatch summary, not a figure anyone
judges mid-load.

---

## 2. Files

| File | Role |
|---|---|
| `src/lib/payroll/step-load-prediction.ts` | pure prediction + the localStorage EMA. **The invariant lives here so it can be tested.** |
| `src/lib/payroll/step-load-prediction.test.ts` | 12 tests, incl. the never-reaches-100% proof |
| `src/components/PayrollWizard.tsx` `StepDataProgress` (~1796) | the component: rAF loop, grace window, settle timers |
| `src/components/PayrollWizard.tsx` `isStepDataLoading` (~5030) | the per-step data mapping |
| `src/index.css` `.wizard-step-progress` / `-bar` (~1451) | track, fill, done colour |

---

## 3. The invariant

> **Prediction alone never fills the bar. Only the data actually landing takes it to 100%.**

`predictedProgress(elapsedMs, estimateMs)` ramps **linearly to `PREDICTED_CEILING` = 0.9**
across the prediction, then eases asymptotically toward `OVERRUN_CEILING` = **0.99**:

```
elapsed <= est   →  0.9 * (elapsed / est)
elapsed >  est   →  0.9 + 0.09 * (1 - e^-((elapsed-est)/est))
```

This is not cosmetic. The line's whole purpose is to say when figures are safe to read, so a
bar that hit 100% early would say *safe* early — the exact mistake it was added to prevent. An
overrun keeps showing movement instead of parking at a dead 90%, without ever claiming to be
finished. `step-load-prediction.test.ts` covers it across estimates and elapsed times, plus
monotonicity, a hung ten-minute fetch, and a pathological sample poisoning the EMA.

**The module was extracted from `PayrollWizard.tsx` for exactly this reason** — so the
invariant is proven in a test rather than asserted in a comment. Do not inline it back.

---

## 4. The prediction

The loaders cannot report progress — a `fetch` either is or is not done — so the bar is
predicted from **that step's own history on this browser**.

| Constant | Value | Why |
|---|---|---|
| `STEP_LOAD_MS_KEY` | `hris.payrollWizard.stepLoadMs.v1` | localStorage, per-step durations |
| `STEP_LOAD_MS_DEFAULT` | 2600 ms | a step this browser has never timed |
| `STEP_LOAD_MS_MIN` / `MAX` | 350 / 90 000 ms | one pathological load (dropped connection, laptop asleep mid-fetch) cannot poison every refresh after it |
| `STEP_LOAD_EMA_ALPHA` | 0.35 | tracks a genuinely slower week within a couple of refreshes; one slow load does not become the new normal |

**Two honest limitations, both correct behaviour rather than bugs:**

- **First load on a fresh browser** has no history, so it uses the 2600 ms default. If the real
  load is faster the bar is caught mid-ramp and jumps to full. The EMA fixes it from the second
  refresh on.
- **It is a prediction, not a measurement.** A step that suddenly loads much slower than usual
  sits near 90% until it lands. It keeps creeping — that is the asymptote — but the *position*
  is not information at that point.

---

## 5. The per-step data mapping

A tab going green only means something if the mapping is real. Each step lists exactly the
fetches its numbers depend on (`isStepDataLoading`):

| Step | Waits on |
|---|---|
| 1 Initialize | upload list + Hubstaff preview table |
| 2 Initial Calculation | + week hours, `employee_hourly_rates` |
| 3 Orphanage | same as 2 — orphanage pay is priced from those hours × rates |
| 4 Additions (department table + HSL tab) | + the all-weeks PAB merge, HSL KPI amounts, HSL bonus entries (step-scoped) |
| 5 Contractors | upload list + invoices (step-scoped) |
| 6 Validation · 7 Dispatch | everything — these are the steps where a premature reading costs money |
| 8 Reports | nothing — outside the range |

**Step 4 waits on both halves of the old 4+5 pair, and it must.** The step owns two surfaces
that never coexist in the DOM — the shared department table and the HSL tab — but green is a
claim about *the step*, and the operator can switch tabs without reloading anything. So the
HSL fetch is gated on `currentStep === 4`, **never** on `activeDeptTab === 'hogan_smith_law'`:
tab-gating it would let the line go green while nothing had ever been fetched for the tab the
operator is about to open. Same rule as the exclusions below — if it can be judged there, it
is waited on here.

**Every flag used here settles in a `finally`**, so a stalled fetch that rejects still ends the
animation. The line cannot become the forever-spinner a terminal skeleton once was
(see [[kpi-calculator-week-unresolved-hang]]).

### Deliberately excluded

- **`orphanageDetailLoadedFor`.** Its loader never sets the marker on a failed or aborted
  fetch, so a line driven off it would run **forever on exactly the case the line has to
  survive**. Step 3 rides the shared hours + rates, which is what prices orphanage pay anyway.
  **Do not wire this in without first making that loader settle on failure.**
- **`hslSyncLoading` and the upload-progress spinners.** Those are actions Accounting just
  took, already reported by the button they pressed. This line is about *data arriving*, not
  about work they asked for.

### Step-scoped fetches

`hslStepLoading` (4) and `contractorInvoicesLoading` (5) are gated on `currentStep`, because
their effects only run while Accounting is standing on the step — which is also the only time
their absence would be misleading. Step-scoped is as narrow as this may get: **not**
tab-scoped (see above).

---

## 6. Two mechanics that are easy to break

**The 280 ms grace window (`STEP_PROGRESS_GRACE_MS`).** Loaders hand off to each other — the
upload list finishing is what *starts* the preview fetch — so a step is momentarily "not
loading" between two of its own fetches. Without the grace, it flashes green and drops back to
orange. The start timestamp is kept across the hand-off, so the duration recorded in the EMA
is the whole wait Accounting actually sat through, minus the grace.

**The fill is written straight to `style.transform` from a `requestAnimationFrame` loop**, not
through React state. Sixty re-renders a second across eight steps, while the payroll fetches
are already saturating the main thread, is the one thing that would make it stutter. `scaleX`
rather than `width` so the fill runs on the compositor. Only the last stretch to 100% is a CSS
transition — and the transition and the transform are set in **separate frames**, because
committing both together is the classic case where the browser collapses them and snaps
instead of animating.

---

## 7. What this deliberately is not

Earlier cuts used the masked conic sweep of `.urgent-ring` / `.prism-rim`. Two reasons it was
dropped, and both still apply if anyone is tempted back:

1. Kane's verdict: *"it looks too premium please just a normal orange."* On a payroll rail a
   sweeping arc reads as a feature rather than a status light.
2. `@property`-angle animation **repaints the conic gradient every frame**. Fine for one card;
   this runs on eight cards at the exact moment the main thread is busiest.

An earlier cut also made green a *settle* that clears rather than a persistent badge. That is
still the behaviour: eight green outlines living on the rail forever stop carrying information
after a couple of seconds. Making green permanent is one constant away if Kane ever asks.

---

## References

- [payroll-wizard-week-replay.md](./payroll-wizard-week-replay.md) — what "the week's data" means
- [payroll-readiness.md](./payroll-readiness.md) — the Wizard Setup checklist beside this rail
- [payment-dispatch.md](./payment-dispatch.md) §"lock sweep" — the *indeterminate* sibling
  (`.payroll-lock-sweep`), used where there is nothing to predict
- Memory: [[payroll-wizard-step-load-progress]] · [[kpi-calculator-week-unresolved-hang]] ·
  [[payroll-wizard-tab-persist]]
