# UI Standards — Simple HRIS

**Last swept 2026-09-29** against the UI commits of 2026-09-17 → 2026-09-29 (Sep 29 session log item 270).

This document captures the visual conventions, layout patterns, and component
conventions actually in use across the Simple HRIS codebase. It is descriptive,
not prescriptive: every rule here was extracted from existing components in
`src/components/` and `components/ui/`. If you find code that contradicts this
document, the code is the source of truth — please update this file rather than
the code.

Cross-references:

- [`docs/design/responsive-design.md`](./responsive-design.md) — breakpoints, safe
  areas, drawer pattern, short-viewport handling, and the four rules every `p-0`
  dialog follows (§ "Dialogs and modals"). This document does **not**
  re-derive any of that; it builds on top of it.
- [`docs/reference/components.md`](../reference/components.md) — what each component does and why.
  This document covers visual standards (look, feel, spacing).
- [`PRODUCT.md`](../../PRODUCT.md) — the brief this file serves: calm, trustworthy, clear;
  WCAG AA; light **and** dark each meet contrast (PRODUCT.md:43-46).
- `.impeccable/config.json` — the design detector's waivers (§ 15.4).
- `components/ui/*.tsx` — the shadcn/base-ui primitives (`Button`, `Badge`,
  `Card`, `Dialog`, `Input`, `Tabs`, `Table`, etc.).

---

## 1. Dashboards (per-surface theme)

Every dashboard has its own visual personality, but they all share the same
**shell pattern** (header → sidebar → animated content area). The differences
are color accent, density, and the optional pieces (e.g. a "cycle ready" pill
in the Payroll Clerk sidebar header).

### 1.1 Shell pattern (all dashboards)

```
<div h-dvh max-h-dvh w-full overflow-hidden flex>     ← root, owns viewport
  <Sidebar mobileOpen={…} … />                        ← drawer below md, static md+
  <main relative flex flex-1 flex-col overflow-hidden>
    <header md:hidden …>                              ← mobile-only top bar
      <hamburger /> <surface name>
    </header>
    <AnimatePresence mode="wait" initial={false}>     ← tab swap animator
      <motion.div key={activeTab} … />
    </AnimatePresence>
  </main>
  <Toaster position="top-right" theme={…} />
</div>
```

Every shell component this is derived from:

- `src/App.tsx` (Accounting, the canonical reference)
- `app/admin/page.tsx`
- `app/ceo/page.tsx`
- `app/manager/page.tsx`
- `app/orphanage/page.tsx`
- `src/components/employee/EmployeeApp.tsx`
- `src/components/payroll-clerk/PayrollClerkApp.tsx`
- `src/components/contractor/ContractorApp.tsx`
- `src/components/tickets/TicketsBoard.tsx` (standalone `/tickets` page — same
  shell mechanics, but a fixed black+red theme; see § 1.4)
- `src/components/hr/HrApp.tsx` (`/hr`, via `app/hr/page.tsx`)
- `src/components/qc/QCApp.tsx` (`/qc`)

Reasons for the shape:

- `h-dvh max-h-dvh overflow-hidden` on the root prevents the document body from
  scrolling — every dashboard scrolls **inside** its content area, never as a
  page.
- `min-w-0` on the `<main>` and on nested flex children lets wide tables and
  long emails truncate / overflow-x inside their region instead of blowing out
  the page.
- The mobile header is **only rendered below `md`** via `md:hidden`. Desktop
  doesn't get a duplicate top bar.

### 1.2 Per-dashboard accent

| Dashboard      | Accent family | Sidebar bg                           | Selected nav state                                                      | Brand mark               |
| -------------- | ------------- | ------------------------------------ | ----------------------------------------------------------------------- | ------------------------ |
| Accounting     | Orange / blue | `bg-gradient-to-b from-white to-orange-50/40` (light) / `from-[#0d1117] to-[#0f1729]` (dark) | `bg-gradient-to-r from-orange-100 to-orange-50` (light) | `SidebarLogoHeader`, tile `from-orange-500 to-amber-600` (`Sidebar.tsx:149`) — was "Wand icon in orange tile + `simple-logo.png`" until `SidebarLogoHeader` landed 2026-07-04, d13d5372 |
| Payroll Clerk  | Editorial zinc | `bg-white` / `dark:bg-zinc-950`     | `bg-[#18181b] text-white`                                               | `SidebarLogoHeader`, tile `from-zinc-700 to-zinc-900` (`PayrollClerkSidebar.tsx:149`) — was "Lowercase `s` tile" until 2026-07-04, d13d5372 |
| Admin          | Editorial zinc | `bg-white` / `dark:bg-zinc-950`     | `bg-[#18181b] text-white`                                               | `SidebarLogoHeader`, tile `from-zinc-700 to-zinc-900` (`AdminSidebar.tsx:197`) — was "Lowercase `s` tile + "Admin" caption" until 2026-07-04, d13d5372 |
| CEO            | Yellow / amber (tinted editorial) | `bg-gradient-to-b from-white via-yellow-50/30 to-white` / `dark:from-black dark:via-yellow-950/10 dark:to-black` (`CeoSidebar.tsx:108`) | `bg-gradient-to-r from-yellow-500 to-amber-600 text-white shadow-sm shadow-yellow-600/25` (`CeoSidebar.tsx:83`) | `SidebarLogoHeader`, tile `from-yellow-500 to-amber-600` (`CeoSidebar.tsx:115`) — this row read "Editorial zinc + crown accents · `bg-white` / `dark:bg-zinc-950` · `bg-[#18181b] text-white` · Lowercase `s` tile"; the code has been yellow/amber since 2026-05-04, b274b489 (changed in code; no ruling recorded) |
| Manager        | Blue (tinted editorial) | `bg-gradient-to-b from-white via-blue-50/30 to-white` / `dark:from-black dark:via-blue-950/20 dark:to-black` (`ManagerSidebar.tsx:161`) | `bg-gradient-to-r from-blue-600 to-blue-800 text-white shadow-sm shadow-blue-600/25` (`ManagerSidebar.tsx:117`) | `SidebarLogoHeader`, tile `from-blue-500 to-blue-700` (`ManagerSidebar.tsx:167`) — this row read "Editorial zinc · `bg-white` / `dark:bg-zinc-950` · `bg-[#18181b] text-white` · Lowercase `s` tile"; the code has been blue since 2026-04-30, 19f384c9 (changed in code; no ruling recorded) |
| HR             | Emerald / teal (tinted, 256px) | `bg-gradient-to-b from-white via-emerald-50/30 to-white` / `dark:from-black dark:via-emerald-950/15 dark:to-black` (`HrSidebar.tsx:147`) | `bg-gradient-to-r from-emerald-500 to-teal-700 text-white shadow-sm shadow-emerald-600/25` (`HrSidebar.tsx:118`) | `SidebarLogoHeader`, tile `from-emerald-500 to-teal-600` (`HrSidebar.tsx:158`) — row added 2026-09-29; the rail has been emerald since 2026-05-08, 7656e18d |
| QC             | Orange (tinted editorial) | `bg-gradient-to-b from-white via-orange-50/30 to-white` / `dark:from-black dark:via-orange-950/20 dark:to-black` (`QCSidebar.tsx:97`) | `bg-gradient-to-r from-orange-500 to-orange-600 text-white shadow-sm shadow-orange-600/25` (`QCSidebar.tsx:74`) | `SidebarLogoHeader`, tile `from-orange-500 to-orange-600` (`QCSidebar.tsx:103`) — row added 2026-09-29; the rail has been orange since 2026-06-26, 0f2f293d |
| Orphanage      | Pink / rose    | (per-section)                        | per-section                                                             | Heart icon               |
| Employee       | Orange / blue (matches Accounting) | `bg-gradient-to-b from-white to-orange-50/40` | `bg-gradient-to-r from-orange-100 to-orange-50` | Orange tile + `simple-logo.png` |
| Contractor     | Blue (branded family, blue instead of orange) | `bg-gradient-to-b from-white to-blue-50/40` (light) / `from-[#0d1117] to-[#0f1729]` (dark) | `bg-gradient-to-r from-blue-100 to-blue-50 text-blue-900` (light) / `dark:from-blue-950/70 dark:to-blue-950/40` | Blue tile (`from-blue-500 to-blue-700`) + `simple-logo.png` |
| Tickets        | Black + signal red (fixed — no light variant) | `bg-gradient-to-b from-[#0d0d0e] to-[#080809]` | `bg-gradient-to-r from-red-950/70 to-red-950/30 text-white` | Red tile (`from-red-500 to-red-800`) + `simple-logo.png` |

Three distinct visual families:

1. **Branded** — Accounting, Employee, and Contractor use the gradient family
   with marketing-style hero numbers and decorative blobs (`PayrollDispatch`,
   `Overview`). Accounting/Employee are the orange/blue originals; Contractor
   is the same anatomy recolored blue.
2. **Editorial** — Admin and Payroll Clerk use a near-monochrome
   zinc palette, hairline borders, monospace numerals, and dense per-row UI
   (`AdminGlobalMasterList`, `AdminOverview`; the `Rates` tab this list also named was
   deleted 2026-06-22, 63add1bb — the People tab replaced it, `src/App.tsx:316`). When in
   doubt for a new admin surface, follow the editorial family. (This item read "Admin,
   Payroll Clerk, Manager, CEO" — Manager and CEO moved to the tinted rail below in code;
   no ruling recorded.)
   **Tinted editorial** — Manager (blue), CEO (yellow/amber) and QC (orange) keep the
   editorial 220px density and `text-[13.5px]` nav, but the rail is a
   `from-white via-<hue>-50/30 to-white` gradient (dark `from-black via-<hue>-950/… to-black`)
   and the selected row is a solid gradient pill with white text. HR is the same treatment
   at the branded 256px width (emerald → teal). Rows and sources in the table above.
3. **Console (Tickets only)** — the `/tickets` board is a fixed near-black
   surface with red actions in **both** global themes. It is deliberately
   scoped to that one page; don't reuse the black+red look on any dashboard
   (§ 1.4).

### 1.3 Page background tokens

| Tone       | Light                    | Dark                              |
| ---------- | ------------------------ | --------------------------------- |
| App body   | `bg-white`               | `bg-[#0d1117]`                    |
| Editorial canvas | `bg-zinc-50`       | `bg-zinc-950`                     |
| Soft canvas (under cards) | `bg-[#fafaf8]` / `bg-zinc-50/40` | `bg-[#0a0d12]` / `bg-zinc-950` |
| Subtle gradient (Accounting/Employee dashboards) | `bg-gradient-to-br from-white via-orange-50/30 to-blue-50/20` | `dark:bg-none dark:bg-[#0d1117]` |

The gradient hero tone is reserved for the **branded** surfaces. Don't
introduce it on Admin / Payroll Clerk / CEO / Manager — the editorial family
expects flat backgrounds with hairline borders.

**The navy surface travels with its rings (2026-09-26).** Every Employee tab — Profile
included since b7e954c8, which moved it off a near-black `#0a0a0a` — is
`dark:bg-[#0d1117]`. Anything painted *as* the surface moves with it: `ring-2
dark:ring-[#0d1117]` separators and `dark:focus-visible:ring-offset-[#0d1117]`
(`EmployeeProfile.tsx`, `CompensationSections.tsx`). My Team → Rankings cards use the same
navy: `dark:border-blue-950/60 dark:bg-[#0d1117]` (`RankingsSkeleton.tsx:15-16`,
`RankingHistoryModal.tsx:241`).

### 1.4 Tickets console theme (`.tickets-theme`)

The `/tickets` Kanban board is themed by **CSS custom-property override**, not
by per-component classes. `src/index.css` defines a `.tickets-theme` class that
re-points every semantic token (`--background`, `--card`, `--primary`,
`--border`, …) to a near-black palette with signal-red actions
(`--primary: 0 74% 48%`). Rules:

- The board root carries `tickets-theme dark` — the forced `dark` class makes
  shared components render their dark variants while the custom properties
  carry the black+red surface. This holds in **both** global themes: the board
  never goes light, so its rail has **no theme toggle** (it would visibly do
  nothing).
- **Any portaled surface** opened from the board (Dialog, Select content,
  dropdowns) renders outside the board's DOM subtree and must re-apply
  `tickets-theme dark` on its own content element, or it falls back to the
  app palette.
- Inside the theme, style with **semantic tokens** (`bg-background`,
  `bg-card`, `border-border`, `text-muted-foreground`) so the override does
  the work — avoid hard-coded zinc/orange utilities.
- The accent is **red only**. No orange, no navy — status/priority pills on
  the board use red/zinc ramps (`PRIORITY_STYLES` / `STATUS_STYLES` in
  `TicketCard.tsx`).
- Scope: this theme exists for exactly one surface. New dashboards pick
  branded or editorial (§ 1.2); don't opt anything else into `.tickets-theme`.

### 1.5 Floating chrome (2026-09-29)

