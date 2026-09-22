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
  buildGiftSubmissionsExport,
  giftSubmissionsToCsv,
  milestoneLabel,
  GIFT_ROSTER_COLUMNS,
  GIFT_SUBMISSION_COLUMNS,
  type GiftRosterEmployeeInput,
  type GiftRosterSubmissionInput,
  type GiftRosterReceiptInput,
  type GiftSubmissionsRowInput,
} from './shipping-export';
import { diffDays, getCurrentShippingMilestone, parseStartDate } from '@/lib/gift-milestones';
import { parseCsv } from './receipt-import';

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
    recipient_name: '',
    recipient_relationship: '',
    recipient_contact: '',
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
      emp({ name: 'Submitted', work_email: 'a@simple.biz', personal_email: 'a@x.com' }),
      emp({ name: 'Never submitted', work_email: 'b@simple.biz', personal_email: 'b@x.com' }),
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
    emp({ name: 'Due, silent', work_email: 'a@simple.biz', personal_email: 'a@x.com', start_date: '2024-08-19' }),
    emp({ name: 'Too new', work_email: 'b@simple.biz', personal_email: 'b@x.com', start_date: '2026-07-19' }),
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
    emp({ name: 'A', work_email: 'a@simple.biz', personal_email: 'a@x.com' }),
    emp({ name: 'B', work_email: 'b@simple.biz', personal_email: 'b@x.com' }),
    emp({ name: 'C', work_email: 'c@simple.biz', personal_email: 'c@x.com' }),
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
  // BOTH grains. The submissions CSV was added 2026-09-22 against the same
  // column list the XLSX history sheet uses, so this guard is extended rather
  // than copied — a second copy would be the one that fell behind.
  const headers = [...GIFT_ROSTER_COLUMNS, ...GIFT_SUBMISSION_COLUMNS].map((c) =>
    c.header.toLowerCase(),
  );
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

// ---------------------------------------------------------------------------
// Fulfilment — owed, received, and the "not recorded" state that is neither
// ---------------------------------------------------------------------------

/** Build with a fulfilment ledger attached. `emp()` started 2024-08-19, so on
 *  TODAY (2026-08-19) milestones 1–4 have come due and 5 has not. */
function buildWithReceipts(
  employees: GiftRosterEmployeeInput[],
  receipts: GiftRosterReceiptInput[],
) {
  return buildGiftRosterExport({
    employees,
    submissions: [],
    receipts,
    totalRoster: employees.length,
    today: TODAY,
  });
}

test('a due milestone with no receipt row counts as NOT RECORDED, never as owed', () => {
  const model = buildWithReceipts([emp()], []);
  const r = model.rows[0];
  assert.equal(r.giftsOwed, 0);
  assert.equal(r.giftsReceived, 0);
  assert.equal(r.giftsNotRecorded, 4);
  assert.equal(r.oldestOwed, '');
  assert.equal(model.summary.peopleOwed, 0);
  assert.equal(model.summary.peopleNotRecorded, 1);
});

test('omitting the receipts input entirely does not manufacture a backlog', () => {
  // The whole ledger being absent must read as "nobody has said", not "nobody
  // got anything" — otherwise a wiring mistake prints the company as owing
  // every gift it has ever given.
  const model = build([emp()]);
  assert.equal(model.rows[0].giftsOwed, 0);
  assert.equal(model.rows[0].giftsNotRecorded, 4);
  assert.equal(model.summary.giftsOwed, 0);
});

test('an explicit false on a due milestone is owed, and names the oldest', () => {
  const model = buildWithReceipts(
    [emp()],
    [
      { work_email: 'anac@simple.biz', milestone_index: 1, received: true },
      { work_email: 'anac@simple.biz', milestone_index: 2, received: false },
      { work_email: 'anac@simple.biz', milestone_index: 3, received: false },
    ],
  );
  const r = model.rows[0];
  assert.equal(r.giftsReceived, 1);
  assert.equal(r.giftsOwed, 2);
  assert.equal(r.giftsNotRecorded, 1); // milestone 4, due, nothing on record
  assert.equal(r.oldestOwed, '12-month');
});

