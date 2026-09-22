import { NextResponse } from 'next/server';
import { resolveGiftAddressSession } from '@/lib/gift-address/otp';
import { checkSubmissionKey } from '@/lib/gift-address/save';
import { buildGiftAsk } from '@/lib/gift-address/owed';
import { listGiftReceipts } from '@/lib/supabase/employee-gift-receipts';
import {
  listShippingDetails,
  upsertShippingDetail,
} from '@/lib/supabase/employee-gift-shipping';
import { parseStartDate } from '@/lib/gift-milestones';
import { APPAREL_SIZES } from '@/lib/gift-tracker/milestone-copy';
import {
  alternateRecipientColumns,
  hasAlternateRecipient,
  validateAlternateRecipient,
} from '@/lib/gift-tracker/alternate-recipient';
import { insertAuditLog } from '@/lib/supabase/audit-log';
import { notifyGiftShippingSubmitted } from '@/lib/notifications/gift-shipping-submitted';
import { broadcastFromServer } from '@/lib/supabase/realtime-broadcast';
import { GIFT_LIVE_EVENT, GIFT_LIVE_TOPIC } from '@/lib/gift-tracker/gift-live';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

function clientIp(req: Request): string | null {
  const xff = req.headers.get('x-forwarded-for');
  if (xff) return xff.split(',')[0]?.trim() || null;
  return req.headers.get('x-real-ip');
}

const MAX_LOCATION = 500;
const MAX_CONTACT = 60;
const MAX_NOTES = 500;

/**
 * Record one delivery address against every tenure gift this person is still
 * waiting for.
 *
 * THE IDENTITY AND THE MILESTONE LIST ARE BOTH SERVER-DERIVED.
 *
 * The request carries an address and a session token. It does NOT get to say who
 * it is, and it does NOT get to say which milestones to write — both are
 * recomputed here from the token. A body that could name its own milestones
 * would let someone write a submission row against a colleague's gift, and a
 * body that could name its own email is the redirect-the-parcel hole the bank
 * flow closed for salaries.
 *
 * SUBMITTING IS NOT RECEIVING. This writes `employee_gift_shipping_details`
 * only. `employee_gift_receipts` — the ledger of what was actually given — is
 * never touched from a public page; HR sets that in the Gift Tracker. An
 * employee marking their own gift received would make the backlog unfalsifiable.
 */
