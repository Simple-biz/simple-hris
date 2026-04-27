# Payment Dispatch

> **Goal**: A streamlined view that lets the payroll clerk (Lenny) see who's owed pay this cycle, send the money via the right processor, log each confirmation, and pause employee dispute filing while the run is in flight — all in real time across every dashboard.

This document covers the entire Payment Dispatch feature: the UI Lenny uses, the live "payroll being processed" lock employees see, the per-cycle dispatch log, and every supporting migration / API / hook.

---

## 1. Origin

Carla's meeting (see `MEETING-WITH-CARLA.MD`) defined the payroll-clerk role and the dispatch flow. Highlights:

- Lenny's job is to **send money**, not calculate it. She sees a streamlined view with **only name, email, and amount** per row, grouped by payment processor.
- After sending, she **manually logs**: arrival date (adjustable), transaction ID, bank used, date sent. No automation — that's the boss's preference.
- Once she clicks **Start processing**, employees should not be able to file disputes. The button gates the dispute UI live across all open employee dashboards.
- Each pay cycle should keep a memory of who was paid (per-cycle log of dispatches).

---

## 2. Where it lives

| Surface | Path | Audience |
|---|---|---|
| Embedded in Accounting view | `/accounting` → **Payment Dispatch** tab | Anyone with accounting access (RBAC gate is TODO) |
| Standalone page | `/payroll-clerk` | Reserved for when Lenny gets her own role + login |

Both views render the same content via **`PayrollDispatch.tsx`** (used inside Accounting) or the dedicated shell **`PayrollClerkApp.tsx`** (used at `/payroll-clerk`). The difference is just the surrounding chrome — the queue, history, and dispatch-lock logic are shared.

The Accounting sidebar entry is registered in `src/components/Sidebar.tsx` (`payment-dispatch` tab id, `Send` icon).

---

## 3. UI structure

### 3.1 Hero

- "Welcome back, **{firstName}** 👋" — `firstName` derived from NextAuth session (`session.user.name` → email local part → "there"), gradient text fill (orange → rose), animated wave emoji on mount.
- "Payment dispatch" title + subtitle.
- **Period pill** (top-right): `Apr 22 – 28, 2026` style label derived from the current Hubstaff upload's date columns. Hover shows source filename. Renders amber "No upload yet" when there's no current cycle.
- **Processing pill**: "Not processing" (zinc) by default. When `lockState.locked` is true: "Processing · disputes paused" with a pulsing rose dot.
- **Start / Stop processing** button (the lock toggle — see §6).

### 3.2 Hero stats

Three animated stat cards (`HeroStat` component, motion spring-counter via `AnimatedNumber`):

| Card | Source |
|---|---|
| **Pending** | `pending.length` (rows still owed) |
| **Sent** | `paid.length` (already-dispatched rows for this cycle) |
| **Volume** | `Σ amountUSD` of pending; sub-label adapts: `"X of Y priced"` while partial, `"all priced"` when complete, `"awaiting pay calc"` when zero |

### 3.3 Processor cards

A row of 8 filter cards (All + Hurupay + Wepay + HiGlobe + Wise + Jeeves + Wires + History). Each card uses `ProcessorCard.tsx` and has its own brand identity:

| Processor | Gradient | Notes |
|---|---|---|
| Hurupay | orange → amber | Most common in production data |
| Wepay | sky → blue | Email only |
| HiGlobe | emerald → teal | Email + account holder name |
| Wise | green → lime | Brand-matched green |
| Jeeves | pink → rose | Phone + wire details |
| Wires | zinc → zinc | Manual wire transfers (catches `x1xxx` suffix codes) |

Active card is highlighted via Framer Motion's **`layoutId`** glow that physically slides between cards on tab switch.

#### 3.3.1 Brand logo support

`ProcessorLogo.tsx` does a HEAD probe on `/processors/{id}.svg`. If the asset exists, it renders the brand SVG inside a white tile. Otherwise it falls back to a gradient monogram tile (or icon, for non-brand cards like All / History).

To add a real brand logo: drop the SVG into `public/processors/` named after the processor id (e.g. `wise.svg`). See `public/processors/README.md`.

### 3.4 The table

