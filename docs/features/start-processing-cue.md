# Start Processing cue (Payroll Wizard + Payment Dispatch)

**Code:** `src/lib/sound/ping-chime.ts` (§ "Stage prepped" cue) ·
`src/components/PayrollWizard.tsx` · `src/components/payroll-clerk/PayrollDispatch.tsx` ·
`src/components/payroll/LockToggleConfirmDialog.tsx`
**Asset:** `public/sounds/jellyfish-jam.mp3`
**Memory:** [[start-processing-jellyfish-jam]] · [[start-processing-broadcast]] · [[start-processing-truckstart-mp3]] · [[carla-signin-song]]

This doc did not exist until 2026-09-15. The cue had shipped twice (synth V12 →
`truckstart.mp3` → `jellyfish-jam.mp3`) with its rules living only in a memory
entry and one audit-log line, which is why it is written down now.

## What it is

One sound, shared by the two surfaces that have a **Start Processing** button:
the Payroll Wizard and Payment Dispatch. Same action, same cue — deliberately.
Since 2026-09-15 that cue is SpongeBob's *Jellyfish Jam*, and since 2026-09-25 it
is the **whole song** (2:31). Kane: *"it needs to play the whole song unless the
modal is being closed."* Until then every run was cut at 12s.

`playStagePrepped()` / `holdStagePrepped()` / `releaseStagePrepped()` /
`stopStagePrepped()` drive a run; `prefetchStagePrepped()` warms the bytes;
`isStagePreppedActive()` + `subscribeStagePrepped()` report whether a run is
loading or audible. Call sites never touch the AudioContext.

## Invariants

1. **One cue, both surfaces.** A change here lands on the Wizard *and* Dispatch.
   Splitting them was considered and rejected (Kane 2026-09-15, ruling 3a).
2. **It starts on the BUTTON CLICK, as the confirm modal opens** — not on the
   confirm inside it (Kane 2026-09-15; before that date it fired on confirm).
   Both are user gestures, so autoplay policy permits either.
3. **START only.** The same button stops processing; stopping is silent. The
   guard is `if (!lockState.locked)` at the click, on both surfaces.
4. **Confirm HOLDS, cancel KILLS.** The modal closes ~2s after confirm
   (`minShow` = 1600ms), and the cue is required to outlive it. Kane
   2026-09-15: *"for at least 10 seconds"*; 2026-09-25: *"the whole song"*. So
   confirming calls `holdStagePrepped()`, after which `stopStagePrepped()` is a
   no-op for that run. Dismissing the modal never reaches the confirm handler,
   so the run stays unheld and the existing close effect fades it out in 450ms.
   The hold covers the **loading** window too (`stagePreppedLoading`): a confirm
   can land while the mp3 is still decoding, and the modal closing first must
   not cancel a run the operator already committed to. Protection is scoped to a
   run that exists or is still loading, so a hold left behind by a failed decode
   cannot silence a later stop. A stop clears `stagePreppedLoading` together
   with the generation it cancels (before 2026-09-25 a cancelled load left it
   stuck `true`).
   **A FAILED Start releases the hold** (`releaseStagePrepped()` in both
   surfaces' `catch`, 2026-09-25). The confirm dialog stays open on a failure,
   so the run goes back to its pre-confirm state: Cancel kills it, a retried
   Confirm holds it again. Without this a failed Start would play the whole
   song, unstoppable, for a processing run that never began.
5. **Every run is bounded both ways, held or not, and between the bounds it is
   the whole clip** (Kane 2026-09-25). `stagePreppedRunSeconds(clip)` = `clip`
   clamped to [`STAGE_PREPPED_MIN_SECONDS` = 12, `STAGE_PREPPED_MAX_SECONDS` =
   180]. A clip **shorter** than the floor LOOPS up to it, so re-trimming the
   asset cannot silently drop the cue below the 10s Kane asked for on
   2026-09-15. A clip **longer** than the ceiling is faded at it, so a held run
   can never become ten minutes of music behind the UI. The installed track
   (151.5s) sits between them and plays in full, ending on its own; the 1.2s
   fade tail applies only when the run CUTS the audio (loop boundary or
   ceiling). Both ends are enforced by the constants plus a scheduled
   `src.stop()`, not by a caller remembering to stop. **What changed on
   2026-09-25:** the ceiling was 12s and is now 180s, by Kane's ruling on Open
   item 174 Q1. A held operator run now plays 2:31 with **no stop control** once
   the confirm dialog has closed (Open item 208).
   **The decoded buffer is never cached**, because the whole song is ~53MB of
   PCM. Only the compressed bytes (1.2MB) are cached; each run decodes its own
   copy (~0.25s) and releases it when it ends.
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

Kane supplies the recording. The raw purchased/sourced track **stays untracked**,
and the app serves a **small re-encode**, never the raw file. This is the
[[carla-signin-song]] precedent. The engine fetches the whole file before it can decode, so a
multi-megabyte track would leave the first press of the day silent while it
downloaded. Keep the served file small: a test pins it at **≤ 1.5MB**
(`start-processing-broadcast.test.ts`).

Since 2026-09-25 the served `public/sounds/jellyfish-jam.mp3` is the **whole
song**: 151.5s, re-encoded from Kane's `jellyfish jam.mp3` (192kbps, 3,637,008
bytes) to 64kbps stereo with a 0.15s fade-in and two-pass linear loudnorm to
I=-14 / TP=-1.5. That gives **1,212,427 bytes at a measured -14.41 LUFS**, matching
the 14s cut it replaced (224,998 bytes, -14.39 LUFS). Mono was tried and
rejected: the downmix peaked at -0.29 dBTP, over the -1.5 target. The bytes are
also **prefetched**: `StartProcessingBroadcastModal` is mounted (closed) on both
surfaces and calls `prefetchStagePrepped()` 1.5s after mount, so they are
already there when anyone clicks Start or receives a broadcast. The
[[carla-signin-song]] precedent (`carla-song.mp3`, 961,861 bytes) is the same
shape.

