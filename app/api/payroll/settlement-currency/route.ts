import { NextResponse } from 'next/server';
import { getServerSession } from 'next-auth/next';
import { authOptions } from '@/lib/auth/auth-options';
import { normEmail } from '@/lib/email/norm-email';
import { createSupabaseServiceRoleClient } from '@/lib/supabase/server';
import { selectAllPaged } from '@/lib/supabase/select-all-paged';
import { getAppSettings } from '@/lib/supabase/app-settings';
import { getEmployeeHourlyRatesRows } from '@/lib/supabase/employee-hourly-rates';
import {
  USD_TO_COP_SETTINGS_KEY,
  USD_TO_PHP_SETTINGS_KEY,
} from '@/lib/fx/currency-fx';
import {
  buildSettlementCurrencyByEmail,
  resolveSettlementRate,
  type EmailPair,
  type OnboardingCountryRow,
  type SettlementRate,
} from '@/lib/payroll/settlement-currency';
import type { PayCurrency } from '@/lib/payment-catalog/pay-structure';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

type SessionLike = { user?: { email?: string | null; roles?: string[] } | null } | null;

/** Roles that read a pay surface showing settlement figures: department
 *  managers AND QC officers (both drive `DeptBonusCalculator` — the QC first-pass
 *  view is the same table), Accounting (Payroll Wizard, Payment Dispatch), and
 *  admin. The payload carries no amounts — only country-derived currency markers
 *  and the org's two FX rates — but it does reveal which staff are
 *  foreign-settled, so it stays behind a role.
 *
 *  `qc` was missing on the first cut, and the symptom is silent: a QC officer got
 *  a 403, the marker never arrived, and every Colombian's row rendered in pesos
 *  with no sticker — indistinguishable from "this person is Filipino". */
const ALLOWED_ROLES = ['manager', 'qc', 'accounting', 'admin'] as const;

/** Cap on how many emails one call may ask about — the largest caller is the
 *  Payroll Wizard's whole-cycle roster (~1,300). Bounded so a malformed client
 *  cannot turn this into an unbounded scan. */
const MAX_EMAILS = 5000;

/** Serialized {@link SettlementRate} — `usdToPhp`/`usdToCop` are present ONLY
 *  on `live`, so a client literally cannot read a rate off a `unset`/`fallback`
 *  response and convert with it. */
type RatePayload =
  | { status: 'live'; usdToPhp: number; usdToCop: number }
  | { status: 'unset' }
  | { status: 'fallback' };

function ratePayload(rate: SettlementRate): RatePayload {
  return rate.status === 'live'
    ? { status: 'live', usdToPhp: rate.fx.usdToPhp, usdToCop: rate.fx.usdToCop }
    : { status: rate.status };
}

/**
 * In-process memo for the org-wide marker map ONLY.
 *
 * Building it costs three full-table reads (~6,500 rows: master list, onboarding
 * submissions, rate rows) and the answer is near-static — it changes when
 * someone is onboarded or their paperwork is corrected, not weekly. Without
 * this, every Manager tab switch pays for all three, because the Manager shell
 * unmounts its content pane on every switch (`AnimatePresence mode="wait"`), so
 * the calculator refetches on each visit.
 *
 * The FX RATE is deliberately NOT memoized — it is read fresh on every request.
 * It is the money-sensitive half (Accounting sets it mid-cycle and a stale
 * `unset`→`live` transition would keep showing pesos, or worse a stale rate
 * would price a figure), and it costs one `app_settings` lookup.
 */
const MARKER_TTL_MS = 5 * 60 * 1000;
let markerCache: { at: number; byEmail: Map<string, PayCurrency> } | null = null;

