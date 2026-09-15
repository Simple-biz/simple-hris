# Start Processing cue (Payroll Wizard + Payment Dispatch)

**Code:** `src/lib/sound/ping-chime.ts` (§ "Stage prepped" cue) ·
`src/components/PayrollWizard.tsx` · `src/components/payroll-clerk/PayrollDispatch.tsx` ·
`src/components/payroll/LockToggleConfirmDialog.tsx`
**Asset:** `public/sounds/jellyfish-jam.mp3`
**Memory:** [[start-processing-truckstart-mp3]] · [[carla-signin-song]]

This doc did not exist until 2026-09-15. The cue had shipped twice (synth V12 →
`truckstart.mp3` → `jellyfish-jam.mp3`) with its rules living only in a memory
entry and one audit-log line, which is why it is written down now.

## What it is

One sound, shared by the two surfaces that have a **Start Processing** button:
the Payroll Wizard and Payment Dispatch. Same action, same cue — deliberately.
Since 2026-09-15 that cue is SpongeBob's *Jellyfish Jam*.

`playStagePrepped()` / `holdStagePrepped()` / `stopStagePrepped()` are the whole
public API. Call sites never touch the AudioContext.

## Invariants

1. **One cue, both surfaces.** A change here lands on the Wizard *and* Dispatch.
   Splitting them was considered and rejected (Kane 2026-09-15, ruling 3a).
2. **It starts on the BUTTON CLICK, as the confirm modal opens** — not on the
   confirm inside it (Kane 2026-09-15; before that date it fired on confirm).
   Both are user gestures, so autoplay policy permits either.
3. **START only.** The same button stops processing; stopping is silent. The
   guard is `if (!lockState.locked)` at the click, on both surfaces.
4. **Confirm HOLDS, cancel KILLS.** The modal closes ~2s after confirm
   (`minShow` = 1600ms), and the cue is required to outlive it — Kane
   2026-09-15: *"for at least 10 seconds"*. So confirming calls
   `holdStagePrepped()`, after which `stopStagePrepped()` is a no-op for that
   run. Dismissing the modal never reaches the confirm handler, so the run stays
   unheld and the existing close effect fades it out in 450ms. The hold covers
   the **loading** window too (`stagePreppedLoading`): a confirm can land while
   the mp3 is still decoding, and the modal closing first must not cancel a run
   the operator already committed to. Protection is scoped to a run that exists
   or is still loading, so a hold left behind by a failed decode cannot silence
   a later stop.
5. **Every run is bounded at `STAGE_PREPPED_RUN_SECONDS` (12s), held or not.**
   Protection is never open-ended. A clip **shorter** than the window LOOPS up
   to it, so re-trimming the asset cannot silently drop the cue below the 10s
   floor; a clip **longer** is faded at it, so a held run cannot become minutes
   of music behind the UI. Both ends are enforced by the same constant plus a
   scheduled `src.stop()`, not by a caller remembering to stop.
6. **Never `withCtx`-queued.** `withCtx` defers a cue to the next gesture; music
   must never ambush someone on an unrelated later click. A locked context is
   just resumed and the clip plays from the top.
7. **Rapid re-trigger = 60ms fade kill, never layering.** `playStagePrepped()`
   calls `killEngine(0.06)` first and clears the held flag, so a previous run's
   protection can never block the next stop.
8. **Missing or undecodable asset = silent no-op.** The failed fetch/decode
   clears the cache so the next click retries.
9. **A generation token (`stagePreppedGen`) cancels a run still fetching or
   decoding** when the modal closes, so a slow first load can never start
   playing after the UI has moved on.

## The asset

Kane supplies the recording; the repo carries only the cut. This is the
[[carla-signin-song]] precedent — the full purchased/sourced track stays
untracked, a short normalized clip is committed. The engine fetches the whole
file before it can decode, so a multi-megabyte full track would leave the first
press of the day silent while it downloaded. Keep the committed cut small.

