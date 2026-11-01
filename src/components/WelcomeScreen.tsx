import React from 'react';
import { ArrowRight, ArrowUpRight, Check, LockKeyhole } from 'lucide-react';
import { ContinuityVault } from '../engine/protocolStore';
import { phaseLabels, projectVault } from '../experience/model';

type Tab = 'welcome' | 'sentinel' | 'create' | 'recipient' | 'support' | 'evidence' | 'native' | 'demo' | 'case' | 'break' | 'judge';

interface WelcomeScreenProps {
  activeVault: ContinuityVault;
  currentBlockHeight: number;
  onNavigate: (tab: Tab) => void;
  onQuickDemoStep: (step: 'inspect' | 'checkin' | 'grace' | 'expire' | 'support' | 'tests') => void;
  onToggleKeeperOnline: (keeperIndex: number) => void;
}

const art = (name: string) => `./assets/press/${name}.webp`;

export const WelcomeScreen: React.FC<WelcomeScreenProps> = ({ activeVault, currentBlockHeight, onNavigate }) => {
  const visual = projectVault(activeVault, currentBlockHeight);
  const healthy = activeVault.keepers.filter(k => k.online && k.scannerHealth === 'HEALTHY').length;
  const link = (tab: Tab) => (event: React.MouseEvent) => { event.preventDefault(); onNavigate(tab); };

  return <div className="overview">
    <section className="hero" aria-labelledby="hero-title">
      <div className="hero-copy">
        <span className="kicker"><span className="tag">Zcash</span>Safety handoff for reporters</span>
        <h1 id="hero-title" className="display">Evidence should not leak. <mark>Or disappear with you.</mark></h1>
        <p className="lede">Put a file in a locked box. Press &ldquo;I&rsquo;m okay&rdquo; to keep it locked. If you stop checking in, keepers each hand over one piece of the key, and only the person you chose can open it.</p>
        <div className="hero-actions">
          <button className="btn btn-dark" onClick={() => onNavigate('break')}>Try the 60-second challenge<span className="btn-orb"><ArrowUpRight size={18}/></span></button>
          <a className="btn btn-ghost" href="#create" onClick={link('create')}>Protect your own file <ArrowRight size={16}/></a>
        </div>
        <ul className="hero-proof" aria-label="Recorded Zcash testnet proof">
          <li><b>7</b><span>real testnet transactions</span></li>
          <li><b>7</b><span>memos you can re-verify</span></li>
          <li><b>136&nbsp;B</b><span>recovered byte for byte</span></li>
        </ul>
      </div>

      <div className="hero-stage" aria-hidden="true">
        <div className="hero-halo"/>
        <img src={art('hero')} alt="" width="1024" height="1024" fetchPriority="high"/>
      </div>

      <div className="hero-widgets">
        <div className="widget widget-status">
          <span className="widget-icon"><LockKeyhole size={18}/></span>
          <div><span className="label">Browser lab vault</span><strong>{phaseLabels[visual.phase]}</strong></div>
        </div>
        <ul className="widget-list" aria-label="What protects the file">
          <li className="on">Encrypted in your browser</li>
          <li className="on">Signed &ldquo;I&rsquo;m okay&rdquo; check-ins</li>
          <li className="on">{healthy} of 5 keepers watching</li>
          <li>Recipient key still required</li>
        </ul>
        <div className="widget widget-number">
          <div><span className="label">Next check-in due</span><small>at the confirmed block</small></div>
          <strong>{visual.blocksRemaining}<small> blocks</small></strong>
        </div>
        <p className="hero-tagline display-3">Private today.<br/>Recoverable if you go silent.</p>
      </div>
    </section>

    <div className="proof-rail" aria-label="Commands recorded on Zcash testnet">
      <span className="label">Recorded on Zcash testnet</span>
      {['Register', 'Check in', 'Cancel', 'Recover'].map(item => <a key={item} href="#judge" onClick={link('judge')}><Check size={14}/>{item}</a>)}
    </div>

    <section className="bento" aria-labelledby="problem-title">
      <article className="card bento-problem">
        <span className="kicker">The problem · Maya is investigating corruption</span>
        <h2 id="problem-title" className="display-2">Share now, risk exposure. <mark>Keep it alone, risk losing it.</mark></h2>
        <p className="lede">Canary gives Maya a third choice. Her evidence stays encrypted while she checks in. If she becomes unreachable, her editor Noor gets a controlled recovery path, not automatic access.</p>
        <div className="handoff" aria-label="Maya encrypts for Noor; recovery is conditional">
          <div className="person"><span>M</span><div><b>Maya</b><small>Reporter</small></div></div>
          <i/>
          <span className="chip"><LockKeyhole size={13}/>Encrypted for Noor</span>
          <i/>
          <div className="person"><span>N</span><div><b>Noor</b><small>Chosen editor</small></div></div>
        </div>
      </article>
      <article className="card-yellow bento-sealed" aria-label="A sealed reporting file">
        <div className="sealed-doc">
          <span className="label">Maya → Noor</span>
          <div className="sealed-lines" aria-hidden="true"><i/><i/><i/><i/><i/><i/></div>
          <div className="tape" aria-hidden="true"><span>Sealed until silence ·</span><span>Sealed until silence ·</span><span>Sealed until silence ·</span></div>
          <strong className="display-3">Rivergate notes</strong>
        </div>
        <p className="mono-copy">Fictional file. Real encryption in your browser.</p>
      </article>

      {[
        { img: 'icon-seal', n: '01', title: 'Lock it now.', copy: 'Choose who may recover it. The file is encrypted locally before the handoff begins.', cta: 'Create your own Canary', tab: 'create' as Tab },
        { img: 'icon-pulse', n: '02', title: 'Keep saying “I’m okay.”', copy: 'Each signed check-in moves the deadline. While check-ins continue, recovery stays blocked.', cta: 'See the owner view', tab: 'sentinel' as Tab },
        { img: 'icon-folder', n: '03', title: 'If silence continues, recover.', copy: 'After the deadline and grace window, three keepers and the chosen person’s key are still required.', cta: 'See the recipient view', tab: 'recipient' as Tab },
      ].map(step => <button key={step.n} className="card bento-step" onClick={() => onNavigate(step.tab)}>
        <img src={art(step.img)} alt="" width="512" height="512" loading="lazy"/>
        <span className="label">{step.n}</span>
        <h3 className="display-3">{step.title}</h3>
        <p>{step.copy}</p>
        <span className="step-link">{step.cta}<ArrowUpRight size={16}/></span>
      </button>)}

      <article className="card bento-zcash" aria-labelledby="zcash-title">
        <div className="zcash-copy">
          <span className="kicker">Why Zcash belongs here</span>
          <h2 id="zcash-title" className="display-2">Private check-ins. <mark>Verifiable recovery.</mark></h2>
          <p className="lede">Canary carries signed check-ins in Zcash shielded transactions, keeping their contents off the public chain. The evidence file stays off-chain.</p>
          <div className="zcash-stats">
            <div><strong>4</strong><span>commands in the protected-document run</span></div>
            <div><strong>136<small>B</small></strong><span>recovered, byte for byte</span></div>
            <div><strong>3<small>/5</small></strong><span>keeper threshold</span></div>
          </div>
          <div className="hero-actions">
            <button className="btn btn-dark" onClick={() => onNavigate('judge')}>Open Judge Proof<span className="btn-orb"><ArrowUpRight size={18}/></span></button>
            <button className="btn btn-light" onClick={() => onNavigate('native')}>Connect a local native agent</button>
          </div>
        </div>
        <img className="zcash-art" src={art('keepers')} alt="" width="1536" height="1024" loading="lazy"/>
      </article>

      <details className="card bento-limits">
        <summary><span className="display-3">What this does not protect against</span><span className="chip">Read</span></summary>
        <div>
          <p>Five native keeper processes currently share one operator and scanner. Three colluding keepers can release early to the designated recipient. Cancellation cannot recall delivered shares. Network observers and lightwallet operators can learn metadata. No smart contract is deployed.</p>
          <p>The browser uses X25519 and AES-GCM in a demonstration format; native encryption uses age and XChaCha20-Poly1305. This is a tested prototype, not an audited tool for sensitive reporting. Use public fictional files.</p>
        </div>
      </details>
    </section>

    <section className="card closing" aria-labelledby="closing-title">
      <img src={art('vault')} alt="" width="1024" height="1024" loading="lazy"/>
      <h2 id="closing-title" className="display-2">Try to <mark>break the vault</mark></h2>
      <p className="mono-copy">Two keepers. The wrong key. A stale chain view. A cancelled handoff.<br/>Four ways in. None of them should work.</p>
      <button className="btn btn-yellow" onClick={() => onNavigate('break')}>Start the challenge <ArrowRight size={17}/></button>
    </section>
  </div>;
};
