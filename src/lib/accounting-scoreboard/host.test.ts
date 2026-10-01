/** Run: node --import tsx --test src/lib/accounting-scoreboard/host.test.ts */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { decideScoreboardHost, normalizeHost, SCOREBOARD_PAGE } from './host';
import { requiredRolesFor } from '@/lib/auth/route-access';

const HOST = 'accounting-bonus.vercel.app';
const on = (pathname: string, host: string = HOST) =>
  decideScoreboardHost({ host, configuredHost: HOST, pathname });

test('inert until ACCOUNTING_SCOREBOARD_HOST is set', () => {
  for (const configuredHost of [undefined, null, '', '   ']) {
    assert.deepEqual(decideScoreboardHost({ host: HOST, configuredHost, pathname: '/admin' }), { action: 'pass' });
  }
});

test('every other host is untouched, the main HRIS host included', () => {
  for (const host of ['simple-hris.vercel.app', 'localhost:3000', null]) {
    assert.deepEqual(on('/admin', host as string), { action: 'pass' });
    assert.deepEqual(on('/api/payment-dispatches', host as string), { action: 'pass' });
  }
});

test('host matching ignores case and a port', () => {
  assert.equal(normalizeHost('Accounting-Bonus.Vercel.App:443'), HOST);
  assert.deepEqual(on('/admin', 'ACCOUNTING-BONUS.vercel.app'), { action: 'redirect', pathname: SCOREBOARD_PAGE });
});

test('on the scoreboard host: the board, its API and sign-in pass', () => {
  for (const p of [
    '/accounting-scoreboard',
    '/accounting-scoreboard/anything',
    '/api/accounting-scoreboard',
    '/api/accounting-scoreboard/entries',
    '/login',
    '/auth-callback',
    '/api/auth/session',
    '/api/auth/callback/google',
  ]) {
    assert.deepEqual(on(p), { action: 'pass' }, p);
  }
});

test('on the scoreboard host: every other page goes to the board, the bare host included', () => {
  for (const p of ['/', '/admin', '/accounting', '/employee', '/update-bank-info', '/update-gift-address', '/onboarding/x', '/accounting-scoreboardx']) {
    assert.deepEqual(on(p), { action: 'redirect', pathname: SCOREBOARD_PAGE }, p);
  }
});

test('on the scoreboard host: every other API is refused (403, so pollers stop)', () => {
  for (const p of ['/api', '/api/employee-roles', '/api/payment-dispatches/recent-paid', '/api/external/v1/global-master-list', '/api/cron/x', '/api/bank-update/save', '/api/authx']) {
    assert.deepEqual(on(p), { action: 'forbid_api' }, p);
  }
});

test('the board route is NOT role-gated at the edge; membership is checked by the page and the API', () => {
  // '/accounting' (accounting + admin) must not swallow '/accounting-scoreboard':
  // most PH team members hold no HRIS role at all.
  assert.equal(requiredRolesFor('/accounting-scoreboard'), null);
  // The archive page (backfill, 2026-10-01) is gated the same way, by its own page.
  assert.equal(requiredRolesFor('/accounting-scoreboard/archive'), null);
  assert.deepEqual(requiredRolesFor('/accounting'), ['accounting', 'admin']);
});
