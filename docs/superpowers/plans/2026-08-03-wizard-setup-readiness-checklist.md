# Wizard Setup Readiness Checklist Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a per-week "Wizard setup" checklist (7 wizard prerequisites) to the Payroll Notes → Readiness tab, week-scope the existing readiness roster so future hires never appear in a week they weren't hired for, and warn inside the Payroll Wizard's Step 1 when the pay week's Hubstaff CSV is missing.

**Architecture:** Pure decision modules (`node:test`-testable, no `server-only`) + server assembly inside the existing `getPayrollReadiness()` pipeline (new `wizardSetup` response block), one new read-only UI section in `PayrollWizardNotesFab.tsx`, and three wizard-side additions (fx confirm stamp, orphanage confirm-none button, step-1 warning dialog). Weekly confirm markers live in `app_settings`.

**Tech Stack:** Next.js (app router), React 18 client components, Supabase (service-role server reads), `node --import tsx --test` for unit tests, Tailwind + shadcn Dialog + lucide-react + motion/react.

**Spec:** `docs/superpowers/specs/2026-08-03-wizard-setup-readiness-checklist-design.md`. One deliberate deviation: the spec's single `wizard-setup-status.ts` is split into a **pure** module `src/lib/payroll/wizard-setup-steps.ts` (testable — the test runner cannot import `server-only` modules) plus the I/O assembler `buildWizardSetup()` colocated with the other builders in `payroll-readiness.ts` (matches the `readiness-score.ts` / `payroll-readiness.ts` precedent).

## Global Constraints

- **NEVER `git push`** — Kane handles git. Commit locally only.
- **Multi-session checkout:** other sessions have uncommitted work in this repo. `git add` ONLY the exact files each task names — never `git add -A` / `-u` / `.`.
- **Live production DB:** `.env.local` holds production service-role creds. Any script you run against it must be read-only (`scripts/verify-readiness.mts` is read-only and safe). Never run write scripts.
- **Do not run `next build`** — a dev server may be running and they share `.next/`. Verification = `npm run lint` (tsc --noEmit) + targeted `node --import tsx --test <file>`.
- Week keys derive from Hubstaff filename range **start, verbatim (a Sunday)** via `parseDateRangeFromFilename` — never Monday-anchor (see warning at `src/lib/payroll/payroll-readiness.ts:231-243`).
- The expected pay week is `payrollNotesWeekStart()` from `src/lib/payroll/manila-week.ts:42` — Sunday of the current Manila week minus 7 days.
- `bonusOverrides` in the additions blob is keyed by **RAW calc-result email casing** — normalize (`.trim().toLowerCase()`) only for comparison, never rekey.
- PostgREST caps reads at 1000 rows even with `.range()` — any new table read loops pages of 1000.
- New app_settings keys (exact): `payroll.wizard.fx_confirmed.<weekStart>`, `payroll.wizard.orphanage_confirmed.<weekStart>` where `<weekStart>` is the Sunday ISO (`YYYY-MM-DD`) of the pay week. localStorage key (exact): `payroll.wizard.csvWarnIgnored.<weekStart>`.
- Test files must import **only pure modules** (no `server-only`, no supabase clients). Run a single file: `node --import tsx --test src/lib/payroll/<name>.test.ts`. Full suite: `npm test`.
- Match the house comment style: comments state constraints, not narration.

---

### Task 1: Pure week-scope helpers + tests

**Files:**
- Create: `src/lib/payroll/readiness-week-scope.ts`
- Test: `src/lib/payroll/readiness-week-scope.test.ts`

**Interfaces:**
- Consumes: `weekEndFromStart(startIso: string): string` from `@/lib/payroll/manila-week` (`manila-week.ts:68`, start + 6 days, pure).
- Produces: `isFutureHireForWeek(startDateIso: string | null, weekStart: string, onPayroll: boolean): boolean` and `startsAfterWeek(startIso: string | null, weekStart: string): boolean` — Task 2 wires both into `payroll-readiness.ts`.

- [ ] **Step 1: Write the failing test**

Create `src/lib/payroll/readiness-week-scope.test.ts`:

```ts
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { isFutureHireForWeek, startsAfterWeek } from './readiness-week-scope';

// Pay week Sun 2026-07-26 → Sat 2026-08-01.
const WEEK = '2026-07-26';

test('start date after the week end → excluded (future hire)', () => {
  assert.equal(isFutureHireForWeek('2026-08-02', WEEK, false), true);
  assert.equal(isFutureHireForWeek('2026-09-15', WEEK, false), true);
});

test('start date inside or before the week → stays', () => {
  assert.equal(isFutureHireForWeek('2026-08-01', WEEK, false), false); // boundary: week end
  assert.equal(isFutureHireForWeek('2026-07-26', WEEK, false), false); // boundary: week start
  assert.equal(isFutureHireForWeek('2026-01-05', WEEK, false), false);
});

test('hours in the week file always win — onPayroll stays even with a future start date', () => {
  assert.equal(isFutureHireForWeek('2026-08-02', WEEK, true), false);
});

test('missing/unparseable start date fails safe — stays listed', () => {
  assert.equal(isFutureHireForWeek(null, WEEK, false), false);
});

test('startsAfterWeek: after week end → true, else false, null → false', () => {
  assert.equal(startsAfterWeek('2026-08-02', WEEK), true);
  assert.equal(startsAfterWeek('2026-08-01', WEEK), false);
  assert.equal(startsAfterWeek(null, WEEK), false);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --import tsx --test src/lib/payroll/readiness-week-scope.test.ts`
Expected: FAIL — `Cannot find module './readiness-week-scope'`.

- [ ] **Step 3: Write the implementation**

Create `src/lib/payroll/readiness-week-scope.ts`:

```ts
/**
 * Week-scoping predicates for the Payroll Readiness roster: a readiness period
 * must only contain people who were on board during that week. Someone whose
 * master Start Date is AFTER the week's end (a future hire, or any hire made
 * after a past week being viewed) must not appear in that week's lists or
 * denominators.
 *
 * Pure — no I/O, no server-only — so `node:test` can exercise every branch
 * (same split as readiness-score.ts vs payroll-readiness.ts).
 */

import { weekEndFromStart } from '@/lib/payroll/manila-week';

/**
 * True when this person had not yet started during the week in view and can be
 * dropped from the bank list and its denominators.
 *
 * - `onPayroll` (any alias has hours in the week's Hubstaff file) always wins:
 *   a stale/wrong start date must never hide someone actually being paid —
 *   same fail-safe shape as the off-board guard in buildMissingBank.
 * - A missing/unparseable start date fails safe: the person stays listed
 *   (over-flagging is this dimension's existing direction).
 */
export function isFutureHireForWeek(
  startDateIso: string | null,
  weekStart: string,
  onPayroll: boolean,
): boolean {
  if (onPayroll) return false;
  if (!startDateIso) return false;
  return startDateIso > weekEndFromStart(weekStart);
}

/** True when a known start date lands strictly after the week in view — used to
 *  hide onboarding-pipeline exception rows from a week that predates the hire.
 *  Null (dateless pipeline row) → false: can't place it in time, keep visible. */
export function startsAfterWeek(startIso: string | null, weekStart: string): boolean {
  if (!startIso) return false;
  return startIso > weekEndFromStart(weekStart);
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `node --import tsx --test src/lib/payroll/readiness-week-scope.test.ts`
Expected: PASS (5 tests).

- [ ] **Step 5: Commit**

```bash
git add src/lib/payroll/readiness-week-scope.ts src/lib/payroll/readiness-week-scope.test.ts
git commit -m "feat(readiness): pure week-scope predicates for future-hire exclusion"
```

---

### Task 2: Wire week-scoping into the bank check and exceptions

**Files:**
- Modify: `src/lib/payroll/payroll-readiness.ts` (`buildMissingBank` ~:1126-1174, `buildExceptions` ~:1250-1291, imports ~:85)

**Interfaces:**
- Consumes: `isFutureHireForWeek`, `startsAfterWeek` from Task 1.
- Produces: no signature changes — `buildMissingBank` / `buildExceptions` keep their shapes; only their populations shrink. `bankEligibleCount`, `bankOnPayrollCount`, `missingBankOnPayroll` shrink automatically because they are computed after the skip.

- [ ] **Step 1: Add the import**

In `payroll-readiness.ts`, next to the existing `manila-week` import (~:85):

```ts
import { isFutureHireForWeek, startsAfterWeek } from '@/lib/payroll/readiness-week-scope';
```

- [ ] **Step 2: Skip future hires in `buildMissingBank`**

Inside the `for (const e of employees)` loop, the current code computes `onPayroll` (:1143) then the `offAt` IIFE (:1157-1165) which contains `const started = normalizeStartDate(e.start_date);`. Lift that normalization out so both guards share it, and add the future-hire skip **after the off-board guard** (:1166) and **before** `eligibleCount += 1` (:1173):

```ts
    const onPayroll = [w, p].some((em) => !!em && payrollEmails.has(em));

    const startedIso = normalizeStartDate(e.start_date);
    // …existing offAt IIFE, with its inner
    //   `const started = normalizeStartDate(e.start_date);`
    // replaced by the lifted `startedIso` …
    if (offAt && offAt < weekStart && !onPayroll) continue;
    const offBoardedAt = offAt && offAt >= weekStart ? offAt : null;

    // Readiness only reads its own week: someone whose Start Date is after the
    // week in view hadn't been hired yet — they leave the list AND both
    // denominators (eligibleCount / onPayrollEligibleCount), for the current
    // week and for past weeks via the selector alike.
    if (isFutureHireForWeek(startedIso, weekStart, onPayroll)) continue;

    eligibleCount += 1;
