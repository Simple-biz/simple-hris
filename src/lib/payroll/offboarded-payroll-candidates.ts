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
 *   - the offboard bank snapshot (`offboardSnapshotKey`) — their
 *     bank/routing/processor data frozen at the moment HR offboarded them, read
 *     here for the first time anywhere, in ONE bulk `app_settings` round trip
 *     for the whole list rather than one per person.
 *
 * Rate/bank status is judged the SAME way the Readiness tab's own
 * missing-rate/missing-bank checks judge active employees — including its two
 * exclusions (`isOffChannelDept` for USEE/US-Employee departments and
 * `loadContractorEmails` for Admin-provisioned contractors), both imported from
 * that module rather than re-implemented — so this tab never disagrees with what
 * Payment Dispatch would actually do.
 */
import { listRecentlyOffboardedPeople } from '@/lib/roster/recently-offboarded';
import { offboardedRelevantToWeek } from '@/lib/roster/offboarded-week-relevance';
import { loadCycleHoursIndex, personWorkedCycle } from '@/lib/payroll/cycle-hours-index';
import { resolveCurrentWeek, isOffChannelDept, loadContractorEmails } from '@/lib/payroll/payroll-readiness';
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
import { offboardSnapshotKey, type OffboardSnapshot } from '@/lib/hr/offboard-snapshot';
import { getAppSettings } from '@/lib/supabase/app-settings';
import { weekRangeLabel } from '@/lib/payroll/manila-week';
import { offboardReasonLabel } from '@/lib/hr/offboard-reasons';
import { normEmail } from '@/lib/email/norm-email';

export interface OffboardedBankPrefill {
  /** The processor the snapshot resolved. Seeds the Set Bank picker's initial
   *  selection WITHOUT locking it: a snapshot-only person has no live
   *  `preferred_processor`, and the dialog skips writing that column whenever it
   *  considers the processor locked — so locking on a snapshot value would let
   *  the clerk "save" a person who stays unpayable. See `bankProcessor` (live
   *  only) for the value that legitimately locks the picker. */
  processor: string | null;
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
  /** The processor Set Bank should lock to, when one resolves from their LIVE
   *  `employee_ids` row (or its legacy rates-sheet fallbacks) — never from the
   *  offboard snapshot. A snapshot-only processor rides `bankPrefill.processor`
   *  instead, so the picker pre-selects it while staying editable and the save
   *  path still writes `preferred_processor`. */
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

