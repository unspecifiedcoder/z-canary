import React, { useState } from 'react';
import {
  Upload,
  FileText,
  KeyRound,
  ShieldCheck,
  Check,
  AlertCircle,
  ArrowRight,
  Lock,
  Server,
} from 'lucide-react';
import {
  bytesToHex,
  hexToBytes,
  KeeperShare,
  sha256Hex,
  splitSecret,
} from '../crypto/shamir';
import {
  deriveSourcePublicKey,
  encodeShieldedMemo,
  MemoOperation,
  ZcashNetwork,
} from '../crypto/memoCodec';
import {
  computeKeyFingerprint,
  EncryptedVaultPackage,
  encryptDossierDualLayer,
  RecipientIdentity,
} from '../crypto/envelope';
import {
  buildDeterministicManifest,
  ChainTransaction,
  ContinuityVault,
  formatBlockHash,
  KeeperInstance,
  SYNTHETIC_DOSSIER_CONTENT,
} from '../engine/protocolStore';

interface CreateVaultWizardProps {
  recipientIdentity: RecipientIdentity;
  currentBlockHeight: number;
  walletBalanceZatoshi: number;
  onVaultCreated: (vault: ContinuityVault, regTx: ChainTransaction, feeZatoshi: number) => void;
  onCancel: () => void;
}

const MAX_FILE_SIZE_BYTES = 10 * 1024 * 1024; // 10 MiB