To swap the song: replace `public/sounds/jellyfish-jam.mp3`, or change
`STAGE_PREPPED_SRC`. To change how long it plays: `STAGE_PREPPED_RUN_SECONDS`
(and check invariant 5 still reads true). The retired synth V12 survives only as
a reference card in `references/sound-tester/sound-tester.html`;
`public/sounds/truckstart.mp3` is retired but left on disk.

## The broadcast — everyone else hears it too

Shipped 2026-09-15, same day, after a `blueprint` brief. When a clerk confirms
Start, every **other** open Payroll Wizard and Payment Dispatch pops
`StartProcessingBroadcastModal` and plays the same cue.

| Piece | File |
| --- | --- |
| Topic, payload, staleness rule (pure + tested) | `src/lib/payroll/start-processing-broadcast.ts` |
| Subscription + send | `src/hooks/useStartProcessingBroadcast.ts` |
| The modal | `src/components/payroll/StartProcessingBroadcastModal.tsx` |
| Peer cue | `playStagePreppedForPeer` / `stopStagePreppedForPeer` in `ping-chime.ts` |

10. **Its OWN topic, `payroll-start-processing`.** Never `payroll-wizard-follow`,
    `payment-dispatch-sync` or `payment-dispatch-paid`: realtime-js `channel()`
    returns the EXISTING channel for a repeated topic, so sharing one would let
    this hook's `removeChannel` tear down the wizard's follow mode or the
    dispatch queue's live sync. **Both surfaces share this one topic
    deliberately** — one cue for one action, the same ruling as invariant 1.
    A test pins the topic against all three.
11. **Broadcast, never `postgres_changes`** — the browser client is `anon` and
    the lock tables are RLS-protected, so row events never arrive
    ([[supabase-realtime-anon-rls-dead]]).
12. **A late arrival never hears it** (Kane 2026-09-15). Broadcast is not
    replayed, so the ordinary late joiner is handled by the transport — but a
    reconnecting or backgrounded tab *can* be handed a message after the fact,
    so `shouldAnnounceStart` also drops anything older than
    `START_CUE_WINDOW_MS`, judged at RECEIVE time. There is deliberately **no
    replay from lock state**: that would let the song fire on a page load, a
    failure class nobody asked for.
13. **`START_CUE_WINDOW_MS` must equal `STAGE_PREPPED_RUN_SECONDS`.** It is both
    the modal's auto-dismiss deadline and the staleness cutoff; drift leaves a
    peer in front of a silent modal or cuts the tail off the song. A test pins
    them together — do not change one alone.
14. **The operator never sees it.** The channel is `broadcast: { self: false }`,
    so they keep exactly the behaviour above; `shouldAnnounceStart` re-checks the
    sender anyway, because a second tab of the same person is a different client
    that `self: false` does not cover.
15. **Dismissible, and dismissing STOPS the song** (Kane, Q3) — the same contract
    Cancel already has. It also auto-dismisses at the window, so it cannot sit on
    top of the oversee/follow mirror spectators are there to watch.
16. **A peer's audio is attempted IMMEDIATELY** (Kane: *"this should sound right
    away"*), which works for anyone who has clicked anywhere on the page since it
    loaded. A tab that has never been touched is refused by the browser, and only
    then does the modal show "Tap anywhere for sound", arming a **scoped** one-shot
    unlock. This is not a hole in invariant 6: `withCtx` parks a cue on a module
    global indefinitely and fires it on the next unrelated click anywhere in the
    app, whereas this arm is owned by an open modal, advertised on screen, and torn
    down by `stopStagePreppedForPeer()` on dismiss **and** on unmount. Leaving that
    teardown to the dismiss handler alone would strand an armed listener — which is
    exactly the ambush invariant 6 exists to prevent. Precedent: `carla-song.ts`.
17. **Payload off the wire is untrusted.** `parseStartPayload` returns `null` for
    anything malformed and nothing is rendered from an unparsed message.
18. **START only, both surfaces.** Stopping processing is silent on every screen.

**Who hears it = who has the surface OPEN** (Kane, Q1). This is a broadcast, not a
notification: it reaches live pages, not people. Reaching everyone who *could* open
the wizard would need a notification type and a DDL, and is a different feature.
