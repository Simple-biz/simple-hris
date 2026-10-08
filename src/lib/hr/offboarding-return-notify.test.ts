import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  buildReturnedNotifications,
  departmentManagersFor,
  RETURNED_NOTIFICATION_TYPE,
  type ReturnedNotificationInput,
} from './offboarding-return-notify';

// Open item 397. On 2026-10-06 HR returned Carla's queue row for Mark Arriola
// (Lead Gen). The route told the REQUESTER only, so Jackie, who manages Lead
// Gen, never heard. Carla: "Jackie didn't get a notification on that and that's
// she wants one set up."

const LEAD_GEN_GRANTS = [
  { manager_email: 'jackie@simple.biz', department: 'Lead Gen' },
  { manager_email: 'carla@simple.biz', department: 'Lead Gen' },
  { manager_email: 'cjm@simple.biz', department: 'Callbacks' },
  { manager_email: 'other@simple.biz', department: 'Sales' },
];

function input(over: Partial<ReturnedNotificationInput> = {}): ReturnedNotificationInput {
  return {
    requestId: 'q-1',
    employeeName: 'Sample Person',
    employeeEmail: 'sample.person@gmail.com',
    subjectEmails: ['sample.person@gmail.com', 'samplep@simple.biz', 'sample.person@gmail.com'],
    requestedBy: 'requester@simple.biz',
    requestedByName: 'Req Uester',
    departmentManagers: ['manager@simple.biz'],
    returnedBy: 'returner@simple.biz',
    note: 'No work email on file',
    ...over,
  };
}

const recipients = (rows: { recipient_email: string }[]) => rows.map((r) => r.recipient_email).sort();

test("Review Focus 5: the requester AND the department's managers, deduped, never the returner", () => {
  const out = buildReturnedNotifications(input({
    requestedBy: 'Requester@simple.biz',
    departmentManagers: ['manager@simple.biz', 'requester@simple.biz', ' RETURNER@simple.biz '],
  }));
  assert.deepEqual(recipients(out), ['manager@simple.biz', 'requester@simple.biz']);
  assert.ok(out.every((n) => n.type === 'offboarding.request_returned'));
  assert.ok(out.every((n) => n.tone === 'neutral'));
  for (const n of out) {
    assert.match(n.message, /Sample Person/);
    assert.match(n.message, /No work email on file/);
  }
});

test('the Arriola case: Carla raised it, Jackie manages Lead Gen, jakec@ returned it → both told', () => {
  const managers = departmentManagersFor('Lead Gen', LEAD_GEN_GRANTS);
  const out = buildReturnedNotifications(input({
    requestedBy: 'carla@simple.biz',
    requestedByName: 'Carla T',
    departmentManagers: managers,
    returnedBy: 'jakec@simple.biz',
  }));
  assert.deepEqual(recipients(out), ['carla@simple.biz', 'jackie@simple.biz']);
});

test('the requester keeps the "your request" wording; a manager is told whose request it was', () => {
  const out = buildReturnedNotifications(input());
  const toRequester = out.find((n) => n.recipient_email === 'requester@simple.biz')!;
  const toManager = out.find((n) => n.recipient_email === 'manager@simple.biz')!;
  // Byte-for-byte the message the route has sent since 2026-07-02.
  assert.equal(
    toRequester.message,
    'HR sent your request to offboard Sample Person back for another look: "No work email on file"',
  );
  assert.equal(
    toManager.message,
    'HR sent Req Uester\'s request to offboard Sample Person back for another look: "No work email on file"',
  );
  assert.equal(toRequester.details.audience, 'requester');
  assert.equal(toManager.details.audience, 'department_manager');
  assert.equal(toRequester.title, 'Offboarding Request Returned');
  assert.equal(toManager.title, 'Offboarding Request Returned');
});

test('a requester who also manages the department gets ONE notification, the requester copy', () => {
  const out = buildReturnedNotifications(input({ departmentManagers: ['REQUESTER@simple.biz'] }));
  assert.equal(out.length, 1);
  assert.equal(out[0]!.details.audience, 'requester');
});

test('the person being offboarded is never told, even when they manage their own department', () => {
  const out = buildReturnedNotifications(input({
    departmentManagers: ['manager@simple.biz', 'SampleP@simple.biz'],
  }));
  assert.deepEqual(recipients(out), ['manager@simple.biz', 'requester@simple.biz']);
});

test('the returner is never told, even when they raised the request', () => {
  const out = buildReturnedNotifications(input({ returnedBy: 'requester@simple.biz' }));
  assert.deepEqual(recipients(out), ['manager@simple.biz']);
});

