import test from 'node:test';
import assert from 'node:assert/strict';
import {
  matchHslSubDeptKey, calcBonus, HSL_DEPT_KEYS, HSL_DEPTS,
  HSL_MANAGERS, HSL_MANAGER_SHEET_2026_08_30, calcManagerBonus, managerSpecFor, managerCohortFor,
  landedBand, bandValue, hslDeptAutoDispatches, type ManagerComponent, type KpiData,
} from './schema';

test('matchHslSubDeptKey resolves every branch display name, case/whitespace-tolerant', () => {
  for (const key of HSL_DEPT_KEYS) {
    const name = HSL_DEPTS[key].name;
    assert.equal(matchHslSubDeptKey(name), key);
    assert.equal(matchHslSubDeptKey(name.toUpperCase()), key);
    assert.equal(matchHslSubDeptKey(`  ${name}  `), key);
  }
});

test('matchHslSubDeptKey resolves the namespaced hsl:<key> form', () => {
  assert.equal(matchHslSubDeptKey('hsl:case_managers'), 'case_managers');
  assert.equal(matchHslSubDeptKey('HSL:CASE_MANAGERS'), 'case_managers');
  assert.equal(matchHslSubDeptKey('hsl:not_a_real_branch'), null);
});

test('matchHslSubDeptKey returns null for generic HSL tags and unrelated strings', () => {
  assert.equal(matchHslSubDeptKey('HSL'), null);
  assert.equal(matchHslSubDeptKey('Hogan Smith Law'), null);
  assert.equal(matchHslSubDeptKey('Hogan'), null);
  assert.equal(matchHslSubDeptKey('Accounting'), null);
  assert.equal(matchHslSubDeptKey(null), null);
  assert.equal(matchHslSubDeptKey(undefined), null);
  assert.equal(matchHslSubDeptKey('   '), null);
});

// ── Attestation formula pin ──────────────────────────────────────────────────
// The manager sheet (2026-08-24):
//   =IF(Cases>=50,Cases*100,IF(Cases>=35,Cases*75,IF(Cases>=25,Cases*50,0)))
//     + (Referral Leads * 250) + (SSA.Gov * 250)
// The tiered term reads the CASE COUNT ALONE; the two per-unit terms are purely
// additive. `calculated_bonus` is frozen at save and dispatched verbatim by the
// wizard, so a drift here is a mispay, not a display bug.
const attestationSheet = (cases: number, referralLeads: number, ssaGov: number) =>
  (cases >= 50 ? cases * 100 : cases >= 35 ? cases * 75 : cases >= 25 ? cases * 50 : 0) +
  referralLeads * 250 +
  ssaGov * 250;

test('attestation calcBonus reproduces the sheet formula across every band boundary', () => {
  for (let cases = 0; cases <= 120; cases++) {
    for (const referral_leads of [0, 1, 7]) {
      for (const ssa_gov of [0, 1, 4]) {
        assert.equal(
          calcBonus({ attested_cases: cases, referral_leads, ssa_gov }, HSL_DEPTS.attestation, false),
          attestationSheet(cases, referral_leads, ssa_gov),
          `cases=${cases} referral_leads=${referral_leads} ssa_gov=${ssa_gov}`,
        );
      }
    }
  }
});

test('attestation: referral leads and SSA.Gov never lift the case tier', () => {
  // 24 cases is below the first band; 100 referral leads must NOT buy the ₱50 rate.
  assert.equal(
    calcBonus({ attested_cases: 24, referral_leads: 100, ssa_gov: 0 }, HSL_DEPTS.attestation, false),
    25_000,
  );
  // 49 cases stays in the ₱75 band no matter how many extras ride along.
  assert.equal(
    calcBonus({ attested_cases: 49, referral_leads: 10, ssa_gov: 10 }, HSL_DEPTS.attestation, false),
    49 * 75 + 5_000,
  );
});

test('attestation: the additive terms pay even when the tiered term is zero', () => {
  assert.equal(
    calcBonus({ attested_cases: 0, referral_leads: 3, ssa_gov: 2 }, HSL_DEPTS.attestation, false),
    1_250,
  );
});

