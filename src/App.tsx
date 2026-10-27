/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

import React, { lazy, Suspense, useEffect, useRef, useState } from 'react';
import {
  Pickaxe,
  FastForward,
  RotateCcw,
  CheckCircle2,
  AlertTriangle,
} from 'lucide-react';
import { bytesToHex, sha256Hex } from './crypto/shamir';
import {
  encodeShieldedMemo,
  MemoOperation,
  ZcashNetwork,
} from './crypto/memoCodec';
import {
  ChainTransaction,
  ContinuityVault,
  createInitialPreloadedSetup,
  formatBlockHash,
  ScannerHealthState,
  ShieldedSupportTransaction,
  suspendVaultForReorg,
  synchronizeVaultWithChain,
} from './engine/protocolStore';
import { WelcomeScreen } from './components/WelcomeScreen';
import { CreateVaultWizard } from './components/CreateVaultWizard';
import { VaultDetailConsole } from './components/VaultDetailConsole';
import { RecipientInboxScreen } from './components/RecipientInboxScreen';
import { SupportScreen } from './components/SupportScreen';
import { EvidenceAndKeepersPanel } from './components/EvidenceAndKeepersPanel';
import NativeVaultWorkspace from './components/NativeVaultWorkspace';

const GuidedExperience = lazy(() => import('./components/GuidedExperience'));
const CaseStudyDemo = lazy(() => import('./components/CaseStudyDemo'));

type ActiveTab = 'demo' | 'case' | 'welcome' | 'sentinel' | 'create' | 'recipient' | 'support' | 'evidence' | 'native';

const INITIAL_HEIGHT = 2845100;

