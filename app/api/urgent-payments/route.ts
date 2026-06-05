import { NextResponse } from 'next/server';
import { createSupabaseServiceRoleClient, createSupabaseServerClient } from '@/lib/supabase/server';
import { deniedResponse, requireElevatedSession } from '@/lib/auth/authorize-email';
import type { ProcessorId, QueueRow } from '@/components/payroll-clerk/mock-queue';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

const KNOWN_PROCESSORS = new Set<ProcessorId>(['hurupay', 'wepay', 'higlobe', 'wise', 'jeeves', 'wires']);

function isKnownProcessor(v: string): v is ProcessorId {
  return (KNOWN_PROCESSORS as Set<string>).has(v);
}

function pickFirst(...values: Array<string | null | undefined>): string | undefined {
  for (const v of values) {
    if (v != null && String(v).trim() !== '') return String(v).trim();
  }
  return undefined;
}

interface UrgentPaymentRow {
  id: string;
  work_email: string;
  full_name: string;
  department: string;
  disbursement_reason: string | null;
  explanation: string | null;
  amount_needed: number | null;
  created_at: string;
  reviewed_by: string | null;
  reviewed_at: string | null;
  /** The recipient's saved preferred processor (defaults to 'wise' for MESA). */
  processor: ProcessorId;
  /** Per-processor payout detail so Mark Paid pre-fills for whichever processor the clerk picks. */
  details: QueueRow['details'];
}

// Minimal shape of the employee_ids columns we read for payout pre-fill.
type IdsRow = {
  work_email: string | null;
  preferred_processor: string | null;
  preferred_bank_slot: string | null;
  bank_name: string | null;
  account_holder_name: string | null;
  account_number: string | null;
  routing_number: string | null;
  alt_bank_name: string | null;
  alt_account_holder_name: string | null;
  alt_account_number: string | null;
  alt_routing_number: string | null;
  hurupay_email: string | null;
  wepay_email: string | null;
  higlobe_email: string | null;
  higlobe_account_name: string | null;
  wise_email: string | null;
  wise_tag: string | null;
  phone_number: string | null;
  swift_code: string | null;
  full_address: string | null;
};

function buildDetails(ids: IdsRow | undefined, workEmail: string): QueueRow['details'] {
  const slot = ids?.preferred_bank_slot === 'alternative' ? 'alternative' : 'primary';
  const bankName = slot === 'alternative'
    ? pickFirst(ids?.alt_bank_name, ids?.bank_name)
    : pickFirst(ids?.bank_name, ids?.alt_bank_name);
  const accountHolder = slot === 'alternative'
    ? pickFirst(ids?.alt_account_holder_name, ids?.account_holder_name)
    : pickFirst(ids?.account_holder_name, ids?.alt_account_holder_name);
  const accountNumber = slot === 'alternative'
    ? pickFirst(ids?.alt_account_number, ids?.account_number)
    : pickFirst(ids?.account_number, ids?.alt_account_number);
  const swiftCode = slot === 'alternative'
    ? pickFirst(ids?.alt_routing_number, ids?.swift_code, ids?.routing_number)
    : pickFirst(ids?.swift_code, ids?.routing_number, ids?.alt_routing_number);
  return {
    email: workEmail,
    hurupay_email: pickFirst(ids?.hurupay_email),
    wepay_email: pickFirst(ids?.wepay_email),
    higlobe_email: pickFirst(ids?.higlobe_email),
    higlobe_account_name: pickFirst(ids?.higlobe_account_name),
    wise_email: pickFirst(ids?.wise_email),
    wise_tag: pickFirst(ids?.wise_tag),
    phone_number: pickFirst(ids?.phone_number),
    full_address: pickFirst(ids?.full_address),
    bank_name: bankName,
    account_holder_name: accountHolder,
    account_number: accountNumber,
    swift_code: swiftCode,
  };
}

// GET /api/urgent-payments
// Returns approved, not-yet-dispatched MESA disbursement requests, each carrying
// the recipient's preferred payment processor + payout details so the Urgent
// queue can default + pre-fill the Mark Paid dialog per recipient.
// Accounting / payroll-clerk only.
export async function GET() {
  try {
    const authz = await requireElevatedSession();
    if (!authz.ok) return deniedResponse(authz);

    const supabase = createSupabaseServiceRoleClient() ?? createSupabaseServerClient();
    if (!supabase) return NextResponse.json({ error: 'DB unavailable' }, { status: 500 });

    const { data, error } = await supabase
      .from('mesa_requests')
      .select('id, work_email, full_name, department, disbursement_reason, explanation, amount_needed, created_at, reviewed_by, reviewed_at')
      .eq('request_type', 'disbursement')
      .eq('status', 'approved')
      .is('dispatched_at', null)
      .order('reviewed_at', { ascending: true });

    if (error) return NextResponse.json({ error: error.message }, { status: 500 });

    const rows = (data ?? []) as Array<{
      id: string;
      work_email: string;
      full_name: string;
      department: string;
      disbursement_reason: string | null;
      explanation: string | null;
      amount_needed: number | null;
      created_at: string;
      reviewed_by: string | null;
      reviewed_at: string | null;
    }>;

    // Batch-fetch employee_ids for processor preference + payout pre-fill.
    const emails = [...new Set(rows.map((r) => r.work_email.trim().toLowerCase()))];
    const idsByEmail: Record<string, IdsRow> = {};

    if (emails.length > 0) {
      const { data: idsData } = await supabase
        .from('employee_ids')
        .select('work_email, preferred_processor, preferred_bank_slot, bank_name, account_holder_name, account_number, routing_number, alt_bank_name, alt_account_holder_name, alt_account_number, alt_routing_number, hurupay_email, wepay_email, higlobe_email, higlobe_account_name, wise_email, wise_tag, phone_number, swift_code, full_address')
        .in('work_email', emails);

      for (const row of (idsData ?? []) as IdsRow[]) {
        const e = row.work_email?.trim().toLowerCase();
        if (e) idsByEmail[e] = row;
      }
    }

    const result: UrgentPaymentRow[] = rows.map((r) => {
      const ids = idsByEmail[r.work_email.trim().toLowerCase()];
      const chose = (ids?.preferred_processor ?? '').trim().toLowerCase();
      const processor: ProcessorId = isKnownProcessor(chose) ? chose : 'wise';
      return {
        ...r,
        processor,
        details: buildDetails(ids, r.work_email),
      };
    });

    return NextResponse.json({ rows: result });
  } catch (e) {
    return NextResponse.json({ error: String(e) }, { status: 500 });
  }
}
