import React, { useMemo, useState } from 'react';
import { ArrowUpRight, Check, Copy, ExternalLink, FileCheck2, RadioTower, ShieldCheck, UsersRound } from 'lucide-react';
import { NATIVE_RUN_TRANSACTIONS, NATIVE_RUN_VAULTS, TRANSPORT_RECEIPTS } from '../evidence/recordedRun';
import { verifyReceiptHex } from '../evidence/verifyReceipt';
import { ReceiptVerifier } from './ReceiptVerifier';
import { RealRunReplay } from './RealRunReplay';
import './JudgeProof.css';

const repo = 'https://github.com/unspecifiedcoder/z-canary';
const evidenceRoot = `${repo}/blob/9759cd1/docs/evidence`;
const explorer = (txid: string) => `https://testnet.cipherscan.app/tx/${txid}`;
const labels: Record<string, string> = { release_register: 'Maya seals the release vault', cancel_register: 'Maya seals a second vault', cancel_postpone: 'Maya checks in', cancel_cancel: 'Maya cancels the second vault' };

export const JudgeProof: React.FC = () => {
  const verifiedMemos = useMemo(() => TRANSPORT_RECEIPTS.filter(receipt => verifyReceiptHex(receipt.memoHex).valid).length, []);
  const [copyStatus, setCopyStatus] = useState('');
  const copyDigest = async () => {
    try { await navigator.clipboard.writeText(NATIVE_RUN_VAULTS.release.recoveredDigestHex); setCopyStatus('SHA-256 copied.'); }
    catch { setCopyStatus('Select and copy the SHA-256 below.'); }
  };

  return <div className="judge-proof">
    <section className="judge-proof__hero" aria-labelledby="judge-proof-title">
      <div>
        <span className="judge-proof__eyebrow"><i /> CANARY / THE PROOF</span>
        <h1 id="judge-proof-title">If Maya goes silent,<br />her evidence can still reach Noor.</h1>
        <p className="judge-proof__lede">Maya is a journalist. Noor is her editor. Canary keeps Maya’s file encrypted while she checks in. After a missed deadline and grace period, three keepers’ shares plus Noor’s private key allow recovery.</p>
        <div className="judge-proof__actions"><a className="canary-button primary" href="#break-vault">Try to break the vault <ArrowUpRight size={17} /></a><a className="judge-proof__quiet-link" href="#create">Protect your own test file <ArrowUpRight size={15} /></a></div>
        <p className="judge-proof__mode-note">Interactive browser lab: real cryptography, simulated timing. Recorded native Zcash testnet evidence below.</p>
      </div>
      <aside className="judge-proof__verdict"><span>RECORDED NATIVE ACCEPTANCE</span><strong>Recovered.</strong><p>4 confirmed commands<br />5 keeper databases<br />136 original bytes recovered</p><a href={`${evidenceRoot}/native-live-acceptance.json`} target="_blank" rel="noreferrer">Read the acceptance record <ExternalLink size={13} /></a></aside>
    </section>

    <section className="judge-proof__outcomes" aria-label="Recorded outcomes and local verification">
      <article><span>01 / ZCASH TESTNET</span><strong>4</strong><p>commands in the recorded protected-document workflow</p></article>
      <article><span>02 / EXPIRED VAULT</span><strong>{NATIVE_RUN_VAULTS.release.shareCount}<small> shares</small></strong><p>delivered encrypted to the designated recipient</p></article>
      <article><span>03 / CANCELLED VAULT</span><strong>{NATIVE_RUN_VAULTS.cancel.shareCount}<small> shares</small></strong><p>released after the owner cancelled before delivery</p></article>
      <article><span>04 / VERIFY HERE</span><strong>{verifiedMemos}<small> / 3</small></strong><p>earlier transport memo signatures checked in this browser</p></article>
    </section>

    <section className="judge-proof__transactions" aria-labelledby="judge-transactions-title">
      <div className="judge-proof__section-heading"><div><span>FOUR TRANSACTIONS / TWO OUTCOMES</span><h2 id="judge-transactions-title">A release.<br />A cancellation.</h2></div><p>One vault expired and Noor recovered the file. The other received a check-in and then a cancellation, delivering zero shares. These links open the recorded transactions on a testnet explorer.</p></div>
      <ol>{NATIVE_RUN_TRANSACTIONS.map((tx, index) => <li key={tx.txid}><a href={explorer(tx.txid)} target="_blank" rel="noreferrer"><span>0{index + 1}</span><div><strong>{labels[tx.label] ?? tx.label}</strong><code>{tx.txid}</code></div><small>BLOCK {tx.blockHeight.toLocaleString()}</small><ExternalLink aria-hidden="true" /></a><a className="judge-proof__alternate-explorer" href={`https://zexplorer.app/testnet/tx/${tx.txid}`} target="_blank" rel="noreferrer" aria-label={`Open ${labels[tx.label] ?? tx.label} on alternate explorer Zexplorer`}>Alternate explorer · Zexplorer <ExternalLink size={12} aria-hidden="true" /></a></li>)}</ol>
      <p className="judge-proof__source-note">The explorer shows transaction inclusion, not the private memo or file. This page uses archived run records; it does not poll the chain for live confirmations.</p>
    </section>

    <section className="judge-proof__keepers" aria-labelledby="judge-keepers-title">
      <div className="judge-proof__section-heading"><div><span>FIVE DATABASES / ONE SIGNED CHECK-IN</span><h2 id="judge-keepers-title">Every keeper applied it.</h2></div><p>Recorded after POSTPONE, before cancellation. All five keeper databases advanced to sequence 1 and extended the deadline from 4,546,757 to 4,546,761.</p></div>
      <div className="judge-proof__keeper-list" role="list" aria-label="Keeper database snapshot on October 27, 2026">{[1, 2, 3, 4, 5].map(index => <article key={index} role="listitem"><span>KEEPER 0{index}</span><strong><Check size={16} />ACTIVE</strong><dl><div><dt>Sequence</dt><dd>1</dd></div><div><dt>Expiry block</dt><dd>4,546,761</dd></div></dl></article>)}</div>
      <div className="judge-proof__keeper-caption"><p>Snapshot: 27 Oct 2026, 07:15:57 UTC · Five processes operated on one machine.</p><a href={`${evidenceRoot}/live-postpone-databases.json`} target="_blank" rel="noreferrer">Inspect the five records <ExternalLink size={13} /></a></div>
      <p className="judge-proof__restart">A subsequent restart check preserved both outcomes: released vault at sequence 0, cancelled vault at sequence 2, with all five databases agreeing. <a href={`${evidenceRoot}/native-restart-audit.json`} target="_blank" rel="noreferrer">Read restart evidence ↗</a></p>
    </section>

    <section className="judge-proof__chain" aria-labelledby="judge-chain-title">
      <div className="judge-proof__section-heading"><div><span>WHAT EACH LAYER DEMONSTRATES</span><h2 id="judge-chain-title">Follow the evidence.</h2></div><p>Chain receipts, recorded outcomes and local cryptographic checks answer different questions. Together they make the implementation inspectable.</p></div>
      <div className="judge-proof__chain-grid">
        <article><RadioTower /><span>1</span><h3>Shielded commands</h3><p>The recorded native workflow submitted REGISTER, POSTPONE and CANCEL on Zcash testnet.</p><b><Check /> recorded testnet run</b></article>
        <article><UsersRound /><span>2</span><h3>Keeper agreement</h3><p>Five separate databases applied the signed check-in. Their recorded states agree on sequence and expiry.</p><b><Check /> database records</b></article>
        <article><ShieldCheck /><span>3</span><h3>Release guards</h3><p>Live cancellation delivered zero shares. The browser challenge lets you test two shares, the wrong key and delayed scans.</p><a href="#break-vault">Run the challenge <ArrowUpRight size={13} /></a></article>
        <article><FileCheck2 /><span>4</span><h3>Exact recovery</h3><p>The recorded native recipient recovered the 136-byte public fixture with the original SHA-256.</p><b><Check /> acceptance record</b></article>
      </div>
      <div className="judge-proof__digest"><span>RECOVERED FILE SHA-256</span><code>{NATIVE_RUN_VAULTS.release.recoveredDigestHex}</code><button type="button" onClick={copyDigest} aria-label="Copy recorded recovered file SHA-256"><Copy size={15} /> Copy</button></div><p className="judge-proof__copy-status" role="status">{copyStatus}</p>
    </section>

    <div className="judge-proof__verification-intro"><span>CHECK THE SIGNATURES YOURSELF</span><h2>Real checks in your browser.</h2><p>The three archived memos below belong to an earlier transport run using a public signing fixture. They are separate from the four protected-document transactions above. Signature verification checks authorship and integrity; it does not independently prove that these memo bytes were inside a particular shielded transaction.</p></div>
    <div className="judge-proof__live-tools"><RealRunReplay /><ReceiptVerifier /></div>

    <section className="judge-proof__reproduce" aria-labelledby="reproduce-title">
      <div><span>READ IT / RUN IT / CHALLENGE IT</span><h2 id="reproduce-title">The evidence is open.</h2></div>
      <p className="judge-proof__reproduce-description">Inspect the source and test runs, then try your own recovery scenario. No wallet or paid service is needed for the browser challenge.</p>
      <div className="judge-proof__resource-links"><a href="#break-vault">Try to break the vault <ArrowUpRight size={17} /></a><a href={`${repo}/actions/workflows/verification.yml`} target="_blank" rel="noreferrer">CI runs and test results <ExternalLink size={15} /></a><a href={`${evidenceRoot}/VERIFICATION.md`} target="_blank" rel="noreferrer">Recorded verification report <ExternalLink size={15} /></a><a href={`${repo}/tree/main/backend`} target="_blank" rel="noreferrer">Run the native implementation <ExternalLink size={15} /></a></div>
      <small>Testnet prototype. Keepers in the recorded run share one operator. The threshold assumes fewer than three keepers collude; delivery cannot be recalled after shares leave custody. Security tests are engineering evidence, not an independent audit.</small>
    </section>
  </div>;
};
