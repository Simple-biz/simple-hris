/**
 * buildGiftRosterExport — the CSV/XLSX/PDF model behind Gift Tracker → Export.
 *
 * The load-bearing property pinned here: the grain is the MASTER LIST, not the
 * submissions table. Kane reconciles this export against the tenure-gift Google
 * Sheet, so a person who never submitted, has no start date, or has reached no
 * milestone is precisely the person the comparison must surface — dropping them
 * would make the export agree with the sheet by omission.
 *
 * Also pinned: tenure gifts are INFORMATION ONLY. `gift_price_php` / `gift_name`
 * are vestigial history columns and must never reach an output format.
 *
 * Run:  npx tsx --test src/lib/gift-tracker/shipping-export.test.ts
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  buildGiftRosterExport,
  giftRosterToCsv,
  buildGiftRosterWorkbook,
  milestoneLabel,
  GIFT_ROSTER_COLUMNS,
  type GiftRosterEmployeeInput,
  type GiftRosterSubmissionInput,
} from './shipping-export';
import { diffDays, getCurrentShippingMilestone, parseStartDate } from '@/lib/gift-milestones';

/** Fixed clock so milestone math is deterministic. */
const TODAY = new Date('2026-08-19T00:00:00');

function emp(over: Partial<GiftRosterEmployeeInput> = {}): GiftRosterEmployeeInput {
  return {
    name: 'Ana Cruz',
    department: 'Sales',
    work_email: 'anac@simple.biz',
    personal_email: 'ana.cruz@gmail.com',
    start_date: '2024-08-19',
    ...over,
  };
}

function sub(over: Partial<GiftRosterSubmissionInput> = {}): GiftRosterSubmissionInput {
  return {
    personal_email: 'ana.cruz@gmail.com',
    milestone_index: 4,
    milestone_date: '2026-08-19',
    preferred_delivery_location: '12 Rizal St, Barangay Uno, Cebu City',
    active_contact_number: '09171234567',
    apparel_size: 'L',
    notes: '',
    status: 'approved',
    decided_by: 'kaner@simple.biz',
    decided_at: '2026-08-10T02:00:00Z',
    updated_at: '2026-08-09T02:00:00Z',
    ...over,
  };
}

function build(
  employees: GiftRosterEmployeeInput[],
  submissions: GiftRosterSubmissionInput[] = [],
) {
  return buildGiftRosterExport({
    employees,
    submissions,
    totalRoster: employees.length,
    today: TODAY,
  });
}

// ---------------------------------------------------------------------------
// Completeness — the reason this export exists
// ---------------------------------------------------------------------------

test('every roster person appears, submitted or not', () => {
  const model = build(
    [
      emp({ name: 'Submitted', personal_email: 'a@x.com' }),
      emp({ name: 'Never submitted', personal_email: 'b@x.com' }),
    ],
    [sub({ personal_email: 'a@x.com' })],
  );
  assert.equal(model.rows.length, 2);
  assert.deepEqual(
    model.rows.map((r) => r.name).sort(),
    ['Never submitted', 'Submitted'],
  );
  assert.equal(model.rows.find((r) => r.name === 'Never submitted')?.submitted, 'No');
  assert.equal(model.rows.find((r) => r.name === 'Never submitted')?.status, 'Not submitted');
});

test('a person with no start date still gets a row', () => {
  const model = build([emp({ name: 'No start', start_date: null })]);
  assert.equal(model.rows.length, 1);
  assert.equal(model.rows[0].name, 'No start');
  assert.equal(model.rows[0].milestonesReached, 0);
  assert.equal(model.rows[0].currentMilestone, 'None yet');
  assert.equal(model.rows[0].tenure, '-');
});

test('a person who has reached no milestone still gets a row', () => {
  // Started 1 month ago — first milestone is 5 months out, past the 30-day window.
  const model = build([emp({ name: 'Brand new', start_date: '2026-07-19' })]);
  assert.equal(model.rows.length, 1);
  assert.equal(model.rows[0].milestonesReached, 0);
  assert.equal(model.rows[0].currentMilestone, 'None yet');
  assert.equal(model.rows[0].milestoneDate, '');
  assert.equal(model.rows[0].submitted, 'No');
});

test('duplicate master rows sharing an email collapse to one row', () => {
  const model = build([
    emp({ name: 'First wins', personal_email: 'dupe@x.com' }),
    emp({ name: 'Second dropped', personal_email: 'DUPE@x.com' }),
  ]);
  assert.equal(model.rows.length, 1);
  assert.equal(model.rows[0].name, 'First wins');
});

