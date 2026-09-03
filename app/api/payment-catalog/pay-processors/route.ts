// Payment Catalog -- Pay Processors.
//
// GET   -> { processors } : the stored registry MERGED over the code seeds, so
//          every processor the app knows shows up even before anyone has saved.
// POST  -> create a custom processor (label, classification, logo, …).
// PATCH -> edit one processor by id. The id, wired flag and creation stamp are
//          immutable; everything else is replaceable — including the
//          classification of a code-wired rail, which then shows as DRIFT until
//          the Payment Dispatch integration reads this registry.
//
// Storage is a JSON array in app_settings behind a compare-and-swap write
// (see pay-processors-db.ts). No table, no migration.

import { NextResponse } from 'next/server';
import { deniedResponse, requireRateVisibilitySession } from '@/lib/auth/authorize-email';
import { requireFeatureEdit } from '@/lib/auth/authorize-feature';
import { insertAuditLog } from '@/lib/supabase/audit-log';
import { getSessionActor } from '@/lib/auth/session-actor';
import {
  applyPayProcessorPatch,
  buildPayProcessor,
  codeSeedProcessors,
  mergeRegistryOverCode,
  routingDrift,
  validatePayProcessorInput,
  type PayProcessor,
  type PayProcessorInput,
} from '@/lib/payment-catalog/pay-processors';
import {
  mutatePayProcessorRegistry,
  readPayProcessorRegistry,
} from '@/lib/payment-catalog/pay-processors-db';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

export async function GET() {
  // Same read gate as the rest of the Payment Catalog.
  const authz = await requireRateVisibilitySession();
  if (!authz.ok) return deniedResponse(authz);
  try {
    const { stored } = await readPayProcessorRegistry();
    return NextResponse.json({ processors: mergeRegistryOverCode(stored), error: null });
  } catch (e) {
    const message = e instanceof Error ? e.message : 'Could not read the pay processor registry';
    return NextResponse.json({ processors: [], error: message }, { status: 500 });
  }
}

/** Pull only the fields a write may carry — the body is never spread into a row. */
function pickInput(body: Record<string, unknown>): PayProcessorInput {
  return {
    label: String(body.label ?? ''),
    blurb: typeof body.blurb === 'string' ? body.blurb : undefined,
    routing: body.routing as PayProcessorInput['routing'],
    status: typeof body.status === 'string' ? (body.status as PayProcessorInput['status']) : undefined,
    logo: body.logo === undefined ? undefined : (body.logo as PayProcessorInput['logo']),
    notes: typeof body.notes === 'string' ? body.notes : undefined,
  };
}

async function audit(action: string, p: PayProcessor, extra: Record<string, unknown>) {
  const who = await getSessionActor();
  void insertAuditLog({
    user_name: who.user_name,
    user_role: who.user_role,
    action,
    resource: 'payment_catalog_pay_processors',
    resource_id: p.id,
    details: {
      label: p.label,
      routing: p.routing,
      status: p.status,
      wired_in_code: p.wiredInCode,
      has_logo: p.logo !== null,
      logo_kind: p.logo?.kind ?? null,
      drift: routingDrift(p),
      ...extra,
    },
  }).catch(() => undefined);
}

export async function POST(request: Request) {
  const authz = await requireFeatureEdit('accounting', 'bonus_catalog');
  if (!authz.ok) return deniedResponse(authz);
  const actor = authz.sessionEmail;

  let body: Record<string, unknown>;
  try {
    body = (await request.json()) as Record<string, unknown>;
  } catch {
    return NextResponse.json({ error: 'Invalid JSON body' }, { status: 400 });
  }

  // Validate against the LIVE merged id set so a custom "Wise" can never shadow
  // the wired rail, and two custom rows can never share a slug.
  let existingIds: Set<string>;
  try {
    const { stored } = await readPayProcessorRegistry();
    existingIds = new Set(mergeRegistryOverCode(stored).map((p) => p.id));
  } catch (e) {
    return NextResponse.json(
      { error: e instanceof Error ? e.message : 'Could not read the pay processor registry' },
      { status: 500 },
    );
  }
  const check = validatePayProcessorInput(body, 'create', existingIds);
  if (!check.ok) return NextResponse.json({ error: check.error }, { status: 400 });

  const now = new Date().toISOString();
  const created = buildPayProcessor(pickInput(body), actor, now);

  const result = await mutatePayProcessorRegistry((stored) => {
    if (stored.some((p) => p.id === created.id) || codeSeedProcessors().some((s) => s.id === created.id)) {
      return { error: `"${created.label}" already exists in the registry.` };
    }
    return [...stored, created];
  });
  if (result.error) {
    return NextResponse.json({ error: result.error }, { status: result.conflict ? 409 : 400 });
  }

  await audit('pay_processor.create', created, {});
  return NextResponse.json({ processor: created, processors: mergeRegistryOverCode(result.stored ?? []) });
}

export async function PATCH(request: Request) {
  const authz = await requireFeatureEdit('accounting', 'bonus_catalog');
  if (!authz.ok) return deniedResponse(authz);
  const actor = authz.sessionEmail;

  let body: Record<string, unknown>;
  try {
    body = (await request.json()) as Record<string, unknown>;
  } catch {
    return NextResponse.json({ error: 'Invalid JSON body' }, { status: 400 });
  }
  const id = typeof body.id === 'string' ? body.id.trim() : '';
  if (!id) return NextResponse.json({ error: 'Missing processor id' }, { status: 400 });

  const check = validatePayProcessorInput(body, 'edit', new Set());
  if (!check.ok) return NextResponse.json({ error: check.error }, { status: 400 });

  const now = new Date().toISOString();
  let before: PayProcessor | null = null;
  let after: PayProcessor | null = null;

  const result = await mutatePayProcessorRegistry((stored) => {
    // Editing a never-saved seed is allowed: it is materialised from code here
    // and stored for the first time. An unknown id is refused.
    const existing =
      stored.find((p) => p.id === id) ?? codeSeedProcessors().find((s) => s.id === id) ?? null;
    if (!existing) return { error: `No processor with id "${id}".` };
    before = existing;
    after = applyPayProcessorPatch(existing, pickInput(body), actor, now);
    return [...stored.filter((p) => p.id !== id), after];
  });
  if (result.error || !after) {
    return NextResponse.json(
      { error: result.error ?? 'Update failed' },
      { status: result.conflict ? 409 : result.error?.startsWith('No processor') ? 404 : 400 },
    );
  }

  const prev = before as PayProcessor | null;
  await audit('pay_processor.update', after, {
    previous: prev
      ? { label: prev.label, routing: prev.routing, status: prev.status, has_logo: prev.logo !== null }
      : null,
  });
  return NextResponse.json({ processor: after, processors: mergeRegistryOverCode(result.stored ?? []) });
}