The screen corners are already taken: bottom-right = Penny / Notes FAB / tutorial /
cobrowse; bottom-left = dispatch paid toasts; top-centre = the sign-in pill; top-right =
sonner (`CarlaJamBubble.tsx:33-36`). The Employee Help control went into the page header
cluster, not a corner, on that reasoning (`EmployeeHelpMenu.tsx:19-28`, "NOT A FLOATING
BUBBLE, AND IT MUST NOT BECOME ONE"). The one floating control added since is Carla's
Jellyfish bubble: right edge, vertically centred, `z-[110]`, above the dashboard switch
loader (100) and below the collab chrome (120+) (`CarlaJamBubble.tsx:33-36, 101`;
`carla-jellyfish-bubble.md`).

---

## 2. Sidebars

Two visual families (branded vs editorial — see § 1.2) but **one shared
mechanical shell**. Every dashboard rail — HR, Employee, Admin, and the rest —
composes the same three primitives:

- `src/components/common/CollapsibleSidebarShell.tsx` — the outer rail wrapper.
- `src/components/common/SidebarLogoHeader.tsx` — the brand logo header (§ 2.6).
- `src/components/common/SidebarCollapsedDot.tsx` — the corner dot that stands
  in for a clipped badge while the rail is collapsed (§ 2.5).

Collapse state comes from the shared `useSidebarCollapsed()` hook. Do not
hand-roll a rail — reach for `CollapsibleSidebarShell`.

All sidebars share these mechanics:

- `flex h-dvh shrink-0 flex-col`
- `fixed inset-y-0 left-0 z-50` below `md`, `md:static md:z-auto md:translate-x-0` from `md:` up
- Mobile drawer slide is per-rail (`transition-[transform,opacity,box-shadow,width]`)
  driven by `mobileOpen ? 'translate-x-0' : '-translate-x-full md:translate-x-0'`;
  the desktop collapse width-slide is owned by `CollapsibleSidebarShell` (§ 2.5).
- `id="<surface>-sidebar-nav"` + `role="navigation"` + `aria-label` — passed to
  `CollapsibleSidebarShell` (`id` / `ariaLabel`), which renders them on the rail.
- The mobile hamburger button uses `aria-controls="<surface>-sidebar-nav"` and
  `aria-expanded={mobileOpen}`

### 2.1 Editorial (Admin, Payroll Clerk)

This heading read "(Admin, Payroll Clerk, Manager, CEO)". Manager, CEO and QC share the
width, padding, captions and nav metrics below but not the `#18181b` selected state or the
flat `bg-white` rail — see § 1.2 *tinted editorial* (`ManagerSidebar.tsx:115-118`); changed
in code, no ruling recorded.

- Width: `w-[220px]`
- Padding: `px-5 pb-4 pt-7`
- Selected nav item: `bg-[#18181b] font-medium text-white` (light) /
  `dark:bg-zinc-100 dark:text-zinc-900` for the brand chip — selected nav
  reverses to dark even in dark mode for stronger affordance.
- Hover: `hover:bg-[#f3f3f3] hover:text-[#18181b]` light /
  `hover:bg-zinc-800 hover:text-zinc-100` dark
- Section captions: `text-[10.5px] font-medium uppercase tracking-[0.06em] text-[#a1a1aa]`
- Section divider: `<div className="my-5 mx-2.5 h-px bg-[#ececec] dark:bg-zinc-800" />`
- Counts / badges: small pill `rounded-full px-1.5 py-px text-[10.5px] font-semibold tabular-nums`
  - default tone: `bg-[#f3f3f3] text-[#71717a]`
  - active (on selected nav row): `bg-white/15 text-white/90`
  - alert tone: `bg-[#fbf3e1] text-[#b45309]` / `dark:bg-amber-950/50 dark:text-amber-400`

### 2.2 Branded (Accounting, Employee)

- Width: `w-64` (256px)
- Padding: `p-6`
- Body: `bg-gradient-to-b from-white to-orange-50/40` light /
  `from-[#0d1117] to-[#0f1729]` dark
- Selected nav: `bg-gradient-to-r from-orange-100 to-orange-50 text-orange-900 shadow-sm`
- Hover: `hover:bg-orange-50 hover:text-zinc-900`
- Active icon color: `text-orange-500 dark:text-orange-400`
- Brand mark: orange gradient tile (`bg-gradient-to-br from-orange-500 to-orange-600`)
  with the `<Wand2>` icon, paired with `simple-logo.png`.

### 2.3 Required slots

Every sidebar MUST include — in this stacking order from top to bottom — these
five regions, even if some are empty:

1. **Brand row** — logo / mark + surface label (e.g. "Admin", "Payroll clerk").
2. **Optional state pill** — short status messages (e.g. Payroll Clerk's
   "Cycle ready · dispatching" pill, locked-payroll banner). Place above the
   nav.
3. **Nav** — wrapped in `<ScrollArea className="min-h-0 flex-1 pr-2">`.
   Section captions and dividers as above.
4. **`<ViewSwitcher>` + theme toggle** — placed at the bottom of the
   `<ScrollArea>` so it remains reachable on tall navs and short viewports.
   See § 4.1.
5. **User card / sign-out** — outside the `<ScrollArea>`, inside an
   `mt-auto border-t` footer.

Layout requirement: the first section after brand must use `flex flex-1
flex-col` (or `flex min-h-0 flex-1 flex-col`) and the `<ScrollArea>` must use
`min-h-0 flex-1`. Without these, on a short mobile viewport the bottom region
slides off-screen with no way to scroll to it. (See [responsive-design.md](./responsive-design.md)
for the full diagnosis.)

### 2.4 Sidebar nav button anatomy

```
<button>
  <Icon h-4 w-4 />
  <span flex-1 truncate>{label}</span>
  <ChevronRight h-3 w-3 />     ← branded family only, on the active row
  {countOrAlertBadge}          ← optional
</button>
```

Editorial family uses `h-[15px] w-[15px]` icons and `text-[13.5px]`; branded
family uses `h-4 w-4` icons and `text-sm`.

### 2.5 Unified collapsible rail (the shared shell)

Every rail collapses to a **64px icon-only strip on desktop** via
`CollapsibleSidebarShell` + `useSidebarCollapsed()`. HR, Employee, and Admin all
run through the exact same shell, so their collapse behaviour, brand header,
and badge treatment are identical — only the accent colours and expanded width
differ. How it works and the rules to follow:

- **Collapse is desktop-only.** Below `md` the rail is still the full-width
  mobile drawer (`w-[85vw] max-w-[20rem]` on HR/Employee, `w-[220px]` on Admin);
  every `md:`-scoped collapse class is a no-op there.
- **Only `width` animates.** The rail slides its width down to `md:w-16`; all
  content lives in a **fixed-width inner panel** (`innerWidthClassName`, e.g.
  `md:w-64` or `md:w-[220px]`) that the rail clips. Because the panel width
  never changes, nothing inside re-flows during the animation.
- **Icons are always visible.** Nav / view / footer icons sit at the panel's
  left edge and stay put, so they read the same collapsed or expanded. Labels
  and right-aligned badges fade out via the shared `.sb-collapse-fade` class
  (opacity + a short slide, `md:`-scoped).
- **Timing is centralised.** `src/index.css` owns `--sb-collapse-ms` (700ms) and
  `--sb-collapse-ease` (`cubic-bezier(0.22, 1, 0.36, 1)`, the dialog ease), 0.01ms under
  `prefers-reduced-motion` (`src/index.css:11-19`) — was 560ms /
  `cubic-bezier(0.65,0,0.35,1)` until 2026-07-23, 9feb86c1 (changed in code; no ruling
  recorded). The width slide is applied with `!important` on `[data-collapsible-rail]` so
  Tailwind's transition utilities can never out-order it (`src/index.css:21-30`). Don't
  re-declare per-rail durations for the collapse.
- **Counts / badges are preserved but relocated when collapsed.** The full
  count pill (e.g. HR's unread-notifications bell, Employee's profile-nudge and
  bell, Admin's Roles / Global Master List counts and webhook-alert pill, and
  the per-view unread counts in `ViewSwitcher`) all render as before while
  expanded. When collapsed, the pill is clipped, so a `SidebarCollapsedDot`
  corner dot on the icon stands in (its `tone` encodes urgency — red for
  unread, amber for caution).
- **ViewSwitcher stays reachable by scrolling.** The `<ViewSwitcher>` + theme
  toggle live **inside** the rail's `<ScrollArea>` (§ 4.1), so on a short
  viewport they scroll into view on the same scrollbar as the nav rather than
  being pinned off-screen. When collapsed, the switcher sheds its card chrome
  (`.vs-collapse-box`) so only the view icons remain, aligned with the nav
  icons above.

Expanded widths still track the family: HR and Employee share the branded
`md:w-64` (256px); Admin keeps the editorial `md:w-[220px]`. The collapsed
width (`md:w-16`) is uniform across all rails.

### 2.6 Brand logo header (`SidebarLogoHeader`)

The Simple wordmark at the top of every rail is the shared `SidebarLogoHeader`.
Constraints:

- **Keep the aspect ratio.** The logo image is
  `<img src="/simple-logo.png" className="h-10 w-full object-contain">`. The
  `object-contain` is load-bearing — it fixed a stretched-logo bug. Never swap
  it for `object-cover`/`object-fill` or drop it; the wordmark must never be
  distorted to fill its box.
- **Retain the existing animation.** The header keeps the neon hover border
  (`.logo-neon` conic-gradient ring) and the periodic "heartbeat" slide-in
  (`.logo-heartbeat` → `logo-word-slide`, first beat ~1s after mount, then every
  12s). The heartbeat runs **only while expanded** — a `forwards`-filled beat
  would otherwise pin the image back to full opacity and leak the cut-off logo
  into the collapsed 64px rail.
- **Collapsed swap.** When collapsed, the whole logo box fades out and a single
  compact `SidebarBrandMark` — the Penny heart, `/chatbubble.png` — fades and scales in,
  aligned with the nav icon column below. It is self-coloured: the rail's
  `accentClassName` reaches it only as a positioning class and tints nothing
  (`SidebarBrandMark.tsx:4-17`, `SidebarLogoHeader.tsx:86`). Its heartbeat starts only once
  collapsed and stops under reduced motion. (This bullet said "tinted by each rail's
  `accentClassName`"; the heart replaced the tinted mark 2026-07-06, 8d1e2ca4 — changed in
  code, no ruling recorded.)

---

## 3. Headers

There are two distinct header surfaces.

### 3.1 Mobile top bar (`md:hidden`)

Used on every dashboard. Fixed shape:

```tsx
<header className="flex shrink-0 items-center gap-3 border-b border-[#ececec]
  bg-white/95 px-3 py-2.5 backdrop-blur-md
  supports-[padding:max(0px)]:pt-[max(0.625rem,env(safe-area-inset-top))]
  dark:border-zinc-800 dark:bg-zinc-950/95 md:hidden">
  <Button variant="outline" size="icon"
    onClick={() => setMobileNavOpen(true)}
    aria-expanded={mobileNavOpen}
    aria-controls="<surface>-sidebar-nav">
    <Menu className="h-5 w-5" />
  </Button>
  <span className="min-w-0 truncate text-sm font-semibold text-zinc-900 dark:text-zinc-100">
    {surfaceLabel}
  </span>
</header>
```

Required:

- `supports-[padding:max(0px)]:pt-[max(0.625rem,env(safe-area-inset-top))]` —
  honors notched-device safe areas.
- `bg-white/95 backdrop-blur-md` — floats over scrolled content with a glassy
  edge so the rest of the dashboard reads through.
- The hamburger uses `<Button variant="outline" size="icon">` from
  `components/ui/button.tsx`; do not re-implement.
- `<span>` truncates because surface labels can be long ("Payroll clerk").

### 3.2 Per-page headers (inside the content area)

Each dashboard tab renders its own page-level header. These vary, but follow
two common shapes.

#### 3.2.1 Editorial header (zinc, hairline)

Used by `AdminOverview`, `AdminGlobalMasterList`, `PayrollDispatch`'s
secondary panels.

```
<header className="flex shrink-0 flex-wrap items-center gap-x-3 gap-y-1.5
  border-b border-zinc-200/90 bg-white/70 px-3 py-2 text-[11px]
  backdrop-blur-sm
  [@media(max-height:900px)]:py-1.5
  lg:gap-x-4 lg:py-2.5
  dark:border-zinc-800 dark:bg-zinc-950/70">
  {breadcrumb}
  {sessionChip}
  {meta}                  ← timezone, environment, etc.
  <div className="ml-auto flex flex-wrap items-center gap-1.5">
    {actions}             ← export, sync, role grants
  </div>
</header>
```

Conventions:

- Breadcrumb: `<emerald icon> <segment> / <segment>` with `<span className="text-zinc-300">`/`<span className="text-zinc-700">` separators.
- Session chip: monospace email behind a `<Radio>` icon, kept truncatable
  (`min-w-0 max-w-[220px]` below `lg`, then `lg:max-w-none`).
- Action buttons: small pills, `text-[10px] uppercase tracking-wide`,
  `rounded-md border border-zinc-200 bg-white px-2.5 py-1` with hover
  ramp (`hover:border-zinc-300`).
- Only show secondary meta on `md`+ via `hidden md:inline`.

#### 3.2.2 Branded hero header (orange / rose)

Used by `PayrollDispatch`, `Overview`, employee landing — **as written, this spec has no
current user (2026-09-29).** The eyebrow class below (`border-orange-200/80 bg-white/70
px-2.5 py-0.5`) is in no component; the `Sparkles` caption pill survives only inside the
greeting modal (`PayrollCycleGreetingModal.tsx:192-195`). What ships today is described
under *As shipped* at the end of this section. Whether "no hero by default" is itself a
standard is open — § 20 D13.

```
<div className="relative shrink-0 px-4 pt-5 sm:px-8 sm:pt-8">
  <motion.div initial={{ opacity: 0, y: -8 }} animate={…}>
    <div>
      <div className="mb-1.5 inline-flex items-center gap-1.5 rounded-full
        border border-orange-200/80 bg-white/70 px-2.5 py-0.5 text-[10px]
        font-semibold uppercase tracking-[0.14em] text-orange-700
        backdrop-blur-md">
        <Sparkles className="h-3 w-3" />
        {category}
      </div>
      <h1 className="… text-xl font-bold tracking-tight … sm:text-[28px]">
        {pageTitle}
      </h1>
      <p className="…">{lede}</p>
    </div>
    <div>{statusPills + actions}</div>
  </motion.div>
</div>
```

Conventions:

- Sparkles icon next to the small caption pill is the brand cue. Reserve for
  branded family only.
- `<h1>` scales `text-xl → sm:text-[28px]` (no jump to `text-7xl` —
  responsive-design.md explains why).
- BackgroundOrbs: optional decorative blurred blobs (`PayrollDispatch.tsx`).
  Reserve for the highest-traffic landing surfaces; don't reuse on every page.

**As shipped (2026-09-24): the work-surface heading.** Payment Dispatch
(`PayrollDispatch.tsx:1644-1690`, f957cb10) leads with the pay week: a muted
`text-[13px] text-zinc-500` "Welcome back, {name}" line, then
`<h1 className="text-xl font-semibold tracking-tight tabular-nums sm:text-2xl">` naming the
week, with the week switcher (`CycleSelector`) inline beside it. The processing status and
its Start/Stop button are ONE bordered group (`rounded-lg border border-zinc-200 bg-white
py-1 pr-1 pl-3`), solid emerald / rose fills. `BackgroundOrbs` stays
(`PayrollDispatch.tsx:1642`). Employee Overview uses the same H1 scale with a 2px
orange→rose rule under the greeting (`EmployeeDashboard.tsx:2776-2790`).

Three hero banners were removed in one week, each at Kane's request:

- Gift Tracker — the gradient hero card and four tiles; "keep four stat tiles that answer
  something" (ca8bbcb2, 2026-09-23).
- Payment Dispatch — the heading and blurb (e7f67ad2), the eyebrow badge, gradient name and
  wave emoji (f957cb10), the source CSV filename (d309dc61), 2026-09-24.
- HR → Onboarding — the gradient hero card and its Bulk promote (Lead Gen) button; the page
  "now opens straight on the Onboarding Form / Pending Hires sub-tabs" (5c5cc077, 2026-09-25).

---

## 4. Common bottom sections

### 4.1 ViewSwitcher

`@/components/rbac/ViewSwitcher` is shared across every dashboard. It renders
nothing when `views.length <= 1`. Treat it as a drop-in component — do not
restyle. Mount it inside the sidebar's `<ScrollArea>` (NOT in the `mt-auto`
footer) so it remains scrollable on short viewports.

Animation contract: the click paints `DashboardSwitchLoader` — the same component the
target route's `loading.tsx` renders — this frame, and pushes on the next
`requestAnimationFrame` (`ViewSwitcher.tsx:80-99`). It deliberately does NOT wrap the push
in a View Transition: the snapshot cross-fade masked the loader for ~400ms. Hover/focus
prefetches the target route. New surfaces should not intercept the click.
(This paragraph read: "clicking a target view delays the route push by 520ms while playing
a glow + ring overlay (`<ViewSwitchOverlay>`) … just call `withViewTransition(() =>
router.push(url))` which is what `ViewSwitcher` already does" — changed 2026-07-22,
0e1c3626, which also deleted `ViewSwitchOverlay`; changed in code, no ruling recorded.)

### 4.2 Theme toggle

```
<button
  onClick={() => withViewTransition(() => setTheme(isDark ? 'light' : 'dark'))}
  className="… flex w-full items-center justify-between rounded-md border …"
  aria-label="Toggle dark mode"
>
  <div className="flex items-center gap-2">
    {isDark ? <Moon /> : <Sun />}
    <span>{isDark ? 'Dark' : 'Light'}</span>
  </div>
  <span>{isDark ? '☀' : '☾'}</span>
</button>
```

`withViewTransition` from `@/lib/theme/with-view-transition` wraps the
`setTheme` call so browsers that support View Transitions cross-fade the
theme change. The Unicode "next state" glyph (`☀` or `☾`) is intentional —
it indicates what tapping will switch TO.

### 4.3 User card / sign-out

Bottom of every sidebar, outside the ScrollArea:

```
<div className="mt-auto border-t … p-5">
  <div className="flex items-center gap-2.5 rounded-md border … bg-[#fafaf8] …">
    <div className="flex h-7 w-7 shrink-0 items-center justify-center rounded-full bg-[#18181b] text-[11px] font-semibold text-white">
      {emailInitials}
    </div>
    <div className="min-w-0 flex-1">
      <div className="truncate text-[13px] font-medium">{titleName}</div>
      <div className="mt-px truncate text-[11px] text-[#71717a]">{role}</div>
    </div>
    <MoreHorizontal className="h-4 w-4 cursor-pointer text-[#a1a1aa]" />
  </div>
  <Button variant="ghost" className="mt-3 w-full justify-start gap-3 text-[#71717a] hover:bg-red-500/10 hover:text-red-600">
    <LogOut className="h-4 w-4" />
    Sign Out
  </Button>
</div>
```

The sign-out hover ramps to red (`hover:bg-red-500/10 hover:text-red-600`).
Don't soften this — it's a deliberate "this is destructive" cue.

---

## 5. Tables

There are **three** table conventions in the codebase, used in different
contexts. They are not interchangeable. Pick by intent.

### 5.1 shadcn `<Table>` (`components/ui/table.tsx`)

The thinnest layer. Use when the content is genuinely tabular and a table
element is semantically right (audit logs, role lists, employee directory
detail). Default class hooks:

- `<Table>` — wraps in `relative w-full overflow-x-auto`, then `<table className="w-full caption-bottom text-sm">`. Wide tables scroll horizontally inside their container, never the page.
- `<TableHeader>` — `[&_tr]:border-b`
- `<TableHead>` — `h-10 px-2 text-left align-middle font-medium whitespace-nowrap`
- `<TableRow>` — `border-b transition-colors hover:bg-muted/50`
- `<TableCell>` — `p-2 align-middle whitespace-nowrap`

