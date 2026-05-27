# System Diagnostics

*Added 2026-05-02. Admin-only health map for the Simple HRIS stack.*

A Supabase-schema-visualiser-style service map that probes the live system and surfaces failure modes (Supabase outage, stale Hubstaff imports, missing master-list data, audit-log starvation, etc.). Renders as a draggable React Flow diagram with relationship-aware edge animations, an alerts list, and per-node detail panels.

---

## Where it lives

| Layer | File |
|---|---|
| Route | `app/admin/page.tsx` — mounts when `activeTab === 'diagnostics'` |
| Sidebar entry | `src/components/admin/AdminSidebar.tsx` — `securityNav` array, `Radar` icon |
| Component | `src/components/SystemDiagnostics.tsx` |
| Live probes | `src/lib/admin/diagnostics-probes.ts` |
| Probe endpoint | `app/api/admin/diagnostics/route.ts` |

The feature is **admin-only** and is mounted exclusively in the Admin shell at `/admin`. The Accounting (`/accounting`), Manager (`/manager`), Employee (`/employee`), and Orphanage (`/orphanage`) shells do not import or reference `SystemDiagnostics` in any way.

> **TODO**: enforce full RBAC once admin auth gate is wired. Today the page-level admin gate is best-effort (sessionStorage email → `/api/employee-roles`), so secrets must stay out of this UI per the security rules.

---

## Data flow

```
                                 mount
SystemDiagnostics  ─── useState(buildMockDiagnostics()) ──▶ first paint (instant)
        │
        │ useEffect on mount
        ▼
fetch('/api/admin/diagnostics')                      ◀── auth gate (admin only)
        │
        │   parallel probes via Promise.all + 4s timeout
        ▼
DiagnosticsHealthResponse  { source: 'live', nodes, alerts }
        │
        ▼
setData(...) + setDataSource('live')
        │
        ▼
React Flow renders nodes + edges; alerts list populates;
header chip flips to "Live probes" (green)
```

On error (401/403/network), the client falls back to mock and surfaces an amber banner:

```
Live probe failed — showing mock baseline.  <Probe failed (HTTP 403)>
```

The chip in the header is the source-of-truth for "is this real":
- 🟢 **Live probes** — last successful fetch from `/api/admin/diagnostics`
- ⚪ **Mock data** — first paint OR last fetch failed

---

## Probes

| Node id | Probe | Source of truth | Status mapping |
|---|---|---|---|
| `admin-shell` | none — always healthy if the response renders | n/a | `healthy` |
| `payroll-wizard` | composite of `hubstaff-csv` + `master-list` + `disbursement-records` | derived | floor at `warning` (CSV mismatches stay subtle) |
| `rates` | `select count` on `employee_hourly_rates` | Supabase | `healthy` if count > 0 |
| `hubstaff-csv` | latest row from `hubstaff_uploads`, age | Supabase service-role | `healthy` < 7d, `warning` 7–14d, `warning` > 14d, `unknown` if empty |
| `master-list` | `select count` on `active_employees` view | Supabase service-role | `critical` if 0, `warning` if < 50, else `healthy` |
| `supabase-client` | `select head` on `app_settings`, latency | Supabase anon | `healthy` < 500ms, `warning` 500–2000ms, `critical` on error / timeout |
| `supabase-postgres` | shares the same probe as `supabase-client` | same | same |
| `pg-pool` | `SELECT 1` over a pg `Pool` (only when `DATABASE_URL` is set) | direct pg | `unknown` if env missing, `healthy` < 1500ms, `warning` slower, `critical` on connection error |
| `daily-report` | most recent `audit_log` entry where action LIKE `daily_reports.%` | Supabase service-role | `healthy` < 48h, `warning` 48h–N/A, `warning` if never |
| `auth-login` | recent login events from `audit_log` (24h window) | Supabase service-role | always `warning` until admin gate is enforced server-side; probe adds context |
| `audit-log` | most recent `audit_log` entry, age | Supabase service-role | `healthy` < 7d, `warning` if older or empty |
| `disbursement-records` | row count from `disbursement_records` | Supabase service-role | `healthy` if table reads |

Each probe runs with a **4-second timeout** via `withProbeTimeout()`. If a probe doesn't complete, it returns `critical` with `"Probe timed out."` so a hung Supabase doesn't stall the entire response.

Probes run **in parallel** via `Promise.all` — total wall-clock time is the slowest probe (capped at 4s).

### Composite statuses

The `payroll-wizard` node is derived from its dependencies:

```ts
const payrollStatus = [
  hubstaffProbe.status,
  masterListProbe.status,
  disbursementProbe.status,
].reduce(worseStatus, 'healthy');

// Warning floor — CSV mismatches are subtle, so we never let it look healthy.
status: payrollStatus === 'healthy' ? 'warning' : payrollStatus
```

So a `critical` upstream (e.g. master_list = 0) cascades to payroll-wizard, but a fully healthy upstream still shows `warning` for the payroll node — a deliberate hint that CSV / date-column mismatches deserve manual eyes.

---

## Service map (React Flow)

The diagram uses `@xyflow/react` v12 with **custom node and edge types** to mimic Supabase Schema Visualiser's aesthetic.

### Custom node — `DiagFlowNode`

A 280px-wide "schema card" with:
- A status-tinted **header** (icon + label + status pill)
- 4 **column rows** mimicking Supabase columns: `category` / `enum`, `status` / `status`, `summary` / `text`, `checked_at` / `timestamp`
- Left and right `Handle` anchors so edges connect to stable points

