# Simple HRIS: Component Reference

This document covers every UI component — what it renders, why it is designed that way, and all significant logic it contains.

---

## `src/App.tsx` — Root Shell

The top-level `"use client"` component. Owns the `activeTab` state (string), `mobileNavOpen` for the off-canvas nav below the `md` breakpoint, resolves dark/light theme from `next-themes`, and renders the two-column layout: `<Sidebar>` on the left and the active view on the right.

On viewports narrower than `md` (768px), a top bar with a menu button opens the sidebar as a fixed drawer; backdrop tap or **Escape** closes it. `navigate()` wraps tab changes and closes the drawer.

Also renders a global `<Toaster>` (sonner) for toast notifications that can be triggered from any child component.

See [RESPONSIVE-DESIGN.md](./RESPONSIVE-DESIGN.md) for breakpoints, safe areas, and testing notes.

Placeholder `<div>` cards are rendered for `hogan-suite` and `settings` — they show a "Coming Soon" indicator so navigation works without errors. The **Disputes** tab renders `PabDisputeQueue`; see **Pab Dispute Queue** below.

---

## `src/components/payroll/PabDisputeQueue.tsx`

**Accounting → Disputes.** Lists `pab_day_disputes` via `GET /api/pab-disputes` with `awaiting_accounting=1` when the status filter is **Pending** (so Accounting sees both plain `pending` and `orphanage_manager_approved` rows). Search, pagination, and filters for Approved / Denied / All.

**Actions (gated by `DISPUTE_ACTOR_ROLES` from `/api/employee-roles`):**

- **Approve / Deny** — for rows awaiting Accounting (`pending` or `orphanage_manager_approved`). Orphanage visits do not collect hour overrides at approval; others can set override hours in the dialog.
- **Return** — only for `orphanage_visit` with `orphanage_manager_approved`; calls `PATCH` with `return_to_orphanage` and optional note.
- **Edit** — for terminal rows. Toggle Approved/Denied, adjust hours (non-orphanage), notes. When the row currently grants PAB forgiveness (`disputeGrantsPabForgiveness`), shows **Revoke PAB forgiveness** → confirm dialog → `PATCH` `edit` with `status: denied` and `override_hours: null`.

