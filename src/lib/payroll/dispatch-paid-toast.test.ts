import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  PAID_TOAST_MAX,
  PAID_TOAST_TOPIC,
  buildPaidToastEvent,
  formatPaidLine,
  paidAmountParts,
  parsePaidToastPayload,
  pushPaidToast,
  shouldAnnouncePaid,
  foldRecentPaidRows,
  PAID_TOAST_FRESH_MS,
  remotePaidHidesRow,
  hidePaidElsewhere,
  type PaidToastEvent,
} from './dispatch-paid-toast';

const evt = (id: string, extra: Partial<PaidToastEvent> = {}): PaidToastEvent => ({
  id,
  by: 'lenny@simple.biz',
  recipientEmail: 'kaner@simple.biz',
  recipientName: 'Kane R',
  amountUsd: 2700,
  amountPhp: 151200,
  amountCop: null,
  processor: 'hurupay',
  sourceFile: 'hubstaff-2026-08-23.csv',
  ts: 1,
  ...extra,
});

test('the topic is its own — never the queue sync topic', () => {
  // realtime-js channel() returns the EXISTING channel for a repeated topic, so
  // sharing `payment-dispatch-sync` would let one hook's removeChannel kill the
  // other's subscription.
  assert.notEqual(PAID_TOAST_TOPIC, 'payment-dispatch-sync');
  assert.notEqual(PAID_TOAST_TOPIC, 'payments-live');
});

test('only a paid row announces', () => {
  assert.equal(shouldAnnouncePaid('paid'), true);
  assert.equal(shouldAnnouncePaid(' Paid '), true);
  for (const s of ['problem', 'not_paid', 'threshold', '', null, undefined]) {
    assert.equal(shouldAnnouncePaid(s), false, String(s));
  }
});

test('formatPaidLine reads "by paid recipient $amount"', () => {
  assert.equal(formatPaidLine(evt('a')), 'lenny@simple.biz paid kaner@simple.biz $2,700.00');
});

test('amounts: USD leads with PHP beneath; COP-only leads with COP', () => {
  assert.deepEqual(paidAmountParts(evt('a')), { primary: '$2,700.00', secondary: '₱151,200.00' });
  assert.deepEqual(paidAmountParts({ amountUsd: null, amountPhp: 5000, amountCop: null }), {
    primary: '₱5,000.00',
    secondary: null,
  });
  assert.deepEqual(paidAmountParts({ amountUsd: null, amountPhp: null, amountCop: 8000 }), {
    primary: '$COP8.000',
    secondary: null,
  });
  assert.deepEqual(paidAmountParts({ amountUsd: null, amountPhp: null, amountCop: null }), {
    primary: '—',
    secondary: null,
  });
});

test('pushPaidToast appends newest-last, de-dupes by id, caps by dropping the oldest', () => {
  let stack: PaidToastEvent[] = [];
  stack = pushPaidToast(stack, evt('1'));
  stack = pushPaidToast(stack, evt('2'));
  assert.deepEqual(stack.map((t) => t.id), ['1', '2']);

  // The same row arriving again (local + broadcast) is the SAME array back.
  const same = pushPaidToast(stack, evt('2'));
  assert.equal(same, stack);

  for (const id of ['3', '4', '5', '6']) stack = pushPaidToast(stack, evt(id));
  assert.equal(stack.length, PAID_TOAST_MAX);
  assert.deepEqual(stack.map((t) => t.id), ['3', '4', '5', '6']);
});

test('buildPaidToastEvent lowercases, normalises, and never loses a toast to a missing id', () => {
  const e = buildPaidToastEvent({
    id: undefined,
    by: ' Lenny@Simple.biz ',
    recipientEmail: 'Kaner@Simple.biz',
    recipientName: '  ',
    amountUsd: 2700,
    sourceFile: 'f.csv',
    now: 42,
  });
  assert.equal(e.by, 'lenny@simple.biz');
  assert.equal(e.recipientEmail, 'kaner@simple.biz');
  assert.equal(e.recipientName, null);
  assert.equal(e.id, 'kaner@simple.biz:f.csv:42');
  assert.equal(e.amountPhp, null);
  assert.equal(buildPaidToastEvent({ id: 'row-1', by: null, recipientEmail: 'x@y.z' }).by, 'accounting');
});

