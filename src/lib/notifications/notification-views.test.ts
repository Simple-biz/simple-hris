import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  NOTIFICATION_TYPE_TO_VIEWS,
  hiddenTypesForView,
  viewsForNotificationType,
} from './notification-views';

// ── HR is never alerted about money (2026-08-17) ────────────────────────────
// Bank/payout changes are Accounting's business. The three fan-outs that write
// `people.banking.self_updated` address admin/accounting/ceo role holders only
// (app/api/bank-update/save/route.ts, app/api/update-employee-ids/route.ts ×2),
// and the mapping below is the second half of that rule: it keeps the type out
// of every HR-scoped read.
//
// This matters because `useNotificationChime` used to fetch UNSCOPED, which the
// GET treats as "every type this viewer may see". An HR coordinator who also
// held accounting/ceo therefore heard payout changes chime on the HR dashboard
// even though HR's own panel hid them. Both dashboards now pass a `view`, so
// this map is what the alert is filtered by — if a money type ever gains 'hr',
// that leak silently reopens.

test('bank-detail changes are hidden from the HR view', () => {
  assert.ok(
    hiddenTypesForView('hr').includes('people.banking.self_updated'),
    'people.banking.self_updated must be excluded from every HR-scoped read',
  );
  assert.deepEqual(viewsForNotificationType('people.banking.self_updated'), [
    'accounting',
    'admin',
    'ceo',
  ]);
});

test('bank-detail changes still reach Accounting', () => {
  // The other half of the rule: tightening HR must never cost Accounting the
  // alert it is the reviewer for.
  assert.ok(!hiddenTypesForView('accounting').includes('people.banking.self_updated'));
});

test('no money-shaped notification type is mapped to HR', () => {
  // A guard against the next one, not just this one: any type carrying bank,
  // payout, payment or dispatch semantics must stay off the HR dashboard.
  const moneyish = Object.keys(NOTIFICATION_TYPE_TO_VIEWS).filter((t) =>
    /^(people\.banking|bank_preferred|bank_info)\./.test(t),
  );
  assert.ok(moneyish.length > 0, 'expected at least one money-shaped type to exist');
  for (const type of moneyish) {
    assert.ok(
      !NOTIFICATION_TYPE_TO_VIEWS[type].includes('hr'),
      `${type} is money — it must not be mapped to the HR dashboard`,
    );
  }
});

// ── Scoping HR must not silence HR's own alerts ─────────────────────────────
// Passing `view: 'hr'` to the chime narrows what rings. These pin that the
// narrowing stopped at money and did not take HR's real work with it.

test('HR still hears its own notification types', () => {
  const hidden = hiddenTypesForView('hr');
  for (const type of [
    'onboarding.submitted',
    'transfer.requested',
    'offboarding.requested',
    // Company-wide payroll lock — deliberately ungated and shared with HR
    // (see NOTIFICATION_TYPE_FEATURE_GATE's note).
    'payroll.processing_started',
    'payroll.processing_stopped',
  ]) {
    assert.ok(!hidden.includes(type), `${type} must still reach the HR dashboard`);
  }
});

test('an unmapped type is hidden from nobody', () => {
  // hiddenTypesForView only ever lists MAPPED types, so a new flow that forgets
  // its mapping degrades to "visible everywhere" instead of vanishing.
  assert.deepEqual(viewsForNotificationType('some.brand_new_type'), []);
  assert.ok(!hiddenTypesForView('hr').includes('some.brand_new_type'));
  assert.ok(!hiddenTypesForView('accounting').includes('some.brand_new_type'));
});
