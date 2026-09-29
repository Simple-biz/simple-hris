/**
 * HR → Gift Tracker — the tenure-gift fulfilment ledger.
 *
 *   GET                     every receipt on file (roster grain is applied client-side)
 *   PUT   { received }      state that a gift was / was not given
 *   DELETE { expect_received, reason }
 *                           withdraw the assertion entirely, back to UNKNOWN
 *
 * `route-access.ts` gates PAGES, not APIs — every /api/* route enforces its own
 * authz (docs/features/route-authorization.md). Read needs `view` on
 * (hr, gift_tracker); every write needs `edit`.
 *
 * WRITES ARE GUARDED BEYOND THE GRANT (Carla, 2026-09-29 — "I hate how easy it
 * is to undo"; `src/lib/gift-tracker/receipt-guards.ts`):
 *  - nobody records or clears their OWN gift (403; 503 if that cannot be told);
 *  - received → owed is refused (409) — Clear first, with a reason;
 *  - re-stating the current state writes nothing (keeps the row's provenance);
 *  - both writes are conditional on the state the caller read (409 on a race).
 *
 * THE ACTOR IS THE SESSION, NEVER THE BODY. `recorded_by` is taken from the
 * resolved `AuthzOk` and the request cannot influence it — six gift/orphanage
 * routes previously read an actor off the body, which is a forged identity
 * (memory/audit-registry-single-source).
 *
 * Tenure gifts carry no price and reach no payment path. Nothing here is money.
 */
import { NextRequest, NextResponse } from 'next/server';
import {
  deleteGiftReceipt,
  getGiftReceipt,
  listGiftReceipts,
  writeGiftReceiptIfUnchanged,
} from '@/lib/supabase/employee-gift-receipts';
import { requireFeatureAccess, requireFeatureEdit } from '@/lib/auth/authorize-feature';
import { deniedResponse } from '@/lib/auth/authorize-email';
import { getSessionActor } from '@/lib/auth/session-actor';
import { getEmployeeMasterRecord } from '@/lib/supabase/employees';
import { normEmail } from '@/lib/email/norm-email';
import { expandWorkEmailAliases } from '@/lib/email/work-email-aliases';
import { insertAuditLog } from '@/lib/supabase/audit-log';
import { MAX_MILESTONE_INDEX } from '@/lib/gift-tracker/receipts';
import {
  decideReceiptWrite,
  isOwnGiftRecord,
  OWN_GIFT_MESSAGE,
  readWithdrawReason,
} from '@/lib/gift-tracker/receipt-guards';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

/**
 * Validate the (person, milestone) pair a write addresses. Returns the
 * normalised pair or a message — never a partially-trusted value.
 */
function readTarget(body: {
  work_email?: unknown;
  milestone_index?: unknown;
}): { workEmail: string; milestoneIndex: number } | { error: string } {
  const workEmail =
    typeof body.work_email === 'string' ? body.work_email.trim().toLowerCase() : '';
  if (!workEmail || !workEmail.includes('@')) {
    return { error: 'work_email is required and must be an email address' };
  }
  const milestoneIndex = Number(body.milestone_index);
  if (
    !Number.isInteger(milestoneIndex) ||
    milestoneIndex < 1 ||
    milestoneIndex > MAX_MILESTONE_INDEX
  ) {
    return { error: `milestone_index must be an integer between 1 and ${MAX_MILESTONE_INDEX}` };
  }
  return { workEmail, milestoneIndex };
}

/**
 * Who may READ the ledger, mirroring `employee-gift-shipping`'s gate exactly so
 * the two gift surfaces cannot drift apart on who sees what.
 *
 *  - staff with `hr / gift_tracker` view → everything;
 *  - the employee themself → their own rows only, matched against every email
 *    on their master row (work, personal, both alternates) plus their session
 *    email, because the card sends whichever it has.
 *
 * The UN-SCOPED list stays staff-only: there is no single owner to match, and it
 * would otherwise hand any signed-in caller the whole company's gift backlog.
 *
 * READ ONLY. An employee can never WRITE here — declaring your own gift received
 * (or owed) is a statement about the company's obligation to you, and PUT/DELETE
 * below stay on `requireFeatureEdit`.
 */