See [BUSINESS_LOGIC.md](./BUSINESS_LOGIC.md#pab-day-dispute-system) and [API_REFERENCE.md](./API_REFERENCE.md#patch-apipab-disputesid).

---

## `src/components/Sidebar.tsx`

**Layout**: Fixed-width (`w-64`), full height (`h-dvh`), flex column. Below `md`, the sidebar is `fixed` with a slide-in transform; `mobileOpen` (from `App`) controls visibility. From `md` up it is `static` in the flex row. Background uses the orange-to-white gradient (light) or navy gradient (dark) from CSS variables.

**Nav items** (top section):
- Overview, Rates, Payroll Wizard, Hogan Suite, Disputes, System Settings
- Active item: orange gradient background, right-aligned chevron icon, bold text
- Inactive item: ghost hover state, muted text
- Icons from `lucide-react`

**Bottom section** (pinned via `mt-auto`):
- Dark mode toggle: `<Switch>` bound to `next-themes` `setTheme`. Label reads "Dark Mode".
- User card: Hardcoded "Fran M / Senior Admin" with an avatar using an orange-to-blue CSS gradient. This is intentional for a single-operator internal tool — no auth UI is needed.
- Sign Out: Ghost button, red text on hover. No actual logout logic (placeholder).

**Design rationale**: On laptop and desktop, the sidebar stays visible for orientation during long payroll workflows. On phones and small tablets, it becomes a drawer so content can use the full width.

---

## `src/components/Overview.tsx`

The dashboard view. Loaded when `activeTab === "overview"`.

### CSV Source Selector

A `<select>` dropdown in the header allows switching between:
- **All Time** (`__all__`): fetches every source file individually, accumulates payroll rows, splits regular/OT per file per employee (same per-file split logic as the Employee Dashboard), then sums.
- **Specific file**: fetches that single file's data.
- **Default**: the latest file (lexicographically last, which corresponds to the most recent week for ISO-style filenames).

A loading spinner appears beside the dropdown while stats are recomputing.

### Stat Cards (top row — 4 cards, responsive grid)

| Card | Value Source | Notes |
|---|---|---|
| Total Payout | Computed live from selected Hubstaff file + rate map | Sum of all `initialPay` values; reacts to CSV selector |
| Active Workers | Distinct work emails in selected payroll data | Count of unique employees in the selected file(s) |
| In Payroll not in Master | Cross-reference payroll emails vs master list | Potential unregistered contractors |
| In Master not in Payroll | Cross-reference master list vs payroll emails | Employees missing from Hubstaff this period |

**Total Payout computation** runs in-browser after both Hubstaff data and rates resolve. For "All Time", hours are accumulated per employee across files with per-file regular/OT split, then pay is computed from the summed seconds. Stat card subtexts adapt to show the source (filename or "all uploads combined").

### Employee Table (middle-left, spans 2/3 of second row)

- Columns: Employee ID, Department, Name, Personal Email, Start Date
- **Pagination**: `PAGE_SIZE = 5`. `buildPageRange()` helper generates an ellipsis-aware array (e.g., `[1, 2, '...', 8, 9, 10]`) for the page buttons.
- **Search**: Filters across all rendered columns simultaneously (case-insensitive string match).
- **Department filter**: Dropdown that extracts unique department values from the data.
- Employee IDs are assigned by `generateEmployeeIds()` from `src/lib/supabase/employees.ts` — format `YYMM-NNNN`, grouped by start-date month, sorted by first name within group.

### Bonus & Status Panel (middle-right, 1/3 of row)

Three real metric sections replacing the old hardcoded "System Health" panel:

**Perfect Attendance Bonus**
- Fetches all source files on mount, merges per-employee data with canonical-to-ISO column resolution (same `resolveCanonicalColumnsToIso()` logic as the Employee Dashboard), then evaluates PAB eligibility for every employee using `buildPabCalendarWeeks()`.
- Shows: PAB period label (e.g., "Mar 2026"), eligible count (green), not eligible count (red), progress bar with percentage (eligible / total).
- Loading state with spinner while computing across all files.

**Technology Bonus**
- Fixed ₱1,850 per employee per cycle.
- "Payroll Discretion" badge — applied manually by the operator, not auto-computed from hours.

**Dispute Requests**
- Pending / Resolved / Rejected counts with color-coded icons.
- Currently shows 0 for all with a note that the dispute system is planned.
- Ready to wire up once the `hour_disputes` table and dispute API are implemented.

---

## `src/components/Rates.tsx`

Employee rate profile viewer with add/edit/delete capabilities.

### Data Loading

On mount, fetches two endpoints in parallel:
- `/api/employee-rate-profiles` — full merged profiles from all tables
- `/api/employee-ids` — explicit ID overrides

If the profile response includes merge errors (a `mergeNotes` field), a yellow banner appears at the top explaining which tables were inaccessible or blocked by RLS.

### Table View

- `PAGE_SIZE = 12`
- Columns: Employee ID, Name (with avatar), Department, Organization, Work Email, Regular Rate, OT Rate, View (eye icon), Delete (trash icon)
- **Employee Avatar**: Each row shows an `<EmployeeAvatar>` beside the name — displays uploaded photo, Gravatar, or initials. Photo URL and email extracted from the profile fields via `getAvatarInfoFromProfile()`.
- Search: filters across name, emails, department, employee ID
- Rates formatted as `₱X,XXX.XX` using `en-PH` locale
- Employee ID shown if found in the ID map; otherwise `—`

**`tableRowFromProfile()`**: Extracts flat values from a nested profile by building a normalized field map (`buildNormFieldMap()`), then looking up canonical keys like `work_email`, `regular_rate`, `ot_rate`, `department`.

**`buildNormFieldMap()`**: Iterates all profile fields, normalizes each key with `normFieldKey()` (lowercases, replaces spaces with underscores), and indexes them. This lets the table work regardless of whether columns come from a table using `"Work Email"` or `work_email`.

**Hidden fields**: Fields with keys matching `profile_photo_url`, `photo_url`, `avatar_url` (and variants) are filtered from the displayed field list via `isHiddenField()`. The photo is shown visually via the avatar instead of as a raw URL string.

### View Profile Modal

Triggered by the eye icon. Opens a `<Dialog>` up to 1,200px wide.

**Sections**:
1. **Header**: Large avatar (h-14 w-14) on the upper left with ring border, display name + employee ID badge to the right, department + organization badges below, email subtitle.
2. **Quick Rate Editor**: Shows current regular and OT rates. "Edit" button opens inline inputs. "Save" calls `POST /api/update-employee-rates`. "Cancel" restores original values. "Edit Profile" button opens inline form for name, department, emails, start date.
3. **All Fields**: Rendered as a `<dl>` grid. Each field is a `<motion.div>` with staggered fade-in (`delay: i * 0.01`, capped at 0.28s). Date fields (keys containing `date` or `start`) are auto-formatted to "January 1, 2025" using `Date` constructor. Photo URL fields are filtered out (shown as avatar in header instead).

### Add Employee Modal

Fields: Name (required), Department, Work Email, Personal Email, Start Date, Regular Rate, OT Rate.

On submit: calls `POST /api/add-employee` which inserts to both `employee_hourly_rates` and `global_master_list`. After success, re-fetches profiles to refresh the table.

### Delete Confirmation Modal

Triggered by trash icon. Shows the employee name + email. On confirm: calls `DELETE /api/delete-employee`. The API removes from both tables. After success, re-fetches profiles.

---

## `src/components/PayrollWizard.tsx`

The core feature. A 5-step wizard for the weekly payroll cycle, called the **"Friday Path"**.

**Step navigation**: Left sidebar shows 5 numbered steps with a `layoutId="active-indicator"` animated pill (Framer Motion) that slides between steps. Forward/back buttons in each step. Steps are rendered as `<motion.div>` wrappers inside `<AnimatePresence>` — entering steps slide in from the right (+x), exiting steps slide out to the left (-x), and the direction reverses when going back.

---

### Step 1 — Upload & Preview

**Purpose**: Load existing Hubstaff data from the DB and allow uploading a new CSV.

**On mount**: Fetches `GET /api/hubstaff-hours`. Both the service-role and anon-key paths now return the same JSON shape: `{ columns, rows, payrollRows, error }`. The service-role path uses `fetchHubstaffRowsOrdered()` (OpenAPI column discovery); the anon path does a direct `select("*")` and builds the same structure. This ensures `hubstaffDisplayColumns` and `hubstaffDisplayRows` are always populated.

**Table lock mechanism**: Once Hubstaff data is present (`hubstaffDisplayRows.length > 0`), the component sets `hubstaffTableLocked = true`. The upload area shows a "Data locked" badge and the table is rendered. A "Replace data" button sets `hubstaffTableLocked = false`, which shows the upload button again. This prevents accidental re-upload mid-wizard.

**CSV upload flow**:
1. File chosen via `<input type="file">`.
2. SHA-256 hash computed client-side (`src/lib/hash.ts`).
3. If hash matches last uploaded file: show duplicate-data approval dialog.
4. Approval dialog confirmed → `POST /api/hubstaff-hours` with CSV as `FormData`.
5. On success: **the CSV text is re-parsed client-side** using `parseCsv()` and `buildHubstaffDataFromParsedGrid()`. This sets `hubstaffDisplayColumns` and `hubstaffDisplayRows` directly from the CSV — not from a Supabase re-fetch.
6. **Why client-side re-parse?** The Supabase table may have ISO date column names (`"2026-03-24"`) while the CSV has Hubstaff-format names (`"Mon 3/24"`). Even with the server-side date-aware column mapping, there can be cases where daily column values end up as `null` in Supabase (e.g., different week's dates). Parsing client-side guarantees the daily breakdown data is always available for Perfect Attendance detection in Step 3.
7. Store hash, lock table. The previous `loadHubstaffPreview()` call is skipped — the CSV data is authoritative.

**Preview table**:
- Up to 8 columns shown. Priority order: Member, Email, Total Worked, Overtime Hours, Activity, Spent Total, Organization, Time Zone. Remaining actual columns fill slots after these.
- A computed `__overtime__` pseudo-column is inserted showing OT hours > 40 in indigo text.
- Pagination: 15 rows/page, compact `«‹›»` buttons.
- Search filters across all visible column values.

**Hogan Cycle toggle**: A `<Switch>` that sets an `isHoganCycle` flag. This marks the upload as the Mon–Sun cycle (Hogan Smith Law) vs the standard Tue–Mon cycle. Currently a flag only — no filtering logic changes downstream.

---

### Step 2 — Initial Calculation

**Purpose**: Compute base pay for every Hubstaff employee by matching them to their hourly rates.

**`CalcRow` type** (defined inline):
```
{
  member: string
  email: string          // Hubstaff email
  totalHours: number     // decimal
  regularHours: number   // min(total, 40)
  otHours: number        // max(0, total - 40)
  regularRate: number    // from employee_hourly_rates
  otRate: number         // from employee_hourly_rates
  regularPay: number
  otPay: number
  initialPay: number
  matched: boolean       // false if no rate found
}
```

**Overtime rule**: 40-hour weekly threshold. `regularHours = Math.min(totalHours, 40)`, `otHours = Math.max(0, totalHours - 40)`.

**Rate matching**: Email from Hubstaff row is normalized → looked up in the rate map from `indexHourlyRatesByEmail()`. If no match, `matched: false`, rates default to 0, initialPay is 0.

**Table design**: Frozen header (sticky `position: sticky top-0`), horizontally scrollable, tall fixed height. 10 columns. OT-related values (OT Hrs, OT Rate, OT Pay) rendered in `text-indigo-600` to visually separate them from regular pay columns. Unmatched employees shown with an orange warning badge.

**"Refresh Rates" button**: Re-fetches `/api/employee-hourly-rates` and rebuilds the calc rows without leaving the step.

**Currency**: Philippine Peso `₱` with `en-PH` locale formatting (`toLocaleString("en-PH", { style: "currency", currency: "PHP" })`).

---

### Step 3 — Additions (Department Bonuses)

**Purpose**: Apply per-department bonus rules on top of initial pay.

**15 department tabs** (rendered as `<Tabs>`):
Accounting, Edit, Devs, Lead Gen, US-Manager Bonus, Callback, QC, Discovery, HR, Sales Assistant, Smart Staff, Hogan Smith Law, Social Media, PM Team, Client VA, Site Building.

#### Department Auto-Assignment

Runs as a `useEffect` after calc rows are available. For each Hubstaff employee, tries 4 resolution tiers in order, stopping at the first match:

1. `personal_email` from their rate row → look up in master list → use `Department`
2. `name` from rate row → name match in master list → use `Department`
3. `work_email` from rate row → look up in master list → use `Department`
4. Hubstaff row `Job type` field → use as department string directly

Manual tab clicks override the auto-assignment. Once a user manually assigns someone, the effect will not overwrite it on re-render.

The **unassigned count** badge in the header shows how many Hubstaff employees have no department yet.

#### Perfect Attendance Auto-Detection

**Data source**: `hubstaffDisplayRows` — the raw row data with daily columns. After a CSV upload, this comes from the **client-side CSV re-parse** (not Supabase), so daily values are always present. On initial page load (no upload this session), it comes from Supabase — daily columns may be `null` if the original upload had a column-name mismatch (see Step 1 notes). When all daily values are null, a `dailyDataMissing` flag is set and an amber warning banner appears telling the user to re-upload.

**Weekday column detection** (`colIsWeekday()`): Uses a two-tier approach:
1. **Day-name prefix** takes priority: if the column starts with `Mon`, `Tue`, `Wed`, `Thu`, or `Fri` (short or full names like `Monday`), it is a weekday regardless of the date portion. This is authoritative because Hubstaff CSV headers always label the correct day.
2. **ISO date fallback**: for columns without a day-name prefix (e.g., `"2026-03-24"`), `parseColDate()` parses the date and `getDay()` determines the day of week.

`colDayPrefix()` + `DAY_PREFIX_MAP` drive identification, `colDayOrder()` sorts them Mon→Fri, and `dayLabel()` / `dayLetter()` produce the display labels.

**Per-employee eligibility** (`perfectAttendanceEligible` useMemo):
- Filters `hubstaffDisplayColumns` to weekday columns.
- For each employee row, parses every weekday cell to integer seconds with `rawValueToTotalSeconds()`.
- If **all** weekday values ≥ 25,200 seconds (7 hours), the employee is added to the eligible set.

**Per-employee breakdown** (`employeeWeekdayHours` useMemo):
- Maps each employee's normalized email to an array of `{ col, seconds, passes, forgivenByDispute }` for each weekday column in the PAB range.
- Used by the PAB cell pill and by the **PAB Calendar modal** (clickable from any cell in the Additions table) to render a full month view with per-day ✓/✗/★ states.

**Tri-state PAB pill** (`pabStatusByEmail` useMemo): the Additions table pill and the calendar-modal badge display **Eligible** / **Ineligible** / **In Progress** based on:
- Any past weekday in the PAB range with `!passes` → `ineligible` immediately (verdict locks, future days can't salvage the month).
- Today ≤ `pabMonthRange.end` with no past failures → `in_progress`.
- Period ended with all weekdays passing → `eligible`.

The underlying `perfectAttendanceEligible` set is still strict-pass only; this memo is display-only so in-progress months don't read as "Ineligible" just because future weekdays haven't happened yet.

**Auto-apply effect**: When `perfectAttendanceEligible` recomputes, a `useEffect` auto-toggles the `perfect_attendance` bonus for all department-assigned employees. Manual overrides after the effect are preserved.

#### PAB settings modal (Additions header)

PAB period configuration lives in the Payroll Wizard, not System Settings. A compact button in the Additions header (showing the active month + date range + any "Custom" badge) opens a modal containing:

- **Year navigation** (prev/next year arrows) scoping the month grid.
- **12-month picker**: each month pill shows a green dot when at least one Hubstaff date column falls in that month's range (`pabMonthDataCoverage` memo), an amber dot when a per-month override is saved, and a "Now" badge on today's PAB month. Months with no Hubstaff data are non-selectable (dashed border) — the constraint is *"a month can only be selected if it has data to evaluate"*, except the current month which is always selectable.
- **Active-month editor**: start/end date inputs that auto-save as an override for the selected month, plus **Auto-calc** (writes the canonical `getPabMonthRange(year, month)` window) and **Reset override** (deletes the override so the default formula takes over).
- **Refresh** — re-fetches PAB settings and Hubstaff uploads.

Storage keys: `pab_period_overrides` (JSON map), `pab_period_active_month` (`"YYYY-MM"`). Legacy `pab_period_manual`/`_start`/`_end` still honored on read and auto-migrated. See BUSINESS_LOGIC §"PAB period configuration" for the detailed schema.

#### Common Bonuses (all departments)

| Bonus | Amount | Type |
|---|---|---|
| Technology Bonus | ₱1,850 | Toggle |
| Perfect Attendance | ₱5,000 | Auto-toggle (can be overridden) |

#### Per-Department Bonus Logic

**Toggle-based** (on/off per employee):
- **US-Manager Bonus**: Leadership Bonus ₱3,500, Team Performance ₱3,000
- **Hogan Smith Law**: Case Resolution Bonus ₱3,000, Compliance & Accuracy ₱2,500
- Social Media, PM Team, Client VA, Site Building: have toggle UI but no specific bonuses defined yet

**Formula-based** (requires metric input):

| Department | Input | Formula |
|---|---|---|
| Accounting | Collected count | ≥30 → ₱450; 22–29 → ₱300; 17–21 → ₱200; else ₱0 |
| Edit | Ticket count | ₱50 per ticket |
| Devs | Ticket count + flags | ₱50/ticket; site delivery ₱50; specific named employees get ₱250 for checking work |
| Callback | Appointments + leads | ₱50/appt; plus internal lead-gen tier applied to callback employees |
| QC | Units sold + pool | Pool = units sold × ₱125–150 ÷ member count; Jerome Rosero exception: units×₱30 + callback×₱50 |
| Discovery | Prior week units | ₱25 per unit |
| HR | Headcount + new hires | Pool = headcount × ₱1,000 ÷ new hire count; "Teal" excluded from pool |
| Sales Assistant | Sales count | ₱150 per sale |
| Smart Staff | Appointments | ₱250 per appointment |

**Lead Gen**: Explicitly disregarded per company policy. Employees auto-assigned here see no bonus options.

#### Right Column Table

For each department tab, shows a table of that department's employees:
- Name, Hours (from calc), Metric input (number field for formula depts), Bonus toggles, Per-employee bonus total, Final Pay (initial + bonuses)
- Footer row: department totals

---

### Step 4 — Pre-Flight Validation

**Purpose**: Review the full payroll before dispatch.

**Three summary cards**:
- Total Initial Pay (sum of all calc rows' `initialPay`)
- Total Bonuses Added (sum of all bonus amounts from Step 3)
- Grand Total Payout + coverage ratio (employees with hours ÷ total master list employees)

**Full breakdown table**: All employees sorted by name. Columns: Department badge (or "Unassigned" in muted), Hours, Initial Pay, Bonuses, Final Pay. Grand total footer row.

**Validation checklist** (6 items, checkmark/warning icon):
1. Hubstaff Hours Uploaded
2. Initial Calculations Complete
3. All Employees Department-Assigned
4. Perfect Attendance Evaluated
5. Cycle Separation (Hogan toggle checked)
6. Master List Coverage (from `comparePayrollToMaster`)

**`comparePayrollToMaster()` from `src/lib/payroll/compare-to-master.ts`**:
- Builds a Set of all master personal emails (normalized).
- Maps each Hubstaff email to their max hours.
- Counts: on master + has hours, on master + no hours this week, Hubstaff-only (not on master).
- Returns stats object + up to 75 sample unmatched email strings.

---

### Step 5 — Dispatch

**Purpose**: Confirm and send payroll.

**Layout**: Centered animated circle (indigo gradient) with a Send icon. Shows worker count from the payrollComparison stats.

**Buttons**:
- "Preview Paystubs" → `toast.info("Coming soon")` (placeholder)
- "Confirm & Dispatch" → `toast.success("Payroll dispatched")` + resets wizard to Step 1 (placeholder — no actual payment API call)

**Design note**: The large centered circle animation signals "this is a significant action." The indigo accent (distinct from the global orange/blue) is used throughout the wizard as a visual cue that you are inside a specific workflow, not the general app.

---

## Employee Portal (`src/components/employee/`)

### `EmployeeApp.tsx` — Employee Shell

Top-level employee-side shell. Manages `activeTab`, `mobileNavOpen` (drawer below `md`), renders `<EmployeeSidebar>` and switches content via `renderContent()`. Resolves employee email from URL query params. Uses the same mobile top bar, backdrop, and `navigate()` pattern as `App.tsx`.

### `EmployeeSidebar.tsx` — Employee Navigation

Sidebar with nav items (dashboard, profile, hours, leaves, disputes, orphanage visits, settings). Shows employee name, avatar, view switcher, and dark mode toggle. Below `md` it is an off-canvas drawer controlled by `mobileOpen`; from `md` up it stays in the layout column.

### `EmployeeDashboard.tsx` — My Dashboard

The primary employee-facing view. Shows weekly hours, pay calculations, and PAB status.

**Sections:**
- **Header**: Employee name, PAB period badge, CSV source file selector (includes "All Time" option)
- **Bonus Indicators Card**: PAB eligibility status with month/date range info, Technology Bonus info
- **Stats Cards** (5-column grid): Total Hours, Regular Pay, Overtime Pay, PAB, Initial Pay
- **Daily Hours Breakdown** (bar chart): Per-day bars with 7h threshold line, color-coded (green ≥7h, amber <7h, gray weekend)
- **PAB Calendar** (grid): Mon–Fri calendar for the full PAB month period with pass/fail per day, skeleton loading, staggered animations
- **Pay Summary**: Rate breakdown, Regular/OT/PAB line items, total with USD conversion

**Key features:**
- **All Time mode**: Aggregates totals across all uploaded source files. Regular/OT split computed per-file independently at the 40h threshold, then summed. PAB shows accumulated eligible months × ₱5,000.
- **Canonical column resolution**: Source files with `monday`/`tuesday` columns are resolved to ISO dates using filename date ranges so weekly data doesn't overwrite during merge.
- **PAB Calendar**: Built via `buildPabCalendarWeeks()` — generates expected weekdays in the PAB range, maps actual hours, renders a grid with date/hours/status per cell.
- **Skeleton loading**: Full-page skeleton (header, bonus cards, stats grid, chart/calendar/summary) shown during initial data load. PAB calendar has its own skeleton with staggered pulse.

### `EmployeeProfile.tsx` — Profile

Employee profile information view with hero header and info panels.

**Sections:**
- **Hero Header**: Large avatar (80×80 / 96×96) with ring border and hover camera overlay for photo upload, employee name, email, department/job title/employee ID badges
- **Identity Panel**: Full name, Employee ID
- **Contact Panel**: Work email, Personal email
- **Employment Panel**: Department, Job type, Job title, Organization, Start date (with icons per field)
- **Compensation Panel**: Regular rate, OT rate (₱/hr)
- **Bank Information Card** (full-width): Primary and alternative bank accounts (bank name, account holder, masked account number showing last 4 digits, routing number). "Edit" button navigates to Settings tab. Empty state shows "Add Bank Details in Settings" button.
- **Data Sources Panel**: Shows the three Supabase tables that provide profile data

**Data sources**: Fetches from `/api/employees`, `/api/employee-hourly-rates`, `/api/hubstaff-hours`, and `/api/employee-ids` in parallel. Bank info comes from `employee_ids` table.

**Skeleton**: Full-page skeleton matching the hero + cards layout during initial load.

### `EmployeeSettings.tsx` — Settings

Employee self-service settings for personal email and bank information.

**Sections:**
- Personal email editor
- Primary bank account (account holder name, bank name, account number, routing number)
- Alternative bank account (same 4 fields)
- Save button with toast notifications

Updates via POST to `/api/update-employee-ids`.

### `EmployeeAvatar.tsx` — Avatar Component

Displays employee photo with fallback chain: uploaded photo (Supabase Storage) → Gravatar → initials (orange-to-blue gradient circle).

---

## `src/lib/hubstaff/calendar-column-dedupe.ts` — PAB Helpers

Shared module for PAB (Perfect Attendance Bonus) date logic, used by both PayrollWizard and EmployeeDashboard.

**Key exports:**
- `getPabMonthRange(year, month)` — Computes PAB start/end dates for a month (first Monday on/after 1st → Friday of last week with Monday in month)
- `inferPabMonthFromColumns(cols)` — Identifies target month from column date headers
- `filterColumnGroupsByPabRange(groups, cols, start, end)` — Filters column groups to PAB date range
- `buildPabCalendarWeeks(start, end, hoursByDateKey)` — Generates calendar grid (weeks × days) with hours data mapped
- `resolveCanonicalColumnsToIso(row, filename)` — Maps `monday`/`tuesday` columns to ISO dates using source filename date range
- `columnsAreAllCanonical(cols)` — Detects whether columns need resolution
- `pabDateKey(date)` — Stable date key for lookup maps
- `countMonFriInclusiveInRange(start, end)` — Counts weekdays in a range

---

## `src/components/ThemeProvider.tsx`

A thin wrapper around `next-themes`' `ThemeProvider`. Sets `attribute="class"` (Tailwind dark mode), `defaultTheme="system"`, `enableSystem`. The patch in `patches/next-themes+0.4.6.patch` fixes a hydration mismatch where the theme script was injected twice (once server-side, once client-side). The fix makes the `ScriptInjector` return `null` on the client.

### Theme cross-fade

All three sidebar toggles (Sidebar, AdminSidebar, EmployeeSidebar) wrap `setTheme()` with `withViewTransition()` (`src/lib/theme/with-view-transition.ts`), which uses the browser's **View Transition API** (`document.startViewTransition`) to snapshot the old theme, apply the new one, and cross-fade between them.

The fade is controlled by `::view-transition-old(root)` / `::view-transition-new(root)` keyframes in `src/index.css` (`theme-fade-out` / `theme-fade-in`, 420ms, `cubic-bezier(0.4, 0, 0.2, 1)`). Browsers without support fall back to an instant swap (Safari < 18).

An earlier attempt at a global `transition-property: background-color, …` on every element was removed because Tailwind utility classes overrode it on most components and the cumulative transitions made the rest of the UI feel sluggish. The View Transition approach is isolated to the theme swap and doesn't affect other hover/focus transitions.

---

## `components/ui/` — shadcn Primitives

These components are generated by shadcn and should not be edited directly. They provide accessible HTML foundations:

| Component | Usage in app |
|---|---|
| `badge` | Department labels, status indicators, step labels |
| `button` | All interactive buttons |
| `card` | Dashboard stat cards, modal inner panels |
| `checkbox` | Bonus toggle options (some depts) |
| `dialog` | View Profile, Add Employee, Delete Confirm, CSV upload approval |
| `input` | Search bars, metric inputs, rate editor |
| `label` | Form labels |
| `scroll-area` | Tall table containers |
| `select` | Department filter dropdown |
| `separator` | Visual dividers |
| `sonner` | Toast notification queue (Toaster component) |
| `switch` | Dark mode toggle, Hogan cycle toggle, per-employee bonus toggles |
| `table` | Employee table, calc table, bonus table, pre-flight table |
| `tabs` | Department tabs in Step 3 |
