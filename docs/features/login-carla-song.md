# Login sign-in songs (per person: Carla, Aliviah)

> **Status:** Carla's shipped 2026-07-30 (`eec5a4c` → `e499ab4` → `2967bf9` → `1ea603a` → `1f6fc03`).
> Aliviah's added 2026-10-07; player hardened and her clip installed the same day (item 386). Per-person easter egg. No DB, no API, no migration.

When a person listed in **`SIGNIN_SONGS`** (`src/lib/sound/carla-song.ts`) signs in, a 30-second
clip of **their** song plays right after the login intro video hands off to their dashboard, with
a now-playing toast at the top that they can mute. It keeps playing while they switch dashboards
**and across full page loads**, then fades out and the toast slides away.

Anyone not in the table gets nothing — the gate is a literal email match, not a role.

Sibling: [carla-jellyfish-bubble.md](./carla-jellyfish-bubble.md), a Jellyfish Jam play bubble
every 5 active minutes, Carla only, same root-layout mount. It never offers while a sign-in song plays.

## Who gets which song

Until 2026-10-07 this was Carla only. Kane added Aliviah that day (*"lets have aliviah@simple.biz
accounts opening song as Imporstor Syndrome by sydney gish"*). Anyone else is added the same way:
one `SIGNIN_SONGS` row, its own clip and its own cover art. The pinning test is
`carla-song.test.ts`.

| Email | Song | Clip | Cover art |
|---|---|---|---|
| `carla@simple.biz` | Anri, "I Can't Stop The Loneliness" (1983) | `public/sounds/carla-song.mp3` (installed) | `public/carla-song-thumb.jpg`, `.svg` fallback |
| `aliviah@simple.biz` | Sidney Gish, "Impostor Syndrome" (*No Dogs Allowed*, 2017) | `public/sounds/aliviah-song.mp3` (installed) | `public/aliviah-song-thumb.jpg` (album art from Bandcamp, 600×600), no fallback |

Each row's clip is `installed` (the cut is committed) or `pending` (it is not). A pending row
is inert: the player fetches nothing, plays nothing, shows **no pill**, and logs a console
warning naming the missing file. A new person's row stays `pending` until their cut is committed.
No real row is pending today, so class 1's test below uses its own table.

Before the hardening, Aliviah's row on `ce1d5cd4` pointed straight at a missing file, and the
player raised the pill before it knew the audio had loaded. She saw *"Now playing · Impostor
Syndrome"* over silence until the 404 came back. This was reproduced in headless Chromium on
2026-10-07, and is class 1 and class 2 below.

The table matches emails exactly after trimming and lowercasing, so `aliviahr@` or a trailing
period does not match. Tests pin that.

---

## How the 30 seconds are guaranteed

The hard part was not the audio, it was that the login → dashboard hand-off can be a
**hard navigation**, which destroys module-level audio state.

- **The run is persisted per tab** (`sessionStorage` key `carla_song_run_v2`): start timestamp,
  mute state and **whose song** it is. A stored run whose email is not in the table, or that has
  no email, is dropped and never resumed. That covers the v1 key, which had none.
- **The toast mounts on every document** (wired in `app/layout.tsx`, triggered from
  `app/login/page.tsx`) and, if a run is in progress, **resumes playback at the correct
  offset** — so the fade still begins at **0:26** and the stop still lands at **0:30**
  *measured from the original start*, no matter how many navigations happen in between.
- **The 30 seconds start when sound does.** A fresh run re-anchors its start to the moment
  audio actually begins, so a slow load never shortens it. A resume is placed by the wall clock
  *when sound begins*, so a slow load never stretches it past 0:30.
- **A resume seeks before it plays.** `currentTime` is set before `play()`, so a hard-nav resume
  starts at its offset, not at 0:00 with a jump. If a browser ignores the early seek, it is
  corrected once sound starts (more than 0.75s off).
- **Mute survives the reload** too.
- **Browser caveat:** after a genuine hard reload the fresh document has no user gesture
  yet, so autoplay may be held until their first tap. The toast then reads
  **"Tap anywhere for sound"** and resumes at the right offset.

## How it can fail, and what stops it

Hardened 2026-10-07 after Kane's *"harden it please it doesnt play properly"*. Each class has a
test in `carla-song-engine.test.ts`, which drives the player with a fake audio element and a fake
clock. Each guard was removed in turn to confirm its test then fails.

| # | Failure | Guard |
|---|---|---|
| 1 | A listed person whose cut is not committed: pill over silence | `pending` rows are inert, with a console warning. `carla-song.test.ts` fails if a row's status disagrees with the disk, either way |
| 2 | Pill says "Now playing" before any audio exists, so a 404, slow or undecodable clip flashes it | Status is `starting` until `play()` resolves. The pill renders only on `playing` or `blocked` (`isCarlaSongPillVisible`) |
| 3 | An element that failed to load is reused, and every later start fails instantly | A load or play error logs with `console.error` and drops the element, so the next start builds a fresh one |
| 4 | Stop or finish while `play()` is pending, then a late resolve brings back a "playing" run nobody can see stopped | Every start and finish bumps a run number. A settled `play()` from an older run does nothing |
| 5 | A hard-nav resume blips from 0:00 before jumping to its offset | Seek before `play()` (above) |
| 6 | A slow load shortens a fresh run or stretches a resume past 0:30 | Re-anchor or re-place when sound begins (above). A resume whose window ran out while loading never plays |
| 7 | A different person signs in while the last person's run is live, and they inherit that song | Any sign-in that is not the run's owner stops the run. The same owner again is a no-op, because the hand-off can fire twice. Every `signOut()` is a hard navigation to `/login` today, which also drops the run, but the player no longer relies on that |
| 8 | The jam bubble misses the new `starting` state and offers a second song | It calls `isCarlaSongActive()`, which counts `starting` |

## The clips

Every song serves a **~40-second cut**, never the full track. The player owns the 26→30s fade,
so a cut has **no baked fade-out**. Tests hold every row to the disk: an `installed` cut must
exist and be **≤1.5MB**, and a `pending` one must **not** exist. Carla's cut is 961,861 bytes
and a full track is 3–6MB, so committing the whole song fails the suite.

**Carla's.** `public/sounds/carla-song.mp3` is a **40-second cut** of the licensed track, starting at
**2:43** (the final-chorus block), chosen by a per-second loudness sweep plus a
center-cancel vocal-presence analysis — it is the loudest sustained 30s of the song and
has no energy dips, so the very first second is full vocal rather than an instrumental
lead-in. Loudness-normalized to **−14 LUFS**, with a 0.3s anti-click fade-in and
deliberately **no baked fade-out** (the player owns the 26→30s fade; a baked one would
double-fade).

**Aliviah's.** `public/sounds/aliviah-song.mp3` is a **40-second cut** starting at **1:44.95**, the
second chorus, installed 2026-10-07.
- **Source:** Kane supplied `Sidney Gish - Impostor Syndrome (Lyrics).mp3`. It is 294.5s, which
  matches Bandcamp's 294.3s, so it is not sped up. It is about 120 kbps, a lyric-video rip rather
  than the Bandcamp download. That is lower fidelity, but fine for a 30s clip.
- **Finding the chorus:** a per-second loudness sweep, a mid/side vocal-presence check, and a
  chroma repetition map.
  - The section that repeats most strongly starts at **0:38.4**: loudness −20 → −15 dB, vocal
    presence 8 → 24.
  - It comes back at **1:45.2** (similarity 0.78), and each pass lasts about 29s.
  - Chorus 2 was picked because it is fuller than chorus 1. Its 30-second run is wall-to-wall,
    −13 to −16 dB every second, with no dips.
- **The cut:** −14.2 LUFS integrated, true peak −1.7 dBFS, 192 kbps, 961,767 bytes, metadata
  stripped, 0.3s fade-in, no fade-out.
- **Alternates** live **outside the repo** in `C:\Users\Kane\Downloads\aliviah-song-candidates\`:
  - `A-chorus2-104.95s` is the installed one.
  - `B-chorus1-38.15s` is the first chorus.
  - `C-section-170.65s` is the loud new section at 2:50. It is not the chorus.

  To swap, copy one over `aliviah-song.mp3` and commit that file only. The raw track stays in
  Downloads. Nothing in `.gitignore` covers `public/sounds/`, and item 175 is what happens when a
  raw track sits there.

**Adding a person.** Their row starts `pending`. Cut their clip the same way (strongest sustained
30s, export 40s, loudnorm **−14 LUFS** / TP −1.5, 0.3s fade-in, **no fade-out**). Commit only the
cut, and in the same commit flip the row's `clip.status` to `'installed'`. The suite fails until
the row and the disk agree.

> **Repo hygiene:** only each person's 40s clip should be committed. The full purchased track and the
> alternate cuts in `public/sounds/carla-song-candidates/` (`A-final-chorus-163s` — the
> installed one, `B-chorus2-111s`, `C-chorus1-56s`) **must stay untracked and out of
> the repo**. To switch cuts, copy a candidate over `carla-song.mp3` and commit that file
> only.
>
> **The repo is out of compliance with that rule — they are tracked today** (item 175,
> measured 2026-09-29 with `git ls-files public/sounds`): the full track
> `public/sounds/ANRI - I Can't Stop The Loneliness.mp3` and all three candidates were
> committed by `69073939` (2026-07-30). No code reads any of them. The rule stands; see
> [start-processing-cue.md](./start-processing-cue.md) § *The asset* for the sibling case.

## Toast performance note

`CarlaSongToast` animates its level meters and progress bar via **transforms only**
(compositor-only, `e499ab4`) — no layout-triggering properties — because it renders during
the dashboard's heaviest mount.

## Files

| Path | Role |
|---|---|
| `src/lib/sound/carla-song.ts` | the player: `SIGNIN_SONGS` table (the gate), per-tab persisted run, resume-at-offset, 26→30s fade |
| `src/lib/sound/carla-song.test.ts` | pins the gate (exact email, trim + case-fold only), each person's song, committed cover art, clip status vs disk, the 1.5MB cap |
| `src/lib/sound/carla-song-engine.test.ts` | the player under a fake audio element and fake clock: one test per failure class above |
| `src/components/common/CarlaSongToast.tsx` | now-playing toast + mute control + cover art, all read from the playing song's row |
| `app/layout.tsx` | mounts the toast on every document (this is what makes resume work) |
| `app/login/page.tsx` | starts the run at the intro hand-off |
| `public/sounds/carla-song.mp3`, `public/carla-song-thumb.jpg` | Carla's committed clip + cover art |
| `public/sounds/aliviah-song.mp3`, `public/aliviah-song-thumb.jpg` | Aliviah's committed clip + cover art |

**Manual test:** dev server → super-admin sign-in as `carla@simple.biz` → intro video →
audio starts with the toast at the hand-off → switch dashboards mid-clip (keeps playing) →
fades out at 30s. Repeat as `aliviah@simple.biz`: Sidney Gish / *Impostor Syndrome* with the
*No Dogs Allowed* cover, starting on the second chorus.

**Verified 2026-10-07 in headless Chromium**, using the real player bundle and the real clips.
The harness ran from the session scratchpad and is not committed:
- Carla's fresh start goes `starting → playing` and is 1.97s in after 2s.
- Carla's resume at 10s is at 10.00 the moment it plays.
- A 404 clip never shows the pill, and logs the error.
- A pending row requests nothing. This was checked before Aliviah's cut was installed.
- Carla's full run is 30.02s from first sound to done.
- Aliviah's sign-in reaches `playing` showing *Impostor Syndrome / Sidney Gish*, and is 1.95s
  further on after 2s.
- Aliviah's resume at 12s is at 12.00 the moment it plays, and her full run is 30.02s.
- Carla's sign-in still plays her own clip.

**Not verified** through the real login flow, signed in.
