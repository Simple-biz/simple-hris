# Login sign-in songs (per person: Carla, Aliviah)

> **Status:** Carla's shipped 2026-07-30 (`eec5a4c` → `e499ab4` → `2967bf9` → `1ea603a` → `1f6fc03`).
> Aliviah's added 2026-10-07: code + cover art committed, **clip PENDING** (item 386). Per-person easter egg. No DB, no API, no migration.

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
| `aliviah@simple.biz` | Sidney Gish, "Impostor Syndrome" (*No Dogs Allowed*, 2017) | `public/sounds/aliviah-song.mp3`, **PENDING (not in the repo)** | `public/aliviah-song-thumb.jpg` (album art from Bandcamp, 600×600), no fallback |

Until Aliviah's clip lands, her sign-in plays **nothing and shows no toast**. That is the
missing-asset stand-down below, not a bug. The table matches emails exactly after trimming and
lowercasing, so `aliviahr@` or a trailing period does not match. Tests pin that.

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
- **Mute survives the reload** too.
- **Browser caveat:** after a genuine hard reload the fresh document has no user gesture
  yet, so autoplay may be held until their first tap. The toast then reads
  **"Tap anywhere for sound"** and resumes at the right offset.

## The clips

Every song serves a **~40-second cut**, never the full track. The player owns the 26→30s fade,
so a cut has **no baked fade-out**. A test caps any served clip at **1.5MB**. Carla's cut is
961,861 bytes and a full track is 3–6MB, so committing the whole song fails the suite.

**Carla's.** `public/sounds/carla-song.mp3` is a **40-second cut** of the licensed track, starting at
**2:43** (the final-chorus block), chosen by a per-second loudness sweep plus a
center-cancel vocal-presence analysis — it is the loudest sustained 30s of the song and
has no energy dips, so the very first second is full vocal rather than an instrumental
lead-in. Loudness-normalized to **−14 LUFS**, with a 0.3s anti-click fade-in and
deliberately **no baked fade-out** (the player owns the 26→30s fade; a baked one would
double-fade).

**Aliviah's: PENDING (item 386).** `public/sounds/aliviah-song.mp3` does not exist yet. Kane
supplies the purchased track; the session can't source the audio. Cut it the same way as
Carla's: per-second loudness sweep plus a vocal-presence check, pick the strongest sustained 30s
(the chorus), export 40s, loudnorm **−14 LUFS** / TP −1.5, 0.3s fade-in, **no fade-out**.
Commit only `aliviah-song.mp3`. Keep the raw purchased file **outside the repo**, for example in
Downloads. Nothing in `.gitignore` covers `public/sounds/`, and item 175 is what happens when a
raw track sits there.

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
| `src/lib/sound/carla-song.test.ts` | pins the gate (exact email, trim + case-fold only), each person's song, committed cover art, the 1.5MB clip cap |
| `src/components/common/CarlaSongToast.tsx` | now-playing toast + mute control + cover art, all read from the playing song's row |
| `app/layout.tsx` | mounts the toast on every document (this is what makes resume work) |
| `app/login/page.tsx` | starts the run at the intro hand-off |
| `public/sounds/carla-song.mp3`, `public/carla-song-thumb.jpg` | Carla's committed clip + cover art |
| `public/sounds/aliviah-song.mp3` (**PENDING**), `public/aliviah-song-thumb.jpg` | Aliviah's clip + cover art |

**Manual test:** dev server → super-admin sign-in as `carla@simple.biz` → intro video →
audio starts with the toast at the hand-off → switch dashboards mid-clip (keeps playing) →
fades out at 30s. Repeat as `aliviah@simple.biz` once her clip lands: Sidney Gish / *Impostor
Syndrome* with the *No Dogs Allowed* cover. Before then, expect silence and no toast.
