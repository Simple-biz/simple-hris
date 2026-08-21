# Hubstaff zero-hours gap — the "did anyone actually offboard this person?" reminder

An active roster member with **no Hubstaff hours** for a week, and nothing in the HRIS
explaining it, is surfaced to Accounting in two places: a **No Hours** tab in the Payroll
Notes → Readiness pane, and a **`payroll.hours_gap` notification** fired once per week the
moment a Hubstaff file is ingested. It answers one question — *is this person still
working, on leave, sick, or did nobody offboard them?* — and it answers it without
touching a single payroll number.

Shipped 2026-08-21. The trigger was `jvincec@simple.biz`: Active on the master list,
`off_boarded_at` null, no `offboarded_sheet` row, hours tapering 39h → 33h → 9h → **zero**
from 2026-08-05, still drawing a roster seat two weeks later. Nobody had offboarded him and
nobody noticed.

## The signal already existed. That is the point of this feature.

**Do not rebuild the detector.** `Overview.tsx`'s "Hubstaff ↔ Master matches" tile has
classified no-hours people into *expected absence* vs *unexplained gap* — approved leave
included — since long before this. It had `jvincec` correctly in the gap bucket the whole
time. What it lacked was **delivery**: it is a passive tile on one dashboard that nobody
opens, and its gap bucket held **228 rows**, of which ~201 were structural false positives.

So this feature is three things, in this order, and the order matters:

1. **The exempt list was made drift-proof** — without that, any alert is 228 rows of noise
   in week one and ignored by week three.
2. **The rule was extracted** so the tile, the pane and the notification cannot disagree.
3. **Only then was it pushed** to the people who act on it.

## Key files

| Piece | File |
| --- | --- |
| The classification rule (pure, unit-tested) | `src/lib/payroll/zero-hours-gap.ts` (+ `.test.ts`) |
| Exempt-department model | `src/lib/payroll/hubstaff-reconciliation.ts` (+ `.test.ts`) |
| Readiness dimension (`buildZeroHours`) | `src/lib/payroll/payroll-readiness.ts` |
| Approved-leave reader (paged, scoped) | `src/lib/supabase/leave-requests.ts` (`listApprovedLeavesFrom`) |
| The notification | `src/lib/notifications/zero-hours-gap.ts` |
| Type → dashboard map | `src/lib/notifications/notification-views.ts` |
| Ingest hooks | `app/api/hubstaff-hours/route.ts` · `src/lib/hubstaff/run-weekly-sync.ts` |
| The pane tab | `src/components/accounting/PayrollWizardNotesFab.tsx` (`readinessTab === "hours"`) |
| The Overview tile (now a consumer) | `src/components/Overview.tsx` (`masterRecon`) |
| Score tripwire | `src/lib/payroll/readiness-score.test.ts` |

## One rule, three consumers

`classifyZeroHours` is the only implementation, and its priority order is load-bearing:

**untracked department → approved leave → onboarding timing → unexplained gap.**

A person the tile calls an expected absence while the notification calls a gap is worse
than either answer alone, so the tile was re-pointed at this module rather than left as a
second copy. An exempt-department person who *also* filed leave reports as the department
exemption, because that is the durable reason. A leave that ended before the week began
excuses nothing.

The rule was ported **behavior-identical**, including one inherited quirk documented at the
function: the onboarding branch parses the master `Start Date` with `new Date(...)`, so
`"03/09/26"` is local midnight while the ISO period bound is UTC midnight. A test pins the
current boundary behavior. Changing it is a deliberate re-classification, not a refactor.

## The exempt list must survive a department rename

`HUBSTAFF_EXEMPT_DEPTS` holds base labels (`site building`, `smm freelancer`, `sales`,
`sales assistant`, `usee`). `isHubstaffExemptDept` matches exactly, then retries once with a
**trailing parenthetical qualifier stripped**.

That second pass is not a convenience. Measured on the 2026-08-09 week: `Site Building` had
been split into `Site Building (US - Freelance)` (20 people, **0** with hours) and
`Site Building (PH - Freelancer)` (13, **0** with hours). The exact-match list silently
inverted its own meaning and reported 33 people as unexplained gaps, while the untouched
`SMM Freelancer` label (29, 0 tracked) exempted correctly. The mechanism was fine; only the
labels had drifted.

It widens nothing on its own — the base label still has to be one of the five — and a test
pins the negative control: a dept whose base is not in the set stays tracked however it is
qualified (`AI/API Team (Core)`, `Lead Gen (PH)`).

## Lead Gen is TRACKED, and that is why this is never scored

Kane, 2026-08-21 (Q1): *"Track them as well, this is just to remind accounting if they are
still active or on leave or Sick."* Lead Gen has 135 of 343 active people logging hours, so
it is neither a clean exemption nor a clean signal — and excluding it would hide anyone who
actually walked. It stays in.

The consequence is that the list runs **~190 people a week**, which is why the dimension is
**listed but never scored**:

- Scoring it would peg the readiness score near zero every single week and permanently kill
  the 100% celebration — a reminder turned into a broken gauge.
- `ReadinessScoreComponent['key']` is the closed union `'rate' | 'kpi' | 'bank'`, whose
  `SCORE_WEIGHTS` sum to 1.0 and whose points are asserted to equal the headline. A fourth
  component needs a deliberate weight rebalance.

`readiness-score.test.ts` carries the tripwire: *"the score has exactly three dimensions"*.
Do not "fix" that test by adding a fourth — fix the weights on purpose or leave it alone.

