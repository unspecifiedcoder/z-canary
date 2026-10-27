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

  return <section className="border border-[#222938] bg-[#141820] p-6 lg:p-8 space-y-5">
    <div className="space-y-1">
      <div className="text-xs font-mono text-[#38BDF8]">LOCAL AGENT · AUTHENTICATED API</div>
      <h2 className="text-xl font-bold text-[#F8FAFC]">Connect to the local Rust service</h2>
      <p className="text-sm text-[#94A3B8]">The bearer token stays in this tab’s memory and is cleared when you reload or close it. It is never saved to browser storage.</p>
    </div>
    <div className="grid gap-3 md:grid-cols-[1fr_1.4fr_auto]">
      <label className="text-xs text-[#94A3B8] space-y-1">Loopback agent URL
        <input value={baseUrl} onChange={e=>{clearConnectionState();setBaseUrl(e.target.value);}} className="w-full px-3 py-2 bg-[#0B0D11] border border-[#222938] rounded text-sm font-mono text-[#F8FAFC]" spellCheck={false}/>
      </label>
      <label className="text-xs text-[#94A3B8] space-y-1">Bearer token
        <span className="flex"><input value={token} onChange={e=>{clearConnectionState();setToken(e.target.value);}} type={showToken?'text':'password'} autoComplete="off" className="min-w-0 flex-1 px-3 py-2 bg-[#0B0D11] border border-[#222938] rounded-l text-sm font-mono text-[#F8FAFC]"/><button type="button" aria-label={showToken?'Hide token':'Show token'} onClick={()=>setShowToken(v=>!v)} className="px-3 border border-l-0 border-[#222938] rounded-r text-[#94A3B8]">{showToken?<EyeOff size={16}/>:<Eye size={16}/>}</button></span>
      </label>
      <button disabled={!!busy} onClick={connect} className="self-end px-4 py-2 bg-[#38BDF8] disabled:opacity-50 text-[#0B0D11] rounded text-sm font-semibold">{busy==='status'?'Connecting…':'Connect'}</button>
    </div>
    {error && <div role="alert" className="p-3 border border-red-500/40 bg-red-500/5 text-sm text-red-200">{error}</div>}
    {status && <div className="space-y-4">
      <div className="p-4 bg-[#0B0D11] border border-[#222938] flex flex-wrap items-center justify-between gap-3">
        <div className="flex items-center gap-2 text-sm"><Wifi size={17} className="text-emerald-400"/><strong>{status.service}</strong><span className="text-[#64748B]">· {status.network}</span></div>
        <span className="text-xs font-mono text-amber-300">{status.state.replaceAll('-', ' ').toUpperCase()}</span>
      </div>
      <div className="grid gap-3 sm:grid-cols-3 text-sm">
        <div className="p-3 border border-[#222938] bg-[#0B0D11]">Wallet <strong className={status.wallet.available?'text-emerald-300':'text-amber-300'}>{status.wallet.available?'Available':status.wallet.state}</strong></div>
        <div className="p-3 border border-[#222938] bg-[#0B0D11]">Keepers <strong className={status.keepers.running?'text-emerald-300':'text-amber-300'}>{status.keepers.running?'Running':status.keepers.state}</strong></div>
        <div className="p-3 border border-[#222938] bg-[#0B0D11]">Mode <strong className="text-sky-300">{status.simulation?'Simulation':'Local agent'}</strong></div>
      </div>
      <div className="p-4 border border-amber-500/40 bg-amber-500/5 text-sm text-amber-100">
        {status.capabilities.walletCommands ? 'Wallet operations are reported available by the agent.' : 'Wallet integration is unavailable. This connection cannot create, fund, register, check in, cancel, or release a vault.'}
        {' '}Memo signature verification is {status.capabilities.memoVerification?'available':'unavailable'}; keeper release is {status.capabilities.keeperRelease?'available':'unavailable'}.
      </div>
      <section className="p-4 bg-[#0B0D11] border border-[#222938] space-y-4" aria-labelledby="agent-evidence-title">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div><h3 id="agent-evidence-title" className="font-semibold text-[#F8FAFC]">Configured evidence report</h3><p className="text-xs text-[#94A3B8]">Loaded from the configured local report file and schema-validated at startup; the agent accepts no file path over HTTP.</p></div>
          <button disabled={!!busy} onClick={refreshEvidence} className="px-3 py-1.5 border border-[#2E3748] rounded text-xs text-[#CBD5E1] disabled:opacity-50">{busy==='evidence'?'Loading…':'Refresh report'}</button>
        </div>
        {evidenceError && <p role="alert" className="text-sm text-red-200">{evidenceError}</p>}
        {!evidenceError && evidence?.available && evidence.report && <div className="space-y-4">
          <strong className="text-sm text-[#F8FAFC]">{evidence.report.label}</strong>
          {evidence.report.runs.map((run,runIndex)=><div key={`${runIndex}-${run.label}`} className="border-t border-[#222938] pt-3 space-y-3">
            <div className="flex flex-wrap items-center gap-2"><strong className="text-sm text-[#F8FAFC]">{run.label}</strong><span className={`px-2 py-0.5 rounded text-[10px] uppercase font-mono ${run.mode==='testnet'?'bg-emerald-500/10 text-emerald-300':'bg-amber-500/10 text-amber-300'}`}>{run.mode==='testnet'?'Testnet':'Synthetic chain'}</span></div>
            <div className="space-y-2">
              <h4 className="text-xs font-mono text-[#94A3B8]">{run.mode==='testnet'?'TESTNET CHECKS':'SYNTHETIC REHEARSAL CHECKS'}</h4>
              {run.checks.length===0?<p className="text-xs text-[#64748B]">No checks listed.</p>:run.checks.map((check,index)=><div key={`${index}-${check.name}`} className="flex items-start gap-2 text-sm"><span className={check.passed?'text-emerald-300':'text-red-300'} aria-label={check.passed?'passed':'failed'}>{check.passed?'PASS':'FAIL'}</span><span className="text-[#CBD5E1]">{check.name}</span></div>)}
            </div>
            {run.mode==='testnet' && <div className="space-y-2">
              <h4 className="text-xs font-mono text-[#94A3B8]">TESTNET TRANSACTIONS</h4>
              {run.transactions.length===0?<p className="text-xs text-[#64748B]">No transactions listed.</p>:run.transactions.map((tx,index)=>{
                const txid=tx.txid.toLowerCase();
                const validTxid=/^[0-9a-f]{64}$/.test(txid);
                return <div key={`${index}-${txid}`} className="border-t border-[#222938] pt-2 text-sm space-y-1"><div className="flex flex-wrap justify-between gap-2"><span className="text-[#F8FAFC]">{tx.label}</span>{validTxid&&<a href={`https://testnet.cipherscan.app/tx/${txid}`} target="_blank" rel="noreferrer" className="text-sky-300 hover:underline">Open testnet transaction</a>}</div><code className="block break-all text-xs text-[#94A3B8]">{txid}</code>{tx.blockHeight!==undefined&&<span className="text-xs text-[#64748B]">Reported block #{tx.blockHeight.toLocaleString()}</span>}</div>;
              })}
              <p className="text-xs text-[#64748B]">Explorer links show publicly available transaction data. The agent does not independently verify report claims, payment purpose, or shielded memo contents.</p>
            </div>}
            {run.limitations.length>0&&<div className="space-y-1"><h4 className="text-xs font-mono text-[#94A3B8]">LIMITATIONS</h4><ul className="list-disc pl-5 text-xs text-[#94A3B8] space-y-1">{run.limitations.map((item,index)=><li key={`${index}-${item}`}>{item}</li>)}</ul></div>}
          </div>)}
        </div>}
        {!evidenceError && evidence && !evidence.available && <p className="text-sm text-[#94A3B8]">No evidence report is configured for this agent.</p>}
      </section>
      <div className="flex flex-wrap items-center gap-3">
        <button disabled={!!busy || !memoHex || !status.capabilities.memoVerification} onClick={verify} className="px-4 py-2 bg-[#1E2430] disabled:opacity-40 border border-[#2E3748] rounded text-sm text-[#F8FAFC] flex items-center gap-2">{busy==='verify'?<LoaderCircle size={15} className="animate-spin"/>:<Activity size={15}/>}Verify selected memo with agent</button>
        {!memoHex && <span className="text-xs text-[#94A3B8]">Select a demo memo above to enable verification.</span>}
      </div>
      {verified && <div role="status" className="p-4 border border-emerald-500/40 bg-emerald-500/5 text-sm space-y-1"><div className="flex items-center gap-2 text-emerald-300"><CheckCircle2 size={17}/>Agent verified the memo signature</div><div className="font-mono text-xs text-[#CBD5E1]">{verified.operation.toUpperCase()} · seq {verified.sequence} · switch {verified.switchIdHex.slice(0,20)}…</div><p className="text-xs text-[#94A3B8]">This verifies the selected locally generated demo payload only. It does not prove broadcast, mining, or testnet confirmation.</p></div>}
    </div>}
  </section>;
};
