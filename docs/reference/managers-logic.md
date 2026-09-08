The bonus calculation logic for each person in the **'Julie'** sheet is structured around specific Key Performance Indicators (KPIs) found in rows 3 through 13. Each person has a dedicated section with individual bonus components, criteria based on these KPIs, and a total calculation.### **KPI Reference Table (Rows 3-13)**  * **Row 3:** Average Form Response Time (Minutes)
  * **Row 4:** Internet Leads
  * **Row 5:** Internet Intakes (Sign ups)
  * **Row 6:** Total Intakes Sign up Last Week
  * **Row 7:** Total Intake Calls Made
  * **Row 8:** Insurance Sign Ups
  * **Row 9:** Case Status Outbound Messages
  * **Row 10:** New RFCs and DME
  * **Row 11:** Average Signed Up Clients Awaiting Filing
  * **Row 12:** Hearings Held
  * **Row 13:** Hearings with Incomplete Medical Records-----### **Bonus Logic by Person**#### **1. Gyd (Tura, Gyd)**  * **Components & Criteria:**
      * **Average Form Response \<1.0 Minutes (2500):** Earned if Row 3 \< 1.0.
      * **Internet Intakes/Internet Leads \> 25% (2500):** Earned if Row 5 / Row 4 \> 25%.
      * **Internet Intakes/Internet Leads \> 30% (1250):** Earned if Row 5 / Row 4 \> 30%.
      * **RD sign ups (25 per unit):** Based on Insurance Sign Ups (Row 8).
      * **Total Filings (25 per unit):** Based on Average Signed Up Clients Awaiting Filing (Row 11).
      * **Monthly Bonus (25000):** Earned during the last week of the month.
      * **Attendance (5000):** Fixed weekly bonus for attendance.
      * **Tech Allowance (1850):** Fixed weekly allowance.
  * **Total Bonus Formula (Row 33):** `=SUM(D16:D31)`#### **2. Eula (Pacheco, Eula Jane J.)**  * **Components & Criteria:**
      * **\>9,000 Outbound Case Status Messages (2500):** Earned if Row 9 \> 9,000.
      * **\>12,500 Outbound Case Status Messages (1250):** Earned if Row 9 \> 12,500.
      * **75 or More RFCs and DME (2500):** Earned if Row 10 ≥ 75.
      * **100 or More RFCs and DME (1250):** Earned if Row 10 ≥ 100.
      * **Attendance (5000):** Fixed.
      * **Tech Allowance (1850):** Fixed.
  * **Total Bonus Formula (Row 43):** `=SUM(D36:D41)`#### **3. Andy (Tolentino, Romel T. "Andre")**  * **Components & Criteria:**
      * **New Clients Awaiting Filing \< 3 Days (5000):** Earned if Row 11 \< 3.
      * **New Clients Awaiting Filing \< 2.5 Days (1250):** Earned if Row 11 \< 2.5.
      * **New Clients Awaiting Filing \< 2 Days (1250):** Earned if Row 11 \< 2.
      * **Attendance (5000):** Fixed.
      * **Tech Allowance (1850):** Fixed.
  * **Total Bonus Formula (Row 52):** `=SUM(D46:D50)`#### **4. Vee C (Mortos, Veronela Clarissa "Vee")**  * **Components & Criteria:**
      * **Hearing with Incomplete Medical Records \<5% (2500):** Earned if Row 13 / Row 12 \< 5%.
      * **Hearing with Incomplete Medical Records \<10% (2500):** Earned if Row 13 / Row 12 \< 10%.
      * **Attendance (5000):** Fixed.
      * **Tech Allowance (1850):** Fixed.
  * **Total Bonus Formula (Row 60):** `=SUM(D55:D58)`#### **5. Ems (Solon, Emily "Ems")**  * **Components & Criteria:**
      * **Monthly Performance Bonus (2500):** Based on performance metrics.
      * **Attendance (5000):** Fixed.
      * **Tech Allowance (1850):** Fixed.
  * **Total Bonus Formula (Row 67):** `=SUM(D63:D65)`#### **6. Star A (Abella, Esterlita I. "Star")**  * **Components & Criteria:**
      * **Monthly Performance Bonus (2500):** Based on performance metrics.
      * **Attendance (5000):** Fixed.
      * **Tech Allowance (1850):** Fixed.
  * **Total Bonus Formula (Row 74):** `=SUM(D70:D72)`#### **7. Jazmine (Roa, Sajda "Jazmine")**  * **Components & Criteria:**
      * **Attendance (5000):** Fixed.
      * **Tech Allowance (1850):** Fixed.
  * **Total Bonus Formula (Row 80):** `=SUM(D77:D78)`#### **8. Jazz (Redulla, Jazz)**  * **Components & Criteria:**
      * **Monthly Performance Bonus (2500):** Based on performance metrics.
      * **Attendance (5000):** Fixed.
      * **Tech Allowance (1850):** Fixed.
  * **Total Bonus Formula (Row 87):** `=SUM(D83:D85)`#### **9. Mariel (Yungco, Marielace "Mariel" Buena Fe)**  * **Components & Criteria:**
      * **Closes over 30% of overall leads (2500):** Earned if Row 5 / Row 4 \> 30%.
      * **Average Form Response \<1.0 Minutes (2500):** Earned if Row 3 \< 1.0.
      * **Attendance (5000):** Fixed.
      * **Tech Allowance (1850):** Fixed.
  * **Total Bonus Formula (Row 94):** `=SUM(D90:D93)`#### **10. Dan A (Abad, Danilo Jr "Dan")**  * **Components & Criteria:**
      * **Closes over 30% of overall leads (2500):** Earned if Row 5 / Row 4 \> 30%.
      * **Average Form Response \<1.0 Minutes (2500):** Earned if Row 3 \< 1.0.
      * **Attendance (5000):** Fixed.
      * **Tech Allowance (1850):** Fixed.
  * **Total Bonus Formula (Row 101):** `=SUM(D97:D100)`#### **11. Julie C (Julie Credo)**  * **Components & Criteria:**
      * **Closes over 30% of overall leads (1250):** Earned if Row 5 / Row 4 \> 30%.
      * **Average Form Response \<1.0 Minutes (1250):** Earned if Row 3 \< 1.0.
      * **Attendance (5000):** Fixed.
      * **Tech Allowance (1850):** Fixed.
  * **Total Bonus Formula (Row 108):** `=SUM(D104:D107)`#### **12. Jay (John Michael Hernandez)**  * **Components & Criteria:**
      * **Closes over 30% of overall leads (1250):** Earned if Row 5 / Row 4 \> 30%.
      * **Average Form Response \<1.0 Minutes (1250):** Earned if Row 3 \< 1.0.
      * **Attendance (5000):** Fixed.
      * **Tech Allowance (1850):** Fixed.
  * **Total Bonus Formula (Row 115):** `=SUM(D111:D114)`
