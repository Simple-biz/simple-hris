import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import {
  PAB_PERIOD_LIVE_EVENT,
  PAB_PERIOD_LIVE_KEYS,
  PAB_PERIOD_LIVE_POLL_MS,
  PAB_PERIOD_LIVE_TOPIC,
  isPabPeriodLiveKey,
} from './pab-period-live';
import {
  PAB_PERIOD_ACTIVE_MONTH_KEY,
  PAB_PERIOD_EXCLUSIONS_KEY,
  PAB_PERIOD_OVERRIDES_KEY,
  fetchPabPeriodSettingsWithHealth,
  pabSettingsReadVerdict,
  parsePabPeriodExclusions,
  parsePabPeriodOverrides,
  samePabPeriodSettings,
  type PabPeriodFetchResult,
} from './pab-period-settings';
import { DISPATCH_SYNC_TOPIC, PAID_TOAST_TOPIC } from '@/lib/payroll/dispatch-paid-toast';
import { START_PROCESSING_TOPIC } from '@/lib/payroll/start-processing-broadcast';
import { FPU_LIVE_TOPIC } from '@/lib/mesa/fpu-live';

const read = (p: string) => readFileSync(join(process.cwd(), p), 'utf8');

// ── The channel ───────────────────────────────────────────────────────────────

test('the PAB period topic is its own — never another live contract’s', () => {
  // realtime-js reuses one channel per topic per client (memory/start-processing-broadcast).
  for (const other of [
    DISPATCH_SYNC_TOPIC,
    PAID_TOAST_TOPIC,
    START_PROCESSING_TOPIC,
    FPU_LIVE_TOPIC,
    'payroll-wizard-pab-decisions',
  ]) {
    assert.notEqual(PAB_PERIOD_LIVE_TOPIC, other);
  }
  assert.equal(PAB_PERIOD_LIVE_EVENT, 'changed');
});

