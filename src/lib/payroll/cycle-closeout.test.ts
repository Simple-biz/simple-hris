import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import {
  CYCLE_CLOSEOUT_PREFIX,
  CYCLE_CLOSEOUT_VERSION,
  CYCLE_REOPENED_PREFIX,
  CYCLE_REOPEN_ROLES,
  MAX_STORED_UNPAID,
  buildCycleCloseoutRecord,
  canReopenCycle,
  cycleCloseoutKey,
  cycleReopenedKey,
  normalizeReportedUnpaid,
  parseCycleCloseout,
} from './cycle-closeout';

function dispatch(over: Record<string, unknown> = {}) {
  return {
    status: 'paid',
    payee_type: 'employee',
    recipient_email: 'anna@simple.biz',
    amount_usd: 100,
    amount_php: 5600,
    processor: 'hurupay',
    ...over,
  };
}

function build(over: Partial<Parameters<typeof buildCycleCloseoutRecord>[0]> = {}) {
  return buildCycleCloseoutRecord({
    sourceFile: 'simple-biz_daily_report_2026-08-02_to_2026-08-08.csv',
    cycleId: 'cycle-1',
    label: 'August 2-8, 2026',
    periodStart: '2026-08-02',
    periodEnd: '2026-08-08',
    closedBy: 'Lenny',
    closedByEmail: 'lenny@simple.biz',
    closedAt: '2026-08-10T04:00:00.000Z',
    dispatches: [dispatch()],
    reportedUnpaid: [],
    recordsOutstanding: null,
    ...over,
  });
}

describe('cycleCloseoutKey', () => {
  test('is namespaced per source file', () => {
    assert.equal(cycleCloseoutKey('a.csv'), 'dispatch.cycle_closeout.a.csv');
  });
});

describe('normalizeReportedUnpaid', () => {
  test('non-array input yields an empty list rather than throwing', () => {
    assert.deepEqual(normalizeReportedUnpaid(null), { payees: [], truncated: 0, dropped: 0 });
    assert.deepEqual(normalizeReportedUnpaid('nope'), { payees: [], truncated: 0, dropped: 0 });
  });

  test('drops entries with no email, and COUNTS the drop', () => {
    const out = normalizeReportedUnpaid([
      { email: 'a@simple.biz' },
      { name: 'No Email Person' },
      null,
      42,
    ]);
    assert.equal(out.payees.length, 1);
    assert.equal(out.dropped, 3);
  });

  test('lower-cases email and defaults an unknown reason to pending', () => {
    const out = normalizeReportedUnpaid([{ email: 'A@Simple.BIZ', reason: 'banana' }]);
    assert.equal(out.payees[0]!.email, 'a@simple.biz');
    assert.equal(out.payees[0]!.reason, 'pending');
  });

  test('keeps the three real reasons', () => {
    const out = normalizeReportedUnpaid([
      { email: 'a@x.com', reason: 'problem' },
      { email: 'b@x.com', reason: 'threshold' },
      { email: 'c@x.com', reason: 'pending' },
    ]);
    assert.deepEqual(
      out.payees.map((p) => p.reason).sort(),
      ['pending', 'problem', 'threshold'],
    );
  });

  test('non-numeric amounts become null, never 0 — an unknown amount is not "nothing owed"', () => {
    const out = normalizeReportedUnpaid([{ email: 'a@x.com', amountPHP: 'abc', amountUSD: null }]);
    assert.equal(out.payees[0]!.amountPHP, null);
    assert.equal(out.payees[0]!.amountUSD, null);
  });

  test('caps the list and REPORTS what it cut — a silent truncation would read as "that is everyone"', () => {
    const many = Array.from({ length: MAX_STORED_UNPAID + 7 }, (_, i) => ({
      email: `p${i}@simple.biz`,
      amountPHP: i,
    }));
    const out = normalizeReportedUnpaid(many);
    assert.equal(out.payees.length, MAX_STORED_UNPAID);
    assert.equal(out.truncated, 7);
    // Biggest money survives the cap.
    assert.equal(out.payees[0]!.amountPHP, MAX_STORED_UNPAID + 6);
  });
});

