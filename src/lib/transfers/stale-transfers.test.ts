/**
 * Coverage for the pending-release-request staleness check that hides "already
 * moved" requests from the manager's Release queue and feeds the cron auto-cancel
 * sweep. The two loosened lenses (name fallback for email drift, department
 * match-key for label drift) must NOT weaken the conservative contract: a request
 * whose employee can't be positively located on the roster is never hidden.
 *
 * Run:  npx tsx --test src/lib/transfers/stale-transfers.test.ts
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  deptMatchKey,
  nameMatchKey,
  isStaleTransfer,
  type ActiveDeptsIndex,
} from './stale-transfers';
import type { DepartmentTransferRequestRow } from '@/lib/supabase/department-transfer-requests';

/** Minimal pending row; only the fields isStaleTransfer reads matter. */
function row(overrides: Partial<DepartmentTransferRequestRow>): DepartmentTransferRequestRow {
  return {
    id: 'r1',
    employee_email: 'jane@personal.com',
    employee_name: 'Jane Cruz',
    employee_work_email: 'jane@work.com',
    employee_personal_email: 'jane@personal.com',
    from_department: 'Callback Team',
    to_department: 'QC',
    reason: null,
    status: 'pending',
    requested_by: 'mgr@work.com',
    approver_email: null,
    approver_note: null,
    decided_at: null,
    proposed_effective_date: '2026-08-01',
    effective_date: null,
    applied_at: null,
    sheet_synced: false,
    sheet_sync_error: null,
    created_at: '2026-07-01T00:00:00Z',
    updated_at: '2026-07-01T00:00:00Z',
    ...overrides,
  };
}

/** Build an index the way loadActiveDeptsByEmail does, but from plain fixtures. */
function indexOf(
  people: Array<{ name?: string; work_email?: string; personal_email?: string; department: string }>,
): ActiveDeptsIndex {
  const byEmail = new Map<string, Set<string>>();
  const byName = new Map<string, Set<string>>();
  const add = (m: Map<string, Set<string>>, k: string, d: string) => {
    if (!k) return;
    const s = m.get(k) ?? new Set<string>();
    s.add(d);
    m.set(k, s);
  };
  for (const p of people) {
    const dept = deptMatchKey(p.department);
    add(byEmail, (p.work_email ?? '').toLowerCase(), dept);
    add(byEmail, (p.personal_email ?? '').toLowerCase(), dept);
    add(byName, nameMatchKey(p.name), dept);
  }
  return { byEmail, byName };
}

// ── deptMatchKey ──────────────────────────────────────────────────────────────

test('deptMatchKey collapses known synonyms to one key', () => {
  assert.equal(deptMatchKey('Callback Team'), deptMatchKey('Callbacks'));
  assert.equal(deptMatchKey('Callback Team'), deptMatchKey('callback'));
  assert.equal(deptMatchKey('AI & API Team'), deptMatchKey('devs'));
});

test('deptMatchKey falls back to raw lowercase for unknown/custom departments', () => {
  assert.equal(deptMatchKey('My Custom Dept'), 'my custom dept');
  assert.equal(deptMatchKey('  Growth Pod  '), 'growth pod');
  assert.notEqual(deptMatchKey('Custom A'), deptMatchKey('Custom B'));
});

test('deptMatchKey is empty for blank/nullish', () => {
  assert.equal(deptMatchKey(''), '');
  assert.equal(deptMatchKey(null), '');
  assert.equal(deptMatchKey('   '), '');
});

test('deptMatchKey symmetry: same team compares equal, different teams do not', () => {
  const sameTeam: [string, string][] = [
    ['Callback Team', 'Callbacks'],
    ['Callback Team', 'callback'],
    ['AI & API Team', 'devs'],
    ['AI/API Team', 'devs'],
    ['Accounting', 'Accounting Team'],
    ['Smart Staff', 'SmartClicks/Sterling'],
    ['Smart Staff', 'Smartclicks'],
    ['Growth Pod', 'growth pod'], // custom dept: raw-lowercase fallback
  ];
  for (const [a, b] of sameTeam) {
    assert.equal(deptMatchKey(a), deptMatchKey(b), `expected same team: "${a}" vs "${b}"`);
  }
  const diffTeam: [string, string][] = [
    ['Callback Team', 'Callback Squad'], // "Squad" variant not in synonym map
    ['devs', 'AI Team'], // "AI Team" not in synonym map -> raw
    ['Growth Pod', 'Growth Team'], // two distinct custom depts
  ];
  for (const [a, b] of diffTeam) {
    assert.notEqual(deptMatchKey(a), deptMatchKey(b), `expected different teams: "${a}" vs "${b}"`);
  }
});

