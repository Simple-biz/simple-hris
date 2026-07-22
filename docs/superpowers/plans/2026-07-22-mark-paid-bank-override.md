# Mark Paid Bank-Details Override Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A pencil icon in the Mark Paid modal's Recipient section that lets Accounting save the corrected bank details back to the employee's profile (`employee_ids`), overriding what the employee entered in their dashboard.

**Architecture:** A pure column-mapping lib (unit-tested) + a dedicated accounting-only API route (`POST /api/payment-dispatch/bank-override`) that bypasses the payroll dispatch lock, + an "override mode" UI in `MarkPaidDialog.tsx`. Routing (`employee_ids.bank_preferred`) is never touched — receiving-end details only.

**Tech Stack:** Next.js 16 App Router API route, Supabase service-role writes, React 19 client dialog, `node:test` + `tsx` for unit tests.

**Spec:** `docs/superpowers/specs/2026-07-22-mark-paid-bank-override-design.md`

## Global Constraints

- NEVER write `employee_ids.bank_preferred` or `preferred_processor` from this feature — receiving-end detail columns only.
- No dispatch-lock check in the new route — it is the sanctioned mid-processing correction path.
- All audit/history/notification writes are best-effort: they must NEVER fail the save (wrap in `.catch(() => undefined)` / try-catch).
- The employee notification type is `people.banking.overridden`; its CHECK migration must restate the FULL existing allowed list (restating a subset breaks every other notification INSERT).
- Masked values only in history rows — reuse `maskFieldValue`; never store a full account number in `bank_update_history`.
- Test command: `npm test` runs `node --import tsx --test "src/**/*.test.ts"`. Single file: `node --import tsx --test src/lib/payroll/bank-override-mapping.test.ts`.
- Typecheck before every commit: `npx tsc --noEmit` (repo convention).
- Commits end with `Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>`.
- Ship direct to `main` (no PR) — but push ONLY in the final task after typecheck + tests pass.

---

### Task 1: Column-mapping lib (pure, TDD)

**Files:**
- Create: `src/lib/payroll/bank-override-mapping.ts`
- Test: `src/lib/payroll/bank-override-mapping.test.ts`

**Interfaces:**
- Consumes: nothing (pure function, no imports beyond types it defines).
- Produces: `mapBankOverrideToColumns(opts: { target: 'bank' | 'wallet'; processor: string; preferredBankSlot: 'primary' | 'alternative'; values: BankOverrideValues }): { columns: Record<string, string | null> } | { error: string }` and `interface BankOverrideValues { preferredBank?: string | null; accountNumber: string; accountHolder?: string | null; swiftCode?: string | null }`. Task 2's route calls this exact signature.

- [ ] **Step 1: Write the failing test**

Create `src/lib/payroll/bank-override-mapping.test.ts`:

