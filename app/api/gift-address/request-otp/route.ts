import { NextResponse } from 'next/server';
import {
  createGiftAddressOtp,
  findActiveEmployeeByEmail,
} from '@/lib/gift-address/otp';
import {
  resolveGiftAddressOtpWebhookUrl,
  sendGiftAddressOtpEmail,
} from '@/lib/gift-address/otp-email';
import { insertAuditLog } from '@/lib/supabase/audit-log';
import { normEmail } from '@/lib/email/norm-email';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

function clientIp(req: Request): string | null {
  const xff = req.headers.get('x-forwarded-for');
  if (xff) return xff.split(',')[0]?.trim() || null;
  return req.headers.get('x-real-ip');
}

/**
 * ALWAYS THE SAME ANSWER.
 *
 * This endpoint is public and unauthenticated. Any variation between "that is an
 * employee" and "that is not" turns it into a staff directory that anyone on the
 * internet can enumerate — and the roster is people's names and addresses. A
 * throttled send returns this too, so hitting the cap does not confirm the
 * address is real either.
 */
const GENERIC = {
  ok: true,
  message:
    'If that address belongs to a Simple.biz team member, a 6-digit code is on its way to their work inbox.',
};

/**
 * Strict-enough email shape that excludes LIKE/PostgREST metacharacters (`%`,
 * quotes, parens, commas, whitespace) before any database lookup. `_ . + -` stay
 * allowed — they are valid in real addresses — and are escaped at the query layer.
 */
const EMAIL_OK = /^[^\s@%,"'()]+@[^\s@%,"'()]+\.[^\s@%,"'()]+$/;

export async function POST(req: Request) {
  const body = (await req.json().catch(() => ({}))) as { email?: string };
  const email = normEmail(body.email) ?? '';
  if (!email) {
    return NextResponse.json({ error: 'Enter your Simple.biz email.' }, { status: 400 });
  }
  // Malformed input answers generically WITHOUT a database hit, so it is
  // indistinguishable from a well-formed address that belongs to nobody.
  if (!EMAIL_OK.test(email)) return NextResponse.json(GENERIC);

  // Resolve the email channel first. A missing webhook is a deployment
  // misconfiguration rather than a fact about this person, so reporting it leaks
  // nothing and keeps the generic answer below genuinely uniform. In dev we
  // proceed without n8n and print the code so the flow stays testable.
  const webhook = await resolveGiftAddressOtpWebhookUrl();
  const isDev = process.env.NODE_ENV !== 'production';
  if (!webhook && !isDev) {
    return NextResponse.json(
      { error: "The confirmation-email channel isn't set up yet. Please contact HR." },
      { status: 503 },
    );
  }

  const ip = clientIp(req);
  const person = await findActiveEmployeeByEmail(email);

  if (!person) {
    void insertAuditLog({
      user_name: 'external',
      user_role: 'public',
      action: 'gift_address.otp_requested',
      resource: 'gift_address_otps',
      resource_id: email,
      details: { found: false, channel: 'external_link' },
      ip_address: ip,
    });
    return NextResponse.json(GENERIC);
  }

  const code = await createGiftAddressOtp(person.workEmail, ip);
  if (!code) {
    // Throttled, or the store failed. Same answer as success — see GENERIC.
    void insertAuditLog({
      user_name: 'external',
      user_role: 'public',
      action: 'gift_address.otp_throttled',
      resource: 'gift_address_otps',
      resource_id: person.workEmail,
      details: { channel: 'external_link' },
      ip_address: ip,
    });
    return NextResponse.json(GENERIC);
  }

  let sent = false;
  if (webhook) {
    try {
      sent = (await sendGiftAddressOtpEmail(person.workEmail, person.name, code)).ok;
    } catch {
      sent = false;
    }
  } else if (isDev) {
    console.info(`[gift-address] OTP for ${person.workEmail}: ${code}`);
    sent = true;
  }

  void insertAuditLog({
    user_name: 'external',
    user_role: 'public',
    action: 'gift_address.otp_requested',
    resource: 'gift_address_otps',
    resource_id: person.workEmail,
    // The CODE is never audited — the trail would otherwise hand a reader a
    // live credential. Only that one was sent, and whether it left.
    details: { found: true, sent, channel: 'external_link' },
    ip_address: ip,
  });

  return NextResponse.json(GENERIC);
}
