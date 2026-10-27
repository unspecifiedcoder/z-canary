import test from 'node:test';
import assert from 'node:assert/strict';
import { createCipheriv, createPublicKey, verify } from 'node:crypto';
import { aeadEncrypt, aeadDecrypt, encryptDossierDualLayer, decryptDossierDualLayer, deriveX25519PublicKey, packageDigest } from '../src/crypto/envelope';
import { deriveSourcePublicKey, encodeShieldedMemo, decodeAndValidateMemo, MemoOperation, ZcashNetwork } from '../src/crypto/memoCodec';
import { bytesToHex, hexToBytes, sha256Hex, splitSecret, reconstructSecret } from '../src/crypto/shamir';
import { buildDeterministicManifest, createInitialPreloadedSetup, suspendVaultForReorg, synchronizeVaultWithChain, verifyManifest, type ChainTransaction, type ContinuityVault } from '../src/engine/protocolStore';
import { runAllAcceptanceTests } from '../src/engine/testSuite';

function command(vault: ContinuityVault, operation: MemoOperation, height: number, expiry = 0, sequence = 1n): ChainTransaction {
  const memo = encodeShieldedMemo({ version: 1, network: ZcashNetwork.TESTNET, operation,
    switchIdHex: vault.manifest.switchIdHex, manifestDigestHex: vault.manifest.manifestDigestHex,
    sourcePubKeyHex: vault.sourcePubKeyHex, sequence, requestedExpiryHeight: expiry,
  }, vault.sourceSecretHex);
  return { txid: sha256Hex(memo), operationId: 'test', vaultId: vault.id, operation,
    sequence: Number(sequence), requestedExpiryHeight: expiry, memoHex: bytesToHex(memo),
    feeZatoshi: 10000, submittedAtHeight: height - 1, minedAtHeight: height,
    blockHash: sha256Hex(String(height)), confirmations: 2, status: 'CONFIRMED', timestamp: 'fixture',
  };
}

test('Ed25519 uses RFC 8032 public keys and verifies independently in Node', () => {
  const seed = '9d61b19deffd5a60ba844af492ec2cc44449c5697b326919703bac031cae7f60';
  assert.equal(deriveSourcePublicKey(seed), 'd75a980182b10ab7d54bfed3c964073a0ee172f3daa62325af021a68f707511a');
  const { vault } = createInitialPreloadedSetup();
  const memo = hexToBytes(command(vault, MemoOperation.CANCEL, 2845101).memoHex);
  const publicKey = createPublicKey({ key: Buffer.concat([Buffer.from('302a300506032b6570032100', 'hex'), Buffer.from(vault.sourcePubKeyHex, 'hex')]), format: 'der', type: 'spki' });
  assert.equal(verify(null, Buffer.concat([Buffer.from('ZCANARY-MEMO-SIG-V1'), memo.subarray(0,448)]), publicKey, memo.subarray(448)), true);
  assert.equal(decodeAndValidateMemo(memo).valid, true);
  memo[500] ^= 1;
  assert.equal(decodeAndValidateMemo(memo).errorCode, 'ERR_MEMO_BAD_SIGNATURE');
});

test('a source public key alone cannot forge a cancellation', () => {
  const { vault } = createInitialPreloadedSetup();
  assert.throws(() => encodeShieldedMemo({version:1, network:1, operation:3,
    switchIdHex:vault.manifest.switchIdHex, sequence:1n, requestedExpiryHeight:0,
    manifestDigestHex:vault.manifest.manifestDigestHex, sourcePubKeyHex:vault.sourcePubKeyHex,
  }, vault.sourcePubKeyHex), /Signing key/);
});

test('memo integers and hex are rejected instead of truncated', () => {
  assert.throws(() => hexToBytes('0g'));
  const {vault} = createInitialPreloadedSetup();
  assert.throws(() => command(vault, MemoOperation.POSTPONE, 1, 2**32));
  assert.throws(() => command(vault, MemoOperation.POSTPONE, 1, -1));
  assert.throws(() => command(vault, MemoOperation.CANCEL, 1, 0, 2n**64n));
});

test('X25519 public key matches RFC 7748', () => {
  assert.equal(deriveX25519PublicKey('77076d0a7318a57d3c16c17251b26645df4c2f87ebc0992ab177fba51db92c2a'),
    '8520f0098930a754748b7ddcb43ef75a0dbf3a0d26381af4eba4a98eaa9b4e6a');
});

