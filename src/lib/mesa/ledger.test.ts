import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  summarizeMember,
  summarizeMembers,
  type MesaLedgerEvent,
  type MesaOpenAccountRef,
} from './ledger';

// These tests pin the `lastEventOptedOut` contract that the Payroll Wizard's MESA
// deduction relies on (PayrollWizard.tsx → isMesaOptedOut / fetchMesaOptedOut). A
// person whose ledger last event is an opt-out must NOT be charged the ₱100 weekly
// contribution even when their employee_hourly_rates.mesa_member flag drifted true —
// which is exactly how Accounting's "Non Members" tab treats them. If this contract
// changes, the wizard's suppression silently changes too, so lock it here.

let nextId = 1;
function deposit(email: string, date: string): MesaLedgerEvent {
  return {
    id: nextId++,
    email,
    name: null,
    department: null,
    status: 'Active',
    worker_contribution_php: 100,
    simple_match_php: 300,
    total_daily_deposit_php: 400,
    deposit_date: date,
    disbursement_amount_php: null,
    disbursement_date: null,
    disbursement_type: null,
    notes: null,
    additional_notes: null,
  };
}

function optOut(email: string, date: string): MesaLedgerEvent {
  return {
    id: nextId++,
    email,
    name: null,
    department: null,
    status: 'Inactive',
    worker_contribution_php: null,
    simple_match_php: null,
    total_daily_deposit_php: null,
    deposit_date: null,
    disbursement_amount_php: 5000,
    disbursement_date: date,
    disbursement_type: 'Opt-out',
    notes: null,
    additional_notes: null,
  };
}

// ── summarizeMember: lastEventOptedOut ───────────────────────────────────────

test('lastEventOptedOut: false for a steady contributor (no exit)', () => {
  const s = summarizeMember([
    deposit('a@x.com', '2026-06-01'),
    deposit('a@x.com', '2026-06-08'),
  ]);
  assert.equal(s.lastEventOptedOut, false);
});

test('lastEventOptedOut: true when the trailing event is an opt-out', () => {
  const s = summarizeMember([
    deposit('a@x.com', '2026-06-01'),
    optOut('a@x.com', '2026-06-15'),
  ]);
  assert.equal(s.lastEventOptedOut, true);
});

test('lastEventOptedOut: false again after a re-join deposit dated after the opt-out', () => {
  const s = summarizeMember([
    deposit('a@x.com', '2026-06-01'),
    optOut('a@x.com', '2026-06-15'),
    deposit('a@x.com', '2026-07-01'), // re-joined → active again
  ]);
  assert.equal(s.lastEventOptedOut, false);
});

test('lastEventOptedOut: opt-out on the SAME date as the last deposit still counts as opted out', () => {
  const s = summarizeMember([
    deposit('a@x.com', '2026-06-15'),
    optOut('a@x.com', '2026-06-15'),
  ]);
  assert.equal(s.lastEventOptedOut, true);
});

// ── summarizeMembers: account-scoped re-join resets opt-out ──────────────────

test('account scoping: a fresh open account (post-opt-out re-join) resets lastEventOptedOut to false', () => {
  // Full history ends on an opt-out, but the member re-joined and their new open
  // account starts AFTER that opt-out with no events yet. The account-scoped
  // summary must present them as NOT opted out — so the wizard resumes deducting.
  const events = [
    deposit('a@x.com', '2026-06-01'),
    optOut('a@x.com', '2026-06-15'),
  ];
  const openAccounts = new Map<string, MesaOpenAccountRef>([
    ['a@x.com', { account_number: '26-07-00001', opened_on: '2026-07-01' }],
  ]);
  const [member] = summarizeMembers(events, openAccounts);
  assert.equal(member.lastEventOptedOut, false);
  assert.equal(member.balance, 0); // old account settled/"zeroed"
});

test('account scoping: opt-out inside the current account window still reads as opted out', () => {
  const events = [
    deposit('a@x.com', '2026-07-02'),
    optOut('a@x.com', '2026-07-10'),
  ];
  const openAccounts = new Map<string, MesaOpenAccountRef>([
    ['a@x.com', { account_number: '26-07-00001', opened_on: '2026-07-01' }],
  ]);
  const [member] = summarizeMembers(events, openAccounts);
  assert.equal(member.lastEventOptedOut, true);
});
