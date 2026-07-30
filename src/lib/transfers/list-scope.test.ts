/**
 * Contract for GET /api/department-transfers dispatch: which list each
 * (roles, scope) pair is served. This contract regressed once — the HR/admin
 * unscoped default was repurposed from "every request" to "my own outbox" to
 * fix the admin action-queue tabs, which silently emptied the HR read-only
 * history tab (HR coordinators raise no transfers). The full trail now lives
 * behind the explicit `all` scope; these tests pin both sides so neither
 * surface can hollow out the other again.
 *
 * Run:  npx tsx --test src/lib/transfers/list-scope.test.ts
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { resolveTransferListQuery } from './list-scope';

test('HR scope=all gets the full trail (the HR Transfers history tab)', () => {
  assert.equal(resolveTransferListQuery(['hr_coordinator'], 'all'), 'all-requests');
});

test('admin scope=all gets the full trail', () => {
  assert.equal(resolveTransferListQuery(['admin'], 'all'), 'all-requests');
});

test('HR/admin scoped tabs split by status across all teams', () => {
  assert.equal(resolveTransferListQuery(['admin'], 'incoming'), 'all-pending');
  assert.equal(resolveTransferListQuery(['admin'], 'done'), 'all-resolved');
  assert.equal(resolveTransferListQuery(['hr_coordinator'], 'incoming'), 'all-pending');
  assert.equal(resolveTransferListQuery(['hr_coordinator'], 'done'), 'all-resolved');
});

test('HR/admin default (no scope) stays the personal outbox, NOT the full trail', () => {
  assert.equal(resolveTransferListQuery(['admin'], null), 'own-outbox');
  assert.equal(resolveTransferListQuery(['hr_coordinator'], null), 'own-outbox');
});

test('admin+manager using the manager UI outbox tab (scope=outgoing) gets their outbox', () => {
  assert.equal(resolveTransferListQuery(['admin', 'manager'], 'outgoing'), 'own-outbox');
});

test('manager scopes narrow to departments they manage', () => {
  assert.equal(resolveTransferListQuery(['manager'], 'incoming'), 'dept-incoming');
  assert.equal(resolveTransferListQuery(['manager'], 'done'), 'dept-resolved');
  assert.equal(resolveTransferListQuery(['manager'], 'outgoing'), 'own-outbox');
  assert.equal(resolveTransferListQuery(['manager'], null), 'own-outbox');
});

test('plain managers cannot pull the company-wide trail via scope=all', () => {
  assert.equal(resolveTransferListQuery(['manager'], 'all'), 'own-outbox');
});

test('hr_coordinator + manager resolves through the HR branch (route order)', () => {
  assert.equal(resolveTransferListQuery(['hr_coordinator', 'manager'], 'all'), 'all-requests');
  assert.equal(resolveTransferListQuery(['hr_coordinator', 'manager'], 'incoming'), 'all-pending');
});

test('no qualifying role is forbidden regardless of scope', () => {
  assert.equal(resolveTransferListQuery([], null), 'forbidden');
  assert.equal(resolveTransferListQuery(['employee'], 'all'), 'forbidden');
  assert.equal(resolveTransferListQuery(['tickets'], 'incoming'), 'forbidden');
});

test('unknown scope strings fall to the default branch, never throw', () => {
  assert.equal(resolveTransferListQuery(['admin'], 'bogus'), 'own-outbox');
  assert.equal(resolveTransferListQuery(['manager'], 'bogus'), 'own-outbox');
});