```ts
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { mapBankOverrideToColumns } from './bank-override-mapping';

/**
 * The Mark Paid modal's profile override maps the four semantic recipient
 * fields back to employee_ids columns. `target` mirrors what the modal
 * displayed (resolveMarkPaidDefaults): 'bank' = wire details (wires / jeeves /
 * wise-routed-with-own-bank), 'wallet' = processor wallet. The SERVER owns the
 * slot decision (preferred_bank_slot) — primary vs alternative columns.
 */

test('bank target + primary slot writes the primary wire columns', () => {
  const r = mapBankOverrideToColumns({
    target: 'bank',
    processor: 'wires',
    preferredBankSlot: 'primary',
    values: {
      preferredBank: 'BPI',
      accountNumber: '0098-2231-7710',
      accountHolder: 'Juan Dela Cruz',
      swiftCode: 'BOPIPHMM',
    },
  });
  assert.deepEqual(r, {
    columns: {
      bank_name: 'BPI',
      account_holder_name: 'Juan Dela Cruz',
      account_number: '0098-2231-7710',
      swift_code: 'BOPIPHMM',
    },
  });
});

test('bank target + alternative slot writes the alt_* columns (swift → alt_routing_number)', () => {
  const r = mapBankOverrideToColumns({
    target: 'bank',
    processor: 'jeeves',
    preferredBankSlot: 'alternative',
    values: {
      preferredBank: 'UnionBank',
      accountNumber: '111-222-333',
      accountHolder: 'Maria Clara',
      swiftCode: 'UBPHPHMM',
    },
  });
  assert.deepEqual(r, {
    columns: {
      alt_bank_name: 'UnionBank',
      alt_account_holder_name: 'Maria Clara',
      alt_account_number: '111-222-333',
      alt_routing_number: 'UBPHPHMM',
    },
  });
});

test('bank target: blank optional fields clear to null, values are trimmed', () => {
  const r = mapBankOverrideToColumns({
    target: 'bank',
    processor: 'wires',
    preferredBankSlot: 'primary',
    values: {
      preferredBank: '  BDO  ',
      accountNumber: ' 555 ',
      accountHolder: '',
      swiftCode: '   ',
    },
  });
  assert.deepEqual(r, {
    columns: {
      bank_name: 'BDO',
      account_holder_name: null,
      account_number: '555',
      swift_code: null,
    },
  });
});

test('empty account number is an error regardless of target', () => {
  const r = mapBankOverrideToColumns({
    target: 'bank',
    processor: 'wires',
    preferredBankSlot: 'primary',
    values: { accountNumber: '   ' },
  });
  assert.deepEqual(r, { error: 'Account / wallet ID is required' });
});

test('wallet + hurupay writes only hurupay_email', () => {
  const r = mapBankOverrideToColumns({
    target: 'wallet',
    processor: 'hurupay',
    preferredBankSlot: 'primary',
    values: { preferredBank: 'Hurupay', accountNumber: 'person@mail.com', accountHolder: 'Ignored Co' },
  });
  assert.deepEqual(r, { columns: { hurupay_email: 'person@mail.com' } });
});

test('wallet + wepay writes only wepay_email', () => {
  const r = mapBankOverrideToColumns({
    target: 'wallet',
    processor: 'wepay',
    preferredBankSlot: 'primary',
    values: { accountNumber: 'w@mail.com' },
  });
  assert.deepEqual(r, { columns: { wepay_email: 'w@mail.com' } });
});

test('wallet + higlobe writes higlobe_email + higlobe_account_name', () => {
  const r = mapBankOverrideToColumns({
    target: 'wallet',
    processor: 'higlobe',
    preferredBankSlot: 'primary',
    values: { accountNumber: 'h@mail.com', accountHolder: 'Juan Dela Cruz' },
  });
  assert.deepEqual(r, {
    columns: { higlobe_email: 'h@mail.com', higlobe_account_name: 'Juan Dela Cruz' },
  });
});

test('wallet + wise writes wise_email + account_holder_name', () => {
  const r = mapBankOverrideToColumns({
    target: 'wallet',
    processor: 'wise',
    preferredBankSlot: 'primary',
    values: { accountNumber: 'wise@mail.com', accountHolder: 'Maria Clara' },
  });
  assert.deepEqual(r, {
    columns: { wise_email: 'wise@mail.com', account_holder_name: 'Maria Clara' },
  });
});

test('wallet target ignores the slot — hurupay maps identically on alternative', () => {
  const r = mapBankOverrideToColumns({
    target: 'wallet',
    processor: 'hurupay',
    preferredBankSlot: 'alternative',
    values: { accountNumber: 'person@mail.com' },
  });
  assert.deepEqual(r, { columns: { hurupay_email: 'person@mail.com' } });
});

test('wallet with a non-wallet processor is an error', () => {
  const r = mapBankOverrideToColumns({
    target: 'wallet',
    processor: 'wires',
    preferredBankSlot: 'primary',
    values: { accountNumber: '555' },
  });
  assert.deepEqual(r, { error: 'No wallet mapping for processor "wires"' });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --import tsx --test src/lib/payroll/bank-override-mapping.test.ts`
Expected: FAIL — `Cannot find module './bank-override-mapping'`.

- [ ] **Step 3: Write the implementation**

Create `src/lib/payroll/bank-override-mapping.ts`:

