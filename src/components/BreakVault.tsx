import React, { useRef, useState } from 'react';
import { ArrowRight, Check, CheckCheck, Download, KeyRound, LockKeyhole, RadioTower, RotateCcw, ShieldCheck, UsersRound, X } from 'lucide-react';
import { runVaultChallenge, restoreChallengeThreshold, recoverChallenge, rejectWrongChallengeRecipient, type VaultChallenge, type ChallengeResult } from '../experience/breakVault';
import { CASE_FILENAME, downloadCaseStudy } from '../experience/caseStudy';
import { downloadBytes } from '../services/nativeVault';
import './BreakVault.css';

const challenges = [
  { id: 'two-shares' as const, icon: UsersRound, title: 'Only two keepers', description: 'Try to open the file with fewer than three shares.', kind: 'CRYPTOGRAPHIC CHECK' },
  { id: 'wrong-key' as const, icon: KeyRound, title: 'Wrong recipient', description: 'Meet the threshold, then try someone else’s key.', kind: 'CRYPTOGRAPHIC CHECK' },
  { id: 'stale-scan' as const, icon: RadioTower, title: 'Outdated chain view', description: 'Let grace end while every keeper’s scan is stale.', kind: 'SIMULATED POLICY CHECK' },
  { id: 'cancel' as const, icon: X, title: 'Cancel, then wait', description: 'Cancel the handoff and advance past its deadline.', kind: 'SIMULATED POLICY CHECK' },
];

