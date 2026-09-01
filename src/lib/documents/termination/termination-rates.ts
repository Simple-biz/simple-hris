import 'server-only';

/** [TERMINATION-DOCS]
 * The two rates a termination letter states: what the person was hired at, and
 * what they were last actually paid at.
 *
 * A ZERO IS NOT A RATE. Every carrier below is a TEXT column or a JSON blob, so
 * a missing figure arrives as `0` as readily as it arrives as null;
 * `computePersonComp` treats a stored 0 as present, which is right for a pay
 * engine and wrong for a signed page. Here `amount <= 0` is a BLANK with
 * `blankReason: 'zero_rate'` and the rep types the real number — the same rule
 * the COE keeps in its document layer (coe-facts.ts:322-335), restated in the
 * DDL as `check (starting_rate is null or starting_rate > 0)`.
 *
 * CURRENCY IS RESOLVED, NOT ASSUMED. Every construction site here used to
 * hardcode `'PHP'`, which made `TerminationRate.currency` decorative: it could
 * never be USD or COP, the route could only echo PHP, and a USD payee's hourly
 * rate printed as pesos on a legal document.
 *
 * Two facts settle a figure's denomination, and NEITHER is a guess:
 *
 *   1. THE PAYEE'S OWN CURRENCY, from the Payment Catalog — the one rate store
 *      in this system that carries a currency at all
 *      (`payment_catalog_pay_structures.currency`). Employee-scope structure
 *      first, then the department-scope base, exactly the precedence
 *      `computePersonComp`/`winningRate` apply for the COE (person-comp.ts:212).
 *      With neither, the person is priced by the rates sheet, which is PHP BY
 *      CONSTRUCTION (person-comp.ts:224) — so a SUCCESSFUL catalog read that
 *      finds no structure resolves PHP as evidence, not as a default. A FAILED
 *      catalog read resolves NOTHING, and a carrier's figure then becomes a
 *      BLANK (`currency_unresolved`) for the rep to state.
 *
 *   2. WHAT THE CARRIER COLUMN HOLDS. `hr_pending_employees.regular_rate` and
 *      `employee_rate_history.regular_rate` are bare numbers with no currency
 *      column, so they are denominated in the payee's own currency (1).
 *      `payload.rates_php` and `disbursement_records.regular_rate_php` are
 *      PHP-EQUIVALENTS by construction (PayrollWizard.tsx:865) — COP/USD payees
 *      ride the PHP rails (memory `cop-country-payees-dispatch`), so for them
 *      that figure is an FX conversion of a payroll week, not their rate. It is
 *      therefore a BLANK (`non_php_payee`) carrying their real currency, never a
 *      peso figure printed as if it were the rate they were engaged at.
 *
 * Both rates are also matched on WORK addresses only (G1), the catalog read
 * included: `payment_catalog_pay_structures.employee_email` can hold a personal
 * inbox, and one inbox backs two identities.
 *
 * KNOWN, DELIBERATE GAP: a non-PHP payee whose ONLY catalog structure is keyed
 * on their personal address is not seen here, and resolves to the PHP rails
 * default. Closing it needs a personal address in this module, and
 * `TerminationRatesArgs` deliberately refuses to carry one (see `workAliases`) —
 * that is the cross-wire that printed one identity's hire rate on another's
 * letter. If it is ever closed, the personal match may only DENY ("pesos are not
 * proven here" ⇒ a BLANK), never denominate: a shared inbox can say a figure is
 * doubtful, and can never say what it is worth.
 *
 * `employee_hourly_rates.updated_at` is NOT consulted to date anything:
 * `updateEmployeeRates` rewrites "Regular Rate" in place with no stamp
 * (employee-hourly-rates.ts:389-392) and only 21 of 22,347 rows have
 * `updated_at != created_at`. An absent history row is likewise NOT evidence of
 * a flat rate — the sheet sync wrote no history for years.
 */