test('attestation: the 2026-07-27 bands are unchanged (whole count x landed rate)', () => {
  const cases = (n: number) => calcBonus({ attested_cases: n }, HSL_DEPTS.attestation, false);
  assert.equal(cases(24), 0);
  assert.equal(cases(25), 1_250);   // 25 x 50 — whole count, not marginal
  assert.equal(cases(34), 1_700);
  assert.equal(cases(35), 2_625);   // 35 x 75
  assert.equal(cases(49), 3_675);
  assert.equal(cases(50), 5_000);   // 50 x 100
});

test('attestation: historical rows with no referral_leads/ssa_gov keys recompute unchanged', () => {
  // Rows saved before 2026-08-24 carry only `attested_cases` in kpi_data. The new
  // rules must read absent as 0 so no past week silently reprices.
  for (const n of [0, 24, 25, 35, 50, 87]) {
    assert.equal(
      calcBonus({ attested_cases: n }, HSL_DEPTS.attestation, false),
      attestationSheet(n, 0, 0),
    );
  }
});

test('attestation exposes exactly one scoring column per sheet term', () => {
  assert.deepEqual(
    HSL_DEPTS.attestation.rules.map((r) => [r.key, r.type]),
    [
      ['attested_cases', 'tiered'],
      ['referral_leads', 'per_unit'],
      ['ssa_gov', 'per_unit'],
    ],
  );
  // No monthly cap — a cap would silently truncate the additive terms.
  assert.equal(HSL_DEPTS.attestation.monthlyMax, undefined);
  // Weekly cadence keeps it inside the wizard's unconditional auto-pay pass.
  assert.equal(HSL_DEPTS.attestation.cadence, 'weekly');
});

// ── Managers Weekly: dated specs + banded tiers (the 2026-08-30 sheet) ────────
// Rob approved effective Aug 24, Austin effective Aug 31; Carla (2026-09-08):
// starts with the 8/30–9/5 week, earned WEEKLY, the scorer picks the band that
// applies. The wizard recomputes this dept from kpi_data with the spec in code,
// so a drift here re-prices paid weeks — every assertion below is a money pin.
const OLD_WEEK = '2026-08-23'; // scored + PAID (Sept 2–4) under the Julie sheet
const NEW_WEEK = HSL_MANAGER_SHEET_2026_08_30;
const LATER_WEEK = '2026-10-04';

test('managers: the 2026-08-23 week still resolves to the Julie-sheet specs, byte-identical', () => {
  const expectOld: Record<string, ManagerComponent[]> = {
    'mariely@simple.biz': [
      { kind: 'check', key: 'closes_30',       label: 'Closes over 30% of overall leads',   amount: 2500 },
      { kind: 'check', key: 'form_response_1', label: 'Average Form Response < 1.0 Minutes', amount: 2500 },
    ],
    'juliec@simple.biz': [
      { kind: 'check', key: 'closes_30',       label: 'Closes over 30% of overall leads',   amount: 1250 },
      { kind: 'check', key: 'form_response_1', label: 'Average Form Response < 1.0 Minutes', amount: 1250 },
    ],
    'stara@simple.biz': [
      { kind: 'check', key: 'monthly_perf', label: 'Monthly Performance Bonus', amount: 2500, cadence: 'monthly' },
    ],
    'emss@simple.biz': [
      { kind: 'check', key: 'monthly_perf', label: 'Monthly Performance Bonus', amount: 2500, cadence: 'monthly' },
    ],
  };
  for (const [email, components] of Object.entries(expectOld)) {
    assert.deepEqual(managerSpecFor(email, OLD_WEEK)?.components, components, email);
  }
  assert.equal(managerSpecFor('dana@simple.biz', OLD_WEEK)?.components.length, 2);
  assert.equal(managerSpecFor('jayh@simple.biz', OLD_WEEK)?.components.length, 2);
});

