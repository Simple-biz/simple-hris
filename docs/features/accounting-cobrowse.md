# Accounting Co-Browse (Observe)

Live screen mirroring inside the Accounting dashboard. Building on the existing
**Accounting Collab Layer** (presence roster + section-scoped cursors/clicks),
co-browse lets one accountant **Observe** another and watch their actual screen in
real time -- modals opening, formulas being typed, scrolling -- not just cursors.

Code: `src/hooks/useCobrowse.ts`, `src/components/collab/CobrowseSurface.tsx`,
integrated in the shared `src/components/collab/CollabLayer.tsx` engine. The
Accounting dashboard mounts it via the thin wrapper
`src/components/accounting/AccountingCollabLayer.tsx` (from `src/App.tsx`).

**Now generalized (2026-06-30):** `CollabLayer` is dashboard-agnostic — it takes
its Realtime channel names, section-label map, and accent as props. The HR
dashboard has full parity via `src/components/hr/HrCollabLayer.tsx` (mounted from
`HrApp.tsx`) on its **own** room (`hr-collab` / `hr-cobrowse`, emerald accent),
so HR collaborators never mix with Accounting collaborators. `useCobrowse` takes
an optional `channel` (default `accounting-cobrowse`), so the CEO live-payroll
driver/observer and the standalone payroll-clerk driver are unaffected.

---

## 1. Driver / observer model

Every accounting client runs both halves over one Realtime channel:

- **Driver:** records its live DOM with rrweb -- but **only while at least one peer
  is observing**. Zero cost when nobody is watching.
- **Observer:** receives the driver's DOM event stream and replays it with rrweb's
  `Replayer` in `liveMode`, scaled to fit a full-screen overlay. **Passive only**
  -- the observer cannot interact with the mirrored page.

What the observer sees: the full DOM mirror -- modals/dialogs, live typing and
formula entry, scrolling -- plus the driver's section navigation (the observer's
view follows the driver's active tab). The driver's cursor/click ripples still
come through the separate collab layer, section-scoped.

---

## 2. Transport

- Channel: `accounting-cobrowse` (distinct from the collab layer's
  `accounting-collab`). Broadcast event: `cb`.
- Message types: `watch` / `unwatch` (observer announces target) and `ev`
  (chunked event batch from driver).
- **Chunking:** rrweb full snapshots exceed Realtime's broadcast size, so batches
  are JSON-stringified and split into 28,000-char chunks reassembled in order on
  the observer side. Batches flush ~every 80ms.
- **Heartbeat:** observer re-sends `watch` every 3s; driver prunes a watcher after
  9s of silence and stops recording when no watchers remain.
- rrweb sampling: mousemove 50ms, scroll 100ms, input "last", media 800ms; canvas
  recording + font collection disabled for performance.

---

## 3. The Observe button

Lives on the right-edge **avatar rail** in the Accounting page (rendered by
`AccountingCollabLayer`). Each peer avatar has:

- a main avatar button (toggles the name card), and
- an always-visible **eye badge** pinned to its corner.

