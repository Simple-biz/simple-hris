# Carla's Jellyfish Jam bubble

Brief: posted 2026-09-28 (blueprint, no NEEDS), session `9a92b2cd`. When **carla@simple.biz** is
signed in, a floating bubble with a jellyfish on it appears after every 5 minutes she is active in
the HRIS. Pressing it plays the whole Jellyfish Jam. She can pause, resume and exit. Client only.
No API, no table, no migration.

## Decisions (the brief's CHOSEN lines)

1. **Active = the tab is visible AND a pointer/key/wheel/scroll/touch event happened in the last
   60s.** 300s of that time brings up the bubble. A tab left open with nobody using it earns nothing.
2. **The clock restarts when the bubble closes** (✕, song ends, exit). It is frozen while the bubble
   is up and while the song plays or is paused.
3. **An ignored bubble stays** until play or ✕. It never auto-hides and never stacks.
4. **Whole song**, `public/sounds/jellyfish-jam.mp3`, the re-encode the Start Processing cue already
   serves (1,212,427 bytes, budget test ≤ 1.5MB). No second copy.
5. **Right edge, vertically centred, `z-[110]`**: above the switch loader (100), below the
   cobrowse/collab chrome (120/130) and the sign-in pill.
6. **Per-tab `sessionStorage` `carla_jam_bubble_v1`** keeps the clock and a pending bubble across a
   hard navigation. A song that was playing comes back **paused** at its position.
7. **Per-tab clock.** Only the visible tab she is using accumulates.

## Tasks

### Task 1: pure module `src/lib/sound/carla-jam-clock.ts`
- [x] constants: `CARLA_JAM_ACTIVE_MS` 300_000, `CARLA_JAM_IDLE_AFTER_MS` 60_000, `CARLA_JAM_MAX_TICK_MS` 2_000
- [x] `tickJamClock(clock, { now, lastInputAt, visible })` credits at most one capped tick while active
- [x] `reduceJamPhase(phase, event)`: counting → offer → playing ⇄ paused → counting
- [x] `parseStoredJam(raw)` / `restoredJamPhase(stored)`: malformed → null; playing restores as paused
- [x] `isCarlaJamEmail(email)`: literal match, trimmed + lower-cased
- [x] tests in `carla-jam-clock.test.ts` (node:test)

### Task 2: engine `src/lib/sound/carla-jam.ts`
- [x] module-level `HTMLAudioElement` + `useSyncExternalStore` store (carla-song precedent)
- [x] `armCarlaJam()` / `disarmCarlaJam()`: passive activity listeners, 1s ticker, stage-prepped subscription
- [x] no offer while the Start Processing cue or the sign-in song is active; a cue starting mid-jam pauses it
- [x] `playCarlaJam` / `pauseCarlaJam` / `toggleCarlaJam` / `closeCarlaJam` (one ✕ for bubble and player)
- [x] persistence on every phase change + every 5s of credit; a failed play/decode closes the bubble

### Task 3: UI `src/components/common/CarlaJamBubble.tsx`
- [x] gate: `useSession()` email is Carla's AND the path is not `/login`
- [x] offer: round play button with an inline SVG jellyfish + play badge, small ✕ to dismiss
- [x] player: pill with jellyfish, title, pause/play, ✕ exit, progress line (scaleX only)
- [x] reduced motion: no bob / wobble / ripple

### Task 4: mount
- [x] `app/layout.tsx`: `<CarlaJamBubble />` beside `<CarlaSongToast />`

### Task 5: docs, same commit
- [x] `docs/features/carla-jellyfish-bubble.md`
- [x] `docs/features/INDEX.md` row · `docs/README.md` row · `docs/reference/components.md` row
- [x] `docs/features/start-processing-cue.md`: the asset is now shared
- [x] memory `carla-jellyfish-bubble` + `MEMORY.md` pointer
