# UI Standards — Simple HRIS

This document captures the visual conventions, layout patterns, and component
conventions actually in use across the Simple HRIS codebase. It is descriptive,
not prescriptive: every rule here was extracted from existing components in
`src/components/` and `components/ui/`. If you find code that contradicts this
document, the code is the source of truth — please update this file rather than
the code.

Cross-references:

- [`docs/responsive-design.md`](./responsive-design.md) — breakpoints, safe
  areas, drawer pattern, short-viewport handling. This document does **not**
  re-derive any of that; it builds on top of it.
- [`docs/components.md`](./components.md) — what each component does and why.
  This document covers visual standards (look, feel, spacing).
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
| Accounting     | Orange / blue | `bg-gradient-to-b from-white to-orange-50/40` (light) / `from-[#0d1117] to-[#0f1729]` (dark) | `bg-gradient-to-r from-orange-100 to-orange-50` (light) | Wand icon in orange tile + `simple-logo.png` |
| Payroll Clerk  | Editorial zinc | `bg-white` / `dark:bg-zinc-950`     | `bg-[#18181b] text-white`                                               | Lowercase `s` tile       |
| Admin          | Editorial zinc | `bg-white` / `dark:bg-zinc-950`     | `bg-[#18181b] text-white`                                               | Lowercase `s` tile + "Admin" caption |
| CEO            | Editorial zinc + crown accents | `bg-white` / `dark:bg-zinc-950`             | `bg-[#18181b] text-white`                                               | Lowercase `s` tile       |
| Manager        | Editorial zinc | `bg-white` / `dark:bg-zinc-950`     | `bg-[#18181b] text-white`                                               | Lowercase `s` tile       |
| Orphanage      | Pink / rose    | (per-section)                        | per-section                                                             | Heart icon               |
| Employee       | Orange / blue (matches Accounting) | `bg-gradient-to-b from-white to-orange-50/40` | `bg-gradient-to-r from-orange-100 to-orange-50` | Orange tile + `simple-logo.png` |

Two distinct visual families:

1. **Branded** — Accounting and Employee use the orange/blue gradient family
   with marketing-style hero numbers and decorative blobs (`PayrollDispatch`,
   `Overview`).
2. **Editorial** — Admin, Payroll Clerk, Manager, CEO use a near-monochrome
   zinc palette, hairline borders, monospace numerals, and dense per-row UI
   (`AdminEmployees`, `Rates`, `AdminOverview`). When in doubt for a new admin
   surface, follow the editorial family.

### 1.3 Page background tokens

| Tone       | Light                    | Dark                              |
| ---------- | ------------------------ | --------------------------------- |
| App body   | `bg-white`               | `bg-[#0d1117]`                    |
| Editorial canvas | `bg-zinc-50`       | `bg-zinc-950`                     |
| Soft canvas (under cards) | `bg-[#fafaf8]` / `bg-zinc-50/40` | `bg-[#0a0d12]` / `bg-zinc-950` |
| Subtle gradient (Accounting/Employee dashboards) | `bg-gradient-to-br from-white via-orange-50/30 to-blue-50/20` | `dark:bg-none dark:bg-[#0d1117]` |

The gradient hero tone is reserved for the two **branded** surfaces. Don't
introduce it on Admin / Payroll Clerk / CEO / Manager — the editorial family
expects flat backgrounds with hairline borders.

---

## 2. Sidebars

Two distinct widths and two visual families. Pick by surface (see § 1.2). All
sidebars share these mechanics:

- `flex h-dvh shrink-0 flex-col`
- `fixed inset-y-0 left-0 z-50` below `md`, `md:static md:z-auto md:translate-x-0` from `md:` up
- Translate animation: `transition-transform duration-300 ease-out` driven by
  `mobileOpen ? 'translate-x-0' : '-translate-x-full md:translate-x-0'`
- `id="<surface>-sidebar-nav"` + `role="navigation"` + `aria-label`
- The mobile hamburger button uses `aria-controls="<surface>-sidebar-nav"` and
  `aria-expanded={mobileOpen}`

