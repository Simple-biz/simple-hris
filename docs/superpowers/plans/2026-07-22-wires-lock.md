# WIRES Lock Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A WIRES employee (Bank Preferred not `hurupay`/`higlobe`, including null) can never be switched to Hurupay or HiGlobe — across every dashboard's bank-change surface.

**Architecture:** One pure guard helper in the shared processor registry, imported by (a) the two server routes that write `employee_ids.bank_preferred` — as fail-closed 400/error backstops — and (b) the two UI surfaces that offer the pick — to hide/disable the impossible options. No routing coercion, no DB migration. WIRES = residual (anything not exactly `hurupay` or `higlobe`, incl. `null`).

**Tech Stack:** Next.js (App Router) API routes, React (client components), TypeScript. Tests: Node built-in test runner via `node --import tsx --test`, `node:assert/strict`, colocated `*.test.ts`.

## Global Constraints

- WIRES is the residual: `isWiresPreferred(v) === (v !== 'hurupay' && v !== 'higlobe')`. `null`, `undefined`, `''`, `'wires'`, `'x1153'`, and any legacy/unknown value all count as WIRES.
- Forbidden transition (the ONLY thing blocked): `current` is WIRES AND `next` is `hurupay` or `higlobe`. Everything else is allowed (`hurupay↔higlobe`, `→wires`, `wires→wires`).
- Source of truth = `employee_ids.bank_preferred` ONLY. Do NOT touch the Disbursement picker (`preferred_processor`), the routing resolvers (`mock-queue.ts`, `pay-schedule.ts`, `dispatch-export-csv.ts`), or the contractor model. No retroactive changes to seeded data.
- Enforcement style: UI hides the impossible options; server is the real guard (fail-closed).
- Lint/typecheck command for this repo is `npm run lint` (it runs `tsc --noEmit`). Tests: `npm test`.
- Ship policy (per project convention): after verification, push directly to `main`; no PR.

---

## File Structure

- `src/lib/employee-payment-processors.ts` — **Modify.** Add the two exported pure functions `isWiresPreferred` and `isBankPreferredTransitionAllowed`. This is the one authoritative home; everything imports from here.
- `src/lib/employee-payment-processors.test.ts` — **Create.** Unit tests for the two new functions (the full transition matrix).
- `app/api/update-employee-ids/route.ts` — **Modify.** In `interceptBankPreferred`, reject a forbidden transition with a thrown error the caller turns into a 400 before any request row is filed.
- `app/api/bank-preferred-requests/[id]/route.ts` — **Modify.** In the approve branch, re-check against the live stored value before writing; block with an error if forbidden.
- `src/components/employee/EmployeeProfile.tsx` — **Modify.** Filter the Bank Preferred dropdown options to WIRES-only when the current stored value is WIRES.
- `src/components/payroll/BankPreferredApprovals.tsx` — **Modify.** Disable Approve (with a reason) on any pending row whose `from_value`→`to_value` is a forbidden transition.

---

### Task 1: The shared guard helper (pure functions + tests)

**Files:**
- Modify: `src/lib/employee-payment-processors.ts` (append after `isProcessorId`, around line 42)
- Test: `src/lib/employee-payment-processors.test.ts` (create)

**Interfaces:**
- Consumes: `ProcessorId` (existing type in the same file).
- Produces:
  - `isWiresPreferred(value: string | null | undefined): boolean`
  - `isBankPreferredTransitionAllowed(current: string | null | undefined, next: string | null | undefined): boolean`

- [ ] **Step 1: Write the failing test**

Create `src/lib/employee-payment-processors.test.ts`:

