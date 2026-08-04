import 'server-only';

/**
 * Recently offboarded people who may still need their FINAL paycheck's rate
 * or bank details set — feeds the Payroll Notes FAB's "Offboarded" tab.
 *
 * Built entirely from existing, already-hardened primitives:
 *   - `listRecentlyOffboardedPeople` — who left (unioned from every place an
 *     off-board gets recorded; the same function the KPI bonus calculators'
 *     "Offboarded" pickers already use).
 *   - `offboardedRelevantToWeek` — whether they're still owed a final check
 *     for the CURRENT pay week (the same week-scoping the KPI calculators
 *     use), so a leaver drops off this tab once their final pay is out.
 *   - `getOffboardSnapshot` — their bank/routing/processor data frozen at the
 *     moment HR offboarded them, read here for the first time anywhere.
 *
 * Rate/bank status is judged the SAME way the Readiness tab's own
 * missing-rate/missing-bank checks judge active employees, so this tab never
 * disagrees with what Payment Dispatch would actually do.
 */
import { listRecentlyOffboardedPeople } from '@/lib/roster/recently-offboarded';
import { offboardedRelevantToWeek } from '@/lib/roster/offboarded-week-relevance';
import { resolveCurrentWeek } from '@/lib/payroll/payroll-readiness';
import { isEligibleForFinalPayReview } from '@/lib/payroll/offboarded-final-pay-eligibility';
import { loadPeopleRateContext, resolvePeopleRate } from '@/lib/people/people-roster';
import { getEmployeeIds } from '@/lib/supabase/employee-ids';
import {
  getEmployeeHourlyRatesRows,
  indexHourlyRatesByEmail,
} from '@/lib/supabase/employee-hourly-rates';
import {
  isPayoutComplete,
  resolveEffectivePayoutProcessor,
  payoutDraftFromIdsRow,
  type PayoutLegacyExtras,
} from '@/lib/employee/payout-completeness';
import { getOffboardSnapshot } from '@/lib/hr/offboard-snapshot';
import { weekRangeLabel } from '@/lib/payroll/manila-week';
import { offboardReasonLabel } from '@/lib/hr/offboard-reasons';
import { normEmail } from '@/lib/email/norm-email';

export interface OffboardedBankPrefill {
  walletEmail: string;
  walletName: string;
  bankName: string;
  accountHolder: string;
  accountNumber: string;
  swiftCode: string;
}

export interface OffboardedPayrollCandidate {
  name: string;
  department: string | null;
  workEmail: string | null;
  personalEmail: string | null;
  /** `YYYY-MM-DD` they left; null when they only fell off the sheet unstamped. */
  offBoardedAt: string | null;
  /** Human-readable reason label, null when unknown (never `temporary_pause` —
   *  that reason is filtered out before this list is built). */
  offBoardedReasonLabel: string | null;
  rateStatus: 'ok' | 'missing';
  bankStatus: 'ok' | 'missing' | 'missing_has_snapshot';
  /** The processor Set Bank should lock to, when one resolves (from their
   *  current employee_ids row, or from their offboard snapshot). */
  bankProcessor: string | null;
  /** Present only when bankStatus is 'missing_has_snapshot' — seeds the Set
   *  Bank form with what was on file at the moment they were offboarded. */
  bankPrefill: OffboardedBankPrefill | null;
}

/** Picks the first snapshot `employee_ids` row that actually resolves a
 *  processor — a person can carry more than one row (dual-department), and
 *  an empty/legacy row must not shadow a usable one. */
function pickSnapshotIdRow(rows: Record<string, unknown>[]): Record<string, unknown> | null {
  return rows.find((r) => resolveEffectivePayoutProcessor(r)) ?? rows[0] ?? null;
}

