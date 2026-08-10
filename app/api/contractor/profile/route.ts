import { NextRequest, NextResponse } from 'next/server';
import { createClient } from '@supabase/supabase-js';
import { authorizeEmailAccess, deniedResponse } from '@/lib/auth/authorize-email';
import { getPayrollDispatchLock } from '@/lib/supabase/payroll-dispatch-lock';
import { insertAuditLog } from '@/lib/supabase/audit-log';
import { insertBankUpdateHistory } from '@/lib/supabase/bank-update-history';
import { getSessionActor } from '@/lib/auth/session-actor';
import { maskFieldValue } from '@/lib/bank-update/mask-field';

/**
 * Payout columns on `contractor_profiles`. Writing any of these is a
 * money-routing change, so it gets the same treatment the employee rail has
 * had all along: blocked while payroll is processing, audit-logged, and
 * recorded in `bank_update_history` with a masked before→after.
 */
const PAYOUT_FIELDS = [
  'preferred_processor', 'preferred_bank_slot',
  'hurupay_email', 'wepay_email', 'higlobe_email', 'higlobe_account_name',
  'wise_email', 'wise_tag', 'phone_number', 'full_address',
  'bank_name', 'account_holder_name', 'account_number', 'swift_code',
  'alt_bank_name', 'alt_account_holder_name', 'alt_account_number', 'alt_routing_number',
  'ach_account_holder', 'ach_bank_name', 'ach_account_number', 'ach_routing_number', 'ach_account_type',
] as const;

function errMsg(err: unknown): string {
  if (err instanceof Error) return err.message;
  if (typeof err === 'object' && err !== null && 'message' in err) return String((err as Record<string, unknown>).message);
  return errMsg(err);
}

function getServiceClient() {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL?.trim();
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY?.trim();
  if (!url || !key) throw new Error('Missing Supabase env vars');
  return createClient(url, key, { auth: { persistSession: false, autoRefreshToken: false } });
}

// GET /api/contractor/profile?email=...
// Self-or-elevated: the row carries bank account + ACH routing numbers, so a
// contractor may read only their own and everyone else needs elevation.
export async function GET(req: NextRequest) {
  const email = req.nextUrl.searchParams.get('email')?.toLowerCase().trim();
  if (!email) return NextResponse.json({ profile: null });
  const authz = await authorizeEmailAccess(email);
  if (!authz.ok) return deniedResponse(authz);
  try {
    const supabase = getServiceClient();
    const { data, error } = await supabase
      .from('contractor_profiles')
      .select('*')
      .eq('contractor_email', email)
      .maybeSingle();
    if (error) throw error;
    return NextResponse.json({ profile: data ?? null });
  } catch (err) {
    return NextResponse.json({ error: errMsg(err), profile: null }, { status: 500 });
  }
}