test('every pab_period_* key the Payroll Wizard writes through the generic route announces', () => {
  const wizard = read('src/components/PayrollWizard.tsx');
  const written = [...wizard.matchAll(/savePabSetting\(\s*'(pab_period_[a-z_]+)'/g)].map((m) => m[1]);
  assert.ok(written.includes(PAB_PERIOD_OVERRIDES_KEY), 'the overrides writer moved — re-point this scan');
  assert.ok(written.includes(PAB_PERIOD_ACTIVE_MONTH_KEY), 'the active-month writer moved — re-point this scan');
  for (const key of written) {
    assert.ok(isPabPeriodLiveKey(key), `${key} is written by the wizard but never announced — the employee Overview would go stale`);
  }
});

test('the live key set is exact names, not a prefix family', () => {
  for (const key of PAB_PERIOD_LIVE_KEYS) assert.ok(isPabPeriodLiveKey(key));
  assert.ok(isPabPeriodLiveKey(` ${PAB_PERIOD_OVERRIDES_KEY} `));
  assert.equal(isPabPeriodLiveKey(`${PAB_PERIOD_OVERRIDES_KEY}_x`), false);
  assert.equal(isPabPeriodLiveKey('usd_to_php_rate'), false);
  // Exclusions are written by /api/pab-exclusions, not this route, and the
  // employee surface does not read them — announcing them here would be a lie.
  assert.equal(isPabPeriodLiveKey(PAB_PERIOD_EXCLUSIONS_KEY), false);
});

test('the poll floor exists and stays in minutes — every open employee Overview runs it', () => {
  assert.ok(PAB_PERIOD_LIVE_POLL_MS >= 60_000 && PAB_PERIOD_LIVE_POLL_MS <= 10 * 60_000);
});

test('the route broadcasts only AFTER a successful write, fire-and-forget', () => {
  const src = read('app/api/app-settings/route.ts');
  const write = src.indexOf('await upsertAppSetting(body.key, body.value)');
  const failed = src.indexOf('if (error) return NextResponse.json({ error }, { status: 500 })', write);
  const announce = src.indexOf('isPabPeriodLiveKey(body.key)');
  assert.ok(write > 0 && failed > write, 'the write/failure pair moved — re-point this scan');
  assert.ok(announce > failed, 'the broadcast must follow the failed-write return, never precede it');
  assert.match(src, /void broadcastFromServer\(PAB_PERIOD_LIVE_TOPIC, PAB_PERIOD_LIVE_EVENT/);
});

test('the employee Overview is live; the Payroll Wizard (the writer) is not', () => {
  assert.match(read('src/components/employee/EmployeeDashboard.tsx'), /usePabPeriodSettings\(\{ live: true \}\)/);
  const wizard = read('src/components/PayrollWizard.tsx');
  assert.match(wizard, /usePabPeriodSettings\(\)/);
  assert.doesNotMatch(wizard, /usePabPeriodSettings\(\{[^}]*live/);
});

// ── Reads that land ───────────────────────────────────────────────────────────

test('a newer read owns the screen — an older one landing late is dropped', () => {
  assert.equal(pabSettingsReadVerdict({ seq: 1, latestSeq: 2, degraded: false, screenHealthy: true }), 'stale');
  assert.equal(pabSettingsReadVerdict({ seq: 2, latestSeq: 2, degraded: false, screenHealthy: true }), 'apply');
});

test('a degraded RE-read never repaints a healthy screen with the default window', () => {
  assert.equal(pabSettingsReadVerdict({ seq: 3, latestSeq: 3, degraded: true, screenHealthy: true }), 'keep');
  // Nothing better on screen (first load failed too) → it may paint, as before.
  assert.equal(pabSettingsReadVerdict({ seq: 1, latestSeq: 1, degraded: true, screenHealthy: false }), 'apply');
  assert.equal(pabSettingsReadVerdict({ seq: 4, latestSeq: 4, degraded: false, screenHealthy: false }), 'apply');
});

function settings(overridesJson: string, patch: Partial<PabPeriodFetchResult> = {}): PabPeriodFetchResult {
  return {
    manual: false,
    start: null,
    end: null,
    overrides: parsePabPeriodOverrides(overridesJson),
    exclusions: parsePabPeriodExclusions('{"2026-09":["a@x.com"]}'),
    activeMonth: { year: 2026, month: 8 },
    techWeekOverridesValue: null,
    ...patch,
  };
}
const SEPT = '{"2026-09":{"start":"2026-09-06","end":"2026-10-03"}}';

test('an unchanged re-read is equal, so the screen keeps the same object', () => {
  assert.ok(samePabPeriodSettings(settings(SEPT), settings(SEPT)));
});

test('any moved field is a change', () => {
  const base = settings(SEPT);
  assert.equal(samePabPeriodSettings(base, settings('{"2026-09":{"start":"2026-09-06","end":"2026-10-02"}}')), false);
  assert.equal(samePabPeriodSettings(base, settings('{}')), false);
  assert.equal(samePabPeriodSettings(base, settings(SEPT, { activeMonth: { year: 2026, month: 9 } })), false);
  assert.equal(samePabPeriodSettings(base, settings(SEPT, { activeMonth: null })), false);
  assert.equal(samePabPeriodSettings(base, settings(SEPT, { exclusions: parsePabPeriodExclusions('{"2026-09":["b@x.com"]}') })), false);
  assert.equal(samePabPeriodSettings(base, settings(SEPT, { techWeekOverridesValue: '{"2026-09":"2026-09-13"}' })), false);
  assert.equal(samePabPeriodSettings(base, settings(SEPT, { manual: true })), false);
});

// ── Health ────────────────────────────────────────────────────────────────────

async function withFetch<T>(impl: (url: string) => Promise<Response>, run: () => Promise<T>): Promise<T> {
  const real = globalThis.fetch;
  globalThis.fetch = ((input: RequestInfo | URL) => impl(String(input))) as typeof fetch;
  try {
    return await run();
  } finally {
    globalThis.fetch = real;
  }
}
const ok = (value: string | null) =>
  Promise.resolve(new Response(JSON.stringify({ value, error: null }), { status: 200 }));

test('an ABSENT key is healthy; a 500 or a network error is a failed key', async () => {
  const clean = await withFetch(
    (url) => ok(url.includes(PAB_PERIOD_OVERRIDES_KEY) ? SEPT : null),
    () => fetchPabPeriodSettingsWithHealth(),
  );
  assert.deepEqual(clean.failedKeys, []);
  assert.equal(clean.result.overrides.get('2026-09')?.end.getDate(), 3);

  const down = await withFetch(
    (url) =>
      url.includes(PAB_PERIOD_OVERRIDES_KEY)
        ? Promise.resolve(new Response(JSON.stringify({ value: null, error: 'x' }), { status: 500 }))
        : url.includes(PAB_PERIOD_ACTIVE_MONTH_KEY)
          ? Promise.reject(new TypeError('Failed to fetch'))
          : ok(null),
    () => fetchPabPeriodSettingsWithHealth(),
  );
  assert.deepEqual(down.failedKeys.sort(), [PAB_PERIOD_ACTIVE_MONTH_KEY, PAB_PERIOD_OVERRIDES_KEY].sort());
  // Degraded reads still resolve (never reject) — the hook decides what to do.
  assert.equal(down.result.overrides.size, 0);
});
