import { NextResponse } from 'next/server';
import { resolveGiftAddressSession } from '@/lib/gift-address/otp';
import { checkSubmissionKey } from '@/lib/gift-address/save';
import { buildGiftAsk } from '@/lib/gift-address/owed';
import { listGiftReceipts } from '@/lib/supabase/employee-gift-receipts';
import { listShippingDetails } from '@/lib/supabase/employee-gift-shipping';
import { parseStartDate } from '@/lib/gift-milestones';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

/**
 * Everything the verified page needs: the gifts reached since their start date,
 * which are already received, and the address last on file.
 *
 * IDENTITY COMES FROM THE SESSION TOKEN ONLY. There is no `?email=` on this
 * route by design — accepting one would let anyone with any valid session read
 * any colleague's home address and gift history.
 */
export async function POST(req: Request) {
  const body = (await req.json().catch(() => ({}))) as { sessionToken?: string };
  const person = await resolveGiftAddressSession(String(body.sessionToken ?? ''));
  if (!person) {
    return NextResponse.json(
      { error: 'Your session expired. Request a new code.' },
      { status: 401 },
    );
  }

  const [{ rows: receiptRows }, submissions] = await Promise.all([
    listGiftReceipts({ workEmail: person.workEmail }),
    person.personalEmail
      ? listShippingDetails({ personalEmail: person.personalEmail })
      : Promise.resolve({ rows: [], error: null }),
  ]);

  const receiptsByIndex = new Map<number, boolean>();
  for (const r of receiptRows) receiptsByIndex.set(r.milestone_index, r.received);

  const subs = submissions.rows ?? [];
  const submittedIndexes = new Set(subs.map((s) => s.milestone_index));

  const ask = buildGiftAsk({
    start: parseStartDate(person.startDate),
    today: new Date(),
    receiptsByIndex,
    submittedIndexes,
  });

  // Prefill from the newest submission on file so a returning person confirms
  // rather than retypes. Nothing here is a price or a gift assignment — those
  // columns are vestigial and never leave the server.
  const newest = [...subs].sort((a, b) => a.milestone_index - b.milestone_index).at(-1);

  // Tell the page up front when this person cannot be written for, so it can say
  // so BEFORE they fill in a form that would only be refused on submit.
  const keyVerdict = await checkSubmissionKey(person.personalEmail);

  return NextResponse.json({
    name: person.name,
    workEmail: person.workEmail,
    milestones: ask.milestones,
    collectFor: ask.collectFor,
    receivedCount: ask.receivedCount,
    pendingCount: ask.pendingCount,
    blocked: keyVerdict.ok ? null : keyVerdict.reason,
    prefill: newest
      ? {
          location: newest.preferred_delivery_location ?? '',
          contact: newest.active_contact_number ?? '',
          size: newest.apparel_size ?? '',
          notes: newest.notes ?? '',
        }
      : { location: '', contact: '', size: '', notes: '' },
  });
}
