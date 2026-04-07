# Simple HRIS: System Architecture

## Overview
Simple HRIS is a web application designed to manage HR and payroll tasks such as uploading weekly Hubstaff reports, processing payroll data, applying bonuses, and reconciling discrepancies.

## Technology Stack
- **Framework**: Next.js (App Router setup at `app/`) acting as a shell.
- **Frontend App**: The core application logic resides in `src/App.tsx`, constructed as a React application nested inside the Next.js shell.
- **Styling**: Tailwind CSS combined with Shadcn UI and Framer Motion (`motion/react`) for fluid animations. Theme toggling is provided by `next-themes`.
- **Database Backend**: PostgreSQL managed via Supabase.
- **Data Parsing**: Uses `csv-parse` for local CSV data processing before uploading to the database.

## System Components
The application features a sidebar navigation (`src/components/Sidebar.tsx`) switching between multiple primary views:
1. **Overview**: General dashboard view.
2. **Payroll Wizard** (`src/components/PayrollWizard.tsx`): A multi-step structured workflow meant to:
   - Upload and process the Hubstaff weekly CSV report.
   - Show an aggregate ledger for additions (bonuses), adjustments, and urgent flags.
   - Pre-flight validation against master employee lists.
   - Dispatch payroll signals.
3. **Hogan Suite**: A dedicated view for handling the Monday-Sunday cycle management.
4. **Disputes & Conflicts**: A review interface for payment disputes or unmapped Hubstaff emails.
5. **System Settings**: Configuration view for API keys, DB connections, and rules.
