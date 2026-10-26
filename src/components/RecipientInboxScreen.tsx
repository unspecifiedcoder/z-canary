import React, { useState } from 'react';
import {
  Lock,
  Unlock,
  KeyRound,
  Download,
  CheckCircle2,
  AlertTriangle,
  FileText,
  ShieldAlert,
  FastForward,
} from 'lucide-react';
import { bytesToHex, reconstructSecret } from '../crypto/shamir';
import { decryptDossierDualLayer, RecipientIdentity } from '../crypto/envelope';
import { ContinuityVault } from '../engine/protocolStore';

interface RecipientInboxScreenProps {
  vault: ContinuityVault;
  recipientIdentity: RecipientIdentity;
  currentBlockHeight: number;
  onDecryptSuccess: (plaintext: string) => void;
  onTriggerExpiryForDemo: () => void;
}

export const RecipientInboxScreen: React.FC<RecipientInboxScreenProps> = ({
  vault,
  recipientIdentity,
  currentBlockHeight,
  onDecryptSuccess,
  onTriggerExpiryForDemo,
}) => {
  const [recipientPrivInput, setRecipientPrivInput] = useState(recipientIdentity.privateKeyHex);
  const [decryptError, setDecryptError] = useState<string | null>(null);
  const [reconstructedKeyHex, setReconstructedKeyHex] = useState<string | null>(null);

  const deliveredCount = vault.deliveredSharesToRecipient.length;
  const threshold = vault.manifest.threshold; // 3

  // Distinct Recipient States: "LOCKED" | "WAITING_SHARES" | "READY_TO_DECRYPT" | "DECRYPTED"
  const inboxState = vault.decryptedByRecipient
    ? 'DECRYPTED'
    : deliveredCount >= threshold
    ? 'READY_TO_DECRYPT'
    : deliveredCount > 0 || currentBlockHeight >= vault.currentExpiryHeight
    ? 'WAITING_SHARES'
    : 'LOCKED';

  const handleAttemptDecryption = () => {
    setDecryptError(null);
    try {
      // Step 1: Reconstruct 32-byte outer ReleaseKey from >= 3 valid Keeper shares
      const releaseKeyBytes = reconstructSecret(
        vault.deliveredSharesToRecipient,
        vault.manifest.switchIdHex,
        vault.manifest.configurationEpoch,
        vault.manifest.shareCommitments,
        threshold
      );
      setReconstructedKeyHex(bytesToHex(releaseKeyBytes));

      // Step 2: Unwrap outer AES-256-GCM and inner X25519 recipient layer
      const decryptedBytes = decryptDossierDualLayer(
        vault.encryptedPackage,
        releaseKeyBytes,
        recipientPrivInput,
        vault.manifest.recipientPubKeyHex
      );

      const plaintext = new TextDecoder().decode(decryptedBytes);
      onDecryptSuccess(plaintext);
    } catch (err: any) {
      setDecryptError(err?.message || 'Decryption failed');
    }
  };

  const handleDownloadDossier = () => {
    if (!vault.decryptedContentText) return;
    const blob = new Blob([vault.decryptedContentText], { type: 'text/plain;charset=utf-8' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = vault.fileName.replace(/\.pdf$/i, '') + '-DECRYPTED.txt';
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(url);
  };

  return (
    <div className="space-y-8 pb-16">
      {/* Header & Recipient Identity Bar */}
      <section className="border border-[#222938] bg-[#141820] p-6 lg:p-8 space-y-6">
        <div className="flex flex-col lg:flex-row lg:items-center justify-between gap-4 border-b border-[#222938] pb-6">
          <div className="space-y-1">
            <div className="text-xs font-mono text-[#94A3B8]">
              DESIGNATED RECIPIENT TERMINAL · {recipientIdentity.label.toUpperCase()}
            </div>
            <h1 className="text-2xl font-bold text-[#F8FAFC]">Recipient Continuity Inbox</h1>
            <p className="text-xs font-mono text-[#94A3B8]">
              Verified X25519 Fingerprint: <span className="text-[#F59E0B]">{recipientIdentity.fingerprint}</span>
            </p>
          </div>

          {/* Distinct State Indicator */}
          <div className="p-3.5 bg-[#0B0D11] border border-[#222938] font-mono text-xs flex items-center gap-3 shrink-0">
            {inboxState === 'LOCKED' && (
              <>
                <Lock className="w-4 h-4 text-[#94A3B8]" />
                <div>
                  <div className="text-[#F8FAFC] font-semibold">STATE: LOCKED</div>
                  <div className="text-[#64748B]">0 of 5 Keeper shares delivered</div>
                </div>
              </>
            )}
            {inboxState === 'WAITING_SHARES' && (
              <>
                <AlertTriangle className="w-4 h-4 text-[#F59E0B]" />
                <div>
                  <div className="text-[#F59E0B] font-semibold">STATE: WAITING FOR KEEPER SHARES</div>
                  <div className="text-[#94A3B8]">
                    {deliveredCount} of 5 shares received (Need {threshold})
                  </div>
                </div>
              </>
            )}
            {inboxState === 'READY_TO_DECRYPT' && (
              <>
                <KeyRound className="w-4 h-4 text-[#10B981]" />
                <div>
                  <div className="text-[#10B981] font-semibold">STATE: READY TO DECRYPT</div>
                  <div className="text-[#94A3B8]">
                    {deliveredCount} of 5 verified shares collected (Threshold met)
                  </div>
                </div>
              </>
            )}
            {inboxState === 'DECRYPTED' && (
              <>
                <CheckCircle2 className="w-4 h-4 text-[#10B981]" />
                <div>
                  <div className="text-[#10B981] font-semibold">STATE: AUTHENTICATED & DECRYPTED</div>
                  <div className="text-[#94A3B8]">SHA-256 Digest Verified</div>
                </div>
              </>
            )}
          </div>
        </div>

        {/* Share Collection Matrix (1..5) */}
        <div className="space-y-3">
          <div className="flex items-center justify-between text-xs font-mono">
            <span className="text-[#94A3B8]">
              THRESHOLD SHARE COLLECTION ({deliveredCount}/5 DELIVERED · MINIMUM 3 REQUIRED)
            </span>
            {deliveredCount < threshold && (
              <button
                onClick={onTriggerExpiryForDemo}
                className="text-[#F59E0B] hover:underline flex items-center gap-1 cursor-pointer"
              >
                <FastForward className="w-3.5 h-3.5" />
                <span>Demo Shortcut: Advance Chain Past Grace (#{vault.graceDeadlineHeight})</span>
              </button>
            )}
          </div>

          <div className="grid grid-cols-1 sm:grid-cols-5 gap-3 font-mono text-xs">
            {[1, 2, 3, 4, 5].map((idx) => {
              const delivered = vault.deliveredSharesToRecipient.find((s) => s.index === idx);
              const expectedComm = vault.manifest.shareCommitments[idx] || '';
              return (
                <div
                  key={idx}
                  className={`p-3.5 border space-y-1.5 ${
                    delivered
                      ? 'border-[#10B981]/50 bg-[#0B0D11] text-[#F8FAFC]'
                      : 'border-[#222938] bg-[#0B0D11]/50 text-[#64748B]'
                  }`}
                >
                  <div className="flex items-center justify-between">
                    <span className="font-semibold">Share #0{idx}</span>
                    <span className={delivered ? 'text-[#10B981]' : 'text-[#64748B]'}>
                      {delivered ? 'RECEIVED' : 'WITHHELD'}
                    </span>
                  </div>
                  <div className="text-[11px] truncate">
                    {delivered ? `Data: ${delivered.dataHex.slice(0, 12)}…` : 'Guarded by Keeper'}
                  </div>
                  <div className="text-[10px] text-[#64748B] truncate">
                    Comm: {expectedComm.slice(0, 12)}…
                  </div>
                </div>
              );
            })}
          </div>
        </div>

        {/* Recipient Private Key & Decryption Action */}
        <div className="pt-4 border-t border-[#222938] space-y-4">
          <div className="grid grid-cols-1 lg:grid-cols-12 gap-4 items-end">
            <div className="lg:col-span-8 space-y-1.5">
              <label className="block text-xs font-mono text-[#94A3B8]">
                Recipient Local X25519 Private Key (Required to Unwrap Inner Envelope After Threshold Reconstruction)
              </label>
              <input
                type="text"
                value={recipientPrivInput}
                onChange={(e) => setRecipientPrivInput(e.target.value)}
                className="w-full px-3.5 py-2.5 bg-[#0B0D11] border border-[#222938] rounded font-mono text-xs text-[#F8FAFC] focus:outline-none focus:border-[#F59E0B]"
              />
            </div>

            <div className="lg:col-span-4 flex items-center gap-3">
              <button
                onClick={handleAttemptDecryption}
                className={`w-full py-2.5 px-4 font-semibold text-xs rounded transition-colors flex items-center justify-center gap-2 cursor-pointer ${
                  deliveredCount >= threshold
                    ? 'bg-[#10B981] hover:bg-[#059669] text-[#0B0D11]'
                    : 'bg-[#1E2430] hover:bg-[#283040] text-[#E2E8F0] border border-[#2E3748]'
                }`}
              >
                <Unlock className="w-4 h-4" />
                <span>
                  {deliveredCount >= threshold
                    ? 'Reconstruct Key & Decrypt Dossier'
                    : 'Test Premature Decryption (Will Fail)'}
                </span>
              </button>
            </div>
          </div>

          {decryptError && (
            <div className="p-4 bg-[#0B0D11] border border-[#EF4444]/60 font-mono text-xs text-[#EF4444] flex items-start gap-3">
              <ShieldAlert className="w-4 h-4 shrink-0 mt-0.5" />
              <div className="space-y-1">
                <div className="font-semibold">CRYPTOGRAPHIC ENFORCEMENT BLOCKED DECRYPTION</div>
                <div>{decryptError}</div>
              </div>
            </div>
          )}

          {reconstructedKeyHex && (
            <div className="p-4 bg-[#0B0D11] border border-[#10B981]/50 font-mono text-xs space-y-1">
              <div className="text-[#10B981] font-semibold">
                GF(256) LAGRANGE INTERPOLATION SUCCEEDED (3 OF 5 SHARES)
              </div>
              <div className="text-[#CBD5E1] break-all">
                Reconstructed Outer Release Key: {reconstructedKeyHex}
              </div>
            </div>
          )}
        </div>
      </section>

      {/* Decrypted Dossier Output & Integrity Verification */}
      {vault.decryptedByRecipient && vault.decryptedContentText && (
        <section className="border border-[#10B981]/50 bg-[#141820] p-6 lg:p-8 space-y-6">
          <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-4 border-b border-[#222938] pb-4">
            <div className="space-y-1">
              <div className="text-xs font-mono text-[#10B981]">
                AUTHENTICATED DECRYPTION COMPLETE · SHA-256 INTEGRITY VERIFIED
              </div>
              <h2 className="text-lg font-bold text-[#F8FAFC]">{vault.fileName}</h2>
              <p className="text-xs font-mono text-[#94A3B8]">
                Verified Plaintext Digest: {vault.encryptedPackage.plaintextDigestHex}
              </p>
            </div>

            <button
              onClick={handleDownloadDossier}
              className="px-4 py-2.5 bg-[#F59E0B] hover:bg-[#D97706] text-[#0B0D11] font-semibold text-xs rounded flex items-center gap-2 whitespace-nowrap shrink-0 cursor-pointer"
            >
              <Download className="w-4 h-4" />
              <span>Download Verified Dossier</span>
            </button>
          </div>

          <pre className="p-5 bg-[#0B0D11] border border-[#222938] font-mono text-xs text-[#E2E8F0] whitespace-pre-wrap leading-relaxed overflow-x-auto">
            {vault.decryptedContentText}
          </pre>
        </section>
      )}
    </div>
  );
};