test('managers: saved 2026-08-23 tick marks recompute to exactly what was paid', () => {
  // Shapes lifted from the live hsl_bonus_entries rows for period_start 2026-08-23.
  assert.equal(calcManagerBonus('eulap@simple.biz', { rfc_dme_75: true, rfc_dme_100: true }, { periodStart: OLD_WEEK }), 3750);
  assert.equal(calcManagerBonus('gyd@simple.biz', { monthly_bonus: true }, { periodStart: OLD_WEEK }), 25000);
  assert.equal(calcManagerBonus('stara@simple.biz', { monthly_perf: true }, { periodStart: OLD_WEEK }), 2500);
  assert.equal(calcManagerBonus('emss@simple.biz', { monthly_perf: true }, { periodStart: OLD_WEEK }), 2500);
  assert.equal(calcManagerBonus('jazzr@simple.biz', { monthly_perf: true }, { periodStart: OLD_WEEK }), 2500);
  assert.equal(calcManagerBonus('veec@simple.biz', { incomplete_5: true, incomplete_10: true }, { periodStart: OLD_WEEK }), 5000);
  assert.equal(calcManagerBonus('andret@simple.biz', { awaiting_2: true, awaiting_3: true, awaiting_2_5: true }, { periodStart: OLD_WEEK }), 7500);
  assert.equal(calcManagerBonus('mariely@simple.biz', { form_response_1: true }, { periodStart: '2026-08-16' }), 2500);
  assert.equal(calcManagerBonus('juliec@simple.biz', { form_response_1: true }, { periodStart: '2026-08-16' }), 1250);
  // Sherwin / AR / Jazmine had nothing to earn before the new sheet.
  assert.equal(calcManagerBonus('sherwins@simple.biz', { nurture_signups: 500 }, { periodStart: OLD_WEEK }), 0);
  assert.equal(calcManagerBonus('jazminer@simple.biz', { weekly_batches: 40 }, { periodStart: OLD_WEEK }), 0);
  // And a new-sheet key means nothing to an old-week spec.
  assert.equal(calcManagerBonus('mariely@simple.biz', { signups_weekly: 1500 }, { periodStart: OLD_WEEK }), 0);
});

test('managers: the Julie-sheet ticks pay nothing from 2026-08-30 for the re-sheeted six', () => {
  for (const email of ['mariely@simple.biz', 'dana@simple.biz', 'juliec@simple.biz', 'jayh@simple.biz']) {
    assert.equal(calcManagerBonus(email, { closes_30: true, form_response_1: true }, { periodStart: NEW_WEEK }), 0, email);
  }
  assert.equal(calcManagerBonus('stara@simple.biz', { monthly_perf: true }, { periodStart: NEW_WEEK }), 0);
  assert.equal(calcManagerBonus('emss@simple.biz', { monthly_perf: true }, { periodStart: NEW_WEEK }), 0);
});

test('managers: the cohort is 11 before 2026-08-30 and 14 from it', () => {
  const before = managerCohortFor(OLD_WEEK).map((m) => m.email);
  const after = managerCohortFor(NEW_WEEK).map((m) => m.email);
  assert.equal(before.length, 11);
  assert.equal(after.length, 14);
  for (const e of ['sherwins@simple.biz', 'arr@simple.biz', 'jazminer@simple.biz']) {
    assert.ok(!before.includes(e), `${e} must not be in the old cohort`);
    assert.ok(after.includes(e), `${e} must be in the new cohort`);
  }
  assert.equal(new Set(after).size, after.length, 'one resolved spec per manager');
  assert.equal(managerCohortFor(LATER_WEEK).length, 14);
});

test('managers: Gyd, Eula, Andre, Vee and Jazz Redulla are unchanged across the sheet change', () => {
  for (const email of ['gyd@simple.biz', 'eulap@simple.biz', 'andret@simple.biz', 'veec@simple.biz', 'jazzr@simple.biz']) {
    const a = managerSpecFor(email, OLD_WEEK);
    const b = managerSpecFor(email, NEW_WEEK);
    assert.ok(a && b, email);
    assert.strictEqual(a, b, `${email} must resolve to the very same spec object`);
    assert.equal(a.effectiveFrom, undefined);
  }
});

