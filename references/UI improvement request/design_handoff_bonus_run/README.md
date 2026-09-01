# Handoff: Monthly Production Bonus Entry

## Overview
A single-screen internal tool for entering monthly production KPIs per sub-team, resolving employee team assignments, and locking the run so it can be sent to accounting. One supervisor works through it once a month: enter accuracy, record count and bonus pool for each of six color-named teams; fix any employees who are unassigned or on the wrong team; then lock.

The screen's central design job is **making "done vs. not done" unmistakable at a glance** — that was the user's stated pain with the original.

## About the Design Files
The files in this bundle are **design references created in HTML** — prototypes showing intended look and behavior, not production code to copy directly. `Bonus Run.dc.html` uses a proprietary template runtime (`<x-dc>`, `{{ }}` holes, `<sc-for>`, `<sc-if>`, a `Component extends DCLogic` class). **Do not try to port that runtime.** Read it as a spec: the logic class maps 1:1 onto ordinary React state + derived values, and the template maps onto JSX.

Recreate the design in the target codebase's existing environment (React, Vue, SwiftUI, native, etc.) using its established patterns, component library and styling approach. If no environment exists yet, choose the most appropriate framework and implement there.

Runtime translation notes:
- `renderVals()` is a derived-state function called on every render — everything it returns is either a plain value, a style string, or an event handler. In React, compute the same values in the component body.
- `<sc-for list as="x">` is `.map()`. `<sc-if value>` is `{cond && ...}`.
- Style strings assembled in the logic class exist only because the runtime requires inline styles. **In a real codebase, convert them to CSS classes / styled components / Tailwind.** They are documented below as values, not as an implementation instruction.

## Fidelity
**High-fidelity.** Colors, typography, spacing, motion and interaction states are final and specified exactly below. Recreate the UI faithfully using the codebase's existing libraries and patterns.

Two caveats where the design is a placeholder for real business rules:
1. **Bonus tier thresholds and multipliers are invented** (90/95/98% → 50/75/100% of pool). Replace with the real rule.
2. **Employee list and KPI values are sample data.**

## Screens / Views

There is one screen. It has five stacked regions, top to bottom.

### 1. Header
- **Purpose**: identify the run, show the running total, hold the terminal action.
- **Layout**: `display:flex; align-items:flex-end; justify-content:space-between; gap:32px; padding:20px 28px 16px;` with `border-bottom:1px solid var(--line)`.
- **Left cluster** (`flex-column; gap:2px`):
  - Kicker: "Production bonus · monthly run" — Archivo Narrow, 12px, `letter-spacing:.14em`, uppercase, `--mute`.
  - Title: the period, e.g. "August 2026" — Archivo, 30px, weight 800, `letter-spacing:-.02em`, `line-height:1.1`.
- **Right cluster** (`flex; align-items:center; gap:20px`):
  - Total payout block, right-aligned: label "Total payout" (Archivo Narrow, 11px, .14em, uppercase, `--mute`) over the value (24px, weight 800, `font-variant-numeric:tabular-nums`).
  - A 2px-wide vertical `--line` divider, `align-self:stretch`.
  - **Theme toggle button**: pill (`border-radius:999px`), 40px tall, `padding:0 16px`, 1px `--line` border, transparent fill, label "Light"/"Dark" (Archivo Narrow 12px/600/.12em/uppercase).
  - **Primary action button**: pill, 40px tall, `padding:0 20px`, no border, label left-aligned (`text-align:left`), Archivo Narrow 13px/700/.1em/uppercase.
    - Enabled: `background:var(--accent)`, `color:#fff`, `cursor:pointer`, label "Lock & send to accounting".
    - Disabled: `background:var(--line)`, `color:var(--mute)`, `cursor:not-allowed`.
    - After locking: label "Locked", stays disabled.

