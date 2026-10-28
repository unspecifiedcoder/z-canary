import React from 'react';
import { ArrowUpRight, Plus, Radio } from 'lucide-react';
import { ContinuityVault, ShieldedSupportTransaction } from '../engine/protocolStore';

interface SupportScreenProps {
  vault: ContinuityVault;
  walletBalanceZatoshi: number;
  supportHistory: ShieldedSupportTransaction[];
  onReceiveSupportDonation: (amountZatoshi: number) => void;
  onExecuteFundedCheckIn: () => void;
}

export const SupportScreen: React.FC<SupportScreenProps> = ({ walletBalanceZatoshi, supportHistory, onReceiveSupportDonation, onExecuteFundedCheckIn, vault }) => <div>
  <div className="product-heading"><div><h1>Keep the next<br/>signal possible.</h1><p>Support funds check-in fees. It does not change the release threshold or grant access to the evidence.</p></div><Radio size={44} strokeWidth={.7} color="#a4e8d8"/></div>
  <div className="support-layout">
    <section className="support-ledger"><span className="section-label">Simulated wallet balance</span><div className="support-balance">{walletBalanceZatoshi.toLocaleString()} <small>zat</small></div><p>{Math.floor(walletBalanceZatoshi/10000)} simulated check-ins at an assumed 10,000 zat fee. Actual transaction fees come from the native wallet.</p><button className="canary-button primary" onClick={()=>onReceiveSupportDonation(500000)}><Plus size={17}/>Simulate support receipt</button><br/><button className="canary-button quiet" disabled={walletBalanceZatoshi<10000||!vault.keepers.some(k=>k.online&&k.scannerHealth==='HEALTHY'&&['ACTIVE','GRACE'].includes(k.lifecycleState))} onClick={onExecuteFundedCheckIn}>Use balance for a demo check-in <ArrowUpRight size={16}/></button><div className="support-boundary"><h2>No payment request in simulation</h2><p>This view never sends funds. Open Native testnet for the real wallet’s separate shielded address and payment request.</p></div></section>
    <section className="support-ledger"><span className="section-label">Local receipt ledger</span><p style={{marginTop:18}}>Generated receipt references are browser fixtures. They are not blockchain transaction IDs.</p><div style={{marginTop:25}}>{supportHistory.length===0?<p>No simulated receipts.</p>:supportHistory.map(item=><div key={item.id} className="receipt-row"><span>{item.id}</span><strong>+{item.amountZatoshi.toLocaleString()} zat</strong></div>)}</div><div className="support-boundary"><h2>The threshold stays separate</h2><p>{vault.keepers.filter(k=>k.online&&k.scannerHealth==='HEALTHY').length} of 5 keeper records are healthy. Recovery still needs 3 valid shares, the recipient key, and permitted release conditions.</p></div></section>
  </div>
</div>;
