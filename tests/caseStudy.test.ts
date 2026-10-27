import test from 'node:test';
import assert from 'node:assert/strict';
import { actOnCaseStudy as act, createCaseStudy, downloadCaseStudy, CASE_DOSSIER } from '../src/experience/caseStudy';
import { verifyManifest } from '../src/engine/protocolStore';
import { decodeAndValidateMemo } from '../src/crypto/memoCodec';
import { hexToBytes } from '../src/crypto/shamir';

test('Maya/Noor example runs actual encryption, signed check-in, scanner guards, threshold and exact recovery', () => {
  let s = act(createCaseStudy(), 'protect');
  assert.ok(s.vault); assert.ok(verifyManifest(s.vault.manifest));
  assert.ok(s.vault.keepers.every(k => k.lifecycleState === 'ACTIVE'));
  assert.notEqual(s.vault.encryptedPackage.outerCiphertextBase64, CASE_DOSSIER);
  assert.throws(() => downloadCaseStudy(s));
  s = act(s, 'try-early'); assert.equal(s.step, 'early-blocked');
  const original = s.vault!.currentExpiryHeight;
  s = act(s, 'check-in');
  assert.equal(s.vault!.currentExpiryHeight, original + 24);
  assert.ok(s.vault!.keepers.every(k => k.lastSequence === 1n));
  assert.equal(decodeAndValidateMemo(hexToBytes(s.transactions[1].memoHex), s.vault!.manifest.network).valid, true);
  s = act(s, 'miss-check-in');
  assert.ok(s.vault!.keepers.every(k => k.lifecycleState === 'GRACE'));
  assert.equal(s.vault!.deliveredSharesToRecipient.length, 0);
  s = act(s, 'pause-scans');
  assert.ok(s.vault!.keepers.every(k => k.scannerHealth === 'DELAYED_SCAN'));
  assert.equal(s.vault!.deliveredSharesToRecipient.length, 0);
  s = act(s, 'resume-two');
  assert.equal(s.step, 'insufficient'); assert.equal(s.vault!.deliveredSharesToRecipient.length, 2);
  s = act(s, 'restore-third');
  assert.equal(s.vault!.deliveredSharesToRecipient.length, 3);
  assert.equal(s.vault!.keepers.filter(k => !k.online).length, 2);
  s = act(s, 'try-wrong-key'); assert.equal(s.step, 'wrong-key'); assert.equal(s.verified, false);
  s = act(s, 'recover');
  assert.equal(s.verified, true);
  assert.equal(new TextDecoder().decode(downloadCaseStudy(s)), CASE_DOSSIER);
});

test('Maya cancellation is signed and remains terminal beyond the old release boundary', () => {
  let s = act(act(createCaseStudy(), 'protect'), 'check-in');
  s = act(s, 'cancel');
  assert.ok(s.height > s.vault!.graceDeadlineHeight);
  assert.ok(s.vault!.keepers.every(k => k.lifecycleState === 'CANCELLED'));
  assert.equal(s.vault!.deliveredSharesToRecipient.length, 0);
  assert.throws(() => act(s, 'miss-check-in'));
  assert.throws(() => act(s, 'recover'));
  assert.throws(() => downloadCaseStudy(s));
});

test('a signed check-in inside grace restores active protection', () => {
  let s = act(act(createCaseStudy(), 'protect'), 'miss-check-in');
  const expiry = s.vault!.currentExpiryHeight;
  s = act(s, 'check-in');
  assert.equal(s.vault!.currentExpiryHeight, expiry + 24);
  assert.ok(s.vault!.keepers.every(k => k.lifecycleState === 'ACTIVE'));
  assert.equal(s.vault!.deliveredSharesToRecipient.length, 0);
});

test('reset creates fresh random keys and cannot inherit a recovered or cancelled state', () => {
  const one = act(createCaseStudy(), 'protect');
  const two = act(createCaseStudy(), 'protect');
  assert.notEqual(one.vault!.sourceSecretHex, two.vault!.sourceSecretHex);
  assert.notEqual(one.recipient!.privateKeyHex, two.recipient!.privateKeyHex);
  assert.equal(createCaseStudy().vault, null);
  assert.throws(() => act(createCaseStudy(), 'recover'));
});
