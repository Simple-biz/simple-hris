# Responsive layout and screen support

This document describes how Simple HRIS behaves on phones, tablets, laptops, and large desktops, and where to change behavior when adding new screens.

## Viewport and global CSS

- **`app/layout.tsx`** exports a Next.js `viewport` object: `width: device-width`, `initialScale: 1`, and `viewportFit: cover` so notched devices (iPhone, etc.) can use safe-area insets.
- **`body`** uses `min-h-dvh overflow-x-hidden` to reduce horizontal page scroll and to prefer dynamic viewport height (`dvh`) over classic `100vh`, which can mis-measure on mobile browsers when the URL bar shows or hides.
- **`src/index.css`** adds horizontal `padding` on `body` using `env(safe-area-inset-left|right)` so content does not sit under curved display edges.

## Breakpoints (Tailwind defaults)

| Token | Min width | Typical use in this app |
|-------|-----------|-------------------------|
| default | 0 | Phone portrait; drawer nav; stacked layouts in many views |
| `sm` | 640px | Slightly roomier phone / large phone |
| `md` | 768px | **Sidebar switches from drawer to persistent column** |
| `lg` | 1024px | Login marketing column; wider grids where used |
| `xl` | 1280px | Large laptop / desktop |

Tailwind’s `md` breakpoint is the main switch for navigation chrome.

## App shells (three surfaces)

Each primary surface uses the same pattern:

1. **Accounting** — `src/App.tsx` + `src/components/Sidebar.tsx` (route: `/accounting`).
2. **Employee** — `src/components/employee/EmployeeApp.tsx` + `EmployeeSidebar.tsx` (route: `/employee`).
3. **Admin** — `app/admin/page.tsx` + `src/components/admin/AdminSidebar.tsx` (route: `/admin`).

### Mobile (below `md`)

- Side navigation is **off-canvas**: `fixed`, full height, slides in from the left when `mobileOpen` is true.
- A **dimmed backdrop** (`md:hidden`) closes the menu on tap.
- **Escape** closes the drawer (global `keydown` listener while open).
- A **compact header** (`md:hidden`) with a menu button (`aria-controls` pointing at the sidebar `id`) opens the drawer.
- Choosing any nav item calls a `navigate` helper that updates the tab and sets `mobileOpen` to false.

### Laptop / desktop (`md` and up)

- Sidebar is **`static`** in the flex row (not fixed), always visible, no backdrop.
- The mobile header is hidden.

### Shell implementation details

- Root flex containers use **`h-dvh max-h-dvh overflow-hidden`** so the app fills one screen without the document body growing past the viewport.
- **`min-w-0`** on `main` (and nested flex children where needed) lets flex items shrink so wide tables can scroll inside their regions instead of blowing out the page width.

## Tables and wide content

- Shared **`components/ui/table.tsx`** wraps every `<table>` in a container with **`overflow-x-auto`**, so wide grids scroll horizontally on small screens.
- Individual views (Overview, Rates, Payroll Wizard, etc.) may add their own scroll regions; prefer keeping **`min-h-0`** on flex children so nested `overflow-auto` works.

## Login page

- **`app/login/page.tsx`** already uses responsive grids (`lg:grid-cols`, hidden marketing column on small screens). The sign-in card uses responsive padding (`px-8`, `sm:px-10`).

## Accessibility notes

- Sidebars expose **`role="navigation"`**, an **`aria-label`**, and a stable **`id`** matched by the menu button’s **`aria-controls`**.
- Backdrop and menu buttons have **`aria-label`**s suitable for screen readers.

## How to verify manually

1. **Chrome DevTools** → Toggle device toolbar; try iPhone SE width (~375px) and a tablet width (~768px).
2. Confirm: menu opens/closes, backdrop works, Escape closes, no horizontal page scroll on the shell.
3. Resize across **768px**: sidebar should lock open and the top mobile bar should disappear.
4. On a real phone (optional): confirm safe-area padding and `dvh` behavior with the browser chrome visible.

## Changing breakpoints

If you need the drawer to persist up to a larger width (e.g. tablets in landscape), adjust the Tailwind prefixes in the shell files from `md:` to `lg:` consistently for:

- Sidebar `md:static`, `md:translate-x-0`, etc.
- Backdrop and mobile header `md:hidden`.

Alternatively, define a custom breakpoint in `src/index.css` under `@theme` if the team standardizes on a non-default width.
