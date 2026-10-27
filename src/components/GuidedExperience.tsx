import React, { lazy, Suspense, useEffect, useState } from 'react';
import { ArrowRight, Download, Pause, Play, RotateCcw } from 'lucide-react';
import { advanceGuidedScenario, createGuidedScenario, recoverGuidedFixture } from '../experience/demo';
import { demoChapters, projectVault } from '../experience/model';
import { downloadBytes } from '../services/nativeVault';
const LivingVault = lazy(() => import('./LivingVault'));

export default function GuidedExperience({ onNative }: { onNative: () => void }) {
  const [scenario, setScenario] = useState(createGuidedScenario);
  const [playing, setPlaying] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const chapter = demoChapters[scenario.chapter];
  const next = () => {
    try { setScenario(advanceGuidedScenario(scenario)); setError(null); }
    catch { setError('The protocol check failed. Reset the synthetic scenario to try again.'); setPlaying(false); }
  };
  useEffect(() => {
    if (!playing) return;
    if (scenario.chapter === 5) { setPlaying(false); return; }
    const timer = setTimeout(next, 12500);
    return () => clearTimeout(timer);
  }, [playing, scenario.chapter]);
  const reset = () => { setPlaying(false); setScenario(createGuidedScenario()); setError(null); };
  return <div className="guided-experience">
    <div className="page-eyebrow"><span>THE CANARY STORY</span><span>INTERACTIVE SIMULATION / ~75 SECONDS</span></div>
    <div className="chapter-progress" aria-label="Demonstration progress">{demoChapters.map((item, i) => <div key={item.label} className={i <= scenario.chapter ? 'is-complete' : ''} aria-current={i === scenario.chapter ? 'step' : undefined}><span>0{i + 1}</span>{item.label}</div>)}</div>
    <div className="guided-stage">
      <div className="guided-copy" key={scenario.chapter}>
        <span className="chapter-number">0{scenario.chapter + 1}<span> / 06</span></span>
        <h1>{chapter.title}</h1><p>{chapter.copy}</p>
        <button className="canary-button primary" onClick={next}>{chapter.action}<ArrowRight size={18}/></button>
        {scenario.verified && <button className="canary-button quiet" onClick={() => { try { const bytes = recoverGuidedFixture(scenario); downloadBytes('Canary-synthetic-dossier.txt', bytes); bytes.fill(0); } catch { setError('Fixture verification failed. Nothing was downloaded.'); } }}><Download size={16}/>Download verified fixture</button>}
        {error && <p role="alert" className="error-text">{error}</p>}
      </div>
      <Suspense fallback={<div className="scene-loading">Assembling the archive…</div>}><LivingVault state={projectVault(scenario.vault, scenario.height)} /></Suspense>
    </div>
    <div className="demo-readouts"><div><span>SIMULATED CHAIN</span><strong>#{scenario.height.toLocaleString()}</strong></div><div><span>SIGNED SEQUENCE</span><strong>{String(scenario.vault.highestSequence).padStart(2, '0')}</strong></div><div><span>RECIPIENT SHARES</span><strong>{scenario.vault.deliveredSharesToRecipient.length}<small> / 3 required</small></strong></div><div><span>PACKAGE VERIFICATION</span><strong>{scenario.verified ? 'Passed' : 'Sealed'}</strong></div></div>
    <div className="demo-transport"><div><button className="canary-button outline" onClick={() => setPlaying(v => !v)} disabled={scenario.chapter === 5}>{playing ? <Pause size={14}/> : <Play size={14}/>} {playing ? 'Pause story' : 'Play guided story'}</button><button className="canary-button quiet" onClick={reset}><RotateCcw size={14}/>Reset</button></div><p>Real browser cryptography. Simulated blocks and keeper records. No transactions sent.</p></div>
    <div className="trust-note"><span>THE IMPORTANT BOUNDARY</span><p>Three colluding keepers could release early to the recipient. Delivered shares cannot be recalled. This demo shares one browser; native testnet uses local processes operated by one team.</p><button className="text-link" onClick={onNative}>Open the native workspace <ArrowRight size={16}/></button></div>
  </div>;
}
