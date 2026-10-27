import React, { lazy, Suspense } from 'react';
import { ArrowDown, ArrowRight, ArrowUpRight, Fingerprint, Radio, ShieldCheck } from 'lucide-react';
import { ContinuityVault } from '../engine/protocolStore';
import { phaseLabels, projectVault } from '../experience/model';
const LivingVault = lazy(() => import('./LivingVault'));

interface WelcomeScreenProps {
  activeVault: ContinuityVault;
  currentBlockHeight: number;
  onNavigate: (tab: 'welcome' | 'sentinel' | 'create' | 'recipient' | 'support' | 'evidence' | 'native' | 'demo' | 'case') => void;
  onQuickDemoStep: (step: 'inspect' | 'checkin' | 'grace' | 'expire' | 'support' | 'tests') => void;
  onToggleKeeperOnline: (keeperIndex: number) => void;
}

export const WelcomeScreen: React.FC<WelcomeScreenProps> = ({ activeVault, currentBlockHeight, onNavigate }) => {
  const visual = projectVault(activeVault, currentBlockHeight);
  return <div className="overview-experience">
    <div className="page-eyebrow"><span>PRIVATE EVIDENCE. ENDURING INTENT.</span><span>CONTINUITY PROTOCOL / 01</span></div>
    <section className="opening-composition">
      <div className="opening-copy"><div className="opening-kicker"><span className="signal-dot"/>For reporters and their trusted editors.</div>
        <h1>Stay present.<br/><em>Leave nothing</em><br/>to silence.</h1>
        <p>Keep your reporting notes private today. Arrange for a trusted editor to recover them if your check-ins stop and the recovery conditions are met.</p>
        <button className="canary-button primary" onClick={() => onNavigate('case')}>Try Maya &amp; Noor's story <ArrowUpRight size={20}/></button>
        <div className="opening-caption"><span>TRY IT</span> A fictional reporter, a real encryption workflow.</div>
      </div>
      <div className="opening-scene"><Suspense fallback={<div className="scene-loading">Assembling the archive…</div>}><LivingVault state={visual}/></Suspense></div>
    </section>
    <section className="overview-status" aria-label="Current simulated vault">
      <div><span className="section-label">YOUR DEMO VAULT</span><strong>{phaseLabels[visual.phase]}</strong><small>{activeVault.fileName}</small></div>
      <div><span className="section-label">NEXT CHECK-IN</span><strong>{visual.blocksRemaining}<small> blocks</small></strong><small>Measured at the confirmed cursor</small></div>
      <div><span className="section-label">RECOVERY THRESHOLD</span><strong>3<span className="muted"> / 5</span></strong><small>Valid, distinct keeper shares</small></div>
      <button className="round-action" onClick={() => onNavigate('sentinel')} aria-label="Open vault sentinel"><ArrowUpRight size={24}/></button>
    </section>
    <section className="protocol-editorial"><div className="editorial-heading"><span className="section-label">DESIGNED FOR CONTINUITY</span><h2>A deliberate path<br/>from <em>privacy to recovery.</em></h2><ArrowDown size={24}/></div>
      <div className="protocol-rows">
        <button onClick={() => onNavigate('create')}><span>01</span><Fingerprint/><div><h3>Encrypt for one person.</h3><p>A recipient layer protects the evidence. A separate release layer controls when it can be opened.</p></div><ArrowUpRight/></button>
        <button onClick={() => onNavigate('sentinel')}><span>02</span><Radio/><div><h3>Keep the signal alive.</h3><p>Signed check-ins extend the deadline. A grace window gives an overdue owner time to respond.</p></div><ArrowUpRight/></button>
        <button onClick={() => onNavigate('recipient')}><span>03</span><ShieldCheck/><div><h3>Recover with a threshold.</h3><p>Three permitted shares and the recipient’s key are required to recover the original evidence.</p></div><ArrowUpRight/></button>
      </div>
    </section>
    <section className="native-invitation"><span className="section-label">BEYOND THE SIMULATION</span><h2>The protocol,<br/>connected.</h2><div><p>The native workspace talks to your authenticated local Rust agent. It shows actual wallet, provisioning, command, and recipient state.</p><button className="text-link" onClick={() => onNavigate('native')}>Open native testnet <ArrowRight size={18}/></button></div></section>
    <details className="threat-disclosure"><summary>Understand the trust boundaries <span>+</span></summary><p>Three colluding keepers can release early to the designated recipient. Cancellation cannot recall delivered key material. Lightwallet servers can observe network metadata. Five local keeper processes are not five independent organizations. There is no smart contract: the protocol uses signed shielded Zcash memo commands and keeper policy evaluation.</p><p>The browser harness uses X25519 and AES-GCM in a demonstration format; native encryption uses age and XChaCha20-Poly1305. Do not use sensitive documents in the browser simulation.</p></details>
  </div>;
};
