# Orphanage Dashboard — Tech Stack & UI Standards

> Last updated: 2026-06-05

---

## 1. Tech Stack

| Layer | Technology | Notes |
|-------|-----------|-------|
| UI Framework | React 18 (`'use client'` on every component) | No Server Components in this feature |
| Routing | Next.js App Router | Page at `app/orphanage/page.tsx` |
| Auth | NextAuth — `getServerSession(authOptions)` | All API routes gate on session |
| Database | Supabase (PostgreSQL) | Service-role client in API routes |
| Component Library | shadcn/ui | Button, Card, Input, Label, Badge, Dialog |
| Styling | Tailwind CSS 3+ | Utility-first; dark mode via `dark:` prefix |
| Icons | lucide-react | |
| Animation | Framer Motion (`motion/react`) | AnimatePresence, motion.div/button/li |
| Toasts | sonner | All success/error feedback |
| State | React hooks only | useState, useCallback, useMemo, useRef |
| Forms | Controlled inputs | No react-hook-form or Formik |
| HTTP | Browser `fetch` | `cache: 'no-store'`; Promise.all for parallel |
| Dates | Native JS `Date` | No date-fns / dayjs / moment |

---

## 2. File Inventory

### Components (`src/components/orphanage/`)

| File | Lines | Role |
|------|------:|------|
| `OrphanageApp.tsx` | 1,458 | Main shell — 6-tab layout (Overview, Dispute Queue, Budget, Budget History, Notifications, S-Wall) |
| `OrphanageBudgetForm.tsx` | 1,409 | Multi-step budget request (Monthly / Frequent / Special) with sticky live-total sidebar |
| `OrphanageBudgetHistory.tsx` | 1,102 | Expandable request + gift payment history with per-row audit trail |
| `GiftTracker.tsx` | 1,732 | 6-month milestone gift roster; status badges (overdue / red / orange / green / far) |
| `OrphanagesPanel.tsx` | 834 | Directory CRUD — add/edit/delete partner orphanages with photo + leftover budget |
| `GiftPayments.tsx` | 826 | Vendor payment entry — line items, shipping, bank details, status |
| `CreateOrphanageStyleDisputeDialog.tsx` | 887 | Bulk-create PAB disputes — 2-column (reason/people left, PAB calendar right) |
| `GiftCatalog.tsx` | 531 | Gift catalog editor — item prices (PHP), 6-month anniversary tiers |

### API Routes (`app/api/`)

| Route | Methods | Purpose |
|-------|---------|---------|
| `orphanage-disputes/` | GET | Pending + receipt-log disputes for manager queue |
| `orphanage-budget-requests/` | GET, POST | List / create budget requests |
| `orphanage-budget-requests/[id]/decide/` | PATCH | Approve / reject a budget request |
| `orphanage-dispatches/` | GET, POST | Pending payment items + dispatch log |
| `orphanages/` | GET, POST | Orphanage directory list / create |
| `orphanages/[id]/` | PATCH, DELETE | Edit / delete single orphanage |
| `orphanages/upload/` | POST | Photo upload handler |
| `pab-disputes/orphanage-overlap/` | GET | Existing disputes for calendar state |
| `pab-disputes/orphanage-manager-submit/` | POST | Bulk dispute creation (manager flow) |
| `pab-disputes/orphanage-visits/` | GET, POST | Visit-style dispute list / create |

### Library Utilities (`src/lib/`)

| File | Purpose |
|------|---------|
| `supabase/orphanages.ts` | Orphanage directory CRUD |
| `supabase/orphanage-budget-requests.ts` | Budget request CRUD + audit trail |
| `supabase/orphanage-dispatches.ts` | Dispatch creation + pending items |
| `pab-disputes/fetch-orphanage-overlap.ts` | Client-side dispute overlap fetcher |

---

## 3. UI Standards

### 3.1 Color Palette

