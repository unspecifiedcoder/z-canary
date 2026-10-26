import React, { useState } from 'react';
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

  // Determine aggregate consensus state from online keepers
  const onlineKeepers = vault.keepers.filter((k) => k.online);
  const primaryState = onlineKeepers[0]?.lifecycleState || vault.keepers[0]?.lifecycleState || 'ACTIVE';

  const blocksUntilExpiry = vault.currentExpiryHeight - currentBlockHeight;
  const blocksUntilGraceRelease = vault.graceDeadlineHeight - currentBlockHeight;
  const estimatedMinutesRemaining = Math.max(0, Math.round((blocksUntilExpiry * 75) / 60));

  const unconfirmedTxs = transactions.filter(
    (tx) =>
      tx.vaultId === vault.id &&
      tx.minedAtHeight !== null &&
      currentBlockHeight - tx.minedAtHeight + 1 < vault.manifest.confirmationTarget
  );

  const canAct = primaryState === 'ACTIVE' || primaryState === 'GRACE' || primaryState === 'REGISTERING';

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

      {/* First Viewport Focal Anchor: Answers the 3 Core Questions */}
      <section className="border border-[#222938] bg-[#141820] p-6 lg:p-8 space-y-8">
        <div className="flex flex-col lg:flex-row lg:items-start justify-between gap-6 border-b border-[#222938] pb-6">
          <div className="space-y-2">
            <div className="flex items-center gap-2 text-xs font-mono text-[#94A3B8]">
              <span>Switch ID: {vault.manifest.switchIdHex.slice(0, 16)}…</span>
              <span aria-hidden="true">·</span>
              <span>Sequence: #{vault.highestSequence}</span>
              <span aria-hidden="true">·</span>
              <span>Threshold: 3-of-5 Keepers</span>
            </div>
            <h1 className="text-2xl sm:text-3xl font-bold text-[#F8FAFC]">{vault.title}</h1>
            <p className="text-xs font-mono text-[#94A3B8]">
              Protected Artifact: {vault.fileName} · Package Digest: {vault.manifest.packageDigestHex.slice(0, 24)}…
            </p>
          </div>

          {/* Primary Action: Check In */}
          <div className="flex flex-wrap items-center gap-3 shrink-0">
            <button
              disabled={!canAct || walletBalanceZatoshi < 10000}
              onClick={() => onCheckIn(vault.manifest.initialIntervalBlocks)}
              className="px-6 py-3 bg-[#F59E0B] disabled:opacity-40 hover:bg-[#D97706] text-[#0B0D11] font-bold text-sm rounded transition-colors flex items-center gap-2 whitespace-nowrap cursor-pointer"
            >
              <RefreshCw className="w-4 h-4" />
              <span>Check In (+{vault.manifest.initialIntervalBlocks} Blocks)</span>
            </button>

            {canAct && (
              <button
                onClick={() => setShowCancelModal(true)}
                className="px-4 py-3 bg-[#0B0D11] hover:bg-[#1E2430] text-[#EF4444] border border-[#222938] font-medium text-xs rounded transition-colors whitespace-nowrap cursor-pointer"
              >
                Cancel Vault…
              </button>
            )}
          </div>
        </div>

        {/* 3 Core Questions Grid */}
        <div className="grid grid-cols-1 md:grid-cols-3 gap-6">
          {/* Question 1: Is this vault active? */}
          <div className="p-5 bg-[#0B0D11] border border-[#222938] space-y-2">
            <div className="text-xs font-mono text-[#64748B]">1. IS THIS VAULT ACTIVE?</div>
            <div className="flex items-center gap-2">
              {primaryState === 'ACTIVE' && (
                <span className="text-xl font-bold text-[#10B981]">ACTIVE & LOCKED</span>
              )}
              {primaryState === 'REGISTERING' && (
                <span className="text-xl font-bold text-[#F59E0B]">AWAITING CONFIRMATION</span>
              )}
              {primaryState === 'GRACE' && (
                <span className="text-xl font-bold text-[#F59E0B]">IN GRACE WINDOW</span>
              )}
              {primaryState === 'RELEASED' && (
                <span className="text-xl font-bold text-[#EF4444]">RELEASE AUTHORIZED</span>
              )}
              {primaryState === 'CANCELLED' && (
                <span className="text-xl font-bold text-[#94A3B8]">PERMANENTLY CANCELLED</span>
              )}
            </div>
            <p className="text-xs text-[#94A3B8] leading-relaxed">
              {primaryState === 'ACTIVE' &&
                `${onlineKeepers.length}/5 online Keepers are guarding shares. Outer Release Key remains split.`}
              {primaryState === 'REGISTERING' &&
                `Registration broadcast. Protection activates once confirmed by ${vault.manifest.confirmationTarget} blocks.`}
              {primaryState === 'GRACE' &&
                `Confirmed chain height reached expiry (#${vault.currentExpiryHeight}). Broadcast check-in before #${vault.graceDeadlineHeight} to abort release.`}
              {primaryState === 'RELEASED' &&
                `Grace deadline (#${vault.graceDeadlineHeight}) passed. ${vault.deliveredSharesToRecipient.length} of 5 Keeper shares delivered to Recipient Inbox.`}
              {primaryState === 'CANCELLED' &&
                'Signed CANCEL command confirmed. Unreleased Keeper shares have been permanently zeroized.'}
            </p>
          </div>

          {/* Question 2: When is the next confirmed-chain deadline? */}
          <div className="p-5 bg-[#0B0D11] border border-[#222938] space-y-2">
            <div className="text-xs font-mono text-[#64748B]">2. NEXT CONFIRMED-CHAIN DEADLINE</div>
            <div className="text-xl font-bold font-mono text-[#F8FAFC] tabular-nums">
              Block #{vault.currentExpiryHeight.toLocaleString()}
            </div>
            <div className="text-xs font-mono text-[#F59E0B] tabular-nums">
              {blocksUntilExpiry > 0
                ? `${blocksUntilExpiry} blocks remaining (~${estimatedMinutesRemaining} min est.)`
                : blocksUntilGraceRelease > 0
                ? `Expired · ${blocksUntilGraceRelease} Grace blocks left until #${vault.graceDeadlineHeight}`
                : `Grace boundary #${vault.graceDeadlineHeight} passed`}
            </div>
            <p className="text-xs text-[#64748B] font-mono">
              Current Scan Height: #{currentBlockHeight.toLocaleString()} · Grace: +{vault.manifest.graceBlocks} blocks
            </p>
          </div>

          {/* Question 3: What should I do next? */}
          <div className="p-5 bg-[#0B0D11] border border-[#222938] space-y-2">
            <div className="text-xs font-mono text-[#64748B]">3. RECOMMENDED NEXT ACTION</div>
            <div className="text-base font-semibold text-[#F8FAFC]">
              {primaryState === 'ACTIVE' && 'Broadcast periodic Check-In before expiry'}
              {primaryState === 'REGISTERING' && 'Wait for block confirmation'}
              {primaryState === 'GRACE' && 'URGENT: Broadcast Check-In immediately to prevent release'}
              {primaryState === 'RELEASED' && 'Switch to Recipient Inbox to reconstruct & decrypt'}
              {primaryState === 'CANCELLED' && 'No further action (Switch deactivated)'}
            </div>
            <p className="text-xs text-[#94A3B8] leading-relaxed">
              {canAct
                ? `Each Check-In signs sequence #${vault.highestSequence + 1} in a 512-byte shielded memo (Fee: 10,000 zatoshi).`
                : 'Terminal lifecycle state reached on confirmed chain.'}
            </p>
          </div>
        </div>

        {/* Custom Postponement Controls */}
        {canAct && (
          <div className="pt-2 border-t border-[#222938] flex flex-col sm:flex-row sm:items-center justify-between gap-4">
            <div className="text-xs text-[#94A3B8]">
              Need a custom postponement window? Specify block extension (Max:{' '}
              <span className="font-mono">{vault.manifest.maxExtensionBlocks}</span> blocks):
            </div>
            <div className="flex items-center gap-2">
              <input
                type="number"
                min={6}
                max={vault.manifest.maxExtensionBlocks}
                value={customExtension}
                onChange={(e) => setCustomExtension(Math.max(1, Number(e.target.value)))}
                className="w-28 px-3 py-1.5 bg-[#0B0D11] border border-[#222938] rounded font-mono text-xs text-[#F8FAFC] tabular-nums"
              />
              <button
                onClick={() => onCheckIn(customExtension)}
                className="px-3.5 py-1.5 bg-[#1E2430] hover:bg-[#283040] border border-[#2E3748] text-xs font-medium text-[#F8FAFC] rounded whitespace-nowrap cursor-pointer"
              >
                Postpone by +{customExtension} Blocks
              </button>
            </div>
          </div>
        )}
      </section>

      {/* Two-Column Split: Auditable Event Timeline & Keeper Committee Summary */}
      <div className="grid grid-cols-1 lg:grid-cols-12 gap-6">
        {/* Readable Event Timeline (7 cols) */}
        <section className="lg:col-span-7 border border-[#222938] bg-[#141820] p-6 space-y-5">
          <div className="flex items-center justify-between border-b border-[#222938] pb-4">
            <div>
              <h2 className="text-base font-semibold text-[#F8FAFC]">
                Verified Continuity Event Timeline
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
                3-of-5 Keeper Committee State
              </h2>
              <p className="text-xs text-[#94A3B8]">
                Five isolated local processes scanning Zcash Testnet blocks.
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
          <div className="max-w-md w-full border border-[#222938] bg-[#141820] p-6 space-y-5">
            <div className="space-y-2">
              <div className="text-xs font-mono text-[#EF4444]">IRREVOCABLE CANCELLATION COMMAND</div>
              <h3 className="text-lg font-bold text-[#F8FAFC]">
                Permanently cancel this continuity vault?
              </h3>
              <p className="text-xs text-[#94A3B8] leading-relaxed">
                Broadcasting a signed CANCEL (0x03) shielded memo instructs all 5 Keepers to transition
                this switch to the terminal <strong>CANCELLED</strong> state and purge queued release
                shares. A cancelled switch can never be reactivated.
              </p>
            </div>

            <div className="p-3 bg-[#0B0D11] border border-[#222938] font-mono text-xs text-[#CBD5E1] space-y-1">
              <div>Switch ID: {vault.manifest.switchIdHex.slice(0, 24)}…</div>
              <div>Next Sequence: #{vault.highestSequence + 1}</div>
              <div>Operation Code: 0x03 (CANCEL)</div>
            </div>

            <div className="flex items-center justify-end gap-3 pt-2">
              <button
                onClick={() => setShowCancelModal(false)}
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
                Sign & Broadcast Cancellation
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
};