// ── core staleness ──────────────────────────────────────────────────────────

test('still in source dept -> NOT stale', () => {
  const idx = indexOf([{ name: 'Jane Cruz', work_email: 'jane@work.com', department: 'Callback Team' }]);
  assert.equal(isStaleTransfer(row({}), idx), false);
});

test('moved out of source dept (by email) -> stale', () => {
  const idx = indexOf([{ name: 'Jane Cruz', work_email: 'jane@work.com', department: 'QC' }]);
  assert.equal(isStaleTransfer(row({}), idx), true);
});

test('not on roster by any email or name -> ambiguous -> NOT stale', () => {
  const idx = indexOf([{ name: 'Someone Else', work_email: 'other@work.com', department: 'QC' }]);
  assert.equal(isStaleTransfer(row({}), idx), false);
});

// ── loosened lens 1: department LABEL drift ──────────────────────────────────

test('source label "Callback Team" vs roster "Callbacks" (same team) -> NOT stale', () => {
  // Before the fix, the raw-string compare treated these as different depts and
  // wrongly kept the request. They are the same team, so the person is still in
  // source and the request must remain live (NOT stale).
  const idx = indexOf([{ name: 'Jane Cruz', work_email: 'jane@work.com', department: 'Callbacks' }]);
  assert.equal(isStaleTransfer(row({ from_department: 'Callback Team' }), idx), false);
});

test('label drift does not mask a genuine move-out', () => {
  // Request from "callback"; person now in QC. Still stale despite label variance.
  const idx = indexOf([{ name: 'Jane Cruz', work_email: 'jane@work.com', department: 'QC' }]);
  assert.equal(isStaleTransfer(row({ from_department: 'callback' }), idx), true);
});

// ── loosened lens 2: email drift, name fallback ──────────────────────────────

test('email drifted but name matches and moved out -> stale', () => {
  // The request carries jane@work.com; the roster row has a recycled/changed work
  // email. Email lookup misses, name fallback locates her in QC -> stale.
  const idx = indexOf([{ name: 'Jane Cruz', work_email: 'newjane@work.com', department: 'QC' }]);
  assert.equal(isStaleTransfer(row({}), idx), true);
});

test('email drifted, name matches, STILL in source -> NOT stale', () => {
  const idx = indexOf([{ name: 'Jane Cruz', work_email: 'newjane@work.com', department: 'Callback Team' }]);
  assert.equal(isStaleTransfer(row({}), idx), false);
});

test('name fallback is case/whitespace insensitive', () => {
  const idx = indexOf([{ name: '  jane   cruz ', work_email: 'x@x.com', department: 'QC' }]);
  assert.equal(isStaleTransfer(row({ employee_name: 'Jane Cruz' }), idx), true);
});

test('email match wins; name fallback is NOT consulted when an email hits', () => {
  // Email locates Jane still in source (Callback Team). A same-name homonym sits
  // in QC. Because an email matched, the name lens is skipped and we trust the
  // email dept set -> NOT stale (no false positive from a name collision).
  const idx = indexOf([
    { name: 'Jane Cruz', work_email: 'jane@work.com', department: 'Callback Team' },
    { name: 'Jane Cruz', work_email: 'homonym@work.com', department: 'QC' },
  ]);
  assert.equal(isStaleTransfer(row({}), idx), false);
});

test('no name on request + email miss -> ambiguous -> NOT stale', () => {
  // Guards the fallback: an empty name must not match an empty-keyed roster entry.
  const idx = indexOf([{ name: '', work_email: 'other@work.com', department: 'QC' }]);
  assert.equal(isStaleTransfer(row({ employee_name: null, employee_work_email: 'x@x.com', employee_personal_email: null, employee_email: 'x@x.com' }), idx), false);
});

test('blank from_department -> NOT stale (nothing to compare)', () => {
  const idx = indexOf([{ name: 'Jane Cruz', work_email: 'jane@work.com', department: 'QC' }]);
  assert.equal(isStaleTransfer(row({ from_department: '' }), idx), false);
});

test('person holding rows in BOTH source and target -> NOT stale', () => {
  // Multi-dept human: still on the source team (plus target). Releasing is still
  // meaningful, so must remain live.
  const idx = indexOf([
    { name: 'Jane Cruz', work_email: 'jane@work.com', department: 'Callback Team' },
    { name: 'Jane Cruz', personal_email: 'jane@personal.com', department: 'QC' },
  ]);
  assert.equal(isStaleTransfer(row({}), idx), false);
});