test('parsePaidToastPayload drops anything naming nobody', () => {
  assert.equal(parsePaidToastPayload(null), null);
  assert.equal(parsePaidToastPayload('nope'), null);
  assert.equal(parsePaidToastPayload({ id: 'a', by: 'x@y.z' }), null);
  assert.equal(parsePaidToastPayload({ id: 'a', recipientEmail: 'x@y.z' }), null);
  const ok = parsePaidToastPayload({
    id: 'a',
    by: 'LENNY@simple.biz',
    recipientEmail: 'kaner@simple.biz',
    amountUsd: '2700',
    ts: 5,
  });
  assert.ok(ok);
  assert.equal(ok.by, 'lenny@simple.biz');
  assert.equal(ok.amountUsd, 2700);
  assert.equal(ok.amountPhp, null);
  assert.equal(ok.ts, 5);
});

const NOW = Date.parse('2026-09-02T12:00:00Z');
const row = (id: string, secondsAgo: number, extra: Record<string, unknown> = {}) => ({
  id,
  created_by: 'lenny@simple.biz',
  recipient_email: 'Kaner@Simple.biz',
  recipient_name: 'Kane',
  amount_usd: 2700,
  amount_php: '151200',
  amount_cop: null,
  processor: 'hurupay',
  cycle_source_file: 'f.csv',
  created_at: new Date(NOW - secondsAgo * 1000).toISOString(),
  ...extra,
});

test('foldRecentPaidRows: fresh remote rows become events, oldest first', () => {
  const { events } = foldRecentPaidRows([row('b', 5), row('a', 20)], {
    selfEmail: 'kane@simple.biz',
    serverNow: NOW,
  });
  assert.deepEqual(events.map((e) => e.id), ['a', 'b']);
  assert.equal(events[0].by, 'lenny@simple.biz');
  assert.equal(events[0].recipientEmail, 'kaner@simple.biz');
  assert.equal(events[0].amountPhp, 151200);
  assert.equal(formatPaidLine(events[0]), 'lenny@simple.biz paid kaner@simple.biz $2,700.00');
});

test('foldRecentPaidRows: OWN rows are skipped — the local path already showed them', () => {
  const { events, skippedOwn } = foldRecentPaidRows([row('a', 5, { created_by: 'LENNY@simple.biz' })], {
    selfEmail: 'lenny@simple.biz',
    serverNow: NOW,
  });
  assert.equal(events.length, 0);
  assert.equal(skippedOwn, 1);
});

test('foldRecentPaidRows: stale rows are skipped, judged by the server clock', () => {
  const { events, skippedStale } = foldRecentPaidRows(
    [row('old', PAID_TOAST_FRESH_MS / 1000 + 1), row('new', 3)],
    { selfEmail: null, serverNow: NOW },
  );
  assert.deepEqual(events.map((e) => e.id), ['new']);
  assert.equal(skippedStale, 1);
});

test('foldRecentPaidRows: a row naming nobody is dropped; a missing actor reads "accounting"', () => {
  const { events } = foldRecentPaidRows(
    [
      row('x', 1, { recipient_email: '' }),
      { created_by: 'a@b.c', recipient_email: 'x@y.z' },
      row('ok', 1, { created_by: null }),
    ],
    { selfEmail: null, serverNow: NOW },
  );
  assert.deepEqual(events.map((e) => e.id), ['ok']);
  assert.equal(events[0].by, 'accounting');
});

test('remotePaidHidesRow: same cycle hides, a different cycle does not, unknown cycle hides', () => {
  assert.equal(remotePaidHidesRow({ sourceFile: 'a.csv' }, 'a.csv'), true);
  assert.equal(remotePaidHidesRow({ sourceFile: 'a.csv' }, 'b.csv'), false);
  assert.equal(remotePaidHidesRow({ sourceFile: null }, 'a.csv'), true);
  assert.equal(remotePaidHidesRow({ sourceFile: 'a.csv' }, null), true);
});

test('hidePaidElsewhere: filters by normalised email and returns the same array when idle', () => {
  const rows = [{ email: 'A@x.y', v: 1 }, { email: 'b@x.y', v: 2 }];
  assert.equal(hidePaidElsewhere(rows, new Set()), rows);
  assert.deepEqual(hidePaidElsewhere(rows, new Set(['a@x.y'])).map((r) => r.v), [2]);
});
