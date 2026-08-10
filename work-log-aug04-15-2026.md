# Work log — Kane Reroma, 2026-08-04 to 2026-08-15

**Scope:** Simple projects only — `simple-hris` and `gridlineanalyticsv2.2` (Gridline Analytics).
**Source:** `git log`, read-only, bucketed by commit author date. Generated 2026-08-10.

### Read this before the numbers

- **Aug 11–15 had not happened yet** when this was generated (Aug 10). Those days are empty by definition, not by inactivity.
- **Aug 10 is the generation date itself** and falls outside the Aug 2–8 sprint week. Included because the requested range covers it.
- **Aug 3 is excluded by this window but was the single heaviest day** — 40 simple-hris + 2 Gridline commits. If the intent is to
  capture the Aug 2–8 sprint week, Aug 3 needs to be in scope; the Aug 4 start date drops it.
- **Gridline contributes zero commits to Aug 4–15.** All 4 Gridline commits in the window are Garry Morris's. Kane's Gridline
  work sits on Aug 3 (`d7dc6f7`, `3adeef0` — Netradyne device-based monthly billing + Duplicate GO VIN exception).
- Commits marked _(checkpoint)_ are work-in-progress saves with no descriptive message (`s`, `a`, `Push`, `Massiv Update`).
  They are real commits but do not each represent a separate deliverable.

## Commit counts by day

| Date | simple-hris | Gridline (Kane) | total |
|---|---|---|---|
| 2026-08-04 Tue | 29 | 0 | 29 |
| 2026-08-05 Wed | 11 | 0 | 11 |
| 2026-08-06 Thu | 9 | 0 | 9 |
| 2026-08-07 Fri | 26 | 0 | 26 |
| 2026-08-08 Sat | 0 | 0 | 0 _(weekend)_ |
| 2026-08-09 Sun | 0 | 0 | 0 _(weekend)_ |
| 2026-08-10 Mon | 21 | 0 | 21 |
| 2026-08-11 Tue | 0 | 0 | 0 _(future)_ |
| 2026-08-12 Wed | 0 | 0 | 0 _(future)_ |
| 2026-08-13 Thu | 0 | 0 | 0 _(future)_ |
| 2026-08-14 Fri | 0 | 0 | 0 _(future)_ |
| 2026-08-15 Sat | 0 | 0 | 0 _(future)_ |
| **Total** | **96** | **0** | **96** |

## Deliverables in the window

Grouping the commits into the work they belong to: **22 substantive deliverables across 96 commits**
(27 numbered entries below, of which 5 are checkpoint groups rather than deliverables).

**Tue Aug 4** — 29 commits
1. Per-cycle FX zero placeholders; hard-block dispatch while cycle FX rates are 0 — `6132cad` `fffbbc1` `0b36d46` `27a84aa` `5c501ff` `0dbc294`
2. Payroll Notes "Offboarded" tab — final-pay rate/bank setup for leavers, incl. API route, eligibility rules, degraded-read warning, read-only verifier — `9fde8c3` `1f6c9ae` `988c6d1` `90433cc` `a74dd13` `3d09827` `eeb471b` `ac8add3` `e9cd068` `32d498f` `df41c70` `02e1695` `243e3ee` `f6f5545` `2e311a2`
3. Per-week "Temporary Exemption" on Bank Info readiness rows — `f45c1c2`
4. Rate-history `effective_from` snapped to pay-week start — `28a87fe` `c39fad3` `008ec2b` `b3ab13a` `cda34a8`
5. Pay-structures "Set rate" no longer dies on duplicate key — `d9f34ef`
6. _(checkpoint)_ `c756437`

**Wed Aug 5** — 11 commits
7. My Team list + cards; Suspend rides deactivate flow, new Reactivation button — `c0ba7f9` `68aa6a0` `b929b3e` `b63cd2e`
8. Monday Sprint 26 reconciliation — 1 epic + 46 tasks for Jul 29–Aug 5 — `5a6c52f`
9. Badge/label component fixes — `a7486dc` `33a3a27` `7252d23` `d158c08`
10. _(checkpoint)_ `0fed428` `faf674b`