export async function listOffboardedPayrollCandidates(sourceFile: string | null): Promise<{
  people: OffboardedPayrollCandidate[];
  weekLabel: string;
  degraded: string[];
  error: string | null;
}> {
  const { weekStart, degraded: weekDegraded } = await resolveCurrentWeek(sourceFile);

  const [offboardedRes, rateCtx, idsRes, ratesRes] = await Promise.all([
    listRecentlyOffboardedPeople(90),
    loadPeopleRateContext(),
    getEmployeeIds().catch(() => ({ rows: [], error: 'unreachable' })),
    getEmployeeHourlyRatesRows().catch(() => ({ rows: [], error: 'unreachable' })),
  ]);

  if (offboardedRes.error) {
    return { people: [], weekLabel: weekRangeLabel(weekStart), degraded: weekDegraded, error: offboardedRes.error };
  }

  const degraded = [...weekDegraded];
  if (idsRes.error) {
    degraded.push(
      'Payout records (employee_ids) couldn’t be read — bank status may read as missing until it recovers.',
    );
  }
  if (ratesRes.error) {
    degraded.push('The legacy rates sheet couldn’t be read — bank status was judged without its fallbacks.');
  }

  const idRowByEmail = new Map<string, Record<string, unknown>>();
  for (const r of idsRes.rows) {
    for (const e of [r.work_email, r.personal_email]) {
      const em = normEmail(e ?? '');
      if (em) idRowByEmail.set(em, r as unknown as Record<string, unknown>);
    }
  }
  const ratesByEmail = indexHourlyRatesByEmail(ratesRes.rows);

  const people: OffboardedPayrollCandidate[] = [];
  for (const person of offboardedRes.people) {
    if (!isEligibleForFinalPayReview(person.off_boarded_reason)) continue;
    if (!offboardedRelevantToWeek(person, weekStart, offboardedRes.hoursWeekFloor)) continue;

    const w = normEmail(person.work_email ?? '');
    const p = normEmail(person.personal_email ?? '');
    const aliases = [w, p].filter((e): e is string => !!e);

    const rate = resolvePeopleRate(rateCtx, aliases, person.department);
    const rateStatus: 'ok' | 'missing' = rate.source === null ? 'missing' : 'ok';

    const idRow = (w && idRowByEmail.get(w)) || (p && idRowByEmail.get(p)) || null;
    const legacyRates = (w && ratesByEmail.get(w)) || (p && ratesByEmail.get(p)) || null;
    const extras: PayoutLegacyExtras | undefined = legacyRates
      ? {
          bankPreferredRaw: legacyRates.bank_preferred,
          hurupayEmail: legacyRates.hurupay_email,
          higlobeEmail: legacyRates.higlobe_email,
          higlobeAccountName: legacyRates.higlobe_account_name,
        }
      : undefined;

    const payable = isPayoutComplete(idRow, extras);
    let bankProcessor = resolveEffectivePayoutProcessor(idRow, extras);
    let bankStatus: 'ok' | 'missing' | 'missing_has_snapshot' = payable ? 'ok' : 'missing';
    let bankPrefill: OffboardedBankPrefill | null = null;

    if (!payable && person.work_email) {
      const snapshot = await getOffboardSnapshot(person.work_email);
      const snapshotIdRow = snapshot ? pickSnapshotIdRow(snapshot.employee_ids) : null;
      const snapshotProcessor = snapshotIdRow ? resolveEffectivePayoutProcessor(snapshotIdRow) : null;
      if (snapshotIdRow && snapshotProcessor) {
        bankStatus = 'missing_has_snapshot';
        bankProcessor = bankProcessor ?? snapshotProcessor;
        const draft = payoutDraftFromIdsRow(snapshotIdRow).payout;
        bankPrefill = {
          walletEmail:
            snapshotProcessor === 'hurupay'
              ? draft.hurupayEmail
              : snapshotProcessor === 'wepay'
                ? draft.wepayEmail
                : snapshotProcessor === 'higlobe'
                  ? draft.higlobeEmail
                  : '',
          walletName: draft.higlobeAccountName,
          bankName: draft.bankName || draft.altBankName,
          accountHolder: draft.accountHolderName || draft.altAccountHolderName,
          accountNumber: draft.accountNumber || draft.altAccountNumber,
          swiftCode: draft.swiftCode || draft.altSwiftCode,
        };
      }
    }

    people.push({
      name: person.name,
      department: person.department,
      workEmail: person.work_email,
      personalEmail: person.personal_email,
      offBoardedAt: person.off_boarded_at,
      offBoardedReasonLabel: person.off_boarded_reason ? offboardReasonLabel(person.off_boarded_reason) : null,
      rateStatus,
      bankStatus,
      bankProcessor,
      bankPrefill,
    });
  }

  people.sort(
    (a, b) =>
      (b.offBoardedAt ?? '9999-99-99').localeCompare(a.offBoardedAt ?? '9999-99-99') ||
      a.name.localeCompare(b.name),
  );

  return { people, weekLabel: weekRangeLabel(weekStart), degraded, error: null };
}