```ts
import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  isWiresPreferred,
  isBankPreferredTransitionAllowed,
} from './employee-payment-processors';

// WIRES is the residual: anything that isn't exactly hurupay/higlobe.
test('isWiresPreferred: hurupay and higlobe are NOT wires', () => {
  assert.equal(isWiresPreferred('hurupay'), false);
  assert.equal(isWiresPreferred('higlobe'), false);
});

test('isWiresPreferred: wires/x1153/legacy/null/empty all count as wires', () => {
  assert.equal(isWiresPreferred('wires'), true);
  assert.equal(isWiresPreferred('x1153'), true);
  assert.equal(isWiresPreferred('wise'), true);
  assert.equal(isWiresPreferred('jeeves'), true);
  assert.equal(isWiresPreferred('bpi'), true);
  assert.equal(isWiresPreferred(null), true);
  assert.equal(isWiresPreferred(undefined), true);
  assert.equal(isWiresPreferred(''), true);
});

// The ONLY forbidden transition: a WIRES employee → hurupay/higlobe.
test('transition: wires -> hurupay/higlobe is forbidden', () => {
  assert.equal(isBankPreferredTransitionAllowed('wires', 'hurupay'), false);
  assert.equal(isBankPreferredTransitionAllowed('wires', 'higlobe'), false);
});

test('transition: null/legacy (treated as wires) -> hurupay/higlobe is forbidden', () => {
  assert.equal(isBankPreferredTransitionAllowed(null, 'hurupay'), false);
  assert.equal(isBankPreferredTransitionAllowed(undefined, 'higlobe'), false);
  assert.equal(isBankPreferredTransitionAllowed('x1153', 'hurupay'), false);
});

test('transition: wires -> wires and null -> wires are allowed', () => {
  assert.equal(isBankPreferredTransitionAllowed('wires', 'wires'), true);
  assert.equal(isBankPreferredTransitionAllowed(null, 'wires'), true);
  assert.equal(isBankPreferredTransitionAllowed('x1153', 'wires'), true);
});

test('transition: hurupay/higlobe can move freely (incl. to wires)', () => {
  assert.equal(isBankPreferredTransitionAllowed('hurupay', 'higlobe'), true);
  assert.equal(isBankPreferredTransitionAllowed('higlobe', 'hurupay'), true);
  assert.equal(isBankPreferredTransitionAllowed('hurupay', 'wires'), true);
  assert.equal(isBankPreferredTransitionAllowed('higlobe', 'wires'), true);
  assert.equal(isBankPreferredTransitionAllowed('hurupay', 'hurupay'), true);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm test`
Expected: FAIL — the two new imports don't exist yet (`SyntaxError`/`undefined is not a function`).

- [ ] **Step 3: Write minimal implementation**

In `src/lib/employee-payment-processors.ts`, add immediately after the `isProcessorId` function (after line 42):

```ts
/**
 * "WIRES" is the residual send-from rail: anything that is NOT explicitly
 * `hurupay` or `higlobe` is treated as WIRES. That deliberately includes
 * `wires`, `x1153`, retired processors, legacy free-text, and null/unset — a
 * WIRES recipient is paid by bank wire and physically cannot receive via the
 * Hurupay/HiGlobe wallets.
 */
export function isWiresPreferred(value: string | null | undefined): boolean {
  const v = (value ?? '').trim().toLowerCase();
  return v !== 'hurupay' && v !== 'higlobe';
}

/**
 * The only forbidden Bank Preferred transition: a WIRES employee cannot be
 * switched to `hurupay` or `higlobe` (impossible to pay a wire recipient via a
 * wallet). Everything else is allowed — hurupay↔higlobe, and moving TO wires.
 * `current` is the employee's stored Bank Preferred; `next` is the requested one.
 */
export function isBankPreferredTransitionAllowed(
  current: string | null | undefined,
  next: string | null | undefined,
): boolean {
  if (isWiresPreferred(current) && !isWiresPreferred(next)) return false;
  return true;
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npm test`
Expected: PASS — all cases in `employee-payment-processors.test.ts` green, no other test regressed.

- [ ] **Step 5: Commit**