Inside `ProcessorQueue.tsx`. **All Pending** view has 6 columns (avatar, person, bank, current pay, hours, action). Per-processor views have 5 (no bank — already filtered).

Sticky column header on desktop (`hidden md:grid`); on mobile each row collapses into a stacked card layout (`md:hidden`).

#### Per-row content

| Column | Content |
|---|---|
| Avatar | Gradient initials circle (deterministic palette per row id) |
| Person | Name (bold), work email (mono), expand chevron |
| Bank Preferred | Pill with processor accent dot + label; `x1xxx` wire suffix surfaces in mono-amber if relevant |
| Current pay | USD on top (`$412.55`), PHP underneath (`₱24,140`), muted |
| Hours | Total hrs on top, OT hours underneath (amber when > 0) |
| Action | "Mark paid" gradient button (emerald → teal, fixed width for column alignment) |

Click the row to expand the processor-specific contact details (Hurupay email, Higlobe email + account name, phone, full address, city, province/state) with copy buttons on each.

#### Search

`SearchBar` with **debounced** input (`useDebouncedValue` hook, 250 ms). Searches name, email, row id, and bank-preferred raw value. Right side shows three bouncing motion-driven dots while typing, then settles to a result count when the debounce completes. Clear button (X) appears when there's a query.

Empty states:
- **Queue clear** — green sparkles tile, when the pending list is empty by itself
- **No matches** — zinc search-X tile + the literal query in a code chip + "Clear search" pill

#### Skeleton

