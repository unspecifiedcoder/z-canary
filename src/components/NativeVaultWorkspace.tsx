import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Check, CircleAlert, Copy, Download, ExternalLink, FileLock2, LoaderCircle, LogOut, RefreshCw, ShieldCheck, WalletCards, Wifi, WifiOff } from 'lucide-react';
import NativeRecoveryTools from './NativeRecoveryTools';
import NativeCommandCost from './NativeCommandCost';
import {
  base64ToBytes,
  downloadBytes,
  fileToBase64,
  isLoopbackHostname,
  MAX_NATIVE_FILE_BYTES,
  NativeApiError,
  NativeOperation,
  NativeRecipientIdentity,
  NativeRuntime,
  NativeVaultDetail,
  nativeVaultApi,
  sha256HexBytes,
} from '../services/nativeVault';

const KEEPERS_REQUIRED = 5;
const OPERATION_POLL_MS = 1800;
const OPERATION_MAX_POLLS = 90;

function errorText(error: unknown): string {
  if (error instanceof NativeApiError) return `${error.message}${error.code ? ` (${error.code})` : ''}`;
  return error instanceof Error ? error.message : 'The local-agent request failed.';
}

function getAckCount(vault: NativeVaultDetail): number {
  const verified = new Set(vault.acknowledgements.filter(ack => ack.verified).map(ack => ack.keeperId));
  return verified.size;
}

function eventText(event: Record<string, unknown>): string {
  const title = typeof event.title === 'string' ? event.title : typeof event.name === 'string' ? event.name : typeof event.type === 'string' ? event.type : 'Vault event';
  const detail = typeof event.detail === 'string' ? event.detail : typeof event.message === 'string' ? event.message : '';
  const height = typeof event.blockHeight === 'number' ? ` · block #${event.blockHeight.toLocaleString()}` : '';
  return `${title}${detail ? ` — ${detail}` : ''}${height}`;
}

function shortAddress(address?: string): string {
  if (!address) return 'Unavailable';
  return address.length > 30 ? `${address.slice(0, 16)}…${address.slice(-12)}` : address;
}

function zatoshiToTaz(value?: number): string {
  if (typeof value !== 'number') return 'Unavailable';
  return `${(value / 100_000_000).toLocaleString(undefined, { maximumFractionDigits: 8 })} TAZ`;
}