describe('buildCycleCloseoutRecord', () => {
  test('paid totals are recomputed from dispatch rows, never taken from the caller', () => {
    const rec = build({
      dispatches: [
        dispatch({ recipient_email: 'a@x.com' }),
        dispatch({ recipient_email: 'b@x.com', amount_usd: 50, amount_php: 2800 }),
      ],
    });
    assert.equal(rec.paid.payeeCount, 2);
    assert.equal(rec.paid.dispatchCount, 2);
    assert.equal(rec.paid.paidUSD, 150);
    assert.equal(rec.paid.paidPHP, 8400);
  });

  test('a superseded marker does not inflate the paid tally or the payee count', () => {
    // Not Paid (bank glitch) → retried → Paid. Both rows live in the cycle forever.
    const rec = build({
      dispatches: [
        dispatch({ status: 'not_paid', amount_usd: 0, amount_php: 0 }),
        dispatch({ status: 'paid' }),
      ],
    });
    assert.equal(rec.paid.payeeCount, 1);
    assert.equal(rec.paid.dispatchCount, 1);
    assert.equal(rec.paid.paidUSD, 100);
  });

  test('contractors count per invoice, employees per distinct email', () => {
    const rec = build({
      dispatches: [
        dispatch({ recipient_email: 'claire@x.com' }),
        dispatch({ recipient_email: 'claire@x.com' }),
        dispatch({ recipient_email: 'claire@x.com', payee_type: 'contractor' }),
        dispatch({ recipient_email: 'claire@x.com', payee_type: 'contractor' }),
      ],
    });
    // One employee identity + two contractor settlements.
    assert.equal(rec.paid.employeeCount, 1);
    assert.equal(rec.paid.contractorCount, 2);
    assert.equal(rec.paid.payeeCount, 3);
  });

  test('byProcessor only counts paid rows', () => {
    const rec = build({
      dispatches: [
        dispatch({ processor: 'wise', recipient_email: 'a@x.com' }),
        dispatch({ processor: 'wires', recipient_email: 'b@x.com', status: 'problem' }),
      ],
    });
    assert.equal(rec.byProcessor.wise?.count, 1);
    assert.equal(rec.byProcessor.wires, undefined);
  });

  test('a dispatch with no processor buckets as unknown rather than crashing', () => {
    const rec = build({ dispatches: [dispatch({ processor: null })] });
    assert.equal(rec.byProcessor.unknown?.count, 1);
  });

  test('unpaid money and counts add up from the reported list', () => {
    const rec = build({
      reportedUnpaid: [
        { email: 'a@x.com', amountPHP: 1000, amountUSD: 18, reason: 'pending' },
        { email: 'b@x.com', amountPHP: 500, amountUSD: 9, reason: 'problem' },
        { email: 'c@x.com', amountPHP: 250, payeeType: 'contractor', reason: 'threshold' },
      ],
    });
    assert.equal(rec.unpaid.count, 3);
    assert.equal(rec.unpaid.employeeCount, 2);
    assert.equal(rec.unpaid.contractorCount, 1);
    assert.equal(rec.unpaid.totalPHP, 1750);
    assert.equal(rec.unpaid.totalUSD, 27);
  });

  test('the unpaid list is always marked as clerk-reported, never as server truth', () => {
    assert.equal(build().unpaid.source, 'dispatch_screen');
  });

  test('a failed cross-check is recorded as null, not as zero outstanding', () => {
    assert.equal(build({ recordsOutstanding: null }).records_outstanding, null);
  });

  test('stamps the version', () => {
    assert.equal(build().version, CYCLE_CLOSEOUT_VERSION);
  });
});

