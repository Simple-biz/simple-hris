The following is a detailed summary of the discussion:

### New Employee and Payment Setup

  * **New Employee Data:** When new people are added, a new dropdown for the pay cycle (month or week) must be created, and existing information must carry over, including notes on position, participant status, bank updates, department, and rates. Formulas for payroll also need to be maintained, and a record of the last payment method used should be kept, as bank accounts can change frequently.
  * **Bank Information and Dashboard Access:** Kane R suggested an update feature for bank info where the employee can set one account as the "active bank account" for payroll, and any employee without bank information should be flagged. Carla T requested that employees without bank information should be **prevented from accessing the rest of the dashboard** until they provide it.
  * **Preferred Payment Processors:** Carla T prefers Wepay, Higlobe, and others because they are cheaper and faster than wires. The team wants employees to use these processors and not have "full control" to enter options like Gcash or digital wallets. Kane R will need a list of preferred options from Carla T to create a drop-down selector.

### Payroll Dashboard Technical Status and PAB Calculation

  * **SSO Server Error:** Kane R mentioned that the dashboard is currently experiencing an SSO (single sign-on from Google) server error and requested that Cobb fix it.
  * **PAB Calculation Feature:** The new payroll wizard allows for automatic PAB (Perfect Attendance Bonus) calculation. The correct payroll period runs from **Sunday to Saturday**. Kane R added a selector to manually set the PAB period if needed.
  * **Date Display:** Kane R suggested making dates that have not yet passed unselectable or grayed out.
  * **Testing PAB Accuracy:** Carla T suggested running a **parallel test** by using their existing payroll calculator alongside the new PAB calculator to verify its accuracy and provide feedback on the logic.
  * **PAB Tracking:** The system can function as a tracker, showing the PAB period and dates/hours served by an employee. An ineligible status due to missing hours can be changed if the absence is a "forgiven one" (like the orphanage program), making the employee eligible again.
  * **Bonus Calculation Timing:** The team is currently in the third week of the cycle. The fourth week is next week, and the tech bonus will be calculated on Sunday (the 3rd) for payout the week of May 4th.

### Missing Rates and Employee Identification

  * **13 Missing Rates:** Kane R observed 13 employees with missing rates. Carla T identified that these are likely **US employees** who do not qualify for the hourly payroll dashboard since they are paid through a separate system (QuickBooks) and should not be included.
  * **114 Missing Rates:** Kane R also found 114 employees with no rates. Carla T noted this is "scary" and suggested that her team investigate the list.
      * **Possible Reasons:** Investigation on individual cases revealed missing rates could be due to employees being **freelancers** (not hourly workers) or **new hires** who are not yet in the current payroll cycle.
  * **Developer/Contractor Pay:** Developers and contractors are paid per project, not hourly. Their pay is tracked on a separate tab, and their rates vary by location and currency (USD, PHP, Africa). Some may not have an "actual rate" in the same format as hourly workers.

### Pay Stubs and Dispute Workflow

  * **Pay Stub Timing:** Carla T stated that pay stubs are sent on **Friday, after pay has gone out**, to avoid an overwhelming volume of emails and disputes from employees while the accounting team is actively running payroll.
  * **Dispute Volume:** Carla T expressed concern that with over 800 workers and only two or three people handling payroll correspondence, high volume is a major issue.
  * **Proposed Dispute Feature:** Kane R suggested adding a "dispute" button on the employee dashboard that would be active for them to flag issues before payout. Carla T countered that she does not want employees to see their pay details or be able to reach out until she, as the calculator, marks the payroll as "ready".
  * **Dispute Button Solution:** Kane R proposed making the dispute button accessible only when the payroll is *not* actively being processed. If accounting initiates the final dispatch, the dispute button would be disabled for employees.

### Lenny's Payroll Clerk Dashboard

  * **Lenny's Role and Access:** Lenny T is a **Payroll Clerk** whose sole job is to send money via payment processors (Wise, Higlobe, etc.). She should not see any calculation details, and her dashboard needs to be a streamlined, special view.
  * **Required Functionality:** Lenny needs a list of people who need payment, categorized by payment processor (Wepay, Higlobe, Jeeves, Wise, wires). When she clicks on a processor tab, it should provide a list showing only the **name, email, and amount** for each person.
  * **Manual Data Input (Non-Negotiable):** Due to the boss's preference against automation for sending funds, Lenny needs a prompt after sending a payment to manually enter the following information for compliance purposes:
      * Arrival date (adjustable)
      * Transaction ID/Details (copied and pasted)
      * Bank used
      * Date it was sent (could automatically populate)
  * **Payment Processor Data Needs:** The information Lenny needs varies per processor:
      * **Wepay:** Email.
      * **Higlobe:** Account and email.
      * **Wires:** Name, account number, Swift code, and full address.
      * **Jeeves:** Phone number and all the wire details.
  * **Workflow:** Once a payment is marked as "paid," it should be removed from Lenny's list. The list should appear when a new pay cycle is marked as "ready".

The meeting concluded with Carla T confirming the top priority tasks for Kane R: providing the role assignment details (including Lenny's role definition) and running the parallel test of the PAB calculator.
