/**
 * Source guards for the settlement-currency surfaces.
 *
 * Settlement currency is a DISPLAY axis reconstructed from a peso figure. The
 * two ways to get that wrong are both silent and both expensive, so they are
 * pinned here against the real source rather than trusted to review:
 *
 *  1. handing a settlement currency to `computeAmount`/`phpPerUnit` — reads a
 *     ₱1,200 bonus as COP 1,200 and pays about ₱18;
 *  2. writing a native figure into a peso column (`bonus_catalog_applied.amount`,
 *     `pay_php`) — the Payroll Wizard pays that column verbatim, so a COP number
 *     landing there pays about 68x the bonus.
 *
 * Mirrors the `no-skip-flag` style of guard already used for the KPI cache.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

/** Source, with line endings normalised to LF. The working tree is CRLF on
 *  Windows, so any guard that anchors on a newline would silently stop matching
 *  — and a source guard that quietly matches nothing is worse than no guard. */
const read = (rel: string) =>
  fs.readFileSync(path.join(process.cwd(), rel), 'utf8').replace(/\r\n/g, '\n');

const KPI = 'src/components/manager/DeptBonusCalculator.tsx';
const WIZARD = 'src/components/PayrollWizard.tsx';
const LIB = 'src/lib/payroll/settlement-currency.ts';
const ROUTE = 'app/api/payroll/settlement-currency/route.ts';

/** The source of one top-level `function <name>(...)`, sliced by name rather
 *  than matched across lines so these guards don't hinge on newline handling.
 *
 *  The terminator is `\n}\n` — a brace alone on its own line — NOT `\n}`, which
 *  also matches the `}: {` closing a destructured parameter list and would slice
 *  off the whole body of any component that takes props that way. */
function functionBody(src: string, name: string): string {
  const at = src.indexOf(`function ${name}(`);
  assert.ok(at > 0, `${name} must exist`);
  const end = src.indexOf('\n}\n', at);
  assert.ok(end > at, `${name} must be a top-level function`);
  return src.slice(at, end);
}

test('the KPI Calculator saves the CATALOG currency, never the settlement one', () => {
  const src = read(KPI);
  const calls = [...src.matchAll(/computeAmount\(([^;]*?)\)[,;]/g)].map((m) => m[1]!);
  assert.ok(calls.length >= 2, 'expected the display and the save call sites');
  for (const args of calls) {
    assert.ok(
      !/settlement|settledFigure|settlementFor/.test(args),
      `computeAmount must never receive a settlement currency — got: ${args.trim()}`,
    );
  }
  // The row written to bonus_catalog_applied stays on the catalog axis.
  assert.match(
    src,
    /amount: computeAmount\(bonus, st\.vars, fx, effectiveCurrency\(key, bonus\)\)/,
    'the saved applied-row amount must be the PHP figure from the catalog currency',
  );
});

test('nothing on a settlement path calls phpPerUnit with a settlement currency', () => {
  for (const rel of [KPI, WIZARD, LIB]) {
    const src = read(rel);
    for (const m of src.matchAll(/phpPerUnit\(([^)]*)\)/g)) {
      assert.ok(
        !/settlement|settle/i.test(m[1]!),
        `${rel}: phpPerUnit must never be handed a settlement currency — got: ${m[1]}`,
      );
    }
  }
});

test('the settlement module never resolves a country from invite_country', () => {
  const src = read(LIB);
  // The trust rule: a Filipino hire was once INVITED under "Colombia". Only the
  // hire's own submitted `country` may mark anyone. `invite_country` may appear
  // in prose explaining the rule, but never as a property read.
  assert.ok(
    !/\.invite_country|\binvite_country:/.test(src),
    'invite_country must never be read as a country source',
  );
});

test('a native figure only ever comes from settlementAmountFromPhp', () => {
  // nativeAmountFromPhp is the raw, ungated conversion. Every settlement
  // surface must go through settlementAmountFromPhp instead, because that is
  // what refuses to convert on an unset/placeholder rate.
  for (const rel of [KPI, WIZARD]) {
    const src = read(rel);
    assert.ok(
      !src.includes('nativeAmountFromPhp'),
      `${rel}: use settlementAmountFromPhp (rate-gated), never nativeAmountFromPhp`,
    );
  }
  assert.ok(
    read(LIB).includes('nativeAmountFromPhp'),
    'the gate itself is the one place allowed to call the raw conversion',
  );
});

test('the USD equivalence line refuses an unlicensed rate', () => {
  // Totals carry a "~ $USD · ₱PHP" line under the native headline. USD is a
  // CONVERSION, so it is subject to the same licence as the headline: an unset
  // per-cycle rate or the official placeholders must produce no line at all,
  // never a plausible-looking number.
  const src = read(KPI);
  const usd = functionBody(src, 'usdFromPhp');
  assert.ok(
    usd.includes("rate.status !== 'live'"),
    'usdFromPhp must return null unless the rate is live',
  );
  assert.ok(
    usd.includes('usdToPhp <= 0'),
    'and must guard the divisor rather than returning Infinity',
  );
  // The peso subline is the PHP PIVOT, not a conversion — but it must only show
  // where the headline is NOT already pesos, or it just repeats itself.
  assert.ok(
    functionBody(src, 'PesoSubline').includes("fig.cur === 'PHP') return null"),
    'PesoSubline must render nothing for a peso-settled figure',
  );
});