import { createSupabaseServiceRoleClient } from '@/lib/supabase/server';
import { selectAllPaged } from '@/lib/supabase/select-all-paged';
import { normEmail } from '@/lib/email/norm-email';
import { normalizeMasterDate } from '@/lib/roster/master-date';
import { parseRateText, resolveRosterDeptKey } from '@/lib/payment-catalog/person-comp';
import { listPayStructures } from '@/lib/supabase/pay-structures-db';
import { getDepartmentRegistry } from '@/lib/departments/registry-db';
import { listPaymentDispatches } from '@/lib/supabase/payment-dispatches';
import { getFreshPaystubEntry } from '@/lib/payroll/paystub-fresh';
import { mapPayloadToPayStub } from '@/lib/payroll/paystub-view';
import {
  buildRateHistoryByEmail,
  parseEffectiveDate,
  resolveRateAsOfDate,
} from '@/lib/payroll/rate-history-resolve';
import {
  isTerminationCurrency,
  type TerminationCurrency,
  type TerminationRate,
  type TerminationRateSource,
} from './types';
import { escapeLikePattern } from './reason-key';

type Row = Record<string, unknown>;

/** Verbatim projection — `employee_rate_history` is snake_case, and the column
 *  is `employee_email`. `scripts/find-email-everywhere.mjs:51` names
 *  `work_email`/`email`; both are WRONG and that script swallows the 42703. */
const HISTORY_SELECT = 'employee_email, regular_rate, ot_rate, effective_from, note, created_by';

/** The literal behind the private `SYNC_HISTORY_AUTHOR` const
 *  (src/lib/supabase/rates-upload-db.ts:14). A sync-authored history row records
 *  a sheet snapshot, not a decision anyone made about this person's hire rate. */
const SYNC_HISTORY_AUTHOR = 'GSheets Sync';

/** `effective_from = 1970-01-01` is the seeded baseline backfill, not a real
 *  rate change — it is the LAST starting-rate carrier, never the first. */
const BASELINE_PREFIX = '1970';

export interface TerminationRatesArgs {
  /** THE identity (G1). Already normalized. */
  workEmail: string;
  /**
   * WORK addresses only — the work email plus the master row's
   * `"Alternate Work Email"` / `"Alternate Work Email 2"`, built by
   * `workAliasesForRateContext` (termination-arbitration.ts).
   *
   * There is NO field on this type that can carry a personal address, and that
   * is deliberate: this module used to receive an `aliases` array containing the
   * master row's personal email and query the hire record on it, so
   * `carlath@simple.biz`'s letter could print the ACTIVE `carla@simple.biz`'s
   * hire rate as the STARTING RATE — one inbox
   * (`carlathomas0112@gmail.com`) backs both identities. An alternate work
   * address is one human; a personal inbox is not.
   */
  workAliases: string[];
  /** Raw master `Department` cell. No rate AMOUNT below is department-scoped;
   *  it is read only to find a department-scope Payment Catalog structure, whose
   *  currency says whether this person's money is provably pesos. */
  departmentRaw: string | null;
  /** Sanitized `YYYY-MM-DD` departure day, or null when it is a BLANK. */
  offDate: string | null;
}

/**
 * What the Payment Catalog says this person's money is denominated in.
 *
 * `confirmed` is the difference between "this person is priced in X" and "this
 * person's DEPARTMENT is priced in X". Only the first can denominate a bare
 * number sitting in `employee_rate_history` or `hr_pending_employees`: a leaver
 * has no rates-sheet row left to prove they were on the PHP middle layer, so a
 * non-PHP DEPARTMENT base is enough to say "not provably pesos" and never enough
 * to restate their stored figure in that department's currency.
 */