// ---------------------------------------------------------------------------
// Off-roster submitters — the likeliest mis-ship
// ---------------------------------------------------------------------------

test('a submitter matching no roster row is appended and flagged, never dropped', () => {
  const model = build(
    [emp({ name: 'On roster', personal_email: 'on@x.com' })],
    [
      sub({ personal_email: 'on@x.com' }),
      sub({ personal_email: 'ghost@x.com', preferred_delivery_location: '9 Mabini Ave' }),
    ],
  );
  assert.equal(model.rows.length, 2);
  const ghost = model.rows.at(-1)!; // appended AFTER the roster block
  assert.equal(ghost.offRoster, true);
  assert.equal(ghost.personalEmail, 'ghost@x.com');
  assert.equal(ghost.department, 'Off-roster');
  assert.equal(ghost.workEmail, '-');
  assert.equal(ghost.shippingAddress, '9 Mabini Ave');
  assert.equal(model.summary.offRoster, 1);
});

// ---------------------------------------------------------------------------
// Address provenance
// ---------------------------------------------------------------------------

test('a submitted address wins and is labelled Submitted', () => {
  const model = build(
    [emp({ street: '1 Home St', city: 'Manila' })],
    [sub({ preferred_delivery_location: '12 Rizal St, Cebu City' })],
  );
  assert.equal(model.rows[0].shippingAddress, '12 Rizal St, Cebu City');
  assert.equal(model.rows[0].addressSource, 'Submitted');
});

test('with no submission the master-list address is used and labelled Master list', () => {
  const model = build([
    emp({ street: '1 Home St', city: 'Manila', province: 'NCR', postal_code: '1000' }),
  ]);
  assert.equal(model.rows[0].shippingAddress, '1 Home St, Manila, NCR, 1000');
  assert.equal(model.rows[0].addressSource, 'Master list');
});

test('the home address never depends on the EXTENDED-tier location column alone', () => {
  // street/city/province/postal_code/full_address are BASE tier and must carry
  // the address on their own — `location` degrades to undefined on a stale view.
  const model = build([
    emp({
      street: null, city: null, province: null, postal_code: null,
      full_address: '77 Base Tier Rd, Davao',
      location: undefined,
    }),
  ]);
  assert.equal(model.rows[0].shippingAddress, '77 Base Tier Rd, Davao');
  assert.equal(model.rows[0].addressSource, 'Master list');
});

test('no address anywhere is called out, not silently blank', () => {
  const model = build([
    emp({ street: null, city: null, province: null, postal_code: null, full_address: null, location: null }),
  ]);
  assert.equal(model.rows[0].addressSource, 'None on file');
  assert.equal(model.rows[0].shippingAddress, '-');
  assert.equal(model.summary.noAddress, 1);
});

// ---------------------------------------------------------------------------
// Milestone math — delegated to gift-milestones.ts, pinned here
// ---------------------------------------------------------------------------

test('milestone_index N labels as the (N x 6)-month gift', () => {
  assert.equal(milestoneLabel(1), '6-month');
  assert.equal(milestoneLabel(2), '12-month');
  assert.equal(milestoneLabel(4), '24-month');
  assert.equal(milestoneLabel(0), 'None yet');
  assert.equal(milestoneLabel(null), 'None yet');
});

test('milestones reached counts every 6-month mark passed', () => {
  // Started exactly 2 years before TODAY → 6/12/18/24-month all reached.
  const model = build([emp({ start_date: '2024-08-19' })]);
  assert.equal(model.rows[0].milestonesReached, 4);
  assert.equal(model.rows[0].currentMilestone, '24-month');
});

test('dueIn is derived from the SHARED milestone helper, not a second date rule', () => {
  // `parseStartDate` reads a date-only `start_date` as UTC midnight, so west of
  // UTC it renders a day earlier — the on-screen Gift Tracker does exactly the
  // same thing, and the export must agree with the screen rather than invent a
  // second interpretation. Derive the expectation from the shared helpers so
  // this pins the delegation, not the runner's timezone.
  const start = parseStartDate('2024-08-19')!;
  const current = getCurrentShippingMilestone(start, TODAY)!;
  const days = diffDays(current.date, TODAY);
  const expected =
    days === 0 ? 'Today'
    : days === 1 ? 'Tomorrow'
    : days < 0 ? `Overdue by ${Math.abs(days)} day${Math.abs(days) === 1 ? '' : 's'}`
    : `In ${days} days`;

  const model = build([emp({ start_date: '2024-08-19' })]);
  assert.equal(model.rows[0].currentMilestone, `${current.index * 6}-month`);
  assert.equal(model.rows[0].dueIn, expected);
});

