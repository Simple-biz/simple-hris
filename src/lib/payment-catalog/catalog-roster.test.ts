import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  CATALOG_ROSTER_FIELDS,
  parseCatalogRosterResponse,
  toCatalogRosterRows,
} from './catalog-roster';
import type { EmployeeRow } from '@/lib/supabase/employees';

const row = (over: Partial<EmployeeRow> = {}): EmployeeRow => ({
  employee_id: 'E1',
  department: 'hsl:healthcare_specialist',
  name: 'Aireen P',
  personal_email: 'a@gmail.com',
  work_email: 'aireenp@simple.biz',
  start_date: '2026-09-14',
  hourlyRate: 3.5,
  bankInfo: { accountName: 'A', accountNumber: '0001234', bankName: 'BDO', routingNumber: '9' },
  ...over,
});

test('projection carries exactly the four catalog fields — never bank info or rate', () => {
  const [out] = toCatalogRosterRows([row()]);
  assert.deepEqual(Object.keys(out!).sort(), [...CATALOG_ROSTER_FIELDS].sort());
  assert.equal(JSON.stringify(out).includes('0001234'), false);
  assert.equal(out!.department, 'hsl:healthcare_specialist');
});

test('a well-formed response parses, lower-casing the off-board set', () => {
  const parsed = parseCatalogRosterResponse({
    employees: toCatalogRosterRows([row()]),
    catalogOffboardedEmails: [' Gone@Simple.biz '],
    error: null,
    offboardedError: null,
  });
  assert.equal(parsed?.employees.length, 1);
  assert.deepEqual(parsed?.catalogOffboardedEmails, ['gone@simple.biz']);
});

test('a failed or malformed read returns null so the caller keeps its prior roster', () => {
  assert.equal(parseCatalogRosterResponse(null), null);
  assert.equal(parseCatalogRosterResponse('<html>'), null);
  assert.equal(parseCatalogRosterResponse({ employees: [], catalogOffboardedEmails: [], error: 'boom' }), null);
  assert.equal(parseCatalogRosterResponse({ employees: 'x', catalogOffboardedEmails: [] }), null);
  assert.equal(parseCatalogRosterResponse({ employees: [row()] }), null);
  assert.equal(parseCatalogRosterResponse({ employees: [null], catalogOffboardedEmails: [] }), null);
});

test('a "successful" read with zero people is refused — it would zero every headcount', () => {
  assert.equal(
    parseCatalogRosterResponse({ employees: [], catalogOffboardedEmails: [], error: null }),
    null,
  );
});

test('an off-board evidence failure still delivers the roster (hide nobody)', () => {
  const parsed = parseCatalogRosterResponse({
    employees: toCatalogRosterRows([row()]),
    catalogOffboardedEmails: [],
    error: null,
    offboardedError: 'Off-board evidence could not be read — nobody was hidden',
  });
  assert.equal(parsed?.employees.length, 1);
  assert.deepEqual(parsed?.catalogOffboardedEmails, []);
});