Click the eye badge (or **Observe** in the name card) to start: orange eye + a
bold ring/glow on the avatar, and a full-screen mirror overlay
(`CobrowseSurface`) opens with an "Observing <name>" header and live/connecting
status. Click again (or the overlay's close button) to stop. Observing
**auto-stops** if the observed peer leaves Accounting.

---

## 4. Relationship to the Collab Layer

| | Accounting Collab Layer | Co-Browse (new) |
|---|---|---|
| Channel | `accounting-collab` | `accounting-cobrowse` |
| What's shared | presence roster + cursors/clicks (same-section only) | full DOM stream (rrweb) |
| Following | none -- you only see cursors on your own section | observer follows driver across tabs |
| Cost | always on | driver records on-demand only |
| Surface | floating avatars + remote cursors | full-screen mirror overlay |

Both run together: while observing you get the full screen mirror *and* the
driver's live cursor. See
[project_accounting_collab_layer](../../) memory and
`docs/reference/components.md` for the collab layer details.

---

## 5. Two-way tutoring chat + Admin Global Master List (2026-07-09/10)

The app-wide **"watch screen"** cobrowse (a second driver every authenticated
client runs on the shared `hris-cobrowse` channel, separate from the per-dashboard
`accounting-cobrowse` / `hr-cobrowse` drivers) is driven **only** from the
admin-gated **Admin → Global Master List**. While watching a person's real screen
from there, the admin can hold a **two-way tutoring chat** with them — a live
back-and-forth layered on top of the silent mirror.

Key files:

- [CobrowseProvider.tsx](src/components/presence/CobrowseProvider.tsx) — app-wide watch-screen driver/observer (`useWatchScreen`), full-screen mirror, and the **observer-side** docked chat window + reopen bubble.
- [CobrowseChatProvider.tsx](src/components/presence/CobrowseChatProvider.tsx) — the `hris-cobrowse-chat` Broadcast layer (`useCobrowseChat`) and the **driver-side** pop-up windows.
- [AdminGlobalMasterList.tsx](src/components/admin/AdminGlobalMasterList.tsx) — the GML surface: the Observe/watch button, the **Refresh** button, and the 15s telemetry tick.
- [PresenceProvider.tsx](src/components/presence/PresenceProvider.tsx) — `usePresenceRefresh` / `PresenceRefreshContext` (force-recompute the live presence roster).

### Stacking rule: the mirror MUST portal to `<body>` *(2026-07-30, `3bb0efa`)*

`CobrowseSurface` (`fixed inset-0 z-[120]`) renders **inside `<main>`**. When `isolate` was
added to `<main>` the previous day (`f3d2213`, to stop the collab avatar rail floating over
modal scrims), it trapped the mirror in main's stacking context — and the desktop sidebar
(`md:z-30` via `CollapsibleSidebarShell`, for its pull-tab) started painting **on top of** the
full-screen mirror's left edge.

The fix is inside `CobrowseSurface` itself: it **portals to `document.body`**, putting the
full-screen takeover back in the root stacking context. Doing it in the component covers all
three mounts at once — the Accounting/HR collab layers, the CEO live-payroll mirror, and the
admin watch-screen. Exit animations still work (AnimatePresence context crosses portals) and
the `rr-block` no-mirror-of-a-mirror guard still applies at body level.

> **The rule `isolate` establishes:** anything rendered **inside `<main>`** stays **under**
> body-level chrome (sidebar, dialogs) unless it **portals out**. Any new full-screen or
> floating surface mounted in `<main>` that must beat the sidebar or a modal needs the same
> treatment.
>
> An older note claimed portaling `CobrowseSurface` was "a refuted no-op". That was true for
> **sizing** (nothing was clipping it) — the `isolate` change is what made it matter for
> **stacking**. Don't conflate the two.
>
> Separate, still open: an **unlayered `*, *::before, *::after` transition rule** in
> `src/index.css` kills Tailwind transition utilities app-wide, and remote-cursor scroll drift
> in the mirror is unfixed.

### The chat — live-only, silent-watch-preserving

- **Docked window, admin side.** When the admin observes someone, `CobrowseProvider`
  docks a `CobrowseChatWindow` (`variant="observer"`, titled `Tutoring <name>`).
- **Pop-up appears on the watched screen only on the FIRST admin message.**
  `CobrowseChatProvider` opens a driver-side pop-up (`variant="driver"`, "…is helping
  you — reply here") for a peer only when a message for that peer actually arrives.
  A pure silent watch therefore stays silent — nothing surfaces on the watched
  person's screen until the admin types — matching the mirror's "they aren't
  notified" contract. Driver replies keep the driver's real name.
- **Nothing is persisted.** Threads live in memory for the session, keyed by the
  **other party's normalized email**; if the other side isn't connected when a
  message is sent, it's simply never received (same trust/delivery model as the
  Admin **Ping**). Chime feedback via `playPingChime` (receive) / `playPingSent`
  (send).

### Transport (`hris-cobrowse-chat`)

Its own Realtime Broadcast channel (`CHAT_CHANNEL`), `broadcast: { self: false }`,
distinct from both the mirror's `hris-cobrowse` and the presence `hris-presence`
channels. Two events:

| Event | Payload | Meaning |
|---|---|---|
| `msg` | `{ id, fromEmail, fromName, toEmail, text, ts }` (`ChatWire`) | a chat message; receiver dedupes to itself (`to === self`, `from !== self`) |
| `end` | `{ fromEmail, toEmail }` (`ChatEndWire`) | one side ended the chat; the other closes its window and clears the thread |

### Anonymized admin identity

The admin sends with `chat.send({ email, name }, text, { asName: 'Admin' })`, so the
outgoing `fromName` is the fixed label **"Admin"** — the staff member never sees the
admin's real name. `send`'s `opts.asName` override wins over the sender's session
name. Driver-side replies carry no such override, so the admin sees the staff
member's real name.

### Ending the chat (decoupled from the watch)

The admin can **End** the chat (× on the observer window, `closeTitle="End chat"`):
this calls `chat.terminate(observedEmail)`, which broadcasts `end` (clearing the
pop-up + thread on the watched person's side), clears the thread/unread on the admin
side, and drops any driver popup — then minimizes the admin's chat to a reopen
**bubble** (`chatOpen=false`; a `MessageCircle` FAB with an unread badge) **without
stopping the screen mirror**. Auto-cleanup: `observe()` calls `chat.terminate` for
the previous peer whenever the admin stops (`observe(null)`) or switches to a
different person, so a stale popup never lingers on someone's screen.

### GML live telemetry — Refresh, 15s tick, "Live" dot

- **Refresh button** (`RotateCw`, beside the Sync button). `handleRefresh` calls
  `refreshPresence()` (the `usePresenceRefresh` `resync`, which force-recomputes the
  online roster from the current `hris-presence` channel state) **and** bumps
  `statusTick` to re-fetch the DB-backed **last-seen** stamps
  (`/api/presence/last-seen?emails=…`) for the on-screen rows, refreshing relative
  times.
- **15s auto-telemetry tick.** A `window.setInterval` (`REFRESH_MS = 15_000`, paused
  while the tab is hidden, and it re-ticks on `visibilitychange` → visible) bumps
  `statusTick` so the offline "last seen" times stay fresh **without** pressing
  Refresh. Presence itself (who's online / which page) already streams live over
  `hris-presence`, so this tick only refreshes the last-seen layer.
- **Pulsing "Live" dot.** The **Online now** stat card carries an emerald
  `animate-ping` dot (title "Live — updating in real time") signaling the roster is
  updating in real time.