The Orphanage dashboard uses a **pink/rose primary accent** throughout, chosen to visually distinguish it from the rest of the HRIS.

| Intent | Tailwind Classes |
|--------|-----------------|
| Primary gradient (headers, hero) | `bg-gradient-to-br from-pink-500 via-rose-500 to-rose-700` |
| Primary button / active state | `bg-pink-600 hover:bg-pink-700` |
| Subtle background tint | `bg-pink-50 dark:bg-pink-900/10` |
| Border accent | `border-pink-100/80` |
| Success / approved | `emerald-*` (green) |
| Warning / pending | `amber-*` (yellow-orange) |
| Info / neutral | `sky-*` (light blue) |
| Dispute / milestone | `violet-*` (purple) |
| Danger / overdue | `rose-600` / `red-*` |

> **Note:** Semantic Tailwind tokens (`bg-primary`, `bg-card`, `text-muted-foreground`) are **not used** here — they do not compile in this project. Use hardcoded palette utilities only (see [Tailwind semantic tokens are dead](../memory/project_tailwind_tokens_dead.md)).

### 3.2 Typography

- **Section headings**: `text-lg font-semibold` or `text-xl font-bold`
- **Sub-labels / metadata**: `text-xs text-zinc-500 dark:text-zinc-400`
- **Body text**: `text-sm` (14px effective)
- **Monospace values** (IDs, dates): `font-mono text-xs`
- No custom font stack beyond the project default.

### 3.3 Spacing & Layout

- Component padding standard: `px-4 py-3` (inner cards), `p-6` (top-level panels)
- Card rounding: `rounded-xl` (main cards), `rounded-lg` (inner elements)
- Shadow: `shadow-md` on raised cards, `shadow-sm` on nested
- Section gaps: `gap-4` or `gap-6` in flex/grid layouts
- Max-width content: `max-w-2xl` or `max-w-4xl` centered with `mx-auto`

### 3.4 Cards

All content blocks use shadcn/ui `Card` or Tailwind-composed equivalents:

```tsx
<Card className="rounded-xl shadow-md border border-pink-100/80 dark:border-zinc-800">
  <CardHeader className="pb-3">
    <CardTitle className="text-lg font-semibold">...</CardTitle>
  </CardHeader>
  <CardContent>...</CardContent>
</Card>
```

Nested sub-cards use `bg-zinc-50 dark:bg-zinc-800/40 rounded-lg p-4`.

### 3.5 Buttons

| Variant | Usage |
|---------|-------|
| Default (pink filled) | Primary actions (Submit, Save, Approve) |
| `outline` | Secondary / cancel actions |
| `ghost` | Toolbar / icon-only controls |
| `size="sm"` | Inline row actions |
| `size="icon"` | Single-icon buttons (edit, delete, expand) |

Destructive actions (delete, reject) use `variant="destructive"` or `bg-red-600 hover:bg-red-700` manually.

### 3.6 Badges

```tsx
<Badge variant="outline" className="text-emerald-600 border-emerald-200 bg-emerald-50">
  Approved
</Badge>
```

Status color mapping:

| Status | Classes |
|--------|---------|
| Approved / Paid | `text-emerald-600 border-emerald-200 bg-emerald-50` |
| Pending | `text-amber-600 border-amber-200 bg-amber-50` |
| Rejected / Problem | `text-red-600 border-red-200 bg-red-50` |
| Overdue | `text-rose-600 border-rose-200 bg-rose-50` |
| Info / Neutral | `text-sky-600 border-sky-200 bg-sky-50` |

### 3.7 Animations (Framer Motion)

All major state transitions (tab switches, list item mounts, dialog open) use `motion/react`:

```tsx
import { motion, AnimatePresence } from 'motion/react'

<AnimatePresence mode="wait">
  <motion.div
    key={activeTab}
    initial={{ opacity: 0, y: 8 }}
    animate={{ opacity: 1, y: 0 }}
    exit={{ opacity: 0, y: -8 }}
    transition={{ duration: 0.18 }}
  >
    ...
  </motion.div>
</AnimatePresence>
```

