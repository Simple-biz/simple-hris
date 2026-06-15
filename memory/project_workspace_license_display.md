---
name: workspace-license-display
description: Google Workspace license availability shown in Set Work Email modal; cached in app_settings
metadata:
  type: project
---

## Google Workspace License Display in Set Work Email Modal

**When:** 2026-06-15 — added license availability check to the Set Work Email modal for both individual and bulk assign modes.

**What:**
- New API endpoint `/api/hr/workspace-license-info` (GET) fetches cached Google Workspace license availability
- SetWorkEmailDialog now displays a card showing available vs. total licenses with color-coded status
- Status indicators:
  - 🟢 Green (available_licenses ≥ 3): "Licenses available"
  - 🟠 Orange (available_licenses ≤ 2): "Low on licenses" 
  - 🔴 Red (available_licenses == 0): "No licenses available"
  - 🟡 Amber (null/unconfigured): "License info unavailable"

**Where:**
- API: `app/api/hr/workspace-license-info/route.ts`
- UI: `src/components/hr/HrOnboarding.tsx` — SetWorkEmailDialog component
- Data store: `app_settings` table, key = `workspace.license_info`, value = JSON with `{ available_licenses, total_licenses, last_updated }`

**How HR updates license count:**
1. Check actual available licenses in Google Workspace Admin Console → Account → Licenses
2. (Future) Use Admin panel to update `workspace.license_info` in app_settings
3. For now, direct DB update: `UPDATE app_settings SET value = jsonb_set(value, '{available_licenses}', '5') WHERE key = 'workspace.license_info'`

**Why:** Before assigning work emails, HR needs visibility into whether Google Workspace has available licenses. Assigning when licenses are depleted fails silently with a "Save Pending License Request" webhook response.

**Related:**
- [[project_onboarding_workspace_pipeline]] — workspace account creation fires on work-email set
- [[project_designated_work_email_column]] — designated_work_email field tracks assignment outcome
