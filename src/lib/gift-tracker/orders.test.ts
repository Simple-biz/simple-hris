import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  buildInvoice,
  canonicalSize,
  countOpenOrders,
  formatPhp,
  isSizedItem,
  orderLineKey,
  resolveOrderLines,
  tierForMilestone,
  toCentavos,
  type OrderCatalogItem,
  type OrderSubmission,
  type OrderTier,
} from './orders';

const CATALOG: OrderCatalogItem[] = [
  { id: 'i1', item: 'Mug', description: 'Regular ceramic mug', price_php: 140 },
  { id: 'i2', item: 'Tote Bag', description: 'Small', price_php: 280 },
  { id: 'i3', item: 'Tote Bag', description: 'Medium', price_php: 320 },
  { id: 'i6', item: 'Tshirt', description: 'XS', price_php: 430 },
  { id: 'i7', item: 'Tshirt', description: 'Small', price_php: 430 },
  { id: 'i8', item: 'Tshirt', description: 'Medium', price_php: 430 },
  { id: 'i11', item: 'Tshirt', description: '2XL', price_php: 450 },
  { id: 'i16', item: 'Tumbler', description: '20oz', price_php: 600 },
  { id: 'i18', item: 'Hoodie Jacket', description: 'With company logo embroidery', price_php: 800, sized: true },
  { id: 'i20', item: 'Planner', description: 'PU leather', price_php: 0 },
];

const TIERS: OrderTier[] = [
  { year: 0.5, month_label: '6 Month Gift', gift: 'Tshirt' },
  { year: 1, month_label: '12 Month Gift', gift: 'Tumbler' },
  { year: 1.5, month_label: '18 Month Gift', gift: 'Hoodie Jacket', gift_items: ['Hoodie Jacket'] },
  { year: 2, month_label: '24 Month Gift', gift: 'Tote Bag & Mug' },
  { year: 2.5, month_label: '30 Month Gift', gift: 'Hat & Polo' },
  { year: 3, month_label: '36 Month Gift', gift: 'Planner' },
  { year: 3.5, month_label: '42 Month Gift', gift: '' },
];

function sub(over: Partial<OrderSubmission> = {}): OrderSubmission {
  return {
    id: 's1',
    personal_email: 'Ana@Example.com',
    milestone_index: 1,
    milestone_date: '2026-10-01',
    status: 'approved',
    apparel_size: 'M',
    preferred_delivery_location: '1 Rizal St, Manila',
    active_contact_number: '0917',
    recipient_name: '',
    recipient_relationship: '',
    recipient_contact: '',
    decided_by: 'hr@simple.biz',
    decided_at: '2026-09-20T00:00:00Z',
    ...over,
  };
}

const resolve = (submissions: OrderSubmission[], lockedKeys = new Set<string>(), variantChoices = {}) =>
  resolveOrderLines({ submissions, catalog: CATALOG, tiers: TIERS, lockedKeys, variantChoices });

test('milestone N is the tier at year N/2', () => {
  assert.equal(tierForMilestone(TIERS, 1)?.gift, 'Tshirt');
  assert.equal(tierForMilestone(TIERS, 4)?.gift, 'Tote Bag & Mug');
  assert.equal(tierForMilestone(TIERS, 20), null);
});

test('only APPROVED submissions are orders — any month', () => {
  const lines = resolve([
    sub({ id: 'a', status: 'approved', milestone_date: '2025-01-01' }),
    sub({ id: 'p', status: 'pending' }),
    sub({ id: 'r', status: 'rejected' }),
  ]);
  assert.deepEqual(lines.map((l) => l.submissionId), ['a']);
});

test('a gift on a LIVE order is not open; the rest of that submission still is', () => {
  const s = sub({ id: 'x', milestone_index: 4 });
  const lines = resolve([s], new Set([orderLineKey('x', 'Mug')]));
  assert.deepEqual(lines.map((l) => l.item), ['Tote Bag']);
});

test('Tshirt picks its row from the employee size and prints it', () => {
  const [l] = resolve([sub({ apparel_size: 'M' })]);
  assert.equal(l.problem, null);
  assert.equal(l.catalogItemId, 'i8');
  assert.equal(l.size, 'M');
  assert.equal(l.unitCentavos, 43000);
});

test('2XL is priced at the 2XL row, not the cheapest Tshirt', () => {
  const [l] = resolve([sub({ apparel_size: '2XL' })]);
  assert.equal(l.catalogItemId, 'i11');
  assert.equal(l.unitCentavos, 45000);
});

test('apparel with no size on the submission cannot be locked', () => {
  const [l] = resolve([sub({ apparel_size: '' })]);
  assert.equal(l.problem, 'needs_size');
  assert.equal(l.unitCentavos, null);
});

test('a size with no matching row needs a pick, never a guess', () => {
  const [l] = resolve([sub({ apparel_size: '3XL' })]);
  assert.equal(l.problem, 'needs_variant');
  assert.equal(l.variantOptions.length, 4);
});

test('a single-row item marked sized prints the employee size', () => {
  const [l] = resolve([sub({ milestone_index: 3, apparel_size: 'L' })]);
  assert.equal(l.item, 'Hoodie Jacket');
  assert.equal(l.size, 'L');
  assert.equal(l.problem, null);
});

