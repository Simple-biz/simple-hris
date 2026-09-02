import { strict as assert } from 'node:assert';
import { test } from 'node:test';

import { INTERN_EMAIL_DOMAIN, isInternEmail } from './intern-email';

test('the intern domain is pathway.ph', () => {
  assert.equal(INTERN_EMAIL_DOMAIN, 'pathway.ph');
});

test('an @pathway.ph address is an intern, whatever the case or whitespace', () => {
  assert.equal(isInternEmail('maria@pathway.ph'), true);
  assert.equal(isInternEmail('  Maria@Pathway.PH '), true);
});

test('a Simple address is never an intern', () => {
  assert.equal(isInternEmail('kaner@simple.biz'), false);
  assert.equal(isInternEmail('randalh@hogansmith.com'), false);
});

test('look-alike domains do not qualify', () => {
  // A subdomain, a prefix, or the domain as a local part must not pass.
  assert.equal(isInternEmail('x@mail.pathway.ph'), false);
  assert.equal(isInternEmail('x@notpathway.ph'), false);
  assert.equal(isInternEmail('pathway.ph@simple.biz'), false);
});

test('empty / null / garbage is not an intern', () => {
  assert.equal(isInternEmail(null), false);
  assert.equal(isInternEmail(undefined), false);
  assert.equal(isInternEmail(''), false);
  assert.equal(isInternEmail('@pathway.ph'), false);
  assert.equal(isInternEmail('not-an-email'), false);
});
