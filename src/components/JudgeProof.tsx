import React, { useMemo, useState } from 'react';
import { ArrowUpRight, Check, Copy, ExternalLink, FileCheck2, RadioTower, ShieldCheck, UsersRound } from 'lucide-react';
import { NATIVE_RUN_TRANSACTIONS, NATIVE_RUN_VAULTS } from '../evidence/recordedRun';
import { NATIVE_MEMO_RECEIPTS } from '../evidence/nativeMemos';
import { verifyReceiptHex } from '../evidence/verifyReceipt';
import { ReceiptVerifier } from './ReceiptVerifier';
import { RealRunReplay } from './RealRunReplay';

const repo = 'https://github.com/unspecifiedcoder/z-canary';
const evidenceRoot = `${repo}/blob/9759cd1/docs/evidence`;
const explorer = (txid: string) => `https://testnet.cipherscan.app/tx/${txid}`;
const labels: Record<string, string> = { release_register: 'Maya seals the release vault', cancel_register: 'Maya seals a second vault', cancel_postpone: 'Maya checks in', cancel_cancel: 'Maya cancels the second vault' };

export const JudgeProof: React.FC = () => {
  const verifiedMemos = useMemo(() => NATIVE_MEMO_RECEIPTS.filter(receipt => verifyReceiptHex(receipt.memoHex).valid).length, []);
  const [copyStatus, setCopyStatus] = useState('');
  const copyDigest = async () => {
    try { await navigator.clipboard.writeText(NATIVE_RUN_VAULTS.release.recoveredDigestHex); setCopyStatus('SHA-256 copied.'); }
    catch { setCopyStatus('Select and copy the SHA-256 below.'); }
  };

  return <div className="proof">
    <section className="proof-hero" aria-labelledby="judge-proof-title">
      <div className="card proof-hero-copy">
        <span className="kicker"><span className="tag">Proof</span>Recorded on Zcash testnet</span>
        <h1 id="judge-proof-title" className="display">If Maya goes silent, <mark>Noor can still recover it.</mark></h1>
        <p className="lede">Canary keeps Maya&rsquo;s file encrypted while she checks in. After a missed deadline and grace period, three keepers&rsquo; shares plus Noor&rsquo;s private key allow recovery.</p>
        <div className="hero-actions"><a className="btn btn-dark" href="#break-vault">Try to break the vault<span className="btn-orb"><ArrowUpRight size={18}/></span></a><a className="btn btn-ghost" href="#create">Protect your own test file <ArrowUpRight size={16}/></a></div>
        <p className="scope-note">Interactive browser lab: real cryptography, simulated timing. Recorded native Zcash testnet evidence below.</p>
      </div>
      <aside className="card-yellow proof-verdict">
        <img src="./assets/press/icon-folder.webp" alt="" width="512" height="512"/>
        <span className="label">Recorded native acceptance</span>
        <strong className="verdict-word">Recovered.</strong>
        <ul><li><b>4</b> confirmed commands</li><li><b>5</b> keeper databases</li><li><b>136</b> original bytes recovered</li></ul>
        <a className="btn btn-dark btn-sm" href={`${evidenceRoot}/native-live-acceptance.json`} target="_blank" rel="noreferrer">Read the acceptance record <ExternalLink size={14}/></a>
      </aside>
    </section>

    <section className="proof-stats" aria-label="Recorded outcomes and local verification">
      <article className="card"><span className="label">Zcash testnet</span><strong>4</strong><p>commands in the recorded protected-document workflow</p></article>
      <article className="card"><span className="label">Expired vault</span><strong>{NATIVE_RUN_VAULTS.release.shareCount}<small>shares</small></strong><p>delivered encrypted to the designated recipient</p></article>
      <article className="card"><span className="label">Cancelled vault</span><strong>{NATIVE_RUN_VAULTS.cancel.shareCount}<small>shares</small></strong><p>released after the owner cancelled before delivery</p></article>
      <article className="card"><span className="label">Verify here</span><strong>{verifiedMemos}<small>/ 4</small></strong><p>command signatures checked in this browser</p></article>
    </section>

    <section className="card proof-section" aria-labelledby="judge-transactions-title">
      <div className="section-head"><div><span className="kicker">Four transactions · two outcomes</span><h2 id="judge-transactions-title" className="display-2">A release. <mark>A cancellation.</mark></h2></div><p className="lede">One vault expired and Noor recovered the file. The other received a check-in and then a cancellation, delivering zero shares.</p></div>
      <ol className="tx-list">{NATIVE_RUN_TRANSACTIONS.map((tx, index) => <li key={tx.txid}>
        <span className="tx-n">0{index + 1}</span>
        <div className="tx-main"><b>{labels[tx.label] ?? tx.label}</b><code>{tx.txid}</code></div>
        <span className="chip">Block {tx.blockHeight.toLocaleString()}</span>
        <div className="tx-links"><a className="btn btn-light btn-sm" href={explorer(tx.txid)} target="_blank" rel="noreferrer">CipherScan <ExternalLink size={13} aria-hidden="true"/></a><a className="btn btn-ghost btn-sm" href={`https://zexplorer.app/testnet/tx/${tx.txid}`} target="_blank" rel="noreferrer" aria-label={`Open ${labels[tx.label] ?? tx.label} on alternate explorer Zexplorer`}>Zexplorer <ExternalLink size={13} aria-hidden="true"/></a></div>
      </li>)}</ol>
      <p className="scope-note">The explorer shows transaction inclusion, not the private memo or file. This page uses archived run records; it does not poll the chain for live confirmations.</p>
    </section>

    <section className="card proof-section" aria-labelledby="judge-keepers-title">
      <div className="section-head"><div><span className="kicker">Five databases · one signed check-in</span><h2 id="judge-keepers-title" className="display-2">Every keeper <mark>applied it.</mark></h2></div><p className="lede">Recorded after POSTPONE, before cancellation. All five keeper databases advanced to sequence 1 and extended the deadline from 4,546,757 to 4,546,761.</p></div>
      <div className="keeper-grid" role="list" aria-label="Keeper database snapshot on October 27, 2026">{[1, 2, 3, 4, 5].map(index => <article key={index} role="listitem"><span className="label">Keeper 0{index}</span><strong><Check size={16}/>Active</strong><dl><div><dt>Sequence</dt><dd>1</dd></div><div><dt>Expiry block</dt><dd>4,546,761</dd></div></dl></article>)}</div>
      <div className="proof-foot"><p>Snapshot: 27 Oct 2026, 07:15:57 UTC · Five processes operated on one machine. A later restart check preserved both outcomes, with all five databases agreeing.</p><div className="hero-actions"><a className="btn btn-light btn-sm" href={`${evidenceRoot}/live-postpone-databases.json`} target="_blank" rel="noreferrer">Inspect the five records <ExternalLink size={13}/></a><a className="btn btn-ghost btn-sm" href={`${evidenceRoot}/native-restart-audit.json`} target="_blank" rel="noreferrer">Restart evidence <ExternalLink size={13}/></a></div></div>
    </section>

    <section className="proof-layers" aria-labelledby="judge-chain-title">
      <div className="section-head"><div><span className="kicker">What each layer demonstrates</span><h2 id="judge-chain-title" className="display-2">Follow <mark>the evidence.</mark></h2></div><p className="lede">Chain receipts, recorded outcomes and local cryptographic checks answer different questions. Together they make the implementation inspectable.</p></div>
      <div className="layer-grid">
        <article className="card"><span className="layer-icon"><RadioTower size={20}/></span><span className="label">01</span><h3 className="display-3">Shielded commands</h3><p>The recorded native workflow submitted REGISTER, POSTPONE and CANCEL on Zcash testnet.</p><span className="chip"><Check size={13}/>Recorded testnet run</span></article>
        <article className="card"><span className="layer-icon"><UsersRound size={20}/></span><span className="label">02</span><h3 className="display-3">Keeper agreement</h3><p>Five separate databases applied the signed check-in. Their recorded states agree on sequence and expiry.</p><span className="chip"><Check size={13}/>Database records</span></article>
        <article className="card"><span className="layer-icon"><ShieldCheck size={20}/></span><span className="label">03</span><h3 className="display-3">Release guards</h3><p>Live cancellation delivered zero shares. The browser challenge tests two shares, the wrong key and delayed scans.</p><a className="chip" href="#break-vault">Run the challenge <ArrowUpRight size={13}/></a></article>
        <article className="card"><span className="layer-icon"><FileCheck2 size={20}/></span><span className="label">04</span><h3 className="display-3">Exact recovery</h3><p>The recorded native recipient recovered the 136-byte public fixture with the original SHA-256.</p><span className="chip"><Check size={13}/>Acceptance record</span></article>
      </div>
      <div className="digest proof-digest"><span className="label">Recovered file SHA-256</span><code>{NATIVE_RUN_VAULTS.release.recoveredDigestHex}</code><button type="button" className="btn btn-yellow btn-sm" onClick={copyDigest} aria-label="Copy recorded recovered file SHA-256"><Copy size={14}/>Copy</button></div>
      <p className="scope-note" role="status">{copyStatus}</p>
    </section>

    <section className="proof-verify" aria-labelledby="verify-title">
      <div className="section-head"><div><span className="kicker">Check the signatures yourself</span><h2 id="verify-title" className="display-2">The original commands. <mark>Verified here.</mark></h2></div><p className="lede">A fresh viewing-only scan recovered all four protected-document memos. Your browser now checks all four signatures, plus three earlier transport receipts. Signature checks prove authorship and integrity; the archived scanner record supplies transaction association.</p></div>
      <div className="verify-grid"><RealRunReplay /><ReceiptVerifier /></div>
    </section>

    <section className="card-dark proof-open" aria-labelledby="reproduce-title">
      <div><span className="label">Read it · run it · challenge it</span><h2 id="reproduce-title" className="display-2">The evidence <mark>is open.</mark></h2><p>Inspect the source and test runs, then try your own recovery scenario. No wallet or paid service is needed for the browser challenge.</p></div>
      <div className="open-links"><a href="#break-vault">Try to break the vault <ArrowUpRight size={17}/></a><a href={`${repo}/actions/workflows/verification.yml`} target="_blank" rel="noreferrer">CI runs and test results <ExternalLink size={15}/></a><a href={`${evidenceRoot}/VERIFICATION.md`} target="_blank" rel="noreferrer">Recorded verification report <ExternalLink size={15}/></a><a href={`${repo}/tree/main/backend`} target="_blank" rel="noreferrer">Run the native implementation <ExternalLink size={15}/></a></div>
      <small>Testnet prototype. Keepers in the recorded run share one operator. The threshold assumes fewer than three keepers collude; delivery cannot be recalled after shares leave custody. Security tests are engineering evidence, not an independent audit.</small>
    </section>
  </div>;
};
