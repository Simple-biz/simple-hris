import test from 'node:test';
import assert from 'node:assert/strict';
import {
  DEPARTMENTS,
  DEPT_INPUT_CONFIG,
  DEPT_DESCRIPTION,
  MANAGER_BONUS_DEPT_KEYS,
  WIZARD_PAYABLE_KPI_DEPT_KEYS,
  KPI_CALCULATOR_RETIRED_DEPT_KEYS,
  isKpiCalculatorDeptKey,
} from './department-bonus';
import { HSL_DEPT_KEYS, hslAccessKey } from '../hsl-bonus/schema';
import { normalizeDeptToKey } from './normalize-dept-key';
import { slugifyDeptKey } from '../departments/registry';

// ── Departments permanently retired from the KPI Calculator (2026-08-10) ──────
//
// Kane: "All of those departments should be removed from KPI Calculator
// permanently." These eleven have no formal bonus structure, or are not run
// through HRIS payroll at all. The calculator draws cards from TWO sources —
// the built-in DEPT_INPUT_CONFIG keys and the slugs of unmapped
// `department_managers` grant labels — so both halves are pinned here.

/** The exact labels the manager reported, as they appear on the master list /
 *  in Admin -> Roles & permissions. */
const RETIRED_LABELS = [
  'Sales',
  'SMM Freelancer',
  'Social Media',
  'Executive Assistant to the CEO',
  'Executive Assistants',
  'Manager',
  'Orphan Ministry',
  'Site Building (PH - Freelancer)',
  'Site Building (US - Freelance)',
  'US Manager Bonus',
  'USEE',
];

test('every retired label resolves to a key the KPI Calculator refuses', () => {
  for (const label of RETIRED_LABELS) {
    // A label either maps through the built-in alias map or falls back to its
    // slug — whichever path it takes, the calculator must reject the result.
    const key = normalizeDeptToKey(label) ?? slugifyDeptKey(label);
    assert.ok(key, `${label} produced no department key at all`);
    assert.equal(
      isKpiCalculatorDeptKey(key),
      false,
      `${label} -> "${key}" is still allowed on the KPI Calculator`,
    );
    assert.ok(
      KPI_CALCULATOR_RETIRED_DEPT_KEYS.has(key),
      `${label} -> "${key}" is missing from KPI_CALCULATOR_RETIRED_DEPT_KEYS`,
    );
  }
});

test('no retired department has a KPI Calculator card', () => {
  for (const key of KPI_CALCULATOR_RETIRED_DEPT_KEYS) {
    // Source 1: a bespoke input config would put the card back.
    assert.ok(
      !(key in DEPT_INPUT_CONFIG),
      `"${key}" is retired but still has a DEPT_INPUT_CONFIG entry`,
    );
    // ...and therefore must not reach the calculator's built-in dept list.
    assert.ok(
      !MANAGER_BONUS_DEPT_KEYS.includes(key),
      `"${key}" is retired but still in MANAGER_BONUS_DEPT_KEYS`,
    );
    // Source 2: the grant-slug path funnels through this predicate.
    assert.equal(isKpiCalculatorDeptKey(key), false);
  }
});

test('the "Social Media Team" alias cannot smuggle Social Media back in', () => {
  // normalizeDeptToKey folds several labels onto one key; a retired key has to
  // stay retired through every alias, not just the one Kane happened to name.
  for (const alias of ['Social Media', 'Social Media Team', 'smm', 'SMM Freelancers']) {
    const key = normalizeDeptToKey(alias);
    assert.ok(key, `${alias} lost its alias mapping`);
    assert.equal(isKpiCalculatorDeptKey(key), false, `${alias} -> "${key}" is still allowed`);
  }
});

test('retiring a calculator card does NOT retire the payroll department', () => {
  // DEPARTMENTS drives the Payroll Wizard's Additions tabs, department colours
  // and Hubstaff exemptions. Sales / Social Media / SMM Freelancer keep their
  // payroll identity — only the KPI Calculator card went away.
  const payrollKeys = new Set(DEPARTMENTS.map((d) => d.key));
  for (const key of ['sales', 'smm', 'smm_freelancer']) {
    assert.ok(payrollKeys.has(key), `"${key}" was wrongly dropped from DEPARTMENTS`);
  }
  // sales_assistant is a DIFFERENT department (split 2026-07-27) and keeps both
  // its card and its ₱150/sale formula — see sales-dept-split.md.
  assert.ok(!KPI_CALCULATOR_RETIRED_DEPT_KEYS.has('sales_assistant'));
  assert.ok(MANAGER_BONUS_DEPT_KEYS.includes('sales_assistant'));
  // Plain "Site Building" was NOT retired — only the two freelancer variants.
  assert.ok(!KPI_CALCULATOR_RETIRED_DEPT_KEYS.has('site_building'));
  assert.ok(MANAGER_BONUS_DEPT_KEYS.includes('site_building'));
});

test('the calculator dept list stays internally consistent', () => {
  // Every surviving card needs its description, and no description may outlive
  // its card (the landing card renders DEPT_DESCRIPTION[key]).
  for (const key of MANAGER_BONUS_DEPT_KEYS) {
    assert.ok(DEPT_DESCRIPTION[key], `"${key}" has a card but no DEPT_DESCRIPTION`);
  }
  for (const key of Object.keys(DEPT_DESCRIPTION)) {
    assert.ok(
      MANAGER_BONUS_DEPT_KEYS.includes(key),
      `"${key}" has a DEPT_DESCRIPTION but no calculator card`,
    );
  }
});

// ── Paying a scored week vs. offering a card for it ──────────────────────────
//
// These two questions were the same code path until 2026-08-11, so retiring a
// card silently stopped the Payroll Wizard from reading that department's
// already-applied `bonus_catalog_applied` rows — on the live week and on every
// replay of a week it had been paid in.

