# Carla's Jellyfish Jam bubble — a play button that floats in every 5 active minutes

While **`carla@simple.biz`** is signed in, a round bubble with a pink jellyfish on it floats in on
the right edge of the screen after every **5 minutes she is actively using the HRIS**. Pressing it
plays the whole *Jellyfish Jam* (2:31), and the bubble becomes a small player she can pause, resume
and close. It is a one-person easter egg, the sibling of her [sign-in song](./login-carla-song.md).
Nobody else ever sees it or arms anything. Built 2026-09-28 (session `9a92b2cd`, blueprint, no
NEEDS), pushed (`origin/main` = `0fa0b89d`, reflog 2026-09-29). No DB, no API, no migration.

## Key files

| Piece | File |
| --- | --- |
| Rules: active-time clock, phase machine, stored-state parser, email gate (pure, tested) | `src/lib/sound/carla-jam-clock.ts` · `carla-jam-clock.test.ts` |
| Engine: audio element, activity listeners, 1s ticker, per-tab persistence | `src/lib/sound/carla-jam.ts` |
| Bubble + player UI, inline SVG jellyfish | `src/components/common/CarlaJamBubble.tsx` |
| Mount (once, every document) | `app/layout.tsx`, beside `CarlaSongToast` |
| Asset (shared with the Start Processing cue) | `public/sounds/jellyfish-jam.mp3` |

## Who gets it

**A literal email match, never a role**, the same rule as the sign-in song
(`login-carla-song.md:11`). `isCarlaJamEmail` trims and case-folds, and a test pins it to the
sign-in song's `CARLA_SONG_EMAIL`. The component reads `useSession()`. Both sign-in paths put
Carla's address there, because the super-admin provider signs you in **as** the email
(`src/lib/auth/auth-options.ts:33`). So impersonating Carla is how to test it.

It never arms on `/login`. When the session is not Carla's (signed out, or someone else signed in
on the same tab), `disarmCarlaJam({ forget: true })` stops the song and wipes this tab's clock. A
different user never inherits her bubble.

## What "5 active minutes" means

- **Active = the tab is visible AND a pointer, key, wheel, scroll or touch event happened in the
  last 60s** (`CARLA_JAM_IDLE_AFTER_MS`). Reading a page without touching it counts for a minute.
  A tab left open with nobody at it earns nothing, so the bubble cannot pop on a tab left open
  overnight.
- The engine ticks every second. **One tick credits at most 2s** (`CARLA_JAM_MAX_TICK_MS`). A
  throttled or slept tab fires its next tick minutes late, and without the cap that single tick
  would credit the whole gap.
- **300s** of credit (`CARLA_JAM_ACTIVE_MS`) brings up the bubble.
- **The clock is per tab** (`sessionStorage` `carla_jam_bubble_v1`). Only the visible tab she is
  using earns time. Two tabs do not share one clock. That is deliberate: a shared clock would
  need cross-tab writes for a sound easter egg.

**This looks like a bug but isn't:** the bubble does not come every 5 wall-clock minutes. Idle
time, hidden tabs and the time the bubble or player is up all earn nothing.

## The bubble's lifecycle

`counting → offer → playing ⇄ paused → counting` (`reduceJamPhase`).

- **The 5 minutes restart only when the bubble closes**: ✕ on the bubble ("Not now"), ✕ on the
  player, the song ending, or a failed load. The clock is **frozen** while the bubble or the player
  is up. So bubbles never stack and never re-offer while she is listening.
- **An ignored bubble stays** until she presses play or ✕. It never auto-hides.
- An event that doesn't apply to the current phase is a no-op. A double click or a late `ended`
  cannot knock the machine sideways.

## Audio rules

1. **Audio starts ONLY from `playCarlaJam()`, i.e. from her click.** A tick never plays; a test
   pins that `carla-jam.ts` has exactly one `.play()` call, inside `playCarlaJam`. This is the
   Start Processing cue's "music never ambushes an unrelated click" rule
   (`start-processing-cue.md:78`) applied here: the bubble *offers*, it never plays on its own.