Stagger effects on lists use `transition={{ delay: index * 0.04 }}`.

### 3.8 Forms

- All inputs are **controlled** — `value={state}` + `onChange` handler
- Validation is manual (pre-submit guard checks), surfaced via `toast.error()`
- `<Input>` from shadcn/ui with `className` overrides for sizing
- Numeric inputs: `type="number"` with `min`, `step` and optional currency prefix icon
- Date inputs: shared `<DatePicker>` from `components/ui/date-picker.tsx` (see ui-standards § 9.3)
- Text areas: native `<textarea>` with Tailwind styling (no shadcn Textarea in this feature)
- No form library used

### 3.9 Data Fetching Pattern

```ts
// Standard fetch inside useEffect / triggered by user action
const load = useCallback(async () => {
  setLoading(true)
  try {
    const [a, b] = await Promise.all([
      fetch('/api/orphanages').then(r => r.json()),
      fetch('/api/orphanage-budget-requests').then(r => r.json()),
    ])
    setOrphanages(a.orphanages)
    setRequests(b.requests)
  } catch {
    toast.error('Failed to load data')
  } finally {
    setLoading(false)
  }
}, [])
```

- `cache: 'no-store'` on reads to avoid stale payloads
- Parent components pre-fetch and pass data to child dialogs via props (avoids open-time lag)
- No SWR / React Query used in this feature

### 3.10 Dark Mode

Dark mode is supported on every component via `dark:` Tailwind prefix:

- Dark backgrounds: `dark:bg-zinc-900`, `dark:bg-zinc-800/40`, `dark:bg-zinc-950`
- Dark borders: `dark:border-zinc-700`, `dark:border-zinc-800`
- Dark text: `dark:text-zinc-100`, `dark:text-zinc-400`

The app is **light-first**; dark mode is an overlay, not the default.

### 3.11 Responsive Behavior

- Global CSS auto-stacks `<table>` elements into cards on mobile (project-wide convention)
- Add `data-label="Column Name"` to `<td>` for mobile card labels
- Use `.table-keep` class to opt out of auto-stacking
- Layouts use `flex-col md:flex-row` breakpoints for 2-column → stacked on small screens

### 3.12 Role-Based Visibility

Views are gated via `canActOnOrphanageManagerQueue(email)` (server-side) and role props passed down to components. Accounting and Manager roles see different tabs and action buttons. No client-side-only permission gates — authorization always enforced in API routes.

---

## 4. Database Schema (Key Tables)

| Table | Purpose |
|-------|---------|
| `public.orphanages` | Partner directory (name, address, photo, leftover budget) |
| `public.orphanage_budget_requests` | Budget submissions with status + audit log |
| `public.orphanage_dispatches` | Payment dispatch records (budget_request / gift_shipping) |
| `public.pab_day_disputes` | PAB dispute rows (orphanage-visit subset) |
| `public.audit_log` | Per-decision audit trail for budget requests |

---

## 5. Key UX Patterns

| Pattern | Where Used |
|---------|------------|
| Sticky live-total sidebar | `OrphanageBudgetForm` — cost summary updates as user fills fields |
| 2-column dispute dialog | `CreateOrphanageStyleDisputeDialog` — reason/people left, PAB calendar right |
| Expandable rows with audit trail | `OrphanageBudgetHistory` — click row to reveal decision timeline |
| Status color rings | `GiftTracker` — overdue/red/orange/green/far milestone bands |
| Pre-warmed dialog data | Parent fetches data before dialog opens; child receives via props |
| Parallel fan-out loading | `Promise.all()` on 2–4 endpoints simultaneously |
| Toast-only error UX | No inline error states; `sonner` toast for all feedback |