```bash
git add src/lib/employee-payment-processors.ts src/lib/employee-payment-processors.test.ts
git commit -m "feat(wires-lock): add isWiresPreferred + transition guard helper

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

### Task 2: Server backstop — reject the forbidden transition in the update-employee-ids intercept

**Files:**
- Modify: `app/api/update-employee-ids/route.ts` — `interceptBankPreferred` (function starts ~line 139; the change is inside it after the `current`/`target` are computed, ~line 165)

**Interfaces:**
- Consumes: `isBankPreferredTransitionAllowed` from Task 1.
- Produces: no new exports. Behavior change only — a forbidden change throws before any request row is filed. The caller (the POST handler `try/catch`) already converts thrown errors to a 500; we make this specific case a **400** instead (see Step 3).

- [ ] **Step 1: Add the import**

At the top of `app/api/update-employee-ids/route.ts`, add to the imports (near the other `@/lib/...` imports):

```ts
import { isBankPreferredTransitionAllowed } from "@/lib/employee-payment-processors";
```

- [ ] **Step 2: Change `interceptBankPreferred` to signal a forbidden transition**

`interceptBankPreferred` currently returns `Promise<{ requested: boolean }>`. Extend the return type so the caller can distinguish a policy rejection from a filed request. Change the signature's return type to:

```ts
): Promise<{ requested: boolean; forbidden?: boolean }> {
```

Then, inside the function, immediately AFTER the existing no-op guards (after the `if (!target) return { requested: false };` line, ~line 165) and BEFORE the `createBankPreferredRequest` call, insert:

```ts
  // WIRES lock: a WIRES employee (anything not hurupay/higlobe, incl. null) can
  // never be switched to hurupay/higlobe. Reject BEFORE filing a request so an
  // impossible change never enters the approval queue.
  if (!isBankPreferredTransitionAllowed(current, target)) {
    return { requested: false, forbidden: true };
  }
```

- [ ] **Step 3: Turn a forbidden result into a 400 at the call site**

At the call site (~line 446, `const bankPreferred = await interceptBankPreferred({ ... })`), immediately AFTER that `await` and BEFORE the `if (Object.keys(update).length === 0)` block, insert:

```ts
    if (bankPreferred.forbidden) {
      return NextResponse.json(
        {
          error:
            "This employee is set to WIRES and can only be paid via wires — Hurupay/HiGlobe is not possible.",
        },
        { status: 400 },
      );
    }
```

Note: because `interceptBankPreferred` mutates `update` by `delete update.bank_preferred` at its top, the forbidden `bank_preferred` value has already been stripped from the write — so returning here does not partially write it. Any OTHER fields in the same request are NOT saved when we 400; that is intentional (the caller should resubmit a valid payload).

- [ ] **Step 4: Typecheck**

Run: `npm run lint`
Expected: PASS (no TS errors). This is the verification for this task — the route has no unit-test harness in this repo (it needs a live Supabase client), matching the codebase's existing pattern of unit-testing pure logic (Task 1) and typechecking the wiring.

- [ ] **Step 5: Commit**

```bash
git add app/api/update-employee-ids/route.ts
git commit -m "feat(wires-lock): block wires->hurupay/higlobe in bank-preferred intercept (400)

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

### Task 3: Server backstop — re-check at approval time

**Files:**
- Modify: `app/api/bank-preferred-requests/[id]/route.ts` — the `if (status === 'approved')` branch (starts ~line 65)

**Interfaces:**
- Consumes: `isBankPreferredTransitionAllowed` from Task 1.
- Produces: no new exports. On approve of a forbidden transition, returns HTTP 400 and does NOT write `employee_ids.bank_preferred` or mark the request approved (it stays `pending`, so accounting can deny it).

- [ ] **Step 1: Add the import**

Add to the imports at the top of `app/api/bank-preferred-requests/[id]/route.ts` (the file already imports `bankPreferredLabelForProcessor` and `ProcessorId` from the same module — extend that import):

```ts
import {
  bankPreferredLabelForProcessor,
  isBankPreferredTransitionAllowed,
} from '@/lib/employee-payment-processors';
```

(Keep the existing `import type { ProcessorId } from '@/lib/employee-payment-processors';` line as-is.)

- [ ] **Step 2: Re-check against the LIVE stored value inside the approve branch**

Inside `if (status === 'approved') {`, AFTER `const workEmail = row.work_email.trim().toLowerCase();` (~line 66) and BEFORE the `employee_ids` update, insert a live read + guard:

```ts
      // WIRES lock re-check: verify against the CURRENT stored value, not the
      // request's from_value (it may have changed since the request was filed).
      // A WIRES employee can never be approved onto hurupay/higlobe.
      const { data: liveRows } = await supabase
        .from('employee_ids')
        .select('bank_preferred')
        .ilike('work_email', workEmail)
        .limit(1);
      const liveCurrent =
        Array.isArray(liveRows) && liveRows[0] && typeof liveRows[0].bank_preferred === 'string'
          ? (liveRows[0].bank_preferred as string)
          : null;
      if (!isBankPreferredTransitionAllowed(liveCurrent, row.to_value)) {
        return NextResponse.json(
          {
            error:
              'This employee is set to WIRES and can only be paid via wires — approving Hurupay/HiGlobe is not possible. Deny this request instead.',
          },
          { status: 400 },
        );
      }
```

- [ ] **Step 3: Typecheck**

Run: `npm run lint`
Expected: PASS.

- [ ] **Step 4: Commit**

```bash
git add "app/api/bank-preferred-requests/[id]/route.ts"
git commit -m "feat(wires-lock): re-check wires lock at approval time (block approve)

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

### Task 4: UI — hide the impossible options in the Employee Profile dropdown

**Files:**
- Modify: `src/components/employee/EmployeeProfile.tsx` — the Bank Preferred `SmoothSelect` options (~line 1901-1909); imports (~line 74/77)

**Interfaces:**
- Consumes: `isWiresPreferred` from Task 1; existing `bankPreferred` state (the employee's CURRENT stored value) and `BANK_PREFERRED_OPTIONS`.
- Produces: nothing new.

- [ ] **Step 1: Add the import**

The file already imports from `@/lib/employee-payment-processors` (`PROCESSOR_OPTIONS`, `BANK_PREFERRED_OPTIONS`, `bankPreferredLabelForProcessor`, `processorForBankPreferredLabel`). Add `isWiresPreferred` to that existing import statement.

- [ ] **Step 2: Compute the allowed option list and use it**

The `bankPreferred` state holds the employee's current stored Bank Preferred value. When that is WIRES, only the wires option may be offered. Replace the `options={[ ... ]}` array on the Bank Preferred `SmoothSelect` (~line 1901-1909) with a list filtered when the current value is WIRES:

```tsx
                        options={[
                          ...(bankPreferredLabelForProcessor(bankPreferred)
                            ? []
                            : [{ value: '', label: 'Select…' }]),
                          ...BANK_PREFERRED_OPTIONS
                            // WIRES lock: a WIRES employee can only stay WIRES,
                            // so never offer hurupay/higlobe to them.
                            .filter((o) =>
                              isWiresPreferred(bankPreferred) ? isWiresPreferred(o.id) : true,
                            )
                            .map((o) => ({
                              value: o.label,
                              label: o.label,
                            })),
                        ]}
```

Note: `BANK_PREFERRED_OPTIONS` already excludes `hurupay`/`higlobe` via `isWiresPreferred(o.id)` for wires employees — the remaining offered labels are `x1153` (wires), plus retired `Jeeves`/`Wise` which are themselves WIRES-residual and harmless to leave (they map to non-hurupay/higlobe ids and the server allows wires→those). This matches "only WIRES for a WIRES employee" because none of the offered options is hurupay/higlobe.

- [ ] **Step 3: Add the explanatory hint for WIRES employees**

In the description paragraph (~line 1887-1891), when the employee is WIRES and has no pending change, make the copy explain the lock. Change the non-pending branch of that ternary so a WIRES employee sees the lock reason. Replace:

```tsx
                            : 'The bank Payment Dispatch routes your salary through. Changes need Accounting approval before they take effect. Independent of your disbursement channel above.'}
