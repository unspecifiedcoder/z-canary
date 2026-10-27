import test from 'node:test';
import assert from 'node:assert/strict';
import { tabForHash } from '../src/experience/routes';

test('public judge links open the intended self-service and proof surfaces', () => {
  assert.equal(tabForHash('#create'), 'create');
  assert.equal(tabForHash('#maya-noor'), 'case');
  assert.equal(tabForHash('#recipient'), 'recipient');
  assert.equal(tabForHash('#evidence'), 'evidence');
  assert.equal(tabForHash('#native'), 'native');
});

test('unknown or empty hashes fail safely to the product overview', () => {
  assert.equal(tabForHash(''), 'welcome');
  assert.equal(tabForHash('#not-a-real-route'), 'welcome');
  assert.equal(tabForHash('#CREATE'), 'create');
});
