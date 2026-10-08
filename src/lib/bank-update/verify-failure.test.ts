import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { VERIFY_FAILURE_MESSAGE, verifyFailureResponse } from './verify-failure';
import { getPayrollDispatchLockGate } from '../supabase/payroll-dispatch-lock';

// Open item 266, closed 2026-10-08: (1) verify-otp told the public whether an
// address belongs to an active employee; (2) the bank saves' payroll-lock gate
// read a failed lookup as "unlocked".

// ── Class 1 + 2: one answer for every failed code ───────────────────────────

test('every verify failure answers the same body and status, whatever the reason', () => {
  const invalid = verifyFailureResponse('invalid');
  const expired = verifyFailureResponse('expired');
  const locked = verifyFailureResponse('locked');
  assert.deepEqual(invalid, expired);
  assert.deepEqual(expired, locked, 'the old "Too many incorrect attempts" text fired only for an active employee');
  assert.deepEqual(Object.keys(invalid.body), ['error'], 'no reason (or anything else) in the body');
  assert.equal(invalid.body.error, VERIFY_FAILURE_MESSAGE);
  assert.equal(invalid.status, 401);
});

const ROUTE = path.join(process.cwd(), 'app', 'api', 'bank-update', 'verify-otp', 'route.ts');
const stripComments = (src: string) => src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/.*$/gm, '$1');

test('the verify-otp route answers failures ONLY through verifyFailureResponse', () => {
  const src = stripComments(readFileSync(ROUTE, 'utf8'));
  // Negative control: the scan sees a reason-bearing response when one exists.
  assert.match('NextResponse.json({ error, reason: result.reason }, { status: 401 })', /NextResponse\.json\(\s*\{[^}]*\breason\b/);
  assert.doesNotMatch(src, /NextResponse\.json\(\s*\{[^}]*\breason\b/, 'a response body naming the reason is the oracle');
  assert.doesNotMatch(src, /Too many incorrect attempts/, 'a locked-only message is the oracle too');
  assert.match(src, /verifyFailureResponse\(result\.reason\)/);
});

// ── Class 3: an unreadable lock refuses, never reads as unlocked ────────────

test('lock gate: a failed read is UNKNOWN (refuse), never open', async () => {
  const failing = async () => {
    throw new Error('connection reset');
  };
  assert.equal(await getPayrollDispatchLockGate(failing), 'unknown');
});

test('lock gate: stored values', async () => {
  const reads = (v: string | null) => async () => v;
  assert.equal(await getPayrollDispatchLockGate(reads('true')), 'locked');
  assert.equal(await getPayrollDispatchLockGate(reads(' TRUE ')), 'locked');
  assert.equal(await getPayrollDispatchLockGate(reads('false')), 'open');
  assert.equal(await getPayrollDispatchLockGate(reads(null)), 'open', 'an absent key means the lock was never set');
});

test('both bank saves gate on the fail-closed read, and refuse unknown before writing', () => {
  for (const rel of [['app', 'api', 'bank-update', 'save', 'route.ts'], ['app', 'api', 'update-employee-ids', 'route.ts']]) {
    const src = stripComments(readFileSync(path.join(process.cwd(), ...rel), 'utf8'));
    const name = rel.join('/');
    assert.doesNotMatch(src, /getPayrollDispatchLock\(\)/, `${name} must not use the fail-open lock read`);
    assert.match(src, /getPayrollDispatchLockGate\(\)/, `${name} reads the fail-closed gate`);
    const unknown = src.indexOf('lockGate === "unknown"');
    const write = src.indexOf('.update(update)');
    assert.ok(unknown > 0 && write > unknown, `${name} refuses an unknown lock before its first write`);
    assert.match(src.slice(unknown, unknown + 400), /status: 503/, `${name} answers 503, not 423, for an unreadable lock`);
  }
});