// The sheet, band by band, at every boundary. `to` bounds are inclusive.
const intake = (n: number) => (n >= 1500 ? 10000 : n >= 1400 ? 8000 : n >= 1300 ? 6500 : n >= 1200 ? 5000 : 0);
test('managers: Intake Manager + the three Intake TLs pay the sign-up ladder from 2026-08-30', () => {
  for (const email of ['mariely@simple.biz', 'dana@simple.biz', 'juliec@simple.biz', 'jayh@simple.biz']) {
    for (const n of [0, 1, 1199, 1200, 1250, 1299, 1300, 1399, 1400, 1499, 1500, 1501, 9000]) {
      assert.equal(calcManagerBonus(email, { signups_weekly: n }, { periodStart: NEW_WEEK }), intake(n), `${email} n=${n}`);
    }
  }
});

test('managers: Sherwin pays the Lead Nurture ladder', () => {
  const sheet = (n: number) => (n >= 500 ? 10000 : n >= 400 ? 7500 : n >= 300 ? 5000 : 0);
  for (const n of [0, 299, 300, 399, 400, 499, 500, 501, 2000]) {
    assert.equal(calcManagerBonus('sherwins@simple.biz', { nurture_signups: n }, { periodStart: NEW_WEEK }), sheet(n), `n=${n}`);
  }
});

test('managers: Star pays the completion ladder weekly (no monthly gate)', () => {
  const sheet = (p: number) => (p >= 100 ? 5000 : p >= 90 ? 3500 : p >= 85 ? 2500 : 0);
  for (const p of [0, 84.99, 85, 89.99, 90, 99.99, 100, 100.5, 110]) {
    assert.equal(calcManagerBonus('stara@simple.biz', { completion_pct: p }, { periodStart: NEW_WEEK }), sheet(p), `p=${p}`);
    // Weekly now: excluding monthly components changes nothing.
    assert.equal(
      calcManagerBonus('stara@simple.biz', { completion_pct: p }, { periodStart: NEW_WEEK, includeMonthly: false }),
      sheet(p),
      `p=${p} includeMonthly:false`,
    );
  }
});

test('managers: AR pays by failover count — zero failovers is the TOP band, not "unset"', () => {
  assert.equal(calcManagerBonus('arr@simple.biz', { failovers: 0 }, { periodStart: NEW_WEEK }), 10000);
  assert.equal(calcManagerBonus('arr@simple.biz', { failovers: 1 }, { periodStart: NEW_WEEK }), 5000);
  assert.equal(calcManagerBonus('arr@simple.biz', { failovers: 2 }, { periodStart: NEW_WEEK }), 0);
  assert.equal(calcManagerBonus('arr@simple.biz', { failovers: 7 }, { periodStart: NEW_WEEK }), 0);
  assert.equal(calcManagerBonus('arr@simple.biz', {}, { periodStart: NEW_WEEK }), 0);
});

test('managers: Jazmine pays the weekly-batches ladder', () => {
  const sheet = (n: number) => (n >= 40 ? 2000 : n >= 30 ? 1500 : 0);
  for (const n of [0, 29, 30, 39, 40, 50, 51, 80]) {
    assert.equal(calcManagerBonus('jazminer@simple.biz', { weekly_batches: n }, { periodStart: NEW_WEEK }), sheet(n), `n=${n}`);
  }
});

test('managers: Ems pays the case-prepared ladder weekly (approved — Carla 2026-09-08)', () => {
  const sheet = (p: number) => (p >= 98 ? 5000 : p >= 95 ? 3500 : p >= 87 ? 2500 : 0);
  for (const p of [0, 86.99, 87, 94.99, 95, 97.99, 98, 100]) {
    assert.equal(calcManagerBonus('emss@simple.biz', { case_prepared_pct: p }, { periodStart: NEW_WEEK }), sheet(p), `p=${p}`);
    assert.equal(calcManagerBonus('emss@simple.biz', { case_prepared_pct: p }, { periodStart: NEW_WEEK, includeMonthly: false }), sheet(p));
  }
});

