import React, { useState, useEffect } from 'react';
import {
  CheckCircle2,
  XCircle,
  Play,
  AlertTriangle,
  Power,
  RotateCcw,
  ShieldCheck,
  WifiOff,
  Clock,
  Unlock,
} from 'lucide-react';
import { hexToBytes, bytesToHex } from '../crypto/shamir';
import {
  decodeAndValidateMemo,
  operationLabel,
  ZcashNetwork,
} from '../crypto/memoCodec';
import {
  ChainTransaction,
  ContinuityVault,
  ScannerHealthState,
} from '../engine/protocolStore';
import {
  AcceptanceTestResult,
  runAllAcceptanceTests,
} from '../engine/testSuite';
import { KeeperNetworkD3Graph } from './KeeperNetworkD3Graph';
import { LocalAgentPanel } from './LocalAgentPanel';

interface EvidenceAndKeepersPanelProps {
  vault: ContinuityVault;
  transactions: ChainTransaction[];
  currentBlockHeight: number;
  selectedTxidForMemo: string | null;
  onToggleKeeperOnline: (keeperIndex: number) => void;
  onSetKeeperScannerHealth: (keeperIndex: number, health: ScannerHealthState) => void;
  onSimulateReorg: (depth: 'shallow' | 'deep') => void;
  onTriggerExpiryForDemo?: () => void;
}