test('a settled total keeps BOTH the native bag and the PHP pivot', () => {
  // The native legs cannot be summed across currencies, and the PHP pivot is
  // the only figure comparable across a mixed department (and the one the
  // Wizard pays). Collapsing to either alone loses something that is needed.
  const src = read(KPI);
  assert.match(
    src,
    /type SettledTotal = \{ money: Money; php: number \}/,
    'SettledTotal must carry the native bag AND the peso pivot',
  );
  const fig = src.slice(src.indexOf('const settledFigure = useCallback('));
  assert.ok(
    /\{ amt: number; cur: PayCurrency; php: number \}/.test(fig),
    'settledFigure must return the peso pivot alongside the native figure',
  );
});

test('both settlement surfaces resolve FX provenance from the shared route, not app-settings', () => {
  // /api/app-settings hands back a raw value that the effectiveUsdTo*RateFromStored
  // helpers would silently turn into the official placeholder. The settlement
  // route decides provenance server-side and withholds the numbers unless live,
  // so a surface cannot accidentally convert with a rate nobody confirmed.
  for (const rel of [KPI, WIZARD]) {
    const src = read(rel);
    assert.ok(
      src.includes("'/api/payroll/settlement-currency'"),
      `${rel}: must read the settlement marker + rate from the shared route`,
    );
  }
});

test('the settlement route admits every role that renders the KPI Calculator', () => {
  // DeptBonusCalculator serves BOTH managers and QC officers (the QC first-pass
  // view is the same table). A missing role is silent: the fetch 403s, no marker
  // arrives, and every Colombian renders in pesos with no sticker — which reads
  // as "this person is Filipino".
  const src = read(ROUTE);
  const m = /const ALLOWED_ROLES = \[([^\]]*)\]/.exec(src);
  assert.ok(m, 'ALLOWED_ROLES must be a literal list');
  for (const role of ['manager', 'qc', 'accounting', 'admin']) {
    assert.ok(m[1]!.includes(`'${role}'`), `ALLOWED_ROLES must include ${role}`);
  }
});

test('the settlement route pages every identity read', () => {
  // PostgREST caps at 1000 rows even with an explicit .range(), and the roster
  // passed 1,000 people in Jul 2026 — an un-paged read would silently drop the
  // tail of the alphabet and quietly un-mark those Colombians.
  const src = read(ROUTE);
  const selects = [...src.matchAll(/\.from\('([^']+)'\)/g)].map((m) => m[1]!);
  assert.deepEqual(
    selects.sort(),
    ['global_master_list', 'hr_onboarding_submissions'],
    'the two direct identity reads',
  );
  assert.equal(
    [...src.matchAll(/selectAllPaged</g)].length,
    2,
    'both direct reads must be paged',
  );
});

test('the route memoizes the marker map but NEVER the FX rate', () => {
  // The marker map is near-static and costs three full-table reads, so it is
  // memoized for the Manager shell's unmount-on-every-tab-switch. The rate is
  // the money-sensitive half — Accounting sets it mid-cycle — so it must be read
  // fresh on every request, and a partial (read-error) build must never be
  // cached and served as the truth.
  const src = read(ROUTE);
  assert.ok(
    /markerCache = \{ at: Date\.now\(\), byEmail: byEmailMap \}/.test(src),
    'the completed marker map is memoized',
  );
  const guardAt = src.indexOf('Identity read failed');
  const writeAt = src.indexOf('markerCache = { at:');
  assert.ok(
    guardAt > 0 && writeAt > guardAt,
    'the memo write must come after the read-failure guard, so a partial map is never cached',
  );
  assert.ok(!/rateCache|cachedRate/.test(src), 'the FX rate must never be cached');
  assert.ok(
    src.indexOf('resolveSettlementRate') < src.indexOf('markerCache && Date.now()'),
    'the rate is resolved before the marker cache short-circuit, so a cache hit still returns a fresh rate',
  );
});

test('the rates bridge never hand-rolls a snake_case projection', () => {
  // `employee_hourly_rates` is CSV-seeded: its columns are quoted and
  // capitalised ("Work Email"), so `select('work_email, personal_email')` fails
  // with `column employee_hourly_rates.work_email does not exist` — and if the
  // caller bails on that error, EVERY marker is lost, not just the bridged
  // ones. The shared helper also owns the env-var table name and the view.
  for (const rel of [ROUTE, 'scripts/verify-settlement-currency.mts']) {
    const src = read(rel);
    assert.ok(
      !/from\(["']employee_hourly_rates["']\)/.test(src),
      `${rel}: read rates through getEmployeeHourlyRatesRows, never directly`,
    );
    assert.ok(
      src.includes('getEmployeeHourlyRatesRows'),
      `${rel}: must use the shared rates helper`,
    );
  }
});
