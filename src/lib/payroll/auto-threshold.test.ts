import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  AUTO_THRESHOLD_AUDIT_ACTION,
  AUTO_THRESHOLD_LIMIT_USD,
  AUTO_THRESHOLD_RUN_STALE_MS,
  autoFlaggedEmails,
  autoThresholdCandidates,
  autoThresholdCreatedBy,
  clearedThresholdEmails,
  isAutoThresholdRecord,
  isAutoThresholdRunStale,
  isUnderAutoThreshold,
  parseAutoThresholdCandidate,
  parseWizardLockedFlag,
  planAutoThreshold,
  type AutoThresholdCandidate,
} from './auto-threshold';
import { actorLabel } from './undo-history';
import { familyForAction } from '@/lib/audit/registry';

/**
 * Kane 2026-09-29: anything under US$15.00 is held at Threshold automatically
 * when Payment Dispatch loads. These pin the boundary (exactly $15.00 is PAID),
 * that an unknown amount is never "small", that only wizard-priced employee
 * rows qualify, and that a Clear sticks for the week.
 */

type Row = Parameters<typeof autoThresholdCandidates>[0][number];

function row(over: Partial<Row> = {}): Row {
  return {
    id: 'ana@simple.biz',
    name: 'Ana Reyes',
    processor: 'hurupay',
    bankPreferredRaw: 'hurupay',
    amountUSD: 3.25,
    amountPHP: 190.5,
    amountCOP: null,
    payeeKind: 'employee',
    valuesSource: 'lock',
    ...over,
  };
}

test('the limit is strict: $14.99 is held, exactly $15.00 is paid', () => {
  assert.equal(AUTO_THRESHOLD_LIMIT_USD, 15);
  assert.equal(isUnderAutoThreshold(14.99), true);
  assert.equal(isUnderAutoThreshold(15), false);
  assert.equal(isUnderAutoThreshold(15.01), false);
});

test('zero and a negative week (withholding > pay) are under — clerks already held those', () => {
  assert.equal(isUnderAutoThreshold(0), true);
  assert.equal(isUnderAutoThreshold(-59.73), true);
});

test('an unknown amount is never "small"', () => {
  assert.equal(isUnderAutoThreshold(null), false);
  assert.equal(isUnderAutoThreshold(undefined), false);
  assert.equal(isUnderAutoThreshold(Number.NaN), false);
  assert.equal(isUnderAutoThreshold(Number.NEGATIVE_INFINITY), false);
});

test('candidates: wizard-priced employees under $15 only', () => {
  const out = autoThresholdCandidates([
    row({ id: 'lock@x.com', valuesSource: 'lock', amountUSD: 4 }),
    row({ id: 'snap@x.com', valuesSource: 'snapshot', amountUSD: 2 }),
    row({ id: 'recomputed@x.com', valuesSource: 'recomputed', amountUSD: 1 }),
    row({ id: 'nosource@x.com', valuesSource: undefined, amountUSD: 1 }),
    row({ id: 'contractor@x.com', payeeKind: 'contractor', amountUSD: 1 }),
    row({ id: 'big@x.com', amountUSD: 15 }),
    row({ id: 'unpriced@x.com', amountUSD: null }),
  ]);
  assert.deepEqual(
    out.map((c) => c.recipient_email),
    ['lock@x.com', 'snap@x.com'],
  );
});

test('candidates are keyed on the lowercased queue id, once per person', () => {
  const out = autoThresholdCandidates([row({ id: 'Ana@Simple.Biz' }), row({ id: 'ana@simple.biz' })]);
  assert.equal(out.length, 1);
  assert.equal(out[0].recipient_email, 'ana@simple.biz');
});

test('a COP-paid person is judged on the same USD figure', () => {
  const out = autoThresholdCandidates([row({ amountUSD: 9, amountCOP: 36000, amountPHP: 525 })]);
  assert.equal(out.length, 1);
  assert.equal(out[0].amount_cop, 36000);
});

function body(over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    recipient_email: ' Ana@Simple.biz ',
    recipient_name: 'Ana',
    processor: 'wise',
    bank_preferred_raw: 'x1153',
    amount_usd: 3.5,
    amount_php: 200,
    amount_cop: null,
    values_source: 'snapshot',
    ...over,
  };
}

test('server re-validation accepts a qualifying row and normalises the email', () => {
  const c = parseAutoThresholdCandidate(body());
  assert.ok(c);
  assert.equal(c.recipient_email, 'ana@simple.biz');
  assert.equal(c.processor, 'wise');
});

test('server re-validation refuses anything the page should not have sent', () => {
  assert.equal(parseAutoThresholdCandidate(body({ amount_usd: 15 })), null, 'exactly $15');
  assert.equal(parseAutoThresholdCandidate(body({ amount_usd: '3' })), null, 'string amount');
  assert.equal(parseAutoThresholdCandidate(body({ amount_usd: null })), null, 'unknown amount');
  assert.equal(parseAutoThresholdCandidate(body({ values_source: 'recomputed' })), null, 'recomputed');
  assert.equal(parseAutoThresholdCandidate(body({ values_source: undefined })), null, 'no source');
  assert.equal(parseAutoThresholdCandidate(body({ processor: 'paypal' })), null, 'unknown rail');
  assert.equal(parseAutoThresholdCandidate(body({ recipient_email: 'nobody' })), null, 'no email');
  assert.equal(parseAutoThresholdCandidate(body({ amount_php: 'lots' })), null, 'bad php');
  assert.equal(parseAutoThresholdCandidate(null), null);
  assert.equal(parseAutoThresholdCandidate('x'), null);
});

