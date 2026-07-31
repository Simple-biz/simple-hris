# Login sign-in song (Carla only)

> **Status:** Shipped 2026-07-30 (`eec5a4c` → `e499ab4` → `2967bf9` → `1ea603a` → `1f6fc03`).
> One-person easter egg. No DB, no API, no migration.

When **`carla@simple.biz`** signs in, a 30-second audio clip plays right after the login
intro video hands off to her dashboard, with a now-playing toast at the top that she can
mute. It keeps playing while she switches dashboards **and across full page loads**, then
fades out and the toast slides away.

Anyone else signing in gets nothing — the gate is a literal email match, not a role.

---

## How the 30 seconds are guaranteed

The hard part was not the audio, it was that the login → dashboard hand-off can be a
**hard navigation**, which destroys module-level audio state.

- **The run is persisted per tab** (`sessionStorage`): start timestamp + mute state.
- **The toast mounts on every document** (wired in `app/layout.tsx`, triggered from
  `app/login/page.tsx`) and, if a run is in progress, **resumes playback at the correct
  offset** — so the fade still begins at **0:26** and the stop still lands at **0:30**
  *measured from the original start*, no matter how many navigations happen in between.
- **Mute survives the reload** too.
- **Browser caveat:** after a genuine hard reload the fresh document has no user gesture
  yet, so autoplay may be held until her first tap. The toast then reads
  **"Tap anywhere for sound"** and resumes at the right offset.

## The clip

`public/sounds/carla-song.mp3` is a **40-second cut** of the licensed track, starting at
**2:43** (the final-chorus block), chosen by a per-second loudness sweep plus a
center-cancel vocal-presence analysis — it is the loudest sustained 30s of the song and
has no energy dips, so the very first second is full vocal rather than an instrumental
lead-in. Loudness-normalized to **−14 LUFS**, with a 0.3s anti-click fade-in and
deliberately **no baked fade-out** (the player owns the 26→30s fade; a baked one would
double-fade).

> **Repo hygiene:** only the 40s clip is committed. The full purchased track and the
> alternate cuts in `public/sounds/carla-song-candidates/` (`A-final-chorus-163s` — the
> installed one, `B-chorus2-111s`, `C-chorus1-56s`) are **untracked and must stay out of
> the repo**. To switch cuts, copy a candidate over `carla-song.mp3` and commit that file
> only.

## Toast performance note

`CarlaSongToast` animates its level meters and progress bar via **transforms only**
(compositor-only, `e499ab4`) — no layout-triggering properties — because it renders during
the dashboard's heaviest mount.

## Files

| Path | Role |
|---|---|
| `src/lib/sound/carla-song.ts` | the player: eligibility gate, per-tab persisted run, resume-at-offset, 26→30s fade |
| `src/components/common/CarlaSongToast.tsx` | now-playing toast + mute control + cover art |
| `app/layout.tsx` | mounts the toast on every document (this is what makes resume work) |
| `app/login/page.tsx` | starts the run at the intro hand-off |
| `public/sounds/carla-song.mp3`, `public/carla-song-thumb.jpg` | the committed clip + cover art |

**Manual test:** dev server → super-admin sign-in as `carla@simple.biz` → intro video →
audio starts with the toast at the hand-off → switch dashboards mid-clip (keeps playing) →
fades out at 30s.
