import test from 'node:test';
import assert from 'node:assert/strict';
import { matchHslSubDeptKey, calcBonus, HSL_DEPT_KEYS, HSL_DEPTS } from './schema';

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
