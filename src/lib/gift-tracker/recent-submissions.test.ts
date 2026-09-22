/**
 * The "Recently filled / updated" feed.
 *
 * The properties these exist to protect:
 *   1. THE CHANNEL IS READ, NEVER GUESSED. The tab's whole purpose is to say who
 *      is using the public link. A channel inferred from anything other than the
 *      audit row the write route stamped would mislabel exactly the measurement
 *      the tab is for, so an unresolvable one must stay `null`.
 *   2. THE TWO AUDIT FAMILIES KEY DIFFERENTLY. `gift_address.saved` carries the
 *      WORK email, `employee_gift_shipping.submitted` the PERSONAL one, and the
 *      submission row is keyed on the personal one. Get the bridge wrong and
 *      every public submission reads "Unknown source" — which reads as "nobody
 *      used the link".
 *   3. NOBODY IS DROPPED. An off-roster submitter is the likeliest mis-ship. The
 *      export already appends them flagged; this must too.
 *   4. FIRST WRITE VS EDIT IS DERIVED FROM THE ROW, not from the audit window —
 *      a windowed audit read would make an old row look freshly filled.
 *
 * Run:  npx tsx --test src/lib/gift-tracker/recent-submissions.test.ts
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  buildChannelIndex,
  buildRecentSubmissions,
  channelFromDetails,
  classifyKind,
  indexRoster,
  summarize,
  type ChannelEventInput,
  type RosterInput,
  type SubmissionInput,
} from './recent-submissions';
import { describeAlternateRecipient } from './alternate-recipient';

const describeRecipient = (row: { recipient_name: string; recipient_relationship: string }) =>
  describeAlternateRecipient({
    recipient_name: row.recipient_name,
    recipient_relationship: row.recipient_relationship,
  });

function submission(over: Partial<SubmissionInput> = {}): SubmissionInput {
  return {
    id: 'sub-1',
    personal_email: 'jane@gmail.com',
    milestone_index: 1,
    milestone_date: '2026-03-01',
    preferred_delivery_location: '12 Mabini St, Cebu',
    active_contact_number: '09171234567',
    recipient_name: '',
    recipient_relationship: '',
    notes: '',
    status: 'pending',
    created_at: '2026-09-22T17:00:00.000Z',
    updated_at: '2026-09-22T17:00:00.000Z',
    ...over,
  };
}

const JANE: RosterInput = {
  work_email: 'jane@simple.biz',
  personal_email: 'jane@gmail.com',
  name: 'Jane Cruz',
  department: 'Lead Gen',
};

test('the public link resolves through the roster bridge — work email in, personal email out', () => {
  const events: ChannelEventInput[] = [
    {
      action: 'gift_address.saved',
      resource_id: 'jane@simple.biz',
      created_at: '2026-09-22T17:00:05.000Z',
      details: { channel: 'external_link', milestones_saved: [1, 2] },
    },
  ];
  const index = buildChannelIndex(events, indexRoster([JANE]));
  assert.equal(index.get('jane@gmail.com')?.get(1)?.channel, 'external_link');
  assert.equal(index.get('jane@gmail.com')?.get(2)?.channel, 'external_link');
  // Never filed under the address the event itself carried.
  assert.equal(index.get('jane@simple.biz'), undefined);
});

test('the in-app write is already keyed on the personal email and needs no bridge', () => {
  const events: ChannelEventInput[] = [
    {
      action: 'employee_gift_shipping.submitted',
      resource_id: 'jane@gmail.com',
      created_at: '2026-09-22T17:00:05.000Z',
      details: { channel: 'employee_self', milestone_index: 1 },
    },
  ];
  const index = buildChannelIndex(events, indexRoster([]));
  assert.equal(index.get('jane@gmail.com')?.get(1)?.channel, 'employee_self');
});

test('an unbridgeable public event is DROPPED, never matched on the raw address', () => {
  const events: ChannelEventInput[] = [
    {
      action: 'gift_address.saved',
      resource_id: 'ghost@simple.biz',
      created_at: '2026-09-22T17:00:05.000Z',
      details: { channel: 'external_link', milestones_saved: [1] },
    },
  ];
  const index = buildChannelIndex(events, indexRoster([JANE]));
  assert.equal(index.size, 0);
});

test('an unrecognised channel is refused rather than passed through', () => {
  assert.equal(channelFromDetails({ channel: 'external_link' }), 'external_link');
  assert.equal(channelFromDetails({ channel: 'EXTERNAL_LINK' }), 'external_link');
  assert.equal(channelFromDetails({ channel: 'sms' }), null);
  assert.equal(channelFromDetails({}), null);
  assert.equal(channelFromDetails(null), null);
});

test('a submission with no audit row reports null — NOT a guessed channel', () => {
  const rows = buildRecentSubmissions({
    submissions: [submission()],
    roster: [JANE],
    events: [],
    describeRecipient,
  });
  assert.equal(rows.length, 1);
  assert.equal(rows[0].channel, null);
});

test('the newest event wins when a row was touched through two surfaces', () => {
  const events: ChannelEventInput[] = [
    {
      action: 'gift_address.saved',
      resource_id: 'jane@simple.biz',
      created_at: '2026-09-22T17:00:00.000Z',
      details: { channel: 'external_link', milestones_saved: [1] },
    },
    {
      action: 'employee_gift_shipping.submitted',
      resource_id: 'jane@gmail.com',
      created_at: '2026-09-22T18:00:00.000Z',
      details: { channel: 'staff', milestone_index: 1 },
    },
  ];
  const index = buildChannelIndex(events, indexRoster([JANE]));
  assert.equal(index.get('jane@gmail.com')?.get(1)?.channel, 'staff');
});

test('an out-of-order audit read still lands on the newest event', () => {
  const events: ChannelEventInput[] = [
    {
      action: 'employee_gift_shipping.submitted',
      resource_id: 'jane@gmail.com',
      created_at: '2026-09-22T18:00:00.000Z',
      details: { channel: 'staff', milestone_index: 1 },
    },
    {
      action: 'gift_address.saved',
      resource_id: 'jane@simple.biz',
      created_at: '2026-09-22T17:00:00.000Z',
      details: { channel: 'external_link', milestones_saved: [1] },
    },
  ];
  const index = buildChannelIndex(events, indexRoster([JANE]));
  assert.equal(index.get('jane@gmail.com')?.get(1)?.channel, 'staff');
});

test('an alternate work address still resolves to the same human', () => {
  const alt: RosterInput = { ...JANE, alternate_work_email: 'j.cruz@simple.biz' };
  const events: ChannelEventInput[] = [
    {
      action: 'gift_address.saved',
      resource_id: 'j.cruz@simple.biz',
      created_at: '2026-09-22T17:00:05.000Z',
      details: { channel: 'external_link', milestones_saved: [1] },
    },
  ];
  const index = buildChannelIndex(events, indexRoster([alt]));
  assert.equal(index.get('jane@gmail.com')?.get(1)?.channel, 'external_link');
});

test('a shared personal email keeps the FIRST claimant — it is not injective here', () => {
  const a: RosterInput = { work_email: 'russell@simple.biz', personal_email: 'shared@gmail.com', name: 'Russell' };
  const b: RosterInput = { work_email: 'johnc@simple.biz', personal_email: 'shared@gmail.com', name: 'John C' };
  const byEmail = indexRoster([a, b]);
  assert.equal(byEmail.get('shared@gmail.com')?.name, 'Russell');
  // Each still resolves from their own work address.
  assert.equal(byEmail.get('johnc@simple.biz')?.name, 'John C');
});

test('filled vs updated is derived from the row, with a tolerance for insert skew', () => {
  assert.equal(classifyKind('2026-09-22T17:00:00.000Z', '2026-09-22T17:00:00.000Z'), 'filled');
  assert.equal(classifyKind('2026-09-22T17:00:00.000Z', '2026-09-22T17:00:01.500Z'), 'filled');
  assert.equal(classifyKind('2026-09-22T17:00:00.000Z', '2026-09-22T17:00:05.000Z'), 'updated');
  assert.equal(classifyKind('2026-09-20T17:00:00.000Z', '2026-09-22T17:00:00.000Z'), 'updated');
});

test('an off-roster submitter is flagged and KEPT, never dropped', () => {
  const rows = buildRecentSubmissions({
    submissions: [submission({ personal_email: 'stranger@gmail.com' })],
    roster: [JANE],
    events: [],
    describeRecipient,
  });
  assert.equal(rows.length, 1);
  assert.equal(rows[0].offRoster, true);
  assert.equal(rows[0].workEmail, null);
  assert.equal(rows[0].name, null);
});

test('newest change first, with a stable tie-break', () => {
  const rows = buildRecentSubmissions({
    submissions: [
      submission({ id: 'old', updated_at: '2026-09-20T10:00:00.000Z' }),
      submission({ id: 'b-same', updated_at: '2026-09-22T17:00:00.000Z' }),
      submission({ id: 'a-same', updated_at: '2026-09-22T17:00:00.000Z' }),
    ],
    roster: [JANE],
    events: [],
    describeRecipient,
  });
  assert.deepEqual(rows.map((r) => r.id), ['a-same', 'b-same', 'old']);
});

test('the alternate recipient carries one spelling, and a blank name is not a person', () => {
  const [withSpouse, without] = buildRecentSubmissions({
    submissions: [
      submission({ id: 'a', recipient_name: 'Maria Dela Cruz', recipient_relationship: 'Spouse', updated_at: '2026-09-22T18:00:00.000Z' }),
      submission({ id: 'b', recipient_name: '   ', recipient_relationship: '', updated_at: '2026-09-22T17:00:00.000Z' }),
    ],
    roster: [JANE],
    events: [],
    describeRecipient,
  });
  assert.equal(withSpouse.hasAlternateRecipient, true);
  assert.equal(withSpouse.alternateRecipient, 'Maria Dela Cruz (Spouse)');
  assert.equal(without.hasAlternateRecipient, false);
  assert.equal(without.alternateRecipient, '');
});

test('the summary counts each question separately and never sums them', () => {
  const rows = buildRecentSubmissions({
    submissions: [
      submission({ id: 'a', milestone_index: 1, created_at: '2026-09-22T18:00:00.000Z', updated_at: '2026-09-22T18:00:00.000Z' }),
      submission({ id: 'b', milestone_index: 2, created_at: '2026-09-01T10:00:00.000Z', updated_at: '2026-09-22T17:00:00.000Z' }),
      submission({ id: 'c', personal_email: 'stranger@gmail.com', created_at: '2026-09-22T16:00:00.000Z', updated_at: '2026-09-22T16:00:00.000Z' }),
    ],
    roster: [JANE],
    events: [
      {
        action: 'gift_address.saved',
        resource_id: 'jane@simple.biz',
        created_at: '2026-09-22T18:00:01.000Z',
        details: { channel: 'external_link', milestones_saved: [1] },
      },
    ],
    describeRecipient,
  });
  const s = summarize(rows);
  assert.equal(s.total, 3);
  assert.equal(s.filled, 2);
  assert.equal(s.updated, 1);
  assert.equal(s.externalLink, 1);
  assert.equal(s.unknownChannel, 2);
  assert.equal(s.offRoster, 1);
  // A row is counted by kind AND by channel — the two axes are different
  // questions about the same submission, so they must not be added together.
  assert.equal(s.filled + s.updated, s.total);
  assert.equal(s.externalLink + s.employeeSelf + s.staff + s.unknownChannel, s.total);
});

test('a blank personal email is not a submitter', () => {
  const rows = buildRecentSubmissions({
    submissions: [submission({ personal_email: '   ' })],
    roster: [JANE],
    events: [],
    describeRecipient,
  });
  assert.equal(rows.length, 0);
});
