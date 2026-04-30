# Meeting with Carla — 2026-04-29

> Detailed, non-verbatim account of the discussion. Topics: HSL payroll
> complexity, the proposed "Hogan Sweet" dashboard, hour-calculation
> workflow, and the time-adjustment automation project.

## Initial Check-in and System Status

The meeting began with a brief check-in. Kane R mentioned that he had added the Hogan Sweet (HSL) tab but had not yet reviewed it. He also noted that he needs to create another tab for Ali. Carla T confirmed that she was ready to discuss the issues.

---

## Section 1: HSL Payroll Complexity and Data Problems

### HSL Bonus Data Submission Issues

Carla T expressed significant frustration regarding the bonus data submission from the HSL department.

**Problem Statement:**
Other departments submit bonus data that is easily manageable: names and emails match the payroll dashboard, and KPI summaries are nicely compiled, allowing for simple formula calculation. In contrast, HSL's office manager, Jid, sends data that is messy and requires extensive manual cleaning.

**Specific Issues with Data from Jid:**
- **Format:** Jid sends a list on Monday showing every person with the same KPI for each team, their rate, and their HSL name.
- **Data Quality:** Half of the provided simple.biz emails are incorrect.
- **Lack of Summary:** When Carla T requested a summary of KPIs to help with calculations (to fix prior errors where people missed bonuses or received incorrect amounts), Jid provided a detailed but unstructured list, claiming it was the summary.
- **Cleanup Workflow:** Carla T must copy columns A and B, copy all names, clean the data, and perform a VLOOKUP to match the employee information, calling the source spreadsheet "ugly" and "awful". An entire Monday was spent on HSL payroll due to this process.

### HSL Staffing and Compensation Constraints

- **Onboarding/Off-boarding:** HSL has constant daily staff changes, with people starting on various days (Monday, Wednesday).
- **Rate Changes and Movement:** People frequently switch between the simple team and Hogan. Base pay starts at $1.75/hr but changes upon moving to Hogan.
- **Weekend Differential:** HSL employees receive a different pay rate when working the weekend schedule, and overtime must be calculated using a separate, complex formula for the entire period worked.
- **Rate Consistency:** Rates are inconsistent and applied individually to each person, requiring Carla T to check for updates and manually adjust rates because the existing individual rate records are often outdated.

### HSL Bonus Structure and Calculation Workflow

Kane R asked for clarification on whether bonuses or formulas differed per person. Carla T confirmed that case managers have individual rates, and although the bonus rate is the same for all, the total bonus is based on individual or team collection/metric achievements (KPIs).

**Complex Case Manager Bonus Logic:**
Case managers are categorized into colored teams (Blue Team, Green Team, Yellow Team, etc.). Their bonus is tiered based on a completion percentage: for instance, over 90% completion earns $200+, and over 95% earns $350+. The percentage is calculated by dividing metrics like total cases by incomplete cases.

**Current Calculation Workflow:**
1. **Data Extraction:** Carla T uses VLOOKUP to combine data from various columns on multiple sheets (e.g., column N with columns A and B).
2. **Bonus Component Calculation:** Specific rates are applied: $250 for RFC (Request for Contact) and $100 for Patient Portal.
3. **Data Cleaning Constraint:** The source data uses the PHP symbol (pao), which must be manually removed to prevent formula errors.
4. **Final Tally:** A final formula sums all components to determine the total bonus amount.

### Data Matching Challenges

- **The "Carol" Problem:** Carla T frequently encounters names like "Carol" in the bonus data and must run additional formulas (VLOOKUPs) to find the correct corresponding employee. Formula failures result in `#N/A` errors, requiring manual identification.
- **Email Discrepancies:** Mismatched emails between the HSL report and the payroll dashboard cause VLOOKUPs to fail, which leads to missing bonus payments.
- **Email Reliability (Q&A):** Kane R asked if matching the work and personal emails for HSL staff is reliable. Carla T stated it is not; HSL struggles to maintain even the simple.biz email accuracy. The Hogan Smith email is likely a better record.
- **Inaccurate Data Entry:** The simple.biz email data in the HSL pay plan is manually encoded by Jid, which is confirmed to be a source of frequent mismatches and inaccuracies.

---

## Section 2: Proposed Payroll UI Solution and Requirements

### New System Design and Automation Goal

Kane R proposed creating a dashboard ("Hogan Sweet") to simplify the process and reduce the complexity imposed by HSL.

**Action Item & Requirement (Kane R):**
The team leaders should be "punished" by being given access to the Hogan Sweet tab to input their team members' scores directly. The system must then calculate the total values and provide the total bonuses linked to each employee's simple.biz email.

### Management Structure and Scale

