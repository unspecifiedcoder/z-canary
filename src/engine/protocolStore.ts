import { ed25519 } from '@noble/curves/ed25519.js';
import {
  bytesToHex,
  computeShareCommitment,
  hexToBytes,
  KeeperShare,
  reconstructSecret,
  sha256Hex,
  splitSecret,
} from '../crypto/shamir';
import {
  decodeAndValidateMemo,
  deriveSourcePublicKey,
  encodeShieldedMemo,
  MemoOperation,
  ZcashNetwork,
} from '../crypto/memoCodec';
import {
  computeKeyFingerprint,
  decryptDossierDualLayer,
  deriveX25519PublicKey,
  EncryptedVaultPackage,
  encryptDossierDualLayer,
  RecipientIdentity,
} from '../crypto/envelope';

export type VaultLifecycleState =
  | 'DRAFT'
  | 'REGISTERING'
  | 'ACTIVE'
  | 'GRACE'
  | 'RELEASED'
  | 'CANCELLED';

export type ScannerHealthState = 'HEALTHY' | 'DELAYED_SCAN' | 'REORG_INCIDENT';

export interface ImmutableManifest {
  protocolId: 'Z-CANARY-V1';
  network: ZcashNetwork;
  switchIdHex: string;
  sourcePubKeyHex: string;
  recipientPubKeyHex: string;
  recipientFingerprint: string;
  packageDigestHex: string;
  packageSize: number;
  initialIntervalBlocks: number;
  graceBlocks: number;
  confirmationTarget: number;
  maxExtensionBlocks: number;
  keeperIds: string[];
  threshold: number;
  configurationEpoch: number;
  shareCommitments: Record<number, string>;
  sourceSignatureHex: string;
  manifestDigestHex: string;
}

export interface KeeperInstance {
  index: number; // 1..5
  id: string;
  name: string;
  operatorLabel: string;
  endpoint: string;
  dbPath: string;
  online: boolean;
  scannerHealth: ScannerHealthState;
  scanCursorHeight: number;
  scanCursorBlockHash: string;
  lifecycleState: VaultLifecycleState;
  provisionedShare: KeeperShare | null;
  provisionedAckSignature: string | null;
  lastSequence: bigint | null;
  expiryHeight: number;
  graceDeadlineHeight: number;
  outboxDelivered: boolean;
  deliveryIdempotencyKey: string | null;
  logs: string[];
}

export interface ChainTransaction {
  txid: string;
  operationId: string;
  vaultId: string;
  operation: MemoOperation;
  sequence: number;
  requestedExpiryHeight: number;
  memoHex: string;
  transactionIndex?: number;
  outputIndex?: number;
  feeZatoshi: number;
  submittedAtHeight: number;
  minedAtHeight: number | null;
  blockHash: string | null;
  confirmations: number;
  status: 'BROADCAST' | 'MINED' | 'CONFIRMED' | 'ORPHANED';
  timestamp: string;
}

export interface VaultTimelineEvent {
  id: string;
  type:
    | 'PACKAGE_ENCRYPTED'
    | 'KEEPERS_PROVISIONED'
    | 'REGISTRATION_BROADCAST'
    | 'REGISTRATION_CONFIRMED'
    | 'CHECKIN_CONFIRMED'
    | 'GRACE_STARTED'
    | 'POSTPONED_IN_GRACE'
    | 'DELIVERY_AUTHORIZED'
    | 'CANCELLED'
    | 'REORG_DETECTED'
    | 'RECIPIENT_DECRYPTED';
  title: string;
  detail: string;
  blockHeight: number;
  txid?: string;
  timestamp: string;
}