### Custom edges — relationship-aware animations

Each edge has one of 4 relationship types, classified by `relationshipFor(source, target)`:

| Relationship | Triggered by | Visual |
|---|---|---|
| **mount** | `admin-shell → *` | Slow flowing dashes (7s loop, 4s when critical). Reads as "this hosts that." |
| **flow** | `payroll-wizard → *` and other data-pipeline edges | Solid line + a colored particle traveling the path with a halo trailing it (3.4s loop, 2.2s when critical). Reads as "data is moving." |
| **query** | Anything → `supabase-client` / `supabase-postgres` / `pg-pool` | Fast flowing dashes (1.6s loop, 1s when critical). Reads as "live DB reads." |
| **event** | `auth-login → audit-log` | Particle bursts from source → target, fades, pauses 4s, fires again. Reads as "discrete event being logged." |

Edge stroke colour = max-of-endpoint-statuses (so a healthy→warning edge draws amber). Markers are arrow heads tinted to match.

A small **legend** floats in the bottom-right corner of the canvas with mini animated SVG samples of each edge type.

### Drag, layout persistence, and the twitch fix

- Cards are draggable (`draggable: true`); React Flow handles the geometry
- **Position persistence**: `localStorage["system-diagnostics-positions-v1"]` keyed by node id, written on `dragging === false` (drag-end) so we don't thrash storage during drag
- **Reset Layout** button in the diagram toolbar restores the curated `NODE_POSITIONS` template and clears localStorage. Disabled when the user is already at the template (`hasCustomLayout` check)

**Twitch mitigation** (the engineering tricky bit):

SVG `<animateMotion>` resets to t=0 every time its `path` attribute changes — and the path string changes 60×/sec during drag. Two fixes:

1. **Drop particles during drag.** `onNodeDragStart` → `setDragging(true)`; `onNodeDragStop` → `setDragging(false)`. The `dragging` flag is threaded through `flowEdges.data.dragging`. Edge components conditionally unmount their `<circle><animateMotion/></circle>` elements while dragging. On drag-stop they re-mount with the final path and animation starts cleanly.
2. **Move dash animations from inline `style.animation` to CSS classes.** Inline animation re-applies every render (style object reference changes). With the rule on `.sd-edge-mount > .react-flow__edge-path`, the declaration is set once and stays stable while only the path's `d` attribute updates.

A CSS `.sd-paused` class (toggled via the edge's `className` field) freezes dash flow with `animation-play-state: paused` during drag.

### Reduced motion

```css
@media (prefers-reduced-motion: reduce) {
  .react-flow__edge-path,
  .sd-particle-halo,
  .react-flow__edge circle[fill] {
    animation: none !important;
  }
}
```

Users with motion sensitivity see static edges, no particles, no dash flow.

---

## Security

Probes never return:
- Raw stack traces (errors trimmed via `trimError()` — strips newlines, caps at 120 chars)
- SQL text (no query strings echoed)
- Secrets (no env vars, no service-role keys, no `DATABASE_URL`)
- Employee PII (no emails, no names — only aggregate counts and ages)

Probes do return:
- Aggregate counts (`"42 active employees on roster"`)
- Latency timings (`"Round-trip 187ms"`)
- Ages of latest rows (`"Last upload 3d ago"`)
- PostgREST error codes (e.g. `42703`) — these are useful for admin diagnosis and aren't sensitive

The route handler enforces admin role server-side via `requireElevatedSession() && roles.includes('admin')`, so probe data is unreachable from non-admin sessions even if the client-side gate is bypassed.

---

## Extending

### Add a new node

1. Add an entry to `NODE_POSITIONS` in `SystemDiagnostics.tsx` with `{ x, y }` coordinates.
2. (Optional) Add edges to/from it in the `EDGES` array. The `relationshipFor()` classifier will assign an animation; tweak the classifier if your new relationship doesn't fit the existing 4 categories.
3. In the route handler (`app/api/admin/diagnostics/route.ts`), add a probe call and a node entry in the `nodes` array. Match the node `id` to your `NODE_POSITIONS` key.

### Add a new probe

1. In `src/lib/admin/diagnostics-probes.ts`, write an `async function probeFoo(): Promise<ProbeResult>` that returns `{ status, summary, details, suggestedChecks }`. Use `trimError()` on caught errors. Keep details under 3 lines. No PII, no SQL text.
2. In the route, add `withProbeTimeout(probeFoo(), fallback)` to the `Promise.all` and use the result in your node entry.

### Adjust a status threshold

Probes are pure functions — change the if/else thresholds in the relevant `probeFoo()` and the change shows up on the next refresh. No DB migrations required.

---

## Out of scope (parked)

- **Workspace Admin Directory sync** for filling Google photos before users log in. Documented in the conversation memory under "Path C" — service account + domain-wide delegation. Not built. Photo population happens organically via the JWT callback when each user signs in (see `src/lib/auth/auth-options.ts → persistGooglePhoto`).
- **Real-time updates**. The map polls on Refresh + auto-rolls timestamps every 60s, but doesn't subscribe to Supabase Realtime for status changes. If we add a `health_events` channel later, edges could animate in response to live alerts.
- **Historical health graphs**. Today's response is a snapshot; there's no time-series store for trends. Would require a `diagnostic_snapshots` table + a worker.