### 2.1 Editorial (Admin, Payroll Clerk, Manager, CEO)

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

Used by `AdminOverview`, `Rates`, `AdminEmployees`, `PayrollDispatch`'s
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

Used by `PayrollDispatch`, `Overview`, employee landing.

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

---

## 4. Common bottom sections

### 4.1 ViewSwitcher

`@/components/rbac/ViewSwitcher` is shared across every dashboard. It renders
nothing when `views.length <= 1`. Treat it as a drop-in component — do not
restyle. Mount it inside the sidebar's `<ScrollArea>` (NOT in the `mt-auto`
footer) so it remains scrollable on short viewports.

Animation contract: clicking a target view delays the route push by 520ms while
playing a glow + ring overlay (`<ViewSwitchOverlay>`). New surfaces should not
intercept the click; just call `withViewTransition(() => router.push(url))`
which is what `ViewSwitcher` already does.

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

Used in `Rates`, `AdminEmployees`, `ProcessorQueue` (Payroll Clerk),
`SentPaymentsHistory`, `DispatchReports.dispatches`. Each row is a flex card,
not a `<tr>`. Reasons:

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

A specialty pattern used in the Reports tab drilldown and any per-employee
financial history. Characterized by:

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
`QueueSkeleton`) for the canonical refs.

---

## 6. Cards / Panels

### 6.1 shadcn `<Card>` (`components/ui/card.tsx`)

Default size:

- `rounded-xl bg-card py-4 text-sm ring-1 ring-foreground/10`
- `<CardHeader>` `px-4`, `<CardContent>` `px-4`, `<CardFooter>` `border-t bg-muted/50 p-4`
- `gap-4` between sub-elements; `data-size="sm"` swaps to `gap-3 py-3 px-3`.

Use the shadcn `<Card>` for **bordered, content-section panels** with a clear
title and structured body. Examples: `AdminRoles` role list cards, audit log
filters card, `AdminEmployees` directory + selected detail.

### 6.2 Hairline panel (editorial alternative)

Used widely in `AdminOverview`, `Rates` row detail, dispatch reports. Pattern:

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

### 9.3 Date / time inputs

Native `<Input type="date">` is used everywhere. Pair with a calendar icon
when standalone. Don't introduce a date picker library — the native input is
acceptable for the precision this app needs (day-level).

---

## 10. Dialogs (`components/ui/dialog.tsx`)

Backdrop is intentionally branded (`bg-gradient-to-br from-orange-950/40 to-blue-950/40 backdrop-blur-[2px]`). Don't override.

Default size is `sm:max-w-sm`. Override with explicit pixel widths for
specialty content:

| Dialog                       | `className` width pattern                              |
| ---------------------------- | ------------------------------------------------------ |
| Standard form (Mark paid)    | `sm:max-w-[440px]` to `sm:max-w-[520px]`               |
| Lock-toggle confirm          | `sm:max-w-[440px]`                                     |
| Profile dialog (Rates)       | `w-[min(92vw,1100px)] max-w-[min(92vw,1100px)] max-h-[min(92vh,960px)] overflow-hidden rounded-2xl p-0` |
| Bulk-create disputes         | `max-w-[1200px] w-[95vw]`                              |
| Confirm delete               | default `sm:max-w-sm`                                  |

Layout inside a sectioned dialog (Profile / bulk-create):

- `<DialogHeader>` is `shrink-0`, sits in a slim `border-b` bar.
- Action row sits below the header, `shrink-0`.
- The body uses `overflow-y-auto bg-zinc-50/40 px-6 [-webkit-overflow-scrolling:touch] dark:bg-[#0a0d12]` with `style={{ maxHeight: "min(58vh, 600px)" }}`.
- `<DialogFooter>` extends edge-to-edge by undoing the dialog's padding:
  `-mx-4 -mb-4` — already baked into the primitive's default classes.

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

### 12.3 Loading

Two flavors:

- **Skeleton** for table-style content (`QueueSkeleton`, `ReportListSkeleton`).
  Preserves layout — pulses the row outlines.