interface PayeeCurrency {
  /** null only when the catalog read FAILED — nothing could state a currency. */
  currency: TerminationCurrency | null;
  /** True when `currency` denominates THIS PERSON's own stored figures. */
  confirmed: boolean;
  /** Which evidence answered. Recorded for review and for the failure the tests
   *  pin; what the REP sees is the rate's `blankReason`. */
  source: 'catalog_employee' | 'catalog_department' | 'payroll_rails' | 'unresolved';
}

const CURRENCY_UNRESOLVED: PayeeCurrency = {
  currency: null,
  confirmed: false,
  source: 'unresolved',
};

/**
 * Resolve the payee's currency the way the COE does — `payment_catalog_pay_structures`,
 * employee scope before department scope (person-comp.ts:212 `winningRate`) —
 * and treat a successful read that finds nothing as PHP, because the only other
 * rate layer in the system is the rates sheet and that is PHP by construction
 * (person-comp.ts:224). A FAILED read states nothing at all.
 *
 * Employee-scope structures are matched on WORK addresses only:
 * `PayStructure.employeeEmail` is documented as "work/personal", and a structure
 * keyed on a shared personal inbox belongs to whichever identity created it.
 */
async function resolvePayeeCurrency(
  workAliases: string[],
  departmentRaw: string | null,
  degraded: string[],
): Promise<PayeeCurrency> {
  const catalog = await listPayStructures();
  if (catalog.error) {
    degraded.push(
      `payment_catalog_pay_structures: ${catalog.error} — no rate could be denominated, so both rates are BLANK for the rep to state with a currency`,
    );
    return CURRENCY_UNRESOLVED;
  }

  // Later-one-wins on duplicate keys, the index shape the Payment Catalog and
  // the COE both build (coe-facts.ts:297-306).
  const byEmail = new Map<string, TerminationCurrency>();
  const byDeptKey = new Map<string, TerminationCurrency>();
  for (const s of catalog.structures) {
    // A currency outside the union can never denominate a printed figure.
    const currency = isTerminationCurrency(s.currency) ? s.currency : null;
    if (!currency) continue;
    if (s.scope === 'employee') {
      const email = normEmail(s.employeeEmail);
      if (email) byEmail.set(email, currency);
    } else {
      byDeptKey.set(s.departmentKey, currency);
    }
  }

  for (const alias of workAliases) {
    const own = byEmail.get(alias);
    if (own) return { currency: own, confirmed: true, source: 'catalog_employee' };
  }

  const rawDept = (departmentRaw ?? '').trim();
  // The registry read is skipped when the catalog holds no department-scope
  // structure at all: there would be nothing for a resolved key to match, and an
  // app_settings round trip per generation buys nothing.
  if (rawDept && byDeptKey.size > 0) {
    // Custom departments live in the app_settings registry, so the raw label
    // resolves to a key the same way the Payment Catalog resolves it. A failed
    // registry read is NOT fatal: it can only cost a custom department its
    // dept-scope match, which falls through to the rails default below.
    let customDepartments: { key: string; name: string }[] = [];
    try {
      customDepartments = (await getDepartmentRegistry()).map((d) => ({ key: d.key, name: d.name }));
    } catch (e) {
      degraded.push(
        `department registry: ${e instanceof Error ? e.message : 'read failed'} — a custom department's catalog currency could not be checked`,
      );
    }
    const deptKey = resolveRosterDeptKey(rawDept, customDepartments);
    const base = deptKey ? byDeptKey.get(deptKey) : undefined;
    if (base) {
      // PHP agrees with the sheet layer, so nothing about this person is
      // non-PHP and the figure can be stated. A non-PHP department base only
      // establishes that pesos are NOT proven.
      return { currency: base, confirmed: base === 'PHP', source: 'catalog_department' };
    }
  }

  return { currency: 'PHP', confirmed: true, source: 'payroll_rails' };
}

/** A BLANK rate, in the payee's currency when one was resolved. `amount === null`
 *  is the signal the panel renders an input for; a null currency additionally
 *  makes it render a currency picker. */