**Thu Aug 6** — 9 commits
11. Payment Catalog "Create a Department" — per-sub-department base rates — `882542e`
12. CEO Live Dispatch payment-confirmed chime, incl. hydration gating so it doesn't fire on load — `e9f49fc` `d034799` `d4a3cf6` `023b6ab` `69223c9` `997c672` `053fed9`
13. _(checkpoint)_ `02dc5aa`

**Fri Aug 7** — 26 commits
14. Offboarded final pay on the right basis; hard-gate on hours in cycle timesheet; reject garbage `off_boarded_at` — `2020a74` `5379204` `ad60b94`
15. Wizard Validation calculation breakdown — spec, plan, module, table component, red/amber flags, MESA sign correction, ot_ratio rounding tolerance — `4490333` `83ef2e9` `b3adf4c` `851a0ab` `5eb2e1a` `fac504e` `4ab5714` `1452b53` `d39ff41` `ba33b4b` `993dfb4`
16. HSL weekend overtime retired — all OT pays plain OT; paystub Weekend Hours merged; rate-change disclosure — `0a731ed` `5eb398a` `362b41c` `c97d0b5`
17. Offboarding: Google Sheet retired as a source; every offboard rides the n8n delete pathway — `3502e93` `28cb65d`
18. Roster repair — six dept assignments broken by transfer/sheet clobbers — `ccc74c2`
19. Dispatch USD bucket retired; USD payees held out of pending — `265eb64` `684b305`
20. _(checkpoint)_ `0b66a8e` `237696c` `ceef518`

**Mon Aug 10** — 21 commits _(outside the Aug 2–8 sprint week)_
21. HSL sub-department identity helpers + labels; within-family transfers no longer reset weekend-premium dates — `e70757d` `06bad5e` `7b46843` `b96897a` `289ab7e`
22. People tab dispatch-parity for banks (from + to) — `b13530d`
23. Payroll Wizard tab-switch animation; Wizard Setup follows the week selector — `a29c93c` `7124ed6`
24. Hardening skill + governing docs — spec, plan, feature index, root CLAUDE.md, architecture re-verify, review fixes — `3a06a79` `543f8f9` `80c30b0` `20f6dcd` `0fd5393` `5120398` `c07e85d` `0b499d5` `f9122db` `00eefbd`
25. Offboard toast spec with final-pay bank details — `238a6ee`
26. KPI calc — allow external members on the Callback department — `7d14e04`
27. _(checkpoint)_ `a7ecd4c`

## Full commit list — simple-hris

### Aug 04 (Tuesday)

- 18:30  `c756437`  Update tsconfig.tsbuildinfo
- 15:36  `d9f34ef`  fix(pay-structures): make "Set rate" update an existing rate instead of dying on a duplicate key
- 14:17  `cda34a8`  s
- 13:53  `b3ab13a`  s
- 13:37  `008ec2b`  a
- 13:36  `c39fad3`  fix(payroll): snap rate-history effective_from to the pay-week start
- 12:57  `28a87fe`  s
- 11:20  `f45c1c2`  feat(readiness): per-week "Temporary Exemption" on Bank Info rows
- 10:49  `2e311a2`  fix(offboarded-tab): unlock snapshot processor, mirror readiness exclusions, bulk snapshot read
- 10:49  `f6f5545`  fix(manager): strip off_boarded_reason from transfer-candidates response
- 10:27  `243e3ee`  s
- 10:14  `02e1695`  chore(scripts): add read-only verifier for the Offboarded tab
- 10:02  `df41c70`  fix(payroll-notes): surface degraded-read warning on Offboarded tab
- 09:52  `32d498f`  feat(payroll-notes): add Offboarded tab for final-pay rate/bank setup
- 09:41  `e9cd068`  feat(payroll-notes): add optional prefill prop to SetBankDialog
- 09:38  `ac8add3`  feat(api): add GET /api/payroll-wizard/offboarded route
- 09:31  `eeb471b`  feat(payroll): add listOffboardedPayrollCandidates for the final-pay review list
- 09:26  `3d09827`  feat(payroll): add isEligibleForFinalPayReview (excludes temporary_pause)
- 09:24  `a74dd13`  refactor(payroll-readiness): export resolveCurrentWeek for reuse
- 09:21  `90433cc`  feat(roster): carry off_boarded_reason through listRecentlyOffboardedPeople
- 09:16  `988c6d1`  chore: ignore .worktrees/ for local isolated feature work
- 09:08  `1f6c9ae`  docs(plans): implementation plan for Payroll Notes Offboarded tab
- 08:49  `9fde8c3`  docs(specs): design doc for Payroll Notes Offboarded tab
- 08:27  `0dbc294`  fix(wizard): publishFinalPaySnapshot no-ops while cycle FX rates are 0
- 04:19  `5c501ff`  docs(readiness): fx row reads per-cycle zero-placeholder record
- 03:16  `27a84aa`  refactor(readiness): drop superseded fx_confirmed week-marker helpers
- 03:04  `0b36d46`  feat(wizard): hard-block dispatch while cycle FX rates are 0; guard USD display; snapshot fx fallback
- 02:51  `fffbbc1`  fix(wizard): cycle-fx hydration guards last-writer-wins on a local timestamp
- 02:45  `6132cad`  fix(wizard): cycle-fx save merges from a persisted-record ref, not live state

