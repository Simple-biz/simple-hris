import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { mapPayloadToPayStub } from '@/lib/payroll/paystub-view';
import { wizardKpiLiveAllowed } from '@/lib/payroll/wizard-kpi-load';
import {
  PAYSTUB_REFRESH_READS,
  READ,
  diffPayStubViews,
  failedRead,
  joinLabels,
  payStubDetailsChanged,
  paystubRefreshBlockedReason,
  skippedRead,
  summarizePaystubRefresh,
  type PaystubRefreshOutcomes,
} from './paystub-refresh';

// ── The gate ─────────────────────────────────────────────────────────────────

test('the Refresh runs exactly when the KPI live refresh may — every combination', () => {
  for (const isReplay of [false, true]) {
    for (const processingLocked of [false, true]) {
      for (const valuesLockLoading of [false, true]) {
        for (const valuesLocked of [false, true]) {
          const s = { isReplay, processingLocked, valuesLockLoading, valuesLocked };
          assert.equal(
            paystubRefreshBlockedReason(s) === null,
            wizardKpiLiveAllowed(s),
            `gates disagree for ${JSON.stringify(s)}`,
          );
        }
      }
    }
  }
});

test('a locked cycle names the way out instead of doing nothing', () => {
  const r = paystubRefreshBlockedReason({
    isReplay: false,
    processingLocked: false,
    valuesLockLoading: false,
    valuesLocked: true,
  });
  assert.match(r ?? '', /Unlock Payment Dispatch/);
});

test('an unknown lock is treated as locked', () => {
  assert.notEqual(
    paystubRefreshBlockedReason({ isReplay: false, processingLocked: false, valuesLockLoading: true, valuesLocked: false }),
    null,
  );
});

// ── The reads ────────────────────────────────────────────────────────────────

function outcomes(over: Partial<PaystubRefreshOutcomes> = {}): PaystubRefreshOutcomes {
  const all = Object.fromEntries(PAYSTUB_REFRESH_READS.map((r) => [r.id, READ])) as PaystubRefreshOutcomes;
  return { ...all, ...over };
}

test('read ids are unique', () => {
  const ids = PAYSTUB_REFRESH_READS.map((r) => r.id);
  assert.equal(new Set(ids).size, ids.length);
});

test('a failed read is reported by its label, in list order, never counted as read', () => {
  const s = summarizePaystubRefresh(
    outcomes({ mesaOptOut: failedRead(new Error('mesa-suspensions HTTP 500')), managerKpi: failedRead('HTTP 403') }),
  );
  assert.equal(s.readCount, PAYSTUB_REFRESH_READS.length - 2);
  assert.deepEqual(
    s.failures.map((f) => [f.id, f.message]),
    [
      ['managerKpi', 'HTTP 403'],
      ['mesaOptOut', 'mesa-suspensions HTTP 500'],
    ],
  );
  assert.equal(s.nothingRead, false);
});

test('a skipped read is neither read nor failed, and is said with its reason', () => {
  const s = summarizePaystubRefresh(outcomes({ hslKpi: skippedRead('not loaded for this week') }));
  assert.equal(s.readCount, PAYSTUB_REFRESH_READS.length - 1);
  assert.deepEqual(s.failures, []);
  assert.deepEqual(s.skipped, [{ id: 'hslKpi', label: 'HSL KPI bonuses', reason: 'not loaded for this week' }]);
});

test('nothing read is said as such — never as up to date', () => {
  const none = Object.fromEntries(
    PAYSTUB_REFRESH_READS.map((r) => [r.id, failedRead('offline')]),
  ) as PaystubRefreshOutcomes;
  const s = summarizePaystubRefresh(none);
  assert.equal(s.nothingRead, true);
  assert.equal(s.failures.length, PAYSTUB_REFRESH_READS.length);
});

test('failedRead never yields an empty message', () => {
  assert.equal(failedRead(undefined).status, 'failed');
  const f = failedRead(new Error(''), 'Rates failed');
  assert.ok(f.status === 'failed' && f.message === 'Rates failed');
});

test('joinLabels reads as a sentence', () => {
  assert.equal(joinLabels([]), '');
  assert.equal(joinLabels(['a']), 'a');
  assert.equal(joinLabels(['a', 'b']), 'a and b');
  assert.equal(joinLabels(['a', 'b', 'c']), 'a, b and c');
});

// ── What changed on the statement ────────────────────────────────────────────

function payload(over: { pay?: Record<string, number>; rates?: Record<string, number>; dept?: string } = {}) {
  return {
    name: 'Jane Cruz',
    email: 'janec@simple.biz',
    department_name: over.dept ?? 'Lead Gen',
    hours: { total: 40, regular: 40, ot: 0 },
    rates_php: { regular: 225, ot: 337.5, ...over.rates },
    pay_php: {
      regular: 9000,
      ot: 0,
      initial: 9000,
      bonuses_total: 0,
      perfect_attendance_bonus: 0,
      tech_bonus: 0,
      other_bonuses: 0,
      adjustment: 0,
      mesa_deduction: 100,
      mesa_disbursement: 0,
      orphanage_pay: 0,
      final: 8900,
      ...over.pay,
    },
    pay_period: { week: { start: '2026-09-27', end: '2026-10-03' }, fx_rate: 58 },
  };
}