test('the wizard still pays every retired department', () => {
  for (const key of KPI_CALCULATOR_RETIRED_DEPT_KEYS) {
    assert.ok(
      WIZARD_PAYABLE_KPI_DEPT_KEYS.has(key),
      `"${key}" lost its card AND its pay — the wizard can no longer read weeks already scored under it`,
    );
  }
});

test('every current card is payable', () => {
  for (const key of MANAGER_BONUS_DEPT_KEYS) {
    assert.ok(
      WIZARD_PAYABLE_KPI_DEPT_KEYS.has(key),
      `"${key}" offers a card the wizard would never pay`,
    );
  }
});

// An HSL sub-department reaches a payable-key lookup ONLY in its namespaced
// `hsl:<key>` form (`hslAccessKey`) — `WIZARD_PAYABLE_KPI_DEPT_KEYS` holds
// unnamespaced slugs, so the namespaced form is the actual double-pay vector.
// A BARE HSL key that matches a payable slug is a NAME COLLISION between two
// unrelated departments, not a double-pay: see the note at
// `src/lib/hsl-bonus/schema.ts` on `executive_assistants` — "this key only ever
// appears as `hsl:executive_assistants`, so the two never meet".
//
// Declared homonyms: a bare HSL dept key that legitimately coexists with an
// identically-named in-app registry department. Adding an entry here is a
// deliberate assertion that the two are DIFFERENT teams paid by different
// loaders. If they are actually the same team, the fix is to remove the slug
// from the payable set — not to add it here.
const KNOWN_DISTINCT_DEPT_HOMONYMS: ReadonlySet<string> = new Set([
  // `executive_assistants`: the bare slug is the in-app registry dept whose
  // calculator card was retired 2026-08-10; the HSL sub-dept of the same name
  // was created 2026-08-14 as roster-only (`noKpi`) and has no bonus program.
  'executive_assistants',
]);

test('the namespaced HSL family never enters the payable KPI set', () => {
  // HSL amounts come from `hsl_bonus_entries` via a separate wizard loader, so a
  // key admitted to BOTH sets is paid twice. This is the real vector: it fails
  // the moment a retirement or config entry smuggles an `hsl:*` key or a family
  // label into the payable set.
  for (const key of [
    ...HSL_DEPT_KEYS.map(hslAccessKey),
    'hogan_smith_law',
    'smart_staff',
    'hsl',
  ]) {
    assert.ok(
      !WIZARD_PAYABLE_KPI_DEPT_KEYS.has(key),
      `"${key}" is in WIZARD_PAYABLE_KPI_DEPT_KEYS — it would be paid twice (catalog + HSL entries)`,
    );
  }
});

test('every bare HSL key colliding with a payable slug is a declared homonym', () => {
  // The general failure class: a department retired from the KPI calculator and
  // later adopted into the HSL family re-enters the payable set silently. This
  // does not blanket-fail on the known homonym (a permanently-red test catches
  // nothing and gets normalised away) — it fails on an UNDECLARED one.
  for (const key of HSL_DEPT_KEYS) {
    if (!WIZARD_PAYABLE_KPI_DEPT_KEYS.has(key)) continue;
    assert.ok(
      KNOWN_DISTINCT_DEPT_HOMONYMS.has(key),
      `bare HSL dept key "${key}" is in WIZARD_PAYABLE_KPI_DEPT_KEYS. If the in-app ` +
        `department of the same name is a DIFFERENT team, declare it in ` +
        `KNOWN_DISTINCT_DEPT_HOMONYMS with a note. If it is the SAME team, it is now paid ` +
        `from hsl_bonus_entries and the slug must leave the payable set — otherwise it is paid twice.`,
    );
  }
});

test('each declared homonym is genuinely a separate department', () => {
  // Guards the escape hatch above: a homonym is only benign while the bare slug
  // is a retired in-app card (paid from bonus_catalog_applied for weeks already
  // scored) AND the HSL side never reaches the payable set under its own
  // namespace. If either stops holding, the declaration is wrong.
  for (const key of KNOWN_DISTINCT_DEPT_HOMONYMS) {
    assert.ok(
      HSL_DEPT_KEYS.includes(key as (typeof HSL_DEPT_KEYS)[number]),
      `"${key}" is declared a homonym but is not an HSL dept key — stale declaration`,
    );
    assert.ok(
      KPI_CALCULATOR_RETIRED_DEPT_KEYS.has(key),
      `"${key}" is declared a homonym but is a LIVE calculator card — a manager can score ` +
        `it into bonus_catalog_applied while HSL also pays it`,
    );
    assert.ok(
      !MANAGER_BONUS_DEPT_KEYS.includes(key),
      `"${key}" is declared a homonym but still offers a calculator card`,
    );
    assert.ok(
      !WIZARD_PAYABLE_KPI_DEPT_KEYS.has(hslAccessKey(key as (typeof HSL_DEPT_KEYS)[number])),
      `"${hslAccessKey(key as (typeof HSL_DEPT_KEYS)[number])}" is payable — the HSL side of the ` +
        `homonym has entered the payable set and IS a double-pay`,
    );
  }
});

test('isKpiCalculatorDeptKey rejects empty keys and allows unknown ones', () => {
  // An in-app (Payment Catalog -> Department) department that nobody retired
  // still gets its generic catalog-driven card.
  assert.equal(isKpiCalculatorDeptKey('some_new_inapp_dept'), true);
  assert.equal(isKpiCalculatorDeptKey(''), false);
  assert.equal(isKpiCalculatorDeptKey(null), false);
  assert.equal(isKpiCalculatorDeptKey(undefined), false);
});
