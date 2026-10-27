import React, { useState } from 'react';
import { Copy, Download, KeyRound, LoaderCircle, Upload } from 'lucide-react';
import { downloadBytes, nativeVaultApi, type NativeIdentityBackup, type NativeSupportRequest } from '../services/nativeVault';

export default function NativeRecoveryTools({ baseUrl, token, enabled }: { baseUrl: string; token: string; enabled: boolean }) {
  const [support, setSupport] = useState<NativeSupportRequest | null>(null);
  const [role, setRole] = useState<'source' | 'recipient'>('recipient');
  const [passphrase, setPassphrase] = useState('');
  const [confirmation, setConfirmation] = useState('');
  const [fingerprint, setFingerprint] = useState('');
  const [backup, setBackup] = useState<NativeIdentityBackup | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [message, setMessage] = useState('');
  const [error, setError] = useState('');
  const fail = (reason: unknown) => setError(reason instanceof Error ? reason.message : 'The agent request failed.');
  const validPassphrase = new TextEncoder().encode(passphrase).length >= 12 && new TextEncoder().encode(passphrase).length <= 1024;

  const loadSupport = async () => {
    setBusy('support'); setError(''); setMessage('');
    try {
      const result = await nativeVaultApi.support(baseUrl, token);
      if (result.network !== 'testnet' || !/^utest1[0-9a-z]+$/.test(result.address) || result.memo !== null || result.uri !== `zcash:${result.address}?amount=0.00100000` || result.amountZatoshi !== 100000) throw new Error('The agent returned an unexpected payment request. No request is displayed.');
      setSupport(result);
    } catch (reason) { setSupport(null); fail(reason); }
    finally { setBusy(null); }
  };
  const exportBackup = async () => {
    if (!validPassphrase || passphrase !== confirmation) return;
    setBusy('export'); setError(''); setMessage('');
    try {
      const result = await nativeVaultApi.exportIdentity(baseUrl, token, role, passphrase);
      if (result.version !== 1 || result.role !== role || !/^[a-f0-9]{64}$/.test(result.fingerprint) || typeof result.encryptedBase64 !== 'string') throw new Error('Invalid encrypted backup response.');
      downloadBytes(`canary-${role}.zcanary-identity.json`, new TextEncoder().encode(JSON.stringify(result, null, 2)));
      setMessage(`Encrypted ${role} identity downloaded. Record its fingerprint separately: ${result.fingerprint}`);
    } catch (reason) { fail(reason); }
    finally { setPassphrase(''); setConfirmation(''); setBusy(null); }
  };
  const readBackup = async (file?: File) => {
    setBackup(null); setError('');
    if (!file) return;
    try {
      if (file.size > 384 * 1024) throw new Error('Identity backup exceeds the size limit.');
      const parsed = JSON.parse(await file.text()) as NativeIdentityBackup;
      if (parsed.version !== 1 || parsed.role !== role || !/^[a-f0-9]{64}$/.test(parsed.fingerprint) || typeof parsed.encryptedBase64 !== 'string') throw new Error('Choose a valid encrypted backup for the selected role.');
      setBackup(parsed);
    } catch (reason) { fail(reason); }
  };
  const restoreBackup = async () => {
    if (!backup || !validPassphrase || !/^[a-f0-9]{64}$/.test(fingerprint)) return;
    setBusy('import'); setError(''); setMessage('');
    try {
      const result = await nativeVaultApi.importIdentity(baseUrl, token, role, { passphrase, expectedFingerprint: fingerprint, backup });
      if (!result.restored) throw new Error('The agent did not confirm restoration.');
      setMessage(`${role === 'source' ? 'Source' : 'Recipient'} identity ${result.alreadyPresent ? 'already matches this device' : 'restored'}. Wallet funds, vault packages, journals, and keeper state are not part of this backup.`);
    } catch (reason) { fail(reason); }
    finally { setPassphrase(''); setConfirmation(''); setBusy(null); }
  };
  return <section className="native-recovery-tools">
    <div className="native-tool-section"><span className="section-label">SHIELDED SUPPORT / TESTNET</span><h2>Fund the signal.</h2><p>The agent’s separate shielded receive address funds testnet check-in fees. The payment request carries no vault identifier, filename, or memo.</p><button className="canary-button outline" disabled={!enabled || !!busy} onClick={loadSupport}>{busy === 'support' ? <LoaderCircle size={15} className="animate-spin"/> : <KeyRound size={15}/>}Load testnet payment request</button>
      {support && <div className="native-payment"><span className="section-label">0.001 TAZ / 100,000 ZAT / TESTNET ONLY</span><code>{support.address}</code><div><button className="canary-button quiet" onClick={async () => { try { await navigator.clipboard.writeText(support.uri); setMessage('Testnet payment request copied.'); } catch { setError('Clipboard unavailable. Select and copy the request below.'); } }}><Copy size={14}/>Copy payment request</button></div><code>{support.uri}</code></div>}
    </div>
    <details className="identity-backup"><summary><span>Identity backup & recovery</span><span>+</span></summary><p>Encrypted identity keys only. This does not back up wallet funds, vault packages, manifests, command journals, or keeper databases. A different existing identity is never replaced.</p>
      <div className="backup-fields"><label>Identity role<select value={role} disabled={!!busy} onChange={event => { setRole(event.target.value as 'source' | 'recipient'); setBackup(null); setFingerprint(''); setMessage(''); }}><option value="recipient">Recipient identity</option><option value="source">Source signing identity</option></select></label><label>Passphrase · at least 12 bytes<input type="password" autoComplete="off" value={passphrase} onChange={event => setPassphrase(event.target.value)}/></label></div>
      <div className="backup-actions"><div><h3>Export encrypted identity</h3><p>Initialize the recipient or create a vault first. Keep the downloaded backup and its passphrase separately.</p><label>Confirm export passphrase<input type="password" autoComplete="off" value={confirmation} onChange={event => setConfirmation(event.target.value)}/></label><button className="canary-button outline" disabled={!enabled || !!busy || !validPassphrase || passphrase !== confirmation} onClick={exportBackup}><Download size={15}/>{busy === 'export' ? 'Encrypting…' : 'Export identity'}</button></div>
      <div><h3>Restore encrypted identity</h3><label>Encrypted identity backup<input key={role} type="file" accept=".json,application/json" onChange={event => void readBackup(event.target.files?.[0])}/></label><label>Fingerprint recorded separately<input value={fingerprint} autoComplete="off" spellCheck={false} placeholder="64 hexadecimal characters" onChange={event => setFingerprint(event.target.value.trim().toLowerCase())}/></label><button className="canary-button outline" disabled={!enabled || !!busy || !validPassphrase || !backup || !/^[a-f0-9]{64}$/.test(fingerprint)} onClick={restoreBackup}><Upload size={15}/>{busy === 'import' ? 'Verifying…' : 'Verify and restore identity'}</button></div></div>
    </details>
    {error && <p className="recovery-error" role="alert">{error}</p>}{message && <p className="native-backup-notice" role="status">{message}</p>}
  </section>;
}
