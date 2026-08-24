import fs from 'node:fs';
const claims = `src/components/employee/EmployeeSidebar.tsx:352
app/api/department-transfers/route.ts:271
app/api/department-transfers/[id]/route.ts:291
app/api/department-transfers/[id]/route.ts:249
src/components/manager/ManagerApp.tsx:3271
src/components/manager/ManagerApp.tsx:3658
src/components/manager/ManagerApp.tsx:3967
src/components/manager/ManagerApp.tsx:2206
src/components/admin/AdminRoles.tsx:573
src/components/admin/AdminRoles.tsx:1085
src/components/people/PeopleTab.tsx:3466
src/components/people/PeopleTab.tsx:3451
src/components/people/PeopleTab.tsx:3262
src/components/people/PeopleTab.tsx:2445
src/components/people/PeopleTab.tsx:2607
src/components/people/PeopleTab.tsx:2669
src/components/people/PeopleTab.tsx:917
src/components/people/PeopleTab.tsx:785
src/components/Overview.tsx:1642
src/components/Overview.tsx:1477
src/components/Overview.tsx:4881
src/components/Overview.tsx:4777
src/components/Overview.tsx:323
src/components/Overview.tsx:311
src/components/Overview.tsx:1341
src/components/Overview.tsx:4271
src/components/accounting/PayrollWizardNotesFab.tsx:2434
src/components/accounting/PayrollWizardNotesFab.tsx:1909
src/components/accounting/PayrollWizardNotesFab.tsx:2242
src/components/accounting/PayrollWizardNotesFab.tsx:5772
src/components/accounting/PayrollWizardNotesFab.tsx:3397
src/components/manager/transfer-charts.tsx:265
src/components/manager/ManagerTransfers.tsx:541
src/components/manager/ManagerTransfers.tsx:1490
src/components/manager/ManagerTransferDialog.tsx:203
app/api/employee/penny-chat/route.ts:183
src/lib/anthropic/admin-tools.ts:759
src/components/employee/EmployeeProfile.tsx:1484
src/components/employee/EmployeeProfile.tsx:1359
src/components/employee/EmployeeProfile.tsx:2319
src/components/employee/EmployeePolicies.tsx:131
src/components/employee/EmployeeTeam.tsx:1103
src/components/employee/EmployeeMesa.tsx:1444
src/components/admin/AdminGlobalMasterList.tsx:1057
src/components/admin/AdminGlobalMasterList.tsx:781
src/components/hr/HrOffboarding.tsx:848
src/components/hr/HrApp.tsx:1091
src/components/hr/HrApp.tsx:2325
src/components/hr/HrApp.tsx:2538
src/components/hr/HrApp.tsx:2130
src/components/hr/HrMesa.tsx:920
src/components/hr/HrOffboardQueueProcessor.tsx:484
src/components/hr/OffboardingWeeklyPulse.tsx:445
src/components/LeaveRequestsPanel.tsx:502
src/components/audit/AuditLogPanel.tsx:488
src/components/audit/AuditLogPanel.tsx:484
src/components/PayrollWizard.tsx:1303
src/components/PayrollWizard.tsx:1309
src/components/manager/HslBonusCalculator.tsx:3114
src/components/manager/DeptBonusCalculator.tsx:4209
src/components/manager/NewlyHiredPanel.tsx:694
src/components/manager/ManagerOffboardQueueDialog.tsx:274
src/components/accounting/BonusCatalog.tsx:4491
src/components/accounting/BonusCatalog.tsx:2344
src/components/accounting/DepartmentsTab.tsx:1412
src/components/ceo/CeoOverviewKpis.tsx:781
src/components/ceo/CeoFinancialReports.tsx:813
src/components/ceo/CeoFinancialReports.tsx:933
src/components/payroll/AccountingMesa.tsx:1022
src/components/orphanage/GiftTracker.tsx:1212
src/components/orphanage/CreateOrphanageStyleDisputeDialog.tsx:625
src/components/payroll/OrphanageVisits.tsx:384
src/components/tickets/TicketsOverview.tsx:456
src/components/people/PeopleBankChanges.tsx:527
src/components/employee/GiftShippingCard.tsx:784
src/components/accounting/HubstaffMasterMatchesModal.tsx:273
src/components/hr/HrGlobalMasterList.tsx:298
src/lib/hr/global-master-list-export.ts:139
src/lib/gift-tracker/shipping-export.ts:311
src/components/payroll/AccountingMesa.tsx:557
src/components/admin/AdminDesignSpecs.tsx:611
src/components/payroll-clerk/UrgentPaymentsQueue.tsx:1146
src/components/hr/HrOnboarding.tsx:1483
src/components/payroll-clerk/DeptChip.tsx:21
src/components/paystub/PayStubStatement.tsx:384
src/lib/documents/coe-document.ts:392
src/lib/transfers/apply-transfer.ts:135
src/lib/payroll/paystub-export.ts:486
src/components/employee/RequestDocumentsTab.tsx:222
src/lib/transfers/transfers-export.ts:177
src/lib/people/people-roster-export.ts:157
src/lib/anthropic/admin-tools.ts:301
src/lib/anthropic/ceo-tools.ts:306
src/lib/payroll/readiness-activity.ts:65
src/lib/rates/export-csv.ts:142
src/lib/payment-catalog/overview-metrics.ts:207
src/components/accounting/BonusCatalog.tsx:4675
src/components/accounting/BonusCatalog.tsx:4611
src/components/accounting/BonusCatalog.tsx:4803
src/components/accounting/BonusCatalog.tsx:4844
src/components/accounting/BonusCatalog.tsx:3860
src/components/people/PeopleTab.tsx:918
src/components/hr/HrGlobalMasterList.tsx:714
src/components/PayrollWizard.tsx:16459
src/components/accounting/PaymentCatalogOverview.tsx:254
src/lib/notifications/kpi-scored.ts:301
app/api/hr/onboarding-submissions/[id]/send/route.ts:400`.trim().split('\n');
const out = [];
for (const c of claims) {
  const i = c.lastIndexOf(':');
  const f = c.slice(0, i), ln = parseInt(c.slice(i + 1), 10);
  if (!fs.existsSync(f)) { out.push(`=== ${c} :: FILE MISSING`); continue; }
  const lines = fs.readFileSync(f, 'utf8').split('\n');
  const a = Math.max(1, ln - 6), b = Math.min(lines.length, ln + 5);
  out.push(`=== ${c} (of ${lines.length})`);
  for (let k = a; k <= b; k++) out.push(`${k === ln ? '>>' : '  '}${k}| ${lines[k-1]}`);
}
fs.writeFileSync('.tmp-vfy-out.txt', out.join('\n'));
console.log('lines', out.length);