/**
 * POST — settlement currency per payee, plus whether the FX rates may be used
 * to state a native figure at all.
 *
 * The currency a person is PAID IN, resolved from the country they selected on
 * their own onboarding paperwork. Colombians ride the ordinary PHP rails, so
 * nothing in the pay engine knows they settle in COP; this is the marker that
 * lets the Manager KPI Calculator, the Payroll Wizard and Payment Dispatch show
 * every one of them the figure that actually reaches their bank.
 *
 * `rate` is resolved HERE, from the RAW `app_settings` values, and it is the
 * only thing that licenses a native figure. Two silent-fabrication modes make
 * that non-negotiable: the per-cycle rate starts at 0 on every new Hubstaff
 * upload (a COP figure would render as `COP 0`), and the official fallbacks
 * (COP 4,000/$1 and PHP 1/$1) are indistinguishable from real rates. Callers
 * get `unset`/`fallback` with NO numbers attached and must show pesos instead.
 *
 * Body: `{ emails: string[] }` — every alias the caller knows for the people it
 * is rendering. Submissions are filed under personal emails while pay keys on
 * work emails, so the resolver bridges both ways server-side; the caller only
 * needs to send what it has.
 *
 * Response: `{ byEmail, rate, error }`. `byEmail` includes only the emails that
 * were asked for and resolved to a currency — an absent key means "no
 * paperwork, or a country that maps to nothing", which every surface renders as
 * plain pesos.
 */
