# Payroll Notes FAB — Readiness Progress Ring

**Date:** 2026-08-03
**Status:** Approved

## Goal

The Payroll Wizard's floating "Payroll Notes" button
([`PayrollWizardNotesFab.tsx:772`](../../../src/components/accounting/PayrollWizardNotesFab.tsx#L772))
already carries a Readiness tab — a 0–100 payroll-ready score computed by
[`getPayrollReadiness`](../../../src/lib/payroll/payroll-readiness.ts). Today that
score is invisible until an accountant opens the modal and clicks into the
Readiness tab. This feature puts the score on the **closed** button itself, as a
progress ring, so readiness is visible at a glance without opening anything.

## Decisions (from brainstorming)

1. **Progress ring around the button edge.** The `StickyNote` icon and the
   existing blue unread-notes count badge are unchanged. Rejected alternatives:
   replacing the icon with the number, a flat color-shift with no ring, and a
   ring that only appears when the score is bad.
2. **Color is a continuous fade, not the 3-band grade tone.** The ring's stroke
   interpolates from **orange at 0%** (`#f97316`, the button's own existing base
   color) to **emerald at 100%** (`#10b981`, the same green the rest of the
   Readiness feature uses for "ready"), driven by the raw `score.value` — not by
   `score.grade`. No special-casing for the `blocked` grade: the scorer already
   pins blocked totals to ≤60, so a blocked week reads solidly orange/amber on
   its own.
3. **The FAB fetches its own score, independently.** It calls the same
   `GET /api/payroll-wizard/readiness?source_file=...` endpoint
   [`PayrollReadinessGlance`](../../../src/components/accounting/PayrollWizardNotesFab.tsx#L2516)
   already uses, reading only `data.readiness.score` and discarding the rest of
   the payload. `PayrollReadinessGlance` itself is untouched — this is additive,
   with no risk to that component's already heavily-hardened internals.
4. **Refresh is trigger-based, not continuous.** Fetch on mount, whenever
   `wizardSourceFile` changes (new week), and when the Notes dialog closes
   (catches fixes made via the Readiness tab's inline "Set rate"/"Set bank"
   actions). No new Realtime subscription or poll timer at the FAB level — that
   infrastructure already exists inside `PayrollReadinessGlance` for when the tab
   is actually open, and this endpoint is expensive enough that a second
   always-on 7-table channel + 30s poll isn't worth it just to animate a badge.
5. **Silent best-effort.** A failed fetch simply leaves the ring absent (today's
   plain orange button) — never a toast, never blocks Notes/Adjustments.
6. **Click behavior is unchanged.** The button still opens to whichever tab was
   last active (default "Adjustments and Notes").

## Implementation

### Data

New state in `PayrollWizardNotesFab` (alongside the existing `wizardSourceFile`
/ `heardWizard` pair, [line 248](../../../src/components/accounting/PayrollWizardNotesFab.tsx#L248)):

```ts
const [fabScore, setFabScore] = useState<ReadinessScore | null>(null);
```

A new effect fetches `GET /api/payroll-wizard/readiness` (with `?source_file=`
when `wizardSourceFile` is set), holding for `heardWizard || grace(1500ms)` —
the exact pattern `PayrollReadinessGlance` already uses
([line 2620](../../../src/components/accounting/PayrollWizardNotesFab.tsx#L2620))
— so the ring never briefly shows the wrong week's score. Re-runs when
`wizardSourceFile` changes and when `open` transitions `true → false`. Wrapped
in try/catch; any failure just leaves `fabScore` as `null`.

### Color

A small pure helper (colocated in the same file, not a shared lib — nothing
else needs it):

```ts
function readinessRingColor(pct: number): string {
  const t = Math.max(0, Math.min(100, pct)) / 100;
  const lerp = (a: number, b: number) => a + (b - a) * t;
  // orange-500 hsl(21, 90.6%, 53.1%) → emerald-500 hsl(160, 84.1%, 39.4%)
  const h = lerp(21, 160);
  const s = lerp(90.6, 84.1);
  const l = lerp(53.1, 39.4);
  return `hsl(${h.toFixed(1)}, ${s.toFixed(1)}%, ${l.toFixed(1)}%)`;
}
```

Hue increases 21 → 160 (the short way around the wheel — no wraparound
handling needed), so the midpoint naturally reads yellow-green without a
hardcoded third stop.

### Ring markup

An `<svg>` sized a few pixels larger than the button's own footprint, laid over
the same `fixed right-5 bottom-5` corner with `pointer-events-none` so the
button underneath stays fully clickable. Same stroke-dasharray technique as
[`ScoreGauge`](../../../src/components/accounting/PayrollWizardNotesFab.tsx#L3752)
(track circle + animated progress circle), but no center text — just the ring.
Rendered only once `fabScore` is non-null (no flash of an empty/0% ring before
the first fetch resolves); animates in from empty, skipped under
`useReducedMotion`.

### Accessibility

The button's `aria-label` and a new `title` gain the readiness line when
`fabScore` is loaded, e.g.:
`Open payroll notes and readiness (3 open, readiness 82% — Almost)`.

## Error handling

- Fetch failure or non-OK response → `fabScore` stays `null` → today's plain
  orange button, no ring, no error surfaced.
- Malformed/unexpected payload shape → same silent fallback.

## Testing

- Unit test for `readinessRingColor`: 0% → orange-500 hsl, 100% → emerald-500
  hsl, monotonic hue between.
- Typecheck + `next build`.
- Manual: open the Payroll Wizard tab and confirm the ring appears colored for
  the current week; use a Readiness inline fixer, close the dialog, confirm the
  ring recolors; confirm a fetch failure leaves the plain orange button with no
  crash or toast.

## Out of scope

- No change to the score formula or to `PayrollReadinessGlance`.
- No change to the in-modal `ScoreGauge` (stays on the 3-band grade tone).
- No new API route or query param — reuses the existing endpoint as-is.
- No Realtime subscription/polling at the FAB level.
- No change to click-through behavior (still opens to the last-active tab).
