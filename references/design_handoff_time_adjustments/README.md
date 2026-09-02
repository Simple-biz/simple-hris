# Handoff: Manager Time Adjustment Review Dashboard

## Overview
A manager-facing dashboard for reviewing employee time adjustment requests (missed tracker
time, offline work, other). Replaces a flat chronological "History" list with a review
workspace: KPI summary row, filter/search bar, a sortable request table with bulk actions,
and a detail panel for approving, declining, or forwarding a single request to accounting
for second approval.

## About the Design Files
The files in this bundle are **design references created in HTML** — a prototype showing the
intended look and behavior, not production code to copy directly. The task is to **recreate
this design in the target codebase's existing environment** (React, Vue, Blade, etc.) using
its established component library, routing, and data layer. The existing time-adjustment
business logic (submission, approval, second approver, accounting forwarding) already exists
in the product — only the UI layer changes.

`Time Adjustments.dc.html` is a small streaming-component format. Read it as plain HTML +
one JS class:
- markup lives between `<x-dc>` and the `<script data-dc-script>` block;
- `{{ name }}` holes are values returned by `renderVals()` in that script;
- `<sc-for list="{{ rows }}" as="row">` = a list map; `<sc-if value="{{ x }}">` = conditional.
Ignore `support.js` — it is only the runtime for the prototype.

## Fidelity
**High fidelity.** Colors, typography, spacing, rules and states are final and come from the
Modernist design system (`styles.css`, included). Recreate pixel-for-pixel using the
codebase's existing components where equivalents exist (button, tag/badge, table, input,
segmented control), and take every color/space value from the tokens listed below.

Sample records in the prototype are placeholder data. Field names map 1:1 to the real record
(see State Management).

## Screens / Views

### 1. Review workspace (single page, `/time-adjustments`)
**Purpose:** a manager triages every request assigned to them and decides on each one.

**Layout** (top to bottom, page is `min-height: 100vh`, flex column, background `#f3f2f2`):

1. **Header bar** — `.nav` class: flex row, `padding: 12px 16px`, `border-bottom: 2px solid
   var(--color-divider)`, sticky at `top: 0`, `z-index: 5`, background `--color-bg`.
   - Brand "Simple.biz" — `.nav-brand`, Archivo 800, 18px.
   - Nav links, 20px gap, 14px: Dashboard / **Time adjustments** (current: `#ec3013`, weight 600) /
     Timesheets / People.
   - Right side (`margin-left: auto`, 12px gap): muted `carla@simple.biz`, then a 30×30px
     square avatar, background `#ec3013`, letter in `--color-bg`, 12px/800, no radius.

2. **Page title block** — `padding: 24px 32px 8px`, flex row, wraps.
   - Kicker "MANAGER REVIEW" — 11px, `letter-spacing: .1em`, uppercase, `#ec3013`.
   - `<h2>` "Time adjustment requests" — Archivo 800, 32px, `letter-spacing: -.015em`.
   - Right (`margin-left: auto`, 8px gap): `Export CSV` (`.btn .btn-secondary`) and
     `Review oldest pending` (`.btn .btn-primary`). All button labels flush left.

