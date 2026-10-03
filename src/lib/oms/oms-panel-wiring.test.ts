/**
 * Send to OMS wiring: the guards that live in the panel, where the pure tests cannot reach.
 * Source scans. The route cannot see the Test switch, so the panel's button IS the LIVE-only
 * guard. A refactor that drops the button, or its disabled state, fails here and not in OMS.
 *
 * Why this exists: the modal, hook and gating shipped on 2026-09-28 with NO button, and nothing
 * noticed for four days, because nothing tested that anything opened the modal.
 */
import test, { describe } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

const panel = fs
  .readFileSync(path.join(process.cwd(), 'src/components/payroll/OrphanageOmsPanel.tsx'), 'utf8')
  .replace(/\r\n/g, '\n');

describe('Send to OMS button', () => {
  test('a button opens the Send to OMS modal', () => {
    assert.match(panel, /onClick=\{omsReturn\.open\}/);
    assert.match(panel, /<OrphanageOmsReturnDialog state=\{omsReturn\}/);
  });

  test('the button is disabled whenever sending is blocked', () => {
    const at = panel.indexOf('onClick={omsReturn.open}');
    const button = panel.slice(panel.lastIndexOf('<Button', at), panel.indexOf('</Button>', at));
    assert.match(button, /disabled=\{!!sendBlockedReason\}/);
  });

  test('Test mode and replay both block the send (the route cannot see either)', () => {
    const block = panel.slice(panel.indexOf('const sendBlockedReason'), panel.indexOf('// ── the indicator'));
    assert.match(block, /isReplay \?/);
    assert.match(block, /testMode \?/);
    assert.match(block, /!weekStart \|\| !sourceFile/);
  });

  test('the button never spins: the loading lives in the modal', () => {
    const at = panel.indexOf('onClick={omsReturn.open}');
    const button = panel.slice(panel.lastIndexOf('<Button', at), panel.indexOf('</Button>', at));
    assert.doesNotMatch(button, /animate-spin|Loader2/);
  });
});
