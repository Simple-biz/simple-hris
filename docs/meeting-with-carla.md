# Meeting with Carla — May 5, 2026

*Meeting Discussion Summary. Attendees: Kane (dev), Carla (payroll coordinator).*

---

## I. Payroll System and Dashboard Issues

### Data Misalignment in Master Spreadsheet

The master spreadsheet becomes corrupted when employees are added or removed, causing row data to shift. Observed example: Michelle's bank information and name appeared on Maya's row. This causes Carla's "ready for dashboard" sheet to misalign with the master list and bank keys.

### Manual Workload

Carla's core weekly problem is the high volume of manual copy-paste work required to move new employee information (bank details, preferred rate, etc.) into the system while waiting for the new payroll system. An XLOOKUP-based approach was attempted but the sheet still became unreliable.

### Payroll Checklist (Mandatory Steps)

1. Pull Hogan and Simple hours from Hubstaff.
2. Input the USD conversion formula.
3. Check for duplicates using A-to-Z sorting and conditional formatting.
4. Add Jackie's manager bonuses.
5. Process monthly billing for VA overtime (customers and HSL).
6. Process HSL-specific bonuses: Lead Gen, QC, Discovery, Callback Sales Assistant, Edit team.

### Handymen and Orphanage Pay

- Handymen work directly for the orphanage and are paid weekly at a special rate.
- Orphanage hours must be entered into dedicated **orphanage pay columns** (column AL) — **not** through Hubstaff and **not** into regular pay columns.
- The formula checks whether these hours trigger the overtime rate of **337.50 PHP** (not the standard 125 or 225 PHP rate).
- Carla is currently performing backfill corrections for missed orphanage hour payments from previous weeks, requiring new rows with notes specifying the correct date (e.g. `4/17`).
- **Ralph** is the only person dedicated solely to orphanage work (English teacher). All others on the orphanage list also work for HSL or Simple.

---

## II. HSL Perfect Attendance Bonus (PAB)

### Period and Eligibility

| Parameter | Value |
|---|---|
| Payroll week | Monday to Sunday (all other departments: Sunday to Saturday) |
| Current tracked period | April 6 – May 3, 2026 (four full weeks) |
| Minimum days required | 5 of 7 days |
| Minimum hours per day | 7 hours |

### Schedule Flexibility (Reconciliation)

HSL employees have shifting schedules (e.g. Tue–Sat or Mon–Fri). The system must detect when an employee misses hours on a weekday and check Saturday **and** Sunday for hours ≥ 7h to count toward their five working days. Both Saturday and Sunday must reach the threshold for the reconciliation to apply.

### Compensation Rationale

HSL employees receive a **15 PHP premium rate** because their schedule requires weekend availability, which is why their payroll week and PAB structure differ from other departments.

### System Update

Kane confirmed the payroll wizard logic is being updated for HSL to reflect the Monday-to-Sunday week and the flexible five-of-seven-day requirement, including the Sat+Sun reconciliation rule.

---

## III. PAB Violations and Ineligibility

### Violation Policy

Employees can lose their PAB due to **Hubstaff violations** or **camera violations**.

**Origin:** Policy was introduced after Bob became frustrated that employees had cameras off during a quarterly meeting. Jackie mentions it during orientation, but the policy lacks formal, consistent documentation.

### Warning System

| Offense | Consequence |
|---|---|
| First violation | Warning only |
| Second violation within reset window | Employee loses PAB for the period |

- Carla's suggestion: change the reset window from "less than one year" to **six months**.
- Carla receives the violation list from the compliance team, manually reviews it, and excuses certain camera violations (e.g. technical issues, customer-facing roles).
- Second offenses are generally not excused and result in PAB removal.

### Proposed System Improvement

Kane proposed:
- Automatically mark employees as PAB-eligible when no violations are recorded.
- A manual **tick/remove button** to flag employees as ineligible due to a violation, overriding the automatic eligible status.

---

## IV. Action Items and Next Steps

### Hubstaff Report Gap

The May 3 date is missing from the reports Kane currently has because Hogan uses a **different Hubstaff project**. Carla will send the full Hubstaff report for **April 26 – May 3** so the system can calculate PAB eligibility across all seven days by department.

### Immediate Workaround

While the system is not yet updated, Carla will proceed with her current eligible PAB list and handle disputes manually. Employees who believe they were incorrectly marked ineligible should email `payroll@simple.biz`.

### Claude AI

Kane recommended Carla install the **Claude AI browser extension** for sifting through large documents or sheets (identifies data by sheet, column, and row). Carla agreed to get it.

### Mesa Program

Carla offered to send Kane the link to the Mesa program document (`simple.biz/messa`), which explains how the program works.

### Monday Observation Session

Carla invited Kane to join her and Claire on **Monday** to observe the full new payroll week process live. Carla noted she often works late at night with Claire on payroll.

### Personnel

- **Ryan** was off-boarded today (May 5, 2026).
- Carla refunded a wrong payment made in error.