```

with:

```tsx
                            : isWiresPreferred(bankPreferred)
                              ? 'You are set to WIRES — salary is sent by bank wire, so Hurupay/HiGlobe are not available. Changes need Accounting approval.'
                              : 'The bank Payment Dispatch routes your salary through. Changes need Accounting approval before they take effect. Independent of your disbursement channel above.'}
```

- [ ] **Step 4: Typecheck**

Run: `npm run lint`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/components/employee/EmployeeProfile.tsx
git commit -m "feat(wires-lock): hide hurupay/higlobe in Bank Preferred dropdown for wires employees

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

### Task 5: UI — disable Approve for forbidden transitions in the Accounting approvals queue

**Files:**
- Modify: `src/components/payroll/BankPreferredApprovals.tsx` — imports (~line 8-11) and the row render (~line 135-183)

**Interfaces:**
- Consumes: `isBankPreferredTransitionAllowed` from Task 1; existing `row.from_value` / `row.to_value`.
- Produces: nothing new.

- [ ] **Step 1: Add the import**

The file already imports `bankPreferredLabelForProcessor` and `type ProcessorId` from `@/lib/employee-payment-processors`. Add `isBankPreferredTransitionAllowed` to that import:

```ts
import {
  bankPreferredLabelForProcessor,
  isBankPreferredTransitionAllowed,
  type ProcessorId,
} from '@/lib/employee-payment-processors';
```

- [ ] **Step 2: Compute per-row lock and disable Approve**

Inside the `rows.map((row) => { ... })` callback (~line 135), after `const acting = actingId === row.id;`, add:

```tsx
            const wiresLocked = !isBankPreferredTransitionAllowed(row.from_value, row.to_value);
