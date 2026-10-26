import React, { useState } from 'react';
import {
  Shield,
  Lock,
  KeyRound,
  ArrowRight,
  AlertTriangle,
  BookOpen,
  RefreshCw,
  Unlock,
  CheckCircle2,
} from 'lucide-react';
import { ContinuityVault } from '../engine/protocolStore';
import { Vault3DVisualizer } from './Vault3DVisualizer';

interface WelcomeScreenProps {
  activeVault: ContinuityVault;
  currentBlockHeight: number;
  onNavigate: (tab: 'welcome' | 'sentinel' | 'create' | 'recipient' | 'support' | 'evidence') => void;
  onQuickDemoStep: (step: 'inspect' | 'checkin' | 'grace' | 'expire' | 'support' | 'tests') => void;
  onToggleKeeperOnline: (keeperIndex: number) => void;
}

export const WelcomeScreen: React.FC<WelcomeScreenProps> = ({
  activeVault,
  currentBlockHeight,
  onNavigate,
  onQuickDemoStep,
  onToggleKeeperOnline,
}) => {
  const [activeDocTab, setActiveDocTab] = useState<'spec' | 'contracts' | 'tasks' | null>(null);

  const blocksRemaining = Math.max(0, activeVault.currentExpiryHeight - currentBlockHeight);
  const onlineKeepers = activeVault.keepers.filter((k) => k.online && k.scannerHealth === 'HEALTHY');
  const primaryState = onlineKeepers[0]?.lifecycleState || activeVault.keepers[0]?.lifecycleState || 'ACTIVE';

  return (
    <div className="space-y-12 pb-16">
      {/* Hero Split + Live Interactive 3D Continuity Vault */}
      <section className="space-y-6">
        <div className="border border-[#222938] bg-[#141820] p-6 lg:p-10">
          <div className="grid grid-cols-1 lg:grid-cols-12 gap-8 items-center">
            <div className="lg:col-span-7 space-y-5">
              <div className="flex items-center gap-2 text-xs text-[#94A3B8] font-mono">
                <span className="text-[#F59E0B] font-semibold">Z-Canary Continuity Protocol</span>
                <span aria-hidden="true">·</span>
                <span>Zcash Shielded Memos</span>
                <span aria-hidden="true">·</span>
                <span>3-of-5 Keeper Threshold</span>
              </div>

              <h1
                className="text-3xl sm:text-4xl lg:text-[2.65rem] font-bold tracking-tight text-[#F8FAFC] leading-[1.14]"
                style={{ textWrap: 'balance' }}
              >
                Your evidence stays locked while you check in—and delivers automatically if you cannot.
              </h1>

              <p className="text-[#94A3B8] text-base leading-relaxed max-w-2xl">
                Protect sensitive disclosures with a Zcash dead-man’s switch. Your file is sealed
                inside two cryptographic layers and guarded by 5 independent Keepers. Send a private
                heartbeat to keep it locked, or let the timer expire so 3 of 5 Keepers unlock
                delivery for your designated recipient.
              </p>

              <div className="pt-1 flex flex-wrap items-center gap-3">
                <button
                  onClick={() => onNavigate('sentinel')}
                  className="px-5 py-2.5 bg-[#F59E0B] hover:bg-[#D97706] text-[#0B0D11] font-semibold text-sm rounded transition-colors flex items-center gap-2 whitespace-nowrap shrink-0 cursor-pointer"
                >
                  <span>Open Vault Sentinel</span>
                  <ArrowRight className="w-4 h-4" />
                </button>

                <button
                  onClick={() => onNavigate('create')}
                  className="px-5 py-2.5 bg-[#1E2430] hover:bg-[#283040] text-[#F1F5F9] border border-[#2E3748] font-medium text-sm rounded transition-colors whitespace-nowrap shrink-0 cursor-pointer"
                >
                  Encrypt New Dossier
                </button>

                <button
                  onClick={() => setActiveDocTab(activeDocTab ? null : 'spec')}
                  className="px-4 py-2.5 text-xs font-mono text-[#94A3B8] hover:text-[#F8FAFC] transition-colors flex items-center gap-1.5 whitespace-nowrap shrink-0 cursor-pointer"
                >
                  <BookOpen className="w-3.5 h-3.5" />
                  <span>{activeDocTab ? 'Hide Protocol Specs' : 'SPEC & Contracts'}</span>
                </button>
              </div>
            </div>

            {/* Right: Instant Visual Vault Status Summary */}
            <div className="lg:col-span-5 border border-[#222938] bg-[#0B0D11] p-6 space-y-5">
              <div className="flex items-center justify-between border-b border-[#1E2430] pb-3">
                <div>
                  <div className="text-[11px] font-mono text-[#64748B]">ACTIVE DEMO VAULT</div>
                  <div className="text-base font-bold text-[#F8FAFC] truncate max-w-[260px]">
                    {activeVault.fileName}
                  </div>
                </div>
                <span
                  className={`text-xs font-mono font-semibold ${
                    primaryState === 'ACTIVE'
                      ? 'text-[#10B981]'
                      : primaryState === 'GRACE'
                      ? 'text-[#F59E0B]'
                      : 'text-[#38BDF8]'
                  }`}
                >
                  {primaryState}
                </span>
              </div>

              {/* Visual Progress Bar Toward Deadline */}
              <div className="space-y-2">
                <div className="flex items-center justify-between text-xs font-mono">
                  <span className="text-[#94A3B8]">Countdown to Grace Window</span>
                  <span className="text-[#F59E0B] font-semibold tabular-nums">
                    {blocksRemaining} blocks left
                  </span>
                </div>
                <div className="w-full h-2 bg-[#141820] border border-[#222938] overflow-hidden">
                  <div
                    className={`h-full transition-all duration-300 ${
                      blocksRemaining > 6 ? 'bg-[#10B981]' : blocksRemaining > 0 ? 'bg-[#F59E0B]' : 'bg-[#EF4444]'
                    }`}
                    style={{
                      width: `${Math.min(100, Math.max(8, (blocksRemaining / 24) * 100))}%`,
                    }}
                  />
                </div>
              </div>

              <div className="grid grid-cols-3 gap-2 pt-1 text-center font-mono text-xs">
                <div className="p-2.5 bg-[#141820] border border-[#1E2430]">
                  <div className="text-[10px] text-[#64748B]">KEEPERS ONLINE</div>
                  <div className="text-sm font-bold text-[#10B981] mt-0.5 tabular-nums">
                    {onlineKeepers.length} / 5
                  </div>
                </div>
                <div className="p-2.5 bg-[#141820] border border-[#1E2430]">
                  <div className="text-[10px] text-[#64748B]">SHARES RELEASED</div>
                  <div className="text-sm font-bold text-[#F8FAFC] mt-0.5 tabular-nums">
                    {activeVault.deliveredSharesToRecipient.length} / 3
                  </div>
                </div>
                <div className="p-2.5 bg-[#141820] border border-[#1E2430]">
                  <div className="text-[10px] text-[#64748B]">SEQUENCE</div>
                  <div className="text-sm font-bold text-[#F59E0B] mt-0.5 tabular-nums">
                    #{activeVault.highestSequence}
                  </div>
                </div>
              </div>

              <div className="grid grid-cols-2 gap-2.5 pt-1">
                <button
                  onClick={() => onQuickDemoStep('checkin')}
                  className="py-2 px-3 bg-[#141820] hover:bg-[#1E2430] border border-[#222938] text-xs font-medium text-[#F8FAFC] rounded transition-colors flex items-center justify-center gap-1.5 cursor-pointer"
                >
                  <RefreshCw className="w-3.5 h-3.5 text-[#F59E0B]" />
                  <span>Send Check-In</span>
                </button>
                <button
                  onClick={() => onQuickDemoStep('expire')}
                  className="py-2 px-3 bg-[#141820] hover:bg-[#1E2430] border border-[#222938] text-xs font-medium text-[#F59E0B] rounded transition-colors flex items-center justify-center gap-1.5 cursor-pointer"
                >
                  <Unlock className="w-3.5 h-3.5" />
                  <span>Simulate Expiry</span>
                </button>
              </div>
            </div>
          </div>
        </div>

        {/* Interactive Three.js 3D Continuity Vault & 5-Keeper Orbital Visualizer */}
        <Vault3DVisualizer
          vault={activeVault}
          currentBlockHeight={currentBlockHeight}
          onCheckIn={() => onQuickDemoStep('checkin')}
          onToggleKeeperOnline={onToggleKeeperOnline}
          onJumpToGrace={() => onQuickDemoStep('grace')}
          onTriggerExpiry={() => onQuickDemoStep('expire')}
        />
      </section>

      {/* Expandable Handoff Specifications Viewer */}
      {activeDocTab && (
        <section className="border border-[#222938] bg-[#141820] p-6 space-y-4">
          <div className="flex flex-wrap items-center justify-between gap-4 border-b border-[#222938] pb-4">
            <div className="flex items-center gap-2">
              <button
                onClick={() => setActiveDocTab('spec')}
                className={`px-3 py-1.5 text-xs font-medium rounded transition-colors cursor-pointer ${
                  activeDocTab === 'spec'
                    ? 'bg-[#F59E0B] text-[#0B0D11]'
                    : 'text-[#94A3B8] hover:text-[#F8FAFC]'
                }`}
              >
                SPEC.md (Architecture & Invariants)
              </button>
              <button
                onClick={() => setActiveDocTab('contracts')}
                className={`px-3 py-1.5 text-xs font-medium rounded transition-colors cursor-pointer ${
                  activeDocTab === 'contracts'
                    ? 'bg-[#F59E0B] text-[#0B0D11]'
                    : 'text-[#94A3B8] hover:text-[#F8FAFC]'
                }`}
              >
                CONTRACTS.md (512-Byte Memo & API)
              </button>
              <button
                onClick={() => setActiveDocTab('tasks')}
                className={`px-3 py-1.5 text-xs font-medium rounded transition-colors cursor-pointer ${
                  activeDocTab === 'tasks'
                    ? 'bg-[#F59E0B] text-[#0B0D11]'
                    : 'text-[#94A3B8] hover:text-[#F8FAFC]'
                }`}
              >
                TASKS.md (Builder Ownership & Proofs)
              </button>
            </div>
            <button
              onClick={() => setActiveDocTab(null)}
              className="text-xs text-[#94A3B8] hover:text-[#F8FAFC] cursor-pointer"
            >
              Close Document
            </button>
          </div>

          {activeDocTab === 'spec' && (
            <div className="font-mono text-xs text-[#CBD5E1] space-y-3 leading-relaxed bg-[#0B0D11] p-5 border border-[#222938]">
              <p className="text-[#F8FAFC] font-semibold">Z-CANARY PROTOCOL SPECIFICATION (v1)</p>
              <p>
                1. DUAL-LAYER ENVELOPE: Document M is encrypted to Recipient X25519 public key pk_R
                (inner layer), then wrapped in a random 256-bit AES-GCM ReleaseKey K_rel (outer
                layer). K_rel is split via Shamir Secret Sharing over GF(2^8) into n=5 shares with
                threshold k=3.
              </p>
              <p>
                2. PROTECTION INVARIANT: Before release, Recipient lacks K_rel. After Keeper
                reconstruction, Keepers and third-party observers still lack sk_R.
              </p>
            </div>
          )}

          {activeDocTab === 'contracts' && (
            <div className="font-mono text-xs text-[#CBD5E1] space-y-3 leading-relaxed bg-[#0B0D11] p-5 border border-[#222938] overflow-x-auto">
              <p className="text-[#F8FAFC] font-semibold">
                FROZEN 512-BYTE SHIELDED MEMO LAYOUT (ZIP-302 BINARY)
              </p>
              <pre className="text-[11px] text-[#94A3B8]">
{`Offset   Bytes  Field                 Constraint
0        1      zip302_prefix         0xFF (ZIP-302 binary indicator)
1..5     4      app_magic             "ZCAN" (0x5A 0x43 0x41 0x4E)
5        1      version               0x01
6        1      network               0x01 (Testnet) / 0x00 (Mainnet)
7        1      operation             0x01=Register, 0x02=Postpone, 0x03=Cancel
8..40    32     switch_id             Unique 256-bit switch identifier
40..48   8      sequence              uint64 Little-Endian
48..52   4      requested_expiry      uint32 Little-Endian block height
52..84   32     manifest_digest       SHA-256 of canonical immutable manifest
84..116  32     source_pubkey         Ed25519 command verification key
116..448 332    zero_padding          332 bytes of 0x00 (non-zero rejected)
448..512 64     signature             Ed25519 signature over domain_sep + bytes[0..448]`}
              </pre>
            </div>
          )}

          {activeDocTab === 'tasks' && (
            <div className="font-mono text-xs text-[#CBD5E1] space-y-2 leading-relaxed bg-[#0B0D11] p-5 border border-[#222938]">
              <p className="text-[#F8FAFC] font-semibold">COMPONENT OWNERSHIP & VERIFICATION MATRIX</p>
              <p>Builder A (Protocol/Core): Memo codec, GF(256) Shamir 3-of-5, Keeper state reducer — VERIFIED</p>
              <p>Builder B (Wallet/Agent): Testnet shielded memo scanner, zatoshi fee estimator, reorg handler — VERIFIED</p>
              <p>Builder C (Editorial UI): Source console, Recipient inbox, ZIP-321 Support, Evidence suite — VERIFIED</p>
            </div>
          )}
        </section>
      )}

      {/* Visual 3-Step Architecture Diagram (Understandable in 10 Seconds) */}
      <section className="space-y-5">
        <div className="flex flex-col sm:flex-row sm:items-end justify-between gap-2">
          <div>
            <h2 className="text-xl font-bold text-[#F8FAFC]">
              How Z-Canary Works in Three Visual Steps
            </h2>
            <p className="text-sm text-[#94A3B8]">
              Click any step below to experience that exact stage in the live simulator.
            </p>
          </div>
        </div>

        <div className="grid grid-cols-1 lg:grid-cols-3 gap-5">
          {/* Step 1 */}
          <div className="border border-[#222938] bg-[#141820] p-6 flex flex-col justify-between space-y-5">
            <div className="space-y-3">
              <div className="flex items-center justify-between">
                <span className="text-xs font-mono text-[#10B981]">STEP 01 · DUAL-LAYER SEAL</span>
                <Lock className="w-5 h-5 text-[#10B981]" />
              </div>
              <h3 className="text-lg font-bold text-[#F8FAFC]">
                1. Lock Dossier in Two Concentric Envelopes
              </h3>
              <p className="text-sm text-[#94A3B8] leading-relaxed">
                Your file is first encrypted to the <strong>Recipient’s X25519 key</strong> (Inner
                Emerald Core), then locked inside a <strong>256-bit Release Key</strong> split across
                5 Keepers (Outer Titanium Cage).
              </p>
            </div>

            <div className="space-y-3 pt-2 border-t border-[#1E2430]">
              <div className="text-xs font-mono text-[#CBD5E1]">
                Result: Neither the Recipient nor the Keepers can read the file early.
              </div>
              <button
                onClick={() => onQuickDemoStep('inspect')}
                className="w-full py-2.5 px-3.5 bg-[#0B0D11] hover:bg-[#1E2430] border border-[#222938] text-xs font-semibold text-[#F8FAFC] rounded flex items-center justify-between cursor-pointer transition-colors"
              >
                <span>Try Locked Recipient Inbox</span>
                <ArrowRight className="w-4 h-4 text-[#10B981]" />
              </button>
            </div>
          </div>

          {/* Step 2 */}
          <div className="border border-[#222938] bg-[#141820] p-6 flex flex-col justify-between space-y-5">
            <div className="space-y-3">
              <div className="flex items-center justify-between">
                <span className="text-xs font-mono text-[#F59E0B]">STEP 02 · SHIELDED HEARTBEAT</span>
                <RefreshCw className="w-5 h-5 text-[#F59E0B]" />
              </div>
              <h3 className="text-lg font-bold text-[#F8FAFC]">
                2. Renew Deadline via Private Zcash Memos
              </h3>
              <p className="text-sm text-[#94A3B8] leading-relaxed">
                While you are safe, click <strong>Check In</strong>. Your wallet broadcasts an
                Ed25519-signed command hidden inside a 512-byte Zcash shielded memo, pushing the
                release block deadline forward.
              </p>
            </div>

            <div className="space-y-3 pt-2 border-t border-[#1E2430]">
              <div className="text-xs font-mono text-[#CBD5E1]">
                Funded by unlinked Orchard donations with zero document IDs.
              </div>
              <button
                onClick={() => onQuickDemoStep('checkin')}
                className="w-full py-2.5 px-3.5 bg-[#0B0D11] hover:bg-[#1E2430] border border-[#222938] text-xs font-semibold text-[#F8FAFC] rounded flex items-center justify-between cursor-pointer transition-colors"
              >
                <span>Broadcast Shielded Check-In Now</span>
                <ArrowRight className="w-4 h-4 text-[#F59E0B]" />
              </button>
            </div>
          </div>

          {/* Step 3 */}
          <div className="border border-[#222938] bg-[#141820] p-6 flex flex-col justify-between space-y-5">
            <div className="space-y-3">
              <div className="flex items-center justify-between">
                <span className="text-xs font-mono text-[#38BDF8]">STEP 03 · 3-OF-5 THRESHOLD</span>
                <KeyRound className="w-5 h-5 text-[#38BDF8]" />
              </div>
              <h3 className="text-lg font-bold text-[#F8FAFC]">
                3. Automatic 3-of-5 Keeper Release on Silence
              </h3>
              <p className="text-sm text-[#94A3B8] leading-relaxed">
                If you stop checking in and the Grace window expires on-chain, at least 3 Keepers
                deliver their shares to the Recipient, who reconstructs the outer key and unlocks the
                dossier.
              </p>
            </div>

            <div className="space-y-3 pt-2 border-t border-[#1E2430]">
              <div className="text-xs font-mono text-[#CBD5E1]">
                Works even if 2 of the 5 Keepers go completely offline.
              </div>
              <button
                onClick={() => onQuickDemoStep('expire')}
                className="w-full py-2.5 px-3.5 bg-[#F59E0B] hover:bg-[#D97706] text-[#0B0D11] text-xs font-bold rounded flex items-center justify-between cursor-pointer transition-colors"
              >
                <span>Trigger Expiry & Decrypt as Recipient</span>
                <ArrowRight className="w-4 h-4" />
              </button>
            </div>
          </div>
        </div>
      </section>

      {/* Compact Trust & Privacy Disclosures */}
      <section className="grid grid-cols-1 lg:grid-cols-2 gap-6">
        <div className="border border-[#222938] bg-[#141820] p-5 flex items-start gap-4">
          <Shield className="w-5 h-5 text-[#10B981] shrink-0 mt-0.5" />
          <div className="space-y-1">
            <h3 className="text-sm font-semibold text-[#F8FAFC]">
              Why Keepers Cannot Read Your Document
            </h3>
            <p className="text-xs text-[#94A3B8] leading-relaxed">
              Keepers only hold shares of the <em>outer</em> release key. The <em>inner</em> envelope
              is encrypted to the Recipient’s X25519 private key, which never leaves the Recipient’s
              machine.
            </p>
          </div>
        </div>

        <div className="border border-[#222938] bg-[#141820] p-5 flex items-start gap-4">
          <AlertTriangle className="w-5 h-5 text-[#F59E0B] shrink-0 mt-0.5" />
          <div className="space-y-1">
            <h3 className="text-sm font-semibold text-[#F8FAFC]">
              Explicit Trust & Network Metadata Boundaries
            </h3>
            <p className="text-xs text-[#94A3B8] leading-relaxed">
              Three colluding Keepers can deliver early to the designated Recipient (though not to
              the public). Standard lightwalletd connections expose network IP metadata unless routed
              over Tor.
            </p>
          </div>
        </div>
      </section>
    </div>
  );
};
