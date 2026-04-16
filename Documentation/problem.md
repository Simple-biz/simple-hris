# Attendance Bonus Calculator — Reference & Implementation Plan

## Overview

This document breaks down how the existing Excel attendance bonus calculator works, based on the "How to Use This Sheet" tab and the supporting calculation sheets. The goal is to give enough detail to replicate the logic inside the payroll wizard.

---

## Data Source

The calculator is driven by time-tracking data exported from **Apploye** (previously Hubstaff). Each month, an admin exports a CSV report for the entire staff from `app.apploye.com/user/reports/time-and-activity`, then imports it into the `Import Time & Activity` tab. The raw import contains per-employee, per-day records including total hours worked and activity percentage.

---

## How Eligibility Is Determined

An employee receives the attendance bonus only if **all** of the following conditions are satisfied for the measurement period:

### 1. Zero days under the minimum shift length

A workday is counted as under-minimum if the employee worked fewer than **5 hours**. An employee must have **zero** such days in the period to qualify.

The `Employee Completed Data` sheet tracks this as `Days under min`.

### 2. Zero unexcused absent days

Absences are tracked across the entire period. Employees who appear on the `Individual Days Off` tab with approved time-off requests have their absences forgiven (counted as pre-approved). Only *unexcused* absences disqualify.

The field tracked is `Absent Days Total`, cross-referenced against `# Preapproved Absences`.

### 3. Minimum weekly hours met for all four workweeks

The measurement period is divided into **four workweeks**. Each workweek must clear a minimum total:

- **Non-HSL employees:** 35 hours per workweek (Sunday–Saturday).
- **HSL Team (Hogan Smith Law Firm):** 35 hours per workweek, but their week runs **Monday–Sunday** instead of Sunday–Saturday.

This is calculated in the `Combined Work Day Shifts` sheet and aggregated per employee per workweek in `Employee Completed Data` as `Workweek 1 hours` through `Workweek 4 hours`.

### 4. Not on the salary-excluded list

Employees listed on the `Salary Employees Excluded` tab are never eligible regardless of attendance (e.g., Emma Kitson, Carla Thomas, Jaquelin Zapata, etc.).

### 5. No ineligibility carry-over from the previous month

The `Ineligibility Tracking` and `Has Ineligibility from last month` columns track whether an employee was marked ineligible at the end of the prior period. Carry-over ineligibility blocks the current period bonus.

### 6. Not on the >50-hour workweek exception list (informational)

Employees who worked over 50 hours in any workweek are noted in the `Above 50hour Week` sheet. This does **not** automatically disqualify them, but it is surfaced in `Employee Completed Data` for review.

---

## Summary of Disqualifying Conditions

| Condition | Disqualifies? |
|---|---|
| Any day < 5 hours worked | Yes |
| Any unexcused absent day | Yes |
| Any workweek below 35 hours (non-HSL) | Yes |
| Any HSL workweek below 35 hours | Yes |
| Listed on Salary Employees Excluded | Yes |
| Ineligible carry-over from last month | Yes |

---

## Special Rules for HSL Team

Employees assigned to the Hogan Smith Law Firm team follow different calendar rules. The `HSL Team` tab lists these employees by name. Their workweek is Monday–Sunday rather than Sunday–Saturday. The `Employee Completed Data` sheet stores their weekly totals in the `HSLW1`–`HSLW4` columns alongside the standard weekly columns.

---

## Supporting Reference Tables

| Sheet | Purpose |
|---|---|
| `Eligible for Bonus` | Master list of employees who are even eligible to receive the bonus (role-based filter before any attendance check) |
| `HSL Team` | List of employees under the HSL workweek calendar |
| `Salary Employees Excluded` | Employees permanently excluded |
| `Company-Wide Days Off` | Holidays and company-wide off days (not counted against absence totals) |
| `Individual Days Off` | Approved personal time-off requests (pre-approved absences) |
| `Weekend Shifts` | Employees with non-standard schedules who work Sat/Sun instead of earlier weekdays |
| `<7hour Workday Exceptions` | Shifts expected to be under 7 hours that should not count as short-day violations |
| `Ineligibility Tracking` | Carry-over ineligibility status from prior months |