async function authorizeReceiptRead(
  workEmail: string | null,
): Promise<{ ok: true } | { ok: false; status: 401 | 403; message: string }> {
  const actor = await getSessionActor();
  if (actor.user_name === 'anonymous') {
    return { ok: false, status: 401, message: 'Not signed in' };
  }

  const staff = await requireFeatureAccess('hr', 'gift_tracker', 'view');
  if (staff.ok) return { ok: true };

  if (!workEmail) {
    return {
      ok: false,
      status: 403,
      message: 'Listing every gift record requires the Gift Tracker permission.',
    };
  }

  const target = normEmail(workEmail);
  const { employee } = await getEmployeeMasterRecord(actor.user_name);
  const own = [
    employee?.work_email,
    employee?.personal_email,
    employee?.alternate_work_email,
    employee?.alternate_work_email_2,
    actor.user_name,
  ]
    .map((e) => normEmail(e ?? null))
    .filter((e): e is string => Boolean(e));

  if (target && own.includes(target)) return { ok: true };
  return {
    ok: false,
    status: 403,
    message: 'You can only view your own gift record.',
  };
}

/** GET ?work_email=… — scope to one person. Omit it for the staff-wide list. */
export async function GET(req: NextRequest) {
  const { searchParams } = new URL(req.url);
  const workEmail = searchParams.get('work_email')?.trim() || null;

  const authz = await authorizeReceiptRead(workEmail);
  if (!authz.ok) {
    return NextResponse.json({ rows: [], error: authz.message }, { status: authz.status });
  }

  const { rows, error } = await listGiftReceipts({ workEmail });
  if (error) return NextResponse.json({ rows: [], error }, { status: 500 });
  return NextResponse.json({ rows, error: null });
}

/**
 * Every address the signed-in actor is known by, so a write can refuse the
 * actor's OWN gift record (Carla, 2026-09-29: "you can just undo yourself every
 * month and get a new shirt"). Staff with Gift Tracker edit are employees too.
 *
 * FAILS CLOSED: if the master row cannot be read, the write is refused — "could
 * not tell whose gift this is" is never "not yours". The alias expansion only
 * ever WIDENS the set (it degrades to the input address on error), so it can
 * add refusals but never remove one.
 */
async function ownAddresses(authz: {
  sessionEmail: string;
  effectiveEmail: string;
}): Promise<{ own: string[] } | { error: string }> {
  const { employee, error } = await getEmployeeMasterRecord(authz.sessionEmail);
  if (error) return { error };
  const aliases = await expandWorkEmailAliases(authz.sessionEmail);
  const own = [
    authz.sessionEmail,
    authz.effectiveEmail,
    employee?.work_email,
    employee?.personal_email,
    employee?.alternate_work_email,
    employee?.alternate_work_email_2,
    ...aliases,
  ]
    .map((e) => normEmail(e ?? null))
    .filter((e): e is string => Boolean(e));
  return { own };
}

/** 403 when the target is the actor's own gift, 503 when that cannot be told. */
async function refuseOwnGift(
  authz: { sessionEmail: string; effectiveEmail: string },
  workEmail: string,
): Promise<NextResponse | null> {
  const mine = await ownAddresses(authz);
  if ('error' in mine) {
    return NextResponse.json(
      { error: `Could not confirm this is not your own gift record: ${mine.error}` },
      { status: 503 },
    );
  }
  if (isOwnGiftRecord(workEmail, mine.own)) {
    return NextResponse.json({ error: OWN_GIFT_MESSAGE }, { status: 403 });
  }
  return null;
}

