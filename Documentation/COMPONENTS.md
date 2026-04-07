# Simple HRIS: Component Reference

This document covers every UI component — what it renders, why it is designed that way, and all significant logic it contains.

---

## `src/App.tsx` — Root Shell

The top-level `"use client"` component. Owns the `activeTab` state (string), resolves dark/light theme from `next-themes`, and renders the two-column layout: `<Sidebar>` on the left and the active view on the right.

Also renders a global `<Toaster>` (sonner) for toast notifications that can be triggered from any child component.

Placeholder `<div>` cards are rendered for `hogan-suite`, `disputes`, and `settings` — they show a "Coming Soon" indicator so navigation works without errors.

---

## `src/components/Sidebar.tsx`

**Layout**: Fixed-width (`w-64`), full viewport height, flex column. Background uses the orange-to-white gradient (light) or navy gradient (dark) from CSS variables.

**Nav items** (top section):
- Overview, Rates, Payroll Wizard, Hogan Suite, Disputes, System Settings
- Active item: orange gradient background, right-aligned chevron icon, bold text
- Inactive item: ghost hover state, muted text
- Icons from `lucide-react`

**Bottom section** (pinned via `mt-auto`):
- Dark mode toggle: `<Switch>` bound to `next-themes` `setTheme`. Label reads "Dark Mode".
- User card: Hardcoded "Fran M / Senior Admin" with an avatar using an orange-to-blue CSS gradient. This is intentional for a single-operator internal tool — no auth UI is needed.
- Sign Out: Ghost button, red text on hover. No actual logout logic (placeholder).

**Design rationale**: The sidebar is always visible and never collapses. The tool is desktop-only and intended for use on a workstation during payroll processing, so a persistent sidebar improves orientation across a long multi-step workflow.

---

## `src/components/Overview.tsx`

The dashboard view. Loaded when `activeTab === "overview"`.

### Stat Cards (top row — 6 cards, responsive grid)

| Card | Value Source | Notes |
|---|---|---|
| Total Payout | Computed live from Hubstaff rows + rate map | Sum of all `initialPay` values |
| Active Workers | `GET /api/employees` count | Filtered to `status !== DISABLED` |
| Employees with Rates | `GET /api/employee-hourly-rates` count | Row count from rates table |
| Employees with Profiles | Checks bank + address fields | Counts rows where both fields are non-null |
| Avg. Hours | Static `38.5` | Placeholder — not computed |
| Pending Hires | Static `5` | Placeholder |

**Total Payout computation** runs in-browser after both `/api/hubstaff-hours` and `/api/employee-hourly-rates` resolve. For each Hubstaff row, it finds the matching rate by normalized email and calculates `regularPay + otPay`. Sums all results.

### Employee Table (middle-left, spans 2/3 of second row)

- Columns: Employee ID, Department, Name, Personal Email, Start Date
- **Pagination**: `PAGE_SIZE = 5`. `buildPageRange()` helper generates an ellipsis-aware array (e.g., `[1, 2, '...', 8, 9, 10]`) for the page buttons.
- **Search**: Filters across all rendered columns simultaneously (case-insensitive string match).
- **Department filter**: Dropdown that extracts unique department values from the data.
- Employee IDs are assigned by `generateEmployeeIds()` from `src/lib/supabase/employees.ts` — format `YYMM-NNNN`, grouped by start-date month, sorted by first name within group.

### System Health Panel (middle-right, 1/3 of row)

Three static health indicators with progress bars:
- Hubstaff API Sync: 98%, "Stable"
- Payroll Calculation Engine: 100%, "Stable"
- Recruitment DB Pipeline: 75%, "Degraded" (orange)

These are hardcoded. They serve as a visual dashboard placeholder until real monitoring is wired up.

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
- Columns: Employee ID, Name, Work Email, Regular Rate, OT Rate, View (eye icon), Delete (trash icon)
- Search: filters across name, emails, department, employee ID
- Rates formatted as `₱X,XXX.XX` using `en-PH` locale
- Employee ID shown if found in the ID map; otherwise `—`

**`tableRowFromProfile()`**: Extracts flat values from a nested profile by building a normalized field map (`buildNormFieldMap()`), then looking up canonical keys like `work_email`, `regular_rate`, `ot_rate`, `department`.

**`buildNormFieldMap()`**: Iterates all profile fields, normalizes each key with `normFieldKey()` (lowercases, replaces spaces with underscores), and indexes them. This lets the table work regardless of whether columns come from a table using `"Work Email"` or `work_email`.

### View Profile Modal

Triggered by the eye icon. Opens a `<Dialog>` up to 1,200px wide.

**Sections**:
1. Header: display name + subtitle (collapsed emails) + department badge
2. **Quick Rate Editor**: Shows current regular and OT rates. "Edit" button opens inline inputs. "Save" calls `POST /api/update-employee-rates`. "Cancel" restores original values.
3. **All Fields**: Rendered as a `<dl>` grid. Each field is a `<motion.div>` with staggered fade-in (`delay: i * 0.01`, capped at 0.28s). Date fields (keys containing `date` or `start`) are auto-formatted to "January 1, 2025" using `Date` constructor.

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
- Maps each employee's normalized email to an array of `{ col, seconds, passes }` for each weekday column, sorted Mon→Fri.
- Used to render colored day-pill indicators (M T W T F) in the PA toggle cell. Green = ≥7h, red = <7h. Hovering shows a tooltip with the full column name and logged hours.

**Auto-apply effect**: When `perfectAttendanceEligible` recomputes, a `useEffect` auto-toggles the `perfect_attendance` bonus for all department-assigned employees. Manual overrides after the effect are preserved.

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

## `src/components/ThemeProvider.tsx`

A thin wrapper around `next-themes`' `ThemeProvider`. Sets `attribute="class"` (Tailwind dark mode), `defaultTheme="system"`, `enableSystem`. The patch in `patches/next-themes+0.4.6.patch` fixes a hydration mismatch where the theme script was injected twice (once server-side, once client-side). The fix makes the `ScriptInjector` return `null` on the client.

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