test('gifts owed and people owed are counted separately and never netted', () => {
  const model = buildWithReceipts(
    [
      emp({ name: 'Owed three', work_email: 'a@simple.biz', personal_email: 'a@x.com' }),
      emp({ name: 'Owed one', work_email: 'b@simple.biz', personal_email: 'b@x.com' }),
    ],
    [
      { work_email: 'a@simple.biz', milestone_index: 1, received: false },
      { work_email: 'a@simple.biz', milestone_index: 2, received: false },
      { work_email: 'a@simple.biz', milestone_index: 3, received: false },
      { work_email: 'b@simple.biz', milestone_index: 1, received: false },
    ],
  );
  assert.equal(model.summary.giftsOwed, 4);
  assert.equal(model.summary.peopleOwed, 2);
});

test('a false against a milestone that has NOT come due is not owed', () => {
  const model = buildWithReceipts(
    [emp()],
    [{ work_email: 'anac@simple.biz', milestone_index: 5, received: false }],
  );
  assert.equal(model.rows[0].giftsOwed, 0);
});

test('fulfilment is keyed on WORK email — a matching personal email does not count', () => {
  const model = buildWithReceipts(
    [emp()],
    [{ work_email: 'ana.cruz@gmail.com', milestone_index: 1, received: true }],
  );
  assert.equal(model.rows[0].giftsReceived, 0);
  assert.equal(model.rows[0].giftsNotRecorded, 4);
});

test('two people sharing one personal email keep separate gift histories', () => {
  // The exact collision that kept fulfilment off employee_gift_shipping_details:
  // russell@ and johnc@ share corpuzmachacon@gmail.com on the live roster.
  const model = buildWithReceipts(
    [
      emp({ name: 'Russell', work_email: 'russell@simple.biz', personal_email: 'shared@x.com' }),
      emp({ name: 'John C', work_email: 'johnc@simple.biz', personal_email: 'shared2@x.com' }),
    ],
    [
      { work_email: 'russell@simple.biz', milestone_index: 1, received: true },
      { work_email: 'johnc@simple.biz', milestone_index: 1, received: false },
    ],
  );
  const russell = model.rows.find((r) => r.name === 'Russell')!;
  const john = model.rows.find((r) => r.name === 'John C')!;
  assert.equal(russell.giftsReceived, 1);
  assert.equal(russell.giftsOwed, 0);
  assert.equal(john.giftsReceived, 0);
  assert.equal(john.giftsOwed, 1);
});

test('a person with no start date has no owed gifts — undatable is not overdue', () => {
  const model = buildWithReceipts(
    [emp({ start_date: null })],
    [{ work_email: 'anac@simple.biz', milestone_index: 1, received: false }],
  );
  // A stated "not received" against a milestone that cannot be DATED is not a
  // debt — without a start date there is no way to know the milestone arrived.
  // It stays unresolved rather than being promoted to owed.
  assert.equal(model.rows[0].giftsOwed, 0);
  assert.equal(model.rows[0].giftsNotRecorded, 1);
});

test('the CSV carries the fulfilment columns and keeps them distinct', () => {
  const headers = GIFT_ROSTER_COLUMNS.map((c) => c.header);
  assert.ok(headers.includes('Gifts Received'));
  assert.ok(headers.includes('Gifts Owed'));
  assert.ok(headers.includes('Not Recorded'));
  assert.ok(headers.includes('Oldest Owed'));

  const csv = giftRosterToCsv(
    buildWithReceipts(
      [emp()],
      [{ work_email: 'anac@simple.biz', milestone_index: 2, received: false }],
    ),
  );
  // Parsed, never split(',') — the address column is full of commas and a naive
  // split silently shifts every column after it.
  const table = parseCsv(csv);
  const cols = table.find((r) => r[0] === '#')!;
  const cells = table[table.indexOf(cols) + 1];
  assert.equal(cells[cols.indexOf('Gifts Owed')], '1');
  assert.equal(cells[cols.indexOf('Not Recorded')], '3');
  assert.equal(cells[cols.indexOf('Oldest Owed')], '12-month');
});

test('an off-roster submitter reports no fulfilment rather than a fabricated zero backlog', () => {
  const model = buildGiftRosterExport({
    employees: [emp()],
    submissions: [sub({ personal_email: 'ghost@x.com' })],
    receipts: [],
    totalRoster: 1,
    today: TODAY,
  });
  const ghost = model.rows.find((r) => r.offRoster)!;
  assert.equal(ghost.giftsOwed, 0);
  assert.equal(ghost.giftsNotRecorded, 0);
  assert.equal(ghost.oldestOwed, '');
  // The flag, not the counts, is the finding.
  assert.equal(ghost.department, 'Off-roster');
});