export interface ContinuityVault {
  id: string;
  title: string;
  fileName: string;
  mimeType: string;
  createdAt: string;
  profileMode: 'TESTNET_DEMO' | 'STANDARD_PRODUCTION';
  sourceSecretHex: string;
  sourcePubKeyHex: string;
  manifest: ImmutableManifest;
  encryptedPackage: EncryptedVaultPackage;
  keepers: KeeperInstance[];
  highestSequence: number;
  registeredAtHeight: number | null;
  currentExpiryHeight: number;
  graceDeadlineHeight: number;
  deliveredSharesToRecipient: KeeperShare[];
  decryptedByRecipient: boolean;
  decryptedContentText: string | null; // Base64 bytes for an exact download; historical field name.
  timeline: VaultTimelineEvent[];
}

export interface ShieldedSupportTransaction {
  id: string;
  txid: string;
  amountZatoshi: number;
  blockHeight: number;
  confirmations: number;
  timestamp: string;
  note: string;
}

export const SYNTHETIC_DOSSIER_CONTENT = `CONFIDENTIAL CONTINUITY DOSSIER // SYNTHETIC TEST ARTIFACT
Document Reference: ZCAN-2026-8841-OMEGA
Classification: RESTRICTED SOURCE DISCLOSURE (SYNTHETIC)
Prepared For: Elena Rostova, Senior Special Counsel (Designated Recipient)
Prepared By: Source Node #04 ("Vanguard")

========================================================================
1. EXECUTIVE SUMMARY OF SYNTHETIC EVIDENCE
========================================================================
Between Q1 and Q3 2026, internal audit logs from Meridian Clearing Corp
demonstrated systematic off-ledger settlement routing across three
unreported liquidity pools. Total synthetic discrepancy: 41,850,000 USD
equivalent.

This dossier is protected by Z-Canary Protocol v1:
- Outer Envelope: 256-bit AES-GCM Release Key split via GF(256) Shamir
  Secret Sharing (3-of-5 Keeper Threshold).
- Inner Envelope: X25519 Authenticated Encryption bound exclusively to
  Recipient Fingerprint.
- Continuity Mechanism: Zcash Testnet Shielded Memos (512-byte ZIP-302
  binary format with Ed25519 command verification).

========================================================================
2. CRYPTOGRAPHIC CUSTODY & VERIFICATION LOG
========================================================================
- Primary Ledger Evidence: Batch #994-A (SHA-256: 7f83b1657ff1fc53b92dc181)
- Custodian Witness Nodes: 5 in-memory keeper records
- Release Condition: Confirmed Zcash chain height exceeding Expiry + Grace
  boundary without valid Ed25519-signed Check-In command.

[END OF SYNTHETIC WHISTLEBLOWER DOSSIER — SIMULATION ONLY INTEGRITY]`;

export function formatBlockHash(height: number, forkSalt = 0): string {
  return sha256Hex(`zcash-testnet-block-${height}-fork-${forkSalt}`).slice(0, 64);
}

export interface ManifestFields {
  network: ZcashNetwork;
  switchIdHex: string;
  sourcePubKeyHex: string;
  recipientPubKeyHex: string;
  packageDigestHex: string;
  packageSize: number;
  initialIntervalBlocks: number;
  graceBlocks: number;
  confirmationTarget: number;
  maxExtensionBlocks: number;
  threshold: number;
  configurationEpoch: number;
  shareCommitments: Record<number, string>;
}