-----

### **2026-08-30 sheet — banded weekly tiers (approved by Rob effective Aug 24, 2026 and Austin effective Aug 31, 2026)**

Ruling (Carla T, 2026-09-08): starts with the **8/30–9/5 payroll week**; the 8/23–8/29 week stays as paid under the sheet above. Star's and Ems's lines are now **earned weekly**. Ems's "Pending for Approval" row proceeds. Gyd, Eula, Andre, Vee and Jazz Redulla are **unchanged** and keep the sheet above. Each line is ONE metric for the week that lands in exactly one band; only that band pays (the scorer picks the band reached). Attendance (₱5,000) and Tech Allowance (₱1,850) are still listed on the sheet and are still paid by the PAB + Technology engine, never here.

| Name | Role | Email | Metric | Bands |
| --- | --- | --- | --- | --- |
| Yungco, Marielace "Mariel" Buena Fe | Intake Manager | mariely@simple.biz | sign-ups | 1,500+ → ₱10,000 · 1,400–1,499 → ₱8,000 · 1,300–1,399 → ₱6,500 · 1,200–1,299 → ₱5,000 · 1,199 and below → ₱0 |
| Abad, Danilo Jr "Dan" | Intake Team Leader | dana@simple.biz | sign-ups | same as Mariel |
| Credo, Julie Ann "Julie" | Intake Team Leader | juliec@simple.biz | sign-ups | same as Mariel |
| Hernandez, John Michael | Intake Team Leader | jayh@simple.biz | sign-ups | same as Mariel |
| Santos, Sherwin *(new to the cohort)* | Lead Nurture Team Leader | sherwins@simple.biz | sign-ups | 500+ → ₱10,000 · 400–499 → ₱7,500 · 300–399 → ₱5,000 · 299 and below → ₱0 |
| Abella, Esterlita I. "Star" | Post-Hearing Manager | stara@simple.biz | % completion | 100%+ → ₱5,000 · 90–99.99% → ₱3,500 · 85–89.99% → ₱2,500 · below 85% → ₱0 |
| Rosales, Anna Rowella "AR" *(new to the cohort)* | Executive Guest Services Team Leader | arr@simple.biz | failovers | 0 → ₱10,000 · 1 → ₱5,000 · 2+ → ₱0 |
| Roa, Sajda "Jazmine" *(new to the cohort)* | Mail-Sorting Team Leader | jazminer@simple.biz | weekly batches | 40–50+ → ₱2,000 · 30–39 → ₱1,500 · 29 or fewer → ₱0 |
| Solon, Emily "Ems" | Pre-Hearing Manager | emss@simple.biz | % cases prepared | 98–100% → ₱5,000 · 95–97.99% → ₱3,500 · 87–94.99% → ₱2,500 · below 87% → ₱0 |

The sheet also notes "Updated Base pay ₱355" for AR — a rate-catalog change, already applied there per Carla, not a KPI-calculator line.
