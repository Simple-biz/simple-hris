import { test } from 'node:test';
import assert from 'node:assert/strict';
import { describeNotifyError, NOTIFY_FAILED_ACTION } from './notify-failure-audit';

// The whole point of this module is that a notification failure stops being
// invisible WITHOUT becoming fatal. Both halves are load-bearing: kpi.scored was
// dead 3 days and pab.excluded 17 days behind a console.warn, and the wrong fix
// would be to make a notify failure fail the payroll save that triggered it.

test('the action string is stable — audit readers filter on it', () => {
  // Changing this orphans every previously-written row from any search for it.
  assert.equal(NOTIFY_FAILED_ACTION, 'notification.insert_failed');
});

test('describeNotifyError keeps an Error message', () => {
  assert.equal(describeNotifyError(new Error('boom')), 'boom');
});

test('describeNotifyError passes a bare string through', () => {
  // Supabase hands back `error.message` as a plain string at several call sites.
  assert.equal(
    describeNotifyError('new row violates check constraint "employee_notifications_type_check"'),
    'new row violates check constraint "employee_notifications_type_check"',
  );
});

test('describeNotifyError never loses a non-Error value', () => {
  assert.equal(describeNotifyError({ code: '23514' }), '{"code":"23514"}');
  assert.equal(describeNotifyError(null), 'null');
  // JSON.stringify(undefined) is undefined, not a string — the helper must still
  // return a string or details.error lands as null in the audit row.
  assert.equal(describeNotifyError(undefined), 'undefined');
});

test('describeNotifyError survives a value JSON cannot stringify', () => {
  // A circular object must not throw — this runs inside a catch that is
  // protecting a payroll save.
  const circular: Record<string, unknown> = { a: 1 };
  circular.self = circular;
  assert.doesNotThrow(() => describeNotifyError(circular));
  assert.equal(typeof describeNotifyError(circular), 'string');
});

test('a type-CHECK rejection is recognisable from its message', () => {
  // This is the exact footgun that caused both outages, so the audit row flags
  // it rather than leaving the next person to re-diagnose it from scratch.
  const detect = (m: string) => /type_check|violates check constraint/i.test(m);
  assert.equal(detect('new row for relation "employee_notifications" violates check constraint "employee_notifications_type_check"'), true);
  assert.equal(detect('violates check constraint "x"'), true);
  assert.equal(detect('could not connect'), false);
});