test('AES-256-GCM ciphertext and tag match Node OpenSSL', () => {
  const key = new Uint8Array(32), nonce = new Uint8Array(12), plain = new Uint8Array([0,255,128,0,50]);
  const cipher = createCipheriv('aes-256-gcm', key, nonce);
  const expected = Buffer.concat([cipher.update(plain), cipher.final(), cipher.getAuthTag()]);
  assert.deepEqual(aeadEncrypt(key,nonce,plain), new Uint8Array(expected));
  assert.deepEqual(aeadDecrypt(key,nonce,expected),plain);
  expected[0] ^= 1;
  assert.throws(() => aeadDecrypt(key,nonce,expected));
});

test('binary dossier roundtrips, wrong recipient and modified metadata fail', () => {
  const secret = sha256Hex('recipient');
  const pub = deriveX25519PublicKey(secret);
  const release = hexToBytes(sha256Hex('release'));
  const plain = Uint8Array.from({length:256}, (_,i)=>i);
  const pkg = encryptDossierDualLayer(plain,pub,release);
  assert.deepEqual(decryptDossierDualLayer(pkg,release,secret,pub,pkg.outerPackageDigestHex),plain);
  assert.throws(() => decryptDossierDualLayer(pkg,release,sha256Hex('attacker'),pub,pkg.outerPackageDigestHex));
  const bad = {...pkg, ephemeralPubKeyHex:deriveX25519PublicKey(sha256Hex('other'))};
  bad.outerPackageDigestHex = packageDigest(bad);
  assert.throws(() => decryptDossierDualLayer(bad,release,secret,pub,pkg.outerPackageDigestHex),/TAMPERED/);
});

test('all ten distinct three-share subsets reconstruct', () => {
  const secret = hexToBytes(sha256Hex('share-secret')), id = sha256Hex('switch');
  const shares = splitSecret(secret,id);
  const commitments = Object.fromEntries(shares.map(s=>[s.index,s.commitmentHex]));
  for(let a=0;a<3;a++) for(let b=a+1;b<4;b++) for(let c=b+1;c<5;c++) {
    assert.deepEqual(reconstructSecret([shares[a],shares[b],shares[c]],id,1,commitments), secret);
  }
  assert.throws(()=>reconstructSecret(shares.slice(0,2),id,1,commitments),/INSUFFICIENT/);
  assert.throws(()=>reconstructSecret([...shares.slice(0,3),shares[0]],id,1,commitments),/DUPLICATE/);
  assert.throws(()=>reconstructSecret([{...shares[0],keeperId:'keeper-05'},shares[1],shares[2]],id,1,commitments),/KEEPER_MISMATCH/);
  assert.throws(()=>reconstructSecret(shares,id,2,commitments),/EPOCH/);
});

test('manifest signature binds the policy before any keeper release', () => {
  const {vault,transactions} = createInitialPreloadedSetup();
  assert.equal(verifyManifest(vault.manifest),true);
  vault.manifest.graceBlocks = 0;
  assert.equal(verifyManifest(vault.manifest),false);
  assert.throws(()=>synchronizeVaultWithChain(vault,transactions,2845200),/MANIFEST_INVALID/);
});

test('manifest verification rejects a changed protocol discriminator', () => {
  const {vault} = createInitialPreloadedSetup();
  const changed = {...vault.manifest, protocolId: 'OTHER-PROTOCOL'};
  assert.equal(verifyManifest(changed as typeof vault.manifest), false);
});

test('manifest signing rejects invalid policies even from the legitimate source', () => {
  const {vault} = createInitialPreloadedSetup();
  for (const change of [
    {confirmationTarget: 0}, {confirmationTarget: NaN}, {graceBlocks: -1},
    {initialIntervalBlocks: 1.5}, {maxExtensionBlocks: 2 ** 32},
    {configurationEpoch: 0}, {packageSize: 10 * 1024 * 1024 + 65537},
    {shareCommitments: {...vault.manifest.shareCommitments, 6: sha256Hex('extra')}},
    {shareCommitments: {...vault.manifest.shareCommitments, 1: 'bad'}},
  ]) {
    assert.throws(() => buildDeterministicManifest({...vault.manifest, ...change}, vault.sourceSecretHex), /MANIFEST_POLICY/);
  }
});