export async function PUT(request: Request) {
  try {
    const authz = await requireFeatureEdit('hr', 'gift_tracker');
    if (!authz.ok) return deniedResponse(authz);

    const body = (await request.json()) as {
      work_email?: unknown;
      milestone_index?: unknown;
      received?: unknown;
      note?: unknown;
    };
    const target = readTarget(body);
    if ('error' in target) return NextResponse.json({ error: target.error }, { status: 400 });

    // Strictly boolean. A missing or coercible value is refused rather than
    // defaulted — `received: false` puts a named person on the owed list, and
    // nothing should land there because a field was absent.
    if (typeof body.received !== 'boolean') {
      return NextResponse.json(
        { error: 'received must be true or false' },
        { status: 400 },
      );
    }
    const requested = body.received;

    const own = await refuseOwnGift(authz, target.workEmail);
    if (own) return own;

    const current = await getGiftReceipt({
      workEmail: target.workEmail,
      milestoneIndex: target.milestoneIndex,
    });
    if (current.error) return NextResponse.json({ error: current.error }, { status: 500 });

    const decision = decideReceiptWrite(current.row?.received, requested);
    if (decision.kind === 'refuse') {
      return NextResponse.json({ error: decision.message, reason: decision.reason }, { status: 409 });
    }
    // Re-stating what is already on file writes nothing: an upsert would re-stamp
    // source/recorded_by/recorded_at and erase where the statement came from.
    if (decision.kind === 'unchanged') {
      return NextResponse.json({ row: current.row, unchanged: true, error: null });
    }

    const { row, conflict, error } = await writeGiftReceiptIfUnchanged({
      work_email: target.workEmail,
      milestone_index: target.milestoneIndex,
      received: requested,
      source: 'hris',
      note: typeof body.note === 'string' ? body.note : '',
      recorded_by: authz.sessionEmail,
      expectReceived: current.row?.received,
    });
    if (error) return NextResponse.json({ error }, { status: 500 });
    if (conflict) {
      return NextResponse.json(
        { error: 'Someone changed this gift record while you were looking at it. Refresh and try again.' },
        { status: 409 },
      );
    }

    void insertAuditLog({
      user_name: authz.sessionEmail,
      user_role: authz.roles[0] ?? 'hr',
      action: 'gift_receipt.recorded',
      resource: 'employee_gift_receipts',
      resource_id: `${target.workEmail}#${target.milestoneIndex}`,
      details: {
        work_email: target.workEmail,
        milestone_index: target.milestoneIndex,
        received: requested,
        // The statement this one replaced (null = nobody had said anything).
        // An owed → received write overwrites it, so the trail keeps it.
        previous_row: current.row,
      },
    });

    return NextResponse.json({ row, error: null });
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    return NextResponse.json({ error: msg }, { status: 500 });
  }
}

/**
 * Clear — withdraw the statement, back to UNKNOWN. Needs a written reason and
 * the state the caller saw (`expect_received`); the row is deleted only while it
 * still says that, so a reason written about "owed" can never delete a
 * "received" somebody recorded a moment later.
 */
export async function DELETE(request: Request) {
  try {
    const authz = await requireFeatureEdit('hr', 'gift_tracker');
    if (!authz.ok) return deniedResponse(authz);

    const body = (await request.json()) as {
      work_email?: unknown;
      milestone_index?: unknown;
      expect_received?: unknown;
      reason?: unknown;
    };
    const target = readTarget(body);
    if ('error' in target) return NextResponse.json({ error: target.error }, { status: 400 });
    if (typeof body.expect_received !== 'boolean') {
      return NextResponse.json(
        { error: 'expect_received must be true or false' },
        { status: 400 },
      );
    }
    const why = readWithdrawReason(body.reason);
    if ('error' in why) return NextResponse.json({ error: why.error }, { status: 400 });

    const own = await refuseOwnGift(authz, target.workEmail);
    if (own) return own;

    const { row, error } = await deleteGiftReceipt({
      workEmail: target.workEmail,
      milestoneIndex: target.milestoneIndex,
      expectReceived: body.expect_received,
    });
    if (error) return NextResponse.json({ error }, { status: 500 });
    if (!row) {
      return NextResponse.json(
        { error: 'This gift record changed or was already cleared. Refresh and try again.' },
        { status: 409 },
      );
    }

    // The deleted row is snapshotted into the trail: withdrawing an assertion
    // destroys the only record that it was ever made. The reason is the one
    // thing that cannot be reconstructed afterwards.
    void insertAuditLog({
      user_name: authz.sessionEmail,
      user_role: authz.roles[0] ?? 'hr',
      action: 'gift_receipt.withdrawn',
      resource: 'employee_gift_receipts',
      resource_id: `${target.workEmail}#${target.milestoneIndex}`,
      details: {
        work_email: target.workEmail,
        milestone_index: target.milestoneIndex,
        reason: why.reason,
        deleted_row: row,
      },
    });

    return NextResponse.json({ error: null, existed: true });
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    return NextResponse.json({ error: msg }, { status: 500 });
  }
}
