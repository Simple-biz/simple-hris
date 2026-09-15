import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

/**
 * Wiring guards for the Payroll Notes -> Offboarded tab's COMPLETE-OVERRIDE
 * fixers (2026-09-15). The behavioural rules are proven in their pure modules
 * (`rate-override.test.ts`, `bank-override-patch.test.ts`,
 * `offboarded-bank-current.test.ts`); these source scans pin the wiring that
 * cannot be unit-tested from Node - the same shape as
 * `setrate-effective-date.test.ts`.
 *
 * The failure classes this file keeps closed:
 *   1. the Offboarded tab silently reverting to the locked-rail Set bank
 *   2. the Readiness Bank Info tab silently GAINING the override (its lock is a
 *      documented rule - payroll-readiness.md)
 *   3. the catalog route applying the override to the Payment Catalog editor
 *   4. a rate save that no longer tells the wizard to re-pull its rate sources
 *   5. the wizard forgetting catalog-only leavers again
 *   6. a full account number reaching the Offboarded payload
 */

const read = (rel: string) => fs.readFileSync(path.join(process.cwd(), rel), 'utf8');
const FAB = read('src/components/accounting/PayrollWizardNotesFab.tsx');
const BANK_DIALOG = read('src/components/accounting/SetBankDialog.tsx');
const ROUTE = read('app/api/payment-catalog/pay-structures/route.ts');
const WIZARD = read('src/components/PayrollWizard.tsx');
const CANDIDATES = read('src/lib/payroll/offboarded-payroll-candidates.ts');
const PEOPLE_OFFBOARDED = read('src/components/people/PeopleOffboarded.tsx');
const BANK_CURRENT = read('src/lib/payroll/offboarded-bank-current.ts');

function sliceFrom(src: string, marker: string, len: number): string {
  const i = src.indexOf(marker);
  assert.ok(i >= 0, `marker not found: ${marker}`);
  return src.slice(i, i + len);
}

// ── 1 + 2: override is the Offboarded tab's, and ONLY the Offboarded tab's ──

test('the Offboarded pane mounts SetBankDialog in override mode with the masked readout', () => {
  const pane = sliceFrom(FAB, 'function OffboardedGlance(', 40_000);
  assert.match(pane, /<SetBankDialog[\s\S]*?\boverride\b[\s\S]*?current=\{bankCurrent\}/);
});

test('the Readiness Bank Info pane keeps the locked-rail dialog (no override prop)', () => {
  const glanceStart = FAB.indexOf('function PayrollReadinessGlance(');
  const offboardedStart = FAB.indexOf('function OffboardedGlance(');
  assert.ok(glanceStart >= 0 && offboardedStart > glanceStart);
  const readiness = FAB.slice(glanceStart, offboardedStart);
  const bankUses = readiness.match(/<SetBankDialog[\s\S]*?\/>/g) ?? [];
  assert.equal(bankUses.length, 1, 'exactly one Set bank mount in the Readiness pane');
  assert.ok(!/\boverride\b/.test(bankUses[0]), 'Bank Info must never pass override - its lock is a documented rule');
});

test('the People -> Offboarded tab also keeps the default dialog', () => {
  const use = PEOPLE_OFFBOARDED.match(/<SetBankDialog[\s\S]*?\/>/)?.[0] ?? '';
  assert.ok(use.length > 0);
  assert.ok(!/\boverride\b/.test(use));
});