For the same reason the tab badge is **sky/neutral**, never amber: someone with no hours is
correctly paid nothing, so there is nothing to clear before running payroll. The risk being
closed is the opposite one — a leaver holding a roster seat forever.

## Approved leave is a legitimate zero-hours week — but almost nobody files one

Kane, 2026-08-21 (Q2): *"Vacation Leaves are legit, this would mean wouldn't have hours that
week."* So an approved leave overlapping **or upcoming relative to** the week resolves to an
exception, never a gap. Pending, rejected and cancelled requests excuse nothing — a
still-unapproved request leaves the person listed, which is exactly the prompt HR needs.

**Know the limit before trusting the list:** `leave_requests` held **4 rows total, 3
approved,** across the entire database when this shipped. The leave feature is effectively
unused, so a real vacation usually appears as an unexplained gap. That is accepted (Kane's
Q2) precisely because the list is a prompt to ask, not a verdict — but do not describe this
list to anyone as "people who are absent without leave".

`listApprovedLeavesFrom` is deliberately not `listAllLeaveRequests`: that one caps at 200
rows ordered by recency, so the moment the table grows the oldest still-open leave silently
stops excusing anyone.

## One zero week is enough

Kane, 2026-08-21 (Q3). There is deliberately **no consecutive-week rule and no history
lookup**. `jvincec` tapered into silence rather than stopping cleanly (9h16m in his final
week, last tracked day Wednesday), so a two-week rule would have delayed the flag by another
seven days for no gain in signal.

## Why a notification and not a scheduled job

There is no scheduler to hang this on, by measurement **and** by ruling:

- Every `/api/cron/*` route 401s at the edge on `proxy.ts`'s fail-closed `CRON_SECRET` gate.
  The two Vercel crons that exist have never once run — 0 audit rows, ever.
- The only real scheduler this product had, the n8n weekly Hubstaff pull, was **retired
  2026-08-20** with *"there is now no scheduler for this by design."*

A "weekly reminder" would therefore have been dead on arrival and silently so. The ingest is
the correct trigger anyway: it is the exact moment the answer changes, it is a human action
someone is already watching, and it is where `payroll.available` already fires. No upload,
nothing to reconcile, no reminder owed. **`vercel.json` is not touched — do not "fix the
missing cron".**

## The card carries a count, not the people

~190 names in a notification is a notification nobody reads — the same failure this feature
exists to correct. So the card carries the total plus the top departments
(`summarizeZeroHoursGaps` / `zeroHoursDigestLine`) and points at the pane that holds the
rows. A blank department folds to **"No department"** rather than vanishing, and ties break
on name so the digest is stable across runs.

`notifyZeroHoursGapForWeek` reads its rows from `getPayrollReadiness` rather than
recomputing them, so the count can never disagree with the pane it tells you to open. That
costs a readiness load on ingest, which is in line with what the ingest already spends.

Other rules the card obeys:

- **Recipients are active `accounting` role holders only** (Kane's Q4). It names headcount,
  not money, and HR has its own offboarding queue — a second view here would put a
  payroll-operations chore on the HR chime. See `notification-alerts.md`: every
  `useNotificationChime` mount passes a `view`.
- **Zero gaps sends nothing.** A "0 this week" card every week trains people to dismiss the
  card that matters.
- **De-dupe is per (recipient, source_file)** via `details->>source_file`, the same idiom
  `payroll-available.ts` uses. A re-upload never re-notifies; a newly-granted accountant
  still gets the current week.
- **A failed de-dupe read bails instead of notifying.** A skipped week self-heals on the
  next ingest; a duplicate storm across every accountant does not.
- **Failures are audited, not warned.** `recordNotifyFailure` writes `audit_log` rather than
  `console.warn`, because a bare warn is exactly how `kpi.scored` stayed dead for three days
  after its DDL was missed.

## What looks like a bug but isn't

| Looks wrong | Actually |
|---|---|
| ~190 rows every week | By design — Lead Gen is tracked (Q1). It is a reconciliation list, not a queue to empty. |
| The score stays 100 with 190 rows listed | Correct. This dimension is not scored — see above. |
| Someone on holiday is listed | Almost certainly filed no leave request. 4 rows exist in the whole table. |
| A person shows "Left · final pay" | They off-boarded during/after this week and are still owed a check; the row is context, not a mystery. |
| The tab badge is sky, not amber | Neutral on purpose — nothing here blocks payroll. |
| No 5th stat tile | The tile row is `sm:grid-cols-4`; a fifth would orphan or shrink all four. The tab badge carries the count. |
| The notification never arrives | Check the DDL first (Deploy notes), then `audit_log` for `notification.insert_failed`. |

## Deploy notes

**Migration — REQUIRED, and the feature is dead until it runs:**

- `references/sql/alter/2026-08-21_add_payroll_hours_gap_notification_type.sql`
- Apply with `node scripts/apply-hours-gap-notification-type.mjs` (verify-only:
  `--verify`). Idempotent; restates the FULL allowed type set and aborts if the live
  constraint carries a type the file lacks.
- **PENDING** until Kane confirms it ran. Every `payroll.hours_gap` insert is rejected by
  `employee_notifications_type_check` until then. `kpi.scored` shipped exactly that way and
  wrote 0 rows for three days against 3,694 for `payroll.available`. The notifier here
  audits its own failures, so the silence is visible — but the notification still does not
  exist until the DDL lands.
- Needs `DATABASE_URL` (session pooler `aws-1-us-east-2`, user `postgres.<ref>`, `@` in the
  password percent-encoded as `%40`). The script prints the exact form on a missing var.

No new tables. No env vars. No n8n import. `vercel.json` unchanged.
