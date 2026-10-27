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
import { decryptDossierDualLayer, RecipientIdentity, bytesToBase64, base64ToBytes } from '../crypto/envelope';
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
  const [reconstructed, setReconstructed] = useState(false);

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
    let releaseKeyBytes: Uint8Array | undefined;
    try {
      // Step 1: Reconstruct 32-byte outer ReleaseKey from >= 3 valid Keeper shares
      releaseKeyBytes = reconstructSecret(
        vault.deliveredSharesToRecipient,
        vault.manifest.switchIdHex,
        vault.manifest.configurationEpoch,
        vault.manifest.shareCommitments,
        threshold
      );
      setReconstructed(false);

      // Step 2: Unwrap outer AES-256-GCM and inner X25519 recipient layer
      const decryptedBytes = decryptDossierDualLayer(
        vault.encryptedPackage,
        releaseKeyBytes,
        recipientPrivInput,
        vault.manifest.recipientPubKeyHex,
        vault.manifest.packageDigestHex
      );

      setReconstructed(true);
      releaseKeyBytes.fill(0);
      onDecryptSuccess(bytesToBase64(decryptedBytes));
      decryptedBytes.fill(0);
    } catch (err: any) {
      setDecryptError(err?.message || 'Decryption failed');
    } finally { releaseKeyBytes?.fill(0); }
  };

  const handleDownloadDossier = () => {
    if (vault.decryptedContentText === null) return;
    const bytes = base64ToBytes(vault.decryptedContentText);
    const blob = new Blob([new Uint8Array(bytes).buffer], { type: 'application/octet-stream' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = vault.fileName;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(url);
  };

  return <div className="recipient-workspace">
    <div className="product-heading"><div><span className="section-label">RECIPIENT / SECURE RECOVERY</span><h1>An archive,<br/>waiting for you.</h1><p>Recovery needs the permitted threshold and the designated recipient’s private key.</p></div><span className="recipient-state"><span className="signal-dot"/>{inboxState.replaceAll('_',' ')}</span></div>
    <section className="recovery-layout">
      <div className="recovery-artifact"><div className="artifact-symbol" aria-hidden="true"><FileText size={68} strokeWidth={.7}/><span>{vault.decryptedByRecipient?<CheckCircle2 size={20}/>:<Lock size={20}/>}</span></div><span className="section-label">{vault.decryptedByRecipient?'RECOVERED DEMO DOSSIER':'ENCRYPTED DEMO DOSSIER'}</span><h2>{vault.fileName}</h2><p>{vault.decryptedByRecipient?'Authenticated decryption succeeded. The original bytes are ready to download.':deliveredCount>=threshold?'The keeper threshold is available. The recipient layer still requires your key.':'The evidence remains encrypted while the release conditions are unmet.'}</p><div className="artifact-fingerprint"><span>RECIPIENT FINGERPRINT</span><code>{recipientIdentity.fingerprint}</code></div></div>
      <div className="recovery-controls"><div className="recovery-count"><strong>{deliveredCount}<span> / {threshold}</span></strong><div>SHARES RECEIVED<br/><span>Three distinct valid shares required</span></div></div>
        <ol className="share-stations">{[1,2,3,4,5].map(index=>{const delivered=vault.deliveredSharesToRecipient.some(s=>s.index===index);return <li key={index} className={delivered?'is-received':''}><span>0{index}</span><div><strong>Keeper station {index}</strong><small>{delivered?'Share received · commitment checked on recovery':'Share withheld'}</small></div>{delivered?<CheckCircle2 size={16}/>:<Lock size={15}/>}</li>;})}</ol>
        <label className="recipient-key-label" htmlFor="demo-recipient-key">Demo recipient key<input id="demo-recipient-key" type="password" autoComplete="off" spellCheck={false} value={recipientPrivInput} onChange={event=>setRecipientPrivInput(event.target.value)}/></label>
        <button className="canary-button primary" onClick={handleAttemptDecryption} disabled={deliveredCount<threshold}><Unlock size={16}/>Verify and decrypt</button>
        {deliveredCount<threshold&&<details className="recovery-test-controls"><summary>Explore the simulation</summary><button className="canary-button quiet" onClick={onTriggerExpiryForDemo}><FastForward size={14}/>Advance past grace</button><button className="canary-button quiet" onClick={handleAttemptDecryption}>Test premature decryption</button></details>}
        {decryptError&&<div role="alert" className="recovery-error"><ShieldAlert size={18}/><div><strong>Decryption blocked</strong><p>{decryptError}</p></div></div>}
        {reconstructed&&<p role="status" className="recovery-success"><CheckCircle2 size={16}/>Threshold and authenticated decryption verified.</p>}
      </div>
    </section>
    {vault.decryptedByRecipient&&vault.decryptedContentText!==null&&<section className="recovered-file"><div><span className="section-label">RECOVERY COMPLETE</span><h2>Original bytes. Verified integrity.</h2><p>The document is ready to download. Its content is never rendered in this page.</p><code>SHA-256 {vault.encryptedPackage.plaintextDigestHex}</code></div><button className="canary-button primary" onClick={handleDownloadDossier}><Download size={16}/>Download verified dossier</button></section>}
  </div>;
};