Always wrap the parent of `<Table>` with `min-w-0` so the `overflow-x-auto`
actually has room to clip.

Used in: `AuditLogPanel.tsx`, `AdminRoles.tsx` table view.

### 5.2 Editorial card-list (the main pattern)

Used in `AdminGlobalMasterList`, `ProcessorQueue` (Payroll Clerk),
`SentPaymentsHistory`. Each row is a flex card, not a `<tr>`. Reasons:

- Each row mixes inline meta with avatars, status pills, and CTAs that are
  awkward to style as `<td>`s.
- Hover affordances (left-edge accent, scale on action click) read better on
  cards.
- Mobile collapses cleanly to a stacked layout.

Anatomy:

```
<motion.li className="bg-white/90 transition-colors hover:bg-orange-50/40 dark:hover:bg-zinc-900/50">
  {/* MOBILE: stacked card */}
  <div className="flex flex-col gap-2.5 px-3 py-3 md:hidden">…</div>

  {/* DESKTOP: N-column grid (rowGrid string) */}
  <div className={cn('hidden items-center gap-3 px-6 py-3 md:grid', rowGrid)}>
    <Avatar />
    <Identity />
    {optionalCell}
    <Money />
    <Hours />
    <ActionButton />
  </div>

  {/* Optional expand panel */}
  <AnimatePresence initial={false}>
    {isOpen && <motion.div … />}
  </AnimatePresence>
</motion.li>
```

Key rules:

- `React.memo` the row component. At ~1000 rows the difference is `16ms`
  (memoized) vs `200ms` (not) when an unrelated state flips, e.g. opening a
  dialog. See `ProcessorQueue.QueueRowItem` for the canonical reference.
- Hover state changes `bg`, never the layout. Accent rules / left bars are
  `position: absolute` and `transition-transform`.
- Money columns always use `font-mono tabular-nums` and right-align.
- A dim "—" is the empty-cell convention (`text-zinc-400 dark:text-zinc-600`).

### 5.3 Ledger row (financial / temporal data)

A specialty pattern for per-employee financial history. Its shipped reference
(the Payment Dispatch Reports drilldown) was retired 2026-08-12, so treat this
section as the spec. Characterized by:

- Left "index" stub (`N°001`)
- Vertical date stamp (`APR / 12 → 18 / '26`)
- `font-mono tabular-nums` everywhere
- Status as a single glyph (`●`, `○`, `△`, `✕`) + tiny caps label
- Hairlines, no per-row card chrome
- One refined orange accent rule on hover (left edge, `origin-top scale-y-0` →
  `scale-y-100`)

Use only for printed-statement-style content. Don't apply to roster-style
tables.

### 5.4 Table headers (within § 5.2 layout)

```
<div className={cn(
  'sticky top-0 z-10 hidden items-center gap-3 border-b border-orange-100/80
   bg-white/90 px-6 py-2 text-[10px] font-semibold uppercase tracking-[0.12em]
   text-zinc-400 backdrop-blur-md dark:border-zinc-800 dark:bg-zinc-950/90
   dark:text-zinc-500 md:grid',
  rowGrid,
)}>
```

Conventions:

- `sticky top-0 z-10 backdrop-blur-md` — header stays in view while the row
  list scrolls.
- `text-[10px] font-semibold uppercase tracking-[0.12em] text-zinc-400` — the
  "tiny caps" used for every column heading and section label app-wide.
  > ⚠ **Deviation (2026-09-29, OPEN — Kane's call):** § 11.2 of this document says
  > `zinc-400` fails AA (2.8:1); the new Rankings tables head in `text-zinc-500` — § 20 D7.
- Hidden below `md` (`md:grid`) because mobile rows use the stacked card
  layout above.

### 5.5 Empty / search-no-match / loading

Three distinct states, never merged:

| State | Used when | Visual cue |
| --- | --- | --- |
| **Empty queue** | The data set is empty | gradient sparkle tile + "Queue clear" + soft sub-line |
| **No matches** | A filter / search excludes all rows | gradient zinc tile + "No matches" + the queried string in mono + "Clear search" pill |
| **Loading** | Data is in flight | small skeleton matching the row layout (`QueueSkeleton`), or a centered spinner with `text-[10px] uppercase tracking-[0.22em] text-zinc-400` caption |

See `ProcessorQueue.tsx` (`EmptyQueueState`, `NoMatchesState`,
`QueueSkeleton`) for the canonical refs. Board-shaped skeletons and the refetch rule:
§ 12.3.

### 5.6 Pagination (display only, 2026-09-29)

Paging is DISPLAY ONLY: counts, pills, totals, KPI tiles and exports read the full filtered
list, never the page on screen (`src/lib/manager/page-window.ts:1-10`; b47bb153's Gift
Tracker comment). Five shipped pagers share the shape — `QueuePagination`
(`QueuePagination.tsx:27-39`, the Payment Dispatch queues), the My Team roster list
(`ManagerApp.tsx:4274-4309`), Orientation's `Pager` (`OrientationAttendancePanel.tsx:133`,
weeks and people at 10, a8507246), People → Search Bar (`PeopleBankSearch.tsx:314-318`),
Gift Tracker → Submissions (`GiftTracker.tsx:2939-2965`, 20 per page, b47bb153):

- **Clamp, never trust the page.** A refresh, an approval or a filter can shrink the list
  under the cursor; `pageWindow()` (`src/lib/manager/page-window.ts`, tested) clamps it, and
  Gift Tracker clamps at read time (`GiftTracker.tsx:2594`).
- **Reset to page 1** on a filter / search / department change.
- **Say which slice:** "Showing 11–20 of 24 weeks" (or "Page 2 of 3 · 41 total"), then
  `Button variant="outline" size="sm"` Prev / Next at `h-7 text-xs`, the page as a mono
  `n / N` chip between them (My Team, Orientation). **Render nothing for a single page**
  (`QueuePagination.tsx:27`; `OrientationAttendancePanel.tsx` `Pager`).
- Inside a `ReadOnlyTab`, the pager carries `data-readonly-allow` so a view-only viewer can
  still page (`ReadOnlyTab.tsx:22, 46`; `ManagerApp.tsx:4274`, `GiftTracker.tsx:2940`).
- Next / Prev scroll the list back into view only if its top has left the viewport
  (`OrientationAttendancePanel.tsx`, `goToWeekPage`).

Append variant, used by the Rankings leaderboards: "Show 25 more · N left"
(`AppointmentLeaderboardPane.tsx:51, 636`; `AppointmentRankingsPane.tsx:45`).

---

## 6. Cards / Panels

### 6.1 shadcn `<Card>` (`components/ui/card.tsx`)

Default size:

- `rounded-xl bg-card py-4 text-sm ring-1 ring-foreground/10`
- `<CardHeader>` `px-4`, `<CardContent>` `px-4`, `<CardFooter>` `border-t bg-muted/50 p-4`
- `gap-4` between sub-elements; `data-size="sm"` swaps to `gap-3 py-3 px-3`.

Use the shadcn `<Card>` for **bordered, content-section panels** with a clear
title and structured body. Examples: `AdminRoles` role list cards, audit log
filters card, `AdminGlobalMasterList`'s roster card.

### 6.2 Hairline panel (editorial alternative)

Used widely in `AdminOverview`, dispatch reports (that tab was retired 2026-08-12,
4c556c02). Pattern:

```
<div className="rounded-lg border border-zinc-200/90 bg-gradient-to-br
  from-white via-white to-zinc-50/90 p-3 shadow-sm xl:p-4
  dark:border-zinc-800/80 dark:from-zinc-900/80 dark:via-zinc-900/60 dark:to-zinc-950/90">
  …
</div>
```

Header inside ("panelHead") is a tiny-caps heading row:

```
<div className="flex items-center justify-between border-b border-zinc-200/90 px-3 py-2 dark:border-zinc-800/90">
  <span className="text-xs font-semibold text-zinc-700 dark:text-zinc-200">{title}</span>
  <{small meta or action} />
</div>
```

### 6.3 Stat tile

Mini-stat tiles (4-up grid in `AdminOverview`, hero stats in `PayrollDispatch`):

```
<div className="relative overflow-hidden rounded-xl border border-white/60
  bg-white/70 p-2.5 backdrop-blur-md sm:p-3
  dark:border-zinc-800 dark:bg-zinc-900/60">
  <div className="absolute inset-0 bg-gradient-to-br opacity-60 {paletteRing}" aria-hidden />
  <div className="relative flex items-start justify-between gap-2">
    <div className="min-w-0">
      <div className="text-[9px] font-semibold uppercase tracking-[0.14em] {paletteText}">
        {label}
      </div>
      <div className="mt-0.5 text-base font-bold tracking-tight sm:text-lg">
        {value}
      </div>
      <div className="mt-0.5 truncate text-[10px] text-zinc-500 dark:text-zinc-400">
        {sub}
      </div>
    </div>
    <div className="hidden h-8 w-8 items-center justify-center rounded-lg bg-gradient-to-br {paletteIcon} text-white sm:flex">
      <Icon className="h-4 w-4" />
    </div>
  </div>
</div>
```

Standard palettes (matched per stat):

| Tone     | `ring`                                                            | `icon`                            | `text`                       |
| -------- | ----------------------------------------------------------------- | --------------------------------- | ---------------------------- |
| emerald  | `from-emerald-200/40 to-teal-200/40`                              | `from-emerald-500 to-teal-500`    | `text-emerald-700 dark:text-emerald-300` |
| orange   | `from-orange-200/40 to-rose-200/40`                               | `from-orange-500 to-rose-500`     | `text-orange-700 dark:text-orange-300`   |
| violet   | `from-violet-200/40 to-fuchsia-200/40`                            | `from-violet-500 to-fuchsia-500`  | `text-violet-700 dark:text-violet-300`   |
| amber    | `from-amber-200/40 to-orange-200/40`                              | `from-amber-500 to-orange-500`    | `text-amber-700 dark:text-amber-300`     |
| sky      | `from-sky-200/40 to-blue-200/40`                                  | `from-sky-500 to-blue-500`        | `text-sky-700 dark:text-sky-300`         |

Use these tones consistently:
- emerald = success / paid / healthy
- orange = primary / current / hero
- amber = caution / pending / threshold
- violet = secondary / sent / dispatch
- sky / blue = neutral info

### 6.4 Logo plate (brand-mark tile)

For rendering a third-party **brand logo** inside a card — the Payment Dispatch
processor filter cards (Wise / Hurupay / HiGlobe) — use a **white plate**, never
the gradient monogram tile. Canonical component: `ProcessorLogo.tsx`.

```
<div className="relative flex items-center justify-center overflow-hidden rounded-xl bg-white px-1.5 shadow-sm">
  {/* pulse skeleton until the image paints — see §12.3 */}
  {!loaded && <div className="absolute inset-x-2 inset-y-3 animate-pulse rounded-md bg-zinc-200/80 motion-reduce:animate-none" aria-hidden />}
  <img src={logoSrc}
    className="max-h-full max-w-full object-contain transition-opacity duration-200 ease-out motion-reduce:transition-none"
    onLoad={…} onError={…} />
</div>
```

Rules:

- **White plate always** (`bg-white`), in both themes — these wordmarks are
  dark-on-transparent; a dark tile would swallow them.
- **`object-contain` + `max-h/w-full`**, never a fixed square. Most processor
  wordmarks are ~3:1; a square + `object-cover`/small box shrinks them to an
  unreadable sliver (the original "white box" bug). The plate is wide
  (`h-11`-ish), not a 44px square.
- **No `mix-blend`.** Dark-on-transparent logos sit correctly on white as-is;
  `mix-blend-multiply` was what erased them. It also erases anything **white**
  *inside* the artwork: multiply against a white plate maps white→white, which
  flattened the Kolan mark's corona to a featureless black square (light mode
  only — a `dark:mix-blend-normal` companion rendered it correctly, so the bug
  looked theme-specific rather than blend-specific). This rule binds every
  `logoSrc` consumer, not just `ProcessorLogo`: the contractor invoice/profile
  gateway chips and `employee-payout-fields.tsx` render the same registry
  assets, and the last of them dropped its `mix-blend-multiply` on 2026-08-25.
- **`onError` → fall back** to the gradient monogram/icon tile (the §6.3 pattern)
  so a missing asset degrades instead of showing an empty plate.

### 6.5 Rotating spotlight (2026-09-26, two users)

One item at a time, crossfading, open / most important first — Accounting Overview's
Payroll Notes Steps 1–8 card (`PayrollNotesSetupCard.tsx`, da7d22f5) and the KPI
Calculator's Department spotlight (`KpiInsightCards.tsx`, 98a9ecc7). What they share:

- Dwell **5200ms** (`PayrollNotesSetupCard.tsx:46` `DWELL_MS`; `KpiInsightCards.tsx:57`
  `ROTATE_MS`).
- Crossfade on `[0.22, 1, 0.36, 1]` with a 2–4px blur (`PayrollNotesSetupCard.tsx:71-80`;
  `KpiInsightCards.tsx:320-330`).
- Hover and keyboard focus **pause** it (`PayrollNotesSetupCard.tsx:180-183`;
  `KpiInsightCards.tsx:234`). The KPI card also pauses on `document.hidden` and draws a
  progress pill that freezes where it is (`KpiInsightCards.tsx:255-261, 400-430`).
- Markup: `role="group" aria-roledescription="carousel"` with a `role="tablist"` of slides
  (`KpiInsightCards.tsx:310, 400`).

Where they differ: under reduced motion the KPI card stops rotating
(`kpi-calculator-insights.md:79`), while the Notes card keeps rotating with an
opacity-only fade (`PayrollNotesSetupCard.tsx:183`). Not decided here.

### 6.6 Container-query layouts (four users)

A layout that must answer to its **pane**, not the viewport — the rail collapses, so the
pane width moves independently — uses `@container`: Employee Profile's Overview
(`EmployeeProfile.tsx:2108-2109`, `@4xl:grid-cols-[minmax(0,1fr)_372px]`, 0d5e26e2, the ID
card to the right of the information at a ≥56rem pane), the Accounting Overview roster
(`Overview.tsx:4852`), the HSL share explainer (`HslBonusCalculator.tsx:4558`), and the ID
card itself (`EmployeeIdCard.tsx:69`). A `cqw`-sized child sits in a FIXED track (`372px`),
never `fr` / `auto` / `%`, or it shrinks on screen while its exported PNG does not
(`EmployeeProfile.tsx:2164-2168`).

---

## 7. Buttons (`components/ui/button.tsx`)

Variants exposed by `buttonVariants`:

| Variant       | When to use                                                                    |
| ------------- | ------------------------------------------------------------------------------ |
| `default`     | Primary affirmative ("Submit", "Confirm", "Save")                              |
| `outline`     | Secondary action ("Cancel", "Edit", header utility actions)                    |
| `secondary`   | Tertiary (rare in this app — most "secondary" use `outline` instead)           |
| `ghost`       | Inline icon buttons in headers, sign-out, "more" overflow                      |
| `destructive` | "Delete", "Revoke", "Discard" — uses `bg-destructive/10` not solid red         |
| `link`        | Inline "Manage", "Full log →" links inside cards                               |

Sizes: `xs h-6` / `sm h-7` / `default h-8` / `lg h-9` / `icon size-8` /
`icon-xs size-6` / `icon-sm size-7` / `icon-lg size-9`.

Conventions:

- The default `Button` has `active:translate-y-px` for tactile press feedback.
  Don't override unless the button is wrapped in another animator.
- For "send / submit" actions in green-flavored contexts (Mark Paid, Confirm
  sent), use a custom emerald gradient class on `<Button>` instead of variant:
  `className="bg-gradient-to-br from-emerald-500 to-teal-600 text-white shadow-sm shadow-emerald-500/30 hover:from-emerald-600 hover:to-teal-700 active:scale-95"`.
  This is the canonical "money in flight" CTA — use it sparingly.
- When a button is the **only** action in a row, prefer `size="sm"` so it
  doesn't dominate the row.
- Icon buttons in headers: `<Button variant="outline" size="icon">`. The
  hamburger and close-X follow this exactly.

---

## 8. Badges & status pills

Three different conventions, NOT interchangeable.

### 8.1 shadcn `<Badge>` (`components/ui/badge.tsx`)

`rounded-4xl border h-5 px-2 py-0.5 text-xs font-medium`. Variants
`default | secondary | destructive | outline | ghost | link`. Use for short
inline tags ("Pinned", "Healthy", "Suspended"). Always use the component, not
hand-rolled spans.