test('no department managers (null department, or none assigned) → the requester alone', () => {
  const out = buildReturnedNotifications(input({ departmentManagers: [] }));
  assert.deepEqual(recipients(out), ['requester@simple.biz']);
});

test('a blank requester still reaches the managers', () => {
  const out = buildReturnedNotifications(input({ requestedBy: '  ', requestedByName: null }));
  assert.deepEqual(recipients(out), ['manager@simple.biz']);
  assert.match(out[0]!.message, /HR sent a request to offboard Sample Person/);
});

test('without a note the message ends cleanly, never with an empty quote', () => {
  const out = buildReturnedNotifications(input({ note: null }));
  for (const n of out) {
    assert.ok(n.message.endsWith('back for another look.'), n.message);
    assert.equal(n.details.note, null);
  }
});

test('details carry what the card and an audit reader need', () => {
  const [n] = buildReturnedNotifications(input({ departmentManagers: [] }));
  assert.deepEqual(n!.details, {
    request_id: 'q-1',
    employee_email: 'sample.person@gmail.com',
    employee_name: 'Sample Person',
    processed_by: 'returner@simple.biz',
    requested_by: 'requester@simple.biz',
    note: 'No work email on file',
    audience: 'requester',
  });
});

test('departmentManagersFor uses the same matcher as the queue POST scope check', () => {
  // "Callbacks" and "Callback Team" are one department (normalizeDeptToKey).
  // A manager who could RAISE a request for the person is told when it comes back.
  assert.deepEqual(departmentManagersFor('Callback Team', LEAD_GEN_GRANTS), ['cjm@simple.biz']);
  assert.deepEqual(departmentManagersFor(' lead gen ', LEAD_GEN_GRANTS).sort(), ['carla@simple.biz', 'jackie@simple.biz']);
  assert.deepEqual(departmentManagersFor(null, LEAD_GEN_GRANTS), []);
  assert.deepEqual(departmentManagersFor('', LEAD_GEN_GRANTS), []);
  assert.deepEqual(departmentManagersFor('Nobody Manages This', LEAD_GEN_GRANTS), []);
});

test('departmentManagersFor folds case and whitespace, and drops a blank email', () => {
  const out = departmentManagersFor('Lead Gen', [
    { manager_email: ' Jackie@Simple.biz ', department: 'Lead Gen' },
    { manager_email: 'jackie@simple.biz', department: 'lead gen' },
    { manager_email: '   ', department: 'Lead Gen' },
  ]);
  assert.deepEqual(out, ['jackie@simple.biz']);
});

test('the type is the one already in employee_notifications_type_check and mapped to Manager', () => {
  // A NEW type would be rejected by the CHECK until an ALTER ran, and a rejected
  // insert looks exactly like success (notify-failure-audit.ts). Reuse the one
  // that has been admitted since 2026-07-02.
  assert.equal(RETURNED_NOTIFICATION_TYPE, 'offboarding.request_returned');
});

/* ── Source pins: the route wiring ─────────────────────────────────────────── */

const ROUTE = readFileSync(
  join(process.cwd(), 'app', 'api', 'offboarding-queue', '[id]', 'route.ts'),
  'utf8',
);

test('the route builds return notifications from this module, not an inline requester-only row', () => {
  assert.match(ROUTE, /buildReturnedNotifications\(/);
  assert.match(ROUTE, /departmentManagersFor\(/);
  assert.match(ROUTE, /listActiveManagerAssignments\(/);
});

test('the notification is written only AFTER the status write succeeded', () => {
  const decide = ROUTE.indexOf('await decideOffboardingQueueEntry(');
  const updatedGuard = ROUTE.indexOf('if (updated === 0)', decide);
  const insert = ROUTE.indexOf(".from('employee_notifications').insert(");
  assert.ok(decide > 0 && updatedGuard > decide, 'decide + 409 guard not found');
  assert.ok(insert > updatedGuard, 'notification insert must follow the status write and its 409 guard');
});

test('a failed insert is read, recorded as notification.insert_failed, and reported — never undoes the return', () => {
  const insertAt = ROUTE.indexOf(".from('employee_notifications').insert(");
  const after = ROUTE.slice(insertAt, insertAt + 1500);
  assert.match(after, /error/, 'the insert result must be read');
  assert.match(ROUTE, /recordNotifyFailure\(/);
  assert.match(ROUTE, /notification:\s*notifyResult/);
  // No status rollback anywhere after the decision.
  assert.doesNotMatch(ROUTE.slice(ROUTE.indexOf('await decideOffboardingQueueEntry(') + 10), /decideOffboardingQueueEntry\(/);
});
