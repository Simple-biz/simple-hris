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