test('two colleagues sharing a personal email BOTH appear — neither is deduped away', () => {
  // johnc@simple.biz and russell@simple.biz really share corpuzmachacon@gmail.com.
  // Deduping on the submission key silently dropped whichever arrived second,
  // taking their gift receipts off the file with them.
  const model = buildGiftRosterExport({
    employees: [
      emp({ name: 'Corpuz, John Marc', work_email: 'johnc@simple.biz', personal_email: 'shared@gmail.com' }),
      emp({ name: 'Bencito, Rhocel', work_email: 'russell@simple.biz', personal_email: 'shared@gmail.com' }),
    ],
    submissions: [],
    receipts: [
      { work_email: 'johnc@simple.biz', milestone_index: 1, received: true },
      { work_email: 'russell@simple.biz', milestone_index: 1, received: false },
    ],
    totalRoster: 2,
    today: TODAY,
  });
  assert.equal(model.rows.length, 2);
  const john = model.rows.find((r) => r.name === 'Corpuz, John Marc')!;
  const rhocel = model.rows.find((r) => r.name === 'Bencito, Rhocel')!;
  assert.equal(john.giftsReceived, 1);
  assert.equal(john.giftsOwed, 0);
  assert.equal(rhocel.giftsReceived, 0);
  assert.equal(rhocel.giftsOwed, 1);
});

test('a genuinely duplicated master row still collapses', () => {
  const model = build([
    emp({ name: 'First wins', work_email: 'dupe@simple.biz', personal_email: 'a@x.com' }),
    emp({ name: 'Second dropped', work_email: 'DUPE@simple.biz', personal_email: 'b@x.com' }),
  ]);
  assert.equal(model.rows.length, 1);
  assert.equal(model.rows[0].name, 'First wins');
});

// ---------------------------------------------------------------------------
// Somebody else receiving the gift (2026-09-18)
//
// Kane's Q1 ruling is the load-bearing one here: "The Employees as they will
// contact their spouse." The courier calls the EMPLOYEE, so `Contact Number`
// must keep meaning the employee's number no matter who is at the door.
// ---------------------------------------------------------------------------

const SPOUSE_SUB = {
  recipient_name: 'Maria Dela Cruz',
  recipient_relationship: 'Spouse',
  recipient_contact: '09181111111',
};

test('CONTACT NUMBER STAYS THE EMPLOYEE\u2019S even when a spouse receives the gift', () => {
  // The single most damaging "helpful" edit available to this file would be to
  // prefer the recipient's number in this column. It would point the whole ship
  // list at the wrong person, and nothing on the file would say so.
  const model = build(
    [emp({ name: 'Cruz, Ana', work_email: 'ana@simple.biz', personal_email: 'ana.cruz@gmail.com' })],
    [sub({ active_contact_number: '09170000000', ...SPOUSE_SUB })],
  );
  const row = model.rows[0];
  assert.equal(row.contactNumber, '09170000000');
  assert.equal(row.recipientContact, '09181111111');
  assert.notEqual(row.contactNumber, row.recipientContact);
});

/**
 * Read one CSV column by header name.
 *
 * Through the real parser, never `split(',')`: Philippine addresses are full of
 * commas and RFC-4180-quoted, so a naive split shears every column after the
 * address and the assertions would compare the wrong cells.
 */
function csvCell(csv: string, header: string, rowIndex = 0): string {
  const rows = parseCsv(csv);
  const headerRow = rows.findIndex((r) => r.includes('Contact Number'));
  const col = rows[headerRow].indexOf(header);
  assert.notEqual(col, -1, `column ${header} is missing from the CSV`);
  return rows[headerRow + 1 + rowIndex][col];
}

test('the CSV prints the employee number under Contact Number and the spouse under Recipient Contact', () => {
  const model = build(
    [emp({ name: 'Cruz, Ana', work_email: 'ana@simple.biz', personal_email: 'ana.cruz@gmail.com' })],
    [sub({ active_contact_number: '09170000000', ...SPOUSE_SUB })],
  );
  const csv = giftRosterToCsv(model);
  assert.equal(csvCell(csv, 'Contact Number'), '09170000000');
  assert.equal(csvCell(csv, 'Alternate Recipient'), 'Maria Dela Cruz');
  assert.equal(csvCell(csv, 'Recipient Relationship'), 'Spouse');
  assert.equal(csvCell(csv, 'Recipient Contact'), '09181111111');
});

