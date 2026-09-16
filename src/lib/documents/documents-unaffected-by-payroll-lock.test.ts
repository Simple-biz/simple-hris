/**
 * Documents are NEVER gated on the payroll "Start processing" lock.
 *
 * Kane, 2026-09-16: *"while Payroll is processing we should still be able to
 * create Termination Letters and COE's ... we dont want to delay Documents."*
 *
 * A Certificate of Engagement and a Termination Letter are paperwork a person
 * needs for a bank, a visa or a new employer, and none of it moves money or
 * shifts a figure the payroll run is about to pay. The KPI/QC lock exists to
 * stop *scores* changing under an in-flight run (see
 * `src/lib/payroll/processing-guard.ts`) — extending it here would delay a
 * document for a reason that does not apply to it.
 *
 * This was already true when Kane asked: the sweep found zero gating. These
 * scans exist so it STAYS true — the guarantee was previously implicit, held up
 * only by nobody having wired the lock in, which is not a guarantee at all.
 *
 * Note what is deliberately NOT asserted: nothing here says the COE may be
 * issued freely. `decideCoeActiveGate` still fails closed, the signature gate
 * still answers 412, and a second pending COE is still a 409. Those refusals
 * are the feature working. The only thing pinned is that PAYROLL STATE is not
 * one of the inputs.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

const ROOT = process.cwd();
const rel = (f: string) => path.relative(ROOT, f).replace(/\\/g, '/');

/** Every surface that creates, previews, signs or lists a document. */
const DOCUMENT_SOURCES = [
  // Accounting → Documents (the host tab, the termination panel, its rules)
  'src/components/accounting/AccountingDocuments.tsx',
  'src/components/accounting/termination-docs/TerminationDocsPanel.tsx',
  'src/components/accounting/termination-docs/TerminationDocsTabRow.tsx',
  // Employee dashboard → Documents
  'src/components/employee/RequestDocumentsTab.tsx',
  // The shared resolvers + writers behind both
  'src/lib/documents/requests.ts',
  'src/lib/documents/coe-facts.ts',
  'src/lib/documents/coe-admin.ts',
];

/** Every route that answers a document request. */
const DOCUMENT_ROUTES = [
  'app/api/accounting/documents/route.ts',
  'app/api/accounting/documents/[id]/route.ts',
  'app/api/accounting/documents/coe/route.ts',
  'app/api/accounting/documents/coe/preview/route.ts',
  'app/api/accounting/documents/coe/search/route.ts',
  'app/api/accounting/documents/signature/route.ts',
  'app/api/accounting/documents/termination/route.ts',
  'app/api/accounting/documents/termination/[id]/route.ts',
  'app/api/accounting/documents/termination/facts/route.ts',
  'app/api/accounting/documents/termination/search/route.ts',
  'app/api/employee/documents/route.ts',
  'app/api/employee/documents/[id]/route.ts',
];

/** Anything that reads or reacts to `payroll.dispatch_locked`. */
const LOCK_TOKENS = [
  'useDispatchLock',
  'rejectWhilePayrollProcessing',
  'getPayrollDispatchLock',
  'dispatch_locked',
  'PayrollProcessingLock',
  'payrollLocked',
];

test('the listed document sources and routes all exist — a rename must update this scan, not silently empty it', () => {
  for (const f of [...DOCUMENT_SOURCES, ...DOCUMENT_ROUTES]) {
    assert.ok(
      fs.existsSync(path.join(ROOT, f)),
      `${f} is gone or moved — re-point this scan at its new home rather than dropping the entry`,
    );
  }
});

test('no document component or resolver reads the payroll processing lock', () => {
  for (const f of DOCUMENT_SOURCES) {
    const src = fs.readFileSync(path.join(ROOT, f), 'utf8');
    for (const token of LOCK_TOKENS) {
      assert.ok(
        !src.includes(token),
        `${f} references ${token} — Termination Letters and COEs must stay creatable while payroll is processing`,
      );
    }
  }
});

test('no document route is gated on the payroll processing lock', () => {
  for (const f of DOCUMENT_ROUTES) {
    const src = fs.readFileSync(path.join(ROOT, f), 'utf8');
    for (const token of LOCK_TOKENS) {
      assert.ok(
        !src.includes(token),
        `${f} references ${token} — a document request must not be refused because payroll is running`,
      );
    }
  }
});

test('RequestDocumentsTab is not handed a payrollLocked prop by its host', () => {
  // EmployeeProfile DOES receive `payrollLocked` and uses it correctly — the
  // Payment section's bank fields go read-only mid-run, which is a real money
  // path. The risk is that prop being threaded one level further into the
  // Documents tab that sits in the same component.
  const profile = fs.readFileSync(path.join(ROOT, 'src/components/employee/EmployeeProfile.tsx'), 'utf8');
  const mount = profile.indexOf('<RequestDocumentsTab');
  assert.ok(mount > 0, 'RequestDocumentsTab is no longer mounted in EmployeeProfile — re-point this scan');
  const close = profile.indexOf('/>', mount);
  assert.ok(close > mount, 'could not find the end of the RequestDocumentsTab element');
  const props = profile.slice(mount, close);
  assert.ok(
    !/payrollLocked/.test(props),
    'EmployeeProfile threads payrollLocked into RequestDocumentsTab — document requests are not a money path and must not be locked',
  );
});

test('rejectWhilePayrollProcessing guards score/rate writes only — adding a caller is a deliberate act', () => {
  // The guard's own header scopes it to "every KPI/QC score mutation", and
  // every caller below is a score, rate or bonus write — a figure the in-flight
  // run is about to pay. If a new caller appears, this test names it so the
  // author has to confirm the surface genuinely moves such a figure, and above
  // all that it is not a documents route. A document states a fact about the
  // past; it never changes what payroll owes.
  const callers = walk(path.join(ROOT, 'src'))
    .concat(walk(path.join(ROOT, 'app')))
    .filter((f) => /\.(ts|tsx)$/.test(f) && !/\.test\.tsx?$/.test(f))
    .filter((f) => !rel(f).endsWith('src/lib/payroll/processing-guard.ts'))
    .filter((f) => /rejectWhilePayrollProcessing/.test(fs.readFileSync(f, 'utf8')))
    .map(rel)
    .sort();
  assert.deepEqual(callers, [
    'app/api/bonus-catalog-applied/route.ts',
    'app/api/hsl-bonus/entries/route.ts',
    'app/api/hsl-bonus/period-status/route.ts',
    'app/api/hubstaff-hours/route.ts',
    'app/api/payment-catalog/pay-structures/route.ts',
    'app/api/qc/compare-paste/route.ts',
    'app/api/qc/lock/route.ts',
    'app/api/qc/review/route.ts',
    'app/api/qc/submissions/route.ts',
    'app/api/update-employee-rates/route.ts',
  ]);
  // The load-bearing half: not one of them is a documents route.
  for (const c of callers) {
    assert.ok(!/\/documents\//.test(c), `${c} gates a documents path on payroll state`);
  }
});

function walk(dir: string): string[] {
  const out: string[] = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (entry.name === 'node_modules' || entry.name.startsWith('.')) continue;
    const p = path.join(dir, entry.name);
    if (entry.isDirectory()) out.push(...walk(p));
    else out.push(p);
  }
  return out;
}