export function canonicalManifestBytes(params: ManifestFields): Uint8Array {
  // A valid signature does not make malformed policy values safe to execute.
  const isU32 = (value: number, minimum = 1) => Number.isInteger(value) && value >= minimum && value <= 0xffffffff;
  const isHash = (value: string) => typeof value === 'string' && /^[0-9a-f]{64}$/i.test(value);
  if (![ZcashNetwork.MAINNET, ZcashNetwork.TESTNET].includes(params.network) ||
      ![params.switchIdHex, params.sourcePubKeyHex, params.recipientPubKeyHex, params.packageDigestHex].every(isHash) ||
      !Number.isSafeInteger(params.packageSize) || params.packageSize < 32 || params.packageSize > 10 * 1024 * 1024 + 65536 ||
      ![params.initialIntervalBlocks, params.confirmationTarget, params.maxExtensionBlocks, params.configurationEpoch].every(value => isU32(value)) ||
      !isU32(params.graceBlocks, 0) || params.threshold !== 3 ||
      !params.shareCommitments || Object.keys(params.shareCommitments).sort().join(',') !== '1,2,3,4,5' ||
      ![1, 2, 3, 4, 5].every(index => isHash(params.shareCommitments[index]))) {
    throw new Error('ERR_MANIFEST_POLICY');
  }
  const recipientFingerprint = computeKeyFingerprint(params.recipientPubKeyHex);
  const keeperIds = ['keeper-01', 'keeper-02', 'keeper-03', 'keeper-04', 'keeper-05'];

  // Deterministic canonical serialization for manifest digest
  const canonicalString = JSON.stringify({
    protocolId: 'Z-CANARY-V1',
    network: params.network,
    switchIdHex: params.switchIdHex.toLowerCase(),
    sourcePubKeyHex: params.sourcePubKeyHex.toLowerCase(),
    recipientPubKeyHex: params.recipientPubKeyHex.toLowerCase(),
    packageDigestHex: params.packageDigestHex.toLowerCase(),
    packageSize: params.packageSize,
    initialIntervalBlocks: params.initialIntervalBlocks,
    graceBlocks: params.graceBlocks,
    confirmationTarget: params.confirmationTarget,
    maxExtensionBlocks: params.maxExtensionBlocks,
    keeperIds,
    threshold: params.threshold,
    configurationEpoch: params.configurationEpoch,
    shareCommitments: [1, 2, 3, 4, 5].map((idx) => params.shareCommitments[idx]?.toLowerCase() || ''),
  });

  return new TextEncoder().encode(canonicalString);
}

export function verifyManifest(manifest: ImmutableManifest): boolean {
  try {
    if (manifest.protocolId !== 'Z-CANARY-V1') return false;
    const bytes = canonicalManifestBytes(manifest);
    if (sha256Hex(bytes) !== manifest.manifestDigestHex || manifest.recipientFingerprint !== computeKeyFingerprint(manifest.recipientPubKeyHex)) return false;
    if (manifest.keeperIds.join(',') !== 'keeper-01,keeper-02,keeper-03,keeper-04,keeper-05' || manifest.threshold !== 3) return false;
    return ed25519.verify(hexToBytes(manifest.sourceSignatureHex), bytes, hexToBytes(manifest.sourcePubKeyHex), { zip215: false });
  } catch { return false; }
}

export function buildDeterministicManifest(params: ManifestFields, sourceSecretHex: string): ImmutableManifest {
  if (deriveSourcePublicKey(sourceSecretHex) !== params.sourcePubKeyHex) throw new Error('ERR_MANIFEST_SIGNER');
  const bytes = canonicalManifestBytes(params);
  const manifestDigestHex = sha256Hex(bytes);
  const sourceSignatureHex = bytesToHex(ed25519.sign(bytes, hexToBytes(sourceSecretHex)));
  const recipientFingerprint = computeKeyFingerprint(params.recipientPubKeyHex);
  const keeperIds = ['keeper-01', 'keeper-02', 'keeper-03', 'keeper-04', 'keeper-05'];

  return {
    protocolId: 'Z-CANARY-V1',
    network: params.network,
    switchIdHex: params.switchIdHex,
    sourcePubKeyHex: params.sourcePubKeyHex,
    recipientPubKeyHex: params.recipientPubKeyHex,
    recipientFingerprint,
    packageDigestHex: params.packageDigestHex,
    packageSize: params.packageSize,
    initialIntervalBlocks: params.initialIntervalBlocks,
    graceBlocks: params.graceBlocks,
    confirmationTarget: params.confirmationTarget,
    maxExtensionBlocks: params.maxExtensionBlocks,
    keeperIds,
    threshold: params.threshold,
    configurationEpoch: params.configurationEpoch,
    shareCommitments: params.shareCommitments,
    sourceSignatureHex,
    manifestDigestHex,
  };
}