- **Headcount:** HSL employs around 200 people.
- **Payroll Ownership:** HSL does not have its own payroll manager; the responsibility falls entirely to the accounting department.
- **Organization:** HSL is highly complex, operating like a company within a company, with departments such as Case Managers, Pre-hearing, Post-hearing, and the Intake Team (the largest, or "Legion team").
- **Hierarchy:** The structure includes Managers, Team Leads, Assistant Team Leads, Captains, Assistant QC, and Points of Contact.

### UI/System Requirements for HSL Data

- **Team Selection:** Carla T requested a method for team leaders to identify and select which people are on their team.
- **Transfer Feature:** Kane R suggested a feature that allows team leaders to select their team members via their simple.biz email, accommodating staff movement/transfers.
- **Master List Integration:** The employee drop-down selection should be based on the HSL simple.biz emails already available in the new payroll dashboard/master list.
- **Email Linkage Requirement:** Carla T requires the system to link an employee's personal name, HSL name/email (Hogan Smith email), and simple.biz email together.
- **Technical Detail:** Employees have three unique emails: Personal, Hogan Smith (`@HoganSmith.simple.biz`), and simple.biz. The simple.biz email remains active the entire time for all official communication.
- **Data Validation Logic (Assumption/Edge Case):** Kane R suggests using all three emails as "hooks." If at least two emails match, they can ensure a strong data connection.

### Legal and Invoicing Constraint

- **Constraint:** Carla T noted that Karen (her boss) stated they are not legally allowed to use the word "bonus" on the invoice sent to Hogan; it must be invoiced as "just pay".
- **Decision (Kane R):** The "bonus" payment should be renamed in the system to **"additions"** to satisfy the legal constraint while accurately reflecting the payment type.

---

## Section 3: Detailed Hour Calculation Workflow

Carla T explained the complexities of calculating basic hourly pay from the Hubstaff report.

### HSL Hourly Rate Differential Logic

- **Differential Rate:** HSL is paid at one rate Monday through Friday, and a higher rate on Saturday and Sunday (15% or 15 pesos more than the regular hourly rate).
- **Hubstaff Workflow:**
  1. Sum Monday through Friday hours into a total.
  2. Convert the total hours into a decimal format.
  3. Repeat the process for Saturday and Sunday hours.
  4. VLOOKUP and add the calculated hours to the Hogan tab.

### Overtime Integration and Formula Differences

- **Overtime Edge Case:** Overtime hours are not separated on the Hogan tab. If they were separated, the system would fail to apply the correct weekend differential rate.
- **Technical Detail:** A differential column is used to capture the overtime amount.
- **Formula Difference:** The total hourly formula for Hogan is different from all other departments because the Hogan formula adds all hours together, including overtime, while all other departments split out the overtime.

---

## Section 4: Time Adjustment Automation Project

Carla T shifted focus to the urgent need to automate time adjustments, citing high volume and inefficient manual processes.

### Time Adjustment Project Requirements

- **Automation Goal:** Workers should submit time adjustments that require approval from two managers before being sent to payroll. Once approved, the adjustment should auto-post to Hubstaff, eliminating payroll's manual work.
- **Volume Constraint:** The payroll inbox received 50 new emails this morning after being emptied to zero the day before.
- **Input Requirements (Mandatory Constraints):** The current worker submissions are often incomplete, lacking required detail. The new system must require:
  - Screenshots (proof of work).
  - An exact timestamp.
  - Sign-off/approval from two managers.

### Current Build Status and Edge Cases

Carla T showed the existing time adjustment form built by Cob's team.

**Current Form Fields:** Name, email, name as it appears in Hubstaff, department, time, and details.

**Missing Feature:** There is no clear field for submitting screenshots.

**Manager Workflow:**
- Managers use a dashboard to approve or reject requests.
- Carla T is only notified when a manager approves a request; she is not notified upon submission or rejection.
- The payroll view allows Carla T to approve the adjustment, and this action posts to Hubstaff via an API connection (verified functionality).

**Technical Edge Case (Hubstaff Manual Tracking):**
- The "Time Adjustment Project" is listed as a project in Hubstaff. Carla T cannot disable the manual tracking feature in Hubstaff.
- **The Problem:** Workers can intentionally or unintentionally clock into the "Time Adjustment Project" all day, making it difficult for payroll to distinguish a legitimate time adjustment entry from tracked work hours.
- **Source of Truth Decision:** Kane R asserted that Hubstaff must remain the source of truth and should be kept as "pure as possible" (no manual adjustments in Hubstaff). Any manual adjustment process should occur only in the new system before posting via the API.

---

## Conclusion and Next Steps

Carla T expressed annoyance over the lack of progress, feeling that accounting automation projects are consistently the lowest priority. She stated she will take the lead on pushing the project forward and is prepared to escalate to Bob if her boss, Karen (who dislikes automation), tries to shut it down.

**Action Item (Carla T):** Carla T will meet with Cob later that afternoon after carpool to address her annoyances and discuss the current project status. She promised Kane R a quick response regarding the Hogan Sweet UI feature requests.
