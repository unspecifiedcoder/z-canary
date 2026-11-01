import React, { useRef, useState } from 'react';
import { ArrowRight, ArrowUpRight, Check, CheckCheck, Download, KeyRound, LockKeyhole, RotateCcw } from 'lucide-react';
import { runVaultChallenge, restoreChallengeThreshold, recoverChallenge, rejectWrongChallengeRecipient, type VaultChallenge, type ChallengeResult } from '../experience/breakVault';
import { CASE_FILENAME, downloadCaseStudy } from '../experience/caseStudy';
import { downloadBytes } from '../services/nativeVault';

const challengeArt: Record<VaultChallenge, string> = { 'two-shares': 'icon-shards', 'wrong-key': 'icon-wrongkey', 'stale-scan': 'icon-hourglass', cancel: 'icon-cancel' };

const challenges = [
  { id: 'two-shares' as const, title: 'Only two keepers', description: 'Try to open the file with fewer than three shares.', kind: 'CRYPTOGRAPHIC CHECK' },
  { id: 'wrong-key' as const, title: 'Wrong recipient', description: 'Meet the threshold, then try someone else’s key.', kind: 'CRYPTOGRAPHIC CHECK' },
  { id: 'stale-scan' as const, title: 'Outdated chain view', description: 'Let grace end while every keeper’s scan is stale.', kind: 'SIMULATED POLICY CHECK' },
  { id: 'cancel' as const, title: 'Cancel, then wait', description: 'Cancel the handoff and advance past its deadline.', kind: 'SIMULATED POLICY CHECK' },
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
  const art = (name: string) => `./assets/press/${name}.webp`;
  const status = recovered ? 'Exact recovery verified' : step === 'ready' ? 'Ready for Noor' : step === 'cancelled' ? 'Delivery cancelled' : 'Guard held';
  return <section className="challenge" aria-labelledby="break-title">
    <header className="challenge-head">
      <div className="card challenge-intro">
        <span className="kicker"><span className="tag">60 s</span>The Canary challenge</span>
        <h1 id="break-title" className="display">Try to <mark>break</mark> the vault.</h1>
        <p className="lede">Maya is a journalist. Noor is her editor. Maya&rsquo;s evidence should stay sealed while she checks in, and be recoverable by Noor if she stops.</p>
        <div className="challenge-meta"><span className="chip"><LockKeyhole size={13}/>Public fictional notes</span><span className="chip">Fresh keys per challenge</span><button className="btn btn-light btn-sm" onClick={reset}><RotateCcw size={14} aria-hidden="true"/>Reset all tests</button></div>
      </div>
      <aside className="card-yellow challenge-brief">
        <img src={art('vault')} alt="" width="1024" height="1024"/>
        <div><h2 className="display-3">You control the test.</h2><p>Choose a failure. See what holds. Then recover the original file.</p><span className="label">Real encryption · simulated chain &amp; keepers</span></div>
      </aside>
    </header>

    <div className="challenge-board">
      <nav className="challenge-list" aria-label="Choose a vault challenge">{challenges.map(({ id, title, description, kind }, index) => {
        const passed = completed.includes(id);
        return <button key={id} className={`card challenge-item ${result?.challenge === id ? 'is-active' : ''}`} disabled={busy} onClick={() => execute(() => runVaultChallenge(id))} aria-pressed={result?.challenge === id}>
          <img src={art(challengeArt[id])} alt="" width="512" height="512" loading="lazy"/>
          <span className="challenge-item-text"><span className="label">0{index + 1} · {kind.toLowerCase()}</span><b>{title}</b><small>{description}</small></span>
          <span className={`challenge-state ${passed ? 'passed' : ''}`}>{passed ? <><CheckCheck size={14} aria-hidden="true"/>Held</> : 'Try'}</span>
        </button>;
      })}</nav>

      <div className={`card challenge-result ${recovered ? 'is-recovered' : ''}`} aria-busy={busy}>
        {!result ? <div className="challenge-empty">
          <img src={art('envelope')} alt="" width="1024" height="1024"/>
          <span className="label">Maya&rsquo;s encrypted evidence</span>
          <h2 className="display-2">Can you open it <mark>before you should?</mark></h2>
          <p>Start with two keepers. The reconstruction code will actually run.</p>
          <button className="btn btn-dark" disabled={busy} onClick={() => execute(() => runVaultChallenge('two-shares'))}>Try with two shares<span className="btn-orb"><ArrowRight size={18}/></span></button>
        </div> : <>
          <div className="result-top"><span className={`pill ${recovered ? 'is-ok' : ''}`}><span className={`dot ${recovered ? 'ok' : ''}`} aria-hidden="true"/>{status}</span><span className="label">{completed.length} / 4 checks tried</span></div>
          <h2 ref={resultHeading} tabIndex={-1} className="display-2">{result.title}</h2>
          <p className="lede">{result.explanation}</p>
          <div className="share-meter">
            <div className="share-count"><strong>{shares}</strong><span>/ 3 valid shares at the recipient</span><b>{recovered ? 'File recovered' : step === 'cancelled' ? 'Delivery cancelled' : shares < 3 ? 'Recovery blocked' : 'Recipient key required'}</b></div>
            <div className="share-bars" aria-hidden="true">{[0, 1, 2].map(i => <i key={i} className={i < shares ? 'on' : ''}/>)}</div>
          </div>
          <ul className="keeper-chips" aria-label="Simulated keeper states">{vault?.keepers.map(keeper => {
            const label = keeper.lifecycleState === 'CANCELLED' ? 'Cancelled' : keeper.outboxDelivered ? 'Delivered' : !keeper.online ? 'Offline' : keeper.scannerHealth !== 'HEALTHY' ? 'Scan stale' : 'Sealed';
            return <li key={keeper.id} className={keeper.outboxDelivered ? 'delivered' : !keeper.online ? 'offline' : ''}><span>K{keeper.index}</span>{label}</li>;
          })}</ul>
          {recovered && <div className="digest"><span className="label">Recovered file · SHA-256 match</span><code>{vault?.encryptedPackage.plaintextDigestHex}</code></div>}
          <div className="result-actions">
            {restore && <button className="btn btn-dark" disabled={busy} onClick={() => execute(() => restoreChallengeThreshold(result))}>{step === 'scan-paused' ? 'Refresh scans & restore three keepers' : 'Restore the third keeper'}<span className="btn-orb"><ArrowRight size={18}/></span></button>}
            {step === 'ready' && <button className="btn btn-light" disabled={busy} onClick={() => execute(() => rejectWrongChallengeRecipient(result))}><KeyRound size={16}/>Try a different recipient key</button>}
            {recover && <button className="btn btn-dark" disabled={busy} onClick={() => execute(() => recoverChallenge(result))}>Use Noor&rsquo;s key &amp; recover<span className="btn-orb"><ArrowRight size={18}/></span></button>}
            {recovered && <button className="btn btn-yellow" disabled={busy} onClick={() => { try { const bytes = downloadCaseStudy(result.scenario); try { downloadBytes(CASE_FILENAME, bytes); } finally { bytes.fill(0); } } catch { setError('Recovery could not be verified again. Nothing was downloaded.'); } }}><Download size={16}/>Download the verified file</button>}
            {step === 'cancelled' && <button className="btn btn-dark" disabled={busy} onClick={() => execute(() => runVaultChallenge('two-shares'))}>Try a fresh vault<span className="btn-orb"><ArrowRight size={18}/></span></button>}
          </div>
          <p className="receipt" role="status"><Check size={16} aria-hidden="true"/>{result.receipt}</p>
        </>}
        {busy && <p role="status" className="running">Running the check…</p>}
        {error && <p role="alert" className="error-note">{error}</p>}
      </div>
    </div>

    <footer className="card-dark challenge-next">
      <div><span className="label">Now try your own scenario</span><h2 className="display-2">Your file. <mark>Your handoff.</mark></h2><p>Bring a harmless file into the browser lab, or inspect the recorded Zcash testnet receipts.</p></div>
      <div className="challenge-next-actions"><a className="btn btn-yellow" href="#create">Create your own vault <ArrowRight size={17}/></a><a className="btn btn-ghost" href="#judge">Inspect real testnet proof <ArrowUpRight size={16}/></a></div>
    </footer>
    <p className="scope-note">This challenge runs real local encryption, signatures, threshold reconstruction and recipient decryption. Chain timing and keeper availability are simulated; it sends no transaction. Each challenge starts a separate fresh vault. Passing these checks is not a security audit.</p>
  </section>;
}
