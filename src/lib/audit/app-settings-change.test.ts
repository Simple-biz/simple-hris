import test from 'node:test';
import assert from 'node:assert/strict';

import {
  APP_SETTING_AUDIT_CHANGED_KEYS_MAX,
  APP_SETTING_AUDIT_EXEMPT,
  APP_SETTING_AUDIT_VALUE_MAX,
  cycleSourceFileFromSettingKey,
  describeAppSettingChange,
  isAppSettingChangeAudited,
} from './app-settings-change';
import { US_HOLIDAYS_ENABLED_KEY, US_HOLIDAYS_LIST_KEY } from '@/lib/us-holidays';
import { deptPayPausedSettingKey, otDeptSettingKey } from '@/lib/payroll/dept-pay-config';
import { cycleFxSettingKey } from '@/lib/payroll/wizard-setup-steps';
import { PAB_PERIOD_ACTIVE_MONTH_KEY, PAB_PERIOD_OVERRIDES_KEY } from '@/lib/pab-period-settings';

const FILE = 'simple-biz_daily_report_2026-09-20_to_2026-09-26.csv';

/**
 * Every key the Payroll Wizard writes through POST /api/app-settings (inventory
 * of 2026-09-28, session log item 240). Each one MUST be audited — item 239 was
 * the PAB Period moving with no trail.
 */
const WIZARD_WRITTEN_KEYS = [
  PAB_PERIOD_OVERRIDES_KEY,
  PAB_PERIOD_ACTIVE_MONTH_KEY,
  'tech_bonus_week_overrides',
  US_HOLIDAYS_ENABLED_KEY,
  US_HOLIDAYS_LIST_KEY,
  `payroll.wizard.exclusions.${FILE}`,
  cycleFxSettingKey(FILE),
  deptPayPausedSettingKey(FILE),
  otDeptSettingKey('sales'),
  'usd_to_php_rate',
  'usd_to_cop_rate',
  'payroll.wizard.orphanage_confirmed.2026-09-20',
];

test('every key the wizard writes is audited', () => {
  for (const key of WIZARD_WRITTEN_KEYS) {
    assert.equal(isAppSettingChangeAudited(key), true, key);
  }
});

test('an unknown (future) key is audited by default', () => {
  assert.equal(isAppSettingChangeAudited('some_new_setting_nobody_has_added_yet'), true);
  assert.equal(isAppSettingChangeAudited(`payroll.wizard.brand_new.${FILE}`), true);
});

test('the exemption list is pinned exactly — adding one is a decision, not a drive-by', () => {
  assert.deepEqual(
    APP_SETTING_AUDIT_EXEMPT.map((e) => `${e.kind}:${e.match}`),
    ['prefix:payroll.wizard.final_pay.', 'exact:hubstaff_daily_breakdown'],
  );
  for (const e of APP_SETTING_AUDIT_EXEMPT) assert.ok(e.reason.length > 20, `reason for ${e.match}`);
  assert.equal(isAppSettingChangeAudited(`payroll.wizard.final_pay.${FILE}`), false);
  assert.equal(isAppSettingChangeAudited('hubstaff_daily_breakdown'), false);
  // exact means exact: a longer key with that stem is still audited
  assert.equal(isAppSettingChangeAudited('hubstaff_daily_breakdown_v2'), true);
  // prefix means prefix: a sibling family is still audited
  assert.equal(isAppSettingChangeAudited(`payroll.wizard.final_payout.${FILE}`), true);
});

test('re-posting the same value is not an event', () => {
  assert.equal(describeAppSettingChange('usd_to_php_rate', '58.1', '58.1'), null);
});

test('a PAB Period change records the key, the window before and after', () => {
  const before = JSON.stringify({ '2026-09': { start: '2026-09-20', end: '2026-09-26' } });
  const after = JSON.stringify({ '2026-09': { start: '2026-08-30', end: '2026-10-03' } });
  const d = describeAppSettingChange(PAB_PERIOD_OVERRIDES_KEY, before, after);
  assert.deepEqual(d, { key: PAB_PERIOD_OVERRIDES_KEY, created: false, before, after });
});

test('a first write says created, with before null', () => {
  const d = describeAppSettingChange('usd_to_cop_rate', null, '4100');
  assert.deepEqual(d, { key: 'usd_to_cop_rate', created: true, before: null, after: '4100' });
});

test('a failed pre-read is written as UNKNOWN, never as unchanged or as created', () => {
  const same = describeAppSettingChange('usd_to_php_rate', null, '58.1', { beforeUnavailable: true });
  assert.ok(same, 'must not be dropped as a no-op');
  assert.equal(same.before_unavailable, true);
  assert.equal(same.created, false);
  assert.equal('before' in same, false);
  assert.equal(same.after, '58.1');
});

test('a long value is summarised with lengths and the top-level keys that moved', () => {
  const big = (n: number) => Object.fromEntries(Array.from({ length: n }, (_, i) => [`k${i}`, 'x'.repeat(40)]));
  const a = big(150);
  const b = { ...a, k3: 'changed', k7: undefined, new_key: 1 };
  const before = JSON.stringify(a);
  const after = JSON.stringify(b);
  assert.ok(after.length > APP_SETTING_AUDIT_VALUE_MAX);
  const d = describeAppSettingChange('us_holidays_list', before, after);
  assert.ok(d);
  assert.equal(d.summarised, true);
  assert.equal('before' in d, false);
  assert.equal('after' in d, false);
  assert.equal(d.before_length, before.length);
  assert.equal(d.after_length, after.length);
  assert.deepEqual(d.changed_keys, ['k3', 'k7', 'new_key']);
  assert.equal(d.changed_keys_total, 3);
});

test('the changed-keys list is capped but the total is not', () => {
  const a = Object.fromEntries(Array.from({ length: 300 }, (_, i) => [`k${i}`, 'a'.repeat(20)]));
  const b = Object.fromEntries(Array.from({ length: 300 }, (_, i) => [`k${i}`, 'b'.repeat(20)]));
  const d = describeAppSettingChange('x', JSON.stringify(a), JSON.stringify(b));
  assert.ok(d);
  assert.equal(d.changed_keys?.length, APP_SETTING_AUDIT_CHANGED_KEYS_MAX);
  assert.equal(d.changed_keys_total, 300);
});

test('a per-cycle wizard key carries its cycle, so it reaches that week’s Step 9 trail', () => {
  assert.equal(cycleSourceFileFromSettingKey(`payroll.wizard.exclusions.${FILE}`), FILE);
  assert.equal(cycleSourceFileFromSettingKey(cycleFxSettingKey(FILE)), FILE);
  assert.equal(cycleSourceFileFromSettingKey('payroll.wizard.orphanage_confirmed.2026-09-20'), null);
  assert.equal(cycleSourceFileFromSettingKey(PAB_PERIOD_OVERRIDES_KEY), null);
  const d = describeAppSettingChange(`payroll.wizard.exclusions.${FILE}`, '[]', '["a@simple.biz"]');
  assert.deepEqual(d?.cycle, { source_file: FILE });
});