const NativeVaultWorkspace: React.FC = () => {
  const [baseUrl, setBaseUrl] = useState('http://127.0.0.1:8787');
  const [token, setToken] = useState('');
  const [runtime, setRuntime] = useState<NativeRuntime | null>(null);
  const [vaults, setVaults] = useState<NativeVaultDetail[]>([]);
  const [inbox, setInbox] = useState<NativeVaultDetail[]>([]);
  const [identity, setIdentity] = useState<NativeRecipientIdentity | null>(null);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [file, setFile] = useState<File | null>(null);
  const [fingerprintAcknowledged, setFingerprintAcknowledged] = useState(false);
  const [intervalBlocks, setIntervalBlocks] = useState(144);
  const [graceBlocks, setGraceBlocks] = useState(24);
  const [confirmationTarget, setConfirmationTarget] = useState(2);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [operation, setOperation] = useState<NativeOperation | null>(null);
  const [operationVaultId, setOperationVaultId] = useState<string | null>(null);
  const [createOutcomeUnknown, setCreateOutcomeUnknown] = useState(false);
  const [cancelConfirm, setCancelConfirm] = useState(false);
  const canConnectFromPage = typeof window !== 'undefined' && isLoopbackHostname(window.location.hostname);
  const epoch = useRef(0);
  const active = useRef(true);
  const selected = useMemo(() => vaults.find(vault => vault.id === selectedId) ?? null, [vaults, selectedId]);
  const canMutate = runtime?.available === true && runtime.mode === 'testnet' && runtime.wallet.available === true;

  useEffect(() => {
    active.current = true;
    return () => { active.current = false; epoch.current += 1; };
  }, []);

  const clearConnection = () => {
    epoch.current += 1;
    setRuntime(null); setVaults([]); setInbox([]); setIdentity(null); setSelectedId(null);
    setFingerprintAcknowledged(false); setOperation(null); setOperationVaultId(null); setBusy(null); setError(null); setNotice(null); setCancelConfirm(false);
  };

  const disconnect = () => {
    clearConnection();
    setToken('');
  };

  const copyWalletAddress = async () => {
    const address = runtime?.wallet.receiveAddress;
    if (!address) return;
    try {
      await navigator.clipboard.writeText(address);
      setNotice('Testnet Unified Address copied.');
    } catch {
      setError('Could not copy the wallet address. Select it manually instead.');
    }
  };

  const refreshData = useCallback(async (version = epoch.current) => {
    const [vaultResult, inboxResult] = await Promise.allSettled([
      nativeVaultApi.listVaults(baseUrl, token),
      nativeVaultApi.recipientInbox(baseUrl, token),
    ]);
    if (!active.current || version !== epoch.current) return;
    if (vaultResult.status === 'fulfilled') {
      setVaults(vaultResult.value.vaults);
      setSelectedId(current => current && vaultResult.value.vaults.some(vault => vault.id === current) ? current : vaultResult.value.vaults[0]?.id ?? null);
      setOperation(current => { const updated = vaultResult.value.vaults.find(v => v.lastOperation?.operationId === current?.operationId); return updated?.lastOperation ?? current; });
    } else setError(`Could not load vaults: ${errorText(vaultResult.reason)}`);
    if (inboxResult.status === 'fulfilled') setInbox(inboxResult.value.vaults);
    else setError(current => current ? `${current}\nCould not load recipient inbox: ${errorText(inboxResult.reason)}` : `Could not load recipient inbox: ${errorText(inboxResult.reason)}`);
    return vaultResult.status === 'fulfilled';
  }, [baseUrl, token]);

  const connect = async () => {
    const version = ++epoch.current;
    setBusy('connect'); setError(null); setNotice(null); setRuntime(null); setVaults([]); setInbox([]); setIdentity(null); setOperation(null); setOperationVaultId(null);
    try {
      const result = await nativeVaultApi.runtime(baseUrl, token);
      if (!active.current || version !== epoch.current) return;
      setRuntime(result);
      const refreshed = await refreshData(version);
      if (refreshed) setCreateOutcomeUnknown(false);
      if (!result.available || result.mode !== 'testnet' || !result.wallet.available) {
        setNotice(result.error || `Native testnet actions are disabled: wallet state is “${result.wallet.state}”.`);
      }
    } catch (reason) {
      if (active.current && version === epoch.current) setError(errorText(reason));
    } finally {
      if (active.current && version === epoch.current) setBusy(null);
    }
  };

  const refresh = async () => {
    const version = epoch.current;
    setBusy('refresh'); setError(null);
    try {
      const result = await nativeVaultApi.runtime(baseUrl, token);
      if (!active.current || version !== epoch.current) return;
      setRuntime(result);
      const refreshed = await refreshData(version);
      if (refreshed) setCreateOutcomeUnknown(false);
      if (!result.available || result.mode !== 'testnet' || !result.wallet.available) setNotice(result.error || `Native testnet actions are disabled: wallet state is “${result.wallet.state}”.`);
      else setNotice(null);
    } catch (reason) {
      if (active.current && version === epoch.current) { setRuntime(null); setError(errorText(reason)); }
    } finally { if (active.current && version === epoch.current) setBusy(null); }
  };

  const initializeIdentity = async () => {
    const version = epoch.current;
    setBusy('identity'); setError(null); setNotice(null);
    try {
      const result = await nativeVaultApi.createRecipientIdentity(baseUrl, token);
      if (!active.current || version !== epoch.current) return;
      setIdentity(result); setFingerprintAcknowledged(false);
      setNotice('Recipient public identity is ready. Verify its fingerprint with the recipient through a separate trusted channel before creating a vault.');
    } catch (reason) { if (active.current && version === epoch.current) setError(errorText(reason)); }
    finally { if (active.current && version === epoch.current) setBusy(null); }
  };

  const createVault = async (event: React.FormEvent) => {
    event.preventDefault();
    if (!canMutate || !identity || !fingerprintAcknowledged || !file || createOutcomeUnknown) return;
    if (file.size > MAX_NATIVE_FILE_BYTES) { setError('Choose a file no larger than 10 MiB.'); return; }
    const version = epoch.current;
    setBusy('create'); setError(null); setNotice(null);
    try {
      const contentsBase64 = await fileToBase64(file);
      if (!active.current || version !== epoch.current) return;
      const result = await nativeVaultApi.createVault(baseUrl, token, {
        fileName: file.name,
        contentsBase64,
        recipient: identity.recipient,
        recipientFingerprint: identity.fingerprint,
        intervalBlocks,
        graceBlocks,
        confirmationTarget,
      });
      if (!active.current || version !== epoch.current) return;
      setVaults(current => [result, ...current.filter(vault => vault.id !== result.id)]);
      setSelectedId(result.id); setFile(null); setNotice('Vault created and the agent returned its keeper provisioning state. Registration has not been submitted.');
      const input = document.getElementById('native-vault-file') as HTMLInputElement | null;
      if (input) input.value = '';
      await refreshData(version);
    } catch (reason) { if (active.current && version === epoch.current) { setError(errorText(reason)); setCreateOutcomeUnknown(true); await refreshData(version); } }
    finally { if (active.current && version === epoch.current) setBusy(null); }
  };

  const resumeProvisioning = async (id: string) => {
    const version = epoch.current;
    setBusy('provision'); setError(null);
    try { await nativeVaultApi.provision(baseUrl, token, id); if (active.current && version === epoch.current) await refreshData(version); }
    catch (reason) { if (active.current && version === epoch.current) setError(errorText(reason)); }
    finally { if (active.current && version === epoch.current) setBusy(null); }
  };

  const retryOperation = async (id: string) => {
    const version = epoch.current;
    setBusy('retry'); setError(null);
    try { const result = await nativeVaultApi.retry(baseUrl, token, id); const resumed = await nativeVaultApi.operation(baseUrl, token, result.operationId); if (!active.current || version !== epoch.current) return; setOperation(resumed); setNotice('The existing immutable operation was resumed. Refresh to check its state; no new command was created.'); await refreshData(version); }
    catch (reason) { if (active.current && version === epoch.current) setError(errorText(reason)); }
    finally { if (active.current && version === epoch.current) setBusy(null); }
  };

  const refreshVault = async (id: string, version = epoch.current) => {
    const detail = await nativeVaultApi.getVault(baseUrl, token, id);
    if (active.current && version === epoch.current) setVaults(current => current.map(vault => vault.id === id ? detail : vault));
    return detail;
  };

  const runOperation = async (kind: 'register' | 'postpone' | 'cancel', id: string) => {
    if (!canMutate) return;
    const version = epoch.current;
    setBusy(kind); setError(null); setNotice(null); setOperation(null); setOperationVaultId(id); setCancelConfirm(false);
    try {
      const { operationId } = await nativeVaultApi[kind](baseUrl, token, id);
      if (!active.current || version !== epoch.current) return;
      setNotice(`${kind === 'postpone' ? 'Check-in' : kind === 'register' ? 'Registration' : 'Cancellation'} submitted to the local agent. Waiting for its reported state; vault lifecycle is read separately.`);
      for (let attempt = 0; attempt < OPERATION_MAX_POLLS; attempt += 1) {
        await new Promise(resolve => setTimeout(resolve, OPERATION_POLL_MS));
        if (!active.current || version !== epoch.current) return;
        const currentOperation = await nativeVaultApi.operation(baseUrl, token, operationId);
        setOperation(currentOperation); setOperationVaultId(id);
        await refreshVault(id, version);
        if (currentOperation.state === 'confirmed' || currentOperation.state === 'failed') {
          setNotice(currentOperation.state === 'confirmed'
            ? 'The agent reports this operation confirmed. The vault lifecycle above comes from a fresh vault detail response.'
            : `The agent reports this operation failed${currentOperation.error ? `: ${currentOperation.error}` : '.'}`);
          return;
        }
      }
      setNotice('Operation is still pending after the polling window. Refresh to read its current operation and vault lifecycle.');
    } catch (reason) { if (active.current && version === epoch.current) setError(errorText(reason)); }
    finally { if (active.current && version === epoch.current) setBusy(null); }
  };

  const decrypt = async (vault: NativeVaultDetail) => {
    if (!canMutate || vault.shareCount < 3) return;
    const version = epoch.current;
    setBusy(`decrypt:${vault.id}`); setError(null); setNotice(null);
    try {
      const recovered = await nativeVaultApi.decrypt(baseUrl, token, vault.id);
      const bytes = base64ToBytes(recovered.contentsBase64);
      const actualDigest = await sha256HexBytes(bytes);
      if (!active.current || version !== epoch.current) { bytes.fill(0); return; }
      if (!/^[a-fA-F0-9]{64}$/.test(recovered.digestHex) || actualDigest.toLowerCase() !== recovered.digestHex.toLowerCase()) {
        throw new NativeApiError('Recovered bytes did not match the agent-provided SHA-256 digest. No file was downloaded.', 'ERR_DIGEST_MISMATCH');
      }
      downloadBytes(recovered.fileName, bytes);
      setNotice(`Recovered file downloaded after SHA-256 verification (${actualDigest}).`);
    } catch (reason) { if (active.current && version === epoch.current) setError(errorText(reason)); }
    finally { if (active.current && version === epoch.current) setBusy(null); }
  };

  const exportPackage = async (id: string) => {
    const version = epoch.current;
    setBusy('package'); setError(null);
    try {
      const result = await nativeVaultApi.exportPackage(baseUrl, token, id);
      if (!active.current || version !== epoch.current) return;
      if (result.format !== 'ZCANARY-ENCRYPTED-PACKAGE-V1' || typeof result.packageBase64 !== 'string' || !/^[a-f0-9]{64}$/.test(result.packageDigestHex)) throw new NativeApiError('The agent returned an invalid encrypted package export.');
      downloadBytes(`canary-${id.slice(0, 12)}.zcanary-package.json`, new TextEncoder().encode(JSON.stringify(result)));
      setNotice('Encrypted package and signed manifest downloaded. The agent verifies its protocol-bound digest before export. This file contains no decryption keys.');
    } catch (reason) { if (active.current && version === epoch.current) setError(errorText(reason)); }
    finally { if (active.current && version === epoch.current) setBusy(null); }
  };

  const ackCount = selected ? getAckCount(selected) : 0;
  const canRegister = canMutate && selected?.lifecycle.toLowerCase() === 'draft' && ackCount === KEEPERS_REQUIRED;

  return <section className="space-y-6 pb-10" aria-labelledby="native-vault-heading">
    <header className="border border-[var(--info)]/30 bg-[var(--sunken)] p-5 sm:p-7 space-y-4">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="space-y-1"><div className="font-mono text-[11px] tracking-wider text-[var(--info)]">REAL ZCASH TESTNET · SHIELDED MEMOS</div><h1 id="native-vault-heading" className="text-2xl sm:text-3xl font-bold text-[var(--ink)]">Connect Canary’s Zcash wallet.</h1></div>
        <span className="inline-flex items-center gap-2 px-3 py-1.5 border border-[var(--info)]/30 text-xs font-mono text-[var(--info)]"><FileLock2 size={15}/>KEYS STAY IN NATIVE RUNTIME</span>
      </div>
      <p className="max-w-3xl text-sm leading-6 text-[var(--muted)]">This is the real network path, separate from the browser simulation. It connects this tab to Canary’s authenticated local Zingolib wallet, then enables real REGISTER, CHECK-IN and CANCEL memo transactions on Zcash testnet. Canary never asks for a seed phrase.</p>
      {!canConnectFromPage&&<div className="border border-[var(--yellow-2)]/30 bg-[var(--yellow-2)]/5 p-3 text-sm text-[var(--accent-ink)]"><strong className="block">Hosted judge copy · connection is intentionally locked.</strong><span className="mt-1 block text-xs leading-5 text-[var(--accent-ink)]/75">Run Canary on loopback before entering the private bearer token. The local agent rejects remote webpage origins, so a hosted-page compromise cannot command your wallet.</span></div>}
      <div className="grid gap-2 sm:grid-cols-3 text-xs">
        <div className="border-l-2 border-[var(--info)]/60 pl-3"><strong className="block text-[var(--ink)]">1 · Start native runtime</strong><span className="text-[var(--faint)]">Run the repository launcher with the existing wallet state.</span></div>
        <div className="border-l-2 border-[var(--info)]/35 pl-3"><strong className="block text-[var(--ink)]">2 · Connect locally</strong><span className="text-[var(--faint)]">Paste the one-time bearer from its private token file.</span></div>
        <div className="border-l-2 border-[var(--info)]/20 pl-3"><strong className="block text-[var(--ink)]">3 · Verify on explorer</strong><span className="text-[var(--faint)]">Confirmed commands expose a real txid and block height.</span></div>
      </div>
      <div className="grid gap-3 md:grid-cols-[minmax(0,1fr)_minmax(0,1fr)_auto]">
        <label className="space-y-1 text-xs text-[var(--muted)]">Loopback agent URL<input value={baseUrl} disabled={!canConnectFromPage} onChange={event => { clearConnection(); setBaseUrl(event.target.value); }} spellCheck={false} autoComplete="off" className="w-full rounded border border-[var(--line)] bg-[var(--sunken)] px-3 py-2 text-sm font-mono text-[var(--ink)] disabled:cursor-not-allowed disabled:opacity-50"/></label>
        <label className="space-y-1 text-xs text-[var(--muted)]">Bearer token<input value={token} disabled={!canConnectFromPage} onChange={event => { clearConnection(); setToken(event.target.value); }} type="password" autoComplete="off" className="w-full rounded border border-[var(--line)] bg-[var(--sunken)] px-3 py-2 text-sm font-mono text-[var(--ink)] disabled:cursor-not-allowed disabled:opacity-50"/></label>
        {canConnectFromPage?<button type="button" disabled={!!busy} onClick={runtime ? refresh : connect} className="self-end inline-flex items-center justify-center gap-2 rounded bg-[var(--yellow)] px-4 py-2 text-sm font-semibold text-[var(--ink)] disabled:opacity-50">{busy==='connect'?<LoaderCircle size={16} className="animate-spin"/>:runtime?<RefreshCw size={16}/>:<WalletCards size={16}/>} {runtime?'Refresh wallet':'Connect Zcash wallet'}</button>:<a href="https://github.com/unspecifiedcoder/z-canary#run-native-zcash-testnet" target="_blank" rel="noreferrer" className="self-end inline-flex items-center justify-center gap-2 rounded bg-[var(--yellow)] px-4 py-2 text-sm font-semibold text-[var(--ink)]"><WalletCards size={16}/>Run locally to connect<ExternalLink size={13}/></a>}
      </div>
      {error&&<div role="alert" className="whitespace-pre-line border border-[var(--bad)]/40 bg-[var(--bad)]/5 p-3 text-sm text-[var(--bad)]"><CircleAlert className="mr-2 inline" size={16}/>{error}</div>}
      {notice&&<div role="status" className="border border-[var(--yellow-2)]/30 bg-[var(--yellow-2)]/5 p-3 text-sm text-[var(--accent-ink)]">{notice}</div>}
      {runtime&&<div className="space-y-3 border border-[var(--ok)]/25 bg-emerald-500/[0.035] p-4">
        <div className="flex flex-wrap items-center justify-between gap-3"><div className="flex items-center gap-2 text-sm font-semibold text-[var(--ok)]">{runtime.wallet.available?<Wifi size={16}/>:<WifiOff size={16}/>} {runtime.wallet.available?'Connected to Zcash testnet':'Wallet unavailable'}</div><button type="button" onClick={disconnect} className="inline-flex items-center gap-1.5 border border-[var(--line)] px-2.5 py-1.5 text-xs text-[var(--muted)]"><LogOut size={13}/>Disconnect</button></div>
        <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
          <div className="border border-[var(--line)] bg-[var(--sunken)] p-3 text-sm"><div className="text-xs text-[var(--faint)]">Network</div><strong className="mt-1 block text-[var(--ok)]">Zcash testnet</strong><span className="text-[10px] font-mono text-[var(--faint)]">NOT SIMULATED</span></div>
          <div className="border border-[var(--line)] bg-[var(--sunken)] p-3 text-sm"><div className="text-xs text-[var(--faint)]">Spendable balance</div><strong className="mt-1 block text-[var(--ink)]">{zatoshiToTaz(runtime.wallet.spendableZatoshi)}</strong><span className="text-[10px] text-[var(--faint)]">Synced when runtime started</span></div>
          <div className="border border-[var(--line)] bg-[var(--sunken)] p-3 text-sm"><div className="text-xs text-[var(--faint)]">Wallet chain height</div><strong className="mt-1 block text-[var(--ink)]">{typeof runtime.wallet.tipHeight==='number'?`#${runtime.wallet.tipHeight.toLocaleString()}`:'Unavailable'}</strong><span className="text-[10px] text-[var(--faint)]">Startup sync snapshot</span></div>
          <div className="border border-[var(--line)] bg-[var(--sunken)] p-3 text-sm"><div className="text-xs text-[var(--faint)]">Keeper processes</div><strong className="mt-1 block text-[var(--ink)]">{runtime.keepers.filter(keeper=>keeper.healthy).length} / {runtime.keepers.length} healthy</strong><span className="text-[10px] text-[var(--faint)]">Threshold requires 3 shares</span></div>
        </div>
        {runtime.wallet.receiveAddress&&<div className="flex flex-col gap-2 border border-[var(--line)] bg-[var(--sunken)] p-3 sm:flex-row sm:items-center sm:justify-between"><div className="min-w-0"><div className="text-[10px] font-mono uppercase tracking-wider text-[var(--faint)]">Shielded Unified Address</div><code title={runtime.wallet.receiveAddress} className="block break-all text-xs text-[var(--info)]">{shortAddress(runtime.wallet.receiveAddress)}</code></div><button type="button" onClick={()=>void copyWalletAddress()} className="inline-flex shrink-0 items-center justify-center gap-1.5 border border-[var(--line)] px-2.5 py-1.5 text-xs text-[var(--muted)]"><Copy size={13}/>Copy full address</button></div>}
      </div>}
      {runtime?.keepers.length ? <ul className="flex flex-wrap gap-2" aria-label="Keeper health">{runtime.keepers.map(keeper=><li key={keeper.id} className={`inline-flex items-center gap-1.5 border px-2 py-1 text-xs ${keeper.healthy?'border-[var(--ok)]/25 text-[var(--ok)]':'border-[var(--yellow-2)]/25 text-[var(--accent-ink)]'}`}><span aria-hidden="true">{keeper.healthy?'●':'○'}</span>{keeper.id}</li>)}</ul>:null}
    </header>

    <div className="grid gap-6 xl:grid-cols-[minmax(0,1.05fr)_minmax(0,0.95fr)]">
      <section className="space-y-5 border border-[var(--line)] bg-[var(--card)] rounded-[22px] shadow-[var(--shadow)] p-5 sm:p-6" aria-labelledby="native-create-heading">
        <div><h2 id="native-create-heading" className="text-lg font-semibold">Create a native testnet vault</h2><p className="mt-1 text-sm text-[var(--muted)]">The local agent performs encryption and keeper provisioning. This page never registers automatically.</p></div>
        <div className="space-y-3 border border-[var(--line)] bg-[var(--sunken)] p-4">
          <div className="flex flex-wrap items-center justify-between gap-3"><div><h3 className="text-sm font-semibold">Recipient identity</h3><p className="text-xs text-[var(--faint)]">Generate or load the public identity from the native agent.</p></div><button type="button" disabled={!canMutate||!!busy} onClick={initializeIdentity} className="rounded border border-[var(--line)] px-3 py-2 text-xs font-semibold text-[var(--ink)] disabled:opacity-40">{busy==='identity'?'Loading…':'Initialize identity'}</button></div>
          {identity&&<div className="space-y-2 text-xs"><div><div className="text-[var(--faint)]">Public recipient identity</div><code className="block break-all text-[var(--muted)]">{identity.recipient}</code></div><div><div className="text-[var(--faint)]">Fingerprint · verify out of band</div><code className="block break-all text-[var(--info)]">{identity.fingerprint}</code></div><label className="flex items-start gap-2 pt-1 text-[var(--muted)]"><input type="checkbox" checked={fingerprintAcknowledged} onChange={event=>setFingerprintAcknowledged(event.target.checked)} className="mt-0.5 accent-[var(--ink)]"/><span>I independently verified this fingerprint with the intended recipient through a trusted channel.</span></label></div>}
          {!canMutate&&<p className="text-xs text-[var(--accent-ink)]">Connect to an available native testnet wallet before initializing recipient identity.</p>}
        </div>
        <form onSubmit={createVault} className="space-y-4">
          <label className="block space-y-1 text-xs text-[var(--muted)]">File to encrypt · maximum 10 MiB<input id="native-vault-file" type="file" onChange={event=>{setFile(event.target.files?.[0]??null);setError(null);}} className="block w-full rounded border border-[var(--line)] bg-[var(--sunken)] px-3 py-2 text-sm text-[var(--muted)] file:mr-3 file:rounded file:border-0 file:bg-[var(--sunken)] file:px-3 file:py-1.5 file:text-xs file:text-[var(--ink)]"/></label>
          {file&&<p className="text-xs text-[var(--muted)]">Selected: <span className="text-[var(--ink)]">{file.name}</span> · {file.size.toLocaleString()} bytes</p>}
          <div className="grid gap-3 sm:grid-cols-3"><label className="space-y-1 text-xs text-[var(--muted)]">Interval blocks<input type="number" min={8} max={1000000} value={intervalBlocks} onChange={event=>setIntervalBlocks(Number(event.target.value))} className="w-full border border-[var(--line)] bg-[var(--sunken)] px-3 py-2 text-sm text-[var(--ink)]"/></label><label className="space-y-1 text-xs text-[var(--muted)]">Grace blocks<input type="number" min={1} value={graceBlocks} onChange={event=>setGraceBlocks(Number(event.target.value))} className="w-full border border-[var(--line)] bg-[var(--sunken)] px-3 py-2 text-sm text-[var(--ink)]"/></label><label className="space-y-1 text-xs text-[var(--muted)]">Confirmations<input type="number" min={2} max={20} value={confirmationTarget} onChange={event=>setConfirmationTarget(Number(event.target.value))} className="w-full border border-[var(--line)] bg-[var(--sunken)] px-3 py-2 text-sm text-[var(--ink)]"/></label></div>
          {createOutcomeUnknown&&<p role="status" className="text-xs text-[var(--accent-ink)]">A prior create request has an uncertain outcome. Use Refresh and inspect the returned vaults before enabling another create.</p>}
          <button type="submit" disabled={!canMutate||!identity||!fingerprintAcknowledged||!file||file.size>MAX_NATIVE_FILE_BYTES||createOutcomeUnknown||!!busy||![intervalBlocks,graceBlocks,confirmationTarget].every(value=>Number.isInteger(value)&&value>0)} className="inline-flex items-center gap-2 rounded bg-[var(--yellow)] px-4 py-2.5 text-sm font-semibold text-[var(--ink)] disabled:opacity-40">{busy==='create'?<LoaderCircle size={16} className="animate-spin"/>:<ShieldCheck size={16}/>}Create vault and provision keepers</button>
        </form>
      </section>

      <section className="space-y-5 border border-[var(--line)] bg-[var(--card)] rounded-[22px] shadow-[var(--shadow)] p-5 sm:p-6" aria-labelledby="native-vault-list-heading">
        <div className="flex items-start justify-between gap-3"><div><h2 id="native-vault-list-heading" className="text-lg font-semibold">Native vaults</h2><p className="text-sm text-[var(--muted)]">Lifecycle comes from fresh agent detail, not an operation status.</p></div><button type="button" disabled={!runtime||!!busy} onClick={refresh} className="rounded border border-[var(--line)] p-2 text-[var(--muted)] disabled:opacity-40" aria-label="Refresh native vaults"><RefreshCw size={16}/></button></div>
        {!runtime&&<p className="border border-[var(--line)] bg-[var(--sunken)] p-4 text-sm text-[var(--muted)]">Connect to the local agent to read native vaults.</p>}
        {runtime&&vaults.length===0&&<p className="border border-[var(--line)] bg-[var(--sunken)] p-4 text-sm text-[var(--muted)]">{busy==='connect'||busy==='refresh'?'Loading native vaults…':'The agent returned no native vaults.'}</p>}
        {vaults.length>0&&<div className="space-y-2">{vaults.map(vault=><button type="button" key={vault.id} onClick={()=>{setSelectedId(vault.id);setCancelConfirm(false);setOperation(vault.lastOperation??null);setOperationVaultId(vault.id);setError(null);}} className={`w-full border p-3 text-left ${vault.id===selectedId?'border-[var(--info)]/50 bg-[var(--info)]/5':'border-[var(--line)] bg-[var(--sunken)] hover:border-[var(--line)]'}`}><div className="flex flex-wrap justify-between gap-2"><strong className="break-all text-sm text-[var(--ink)]">{vault.fileName}</strong><span className="font-mono text-[10px] uppercase text-[var(--info)]">{vault.lifecycle}</span></div><div className="mt-1 font-mono text-[10px] text-[var(--faint)]">{vault.id} · {getAckCount(vault)}/5 acknowledgements · {vault.shareCount} shares</div></button>)}</div>}
        {selected&&<article className="space-y-4 border border-[var(--line)] bg-[var(--sunken)] p-4" aria-label="Selected native vault details">
          <div className="flex flex-wrap items-start justify-between gap-2"><div className="min-w-0"><div className="text-xs font-mono text-[var(--faint)]">VAULT DETAIL</div><h3 className="break-all text-base font-semibold text-[var(--ink)]">{selected.fileName}</h3><code className="break-all text-[10px] text-[var(--faint)]">{selected.id}</code></div><span className="border border-[var(--info)]/30 px-2 py-1 text-xs font-mono text-[var(--info)]">{selected.lifecycle}</span></div>
          <div className="grid grid-cols-2 gap-2 text-xs"><div className="border border-[var(--line)] p-2 text-[var(--muted)]">Verified keeper acknowledgements<strong className="block text-[var(--ink)]">{ackCount} / 5</strong></div><div className="border border-[var(--line)] p-2 text-[var(--muted)]">Available shares<strong className="block text-[var(--ink)]">{selected.shareCount}</strong></div></div>
          {selected.acknowledgements.length>0&&<ul className="space-y-1">{selected.acknowledgements.map(ack=><li key={ack.keeperId} className="flex items-center gap-2 text-xs"><span className={ack.verified?'text-[var(--ok)]':'text-[var(--accent-ink)]'}>{ack.verified?'✓':'○'}</span><span className="text-[var(--muted)]">{ack.keeperId}</span><span className={ack.verified?'text-[var(--ok)]':'text-[var(--accent-ink)]'}>{ack.verified?'Provisioning acknowledged':'Awaiting acknowledgement'}</span></li>)}</ul>}
          <div className="flex flex-wrap gap-2">
            <button className="canary-button outline" disabled={!canMutate||!!busy} onClick={()=>void exportPackage(selected.id)}>Download encrypted package</button>
            {ackCount<5&&<button className="canary-button outline" disabled={!canMutate||!!busy} onClick={()=>void resumeProvisioning(selected.id)}>Resume keeper provisioning</button>}
            {selected.lifecycle.toLowerCase()==='draft'&&<button type="button" disabled={!canRegister||!!busy} onClick={()=>void runOperation('register',selected.id)} className="rounded bg-[var(--ok)] px-3 py-2 text-xs font-bold text-[var(--ink)] disabled:opacity-40">{busy==='register'?'Registering…':'Register on testnet'}</button>}
            {['active','grace'].includes(selected.lifecycle.toLowerCase())&&<button type="button" disabled={!canMutate||!!busy} onClick={()=>void runOperation('postpone',selected.id)} className="rounded border border-[var(--info)]/50 px-3 py-2 text-xs font-semibold text-[var(--info)] disabled:opacity-40">{busy==='postpone'?'Submitting check-in…':'Check in / postpone'}</button>}
            {['active','grace'].includes(selected.lifecycle.toLowerCase())&&!cancelConfirm&&<button type="button" disabled={!canMutate||!!busy} onClick={()=>setCancelConfirm(true)} className="rounded border border-[var(--bad)]/40 px-3 py-2 text-xs font-semibold text-[var(--bad)] disabled:opacity-40">Cancel vault…</button>}
            <button type="button" disabled={!canMutate||!!busy} onClick={()=>{setBusy('detail');void refreshVault(selected.id).catch(reason=>setError(errorText(reason))).finally(()=>setBusy(null));}} className="rounded border border-[var(--line)] px-3 py-2 text-xs text-[var(--muted)] disabled:opacity-40">Refresh detail</button>
          </div>
          <NativeCommandCost key={`${epoch.current}:${selected.id}`} baseUrl={baseUrl} token={token} enabled={canMutate&&!busy} />
          {selected.lifecycle.toLowerCase()==='draft'&&<p className="text-xs text-[var(--muted)]">Registration requires five distinct verified keeper acknowledgements. Nothing is broadcast until you press Register.</p>}
          {cancelConfirm&&<div className="space-y-3 border border-[var(--bad)]/40 bg-[var(--bad)]/5 p-3" role="group" aria-label="Confirm vault cancellation"><p className="text-sm text-[var(--bad)]">Cancel this native vault? This submits a cancellation operation to the local agent.</p><div className="flex gap-2"><button type="button" disabled={!canMutate||!!busy} onClick={()=>void runOperation('cancel',selected.id)} className="rounded bg-[var(--bad)] px-3 py-2 text-xs font-bold text-[var(--ink)] disabled:opacity-40">Confirm cancellation</button><button type="button" onClick={()=>setCancelConfirm(false)} className="rounded border border-[var(--line)] px-3 py-2 text-xs text-[var(--muted)]">Keep vault</button></div></div>}
          {operation&&operationVaultId===selected.id&&<div role="status" className="space-y-1 border border-[var(--line)] p-3 text-xs"><div className="flex items-center gap-2 text-[var(--muted)]">{operation.state==='confirmed'?<Check size={15} className="text-[var(--ok)]"/>:<LoaderCircle size={15} className="text-[var(--info)]"/>}Operation: <strong className="uppercase">{operation.state}</strong></div><code className="block break-all text-[var(--faint)]">{operation.operationId}</code>{operation.txid&&<a href={`https://testnet.cipherscan.app/tx/${operation.txid}`} target="_blank" rel="noreferrer" className="inline-flex max-w-full items-center gap-1 break-all font-mono text-[var(--info)] hover:underline">txid {operation.txid}<ExternalLink size={11} className="shrink-0"/></a>}{operation.blockHeight!==undefined&&<div className="text-[var(--muted)]">Block #{operation.blockHeight.toLocaleString()}</div>}{operation.error&&<p className="text-[var(--bad)]">{operation.error}</p>}<p className="text-[var(--faint)]">Operation state does not itself establish vault lifecycle; the lifecycle above is read from vault detail.</p></div>}
          {operation?.state==='failed'&&operationVaultId===selected.id&&<button className="canary-button outline" disabled={!canMutate||!!busy} onClick={()=>void retryOperation(operation.operationId)}>Resume same operation</button>}
          {selected.events.length>0&&<div className="space-y-2"><h4 className="text-xs font-mono text-[var(--muted)]">RECENT AGENT EVENTS</h4><ul className="space-y-1 text-xs text-[var(--muted)]">{selected.events.slice(-8).reverse().map((event,index)=><li key={index} className="border-t border-[var(--line)] pt-2">{eventText(event)}</li>)}</ul></div>}
        </article>}
      </section>
    </div>

    <NativeRecoveryTools key={epoch.current} baseUrl={baseUrl} token={token} enabled={canMutate} />
    <section className="border border-[var(--line)] bg-[var(--card)] rounded-[22px] shadow-[var(--shadow)] p-5 sm:p-6 space-y-4" aria-labelledby="native-inbox-heading">
      <div><h2 id="native-inbox-heading" className="text-lg font-semibold">Recipient inbox</h2><p className="mt-1 text-sm text-[var(--muted)]">Decrypt is available only when the authenticated agent reports at least three shares. Recovered bytes are SHA-256 checked in this tab before download.</p></div>
      {!runtime&&<p className="text-sm text-[var(--faint)]">Connect to read recipient vaults.</p>}
      {runtime&&inbox.length===0&&<p className="text-sm text-[var(--faint)]">{busy==='connect'||busy==='refresh'?'Loading recipient vaults…':'No recipient vaults were returned by the agent.'}</p>}
      {inbox.map(vault=>{const eligible=vault.shareCount>=3;return <div key={vault.id} className="flex flex-col gap-3 border border-[var(--line)] bg-[var(--sunken)] p-4 sm:flex-row sm:items-center sm:justify-between"><div className="min-w-0"><strong className="block break-all text-sm text-[var(--ink)]">{vault.fileName}</strong><code className="block break-all text-[10px] text-[var(--faint)]">{vault.id}</code><div className="mt-1 text-xs text-[var(--muted)]">{vault.lifecycle} · {vault.shareCount} shares · {getAckCount(vault)}/5 acknowledgements</div></div><button type="button" disabled={!canMutate||!eligible||!!busy} onClick={()=>void decrypt(vault)} className="inline-flex shrink-0 items-center justify-center gap-2 rounded border border-[var(--info)]/40 px-3 py-2 text-xs font-semibold text-[var(--info)] disabled:opacity-40">{busy===`decrypt:${vault.id}`?<LoaderCircle size={15} className="animate-spin"/>:<Download size={15}/>} {eligible?'Decrypt and download':'Need at least 3 shares'}</button></div>;})}
      {inbox.length>0&&<p className="text-xs text-[var(--faint)]">A digest mismatch prevents download. Recovered file content is never rendered in the page.</p>}
    </section>
  </section>;
};

export default NativeVaultWorkspace;