test('managers: a banded component only pays exactly one band, and only for a number', () => {
  for (const spec of HSL_MANAGERS) {
    for (const c of spec.components) {
      if (c.kind !== 'banded') continue;
      // Every band's stored value lands back in that same band (the picker round-trips).
      for (const b of c.bands) {
        assert.strictEqual(landedBand(c.bands, bandValue(b)), b, `${spec.email} ${c.key} ${b.label}`);
      }
      // No two bands overlap at any representative or boundary value.
      const probes = c.bands.flatMap((b) => [b.from, b.to]).filter((v): v is number => v !== undefined);
      for (const v of probes) {
        assert.equal(c.bands.filter((b) => (b.from === undefined || v >= b.from) && (b.to === undefined || v <= b.to)).length, 1, `${spec.email} ${c.key} v=${v}`);
      }
      // Booleans (a stale checkbox tick) and absence score nothing.
      const week = spec.effectiveFrom ?? OLD_WEEK;
      assert.equal(calcManagerBonus(spec.email, { [c.key]: true }, { periodStart: week }), 0);
      assert.equal(calcManagerBonus(spec.email, { [c.key]: false }, { periodStart: week }), 0);
      assert.equal(calcManagerBonus(spec.email, {}, { periodStart: week }), 0);
      assert.equal(landedBand(c.bands, Number.NaN), undefined);
    }
  }
});

test('managers: every re-sheeted component is weekly — nothing on the new sheet is monthly', () => {
  for (const spec of HSL_MANAGERS) {
    if (spec.effectiveFrom !== NEW_WEEK) continue;
    for (const c of spec.components) assert.notEqual(c.cadence, 'monthly', `${spec.email} ${c.key}`);
  }
});

test('managers: the monthly gate still governs the Julie-sheet monthly lines', () => {
  assert.equal(calcManagerBonus('gyd@simple.biz', { monthly_bonus: true }, { periodStart: NEW_WEEK, includeMonthly: false }), 0);
  assert.equal(calcManagerBonus('gyd@simple.biz', { monthly_bonus: true }, { periodStart: NEW_WEEK, includeMonthly: true }), 25000);
  assert.equal(calcManagerBonus('stara@simple.biz', { monthly_perf: true }, { periodStart: OLD_WEEK, includeMonthly: false }), 0);
});

test('managers: an undated period_start is refused, never silently resolved', () => {
  assert.throws(() => calcManagerBonus('gyd@simple.biz', {}, { periodStart: '' }));
  assert.throws(() => managerSpecFor('gyd@simple.biz', 'Aug 30'));
  assert.throws(() => managerCohortFor('2026-8-30'));
});

test('managers: unknown emails score ₱0 in every week', () => {
  assert.equal(calcManagerBonus('nobody@simple.biz', { signups_weekly: 1500 }, { periodStart: NEW_WEEK }), 0);
  assert.equal(managerSpecFor('nobody@simple.biz', NEW_WEEK), undefined);
});

// ── Pre-Hearing / Post-Hearing Prep: the ₱2,500 monthly checkbox (Carla, 2026-09-08)
// "They have a monthly bonus of 2500 … a checkbox that applies 2500 when checked."
// One tick per person per month, final payroll week only, OUTSIDE the ₱3,500
// weekly KPI cap. Aug 30 – Sep 5 is August's final payroll week (next Sunday is
// in September); Sep 6 – 12 is not.
const PHP = HSL_DEPTS.post_hearing_prep;
const FINAL_WEEK = '2026-08-30';
const MID_WEEK = '2026-09-06';

test('post_hearing_prep: the monthly bonus is a ₱2,500 flat checkbox for every member', () => {
  const r = PHP.rules.find((x) => x.key === 'monthly_bonus');
  assert.ok(r && r.type === 'flat');
  assert.equal(r.amount, 2500);
  assert.equal(r.cadence, 'monthly');
  assert.equal(r.exemptFromMonthlyMax, true);
  assert.equal(r.managerOnly, undefined, 'Carla said "they" — every member, not managers only');
  assert.equal(PHP.monthlyMax, 3500, 'the weekly KPI cap is untouched');
});