### 8.2 Tiny-caps section pill (the most common form)

```
<span className="inline-flex items-center gap-1 rounded-full border px-1.5 py-0.5
  text-[10px] font-semibold uppercase tracking-[0.12em] {palette}">
  <Icon className="h-2.5 w-2.5" />
  {label}
</span>
```

Used in: dispatch status (`paid` / `pending` / `threshold` / `problem`),
audit-row scope tags, leave-request status, role pills.

Standard palettes:

| State     | className                                                                              |
| --------- | -------------------------------------------------------------------------------------- |
| paid / ok | `border-emerald-200 bg-emerald-50 text-emerald-700 dark:border-emerald-500/30 dark:bg-emerald-500/10 dark:text-emerald-300` |
| pending   | `border-amber-200 bg-amber-50 text-amber-700 dark:border-amber-500/30 dark:bg-amber-500/10 dark:text-amber-300` |
| neutral   | `border-zinc-200 bg-zinc-50 text-zinc-700 dark:border-zinc-700 dark:bg-zinc-900 dark:text-zinc-300` |
| warn      | `border-amber-200 bg-amber-50 text-amber-700 dark:border-amber-500/30 dark:bg-amber-500/10 dark:text-amber-300` |
| problem   | `border-rose-200 bg-rose-50 text-rose-700 dark:border-rose-500/30 dark:bg-rose-500/10 dark:text-rose-300` |
| current / hero | `border-orange-200 bg-gradient-to-br from-orange-50 to-rose-50 text-orange-700 dark:border-orange-900/40 dark:from-orange-950/40 dark:to-rose-950/30 dark:text-orange-300` |

### 8.3 Glyph + tiny caps (ledger only)

Used inside the § 5.3 ledger row. NOT a generic pattern — reserve for printed-
statement contexts.

```
<span className={STATUS_TONE[status]}>{STATUS_GLYPH[status]}</span>
<span className={cn('font-mono text-[10px] uppercase tracking-[0.22em]', STATUS_TONE[status])}>
  {STATUS_LABEL[status]}
</span>
```

Glyphs in use:

| Status    | Glyph |
| --------- | ----- |
| paid      | `●`   |
| pending   | `○`   |
| not_paid  | `·`   |
| threshold | `△`   |
| problem   | `✕`   |

### 8.4 Step-status palette (two users)

A step's state, the same four colours on every step track: done `bg-emerald-500
dark:bg-emerald-400` · attention `bg-amber-400` · blocked `bg-rose-500 dark:bg-rose-400` ·
pending `bg-sky-400` (`PayrollNotesSetupCard.tsx:62-67`; `PayrollCycleGreetingModal.tsx:45-50`;
the matching pills are `SETUP_STATUS_PILL` in `accounting/wizard-setup-meta.ts`). The
employee's Current Paycycle track uses the same done-emerald and a sky ping for the step in
progress (`CurrentPaycycle.tsx:53-73`). These map onto § 6.3's tones: emerald = done,
amber = caution, sky = neutral / pending.

### 8.5 Rank tones — the podium (two users)

Gold / silver / bronze mean **rank, not money**: `from-amber-400 to-amber-600`,
`from-zinc-300 to-zinc-500`, `from-orange-400 to-orange-700`, on a `h-7 w-7 rounded-md
bg-gradient-to-br text-white shadow-sm` tile with `Crown` for #1 and `Medal` otherwise
(`RankingsPane.tsx:70-75`; `AppointmentLeaderboardPane.tsx:67-71` — the constant is
duplicated; keep the two identical). The podium shows only fields the rows show
(`RankingsPane.tsx:25-29`) and steps aside while a search is live, so a #7 never sits in a
gold slot (`AppointmentLeaderboardPane.tsx:299-310`; `RankingsPane.tsx:223`). Used on My Team
→ Rankings (13e59805, 5db19364); the Employee tab has no podium.

Also used once — the HSL Bonus Library **provenance chip**, `v<n> · from <date> · saved
<when> by <who>`: local-time stamp, the handle before `@` on the chip and the full address in
the `title` (`HslBonusCalculator.tsx:2995-3070`, c9153d9a; Kane: "add like a timestamp on who
changed it ... even the version").

---

## 9. Inputs / forms

### 9.1 `<Input>` and `<Label>`

`<Input>` is `h-8 rounded-lg border-input px-2.5 py-1`. Use `<Label>` from
`components/ui/label.tsx` for every field (accessibility — base-ui won't
auto-wire labels otherwise).

Field group:

```
<div className="space-y-1.5">
  <Label htmlFor="x" className="text-xs font-medium text-zinc-700 dark:text-zinc-300">
    {labelText}
  </Label>
  <Input id="x" … />
</div>
```

Form section header:

```
<div className="flex items-center gap-2 border-b border-zinc-200/70 pb-1.5 dark:border-zinc-800/70">
  <{Icon} className="h-3.5 w-3.5 text-zinc-400" aria-hidden />
  <p className="text-[10px] font-semibold uppercase tracking-[0.14em] text-zinc-500 dark:text-zinc-400">
    {sectionName}
  </p>
</div>
```

### 9.2 Search bar

The compact search input used in queues, audit logs, and roster filters:

```
<div className="relative max-w-sm flex-1">
  <Search className="pointer-events-none absolute left-2.5 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-zinc-400" />
  <Input placeholder="Search …" className="h-8 pl-8 pr-20 text-xs focus-visible:ring-orange-200" />
  <div className="absolute right-1.5 top-1/2 flex -translate-y-1/2 items-center gap-1">
    {isSearching ? <TypingDots /> : hasQuery ? <Count /> : null}
    {hasQuery && <ClearButton />}
  </div>