test('tip at grace boundary cannot release before that block confirms', () => {
  const {vault,transactions} = createInitialPreloadedSetup();
  const next = synchronizeVaultWithChain(vault,transactions,vault.graceDeadlineHeight);
  assert.equal(next.deliveredSharesToRecipient.length,0);
  assert.equal(next.keepers[0].scanCursorHeight,vault.graceDeadlineHeight-1);
});

for (const operation of [MemoOperation.POSTPONE,MemoOperation.CANCEL]) {
  test('command included at inclusive grace boundary wins: '+operation, () => {
    const {vault,transactions} = createInitialPreloadedSetup();
    const boundary = vault.graceDeadlineHeight;
    const tx = command(vault,operation,boundary,operation===MemoOperation.POSTPONE ? boundary+20 : 0);
    const before = synchronizeVaultWithChain(vault,[...transactions,tx],boundary);
    assert.equal(before.deliveredSharesToRecipient.length,0);
    const after = synchronizeVaultWithChain(before,[...transactions,tx],boundary+1);
    assert.equal(after.deliveredSharesToRecipient.length,0);
    assert.equal(after.keepers[0].lifecycleState,operation===MemoOperation.POSTPONE?'ACTIVE':'CANCELLED');
  });
  test('command included after grace cannot rescue a delayed keeper: '+operation, () => {
    const {vault,transactions} = createInitialPreloadedSetup();
    const tx = command(vault,operation,vault.graceDeadlineHeight+1,operation===MemoOperation.POSTPONE ? vault.graceDeadlineHeight+20 : 0);
    const after = synchronizeVaultWithChain(vault,[...transactions,tx],vault.graceDeadlineHeight+4);
    assert.equal(after.keepers[0].lifecycleState,'RELEASED');
  });
}

test('delayed scans and backward confirmed cursor suspend release', () => {
  const {vault,transactions} = createInitialPreloadedSetup();
  vault.keepers.forEach(k=>k.scannerHealth='DELAYED_SCAN');
  assert.equal(synchronizeVaultWithChain(vault,transactions,2845200).deliveredSharesToRecipient.length,0);
  vault.keepers.forEach(k=>k.scannerHealth='HEALTHY');
  const backward = synchronizeVaultWithChain(vault,transactions,2845090);
  assert.ok(backward.keepers.every(k=>k.scannerHealth==='REORG_INCIDENT'));
});

test('cancel remains terminal across repeated processing and duplicate events', () => {
  const {vault,transactions} = createInitialPreloadedSetup();
  const cancel = command(vault,MemoOperation.CANCEL,2845102);
  const txs = [...transactions,cancel,cancel];
  const cancelled = synchronizeVaultWithChain(vault,txs,2845103);
  const later = synchronizeVaultWithChain(cancelled,txs,2845200);
  assert.equal(later.deliveredSharesToRecipient.length,0);
  assert.ok(later.keepers.every(k=>k.lifecycleState==='CANCELLED'));
});

test('simulated reorg freezes future processing and does not pretend to recall delivered shares', () => {
  const {vault,transactions} = createInitialPreloadedSetup();
  const incident = suspendVaultForReorg(vault, 2845098);
  assert.ok(incident.keepers.every(k => k.scannerHealth === 'REORG_INCIDENT'));
  assert.equal(synchronizeVaultWithChain(incident, transactions, 2845200).deliveredSharesToRecipient.length, 0);
  const released = synchronizeVaultWithChain(vault, transactions, vault.graceDeadlineHeight + 1);
  assert.equal(released.deliveredSharesToRecipient.length, 5);
  const afterRelease = suspendVaultForReorg(released, vault.graceDeadlineHeight - 1);
  assert.deepEqual(afterRelease.deliveredSharesToRecipient, released.deliveredSharesToRecipient);
  assert.match(afterRelease.timeline.at(-1)!.detail, /No canonical replay was performed/);
});

test('existing eight simulation checks pass and remain labelled as simulations', () => {
  const results=runAllAcceptanceTests();
  assert.equal(results.length,8);
  assert.deepEqual(results.filter(r=>!r.passed).map(r=>r.id),[]);
});
