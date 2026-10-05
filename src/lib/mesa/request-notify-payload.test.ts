import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

import {
  MESA_REQUEST_DEFAULT_RECIPIENTS,
  MESA_REQUEST_NOTIFY_SLUG,
  buildMesaRequestPayload,
  isMesaNotifyRequestType,
} from './request-notify-payload';
import {
  PROTECTED_PAYLOAD_KEYS,
  WEBHOOK_AUTOMATIONS,
  applyRecipientOverride,
  validateAutomationConfig,
} from '@/lib/webhooks/webhook-config';

const row = {
  id: '11111111-2222-4333-8444-555555555555',
  work_email: 'juan@simple.biz',
  full_name: '  Juan Dela Cruz ',
  department: 'Lead Gen',
  request_type: 'disbursement' as const,
  created_at: '2026-10-05T01:30:00.000Z',
  // Fields a real row carries — the payload must never read them.
  amount_needed: 4321.5,
  disbursement_reason: 'Medical Emergency',
  explanation: 'Hospital bill for my daughter',
};

describe('buildMesaRequestPayload', () => {
  test('carries who filed what and when, under protected keys', () => {
    const p = buildMesaRequestPayload({ row, recipients: MESA_REQUEST_DEFAULT_RECIPIENTS });
    assert.equal(p.event, 'mesa.requested');
    assert.equal(p.trigger, 'employee_mesa_request');
    assert.equal(p.sent_by, 'system');
    assert.equal('test' in p, false);
    assert.deepEqual(p.request, {
      id: row.id,
      request_type: 'disbursement',
      request_label: 'Disbursement',
      employee_name: 'Juan Dela Cruz',
      employee_email: 'juan@simple.biz',
      department: 'Lead Gen',
      requested_at: '2026-10-05T01:30:00.000Z',
      requested_at_manila: 'Oct 5, 2026, 9:30 AM',
    });
    for (const k of ['event', 'trigger', 'request', 'recipients', 'sent_by', 'test']) {
      assert.ok(PROTECTED_PAYLOAD_KEYS.includes(k), `${k} must be protected`);
    }
  });

  test('NO amount, reason or explanation ever reaches the payload', () => {
    const json = JSON.stringify(buildMesaRequestPayload({ row, recipients: MESA_REQUEST_DEFAULT_RECIPIENTS }));
    assert.equal(json.includes('4321'), false);
    assert.equal(json.includes('amount'), false);
    assert.equal(json.includes('Medical'), false);
    assert.equal(json.includes('Hospital'), false);
    assert.equal(json.includes('₱'), false);
  });

  test('an HSL sub-team key is shown as its label, never the slug', () => {
    const p = buildMesaRequestPayload({
      row: { ...row, department: 'hsl:case_managers' },
      recipients: MESA_REQUEST_DEFAULT_RECIPIENTS,
    });
    const dept = (p.request as Record<string, unknown>).department as string;
    assert.equal(dept.includes('hsl:'), false);
    assert.match(dept, /^HSL/);
  });

  test('blank name/department read as null, never ""', () => {
    const p = buildMesaRequestPayload({
      row: { ...row, full_name: '  ', department: ' ' },
      recipients: MESA_REQUEST_DEFAULT_RECIPIENTS,
    });
    const r = p.request as Record<string, unknown>;
    assert.equal(r.employee_name, null);
    assert.equal(r.department, null);
  });

  test('recipients are normalized and deduped; junk addresses drop', () => {
    const p = buildMesaRequestPayload({
      row,
      recipients: [
        { email: ' Carla@Simple.biz ', name: 'Carla' },
        { email: 'carla@simple.biz', name: null },
        { email: 'not-an-email', name: null },
        { email: 'april@simple.biz', name: null },
      ],
    });
    assert.deepEqual(p.recipients, [
      { email: 'carla@simple.biz', name: 'Carla' },
      { email: 'april@simple.biz', name: null },
    ]);
  });

  test('test: true only on a test run', () => {
    assert.equal(buildMesaRequestPayload({ row, recipients: [], test: true }).test, true);
  });
});

describe('which requests are mailed', () => {
  test('the three Accounting types, never the retired opt-in', () => {
    assert.equal(isMesaNotifyRequestType('opt_out'), true);
    assert.equal(isMesaNotifyRequestType('disbursement'), true);
    assert.equal(isMesaNotifyRequestType('return'), true);
    assert.equal(isMesaNotifyRequestType('opt_in'), false);
    assert.equal(isMesaNotifyRequestType(''), false);
    assert.equal(isMesaNotifyRequestType(undefined), false);
  });
});

describe('the default and the descriptor', () => {
  test('carla@ and april@ are the code default (tickets board, 2026-10-05)', () => {
    assert.deepEqual(MESA_REQUEST_DEFAULT_RECIPIENTS.map((r) => r.email), ['carla@simple.biz', 'april@simple.biz']);
  });

  test('the slug has an automation descriptor, so the card shows Open automation', () => {
    const d = WEBHOOK_AUTOMATIONS[MESA_REQUEST_NOTIFY_SLUG];
    assert.ok(d);
    assert.match(d.trigger, /Employee → MESA → Request/);
    assert.deepEqual(d.attachments, []);
  });
});