test('the same statement twice: no change, no detail change', () => {
  const a = mapPayloadToPayStub(payload());
  const b = mapPayloadToPayStub(payload());
  assert.deepEqual(diffPayStubViews(a, b), []);
  assert.equal(payStubDetailsChanged(a, b), false);
});

test('a bonus that landed is named with the statement labels, and Net closes the list', () => {
  const a = mapPayloadToPayStub(payload());
  const b = mapPayloadToPayStub(payload({ pay: { other_bonuses: 1500, bonuses_total: 1500, final: 10400 } }));
  const changes = diffPayStubViews(a, b);
  assert.deepEqual(
    changes.map((c) => [c.label, c.before, c.after]),
    [
      ['Performance Bonus', '₱0.00', '₱1,500.00'],
      ['Total Net Pay', '₱8,900.00', '₱10,400.00'],
    ],
  );
});

test('a rate fix moves the rate and the hours line, printed as the statement prints them', () => {
  const a = mapPayloadToPayStub(payload());
  const b = mapPayloadToPayStub(
    payload({ rates: { regular: 235, ot: 352.5 }, pay: { regular: 9400, initial: 9400, final: 9300 } }),
  );
  const changes = diffPayStubViews(a, b);
  assert.deepEqual(
    changes.map((c) => c.label),
    ['Hourly rate', 'Regular Hours', 'Total Net Pay'],
  );
  assert.equal(changes[0]!.before, '₱225.00');
  assert.equal(changes[0]!.after, '₱235.00');
});

test('the MESA deduction prints signed, the way the statement prints it', () => {
  const a = mapPayloadToPayStub(payload());
  const b = mapPayloadToPayStub(payload({ pay: { mesa_deduction: 0, final: 9000 } }));
  const mesa = diffPayStubViews(a, b).find((c) => c.key === 'mesaDeduction');
  assert.deepEqual(mesa && [mesa.before, mesa.after], ['-₱100.00', '-₱0.00']);
});

test('a department move is a change', () => {
  const a = mapPayloadToPayStub(payload());
  const b = mapPayloadToPayStub(payload({ dept: 'Callback' }));
  assert.deepEqual(
    diffPayStubViews(a, b).map((c) => [c.label, c.before, c.after]),
    [['Department', 'Lead Gen', 'Callback']],
  );
});

test('float noise under a cent is not a change', () => {
  const a = mapPayloadToPayStub(payload());
  const b = mapPayloadToPayStub(payload({ pay: { final: 8900.000001 } }));
  assert.deepEqual(diffPayStubViews(a, b), []);
});

test('a detail that moved with no figure is detected separately', () => {
  const a = mapPayloadToPayStub(payload());
  const b = mapPayloadToPayStub({ ...payload(), adjustment_note: 'From Payroll Notes (carla)' });
  assert.deepEqual(diffPayStubViews(a, b), []);
  assert.equal(payStubDetailsChanged(a, b), true);
});

// ── The wiring (source scan) ─────────────────────────────────────────────────

function wizardRefreshBody(): string {
  const src = readFileSync(join(process.cwd(), 'src/components/PayrollWizard.tsx'), 'utf8');
  const start = src.indexOf('const refreshPaystubSources = useCallback(');
  assert.ok(start > 0, 'refreshPaystubSources moved — re-point this scan');
  const end = src.indexOf('\n  }, [', start);
  assert.ok(end > start, 'refreshPaystubSources has no dependency array — re-point this scan');
  return src.slice(start, end);
}

test('the Refresh never re-reads the additions blob, the hours or the PAB merge', () => {
  const body = wizardRefreshBody();
  // The additions blob has no dirty tracking: a reload replaces typed, unsaved
  // amounts with the saved ones. Hours and the merge re-skeleton Step 2.
  for (const banned of ['loadAdditionsProgress(', 'loadCalcSourceFileData(', 'loadUploadedSourceFiles(']) {
    assert.ok(!body.includes(banned), `refreshPaystubSources must not call ${banned}`);
  }
});

test('every loader the Refresh calls that has a pending/loading flip is called in background mode', () => {
  const body = wizardRefreshBody();
  for (const call of [
    'loadEmployeeHourlyRates({ background: true })',
    'loadRateHistory({ background: true })',
    'reloadMasterEmployees({ background: true })',
    'refreshApprovedAdjustmentOverrides({ background: true })',
    'fetchMesaDisbursements({ background: true })',
    'fetchMesaOptedOut({ background: true })',
    'pabPeriodSettings.refreshInBackground()',
    'refreshKpiLive(null)',
  ]) {
    assert.ok(body.includes(call), `expected ${call} inside refreshPaystubSources`);
  }
  assert.ok(!body.includes('pabPeriodSettings.refresh()'), 'pabPeriodSettings.refresh() flips loading — use refreshInBackground');
});

test('every read id the strip names is produced by the wiring', () => {
  const body = wizardRefreshBody();
  for (const { id } of PAYSTUB_REFRESH_READS) {
    assert.match(body, new RegExp(`\\b${id}\\b`), `${id} is in PAYSTUB_REFRESH_READS but never produced`);
  }
});
