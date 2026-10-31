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
const MAYA_REPORTING_NOTES = `MAYA'S REPORTING NOTES — FICTIONAL DEMONSTRATION

Maya is a journalist investigating pollution in the fictional town of Rivergate.
Noor is her editor. These public sample notes contain no real allegations or sources.

Maya wants to keep her notes private while she checks in. If she becomes unreachable,
Noor should be able to recover them only after the deadline, safety window, and required
keeper participation. Noor's private key is still needed to open the file.

Replace this text or choose a harmless file to test your own scenario.`;
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
  const [title, setTitle] = useState('Maya’s reporting notes for Noor');
  const [fileName, setFileName] = useState('Maya-Reporting-Notes.txt');
  const [fileContent, setFileContent] = useState(MAYA_REPORTING_NOTES);
  const [uploadedBytes, setUploadedBytes] = useState<Uint8Array | null>(null);
  const [fileLoading, setFileLoading] = useState(false);
  const [fileError, setFileError] = useState<string | null>(null);
  const [provisioningError, setProvisioningError] = useState<string | null>(null);

  const [generatedRecipient, setGeneratedRecipient] = useState<RecipientIdentity>(() =>
    generateRecipientIdentity('Noor — demo editor')
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
      <div className="flex items-center justify-between border-b border-[var(--line)] pb-5">
        <div>
          <h1 className="text-2xl font-bold text-[var(--ink)]">Your file. Your trusted recipient.</h1>
          <p className="text-sm text-[var(--muted)]">
            Try Maya’s reporting notes or bring a harmless file, up to 10 MiB. Encrypt it for one person, then test what happens when you check in—or go silent.
          </p>
          <p className="text-sm text-[var(--muted)]">
            Real encryption happens in your browser. The walkthrough simulates time and keepers; an optional external wallet request can carry your signed registration on Zcash testnet.
          </p>
        </div>
        <button
          onClick={onCancel}
          className="px-4 py-2 text-xs font-medium text-[var(--muted)] hover:text-[var(--ink)] border border-[var(--line)] rounded cursor-pointer"
        >
          Back to vault
        </button>
      </div>

      {/* Stepper Header */}
      <div aria-label="Creation progress" className="grid grid-cols-2 sm:grid-cols-4 gap-3 text-xs">
        {[
          { num: 1, label: '01. Your file' },
          { num: 2, label: '02. Who receives it' },
          { num: 3, label: '03. When to recover' },
          { num: 4, label: '04. Start the handoff' },
        ].map((s) => (
          <div
            key={s.num}
            aria-current={step === s.num ? 'step' : undefined}
            className={`p-3 border ${
              step === s.num
                ? 'border-[var(--yellow-2)] bg-[var(--card)] rounded-[22px] shadow-[var(--shadow)] text-[var(--ink)]'
                : step > s.num
                ? 'border-[var(--ok)]/40 bg-[var(--card)]/60 rounded-[22px] shadow-[var(--shadow)] text-[var(--ok)]'
                : 'border-[var(--line)] bg-[var(--sunken)] text-[var(--faint)]'
            }`}
          >
            {s.label}
          </div>
        ))}
      </div>

      {/* Step 1: File Selection */}
      {step === 1 && (
        <div className="border border-[var(--line)] bg-[var(--card)] rounded-[22px] shadow-[var(--shadow)] p-6 lg:p-8 space-y-6">
          <div className="space-y-2">
            <label htmlFor="vault-reference" className="block text-xs text-[var(--muted)]">
              Name this handoff — stays in this browser
            </label>
            <input
              id="vault-reference"
              type="text"
              value={title}
              onChange={(e) => setTitle(e.target.value)}
              className="w-full px-3.5 py-2.5 bg-[var(--sunken)] border border-[var(--line)] rounded text-sm text-[var(--ink)] focus:outline-none focus:border-[var(--yellow-2)]"
            />
          </div>

          <div className="space-y-2">
            <label id="dossier-document-label" className="block text-xs text-[var(--muted)]">
              Choose a harmless file — any type, up to 10 MiB
            </label>
            <label onDragOver={e => e.preventDefault()} onDrop={e => { e.preventDefault(); void loadFile(e.dataTransfer.files[0]); }} className="flex flex-col items-center justify-center border border-dashed border-[var(--line)] hover:border-[var(--yellow-2)] bg-[var(--sunken)] p-8 rounded cursor-pointer transition-colors">
              <Upload className="w-6 h-6 text-[var(--accent-ink)] mb-2" />
              <span className="text-sm font-medium text-[var(--ink)]">
                Drop your file here or choose one below
              </span>
              <span className="text-xs text-[var(--faint)] mt-1">
                Active selection: {fileName} ({uploadedBytes?.length ?? new TextEncoder().encode(fileContent).length} bytes)
              </span>
              <input type="file" onChange={handleFileUpload} aria-labelledby="dossier-document-label" aria-describedby={fileError ? 'dossier-file-error' : undefined} accept="*/*" className="mt-3 text-xs max-w-full" />
            </label>
            {fileError && (
              <p id="dossier-file-error" role="alert" className="text-xs text-[var(--bad)] pt-1">{fileError}</p>
            )}
          </div>

          <div className="space-y-2">
            <div className="flex items-center justify-between text-xs text-[var(--muted)]">
              <span>{uploadedBytes ? 'Your selected file' : 'Or edit these fictional reporting notes'}</span>
              <button
                type="button"
                onClick={() => {
                  setUploadedBytes(null);
                  setFileError(null);
                  setFileName('Maya-Reporting-Notes.txt');
                  setFileContent(MAYA_REPORTING_NOTES);
                }}
                className="text-[var(--accent-ink)] hover:underline cursor-pointer"
              >
                Use Maya’s sample
              </button>
            </div>
            <textarea
              rows={6}
              aria-label="Fictional reporting notes"
              disabled={uploadedBytes !== null}
              value={uploadedBytes ? 'Binary file selected. Exact bytes will be encrypted and downloaded.' : fileContent}
              onChange={(e) => setFileContent(e.target.value)}
              className="w-full p-3 bg-[var(--sunken)] border border-[var(--line)] rounded font-mono text-xs text-[var(--muted)] focus:outline-none focus:border-[var(--yellow-2)]"
            />
            <details className="text-xs text-[var(--muted)]">
              <summary className="cursor-pointer">File integrity details</summary>
              <p className="mt-2 break-all">SHA-256: {sha256Hex(uploadedBytes ?? fileContent)}</p>
            </details>
          </div>

          <div className="flex justify-end pt-2">
            <button
              disabled={fileLoading || Boolean(fileError)}
              onClick={() => setStep(2)}
              className="px-5 py-2.5 bg-[var(--yellow)] hover:bg-[var(--yellow-2)] text-[var(--ink)] font-semibold text-sm rounded transition-colors flex items-center gap-2 cursor-pointer"
            >
              <span>Choose who can recover it</span>
              <ArrowRight className="w-4 h-4" />
            </button>
          </div>
        </div>
      )}

      {/* Step 2: Recipient Verification */}
      {step === 2 && (
        <div className="border border-[var(--line)] bg-[var(--card)] rounded-[22px] shadow-[var(--shadow)] p-6 lg:p-8 space-y-6">
          <div className="space-y-2">
            <h2 className="text-lg font-semibold text-[var(--ink)]">
              Who should be able to open it?
            </h2>
            <p className="text-sm text-[var(--muted)]">
              Noor is Maya’s editor in this example. We created a fresh demo key for Noor here,
              so you can play both roles and test recovery without installing anything.
            </p>
          </div>

          <div className="p-4 bg-[var(--sunken)] border border-[var(--ok)]/40 space-y-3">
            <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-3">
              <div>
                <div className="text-xs text-[var(--ok)]">{recipientPubKey === generatedRecipient.publicKeyHex ? 'Noor — ready for the walkthrough' : 'Using another recipient’s public key'}</div>
                <p className="text-xs text-[var(--muted)] mt-1">{recipientPubKey === generatedRecipient.publicKeyHex ? 'Noor’s demo private key stays in this browser session. Later you will use it to open the file.' : 'That recipient will need their matching private key. Canary cannot generate or recover it for them.'}</p>
              </div>
              <button
                type="button"
                onClick={() => {
                  const next = generateRecipientIdentity('Noor — demo editor');
                  setGeneratedRecipient(next);
                  setRecipientPubKey(next.publicKeyHex);
                  setFingerprintVerified(false);
                }}
                className="px-3 py-2 text-xs font-semibold text-[var(--ok)] border border-[var(--ok)]/50 hover:bg-[var(--ok)]/10 cursor-pointer"
              >
                Create a fresh demo key
              </button>
            </div>
          </div>

          <details className="space-y-3 text-sm text-[var(--muted)]">
            <summary className="cursor-pointer">Use another recipient or inspect the key</summary>
            <p className="text-xs">For another person, paste their X25519 public key and compare its fingerprint through a trusted channel. Never paste their private key here.</p>
          <div className="space-y-2">
            <label htmlFor="recipient-public-key" className="block text-xs text-[var(--muted)]">
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
              className="w-full px-3.5 py-2.5 bg-[var(--sunken)] border border-[var(--line)] rounded font-mono text-xs text-[var(--ink)] focus:outline-none focus:border-[var(--yellow-2)]"
            />
          </div>

          <div className="p-4 bg-[var(--sunken)] border border-[var(--line)] space-y-2">
            <div className="text-xs text-[var(--faint)]">
              SHA-256 key fingerprint
            </div>
            <div id="recipient-key-fingerprint" role="status" aria-live="polite" className="text-sm font-mono font-semibold text-[var(--accent-ink)]">
              {displayedFingerprint}
            </div>
            <div className="text-xs text-[var(--muted)]">
              Recipient: {recipientPubKey === generatedRecipient.publicKeyHex ? generatedRecipient.label : 'Your chosen recipient'}
            </div>
          </div>
          </details>

          <label className="flex items-center gap-3 text-sm text-[var(--ink)] cursor-pointer">
            <input
              type="checkbox"
              checked={fingerprintVerified}
              onChange={(e) => setFingerprintVerified(e.target.checked)}
              className="w-4 h-4 accent-[var(--ink)]"
            />
            <span>
              {recipientPubKey === generatedRecipient.publicKeyHex
                ? 'Use Noor’s demo key. I will play the recipient in this browser.'
                : 'I compared this key’s fingerprint with my recipient through a trusted channel.'}
            </span>
          </label>

          {!fingerprintVerified && (
            <p id="recipient-step-hint" className="text-xs text-[var(--accent-ink)]">
              {recipientPubKey === generatedRecipient.publicKeyHex ? 'Confirm the demo recipient above to continue.' : 'Confirm your recipient’s fingerprint above before continuing.'}
            </p>
          )}
          <div className="flex justify-between pt-2">
            <button
              onClick={() => setStep(1)}
              className="px-4 py-2 text-xs font-medium text-[var(--muted)] hover:text-[var(--ink)] border border-[var(--line)] rounded cursor-pointer"
            >
              Back
            </button>
            <button
              disabled={!fingerprintVerified || displayedFingerprint.startsWith('INVALID')}
              aria-describedby={!fingerprintVerified ? 'recipient-step-hint' : undefined}
              onClick={() => setStep(3)}
              className="px-5 py-2.5 bg-[var(--yellow)] disabled:opacity-40 hover:bg-[var(--yellow-2)] text-[var(--ink)] font-semibold text-sm rounded transition-colors flex items-center gap-2 cursor-pointer"
            >
              <span>Choose recovery rules</span>
              <ArrowRight className="w-4 h-4" />
            </button>
          </div>
        </div>
      )}

      {/* Step 3: Release Deadline & Cadence */}
      {step === 3 && (
        <div className="border border-[var(--line)] bg-[var(--card)] rounded-[22px] shadow-[var(--shadow)] p-6 lg:p-8 space-y-6">
          <div className="space-y-2">
            <h2 className="text-lg font-semibold text-[var(--ink)]">
              Give yourself time to check in.
            </h2>
            <p className="text-sm text-[var(--muted)]">
              A missed check-in starts a safety window before recovery can begin. Use the quick
              walkthrough to advance time with buttons, or explore a longer interval.
            </p>
          </div>

          <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
            <button
              type="button"
              onClick={() => handleSelectProfile('TESTNET_DEMO')}
              className={`p-4 border text-left space-y-2 cursor-pointer transition-colors ${
                profileMode === 'TESTNET_DEMO'
                  ? 'border-[var(--yellow-2)] bg-[var(--sunken)]'
                  : 'border-[var(--line)] bg-[var(--sunken)]/50 hover:border-[var(--line)]'
              }`}
            >
              <div className="text-xs text-[var(--accent-ink)]">Quick walkthrough · recommended</div>
              <div className="text-base font-semibold text-[var(--ink)]">
                Short interval + safety window
              </div>
              <p className="text-xs text-[var(--muted)]">
                24 blocks between check-ins, then 6 blocks of grace. In the browser lab, advance them instantly with buttons.
              </p>
            </button>

            <button
              type="button"
              onClick={() => handleSelectProfile('STANDARD_PRODUCTION')}
              className={`p-4 border text-left space-y-2 cursor-pointer transition-colors ${
                profileMode === 'STANDARD_PRODUCTION'
                  ? 'border-[var(--yellow-2)] bg-[var(--sunken)]'
                  : 'border-[var(--line)] bg-[var(--sunken)]/50 hover:border-[var(--line)]'
              }`}
            >
              <div className="text-xs text-[var(--muted)]">Longer interval · simulation</div>
              <div className="text-base font-semibold text-[var(--ink)]">
                About a week between check-ins
              </div>
              <p className="text-xs text-[var(--muted)]">
                8,064 blocks, then 12 blocks of grace. About seven days at 75 seconds per block; actual block times vary.
              </p>
            </button>
          </div>

          <details className="text-sm text-[var(--muted)]">
            <summary className="cursor-pointer">Exact block deadlines and confirmation rules</summary>
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-4 pt-3 text-xs">
            <div className="p-3.5 bg-[var(--sunken)] border border-[var(--line)] space-y-1">
              <span className="text-[var(--faint)]">Initial Expiry Height</span>
              <div className="text-sm font-semibold text-[var(--ink)] tabular-nums">
                #{(currentBlockHeight + intervalBlocks).toLocaleString()} (+{intervalBlocks} blocks)
              </div>
            </div>
            <div className="p-3.5 bg-[var(--sunken)] border border-[var(--line)] space-y-1">
              <span className="text-[var(--faint)]">Grace Release Boundary</span>
              <div className="text-sm font-semibold text-[var(--accent-ink)] tabular-nums">
                #{(currentBlockHeight + intervalBlocks + graceBlocks).toLocaleString()} (+{graceBlocks} grace)
              </div>
            </div>
          </div>
          <p className="text-xs mt-3">Commands require {confirmationTarget} confirmations. This browser lab simulates those blocks; deadlines use confirmed height, not a wall-clock timer.</p>
          </details>
            <div className="p-4 bg-[var(--sunken)] border border-[var(--line)] space-y-2">
              <label htmlFor="keeper-threshold" className="text-sm text-[var(--ink)]">How many keepers must participate?</label>
              <label className="block text-sm font-semibold text-[var(--ok)] tabular-nums" htmlFor="keeper-threshold">
                <span className="sr-only">Keeper threshold</span>
                <select id="keeper-threshold" value={threshold} onChange={event => setThreshold(Number(event.target.value))} className="w-full bg-transparent text-[var(--ok)] border-0 p-0 focus:outline-none cursor-pointer">
                  {[2,3,4,5].map(value => <option key={value} value={value} className="bg-[var(--sunken)]">{value} of 5 keepers{value === 3 ? ' · recommended' : ''}</option>)}
                </select>
              </label>
              <p className="text-xs text-[var(--muted)]">Each keeper holds one piece of the release key. Recovery needs {threshold} different pieces and the recipient’s private key.</p>
            </div>

          {policyValidationError && (
            <p role="alert" className="text-xs text-[var(--bad)]">{policyValidationError}</p>
          )}
          {provisioningError && (
            <p role="alert" className="text-xs text-[var(--bad)]">{provisioningError}</p>
          )}

          <div className="flex justify-between pt-2">
            <button
              onClick={() => setStep(2)}
              className="px-4 py-2 text-xs font-medium text-[var(--muted)] hover:text-[var(--ink)] border border-[var(--line)] rounded cursor-pointer"
            >
              Back
            </button>
            <button
              disabled={Boolean(policyValidationError)}
              onClick={initiateEncryptionAndProvisioning}
              className="px-5 py-2.5 bg-[var(--yellow)] disabled:opacity-40 hover:bg-[var(--yellow-2)] text-[var(--ink)] font-semibold text-sm rounded transition-colors flex items-center gap-2 cursor-pointer"
            >
              <span>Encrypt my file</span>
              <ArrowRight className="w-4 h-4" />
            </button>
          </div>
        </div>
      )}

      {/* Step 4: simulated keeper acknowledgements and local registration */}
      {step === 4 && encryptedPkg && (
        <div className="border border-[var(--line)] bg-[var(--card)] rounded-[22px] shadow-[var(--shadow)] p-6 lg:p-8 space-y-6">
          <div className="space-y-1">
            <div className="text-xs text-[var(--ok)]">
              FILE ENCRYPTED HERE · {threshold} OF 5 KEEPERS REQUIRED
            </div>
            <h2 className="text-lg font-semibold text-[var(--ink)]">
              Your file is encrypted. Try the handoff.
            </h2>
            <p className="text-xs text-[var(--muted)]">
              Test a check-in, miss a deadline, and recover as the recipient. Five simulated keeper records are ready; your file and private keys stay in this session.
            </p>
          </div>

          {/* Individual Keeper Acknowledgements Table */}
          <details className="text-sm text-[var(--muted)]">
            <summary className="cursor-pointer">Inspect the five simulated keepers</summary>
          <div className="border border-[var(--line)] bg-[var(--sunken)] divide-y divide-[var(--line)] text-xs mt-3">
            {generatedShares.map((s) => (
              <div key={s.index} className="p-3 flex items-center justify-between gap-4">
                <div className="flex items-center gap-3">
                  <Check className="w-4 h-4 text-[var(--ok)] shrink-0" />
                  <span className="text-[var(--ink)] font-medium">Keeper 0{s.index}</span>
                  <span className="text-[var(--faint)]">·</span>
                  <span className="text-[var(--muted)]">
                    Commitment: {s.commitmentHex.slice(0, 20)}…
                  </span>
                </div>
                <span className="text-[var(--ok)] shrink-0">Simulated ack</span>
              </div>
            ))}
          </div>
          </details>

          <div className="space-y-3">
            <div className="text-sm text-[var(--ink)]">Choose your next step</div>
            <div className="grid grid-cols-1 md:grid-cols-2 gap-3" role="radiogroup" aria-label="Registration transport">
              <button
                type="button"
                role="radio"
                aria-checked={registrationMode === 'simulation'}
                onClick={() => setRegistrationMode('simulation')}
                className={`p-4 border text-left space-y-2 transition-colors ${registrationMode === 'simulation' ? 'border-[var(--yellow-2)] bg-[var(--sunken)]' : 'border-[var(--line)] bg-[var(--sunken)]/50 hover:border-[var(--line)]'}`}
              >
                <div className="flex items-center gap-2 text-sm font-semibold text-[var(--ink)]"><Server className="w-4 h-4 text-[var(--accent-ink)]"/>Try the full walkthrough</div>
                <p className="text-xs text-[var(--muted)]">Recommended. Real encryption and recovery, simulated time and keepers. No wallet or funds needed.</p>
              </button>
              <button
                type="button"
                role="radio"
                aria-checked={registrationMode === 'external'}
                onClick={() => setRegistrationMode('external')}
                className={`p-4 border text-left space-y-2 transition-colors ${registrationMode === 'external' ? 'border-[var(--ok)] bg-[var(--sunken)]' : 'border-[var(--line)] bg-[var(--sunken)]/50 hover:border-[var(--line)]'}`}
              >
                <div className="flex items-center gap-2 text-sm font-semibold text-[var(--ink)]"><WalletCards className="w-4 h-4 text-[var(--ok)]"/>External testnet wallet</div>
                <p className="text-xs text-[var(--muted)]">Creates a real ZIP-321 payment request carrying this signed memo. You send it with a compatible Zcash testnet wallet.</p>
              </button>
            </div>
          </div>

          <details className="text-sm text-[var(--muted)]" open={registrationMode === 'external' || undefined}>
            <summary className="cursor-pointer">{registrationMode === 'external' ? 'Testnet amount and signing details' : 'Simulated fee and signing details'}</summary>
          <div className="grid grid-cols-1 md:grid-cols-2 gap-4 text-xs mt-3">
            <div className="p-4 bg-[var(--sunken)] border border-[var(--line)] space-y-1.5">
              <div className="text-[var(--faint)]">{registrationMode === 'external' ? 'Requested testnet amount' : 'Browser simulation fee assumption'}</div>
              <div className="text-sm font-semibold text-[var(--ink)] tabular-nums">10,000 zatoshi (0.00010000 TAZ)</div>
              <div className="text-[var(--muted)] tabular-nums">
                {registrationMode === 'external' ? 'Paid by your external wallet; Canary never requests a seed phrase.' : `Available Source Balance: ${walletBalanceZatoshi.toLocaleString()} zatoshi`}
              </div>
            </div>

            <div className="p-4 bg-[var(--sunken)] border border-[var(--line)] space-y-1.5">
              <div className="text-[var(--faint)]">Browser-only signing-key reference (redacted)</div>
              <div className="text-xs text-[var(--accent-ink)] truncate tabular-nums">{sha256Hex(sourceSecretHex).slice(0, 16)}…</div>
              <div className="text-[var(--muted)]">The full demo key remains in browser memory and is never rendered or sent to the wallet.</div>
            </div>
          </div>
          </details>

          <label className="flex items-center gap-3 text-sm text-[var(--ink)] cursor-pointer">
            <input
              type="checkbox"
              checked={backupConfirmed}
              onChange={(e) => setBackupConfirmed(e.target.checked)}
              className="w-4 h-4 accent-[var(--ink)]"
            />
            <span>
              I understand this is a temporary walkthrough. Refreshing or closing the page loses the demo keys and progress. I am using a harmless file.
            </span>
          </label>

          {registrationMode === 'external' && externalRequest && (
            <section className="border border-[var(--ok)]/40 bg-[var(--sunken)] p-4 sm:p-5 space-y-4" aria-label="External wallet request">
              <div className="flex items-start justify-between gap-4">
                <div>
                  <div className="text-xs text-[var(--ok)]">ZIP-321 REQUEST READY · MEMO SIGNATURE VALID</div>
                  <h3 className="text-base font-semibold text-[var(--ink)] mt-1">Send the registration from your wallet</h3>
                </div>
                <Check className="w-5 h-5 text-[var(--ok)] shrink-0" aria-hidden="true" />
              </div>
              <ol className="grid grid-cols-1 sm:grid-cols-3 gap-3 text-xs">
                <li className="border border-[var(--ok)]/20 p-3"><strong className="block text-[var(--ink)] mb-1">1 · Open request</strong><span className="text-[var(--muted)]">Your wallet reviews the testnet address, amount, and memo.</span></li>
                <li className="border border-[var(--ok)]/20 p-3"><strong className="block text-[var(--ink)] mb-1">2 · Send</strong><span className="text-[var(--muted)]">Approve it in the wallet. Canary never sees wallet keys.</span></li>
                <li className="border border-[var(--ok)]/20 p-3"><strong className="block text-[var(--ink)] mb-1">3 · Paste txid</strong><span className="text-[var(--muted)]">Open the public transaction record in the testnet explorer.</span></li>
              </ol>
              <div className="flex flex-wrap gap-2">
                <a href={externalRequest.uri} className="px-4 py-2.5 bg-[var(--ok)] text-[var(--ink)] text-xs font-semibold rounded inline-flex items-center gap-2"><WalletCards className="w-4 h-4"/>Send with Zcash wallet</a>
                <button type="button" onClick={() => void copyWalletValue(externalRequest.uri, 'ZIP-321 request')} className="px-4 py-2.5 border border-[var(--ok)]/40 text-[var(--ok)] text-xs font-semibold rounded inline-flex items-center gap-2"><Copy className="w-4 h-4"/>Copy request</button>
                <button type="button" onClick={() => void copyWalletValue(externalRequest.memoHex, 'Signed memo')} className="px-4 py-2.5 border border-[var(--line)] text-[var(--muted)] text-xs font-semibold rounded inline-flex items-center gap-2"><Copy className="w-4 h-4"/>Copy memo</button>
              </div>
              <div className="space-y-2">
                <label htmlFor="external-wallet-txid" className="block text-xs text-[var(--muted)]">Transaction ID returned by the wallet</label>
                <input id="external-wallet-txid" value={externalTxid} onChange={event => { setExternalTxid(event.target.value); setWalletError(null); }} placeholder="64 hexadecimal characters" spellCheck={false} autoComplete="off" className="w-full px-3.5 py-2.5 bg-[var(--sunken)] border border-[var(--line)] rounded text-xs text-[var(--ink)] font-mono focus:outline-none focus:border-[var(--ok)]" />
                <p className="text-[11px] text-[var(--muted)]">A supplied txid is not treated as confirmation. The explorer is the source for inclusion and block status.</p>
                {normalizedExternalTxid && <a href={testnetExplorerUrl(normalizedExternalTxid)} target="_blank" rel="noreferrer" className="inline-flex items-center gap-2 text-xs text-[var(--ok)] hover:underline">Open transaction in Zcash testnet explorer <ExternalLink className="w-3.5 h-3.5"/></a>}
              </div>
            </section>
          )}

          {walletMessage && <p role="status" className="text-xs text-[var(--ok)]">{walletMessage}</p>}
          {walletError && <p role="alert" className="text-xs text-[var(--bad)]">{walletError}</p>}

          <div className="flex justify-between pt-2">
            <button
              onClick={() => setStep(3)}
              className="px-4 py-2 text-xs font-medium text-[var(--muted)] hover:text-[var(--ink)] border border-[var(--line)] rounded cursor-pointer"
            >
              Back
            </button>
            {registrationMode === 'simulation' ? (
              <button disabled={!backupConfirmed || provisionedKeepers.length < 5} onClick={handleSimulateRegistration} className="px-5 py-2.5 bg-[var(--yellow)] disabled:opacity-40 hover:bg-[var(--yellow-2)] text-[var(--ink)] font-semibold text-sm rounded transition-colors flex items-center gap-2 cursor-pointer">
                <Lock className="w-4 h-4"/><span>Start my walkthrough</span>
              </button>
            ) : !externalRequest ? (
              <button disabled={!backupConfirmed || provisionedKeepers.length < 5} onClick={handlePrepareExternalRequest} className="px-5 py-2.5 bg-[var(--ok)] disabled:opacity-40 hover:bg-[var(--ok)] text-[var(--ink)] font-semibold text-sm rounded transition-colors flex items-center gap-2 cursor-pointer">
                <WalletCards className="w-4 h-4"/><span>Prepare External Wallet Request</span>
              </button>
            ) : (
              <button disabled={!normalizedExternalTxid} onClick={handleRecordExternalSubmission} className="px-5 py-2.5 bg-[var(--ok)] disabled:opacity-40 hover:bg-[var(--ok)] text-[var(--ink)] font-semibold text-sm rounded transition-colors flex items-center gap-2 cursor-pointer">
                <Check className="w-4 h-4"/><span>Save Txid & Continue to Lifecycle Lab</span>
              </button>
            )}
          </div>
        </div>
      )}
    </div>
  );
};