3. **KPI row** — `margin: 12px 32px 0`, `border-top: 2px solid var(--color-divider)`,
   `display: grid; grid-template-columns: repeat(4, 1fr); gap: 2px`. Each cell:
   background `--color-surface` (#eae9e9), `padding: 16px`, `border-left: 2px solid
   var(--color-divider)` (omitted on the first cell). Each cell has:
   - label — 11px uppercase, `letter-spacing: .08em`, muted (55% ink);
   - value — Archivo 800, 34px, `line-height: 1.1`;
   - sub-line — 12px muted.

   | Cell | Label | Value | Sub |
   | --- | --- | --- | --- |
   | 1 | Pending your review | count of `status === 'pending'` (in `#ec3013`) | `{sum of hours} h requested` |
   | 2 | Awaiting second approver | count of `status === 'forwarded'` | Sent to accounting |
   | 3 | Decided last 30 days | count of decided | `{approved/decided}% approved` |
   | 4 | Median time to decide | e.g. `1.8 d` | Target: under 2 days |

   Only cell 1 uses the accent — it is the manager's actual to-do number.

4. **Filter bar** — `margin: 0 32px`, `border-top`/`border-bottom: 2px solid
   var(--color-divider)`, `padding: 12px 0`, flex row, 12px gap, wraps.
   - Search `.input`, flex `1 1 260px` capped at 340px, `padding-left: 30px`, Lucide `search`
     icon 15px absolutely positioned `left: 8px; top: 10px`, opacity .55.
     Placeholder: "Search employee, reason or note". Matches email + reason + note + request id,
     case-insensitive, live on every keystroke.
   - Status segmented control `.seg` / `.seg-opt` (native radios, hidden input, checked option
     fills `#ec3013` with `--color-bg` text): **All** · **Pending** · **Forwarded** ·
     **Approved** · **Declined**. All and Pending show a count at 60% opacity.
   - Reason `<select class="input">`, min-width 200px: All reasons / Forgot to start tracker /
     Worked offline or untracked / Other.
   - Pay period `<select class="input">`, min-width 150px: All periods / `2026-08` … `2026-04`.
   - `Clear` — `.btn .btn-ghost`, resets all four filters.

5. **Body** — `margin: 0 32px`, flex row: table column (`flex: 1`, min-width 0) + optional
   detail panel.

6. **Bulk action bar** — only when ≥1 row is checked. Above the table head:
   `padding: 10px 12px`, background `--color-accent-100` (#fff2ef),
   `border-bottom: 1px solid var(--color-divider)`. Left: `{n} selected` (13px bold).
   Right: `Approve` (primary), `Forward to accounting` (secondary), `Decline` (secondary),
   `Cancel` (ghost, clears the selection).

7. **Request table** — `.table`, `table-layout: fixed`, 14px. Header cells: 11px uppercase,
   `letter-spacing: .08em`, 60% ink, `padding: 8px`, `border-bottom: 2px solid divider`.
   Body cells `padding: 8px`, `border-bottom: 1px solid divider`. Row hover:
   `color-mix(in srgb, #201e1d 4%, transparent)`.

   | Col | Width | Content |
   | --- | --- | --- |
   | checkbox | 34px | row select, `accent-color: #ec3013`, 14×14 |
   | Employee | auto | 6px status dot + email (weight 600, ellipsis) |
   | Work date | 108px | muted, tabular numerals |
   | Reason | auto | single line, ellipsis |
   | Hours | 86px, right | bold, tabular, rounded to 2 dp + " h" |
   | Submitted | 108px | muted, tabular |
   | Status | 180px | status tag (below) |
   | action | 92px, right | ghost button: "Review" (pending) or "View" |

   Clicking any cell except the checkbox opens that request in the detail panel. The open row
   is marked `background: var(--color-accent-100)` plus
   `box-shadow: inset 2px 0 0 #ec3013`.

   Header checkbox toggles all currently *filtered* rows.

   **Status vocabulary** (dot color / tag class):
   - `pending` → "Pending review", `.tag .tag-outline` (1px `#ec3013` border, accent text), dot `#ec3013`
   - `forwarded` → "Forwarded to accounting", `.tag .tag-accent` (bg #fff2ef, text #7c1405), dot `--color-neutral-600`
   - `approved` → "Approved", `.tag .tag-neutral` (bg #f8f4f4, text #444141), dot `--color-neutral-400`
   - `declined` → "Declined by you", `.tag .tag-neutral`, dot `--color-neutral-400`

   Red is reserved for *pending* — the only state needing action. Resolved states are neutral.

   Below the table: `Showing {n} of {total} requests`, 12px muted.

8. **Empty state** — when the filters match nothing: `padding: 48px 12px`, left aligned.
   `<h4>` "No requests match these filters", 13px muted line "Try clearing the search or
   widening the period.", then a `Clear filters` secondary button.

9. **Detail panel** (right, only when a request is open) — `flex: 0 0 400px`,
   `border-left: 2px solid var(--color-divider)`, `padding: 16px 0 32px 20px`,
   `margin-left: 20px`, `align-self: flex-start`, `position: sticky; top: 74px`.
   - Head row: kicker "REQUEST TA-2412" (11px uppercase accent) + `<h4>` employee email;
     close `.btn .btn-icon .btn-secondary` with Lucide `x`, `margin-left: auto`.
   - Facts grid — 2 columns, 12px gap, `border-top: 1px solid divider`, `padding-top: 12px`:
     *Hours requested* and *Pay period* (Archivo 800, 22px), then full-width *Time window*
     (`9:00 AM – 10:30 AM · 2026-08-31`, tabular) and *Reason*. Each field has a 10px uppercase
     muted label.
   - *Employee explanation* — 14px, background `--color-surface`, `padding: 10px 12px`.
   - *Proof attached* — 150px block, background `--color-neutral-200`, 1px divider border,
     wrapped in `.grayscale`; the real screenshot/attachment renders here, with a
     `.tag .tag-neutral` chip bottom-left reading `Screenshot · {source}`. Never tint imagery.
   - *Decision trail* — one row per event, `grid-template-columns: 84px 1fr`, 10px gap,
     `padding: 6px 0`, hairline bottom rule: date (12px muted tabular) + `**who** what`.
     Covers submission, manager decision, and second approver in one chronology (this replaces
     the old separate "Manager decision" / "Second approver" blocks).
   - **Actions** — only when `status === 'pending'`: an optional note `<textarea class="input">`
     ("Note to the employee (optional)", min-height 64px), then a row with
     `Approve {hours} h` (primary, `flex: 1`) and `Decline` (secondary), then
     `Forward to accounting for second approval` (`.btn .btn-secondary .btn-block`).
   - **Resolved footer** — when not pending: the status tag plus a ghost
     `Retrieve request` button that returns the request to `pending`.

10. **Footer** — `margin-top: auto`, `border-top: 2px solid divider`, `padding: 14px 32px`,
    12px muted: `Developed by AI/API Team / Simple.biz © 2026`.

## Interactions & Behavior
- **Filters are AND-combined** and applied client-side in the prototype; in production apply
  them server-side (query params: `q`, `status`, `reason`, `period`) and keep them in the URL
  so a review session is shareable/back-navigable.
- **Search** filters live on input, no debounce in the prototype; debounce ~250 ms if server-side.
- **Row click** (any cell but the checkbox) opens the detail panel; the panel replaces the
  previous one without animation. Close with the `x` button (also wire `Esc`).
- **`Review oldest pending`** opens the oldest pending request in the panel — the intended
  "start working" entry point.
- **Bulk actions** apply to every checked row, append a trail entry, then clear the selection.
  In production, confirm destructive bulk declines and surface a toast with an undo.
- **Approve / Decline / Forward** in the panel mutate that one request's status and append a
  decision-trail entry dated today, attributed to the acting manager.
- **Retrieve** sets a resolved request back to `pending` (matches the existing "Retrieve" action).
- **Hover / active / focus**: do not restyle — they come from the design system. Focus is a
  `2px solid #ec3013` ring at `outline-offset: 2px`; button hovers step to `--color-accent-600`
  (primary) or a 7% ink tint (secondary).
- **Loading**: skeleton the table rows (7 rows) and the KPI numbers; keep the filter bar live.
- **Errors**: an action that fails should keep the row in its previous state and show an inline
  message in the detail panel above the action buttons, not a modal.
- **Responsive**: below ~1100px the detail panel should become a full-height right drawer over
  the table; below ~760px collapse the KPI grid to 2×2 and drop the Reason/Submitted columns.
- **No rounded corners anywhere** (`--radius-md: 0`). Do not soften the 2px rules.

## State Management
Prototype state (in `renderVals()` / `state`):

```
query: string          // search box
status: 'all' | 'pending' | 'forwarded' | 'approved' | 'declined'
reason: 'all' | <reason label>
period: 'all' | 'YYYY-MM'
checked: { [requestId]: boolean }   // bulk selection
openId: requestId | null            // detail panel target
data:   Request[]
```

Request record shape (map to the real model):

```
id         string   // "TA-2412", displayed as the request ref
email      string   // employee
workDate   'YYYY-MM-DD'
submitted  'YYYY-MM-DD'
reason     string   // one of the three reason labels
hours      number   // raw; ALWAYS display rounded to 2 dp + " h"
period     'YYYY-MM'
window     string   // "9:00 AM – 10:30 AM"
note       string   // employee explanation
proof      string   // attachment label/URL
status     'pending' | 'forwarded' | 'approved' | 'declined'
trail      [{ date, who, what }]
```

Derived values: pending count and hour sum, forwarded count, decided count, approval rate,
median decision time, filtered row list, `allChecked`, `selectedCount`.

Data fetching: one paginated list endpoint driven by the filter params, plus one detail
endpoint (or embed detail fields in the list payload — the panel needs window, note, proof and
trail). Actions are per-request POSTs plus a bulk variant.

**Fix carried over from the old UI:** raw hour values such as `4.566666666666666h` were printed
verbatim. Always round for display (`Math.round(h * 100) / 100`) and keep the raw value for
payroll math.

## Design Tokens
From `styles.css` (Modernist). Use the CSS variables, not the literals.

- Background `--color-bg` #f3f2f2 · Surface `--color-surface` #eae9e9 · Text `--color-text` #201e1d
- Accent `--color-accent` #ec3013 · Divider `--color-divider` = 40% #201e1d
- Accent ramp: 100 #fff2ef · 200 #ffe0d9 · 300 #ffc4b8 · 400 #ff9783 · 500 #ff563c ·
  600 #dd2b0f · 700 #ae1800 · 800 #7c1405 · 900 #4d170e
- Neutral ramp: 100 #f8f4f4 · 200 #eae7e7 · 300 #d7d3d3 · 400 #bab6b6 · 500 #9b9797 ·
  600 #7d7979 · 700 #605d5d · 800 #444141 · 900 #2d2b2b
- Spacing: 4 / 8 / 12 / 16 / 24 / 32 px (`--space-1…8`)
- Radius: **0px** at every step
- Shadows: sm `0 1px 2px rgba(45,43,43,.14)` · md `0 3px 10px rgba(45,43,43,.16)` ·
  lg `0 12px 32px rgba(45,43,43,.22)` — not used on this screen; nothing floats
- Type: Archivo 400/600/800 (Google Fonts). Body 15px/1.55. h2 32px, h4 20px, h5 16px;
  headings `letter-spacing: -.015em`, `line-height: 1.12`. Uppercase micro-labels 10–11px at
  `letter-spacing: .08–.1em`. Numeric columns use `font-variant-numeric: tabular-nums`.
- Muted text = `color-mix(in srgb, var(--color-text) 55%, transparent)`.
- Accent at body-copy size fails contrast — use `--color-accent-700` for paragraph text in red.

## Assets
- **Fonts:** Archivo from Google Fonts (imported at the top of `styles.css`).
- **Icons:** Lucide (`search`, `x` inline in the prototype). Use the codebase's Lucide package.
- **Images:** none shipped. The proof block is a placeholder for the employee's real uploaded
  screenshot; render it inside `.grayscale`.

## Files
- `Time Adjustments.dc.html` — the full prototype (markup + logic + placeholder data).
- `support.js` — prototype runtime only; not part of the design.
- `_ds/modernist-1d1ff938-fc63-49ec-8fc9-e1e921204ff7/styles.css` — the design system
  stylesheet: all tokens and component classes referenced above.
- `_ds/modernist-1d1ff938-fc63-49ec-8fc9-e1e921204ff7/readme.md` — the design system guide
  (rules on rules, flush-left labels, accent use, imagery).
- `original-ui.png` — screenshot of the UI being replaced, for reference.