```ts
/**
 * Maps the Mark Paid modal's profile-override values to employee_ids columns.
 *
 * `target` mirrors what the modal displayed (see resolveMarkPaidDefaults):
 * 'bank' = wire details (wires / jeeves / wise-routed employee whose payout is
 * their own bank), 'wallet' = the processor's wallet fields. The caller (the
 * bank-override route) resolves `preferredBankSlot` from the employee's row so
 * the write lands on the ACTIVE slot — primary or alternative — matching what
 * the dispatch queue displayed.
 *
 * Trimmed-empty optional values map to null (an explicit clear — the fields
 * are prefilled from the current values, so an emptied field is deliberate).
 * Routing columns (bank_preferred / preferred_processor) are NEVER produced.
 */

export type BankOverrideTarget = 'bank' | 'wallet';

export interface BankOverrideValues {
  preferredBank?: string | null;
  accountNumber: string;
  accountHolder?: string | null;
  swiftCode?: string | null;
}

const clean = (v: string | null | undefined): string | null => {
  const t = (v ?? '').trim();
  return t === '' ? null : t;
};

export function mapBankOverrideToColumns(opts: {
  target: BankOverrideTarget;
  processor: string;
  preferredBankSlot: 'primary' | 'alternative';
  values: BankOverrideValues;
}): { columns: Record<string, string | null> } | { error: string } {
  const { target, processor, preferredBankSlot, values } = opts;
  const accountNumber = clean(values.accountNumber);
  if (!accountNumber) return { error: 'Account / wallet ID is required' };

  if (target === 'bank') {
    if (preferredBankSlot === 'alternative') {
      return {
        columns: {
          alt_bank_name: clean(values.preferredBank),
          alt_account_holder_name: clean(values.accountHolder),
          alt_account_number: accountNumber,
          alt_routing_number: clean(values.swiftCode),
        },
      };
    }
    return {
      columns: {
        bank_name: clean(values.preferredBank),
        account_holder_name: clean(values.accountHolder),
        account_number: accountNumber,
        swift_code: clean(values.swiftCode),
      },
    };
  }

  switch (processor) {
    case 'hurupay':
      return { columns: { hurupay_email: accountNumber } };
    case 'wepay':
      return { columns: { wepay_email: accountNumber } };
    case 'higlobe':
      return {
        columns: { higlobe_email: accountNumber, higlobe_account_name: clean(values.accountHolder) },
      };
    case 'wise':
      return {
        columns: { wise_email: accountNumber, account_holder_name: clean(values.accountHolder) },
      };
    default:
      return { error: `No wallet mapping for processor "${processor}"` };
  }
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `node --import tsx --test src/lib/payroll/bank-override-mapping.test.ts`
Expected: PASS — 10 tests, 0 failures.

- [ ] **Step 5: Typecheck and commit**

```bash
npx tsc --noEmit
git add src/lib/payroll/bank-override-mapping.ts src/lib/payroll/bank-override-mapping.test.ts
git commit -m "feat(mark-paid): column mapping for bank-details profile override

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

### Task 2: API route + notification-type migration

**Files:**
- Create: `app/api/payment-dispatch/bank-override/route.ts`
- Create: `references/sql/alter/2026-07-22_employee_notifications_add_bank_override_type.sql`

**Interfaces:**
- Consumes: `mapBankOverrideToColumns`, `BankOverrideValues` from `@/lib/payroll/bank-override-mapping` (Task 1); existing helpers `requireFeatureEdit` (`@/lib/auth/authorize-feature`), `deniedResponse` (`@/lib/auth/authorize-email`), `getSessionActor` (`@/lib/auth/session-actor`), `insertAuditLog` (`@/lib/supabase/audit-log`), `insertBankUpdateHistory` (`@/lib/supabase/bank-update-history`), `maskFieldValue` (`@/lib/bank-update/mask-field`), `pulseBankChanges` (`@/lib/supabase/app-settings`), `createSupabaseServiceRoleClient` (`@/lib/supabase/server`).
- Produces: `POST /api/payment-dispatch/bank-override` accepting JSON `{ work_email: string, target: 'bank' | 'wallet', processor: string, display_name?: string, values: BankOverrideValues }`, responding `{ success: true, created: boolean }` or `{ error: string }`. Task 3's dialog calls this endpoint.

- [ ] **Step 1: Write the migration SQL**