test('post_hearing_prep: the monthly bonus rides ON TOP of the ₱3,500 weekly cap', () => {
  // 14 five-star surveys = ₱3,500 exactly; 20 = ₱5,000 → capped to ₱3,500.
  assert.equal(calcBonus({ five_star_survey: 20 }, PHP, false, { periodStart: FINAL_WEEK }), 3500);
  assert.equal(calcBonus({ five_star_survey: 20, monthly_bonus: true }, PHP, false, { periodStart: FINAL_WEEK }), 6000);
  assert.equal(calcBonus({ five_star_survey: 4, monthly_bonus: true }, PHP, false, { periodStart: FINAL_WEEK }), 3500);
  assert.equal(calcBonus({ monthly_bonus: true }, PHP, false, { periodStart: FINAL_WEEK }), 2500);
  assert.equal(calcBonus({ monthly_bonus: false }, PHP, false, { periodStart: FINAL_WEEK }), 0);
});

test('post_hearing_prep: a monthly tick pays nothing in a week that is not the month\'s final payroll week', () => {
  assert.equal(calcBonus({ five_star_survey: 4, monthly_bonus: true }, PHP, false, { periodStart: MID_WEEK }), 1000);
  assert.equal(calcBonus({ monthly_bonus: true }, PHP, false, { periodStart: MID_WEEK }), 0);
  // Without a week to judge by, the saved tick is honoured (the wizard pays the
  // stored calculated_bonus and never calls this for a per-unit dept).
  assert.equal(calcBonus({ monthly_bonus: true }, PHP, false), 2500);
});

test('post_hearing_prep: rows saved before the checkbox existed recompute unchanged', () => {
  const legacyRows: KpiData[] = [{}, { five_star_survey: 3 }, { portal_login: 7, five_star_survey: 2 }, { five_star_survey: 30 }];
  for (const kpi of legacyRows) {
    const before = Math.min(3500, Number(kpi.five_star_survey ?? 0) * 250 + Number(kpi.portal_login ?? 0) * 100);
    assert.equal(calcBonus(kpi, PHP, false), before, JSON.stringify(kpi));
    assert.equal(calcBonus(kpi, PHP, false, { periodStart: FINAL_WEEK }), before, JSON.stringify(kpi));
  }
});

test('flat rules elsewhere are untouched: Collections\' manager-only monthly flat still sums inside the (absent) cap', () => {
  const col = HSL_DEPTS.collections;
  assert.equal(calcBonus({ monthly_flat: true, converted_referral: 2 }, col, true), 3000);
  assert.equal(calcBonus({ monthly_flat: true, converted_referral: 2 }, col, false), 500);
  // No cadence on that rule → no final-week gate, whatever week is passed.
  assert.equal(calcBonus({ monthly_flat: true }, col, true, { periodStart: MID_WEEK }), 2500);
});

test('only post_hearing_prep carries a cap-exempt or monthly flat rule (a new one is a pay decision)', () => {
  for (const k of HSL_DEPT_KEYS) {
    for (const r of HSL_DEPTS[k].rules) {
      if (r.type !== 'flat') continue;
      if (r.cadence === 'monthly' || r.exemptFromMonthlyMax) {
        assert.equal(k, 'post_hearing_prep', `${k}.${r.key}`);
      }
    }
  }
});

// ── Case Managers: SSA.Gov ×₱250 (2026-09-08, Carla via Kane) ─────────────────
// Sheet: (Reviews*250)+(RFC*250)+(PPL*100)+(DME*250)+(Task*250)+(Referral Leads*250)+(SSA.Gov*250)
const CM = HSL_DEPTS.case_managers;
const cmSheet = (k: Record<string, number>) =>
  (k.reviews ?? 0) * 250 + (k.rfc ?? 0) * 250 + (k.ppl ?? 0) * 100 + (k.dme ?? 0) * 250 +
  (k.task ?? 0) * 250 + (k.referral_leads ?? 0) * 250 + (k.ssa_gov ?? 0) * 250;

