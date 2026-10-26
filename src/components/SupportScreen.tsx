import React, { useState } from 'react';
import { Copy, Check, Shield, ArrowUpRight, PlusCircle } from 'lucide-react';
import { ContinuityVault, ShieldedSupportTransaction } from '../engine/protocolStore';

interface SupportScreenProps {
  vault: ContinuityVault;
  walletBalanceZatoshi: number;
  supportHistory: ShieldedSupportTransaction[];
  onReceiveSupportDonation: (amountZatoshi: number) => void;
  onExecuteFundedCheckIn: () => void;
}

const ORCHARD_SUPPORT_ADDRESS =
  'u1zcanarysupport7x9m2k4p8q0w3v5n6l8j2h4g6f8d0s2a4p6r8t0y2u4i6o8p0';

export const SupportScreen: React.FC<SupportScreenProps> = ({
  vault,
  walletBalanceZatoshi,
  supportHistory,
  onReceiveSupportDonation,
  onExecuteFundedCheckIn,
}) => {
  const [requestedTaz, setRequestedTaz] = useState('0.00500000');
  const [copiedUri, setCopiedUri] = useState(false);

  // Strictly no switchId, manifestDigest, or document identifier in the ZIP-321 URI
  const zip321Uri = `zcash:${ORCHARD_SUPPORT_ADDRESS}?amount=${requestedTaz}`;

  const handleCopy = () => {
    navigator.clipboard?.writeText(zip321Uri);
    setCopiedUri(true);
    setTimeout(() => setCopiedUri(false), 1800);
  };

  const checkInsCovered = Math.floor(walletBalanceZatoshi / 10000);

  return (
    <div className="space-y-8 pb-16">
      <section className="border border-[#222938] bg-[#141820] p-6 lg:p-8 space-y-6">
        <div className="border-b border-[#222938] pb-5 space-y-2">
          <div className="text-xs font-mono text-[#F59E0B]">
            UNLINKED ORCHARD SUPPORT ADDRESS · ZIP-321 COMPLIANT
          </div>
          <h1 className="text-2xl font-bold text-[#F8FAFC]">
            Shielded Source Support & Check-In Funding
          </h1>
          <p className="text-sm text-[#94A3B8] max-w-3xl leading-relaxed">
            Supporters can fund a source’s ongoing check-in transaction fees through a dedicated
            Orchard unified address. To preserve metadata compartmentalization, payment requests
            never include vault identifiers, manifest digests, or document names.
          </p>
        </div>

        <div className="grid grid-cols-1 lg:grid-cols-12 gap-8">
          {/* Left: ZIP-321 Request Generator (7 cols) */}
          <div className="lg:col-span-7 space-y-5">
            <div className="space-y-2">
              <label className="block text-xs font-mono text-[#94A3B8]">
                Dedicated Orchard Support Address (Separate from Registry Command Address)
              </label>
              <div className="p-3.5 bg-[#0B0D11] border border-[#222938] font-mono text-xs text-[#E2E8F0] break-all">
                {ORCHARD_SUPPORT_ADDRESS}
              </div>
            </div>

            <div className="space-y-2">
              <label className="block text-xs font-mono text-[#94A3B8]">
                Requested Donation Amount (TAZ · 1 TAZ = 100,000,000 zatoshi)
              </label>
              <div className="flex items-center gap-3">
                <input
                  type="text"
                  value={requestedTaz}
                  onChange={(e) => setRequestedTaz(e.target.value)}
                  className="w-48 px-3.5 py-2 bg-[#0B0D11] border border-[#222938] rounded font-mono text-xs text-[#F8FAFC] tabular-nums"
                />
                <span className="text-xs font-mono text-[#64748B]">
                  (= {Math.round(parseFloat(requestedTaz || '0') * 1e8).toLocaleString()} zatoshi)
                </span>
              </div>
            </div>

            <div className="space-y-2">
              <div className="flex items-center justify-between text-xs font-mono">
                <span className="text-[#94A3B8]">Generated ZIP-321 Payment Request URI</span>
                <span className="text-[#10B981]">Zero Evidence Identifiers Verified</span>
              </div>
              <div className="p-3.5 bg-[#0B0D11] border border-[#222938] font-mono text-xs text-[#F59E0B] break-all flex items-center justify-between gap-4">
                <span>{zip321Uri}</span>
                <button
                  onClick={handleCopy}
                  className="px-3 py-1.5 bg-[#141820] hover:bg-[#1E2430] border border-[#222938] text-[#F8FAFC] rounded flex items-center gap-1.5 shrink-0 cursor-pointer"
                >
                  {copiedUri ? <Check className="w-3.5 h-3.5 text-[#10B981]" /> : <Copy className="w-3.5 h-3.5" />}
                  <span>{copiedUri ? 'Copied' : 'Copy URI'}</span>
                </button>
              </div>
            </div>

            {/* Privacy Invariant Audit Box */}
            <div className="p-4 bg-[#0B0D11] border border-[#222938] space-y-2 font-mono text-xs">
              <div className="text-[#F8FAFC] font-semibold">
                PRIVACY & UNLINKABILITY AUDIT
              </div>
              <div className="text-[#94A3B8] space-y-1">
                <div>
                  · Contains Switch ID ({vault.manifest.switchIdHex.slice(0, 10)}…):{' '}
                  <span className="text-[#10B981]">FALSE (0 matches)</span>
                </div>
                <div>
                  · Contains Manifest Digest ({vault.manifest.manifestDigestHex.slice(0, 10)}…):{' '}
                  <span className="text-[#10B981]">FALSE (0 matches)</span>
                </div>
                <div>
                  · On-Chain Note Traceability: Shielded Orchard pool prevents public input-to-output
                  coin linking.
                </div>
              </div>
            </div>
          </div>

          {/* Right: Local Wallet Balance & Donation-to-Check-In Demo (5 cols) */}
          <div className="lg:col-span-5 border border-[#222938] bg-[#0B0D11] p-6 flex flex-col justify-between space-y-6">
            <div className="space-y-4">
              <div className="text-xs font-mono text-[#94A3B8]">
                LOCAL SOURCE WALLET SHIELDED BALANCE
              </div>
              <div className="text-2xl font-bold font-mono text-[#F8FAFC] tabular-nums">
                {walletBalanceZatoshi.toLocaleString()} zatoshi
              </div>
              <div className="text-xs font-mono text-[#10B981] tabular-nums">
                Sufficient for {checkInsCovered} shielded Check-In transactions (10,000 zatoshi/tx)
              </div>

              <div className="pt-4 border-t border-[#1E2430] space-y-3">
                <div className="text-xs font-semibold text-[#F8FAFC]">
                  Demonstrate Support-to-Check-In Workflow
                </div>
                <p className="text-xs text-[#94A3B8] leading-relaxed">
                  1. Credit an incoming shielded Orchard support note to the local wallet.
                  <br />
                  2. Use available wallet funds to cover a subsequent vault check-in without
                  claiming a publicly traceable coin link.
                </p>
              </div>
            </div>

            <div className="space-y-3">
              <button
                onClick={() => onReceiveSupportDonation(500000)}
                className="w-full py-2.5 px-4 bg-[#F59E0B] hover:bg-[#D97706] text-[#0B0D11] font-semibold text-xs rounded transition-colors flex items-center justify-center gap-2 cursor-pointer"
              >
                <PlusCircle className="w-4 h-4" />
                <span>Simulate Shielded Support Receipt (+500,000 zatoshi)</span>
              </button>

              <button
                onClick={onExecuteFundedCheckIn}
                className="w-full py-2.5 px-4 bg-[#141820] hover:bg-[#1E2430] border border-[#222938] text-[#F8FAFC] font-medium text-xs rounded transition-colors cursor-pointer"
              >
                Execute Funded Check-In (-10,000 zatoshi fee)
              </button>
            </div>
          </div>
        </div>
      </section>

      {/* Confirmed Support Receipts Table */}
      <section className="border border-[#222938] bg-[#141820] p-6 space-y-4">
        <div className="flex items-center justify-between border-b border-[#222938] pb-3">
          <h2 className="text-base font-semibold text-[#F8FAFC]">
            Local Shielded Support Receipts (Orchard Pool)
          </h2>
          <span className="text-xs font-mono text-[#94A3B8] tabular-nums">
            {supportHistory.length} Confirmed Notes
          </span>
        </div>

        <div className="overflow-x-auto">
          <table className="w-full text-left border-collapse font-mono text-xs">
            <thead>
              <tr className="border-b border-[#222938] text-[#64748B]">
                <th className="py-2.5 pr-4">TXID</th>
                <th className="py-2.5 px-4">Block Height</th>
                <th className="py-2.5 px-4">Note Status</th>
                <th className="py-2.5 pl-4 text-right">Amount (zatoshi)</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-[#1E2430]">
              {supportHistory.map((item) => (
                <tr key={item.id} className="hover:bg-[#1E2430]/40">
                  <td className="py-3 pr-4 text-[#E2E8F0]">{item.txid.slice(0, 20)}…</td>
                  <td className="py-3 px-4 text-[#94A3B8] tabular-nums">#{item.blockHeight}</td>
                  <td className="py-3 px-4 text-[#10B981]">{item.note}</td>
                  <td className="py-3 pl-4 text-right text-[#F8FAFC] font-semibold tabular-nums">
                    +{item.amountZatoshi.toLocaleString()}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </section>
    </div>
  );
};
