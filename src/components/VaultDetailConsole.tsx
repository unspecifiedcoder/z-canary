import React, { useEffect, useRef, useState } from 'react';
import {
  Shield,
  Clock,
  RefreshCw,
  AlertTriangle,
  XCircle,
  CheckCircle2,
  ArrowUpRight,
  Lock,
  Activity,
} from 'lucide-react';
import { ChainTransaction, ContinuityVault } from '../engine/protocolStore';
import { phaseLabels, projectVault } from '../experience/model';

interface VaultDetailConsoleProps {
  vault: ContinuityVault;
  currentBlockHeight: number;
  walletBalanceZatoshi: number;
  transactions: ChainTransaction[];
  onCheckIn: (additionalBlocks: number) => void;
  onCancelVault: () => void;
  onMineBlocks: (count: number) => void;
  onInspectMemo: (txid: string) => void;
}

export const VaultDetailConsole: React.FC<VaultDetailConsoleProps> = ({
  vault,
  currentBlockHeight,
  walletBalanceZatoshi,
  transactions,
  onCheckIn,
  onCancelVault,
  onMineBlocks,
  onInspectMemo,
}) => {
  const [customExtension, setCustomExtension] = useState(vault.manifest.initialIntervalBlocks);
  const [showCancelModal, setShowCancelModal] = useState(false);
  const cancelTriggerRef = useRef<HTMLButtonElement>(null);
  const cancelDialogRef = useRef<HTMLDivElement>(null);
  const keepActiveRef = useRef<HTMLButtonElement>(null);
  const closeCancelDialog = () => {
    setShowCancelModal(false);
    cancelTriggerRef.current?.focus();
  };

  useEffect(() => {
    if (!showCancelModal) return;
    keepActiveRef.current?.focus();

    const handleDialogKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        event.preventDefault();
        closeCancelDialog();
        return;
      }
      if (event.key !== 'Tab' || !cancelDialogRef.current) return;
      const controls = Array.from(
        cancelDialogRef.current.querySelectorAll<HTMLElement>(
          'button:not([disabled]), [href], input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])'
        )
      );
      if (controls.length === 0) return;
      const first = controls[0];
      const last = controls[controls.length - 1];
      if (event.shiftKey && document.activeElement === first) {
        event.preventDefault();
        last.focus();
      } else if (!event.shiftKey && document.activeElement === last) {
        event.preventDefault();
        first.focus();
      }
    };
    document.addEventListener('keydown', handleDialogKeyDown);
    return () => document.removeEventListener('keydown', handleDialogKeyDown);
  }, [showCancelModal]);

  // Determine aggregate consensus state from online keepers
  const onlineKeepers = vault.keepers.filter((k) => k.online);
  const primaryState = onlineKeepers[0]?.lifecycleState || vault.keepers[0]?.lifecycleState || 'ACTIVE';

  const confirmedHeight = Math.max(0, currentBlockHeight - vault.manifest.confirmationTarget + 1);
  const blocksUntilExpiry = vault.currentExpiryHeight - confirmedHeight;
  const blocksUntilGraceRelease = vault.graceDeadlineHeight - confirmedHeight;
  const estimatedMinutesRemaining = Math.max(0, Math.round((blocksUntilExpiry * 75) / 60));

  const unconfirmedTxs = transactions.filter(
    (tx) =>
      tx.vaultId === vault.id &&
      tx.minedAtHeight !== null &&
      currentBlockHeight - tx.minedAtHeight + 1 < vault.manifest.confirmationTarget
  );

  const visual = projectVault(vault, currentBlockHeight);
  const canAct = (primaryState === 'ACTIVE' || primaryState === 'GRACE') && visual.phase !== 'suspended';
  const remainingRatio = Math.min(1, Math.max(0, blocksUntilExpiry / vault.manifest.initialIntervalBlocks));

  return (
    <div className="space-y-8 pb-16">
      {/* Unconfirmed Transaction Banner */}
      {unconfirmedTxs.length > 0 && (
        <div className="border border-[#F59E0B]/50 bg-[#141820] p-4 flex flex-col sm:flex-row sm:items-center justify-between gap-4">
          <div className="space-y-1">
            <div className="text-xs font-mono text-[#F59E0B]">
              AWAITING CHAIN CONFIRMATION ({currentBlockHeight - unconfirmedTxs[0].minedAtHeight! + 1}/
              {vault.manifest.confirmationTarget} BLOCKS)
            </div>
            <p className="text-xs text-[#E2E8F0]">
              Shielded command tx <span className="font-mono">{unconfirmedTxs[0].txid.slice(0, 16)}…</span> is mined
              at height #{unconfirmedTxs[0].minedAtHeight}. Keepers require {vault.manifest.confirmationTarget}{' '}
              confirmations before updating state.
            </p>
          </div>
          <button
            onClick={() => onMineBlocks(vault.manifest.confirmationTarget)}
            className="px-3.5 py-2 bg-[#F59E0B] hover:bg-[#D97706] text-[#0B0D11] text-xs font-semibold rounded whitespace-nowrap shrink-0 cursor-pointer"
          >
            Mine +{vault.manifest.confirmationTarget} Confirmation Blocks
          </button>
        </div>
      )}

      <section className="sentinel-primary">
        <div className="product-heading"><div><span className="section-label">SOURCE / VAULT SENTINEL</span><h1>Your signal keeps<br/>the archive sealed.</h1><p>{vault.fileName}</p></div><span className="section-label">SIMULATED VAULT / {vault.manifest.switchIdHex.slice(0,8)}</span></div>
        <div className="sentinel-instrument">
          <div className="deadline-dial" role="img" aria-label={`${Math.max(0,blocksUntilExpiry)} confirmed blocks until expiry`}>
            <svg viewBox="0 0 260 260" aria-hidden="true"><circle cx="130" cy="130" r="116" fill="none" stroke="#273b33" strokeWidth="1"/><circle cx="130" cy="130" r="104" fill="none" stroke="#20342b" strokeWidth="4"/><circle cx="130" cy="130" r="104" fill="none" stroke={visual.phase==='grace'?'#e7bc79':'#a4e8d8'} strokeWidth="4" strokeDasharray="653.45" strokeDashoffset={653.45*(1-remainingRatio)} style={{transition:'stroke-dashoffset 1s cubic-bezier(.16,1,.3,1)'}}/><circle cx="130" cy="130" r="87" fill="none" stroke="#274030" strokeWidth="1" strokeDasharray="1 8"/></svg>
            <div><strong>{Math.max(0,blocksUntilExpiry)}</strong><span>BLOCKS TO EXPIRY</span></div>
          </div>
          <div className="sentinel-status"><span className="section-label">CURRENT PROTECTION STATE</span><h2>{phaseLabels[visual.phase]}</h2><p>{visual.phase==='sealed'?'The recipient layer remains encrypted. Your next signed check-in extends the release deadline.':visual.phase==='grace'?'Your check-in is overdue. A valid command must be included by the inclusive grace boundary to prevent release.':visual.phase==='released'?`The release condition was evaluated. The recipient still needs ${vault.manifest.threshold} valid shares and their private key to recover the evidence.`:visual.phase==='suspended'?'Keeper states are unavailable or disagree. Inspect keeper health before relying on protection status.':visual.phase==='cancelled'?'This simulated vault is cancelled. Shares already delivered cannot be recalled.':'Confirm the registration before relying on this vault.'}</p>
            <div className="sentinel-meta"><span>EXPIRY #{vault.currentExpiryHeight.toLocaleString()}</span><span>GRACE +{vault.manifest.graceBlocks} BLOCKS</span><span>SEQUENCE {vault.highestSequence}</span></div>
            <button className="canary-button primary" disabled={!canAct||walletBalanceZatoshi<10000} onClick={()=>onCheckIn(vault.manifest.initialIntervalBlocks)}><RefreshCw size={16}/>Check in · +{vault.manifest.initialIntervalBlocks} blocks</button>
            <p style={{fontSize:10,marginTop:12}}>Simulated command · assumed fee 10,000 zat · no network transaction</p>
          </div>
        </div>
        {canAct&&<div className="sentinel-custom"><label htmlFor="extension-blocks">Choose a custom extension</label><input id="extension-blocks" type="number" min={1} max={vault.manifest.maxExtensionBlocks} value={customExtension} onChange={event=>setCustomExtension(Number(event.target.value))}/><button className="canary-button outline" onClick={()=>onCheckIn(customExtension)}>Postpone</button><button ref={cancelTriggerRef} className="canary-button quiet" onClick={()=>setShowCancelModal(true)}>Cancel simulated vault…</button></div>}
      </section>

      {/* Two-Column Split: Auditable Event Timeline & Keeper Committee Summary */}
      <div className="grid grid-cols-1 lg:grid-cols-12 gap-6">
        {/* Readable Event Timeline (7 cols) */}
        <section className="lg:col-span-7 border border-[#222938] bg-[#141820] p-6 space-y-5">
          <div className="flex items-center justify-between border-b border-[#222938] pb-4">
            <div>
              <h2 className="text-base font-semibold text-[#F8FAFC]">
                Simulated Continuity Event Timeline
              </h2>
              <p className="text-xs text-[#94A3B8]">
                Local source audit log (never published on unauthenticated public pages).
              </p>
            </div>
            <span className="text-xs font-mono text-[#94A3B8] tabular-nums">
              {vault.timeline.length} Events
            </span>
          </div>

          <div className="divide-y divide-[#1E2430]">
            {vault.timeline.map((ev, index) => (
              <div key={ev.id} className="py-3.5 first:pt-0 last:pb-0 flex items-start justify-between gap-4">
                <div className="space-y-1">
                  <div className="flex items-center gap-2 text-xs font-mono">
                    <span className="text-[#F59E0B]">0{index + 1}.</span>
                    <span className="font-semibold text-[#F8FAFC]">{ev.title}</span>
                    <span className="text-[#64748B]">·</span>
                    <span className="text-[#94A3B8] tabular-nums">Block #{ev.blockHeight}</span>
                  </div>
                  <p className="text-xs text-[#94A3B8] leading-relaxed">{ev.detail}</p>
                  {ev.txid && (
                    <button
                      onClick={() => onInspectMemo(ev.txid!)}
                      className="text-[11px] font-mono text-[#F59E0B] hover:underline flex items-center gap-1 pt-0.5 cursor-pointer"
                    >
                      <span>Inspect 512B Memo (tx: {ev.txid.slice(0, 14)}…)</span>
                      <ArrowUpRight className="w-3 h-3" />
                    </button>
                  )}
                </div>
                <span className="text-[11px] font-mono text-[#64748B] whitespace-nowrap shrink-0 tabular-nums">
                  {ev.timestamp.slice(11, 19)}
                </span>
              </div>
            ))}
          </div>
        </section>

        {/* 5-Keeper Committee Consensus Status (5 cols) */}
        <section className="lg:col-span-5 border border-[#222938] bg-[#141820] p-6 space-y-5">
          <div className="flex items-center justify-between border-b border-[#222938] pb-4">
            <div>
              <h2 className="text-base font-semibold text-[#F8FAFC]">
                {vault.manifest.threshold}-of-5 Keeper Committee State
              </h2>
              <p className="text-xs text-[#94A3B8]">
                Five in-memory keeper records processing simulated blocks.
              </p>
            </div>
            <span className="text-xs font-mono text-[#10B981]">Epoch #{vault.manifest.configurationEpoch}</span>
          </div>

          <div className="divide-y divide-[#1E2430] font-mono text-xs">
            {vault.keepers.map((k) => (
              <div key={k.id} className="py-3 first:pt-0 last:pb-0 space-y-1">
                <div className="flex items-center justify-between">
                  <span className="text-[#F8FAFC] font-medium">{k.name}</span>
                  <span
                    className={
                      !k.online
                        ? 'text-[#EF4444]'
                        : k.lifecycleState === 'ACTIVE'
                        ? 'text-[#10B981]'
                        : k.lifecycleState === 'GRACE'
                        ? 'text-[#F59E0B]'
                        : k.lifecycleState === 'RELEASED'
                        ? 'text-[#F59E0B]'
                        : 'text-[#94A3B8]'
                    }
                  >
                    {!k.online ? 'OFFLINE' : k.lifecycleState}
                  </span>
                </div>
                <div className="flex items-center justify-between text-[11px] text-[#64748B] tabular-nums">
                  <span>
                    Cursor: #{k.scanCursorHeight} · Seq: {k.lastSequence !== null ? k.lastSequence.toString() : '-'}
                  </span>
                  <span>
                    {k.outboxDelivered ? 'Share Dispatched' : `Expiry #${k.expiryHeight}`}
                  </span>
                </div>
              </div>
            ))}
          </div>

          <div className="p-3.5 bg-[#0B0D11] border border-[#222938] text-xs text-[#94A3B8] space-y-1">
            <div className="font-mono text-[#F8FAFC]">Delivery Policy Invariant</div>
            <p className="leading-relaxed">
              Keepers release only after scanning through block #{vault.graceDeadlineHeight} with
              healthy chain continuity.
            </p>
          </div>
        </section>
      </div>

      {/* Deliberate Cancellation Confirmation Modal */}
      {showCancelModal && (
        <div className="fixed inset-0 z-50 bg-black/80 flex items-center justify-center p-4">
          <div ref={cancelDialogRef} role="dialog" aria-modal="true" aria-labelledby="cancel-dialog-title" aria-describedby="cancel-dialog-description" className="max-w-md w-full border border-[#222938] bg-[#141820] p-6 space-y-5">
            <div className="space-y-2">
              <div className="text-xs font-mono text-[#EF4444]">SIMULATED CANCELLATION</div>
              <h3 id="cancel-dialog-title" className="text-lg font-bold text-[#F8FAFC]">
                Mark this simulated vault cancelled?
              </h3>
              <p id="cancel-dialog-description" className="text-xs text-[#94A3B8] leading-relaxed">
                This browser demo changes local simulated state only. It does not broadcast a Zcash
                transaction or erase keeper keys or shares. Shares already delivered or copied cannot
                be recalled. Reset the demo to start again.
              </p>
            </div>

            <div className="p-3 bg-[#0B0D11] border border-[#222938] font-mono text-xs text-[#CBD5E1] space-y-1">
              <div>Switch ID: {vault.manifest.switchIdHex.slice(0, 24)}…</div>
              <div>Next Sequence: #{vault.highestSequence + 1}</div>
              <div>Operation Code: 0x03 (CANCEL)</div>
            </div>

            <div className="flex items-center justify-end gap-3 pt-2">
              <button
                ref={keepActiveRef}
                onClick={closeCancelDialog}
                className="px-4 py-2 text-xs font-medium text-[#94A3B8] hover:text-[#F8FAFC] border border-[#222938] rounded cursor-pointer"
              >
                Keep Vault Active
              </button>
              <button
                onClick={() => {
                  setShowCancelModal(false);
                  onCancelVault();
                }}
                className="px-4 py-2 bg-[#EF4444] hover:bg-[#DC2626] text-white text-xs font-semibold rounded cursor-pointer"
              >
                Simulate Cancellation
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
};