`QueueSkeleton.tsx` mirrors the table structure exactly. Renders during `loading || !hydrated` (hydration flag prevents the one-frame flash where loading flips off but local state hasn't synced from the fetched server data yet). Sliding-gradient shimmer on each placeholder bar, motion-driven 1.6s loop, with row-stagger on entrance.

### 3.5 Mark Paid dialog

Modal organised into two field groups (`MarkPaidDialog.tsx`):

**Send details** (Lenny enters):

- **Transaction ID / details** — paste from processor *(required)*
- **Bank used (sent from)** — e.g. "BPI corporate", "Wise USD" *(required)*
- **Date sent** — date input, defaults to today *(required)*
- **Arrival date** — optional date input

**Recipient banking** (snapshotted to the dispatch row, pre-filled from rates):

- **Preferred bank** — readable bank name (e.g. "Hurupay", "BPI", "UnionBank")
- **Account holder** — name on the recipient's account
- **Account number / wallet ID** — for digital wallets this is usually the email; for wires it's the bank account number
- **SWIFT code** — only shown for the Wires processor

**Outcome:**

- **Status** — pill segmented control: `Paid` (default) · `Not Paid` · `Threshold` · `Problem`. Determines whether the row counts toward the hero "Paid" stat and whether the recipient stays in the pending queue (only `Paid` removes them — Threshold and Problem leave the person available for retry).
- **Note** — optional free-text textarea for context (e.g. "bank rejected, retrying tomorrow"). Stored in `payment_dispatches.note`.

The confirm button label and color adapt to the chosen status (`Confirm sent` / `Log dispatch` with emerald / amber / rose / zinc background).

The pre-fills follow Carla's per-processor spec:

| Processor | Pre-filled values |
|---|---|
| Hurupay | bank=Hurupay · acct=hurupay_email · holder=name |
| Wepay | bank=Wepay · acct=work email · holder=name |
| HiGlobe | bank=HiGlobe · acct=higlobe_email · holder=higlobe_account_name |
| Wise | bank=Wise · acct=work email · holder=name |
| Jeeves | bank=Jeeves · acct=phone_number · holder=name |
| Wires | bank=raw "Bank Preferred" (e.g. "x1161") · acct=blank · holder=name · SWIFT input shown |

On confirm: POST to `/api/payment-dispatches` with all 4 send fields + 4 recipient banking fields, optimistic remove from queue, refresh on success, rollback on failure.

### 3.6 Sent payments history

`SentPaymentsHistory.tsx` — table of `payment_dispatches` rows for the current cycle. 7 columns (recipient, processor, USD, PHP, bank used, txn id, sent, arrival). On mobile: horizontal scroll (`overflow-x-auto` with `min-w-[760px]`).

---

## 4. Data layer

### 4.1 Schema additions

Two migrations (both idempotent, in `references/`):

#### `seed_payroll_dispatch_columns.sql` (migration #11)

Adds 8 quoted columns to `employee_hourly_rates` and seeds them from `references/NEW Payroll Dashboard - All Dept.csv` (1,062 rows after dedup + `#N/A` filter). Required so people show up in the dispatch view.

```sql
ALTER TABLE employee_hourly_rates
  ADD COLUMN IF NOT EXISTS "Bank Preferred"       TEXT,
  ADD COLUMN IF NOT EXISTS "Hurupay Email"        TEXT,
  ADD COLUMN IF NOT EXISTS "HiGlobe Email"        TEXT,
  ADD COLUMN IF NOT EXISTS "HiGlobe Account Name" TEXT,
  ADD COLUMN IF NOT EXISTS "Phone Number"         TEXT,
  ADD COLUMN IF NOT EXISTS "Full Address"         TEXT,
  ADD COLUMN IF NOT EXISTS "City"                 TEXT,
  ADD COLUMN IF NOT EXISTS "Province/State"       TEXT;
```

UPDATEs use `COALESCE(new, existing)` so re-running cannot null out curated values. Distinct values seen in `Bank Preferred`: `Hurupay`, `HiGlobe`, `Wise`, `Jeeves`, plus a few `x1153` / `x1161` (account-suffix codes — handled as wires).

Regenerate via `node scripts/gen-seed-payroll-dispatch.mjs`.

#### `seed_payment_dispatches.sql` (migration #12)

Three things, all idempotent:

1. **`public.payment_dispatches`** — per-cycle pay log

   ```sql
   CREATE TABLE IF NOT EXISTS public.payment_dispatches (
     id                       UUID PRIMARY KEY DEFAULT gen_random_uuid(),
     cycle_id                 UUID REFERENCES public.hubstaff_uploads(id) ON DELETE SET NULL,
     cycle_period_start       DATE,
     cycle_period_end         DATE,
     cycle_source_file        TEXT,
     recipient_email          TEXT NOT NULL,
     recipient_name           TEXT,
     processor                TEXT NOT NULL,
     bank_preferred_raw       TEXT,
     -- Recipient banking snapshot (where money went TO, distinct from bank_used)
     recipient_preferred_bank TEXT,
     recipient_account_number TEXT,
     recipient_account_holder TEXT,
     recipient_swift_code     TEXT,
     -- Outcome of the dispatch attempt + free-text context
     status                   TEXT NOT NULL DEFAULT 'paid'
                              CHECK (status IN ('paid', 'not_paid', 'threshold', 'problem')),
     note                     TEXT,
     amount_usd               NUMERIC(10,2),
     amount_php               NUMERIC(12,2),
     transaction_id           TEXT NOT NULL,
     bank_used                TEXT NOT NULL,
     sent_date                DATE NOT NULL,
     arrival_date             DATE,
     created_by               TEXT,
     created_at               TIMESTAMPTZ NOT NULL DEFAULT now()
   );
   ```

   Indexes: `(cycle_id)`, `lower(recipient_email)`, `(cycle_id, lower(recipient_email))`. Email-normalization trigger attached if `normalize_email_column()` exists (from migration #5).

   The migration also runs `ALTER TABLE … ADD COLUMN IF NOT EXISTS …` for the four `recipient_*` fields after the `CREATE`, so re-running picks up the schema even if the table existed from an earlier migration run.

2. **Three `app_settings` seed rows** for the lock:
   - `payroll.dispatch_locked` — `'false'` / `'true'`
   - `payroll.dispatch_locked_at` — ISO timestamp when last locked, blank otherwise
   - `payroll.dispatch_locked_by` — operator email when locked, blank otherwise

3. **Realtime publication membership** — adds `app_settings` to `supabase_realtime` so employee dashboards can subscribe to lock changes:

   ```sql
   ALTER PUBLICATION supabase_realtime ADD TABLE public.app_settings;
   ```

   Wrapped in a `DO $$ ... $$` block that checks before adding, so it's safe to re-run.

### 4.2 Pay calculator

`src/lib/payroll/current-pay.ts` exposes `computeCurrentPay()`, which:

1. Fetches the **current** Hubstaff upload (`is_current = true`) via `getCurrentHubstaffUploadId()` + `fetchHubstaffRowsOrdered()`
2. Reads `employee_hourly_rates`
3. Reads `app_settings.usd_to_php_rate` (or falls back to `OFFICIAL_USD_TO_PHP_RATE`)
4. Per employee:
   - `regularHours = max(0, totalHours − otHours)`
   - `otHours = max(0, totalHours − 40)` (already on the Hubstaff row)
   - `regularPayPHP = regularHours × regularRate`
   - `otPayPHP = otHours × otRate`
   - `initialPayPHP = regularPayPHP + otPayPHP`
   - `initialPayUSD = initialPayPHP / fxRate`
5. Derives `period.start` and `period.end` from the ISO-shaped date column names (Sun…Sat) in the Hubstaff data
6. Returns `{ period: { cycleId, start, end, sourceFile }, fxRate, byEmail }`

> **Caveats:** This is "initial pay" only — no department bonuses, no Tech / Perfect Attendance bonuses, no OT-suppression toggles, no manual hour overrides. The PayrollWizard remains the source of truth for the final paystub. The dispatch view is a quick "roughly how much" reference for Lenny so amounts can grow into the wizard later.

### 4.3 API routes

| Route | Method | Purpose |
|---|---|---|
| `/api/payroll-current-pay` | GET | Returns the `CurrentPayResult` from `computeCurrentPay()` |
| `/api/payment-dispatches` | GET | Lists dispatches, optionally filtered by `?cycle_id=` |
| `/api/payment-dispatches` | POST | Inserts a new dispatch row + writes audit-log entry `payment.dispatched` |
| `/api/payroll-dispatch-lock` | GET | Returns `{ locked, lockedAt, lockedBy }` |
| `/api/payroll-dispatch-lock` | POST | Toggles the lock — body: `{ locked: boolean }` — writes audit-log entry `payroll.dispatch.locked` / `payroll.dispatch.unlocked` with snapshotted operator + timestamp |
| `/api/employee-hourly-rates` | GET | Existing route, now also returns the 8 new payment-dispatch fields |

### 4.4 Audit log entries

Both lock toggles and dispatch records write `audit_log` rows. Lock-toggle details snapshot `started_by` + `started_at` so the row is self-contained:

```json
{
  "user_name": "carla@simple.biz",
  "user_role": "payroll_clerk",
  "action": "payroll.dispatch.locked",
  "resource": "app_settings",
  "resource_id": "payroll.dispatch_locked",
  "details": {
    "locked": true,
    "started_by": "carla@simple.biz",
    "started_at": "2026-04-27T12:34:56.789Z"
  }
}
```

Dispatch records:

```json
{
  "user_name": "lenny@simple.biz",
  "user_role": "payroll_clerk",
  "action": "payment.dispatched",
  "resource": "payment_dispatches",
  "resource_id": "<uuid>",
  "details": {
    "recipient_email": "anna.reyes@example.com",
    "processor": "wepay",
    "amount_usd": 412.55,
    "cycle_id": "<uuid>"
  }
}
```

Visible at `/admin` → Audit log.

---

## 5. Hooks

### 5.1 `useDispatchQueue()`

Located at `src/components/payroll-clerk/useDispatchQueue.ts`. Joins three sources:

1. `/api/employee-hourly-rates` — eligibility list + bank-preferred + contact fields
2. `/api/payroll-current-pay` — per-person USD/PHP pay + cycle period
3. `/api/payment-dispatches?cycle_id=<id>` — already-paid for the current cycle

Builds a `QueueRow[]` via `buildQueueFromRates()` from `mock-queue.ts` (filename historical — it's no longer mocks). Filters out anyone whose email already has a dispatch record in the current cycle, so the same person can't be paid twice.

Returns `{ rows, paid, period, fxRate, loading, error, refresh }`. The `refresh()` callback re-pulls everything; called after Mark paid succeeds.

### 5.2 `useDispatchLock()`

Located at `src/hooks/useDispatchLock.ts`. The single source of truth for the live "payroll is being processed" flag.

**Wiring:**

- **REST hydration** on mount: `GET /api/payroll-dispatch-lock` so the UI is correct before Realtime attaches.
- **Realtime subscription**: `postgres_changes` on `app_settings` filtered by `key=eq.payroll.dispatch_locked`. Channel names include a `useId()` suffix so concurrent subscriptions don't collide.
- **30-second backup poll**: belt-and-braces refetch in case Realtime is silently broken (publication missing, RLS blocking anon SELECT). Banner cannot be stuck for more than ~30s.
- **Focus / visibilitychange refetch**: refreshes whenever the tab regains focus.
- **Subscribe-status logging**: emits `[dispatch-lock] Realtime ready` to the console on SUBSCRIBED, or `Realtime CHANNEL_ERROR. Falling back to 30s poll.` on errors. Useful for diagnosing missing-publication issues.

**Returns `{ state, loading, setLocked }`** where `setLocked(boolean)` does optimistic update + POST + rollback on failure.

### 5.3 `useDebouncedValue()`

Generic 250ms debounce hook used by the search bar.

### 5.4 `AnimatedNumber`

Spring-tweened `<motion.span>` for the counters in hero stats and processor cards.

---

## 6. The dispatch lock — end-to-end flow

The mechanism that pauses employee disputes while Lenny is processing. This is the most important plumbing in the feature.

```
┌─────────────────────────┐                         ┌────────────────────────────┐
│  Lenny's Payment        │   1. Click Start ─────► │  POST /api/payroll-        │
│  Dispatch view          │                         │       dispatch-lock         │
│  (PayrollDispatch.tsx)  │                         │  body: { locked: true }    │
└─────────────────────────┘                         └────────────────────────────┘
                                                                  │
                                                                  │ upserts 3 keys
                                                                  ▼
                                         ┌──────────────────────────────────────┐
                                         │  app_settings rows updated:          │
                                         │  - payroll.dispatch_locked  = 'true' │
                                         │  - payroll.dispatch_locked_at = now  │
                                         │  - payroll.dispatch_locked_by = email│
                                         │  + audit_log INSERT                  │
                                         └──────────────────────────────────────┘
                                                                  │
                                          Postgres logical decoding emits UPDATE
                                                                  ▼
                                         ┌──────────────────────────────────────┐
                                         │  Supabase Realtime broadcasts        │
                                         │  postgres_changes event on           │
                                         │  filter: key=eq.payroll.dispatch_    │
                                         │  locked                              │
                                         └──────────────────────────────────────┘
                                                                  │
                                                                  ▼
   ┌─────────────────────────────────────────┐  ┌──────────────────────────────────┐
   │  EmployeeApp.tsx                        │  │  PayrollDispatch.tsx             │
   │  useDispatchLock fires onChange         │  │  useDispatchLock fires onChange  │
   │  → re-fetches lock state                │  │  → re-fetches lock state         │
   │                                         │  │  → ProcessingPill switches red   │
   │  Renders:                               │  │  → Toggle button crossfades      │
   │  • PayrollLockBanner (slides down)      │  └──────────────────────────────────┘
   │  • Sidebar "Paused" pill                │
   │  • One-time toast notification          │
   │                                         │
   │  Passes lockState.locked to:            │
   │  • MyDisputes (disables Submit, banner) │
   └─────────────────────────────────────────┘
```

### 6.1 Lenny's view (Payment Dispatch)

`PayrollDispatch.tsx` renders:

- **`ProcessingToggleButton`** — Start / Stop button. Crossfades icon + label between states using `AnimatePresence mode="popLayout"` (no hard swap). Spring hover lift + tap squish.
- **`ProcessingPill`** — "Not processing" (zinc) or "Processing · disputes paused" (rose, with animated ping dot).
- **`LockToggleConfirmDialog`** — confirmation modal with proper loading state. While the POST is in flight: button shows `Loader2` spinner, label says "Starting…" / "Stopping…", buttons disabled, dialog refuses to close on outside-click or Esc. Closes after success so the exit animation overlaps with the parent state change.
- **`togglingLock` flag** in component state guards against rapid clicks.

### 6.2 Employee view

#### `EmployeeApp.tsx` (shell)

- Mounts the **single** `useDispatchLock` for the employee tree.
- Tracks previous lock state via `useRef` to detect transitions and emit toasts only on change (not on initial mount).
- Renders `PayrollLockBanner` above the main content area.
- Passes `payrollLocked` to `EmployeeSidebar` and `MyDisputes` via prop.

#### `PayrollLockBanner.tsx`

A sticky banner at the top of the shell. Smooth `AnimatePresence` enter/exit (height + opacity + Y slide, easing `[0.16, 1, 0.3, 1]`, 320 ms). Components:

- Pulsing ring around a lock icon (motion `scale 1 → 1.5` with `opacity 0.6 → 0`, infinite loop)
- Title: "Payroll is being processed"
- Sub-line: "Started by Carla · 12 mins ago" (operator name parsed from email; `setInterval` ticks every 60 s for live relative time)
- Bottom-edge shimmer bar (motion `scaleX 0.2 → 1 → 0.2`, infinite, easeInOut, 2.8 s) — ambient activity feel
- Dismiss `X` button — collapses the banner locally for that user. Other notification layers (sidebar pill, inline form banner) still surface the state.

#### `EmployeeSidebar.tsx`

Spring-pop "Paused" pill on the **My Disputes** nav item when locked. Uses motion `initial={ scale: 0.6 }` → `animate={ scale: 1 }` with `type: 'spring', stiffness: 320, damping: 20`.

Plus the existing footer notice that's been in place since the lock landed.

#### `MyDisputes.tsx`

- Receives `payrollLocked` prop from the shell (no longer subscribes to its own `useDispatchLock` — single source of truth).
- Inline rose banner above the form, wrapped in `AnimatePresence` so it smoothly animates out when the lock flips off (height collapse + opacity fade + Y slide).
- Submit button: `disabled={…|| dispatchLocked}`, label changes from "Submit" → "Locked" with a `Lock` icon swap.
- `handleSubmit` short-circuits with a toast if the user somehow bypasses the disabled state.

#### Transition toasts

In `EmployeeApp.tsx`:

```
if (previous != null && previous !== current) {
  if (current) toast.error('Payroll processing started', { … });
  else toast.success('Payroll processing finished', { … });
}
```

Uses Sonner with custom rose / emerald icons. 6 s duration on lock, 5 s on unlock.

---

## 7. Files

### New components

```
src/components/payroll-clerk/
  PayrollDispatch.tsx           — embedded in /accounting (main view)
  PayrollClerkApp.tsx           — standalone /payroll-clerk shell
  PayrollClerkSidebar.tsx       — sidebar for /payroll-clerk
  ProcessorQueue.tsx            — the table (mobile + desktop layouts)
  ProcessorCard.tsx             — filter cards with shared-layout glow
  ProcessorLogo.tsx             — brand-logo loader with fallback
  MarkPaidDialog.tsx            — confirmation modal
  SentPaymentsHistory.tsx       — history table
  QueueSkeleton.tsx             — loading skeleton (mobile + desktop)
  AnimatedNumber.tsx            — spring counter
  mock-queue.ts                 — types, processor metadata, builders
  useDispatchQueue.ts           — queue + dispatches hook

src/components/employee/
  PayrollLockBanner.tsx         — global locked banner with animations

src/hooks/
  useDispatchLock.ts            — Realtime-subscribed lock state hook
  useDebouncedValue.ts          — generic debounce
```

### New libs

```
src/lib/
  payroll/current-pay.ts                         — server-side pay calculator
  supabase/payment-dispatches.ts                 — CRUD helpers
  supabase/payroll-dispatch-lock.ts              — get/set helpers
  supabase/browser.ts                            — singleton browser client (Realtime)
```

### New API routes

```
app/api/
  payroll-current-pay/route.ts
  payment-dispatches/route.ts
  payroll-dispatch-lock/route.ts
```

### New routes

```
app/payroll-clerk/page.tsx     — standalone Lenny page
```

### Migration files

```
references/
  seed_payroll_dispatch_columns.sql              — bank/contact data (1,062 rows)
  seed_payment_dispatches.sql                    — log table + lock setting
scripts/
  gen-seed-payroll-dispatch.mjs                  — regenerator for the column seed
public/processors/
  README.md                                       — where to drop brand SVGs
```

### Updated files

- `src/lib/supabase/employee-hourly-rates.ts` — extended `EmployeeHourlyRateRow` with the 8 dispatch fields + aliases in the mapper
- `src/components/Sidebar.tsx` — added "Payment Dispatch" nav item
- `src/App.tsx` — added the `payment-dispatch` case
- `src/components/employee/EmployeeApp.tsx` — mounts `useDispatchLock`, banner, transition toasts
- `src/components/employee/EmployeeSidebar.tsx` — "Paused" pill on Disputes nav item
- `src/components/employee/MyDisputes.tsx` — accepts `payrollLocked` prop, animated lock banner

---

## 8. Migrations to run

Both files are in `references/`. Run in this order in the Supabase SQL Editor:

1. **`seed_payroll_dispatch_columns.sql`** — required for people to show up in the dispatch view (without the `Bank Preferred` column populated, the queue is empty).
2. **`seed_payment_dispatches.sql`** — required for Mark paid persistence and the Start/Stop processing button.

Both are idempotent — safe to re-run if you're unsure whether they executed cleanly.

For Realtime to fire (vs. the 30-second poll fallback), the second migration's Step 3 must succeed. If it doesn't (e.g. RLS blocks the anon role from selecting `app_settings`), the lock UI still works — just with up-to-30-second latency instead of instant.

---

## 9. RBAC notes

The Payment Dispatch tab is currently **open to anyone with accounting access**. Future work:

- Add a `payroll_clerk` role to `src/lib/rbac/views.ts`
- Restrict the standalone `/payroll-clerk` page to `payroll_clerk` and `admin` only
- Restrict the `payment-dispatch` tab in Accounting to roles that should see it (Lenny + Carla + Fran, presumably)

The lock toggle should also be permission-gated server-side (currently any authenticated user can POST `/api/payroll-dispatch-lock`).

---

## 10. Open follow-ups

- **Cycle-specific lock** — currently the lock is global. If you ever want cycle A locked while cycle B is open, this needs revisiting (probably move the flag onto `hubstaff_uploads` or a sibling table).
- **Bonuses in the calculator** — `current-pay.ts` is initial-pay only. Eventually it should match what PayrollWizard outputs (bonuses, OT toggles, manual overrides) so Lenny sees the *final* number, not just the base.
- **Wepay tab** — empty in the source CSV (no Wepay employees yet). Tab still exists for when adoption ramps.
- **Unlocked-only Mark paid** — currently Mark paid works regardless of the lock. Consider gating it on `lockState.locked === true` so dispatches can only be logged during a "live" run.
- **Webhook out of `payroll.dispatch.locked`** — for slack-style notifications to managers when payroll starts.
- **Per-row dispatch retry** — if Mark paid POST fails, the row is restored but the dialog is closed. Could keep the dialog open with the entered values pre-filled.
- **`payment_dispatches` audit / undo** — there's no UI to delete a misclicked dispatch. Currently you'd have to delete the row via Supabase manually.
- **Pre-flight summary** — before Lenny clicks Start, show a count of who's about to be billed, total volume, and any people missing bank info.

---

## 11. Quick test plan

After both migrations run:

1. Open `/accounting` → Payment Dispatch in tab A.
2. Open `/employee` (signed in as any employee) in tab B.
3. **In tab A:** click **Start processing**, confirm. Within ~1s tab B should:
   - Show a red lock-icon toast
   - Animate the rose `PayrollLockBanner` down from the top
   - Render the "Paused" pill on the My Disputes sidebar item
   - If the user is on the Disputes tab, the inline banner should slide in and the Submit button should become "Locked"
4. **In tab A:** click **Mark paid** on any row, fill the 4 fields, confirm. The row should slide right + fade out, and the History tab should pick it up persistently (survives refresh).
5. **In tab A:** click **Stop processing**, confirm. Within ~1s tab B should:
   - Show a green unlock toast
   - Banner slides up and away
   - Sidebar pill disappears
   - Submit button restores
6. Open DevTools console in tab B — you should see `[dispatch-lock] Realtime ready (…)`. If you see `CHANNEL_ERROR`, Realtime is broken (probably the publication step in `seed_payment_dispatches.sql` didn't run); the 30-second poll keeps things working in degraded mode.
7. Visit `/admin` → Audit log. Each Start/Stop and each Mark paid should have its own entry with full details.
