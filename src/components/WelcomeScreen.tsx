import React, { lazy, Suspense } from 'react';
import { ArrowRight, ArrowUpRight, FileText, LockKeyhole } from 'lucide-react';
import { ContinuityVault } from '../engine/protocolStore';
import { phaseLabels, projectVault } from '../experience/model';
const LivingVault = lazy(() => import('./LivingVault'));

interface WelcomeScreenProps {
  activeVault: ContinuityVault;
  currentBlockHeight: number;
  onNavigate: (tab: 'welcome' | 'sentinel' | 'create' | 'recipient' | 'support' | 'evidence' | 'native' | 'demo' | 'case' | 'break' | 'judge') => void;
  onQuickDemoStep: (step: 'inspect' | 'checkin' | 'grace' | 'expire' | 'support' | 'tests') => void;
  onToggleKeeperOnline: (keeperIndex: number) => void;
}

export const WelcomeScreen: React.FC<WelcomeScreenProps> = ({ activeVault, currentBlockHeight, onNavigate }) => {
  const visual = projectVault(activeVault, currentBlockHeight);
  return <div className="overview-experience">
    <section className="canary-opening" aria-labelledby="opening-title">
      <div className="canary-opening-art" aria-hidden="true"><img src="./assets/dossier/hero.webp" alt="" width="1536" height="1024" fetchPriority="high" /></div>
      <div className="canary-opening-inner">
        <div className="canary-opening-copy">
          <p className="canary-eyebrow"><span/>A safety handoff for whistleblowers &amp; journalists</p>
          <h1 id="opening-title">Evidence should not leak.<br/><em>Or disappear with you.</em></h1>
          <p className="canary-opening-description"><strong>Put a file in a locked box. Press “I’m okay” to keep it locked.</strong> If you stop checking in, several keepers can provide pieces of the key—but only the person you chose can open it. Zcash shielded transactions carry the native signed check-ins without publishing their contents. The file stays off-chain.</p>
          <div className="canary-opening-actions">
            <button className="canary-button primary" onClick={() => onNavigate('break')}>Try the 60-second challenge <ArrowUpRight size={19}/></button>
            <a className="canary-watch-link" href="#create" onClick={(event) => { event.preventDefault(); onNavigate('create'); }}>Try your own file <ArrowUpRight size={14}/></a>
          </div>
          <p className="canary-opening-note">Browser lab: real local encryption · simulated blocks and keepers · no wallet needed</p>
        </div>
      </div>
      <div className="canary-opening-baseline" aria-label="Recorded Zcash testnet proof">
        <dl className="proof-strip">
          <div><dt>Real Zcash testnet transactions</dt><dd>7</dd></div>
          <div><dt>Memos you can re-verify in your browser</dt><dd>7</dd></div>
          <div><dt>Recovered byte for byte</dt><dd>136 B</dd></div>
        </dl>
        <a href="#judge" onClick={(event) => { event.preventDefault(); onNavigate('judge'); }}>Open Judge Proof <ArrowRight size={14}/></a>
      </div>
    </section>

    <div className="dossier-hatch" aria-hidden="true"/>

    <section className="handoff-story" id="handoff-story" aria-labelledby="handoff-title">
      <div className="canary-section-shell">
        <div className="handoff-story-heading"><div><span className="canary-paper-label">The problem: Maya is investigating corruption</span><h2 id="handoff-title">Share now, risk exposure.<br/><em>Keep it alone, risk losing it.</em></h2></div><p>Canary gives Maya a third choice. Her evidence stays encrypted while she checks in. If she becomes unreachable, her editor Noor gets a controlled recovery path—not automatic access.</p></div>
        <div className="handoff-illustration" aria-label="Maya's encrypted file can be recovered by Noor when the recovery conditions are met">
          <div className="handoff-person"><span className="handoff-person-initial">M</span><div><strong>Maya</strong><span>The reporter</span></div></div>
          <div className="handoff-connector"><span>Encrypted for Noor</span><i/></div>
          <div className="handoff-document"><FileText size={34}/><span>Reporting<br/>notes</span><LockKeyhole size={18}/></div>
          <div className="handoff-connector"><span>Conditional recovery</span><i/></div>
          <div className="handoff-person"><span className="handoff-person-initial">N</span><div><strong>Noor</strong><span>The chosen editor</span></div></div>
        </div>
        <div className="handoff-principles">
          <button onClick={() => onNavigate('create')}><img className="handoff-icon" src="./assets/dossier/icon-seal.webp" alt="" width="512" height="512" loading="lazy"/><span className="handoff-step">01</span><h3>Lock the evidence now.</h3><p>Choose who may recover it. The file is encrypted locally before the handoff begins.</p><span className="handoff-principle-link">Create your own Canary <ArrowUpRight size={17}/></span></button>
          <button onClick={() => onNavigate('sentinel')}><img className="handoff-icon" src="./assets/dossier/icon-pulse.webp" alt="" width="512" height="512" loading="lazy"/><span className="handoff-step">02</span><h3>Keep saying “I’m okay.”</h3><p>Each signed check-in moves the deadline. While check-ins continue, recovery stays blocked.</p><span className="handoff-principle-link">See the owner view <ArrowUpRight size={17}/></span></button>
          <button onClick={() => onNavigate('recipient')}><img className="handoff-icon" src="./assets/dossier/icon-recover.webp" alt="" width="512" height="512" loading="lazy"/><span className="handoff-step">03</span><h3>If silence continues, recover.</h3><p>After the deadline and safety window, enough keepers—and the chosen person’s key—are still required.</p><span className="handoff-principle-link">See the recipient view <ArrowUpRight size={17}/></span></button>
        </div>
        <div className="handoff-story-bottom"><p>Use a harmless file and run the whole lifecycle yourself—or follow Maya and Noor’s guided example.</p><button className="canary-button ink" onClick={() => onNavigate('create')}>Create your own Canary <ArrowRight size={18}/></button></div>
      </div>
    </section>

    <section className="canary-observatory" aria-labelledby="observatory-title">
      <div className="canary-section-shell">
        <div className="canary-observatory-top"><div><span className="canary-eyebrow">The working vault, in a browser simulation</span><h2 id="observatory-title">A promise, with<br/><em>rules you can inspect.</em></h2><p>Explore the two encryption layers and the five keeper records. This is the current state of your separate browser demo vault.</p><button className="text-link" onClick={() => onNavigate('demo')}>Explore the protocol tour <ArrowUpRight size={17}/></button></div><div className="canary-observatory-scene"><Suspense fallback={<div className="scene-loading">Assembling the vault schematic…</div>}><LivingVault state={visual}/></Suspense></div></div>
        <div className="overview-status" aria-label="Current simulated vault">
          <div><span className="section-label">Current protection</span><strong>{phaseLabels[visual.phase]}</strong><small>{activeVault.fileName}</small></div>
          <div><span className="section-label">Next check-in</span><strong>{visual.blocksRemaining}<small> blocks</small></strong><small>Measured at the confirmed cursor</small></div>
          <div><span className="section-label">Valid shares required</span><strong>3<span className="muted"> / 5</span></strong><small>The recipient’s key is still required</small></div>
          <button className="round-action" onClick={() => onNavigate('sentinel')} aria-label="Open vault sentinel"><ArrowUpRight size={24}/></button>
        </div>
      </div>
    </section>

    <section className="canary-native-proof" aria-labelledby="native-proof-title">
      <img className="native-proof-art" src="./assets/dossier/keepers.webp" alt="" aria-hidden="true" width="1536" height="1024" loading="lazy" />
      <div className="canary-section-shell">
        <div className="native-proof-copy"><span className="canary-paper-label">Why Zcash belongs here</span><h2 id="native-proof-title">Private check-ins.<br/>Verifiable recovery.</h2><p>Canary’s native testnet path carries signed check-ins in Zcash shielded transactions, keeping their contents off the public chain. The evidence file stays off-chain. Inspect the recorded registration, check-in, cancellation and exact-file recovery below.</p></div>
        <div className="native-proof-numbers"><div><strong>4</strong><span>Commands in the protected-document run (3 more memos in an earlier run: 7 in total)</span></div><div><strong>136<span>B</span></strong><span>Recovered, byte for byte</span></div><div><strong>3<span>/5</span></strong><span>Recovery threshold</span></div></div>
        <div className="native-proof-actions"><button className="canary-button ink" onClick={() => onNavigate('judge')}>Open Judge Proof <ArrowUpRight size={18}/></button><button className="canary-paper-link" onClick={() => onNavigate('native')}>Connect a local native agent <ArrowRight size={17}/></button></div>
        <details className="threat-disclosure" open><summary>What this does not protect against <span>+</span></summary><p>Five native keeper processes currently share one operator and scanner. Three colluding keepers can release early to the designated recipient. Cancellation cannot recall delivered shares. Network observers and lightwallet operators can learn metadata. No smart contract is deployed.</p><p>The browser uses X25519 and AES-GCM in a demonstration format; native encryption uses age and XChaCha20-Poly1305. This is a tested prototype, not an audited tool for sensitive reporting. Use public fictional files.</p></details>
      </div>
    </section>
  </div>;
};
