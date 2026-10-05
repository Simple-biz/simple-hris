/**
 * An address that has ever belonged to someone is never re-issued.
 *
 * Kane, 2026-10-05 (audit item 344), replacing HR's "off-boarded rows are
 * recyclable". On 2026-09-26 five Lead Gen hires were minted a recycled address
 * (`johnt@`, `justinem@`, `maryt@`, `marial@`, `marief@`). None could be
 * promoted, and payroll would have paid each one through the previous holder's
 * `employee_ids` row.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  buildWorkEmailReservations,
  IN_FLIGHT_PENDING_STATUSES,
  mayReclaimWhenWorkspaceMissing,
  type WorkEmailReservationSources,
} from './work-email-reservations';

const none: WorkEmailReservationSources = {
  masterEmails: [],
  employeeIdsEmails: [],
  roleEmails: [],
  offboardedLedgerEmails: [],
  ratesEmails: [],
  inFlightPendingEmails: [],
};

test("an off-boarded holder's master address is taken and never reclaimable", () => {
  // The loader passes EVERY master row; there is no off-boarded exemption left.
  const r = buildWorkEmailReservations({ ...none, masterEmails: ['MaryT@simple.biz '] });
  assert.ok(r.taken.has('maryt@simple.biz'));
  assert.equal(mayReclaimWhenWorkspaceMissing('maryt@simple.biz', r), false);
});

test('each history source reserves on its own — none is freed by another', () => {
  for (const key of ['employeeIdsEmails', 'roleEmails', 'offboardedLedgerEmails', 'ratesEmails'] as const) {
    const r = buildWorkEmailReservations({ ...none, [key]: ['johnt@simple.biz'] });
    assert.ok(r.onRecord.has('johnt@simple.biz'), key);
    assert.equal(mayReclaimWhenWorkspaceMissing('johnt@simple.biz', r), false, key);
  }
});

test('a pure in-flight claim is taken but may be reclaimed when Workspace has no account', () => {
  const r = buildWorkEmailReservations({ ...none, inFlightPendingEmails: ['newhire@simple.biz'] });
  assert.ok(r.taken.has('newhire@simple.biz'));
  assert.ok(r.claimed.has('newhire@simple.biz'));
  assert.equal(mayReclaimWhenWorkspaceMissing('newhire@simple.biz', r), true);
});

test('an in-flight claim on an address that is also on record stays unreclaimable', () => {
  // Tudtud's failed_to_promote row holds maryt@, and so do three previous holders.
  const r = buildWorkEmailReservations({
    ...none,
    masterEmails: ['maryt@simple.biz'],
    inFlightPendingEmails: ['maryt@simple.biz'],
  });
  assert.equal(r.claimed.has('maryt@simple.biz'), false);
  assert.equal(mayReclaimWhenWorkspaceMissing('maryt@simple.biz', r), false);
});

test('blank and null cells reserve nothing', () => {
  const r = buildWorkEmailReservations({ ...none, masterEmails: [null, '', '  ', undefined] });
  assert.equal(r.taken.size, 0);
});

test('a failed promote still holds its address', () => {
  assert.ok((IN_FLIGHT_PENDING_STATUSES as readonly string[]).includes('failed_to_promote'));
  assert.ok((IN_FLIGHT_PENDING_STATUSES as readonly string[]).includes('ready'));
  assert.ok((IN_FLIGHT_PENDING_STATUSES as readonly string[]).includes('pending_work_email'));
});

const read = (p: string) => readFileSync(join(process.cwd(), p), 'utf8');

test('the loader reads every master row and all six sources, with no off-boarded exemption', () => {
  const src = read('src/lib/hr/work-email-server.ts');
  for (const table of [
    'global_master_list',
    'employee_ids',
    'employee_roles',
    'offboarded_sheet',
    'employee_hourly_rates_current',
    'hr_pending_employees',
  ]) {
    assert.match(src, new RegExp(`from\\("${table}"\\)`), table);
  }
  assert.doesNotMatch(src, /off_boarded_at/, 'the master read must not filter or branch on off_boarded_at');
  assert.doesNotMatch(src, /freed/, 'no address may be freed from the history sources');
});

test('every reclaim path asks mayReclaimWhenWorkspaceMissing before trusting "missing"', () => {
  const suggest = read('app/api/hr/work-email/suggest/route.ts');
  assert.equal((suggest.match(/mayReclaimWhenWorkspaceMissing\(/g) ?? []).length, 2);
  const server = read('src/lib/hr/work-email-server.ts');
  const fn = server.slice(server.indexOf('export async function workEmailIssueDenial('));
  const gate = fn.indexOf('mayReclaimWhenWorkspaceMissing(');
  const verify = fn.indexOf('verifyWorkspaceAccount(');
  assert.ok(gate > 0 && gate < verify, 'the record check must run before the stale-claim verify');
});

test('both routes that WRITE a work email run workEmailIssueDenial before writing', () => {
  const set = read('app/api/hr/onboarding-submissions/[id]/set-work-email/route.ts');
  const setGate = set.indexOf('workEmailIssueDenial(workEmail, row.work_email)');
  assert.ok(setGate > 0, 'set-work-email must gate');
  assert.ok(setGate < set.indexOf('updateHrPendingEmployee('), 'gate before the pending update');
  assert.ok(setGate < set.indexOf('createHrPendingEmployee('), 'gate before the pending insert');
  assert.ok(setGate < set.indexOf('createWorkspaceAccount('), 'gate before the Workspace create');

  // PATCH used to write any address with no check at all.
  const patch = read('app/api/hr/pending-employees/[id]/route.ts');
  const patchGate = patch.indexOf('workEmailIssueDenial(body.work_email, current.work_email)');
  assert.ok(patchGate > 0, 'PATCH must gate');
  assert.ok(patchGate < patch.indexOf('updateHrPendingEmployee(id, body)'), 'gate before the update');
  assert.ok(
    patch.indexOf('current.promoted_to_master_id') < patchGate,
    'a hire linked to a master row may not change address on the staged row',
  );
});