```

Then on the Approve `<Button>` (~line 172-181), change `disabled={acting}` to `disabled={acting || wiresLocked}` and add a `title` when locked:

```tsx
                  <Button
                    type="button"
                    size="sm"
                    className="h-8 gap-1.5 rounded-lg bg-emerald-600 text-[12px] text-white hover:bg-emerald-700 disabled:cursor-not-allowed disabled:opacity-50 dark:bg-emerald-500 dark:hover:bg-emerald-400"
                    disabled={acting || wiresLocked}
                    title={
                      wiresLocked
                        ? 'This employee is set to WIRES and cannot be paid via Hurupay/HiGlobe. Deny this request.'
                        : undefined
                    }
                    onClick={() => void decide(row, 'approved')}
                  >
```

- [ ] **Step 3: Show the lock reason on the row**

When `wiresLocked`, render a small note so accounting understands why Approve is disabled. Immediately after the `<div className="mt-1 flex items-center gap-1 ...">Requested {timeAgo(...)}</div>` block (~line 155-158, inside the `min-w-0` container), add:

```tsx
                  {wiresLocked && (
                    <div className="mt-1 text-[11px] font-medium text-rose-600 dark:text-rose-400">
                      WIRES employee — Hurupay/HiGlobe not possible. Deny this request.
                    </div>
                  )}
```

- [ ] **Step 4: Typecheck**

Run: `npm run lint`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/components/payroll/BankPreferredApprovals.tsx
git commit -m "feat(wires-lock): disable Approve for wires->hurupay/higlobe requests

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

### Task 6: Full verification + ship

**Files:** none (verification only).

- [ ] **Step 1: Run the whole test suite**

Run: `npm test`
Expected: PASS — all tests including the new `employee-payment-processors.test.ts`.

- [ ] **Step 2: Typecheck the whole project**

Run: `npm run lint`
Expected: PASS — `tsc --noEmit` clean.

- [ ] **Step 3: Sanity-check the diff**

Run: `git diff --stat HEAD~5..HEAD`
Expected: exactly these 6 source/test files touched across Tasks 1–5:
`src/lib/employee-payment-processors.ts`, `src/lib/employee-payment-processors.test.ts`,
`app/api/update-employee-ids/route.ts`, `app/api/bank-preferred-requests/[id]/route.ts`,
`src/components/employee/EmployeeProfile.tsx`, `src/components/payroll/BankPreferredApprovals.tsx`.
No stray edits to routing resolvers (`mock-queue.ts`, `pay-schedule.ts`, `dispatch-export-csv.ts`), the Disbursement picker, the People tab, the external bank-update page, or contractor code.

- [ ] **Step 4: Push to main (project ship policy — no PR)**

```bash
git push origin main
```

Expected: push succeeds; Vercel deploys production. Tell Kane to hard-refresh so the dropdown/approvals changes load.

---

## Notes for the implementer

- **Do NOT** add a DB migration. The value space is already CHECK-constrained; this is a cross-value transition rule enforced in app code, per the spec's "no migration" decision.
- **Do NOT** modify the routing resolvers (`mock-queue.ts`, `pay-schedule.ts`, `dispatch-export-csv.ts`), the Disbursement picker (`PreferredPaymentMethodRadios` / `preferred_processor`), the People tab banking route, the external `update-bank-info` page, or the contractor model. The lock is scoped to `bank_preferred` writes only.
- The `interceptBankPreferred` guard (Task 2) is the primary gate — it prevents a forbidden request from ever being filed. Task 3 (approval re-check) and Task 5 (UI disable) are backstops for pre-existing pending rows or races. Both are still required.
- `isWiresPreferred` lowercases/trims defensively; stored values are already canonical lowercase ids, but legacy free-text may not be.
```
