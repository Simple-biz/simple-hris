# Documentation: Antigravity HRIS System

*Meeting with Carla — June 16, 2026. System overview walkthrough + agreed development priorities.*

## Overview

Antigravity is the internal HRIS platform designed to manage payroll, employee performance, attendance, and corporate benefits. It provides distinct views for general employees and management/accounting personnel, utilizing Role-Based Access Control (RBAC) to ensure data security and operational efficiency.

## Core Features

### Employee Dashboard

The employee interface is designed for self-service and real-time visibility into compensation and benefits.

  * **Attendance Tracking:** Visual indicators display attendance status. A green status indicates perfect attendance, while a "forgiven" status allows for shift completion adjustments due to extenuating circumstances.
  * **Compensation Visibility:** Users can view estimated take-home pay and access detailed payroll history through the "eyeball" icon.
  * **Bonus & KPI Monitoring:** A dedicated section displays weekly KPI results, including bonuses, hours worked, and earnings progression, providing motivation and clarity on performance metrics.
  * **Benefits & Rewards:**
      * **Gift Management:** A portal to track anniversary gift history and confirm shipping details for company-provided items (e.g., equipment, apparel).
      * **Mesa Program:** Interface for viewing enrollment status, opting in/out, and viewing contribution history.
  * **Skill Sets:** A searchable repository of employee skills (e.g., language proficiency), enabling HR to identify specific talent requirements efficiently.
  * **Time Adjustments:** Capability to view and request adjustments for hours, including special event attendance (e.g., orphanage visits).

### Management & Accounting

The management portal provides advanced oversight and financial controls.

  * **Team Oversight:** Managers have access to a "My Team" view to monitor direct reports and team-wide performance.
  * **Bonus Catalog:** A centralized system to create, edit, and assign bonuses to individuals or entire teams. This includes flat-amount bonuses and formula-based commission structures.
  * **Admin Controls (RBAC):** Implementation of Role-Based Access Control to restrict sensitive functions (e.g., bonus editing, viewing the payment catalog) to authorized personnel (Accounting/Admin).
  * **Payroll Processing:** Functionality to input hours, manage disbursements, and track payroll cycle accuracy.

## Development Priorities

The following items are prioritized for future development to enhance system stability and functionality:

1.  **RBAC Refinement:** Complete the implementation of Role-Based Access Control to ensure that only designated administrators (e.g., Carla, Claire) have the ability to edit sensitive financial data, while others are restricted to view-only or no-access roles.
2.  **Chargeback Automation:** Automate the chargeback update process to allow for real-time tracking of win/loss ratios without manual spreadsheet intervention.
3.  **Scoreboard Integration:** Develop a "Manager Scoreboard" to provide a unified view of team metrics, including:
      * Email volume (start/end of day).
      * Chargeback handling stats.
      * Payroll processing time and error rates.
      * Deal setup and compliance violations.
4.  **Bonus Logic Fixes:**
      * Address the "PM Bonus" logic to correctly apply monthly payments rather than repeating weekly.
      * Fix bonus assignment triggers for employees with varying numbers of clients to prevent data redundancy and errors.
      * Improve error handling for the "Save" function to prevent accidental sign-outs during bonus entry.
5.  **Performance & Rendering:** Optimize the UI to support various screen sizes and resolutions, and improve loading times for large datasets.
6.  **Chatbot Integration:** Potential development of an AI chatbot interface for HR to query the system (e.g., "Find me someone who speaks Spanish").