test('case_managers: exactly the seven sheet terms, all per-unit, no cap, weekly', () => {
  assert.deepEqual(
    CM.rules.map((r) => [r.type, r.key, r.type === 'per_unit' ? r.rate : null]),
    [
      ['per_unit', 'reviews', 250], ['per_unit', 'rfc', 250], ['per_unit', 'ppl', 100],
      ['per_unit', 'dme', 250], ['per_unit', 'task', 250], ['per_unit', 'referral_leads', 250],
      ['per_unit', 'ssa_gov', 250],
    ],
  );
  assert.equal(CM.monthlyMax, undefined);
  assert.equal(CM.cadence, 'weekly');
});

test('case_managers: calcBonus reproduces the sheet with SSA.Gov added on top', () => {
  for (const ssa_gov of [0, 1, 3, 12]) {
    const bases: Record<string, number>[] = [{}, { reviews: 2 }, { reviews: 1, rfc: 2, ppl: 3, dme: 1, task: 4, referral_leads: 1 }, { ppl: 9 }];
    for (const k of bases) {
      const kpi: Record<string, number> = { ...k, ssa_gov };
      assert.equal(calcBonus(kpi, CM, false), cmSheet(kpi), JSON.stringify(kpi));
      assert.equal(calcBonus(kpi, CM, true), cmSheet(kpi), `manager ${JSON.stringify(kpi)}`);
    }
  }
  assert.equal(calcBonus({ ssa_gov: 4 }, CM, false), 1000);
});

test('case_managers: rows saved before the SSA.Gov term recompute unchanged (not retroactive)', () => {
  const legacy: Record<string, number>[] = [{}, { reviews: 2, dme: 1 }, { reviews: 1, rfc: 2, ppl: 3, dme: 1, task: 4, referral_leads: 1 }];
  for (const k of legacy) {
    assert.equal(calcBonus(k, CM, false), cmSheet(k), JSON.stringify(k));
  }
});

// ── SSD Medical Records auto-dispatches in the week it is marked Ready (2026-09-08)
// Carla: SSD "is a monthly payment, typically processed in the first week of the
// month", and it must be "combined with the weekly bonus". `cadence: 'monthly'`
// since 2026-07-18 had silently dropped SSD from the wizard's weekly-only auto-pay
// set (₱475 Medical Records paid, ₱1,625 SSD share did not, 49 people). The
// manager's Ready is the trigger — not the calendar — so the loader's period_start
// pin is the only gate.
const MONTHLY_AUTO_DISPATCH = new Set<string>(['ssd_medical_records', 'collections']);
test('ssd_medical_records + collections: monthly, and the ONLY depts opted into monthly auto-dispatch', () => {
  assert.equal(HSL_DEPTS.ssd_medical_records.cadence, 'monthly');
  assert.equal(HSL_DEPTS.ssd_medical_records.monthlyAutoPay, true);
  // Carla (2026-09-08): 30 Collections people ticked manager + monthly flat and
  // ₱77,000 never reached pay — same class as SSD, same ruling.
  assert.equal(HSL_DEPTS.collections.cadence, 'monthly');
  assert.equal(HSL_DEPTS.collections.monthlyAutoPay, true);
  for (const k of HSL_DEPT_KEYS) {
    if (MONTHLY_AUTO_DISPATCH.has(k)) continue;
    assert.notEqual(HSL_DEPTS[k].monthlyAutoPay, true, `${k} must not auto-dispatch monthly without a ruling`);
  }
});

test('hslDeptAutoDispatches: every weekly dept, SSD, Collections, and no other monthly dept', () => {
  for (const k of HSL_DEPT_KEYS) {
    const d = HSL_DEPTS[k];
    const expected = d.cadence === 'weekly' || MONTHLY_AUTO_DISPATCH.has(k);
    assert.equal(hslDeptAutoDispatches(d), expected, k);
  }
  assert.equal(hslDeptAutoDispatches(HSL_DEPTS.collections), true);
  assert.equal(hslDeptAutoDispatches(HSL_DEPTS.healthcare_team_lead), false);
  assert.equal(hslDeptAutoDispatches(HSL_DEPTS.medical_records), true);
  assert.equal(hslDeptAutoDispatches(HSL_DEPTS.ssd_medical_records), true);
});