// POST /api/contractor/profile  — upsert by contractor_email
export async function POST(req: NextRequest) {
  try {
    const body = await req.json() as Record<string, unknown>;
    const email = String(body.contractor_email ?? '').toLowerCase().trim();
    if (!email) return NextResponse.json({ error: 'Missing contractor_email' }, { status: 400 });

    // The body-supplied email is the write key, so it MUST be authorized —
    // without this any signed-in account could redirect any contractor's payout.
    const authz = await authorizeEmailAccess(email);
    if (!authz.ok) return deniedResponse(authz);

    const touchesPayout = PAYOUT_FIELDS.some((f) =>
      Object.prototype.hasOwnProperty.call(body, f),
    );

    // Same freeze the employee rail has: no payout edits mid-dispatch, so a
    // contractor payment can't be redirected while Accounting is paying it out.
    // Non-payout edits (logo, display name, invoice "From" block) stay open.
    if (touchesPayout) {
      const lock = await getPayrollDispatchLock();
      if (lock.locked) {
        return NextResponse.json(
          { error: 'Payroll is being processed right now, so payment details are temporarily locked. Please try again after the dispatch completes.' },
          { status: 423 },
        );
      }
    }

    const supabase = getServiceClient();

    // Snapshot BEFORE values so the change trail can record a masked before→after.
    const { data: beforeRow } = touchesPayout
      ? await supabase.from('contractor_profiles').select('*').eq('contractor_email', email).maybeSingle()
      : { data: null };

    const { error } = await supabase
      .from('contractor_profiles')
      .upsert(
        {
          contractor_email:        email,
          display_name:            body.display_name             ?? null,
          logo_data_url:           body.logo_data_url            ?? null,
          // Invoice "From" details
          from_entity_name:        body.from_entity_name         ?? null,
          from_name:               body.from_name                ?? null,
          from_address:            body.from_address             ?? null,
          from_city_state_zip:     body.from_city_state_zip      ?? null,
          from_country:            body.from_country             ?? null,
          currency:                body.currency === 'USD' ? 'USD' : 'PHP',
          // Payment gateway
          preferred_processor:     body.preferred_processor      ?? null,
          preferred_bank_slot:     body.preferred_bank_slot      ?? 'primary',
          hurupay_email:           body.hurupay_email            ?? null,
          wepay_email:             body.wepay_email              ?? null,
          higlobe_email:           body.higlobe_email            ?? null,
          higlobe_account_name:    body.higlobe_account_name     ?? null,
          wise_email:              body.wise_email               ?? null,
          wise_tag:                body.wise_tag                 ?? null,
          phone_number:            body.phone_number             ?? null,
          full_address:            body.full_address             ?? null,
          bank_name:               body.bank_name                ?? null,
          account_holder_name:     body.account_holder_name      ?? null,
          account_number:          body.account_number           ?? null,
          swift_code:              body.swift_code               ?? null,
          alt_bank_name:           body.alt_bank_name            ?? null,
          alt_account_holder_name: body.alt_account_holder_name  ?? null,
          alt_account_number:      body.alt_account_number       ?? null,
          alt_routing_number:      body.alt_routing_number       ?? null,
          // US ACH rail
          ach_account_holder:      body.ach_account_holder       ?? null,
          ach_bank_name:           body.ach_bank_name            ?? null,
          ach_account_number:      body.ach_account_number       ?? null,
          ach_routing_number:      body.ach_routing_number       ?? null,
          ach_account_type:        body.ach_account_type         ?? null,
        },
        { onConflict: 'contractor_email' },
      );
    if (error) throw error;

    // Money-routing changes leave a trail — audit_log plus the non-clearable
    // bank_update_history feed, matching every employee-side payout writer.
    if (touchesPayout) {
      const before = (beforeRow ?? {}) as Record<string, unknown>;
      const changes = PAYOUT_FIELDS.filter((f) => Object.prototype.hasOwnProperty.call(body, f)).map((field) => {
        const rawBefore = before[field] != null ? String(before[field]) : null;
        const rawAfter = body[field] != null ? String(body[field]) : null;
        return {
          field,
          before: maskFieldValue(field, rawBefore),
          after: maskFieldValue(field, rawAfter),
          changed: (rawBefore ?? '').trim() !== (rawAfter ?? '').trim(),
        };
      });
      let actor = { user_name: authz.sessionEmail, user_role: 'contractor' };
      try { actor = await getSessionActor(); } catch { /* best-effort */ }
      await insertAuditLog({
        user_name: actor.user_name,
        user_role: actor.user_role,
        action: 'contractor.banking.updated',
        resource: 'contractor_profiles',
        resource_id: email,
        details: {
          via: authz.sessionEmail === email ? 'contractor_self' : 'accounting',
          edited_for: email,
          fields: changes.map((c) => c.field),
          changes,
        },
      }).catch(() => undefined);
      await insertBankUpdateHistory({
        work_email: email,
        employee_name: (body.display_name as string | null) ?? null,
        fields: changes.map((c) => c.field),
        changes,
        processor: (body.preferred_processor as string | null) ?? null,
        created_new: !beforeRow,
        via: authz.sessionEmail === email ? 'contractor_self' : 'contractor_admin',
        ip_address: null,
      }).catch(() => undefined);
    }

    return NextResponse.json({ success: true });
  } catch (err) {
    return NextResponse.json({ error: errMsg(err) }, { status: 500 });
  }
}

// PATCH /api/contractor/profile  — partial update of a single contractor's
// invoicing currency. Kept separate from POST so admins can set the currency
// without overwriting the contractor's own profile fields (and vice versa).
export async function PATCH(req: NextRequest) {
  try {
    const body = await req.json() as Record<string, unknown>;
    const email = String(body.contractor_email ?? '').toLowerCase().trim();
    if (!email) return NextResponse.json({ error: 'Missing contractor_email' }, { status: 400 });
    const authz = await authorizeEmailAccess(email);
    if (!authz.ok) return deniedResponse(authz);
    const currency = body.currency === 'USD' ? 'USD' : 'PHP';

    const supabase = getServiceClient();
    const { error } = await supabase
      .from('contractor_profiles')
      .upsert({ contractor_email: email, currency }, { onConflict: 'contractor_email' });
    if (error) throw error;
    return NextResponse.json({ success: true, currency });
  } catch (err) {
    return NextResponse.json({ error: errMsg(err) }, { status: 500 });
  }
}
