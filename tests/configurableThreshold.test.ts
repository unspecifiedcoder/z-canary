import test from 'node:test';
import assert from 'node:assert/strict';
import { generateRecipientIdentity, encryptDossierDualLayer, decryptDossierDualLayer } from '../src/crypto/envelope';
import { bytesToHex, reconstructSecret, sha256Hex, splitSecret } from '../src/crypto/shamir';
import { deriveSourcePublicKey, ZcashNetwork } from '../src/crypto/memoCodec';
import { buildDeterministicManifest, verifyManifest } from '../src/engine/protocolStore';

for (const threshold of [2, 3, 4, 5]) {
  test(`${threshold}-of-5 policy blocks one-short recovery and permits only its chosen recipient`, () => {
    const recipient = generateRecipientIdentity(`threshold-${threshold} recipient`);
    const wrongRecipient = generateRecipientIdentity('wrong recipient');
    const sourceSecretHex = bytesToHex(crypto.getRandomValues(new Uint8Array(32)));
    const sourcePubKeyHex = deriveSourcePublicKey(sourceSecretHex);
    const switchIdHex = bytesToHex(crypto.getRandomValues(new Uint8Array(32)));
    const releaseKey = crypto.getRandomValues(new Uint8Array(32));
    const plaintext = new TextEncoder().encode(`judge-owned Canary threshold ${threshold}`);
    try {
      const encryptedPackage = encryptDossierDualLayer(plaintext, recipient.publicKeyHex, releaseKey);
      const shares = splitSecret(releaseKey, switchIdHex, 1, 5, threshold);
      const shareCommitments = Object.fromEntries(shares.map(share => [share.index, share.commitmentHex]));
      const manifest = buildDeterministicManifest({
        network: ZcashNetwork.TESTNET,
        switchIdHex,
        sourcePubKeyHex,
        recipientPubKeyHex: recipient.publicKeyHex,
        packageDigestHex: encryptedPackage.outerPackageDigestHex,
        packageSize: encryptedPackage.encryptedSize,
        initialIntervalBlocks: 24,
        graceBlocks: 6,
        confirmationTarget: 2,
        maxExtensionBlocks: 10000,
        threshold,
        configurationEpoch: 1,
        shareCommitments,
      }, sourceSecretHex);

      assert.equal(manifest.threshold, threshold);
      assert.equal(verifyManifest(manifest), true);
      assert.throws(() => reconstructSecret(shares.slice(0, threshold - 1), switchIdHex, 1, shareCommitments, threshold), /THRESHOLD_INSUFFICIENT/);

      const reconstructed = reconstructSecret(shares.slice(0, threshold), switchIdHex, 1, shareCommitments, threshold);
      try {
        assert.equal(bytesToHex(reconstructed), bytesToHex(releaseKey));
        assert.throws(() => decryptDossierDualLayer(encryptedPackage, reconstructed, wrongRecipient.privateKeyHex, recipient.publicKeyHex, manifest.packageDigestHex), /WRONG_RECIPIENT_KEY/);
        const recovered = decryptDossierDualLayer(encryptedPackage, reconstructed, recipient.privateKeyHex, recipient.publicKeyHex, manifest.packageDigestHex);
        try {
          assert.equal(new TextDecoder().decode(recovered), new TextDecoder().decode(plaintext));
          assert.equal(sha256Hex(recovered), encryptedPackage.plaintextDigestHex);
        } finally { recovered.fill(0); }
      } finally { reconstructed.fill(0); }
    } finally {
      releaseKey.fill(0);
      plaintext.fill(0);
    }
  });
}