describe('the one trigger', () => {
  const root = process.cwd();
  const read = (p: string) => fs.readFileSync(path.join(root, p), 'utf8');

  test('only the request POST fires it, after the response, for the Accounting types', () => {
    const src = read('app/api/mesa-requests/route.ts');
    assert.match(src, /after\(\s*\(\)\s*=>\s*notifyMesaRequested\(notifyRow\)\s*\)/);
    assert.match(src, /isMesaNotifyRequestType\(row\.request_type\)/);
    // Decisions and archiving never mail anyone.
    assert.equal(read('app/api/mesa-requests/[id]/route.ts').includes('notifyMesaRequested'), false);
  });

  test('the n8n workflow refuses any other event and sends nothing with no recipients', () => {
    const wf = read('references/n8n/mesa-request-notify.workflow.json');
    assert.match(wf, /mesa\.requested/);
    assert.match(wf, /No valid recipients in the payload/);
    // The email body is fixed in the workflow and carries no money either.
    assert.equal(wf.includes('amount_needed'), false);
    assert.equal(wf.includes('explanation'), false);
  });
});

// Kane, 2026-10-05: "make sure that in ADMIN we can edit the recipients". The
// editor saves an override on the slug's webhooks.config entry; the notifier runs
// the SAME applyRecipientOverride over the SAME defaults and builds the payload
// from the result. These pin that chain, and that nothing can route around it.
describe('recipients edited in Admin → Webhooks are the ones mailed', () => {
  const recipientsFor = (override: unknown) => {
    const v = validateAutomationConfig({ recipients: override, payload_overrides: null });
    assert.ok(v.ok, JSON.stringify(v));
    const { effective } = applyRecipientOverride(MESA_REQUEST_DEFAULT_RECIPIENTS, v.config.recipients);
    return (buildMesaRequestPayload({ row, recipients: effective }).recipients as { email: string }[]).map(
      (r) => r.email,
    );
  };

  test('no edit = the two defaults', () => {
    const { effective } = applyRecipientOverride(MESA_REQUEST_DEFAULT_RECIPIENTS, null);
    assert.deepEqual(effective.map((r) => r.email), ['carla@simple.biz', 'april@simple.biz']);
  });

  test('Default ± changes: remove one default, add someone else', () => {
    assert.deepEqual(
      recipientsFor({ mode: 'role', add: ['Maya@Simple.biz'], remove: ['carla@simple.biz'], custom: [] }),
      ['april@simple.biz', 'maya@simple.biz'],
    );
  });

  test('Fixed list replaces the defaults outright', () => {
    assert.deepEqual(
      recipientsFor({ mode: 'custom', add: [], remove: [], custom: ['jane@simple.biz'] }),
      ['jane@simple.biz'],
    );
  });

  test('removing every default leaves nobody — the notifier refuses rather than sending empty', () => {
    assert.deepEqual(
      recipientsFor({ mode: 'role', add: [], remove: ['carla@simple.biz', 'april@simple.biz'], custom: [] }),
      [],
    );
    const src = fs.readFileSync(path.join(process.cwd(), 'src/lib/mesa/request-notify.ts'), 'utf8');
    assert.match(src, /effective\.length === 0/);
    assert.match(src, /reason: "no_recipients"/);
  });

  test('the only URL source is the Admin card — an env URL would drop the edits', () => {
    const src = fs.readFileSync(path.join(process.cwd(), 'src/lib/mesa/request-notify.ts'), 'utf8');
    assert.match(src, /resolveWebhookDelivery\(MESA_REQUEST_NOTIFY_SLUG\)/);
    assert.equal(src.includes('envVars'), false);
    assert.equal(src.includes('N8N_MESA_REQUEST_NOTIFY_WEBHOOK_URL'), false);
    // The send path applies the saved override to the defaults, not a fixed list.
    assert.match(src, /applyRecipientOverride\(defaults, delivery\.recipients\)/);
  });

  test('the Admin editor serves this slug (descriptor + runtime), so the card offers Open automation', () => {
    const route = fs.readFileSync(path.join(process.cwd(), 'app/api/admin/webhooks/automation/route.ts'), 'utf8');
    assert.match(route, /\[MESA_REQUEST_NOTIFY_SLUG\]: \{/);
    assert.match(route, /defaults: listMesaRequestDefaultRecipients/);
    const card = fs.readFileSync(path.join(process.cwd(), 'src/components/admin/AdminWebhooks.tsx'), 'utf8');
    assert.match(card, /slug: 'mesa_request_notify'/);
  });

  test('the editor warns when an env URL means its edits are not applied', () => {
    const dialog = fs.readFileSync(path.join(process.cwd(), 'src/components/admin/WebhookAutomationDialog.tsx'), 'utf8');
    assert.match(dialog, /status === 'env' && \(/);
    assert.match(dialog, /Your edits here are not applied yet/);
  });
});