test('no alternate recipient reads as a dash, never as a blank cell', () => {
  // A blank would be indistinguishable from a missing value. A dash is an
  // answer: this person receives their own gift.
  const model = build(
    [emp({ name: 'Cruz, Ana', work_email: 'ana@simple.biz', personal_email: 'ana.cruz@gmail.com' })],
    [sub()],
  );
  assert.equal(model.rows[0].alternateRecipient, '');
  assert.equal(csvCell(giftRosterToCsv(model), 'Alternate Recipient'), '-');
});

test('a relationship with no name is NOT reported as an alternate recipient', () => {
  // The database refuses this shape, but a legacy row or a hand edit can hold
  // it. One predicate decides, and it keys on the name.
  const model = build(
    [emp({ name: 'Cruz, Ana', work_email: 'ana@simple.biz', personal_email: 'ana.cruz@gmail.com' })],
    [sub({ recipient_name: '   ', recipient_relationship: 'Spouse', recipient_contact: '0918' })],
  );
  assert.equal(model.rows[0].alternateRecipient, '');
  assert.equal(model.rows[0].recipientRelationship, '');
  assert.equal(model.rows[0].recipientContact, '');
  assert.equal(model.summary.altRecipient, 0);
});

test('the summary counts parcels going to somebody else', () => {
  const model = build(
    [
      emp({ name: 'A', work_email: 'a@simple.biz', personal_email: 'a@x.com' }),
      emp({ name: 'B', work_email: 'b@simple.biz', personal_email: 'b@x.com' }),
      emp({ name: 'C', work_email: 'c@simple.biz', personal_email: 'c@x.com' }),
    ],
    [
      sub({ personal_email: 'a@x.com', ...SPOUSE_SUB }),
      sub({ personal_email: 'b@x.com' }),
    ],
  );
  assert.equal(model.summary.altRecipient, 1);
});

test('an OFF-ROSTER submitter keeps their alternate recipient', () => {
  // They are the likeliest person to be mis-shipped, so dropping the field that
  // says who is actually at the door would be exactly backwards.
  const model = build(
    [emp({ name: 'On roster', work_email: 'on@simple.biz', personal_email: 'on@x.com' })],
    [
      sub({ personal_email: 'on@x.com' }),
      sub({ personal_email: 'ghost@x.com', ...SPOUSE_SUB }),
    ],
  );
  const ghost = model.rows.find((r) => r.department === 'Off-roster')!;
  assert.equal(ghost.alternateRecipient, 'Maria Dela Cruz');
  assert.equal(ghost.recipientRelationship, 'Spouse');
});

test('the XLSX submissions sheet carries the recipient columns', () => {
  const model = build(
    [emp({ name: 'Cruz, Ana', work_email: 'ana@simple.biz', personal_email: 'ana.cruz@gmail.com' })],
    [sub({ ...SPOUSE_SUB })],
  );
  assert.equal(model.submissions[0].alternateRecipient, 'Maria Dela Cruz');
  assert.equal(model.submissions[0].recipientRelationship, 'Spouse');
  // The history sheet exists so the detail the roster grain flattens survives;
  // an arrangement that appeared on one milestone and not the next is exactly
  // the kind of thing it is there to preserve.
  assert.doesNotThrow(() => buildGiftRosterWorkbook(model));
});

test('the recipient columns carry NO price, like every other column here', () => {
  const model = build(
    [emp({ name: 'Cruz, Ana', work_email: 'ana@simple.biz', personal_email: 'ana.cruz@gmail.com' })],
    [sub({ ...SPOUSE_SUB })],
  );
  const csv = giftRosterToCsv(model);
  const header = csv.split('\n').find((l) => l.includes('Alternate Recipient'))!;
  assert.equal(/price|cost|amount|php|catalog/i.test(header), false);
});

