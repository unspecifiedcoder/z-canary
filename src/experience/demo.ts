import { createInitialPreloadedSetup, formatBlockHash, synchronizeVaultWithChain, type ChainTransaction } from '../engine/protocolStore';
import { encodeShieldedMemo, MemoOperation } from '../crypto/memoCodec';
import { bytesToHex, reconstructSecret, sha256Hex } from '../crypto/shamir';
import { decryptDossierDualLayer } from '../crypto/envelope';

export function createGuidedScenario() {
  return { ...createInitialPreloadedSetup(2845100), height: 2845100, chapter: 0, verified: false };
}
export type GuidedScenario = ReturnType<typeof createGuidedScenario>;

/** Exercises the browser protocol. Never calls a wallet, agent or network endpoint. */
export function advanceGuidedScenario(previous: GuidedScenario): GuidedScenario {
  if (previous.chapter === 5) return createGuidedScenario();
  let { vault, transactions, height } = previous;
  const chapter = previous.chapter + 1;
  if (chapter === 1) {
    const sequence = vault.highestSequence + 1;
    const requestedExpiryHeight = vault.currentExpiryHeight + vault.manifest.initialIntervalBlocks;
    const memo = encodeShieldedMemo({ version: 1, network: vault.manifest.network, operation: MemoOperation.POSTPONE,
      switchIdHex: vault.manifest.switchIdHex, sequence: BigInt(sequence), requestedExpiryHeight,
      manifestDigestHex: vault.manifest.manifestDigestHex, sourcePubKeyHex: vault.sourcePubKeyHex }, vault.sourceSecretHex);
    const minedAtHeight = height + 1;
    const tx: ChainTransaction = { txid: sha256Hex(memo), operationId: 'guided-synthetic-checkin', vaultId: vault.id,
      operation: MemoOperation.POSTPONE, sequence, requestedExpiryHeight, memoHex: bytesToHex(memo), feeZatoshi: 10000,
      submittedAtHeight: height, minedAtHeight, blockHash: formatBlockHash(minedAtHeight),
      confirmations: vault.manifest.confirmationTarget, status: 'CONFIRMED', timestamp: 'Guided simulation' };
    transactions = [...transactions, tx]; height = minedAtHeight + vault.manifest.confirmationTarget - 1;
    vault = synchronizeVaultWithChain({ ...vault, highestSequence: sequence }, transactions, height);
  } else if (chapter === 2) {
    height = vault.currentExpiryHeight + vault.manifest.confirmationTarget - 1;
    vault = synchronizeVaultWithChain(vault, transactions, height);
  } else if (chapter === 3) {
    height = vault.graceDeadlineHeight + vault.manifest.confirmationTarget - 1;
    vault = { ...vault, keepers: vault.keepers.map(k => ({ ...k, online: k.index <= 3,
      scannerHealth: k.index <= 3 ? 'DELAYED_SCAN' as const : k.scannerHealth })) };
    vault = synchronizeVaultWithChain(vault, transactions, height);
  } else if (chapter === 4) {
    vault = { ...vault, keepers: vault.keepers.map(k => ({ ...k, scannerHealth: 'HEALTHY' as const })) };
    vault = synchronizeVaultWithChain(vault, transactions, height);
  } else {
    const key = reconstructSecret(vault.deliveredSharesToRecipient, vault.manifest.switchIdHex, vault.manifest.configurationEpoch, vault.manifest.shareCommitments, vault.manifest.threshold);
    try {
      const bytes = decryptDossierDualLayer(vault.encryptedPackage, key, previous.recipientIdentity.privateKeyHex,
        vault.manifest.recipientPubKeyHex, vault.manifest.packageDigestHex);
      bytes.fill(0);
    } finally { key.fill(0); }
    vault = { ...vault, decryptedByRecipient: true };
  }
  return { ...previous, chapter, height, vault, transactions, verified: chapter === 5 };
}

export function recoverGuidedFixture(scenario: GuidedScenario): Uint8Array {
  if (!scenario.verified || scenario.chapter !== 5) throw new Error('Complete verified recovery first.');
  const { vault } = scenario;
  const key = reconstructSecret(vault.deliveredSharesToRecipient, vault.manifest.switchIdHex, vault.manifest.configurationEpoch, vault.manifest.shareCommitments, vault.manifest.threshold);
  try { return decryptDossierDualLayer(vault.encryptedPackage, key, scenario.recipientIdentity.privateKeyHex, vault.manifest.recipientPubKeyHex, vault.manifest.packageDigestHex); }
  finally { key.fill(0); }
}