---

## End-of-Month Process

After running the calculator:

1. Copy columns A & B from `Employee Completed Data` into `Ineligibility Tracking` using **Paste Special → Values Only** (Ctrl+Shift+V). This preserves the carry-over status for the next run without copying live formulas.
2. Review the `Above 50hour Week` sheet for anomalies.
3. Finalize the `Eligible for Bonus` column in `Employee Completed Data` — employees with `TRUE` receive the bonus.

---

## Implementation Plan for the Payroll Wizard

### Step 1 — Data Ingestion

Accept an Apploye CSV upload (or API pull if available) with columns: `Date`, `Member`, `Total hours`, `Activity %`. This maps directly to the existing `Import Time & Activity` tab. Normalize date values and map each row to an employee record in the system.

### Step 2 — Define the Period & Workweeks

When a payroll run is initiated, the admin selects a start and end date. The system should:

- Identify the 4 workweeks within the period.
- Flag which employees are on the HSL calendar (Monday–Sunday weeks) vs. the standard calendar (Sunday–Saturday weeks).

HSL team membership should be stored as a boolean flag on the employee record, mirroring the `HSL Team` tab.

### Step 3 — Compute Per-Employee Attendance Metrics

For each employee in the period, calculate:

- `days_under_5hrs` — count of workdays where `total_hours < 5`, excluding entries covered by the `<7hour Workday Exceptions` list.
- `absent_days` — count of expected workdays where no hours were logged, after subtracting pre-approved days off.
- `preapproved_absences` — count pulled from the `Individual Days Off` and `Company-Wide Days Off` tables.
- `workweek_1_hrs` through `workweek_4_hrs` — sum of hours per workweek bucket.
- HSL variants of the weekly totals using the Monday–Sunday bucketing.

### Step 4 — Eligibility Check

Run the employee through the following gate logic (any `false` = ineligible):

```
is_eligible =
  days_under_5hrs == 0
  AND absent_days == 0
  AND workweek_1_hrs >= 35
  AND workweek_2_hrs >= 35
  AND workweek_3_hrs >= 35
  AND workweek_4_hrs >= 35
  AND employee NOT IN salary_excluded_list
  AND employee.prior_month_ineligible == false
  AND employee.name IN eligible_for_bonus_list
```

For HSL employees, use the HSL weekly totals instead of the standard ones.

### Step 5 — Flag Over-50-Hour Weeks

For informational display only, flag employees where any workweek total exceeds 50 hours. Surface this in the payroll review UI without blocking the bonus.

### Step 6 — Carry-Over Tracking

After finalizing bonuses for the period, write the result back to the employee record:

- `ineligible_next_period = true` if the employee was manually flagged (e.g., special circumstance), otherwise `false`.
- This value is read at the start of the next run in Step 4.

### Step 7 — Admin Overrides

The system should support:

- Adding an employee to `salary_excluded` permanently.
- Logging individual approved days off per employee, per date.
- Flagging a specific short shift as an exception (maps to `<7hour Workday Exceptions`).
- Adding company-wide off days that are excluded from absence counting.

### Step 8 — Output

Generate a report listing each eligible employee with their 4-week hour totals, absent day count, and short-day count. The payroll wizard should consume this as input to calculate and post the bonus amounts.

---

## Notes on the Current Calculator's Known Limitations

The spreadsheet's "To Do" section noted several pending items that should be accounted for when building the wizard:

- Name inconsistencies exist in the raw Apploye data (e.g., "april galang" vs "April Galang"). The wizard should normalize names before matching.
- Some employees appear under multiple projects or duplicate rows on the same day; these need to be summed, not double-counted.
- The calculator currently requires manual copy-paste for carry-over tracking. The wizard should automate this.