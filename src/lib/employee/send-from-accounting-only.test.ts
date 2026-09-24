import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

// THE SENDING BANK IS ACCOUNTING'S (Kane, 2026-09-24): "let us deprecate the
// feature that the Employee can choose a sending bank and that it would pop up
// in accounting under the issues Section - all changes for the sending bank
// should be here only in accounting and accounting will the only one who will be
// responsible for changing it".
//
// These pin the retirement at the source, because nothing else would notice it
// coming back: the employee pick, the approval rows and their routes were a
// working feature, so re-adding any piece compiles and runs. The pure halves
// (`isBankPreferredChange`, `sendFromMismatch`) are unit-tested in
// employee-payment-processors.test.ts. See bank-preferred-routing.md §1 and §3.

/** A file's CODE: comments removed, so a tombstone that names the retired pieces
 *  (kept on purpose, so a grep for them lands on the reason) cannot trip a scan.
 *  Deliberately narrow: a block comment must open at a line start, after
 *  whitespace or after `{` (so `accept="image/*"` is not one), and a line comment
 *  after whitespace (so `https://` is not one). */
const read = (rel: string) =>
  readFileSync(join(process.cwd(), rel), 'utf8')
    .replace(/(^|[\s{])\/\*[\s\S]*?\*\//g, '$1')
    .replace(/(^|\s)\/\/.*$/gm, '$1');

/** An object key named bank_preferred — a request body or an update payload.
 *  Preceded by whitespace, `{` or `,` so prose like "the stored `bank_preferred`:"
 *  in a comment does not count. */
const BANK_PREFERRED_KEY = /(^|[\s{,])["']?bank_preferred["']?\s*:/m;

test('the approval routes and their data layer are gone', () => {
  assert.equal(existsSync(join(process.cwd(), 'app/api/bank-preferred-requests')), false);
  assert.equal(existsSync(join(process.cwd(), 'src/lib/supabase/bank-preferred-requests.ts')), false);
});

test('Employee Profile never sends, picks or badges a sending bank', () => {
  const src = read('src/components/employee/EmployeeProfile.tsx');
  assert.ok(!BANK_PREFERRED_KEY.test(src), 'the payout save must not carry bank_preferred');
  assert.ok(!src.includes('/api/bank-preferred-requests'), 'no pending-approval badge read');
  assert.ok(!/aria-label="Bank Preferred"/.test(src), 'no sending-bank picker');
  assert.ok(!/selectableBankPreferredOptions|mirroredBankPreferredFor/.test(src), 'no send-from options or in-form mirror');
});

test('update-employee-ids cannot write a sending bank, and refuses a change out loud', () => {
  const src = read('app/api/update-employee-ids/route.ts');
  const allowed = src.match(/const allowed = \[([\s\S]*?)\];/);
  assert.ok(allowed, 'the allowlist moved — re-point this test, do not delete it');
  assert.ok(!/["']bank_preferred["']/.test(allowed[1]), 'bank_preferred must not be on the write allowlist');
  assert.ok(!/update\.bank_preferred\s*=|update\[["']bank_preferred["']\]\s*=/.test(src), 'nothing may inject it into the write');
  assert.ok(/isBankPreferredChange\(fields\.bank_preferred/.test(src), 'a posted change must be judged, not dropped');
  assert.ok(/status: 403/.test(src), 'the refusal is a 403');
  assert.ok(!/bank_preferred_change_requests|createBankPreferredRequest|interceptBankPreferred\(/.test(src), 'no request is filed');
});

test('the OTP bank page route cannot write a sending bank either', () => {
  const src = read('app/api/bank-update/save/route.ts');
  const allowed = src.match(/const ALLOWED_FIELDS = \[([\s\S]*?)\];/);
  assert.ok(allowed, 'the allowlist moved — re-point this test, do not delete it');
  assert.ok(!/["']bank_preferred["']/.test(allowed[1]));
});

test('Accounting → Issues carries no sending-bank rows', () => {
  const src = read('src/components/payroll/PabDisputeQueue.tsx');
  assert.ok(!src.includes('/api/bank-preferred-requests'));
  assert.ok(!/kind:\s*['"]bank['"]/.test(src), 'IssueRow has no bank kind');
});

test("People → Banking is still the sending bank's one write path", () => {
  // The other half of the rule: retiring the employee side must never cost
  // Accounting its edit.
  const src = read('app/api/people/[email]/banking/route.ts');
  assert.ok(/['"]bank_preferred['"]/.test(src), 'People → Banking must keep accepting bank_preferred');
  assert.ok(/isBankPreferredAllowedForReceiving\(/.test(src), 'and keep enforcing the 1:1 rule where it is set');
});
