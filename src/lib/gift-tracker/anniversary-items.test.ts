import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  canonicalizeTierItems,
  catalogItemNames,
  missingTierItems,
  tierGiftFields,
  tierGiftItems,
} from './anniversary-items';

test('catalog names are distinct item names, variants collapsed, blanks skipped', () => {
  const names = catalogItemNames([
    { item: 'Tshirt' },
    { item: 'Tshirt' },
    { item: ' Tote Bag ' },
    { item: 'tote bag' },
    { item: '' },
    { item: 'Mug' },
  ]);
  assert.deepEqual(names, ['Tshirt', 'Tote Bag', 'Mug']);
});

test('a legacy tier with only free text splits on " & "', () => {
  assert.deepEqual(tierGiftItems({ gift: 'Tote Bag & Mug' }), ['Tote Bag', 'Mug']);
  assert.deepEqual(tierGiftItems({ gift: '' }), []);
});

test('gift_items wins over the free text when present', () => {
  assert.deepEqual(tierGiftItems({ gift: 'Old', gift_items: ['Tumbler'] }), ['Tumbler']);
  assert.deepEqual(tierGiftItems({ gift: 'Old', gift_items: [] }), []);
});

test('the two stored fields are written together and agree', () => {
  assert.deepEqual(tierGiftFields(['Hat', 'Mug', 'hat', ' ']), { gift_items: ['Hat', 'Mug'], gift: 'Hat & Mug' });
  assert.deepEqual(tierGiftFields([]), { gift_items: [], gift: '' });
});

test('names not in Gift items are reported, never dropped', () => {
  const catalog = ['Hat', 'Tshirt', 'Speaker (Square)'];
  const tier = tierGiftItems({ gift: 'Hat & Polo' });
  assert.deepEqual(missingTierItems(tier, catalog), ['Polo']);
  assert.deepEqual(tier, ['Hat', 'Polo']);
  assert.deepEqual(missingTierItems(['Speaker'], catalog), ['Speaker']);
});

test('case-only differences snap to the catalog spelling', () => {
  assert.deepEqual(canonicalizeTierItems(['tshirt', 'Polo'], ['Tshirt']), ['Tshirt', 'Polo']);
  assert.deepEqual(missingTierItems(['tshirt'], ['Tshirt']), []);
});