export async function POST(request: Request) {
  const session = (await getServerSession(authOptions)) as SessionLike;
  const sessionEmail = normEmail(session?.user?.email ?? '') ?? '';
  if (!sessionEmail) {
    return NextResponse.json({ byEmail: {}, rate: { status: 'unset' }, error: 'Not signed in' }, { status: 401 });
  }
  const roles = (session?.user?.roles ?? []) as string[];
  if (!ALLOWED_ROLES.some((r) => roles.includes(r))) {
    return NextResponse.json(
      { byEmail: {}, rate: { status: 'unset' }, error: 'Manager, accounting or admin role required' },
      { status: 403 },
    );
  }

  let requested: string[];
  try {
    const body = (await request.json()) as { emails?: unknown };
    if (!Array.isArray(body.emails)) {
      return NextResponse.json(
        { byEmail: {}, rate: { status: 'unset' }, error: 'Body must be { emails: string[] }' },
        { status: 400 },
      );
    }
    requested = [
      ...new Set(
        body.emails
          .map((e) => normEmail(typeof e === 'string' ? e : null))
          .filter((e): e is string => !!e),
      ),
    ];
  } catch {
    return NextResponse.json(
      { byEmail: {}, rate: { status: 'unset' }, error: 'Malformed JSON body' },
      { status: 400 },
    );
  }
  if (requested.length > MAX_EMAILS) {
    return NextResponse.json(
      { byEmail: {}, rate: { status: 'unset' }, error: `At most ${MAX_EMAILS} emails per call` },
      { status: 400 },
    );
  }

  const supabase = createSupabaseServiceRoleClient();
  if (!supabase) {
    return NextResponse.json(
      { byEmail: {}, rate: { status: 'unset' }, error: 'Supabase not configured' },
      { status: 503 },
    );
  }

  // The FX rates come from the RAW stored strings — never through
  // effectiveUsdTo*RateFromStored, which is exactly what replaces a 0 with a
  // plausible default and would erase the "not confirmed yet" state.
  let rate: SettlementRate;
  try {
    const settings = await getAppSettings([USD_TO_PHP_SETTINGS_KEY, USD_TO_COP_SETTINGS_KEY]);
    rate = resolveSettlementRate(
      settings[USD_TO_PHP_SETTINGS_KEY],
      settings[USD_TO_COP_SETTINGS_KEY],
    );
  } catch {
    // An unreadable rate is "no licence to convert", never a default rate.
    rate = { status: 'unset' };
  }

  if (requested.length === 0) {
    return NextResponse.json({ byEmail: {}, rate: ratePayload(rate), error: null });
  }

  const cached =
    markerCache && Date.now() - markerCache.at < MARKER_TTL_MS ? markerCache.byEmail : null;
  if (cached) {
    const hit: Record<string, PayCurrency> = {};
    for (const e of requested) {
      const cur = cached.get(e);
      if (cur) hit[e] = cur;
    }
    return NextResponse.json({ byEmail: hit, rate: ratePayload(rate), error: null });
  }

  // ── Identity: every alias of every human, so a marker filed under a personal
  // email reaches the work email a pay surface renders. Both reads are PAGED —
  // PostgREST caps at 1000 rows even with an explicit .range(), and the roster
  // passed 1,000 people in Jul 2026, so an un-paged read would silently drop
  // the tail of the alphabet and quietly un-mark those Colombians.
  const { rows: masterRows, error: masterErr } = await selectAllPaged<{
    'Work Email': string | null;
    'Personal Email': string | null;
    'Alternate Work Email': string | null;
    'Alternate Work Email 2': string | null;
  }>((from, to) =>
    supabase
      .from('global_master_list')
      .select('"Work Email", "Personal Email", "Alternate Work Email", "Alternate Work Email 2"')
      .order('Work Email', { ascending: true })
      .range(from, to),
  );

  const { rows: onboardingRows, error: onboardErr } = await selectAllPaged<OnboardingCountryRow>(
    (from, to) =>
      supabase
        .from('hr_onboarding_submissions')
        .select('email, invite_personal_email, country')
        .order('email', { ascending: true })
        .range(from, to),
  );

  // The rates read goes through `getEmployeeHourlyRatesRows` rather than a
  // hand-rolled select. That table is CSV-seeded, so its columns are quoted and
  // capitalised ("Work Email", "Personal Email"); a snake_case projection fails
  // outright with `column employee_hourly_rates.work_email does not exist`, and
  // the table name itself comes from an env var. The helper already handles the
  // naming variants, the deduplicated view, and the 1000-row paging.
  const ratesResult = await getEmployeeHourlyRatesRows();
  const ratePairs: EmailPair[] = ratesResult.rows.map((r) => ({
    work_email: r.work_email ?? null,
    personal_email: r.personal_email ?? null,
  }));
  const ratesErr = ratesResult.error;

  // A partial identity read would UNDER-mark people (a Colombian silently shown
  // pesos), so a read failure is reported rather than served as "nobody is
  // foreign-settled". Surfaces then keep showing pesos AND say the marker is
  // unavailable, which is honest; a bare empty map would not be.
  const readError = masterErr ?? onboardErr ?? ratesErr;
  if (readError) {
    return NextResponse.json(
      { byEmail: {}, rate: ratePayload(rate), error: `Identity read failed: ${readError}` },
      { status: 502 },
    );
  }

  const aliasesByEmail = new Map<string, string[]>();
  for (const m of masterRows) {
    const group = [
      normEmail(m['Work Email']),
      normEmail(m['Personal Email']),
      normEmail(m['Alternate Work Email']),
      normEmail(m['Alternate Work Email 2']),
    ].filter((e): e is string => !!e);
    for (const e of group) {
      const existing = aliasesByEmail.get(e);
      if (existing) {
        for (const x of group) if (!existing.includes(x)) existing.push(x);
      } else {
        aliasesByEmail.set(e, [...group]);
      }
    }
  }

  const byEmailMap = buildSettlementCurrencyByEmail(onboardingRows, aliasesByEmail, ratePairs);
  // Only a COMPLETE build is cached — the read-error branch above returns before
  // here, so a partial map can never be memoized and served as the truth.
  markerCache = { at: Date.now(), byEmail: byEmailMap };

  // Return only what was asked about — the full map is org-wide.
  const byEmail: Record<string, PayCurrency> = {};
  for (const e of requested) {
    const cur = byEmailMap.get(e);
    if (cur) byEmail[e] = cur;
  }

  return NextResponse.json({ byEmail, rate: ratePayload(rate), error: null });
}