const KEEPER_METADATA = [
  {
    index: 1,
    id: 'keeper-01',
    name: 'Keeper 01 (Zurich Shelf)',
    operatorLabel: 'Simulated keeper #1 · Port 9101',
    endpoint: 'http://127.0.0.1:9101',
    dbPath: './state/keeper_01.sqlite',
  },
  {
    index: 2,
    id: 'keeper-02',
    name: 'Keeper 02 (Reykjavik Relay)',
    operatorLabel: 'Simulated keeper #2 · Port 9102',
    endpoint: 'http://127.0.0.1:9102',
    dbPath: './state/keeper_02.sqlite',
  },
  {
    index: 3,
    id: 'keeper-03',
    name: 'Keeper 03 (Toronto Watch)',
    operatorLabel: 'Simulated keeper #3 · Port 9103',
    endpoint: 'http://127.0.0.1:9103',
    dbPath: './state/keeper_03.sqlite',
  },
  {
    index: 4,
    id: 'keeper-04',
    name: 'Keeper 04 (Tokyo Sentinel)',
    operatorLabel: 'Simulated keeper #4 · Port 9104',
    endpoint: 'http://127.0.0.1:9104',
    dbPath: './state/keeper_04.sqlite',
  },
  {
    index: 5,
    id: 'keeper-05',
    name: 'Keeper 05 (Geneva Archive)',
    operatorLabel: 'Simulated keeper #5 · Port 9105',
    endpoint: 'http://127.0.0.1:9105',
    dbPath: './state/keeper_05.sqlite',
  },
];

/**
 * Creates a complete pre-populated ContinuityVault and its initial confirmed registration
 * transaction so judges can immediately inspect or advance the chain.
 */
