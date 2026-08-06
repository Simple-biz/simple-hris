# CEO Live Dispatch: payment-confirmed sound per person paid

**Date:** 2026-08-06
**Status:** Approved

## Problem

The CEO's "Live payroll processing" modal (`CeoPayrollLive.tsx`) shows a
"Being paid now" feed (`PaymentsFeedRail`) that already pops in a new row the
moment a recipient is marked paid, but silently. The CEO wants an audible cue
per person paid while watching this view.

## Decisions (user-confirmed)

1. **Scope** — sound plays only while the Live Dispatch modal is open, not in
   the background whenever the CEO Overview page is loaded.
2. **Sound** — reuse the existing `playPaymentConfirmed()` cue
   (`src/lib/sound/ping-chime.ts`), the same one Accounting already hears on
   Mark Paid. No new cue is designed.
3. **Sound reference page** — `references/sound-tester/sound-tester.html`
   already lists "Payment Confirmed" as a card. Since this reuses that exact
   cue, extend its existing description to mention the CEO Live Dispatch feed
   as a second call site, rather than adding a duplicate card for an identical
   sound.

## Approach

Purely a presentation-layer effect inside `PaymentsFeedRail`, keyed off the
`payments.recent` prop it already renders. No changes to `usePaymentsLive`,
the API route, or the DB.

**Note (added during implementation):** `usePaymentsLive.ts` did end up
gaining one small addition beyond the above — a `recentHydrated: boolean`
field, set true only once a genuinely trustworthy snapshot has actually been
fetched, since `loading` alone can't reliably distinguish that from a
Realtime broadcast or a failed/erroring response. This was required to
correctly satisfy the "no replay of the existing backlog on open" behavior
below; it's purely additive and doesn't affect the hook's other consumer
(the CEO Overview KPI card).

- A `useRef<Set<string>>` tracks recipient emails already "seen."
- On the first effect run after mount, seed the set with every email
  currently in `payments.recent` and play nothing — opening the modal
  mid-cycle must not replay the existing backlog (up to 60 entries) as a wall
  of chimes.
- On every subsequent change to `payments.recent`, diff against the seen set.
  Each email not yet seen is a fresh payment: schedule `playPaymentConfirmed()`
  for it (staggered ~160ms apart per new arrival, so a burst that lands in one
  poll/refresh reads as a rapid cascade rather than a simultaneous chord), and
  add it to the seen set immediately (not after the timeout) so a re-render
  mid-stagger can't double-schedule the same email.
- Relies on `PaymentsFeedRail` only being mounted while the modal is open
  (standard Base UI `Dialog`/`DialogContent` behavior, no `keepMounted` in use
  here) — closing the modal unmounts it, clearing the ref; reopening re-seeds
  fresh with no sound for what's already in the feed.

## Error handling

None needed beyond what `playPaymentConfirmed()` already does (try/catch,
silent no-op if Web Audio is unavailable).

## Testing

Manual, matching how the app's other sound cues are validated (none have
unit tests — they're fire-and-forget browser audio side effects). Verify in
the sound reference page that the "Payment Confirmed" card's updated
description reads correctly, then verify in-app: open Live Dispatch, have a
payment marked paid, confirm one chime per new arrival and no chime replay of
existing feed entries on open.

## Out of scope

- Mute/volume control for this feed.
- Any change to the sound played on Accounting's own Mark Paid confirmation.
- A distinct/new sound cue for this call site.
