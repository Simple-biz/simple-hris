import { NextRequest, NextResponse } from 'next/server';
import { requireAdminSession, deniedResponse } from '@/lib/auth/authorize-email';
import { getSessionActor } from '@/lib/auth/session-actor';
import { getAppSetting, upsertAppSetting } from '@/lib/supabase/app-settings';
import { insertAuditLog } from '@/lib/supabase/audit-log';
import {
  PROTECTED_PAYLOAD_KEYS,
  WEBHOOK_AUTOMATIONS,
  applyRecipientOverride,
  mergePayloadOverrides,
  parseWebhookConfig,
  validateAutomationConfig,
  type WebhookConfigEntry,
} from '@/lib/webhooks/webhook-config';
import {
  buildCycleCompletePayload,
  listAccountingCelebrationRecipients,
  postCycleCompleteWebhook,
  resolveCycleCompleteDelivery,
} from '@/lib/payroll/cycle-complete-notify';
import { buildCycleCloseAttachmentsFromModel, describeAttachments } from '@/lib/payroll/cycle-close-attachments';
import {
  sampleCoeRequestRow,
  sampleCycleCloseoutRecord,
  samplePaidDetailRows,
} from '@/lib/webhooks/automation-fixtures';
import { buildCoeRequestPayload, COE_REQUEST_NOTIFY_SLUG } from '@/lib/documents/coe-request-notify-payload';
import {
  listCoeRequestDefaultRecipients,
  postCoeRequestWebhook,
  resolveCoeRequestDelivery,
} from '@/lib/documents/coe-request-notify';
import type { WebhookDelivery } from '@/lib/webhooks/resolve-webhook';
import type { WebhookRecipient } from '@/lib/webhooks/webhook-config';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

/**
 * Admin → Webhooks → "Open automation" (2026-09-04). Admin-only, like the API
 * tokens route — `webhooks.config` is admin-only to WRITE everywhere, and this
 * route is the only writer of its automation fields.
 *
 * GET  ?slug=  — the automation as it would fire right now: default audience,
 *                effective audience after the saved override, and the exact
 *                payload shape (attachments as metadata, no base64).
 * PUT  {slug, recipients, payload_overrides} — validate STRICTLY (protected keys
 *                refused by name) and persist onto the slug's entry. Read-modify-
 *                write of the whole array, keyed by slug; other entries untouched.
 * POST {slug}  — test run: the production payload built from a FICTIONAL record,
 *                mailed to the signed-in admin ONLY, `test: true`. Never the real
 *                audience, never a real week.
 *
 * Only slugs in `WEBHOOK_AUTOMATIONS` that ALSO have a runtime below are served:
 * `payment_cycle_complete` and `coe_request_notify` (2026-10-05).
 */

const SETTINGS_KEY = 'webhooks.config';

type Attachments = Awaited<ReturnType<typeof buildCycleCloseAttachmentsFromModel>>;

/**
 * What the route needs from each automation: where it posts, who it mails by
 * default, the payload for the preview (from a fictional record), and the
 * test-run payload + files. Every builder is the one production sends through,
 * so the preview is the payload.
 */
interface AutomationRuntime {
  resolveDelivery: () => Promise<WebhookDelivery | null>;
  defaults: () => Promise<WebhookRecipient[]>;
  previewBase: (recipients: readonly WebhookRecipient[]) => Promise<Record<string, unknown>>;
  testRun: (to: string, now: Date) => Promise<{ payload: Record<string, unknown>; attachments: Attachments | null }>;
  post: (
    url: string,
    payload: Record<string, unknown>,
  ) => Promise<{ ok: boolean; status: number | null; detail: string | null }>;
}