export function createInitialPreloadedSetup(initialBlockHeight = 2845100): {
  recipientIdentity: RecipientIdentity;
  vault: ContinuityVault;
  transactions: ChainTransaction[];
} {
  // Deterministic recipient identity for smooth demo reproduction
  const recipientPrivHex = sha256Hex('zcanary-demo-recipient-elena-rostova-v1');
  const recipientPubHex = deriveX25519PublicKey(recipientPrivHex);
  const recipientIdentity: RecipientIdentity = {
    label: 'Elena Rostova (Special Legal Counsel)',
    privateKeyHex: recipientPrivHex,
    publicKeyHex: recipientPubHex,
    fingerprint: computeKeyFingerprint(recipientPubHex),
  };

  const sourceSecretHex = sha256Hex('zcanary-demo-source-vanguard-seed-v1');
  const sourcePubKeyHex = deriveSourcePublicKey(sourceSecretHex);
  const switchIdHex = sha256Hex('zcanary-switch-id-omega-8841');

  const releaseKey32 = hexToBytes(sha256Hex('zcanary-ephemeral-outer-release-key-8841'));
  const plainBytes = new TextEncoder().encode(SYNTHETIC_DOSSIER_CONTENT);

  const encryptedPackage = encryptDossierDualLayer(plainBytes, recipientPubHex, releaseKey32);
  const shares = splitSecret(
    releaseKey32,
    switchIdHex,
    1,
    5,
    3,
    hexToBytes(sha256Hex('zcanary-demo-poly-seed'))
  );

  const shareCommitments: Record<number, string> = {};
  shares.forEach((s) => {
    shareCommitments[s.index] = s.commitmentHex;
  });

  const initialIntervalBlocks = 24; // Shortened Testnet Demo Interval (24 blocks)
  const graceBlocks = 6; // 6 blocks Grace Window
  const confirmationTarget = 2; // 2 confirmations for Testnet Demo profile
  const registeredHeight = initialBlockHeight - 4;
  const initialExpiryHeight = registeredHeight + initialIntervalBlocks; // 2845120
  const graceDeadlineHeight = initialExpiryHeight + graceBlocks; // 2845126

  const manifest = buildDeterministicManifest({
    network: ZcashNetwork.TESTNET,
    switchIdHex,
    sourcePubKeyHex,
    recipientPubKeyHex: recipientPubHex,
    packageDigestHex: encryptedPackage.outerPackageDigestHex,
    packageSize: encryptedPackage.encryptedSize,
    initialIntervalBlocks,
    graceBlocks,
    confirmationTarget,
    maxExtensionBlocks: 10000,
    threshold: 3,
    configurationEpoch: 1,
    shareCommitments,
  }, sourceSecretHex);

  // Encode real 512-byte registration memo (Sequence 0)
  const regMemoBytes = encodeShieldedMemo({
    version: 1,
    network: ZcashNetwork.TESTNET,
    operation: MemoOperation.REGISTER,
    switchIdHex,
    sequence: 0n,
    requestedExpiryHeight: initialExpiryHeight,
    manifestDigestHex: manifest.manifestDigestHex,
    sourcePubKeyHex,
  }, sourceSecretHex);
  const regMemoHex = bytesToHex(regMemoBytes);
  const regTxid = sha256Hex(`tx-register-${switchIdHex}-seq-0`);

  const confirmedHeight = initialBlockHeight - confirmationTarget + 1;
  const currentBlockHash = formatBlockHash(confirmedHeight);

  const keepers: KeeperInstance[] = KEEPER_METADATA.map((meta, idx) => {
    const share = shares[idx];
    const ackSig = sha256Hex(`KEEPER-ACK:${meta.id}:${share.commitmentHex}`).slice(0, 32);
    return {
      ...meta,
      online: true,
      scannerHealth: 'HEALTHY',
      scanCursorHeight: confirmedHeight,
      scanCursorBlockHash: currentBlockHash,
      lifecycleState: 'ACTIVE',
      provisionedShare: share,
      provisionedAckSignature: ackSig,
      lastSequence: 0n,
      expiryHeight: initialExpiryHeight,
      graceDeadlineHeight,
      outboxDelivered: false,
      deliveryIdempotencyKey: null,
      logs: [
        `[${registeredHeight - 1}] Verified share #${meta.index} against manifest commitment ${share.commitmentHex.slice(0, 12)}...`,
        `[${registeredHeight}] Scanned REGISTER memo (seq=0) in tx ${regTxid.slice(0, 12)}...`,
        `[${registeredHeight + 2}] Confirmation threshold (2/2) reached. Transitioned REGISTERING -> ACTIVE. Expiry set to #${initialExpiryHeight}.`,
      ],
    };
  });

  const regTx: ChainTransaction = {
    txid: regTxid,
    operationId: 'op-reg-8841',
    vaultId: 'vault-omega-8841',
    operation: MemoOperation.REGISTER,
    sequence: 0,
    requestedExpiryHeight: initialExpiryHeight,
    memoHex: regMemoHex,
    feeZatoshi: 10000,
    submittedAtHeight: registeredHeight,
    minedAtHeight: registeredHeight,
    blockHash: formatBlockHash(registeredHeight),
    confirmations: initialBlockHeight - registeredHeight + 1,
    status: 'CONFIRMED',
    timestamp: '2026-10-26 03:42:10 UTC',
  };

  const vault: ContinuityVault = {
    id: 'vault-omega-8841',
    title: 'Project Canary: Meridian Clearing Audit Dossier',
    fileName: 'Project-Canary-Dossier-v4.txt',
    mimeType: 'text/plain',
    createdAt: '2026-10-26 03:40:00 UTC',
    profileMode: 'TESTNET_DEMO',
    sourceSecretHex,
    sourcePubKeyHex,
    manifest,
    encryptedPackage,
    keepers,
    highestSequence: 0,
    registeredAtHeight: registeredHeight,
    currentExpiryHeight: initialExpiryHeight,
    graceDeadlineHeight,
    deliveredSharesToRecipient: [],
    decryptedByRecipient: false,
    decryptedContentText: null,
    timeline: [
      {
        id: 'ev-1',
        type: 'PACKAGE_ENCRYPTED',
        title: 'Package encrypted locally',
        detail: `Dual-layer X25519 + AES-256-GCM cipher package (${encryptedPackage.encryptedSize} bytes). Digest: ${encryptedPackage.outerPackageDigestHex.slice(0, 16)}…`,
        blockHeight: registeredHeight - 1,
        timestamp: '2026-10-26 03:40:12 UTC',
      },
      {
        id: 'ev-2',
        type: 'KEEPERS_PROVISIONED',
        title: '5 of 5 Keepers acknowledged share provisioning',
        detail: 'All five simulated keeper records verified share commitments against the immutable manifest.',
        blockHeight: registeredHeight - 1,
        timestamp: '2026-10-26 03:41:05 UTC',
      },
      {
        id: 'ev-3',
        type: 'REGISTRATION_CONFIRMED',
        title: 'Simulated registration confirmed',
        detail: `512-byte ZIP-302 command (seq 0) confirmed across 5/5 keepers. Active protection until block #${initialExpiryHeight}.`,
        blockHeight: registeredHeight + 2,
        txid: regTxid,
        timestamp: '2026-10-26 03:44:30 UTC',
      },
    ],
  };

  return {
    recipientIdentity,
    vault,
    transactions: [regTx],
  };
}