test('a non-apparel item with several rows needs HR to pick, then prints the pick', () => {
  const s = sub({ id: 't', milestone_index: 4 });
  const before = resolve([s]).find((l) => l.item === 'Tote Bag')!;
  assert.equal(before.problem, 'needs_variant');
  const after = resolve([s], new Set(), { [orderLineKey('t', 'Tote Bag')]: 'i3' }).find((l) => l.item === 'Tote Bag')!;
  assert.equal(after.problem, null);
  assert.equal(after.size, 'Medium');
  assert.equal(after.unitCentavos, 32000);
});

test('the employee shirt size does NOT leak onto a mug', () => {
  const mug = resolve([sub({ milestone_index: 4, apparel_size: 'M' })]).find((l) => l.item === 'Mug')!;
  assert.equal(mug.size, '');
});

test('off-catalog, unpriced and gift-less tiers are flagged, never ₱0', () => {
  const lines = resolve([
    sub({ id: 'h', milestone_index: 5 }),
    sub({ id: 'p', milestone_index: 6 }),
    sub({ id: 'n', milestone_index: 7 }),
    sub({ id: 'z', milestone_index: 30 }),
  ]);
  const by = (id: string) => lines.filter((l) => l.submissionId === id).map((l) => l.problem);
  assert.deepEqual(by('h'), ['off_catalog', 'off_catalog']);
  assert.deepEqual(by('p'), ['no_price']);
  assert.deepEqual(by('n'), ['no_tier_gift']);
  assert.deepEqual(by('z'), ['no_tier_gift']);
  assert.ok(lines.every((l) => l.unitCentavos === null));
});

test('the invoice groups by item + size with qty, unit and amount', () => {
  const lines = resolve([
    sub({ id: '1', personal_email: 'a@x.com', apparel_size: 'M' }),
    sub({ id: '2', personal_email: 'b@x.com', apparel_size: 'M' }),
    sub({ id: '3', personal_email: 'c@x.com', apparel_size: 'XS' }),
    sub({ id: '4', personal_email: 'd@x.com', milestone_index: 2 }),
  ]);
  const { snapshot, lockLines } = buildInvoice(lines, () => null);
  assert.deepEqual(
    snapshot.groups.map((g) => [g.item, g.size, g.qty, g.unitCentavos, g.amountCentavos]),
    [
      ['Tshirt', 'XS', 1, 43000, 43000],
      ['Tshirt', 'M', 2, 43000, 86000],
      ['Tumbler', '', 1, 60000, 60000],
    ],
  );
  assert.equal(snapshot.totalCentavos, 189000);
  assert.equal(snapshot.qtyTotal, 4);
  assert.equal(snapshot.giftCount, 4);
  assert.equal(lockLines.reduce((n, l) => n + l.unit_centavos * l.qty, 0), snapshot.totalCentavos);
});

test('the invoice refuses a line that has a problem', () => {
  const lines = resolve([sub({ apparel_size: '' })]);
  assert.throws(() => buildInvoice(lines, () => null), /cannot be invoiced/);
});

test('recipients carry ship-to and the alternate recipient', () => {
  const lines = resolve([sub({ recipient_name: 'Maria', recipient_relationship: 'Spouse', recipient_contact: '0918' })]);
  const { snapshot } = buildInvoice(lines, () => 'Ana Cruz');
  assert.equal(snapshot.recipients[0].name, 'Ana Cruz');
  assert.equal(snapshot.recipients[0].items, 'Tshirt (M)');
  assert.equal(snapshot.recipients[0].receivedBy, 'Maria (Spouse) · 0918');
});

test('sizes, centavos and pesos', () => {
  assert.equal(canonicalSize('Medium'), 'M');
  assert.equal(canonicalSize('xxl'), '2XL');
  assert.equal(canonicalSize('Regular ceramic mug'), null);
  assert.equal(toCentavos(430), 43000);
  assert.equal(toCentavos(0.1 + 0.2), 30);
  assert.equal(toCentavos(0), null);
  assert.equal(toCentavos(NaN), null);
  assert.equal(formatPhp(189000), '₱1,890.00');
  assert.equal(formatPhp(5), '₱0.05');
  assert.equal(isSizedItem(CATALOG.filter((r) => r.item === 'Tshirt')), true);
  assert.equal(isSizedItem(CATALOG.filter((r) => r.item === 'Tote Bag')), false);
  // The live Tote Bag rows are exactly Small/Medium/Large — must not read as apparel.
  const tote = (d: string) => ({ id: d, item: 'Tote Bag', description: d, price_php: 1 });
  assert.equal(isSizedItem([tote('Small'), tote('Medium'), tote('Large')]), false);
  assert.equal(isSizedItem([{ ...tote('Small'), sized: true }]), true);
});

test('the Orders badge counts open GIFTS: locked ones out, blocked ones in, two items count once', () => {
  const lines = resolve(
    [
      sub({ id: 'open' }),
      sub({ id: 'two', milestone_index: 4 }), // Tote Bag & Mug = 2 lines, 1 gift
      sub({ id: 'blocked', apparel_size: '' }), // needs_size — still open
      sub({ id: 'locked' }),
      sub({ id: 'pending', status: 'pending' }),
    ],
    new Set([orderLineKey('locked', 'Tshirt')]),
  );
  assert.equal(countOpenOrders(lines), 3);
  assert.equal(countOpenOrders([]), 0);
});
