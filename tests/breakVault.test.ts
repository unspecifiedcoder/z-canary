import test from 'node:test';
import assert from 'node:assert/strict';
import { runVaultChallenge, restoreChallengeThreshold, recoverChallenge, rejectWrongChallengeRecipient } from '../src/experience/breakVault';
import { CASE_DOSSIER, downloadCaseStudy } from '../src/experience/caseStudy';

test('two-share challenge blocks real recovery then restores threshold and downloads exact bytes', () => {
  let result = runVaultChallenge('two-shares');
  assert.equal(result.scenario.step, 'insufficient');
  assert.equal(result.scenario.vault!.deliveredSharesToRecipient.length, 2);
  assert.throws(() => recoverChallenge(result));
  assert.throws(() => downloadCaseStudy(result.scenario));
  result = restoreChallengeThreshold(result);
  assert.equal(result.scenario.vault!.deliveredSharesToRecipient.length, 3);
  assert.equal(result.scenario.vault!.keepers.filter(k => !k.online).length, 2);
  const originalId = result.scenario.vault!.id;
  result = rejectWrongChallengeRecipient(result);
  assert.equal(result.scenario.vault!.id, originalId);
  assert.equal(result.scenario.step, 'wrong-key');
  assert.equal(result.scenario.verified, false);
  result = recoverChallenge(result);
  assert.equal(new TextDecoder().decode(downloadCaseStudy(result.scenario)), CASE_DOSSIER);
});

test('wrong-recipient challenge reaches quorum but fails identity check before Noor succeeds', () => {
  const blocked = runVaultChallenge('wrong-key');
  assert.equal(blocked.scenario.step, 'wrong-key');
  assert.equal(blocked.scenario.vault!.deliveredSharesToRecipient.length, 3);
  assert.equal(blocked.scenario.verified, false);
  assert.throws(() => downloadCaseStudy(blocked.scenario));
  assert.equal(recoverChallenge(blocked).scenario.verified, true);
});

test('stale scans prevent delivery and cancellation is terminal past grace', () => {
  const stale = runVaultChallenge('stale-scan');
  assert.equal(stale.scenario.vault!.deliveredSharesToRecipient.length, 0);
  assert.ok(stale.scenario.vault!.keepers.every(k => k.scannerHealth === 'DELAYED_SCAN'));
  assert.equal(recoverChallenge(restoreChallengeThreshold(stale)).scenario.verified, true);
  const cancelled = runVaultChallenge('cancel');
  assert.ok(cancelled.scenario.height > cancelled.scenario.vault!.graceDeadlineHeight);
  assert.ok(cancelled.scenario.vault!.keepers.every(k => k.lifecycleState === 'CANCELLED'));
  assert.equal(cancelled.scenario.vault!.deliveredSharesToRecipient.length, 0);
  assert.throws(() => recoverChallenge(cancelled));
  assert.throws(() => restoreChallengeThreshold(cancelled));
});

test('each challenge uses fresh vault and recipient keys without inheriting release', () => {
  const released = recoverChallenge(runVaultChallenge('wrong-key'));
  const fresh = runVaultChallenge('two-shares');
  assert.notEqual(released.scenario.vault!.id, fresh.scenario.vault!.id);
  assert.notEqual(released.scenario.recipient!.publicKeyHex, fresh.scenario.recipient!.publicKeyHex);
  assert.equal(fresh.scenario.verified, false);
});