export default function BreakVault() {
  const [result, setResult] = useState<ChallengeResult | null>(null);
  const [completed, setCompleted] = useState<VaultChallenge[]>([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const operation = useRef(0);
  const resultHeading = useRef<HTMLHeadingElement>(null);
  const execute = async (run: () => ChallengeResult) => {
    const current = ++operation.current;
    setBusy(true); setError('');
    await new Promise<void>(resolve => requestAnimationFrame(() => requestAnimationFrame(() => resolve())));
    if (operation.current !== current) return;
    try {
      const next = run();
      setResult(next);
      setCompleted(previous => {
        const checks = new Set(previous);
        checks.add(next.challenge);
        if (next.scenario.step === 'wrong-key') checks.add('wrong-key');
        return [...checks];
      });
      requestAnimationFrame(() => {
        const heading = resultHeading.current;
        heading?.focus({ preventScroll: true });
        if (window.matchMedia('(max-width: 700px)').matches) {
          heading?.scrollIntoView({
            block: 'start',
            behavior: window.matchMedia('(prefers-reduced-motion: reduce)').matches ? 'instant' : 'smooth',
          });
        }
      });
    } catch { setError('This check did not complete. No successful result was recorded. Reset and try again.'); }
    finally { if (operation.current === current) setBusy(false); }
  };
  const reset = () => { operation.current++; setResult(null); setCompleted([]); setError(''); setBusy(false); };
  const vault = result?.scenario.vault;
  const step = result?.scenario.step;
  const shares = vault?.deliveredSharesToRecipient.length ?? 0;
  const recovered = result?.scenario.verified === true;
  const restore = step === 'insufficient' || step === 'scan-paused';
  const recover = step === 'ready' || step === 'wrong-key';
  return <section className="break-vault" aria-labelledby="break-title">
    <header className="break-heading"><div><span className="break-eyebrow">THE CANARY CHALLENGE / ABOUT 60 SECONDS</span><h1 id="break-title">Try to break<br /><em>the vault.</em></h1><p>Maya is a journalist. Noor is her editor. Maya’s evidence should stay sealed while she checks in—and be recoverable by Noor if she stops.</p></div><aside><ShieldCheck aria-hidden="true"/><strong>You control the test.</strong><p>Choose a failure. See what holds.<br />Then recover the original file.</p><span>Real encryption · simulated chain & keepers</span></aside></header>
    <div className="break-toolbar"><p><LockKeyhole size={15} aria-hidden="true"/> Public fictional reporting notes. Fresh keys for each challenge.</p><button onClick={reset}><RotateCcw size={14} aria-hidden="true"/>Reset all tests</button></div>
    <div className="break-layout"><nav className="break-challenges" aria-label="Choose a vault challenge">{challenges.map(({id,icon:Icon,title,description,kind}, index)=><button key={id} disabled={busy} onClick={()=>execute(()=>runVaultChallenge(id))} aria-pressed={result?.challenge===id} className={result?.challenge===id?'selected':''}><span className="break-challenge-number">0{index+1}</span><div><span className="break-challenge-kind">{kind}</span><h2>{title}</h2><p>{description}</p></div>{completed.includes(id)?<CheckCheck className="break-test-passed" aria-label="Check passed"/>:<Icon aria-hidden="true"/>}</button>)}</nav>
      <div className={`break-result ${recovered?'recovered':''}`} aria-busy={busy}>
        {!result ? <div className="break-empty"><div className="break-lock"><LockKeyhole size={48} strokeWidth={1}/></div><span className="break-eyebrow">MAYA’S ENCRYPTED EVIDENCE</span><h2>Can you open it<br />before you should?</h2><p>Start with two keepers. The reconstruction code will actually run.</p><button className="break-primary" disabled={busy} onClick={()=>execute(()=>runVaultChallenge('two-shares'))}>Try with two shares<ArrowRight size={17}/></button></div> : <>
          <div className="break-result-top"><span>{recovered?'EXACT RECOVERY VERIFIED':step==='ready'?'READY FOR NOOR':'GUARD HELD'}</span><span>{completed.length} / 4 checks tried</span></div>
          <h2 ref={resultHeading} tabIndex={-1}>{result.title}</h2><p className="break-explanation">{result.explanation}</p>
          <div className="break-share-display"><strong>{shares}<small> / 3</small></strong><span>valid shares at recipient<br /><b>{recovered?'File recovered':step==='cancelled'?'Delivery cancelled':shares<3?'Recovery blocked':'Recipient key required'}</b></span></div>
          <div className="break-keepers" aria-label="Simulated keeper states">{vault?.keepers.map(keeper=><div key={keeper.id} className={keeper.outboxDelivered?'delivered':''}><span>K{keeper.index}</span><i aria-hidden="true"/><small>{keeper.lifecycleState==='CANCELLED'?'Cancelled':keeper.outboxDelivered?'Delivered':!keeper.online?'Offline':keeper.scannerHealth!=='HEALTHY'?'Scan stale':'Sealed'}</small></div>)}</div>
          {recovered&&<div className="break-digest"><span>RECOVERED FILE / SHA-256 MATCH</span><code>{vault?.encryptedPackage.plaintextDigestHex}</code></div>}
          <div className="break-actions">{restore&&<button className="break-primary" disabled={busy} onClick={()=>execute(()=>restoreChallengeThreshold(result))}>{step==='scan-paused'?'Refresh scans & restore three keepers':'Restore the third keeper'}<ArrowRight size={17}/></button>}{step==='ready'&&<button className="break-primary" disabled={busy} onClick={()=>execute(()=>rejectWrongChallengeRecipient(result))}>Try a different recipient key<KeyRound size={17}/></button>}{recover&&<button className="break-primary" disabled={busy} onClick={()=>execute(()=>recoverChallenge(result))}>Use Noor’s key & recover<ArrowRight size={17}/></button>}{recovered&&<button className="break-primary" disabled={busy} onClick={()=>{try{const bytes=downloadCaseStudy(result.scenario);try{downloadBytes(CASE_FILENAME,bytes);}finally{bytes.fill(0);}}catch{setError('Recovery could not be verified again. Nothing was downloaded.');}}}><Download size={17}/>Download the verified file</button>}{step==='cancelled'&&<button className="break-primary" disabled={busy} onClick={()=>execute(()=>runVaultChallenge('two-shares'))}>Try a fresh vault<ArrowRight size={17}/></button>}</div>
          <p className="break-receipt" role="status"><Check size={16} aria-hidden="true"/>{result.receipt}</p>
        </>}
        {busy&&<p role="status" className="break-running">Running the check…</p>}
        {error&&<p role="alert" className="break-error">{error}</p>}
      </div>
    </div>
    <footer className="break-footer"><div><span>NOW TRY YOUR OWN SCENARIO</span><h2>Your file. Your handoff.</h2><p>Bring a harmless file into the browser lab, or inspect the recorded Zcash testnet receipts.</p></div><div><a className="break-primary" href="#create">Create your own vault<ArrowRight size={17}/></a><a href="#judge" className="break-proof-link">Inspect real testnet proof ↗</a></div></footer>
    <p className="break-scope">This challenge runs real local encryption, signatures, threshold reconstruction and recipient decryption. Chain timing and keeper availability are simulated; it sends no transaction. Each challenge starts a separate fresh vault. Passing these checks is not a security audit.</p>
  </section>;
}