### Aug 05 (Wednesday)

- 18:02  `faf674b`  zs
- 16:55  `5a6c52f`  chore(monday): reconcile Sprint 26 — 1 epic + 46 tasks for Jul 29–Aug 5
- 16:53  `0fed428`  cc
- 15:49  `b929b3e`  My Team cards: same action buttons as the list view
- 15:33  `68aa6a0`  Temp-pause pair: Suspend rides deactivate flow, new Reactivation button
- 15:19  `c0ba7f9`  My Team list: MESA-style table + row actions (View / Suspend / Offboard)
- 14:49  `d158c08`  Update label.tsx
- 13:57  `7252d23`  Update label.tsx
- 13:02  `33a3a27`  Update badge.tsx
- 13:00  `a7486dc`  Update badge.tsx
- 12:48  `b63cd2e`  Push

### Aug 06 (Thursday)

- 17:46  `02dc5aa`  Massiv Update
- 15:31  `053fed9`  fix(ceo): require a genuine snapshot before recentHydrated latches true
- 15:14  `997c672`  fix(ceo): gate Live Dispatch chime seed on a real recent-feed hydration flag
- 14:59  `69223c9`  fix(ceo): gate Live Dispatch chime seed on payments.loading
- 14:45  `023b6ab`  feat(ceo): play payment-confirmed chime per person in Live Dispatch feed
- 14:34  `d4a3cf6`  feat(ceo): add selectNewlyPaidEntries helper for Live Dispatch sound
- 14:29  `d034799`  docs(plans): add implementation plan for CEO Live Dispatch payment sound
- 14:21  `e9f49fc`  docs(specs): add design for CEO Live Dispatch payment-confirmed sound
- 13:12  `882542e`  feat(catalog): Create a Department — per-sub-department base rates

### Aug 07 (Friday)

