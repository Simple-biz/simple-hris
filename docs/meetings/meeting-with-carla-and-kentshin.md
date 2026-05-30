# HRIS and Payroll System Change Log (For Antigravity Implementation)

This document details all discussed changes, decisions, and required updates for the HRIS and Payroll Wizard systems, intended for verbose and descriptive implementation by the Antigravity team. The primary goal is to address scaling issues, process inconsistencies, and system bugs related to onboarding, offboarding, and payroll calculation.

## 1\. HRIS Leadership and System Roles

  * **Nava Leader Assignment:** Kentshin W is now confirmed as the Nava leader for the HRIS system.
  * **Carla T's Promotion Status:** The previous system issue preventing Carla T from receiving necessary materials was identified as a lack of proper promotion within the system. This has been confirmed as the root cause for missing information.

## 2\. Onboarding Process Changes & Features

### Invite Workflow Logic

The requirement for staggered account creation has been overridden due to process inefficiencies.

  * **Required Change:** All onboarding invites (including Hubstaff and Workspace account creation) must now be triggered and sent out simultaneously at one time, weekly.
  * **Post-Orientation Process:** If a new hire reschedules their orientation, the team will manually off-board and then re-onboard them as needed.

### Bulk Onboarding Feature (New Design)

To support the onboarding of large batches (e.g., 50 people from the Lead Gen department weekly), a new bulk process is required to replace the current individual link generation.

| HRIS Bulk Onboarding Design            | Implementation Detail                                                                                                                                                                                                                                           |
| :------------------------------------- | :-------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Data Source Connection**             | Kane R will connect the HRIS to the Lead Gen Google Sheet, similar to the existing Master List and New Payroll Dashboard connections.                                                                                                                           |
| **New Feature: Refresh Button**        | A "Refresh" button should be created in the HRIS to pull all pending hires from the connected Lead Gen sheet.                                                                                                                                                   |
| **New Feature: Bulk Link Generation**  | The "Generate Link" button must be updated to send the links to *all* listed personal emails in the batch simultaneously, assuming they belong to the same department (e.g., Lead Gen).                                                                         |
| **Input Data Modification (CRITICAL)** | The HRIS input for generating links should be modified to **only require a batch of personal emails**. The system must remove the requirement for entering the first name and last name, as this information will be captured later via the new hire paperwork. |
| **Pending Clarification:**             | Confirmation is needed from Drew regarding whether the source Lead Gen Google Sheet is consistently cleaned up weekly to ensure links are not resent to previous hires.                                                                                         |

### Email Content Updates

  * **Combined Workflow:** Kentshin W will combine the separate workflows for sending emails, preferably into a single point of failure (one combined webhook call), as suggested by Kane R.
  * **Instructional Content:** The workflow must include two essential instructional emails: the "Hubstaff Overview" and the "Roboform" (password manager) instructions.
  * **Email Format Update:** Kentshin W has already modified the password manager email to use **buttons linking to Google Drive** for viewing the video and text, replacing the previous attachment-based format. The Hubstaff email should also be updated to fit this current team email theme.
  * **RoboForm Automation Status:** Full RoboForm automation is not currently possible. Kentshin W will follow up with Thomas after his vacation to explore future automation.

## 3\. Offboarding Process Changes & Logic

### Department-Based Offboarding Logic

The offboarding automation must be updated to handle differing deletion timelines based on the employee's department.

  * **Lead Gen Department:** If a worker is from Lead Gen, their email and accounts must be deleted **immediately** upon offboarding.
  * **Other Departments (e.g., AI API Team):** For non-Lead Gen departments, the worker's email account (Gmail) must be **deactivated** and kept for a two-week delay before the final deletion occurs.
  * **Attendance Trigger:** An additional automation trigger is required: If Manager Jackie marks a hire as "No Attend" in orientation, and they are from the Lead Gen department, they must be **automatically off-boarded** immediately. If they are from another department, the standard two-week delay for deletion must apply.
  * **Implementation Note:** Kane R will add the department logic to the HRIS to prevent immediate automation for non-Lead Gen departments.
  * **Coordination:** Kentshin W will coordinate with Sir Vinci, who manages the off-boarding automation, to ensure the new logic is implemented and consistent.

### Hubstaff Removal Process Update

The process for removing off-boarded members from Hubstaff needs a critical update.

  * **Required Change (Hubstaff):** When a worker is off-boarded, the "remove member" function from Hubstaff must be executed **immediately** as part of the offboarding automation.
  * **Outdated Process Note:** The old process of only disabling tracking and waiting a week to delete the member is unnecessary, as deleted members are still included in reports.
  * **Pay Rate Fix:** To prevent the pay rate from being displayed incorrectly (e.g., "USD"), the pay rate payload being sent to Hubstaff should be explicitly set to **zero**.

## 4\. Payroll Wizard Updates and Requirements

### Feature Additions/Modifications

The following updates are required for the Payroll Wizard module:

| Component                   | Required Changes                                                                                                                                                                                                                                            | Owner/Note |
| :-------------------------- | :---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | :--------- |
| **Bonus Section**           | Add separate, editable fields for **Additions** and **Deductions** (Deletions). This is necessary because some workers may have a bonus, an addition, and a deduction in the same week, and having separate columns simplifies accounting and explanations. | Kane R     |
| **Mesa Tab (New Feature)**  | Add a new "Mesa" tab to the HRIS sidebar, accessible by the accounting team. This feature is for recording mid-week disbursements that occur in accounting, ensuring they are properly included in the weekly reports and payment dispatch.                 | Kane R     |
| **Exported Report (Excel)** | The Excel export for reports must be updated to include the **Employee ID**.                                                                                                                                                                                | Kane R     |
| **Audit Log Fix**           | The bug in the audit log that incorrectly attributes changes to the wrong user (e.g., attributing Carla T's changes to Kane R) must be fixed to correctly identify the modifying user or the "Payroll Wizard" itself.                                       | Kane R     |

### Feature Removals/Replacements

  * **Tenure Gifts Section:** The "Tenure Gifts" section in the Payroll Wizard is completely redundant and must be **removed**.
  * **Replacement Section (HSL Calculation):** The space occupied by the Tenure Gifts section will be replaced by a new feature for **HSL (Hogan) Payroll Calculation**.
      * The system needs the ability to perform separate initial payroll calculations based on the worker's project: one for "Simple" and one for "HSL," as Hogan's calculation method differs significantly.
      * The system must split the calculation logic based on the project the worker is assigned to.

## 5\. System Bugs Identified

  * **Account Disabled:** Kane R's new Workspace account was immediately disabled upon creation.
  * **Offboarding UI Bug:** The offboarding UI currently shows duplicate entries for a single person (e.g., two "Carla T" entries). Offboarding one entry currently deletes both. This must be corrected.
  * **Audit Log Attribution Bug:** The Audit Log feature within the Payroll Wizard incorrectly attributes changes to the wrong user (e.g., assigning Carla T's edits to Kane R). This needs immediate correction to ensure accurate audit trails.
  * **Hubstaff Invite Subject:** The Hubstaff invite subject line was previously showing an incorrect sender (e.g., "Fran" or "Thomas") but this was resolved by Kentshin W using Carla T's credentials.