### 2. Status strip / team tab bar
- **Purpose**: the completion overview AND the team tab control. This is the screen's answer to "which teams are done?".
- **Layout**: `display:flex; align-items:center; flex-wrap:wrap; gap:10px 20px; padding:12px 28px; background:var(--sunk); border-bottom:1px solid var(--line);`
- **Counter block** — `flex:none; white-space:nowrap;` `padding-right:20px`, `border-right:1px solid var(--line)`. Reads "3 / 6" (20px, weight 800, tabular-nums) + "teams entered" (Archivo Narrow 12px/.12em/uppercase/`--mute`). *The `flex:none` and `nowrap` are load-bearing — without them this block collapses into a vertical stack at narrow widths.*
- **Tab group** — `flex:1 1 auto; min-width:0; display:flex; flex-wrap:wrap; gap:8px;` contains the six team tabs. This group is the element allowed to give when space is tight.
- **Team tab** (button, one per team): pill, 28px tall, `padding:0 12px`, `gap:7px`, `flex:none; white-space:nowrap`, 1px `--line` border, `--surface` fill, Archivo Narrow 12px/600/.12em/uppercase. Contains, in order:
  1. a 9px round dot in the team color (or `--line` when the team is untouched and not selected),
  2. the team name,
  3. a status mark: `✓` (`--ink`) when complete, `!` (`--accent`) when partial, `–` (`--mute`) when empty.
  - **Selected tab**: `border-color` = team color, `background: color-mix(in srgb, <team> 22%, var(--surface))`, plus `box-shadow: inset 0 0 0 1px <team>` to thicken the ring.
  - Untouched, unselected tabs dim their text to `--mute`.
- **Unassigned warning** (only when count > 0) — `flex:none; white-space:nowrap`, an 8px round `--accent` dot + "N unassigned employees" in `--accent`, Archivo Narrow 12px/600/.1em/uppercase.

### 3. Team card (one at a time, driven by the selected tab)
- **Purpose**: enter the three KPIs for the selected team and see the resulting payout.
- **Container**: `padding:24px 28px 28px`, inner `display:grid; grid-template-columns:minmax(0,620px); gap:20px` — i.e. the card is capped at 620px wide and flush left.
- **Card shell**: `border-radius:16px; overflow:hidden; background:var(--surface); border:1px solid <mix>; border-top:5px solid <team>;`
  - Complete/partial: border is `color-mix(in srgb, <team> 65%, var(--line))`, top bar is the full team color, and the card carries `box-shadow: 0 1px 2px rgba(0,0,0,.05), 0 8px 20px -12px rgba(0,0,0,.18)`.
  - Untouched: border and top bar both `--line`, **no shadow**. The card visibly recedes.
- **Card header row**: `flex; justify-content:space-between; padding:12px 16px; border-bottom:1px solid var(--line)`.
  - Left: 12px round team swatch, team name (Archivo Narrow 15px/700/.16em/uppercase), member count (Archivo Narrow 12px/.06em/`--mute`, e.g. "4 members").
  - Right: **status badge**, a pill at `padding:3px 11px`, Archivo Narrow 11px/700/.14em/uppercase:
    - `✓ Entered` — solid team-color fill. Label color is `#201e1d` for the light fills (yellow, green, orange) and `#fff` for blue, purple, red.
    - `Incomplete` — transparent, 1px `--accent` border, `--accent` text.
    - `Not started` — transparent, 1px `--line` border, `--mute` text.
- **Field grid**: `display:grid; grid-template-columns:repeat(auto-fit,minmax(160px,1fr)); gap:14px 16px; padding:18px 20px`. Three fields, each a `flex-column; gap:5px` label + control.
  - Field labels: Archivo Narrow 11px/.14em/uppercase/`--mute`.
  - Control shell: `border:1px solid var(--line); border-radius:10px; background:var(--sunk)`. Input text is 16px/600, tabular-nums, transparent background, no border of its own, `padding:9px 10px`.
  - **Accuracy** — decimal input with a trailing `%` adornment in `--mute`. Input needs `min-width:56px` so the value can't clip.
  - **Records** — integer input.
  - **RFC pool, pooled** — currency input with a leading `₱` adornment. Below it, a helper line (Archivo Narrow 11px, `--mute`) that recomputes live: `"1,240 records × ₱250 = ₱310,000"`, or `"₱250 per record"` when records is empty.