export default function App() {
  const [initialData] = useState(() => createInitialPreloadedSetup(INITIAL_HEIGHT));

  const [activeTab, setActiveTab] = useState<ActiveTab>('welcome');
  const mainRef = useRef<HTMLElement>(null);
  const didNavigate = useRef(false);
  useEffect(() => {
    if (didNavigate.current) { mainRef.current?.focus({ preventScroll: true }); window.scrollTo({ top: 0, behavior: 'instant' }); }
    didNavigate.current = true;
  }, [activeTab]);
  const [currentBlockHeight, setCurrentBlockHeight] = useState<number>(INITIAL_HEIGHT);
  const [forkSalt, setForkSalt] = useState<number>(0);
  const [recipientIdentity] = useState(initialData.recipientIdentity);
  const [vault, setVault] = useState<ContinuityVault>(initialData.vault);
  const [transactions, setTransactions] = useState<ChainTransaction[]>(initialData.transactions);
  const [walletBalanceZatoshi, setWalletBalanceZatoshi] = useState<number>(480000);
  const [selectedTxidForMemo, setSelectedTxidForMemo] = useState<string | null>(
    initialData.transactions[0]?.txid || null
  );
  const [toastMessage, setToastMessage] = useState<string | null>(null);

  const [supportHistory, setSupportHistory] = useState<ShieldedSupportTransaction[]>([
    {
      id: 'sup-1',
      txid: sha256Hex('orchard-support-note-initial-1'),
      amountZatoshi: 500000,
      blockHeight: INITIAL_HEIGHT - 12,
      confirmations: 13,
      timestamp: '2026-10-26 03:25:00 UTC',
      note: 'Confirmed Orchard Shielded Receipt (Unlinked)',
    },
  ]);

  const showToast = (msg: string) => {
    setToastMessage(msg);
    setTimeout(() => {
      setToastMessage((prev) => (prev === msg ? null : prev));
    }, 4200);
  };

  /**
   * Advances the simulated Zcash Testnet block height and synchronizes all 5 isolated Keepers
   */
  const handleAdvanceBlocks = (
    deltaBlocks: number,
    overrideVault?: ContinuityVault,
    overrideTxs?: ChainTransaction[]
  ) => {
    const targetVault = overrideVault || vault;
    const targetTxs = overrideTxs || transactions;
    const nextHeight = currentBlockHeight + deltaBlocks;

    const updatedTxs = targetTxs.map((tx) => {
      if (tx.status === 'ORPHANED') return tx;
      if (tx.minedAtHeight === null) {
        return {
          ...tx,
          minedAtHeight: nextHeight,
          blockHash: formatBlockHash(nextHeight, forkSalt),
          confirmations: 1,
          status: 'MINED' as const,
        };
      }
      return {
        ...tx,
        confirmations: Math.max(1, nextHeight - tx.minedAtHeight + 1),
        status: nextHeight - tx.minedAtHeight + 1 >= targetVault.manifest.confirmationTarget ? 'CONFIRMED' as const : 'MINED' as const,
      };
    });

    const syncedVault = synchronizeVaultWithChain(targetVault, updatedTxs, nextHeight, forkSalt);
    setCurrentBlockHeight(nextHeight);
    setTransactions(updatedTxs);
    setVault(syncedVault);
  };

  /**
   * Signs and broadcasts a 512-byte ZIP-302 Check-In / Postponement command (0x02)
   * and mines confirmation blocks so Keepers process it in canonical order.
   */
  const handleCheckIn = (additionalBlocks: number) => {
    if (!Number.isInteger(additionalBlocks) || additionalBlocks < 1 || additionalBlocks > vault.manifest.maxExtensionBlocks) {
      showToast('Enter a whole number of blocks within the configured extension limit.');
      return;
    }
    if (!vault.keepers.some(k => k.lifecycleState === 'ACTIVE' || k.lifecycleState === 'GRACE') || currentBlockHeight + 1 > vault.graceDeadlineHeight) {
      showToast('This vault is not accepting check-ins. Confirm registration first, or create a new vault after expiry or cancellation.');
      return;
    }
    if (walletBalanceZatoshi < 10000) {
      showToast('Insufficient wallet balance (need 10,000 zatoshi). Visit Shielded Support.');
      return;
    }

    const nextSeq = vault.highestSequence + 1;
    const baseHeight = Math.max(currentBlockHeight, vault.currentExpiryHeight);
    const requestedExpiryHeight = baseHeight + additionalBlocks;
    if (requestedExpiryHeight > currentBlockHeight + 1 + vault.manifest.maxExtensionBlocks || requestedExpiryHeight > 0xffffffff) {
      showToast('The requested deadline exceeds the policy limit measured from the inclusion block. Choose a smaller extension.');
      return;
    }

    const memoBytes = encodeShieldedMemo({
      version: 1,
      network: ZcashNetwork.TESTNET,
      operation: MemoOperation.POSTPONE,
      switchIdHex: vault.manifest.switchIdHex,
      sequence: BigInt(nextSeq),
      requestedExpiryHeight,
      manifestDigestHex: vault.manifest.manifestDigestHex,
      sourcePubKeyHex: vault.sourcePubKeyHex,
    }, vault.sourceSecretHex);

    const memoHex = bytesToHex(memoBytes);
    const txid = sha256Hex(`tx-checkin-${vault.id}-seq-${nextSeq}-${Date.now()}`);
    const minedHeight = currentBlockHeight + 1;
    const confirmedHeight = minedHeight + vault.manifest.confirmationTarget - 1;

    const newTx: ChainTransaction = {
      txid,
      operationId: `op-postpone-${nextSeq}`,
      vaultId: vault.id,
      operation: MemoOperation.POSTPONE,
      sequence: nextSeq,
      requestedExpiryHeight,
      memoHex,
      feeZatoshi: 10000,
      submittedAtHeight: currentBlockHeight,
      minedAtHeight: minedHeight,
      blockHash: formatBlockHash(minedHeight, forkSalt),
      confirmations: vault.manifest.confirmationTarget,
      status: 'CONFIRMED',
      timestamp: new Date().toISOString().replace('T', ' ').slice(0, 19) + ' UTC',
    };

    const nextTxs = [...transactions, newTx];
    const nextVaultPreSync: ContinuityVault = {
      ...vault,
      highestSequence: nextSeq,
      timeline: [
        ...vault.timeline,
        {
          id: `ev-checkin-${nextSeq}-${Date.now()}`,
          type: 'CHECKIN_CONFIRMED',
          title: `Simulated check-in included (Sequence #${nextSeq})`,
          detail: `Signed 512-byte POSTPONE memo reached ${vault.manifest.confirmationTarget} simulated confirmations. Offline or unhealthy keeper records must catch up before applying it. Requested expiry: #${requestedExpiryHeight}.`,
          blockHeight: confirmedHeight,
          txid,
          timestamp: new Date().toISOString().replace('T', ' ').slice(0, 19) + ' UTC',
        },
      ],
    };

    const syncedVault = synchronizeVaultWithChain(nextVaultPreSync, nextTxs, confirmedHeight, forkSalt);
    setWalletBalanceZatoshi((b) => b - 10000);
    setCurrentBlockHeight(confirmedHeight);
    setTransactions(nextTxs);
    setVault(syncedVault);
    setSelectedTxidForMemo(txid);
    showToast(
      `Simulated check-in confirmed. ${syncedVault.keepers.filter(k => k.lastSequence === BigInt(nextSeq)).length}/5 keeper records applied the new deadline.`
    );
  };

  /**
   * Signs and broadcasts an irrevocable 512-byte CANCEL command (0x03)
   */
  const handleCancelVault = () => {
    if (!vault.keepers.some(k => k.lifecycleState === 'ACTIVE' || k.lifecycleState === 'GRACE')) {
      showToast('Cancellation is available only after registration and before release or cancellation.');
      return;
    }
    if (walletBalanceZatoshi < 10000 || currentBlockHeight + 1 > vault.graceDeadlineHeight) {
      showToast('Cancellation requires a funded wallet and inclusion before the grace boundary.');
      return;
    }
    const nextSeq = vault.highestSequence + 1;
    const memoBytes = encodeShieldedMemo({
      version: 1,
      network: ZcashNetwork.TESTNET,
      operation: MemoOperation.CANCEL,
      switchIdHex: vault.manifest.switchIdHex,
      sequence: BigInt(nextSeq),
      requestedExpiryHeight: 0,
      manifestDigestHex: vault.manifest.manifestDigestHex,
      sourcePubKeyHex: vault.sourcePubKeyHex,
    }, vault.sourceSecretHex);

    const memoHex = bytesToHex(memoBytes);
    const txid = sha256Hex(`tx-cancel-${vault.id}-seq-${nextSeq}-${Date.now()}`);
    const minedHeight = currentBlockHeight + 1;
    const confirmedHeight = minedHeight + vault.manifest.confirmationTarget - 1;

    const cancelTx: ChainTransaction = {
      txid,
      operationId: `op-cancel-${nextSeq}`,
      vaultId: vault.id,
      operation: MemoOperation.CANCEL,
      sequence: nextSeq,
      requestedExpiryHeight: 0,
      memoHex,
      feeZatoshi: 10000,
      submittedAtHeight: currentBlockHeight,
      minedAtHeight: minedHeight,
      blockHash: formatBlockHash(minedHeight, forkSalt),
      confirmations: vault.manifest.confirmationTarget,
      status: 'CONFIRMED',
      timestamp: new Date().toISOString().replace('T', ' ').slice(0, 19) + ' UTC',
    };

    const nextTxs = [...transactions, cancelTx];
    const nextVaultPreSync: ContinuityVault = {
      ...vault,
      highestSequence: nextSeq,
      timeline: [
        ...vault.timeline,
        {
          id: `ev-cancel-${Date.now()}`,
          type: 'CANCELLED',
          title: `Simulated cancel included (Sequence #${nextSeq})`,
          detail: 'Signed 512-byte CANCEL command reached simulated confirmation. Offline or unhealthy keeper records must catch up before applying it; delivered shares cannot be recalled.',
          blockHeight: confirmedHeight,
          txid,
          timestamp: new Date().toISOString().replace('T', ' ').slice(0, 19) + ' UTC',
        },
      ],
    };

    const synced = synchronizeVaultWithChain(nextVaultPreSync, nextTxs, confirmedHeight, forkSalt);
    setWalletBalanceZatoshi((b) => Math.max(0, b - 10000));
    setCurrentBlockHeight(confirmedHeight);
    setTransactions(nextTxs);
    setVault(synced);
    setSelectedTxidForMemo(txid);
    showToast(`Simulated cancellation confirmed. ${synced.keepers.filter(k => k.lifecycleState === 'CANCELLED').length}/5 keeper records applied it; delivered shares cannot be recalled.`);
  };

  const handleJumpToGrace = () => {
    const targetHeight = vault.currentExpiryHeight + vault.manifest.confirmationTarget - 1;
    const delta = Math.max(1, targetHeight - currentBlockHeight);
    handleAdvanceBlocks(delta);
    setActiveTab('sentinel');
    showToast(
      `Advanced chain to #${currentBlockHeight + delta}. Keepers entered GRACE window (Expires at #${vault.graceDeadlineHeight}).`
    );
  };

  const handleJumpPastGraceToExpire = () => {
    const targetHeight = vault.graceDeadlineHeight + vault.manifest.confirmationTarget - 1;
    const delta = Math.max(1, targetHeight - currentBlockHeight);
    handleAdvanceBlocks(delta);
    setActiveTab('recipient');
    showToast(
      `Advanced chain past Grace (#${vault.graceDeadlineHeight}). Keepers authorized share delivery to Recipient Inbox.`
    );
  };

  const handleResetDemo = () => {
    const fresh = createInitialPreloadedSetup(INITIAL_HEIGHT);
    setCurrentBlockHeight(INITIAL_HEIGHT);
    setForkSalt(0);
    setVault(fresh.vault);
    setTransactions(fresh.transactions);
    setWalletBalanceZatoshi(480000);
    setSelectedTxidForMemo(fresh.transactions[0]?.txid || null);
    showToast('Reset deterministic harness to clean initial state (#2,845,100).');
  };

  const handleToggleKeeperOnline = (keeperIndex: number) => {
    const updatedKeepers = vault.keepers.map((k) =>
      k.index === keeperIndex
        ? {
            ...k,
            online: !k.online,
            logs: [
              ...k.logs,
              `[${currentBlockHeight}] Operator toggled process ${!k.online ? 'ONLINE' : 'OFFLINE'}.`,
            ],
          }
        : k
    );
    const synced = synchronizeVaultWithChain(
      { ...vault, keepers: updatedKeepers },
      transactions,
      currentBlockHeight,
      forkSalt
    );
    setVault(synced);
  };

  const handleSetKeeperScannerHealth = (keeperIndex: number, health: ScannerHealthState) => {
    if (vault.keepers.some(k => k.index === keeperIndex && k.scannerHealth === 'REORG_INCIDENT') && health !== 'REORG_INCIDENT') {
      showToast('Canonical replay is not implemented. Reset the synthetic scenario to clear a reorg incident.');
      return;
    }
    const updatedKeepers = vault.keepers.map((k) =>
      k.index === keeperIndex
        ? {
            ...k,
            scannerHealth: health,
            logs: [...k.logs, `[${currentBlockHeight}] Scanner health status changed to ${health}.`],
          }
        : k
    );
    setVault({ ...vault, keepers: updatedKeepers });
  };

  const handleSimulateReorg = (depth: 'shallow' | 'deep') => {
    const nextFork = forkSalt + 1;
    setForkSalt(nextFork);
    const rollbackHeight = depth === 'shallow' ? Math.max(0, currentBlockHeight - 2) : currentBlockHeight;
    setCurrentBlockHeight(rollbackHeight);
    setTransactions(transactions.map(tx => tx.minedAtHeight !== null && (depth === 'deep' || tx.minedAtHeight > rollbackHeight)
      ? {...tx, status: 'ORPHANED' as const, confirmations: 0} : tx));
    setVault(suspendVaultForReorg(vault, rollbackHeight));
    showToast('Reorg incident: processing suspended. Reset to continue; already delivered shares cannot be recalled.');
  };

  return (
    <div className="canary-app">
      <a className="skip-link" href="#main-content">Skip to content</a>
      <header className="canary-header">
        <button className="canary-wordmark" onClick={() => setActiveTab('welcome')} aria-label="Canary overview"><svg viewBox="0 0 34 34" aria-hidden="true"><path d="M5 25V9l12 8L29 9v16L17 17Z"/><path d="M17 5v24"/></svg><span>canary<span className="wordmark-dot">.</span></span></button>
        <nav className="canary-navigation" aria-label="Main navigation">
          {([['welcome','Overview'],['sentinel','Vault Sentinel'],['recipient','Recipient Inbox'],['support','Shielded Support'],['evidence','Evidence & Keepers']] as const).map(([tab,label])=><button key={tab} onClick={()=>setActiveTab(tab)} aria-current={activeTab===tab?'page':undefined}>{label}</button>)}
        </nav>
        <button className={`native-nav ${activeTab==='native'?'is-active':''}`} onClick={()=>setActiveTab('native')}><span className="signal-dot"/>Native testnet <span aria-hidden="true">↗</span></button>
      </header>
      <div className={`environment-strip ${activeTab==='native'?'environment-strip--native':''}`} role="note">
        <span>{activeTab==='native'?'AUTHENTICATED LOCAL WORKSPACE':'BROWSER SIMULATION'}</span>
        <p>{activeTab==='native'?'Actual state is reported by your local agent. Testnet only.':'Synthetic evidence only · Simulated chain and keeper records · No transactions sent'}</p>
        {activeTab!=='case'&&<button onClick={()=>setActiveTab('case')}>Try Maya & Noor's example ↗</button>}
        {activeTab==='case'&&<button onClick={()=>setActiveTab('demo')}>Protocol tour ↗</button>}
      </div>
      {!['native','welcome','demo','case'].includes(activeTab)&&<details className="simulation-tools">
        <summary><span>SIMULATION CONTROLS</span><span>#{currentBlockHeight.toLocaleString()} · {walletBalanceZatoshi.toLocaleString()} zat</span><span>Expand +</span></summary>
        <div><button onClick={()=>handleAdvanceBlocks(1)}><Pickaxe size={14}/>Mine +1 block</button><button onClick={()=>handleAdvanceBlocks(6)}>Mine +6 blocks</button><button onClick={handleJumpToGrace}>Enter grace</button><button onClick={handleJumpPastGraceToExpire}><FastForward size={14}/>Evaluate expiry</button><button onClick={handleResetDemo}><RotateCcw size={14}/>Reset harness</button><button onClick={()=>setActiveTab('create')}>New demo vault ↗</button></div>
      </details>}

      {/* Toast Feedback Banner */}
      {toastMessage && (
        <div role="status" aria-live="polite" className="max-w-7xl w-full mx-auto px-6 pt-4">
          <div className="p-3.5 bg-[#141820] border border-[#F59E0B] text-xs font-mono text-[#F8FAFC] flex items-center justify-between gap-4">
            <div className="flex items-center gap-2.5">
              <CheckCircle2 className="w-4 h-4 text-[#F59E0B] shrink-0" />
              <span>{toastMessage}</span>
            </div>
            <button
              onClick={() => setToastMessage(null)}
              className="text-[#94A3B8] hover:text-[#F8FAFC] cursor-pointer"
            >
              Dismiss
            </button>
          </div>
        </div>
      )}

      {/* Main Content Viewport */}
      <main id="main-content" ref={mainRef} tabIndex={-1} className={`canary-main page-${activeTab}`}><div key={activeTab} className="page-reveal">
        {activeTab === 'welcome' && (
          <WelcomeScreen
            activeVault={vault}
            currentBlockHeight={currentBlockHeight}
            onNavigate={(tab) => setActiveTab(tab)}
            onToggleKeeperOnline={handleToggleKeeperOnline}
            onQuickDemoStep={(step) => {
              if (step === 'inspect') {
                setActiveTab('recipient');
              } else if (step === 'checkin') {
                setActiveTab('sentinel');
                handleCheckIn(vault.manifest.initialIntervalBlocks);
              } else if (step === 'support') {
                setActiveTab('support');
              } else if (step === 'grace') {
                handleJumpToGrace();
              } else if (step === 'expire') {
                handleJumpPastGraceToExpire();
              } else if (step === 'tests') {
                setActiveTab('evidence');
              }
            }}
          />
        )}

        {activeTab === 'create' && (
          <CreateVaultWizard
            recipientIdentity={recipientIdentity}
            currentBlockHeight={currentBlockHeight}
            walletBalanceZatoshi={walletBalanceZatoshi}
            onVaultCreated={(newVault, regTx, fee) => {
              const nextTxs = [...transactions, regTx];
              setWalletBalanceZatoshi((b) => Math.max(0, b - fee));
              setTransactions(nextTxs);
              setVault(newVault);
              setSelectedTxidForMemo(regTx.txid);
              setActiveTab('sentinel');
              showToast(
                'Demo vault encrypted and simulated REGISTER submitted. Mine simulated confirmation blocks to activate.'
              );
            }}
            onCancel={() => setActiveTab('sentinel')}
          />
        )}

        {activeTab === 'sentinel' && (
          <VaultDetailConsole
            vault={vault}
            currentBlockHeight={currentBlockHeight}
            walletBalanceZatoshi={walletBalanceZatoshi}
            transactions={transactions}
            onCheckIn={handleCheckIn}
            onCancelVault={handleCancelVault}
            onMineBlocks={(count) => handleAdvanceBlocks(count)}
            onInspectMemo={(txid) => {
              setSelectedTxidForMemo(txid);
              setActiveTab('evidence');
            }}
          />
        )}

        {activeTab === 'recipient' && (
          <RecipientInboxScreen
            vault={vault}
            recipientIdentity={recipientIdentity}
            currentBlockHeight={currentBlockHeight}
            onDecryptSuccess={(plaintext) => {
              setVault((prev) => ({
                ...prev,
                decryptedByRecipient: true,
                decryptedContentText: plaintext,
                timeline: [
                  ...prev.timeline,
                  {
                    id: `ev-dec-${Date.now()}`,
                    type: 'RECIPIENT_DECRYPTED',
                    title: 'Recipient reconstructed key and decrypted dossier',
                    detail: `3-of-5 Keeper shares interpolated over GF(256) and inner X25519 envelope verified against SHA-256 digest.`,
                    blockHeight: currentBlockHeight,
                    timestamp: new Date().toISOString().replace('T', ' ').slice(0, 19) + ' UTC',
                  },
                ],
              }));
              showToast('Dossier decrypted and SHA-256 digest verified!');
            }}
            onTriggerExpiryForDemo={handleJumpPastGraceToExpire}
          />
        )}

        {activeTab === 'support' && (
          <SupportScreen
            vault={vault}
            walletBalanceZatoshi={walletBalanceZatoshi}
            supportHistory={supportHistory}
            onReceiveSupportDonation={(amountZatoshi) => {
              const newReceipt: ShieldedSupportTransaction = {
                id: `sup-${Date.now()}`,
                txid: sha256Hex(`orchard-support-${Date.now()}`),
                amountZatoshi,
                blockHeight: currentBlockHeight,
                confirmations: 1,
                timestamp: new Date().toISOString().replace('T', ' ').slice(0, 19) + ' UTC',
                note: 'Confirmed Orchard Shielded Receipt (Zero Vault IDs)',
              };
              setSupportHistory((prev) => [newReceipt, ...prev]);
              setWalletBalanceZatoshi((b) => b + amountZatoshi);
              showToast(
                `Simulated receipt: +${amountZatoshi.toLocaleString()} zatoshi. No transaction was sent.`
              );
            }}
            onExecuteFundedCheckIn={() => {
              handleCheckIn(vault.manifest.initialIntervalBlocks);
              setActiveTab('sentinel');
            }}
          />
        )}

        {activeTab === 'evidence' && (
          <EvidenceAndKeepersPanel
            vault={vault}
            transactions={transactions}
            currentBlockHeight={currentBlockHeight}
            selectedTxidForMemo={selectedTxidForMemo}
            onToggleKeeperOnline={handleToggleKeeperOnline}
            onSetKeeperScannerHealth={handleSetKeeperScannerHealth}
            onSimulateReorg={handleSimulateReorg}
            onTriggerExpiryForDemo={handleJumpPastGraceToExpire}
          />
        )}

        {activeTab === 'native' && <NativeVaultWorkspace />}
        {activeTab === 'case' && <Suspense fallback={<div className="scene-loading">Preparing Maya and Noor's example…</div>}><CaseStudyDemo /></Suspense>}
        {activeTab === 'demo' && <Suspense fallback={<div className="scene-loading">Preparing the guided experience…</div>}><GuidedExperience onNative={() => setActiveTab('native')} /></Suspense>}
      </div></main>

      <footer className="canary-footer"><span className="footer-wordmark">canary.</span><p>Private by design. Deliberate by protocol.<br/><span>Zcash testnet · 3-of-5 threshold · Signed shielded memos</span></p><button onClick={()=>setActiveTab('evidence')}>Inspect the evidence ↗</button></footer>
    </div>
  );
}