Create `references/sql/alter/2026-07-22_employee_notifications_add_bank_override_type.sql`:

```sql
-- Widen employee_notifications.type CHECK to allow the Mark Paid bank-override
-- notification type: `people.banking.overridden`.
--
-- When Accounting overrides an employee's bank details from the Payment
-- Dispatch Mark Paid modal (app/api/payment-dispatch/bank-override/route.ts),
-- the employee gets a `people.banking.overridden` notification. The table's
-- CHECK must list it or the INSERT is silently rejected by the route's
-- best-effort try/catch.
--
-- ADD CONSTRAINT re-validates existing rows, so we restate the FULL
-- authoritative allowed set — the list from
-- 2026-07-22_employee_notifications_add_bank_preferred_type.sql (the latest
-- full list) PLUS the new people.banking.overridden. Restating a SUBSET would
-- silently break every other notification type's INSERT, so the whole list is
-- kept here verbatim. Run once in the Supabase SQL editor. Idempotent.

ALTER TABLE public.employee_notifications
  DROP CONSTRAINT IF EXISTS employee_notifications_type_check;

ALTER TABLE public.employee_notifications
  ADD CONSTRAINT employee_notifications_type_check
  CHECK (type IN (
    'rate.change',
    'promotion',
    'dispute.approved',
    'dispute.denied',
    'dispute.revoked',
    'onboarding.submitted',
    'time_adjustment.approved',
    'time_adjustment.denied',
    'transfer.requested',
    'transfer.approved',
    'transfer.rejected',
    'transfer.release_requested',
    'transfer.released',
    'transfer.declined',
    'transfer.applied',
    'payroll.processing_started',
    'payroll.processing_stopped',
    'payroll.paid',
    'payroll.available',
    'special_transfer.recorded',
    'qc.scores_submitted',
    'qc.scores_returned',
    'people.banking.self_updated',
    'people.banking.overridden',
    'bank_info.requested',
    'offboarding.requested',
    'offboarding.request_completed',
    'offboarding.request_dismissed',
    'offboarding.request_returned',
    'resignation.submitted',
    'resignation.approved',
    'resignation.rejected',
    'ticket.replied',
    'ticket.assigned',
    'documents.requested',
    'documents.signed',
    'documents.rejected',
    'bank_preferred.decided'
  ));

-- Verify:
-- select conname, pg_get_constraintdef(oid)
--   from pg_constraint where conname = 'employee_notifications_type_check';
```

- [ ] **Step 2: Write the route**

Create `app/api/payment-dispatch/bank-override/route.ts`:

```ts
import { NextResponse } from 'next/server';
import { randomUUID } from 'crypto';
import { createSupabaseServiceRoleClient } from '@/lib/supabase/server';
import { requireFeatureEdit } from '@/lib/auth/authorize-feature';
import { deniedResponse } from '@/lib/auth/authorize-email';
import { getSessionActor } from '@/lib/auth/session-actor';
import { insertAuditLog } from '@/lib/supabase/audit-log';
import { insertBankUpdateHistory } from '@/lib/supabase/bank-update-history';
import { maskFieldValue } from '@/lib/bank-update/mask-field';
import { pulseBankChanges } from '@/lib/supabase/app-settings';
import {
  mapBankOverrideToColumns,
  type BankOverrideTarget,
  type BankOverrideValues,
} from '@/lib/payroll/bank-override-mapping';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

// POST /api/payment-dispatch/bank-override
// Accounting-only (Mark Paid modal): save corrected receiving-end bank details
// back to the employee's profile (employee_ids), overriding the dashboard
// values. Deliberately NO dispatch-lock check — this is the sanctioned
// mid-processing correction path (the lock exists to stop EMPLOYEES changing
// details while accounting pays). Routing (bank_preferred) is never written.
export async function POST(req: Request) {
  try {
    const authz = await requireFeatureEdit('accounting', 'payment_dispatch');
    if (!authz.ok) return deniedResponse(authz);

    const body = (await req.json()) as {
      work_email?: string;
      target?: string;
      processor?: string;
      display_name?: string;
      values?: BankOverrideValues;
    };

    const workEmail = (body.work_email ?? '').trim().toLowerCase();
    const target = (body.target ?? '') as BankOverrideTarget;
    const processor = (body.processor ?? '').trim().toLowerCase();
    const displayName = (body.display_name ?? '').trim() || null;

    if (!workEmail) return NextResponse.json({ error: 'work_email is required' }, { status: 400 });
    if (target !== 'bank' && target !== 'wallet') {
      return NextResponse.json({ error: "target must be 'bank' or 'wallet'" }, { status: 400 });
    }
    if (!body.values) return NextResponse.json({ error: 'values is required' }, { status: 400 });

    const supabase = createSupabaseServiceRoleClient();
    if (!supabase) {
      return NextResponse.json(
        { error: 'SUPABASE_SERVICE_ROLE_KEY is required for bank-override writes.' },
        { status: 500 },
      );
    }

    // Current row: the slot decides which columns a 'bank' write targets, and
    // the before-values feed the masked history entry.
    const { data: currentRows, error: loadErr } = await supabase
      .from('employee_ids')
      .select(
        'employee_id, name, preferred_bank_slot, bank_name, account_holder_name, account_number, swift_code, alt_bank_name, alt_account_holder_name, alt_account_number, alt_routing_number, hurupay_email, wepay_email, higlobe_email, higlobe_account_name, wise_email',
      )
      .ilike('work_email', workEmail)
      .limit(1);
    if (loadErr) return NextResponse.json({ error: loadErr.message }, { status: 500 });
    const beforeRow = (currentRows?.[0] ?? null) as Record<string, unknown> | null;

    const slot: 'primary' | 'alternative' =
      beforeRow?.preferred_bank_slot === 'alternative' ? 'alternative' : 'primary';

    const mapped = mapBankOverrideToColumns({
      target,
      processor,
      preferredBankSlot: slot,
      values: body.values,
    });
    if ('error' in mapped) return NextResponse.json({ error: mapped.error }, { status: 400 });
    const { columns } = mapped;

    // Write: update the existing row, or bootstrap one for a person who only
    // exists in the rates CSV (same SELF- pattern as the bank-preferred
    // approval route).
    let created = false;
    if (beforeRow) {
      const { error: updErr } = await supabase
        .from('employee_ids')
        .update(columns)
        .ilike('work_email', workEmail);
      if (updErr) return NextResponse.json({ error: updErr.message }, { status: 500 });
    } else {
      created = true;
      const employeeId = `SELF-${randomUUID().replace(/-/g, '').slice(0, 14).toUpperCase()}`;
      const { error: insErr } = await supabase.from('employee_ids').insert({
        employee_id: employeeId,
        name: displayName ?? workEmail,
        work_email: workEmail,
        ...columns,
      });
      if (insErr) return NextResponse.json({ error: insErr.message }, { status: 500 });
    }

    // ── Best-effort trail: history feed, audit log, live pulse, employee
    // notification. None of these may fail the save. ──────────────────────
    const fields = Object.keys(columns);
    const changes = fields.map((field) => {
      const rawBefore = beforeRow?.[field] != null ? String(beforeRow[field]) : null;
      const rawAfter = columns[field];
      return {
        field,
        before: maskFieldValue(field, rawBefore),
        after: maskFieldValue(field, rawAfter),
        changed: (rawBefore ?? '').trim() !== (rawAfter ?? '').trim(),
      };
    });
    const employeeName =
      displayName ?? (typeof beforeRow?.name === 'string' ? (beforeRow.name as string) : null);

    await insertBankUpdateHistory({
      work_email: workEmail,
      employee_name: employeeName,
      fields,
      changes,
      processor: processor || null,
      created_new: created,
      via: 'mark_paid_override',
      ip_address: null,
    }).catch(() => undefined);

    const actor = await getSessionActor();
    void insertAuditLog({
      user_name: actor.user_name,
      user_role: actor.user_role,
      action: 'bank_override.saved',
      resource: 'employee_ids',
      resource_id: workEmail,
      details: { via: 'mark_paid_override', target, processor, fields, changes, created },
    });

    await pulseBankChanges().catch(() => undefined);

    try {
      await supabase.from('employee_notifications').insert({
        recipient_email: workEmail,
        type: 'people.banking.overridden',
        tone: 'neutral',
        title: 'Accounting updated your bank details',
        message: `Accounting corrected your payout details (${fields.join(', ')}) while processing your payment. Review them under Profile → Payment.`,
        details: { kind: 'bank_override', via: 'mark_paid_override', fields },
      });
    } catch {
      /* notification failure must not fail the save */
    }

    return NextResponse.json({ success: true, created });
  } catch (e) {
    return NextResponse.json({ error: String(e) }, { status: 500 });
  }
}
```