describe('parseCycleCloseout', () => {
  test('round-trips a real record', () => {
    const rec = build({ reportedUnpaid: [{ email: 'a@x.com', amountPHP: 10 }] });
    const back = parseCycleCloseout(JSON.stringify(rec));
    assert.deepEqual(back, rec);
  });

  test('returns null on junk instead of throwing — one bad row must not blank the tab', () => {
    assert.equal(parseCycleCloseout('not json'), null);
    assert.equal(parseCycleCloseout('null'), null);
    assert.equal(parseCycleCloseout('{}'), null);
    assert.equal(parseCycleCloseout(JSON.stringify({ source_file: 'a.csv' })), null);
  });

  test('rejects a record whose paid totals are not numbers (the UI calls toLocaleString on them)', () => {
    const rec = build() as unknown as Record<string, unknown>;
    (rec.paid as Record<string, unknown>).paidUSD = 'lots';
    assert.equal(parseCycleCloseout(JSON.stringify(rec)), null);
  });

  test('repairs soft fields rather than rejecting the record', () => {
    const rec = JSON.parse(JSON.stringify(build())) as Record<string, unknown>;
    delete rec.byProcessor;
    delete (rec.unpaid as Record<string, unknown>).payees;
    rec.label = '';
    rec.closed_by = '';
    const back = parseCycleCloseout(JSON.stringify(rec));
    assert.ok(back);
    assert.deepEqual(back.byProcessor, {});
    assert.deepEqual(back.unpaid.payees, []);
    assert.equal(back.label, back.source_file);
    assert.equal(back.closed_by, 'lenny@simple.biz');
  });
});

/**
 * Reopening a closed week (2026-08-14). The archive must be invisible to the
 * "which weeks are closed" scan, or a reopened week reads as still closed —
 * which is the exact thing a reopen exists to undo.
 */
describe('reopen — archive key and role gate', () => {
  const SF = 'simple-biz_daily_report_2026-08-02_to_2026-08-08.csv';
  const TS = '2026-08-14T12:34:56.789Z';

  /** SQL LIKE, as PostgREST applies it in listCycleCloseouts: `%` spans any run
   *  of characters and `_` matches exactly one. Modelling it (rather than a
   *  startsWith) is the point — `_` is a WILDCARD in the closeout prefix. */
  const likeMatches = (key: string, pattern: string): boolean => {
    let rx = '';
    for (const ch of pattern) {
      if (ch === '%') rx += '[\\s\\S]*';
      else if (ch === '_') rx += '[\\s\\S]';
      // Everything else is literal — `.` included, which is why a plain
      // startsWith would model this wrong in the other direction.
      else rx += ch.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    }
    return new RegExp(`^${rx}$`).test(key);
  };

  test('the closeout prefix scan never catches an archived record', () => {
    const scan = `${CYCLE_CLOSEOUT_PREFIX}%`;
    assert.equal(likeMatches(cycleCloseoutKey(SF), scan), true);
    assert.equal(likeMatches(cycleReopenedKey(SF, TS), scan), false);
  });

  test('the two prefixes are disjoint — neither is a prefix of the other', () => {
    assert.equal(CYCLE_REOPENED_PREFIX.startsWith(CYCLE_CLOSEOUT_PREFIX), false);
    assert.equal(CYCLE_CLOSEOUT_PREFIX.startsWith(CYCLE_REOPENED_PREFIX), false);
  });

  test('each reopen gets its own key — closing twice never overwrites history', () => {
    const a = cycleReopenedKey(SF, TS);
    const b = cycleReopenedKey(SF, '2026-08-15T09:00:00.000Z');
    assert.notEqual(a, b);
    assert.ok(a.includes(SF));
  });

  test('reopen is admin / payroll_manager only — closing rights are not enough', () => {
    assert.deepEqual([...CYCLE_REOPEN_ROLES], ['payroll_manager', 'admin']);
    assert.equal(canReopenCycle(['admin']), true);
    assert.equal(canReopenCycle(['payroll_manager']), true);
    assert.equal(canReopenCycle(['payroll_coordinator', 'finance', 'accounting']), false);
    assert.equal(canReopenCycle([]), false);
    assert.equal(canReopenCycle(null), false);
    assert.equal(canReopenCycle(undefined), false);
  });
});