</div>
```

Always include the typing-dots indicator (debounce in flight) and the result
count once the debounced query has resolved. See `ProcessorQueue.SearchBar`.

> ⚠ **Deviation (2026-09-29, OPEN — Kane's call):** `RankingsSearch`, on every My Team
> Rankings view, shows neither dots nor a count (it is a synchronous filter, no debounce) —
> § 20 D5.

Variants, each used once:

- **Compact 26px filter** — `RankingsSearch` (`RankingsSearch.tsx:21-61`, fe676f9d): sits in
  a row with the segmented toggles and the KPI picker; names and **work** emails only;
  Escape clears; filtering hides rows and never re-ranks (`src/lib/manager/rankings-search.ts`).
- **Hero search** — People → Search Bar (`PeopleBankSearch.tsx`, 27225f85 / b2c7de37): a
  centred logo + bar that lifts to the top on the first keystroke as a FLIP (motion
  `layout`, 500ms), results arriving once per search 180ms behind it and then live-filtering
  without re-animating (`people-bank-search.md` § 7).

### 9.3 Date / time inputs

Use the shared pickers in `components/ui/date-picker.tsx` — still no
third-party date library; both are hand-rolled and dependency-free:

- `<DatePicker />` for single dates. Same value contract as the old native
  input (`value: "YYYY-MM-DD" | ""`, `onChange(iso)`), plus `min`/`max`,
  `required` (keeps native form validation via an invisible mirror input and
  hides the clear ×), `className` (trigger: height/text/focus-ring accent) and
  `containerClassName` (width/flex — the trigger itself is `w-full`). Calendar
  popover has month/year drill-down (click the header label), full keyboard
  nav (arrows, PageUp/Down ± month, Shift+PageUp/Down ± year, Home/End),
  a Today shortcut, and edge-aware placement.
- `<DateRangePicker />` for range filters (formerly
  `PeopleDateRangePicker`, now shared). Two-month calendar on `sm:`+, preset
  chips, hover span preview, optional `accent` object for per-dashboard
  theming (defaults to the teal used by `SmoothSelect`).

Don't use native `<input type="date">` in new code — its popup ignores the
app theme and renders inconsistently across browsers.

### 9.4 Selects / dropdowns

- **Default primitive:** `SmoothSelect` (theme-aware, teal accent by default).
  Reach for it before a native `<select>`, whose popup ignores the app theme.
  Since 2026-09-27 the menu animates **out** as well as in (`motion` +
  `AnimatePresence`: 180ms in and 120ms out on the exponential ease-out
  `[0.22, 1, 0.36, 1]`, a 4px drift and 0.97 scale, opacity only under reduced
  motion). A portalled menu closes where it was drawn. Opt-in props, each
  defaulting to the old look: `size="sm"` (a 26px trigger that lines up with
  segmented toggles), `accent="blue"` (for surfaces whose other controls are
  blue), `leading` (a muted prefix label inside the trigger, e.g. "KPI"), and
  `align="start"` (a left-aligned menu that opens toward the page, not off its
  left edge on a phone). First user of all four: My Team → Rankings' KPI picker.
  `accent="orange"` (2026-10-01) is the same rule for the orange Accounting family.
  Its first user is the Accounting Scoreboard, where every dropdown is
  `accent="orange" align="start" portal`. `portal` is there because the board's
  content scrolls, and a scroll container would clip an in-flow menu.
- **Themed collapsible picker** (the "beautifully wrapped dropdown" pattern —
  `HslBonusCalculator.tsx` branch picker): a sticky, `backdrop-blur-md` themed
  header (`sticky top-0 z-10 … bg-white/90 dark:bg-zinc-950/90`) over a body that
  expands/collapses with `motion/react` + `AnimatePresence` and a `ChevronDown`
  that rotates on `open`. Gate its very existence on there being more than one
  option to pick (`multiDept`) — a one-option "dropdown" is noise; render the
  single item flat instead. Self-disable the motion under reduced motion.

---

## 10. Dialogs (`components/ui/dialog.tsx`)

Backdrop is intentionally branded (`bg-gradient-to-br from-orange-950/40 to-blue-950/40 backdrop-blur-[2px]`). Don't override.
Its dark variant is `dark:from-black/75 dark:to-blue-950/60`; the popup itself is
`from-white via-orange-50 to-blue-50` (dark `from-[#0d1117] via-[#0f1729] to-[#0a1628]`) and
closes on `zoom-out-[0.97]` over 180ms `ease-in` (`components/ui/dialog.tsx:32-34, 56-60`).

Default size is `sm:max-w-sm`. Override with explicit pixel widths for
specialty content:

| Dialog                       | `className` width pattern                              |
| ---------------------------- | ------------------------------------------------------ |
| Standard form (Mark paid)    | `sm:max-w-[440px]` to `sm:max-w-[520px]`               |
| Lock-toggle confirm          | `sm:max-w-[440px]`                                     |
| Bulk-create disputes         | `max-w-[1200px] w-[95vw]`                              |
| Rankings View (My Team)      | `flex max-h-[calc(100dvh-1.5rem)] max-w-[calc(100%-2rem)] flex-col gap-0 p-0 sm:max-h-[92dvh] sm:max-w-3xl` (`RankingHistoryModal.tsx:109`) |
| Multi-column live modal (CEO Live Processing) | `lg:max-w-6xl` — three peer columns |
| Confirm delete               | default `sm:max-w-sm`                                  |

**Multi-column modal layout** (CEO Live Processing, `CeoPayrollLive.tsx`): when a
modal shows parallel lists (roster · departments-this-cycle · payments feed),
make each a **standalone peer column** — its own header + count pill,
`border-l` divider, and independent scroll area — not content nested inline in a
sibling. Widen to `lg:max-w-6xl` and let the columns **stack vertically** below
`lg`. ("Separate it into another column, not inline with the people.")

Layout inside a sectioned dialog (Profile / bulk-create — the Profile dialog was the
`Rates` one, deleted with that tab):

- `<DialogHeader>` is `shrink-0`, sits in a slim `border-b` bar.
- Action row sits below the header, `shrink-0`.
- The body uses `overflow-y-auto bg-zinc-50/40 px-6 [-webkit-overflow-scrolling:touch] dark:bg-[#0a0d12]` with `style={{ maxHeight: "min(58vh, 600px)" }}`.
  > ⚠ **Deviation (2026-09-29, OPEN — Kane's call):** doc vs doc — responsive-design.md
  > § "Dialogs and modals" (lines 108-111) forbids a pixel `maxHeight` on the scroll region;
  > no code still uses `min(58vh, 600px)` — § 20 D10.
- `<DialogFooter>` extends edge-to-edge by undoing the dialog's padding:
  `-mx-4 -mb-4` — already baked into the primitive's default classes.

Any dialog that overrides the padding with `p-0` follows the four rules in
[responsive-design.md § "Dialogs and modals"](./responsive-design.md): `gap-0`, a height cap
(`max-h-[calc(100dvh-1.5rem)] sm:max-h-[92dvh]`), a width re-declared at `sm:`, and
`flex flex-col` with `shrink-0` chrome around one `min-h-0 flex-1 overflow-y-auto` body.
Shipped reference since that rule: `RankingHistoryModal.tsx:109-123` (2026-09-28), which
cites it in its header (`RankingHistoryModal.tsx:19-21`).

Animation: dialog uses `data-open:animate-in data-open:fade-in-0
data-open:zoom-in-[0.94] data-open:slide-in-from-bottom-6` over 320ms with the
custom ease `cubic-bezier(0.22, 1, 0.36, 1)`. Match this curve everywhere; see
§ 14.

Confirmation dialogs always have:
1. An icon at the top of the title (`<Play>` for affirm, `<StopCircle>` for
   stop, `<Trash2>` for delete).
2. A short description that explains side effects (NOT just "Are you sure?").
3. Two buttons: `<Button variant="outline">Cancel</Button>` and a
   variant-tinted confirm (emerald for go, rose for stop, red for delete).

Notes from dialogs shipped 2026-09-26 → 09-28, each "used by":

- **The built-in ✕** sits `absolute top-2 right-2` (`components/ui/dialog.tsx:67-80`), so a
  custom header reserves `pr-12` — used by `RankingHistoryModal.tsx:110`.
- **Close plays on content.** The primitive animates the close on whatever the popup still
  renders, so the opener keeps the row after close and flips only `open` — used by
  `AppointmentLeaderboardPane.tsx:165-179` / `RankingHistoryModal.tsx:15-17`. The same idea
  outside a dialog: Carla's bubble holds its last view while it floats away
  (`CarlaJamBubble.tsx:59-80`).
- **Escape backs out one layer.** A lightbox over the time-adjustment View modal closes only
  itself (`TimeAdjustmentIssueRows.tsx:242-243, 280`); a chart readout inside the Rankings
  View modal clears on the first Escape, and a second closes the dialog
  (`RankingHistoryChart.tsx:202-206`).
- **Greeting on arrival** — used by `PayrollCycleGreetingModal` ("Hi Kane", 5f22e91b): at
  most once per browser session, only when a step is unfinished, never over another open
  dialog, about 600ms after the data is ready so it lands after the dashboard paints
  (`PayrollCycleGreetingModal.tsx:27-43`). Its shell is `max-h-[85dvh] gap-0 p-0
  sm:max-w-xl` with one scrolling body (`PayrollCycleGreetingModal.tsx:187-247`).

### 10.1 Confirm-then-progress (2026-09-17)

For a confirm whose action has more than one real step, the dialog keeps the
same shell and swaps its footer for a determinate bar
(`EnrollmentGateDialog`, `HrFpuEnrollments.tsx`). Two rules:

- **The bar tracks completed STEPS, never elapsed time.** It advances when the
  write lands and again when the dependent reload finishes, and only reaches the
  end when both are done. A bar that fills on a timer is a lie told to someone
  mid-decision, and it is the reason this pattern is written down rather than
  reinvented per screen.
- **The backdrop stops dismissing while the write is in flight**, and a failure
  keeps the dialog open carrying the server's own sentence plus *Try again* —
  never a toast that disappears while the user is reading it (§12.4).
  > ⚠ **Deviation (2026-09-29, OPEN — Kane's call):** Gift Orders' "Creating invoice"
  > overlay closes on failure and toasts the reason — § 20 D8.

A single-step confirm does NOT get a progress bar. It is a confirm.

Second user of the steps-not-time rule: `InvoiceProgress.tsx` (Gift Orders lock, c6f4d06f,
2026-09-23) — a stepped checklist overlay rather than a footer bar. `locking → pdf → done`
are real phases of the lock, never a timer, and the LOCKED stamp lands only once both
finished (`InvoiceProgress.tsx:7-24, 88-104`).

### 10.2 Full-screen viewer (2026-09-26, used by `ProofLightbox`)

`ProofLightbox` (`TimeAdjustmentIssueRows.tsx:248-473`, 2aebfde3), the Accounting → Issues
proof viewer: `fixed inset-0 z-[70] bg-black/85 backdrop-blur-sm`, `role="dialog"
aria-modal="true"`, focus taken on open and handed back to the thumbnail that opened it. A
"Proof N of M" header; Previous / Next as `h-10 w-10 rounded-full bg-white/10 ring-1
ring-white/20` beside the stage; ←/→ step and wrap, like the manager and employee viewers. A
numbered thumbnail strip underneath shows how many proofs there are, the current one ringed by
a shared `layoutId` and scrolled into view. An expired signed URL keeps its slot and says so
on stage — the count never shrinks silently. Escape closes this layer only (§ 10 notes).

### 10.3 Inline confirm (two users)

For a row-level action, a tinted panel opens under the row instead of a modal: the side
effects in one sentence, then a ghost Cancel and a solid `bg-rose-600` confirm — Gift Orders'
Delete and Reopen (`GiftOrders.tsx:727-751`, c6f4d06f). The two-step variant arms on the first
click and commits on the second — Payment Dispatch's closed-week Reopen
(`PayrollDispatch.tsx:1692-1735`). Neither is a dialog, so § 10's "Confirmation dialogs
always have" list does not describe them.

---

## 11. Tabs (`components/ui/tabs.tsx`)

Built on `@base-ui/react/tabs`. Known caveat: the variant CSS uses
`data-horizontal:flex-col` which doesn't always apply in this Tailwind config.
**If your tabs render side-by-side instead of stacked, force `flex flex-col`
on the `<Tabs>` root.** This is documented in `components/ui/tabs.tsx`.

Tabs come in two stylings:

- `default` variant (filled pill) — `bg-muted` list, `data-active:bg-background data-active:text-foreground` triggers.
- `line` variant — transparent list, underline accent on active.

Always pair with `AnimatePresence mode="wait" initial={false}` if you want
content to cross-fade between tabs:

```
<Tabs value={tab} onValueChange={setTab} className="flex w-full flex-col">
  <TabsList className="self-start">
    <TabsTrigger value="a">A</TabsTrigger>
    <TabsTrigger value="b">B</TabsTrigger>
  </TabsList>
  <AnimatePresence mode="wait" initial={false}>
    <motion.div
      key={tab}
      initial={{ opacity: 0, y: 8 }}
      animate={{ opacity: 1, y: 0 }}
      exit={{ opacity: 0, y: -6 }}
      transition={{ duration: 0.26, ease: [0.22, 1, 0.36, 1] }}
    >
      {tab === 'a' ? <PaneA /> : <PaneB />}
    </motion.div>
  </AnimatePresence>
</Tabs>
```

Note: `<TabsContent>` is omitted when using `AnimatePresence` because base-ui
unmounts the inactive panel before motion can play its exit animation; the
controlled `tab` state lets us drive the swap manually.

### 11.1 Sliding-indicator pill tabs (custom, not `components/ui/tabs`)

For dense in-page tab/filter rows the codebase uses a hand-rolled pill row
instead of the shadcn `<Tabs>` primitive. The signature is a **single gradient
indicator that physically glides between pills** via a Framer `layoutId`
(shared-element transition) rather than each pill toggling its own background.
Canonical references (this table is the set to copy from; the codebase holds about
sixty-five `layoutId` sites — counted 2026-09-29; "about forty" on 2026-09-15 — and
`grep -rn 'layoutId=' src/components` is the inventory):

| Pill component | File | `layoutId` |
| --- | --- | --- |
| `SubTabPill` (Onboarding Form / Pending Hires) | `HrOnboarding.tsx` | `hr-onboarding-subtab` |
| `TabPill` (Awaiting / Ready / Failed / Promoted / …) | `HrOnboarding.tsx` | `hr-pending-tab` |
| `FilterPill` (Awaiting submission / Submitted / Archived / All ┆ Archive icon = Archived/Complete) — **All excludes both archived pills** | `HrOnboardingForm.tsx` | `hr-onboarding-filter` |
| Section strip (Departments / HSL) — **underline variant** | `PayrollWizard.tsx` (Additions step) | `additions-section-indicator` |
| `SlidingTab` (My Team inner tabs · Cards/List · People/Scheduling/Rankings) — **spring variant, § 11.2** | `manager/ManagerApp.tsx` | `myTeamInnerTab` · `myTeamViewMode` · `myTeamDeptView` |
| Department rail row (My Team) — **vertical rail variant, § 11.2** | `manager/ManagerApp.tsx` | `myTeamDeptRail` |
| `SlidingPill` (Accounting Scoreboard section tabs · Setup's Rows / Sections / Members) — orange `from-orange-500 to-amber-600`, 0.28s tween, not a spring | `accounting-scoreboard/shared.tsx` | `acct-sb-section-tab` · `acct-sb-setup-area` |

The **underline variant** is the same mechanism with a different indicator: a 2px
bar (`absolute inset-x-0 bottom-0 h-0.5`) instead of a filled pill, for a strip that
must outrank the pill row beneath it without competing with it. Same shared
`layoutId`, same 0.28s / `[0.22, 1, 0.36, 1]`, same `useReducedMotion()` gate. Each
tab keeps its own tone (the HSL tab is violet, Departments indigo), so the bar
changes colour as it arrives — the danger-pill rule one tier out.

Anatomy (only the active pill renders the indicator; every pill shares the same
`layoutId`, so Framer animates the single element across positions):

```tsx
<button type="button" onClick={onClick} aria-pressed={active}
  className={cn('relative rounded-md px-3 py-1.5 text-[13px] font-medium transition-colors',
    active ? 'text-white' : 'text-zinc-600 hover:bg-emerald-50 hover:text-emerald-900 …')}>
  {active && (
    <motion.span
      layoutId="hr-onboarding-subtab"
      className="absolute inset-0 rounded-md bg-gradient-to-r from-emerald-500 to-teal-700 shadow-sm shadow-emerald-600/25"
      transition={{ duration: reduce ? 0 : 0.28, ease: [0.22, 1, 0.36, 1] }}
    />
  )}
  <span className="relative z-10">{label}</span>
</button>
```

Rules:

- The emerald→teal gradient indicator is the default tone; the count chip is
  `bg-white/20 text-white` when active, neutral zinc otherwise.
- A pill that carries a **danger tone keeps its own color even while the
  indicator slides onto it** — `TabPill`'s `tone="danger"` (the Failed tab)
  swaps the indicator gradient to `from-red-500 to-rose-700` and tints the idle
  label/count red so an unfinished promote stands out whether or not it's
  selected. Don't let the shared indicator flatten a danger pill back to emerald.
- The same rule covers **status tones**: a `FilterPill` `tone` keeps its own
  indicator colour, matching the row badge it filters. On HR → Onboarding the
  plain **Archived** text pill is `tone="muted"` (`from-zinc-500 to-zinc-700`, the
  grey "Archived" badge). The **Archive icon** pill after the divider is
  `tone="sky"` (`from-sky-500 to-sky-700`, the sky "Archived/Complete" badge). It is
  icon-only (`Archive`; the label moves to `aria-label` + `title`) and stays in the
  same tablist, so the indicator still glides onto it. The split is
  `onboardingSubmissionBucket` (`src/lib/hr/onboarding-submission-bucket.ts`):
  archived + linked hire `promoted` ⇒ Archived/Complete, every other archived row
  ⇒ Archived. Neither shows under "All", which is the live pipeline only (Kane,
  2026-09-25). Both are archived views, which keeps the per-row hard Delete out of
  "All".
- The indicator transition is `duration: 0.28, ease: [0.22, 1, 0.36, 1]`,
  **gated behind `useReducedMotion()`** (`reduce ? 0`).
  > ⚠ **Deviation (2026-09-29, OPEN — Kane's call):** about 40 of the ~65 `layoutId`
  > transitions in 21 files are springs, most predating this rule — § 20 D2 (and § 11.2's OPEN).
- `aria-pressed={active}` on every pill; the label/count sit at `relative z-10`
  above the absolute indicator.

Two notes from 2026-09-25 → 09-28:

- **One strip, one id** — used by `PeopleBankSearch.tsx:618-620`: the person page's
  underline takes its own `layoutId` (`search-person-tab-underline`) because the People
  popup can open over the page, and a shared id would fly the popup's underline across the
  screen between the two.
- **A static segmented control exists too.** `Segmented` (`manager/leaderboard-ui.tsx:32-70`)
  is `role="tablist"` / `role="tab"` + `aria-selected`, a white active pill with
  `text-blue-700`, and **no** `layoutId` — the pill swaps, it does not glide. Used by My
  Team → Rankings' Average and Window toggles (`AppointmentLeaderboardPane.tsx:252-267`) and
  the Rankings View modal (`RankingHistoryModal.tsx:130-135`). See § 17.5 and § 20 D3.

The associated **panel content** does a directional crossfade/slide keyed on the
active value, wrapped in `overflow-x-clip` so the horizontal slide never spawns
a page scrollbar (and, unlike `overflow-x-hidden`, doesn't turn the wrapper into
a scroll container that would break a sticky table header). The slide direction
tracks which pill the user moved toward (`dir` +1 forward / −1 back), e.g.
`HrOnboarding.tsx`:

```tsx
const SUB_TAB_VARIANTS = {
  enter: (dir: number) => ({ opacity: 0, x: dir >= 0 ? 28 : -28 }),
  center: { opacity: 1, x: 0 },
  exit:  (dir: number) => ({ opacity: 0, x: dir >= 0 ? -28 : 28 }),
};
// …
<div className="overflow-x-clip">
  <AnimatePresence mode="wait" initial={false} custom={subDir}>
    <motion.div key={subTab} custom={subDir} variants={SUB_TAB_VARIANTS}
      initial="enter" animate="center" exit="exit"
      transition={{ duration: reduceMotion ? 0 : 0.22, ease: [0.22, 1, 0.36, 1] }} />
  </AnimatePresence>
</div>
```

### 11.2 `SlidingTab` and the vertical rail (Manager → My Team, 2026-09-14)

My Team has four selectors on one screen — the three inner tabs, the department
rail, Cards/List, and HSL's People/Scheduling/Rankings — and each used to swap a
static white pill instantly. They now share one component, `SlidingTab`
(`src/components/manager/ManagerApp.tsx`), and one `layoutId` per **group**, so the
indicator travels between siblings instead of re-appearing somewhere else. Kane:
*"animate it properly please smoothen the tab switching within the my team."* Feature
doc: `manager-my-team.md` § *Motion*.

What it keeps from § 11.1: only the selected item renders the indicator; the
indicator is an `absolute inset-0` **background element** (`-z-10` under an `isolate`
button), so text never reflows and no 300-row list is asked to move; and the
indicator **survives reduced motion** — it carries which tab is active — with only the
travel dropped (`duration: 0`).

What differs — **recorded here, not ratified**:

| | § 11.1 rule | `SlidingTab` as shipped |
| --- | --- | --- |
| Indicator transition | `duration: 0.28, ease: [0.22, 1, 0.36, 1]` | `{ type: 'spring', stiffness: 520, damping: 38, mass: 0.7 }`; the rail row uses `460 / 40 / 0.8` |
| Indicator tone | emerald→teal gradient | flat `bg-white shadow-sm` (dark `bg-zinc-950`); the rail row `bg-blue-50 ring-1 ring-blue-200` |
| ARIA | `aria-pressed={active}` | `role="tab"` + `aria-selected` |
| Panel swap | `AnimatePresence mode="wait"` with a directional slide | **no `mode="wait"`** — panes settle in over `0.22` on `[0.22, 1, 0.36, 1]` (`TEAM_EASE`) while the old one is already gone, because waiting doubles the perceived latency of every click on a surface people work in rather than look at. Pane keys cover both axes (tab AND department) |

> **OPEN — spring vs ease.** § 11.1 and § 18 item 8 name only the two eases; this is
> not the first indicator on a spring — about 40 `layoutId` transitions in 21 files already
> ran on one (e.g. `EmployeeProfile.tsx:794` 2026-05-03, `HrMesa.tsx:161` 2026-05-15,
> `BonusCatalog.tsx:1352` 2026-06-12 and eight more in that file, `PayProcessorsTab.tsx:1359`
> 2026-09-03, `CompensationSections.tsx:94` 2026-09-12). (Corrected 2026-09-29; this sentence
> read "this is the first indicator on a spring".) Either the rule gains a spring allowance, with
> these parameters as the reference, or the component moves to the 0.28 ease. Not
> decided here — logged 2026-09-15 (Sep 14 session log, row 109). Do not resolve it
> by editing only one side.
>
> **Scope widened 2026-09-29 (note, not a ruling):** since 09-15 the same question covers
> more than springs — ease-in exits `[0.4, 0, 1, 1]`, ease-in-out travel `[0.4, 0, 0.2, 1]`,
> a JS `easeOutCubic` wipe, and further springs (inventory in § 14.1; § 20 D1, D2). Row 109
> was not carried into the Sep 16, 23 or 25 session logs' Open items.

**The vertical rail variant.** The department rail is a tall, nested list — parents
disclosing their `hsl:*` sub-teams — and it is where the glide earns the most: moving
from a parent to a sub-team three rows down is a jump the eye would otherwise have to
re-find. One `layoutId` (`myTeamDeptRail`) serves the whole rail. Each row carries a
headcount in `font-mono tabular-nums` that stays **AA** (`zinc-500`, 4.6:1 on white —
`zinc-400` at 2.8:1 failed) and, while a search is live, a blue match-count chip. Below
`lg` the rail is replaced by a flat `SmoothSelect` with the sub-teams **indented, not
dropped** — dropping them would make the whole HSL family unreachable on a phone. A
manager with a single department gets no rail at all.

The roster-card stagger is capped at **180ms** (`Math.min(idx * 0.025, 0.18)`), inside
the § 14.3 envelope; uncapped, a large department reads as the page loading slowly.

---

## 12. Empty / loading / error states

Three states, three visual treatments. Never share copy or styling between
them.

### 12.1 Empty (success-shaped)

A gradient sparkle tile saying "queue clear" / "all paid" / "no disputes".
Default tone: emerald. Header is medium weight, sub-line is muted.

```
<div className="flex h-full items-center justify-center px-6 py-16 text-center">
  <div>
    <motion.div className="mx-auto mb-3 flex h-12 w-12 items-center justify-center rounded-2xl bg-gradient-to-br from-emerald-400 to-teal-500 text-white shadow-md">
      <Sparkles className="h-6 w-6" />
    </motion.div>
    <h3 className="text-sm font-semibold">No pending payments</h3>
    <p className="mt-1 text-xs text-zinc-500">…</p>
  </div>
</div>
```

### 12.2 No-results (filter-shaped)

Same shape, but zinc tile + `<SearchX>` icon + the query rendered in mono
inside a small chip + a "Clear search" pill below. See `ProcessorQueue.NoMatchesState`.

> ⚠ **Deviation (2026-09-29, OPEN — Kane's call):** `RankingsNoMatch` and People → Search
> Bar render a text-only dashed card with the query in curly quotes and no Clear pill —
> § 20 D4.

### 12.3 Loading

Three flavors:

- **Skeleton** for table-style content (`QueueSkeleton`; `ReportListSkeleton` was also
  named here — deleted 2026-08-12 with the Reports tab, 4c556c02).
  Preserves layout — pulses the row outlines.
- **Skeleton shaped like what arrives** (2026-09-27, 34e31cab) — `RankingsSkeleton`
  (`src/components/team/RankingsSkeleton.tsx:3-13`): the header bar, the top-3 podium, then
  the rows, on the same card classes, so the real view lands in place instead of pushing the
  list down when the podium appears. One component for all three Rankings views, so they
  cannot drift into three skeletons; `podium={false}` where no podium will appear
  (`RankingsPane.tsx:128-129`). Two skeleton primitives exist: `<Skeleton>`
  (`components/ui/skeleton.tsx`, `animate-pulse`, 18 importers) and `.skeleton-shimmer`
  (`src/index.css:960-981`, a sweep that becomes a still zinc bar under reduced motion,
  `src/index.css:1017-1026`).
- **A refetch never re-skeletons** (three users). Painted figures stay on screen: the KPI
  insight cards dim a refetch to `opacity-60` (`KpiInsightCards.tsx:12-14, 176`), the
  Payroll Notes card keeps what is on screen through a background failure
  (`PayrollNotesSetupCard.tsx:37-42`), and Diagnostics' background refresh "covers nothing"
  (`performance-ui.tsx:36-38`). A skeleton is for the first paint.
- **Spinner** for non-tabular ("Loading payment history…", profile detail).
  `<Loader2 className="h-4 w-4 animate-spin text-orange-500" />` + a tiny-caps
  caption.
- **Inline pulse** for a single async asset inside its own frame — e.g. a
  loading brand logo (`ProcessorLogo.tsx`, §6.4):
  `<div className="absolute inset-x-2 inset-y-3 animate-pulse rounded-md bg-zinc-200/80 motion-reduce:animate-none" />`.
  Guard it: an image can be `complete` before React hydrates, so `onLoad` never
  fires — a ref callback that checks `el.complete && el.naturalWidth > 0` and
  skips the skeleton avoids a permanent shimmer on cached images.

- **Per-field placeholder** for a *document* whose individual figures arrive on
  separate clocks — currently only the pay statement (`.paystub-pending-bar`,
  `paystub-dispatch.md` § *Per-line load state*). Three states, never two:
  `pending` is a grey shimmer, **`unavailable` is amber and STATIC**. A terminal
  state must never animate — an animation promises an arrival.
  Amber is right there and wrong for `pending`: amber is the warning colour
  (§ 12.4, and `payroll-wizard-pab-step.md`'s "missing evidence is a warning to
  check"), a fetch still in flight is not a warning, and a failed one is.
  The bar is light-locked — no `.dark` variant — because the statement is a
  document in both app themes.

Reading-state captions follow this format:
`<p className="font-mono text-[10px] uppercase tracking-[0.22em] text-zinc-400">Reading ledger</p>`.
Use a verb that matches the domain ("Reading ledger", "Loading roster",
"Tallying disputes") rather than the generic "Loading…".

### 12.4 Error

```
<div className="flex h-full flex-col items-center justify-center gap-3 px-6 text-center">
  <div className="flex h-12 w-12 items-center justify-center rounded-2xl bg-gradient-to-br from-red-500 to-rose-600 text-white shadow-lg shadow-rose-500/30">
    <AlertTriangle className="h-6 w-6" />
  </div>
  <h2 className="text-base font-semibold">{title}</h2>
  <p className="max-w-md text-xs text-zinc-500 dark:text-zinc-400">{message}</p>
  <Button variant="outline" size="sm" onClick={onBack}>Back</Button>
</div>
```

Always show the **actual error message** in the sub-line. Don't replace it
with a friendly rewrite — internal users want to know what failed.

### 12.5 Absence is not zero (2026-09-29, four users)

A value that was never recorded renders as absence — "—", "No entry", a hatch, a flat stub —
never as 0, and a loading or failed read never renders as success:

- Current Paycycle days: `null` means the upload has no cell for that day and shows "—", not
  "0.00" (`CurrentPaycycle.tsx:35-37`).
- KPI spotlight bars: a week the department did not send is a 1px stub on the baseline,
  never a zero-height column that reads as ₱0 (`KpiInsightCards.tsx:364-390`).
- Payment Dispatch: a processor shows the green **done** check only if it had payments this
  week and none are left; an unused processor keeps its plain 0, and nothing shows while
  loading (`PayrollDispatch.tsx:1944`; `ProcessorCard.tsx:167-175`; 277352b0).
- Charts: § 19 rules 2–3. The Rankings View table prints "No entry" and "—"
  (`RankingHistoryModal.tsx:299-315`).

---

## 13. Typography scale

Observed scale, top-down (do not introduce intermediate sizes without good
reason):

| Use | Class | Notes |
| --- | --- | --- |
| Hero number (financial display) | `text-[40px] font-medium … sm:text-[56px]` mono | Counter animation, tight tracking |
| Page H1 | `text-xl font-semibold tracking-tight sm:text-2xl` (branded: `PayrollDispatch.tsx:1657-1661`, `EmployeeDashboard.tsx:2776`; Employee Profile `text-[20px] font-semibold tracking-[-0.02em] sm:text-[28px]`, `EmployeeProfile.tsx:1992`) / `text-base font-semibold sm:text-xl` (editorial) | Branded was `text-xl font-bold tracking-tight sm:text-[28px]`; no page H1 uses `font-bold` any more — Payment Dispatch moved 2026-09-24, f957cb10 (changed in code; no ruling recorded) |
| Section heading | `text-base font-semibold` | Card / panel titles |
| Body | `text-sm` | The default. |
| Caption / body-sm | `text-xs text-zinc-500` | |
| Tiny / mono ID | `text-[11px]` mono | Emails, transaction IDs, employee IDs |
| Tiny caps (most common) | `text-[10px] font-semibold uppercase tracking-[0.14em]` | Labels everywhere |
| Ultra-tiny caps | `text-[9px] uppercase tracking-[0.18em]` | Date stamps, ledger column labels |

Fonts:

- `font-sans` is the default body family (whatever Tailwind's defaults resolve
  in this config).
- `font-mono` is used for: emails, employee IDs, all numeric tabular data
  (`tabular-nums` always), file names, transaction IDs, dates in stamp form,
  and tiny-caps captions.
- `font-heading` is referenced by `Card.CardTitle` and `Dialog.DialogTitle`
  but not heavily customized — the project uses it as a synonym for the
  default sans family.

Tracking conventions:

- Body / headings: default tracking
- Tiny caps: `tracking-[0.14em]` (most), `tracking-[0.18em]` (ledger), `tracking-[0.22em]` (most caption-y)
- Hero numbers: `tracking-tight`

Tabular numerals (`tabular-nums`) is **mandatory** for any column or stat
that aligns under another number. The two together (`font-mono tabular-nums`)
are the canonical "money / hours / counters" treatment.

---

## 14. Motion

The project uses `motion/react` (Framer Motion successor). One canonical ease
curve and a small set of stagger / delay constants.

### 14.1 Standard ease

```
ease: [0.16, 1, 0.3, 1]   // refined ease-out (most enter / settle)
ease: [0.22, 1, 0.36, 1]  // dialog enter, tab swap (slightly less aggressive)
```

Use one of these two — do not introduce custom curves.

> ⚠ **Deviation (2026-09-29, OPEN — Kane's call):** shipped code uses at least three more
> curves and ~40 springs (inventory below) — § 20 D1; the same ruling as § 11.2's OPEN.

> **Observed in shipped code (2026-09-29), not ratified:**
> - exit ease-in `[0.4, 0, 1, 1]` — `issue-row-motion.tsx:48`,
>   `TimeAdjustmentIssueRows.tsx:315`, `ManagerApp.tsx:4023, 4319`, `GiftTracker.tsx:351`,
>   `CollabLayer.tsx:576, 720`, `EmployeeLeaves.tsx:923`; the Dialog primitive's own close is
>   `ease-in` (`components/ui/dialog.tsx:59`);
> - travel ease-in-out `[0.4, 0, 0.2, 1]` — `PeopleBankSearch.tsx:75` (`TRAVEL`, for a ~280px
>   move where expo-out lurched 21% in one frame, measured in `people-bank-search.md` § 7),
>   `HrApp.tsx:837, 881`, `MarkPaidDialog.tsx:667`, `OrphanageMarkPaidDialog.tsx:239`, `SWall.tsx:69`;
> - `easeOutCubic` as a JS function for a chart wipe — `KpiInsightCards.tsx:646`;
> - `cubic-bezier(0.45, 0, 0.55, 1)` for the ID-card sheen — `EmployeeIdCard.tsx:136`;
> - CSS keyword `ease-in-out` / `ease-out` / `linear` on ambient loops —
>   `CarlaJamBubble.tsx:250-279`, `InvoiceProgress.tsx:62-63`;
> - springs on ~40 `layoutId` indicators (§ 11.1, § 11.2) and on chart crosshairs / markers
>   (`KpiInsightCards.tsx:717-718, 912`).

### 14.2 Standard durations

| Use | Duration |
| --- | --- |
| Element fade-in on mount | `0.2 – 0.3s` |
| Tab swap (cross-fade) | `0.26s` |
| Dialog open | `0.32s` (320ms) |
| Dialog close | `0.18s` |
| Drawer slide (sidebar) | `0.3s` (CSS transition, not motion) |
| Hover reveals | `0.2s` |

### 14.3 Stagger patterns

Row reveal: `staggerChildren: 0.025 – 0.04, delayChildren: 0.05 – 0.08`. For
~12+ rows, cap the per-row delay (`Math.min(i * 0.012, 0.2)`) so very long
lists don't take seconds to fully reveal.

**Per-row table stagger-in** (used when a table is wrapped in
`AnimatePresence`, e.g. the HR Onboarding tables): each `motion.tr` does
`initial={{ opacity: 0, y: 4 }} → animate={{ opacity: 1, y: 0 }}` over
`duration: 0.18, ease: 'easeOut'` with a **per-index delay capped** so a long
list never crawls — `delay: reduceMotion ? 0 : Math.min(i * 0.02, 0.2)` in
`HrOnboarding.tsx` (the pending-hires table also gives a **snappier exit**,
`{ opacity: 0, y: -4, transition: { duration: 0.12 } }`). The
`HrOnboardingForm.tsx` submissions table uses the same shape with a slightly
larger cap (`Math.min(i * 0.025, 0.25)`) and **no exit** — its rows are keyed
`` `${filter}:${r.id}` `` so switching filter remounts them and replays the
cascade. Always gate the delay on `useReducedMotion()`. The My Team roster cards cap
at `Math.min(idx * 0.025, 0.18)` (§ 11.2).

**Rows that leave and rows that change** — used by Accounting → Issues (`IssueMotionRow`,
`issue-row-motion.tsx:37-60`, 2aebfde3, shared by both row kinds so they never move
differently in one table): rows rise on `[0.16, 1, 0.3, 1]` with
`Math.min(index * 0.028, 0.2)`; a row leaving the view drifts `x: -14` while the rest close
the gap with `layout="position"` (position only, so a wrapped explanation never
scale-distorts); a row whose status changed between two reads sweeps its outcome colour once
(`.issue-row-flash`, 1.5s, `src/index.css:1156-1168`; which rows is the pure
`src/lib/accounting/issue-row-flash.ts`), and its badge swaps in place (`IssueStatusSwap`).
The sweep stays on under reduced motion because it IS the confirmation — § 16's "stop travel,
keep the signal". Search is not in the body key, so typing never replays the entrance.

### 14.4 Hover affordance

Three patterns in use:

- **Whole row, color shift** — `hover:bg-orange-50/40` etc. No transform.
- **Card, lift** — `whileHover={{ y: -1 }}` with a spring `{ type: 'spring', stiffness: 320, damping: 24 }`.
- **Left-edge accent rule** — absolutely positioned 1px line, `origin-top scale-y-0 transition-transform group-hover:scale-y-100`.

### 14.5 Reduced motion

Honor `useReducedMotion()` from `motion/react` for any animation longer than
~300ms or any number-counter. Snap to the final value. Example: `CountUp`
in `PaymentHistoryPanel` (deleted but the pattern is canonical). Don't ship
mount animations that the user can't bypass.

> ⚠ **Deviation (2026-09-29, OPEN — Kane's call):** the Start Processing peer modal runs
> four infinite motion loops with no reduced-motion gate — § 20 D12.

What the platform does for you, and what it does not: under reduced motion a global rule
kills every CSS **transition** (`transition: none !important`, `src/index.css:873-878`). It
does not reach CSS keyframe animations or `motion/react` — there is no `MotionConfig` in the
app — so every JS animation and keyframe loop gates itself, with `useReducedMotion()` or
`@media (prefers-reduced-motion: no-preference)` around the keyframes
(`CarlaJamBubble.tsx:250-279`). A live counter in current code: `AnimatedPeso`
(`KpiInsightCards.tsx:96-121`), which snaps under reduced motion — see D9 on its digits.

**Rolling / slot-machine counters** (e.g. the Accounting Overview "Total Payout
Value" spin) are the same `CountUp` contract: ease to the real figure, then hold;
under reduced motion, render the final number with no roll. If you mask digit
strips with `overflow-hidden` + `translateY`, keep the mask window sized to one
row and avoid `will-change: transform` leaking cells outside it (a
headless-Chromium rasterization quirk seen while building it — harmless in real
browsers, but don't rely on `will-change` to clip). Prefer `tabular-nums` so
digits don't reflow as they change.

> ⚠ **Deviation (2026-09-29, OPEN — Kane's call):** `AnimatedPeso` rolls for 0.9s in
> proportional figures by choice ("a standalone number, not a column") — § 20 D9.

### 14.6 Theme-toggle / view-switch

The theme toggle uses the `withViewTransition` helper (`@/lib/theme/with-view-transition`)
which calls the View Transitions API when available, gracefully degrading to
no-animation otherwise. Don't reinvent — call the helper. The **view switch does not** use
it: `ViewSwitcher` paints `DashboardSwitchLoader` this frame and pushes the route on the next
(§ 4.1, `ViewSwitcher.tsx:80-99`). (This paragraph read "Both use the `withViewTransition`
helper … `ViewSwitcher` additionally injects an overlay card with a 700ms ring expand" —
changed 2026-07-22, 0e1c3626; changed in code, no ruling recorded.)

The overlay card is **themed to the destination dashboard**, so the transition
reads as a continuous colored move from click to landed view. Both the click-time
overlay (`ViewSwitcher.tsx`) and the route-level loader render the one shared
`DashboardSwitchLoader.tsx`, which looks up a `TONES[view]` record (keyed by
`AppView`) for the card border/shadow, pulsing emblem gradient, rings, text,
dots, and progress bar; view-less routes fall back to orange. When adding a new
surface, add its `TONES` entry (mirror the dashboard's §17 accent) — and keep
every Tailwind value a **complete literal string** (no interpolated fragments),
or the JIT compiler drops the class.

### 14.7 Background orbs (branded only)

Decorative blurred blobs (`<motion.div className="absolute … rounded-full bg-orange-300/30 blur-3xl" />`) are reserved for the highest-traffic branded
landing pages (`PayrollDispatch`). They fade in over `0.8 – 1.2s`. Don't use
on any editorial surface.

### 14.8 Live-presence avatar rail (Accounting collab)

The floating right-edge "who's in Accounting" rail
(`src/components/accounting/AccountingCollabLayer.tsx`) is the canonical
presence-roster animation. Conventions to copy if you build another presence rail:

- **No `overflow`/`max-h` on the rail container.** The avatar's decorations
  render *outside* its box — the name card pops out to the left (`right-full`)
  and the online/eye badges sit at the avatar's corners — so any clipping
  container (incl. `overflow-y-auto`) would shear them off (and add a
  scrollbar). To stay on-screen without a scrollbar, **cap the visible
  avatars** at `MAX_RAIL_AVATARS = 9` and collapse the remainder into a `+N`
  chip (a same-sized `h-11 w-11` zinc bubble).
- **Join/leave pop** via `<AnimatePresence mode="popLayout">`: each `RailAvatar`
  enters `{ opacity: 0, scale: 0.2, x: 24 } → { opacity: 1, scale: 1, x: 0 }`
  and exits the reverse, on a `POP_SPRING`
  (`{ type: 'spring', stiffness: 520, damping: 24, mass: 0.7 }`) tuned to
  overshoot so the avatar "pops" rather than eases in. Remaining avatars
  reflow with `layout="position"`.
- **Staggered initial cascade**: `delay: Math.min(index * 0.06, 0.42)` so a
  fresh roster cascades in, capped so a large team never feels sluggish.
- **44px raised chips** (`h-11 w-11`) with a layered `boxShadow` ring whose
  color encodes state: **orange glow when observing** that peer, the peer's own
  **cursor color when same-section** (their pointer is observable right now),
  and a soft neutral white ring + drop shadow otherwise (reads as a chip
  floating over the page).
- **Pulsing online badge**: an emerald dot with a looping ping halo
  (`opacity 0.55→0, scale 1→2.1`, `repeat: Infinity`), the halo `aria-hidden`
  by virtue of being decorative (see §16 — pair live indicators with text).

---

## 15. Color tokens (semantic, used everywhere)

Tailwind defaults in use, mapped to semantic intent:

| Intent | Light | Dark |
| --- | --- | --- |
| Primary brand | `orange-500 → orange-600` (gradient) | `orange-400 / 500` |
| Success / paid | `emerald-500 → teal-500` (gradient), `emerald-700` text | `emerald-400 / emerald-300` |
| Warning / pending / threshold | `amber-500 → orange-500` (gradient), `amber-700` text | `amber-400 / amber-300` |
| Danger / problem | `rose-500 → red-600` (gradient), `rose-700` text | `rose-400 / rose-300` |
| Information / dispatched | `violet-500 → fuchsia-500` (gradient), `violet-700` text | `violet-400 / violet-300` |
| Surface neutral | `zinc-50, zinc-100, zinc-200, zinc-500, zinc-700, zinc-900` | `zinc-950, zinc-900, zinc-800, zinc-500, zinc-300, zinc-100` |
| Hairline | `border-[#ececec]` light, `border-zinc-800` dark | (these specific hex values used in editorial sidebars) |
| Editorial canvas | `bg-[#fafaf8]` light, `bg-[#0a0d12]` / `bg-zinc-950` dark | |
| Branded canvas (Accounting body) | `bg-[#0d1117]` dark base | |

Do not introduce a sixth status color (e.g. teal, indigo) without updating
this table. The five colors above carry semantic weight across the app.

> ⚠ **Deviation (2026-09-29, OPEN — Kane's call):** the Accounting → Issues "moved" flash is
> indigo (`src/index.css:1165, 1168`) — § 20 D6.

### 15.1 `--primary` cannot carry small text

**Measured 2026-09-02 on the Manager Overview: `--primary` orange is 2.7:1 against
these surfaces — below AA for text of any size.** It is a brand and fill colour, not
an ink. When a surface needs an accent that small text can sit in, use `--secondary`
blue; the Overview does exactly this and documents why
([manager-overview.md](../features/manager-overview.md)). Emerald stays reserved for
presence, because "online" is its own meaning rather than an accent.

### 15.2 Tone classes must be literal — never interpolated

Tailwind compiles the classes it can **see in the source**. A computed class name
(`` `border-${tone}-200 bg-${tone}-50` ``) is absent from the build output and renders
**unstyled with no error**. Write every branch out in full, even when that means
repeating five near-identical strings:

```tsx
// wrong — silently unstyled
className={`border-${tone}-200 bg-${tone}-50 text-${tone}-900`}
// right
tone === 'blue' ? 'border-blue-200 bg-blue-50 text-blue-900' : …
```

This has bitten twice: the Manager Time Adjustments workspace and the Employee
My Hours day tiles.

### 15.3 Ink on a coloured ground comes from that ground

Neutral zinc/grey text on a tinted fill is the `gray-on-color` defect the design
detector flags, and it is usually real. **Retint the text to the ground's own hue**
— slate on the Overview's `bg-secondary/[0.06]` greeting, `text-orange-950` on the
My Hours weekend tile, the Time Adjustments explanation ink to its own fill
(`b97637e3`). A waiver is only correct when the coloured ground exists **solely on
hover** and the text turns with it; waive it file-scoped in `.impeccable/config.json`
with the reasoning in the commit message, never by changing the resting colour.

### 15.4 The design detector (`.impeccable/config.json`, 2026-09-29)

`detector.ignoreValues` is the only waiver mechanism in use — no `ignoreRules`, no
`ignoreFiles`. A rule is waived per file (`value: "*"`, `files: [...]`); a value rule is
waived per value (`bounce-easing` → `jam-wobble`, d9dc6322 — the impeccable skill's own
procedure for value findings). Every entry carries `createdAt` and a `reason` naming who
decided (Kane, or a Claude session id) and the evidence. Rules waived so far:
`gray-on-color` (11 files, every one a hover-only ground, § 15.3), `broken-image` (4 —
runtime signed URLs, or files with no JSX), `gradient-text` (1), `bounce-easing` (1).
`.impeccable/hook.cache.json` is local (`.git/info/exclude`).

Two findings, recorded here and not acted on (§ 20 D14):

- The `gradient-text` waiver for `src/components/payroll-clerk/PayrollDispatch.tsx` has
  outlived its subject: the orange→rose "Welcome back" fill was removed 2026-09-24
  (f957cb10), and the doc line it cites (`payment-dispatch.md:39`) no longer mentions it.
- `EmployeeDashboard.tsx:2780` renders a `bg-clip-text text-transparent` orange→rose
  gradient on the greeting name with no waiver.

---

## 16. Accessibility checklist

Every new surface must:

- Have a single root `role` / `aria-label` for the navigation drawer
  (`<aside id="<surface>-sidebar-nav" role="navigation" aria-label="<surface> navigation">`).
- Wire the mobile hamburger with `aria-expanded={mobileOpen}` and
  `aria-controls="<surface>-sidebar-nav"`.
- Listen for `keydown` Escape on the document while the drawer is open and
  close it.
- Render an `aria-hidden` decorative icon if the icon has a visible label
  next to it — never both readable.
- Mark live status indicators (`<span className="animate-ping">`) `aria-hidden`
  and provide the textual status separately.
- Use `<Label htmlFor>` for every form field.
- Use `<button type="button">` explicitly for any non-submit button — without
  it the browser defaults to `submit` and breaks form flows.
- Include `aria-label` on icon-only buttons (`<Menu>` hamburger, `<X>` close,
  toggle buttons).
- Never place neutral grey text on a tinted ground — retint it to the ground's own
  hue (§15.3), and never use `--primary` for text (§15.1, 2.7:1).
- Respect `prefers-reduced-motion` by stopping travel, not by removing the signal:
  the KPI Calculator's payroll-lock rim stays lit and stops rotating.
- Auto-rotating content pauses on hover and on keyboard focus (§ 6.5).
- A chart is one tab stop with ←/→ (Home/End), an `aria-live` sentence per point, and a
  table twin carrying every value (§ 19 rules 13–14).

---

## 17. Per-dashboard quick reference

### 17.1 Accounting (`/accounting`)

- Family: branded
- Sidebar: 256px wide, orange/blue gradient, 'Accounting HRIS' caption above
  logo
- Header: editorial breadcrumb header at the page level for most tabs;
  branded hero header on `Overview`
- Notable surfaces: `Overview` (mixed densities), `PayrollWizard` (its own deep
  convention — do not modify; its
  Step-8 paystub preview is a *document* and follows § 12.3's per-field rule,
  not app-table chrome),
  `PabDisputeQueue` (table + dialog), `LeaveRequestsPanel`. (`Rates`, the editorial
  card-list this list also named, was deleted with its tab — § 1.2.)
- Nav (2026-09-29, `Sidebar.tsx:64-75`): Overview · People · Payroll Wizard · Payment
  Catalog · Payment Dispatch · Issues · Transfers · MESA · Documents · Announcements ·
  Notifications · System Settings.
- Since 2026-09-26: Overview's **Payroll Notes · Steps 1–8** card replaced New hires +
  Attrition (§ 6.5, da7d22f5); the shell mounts the "Hi Kane" greeting modal (§ 10 notes,
  5f22e91b); **Issues** runs both row kinds through `IssueMotionRow` (§ 14.3) with the proof
  viewer (§ 10.2); **People** opens on the Search Bar (§ 9.2, 9258059e) whose person page has
  Profile / Payroll / PAB tabs (7480c046).

### 17.2 Payroll Clerk (`/payroll-clerk`)

- Family: branded (with editorial sidebar)
- Sidebar: 220px wide, editorial zinc with a "cycle ready" pill above the nav
- Hero header: backgroundOrbs kept; a muted "Welcome back, {name}" line, the pay week
  as the H1 with the week switcher beside it, and the processing status + Start/Stop as one
  bordered group (§ 3.2.2 *As shipped*); three hero stats (Pending / Sent / Paid). Was
  "branded with backgroundOrbs, "Welcome back, {name} 👋"" until 2026-09-24 (e7f67ad2,
  f957cb10, d309dc61 — Kane's requests).
- Filter rail (left within the body): processor cards (`ProcessorCard`),
  vertical on lg, horizontal scroll on sm. A processor that had payments this week and has
  none left shows a green check instead of 0 (§ 12.5, 277352b0).
- Table: editorial card-list (`ProcessorQueue`), one row per recipient
- Reports drilldown: ledger-style row layout — retired with the Reports tab 2026-08-12
  (4c556c02; § 5.3 keeps the spec).

### 17.3 Admin (`/admin`)

- Family: editorial
- Sidebar: 220px wide, editorial zinc with two section dividers ('System' /
  'Security')
- Header: editorial breadcrumb header (`Admin / Overview / kaner@simple.biz`)
  with three small action pills on the right (Sync, Export Audit, Roles)
- Body: hairline panels in a flex row on lg, single scrollable column below
  lg (see `AdminOverview` mobile fix)
- Nav (2026-09-29, `AdminSidebar.tsx:60-84`): System — Overview · Penny AI · Roles &
  permissions · Global Master List · Google Workspace · Webhooks & Integrations (with the
  Data catalog, ab361ae3) · Pages · Design & Specifications · Notifications; Security —
  Audit log · Diagnostics (scoped service maps; the Performance tabs carry
  `CycleTrendChart`, § 19) · API tokens · Backups.

### 17.4 CEO (`/ceo`)

- Family: tinted editorial, yellow / amber (§ 1.2) — was "editorial" / "Crown icon as
  brand cue; otherwise mirrors Admin's chrome"; the rail has been yellow/amber since
  2026-05-04, b274b489 (changed in code; no ruling recorded)
- Rail: `from-white via-yellow-50/30 to-white`, selected `from-yellow-500 to-amber-600
  text-white`, `SidebarLogoHeader` tile `from-yellow-500 to-amber-600`
  (`CeoSidebar.tsx:83, 108, 115`)
- Surfaces are read-only summary panels — no destructive actions in the
  default ribbon

### 17.5 Manager (`/manager`)

- Family: tinted editorial, blue (§ 1.2) — was "editorial"; the rail has been blue since
  2026-04-30, 19f384c9 (changed in code; no ruling recorded)
- 'Manager' caption under the brand mark; nav scoped to the manager's
  department members + leave requests + orphanage create
- Nav (2026-09-29, `ManagerSidebar.tsx:176-234`): Overview · Time adjustments · Leaves ·
  My team · Transfers · Announcements · S-Wall (violet→indigo selected state,
  `ManagerSidebar.tsx:206-208`) · *Bonuses*: KPI Calculator · Notifications (Bonus History retired
  2026-09-29)
- My Team (2026-09-14): a vertical **department rail** is the outer axis — no
  "All" entry, HSL folded to one parent, a granted-but-empty department still
  shows a 0 tab — then Roster / New Hire Check List / Orientation, with the
  per-department views (HSL Scheduling, AI/API Rankings) beside the search. Every
  selector on the screen is a `SlidingTab` (§ 11.2). Doc: `manager-my-team.md`.
  > ⚠ **Deviation (2026-09-29, OPEN — Kane's call):** the Rankings views use the static
  > `Segmented` toggle and a `SmoothSelect` KPI picker — § 20 D3.
- My Team → **Rankings** (2026-09-26 → 09-28): every per-person KPI-bonus department, PM
  Team, Lead Gen appointments, HR / QC / Accounting team boards and the HSL sub-teams. Each
  board opens with the § 8.5 podium, carries the 26px `RankingsSearch` (§ 9.2), loads as the
  board-shaped `RankingsSkeleton` (§ 12.3), pages with "Show 25 more" (§ 5.6), and has a
  **View** row action (`Button variant="outline" size="sm"`, blue tint, `ChartLine` icon,
  `AppointmentLeaderboardPane.tsx:606-621`) opening `RankingHistoryModal` (§ 10, § 19).
  The "Showing active roster members in …" header line was dropped (459d65a2).
- My Team → **Orientation** pages its weeks and each week's people at 10 (§ 5.6, a8507246).
- **KPI Calculator** opens on three insight cards — Department spotlight (§ 6.5), Top earner
  (a 44px initials avatar whose ring is a `border-2`, inside the box, because a `0 0 0 2px`
  box-shadow ring was sliced by the card's `overflow-hidden`, `KpiInsightCards.tsx:527-536`),
  and the Sent-to-Accounting trend (§ 19) — `kpi-calculator-insights.md`, 98a9ecc7.

### 17.6 Orphanage (`/orphanage`)

- Family: branded, pink/rose accent (heart icon)
- Distinct from the others — used by Alyson for orphanage dispute creation
- Calendar grid is the centerpiece; uses the shared
  `<CreateOrphanageStyleDisputeDialog>`

### 17.7 Employee (`/employee`)

- Family: branded (mirrors Accounting closely)
- Per-employee landing with hero, hours summary, dispute filing,
  announcements; all ScrollArea-bounded — "dispute filing" is out of date: the employee
  disputes tab has been hidden (`EmployeeSidebar.tsx:85`, "disputes now go through Orphanage
  Manager → Accounting flow")
- Nav (2026-09-29, `EmployeeSidebar.tsx:77-92`): Overview · Profile · Time Adjustments ·
  KPI Results · Leave · MESA · My Team · Approvals (only for someone a manager named as
  second approver, `EmployeeSidebar.tsx:88-91`) · Notifications
- Overview: greeting H1 (§ 3.2.2 *As shipped*), the PAB calendar following a wizard PAB
  Period save live (bbdea24a), and the header **Help** control — a popover with exactly two
  doors, Chat Support and Raise a ticket (`EmployeeHelpMenu.tsx`, 386c5c10; § 1.5)
- Profile: four chips — Overview (Personal / Employment / Address on the left, the ID card in
  a fixed 372px right track at a ≥56rem pane, § 6.6, 0d5e26e2) · Compensation (Rates · Pay
  Stubs · Payout · Current Paycycle, e3ee5541) · Skill Sets · Request Documents; dark
  `#0d1117` like every Employee tab (§ 1.3, b7e954c8)
- My Team: the SP Rankings pane without a podium (`RankingsPane`, `showPodium` off)

### 17.8 Contractor (`/contractor`)

- Family: branded, **blue** accent — the Employee anatomy recolored
  (`ContractorApp.tsx` / `ContractorSidebar.tsx` mirror `EmployeeApp`)
- Sidebar: 256px branded rail, `from-white to-blue-50/40` gradient
  (`from-[#0d1117] to-[#0f1729]` dark), selected nav
  `from-blue-100 to-blue-50 text-blue-900`, blue `SidebarLogoHeader` tile
  (`from-blue-500 to-blue-700`); same `CollapsibleSidebarShell` +
  `ViewSwitcher` + theme toggle + red-hover sign-out slots as every rail
- Tabs: Overview / Profile / Invoices, filtered by the feature-permission
  overlay (`allowedTabs`)
- Identity comes from `?email=` synced to sessionStorage
  (`contractor_session_email`), else redirect to `/login`
- When adding a Contractor surface, treat blue as this dashboard's primary the
  way orange is Accounting's — don't mix orange in

### 17.9 Tickets (`/tickets`)

- Family: **console** — fixed black + signal-red in both global themes (§ 1.4)
- Standalone page: `TicketsBoard.tsx` owns the whole route; views are Overview
  (default landing) / Board (dnd-kit Kanban) / Archived, navigated via
  `TicketsSidebar` (whose rail still mounts `ViewSwitcher` so the viewer can
  jump back to their dashboards)
- Sidebar: 256px, `from-[#0d0d0e] to-[#080809]`, selected nav
  `from-red-950/70 to-red-950/30 text-white`, red logo tile
  (`from-red-500 to-red-800`), **no theme toggle** (surface never goes light);
  identity card recolored `border-red-950/40` with the viewer's avatar
- Portaled surfaces (TicketDialog, Select content) must re-apply
  `tickets-theme dark` — see § 1.4
- KPI cards on the Overview use the smoked-glass treatment: `bg-card/65` +
  `backdrop-blur-[3px]` + white/10 hairline rim over a soft red ambient glow —
  deliberately *not* the § 6.3 stat-tile palette; keep glass scoped to this
  surface
- Access: dedicated `tickets` role (plus admin) via the `/tickets` layout
  guard; the per-user `tickets` feature grant decides create/drag vs read-only
- Since 2026-09-21 the rail adds an **Employee Support** group — Support Chat, then Support
  Tickets — drawn from `access.supportTabs` for the `employee_support` role (e59a16ea,
  2e542207, 240192e2). While access is still unknown the rail paints a skeleton, never the
  dev board's three entries (`TicketsSidebar.tsx:50-85`).

### 17.10 HR (`/hr`)

- Family: branded width (256px) with the emerald → teal tinted rail (§ 1.2,
  `HrSidebar.tsx:118, 147, 158`)
- Nav (2026-09-29, `HrSidebar.tsx:171-184`): Overview · Global Master List · Screening ·
  New Hire Checklist · Onboarding · Offboarding · Leave Requests · Transfers · Gift Tracker ·
  MESA · Announcements · Notifications
- Onboarding opens straight on the Onboarding Form / Pending Hires sub-tabs — its hero card
  was removed at Kane's request (5c5cc077); the Archived / Archived-Complete pills are § 11.1
- Gift Tracker: the hero banner went, four stat tiles stayed (ca8bbcb2); Submissions pages at
  20 (§ 5.6); the Orders tab sits after Submissions and locks with the "Creating invoice"
  overlay (§ 10.1) and inline Delete / Reopen (§ 10.3)
- Offboarding's queue dialogs render light in light mode since 2026-09-28 (8423e710: each
  hard-coded dark class kept behind `dark:` with a light base beside it, per PRODUCT.md:45)

### 17.11 QC (`/qc`)

- Family: tinted editorial, orange (§ 1.2, `QCSidebar.tsx:74, 97, 103`)
- Nav (2026-09-29, `QCSidebar.tsx:112-114`): Overview · QC Calculator · Notifications

---

## 18. Adding a new surface — checklist

1. Pick a family (branded vs editorial — the Tickets console theme is not a
   candidate, § 1.4).
2. Build the shell: `h-dvh max-h-dvh overflow-hidden flex` root, `<Sidebar>` +
   `<main>` with mobile header (§ 1.1, § 3.1).
3. Add the surface to `@/lib/rbac/views.ts` and update `ViewSwitcher` if it's
   a new RBAC view.
4. Sidebar must include all five required slots (§ 2.3).
5. For each tab, pick a header pattern (§ 3.2).
6. Tables: pick one of the three conventions (§ 5) — don't mix.
7. Use only the existing color palette (§ 15). No sixth status color without
   adding it to this doc first.
8. Animations: only `[0.16, 1, 0.3, 1]` or `[0.22, 1, 0.36, 1]` ease (§ 14.1).
   > ⚠ **Deviation (2026-09-29, OPEN — Kane's call):** springs and three more curves ship
   > (§ 14.1 inventory) — § 20 D1, D2; § 11.2's OPEN.
9. Empty / loading / error states: distinct, follow § 12.
10. Test mobile (drawer + content overflow) and short-viewport
    (`@media(max-height:900px)`) before merging.
11. A `p-0` dialog follows responsive-design.md's four rules (§ 10).
12. A paged list follows § 5.6.
13. A chart follows § 19.

---

## 19. Charts (2026-09-29)

There is no charting library — every chart is hand-rolled SVG on `motion/react`
(`src/components/ceo/financial-chart.tsx:7-15`). The July `PayoutTrendChart`
(`financial-chart.tsx`, reused by `manager/transfer-charts.tsx`) is the older generation; the
three September charts below are the ones to copy:

| Chart | File | Surface | Form |
| --- | --- | --- | --- |
| `CycleTrendChart` | `admin/performance-ui.tsx:1005` | Admin → Diagnostics → Payroll Cycles | two strips (rate · people paid), straight segments, area wash, dashed grid |
| `RankingHistoryChart` | `manager/RankingHistoryChart.tsx:114` | My Team → Rankings → View | two strips (count vs team average · rank), straight segments, lines only |
| `KpiSentTrendChart` | `manager/KpiInsightCards.tsx:651` | Manager → KPI Calculator | one series, monotone cubic, area, zero-based |

1. **Measured, not scaled.** Width from a `ResizeObserver` (`useMeasuredWidth`:
   `performance-ui.tsx:921`, `RankingHistoryChart.tsx:49`, `KpiInsightCards.tsx:630`); real
   pixel coordinates, so a stroke never thins.
2. **A missing measurement breaks the line** (`toRuns`: `performance-ui.tsx:950`,
   `RankingHistoryChart.tsx:68`, `src/lib/manager/kpi-insights.ts:396`) — no point, no
   segment in or out, never interpolated, never drawn as 0. A measured zero IS plotted.
3. **The gap is a 45° hatch** (`HATCH`, `performance-ui.tsx:892`; a `<pattern>`,
   `KpiInsightCards.tsx:832`). `RankingHistoryChart` leaves the gap empty and says so in words
   (`RankingHistoryModal.tsx:222-225`).
4. **Never a curve that overshoots.** Straight segments by default
   (`performance-ui.tsx:969-972`; `RankingHistoryChart.tsx:17, 83`). A Steffen monotone cubic
   is allowed because it stays inside each pair's own range (`kpi-insights.ts:413-422`, used by
   `KpiSentTrendChart`). Do not copy `financial-chart.tsx`'s Catmull-Rom (`smoothPath`, :41):
   it overshoots after a sharp drop.
5. **Two measures → two strips on one x axis, never two y axes** (`performance-ui.tsx:985-990`;
   `RankingHistoryChart.tsx:12-13`).
6. **Area wash: one series, on a zero-based axis** (`RankingHistoryChart.tsx:25-26`;
   `KpiInsightCards.tsx:852`; `kpi-calculator-insights.md:56-57`).
   > ⚠ **Deviation (2026-09-29, OPEN — Kane's call):** `CycleTrendChart` fills an area under
   > its rate strip, whose axis is not zero-based (`performance-ui.tsx:1285`) — § 20 D11.
7. **Markers** r=4 (hover 5–5.5) with a 2px ring in the SURFACE colour, never a fixed white
   (`performance-ui.tsx:1312-1316`; `RankingHistoryChart.tsx:470-490`;
   `KpiInsightCards.tsx:898-918`). A still-open newest point is hollow
   (`KpiInsightCards.tsx:898-903`).
8. **Selective direct labels** — newest + best (or best / worst / newest), never every
   point; label ink is a text token, never the series colour (`performance-ui.tsx:1038-1060`;
   `RankingHistoryChart.tsx:171-181`; `KpiInsightCards.tsx:922`).
9. **Colour is validated, not chosen** (the dataviz validator): orange-600 / 500
   (`performance-ui.tsx:885-889`), blue-600 / 500 (`RankingHistoryChart.tsx:19-24`),
   `#059669` / `#12a574` (`KpiInsightCards.tsx:780`). A context line (team average, no-data
   grey) sits under the chroma floor on purpose. Series colour flows through `currentColor`
   or a CSS variable, so the theme switch is automatic.
10. **Reveal**: a `stroke-dashoffset` draw-on with `pathLength={1}`, 900ms on
    `[0.22, 1, 0.36, 1]` (`performance-ui.tsx:1300`; `RankingHistoryChart.tsx:446-468`), or a
    clip wipe (`KpiInsightCards.tsx:802`). A refetch that only moves values morphs `d` in
    place; the reveal replays only on a structural change (`KpiInsightCards.tsx:692-697`).
    Reduced motion lands the finished chart.
11. **The chart box scrolls, never the page**: `MIN_SLOT_PX` 34 / 36 per week
    (`performance-ui.tsx:899`; `RankingHistoryChart.tsx:38`), the axis gutter OUTSIDE the
    scroller (`performance-ui.tsx:1098`; `RankingHistoryChart.tsx:227`), opening on the
    newest week (`RankingHistoryChart.tsx:150-154`).
12. **Readout**: an HTML tooltip (`rounded-lg border border-zinc-200 bg-white shadow-lg`, dark
    `bg-zinc-900`) that flips or clamps at the edge (`performance-ui.tsx:1383`;
    `RankingHistoryChart.tsx:552`; `KpiInsightCards.tsx:719`); a crosshair finds the week;
    hit targets are full-height week columns, never the dot (`RankingHistoryChart.tsx:352-370`).
13. **Keyboard**: one tab stop (`role="group"`, `tabIndex={0}`), ←/→ per week, Home/End,
    Escape clears the readout first, an `aria-live` sentence per week
    (`RankingHistoryChart.tsx:190-207, 255-265`; `KpiInsightCards.tsx:752-786`).
    `CycleTrendChart` instead makes each week its own tab stop (`performance-ui.tsx:1361`).
14. **A table twin carries every value** — visible below (`PayrollCyclePerformance.tsx:335`;
    `RankingHistoryModal.tsx:259-279`, `table-keep`) or `sr-only` (`KpiInsightCards.tsx:1026`).

Gridlines are solid hairlines, `stroke-zinc-100 dark:stroke-zinc-800/80`
(`RankingHistoryChart.tsx:431-440`; `KpiInsightCards.tsx:852-860`); `CycleTrendChart`'s dashed
`2 4` (`performance-ui.tsx:1276`) is the older variant.

---

## 20. Open deviations — shipped UI vs this document (2026-09-29)

Shipped code that contradicts a written rule is **flagged here, never resolved by rewording
the rule**. Each row stays OPEN until Kane rules; the rule text above is unchanged and carries
a ⚠ marker pointing here. Line numbers are this file as of the 2026-09-29 sweep.

| D# | Rule (verbatim, with § and line) | Shipped code (file:line) | State |
| --- | --- | --- | --- |
| D1 | § 14.1 L1549: "Use one of these two — do not introduce custom curves." Also § 18 item 8, L2010: "Animations: only `[0.16, 1, 0.3, 1]` or `[0.22, 1, 0.36, 1]` ease (§ 14.1)." | `[0.4, 0, 1, 1]`: `issue-row-motion.tsx:48`, `TimeAdjustmentIssueRows.tsx:315`, `ManagerApp.tsx:4023, 4319`, `GiftTracker.tsx:351`, `CollabLayer.tsx:576, 720`, `EmployeeLeaves.tsx:923`. `[0.4, 0, 0.2, 1]`: `PeopleBankSearch.tsx:75`, `HrApp.tsx:837, 881`, `MarkPaidDialog.tsx:667`, `OrphanageMarkPaidDialog.tsx:239`, `SWall.tsx:69`. `easeOutCubic`: `KpiInsightCards.tsx:646`. `cubic-bezier(0.45, 0, 0.55, 1)`: `EmployeeIdCard.tsx:136`. The Dialog primitive's own close is `ease-in` (`components/ui/dialog.tsx:59`). | OPEN — joined to § 11.2's spring-vs-ease ruling |
| D2 | § 11.1 L1290-1291: "The indicator transition is `duration: 0.28, ease: [0.22, 1, 0.36, 1]`, **gated behind `useReducedMotion()`**". § 11.2's OPEN (L1357) rested on "this is the first indicator on a spring" — a false premise, corrected in place. | About 40 spring transitions on `layoutId` indicators in 21 files, e.g. `EmployeeProfile.tsx:794` (2026-05-03), `HrMesa.tsx:161` (2026-05-15), `BonusCatalog.tsx:1352` (2026-06-12; 9 in the file), `PayProcessorsTab.tsx:1359` (2026-09-03), `CompensationSections.tsx:94` (2026-09-12), `ManagerApp.tsx:324, 416` (`SlidingTab`, rail). | OPEN — the § 11.2 ruling (Sep 14 log row 109) was never carried into a later Open items table |
| D3 | § 17.5 L1892-1893: "Every selector on the screen is a `SlidingTab` (§ 11.2)." | My Team → Rankings uses the static `Segmented` (`leaderboard-ui.tsx:32-70`; `AppointmentLeaderboardPane.tsx:252-267`; `RankingHistoryModal.tsx:130-135`) — the swap-a-white-pill control § 11.2 says My Team replaced — and a `SmoothSelect` KPI picker (`DeliverableLeaderboardPane.tsx:175`). | OPEN |
| D4 | § 12.2 L1411-1412: "Same shape, but zinc tile + `<SearchX>` icon + the query rendered in mono inside a small chip + a "Clear search" pill below." | `RankingsNoMatch` (`RankingsSearch.tsx:65-73`): a dashed text-only card, the query in curly quotes, no Clear pill; People → Search Bar the same (`PeopleBankSearch.tsx:286-289`). | OPEN |
| D5 | § 9.2 L1003-1004: "Always include the typing-dots indicator (debounce in flight) and the result count once the debounced query has resolved." | `RankingsSearch` (`RankingsSearch.tsx:21-61`) shows neither, on every Rankings view (`RankingsPane.tsx:203`; `AppointmentLeaderboardPane.tsx:250`). It is a synchronous filter with no debounce, so the question is whether the rule is scoped to debounced searches. | OPEN |
| D6 | § 15 L1722-1723: "Do not introduce a sixth status color (e.g. teal, indigo) without updating this table." | `.issue-row-flash-moved` is indigo — `rgb(99 102 241 / 0.14)`, dark `rgb(129 140 248 / 0.2)` (`src/index.css:1165, 1168`; 2aebfde3). | OPEN |
| D7 | § 5.4 L643-644: "`text-[10px] font-semibold uppercase tracking-[0.12em] text-zinc-400` — the "tiny caps" used for every column heading and section label app-wide." Contradicted inside this document by § 11.2 ("`zinc-400` at 2.8:1 failed"). | The new tables head in `text-[10px] uppercase tracking-wide text-zinc-500` (`AppointmentLeaderboardPane.tsx:527`; `RankingHistoryModal.tsx:281`). | OPEN |
| D8 | § 10.1 L1151-1153: "a failure keeps the dialog open carrying the server's own sentence plus *Try again* — never a toast that disappears while the user is reading it (§12.4)." | `InvoiceProgress.tsx:14-15` ("A failure closes it immediately (the toast says why)"); `GiftOrders.tsx:261-268` `toast.error`. Scope is arguable: it is a progress overlay after the click, not a confirm. | OPEN |
| D9 | § 14.5 L1642-1643: "Prefer `tabular-nums` so digits don't reflow as they change." | `AnimatedPeso` (`KpiInsightCards.tsx:94-121`, "Proportional figures: this is a standalone number, not a column") rolls for 0.9s without `tabular-nums`; `performance-ui.tsx:39-40` states the opposite rule for its own counters. | OPEN |
| D10 | **Doc vs doc.** § 10 L1095: "The body uses `overflow-y-auto bg-zinc-50/40 px-6 [-webkit-overflow-scrolling:touch] dark:bg-[#0a0d12]` with `style={{ maxHeight: "min(58vh, 600px)" }}`." vs `docs/design/responsive-design.md:108-111`: "Never a hard-coded pixel `maxHeight` on the scroll region". | No code still uses `min(58vh, 600px)`. Against the responsive-design rule, restyled 2026-09-28 (8423e710) without the dialog fixes: `ManagerOffboardQueueDialog.tsx:189` (`max-h-[88vh]`, vh not dvh); `HrOffboardQueueProcessor.tsx:370`, `HrOffboarding.tsx:1044, 1142` (`p-0`, no `gap-0`, no height cap). | OPEN |
| D11 | § 19 rule 6, L2051-2052: "Area wash: one series, on a zero-based axis"; `docs/features/kpi-calculator-insights.md:56-57`: "The Diagnostics chart's floating floor was licensed for a line with no fill." | `CycleTrendChart` fills an area (`areaPath` + gradient, `performance-ui.tsx:1285`) under its rate strip, whose axis is not zero-based (`trendRateBand`). | OPEN |
| D12 | § 14.5 L1620-1623: "Honor `useReducedMotion()` from `motion/react` for any animation longer than ~300ms or any number-counter. Snap to the final value. Example: `CountUp` in `PaymentHistoryPanel` (deleted but the pattern is canonical). Don't ship mount animations that the user can't bypass." | `StartProcessingBroadcastModal.tsx:61, 161, 168, 172` — four `repeat: Infinity` motion loops, no reduced-motion gate (file touched 2026-09-25, 0f4667c5). The global CSS kill (§ 14.5) does not reach `motion/react`. | OPEN |
| D13 | § 3.2.2 L417 (the branded hero spec, now with no current user). Question, not a contradiction: is "no hero by default" a standard? | Three heroes removed at Kane's request: Gift Tracker ca8bbcb2 (2026-09-23); Payment Dispatch e7f67ad2, f957cb10, d309dc61 (2026-09-24); HR Onboarding 5c5cc077 (2026-09-25). | OPEN — Kane's call |
| D14 | Findings, not a contradiction of a written rule (recorded in § 15.4, L1764). Nearest text: § 15.3 L1761-1762: "waive it file-scoped in `.impeccable/config.json` with the reasoning in the commit message, never by changing the resting colour." | `.impeccable/config.json` still waives `gradient-text` for `PayrollDispatch.tsx`, which has had no gradient text since f957cb10 (the cited `payment-dispatch.md:39` no longer mentions it); `EmployeeDashboard.tsx:2780` carries an unwaived `bg-clip-text` gradient. Config not edited. | OPEN |
