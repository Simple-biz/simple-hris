/**
 * Mid-week transfer disclosure — the "Lead Gen to HSL" label under the paystub
 * Department. Every case below is a shape that exists in production
 * (`department_transfer_requests`, probed 2026-08-25: 282 applied/approved
 * rows, 277 of 281 dated ones effective on a NON-Sunday, five people-weeks
 * carrying two legs).
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  buildTransferLegsByEmail,
  transferLegsInWeek,
  transferBlockForWeek,
  parseTransferBlock,
  formatTransferLabel,
  type TransferLegRowLike,
} from './department-transfer-legs';

const row = (o: Partial<TransferLegRowLike>): TransferLegRowLike => ({
  employee_email: null,
  employee_work_email: null,
  from_department: 'Lead Gen',
  to_department: 'HSL',
  effective_date: '2026-08-13',
  status: 'applied',
  ...o,
});

// ── buildTransferLegsByEmail ────────────────────────────────────────────────

test('APPLIED only — an `approved` row whose apply failed never moved the label', () => {
  // Narrower than buildHslTransferEffectiveMap on purpose. Live 2026-08-25: 276
  // applied, 6 approved — and all 6 have a NULL applied_at, i.e. the master row
  // was never written. Disclosing one would print "Lead Gen to HSL" under a
  // Department line that still reads Lead Gen. Never widen this to match the
  // premium map: they answer different questions.
  const m = buildTransferLegsByEmail([
    row({ employee_work_email: 'a@simple.biz', status: 'applied' }),
    row({ employee_work_email: 'b@simple.biz', status: 'approved' }),
    row({ employee_work_email: 'c@simple.biz', status: 'pending' }),
    row({ employee_work_email: 'd@simple.biz', status: 'rejected' }),
    row({ employee_work_email: 'e@simple.biz', status: 'cancelled' }),
  ]);
  assert.deepEqual([...m.keys()].sort(), ['a@simple.biz']);
});

test('keys on BOTH employee_email and employee_work_email, lowercased', () => {
  const m = buildTransferLegsByEmail([
    row({ employee_email: 'Ray.C@Gmail.com', employee_work_email: ' RaymandC@Simple.biz ' }),
  ]);
  assert.deepEqual([...m.keys()].sort(), ['ray.c@gmail.com', 'raymandc@simple.biz']);
  assert.equal(m.get('raymandc@simple.biz')?.length, 1);
});

test('the same move under two emails is ONE leg, not two', () => {
  const m = buildTransferLegsByEmail([
    row({ employee_email: 'x@gmail.com', employee_work_email: 'x@simple.biz' }),
    // A duplicated row (re-created request, same move) must not double up.
    row({ employee_email: 'x@gmail.com', employee_work_email: 'x@simple.biz' }),
  ]);
  assert.equal(m.get('x@simple.biz')?.length, 1);
  assert.equal(m.get('x@gmail.com')?.length, 1);
});

test('rows with a blank side, or an undatable effective_date, are dropped', () => {
  const m = buildTransferLegsByEmail([
    row({ employee_work_email: 'a@simple.biz', from_department: '  ' }),
    row({ employee_work_email: 'b@simple.biz', to_department: null }),
    row({ employee_work_email: 'c@simple.biz', effective_date: null }),
    row({ employee_work_email: 'd@simple.biz', effective_date: 'later' }),
    row({ employee_work_email: 'e@simple.biz', effective_date: '2026-08-13T00:00:00Z' }),
  ]);
  assert.deepEqual([...m.keys()], ['e@simple.biz']);
  assert.equal(m.get('e@simple.biz')?.[0].effective_date, '2026-08-13');
});

test('legs come back in week order, and the order is stable across rebuilds', () => {
  const rows = [
    row({ employee_work_email: 'r@simple.biz', from_department: 'HSL', to_department: 'Lead Gen', effective_date: '2026-08-13' }),
    row({ employee_work_email: 'r@simple.biz', from_department: 'Lead Gen', to_department: 'HSL', effective_date: '2026-08-11' }),
  ];
  const a = buildTransferLegsByEmail(rows).get('r@simple.biz');
  const b = buildTransferLegsByEmail([...rows].reverse()).get('r@simple.biz');
  assert.deepEqual(a?.map((l) => l.effective_date), ['2026-08-11', '2026-08-13']);
  assert.deepEqual(a, b);
});

test('an intra-HSL sub-team reshuffle IS kept (unlike the into-HSL premium map)', () => {
  // buildHslTransferEffectiveMap skips these — a reshuffle is not an ARRIVAL,
  // which is a question about the weekend premium. Disclosure is a different
  // question: the person really did change teams.
  const m = buildTransferLegsByEmail([
    row({ employee_work_email: 'k@simple.biz', from_department: 'HSL', to_department: 'hsl:case_managers' }),
  ]);
  assert.equal(m.get('k@simple.biz')?.length, 1);
});

// ── transferLegsInWeek ──────────────────────────────────────────────────────

const LEGS = [
  { from: 'Lead Gen', to: 'HSL', effective_date: '2026-08-11' },
  { from: 'HSL', to: 'Lead Gen', effective_date: '2026-08-13' },
  { from: 'Lead Gen', to: 'Client VA', effective_date: '2026-09-02' },
];

test('week bounds are INCLUSIVE on both ends', () => {
  assert.equal(transferLegsInWeek(LEGS, '2026-08-11', '2026-08-13').length, 2);
  assert.equal(transferLegsInWeek(LEGS, '2026-08-12', '2026-08-13').length, 1);
  assert.equal(transferLegsInWeek(LEGS, '2026-08-11', '2026-08-12').length, 1);
});

test('a transfer before or after the week is not this week\'s disclosure', () => {
  assert.deepEqual(transferLegsInWeek(LEGS, '2026-08-16', '2026-08-22'), []);
  assert.deepEqual(transferLegsInWeek(LEGS, '2026-08-02', '2026-08-08'), []);
});

test('a missing or malformed week yields no legs — never a partial guess', () => {
  assert.deepEqual(transferLegsInWeek(LEGS, null, '2026-08-13'), []);
  assert.deepEqual(transferLegsInWeek(LEGS, '2026-08-09', undefined), []);
  assert.deepEqual(transferLegsInWeek(LEGS, 'week 33', '2026-08-13'), []);
  assert.deepEqual(transferLegsInWeek(undefined, '2026-08-09', '2026-08-15'), []);
});

test('transferBlockForWeek returns null (not an empty block) for a quiet week', () => {
  assert.equal(transferBlockForWeek(LEGS, '2026-08-16', '2026-08-22'), null);
  assert.deepEqual(transferBlockForWeek(LEGS, '2026-08-09', '2026-08-15'), {
    legs: [LEGS[0], LEGS[1]],
  });
});

// ── parseTransferBlock ──────────────────────────────────────────────────────

test('parse survives a jsonb round-trip and rejects junk legs', () => {
  assert.deepEqual(
    parseTransferBlock({ legs: [{ to: 'HSL', effective_date: '2026-08-13', from: 'Lead Gen' }] }),
    { legs: [{ from: 'Lead Gen', to: 'HSL', effective_date: '2026-08-13' }] },
  );
  assert.equal(parseTransferBlock(null), null);
  assert.equal(parseTransferBlock({}), null);
  assert.equal(parseTransferBlock({ legs: [] }), null);
  assert.equal(parseTransferBlock({ legs: 'Lead Gen to HSL' }), null);
  assert.equal(parseTransferBlock({ legs: [{ from: 'Lead Gen' }] }), null);
});

// ── formatTransferLabel ─────────────────────────────────────────────────────

test('the headline case reads exactly as Kane asked for it', () => {
  assert.equal(
    formatTransferLabel({ legs: [{ from: 'Lead Gen', to: 'HSL', effective_date: '2026-08-13' }] }),
    'Lead Gen to HSL',
  );
});

test('a sub-team target is the em-dash display form, never the storage key', () => {
  // 133 of the 282 live transfers target an `hsl:*` sub-team.
  assert.equal(
    formatTransferLabel({
      legs: [{ from: 'Lead Gen', to: 'hsl:intake_specialist', effective_date: '2026-08-24' }],
    }),
    'Lead Gen to HSL — Intake Specialist',
  );
  assert.equal(
    formatTransferLabel({
      legs: [{ from: 'hsl:filing_specialist', to: 'Lead Gen', effective_date: '2026-08-20' }],
    }),
    'HSL — Filing Specialist to Lead Gen',
  );
});

test('no rendered label can ever contain a raw `hsl:` slug', () => {
  const raws = [
    'hsl:intake_specialist',
    'hsl:filing_specialist',
    'hsl:attestation',
    'hsl:case_managers',
    'hsl:medical_records',
    'hsl:simple_texting',
    'hsl:executive_guest_services',
    'hsl:hearing_prep_mail_sorting',
    'hsl:callback_team',
    'hsl:not_a_team_this_build_knows',
  ];
  for (const raw of raws) {
    const label = formatTransferLabel({ legs: [{ from: raw, to: raw, effective_date: '2026-08-13' }] });
    assert.ok(label && !label.includes('hsl:'), `leaked a slug: ${label}`);
  }
});

test('a round trip inside one week collapses to the journey a human would say', () => {
  // raymandc@, 2026-08-09 week — Lead Gen → HSL Tue, HSL → Lead Gen Thu.
  assert.equal(
    formatTransferLabel({
      legs: [
        { from: 'Lead Gen', to: 'HSL', effective_date: '2026-08-11' },
        { from: 'HSL', to: 'Lead Gen', effective_date: '2026-08-13' },
      ],
    }),
    'Lead Gen to HSL to Lead Gen',
  );
});

test('legs that do NOT chain print separately — never an invented journey', () => {
  // hansc@, 2026-08-16 week: Client VA → Lead Gen, then hsl:filing_specialist
  // → Lead Gen. Chaining these would claim a Lead Gen → HSL move that never
  // happened.
  assert.equal(
    formatTransferLabel({
      legs: [
        { from: 'Client VA', to: 'Lead Gen', effective_date: '2026-08-19' },
        { from: 'hsl:filing_specialist', to: 'Lead Gen', effective_date: '2026-08-20' },
      ],
    }),
    'Client VA to Lead Gen · HSL — Filing Specialist to Lead Gen',
  );
});

test('chaining is decided on the DISPLAYED label, so HSL and a sub-team stay two legs', () => {
  assert.equal(
    formatTransferLabel({
      legs: [
        { from: 'Lead Gen', to: 'HSL', effective_date: '2026-08-11' },
        { from: 'hsl:case_managers', to: 'Lead Gen', effective_date: '2026-08-13' },
      ],
    }),
    'Lead Gen to HSL · HSL — Case Managers to Lead Gen',
  );
});

test('an empty or absent block renders nothing at all', () => {
  assert.equal(formatTransferLabel(null), '');
  assert.equal(formatTransferLabel(undefined), '');
  assert.equal(formatTransferLabel({ legs: [] }), '');
});