- 16:50  `ceef518`  PUSH
- 16:19  `684b305`  fix(dispatch): hold USD payees out of pending, not just out of their own tab
- 16:14  `265eb64`  fix(dispatch): retire the USD bucket, fold those payees into the normal queue
- 14:43  `237696c`  pw
- 12:36  `4ab5714`  feat(wizard): show the full calculation on Validation, and stop dropping MESA disbursements
- 12:27  `c97d0b5`  fix(paystub): disclose a weekend paid on the old side of a rate change
- 12:10  `fac504e`  fix(payroll): sign-correct MESA money, itemise other bonuses, collision-proof row keys
- 12:04  `5eb2e1a`  feat(payroll): validation breakdown table component
- 11:58  `993dfb4`  fix(payroll): tolerate rounding-convention centavo gap in ot_ratio
- 11:53  `0b66a8e`  HSL - ANNOYANCE
- 11:49  `ba33b4b`  feat(payroll): amber flags for rate-source disagreement
- 11:44  `d39ff41`  feat(payroll): red flags for rows that cannot be paid as calculated
- 11:41  `362b41c`  docs(paystub): weekend OT rate removed 2026-08-07 - update the weekend section
- 11:39  `5eb398a`  feat(payroll): remove the HSL weekend overtime rate — all OT pays plain OT
- 11:39  `1452b53`  test(payroll): lock HSL sheet-form derivation in the breakdown module
- 11:39  `ccc74c2`  fix(roster): repair six dept assignments broken by transfer/sheet clobbers
- 11:36  `0a731ed`  feat(paystub): merge Weekend Overtime into a single Weekend Hours line
- 11:35  `851a0ab`  feat(payroll): validation breakdown module — base derivation
- 11:33  `28cb65d`  feat(offboarding): retire the Google Sheet as an offboarding source
- 11:25  `3502e93`  fix(offboard): every offboard rides the n8n delete pathway; deactivate = suspend-only
- 11:24  `b3adf4c`  refactor(payroll): extract formatPHP for reuse outside the wizard
- 11:10  `83ef2e9`  docs(wizard): implementation plan for the Validation breakdown
- 11:02  `4490333`  docs(wizard): spec the Validation step calculation breakdown
- 10:55  `ad60b94`  fix(roster): never let a garbage off_boarded_at date vouch for a leaver
- 10:46  `5379204`  fix(payroll): hard-gate final-pay surfaces on hours in the cycle's timesheet
- 10:13  `2020a74`  fix(payroll): pay offboarded people their final check on the right basis

### Aug 10 (Monday)

- 11:08  `a7ecd4c`  Callback
- 11:03  `00eefbd`  fix(hardening): close the gaps the final review found
- 10:58  `7d14e04`  feat(kpi-calc): allow external members on the Callback department
- 10:41  `f9122db`  docs(hardening): record the validation result and drop two bad criteria
- 10:32  `0b499d5`  docs(architecture): re-verify system-architecture.md against the code, record retired behavior
- 10:30  `c07e85d`  docs: add root CLAUDE.md — hardening trigger plus the unwritten repo rules
- 10:27  `5120398`  feat(skill): add hardening — read the docs first, then tighten
- 10:21  `0fd5393`  fix(index): split the HSL weekend-hours rule from the OT-rate rule
- 10:21  `20f6dcd`  docs(hardening): split the HSL rules in the plan and spec, per Kane's ruling
- 10:13  `80c30b0`  docs(index): map every feature surface to its docs, memory, and invariant
- 09:32  `543f8f9`  docs(hardening): implementation plan — index, skill, CLAUDE.md, validation
- 09:32  `238a6ee`  docs(accounting): spec the offboard toast with final-pay bank details
- 09:22  `3a06a79`  docs(hardening): spec the hardening skill — docs first, then tighten
- 09:19  `7124ed6`  fix(readiness): make Wizard Setup follow the week selector above it
- 08:38  `a29c93c`  fix(wizard): make the Payroll Wizard tab switch animate like every other tab
- 07:53  `b13530d`  fix(people): make the People tab dispatch-parity for banks (from + to)
- 07:38  `289ab7e`  docs(hsl): record the 2026-08-10 safe slice + the hold on Task 2 Step 4
- 07:35  `b96897a`  feat(hsl): render sub-team labels as "HSL - Intake Specialist", not the raw key
- 07:31  `7b46843`  fix(hsl): sub-team labels count as HSL on every week-model surface
- 07:27  `06bad5e`  fix(hsl): within-family transfers no longer reset weekend-premium effective dates
- 07:25  `e70757d`  feat(hsl): sub-department identity helpers (canonical hsl:<key> label)

## Full commit list — Gridline Analytics

_No commits authored by Kane between Aug 4 and Aug 15._

For completeness, the 4 Gridline commits that do fall in the window, all by Garry Morris:

- 2026-08-04 10:20  `b6a6ddc`  Bump portal version 2026.7.5 -> 2026.8.1 — Garry Morris
- 2026-08-04 10:09  `5c4ca6a`  Clean up tempdata folder (Used for billing run data analysis) — Garry Morris
- 2026-08-04 10:05  `cbc43fa`  Split month-end verification detail into a linked runbook — Garry Morris
- 2026-08-04 09:53  `5220a64`  [#13385] RC4 groundwork: stop gating hardcoded flat fees on device presence — Garry Morris
