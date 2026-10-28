import test from 'node:test';
import assert from 'node:assert/strict';
import { tabForDirectHash, tabForHash } from '../src/experience/routes';

test('public judge links open the intended self-service and proof surfaces', () => {
  assert.equal(tabForHash('#create'), 'create');
  assert.equal(tabForHash('#maya-noor'), 'case');
  assert.equal(tabForHash('#recipient'), 'recipient');
  assert.equal(tabForHash('#evidence'), 'evidence');
  assert.equal(tabForHash('#native'), 'native');
  assert.equal(tabForHash('#judge'), 'judge');
  assert.equal(tabForHash('#break-vault'), 'break');
});

test('unknown or empty hashes fail safely to the product overview', () => {
  assert.equal(tabForHash(''), 'welcome');
  assert.equal(tabForHash('#not-a-real-route'), 'welcome');
  assert.equal(tabForHash('#CREATE'), 'create');
});

test('ordinary document anchors never navigate away from the current app surface', () => {
  assert.equal(tabForDirectHash('#main-content'), null);
  assert.equal(tabForDirectHash('#watch'), null);
  assert.equal(tabForDirectHash(''), null);
  assert.equal(tabForDirectHash('#create'), 'create');
});
