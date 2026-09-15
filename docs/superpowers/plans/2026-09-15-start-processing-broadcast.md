# Start Processing broadcast — every open Payroll Wizard and Payment Dispatch hears it

**Approved brief:** in-session 2026-09-15. Kane's answers: Q1 = recommendation
(everyone with the surface OPEN), Q2 = "this should sound right away",
Q3 = dismissible, Q4 = "if they are late they shouldnt hear it",
Q5 = "yes payment dispatch to".

Q5 is a scope change from the posted brief: Payment Dispatch was `out:`. It is
now `in:`, and because Dispatch has no follow channel, both surfaces move onto
ONE new dedicated topic instead of the Wizard riding `payroll-wizard-follow`.
That is also the better shape — one cue, one rule, one modal, matching the
"one cue serves both Start Processing surfaces" ruling from this morning.

**Stack:** Next.js app router, client components, Supabase Realtime Broadcast,
existing `src/lib/sound/ping-chime.ts`, `node --import tsx --test`.

## Task 1 — the pure module

- [ ] `src/lib/payroll/start-processing-broadcast.ts`
  - `START_PROCESSING_TOPIC = 'payroll-start-processing'` — its OWN topic. Never
    `payroll-wizard-follow`, never `payment-dispatch-sync`, never
    `payment-dispatch-paid`: realtime-js `channel()` returns the EXISTING channel
    for a repeated topic, so sharing would let one hook's `removeChannel` tear
    down another's live sync.
  - `START_PROCESSING_EVENT = 'start'`
  - `START_CUE_WINDOW_MS = 12_000` — must equal the cue's run length.
  - payload `{ by: string; byLabel: string; at: number; surface: 'wizard' | 'dispatch' }`
  - `parseStartPayload(raw): StartProcessingAnnouncement | null` — anything
    malformed off the wire is dropped, never rendered.
  - `shouldAnnounceStart(msg, selfEmailLower, nowMs): boolean` — false when the
    message is your own, when `at` is missing, and **when it is older than
    `START_CUE_WINDOW_MS`**. That last clause is Kane's Q4 answer made
    enforceable: a reconnect or a slow tab can deliver a stale message, and a
    late arrival must not hear it.
- [ ] `src/lib/payroll/start-processing-broadcast.test.ts`
  - topic is not any of the three existing topics (pinned, like `dispatch-paid-toast.test.ts`)
  - own message is dropped
  - a message `START_CUE_WINDOW_MS + 1` old is dropped
  - a message just inside the window announces
  - malformed payloads parse to null

## Task 2 — the peer cue

- [ ] `src/lib/sound/ping-chime.ts` — add `playStagePreppedForPeer(): Promise<boolean>`
  - Resolves `true` when the sound is audible now, `false` when the browser
    refused it. The caller renders the affordance on `false`.
  - It plays IMMEDIATELY when the AudioContext is running — which it is for
    anyone who has clicked anywhere on the page since load, i.e. nearly every
    real spectator. That is Kane's "should sound right away".
  - When the context is suspended it arms a **scoped** one-shot pointer/key
    unlock. This does NOT weaken invariant 6 (never `withCtx`-queued): `withCtx`
    queues a cue indefinitely on a module-global and fires it on the next
    unrelated click. This arm is owned by an open modal, is advertised on screen
    ("Tap anywhere for sound"), and MUST be torn down by
    `disarmStagePreppedPeer()` when the modal closes. Precedent: `carla-song.ts`.
- [ ] `disarmStagePreppedPeer()` — removes the listeners and stops the cue.
      Called on dismiss and on unmount. Without it the arm is an ambush.

## Task 3 — the hook

- [ ] `src/hooks/useStartProcessingBroadcast.ts` (`'use client'`)
  - Subscribes once per `selfEmail`; `broadcast: { self: false }` so the operator
    never receives their own message and keeps exactly today's behaviour.
  - Returns `{ announceStart, announcement, dismiss }`.
  - Applies `shouldAnnounceStart` with `Date.now()` at receive time.

## Task 4 — the modal

- [ ] `src/components/payroll/StartProcessingBroadcastModal.tsx`
  - Third person: "<name> is starting payroll". Reuses the visual language of
    `LockToggleConfirmDialog`'s `PreparingScene` (orange orb, breathing dots) —
    a new design here would be a defect.
  - **Dismissible** (Q3), and dismissing STOPS the song — the same contract the
    operator's Cancel already has.
  - Auto-dismisses at `START_CUE_WINDOW_MS`, so it cannot sit on top of the
    oversee/follow mirror that spectators are there to watch.
  - Renders "Tap anywhere for sound" only when the cue reported blocked.

## Task 5 — wire both surfaces

- [ ] `src/components/PayrollWizard.tsx` — `announceStart` beside the existing
      `holdStagePrepped()` / `broadcastLockAcquired()` on the START branch only;
      mount the modal.
- [ ] `src/components/payroll-clerk/PayrollDispatch.tsx` — same.
- [ ] START only, both surfaces. Stopping processing stays silent.

## Task 6 — verify + document

- [ ] `npm test` (the new test file) and `npx tsc --noEmit`
- [ ] extend `docs/features/start-processing-cue.md`, its INDEX row, and replace
      memory `start-processing-broadcast-blueprint-pending` with the shipped entry
- [ ] one commit, staged by explicit path

## Deploy notes

**No migration.** No table, no column, no notification type, no n8n import — the
message is transient Broadcast. Nothing for Kane to run.
