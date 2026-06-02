An extremely detailed and verbose summary for Antigravity has been created below, formatted as an MD file, outlining its role and the specific HRIS logic updates it is being used to develop.

``` markdown
# Antigravity Development Summary for HRIS Logic Update

## 1. Overview and Purpose of Document

This document provides a comprehensive, highly detailed summary of the Antigravity application, focusing specifically on its operational usage, current status within the development team, and the critical HRIS logic implementations being addressed using this tool. The intent is to formalize the recent development activities and required updates discussed in the team meeting and recorded in work logs, ensuring a clear roadmap for all subsequent HRIS logic changes.

Antigravity is recognized as an application from Google, denoted by the sender 'antigravity-noreply@google.com'. It serves as a key development tool for the team, particularly within the AI/API project, and is heavily utilized by Kane R for tasks pertaining to the Simple - HRIS system.

## 2. Antigravity Tool Profile and Recent Status

### 2.1 Tool Classification and User Experience

While initially categorized as an Integrated Development Environment (IDE), referred to as “Antigravity IDE” in work logs, the application has recently undergone significant changes in its user interface and functionality. Kane R noted a shift to an "agentic" function, questioning why it is "agentic and not an IDE anymore". Cob B and Kane R commented extensively on the drastic change in the UI, with Cob B confirming the "latest version indeed looks like LGBTQMMXS+1".

### 2.2 Operational Use and Time Allocation

The Antigravity application is integral to the development workflow, logged for substantial durations across multiple days. On June 1, 2026, the Antigravity IDE logged 2:14:57 of usage, demonstrating its active role in the HRIS development process. Other recorded usage instances span across months, highlighting consistent reliance on the tool for the AI/API project and the Simple - HRIS task, with individual sessions ranging up to an hour or more.

### 2.3 Known Technical Constraints

A current technical constraint noted during use is the incompatibility of specific extensions: Cob B reported that the "`Continue` extension doesn't work for me" within Antigravity and is currently testing the functionality via the Command Line Interface (CLI).

## 3. HRIS Logic Implemented or Under Development via Antigravity

The work performed with Antigravity directly supports the core payroll and HR functionalities discussed in the meeting.

### 3.1 Time Adjustment and Approval Workflow

The system is configured for time adjustments to accept input in separate fields for hours and minutes, which the system must convert into a decimal format.

A primary focus is the implementation of a robust, dual-approval workflow for time adjustments:
*   **Two-Vote Mandate:** Time adjustments require two managers' approval (two votes) to be considered a 'Yes' and subsequently passed to accounting.
*   **Role-Based Permissions:** A new role, "assistant manager," has been confirmed and can be configured with highly restricted views. This role can be set to view and approve **only** time adjustments, with all other team data hidden.

### 3.2 Onboarding and Offboarding Automation

*   **Bulk Onboarding:** Development is prioritizing bulk onboarding automation to address earlier migration and scale issues.
    *   **Email Content Update:** To prevent variable errors during bulk processing, the generic onboarding email greeting must be updated to simply "Hi" from a personalized greeting like "Hi Kane".
    *   **Pay Plans:** The system must integrate pay plans (which include details like perfect attendance and technology bonuses) into the onboarding process. For the four specified teams (Legion, Edit, Developers, and AI people), the PDF pay plans should be included with the onboarding automation alongside Hubstaff, Roboform, and other invitations, or directly on an extra page for signing. A download button must be added at the end of the onboarding paperwork process so new hires can obtain a copy of their submitted documents and the pay plan.
*   **Offboarding:** The system allows users to be moved to an 'Off-boarded sheet' and restored back to the master list. The current offboard automation is designed to "nuke the workspace account" upon execution. While the Global Master List is being deprecated, it will be maintained as a backup where the HRIS will now feed data into it, rather than the list feeding the HRIS.

## 4. Critical Payroll Logic Updates (Urgent Requirements)

### 4.1 Mesa Disbursement and Urgent Payments

A crucial update is required to handle urgent, non-weekly payments like Mesa account disbursements (e.g., for medical emergencies) or budget requests, which must be paid immediately upon approval.
*   **Bypass Payroll Wizard:** These urgent disbursements must bypass the standard Payroll Wizard weekly cycle.
*   **Immediate Payment Dispatch:** The approved requests should be directed straight to Payment Dispatch for immediate payout.
*   **"Urgent Payments" Tab:** The development must include a new "Urgent Payments" tab on the payment dashboard to handle these requests (which primarily use the Wise bank account).
*   **Approval Flow:** A dedicated "approved" button will be implemented in the request form flow (e.g., for Mesa) that pushes the item directly to Payment Dispatch, with the Payroll Wizard following up to ensure a record is kept.

### 4.2 Orphanage Hours and Perfect Attendance Bonus (PAB) Logic

Logic is required to handle special considerations for employees who attend events at the orphanage with Bob:
*   **Forgiveness Mechanism:** A feature must be developed for Carla T to upload a list of people and specific days they were with Bob. This allows those days to be marked as "forgiven" (e.g., using a purple color toggle) for PAB eligibility purposes, without affecting their logged hours or being treated as a time adjustment. This tool should allow for selecting multiple people and days.
*   **Orphanage Pay Calculation Formula:** A complex, specific formula must be implemented to correctly calculate the pay for orphanage hours, especially when those hours push a worker into overtime. This calculation must determine the amount to be paid at the regular rate (up to 40 hours) versus the overtime rate (beyond 40 hours) and separately track the total expense for reconciliation purposes.

### 4.3 HSL Weekend Pay Rate Update

The core pay calculation logic must be updated to apply a 15 pesos higher rate for all hours worked on Saturday and Sunday.
*   **Regular Weekend Rate:** If a worker has not reached 40 hours, weekend hours are paid at the regular rate plus 15 pesos.
*   **Overtime Weekend Rate:** If a worker exceeds 40 hours on the weekend, those hours are paid at the overtime rate plus 15 pesos.
*   The system must correctly account for the dual nature of overtime pay: the combined rate paid in the main column and the extra half-rate paid in a separate overtime column.

### 4.4 Data Aggregation

The system is designed to simplify payroll data for Lenny by aggregating all individual payments (salary, bonuses, Mesa disbursements, deductions) into a single, final value on the Payment Dispatch screen. This requires maintaining proper foreign exchange settings.

```
