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
  Copy,
  ExternalLink,
  WalletCards,
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
  decodeAndValidateMemo,
  encodeShieldedMemo,
  MemoOperation,
  ZcashNetwork,
} from '../crypto/memoCodec';
import {
  computeKeyFingerprint,
  EncryptedVaultPackage,
  encryptDossierDualLayer,
  generateRecipientIdentity,
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
import {
  buildZip321RegistrationRequest,
  ExternalWalletSubmission,
  normalizeTestnetTxid,
  testnetExplorerUrl,
  Zip321RegistrationRequest,
} from '../zcash/zip321';

interface CreateVaultWizardProps {
  recipientIdentity: RecipientIdentity;
  currentBlockHeight: number;
  walletBalanceZatoshi: number;
  onVaultCreated: (vault: ContinuityVault, regTx: ChainTransaction, feeZatoshi: number, recipient: RecipientIdentity, externalSubmission?: ExternalWalletSubmission) => void;
  onCancel: () => void;
}

const MAX_FILE_SIZE_BYTES = 10 * 1024 * 1024; // 10 MiB
const EXTERNAL_WALLET_AMOUNT_ZATOSHI = 10_000;
const EXTERNAL_WALLET_ADDRESS = import.meta.env.VITE_CANARY_TESTNET_REGISTER_ADDRESS
  ?? 'utest170vmkzw3hjx8yltquph5pr7d32j097g7nwq7xty2kr04us00g96fc3kf7dpp0qk6sa4rmem00dhvznxsnxc48ss33xjfd0w7s3kdy2y9qzrrjkd9gu8x9xspgzv583fq6e9nhyp5cwe5uyxuqx8d8ctw0930678aamn2u7dqxqa0hwcq';

interface RegistrationBundle {
  newVault: ContinuityVault;
  regTx: ChainTransaction;
  selectedRecipient: RecipientIdentity;
}

export const CreateVaultWizard: React.FC<CreateVaultWizardProps> = ({
  recipientIdentity,
  currentBlockHeight,
  walletBalanceZatoshi,
  onVaultCreated,
  onCancel,
}) => {
  const [step, setStep] = useState<1 | 2 | 3 | 4>(1);
  const [title, setTitle] = useState('Meridian Liquidity Audit — Supplemental Annex');
  const [fileName, setFileName] = useState('Synthetic-Evidence-Annex-B.txt');
  const [fileContent, setFileContent] = useState(SYNTHETIC_DOSSIER_CONTENT);
  const [uploadedBytes, setUploadedBytes] = useState<Uint8Array | null>(null);
  const [fileLoading, setFileLoading] = useState(false);
  const [fileError, setFileError] = useState<string | null>(null);
  const [provisioningError, setProvisioningError] = useState<string | null>(null);

  const [generatedRecipient, setGeneratedRecipient] = useState<RecipientIdentity>(() =>
    generateRecipientIdentity('Judge-created recovery recipient')
  );
  const [recipientPubKey, setRecipientPubKey] = useState(generatedRecipient.publicKeyHex);
  const [fingerprintVerified, setFingerprintVerified] = useState(false);

  const [profileMode, setProfileMode] = useState<'TESTNET_DEMO' | 'STANDARD_PRODUCTION'>('TESTNET_DEMO');
  const [intervalBlocks, setIntervalBlocks] = useState(24);
  const [graceBlocks, setGraceBlocks] = useState(6);
  const [confirmationTarget, setConfirmationTarget] = useState(2);
  const [threshold, setThreshold] = useState(3);

  // Step 4 provisioning & backup state
  const [provisionedKeepers, setProvisionedKeepers] = useState<number[]>([]);
  const [encryptedPkg, setEncryptedPkg] = useState<EncryptedVaultPackage | null>(null);
  const [generatedShares, setGeneratedShares] = useState<KeeperShare[]>([]);
  const [switchIdHex, setSwitchIdHex] = useState('');
  const [sourceSecretHex, setSourceSecretHex] = useState('');
  const [backupConfirmed, setBackupConfirmed] = useState(false);
  const [registrationMode, setRegistrationMode] = useState<'simulation' | 'external'>('simulation');
  const [preparedRegistration, setPreparedRegistration] = useState<RegistrationBundle | null>(null);
  const [externalRequest, setExternalRequest] = useState<Zip321RegistrationRequest | null>(null);
  const [externalTxid, setExternalTxid] = useState('');
  const [walletMessage, setWalletMessage] = useState<string | null>(null);
  const [walletError, setWalletError] = useState<string | null>(null);

  const estimatedFeeZatoshi = 10000; // Simulation assumption; the future wallet adapter estimates fees.

  const loadFile = async (file?: File) => {
    if (!file) return;
    setFileError(null);
    setUploadedBytes(null);
    if (file.size > MAX_FILE_SIZE_BYTES) {
      setFileError('Document exceeds the 10 MiB limit.');
      return;
    }
    setFileLoading(true);
    try {
      const bytes = new Uint8Array(await file.arrayBuffer());
      setUploadedBytes(bytes);
      setFileName(file.name);
    } catch {
      setFileError('Could not read the selected file. Try again.');
    } finally { setFileLoading(false); }
  };
  const handleFileUpload = (e: React.ChangeEvent<HTMLInputElement>) => { void loadFile(e.target.files?.[0]); };

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
    if (policyValidationError) return;
    setProvisioningError(null);
    try {
      const randSwitch = new Uint8Array(32);
      const randSource = new Uint8Array(32);
      const randReleaseKey = new Uint8Array(32);
      crypto.getRandomValues(randSwitch);
      crypto.getRandomValues(randSource);
      crypto.getRandomValues(randReleaseKey);

      const sIdHex = bytesToHex(randSwitch);
      const srcSecHex = bytesToHex(randSource);
      const plainBytes = uploadedBytes ?? new TextEncoder().encode(fileContent);

      const pkg = encryptDossierDualLayer(plainBytes, recipientPubKey, randReleaseKey);
      const shares = splitSecret(randReleaseKey, sIdHex, 1, 5, threshold);

      setSwitchIdHex(sIdHex);
      setSourceSecretHex(srcSecHex);
      setEncryptedPkg(pkg);
      setGeneratedShares(shares);
      setProvisionedKeepers([1, 2, 3, 4, 5]);
      setStep(4);
    } catch {
      setProvisioningError('Could not encrypt for this recipient key. Recheck the 32-byte public key and its fingerprint.');
    }
  };

  const buildRegistration = (): RegistrationBundle | null => {
    if (!encryptedPkg || generatedShares.length !== 5 || provisionedKeepers.length < 5) return null;

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
      threshold,
      configurationEpoch: 1,
      shareCommitments,
    }, sourceSecretHex);

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
    }, sourceSecretHex);
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
      operatorLabel: `Simulated keeper #${share.index} · Port 910${share.index}`,
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
      status: 'MINED',
      timestamp: new Date().toISOString().replace('T', ' ').slice(0, 19) + ' UTC',
    };

    const newVault: ContinuityVault = {
      id: `vault-${switchIdHex.slice(0, 8)}`,
      title,
      fileName,
      mimeType: 'application/octet-stream',
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
          detail: 'Five in-memory keeper records hold demo shares. Persistence is not implemented.',
          blockHeight: currentBlockHeight,
          timestamp: new Date().toISOString().replace('T', ' ').slice(0, 19) + ' UTC',
        },
        {
          id: `ev-bcast-${Date.now()}`,
          type: 'REGISTRATION_BROADCAST',
          title: 'Simulated registration prepared (Awaiting confirmation)',
          detail: `512-byte ZIP-302 REGISTER memo processed locally with synthetic transaction id ${txid.slice(0, 14)}… (1/${confirmationTarget} simulated confirmations). No network broadcast occurred.`,
          blockHeight: currentBlockHeight,
          txid,
          timestamp: new Date().toISOString().replace('T', ' ').slice(0, 19) + ' UTC',
        },
      ],
    };

    const selectedRecipient = recipientPubKey === generatedRecipient.publicKeyHex
      ? generatedRecipient
      : {
          label: 'External recovery recipient',
          privateKeyHex: '',
          publicKeyHex: recipientPubKey,
          fingerprint: computeKeyFingerprint(recipientPubKey),
        };
    return { newVault, regTx, selectedRecipient };
  };

  const handleSimulateRegistration = () => {
    const registration = buildRegistration();
    if (!registration) return;
    onVaultCreated(registration.newVault, registration.regTx, estimatedFeeZatoshi, registration.selectedRecipient);
  };

  const handlePrepareExternalRequest = () => {
    setWalletError(null);
    setWalletMessage(null);
    try {
      const registration = buildRegistration();
      if (!registration) throw new Error('Complete encryption and keeper provisioning first.');
      const request = buildZip321RegistrationRequest({
        address: EXTERNAL_WALLET_ADDRESS,
        amountZatoshi: EXTERNAL_WALLET_AMOUNT_ZATOSHI,
        memoHex: registration.regTx.memoHex,
      });
      const validation = decodeAndValidateMemo(hexToBytes(request.memoHex), ZcashNetwork.TESTNET);
      if (!validation.valid || !validation.decoded?.signatureValid) {
        throw new Error('Canary refused to create a wallet request because memo verification failed.');
      }
      setPreparedRegistration(registration);
      setExternalRequest(request);
      setExternalTxid('');
      setWalletMessage('Signed REGISTER memo verified locally. The wallet request is ready.');
    } catch (error) {
      setWalletError(error instanceof Error ? error.message : 'Could not prepare the external wallet request.');
    }
  };

  const copyWalletValue = async (value: string, label: string) => {
    try {
      await navigator.clipboard.writeText(value);
      setWalletError(null);
      setWalletMessage(`${label} copied.`);
    } catch {
      setWalletError('Clipboard access is unavailable. Select the value and copy it manually.');
    }
  };

  const handleRecordExternalSubmission = () => {
    if (!preparedRegistration || !externalRequest) return;
    const txid = normalizeTestnetTxid(externalTxid);
    if (!txid) {
      setWalletError('Paste the 64-character testnet transaction ID returned by your wallet.');
      return;
    }
    const explorerUrl = testnetExplorerUrl(txid);
    onVaultCreated(
      preparedRegistration.newVault,
      preparedRegistration.regTx,
      0,
      preparedRegistration.selectedRecipient,
      { request: externalRequest, txid, explorerUrl },
    );
  };

  const displayedFingerprint = (() => {
    try {
      return computeKeyFingerprint(recipientPubKey);
    } catch {
      return 'INVALID PUBLIC KEY HEX';
    }
  })();

  const policyValidationError = (() => {
    const uint32Max = 0xffff_ffff;
    const documentSize = uploadedBytes?.length ?? new TextEncoder().encode(fileContent).length;
    if (!Number.isInteger(intervalBlocks) || intervalBlocks < 1 || intervalBlocks > uint32Max) {
      return 'Release interval must be a positive whole block count.';
    }
    if (!Number.isInteger(graceBlocks) || graceBlocks < 0 || graceBlocks > uint32Max) {
      return 'Grace period must be a whole block count of zero or more.';
    }
    if (!Number.isInteger(confirmationTarget) || confirmationTarget < 1 || confirmationTarget > uint32Max) {
      return 'Confirmation target must be a positive whole block count.';
    }
    if (!Number.isInteger(threshold) || threshold < 2 || threshold > 5) {
      return 'Keeper threshold must be a whole number from 2 through 5.';
    }
    if (currentBlockHeight + intervalBlocks + graceBlocks > uint32Max) {
      return 'This deadline exceeds the protocol’s maximum supported block height.';
    }
    if (documentSize > MAX_FILE_SIZE_BYTES) {
      return 'Document exceeds the 10 MiB limit.';
    }
    return null;
  })();
  const normalizedExternalTxid = normalizeTestnetTxid(externalTxid);

  return (
    <div className="max-w-4xl mx-auto space-y-8 pb-16">
      <div className="flex items-center justify-between border-b border-[#222938] pb-5">
        <div>
          <h1 className="text-2xl font-bold text-[#F8FAFC]">Create an Encrypted Safety Handoff</h1>
          <p className="text-sm text-[#CBD5E1]">
            Lock a file so only the person you choose can open it if you go silent. Any file works, up to 10 MiB, and it is encrypted in your browser.
          </p>
          <p className="text-sm text-[#94A3B8]">
            Check-ins and releases are signed commands that travel as Zcash shielded memos. This browser lab runs the real encryption and simulates the chain, so you can test every recovery rule without sending a transaction.
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
      <div aria-label="Creation progress" className="grid grid-cols-2 sm:grid-cols-4 gap-3 text-xs">
        {[
          { num: 1, label: '01. Choose File' },
          { num: 2, label: '02. Choose Recipient' },
          { num: 3, label: '03. Set Recovery Rules' },
          { num: 4, label: '04. Protect Locally' },
        ].map((s) => (
          <div
            key={s.num}
            aria-current={step === s.num ? 'step' : undefined}
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
            <label htmlFor="vault-reference" className="block text-xs text-[#94A3B8]">
              Vault Reference Label (Local Only — Never Included in Manifest or Chain Memo)
            </label>
            <input
              id="vault-reference"
              type="text"
              value={title}
              onChange={(e) => setTitle(e.target.value)}
              className="w-full px-3.5 py-2.5 bg-[#0B0D11] border border-[#222938] rounded text-sm text-[#F8FAFC] focus:outline-none focus:border-[#F59E0B]"
            />
          </div>

          <div className="space-y-2">
            <label id="dossier-document-label" className="block text-xs text-[#94A3B8]">
              Dossier Document (Max 10 MiB · Encrypted Locally Before Any Network Activity)
            </label>
            <label onDragOver={e => e.preventDefault()} onDrop={e => { e.preventDefault(); void loadFile(e.dataTransfer.files[0]); }} className="flex flex-col items-center justify-center border border-dashed border-[#2E3748] hover:border-[#F59E0B] bg-[#0B0D11] p-8 rounded cursor-pointer transition-colors">
              <Upload className="w-6 h-6 text-[#F59E0B] mb-2" />
              <span className="text-sm font-medium text-[#F8FAFC]">
                Drop dossier file here or click to select
              </span>
              <span className="text-xs text-[#64748B] mt-1">
                Active selection: {fileName} ({uploadedBytes?.length ?? new TextEncoder().encode(fileContent).length} bytes)
              </span>
              <input type="file" onChange={handleFileUpload} aria-labelledby="dossier-document-label" aria-describedby={fileError ? 'dossier-file-error' : undefined} accept="*/*" className="mt-3 text-xs max-w-full" />
            </label>
            {fileError && (
              <p id="dossier-file-error" role="alert" className="text-xs text-[#EF4444] pt-1">{fileError}</p>
            )}
          </div>

          <div className="space-y-2">
            <div className="flex items-center justify-between text-xs text-[#94A3B8]">
              <span>Synthetic Dossier Preview (Plaintext SHA-256: {sha256Hex(uploadedBytes ?? fileContent).slice(0, 20)}…)</span>
              <button
                type="button"
                onClick={() => {
                  setUploadedBytes(null);
                  setFileError(null);
                  setFileName('Synthetic-Evidence-Annex-B.txt');
                  setFileContent(SYNTHETIC_DOSSIER_CONTENT);
                }}
                className="text-[#F59E0B] hover:underline cursor-pointer"
              >
                Reset to Default Synthetic Dossier
              </button>
            </div>
            <textarea
              rows={6}
              aria-label="Synthetic text dossier"
              disabled={uploadedBytes !== null}
              value={uploadedBytes ? 'Binary file selected. Exact bytes will be encrypted and downloaded.' : fileContent}
              onChange={(e) => setFileContent(e.target.value)}
              className="w-full p-3 bg-[#0B0D11] border border-[#222938] rounded font-mono text-xs text-[#CBD5E1] focus:outline-none focus:border-[#F59E0B]"
            />
          </div>

          <div className="flex justify-end pt-2">
            <button
              disabled={fileLoading || Boolean(fileError)}
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
              Canary created a fresh browser-only recipient identity for this walkthrough. You can
              use it immediately, regenerate it, or paste a public key supplied by another recipient.
            </p>
          </div>

          <div className="p-4 bg-[#071611] border border-[#10B981]/40 space-y-3">
            <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-3">
              <div>
                <div className="text-xs text-[#10B981]">Demo recipient generated locally</div>
                <p className="text-xs text-[#94A3B8] mt-1">The private key stays in this browser session and is used later to prove recipient-only recovery.</p>
              </div>
              <button
                type="button"
                onClick={() => {
                  const next = generateRecipientIdentity('Judge-created recovery recipient');
                  setGeneratedRecipient(next);
                  setRecipientPubKey(next.publicKeyHex);
                  setFingerprintVerified(false);
                }}
                className="px-3 py-2 text-xs font-semibold text-[#10B981] border border-[#10B981]/50 hover:bg-[#10B981]/10 cursor-pointer"
              >
                Generate another identity
              </button>
            </div>
          </div>

          <div className="space-y-2">
            <label htmlFor="recipient-public-key" className="block text-xs text-[#94A3B8]">
              Recipient Public Key (32-Byte Hex)
            </label>
            <input
              id="recipient-public-key"
              type="text"
              autoComplete="off"
              spellCheck={false}
              aria-invalid={displayedFingerprint.startsWith('INVALID')}
              aria-describedby="recipient-key-fingerprint"
              value={recipientPubKey}
              onChange={(e) => { setRecipientPubKey(e.target.value); setFingerprintVerified(false); }}
              className="w-full px-3.5 py-2.5 bg-[#0B0D11] border border-[#222938] rounded font-mono text-xs text-[#F8FAFC] focus:outline-none focus:border-[#F59E0B]"
            />
          </div>

          <div className="p-4 bg-[#0B0D11] border border-[#222938] space-y-2">
            <div className="text-xs text-[#64748B]">
              SHA-256 key fingerprint
            </div>
            <div id="recipient-key-fingerprint" role="status" aria-live="polite" className="text-sm font-mono font-semibold text-[#F59E0B]">
              {displayedFingerprint}
            </div>
            <div className="text-xs text-[#94A3B8]">
              Designated Profile: {recipientPubKey === generatedRecipient.publicKeyHex ? generatedRecipient.label : recipientIdentity.label}
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

          {!fingerprintVerified && (
            <p id="recipient-step-hint" className="text-xs text-[#EFAD45]">
              Tick the fingerprint box above to continue. In this demo the recipient key was generated in your browser, so you can confirm it yourself.
            </p>
          )}
          <div className="flex justify-between pt-2">
            <button
              onClick={() => setStep(1)}
              className="px-4 py-2 text-xs font-medium text-[#94A3B8] hover:text-[#F8FAFC] border border-[#222938] rounded cursor-pointer"
            >
              Back
            </button>
            <button
              disabled={!fingerprintVerified || displayedFingerprint.startsWith('INVALID')}
              aria-describedby={!fingerprintVerified ? 'recipient-step-hint' : undefined}
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
              <div className="text-xs text-[#F59E0B]">Testnet demonstration profile</div>
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
              <div className="text-xs text-[#94A3B8]">Standard interval simulation</div>
              <div className="text-base font-semibold text-[#F8FAFC]">
                8,064 Blocks Interval · 12 Blocks Grace
              </div>
              <p className="text-xs text-[#94A3B8]">
                Requires 6 simulated confirmations. The roughly 7-day interval is an estimate at 75 seconds per block.
              </p>
            </button>
          </div>

          <div className="grid grid-cols-1 sm:grid-cols-3 gap-4 pt-2 text-xs">
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
              <label className="block text-sm font-semibold text-[#10B981] tabular-nums" htmlFor="keeper-threshold">
                <span className="sr-only">Keeper threshold</span>
                <select id="keeper-threshold" value={threshold} onChange={event => setThreshold(Number(event.target.value))} className="w-full bg-transparent text-[#10B981] border-0 p-0 focus:outline-none cursor-pointer">
                  {[2,3,4,5].map(value => <option key={value} value={value} className="bg-[#0B0D11]">{value}-of-5 Threshold</option>)}
                </select>
              </label>
              <span className="text-[10px] text-[#64748B]">Choose how many distinct shares recovery requires.</span>
            </div>
          </div>

          {policyValidationError && (
            <p role="alert" className="text-xs text-[#EF4444]">{policyValidationError}</p>
          )}
          {provisioningError && (
            <p role="alert" className="text-xs text-[#EF4444]">{provisioningError}</p>
          )}

          <div className="flex justify-between pt-2">
            <button
              onClick={() => setStep(2)}
              className="px-4 py-2 text-xs font-medium text-[#94A3B8] hover:text-[#F8FAFC] border border-[#222938] rounded cursor-pointer"
            >
              Back
            </button>
            <button
              disabled={Boolean(policyValidationError)}
              onClick={initiateEncryptionAndProvisioning}
              className="px-5 py-2.5 bg-[#F59E0B] disabled:opacity-40 hover:bg-[#D97706] text-[#0B0D11] font-semibold text-sm rounded transition-colors flex items-center gap-2 cursor-pointer"
            >
              <span>Encrypt Dossier & Provision 5 Keepers</span>
              <ArrowRight className="w-4 h-4" />
            </button>
          </div>
        </div>
      )}

      {/* Step 4: simulated keeper acknowledgements and local registration */}
      {step === 4 && encryptedPkg && (
        <div className="border border-[#222938] bg-[#141820] p-6 lg:p-8 space-y-6">
          <div className="space-y-1">
            <div className="text-xs text-[#10B981]">
              LOCAL DUAL-LAYER ENCRYPTION · 5 KEEPER RECORDS · {threshold}-OF-5 RECOVERY
            </div>
            <h2 className="text-lg font-semibold text-[#F8FAFC]">
              Verify Simulated Keeper Acknowledgements & Prepare Registration Memo
            </h2>
            <p className="text-xs text-[#94A3B8]">
              This browser lab uses five in-memory keeper records. The separate native implementation uses authenticated keeper services and durable SQLite state.
            </p>
          </div>

          {/* Individual Keeper Acknowledgements Table */}
          <div className="border border-[#222938] bg-[#0B0D11] divide-y divide-[#1E2430] text-xs">
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
                <span className="text-[#10B981] shrink-0">Simulated ack</span>
              </div>
            ))}
          </div>

          <div className="space-y-3">
            <div className="text-xs text-[#94A3B8]">Choose how to carry the signed REGISTER command</div>
            <div className="grid grid-cols-1 md:grid-cols-2 gap-3" role="radiogroup" aria-label="Registration transport">
              <button
                type="button"
                role="radio"
                aria-checked={registrationMode === 'simulation'}
                onClick={() => setRegistrationMode('simulation')}
                className={`p-4 border text-left space-y-2 transition-colors ${registrationMode === 'simulation' ? 'border-[#F59E0B] bg-[#0B0D11]' : 'border-[#222938] bg-[#0B0D11]/50 hover:border-[#2E3748]'}`}
              >
                <div className="flex items-center gap-2 text-sm font-semibold text-[#F8FAFC]"><Server className="w-4 h-4 text-[#F59E0B]"/>Browser lifecycle lab</div>
                <p className="text-xs text-[#94A3B8]">Fast, resettable path. Runs the full policy locally with a simulated chain and keeper records.</p>
              </button>
              <button
                type="button"
                role="radio"
                aria-checked={registrationMode === 'external'}
                onClick={() => setRegistrationMode('external')}
                className={`p-4 border text-left space-y-2 transition-colors ${registrationMode === 'external' ? 'border-[#10B981] bg-[#071611]' : 'border-[#222938] bg-[#0B0D11]/50 hover:border-[#2E3748]'}`}
              >
                <div className="flex items-center gap-2 text-sm font-semibold text-[#F8FAFC]"><WalletCards className="w-4 h-4 text-[#10B981]"/>External testnet wallet</div>
                <p className="text-xs text-[#94A3B8]">Creates a real ZIP-321 payment request carrying this signed memo. You send it with a compatible Zcash testnet wallet.</p>
              </button>
            </div>
          </div>

          <div className="grid grid-cols-1 md:grid-cols-2 gap-4 text-xs">
            <div className="p-4 bg-[#0B0D11] border border-[#222938] space-y-1.5">
              <div className="text-[#64748B]">{registrationMode === 'external' ? 'Requested testnet amount' : 'Browser simulation fee assumption'}</div>
              <div className="text-sm font-semibold text-[#F8FAFC] tabular-nums">10,000 zatoshi (0.00010000 TAZ)</div>
              <div className="text-[#94A3B8] tabular-nums">
                {registrationMode === 'external' ? 'Paid by your external wallet; Canary never requests a seed phrase.' : `Available Source Balance: ${walletBalanceZatoshi.toLocaleString()} zatoshi`}
              </div>
            </div>

            <div className="p-4 bg-[#0B0D11] border border-[#222938] space-y-1.5">
              <div className="text-[#64748B]">Browser-only signing-key reference (redacted)</div>
              <div className="text-xs text-[#F59E0B] truncate tabular-nums">{sha256Hex(sourceSecretHex).slice(0, 16)}…</div>
              <div className="text-[#94A3B8]">The full demo key remains in browser memory and is never rendered or sent to the wallet.</div>
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
              I have saved the recovery details for this demo session. The wallet receives only the payment request and signed REGISTER memo, never the file or a private key.
            </span>
          </label>

          {registrationMode === 'external' && externalRequest && (
            <section className="border border-[#10B981]/40 bg-[#071611] p-4 sm:p-5 space-y-4" aria-label="External wallet request">
              <div className="flex items-start justify-between gap-4">
                <div>
                  <div className="text-xs text-[#10B981]">ZIP-321 REQUEST READY · MEMO SIGNATURE VALID</div>
                  <h3 className="text-base font-semibold text-[#F8FAFC] mt-1">Send the registration from your wallet</h3>
                </div>
                <Check className="w-5 h-5 text-[#10B981] shrink-0" aria-hidden="true" />
              </div>
              <ol className="grid grid-cols-1 sm:grid-cols-3 gap-3 text-xs">
                <li className="border border-[#10B981]/20 p-3"><strong className="block text-[#F8FAFC] mb-1">1 · Open request</strong><span className="text-[#94A3B8]">Your wallet reviews the testnet address, amount, and memo.</span></li>
                <li className="border border-[#10B981]/20 p-3"><strong className="block text-[#F8FAFC] mb-1">2 · Send</strong><span className="text-[#94A3B8]">Approve it in the wallet. Canary never sees wallet keys.</span></li>
                <li className="border border-[#10B981]/20 p-3"><strong className="block text-[#F8FAFC] mb-1">3 · Paste txid</strong><span className="text-[#94A3B8]">Open the public transaction record in the testnet explorer.</span></li>
              </ol>
              <div className="flex flex-wrap gap-2">
                <a href={externalRequest.uri} className="px-4 py-2.5 bg-[#10B981] text-[#071611] text-xs font-semibold rounded inline-flex items-center gap-2"><WalletCards className="w-4 h-4"/>Send with Zcash wallet</a>
                <button type="button" onClick={() => void copyWalletValue(externalRequest.uri, 'ZIP-321 request')} className="px-4 py-2.5 border border-[#10B981]/40 text-[#10B981] text-xs font-semibold rounded inline-flex items-center gap-2"><Copy className="w-4 h-4"/>Copy request</button>
                <button type="button" onClick={() => void copyWalletValue(externalRequest.memoHex, 'Signed memo')} className="px-4 py-2.5 border border-[#2E3748] text-[#CBD5E1] text-xs font-semibold rounded inline-flex items-center gap-2"><Copy className="w-4 h-4"/>Copy memo</button>
              </div>
              <div className="space-y-2">
                <label htmlFor="external-wallet-txid" className="block text-xs text-[#94A3B8]">Transaction ID returned by the wallet</label>
                <input id="external-wallet-txid" value={externalTxid} onChange={event => { setExternalTxid(event.target.value); setWalletError(null); }} placeholder="64 hexadecimal characters" spellCheck={false} autoComplete="off" className="w-full px-3.5 py-2.5 bg-[#0B0D11] border border-[#2E3748] rounded text-xs text-[#F8FAFC] font-mono focus:outline-none focus:border-[#10B981]" />
                <p className="text-[11px] text-[#94A3B8]">A supplied txid is not treated as confirmation. The explorer is the source for inclusion and block status.</p>
                {normalizedExternalTxid && <a href={testnetExplorerUrl(normalizedExternalTxid)} target="_blank" rel="noreferrer" className="inline-flex items-center gap-2 text-xs text-[#10B981] hover:underline">Open transaction in Zcash testnet explorer <ExternalLink className="w-3.5 h-3.5"/></a>}
              </div>
            </section>
          )}

          {walletMessage && <p role="status" className="text-xs text-[#10B981]">{walletMessage}</p>}
          {walletError && <p role="alert" className="text-xs text-[#EF4444]">{walletError}</p>}

          <div className="flex justify-between pt-2">
            <button
              onClick={() => setStep(3)}
              className="px-4 py-2 text-xs font-medium text-[#94A3B8] hover:text-[#F8FAFC] border border-[#222938] rounded cursor-pointer"
            >
              Back
            </button>
            {registrationMode === 'simulation' ? (
              <button disabled={!backupConfirmed || provisionedKeepers.length < 5} onClick={handleSimulateRegistration} className="px-5 py-2.5 bg-[#F59E0B] disabled:opacity-40 hover:bg-[#D97706] text-[#0B0D11] font-semibold text-sm rounded transition-colors flex items-center gap-2 cursor-pointer">
                <Lock className="w-4 h-4"/><span>Start Browser Lifecycle</span>
              </button>
            ) : !externalRequest ? (
              <button disabled={!backupConfirmed || provisionedKeepers.length < 5} onClick={handlePrepareExternalRequest} className="px-5 py-2.5 bg-[#10B981] disabled:opacity-40 hover:bg-[#0EA371] text-[#071611] font-semibold text-sm rounded transition-colors flex items-center gap-2 cursor-pointer">
                <WalletCards className="w-4 h-4"/><span>Prepare External Wallet Request</span>
              </button>
            ) : (
              <button disabled={!normalizedExternalTxid} onClick={handleRecordExternalSubmission} className="px-5 py-2.5 bg-[#10B981] disabled:opacity-40 hover:bg-[#0EA371] text-[#071611] font-semibold text-sm rounded transition-colors flex items-center gap-2 cursor-pointer">
                <Check className="w-4 h-4"/><span>Save Txid & Continue to Lifecycle Lab</span>
              </button>
            )}
          </div>
        </div>
      )}
    </div>
  );
};