- **Card footer**: `flex; align-items:flex-end; justify-content:space-between; padding:12px 16px; border-top:1px solid var(--line); background:var(--sunk)`.
  - Left: a **three-segment tier meter** — three 26×5px rounded bars, `gap:3px`, filled in the team color up to the achieved tier, `--line` beyond. Under it the tier label (Archivo Narrow 12px/600/.08em/uppercase): "Tier 3 · 100% of pool", "Below 90% · no bonus", or "Awaiting accuracy" (`--mute`) when accuracy is blank.
  - Right: **per-member payout**, 22px weight 800 tabular-nums in the team color (or `--mute` "—" when not computable), over the caption "per member" (Archivo Narrow 10px/.14em/uppercase/`--mute`).

### 4. Roster
Sits **below** the card as a full-width section, separated by `border-top:1px solid var(--line)`.

- **Filter bar**: `flex; align-items:center; gap:10px; padding:14px 20px; border-bottom:1px solid var(--line)`. Leading label "Roster" (Archivo Narrow 11px/.14em/uppercase/`--mute`), then eight filter chips: All, the six teams, Unassigned.
  - Chip: pill, `padding:5px 12px`, `gap:6px`, 1px `--line` border, transparent, Archivo Narrow 11px/600/.1em/uppercase, with a trailing count at `opacity:.65` tabular-nums.
  - Active chip: border transparent, fill = team color (or `--ink` for All, `--accent` for Unassigned). **Foreground must be derived from the fill, not hard-coded white**: `#201e1d` on yellow/green/orange, `#fff` on blue/purple/red and on Unassigned, and `var(--app-bg)` on All (so it inverts correctly in dark mode).
- **Bulk-assign bar** (only when ≥1 row is checked): `padding:10px 20px`, `background: color-mix(in srgb, var(--accent) 10%, transparent)`, `border-bottom:1px solid var(--line)`. Reads "N selected · assign to →" followed by seven outline pills (Unassigned + six teams, each bordered in its own color) and a right-aligned underlined "Clear".
- **Table header**: `display:grid; grid-template-columns:34px 1fr 190px 110px; gap:12px; padding:8px 20px; border-bottom:1px solid var(--line)`. Select-all checkbox, "Employee", "Sub-team", right-aligned "Share". Archivo Narrow 11px/.14em/uppercase/`--mute`.
- **Scroll area**: `overflow:auto; max-height:46vh`.
- **Row**: same 4-column grid, `padding:9px 20px`, `border-bottom:1px solid var(--line)`.
  - Checkbox, `accent-color: var(--accent)`.
  - Name (14px/600, `letter-spacing:-.01em`) over email (12px, `--mute`); both single-line with ellipsis overflow.
  - Sub-team cell: a 10px round team dot + the **custom dropdown** (see below).
  - Share: right-aligned 13px/600 tabular-nums, `--ink` when computable else `--mute` "—".
  - Checked row: `background: color-mix(in srgb, var(--accent) 8%, transparent)`.
  - **Unassigned row: `box-shadow: inset 3px 0 0 var(--accent)`** — a red left edge marker.
- **Footer line**: "N of M shown", `padding:10px 20px`, `border-top:1px solid var(--line)`, Archivo Narrow 11px/.1em/uppercase/`--mute`.

#### The sub-team dropdown
Native `<select>` with all browser chrome removed. Reproduce exactly:
- Wrapper: `position:relative; display:block; flex:1; min-width:0;` with `color` set to the team color (or `--mute` when unassigned) so the chevron inherits it.
- Select: `appearance:none; -webkit-appearance:none; width:100%; border-radius:999px; padding:6px 30px 6px 12px; text-overflow:ellipsis;` Archivo Narrow 12px/600/.1em/uppercase.
  - Assigned: `border:1px solid color-mix(in srgb, <team> 60%, var(--line))`, `background: color-mix(in srgb, <team> 18%, var(--surface))`, text `--ink`.
  - Unassigned: `border:1px solid var(--line)`, `background:var(--surface)`, text `--mute`.