**The "stays untracked" half of that rule is not what the repo does — measured
2026-09-22.** Both full tracks are committed at HEAD: `public/sounds/jellyfish
jam.mp3` (3,637,008 bytes, added by `9c674472` on 2026-09-15, the same commit as
the cut) and `public/sounds/ANRI - I Can't Stop The Loneliness.mp3` (6,330,964
bytes); nothing in `.gitignore` covers `public/sounds/`. Neither path is read by
any code (`STAGE_PREPPED_SRC` is the hyphenated cut, `carla-song.ts` its own
cut), so **no fetch and no first-press latency is affected** — the cost is ~10MB
in the repo and in every deploy bundle. The rule above stands; the repo is out
of compliance with it. Open item 175. **Re-measured 2026-09-25:** still true.
The served hyphenated file is now the whole-song re-encode (1,212,427 bytes),
the raw `jellyfish jam.mp3` is still unread by any code, and it is still
committed.

To swap the song: replace `public/sounds/jellyfish-jam.mp3` (within the tested
budget), or change `STAGE_PREPPED_SRC`. It plays for its own length between
`STAGE_PREPPED_MIN_SECONDS` and `STAGE_PREPPED_MAX_SECONDS`. Check that
invariant 5 still reads true and that the ceiling does not cut the new song.
The retired synth V12 survives only as a reference card in
`references/sound-tester/sound-tester.html`;
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
    `START_CUE_WINDOW_MS` (**12s**), judged at RECEIVE time. There is
    deliberately **no replay from lock state**: that would let the song fire on
    a page load, a failure class nobody asked for.
13. **The staleness cutoff is NOT the song's length. They were split on
    2026-09-25.** Until then `START_CUE_WINDOW_MS` had to equal the run (12s).
    When Kane ruled the whole song in, stretching the cutoff to 2:31 would have
    let a tab that reconnects two and a half minutes late start the song from
    the top, which breaks invariant 12. So the cutoff stays **12s** (a test pins
    the exact value) and the peer modal follows the song itself instead:
    `shouldCloseStartModal` closes it only when **both** the 12s window has
    passed **and** `isStagePreppedActive()` is false. It can neither close
    mid-song nor sit in front of silence; an untapped tab or a missing asset
    still gets exactly the old 12s. `START_MODAL_MAX_MS` (window + ceiling + 10s
    = 202s) is the hard stop, so a lost `ended` event can never strand it. The
    engine notifies at the END of each transition, never inside one, so a
    re-trigger never flickers "inactive" at the modal.
14. **The operator never sees it.** The channel is `broadcast: { self: false }`,
    so they keep exactly the behaviour above; `shouldAnnounceStart` re-checks the
    sender anyway, because a second tab of the same person is a different client
    that `self: false` does not cover.
15. **Dismissible, and dismissing STOPS the song** (Kane, Q3), the same contract
    Cancel already has. **It stays up for the whole song** (Kane 2026-09-25:
    *"it needs to play the whole song unless the modal is being closed"*).
    Before that date it auto-closed at 12s so it would not sit on top of the
    oversee/follow mirror; now a spectator who wants the mirror back closes it,
    and that stops the song. The sr-only description says so.
15a. **It names who started it in full** (Kane 2026-09-25: *"the modal should
    also show the person who started it"*). Below the first-name headline, a
    **Started by** row renders `startedByLine`: full name · account email. The
    payload carries `byName` (the session's full name). `parseFullName` rejects
    an email (impersonation sessions set `name` to one), collapses whitespace
    and caps it at 80 chars. A sender on an older build sends no `byName` and
    the row falls back to the first name, never blank.
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