function blankRate(
  blankReason: TerminationRate['blankReason'],
  payee: PayeeCurrency,
): TerminationRate {
  return { amount: null, currency: payee.currency, source: null, blankReason };
}

/**
 * Turn a BARE-NUMBER carrier's parsed figure into a rate.
 * `hr_pending_employees.regular_rate` and `employee_rate_history.regular_rate`
 * carry no currency column, so the figure is denominated in the payee's own
 * currency and can be printed only when the catalog CONFIRMED one for them.
 *
 * Returns null when the carrier held NOTHING (the caller falls through to the
 * next carrier). Every other outcome is a hit, and a hit STOPS the chain rather
 * than letting an older, unrelated rate stand in for it — including the two
 * currency blanks, because "we found a figure we cannot denominate" must not
 * silently become an older figure from a different carrier.
 */
function bareRate(
  amount: number | null,
  payee: PayeeCurrency,
  source: TerminationRateSource,
): TerminationRate | null {
  if (amount == null || !Number.isFinite(amount)) return null;
  if (amount <= 0) return { amount: null, currency: payee.currency, source, blankReason: 'zero_rate' };
  if (!payee.currency) {
    return { amount: null, currency: null, source, blankReason: 'currency_unresolved' };
  }
  if (!payee.confirmed) {
    return { amount: null, currency: payee.currency, source, blankReason: 'non_php_payee' };
  }
  return { amount, currency: payee.currency, source, blankReason: null };
}

/**
 * Turn a PHP-EQUIVALENT carrier's figure into a rate. `payload.rates_php` and
 * `disbursement_records.regular_rate_php` are pesos by construction
 * (PayrollWizard.tsx:865 — "PHP-equivalents, for comparing against the stub's
 * rates_php"), and COP/USD staff ride the same PHP rails, so for them the number
 * is an FX conversion of one payroll week rather than the rate they were engaged
 * at. That is a BLANK in their own currency, never a peso figure on the letter.
 */
function phpRailRate(
  amount: number | null,
  payee: PayeeCurrency,
  source: TerminationRateSource,
): TerminationRate | null {
  if (amount == null || !Number.isFinite(amount)) return null;
  if (amount <= 0) return { amount: null, currency: payee.currency, source, blankReason: 'zero_rate' };
  if (!payee.currency) {
    return { amount: null, currency: null, source, blankReason: 'currency_unresolved' };
  }
  if (payee.currency !== 'PHP') {
    return { amount: null, currency: payee.currency, source, blankReason: 'non_php_payee' };
  }
  // Narrowed to 'PHP' by the check above, and READ from the resolution rather
  // than restated as a literal: no construction site in this module names a
  // currency of its own, which is what made the field decorative before.
  return { amount, currency: payee.currency, source, blankReason: null };
}

