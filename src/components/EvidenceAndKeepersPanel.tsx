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
  ExternalLink,
  FileCheck2,
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
import { ReceiptVerifier } from './ReceiptVerifier';
import { RealRunReplay } from './RealRunReplay';

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

const NATIVE_FIXTURE_SHA256 = 'e05e833a180c72954315c0165cf79dc921221065f65263b408bcf99ba362d2d2';

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

  useEffect(() => {
    if (!selectedTxidForMemo) return;
    const t = window.setTimeout(() => document.getElementById('memo-paste')?.scrollIntoView({ block: 'center', behavior: 'auto' }), 350);
    return () => window.clearTimeout(t);
  }, [selectedTxidForMemo]);

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
      <section className="border border-[var(--yellow-2)]/50 bg-[var(--card)] rounded-[22px] shadow-[var(--shadow)] p-6 lg:p-8 space-y-7" aria-labelledby="judge-proof-title">
        <div className="flex flex-col xl:flex-row xl:items-end justify-between gap-5 border-b border-[var(--line)] pb-6">
          <div className="max-w-3xl space-y-2">
            
            <h1 id="judge-proof-title" className="text-2xl lg:text-3xl font-bold text-[var(--ink)]">
              One lifecycle. Three different kinds of evidence.
            </h1>
            <p className="text-sm leading-relaxed text-[var(--muted)]">
              The hosted lab makes the recovery rules testable without a wallet. It performs real local
              cryptography but sends no transaction. The receipts below belong to a separate recorded native
              run that used genuine shielded Zcash testnet commands and recovered a public fixture byte for byte.
            </p>
          </div>
          <div className="flex flex-wrap gap-2 text-xs">
            <a href="https://github.com/unspecifiedcoder/z-canary/blob/main/docs/evidence/VERIFICATION.md" target="_blank" rel="noreferrer" className="px-3 py-2 border border-[var(--yellow-2)]/60 text-[var(--accent-ink)] hover:bg-[var(--yellow-soft)] inline-flex items-center gap-1.5">Verification record <ExternalLink className="w-3.5 h-3.5" /></a>
            <a href="https://github.com/unspecifiedcoder/z-canary/blob/main/docs/ARCHITECTURE.md" target="_blank" rel="noreferrer" className="px-3 py-2 border border-[var(--line)] text-[var(--muted)] hover:border-[var(--line-strong)] inline-flex items-center gap-1.5">Architecture <ExternalLink className="w-3.5 h-3.5" /></a>
            <a href="https://github.com/unspecifiedcoder/z-canary/blob/main/docs/THREAT-MODEL.md" target="_blank" rel="noreferrer" className="px-3 py-2 border border-[var(--line)] text-[var(--muted)] hover:border-[var(--line-strong)] inline-flex items-center gap-1.5">Threat model <ExternalLink className="w-3.5 h-3.5" /></a>
          </div>
        </div>

        <div className="grid grid-cols-1 lg:grid-cols-3 gap-3">
          <article className="space-y-1.5 border-t border-[var(--line)] pt-4">
            <div className="flex items-center justify-between gap-3"><span className="text-xs text-[var(--accent-ink)]">Interactive</span><span className="text-[10px] font-mono text-[var(--faint)]">Hosted browser</span></div>
            <h2 className="font-semibold text-[var(--ink)]">Real local cryptography</h2>
            <p className="text-xs leading-relaxed text-[var(--muted)]">X25519 recipient binding, AES-256-GCM, signatures, {vault.manifest.threshold}-of-5 reconstruction and exact-byte verification execute in this browser.</p>
          </article>
          <article className="space-y-1.5 border-t border-[var(--line)] pt-4">
            <div className="flex items-center justify-between gap-3"><span className="text-xs text-[var(--accent-ink)]">Simulated, resettable</span><span className="text-[10px] font-mono text-[var(--faint)]">Hosted browser</span></div>
            <h2 className="font-semibold text-[var(--ink)]">Blocks and keeper records</h2>
            <p className="text-xs leading-relaxed text-[var(--muted)]">The chain height, transactions, timing and five keeper records on this screen are synthetic. No Zcash transaction is sent here.</p>
          </article>
          <article className="space-y-1.5 border-t border-[var(--line)] pt-4">
            <div className="flex items-center justify-between gap-3"><span className="text-xs text-[var(--ok)]">Recorded, verifiable</span><span className="text-[10px] font-mono text-[var(--faint)]">Native testnet</span></div>
            <h2 className="font-semibold text-[var(--ink)]">Shielded Zcash commands</h2>
            <p className="text-xs leading-relaxed text-[var(--muted)]">A separate native run used real testnet REGISTER, POSTPONE and CANCEL transactions, five local keeper processes and recipient recovery.</p>
          </article>
        </div>

        <div className="grid grid-cols-1 xl:grid-cols-[1.35fr_.65fr] gap-5">
          <ReceiptVerifier labMemoHex={selectedTxidForMemo ? selectedTx?.memoHex : undefined} />

          <aside className="border border-[var(--ok)]/45 bg-[var(--sunken)] p-5 space-y-4">
            <div className="flex items-center gap-2"><FileCheck2 className="w-5 h-5 text-[var(--ok)]" /><h2 className="font-semibold text-[var(--ink)]">Exact recovery passed</h2></div>
            <div className="grid grid-cols-2 gap-3 text-xs">
              <div><span className="block text-[var(--faint)]">Native fixture</span><strong className="text-[var(--ink)]">136 bytes</strong></div>
              <div><span className="block text-[var(--faint)]">Threshold</span><strong className="text-[var(--ink)]">3 of 5</strong></div>
              <div><span className="block text-[var(--faint)]">Expired path</span><strong className="text-[var(--ok)]">5 shares</strong></div>
              <div><span className="block text-[var(--faint)]">Cancelled path</span><strong className="text-[var(--ok)]">0 shares</strong></div>
            </div>
            <div className="space-y-1"><span className="text-[10px] font-mono text-[var(--faint)]">Recovered SHA-256</span><code className="block text-[10px] leading-relaxed text-[var(--muted)] break-all">{NATIVE_FIXTURE_SHA256}</code></div>
            <p className="text-[11px] leading-relaxed text-[var(--muted)]">All five native keeper processes shared one operator, one viewing-only scanner and one lightwallet endpoint. This proves the implemented path—not independent decentralization or production security.</p>
          </aside>
        </div>

        <RealRunReplay />

        <div className="grid grid-cols-1 items-start gap-3 lg:grid-cols-2">
          <article className="space-y-2 border-t border-[var(--line)] pt-4 text-[13px] leading-relaxed text-[var(--muted)]">
            <h2 className="text-sm font-semibold text-[var(--ink)]">Why Zcash, and why no smart contract</h2>
            <p>The file stays off-chain. Zcash carries only the owner’s signed REGISTER, POSTPONE and CANCEL commands, as 512-byte shielded memos in a confirmed order. A viewing-only scanner reads them for the keepers without any spending authority.</p>
            <p>Shielded memos hide who is checking in and for whom. A transparent chain would expose a pattern of life, and a plain server would be one party that can be pressured or switched off. Zcash has no general smart contracts, and none are needed: the memo format and the keeper state machine do that job.</p>
            <p>This page publishes testnet receipts only because it is a demonstration. Real users would never publish their memos or viewing keys.</p>
          </article>
          <article className="space-y-2 border-t border-[var(--line)] pt-4 text-[13px] leading-relaxed text-[var(--muted)]">
            <h2 className="text-sm font-semibold text-[var(--ink)]">What this does not prove</h2>
            <ul className="list-disc space-y-1 pl-4">
              <li>The five keepers are local processes sharing one operator, one scanner and one lightwallet endpoint. They are not independent.</li>
              <li>Three colluding keepers can deliver shares early. Cancellation cannot revoke shares already delivered.</li>
              <li>Testnet only, with no mainnet funds, and the native runtime is Windows-specific.</li>
              <li>Not independently security-audited. Use synthetic files only.</li>
            </ul>
          </article>
        </div>
      </section>

      {/* Section 1: Refined 5-Keeper High-Assurance Infrastructure Grid + Live D3.js Topology */}
      <section className="border border-[var(--line)] bg-[var(--card)] rounded-[22px] shadow-[var(--shadow)] p-6 lg:p-8 space-y-6">
        <div className="flex flex-col lg:flex-row lg:items-center justify-between gap-4 border-b border-[var(--line)] pb-5">
          <div className="space-y-1">
            
            <h2 className="text-2xl font-bold text-[var(--ink)]">
              Five stations. One deliberate threshold.
            </h2>
            <p className="text-sm text-[var(--muted)]">
              These five records run in one browser. Toggle availability and scanner health to explore the release policy. Native testnet has separate local processes and is accessed in the native workspace.
            </p>
          </div>

          <div className="flex flex-wrap items-center gap-2 shrink-0">
            <button
              onClick={() => onSimulateReorg('shallow')}
              className="px-3.5 py-2 bg-[var(--sunken)] hover:bg-[var(--sunken)] border border-[var(--line)] text-xs text-[var(--ink)] rounded flex items-center gap-1.5 cursor-pointer transition-colors"
            >
              <RotateCcw className="w-3.5 h-3.5 text-[var(--accent-ink)]" />
              <span>2-Block Reorg</span>
            </button>
            <button
              onClick={() => onSimulateReorg('deep')}
              className="px-3.5 py-2 bg-[var(--sunken)] hover:bg-[var(--sunken)] border border-[var(--bad)]/50 text-xs text-[var(--bad)] rounded flex items-center gap-1.5 cursor-pointer transition-colors"
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
        <div className="p-4 bg-[var(--sunken)] border border-[var(--line)] flex flex-col sm:flex-row sm:items-center justify-between gap-4">
          <div className="flex items-center gap-3">
            {thresholdMet ? (
              <ShieldCheck className="w-5 h-5 text-[var(--ok)] shrink-0" />
            ) : (
              <AlertTriangle className="w-5 h-5 text-[var(--bad)] shrink-0" />
            )}
            <div>
              <div className="text-sm font-semibold text-[var(--ink)]">
                {thresholdMet
                  ? `Quorum Healthy: ${onlineHealthyCount} of 5 Keepers Active & Synchronized`
                  : `Quorum Degraded: Only ${onlineHealthyCount} of 5 Keepers Healthy (Minimum 3 Required)`}
              </div>
              <div className="text-xs text-[var(--muted)]">
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
                      ? 'bg-[var(--bad)]/40 border border-[var(--bad)]'
                      : k.lifecycleState === 'GRACE'
                      ? 'bg-[var(--yellow)]'
                      : 'bg-[var(--ok)]'
                  }`}
                />
              );
            })}
          </div>
        </div>

        {/* Navigation Tabs: All 5 Grid vs Individual Deep Dive */}
        <div className="flex flex-wrap items-center justify-between gap-4">
          <div className="flex flex-wrap items-center gap-1.5 p-1 bg-[var(--sunken)] border border-[var(--line)] rounded">
            <button
              onClick={() => setSelectedKeeperTab('ALL')}
              className={`px-3 py-1.5 text-xs rounded transition-colors cursor-pointer ${
                selectedKeeperTab === 'ALL'
                  ? 'bg-[var(--yellow)] text-[var(--ink)] font-semibold'
                  : 'text-[var(--muted)] hover:text-[var(--ink)]'
              }`}
            >
              All keeper stations
            </button>
            {vault.keepers.map((k) => (
              <button
                key={k.index}
                onClick={() => setSelectedKeeperTab(k.index as 1 | 2 | 3 | 4 | 5)}
                className={`px-3 py-1.5 text-xs rounded transition-colors cursor-pointer ${
                  selectedKeeperTab === k.index
                    ? 'bg-[var(--yellow)] text-[var(--ink)] font-semibold'
                    : 'text-[var(--muted)] hover:text-[var(--ink)]'
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
                ? 'keeper-node-card keeper-node-offline border-[var(--bad)]/40 bg-[var(--sunken)]/70'
                : isGrace
                ? 'keeper-node-card keeper-node-grace keeper-scan-line keeper-scan-line-amber border-[var(--yellow-2)]/70 bg-[var(--sunken)]'
                : isHealthyOnline
                ? 'keeper-node-card keeper-node-active keeper-scan-line border-[var(--line)] hover:border-[var(--ok)]/60 bg-[var(--sunken)]'
                : 'keeper-node-card border-[var(--yellow-2)]/60 bg-[var(--sunken)]';

              // Low-frequency heartbeat glow class applied strictly to online keeper status indicator boxes
              const statusIndicatorHeartbeatClass = !k.online
                ? 'border-[var(--bad)]/40 bg-[var(--card)] rounded-[22px] shadow-[var(--shadow)]'
                : isReleased
                ? 'keeper-status-heartbeat-cyan border-[var(--info)]/60 bg-[var(--card)] rounded-[22px] shadow-[var(--shadow)]'
                : isGrace || k.scannerHealth !== 'HEALTHY'
                ? 'keeper-status-heartbeat-amber border-[var(--yellow-2)]/60 bg-[var(--card)] rounded-[22px] shadow-[var(--shadow)]'
                : 'keeper-status-heartbeat-emerald border-[var(--ok)]/60 bg-[var(--card)] rounded-[22px] shadow-[var(--shadow)]';

              return (
                <div
                  key={k.id}
                  className={`p-4 border flex flex-col justify-between space-y-4 text-xs ${stateAnimationClass}`}
                >
                  {/* Top Row: Keeper ID & Status Indicator with Low-Frequency CSS Heartbeat Glow */}
                  <div className="space-y-3">
                    <div className="flex items-start justify-between gap-2">
                      <div>
                        <div className="text-[11px] text-[var(--faint)]">{k.id.toUpperCase()}</div>
                        <div className="text-sm font-bold text-[var(--ink)] font-sans">
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
                          <WifiOff className="w-4 h-4 text-[var(--bad)]" />
                        ) : k.scannerHealth !== 'HEALTHY' ? (
                          <AlertTriangle className="w-4 h-4 text-[var(--accent-ink)]" />
                        ) : isReleased ? (
                          <Unlock className="w-4 h-4 text-[var(--info)]" />
                        ) : isGrace ? (
                          <Clock className="w-4 h-4 text-[var(--accent-ink)]" />
                        ) : (
                          <ShieldCheck className="w-4 h-4 text-[var(--ok)]" />
                        )}
                      </div>
                    </div>

                    {/* Lifecycle & Health Status Readout */}
                    <div className="p-2.5 bg-[var(--card)] rounded-[22px] shadow-[var(--shadow)] border border-[var(--line)] space-y-1.5 tabular-nums">
                      <div className="flex items-center justify-between">
                        <span className="text-[var(--faint)]">Lifecycle</span>
                        <span
                          className={`font-semibold ${
                            !k.online
                              ? 'text-[var(--bad)]'
                              : k.lifecycleState === 'ACTIVE'
                              ? 'text-[var(--ok)]'
                              : k.lifecycleState === 'GRACE'
                              ? 'text-[var(--accent-ink)]'
                              : k.lifecycleState === 'RELEASED'
                              ? 'text-[var(--info)]'
                              : 'text-[var(--muted)]'
                          }`}
                        >
                          {!k.online ? 'OFFLINE' : k.lifecycleState}
                        </span>
                      </div>

                      <div className="flex items-center justify-between">
                        <span className="text-[var(--faint)]">Confirmed Block</span>
                        <span className="text-[var(--ink)] font-semibold">
                          #{k.scanCursorHeight.toLocaleString()}
                        </span>
                      </div>

                      <div className="flex items-center justify-between">
                        <span className="text-[var(--faint)]">Scanner Health</span>
                        <span
                          className={
                            !k.online
                              ? 'text-[var(--bad)]'
                              : k.scannerHealth === 'HEALTHY'
                              ? 'text-[var(--ok)]'
                              : 'text-[var(--accent-ink)]'
                          }
                        >
                          {!k.online ? 'DISCONNECTED' : k.scannerHealth}
                        </span>
                      </div>
                    </div>

                    {/* Additional Telemetry: Last Sequence, Expiry, Share Custody */}
                    <div className="space-y-1 text-[11px] text-[var(--muted)] tabular-nums pt-1">
                      <div className="flex justify-between">
                        <span className="text-[var(--faint)]">Verified Seq:</span>
                        <span>#{k.lastSequence !== null ? k.lastSequence.toString() : '0'}</span>
                      </div>
                      <div className="flex justify-between">
                        <span className="text-[var(--faint)]">Release Height:</span>
                        <span className="text-[var(--accent-ink)]">#{k.graceDeadlineHeight}</span>
                      </div>
                      <div className="flex justify-between">
                        <span className="text-[var(--faint)]">Share #0{k.index}:</span>
                        <span className={k.outboxDelivered ? 'text-[var(--info)]' : 'text-[var(--ok)]'}>
                          {k.outboxDelivered ? 'Transmitted' : 'Locked in DB'}
                        </span>
                      </div>
                    </div>
                  </div>

                  {/* Action Controls: Online Toggle & Inspector Link */}
                  <div className="space-y-2 pt-3 border-t border-[var(--line)]">
                    <button
                      onClick={() => onToggleKeeperOnline(k.index)}
                      className={`w-full py-2 px-3 rounded text-xs font-medium flex items-center justify-center gap-1.5 transition-colors cursor-pointer ${
                        k.online
                          ? 'bg-[var(--card)] rounded-[22px] shadow-[var(--shadow)] hover:bg-[var(--sunken)] text-[var(--ink)] border border-[var(--line)]'
                          : 'bg-[var(--ok)] hover:bg-[var(--ok)] text-[var(--ink)] font-semibold'
                      }`}
                    >
                      <Power className="w-3.5 h-3.5" />
                      <span>{k.online ? 'Simulate Node Offline' : 'Restore Node Online'}</span>
                    </button>

                    <button
                      onClick={() => setSelectedKeeperTab(k.index as 1 | 2 | 3 | 4 | 5)}
                      className="w-full py-1.5 px-2.5 bg-[var(--card)]/60 rounded-[22px] shadow-[var(--shadow)] hover:bg-[var(--sunken)] text-[var(--muted)] hover:text-[var(--ink)] rounded text-[11px] transition-colors cursor-pointer"
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
          <div className="border border-[var(--line)] bg-[var(--sunken)] p-6 space-y-6 text-xs">
            <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-4 border-b border-[var(--line)] pb-4">
              <div className="space-y-1">
                <div className="text-sm font-bold text-[var(--ink)]">
                  {activeKeeper.name} ({activeKeeper.id}) — Isolated Process Inspector
                </div>
                <div className="text-[var(--muted)]">
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
                  className="px-3 py-1.5 bg-[var(--card)] rounded-[22px] shadow-[var(--shadow)] border border-[var(--line)] rounded text-xs text-[var(--ink)]"
                >
                  <option value="HEALTHY">Health: HEALTHY</option>
                  <option value="DELAYED_SCAN">Health: DELAYED_SCAN</option>
                  <option value="REORG_INCIDENT">Health: REORG_INCIDENT</option>
                </select>

                <button
                  onClick={() => onToggleKeeperOnline(activeKeeper.index)}
                  className="px-3 py-1.5 bg-[var(--card)] rounded-[22px] shadow-[var(--shadow)] hover:bg-[var(--sunken)] border border-[var(--line)] rounded text-xs text-[var(--ink)] cursor-pointer"
                >
                  {activeKeeper.online ? 'Simulate Process Kill' : 'Restart Process'}
                </button>
              </div>
            </div>

            <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
              <div className="p-3.5 bg-[var(--card)] rounded-[22px] shadow-[var(--shadow)] border border-[var(--line)] space-y-1">
                <div className="text-[var(--faint)]">Provisioned Share Commitment</div>
                <div className="text-[var(--ink)] truncate">
                  {activeKeeper.provisionedShare?.commitmentHex}
                </div>
                <div className="text-[var(--ok)]">
                  ACK Signature: {activeKeeper.provisionedAckSignature}
                </div>
              </div>

              <div className="p-3.5 bg-[var(--card)] rounded-[22px] shadow-[var(--shadow)] border border-[var(--line)] space-y-1 tabular-nums">
                <div className="text-[var(--faint)]">Confirmed Block Scan Cursor</div>
                <div className="text-[var(--ink)] font-semibold">
                  Height #{activeKeeper.scanCursorHeight.toLocaleString()}
                </div>
                <div className="text-[var(--muted)] truncate">
                  Hash: {activeKeeper.scanCursorBlockHash}
                </div>
              </div>

              <div className="p-3.5 bg-[var(--card)] rounded-[22px] shadow-[var(--shadow)] border border-[var(--line)] space-y-1">
                <div className="text-[var(--faint)]">Outbox & Idempotency Status</div>
                <div className="text-[var(--ink)] font-semibold">
                  {activeKeeper.outboxDelivered ? 'DISPATCHED TO RECIPIENT' : 'HELD IN CUSTODY'}
                </div>
                <div className="text-[var(--muted)] truncate">
                  Idempotency Key: {activeKeeper.deliveryIdempotencyKey || 'Not yet generated'}
                </div>
              </div>
            </div>

            <div className="space-y-2">
              <div className="text-[var(--muted)]">In-memory simulation event log</div>
              <div className="p-4 bg-[var(--card)] rounded-[22px] shadow-[var(--shadow)] border border-[var(--line)] space-y-1.5 text-[11px] text-[var(--muted)]">
                {activeKeeper.logs.map((line, i) => (
                  <div key={i}>{line}</div>
                ))}
              </div>
            </div>
          </div>
        )}
      </section>

      {/* Section 2: 512-Byte ZIP-302 Shielded Memo Binary Inspector */}
      <section className="border border-[var(--line)] bg-[var(--card)] rounded-[22px] shadow-[var(--shadow)] p-6 lg:p-8 space-y-6">
        <div className="flex flex-col lg:flex-row lg:items-center justify-between gap-4 border-b border-[var(--line)] pb-5">
          <div className="space-y-1">
            
            <h2 className="text-xl font-bold text-[var(--ink)]">
              Shielded Memo Binary Inspector & Tamper Verifier
            </h2>
            <p className="text-xs text-[var(--muted)]">
              Inspect the exact 512-byte payload prepared by the browser simulation or inject faults
              to verify strict rejection rules. No network transaction is sent from this screen.
            </p>
          </div>

          <div className="flex flex-wrap items-center gap-2">
            <select
              value={selectedTx?.txid || ''}
              onChange={(e) => {
                setSelectedTxid(e.target.value);
                setTamperMode('NONE');
              }}
              className="w-full min-w-0 max-w-full sm:w-auto px-3 py-2 bg-[var(--sunken)] border border-[var(--line)] rounded text-xs text-[var(--ink)]"
            >
              {transactions.map((tx) => (
                <option key={tx.txid} value={tx.txid}>
                  Seq #{tx.sequence} · {operationLabel(tx.operation)} · synthetic id:{tx.txid.slice(0, 10)}…
                </option>
              ))}
            </select>
          </div>
        </div>

        {memoInspection && (
          <div className="space-y-6">
            <div className="flex flex-wrap items-center justify-between gap-4 p-4 bg-[var(--sunken)] border border-[var(--line)] text-xs">
              <div className="flex flex-wrap items-center gap-2">
                <span className="text-[var(--muted)]">Codec Fault Injection:</span>
                <button
                  onClick={() => setTamperMode('NONE')}
                  className={`px-2.5 py-1 rounded cursor-pointer ${
                    tamperMode === 'NONE'
                      ? 'bg-[var(--ok)] text-[var(--ink)] font-semibold'
                      : 'bg-[var(--card)] rounded-[22px] shadow-[var(--shadow)] text-[var(--muted)]'
                  }`}
                >
                  Generated 512B Memo
                </button>
                <button
                  onClick={() => setTamperMode('PADDING')}
                  className={`px-2.5 py-1 rounded cursor-pointer ${
                    tamperMode === 'PADDING'
                      ? 'bg-[var(--bad)] text-[var(--ink)] font-semibold'
                      : 'bg-[var(--card)] rounded-[22px] shadow-[var(--shadow)] text-[var(--muted)]'
                  }`}
                >
                  Corrupt Zero Padding [Byte 200]
                </button>
                <button
                  onClick={() => setTamperMode('SIGNATURE')}
                  className={`px-2.5 py-1 rounded cursor-pointer ${
                    tamperMode === 'SIGNATURE'
                      ? 'bg-[var(--bad)] text-[var(--ink)] font-semibold'
                      : 'bg-[var(--card)] rounded-[22px] shadow-[var(--shadow)] text-[var(--muted)]'
                  }`}
                >
                  Flip Ed25519 Signature [Byte 490]
                </button>
                <button
                  onClick={() => setTamperMode('NETWORK')}
                  className={`px-2.5 py-1 rounded cursor-pointer ${
                    tamperMode === 'NETWORK'
                      ? 'bg-[var(--bad)] text-[var(--ink)] font-semibold'
                      : 'bg-[var(--card)] rounded-[22px] shadow-[var(--shadow)] text-[var(--muted)]'
                  }`}
                >
                  Wrong Network Scanner
                </button>
              </div>

              <div>
                {memoInspection.result.valid ? (
                  <span className="text-[var(--ok)] font-semibold">
                    Valid 512-byte ZIP-302 command · Ed25519 verified
                  </span>
                ) : (
                  <span className="text-[var(--bad)] font-semibold">
                    REJECTED: {memoInspection.result.errorCode}
                  </span>
                )}
              </div>
            </div>

            {!memoInspection.result.valid && (
              <div className="p-4 bg-[var(--sunken)] border border-[var(--bad)] text-xs text-[var(--bad)]">
                Decoder Rejection Reason: {memoInspection.result.errorMessage} (
                {memoInspection.result.errorCode})
              </div>
            )}

            <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-4 gap-3 text-xs">
              <div className="p-3 bg-[var(--sunken)] border border-[var(--line)]">
                <div className="text-[var(--faint)]">[0] ZIP-302 Prefix (1B)</div>
                <div className="text-[var(--accent-ink)] font-semibold mt-1">
                  0x{memoInspection.rawBytes[0].toString(16).toUpperCase()}
                </div>
              </div>
              <div className="p-3 bg-[var(--sunken)] border border-[var(--line)]">
                <div className="text-[var(--faint)]">[1..5] App Magic (4B)</div>
                <div className="text-[var(--ink)] font-semibold mt-1">"ZCAN" (5a 43 41 4e)</div>
              </div>
              <div className="p-3 bg-[var(--sunken)] border border-[var(--line)]">
                <div className="text-[var(--faint)]">[5..8] Ver / Net / Op (3B)</div>
                <div className="text-[var(--ok)] font-semibold mt-1">
                  v{memoInspection.rawBytes[5]} · Testnet · Op 0x0{memoInspection.rawBytes[7]}
                </div>
              </div>
              <div className="p-3 bg-[var(--sunken)] border border-[var(--line)]">
                <div className="text-[var(--faint)]">[40..52] Seq (8B LE) & Expiry (4B LE)</div>
                <div className="text-[var(--ink)] font-semibold mt-1 tabular-nums">
                  Seq #{selectedTx?.sequence} · Exp #{selectedTx?.requestedExpiryHeight}
                </div>
              </div>
            </div>

            <div className="p-4 bg-[var(--sunken)] border border-[var(--line)] text-[11px] space-y-2">
              <div className="flex items-center justify-between text-[var(--faint)]">
                <span>Raw 512-byte payload (1,024 hex characters)</span>
                <span>Total Length: {memoInspection.rawBytes.length} Bytes</span>
              </div>
              <div className="text-[var(--muted)] break-all leading-relaxed max-h-36 overflow-y-auto">
                {memoInspection.rawHex}
              </div>
            </div>
          </div>
        )}
      </section>

      <details className="native-evidence-disclosure"><summary>Inspect authenticated native evidence <span>+</span></summary><LocalAgentPanel memoHex={memoInspection?.rawHex} /></details>

      {/* Section 3: Automated Acceptance Test Suite */}
      <section className="border border-[var(--line)] bg-[var(--card)] rounded-[22px] shadow-[var(--shadow)] p-6 lg:p-8 space-y-6">
        <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-4 border-b border-[var(--line)] pb-5">
          <div className="space-y-1">
            
            <h2 className="text-xl font-bold text-[var(--ink)]">
              Browser Simulation Checks ({testResults.filter((r) => r.passed).length}/
              {testResults.length} Passing)
            </h2>
          </div>

          <button
            onClick={handleRunTests}
            className="px-4 py-2 bg-[var(--yellow)] hover:bg-[var(--yellow-2)] text-[var(--ink)] font-semibold text-xs rounded flex items-center gap-2 self-start cursor-pointer"
          >
            <Play className="w-3.5 h-3.5" />
            <span>Re-Run All Acceptance Vectors</span>
          </button>
        </div>

        <div className="divide-y divide-[var(--line)] text-xs">
          {testResults.map((test) => (
            <div
              key={test.id}
              className="py-4 first:pt-0 last:pb-0 flex flex-col lg:flex-row lg:items-center justify-between gap-4"
            >
              <div className="space-y-1">
                <div className="flex items-center gap-2.5">
                  {test.passed ? (
                    <CheckCircle2 className="w-4 h-4 text-[var(--ok)] shrink-0" />
                  ) : (
                    <XCircle className="w-4 h-4 text-[var(--bad)] shrink-0" />
                  )}
                  <span className="text-[var(--accent-ink)]">{test.id}</span>
                  <span className="text-[var(--faint)]">·</span>
                  <span className="text-[var(--muted)]">{test.category}</span>
                  <span className="text-[var(--faint)]">·</span>
                  <span className="text-[var(--ink)] font-semibold">{test.name}</span>
                </div>
                <p className="text-[var(--muted)] pl-6">{test.assertionSummary}</p>
                <div className="text-[11px] text-[var(--faint)] pl-6">{test.evidenceLog}</div>
              </div>

              <div className="pl-6 lg:pl-0 flex items-center gap-3 shrink-0 tabular-nums">
                <span className="text-[var(--faint)]">{test.durationMs} ms</span>
                <span className={test.passed ? 'text-[var(--ok)] font-semibold' : 'text-[var(--bad)]'}>
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
