import { NextResponse } from 'next/server';
import { verifyGiftAddressOtp } from '@/lib/gift-address/otp';
import { insertAuditLog } from '@/lib/supabase/audit-log';
import { normEmail } from '@/lib/email/norm-email';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

function clientIp(req: Request): string | null {
  const xff = req.headers.get('x-forwarded-for');
  if (xff) return xff.split(',')[0]?.trim() || null;
  return req.headers.get('x-real-ip');
}

const MESSAGES: Record<'invalid' | 'expired' | 'locked', string> = {
  invalid: "That code doesn't match. Check the email and try again.",
  // Covers a genuinely expired code AND an address that belongs to nobody —
  // deliberately the same sentence, so this cannot be used to find out who works
  // here (see the core's verifyCode).
  expired: 'That code has expired. Request a new one.',
  locked: 'Too many attempts. Request a new code.',
};

/**
 * Exchange a 6-digit code for a session token.
 *
 * The token is returned to the browser ONCE and only its hash is stored. Every
 * later step resolves identity from the token — the email in this request body
 * is used to find the code and is never trusted again.
 */
export async function POST(req: Request) {
  const body = (await req.json().catch(() => ({}))) as { email?: string; code?: string };
  const email = normEmail(body.email) ?? '';
  const code = String(body.code ?? '').trim();

  if (!email || !code) {
    return NextResponse.json({ error: 'Enter the 6-digit code.' }, { status: 400 });
  }

  const ip = clientIp(req);
  const out = await verifyGiftAddressOtp(email, code);

  if (!out.ok) {
    void insertAuditLog({
      user_name: 'external',
      user_role: 'public',
      action: 'gift_address.otp_verify_failed',
      resource: 'gift_address_otps',
      resource_id: email,
      details: { reason: out.reason, channel: 'external_link' },
      ip_address: ip,
    });
    // 400 for every failure shape. A 404 on "no such person" would restore the
    // enumeration oracle the shared message exists to close.
    return NextResponse.json({ error: MESSAGES[out.reason] }, { status: 400 });
  }

  const person = out.person!;
  void insertAuditLog({
    user_name: 'external',
    user_role: 'public',
    action: 'gift_address.otp_verified',
    resource: 'gift_address_otps',
    resource_id: person.workEmail,
    details: { channel: 'external_link' },
    ip_address: ip,
  });

  return NextResponse.json({
    sessionToken: out.sessionToken,
    name: person.name,
    workEmail: person.workEmail,
  });
}