test('SetBankDialog defaults override OFF and only override saves through the People banking PATCH', () => {
  assert.match(BANK_DIALOG, /override = false,/);
  assert.match(BANK_DIALOG, /const locked = !override && lockedProcessor !== '';/, 'a resolved rail still locks the default mode');
  const overrideSave = sliceFrom(BANK_DIALOG, 'const saveOverride = async () => {', 2_500);
  assert.match(overrideSave, /\/api\/people\/\$\{encodeURIComponent\(email\)\}\/banking/);
  assert.match(overrideSave, /method: 'PATCH'/);
  assert.match(overrideSave, /buildBankOverridePatch\(/, 'the patch is built by the pure module, never hand-assembled');
  const defaultSave = sliceFrom(BANK_DIALOG, 'const save = async () => {', 3_500);
  assert.match(defaultSave, /\/api\/update-employee-ids/);
  assert.ok(!/body\.bank_preferred|bank_preferred:/.test(defaultSave), 'the default mode never writes the send-from rail');
});

// ── 3: the catalog route's override is gated on the fixer source ─────────────

test('the pay-structures route applies the complete override ONLY for the Readiness source', () => {
  assert.match(ROUTE, /const isFixerOverride = s\.scope === 'employee' && source === READINESS_SOURCE;/);
  assert.match(ROUTE, /shadowEmployeeStructures\(s\.employeeEmail, row\.id, mine\)/);
  assert.match(ROUTE, /historySupersedeFloor\(todayIso, effectiveIso\)/);
  // The Payment Catalog editor keeps the documented clause byte-for-byte.
  assert.match(ROUTE, /\.or\(`effective_from\.gte\.\$\{todayIso\},effective_from\.eq\.\$\{effectiveIso\}`\)/);
  // The override is AWAITED so a failed history write is heard, not logged.
  assert.match(ROUTE, /await syncRateHistory\(s, actor, source, body\.effectiveDate \?\? undefined, true\)/);
});

test('retired structures are named in the audit row', () => {
  assert.match(ROUTE, /superseded_structures: isFixerOverride \? supersededStructures : undefined/);
});

// ── 4: the fixer announces the change and the wizard listens ─────────────────

test('a successful Set rate dispatches RATES_CHANGED_EVENT and the wizard re-pulls all three rate sources', () => {
  assert.match(FAB, /new CustomEvent\(RATES_CHANGED_EVENT/);
  const listener = sliceFrom(WIZARD, 'const onRatesChanged = () => {', 400);
  assert.match(listener, /loadPayStructures\(\)/);
  assert.match(listener, /loadEmployeeHourlyRates\(\)/);
  assert.match(listener, /loadRateHistory\(\)/);
  assert.match(WIZARD, /window\.addEventListener\(RATES_CHANGED_EVENT, onRatesChanged\)/);
});

// ── 5: catalog-only leavers are priced by the wizard ─────────────────────────

test('the wizard synthesizes catalog rates for leavers from the final-pay overlay, has()-guarded', () => {
  const block = sliceFrom(WIZARD, '// 3) Catalog-only LEAVERS.', 2_400);
  assert.match(block, /for \(const r of offboardedRoster\)/);
  assert.match(block, /if \(emails\.some\(\(em\) => idx\.has\(em\)\)\) continue;/, 'an overlay row can never move an active rate');
  assert.match(WIZARD, /\}, \[hourlyRateRows, masterEmployees, offboardedRoster, payStructures, isReplay, fxRates\]\);/);
});

// ── 6: the payload carries a MASKED readout and the payable identity ─────────

test('the Offboarded payload is masked on the server and keys Set rate to the hours-carrying email', () => {
  assert.match(CANDIDATES, /readOffboardedBankCurrent\(idRow, extras\)/);
  // The readout type has a MASKED account field and no raw one - the payload
  // is readable on the wizard VIEW grant.
  assert.match(BANK_CURRENT, /accountNumberMasked: string \| null;/);
  assert.ok(!/^\s+accountNumber: /m.test(BANK_CURRENT), 'the live readout never carries a raw account number');
  assert.match(BANK_CURRENT, /maskFieldValue\('account_number'/);
  assert.match(CANDIDATES, /rateWriteEmail: rateWriteEmail\(person\.hubstaff_email, person\.work_email, person\.personal_email\)/);
  const pane = sliceFrom(FAB, 'function OffboardedGlance(', 40_000);
  assert.match(pane, /email: r\.rateWriteEmail,/);
  assert.match(pane, /disabled=\{!r\.rateWriteEmail\}/);
});

test('both dialogs show what is currently on file', () => {
  assert.match(FAB, /data-testid="setrate-current"/);
  assert.match(BANK_DIALOG, /data-testid="setbank-current"/);
});
