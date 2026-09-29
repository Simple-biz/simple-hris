import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  fetchHslKpi,
  fetchManagerKpi,
  sameJson,
  wizardKpiLiveAllowed,
  type KpiFetch,
} from './wizard-kpi-load';

/** A fake fetch answering by URL prefix; records every URL asked for. */
function fakeFetch(routes: Record<string, { status?: number; body: unknown }>, delays: Record<string, number> = {}) {
  const asked: string[] = [];
  const impl: KpiFetch = async (url) => {
    asked.push(url);
    const key = Object.keys(routes).find((k) => url.startsWith(k));
    if (!key) throw new Error(`unexpected ${url}`);
    const d = Object.entries(delays).find(([k]) => url.startsWith(k))?.[1] ?? 0;
    if (d) await new Promise((r) => setTimeout(r, d));
    const { status = 200, body } = routes[key];
    return new Response(JSON.stringify(body), { status });
  };
  return { impl, asked };
}

const WEEK = '2026-09-20';

// The underpay class: a 500 used to parse as zero rows, mark the week loaded,
// and let the final-pay publisher write a KPI-less total.
test('a failed status read THROWS — never "no submissions"', async () => {
  const f = fakeFetch({ '/api/hsl-bonus/period-status': { status: 500, body: { error: 'boom' } } });
  await assert.rejects(fetchManagerKpi(WEEK, f.impl), /KPI period status failed/);
});

test('a 200 carrying `error` also throws', async () => {
  const f = fakeFetch({
    '/api/hsl-bonus/period-status': {
      body: { rows: [{ department: 'pm_team', period_start: WEEK, period_end: '2026-09-26', status: 'ready' }] },
    },
    '/api/bonus-catalog-applied': { body: { rows: [], error: 'read failed' } },
  });
  await assert.rejects(fetchManagerKpi(WEEK, f.impl), /KPI submissions for pm_team failed/);
});

test('the status read is narrowed to the week when it is known (no 1000-row cap exposure)', async () => {
  const f = fakeFetch({ '/api/hsl-bonus/period-status': { body: { rows: [] } } });
  await fetchManagerKpi(WEEK, f.impl);
  assert.equal(f.asked[0], `/api/hsl-bonus/period-status?period_start=${WEEK}`);
  const g = fakeFetch({ '/api/hsl-bonus/period-status': { body: { rows: [] } } });
  await fetchManagerKpi(null, g.impl);
  assert.equal(g.asked[0], '/api/hsl-bonus/period-status');
});

test('drafts pay nothing and only payable departments are read', async () => {
  const f = fakeFetch({
    '/api/hsl-bonus/period-status': {
      body: {
        rows: [
          { department: 'pm_team', period_start: WEEK, period_end: '', status: 'draft' },
          { department: 'not_a_dept', period_start: WEEK, period_end: '', status: 'ready' },
        ],
      },
    },
  });
  const r = await fetchManagerKpi(WEEK, f.impl);
  assert.deepEqual(r.raw, {});
  assert.equal(f.asked.length, 1);
});

test('same data in, same key order out — whichever fetch lands first', async () => {
  const status = {
    body: {
      rows: [
        { department: 'pm_team', period_start: WEEK, period_end: '', status: 'ready' },
        { department: 'edit', period_start: WEEK, period_end: '', status: 'ready' },
      ],
    },
  };
  const applied = (dept: string) => ({
    body: { rows: [{ employee_email: `${dept}@x.com`, amount: 100 }, { employee_email: 'both@x.com', amount: 5 }] },
  });
  const routes = {
    '/api/hsl-bonus/period-status': status,
    '/api/bonus-catalog-applied?dept=pm_team': applied('pm_team'),
    '/api/bonus-catalog-applied?dept=edit': applied('edit'),
  };
  const a = await fetchManagerKpi(WEEK, fakeFetch(routes, { '/api/bonus-catalog-applied?dept=edit': 15 }).impl);
  const b = await fetchManagerKpi(WEEK, fakeFetch(routes, { '/api/bonus-catalog-applied?dept=pm_team': 15 }).impl);
  assert.equal(sameJson(a, b), true);
  assert.equal(a.raw['both@x.com'], 10);
});

test('HSL: nothing ready for the week is a KNOWN empty (period null), not a failure', async () => {
  const f = fakeFetch({ '/api/hsl-bonus/period-status': { body: { rows: [] } } });
  const r = await fetchHslKpi({ week: WEEK, payableSet: new Set(['hsl:x']), perEmployeeDepts: new Set(), fetchImpl: f.impl });
  assert.deepEqual(r, { amounts: {}, period: null });
});

test('HSL: locked beats ready and a failed entries read throws', async () => {
  const status = {
    body: {
      rows: [
        { department: 'hsl:x', period_start: WEEK, period_end: '2026-09-26', status: 'ready' },
        { department: 'hsl:x', period_start: WEEK, period_end: '2026-09-26', status: 'locked' },
      ],
    },
  };
  const ok = fakeFetch({
    '/api/hsl-bonus/period-status': status,
    '/api/hsl-bonus/entries': { body: { rows: [{ employee_email: 'A@x.com', calculated_bonus: 250.4 }, { employee_email: '__dept_meta__', calculated_bonus: 9 }] } },
  });
  const r = await fetchHslKpi({ week: WEEK, payableSet: new Set(['hsl:x']), perEmployeeDepts: new Set(), fetchImpl: ok.impl });
  assert.deepEqual(r.amounts, { 'a@x.com': 250 });
  assert.equal(r.period?.status, 'locked');

  const bad = fakeFetch({
    '/api/hsl-bonus/period-status': status,
    '/api/hsl-bonus/entries': { status: 500, body: { error: 'down' } },
  });
  await assert.rejects(
    fetchHslKpi({ week: WEEK, payableSet: new Set(['hsl:x']), perEmployeeDepts: new Set(), fetchImpl: bad.impl }),
    /HSL KPI entries for hsl:x failed/,
  );
});

// "Nothing may drift in silently mid-payout" — the rule pullNotesAdjustments follows.
test('live KPI refresh is allowed ONLY on an editable live cycle', () => {
  const open = { isReplay: false, processingLocked: false, valuesLockLoading: false, valuesLocked: false };
  assert.equal(wizardKpiLiveAllowed(open), true);
  assert.equal(wizardKpiLiveAllowed({ ...open, valuesLocked: true }), false);
  assert.equal(wizardKpiLiveAllowed({ ...open, valuesLockLoading: true }), false, 'an unknown lock is a lock');
  assert.equal(wizardKpiLiveAllowed({ ...open, processingLocked: true }), false);
  assert.equal(wizardKpiLiveAllowed({ ...open, isReplay: true }), false);
});