/** Conservatively stop the simulation; this is not canonical-chain replay. */
export function suspendVaultForReorg(vault: ContinuityVault, observedHeight: number): ContinuityVault {
  return {
    ...vault,
    keepers: vault.keepers.map(keeper => ({
      ...keeper,
      scannerHealth: 'REORG_INCIDENT',
      logs: [...keeper.logs, `[${observedHeight}] Reorg incident: processing suspended. Canonical replay is unavailable in this simulation; previously delivered shares cannot be recalled.`].slice(-14),
    })),
    timeline: [...vault.timeline, {
      id: `ev-reorg-${vault.timeline.length}-${observedHeight}`,
      type: 'REORG_DETECTED',
      title: 'Simulated reorganization: processing suspended',
      detail: 'No canonical replay was performed. Reset the synthetic scenario to continue. Already delivered shares remain available to the recipient.',
      blockHeight: observedHeight,
      timestamp: new Date().toISOString(),
    }],
  };
}

/**
 * Advances five in-memory keeper records against a synthetic chain snapshot.
 * It applies confirmed commands before expiry/release and respects scanner health.
 * It does not establish scan completeness or real canonical block continuity.
 */
export function synchronizeVaultWithChain(
  vault: ContinuityVault,
  transactions: ChainTransaction[],
  currentChainHeight: number,
  forkSalt = 0
): ContinuityVault {
  const confirmationTarget = vault.manifest.confirmationTarget;
  if (!verifyManifest(vault.manifest)) throw new Error('ERR_MANIFEST_INVALID');
  if (!Number.isInteger(currentChainHeight) || currentChainHeight < 0) throw new Error('ERR_CHAIN_HEIGHT');
  const confirmedHeight = Math.max(0, currentChainHeight - confirmationTarget + 1);

  // Filter confirmed transactions for this vault in canonical order
  const confirmedVaultTxs = transactions
    .filter(
      (tx) =>
        tx.vaultId === vault.id &&
        tx.status === 'CONFIRMED' &&
        tx.minedAtHeight !== null &&
        currentChainHeight - tx.minedAtHeight + 1 >= confirmationTarget
    )
    .sort((a, b) => (a.minedAtHeight! - b.minedAtHeight!) || ((a.transactionIndex ?? 0) - (b.transactionIndex ?? 0)) || ((a.outputIndex ?? 0) - (b.outputIndex ?? 0)));

  const newTimeline = [...vault.timeline];
  const deliveredShares = [...vault.deliveredSharesToRecipient];

  const updatedKeepers = vault.keepers.map((keeper) => {
    // Offline keepers or unhealthy scanners cannot advance their scan cursor or release shares
    if (!keeper.online || keeper.scannerHealth !== 'HEALTHY') {
      return keeper;
    }

    if (confirmedHeight < keeper.scanCursorHeight) return { ...keeper, scannerHealth: 'REORG_INCIDENT' as const };
    let state = keeper.lifecycleState;
    let lastSeq = keeper.lastSequence;
    let expiry = keeper.expiryHeight;
    let graceDeadline = keeper.graceDeadlineHeight;
    let outboxDelivered = keeper.outboxDelivered;
    let idempotencyKey = keeper.deliveryIdempotencyKey;
    const logs = [...keeper.logs];

    // Terminal states cannot transition further
    if (state === 'CANCELLED' || state === 'RELEASED') {
      return {
        ...keeper,
        scanCursorHeight: confirmedHeight,
        scanCursorBlockHash: formatBlockHash(confirmedHeight, forkSalt),
      };
    }

    // 1. Process confirmed commands in canonical order
    for (const tx of confirmedVaultTxs) {
      if (state === 'CANCELLED') break;
      if (lastSeq !== null && tx.minedAtHeight! > graceDeadline) continue;
      let memoBytes: Uint8Array;
      try { memoBytes = hexToBytes(tx.memoHex); } catch { continue; }
      const validation = decodeAndValidateMemo(memoBytes, vault.manifest.network);
      if (!validation.valid || !validation.decoded) continue;

      const cmd = validation.decoded;
      if (cmd.switchIdHex.toLowerCase() !== vault.manifest.switchIdHex.toLowerCase()) continue;
      if (cmd.manifestDigestHex.toLowerCase() !== vault.manifest.manifestDigestHex.toLowerCase()) continue;
      if (cmd.sourcePubKeyHex.toLowerCase() !== vault.manifest.sourcePubKeyHex.toLowerCase()) continue;

      if (cmd.operation === MemoOperation.REGISTER) {
        if (lastSeq === null && cmd.sequence === 0n && keeper.provisionedShare && keeper.provisionedShare.commitmentHex === vault.manifest.shareCommitments[keeper.index] && cmd.requestedExpiryHeight > tx.minedAtHeight! && (state === 'DRAFT' || state === 'REGISTERING')) {
          state = 'ACTIVE';
          lastSeq = 0n;
          expiry = cmd.requestedExpiryHeight;
          graceDeadline = expiry + vault.manifest.graceBlocks;
          logs.push(
            `[${currentChainHeight}] Confirmed REGISTER (seq=0) tx ${tx.txid.slice(0, 10)}... -> ACTIVE (expiry #${expiry})`
          );
        }
      } else if (cmd.operation === MemoOperation.POSTPONE) {
        if (lastSeq !== null && cmd.sequence > lastSeq && (state === 'ACTIVE' || state === 'GRACE')) {
          if (
            cmd.requestedExpiryHeight > expiry &&
            cmd.requestedExpiryHeight <= tx.minedAtHeight! + vault.manifest.maxExtensionBlocks
          ) {
            const wasInGrace = state === 'GRACE';
            state = 'ACTIVE';
            lastSeq = cmd.sequence;
            expiry = cmd.requestedExpiryHeight;
            graceDeadline = expiry + vault.manifest.graceBlocks;
            logs.push(
              `[${currentChainHeight}] Confirmed CHECK-IN (seq=${cmd.sequence}) -> ${
                wasInGrace ? 'Recovered GRACE -> ACTIVE' : 'Renewed ACTIVE'
              } (new expiry #${expiry})`
            );
          }
        }
      } else if (cmd.operation === MemoOperation.CANCEL) {
        if (lastSeq !== null && cmd.sequence > lastSeq && cmd.requestedExpiryHeight === 0 && (state === 'ACTIVE' || state === 'GRACE')) {
          state = 'CANCELLED';
          lastSeq = cmd.sequence;
          logs.push(
            `[${currentChainHeight}] Confirmed CANCEL (seq=${cmd.sequence}) -> CANCELLED. Future simulated delivery disabled; browser copies remain.`
          );
        }
      }
    }

    // 2. Evaluate height-based transitions (ACTIVE -> GRACE -> RELEASED)
    if (state === 'ACTIVE' && confirmedHeight >= expiry) {
      state = 'GRACE';
      logs.push(
        `[${currentChainHeight}] Scan cursor reached expiry #${expiry}. Entered GRACE window until #${graceDeadline}.`
      );
    }

    if (state === 'GRACE' && confirmedHeight >= graceDeadline) {
      // Revalidate before dispatching release
      state = 'RELEASED';
      outboxDelivered = true;
      idempotencyKey = sha256Hex(
        `DELIVERY:${vault.manifest.switchIdHex}:${keeper.id}:${vault.manifest.manifestDigestHex}`
      ).slice(0, 24);
      logs.push(
        `[${currentChainHeight}] Grace boundary #${graceDeadline} passed with no valid check-in. Dispatched Share #${keeper.index} (idempotency: ${idempotencyKey}).`
      );

      if (
        keeper.provisionedShare &&
        !deliveredShares.some((s) => s.index === keeper.provisionedShare!.index)
      ) {
        deliveredShares.push(keeper.provisionedShare);
      }
    }

    return {
      ...keeper,
      scanCursorHeight: confirmedHeight,
      scanCursorBlockHash: formatBlockHash(confirmedHeight, forkSalt),
      lifecycleState: state,
      lastSequence: lastSeq,
      expiryHeight: expiry,
      graceDeadlineHeight: graceDeadline,
      outboxDelivered,
      deliveryIdempotencyKey: idempotencyKey,
      logs: logs.slice(-14),
    };
  });

  // Sync vault aggregate timeline events
  const activeKeepers = updatedKeepers.filter((k) => k.online && k.scannerHealth === 'HEALTHY');
  if (updatedKeepers.some(k => k.lastSequence !== null) && !newTimeline.some(e => e.type === 'REGISTRATION_CONFIRMED')) {
    newTimeline.push({ id: `ev-registration-${vault.id}`, type: 'REGISTRATION_CONFIRMED',
      title: 'Simulated registration confirmed', detail: 'Confirmed command processed by an available in-memory keeper.',
      blockHeight: confirmedHeight, timestamp: new Date().toISOString() });
  }
  const maxExpiry = Math.max(...updatedKeepers.map((k) => k.expiryHeight));
  const maxGrace = Math.max(...updatedKeepers.map((k) => k.graceDeadlineHeight));

  const anyInGrace = activeKeepers.some((k) => k.lifecycleState === 'GRACE');
  if (anyInGrace && !newTimeline.some((e) => e.type === 'GRACE_STARTED' && e.blockHeight >= maxExpiry - 5)) {
    newTimeline.push({
      id: `ev-grace-${currentChainHeight}`,
      type: 'GRACE_STARTED',
      title: 'Grace period started',
      detail: `Confirmed block cursor reached expiry height #${maxExpiry}. A valid check-in must be included by block #${maxGrace} (${vault.manifest.graceBlocks} grace blocks) before threshold share release.`,
      blockHeight: currentChainHeight,
      timestamp: new Date().toISOString().replace('T', ' ').slice(0, 19) + ' UTC',
    });
  }

  const releasedCount = updatedKeepers.filter((k) => k.lifecycleState === 'RELEASED').length;
  if (
    releasedCount >= vault.manifest.threshold &&
    !newTimeline.some((e) => e.type === 'DELIVERY_AUTHORIZED')
  ) {
    newTimeline.push({
      id: `ev-release-${currentChainHeight}`,
      type: 'DELIVERY_AUTHORIZED',
      title: `Threshold delivery authorized (${releasedCount}/5 Keepers released)`,
      detail: `Grace boundary #${maxGrace} expired. ${releasedCount} valid Keeper shares delivered to Designated Recipient inbox.`,
      blockHeight: currentChainHeight,
      timestamp: new Date().toISOString().replace('T', ' ').slice(0, 19) + ' UTC',
    });
  }

  return {
    ...vault,
    keepers: updatedKeepers,
    currentExpiryHeight: maxExpiry,
    graceDeadlineHeight: maxGrace,
    deliveredSharesToRecipient: deliveredShares,
    timeline: newTimeline,
  };
}
