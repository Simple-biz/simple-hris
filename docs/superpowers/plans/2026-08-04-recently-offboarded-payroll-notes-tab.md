# Payroll Notes "Offboarded" Tab — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a 4th tab, "Offboarded," to the Payroll Notes FAB modal, listing recently offboarded people so a clerk can set their final pay rate and bank details before their last paycheck runs.

**Architecture:** A new server module (`offboarded-payroll-candidates.ts`) composes three already-hardened, currently-disconnected pieces — `listRecentlyOffboardedPeople()` (who left), `offboardedRelevantToWeek()` (still owed a final check this pay week), and `getOffboardSnapshot()` (their bank info frozen at departure) — into one list with rate/bank status per person. A new API route serves it. A new client component (`OffboardedGlance`) renders it as a 4th modal tab, reusing the existing `SetRateDialog`/`SetBankDialog` editors verbatim (the same ones the Readiness tab already uses for missing-rate/missing-bank rows).

**Tech Stack:** Next.js App Router API routes, React (client components in `PayrollWizardNotesFab.tsx`), Supabase (service-role reads), `node:test` for pure-function unit tests.

**Design doc:** `docs/superpowers/specs/2026-08-04-recently-offboarded-payroll-notes-tab-design.md`

## Global Constraints

- No new database table or migration — every read is against existing tables/columns.
- `temporary_pause` offboard reason is excluded from this feature's list — that reason means the person is expected back, not actually leaving (design decision #4).
- No "file final payment" action in this tab — only Set rate / Set bank (design decision #5). Filing the actual payment stays on the existing Urgent one-off flow.
- Reuse existing components/functions rather than forking them: `listRecentlyOffboardedPeople`, `offboardedRelevantToWeek`, `getOffboardSnapshot`, `SetRateDialog`, `SetBankDialog`, `PersonLine`, `RowFixButton`, `resolvePeopleRate`, `isPayoutComplete`, `resolveEffectivePayoutProcessor`.
- Every write path this feature triggers (Set rate → `/api/payment-catalog/pay-structures`, Set bank → `/api/update-employee-ids`) is UNCHANGED — this feature only changes what feeds those existing dialogs.
- Gate the tab's edit actions on the same `canEdit` prop every other edit action in `PayrollWizardNotesFab.tsx` already uses. The route itself is gated the same way the existing `/api/payroll-wizard/readiness` route is (`requireFeatureAccess("accounting", "payroll_wizard", "view")` — a read, so view-only accountants can see it too).

---

## File Structure

| File | Responsibility |
|---|---|
| `src/lib/roster/recently-offboarded.ts` | *(modify)* Add `off_boarded_reason` to `RecentlyOffboardedPerson` — additive, no behavior change for existing callers. |
| `src/lib/payroll/payroll-readiness.ts` | *(modify)* Export the already-private `resolveCurrentWeek` — additive, no behavior change. |
| `src/lib/payroll/offboarded-final-pay-eligibility.ts` | *(create)* One pure predicate: is this offboard reason an actual departure (excludes `temporary_pause`)? |
| `src/lib/payroll/offboarded-final-pay-eligibility.test.ts` | *(create)* Unit test for the predicate above. |
| `src/lib/payroll/offboarded-payroll-candidates.ts` | *(create)* The data-assembly module: combines the recently-offboarded list, the week-relevance filter, rate/bank status resolution, and snapshot-based bank prefill into one exported async function. |
| `app/api/payroll-wizard/offboarded/route.ts` | *(create)* `GET` route serving the above, mirroring `/api/payroll-wizard/readiness`. |
| `src/components/accounting/PayrollWizardNotesFab.tsx` | *(modify)* Extend `SetBankDialog` with an optional `prefill` prop; add `"offboarded"` to `ModalTab`/`TAB_ORDER`, the tab bar, the description switch, and the pane-render switch; add the new `OffboardedGlance` component. |
| `scripts/verify-recently-offboarded-tab.mts` | *(create)* Read-only CLI verifier against live data, matching the existing `scripts/verify-offboarded-people.mts` convention. |

---

### Task 1: Add `off_boarded_reason` to `RecentlyOffboardedPerson`

**Files:**
- Modify: `src/lib/roster/recently-offboarded.ts:44-65` (interface), `:91-98` (`Cand`), `:160-167` (select), `:322-350` (candidate push), `:368-391` (merge), `:456-464` (final push)

**Interfaces:**
- Produces: `RecentlyOffboardedPerson.off_boarded_reason: string | null` — the raw `off_boarded_reason` value from the stamped `global_master_list` row, when known.

This function has no existing test file (it's `'server-only'`, DB-backed — the codebase's own convention for this class of function is to verify via the CLI script, not `node:test`; see `scripts/verify-offboarded-people.mts`). This task is a small, additive, mechanically-checked change — verified by typecheck now and by the new diagnostic script in Task 8, not a unit test.

- [ ] **Step 1: Add the field to the interface**

In `src/lib/roster/recently-offboarded.ts`, add to `RecentlyOffboardedPerson` (after the `hubstaff_email` doc/field, before `last_hours_week_start`, or anywhere in the interface — order doesn't matter):

```ts
  /** Raw `off_boarded_reason` from the stamped global_master_list row, when
   *  known. Null for flavor-4 (fell off the sheet unstamped) or when no
   *  contributing source carried a reason. */
  off_boarded_reason: string | null;
```

- [ ] **Step 2: Carry it through `Cand`**

In the same file, add to the `interface Cand` block:

```ts
  /** Latest known off_boarded_reason, null for flavor-4/queue/sheet rows. */
  off: string | null;
  off_boarded_reason: string | null;
```

(`off_boarded_reason` sits alongside the existing `off` field.)

- [ ] **Step 3: Select it, and populate it on the GML candidate push**

Change the `global_master_list` select (currently):

```ts
        .select(
          '"Name","Work Email","Personal Email","Alternate Work Email","Alternate Work Email 2","Department",off_boarded_at,last_seen_upload_id',
        )
```

to:

```ts
        .select(
          '"Name","Work Email","Personal Email","Alternate Work Email","Alternate Work Email 2","Department",off_boarded_at,off_boarded_reason,last_seen_upload_id',
        )
```

Then in the flavor 1/3 push (currently `if (off >= cutoff) cands.push({ name, department: str(r['Department']), work_email: w, personal_email: p, off });`), add the reason:

```ts
      if (off >= cutoff) {
        cands.push({
          name,
          department: str(r['Department']),
          work_email: w,
          personal_email: p,
          off,
          off_boarded_reason: str(r['off_boarded_reason']),
        });
      }
```

And the flavor-4 push (fell off the sheet unstamped — no reason exists):

```ts
      if (onHub) {
        cands.push({
          name,
          department: str(r['Department']),
          work_email: w,
          personal_email: p,
          off: null,
          off_boarded_reason: null,
        });
      }
```

The `queueRows` and `sheetRows` pushes also need the new field (those sources carry no reason column) — add `off_boarded_reason: null` to both of their `cands.push({...})` calls.

- [ ] **Step 4: Carry it through the merge**

In the dedup/merge loop, the `else` branch currently does:

```ts
    } else {
      g.department = g.department ?? c.department;
      g.work_email = g.work_email ?? c.work_email;
      g.personal_email = g.personal_email ?? c.personal_email;
      // Latest known departure wins (a dated record beats an undated one).
      if (c.off && (!g.off || c.off > g.off)) g.off = c.off;
    }
```

Add one line:

```ts
    } else {
      g.department = g.department ?? c.department;
      g.work_email = g.work_email ?? c.work_email;
      g.personal_email = g.personal_email ?? c.personal_email;
      g.off_boarded_reason = g.off_boarded_reason ?? c.off_boarded_reason;
      // Latest known departure wins (a dated record beats an undated one).
      if (c.off && (!g.off || c.off > g.off)) g.off = c.off;
    }
```

(The GML candidate is always seeded into `cands` before `queueRows`/`sheetRows` in the array, so its `off_boarded_reason` — the only source that ever carries one — is never overwritten by a later null.)

- [ ] **Step 5: Carry it into the final `people.push`**

The final push currently ends with `last_hours_week_start: ...`. Add the new field to the pushed object:

```ts
    people.push({
      name: g.name,
      department: g.department,
      work_email: g.work_email,
      personal_email: g.personal_email,
      off_boarded_at: g.off,
      off_boarded_reason: g.off_boarded_reason,
      hubstaff_email,
      last_hours_week_start: hubstaff_email ? hubWeekByEmail.get(hubstaff_email) ?? null : null,
    });
```

- [ ] **Step 6: Typecheck**

Run: `npm run lint`
Expected: no new errors. (This surfaces immediately if any `cands.push(...)` call site was missed — TypeScript will complain about a missing `off_boarded_reason` property.)

- [ ] **Step 7: Commit**

```bash
git add src/lib/roster/recently-offboarded.ts
git commit -m "feat(roster): carry off_boarded_reason through listRecentlyOffboardedPeople"
```

---

### Task 2: Export `resolveCurrentWeek` from `payroll-readiness.ts`

**Files:**
- Modify: `src/lib/payroll/payroll-readiness.ts:302` (add `export`)

**Interfaces:**
- Produces: `resolveCurrentWeek(preferredSourceFile?: string | null): Promise<{ weekStart: string; sourceFile: string | null; degraded: string[] }>` — now importable from other modules.

This is the exact function `getPayrollReadiness` already uses to resolve "which pay week is the wizard on" (falls back from an explicit source file → the live Hubstaff upload → today's calendar week). Task 4 needs the identical resolution so the new tab always agrees with the Readiness tab on which week is "current." No behavior change — purely adding visibility.

- [ ] **Step 1: Add the export keyword**

Change:

```ts
async function resolveCurrentWeek(
```

to:

```ts
export async function resolveCurrentWeek(
```

- [ ] **Step 2: Typecheck**

Run: `npm run lint`
Expected: no errors (adding `export` to a function with no other change is always safe).

- [ ] **Step 3: Commit**

```bash
git add src/lib/payroll/payroll-readiness.ts
git commit -m "refactor(payroll-readiness): export resolveCurrentWeek for reuse"
```

---

### Task 3: `offboarded-final-pay-eligibility.ts` — the reason filter

**Files:**
- Create: `src/lib/payroll/offboarded-final-pay-eligibility.ts`
- Test: `src/lib/payroll/offboarded-final-pay-eligibility.test.ts`

**Interfaces:**
- Produces: `isEligibleForFinalPayReview(reason: string | null): boolean`

Pure, no I/O — following the exact split already established by `readiness-week-scope.ts` vs `payroll-readiness.ts` ("Pure — no I/O, no server-only — so `node:test` can exercise every branch").

- [ ] **Step 1: Write the failing test**

Create `src/lib/payroll/offboarded-final-pay-eligibility.test.ts`:

```ts
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { isEligibleForFinalPayReview } from './offboarded-final-pay-eligibility';

test('temporary_pause is excluded — the person is expected back, not leaving', () => {
  assert.equal(isEligibleForFinalPayReview('temporary_pause'), false);
});

test('every real departure reason is eligible', () => {
  for (const reason of [
    'ncns',
    'resigned',
    'end_of_contract',
    'performance',
    'attendance',
    'time_manipulation',
    'other',
  ]) {
    assert.equal(isEligibleForFinalPayReview(reason), true);
  }
});

test('an unknown/undetermined reason (null) is eligible — fail toward showing, not hiding', () => {
  assert.equal(isEligibleForFinalPayReview(null), true);
});
```

- [ ] **Step 2: Run it and confirm it fails**

Run: `node --import tsx --test src/lib/payroll/offboarded-final-pay-eligibility.test.ts`
Expected: FAIL — `Cannot find module './offboarded-final-pay-eligibility'`.

- [ ] **Step 3: Implement it**

Create `src/lib/payroll/offboarded-final-pay-eligibility.ts`:

```ts
/**
 * Whether an offboard reason represents someone who's actually leaving.
 *
 * `temporary_pause` suspends the Workspace account for an approved leave —
 * the person is expected back via the normal re-onboard flow (see
 * `src/lib/hr/offboard-reasons.ts`), so there is no "final pay" to set up for
 * them. Showing them in a final-pay review list would be actively misleading:
 * a clerk could set a "final" bank/rate for someone who's still employed.
 *
 * Pure — no I/O — so node:test can exercise every branch.
 */
export function isEligibleForFinalPayReview(reason: string | null): boolean {
  return reason !== 'temporary_pause';
}
```

- [ ] **Step 4: Run it and confirm it passes**

Run: `node --import tsx --test src/lib/payroll/offboarded-final-pay-eligibility.test.ts`
Expected: PASS, 3 tests.

- [ ] **Step 5: Commit**

```bash
git add src/lib/payroll/offboarded-final-pay-eligibility.ts src/lib/payroll/offboarded-final-pay-eligibility.test.ts
git commit -m "feat(payroll): add isEligibleForFinalPayReview (excludes temporary_pause)"
```

---

### Task 4: `offboarded-payroll-candidates.ts` — the data-assembly module

**Files:**
- Create: `src/lib/payroll/offboarded-payroll-candidates.ts`

**Interfaces:**
- Consumes:
  - `listRecentlyOffboardedPeople(days?: number): Promise<{ people: RecentlyOffboardedPerson[]; hoursWeekFloor: string | null; error: string | null }>` from `@/lib/roster/recently-offboarded` (Task 1's extended type, now carrying `off_boarded_reason`)
  - `offboardedRelevantToWeek(c: OffboardedWeekEvidence, weekStart: string, hoursWeekFloor?: string | null): boolean` from `@/lib/roster/offboarded-week-relevance` (untouched, existing)
  - `resolveCurrentWeek(preferredSourceFile?: string | null): Promise<{ weekStart: string; sourceFile: string | null; degraded: string[] }>` from `@/lib/payroll/payroll-readiness` (Task 2)
  - `isEligibleForFinalPayReview(reason: string | null): boolean` from `@/lib/payroll/offboarded-final-pay-eligibility` (Task 3)
  - `loadPeopleRateContext(): Promise<PeopleRateContext>`, `resolvePeopleRate(ctx, emails: string[], department: string | null): PeopleRate` from `@/lib/people/people-roster`
  - `getEmployeeIds(): Promise<{ rows: EmployeeIdRow[]; error: string | null }>` from `@/lib/supabase/employee-ids`
  - `getEmployeeHourlyRatesRows(): Promise<{ rows: EmployeeHourlyRateRow[]; error: string | null }>`, `indexHourlyRatesByEmail(rows): Map<string, EmployeeHourlyRateRow>` from `@/lib/supabase/employee-hourly-rates`
  - `isPayoutComplete(row, extras?): boolean`, `resolveEffectivePayoutProcessor(row, extras?): ProcessorId | null`, `payoutDraftFromIdsRow(row): { preferredProcessor, payout: PayoutFields }`, `type PayoutLegacyExtras` from `@/lib/employee/payout-completeness`
  - `getOffboardSnapshot(workEmail: string): Promise<OffboardSnapshot | null>` from `@/lib/hr/offboard-snapshot`
  - `weekRangeLabel(startIso: string): string` from `@/lib/payroll/manila-week`
  - `offboardReasonLabel(v: string | null | undefined): string` from `@/lib/hr/offboard-reasons`
  - `normEmail` from `@/lib/email/norm-email`
- Produces:
  - `interface OffboardedBankPrefill { walletEmail: string; walletName: string; bankName: string; accountHolder: string; accountNumber: string; swiftCode: string }`
  - `interface OffboardedPayrollCandidate { name: string; department: string | null; workEmail: string | null; personalEmail: string | null; offBoardedAt: string | null; offBoardedReasonLabel: string | null; rateStatus: 'ok' | 'missing'; bankStatus: 'ok' | 'missing' | 'missing_has_snapshot'; bankProcessor: string | null; bankPrefill: OffboardedBankPrefill | null }`
  - `listOffboardedPayrollCandidates(sourceFile: string | null): Promise<{ people: OffboardedPayrollCandidate[]; weekLabel: string; degraded: string[]; error: string | null }>`

This function is `'server-only'`, DB-backed, and composes several already-hardened primitives — following this codebase's established convention (matching `payroll-readiness.ts`, `recently-offboarded.ts` — neither has a `node:test` file), it is verified by Task 5's route wiring, Task 8's diagnostic script, and Task 9's manual check, not a mocked unit test.

- [ ] **Step 1: Write the module**

Create `src/lib/payroll/offboarded-payroll-candidates.ts`:

```ts
import 'server-only';

/**
 * Recently offboarded people who may still need their FINAL paycheck's rate
 * or bank details set — feeds the Payroll Notes FAB's "Offboarded" tab.
 *
 * Built entirely from existing, already-hardened primitives:
 *   - `listRecentlyOffboardedPeople` — who left (unioned from every place an
 *     off-board gets recorded; the same function the KPI bonus calculators'
 *     "Offboarded" pickers already use).
 *   - `offboardedRelevantToWeek` — whether they're still owed a final check
 *     for the CURRENT pay week (the same week-scoping the KPI calculators
 *     use), so a leaver drops off this tab once their final pay is out.
 *   - `getOffboardSnapshot` — their bank/routing/processor data frozen at the
 *     moment HR offboarded them, read here for the first time anywhere.
 *
 * Rate/bank status is judged the SAME way the Readiness tab's own
 * missing-rate/missing-bank checks judge active employees, so this tab never
 * disagrees with what Payment Dispatch would actually do.
 */
import { listRecentlyOffboardedPeople } from '@/lib/roster/recently-offboarded';
import { offboardedRelevantToWeek } from '@/lib/roster/offboarded-week-relevance';
import { resolveCurrentWeek } from '@/lib/payroll/payroll-readiness';
import { isEligibleForFinalPayReview } from '@/lib/payroll/offboarded-final-pay-eligibility';
import { loadPeopleRateContext, resolvePeopleRate } from '@/lib/people/people-roster';
import { getEmployeeIds } from '@/lib/supabase/employee-ids';
import {
  getEmployeeHourlyRatesRows,
  indexHourlyRatesByEmail,
} from '@/lib/supabase/employee-hourly-rates';
import {
  isPayoutComplete,
  resolveEffectivePayoutProcessor,
  payoutDraftFromIdsRow,
  type PayoutLegacyExtras,
} from '@/lib/employee/payout-completeness';
import { getOffboardSnapshot } from '@/lib/hr/offboard-snapshot';
import { weekRangeLabel } from '@/lib/payroll/manila-week';
import { offboardReasonLabel } from '@/lib/hr/offboard-reasons';
import { normEmail } from '@/lib/email/norm-email';

export interface OffboardedBankPrefill {
  walletEmail: string;
  walletName: string;
  bankName: string;
  accountHolder: string;
  accountNumber: string;
  swiftCode: string;
}

export interface OffboardedPayrollCandidate {
  name: string;
  department: string | null;
  workEmail: string | null;
  personalEmail: string | null;
  /** `YYYY-MM-DD` they left; null when they only fell off the sheet unstamped. */
  offBoardedAt: string | null;
  /** Human-readable reason label, null when unknown (never `temporary_pause` —
   *  that reason is filtered out before this list is built). */
  offBoardedReasonLabel: string | null;
  rateStatus: 'ok' | 'missing';
  bankStatus: 'ok' | 'missing' | 'missing_has_snapshot';
  /** The processor Set Bank should lock to, when one resolves (from their
   *  current employee_ids row, or from their offboard snapshot). */
  bankProcessor: string | null;
  /** Present only when bankStatus is 'missing_has_snapshot' — seeds the Set
   *  Bank form with what was on file at the moment they were offboarded. */
  bankPrefill: OffboardedBankPrefill | null;
}

/** Picks the first snapshot `employee_ids` row that actually resolves a
 *  processor — a person can carry more than one row (dual-department), and
 *  an empty/legacy row must not shadow a usable one. */
function pickSnapshotIdRow(rows: Record<string, unknown>[]): Record<string, unknown> | null {
  return rows.find((r) => resolveEffectivePayoutProcessor(r)) ?? rows[0] ?? null;
}

export async function listOffboardedPayrollCandidates(sourceFile: string | null): Promise<{
  people: OffboardedPayrollCandidate[];
  weekLabel: string;
  degraded: string[];
  error: string | null;
}> {
  const { weekStart, degraded: weekDegraded } = await resolveCurrentWeek(sourceFile);

  const [offboardedRes, rateCtx, idsRes, ratesRes] = await Promise.all([
    listRecentlyOffboardedPeople(90),
    loadPeopleRateContext(),
    getEmployeeIds().catch(() => ({ rows: [], error: 'unreachable' })),
    getEmployeeHourlyRatesRows().catch(() => ({ rows: [], error: 'unreachable' })),
  ]);

  if (offboardedRes.error) {
    return { people: [], weekLabel: weekRangeLabel(weekStart), degraded: weekDegraded, error: offboardedRes.error };
  }

  const degraded = [...weekDegraded];
  if (idsRes.error) {
    degraded.push(
      'Payout records (employee_ids) couldn’t be read — bank status may read as missing until it recovers.',
    );
  }
  if (ratesRes.error) {
    degraded.push('The legacy rates sheet couldn’t be read — bank status was judged without its fallbacks.');
  }

  const idRowByEmail = new Map<string, Record<string, unknown>>();
  for (const r of idsRes.rows) {
    for (const e of [r.work_email, r.personal_email]) {
      const em = normEmail(e ?? '');
      if (em) idRowByEmail.set(em, r as unknown as Record<string, unknown>);
    }
  }
  const ratesByEmail = indexHourlyRatesByEmail(ratesRes.rows);

  const people: OffboardedPayrollCandidate[] = [];
  for (const person of offboardedRes.people) {
    if (!isEligibleForFinalPayReview(person.off_boarded_reason)) continue;
    if (!offboardedRelevantToWeek(person, weekStart, offboardedRes.hoursWeekFloor)) continue;

    const w = normEmail(person.work_email ?? '');
    const p = normEmail(person.personal_email ?? '');
    const aliases = [w, p].filter((e): e is string => !!e);

    const rate = resolvePeopleRate(rateCtx, aliases, person.department);
    const rateStatus: 'ok' | 'missing' = rate.source === null ? 'missing' : 'ok';

    const idRow = (w && idRowByEmail.get(w)) || (p && idRowByEmail.get(p)) || null;
    const legacyRates = (w && ratesByEmail.get(w)) || (p && ratesByEmail.get(p)) || null;
    const extras: PayoutLegacyExtras | undefined = legacyRates
      ? {
          bankPreferredRaw: legacyRates.bank_preferred,
          hurupayEmail: legacyRates.hurupay_email,
          higlobeEmail: legacyRates.higlobe_email,
          higlobeAccountName: legacyRates.higlobe_account_name,
        }
      : undefined;

    const payable = isPayoutComplete(idRow, extras);
    let bankProcessor = resolveEffectivePayoutProcessor(idRow, extras);
    let bankStatus: 'ok' | 'missing' | 'missing_has_snapshot' = payable ? 'ok' : 'missing';
    let bankPrefill: OffboardedBankPrefill | null = null;

    if (!payable && person.work_email) {
      const snapshot = await getOffboardSnapshot(person.work_email);
      const snapshotIdRow = snapshot ? pickSnapshotIdRow(snapshot.employee_ids) : null;
      const snapshotProcessor = snapshotIdRow ? resolveEffectivePayoutProcessor(snapshotIdRow) : null;
      if (snapshotIdRow && snapshotProcessor) {
        bankStatus = 'missing_has_snapshot';
        bankProcessor = bankProcessor ?? snapshotProcessor;
        const draft = payoutDraftFromIdsRow(snapshotIdRow).payout;
        bankPrefill = {
          walletEmail:
            snapshotProcessor === 'hurupay'
              ? draft.hurupayEmail
              : snapshotProcessor === 'wepay'
                ? draft.wepayEmail
                : snapshotProcessor === 'higlobe'
                  ? draft.higlobeEmail
                  : '',
          walletName: draft.higlobeAccountName,
          bankName: draft.bankName || draft.altBankName,
          accountHolder: draft.accountHolderName || draft.altAccountHolderName,
          accountNumber: draft.accountNumber || draft.altAccountNumber,
          swiftCode: draft.swiftCode || draft.altSwiftCode,
        };
      }
    }

    people.push({
      name: person.name,
      department: person.department,
      workEmail: person.work_email,
      personalEmail: person.personal_email,
      offBoardedAt: person.off_boarded_at,
      offBoardedReasonLabel: person.off_boarded_reason ? offboardReasonLabel(person.off_boarded_reason) : null,
      rateStatus,
      bankStatus,
      bankProcessor,
      bankPrefill,
    });
  }

  people.sort(
    (a, b) =>
      (b.offBoardedAt ?? '9999-99-99').localeCompare(a.offBoardedAt ?? '9999-99-99') ||
      a.name.localeCompare(b.name),
  );

  return { people, weekLabel: weekRangeLabel(weekStart), degraded, error: null };
}
```

- [ ] **Step 2: Typecheck**

Run: `npm run lint`
Expected: no errors. Pay special attention to any mismatch between `EmployeeHourlyRateRow`'s actual field names and `legacyRates.bank_preferred`/`hurupay_email`/`higlobe_email`/`higlobe_account_name` — these must match `src/lib/supabase/employee-hourly-rates.ts`'s row shape exactly (they mirror the exact same field names `buildMissingBank` in `payroll-readiness.ts` already reads off the same type).

- [ ] **Step 3: Commit**

```bash
git add src/lib/payroll/offboarded-payroll-candidates.ts
git commit -m "feat(payroll): add listOffboardedPayrollCandidates for the final-pay review list"
```

---

### Task 5: `GET /api/payroll-wizard/offboarded`

**Files:**
- Create: `app/api/payroll-wizard/offboarded/route.ts`

**Interfaces:**
- Consumes: `listOffboardedPayrollCandidates(sourceFile: string | null)` from Task 4.
- Produces: `GET /api/payroll-wizard/offboarded?source_file=<optional>` → `{ people, weekLabel, degraded, error }` JSON, or `{ error }` with HTTP 500 on an unhandled exception.

- [ ] **Step 1: Write the route**

Create `app/api/payroll-wizard/offboarded/route.ts`:

```ts
import { NextRequest, NextResponse } from "next/server";
import { listOffboardedPayrollCandidates } from "@/lib/payroll/offboarded-payroll-candidates";
import { deniedResponse } from "@/lib/auth/authorize-email";
import { requireFeatureAccess } from "@/lib/auth/authorize-feature";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

/**
 * GET — recently offboarded people who may still need their final paycheck's
 * rate/bank set, scoped to the pay week in view (they age off once their
 * final pay has gone out — see `offboardedRelevantToWeek`).
 *
 * Optional `?source_file=` scopes to the exact Hubstaff upload the Payroll
 * Wizard is currently on, mirroring `/api/payroll-wizard/readiness`. Omitted
 * → the live (`is_current`) upload.
 *
 * Same gate as Readiness: a read-only view, anyone who can see the Payroll
 * Wizard can see this list; the write paths behind Set rate / Set bank
 * enforce their own edit grants.
 */
export async function GET(req: NextRequest) {
  const authz = await requireFeatureAccess("accounting", "payroll_wizard", "view");
  if (!authz.ok) return deniedResponse(authz);

  const sourceFile = req.nextUrl.searchParams.get("source_file");

  try {
    const result = await listOffboardedPayrollCandidates(sourceFile);
    return NextResponse.json(result);
  } catch (e) {
    return NextResponse.json(
      { error: e instanceof Error ? e.message : "Could not load recently offboarded people" },
      { status: 500 },
    );
  }
}
```

- [ ] **Step 2: Typecheck**

Run: `npm run lint`
Expected: no errors.

- [ ] **Step 3: Manual smoke check**

Start the dev server (`npm run dev`) and hit the route directly (with a signed-in accounting/CEO session cookie in the browser, since `requireFeatureAccess` needs a real session): open `http://localhost:3000/api/payroll-wizard/offboarded` in a browser tab where you're already logged into the app. Expected: a JSON body shaped `{ "people": [...], "weekLabel": "...", "degraded": [...], "error": null }`, not a 401/500.

- [ ] **Step 4: Commit**

```bash
git add app/api/payroll-wizard/offboarded/route.ts
git commit -m "feat(api): add GET /api/payroll-wizard/offboarded route"
```

---

### Task 6: Extend `SetBankDialog` with an optional `prefill` prop

**Files:**
- Modify: `src/components/accounting/PayrollWizardNotesFab.tsx:2461-2479` (function signature + state initializers)

**Interfaces:**
- Produces: `SetBankDialog` now accepts an optional `prefill?: { walletEmail?: string; walletName?: string; bankName?: string; accountHolder?: string; accountNumber?: string; swiftCode?: string }` prop. Omitting it is 100% behavior-identical to today.

This is a client component with no existing test coverage for this dialog (it's exercised via the running app, like every other dialog in this file) — verified by typecheck + the manual check in Task 9.

- [ ] **Step 1: Change the function signature**

Currently:

```ts
function SetBankDialog({
  person,
  onClose,
  onSaved,
}: {
  person: ReadinessMissingBank;
  onClose: () => void;
  onSaved: () => void;
}) {
```

Change to:

```ts
function SetBankDialog({
  person,
  prefill,
  onClose,
  onSaved,
}: {
  person: ReadinessMissingBank;
  /** Seeds the form from a known-but-not-yet-saved source (e.g. an offboard
   *  snapshot) instead of starting blank. The clerk can still edit every
   *  field before saving — this only changes the initial values. */
  prefill?: {
    walletEmail?: string;
    walletName?: string;
    bankName?: string;
    accountHolder?: string;
    accountNumber?: string;
    swiftCode?: string;
  };
  onClose: () => void;
  onSaved: () => void;
}) {
```

- [ ] **Step 2: Seed the field state from `prefill`**

Currently:

```ts
  const [processor, setProcessor] = useState<string>(lockedProcessor);
  const [walletEmail, setWalletEmail] = useState("");
  const [walletName, setWalletName] = useState("");
  const [bankName, setBankName] = useState("");
  const [accountHolder, setAccountHolder] = useState("");
  const [accountNumber, setAccountNumber] = useState("");
  const [swiftCode, setSwiftCode] = useState("");
```

Change to:

```ts
  const [processor, setProcessor] = useState<string>(lockedProcessor);
  const [walletEmail, setWalletEmail] = useState(prefill?.walletEmail ?? "");
  const [walletName, setWalletName] = useState(prefill?.walletName ?? "");
  const [bankName, setBankName] = useState(prefill?.bankName ?? "");
  const [accountHolder, setAccountHolder] = useState(prefill?.accountHolder ?? "");
  const [accountNumber, setAccountNumber] = useState(prefill?.accountNumber ?? "");
  const [swiftCode, setSwiftCode] = useState(prefill?.swiftCode ?? "");
```

Nothing else in `SetBankDialog` changes — `locked`, `isWallet`, `needsWalletName`, `processorLabel`, `save()`, and the entire JSX body are untouched. The existing call site in `PayrollReadinessGlance` (around line 3751-3757) doesn't pass `prefill`, so it keeps starting blank exactly as today.

- [ ] **Step 3: Typecheck**

Run: `npm run lint`
Expected: no errors.

- [ ] **Step 4: Commit**

```bash
git add src/components/accounting/PayrollWizardNotesFab.tsx
git commit -m "feat(payroll-notes): add optional prefill prop to SetBankDialog"
```

---

### Task 7: The "Offboarded" tab

**Files:**
- Modify: `src/components/accounting/PayrollWizardNotesFab.tsx`
  - `:8-40` (lucide-react imports — add `UserMinus` is NOT needed; reuse the already-imported `PowerOff`, used elsewhere in this file for the same "person left" concept)
  - `:217-218` (`ModalTab` / `TAB_ORDER`)
  - `:1042-1096` (description switch + tab bar)
  - `:1104-1133` (pane-render switch)
  - insert new `OffboardedGlance` function after line 3809 (right after `PayrollReadinessGlance`'s closing brace, before `ReadinessLoadingCard`)

**Interfaces:**
- Consumes: `GET /api/payroll-wizard/offboarded` (Task 5); `type OffboardedPayrollCandidate` from `@/lib/payroll/offboarded-payroll-candidates` (Task 4); `PersonLine`, `RowFixButton`, `SetRateDialog`, `SetBankDialog` (existing, `SetBankDialog` extended in Task 6); `formatStartDate` (existing helper in this file, line 1897).
- Produces: a 4th visible tab in the Payroll Notes modal.

- [ ] **Step 1: Add the tab to `ModalTab` and `TAB_ORDER`**

Currently:

```ts
type ModalTab = "readiness" | "checklist" | "rates";
const TAB_ORDER: ModalTab[] = ["readiness", "checklist", "rates"];
```

Change to:

```ts
type ModalTab = "readiness" | "checklist" | "rates" | "offboarded";
const TAB_ORDER: ModalTab[] = ["readiness", "checklist", "rates", "offboarded"];
```

- [ ] **Step 2: Add the tab-bar button and description**

In the `DialogDescription` switch (currently `checklist` / `readiness` / else-rates), add an `offboarded` branch. Change:

```tsx
            <DialogDescription>
              {modalTab === "checklist" ? (
                <>
                  ...
                </>
              ) : modalTab === "readiness" ? (
                <>
                  ...
                </>
              ) : (
                <>
                  The rates set in the Payment Catalog, at a glance. Hover a department card to
                  see its individual overrides — editing stays in the Payment Catalog tab.
                </>
              )}
            </DialogDescription>
```

to (adding the `offboarded` branch before the final `rates` fallback, and making `rates` explicit so the fallback is unambiguous):

```tsx
            <DialogDescription>
              {modalTab === "checklist" ? (
                <>
                  ...
                </>
              ) : modalTab === "readiness" ? (
                <>
                  ...
                </>
              ) : modalTab === "offboarded" ? (
                <>
                  Recently offboarded people who may still need their final paycheck&apos;s pay
                  rate or bank details set. They drop off this list automatically once their final
                  pay has gone out.
                </>
              ) : (
                <>
                  The rates set in the Payment Catalog, at a glance. Hover a department card to
                  see its individual overrides — editing stays in the Payment Catalog tab.
                </>
              )}
            </DialogDescription>
```

(Leave the `checklist`/`readiness` branch bodies exactly as they are today — only the new `offboarded` branch is added.)

Then add the 4th tab button to the tab-bar array. Change:

```tsx
            {(
              [
                { id: "readiness", label: "Readiness", icon: ShieldCheck },
                { id: "checklist", label: "Adjustments and Notes", icon: ListChecks },
                { id: "rates", label: "Rates", icon: Wallet },
              ] as const
            ).map((t) => (
```

to:

```tsx
            {(
              [
                { id: "readiness", label: "Readiness", icon: ShieldCheck },
                { id: "checklist", label: "Adjustments and Notes", icon: ListChecks },
                { id: "rates", label: "Rates", icon: Wallet },
                { id: "offboarded", label: "Offboarded", icon: PowerOff },
              ] as const
            ).map((t) => (
```

- [ ] **Step 3: Add the pane-render branch**

The pane switch currently reads (rates → readiness → else-checklist):

```tsx
          {modalTab === "rates" ? (
            <motion.div key="rates" ...>
              <RatesGlance wizardSourceFile={wizardSourceFile} />
            </motion.div>
          ) : modalTab === "readiness" ? (
            <motion.div key="readiness" ...>
              <PayrollReadinessGlance
                wizardSourceFile={wizardSourceFile}
                heardWizard={heardWizard}
                canEdit={canEdit}
                viewerEmail={sessionEmail}
              />
            </motion.div>
          ) : (
            <motion.div key="checklist" ... className="grid gap-4">
              {/* the notes table */}
            </motion.div>
          )}
```

Add an `offboarded` branch before the final `checklist` fallback (same `motion.div`/`variants`/`transition` props as the other two — copy them verbatim from the `rates` branch):

```tsx
          {modalTab === "rates" ? (
            <motion.div key="rates" custom={tabDir} variants={PANE_VARIANTS} initial="enter" animate="center" exit="exit" transition={{ duration: reduceMotion ? 0 : 0.24, ease: EASE }}>
              <RatesGlance wizardSourceFile={wizardSourceFile} />
            </motion.div>
          ) : modalTab === "readiness" ? (
            <motion.div key="readiness" custom={tabDir} variants={PANE_VARIANTS} initial="enter" animate="center" exit="exit" transition={{ duration: reduceMotion ? 0 : 0.24, ease: EASE }}>
              <PayrollReadinessGlance
                wizardSourceFile={wizardSourceFile}
                heardWizard={heardWizard}
                canEdit={canEdit}
                viewerEmail={sessionEmail}
              />
            </motion.div>
          ) : modalTab === "offboarded" ? (
            <motion.div key="offboarded" custom={tabDir} variants={PANE_VARIANTS} initial="enter" animate="center" exit="exit" transition={{ duration: reduceMotion ? 0 : 0.24, ease: EASE }}>
              <OffboardedGlance wizardSourceFile={wizardSourceFile} canEdit={canEdit} />
            </motion.div>
          ) : (
            <motion.div key="checklist" custom={tabDir} variants={PANE_VARIANTS} initial="enter" animate="center" exit="exit" transition={{ duration: reduceMotion ? 0 : 0.24, ease: EASE }} className="grid gap-4">
              {/* unchanged notes-table body */}
            </motion.div>
          )}
```

(Keep the actual `checklist` branch's full existing body untouched — only the new `else if` link is inserted above it.)

- [ ] **Step 4: Add the `OffboardedGlance` component**

Insert this new function immediately after `PayrollReadinessGlance`'s closing `}` (line 3809), before `ReadinessLoadingCard`:

```tsx
/**
 * "Offboarded" tab — recently offboarded people who may still need their
 * final paycheck's rate/bank set. Built on `listOffboardedPayrollCandidates`,
 * which is itself built on the same `listRecentlyOffboardedPeople` union the
 * KPI bonus calculators use, scoped to the wizard's current pay week so a
 * leaver drops off once their final pay has actually gone out. Deliberately
 * light on machinery (no cache, no celebration, no pagination) — this list
 * is expected to be short; RatesGlance is the closer model for this pane's
 * complexity, not PayrollReadinessGlance.
 */
function OffboardedGlance({
  wizardSourceFile,
  canEdit,
}: {
  wizardSourceFile: string | null;
  canEdit: boolean;
}) {
  const [people, setPeople] = useState<OffboardedPayrollCandidate[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [ratePerson, setRatePerson] = useState<ReadinessMissingRate | null>(null);
  const [bankPerson, setBankPerson] = useState<ReadinessMissingBank | null>(null);
  const [bankPrefill, setBankPrefill] = useState<OffboardedPayrollCandidate["bankPrefill"]>(null);

  const load = useCallback(() => {
    const qs = wizardSourceFile ? `?source_file=${encodeURIComponent(wizardSourceFile)}` : "";
    return fetch(`/api/payroll-wizard/offboarded${qs}`, { cache: "no-store" })
      .then(async (res) => {
        const json = (await res.json()) as { people?: OffboardedPayrollCandidate[]; error?: string | null };
        if (!res.ok || json.error) throw new Error(json.error || `Load failed (${res.status})`);
        setPeople(json.people ?? []);
        setError(null);
      })
      .catch((e) => {
        setError(e instanceof Error ? e.message : "Could not load recently offboarded people");
      });
  }, [wizardSourceFile]);

  useEffect(() => {
    setPeople(null);
    void load();
  }, [load]);

  if (error) {
    return (
      <p className="rounded-lg border border-red-200 bg-red-50 px-3 py-2 text-xs text-red-700 dark:border-red-900/50 dark:bg-red-950/30 dark:text-red-300">
        {error}
      </p>
    );
  }
  if (people === null) {
    return (
      <div className="flex h-[70vh] items-center justify-center text-sm text-zinc-400">
        <Loader2 className="mr-2 h-4 w-4 animate-spin" />
        Loading recently offboarded people…
      </div>
    );
  }
  if (people.length === 0) {
    return (
      <div className="flex h-[70vh] items-center justify-center text-sm text-zinc-400">
        No one&apos;s recently left — nothing needs final-pay setup.
      </div>
    );
  }

  const badgeCls = (ok: boolean) =>
    ok
      ? "border-emerald-200 bg-emerald-50 text-emerald-700 dark:border-emerald-500/30 dark:bg-emerald-500/10 dark:text-emerald-300"
      : "border-amber-200 bg-amber-50 text-amber-700 dark:border-amber-500/30 dark:bg-amber-500/10 dark:text-amber-300";

  return (
    <div className="h-[70vh] overflow-y-auto rounded-lg border border-orange-100 p-1 dark:border-blue-950/60">
      <div className="space-y-0.5">
        {people.map((r) => (
          <PersonLine
            key={r.workEmail ?? r.personalEmail ?? r.name}
            name={r.name}
            email={r.workEmail ?? r.personalEmail}
            department={r.department}
            right={
              <div className="flex shrink-0 items-center gap-1.5">
                {r.offBoardedAt && (
                  <span
                    className="shrink-0 rounded-full border border-zinc-200 bg-zinc-50 px-1.5 py-0.5 text-[9px] font-semibold uppercase tracking-wide text-zinc-500 dark:border-zinc-700 dark:bg-zinc-800/60 dark:text-zinc-400"
                    title={r.offBoardedReasonLabel ?? undefined}
                  >
                    Left {formatStartDate(r.offBoardedAt)}
                    {r.offBoardedReasonLabel ? ` · ${r.offBoardedReasonLabel}` : ""}
                  </span>
                )}
                <span className={`shrink-0 rounded-full border px-1.5 py-0.5 text-[9px] font-semibold uppercase tracking-wide ${badgeCls(r.rateStatus === "ok")}`}>
                  {r.rateStatus === "ok" ? "Rate OK" : "No rate"}
                </span>
                <span className={`shrink-0 rounded-full border px-1.5 py-0.5 text-[9px] font-semibold uppercase tracking-wide ${badgeCls(r.bankStatus === "ok")}`}>
                  {r.bankStatus === "ok"
                    ? "Bank OK"
                    : r.bankStatus === "missing_has_snapshot"
                      ? "Prior bank on file"
                      : "No bank"}
                </span>
                {canEdit && (
                  <>
                    <RowFixButton
                      label="Set rate"
                      disabled={!r.workEmail && !r.personalEmail}
                      onClick={() =>
                        setRatePerson({
                          name: r.name,
                          email: r.workEmail ?? r.personalEmail,
                          department: r.department,
                          startDate: null,
                          recentlyOnboarded: false,
                          offBoardedAt: r.offBoardedAt,
                        })
                      }
                    />
                    <RowFixButton
                      label="Set bank"
                      disabled={!r.workEmail && !r.personalEmail}
                      onClick={() => {
                        setBankPrefill(r.bankPrefill);
                        setBankPerson({
                          name: r.name,
                          email: r.workEmail ?? r.personalEmail,
                          department: r.department,
                          processor: r.bankProcessor,
                          workEmail: r.workEmail,
                          personalEmail: r.personalEmail,
                          onPayroll: false,
                          offBoardedAt: r.offBoardedAt,
                        });
                      }}
                    />
                  </>
                )}
              </div>
            }
          />
        ))}
      </div>
      {ratePerson && (
        <SetRateDialog person={ratePerson} onClose={() => setRatePerson(null)} onSaved={() => void load()} />
      )}
      {bankPerson && (
        <SetBankDialog
          person={bankPerson}
          prefill={bankPrefill ?? undefined}
          onClose={() => {
            setBankPerson(null);
            setBankPrefill(null);
          }}
          onSaved={() => void load()}
        />
      )}
    </div>
  );
}
```

- [ ] **Step 5: Add the type import**

Near the other `@/lib/payroll/payroll-readiness` type imports (line ~85-94), add:

```ts
import type { OffboardedPayrollCandidate } from "@/lib/payroll/offboarded-payroll-candidates";
```

- [ ] **Step 6: Typecheck**

Run: `npm run lint`
Expected: no errors. If `PowerOff` shows as unused anywhere (it isn't — it's already used at line 1546 and now also in the tab bar), that would be the only likely lint complaint; there should be none.

- [ ] **Step 7: Manual check in the running app**

Start the dev server (`npm run dev`), sign in as an accounting/CEO user, open the Payroll Wizard tab, click the Payroll Notes FAB. Confirm:
- A 4th "Offboarded" tab appears after "Rates" and is clickable.
- It shows either a list of people, an empty state, or an error — never a blank/crashed pane.
- If any recently offboarded test person exists in your environment, confirm their row shows correct status pills, and that "Set rate"/"Set bank" open the same dialogs the Readiness tab uses and save successfully.
- Switching away from and back to the "Offboarded" tab re-fetches without error.

- [ ] **Step 8: Commit**

```bash
git add src/components/accounting/PayrollWizardNotesFab.tsx
git commit -m "feat(payroll-notes): add Offboarded tab for final-pay rate/bank setup"
```

---

### Task 8: Read-only diagnostic script

**Files:**
- Create: `scripts/verify-recently-offboarded-tab.mts`

**Interfaces:**
- Consumes: `listOffboardedPayrollCandidates` (Task 4).

Matches the existing convention (`scripts/verify-offboarded-people.mts`): a read-only CLI tool run against live data, no test framework involved.

- [ ] **Step 1: Write the script**

Create `scripts/verify-recently-offboarded-tab.mts`:

```ts
/**
 * READ-ONLY verifier: runs the REAL `listOffboardedPayrollCandidates()` — the
 * function behind the Payroll Notes FAB's "Offboarded" tab
 * (GET /api/payroll-wizard/offboarded) — from the command line.
 *
 * Usage:
 *   node --import tsx scripts/verify-recently-offboarded-tab.mts [--source-file=<name>]
 *
 * Prints every person the tab would show, their rate/bank status, and flags
 * (as an error exit) any `temporary_pause` leakage — that reason must never
 * reach this list (see offboarded-final-pay-eligibility.ts).
 */
import dotenv from "dotenv";

dotenv.config({ path: ".env.local" });
dotenv.config();

const { listOffboardedPayrollCandidates } = await import(
  "../src/lib/payroll/offboarded-payroll-candidates"
);
const { listRecentlyOffboardedPeople } = await import("../src/lib/roster/recently-offboarded");

const args = process.argv.slice(2);
const sourceFile = args.find((a) => a.startsWith("--source-file="))?.slice("--source-file=".length) ?? null;

const { people, weekLabel, degraded, error } = await listOffboardedPayrollCandidates(sourceFile);
if (error) {
  console.error(`ERROR: ${error}`);
  process.exit(1);
}

console.log(`pay week in view: ${weekLabel}`);
if (degraded.length > 0) {
  console.log("degraded reads:");
  for (const d of degraded) console.log(`  - ${d}`);
}

console.log(`\noffboarded tab would show: ${people.length} people`);
for (const p of people) {
  console.log(
    `  ${p.offBoardedAt ?? "(no date)"} · ${p.name} [${p.department ?? "—"}] ` +
      `reason=${p.offBoardedReasonLabel ?? "—"} rate=${p.rateStatus} bank=${p.bankStatus}` +
      (p.bankProcessor ? ` (${p.bankProcessor})` : ""),
  );
}

// Sanity check: temporary_pause must never leak through, even indirectly via
// a source that doesn't carry the reason cleanly.
const { people: allOffboarded } = await listRecentlyOffboardedPeople(90);
const pausedEmails = new Set(
  allOffboarded
    .filter((p) => p.off_boarded_reason === "temporary_pause")
    .flatMap((p) => [p.work_email, p.personal_email])
    .filter((e): e is string => !!e)
    .map((e) => e.toLowerCase()),
);
const leaked = people.filter(
  (p) =>
    (p.workEmail && pausedEmails.has(p.workEmail.toLowerCase())) ||
    (p.personalEmail && pausedEmails.has(p.personalEmail.toLowerCase())),
);
if (leaked.length > 0) {
  console.error(`\nFAIL: ${leaked.length} temporary_pause person(s) leaked into the tab:`);
  for (const p of leaked) console.error(`  ${p.name}`);
  process.exit(1);
}
console.log("\nOK: no temporary_pause leakage.");
```

- [ ] **Step 2: Run it against live data**

Run: `node --import tsx scripts/verify-recently-offboarded-tab.mts`
Expected: prints the pay week, any degraded reads, the candidate list (may be empty — that's fine), and ends with `OK: no temporary_pause leakage.` and exit code 0.

- [ ] **Step 3: Commit**

```bash
git add scripts/verify-recently-offboarded-tab.mts
git commit -m "chore(scripts): add read-only verifier for the Offboarded tab"
```

---

### Task 9: Final verification

**Files:** none (verification only)

- [ ] **Step 1: Run the full unit test suite**

Run: `npm test`
Expected: all tests pass, including the two new ones from Task 3.

- [ ] **Step 2: Full typecheck**

Run: `npm run lint`
Expected: no errors.

- [ ] **Step 3: Production build**

Run: `npm run build`
Expected: builds successfully (catches anything `tsc --noEmit` alone might miss, e.g. a server-only import accidentally reaching a client bundle — verify `offboarded-payroll-candidates.ts`'s `'server-only'` guard is respected: it must only be imported from `app/api/payroll-wizard/offboarded/route.ts`, never from `PayrollWizardNotesFab.tsx`, which imports only the `type OffboardedPayrollCandidate`).

- [ ] **Step 4: Re-run the diagnostic script**

Run: `node --import tsx scripts/verify-recently-offboarded-tab.mts`
Expected: same clean result as Task 8.

- [ ] **Step 5: Manual end-to-end pass in the running app**

With the dev server running and signed in as an accounting/CEO user: open the Offboarded tab, confirm the empty/populated/error states all render correctly, open Set rate and Set bank on a real (or test) recently offboarded person and confirm both save, confirm a person with a bank snapshot shows prefilled fields, confirm a `temporary_pause` person (if one exists in your data) never appears on the list, and confirm a view-only (non-`canEdit`) session sees the list but not the Set rate/Set bank buttons.
