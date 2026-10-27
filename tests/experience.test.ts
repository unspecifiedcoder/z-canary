import test from 'node:test';
import assert from 'node:assert/strict';
import { advanceGuidedScenario, createGuidedScenario, recoverGuidedFixture } from '../src/experience/demo';
import { projectVault } from '../src/experience/model';
import { SYNTHETIC_DOSSIER_CONTENT } from '../src/engine/protocolStore';

test('guided story verifies a signed check-in, fails closed on delayed scans, and recovers with two offline keepers', () => {
  let scenario = createGuidedScenario();
  const expiry = scenario.vault.currentExpiryHeight;
  assert.equal(projectVault(scenario.vault, scenario.height).phase, 'sealed');
  assert.throws(() => recoverGuidedFixture(scenario));
  scenario = advanceGuidedScenario(scenario);
  assert.equal(scenario.vault.highestSequence, 1);
  assert.ok(scenario.vault.currentExpiryHeight > expiry);
  assert.ok(scenario.vault.keepers.every(k => k.lastSequence === 1n));
  scenario = advanceGuidedScenario(scenario);
  assert.equal(projectVault(scenario.vault, scenario.height).phase, 'grace');
  assert.equal(scenario.vault.deliveredSharesToRecipient.length, 0);
  scenario = advanceGuidedScenario(scenario);
  assert.equal(projectVault(scenario.vault, scenario.height).phase, 'suspended');
  assert.equal(scenario.vault.deliveredSharesToRecipient.length, 0);
  scenario = advanceGuidedScenario(scenario);
  assert.equal(scenario.vault.keepers.filter(k => !k.online).length, 2);
  assert.equal(scenario.vault.deliveredSharesToRecipient.length, 3);
  scenario = advanceGuidedScenario(scenario);
  assert.equal(scenario.verified, true);
  assert.equal(new TextDecoder().decode(recoverGuidedFixture(scenario)), SYNTHETIC_DOSSIER_CONTENT);
  scenario = advanceGuidedScenario(scenario);
  assert.equal(scenario.chapter, 0);
  assert.equal(scenario.verified, false);
  assert.equal(scenario.vault.deliveredSharesToRecipient.length, 0);
});

test('WebGL projection contains no keys, shares, identifiers, filenames or plaintext', () => {
  const scenario = createGuidedScenario();
  const visual = projectVault(scenario.vault, scenario.height);
  assert.deepEqual(Object.keys(visual).sort(), ['blocksRemaining','decrypted','keepers','phase','sequence','shares','threshold']);
  assert.deepEqual(Object.keys(visual.keepers[0]).sort(), ['delivered','healthy','index','online']);
  const serialized = JSON.stringify(visual);
  for (const secret of [scenario.vault.sourceSecretHex, scenario.recipientIdentity.privateKeyHex, scenario.vault.fileName, scenario.vault.manifest.switchIdHex]) assert.ok(!serialized.includes(secret));
});

test('public protection summary does not conceal keeper disagreement', () => {
  const scenario = createGuidedScenario();
  scenario.vault.keepers[0].lifecycleState = 'CANCELLED';
  assert.equal(projectVault(scenario.vault, scenario.height).phase, 'suspended');
});
