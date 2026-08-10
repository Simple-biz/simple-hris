import { NextResponse } from 'next/server';
import {
  listPayStructures,
  upsertPayStructure,
  deletePayStructure,
} from '@/lib/supabase/pay-structures-db';
import { deniedResponse, requireRateVisibilitySession } from '@/lib/auth/authorize-email';
import { requireFeatureEdit } from '@/lib/auth/authorize-feature';
import { rejectWhilePayrollProcessing } from '@/lib/payroll/processing-guard';
import { validatePayStructure, type PayStructure } from '@/lib/payment-catalog/pay-structure';
import { insertRateHistoryRow } from '@/lib/payroll/rate-history';
import { insertAuditLog } from '@/lib/supabase/audit-log';
import { getSessionActor } from '@/lib/auth/session-actor';
import {
  normalizeSource,
  sourceLabel,
  PAYMENT_CATALOG_SOURCE,
  READINESS_SOURCE,
} from '@/lib/payroll/readiness-audit';
import { updateEmployeeRates } from '@/lib/supabase/employee-hourly-rates';
import { invalidateRateProfilesCache } from '@/lib/supabase/employee-rate-profiles';
import { createSupabaseServiceRoleClient } from '@/lib/supabase/server';
import { normEmail } from '@/lib/email/norm-email';
import { updateEmployeeRateInSheet } from '@/lib/google-sheets/update-rates-sheet';
import { updateHslPayPlanRate } from '@/lib/google-sheets/update-hsl-pay-plan-sheet';
import { isHslSubDeptLabel } from '@/lib/departments/hsl-subdept';

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

async function syncRateHistory(
  s: PayStructure,
  actor: string,
  source: string,
  effectiveDateIso?: string,
): Promise<void> {
  const email = normEmail(s.employeeEmail ?? '') ?? null;
  if (!email) return;

  // The Rate History panel (BonusCatalog.tsx) shows any note EXCEPT the literal
  // "Set via Payment Catalog", which it hides. So a Readiness fix writes a
  // distinct note ("Set from Payroll Wizard by <actor>") that renders there as
  // the visible "changed from Payroll Wizard by:" attribution; a normal catalog
  // save keeps the hidden constant.
  const rateNote =
    source === READINESS_SOURCE
      ? `Set from ${sourceLabel(source)} by ${actor}`
      : 'Set via Payment Catalog';

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
      note: rateNote,
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
    //
    // An HSL SUB-TEAM key (`hsl:intake_specialist`, …) is still Hogan: since the
    // Pay Structure rail lists the sub-teams, an individual rate can now be saved
    // while a sub-team is selected, and a bare `=== HOGAN_DEPT_KEY` test would
    // silently stop mirroring it to the Pay Plan sheet.
    if (s.departmentKey === HOGAN_DEPT_KEY || isHslSubDeptLabel(s.departmentKey)) {
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
  // Pay structures ARE the authoritative pay rates (regularRate/otRate per
  // department/employee). Accounting/CEO only — the GET used to be ungated, so
  // any authenticated user could read every structure's figures. Consumers are
  // accounting surfaces (Payroll Wizard, Payment Catalog); the HR onboarding form
  // only subscribes to realtime change events, it never GETs this list.
  const authz = await requireRateVisibilitySession();
  if (!authz.ok) return deniedResponse(authz);
  const { structures, error } = await listPayStructures();
  if (error) return NextResponse.json({ structures: [], error }, { status: 500 });
  return NextResponse.json({ structures, error: null });
}

export async function POST(request: Request) {
  const authz = await requireFeatureEdit('accounting', 'bonus_catalog');
  if (!authz.ok) return deniedResponse(authz);
  // The catalog is the rate source of truth, so editing a structure mid-run
  // desyncs the staged amounts from what the paystub renders. Matches the
  // guard already on the per-employee applied amounts.
  const locked = await rejectWhilePayrollProcessing('editing the payment catalog');
  if (locked) return locked;
  const actor = authz.sessionEmail;

  let body: { structure?: PayStructure; effectiveDate?: string | null; source?: string };
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

  // Where this rate change was made from (Readiness fixer vs the Payment Catalog
  // itself). Drives the Rate History note + the audit-log attribution.
  const source = normalizeSource(body.source, PAYMENT_CATALOG_SOURCE);

  const { row, error } = await upsertPayStructure(s, actor);
  if (error) return NextResponse.json({ error }, { status: 500 });

  // Rates & Profiles overlays employee-scope catalog rates onto its cached
  // merge — a structure change must show there immediately, not after the TTL.
  invalidateRateProfilesCache();

  if (s.scope === 'employee') {
    void syncRateHistory(s, actor, source, body.effectiveDate ?? undefined).catch((err: unknown) => {
      console.warn('[pay-structures] syncRateHistory failed:', err);
    });

    // Audit trail (this route had none): an individual rate set, tagged with its
    // source so a Payroll-Wizard fix reads "via Payroll Wizard". Best-effort —
    // never fails the save. Identity comes from the verified session, not the body.
    const who = await getSessionActor();
    void insertAuditLog({
      user_name: who.user_name,
      user_role: who.user_role,
      action: 'payroll.rate.set',
      resource: 'payment_catalog_pay_structures',
      resource_id: s.employeeEmail ?? s.id,
      details: {
        source,
        source_label: sourceLabel(source),
        employee_email: s.employeeEmail ?? null,
        employee_name: s.employeeName ?? null,
        department_key: s.departmentKey,
        regular_rate: s.regularRate,
        ot_rate: s.otRate ?? null,
        currency: s.currency,
        effective_date: body.effectiveDate ?? null,
      },
    }).catch(() => undefined);
  }

  return NextResponse.json({ row, error: null });
}

export async function DELETE(request: Request) {
  const authz = await requireFeatureEdit('accounting', 'bonus_catalog');
  if (!authz.ok) return deniedResponse(authz);
  const locked = await rejectWhilePayrollProcessing('editing the payment catalog');
  if (locked) return locked;

  const { searchParams } = new URL(request.url);
  const id = searchParams.get('id');
  if (!id) return NextResponse.json({ error: 'Missing id' }, { status: 400 });

  const { error } = await deletePayStructure(id);
  if (error) return NextResponse.json({ error }, { status: 500 });
  // Deleting a structure changes which rate Rates & Profiles displays.
  invalidateRateProfilesCache();
  return NextResponse.json({ error: null });
}
