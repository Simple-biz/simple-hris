/**
 * Kane, 2026-10-02: rob@simple.biz keeps People → View but never sees Pay.
 * Pins the exclusion and that the server route and both PeopleTab mounts apply it.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

import {
  EXCLUDED_PAY_ERROR,
  isExcludedFromPayAction,
  PAY_ACTION_EXCLUSIONS,
} from './pay-action-exclusions';

test('rob@ is excluded', () => {
  assert.equal(isExcludedFromPayAction('rob@simple.biz'), true);
  assert.equal(PAY_ACTION_EXCLUSIONS.length, 1);
});

test('case and whitespace do not smuggle an excluded account through', () => {
  assert.equal(isExcludedFromPayAction('  Rob@Simple.biz '), true);
});

test('the other CEO-role holders and the other Robs pass', () => {
  assert.equal(isExcludedFromPayAction('carla@simple.biz'), false);
  assert.equal(isExcludedFromPayAction('accounting@simple.biz'), false);
  assert.equal(isExcludedFromPayAction('robt@simple.biz'), false);
  assert.equal(isExcludedFromPayAction('robp@simple.biz'), false);
});

test('a blank is not excluded (it is refused elsewhere, as "not signed in")', () => {
  assert.equal(isExcludedFromPayAction(''), false);
  assert.equal(isExcludedFromPayAction(null), false);
});

test('the refusal reads as Not authorized so the route answers 403', () => {
  assert.ok(EXCLUDED_PAY_ERROR.startsWith('Not authorized'));
});

const read = (...p: string[]) => fs.readFileSync(path.join(process.cwd(), ...p), 'utf8');

test('the Pay route refuses an excluded session, and both PeopleTab mounts hide Pay for it', () => {
  const route = read('app', 'api', 'people', 'pay', 'route.ts');
  assert.ok(route.includes('isExcludedFromPayAction(authz.sessionEmail)'), 'the route does not apply the exclusion');
  assert.ok(route.includes('status: 403'), 'the route does not answer 403');

  const ceo = read('src', 'components', 'ceo', 'CeoApp.tsx');
  assert.ok(/canPay=\{[^}]*isExcludedFromPayAction\(viewerEmail\)/.test(ceo), 'CEO People still shows Pay to an excluded account');

  const app = read('src', 'App.tsx');
  assert.ok(/canPay=\{[^}]*isExcludedFromPayAction\(sessionEmail\)/.test(app), 'Accounting People still shows Pay to an excluded account');
});
