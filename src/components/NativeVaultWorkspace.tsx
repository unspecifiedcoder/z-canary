import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Check, CircleAlert, Copy, Download, ExternalLink, FileLock2, LoaderCircle, LogOut, RefreshCw, ShieldCheck, WalletCards, Wifi, WifiOff } from 'lucide-react';
import NativeRecoveryTools from './NativeRecoveryTools';
import NativeCommandCost from './NativeCommandCost';
import {
  base64ToBytes,
  downloadBytes,
  fileToBase64,
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
    <header className="border border-sky-500/30 bg-[#111923] p-5 sm:p-7 space-y-4">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="space-y-1"><div className="font-mono text-[11px] tracking-wider text-sky-300">REAL ZCASH TESTNET · SHIELDED MEMOS</div><h1 id="native-vault-heading" className="text-2xl sm:text-3xl font-bold text-[#F8FAFC]">Connect Canary’s Zcash wallet.</h1></div>
        <span className="inline-flex items-center gap-2 px-3 py-1.5 border border-sky-500/30 text-xs font-mono text-sky-200"><FileLock2 size={15}/>KEYS STAY IN NATIVE RUNTIME</span>
      </div>
      <p className="max-w-3xl text-sm leading-6 text-[#AAB6C7]">This is the real network path, separate from the browser simulation. It connects this tab to Canary’s authenticated local Zingolib wallet, then enables real REGISTER, CHECK-IN and CANCEL memo transactions on Zcash testnet. Canary never asks for a seed phrase.</p>
      <div className="grid gap-2 sm:grid-cols-3 text-xs">
        <div className="border-l-2 border-sky-400/60 pl-3"><strong className="block text-[#E2E8F0]">1 · Start native runtime</strong><span className="text-[#718096]">Run the repository launcher with the existing wallet state.</span></div>
        <div className="border-l-2 border-sky-400/35 pl-3"><strong className="block text-[#E2E8F0]">2 · Connect locally</strong><span className="text-[#718096]">Paste the one-time bearer from its private token file.</span></div>
        <div className="border-l-2 border-sky-400/20 pl-3"><strong className="block text-[#E2E8F0]">3 · Verify on explorer</strong><span className="text-[#718096]">Confirmed commands expose a real txid and block height.</span></div>
      </div>
      <div className="grid gap-3 md:grid-cols-[minmax(0,1fr)_minmax(0,1fr)_auto]">
        <label className="space-y-1 text-xs text-[#94A3B8]">Loopback agent URL<input value={baseUrl} onChange={event => { clearConnection(); setBaseUrl(event.target.value); }} spellCheck={false} autoComplete="off" className="w-full rounded border border-[#2E3748] bg-[#0B0D11] px-3 py-2 text-sm font-mono text-[#F8FAFC]"/></label>
        <label className="space-y-1 text-xs text-[#94A3B8]">Bearer token<input value={token} onChange={event => { clearConnection(); setToken(event.target.value); }} type="password" autoComplete="off" className="w-full rounded border border-[#2E3748] bg-[#0B0D11] px-3 py-2 text-sm font-mono text-[#F8FAFC]"/></label>
        <button type="button" disabled={!!busy} onClick={runtime ? refresh : connect} className="self-end inline-flex items-center justify-center gap-2 rounded bg-sky-300 px-4 py-2 text-sm font-semibold text-[#081018] disabled:opacity-50">{busy==='connect'?<LoaderCircle size={16} className="animate-spin"/>:runtime?<RefreshCw size={16}/>:<WalletCards size={16}/>} {runtime?'Refresh wallet':'Connect Zcash wallet'}</button>
      </div>
      {error&&<div role="alert" className="whitespace-pre-line border border-red-500/40 bg-red-500/5 p-3 text-sm text-red-200"><CircleAlert className="mr-2 inline" size={16}/>{error}</div>}
      {notice&&<div role="status" className="border border-amber-500/30 bg-amber-500/5 p-3 text-sm text-amber-100">{notice}</div>}
      {runtime&&<div className="space-y-3 border border-emerald-500/25 bg-emerald-500/[0.035] p-4">
        <div className="flex flex-wrap items-center justify-between gap-3"><div className="flex items-center gap-2 text-sm font-semibold text-emerald-200">{runtime.wallet.available?<Wifi size={16}/>:<WifiOff size={16}/>} {runtime.wallet.available?'Connected to Zcash testnet':'Wallet unavailable'}</div><button type="button" onClick={disconnect} className="inline-flex items-center gap-1.5 border border-[#3A465A] px-2.5 py-1.5 text-xs text-[#CBD5E1]"><LogOut size={13}/>Disconnect</button></div>
        <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
          <div className="border border-[#293548] bg-[#0B0D11] p-3 text-sm"><div className="text-xs text-[#64748B]">Network</div><strong className="mt-1 block text-emerald-300">Zcash testnet</strong><span className="text-[10px] font-mono text-[#64748B]">NOT SIMULATED</span></div>
          <div className="border border-[#293548] bg-[#0B0D11] p-3 text-sm"><div className="text-xs text-[#64748B]">Spendable balance</div><strong className="mt-1 block text-[#E2E8F0]">{zatoshiToTaz(runtime.wallet.spendableZatoshi)}</strong><span className="text-[10px] text-[#64748B]">Synced when runtime started</span></div>
          <div className="border border-[#293548] bg-[#0B0D11] p-3 text-sm"><div className="text-xs text-[#64748B]">Wallet chain height</div><strong className="mt-1 block text-[#E2E8F0]">{typeof runtime.wallet.tipHeight==='number'?`#${runtime.wallet.tipHeight.toLocaleString()}`:'Unavailable'}</strong><span className="text-[10px] text-[#64748B]">Startup sync snapshot</span></div>
          <div className="border border-[#293548] bg-[#0B0D11] p-3 text-sm"><div className="text-xs text-[#64748B]">Keeper processes</div><strong className="mt-1 block text-[#E2E8F0]">{runtime.keepers.filter(keeper=>keeper.healthy).length} / {runtime.keepers.length} healthy</strong><span className="text-[10px] text-[#64748B]">Threshold requires 3 shares</span></div>
        </div>
        {runtime.wallet.receiveAddress&&<div className="flex flex-col gap-2 border border-[#293548] bg-[#0B0D11] p-3 sm:flex-row sm:items-center sm:justify-between"><div className="min-w-0"><div className="text-[10px] font-mono uppercase tracking-wider text-[#64748B]">Shielded Unified Address</div><code title={runtime.wallet.receiveAddress} className="block break-all text-xs text-sky-200">{shortAddress(runtime.wallet.receiveAddress)}</code></div><button type="button" onClick={()=>void copyWalletAddress()} className="inline-flex shrink-0 items-center justify-center gap-1.5 border border-[#3A465A] px-2.5 py-1.5 text-xs text-[#CBD5E1]"><Copy size={13}/>Copy full address</button></div>}
      </div>}
      {runtime?.keepers.length ? <ul className="flex flex-wrap gap-2" aria-label="Keeper health">{runtime.keepers.map(keeper=><li key={keeper.id} className={`inline-flex items-center gap-1.5 border px-2 py-1 text-xs ${keeper.healthy?'border-emerald-500/25 text-emerald-200':'border-amber-500/25 text-amber-200'}`}><span aria-hidden="true">{keeper.healthy?'●':'○'}</span>{keeper.id}</li>)}</ul>:null}
    </header>

    <div className="grid gap-6 xl:grid-cols-[minmax(0,1.05fr)_minmax(0,0.95fr)]">
      <section className="space-y-5 border border-[#222938] bg-[#141820] p-5 sm:p-6" aria-labelledby="native-create-heading">
        <div><h2 id="native-create-heading" className="text-lg font-semibold">Create a native testnet vault</h2><p className="mt-1 text-sm text-[#94A3B8]">The local agent performs encryption and keeper provisioning. This page never registers automatically.</p></div>
        <div className="space-y-3 border border-[#293548] bg-[#0B0D11] p-4">
          <div className="flex flex-wrap items-center justify-between gap-3"><div><h3 className="text-sm font-semibold">Recipient identity</h3><p className="text-xs text-[#718096]">Generate or load the public identity from the native agent.</p></div><button type="button" disabled={!canMutate||!!busy} onClick={initializeIdentity} className="rounded border border-[#3A465A] px-3 py-2 text-xs font-semibold text-[#E2E8F0] disabled:opacity-40">{busy==='identity'?'Loading…':'Initialize identity'}</button></div>
          {identity&&<div className="space-y-2 text-xs"><div><div className="text-[#64748B]">Public recipient identity</div><code className="block break-all text-[#CBD5E1]">{identity.recipient}</code></div><div><div className="text-[#64748B]">Fingerprint · verify out of band</div><code className="block break-all text-sky-200">{identity.fingerprint}</code></div><label className="flex items-start gap-2 pt-1 text-[#CBD5E1]"><input type="checkbox" checked={fingerprintAcknowledged} onChange={event=>setFingerprintAcknowledged(event.target.checked)} className="mt-0.5 accent-sky-400"/><span>I independently verified this fingerprint with the intended recipient through a trusted channel.</span></label></div>}
          {!canMutate&&<p className="text-xs text-amber-200">Connect to an available native testnet wallet before initializing recipient identity.</p>}
        </div>
        <form onSubmit={createVault} className="space-y-4">
          <label className="block space-y-1 text-xs text-[#94A3B8]">File to encrypt · maximum 10 MiB<input id="native-vault-file" type="file" onChange={event=>{setFile(event.target.files?.[0]??null);setError(null);}} className="block w-full rounded border border-[#2E3748] bg-[#0B0D11] px-3 py-2 text-sm text-[#CBD5E1] file:mr-3 file:rounded file:border-0 file:bg-[#263244] file:px-3 file:py-1.5 file:text-xs file:text-[#E2E8F0]"/></label>
          {file&&<p className="text-xs text-[#94A3B8]">Selected: <span className="text-[#E2E8F0]">{file.name}</span> · {file.size.toLocaleString()} bytes</p>}
          <div className="grid gap-3 sm:grid-cols-3"><label className="space-y-1 text-xs text-[#94A3B8]">Interval blocks<input type="number" min={8} max={1000000} value={intervalBlocks} onChange={event=>setIntervalBlocks(Number(event.target.value))} className="w-full border border-[#2E3748] bg-[#0B0D11] px-3 py-2 text-sm text-white"/></label><label className="space-y-1 text-xs text-[#94A3B8]">Grace blocks<input type="number" min={1} value={graceBlocks} onChange={event=>setGraceBlocks(Number(event.target.value))} className="w-full border border-[#2E3748] bg-[#0B0D11] px-3 py-2 text-sm text-white"/></label><label className="space-y-1 text-xs text-[#94A3B8]">Confirmations<input type="number" min={2} max={20} value={confirmationTarget} onChange={event=>setConfirmationTarget(Number(event.target.value))} className="w-full border border-[#2E3748] bg-[#0B0D11] px-3 py-2 text-sm text-white"/></label></div>
          {createOutcomeUnknown&&<p role="status" className="text-xs text-amber-200">A prior create request has an uncertain outcome. Use Refresh and inspect the returned vaults before enabling another create.</p>}
          <button type="submit" disabled={!canMutate||!identity||!fingerprintAcknowledged||!file||file.size>MAX_NATIVE_FILE_BYTES||createOutcomeUnknown||!!busy||![intervalBlocks,graceBlocks,confirmationTarget].every(value=>Number.isInteger(value)&&value>0)} className="inline-flex items-center gap-2 rounded bg-sky-300 px-4 py-2.5 text-sm font-semibold text-[#081018] disabled:opacity-40">{busy==='create'?<LoaderCircle size={16} className="animate-spin"/>:<ShieldCheck size={16}/>}Create vault and provision keepers</button>
        </form>
      </section>

      <section className="space-y-5 border border-[#222938] bg-[#141820] p-5 sm:p-6" aria-labelledby="native-vault-list-heading">
        <div className="flex items-start justify-between gap-3"><div><h2 id="native-vault-list-heading" className="text-lg font-semibold">Native vaults</h2><p className="text-sm text-[#94A3B8]">Lifecycle comes from fresh agent detail, not an operation status.</p></div><button type="button" disabled={!runtime||!!busy} onClick={refresh} className="rounded border border-[#3A465A] p-2 text-[#CBD5E1] disabled:opacity-40" aria-label="Refresh native vaults"><RefreshCw size={16}/></button></div>
        {!runtime&&<p className="border border-[#293548] bg-[#0B0D11] p-4 text-sm text-[#94A3B8]">Connect to the local agent to read native vaults.</p>}
        {runtime&&vaults.length===0&&<p className="border border-[#293548] bg-[#0B0D11] p-4 text-sm text-[#94A3B8]">{busy==='connect'||busy==='refresh'?'Loading native vaults…':'The agent returned no native vaults.'}</p>}
        {vaults.length>0&&<div className="space-y-2">{vaults.map(vault=><button type="button" key={vault.id} onClick={()=>{setSelectedId(vault.id);setCancelConfirm(false);setOperation(vault.lastOperation??null);setOperationVaultId(vault.id);setError(null);}} className={`w-full border p-3 text-left ${vault.id===selectedId?'border-sky-400/50 bg-sky-400/5':'border-[#293548] bg-[#0B0D11] hover:border-[#45546B]'}`}><div className="flex flex-wrap justify-between gap-2"><strong className="break-all text-sm text-[#F8FAFC]">{vault.fileName}</strong><span className="font-mono text-[10px] uppercase text-sky-200">{vault.lifecycle}</span></div><div className="mt-1 font-mono text-[10px] text-[#64748B]">{vault.id} · {getAckCount(vault)}/5 acknowledgements · {vault.shareCount} shares</div></button>)}</div>}
        {selected&&<article className="space-y-4 border border-[#344052] bg-[#0B0D11] p-4" aria-label="Selected native vault details">
          <div className="flex flex-wrap items-start justify-between gap-2"><div className="min-w-0"><div className="text-xs font-mono text-[#64748B]">VAULT DETAIL</div><h3 className="break-all text-base font-semibold text-[#F8FAFC]">{selected.fileName}</h3><code className="break-all text-[10px] text-[#64748B]">{selected.id}</code></div><span className="border border-sky-500/30 px-2 py-1 text-xs font-mono text-sky-200">{selected.lifecycle}</span></div>
          <div className="grid grid-cols-2 gap-2 text-xs"><div className="border border-[#263244] p-2 text-[#94A3B8]">Verified keeper acknowledgements<strong className="block text-[#E2E8F0]">{ackCount} / 5</strong></div><div className="border border-[#263244] p-2 text-[#94A3B8]">Available shares<strong className="block text-[#E2E8F0]">{selected.shareCount}</strong></div></div>
          {selected.acknowledgements.length>0&&<ul className="space-y-1">{selected.acknowledgements.map(ack=><li key={ack.keeperId} className="flex items-center gap-2 text-xs"><span className={ack.verified?'text-emerald-300':'text-amber-300'}>{ack.verified?'✓':'○'}</span><span className="text-[#CBD5E1]">{ack.keeperId}</span><span className={ack.verified?'text-emerald-300':'text-amber-200'}>{ack.verified?'Provisioning acknowledged':'Awaiting acknowledgement'}</span></li>)}</ul>}
          <div className="flex flex-wrap gap-2">
            <button className="canary-button outline" disabled={!canMutate||!!busy} onClick={()=>void exportPackage(selected.id)}>Download encrypted package</button>
            {ackCount<5&&<button className="canary-button outline" disabled={!canMutate||!!busy} onClick={()=>void resumeProvisioning(selected.id)}>Resume keeper provisioning</button>}
            {selected.lifecycle.toLowerCase()==='draft'&&<button type="button" disabled={!canRegister||!!busy} onClick={()=>void runOperation('register',selected.id)} className="rounded bg-emerald-400 px-3 py-2 text-xs font-bold text-[#07110C] disabled:opacity-40">{busy==='register'?'Registering…':'Register on testnet'}</button>}
            {['active','grace'].includes(selected.lifecycle.toLowerCase())&&<button type="button" disabled={!canMutate||!!busy} onClick={()=>void runOperation('postpone',selected.id)} className="rounded border border-sky-400/50 px-3 py-2 text-xs font-semibold text-sky-200 disabled:opacity-40">{busy==='postpone'?'Submitting check-in…':'Check in / postpone'}</button>}
            {['active','grace'].includes(selected.lifecycle.toLowerCase())&&!cancelConfirm&&<button type="button" disabled={!canMutate||!!busy} onClick={()=>setCancelConfirm(true)} className="rounded border border-red-500/40 px-3 py-2 text-xs font-semibold text-red-200 disabled:opacity-40">Cancel vault…</button>}
            <button type="button" disabled={!canMutate||!!busy} onClick={()=>{setBusy('detail');void refreshVault(selected.id).catch(reason=>setError(errorText(reason))).finally(()=>setBusy(null));}} className="rounded border border-[#3A465A] px-3 py-2 text-xs text-[#CBD5E1] disabled:opacity-40">Refresh detail</button>
          </div>
          <NativeCommandCost key={`${epoch.current}:${selected.id}`} baseUrl={baseUrl} token={token} enabled={canMutate&&!busy} />
          {selected.lifecycle.toLowerCase()==='draft'&&<p className="text-xs text-[#94A3B8]">Registration requires five distinct verified keeper acknowledgements. Nothing is broadcast until you press Register.</p>}
          {cancelConfirm&&<div className="space-y-3 border border-red-500/40 bg-red-500/5 p-3" role="group" aria-label="Confirm vault cancellation"><p className="text-sm text-red-100">Cancel this native vault? This submits a cancellation operation to the local agent.</p><div className="flex gap-2"><button type="button" disabled={!canMutate||!!busy} onClick={()=>void runOperation('cancel',selected.id)} className="rounded bg-red-500 px-3 py-2 text-xs font-bold text-white disabled:opacity-40">Confirm cancellation</button><button type="button" onClick={()=>setCancelConfirm(false)} className="rounded border border-[#3A465A] px-3 py-2 text-xs text-[#CBD5E1]">Keep vault</button></div></div>}
          {operation&&operationVaultId===selected.id&&<div role="status" className="space-y-1 border border-[#263244] p-3 text-xs"><div className="flex items-center gap-2 text-[#CBD5E1]">{operation.state==='confirmed'?<Check size={15} className="text-emerald-300"/>:<LoaderCircle size={15} className="text-sky-200"/>}Operation: <strong className="uppercase">{operation.state}</strong></div><code className="block break-all text-[#64748B]">{operation.operationId}</code>{operation.txid&&<a href={`https://zexplorer.app/testnet/tx/${operation.txid}`} target="_blank" rel="noreferrer" className="inline-flex max-w-full items-center gap-1 break-all font-mono text-sky-300 hover:underline">txid {operation.txid}<ExternalLink size={11} className="shrink-0"/></a>}{operation.blockHeight!==undefined&&<div className="text-[#94A3B8]">Block #{operation.blockHeight.toLocaleString()}</div>}{operation.error&&<p className="text-red-200">{operation.error}</p>}<p className="text-[#64748B]">Operation state does not itself establish vault lifecycle; the lifecycle above is read from vault detail.</p></div>}
          {operation?.state==='failed'&&operationVaultId===selected.id&&<button className="canary-button outline" disabled={!canMutate||!!busy} onClick={()=>void retryOperation(operation.operationId)}>Resume same operation</button>}
          {selected.events.length>0&&<div className="space-y-2"><h4 className="text-xs font-mono text-[#94A3B8]">RECENT AGENT EVENTS</h4><ul className="space-y-1 text-xs text-[#CBD5E1]">{selected.events.slice(-8).reverse().map((event,index)=><li key={index} className="border-t border-[#202A38] pt-2">{eventText(event)}</li>)}</ul></div>}
        </article>}
      </section>
    </div>

    <NativeRecoveryTools key={epoch.current} baseUrl={baseUrl} token={token} enabled={canMutate} />
    <section className="border border-[#222938] bg-[#141820] p-5 sm:p-6 space-y-4" aria-labelledby="native-inbox-heading">
      <div><h2 id="native-inbox-heading" className="text-lg font-semibold">Recipient inbox</h2><p className="mt-1 text-sm text-[#94A3B8]">Decrypt is available only when the authenticated agent reports at least three shares. Recovered bytes are SHA-256 checked in this tab before download.</p></div>
      {!runtime&&<p className="text-sm text-[#718096]">Connect to read recipient vaults.</p>}
      {runtime&&inbox.length===0&&<p className="text-sm text-[#718096]">{busy==='connect'||busy==='refresh'?'Loading recipient vaults…':'No recipient vaults were returned by the agent.'}</p>}
      {inbox.map(vault=>{const eligible=vault.shareCount>=3;return <div key={vault.id} className="flex flex-col gap-3 border border-[#293548] bg-[#0B0D11] p-4 sm:flex-row sm:items-center sm:justify-between"><div className="min-w-0"><strong className="block break-all text-sm text-[#F8FAFC]">{vault.fileName}</strong><code className="block break-all text-[10px] text-[#64748B]">{vault.id}</code><div className="mt-1 text-xs text-[#94A3B8]">{vault.lifecycle} · {vault.shareCount} shares · {getAckCount(vault)}/5 acknowledgements</div></div><button type="button" disabled={!canMutate||!eligible||!!busy} onClick={()=>void decrypt(vault)} className="inline-flex shrink-0 items-center justify-center gap-2 rounded border border-sky-400/40 px-3 py-2 text-xs font-semibold text-sky-100 disabled:opacity-40">{busy===`decrypt:${vault.id}`?<LoaderCircle size={15} className="animate-spin"/>:<Download size={15}/>} {eligible?'Decrypt and download':'Need at least 3 shares'}</button></div>;})}
      {inbox.length>0&&<p className="text-xs text-[#64748B]">A digest mismatch prevents download. Recovered file content is never rendered in the page.</p>}
    </section>
  </section>;
};

export default NativeVaultWorkspace;