export const EvidenceAndKeepersPanel: React.FC<EvidenceAndKeepersPanelProps> = ({
  vault,
  transactions,
  currentBlockHeight,
  selectedTxidForMemo,
  onToggleKeeperOnline,
  onSetKeeperScannerHealth,
  onSimulateReorg,
  onTriggerExpiryForDemo,
}) => {
  const [selectedKeeperTab, setSelectedKeeperTab] = useState<'ALL' | 1 | 2 | 3 | 4 | 5>('ALL');
  const [selectedTxid, setSelectedTxid] = useState<string>(
    selectedTxidForMemo || transactions[transactions.length - 1]?.txid || ''
  );
  const [tamperMode, setTamperMode] = useState<'NONE' | 'PADDING' | 'SIGNATURE' | 'NETWORK'>('NONE');
  const [testResults, setTestResults] = useState<AcceptanceTestResult[]>([]);

  useEffect(() => {
    if (selectedTxidForMemo) {
      setSelectedTxid(selectedTxidForMemo);
    }
  }, [selectedTxidForMemo]);

  useEffect(() => {
    setTestResults(runAllAcceptanceTests());
  }, []);

  const selectedTx =
    transactions.find((t) => t.txid === selectedTxid) || transactions[transactions.length - 1];

  const memoInspection = (() => {
    if (!selectedTx) return null;
    const raw = new Uint8Array(hexToBytes(selectedTx.memoHex));
    if (tamperMode === 'PADDING') {
      raw[200] = 0x99;
    } else if (tamperMode === 'SIGNATURE') {
      raw[490] ^= 0xff;
    }
    const targetNet = tamperMode === 'NETWORK' ? ZcashNetwork.MAINNET : ZcashNetwork.TESTNET;
    const result = decodeAndValidateMemo(raw, targetNet);
    return {
      rawBytes: raw,
      rawHex: bytesToHex(raw),
      result,
    };
  })();

  const handleRunTests = () => {
    setTestResults(runAllAcceptanceTests());
  };

  const activeKeeper =
    selectedKeeperTab === 'ALL'
      ? null
      : vault.keepers.find((k) => k.index === selectedKeeperTab) || vault.keepers[0];

  const onlineHealthyCount = vault.keepers.filter(
    (k) => k.online && k.scannerHealth === 'HEALTHY'
  ).length;
  const thresholdMet = onlineHealthyCount >= vault.manifest.threshold;

  return (
    <div className="space-y-10 pb-16">
      {/* Section 1: Refined 5-Keeper High-Assurance Infrastructure Grid + Live D3.js Topology */}
      <section className="border border-[#222938] bg-[#141820] p-6 lg:p-8 space-y-6">
        <div className="flex flex-col lg:flex-row lg:items-center justify-between gap-4 border-b border-[#222938] pb-5">
          <div className="space-y-1">
            <div className="text-xs font-mono text-[#F59E0B]">
              3-OF-5 THRESHOLD CUSTODY · 5 SIMULATED KEEPER RECORDS
            </div>
            <h1 className="text-2xl font-bold text-[#F8FAFC]">
              Five stations. One deliberate threshold.
            </h1>
            <p className="text-sm text-[#94A3B8]">
              These five records run in one browser. Toggle availability and scanner health to explore the release policy. Native testnet has separate local processes and is accessed in the native workspace.
            </p>
          </div>

          <div className="flex flex-wrap items-center gap-2 shrink-0">
            <button
              onClick={() => onSimulateReorg('shallow')}
              className="px-3.5 py-2 bg-[#0B0D11] hover:bg-[#1E2430] border border-[#222938] text-xs font-mono text-[#E2E8F0] rounded flex items-center gap-1.5 cursor-pointer transition-colors"
            >
              <RotateCcw className="w-3.5 h-3.5 text-[#F59E0B]" />
              <span>2-Block Reorg</span>
            </button>
            <button
              onClick={() => onSimulateReorg('deep')}
              className="px-3.5 py-2 bg-[#0B0D11] hover:bg-[#1E2430] border border-[#EF4444]/50 text-xs font-mono text-[#EF4444] rounded flex items-center gap-1.5 cursor-pointer transition-colors"
            >
              <AlertTriangle className="w-3.5 h-3.5" />
              <span>Deep Reorg Incident</span>
            </button>
          </div>
        </div>

        {/* Live D3.js 5-Keeper Mesh & Share Transmission Visualization */}
        <KeeperNetworkD3Graph
          vault={vault}
          currentBlockHeight={currentBlockHeight}
          onToggleKeeperOnline={onToggleKeeperOnline}
          onTriggerExpiryForDemo={onTriggerExpiryForDemo}
        />

        {/* Visual Threshold Consensus Bar */}
        <div className="p-4 bg-[#0B0D11] border border-[#222938] flex flex-col sm:flex-row sm:items-center justify-between gap-4">
          <div className="flex items-center gap-3">
            {thresholdMet ? (
              <ShieldCheck className="w-5 h-5 text-[#10B981] shrink-0" />
            ) : (
              <AlertTriangle className="w-5 h-5 text-[#EF4444] shrink-0" />
            )}
            <div>
              <div className="text-sm font-semibold text-[#F8FAFC]">
                {thresholdMet
                  ? `Quorum Healthy: ${onlineHealthyCount} of 5 Keepers Active & Synchronized`
                  : `Quorum Degraded: Only ${onlineHealthyCount} of 5 Keepers Healthy (Minimum 3 Required)`}
              </div>
              <div className="text-xs text-[#94A3B8] font-mono">
                {thresholdMet
                  ? 'System can tolerate up to 2 simultaneous node failures without blocking release.'
                  : 'Release threshold is currently blocked until at least 3 nodes are online and healthy.'}
              </div>
            </div>
          </div>

          <div className="flex items-center gap-1.5 shrink-0">
            {vault.keepers.map((k) => {
              const isOk = k.online && k.scannerHealth === 'HEALTHY';
              return (
                <div
                  key={k.id}
                  title={`${k.name}: ${!k.online ? 'OFFLINE' : k.scannerHealth}`}
                  className={`w-7 h-2.5 rounded-xs transition-all duration-200 ${
                    !isOk
                      ? 'bg-[#EF4444]/40 border border-[#EF4444]'
                      : k.lifecycleState === 'GRACE'
                      ? 'bg-[#F59E0B]'
                      : 'bg-[#10B981]'
                  }`}
                />
              );
            })}
          </div>
        </div>

        {/* Navigation Tabs: All 5 Grid vs Individual Deep Dive */}
        <div className="flex flex-wrap items-center justify-between gap-4">
          <div className="flex flex-wrap items-center gap-1.5 p-1 bg-[#0B0D11] border border-[#222938] rounded">
            <button
              onClick={() => setSelectedKeeperTab('ALL')}
              className={`px-3 py-1.5 text-xs font-mono rounded transition-colors cursor-pointer ${
                selectedKeeperTab === 'ALL'
                  ? 'bg-[#F59E0B] text-[#0B0D11] font-semibold'
                  : 'text-[#94A3B8] hover:text-[#F8FAFC]'
              }`}
            >
              All keeper stations
            </button>
            {vault.keepers.map((k) => (
              <button
                key={k.index}
                onClick={() => setSelectedKeeperTab(k.index as 1 | 2 | 3 | 4 | 5)}
                className={`px-3 py-1.5 text-xs font-mono rounded transition-colors cursor-pointer ${
                  selectedKeeperTab === k.index
                    ? 'bg-[#F59E0B] text-[#0B0D11] font-semibold'
                    : 'text-[#94A3B8] hover:text-[#F8FAFC]'
                }`}
              >
                {k.id} ({!k.online ? 'OFF' : k.lifecycleState})
              </button>
            ))}
          </div>
        </div>

        {/* Refined 5-Keeper Grid Display with Subtle CSS Heartbeat Glow on Online Status Indicators */}
        {selectedKeeperTab === 'ALL' && (
          <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-5 gap-4">
            {vault.keepers.map((k) => {
              const isHealthyOnline = k.online && k.scannerHealth === 'HEALTHY';
              const isGrace = isHealthyOnline && k.lifecycleState === 'GRACE';
              const isReleased = isHealthyOnline && k.lifecycleState === 'RELEASED';

              const stateAnimationClass = !k.online
                ? 'keeper-node-card keeper-node-offline border-[#EF4444]/40 bg-[#0B0D11]/70'
                : isGrace
                ? 'keeper-node-card keeper-node-grace keeper-scan-line keeper-scan-line-amber border-[#F59E0B]/70 bg-[#0B0D11]'
                : isHealthyOnline
                ? 'keeper-node-card keeper-node-active keeper-scan-line border-[#222938] hover:border-[#10B981]/60 bg-[#0B0D11]'
                : 'keeper-node-card border-[#F59E0B]/60 bg-[#0B0D11]';

              // Low-frequency heartbeat glow class applied strictly to online keeper status indicator boxes
              const statusIndicatorHeartbeatClass = !k.online
                ? 'border-[#EF4444]/40 bg-[#141820]'
                : isReleased
                ? 'keeper-status-heartbeat-cyan border-[#38BDF8]/60 bg-[#141820]'
                : isGrace || k.scannerHealth !== 'HEALTHY'
                ? 'keeper-status-heartbeat-amber border-[#F59E0B]/60 bg-[#141820]'
                : 'keeper-status-heartbeat-emerald border-[#10B981]/60 bg-[#141820]';

              return (
                <div
                  key={k.id}
                  className={`p-4 border flex flex-col justify-between space-y-4 font-mono text-xs ${stateAnimationClass}`}
                >
                  {/* Top Row: Keeper ID & Status Indicator with Low-Frequency CSS Heartbeat Glow */}
                  <div className="space-y-3">
                    <div className="flex items-start justify-between gap-2">
                      <div>
                        <div className="text-[11px] text-[#64748B]">{k.id.toUpperCase()}</div>
                        <div className="text-sm font-bold text-[#F8FAFC] font-sans">
                          {k.name.replace(/^Keeper 0\d\s*/, '')}
                        </div>
                      </div>

                      {/* Dynamic Status Indicator with Subtle CSS Heartbeat Animation */}
                      <div
                        title={
                          k.online
                            ? `Online Heartbeat Active · ${k.lifecycleState}`
                            : 'Keeper Process Offline'
                        }
                        className={`p-2 border rounded shrink-0 ${statusIndicatorHeartbeatClass}`}
                      >
                        {!k.online ? (
                          <WifiOff className="w-4 h-4 text-[#EF4444]" />
                        ) : k.scannerHealth !== 'HEALTHY' ? (
                          <AlertTriangle className="w-4 h-4 text-[#F59E0B]" />
                        ) : isReleased ? (
                          <Unlock className="w-4 h-4 text-[#38BDF8]" />
                        ) : isGrace ? (
                          <Clock className="w-4 h-4 text-[#F59E0B]" />
                        ) : (
                          <ShieldCheck className="w-4 h-4 text-[#10B981]" />
                        )}
                      </div>
                    </div>

                    {/* Lifecycle & Health Status Readout */}
                    <div className="p-2.5 bg-[#141820] border border-[#1E2430] space-y-1.5 tabular-nums">
                      <div className="flex items-center justify-between">
                        <span className="text-[#64748B]">Lifecycle</span>
                        <span
                          className={`font-semibold ${
                            !k.online
                              ? 'text-[#EF4444]'
                              : k.lifecycleState === 'ACTIVE'
                              ? 'text-[#10B981]'
                              : k.lifecycleState === 'GRACE'
                              ? 'text-[#F59E0B]'
                              : k.lifecycleState === 'RELEASED'
                              ? 'text-[#38BDF8]'
                              : 'text-[#94A3B8]'
                          }`}
                        >
                          {!k.online ? 'OFFLINE' : k.lifecycleState}
                        </span>
                      </div>

                      <div className="flex items-center justify-between">
                        <span className="text-[#64748B]">Confirmed Block</span>
                        <span className="text-[#F8FAFC] font-semibold">
                          #{k.scanCursorHeight.toLocaleString()}
                        </span>
                      </div>

                      <div className="flex items-center justify-between">
                        <span className="text-[#64748B]">Scanner Health</span>
                        <span
                          className={
                            !k.online
                              ? 'text-[#EF4444]'
                              : k.scannerHealth === 'HEALTHY'
                              ? 'text-[#10B981]'
                              : 'text-[#F59E0B]'
                          }
                        >
                          {!k.online ? 'DISCONNECTED' : k.scannerHealth}
                        </span>
                      </div>
                    </div>

                    {/* Additional Telemetry: Last Sequence, Expiry, Share Custody */}
                    <div className="space-y-1 text-[11px] text-[#94A3B8] tabular-nums pt-1">
                      <div className="flex justify-between">
                        <span className="text-[#64748B]">Verified Seq:</span>
                        <span>#{k.lastSequence !== null ? k.lastSequence.toString() : '0'}</span>
                      </div>
                      <div className="flex justify-between">
                        <span className="text-[#64748B]">Release Height:</span>
                        <span className="text-[#F59E0B]">#{k.graceDeadlineHeight}</span>
                      </div>
                      <div className="flex justify-between">
                        <span className="text-[#64748B]">Share #0{k.index}:</span>
                        <span className={k.outboxDelivered ? 'text-[#38BDF8]' : 'text-[#10B981]'}>
                          {k.outboxDelivered ? 'Transmitted' : 'Locked in DB'}
                        </span>
                      </div>
                    </div>
                  </div>

                  {/* Action Controls: Online Toggle & Inspector Link */}
                  <div className="space-y-2 pt-3 border-t border-[#1E2430]">
                    <button
                      onClick={() => onToggleKeeperOnline(k.index)}
                      className={`w-full py-2 px-3 rounded text-xs font-medium flex items-center justify-center gap-1.5 transition-colors cursor-pointer ${
                        k.online
                          ? 'bg-[#141820] hover:bg-[#1E2430] text-[#E2E8F0] border border-[#222938]'
                          : 'bg-[#10B981] hover:bg-[#059669] text-[#0B0D11] font-semibold'
                      }`}
                    >
                      <Power className="w-3.5 h-3.5" />
                      <span>{k.online ? 'Simulate Node Offline' : 'Restore Node Online'}</span>
                    </button>

                    <button
                      onClick={() => setSelectedKeeperTab(k.index as 1 | 2 | 3 | 4 | 5)}
                      className="w-full py-1.5 px-2.5 bg-[#141820]/60 hover:bg-[#1E2430] text-[#94A3B8] hover:text-[#F8FAFC] rounded text-[11px] transition-colors cursor-pointer"
                    >
                      Inspect simulation events →
                    </button>
                  </div>
                </div>
              );
            })}
          </div>
        )}

        {/* Individual Keeper Deep-Dive View */}
        {activeKeeper && (
          <div className="border border-[#222938] bg-[#0B0D11] p-6 space-y-6 font-mono text-xs">
            <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-4 border-b border-[#1E2430] pb-4">
              <div className="space-y-1">
                <div className="text-sm font-bold text-[#F8FAFC]">
                  {activeKeeper.name} ({activeKeeper.id}) — Isolated Process Inspector
                </div>
                <div className="text-[#94A3B8]">
                  Endpoint: {activeKeeper.endpoint} · Planned database: {activeKeeper.dbPath}
                </div>
              </div>

              <div className="flex items-center gap-3">
                <select
                  value={activeKeeper.scannerHealth}
                  onChange={(e) =>
                    onSetKeeperScannerHealth(
                      activeKeeper.index,
                      e.target.value as ScannerHealthState
                    )
                  }
                  className="px-3 py-1.5 bg-[#141820] border border-[#222938] rounded text-xs text-[#F8FAFC]"
                >
                  <option value="HEALTHY">Health: HEALTHY</option>
                  <option value="DELAYED_SCAN">Health: DELAYED_SCAN</option>
                  <option value="REORG_INCIDENT">Health: REORG_INCIDENT</option>
                </select>

                <button
                  onClick={() => onToggleKeeperOnline(activeKeeper.index)}
                  className="px-3 py-1.5 bg-[#141820] hover:bg-[#1E2430] border border-[#222938] rounded text-xs text-[#F8FAFC] cursor-pointer"
                >
                  {activeKeeper.online ? 'Simulate Process Kill' : 'Restart Process'}
                </button>
              </div>
            </div>

            <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
              <div className="p-3.5 bg-[#141820] border border-[#222938] space-y-1">
                <div className="text-[#64748B]">Provisioned Share Commitment</div>
                <div className="text-[#E2E8F0] truncate">
                  {activeKeeper.provisionedShare?.commitmentHex}
                </div>
                <div className="text-[#10B981]">
                  ACK Signature: {activeKeeper.provisionedAckSignature}
                </div>
              </div>

              <div className="p-3.5 bg-[#141820] border border-[#222938] space-y-1 tabular-nums">
                <div className="text-[#64748B]">Confirmed Block Scan Cursor</div>
                <div className="text-[#F8FAFC] font-semibold">
                  Height #{activeKeeper.scanCursorHeight.toLocaleString()}
                </div>
                <div className="text-[#94A3B8] truncate">
                  Hash: {activeKeeper.scanCursorBlockHash}
                </div>
              </div>

              <div className="p-3.5 bg-[#141820] border border-[#222938] space-y-1">
                <div className="text-[#64748B]">Outbox & Idempotency Status</div>
                <div className="text-[#F8FAFC] font-semibold">
                  {activeKeeper.outboxDelivered ? 'DISPATCHED TO RECIPIENT' : 'HELD IN CUSTODY'}
                </div>
                <div className="text-[#94A3B8] truncate">
                  Idempotency Key: {activeKeeper.deliveryIdempotencyKey || 'Not yet generated'}
                </div>
              </div>
            </div>

            <div className="space-y-2">
              <div className="text-[#94A3B8]">In-memory simulation event log</div>
              <div className="p-4 bg-[#141820] border border-[#222938] space-y-1.5 text-[11px] text-[#CBD5E1]">
                {activeKeeper.logs.map((line, i) => (
                  <div key={i}>{line}</div>
                ))}
              </div>
            </div>
          </div>
        )}
      </section>

      {/* Section 2: 512-Byte ZIP-302 Shielded Memo Binary Inspector */}
      <section className="border border-[#222938] bg-[#141820] p-6 lg:p-8 space-y-6">
        <div className="flex flex-col lg:flex-row lg:items-center justify-between gap-4 border-b border-[#222938] pb-5">
          <div className="space-y-1">
            <div className="text-xs font-mono text-[#F59E0B]">
              LOCAL MEMO CODEC · LIVE SEND/SCAN GATE PENDING
            </div>
            <h2 className="text-xl font-bold text-[#F8FAFC]">
              Shielded Memo Binary Inspector & Tamper Verifier
            </h2>
            <p className="text-xs text-[#94A3B8]">
              Inspect the exact 512-byte payload generated by a simulated transaction or inject
              faults to verify strict rejection rules.
            </p>
          </div>

          <div className="flex flex-wrap items-center gap-2">
            <select
              value={selectedTx?.txid || ''}
              onChange={(e) => {
                setSelectedTxid(e.target.value);
                setTamperMode('NONE');
              }}
              className="px-3 py-2 bg-[#0B0D11] border border-[#222938] rounded font-mono text-xs text-[#F8FAFC]"
            >
              {transactions.map((tx) => (
                <option key={tx.txid} value={tx.txid}>
                  Seq #{tx.sequence} · {operationLabel(tx.operation)} · tx:{tx.txid.slice(0, 10)}…
                </option>
              ))}
            </select>
          </div>
        </div>

        {memoInspection && (
          <div className="space-y-6">
            <div className="flex flex-wrap items-center justify-between gap-4 p-4 bg-[#0B0D11] border border-[#222938] font-mono text-xs">
              <div className="flex flex-wrap items-center gap-2">
                <span className="text-[#94A3B8]">Codec Fault Injection:</span>
                <button
                  onClick={() => setTamperMode('NONE')}
                  className={`px-2.5 py-1 rounded cursor-pointer ${
                    tamperMode === 'NONE'
                      ? 'bg-[#10B981] text-[#0B0D11] font-semibold'
                      : 'bg-[#141820] text-[#94A3B8]'
                  }`}
                >
                  Generated 512B Memo
                </button>
                <button
                  onClick={() => setTamperMode('PADDING')}
                  className={`px-2.5 py-1 rounded cursor-pointer ${
                    tamperMode === 'PADDING'
                      ? 'bg-[#EF4444] text-white font-semibold'
                      : 'bg-[#141820] text-[#94A3B8]'
                  }`}
                >
                  Corrupt Zero Padding [Byte 200]
                </button>
                <button
                  onClick={() => setTamperMode('SIGNATURE')}
                  className={`px-2.5 py-1 rounded cursor-pointer ${
                    tamperMode === 'SIGNATURE'
                      ? 'bg-[#EF4444] text-white font-semibold'
                      : 'bg-[#141820] text-[#94A3B8]'
                  }`}
                >
                  Flip Ed25519 Signature [Byte 490]
                </button>
                <button
                  onClick={() => setTamperMode('NETWORK')}
                  className={`px-2.5 py-1 rounded cursor-pointer ${
                    tamperMode === 'NETWORK'
                      ? 'bg-[#EF4444] text-white font-semibold'
                      : 'bg-[#141820] text-[#94A3B8]'
                  }`}
                >
                  Wrong Network Scanner
                </button>
              </div>

              <div>
                {memoInspection.result.valid ? (
                  <span className="text-[#10B981] font-semibold">
                    VALID 512B ZIP-302 COMMAND · ED25519 VERIFIED
                  </span>
                ) : (
                  <span className="text-[#EF4444] font-semibold">
                    REJECTED: {memoInspection.result.errorCode}
                  </span>
                )}
              </div>
            </div>

            {!memoInspection.result.valid && (
              <div className="p-4 bg-[#0B0D11] border border-[#EF4444] font-mono text-xs text-[#EF4444]">
                Decoder Rejection Reason: {memoInspection.result.errorMessage} (
                {memoInspection.result.errorCode})
              </div>
            )}

            <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-4 gap-3 font-mono text-xs">
              <div className="p-3 bg-[#0B0D11] border border-[#222938]">
                <div className="text-[#64748B]">[0] ZIP-302 Prefix (1B)</div>
                <div className="text-[#F59E0B] font-semibold mt-1">
                  0x{memoInspection.rawBytes[0].toString(16).toUpperCase()}
                </div>
              </div>
              <div className="p-3 bg-[#0B0D11] border border-[#222938]">
                <div className="text-[#64748B]">[1..5] App Magic (4B)</div>
                <div className="text-[#F8FAFC] font-semibold mt-1">"ZCAN" (5a 43 41 4e)</div>
              </div>
              <div className="p-3 bg-[#0B0D11] border border-[#222938]">
                <div className="text-[#64748B]">[5..8] Ver / Net / Op (3B)</div>
                <div className="text-[#10B981] font-semibold mt-1">
                  v{memoInspection.rawBytes[5]} · Testnet · Op 0x0{memoInspection.rawBytes[7]}
                </div>
              </div>
              <div className="p-3 bg-[#0B0D11] border border-[#222938]">
                <div className="text-[#64748B]">[40..52] Seq (8B LE) & Expiry (4B LE)</div>
                <div className="text-[#F8FAFC] font-semibold mt-1 tabular-nums">
                  Seq #{selectedTx?.sequence} · Exp #{selectedTx?.requestedExpiryHeight}
                </div>
              </div>
            </div>

            <div className="p-4 bg-[#0B0D11] border border-[#222938] font-mono text-[11px] space-y-2">
              <div className="flex items-center justify-between text-[#64748B]">
                <span>RAW 512-BYTE HEXADECIMAL PAYLOAD (1,024 HEX CHARS)</span>
                <span>Total Length: {memoInspection.rawBytes.length} Bytes</span>
              </div>
              <div className="text-[#94A3B8] break-all leading-relaxed max-h-36 overflow-y-auto">
                {memoInspection.rawHex}
              </div>
            </div>
          </div>
        )}
      </section>

      <details className="native-evidence-disclosure"><summary>Inspect authenticated native evidence <span>+</span></summary><LocalAgentPanel memoHex={memoInspection?.rawHex} /></details>

      {/* Section 3: Automated Acceptance Test Suite */}
      <section className="border border-[#222938] bg-[#141820] p-6 lg:p-8 space-y-6">
        <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-4 border-b border-[#222938] pb-5">
          <div className="space-y-1">
            <div className="text-xs font-mono text-[#10B981]">
              BROWSER SIMULATION CHECKS · LIVE ACCEPTANCE PENDING
            </div>
            <h2 className="text-xl font-bold text-[#F8FAFC]">
              Browser Simulation Checks ({testResults.filter((r) => r.passed).length}/
              {testResults.length} Passing)
            </h2>
          </div>

          <button
            onClick={handleRunTests}
            className="px-4 py-2 bg-[#F59E0B] hover:bg-[#D97706] text-[#0B0D11] font-semibold text-xs rounded flex items-center gap-2 self-start cursor-pointer"
          >
            <Play className="w-3.5 h-3.5" />
            <span>Re-Run All Acceptance Vectors</span>
          </button>
        </div>

        <div className="divide-y divide-[#1E2430] font-mono text-xs">
          {testResults.map((test) => (
            <div
              key={test.id}
              className="py-4 first:pt-0 last:pb-0 flex flex-col lg:flex-row lg:items-center justify-between gap-4"
            >
              <div className="space-y-1">
                <div className="flex items-center gap-2.5">
                  {test.passed ? (
                    <CheckCircle2 className="w-4 h-4 text-[#10B981] shrink-0" />
                  ) : (
                    <XCircle className="w-4 h-4 text-[#EF4444] shrink-0" />
                  )}
                  <span className="text-[#F59E0B]">{test.id}</span>
                  <span className="text-[#64748B]">·</span>
                  <span className="text-[#94A3B8]">{test.category}</span>
                  <span className="text-[#64748B]">·</span>
                  <span className="text-[#F8FAFC] font-semibold">{test.name}</span>
                </div>
                <p className="text-[#94A3B8] pl-6">{test.assertionSummary}</p>
                <div className="text-[11px] text-[#64748B] pl-6">{test.evidenceLog}</div>
              </div>

              <div className="pl-6 lg:pl-0 flex items-center gap-3 shrink-0 tabular-nums">
                <span className="text-[#64748B]">{test.durationMs} ms</span>
                <span className={test.passed ? 'text-[#10B981] font-semibold' : 'text-[#EF4444]'}>
                  {test.passed ? 'PASS' : 'FAIL'}
                </span>
              </div>
            </div>
          ))}
        </div>
      </section>
    </div>
  );
};
