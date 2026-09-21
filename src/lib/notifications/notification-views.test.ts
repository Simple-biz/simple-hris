import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
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

// ── Employee Support is the employee's, never the answerers' ─────────────────
// Both doors behind the Employee dashboard's Help button — the live chat and,
// from 2026-09-21, Raise a ticket — notify the person who asked. The five
// answerers watch the queue, the line and the board on /tickets, so a badge on
// that dashboard for their own replies would be noise. And an UNMAPPED type is
// worse than noise: viewsForNotificationType returns [], the per-view count
// adds the row to nothing, and the notification exists in the table while
// reaching nobody. These pin both halves for all four types.

const EMPLOYEE_SUPPORT_TYPES = [
  'support_chat.replied',
  'support_chat.became_ticket',
  'support.replied',
  'support.answered',
] as const;

test('the two ticket-side Employee Support types badge the Employee dashboard', () => {
  assert.deepEqual(viewsForNotificationType('support.replied'), ['employee']);
  assert.deepEqual(viewsForNotificationType('support.answered'), ['employee']);
  const hiddenFromEmployee = hiddenTypesForView('employee');
  assert.ok(!hiddenFromEmployee.includes('support.replied'));
  assert.ok(!hiddenFromEmployee.includes('support.answered'));
});

test("Employee Support never badges the answerers' own dashboard", () => {
  // /tickets is where the five answer from; their own replies must not light it.
  const hiddenFromTickets = hiddenTypesForView('tickets');
  for (const type of EMPLOYEE_SUPPORT_TYPES) {
    assert.ok(hiddenFromTickets.includes(type), `${type} must be hidden from the tickets dashboard`);
  }
});

test('every Employee Support type — chat and ticket — maps to the employee alone', () => {
  // A guard against the next one, not just these four: any support.* or
  // support_chat.* type added later belongs to the employee who asked unless
  // somebody argues otherwise here first.
  const support = Object.keys(NOTIFICATION_TYPE_TO_VIEWS).filter((t) => /^support(_chat)?\./.test(t));
  for (const type of EMPLOYEE_SUPPORT_TYPES) {
    assert.ok(support.includes(type), `${type} must be mapped — an unmapped type reaches nobody`);
  }
  for (const type of support) {
    assert.deepEqual(
      NOTIFICATION_TYPE_TO_VIEWS[type],
      ['employee'],
      `${type} belongs to the employee who asked, and to nobody else's badge`,
    );
  }
});

// The two widens each say they were "changed together with" this module. A
// test is what makes that sentence true instead of hopeful: every value a widen
// ADDS is mapped here, and every type mapped here for that family is one a
// widen adds. A type in one place and not the other is either a dead
// notification (in SQL, unmapped — invisible) or a rejected insert (mapped,
// not in SQL — the kpi.scored three-day silence).

/** The `added constant text[] := array[...]` values of an additive widen. */
function addedTypes(sqlPath: string): string[] {
  const sql = readFileSync(join(process.cwd(), sqlPath), 'utf8');
  const m = sql.match(/added\s+constant\s+text\[\]\s*:=\s*array\[([^\]]*)\]/i);
  assert.ok(m, `no \`added constant text[] := array[...]\` block in ${sqlPath}`);
  return [...m[1].matchAll(/'([^']+)'/g)].map((x) => x[1]).sort();
}

const mappedFamily = (re: RegExp) =>
  Object.keys(NOTIFICATION_TYPE_TO_VIEWS)
    .filter((t) => re.test(t))
    .sort();

test('the ticket-side widen and this map admit the same two support.* types', () => {
  assert.deepEqual(
    mappedFamily(/^support\./),
    addedTypes('references/sql/alter/2026-09-21_support_notification_types.sql'),
  );
});

test('the chat-side widen and this map admit the same two support_chat.* types', () => {
  assert.deepEqual(
    mappedFamily(/^support_chat\./),
    addedTypes('references/sql/alter/2026-09-19_add_chat_notification_types.sql'),
  );
});
