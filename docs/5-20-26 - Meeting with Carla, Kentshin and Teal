# Meeting Summary for ANTIGRAVITY Review

## Date and Attendees

  * **Date:** Wednesday, May 20, 2026
  * **Attendees:** Kane R, Kentshin W, Teal Crowley, Carla T

## I. Summary of Key Discussions

The meeting focused on the initial rollout and demonstration of the new HRIS functionality, specifically the onboarding flow, which revealed critical data integrity, system automation, and alias management issues requiring immediate development attention.

The final phase of onboarding automation, which is triggered by the **"Promote"** button and handles credentialing (Gmail, Hubstaff, Roboform), is currently **blocked by an N8.N platform issue**.

## II. HRIS System Updates

  * **Hubstep Maintenance:** Kane R posted a notification regarding a Hubstep maintenance schedule affecting the Legion and HSL teams on an upcoming Saturday.
  * **Access & Warning:** Teal Crowley's team was granted access to **Notifications**, **Onboarding**, and **Offboarding** sections. Kane R advised against using the **Off-boarding** feature until automation status with Vinci is confirmed, as it risks accidental employee off-boarding.
  * **Credential Update:** The cloud-hosted credential used for sending system emails (like onboarding links) was updated and re-authenticated by Carla T using the **Payroll** account to ensure proper sender attribution, as the previous credential using Kane R's email had expired.

## III. Onboarding Automation Review and Critical Issues

A demonstration of the onboarding process, including a simulated submission by Kentshin W, revealed the following technical issues and feature requests:

### 1\. W8 Ben / Location Validation

  * **Issue:** The onboarding form asks applicants if they are US-based, prompting non-US applicants to upload the W8 Ben form. Carla T noted applicants might deliberately choose "US-based" to bypass the upload, creating compliance problems.
  * **Proposed Fix:** Modify the **"Generate Link"** function to allow pre-selecting the applicant's location. This pre-selection would disable the location choice on the form, enforcing the correct W8 Ben requirement.

### 2\. Work Email Alias Conflict (Critical Data Integrity)

  * **Issue:** The system generates new work emails based on the Global Master List. However, employees who transfer departments (especially PMs and Accounting) are given alternate customer-facing email aliases (e.g., `chariseg@simple.biz`) in G Suite that are **not recorded on the Global Master List**.
  * **Resulting Problem:** The automated email creation process cannot detect conflicts with these existing aliases, leading to errors when attempting to create a new G Suite account that matches a pre-existing alias.
  * **Solution:** The Global Master List must be updated to include additional columns (up to three were suggested) for email aliases to allow the HRIS automation to check against all in-use addresses.

### 3\. Post-Onboarding Credentialing Automation

  * **Goal:** The **"Promote"** button is intended to automatically trigger the creation of G Suite, Hubstaff, and Roboform accounts and send all necessary credential emails, replacing Carla T's manual work.
  * **Blocker:** This automation is currently incomplete due to an **N8.N platform issue**.
  * **Roboform Deletion Problem:** Carla T noted that off-boarded employees are not being automatically deleted from Roboform, leading to license exhaustion. Gerald previously raised this concern to Thomas.
  * **Roboform Creation Timing:** Kentshin W clarified that the existing Roboform automation runs daily, creating accounts for those generated in G Suite the *previous day*, meaning a Friday G Suite creation results in a Saturday Roboform account.
  * **Action for Dev:** The "Promote" button must be configured to trigger the creation of Roboform accounts.

### 4\. Document Management and Payment

  * **Document Funneling Request:** Carla T requested that all submitted onboarding forms (like the W8 Ben) be automatically funneled into a designated Google Drive folder.
  * **Hurupay Details:** Carla T asked to integrate the capture of Hurupay account details (the linked email) directly into the onboarding form to eliminate the current need for applicants to manually email Payroll.

## IV. Action Items and Next Steps

| Owner                          | Task                          | Detail                                                                                                                                    | Status            |
| :----------------------------- | :---------------------------- | :---------------------------------------------------------------------------------------------------------------------------------------- | :---------------- |
| **Carla T**                    | **Global Master List Update** | Add three new columns to the Global Master List to record all alternate employee email aliases (e.g., PM emails) for conflict prevention. | **To Do**         |
| **Carla T**                    | **Drive Access**              | Provide Kane R with the Google Drive link and necessary permissions for the automated funneling of onboarding documents.                  | **To Do**         |
| **Kentshin W / Dev**           | **N8.N Fix**                  | Resolve the platform issue blocking the completion of the "Promote" button automation.                                                    | **Blocked**       |
| **Kentshin W / Dev**           | **W8 Ben Fix**                | Implement location-based logic to disable manual selection and enforce W8 Ben upload requirements during link generation.                 | **To Do**         |
| **Kentshin W / Dev**           | **Hurupay Field**             | Add a dedicated field to the onboarding form to capture the Hurupay-linked email address.                                                 | **To Do**         |
| **Kane R**                     | **Master List Sync Fix**      | Resolve the failing data sync between the Admin Master List and the Google Sheet source.                                                  | **To Do**         |
| **Thomas (Ownership Pending)** | **Roboform Deletion**         | Investigate and fix the issue of off-boarded employees not being automatically removed from Roboform.                                     | **Pending Check** |