- [ ] **Step 3: Typecheck**

Run: `npx tsc --noEmit`
Expected: exit 0, no errors.

- [ ] **Step 4: Commit**

```bash
git add app/api/payment-dispatch/bank-override/route.ts references/sql/alter/2026-07-22_employee_notifications_add_bank_override_type.sql
git commit -m "feat(mark-paid): accounting bank-override endpoint + notification type migration

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

### Task 3: Override mode in MarkPaidDialog

**Files:**
- Modify: `src/components/payroll-clerk/MarkPaidDialog.tsx`

**Interfaces:**
- Consumes: `POST /api/payment-dispatch/bank-override` (Task 2's body shape), existing `resolveMarkPaidDefaults` (`isBankWire = defaults?.showSwiftField`).
- Produces: new optional prop `onBankDetailsOverridden?: () => void` on `MarkPaidDialogProps` — Task 4 wires it in PayrollDispatch. All existing render sites compile unchanged (prop optional).

- [ ] **Step 1: Add imports and prop**

In `src/components/payroll-clerk/MarkPaidDialog.tsx`:

Add `Pencil` to the lucide import (line 12) and `toast`:

```ts
import { AlertTriangle, Check, CheckCircle2, ChevronDown, ChevronLeft, ChevronRight, CircleDashed, Copy, Gauge, Loader2, Pencil, X } from 'lucide-react';
import { toast } from 'sonner';
```

Extend `MarkPaidDialogProps` (after `onNext?: () => void;`):

```ts
  /**
   * Fires after a successful profile override (Save to profile) so the parent
   * can silently refetch the queue — the corrected details become the row's
   * new defaults. Optional: render sites without a queue skip it.
   */
  onBankDetailsOverridden?: () => void;
```

And destructure it in the component signature:

```ts
export default function MarkPaidDialog({
  row,
  onClose,
  onConfirm,
  position,
  onPrev,
  onNext,
  onBankDetailsOverridden,
}: MarkPaidDialogProps) {
```

- [ ] **Step 2: Add override state + handlers**

After the `copiedAcct` state (line ~307), add:

```ts
  // ── Profile override (pencil on the Recipient divider) ─────────────────
  // Arms an explicit "Save to profile" that writes the recipient fields back
  // to employee_ids, overriding the employee dashboard. Typing WITHOUT the
  // pencil keeps the log-only behavior. Snapshot restores on Cancel.
  const [overrideMode, setOverrideMode]         = useState(false);
  const [overrideSaving, setOverrideSaving]     = useState(false);
  const [overrideSnapshot, setOverrideSnapshot] = useState<{
    bank: string; holder: string; acct: string; swift: string;
  } | null>(null);
```

After the `copyAccount` callback (line ~345), add:

```ts
  const enterOverride = useCallback(() => {
    setOverrideSnapshot({
      bank: recipientPreferredBank,
      holder: recipientAccountHolder,
      acct: recipientAccountNumber,
      swift: recipientSwiftCode,
    });
    setOverrideMode(true);
  }, [recipientPreferredBank, recipientAccountHolder, recipientAccountNumber, recipientSwiftCode]);

  const cancelOverride = useCallback(() => {
    if (overrideSnapshot) {
      setRecipientPreferredBank(overrideSnapshot.bank);
      setRecipientAccountHolder(overrideSnapshot.holder);
      setRecipientAccountNumber(overrideSnapshot.acct);
      setRecipientSwiftCode(overrideSnapshot.swift);
    }
    setOverrideSnapshot(null);
    setOverrideMode(false);
  }, [overrideSnapshot]);

  const saveOverride = useCallback(async () => {
    if (!row || recipientAccountNumber.trim() === '' || overrideSaving) return;
    setOverrideSaving(true);
    try {
      const res = await fetch('/api/payment-dispatch/bank-override', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          work_email: row.email,
          target: (defaults?.showSwiftField ?? false) ? 'bank' : 'wallet',
          processor: row.processor,
          display_name: row.name,
          values: {
            preferredBank: recipientPreferredBank,
            accountNumber: recipientAccountNumber,
            accountHolder: recipientAccountHolder,
            swiftCode: recipientSwiftCode,
          },
        }),
      });
      const json = (await res.json()) as { success?: boolean; error?: string };
      if (!res.ok || json.error) throw new Error(json.error ?? 'Failed to save to profile');
      toast.success(`Saved to ${row.name}'s profile — their dashboard now shows these details.`);
      setOverrideSnapshot(null);
      setOverrideMode(false);
      onBankDetailsOverridden?.();
    } catch (e) {
      toast.error(e instanceof Error ? e.message : 'Failed to save to profile');
    } finally {
      setOverrideSaving(false);
    }
  }, [row, defaults, recipientPreferredBank, recipientAccountNumber, recipientAccountHolder, recipientSwiftCode, overrideSaving, onBankDetailsOverridden]);
