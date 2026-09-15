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

## Not covered here

Broadcasting this modal to every Payroll Wizard viewer (Kane, 2026-09-15) is a
**new** surface and has not been built. It goes through `blueprint`, not this doc.