export async function POST(req: Request) {
  const body = (await req.json().catch(() => ({}))) as {
    sessionToken?: string;
    location?: string;
    contact?: string;
    size?: string;
    notes?: string;
    recipientName?: string;
    recipientRelationship?: string;
    recipientContact?: string;
  };

  const person = await resolveGiftAddressSession(String(body.sessionToken ?? ''));
  if (!person) {
    return NextResponse.json(
      { error: 'Your session expired. Request a new code.' },
      { status: 401 },
    );
  }

  const location = String(body.location ?? '').trim();
  const contact = String(body.contact ?? '').trim();
  const notes = String(body.notes ?? '').trim();
  const size = String(body.size ?? '').trim();

  if (!location) {
    return NextResponse.json({ error: 'Enter a delivery address.' }, { status: 400 });
  }
  if (!contact) {
    return NextResponse.json({ error: 'Enter a contact number.' }, { status: 400 });
  }
  if (location.length > MAX_LOCATION || contact.length > MAX_CONTACT || notes.length > MAX_NOTES) {
    return NextResponse.json({ error: 'That is longer than we can store.' }, { status: 400 });
  }
  // An unknown size is REFUSED rather than coerced to blank: a silently dropped
  // size means somebody receives the wrong shirt and never finds out why.
  if (size && !(APPAREL_SIZES as readonly string[]).includes(size)) {
    return NextResponse.json({ error: 'Pick a size from the list.' }, { status: 400 });
  }

  // Somebody else receiving the gift — in practice a spouse. Refused rather than
  // repaired, exactly like the size above and for the same reason: a half-filled
  // arrangement that the server quietly tidied away would leave the employee
  // believing their spouse was on the delivery.
  //
  // Note what this does NOT do: the recipient's number never replaces `contact`.
  // Kane's Q1 ruling — "The Employees as they will contact their spouse" — so
  // `active_contact_number` stays the employee's and the recipient's is a
  // fallback stored beside it.
  const recipient = validateAlternateRecipient({
    recipient_name: body.recipientName,
    recipient_relationship: body.recipientRelationship,
    recipient_contact: body.recipientContact,
  });
  if (!recipient.ok) {
    return NextResponse.json({ error: recipient.error }, { status: 400 });
  }

  const keyVerdict = await checkSubmissionKey(person.personalEmail);
  if (!keyVerdict.ok) {
    return NextResponse.json(
      {
        error:
          keyVerdict.reason === 'missing'
            ? 'We do not have a personal email on file for you, which we need to file this safely. Please contact HR.'
            : 'Your personal email is shared with another teammate on our records, so we cannot file this without mixing up your gifts. Please contact HR.',
        blocked: keyVerdict.reason,
      },
      { status: 409 },
    );
  }

  // Recompute the milestone list server-side — the body never names it.
  const { rows: receiptRows } = await listGiftReceipts({ workEmail: person.workEmail });
  const receiptsByIndex = new Map<number, boolean>();
  for (const r of receiptRows) receiptsByIndex.set(r.milestone_index, r.received);

  const { rows: subs } = await listShippingDetails({ personalEmail: keyVerdict.personalEmail });
  const ask = buildGiftAsk({
    start: parseStartDate(person.startDate),
    today: new Date(),
    receiptsByIndex,
    submittedIndexes: new Set(subs.map((s) => s.milestone_index)),
  });

  if (ask.collectFor.length === 0) {
    return NextResponse.json(
      { error: 'You have no gifts waiting to be sent right now.' },
      { status: 400 },
    );
  }

  const byIndex = new Map(ask.milestones.map((m) => [m.milestoneIndex, m]));
  // Which milestones already had a row BEFORE this write, so the alert can say
  // "updated" rather than "filled in". Read from the list already loaded above —
  // a second query would be a second answer to the same question.
  const submittedBefore = new Set(subs.map((s) => s.milestone_index));
  const saved: number[] = [];
  const refused: Array<{ milestoneIndex: number; error: string }> = [];

  for (const idx of ask.collectFor) {
    const milestone = byIndex.get(idx);
    if (!milestone) continue;
    const { error } = await upsertShippingDetail({
      personal_email: keyVerdict.personalEmail,
      milestone_index: idx,
      milestone_date: milestone.date,
      preferred_delivery_location: location,
      active_contact_number: contact,
      apparel_size: size,
      ...alternateRecipientColumns(recipient.value),
      notes,
    });
    // An already-APPROVED row refuses by design (the details are locked). That
    // is reported per milestone rather than failing the whole submission — the
    // other gifts still need an address.
    if (error) refused.push({ milestoneIndex: idx, error });
    else saved.push(idx);
  }

  void insertAuditLog({
    user_name: 'external',
    user_role: 'public',
    action: 'gift_address.saved',
    resource: 'employee_gift_shipping_details',
    resource_id: person.workEmail,
    details: {
      channel: 'external_link',
      // The ADDRESS itself is not written to the trail — the row holds it, and
      // the audit log is read by more people than the shipping list is.
      milestones_saved: saved,
      milestones_refused: refused.map((r) => r.milestoneIndex),
      has_size: Boolean(size),
      // A BOOLEAN, never the name or the number. The named person does not work
      // here and never agreed to appear in our audit log; that a redirection was
      // arranged is auditable, who they are is not. Same rule as the address.
      has_alternate_recipient: hasAlternateRecipient(
        alternateRecipientColumns(recipient.value),
      ),
    },
    ip_address: clientIp(req),
  });

  if (saved.length === 0) {
    return NextResponse.json(
      { error: 'Those gifts are already locked for shipping. Contact HR to change the address.' },
      { status: 409 },
    );
  }

  // Tell the Gift Tracker's people, and wake the "Recently filled / updated"
  // sub-tab. Both are fire-and-forget by contract: a bell and a socket message
  // must never be the thing that fails somebody's address submission. The notify
  // helper records its own failures into `audit_log`, so the CHECK-constraint
  // silence that killed `kpi.scored` for three days is visible here.
  //
  // Broadcast, NOT an `app_settings` pulse: the browser is `anon` and
  // `app_settings` is RLS "Admins only", so a pulse would never arrive
  // (memory/supabase-realtime-anon-rls-dead — Kane's ruling (a) on the brief).
  void notifyGiftShippingSubmitted({
    channel: 'external_link',
    employeeName: person.name ?? null,
    workEmail: person.workEmail,
    milestones: saved,
    hasAlternateRecipient: hasAlternateRecipient(alternateRecipientColumns(recipient.value)),
    isUpdate: saved.some((i) => submittedBefore.has(i)),
  });
  void broadcastFromServer(GIFT_LIVE_TOPIC, GIFT_LIVE_EVENT, {
    channel: 'external_link',
    milestones: saved,
    ts: Date.now(),
  });

  return NextResponse.json({ saved, refused, name: person.name });
}
