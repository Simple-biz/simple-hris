/**
 * The Gift Tracker submission alert.
 *
 * The properties these exist to protect:
 *   1. THE RECIPIENTS ARE GRANT HOLDERS, NOT A ROLE LIST. Kane, 2026-09-22:
 *      "HR Dashboard people with HR - Gift Tracker Access". Every other HR
 *      fan-out here resolves `recipientsForRoles(['hr_coordinator','admin'])`;
 *      copying that would notify coordinators who cannot open the tab and miss
 *      the delegated people who can.
 *   2. A `hidden` GRANT IS SILENT. It is a revocation in all but name — telling
 *      somebody about a surface they cannot open is the same leak the
 *      view-scoped chime exists to prevent.
 *   3. ONE HUMAN, ONE NOTIFICATION. Grants are keyed on whatever address the
 *      person was granted under; an alias must fold onto the master row's
 *      primary work email rather than becoming a second recipient.
 *   4. ADMINS ARE IN. `requireFeatureAccess` short-circuits for them
 *      (authorize-feature.ts:56), so they can open the tab with no grant row —
 *      leaving them out would silence exactly the broadest access.
 *
 * Run:  npx tsx --test src/lib/notifications/gift-shipping-submitted.test.ts
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { buildGiftShippingMessage, foldRecipients, type AliasRow } from './gift-shipping-submitted';

const ROSTER: AliasRow[] = [
  {
    work_email: 'elly@simple.biz',
    personal_email: 'elly.personal@gmail.com',
    alternate_work_email: 'e.reyes@simple.biz',
  },
  { work_email: 'carla@simple.biz', personal_email: 'carla@gmail.com' },
  { work_email: 'kane@simple.biz', personal_email: 'kane.p@gmail.com' },
];

test('a grant holder is notified', () => {
  const out = foldRecipients({
    grants: [{ work_email: 'elly@simple.biz', access: 'view' }],
    admins: [],
    employees: ROSTER,
  });
  assert.deepEqual(out, ['elly@simple.biz']);
});

test('an `edit` grant is audible too — edit satisfies view everywhere else', () => {
  const out = foldRecipients({
    grants: [{ work_email: 'carla@simple.biz', access: 'edit' }],
    admins: [],
    employees: ROSTER,
  });
  assert.deepEqual(out, ['carla@simple.biz']);
});

test('a HIDDEN grant is silent', () => {
  const out = foldRecipients({
    grants: [
      { work_email: 'elly@simple.biz', access: 'hidden' },
      { work_email: 'carla@simple.biz', access: 'view' },
    ],
    admins: [],
    employees: ROSTER,
  });
  assert.deepEqual(out, ['carla@simple.biz']);
});

test('an unknown access value is silent rather than assumed audible', () => {
  const out = foldRecipients({
    grants: [{ work_email: 'elly@simple.biz', access: 'readonly' }],
    admins: [],
    employees: ROSTER,
  });
  assert.deepEqual(out, []);
});

test('a grant on an ALTERNATE address lands on the primary work email', () => {
  const out = foldRecipients({
    grants: [{ work_email: 'e.reyes@simple.biz', access: 'view' }],
    admins: [],
    employees: ROSTER,
  });
  assert.deepEqual(out, ['elly@simple.biz']);
});

test('one human granted twice under two addresses is ONE recipient', () => {
  const out = foldRecipients({
    grants: [
      { work_email: 'elly@simple.biz', access: 'view' },
      { work_email: 'e.reyes@simple.biz', access: 'edit' },
    ],
    admins: [],
    employees: ROSTER,
  });
  assert.deepEqual(out, ['elly@simple.biz']);
});

test('an admin with no grant row is still notified, and not duplicated', () => {
  const out = foldRecipients({
    grants: [{ work_email: 'kane@simple.biz', access: 'view' }],
    admins: [{ work_email: 'kane@simple.biz' }, { work_email: 'carla@simple.biz' }],
    employees: ROSTER,
  });
  assert.equal(out.length, 2);
  assert.ok(out.includes('kane@simple.biz'));
  assert.ok(out.includes('carla@simple.biz'));
});

test('a grant on somebody absent from the roster is kept at its own address', () => {
  // Never dropped: an off-roster grant holder is a real account that can open
  // the tab, and silently removing them would be an invisible revocation.
  const out = foldRecipients({
    grants: [{ work_email: 'contractor@simple.biz', access: 'view' }],
    admins: [],
    employees: ROSTER,
  });
  assert.deepEqual(out, ['contractor@simple.biz']);
});

test('casing and whitespace never split one person into two', () => {
  const out = foldRecipients({
    grants: [
      { work_email: '  Elly@Simple.biz ', access: 'view' },
      { work_email: 'elly@simple.biz', access: 'view' },
    ],
    admins: [],
    employees: ROSTER,
  });
  assert.deepEqual(out, ['elly@simple.biz']);
});

test('a blank grant address is not a recipient', () => {
  const out = foldRecipients({
    grants: [{ work_email: '   ', access: 'view' }, { work_email: null, access: 'edit' }],
    admins: [],
    employees: ROSTER,
  });
  assert.deepEqual(out, []);
});

test('the message names the surface — that is the question the tab answers', () => {
  const base = {
    employeeName: 'Don Dizon',
    workEmail: 'don@simple.biz',
    milestones: [1],
    hasAlternateRecipient: false,
    isUpdate: false,
  } as const;

  assert.match(
    buildGiftShippingMessage({ ...base, channel: 'external_link' }),
    /Don Dizon filled in their gift delivery details through the public gift link\./,
  );
  assert.match(
    buildGiftShippingMessage({ ...base, channel: 'employee_self' }),
    /through their Employee dashboard/,
  );
  assert.match(
    buildGiftShippingMessage({ ...base, channel: 'staff' }),
    /through the Gift Tracker/,
  );
});

test('an update says updated, and several milestones are counted', () => {
  const msg = buildGiftShippingMessage({
    channel: 'external_link',
    employeeName: 'Don Dizon',
    workEmail: 'don@simple.biz',
    milestones: [1, 2, 3],
    hasAlternateRecipient: true,
    isUpdate: true,
  });
  assert.match(msg, /updated their 3 gifts delivery details/);
  assert.match(msg, /naming somebody else to receive it/);
});

test('a nameless submitter falls back to the address, never to "undefined"', () => {
  const msg = buildGiftShippingMessage({
    channel: 'external_link',
    employeeName: null,
    workEmail: 'ghost@simple.biz',
    milestones: [1],
    hasAlternateRecipient: false,
    isUpdate: false,
  });
  assert.match(msg, /^ghost@simple\.biz filled in their gift/);
});

test('with neither a name nor an address the message still reads', () => {
  const msg = buildGiftShippingMessage({
    channel: 'staff',
    employeeName: '   ',
    workEmail: null,
    milestones: [1],
    hasAlternateRecipient: false,
    isUpdate: false,
  });
  assert.match(msg, /^Someone filled in their gift/);
});