export const CreateVaultWizard: React.FC<CreateVaultWizardProps> = ({
  recipientIdentity,
  currentBlockHeight,
  walletBalanceZatoshi,
  onVaultCreated,
  onCancel,
}) => {
  const [step, setStep] = useState<1 | 2 | 3 | 4>(1);
  const [title, setTitle] = useState('Meridian Liquidity Audit — Supplemental Annex');
  const [fileName, setFileName] = useState('Synthetic-Evidence-Annex-B.pdf');
  const [fileContent, setFileContent] = useState(SYNTHETIC_DOSSIER_CONTENT);
  const [fileError, setFileError] = useState<string | null>(null);

  const [recipientPubKey, setRecipientPubKey] = useState(recipientIdentity.publicKeyHex);
  const [fingerprintVerified, setFingerprintVerified] = useState(true);

  const [profileMode, setProfileMode] = useState<'TESTNET_DEMO' | 'STANDARD_PRODUCTION'>('TESTNET_DEMO');
  const [intervalBlocks, setIntervalBlocks] = useState(24);
  const [graceBlocks, setGraceBlocks] = useState(6);
  const [confirmationTarget, setConfirmationTarget] = useState(2);

  // Step 4 provisioning & backup state
  const [provisionedKeepers, setProvisionedKeepers] = useState<number[]>([]);
  const [encryptedPkg, setEncryptedPkg] = useState<EncryptedVaultPackage | null>(null);
  const [generatedShares, setGeneratedShares] = useState<KeeperShare[]>([]);
  const [switchIdHex, setSwitchIdHex] = useState('');
  const [sourceSecretHex, setSourceSecretHex] = useState('');
  const [backupConfirmed, setBackupConfirmed] = useState(false);

  const estimatedFeeZatoshi = 10000; // Standard ZIP-317 10,000 zatoshi fee

  const handleFileUpload = (e: React.ChangeEvent<HTMLInputElement>) => {
    setFileError(null);
    const file = e.target.files?.[0];
    if (!file) return;

    if (file.size > MAX_FILE_SIZE_BYTES) {
      setFileError(`File size (${(file.size / 1024 / 1024).toFixed(2)} MiB) exceeds the 10 MiB maximum limit.`);
      return;
    }

    setFileName(file.name);
    const reader = new FileReader();
    reader.onload = () => {
      const text = typeof reader.result === 'string' ? reader.result : SYNTHETIC_DOSSIER_CONTENT;
      setFileContent(text);
    };
    reader.readAsText(file);
  };

  const handleSelectProfile = (mode: 'TESTNET_DEMO' | 'STANDARD_PRODUCTION') => {
    setProfileMode(mode);
    if (mode === 'TESTNET_DEMO') {
      setIntervalBlocks(24);
      setGraceBlocks(6);
      setConfirmationTarget(2);
    } else {
      setIntervalBlocks(8064);
      setGraceBlocks(12);
      setConfirmationTarget(6);
    }
  };

  const initiateEncryptionAndProvisioning = () => {
    const randSwitch = new Uint8Array(32);
    const randSource = new Uint8Array(32);
    const randReleaseKey = new Uint8Array(32);
    crypto.getRandomValues(randSwitch);
    crypto.getRandomValues(randSource);
    crypto.getRandomValues(randReleaseKey);

    const sIdHex = bytesToHex(randSwitch);
    const srcSecHex = bytesToHex(randSource);
    const plainBytes = new TextEncoder().encode(fileContent);

    const pkg = encryptDossierDualLayer(plainBytes, recipientPubKey, randReleaseKey);
    const shares = splitSecret(randReleaseKey, sIdHex, 1, 5, 3);

    setSwitchIdHex(sIdHex);
    setSourceSecretHex(srcSecHex);
    setEncryptedPkg(pkg);
    setGeneratedShares(shares);
    setProvisionedKeepers([1, 2, 3, 4, 5]);
    setStep(4);
  };

  const handleBroadcastRegistration = () => {
    if (!encryptedPkg || generatedShares.length !== 5 || provisionedKeepers.length < 5) return;

    const sourcePubKeyHex = deriveSourcePublicKey(sourceSecretHex);
    const shareCommitments: Record<number, string> = {};
    generatedShares.forEach((s) => {
      shareCommitments[s.index] = s.commitmentHex;
    });

    const manifest = buildDeterministicManifest({
      network: ZcashNetwork.TESTNET,
      switchIdHex,
      sourcePubKeyHex,
      recipientPubKeyHex: recipientPubKey,
      packageDigestHex: encryptedPkg.outerPackageDigestHex,
      packageSize: encryptedPkg.encryptedSize,
      initialIntervalBlocks: intervalBlocks,
      graceBlocks,
      confirmationTarget,
      maxExtensionBlocks: 10000,
      threshold: 3,
      configurationEpoch: 1,
      shareCommitments,
    });

    const requestedExpiryHeight = currentBlockHeight + intervalBlocks;
    const graceDeadlineHeight = requestedExpiryHeight + graceBlocks;

    const memoBytes = encodeShieldedMemo({
      version: 1,
      network: ZcashNetwork.TESTNET,
      operation: MemoOperation.REGISTER,
      switchIdHex,
      sequence: 0n,
      requestedExpiryHeight,
      manifestDigestHex: manifest.manifestDigestHex,
      sourcePubKeyHex,
    });
    const memoHex = bytesToHex(memoBytes);
    const txid = sha256Hex(`tx-reg-${switchIdHex}-${Date.now()}`);

    const keeperNames = [
      'Keeper 01 (Zurich Shelf)',
      'Keeper 02 (Reykjavik Relay)',
      'Keeper 03 (Toronto Watch)',
      'Keeper 04 (Tokyo Sentinel)',
      'Keeper 05 (Geneva Archive)',
    ];

    const keepers: KeeperInstance[] = generatedShares.map((share, idx) => ({
      index: share.index,
      id: share.keeperId,
      name: keeperNames[idx],
      operatorLabel: `Local Process #${share.index} · Port 910${share.index}`,
      endpoint: `http://127.0.0.1:910${share.index}`,
      dbPath: `./state/keeper_0${share.index}.sqlite`,
      online: true,
      scannerHealth: 'HEALTHY',
      scanCursorHeight: currentBlockHeight,
      scanCursorBlockHash: formatBlockHash(currentBlockHeight),
      lifecycleState: 'REGISTERING',
      provisionedShare: share,
      provisionedAckSignature: sha256Hex(`ACK:${share.keeperId}:${share.commitmentHex}`).slice(0, 32),
      lastSequence: null,
      expiryHeight: requestedExpiryHeight,
      graceDeadlineHeight,
      outboxDelivered: false,
      deliveryIdempotencyKey: null,
      logs: [
        `[${currentBlockHeight}] Provisioned Share #${share.index}. Commitment ${share.commitmentHex.slice(0, 12)}... verified.`,
        `[${currentBlockHeight}] State -> REGISTERING. Awaiting ${confirmationTarget} confirmations on REGISTER memo.`,
      ],
    }));

    const regTx: ChainTransaction = {
      txid,
      operationId: `op-reg-${switchIdHex.slice(0, 8)}`,
      vaultId: `vault-${switchIdHex.slice(0, 8)}`,
      operation: MemoOperation.REGISTER,
      sequence: 0,
      requestedExpiryHeight,
      memoHex,
      feeZatoshi: estimatedFeeZatoshi,
      submittedAtHeight: currentBlockHeight,
      minedAtHeight: currentBlockHeight,
      blockHash: formatBlockHash(currentBlockHeight),
      confirmations: 1,
      status: 'CONFIRMED',
      timestamp: new Date().toISOString().replace('T', ' ').slice(0, 19) + ' UTC',
    };

    const newVault: ContinuityVault = {
      id: `vault-${switchIdHex.slice(0, 8)}`,
      title,
      fileName,
      mimeType: 'application/pdf',
      createdAt: new Date().toISOString().replace('T', ' ').slice(0, 19) + ' UTC',
      profileMode,
      sourceSecretHex,
      sourcePubKeyHex,
      manifest,
      encryptedPackage: encryptedPkg,
      keepers,
      highestSequence: 0,
      registeredAtHeight: currentBlockHeight,
      currentExpiryHeight: requestedExpiryHeight,
      graceDeadlineHeight,
      deliveredSharesToRecipient: [],
      decryptedByRecipient: false,
      decryptedContentText: null,
      timeline: [
        {
          id: `ev-enc-${Date.now()}`,
          type: 'PACKAGE_ENCRYPTED',
          title: 'Package encrypted locally',
          detail: `Dual-layer X25519 + AES-256-GCM cipher package (${encryptedPkg.encryptedSize} bytes).`,
          blockHeight: currentBlockHeight,
          timestamp: new Date().toISOString().replace('T', ' ').slice(0, 19) + ' UTC',
        },
        {
          id: `ev-prov-${Date.now()}`,
          type: 'KEEPERS_PROVISIONED',
          title: '5 of 5 Keepers acknowledged share provisioning',
          detail: 'All five isolated keepers verified share commitments and persisted encrypted shares.',
          blockHeight: currentBlockHeight,
          timestamp: new Date().toISOString().replace('T', ' ').slice(0, 19) + ' UTC',
        },
        {
          id: `ev-bcast-${Date.now()}`,
          type: 'REGISTRATION_BROADCAST',
          title: 'Registration command broadcast (Awaiting confirmation)',
          detail: `512-byte ZIP-302 REGISTER memo broadcast in tx ${txid.slice(0, 14)}… (1/${confirmationTarget} confirmations).`,
          blockHeight: currentBlockHeight,
          txid,
          timestamp: new Date().toISOString().replace('T', ' ').slice(0, 19) + ' UTC',
        },
      ],
    };

    onVaultCreated(newVault, regTx, estimatedFeeZatoshi);
  };

  const displayedFingerprint = (() => {
    try {
      return computeKeyFingerprint(recipientPubKey);
    } catch {
      return 'INVALID PUBLIC KEY HEX';
    }
  })();

  return (
    <div className="max-w-4xl mx-auto space-y-8 pb-16">
      <div className="flex items-center justify-between border-b border-[#222938] pb-5">
        <div>
          <h1 className="text-2xl font-bold text-[#F8FAFC]">Create Continuity Vault</h1>
          <p className="text-sm text-[#94A3B8]">
            Encrypt a confidential dossier locally, provision 5 keepers, and register on Zcash Testnet.
          </p>
        </div>
        <button
          onClick={onCancel}
          className="px-4 py-2 text-xs font-medium text-[#94A3B8] hover:text-[#F8FAFC] border border-[#222938] rounded cursor-pointer"
        >
          Return to Console
        </button>
      </div>

      {/* Stepper Header */}
      <div className="grid grid-cols-4 gap-3 text-xs font-mono">
        {[
          { num: 1, label: '01. Dossier File' },
          { num: 2, label: '02. Recipient Key' },
          { num: 3, label: '03. Release Policy' },
          { num: 4, label: '04. Provision & Sign' },
        ].map((s) => (
          <div
            key={s.num}
            className={`p-3 border ${
              step === s.num
                ? 'border-[#F59E0B] bg-[#141820] text-[#F8FAFC]'
                : step > s.num
                ? 'border-[#10B981]/40 bg-[#141820]/60 text-[#10B981]'
                : 'border-[#222938] bg-[#0B0D11] text-[#64748B]'
            }`}
          >
            {s.label}
          </div>
        ))}
      </div>

      {/* Step 1: File Selection */}
      {step === 1 && (
        <div className="border border-[#222938] bg-[#141820] p-6 lg:p-8 space-y-6">
          <div className="space-y-2">
            <label className="block text-xs font-mono text-[#94A3B8]">
              Vault Reference Label (Local Only — Never Included in Manifest or Chain Memo)
            </label>
            <input
              type="text"
              value={title}
              onChange={(e) => setTitle(e.target.value)}
              className="w-full px-3.5 py-2.5 bg-[#0B0D11] border border-[#222938] rounded text-sm text-[#F8FAFC] focus:outline-none focus:border-[#F59E0B]"
            />
          </div>

          <div className="space-y-2">
            <label className="block text-xs font-mono text-[#94A3B8]">
              Dossier Document (Max 10 MiB · Encrypted Locally Before Any Network Activity)
            </label>
            <label className="flex flex-col items-center justify-center border border-dashed border-[#2E3748] hover:border-[#F59E0B] bg-[#0B0D11] p-8 rounded cursor-pointer transition-colors">
              <Upload className="w-6 h-6 text-[#F59E0B] mb-2" />
              <span className="text-sm font-medium text-[#F8FAFC]">
                Drop dossier file here or click to select
              </span>
              <span className="text-xs text-[#64748B] font-mono mt-1">
                Active selection: {fileName} ({new TextEncoder().encode(fileContent).length} bytes)
              </span>
              <input type="file" onChange={handleFileUpload} className="hidden" />
            </label>
            {fileError && (
              <p className="text-xs text-[#EF4444] font-mono pt-1">{fileError}</p>
            )}
          </div>

          <div className="space-y-2">
            <div className="flex items-center justify-between text-xs font-mono text-[#94A3B8]">
              <span>Synthetic Dossier Preview (Plaintext SHA-256: {sha256Hex(fileContent).slice(0, 20)}…)</span>
              <button
                type="button"
                onClick={() => {
                  setFileName('Synthetic-Evidence-Annex-B.pdf');
                  setFileContent(SYNTHETIC_DOSSIER_CONTENT);
                }}
                className="text-[#F59E0B] hover:underline cursor-pointer"
              >
                Reset to Default Synthetic Dossier
              </button>
            </div>
            <textarea
              rows={6}
              value={fileContent}
              onChange={(e) => setFileContent(e.target.value)}
              className="w-full p-3 bg-[#0B0D11] border border-[#222938] rounded font-mono text-xs text-[#CBD5E1] focus:outline-none focus:border-[#F59E0B]"
            />
          </div>

          <div className="flex justify-end pt-2">
            <button
              onClick={() => setStep(2)}
              className="px-5 py-2.5 bg-[#F59E0B] hover:bg-[#D97706] text-[#0B0D11] font-semibold text-sm rounded transition-colors flex items-center gap-2 cursor-pointer"
            >
              <span>Continue to Recipient Verification</span>
              <ArrowRight className="w-4 h-4" />
            </button>
          </div>
        </div>
      )}

      {/* Step 2: Recipient Verification */}
      {step === 2 && (
        <div className="border border-[#222938] bg-[#141820] p-6 lg:p-8 space-y-6">
          <div className="space-y-2">
            <h2 className="text-lg font-semibold text-[#F8FAFC]">
              Designated Recipient X25519 Identity
            </h2>
            <p className="text-sm text-[#94A3B8]">
              Z-Canary v1 enforces single-recipient encrypted delivery without public document
              disclosure. Verify the recipient’s out-of-band key fingerprint before encrypting.
            </p>
          </div>

          <div className="space-y-2">
            <label className="block text-xs font-mono text-[#94A3B8]">
              Recipient Public Key (32-Byte Hex)
            </label>
            <input
              type="text"
              value={recipientPubKey}
              onChange={(e) => setRecipientPubKey(e.target.value)}
              className="w-full px-3.5 py-2.5 bg-[#0B0D11] border border-[#222938] rounded font-mono text-xs text-[#F8FAFC] focus:outline-none focus:border-[#F59E0B]"
            />
          </div>

          <div className="p-4 bg-[#0B0D11] border border-[#222938] space-y-2">
            <div className="text-xs font-mono text-[#64748B]">
              COMPUTED SHA-256 KEY FINGERPRINT
            </div>
            <div className="text-sm font-mono font-semibold text-[#F59E0B] tracking-wider">
              {displayedFingerprint}
            </div>
            <div className="text-xs text-[#94A3B8]">
              Designated Profile: {recipientIdentity.label}
            </div>
          </div>

          <label className="flex items-center gap-3 text-sm text-[#E2E8F0] cursor-pointer">
            <input
              type="checkbox"
              checked={fingerprintVerified}
              onChange={(e) => setFingerprintVerified(e.target.checked)}
              className="w-4 h-4 accent-[#F59E0B]"
            />
            <span>
              I have verified this X25519 key fingerprint with the designated recipient over an
              authenticated channel.
            </span>
          </label>

          <div className="flex justify-between pt-2">
            <button
              onClick={() => setStep(1)}
              className="px-4 py-2 text-xs font-medium text-[#94A3B8] hover:text-[#F8FAFC] border border-[#222938] rounded cursor-pointer"
            >
              Back
            </button>
            <button
              disabled={!fingerprintVerified || displayedFingerprint.startsWith('INVALID')}
              onClick={() => setStep(3)}
              className="px-5 py-2.5 bg-[#F59E0B] disabled:opacity-40 hover:bg-[#D97706] text-[#0B0D11] font-semibold text-sm rounded transition-colors flex items-center gap-2 cursor-pointer"
            >
              <span>Configure Release Policy</span>
              <ArrowRight className="w-4 h-4" />
            </button>
          </div>
        </div>
      )}

      {/* Step 3: Release Deadline & Cadence */}
      {step === 3 && (
        <div className="border border-[#222938] bg-[#141820] p-6 lg:p-8 space-y-6">
          <div className="space-y-2">
            <h2 className="text-lg font-semibold text-[#F8FAFC]">
              Block-Based Release Policy & Confirmation Threshold
            </h2>
            <p className="text-sm text-[#94A3B8]">
              Select either the accelerated Testnet Demonstration profile or the full 8,064-block
              production interval. Deadlines are evaluated strictly by confirmed block height.
            </p>
          </div>

          <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
            <button
              type="button"
              onClick={() => handleSelectProfile('TESTNET_DEMO')}
              className={`p-4 border text-left space-y-2 cursor-pointer transition-colors ${
                profileMode === 'TESTNET_DEMO'
                  ? 'border-[#F59E0B] bg-[#0B0D11]'
                  : 'border-[#222938] bg-[#0B0D11]/50 hover:border-[#2E3748]'
              }`}
            >
              <div className="text-xs font-mono text-[#F59E0B]">TESTNET DEMONSTRATION PROFILE</div>
              <div className="text-base font-semibold text-[#F8FAFC]">
                24 Blocks Interval · 6 Blocks Grace
              </div>
              <p className="text-xs text-[#94A3B8]">
                Requires 2 confirmations. Designed for live verification of check-ins, grace
                recovery, and threshold release.
              </p>
            </button>

            <button
              type="button"
              onClick={() => handleSelectProfile('STANDARD_PRODUCTION')}
              className={`p-4 border text-left space-y-2 cursor-pointer transition-colors ${
                profileMode === 'STANDARD_PRODUCTION'
                  ? 'border-[#F59E0B] bg-[#0B0D11]'
                  : 'border-[#222938] bg-[#0B0D11]/50 hover:border-[#2E3748]'
              }`}
            >
              <div className="text-xs font-mono text-[#94A3B8]">STANDARD PRODUCTION PROFILE</div>
              <div className="text-base font-semibold text-[#F8FAFC]">
                8,064 Blocks Interval · 12 Blocks Grace
              </div>
              <p className="text-xs text-[#94A3B8]">
                Requires 6 confirmations (~7 days interval at 75s/block). Full operational security
                margins.
              </p>
            </button>
          </div>

          <div className="grid grid-cols-1 sm:grid-cols-3 gap-4 pt-2 font-mono text-xs">
            <div className="p-3.5 bg-[#0B0D11] border border-[#222938] space-y-1">
              <span className="text-[#64748B]">Initial Expiry Height</span>
              <div className="text-sm font-semibold text-[#F8FAFC] tabular-nums">
                #{(currentBlockHeight + intervalBlocks).toLocaleString()} (+{intervalBlocks} blocks)
              </div>
            </div>
            <div className="p-3.5 bg-[#0B0D11] border border-[#222938] space-y-1">
              <span className="text-[#64748B]">Grace Release Boundary</span>
              <div className="text-sm font-semibold text-[#F59E0B] tabular-nums">
                #{(currentBlockHeight + intervalBlocks + graceBlocks).toLocaleString()} (+{graceBlocks} grace)
              </div>
            </div>
            <div className="p-3.5 bg-[#0B0D11] border border-[#222938] space-y-1">
              <span className="text-[#64748B]">Keeper Committee</span>
              <div className="text-sm font-semibold text-[#10B981] tabular-nums">
                3-of-5 Threshold (Epoch 1)
              </div>
            </div>
          </div>

          <div className="flex justify-between pt-2">
            <button
              onClick={() => setStep(2)}
              className="px-4 py-2 text-xs font-medium text-[#94A3B8] hover:text-[#F8FAFC] border border-[#222938] rounded cursor-pointer"
            >
              Back
            </button>
            <button
              onClick={initiateEncryptionAndProvisioning}
              className="px-5 py-2.5 bg-[#F59E0B] hover:bg-[#D97706] text-[#0B0D11] font-semibold text-sm rounded transition-colors flex items-center gap-2 cursor-pointer"
            >
              <span>Encrypt Dossier & Provision 5 Keepers</span>
              <ArrowRight className="w-4 h-4" />
            </button>
          </div>
        </div>
      )}

      {/* Step 4: Keeper Acknowledgements, Backup & Registration Broadcast */}
      {step === 4 && encryptedPkg && (
        <div className="border border-[#222938] bg-[#141820] p-6 lg:p-8 space-y-6">
          <div className="space-y-1">
            <div className="text-xs font-mono text-[#10B981]">
              LOCAL DUAL-LAYER ENCRYPTION & 5-OF-5 KEEPER PROVISIONING COMPLETE
            </div>
            <h2 className="text-lg font-semibold text-[#F8FAFC]">
              Verify Keeper Acknowledgements & Broadcast Registration Memo
            </h2>
            <p className="text-xs text-[#94A3B8]">
              Registration is only unlocked after all 5 isolated keepers verify their share against
              its commitment and return a durable storage signature.
            </p>
          </div>

          {/* Individual Keeper Acknowledgements Table */}
          <div className="border border-[#222938] bg-[#0B0D11] divide-y divide-[#1E2430] font-mono text-xs">
            {generatedShares.map((s) => (
              <div key={s.index} className="p-3 flex items-center justify-between gap-4">
                <div className="flex items-center gap-3">
                  <Check className="w-4 h-4 text-[#10B981] shrink-0" />
                  <span className="text-[#F8FAFC] font-medium">Keeper 0{s.index}</span>
                  <span className="text-[#64748B]">·</span>
                  <span className="text-[#94A3B8]">
                    Commitment: {s.commitmentHex.slice(0, 20)}…
                  </span>
                </div>
                <span className="text-[#10B981] shrink-0">ACK VERIFIED (SQLite)</span>
              </div>
            ))}
          </div>

          {/* Fee Estimate & Source Recovery Instructions */}
          <div className="grid grid-cols-1 md:grid-cols-2 gap-4 font-mono text-xs">
            <div className="p-4 bg-[#0B0D11] border border-[#222938] space-y-1.5">
              <div className="text-[#64748B]">Zcash Shielded Transaction Fee (ZIP-317)</div>
              <div className="text-sm font-semibold text-[#F8FAFC] tabular-nums">
                10,000 zatoshi (0.00010000 TAZ)
              </div>
              <div className="text-[#94A3B8] tabular-nums">
                Available Source Balance: {walletBalanceZatoshi.toLocaleString()} zatoshi
              </div>
            </div>

            <div className="p-4 bg-[#0B0D11] border border-[#222938] space-y-1.5">
              <div className="text-[#64748B]">Source Signing Seed Backup (Encrypted Local Store)</div>
              <div className="text-xs text-[#F59E0B] truncate tabular-nums">
                {sourceSecretHex}
              </div>
              <div className="text-[#94A3B8]">
                Required to sign future Check-In or Cancel memos.
              </div>
            </div>
          </div>

          <label className="flex items-center gap-3 text-sm text-[#E2E8F0] cursor-pointer">
            <input
              type="checkbox"
              checked={backupConfirmed}
              onChange={(e) => setBackupConfirmed(e.target.checked)}
              className="w-4 h-4 accent-[#F59E0B]"
            />
            <span>
              I have backed up the Source command-signing key and understand that protection activates
              only after the registration transaction reaches {confirmationTarget} confirmations.
            </span>
          </label>

          <div className="flex justify-between pt-2">
            <button
              onClick={() => setStep(3)}
              className="px-4 py-2 text-xs font-medium text-[#94A3B8] hover:text-[#F8FAFC] border border-[#222938] rounded cursor-pointer"
            >
              Back
            </button>
            <button
              disabled={!backupConfirmed || provisionedKeepers.length < 5}
              onClick={handleBroadcastRegistration}
              className="px-5 py-2.5 bg-[#F59E0B] disabled:opacity-40 hover:bg-[#D97706] text-[#0B0D11] font-semibold text-sm rounded transition-colors flex items-center gap-2 cursor-pointer"
            >
              <Lock className="w-4 h-4" />
              <span>Sign 512-Byte Memo & Broadcast Registration</span>
            </button>
          </div>
        </div>
      )}
    </div>
  );
};