export async function resolveTerminationRates(args: TerminationRatesArgs): Promise<{
  starting: TerminationRate;
  ending: TerminationRate;
  degraded: string[];
}> {
  const degraded: string[] = [];
  const supabase = createSupabaseServiceRoleClient();
  if (!supabase) {
    return {
      starting: blankRate('read_degraded', CURRENCY_UNRESOLVED),
      ending: blankRate('read_degraded', CURRENCY_UNRESOLVED),
      degraded: ['Supabase not configured — neither rate could be resolved'],
    };
  }

  const workEmail = normEmail(args.workEmail);
  if (!workEmail) {
    return {
      starting: blankRate('not_on_file', CURRENCY_UNRESOLVED),
      ending: blankRate('not_on_file', CURRENCY_UNRESOLVED),
      degraded: [],
    };
  }
  // Work email FIRST, always. Every member of this set is a WORK address by
  // construction (see `workAliases`): a rate keyed on a shared personal inbox
  // can belong to the other identity behind it — the carla@ / carlath@
  // cross-wire — and no code path here can reach one.
  const aliases = [workEmail, ...args.workAliases.map((a) => normEmail(a) ?? '')].filter(
    (a, i, all) => a && all.indexOf(a) === i,
  );

  // ── One rate-history read, shared by both rates ────────────────────────────
  // `.in()` is an exact-match list, not a pattern — no `.or()`, no ILIKE
  // wildcard hazard. Exact case can miss a mixed-case row, which produces a
  // BLANK the rep fills; it can never produce a wrong number.
  const history = await selectAllPaged<Row>((from, to) =>
    supabase
      .from('employee_rate_history')
      .select(HISTORY_SELECT)
      .in('employee_email', aliases)
      .order('effective_from', { ascending: true })
      .order('employee_email', { ascending: true })
      .range(from, to),
  );
  if (history.error) degraded.push(`employee_rate_history: ${history.error}`);

  // ONE currency resolution, shared by both rates: they describe the same
  // engagement, so they can never be denominated by two different answers.
  const payee = await resolvePayeeCurrency(aliases, args.departmentRaw, degraded);

  const starting = await resolveStartingRate(supabase, aliases, history, payee, degraded);
  const ending = await resolveEndingRate(
    supabase,
    workEmail,
    args.offDate,
    history,
    payee,
    degraded,
  );
  return { starting, ending, degraded };
}

// ─── Starting rate ───────────────────────────────────────────────────────────

async function resolveStartingRate(
  supabase: NonNullable<ReturnType<typeof createSupabaseServiceRoleClient>>,
  aliases: string[],
  history: { rows: Row[]; error: string | null },
  payee: PayeeCurrency,
  degraded: string[],
): Promise<TerminationRate> {
  // 1. The hire record. `hr_pending_employees` rows SURVIVE promotion —
  //    setHrPromotionOutcome only UPDATEs status (hr-pending-employees.ts:1147) —
  //    so this is the truest statement of what the person was hired at.
  //    NEVER call listHrPendingEmployees(): it is `.range(0, 1999)` with no
  //    paging (:265).
  //
  //    MATCHED ON WORK ADDRESSES ONLY — one pass per alias, the identity's own
  //    address first, each pass short-circuiting. The hire record is also keyed
  //    by personal inbox, and a pass on that column is what let a shared gmail
  //    hand this person the OTHER identity's hire rate; a printed money fact may
  //    never be derived from a personal address (G1). A pre-pipeline hire whose
  //    staged row exists only under a personal inbox therefore resolves to a
  //    BLANK, which the rep fills — the honest outcome, and the one this module
  //    already gives every 2023 leaver.
  const hrPasses: Array<{ what: string; value: string }> = aliases.map((alias) => ({
    what: `hr_pending_employees.work_email (${alias})`,
    value: alias,
  }));
  for (const pass of hrPasses) {
    const res = await selectAllPaged<Row>((from, to) =>
      supabase
        .from('hr_pending_employees')
        .select('work_email, regular_rate, created_at')
        .ilike('work_email', escapeLikePattern(pass.value))
        .order('created_at', { ascending: true })
        .range(from, to),
    );
    if (res.error) degraded.push(`${pass.what}: ${res.error}`);
    for (const row of res.rows) {
      // `regular_rate` is a TEXT column ("1,234.50"), so parseRateText — not
      // Number(), which is NaN on a thousands separator.
      const hit = bareRate(
        parseRateText(row['regular_rate'] as string | null),
        payee,
        'hr_pending',
      );
      if (hit) return hit;
    }
  }

  // 2. The earliest DECISION in the rate history. Sync-authored and
  //    `system`-authored rows are snapshots, not decisions, and the 1970 row is
  //    the seeded baseline — all three are excluded here.
  const historyRows = preferWorkEmailRows(history.rows, aliases[0]);
  const decisions = historyRows.filter((r) => {
    const eff = String(r['effective_from'] ?? '');
    const by = String(r['created_by'] ?? '');
    return !eff.startsWith(BASELINE_PREFIX) && by !== SYNC_HISTORY_AUTHOR && by !== 'system';
  });
  const earliest = earliestByEffectiveFrom(decisions);
  if (earliest) {
    const hit = bareRate(
      parseRateText(earliest['regular_rate'] as string | null),
      payee,
      'rate_history',
    );
    if (hit) return hit;
  }

  // 3. The seeded 1970 baseline, if one exists. It is a backfill of "the rate as
  //    of the day the history table was created", which for a long-tenured
  //    leaver is the closest thing to a hire rate that survives.
  const baseline = earliestByEffectiveFrom(
    historyRows.filter((r) => String(r['effective_from'] ?? '').startsWith(BASELINE_PREFIX)),
  );
  if (baseline) {
    const hit = bareRate(
      parseRateText(baseline['regular_rate'] as string | null),
      payee,
      'rate_history_baseline',
    );
    if (hit) return hit;
  }

  if (history.error) return blankRate('read_degraded', payee);
  // Pre-digital-pipeline hires have no `hr_pending_employees` row at all. That is
  // the NORMAL state of a 2023 leaver, not an error — the rep fills it.
  return blankRate('no_hire_record', payee);
}

