import { NextRequest, NextResponse } from 'next/server';
import {
  listShippingDetails,
  upsertShippingDetail,
  type UpsertShippingInput,
} from '@/lib/supabase/employee-gift-shipping';
import { requireFeatureAccess } from '@/lib/auth/authorize-feature';
import { getSessionActor } from '@/lib/auth/session-actor';
import { getEmployeeMasterRecord } from '@/lib/supabase/employees';
import { normEmail } from '@/lib/email/norm-email';
import { insertAuditLog } from '@/lib/supabase/audit-log';
import { clientIp } from '@/lib/audit/context';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

/**
 * GET ?email=… — scope to one employee. Omit `email` to list everyone
 * (Orphanage team view).
 *
 * Both forms were UNAUTHORIZED: the un-scoped form returned every employee's
 * home address and phone number to any caller. Same gate as the write below —
 * the owner of that row, or staff with `hr / gift_tracker`, which is what the
 * sibling `[id]` routes already require of the Gift Tracker.
 */
export async function GET(req: NextRequest) {
  const { searchParams } = new URL(req.url);
  const email = searchParams.get('email')?.trim() || null;

  const authz = await authorizeShippingAccess(email);
  if (!authz.ok) {
    return NextResponse.json({ rows: [], error: authz.message }, { status: authz.status });
  }

  const { rows, error } = await listShippingDetails({ personalEmail: email });
  if (error) return NextResponse.json({ rows: [], error }, { status: 500 });
  return NextResponse.json({ rows, error: null });
}

/**
 * Who a PUT is allowed to write for.
 *
 * This route had NO authorization gate at all: any caller, signed in or not,
 * could upsert shipping details (name, delivery address, contact number) for
 * any `personal_email` on the roster. Two things are wrong with an ungated
 * write, and the second is why the fix belongs here: there is no actor to
 * record, so the audit event would have had to say "anonymous".
 *
 * Two legitimate callers (the same two for the read):
 *  - the employee themself (`src/components/employee/GiftShippingCard.tsx`),
 *    matched against their own master row — the card sends the personal email
 *    from their profile, falling back to their session email, so both count;
 *  - staff with `hr / gift_tracker` edit (the Orphanage Gift Tracker), which
 *    the sibling `[id]` routes already require.
 */
async function authorizeShippingAccess(
  personalEmail: string | null,
): Promise<
  | { ok: true; channel: 'employee_self' | 'staff'; actor: { user_name: string; user_role: string } }
  | { ok: false; status: 401 | 403; message: string }
> {
  const actor = await getSessionActor();
  if (actor.user_name === 'anonymous') {
    return { ok: false, status: 401, message: 'Not signed in' };
  }

  // `edit` satisfies a `view` requirement, so one call covers both.
  const staff = await requireFeatureAccess('hr', 'gift_tracker', 'view');
  if (staff.ok) return { ok: true, channel: 'staff', actor };

  // The un-scoped list is staff-only: there is no single owner to match.
  if (!personalEmail) {
    return {
      ok: false,
      status: 403,
      message: 'Listing all shipping details requires the Gift Tracker permission.',
    };
  }

  const target = normEmail(personalEmail);
  const { employee } = await getEmployeeMasterRecord(actor.user_name);
  const own = [
    employee?.personal_email,
    employee?.work_email,
    employee?.alternate_work_email,
    employee?.alternate_work_email_2,
    actor.user_name,
  ]
    .map((e) => normEmail(e ?? null))
    .filter((e): e is string => Boolean(e));

  if (target && own.includes(target)) {
    return { ok: true, channel: 'employee_self', actor };
  }
  return {
    ok: false,
    status: 403,
    message: 'You can only submit shipping details for your own account.',
  };
}

/** PUT — employee submit/edit for a specific (personal_email, milestone_index). */
export async function PUT(req: NextRequest) {
  let body: UpsertShippingInput;
  try {
    body = (await req.json()) as UpsertShippingInput;
  } catch {
    return NextResponse.json({ row: null, error: 'Invalid JSON body' }, { status: 400 });
  }

  const required: (keyof UpsertShippingInput)[] = [
    'personal_email',
    'milestone_index',
    'milestone_date',
    'preferred_delivery_location',
    'active_contact_number',
  ];
  for (const k of required) {
    const v = body[k];
    if (v == null || (typeof v === 'string' && !v.trim())) {
      return NextResponse.json(
        { row: null, error: `Missing required field: ${String(k)}` },
        { status: 400 },
      );
    }
  }

  const authz = await authorizeShippingAccess(String(body.personal_email));
  if (!authz.ok) {
    return NextResponse.json({ row: null, error: authz.message }, { status: authz.status });
  }

  const { row, error } = await upsertShippingDetail(body);
  if (error || !row) {
    return NextResponse.json(
      { row: null, error: error ?? 'Insert failed' },
      { status: error?.includes('approved') ? 409 : 500 },
    );
  }

  // `channel` is the whole point of auditing this: a staff-entered address and
  // the employee's own submission are otherwise indistinguishable afterwards.
  // The address itself is NOT copied into the trail — it lives on the row, and
  // the audit log is read by more people than the Gift Tracker is.
  void insertAuditLog({
    ...authz.actor,
    ip_address: clientIp(req),
    action: 'employee_gift_shipping.submitted',
    resource: 'employee_gift_shipping_details',
    resource_id: normEmail(String(body.personal_email)),
    details: {
      channel: authz.channel,
      milestone_index: body.milestone_index,
      milestone_date: body.milestone_date,
      status: row.status,
      fields: required.map(String),
    },
  });

  return NextResponse.json({ row, error: null });
}