// ---------------------------------------------------------------------------
// Submissions grain — HR → Gift Tracker → Submissions → Export CSV
//
// The OTHER grain, and these tests exist mostly to stop somebody reconciling the
// two. This file is one row per submission on purpose: it is the shipping desk's
// queue, not the roster reconciliation. Neither weakens the other.
// ---------------------------------------------------------------------------

function srow(over: Partial<GiftSubmissionsRowInput> = {}): GiftSubmissionsRowInput {
  return {
    submission: sub(),
    offRoster: false,
    name: 'Ana Cruz',
    workEmail: 'anac@simple.biz',
    department: 'Sales',
    ...over,
  };
}

test('caller order is preserved exactly — the builder never re-sorts', () => {
  // The panel sorts pending-first, then newest edit. That IS the review order the
  // team works in, so a file that re-sorted itself would stop matching the screen
  // it was taken from.
  const model = buildGiftSubmissionsExport({
    rows: [
      srow({ name: 'Third', submission: sub({ status: 'approved' }) }),
      srow({ name: 'First', submission: sub({ status: 'pending' }) }),
      srow({ name: 'Second', submission: sub({ status: 'rejected' }) }),
    ],
    totalSubmissions: 3,
  });
  assert.deepEqual(model.rows.map((r) => r.name), ['Third', 'First', 'Second']);
});

test('an off-roster submitter is FLAGGED in Department, never dropped', () => {
  const model = buildGiftSubmissionsExport({
    rows: [
      srow(),
      srow({
        offRoster: true,
        name: null,
        workEmail: null,
        department: null,
        submission: sub({ personal_email: 'ghost@x.com' }),
      }),
    ],
    totalSubmissions: 2,
  });
  assert.equal(model.rows.length, 2);
  const ghost = model.rows[1];
  assert.equal(ghost.department, 'Off-roster');
  // No roster row means no work email exists. `-`, never their personal address
  // dressed up as a company one.
  assert.equal(ghost.workEmail, '-');
  assert.equal(ghost.name, 'ghost@x.com');
  assert.equal(model.summary.offRoster, 1);
});

test('people are counted on the WORK email, not the submission key', () => {
  // personal_email is not injective on this roster — two colleagues share one.
  // Counting distinct submission keys would merge them into a single "person".
  const shared = 'shared.household@gmail.com';
  const model = buildGiftSubmissionsExport({
    rows: [
      srow({ name: 'Ana', workEmail: 'anac@simple.biz', submission: sub({ personal_email: shared }) }),
      srow({ name: 'Ben', workEmail: 'benc@simple.biz', submission: sub({ personal_email: shared }) }),
      // Ana again, a second milestone: one more submission, still one person.
      srow({
        name: 'Ana',
        workEmail: 'anac@simple.biz',
        submission: sub({ personal_email: shared, milestone_index: 3 }),
      }),
    ],
    totalSubmissions: 3,
  });
  assert.equal(model.summary.submissions, 3);
  assert.equal(model.summary.people, 2);
});

test('the scope is stamped — N of TOTAL, because the panel defaults to Pending', () => {
  const csv = giftSubmissionsToCsv(
    buildGiftSubmissionsExport({
      rows: [srow(), srow()],
      totalSubmissions: 231,
      scopeLabel: 'Pending · search cebu',
    }),
  );
  assert.ok(csv.includes('Tenure Gift Submissions'));
  assert.ok(csv.includes('Scope: Pending · search cebu'));
  // An unstamped file would read as the whole queue while holding a fraction.
  assert.ok(csv.includes('2 of 231 submissions on file'));
});

test('an omitted scope label says All submissions, never blank', () => {
  const model = buildGiftSubmissionsExport({ rows: [srow()], totalSubmissions: 1 });
  assert.equal(model.scopeLabel, 'All submissions');
});

test('status counts come from the RAW status, not the printed label', () => {
  const model = buildGiftSubmissionsExport({
    rows: [
      srow({ submission: sub({ status: 'pending' }) }),
      srow({ submission: sub({ status: 'pending' }) }),
      srow({ submission: sub({ status: 'approved' }) }),
      srow({ submission: sub({ status: 'rejected' }) }),
    ],
    totalSubmissions: 4,
  });
  assert.equal(model.summary.pending, 2);
  assert.equal(model.summary.approved, 1);
  assert.equal(model.summary.rejected, 1);
});

