/**
 * buildCatalogExport — the CSV/XLSX/PDF model behind Payment Catalog → Export.
 *
 * The load-bearing property pinned here: a department-scope rate row is exported
 * ONLY if its `departmentKey` appears in the `departments` list the caller passes.
 * When the Pay Structure rail learned to set HSL sub-team rates (`hsl:<key>`), the
 * export's list still held only DEPARTMENTS + custom registry entries — so a
 * sub-team's base rate was silently ABSENT from an Accounting export. Not a
 * cosmetic gap: a missing rate row reads as "no rate set".
 *
 * Run:  npx tsx --test src/lib/payment-catalog/catalog-export.test.ts
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildCatalogExport } from './catalog-export';
import type { PayStructure } from './pay-structure';
import { DEPARTMENTS } from '@/lib/payroll/department-bonus';
import { hslSubDeptOptions } from '@/lib/departments/hsl-subdept';

const SUB_RATE: PayStructure = {
  id: 'dept-hsl-intake',
  scope: 'department',
  departmentKey: 'hsl:intake_specialist',
  regularRate: 260,
  otRate: 390,
  currency: 'PHP',
};

/** Exactly the list BonusCatalog.tsx hands the export builder. */
const deptListWithSubs = () => [
  ...DEPARTMENTS.map((d) => ({ key: d.key, name: d.name })),
  ...hslSubDeptOptions().map((o) => ({ key: o.value, name: o.label })),
];

/** The pre-fix list — kept as a regression witness, not as a supported shape. */
const deptListWithoutSubs = () => DEPARTMENTS.map((d) => ({ key: d.key, name: d.name }));

function build(departments: { key: string; name: string }[]) {
  return buildCatalogExport({
    payStructures: [SUB_RATE],
    bonuses: [],
    assignments: [],
    departments,
    generatedAt: new Date(0),
  } as Parameters<typeof buildCatalogExport>[0]);
}

test('an HSL sub-team base rate reaches the export under its display name', () => {
  const model = build(deptListWithSubs());
  const block = model.departments.find((d) => d.name === 'HSL — Intake Specialist');
  assert.ok(block, 'the sub-team must have its own export block');
  assert.ok(
    JSON.stringify(block).includes('260'),
    'the sub-team block must carry its regular rate',
  );
  // It must NOT be reported as a department with nothing configured.
  assert.equal(
    model.emptyDepartments.includes('HSL — Intake Specialist'),
    false,
    'a sub-team WITH a rate must never land in emptyDepartments',
  );
});

test('regression witness: omit the sub-teams and the rate row vanishes silently', () => {
  const model = build(deptListWithoutSubs());
  // The only configured rate in the catalog is the sub-team's, and with the
  // pre-fix department list the export contains NO block at all — every built-in
  // is reported "empty" and the one real rate is nowhere. No error, no warning:
  // an accountant reads it as "no rates configured".
  assert.equal(
    model.departments.some((d) => JSON.stringify(d).includes('260')),
    false,
    'the sub-team rate is absent from every block',
  );
  assert.equal(model.departments.length, 0, 'the export "succeeds" while carrying nothing');
  assert.ok(
    model.emptyDepartments.length > 0,
    'and it confidently lists departments as having nothing set',
  );
});

test('every sub-team the rail can set a rate on is exportable', () => {
  const keys = new Set(deptListWithSubs().map((d) => d.key));
  for (const o of hslSubDeptOptions()) {
    assert.ok(keys.has(o.value), `${o.value} must be exportable`);
  }
});
