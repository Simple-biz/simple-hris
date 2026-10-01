/** Run: node --import tsx --test src/lib/accounting-scoreboard/names.test.ts */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { shortNameFromRoster } from './names';

test('a quoted nickname wins, straight or curly quotes', () => {
  assert.equal(shortNameFromRoster('Galang, April Pearl "April"'), 'April');
  assert.equal(shortNameFromRoster('Tesalona, Maria Linda "Lenny"'), 'Lenny');
  assert.equal(shortNameFromRoster('Lavilla, John Mark “John”'), 'John');
  assert.equal(shortNameFromRoster('Superta, Jaypee "Steve Sanders"'), 'Steve Sanders');
});

test('"Last, First" becomes First L.', () => {
  assert.equal(shortNameFromRoster('Weissman, Justin'), 'Justin W.');
  assert.equal(shortNameFromRoster('Gobalani,  Kyle Sheen'), 'Kyle G.');
});

test('anything else is kept, squeezed', () => {
  assert.equal(shortNameFromRoster('  Victor   Caleb De Lara '), 'Victor Caleb De Lara');
  assert.equal(shortNameFromRoster(''), '');
});
