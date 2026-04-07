# Simple HRIS: Data Sources and Flow

## Overview
This document outlines where Simple HRIS pulls data from and how information flows through the system.

## 1. Master Employee List
- **Table Source**: The system reads from a Supabase table named `global_master_list` (or configurable via the `NEXT_PUBLIC_SUPABASE_EMPLOYEES_TABLE` env var).
- **Endpoint**: Data is queried by the UI through `GET /api/employees`.
- **Location in Code**: `src/lib/supabase/employees.ts`.
- **Data Extracted**: 
  - `Department`
  - `Name`
  - `Personal Email`
  - `Start Date`

## 2. Hubstaff Hours Data
- **Mechanism**: The user manually provides the data via CSV upload (Hubstaff export format) on the Payroll Wizard view.
- **Data Columns Needed**: `Organization`, `Email`, `Total worked`, and optional daily columns.
- **Endpoint**: Uploaded via `POST /api/hubstaff-hours` to parse it securely.
- **Database Table**: 
  - Validated CSV rows are inserted/replaced in the **`public.hubstaff_hours`** database table using the Supabase Service Role Key (`SUPABASE_SERVICE_ROLE_KEY`).
- **Location in Code**: 
  - `src/lib/supabase/hubstaff-hours.ts` & `hubstaff-hours-db.ts`
  - `app/api/hubstaff-hours/route.ts`
- **Computed Values**: Converts raw string hour inputs (e.g., "40:00:00") into total seconds for integer math to prevent floating point drifts, ultimately yielding decimal hour representations for accurate payroll.

## 3. Data Reconciliation (Validation)
- The UI retrieves both the Master Employee list and the weekly Hubstaff hours list.
- **Payroll Comparison**: Logic in `src/lib/payroll/compare-to-master.ts` attempts to map the uploaded Hubstaff emails to the master employee list. 
- Mismatched users or unidentified emails are flagged as discrepancies in the *Disputes & Conflicts* state before payroll dispatch calculations happen.