```

Concretely: in the `offAt` IIFE change `const started = normalizeStartDate(e.start_date);` → `const started = startedIso;` (or use `startedIso` directly), and insert the two new statements exactly where shown.

- [ ] **Step 3: Hide future-start pipeline rows in `buildExceptions`, keep their identities**

In `buildExceptions` (:1250-1291), the `no_show` and onboarding branches push unconditionally. Compute the same start ISO the `promoted` branch uses, and for those two branches skip the **push** (not the `remember`) when the hire starts after the week in view:

```ts
  for (const r of rows) {
    const name = r.display_name || r.name || r.work_email || r.personal_email || '—';
    const email = r.work_email || r.personal_email || null;
    const department = r.department ?? null;
    // The pipeline's best-known start (same precedence as the promoted branch):
    // orientation date → staged start_date → promoted_at.
    const startIso =
      (r.orientation_attended_at ? r.orientation_attended_at.slice(0, 10) : null) ??
      r.start_date ??
      (r.promoted_at ? r.promoted_at.slice(0, 10) : null);
    // Readiness only reads its own week: a hire that starts AFTER the week in
    // view doesn't belong in that week's exception list. Their identities are
    // still remembered below — an onboarding hire must never cost points on
    // the rate/bank dimensions whichever week is in view. Dateless rows stay
    // visible (can't place them in time; exceptions are never scored).
    const hiddenForWeek = startsAfterWeek(startIso, weekStart);

    if (r.status === 'no_show') {
      if (!hiddenForWeek) {
        out.push({ name, email, department, kind: 'no_show', detail: 'Marked no-show — not paid' });
      }
      remember(r);
      continue;
    }
    if (r.status === 'pending_work_email' || r.status === 'ready' || r.status === 'failed_to_promote') {
      const awaiting = !r.orientation_attended_at;
      if (!hiddenForWeek) {
        out.push({
          name,
          email,
          department,
          kind: awaiting ? 'awaiting_orientation' : 'onboarding',
          detail: awaiting ? 'Awaiting orientation confirmation' : 'Still onboarding — not on payroll yet',
        });
      }
      remember(r);
      continue;
    }
    if (r.status === 'promoted') {
      // unchanged — already window-scoped (startIso >= weekStart && <= weekEnd)
```

The `promoted` branch keeps its own `startIso` computation (or reuses the lifted one — identical expression) and is otherwise untouched.

- [ ] **Step 4: Typecheck**

Run: `npm run lint`
Expected: clean (same set of pre-existing warnings/errors as before the change, if any — do not fix unrelated ones).

- [ ] **Step 5: Verify against live data (read-only)**

```powershell
$env:TSX_TSCONFIG_PATH="tsconfig.readiness-verify.json"; node --import tsx scripts/verify-readiness.mts
```

Expected: script completes; `Missing bank: N of M eligible` may shrink vs before the change (any person listed must not have `started=<date after the week end>` in the no-rate/bank dumps). Nothing is written — the script only reads.

- [ ] **Step 6: Commit**

```bash
git add src/lib/payroll/payroll-readiness.ts
git commit -m "fix(readiness): roster is week-scoped - future hires leave the bank list, denominators, and exception rows for weeks before their start"
```

---

### Task 3: Pure wizard-setup module (types, keys, derive) + tests

**Files:**
- Create: `src/lib/payroll/wizard-setup-steps.ts`
- Test: `src/lib/payroll/wizard-setup-steps.test.ts`

**Interfaces:**
- Consumes: nothing project-specific (pure).
- Produces (used by Tasks 4, 5, 6, 7):
  - `type WizardSetupStepKey = 'csv' | 'fx' | 'orphanage' | 'kpi' | 'notes' | 'contractors' | 'dispatch'`
  - `interface WizardSetupStep { key: WizardSetupStepKey; stepNo: string; label: string; status: 'done' | 'attention' | 'blocked' | 'pending'; detail: string }`
  - `interface WizardSetup { expectedWeekStart: string; weekLabel: string; matchedSourceFile: string | null; mismatch: boolean; steps: WizardSetupStep[]; doneCount: number; totalCount: number }`
  - `interface WizardSetupInput` (below), `deriveWizardSetupSteps(input: WizardSetupInput): WizardSetup`
  - `fxConfirmedSettingKey(weekStart: string): string`, `orphanageConfirmedSettingKey(weekStart: string): string`
  - `parseFxConfirmedMarker(value: string | null): { rate: number; by: string | null; at: string | null } | null`
  - `parseOrphanageNoneMarker(value: string | null): { by: string | null; at: string | null } | null`
  - `parseDispatchLockValue(value: string | null): { locked: boolean; lockedBy: string | null; lockedAt: string | null }`

- [ ] **Step 1: Write the failing test**

Create `src/lib/payroll/wizard-setup-steps.test.ts`:

```ts
import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  deriveWizardSetupSteps,
  fxConfirmedSettingKey,
  orphanageConfirmedSettingKey,
  parseDispatchLockValue,
  parseFxConfirmedMarker,
  parseOrphanageNoneMarker,
  type WizardSetupInput,
} from './wizard-setup-steps';

/** A fully-set-up week — every row must read done. */
const ALL_DONE: WizardSetupInput = {
  expectedWeekStart: '2026-07-26',
  weekLabel: 'Jul 26 – Aug 1',
  paneWeekStart: '2026-07-26',
  paneWeekLabel: 'Jul 26 – Aug 1',
  csvUpload: { sourceFile: 'simple-biz_daily_report_2026-07-26_to_2026-08-01.csv', uploadedAt: '2026-08-02T05:10:00Z', rowCount: 412 },
  newestUploadUnparseable: false,
  fxMarker: { rate: 58.9, by: 'lenny@simple.biz', at: '2026-08-02T06:00:00Z' },
  orphanageRowCount: 4,
  orphanageNoneMarker: false,
  kpi: { due: 9, submitted: 9, pendingDepts: [] },
  notes: { total: 3, applied: 3 },
  contractorsPending: 0,
  dispatchLock: { locked: true, lockedBy: 'lenny@simple.biz', lockedAt: '2026-08-03T09:00:00Z' },
  degradedKeys: new Set(),
};

function step(setup: ReturnType<typeof deriveWizardSetupSteps>, key: string) {
  const s = setup.steps.find((s) => s.key === key);
  assert.ok(s, `step ${key} missing`);
  return s;
}

test('all set up → 7/7 done, no mismatch', () => {
  const setup = deriveWizardSetupSteps(ALL_DONE);
  assert.equal(setup.totalCount, 7);
  assert.equal(setup.doneCount, 7);
  assert.equal(setup.mismatch, false);
  assert.equal(setup.matchedSourceFile, ALL_DONE.csvUpload!.sourceFile);
  for (const s of setup.steps) assert.equal(s.status, 'done', `${s.key} should be done`);
});

test('missing CSV → blocked, mismatch called out when the pane shows another week', () => {
  const setup = deriveWizardSetupSteps({
    ...ALL_DONE,
    csvUpload: null,
    paneWeekStart: '2026-07-19',
    paneWeekLabel: 'Jul 19 – Jul 25',
  });
  const csv = step(setup, 'csv');
  assert.equal(csv.status, 'blocked');
  assert.match(csv.detail, /Jul 19 – Jul 25/);
  assert.equal(setup.mismatch, true);
  assert.equal(setup.matchedSourceFile, null);
});

test('missing CSV with unparseable newest upload → attention, not blocked', () => {
  const setup = deriveWizardSetupSteps({ ...ALL_DONE, csvUpload: null, newestUploadUnparseable: true });
  assert.equal(step(setup, 'csv').status, 'attention');
});

test('fx unconfirmed → attention pointing at Step 2', () => {
  const setup = deriveWizardSetupSteps({ ...ALL_DONE, fxMarker: null });
  const fx = step(setup, 'fx');
  assert.equal(fx.status, 'attention');
  assert.match(fx.detail, /Step 2/);
});

test('orphanage: rows outrank the none-marker; none-marker alone is done; neither is attention', () => {
  const rows = step(deriveWizardSetupSteps({ ...ALL_DONE, orphanageNoneMarker: true }), 'orphanage');
  assert.equal(rows.status, 'done');
  assert.match(rows.detail, /4/);
  const marker = step(deriveWizardSetupSteps({ ...ALL_DONE, orphanageRowCount: 0, orphanageNoneMarker: true }), 'orphanage');
  assert.equal(marker.status, 'done');
  assert.match(marker.detail, /none/i);
  const neither = step(deriveWizardSetupSteps({ ...ALL_DONE, orphanageRowCount: 0 }), 'orphanage');
  assert.equal(neither.status, 'attention');
});

test('kpi: partial → attention listing pending depts (capped at 3), none due → pending', () => {
  const partial = step(
    deriveWizardSetupSteps({
      ...ALL_DONE,
      kpi: { due: 9, submitted: 7, pendingDepts: ['SSD', 'NPD', 'CS', 'Sales'] },
    }),
    'kpi',
  );
  assert.equal(partial.status, 'attention');
  assert.match(partial.detail, /7\/9/);
  assert.match(partial.detail, /SSD, NPD, CS \+1 more/);
  const none = step(deriveWizardSetupSteps({ ...ALL_DONE, kpi: { due: 0, submitted: 0, pendingDepts: [] } }), 'kpi');
  assert.equal(none.status, 'pending');
});

test('notes: zero rows → done "None"; partial applied → attention with counts', () => {
  const noneRow = step(deriveWizardSetupSteps({ ...ALL_DONE, notes: { total: 0, applied: 0 } }), 'notes');
  assert.equal(noneRow.status, 'done');
  const partial = step(deriveWizardSetupSteps({ ...ALL_DONE, notes: { total: 3, applied: 1 } }), 'notes');
  assert.equal(partial.status, 'attention');
  assert.match(partial.detail, /2 of 3/);
});

test('contractors pending → attention; dispatch unlocked → pending (neutral end-state)', () => {
  const c = step(deriveWizardSetupSteps({ ...ALL_DONE, contractorsPending: 2 }), 'contractors');
  assert.equal(c.status, 'attention');
  assert.match(c.detail, /2/);
  const d = step(
    deriveWizardSetupSteps({ ...ALL_DONE, dispatchLock: { locked: false, lockedBy: null, lockedAt: null } }),
    'dispatch',
  );
  assert.equal(d.status, 'pending');
});

test('a degraded read → pending "couldn\'t read", never done or blocked', () => {
  const setup = deriveWizardSetupSteps({ ...ALL_DONE, fxMarker: null, degradedKeys: new Set(['fx']) });
  const fx = step(setup, 'fx');
  assert.equal(fx.status, 'pending');
  assert.match(fx.detail, /read/i);
});

test('setting keys + marker/lock parsers', () => {
  assert.equal(fxConfirmedSettingKey('2026-07-26'), 'payroll.wizard.fx_confirmed.2026-07-26');
  assert.equal(orphanageConfirmedSettingKey('2026-07-26'), 'payroll.wizard.orphanage_confirmed.2026-07-26');
  assert.deepEqual(parseFxConfirmedMarker('{"rate":58.9,"by":"a@b.c","at":"2026-08-02T06:00:00Z"}'), {
    rate: 58.9,
    by: 'a@b.c',
    at: '2026-08-02T06:00:00Z',
  });
  assert.equal(parseFxConfirmedMarker('not json'), null);
  assert.equal(parseFxConfirmedMarker(null), null);
  assert.deepEqual(parseOrphanageNoneMarker('{"none":true,"by":"a@b.c","at":"x"}'), { by: 'a@b.c', at: 'x' });
  assert.equal(parseOrphanageNoneMarker('{"none":false}'), null);
  assert.deepEqual(parseDispatchLockValue('{"locked":true,"lockedAt":"t","lockedBy":"a@b.c"}'), {
    locked: true,
    lockedAt: 't',
    lockedBy: 'a@b.c',
  });
  assert.deepEqual(parseDispatchLockValue('true'), { locked: true, lockedAt: null, lockedBy: null });
  assert.deepEqual(parseDispatchLockValue(null), { locked: false, lockedAt: null, lockedBy: null });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --import tsx --test src/lib/payroll/wizard-setup-steps.test.ts`
Expected: FAIL — `Cannot find module './wizard-setup-steps'`.

- [ ] **Step 3: Write the implementation**

Create `src/lib/payroll/wizard-setup-steps.ts`:

```ts
/**
 * The Payroll Wizard's per-week setup checklist — the pure decision layer.
 *
 * Seven prerequisites must be true before a cycle can go to Payment Dispatch:
 * this week's Hubstaff CSV (step 1), the USD→PHP rate confirmed for the week
 * (step 2), orphanage hours entered or confirmed-none (step 3), KPI bonuses
 * ready (steps 4–5), notes adjustments pulled (step 5), contractor invoices
 * reviewed (step 6), and finally the dispatch lock itself (step 8).
 *
 * This module is PURE (no I/O, no server-only) so node:test can exercise every
 * status branch; the reads live in payroll-readiness.ts `buildWizardSetup`.
 * It is also imported by the wizard client for the app_settings marker keys.
 *
 * Deliberately NOT part of the readiness score — the checklist sits beside the
 * people-coverage score, never inside it (Kane, 2026-08-03).
 */

export type WizardSetupStepKey =
  | 'csv'
  | 'fx'
  | 'orphanage'
  | 'kpi'
  | 'notes'
  | 'contractors'
  | 'dispatch';

export interface WizardSetupStep {
  key: WizardSetupStepKey;
  /** Wizard step number(s) the fix lives on — "1", "2", "3", "4–5", "5", "6", "8". */
  stepNo: string;
  label: string;
  /** done = green · attention = amber (actionable) · blocked = rose (CSV missing
   *  — the only red) · pending = sky (neutral: not-yet end-state or failed read). */
  status: 'done' | 'attention' | 'blocked' | 'pending';
  detail: string;
}

export interface WizardSetup {
  /** Sunday ISO of the pay week the checklist evaluates. */
  expectedWeekStart: string;
  weekLabel: string;
  /** The upload whose filename week matches `expectedWeekStart`, if any. */
  matchedSourceFile: string | null;
  /** True when the rest of the readiness pane resolved a DIFFERENT week (its
   *  data is a stale file) — the CSV row's detail calls it out. */
  mismatch: boolean;
  steps: WizardSetupStep[];
  doneCount: number;
  totalCount: number;
}

export interface WizardSetupInput {
  expectedWeekStart: string;
  weekLabel: string;
  paneWeekStart: string;
  paneWeekLabel: string;
  csvUpload: { sourceFile: string; uploadedAt: string; rowCount: number | null } | null;
  /** The live current upload's filename carries no parseable week range. */
  newestUploadUnparseable: boolean;
  fxMarker: { rate: number; by: string | null; at: string | null } | null;
  orphanageRowCount: number;
  orphanageNoneMarker: boolean;
  kpi: { due: number; submitted: number; pendingDepts: string[] };
  /** Adjustment notes for the week: total strict-parseable rows / rows whose
   *  worker already has an Adj. override in the cycle's additions blob. */
  notes: { total: number; applied: number };
  contractorsPending: number;
  dispatchLock: { locked: boolean; lockedBy: string | null; lockedAt: string | null };
  /** Step keys whose backing read failed — those rows read `pending`,
   *  never a false done/blocked. */
  degradedKeys: Set<WizardSetupStepKey>;
}

// ── app_settings keys (written by the wizard, read by buildWizardSetup) ──────

export const FX_CONFIRMED_SETTING_PREFIX = 'payroll.wizard.fx_confirmed.';
export const ORPHANAGE_CONFIRMED_SETTING_PREFIX = 'payroll.wizard.orphanage_confirmed.';

export function fxConfirmedSettingKey(weekStart: string): string {
  return `${FX_CONFIRMED_SETTING_PREFIX}${weekStart}`;
}

export function orphanageConfirmedSettingKey(weekStart: string): string {
  return `${ORPHANAGE_CONFIRMED_SETTING_PREFIX}${weekStart}`;
}

export function parseFxConfirmedMarker(
  value: string | null,
): { rate: number; by: string | null; at: string | null } | null {
  if (!value) return null;
  try {
    const o = JSON.parse(value) as { rate?: unknown; by?: unknown; at?: unknown };
    if (typeof o.rate !== 'number' || !Number.isFinite(o.rate)) return null;
    return {
      rate: o.rate,
      by: typeof o.by === 'string' ? o.by : null,
      at: typeof o.at === 'string' ? o.at : null,
    };
  } catch {
    return null;
  }
}

export function parseOrphanageNoneMarker(
  value: string | null,
): { by: string | null; at: string | null } | null {
  if (!value) return null;
  try {
    const o = JSON.parse(value) as { none?: unknown; by?: unknown; at?: unknown };
    if (o.none !== true) return null;
    return {
      by: typeof o.by === 'string' ? o.by : null,
      at: typeof o.at === 'string' ? o.at : null,
    };
  } catch {
    return null;
  }
}

/** Mirror of useWizardDispatchLock's parseLock (the hook is client-only): JSON
 *  object, legacy 'true'/'false', or null. */
export function parseDispatchLockValue(
  value: string | null,
): { locked: boolean; lockedBy: string | null; lockedAt: string | null } {
  const EMPTY = { locked: false, lockedAt: null, lockedBy: null };
  if (!value) return EMPTY;
  const trimmed = value.trim();
  if (trimmed === 'true') return { locked: true, lockedAt: null, lockedBy: null };
  if (trimmed === 'false' || trimmed === '') return EMPTY;
  try {
    const o = JSON.parse(trimmed) as { locked?: unknown; lockedAt?: unknown; lockedBy?: unknown };
    return {
      locked: o.locked === true,
      lockedAt: typeof o.lockedAt === 'string' ? o.lockedAt : null,
      lockedBy: typeof o.lockedBy === 'string' ? o.lockedBy : null,
    };
  } catch {
    return EMPTY;
  }
}

// ── derive ───────────────────────────────────────────────────────────────────

/** "Aug 2" in Manila time, for detail strings. Null in → null out. */
function manilaStampLabel(iso: string | null): string | null {
  if (!iso) return null;
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return null;
  return new Intl.DateTimeFormat('en-PH', {
    timeZone: 'Asia/Manila',
    month: 'short',
    day: 'numeric',
  }).format(d);
}

export function deriveWizardSetupSteps(input: WizardSetupInput): WizardSetup {
  const mismatch = input.paneWeekStart !== input.expectedWeekStart;
  const steps: WizardSetupStep[] = [];
  const degraded = (key: WizardSetupStepKey) => input.degradedKeys.has(key);

  // 1 · Hubstaff CSV — the only row that can read `blocked`.
  if (degraded('csv')) {
    steps.push({ key: 'csv', stepNo: '1', label: 'Hubstaff CSV', status: 'pending', detail: "Couldn't read the upload list" });
  } else if (input.csvUpload) {
    const stamp = manilaStampLabel(input.csvUpload.uploadedAt);
    steps.push({
      key: 'csv',
      stepNo: '1',
      label: 'Hubstaff CSV',
      status: 'done',
      detail: `Uploaded${stamp ? ` ${stamp}` : ''}${input.csvUpload.rowCount != null ? ` · ${input.csvUpload.rowCount} rows` : ''}`,
    });
  } else if (input.newestUploadUnparseable) {
    steps.push({
      key: 'csv',
      stepNo: '1',
      label: 'Hubstaff CSV',
      status: 'attention',
      detail: "Can't tell — the newest upload's name has no week range",
    });
  } else {
    steps.push({
      key: 'csv',
      stepNo: '1',
      label: 'Hubstaff CSV',
      status: 'blocked',
      detail: mismatch ? `Not uploaded — sections below show ${input.paneWeekLabel}` : 'Not uploaded yet',
    });
  }

  // 2 · USD → PHP rate confirmed for the week.
  if (degraded('fx')) {
    steps.push({ key: 'fx', stepNo: '2', label: 'USD rate confirmed', status: 'pending', detail: "Couldn't read the weekly confirmation" });
  } else if (input.fxMarker) {
    const stamp = manilaStampLabel(input.fxMarker.at);
    steps.push({
      key: 'fx',
      stepNo: '2',
      label: 'USD rate confirmed',
      status: 'done',
      detail: `₱${input.fxMarker.rate} / $1${input.fxMarker.by ? ` · ${input.fxMarker.by}` : ''}${stamp ? ` · ${stamp}` : ''}`,
    });
  } else {
    steps.push({ key: 'fx', stepNo: '2', label: 'USD rate confirmed', status: 'attention', detail: 'Not confirmed — Confirm on Step 2' });
  }

  // 3 · Orphanage hours — real rows always outrank the confirm-none marker.
  if (degraded('orphanage')) {
    steps.push({ key: 'orphanage', stepNo: '3', label: 'Orphanage hours', status: 'pending', detail: "Couldn't read orphanage records" });
  } else if (input.orphanageRowCount > 0) {
    steps.push({
      key: 'orphanage',
      stepNo: '3',
      label: 'Orphanage hours',
      status: 'done',
      detail: `${input.orphanageRowCount} ${input.orphanageRowCount === 1 ? 'person' : 'people'} locked in`,
    });
  } else if (input.orphanageNoneMarker) {
    steps.push({ key: 'orphanage', stepNo: '3', label: 'Orphanage hours', status: 'done', detail: 'Confirmed none this week' });
  } else {
    steps.push({
      key: 'orphanage',
      stepNo: '3',
      label: 'Orphanage hours',
      status: 'attention',
      detail: 'Paste hours or confirm none on Step 3',
    });
  }

  // 4–5 · KPI bonuses.
  if (degraded('kpi')) {
    steps.push({ key: 'kpi', stepNo: '4–5', label: 'KPI bonuses', status: 'pending', detail: "Couldn't read KPI statuses" });
  } else if (input.kpi.due === 0) {
    steps.push({ key: 'kpi', stepNo: '4–5', label: 'KPI bonuses', status: 'pending', detail: 'No departments due this week' });
  } else if (input.kpi.submitted >= input.kpi.due) {
    steps.push({
      key: 'kpi',
      stepNo: '4–5',
      label: 'KPI bonuses',
      status: 'done',
      detail: `${input.kpi.due}/${input.kpi.due} departments ready`,
    });
  } else {
    const listed = input.kpi.pendingDepts.slice(0, 3).join(', ');
    const extra = input.kpi.pendingDepts.length > 3 ? ` +${input.kpi.pendingDepts.length - 3} more` : '';
    steps.push({
      key: 'kpi',
      stepNo: '4–5',
      label: 'KPI bonuses',
      status: 'attention',
      detail: `${input.kpi.submitted}/${input.kpi.due} ready${listed ? ` · ${listed}${extra}` : ''}`,
    });
  }

  // 5 · Notes adjustments.
  if (degraded('notes')) {
    steps.push({ key: 'notes', stepNo: '5', label: 'Notes adjustments', status: 'pending', detail: "Couldn't read the notes board" });
  } else if (input.notes.total === 0) {
    steps.push({ key: 'notes', stepNo: '5', label: 'Notes adjustments', status: 'done', detail: 'None this week' });
  } else if (input.notes.applied >= input.notes.total) {
    steps.push({
      key: 'notes',
      stepNo: '5',
      label: 'Notes adjustments',
      status: 'done',
      detail: `${input.notes.total} applied in the wizard`,
    });
  } else {
    steps.push({
      key: 'notes',
      stepNo: '5',
      label: 'Notes adjustments',
      status: 'attention',
      detail: `${input.notes.total - input.notes.applied} of ${input.notes.total} not yet in wizard`,
    });
  }

  // 6 · Contractor invoices.
  if (degraded('contractors')) {
    steps.push({ key: 'contractors', stepNo: '6', label: 'Contractor invoices', status: 'pending', detail: "Couldn't read invoices" });
  } else if (input.contractorsPending === 0) {
    steps.push({ key: 'contractors', stepNo: '6', label: 'Contractor invoices', status: 'done', detail: 'None pending' });
  } else {
    steps.push({
      key: 'contractors',
      stepNo: '6',
      label: 'Contractor invoices',
      status: 'attention',
      detail: `${input.contractorsPending} awaiting approval`,
    });
  }

  // 8 · Sent to dispatch — the end-state; never a warning while unfinished.
  if (degraded('dispatch')) {
    steps.push({ key: 'dispatch', stepNo: '8', label: 'Sent to dispatch', status: 'pending', detail: "Couldn't read the cycle lock" });
  } else if (input.dispatchLock.locked) {
    const stamp = manilaStampLabel(input.dispatchLock.lockedAt);
    steps.push({
      key: 'dispatch',
      stepNo: '8',
      label: 'Sent to dispatch',
      status: 'done',
      detail: `Locked${input.dispatchLock.lockedBy ? ` by ${input.dispatchLock.lockedBy}` : ''}${stamp ? ` · ${stamp}` : ''}`,
    });
  } else {
    steps.push({ key: 'dispatch', stepNo: '8', label: 'Sent to dispatch', status: 'pending', detail: 'Not sent yet' });
  }

  return {
    expectedWeekStart: input.expectedWeekStart,
    weekLabel: input.weekLabel,
    matchedSourceFile: input.csvUpload?.sourceFile ?? null,
    mismatch,
    steps,
    doneCount: steps.filter((s) => s.status === 'done').length,
    totalCount: steps.length,
  };
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `node --import tsx --test src/lib/payroll/wizard-setup-steps.test.ts`
Expected: PASS (10 tests).

- [ ] **Step 5: Commit**

```bash
git add src/lib/payroll/wizard-setup-steps.ts src/lib/payroll/wizard-setup-steps.test.ts
git commit -m "feat(readiness): pure wizard-setup checklist derivation, marker keys and parsers"
```

---

### Task 4: Server assembler `buildWizardSetup` + response field + verify script

**Files:**
- Modify: `src/lib/payroll/payroll-readiness.ts` (imports, new builder, `PayrollReadiness` interface ~:190, `getPayrollReadiness` ~:1419-1472)
- Modify: `scripts/verify-readiness.mts` (print the new block)

**Interfaces:**
- Consumes: everything Task 3 produced; `listHubstaffUploads` (`src/lib/supabase/hubstaff-hours-db.ts:518`); `listOrphanagePay(sourceFile)` (`src/lib/supabase/orphanage-pay-db.ts:83`); `listPayrollWizardNotes()` (`src/lib/supabase/payroll-wizard-notes.ts:99`); `getAppSettings(keys)` / `getAppSetting(key)` (`src/lib/supabase/app-settings.ts:9/:26`); `parseAdjustmentAmount` (`src/lib/payroll/adjustment-bridge.ts:102`); `isInvoiceInPeriod` (`src/lib/contractor/invoice-period.ts:32` — check its exact parameter shape there and mirror the call at `contractor-dispatch-queue.ts:343`); `pickCurrentSourceFile` (already imported); `payrollNotesWeekStart`, `weekEndFromStart`, `weekRangeLabel` from `manila-week`.
- Produces: `PayrollReadiness.wizardSetup: WizardSetup` — Task 5's UI consumes it; `payroll-readiness.ts` re-exports `type { WizardSetup, WizardSetupStep }`.

- [ ] **Step 1: Extend imports and the interface**

In `payroll-readiness.ts`:

```ts
// extend the existing manila-week import (:85) —
import { weekRangeLabel, payrollNotesWeekStart, weekEndFromStart } from '@/lib/payroll/manila-week';

// new imports —
import { listOrphanagePay } from '@/lib/supabase/orphanage-pay-db';
import { listPayrollWizardNotes } from '@/lib/supabase/payroll-wizard-notes';
import { getAppSettings } from '@/lib/supabase/app-settings'; // getAppSetting is already imported
import { parseAdjustmentAmount } from '@/lib/payroll/adjustment-bridge';
import { isInvoiceInPeriod } from '@/lib/contractor/invoice-period';
import {
  deriveWizardSetupSteps,
  fxConfirmedSettingKey,
  orphanageConfirmedSettingKey,
  parseDispatchLockValue,
  parseFxConfirmedMarker,
  parseOrphanageNoneMarker,
  type WizardSetup,
  type WizardSetupStepKey,
} from '@/lib/payroll/wizard-setup-steps';

// re-export for the UI (same precedent as the readiness-score re-exports at :94-95)
export type { WizardSetup, WizardSetupStep } from '@/lib/payroll/wizard-setup-steps';
```

Add to the `PayrollReadiness` interface (after `degraded`):

```ts
  /** The per-week Wizard setup checklist — evaluated against the EXPECTED pay
   *  week (payrollNotesWeekStart, or the selected file's week when the caller
   *  is on an older upload), NOT the pane's resolved data week. See
   *  wizard-setup-steps.ts. */
  wizardSetup: WizardSetup;
```

- [ ] **Step 2: Write `buildWizardSetup` (place it after `buildExceptions`, before the public entry point)**

```ts
// ── Wizard setup checklist ────────────────────────────────────────────────────

/** Count `pending` (awaiting Accounting approval), non-stranded contractor
 *  invoices that would ride the week's cycle — the same status/stranded/window
 *  rules the dispatch queue uses (contractor-dispatch-queue.ts:297-346), reread
 *  here with a paged loop (PostgREST caps every read at 1000 rows). */
async function countPendingContractorInvoices(weekStart: string): Promise<number> {
  const supabase = createSupabaseServiceRoleClient();
  if (!supabase) throw new Error('Supabase unavailable');
  type Row = {
    id: string;
    invoice_date: string | null;
    due_date: string | null;
    created_at: string | null;
    dispatch_claimed_at: string | null;
  };
  const rows: Row[] = [];
  for (let from = 0; ; from += 1000) {
    const { data, error } = await supabase
      .from('contractor_invoices')
      .select('id, invoice_date, due_date, created_at, dispatch_claimed_at')
      .eq('status', 'pending')
      .is('dispatch_id', null)
      .range(from, from + 999);
    if (error) throw new Error(error.message);
    rows.push(...((data ?? []) as Row[]));
    if (!data || data.length < 1000) break;
  }
  const start = parseLocalIso(weekStart);
  const end = parseLocalIso(weekEndFromStart(weekStart));
  if (!start || !end) return rows.filter((i) => !i.dispatch_claimed_at).length;
  return rows.filter((i) => !i.dispatch_claimed_at && isInvoiceInPeriod(i, start, end)).length;
}

/**
 * Assemble the Wizard setup checklist for the EXPECTED pay week.
 *
 * Expected week rule (the load-bearing part): when the caller is on the live
 * current upload (or there is none), the checklist anchors to
 * `payrollNotesWeekStart()` — the calendar pay week — NOT the upload's week.
 * That is what lets a missing new-week CSV read `blocked` instead of the pane
 * silently showing last week's file as all-green. Only an explicitly selected
 * OLDER upload (readiness week selector / wizard replay) re-anchors the
 * checklist to that file's own week, as a historical view.
 */
async function buildWizardSetup(
  resolvedFile: string | null,
  paneWeekStart: string,
  kpi: ReadinessKpiDept[],
): Promise<{ setup: WizardSetup; degraded: string[] }> {
  const degraded: string[] = [];
  const degradedKeys = new Set<WizardSetupStepKey>();

  let uploads: Awaited<ReturnType<typeof listHubstaffUploads>> | null = null;
  try {
    uploads = await listHubstaffUploads();
  } catch {
    degradedKeys.add('csv');
    degraded.push("The Hubstaff upload list couldn't be read — the setup checklist's CSV row is unknown.");
  }

  const currentFile = uploads
    ? pickCurrentSourceFile(
        uploads.map((u) => ({ source_file: u.source_file, is_current: u.is_current })),
        undefined,
      )
    : null;
  const viewingOlderFile = Boolean(resolvedFile && currentFile && resolvedFile !== currentFile);
  const expectedWeekStart = viewingOlderFile
    ? (weekKeyFromSourceFile(resolvedFile!) ?? payrollNotesWeekStart())
    : payrollNotesWeekStart();

  // The upload whose filename week matches the expected week. Prefer the
  // is_current batch, else the newest (the list is already newest-first).
  const matching = (uploads ?? []).filter(
    (u) => u.source_file && weekKeyFromSourceFile(u.source_file) === expectedWeekStart,
  );
  const matched = matching.find((u) => u.is_current) ?? matching[0] ?? null;
  const newestUploadUnparseable = Boolean(currentFile && weekKeyFromSourceFile(currentFile) === null);

  const [settings, orphanageRows, notesRes, additionsRaw, contractorsPending] = await Promise.all([
    getAppSettings([
      fxConfirmedSettingKey(expectedWeekStart),
      orphanageConfirmedSettingKey(expectedWeekStart),
      ...(matched?.source_file ? [`payroll.dispatch_lock.${matched.source_file}`] : []),
    ]).catch(() => null),
    matched?.source_file
      ? listOrphanagePay(matched.source_file).catch(() => null)
      : Promise.resolve([] as Record<string, unknown>[]),
    listPayrollWizardNotes().catch(() => ({ rows: null, error: 'unreachable' })),
    matched?.source_file
      ? getAppSetting(`payroll.wizard.additions.${matched.source_file}`).catch(() => undefined)
      : Promise.resolve(null),
    countPendingContractorInvoices(expectedWeekStart).catch(() => null),
  ]);

  if (settings === null) {
    degradedKeys.add('fx');
    degradedKeys.add('orphanage');
    degradedKeys.add('dispatch');
    degraded.push("app_settings couldn't be read — the setup checklist's confirmations are unknown.");
  }
  if (orphanageRows === null) {
    degradedKeys.add('orphanage');
    degraded.push("Orphanage records couldn't be read — the setup checklist's orphanage row is unknown.");
  }
  // listPayrollWizardNotes reports Supabase errors as { rows: [], error } WITHOUT
  // throwing — check the error field, or a broken read silently reads "None this week".
  if (notesRes.rows === null || notesRes.error) {
    degradedKeys.add('notes');
    degraded.push("The notes board couldn't be read — the setup checklist's adjustments row is unknown.");
  }
  if (additionsRaw === undefined) {
    degradedKeys.add('notes');
    degraded.push("The cycle's additions blob couldn't be read — applied adjustments are unknown.");
  }
  if (contractorsPending === null) {
    degradedKeys.add('contractors');
    degraded.push("Contractor invoices couldn't be read — the setup checklist's invoice row is unknown.");
  }

  // Notes: strict-parseable Adjustment rows for the expected week, judged
  // "applied" when the worker's normalized email has a finite Adj. override in
  // the cycle's additions blob. Existence-based on purpose: the bridge has no
  // per-note applied column, and hand-tweaked overrides after a pull are
  // legitimate — this catches the real failure (a week of notes never pulled)
  // without false ambers. bonusOverrides is keyed by RAW calc-result casing, so
  // normalize both sides for the comparison only.
  const overrideEmails = new Set<string>();
  if (typeof additionsRaw === 'string' && additionsRaw) {
    try {
      const blob = JSON.parse(additionsRaw) as { bonusOverrides?: Record<string, unknown> };
      for (const [email, v] of Object.entries(blob.bonusOverrides ?? {})) {
        if (typeof v === 'number' && Number.isFinite(v)) overrideEmails.add(email.trim().toLowerCase());
      }
    } catch {
      /* malformed blob — treated as no overrides */
    }
  }
  const weekNotes = (notesRes.rows ?? []).filter(
    (r) => r.week_start === expectedWeekStart && parseAdjustmentAmount(r.adjustment) !== null,
  );
  const appliedNotes = weekNotes.filter((r) =>
    overrideEmails.has((r.worker_email ?? '').trim().toLowerCase()),
  );

  const kpiDueRows = kpi.filter((d) => d.status !== 'na' && d.status !== 'excluded');
  const kpiSubmittedRows = kpiDueRows.filter(
    (d) => d.status === 'ready' || d.status === 'locked' || d.status === 'no_bonus',
  );
  const pendingDepts = kpiDueRows
    .filter((d) => d.status !== 'ready' && d.status !== 'locked' && d.status !== 'no_bonus')
    .map((d) => d.department);

  const setup = deriveWizardSetupSteps({
    expectedWeekStart,
    weekLabel: weekRangeLabel(expectedWeekStart),
    paneWeekStart,
    paneWeekLabel: weekRangeLabel(paneWeekStart),
    csvUpload: matched?.source_file
      ? { sourceFile: matched.source_file, uploadedAt: matched.uploaded_at, rowCount: matched.row_count }
      : null,
    newestUploadUnparseable,
    fxMarker: parseFxConfirmedMarker(settings?.[fxConfirmedSettingKey(expectedWeekStart)] ?? null),
    orphanageRowCount: (orphanageRows ?? []).length,
    orphanageNoneMarker:
      parseOrphanageNoneMarker(settings?.[orphanageConfirmedSettingKey(expectedWeekStart)] ?? null) !== null,
    kpi: { due: kpiDueRows.length, submitted: kpiSubmittedRows.length, pendingDepts },
    notes: { total: weekNotes.length, applied: appliedNotes.length },
    contractorsPending: contractorsPending ?? 0,
    dispatchLock: parseDispatchLockValue(
      matched?.source_file ? (settings?.[`payroll.dispatch_lock.${matched.source_file}`] ?? null) : null,
    ),
    degradedKeys,
  });
  return { setup, degraded };
}
```

Notes for the implementer:
- `ReadinessKpiDept` (:110) — confirm the dept label field name (`department`) and adjust `pendingDepts` mapping if it differs.
- `getAppSettings` returns `Record<string, string | null>` and never throws in normal operation — the `.catch(() => null)` guards transport-level failures.
- The KPI due/submitted filters MUST mirror `getPayrollReadiness`'s own `kpiDue`/`kpiSubmitted` at :1421-1424 exactly.
- `isInvoiceInPeriod`: open `src/lib/contractor/invoice-period.ts` and match its real signature; the call at `contractor-dispatch-queue.ts:343` passes `(i, cycleWindow.start, cycleWindow.end)` where the window came from `parseCyclePeriodFromFile`. If its window params are `Date`s, `parseLocalIso(...)` above already produces `Date`s; if they are ISO strings, pass `weekStart` / `weekEndFromStart(weekStart)` directly.
- Known limitation (accepted): `listOrphanagePay` swallows Supabase errors and returns `[]`, so an orphanage read failure reads as `attention` ("Paste hours or confirm none") rather than `pending` — the safe over-flagging direction. Do not restructure the lib for this.

- [ ] **Step 3: Call it from `getPayrollReadiness` and return it**

After the `missingBankOnPayroll` reduce (:1412) and BEFORE the `computeReadinessScore` call (so its degraded notes participate in the ready→at_risk override):

```ts
  const wizardSetupRes = await buildWizardSetup(resolvedFile, weekStart, kpi);
  degraded.push(...wizardSetupRes.degraded);
```

Add to the return literal (:1456-1472), after `degraded`:

```ts
    wizardSetup: wizardSetupRes.setup,
```

- [ ] **Step 4: Typecheck**

Run: `npm run lint`
Expected: clean.

- [ ] **Step 5: Extend `scripts/verify-readiness.mts`**

After the score-components loop (the `for (const c of r.score.components)` block), add:

```ts
const ws = r.wizardSetup;
console.log(
  `\nWizard setup: ${ws.doneCount}/${ws.totalCount} · week=${ws.expectedWeekStart} (${ws.weekLabel})` +
    `${ws.mismatch ? " · MISMATCH — pane shows another week" : ""}${ws.matchedSourceFile ? ` · file=${ws.matchedSourceFile}` : " · no matching upload"}`,
);
for (const s of ws.steps) {
  console.log(`  [${s.status.padEnd(9)}] ${s.stepNo.padEnd(3)} ${s.label.padEnd(20)} ${s.detail}`);
}
```

- [ ] **Step 6: Run the verify script (read-only) and eyeball the block**

```powershell
$env:TSX_TSCONFIG_PATH="tsconfig.readiness-verify.json"; node --import tsx scripts/verify-readiness.mts
```

Expected: the new `Wizard setup: N/7 · week=…` block prints; the CSV row should read `done` if this week's file is uploaded (or `blocked` with the mismatch note if not); `fx`/`orphanage` read `attention` until Task 6 ships the stamp buttons — that's correct.

- [ ] **Step 7: Commit**

```bash
git add src/lib/payroll/payroll-readiness.ts scripts/verify-readiness.mts
git commit -m "feat(readiness): wizardSetup block - per-week wizard-step checklist computed in the readiness API"
```

---

### Task 5: WizardSetupSection UI in the Readiness pane

> **AMENDED by Kane 2026-08-03 (mid-execution):** the checklist is NOT a section below
> the hero — it is its **own tab, FIRST in the inner Readiness tab strip, before KPI
> Submissions**, and the default selected tab. `ReadinessTab` gains `"setup"` at the
> head of the order; the strip badge counts open steps (amber while open, emerald at 0,
> no `neutral`/`blocker` flag); the pane shows a slim week/N-of-7 header + the 7 rows;
> the stat-tile row stays 4 tiles; the below-hero section and its collapse behavior are
> removed; the skeleton's tab labels gain "Wizard Setup" first (no extra hero-adjacent
> shimmer block). The steps below describe the superseded section variant — the row
> rendering (SETUP_STATUS_PILL / SETUP_STEP_ICON / row layout) carries over into the
> pane unchanged.

**Files:**
- Modify: `src/components/accounting/PayrollWizardNotesFab.tsx` (type import ~:80-88, lucide import ~:8-35, new component near `PaneBody` ~:1608, render insert ~:3064-3068, `useLiveRefresh` ~:2836-2848, `ReadinessSkeleton` ~:3632)

**Interfaces:**
- Consumes: `WizardSetup`, `WizardSetupStep` re-exported from `@/lib/payroll/payroll-readiness` (Task 4); `data.wizardSetup` on the fetched `PayrollReadiness`.
- Produces: `function WizardSetupSection({ setup, reduceMotion }: { setup: WizardSetup; reduceMotion: boolean })` — internal to this file.

- [ ] **Step 1: Extend imports**

Add `WizardSetup` and `WizardSetupStep` to the existing type import from `@/lib/payroll/payroll-readiness` (:80-88). Add `Heart`, `DollarSign`, `Upload`, `Send`, `FileText` to the lucide-react import (:8-35) — keep the list alphabetized as it is now.

- [ ] **Step 2: Add the section component (place it right after `PaneBody`, ~:1616)**

```tsx
/** Status pill + row meta for the Wizard setup checklist. Read-only by design —
 *  fixes happen on the wizard steps themselves; the detail names which one. */
const SETUP_STATUS_PILL: Record<
  WizardSetupStep["status"],
  { label: string; cls: string; Icon: typeof CheckCircle2 }
> = {
  done: {
    label: "Done",
    cls: "border-emerald-200 bg-emerald-50 text-emerald-700 dark:border-emerald-500/30 dark:bg-emerald-500/10 dark:text-emerald-300",
    Icon: CheckCircle2,
  },
  attention: {
    label: "Attention",
    cls: "border-amber-200 bg-amber-50 text-amber-700 dark:border-amber-500/30 dark:bg-amber-500/10 dark:text-amber-300",
    Icon: AlertTriangle,
  },
  blocked: {
    label: "Blocked",
    cls: "border-rose-200 bg-rose-50 text-rose-700 dark:border-rose-500/30 dark:bg-rose-500/10 dark:text-rose-300",
    Icon: AlertTriangle,
  },
  pending: {
    label: "Pending",
    cls: "border-sky-200 bg-sky-50 text-sky-700 dark:border-sky-500/30 dark:bg-sky-500/10 dark:text-sky-300",
    Icon: Clock,
  },
};

const SETUP_STEP_ICON: Record<WizardSetupStep["key"], typeof CheckCircle2> = {
  csv: Upload,
  fx: DollarSign,
  orphanage: Heart,
  kpi: Sparkles,
  notes: StickyNote,
  contractors: FileText,
  dispatch: Send,
};

/** The per-week "Wizard setup" checklist card: 7 wizard prerequisites, one row
 *  each. Defaults open while anything is unfinished; collapsed once all seven
 *  are done (a manual toggle overrides either way, not persisted). */
function WizardSetupSection({ setup, reduceMotion }: { setup: WizardSetup; reduceMotion: boolean }) {
  const [manualOpen, setManualOpen] = useState<boolean | null>(null);
  const allDone = setup.doneCount >= setup.totalCount;
  const open = manualOpen ?? !allDone;
  return (
    <section className="rounded-xl border border-orange-100 bg-white/60 dark:border-blue-950/60 dark:bg-blue-950/10">
      <button
        type="button"
        aria-expanded={open}
        onClick={() => setManualOpen(!open)}
        className="flex w-full items-center gap-2 px-3 py-2 text-left"
      >
        <ClipboardList className="h-4 w-4 shrink-0 text-orange-600 dark:text-orange-400" />
        <span className="text-xs font-semibold text-zinc-800 dark:text-zinc-200">Wizard setup</span>
        <span className="text-[11px] text-zinc-500 dark:text-zinc-400">· {setup.weekLabel}</span>
        <span
          className={`ml-auto rounded-full border px-1.5 py-0.5 text-[9px] font-semibold uppercase tracking-wide ${
            allDone
              ? "border-emerald-200 bg-emerald-50 text-emerald-700 dark:border-emerald-500/30 dark:bg-emerald-500/10 dark:text-emerald-300"
              : "border-amber-200 bg-amber-50 text-amber-700 dark:border-amber-500/30 dark:bg-amber-500/10 dark:text-amber-300"
          }`}
        >
          {setup.doneCount}/{setup.totalCount}
        </span>
        <ChevronDown
          className={`h-3.5 w-3.5 shrink-0 text-zinc-400 transition-transform ${open ? "rotate-180" : ""}`}
        />
      </button>
      <AnimatePresence initial={false}>
        {open && (
          <motion.div
            key="setup-rows"
            initial={reduceMotion ? false : { height: 0, opacity: 0 }}
            animate={{ height: "auto", opacity: 1 }}
            exit={reduceMotion ? undefined : { height: 0, opacity: 0 }}
            transition={{ duration: reduceMotion ? 0 : 0.22, ease: EASE }}
            className="overflow-hidden"
          >
            <ul className="space-y-0.5 px-2 pb-2">
              {setup.steps.map((s) => {
                const pill = SETUP_STATUS_PILL[s.status];
                const StepIcon = SETUP_STEP_ICON[s.key];
                return (
                  <li
                    key={s.key}
                    className="flex items-center gap-2 rounded-lg px-1.5 py-1 hover:bg-orange-50/60 dark:hover:bg-blue-950/30"
                  >
                    <span className="w-7 shrink-0 text-center font-mono text-[10px] font-semibold text-zinc-400 dark:text-zinc-500">
                      {s.stepNo}
                    </span>
                    <StepIcon className="h-3.5 w-3.5 shrink-0 text-zinc-400 dark:text-zinc-500" />
                    <span className="shrink-0 text-xs font-medium text-zinc-800 dark:text-zinc-200">{s.label}</span>
                    <span
                      className={`inline-flex shrink-0 items-center gap-1 rounded-full border px-1.5 py-0.5 text-[9px] font-semibold uppercase tracking-wide ${pill.cls}`}
                    >
                      <pill.Icon className="h-2.5 w-2.5" />
                      {pill.label}
                    </span>
                    <span className="min-w-0 flex-1 truncate text-right text-[11px] text-zinc-500 dark:text-zinc-400" title={s.detail}>
                      {s.detail}
                    </span>
                  </li>
                );
              })}
            </ul>
          </motion.div>
        )}
      </AnimatePresence>
    </section>
  );
}
```

- [ ] **Step 3: Render it below the hero**

In `PayrollReadinessGlance`'s return, the frozen header (`<div className="shrink-0 space-y-3">`) currently renders the hero `div`, then the degraded-data alert (:3049-3064), then the stat-tile grid (:3068). Insert **between the degraded alert block and the grid**:

```tsx
      {data.wizardSetup && (
        <WizardSetupSection setup={data.wizardSetup} reduceMotion={reduceMotion} />
      )}
```

(The `&&` guard keeps the pane resilient if an older cached API response without the field is ever in flight.)

- [ ] **Step 4: Live refresh + skeleton**

In the `useLiveRefresh` call (:2836-2848) extend `tables` with:

```ts
      "hubstaff_uploads",
      "orphanage_pay",
      "payroll_wizard_notes",
      "contractor_invoices",
      "app_settings",
```

In `ReadinessSkeleton` (:3632), after the hero placeholder `div` and before the tiles grid, add:

```tsx
      <div className="flex items-center gap-3 rounded-xl border border-zinc-200/70 bg-white/60 px-3 py-2 dark:border-zinc-800 dark:bg-zinc-900/40">
        <div className={`${bar} h-4 w-4 rounded`} />
        <div className={`${bar} h-3 w-32`} />
        <div className={`${bar} ml-auto h-3 w-10 rounded-full`} />
      </div>
```

- [ ] **Step 5: Typecheck**

Run: `npm run lint`
Expected: clean.

- [ ] **Step 6: Manual check (only if a dev server is already running — do not start builds)**

If `next dev` is up: open the Payroll Wizard tab → Notes FAB → Readiness. The "Wizard setup · <week>" card sits under the hero; rows show statuses; collapsing works; all-done state starts collapsed.

- [ ] **Step 7: Commit**

```bash
git add src/components/accounting/PayrollWizardNotesFab.tsx
git commit -m "feat(readiness): Wizard setup checklist section under the readiness hero"
```

---

### Task 6: Wizard confirm markers — fx stamp + Confirm button (Step 2), confirm-none button (Step 3)

> **CORRECTED in review (fix round 1):** Step 1's `markerWeekStart` formula below is
> wrong — `hubstaffWeekStart ?? payrollNotesWeekStart()` stamps LAST week's key in the
> new-week-no-CSV window. The shipped rule mirrors the reader:
> `const markerWeekStart = isReplay ? (hubstaffWeekStart ?? payrollNotesWeekStart()) : payrollNotesWeekStart();`

**Files:**
- Modify: `src/components/PayrollWizard.tsx` (imports ~:55-230, state ~:1996, marker-load effect near the fx-settings load ~:2949, fx card ~:9958-10083, orphanage step ~:13097-13150)

**Interfaces:**
- Consumes: `fxConfirmedSettingKey`, `orphanageConfirmedSettingKey`, `parseFxConfirmedMarker`, `parseOrphanageNoneMarker` from `@/lib/payroll/wizard-setup-steps` (pure — client-safe); `payrollNotesWeekStart` from `@/lib/payroll/manila-week`; existing `savePabSetting` (:2530), `logAudit`, `sessionEmail`/`sessionRole`, `hubstaffWeekStart` (:2146), `orphanageAmounts`, `isReplay`.
- Produces: app_settings rows `payroll.wizard.fx_confirmed.<weekStart>` = `{"rate":number,"by":string|null,"at":iso}` and `payroll.wizard.orphanage_confirmed.<weekStart>` = `{"none":true,"by":string|null,"at":iso}` — exactly what Task 4's reader parses.

- [ ] **Step 1: Imports + state + marker week**

Add imports:

```ts
import { payrollNotesWeekStart } from '@/lib/payroll/manila-week';
import {
  fxConfirmedSettingKey,
  orphanageConfirmedSettingKey,
  parseFxConfirmedMarker,
  parseOrphanageNoneMarker,
} from '@/lib/payroll/wizard-setup-steps';
```

Near the fx state block (:1996) add:

```ts
  /** Sunday ISO the weekly confirm markers key on: the cycle being worked
   *  (its filename week) — falling back to the calendar pay week before a
   *  file is selected. Must match what buildWizardSetup reads. */
  const markerWeekStart = hubstaffWeekStart ?? payrollNotesWeekStart();
  const [fxConfirmedAt, setFxConfirmedAt] = useState<string | null>(null);
  const [fxConfirming, setFxConfirming] = useState(false);
  const [orphanageNoneConfirmed, setOrphanageNoneConfirmed] = useState(false);
  const [orphanageNoneConfirming, setOrphanageNoneConfirming] = useState(false);
```

NOTE: `markerWeekStart` must be declared AFTER the `hubstaffWeekStart` memo (:2146) — put the state `useState`s at :1996 but the `markerWeekStart` const just below the memo at :2155.

- [ ] **Step 2: Load both markers when the week changes**

Add an effect below the `markerWeekStart` const:

```ts
  // The weekly confirm markers (fx + orphanage-none) for the cycle in view —
  // read-only mirrors of what the Readiness checklist shows, so the Step 2/3
  // buttons can render "already confirmed".
  useEffect(() => {
    let cancelled = false;
    const keys = [fxConfirmedSettingKey(markerWeekStart), orphanageConfirmedSettingKey(markerWeekStart)];
    fetch(`/api/app-settings?keys=${encodeURIComponent(keys.join(','))}`, { cache: 'no-store' })
      .then((res) => (res.ok ? res.json() : { settings: {} }))
      .then((json: { settings?: Record<string, string | null> }) => {
        if (cancelled) return;
        const fx = parseFxConfirmedMarker(json.settings?.[keys[0]!] ?? null);
        setFxConfirmedAt(fx?.at ?? (fx ? '' : null));
        setOrphanageNoneConfirmed(parseOrphanageNoneMarker(json.settings?.[keys[1]!] ?? null) !== null);
      })
      .catch(() => {
        /* marker display is best-effort; stamping still works */
      });
    return () => {
      cancelled = true;
    };
  }, [markerWeekStart]);
```

NOTE: check the exact response shape of `GET /api/app-settings?keys=` first — the fx-settings loader at :2928-2949 already consumes it; mirror whatever shape that effect reads (it may be `{ settings: {...} }` or a flat map).

- [ ] **Step 3: Stamp helper + wire into BOTH save paths**

Add near `savePabSetting`:

```ts
  /** Stamp the weekly fx confirmation (spec: saving the rate confirms it; the
   *  standalone button covers no-change weeks). Never throws — a failed stamp
   *  must not break the rate save it rides on. */
  const stampFxConfirmed = React.useCallback(
    async (rate: number) => {
      const at = new Date().toISOString();
      try {
        await savePabSetting(
          fxConfirmedSettingKey(markerWeekStart),
          JSON.stringify({ rate, by: sessionEmail ?? null, at }),
        );
        setFxConfirmedAt(at);
        void logAudit({
          user_name: sessionEmail ?? 'anonymous',
          user_role: sessionRole ?? 'user',
          action: 'wizard.fx_week_confirmed',
          resource: fxConfirmedSettingKey(markerWeekStart),
          cycle: auditCycle,
          details: { rate, week_start: markerWeekStart },
        });
      } catch {
        toast.error('Rate saved, but the weekly confirmation stamp failed — use "Confirm for this week".');
      }
    },
    [markerWeekStart, savePabSetting, sessionEmail, sessionRole, auditCycle],
  );
```

In BOTH fx save paths (Enter key ~:9995 and Apply & Save ~:10049), inside the `.then(...)` success branch right after `toast.success(...)`, add:

```ts
                              void stampFxConfirmed(parsed);
```

- [ ] **Step 4: "Confirm for this week" button on the rate card**

In the fx card's read-only branch (`!usdToPhpEditing`, next to the "Edit rate" button ~:10019), add before/beside it:

```tsx
                  <Button
                    type="button"
                    size="sm"
                    variant="outline"
                    disabled={fxConfirming}
                    className={`h-8 px-3 text-xs font-semibold ${
                      fxConfirmedAt !== null
                        ? 'border-emerald-300 text-emerald-700 dark:border-emerald-700 dark:text-emerald-300'
                        : 'border-blue-300 text-blue-700 dark:border-blue-700 dark:text-blue-300'
                    }`}
                    onClick={() => {
                      setFxConfirming(true);
                      void stampFxConfirmed(usdToPhpRate).finally(() => setFxConfirming(false));
                    }}
                  >
                    {fxConfirming ? (
                      <Loader2 className="h-3 w-3 animate-spin" />
                    ) : fxConfirmedAt !== null ? (
                      <>
                        <CheckCircle2 className="mr-1 h-3 w-3" /> Confirmed this week
                      </>
                    ) : (
                      'Confirm for this week'
                    )}
                  </Button>
```

(Re-clicking re-stamps — idempotent and harmless. The button lives ONLY in the read-only branch; while editing, saving IS confirming.)

- [ ] **Step 5: "No orphanage hours this week" on Step 3**

In the step-3 header banner (after the pay-period chip row, ~:13116), add — shown only when the cycle has no locked-in rows and it isn't a replay:

```tsx
              {!isReplay && orphLocked.length === 0 && (
                <div className="mt-2">
                  <Button
                    type="button"
                    size="sm"
                    variant="outline"
                    disabled={orphanageNoneConfirming}
                    className={`h-8 px-3 text-xs font-semibold ${
                      orphanageNoneConfirmed
                        ? 'border-emerald-300 text-emerald-700 dark:border-emerald-700 dark:text-emerald-300'
                        : 'border-rose-300 text-rose-700 dark:border-rose-700 dark:text-rose-300'
                    }`}
                    onClick={() => {
                      setOrphanageNoneConfirming(true);
                      void savePabSetting(
                        orphanageConfirmedSettingKey(markerWeekStart),
                        JSON.stringify({ none: true, by: sessionEmail ?? null, at: new Date().toISOString() }),
                      )
                        .then(() => {
                          setOrphanageNoneConfirmed(true);
                          toast.success('Confirmed: no orphanage hours this week');
                          void logAudit({
                            user_name: sessionEmail ?? 'anonymous',
                            user_role: sessionRole ?? 'user',
                            action: 'wizard.orphanage_none_confirmed',
                            resource: orphanageConfirmedSettingKey(markerWeekStart),
                            cycle: auditCycle,
                            details: { week_start: markerWeekStart },
                          });
                        })
                        .catch((err: unknown) =>
                          toast.error(
                            `Could not confirm: ${err instanceof Error ? err.message : 'Unknown error'}`,
                          ),
                        )
                        .finally(() => setOrphanageNoneConfirming(false));
                    }}
                  >
                    {orphanageNoneConfirming ? (
                      <Loader2 className="h-3 w-3 animate-spin" />
                    ) : orphanageNoneConfirmed ? (
                      <>
                        <CheckCircle2 className="mr-1 h-3 w-3" /> Confirmed — none this week
                      </>
                    ) : (
                      'No orphanage hours this week'
                    )}
                  </Button>
                </div>
              )}
```

NOTE: `case 3` is a block-scoped render case — `orphLocked` is defined inside it (:13087), so the button must render inside that case's JSX (it does, in the header banner). Real rows outrank the marker by design; the marker is never cleared when rows land later.

- [ ] **Step 6: Typecheck**

Run: `npm run lint`
Expected: clean.

- [ ] **Step 7: Manual check (only if a dev server is already running)**

Step 2: "Confirm for this week" stamps and flips to "Confirmed this week"; saving a rate also stamps (watch the Network tab for the `payroll.wizard.fx_confirmed.*` POST). Step 3 with no rows: the confirm-none button stamps. Readiness tab reflects both rows as done after refresh.

- [ ] **Step 8: Commit**

```bash
git add src/components/PayrollWizard.tsx
git commit -m "feat(wizard): weekly fx-confirmed stamp + Step 3 no-orphanage confirm markers"
```

---

### Task 7: Step-1 CSV warning modal

**Files:**
- Modify: `src/components/PayrollWizard.tsx` (const ~:700, state ~:1723, memo+effect after `hubstaffWeekStart` ~:2155, dialog render next to the approve dialog ~:15847, `weekRangeLabel` import)

**Interfaces:**
- Consumes: `payrollNotesWeekStart` (imported in Task 6), `weekRangeLabel` from `@/lib/payroll/manila-week` (extend that import), `parseDateRangeFromFilename` (already imported), `hubstaffUploads` (:1816), `sourceFilesLoading` (:1886), `currentStep`, `setHubstaffActiveTab` (:1793), the shadcn `Dialog` imports (:230-236), `AlertTriangle` (:41).
- Produces: localStorage key `payroll.wizard.csvWarnIgnored.<weekStart>` = `'1'`.

- [ ] **Step 1: Constant + state + detection**

Next to `COMPARE_RATE_SOURCES_LS_KEY` (:700):

```ts
/** localStorage prefix for the Step-1 "CSV not uploaded" warning's per-week ignore. */
const CSV_WARN_IGNORED_LS_PREFIX = 'payroll.wizard.csvWarnIgnored.';
```

State near the other dialog states (:1702):

```ts
  const [csvWarnOpen, setCsvWarnOpen] = useState(false);
```

After the `hubstaffWeekStart` memo (:2155):

```ts
  /** The calendar pay week (Sun, one week in arrears) and whether ANY upload's
   *  filename covers it. Drives the Step-1 "CSV not uploaded yet" warning. */
  const expectedPayWeekStart = useMemo(() => payrollNotesWeekStart(), []);
  const hasExpectedWeekUpload = useMemo(
    () =>
      hubstaffUploads.some((u) => {
        if (!u.source_file) return false;
        const r = parseDateRangeFromFilename(u.source_file);
        if (!r) return false;
        const d = r.start;
        const iso = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
        return iso === expectedPayWeekStart;
      }),
    [hubstaffUploads, expectedPayWeekStart],
  );

  // Warn once per pay week per browser when the week's CSV is missing. The
  // effect re-runs when uploads land, so the dialog silently disappears the
  // moment the file arrives (Ignore writes the per-week localStorage key).
  useEffect(() => {
    if (sourceFilesLoading) return;
    if (currentStep !== 1) return;
    if (hasExpectedWeekUpload) {
      setCsvWarnOpen(false);
      return;
    }
    try {
      if (localStorage.getItem(`${CSV_WARN_IGNORED_LS_PREFIX}${expectedPayWeekStart}`) === '1') return;
    } catch {
      /* storage unavailable — warn anyway, session-only */
    }
    setCsvWarnOpen(true);
  }, [sourceFilesLoading, currentStep, hasExpectedWeekUpload, expectedPayWeekStart]);
```

- [ ] **Step 2: Extend the manila-week import**

Task 6 added `import { payrollNotesWeekStart } from '@/lib/payroll/manila-week';` — extend it:

```ts
import { payrollNotesWeekStart, weekRangeLabel } from '@/lib/payroll/manila-week';
```

- [ ] **Step 3: Render the dialog (sibling of the approve dialog, ~:15847)**

```tsx
      <Dialog open={csvWarnOpen} onOpenChange={setCsvWarnOpen}>
        <DialogContent className="border-zinc-200 bg-white sm:max-w-md dark:border-zinc-800 dark:bg-zinc-950">
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2 text-zinc-900 dark:text-white">
              <AlertTriangle className="h-5 w-5 shrink-0 text-amber-500" />
              This week&apos;s Hubstaff CSV isn&apos;t uploaded yet
            </DialogTitle>
            <DialogDescription className="text-zinc-600 dark:text-zinc-400">
              The pay week <span className="font-semibold">{weekRangeLabel(expectedPayWeekStart)}</span> has no
              Hubstaff report uploaded. Rates, hours, and every later step run on last week&apos;s file until it lands.
            </DialogDescription>
          </DialogHeader>
          <div className="flex items-start gap-2 rounded-md border border-amber-300 bg-amber-50 px-3 py-2 dark:border-amber-500/40 dark:bg-amber-950/30">
            <AlertTriangle className="mt-0.5 h-3.5 w-3.5 shrink-0 text-amber-600 dark:text-amber-400" />
            <p className="text-[11px] leading-snug text-amber-700 dark:text-amber-300">
              Newest upload: {newestSourceFile ? <span className="font-mono">{newestSourceFile}</span> : 'none yet'}.
              The weekly auto-sync normally lands it Sunday afternoon — upload manually if it hasn&apos;t.
            </p>
          </div>
          <div className="flex justify-end gap-2 pt-2">
            <Button
              type="button"
              variant="outline"
              className="border-zinc-200 dark:border-zinc-800"
              onClick={() => {
                try {
                  localStorage.setItem(`${CSV_WARN_IGNORED_LS_PREFIX}${expectedPayWeekStart}`, '1');
                } catch {
                  /* ignore */
                }
                setCsvWarnOpen(false);
              }}
            >
              Ignore for this week
            </Button>
            <Button
              type="button"
              className="gap-2 bg-indigo-600 text-white hover:bg-indigo-700"
              onClick={() => {
                setCsvWarnOpen(false);
                setHubstaffActiveTab('upload');
              }}
            >
              <Upload className="h-4 w-4" />
              Upload now
            </Button>
          </div>
        </DialogContent>
      </Dialog>
```

(`Upload` is already in the lucide import at :7. Plain `onOpenChange={setCsvWarnOpen}` means Esc/backdrop close WITHOUT writing the ignore key — it reappears on the next mount, matching "ignore is an explicit choice".)

- [ ] **Step 4: Typecheck**

Run: `npm run lint`
Expected: clean.

- [ ] **Step 5: Manual check (only if a dev server is already running)**

With this week's CSV present the modal must NOT appear. To see it, temporarily flip the localStorage key away / use devtools to simulate: clear `payroll.wizard.csvWarnIgnored.*`, and confirm behavior by selecting a week with no upload is NOT possible client-side — so verify the logic path: `hasExpectedWeekUpload === true` → no modal (normal state this week). The blocked state occurs naturally next Sunday if the cron fails.

- [ ] **Step 6: Commit**

```bash
git add src/components/PayrollWizard.tsx
git commit -m "feat(wizard): step-1 warning modal when the pay week's Hubstaff CSV is missing"
```

---

### Task 8: Docs + full suite + final verify

**Files:**
- Modify: `docs/features/payroll-readiness.md`

**Interfaces:**
- Consumes: everything shipped above.
- Produces: documentation only.

- [ ] **Step 1: Update the feature doc**

In `docs/features/payroll-readiness.md`:
- Key-files table (~:15): add `src/lib/payroll/wizard-setup-steps.ts` (pure checklist derivation + marker keys) and `src/lib/payroll/readiness-week-scope.ts` (week-scoping predicates).
- Week resolution section (~:34): note the checklist's expected-week rule (anchors to `payrollNotesWeekStart()` on the current upload; an explicitly selected older file re-anchors to that file's week) and the `mismatch` flag.
- The four dimensions section (~:51): add a "Wizard setup checklist" subsection — the 7 rows, their done/attention/blocked/pending semantics, the two app_settings markers, and that it never affects the score.
- Score rules section (~:115): add the week-scoped roster rule — future hires (Start Date after week end) leave the bank list, both denominators, and pipeline exception rows; hours-in-file always wins; unparseable start dates stay.

- [ ] **Step 2: Run the full test suite**

Run: `npm test`
Expected: all pass, including the two new test files and the pre-existing `readiness-score.test.ts` (11 tests, untouched).

- [ ] **Step 3: Typecheck + final read-only verify**

```powershell
npm run lint
$env:TSX_TSCONFIG_PATH="tsconfig.readiness-verify.json"; node --import tsx scripts/verify-readiness.mts
```

Expected: lint clean; verify prints the `Wizard setup: N/7` block with sane statuses.

- [ ] **Step 4: Commit**

```bash
git add docs/features/payroll-readiness.md
git commit -m "docs(readiness): wizard-setup checklist + week-scoped roster rules"
```