```

In the row-reset `useEffect` (line ~347, `if (!row || !defaults) return;`), add before the closing brace:

```ts
    setOverrideMode(false);
    setOverrideSnapshot(null);
    setOverrideSaving(false);
```

- [ ] **Step 3: Per-field editability during override**

Below `const isBankWire = defaults?.showSwiftField ?? false;` (line ~369), add:

```ts
  // Which recipient fields the profile override can actually persist. Wallet
  // processors only store what their columns carry: hurupay/wepay just the
  // wallet email; higlobe/wise also the holder. Bank wires store all four.
  const overrideEditable = {
    bank: isBankWire,
    holder: isBankWire || row?.processor === 'higlobe' || row?.processor === 'wise',
    acct: true,
    swift: isBankWire,
  };
```

- [ ] **Step 4: Divider pencil + badge, field disabling, action row**

Replace the Recipient divider block (lines ~659-666):

```tsx
          {/* Recipient divider — pencil arms the profile override */}
          <div className="flex items-center gap-2.5">
            <div className="h-px flex-1 bg-zinc-100 dark:bg-zinc-800" />
            <span className="text-[9.5px] font-bold uppercase tracking-[0.16em] text-zinc-400">
              Recipient
            </span>
            {overrideMode ? (
              <span className="inline-flex items-center gap-1 rounded-full bg-amber-100 px-2 py-0.5 text-[9.5px] font-semibold text-amber-800 dark:bg-amber-950/40 dark:text-amber-300">
                <Pencil className="h-2.5 w-2.5" />
                Editing employee profile
              </span>
            ) : (
              <button
                type="button"
                onClick={enterOverride}
                onMouseDown={(e) => e.preventDefault()}
                aria-label="Override employee profile bank details"
                title="Override the employee's saved bank details"
                className="inline-flex h-6 w-6 items-center justify-center rounded-md text-zinc-400 outline-none transition-colors hover:bg-zinc-100 hover:text-zinc-600 focus:outline-none focus-visible:outline-none dark:hover:bg-zinc-800 dark:hover:text-zinc-300"
              >
                <Pencil className="h-3 w-3" />
              </button>
            )}
            <div className="h-px flex-1 bg-zinc-100 dark:bg-zinc-800" />
          </div>
```

Disable non-persistable fields during override — extend the three recipient `FieldInput`s:

`rcpt-bank` input (line ~670): add

```tsx
                disabled={overrideMode && !overrideEditable.bank}
                className={cn(overrideMode && !overrideEditable.bank && 'opacity-60')}
```

`rcpt-holder` input (line ~679): add

```tsx
                disabled={overrideMode && !overrideEditable.holder}
                className={cn(overrideMode && !overrideEditable.holder && 'opacity-60')}
