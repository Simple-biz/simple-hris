import { updateEmployeeRates } from "@/lib/supabase/employee-hourly-rates";
import { createSupabaseServiceRoleClient, createSupabaseServerClient } from "@/lib/supabase/server";
import { insertAuditLog } from "@/lib/supabase/audit-log";
import { invalidateRateProfilesCache } from "@/lib/supabase/employee-rate-profiles";
import { insertRateHistoryRow } from "@/lib/payroll/rate-history";
import { NextResponse } from "next/server";

const SYSTEM_USER = { name: 'Fran M', role: 'Senior Admin' } as const;
const RATES_TABLE = process.env.NEXT_PUBLIC_SUPABASE_EMPLOYEE_HOURLY_RATES_TABLE?.trim() || 'employee_hourly_rates';

function parseDateOnly(v: unknown): Date | null {
  if (typeof v !== 'string' || !v) return null;
  const m = v.match(/^(\d{4})-(\d{2})-(\d{2})/);
  if (!m) return null;
  return new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3]));
}

function todayMidnight(): Date {
  const n = new Date();
  return new Date(n.getFullYear(), n.getMonth(), n.getDate());
}

function fmtIsoDate(d: Date): string {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

function fmtFriendly(d: Date): string {
  try {
    return new Intl.DateTimeFormat(undefined, { month: 'long', day: 'numeric', year: 'numeric' }).format(d);
  } catch {
    return fmtIsoDate(d);
  }
}

export async function POST(req: Request) {
  try {
    const { workEmail, personalEmail, regularRate, otRate, effectiveDate } = await req.json();

    if (!workEmail && !personalEmail) {
      return NextResponse.json(
        { error: "Work email or personal email is required" },
        { status: 400 }
      );
    }

    if (regularRate === undefined || otRate === undefined) {
      return NextResponse.json(
        { error: "Regular rate and OT rate are required" },
        { status: 400 }
      );
    }

    // Effective date — defaults to today (immediate). Past dates are allowed
    // (they retroactively prorate prior days in the current cycle).
    const effective = parseDateOnly(effectiveDate) ?? todayMidnight();
    const today = todayMidnight();
    const isImmediate = effective.getTime() <= today.getTime();

    // Fetch existing rates for before/after audit trail
    const supabase = createSupabaseServiceRoleClient() ?? createSupabaseServerClient();
    let oldRegular: string | null = null;
    let oldOt: string | null = null;
    if (supabase) {
      const matchCol = workEmail ? 'Work Email' : 'Personal Email';
      const matchVal = workEmail || personalEmail;
      const { data } = await supabase
        .from(RATES_TABLE)
        .select('"Regular Rate", "OT Rate"')
        .eq(matchCol, matchVal)
        .maybeSingle();
      if (data) {
        oldRegular = (data as Record<string, unknown>)['Regular Rate'] as string | null;
        oldOt      = (data as Record<string, unknown>)['OT Rate']      as string | null;
      }
    }

    // Always record the change in the history table (authoritative source for
    // payroll prorating). Email lower-casing handled by the table trigger.
    const recipient = workEmail || personalEmail;

    // Supersede any existing rate-history row whose effective_from is today or
    // later for this email. Rationale: there should only be ONE active or
    // pending rate change per person at any moment — accountants who mis-set
    // a rate and re-save should overwrite the bad row, not stack a new one
    // on top. Historical rows (effective_from < today) are preserved so past
    // payroll cycles keep their correct per-day rates.
    if (supabase) {
      const todayIso = fmtIsoDate(today);
      const recipientNorm = String(recipient).trim().toLowerCase();
      const { error: supersedeErr } = await supabase
        .from('employee_rate_history')
        .delete()
        .eq('employee_email', recipientNorm)
        .gte('effective_from', todayIso);
      if (supersedeErr) {
        // eslint-disable-next-line no-console
        console.warn('[update-employee-rates] supersede failed:', supersedeErr.message);
      }
    }

    const { error: histErr } = await insertRateHistoryRow({
      email: recipient,
      regularRate,
      otRate,
      effectiveFrom: effective,
      createdBy: SYSTEM_USER.name,
    });
    if (histErr) {
      // Surface in logs but don't block — the cache update below is what
      // existing read paths still depend on.
      // eslint-disable-next-line no-console
      console.warn('[update-employee-rates] rate-history insert failed:', histErr);
    }

    // Only update the denormalized "current rate" cache when the change is
    // effective today or earlier. Future-dated changes leave the cache alone
    // and become active automatically as soon as payroll re-reads history.
    if (isImmediate) {
      const { error } = await updateEmployeeRates({
        workEmail,
        personalEmail,
        regularRate,
        otRate,
      });
      if (error) {
        return NextResponse.json({ error }, { status: 500 });
      }
      invalidateRateProfilesCache();
    }

    void insertAuditLog({
      user_name:   SYSTEM_USER.name,
      user_role:   SYSTEM_USER.role,
      action:      'employee.rates.update',
      resource:    'employee_hourly_rates',
      resource_id: recipient,
      details: {
        employee:  recipient,
        before:    { regular_rate: oldRegular, ot_rate: oldOt },
        after:     { regular_rate: regularRate, ot_rate: otRate },
        effective_from: fmtIsoDate(effective),
        applied_to_cache: isImmediate,
      },
    });

    // Employee-facing notification. Tone is positive when at least one rate
    // ticked up; same/lowered values stay neutral. Message reflects whether
    // the change is immediate (or retroactive) vs. scheduled for a future
    // date — payroll for prior days uses the OLD rate either way.
    if (supabase) {
      const toNum = (v: unknown) => {
        const n = parseFloat(String(v ?? '').replace(/,/g, ''));
        return Number.isFinite(n) ? n : null;
      };
      const oldReg = toNum(oldRegular);
      const oldOtN = toNum(oldOt);
      const newReg = toNum(regularRate);
      const newOtN = toNum(otRate);

      const regUp = oldReg !== null && newReg !== null && newReg > oldReg;
      const otUp  = oldOtN !== null && newOtN !== null && newOtN > oldOtN;
      const anyUp = regUp || otUp;

      const tone: 'positive' | 'neutral' = anyUp ? 'positive' : 'neutral';
      const friendly = fmtFriendly(effective);
      const scheduled = !isImmediate;

      const title = anyUp
        ? (scheduled ? `Rate increase scheduled — effective ${friendly}` : 'Congratulations on your rate increase!')
        : (scheduled ? `Rate change scheduled — effective ${friendly}` : 'Your hourly rate has been updated');

      const message = anyUp
        ? (scheduled
            ? `Your hourly rate will increase starting ${friendly}. Hours worked before that date will still be paid at your current rate.`
            : `Your hourly rate has been increased${effective.getTime() < today.getTime() ? ` (effective ${friendly})` : ''}. Keep up the great work!`)
        : (scheduled
            ? `Your hourly rate will change starting ${friendly}. Hours worked before that date are unaffected.`
            : `Your hourly rate has been updated${effective.getTime() < today.getTime() ? ` (effective ${friendly})` : ''}. See the details below for the latest figures.`);

      void supabase
        .from('employee_notifications')
        .insert({
          recipient_email: recipient,
          type: 'rate.change',
          tone,
          title,
          message,
          details: {
            before: { regular_rate: oldRegular, ot_rate: oldOt },
            after:  { regular_rate: regularRate, ot_rate: otRate },
            effective_from: fmtIsoDate(effective),
            scheduled,
            before_title: null,
            after_title:  null,
          },
        })
        .then(({ error: notifErr }) => {
          if (notifErr) {
            // eslint-disable-next-line no-console
            console.warn('[update-employee-rates] notification insert failed:', notifErr.message);
          }
        });
    }

    return NextResponse.json({
      success: true,
      effective_from: fmtIsoDate(effective),
      applied_to_cache: isImmediate,
    });
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    return NextResponse.json({ error: msg }, { status: 500 });
  }
}