// ─── Ending rate ─────────────────────────────────────────────────────────────

async function resolveEndingRate(
  supabase: NonNullable<ReturnType<typeof createSupabaseServiceRoleClient>>,
  workEmail: string,
  offDate: string | null,
  history: { rows: Row[]; error: string | null },
  payee: PayeeCurrency,
  degraded: string[],
): Promise<TerminationRate> {
  // 1. The last week money actually moved. Contractor-invoice settlements are
  //    excluded: they carry the live cycle's source_file and the person's email,
  //    so a settled invoice would speak for a salary week that was never paid —
  //    the exact filter at app/api/employee/paystub/route.ts:911-913.
  const dispatches = await listPaymentDispatches({ recipientEmail: workEmail });
  if (dispatches.error) {
    degraded.push(`payment_dispatches: ${dispatches.error}`);
    return blankRate('read_degraded', payee);
  }
  const paid = dispatches.rows.filter(
    (r) => r.status === 'paid' && r.cycle_source_file && r.payee_type !== 'contractor',
  );
  if (paid.length === 0) return blankRate('never_paid', payee);

  // `sent_date` is compared as a CALENDAR DAY, not as a raw string: a
  // sheet-shaped `M/D/YYYY` value sorts lexicographically by month, which would
  // pick the wrong week and print the wrong week's rate.
  const sentDay = (r: { sent_date: string | null }): string =>
    normalizeMasterDate(r.sent_date) ?? String(r.sent_date ?? '');
  let latest = paid[0];
  for (const r of paid) {
    if (sentDay(r) > sentDay(latest)) latest = r;
  }
  const sourceFile = latest.cycle_source_file as string;

  // 2. That week's paystub payload — the figure the person was actually shown.
  //    `refreshed` means a newer wizard snapshot supplied it; otherwise the
  //    locked stage did.
  try {
    const fresh = await getFreshPaystubEntry(sourceFile, workEmail);
    if (fresh.error) degraded.push(`paystub_dispatch_queue (${sourceFile}): ${fresh.error}`);
    if (fresh.staleRateSnapshot) {
      degraded.push(
        `The wizard snapshot for ${sourceFile} was REJECTED as stale (its rate contradicts the ` +
          `Payment Catalog); the locked staged figure was used instead.`,
      );
    }
    // `mapPayloadToPayStub` coerces a MISSING rate to 0 (`num()`), which would
    // read here as "the carrier held zero" and stop the chain on a payload that
    // simply has no rate block. So presence is decided on the RAW
    // `rates_php.regular` value and only the amount comes from the view.
    if (fresh.payload) {
      const ratesPhp = fresh.payload['rates_php'];
      const rawRegular =
        ratesPhp && typeof ratesPhp === 'object'
          ? (ratesPhp as Record<string, unknown>)['regular']
          : undefined;
      if (rawRegular != null && String(rawRegular).trim() !== '') {
        const view = mapPayloadToPayStub(fresh.payload, fresh.payPeriod);
        const hit = phpRailRate(
          view.mfRate,
          payee,
          fresh.refreshed ? 'wizard_snapshot' : 'paystub_locked',
        );
        if (hit) return hit;
      }
    }
  } catch (e) {
    degraded.push(
      `paystub_dispatch_queue (${sourceFile}): ${e instanceof Error ? e.message : 'read failed'}`,
    );
  }

  // 3. The disbursement record for the same week. Scoped to (source_file,
  //    recipient_email) rather than loading the whole cycle — a cycle can pay
  //    1,000+ people, and loadDisbursementRecordsForCycle THROWS on error.
  const disb = await selectAllPaged<Row>((from, to) =>
    supabase
      .from('disbursement_records')
      .select('recipient_email, source_file, regular_rate_php')
      .eq('source_file', sourceFile)
      .eq('recipient_email', workEmail)
      .order('recipient_email', { ascending: true })
      .range(from, to),
  );
  if (disb.error) degraded.push(`disbursement_records (${sourceFile}): ${disb.error}`);
  for (const row of disb.rows) {
    const hit = phpRailRate(
      parseRateText(row['regular_rate_php'] == null ? null : String(row['regular_rate_php'])),
      payee,
      'disbursement_record',
    );
    if (hit) return hit;
  }

  // 4. The dated history, resolved as of the departure day. ALL rows count here
  //    — including sync- and system-authored ones and the 1970 baseline — because
  //    this is the same resolution both pay engines apply per-day
  //    (rate-history-resolve.ts:39).
  const asOf = offDate ? parseEffectiveDate(offDate) : null;
  if (asOf) {
    const byEmail = buildRateHistoryByEmail(
      history.rows as Array<{
        employee_email?: unknown;
        regular_rate?: unknown;
        ot_rate?: unknown;
        effective_from?: unknown;
      }>,
    );
    const resolved = resolveRateAsOfDate(byEmail.get(workEmail), asOf);
    const hit = bareRate(resolved?.regularRate ?? null, payee, 'rate_history_as_of');
    if (hit) return hit;
  }

  if (history.error || disb.error) return blankRate('read_degraded', payee);
  return blankRate('not_on_file', payee);
}

