import test from 'node:test';
import assert from 'node:assert/strict';
import { commentEmailRecipient, moveEmailRecipient } from './recipients';

const CREATOR = 'alissar@simple.biz';
const DEV = 'kaner@simple.biz';
const THIRD = 'carla@simple.biz';

test('a comment reaches the creator when someone else writes it', () => {
  const t = { created_by: CREATOR, assigned_to: DEV };
  assert.equal(commentEmailRecipient(t, DEV), CREATOR);
  assert.equal(commentEmailRecipient(t, THIRD), CREATOR);
});

test('the creator commenting notifies the assigned dev instead', () => {
  assert.equal(commentEmailRecipient({ created_by: CREATOR, assigned_to: DEV }, CREATOR), DEV);
});

test('nobody is ever emailed about their own comment', () => {
  // Creator with no dev, talking to themselves: no recipient at all.
  assert.equal(commentEmailRecipient({ created_by: CREATOR, assigned_to: null }, CREATOR), null);
  // Self-assigned ticket, one human involved: still nobody.
  assert.equal(commentEmailRecipient({ created_by: DEV, assigned_to: DEV }, DEV), null);
});

test('an unassigned ticket still tells its creator', () => {
  assert.equal(commentEmailRecipient({ created_by: CREATOR, assigned_to: null }, DEV), CREATOR);
});

test('email casing and whitespace never decide who gets mailed', () => {
  const t = { created_by: '  Alissar@Simple.BIZ ', assigned_to: 'KaneR@simple.biz' };
  // Actor is the creator under a different casing — must resolve to the dev.
  assert.equal(commentEmailRecipient(t, 'alissar@simple.biz'), 'kaner@simple.biz');
  // Actor is the dev under a different casing — must resolve to the creator.
  assert.equal(commentEmailRecipient(t, 'KANER@SIMPLE.BIZ'), 'alissar@simple.biz');
  assert.equal(moveEmailRecipient(t, 'ALISSAR@simple.biz'), null);
});

test('a move only ever reaches the creator, never the dev', () => {
  const t = { created_by: CREATOR, assigned_to: DEV };
  assert.equal(moveEmailRecipient(t, DEV), CREATOR);
  assert.equal(moveEmailRecipient(t, THIRD), CREATOR);
  // The creator moving their own card mails nobody — and the dev is NOT a
  // fallback here, which is the whole difference from the comment rule.
  assert.equal(moveEmailRecipient(t, CREATOR), null);
});

test('a blank creator yields no recipient rather than an empty To', () => {
  // n8n's Gmail node is stop-on-error: an empty sendTo fails the whole
  // workflow run, so the guard has to live here.
  assert.equal(moveEmailRecipient({ created_by: '', assigned_to: DEV }, DEV), null);
  assert.equal(commentEmailRecipient({ created_by: '   ', assigned_to: null }, DEV), null);
});