- **Spinner** for non-tabular ("Loading payment history…", profile detail).
  `<Loader2 className="h-4 w-4 animate-spin text-orange-500" />` + a tiny-caps
  caption.

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

---

## 13. Typography scale

Observed scale, top-down (do not introduce intermediate sizes without good
reason):

| Use | Class | Notes |
| --- | --- | --- |
| Hero number (financial display) | `text-[40px] font-medium … sm:text-[56px]` mono | Counter animation, tight tracking |
| Page H1 | `text-xl font-bold tracking-tight sm:text-[28px]` (branded) / `text-base font-semibold sm:text-xl` (editorial) | |
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

### 14.6 Theme-toggle / view-switch

Both use the `withViewTransition` helper (`@/lib/theme/with-view-transition`)
which calls the View Transitions API when available, gracefully degrading to
no-animation otherwise. `ViewSwitcher` additionally injects an overlay card
with a 700ms ring expand. Don't reinvent — call the helper.

### 14.7 Background orbs (branded only)

Decorative blurred blobs (`<motion.div className="absolute … rounded-full bg-orange-300/30 blur-3xl" />`) are reserved for the highest-traffic branded
landing pages (`PayrollDispatch`). They fade in over `0.8 – 1.2s`. Don't use
on any editorial surface.

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

---

## 17. Per-dashboard quick reference

### 17.1 Accounting (`/accounting`)

- Family: branded
- Sidebar: 256px wide, orange/blue gradient, 'Accounting HRIS' caption above
  logo
- Header: editorial breadcrumb header at the page level for most tabs;
  branded hero header on `Overview`
- Notable surfaces: `Overview` (mixed densities), `Rates` (editorial
  card-list), `PayrollWizard` (its own deep convention — do not modify),
  `PabDisputeQueue` (table + dialog), `LeaveRequestsPanel`

### 17.2 Payroll Clerk (`/payroll-clerk`)

- Family: branded (with editorial sidebar)
- Sidebar: 220px wide, editorial zinc with a "cycle ready" pill above the nav
- Hero header: branded with backgroundOrbs, "Welcome back, {name} 👋", three
  hero stats (Pending / Sent / Paid)
- Filter rail (left within the body): processor cards (`ProcessorCard`),
  vertical on lg, horizontal scroll on sm
- Table: editorial card-list (`ProcessorQueue`), one row per recipient
- Reports drilldown: ledger-style row layout

### 17.3 Admin (`/admin`)

- Family: editorial
- Sidebar: 220px wide, editorial zinc with two section dividers ('System' /
  'Security')
- Header: editorial breadcrumb header (`Admin / Overview / kaner@simple.biz`)
  with three small action pills on the right (Sync, Export Audit, Roles)
- Body: hairline panels in a flex row on lg, single scrollable column below
  lg (see `AdminOverview` mobile fix)

### 17.4 CEO (`/ceo`)

- Family: editorial
- Crown icon as brand cue; otherwise mirrors Admin's chrome
- Surfaces are read-only summary panels — no destructive actions in the
  default ribbon

### 17.5 Manager (`/manager`)

- Family: editorial
- 'Manager' caption under the brand mark; nav scoped to the manager's
  department members + leave requests + orphanage create

### 17.6 Orphanage (`/orphanage`)

- Family: branded, pink/rose accent (heart icon)
- Distinct from the others — used by Alyson for orphanage dispute creation
- Calendar grid is the centerpiece; uses the shared
  `<CreateOrphanageStyleDisputeDialog>`

### 17.7 Employee (`/employee`)

- Family: branded (mirrors Accounting closely)
- Per-employee landing with hero, hours summary, dispute filing,
  announcements; all ScrollArea-bounded

---

## 18. Adding a new surface — checklist

1. Pick a family (branded vs editorial).
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
9. Empty / loading / error states: distinct, follow § 12.
10. Test mobile (drawer + content overflow) and short-viewport
    (`@media(max-height:900px)`) before merging.