test('a submission with no address is counted, not silently fine', () => {
  const model = buildGiftSubmissionsExport({
    rows: [srow({ submission: sub({ preferred_delivery_location: '' }) }), srow()],
    totalSubmissions: 2,
  });
  assert.equal(model.summary.noAddress, 1);
  assert.equal(model.rows[0].shippingAddress, '-');
});

test('an alternate recipient is counted and printed at submission grain too', () => {
  const model = buildGiftSubmissionsExport({
    rows: [srow({ submission: sub({ ...SPOUSE_SUB }) }), srow()],
    totalSubmissions: 2,
  });
  assert.equal(model.summary.altRecipient, 1);
  assert.equal(model.rows[0].alternateRecipient, 'Maria Dela Cruz');
  // The employee's own number stays the one the courier calls — same ruling as
  // the roster file, and the reason the recipient columns sit BESIDE it.
  assert.equal(model.rows[0].contactNumber, sub().active_contact_number);
});

test('Reviewer Note and Submitted At reach BOTH grains from the one column list', () => {
  const rich = sub({
    created_at: '2026-08-01T02:00:00Z',
    decision_note: 'Address confirmed by phone',
    updated_at: '2026-08-09T02:00:00Z',
  });
  const headers = GIFT_SUBMISSION_COLUMNS.map((c) => c.header);
  assert.ok(headers.includes('Reviewer Note'));
  // Two timestamps, never one: first send vs most recent edit.
  assert.ok(headers.includes('Submitted At'));
  assert.ok(headers.includes('Last Submitted'));

  const csv = giftSubmissionsToCsv(
    buildGiftSubmissionsExport({ rows: [srow({ submission: rich })], totalSubmissions: 1 }),
  );
  assert.ok(csv.includes('Reviewer Note'));
  assert.ok(csv.includes('Address confirmed by phone'));

  // The roster export's XLSX history sheet reads the same record, so it gains
  // them for free — that shared list is what keeps the two files in step.
  const roster = build([emp()], [rich]);
  assert.equal(roster.submissions[0].reviewerNote, 'Address confirmed by phone');
  assert.notEqual(roster.submissions[0].firstSubmittedAt, '');
  assert.notEqual(roster.submissions[0].firstSubmittedAt, roster.submissions[0].submittedAt);
});

test('an absent created_at / decision_note prints a dash, never an invented value', () => {
  // Both are OPTIONAL on the input type. Absent must not be back-filled from
  // updated_at — that would claim a row had never been edited.
  const model = buildGiftSubmissionsExport({ rows: [srow()], totalSubmissions: 1 });
  const rows = parseCsv(giftSubmissionsToCsv(model));
  const header = rows.find((r) => r[0] === '#')!;
  const body = rows[rows.indexOf(header) + 1];
  assert.equal(body[header.indexOf('Submitted At')], '-');
  assert.equal(body[header.indexOf('Reviewer Note')], '-');
  assert.equal(model.rows[0].firstSubmittedAt, '');
});

test('vestigial price fields never leak into the SUBMISSIONS csv either', () => {
  const dirty = {
    ...sub(),
    gift_price_php: 1499,
    gift_name: 'Branded Hoodie',
    gift_catalog_item_id: 'cat-7',
  } as GiftRosterSubmissionInput;
  const csv = giftSubmissionsToCsv(
    buildGiftSubmissionsExport({ rows: [srow({ submission: dirty })], totalSubmissions: 1 }),
  );
  assert.ok(!csv.includes('1499'));
  assert.ok(!csv.includes('Branded Hoodie'));
  assert.ok(!csv.includes('cat-7'));
});

test('a Philippine address full of commas survives the round trip', () => {
  const model = buildGiftSubmissionsExport({
    rows: [
      srow({
        submission: sub({
          preferred_delivery_location: '12 Rizal St, Barangay Uno, Cebu City, 6000',
          notes: 'Leave with the guard, please',
        }),
      }),
    ],
    totalSubmissions: 1,
  });
  const rows = parseCsv(giftSubmissionsToCsv(model));
  const header = rows.find((r) => r[0] === '#')!;
  const body = rows[rows.indexOf(header) + 1];
  assert.equal(
    body[header.indexOf('Shipping Address')],
    '12 Rizal St, Barangay Uno, Cebu City, 6000',
  );
  assert.equal(body[header.indexOf('Employee Notes')], 'Leave with the guard, please');
});