- Chevron: a 14×14 Lucide `chevron-down` SVG, `stroke="currentColor"`, `stroke-width:2.5`, absolutely positioned `right:10px; top:50%; margin-top:-7px`, `pointer-events:none`, `opacity:.55`.
- `option` elements are re-set to normal case, `letter-spacing:0`, 13px, on `--surface`/`--ink` (browsers otherwise inherit the uppercase tracking into the popup).
- Hover: `filter:brightness(1.04); border-color:currentColor`.

### 5. Footer status bar
`flex; padding:10px 28px; border-top:1px solid var(--line); background:var(--sunk)`, Archivo Narrow 12px/.1em/uppercase/`--mute`.
- Left: save state — "✓ Saved 2 min ago · draft", or "🔒 Locked · sent to accounting".
- Right: **the blocker explanation** — "All checks passed", or `"Blocked: 3 teams missing KPIs · 3 unassigned"`. This is why the primary button is disabled; never disable the button without printing the reason here.

## Interactions & Behavior

- **Tab switch**: clicking a team tab swaps the card. Clicking the already-active tab is a no-op (must not re-trigger the animation).
- **KPI entry**: every keystroke recomputes team completeness, tier, per-member payout, the header total, the counter, the tab marks, and the roster Share column.
- **Team completeness** is derived, never stored: `complete` when all three fields are non-blank AND numerically > 0; `empty` when all three are blank/zero; `partial` otherwise.
- **Row assignment**: changing a row's dropdown moves that person; counts, per-member shares and the unassigned warning all recompute.
- **Bulk assign**: check rows → bar appears → click a target pill → all checked rows move and the selection clears.
- **Select-all** toggles the entire roster (not just the filtered view).
- **Lock**: enabled only when all six teams are complete and zero employees are unassigned. Locking is terminal in the prototype — button becomes "Locked", footer switches to the locked message.
- **Roster filter** is independent of the selected tab. (Open question — see below.)

### Animation
- Card entry on tab switch: `opacity 0→1` and `translateY(6px)→0` over **300ms `cubic-bezier(.2,.7,.3,1)`**. In React, key the card by team id so it remounts and replays.
- Card border-color and box-shadow: **260ms** `cubic-bezier(.2,.7,.3,1)` — the color cross-fades rather than snapping when the tab changes.
- Descendant color transitions inside the card: **240ms ease** on background-color, color, border-color.
- All buttons/selects/inputs: **180ms** `cubic-bezier(.2,.7,.3,1)` on background-color, border-color, box-shadow; **120ms** on transform; color 180ms ease.
- Button hover `translateY(-1px)`; active `translateY(0) scale(.98)`.
- Roster row hover: **140ms ease** to `color-mix(in srgb, var(--ink) 5%, transparent)`.
- `@media (prefers-reduced-motion: reduce)` collapses every duration to 1ms. Required.

### Focus & accessibility
- `:focus-visible { outline: 2px solid var(--accent); outline-offset: 2px; }` on every input, select and button. Never the browser default.
- The tab bar should be built as a real tablist (`role="tablist"` / `role="tab"` / `aria-selected`, arrow-key navigation) — the prototype uses plain buttons and does not implement roving focus.
- Status is never encoded by color alone: every tab carries a ✓ / ! / – glyph and every card carries a text badge.

### Responsive
- The status strip wraps as a band; the counter and unassigned blocks hold their size and the tab group wraps.
- The card's field grid reflows from 3 columns to fewer via `auto-fit minmax(160px,1fr)`.
- No mobile layout was designed. The 4-column roster grid will need rethinking below ~700px.

## State Management

```
activeTeam : string          // team key driving the visible card
theme      : 'light'|'dark'
locked     : boolean         // terminal; disables the whole form
filter     : 'all' | teamKey | 'none'
selected   : Set<employeeId> // roster checkbox selection
entries    : { [teamKey]: { accuracy: string, records: string, pool: string } }
assign     : { [employeeId]: teamKey | '' }
```

Keep KPI fields as **strings**, not numbers — the user types partial values ("96.", "") and coercing on every keystroke fights the input.

