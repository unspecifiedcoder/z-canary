import { generateRecipientIdentity, encryptDossierDualLayer, decryptDossierDualLayer, type RecipientIdentity } from '../crypto/envelope';
import { bytesToHex, splitSecret, reconstructSecret, sha256Hex } from '../crypto/shamir';
import { deriveSourcePublicKey, encodeShieldedMemo, MemoOperation, ZcashNetwork } from '../crypto/memoCodec';
import { buildDeterministicManifest, formatBlockHash, synchronizeVaultWithChain, type ContinuityVault, type ChainTransaction, type KeeperInstance } from '../engine/protocolStore';

/** Public fictional fixture only. This example never accepts private user evidence. */
export const CASE_DOSSIER = `RIVERGATE REPORTING NOTES — FICTIONAL DEMO
Owner: Maya, reporter
Designated recipient: Noor, editor

This is a harmless public test file, not an allegation or real investigation.
Maya is preparing a report about a fictional community garden. Her notes
include an interview checklist, a meeting date, and questions to verify.

If Maya cannot check in, Noor should be able to continue the reporting.
No passwords, private sources, personal records, or real evidence are here.
END OF PUBLIC DEMO FILE
`;
export const CASE_FILENAME = 'Maya-Rivergate-demo-notes.txt';
export type CaseStep = 'intro' | 'protected' | 'early-blocked' | 'checked-in' | 'cancelled' | 'grace' | 'scan-paused' | 'insufficient' | 'ready' | 'wrong-key' | 'recovered';
export type CaseAction = 'protect' | 'try-early' | 'check-in' | 'cancel' | 'miss-check-in' | 'pause-scans' | 'resume-two' | 'restore-third' | 'try-wrong-key' | 'recover';
export interface CaseStudy {
  step: CaseStep;
  height: number;
  vault: ContinuityVault | null;
  recipient: RecipientIdentity | null;
  transactions: ChainTransaction[];
  previousExpiry: number | null;
  verified: boolean;
  receipt: string;
}
export function createCaseStudy(): CaseStudy {
  return { step: 'intro', height: 1000, vault: null, recipient: null, transactions: [], previousExpiry: null, verified: false, receipt: 'Maya has a file. Noor is the one person she wants to receive it.' };
}
function command(vault: ContinuityVault, height: number, operation: MemoOperation, sequence: number, requestedExpiryHeight: number): ChainTransaction {
  const memo = encodeShieldedMemo({ version: 1, network: ZcashNetwork.TESTNET, operation,
    switchIdHex: vault.manifest.switchIdHex, sequence: BigInt(sequence), requestedExpiryHeight,
    manifestDigestHex: vault.manifest.manifestDigestHex, sourcePubKeyHex: vault.sourcePubKeyHex }, vault.sourceSecretHex);
  return { txid: sha256Hex(memo), operationId: `case-${operation}-${sequence}`, vaultId: vault.id,
    operation, sequence, requestedExpiryHeight, memoHex: bytesToHex(memo), feeZatoshi: 0,
    submittedAtHeight: height, minedAtHeight: height, blockHash: formatBlockHash(height),
    confirmations: 2, status: 'CONFIRMED', timestamp: 'Fictional example / simulated confirmation' };
}
function protect(): CaseStudy {
  const recipient = generateRecipientIdentity('Noor · fictional editor');
  const sourceSecretHex = bytesToHex(crypto.getRandomValues(new Uint8Array(32)));
  const sourcePubKeyHex = deriveSourcePublicKey(sourceSecretHex);
  const switchIdHex = bytesToHex(crypto.getRandomValues(new Uint8Array(32)));
  const releaseKey = crypto.getRandomValues(new Uint8Array(32));
  const plain = new TextEncoder().encode(CASE_DOSSIER);
  try {
    const encryptedPackage = encryptDossierDualLayer(plain, recipient.publicKeyHex, releaseKey);
    const shares = splitSecret(releaseKey, switchIdHex, 1, 5, 3);
    const shareCommitments = Object.fromEntries(shares.map(s => [s.index, s.commitmentHex]));
    const manifest = buildDeterministicManifest({ network: ZcashNetwork.TESTNET, switchIdHex,
      sourcePubKeyHex, recipientPubKeyHex: recipient.publicKeyHex, packageDigestHex: encryptedPackage.outerPackageDigestHex,
      packageSize: encryptedPackage.encryptedSize, initialIntervalBlocks: 24, graceBlocks: 6,
      confirmationTarget: 2, maxExtensionBlocks: 10000, threshold: 3, configurationEpoch: 1, shareCommitments }, sourceSecretHex);
    const keepers: KeeperInstance[] = shares.map(share => ({ index: share.index, id: `keeper-0${share.index}`,
      name: `Keeper ${share.index}`, operatorLabel: 'Simulated in this browser', endpoint: 'simulation://local', dbPath: 'memory',
      online: true, scannerHealth: 'HEALTHY', scanCursorHeight: 999, scanCursorBlockHash: formatBlockHash(999),
      lifecycleState: 'REGISTERING', provisionedShare: share, provisionedAckSignature: null,
      lastSequence: null, expiryHeight: 1024, graceDeadlineHeight: 1030, outboxDelivered: false,
      deliveryIdempotencyKey: null, logs: [] }));
    let vault: ContinuityVault = { id: `case-${switchIdHex}`, title: 'Maya → Noor: Rivergate reporting notes', fileName: CASE_FILENAME,
      mimeType: 'text/plain', createdAt: 'Fictional example', profileMode: 'TESTNET_DEMO', sourceSecretHex, sourcePubKeyHex,
      manifest, encryptedPackage, keepers, highestSequence: 0, registeredAtHeight: 1000,
      currentExpiryHeight: 1024, graceDeadlineHeight: 1030, deliveredSharesToRecipient: [],
      decryptedByRecipient: false, decryptedContentText: null, timeline: [] };
    const transactions = [command(vault, 1000, MemoOperation.REGISTER, 0, 1024)];
    vault = synchronizeVaultWithChain(vault, transactions, 1001);
    if (!vault.keepers.every(k => k.lifecycleState === 'ACTIVE')) throw new Error('Registration did not activate all simulated keepers.');
    return { step: 'protected', height: 1001, vault, recipient, transactions, previousExpiry: null, verified: false,
      receipt: 'The file was encrypted locally. A signed registration was accepted by all five simulated keepers.' };
  } finally { releaseKey.fill(0); plain.fill(0); }
}
function recoverBytes(s: CaseStudy, privateKey = s.recipient?.privateKeyHex): Uint8Array {
  if (!s.vault || !privateKey) throw new Error('No recipient package.');
  const v = s.vault;
  const releaseKey = reconstructSecret(v.deliveredSharesToRecipient, v.manifest.switchIdHex, v.manifest.configurationEpoch, v.manifest.shareCommitments, v.manifest.threshold);
  try { return decryptDossierDualLayer(v.encryptedPackage, releaseKey, privateKey, v.manifest.recipientPubKeyHex, v.manifest.packageDigestHex); }
  finally { releaseKey.fill(0); }
}
export function downloadCaseStudy(s: CaseStudy): Uint8Array {
  if (!s.verified || s.step !== 'recovered') throw new Error('Complete verified recovery first.');
  return recoverBytes(s);
}
const allowed: Record<CaseAction, CaseStep[]> = {
  protect: ['intro'], 'try-early': ['protected'], 'check-in': ['protected', 'early-blocked', 'grace'],
  cancel: ['protected', 'early-blocked', 'checked-in', 'grace'], 'miss-check-in': ['protected', 'early-blocked', 'checked-in'],
  'pause-scans': ['grace'], 'resume-two': ['scan-paused'], 'restore-third': ['insufficient'],
  'try-wrong-key': ['ready'], recover: ['ready', 'wrong-key'],
};
/** A real browser-engine transition. Blocks, confirmations and keeper availability are synthetic. */
export function actOnCaseStudy(previous: CaseStudy, action: CaseAction): CaseStudy {
  if (!allowed[action].includes(previous.step)) throw new Error('This action does not apply to the current case state.');
  if (action === 'protect') return protect();
  if (!previous.vault) throw new Error('Create the protected package first.');
  let vault = previous.vault, height = previous.height;
  let transactions = previous.transactions;
  if (action === 'try-early') {
    let blocked = false;
    try { recoverBytes(previous).fill(0); } catch { blocked = true; }
    if (!blocked) throw new Error('The early-recovery guard did not reject this attempt.');
    return { ...previous, step: 'early-blocked', receipt: 'Recovery was rejected: Noor has zero of the three required shares. The file stays encrypted.' };
  }
  if (action === 'check-in' || action === 'cancel') {
    const sequence = vault.highestSequence + 1;
    const expiry = action === 'check-in' ? vault.currentExpiryHeight + vault.manifest.initialIntervalBlocks : 0;
    const tx = command(vault, height + 1, action === 'check-in' ? MemoOperation.POSTPONE : MemoOperation.CANCEL, sequence, expiry);
    transactions = [...transactions, tx]; height += 2;
    vault = synchronizeVaultWithChain({ ...vault, highestSequence: sequence }, transactions, height);
    if (action === 'cancel') {
      // Advance beyond the original boundary to demonstrate that cancellation remains terminal.
      height = Math.max(height, vault.graceDeadlineHeight + 5);
      vault = synchronizeVaultWithChain(vault, transactions, height);
    }
    return { ...previous, vault, height, transactions, previousExpiry: previous.vault.currentExpiryHeight,
      step: action === 'check-in' ? 'checked-in' : 'cancelled',
      receipt: action === 'check-in' ? 'All five simulated keepers verified Maya’s signed check-in. The deadline moved forward.' : 'All five keepers accepted the signed cancellation. Even after the old deadline, zero shares were released.' };
  }
  if (action === 'miss-check-in') {
    height = vault.currentExpiryHeight + vault.manifest.confirmationTarget - 1;
    vault = synchronizeVaultWithChain(vault, transactions, height);
    return { ...previous, vault, height, step: 'grace', receipt: 'Maya missed the deadline. The six-block grace window is now open; no shares have been released.' };
  }
  if (action === 'pause-scans') {
    height = vault.graceDeadlineHeight + vault.manifest.confirmationTarget - 1;
    vault = synchronizeVaultWithChain({ ...vault, keepers: vault.keepers.map(k => ({ ...k, scannerHealth: 'DELAYED_SCAN' })) }, transactions, height);
    return { ...previous, vault, height, step: 'scan-paused', receipt: 'The grace boundary has been reached, but every scanner is stale. Release remains paused with zero shares.' };
  }
  if (action === 'resume-two') {
    vault = synchronizeVaultWithChain({ ...vault, keepers: vault.keepers.map(k => ({ ...k, online: k.index <= 2, scannerHealth: 'HEALTHY' })) }, transactions, height);
    let blocked = false;
    try { recoverBytes({ ...previous, vault }).fill(0); } catch { blocked = true; }
    if (!blocked) throw new Error('The below-threshold guard did not reject this attempt.');
    return { ...previous, vault, step: 'insufficient', receipt: 'Two healthy keepers delivered valid shares. A real reconstruction attempt was rejected: two is fewer than three.' };
  }
  if (action === 'restore-third') {
    vault = synchronizeVaultWithChain({ ...vault, keepers: vault.keepers.map(k => ({ ...k, online: k.index <= 3 })) }, transactions, height);
    return { ...previous, vault, step: 'ready', receipt: 'Keeper 3 scanned the confirmed history and delivered a valid share. Noor now has three distinct shares; two keepers remain offline.' };
  }
  if (action === 'try-wrong-key') {
    const wrong = generateRecipientIdentity('Wrong recipient for this public test');
    let blocked = false;
    try { recoverBytes(previous, wrong.privateKeyHex).fill(0); } catch { blocked = true; }
    if (!blocked) throw new Error('The recipient-key guard did not reject this attempt.');
    return { ...previous, step: 'wrong-key', receipt: 'A different recipient key was rejected. Three shares do not replace Noor’s private identity.' };
  }
  const bytes = recoverBytes(previous);
  try {
    if (sha256Hex(bytes) !== sha256Hex(CASE_DOSSIER)) throw new Error('The recovered public file did not match.');
    return { ...previous, vault: { ...vault, decryptedByRecipient: true }, verified: true, step: 'recovered',
      receipt: 'Noor decrypted the original file. Its SHA-256 digest matches the source, byte for byte.' };
  } finally { bytes.fill(0); }
}