const RUNTIMES: Record<string, AutomationRuntime> = {
  payment_cycle_complete: {
    resolveDelivery: resolveCycleCompleteDelivery,
    defaults: listAccountingCelebrationRecipients,
    previewBase: async (recipients) => {
      const record = sampleCycleCloseoutRecord(new Date('2026-08-03T17:00:00.000Z'));
      const attachments = describeAttachments(
        await buildCycleCloseAttachmentsFromModel({
          kind: 'final',
          record,
          livePaidRows: samplePaidDetailRows(),
          generatedAt: new Date('2026-08-03T17:00:00.000Z'),
        }),
      ).map((a) => ({ ...a, content_base64: '…' }));
      return buildCycleCompletePayload({
        record,
        celebrate: true,
        recipients,
        attachments: attachments as never,
        attachmentsError: null,
      });
    },
    testRun: async (to, now) => {
      const record = sampleCycleCloseoutRecord(now);
      const attachments = await buildCycleCloseAttachmentsFromModel({
        kind: 'final',
        record,
        livePaidRows: samplePaidDetailRows(),
        generatedAt: now,
      });
      const payload = buildCycleCompletePayload({
        record,
        celebrate: true,
        recipients: [{ email: to, name: null }],
        attachments,
        attachmentsError: null,
        test: true,
      });
      return { payload, attachments };
    },
    post: postCycleCompleteWebhook,
  },
  [COE_REQUEST_NOTIFY_SLUG]: {
    resolveDelivery: resolveCoeRequestDelivery,
    defaults: listCoeRequestDefaultRecipients,
    previewBase: async (recipients) =>
      buildCoeRequestPayload({ row: sampleCoeRequestRow(new Date('2026-10-05T01:30:00.000Z')), recipients }),
    testRun: async (to, now) => ({
      payload: buildCoeRequestPayload({
        row: sampleCoeRequestRow(now),
        recipients: [{ email: to, name: null }],
        test: true,
      }),
      attachments: null,
    }),
    post: postCoeRequestWebhook,
  },
};

/** The runtime for a served slug, or null (unknown, or no runtime wired). */
function runtimeFor(slug: string | null): AutomationRuntime | null {
  if (!slug || !WEBHOOK_AUTOMATIONS[slug]) return null;
  return RUNTIMES[slug] ?? null;
}

function cleanSlug(v: unknown): string | null {
  if (typeof v !== 'string') return null;
  const s = v.trim().toLowerCase();
  return /^[a-z0-9_]+$/.test(s) ? s : null;
}

async function loadEntries(): Promise<{ entries: WebhookConfigEntry[]; raw: string | null }> {
  const raw = await getAppSetting(SETTINGS_KEY);
  return { entries: parseWebhookConfig(raw), raw };
}

async function describeAutomation(slug: string, runtime: AutomationRuntime, entries: WebhookConfigEntry[]) {
  const descriptor = WEBHOOK_AUTOMATIONS[slug];
  const entry = entries.find((e) => e.slug === slug) ?? null;
  const delivery = await runtime.resolveDelivery();
  const defaults = await runtime.defaults();
  const { effective, added, removed } = applyRecipientOverride(defaults, entry?.recipients ?? null);

  const base = await runtime.previewBase(effective);
  const { payload, rejected } = mergePayloadOverrides(base, entry?.payload_overrides ?? null);

  return {
    slug,
    descriptor,
    entry: entry
      ? {
          url: entry.url,
          active: entry.active,
          label: entry.label ?? null,
          recipients: entry.recipients,
          payload_overrides: entry.payload_overrides,
          updated_at: entry.updated_at ?? null,
        }
      : null,
    delivery: delivery ? { url: delivery.url, source: delivery.source } : null,
    defaults,
    effective,
    added,
    removed,
    /** The payload as it would go out with the SAVED overrides applied. */
    payload,
    /** The same payload before any override — the editor merges its draft into this for the live preview. */
    basePayload: base,
    rejected,
    protectedKeys: PROTECTED_PAYLOAD_KEYS,
  };
}

export async function GET(req: NextRequest) {
  const authz = await requireAdminSession();
  if (!authz.ok) return deniedResponse(authz);
  const slug = cleanSlug(req.nextUrl.searchParams.get('slug'));
  const runtime = runtimeFor(slug);
  if (!slug || !runtime) {
    return NextResponse.json({ error: 'Unknown automation slug' }, { status: 404 });
  }
  try {
    const { entries } = await loadEntries();
    return NextResponse.json({ ...(await describeAutomation(slug, runtime, entries)), error: null });
  } catch (e) {
    return NextResponse.json({ error: e instanceof Error ? e.message : String(e) }, { status: 500 });
  }
}