function cand(email: string): AutoThresholdCandidate {
  return parseAutoThresholdCandidate(body({ recipient_email: email }))!;
}

test('plan: anyone with a dispatch row this week is left alone', () => {
  const plan = planAutoThreshold({
    candidates: [cand('a@x.com'), cand('b@x.com')],
    dispatchedEmails: new Set(['a@x.com']),
    clearedEmails: new Set(),
    autoFlaggedEmails: new Set(),
  });
  assert.deepEqual(plan.flag.map((c) => c.recipient_email), ['b@x.com']);
  assert.equal(plan.skipped.already_dispatched, 1);
});

test('plan: a Clear sticks — a person someone un-held is never re-held that week', () => {
  const plan = planAutoThreshold({
    candidates: [cand('cleared@x.com')],
    dispatchedEmails: new Set(),
    clearedEmails: new Set(['cleared@x.com']),
    autoFlaggedEmails: new Set(['cleared@x.com']),
  });
  assert.equal(plan.flag.length, 0);
  assert.equal(plan.skipped.cleared, 1);
});

test('plan: the rule acts once per person per week even without a Clear event', () => {
  const plan = planAutoThreshold({
    candidates: [cand('once@x.com')],
    dispatchedEmails: new Set(),
    clearedEmails: new Set(),
    autoFlaggedEmails: new Set(['once@x.com']),
  });
  assert.equal(plan.flag.length, 0);
  assert.equal(plan.skipped.already_auto, 1);
});

test('plan: duplicates in one request write one marker', () => {
  const plan = planAutoThreshold({
    candidates: [cand('dup@x.com'), cand('DUP@x.com')],
    dispatchedEmails: new Set(),
    clearedEmails: new Set(),
    autoFlaggedEmails: new Set(),
  });
  assert.equal(plan.flag.length, 1);
  assert.equal(plan.skipped.duplicate, 1);
});

test('ledger: only a cleared THRESHOLD counts as a Clear', () => {
  const cleared = clearedThresholdEmails([
    { action: 'payment.undone', details: { original_status: 'threshold', recipient_email: 'T@x.com' } },
    { action: 'payment.undone', details: { original_status: 'paid', recipient_email: 'paid@x.com' } },
    { action: 'payment.undone', details: { original_status: 'problem', recipient_email: 'problem@x.com' } },
    { action: 'payment.undone', details: { count: 0, ids: ['1'], no_rows_deleted: true } },
    { action: 'payment.dispatched', details: { status: 'threshold', recipient_email: 'd@x.com' } },
    { action: 'payment.undone', details: null },
  ]);
  assert.deepEqual([...cleared], ['t@x.com']);
});

test('ledger: auto-flagged emails come from the rule\'s own action only', () => {
  const auto = autoFlaggedEmails([
    { action: AUTO_THRESHOLD_AUDIT_ACTION, details: { recipient_email: 'Auto@x.com' } },
    { action: 'payment.dispatched', details: { recipient_email: 'manual@x.com' } },
  ]);
  assert.deepEqual([...auto], ['auto@x.com']);
});

test('the rule\'s audit action is registered (the route builds it from a constant the source scan cannot see)', () => {
  assert.equal(familyForAction(AUTO_THRESHOLD_AUDIT_ACTION)?.match, 'payment.');
});

test('the auto tag splits back out of created_by like a script actor', () => {
  const by = autoThresholdCreatedBy('lenny@simple.biz');
  assert.equal(by, 'lenny@simple.biz (auto-threshold)');
  assert.deepEqual(actorLabel(by), { email: 'lenny@simple.biz', script: 'auto-threshold' });
  assert.equal(isAutoThresholdRecord({ status: 'threshold', created_by: by }), true);
  assert.equal(isAutoThresholdRecord({ status: 'threshold', created_by: 'lenny@simple.biz' }), false);
  assert.equal(isAutoThresholdRecord({ status: 'paid', created_by: by }), false);
});

test('the run lock goes stale after a minute, and an unreadable claim is stale', () => {
  const now = Date.parse('2026-09-29T10:00:00Z');
  assert.equal(isAutoThresholdRunStale(new Date(now - 5_000).toISOString(), now), false);
  assert.equal(isAutoThresholdRunStale(new Date(now - AUTO_THRESHOLD_RUN_STALE_MS - 1).toISOString(), now), true);
  assert.equal(isAutoThresholdRunStale(null, now), true);
  assert.equal(isAutoThresholdRunStale('not a date', now), true);
});

test('wizard lock flag: only an explicit lock counts', () => {
  assert.equal(parseWizardLockedFlag(JSON.stringify({ locked: true, lockedBy: 'x' })), true);
  assert.equal(parseWizardLockedFlag('true'), true);
  assert.equal(parseWizardLockedFlag(JSON.stringify({ locked: false })), false);
  assert.equal(parseWizardLockedFlag(JSON.stringify({ locked: 'true' })), false);
  assert.equal(parseWizardLockedFlag(''), false);
  assert.equal(parseWizardLockedFlag(null), false);
  assert.equal(parseWizardLockedFlag('{broken'), false);
});