```

(`rcpt-acct` and `rcpt-swift` stay always-editable — `acct` and `swift` are editable whenever visible.)

Insert the action row right AFTER the SWIFT field block (`{isBankWire && ( ... )}`, line ~727-738) and BEFORE the Note field:

```tsx
          {overrideMode && (
            <div className="flex items-center justify-between gap-2 rounded-lg border border-amber-200 bg-amber-50/60 px-3 py-2.5 dark:border-amber-900/40 dark:bg-amber-950/20">
              <p className="text-[11px] leading-snug text-amber-800 dark:text-amber-300">
                Saves these details to {row?.name ?? 'the employee'}&apos;s profile —
                overriding their dashboard.
              </p>
              <div className="flex shrink-0 items-center gap-1.5">
                <Button
                  type="button"
                  variant="outline"
                  size="sm"
                  className="h-7 gap-1 rounded-md text-[11.5px]"
                  disabled={overrideSaving}
                  onClick={cancelOverride}
                >
                  <X className="h-3 w-3" />
                  Cancel
                </Button>
                <Button
                  type="button"
                  size="sm"
                  className="h-7 gap-1 rounded-md bg-amber-600 text-[11.5px] text-white hover:bg-amber-700 dark:bg-amber-500 dark:text-amber-950 dark:hover:bg-amber-400"
                  disabled={overrideSaving || recipientAccountNumber.trim() === ''}
                  onClick={() => void saveOverride()}
                >
                  {overrideSaving ? <Loader2 className="h-3 w-3 animate-spin" /> : <Check className="h-3 w-3" />}
                  Save to profile
                </Button>
              </div>
            </div>
          )}
```

- [ ] **Step 5: Typecheck**

Run: `npx tsc --noEmit`
Expected: exit 0. (All three render sites — PayrollDispatch, PayrollClerkApp, UrgentPaymentsQueue — still compile: the new prop is optional.)

- [ ] **Step 6: Commit**

```bash
git add src/components/payroll-clerk/MarkPaidDialog.tsx
git commit -m "feat(mark-paid): pencil override mode saves corrected bank details to the employee profile

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

### Task 4: Wire the queue refresh + final verification + ship

**Files:**
- Modify: `src/components/payroll-clerk/PayrollDispatch.tsx:977-987` (the `<MarkPaidDialog …>` element)

**Interfaces:**
- Consumes: `onBankDetailsOverridden` prop (Task 3); `refresh` from `useDispatchQueue` (already destructured at `PayrollDispatch.tsx:199`).
- Produces: nothing new — final integration.

- [ ] **Step 1: Pass the refresh callback**

In `src/components/payroll-clerk/PayrollDispatch.tsx`, the `<MarkPaidDialog>` element (line ~977) gains one prop:

```tsx
      <MarkPaidDialog
        row={markPaidRow}
        onClose={handleCloseMarkPaid}
        onConfirm={handleConfirmPaid}
        onBankDetailsOverridden={refresh}
        position={
          galleryIdx != null
            ? { index: galleryIdx, total: gallerySiblings.length }
            : undefined
        }
        onPrev={handleGalleryPrev}
        onNext={handleGalleryNext}
      />
```

(`PayrollClerkApp` and `UrgentPaymentsQueue` are deliberately untouched — the prop is optional.)

- [ ] **Step 2: Full verification**

```bash
npx tsc --noEmit
npm test
```

Expected: typecheck exit 0; all tests pass including the 10 new mapping tests.

- [ ] **Step 3: Commit and ship**

```bash
git add src/components/payroll-clerk/PayrollDispatch.tsx
git commit -m "feat(payment-dispatch): refresh queue after a Mark Paid profile override

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
git push origin main
```

- [ ] **Step 4: Post-ship checklist (tell the user)**

1. Run `references/sql/alter/2026-07-22_employee_notifications_add_bank_override_type.sql` in the Supabase SQL editor (employee notifications for overrides silently no-op until then; the override itself works regardless).
2. Hard-refresh the deployed site after Vercel builds.
3. Manual smoke test: Payment Dispatch → any queue row → Mark Paid → pencil on the Recipient divider → edit a field → Save to profile → expect success toast; verify the change appears in People → Bank Changes (via `mark_paid_override`), the employee's Profile → Payment shows the new value, and the employee got a notification (post-migration).
