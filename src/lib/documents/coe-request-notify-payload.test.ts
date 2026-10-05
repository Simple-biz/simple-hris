import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

import {
  COE_REQUEST_DEFAULT_RECIPIENTS,
  COE_REQUEST_NOTIFY_SLUG,
  buildCoeRequestPayload,
} from './coe-request-notify-payload';
import { PROTECTED_PAYLOAD_KEYS, WEBHOOK_AUTOMATIONS } from '@/lib/webhooks/webhook-config';

const row = {
  id: '11111111-2222-4333-8444-555555555555',
  employee_email: 'juan@simple.biz',
  employee_name: '  Juan Dela Cruz ',
  note: ' For my visa appointment ',
  requested_at: '2026-10-05T01:30:00.000Z',
  // Extra fields a real row carries — the payload must never read them.
  period_label: 'Engaged since Mar 4, 2024 · ₱225.00/hr',
  file_path: 'juan_simple.biz/1111/original.pdf',
};

describe('buildCoeRequestPayload', () => {
  test('carries who asked and when, under protected keys', () => {
    const p = buildCoeRequestPayload({ row, recipients: COE_REQUEST_DEFAULT_RECIPIENTS });
    assert.equal(p.event, 'coe.requested');
    assert.equal(p.trigger, 'employee_coe_request');
    assert.equal(p.sent_by, 'system');
    assert.equal('test' in p, false);
    assert.deepEqual(p.request, {
      id: row.id,
      document_type: 'coe',
      document_label: 'Certificate of Engagement',
      employee_name: 'Juan Dela Cruz',
      employee_email: 'juan@simple.biz',
      requested_at: '2026-10-05T01:30:00.000Z',
      // 01:30Z is 9:30 AM in Manila — the clock the certificate prints.
      requested_at_manila: 'Oct 5, 2026, 9:30 AM',
      note: 'For my visa appointment',
    });
    for (const k of ['event', 'trigger', 'request', 'recipients', 'sent_by', 'test']) {
      assert.ok(PROTECTED_PAYLOAD_KEYS.includes(k), `${k} must be protected`);
    }
  });

  test('NO pay figures — period_label, file paths and any ₱ never reach the payload', () => {
    const json = JSON.stringify(buildCoeRequestPayload({ row, recipients: COE_REQUEST_DEFAULT_RECIPIENTS }));
    assert.equal(json.includes('period_label'), false);
    assert.equal(json.includes('225'), false);
    assert.equal(json.includes('₱'), false);
    assert.equal(json.includes('original.pdf'), false);
  });

  test('blank name/note read as null, never ""', () => {
    const p = buildCoeRequestPayload({
      row: { ...row, employee_name: '  ', note: null },
      recipients: COE_REQUEST_DEFAULT_RECIPIENTS,
    });
    const r = p.request as Record<string, unknown>;
    assert.equal(r.employee_name, null);
    assert.equal(r.note, null);
  });

  test('recipients are normalized and deduped; junk addresses drop', () => {
    const p = buildCoeRequestPayload({
      row,
      recipients: [
        { email: ' JakeC@Simple.biz ', name: 'Jake' },
        { email: 'jakec@simple.biz', name: null },
        { email: 'not-an-email', name: null },
        { email: 'maya@simple.biz', name: null },
      ],
    });
    assert.deepEqual(p.recipients, [
      { email: 'jakec@simple.biz', name: 'Jake' },
      { email: 'maya@simple.biz', name: null },
    ]);
  });

  test('test: true only on a test run', () => {
    assert.equal(buildCoeRequestPayload({ row, recipients: [], test: true }).test, true);
  });
});

describe('the default and the descriptor', () => {
  test('jakec@simple.biz is the code default (Kane, 2026-10-05)', () => {
    assert.deepEqual(COE_REQUEST_DEFAULT_RECIPIENTS.map((r) => r.email), ['jakec@simple.biz']);
  });

  test('the slug has an automation descriptor, so the card shows Open automation', () => {
    const d = WEBHOOK_AUTOMATIONS[COE_REQUEST_NOTIFY_SLUG];
    assert.ok(d);
    assert.match(d.trigger, /Request Documents/);
    assert.match(d.trigger, /Generate COE/);
    assert.deepEqual(d.attachments, []);
  });
});

describe('the one trigger', () => {
  const root = process.cwd();
  const read = (p: string) => fs.readFileSync(path.join(root, p), 'utf8');

  test('only the employee documents route fires it, after the response', () => {
    const src = read('app/api/employee/documents/route.ts');
    assert.match(src, /after\(\s*\(\)\s*=>\s*notifyCoeRequested\(row\)\s*\)/);
    // Accounting's Generate COE signs in the same click — nothing waits, nothing is mailed.
    assert.equal(read('app/api/accounting/documents/coe/route.ts').includes('notifyCoeRequested'), false);
  });
});