// ─── Row helpers ─────────────────────────────────────────────────────────────

/**
 * Rows keyed on the WORK email when there are any, every alias row otherwise.
 *
 * The fallback is safe only because the alias set is now WORK-ONLY by
 * construction (`workAliases`): an alternate work address is the same human. It
 * used to include the master row's personal address, and then this fallback
 * printed a rate-history row belonging to the OTHER identity behind a shared
 * inbox whenever the work email owned no history row of its own. Do not widen
 * the alias set back.
 */
function preferWorkEmailRows(rows: Row[], workEmail: string): Row[] {
  const own = rows.filter((r) => normEmail(String(r['employee_email'] ?? '')) === workEmail);
  return own.length ? own : rows;
}

/** Earliest `effective_from`, parsed BY PARTS. `new Date('YYYY-MM-DD')` is UTC
 *  midnight and reads as the previous day in Manila; `new Date('5/4/2026')` is
 *  locale-dependent on Node and can flip to April 5. */
function earliestByEffectiveFrom(rows: Row[]): Row | null {
  let best: { row: Row; at: number } | null = null;
  for (const row of rows) {
    const d = parseEffectiveDate(row['effective_from']);
    if (!d) continue;
    const at = d.getTime();
    if (!best || at < best.at) best = { row, at };
  }
  return best?.row ?? null;
}