test('the submission for the CURRENT milestone is the one joined on', () => {
  const model = build(
    [emp({ start_date: '2024-08-19' })], // current = index 4
    [
      sub({ milestone_index: 3, preferred_delivery_location: 'OLD address' }),
      sub({ milestone_index: 4, preferred_delivery_location: 'CURRENT address' }),
    ],
  );
  assert.equal(model.rows[0].shippingAddress, 'CURRENT address');
  assert.equal(model.rows[0].currentMilestone, '24-month');
});

test('between windows, the newest submission on file still supplies the address', () => {
  // Started 7 months ago: current milestone is index 1 (its window has opened and
  // passed). A submission for index 1 exists, so it is used.
  const model = build(
    [emp({ start_date: '2026-01-19' })],
    [sub({ milestone_index: 1, preferred_delivery_location: 'Last known' })],
  );
  assert.equal(model.rows[0].submitted, 'Yes');
  assert.equal(model.rows[0].shippingAddress, 'Last known');
});

// ---------------------------------------------------------------------------
// Summary counters
// ---------------------------------------------------------------------------

test('dueNoSubmission counts people with an open milestone and no submission', () => {
  const model = build([
    emp({ name: 'Due, silent', personal_email: 'a@x.com', start_date: '2024-08-19' }),
    emp({ name: 'Too new', personal_email: 'b@x.com', start_date: '2026-07-19' }),
  ]);
  assert.equal(model.summary.people, 2);
  assert.equal(model.summary.notSubmitted, 2);
  // Only the person whose milestone window is actually open counts as a gap.
  assert.equal(model.summary.dueNoSubmission, 1);
});

// ---------------------------------------------------------------------------
// Serialization
// ---------------------------------------------------------------------------

test('CSV quotes comma-bearing addresses so columns do not shear', () => {
  const model = build([emp()], [sub({ preferred_delivery_location: '12 Rizal St, Barangay Uno, Cebu' })]);
  const csv = giftRosterToCsv(model);
  assert.ok(csv.includes('"12 Rizal St, Barangay Uno, Cebu"'));
  // One data line per person, plus preamble + header.
  const dataLines = csv.split('\r\n').filter((l) => l.startsWith('1,'));
  assert.equal(dataLines.length, 1);
});

test('CSV leads with a UTF-8 BOM so Excel renders symbols', () => {
  const csv = giftRosterToCsv(build([emp()]));
  assert.equal(csv.charCodeAt(0), 0xfeff);
});

test('CSV emits one row per roster person even when nobody submitted', () => {
  const model = build([
    emp({ name: 'A', personal_email: 'a@x.com' }),
    emp({ name: 'B', personal_email: 'b@x.com' }),
    emp({ name: 'C', personal_email: 'c@x.com' }),
  ]);
  const csv = giftRosterToCsv(model);
  for (const n of ['A', 'B', 'C']) assert.ok(csv.includes(`,${n},`), `${n} missing from CSV`);
});

test('the workbook carries both the roster sheet and the submission history sheet', () => {
  const model = build(
    [emp({ start_date: '2024-08-19' })],
    [sub({ milestone_index: 3 }), sub({ milestone_index: 4 })],
  );
  const wb = buildGiftRosterWorkbook(model);
  assert.deepEqual(wb.SheetNames, ['Gift Roster', 'All submissions']);
  // The roster sheet flattens to one row; the history sheet keeps both.
  assert.equal(model.rows.length, 1);
  assert.equal(model.submissions.length, 2);
});

// ---------------------------------------------------------------------------
// Gifts are information-only — no price, no gift name, anywhere
// ---------------------------------------------------------------------------

test('no price or gift-name column is ever emitted', () => {
  const headers = GIFT_ROSTER_COLUMNS.map((c) => c.header.toLowerCase());
  for (const banned of ['price', 'gift name', 'php', 'amount', 'cost', 'catalog']) {
    assert.ok(
      !headers.some((h) => h.includes(banned)),
      `column header contains banned token "${banned}" — tenure gifts carry no price`,
    );
  }
});

test('vestigial price fields on a submission never leak into the CSV', () => {
  // The real row type carries gift_price_php / gift_name; the export input type
  // does not read them, so even a row that has them cannot surface them.
  const dirty = {
    ...sub(),
    gift_price_php: 1499,
    gift_name: 'Branded Hoodie',
    gift_catalog_item_id: 'cat-7',
  } as GiftRosterSubmissionInput;
  const csv = giftRosterToCsv(build([emp()], [dirty]));
  assert.ok(!csv.includes('1499'));
  assert.ok(!csv.includes('Branded Hoodie'));
  assert.ok(!csv.includes('cat-7'));
});