  const [offboardedRes, rateCtx, idsRes, ratesRes, contractorEmailsRes, hoursIdx] = await Promise.all([
    listRecentlyOffboardedPeople(90),
    loadPeopleRateContext(),
    getEmployeeIds().catch(() => ({ rows: [], error: 'unreachable' })),
    getEmployeeHourlyRatesRows().catch(() => ({ rows: [], error: 'unreachable' })),
    // Low-stakes read: failing it only means a contractor leaver may wrongly
    // read as missing a rate — never a wrong payment — so it degrades rather
    // than failing the load (same posture as payroll-readiness's own call).
    loadContractorEmails().catch(() => null),
    loadCycleHoursIndex(sourceFile),
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
  if (contractorEmailsRes === null) {
    degraded.push(
      'The contractor role list couldn’t be read — a contractor who left may read as missing a rate (they’re paid per-invoice, not hourly).',
    );
  }
  const contractorEmails = contractorEmailsRes ?? new Set<string>();

  const idRowByEmail = new Map<string, Record<string, unknown>>();
  for (const r of idsRes.rows) {
    for (const e of [r.work_email, r.personal_email]) {
      const em = normEmail(e ?? '');
      if (em) idRowByEmail.set(em, r as unknown as Record<string, unknown>);
    }
  }
  const ratesByEmail = indexHourlyRatesByEmail(ratesRes.rows);

  if (hoursIdx.error) {
    degraded.push(
      'This week’s timesheet couldn’t be read — the list may include leavers with no hours this week.',
    );
  }

  // Who this tab will actually show, decided BEFORE any snapshot read so the
  // bulk read below covers exactly the shown rows and nobody else.
  //
  // The hours gate refines the original "list everyone in the window" call
  // (Kane, 2026-08-07): final pay is FOR hours worked, so only leavers present
  // in this cycle's timesheet belong here. Date-based week relevance alone
  // trusts `off_boarded_at`, and one bad stamp defeats it — franm@'s sheet row
  // is year-typo'd 2027-04-20, which read as "left during or after" every week
  // for months after her real last hours (week of 2026-04-19). Fails OPEN when
  // the index couldn't load (degraded note above): a read hiccup must not hide
  // someone owed money.
  const eligible = offboardedRes.people.filter(
    (person) =>
      isEligibleForFinalPayReview(person.off_boarded_reason) &&
      offboardedRelevantToWeek(person, weekStart, offboardedRes.hoursWeekFloor) &&
      (hoursIdx.error !== null ||
        personWorkedCycle(hoursIdx, {
          emails: [
            person.hubstaff_email,
            person.work_email,
            person.personal_email,
            person.alternate_work_email,
            person.alternate_work_email_2,
          ],
          name: person.name,
        })),
  );

  // ONE bulk `app_settings` read for every candidate's offboard bank snapshot.
  // Live data has run to 60+ candidates on a single load, and the previous
  // per-person `getOffboardSnapshot()` await inside the loop meant one Supabase
  // round trip each. Parsing is inlined (same two rules getOffboardSnapshot
  // applies: JSON.parse, then require `v === 1`) so this module reads snapshots
  // without a per-person query.
  const snapshotKeyByEmail = new Map<string, string>();
  for (const person of eligible) {
    if (person.work_email) snapshotKeyByEmail.set(person.work_email, offboardSnapshotKey(person.work_email));
  }
  const rawSnapshots: Record<string, string | null> =
    snapshotKeyByEmail.size > 0
      ? await getAppSettings([...new Set(snapshotKeyByEmail.values())]).catch(() => ({}))
      : {};
  // One summary note, not one per person — a malformed snapshot degrades that
  // person to "no prior bank on file", which is the pre-snapshot behavior.
  let snapshotReadDegraded = false;
  const readSnapshot = (workEmail: string): OffboardSnapshot | null => {
    const key = snapshotKeyByEmail.get(workEmail);
    const raw = key ? rawSnapshots[key] : null;
    if (!raw) return null;
    try {
      const parsed = JSON.parse(raw) as OffboardSnapshot;
      return parsed && parsed.v === 1 ? parsed : null;
    } catch {
      snapshotReadDegraded = true;
      return null;
    }
  };

  const people: OffboardedPayrollCandidate[] = [];
  for (const person of eligible) {
    const w = normEmail(person.work_email ?? '');
    const p = normEmail(person.personal_email ?? '');
    const aliases = [w, p].filter((e): e is string => !!e);

    // The two exclusions payroll-readiness's own checks apply, mirrored here so
    // a leaver's pills never contradict them. Both are "not applicable", NOT
    // "hidden": the row stays listed (plan design decision #3 — list everyone in
    // the window), only its status is corrected. That matters because acting on a
    // false "No rate" files a REAL Payment Catalog structure and notifies the
    // person — wrong for someone who was never paid hourly.
    //   · off-channel (USEE / US Employees): paid outside this system entirely,
    //     so neither rate NOR bank runs through its machinery.
    //   · contractor (Admin `contractor` role): paid per-invoice, not hourly, so
    //     RATE is not applicable — but bank details still fund those invoices,
    //     so their bank status is left computed normally.
    const offChannel = isOffChannelDept(person.department);
    const isContractor = aliases.some((e) => contractorEmails.has(e));

    const rate = resolvePeopleRate(rateCtx, aliases, person.department);
    const rateStatus: 'ok' | 'missing' =
      offChannel || isContractor || rate.source !== null ? 'ok' : 'missing';

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
    // LIVE-resolved only — deliberately never merged with the snapshot's
    // processor. See the `bankProcessor` field doc: this value LOCKS the Set Bank
    // picker, and a locked picker skips writing `preferred_processor`.
    const bankProcessor = resolveEffectivePayoutProcessor(idRow, extras);
    let bankStatus: 'ok' | 'missing' | 'missing_has_snapshot' = payable ? 'ok' : 'missing';
    let bankPrefill: OffboardedBankPrefill | null = null;

    if (!payable && person.work_email) {
      const snapshot = readSnapshot(person.work_email);
      const snapshotIdRow = snapshot ? pickSnapshotIdRow(snapshot.employee_ids ?? []) : null;
      const snapshotProcessor = snapshotIdRow ? resolveEffectivePayoutProcessor(snapshotIdRow) : null;
      if (snapshotIdRow && snapshotProcessor) {
        bankStatus = 'missing_has_snapshot';
        const draft = payoutDraftFromIdsRow(snapshotIdRow).payout;
        bankPrefill = {
          processor: snapshotProcessor,
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

    // Off-channel departments never run through this system's bank machinery
    // either (mirrors the readiness missing-bank check's own `isOffChannelDept`
    // skip). Applied after the snapshot pass so a prefill is still available if a
    // clerk opens Set Bank on them anyway — only the pill is corrected.
    if (offChannel) bankStatus = 'ok';

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

  if (snapshotReadDegraded) {
    degraded.push(
      'At least one offboard bank snapshot couldn’t be read back — those people show as having no prior bank details on file.',
    );
  }

  people.sort(
    (a, b) =>
      (b.offBoardedAt ?? '9999-99-99').localeCompare(a.offBoardedAt ?? '9999-99-99') ||
      a.name.localeCompare(b.name),
  );

  return { people, weekLabel: weekRangeLabel(weekStart), degraded, error: null };
}
