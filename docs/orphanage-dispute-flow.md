# Orphanage Visit Dispute Flow

## Current Flow (as of 2026-05-02)

Disputes for orphanage visits are **no longer submitted by employees**. The flow is fully managed by the Orphanage Manager and Accounting.

### Steps

1. The orphanage leader sends a visit list to **Alyson**.
2. Alyson forwards the list to **Carla**.
3. **Carla** reviews the list and checks whether any additional days affect PAB eligibility beyond what Alyson submitted.
4. Carla (or any Orphanage Manager) creates the disputes on behalf of employees via the **Orphanage Dashboard → Create disputes**.
5. **Accounting** reviews the manager-created disputes and gives the final approval or denial.
6. Only after **Accounting approval** does the PAB Calendar treat that day as forgiven (green).

---

## Previous Flow (disabled — code retained)

The following flow was designed but superseded by Carla's decision above.

1. Employee clicked a red / below-7-hour day on their PAB Calendar.
2. Employee filed it as an `orphanage_visit` dispute from the **My Disputes** tab.
3. Orphanage Managers saw those submitted disputes in the Orphanage view.
4. Any Orphanage Manager could approve or deny.
5. On manager approval, the dispute moved to the Accounting queue.
6. Accounting gave the final approval or denial.
7. Only after Accounting approval did the PAB Calendar treat that day as forgiven.

---

## What Was Hidden

The **My Disputes** page was hidden from the Employee portal on 2026-05-02. All code is commented out and can be re-enabled by reverting the following:

| File | What is commented out |
|---|---|
| `src/components/employee/EmployeeSidebar.tsx` | `disputes` entry in `navItems` |
| `src/components/employee/EmployeeApp.tsx` | `MyDisputes` import |
| `src/components/employee/EmployeeApp.tsx` | `disputesPrefill` state |
| `src/components/employee/EmployeeApp.tsx` | `onNavigateToDisputes` prop on `EmployeeDashboard` |
| `src/components/employee/EmployeeApp.tsx` | `onNavigateToDisputes` prop on `EmployeeMyHours` |
| `src/components/employee/EmployeeApp.tsx` | `'disputes'` case in `renderContent` |

The `MyDisputes` component itself (`src/components/employee/MyDisputes.tsx`) is untouched.
