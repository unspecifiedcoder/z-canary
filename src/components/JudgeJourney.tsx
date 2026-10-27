import React from 'react';
import { ArrowRight, Check, Circle, FastForward, KeyRound, RotateCcw, ShieldCheck } from 'lucide-react';
import type { ContinuityVault } from '../engine/protocolStore';
import './JudgeJourney.css';

type JourneyPage = 'create' | 'sentinel' | 'recipient' | 'evidence';

interface JudgeJourneyProps {
  vault: ContinuityVault;
  isCustomVault: boolean;
  onNavigate: (page: JourneyPage) => void;
  onConfirmRegistration: () => void;
  onCheckIn: () => void;
  onEnterGrace: () => void;
  onReleaseBelowThreshold: () => void;
  onRestoreThreshold: () => void;
  onReset: () => void;
}

export function JudgeJourney({ vault, isCustomVault, onNavigate, onConfirmRegistration, onCheckIn,
  onEnterGrace, onReleaseBelowThreshold, onRestoreThreshold, onReset }: JudgeJourneyProps) {
  if (!isCustomVault) return null;
  const states = new Set(vault.keepers.map(keeper => keeper.lifecycleState));
  const delivered = vault.deliveredSharesToRecipient.length;
  const threshold = vault.manifest.threshold;
  const registering = states.has('REGISTERING') || states.has('DRAFT');
  const grace = states.has('GRACE');
  const released = states.has('RELEASED');
  const checkedIn = vault.highestSequence > 0;
  const complete = vault.decryptedByRecipient;
  const step = registering ? 2 : complete ? 7 : delivered >= threshold ? 6 : released || delivered > 0 ? 5 : grace ? 4 : checkedIn ? 3 : 2;

  return <section className="judge-journey" aria-label="Create your own Canary walkthrough">
    <div className="judge-journey__intro">
      <span>YOUR CANARY / LIVE BROWSER WALKTHROUGH</span>
      <strong>{complete ? 'Recovery verified. You completed the handoff.' : 'Keep going—every button below executes the next protocol state.'}</strong>
      <small>Real local cryptography · simulated blocks and keeper records · no transaction sent</small>
    </div>
    <ol className="judge-journey__steps">
      {['Protect','Confirm','Check in','Miss','Threshold','Recipient','Verify'].map((label, index) => {
        const number = index + 1;
        return <li key={label} className={number < step ? 'done' : number === step ? 'current' : ''} aria-current={number === step ? 'step' : undefined}>
          {number < step ? <Check size={13}/> : <Circle size={11}/>}<span>{label}</span>
        </li>;
      })}
    </ol>
    <div className="judge-journey__action">
      {registering && <><p>Your encrypted package is ready. Confirm the simulated registration so all five keeper records become active.</p><button onClick={onConfirmRegistration}><ShieldCheck size={16}/>Confirm simulated registration</button></>}
      {!registering && !checkedIn && !grace && !released && !complete && <><p>First prove that the chosen recipient cannot recover early. Then return here and sign an “I’m okay” check-in.</p><button onClick={() => onNavigate('recipient')} className="quiet"><KeyRound size={16}/>Test early recovery</button><button onClick={onCheckIn}>Sign my check-in<ArrowRight size={16}/></button></>}
      {!registering && checkedIn && !grace && !released && !complete && <><p>The deadline moved and zero shares were released. Now intentionally miss the next check-in.</p><button onClick={onEnterGrace}><FastForward size={16}/>Miss next check-in</button></>}
      {grace && !released && !complete && <><p>Grace prevents an instant release. End it with only {Math.max(1, threshold - 1)} keepers available to prove that the threshold still blocks recovery.</p><button onClick={onReleaseBelowThreshold}><FastForward size={16}/>End grace below threshold</button></>}
      {(released || delivered > 0) && delivered < threshold && !complete && <><p>{delivered} of {threshold} valid shares arrived. Recovery is still blocked. Restore the next keeper to meet the policy.</p><button onClick={onRestoreThreshold}>Restore keeper {threshold}</button></>}
      {delivered >= threshold && !complete && <><p>The keeper threshold is met. Switch roles: the selected recipient must still supply the matching private key.</p><button onClick={() => onNavigate('recipient')}><KeyRound size={16}/>Continue as recipient</button></>}
      {complete && <><p>The downloaded bytes can now be checked against the original SHA-256 digest. Reset whenever you want to run another scenario.</p><button onClick={onReset}><RotateCcw size={16}/>Create another Canary</button><button onClick={() => onNavigate('evidence')} className="quiet">Inspect protocol evidence</button></>}
    </div>
  </section>;
}