Derived per render (do not store): member counts per team, unassigned count, per-team completeness, tier, team payout, per-member share, grand total, completed-team count, blocker list, submit-enabled.

```
tier          = first TIERS entry where accuracy >= min      // else null
teamPayout    = complete && tier ? pool * tier.mult : 0
perMember     = members > 0 ? teamPayout / members : 0
total         = sum of teamPayout across all teams
canSubmit     = every team complete && unassigned === 0 && !locked
```

Currency formatting: `'₱' + n.toLocaleString('en-PH', { minimumFractionDigits: 2, maximumFractionDigits: 2 })`.

### Data fetching (not in the prototype)
- GET the roster (id, display name, email, current team) and the current period's saved entries.
- Autosave entries on change, debounced — the footer's "Saved 2 min ago" implies it.
- POST the lock action; it should be server-validated, not just client-gated.

## Design Tokens

Declared on the app root; the `[data-theme="dark"]` block overrides them.

| Token | Light | Dark |
| --- | --- | --- |
| `--app-bg` | #f3f2f2 | #131211 |
| `--ink` | #201e1d | #f3f2f2 |
| `--surface` | #ffffff | #1c1b1a |
| `--sunk` | #eae9e9 | #131211 |
| `--line` | #cfcbcb | #3a3736 |
| `--line-strong` | #201e1d | #6d6866 |
| `--mute` | #7d7979 | #918c8a |
| `--accent` | #ec3013 | #ff563c |

Team colors:

| Team | Light | Dark | Needs dark label on fill |
| --- | --- | --- | --- |
| Blue | #0b5cff | #3d7dff | no |
| Green | #00c97b | #00e894 | **yes** |
| Yellow | #ffc400 | #ffce1f | **yes** |
| Orange | #ff7a00 | #ff8f1f | **yes** |
| Purple | #9b2bff | #b455ff | no |
| Red | #ff2d16 | #ff4a33 | no |

**Typography** — Archivo (400/500/600/800) for content, Archivo Narrow (500/600/700) for all labels, kickers, chips, buttons and table headers. Google Fonts.

Scale in use: 30px/800 page title · 24px/800 total · 22px/800 payout · 20px/800 counter · 16px/600 inputs · 15px/700 team name · 14px/600 employee name · 13px/700 primary button · 12px body-small and most Narrow labels · 11px small labels and chips · 10px caption. Uppercase Narrow labels run `letter-spacing` .1em–.16em; large display numbers run -.02em.

**Spacing** — 28px page gutter, 20px section gutter, 16–20px card padding, 12–14px internal gaps, 8–10px tight gaps.

**Radius** — 999px (pills: buttons, chips, tabs, badges, dropdown, dots, meter segments) · 16px (card) · 10px (input shells) · 0 elsewhere.

**Shadow** — one only, on active cards: `0 1px 2px rgba(0,0,0,.05), 0 8px 20px -12px rgba(0,0,0,.18)`.

> **Note on the design system.** The project is nominally bound to *Modernist*, whose rules mandate 0px radius and 2px rules. This design **deliberately departs** from that on the user's explicit instruction ("too edgy", "make the colors vibrant"): pills and 16px cards replace square corners, 1px lines replace 2px rules, and saturated team colors replace the mono red-on-white palette. Modernist's `--color-text`/`--color-bg`/`--color-accent` values and Archivo type are still the base. If your codebase has its own system, follow it and keep the *structure* rather than these literal values.

## Assets
No images. One inline SVG icon: Lucide `chevron-down` (14×14) in the roster dropdown. If you add more icons, use Lucide.

## Files
- `Bonus Run.dc.html` — the full prototype (template + logic). Read as a spec, not as code to port; see "About the Design Files".
- `original-ui.png` — screenshot of the UI this replaces, for before/after context.

## Open questions for the product owner
1. **Tier thresholds and multipliers are invented.** The real accuracy bands and payout percentages need to come from the business.
2. Should the roster auto-filter to the selected team when you switch tabs? Currently they are independent controls.
3. Is locking reversible, and by whom?
4. Is the pool entered per team, or derived from records × rate? The prototype accepts it as an input and only *shows* the multiplication as a hint.
