import React, { useMemo, useState } from 'react';
import { ArrowRight, Check, FileText, LockKeyhole, RotateCcw, Download, ShieldCheck, X, Clock3 } from 'lucide-react';
import { actOnCaseStudy, createCaseStudy, downloadCaseStudy, CASE_FILENAME, type CaseAction, type CaseStep } from '../experience/caseStudy';
import { downloadBytes } from '../services/nativeVault';
import './CaseStudyDemo.css';

const chapters: Record<CaseStep, { role: string; number: string; title: string; copy: string }> = {
  intro: { role: 'MAYA / REPORTER', number: '01', title: 'Her reporting should not depend on her being reachable.', copy: 'Maya wants to keep her draft private now, but let her editor Noor recover it if her check-ins stop.' },
  protected: { role: 'MAYA / REPORTER', number: '02', title: 'File protected. Noor cannot open it yet.', copy: 'The evidence has been encrypted for Noor and wrapped in a separate release layer.' },
  'early-blocked': { role: 'NOOR / EDITOR', number: '03', title: '“Can I open it now?” Not yet.', copy: 'A real recovery attempt was rejected. Being the designated recipient is not enough before release.' },
  'checked-in': { role: 'MAYA / REPORTER', number: '04', title: '“I’m here.” The deadline moves forward.', copy: 'The keepers verified Maya’s signed check-in. Nothing was delivered to Noor.' },
  cancelled: { role: 'MAYA / REPORTER', number: '05', title: 'Changed plans? Cancel before release.', copy: 'Maya’s signed cancellation stops future share delivery. The old deadline has already passed in this branch.' },
  grace: { role: 'MAYA / OVERDUE', number: '06', title: 'A missed check-in is not an instant release.', copy: 'Maya still has a grace window to check in. Noor has no shares yet.' },
  'scan-paused': { role: 'KEEPERS / SAFETY CHECK', number: '07', title: 'No fresh chain view. No release.', copy: 'Grace has ended, but the keepers cannot safely rule out a check-in. They wait.' },
  insufficient: { role: 'NOOR / WAITING', number: '08', title: 'Two shares are not enough.', copy: 'Two keepers are back online. Their shares are valid, but the recovery threshold is three.' },
  ready: { role: 'KEEPERS / THRESHOLD MET', number: '09', title: 'The third keeper makes recovery possible.', copy: 'Three distinct shares are available. Noor still needs her own private identity to decrypt.' },
  'wrong-key': { role: 'RECIPIENT / IDENTITY CHECK', number: '10', title: 'The wrong recipient still cannot open it.', copy: 'A different private key was tried and rejected—even with three valid shares.' },
  recovered: { role: 'NOOR / VERIFIED RECOVERY', number: '11', title: 'Noor can continue the reporting.', copy: 'The original file was decrypted and its integrity verified. Maya’s handoff plan worked in this example.' },
};
const actions: Partial<Record<CaseStep, [CaseAction, string]>> = {
  intro: ['protect', 'Protect Maya’s file'], protected: ['try-early', 'Try Noor’s inbox early'],
  'early-blocked': ['check-in', 'Maya checks in'], 'checked-in': ['miss-check-in', 'Miss the next check-in'],
  grace: ['pause-scans', 'Let grace end with stale scans'], 'scan-paused': ['resume-two', 'Bring two keepers online'],
  insufficient: ['restore-third', 'Restore keeper 3'], ready: ['recover', 'Noor decrypts the file'],
  'wrong-key': ['recover', 'Noor decrypts the file'],
};
export default function CaseStudyDemo() {
  const [scenario, setScenario] = useState(createCaseStudy);
  const [error, setError] = useState<string | null>(null);
  const { step, vault } = scenario;
  const chapter = chapters[step];
  const count = vault?.deliveredSharesToRecipient.length ?? 0;
  const expected = vault?.manifest.threshold ?? 3;
  const action = actions[step];
  const act = (next: CaseAction) => {
    try { setScenario(actOnCaseStudy(scenario, next)); setError(null); }
    catch { setError('This protocol transition could not be verified. Reset the example to try again.'); }
  };
  const reset = () => { setScenario(createCaseStudy()); setError(null); };
  const restartMissed = () => {
    const protectedCase = actOnCaseStudy(createCaseStudy(), 'protect');
    setScenario(actOnCaseStudy(protectedCase, 'check-in')); setError(null);
  };
  const recovered = useMemo(() => {
    if (!scenario.verified) return '';
    const bytes = downloadCaseStudy(scenario);
    try { return new TextDecoder().decode(bytes); } finally { bytes.fill(0); }
  }, [scenario]);
  const format = (value?: number | null) => value == null ? '—' : `#${value.toLocaleString()}`;
  const keeperPhase = ['scan-paused', 'insufficient', 'ready', 'wrong-key'].includes(step);
  const roleIndex = ['intro', 'protected', 'checked-in', 'cancelled', 'grace'].includes(step) ? 0 : keeperPhase ? 1 : 2;
  return <section className="case-demo" aria-label="Maya and Noor interactive example">
    <header className="case-context"><div><span className="case-kicker">ONE FILE. ONE TRUSTED PERSON. A PLAN FOR ABSENCE.</span><p><b>Maya</b>, reporter <ArrowRight size={17}/> <b>Noor</b>, editor <span>Fictional example</span></p></div><button className="case-reset" onClick={reset}><RotateCcw size={16}/>Reset example</button></header>
    <div className="case-roles" aria-label="Example participants">{['01 / Owner’s decision', '02 / Recovery conditions', '03 / Recipient’s outcome'].map((role, i) => <span key={role} className={roleIndex === i ? 'active' : ''}>{role}</span>)}</div>
    <div className="case-heading"><div><span className="case-kicker">{chapter.role}</span><h1>{chapter.title}</h1><p>{chapter.copy}</p></div><span className="case-number">{chapter.number}</span></div>
    <div className={`case-stage case-stage-${step}`} key={step}>
      {step === 'intro' && <div className="case-intro-grid"><article className="case-paper"><span className="case-paper-label"><FileText size={19}/> MAYA’S PUBLIC DEMO FILE</span><h2>Rivergate reporting notes</h2><p>Interview checklist<br/>Meeting date<br/>Questions to verify</p><span className="case-footnote">Harmless fictional community-garden report.<br/>No real sources or private evidence.</span></article><div className="case-recipient"><div className="case-person">N</div><div><span className="case-kicker">DESIGNATED RECIPIENT</span><h2>Noor, her editor</h2><p>Keep the draft private while Maya checks in.<br/>Make recovery possible if she stops.</p></div><div className="case-policy"><span><b>24</b> block check-in interval</span><span><b>6</b> block grace window</span><span><b>3 of 5</b> keeper shares required</span></div></div></div>}
      {(step === 'protected' || step === 'early-blocked') && vault && <div className="case-locked-grid"><div className="case-cipher"><span className="case-kicker"><LockKeyhole size={18}/> ENCRYPTED PACKAGE</span><h2>{vault.encryptedPackage.encryptedSize} <small>encrypted bytes</small></h2><code>{vault.encryptedPackage.outerCiphertextBase64.slice(0, 125)}…</code><p>{CASE_FILENAME}</p><div className="case-seal-line"><Check size={18}/> Encrypted locally <Check size={18}/> 5 keepers provisioned</div></div><div className={`case-inbox ${step === 'early-blocked' ? 'blocked' : ''}`}><span className="case-kicker">NOOR’S INBOX</span><div className="case-count">{count}<small> / {expected}</small></div><h2>{step === 'early-blocked' ? 'Recovery rejected' : 'Waiting for release'}</h2><p>{step === 'early-blocked' ? 'The threshold check ran. Zero shares cannot reconstruct the release key.' : 'Noor’s identity protects the inner layer. Keepers have not released the outer key.'}</p></div></div>}
      {step === 'checked-in' && vault && <div className="case-renewal"><div className="case-deadlines"><div><span>PREVIOUS DEADLINE</span><strong>{format(scenario.previousExpiry)}</strong></div><ArrowRight size={50}/><div className="renewed"><span>NEW DEADLINE</span><strong>{format(vault.currentExpiryHeight)}</strong></div></div><div className="case-renewal-proof"><span><ShieldCheck size={24}/> Signed check-in verified</span><span><b>5 / 5</b> keepers updated</span><span><b>0</b> shares delivered</span></div><p>Same encrypted file. More time for Maya. Noor’s inbox stays locked.</p></div>}
      {step === 'cancelled' && vault && <div className="case-cancel-result"><div><span className="case-result-icon"><X size={36}/></span><span className="case-kicker">SIGNED CANCELLATION ACCEPTED</span><h2>Cancelled</h2><p>All five keepers remain cancelled after<br/>the old grace boundary.</p></div><div className="case-cancel-count"><strong>{count}</strong><span>shares released</span><p>Cancellation cannot recall shares<br/>that were already delivered.</p></div></div>}
      {step === 'grace' && vault && <div className="case-grace"><div className="case-grace-stats"><div><span>MAYA MISSED</span><strong>{format(vault.currentExpiryHeight)}</strong><p>Expiry reached</p></div><Clock3 size={58}/><div><span>SHE STILL HAS</span><strong>{vault.manifest.graceBlocks} <small>blocks</small></strong><p>Check in by {format(vault.graceDeadlineHeight)}</p></div><div className="case-grace-noor"><span>NOOR HAS</span><strong>{count} / {expected}</strong><p>Recovery remains blocked</p></div></div><div className="case-timebar"><span>Owner check-in deadline</span><b>GRACE WINDOW</b><span>Inclusive release boundary</span></div></div>}
      {keeperPhase && vault && <div className="case-keeper-view"><div className="case-keeper-list" aria-label="Simulated keeper state">{vault.keepers.map(k => <div key={k.id} className={`case-keeper-row ${k.outboxDelivered ? 'delivered' : ''}`}><span className="case-keeper-index">0{k.index}</span><b>Keeper {k.index}</b><span>{!k.online ? 'Offline' : k.scannerHealth !== 'HEALTHY' ? 'Scan stale' : 'Scan current'}</span><strong>{k.outboxDelivered ? 'Share delivered ✓' : 'No share released'}</strong></div>)}</div><div className={`case-threshold-result ${step === 'ready' ? 'ready' : ''}`}><span className="case-kicker">NOOR’S VALID SHARES</span><div className="case-count">{count}<small> / {expected}</small></div><h2>{step === 'scan-paused' ? 'Release paused' : step === 'insufficient' ? 'Recovery rejected' : step === 'wrong-key' ? 'Wrong key rejected' : 'Threshold reached'}</h2><p>{step === 'scan-paused' ? 'Time passed. A stale scan is still not permission.' : step === 'insufficient' ? 'The actual reconstruction attempt needs one more distinct share.' : step === 'wrong-key' ? 'Only Noor’s matching private identity can open the inner layer.' : 'Two keepers are offline. Noor can proceed with three valid shares and her key.'}</p></div></div>}
      {step === 'recovered' && vault && <div className="case-recovered-grid"><article className="case-recovered-file"><span className="case-paper-label"><FileText size={19}/> DECRYPTED BY NOOR</span><pre>{recovered}</pre></article><div className="case-integrity"><ShieldCheck size={46}/><h2>Original file.<br/>Exact match.</h2><div><span className="case-kicker">VERIFIED SIZE</span><strong>{vault.encryptedPackage.originalSize} bytes</strong></div><div><span className="case-kicker">SHA-256 MATCH</span><code>{vault.encryptedPackage.plaintextDigestHex}</code></div></div></div>}
    </div>
    <div className="case-actions">
      {action && <button className="case-primary" onClick={() => act(action[0])}>{action[1]}<ArrowRight size={20}/></button>}
      {step === 'checked-in' && <button className="case-secondary" onClick={() => act('cancel')}>Or cancel this vault</button>}
      {step === 'grace' && <button className="case-secondary" onClick={() => act('check-in')}>Maya checks in during grace</button>}
      {step === 'ready' && <button className="case-secondary" onClick={() => act('try-wrong-key')}>Try a different recipient key</button>}
      {step === 'cancelled' && <><button className="case-primary" onClick={restartMissed}>Start the missed-check-in example<ArrowRight size={20}/></button><span className="case-restart-note">A fresh vault, not an undo.</span></>}
      {step === 'recovered' && <><button className="case-primary" onClick={() => { try { const bytes = downloadCaseStudy(scenario); downloadBytes(CASE_FILENAME, bytes); bytes.fill(0); } catch { setError('The file could not be verified again. Nothing was downloaded.'); } }}><Download size={18}/>Download Noor’s verified file</button><button className="case-secondary" onClick={reset}>Run the example again</button></>}
    </div>
    <div className="case-receipt" role="status"><Check size={18}/><span>{scenario.receipt}</span></div>
    {error && <p className="case-error" role="alert">{error}</p>}
    <p className="case-disclosure"><b>BROWSER SIMULATION</b> · Real local encryption, signatures and decryption. Simulated blocks and keepers; no transactions sent. Public fictional file only. Prototype, not an audited tool for sensitive reporting.</p>
  </section>;
}
