import { NextResponse } from 'next/server';
import {
  listPayStructures,
  upsertPayStructure,
  deletePayStructure,
} from '@/lib/supabase/pay-structures-db';
import { requireElevatedSession, deniedResponse } from '@/lib/auth/authorize-email';
import { validatePayStructure, type PayStructure } from '@/lib/payment-catalog/pay-structure';
import { insertRateHistoryRow } from '@/lib/payroll/rate-history';
import { updateEmployeeRates } from '@/lib/supabase/employee-hourly-rates';
import { createSupabaseServiceRoleClient } from '@/lib/supabase/server';
import { normEmail } from '@/lib/email/norm-email';
import { updateEmployeeRateInSheet } from '@/lib/google-sheets/update-rates-sheet';
import { updateHslPayPlanRate } from '@/lib/google-sheets/update-hsl-pay-plan-sheet';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

/** Canonical department key for Hogan Smith Law (see normalize-dept-key.ts). */
const HOGAN_DEPT_KEY = 'hogan_smith_law';

function todayMidnight(): Date {
  const n = new Date();
  return new Date(n.getFullYear(), n.getMonth(), n.getDate());
}

function fmtIsoDate(d: Date): string {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

async function syncRateHistory(s: PayStructure, actor: string, effectiveDateIso?: string): Promise<void> {
  const email = normEmail(s.employeeEmail ?? '') ?? null;
  if (!email) return;

  const today = todayMidnight();
  const todayIso = fmtIsoDate(today);
  const supabase = createSupabaseServiceRoleClient();

  function parseDateOnly(v: string): Date | null {
    const m = v.match(/^(\d{4})-(\d{2})-(\d{2})/);
    if (!m) return null;
    return new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3]));
  }
  const effective = effectiveDateIso ? (parseDateOnly(effectiveDateIso) ?? today) : today;
  const effectiveIso = fmtIsoDate(effective);

  // USD pay structures are intentionally NOT pushed to the PHP-denominated rate
  // history / cache / Google Sheet: writing a USD number there would corrupt
  // them, and the rates sheet sync would later read it back as PHP. The Payment
  // Catalog overlay (src/lib/payroll/resolve-rate.ts) applies USD rates at
  // pay-calc time instead. The employee notification below still fires for both
  // currencies.
  if (s.currency !== 'USD') {
    if (supabase) {
      await supabase
        .from('employee_rate_history')
        .delete()
        .eq('employee_email', email)
        .gte('effective_from', todayIso);
    }

    await insertRateHistoryRow({
      email,
      regularRate: s.regularRate,
      otRate: s.otRate ?? null,
      effectiveFrom: effective,
      createdBy: actor,
      note: 'Set via Payment Catalog',
    });

    if (effective.getTime() <= today.getTime()) {
      await updateEmployeeRates({
        workEmail: email,
        regularRate: String(s.regularRate),
        otRate: String(s.otRate ?? s.regularRate),
      });
    }

    // Push to the Google Sheet rates tab so the Sheet stays in sync.
    // Individual rate overrides the department base -- only individual structures
    // call syncRateHistory so this only fires for per-person saves (never dept).
    void updateEmployeeRateInSheet({
      workEmail: email,
      regularRate: s.regularRate,
      otRate: s.otRate ?? null,
    }).catch((err: unknown) => {
      console.warn('[pay-structures] sheet rate sync failed:', err);
    });

    // Mirror the Hourly Rate + OT rate into the Hogan Agents Pay Plan sheet for
    // Hogan agents only. Surgical (matched by Email; never touches the curated
    // KPI/Scoreboard/Notes columns). Gated on department so non-Hogan saves don't
    // pay to read the large Hogan sheet for a guaranteed no-op.
    if (s.departmentKey === HOGAN_DEPT_KEY) {
      void updateHslPayPlanRate({
        workEmail: email,
        regularRate: s.regularRate,
        otRate: s.otRate ?? null,
      }).catch((err: unknown) => {
        console.warn('[pay-structures] HSL pay plan sync failed:', err);
      });
    }
  }

  if (supabase) {
    void supabase
      .from('employee_notifications')
      .insert({
        recipient_email: email,
        type: 'rate.change',
        tone: 'positive',
        title: 'Your hourly rate has been updated',
        message:
          'Your negotiated pay rate has been updated in the Payment Catalog. See the details below for the latest figures.',
        details: {
          after: { regular_rate: String(s.regularRate), ot_rate: String(s.otRate ?? ''), currency: s.currency },
          effective_from: effectiveIso,
          scheduled: effective.getTime() > today.getTime(),
          source: 'payment_catalog',
        },
      });
  }
}

export async function GET() {
  const { structures, error } = await listPayStructures();
  if (error) return NextResponse.json({ structures: [], error }, { status: 500 });
  return NextResponse.json({ structures, error: null });
}

export async function POST(request: Request) {
  const authz = await requireElevatedSession();
  if (!authz.ok) return deniedResponse(authz);
  const actor = authz.sessionEmail;

  let body: { structure?: PayStructure; effectiveDate?: string | null };
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: 'Invalid JSON body' }, { status: 400 });
  }

  const s = body.structure;
  if (!s || !s.id || !s.departmentKey) {
    return NextResponse.json({ error: 'Missing pay structure id or department' }, { status: 400 });
  }
  const check = validatePayStructure(s);
  if (!check.ok) return NextResponse.json({ error: check.error }, { status: 400 });

  const { row, error } = await upsertPayStructure(s, actor);
  if (error) return NextResponse.json({ error }, { status: 500 });

  if (s.scope === 'employee') {
    void syncRateHistory(s, actor, body.effectiveDate ?? undefined).catch((err: unknown) => {
      console.warn('[pay-structures] syncRateHistory failed:', err);
    });
  }

  return NextResponse.json({ row, error: null });
}

export async function DELETE(request: Request) {
  const authz = await requireElevatedSession();
  if (!authz.ok) return deniedResponse(authz);

  const { searchParams } = new URL(request.url);
  const id = searchParams.get('id');
  if (!id) return NextResponse.json({ error: 'Missing id' }, { status: 400 });

  const { error } = await deletePayStructure(id);
  if (error) return NextResponse.json({ error }, { status: 500 });
  return NextResponse.json({ error: null });
}