export async function PUT(req: NextRequest) {
  const authz = await requireAdminSession();
  if (!authz.ok) return deniedResponse(authz);

  let body: { slug?: unknown; recipients?: unknown; payload_overrides?: unknown };
  try {
    body = (await req.json()) as typeof body;
  } catch {
    return NextResponse.json({ error: 'Invalid JSON body' }, { status: 400 });
  }
  const slug = cleanSlug(body.slug);
  const runtime = runtimeFor(slug);
  if (!slug || !runtime) {
    return NextResponse.json({ error: 'Unknown automation slug' }, { status: 404 });
  }
  const validated = validateAutomationConfig({
    recipients: body.recipients,
    payload_overrides: body.payload_overrides,
  });
  if (!validated.ok) {
    return NextResponse.json({ error: 'Validation failed', errors: validated.errors }, { status: 400 });
  }

  try {
    const { entries } = await loadEntries();
    const now = new Date().toISOString();
    let found = false;
    const next = entries.map((e) => {
      if (e.slug !== slug) return e;
      found = true;
      return { ...e, ...validated.config, updated_at: now };
    });
    if (!found) {
      // The automation can be configured before the URL is — the resolver
      // ignores an inactive/blank entry, so this cannot activate anything.
      next.push({
        id: Math.random().toString(36).slice(2, 10),
        slug,
        label: WEBHOOK_AUTOMATIONS[slug].title,
        url: '',
        active: false,
        updated_at: now,
        ...validated.config,
      });
    }
    const { error } = await upsertAppSetting(SETTINGS_KEY, JSON.stringify(next));
    if (error) return NextResponse.json({ error }, { status: 500 });

    const actor = await getSessionActor();
    await insertAuditLog({
      user_name: actor.user_name,
      user_role: actor.user_role,
      action: 'webhook.automation_updated',
      resource: 'app_settings',
      resource_id: SETTINGS_KEY,
      details: {
        slug,
        recipients: validated.config.recipients,
        payload_override_keys: Object.keys(validated.config.payload_overrides ?? {}),
      },
    }).catch(() => undefined);

    return NextResponse.json({ ...(await describeAutomation(slug, runtime, next)), error: null });
  } catch (e) {
    return NextResponse.json({ error: e instanceof Error ? e.message : String(e) }, { status: 500 });
  }
}

export async function POST(req: NextRequest) {
  const authz = await requireAdminSession();
  if (!authz.ok) return deniedResponse(authz);

  let body: { slug?: unknown };
  try {
    body = (await req.json()) as typeof body;
  } catch {
    return NextResponse.json({ error: 'Invalid JSON body' }, { status: 400 });
  }
  const slug = cleanSlug(body.slug);
  const runtime = runtimeFor(slug);
  if (!slug || !runtime) {
    return NextResponse.json({ error: 'Unknown automation slug' }, { status: 404 });
  }

  const me = authz.sessionEmail?.trim().toLowerCase();
  if (!me) return NextResponse.json({ error: 'No session email to send the test to' }, { status: 400 });

  const delivery = await runtime.resolveDelivery();
  if (!delivery) {
    return NextResponse.json(
      { ok: false, error: 'No webhook URL is configured for this slug — add and activate one first.' },
      { status: 400 },
    );
  }

  try {
    const { entries } = await loadEntries();
    const entry = entries.find((e) => e.slug === slug) ?? null;
    const run = await runtime.testRun(me, new Date());
    const { payload, rejected } = mergePayloadOverrides(run.payload, entry?.payload_overrides ?? null);
    const result = await runtime.post(delivery.url, payload);
    const attachments = run.attachments ? describeAttachments(run.attachments) : [];

    const actor = await getSessionActor();
    await insertAuditLog({
      user_name: actor.user_name,
      user_role: actor.user_role,
      action: 'webhook.test_run',
      resource: 'webhooks',
      resource_id: slug,
      details: {
        slug,
        to: me,
        ok: result.ok,
        status: result.status,
        detail: result.detail,
        attachments,
        payload_overrides_rejected: rejected,
        webhook_source: delivery.source,
      },
    }).catch(() => undefined);

    return NextResponse.json({
      ok: result.ok,
      status: result.status,
      detail: result.detail,
      to: me,
      attachments,
      error: result.ok ? null : result.detail ?? 'Webhook delivery failed',
    });
  } catch (e) {
    return NextResponse.json({ ok: false, error: e instanceof Error ? e.message : String(e) }, { status: 500 });
  }
}
