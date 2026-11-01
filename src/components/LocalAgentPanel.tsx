import React, { useEffect, useRef, useState } from 'react';
import { Activity, CheckCircle2, Eye, EyeOff, LoaderCircle, Wifi, WifiOff } from 'lucide-react';
import { AgentApiError, AgentEvidenceResponse, AgentStatus, RequestEpoch, VerifiedMemo, localAgent } from '../services/localAgent';

interface Props { memoHex?: string }

export const LocalAgentPanel: React.FC<Props> = ({ memoHex }) => {
  const [baseUrl, setBaseUrl] = useState('http://127.0.0.1:8787');
  const [token, setToken] = useState('');
  const [showToken, setShowToken] = useState(false);
  const [status, setStatus] = useState<AgentStatus | null>(null);
  const [verified, setVerified] = useState<VerifiedMemo | null>(null);
  const [evidence, setEvidence] = useState<AgentEvidenceResponse | null>(null);
  const [evidenceError, setEvidenceError] = useState<string | null>(null);
  const [busy, setBusy] = useState<'status' | 'verify' | 'evidence' | null>(null);
  const [error, setError] = useState<string | null>(null);
  const requestEpoch = useRef(new RequestEpoch());

  useEffect(() => {
    requestEpoch.current.invalidate();
    setVerified(null);
    setBusy(null);
    setError(null);
  }, [memoHex]);

  const clearConnectionState = () => {
    requestEpoch.current.invalidate();
    setStatus(null);
    setVerified(null);
    setEvidence(null);
    setEvidenceError(null);
    setBusy(null);
    setError(null);
  };

  const connect = async () => {
    const version = requestEpoch.current.begin();
    setBusy('status'); setError(null); setVerified(null);
    try {
      const result = await localAgent.status(baseUrl, token);
      if (requestEpoch.current.isCurrent(version)) setStatus(result);
      try {
        const evidenceResult = await localAgent.evidence(baseUrl, token);
        if (requestEpoch.current.isCurrent(version)) { setEvidence(evidenceResult); setEvidenceError(null); }
      } catch (reason) {
        if (requestEpoch.current.isCurrent(version)) setEvidenceError(reason instanceof AgentApiError ? reason.message : 'Unable to load evidence report.');
      }
    }
    catch (reason) { if (requestEpoch.current.isCurrent(version)) { setStatus(null); setError(reason instanceof AgentApiError ? `${reason.message}${reason.code ? ` (${reason.code})` : ''}` : 'Unable to connect to local agent.'); } }
    finally { if (requestEpoch.current.isCurrent(version)) setBusy(null); }
  };
  const refreshEvidence = async () => {
    const version = requestEpoch.current.begin();
    setBusy('evidence'); setEvidenceError(null);
    try {
      const result = await localAgent.evidence(baseUrl, token);
      if (requestEpoch.current.isCurrent(version)) setEvidence(result);
    } catch (reason) {
      if (requestEpoch.current.isCurrent(version)) { setEvidence(null); setEvidenceError(reason instanceof AgentApiError ? `${reason.message}${reason.code ? ` (${reason.code})` : ''}` : 'Unable to load evidence report.'); }
    } finally { if (requestEpoch.current.isCurrent(version)) setBusy(null); }
  };
  const verify = async () => {
    if (!memoHex) return;
    const version = requestEpoch.current.begin();
    setBusy('verify'); setError(null); setVerified(null);
    try { const result = await localAgent.verifyMemo(baseUrl, token, memoHex); if (requestEpoch.current.isCurrent(version)) setVerified(result); }
    catch (reason) { if (requestEpoch.current.isCurrent(version)) setError(reason instanceof AgentApiError ? `${reason.message}${reason.code ? ` (${reason.code})` : ''}` : 'Memo verification failed.'); }
    finally { if (requestEpoch.current.isCurrent(version)) setBusy(null); }
  };

  return <section className="border border-[var(--line)] bg-[var(--card)] rounded-[22px] shadow-[var(--shadow)] p-6 lg:p-8 space-y-5">
    <div className="space-y-1">
      <div className="text-xs font-mono text-[var(--info)]">LOCAL AGENT · AUTHENTICATED API</div>
      <h2 className="text-xl font-bold text-[var(--ink)]">Connect to the local Rust service</h2>
      <p className="text-sm text-[var(--muted)]">The bearer token stays in this tab’s memory and is cleared when you reload or close it. It is never saved to browser storage.</p>
    </div>
    <div className="grid gap-3 md:grid-cols-[1fr_1.4fr_auto]">
      <label className="text-xs text-[var(--muted)] space-y-1">Loopback agent URL
        <input value={baseUrl} onChange={e=>{clearConnectionState();setBaseUrl(e.target.value);}} className="w-full px-3 py-2 bg-[var(--sunken)] border border-[var(--line)] rounded text-sm font-mono text-[var(--ink)]" spellCheck={false}/>
      </label>
      <label className="text-xs text-[var(--muted)] space-y-1">Bearer token
        <span className="flex"><input value={token} onChange={e=>{clearConnectionState();setToken(e.target.value);}} type={showToken?'text':'password'} autoComplete="off" className="min-w-0 flex-1 px-3 py-2 bg-[var(--sunken)] border border-[var(--line)] rounded-l text-sm font-mono text-[var(--ink)]"/><button type="button" aria-label={showToken?'Hide token':'Show token'} onClick={()=>setShowToken(v=>!v)} className="px-3 border border-l-0 border-[var(--line)] rounded-r text-[var(--muted)]">{showToken?<EyeOff size={16}/>:<Eye size={16}/>}</button></span>
      </label>
      <button disabled={!!busy} onClick={connect} className="self-end px-4 py-2 bg-[var(--yellow)] disabled:opacity-50 text-[var(--ink)] rounded text-sm font-semibold">{busy==='status'?'Connecting…':'Connect'}</button>
    </div>
    {error && <div role="alert" className="p-3 border border-[var(--bad)]/40 bg-[var(--bad)]/5 text-sm text-[var(--bad)]">{error}</div>}
    {status && <div className="space-y-4">
      <div className="p-4 bg-[var(--sunken)] border border-[var(--line)] flex flex-wrap items-center justify-between gap-3">
        <div className="flex items-center gap-2 text-sm"><Wifi size={17} className="text-[var(--ok)]"/><strong>{status.service}</strong><span className="text-[var(--faint)]">· {status.network}</span></div>
        <span className="text-xs font-mono text-[var(--accent-ink)]">{status.state.replaceAll('-', ' ').toUpperCase()}</span>
      </div>
      <div className="grid gap-3 sm:grid-cols-3 text-sm">
        <div className="p-3 border border-[var(--line)] bg-[var(--sunken)]">Wallet <strong className={status.wallet.available?'text-[var(--ok)]':'text-[var(--accent-ink)]'}>{status.wallet.available?'Available':status.wallet.state}</strong></div>
        <div className="p-3 border border-[var(--line)] bg-[var(--sunken)]">Keepers <strong className={status.keepers.running?'text-[var(--ok)]':'text-[var(--accent-ink)]'}>{status.keepers.running?'Running':status.keepers.state}</strong></div>
        <div className="p-3 border border-[var(--line)] bg-[var(--sunken)]">Mode <strong className="text-[var(--info)]">{status.simulation?'Simulation':'Local agent'}</strong></div>
      </div>
      <div className="p-4 border border-[var(--yellow-2)]/40 bg-[var(--yellow-2)]/5 text-sm text-[var(--accent-ink)]">
        {status.capabilities.walletCommands ? 'Wallet operations are reported available by the agent.' : 'Wallet integration is unavailable. This connection cannot create, fund, register, check in, cancel, or release a vault.'}
        {' '}Memo signature verification is {status.capabilities.memoVerification?'available':'unavailable'}; keeper release is {status.capabilities.keeperRelease?'available':'unavailable'}.
      </div>
      <section className="p-4 bg-[var(--sunken)] border border-[var(--line)] space-y-4" aria-labelledby="agent-evidence-title">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div><h3 id="agent-evidence-title" className="font-semibold text-[var(--ink)]">Configured evidence report</h3><p className="text-xs text-[var(--muted)]">Loaded from the configured local report file and schema-validated at startup; the agent accepts no file path over HTTP.</p></div>
          <button disabled={!!busy} onClick={refreshEvidence} className="px-3 py-1.5 border border-[var(--line)] rounded text-xs text-[var(--muted)] disabled:opacity-50">{busy==='evidence'?'Loading…':'Refresh report'}</button>
        </div>
        {evidenceError && <p role="alert" className="text-sm text-[var(--bad)]">{evidenceError}</p>}
        {!evidenceError && evidence?.available && evidence.report && <div className="space-y-4">
          <strong className="text-sm text-[var(--ink)]">{evidence.report.label}</strong>
          {evidence.report.runs.map((run,runIndex)=><div key={`${runIndex}-${run.label}`} className="border-t border-[var(--line)] pt-3 space-y-3">
            <div className="flex flex-wrap items-center gap-2"><strong className="text-sm text-[var(--ink)]">{run.label}</strong><span className={`px-2 py-0.5 rounded text-[10px] uppercase font-mono ${run.mode==='testnet'?'bg-[var(--ok)]/10 text-[var(--ok)]':'bg-[var(--yellow-2)]/10 text-[var(--accent-ink)]'}`}>{run.mode==='testnet'?'Testnet':'Synthetic chain'}</span></div>
            <div className="space-y-2">
              <h4 className="text-xs font-mono text-[var(--muted)]">{run.mode==='testnet'?'TESTNET CHECKS':'SYNTHETIC REHEARSAL CHECKS'}</h4>
              {run.checks.length===0?<p className="text-xs text-[var(--faint)]">No checks listed.</p>:run.checks.map((check,index)=><div key={`${index}-${check.name}`} className="flex items-start gap-2 text-sm"><span className={check.passed?'text-[var(--ok)]':'text-[var(--bad)]'} aria-label={check.passed?'passed':'failed'}>{check.passed?'PASS':'FAIL'}</span><span className="text-[var(--muted)]">{check.name}</span></div>)}
            </div>
            {run.mode==='testnet' && <div className="space-y-2">
              <h4 className="text-xs font-mono text-[var(--muted)]">TESTNET TRANSACTIONS</h4>
              {run.transactions.length===0?<p className="text-xs text-[var(--faint)]">No transactions listed.</p>:run.transactions.map((tx,index)=>{
                const txid=tx.txid.toLowerCase();
                const validTxid=/^[0-9a-f]{64}$/.test(txid);
                return <div key={`${index}-${txid}`} className="border-t border-[var(--line)] pt-2 text-sm space-y-1"><div className="flex flex-wrap justify-between gap-2"><span className="text-[var(--ink)]">{tx.label}</span>{validTxid&&<a href={`https://testnet.cipherscan.app/tx/${txid}`} target="_blank" rel="noreferrer" className="text-[var(--info)] hover:underline">Open testnet transaction</a>}</div><code className="block break-all text-xs text-[var(--muted)]">{txid}</code>{tx.blockHeight!==undefined&&<span className="text-xs text-[var(--faint)]">Reported block #{tx.blockHeight.toLocaleString()}</span>}</div>;
              })}
              <p className="text-xs text-[var(--faint)]">Explorer links show publicly available transaction data. The agent does not independently verify report claims, payment purpose, or shielded memo contents.</p>
            </div>}
            {run.limitations.length>0&&<div className="space-y-1"><h4 className="text-xs font-mono text-[var(--muted)]">LIMITATIONS</h4><ul className="list-disc pl-5 text-xs text-[var(--muted)] space-y-1">{run.limitations.map((item,index)=><li key={`${index}-${item}`}>{item}</li>)}</ul></div>}
          </div>)}
        </div>}
        {!evidenceError && evidence && !evidence.available && <p className="text-sm text-[var(--muted)]">No evidence report is configured for this agent.</p>}
      </section>
      <div className="flex flex-wrap items-center gap-3">
        <button disabled={!!busy || !memoHex || !status.capabilities.memoVerification} onClick={verify} className="px-4 py-2 bg-[var(--sunken)] disabled:opacity-40 border border-[var(--line)] rounded text-sm text-[var(--ink)] flex items-center gap-2">{busy==='verify'?<LoaderCircle size={15} className="animate-spin"/>:<Activity size={15}/>}Verify selected memo with agent</button>
        {!memoHex && <span className="text-xs text-[var(--muted)]">Select a demo memo above to enable verification.</span>}
      </div>
      {verified && <div role="status" className="p-4 border border-[var(--ok)]/40 bg-[var(--ok)]/5 text-sm space-y-1"><div className="flex items-center gap-2 text-[var(--ok)]"><CheckCircle2 size={17}/>Agent verified the memo signature</div><div className="font-mono text-xs text-[var(--muted)]">{verified.operation.toUpperCase()} · seq {verified.sequence} · switch {verified.switchIdHex.slice(0,20)}…</div><p className="text-xs text-[var(--muted)]">This verifies the selected locally generated demo payload only. It does not prove broadcast, mining, or testnet confirmation.</p></div>}
    </div>}
  </section>;
};
