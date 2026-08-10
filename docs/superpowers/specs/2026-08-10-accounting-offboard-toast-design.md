# Accounting Dashboard: offboard toast with final-pay bank details

**Date:** 2026-08-10
**Status:** Approved

## Problem

When HR offboards someone, Accounting finds out passively — the leaver
eventually surfaces in the Payroll Notes FAB's "Offboarded" tab, but only if an
accountant happens to open the Payroll Wizard and click into it. Nothing tells
them it happened.

The thing Accounting actually needs at that moment is where the person's FINAL
paycheck should go. That data already exists: `/api/hr/offboard` freezes the
leaver's `employee_ids` rows into `app_settings` at offboard time
(`src/lib/hr/offboard-snapshot.ts`), because the live row dies with account
teardown or gets clobbered when the work email is recycled.

So: a live toast on the Accounting dashboard, the moment an offboard lands,
carrying who left and their masked final-pay bank routing.

## Decisions (user-confirmed)

1. **One toast, not two.** A single toast fires on offboard and carries the
   final-pay bank details. Accounting does NOT get a separate toast when an
   active employee self-updates their bank info — that already has a home in the
   People tab's "Bank changes" feed.
2. **Masked bank detail only.** Processor + bank name + last 4 of the account +
   a masked payout email. Never the full account number. This is parity with the
   existing rule stated in `PeopleBankChanges` ("Account numbers are never shown
   here — open a person in the roster to review their audited details"), and it
   matters because this toast can appear during a screen share.
3. **Smooth animation and a sound are explicit requirements**, not polish
   afterthoughts.

## Architecture

Five units, each with one purpose. Nothing here needs a DB migration — both the
pulse key and the bank snapshot live in the existing `app_settings` store.

### 1. Pulse key (transport)

Offboards have no realtime pulse today; bank changes do. Add one, mirroring
`pulseBankChanges` exactly:

- `OFFBOARDS_PULSE_KEY = 'hr.offboards.pulse'` and `pulseOffboards()` in
  `src/lib/supabase/app-settings.ts`.
- `POST /api/hr/offboard` calls it once after the batch's successes are known —
  **one bump per batch, not per person**, matching how that route already
  coalesces its webhooks.
- Best-effort and non-throwing, same posture as the other two pulses: a failed
  bump degrades to the client's 60s poll, it never fails the offboard.

**Why a pulse key rather than subscribing to `global_master_list` directly:**
the browser's anon Supabase client carries no user JWT, so RLS cannot scope that
table to Accounting — a direct subscription could leak leaver PII to any anon
websocket client. Only a timestamp rides the wire. This rationale is already
documented at length in `PeopleBankChanges.tsx` and is being followed, not
reinvented.

### 2. Bank summary module

New: `src/lib/hr/offboard-bank-summary.ts`

```ts
summarizeOffboardSnapshotBank(snapshot: OffboardSnapshot): OffboardBankSummary | null
```

Returns:

```ts
{ processor: string; bankName: string | null;
  accountLast4: string | null; payoutEmail: string | null }
```

Reuses `pickSnapshotIdRow`-equivalent selection, `resolveEffectivePayoutProcessor`
and `payoutDraftFromIdsRow` — the same primitives
`listOffboardedPayrollCandidates` uses — so the toast can never disagree with
what the Offboarded tab shows for the same person. Returns `null` when the
snapshot has no row that resolves a processor (i.e. the person had no payout
data on file), which the UI renders as an explicit warning state rather than
hiding.

Masking happens **here, server-side**. The full account number never enters the
API response, so it cannot leak via devtools or a client-side bug.

Masking rules, stated explicitly so the implementation cannot drift:

- `accountLast4` — the last 4 characters of the account number after stripping
  spaces and dashes. Fewer than 4 characters remaining → `null`, never a
  partial. Rendered as `···6614`.
- `payoutEmail` — first character of the local part, then `…`, then the last
  character of the local part, then the full domain: `kristine.m@gmail.com` →
  `k…m@gmail.com`. A local part of 2 characters or fewer is emitted as `…` plus
  the domain. The domain is never masked (it identifies the rail, not the
  person).
- `bankName` and `processor` are shown in full — neither is a secret, and both
  are what the accountant actually needs to route the payment.

### 3. Gated API route

New: `GET /api/accounting/recent-offboards?limit=8`, gated to accounting roles.

Returns newest-first: `name`, `workEmail`, `department`, `offBoardedAt`,
`offBoardedReasonLabel`, and `bank: OffboardBankSummary | null`.

**Why not reuse `GET /api/payroll-wizard/offboarded`:** that route is
hours-gated and week-scoped (`offboarded-payroll-candidates.ts`, the `eligible`
filter) — a person offboarded 20 seconds ago with no hours in the current cycle
is filtered out of it. That is exactly the person this toast exists to announce.
The two surfaces answer different questions and correctly have different filters.

The route DOES keep one filter from that module: `isEligibleForFinalPayReview`
excludes `temporary_pause`, since a suspension is not a departure and has no
final pay. This mirrors the Offboarded tab and the delete-vs-deactivate split in
`/api/hr/offboard`.

### 4. Client hook

New: `src/hooks/useOffboardAlerts.ts`, modeled on `useNotificationChime` with
one deliberate difference in the replay rule.

- **Silent baseline on first run per viewer.** A localStorage high-water mark
  (the `useMesaNewDeposits` pattern), keyed per viewer email. On a browser that
  has never run this hook, the current state is recorded and NOTHING toasts —
  otherwise a fresh login would fire the entire 90-day backlog. Only offboards
  after that point alert. This is the opposite of `useNotificationChime`'s
  `hw = 0` default, which is correct there (it collapses a backlog into one
  toast with a `+N` badge) but wrong here (each toast carries per-person bank
  data and cannot be collapsed without losing the point).
- **Three refresh paths**, matching `PeopleBankChanges`: realtime on the pulse
  key (450ms debounce), a 60s poll, and a tab-focus refetch. Realtime is the
  fast path; the poll is the guarantee.
- **A session-scoped id set** in addition to the high-water mark, so the same
  row arriving via both realtime and the poll toasts once.
- **Batch cap: one toast per person, up to 3**, then a single "+N more
  offboarded" summary toast. A 12-person queue offboard must not fire 12 toasts.
  Arrivals stagger ~160ms apart, matching the cascade approach already used for
  the CEO live-dispatch payment cue.

### 5. Toast component

New: `src/components/accounting/OffboardAlertToast.tsx`, rendered via
`toast.custom(..., { unstyled: true, position: 'top-right' })` into the
`<Toaster>` already mounted in `App.tsx`.

Content: reason chip, avatar, name, work email, department, then a "Final pay
routes to" block with the masked bank summary, and a CTA.

## Animation

Enter and exit are explicit CSS keyframes in a `<style jsx>` block on the card —
**deliberately not Tailwind `transition-*` utilities.** There is a known
outstanding issue in this app (recorded in the `collab-chrome-stacking-and-mirror-css`
notes) where an unlayered `*` transition rule kills those utilities on portaled
surfaces, and sonner portals its toasts. `CarlaSongToast` already solves the same
problem the same way.

- **Enter:** `opacity 0, translateY(-10px), scale(0.97)` → rest, over `0.42s`
  `cubic-bezier(0.22, 1, 0.36, 1)`. That exact curve and duration are already
  used by `carla-toast-in` and the `PeopleBankChanges` page transition, so the
  motion reads as house style rather than a one-off.
- **Transform and opacity only** — compositor-only, no per-frame layout work.
- **Auto-dismiss progress bar** driven by `scaleX` on a full-width element, not
  by animating `width` (the technique `CarlaSongToast` uses for its progress
  line, for the same reason).
- **`@media (prefers-reduced-motion: reduce)`** collapses the entrance to a
  plain opacity fade and freezes the progress bar.

## Sound

Add one cue, `playOffboardAlert()`, to the existing
`src/lib/sound/ping-chime.ts`. That module already owns a module-level shared
`AudioContext`, a one-time pointer/key unlock handler, and the `withCtx()`
helper that queues a cue requested while audio is still locked. The new cue is
~15 lines inside that established harness — no new sound module, and no binary
asset.

**Tone:** a soft **descending** two-note departure motif (≈660 Hz → 440 Hz sine,
with a low ≈220 Hz body, gentle exponential decay over ~0.5s), at a modest gain.
Descending is the point: every other cue in this app rises (`playPingChime` is a
rising sparkle, `playPaymentConfirmed` resolves upward, `playPingSent` sweeps
660→990 Hz). A departure should not sound like a confirmation.

Register it as a card in `references/sound-tester/sound-tester.html`, following
the convention set by the CEO live-dispatch sound spec.

**Explicitly NOT touching `useNotificationChime`.** It carries its own duplicate
AudioContext and unlock handler, and extracting that into shared code is genuine
cleanup — but it is unrelated to this feature, and the only thing it could
produce here is a regression in HR's bell. Left alone.

## CTA and navigation

The toast's action opens the Payroll Notes FAB's "Offboarded" tab, which is the
surface built for exactly this follow-up work (setting a leaver's final-pay rate
and bank).

That FAB only mounts on the Payroll Wizard tab and is additionally gated on
`wizardShown`, an animation-timing flag (`App.tsx`). A `CustomEvent` dispatch
would therefore race the mount and be dropped. Instead:

- The CTA writes `sessionStorage['hris.payrollNotes.openTab'] = 'offboarded'`
  and calls the existing `navigate('payroll-wizard')`.
- `PayrollWizardNotesFab` reads-and-clears that key on mount, opening itself to
  that tab.

No race, no new event plumbing, and it degrades to a no-op if the FAB never
mounts (e.g. the viewer lacks wizard visibility).

## Data flow

```
HR offboards
  → /api/hr/offboard
      → snapshotOffboardedBankInfo()   (already exists)
      → pulseOffboards()               (new)
          → app_settings row updated
              → Supabase Realtime → useOffboardAlerts (debounced)
                  → GET /api/accounting/recent-offboards   (auth-gated)
                      → summarizeOffboardSnapshotBank()    (masks server-side)
                  → new rows vs high-water mark?
                      → OffboardAlertToast + playOffboardAlert()
```

## Error handling

Every layer degrades rather than fails, matching the surrounding code:

- `pulseOffboards()` failing → no realtime nudge; the 60s poll still delivers
  the toast, just later. The offboard itself is never blocked.
- Realtime channel `CHANNEL_ERROR`/`TIMED_OUT` → `console.warn` naming the poll
  fallback, exactly as `PeopleBankChanges` does.
- API fetch failing → keep prior state, no toast, retry on next poll. Never
  advance the high-water mark on a failed fetch, or the missed offboards would
  be silently skipped forever.
- Snapshot missing or unparseable → `bank: null`, and the toast renders an
  explicit "No bank details on file" warning state. Silently omitting the block
  would read as "nothing to do", which is the opposite of the truth.
- Web Audio unavailable or locked → `withCtx` already no-ops or queues. The
  toast still appears; sound is never a prerequisite for the alert.
- localStorage unavailable (private mode) → fall back to the session-scoped id
  set. Alerts work for the session; they just re-baseline on reload.

## Testing

- **Unit:** `summarizeOffboardSnapshotBank` — masking correctness (last-4 only,
  never the full number), multi-row snapshot picking the row that resolves a
  processor, `null` for a snapshot with no payout data, and malformed input.
- **Unit:** the high-water/dedupe logic in `useOffboardAlerts` — first-run
  baselines silently, a new row alerts once, the same row via both realtime and
  poll alerts once, a failed fetch does not advance the mark.
- **Manual:** matching how this app's other sound and motion work is validated.
  Offboard a test person from HR with an Accounting dashboard open in a second
  window; confirm one toast, correct masked bank, one chime, smooth entrance,
  and that the CTA lands on the Offboarded tab. Then reload Accounting and
  confirm no replay. Verify the new sound-tester card plays.

## Out of scope

- A toast when an active employee self-updates bank info (decision 1).
- Any notification-panel or `employee_notifications` row — this is an ephemeral
  live alert; the Offboarded tab is the durable record.
- Any n8n/webhook change. Per the standing rule from the offboard delete-only
  routing work, automation is not touched without an explicit ask.
- Any DB migration.
- A mute/volume control for the cue.
- Refactoring `useNotificationChime`'s duplicate AudioContext.
