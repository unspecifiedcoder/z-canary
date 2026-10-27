import React, { lazy, Suspense } from 'react';
import { ArrowRight, ArrowUpRight, Fingerprint, Radio, ShieldCheck, Play, FileText, LockKeyhole } from 'lucide-react';
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
    <section className="canary-opening" aria-labelledby="opening-title">
      <div className="canary-opening-art" aria-hidden="true"><img src="./assets/canary-vault.webp" alt="" width="1672" height="941" fetchPriority="high" /></div>
      <div className="canary-opening-inner">
        <div className="canary-opening-copy">
          <p className="canary-eyebrow"><span/>FOR REPORTERS. FOR THE PERSON THEY TRUST.</p>
          <h1 id="opening-title">Keep your<br/>reporting private.<br/><em>Give it a way forward.</em></h1>
          <p className="canary-opening-description">Your editor should have a way to continue the work if you become unavailable. Canary prepares that handoff—while your check-ins keep recovery on hold.</p>
          <div className="canary-opening-actions">
            <button className="canary-button primary" onClick={() => onNavigate('case')}>Try the handoff <ArrowUpRight size={19}/></button>
            <a className="canary-watch-link" href="https://unspecifiedcoder.github.io/z-canary/#watch"><Play size={14}/> Watch the example <span>3:12</span></a>
          </div>
          <p className="canary-opening-note">A fictional file. Real local encryption. No wallet needed.</p>
        </div>
        <div className="canary-object-caption"><span>01 / THE SEALED DOSSIER</span><p>One file.<br/>One chosen recipient.</p><small>Illustration · explore the working example below</small></div>
      </div>
      <div className="canary-opening-baseline"><span>PRIVATE NOW. PREPARED FOR WHAT COMES NEXT.</span><a href="#handoff-story">The handoff, explained <ArrowRight size={14}/></a></div>
    </section>

    <section className="handoff-story" id="handoff-story" aria-labelledby="handoff-title">
      <div className="canary-section-shell">
        <div className="handoff-story-heading"><div><span className="canary-paper-label">A PLAN FOR THE WORK</span><h2 id="handoff-title">Maya has the story.<br/><em>Noor has her trust.</em></h2></div><p>Maya is a journalist. Noor is her editor. Sending the notes today is too early. Leaving the only usable copy with Maya is not a handoff plan.</p></div>
        <div className="handoff-illustration" aria-label="Maya's encrypted file can be recovered by Noor when the recovery conditions are met">
          <div className="handoff-person"><span className="handoff-person-initial">M</span><div><strong>Maya</strong><span>The reporter</span></div></div>
          <div className="handoff-connector"><span>Encrypted for Noor</span><i/></div>
          <div className="handoff-document"><FileText size={34}/><span>Reporting<br/>notes</span><LockKeyhole size={18}/></div>
          <div className="handoff-connector"><span>Conditional recovery</span><i/></div>
          <div className="handoff-person"><span className="handoff-person-initial">N</span><div><strong>Noor</strong><span>The chosen editor</span></div></div>
        </div>
        <div className="handoff-principles">
          <button onClick={() => onNavigate('create')}><span className="handoff-step">01 <Fingerprint size={20}/></span><h3>Choose who comes next.</h3><p>Encrypt a file for one recipient. A separate release layer keeps access on hold.</p><span className="handoff-principle-link">Create a vault <ArrowUpRight size={17}/></span></button>
          <button onClick={() => onNavigate('sentinel')}><span className="handoff-step">02 <Radio size={20}/></span><h3>Keep the plan on hold.</h3><p>A signed check-in extends the deadline. Cancel before release if your plans change.</p><span className="handoff-principle-link">Open Vault Sentinel <ArrowUpRight size={17}/></span></button>
          <button onClick={() => onNavigate('recipient')}><span className="handoff-step">03 <ShieldCheck size={20}/></span><h3>Leave a way forward.</h3><p>After the deadline and grace window, recovery needs three valid shares and the recipient’s key.</p><span className="handoff-principle-link">Open Recipient Inbox <ArrowUpRight size={17}/></span></button>
        </div>
        <div className="handoff-story-bottom"><p>See what happens when Maya checks in, misses a deadline, changes her mind, or a keeper goes offline.</p><button className="canary-button ink" onClick={() => onNavigate('case')}>Run Maya &amp; Noor’s example <ArrowRight size={18}/></button></div>
      </div>
    </section>

    <section className="canary-observatory" aria-labelledby="observatory-title">
      <div className="canary-section-shell">
        <div className="canary-observatory-top"><div><span className="canary-eyebrow">THE WORKING VAULT / BROWSER SIMULATION</span><h2 id="observatory-title">A promise, with<br/><em>rules you can inspect.</em></h2><p>Explore the two encryption layers and the five keeper records. This is the current state of your separate browser demo vault.</p><button className="text-link" onClick={() => onNavigate('demo')}>Explore the protocol tour <ArrowUpRight size={17}/></button></div><div className="canary-observatory-scene"><Suspense fallback={<div className="scene-loading">Assembling the vault schematic…</div>}><LivingVault state={visual}/></Suspense></div></div>
        <div className="overview-status" aria-label="Current simulated vault">
          <div><span className="section-label">CURRENT PROTECTION</span><strong>{phaseLabels[visual.phase]}</strong><small>{activeVault.fileName}</small></div>
          <div><span className="section-label">NEXT CHECK-IN</span><strong>{visual.blocksRemaining}<small> blocks</small></strong><small>Measured at the confirmed cursor</small></div>
          <div><span className="section-label">VALID SHARES REQUIRED</span><strong>3<span className="muted"> / 5</span></strong><small>The recipient’s key is still required</small></div>
          <button className="round-action" onClick={() => onNavigate('sentinel')} aria-label="Open vault sentinel"><ArrowUpRight size={24}/></button>
        </div>
      </div>
    </section>

    <section className="canary-native-proof" aria-labelledby="native-proof-title">
      <div className="canary-section-shell">
        <div className="native-proof-copy"><span className="canary-paper-label">BEYOND THE BROWSER</span><h2 id="native-proof-title">The testnet record<br/>is open to inspection.</h2><p>The native path completed shielded registration, check-in, cancellation and exact-file recovery on Zcash testnet. The recorded receipts are separate from Maya’s fictional example.</p></div>
        <div className="native-proof-numbers"><div><strong>4</strong><span>Confirmed commands</span></div><div><strong>136<span>B</span></strong><span>Recovered, byte for byte</span></div><div><strong>3<span>/5</span></strong><span>Recovery threshold</span></div></div>
        <div className="native-proof-actions"><button className="canary-button ink" onClick={() => onNavigate('evidence')}>Inspect the evidence <ArrowUpRight size={18}/></button><button className="canary-paper-link" onClick={() => onNavigate('native')}>Connect a local native agent <ArrowRight size={17}/></button></div>
        <details className="threat-disclosure"><summary>Know the trust boundaries <span>+</span></summary><p>Five native keeper processes currently share one operator and scanner. Three colluding keepers can release early to the designated recipient. Cancellation cannot recall delivered shares. Network observers and lightwallet operators can learn metadata. No smart contract is deployed.</p><p>The browser uses X25519 and AES-GCM in a demonstration format; native encryption uses age and XChaCha20-Poly1305. This is a tested prototype, not an audited tool for sensitive reporting. Use public fictional files.</p></details>
      </div>
    </section>
  </div>;
};