2. **A hard navigation brings a playing song back PAUSED** at its position (`restoredJamPhase`).
   A fresh document has no user gesture, so the browser would refuse autoplay anyway. A paused
   player that resumes silently would still break rule 1. The clock and a pending bubble survive
   too, and are written on every phase change, every 5s of new credit, on `pagehide`, and when
   the tab is hidden.
3. **Never two songs at once.** No bubble is offered while the Start Processing cue
   (`isStagePreppedActive()`) or the sign-in song is active. The clock can pass 5 minutes, and the
   bubble waits for the other song to end. If a Start Processing cue starts mid-jam, the jam
   **pauses** (`subscribeStagePrepped`). `ping-chime.ts` is only read, never changed.
   **This looks like a bug but isn't:** if she presses play herself *while* a cue is playing,
   both play. That was her explicit press, and stopping the cue from here would reach into the
   Start Processing surface.
4. **A failed load or play closes the bubble and restarts the clock.** The media element is
   dropped so the next bubble retries from scratch. A network blip heals on the next offer, and a
   missing asset costs a bubble that vanishes when pressed, never an error.
5. `HTMLAudioElement`, not Web Audio: pause and resume are native, and the whole song is never
   decoded to ~53MB of PCM (`start-processing-cue.md:75`).

## The asset is shared with the Start Processing cue

The bubble plays `public/sounds/jellyfish-jam.mp3`, the whole-song 64kbps re-encode (1,212,427
bytes) the [Start Processing cue](./start-processing-cue.md) already serves. There is no second
copy, and the browser caches one download for both. Both features' tests pin it at **≤ 1.5MB**. Never
point the bubble at the raw `jellyfish jam.mp3` (3.6MB). A test forbids it.

**Swapping the Start Processing cue to another song must not overwrite `jellyfish-jam.mp3`.**
That would silently change Carla's bubble too. Change `STAGE_PREPPED_SRC` to a new file instead.

## Placement

Right edge, vertically centred, **`z-[110]`**. Bottom-right holds Penny, the Payroll Notes FAB,
the tutorial chat head and the cobrowse button. Bottom-left holds the dispatch paid toasts,
top-centre the sign-in pill (`z-[200]`), and top-right the sonner stack. 110 floats above the
dashboard switch loader (100), so it stays visible while she switches dashboards. It sits below
the collab and cobrowse chrome (120/130).

Animations are transform/opacity only (the sign-in pill's rule, `login-carla-song.md:121`), and
all of them (arrival, bob, ripple, rising air bubbles, the playing wobble, the meter) are off
under `prefers-reduced-motion`. The jellyfish is an inline SVG because lucide has no jellyfish.
Its gradient id comes from `useId()` with every non-`[A-Za-z0-9_-]` character stripped, because
React 19's `«»` would break `url(#…)`. The credit reads "SpongeBob", not "SpongeBob
SquarePants", because the longer name truncates in the 20rem player.

## Deploy notes

**No migration.** No env vars, no n8n, no API. Nothing to run by hand.
Pushed (`origin/main` = `0fa0b89d`, reflog 2026-09-29). PENDING: deploy (Kane).

**Not clicked through signed in as Carla** by the building session. It was verified by 21 unit
tests, a clean typecheck, the dev server compiling and serving the bubble in the client bundle,
and a headless render of the bubble and player. The live sign-in was skipped because it runs
against production.

**Manual test without waiting 5 minutes:** sign in as `carla@simple.biz` (super-admin path). In
devtools run
`sessionStorage.setItem('carla_jam_bubble_v1', JSON.stringify({activeMs: 298000, phase: 'counting', positionSec: 0}))`,
reload, and move the mouse. The bubble floats in about 2s later. Press it, pause, reload
mid-song (it comes back paused at the same spot), then ✕.
